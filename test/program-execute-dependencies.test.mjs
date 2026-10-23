// test/program-execute-dependencies.test.mjs — pins the execute program (lib/programs/execute.mjs)
// end to end: independent leaves end to end, dependencies, a cycle and what blocks a leaf, started
// through lib/run.mjs or called directly over the execution rig (real git, the real measurement, a
// scripted runner).
//
// What is pinned here:
//
//   the tick loop  independent leaves end to end, dependencies (a leaf, a composite), a tdd-pair
//                  cycle merged in one batch, escalations that block dependents and never
//                  siblings, a park that stops its own leaf, a folder the user wrote with nothing
//                  beneath it
//
// Every claim is read from the records (`executionLog(...).entries()`, `readTree(...).status`), the
// result and the calls the runner received. Expected values are computed: heads with `git
// rev-parse`, sessions with `sessionOf`, stamps with `stampNow`, tiers with `producerTier` and
// `tierFor`. Where the contract leaves a value open (a note's wording beyond its named start, a
// park's question beyond what the ruler gave) nothing here pins it. The execution rig and the specs
// the parts share are in test/harness/execute-program-world.mjs.
//
// Design: docs/DESIGN.md#execution, docs/DESIGN.md#scheduling.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { land } from '../lib/boundary.mjs'
import {
  T, E, leafEntry, subEffort, specText, done, said, REVIEW_EMPTY, claim, rootReview, IMPL, git, world, kinds,
  stateOf, statusOf, callsOf, startsOf, dispatchedOf, producerKey, rootHead, same, isAncestor, seqOfFirst,
  idsOf, assertComplete, chainSpec, folderSpecs, C_REVIEW,
} from './harness/execute-program-world.mjs'

// leaf-close, merge-batch and the suite gate measure through `node --test` grandchildren, which
// refuse to run under the test runner's marker; the rig does not clear it.
delete process.env.NODE_TEST_CONTEXT

/** A leaf reviewer's return that rules every unit a world here can produce clean. */
const UNITS = ['criterion:1', 'file:test/r.test.mjs', 'file:src/r.mjs']
const verdict = () => ({ output: { ...REVIEW_EMPTY, units: UNITS.map((unit) => ({ unit, ruling: 'clean', why: 'read it' })) } })

const REVIEWER = (id, n = 1) => `reviewer|${id}|reviewer:${id}:${n}`

const byId = (a, b) => (a.id < b.id ? -1 : 1)
/** The result's implemented entries as `[id, rigor, role, rounds, review_rounds, at_integration, salvaged]`. */
const implementedOf = (res) => [...res.implemented].sort(byId).map((i) => [i.id, i.rigor, i.role, i.rounds, i.review_rounds, i.at_integration, i.salvaged])

const R_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { r } from '../src/r.mjs'\ntest('doubles 2', () => assert.equal(r(2), 4))\n"
const R_SRC = 'export const r = (x) => x * 2\n'

// ================================================================== the tests

describe('the execute program', { concurrency: 4 }, () => {

  // ------------------------------------------------------------------ the tick loop

  test('two independent leaves run end to end: approved at integration, merged, the root reviewed and integrated, the execution closed, its land check clean', T, async (t) => {
    const w = world(t, { leaves: ['a', 'b'] })
    const { rig } = w
    w.script({ [IMPL('a')]: [done()], [IMPL('b')]: [done()] }, rootReview(1, claim('D1 holds')))
    const res = await w.run()

    assert.deepEqual(implementedOf(res), [['a', 'trivial', 'none', 1, 0, true, false], ['b', 'trivial', 'none', 1, 0, true, false]])
    assert.equal(statusOf(rig, 'a'), 'merged')
    assert.equal(statusOf(rig, 'b'), 'merged')
    const reviewers = callsOf(w, 'reviewer')
    assert.equal(reviewers.length, 1, 'one reviewer call')
    assert.equal(reviewers[0].node, '.')
    assert.equal(reviewers[0].thread.key, 'integration:.:1')
    assert.deepEqual(res.integration, { branch: rig.branchOf('.'), head_sha: rootHead(rig), reviews: [{ target: '.', said: reviewers[0].dispatch }] })
    assert.equal(statusOf(rig, '.'), 'integrated')
    assert.deepEqual(stateOf(rig).filter((e) => e.kind === 'closed').map((e) => e.status), ['done'], 'one closed {status: done}')
    assert.deepEqual([res.effort, res.root, res.execution, res.checkpoint, res.nodes_n], [E, '.', rig.stamp, null, 3])
    for (const list of ['escalations', 'parked', 'faults', 'blocked', 'drift']) assert.deepEqual(res[list], [], list)
    assert.equal(res.stopped, '')
    const remaining = ['a', 'b'].filter((id) => git(rig.repo, 'branch', '--list', rig.branchOf(id)) !== '')
    assert.deepEqual(remaining, ['a', 'b'], 'the fixture: both merged branches remain')
    assert.equal(res.cleanup_n, remaining.length)
    assertComplete(res)
    assert.deepEqual(res.coverage.incomplete, [])
    const check = land(rig.repo, E, 'check')
    assert.equal(check.ok, true, JSON.stringify(check.error))
    assert.equal(check.root_status, 'integrated')
    assert.deepEqual(check.open_escalations, [])
    assert.deepEqual(check.parked, [])
  })

  test('a dependency opens only after its provider merged', T, async (t) => {
    const w = world(t, { spec: chainSpec('a', 'b') })
    w.script({ [IMPL('a')]: [done()], [IMPL('b')]: [done()] }, rootReview(1, claim('D1 holds')))
    const res = await w.run()

    const mergedA = kinds(w.rig, 'merged', 'a')
    assert.equal(mergedA.length, 1)
    assert.ok(seqOfFirst(dispatchedOf(w.rig, 'b')) > mergedA[0].seq, 'b opened after a merged')
    assert.equal(statusOf(w.rig, 'b'), 'merged')
    assertComplete(res)
  })

  test('a dependency on a composite binds every leaf beneath it', T, async (t) => {
    const w = world(t, { spec: folderSpecs({ after: 'y' }) })
    w.script({ [IMPL('y')]: [done()], [IMPL('c/k')]: [done()] }, C_REVIEW, rootReview(1, claim('D1 holds'), claim('D2 holds')))
    const res = await w.run()

    const mergedY = kinds(w.rig, 'merged', 'y')
    assert.equal(mergedY.length, 1)
    const opened = dispatchedOf(w.rig, 'c/k')
    assert.equal(opened.length, 1)
    assert.ok(opened[0].seq > mergedY[0].seq, 'c/k opened after y merged')
    assertComplete(res)
  })

  test('a tdd-pair cycle: the red held on its approval, the green cut from it, the pair merged in one batch', T, async (t) => {
    const w = world(t, {
      spec: specText([
        leafEntry('r', { rigor: 'tdd-pair', role: 'red', expects: ['test/r.test.mjs'], check: 'node pass.mjs' }),
        leafEntry('g', { rigor: 'tdd-pair', role: 'green', after: 'r', expects: ['src/r.mjs'], check: 'node pass.mjs' }),
      ]),
    })
    const { rig } = w
    w.jobs['test-author|r#1'] = { 'test/r.test.mjs': R_TEST }
    w.jobs['implementer|g#1'] = { 'src/r.mjs': R_SRC }
    w.script({
      'test-author|r|producer:r': [done('red')], [REVIEWER('r')]: [verdict()],
      [IMPL('g')]: [done()], [REVIEWER('g')]: [verdict()],
    }, rootReview(1, claim('D1 holds')))
    const res = await w.run()

    const batches = kinds(rig, 'batch-started')
    assert.equal(batches.length, 1, 'one batch')
    assert.deepEqual(batches[0].children, ['r', 'g'])
    const merged = ['r', 'g'].map((id) => kinds(rig, 'merged', id))
    assert.deepEqual(merged.map((m) => m.length), [1, 1])
    assert.equal(merged[0][0].merged_sha, merged[1][0].merged_sha, 'both merged events share one merged_sha')
    const approvedG = kinds(rig, 'approved', 'g')
    const approvedR = kinds(rig, 'approved', 'r')
    assert.ok(merged[0][0].seq > approvedG[0].seq, 'the red merged after the green was approved')
    assert.ok(isAncestor(rig, approvedR[0].head_sha, approvedG[0].head_sha), 'the green was cut from the red\'s approved head')
    const [green] = startsOf(w, 'implementer', 'g')
    assert.ok(same(resolve(green.cwd), resolve(rig.worktreeOf('g'))), 'the green\'s call ran in g\'s worktree')
    const pairs = res.implemented.map((i) => [i.id, i.role, i.rounds, i.at_integration]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    assert.deepEqual(pairs, [['g', 'green', 1, false], ['r', 'red', 1, false]])
    assertComplete(res)
  })

  test('an escalation blocks its dependents, never its siblings, and a park stops only its own leaf', T, async (t) => {
    const w = world(t, { spec: specText([leafEntry('a'), leafEntry('b', { after: 'a' }), leafEntry('c'), leafEntry('d')]) })
    const { rig } = w
    w.script({ [IMPL('a')]: [said('blocked', 'a is stuck')], [IMPL('c')]: [said('needs_decision', 'which of the two?')], [IMPL('d')]: [done()] })
    const res = await w.run()

    assert.deepEqual(res.escalations, [{ id: 'a', reason: 'blocked', said: producerKey('a') }])
    assert.deepEqual(res.blocked, [{ blocked_by: 'a', leaves_n: 1 }])
    assert.equal(dispatchedOf(rig, 'b').length, 0, 'b never dispatched')
    assert.equal(callsOf(w, 'implementer', 'b').length, 0)
    assert.equal(statusOf(rig, 'd'), 'merged', 'the sibling merged')
    assert.deepEqual(idsOf(res.implemented), ['d'], 'and is the only one implemented')
    assert.deepEqual(res.parked, [{ id: 'c', return: 'needs_decision', said: producerKey('c') }])
    const lines = res.coverage.unreached
    const at = (line) => lines.indexOf(line)
    assert.ok(at('a: escalated — blocked') >= 0, JSON.stringify(lines))
    assert.ok(at('c: parked — needs_decision') >= 0, JSON.stringify(lines))
    assert.ok(at('1 leaf/leaves blocked — a did not land') >= 0, JSON.stringify(lines))
    assert.ok(at('a: escalated — blocked') < at('c: parked — needs_decision'), 'escalations lead the parks')
    assert.ok(at('c: parked — needs_decision') < at('1 leaf/leaves blocked — a did not land'), 'and the parks lead the blocked count')
    assert.ok(lines.findIndex((l) => /^\d+ of 4 leaves not merged/.test(l)) > at('1 leaf/leaves blocked — a did not land'), 'then the leaves not merged')
    assert.equal(res.coverage.complete, false)
  })

  test('a childless folder the user wrote parks needs_design and no planner runs', T, async (t) => {
    const w = world(t, {
      spec: specText([leafEntry('y'), subEffort('c', { realises: 'D2' })], { decisions: [['D1', 'y is there.'], ['D2', 'c is there.']] }),
    })
    w.script({ [IMPL('y')]: [done()] })
    const res = await w.run()

    const c = res.parked.find((p) => p.id === 'c')
    assert.ok(c, JSON.stringify(res.parked))
    assert.equal(c.return, 'needs_design')
    assert.equal(callsOf(w, 'planner').length, 0, 'no planner call')
    assert.deepEqual(w.calls.map((x) => x.role.name), ['implementer'], 'the leaf beside it is the only call')
    assert.equal(statusOf(w.rig, 'y'), 'merged')
    assert.equal(res.coverage.complete, false)
  })
})
