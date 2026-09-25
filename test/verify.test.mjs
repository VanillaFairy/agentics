// test/verify.test.mjs — lib/verify.mjs, against real repositories.
//
// These are slow tests: each one stands in a real git worktree and runs a real node test suite
// inside it, several times. That cost is the point — the whole value of this file is that the
// discriminator moves HEAD, restores files, runs a suite there and puts the tree back, and none
// of that is observable against a mock.
//
// The repositories themselves come from test/harness/verify-fixture.mjs, which builds each
// distinct shape once and copies it per test. Construction is not the thing under test and used
// to cost more than everything that is; the copy is licensed by the equivalence test at the
// bottom of this file, which pins that a clone and a freshly built fixture produce the same
// verify() payload byte for byte.
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
//     through lib/commit-series.mjs's own format string, so this file re-implementing it would
//     silently stop finding them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { verify, parseArgs, isTestPath, worktreeProblem, extractFailures } from '../lib/verify.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import {
  BRANCH, BUILD, SUITE, TEST_ONE, WIDGET_TEST,
  git, rev, order, orderBuiltFresh, repository,
} from './harness/verify-fixture.mjs'

const CLI = fileURLToPath(new URL('../lib/verify.mjs', import.meta.url))

const options = (over = {}) => parseArgs([
  '--worktree', over.worktree,
  '--base', over.base,
  '--head', over.head,
  '--locus', 'src/widget.mjs',
  '--locus', 'test/widget.test.mjs',
  '--build', BUILD,
  '--typecheck-absent',
  '--suite', SUITE,
  '--test-one', TEST_ONE,
  ...(over.extra || []),
])

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

test('a linked worktree is accepted', (t) => {
  const { worktree } = order(t)
  assert.equal(worktreeProblem(worktree), null)
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
  assert.deepEqual(payload.series_findings, [], 'both changed files are inside the declared locus')
  assert.deepEqual(payload.discriminator, [
    { test_id: 'test/widget.test.mjs', failed_on_base: true, passes_now: true },
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
    'the stash was popped — uncommitted work is nobody else\'s to discard')
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
    { test_id: 'test/widget.test.mjs', failed_on_base: true, passes_now: false },
  ])

  const files = payload.failing_tests.map((f) => f.file)
  assert.ok(files.length > 0, 'a suite that failed while naming nothing is failing everywhere')
  assert.deepEqual([...new Set(files)], ['test/widget.test.mjs'],
    'every failure is placed in the order\'s own test file, repo-relative')
  assert.ok(payload.failing_tests.every((f) => f.id.trim() !== ''))
})

// ---------------------------------------------------------------- absent, and unknown

test('an absent build command is recorded absent only when somebody declared it so', (t) => {
  const { worktree, base, head } = order(t)

  const declared = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
    '--build-absent', '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  assert.equal(declared.build, 'absent')
  assert.equal(declared.stop_reason, 'completed')
  assert.equal(declared.error, null, 'a repository with no build command is a fact, not a fault')
  assert.equal(declared.suite, 'passed')
})

test('a build command nobody named escalates rather than reading as a repository with none', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
    '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  assert.equal(payload.build, 'absent')
  assert.equal(payload.stop_reason, 'environment_broken',
    'a caller that never reads `error` must still fail safe')
  assert.equal(payload.error.kind, 'command_unknown')
  assert.match(payload.error.message, /build/)
})

// ---------------------------------------------------------------- the typecheck

test('a failing typecheck is recorded beside a PASSING suite, which is the whole point', (t) => {
  // The field case, reproduced: 826 tests green over a tree `tsc --noEmit` rejected. Vitest and
  // Jest transform TypeScript with esbuild, which strips types without checking them, so the
  // suite is structurally incapable of answering this question and answering it anyway is how a
  // branch tip ships with a broken build under a green report.
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck', 'node -e "process.exit(2)"',
    '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  assert.equal(payload.suite, 'passed', 'the suite is green and says nothing about the types')
  assert.equal(payload.build, 'passed')
  assert.equal(payload.typecheck, 'failed', 'and the third answer is the one that is not green')
  assert.equal(payload.stop_reason, 'completed',
    'a failed typecheck is a measurement outcome, not a broken environment')
  assert.match(payload.notes, /typecheck output tail:/,
    'the fix round is shown what failed, not just that something did')
})

test('a typecheck nobody named escalates rather than reading as a repository with none', (t) => {
  // The same refusal the build gets, for the same reason and no weaker: defaulting an unnamed
  // typecheck to `absent` would rebuild the exact hole this field was added to close — a check
  // that silently does not run. It costs no extra escalation, because the first verification in
  // a run already escalates to establish the build.
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
    '--build', BUILD, '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  assert.equal(payload.typecheck, 'absent')
  assert.equal(payload.stop_reason, 'environment_broken')
  assert.equal(payload.error.kind, 'command_unknown')
  assert.match(payload.error.message, /typecheck/)
})

test('a declared-absent typecheck is a fact about the repository, not a fault', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.typecheck, 'absent')
  assert.equal(payload.stop_reason, 'completed')
  assert.equal(payload.error, null)
  assert.match(payload.notes, /no typecheck command/)
})

// ---------------------------------------------------------------- the mutation check

const mutations = (specs) => ['--mutations-b64', Buffer.from(JSON.stringify(specs)).toString('base64')]

test('a regression net that catches its own mutation bites, and the tree is put back', (t) => {
  // The right question for a regression net, which is excused the base question. The
  // fixture's test asserts `label() === 'hi'`; breaking the source is what makes it fail, and
  // a net that fails under the break is a net.
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: mutations([
    { file: 'src/widget.mjs', find: "'hi'", replace: "'bye'",
      expect_failing: ['test/widget.test.mjs'] },
  ]) }))

  assert.equal(payload.mutations.length, 1)
  assert.equal(payload.mutations[0].applied, true)
  assert.equal(payload.mutations[0].bites, true)
  assert.deepEqual(payload.mutations[0].observed_failing, ['test/widget.test.mjs'])
  assert.equal(payload.stop_reason, 'completed')

  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '',
    'a deliberate break left in the tree sends the next fix round after a defect nobody wrote')
  assert.equal(readFileSync(join(worktree, 'src', 'widget.mjs'), 'utf8').includes("'hi'"), true)
})

test('a net that survives the break it exists to catch does NOT bite', (t) => {
  // The finding this check exists to produce: the tests pass, they passed at base, and they would
  // pass with the thing they claim to guard broken. Nothing else in the pipeline can see that.
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: mutations([
    { file: 'src/widget.mjs', find: 'const label', replace: 'const  label',
      expect_failing: ['test/widget.test.mjs'] },
  ]) }))

  assert.equal(payload.mutations[0].applied, true)
  assert.equal(payload.mutations[0].bites, false)
  assert.deepEqual(payload.mutations[0].observed_failing, [])
  assert.equal(payload.stop_reason, 'completed',
    'a net that does not bite is a measurement outcome, not a broken environment')
})

test('a stale spec is unapplied, and is never reported as a net that does not bite', (t) => {
  // The two must not collapse into each other. A `find` that no longer occurs is a defect in the
  // SPEC — the plan is out of date — and reading it as evidence about the test is the laundering
  // IRON LAW §2 forbids.
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: mutations([
    { file: 'src/widget.mjs', find: "'this text is not in the file'", replace: 'x',
      expect_failing: ['test/widget.test.mjs'] },
  ]) }))

  assert.equal(payload.mutations[0].applied, false)
  assert.equal(payload.mutations[0].bites, false)
  assert.match(payload.mutations[0].unapplied_reason, /stale/)
  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '')
})

test('a spec whose text occurs more than once is refused as ambiguous', (t) => {
  // Which site was broken decides what the run learned, and a substitution applied to all of them
  // is a different experiment from the one the plan described.
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: mutations([
    { file: 'test/widget.test.mjs', find: 'label', replace: 'nope',
      expect_failing: ['test/widget.test.mjs'] },
  ]) }))

  assert.equal(payload.mutations[0].applied, false)
  assert.match(payload.mutations[0].unapplied_reason, /occurs \d+ times/)
  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '')
})

test('a spec naming no failing test asks nothing, and says so', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: mutations([
    { file: 'src/widget.mjs', find: "'hi'", replace: "'bye'", expect_failing: [] },
  ]) }))

  assert.equal(payload.mutations[0].applied, false)
  assert.match(payload.mutations[0].unapplied_reason, /names no test/)
})

test('an order declaring no mutation records an empty list and runs nothing', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head }))

  assert.deepEqual(payload.mutations, [],
    'every order written before this field existed is this case, and must be untouched')
})

test('a failing build is an observed exit, and its output travels as evidence', (t) => {
  const { worktree, base, head } = order(t)
  writeFileSync(join(worktree, 'tools', 'build.mjs'), 'process.exit(3)\n')

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.build, 'failed')
  assert.equal(payload.stop_reason, 'completed', 'a broken build is a fact to report')
  assert.match(payload.notes, /exited 3/)
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
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
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

test('a commit outside the declared locus is a blocking finding', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  const breach = payload.series_findings.find((f) => f.check === 'locus-breach')
  assert.ok(breach)
  assert.match(breach.message, /src\/widget\.mjs/)
})

// ---------------------------------------------------------------- verbatim output

test('suite_output_tail is the suite\'s own last lines, byte for byte', (t) => {
  const { worktree, base, head } = order(t, { implemented: false })

  const payload = verify(options({ worktree, base, head }))

  const direct = spawnSync(SUITE, { cwd: worktree, shell: true, encoding: 'utf8' })
  const expected = ((direct.stdout || '') + (direct.stderr || '')).split('\n').slice(-40).join('\n')

  // Timings differ run to run; the SHAPE and the content that is not a clock must not.
  const scrub = (text) => text.replace(/\(\d+(\.\d+)?ms\)/g, '(Xms)')
    .replace(/duration_ms [\d.]+/g, 'duration_ms X')
  assert.equal(scrub(payload.suite_output_tail), scrub(expected))
  assert.ok(payload.suite_output_tail.split('\n').length <= 40)
})

// Every byte in the payload is retyped by a model on the way back, and the tail is the only
// unbounded field in it. It rides when a fix round will read it and not otherwise.
test('a passing suite carries no tail: nothing downstream ever opens one', (t) => {
  const { worktree, base, head } = order(t, { implemented: true })

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.suite, 'passed')
  assert.equal(payload.suite_output_tail, '',
    'a passing suite\'s output has no reader and is the largest field a courier carries')
})

test('a failing suite still carries its tail, because that IS the fix round\'s evidence', (t) => {
  const { worktree, base, head } = order(t, { implemented: false })

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.suite, 'failed')
  assert.ok(payload.suite_output_tail.length > 0)
})

// The banner rules a runner draws around a failure are the one part of a tail a courier has to
// COUNT rather than read, and counting is where the single corrupted payload of run
// 20260902-124933 was damaged. Collapsing them costs no word of the evidence.
test('a runner\'s banner rules collapse, and everything that is not a rule survives', (t) => {
  const { worktree } = order(t, { implemented: true })

  writeFileSync(join(worktree, 'noisy.mjs'),
    "process.stdout.write('\\u23af'.repeat(24) + ' Failed Suites 1 ' + '\\u23af'.repeat(7) + '\\n')\n" +
    "process.stdout.write('\\u276f zażółć gęślą jaźń \\u2014 an assertion diff\\n')\n" +
    'process.exit(1)\n')

  const payload = verify(parseArgs([
    '--worktree', worktree, '--mode', 'integration', '--build-absent',
    '--suite', 'node noisy.mjs',
  ]))

  assert.equal(payload.suite, 'failed')
  assert.ok(!/\u23af{2}/.test(payload.suite_output_tail),
    'a run of identical rule glyphs is decoration a courier must count; one of them says the same')
  assert.match(payload.suite_output_tail, /Failed Suites 1/)
  assert.match(payload.suite_output_tail, /\u276f zażółć gęślą jaźń \u2014 an assertion diff/,
    'non-ASCII that is not a repeated rule is evidence and is never touched')
})

test('blank lines are shape, not decoration, and survive the collapse', (t) => {
  const { worktree } = order(t, { implemented: true })

  writeFileSync(join(worktree, 'noisy.mjs'),
    "process.stdout.write('first\\n\\n\\n\\nlast\\n')\nprocess.exit(1)\n")

  const payload = verify(parseArgs([
    '--worktree', worktree, '--mode', 'integration', '--build-absent',
    '--suite', 'node noisy.mjs',
  ]))

  assert.match(payload.suite_output_tail, /first\n\n\n\nlast/,
    'a line terminator is outside printable ASCII too, and collapsing it would change the ' +
    'tail\'s shape rather than its decoration')
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

// ---------------------------------------------------------------- the transport

test('the CLI prints one line whose digest covers the payload it carries', (t) => {
  const { worktree, base, head } = order(t)

  const run = spawnSync(process.execPath, [CLI,
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
  ], { encoding: 'utf8' })

  assert.equal(run.status, 0, 'a payload was printed, which is what this tool produces')
  assert.equal(run.stdout.trim().split('\n').length, 1, 'ONE line, for a courier to paste')

  const parsed = JSON.parse(run.stdout)
  assert.equal(fnv1a(canonical(parsed.payload)), parsed.payload_digest)

  const tampered = { ...parsed.payload, suite: 'absent' }
  assert.notEqual(fnv1a(canonical(tampered)), parsed.payload_digest,
    'a payload that drifted by one field digests differently, which is the whole point')
})

test('a typed error still travels under a digest, and still exits 0', (t) => {
  const dir = repository(t)

  const run = spawnSync(process.execPath, [CLI, '--worktree', dir, '--base', rev(dir, 'HEAD'),
    '--head', rev(dir, 'HEAD'), '--build', BUILD, '--typecheck-absent', '--suite', SUITE], { encoding: 'utf8' })

  assert.equal(run.status, 0,
    'a refusal is a measurement outcome, and a non-zero exit would read as the tool failing')
  const parsed = JSON.parse(run.stdout)
  assert.equal(parsed.payload.error.kind, 'main_worktree')
  assert.equal(fnv1a(canonical(parsed.payload)), parsed.payload_digest)
})

test('base64 command transport decodes to the same commands', () => {
  const encoded = Buffer.from('npm run build --workspace "a b"', 'utf8').toString('base64')
  assert.equal(parseArgs(['--build-b64', encoded]).build, 'npm run build --workspace "a b"')
})

// ---------------------------------------------------------------- the journal

test('the observation is journalled by the process that observed it', (t) => {
  const { dir, worktree, base, head } = order(t)
  const runDir = dir + '/run'
  mkdirSync(runDir)

  const run = spawnSync(process.execPath, [CLI,
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
    '--journal', runDir, '--seq', '7', '--order', 'W1', '--branch', BRANCH,
  ], { encoding: 'utf8' })

  const parsed = JSON.parse(run.stdout)
  assert.equal(parsed.payload.journal.written, true)

  const lines = spawnSync(process.execPath, ['-e',
    'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))',
    runDir + '/journal.jsonl'], { encoding: 'utf8' }).stdout.trim().split('\n')

  assert.equal(lines.length, 1)
  const line = JSON.parse(lines[0])
  assert.equal(line.kind, 'verify-observed')
  assert.equal(line.seq, 7, 'the seq is copied from the dispatch, never chosen here')
  assert.equal(line.order, 'W1')
  assert.equal(line.branch, BRANCH)
  assert.equal(line.head_sha, head)
  assert.equal(line.build, 'passed')
  assert.equal(line.typecheck, 'absent')
  assert.equal(line.suite, 'passed')
  assert.deepEqual(line.discriminator, parsed.payload.discriminator)
  assert.deepEqual(Object.keys(line).sort(), [
    'base_sha', 'branch', 'build', 'discriminator', 'failing_tests', 'head_sha', 'kind',
    'mutations', 'order', 'seq', 'series_findings', 'stop_reason', 'suite', 'typecheck',
    'worktree',
  ], 'the line shape is the one docs/DESIGN.md#journal-lines names — a resume re-derives ' +
     'verdicts from this line, and both predicates read `typecheck` and `mutations`')
})

// ---------------------------------------------------------------- the closed pattern set

test('the test-file pattern set recognises the shapes it claims to', () => {
  for (const path of ['test/a.test.mjs', 'tests/b.py', 'src/__tests__/c.js', 'spec/d.rb',
    'lib/e.spec.ts', 'pkg/f_test.go', 'app/test_g.py', 'src/WidgetTest.java']) {
    assert.ok(isTestPath(path), path + ' should read as a test file')
  }
  for (const path of ['src/widget.mjs', 'docs/testing.md', 'latest/thing.js', 'src/protest.c']) {
    assert.ok(!isTestPath(path), path + ' should not read as a test file')
  }
})

// ---------------------------------------------------------------- summary lines vs paths
//
// The scanner's summary guard exists so a runner's counters are not attributed to whatever file
// was printed last. Its cost, until 20260902-124933, was that `tests/` is also how most of the
// world names its test directory: `\b` treats `/` as a word boundary, so every vitest and jest
// `FAIL tests/…` line read as the summary word `tests` and was discarded. The suite then failed
// while naming nothing, which is `suite_failures_unnamed`, which is `environment_broken`, which
// `verifiable()` refuses — so a correct red order could not be verified at all and the fix round
// sent at it had no defect to find.

test('a FAIL line naming a path under tests/ is a failure, not a summary counter', (t) => {
  const { worktree } = order(t, { implemented: true })
  writeFileSync(join(worktree, 'test', 'widget.test.mjs'), WIDGET_TEST)

  const found = extractFailures(
    ' FAIL  test/widget.test.mjs [ test/widget.test.mjs ]\n' +
    "Error: Cannot find module '../src/nothing.mjs'\n", worktree)

  assert.equal(found.unplaced, 0)
  assert.deepEqual(found.failures.map((f) => f.file), ['test/widget.test.mjs'],
    'the runner named the file on its own FAIL line; nothing here has to guess')
})

test('a runner\'s own counters are still discarded, which is what the guard is for', (t) => {
  const { worktree } = order(t, { implemented: true })

  for (const line of ['✖ tests 5', '✖ pass 4', '✖ fail 1',
    '✖ duration_ms 12.5', '✖ cancelled 0', 'FAIL  Tests  3 failed']) {
    const found = extractFailures(line + '\n', worktree)
    assert.deepEqual(found.failures, [], line + ' names no test and must place nothing')
    assert.equal(found.unplaced, 0, line + ' is a counter, not a failure nobody could place')
  }
})

// ---------------------------------------------------------------- the fixture's own licence
//
// Every test above stands in a COPY of a template rather than in a repository built for it, and
// the saving is worth roughly half this file's wall clock. What makes that legitimate is not the
// argument in the fixture module's header — it is this comparison. A clone and a freshly built
// fixture are handed to the same real verify(), and every field of the payload must agree.
//
// Both roles are covered because they exercise different halves of the machinery: a green order
// takes the discriminator's "passes now" path and leaves the suite green, a red one fails the
// suite, populates failing_tests and takes the other branch. A clone that diverged on either —
// a worktree whose repair left it pointing at the template, a stale index, a HEAD that did not
// come back — shows up here as a diff instead of as a mystery months later.

/** The fields a caller's verdict is computed from. Timings and shas are neither. */
const verdictShape = (p) => ({
  stop_reason: p.stop_reason,
  build: p.build,
  suite: p.suite,
  failing_tests: p.failing_tests,
  discriminator: p.discriminator,
  series_findings: p.series_findings,
  error: p.error,
})

for (const implemented of [true, false]) {
  const role = implemented ? 'green' : 'red'

  test(`a cloned fixture and a built one measure identically — ${role} order`, (t) => {
    const cloned = verify(options(order(t, { implemented })))
    const built = verify(options(orderBuiltFresh(t, { implemented })))

    assert.deepEqual(verdictShape(cloned), verdictShape(built),
      'the copy is only sound while it is indistinguishable from real construction')
    assert.equal(cloned.suite, implemented ? 'passed' : 'failed',
      'and the comparison is only worth anything while it covers both roles')
  })
}

test('a clone comes back on its branch and clean, exactly as a built fixture does', (t) => {
  const fixture = order(t)
  const { worktree } = fixture

  verify(options(fixture))

  assert.equal(git(worktree, 'branch', '--show-current').stdout.trim(), BRANCH,
    'a worktree left detached strands every commit a later fix round makes in it')
  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '',
    'the discriminator stashes and moves HEAD; what it borrowed it puts back')
})

test('two clones share a template and nothing else', (t) => {
  const a = order(t)
  const b = order(t)

  writeFileSync(join(a.worktree, 'src', 'widget.mjs'), "export const label = () => 'mutated'\n")

  assert.notEqual(a.dir, b.dir)
  assert.equal(git(b.worktree, 'status', '--porcelain').stdout.trim(), '',
    'a template poisoned by one test would reach every test taken after it')
})
