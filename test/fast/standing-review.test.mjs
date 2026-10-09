// test/fast/standing-review.test.mjs — an `outside` event voids a folder's standing integration
// review as a merge beneath it does.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { standingReview } from '../../lib/tree.mjs'

const NODES = new Map([['.', { seq: 1 }], ['c', { seq: 2 }], ['c/sub', { seq: 3 }], ['c/sub/x', { seq: 4 }], ['d', { seq: 5 }]])
const claims = (node, seq) => ({ kind: 'claims', node, seq, head_sha: 'h', review: 'done', claims: [] })
const outside = (node, seq) => ({ kind: 'outside', node, seq, execution: '', commits: ['a'.repeat(40)], by: 'user' })

test('an outside event on the folder after its review voids the review', () => {
  assert.equal(standingReview(NODES, [claims('c', 10), outside('c', 11)], 'c'), null)
})

test('an outside event beneath the folder after its review voids the review', () => {
  assert.equal(standingReview(NODES, [claims('c', 10), outside('c/sub', 11)], 'c'), null)
})

test('an outside event before the review leaves it standing', () => {
  const review = claims('c', 10)
  assert.equal(standingReview(NODES, [outside('c', 9), review], 'c'), review)
})

test("an outside event on a sibling or an ancestor leaves the folder's review standing", () => {
  const review = claims('c/sub', 10)
  assert.equal(standingReview(NODES, [review, outside('d', 11), outside('c', 12), outside('.', 13)], 'c/sub'), review)
})
