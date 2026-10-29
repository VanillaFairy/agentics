// test/execute-leaf-review.test.mjs — pins the leaf unit of the execute program (`runLeaf`): one
// leaf driven over the execution rig, with scripted agents, through the review loop.
//
// What is pinned here:
//
//   the review loop  a fresh reviewer each round, its units, the blockers handed on, the raise, the
//                    escalations, and the open set of unruled units that goes to the next
//                    reviewer instead of the producer
//
// The rig, the scripted answers and the worlds the parts share are in
// test/harness/execute-leaf-world.mjs.
//
// Design: docs/DESIGN.md#executors-and-review.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { reviewerBrief } from '../lib/briefs/execute.mjs'
import { heldOf } from '../lib/boundaries/records.mjs'
import { leafOpen } from '../lib/boundaries/leaf-open.mjs'
import { renderMessage } from '../lib/conversation.mjs'
import { readOnlyPermissions } from '../lib/permissions.mjs'
import { raiseTier, reviewerTier } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { append } from '../lib/ledger.mjs'
import { readJson, reviewPath } from '../lib/store.mjs'
import {
  T, YARD, bLeaf, work, world, ofKind, messages, stateOf, faultsOf, startsOf, headOf, approvals, stopsOn,
  keyOf, sessionFor, nodeOf, roleOf, IMPL, REV, done, failed, ALL_UNITS, verdict, finding, fixed,
} from './harness/execute-leaf-world.mjs'

// The rig does not clear NODE_TEST_CONTEXT, and a measurement's nested `node --test` that inherits
// it reports to this runner and exits 0, so every red or tdd test file would read as passing.
delete process.env.NODE_TEST_CONTEXT

/** A scenario built once and shared by the tests that read it; its repositories go with `end()`. */
function scenario(build) {
  const cleanups = []
  let made = null
  return {
    get: () => (made ??= build({ after: (fn) => cleanups.push(fn) })),
    end: () => { for (const fn of cleanups) fn() },
  }
}

const reviewRecord = (rig, n, id = 'b') => readJson(reviewPath(rig.repo, rig.effort, rig.stamp, id, n))

const sorted = (list) => [...list].sort()

const notFixed = (id) => ({ id, status: 'not_fixed', evidence: 'ruled ' + id })

// ------------------------------------------------------------------ one round

describe('the leaf unit', { concurrency: 4 }, () => {

  // ------------------------------------------------------------------ the review loop

  /** A critical in review 1, fixed in round 2 and ruled fixed in review 2; the world is read by several tests. */
  const loop = scenario(async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    const opened = await leafOpen(w.xc, { node: 'b', intelligence: 'normal', sleep: w.ctx.sleep })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n', 'src/b2.txt': 'one\n' }, 'round one'))
    w.job('implementer|b#2', (cwd) => work(cwd, { 'src/b2.txt': 'two\n' }, 'round two'))
    w.rig.script({
      [IMPL]: [done('ROUND-ONE-ACCOUNT'), done('round two account')],
      [REV(1)]: [verdict({ findings: [finding('F1')] })],
      [REV(2)]: [verdict({ fix: [fixed('F1')] })],
    })
    const out = await w.run('b')
    return { w, out, opened }
  })
  describe('the review loop', { concurrency: 4 }, () => {
    after(() => loop.end())

    test('the review loop: a critical sent back, fixed next round, approves after two fresh reviewers', T, async () => {
      const { w, out } = await loop.get()
      assert.equal(out.outcome, 'approved')
      assert.equal(out.round, 2)
      assert.equal(out.review_rounds, 2)
      const reviewers = startsOf(w.rig, 'reviewer', 'b')
      assert.deepEqual(reviewers.map((c) => c.thread.key), ['reviewer:b:1', 'reviewer:b:2'])
      assert.deepEqual(reviewers.map((c) => c.resume), [false, false])
      assert.deepEqual(reviewers.map((c) => c.round), [1, 2], "a reviewer's round is the reviewed producer round")
      const producer = startsOf(w.rig, 'implementer', 'b')[0].thread.session
      const sessions = [producer, ...reviewers.map((c) => c.thread.session)]
      assert.equal(new Set(sessions).size, 3, 'the reviewers and the producer are three sessions')
      const ok = approvals(w.rig)
      assert.equal(ok.length, 1)
      assert.equal(ok[0].review_rounds, 2)
      assert.equal(ok[0].head_sha, headOf(w.rig))
    })

    test("a reviewer runs fresh, read-only, in the leaf's worktree, on the reviewer's tier", T, async () => {
      const { w, opened } = await loop.get()
      const leaf = nodeOf(w.rig)
      const reviewer = roleOf('reviewer')
      const [one, two] = startsOf(w.rig, 'reviewer', 'b')
      for (const call of [one, two]) {
        assert.equal(call.node, 'b')
        assert.equal(call.resume, false)
        assert.equal(resolve(call.cwd), resolve(w.rig.worktreeOf('b')))
        assert.deepEqual(call.permissions, readOnlyPermissions(reviewer))
        assert.deepEqual(call.tier, reviewerTier(leaf, reviewer, { intelligence: 'normal' }))
        assert.deepEqual(call.schema, schemaOf('reviewer'))
        assert.equal(call.role.name, 'reviewer')
      }
      // Its prompt is reviewerBrief over the span, the producer's return and the units (the leaf's brief as its producer has it ends it).
      const MARK = '@@LEAF-BRIEF@@'
      const record = reviewRecord(w.rig, 1)
      const lead = reviewerBrief({
        leaf, brief: MARK, span: { base: opened.base_sha, head: record.head_sha },
        producer: { status: 'done', concerns: [], text: 'ROUND-ONE-ACCOUNT' }, units: record.units, prior: [],
      }).split(MARK)[0]
      assert.ok(one.brief.startsWith(lead), "review 1's prompt is reviewerBrief's: the span, the return, the units")
      assert.ok(one.brief.includes(opened.brief.trim()), "and the leaf's brief as its producer has it")
    })

    test('a later review rules only the files of the fix span', T, async () => {
      const { w } = await loop.get()
      const first = reviewRecord(w.rig, 1)
      assert.equal(first.units[0], 'criterion:1')
      assert.deepEqual(sorted(first.units.slice(1)), ['file:src/b.txt', 'file:src/b2.txt'], 'the first review rules the whole span from the base')
      const record = reviewRecord(w.rig, 2)
      assert.equal(record.units[0], 'criterion:1')
      assert.deepEqual(record.units.slice(1), ['file:src/b2.txt'], 'the fix round changed one file')
    })

    test('the next reviewer is handed the blockers the round before left open', T, async () => {
      const { w } = await loop.get()
      const [one, two] = startsOf(w.rig, 'reviewer', 'b')
      assert.ok(two.brief.includes(finding('F1').claim), "review 2's prompt names the claim review 1 left open")
      assert.ok(!one.brief.includes(finding('F1').claim), "review 1's does not")
    })

    test("a fix round resumes the producer's session with the open findings as its prompt", T, async () => {
      const { w } = await loop.get()
      const sent = messages(w.rig, 'producer:b', 'findings')
      assert.equal(sent.length, 1)
      assert.equal(sent[0].round, 2)
      assert.ok(sent[0].payload.findings.some((f) => f.id === 'F1'))
      const [one, two] = startsOf(w.rig, 'implementer', 'b')
      assert.equal(two.round, 2)
      assert.equal(two.resume, true)
      assert.equal(two.thread.session, one.thread.session)
      assert.equal(two.brief, renderMessage({ msg: 'findings', payload: sent[0].payload }))
      assert.deepEqual(two.carries, [sent[0].seq])
    })
  })

  test('a round after a review that cleared none of its blockers is a fresh session on the raised tier', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n', 'src/b2.txt': 'one\n' }, 'round one'))
    w.job('implementer|b#2', (cwd) => work(cwd, { 'src/b2.txt': 'two\n' }, 'round two'))
    w.job('implementer|b#3', (cwd) => work(cwd, { 'src/b2.txt': 'three\n' }, 'round three'))
    w.rig.script({
      [IMPL]: [done(), done(), done()],
      [REV(1)]: [verdict({ findings: [finding('F1')] })],
      [REV(2)]: [verdict({ fix: [notFixed('F1')] })],
      [REV(3)]: [verdict({ fix: [fixed('F1')] })],
    })
    const out = await w.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 3)
    assert.equal(out.review_rounds, 3)
    const renewals = stateOf(w.rig).filter((e) => e.kind === 'thread_renewed' && e.thread === 'producer:b')
    assert.equal(renewals.length, 1, 'renewed once')
    assert.equal(renewals[0].gen, 1)
    assert.equal(renewals[0].why, 'raised')
    const [one, two, three] = startsOf(w.rig, 'implementer', 'b')
    assert.equal(two.resume, true)
    assert.equal(three.round, 3)
    assert.equal(three.resume, false)
    assert.equal(three.thread.gen, 1)
    assert.equal(three.thread.session, sessionFor(w.rig, { node: 'b', role: 'implementer', thread: 'producer:b', gen: 1 }))
    assert.notEqual(three.thread.session, one.thread.session)
    assert.deepEqual(three.tier, raiseTier(two.tier))
    assert.notDeepEqual(three.tier, two.tier)
    const dispatchedThree = ofKind(w.rig, 'dispatched', 'b').find((e) => e.dispatch === three.dispatch)
    assert.ok(renewals[0].seq < dispatchedThree.seq, 'the renewal comes before the call')
  })

  test('a prior blocker ruled not_fixed and not re-reported stays open, and not fixed twice escalates', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n', 'src/b2.txt': 'one\n' }, 'round one'))
    w.job('implementer|b#2', (cwd) => work(cwd, { 'src/b2.txt': 'two\n' }, 'round two'))
    w.job('implementer|b#3', (cwd) => work(cwd, { 'src/b2.txt': 'three\n' }, 'round three'))
    w.rig.script({
      [IMPL]: [done(), done(), done()],
      [REV(1)]: [verdict({ findings: [finding('F1')] })],
      [REV(2)]: [verdict({ fix: [notFixed('F1')] })],
      [REV(3)]: [verdict({ fix: [notFixed('F1')] })],
    })
    const out = await w.run('b')
    assert.equal(out.outcome, 'stopped')
    assert.equal(out.review_rounds, 3)
    assert.equal(out.round, 3)
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 3, 'review 2 left F1 open although nobody re-reported it')
    const stops = ofKind(w.rig, 'escalated', 'b')
    assert.deepEqual(stops.map((e) => e.reason), ['review_not_converging'])
    assert.equal(stops[0].said, keyOf('b', 'reviewer', 'reviewer:b:3', 3), "said is the third reviewer's dispatch")
    assert.equal(approvals(w.rig).length, 0)
  })

  test('a review that leaves units unruled goes to a fresh reviewer, not to the producer', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n', 'src/b2.txt': 'one\n' }, 'round one'))
    w.rig.script({
      [IMPL]: [done()],
      [REV(1)]: [verdict({ ruled: ['criterion:1'] })],
      [REV(2)]: [verdict()],
    })
    const out = await w.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 1)
    assert.equal(out.review_rounds, 2)
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 1, 'no producer round 2')
    const reviewers = startsOf(w.rig, 'reviewer', 'b')
    assert.deepEqual(reviewers.map((c) => c.thread.key), ['reviewer:b:1', 'reviewer:b:2'])
    assert.deepEqual(reviewers.map((c) => c.round), [1, 1], 'the same producer round')
    assert.deepEqual(reviewers.map((c) => c.resume), [false, false])
    const first = reviewRecord(w.rig, 1)
    assert.equal(first.next, 'fix')
    assert.ok(first.open.length > 0 && first.open.every((o) => String(o.id).startsWith('unit:')), 'what stayed open is unruled units alone')
    assert.deepEqual(messages(w.rig, 'producer:b'), [], 'no message waits on the producer, whatever its kind')
    assert.equal(approvals(w.rig).length, 1)
  })

  test('a unit two reviewers of a round leave unruled stops review_incomplete; a retry asks a fresh reviewer, never a producer round', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n', 'src/b2.txt': 'one\n' }, 'round one'))
    w.rig.script({
      [IMPL]: [done()],
      [REV(1)]: [verdict({ ruled: ALL_UNITS.filter((u) => u !== 'criterion:1') })],
      [REV(2)]: [verdict({ ruled: [] })],
      [REV(3)]: [verdict()],
    })
    const first = await w.run('b')
    assert.equal(first.outcome, 'stopped')
    const stops = ofKind(w.rig, 'escalated', 'b')
    assert.deepEqual(stops.map((e) => e.reason), ['review_incomplete'], 'the second miss of criterion:1 stops, not a third reviewer')
    assert.match(stops[0].detail, /criterion:1/)
    assert.equal(stops[0].said, keyOf('b', 'reviewer', 'reviewer:b:2', 1))
    assert.equal(startsOf(w.rig, 'reviewer', 'b').length, 2)

    append(w.rig.repo, w.rig.effort, 'events', [{ kind: 'replanned', node: 'b', execution: w.rig.stamp, reason: 'retry_escalated', by: 'session' }])
    const second = await w.run('b')
    assert.equal(second.outcome, 'approved')
    assert.deepEqual(startsOf(w.rig, 'reviewer', 'b').map((c) => [c.thread.key, c.round, c.resume]),
      [['reviewer:b:1', 1, false], ['reviewer:b:2', 1, false], ['reviewer:b:3', 1, false]], 'a fresh reviewer at the same producer round')
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 1, 'no producer round with nothing to fix')
    assert.deepEqual(messages(w.rig, 'producer:b'), [])
  })

  test('a reviewer dispatch that fails holds the leaf on a fault', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'round one'))
    w.rig.script({ [IMPL]: [done()], [REV(1)]: [failed('host_error')] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'faulted')
    const faults = faultsOf(w.rig)
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'host_error')
    assert.ok(heldOf(stateOf(w.rig)).has('b'))
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 1, 'no producer round follows')
    assert.deepEqual(stopsOn(w.rig), [])
    assert.equal(approvals(w.rig).length, 0)
  })

  test('a review that comes back without findings holds the leaf on a role fault', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'round one'))
    w.rig.script({
      [IMPL]: [done()],
      [REV(1)]: [{ output: { units: ALL_UNITS.map((unit) => ({ unit, ruling: 'clean', why: 'read it' })), claims: [], notes: '' } }],
    })
    const out = await w.run('b')
    assert.equal(out.outcome, 'faulted')
    const faults = faultsOf(w.rig)
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'role')
    assert.ok(heldOf(stateOf(w.rig)).has('b'))
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 1, 'no producer round follows')
    assert.equal(startsOf(w.rig, 'reviewer', 'b').length, 1)
    assert.equal(approvals(w.rig).length, 0)
  })
})
