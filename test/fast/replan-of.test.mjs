// test/fast/replan-of.test.mjs — lib/programs/execute/folder.mjs `replanOf`: every request a leaf
// routes to its planner must revise that leaf, so a planner that leaves it as it was is recorded as a
// stop, never left for the next run to replay into nothing.
//
// Design: docs/DESIGN.md#execution.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { replanOf } from '../../lib/programs/execute/folder.mjs'

test('a verify finding a leaf routed holds the planner to revising that leaf, as every request of a leaf does; a folder\'s own request does not', () => {
  const leaf = { kind: 'leaf', seq: 7 }
  for (const status of ['verify_finding', 'needs_context', 'premise_mismatch']) {
    assert.deepEqual(replanOf({ node: 'p/v', status }, leaf), { node: 'p/v', rev: leaf.seq }, status)
  }
  assert.equal(replanOf({ node: 'p', status: 'premise_mismatch' }, { kind: 'composite', seq: 3 }), null)
  assert.equal(replanOf(null, null), null)
})
