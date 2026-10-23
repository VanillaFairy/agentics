// test/execute-leaf-convergence.test.mjs — pins the convergence ruling in the leaf unit's review
// loop (`runLeaf`): after a review round `askAfter` picks ends in a fix, a fresh ruler rules
// whether the loop converges; `not_converging` escalates the leaf, `converging` lets it go on, and
// a relaunch resumes or reads back the ruling of a round, never asking twice.
//
// The rig, the scripted answers and the worlds are in test/harness/execute-leaf-world.mjs.
//
// Design: docs/DESIGN.md#executors-and-review and docs/DESIGN.md#l2--states-end-work-counts-dont.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { heldOf } from '../lib/boundaries/records.mjs'
import { renderMessage } from '../lib/conversation.mjs'
import { readOnlyPermissions } from '../lib/permissions.mjs'
import { tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { readJson, reviewPath } from '../lib/store.mjs'
import {
  T, YARD, bLeaf, work, world, ofKind, stateOf, faultsOf, startsOf, approvals, stopsOn,
  keyOf, sessionFor, nodeOf, roleOf, IMPL, REV, done, failed, verdict, finding, fixed,
} from './harness/execute-leaf-world.mjs'

// The rig does not clear NODE_TEST_CONTEXT, and a measurement's nested `node --test` that inherits
// it reports to this runner and exits 0, so every red or tdd test file would read as passing.
delete process.env.NODE_TEST_CONTEXT

const RULER = (n, id = 'b') => 'ruler|' + id + '|ruler:converge:' + id + ':' + n
const ruling = (value, why = 'WHY-' + value) => ({ output: { ruling: value, why } })
const notFixed = (id) => ({ id, status: 'not_fixed', evidence: 'ruled ' + id })
const stopped = () => ({ status: 'stopped', cause: 'rate_limit' })
const reviewRecord = (rig, n, id = 'b') => readJson(reviewPath(rig.repo, rig.effort, rig.stamp, id, n))
const producerSteps = (n) => Array.from({ length: n }, () => done())
const reviewSteps = (verdicts) => Object.fromEntries(verdicts.map((v, i) => [REV(i + 1), [v]]))

/** Three review rounds that each end in a fix and trip no state predicate: F1; F1 fixed, F2 new; F2 not fixed. */
const THREE = [
  verdict({ findings: [finding('F1')] }),
  verdict({ fix: [fixed('F1')], findings: [finding('F2')] }),
  verdict({ fix: [notFixed('F2')] }),
]
/** Rounds four to six, the same shape again: F2 fixed, F3 new; F3 not fixed; F3 fixed, F4 new. */
const NEXT_THREE = [
  verdict({ fix: [fixed('F2')], findings: [finding('F3')] }),
  verdict({ fix: [notFixed('F3')] }),
  verdict({ fix: [fixed('F3')], findings: [finding('F4')] }),
]

/** A world whose producer commits in each of `rounds` rounds; src/b.txt reads ok, so every round measures green. */
function loopWorld(t, rounds) {
  const w = world(t, { leaves: [bLeaf(YARD)] })
  for (let i = 1; i <= rounds; i++) {
    w.job('implementer|b#' + i, (cwd) => work(cwd, i === 1 ? { 'src/b.txt': 'ok\n', 'src/b2.txt': 'round 1\n' } : { 'src/b2.txt': 'round ' + i + '\n' }, 'round ' + i))
  }
  return w
}

/** A scenario built once and shared by the tests that read it; its repositories go with `end()`. */
function scenario(build) {
  const cleanups = []
  let made = null
  return {
    get: () => (made ??= build({ after: (fn) => cleanups.push(fn) })),
    end: () => { for (const fn of cleanups) fn() },
  }
}

/** A killed run's quiet end: resolves the promise a test awaits and never resolves itself. */
function killer() {
  let hit
  const reached = new Promise((resolveIt) => { hit = resolveIt })
  return { reached, hit, sleep: () => { hit(); return new Promise(() => {}) } }
}

/** Wait until `run` is cut off by `k`; a run that ends first (no ruling asked) fails the test instead of hanging it. */
async function cutOff(run, k) {
  const ended = await Promise.race([k.reached.then(() => 'cut off'), run.then(() => 'ended', () => 'ended')])
  assert.equal(ended, 'cut off', 'the first run is cut off inside the ruling')
}

describe('the convergence ruling in the leaf review loop', { concurrency: 4 }, () => {
  /** Review 3 ends in a fix, the ruler rules not_converging; run at intelligence low. */
  const notConverging = scenario(async (t) => {
    const w = loopWorld(t, 3)
    w.rig.script({ [IMPL]: producerSteps(3), ...reviewSteps(THREE), [RULER(3)]: [ruling('not_converging', 'WHY-ROUNDS-2-AND-3')] })
    const out = await w.run('b', { intelligence: 'low' })
    return { w, out }
  })

  describe('a ruling of not_converging at review round 3', { concurrency: 4 }, () => {
    after(() => notConverging.end())

    test('a review round askAfter picks that ends in a fix asks a ruler, and not_converging escalates review_not_converging', T, async () => {
      const { w, out } = await notConverging.get()
      assert.equal(out.outcome, 'stopped')
      assert.equal(out.round, 3)
      assert.equal(out.review_rounds, 3)
      const stops = ofKind(w.rig, 'escalated', 'b')
      assert.deepEqual(stops.map((e) => e.reason), ['review_not_converging'])
      assert.equal(stops[0].said, keyOf('b', 'ruler', 'ruler:converge:b:3', 3), "said is the ruler's dispatch")
      assert.ok(stops[0].detail.includes('WHY-ROUNDS-2-AND-3'), "the detail carries the ruler's why")
      assert.equal(startsOf(w.rig, 'ruler', 'b').length, 1)
      assert.equal(startsOf(w.rig, 'implementer', 'b').length, 3, 'no producer round follows the ruling')
      assert.deepEqual(faultsOf(w.rig), [])
      assert.equal(approvals(w.rig).length, 0)
    })

    test("the ruler runs fresh on its own thread, read-only, in the leaf's worktree, on the ruler's tier", T, async () => {
      const { w } = await notConverging.get()
      const [call] = startsOf(w.rig, 'ruler', 'b')
      const ruler = roleOf('ruler')
      assert.equal(call.thread.key, 'ruler:converge:b:3')
      assert.equal(call.node, 'b')
      assert.equal(call.round, 3, 'its round is the reviewed producer round')
      assert.equal(call.resume, false)
      assert.equal(call.thread.session, sessionFor(w.rig, { node: 'b', role: 'ruler', thread: 'ruler:converge:b:3' }))
      const others = [...startsOf(w.rig, 'implementer', 'b'), ...startsOf(w.rig, 'reviewer', 'b')].map((c) => c.thread.session)
      assert.ok(!others.includes(call.thread.session), "the ruler's session is no producer's and no reviewer's")
      assert.deepEqual(call.schema, schemaOf('ruler_convergence'))
      assert.deepEqual(call.permissions, readOnlyPermissions(ruler))
      assert.deepEqual(call.tier, tierFor(ruler, { intelligence: 'low' }))
      assert.equal(resolve(call.cwd), resolve(w.rig.worktreeOf('b')))
    })

    test("the ruler's prompt is the convergence brief over every review record of the loop", T, async () => {
      const { w } = await notConverging.get()
      const [call] = startsOf(w.rig, 'ruler', 'b')
      const { convergenceBrief } = await import('../lib/briefs/execute.mjs')
      assert.equal(typeof convergenceBrief, 'function', "lib/briefs/execute.mjs builds the ruler's prompt")
      const reviews = [1, 2, 3].map((n) => reviewRecord(w.rig, n))
      assert.equal(call.brief, convergenceBrief({ leaf: nodeOf(w.rig), reviews }))
      for (const id of ['F1', 'F2']) assert.ok(call.brief.includes(finding(id).claim), id)
    })
  })

  test('a converging ruling lets the loop go on, and the next ruling is asked after review round 6', T, async (t) => {
    const w = loopWorld(t, 6)
    w.rig.script({
      [IMPL]: producerSteps(6), ...reviewSteps([...THREE, ...NEXT_THREE]),
      [RULER(3)]: [ruling('converging')], [RULER(6)]: [ruling('not_converging')],
    })
    const out = await w.run('b')
    assert.equal(out.outcome, 'stopped')
    assert.equal(out.round, 6)
    assert.equal(out.review_rounds, 6)
    const rulers = startsOf(w.rig, 'ruler', 'b')
    assert.deepEqual(rulers.map((c) => c.thread.key), ['ruler:converge:b:3', 'ruler:converge:b:6'], 'asked after review rounds 3 and 6 only')
    assert.deepEqual(rulers.map((c) => c.round), [3, 6])
    const ruledThree = ofKind(w.rig, 'returned').find((e) => e.dispatch === rulers[0].dispatch)
    const roundFour = ofKind(w.rig, 'dispatched', 'b').find((e) => e.role === 'implementer' && e.round === 4)
    assert.ok(ruledThree.seq < roundFour.seq, 'round 4 runs after the converging ruling')
    const stops = ofKind(w.rig, 'escalated', 'b')
    assert.deepEqual(stops.map((e) => e.reason), ['review_not_converging'])
    assert.deepEqual(stops.map((e) => e.said), [keyOf('b', 'ruler', 'ruler:converge:b:6', 6)])
  })

  test('a review round askAfter picks that approves asks no ruling', T, async (t) => {
    const w = loopWorld(t, 3)
    w.rig.script({ [IMPL]: producerSteps(3), ...reviewSteps([THREE[0], THREE[1], verdict({ fix: [fixed('F2')] })]) })
    const out = await w.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.review_rounds, 3)
    assert.deepEqual(startsOf(w.rig, 'ruler', 'b'), [])
  })

  test('a review round that leaves units unruled counts toward the ask', T, async (t) => {
    const w = loopWorld(t, 2)
    w.rig.script({
      [IMPL]: producerSteps(2),
      ...reviewSteps([verdict({ ruled: ['criterion:1'] }), verdict({ findings: [finding('F1')] }), verdict({ fix: [notFixed('F1')] })]),
      [RULER(3)]: [ruling('not_converging')],
    })
    const out = await w.run('b')
    assert.equal(out.outcome, 'stopped')
    assert.equal(out.review_rounds, 3)
    assert.equal(out.round, 2)
    assert.deepEqual(startsOf(w.rig, 'reviewer', 'b').map((c) => c.round), [1, 1, 2])
    const [call] = startsOf(w.rig, 'ruler', 'b')
    assert.equal(call.thread.key, 'ruler:converge:b:3')
    assert.equal(call.round, 2)
    assert.deepEqual(ofKind(w.rig, 'escalated', 'b').map((e) => e.reason), ['review_not_converging'])
  })

  test('a ruler dispatch that fails holds the leaf on a fault', T, async (t) => {
    const w = loopWorld(t, 3)
    w.rig.script({ [IMPL]: producerSteps(3), ...reviewSteps(THREE), [RULER(3)]: [failed('host_error')] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'faulted')
    const faults = faultsOf(w.rig)
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'host_error')
    assert.ok(heldOf(stateOf(w.rig)).has('b'))
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 3, 'no producer round follows')
    assert.deepEqual(stopsOn(w.rig), [])
    assert.equal(approvals(w.rig).length, 0)
  })

  test('a ruling that comes back without a ruling holds the leaf on a role fault', T, async (t) => {
    const w = loopWorld(t, 3)
    w.rig.script({ [IMPL]: producerSteps(3), ...reviewSteps(THREE), [RULER(3)]: [{ output: { why: 'it could not tell' } }] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'faulted')
    const faults = faultsOf(w.rig)
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'role')
    assert.ok(heldOf(stateOf(w.rig)).has('b'))
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 3, 'no producer round follows')
    assert.deepEqual(stopsOn(w.rig), [])
  })

  test('a relaunch resumes a ruler cut off mid-ruling in its own session and asks nothing else', T, async (t) => {
    const w = loopWorld(t, 3)
    w.rig.script({ [IMPL]: producerSteps(3), ...reviewSteps(THREE), [RULER(3)]: [stopped()] })
    const k = killer()
    await cutOff(w.leg({ sleep: k.sleep }).run('b'), k)
    const cut = startsOf(w.rig, 'ruler', 'b')[0]
    assert.ok(cut, 'the first run called the ruler')
    const again = w.relaunch()
    again.rig.script({ [RULER(3)]: [ruling('not_converging')] })
    const out = await again.run('b')
    assert.equal(out.outcome, 'stopped')
    assert.equal(out.review_rounds, 3)
    assert.equal(again.rig.calls.length, 1, "the relaunch's only call is the ruler's")
    const [call] = again.rig.calls
    assert.equal(call.role.name, 'ruler')
    assert.equal(call.dispatch, cut.dispatch)
    assert.equal(call.resume, true)
    assert.equal(call.thread.session, cut.thread.session)
    assert.equal(call.brief, renderMessage({ msg: 'cut_off' }))
    assert.deepEqual(ofKind(again.rig, 'escalated', 'b').map((e) => e.reason), ['review_not_converging'])
  })

  test('a ruling that returned before a kill is read back on relaunch, not asked again', T, async (t) => {
    const w = loopWorld(t, 4)
    w.rig.script({ [IMPL]: producerSteps(3), ...reviewSteps(THREE), [RULER(3)]: [ruling('converging')] })
    const k = killer()
    const around = async (call, real) => {
      const out = await real(call)
      if (call.role.name !== 'ruler') return out
      k.hit()
      return new Promise(() => {})
    }
    await cutOff(w.leg({ around }).run('b'), k)
    const again = w.relaunch()
    again.rig.script({ [IMPL]: [done()], [REV(4)]: [verdict({ fix: [fixed('F2')] })] })
    const out = await again.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 4)
    assert.equal(out.review_rounds, 4)
    assert.deepEqual(again.rig.calls.map((c) => c.role.name), ['implementer', 'reviewer'], 'the relaunch asks no ruler')
    assert.equal(ofKind(again.rig, 'dispatched', 'b').filter((e) => e.role === 'ruler').length, 1, 'one ruling dispatch for review round 3')
  })
})
