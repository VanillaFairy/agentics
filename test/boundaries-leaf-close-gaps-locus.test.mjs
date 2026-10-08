// test/boundaries-leaf-close-gaps-locus.test.mjs — lib/boundaries/leaf-close.mjs where the other
// boundaries-leaf-close files leave a path open: the measurement before a revert and the locus a
// close admits.
//
// What is pinned here:
//
//   G4   the measurement before a revert is never read as the round's
//   G13  locus admission
//   G14  the pre-revert measurement's own outcomes
//
// Every close here is a `leafClose` call over real git and the real measurement; expected ids,
// shas, paths and keys are computed. The world builders the parts share are in
// test/harness/leaf-close-gaps-world.mjs.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#verification.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { A_TEST, root } from './harness/boundary-fixture.mjs'
import {
  SLOW, REVERT, scenario, world, open, write, commit, auditor, stored, close, run, recs, msgs, observed, rec,
  head, subjectsOver, holds, DONE, A_FILES, MORE_TEST, ADD_BITE, lfNode, testsOnly, R_SRC, R_BITES, cycle,
  outside,
} from './harness/leaf-close-gaps-world.mjs'

// ================================================================== G4

describe('G4: the measurement before a revert is never read as the round\'s', { concurrency: 2 }, () => {
  const GONE = { file: 'src/extra.mjs', find: 'x = 1', replace: 'x = 2', expect_failing: ['test/more.test.mjs'] }

  const tests = scenario(async (t) => {
    const { w, o } = testsOnly(t)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST, 'src/extra.mjs': 'export const x = 1\n' })
    await run(w, { node: 't', role: 'test-author', round: 1, ret: { status: 'done', text: 'one', commit: 'Test add', mutations: [ADD_BITE, GONE] }, base_sha: o.base_sha })
    const afterOne = head(o.worktree)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST + '// again\n' })
    const { out } = await run(w, { node: 't', role: 'test-author', round: 2, ret: { status: 'done', text: 'two', commit: 'Test add again', mutations: [ADD_BITE] }, base_sha: o.base_sha, head_before: afterOne })
    return { w, o, out }
  })
  after(() => tests.end())

  test('G4.1 the next round does not apply a mutation the pre-revert measurement applied, and the close approves', SLOW, async () => {
    const { w, o, out } = await tests.get()
    const line = observed(w, 't').find((l) => l.head_sha === head(o.worktree))
    assert.ok(line, 'the round measured its head')
    assert.deepEqual(line.mutations.filter((m) => m.file === GONE.file), [])
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
  })

  test('G4.2 an audit failures go to the round thread when only the pre-revert measurement let a mutation through, however often the close is run', SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    write(c.audit.worktree, { 'src/extra.mjs': 'export const x = 1\n' })
    const unseen = { ...GONE, expect_failing: ['test/r.test.mjs'] }
    const spec = { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret: auditor([unseen]), base_sha: c.audit.base_sha, head_before: c.audit.base_sha }
    const dispatch = stored(c.w, spec)
    const first = await close(c.w, { ...spec, dispatch })
    assert.equal(first.decision.next, 'fix', JSON.stringify(first.decision))
    await close(c.w, { ...spec, dispatch })
    assert.deepEqual(msgs(c.w, 'failures', 'au').map((m) => m.thread), ['producer:au'])
    assert.deepEqual(msgs(c.w, 'surviving_mutations', 'au'), [])
  })
})

// ================================================================== G13

describe('G13: locus admission', { concurrency: 2 }, () => {
  test('G13.1 a green locus that shares a path with its red keeps the green implementer committed edit to it', SLOW, async (t) => {
    const c = cycle(t, { redLocus: ['test/r.test.mjs', 'src/shared.mjs'], greenLocus: ['src/r.mjs', 'src/shared.mjs'], greenFiles: { 'src/r.mjs': R_SRC, 'src/shared.mjs': 'export const shared = 1\n' } })
    await run(c.w, { node: 'g', role: 'implementer', round: 1, ret: DONE, base_sha: c.green.base_sha, head_before: c.green.base_sha })
    assert.equal(holds(c.green.worktree, 'HEAD:src/shared.mjs'), true)
    assert.deepEqual(recs(c.w, 'breach_reverted', 'g'), [])
  })

  test('G13.2 a new test file beside a listed file that only a merged leaf lists is inside the locus and kept', SLOW, async (t) => {
    const w = world(t, [root(), lfNode('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] }), lfNode('b', { rigor: 'tests-only', locus: ['test/extra.test.mjs'] })])
    w.xc.log.append('merged', { node: 'b' })
    const o = open(w, 'a')
    commit(o.worktree, { ...A_FILES, 'test/extra.test.mjs': A_TEST }, 'Add a')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(holds(o.worktree, 'HEAD:test/extra.test.mjs'), true)
    assert.deepEqual(recs(w, 'breach_reverted', 'a'), [])
  })

  test('G13.3 an auditor new test file is outside its locus and taken out', SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    write(c.audit.worktree, { 'docs/notes.test.mjs': A_TEST })
    await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret: auditor([R_BITES]), base_sha: c.audit.base_sha, head_before: c.audit.base_sha })
    assert.equal(existsSync(join(c.audit.worktree, 'docs/notes.test.mjs')), false)
    assert.ok(recs(c.w, 'breach_reverted', 'au').some((e) => e.paths.includes('docs/notes.test.mjs')))
  })

  test('G13.4 a path committed outside the locus and also modified uncommitted is named once', SLOW, async (t) => {
    const s = await outside(t, { uncommitted: { 'README.md': 'hello\nedited again\n' } })
    const reverted = recs(s.w, 'breach_reverted', 'a')
    assert.equal(reverted.length, 1)
    assert.deepEqual(reverted[0].paths, ['README.md'])
    assert.deepEqual(rec(s.w, 'a', 'implementer', 1).breach.paths, ['README.md'])
  })
})

// ================================================================== G14

describe('G14: the pre-revert measurement\'s own outcomes', { concurrency: 2 }, () => {
  const countdown = (first) => {
    let calls = 0
    return { before: () => { calls++; if (calls === 1 && first === 'unreadable') throw new Error('unreadable'); return {} }, after: () => ({ moved: calls === 1 && first === 'moved' ? [{ ref: 'refs/heads/main' }] : [] }) }
  }

  test('G14.1 the checkout moving during the pre-revert measurement is a checkout fault that stops the close before the revert', SLOW, async (t) => {
    const s = await outside(t, { ports: { watch: countdown('moved') } })
    assert.deepEqual([s.first.decision.next, s.first.decision.reason], ['stop', 'checkout'])
    assert.equal(recs(s.w, 'fault', 'a').filter((f) => f.channel === 'checkout').length, 1)
    assert.ok(!subjectsOver(s.o.worktree, s.o.base_sha).includes(REVERT))
  })

  test('G14.2 a watch that cannot read the checkout during the pre-revert measurement is a checkout fault', SLOW, async (t) => {
    const s = await outside(t, { ports: { watch: countdown('unreadable') } })
    assert.equal(recs(s.w, 'fault', 'a').filter((f) => f.channel === 'checkout').length, 1)
    assert.ok(!subjectsOver(s.o.worktree, s.o.base_sha).includes(REVERT))
  })

  test('G14.3 a reverted measurement that could not be taken after a pre-revert head that passed escalates by its error kind, with no park and no route', SLOW, async (t) => {
    let calls = 0
    const ports = { spawn: (cmd, args, opts) => (++calls === 2 ? spawn(process.execPath, ['-e', 'process.exit(3)'], opts) : spawn(cmd, args, opts)) }
    const s = await outside(t, { ports })
    assert.equal(calls, 2, 'the head before the revert and the reverted head were each measured once')
    assert.deepEqual([s.first.decision.next, s.first.decision.reason], ['stop', 'measure_failed'])
    assert.deepEqual(recs(s.w, 'parked', 'a'), [])
    assert.equal(s.first.route, undefined)
  })
})
