// test/fast/verdict.test.mjs — lib/verdict.mjs, pure and table-driven.
//
// One measurement shape per row, judged against each rigor and role. The payloads are built by
// hand rather than measured: what is under test is the arithmetic from observed facts to a
// verdict, and test/verify-*.test.mjs already pins that the facts are observed faithfully.
//
// The properties that matter most:
//   every failing conjunct names itself — a leaf never fails with an empty failure list;
//   `unrunnable` is not a pass, and `absent` is not a failure;
//   the discriminator's base half is waived for tests-only and green, and for a tdd or red leaf's
//   upkeep files beside one that adds a test case, and for nothing else;
//   a lone discriminator on a tdd or red leaf escalates on round one rather than buying a fix round.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CONSOLIDATION, auditGap, closeDecision, consolidationDue, greenRoundRole, heldMutations, integrationPark, measurementOk,
  ownFailing, profileOf, reviewExit,
  netsAt, suiteFailed, undiscriminated,
} from '../../lib/verdict.mjs'
import { normalizeNode } from '../../lib/tree.mjs'

const leaf = (over = {}) => normalizeNode({
  id: 'a/b', kind: 'leaf', rigor: 'tdd', expects: ['src/x.mjs', 'test/x.test.mjs'], ...over,
})

const LEAVES = {
  tdd: leaf(),
  'tests-only': leaf({ rigor: 'tests-only' }),
  trivial: leaf({ rigor: 'trivial' }),
  verify: leaf({ rigor: 'verify', expects: [] }),
  red: leaf({ rigor: 'tdd-pair', role: 'red', expects: ['test/x.test.mjs'] }),
  green: leaf({ rigor: 'tdd-pair', role: 'green', expects: ['src/x.mjs'] }),
  audit: leaf({ rigor: 'tdd-triad', role: 'audit', expects: ['src/x.mjs'] }),
}
// A green's test-author round: the same leaf, measured as the round that closes a test gap.
LEAVES['green-tests'] = LEAVES.green
const PRODUCER = { 'green-tests': 'test-author' }

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
    red: ['discriminator', 'suite'], audit: ['mutation'], 'green-tests': true,
  }],
  ['a discriminating test and a net that bites', m({ discriminator: [disc(true, true)], mutations: [bites] }), {
    tdd: true, 'tests-only': true, audit: true, trivial: true, 'green-tests': true,
  }],
  ['a test that passes at base too, with a biting net', m({ discriminator: [disc(false, true)], mutations: [bites] }), {
    tdd: ['discriminator'], 'tests-only': true, green: true, red: ['discriminator', 'suite'],
  }],
  ['no test at all', m(), {
    tdd: ['new-test'], 'tests-only': ['mutation', 'new-test'], trivial: true, verify: true,
    red: ['new-test', 'suite'], green: ['new-test'], audit: ['mutation'], 'green-tests': ['new-test'],
  }],
  ['a red measurement, placed in its own test file', m(red), {
    red: true, tdd: ['discriminator', 'suite'], green: ['discriminator', 'suite'], trivial: ['suite'],
  }],
  ['a red measurement with a stray failure outside its own tests', m({ ...red,
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
  ['a blocking role breach', m({ discriminator: [disc(true, true)],
    series_findings: [{ sha: 'abc', check: 'role-breach', message: 'a test', blocking: true }] }), {
    tdd: ['series-role-breach'], trivial: ['series-role-breach'], verify: ['series-role-breach'],
  }],
  ['an advisory series finding is not a failure', m({ discriminator: [disc(true, true)],
    series_findings: [{ sha: 'abc', check: 'and-subject', message: 'x and y', blocking: false }] }), { tdd: true, trivial: true }],
  ['an unreadable series finding counts as blocking', m({ discriminator: [disc(true, true)], series_findings: [null] }), {
    tdd: ['series-unreadable'],
  }],
  ['a net that survives its break', m({ discriminator: [disc(false, true)], mutations: [survives] }), {
    'tests-only': ['mutation'], audit: ['mutation'], tdd: ['discriminator', 'mutation'], 'green-tests': ['discriminator', 'mutation'],
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
    'green-tests': ['suite'],
  }],
  ['a test that does not pass now', m({ discriminator: [disc(true, false)], mutations: [bites] }), {
    tdd: ['discriminator'], 'tests-only': ['discriminator'], green: ['discriminator'], 'green-tests': ['discriminator'],
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
  ['a red measurement beside an upkeep file that passes at base and now', m({ ...red, discriminator: [disc(true, false), upkeep(true)] }), {
    red: true,
  }],
  ['a red measurement beside an upkeep file that does not pass now', m({ ...red, discriminator: [disc(true, false), upkeep(false)] }), {
    red: ['discriminator'],
  }],
  ['a red leaf with only an upkeep file: it added no test to fail', m({ discriminator: [upkeep(true)] }), {
    red: ['discriminator', 'suite'],
  }],
  ['a broken measurement', m({ stop_reason: 'environment_broken', error: { kind: 'suite_failures_unnamed', message: 'm' },
    discriminator: [disc(true, true)] }), { tdd: ['environment'], verify: ['environment'] }],
]

for (const [name, measurement, expected] of ROWS) {
  for (const [profile, want] of Object.entries(expected)) {
    test(`${profile}: ${name}`, () => {
      const { ok, failures } = measurementOk(measurement, LEAVES[profile], PRODUCER[profile])
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
  assert.equal(profileOf(LEAVES.green, 'test-author'), 'green-tests')
  assert.equal(profileOf(LEAVES.green, 'implementer'), 'green')
  assert.equal(profileOf(LEAVES.red, 'test-author'), 'red', 'a red is always a test-author\'s: its round is no test gap')
})

test('a green\'s test-author round, blind to the implementation, shows each test it added fails at the red\'s stubs or is named by a biting break', () => {
  const redTest = { test_id: 'test/x.test.mjs', adds_test: false, failed_on_base: true, passes_now: true }
  const atStubs = disc(true, true, 'test/table.test.mjs')
  assert.deepEqual(measurementOk(m({ discriminator: [redTest, atStubs] }), LEAVES.green, 'test-author').failures, [],
    'no break to declare: it cannot read the code it would break')
  const passesAtStubs = disc(false, true, 'test/table.test.mjs')
  const named = { ...bites, expect_failing: ['test/table.test.mjs'], observed_failing: ['test/table.test.mjs'] }
  assert.deepEqual(measurementOk(m({ discriminator: [redTest, passesAtStubs], mutations: [named] }), LEAVES.green, 'test-author').failures, [])
  const hollow = measurementOk(m({ discriminator: [redTest, passesAtStubs] }), LEAVES.green, 'test-author').failures
  assert.deepEqual(hollow.map((f) => f.check), ['discriminator'])
  assert.match(hollow[0].claim, /^test\/table\.test\.mjs adds a test that passes at the red's stubs too/)
  assert.equal(closeDecision(m({ discriminator: [redTest, atStubs] }), LEAVES.green, 'test-author').next, 'review')
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

test('a lone discriminator on a tdd leaf goes back to its producer once; the same file still holding at base escalates', () => {
  const d = closeDecision(m({ discriminator: [disc(false, true)] }), LEAVES.tdd)
  assert.deepEqual([d.next, d.reason, d.files], ['fix', 'discriminator_sent_back', ['test/x.test.mjs']])
  assert.match(d.failures[0].evidence, /make it fail without your change/)
  const again = closeDecision(m({ discriminator: [disc(false, true)] }), LEAVES.tdd, '', { sentBack: ['test/x.test.mjs'] })
  assert.deepEqual([again.next, again.reason], ['escalate', 'discriminator_undecidable'])
  const other = closeDecision(m({ discriminator: [disc(false, true, 'test/y.test.mjs')] }), LEAVES.tdd, '', { sentBack: ['test/x.test.mjs'] })
  assert.equal(other.next, 'fix', 'a file never sent back is asked first')
})

test('a tdd change the typecheck rejects at base is discriminated by the check that failed there', () => {
  const check = 'npx tsc --noEmit && ! git grep -n "optional?:" -- src/x.ts'
  const typed = (over) => m({ discriminator: [disc(false, true), upkeep(true)], typecheck: 'passed', checks: [{ command: check, status: 'passed' }], ...over })
  for (const s of [{ kind: 'typecheck', command: 'npx tsc --noEmit', failed_on_base: true }, { kind: 'check', command: check, failed_on_base: true }]) {
    assert.equal(closeDecision(typed({ static_on_base: [s] }), LEAVES.tdd).next, 'approve', s.kind + ' failed at base with the tests restored')
  }
  const undecided = (over, why) => assert.equal(closeDecision(typed(over), LEAVES.tdd, '', { sentBack: ['test/x.test.mjs'] }).reason, 'discriminator_undecidable', why)
  undecided({ static_on_base: [{ kind: 'typecheck', command: 'npx tsc --noEmit', failed_on_base: false }] }, 'the typecheck held at base')
  undecided({ static_on_base: [] }, 'nothing static was asked')
  const unrun = closeDecision(typed({ static_on_base: [{ kind: 'check', command: check, failed_on_base: true }], checks: [{ command: check, status: 'unrunnable' }] }), LEAVES.tdd)
  assert.ok(unrun.failures.some((f) => f.check === 'discriminator'), 'a check that does not pass now pins nothing')
  // A behaviour change keeps the test-first rule: a test file that failed at base is never waived.
  const behaviour = typed({ discriminator: [disc(true, false), disc(false, true, 'test/z.test.mjs')], static_on_base: [{ kind: 'typecheck', command: 'npx tsc --noEmit', failed_on_base: true }] })
  assert.equal(closeDecision(behaviour, LEAVES.tdd).next, 'fix')
})

test('a file the user ruled a regression net is held to passes_now alone, beside a criterion check', () => {
  const passed = [{ command: 'grep wired', status: 'passed' }]
  const nets = ['test/x.test.mjs']
  assert.equal(closeDecision(m({ discriminator: [disc(false, true)], checks: passed }), LEAVES.tdd, '', { nets }).next, 'approve')
  assert.equal(measurementOk(m({ discriminator: [disc(false, false)], checks: passed }), LEAVES.tdd, '', { nets }).ok, false, 'a net must pass now')
  const two = m({ discriminator: [disc(false, true), disc(false, true, 'test/z.test.mjs')], checks: passed })
  assert.equal(closeDecision(two, LEAVES.tdd, '', { nets, sentBack: ['test/z.test.mjs'] }).reason, 'discriminator_undecidable', 'a file not ruled is still undecidable')
})

test('with every changed test file ruled a net, a leaf with no criterion check that ran does not pass', () => {
  const d = closeDecision(m({ discriminator: [disc(false, true)] }), LEAVES.tdd, '', { nets: ['test/x.test.mjs'] })
  assert.equal(d.reason, 'discriminator_undecidable')
  assert.ok(d.failures.some((f) => /no criterion check ran/.test(f.claim)))
})

test('a net ruling stands at its head alone, and a leaf approved there reads undiscriminated', () => {
  const events = [
    { kind: 'nets', node: 'x', head_sha: 'aaa', nets: [{ file: 'test/x.test.mjs', why: 'a net over what held' }], all: true, seq: 1 },
    { kind: 'approved', node: 'x', head_sha: 'aaa', seq: 2 },
  ]
  assert.deepEqual(netsAt(events, 'x', 'aaa').files, ['test/x.test.mjs'])
  assert.equal(netsAt(events, 'x', 'bbb'), null, 'a new commit voids the ruling')
  const nodes = new Map([['x', normalizeNode({ id: 'x', kind: 'leaf' })]])
  assert.deepEqual(undiscriminated(nodes, events, '.').map((l) => l.id), ['x'])
  assert.deepEqual(undiscriminated(nodes, [...events, { kind: 'approved', node: 'x', head_sha: 'bbb', seq: 3 }], '.'), [])
})

test('a net ruling carries to a later head for each netted file whose content is unchanged there', () => {
  const nets = [{ file: 'test/x.test.mjs', why: 'a net' }, { file: 'test/y.test.mjs', why: 'a net' }]
  const events = [
    { kind: 'nets', node: 'x', head_sha: 'aaa', nets, all: true, seq: 1 },
    { kind: 'approved', node: 'x', head_sha: 'bbb', seq: 2 },
  ]
  // A rebase for a conflict elsewhere: x's file is the same at bbb, y's was edited.
  const sameAt = (from, to, file) => from === 'aaa' && to === 'bbb' && file === 'test/x.test.mjs'
  const carried = netsAt(events, 'x', 'bbb', sameAt)
  assert.deepEqual(carried.files, ['test/x.test.mjs'])
  assert.equal(carried.all, false, 'a net voided on the way leaves a file to discriminate')
  assert.equal(netsAt(events, 'x', 'bbb', () => true).all, true)
  assert.equal(netsAt(events, 'x', 'bbb', () => false), null, 'every netted file changed: nothing carries')
  const nodes = new Map([['x', normalizeNode({ id: 'x', kind: 'leaf' })]])
  assert.deepEqual(undiscriminated(nodes, events, '.', () => true).map((l) => l.id), ['x'])
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

test('a red leaf whose only failing fact is a file that adds a case passing at base and now escalates, and a net over it passes', () => {
  const held = disc(false, true, 'test/z.test.mjs')
  const d = closeDecision(m({ ...red, discriminator: [disc(true, false), held] }), LEAVES.red)
  assert.deepEqual([d.next, d.reason], ['escalate', 'discriminator_undecidable'])
  assert.equal(closeDecision(m({ ...red, discriminator: [disc(true, false), held] }), LEAVES.red, '', { nets: ['test/z.test.mjs'] }).next, 'review')
  assert.equal(closeDecision(m({ ...red, discriminator: [disc(true, false), disc(false, false, 'test/z.test.mjs')] }), LEAVES.red).next, 'fix',
    'a test that passed at base and fails now is one the red broke')
  assert.equal(closeDecision(m({ discriminator: [held] }), LEAVES.red).next, 'fix', 'a red whose every test passes pins nothing it could not move')
  assert.equal(closeDecision(m({ ...red, discriminator: [disc(true, false), upkeep(false)] }), LEAVES.red).next, 'fix', 'an upkeep file it broke is its to fix')
})

test('an ordinary failure is a fix round and carries its failures', () => {
  const d = closeDecision(m({ build: 'failed', discriminator: [disc(true, true)] }), LEAVES.tdd)
  assert.equal(d.next, 'fix')
  assert.deepEqual(d.failures.map((f) => f.check), ['build'])
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

test('a red leaf is judged on its own failures: a baseline failure outside its own tests is not collateral', () => {
  const measured = m({ ...red, failing_tests: [...red.failing_tests, { file: 'test/old.test.mjs', id: 'old' }], baseline_failing: [{ file: 'test/old.test.mjs', id: 'old' }] })
  assert.deepEqual(measurementOk(measured, LEAVES.red).failures, [])
})

test('a red leaf owns the failures in the test files of its own diff, and only those', () => {
  const dirRed = leaf({ rigor: 'tdd-pair', role: 'red', expects: ['test/'] })
  assert.deepEqual(measurementOk(m(red), dirRed).failures, [])
  const stray = m({ ...red, failing_tests: [...red.failing_tests, { file: 'tests-old/y.test.mjs', id: 'y' }] })
  assert.deepEqual(measurementOk(stray, dirRed).failures.map((f) => f.check), ['suite'])
})

// ---------------------------------------------------------------- fix rounds and review rounds

const critical = (id) => ({ id, severity: 'critical', claim: 'wrong', evidence: 'x:1', failure_scenario: 'y' })

test('a review round approves on an empty open set and blocks only on criticals, or a yardstick leaf\'s majors with a scenario', () => {
  assert.equal(reviewExit({ findings: [] }).next, 'approve')
  const major = { id: 'M', severity: 'major', claim: 'c', evidence: 'e', failure_scenario: 'breaks a consumer' }
  assert.equal(reviewExit({ findings: [major] }).next, 'approve', 'a major is advisory on a leaf no later work is measured against')
  assert.equal(reviewExit({ findings: [major], yardstick: true }).next, 'fix')
  assert.equal(reviewExit({ findings: [{ ...major, failure_scenario: ' ' }], yardstick: true }).next, 'approve')
  const first = reviewExit({ findings: [critical('F1')] })
  assert.deepEqual([first.next, first.open.map((f) => f.id), first.raise], ['fix', ['F1'], false])
})

test('a prior blocker left unruled, or ruled not fixed without being re-reported, stays open; the same one twice escalates', () => {
  const one = reviewExit({ findings: [critical('F1')] })
  const unruled = reviewExit({ findings: [], verdicts: [], prior: one })
  assert.deepEqual([unruled.next, unruled.open.map((f) => f.id), unruled.raise], ['fix', ['F1'], true])
  const again = reviewExit({ findings: [critical('F1')], verdicts: [{ id: 'F1', status: 'not_fixed' }], prior: unruled })
  assert.deepEqual([again.next, again.reason], ['escalate', 'review_not_converging'])
  assert.equal(reviewExit({ findings: [], verdicts: [{ id: 'F1', status: 'fixed' }], prior: one }).next, 'approve')
})

test('rounds that each fix every prior blocker and mint new ones go on: whether that converges is the ruler\'s', () => {
  const r1 = reviewExit({ findings: [critical('F1')] })
  const r2 = reviewExit({ findings: [critical('F2')], verdicts: [{ id: 'F1', status: 'fixed' }], prior: r1 })
  const r3 = reviewExit({ findings: [critical('F3')], verdicts: [{ id: 'F2', status: 'fixed' }], prior: r2 })
  assert.deepEqual([r2.next, r3.next], ['fix', 'fix'])
  assert.deepEqual([r2.renewed, r3.renewed], [true, true], 'each fixed every prior blocker and minted a new one')
  assert.equal(reviewExit({ findings: [critical('F2')], verdicts: [{ id: 'F1', status: 'not_fixed' }], prior: r1 }).renewed, false)
})

test('a prior blocker the round under review could not fix is carried: open still, and never a strike toward escalation', () => {
  const gap = { ...critical('T1'), remedy: 'tests' }
  const r1 = reviewExit({ findings: [critical('F1'), gap], producer: 'code' })
  // An implementer's round: it fixed F1 and was never asked to touch T1, which the reviewer re-reports.
  const r2 = reviewExit({ findings: [gap], verdicts: [{ id: 'F1', status: 'fixed' }, { id: 'T1', status: 'not_fixed' }], prior: r1, producer: 'code' })
  assert.deepEqual([r2.next, r2.open.map((f) => f.id), r2.unfixed, r2.raise], ['fix', ['T1'], [], false],
    'T1 stays open, but is no strike, no raise and no newly minted blocker')
  // The test-author's round left it unfixed: that is its first strike, not its second.
  const r3 = reviewExit({ findings: [gap], verdicts: [{ id: 'T1', status: 'not_fixed' }], prior: r2, producer: 'tests' })
  assert.deepEqual([r3.next, r3.unfixed, r3.raise], ['fix', ['T1'], true])
  const r4 = reviewExit({ findings: [gap], verdicts: [{ id: 'T1', status: 'not_fixed' }], prior: r3, producer: 'tests' })
  assert.deepEqual([r4.next, r4.reason], ['escalate', 'review_not_converging'], 'unfixed twice by the producer that owns it')
  const plain = reviewExit({ findings: [gap], verdicts: [{ id: 'F1', status: 'fixed' }, { id: 'T1', status: 'not_fixed' }], prior: r1 })
  assert.deepEqual(plain.unfixed, ['T1'], 'with no producer named, a remedy carries nothing: a leaf with one producer owns every finding')
})

test('a green\'s next round goes to a test-author only when what is left is the tests\' to fix', () => {
  const tests = { ...critical('T1'), remedy: 'tests' }
  const fix = (failures, role = 'test-author') => ({ role, decision: { next: 'fix', failures } })
  assert.equal(greenRoundRole({}), 'implementer')
  assert.equal(greenRoundRole({ close: { role: 'implementer', status: 'needs_tests', decision: { next: 'fix' } } }), 'test-author')
  assert.equal(greenRoundRole({ review: { next: 'fix', open: [tests] } }), 'test-author')
  assert.equal(greenRoundRole({ review: { next: 'fix', open: [tests, critical('F1')] } }), 'implementer', 'a mixed set: the code first')
  assert.equal(greenRoundRole({ review: { next: 'fix', open: [critical('F1')] } }), 'implementer', 'a finding with no remedy is the code\'s')
  assert.equal(greenRoundRole({ close: fix([{ check: 'mutation' }, { check: 'series-role-breach' }]) }), 'test-author', 'its own break or breach')
  assert.equal(greenRoundRole({ close: fix([{ check: 'mutation' }, { check: 'discriminator' }]) }), 'implementer', 'a new test failing now may be the code\'s')
  assert.equal(greenRoundRole({ close: fix([{ check: 'mutation' }], 'implementer') }), 'implementer')
})

test('an integration review parks once, by class: a spec defect, then criticals and drift, then what it could not tell', () => {
  const claim = (ruling, text = 't') => ({ claim: text, ruling, evidence: 'a:1' })
  assert.equal(integrationPark([], [claim('met')], 'S'), null)
  for (const v of ['equivalent', 'accepted']) assert.equal(integrationPark([], [claim('met'), claim(v)], 'S'), null, v + ' passes like met')
  assert.equal(integrationPark([critical('F1')], [claim('equivalent')], 'S').why, 'integration_critical', 'a critical still parks beside a pass')
  const failing = (v) => ({ ...claim(v), failure_scenario: 'a save written now reads back empty' })
  for (const v of ['under', 'over', 'deviates']) {
    assert.equal(integrationPark([], [failing(v)], 'S').why, 'integration_critical', v + ' that names its failure parks')
    assert.equal(integrationPark([], [claim(v)], 'S'), null, v + ' that names none is left for landing')
    assert.equal(integrationPark([], [{ ...claim(v), failure_scenario: '  ' }], 'S'), null, v + ' with a blank scenario names none')
  }
  assert.ok(integrationPark([], [failing('under')], 'S').question.includes('fails: a save written now reads back empty'))
  assert.equal(integrationPark([critical('F1')], [claim('cant_tell')], 'S').why, 'integration_critical')
  assert.equal(integrationPark([], [claim('cant_tell')], 'S'), null, 'what the review could not tell is left for landing')
  const defect = integrationPark([critical('F1')], [claim('cant_tell', 'a'), claim('spec_defect', 'b')], 'S')
  assert.equal(defect.why, 'spec_defect')
  assert.ok(defect.question.startsWith('the spec S: ') && ['F1: wrong', '[spec_defect] b'].every((s) => defect.question.includes(s)))
  assert.equal(defect.question.includes('[cant_tell] a'), false, 'what parks nothing is not asked about')
})

test('a tests-only file that adds a test no biting mutation names is not shown to catch anything', () => {
  const twoFiles = m({ discriminator: [disc(false, true), disc(false, true, 'test/z.test.mjs')], mutations: [bites] })
  const failures = measurementOk(twoFiles, LEAVES['tests-only']).failures
  assert.deepEqual(failures.map((f) => f.claim), ['test/z.test.mjs adds a test no biting mutation names'])
  const named = m({ discriminator: [disc(false, true), disc(false, true, 'test/z.test.mjs')], mutations: [bites, { ...bites, expect_failing: ['test/z.test.mjs'], observed_failing: ['test/z.test.mjs'] }] })
  assert.equal(measurementOk(named, LEAVES['tests-only']).ok, true)
  assert.equal(measurementOk(m({ discriminator: [disc(false, true), upkeep(true)], mutations: [bites] }), LEAVES['tests-only']).ok, true, 'an upkeep file adds no test to catch anything')
})

test('a leaf measured by its mutations is held to every one an earlier round applied; others are not', () => {
  const declared = (x) => ({ file: x.file, find: x.find, replace: x.replace, expect_failing: x.expect_failing })
  const old = { ...survives, find: 'a < b', replace: 'a <= b' }
  const lost = { ...stale, find: 'typo', replace: 'x' }
  const fresh = { file: 'src/x.mjs', find: 'return 1', replace: 'return 0', expect_failing: ['test/x.test.mjs'] }
  const measured = [m({ mutations: [old, lost] })]
  for (const profile of ['tests-only', 'audit']) {
    assert.deepEqual(heldMutations(LEAVES[profile], measured, [fresh]), [declared(old), fresh], profile + ': an applied one stays, an unapplied one does not')
  }
  assert.deepEqual(heldMutations(LEAVES.tdd, measured, [fresh]), [fresh], 'a tdd leaf\'s implementation moves, and an old find with it')
  const renamed = { ...declared(old), expect_failing: ['test/new.test.mjs'] }
  assert.deepEqual(heldMutations(LEAVES.audit, measured, [renamed]), [renamed], 'a redeclared mutation takes this round\'s tests')
})

test('an audit gap opens with the first applied mutation its tests let through, and stays open', () => {
  assert.equal(auditGap([]), false)
  assert.equal(auditGap([m({ mutations: [bites, stale] })]), false, 'an unapplied declaration is the auditor\'s, not a gap')
  assert.equal(auditGap([m({ mutations: [survives] }), m({ mutations: [bites] })]), true)
})

test('a finding that asks a test to go never blocks, whatever severity it was given', () => {
  const retire = { ...critical('X1'), remedy: 'retire' }
  assert.equal(reviewExit({ findings: [retire], yardstick: true }).next, 'approve')
  assert.equal(integrationPark([retire], [], 'spec.md'), null)
})

test("a cycle's last member owes one consolidation round, owed again on the replay of the review that asked or after a replan", () => {
  const g = LEAVES.green
  const r = leaf({ id: 'a/r', rigor: 'tdd-pair', role: 'red' })
  const cycle = [r.id, g.id]
  const asked = { kind: 'message', node: g.id, msg: 'consolidate', round: 3, seq: 5 }
  assert.equal(consolidationDue(g, cycle, [], 2), true)
  assert.equal(consolidationDue(r, cycle, [], 1), false, 'a red is never the last member')
  assert.equal(consolidationDue(g, [], [], 2), false, 'a leaf in no cycle owes none')
  assert.equal(consolidationDue(g, cycle, [asked], 2), true, 'the review that asked, replayed, asks again')
  assert.equal(consolidationDue(g, cycle, [asked], 3), false)
  assert.equal(consolidationDue(g, cycle, [asked, { kind: 'replanned', node: g.id, seq: 6 }], 3), true)
})

test('a consolidation round is held to the breaks it declares and the audit held, and to a run of its tests', () => {
  assert.equal(profileOf(LEAVES.audit, CONSOLIDATION), 'consolidation')
  const failing = (over) => measurementOk(m(over), LEAVES.green, CONSOLIDATION).failures.map((f) => f.check)
  assert.deepEqual(failing({ mutations: [bites] }), [])
  assert.deepEqual(failing({}), [], 'a blind round is not asked for a break of its own')
  assert.deepEqual(failing({ mutations: [bites, survives] }), ['mutation'])
  assert.deepEqual(failing({ suite: 'not_run', mutations: [bites] }), ['suite'])
})
