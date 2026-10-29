// test/fast/replan-of.test.mjs — lib/programs/execute/folder.mjs `replanOf`: what a planner's answer
// to a request a leaf routed must change. A request about the leaf itself must revise it; a verify
// finding may be answered by the spec alone, so it carries the spec hash the answer started from,
// and an answer that changes neither is recorded as a stop, never left for the next run to replay.
//
// Design: docs/DESIGN.md#replanning.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { replanOf } from '../../lib/programs/execute/folder.mjs'

test('a request about the leaf holds the planner to revising it; a verify finding to changing the leaf or the spec; a folder\'s own request to nothing', () => {
  const leaf = { kind: 'leaf', seq: 7 }
  for (const status of ['needs_context', 'decompose', 'unsplittable', 'premise_mismatch']) {
    assert.deepEqual(replanOf({ node: 'p/v', status }, leaf, 'h1'), { node: 'p/v', rev: leaf.seq }, status)
  }
  assert.deepEqual(replanOf({ node: 'p/v', status: 'verify_finding' }, leaf, 'h1'), { node: 'p/v', rev: leaf.seq, from: 'h1' })
  assert.equal(replanOf({ node: 'p', status: 'premise_mismatch' }, { kind: 'composite', seq: 3 }, 'h1'), null)
  assert.equal(replanOf(null, null), null)
})
