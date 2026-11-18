// test/execute-leaf-respec.test.mjs — pins that a leaf rewritten after its approval goes back to its
// producer when the work its brief asks moved: the producer's thread is resumed with
// `brief_changed`. A replan that leaves the work as it was is reviewed again, never produced again.
//
// The rig, the scripted answers and the worlds are in test/harness/execute-leaf-world.mjs.
//
// Design: docs/DESIGN.md#executors-and-review.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { append } from '../lib/ledger.mjs'
import { T, E, YARD, bLeaf, work, world, messages, startsOf, approvals, nodeOf, IMPL, REV, done, verdict } from './harness/execute-leaf-world.mjs'

delete process.env.NODE_TEST_CONTEXT

/** What a compile that rewrote leaf `b` writes: its new revision (`change`, none for a replan alone), then its `replanned`. */
function recompile(w, change) {
  if (change) assert.equal(append(w.rig.repo, E, 'nodes', [{ kind: 'node', node: { ...nodeOf(w.rig), ...change } }]).ok, true)
  assert.equal(append(w.rig.repo, E, 'events', [{ kind: 'replanned', node: 'b', execution: '', reason: 'compiled', by: 'compile' }]).ok, true)
}

function approvedWorld(t) {
  const w = world(t, { leaves: [bLeaf(YARD)] })
  w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'round 1'))
  w.job('implementer|b#2', (cwd) => work(cwd, { 'src/b2.txt': 'the new ask\n' }, 'round 2'))
  w.rig.script({ [IMPL]: [done(), done()], [REV(1)]: [verdict()], [REV(2)]: [verdict()] })
  return w
}

describe('a leaf rewritten after its approval', { concurrency: 2 }, () => {
  test('whose work moved goes back to its producer, told what changed', T, async (t) => {
    const w = approvedWorld(t)
    assert.equal((await w.run('b')).outcome, 'approved')
    recompile(w, { context: 'Also write src/b2.txt.' })
    const again = await w.run('b')
    assert.equal(again.outcome, 'approved')
    const rounds = startsOf(w.rig, 'implementer', 'b')
    assert.deepEqual(rounds.map((c) => c.round), [1, 2], 'the producer is dispatched again')
    const changed = messages(w.rig, 'producer:b', 'brief_changed')
    assert.equal(changed.length, 1)
    assert.ok(changed[0].payload.changed.includes('Task'), 'the changed part is named')
    assert.ok(rounds[1].carries.includes(changed[0].seq), 'the resumed round carries it')
    assert.equal(approvals(w.rig).length, 2)
  })

  test('whose work stayed is reviewed again and never produced again', T, async (t) => {
    const w = approvedWorld(t)
    assert.equal((await w.run('b')).outcome, 'approved')
    recompile(w, null)
    assert.equal((await w.run('b')).outcome, 'approved')
    assert.deepEqual(startsOf(w.rig, 'implementer', 'b').map((c) => c.round), [1])
    assert.equal(startsOf(w.rig, 'reviewer', 'b').length, 2)
    assert.equal(messages(w.rig, 'producer:b', 'brief_changed').length, 0)
  })
})
