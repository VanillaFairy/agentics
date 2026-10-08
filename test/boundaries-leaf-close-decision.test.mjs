// test/boundaries-leaf-close-decision.test.mjs — lib/boundaries/leaf-close.mjs: the decision a
// measured round gets and the messages it records, over real git and the real measurement.
//
// What is pinned here:
//
//   leafClose        approval at the head, the go to review, the failures to the producer's thread,
//                    the cycle's test session, surviving mutations, an auditor's round, and
//                    `tests_ready`
//
// A close is never seeded by hand: every close record and every `breach_reverted` line comes from a
// `leafClose` call. Expected ids, shas, paths and keys are computed. The world builders the
// leaf-close files share are in test/harness/leaf-close-world.mjs.
//
// Design: docs/DESIGN.md#boundaries.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SLOW, commit, write, run, recs, msgs, observed, rec, head, DONE, A_FILES, tdd, R_SRC, TABLE, TABLE_TEST,
  CAPACITY_BITE, R_BITES, R_SURVIVES, cycle, answered,
} from './harness/leaf-close-world.mjs'

const TABLE_LABELLED = "export const table = () => ({ capacity: 1, label: 'x' })\n"

// ================================================================== the decision

describe('leaf-close and the decision', { concurrency: 4 }, () => {
  test('a leaf measured green with no review of its own is approved at its head, reviewed at integration', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
    const ok = recs(w, 'approved', 'a')
    assert.equal(ok.length, 1)
    assert.equal(ok[0].head_sha, head(o.worktree))
    assert.equal(ok[0].at_integration, true)
  })

  test('a leaf measured green with a review of its own goes to review, nothing recorded', SLOW, async (t) => {
    const { w, o } = tdd(t, { provides: [{ name: 'api', paths: ['src/a.mjs'] }] })
    commit(o.worktree, A_FILES, 'Add a')
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(out.decision.next, 'review', JSON.stringify(out.decision))
    assert.equal(recs(w, 'approved', 'a').length, 0)
    assert.equal(recs(w, 'message', 'a').length, 0)
  })

  test("a failing measurement records failures to the producer's thread for the next round", SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, { ...A_FILES, 'src/a.mjs': 'export const a = () => 2\n' }, 'Add a')
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(out.decision.next, 'fix', JSON.stringify(out.decision))
    assert.ok(out.decision.failures.length > 0)
    const sent = msgs(w, 'failures', 'a')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:a')
    assert.equal(sent[0].from, 'code')
    assert.equal(sent[0].round, 2)
    assert.equal(sent[0].payload.source, 'verification')
    assert.deepEqual(sent[0].payload.failures, out.decision.failures)
  })

  test("the failures of a green's test round that failed only on what it wrote go back to the cycle's test session", SLOW, async (t) => {
    const c = cycle(t, { greenLocus: ['src/r.mjs', 'src/table.mjs'], greenFiles: { 'src/r.mjs': R_SRC, 'src/table.mjs': TABLE_LABELLED } })
    write(c.green.worktree, { 'src/table.test.mjs': TABLE_TEST })
    const unbitten = { file: 'src/table.mjs', find: "label: 'x'", replace: "label: 'y'", expect_failing: ['src/table.test.mjs'] }
    const ret = { status: 'done', text: 'pinned', commit: 'Pin the capacity', mutations: [unbitten] }
    const { out } = await run(c.w, { node: 'g', role: 'test-author', round: 2, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: c.greenHead })
    assert.equal(out.decision.next, 'fix', JSON.stringify(out.decision))
    const sent = msgs(c.w, 'failures', 'g')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:r')
    assert.equal(sent[0].round, 3)
    assert.equal(sent[0].from, 'code')
  })

  test("an audit's surviving mutation records surviving_mutations to the cycle's test session", SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    const ret = { mutations: [R_SURVIVES], units: [], text: 'x + 2 doubles 2 too' }
    const { out } = await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret, base_sha: c.audit.base_sha })
    assert.equal(out.decision.next, 'fix', JSON.stringify(out.decision))
    const sent = msgs(c.w, 'surviving_mutations', 'au')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:r')
    assert.equal(sent[0].round, 2)
    assert.equal(sent[0].from, 'code')
    assert.ok(sent[0].payload.mutations.some((m) => m.file === R_SURVIVES.file && m.find === R_SURVIVES.find && m.replace === R_SURVIVES.replace))
    assert.equal(msgs(c.w, 'failures', 'au').length, 0)
  })

  test('an audit is measured on every mutation an earlier round applied', SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    const first = { mutations: [R_SURVIVES], units: [], text: 'x + 2 doubles 2 too' }
    await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret: first, base_sha: c.audit.base_sha })
    const easy = { file: 'src/r.mjs', find: '(x) =>', replace: '() =>', expect_failing: ['test/r.test.mjs'] }
    const { out } = await run(c.w, { node: 'au', role: 'test-author', round: 2, thread: 'producer:r', ret: { status: 'done', text: 'tried another', mutations: [easy] }, base_sha: c.audit.base_sha })
    assert.equal(out.decision.next, 'fix', 'the surviving mutation is still measured, so dropping it does not pass')
    const latest = observed(c.w, 'au').at(-1)
    const survivor = latest.mutations.find((m) => m.find === R_SURVIVES.find)
    assert.ok(survivor && survivor.applied && !survivor.bites, 'the earlier mutation is measured again and still gets through')
    assert.ok(latest.mutations.some((m) => m.find === easy.find), 'and so is the new one')
  })

  test("an auditor's round, whose return has no status, is measured and closes as done", SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    const ret = { mutations: [R_BITES], units: [], text: 'the net holds' }
    const { out } = await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret, base_sha: c.audit.base_sha })
    assert.equal(observed(c.w, 'au').length, 1, 'measured once')
    const line = observed(c.w, 'au')[0]
    assert.ok(line.mutations[0].applied && line.mutations[0].bites)
    assert.equal(recs(c.w, 'fault', 'au').length, 0)
    assert.equal(rec(c.w, 'au', 'auditor', 1).status, 'done')
    assert.equal(out.decision.next, 'review', JSON.stringify(out.decision))
  })

  /** A green's test round carrying `msg`, that adds a biting test. */
  async function testRoundAnswering(t, msg) {
    const c = cycle(t, { greenLocus: ['src/r.mjs', 'src/table.mjs'], greenFiles: { 'src/r.mjs': R_SRC, 'src/table.mjs': TABLE } })
    const seq = answered(c.w, { node: 'g', thread: 'producer:r', msg, payload: msg === 'needs_tests' ? { text: 'pin it' } : { findings: [] }, round: 3, from: msg === 'needs_tests' ? 'implementer' : 'code' })
    write(c.green.worktree, { 'src/table.test.mjs': TABLE_TEST })
    const ret = { status: 'done', text: 'pinned', commit: 'Pin the capacity', mutations: [CAPACITY_BITE] }
    const { out } = await run(c.w, { node: 'g', role: 'test-author', round: 3, thread: 'producer:r', ret, carries: [seq], base_sha: c.green.base_sha, head_before: c.greenHead })
    return { c, out }
  }

  test('a test round answering needs_tests, measured, records tests_ready with its test files to the implementer', SLOW, async (t) => {
    const { c, out } = await testRoundAnswering(t, 'needs_tests')
    assert.equal(rec(c.w, 'g', 'test-author', 3).answering, 'needs_tests')
    assert.equal(out.decision.next, 'review', JSON.stringify(out.decision))
    const ready = msgs(c.w, 'tests_ready', 'g')
    assert.equal(ready.length, 1)
    assert.equal(ready[0].thread, 'producer:g')
    assert.equal(ready[0].round, 4)
    assert.equal(ready[0].from, 'code')
    assert.deepEqual(ready[0].payload.files, ['src/table.test.mjs'])
  })

  test('a test round answering anything else records no tests_ready', SLOW, async (t) => {
    const { c } = await testRoundAnswering(t, 'findings')
    assert.equal(rec(c.w, 'g', 'test-author', 3).answering, 'findings')
    assert.equal(msgs(c.w, 'tests_ready', 'g').length, 0)
  })

  /** A leaf whose two criteria are decided by files the implementer commits. */
})
