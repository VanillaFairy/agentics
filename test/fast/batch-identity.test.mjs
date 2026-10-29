// test/fast/batch-identity.test.mjs — batchIdentity in lib/boundaries/merge.mjs: what makes two
// merge-batches the same question, so the second reads the first's outcome back.
//
// What is pinned here:
//
//   batchIdentity  the same target, start head, unit heads and clearings are one identity; a moved
//                  head, another unit head, or the user's word on the target or a child is another;
//                  a node outside the batch moves nothing
//
// Design: docs/DESIGN.md#merging.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { batchIdentity } from '../../lib/boundaries/merge.mjs'
import { liveNodes } from '../../lib/tree.mjs'

const leaf = (id) => ({ id, kind: 'leaf', title: 'do ' + id, rigor: 'trivial' })
const NODES = liveNodes([{ id: '.', kind: 'composite', title: 'root' }, leaf('a'), leaf('b'), leaf('c')].map((node, i) => ({ kind: 'node', node, seq: i + 1 })))
const retry = (node, seq) => ({ kind: 'replanned', node, reason: 'retry_escalated', by: 'session', seq })

test('a batch is the same question exactly while its start, its unit heads and its nodes\' clearings are', () => {
  const ask = { target: '.', pre: 'P0', heads: ['A1', 'B1'], children: ['a', 'b'] }
  const id = batchIdentity({ nodes: NODES, events: [] }, ask)
  assert.equal(batchIdentity({ nodes: NODES, events: [] }, { ...ask, children: ['b', 'a'] }), id, 'the children as a set')
  assert.notEqual(batchIdentity({ nodes: NODES, events: [] }, { ...ask, pre: 'P1' }), id, 'the target moved')
  assert.notEqual(batchIdentity({ nodes: NODES, events: [] }, { ...ask, heads: ['A2', 'B1'] }), id, 'a unit moved')
  assert.notEqual(batchIdentity({ nodes: NODES, events: [retry('a', 9)] }, ask), id, "the user's word on a child")
  assert.notEqual(batchIdentity({ nodes: NODES, events: [retry('.', 9)] }, ask), id, "the user's word on the target")
  assert.equal(batchIdentity({ nodes: NODES, events: [retry('c', 9)] }, ask), id, 'a node outside the batch')
})
