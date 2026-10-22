// test/fast/standing-review.test.mjs — an `outside` event voids a folder's standing integration
// review as a merge beneath it does; a review voided only by the folder's own change can be ruled
// again over its head (`rerulableReview`); a park an integration review raised is cleared by a
// later review of the folder and by nothing else.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deriveStatus, liveNodes, rerulableReview, standingReview } from '../../lib/tree.mjs'

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

// ------------------------------------------------------------------ rerulableReview

const revised = (seq) => new Map([['.', { seq: 1 }], ['c', { seq }], ['c/sub', { seq: 3 }], ['c/sub/x', { seq: 4 }]])
const replanned = (node, seq) => ({ kind: 'replanned', node, seq, execution: '', reason: 'answered' })
const merged = (node, seq) => ({ kind: 'merged', node, seq, execution: '', head_sha: 'h' })

test("a review voided only by the folder's revision or replan is the one to rule again", () => {
  const review = claims('c', 10)
  assert.equal(rerulableReview(revised(20), [review], 'c'), review, 'a revision newer than the review')
  assert.equal(rerulableReview(NODES, [review, replanned('c', 11)], 'c'), review, 'a replan on the folder')
})

test('a merge beneath the folder or an outside event on it leaves nothing to rule again: the head moved', () => {
  const review = claims('c', 10)
  const cleared = replanned('c', 11)
  assert.equal(rerulableReview(NODES, [review, cleared, merged('c/sub/x', 12)], 'c'), null)
  assert.equal(rerulableReview(NODES, [review, cleared, outside('c', 12)], 'c'), null)
  assert.equal(rerulableReview(NODES, [review, cleared, outside('c/sub', 12)], 'c'), null)
  assert.equal(rerulableReview(revised(20), [review, merged('c/sub', 12)], 'c'), null)
})

test('a review that stands, one not earned, a replan beneath the folder and none at all leave nothing to rule again', () => {
  const review = claims('c', 10)
  assert.equal(rerulableReview(NODES, [review], 'c'), null, 'it stands')
  assert.equal(rerulableReview(NODES, [review, replanned('c/sub', 11)], 'c'), null, "a replan below is not the folder's own")
  assert.equal(rerulableReview(revised(20), [{ ...review, review: 'not_earned' }], 'c'), null, 'nothing was judged')
  assert.equal(rerulableReview(revised(20), [], 'c'), null)
})

// ------------------------------------------------------------------ a park an integration review raised

const TREE = [{ id: '.', kind: 'composite', title: 'root' }, { id: 'c', kind: 'composite', title: 'c' }, { id: 'c/x', kind: 'leaf', title: 'x', rigor: 'tdd', locus: ['src/x.mjs'] }]
const statusOf = (events, id = 'c') => {
  const nodes = liveNodes(TREE.map((node, i) => ({ kind: 'node', node, seq: i + 1 })))
  return deriveStatus(nodes, events.map((e) => ({ execution: '', ...e }))).get(id)
}
const review = (seq, said, extra = {}) => ({ kind: 'claims', node: 'c', seq, head_sha: 'h', review: 'done', said, claims: [{ claim: 'k', ruling: 'under' }], ...extra })
const park = (seq, ret, said) => ({ kind: 'parked', node: 'c', seq, return: ret, question: 'q', ...(said ? { said } : {}) })
const MERGED = merged('c/x', 10)

test('a claims event after the park an integration review raised clears it, and the newer review stands', () => {
  const held = [MERGED, review(11, 'r1'), park(12, 'integration_critical', 'r1')]
  assert.equal(statusOf(held).status, 'parked')
  const now = statusOf([...held, review(13, 'r1', { by: 'session' })])
  assert.equal(now.status, 'integrated')
  assert.equal(now.review, 'done')
  assert.equal(statusOf([...held, review(13, 'r2')]).status, 'integrated', 'a new review, whoever dispatched it')
})

test("a claims event leaves a park it did not raise: a spec_changed or a contract_drift stays", () => {
  const events = [MERGED, review(11, 'r1'), park(12, 'spec_changed'), review(13, 'r2')]
  assert.equal(statusOf(events).status, 'parked', 'a park with no said')
  assert.equal(statusOf([MERGED, review(11, 'r1'), park(12, 'contract_drift', 'ruler.r9'), review(13, 'r2')]).status, 'parked', 'a park of another dispatch')
})

test('the park a later review raises stands until a review after it', () => {
  const events = [MERGED, review(11, 'r1'), park(12, 'integration_critical', 'r1'), review(13, 'r2'), park(14, 'integration_critical', 'r2')]
  assert.equal(statusOf(events).status, 'parked')
  assert.equal(statusOf([...events, review(15, 'r2')]).status, 'integrated')
})
