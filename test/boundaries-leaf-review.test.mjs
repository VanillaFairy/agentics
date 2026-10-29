// test/boundaries-leaf-review.test.mjs — pins the leaf review boundary: the units a reviewer is
// handed (`reviewUnits`) and one review round over the reviewer's stored return (`leafReview`):
// the exit it computes against what the round before left open, the review record it writes, the
// approval, the escalation or the `findings` messages it records by thread, the role fault when no
// usable return is stored, and that a round run again records nothing twice.
//
// Design: docs/DESIGN.md#executors-and-review and docs/DESIGN.md#review-returns.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'

import { leafReview, reviewUnits } from '../lib/boundaries/leaf-review.mjs'
import { executionContext } from '../lib/boundaries/records.mjs'
import { executionLog, readLog } from '../lib/ledger.mjs'
import { branchOf, dispatchKey, readJson, returnPath, reviewPath, writeJson } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { greenRoundRole, reviewExit, unruledUnit } from '../lib/verdict.mjs'
import { git, leaf, repo, root, STAMP } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
// The units a leaf review is handed in these tests: its one criterion and one changed file.
const U = ['criterion:1', 'file:src/a.mjs']
const UNRULED = 'unit:file:src/a.mjs'

const finding = (id, extra = {}) => ({
  id, severity: 'critical', claim: 'claim ' + id, evidence: 'evidence ' + id, failure_scenario: 'fails when ' + id, ...extra,
})
const fixed = (id) => ({ id, status: 'fixed', evidence: 'ruled ' + id })
const notFixed = (id) => ({ id, status: 'not_fixed', evidence: 'ruled ' + id })

const plainLeaves = () => [leaf('a', { expects: ['a.mjs'] })]
const cycleLeaves = () => [
  leaf('r', { role: 'red', rigor: 'tdd-triad', expects: ['test/r.test.mjs'] }),
  leaf('g', { role: 'green', rigor: 'tdd-triad', deps: ['r'], expects: ['src/g.mjs'] }),
  leaf('u', { role: 'audit', rigor: 'tdd-triad', deps: ['g'], expects: ['test/u.test.mjs'] }),
  ...plainLeaves(),
]

/** A repository with `leaves` seeded, a branch of its own head per leaf, and an execution's port. */
function world(t, leaves = plainLeaves()) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  const out = seedTree(r, E, [root(), ...leaves])
  assert.equal(out.ok, true, JSON.stringify(out))
  for (const l of leaves) {
    // Its own commit, so a head read from anywhere but the branch is a different sha.
    const sha = git(r, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'work of ' + l.id)
    git(r, 'branch', branchOf(E, l.id), sha)
  }
  const log = executionLog(r, E, STAMP)
  return { r, xc: executionContext({ repo: r, effort: E, execution: STAMP, log }) }
}

/** A producer's round, recorded as the runner records one. Its dispatch. */
function produced(w, { node, round, role = 'implementer', thread = 'producer:' + node }) {
  const dispatch = dispatchKey({ node, role, thread, round })
  w.xc.log.append('dispatched', {
    dispatch, node, round, thread, role, model: 'sonnet', effort: 'medium', session: 's-' + dispatch,
    brief_digest: 'digest', brief_parts: {}, carries: [], pid: 0,
  })
  return dispatch
}

/**
 * A reviewer's call and, where the runner keeps one, its return: `value` is written to the return
 * file when given, and a `returned` record of `status` follows when `status` is not null.
 */
function reviewed(w, { node, round, review_round, value, status = 'returned', cause = '' }) {
  const thread = 'reviewer:' + node + ':' + review_round
  const dispatch = dispatchKey({ node, role: 'reviewer', thread, round })
  w.xc.log.append('dispatched', {
    dispatch, node, round, thread, role: 'reviewer', model: 'opus', effort: 'medium', session: 's-' + dispatch,
    brief_digest: 'digest', brief_parts: {}, carries: [], pid: 0,
  })
  if (value !== undefined) writeJson(returnPath(w.xc.dir, dispatch), value)
  if (status !== null) {
    w.xc.log.append('returned', {
      dispatch, session: 's-' + dispatch, status, cause, usage: null, cost_total: null, cost_usd: null, denials: [],
    })
  }
  return dispatch
}

/** A reviewer's return: every unit in `ruled` ruled clean, the findings and the rulings of fixes given. */
const verdict = ({ ruled = U, findings = [], fix = [] } = {}) => ({
  units: ruled.map((unit) => ({ unit, ruling: 'clean', why: 'read it' })),
  findings, fix_rulings: fix, claims: [], notes: '',
})

/** One review round: the reviewer is called and returns `ret`, then leafReview reads it. */
async function go(w, { node = 'a', round, review_round = round, units = U, ...ret }) {
  const dispatch = reviewed(w, { node, round, review_round, value: verdict({ ruled: units, ...ret }) })
  const args = { node, round, review_round, dispatch, units }
  return { dispatch, args, result: await leafReview(w.xc, args) }
}

const events = (w, kind) => readLog(w.r, E, 'events').entries.filter((e) => e.kind === kind)
const messages = (w) => events(w, 'message').filter((e) => e.msg === 'findings')
const faults = (w) => readLog(w.r, E, 'state:' + STAMP).entries.filter((e) => e.kind === 'fault')
const statusOf = (w, id) => readTree(w.r, E).status.get(id).status
const headOf = (w, id) => git(w.r, 'rev-parse', 'refs/heads/' + branchOf(E, id))
const recordOf = (w, id, n) => readJson(reviewPath(w.r, E, STAMP, id, n))
const idsOf = (m) => m.payload.findings.map((f) => f.id)
const sorted = (a) => [...a].sort()

// ------------------------------------------------------------------ reviewUnits

test('reviewUnits names each criterion from 1, each changed file, each failing approved case, in that order', () => {
  const two = { acceptance: [{ text: 'first' }, { text: 'second' }] }
  const units = reviewUnits(two, {
    changed: ['src/a.mjs', 'src/b.mjs'],
    approved_failing: [{ file: 'test/a.test.mjs', id: 'adds one' }],
  })
  assert.deepEqual(units, [
    'criterion:1', 'criterion:2', 'file:src/a.mjs', 'file:src/b.mjs', 'approved-case:test/a.test.mjs#adds one',
  ])
  // An option left out is an empty list.
  assert.deepEqual(reviewUnits(two, {}), ['criterion:1', 'criterion:2'])
  assert.deepEqual(reviewUnits(two, { changed: ['src/a.mjs'] }), ['criterion:1', 'criterion:2', 'file:src/a.mjs'])
})

test('reviewUnits of a leaf with no criteria, no changed file and no failing case is empty', () => {
  assert.deepEqual(reviewUnits({ acceptance: [] }, { changed: [], approved_failing: [] }), [])
  assert.deepEqual(reviewUnits({ acceptance: [] }, {}), [])
})

// ------------------------------------------------------------------ the exit and its records

test('a round with every unit ruled clean and no finding approves the leaf at its branch head', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  const { result } = await go(w, { round: 1 })
  assert.equal(result.decision.next, 'approve')
  assert.deepEqual(result.stops, [])
  assert.equal(result.raise, false)
  const approvals = events(w, 'approved')
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].node, 'a')
  assert.equal(approvals[0].head_sha, headOf(w, 'a'))
  assert.notEqual(approvals[0].head_sha, git(w.r, 'rev-parse', 'HEAD'), 'the head is the leaf branch\'s, not the checkout\'s')
  assert.equal(approvals[0].review_rounds, 1)
  assert.equal(approvals[0].at_integration, false)
  assert.equal(statusOf(w, 'a'), 'approved')
  assert.equal(events(w, 'escalated').length, 0)
  assert.equal(messages(w).length, 0)
})

test('a unit the reviewer left unruled keeps the round open and sends no findings message', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  const { result } = await go(w, { round: 1, ruled: ['criterion:1'] })
  assert.deepEqual(result.decision, { next: 'fix', reason: '' })
  assert.equal(result.raise, false)
  assert.deepEqual(result.stops, [])
  for (const kind of ['message', 'approved', 'escalated']) assert.equal(events(w, kind).length, 0, kind)
  assert.ok(recordOf(w, 'a', 1).open.some((o) => o.id === UNRULED), 'the unit entry is kept for the next reviewer')
  assert.notEqual(statusOf(w, 'a'), 'approved')
})

test('a fresh reviewer that rules the units left unruled approves, and no message was ever recorded', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  const first = await go(w, { round: 1, review_round: 1, ruled: ['criterion:1'] })
  assert.equal(first.result.decision.next, 'fix')
  const second = await go(w, { round: 1, review_round: 2 })
  assert.equal(second.result.decision.next, 'approve')
  assert.deepEqual(second.result.stops, [])
  const approvals = events(w, 'approved')
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].review_rounds, 2)
  assert.equal(approvals[0].head_sha, headOf(w, 'a'))
  assert.equal(events(w, 'message').length, 0)
})

test('a findings message beside an unruled unit carries the findings alone', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  const { result } = await go(w, { round: 1, ruled: ['criterion:1'], findings: [finding('F1')] })
  assert.equal(result.decision.next, 'fix')
  assert.deepEqual(sorted(recordOf(w, 'a', 1).open.map((o) => o.id)), sorted(['F1', UNRULED]))
  const sent = messages(w)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].node, 'a')
  assert.equal(sent[0].thread, 'producer:a')
  assert.equal(sent[0].round, 2)
  assert.deepEqual(idsOf(sent[0]), ['F1'])
})

test('on a green, a tests finding beside an unruled unit goes to producer:<red>, and the red\'s session answers next', async (t) => {
  const w = world(t, cycleLeaves())
  produced(w, { node: 'g', round: 1 })
  const { result } = await go(w, { node: 'g', round: 1, ruled: ['criterion:1'], findings: [finding('F1', { remedy: 'tests' })] })
  assert.equal(result.decision.next, 'fix')
  const sent = messages(w)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].node, 'g')
  assert.equal(sent[0].thread, 'producer:r')
  assert.equal(sent[0].round, 2)
  assert.deepEqual(idsOf(sent[0]), ['F1'])
  const record = recordOf(w, 'g', 1)
  assert.deepEqual(sorted(record.open.map((o) => o.id)), sorted(['F1', UNRULED]))
  assert.equal(greenRoundRole({ review: record }), 'test-author', 'the unit entry calls no implementer round')
})

test('a critical finding goes to the producer\'s thread as a findings message for the next round', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  const f = finding('F1')
  const { result } = await go(w, { round: 1, findings: [f] })
  assert.equal(result.decision.next, 'fix')
  assert.equal(events(w, 'approved').length, 0)
  const sent = messages(w)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].node, 'a')
  assert.equal(sent[0].thread, 'producer:a')
  assert.equal(sent[0].from, 'code')
  assert.equal(sent[0].msg, 'findings')
  assert.equal(sent[0].round, 2)
  const carried = sent[0].payload.findings.find((x) => x.id === 'F1')
  assert.ok(carried, 'the finding is in the payload')
  for (const key of ['id', 'severity', 'claim', 'evidence', 'failure_scenario']) assert.equal(carried[key], f[key], key)
})

test('a red is judged as a yardstick: its major with a failure scenario blocks', async (t) => {
  const w = world(t, cycleLeaves())
  const major = finding('M1', { severity: 'major' })
  produced(w, { node: 'r', round: 1, role: 'test-author' })
  const onRed = await go(w, { node: 'r', round: 1, findings: [major] })
  assert.equal(onRed.result.decision.next, 'fix')
  produced(w, { node: 'a', round: 1 })
  const onPlain = await go(w, { node: 'a', round: 1, findings: [major] })
  assert.equal(onPlain.result.decision.next, 'approve')
  assert.equal(statusOf(w, 'a'), 'approved')
})

test('a prior blocker ruled fixed in fix_rulings closes, and the round approves', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  assert.equal((await go(w, { round: 1, findings: [finding('F1')] })).result.decision.next, 'fix')
  produced(w, { node: 'a', round: 2 })
  const second = await go(w, { round: 2, fix: [fixed('F1')] })
  assert.equal(second.result.decision.next, 'approve')
  assert.deepEqual(second.result.stops, [])
  const approvals = events(w, 'approved')
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].review_rounds, 2)
  assert.equal(approvals[0].head_sha, headOf(w, 'a'))
})

test('a prior blocker the round neither ruled nor re-reported stays open, and is sent again', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  await go(w, { round: 1, findings: [finding('F1')] })
  produced(w, { node: 'a', round: 2 })
  const second = await go(w, { round: 2 })
  assert.equal(second.result.decision.next, 'fix')
  assert.deepEqual(recordOf(w, 'a', 2).open.map((o) => o.id), ['F1'])
  const again = messages(w).filter((m) => m.round === 3)
  assert.equal(again.length, 1)
  assert.equal(again[0].thread, 'producer:a')
  assert.deepEqual(idsOf(again[0]), ['F1'])
})

test('a prior blocker ruled not_fixed in two consecutive rounds escalates review_not_converging, said the reviewer\'s dispatch', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  await go(w, { round: 1, findings: [finding('F1')] })
  produced(w, { node: 'a', round: 2 })
  assert.equal((await go(w, { round: 2, fix: [notFixed('F1')] })).result.decision.next, 'fix')
  produced(w, { node: 'a', round: 3 })
  const third = await go(w, { round: 3, fix: [notFixed('F1')] })
  assert.deepEqual(third.result.decision, { next: 'escalate', reason: 'review_not_converging' })
  const escalations = events(w, 'escalated')
  assert.equal(escalations.length, 1)
  assert.equal(escalations[0].node, 'a')
  assert.equal(escalations[0].reason, 'review_not_converging')
  assert.equal(escalations[0].said, third.dispatch)
  assert.equal(third.result.stops.length, 1)
  assert.equal(third.result.stops[0].id, 'a')
  assert.equal(third.result.stops[0].status, 'escalated')
  assert.equal(third.result.stops[0].reason, 'review_not_converging')
  assert.equal(third.result.stops[0].said, third.dispatch)
  assert.equal(third.result.raise, false)
  assert.equal(statusOf(w, 'a'), 'escalated')
  assert.equal(events(w, 'approved').length, 0)
  assert.equal(messages(w).filter((m) => m.round === 4).length, 0, 'an escalation sends no findings message')
})

test('a tests finding on a leaf that is no green is judged like any other, and escalates when unfixed twice', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  await go(w, { round: 1, findings: [finding('F1', { remedy: 'tests' })] })
  const first = messages(w)
  assert.equal(first.length, 1)
  assert.equal(first[0].thread, 'producer:a', 'every finding of a plain leaf goes to its producer')
  assert.equal(first[0].round, 2)
  produced(w, { node: 'a', round: 2 })
  assert.equal((await go(w, { round: 2, fix: [notFixed('F1')] })).result.decision.next, 'fix')
  produced(w, { node: 'a', round: 3 })
  const third = await go(w, { round: 3, fix: [notFixed('F1')] })
  assert.deepEqual(third.result.decision, { next: 'escalate', reason: 'review_not_converging' })
})

// ------------------------------------------------------------------ a green's and an audit's findings

test('on a green, a code finding goes to producer:<green> and a tests finding is carried while code is open', async (t) => {
  const w = world(t, cycleLeaves())
  produced(w, { node: 'g', round: 1 })
  const { result } = await go(w, {
    node: 'g', round: 1, findings: [finding('F1'), finding('F2', { remedy: 'tests' })],
  })
  assert.equal(result.decision.next, 'fix')
  const sent = messages(w)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].node, 'g')
  assert.equal(sent[0].thread, 'producer:g')
  assert.equal(sent[0].round, 2)
  assert.deepEqual(idsOf(sent[0]), ['F1'])
  const record = recordOf(w, 'g', 1)
  assert.deepEqual(sorted(record.open.map((o) => o.id)), ['F1', 'F2'], 'the carried finding stays open')
  assert.equal(greenRoundRole({ review: record }), 'implementer')
})

test('on a green, an open set of tests findings alone goes to the cycle\'s test session producer:<red>', async (t) => {
  const w = world(t, cycleLeaves())
  produced(w, { node: 'g', round: 1 })
  const { result } = await go(w, { node: 'g', round: 1, findings: [finding('F1', { remedy: 'tests' })] })
  assert.equal(result.decision.next, 'fix')
  const sent = messages(w)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].node, 'g')
  assert.equal(sent[0].thread, 'producer:r')
  assert.equal(sent[0].round, 2)
  assert.deepEqual(idsOf(sent[0]), ['F1'])
})

test('on a green, a carried tests finding counts toward no escalation', async (t) => {
  const w = world(t, cycleLeaves())
  produced(w, { node: 'g', round: 1 })
  await go(w, { node: 'g', round: 1, findings: [finding('F1', { remedy: 'tests' }), finding('F2')] })
  produced(w, { node: 'g', round: 2 })
  const second = await go(w, { node: 'g', round: 2, findings: [finding('F3')], fix: [notFixed('F1'), fixed('F2')] })
  assert.equal(second.result.decision.next, 'fix')
  produced(w, { node: 'g', round: 3 })
  const third = await go(w, { node: 'g', round: 3, fix: [notFixed('F1'), fixed('F3')] })
  assert.equal(third.result.decision.next, 'fix')
  assert.equal(events(w, 'escalated').length, 0)
  assert.notEqual(statusOf(w, 'g'), 'escalated')
  assert.deepEqual(recordOf(w, 'g', 3).open.map((o) => o.id), ['F1'])
  assert.equal(recordOf(w, 'g', 2).unfixed.includes('F1'), false)
})

test('the reviewed round\'s producer is read from its producer dispatch, past the reviewer dispatched at that round', async (t) => {
  const w = world(t, cycleLeaves())
  produced(w, { node: 'g', round: 1 })
  assert.equal((await go(w, { node: 'g', round: 1, findings: [finding('F1')] })).result.decision.next, 'fix')
  // Two test-author rounds follow; neither rules F1, a code finding, which is not theirs to answer.
  produced(w, { node: 'g', round: 2, role: 'test-author', thread: 'producer:r' })
  const second = await go(w, { node: 'g', round: 2, findings: [finding('F2', { remedy: 'tests' })] })
  assert.equal(second.result.decision.next, 'fix')
  produced(w, { node: 'g', round: 3, role: 'test-author', thread: 'producer:r' })
  const third = await go(w, { node: 'g', round: 3, fix: [fixed('F2')] })
  assert.equal(third.result.decision.next, 'fix')
  assert.equal(events(w, 'escalated').length, 0)
  assert.notEqual(statusOf(w, 'g'), 'escalated')
  assert.deepEqual(recordOf(w, 'g', 3).open.map((o) => o.id), ['F1'])
})

test('on an audit, a code finding goes to auditor:<audit> and a tests finding to producer:<red>', async (t) => {
  const w = world(t, cycleLeaves())
  produced(w, { node: 'u', round: 1, role: 'auditor', thread: 'auditor:u' })
  const { result } = await go(w, {
    node: 'u', round: 1, findings: [finding('F1'), finding('F2', { remedy: 'tests' })],
  })
  assert.equal(result.decision.next, 'fix')
  const sent = messages(w)
  assert.equal(sent.length, 2, 'one message per thread')
  const byThread = Object.fromEntries(sent.map((m) => [m.thread, m]))
  assert.deepEqual(Object.keys(byThread).sort(), ['auditor:u', 'producer:r'])
  for (const m of sent) {
    assert.equal(m.node, 'u')
    assert.equal(m.round, 2)
  }
  assert.deepEqual(idsOf(byThread['auditor:u']), ['F1'])
  assert.deepEqual(idsOf(byThread['producer:r']), ['F2'])
})

// ------------------------------------------------------------------ the raise

test('raise is set when the round answered prior blockers and ruled none fixed', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  const first = await go(w, { round: 1, findings: [finding('F1'), finding('F2')] })
  assert.equal(first.result.raise, false)
  produced(w, { node: 'a', round: 2 })
  const second = await go(w, { round: 2, fix: [notFixed('F1'), notFixed('F2')] })
  assert.equal(second.result.decision.next, 'fix')
  assert.equal(second.result.raise, true)
  assert.equal(recordOf(w, 'a', 2).raise, true)
})

test('no raise when the round fixed one prior blocker and not another', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  await go(w, { round: 1, findings: [finding('F1'), finding('F2')] })
  produced(w, { node: 'a', round: 2 })
  const second = await go(w, { round: 2, fix: [fixed('F1'), notFixed('F2')] })
  assert.equal(second.result.decision.next, 'fix')
  assert.equal(second.result.raise, false)
  assert.equal(recordOf(w, 'a', 2).raise, false)
})

// ------------------------------------------------------------------ the record, faults, idempotence

test('the review record holds node, round, review_round, dispatch, head_sha, units and the exit', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  await go(w, { round: 1, findings: [finding('F1')] })
  produced(w, { node: 'a', round: 2 })
  const ret = verdict({ findings: [finding('F2')], fix: [notFixed('F1')] })
  const dispatch = reviewed(w, { node: 'a', round: 2, review_round: 2, value: ret })
  await leafReview(w.xc, { node: 'a', round: 2, review_round: 2, dispatch, units: U })

  const record = recordOf(w, 'a', 2)
  assert.equal(record.node, 'a')
  assert.equal(record.round, 2)
  assert.equal(record.review_round, 2)
  assert.equal(record.dispatch, dispatch)
  assert.equal(record.head_sha, headOf(w, 'a'))
  assert.deepEqual(record.units, U)
  // The exit is reviewExit's over the return and the round before's record.
  const exit = reviewExit({
    yardstick: false, findings: ret.findings, verdicts: ret.fix_rulings, prior: recordOf(w, 'a', 1), producer: '',
    units: U, rulings: ret.units,
  })
  for (const key of ['next', 'reason', 'detail', 'open', 'unfixed', 'raise', 'renewed']) {
    assert.deepEqual(record[key], exit[key], key)
  }
  assert.equal(recordOf(w, 'a', 1).review_round, 1)
})

test('a review with no stored return holds the leaf on a role fault and records nothing else', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  const dispatch = reviewed(w, { node: 'a', round: 1, review_round: 1, status: null })
  const before = w.xc.log.entries().length
  const result = await leafReview(w.xc, { node: 'a', round: 1, review_round: 1, dispatch, units: U })
  assert.deepEqual(result.decision, { next: 'held', reason: 'role' })
  assert.equal(result.raise, false)
  assert.deepEqual(result.stops, [{ id: 'a', status: 'held', reason: 'role', said: '' }])
  const entries = w.xc.log.entries()
  assert.equal(entries.length, before + 1, 'only the fault was recorded')
  assert.equal(entries.at(-1).kind, 'fault')
  const standing = faults(w)
  assert.equal(standing.length, 1)
  assert.equal(standing[0].node, 'a')
  assert.equal(standing[0].channel, 'role')
  for (const kind of ['approved', 'escalated', 'message']) assert.equal(events(w, kind).length, 0, kind)
  assert.equal(existsSync(reviewPath(w.r, E, STAMP, 'a', 1)), false)
})

test('a return file with no returned record is not read', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  const dispatch = reviewed(w, { node: 'a', round: 1, review_round: 1, value: verdict(), status: null })
  const result = await leafReview(w.xc, { node: 'a', round: 1, review_round: 1, dispatch, units: U })
  assert.equal(result.decision.next, 'held')
  assert.equal(events(w, 'approved').length, 0)
  assert.equal(faults(w).length, 1)
})

test('a return whose findings is not an array holds the leaf on a role fault', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  const dispatch = reviewed(w, { node: 'a', round: 1, review_round: 1, value: { units: [], findings: 'none', fix_rulings: [] } })
  const result = await leafReview(w.xc, { node: 'a', round: 1, review_round: 1, dispatch, units: U })
  assert.deepEqual(result.decision, { next: 'held', reason: 'role' })
  assert.equal(result.raise, false)
  assert.deepEqual(result.stops, [{ id: 'a', status: 'held', reason: 'role', said: '' }])
  for (const kind of ['approved', 'escalated', 'message']) assert.equal(events(w, kind).length, 0, kind)
  assert.equal(existsSync(reviewPath(w.r, E, STAMP, 'a', 1)), false)
})

test('a stored return whose call did not return is not read', async (t) => {
  for (const [status, cause] of [['failed', 'watch_failed'], ['part', ''], ['cut_off', 'orphan_ended']]) {
    const w = world(t)
    produced(w, { node: 'a', round: 1 })
    const dispatch = reviewed(w, { node: 'a', round: 1, review_round: 1, value: verdict(), status, cause })
    assert.ok(existsSync(returnPath(w.xc.dir, dispatch)), 'the file is kept')
    const result = await leafReview(w.xc, { node: 'a', round: 1, review_round: 1, dispatch, units: U })
    assert.equal(result.decision.next, 'held', status)
    assert.equal(result.raise, false, status)
    assert.equal(events(w, 'approved').length, 0, status)
    assert.equal(faults(w).length, 1, status)
    assert.equal(existsSync(reviewPath(w.r, E, STAMP, 'a', 1)), false, status)
  }
})

test('a round run twice records nothing twice and reports the same', async (t) => {
  // approving
  {
    const w = world(t)
    produced(w, { node: 'a', round: 1 })
    const first = await go(w, { round: 1 })
    const again = await leafReview(w.xc, first.args)
    assert.deepEqual(again, first.result)
    assert.equal(events(w, 'approved').length, 1)
  }
  // fixing
  {
    const w = world(t)
    produced(w, { node: 'a', round: 1 })
    const first = await go(w, { round: 1, findings: [finding('F1')] })
    const record = recordOf(w, 'a', 1)
    const again = await leafReview(w.xc, first.args)
    assert.deepEqual(again, first.result)
    assert.equal(messages(w).length, 1, 'one message per node and round')
    assert.deepEqual(recordOf(w, 'a', 1), record)
  }
  // escalating
  {
    const w = world(t)
    produced(w, { node: 'a', round: 1 })
    await go(w, { round: 1, findings: [finding('F1')] })
    produced(w, { node: 'a', round: 2 })
    await go(w, { round: 2, fix: [notFixed('F1')] })
    produced(w, { node: 'a', round: 3 })
    const third = await go(w, { round: 3, fix: [notFixed('F1')] })
    assert.equal(third.result.decision.next, 'escalate')
    const again = await leafReview(w.xc, third.args)
    assert.deepEqual(again, third.result)
    assert.equal(events(w, 'escalated').length, 1)
  }
})

test('a round that crashed after some records landed records the rest once when run again', async (t) => {
  const w = world(t, cycleLeaves())
  produced(w, { node: 'u', round: 1, role: 'auditor', thread: 'auditor:u' })
  const ret = verdict({ findings: [finding('F1'), finding('F2', { remedy: 'tests' })] })
  const dispatch = reviewed(w, { node: 'u', round: 1, review_round: 1, value: ret })
  const args = { node: 'u', round: 1, review_round: 1, dispatch, units: U }
  let appended = 0
  const flaky = {
    ...w.xc,
    log: {
      entries: () => w.xc.log.entries(),
      append(kind, fields) {
        if (kind === 'message' && appended++ === 1) throw new Error('crash between two messages')
        return w.xc.log.append(kind, fields)
      },
    },
  }
  await assert.rejects(async () => leafReview(flaky, args), /crash between two messages/)
  assert.equal(messages(w).length, 1)
  const result = await leafReview(w.xc, args)
  assert.equal(result.decision.next, 'fix')
  const sent = messages(w)
  assert.equal(sent.length, 2)
  assert.deepEqual(sent.map((m) => m.thread).sort(), ['auditor:u', 'producer:r'])
})

test('a node that is no leaf throws', async (t) => {
  const w = world(t)
  produced(w, { node: 'a', round: 1 })
  const dispatch = reviewed(w, { node: 'a', round: 1, review_round: 1, value: verdict() })
  const args = { round: 1, review_round: 1, dispatch, units: U }
  await assert.rejects(async () => leafReview(w.xc, { ...args, node: '.' }), /not a leaf/)
  await assert.rejects(async () => leafReview(w.xc, { ...args, node: 'nowhere' }))
  assert.equal(events(w, 'approved').length, 0)
})

// ------------------------------------------------------------------ the verdict side

test('unruledUnit is true for a unit: entry and false for any other', () => {
  assert.equal(unruledUnit({ id: 'unit:criterion:1' }), true)
  assert.equal(unruledUnit({ id: 'unit:file:src/a.mjs' }), true)
  assert.equal(unruledUnit({ id: 'F1' }), false)
  assert.equal(unruledUnit({ id: 'xunit:1' }), false)
})

test('greenRoundRole leaves unruled unit entries out of a review\'s open set', () => {
  const unit = { id: 'unit:criterion:1', severity: 'critical', claim: 'unit not ruled: criterion:1', evidence: '', failure_scenario: '' }
  const tests = finding('F1', { remedy: 'tests' })
  const code = finding('F2')
  assert.equal(greenRoundRole({ review: { next: 'fix', open: [unit, tests] } }), 'test-author')
  assert.equal(greenRoundRole({ review: { next: 'fix', open: [tests, unit] } }), 'test-author')
  assert.equal(greenRoundRole({ review: { next: 'fix', open: [unit, tests, code] } }), 'implementer')
  assert.equal(greenRoundRole({ review: { next: 'fix', open: [tests] } }), 'test-author')
})
