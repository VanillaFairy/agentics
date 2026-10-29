// test/execute-leaf-retry-review.test.mjs — pins that a leaf stopped by its review loop goes on at
// its next round once the session retries it: the stopping review's open findings and the
// `retried` message reach the producer, and the replayed review never lands the stop again.
//
// The rig, the scripted answers and the worlds are in test/harness/execute-leaf-world.mjs.
//
// Design: docs/DESIGN.md#executors-and-review and docs/DESIGN.md#session-calls.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMessage } from '../lib/conversation.mjs'
import { attach } from '../lib/integration.mjs'
import { append } from '../lib/ledger.mjs'
import {
  T, E, leafEntry, YARD, bLeaf, write, work, world, ofKind, messages, faultsOf, startsOf, approvals,
  IMPL, REV, done, verdict, finding, fixed,
} from './harness/execute-leaf-world.mjs'

// The rig does not clear NODE_TEST_CONTEXT, and a measurement's nested `node --test` that inherits
// it reports to this runner and exits 0, so every red or tdd test file would read as passing.
delete process.env.NODE_TEST_CONTEXT

const NOTE = 'the second blocker is a false alarm; fix the first'
const RULER = (n, id = 'b') => 'ruler|' + id + '|ruler:converge:' + id + ':' + n
const ruling = (value) => ({ output: { ruling: value, why: 'WHY-' + value } })
const notFixed = (id) => ({ id, status: 'not_fixed', evidence: 'ruled ' + id })
const stopped = () => ({ status: 'stopped', cause: 'rate_limit' })
const producerSteps = (n) => Array.from({ length: n }, () => done())
const reviewSteps = (verdicts) => Object.fromEntries(verdicts.map((v, i) => [REV(i + 1), [v]]))

/** A world whose producer commits in each of `rounds` rounds; src/b.txt reads ok, so every round measures green. */
function loopWorld(t, rounds) {
  const w = world(t, { leaves: [bLeaf(YARD)] })
  for (let i = 1; i <= rounds; i++) {
    w.job('implementer|b#' + i, (cwd) => work(cwd, i === 1 ? { 'src/b.txt': 'ok\n', 'src/b2.txt': 'round 1\n' } : { 'src/b2.txt': 'round ' + i + '\n' }, 'round ' + i))
  }
  return w
}

/** What the session's `note` and `retry` write. */
function retry(w, node = 'b') {
  const wrote = append(w.rig.repo, E, 'events', [
    { kind: 'noted', node, execution: w.rig.stamp, by: 'session', text: NOTE },
    { kind: 'replanned', node, execution: w.rig.stamp, reason: 'retry_escalated', by: 'session' },
  ])
  assert.equal(wrote.ok, true, JSON.stringify(wrote))
}

// A cycle, as test/execute-leaf-cycle.test.mjs builds it: a red approved without rounds of its own, a green.
const R_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { r } from '../src/r.mjs'\ntest('doubles 2', () => assert.equal(r(2), 4))\n"
const R_TEST_TWO = R_TEST + "test('doubles 3', () => assert.equal(r(3), 6))\n"
const R_TEST_FOUR = R_TEST_TWO + "test('doubles 5', () => assert.equal(r(5), 10))\n"
const R_TEST_SIX = R_TEST_FOUR + "test('doubles 7', () => assert.equal(r(7), 14))\n"
const R_SRC = 'export const r = (x) => x * 2\n'
const R_BITES = { file: 'src/r.mjs', find: 'x * 2', replace: 'x * 3', expect_failing: ['test/r.test.mjs'] }
const R1 = finding('R1', { remedy: 'tests' })

function cycleWorld(t) {
  return world(t, {
    leaves: [
      leafEntry('r', { rigor: 'tdd-pair', role: 'red', expects: ['test/r.test.mjs'], check: 'node pass.mjs' }),
      leafEntry('g', { rigor: 'tdd-pair', role: 'green', after: 'r', expects: ['src/r.mjs'], check: 'node pass.mjs' }),
    ],
  })
}

/** The red approved without its own rounds: its branch cut from the effort branch, its test committed, `approved` appended. */
function seedRed(w) {
  const { rig } = w
  rig.git('branch', rig.branchOf('r'), rig.branchOf('.'))
  assert.equal(attach(rig.repo, rig.branchOf('r'), rig.worktreeOf('r')).ok, true)
  const head = work(rig.worktreeOf('r'), { 'test/r.test.mjs': R_TEST }, 'Pin r')
  rig.log.append('approved', { node: 'r', head_sha: head, review_rounds: 1, at_integration: false })
}

/** F1 ruled not fixed twice: review 3 escalates review_not_converging on its own. */
const ESCALATING = [
  verdict({ findings: [finding('F1')] }),
  verdict({ fix: [notFixed('F1')] }),
  verdict({ fix: [notFixed('F1')] }),
]
/** Three rounds that each end in a fix (T29a's shape): the ruler is asked after review 3. */
const THREE = [
  verdict({ findings: [finding('F1')] }),
  verdict({ fix: [fixed('F1')], findings: [finding('F2')] }),
  verdict({ fix: [notFixed('F2')] }),
]

/** The round-4 call carries every message waiting for round 4: the findings and the retried. */
function assertRoundFour(w, findingId, reason = 'review_not_converging') {
  const found = messages(w.rig, 'producer:b', 'findings').filter((m) => m.round === 4)
  assert.equal(found.length, 1, 'one findings message for round 4')
  assert.ok(found[0].payload.findings.some((f) => f.id === findingId), findingId)
  const retried = messages(w.rig, 'producer:b', 'retried')
  assert.equal(retried.length, 1)
  assert.equal(retried[0].round, 4)
  assert.deepEqual(retried[0].payload, { reason, notes: [NOTE] })
  const four = startsOf(w.rig, 'implementer', 'b').find((c) => c.round === 4)
  assert.ok(four, 'round 4 is dispatched')
  for (const m of [found[0], retried[0]]) {
    assert.ok(four.carries.includes(m.seq), m.msg + ' is carried')
    assert.ok(four.brief.includes(renderMessage({ msg: m.msg, payload: m.payload })), m.msg + ' is in the prompt')
  }
}

describe('a retry after a review-loop stop', { concurrency: 4 }, () => {
  test('a retry after a review escalation opens the next round with the open findings and the retried message', T, async (t) => {
    const w = loopWorld(t, 4)
    w.rig.script({ [IMPL]: producerSteps(4), ...reviewSteps([...ESCALATING, verdict({ fix: [fixed('F1')] })]) })
    const first = await w.run('b')
    assert.equal(first.outcome, 'stopped')
    assert.deepEqual(ofKind(w.rig, 'escalated', 'b').map((e) => e.reason), ['review_not_converging'])
    retry(w)
    const second = await w.run('b')
    assert.equal(second.outcome, 'approved')
    assert.equal(second.round, 4)
    assert.equal(second.review_rounds, 4)
    assert.equal(ofKind(w.rig, 'escalated', 'b').length, 1, 'the replayed review lands no second escalation')
    assert.equal(startsOf(w.rig, 'reviewer', 'b').length, 4, 'no stopping reviewer is called again')
    assertRoundFour(w, 'F1')
    assert.deepEqual(faultsOf(w.rig), [])
    assert.equal(approvals(w.rig).length, 1)
  })

  test('a retry after a not_converging ruling opens the next round with the open findings and the retried message', T, async (t) => {
    const w = loopWorld(t, 4)
    w.rig.script({
      [IMPL]: producerSteps(4), ...reviewSteps([...THREE, verdict({ fix: [fixed('F2')] })]),
      [RULER(3)]: [ruling('not_converging')],
    })
    const first = await w.run('b')
    assert.equal(first.outcome, 'stopped')
    retry(w)
    const second = await w.run('b')
    assert.equal(second.outcome, 'approved')
    assert.equal(second.round, 4)
    assert.equal(ofKind(w.rig, 'escalated', 'b').length, 1, 'the replayed ruling lands no second escalation')
    assert.equal(startsOf(w.rig, 'ruler', 'b').length, 1, 'the ruler is not asked again')
    assertRoundFour(w, 'F2', 'not_converging')
    assert.equal(approvals(w.rig).length, 1)
  })

  test('a cleared review stop cut off in its next round lands each message once on relaunch', T, async (t) => {
    const w = loopWorld(t, 4)
    w.rig.script({ [IMPL]: [...producerSteps(3), stopped()], ...reviewSteps(ESCALATING) })
    assert.equal((await w.run('b')).outcome, 'stopped')
    retry(w)
    let hit
    const reached = new Promise((resolveIt) => { hit = resolveIt })
    const cut = w.leg({ sleep: () => { hit(); return new Promise(() => {}) } }).run('b')
    const ended = await Promise.race([reached.then(() => 'cut off'), cut.then(() => 'ended', () => 'ended')])
    assert.equal(ended, 'cut off', 'round 4 is dispatched and cut off')
    const again = w.relaunch()
    again.rig.script({ [IMPL]: [done()], [REV(4)]: [verdict({ fix: [fixed('F1')] })] })
    const out = await again.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 4)
    assert.equal(messages(again.rig, 'producer:b', 'findings').filter((m) => m.round === 4).length, 1)
    assert.equal(messages(again.rig, 'producer:b', 'retried').length, 1)
    assert.equal(ofKind(again.rig, 'escalated', 'b').length, 1)
  })

  test('a review-loop stop with no retry stays stopped on relaunch and lands nothing new', T, async (t) => {
    const w = loopWorld(t, 3)
    w.rig.script({ [IMPL]: producerSteps(3), ...reviewSteps(ESCALATING) })
    assert.equal((await w.run('b')).outcome, 'stopped')
    const again = w.relaunch()
    again.rig.script({})
    const out = await again.run('b')
    assert.equal(out.outcome, 'stopped')
    assert.equal(again.rig.calls.length, 0)
    assert.equal(ofKind(again.rig, 'escalated', 'b').length, 1)
    assert.equal(messages(again.rig, 'producer:b', 'findings').filter((m) => m.round === 4).length, 0)
  })

  test('a retry over commits made by hand after a review-loop stop measures them and hands them to a fresh reviewer, no producer round', T, async (t) => {
    const w = loopWorld(t, 3)
    w.rig.script({ [IMPL]: producerSteps(3), ...reviewSteps([...ESCALATING, verdict({ fix: [fixed('F1')] })]) })
    assert.equal((await w.run('b')).outcome, 'stopped')
    const stoppedAt = w.rig.git('rev-parse', 'refs/heads/' + w.rig.branchOf('b'))
    const hand = work(w.rig.worktreeOf('b'), { 'src/b2.txt': 'F1 fixed by hand\n' }, 'fix F1 by hand')
    retry(w)
    const second = await w.run('b')
    assert.equal(second.outcome, 'approved', JSON.stringify(ofKind(w.rig, 'escalated', 'b')))
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 3, 'no producer round after the retry')
    const reviewers = startsOf(w.rig, 'reviewer', 'b')
    assert.equal(reviewers.length, 4, 'one fresh reviewer, the stopping one never called again')
    assert.ok(reviewers[3].brief.includes(stoppedAt) && reviewers[3].brief.includes(hand), 'the fresh review spans the commits made by hand')
    assert.deepEqual(approvals(w.rig).map((e) => e.head_sha), [hand])
    assert.deepEqual(messages(w.rig, 'producer:b', 'findings').filter((m) => m.round === 4), [], "the stopping review's findings reach no producer")
    assert.equal(ofKind(w.rig, 'escalated', 'b').length, 1)
  })

  test('a fresh review of commits made by hand, cut off, is resumed on relaunch and never turns into a producer round', T, async (t) => {
    const w = loopWorld(t, 3)
    w.rig.script({ [IMPL]: producerSteps(3), ...reviewSteps(ESCALATING), [REV(4)]: [stopped()] })
    assert.equal((await w.run('b')).outcome, 'stopped')
    const hand = work(w.rig.worktreeOf('b'), { 'src/b2.txt': 'F1 fixed by hand\n' }, 'fix F1 by hand')
    retry(w)
    let hit
    const reached = new Promise((resolveIt) => { hit = resolveIt })
    const cut = w.leg({ sleep: () => { hit(); return new Promise(() => {}) } }).run('b')
    const ended = await Promise.race([reached.then(() => 'cut off'), cut.then(() => 'ended', () => 'ended')])
    assert.equal(ended, 'cut off', 'the fresh reviewer is dispatched and cut off')
    const again = w.relaunch()
    again.rig.script({ [REV(4)]: [verdict({ fix: [fixed('F1')] })] })
    const out = await again.run('b')
    assert.equal(out.outcome, 'approved', JSON.stringify(ofKind(again.rig, 'escalated', 'b')))
    assert.equal(startsOf(again.rig, 'implementer', 'b').length, 0, 'no producer round on relaunch')
    assert.deepEqual(approvals(again.rig).map((e) => e.head_sha), [hand])
    assert.deepEqual(messages(again.rig, 'producer:b', 'findings').filter((m) => m.round === 4), [])
  })

  test("a retried green whose stopping review left only tests findings sends its next round to the cycle's test session", T, async (t) => {
    const w = cycleWorld(t)
    seedRed(w)
    w.job('implementer|g#1', (cwd) => work(cwd, { 'src/r.mjs': R_SRC }, 'implement r'))
    w.job('test-author|g#2', (cwd) => write(cwd, { 'test/r.test.mjs': R_TEST_TWO }))
    w.job('test-author|g#3', (cwd) => write(cwd, { 'test/r.test.mjs': R_TEST_FOUR }))
    w.job('test-author|g#4', (cwd) => write(cwd, { 'test/r.test.mjs': R_TEST_SIX }))
    w.rig.script({
      'implementer|g|producer:g': [done()],
      'test-author|g|producer:r': [...[1, 2, 3].map(() => done('pinned more', { mutations: [R_BITES] })), done('nothing to consolidate')],
      'reviewer|g|reviewer:g:1': [verdict({ findings: [R1] })],
      'reviewer|g|reviewer:g:2': [verdict({ fix: [notFixed('R1')] })],
      'reviewer|g|reviewer:g:3': [verdict({ fix: [notFixed('R1')] })],
      'reviewer|g|reviewer:g:4': [verdict({ fix: [fixed('R1')] })],
    })
    const first = await w.run('g')
    assert.equal(first.outcome, 'stopped')
    assert.deepEqual(ofKind(w.rig, 'escalated', 'g').map((e) => e.reason), ['review_not_converging'])
    retry(w, 'g')
    const second = await w.run('g')
    assert.equal(second.outcome, 'approved')
    assert.equal(second.round, 5, 'round 5 is the consolidation')
    assert.equal(startsOf(w.rig, 'implementer', 'g').length, 1, 'no implementer round after the retry')
    const four = startsOf(w.rig, 'test-author', 'g').find((c) => c.round === 4)
    assert.ok(four, "round 4 goes to the cycle's test session")
    assert.equal(four.thread.key, 'producer:r')
    const found = messages(w.rig, 'producer:r', 'findings').filter((m) => m.round === 4)
    assert.equal(found.length, 1)
    assert.ok(found[0].payload.findings.some((f) => f.id === 'R1'))
    const retried = messages(w.rig, 'producer:r', 'retried')
    assert.equal(retried.length, 1)
    assert.equal(retried[0].round, 4)
    for (const m of [found[0], retried[0]]) assert.ok(four.carries.includes(m.seq), m.msg + ' is carried')
    assert.deepEqual(messages(w.rig, 'producer:g', 'findings').filter((m) => m.round === 4), [])
  })

  test('a retried green whose stopping review left a mixed set sends its next round to the implementer, the tests finding carried', T, async (t) => {
    const w = cycleWorld(t)
    seedRed(w)
    for (let i = 1; i <= 4; i++) w.job('implementer|g#' + i, (cwd) => work(cwd, { 'src/r.mjs': R_SRC + '// round ' + i + '\n' }, 'round ' + i))
    w.rig.script({
      'implementer|g|producer:g': producerSteps(4),
      'reviewer|g|reviewer:g:1': [verdict({ findings: [finding('F1'), R1] })],
      'reviewer|g|reviewer:g:2': [verdict({ fix: [notFixed('F1')] })],
      'reviewer|g|reviewer:g:3': [verdict({ fix: [notFixed('F1')] })],
      'reviewer|g|reviewer:g:4': [verdict({ fix: [fixed('F1'), fixed('R1')] })],
      'test-author|g|producer:r': [done('nothing to consolidate')],
    })
    const first = await w.run('g')
    assert.equal(first.outcome, 'stopped')
    assert.deepEqual(ofKind(w.rig, 'escalated', 'g').map((e) => e.reason), ['review_not_converging'])
    retry(w, 'g')
    const second = await w.run('g')
    assert.equal(second.outcome, 'approved')
    assert.equal(second.round, 5, 'round 5 is the consolidation')
    assert.deepEqual(startsOf(w.rig, 'test-author', 'g').filter((c) => c.round < 5), [], 'no test round while a code finding is open')
    const four = startsOf(w.rig, 'implementer', 'g').find((c) => c.round === 4)
    assert.ok(four, 'round 4 goes to the implementer')
    const found = messages(w.rig, 'producer:g', 'findings').filter((m) => m.round === 4)
    assert.equal(found.length, 1)
    assert.deepEqual(found[0].payload.findings.map((f) => f.id), ['F1'], 'the tests finding is carried, not sent')
    assert.deepEqual(messages(w.rig, 'producer:r', 'findings').filter((m) => m.round === 4), [])
    const retried = messages(w.rig, 'producer:g', 'retried')
    assert.equal(retried.length, 1)
    for (const m of [found[0], retried[0]]) assert.ok(four.carries.includes(m.seq), m.msg + ' is carried')
  })
})
