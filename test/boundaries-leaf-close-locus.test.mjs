// test/boundaries-leaf-close-locus.test.mjs — lib/boundaries/leaf-close.mjs: a shell-less author's
// commit and the files a close admits to a locus, over real git and the real measurement.
//
// What is pinned here:
//
//   leafClose        a shell-less author's admitted files committed and journalled `authored`,
//                    the files outside its locus left out and taken out, a new test file inside
//                    or outside the locus, a test round beside a cycle source, a close run again
//                    over stray files, and a close that never commits outside a linked worktree
//
// A close is never seeded by hand: every close record and every `breach_reverted` line comes from a
// `leafClose` call. Expected ids, shas, paths and keys are computed. The world builders the
// leaf-close files share are in test/harness/leaf-close-world.mjs.
//
// Design: docs/DESIGN.md#boundaries.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { A_TEST, git, root } from './harness/boundary-fixture.mjs'
import {
  SLOW, world, open, commit, write, run, recs, observed, rec, head, subjectOf, DONE, A_FILES, MORE_TEST,
  ADD_BITE, lf, tdd, testsOnly, R_TEST, R_SRC, TABLE, TABLE_TEST, CAPACITY_BITE, R_BITES, cycle,
} from './harness/leaf-close-world.mjs'

const filesOf = (worktree, sha) => git(worktree, 'show', '--name-only', '--format=', sha).split('\n').filter(Boolean)

const R_TEST_TWO = R_TEST + "test('doubles 3', () => assert.equal(r(3), 6))\n"

// ================================================================== the locus

describe('leaf-close and the locus', { concurrency: 4 }, () => {
  test("a shell-less author's admitted files are committed and journalled authored", SLOW, async (t) => {
    const { w, o } = testsOnly(t)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST })
    const ret = { status: 'done', text: 'Cases: adds negatives.', commit: 'Test add with negatives', mutations: [ADD_BITE] }
    const { out } = await run(w, { node: 't', role: 'test-author', round: 1, ret, base_sha: o.base_sha })
    const tip = head(o.worktree)
    assert.equal(subjectOf(o.worktree), 'Test add with negatives')
    assert.deepEqual(filesOf(o.worktree, tip), ['test/more.test.mjs'])
    assert.equal(git(o.worktree, 'rev-list', '--count', o.base_sha + '..HEAD'), '1')
    const authored = recs(w, 'authored', 't')
    assert.equal(authored.length, 1)
    assert.deepEqual([authored[0].role, authored[0].round, authored[0].sha], ['test-author', 1, tip])
    assert.equal(rec(w, 't', 'test-author', 1).committed, tip)
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
    assert.deepEqual(recs(w, 'approved', 't').map((e) => e.head_sha), [tip])
  })

  test('a shell-less author whose locus is a directory has the files under it committed, none reverted', SLOW, async (t) => {
    const { w, o } = testsOnly(t, ['test/'])
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST })
    const ret = { status: 'done', text: 'Cases: adds negatives.', commit: 'Test add with negatives', mutations: [ADD_BITE] }
    const { out } = await run(w, { node: 't', role: 'test-author', round: 1, ret, base_sha: o.base_sha })
    assert.deepEqual(filesOf(o.worktree, head(o.worktree)), ['test/more.test.mjs'])
    assert.equal(recs(w, 'breach_reverted', 't').length, 0)
    assert.equal(rec(w, 't', 'test-author', 1).breach, null)
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
  })

  test("a shell-less author's files outside its locus are left out of its commit and taken out", SLOW, async (t) => {
    const { w, o } = testsOnly(t)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST, 'stray.txt': 'oops\n' })
    const ret = { status: 'done', text: 'Cases: adds negatives.', commit: 'Test add with negatives', mutations: [ADD_BITE] }
    await run(w, { node: 't', role: 'test-author', round: 1, ret, base_sha: o.base_sha })
    const authored = recs(w, 'authored', 't')
    assert.equal(authored.length, 1)
    assert.deepEqual(filesOf(o.worktree, authored[0].sha), ['test/more.test.mjs'], 'the stray file is not in the authored commit')
    assert.equal(existsSync(join(o.worktree, 'stray.txt')), false)
    assert.equal(git(o.worktree, 'ls-files', 'stray.txt'), '')
    const reverted = recs(w, 'breach_reverted', 't')
    assert.equal(reverted.length, 1)
    assert.deepEqual(reverted[0].paths, ['stray.txt'])
    const record = rec(w, 't', 'test-author', 1)
    assert.deepEqual(record.breach.paths, ['stray.txt'])
    assert.equal(record.breach.sha, reverted[0].sha)
    assert.equal(reverted[0].sha, head(o.worktree), 'the revert commit is the head')
  })

  test('a new test file another unmerged leaf holds is outside the locus and reverted', SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] }), lf('b', { rigor: 'tests-only', locus: ['test/extra.test.mjs'] })])
    const o = open(w, 'a')
    commit(o.worktree, { ...A_FILES, 'test/extra.test.mjs': A_TEST }, 'Add a')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    const reverted = recs(w, 'breach_reverted', 'a')
    assert.equal(reverted.length, 1)
    assert.ok(reverted[0].paths.includes('test/extra.test.mjs'))
  })

  test('a new test file beside a listed file nobody else holds is inside the locus', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, { ...A_FILES, 'test/extra.test.mjs': A_TEST }, 'Add a')
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(recs(w, 'breach_reverted', 'a').length, 0)
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
  })

  test("a green implementer's new test file is outside its locus and reverted", SLOW, async (t) => {
    const c = cycle(t, { greenFiles: { 'src/r.mjs': R_SRC, 'src/extra.test.mjs': "import { test } from 'node:test'\ntest('extra', () => {})\n" } })
    await run(c.w, { node: 'g', role: 'implementer', round: 1, ret: DONE, base_sha: c.green.base_sha, head_before: c.green.base_sha })
    const reverted = recs(c.w, 'breach_reverted', 'g')
    assert.equal(reverted.length, 1)
    assert.ok(reverted[0].paths.includes('src/extra.test.mjs'))
  })

  test('a test round commits a new test beside a cycle source and never the source', SLOW, async (t) => {
    const c = cycle(t, { greenLocus: ['src/r.mjs', 'src/table.mjs'], greenFiles: { 'src/r.mjs': R_SRC, 'src/table.mjs': TABLE } })
    write(c.green.worktree, { 'src/table.test.mjs': TABLE_TEST, 'src/table.mjs': 'export const table = () => ({ capacity: 9 })\n' })
    const ret = { status: 'done', text: 'pinned', commit: 'Pin the capacity', mutations: [CAPACITY_BITE] }
    const { out } = await run(c.w, { node: 'g', role: 'test-author', round: 2, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: c.greenHead })
    const authored = recs(c.w, 'authored', 'g')
    assert.equal(authored.length, 1)
    assert.deepEqual(filesOf(c.green.worktree, authored[0].sha), ['src/table.test.mjs'], 'the authored commit holds only the test')
    assert.equal(git(c.green.worktree, 'show', 'HEAD:src/table.mjs'), git(c.green.worktree, 'show', c.greenHead + ':src/table.mjs'), 'the source at the head is the green\'s')
    const line = observed(c.w, 'g').find((l) => l.head_sha === head(c.green.worktree))
    assert.ok(line, 'the head was measured')
    assert.deepEqual((line.series_findings || []).filter((f) => f.blocking), [])
    assert.equal(out.decision.next, 'review', JSON.stringify(out.decision))
  })

  test('a close run again after it took the stray files into a commit of their own takes them out as before', SLOW, async (t) => {
    const c = cycle(t, { greenLocus: ['src/r.mjs', 'src/table.mjs'], greenFiles: { 'src/r.mjs': R_SRC, 'src/table.mjs': TABLE } })
    commit(c.green.worktree, { 'src/table.mjs': 'export const table = () => ({ capacity: 9 })\n' }, 'agentics: outside locus')
    const ret = { status: 'done', text: 'nothing to add', mutations: [R_BITES] }
    await run(c.w, { node: 'g', role: 'test-author', round: 2, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: c.greenHead })
    assert.equal(subjectOf(c.green.worktree), 'agentics: revert outside locus')
    assert.equal(git(c.green.worktree, 'show', 'HEAD:src/table.mjs'), git(c.green.worktree, 'show', c.greenHead + ':src/table.mjs'), 'the source is the green\'s again')
    assert.ok(rec(c.w, 'g', 'test-author', 2).breach.paths.includes('src/table.mjs'))
  })

  test("a test round after the red's approval is measured against the red's approved tests", SLOW, async (t) => {
    const c = cycle(t, { redTest: R_TEST_TWO })
    write(c.green.worktree, { 'test/r.test.mjs': R_TEST })
    const ret = { status: 'done', text: 'trimmed', commit: 'Drop a case', mutations: [R_BITES] }
    const { out } = await run(c.w, { node: 'g', role: 'test-author', round: 2, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: c.greenHead })
    const line = observed(c.w, 'g').find((l) => l.head_sha === head(c.green.worktree))
    assert.ok(line, 'the head was measured')
    assert.ok((line.series_findings || []).some((f) => f.check === 'test-removed' && f.blocking), JSON.stringify(line.series_findings))
    assert.equal(out.decision.next, 'fix')
  })

  test('leaf-close never commits outside a linked worktree', SLOW, async (t) => {
    const { w, o } = testsOnly(t)
    // The worktree path exists but is no registered worktree: git -C would resolve to the user's repository.
    rmSync(o.worktree, { recursive: true, force: true })
    git(w.r, 'worktree', 'prune')
    mkdirSync(o.worktree, { recursive: true })
    writeFileSync(join(w.r, 'staged.txt'), "the user's staged work\n")
    git(w.r, 'add', 'staged.txt')
    const userHead = git(w.r, 'rev-parse', 'HEAD')
    const ret = { status: 'done', text: 'Cases.', commit: 'Test it', mutations: [ADD_BITE] }
    const { out } = await run(w, { node: 't', role: 'test-author', round: 1, ret, base_sha: userHead })
    assert.ok(out && out.decision, 'the close still decides')
    assert.equal(git(w.r, 'rev-parse', 'HEAD'), userHead, "the user's branch did not move")
    assert.equal(git(w.r, 'diff', '--cached', '--name-only'), 'staged.txt', "the user's staged work is still staged")
    assert.equal(recs(w, 'authored', 't').length, 0)
    const record = rec(w, 't', 'test-author', 1)
    assert.ok(Array.isArray(record.notes) && record.notes.length > 0, 'a note says why nothing was committed')
  })
})
