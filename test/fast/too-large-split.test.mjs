// test/fast/too-large-split.test.mjs — a refusal of a leaf's own work escalates as not converging only
// on what the planner's split of an earlier refused leaf made, never on a sibling revised for its own reasons.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { splitOf } from '../../lib/programs/execute/leaf.mjs'

const line = (seq, id) => ({ seq, kind: 'node', node: { id } })
// x planned at 1; a sibling z at 2; the plan answering x's refusal (at x's rev 1) revises x and adds y at 4-5,
// its events at 6-7; z revised on its own at 9.
const LINES = [line(1, 'f/x'), line(2, 'f/z'), line(4, 'f/x'), line(5, 'f/y'), line(9, 'f/z')]
const REFUSED = { node: 'f/x', rev: 1 }

test('the refused leaf revised, and a leaf its answering plan created, are its split', () => {
  assert.equal(splitOf(LINES, REFUSED, 'f/x', 4), true)
  assert.equal(splitOf(LINES, REFUSED, 'f/y', 5), true)
})

test('the refused leaf at the revision it was refused at, and a sibling revised by another plan, are not', () => {
  assert.equal(splitOf(LINES, REFUSED, 'f/x', 1), false)
  assert.equal(splitOf(LINES, REFUSED, 'f/z', 9), false)
})
