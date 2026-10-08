// test/boundaries-leaf-close-breach.test.mjs — lib/boundaries/leaf-close.mjs: a path outside the
// locus reverted, and what the reverted head decides, over real git and the real measurement.
//
// What is pinned here:
//
//   leafClose        the revert in a commit of its own and `breach_reverted`, the head before the
//                    revert measured as well as the head after it, a breach whose reverted head
//                    still passes, and `needs_locus` to the user's folder or the planner
//
// A close is never seeded by hand: every close record and every `breach_reverted` line comes from a
// `leafClose` call. Expected ids, shas, paths and keys are computed. The world builders the
// leaf-close files share are in test/harness/leaf-close-world.mjs.
//
// Design: docs/DESIGN.md#boundaries.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { git } from './harness/boundary-fixture.mjs'
import { SLOW, recs, observed, rec, head, subjectOf, outside } from './harness/leaf-close-world.mjs'

// ================================================================== the locus

describe('leaf-close and the locus', { concurrency: 4 }, () => {
  test('a path outside the locus is reverted in a commit of its own and recorded breach_reverted', SLOW, async (t) => {
    const s = await outside(t)
    const tip = head(s.o.worktree)
    assert.equal(subjectOf(s.o.worktree), 'agentics: revert outside locus')
    assert.equal(git(s.o.worktree, 'show', 'HEAD:README.md'), git(s.o.worktree, 'show', s.o.base_sha + ':README.md'), 'the file is back to its base content')
    assert.equal(git(s.o.worktree, 'show', 'HEAD:src/a.mjs'), git(s.o.worktree, 'show', s.pre + ':src/a.mjs'), 'the work inside the locus stays')
    const reverted = recs(s.w, 'breach_reverted', 'a')
    assert.equal(reverted.length, 1)
    assert.deepEqual(reverted[0].paths, ['README.md'])
    assert.equal(reverted[0].sha, tip)
    const record = rec(s.w, 'a', 'implementer', 1)
    assert.deepEqual(record.breach.paths, ['README.md'])
    assert.equal(record.breach.sha, tip)
  })

  test('the head before the revert is measured as well as the head after it', SLOW, async (t) => {
    const s = await outside(t)
    const lines = observed(s.w, 'a')
    assert.ok(lines.some((l) => l.head_sha === s.pre), 'the head before the revert was measured')
    assert.ok(lines.some((l) => l.head_sha === head(s.o.worktree)), 'the reverted head was measured')
    assert.equal(rec(s.w, 'a', 'implementer', 1).breach.pre_sha, s.pre)
  })

  test('a breach whose reverted head still passes is no route: the leaf is decided on the reverted head', SLOW, async (t) => {
    const s = await outside(t)
    assert.equal(s.first.decision.next, 'approve', JSON.stringify(s.first.decision))
    assert.equal(s.first.route, undefined)
    assert.equal(recs(s.w, 'parked', 'a').length, 0)
    assert.deepEqual(recs(s.w, 'approved', 'a').map((e) => e.head_sha), [head(s.o.worktree)])
  })

  test('needs_locus parks the leaf needs_respec when the head before the revert passed and the reverted one fails, under a folder the user wrote', SLOW, async (t) => {
    const s = await outside(t, { helper: true })
    assert.deepEqual([s.first.decision.next, s.first.decision.reason], ['stop', 'needs_respec'])
    const parks = recs(s.w, 'parked', 'a')
    assert.equal(parks.length, 1)
    assert.equal(parks[0].return, 'needs_respec')
    assert.ok(parks[0].question.includes('src/helper.mjs'), 'the question names the helper')
    assert.equal(rec(s.w, 'a', 'implementer', 1).breach.pre_passed, true)
    assert.equal(s.first.route, undefined)
  })

  test("needs_locus goes to the folder's planner when the head before the revert passed and the reverted one fails, under a planner's folder", SLOW, async (t) => {
    const s = await outside(t, { helper: true, under: 'planner' })
    assert.equal(s.first.decision.next, 'route')
    assert.equal(s.first.route.to, 'planner')
    assert.equal(s.first.route.folder, 'c')
    assert.equal(s.first.route.request.node, 'c/a')
    assert.equal(s.first.route.request.status, 'needs_locus')
    assert.deepEqual(s.first.route.request.paths, ['src/helper.mjs'])
    assert.equal(recs(s.w, 'parked', 'c/a').length, 0)
  })

  test('no needs_locus when the head before the revert failed as well', SLOW, async (t) => {
    const s = await outside(t, { failing: true })
    assert.equal(s.first.decision.next, 'fix', JSON.stringify(s.first.decision))
    assert.equal(rec(s.w, 'a', 'implementer', 1).breach.pre_passed, false)
    assert.equal(recs(s.w, 'parked', 'a').length, 0)
    assert.equal(s.first.route, undefined)
  })
})
