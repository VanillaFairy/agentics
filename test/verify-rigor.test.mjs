// test/verify-rigor.test.mjs — lib/verify.mjs, against real repositories: rigor and role select
// the checks. See test/verify-series.test.mjs for the whole family.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeNode } from '../lib/tree.mjs'
import { measurementOk } from '../lib/verdict.mjs'
import { verify, parseArgs } from '../lib/verify.mjs'
import {
  BUILD, cycle, git, mutations, options, order, rev, SUITE, TEST_ONE,
} from './harness/verify-fixture.mjs'

// ---------------------------------------------------------------- rigor selects the checks

const check = (command) => ['--check-b64', Buffer.from(command, 'utf8').toString('base64')]

test('a trivial leaf asks no discriminator, and runs its named checks', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: [
    '--rigor', 'trivial', ...check('node -e "process.exit(0)"'), ...check('node -e "process.exit(4)"'),
  ] }))

  assert.equal(payload.stop_reason, 'completed')
  assert.deepEqual(payload.discriminator, [], 'a trivial change has no test that would not restate it')
  assert.deepEqual(payload.series_findings, [], 'but its series is still held to its role')
  assert.deepEqual(payload.checks, [
    { command: 'node -e "process.exit(0)"', status: 'passed', failing_tests: [], baseline_failing: [] },
    { command: 'node -e "process.exit(4)"', status: 'failed', failing_tests: [], baseline_failing: [] },
  ])
  assert.match(payload.notes, /check "node -e \\"process.exit\(4\)\\"": failed \(exit 4\)/)
})

test('a named check that cannot be launched is unrunnable, never failed', (t) => {
  // 127 is the shell's own "no such command". A check nobody could launch was never observed,
  // and a fix round sent after it would look for a defect in code that is really in the criterion.
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: [
    '--rigor', 'trivial', ...check('agentics-no-such-command-anywhere --flag'),
  ] }))

  assert.deepEqual(payload.checks, [{ command: 'agentics-no-such-command-anywhere --flag', status: 'unrunnable', failing_tests: [], baseline_failing: [] }])
  assert.equal(payload.stop_reason, 'completed', 'an unrunnable check is an outcome the verdict reads')
})

test('a verify leaf runs no series and no discriminator: it writes nothing', (t) => {
  // Measured in a worktree whose branch carries commits — which a verify leaf
  // would have to be blamed for if its series were checked. It is not.
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head, '--rigor', 'verify',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE,
    ...check('node -e "process.exit(0)"'),
  ]))

  assert.equal(payload.stop_reason, 'completed')
  assert.equal(payload.error, null, 'no single-test command is needed where no discriminator runs')
  assert.deepEqual(payload.series_findings, [])
  assert.deepEqual(payload.discriminator, [])
  assert.deepEqual(payload.checks, [{ command: 'node -e "process.exit(0)"', status: 'passed', failing_tests: [], baseline_failing: [] }])
  assert.equal(payload.build, 'passed')
  assert.equal(payload.suite, 'not_run', 'a leaf that writes nothing has no test of its own to run')
  assert.equal(payload.suite_scope, 'none')
  assert.match(payload.notes, /series check not run/)
})

test('a verify leaf still refuses a command nobody named: absent is never inferred', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head, '--rigor', 'verify',
    '--typecheck-absent', '--suite', SUITE, ...check('node -e "0"'),
  ]))

  assert.equal(payload.error.kind, 'command_unknown')
  assert.match(payload.error.message, /build/)
})

test('a red leaf runs no mutation and no named check, and says what it was given', (t) => {
  const { worktree, base, head } = order(t, { implemented: false })

  const payload = verify(options({ worktree, base, head, extra: [
    '--rigor', 'tdd-pair', '--role', 'red', ...check('node -e "0"'),
    ...mutations([{ file: 'src/widget.mjs', find: "'plain'", replace: "'x'", expect_failing: ['test/widget.test.mjs'] }]),
  ] }))

  assert.equal(payload.stop_reason, 'completed')
  assert.deepEqual(payload.discriminator, [
    { test_id: 'test/widget.test.mjs', blob: rev(worktree, head + ':test/widget.test.mjs'), base_blob: '', adds_test: true, failed_on_base: true, passes_now: false },
  ])
  assert.deepEqual(payload.mutations, [])
  assert.deepEqual(payload.checks, [])
  assert.match(payload.notes, /1 mutation spec\(s\) given and not run/)
  assert.match(payload.notes, /1 named check\(s\) given and not run/)
})

test('a green leaf is discriminated over its cycle\'s tests, which its own diff does not touch', (t) => {
  const { worktree, red, head } = cycle(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', red, '--head', head,
    '--rigor', 'tdd-pair', '--role', 'green', '--expects', 'src/widget.mjs',
    '--test-file', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  assert.equal(payload.stop_reason, 'completed')
  assert.deepEqual(payload.series_findings, [], 'the green series touches no test')
  assert.deepEqual(payload.discriminator, [
    { test_id: 'test/widget.test.mjs', blob: rev(worktree, head + ':test/widget.test.mjs'), base_blob: rev(worktree, red + ':test/widget.test.mjs'), adds_test: true, failed_on_base: true, passes_now: true },
  ], 'the red test fails at the red head and passes now')
  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '')
  assert.equal(rev(worktree, 'HEAD'), head)
})

test('a green leaf with no cycle tests named measures its own diff, finds none, and says so', (t) => {
  const { worktree, red, head } = cycle(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', red, '--head', head,
    '--rigor', 'tdd-pair', '--role', 'green', '--expects', 'src/widget.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  assert.deepEqual(payload.discriminator, [])
  assert.match(payload.notes, /none of the red tests was measured/)
})

test('an audit leaf expects an empty series, and its declared mutations are run', (t) => {
  // An auditor edits nothing, so its branch is its green's head with no commit of its own.
  const { worktree, head } = order(t)

  const payload = verify(options({ worktree, base: head, head, extra: [
    '--rigor', 'tdd-triad', '--role', 'audit',
    ...mutations([{ file: 'src/widget.mjs', find: "'hi'", replace: "'bye'", expect_failing: ['test/widget.test.mjs'] }]),
  ] }))

  assert.equal(payload.stop_reason, 'completed')
  assert.deepEqual(payload.series_findings, [], 'an empty series is the audit\'s expected shape')
  assert.deepEqual(payload.discriminator, [])
  assert.equal(payload.mutations.length, 1)
  assert.equal(payload.mutations[0].bites, true)
})

test('an empty series is still a blocking finding for every other rigor', (t) => {
  const { worktree, head } = order(t)
  const payload = verify(options({ worktree, base: head, head, extra: ['--rigor', 'trivial'] }))
  assert.equal(payload.series_findings[0].check, 'empty-series')
  assert.equal(payload.series_findings[0].blocking, true)
})

test('a tests-only leaf runs the discriminator and its declared mutations', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: [
    '--rigor', 'tests-only',
    ...mutations([{ file: 'src/widget.mjs', find: "'hi'", replace: "'bye'", expect_failing: ['test/widget.test.mjs'] }]),
  ] }))

  assert.equal(payload.stop_reason, 'completed')
  assert.equal(payload.discriminator.length, 1)
  assert.equal(payload.discriminator[0].passes_now, true)
  assert.equal(payload.mutations.length, 1)
  assert.equal(payload.mutations[0].applied, true)
  assert.equal(payload.mutations[0].bites, true, 'a net that fails under the break it guards is a net')
  assert.deepEqual(payload.mutations[0].observed_failing, ['test/widget.test.mjs'])
  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '',
    'a deliberate break left in the tree sends the next fix round after a defect nobody wrote')
  assert.equal(readFileSync(join(worktree, 'src', 'widget.mjs'), 'utf8').includes("'hi'"), true, 'the tree is put back')
})

test('a tdd leaf that only keeps another test file up to date, declared upkeep, records it so and passes; undeclared it adds a case', (t) => {
  // The field case: a constructor gains an argument, and the leaf passes it at every existing
  // call site in a test file that adds no test of its own. That file passes at base as well, by
  // construction, and no commit could make it fail there.
  const { worktree, base } = order(t)
  writeFileSync(join(worktree, 'test', 'base.test.mjs'),
    "import { test } from 'node:test'\nconst options = { id: 'base' }\ntest('the base suite passes', () => {})\n")
  git(worktree, 'commit', '-qam', 'test: pass the new argument at the base call site')
  const head = rev(worktree, 'HEAD')

  const given = options({ worktree, base, head, extra: ['--rigor', 'tdd', '--expects', 'test/base.test.mjs'] })
  const payload = verify({ ...given, upkeep: ['test/base.test.mjs'] })

  assert.equal(payload.stop_reason, 'completed', payload.notes)
  const byFile = Object.fromEntries(payload.discriminator.map((d) => [d.test_id, d]))
  const blob = (file) => rev(worktree, head + ':' + file)
  assert.deepEqual(byFile['test/widget.test.mjs'], { test_id: 'test/widget.test.mjs', blob: blob('test/widget.test.mjs'), base_blob: '', adds_test: true, failed_on_base: true, passes_now: true })
  assert.deepEqual(byFile['test/base.test.mjs'], { test_id: 'test/base.test.mjs', blob: blob('test/base.test.mjs'), base_blob: rev(worktree, base + ':test/base.test.mjs'), adds_test: false, failed_on_base: false, passes_now: true })
  assert.match(payload.notes, /1 of 2 test file\(s\) add a test case; upkeep or untouched, adding none: test\/base\.test\.mjs/)
  assert.deepEqual(measurementOk(payload, normalizeNode({ id: 'w1', kind: 'leaf', rigor: 'tdd', expects: ['src/'] })).failures, [])
  const undeclared = verify(given).discriminator.find((d) => d.test_id === 'test/base.test.mjs')
  assert.equal(undeclared.adds_test, true, 'a file nobody declared upkeep is held to the whole question')
})

test('an upkeep declaration over a file whose diff adds a test case waives nothing: the case is held to failing at base', (t) => {
  // The producer's declaration is about its own work. A case it adds that already passes at base,
  // declared upkeep, would otherwise pass a tdd leaf on the strength of its other file.
  const { worktree, base } = order(t)
  writeFileSync(join(worktree, 'test', 'base.test.mjs'),
    "import { test } from 'node:test'\ntest('the base suite passes', () => {})\ntest('a case that held all along', () => {})\n")
  git(worktree, 'commit', '-qam', 'test: a case over behaviour that already holds')
  const head = rev(worktree, 'HEAD')

  const payload = verify({ ...options({ worktree, base, head, extra: ['--rigor', 'tdd', '--expects', 'test/base.test.mjs'] }), upkeep: ['test/base.test.mjs'] })

  assert.equal(payload.stop_reason, 'completed', payload.notes)
  const declared = payload.discriminator.find((d) => d.test_id === 'test/base.test.mjs')
  assert.equal(declared.adds_test, true, 'a declared file that adds a case adds one')
  assert.equal(declared.failed_on_base, false)
  assert.match(payload.notes, /declared upkeep and read as adding a test case: test\/base\.test\.mjs adds test\('a case that held all along'/)
  const verdict = measurementOk(payload, normalizeNode({ id: 'w1', kind: 'leaf', rigor: 'tdd', expects: ['src/'] }))
  assert.ok(verdict.failures.some((f) => f.check === 'discriminator' && f.claim.startsWith('test/base.test.mjs passes at base')),
    JSON.stringify(verdict.failures))
})
