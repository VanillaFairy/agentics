// test/execute-leaf-retry-measure.test.mjs — pins what the leaf unit (`runLeaf`) does with a retry of
// a stopped leaf whose branch holds work: the branch is measured as it stands, and a producer goes
// on only from failures measured at its head.
//
// What is pinned here:
//
//   retry        a stopped leaf with work on its branch is measured before any producer goes on,
//                after a change of its criteria or with its brief unchanged: approved when the
//                work passes, a fix round with the failures when it does not
//
// Design: docs/DESIGN.md#resume-and-checkpoints.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { recordApproval } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { append } from '../lib/ledger.mjs'
import { ROOT_ID, specPath } from '../lib/store.mjs'
import {
  T, E, bLeaf, specText, work, world, ofKind, startsOf, headOf, approvals, faultsOf, IMPL, done, said,
} from './harness/execute-leaf-world.mjs'

// The rig does not clear NODE_TEST_CONTEXT, and a measurement's nested `node --test` that inherits
// it reports to this runner and exits 0, so every red or tdd test file would read as passing.
delete process.env.NODE_TEST_CONTEXT

/** What the session's `retry` writes. */
function retry(w) {
  const wrote = append(w.rig.repo, E, 'events', [{ kind: 'replanned', node: 'b', execution: w.rig.stamp, reason: 'retry_escalated', by: 'session' }])
  assert.equal(wrote.ok, true, JSON.stringify(wrote))
}

/** The spec edited so b's criterion checks `check`, approved and compiled, as a re-spec leaves it. */
function respec(w, check) {
  writeFileSync(specPath(w.rig.repo, E, ROOT_ID), specText([bLeaf({ check })]))
  const approved = recordApproval(w.rig.repo, E, ROOT_ID)
  assert.equal(approved.ok, true, JSON.stringify(approved))
  const compiled = compileEffort(w.rig.repo, E)
  assert.equal(compiled.ok, true, JSON.stringify(compiled))
}

const escalations = (w) => ofKind(w.rig, 'escalated', 'b')

describe('a retry over work', { concurrency: 4 }, () => {
  test('a retry after the criteria changed measures the work as it stands: approved, and no producer goes on', T, async (t) => {
    const w = world(t, { leaves: [bLeaf({ check: 'node check.mjs b2' })] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [done(), done('nothing to change')] })
    assert.equal((await w.run('b')).outcome, 'stopped')
    assert.deepEqual(escalations(w).map((e) => e.reason), ['fix_without_commits'])
    respec(w, 'node check.mjs b')
    retry(w)
    const again = await w.run('b')
    assert.equal(again.outcome, 'approved', JSON.stringify(escalations(w)))
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 2, 'no producer round after the retry')
    assert.deepEqual(approvals(w.rig).map((e) => e.head_sha), [headOf(w.rig)])
    assert.equal(faultsOf(w.rig).length, 0)
  })

  test('a retry with the brief unchanged measures the work a stopped round left: approved, and no producer goes on', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [said('blocked', 'git rm was denied')] })
    assert.equal((await w.run('b')).outcome, 'stopped')
    const at = headOf(w.rig)
    retry(w)
    const again = await w.run('b')
    assert.equal(again.outcome, 'approved', JSON.stringify(escalations(w)))
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 1, 'the round that stopped is the only producer round')
    assert.deepEqual(approvals(w.rig).map((e) => e.head_sha), [at])
  })

  test('a retry whose work still fails sends a producer the failures, and one that returns them unmoved escalates again', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'no\n' }, 'make b'))
    w.rig.script({ [IMPL]: [said('blocked', 'git rm was denied'), done('the work is there')] })
    assert.equal((await w.run('b')).outcome, 'stopped')
    retry(w)
    const again = await w.run('b')
    assert.equal(again.outcome, 'stopped')
    const [, two] = startsOf(w.rig, 'implementer', 'b')
    assert.equal(two.round, 2)
    const carried = ofKind(w.rig, 'message', 'b').filter((m) => two.carries.includes(m.seq)).map((m) => m.msg)
    assert.deepEqual(carried.sort(), ['failures', 'retried'])
    assert.deepEqual(escalations(w).map((e) => e.reason), ['blocked', 'fix_without_commits'])
    assert.equal(approvals(w.rig).length, 0)
  })
})
