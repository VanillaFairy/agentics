// test/fast/verdict-units.test.mjs — pins verdicts over units: a unit nobody ruled on is open, never
// passed, and a review loop cannot approve while one is.
//
// Design: docs/DESIGN.md#l3--separate-judges and docs/DESIGN.md#executors-and-review.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { reviewExit, unitsOpen, verdictOf } from '../../lib/verdict.mjs'

const clean = (unit) => ({ unit, ruling: 'clean', why: 'read it' })

test('unitsOpen lists the units nobody ruled on', () => {
  assert.deepEqual(unitsOpen(['a', 'b', 'c'], [clean('a'), clean('c')]), ['b'])
  assert.deepEqual(unitsOpen(['a'], [clean('a')]), [])
})

test('a unit its judge did not examine stays open', () => {
  for (const ruling of ['unexamined', 'unassessable', 'unanchored']) {
    assert.deepEqual(unitsOpen(['a', 'b'], [clean('a'), { unit: 'b', ruling, why: 'did not look' }]), ['b'], ruling)
  }
})

test('every unit ruled and nothing blocking is approved', () => {
  assert.deepEqual(verdictOf({ units: ['a', 'b'], rulings: [clean('a'), clean('b')] }), { approved: true, open: [], blocking: [] })
})

test('an unruled unit keeps the verdict open', () => {
  const v = verdictOf({ units: ['a', 'b'], rulings: [clean('a')] })
  assert.equal(v.approved, false)
  assert.deepEqual(v.open, ['b'])
})

test('a critical finding blocks', () => {
  const f = { id: 'F1', severity: 'critical', claim: 'wrong', failure_scenario: 'x' }
  const v = verdictOf({ units: ['a'], rulings: [clean('a')], findings: [f] })
  assert.equal(v.approved, false)
  assert.deepEqual(v.blocking.map((b) => b.id), ['F1'])
})

test('a major with a failure scenario blocks only on a yardstick', () => {
  const f = { id: 'F2', severity: 'major', claim: 'edge', failure_scenario: 'empty input' }
  assert.equal(verdictOf({ units: [], findings: [f], yardstick: false }).approved, true)
  assert.equal(verdictOf({ units: [], findings: [f], yardstick: true }).approved, false)
})

test('reviewExit without units is unchanged', () => {
  const round = { yardstick: false, findings: [], verdicts: [], prior: {} }
  assert.deepEqual(reviewExit(round), reviewExit({ ...round, units: null }))
  assert.equal(reviewExit(round).next, 'approve')
})

test('reviewExit with an unruled unit asks for another round', () => {
  const exit = reviewExit({ yardstick: false, findings: [], verdicts: [], prior: {}, units: ['src/a.ts', 'criterion 1'], rulings: [clean('src/a.ts')] })
  assert.equal(exit.next, 'fix')
  assert.ok(exit.open.some((o) => o.id === 'unit:criterion 1'))
})

test('a later round that rules the unit closes it', () => {
  const first = reviewExit({ yardstick: false, findings: [], verdicts: [], prior: {}, units: ['u1'], rulings: [] })
  const second = reviewExit({ yardstick: false, findings: [], verdicts: [], prior: first, units: ['u1'], rulings: [clean('u1')] })
  assert.equal(second.next, 'approve')
})

test('a later round that only declares the unit unexamined leaves it open', () => {
  const first = reviewExit({ yardstick: false, findings: [], verdicts: [], prior: {}, units: ['u1'], rulings: [] })
  const second = reviewExit({ yardstick: false, findings: [], verdicts: [], prior: first, units: ['u1'],
    rulings: [{ unit: 'u1', ruling: 'unexamined', why: 'out of time' }] })
  assert.notEqual(second.next, 'approve')
  assert.ok(second.open.some((o) => o.id === 'unit:u1'))
})

test('every unit ruled clean with nothing found is approved', () => {
  assert.equal(reviewExit({ yardstick: true, findings: [], verdicts: [], prior: {}, units: ['u1', 'u2'], rulings: [clean('u1'), clean('u2')] }).next, 'approve')
})

test('ruling a unit closes only that unit\'s own open entry, never another prior blocker', () => {
  const other = { id: 'nope-u1', severity: 'critical', claim: 'wrong', evidence: '', failure_scenario: 'x' }
  const exit = reviewExit({ yardstick: false, findings: [], verdicts: [], prior: { open: [other] }, units: ['u1'], rulings: [clean('u1')] })
  assert.notEqual(exit.next, 'approve')
  assert.ok(exit.open.some((o) => o.id === 'nope-u1'))
})

test('a major without a failure scenario never blocks, even on a yardstick', () => {
  const f = { id: 'F3', severity: 'major', claim: 'edge', failure_scenario: '  ' }
  assert.equal(verdictOf({ units: [], findings: [f], yardstick: true }).approved, true)
})

test('a unit a judge keeps declaring unexamined is unfixed, and two such rounds escalate', () => {
  const skip = [{ unit: 'u1', ruling: 'unexamined', why: 'out of time' }]
  const round = (prior) => reviewExit({ yardstick: false, findings: [], verdicts: [], prior, units: ['u1'], rulings: skip })
  const first = round({})
  const second = round(first)
  assert.ok(second.unfixed.includes('unit:u1'))
  const third = round(second)
  assert.equal(third.next, 'escalate')
  assert.match(third.detail, /unit:u1/)
})
