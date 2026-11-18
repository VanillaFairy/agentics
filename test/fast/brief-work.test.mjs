// test/fast/brief-work.test.mjs — which moves of a leaf brief ask new work of its producer
// (`workMoved`): a part the run fills, such as the worktree a cycle's test round works in, asks none.
//
// Design: docs/DESIGN.md#executors-and-review.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { workMoved } from '../../lib/brief.mjs'

test('a brief whose entry parts moved asks new work; one whose run parts alone moved asks none', () => {
  const before = { Task: 't1', 'Expected files and reads': 'e1', Worktree: 'w1', Commands: 'c1' }
  assert.deepEqual(workMoved(before, { ...before, Worktree: 'w2', Commands: 'c2' }), [])
  assert.deepEqual(workMoved(before, { ...before, Task: 't2', Worktree: 'w2' }), ['Task'])
  assert.deepEqual(workMoved(before, { ...before, 'Spec Design': 's1' }), ['Spec Design'], 'a part the brief newly holds moved')
})
