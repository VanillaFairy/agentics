// test/fast/standing-rulings.test.mjs — pins which ruling of unaffected stands on a consumer's
// contract: a ruler's, or the user's (a contract_drift park a retry cleared), until a later
// affected ruling nobody cleared takes its place.
//
// Design: docs/DESIGN.md#landing-and-drift.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { standingRulings } from '../../lib/boundaries/integration.mjs'

const ruled = (seq, ruling, head, said) => ({ kind: 'drift-ruled', node: 'c', contract: 'docs', head_sha: head, ruling, why: 'why ' + seq, said, seq })
const park = (seq, said) => ({ kind: 'parked', node: 'c', return: 'contract_drift', question: 'q ' + seq, said, seq })
const retry = (seq) => ({ kind: 'replanned', node: 'c', reason: 'retry_escalated', by: 'session', seq })
const answered = (seq, answer) => ({ kind: 'answered', nodes: ['c'], answers: [{ question: 'asked', answer }], seq })

test("a ruler's unaffected ruling stands at the head it ruled", () => {
  const s = standingRulings({ states: [ruled(1, 'unaffected', 'h1', 'r1')] }).get('c docs')
  assert.deepEqual([s.by, s.head_sha, s.why], ['ruler', 'h1', 'why 1'])
})

test("an affected ruling the user cleared with retry stands as the user's, with the answers given between", () => {
  const s = standingRulings({
    states: [ruled(1, 'affected', 'h1', 'r1')], events: [park(2, 'r1'), retry(5)], ledger: [answered(3, 'not ours'), answered(6, 'later')],
  }).get('c docs')
  assert.deepEqual([s.by, s.seq, s.head_sha, s.question], ['user', 5, 'h1', 'q 2'])
  assert.deepEqual(s.answers.map((a) => a.answer), ['not ours'])
})

test('a later affected ruling nobody cleared leaves no ruling standing; an uncleared park stands for nothing', () => {
  const states = [ruled(1, 'unaffected', 'h1', 'r1'), ruled(4, 'affected', 'h2', 'r2')]
  assert.equal(standingRulings({ states, events: [park(5, 'r2')] }).has('c docs'), false)
  const cleared = standingRulings({ states, events: [park(5, 'r2'), retry(7)] }).get('c docs')
  assert.equal(cleared.head_sha, 'h2')
})
