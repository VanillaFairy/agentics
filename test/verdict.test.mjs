// test/verdict.test.mjs — lib/verdict.mjs, pure and table-driven.
//
// One measurement shape per row, judged against each rigor and role. The payloads are built by
// hand rather than measured: what is under test is the arithmetic from observed facts to a
// verdict, and test/verify-*.test.mjs already pins that the facts are observed faithfully.
//
// The properties that matter most:
//   every failing conjunct names itself — a leaf never fails with an empty failure list;
//   `unrunnable` is not a pass, and `absent` is not a failure;
//   the discriminator's base half is waived for tests-only and green, and for a tdd leaf's upkeep
//   files beside one that adds a test case, and for nothing else;
//   a lone discriminator on a tdd leaf escalates on round one rather than buying a fix round;
//   fix rounds cycling between a lone locus breach and a broken build escalate.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { closeDecision, measurementOk, ownFailing, profileOf, suiteFailed } from '../lib/verdict.mjs'
import { normalizeNode } from '../lib/tree.mjs'

const leaf = (over = {}) => normalizeNode({
  id: 'a/b', kind: 'leaf', rigor: 'tdd', locus: ['src/x.mjs', 'test/x.test.mjs'], ...over,
})

const LEAVES = {
  tdd: leaf(),
  'tests-only': leaf({ rigor: 'tests-only' }),
  trivial: leaf({ rigor: 'trivial' }),
  verify: leaf({ rigor: 'verify', locus: [] }),
  red: leaf({ rigor: 'tdd-pair', role: 'red', locus: ['test/x.test.mjs'] }),
  green: leaf({ rigor: 'tdd-pair', role: 'green', locus: ['src/x.mjs'] }),
  audit: leaf({ rigor: 'tdd-triad', role: 'audit', locus: ['src/x.mjs'] }),
}

const m = (over = {}) => ({
  stop_reason: 'completed',
  build: 'passed',
  typecheck: 'absent',
  suite: 'passed',
  suite_output_tail: '',
  failing_tests: [],
  discriminator: [],
  mutations: [],
  series_findings: [],
  checks: [],
  notes: '',
  error: null,
  ...over,
})

const disc = (failed_on_base, passes_now, test_id = 'test/x.test.mjs') => ({ test_id, failed_on_base, passes_now })
// A changed test file that adds no test case: it passes at base by construction.
const upkeep = (passes_now) => ({ test_id: 'test/y.test.mjs', adds_test: false, failed_on_base: false, passes_now })
const bites = { file: 'src/x.mjs', applied: true, unapplied_reason: '', expect_failing: ['test/x.test.mjs'], observed_failing: ['test/x.test.mjs'], bites: true }
const survives = { ...bites, observed_failing: [], bites: false }
const stale = { ...bites, applied: false, unapplied_reason: 'stale', observed_failing: [], bites: false }
const red = { suite: 'failed', failing_tests: [{ file: 'test/x.test.mjs', id: 'x' }], discriminator: [disc(true, false)] }

// ---------------------------------------------------------------- the table
//
// Each row: a measurement and, per profile, `true` for a pass or the sorted list of failing
// checks. A profile left out of a row is not asserted for it.

const ROWS = [
  ['a discriminating test, green suite', m({ discriminator: [disc(true, true)] }), {
    tdd: true, 'tests-only': ['mutation'], trivial: true, verify: true, green: true,
    red: ['discriminator', 'suite'], audit: ['mutation'],
  }],
  ['a discriminating test and a net that bites', m({ discriminator: [disc(true, true)], mutations: [bites] }), {
    tdd: true, 'tests-only': true, audit: true, trivial: true,
  }],
  ['a test that passes at base too, with a biting net', m({ discriminator: [disc(false, true)], mutations: [bites] }), {
    tdd: ['discriminator'], 'tests-only': true, green: true, red: ['discriminator', 'suite'],
  }],
  ['no test at all', m(), {
    tdd: ['new-test'], 'tests-only': ['mutation', 'new-test'], trivial: true, verify: true,
    red: ['new-test', 'suite'], green: ['new-test'], audit: ['mutation'],
  }],
  ['a red measurement, placed in its own test file', m(red), {
    red: true, tdd: ['discriminator', 'suite'], green: ['discriminator', 'suite'], trivial: ['suite'],
  }],
  ['a red measurement with a stray failure outside the locus', m({ ...red,
    failing_tests: [...red.failing_tests, { file: 'test/other.test.mjs', id: 'y' }] }), { red: ['suite'] }],
  ['a red measurement whose failure names no file', m({ ...red, failing_tests: [] }), { red: ['suite'] }],
  ['a failed build', m({ build: 'failed', discriminator: [disc(true, true)], mutations: [bites] }), {
    tdd: ['build'], 'tests-only': ['build'], trivial: ['build'], verify: ['build'], green: ['build'], audit: ['build'],
  }],
  ['a failed typecheck under a passing suite', m({ typecheck: 'failed', discriminator: [disc(true, true)] }), {
    tdd: ['typecheck'], trivial: ['typecheck'], verify: ['typecheck'],
  }],
  ['absent build, typecheck and suite: facts, not failures', m({ build: 'absent', suite: 'absent', discriminator: [disc(true, true)] }), {
    tdd: true, trivial: true, verify: true, green: true,
    audit: ['mutation', 'suite'],
  }],
  ['a blocking locus breach', m({ discriminator: [disc(true, true)],
    series_findings: [{ sha: 'abc', check: 'locus-breach', message: 'outside', blocking: true }] }), {
    tdd: ['series-locus-breach'], trivial: ['series-locus-breach'], verify: ['series-locus-breach'],
  }],
  ['an advisory series finding is not a failure', m({ discriminator: [disc(true, true)],
    series_findings: [{ sha: 'abc', check: 'and-subject', message: 'x and y', blocking: false }] }), { tdd: true, trivial: true }],
  ['an unreadable series finding counts as blocking', m({ discriminator: [disc(true, true)], series_findings: [null] }), {
    tdd: ['series-unreadable'],
  }],
  ['a net that survives its break', m({ discriminator: [disc(false, true)], mutations: [survives] }), {
    'tests-only': ['mutation'], audit: ['mutation'], tdd: ['discriminator', 'mutation'],
  }],
  ['a stale mutation spec', m({ discriminator: [disc(false, true)], mutations: [stale] }), {
    'tests-only': ['mutation'], audit: ['mutation'],
  }],
  ['a passed and a failed named check', m({ discriminator: [disc(true, true)],
    checks: [{ command: 'a', status: 'passed' }, { command: 'b', status: 'failed' }] }), {
    tdd: ['check'], trivial: ['check'], verify: ['check'], red: ['discriminator', 'suite'], green: ['check'],
  }],
  ['a check failed only by a test that fails at the base too', m({ discriminator: [disc(true, true)],
    checks: [{ command: 'a', status: 'failed', failing_tests: [{ file: 'test/x.test.mjs', id: 'x' }],
      baseline_failing: [{ file: 'test/x.test.mjs', id: 'x' }] }] }), { tdd: true, trivial: true, verify: true, green: true }],
  ['a check failed by a test of its own beside one failing at the base', m({ discriminator: [disc(true, true)],
    checks: [{ command: 'a', status: 'failed', failing_tests: [{ file: 'test/x.test.mjs', id: 'x' }, { file: 'test/x.test.mjs', id: 'y' }],
      baseline_failing: [{ file: 'test/x.test.mjs', id: 'x' }] }] }), { tdd: ['check'], trivial: ['check'], green: ['check'] }],
  ['a check failed naming no test', m({ checks: [{ command: 'a', status: 'failed', failing_tests: [], baseline_failing: [] }] }), {
    trivial: ['check'], verify: ['check'],
  }],
  ['no leaf tests ran', m({ suite: 'not_run', discriminator: [disc(true, true)], mutations: [bites] }), {
    tdd: true, trivial: true, verify: true, audit: ['suite'],
  }],
  ['an unrunnable named check is not a pass', m({ checks: [{ command: 'a', status: 'unrunnable' }] }), {
    verify: ['check'], trivial: ['check'],
  }],
  ['every named check passed', m({ checks: [{ command: 'a', status: 'passed' }] }), { verify: true, trivial: true }],
  ['a failed suite', m({ suite: 'failed', suite_output_tail: 'boom', failing_tests: [{ file: 'test/x.test.mjs', id: 'x' }],
    discriminator: [disc(true, true)], mutations: [bites] }), {
    tdd: ['suite'], 'tests-only': ['suite'], trivial: ['suite'], verify: ['suite'], green: ['suite'], audit: ['suite'],
  }],
  ['a test that does not pass now', m({ discriminator: [disc(true, false)], mutations: [bites] }), {
    tdd: ['discriminator'], 'tests-only': ['discriminator'], green: ['discriminator'],
  }],
  ['an upkeep file passing at base beside a discriminating one', m({ discriminator: [disc(true, true), upkeep(true)] }), {
    tdd: true,
  }],
  ['an upkeep file that does not pass now', m({ discriminator: [disc(true, true), upkeep(false)] }), {
    tdd: ['discriminator'],
  }],
  ['only upkeep files: nothing discriminates, so each is held to the whole question', m({ discriminator: [upkeep(true)] }), {
    tdd: ['discriminator'],
  }],
  ['a broken measurement', m({ stop_reason: 'environment_broken', error: { kind: 'suite_failures_unnamed', message: 'm' },
    discriminator: [disc(true, true)] }), { tdd: ['environment'], verify: ['environment'] }],
]

for (const [name, measurement, expected] of ROWS) {
  for (const [profile, want] of Object.entries(expected)) {
    test(`${profile}: ${name}`, () => {
      const { ok, failures } = measurementOk(measurement, LEAVES[profile])
      const checks = [...new Set(failures.map((f) => f.check))].sort()
      if (want === true) {
        assert.equal(ok, true, 'expected a pass, got ' + JSON.stringify(failures))
        assert.deepEqual(failures, [])
      } else {
        assert.equal(ok, false)
        assert.deepEqual(checks, want)
      }
      for (const f of failures) {
        assert.equal(typeof f.claim, 'string')
        assert.ok(f.claim.length > 0, 'a failure with no claim is a fix instruction that says nothing')
        assert.equal(typeof f.evidence, 'string')
      }
    })
  }
}

test('profileOf: a role outranks its rigor, and an unknown rigor is judged as tdd', () => {
  assert.equal(profileOf(LEAVES.red), 'red')
  assert.equal(profileOf(LEAVES.green), 'green')
  assert.equal(profileOf(LEAVES.audit), 'audit')
  assert.equal(profileOf(leaf({ rigor: 'tdd-pair' })), 'tdd')
  assert.equal(profileOf(leaf({ rigor: '' })), 'tdd')
  assert.equal(profileOf(leaf({ rigor: 'something-new' })), 'tdd')
  assert.equal(profileOf(LEAVES.verify), 'verify')
})

test('the suite tail rides a suite failure as its evidence', () => {
  const { failures } = measurementOk(m({ suite: 'failed', suite_output_tail: 'expected 1, got 2',
    failing_tests: [{ file: 'test/x.test.mjs', id: 'x' }] }), LEAVES.trivial)
  assert.equal(failures[0].check, 'suite')
  assert.equal(failures[0].evidence, 'expected 1, got 2')
})

test('a missing field reads in the failing direction, never the passing one', () => {
  // A journal line read back on a resume has no schema. A measurement that recorded nothing is
  // not a clean one.
  assert.equal(measurementOk({}, LEAVES.trivial).ok, false)
  assert.equal(measurementOk(null, LEAVES.tdd).ok, false)
})

// ---------------------------------------------------------------- closeDecision

const green = m({ discriminator: [disc(true, true)], mutations: [bites] })

test('passing: review where the leaf buys its own loop, approve otherwise, approve for verify', () => {
  assert.equal(closeDecision(green, LEAVES.tdd).next, 'approve', 'a tdd leaf is reviewed at integration')
  assert.equal(closeDecision(green, LEAVES.trivial).next, 'approve')
  assert.equal(closeDecision(green, LEAVES['tests-only']).next, 'approve')
  assert.equal(closeDecision(green, LEAVES.green).next, 'review', 'tdd-pair members review on their own')
  assert.equal(closeDecision(green, LEAVES.audit).next, 'review')
  assert.equal(closeDecision(m(red), LEAVES.red).next, 'review')
  assert.equal(closeDecision(green, leaf({ provides: [{ name: 'api', paths: ['src/x.mjs'] }] })).next, 'review',
    'a leaf providing a contract others consume is reviewed before anything is built on it')
  assert.equal(closeDecision(m({ checks: [{ command: 'a', status: 'passed' }] }), LEAVES.verify).next, 'approve')
  assert.deepEqual(closeDecision(green, LEAVES.tdd).failures, [])
})

test('an unknown command goes to the investigator; any other broken measurement escalates by kind', () => {
  const unknown = m({ stop_reason: 'environment_broken', error: { kind: 'command_unknown', message: 'no build' } })
  assert.deepEqual([closeDecision(unknown, LEAVES.tdd).next, closeDecision(unknown, LEAVES.tdd).reason],
    ['command_unknown', 'command_unknown'])

  for (const kind of ['test_unrunnable', 'suite_failures_unnamed', 'tree_not_restored', 'main_worktree']) {
    const broken = m({ stop_reason: 'environment_broken', error: { kind, message: 'x' } })
    assert.deepEqual([closeDecision(broken, LEAVES.tdd).next, closeDecision(broken, LEAVES.tdd).reason], ['escalate', kind])
  }
  const noKind = m({ stop_reason: 'environment_broken' })
  assert.equal(closeDecision(noKind, LEAVES.verify).reason, 'environment_broken',
    'a broken measurement escalates even for a verify leaf: it is not a finding about the parent')
})

test('a verify leaf that fails is a finding for its parent, not a fix round', () => {
  const d = closeDecision(m({ checks: [{ command: 'a', status: 'failed' }] }), LEAVES.verify)
  assert.equal(d.next, 'finding')
  assert.equal(d.failures[0].check, 'check')
})

test('a lone discriminator on a tdd leaf escalates on round one as discriminator_undecidable', () => {
  const d = closeDecision(m({ discriminator: [disc(false, true)] }), LEAVES.tdd)
  assert.deepEqual([d.next, d.reason], ['escalate', 'discriminator_undecidable'])
  assert.equal(d.failures.length, 1)
})

test('...but not when a test does not pass now, which an implementer can move', () => {
  assert.equal(closeDecision(m({ discriminator: [disc(true, false)] }), LEAVES.tdd).next, 'fix')
})

test('...and not beside any other failure, nor on another rigor', () => {
  assert.equal(closeDecision(m({ discriminator: [disc(false, true)], build: 'failed' }), LEAVES.tdd).next, 'fix')
  assert.equal(closeDecision(m({ discriminator: [disc(true, true)], mutations: [survives] }), LEAVES.tdd).next, 'fix')
  assert.equal(closeDecision(m({ discriminator: [disc(true, false)] }), LEAVES.green).next, 'fix')
  assert.equal(closeDecision(m({ discriminator: [disc(false, false)] }), LEAVES.red).next, 'fix')
})

test('an ordinary failure is a fix round and carries its failures', () => {
  const d = closeDecision(m({ build: 'failed', discriminator: [disc(true, true)] }), LEAVES.tdd)
  assert.equal(d.next, 'fix')
  assert.deepEqual(d.failures.map((f) => f.check), ['build'])
})

const breach = m({ discriminator: [disc(true, true)],
  series_findings: [{ sha: 'a', check: 'locus-breach', message: 'outside', blocking: true }] })
const broken = m({ build: 'failed', discriminator: [disc(true, true)] })

test('fix rounds cycling between a lone locus breach and a broken build escalate as verify_oscillating', () => {
  // The field case: edit outside the locus, revert (the tree no longer compiles), edit again.
  assert.equal(closeDecision(breach, LEAVES.tdd, []).next, 'fix')
  assert.equal(closeDecision(broken, LEAVES.tdd, [breach]).next, 'fix',
    'one move from a breach to a broken build is a fix round like any other')
  const back = closeDecision(breach, LEAVES.tdd, [breach, broken])
  assert.deepEqual([back.next, back.reason], ['escalate', 'verify_oscillating'],
    'returning to a state already left is the cycle')
  assert.equal(closeDecision(broken, LEAVES.tdd, [broken, breach]).reason, 'verify_oscillating',
    'in either direction')
})

test('a typecheck failure oscillates with a breach just as a build failure does', () => {
  const typeBroken = m({ typecheck: 'failed', discriminator: [disc(true, true)] })
  assert.equal(closeDecision(breach, LEAVES.tdd, [breach, typeBroken]).reason, 'verify_oscillating')
})

test('no oscillation without alternation: the same state twice, or states of other shapes', () => {
  assert.equal(closeDecision(breach, LEAVES.tdd, [breach, breach]).next, 'fix')
  const suite = m({ suite: 'failed', failing_tests: [{ file: 'test/x.test.mjs', id: 'x' }], discriminator: [disc(true, true)] })
  assert.equal(closeDecision(suite, LEAVES.tdd, [suite, broken]).next, 'fix')
  const breachAndSuite = m({ ...suite, series_findings: breach.series_findings })
  assert.equal(closeDecision(breachAndSuite, LEAVES.tdd, [breachAndSuite, broken]).next, 'fix',
    'a breach is "lone" only when it is the only failing fact')
})

// ---------------------------------------------------------------- the baseline

test('a suite whose every named failure fails at the base too did not fail for this change', () => {
  const before = m({ suite: 'failed', failing_tests: [{ file: 'test/old.test.mjs', id: 'old' }], baseline_failing: [{ file: 'test/old.test.mjs', id: 'old' }] })
  assert.equal(suiteFailed(before), false)
  assert.equal(measurementOk(before, LEAVES.trivial).ok, true)
  assert.equal(closeDecision(before, LEAVES.trivial).next, 'approve')

  const own = { ...before, failing_tests: [...before.failing_tests, { file: 'test/old.test.mjs', id: 'totals' }] }
  assert.equal(suiteFailed(own), true, 'a new failure in a file that was already failing is still the change\'s')
  assert.deepEqual(ownFailing(own).map((f) => f.id), ['totals'])

  assert.equal(suiteFailed(m({ suite: 'failed', failing_tests: [], baseline_failing: [] })), true, 'a failure that names nothing is never excused')
})

test('a red leaf is judged on its own failures: a baseline failure outside its locus is not collateral', () => {
  const measured = m({ ...red, failing_tests: [...red.failing_tests, { file: 'test/old.test.mjs', id: 'old' }], baseline_failing: [{ file: 'test/old.test.mjs', id: 'old' }] })
  assert.deepEqual(measurementOk(measured, LEAVES.red).failures, [])
})

test('a red leaf whose locus is a directory owns the failures under it, and only those', () => {
  const dirRed = leaf({ rigor: 'tdd-pair', role: 'red', locus: ['test/'] })
  assert.deepEqual(measurementOk(m(red), dirRed).failures, [])
  const stray = m({ ...red, failing_tests: [...red.failing_tests, { file: 'tests-old/y.test.mjs', id: 'y' }] })
  assert.deepEqual(measurementOk(stray, dirRed).failures.map((f) => f.check), ['suite'])
})
