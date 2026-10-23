// test/boundaries-leaf-close-roles.test.mjs — lib/boundaries/leaf-close.mjs: what a round's role
// may write, over real git and the real measurement.
//
// What is pinned here:
//
//   leafClose        a shell-less author's files its role may write committed and journalled
//                    `authored`, the rest left out and put back; a leaf's work outside what it
//                    expects measured as it stands; a green implementer's test a blocking
//                    role-breach; a test round beside a cycle source; and a close that never
//                    commits outside a linked worktree
//
// A close is never seeded by hand: every close record comes from a `leafClose` call. Expected ids, shas, paths and keys are computed. The world builders the
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
  ADD_BITE, lf, testsOnly, R_TEST, R_SRC, TABLE, TABLE_TEST, CAPACITY_BITE, R_BITES, cycle,
} from './harness/leaf-close-world.mjs'

const filesOf = (worktree, sha) => git(worktree, 'show', '--name-only', '--format=', sha).split('\n').filter(Boolean)

const R_TEST_TWO = R_TEST + "test('doubles 3', () => assert.equal(r(3), 6))\n"

// ================================================================== the role rules

describe('leaf-close and the role rules', { concurrency: 4 }, () => {
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

  test("a tests-only author's non-test files are left out of its commit and put back, with no commit of their own", SLOW, async (t) => {
    const { w, o } = testsOnly(t)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST, 'stray.txt': 'oops\n' })
    const ret = { status: 'done', text: 'Cases: adds negatives.', commit: 'Test add with negatives', mutations: [ADD_BITE] }
    await run(w, { node: 't', role: 'test-author', round: 1, ret, base_sha: o.base_sha })
    const authored = recs(w, 'authored', 't')
    assert.equal(authored.length, 1)
    assert.deepEqual(filesOf(o.worktree, authored[0].sha), ['test/more.test.mjs'], 'the stray file is not in the authored commit')
    assert.equal(existsSync(join(o.worktree, 'stray.txt')), false)
    assert.equal(head(o.worktree), authored[0].sha, 'the authored commit is the head: nothing is reverted')
  })

  test('a leaf that changes files it does not expect is measured as it stands', SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { expects: ['src/a.mjs'] }), lf('b', { rigor: 'tests-only', expects: ['test/extra.test.mjs'] })])
    const o = open(w, 'a')
    commit(o.worktree, { ...A_FILES, 'test/extra.test.mjs': A_TEST, 'docs/a.md': 'a\n' }, 'Add a')
    const tip = head(o.worktree)
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(head(o.worktree), tip, 'nothing is reverted')
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
  })

  test("a green implementer's committed test file is a blocking role-breach", SLOW, async (t) => {
    const c = cycle(t, { greenFiles: { 'src/r.mjs': R_SRC, 'src/extra.test.mjs': "import { test } from 'node:test'\ntest('extra', () => {})\n" } })
    const { out } = await run(c.w, { node: 'g', role: 'implementer', round: 1, ret: DONE, base_sha: c.green.base_sha, head_before: c.green.base_sha })
    const line = observed(c.w, 'g').find((l) => l.head_sha === head(c.green.worktree))
    assert.ok((line.series_findings || []).some((f) => f.check === 'role-breach' && f.blocking && f.message.includes('src/extra.test.mjs')), JSON.stringify(line.series_findings))
    assert.equal(out.decision.next, 'fix', JSON.stringify(out.decision))
  })

  test('a test round commits a new test beside a cycle source and never the source', SLOW, async (t) => {
    const c = cycle(t, { greenExpects: ['src/r.mjs', 'src/table.mjs'], greenFiles: { 'src/r.mjs': R_SRC, 'src/table.mjs': TABLE } })
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
