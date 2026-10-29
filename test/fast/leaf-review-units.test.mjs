// test/fast/leaf-review-units.test.mjs — the leaf review's pure parts: the units a reviewer is
// handed (`reviewUnits`), and what the verdict reads of an open set (`unruledUnit`,
// `greenRoundRole`). One review round over real git is test/boundaries-leaf-review.test.mjs.
//
// Design: docs/DESIGN.md#executors-and-review and docs/DESIGN.md#review-returns.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { reviewUnits } from '../../lib/boundaries/leaf-review.mjs'
import { reviewDelta } from '../../lib/review-delta.mjs'
import { greenRoundRole, unruledUnit } from '../../lib/verdict.mjs'

const finding = (id, extra = {}) => ({
  id, severity: 'critical', claim: 'claim ' + id, evidence: 'evidence ' + id, failure_scenario: 'fails when ' + id, ...extra,
})

test('reviewUnits names each criterion from 1, each changed file, each failing approved case, in that order', () => {
  const two = { acceptance: [{ text: 'first' }, { text: 'second' }] }
  const units = reviewUnits(two, {
    head: 'h1', changed: ['src/a.mjs', 'src/b.mjs'], blobs: new Map([['src/a.mjs', 'blob-a']]),
    approved_failing: [{ file: 'test/a.test.mjs', id: 'adds one' }],
  })
  assert.deepEqual(units.map((u) => u.unit), [
    'criterion:1', 'criterion:2', 'file:src/a.mjs', 'file:src/b.mjs', 'approved-case:test/a.test.mjs#adds one',
  ])
  assert.deepEqual(units.slice(2, 4).map((u) => u.anchor), ['blob-a', 'deleted'], 'a file is anchored to its blob at the head')
  // An option left out is an empty list.
  assert.deepEqual(reviewUnits(two, {}).map((u) => u.unit), ['criterion:1', 'criterion:2'])
})

test('reviewUnits of a leaf with no criteria, no changed file and no failing case is empty', () => {
  assert.deepEqual(reviewUnits({ acceptance: [] }, { changed: [], approved_failing: [] }), [])
  assert.deepEqual(reviewUnits({ acceptance: [] }, {}), [])
})

test('a criterion and a failing case stand only at the head they were ruled at; a file wherever its blob is the same', () => {
  const leafOf = { acceptance: [{ text: 'first' }] }
  const at = (head, blob) => reviewUnits(leafOf, { head, changed: ['src/a.mjs'], blobs: new Map([['src/a.mjs', blob]]), approved_failing: [{ file: 't.mjs', id: 'x' }] })
  const prior = at('h1', 'blob-a').map((u) => ({ ...u, ruling: 'clean' }))
  assert.deepEqual(reviewDelta(prior, at('h1', 'blob-a')).rule, [], 'nothing moved: every ruling stands')
  assert.deepEqual(reviewDelta(prior, at('h2', 'blob-a')).rule.map((r) => r.unit), ['criterion:1', 'approved-case:t.mjs#x'], 'the head moved, the file did not')
  const edited = reviewUnits({ acceptance: [{ text: 'first, reworded' }] }, { head: 'h1' })
  assert.notEqual(edited[0].anchor, prior[0].anchor, 'a criterion whose text changed is ruled again')
})

test('a unit an earlier reviewer left unruled is ruled at the head though the span no longer reaches it, and named once', () => {
  const units = reviewUnits({ acceptance: [{ text: 'first' }] }, {
    head: 'h2', changed: ['src/a.mjs'], blobs: new Map([['src/a.mjs', 'blob-a']]), unruled: ['file:src/old.mjs', 'file:src/a.mjs', 'file:src/old.mjs'],
  })
  assert.deepEqual(units.map((u) => u.unit), ['criterion:1', 'file:src/a.mjs', 'file:src/old.mjs'])
  assert.equal(units[2].anchor, 'h2')
  assert.deepEqual(reviewDelta([], units).rule.map((r) => r.unit).slice(-1), ['file:src/old.mjs'], 'no prior ruling: the next reviewer rules it')
})

test('unruledUnit is true for a unit: entry and false for any other', () => {
  assert.equal(unruledUnit({ id: 'unit:criterion:1' }), true)
  assert.equal(unruledUnit({ id: 'unit:file:src/a.mjs' }), true)
  assert.equal(unruledUnit({ id: 'F1' }), false)
  assert.equal(unruledUnit({ id: 'xunit:1' }), false)
})

test('greenRoundRole leaves unruled unit entries out of a review\'s open set', () => {
  const unit = { id: 'unit:criterion:1', severity: 'critical', claim: 'unit not ruled: criterion:1', evidence: '', failure_scenario: '' }
  const tests = finding('F1', { remedy: 'tests' })
  const code = finding('F2')
  assert.equal(greenRoundRole({ review: { next: 'fix', open: [unit, tests] } }), 'test-author')
  assert.equal(greenRoundRole({ review: { next: 'fix', open: [tests, unit] } }), 'test-author')
  assert.equal(greenRoundRole({ review: { next: 'fix', open: [unit, tests, code] } }), 'implementer')
  assert.equal(greenRoundRole({ review: { next: 'fix', open: [tests] } }), 'test-author')
})
