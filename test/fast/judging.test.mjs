// test/fast/judging.test.mjs — pins that no judge rules on what its own session or thread produced, and
// that a count only decides when a convergence ruling is asked for.
//
// Design: docs/DESIGN.md#l3--separate-judges and docs/DESIGN.md#l2--states-end-work-counts-dont.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dispatchJudge, judgeAllowed } from '../../lib/programs/common.mjs'
import { askAfter } from '../../lib/programs/converge.mjs'

const P = { session: 's-producer', thread: 'implementer:a/b' }

test('a fresh judge may rule a producer\'s work', () => {
  assert.equal(judgeAllowed({ producer: P, judge: { session: 's-judge', thread: 'reviewer:a/b:1' } }), true)
})

test('a judge in the producer\'s own session may not', () => {
  assert.equal(judgeAllowed({ producer: P, judge: { session: 's-producer', thread: 'reviewer:a/b:1' } }), false)
})

test('a judge on the producer\'s own thread may not, whatever its session', () => {
  assert.equal(judgeAllowed({ producer: P, judge: { session: 's-other', thread: 'implementer:a/b' } }), false)
})

test('dispatchJudge runs an allowed judge and returns what it returned', async () => {
  const out = await dispatchJudge({ producer: P, judge: { session: 's-judge', thread: 'reviewer:a/b:1' }, run: async () => ({ status: 'returned' }) })
  assert.deepEqual(out, { status: 'returned' })
})

test('dispatchJudge refuses a judge on its own work without running it', async () => {
  let ran = false
  const out = await dispatchJudge({ producer: P, judge: P, run: async () => { ran = true } })
  assert.equal(ran, false)
  assert.equal(out.status, 'failed')
  assert.equal(out.error.kind, 'self_judging')
})

test('askAfter asks every third round by default and never before the first', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((r) => askAfter(r)), [false, false, false, true, false, false, true])
})

test('askAfter follows the interval it is given', () => {
  assert.deepEqual([1, 2, 3, 4].map((r) => askAfter(r, 2)), [false, true, false, true])
})
