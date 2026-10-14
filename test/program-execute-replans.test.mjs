// test/program-execute-replans.test.mjs — pins the execute program (lib/programs/execute.mjs) end
// to end: a moved base and the replans it asks for, started through lib/run.mjs or called directly
// over the execution rig (real git, the real measurement, a scripted runner).
//
// What is pinned here:
//
//   replans   a moved base is ruled before any leaf runs; an affected ruling goes to the planner (a
//             decision parks the folder, an unchanged leaf escalates, a fault holds the asking
//             leaf); a leaf's request goes to its planner folder with its slot given back; a stale
//             ruler that rejects holds its leaves
//
// Every claim is read from the records (`executionLog(...).entries()`, `readTree(...).status`), the
// result and the calls the runner received. Expected values are computed: heads with `git
// rev-parse`, sessions with `sessionOf`, stamps with `stampNow`, tiers with `producerTier` and
// `tierFor`. Where the contract leaves a value open (a note's wording beyond its named start, a
// park's question beyond what the ruler gave) nothing here pins it. The execution rig and the specs
// the parts share are in test/harness/execute-program-world.mjs.
//
// Design: docs/DESIGN.md#execution, docs/DESIGN.md#landing-and-drift.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { STANDING_AXES } from '../lib/briefs/probe.mjs'
import { sectionsOf, unitsOf } from '../lib/evidence.mjs'
import { heldBy } from '../lib/locks.mjs'
import { specPath } from '../lib/store.mjs'
import { closingTurn } from './harness/navigator.mjs'
import {
  T, E, leafEntry, subEffort, specText, done, said, failed, ruling, rulings, claim, staleRuler, rootReview,
  IMPL, world, entriesOf, kinds, statusOf, callsOf, dispatchedOf, seqOfFirst, moveBase, assertComplete,
} from './harness/execute-program-world.mjs'

// leaf-close, merge-batch and the suite gate measure through `node --test` grandchildren, which
// refuse to run under the test runner's marker; the rig does not clear it.
delete process.env.NODE_TEST_CONTEXT

/** A planner folder's spec: no decision of its own, its leaves realise the root's D1. */
const plannerSpec = (...entries) => specText(entries, { decisions: [], title: 'Build p' })

/** The planner folder world: the root holds `p` (planner-written, ground known) and the leaf `q`; `p` holds the leaf `x`. */
function plannerWorld(t, over = {}) {
  return world(t, {
    spec: {
      '.': specText([subEffort('p', { planner: true }), leafEntry('q')]),
      p: plannerSpec(leafEntry('x')),
    },
    ...over,
  })
}

// A planner's write is played in the runAgent wrapper by writing p's spec; its probe round is scripted as test/execute-folder.test.mjs scripts it.
const putSpec = (rig, folder, text) => {
  mkdirSync(dirname(specPath(rig.repo, E, folder)), { recursive: true })
  writeFileSync(specPath(rig.repo, E, folder), text)
}
const STANDING = STANDING_AXES.map((a) => a.key)
const cleanProber = (units) => ({
  findings: [], units: units.map((unit) => ({ unit, ruling: 'clean', ids: [], why: 'why ' + unit })), notes: '', stop_reason: 'exhausted', not_reached: '',
})
/** Probe round `n` over `text` for folder `p`: a locate turn that ends every ask, and one prober that rules every unit clean. */
const probing = (n, text) => ({
  ['scout||probe:p:' + n + '/locate']: [closingTurn(['guidance', ...sectionsOf(text).map((s) => 'ground:' + s.slug)])],
  ['analyst||probe:p:' + n + '/prober:1']: [{ output: cleanProber(unitsOf(STANDING, sectionsOf(text))) }],
})
const PLANNER = 'planner|p|planner:p'

// ================================================================== the tests

describe('the execute program', { concurrency: 4 }, () => {

  // ------------------------------------------------------------------ a moved base and replans

  test('a moved base is ruled before any leaf runs', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const { rig } = w
    const head = moveBase(rig, 'src/a.txt')
    w.script(staleRuler(head, rulings(ruling('a', 'unaffected', 'the base change is elsewhere'))), { [IMPL('a')]: [done()] }, rootReview(1, claim('D1 holds')))
    const res = await w.run()

    assert.equal(w.calls[0].role.name, 'ruler', 'the first call is the ruler\'s')
    assert.ok(seqOfFirst(dispatchedOf(rig, '.', 'ruler')) < seqOfFirst(dispatchedOf(rig, 'a')), 'its dispatched is before a\'s')
    assert.deepEqual(kinds(rig, 'stale-ruled').map((r) => [r.node, r.base_now, r.ruling]), [['a', head, 'unaffected']])
    assertComplete(res)
  })

  test("a leaf ruled affected on a moved base goes to its planner with the ruler's question; a planner that needs a decision parks its folder, the leaf waits and the rest runs", T, async (t) => {
    const w = plannerWorld(t)
    const { rig } = w
    const Q = 'Does p/x still hold on the new base?'
    const head = moveBase(rig, 'src/x.txt')
    w.script(
      staleRuler(head, rulings(ruling('p/x', 'affected', 'x\'s file moved', Q))),
      { [PLANNER]: [said('needs_decision', 'Which reading is meant?')], [IMPL('q')]: [done()] },
      rootReview(1, claim('D1 holds')),
    )
    const res = await w.run()

    const planners = callsOf(w, 'planner')
    assert.equal(planners.length, 1, 'one planner call')
    assert.equal(planners[0].thread.key, 'planner:p')
    assert.ok(planners[0].brief.includes(Q), 'its brief holds the question')
    assert.deepEqual(res.parked, [{ id: 'p', return: 'needs_decision', said: planners[0].dispatch }])
    assert.equal(dispatchedOf(rig, 'p/x').length, 0, 'p/x never dispatched')
    assert.equal(statusOf(rig, 'q'), 'merged', 'the rest runs')
    assert.deepEqual(kinds(rig, 'stale-ruled').map((r) => [r.node, r.ruling]), [['p/x', 'affected']])
  })

  test('a moved premise the planner answers without changing the leaf escalates replan_not_converging, and the leaf never runs', T, async (t) => {
    const w = plannerWorld(t)
    const { rig } = w
    const head = moveBase(rig, 'src/x.txt')
    const untouched = plannerSpec(leafEntry('x')).replace('Files under src.', 'Files under src, and a paragraph that answers nothing about x.')
    w.jobs['planner|p#1'] = () => putSpec(rig, 'p', untouched)
    w.script(
      staleRuler(head, rulings(ruling('p/x', 'affected', 'x\'s file moved', 'Does p/x still hold?'))),
      { [PLANNER]: [{ output: { status: 'written', text: '' } }], [IMPL('q')]: [done()] },
      probing(1, untouched),
      rootReview(1, claim('D1 holds')),
    )
    const res = await w.run()

    assert.deepEqual(res.escalations, [{ id: 'p/x', reason: 'replan_not_converging', said: '' }])
    assert.equal(dispatchedOf(rig, 'p/x').length, 0, 'p/x never dispatched')
    assert.equal(statusOf(rig, 'q'), 'merged')
  })

  test('a replan a fault ended holds the asking leaf, and its ruling stays unanswered for the next run', T, async (t) => {
    const w = plannerWorld(t)
    const { rig } = w
    const head = moveBase(rig, 'src/x.txt')
    w.script(
      staleRuler(head, rulings(ruling('p/x', 'affected', 'x\'s file moved', 'Does p/x still hold?'))),
      { [PLANNER]: [failed('host_error')], [IMPL('q')]: [done()] },
      rootReview(1, claim('D1 holds')),
    )
    const res = await w.run()

    assert.deepEqual(res.faults.map((f) => [f.id, f.channel]).sort(), [['p', 'host_error'], ['p/x', 'program']])
    assert.deepEqual(res.parked, [], 'no park')
    const ruled = kinds(rig, 'stale-ruled')
    assert.deepEqual(ruled.map((r) => [r.node, r.ruling]), [['p/x', 'affected']])
    const after = entriesOf(rig).filter((e) => e.seq > ruled[0].seq && e.node === 'p/x' && ['parked', 'escalated', 'replanned'].includes(e.kind))
    assert.deepEqual(after, [], 'nothing answers the ruling on p/x')
    assert.equal(dispatchedOf(rig, 'p/x').length, 0, 'p/x never dispatched')
    assert.equal(statusOf(rig, 'q'), 'merged')
  })

  test('a stale ruler that rejects holds every leaf it was to rule on a program fault', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const { rig } = w
    moveBase(rig, 'src/a.txt')
    w.script({ [IMPL('a')]: [done()] })
    w.before.push((call) => { if (call.role.name === 'ruler') throw new Error('the runner threw on the ruler') })
    const res = await w.run()

    assert.deepEqual(res.faults.map((f) => [f.id, f.channel]), [['a', 'program']])
    assert.equal(dispatchedOf(rig, 'a').length, 0, 'a never dispatched')
    assert.equal(callsOf(w, 'implementer').length, 0)
    assert.equal(res.coverage.complete, false)
  })

  test("a leaf's request goes to its planner folder, its slot given back, and it does not run again until its plan revises it", T, async (t) => {
    const w = plannerWorld(t)
    const { rig } = w
    const ASK = 'which format does the folder want?'
    w.script(
      { [IMPL('p/x')]: [said('needs_context', ASK)], [PLANNER]: [said('needs_decision', 'Which format?')], [IMPL('q')]: [done()] },
      rootReview(1, claim('D1 holds')),
    )
    const slotsAtPlanner = []
    w.before.push((call) => { if (call.role.name === 'planner') slotsAtPlanner.push(heldBy(rig.repo).slots.map((s) => s.node)) })
    const res = await w.run()

    const planners = callsOf(w, 'planner')
    assert.equal(planners.length, 1)
    const sent = kinds(rig, 'message').filter((e) => e.thread === 'planner:p' && e.msg === 'needs_context')
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].payload, { node: 'p/x', text: ASK })
    assert.deepEqual(planners[0].carries, [sent[0].seq], 'the planner\'s call carries exactly the needs_context message')
    assert.equal(slotsAtPlanner.length, 1)
    assert.ok(!slotsAtPlanner[0].includes('p/x'), 'no slot names p/x when the planner is called: ' + JSON.stringify(slotsAtPlanner[0]))
    assert.equal(dispatchedOf(rig, 'p/x').length, 1, 'p/x dispatched once')
    assert.deepEqual(res.parked, [{ id: 'p', return: 'needs_decision', said: planners[0].dispatch }])
  })
})
