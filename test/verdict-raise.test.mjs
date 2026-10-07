// test/verdict-raise.test.mjs — pins when a review round raises: it answered prior blockers (those
// not carried past the round) and ruled none of them fixed. One fixed blocker among the answered
// ones means the producer is making progress, so no raise; a prior unit the round now rules counts
// as fixed.
//
// Design: docs/DESIGN.md#executors-and-review and docs/DESIGN.md#model-tier.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { reviewExit } from '../lib/verdict.mjs'

const blocker = (id, extra = {}) => ({ id, severity: 'critical', claim: 'claim ' + id, evidence: 'ev ' + id, failure_scenario: 'x ' + id, ...extra })
const ruling = (id, status) => ({ id, status, evidence: 'looked' })
const clean = (unit) => ({ unit, ruling: 'clean', why: 'read it' })

test('a first round never raises', () => {
  const exit = reviewExit({ findings: [blocker('F1'), blocker('F2')], verdicts: [], prior: {} })
  assert.equal(exit.next, 'fix')
  assert.equal(exit.raise, false)
})

test('a round that ruled every answered prior blocker not fixed raises', () => {
  const prior = { open: [blocker('F1'), blocker('F2')], unfixed: [], clean_streak: 0 }
  const exit = reviewExit({ findings: [], verdicts: [ruling('F1', 'not_fixed'), ruling('F2', 'regressed')], prior })
  assert.equal(exit.next, 'fix')
  assert.equal(exit.raise, true)
})

test('a round that ruled no prior blocker raises', () => {
  const prior = { open: [blocker('F1'), blocker('F2')], unfixed: [], clean_streak: 0 }
  const exit = reviewExit({ findings: [], verdicts: [], prior })
  assert.equal(exit.next, 'fix')
  assert.equal(exit.raise, true)
})

test('a round that fixed one answered prior blocker and left another unfixed does not raise', () => {
  const prior = { open: [blocker('F1'), blocker('F2')], unfixed: [], clean_streak: 0 }
  const exit = reviewExit({ findings: [], verdicts: [ruling('F1', 'fixed'), ruling('F2', 'not_fixed')], prior })
  assert.equal(exit.next, 'fix')
  assert.deepEqual(exit.open.map((f) => f.id), ['F2'])
  assert.equal(exit.raise, false)
})

test('a round whose answered prior blockers were all fixed does not raise, new blockers or not', () => {
  const prior = { open: [blocker('F1'), blocker('F2')], unfixed: [], clean_streak: 0 }
  const exit = reviewExit({ findings: [blocker('F3')], verdicts: [ruling('F1', 'fixed'), ruling('F2', 'fixed')], prior })
  assert.equal(exit.next, 'fix')
  assert.deepEqual(exit.open.map((f) => f.id), ['F3'])
  assert.equal(exit.raise, false)
})

test('a prior blocker carried past the round counts toward no raise', () => {
  // The round was a code round (`producer: 'code'`): F2 asks for tests, so it was carried, not answered.
  const carriedOnly = reviewExit({
    findings: [], verdicts: [], producer: 'code',
    prior: { open: [blocker('F2', { remedy: 'tests' })], unfixed: [], clean_streak: 0 },
  })
  assert.equal(carriedOnly.next, 'fix')
  assert.equal(carriedOnly.raise, false, 'nothing was answered, so nothing was left unfixed')

  const beside = reviewExit({
    findings: [], verdicts: [ruling('F1', 'not_fixed')], producer: 'code',
    prior: { open: [blocker('F1'), blocker('F2', { remedy: 'tests' })], unfixed: [], clean_streak: 0 },
  })
  assert.equal(beside.next, 'fix')
  assert.equal(beside.raise, true, 'the one answered blocker was ruled not fixed')
})

test('a prior unit the round now rules counts as cleared, so the round does not raise', () => {
  const prior = { open: [blocker('unit:u1'), blocker('F1')], unfixed: [], clean_streak: 0 }
  const exit = reviewExit({
    findings: [], verdicts: [ruling('F1', 'not_fixed')], prior, units: ['u1'], rulings: [clean('u1')],
  })
  assert.equal(exit.next, 'fix')
  assert.deepEqual(exit.open.map((f) => f.id), ['F1'])
  assert.equal(exit.raise, false)
})

test('an escalating round does not raise', () => {
  const prior = { open: [blocker('F1')], unfixed: ['F1'], clean_streak: 0 }
  const exit = reviewExit({ findings: [], verdicts: [ruling('F1', 'not_fixed')], prior })
  assert.equal(exit.next, 'escalate')
  assert.equal(exit.raise, false)
})
