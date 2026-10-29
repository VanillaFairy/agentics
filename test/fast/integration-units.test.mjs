// test/fast/integration-units.test.mjs — pins what an integration review's rulings stand on: a
// decision moves with a merge that realises it, a claim with the head, `spec` with its text; and
// which of a finished review's rulings may stand at all.
//
// Design: docs/DESIGN.md#review-delta.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { integrationUnits, priorRulings } from '../../lib/boundaries/integration.mjs'
import { reviewDelta } from '../../lib/review-delta.mjs'

const at = ({ merges = [3], head = 'h1', specHash = 's1', claims = [] } = {}) => integrationUnits({
  decisions: [{ id: 'D1', text: 'keys are case blind', merges }, { id: 'D2', text: 'saves round-trip', merges: [4] }],
  files: ['src/a.mjs'], blobs: new Map([['src/a.mjs', 'blob-a']]), specHash, head, claims,
})
const anchorsOf = (units) => Object.fromEntries(units.map((u) => [u.unit, u.anchor]))

test('a decision is ruled again once a merge realising it lands, and only that decision', () => {
  const before = anchorsOf(at())
  const after = anchorsOf(at({ merges: [3, 9] }))
  assert.notEqual(after['decision:D1'], before['decision:D1'])
  assert.equal(after['decision:D2'], before['decision:D2'])
})

test('a claim of the last review is anchored to the head under review, and spec to its text hash', () => {
  const claims = [{ claim: 'a', ruling: 'met' }]
  assert.deepEqual([anchorsOf(at({ claims }))['claim:1'], anchorsOf(at({ claims, head: 'h2' }))['claim:1']], ['h1', 'h2'])
  assert.equal(anchorsOf(at({ specHash: 's9' })).spec, 's9')
})

test('a finished review leaves standing what it anchored and the claims it passed, at the head it judged', () => {
  const review = {
    head_sha: 'h1', anchors: { spec: 's1', 'file:src/a.mjs': 'blob-a' },
    claims: [{ claim: 'a', ruling: 'met' }, { claim: 'b', ruling: 'under' }, { claim: 'c', ruling: 'accepted' }, { claim: 'd', ruling: 'cant_tell' }],
  }
  const d = reviewDelta(priorRulings(review), at({ claims: review.claims }))
  assert.deepEqual(d.stand.map((s) => s.unit), ['file:src/a.mjs', 'spec', 'claim:1', 'claim:3'])
  assert.deepEqual(d.rule.map((r) => r.unit), ['decision:D1', 'decision:D2', 'claim:2', 'claim:4'], 'a claim not passed is ruled again, unmoved or not')
})

test('a review that kept no anchors leaves nothing standing', () => {
  assert.deepEqual(priorRulings({ head_sha: 'h1', claims: [{ claim: 'a', ruling: 'met' }] }), [])
  assert.deepEqual(priorRulings(null), [])
})
