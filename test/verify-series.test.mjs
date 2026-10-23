// test/verify-series.test.mjs — lib/verify.mjs, against real repositories: the environment
// refusal, and what a series measures green, red and at the merged head.
//
// Which checks run is the leaf's rigor and role (see `checksFor`); the verdict over what they
// observed is lib/verdict.mjs's, tested purely in test/fast/verdict.test.mjs. The test/verify-*.test.mjs
// files pin the observations, one file per concern so they run side by side.
//
// These are slow tests: each one stands in a real git worktree and runs a real node test suite
// inside it, several times. That cost is the point — the whole value of these files is that the
// discriminator moves HEAD, restores files, runs a suite there and puts the tree back, and none
// of that is observable against a mock.
//
// The repositories themselves come from test/harness/verify-fixture.mjs, which builds each
// distinct shape once and copies it per test. Construction is not the thing under test and used
// to cost more than everything that is; the copy is licensed by the equivalence test in
// test/verify-fixture.test.mjs, which pins that a clone and a freshly built fixture produce the
// same verify() payload byte for byte.
//
// The properties worth pinning, in the order they matter:
//
//   the environment refusal — the procedure stashes and moves HEAD, so it must refuse the tree a
//     human is working in BEFORE it touches anything;
//   absent is never inferred — a command nobody named is not a repository with no command;
//   a failed measurement never wears a clean one's shape — an unreadable series is an error with
//     an empty findings array, and the error is what the caller routes on;
//   the tree is put back — a worktree left detached strands every later fix commit;
//   the log format is IMPORTED — a checkpoint trailer with an ordinary subject is only detectable
//     through lib/commit-series.mjs's own format string, so a test file re-implementing it would
//     silently stop finding them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { verify, parseArgs, worktreeProblem } from '../lib/verify.mjs'
import { measurementOk, suiteFailed } from '../lib/verdict.mjs'
import {
  BRANCH, BUILD, EFFORT, EXECUTION, git, NODE, options, order, repository, rev, SUITE, TEST_ONE,
} from './harness/verify-fixture.mjs'

// ---------------------------------------------------------------- the environment refusal

test('it refuses the repository\'s main working tree, where moving HEAD destroys work', (t) => {
  const dir = repository(t)

  const problem = worktreeProblem(dir)
  assert.ok(problem, 'the main working tree is exactly what this procedure must not touch')
  assert.equal(problem.kind, 'main_worktree')

  const payload = verify(options({ worktree: dir, base: rev(dir, 'HEAD'), head: rev(dir, 'HEAD') }))
  assert.equal(payload.stop_reason, 'environment_broken')
  assert.equal(payload.error.kind, 'main_worktree')
  assert.deepEqual(payload.discriminator, [], 'nothing was measured, so nothing is reported')
  assert.deepEqual(payload.series_findings, [])
})

test('a path that is no working tree at all is refused before anything runs', (t) => {
  const dir = repository(t)

  assert.equal(worktreeProblem('').kind, 'no_worktree',
    'no worktree at all is the case that used to be a sentence in a prompt')
  assert.equal(worktreeProblem(dir + '/nowhere').kind, 'no_worktree')

  const outside = mkdtempSync(join(tmpdir(), 'agentics-not-a-repo-')).split('\\').join('/')
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  assert.equal(worktreeProblem(outside).kind, 'no_worktree')
})

// ---------------------------------------------------------------- the green series

test('a green series: build passes, suite passes, and the new test discriminates', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.stop_reason, 'completed')
  assert.equal(payload.error, null)
  assert.equal(payload.build, 'passed')
  assert.equal(payload.suite, 'passed')
  assert.deepEqual(payload.failing_tests, [])
  assert.deepEqual(payload.series_findings, [], 'a writer may change both files')
  assert.deepEqual(payload.discriminator, [
    { test_id: 'test/widget.test.mjs', adds_test: true, failed_on_base: true, passes_now: true },
  ])
  assert.ok(payload.notes.includes(BUILD), 'the commands actually run are named')
})

test('the worktree is left on its branch, clean, whatever the discriminator checked out', (t) => {
  const { worktree, base, head } = order(t)

  verify(options({ worktree, base, head }))

  assert.equal(git(worktree, 'branch', '--show-current').stdout.trim(), BRANCH)
  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '')
  assert.equal(rev(worktree, 'HEAD'), head)
})

test('uncommitted work in the worktree survives the discriminator', (t) => {
  const { worktree, base, head } = order(t)
  writeFileSync(join(worktree, 'src', 'scratch.txt'), 'not committed\n')

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.stop_reason, 'completed')
  assert.match(git(worktree, 'status', '--porcelain').stdout, /scratch\.txt/,
    'the work set aside came back — uncommitted work is nobody else\'s to discard')
})

test('the discriminator restores its own uncommitted work, whatever another tree stashes meanwhile', (t) => {
  const { dir, worktree, base, head } = order(t)
  writeFileSync(join(worktree, 'src', 'scratch.txt'), 'not committed\n')
  writeFileSync(join(dir, 'tools', 'build.mjs'), '// another session\'s work\n')
  // The test command, run once at head and once at base: at base another tree pops and pushes
  // the stash stack every worktree of the repository shares.
  const scratch = mkdtempSync(join(tmpdir(), 'agentics-stash-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const script = join(scratch, 'meanwhile.cjs').split('\\').join('/')
  writeFileSync(script, `
    const { spawnSync } = require('node:child_process')
    const { existsSync, readFileSync, writeFileSync } = require('node:fs')
    const count = ${JSON.stringify(join(scratch, 'count'))}
    const n = (existsSync(count) ? Number(readFileSync(count, 'utf8')) : 0) + 1
    writeFileSync(count, String(n))
    if (n === 2) {
      spawnSync('git', ['-C', ${JSON.stringify(dir)}, 'stash', 'pop'])
      spawnSync('git', ['-C', ${JSON.stringify(dir)}, 'stash', 'push', '-m', 'foreign'])
    }
    process.exit(n === 2 ? 1 : 0)
  `)

  const payload = verify(options({ worktree, base, head, extra: ['--test-one', 'node ' + script + ' {file}'] }))

  assert.equal(payload.stop_reason, 'completed', payload.notes)
  assert.equal(payload.error, null)
  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '?? src/scratch.txt',
    'the worktree got its own work back, and nobody else\'s')
  assert.doesNotMatch(git(dir, 'status', '--porcelain').stdout, /scratch\.txt/, 'and its work was never popped elsewhere')
  assert.deepEqual(git(worktree, 'stash', 'list', '--format=%gs').stdout.trim().split('\n').map((s) => s.replace(/^.*: /, '')),
    ['foreign'], 'the other tree\'s entry is still on the stack, and this one left nothing there')
  assert.equal(git(worktree, 'for-each-ref', 'refs/worktree/').stdout.trim(), '')
})

// ---------------------------------------------------------------- the red series

test('a red order: its test fails now and at base, and the failure is placed in its own file', (t) => {
  const { worktree, base, head } = order(t, { implemented: false })

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.stop_reason, 'completed')
  assert.equal(payload.error, null, 'a red suite is an observation, not a broken environment')
  assert.equal(payload.build, 'passed')
  assert.equal(payload.suite, 'failed')
  assert.deepEqual(payload.discriminator, [
    { test_id: 'test/widget.test.mjs', adds_test: true, failed_on_base: true, passes_now: false },
  ])

  const files = payload.failing_tests.map((f) => f.file)
  assert.ok(files.length > 0, 'a suite that failed while naming nothing is failing everywhere')
  assert.deepEqual([...new Set(files)], ['test/widget.test.mjs'],
    'every failure is placed in the order\'s own test file, repo-relative')
  assert.ok(payload.failing_tests.every((f) => f.id.trim() !== ''))
})

// ---------------------------------------------------------------- a measurement that failed

test('a series that could not be read is an error, never an empty findings array', (t) => {
  const { worktree, head } = order(t)

  const payload = verify(options({ worktree, base: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', head }))

  assert.deepEqual(payload.series_findings, [])
  assert.equal(payload.stop_reason, 'environment_broken')
  assert.equal(payload.error.kind, 'series_unreadable',
    'an empty findings array means "checked, found nothing" and must not be reachable any other way')
})

test('a changed test file with no way to run one test escalates instead of skipping it', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--expects', 'src/widget.mjs', '--expects', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE,
  ]))

  assert.deepEqual(payload.discriminator, [])
  assert.equal(payload.error.kind, 'command_unknown')
  assert.match(payload.error.message, /single-test/)
})

// ---------------------------------------------------------------- the imported log format

test('a checkpoint trailer under an ordinary subject is still a blocking finding', (t) => {
  // The trailer is the load-bearing half of the mark and the subject here is unremarkable, so
  // this only ever fires through lib/commit-series.mjs's own LOG_FORMAT. A log format
  // re-implemented in this file would pass every other test in it and silently lose this one.
  const { worktree, base, head } = order(t, { trailer: 'agentics-checkpoint: ran long' })

  const payload = verify(options({ worktree, base, head }))

  const checkpoint = payload.series_findings.find((f) => f.check === 'checkpoint-commit')
  assert.ok(checkpoint, 'the checkpoint mark reached the findings through the shared format')
  assert.equal(checkpoint.blocking, true)
})

test("a green's own commit that changes a test is a blocking finding", (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head, '--rigor', 'tdd-pair', '--role', 'green',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  const breach = payload.series_findings.find((f) => f.check === 'role-breach')
  assert.ok(breach, JSON.stringify(payload.series_findings))
  assert.equal(breach.blocking, true)
  assert.match(breach.message, /test\/widget\.test\.mjs/)
})

// ---------------------------------------------------------------- the integration head

test('integration mode measures the merged head and reports honest emptiness', (t) => {
  const { worktree } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--mode', 'integration', '--build', BUILD, '--typecheck-absent', '--suite', SUITE,
  ]))

  assert.equal(payload.stop_reason, 'completed')
  assert.equal(payload.build, 'passed')
  assert.equal(payload.suite, 'passed')
  assert.deepEqual(payload.series_findings, [])
  assert.deepEqual(payload.discriminator, [])
  assert.match(payload.notes, /merged head/)
})

test('a test that fails at the base too is baseline, and a test the change broke is not', (t) => {
  const { worktree } = order(t)
  const commit = (files, subject) => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(worktree, path), text)
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-q', '-m', subject)
    return rev(worktree, 'HEAD')
  }
  const broken = (extra) => "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { label } from '../src/widget.mjs'\n" +
    "test('broken before', () => assert.fail('already broken'))\ntest('widget labels', () => assert.equal(typeof label, 'function'))\n" + extra
  const base = commit({ 'test/broken.test.mjs': broken('') }, 'Add a broken test')
  const leaf = { rigor: 'trivial', expects: ['README.md', 'src/widget.mjs'] }
  const measure = (head) => verify({ ...options({ worktree, base, head }), expects: leaf.expects, rigor: 'trivial', checks: [SUITE] })

  const readmeHead = commit({ 'README.md': 'changed\n' }, 'Touch the readme')
  const readme = measure(readmeHead)
  assert.equal(readme.suite, 'not_run', 'a leaf that changed no test file runs no test beyond its checks')
  assert.equal(readme.suite_scope, 'none')
  const [asked] = readme.checks
  assert.equal(asked.status, 'failed')
  assert.deepEqual(asked.baseline_failing.map((f) => f.file), ['test/broken.test.mjs'], readme.notes)
  assert.equal(asked.baseline_failing.length, asked.failing_tests.length, 'every failure there fails at the base too')
  assert.deepEqual(measurementOk(readme, leaf).failures, [], 'a failure that was already there is not this change\'s')

  const merged = verify({ ...options({ worktree, base, head: readmeHead }), mode: 'integration' })
  assert.equal(merged.suite, 'failed')
  assert.equal(merged.baseline_failing.length, merged.failing_tests.length, merged.notes)
  assert.equal(suiteFailed(merged), false, 'the merged head is not charged for a failure its base had')

  const broke = measure(commit({ 'src/widget.mjs': 'export const widget = () => { throw new Error(\'no\') }\n' }, 'Break the widget'))
  const [again] = broke.checks
  assert.ok(again.failing_tests.length > again.baseline_failing.length, 'the change broke tests that pass at the base: ' + JSON.stringify(again.failing_tests))
  assert.ok(again.baseline_failing.every((f) => f.file === 'test/broken.test.mjs'))
  assert.ok(measurementOk(broke, leaf).failures.some((f) => f.check === 'check'), 'a regression in a file already failing at the base is not excused')
})

test('only a full suite runs under the project\'s test lock', (t) => {
  const { dir, worktree, base, head } = order(t)
  const lock = join(dir, '.agentics', '.state', 'locks', 'tests.lock').split('\\').join('/')
  const held = (want) => 'node -e "process.exit(require(\'fs\').existsSync(\'' + lock + '\') === ' + want + ' ? 0 : 1)"'
  const where = options({ worktree, base, head, extra: ['--repo', dir, '--effort', EFFORT, '--execution', EXECUTION, '--node', NODE] })

  const merged = verify({ ...where, mode: 'integration', build: held(false), suite: held(true) })
  assert.equal(merged.build, 'passed', 'the build ran with the lock free: ' + merged.notes)
  assert.equal(merged.suite, 'passed', 'the merged head\'s suite ran holding the lock: ' + merged.notes)
  assert.equal(merged.suite_scope, 'full')

  const leaf = verify({ ...where, rigor: 'trivial', suite: held(true), checks: [held(false), held(true) + ' && echo whole'] })
  assert.deepEqual(leaf.checks.map((c) => c.status), ['passed', 'passed'],
    'a check runs with the lock free unless it runs the suite command: ' + leaf.notes)
  assert.equal(existsSync(lock), false, 'released once the tests ran')
})
