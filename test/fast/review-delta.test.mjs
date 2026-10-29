// test/fast/review-delta.test.mjs — pins the one delta every review is computed from: a ruling
// stands only for its unit at the anchor it was ruled at, a whole review is the empty prior, and
// what is no longer under review is gone rather than standing.
//
// Design: docs/DESIGN.md#review-delta.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { anchorOf, fileUnits, reviewDelta } from '../../lib/review-delta.mjs'

const unit = (u, a) => ({ unit: u, anchor: a })
const ruled = (u, a, ruling = 'clean') => ({ unit: u, anchor: a, ruling })

test('a prior ruling at the same anchor stands, carried whole; one at another anchor is ruled again, the earlier ruling its was', () => {
  const kept = ruled('file:a', 'b1', 'clean')
  const moved = ruled('file:b', 'b2')
  const d = reviewDelta([kept, moved], [unit('file:a', 'b1'), unit('file:b', 'b3')])
  assert.deepEqual(d.stand, [kept])
  assert.deepEqual(d.rule, [{ unit: 'file:b', anchor: 'b3', was: moved }])
  assert.deepEqual(d.gone, [])
})

test('a whole review is the empty prior: every current unit is ruled, none with a was', () => {
  const current = [unit('criterion:1', 'h'), unit('file:a', 'b1')]
  const d = reviewDelta([], current)
  assert.deepEqual(d.rule, current.map((c) => ({ ...c, was: null })))
  assert.deepEqual([d.stand, d.gone], [[], []])
})

test('a prior ruling of a unit no longer under review is gone, never standing', () => {
  const left = ruled('file:old', 'b1')
  const d = reviewDelta([left], [unit('file:new', 'b1')])
  assert.deepEqual(d.gone, [left])
  assert.deepEqual(d.stand, [])
  assert.deepEqual(d.rule.map((r) => r.unit), ['file:new'], 'the same anchor under another unit stands for nothing')
})

test('a unit named twice is one unit; the later of two prior rulings of it is the one that stands', () => {
  const d = reviewDelta([ruled('u', 'a1', 'first'), ruled('u', 'a2', 'second')], [unit('u', 'a2'), unit('u', 'a9')])
  assert.deepEqual(d.stand.map((p) => p.ruling), ['second'])
  assert.equal(d.rule.length, 0)
})

test('anchorOf is the same for the same value whatever its key order, and differs where the value does', () => {
  assert.equal(anchorOf({ text: 't', head: 'h' }), anchorOf({ head: 'h', text: 't' }))
  assert.notEqual(anchorOf({ text: 't', head: 'h' }), anchorOf({ text: 't', head: 'h2' }))
})

test('fileUnits anchors each file to its blob, a file the head no longer holds to deleted', () => {
  const units = fileUnits(['a', 'gone'], new Map([['a', 'blob-a']]))
  assert.deepEqual(units, [unit('file:a', 'blob-a'), unit('file:gone', 'deleted')])
})
