// test/verify-rigor.test.mjs — lib/verify.mjs, against real repositories: rigor and role select
// the checks. See test/verify-series.test.mjs for the whole family.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeNode } from '../lib/tree.mjs'
import { measurementOk } from '../lib/verdict.mjs'
import { addsTestCase, verify, parseArgs, checksFor } from '../lib/verify.mjs'
import {
  BUILD, cycle, EXECUTION, git, mutations, options, order, rev, SUITE, TEST_ONE,
} from './harness/verify-fixture.mjs'

// ---------------------------------------------------------------- rigor selects the checks

test('checksFor: the SPEC table, a role outranking its rigor and integration outranking both', () => {
  const pick = (o) => {
    const c = checksFor(o)
    return [c.profile, c.series, c.discriminator, c.mutations, c.checks, c.emptySeriesExpected]
  }
  assert.deepEqual(pick({ rigor: 'verify' }), ['verify', false, false, false, true, false])
  assert.deepEqual(pick({ rigor: 'trivial' }), ['trivial', true, false, false, true, false])
  assert.deepEqual(pick({ rigor: 'tests-only' }), ['tests-only', true, true, true, true, false])
  assert.deepEqual(pick({ rigor: 'tdd' }), ['tdd', true, true, true, true, false])
  assert.deepEqual(pick({ rigor: 'tdd-pair', role: 'red' }), ['red', true, true, false, false, false])
  assert.deepEqual(pick({ rigor: 'tdd-triad', role: 'green' }), ['green', true, true, false, true, false])
  assert.deepEqual(pick({ rigor: 'tdd-pair', role: 'green', producer: 'test-author' }), ['green-tests', true, true, true, true, false],
    'a green\'s test-author round is measured by the breaks its new tests catch')
  assert.deepEqual(pick({ rigor: 'tdd-triad', role: 'audit' }), ['audit', true, false, true, false, true])
  assert.deepEqual(pick({}), ['tdd', true, true, true, true, false], 'no rigor measures as before rigor existed')
  assert.deepEqual(pick({ mode: 'integration', rigor: 'tdd-pair', role: 'red' }),
    ['integration', false, false, false, true, false])
})

const check = (command) => ['--check-b64', Buffer.from(command, 'utf8').toString('base64')]

test('a trivial leaf asks no discriminator, and runs its named checks', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: [
    '--rigor', 'trivial', ...check('node -e "process.exit(0)"'), ...check('node -e "process.exit(4)"'),
  ] }))

  assert.equal(payload.stop_reason, 'completed')
  assert.deepEqual(payload.discriminator, [], 'a trivial change has no test that would not restate it')
  assert.deepEqual(payload.series_findings, [], 'but its series is still held to the locus')
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
  // Measured in a worktree whose branch carries commits outside any locus — which a verify leaf
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
    { test_id: 'test/widget.test.mjs', adds_test: true, failed_on_base: true, passes_now: false },
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
    '--rigor', 'tdd-pair', '--role', 'green', '--locus', 'src/widget.mjs',
    '--test-file', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  assert.equal(payload.stop_reason, 'completed')
  assert.deepEqual(payload.series_findings, [], 'the green series touches only its own locus')
  assert.deepEqual(payload.discriminator, [
    { test_id: 'test/widget.test.mjs', adds_test: true, failed_on_base: true, passes_now: true },
  ], 'the red test fails at the red head and passes now')
  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '')
  assert.equal(rev(worktree, 'HEAD'), head)
})

test('a green leaf with no cycle tests named measures its own diff, finds none, and says so', (t) => {
  const { worktree, red, head } = cycle(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', red, '--head', head,
    '--rigor', 'tdd-pair', '--role', 'green', '--locus', 'src/widget.mjs',
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

  assert.equal(payload.discriminator.length, 1)
  assert.equal(payload.discriminator[0].passes_now, true)
  assert.equal(payload.mutations[0].bites, true)
})

test('a tdd leaf that only keeps another test file up to date records it as upkeep, and passes', (t) => {
  // The field case: a constructor gains an argument, and the leaf passes it at every existing
  // call site in a test file that adds no test of its own. That file passes at base as well, by
  // construction, and no commit could make it fail there.
  const { worktree, base } = order(t)
  writeFileSync(join(worktree, 'test', 'base.test.mjs'),
    "import { test } from 'node:test'\nconst options = { id: 'base' }\ntest('the base suite passes', () => {})\n")
  git(worktree, 'commit', '-qam', 'test: pass the new argument at the base call site')
  const head = rev(worktree, 'HEAD')

  const payload = verify(options({ worktree, base, head, extra: ['--rigor', 'tdd', '--locus', 'test/base.test.mjs'] }))

  assert.equal(payload.stop_reason, 'completed', payload.notes)
  const byFile = Object.fromEntries(payload.discriminator.map((d) => [d.test_id, d]))
  assert.deepEqual(byFile['test/widget.test.mjs'], { test_id: 'test/widget.test.mjs', adds_test: true, failed_on_base: true, passes_now: true })
  assert.deepEqual(byFile['test/base.test.mjs'], { test_id: 'test/base.test.mjs', adds_test: false, failed_on_base: false, passes_now: true })
  assert.match(payload.notes, /1 of 2 test file\(s\) add a test case; upkeep, adding none: test\/base\.test\.mjs/)
  assert.deepEqual(measurementOk(payload, normalizeNode({ id: 'w1', kind: 'leaf', rigor: 'tdd', locus: ['src/'] })).failures, [])
})

test('addsTestCase: an added declaration adds a test case; a call site, a moved test or a regex does not', () => {
  const diff = (...lines) => ['diff --git a/t b/t', '--- a/t', '+++ b/t', '@@ -1 +1 @@', ...lines].join('\n')
  const adds = [
    ["+test('a new case', () => {})"],
    ["+  it('a new case', async () => {"],
    ['+it.each([1, 2])(\'case %i\', (n) => {})'],
    ['+test.each`a | b`(\'table\', () => {})'],
    ['+def test_new_case():'],
    ['+func TestNewCase(t *testing.T) {'],
    ['+#[test]'],
    ['+    @Test'],
    ['+    [Fact]'],
  ]
  const none = [
    ['-  new DeckSource(cards)', '+  new DeckSource(cards, id)'],
    ["-test('moved', () => {})", "+test('moved', () => {})"],
    ['+const ok = /x/.test(name)'],
    ['+  // call it (once)'],
    ["+it.skip('later', () => {})"],
    [],
  ]
  for (const lines of adds) assert.equal(addsTestCase(diff(...lines)), true, lines.join(' | '))
  for (const lines of none) assert.equal(addsTestCase(diff(...lines)), false, lines.join(' | '))
  assert.equal(addsTestCase("+++ b/test('header', () => {})\n"), false, 'nothing before the first hunk is a line of the file')
})

test('named checks travel only as base64, and every option parses', () => {
  const o = parseArgs(['--rigor', 'tdd-pair', '--role', 'green', '--test-file', 'test/a.test.mjs',
    ...check("npm run e2e -- 'login flow'"), '--repo', '/r', '--effort', 'e', '--execution', EXECUTION,
    '--node', 'a/b', '--branch', 'agentics/e--a.b'])
  assert.equal(o.rigor, 'tdd-pair')
  assert.equal(o.role, 'green')
  assert.deepEqual(o.tests, ['test/a.test.mjs'])
  assert.deepEqual(o.checks, ["npm run e2e -- 'login flow'"])
  assert.equal(o.repo, '/r')
  assert.equal(o.effort, 'e')
  assert.equal(o.execution, EXECUTION)
  assert.equal(o.node, 'a/b')
  assert.equal(parseArgs([]).role, 'none')
  assert.deepEqual(parseArgs([]).checks, [])
})
