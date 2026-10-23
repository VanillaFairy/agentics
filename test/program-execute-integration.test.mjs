// test/program-execute-integration.test.mjs — pins the execute program (lib/programs/execute.mjs)
// end to end: the merge of a leaf, a lost review, a checkout fault and drift, started through
// lib/run.mjs or called directly over the execution rig (real git, the real measurement, a scripted
// runner).
//
// What is pinned here:
//
//   integration   a leaf failing alone on the merged head gets its fix round, a resumed approval
//                 merges the head it approved, a lost review, a checkout fault and a rejecting
//                 unit hold their node; drift is ruled before its consumer starts, and a consumer
//                 ruled affected under a folder the user wrote parks needs_respec
//
// Every claim is read from the records (`executionLog(...).entries()`, `readTree(...).status`), the
// result and the calls the runner received. Expected values are computed: heads with `git
// rev-parse`, sessions with `sessionOf`, stamps with `stampNow`, tiers with `producerTier` and
// `tierFor`. Where the contract leaves a value open (a note's wording beyond its named start, a
// park's question beyond what the ruler gave) nothing here pins it. The execution rig and the specs
// the parts share are in test/harness/execute-program-world.mjs.
//
// Design: docs/DESIGN.md#execution, docs/DESIGN.md#landing-and-drift, docs/DESIGN.md#coverage-block.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureLeaf } from '../lib/integration.mjs'
import {
  T, E, leafEntry, specText, done, failed, ruling, rulings, claim, rootReview, IMPL, git, work, until, world,
  kinds, stateOf, statusOf, callsOf, startsOf, dispatchedOf, producerKey, rootHead, isAncestor,
  assertComplete,
} from './harness/execute-program-world.mjs'

// leaf-close, merge-batch and the suite gate measure through `node --test` grandchildren, which
// refuse to run under the test runner's marker; the rig does not clear it.
delete process.env.NODE_TEST_CONTEXT

/** Steps for every key starting with `prefix` (a computed thread name). */
const byPrefix = (prefix, ...steps) => new Proxy({}, { get: (_, key) => (String(key).startsWith(prefix) ? steps : undefined) })
const driftRuler = (...steps) => byPrefix('ruler|.|ruler:drift:', ...steps)

/**
 * The drift world: `p` provides `api (src/api/)` and merged before the run, `q` writes under src/api/
 * without providing it, `s` is a sibling, `c` (after p and q) consumes `api`.
 */
function driftWorld(t, over = {}) {
  const w = world(t, {
    spec: specText([
      leafEntry('p', { provides: 'api (src/api/)', words: ['api', 'p'] }),
      leafEntry('q', { words: ['api', 'q'] }),
      leafEntry('s'),
      leafEntry('c', { after: 'p, q', consumes: 'api' }),
    ]),
    ...over,
  })
  const wt = w.rig.worktreeOf('.')
  const sha = work(wt, { 'src/api/p.txt': 'ok\n' }, 'Add p')
  w.rig.log.append('merged', { node: 'p', into: w.rig.branchOf('.'), merged_sha: sha, head_sha: sha })
  w.jobs['implementer|q#1'] = { 'src/api/q.txt': 'ok\n' }
  return w
}

const ADD_OK = 'export const add = (a, b) => a + b\n'
const ADD_BAD = 'export const add = (a, b) => a - b\n'

// ================================================================== the tests

describe('the execute program', { concurrency: 4 }, () => {

  // ------------------------------------------------------------------ integration

  test('a leaf failing alone on the merged head gets its fix round, its failures delivered, and merges', T, async (t) => {
    const w = world(t, { spec: specText([leafEntry('a', { expects: ['src/a.txt', 'src/add.mjs'] })]) })
    const { rig } = w
    w.jobs['implementer|a#1'] = { 'src/a.txt': 'ok\n', 'src/add.mjs': ADD_BAD }
    w.jobs['implementer|a#2'] = { 'src/add.mjs': ADD_OK }
    w.script({ [IMPL('a')]: [done(), done()] }, rootReview(1, claim('D1 holds')))
    const res = await w.run()

    assert.deepEqual(dispatchedOf(rig, 'a').map((e) => e.round), [1, 2], 'rounds 1 and 2')
    const sent = kinds(rig, 'message', 'a').filter((e) => e.msg === 'failures')
    assert.equal(sent.length, 1, 'one failures message')
    assert.equal(sent[0].payload.source, 'integration')
    const [one, two] = startsOf(w, 'implementer', 'a')
    assert.equal(two.round, 2)
    assert.equal(two.resume, true)
    assert.equal(two.thread.session, one.thread.session, 'round 2 resumes the session')
    assert.deepEqual(two.carries, [sent[0].seq], 'and carries exactly that message')
    assert.equal(kinds(rig, 'merged', 'a').length, 1, 'one merged')
    assert.deepEqual(res.implemented.map((i) => [i.id, i.rounds]), [['a', 2]])
    assertComplete(res)
  })

  test('a resumed approval merges the head it approved, not the branch as it stands', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const { rig } = w
    const open = ensureLeaf(rig.repo, E, 'a', { from: rootHead(rig), parentBranch: rig.branchOf('.') })
    assert.equal(open.ok, true, open.error)
    rig.log.append('dispatched', { node: 'a', dispatch: producerKey('a'), round: 1, thread: 'producer:a', role: 'implementer' })
    const approvedSha = work(open.worktree, { 'src/a.txt': 'ok\n' }, 'Make a')
    rig.log.append('approved', { node: 'a', head_sha: approvedSha, review_rounds: 0, at_integration: true })
    const laterSha = work(open.worktree, { 'src/a.txt': 'later\n' }, 'A change after the approval')
    w.script(rootReview(1, claim('D1 holds')))
    const res = await w.run()

    assert.equal(callsOf(w, 'implementer').length, 0, 'no producer call')
    assert.equal(isAncestor(rig, approvedSha, rig.branchOf('.')), true, 'the root holds the approved head')
    assert.equal(isAncestor(rig, laterSha, rig.branchOf('.')), false, 'and not the later one')
    assertComplete(res)
  })

  test('a lost integration review is a failed channel, and the review is not launched again in the run', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    w.script({ [IMPL('a')]: [done()], 'reviewer|.|integration:.:1': [failed('host_error')] })
    const res = await w.run()

    assert.equal(callsOf(w, 'reviewer').length, 1, 'one reviewer call')
    assert.deepEqual(res.faults.map((f) => [f.id, f.channel]), [['.', 'host_error']])
    assert.ok(res.coverage.failed_channels.includes('integration-review'), JSON.stringify(res.coverage.failed_channels))
    assert.ok(res.coverage.unreached.includes('. is not integrated: reviewing'), JSON.stringify(res.coverage.unreached))
    assert.deepEqual(res.integration.reviews, [])
    assert.equal(res.coverage.complete, false)
  })

  test('a merge held on a checkout fault is not launched again in the run', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const { rig } = w
    w.script({ [IMPL('a')]: [done()] })
    // The user's checkout moves while the merge measures: a branch made once the batch has started.
    let moved = false
    const timer = setInterval(() => {
      if (!moved && stateOf(rig).some((e) => e.kind === 'batch-started')) {
        moved = true
        git(rig.repo, 'branch', 'side')
      }
    }, 5)
    let res
    try {
      res = await w.run()
    } finally {
      clearInterval(timer)
    }

    assert.equal(moved, true, 'the fixture: the checkout moved')
    assert.equal(kinds(rig, 'batch-started').length, 1, 'one batch')
    assert.deepEqual(res.faults.map((f) => [f.id, f.channel]), [['.', 'checkout']])
    assert.equal(statusOf(rig, 'a'), 'approved')
    assert.equal(callsOf(w, 'reviewer').length, 0, 'no reviewer call')
    assert.equal(res.coverage.complete, false)
  })

  test('a unit that rejects is a program fault on its node, and the run ends with it held', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    w.script({ [IMPL('a')]: [done()] })
    w.before.push((call) => {
      if (call.role.name === 'reviewer' && call.node === '.') throw new Error('the runner threw on the root\'s reviewer')
    })
    const res = await w.run()

    assert.deepEqual(res.faults.map((f) => [f.id, f.channel]), [['.', 'program']])
    assert.ok(res.notes.some((n) => n.startsWith('review:. threw')), JSON.stringify(res.notes))
    assert.equal(statusOf(w.rig, '.'), 'reviewing')
    assert.equal(res.coverage.complete, false)
  })

  // ------------------------------------------------------------------ drift

  test('a consumer is not launched while the merge that drifted it is being ruled', T, async (t) => {
    const w = driftWorld(t)
    const { rig } = w
    w.script(
      { [IMPL('q')]: [done()], [IMPL('s')]: [done()], [IMPL('c')]: [done()] },
      driftRuler(rulings(ruling('c', 'unaffected', 'the api is the same'))),
      rootReview(1, claim('D1 holds')),
    )
    // s ends only once the merge of q is under way, and q's ruler answers only once s is approved:
    // the ticks s's end wakes see c ready on disk while the merge that drifted it is still out.
    w.before.push(async (call) => {
      if (call.role.name === 'implementer' && call.node === 's') await until(() => stateOf(rig).some((e) => e.kind === 'batch-started'), 'the merge of q starts')
      if (call.role.name === 'ruler') await until(() => kinds(rig, 'approved', 's').length > 0, 's is approved')
    })
    const res = await w.run()

    const ruled = kinds(rig, 'drift-ruled')
    assert.deepEqual(ruled.map((r) => [r.node, r.contract, r.ruling]), [['c', 'api', 'unaffected']])
    assert.ok(kinds(rig, 'approved', 's')[0].seq < ruled[0].seq, 's was approved before the ruling')
    const opened = dispatchedOf(rig, 'c')
    assert.equal(opened.length, 1)
    assert.ok(opened[0].seq > ruled[0].seq, 'c opened only after the ruling')
    assert.deepEqual(res.drift, [{ node: 'c', contract: 'api' }])
    assertComplete(res)
  })

  test("a drifted consumer ruled affected under a folder the user wrote parks needs_respec with the ruler's question", T, async (t) => {
    const w = driftWorld(t)
    const { rig } = w
    const Q = 'Does c still read the api as it was?'
    w.script({ [IMPL('q')]: [done()], [IMPL('s')]: [done()] }, driftRuler(rulings(ruling('c', 'affected', 'the api changed', Q))))
    const res = await w.run()

    const ruled = kinds(rig, 'drift-ruled')
    assert.deepEqual(ruled.map((r) => [r.node, r.contract, r.ruling]), [['c', 'api', 'affected']])
    assert.deepEqual(res.parked, [{ id: 'c', return: 'needs_respec', said: ruled[0].said }])
    const parks = kinds(rig, 'parked', 'c')
    assert.equal(parks.length, 1)
    assert.ok(String(parks[0].question).includes(Q), 'the ruler\'s question: ' + parks[0].question)
    assert.equal(dispatchedOf(rig, 'c').length, 0, 'c never dispatched')
    assert.equal(callsOf(w, 'planner').length, 0, 'no planner call')
  })
})
