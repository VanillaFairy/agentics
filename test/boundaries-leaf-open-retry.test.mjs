// test/boundaries-leaf-open-retry.test.mjs — pins leaf-open in-process: a raise on the previous
// round renews the thread on the raised tier, and a retried round records the retried message once,
// quotes the notes since the stop, and resumes the thread.
//
// The setup the parts share is in test/harness/leaf-open-world.mjs.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#rigor and docs/DESIGN.md#the-locus.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leafOpen } from '../lib/boundaries/leaf-open.mjs'
import { executionContext } from '../lib/boundaries/records.mjs'
import { deliveryPlan, renderMessage } from '../lib/conversation.mjs'
import { append, executionLog, readLog } from '../lib/ledger.mjs'
import { producerTier, raiseTier } from '../lib/roles.mjs'
import { STAMP, leaf } from './harness/boundary-fixture.mjs'
import { E, setup, ran, closed, reviewed, nodeOf, roleOf, cycle } from './harness/leaf-open-world.mjs'

/** What the session's `retry` and `note` append for `node`: a `replanned {reason: 'retry_escalated'}` or a `noted` event under this execution. */
const retry = (r, node) => assert.equal(append(r, E, 'events', [{ kind: 'replanned', node, execution: STAMP, reason: 'retry_escalated', by: 'session' }]).ok, true)
const note = (r, node, text) => assert.equal(append(r, E, 'events', [{ kind: 'noted', node, execution: STAMP, by: 'session', text }]).ok, true)

/** Every `retried` message on disk, oldest first. */
const retriedOf = (r) => readLog(r, E, 'events').entries.filter((e) => e.kind === 'message' && e.msg === 'retried')

/** Leaf `a`'s round 1 returned `blocked` and escalated so, in this execution. */
async function blocked(t) {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  const said = ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', ret: { status: 'blocked', text: 'no fixture' } })
  xc.log.append('escalated', { node: 'a', reason: 'blocked', detail: '', said })
  return { r, xc }
}

// ------------------------------------------------------------------ the raise

test('a raise on the previous round\'s close renews the thread on the raised tier', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', model: 'haiku', effort: 'low', ret: { status: 'done' } })
  closed(xc, { node: 'a', role: 'implementer', round: 1, raise: false })
  const plain = await leafOpen(xc, { node: 'a' })
  assert.equal(plain.fresh, '')
  assert.deepEqual(plain.tier, producerTier(nodeOf(r, 'a'), roleOf('implementer'), { intelligence: 'normal' }))

  closed(xc, { node: 'a', role: 'implementer', round: 1, raise: true })
  const raised = await leafOpen(xc, { node: 'a' })
  assert.equal(raised.fresh, 'raised')
  assert.deepEqual(raised.tier, raiseTier({ model: 'haiku', effort: 'low' }), 'one step above the thread\'s own tier')
})

test('a raise on the previous round\'s review renews the thread on the raised tier', async (t) => {
  const { xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'], provides: [{ name: 'A', paths: ['src/a.mjs'] }] })])
  await leafOpen(xc, { node: 'a' })
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', model: 'opus', effort: 'medium', ret: { status: 'done' } })
  closed(xc, { node: 'a', role: 'implementer', round: 1, decision: { next: 'review', reason: '', failures: [] } })
  reviewed(xc, { node: 'a', round: 1, review_round: 1, raise: true })
  const out = await leafOpen(xc, { node: 'a' })
  assert.deepEqual([out.fresh, out.tier], ['raised', raiseTier({ model: 'opus', effort: 'medium' })])
})

test('a raise on another thread\'s round renews nothing', async (t) => {
  const { r, xc } = await cycle(t)
  ran(xc, { node: 'g', round: 1, role: 'implementer', thread: 'producer:g', ret: { status: 'needs_tests' } })
  closed(xc, { node: 'g', role: 'implementer', round: 1, raise: true })
  const out = await leafOpen(xc, { node: 'g' })
  assert.deepEqual([out.thread, out.fresh], ['producer:r', ''])
  assert.deepEqual(out.tier, producerTier(nodeOf(r, 'r'), roleOf('test-author'), { intelligence: 'normal' }), 'the owner\'s producer tier')
})

// ------------------------------------------------------------------ a retried round

test('a round after a retry on a thread this execution dispatched records a retried message: the stop\'s reason and the notes since it', async (t) => {
  const { r, xc } = await blocked(t)
  note(r, 'a', 'the fixture is in test/fixtures now')
  retry(r, 'a')
  const out = await leafOpen(xc, { node: 'a' })
  assert.deepEqual([out.status, out.round, out.thread, out.fresh], ['opened', 2, 'producer:a', ''])
  const [m] = retriedOf(r)
  assert.deepEqual([m.node, m.thread, m.round, m.from, m.execution], ['a', 'producer:a', 2, 'code', STAMP])
  assert.deepEqual(m.payload, { reason: 'blocked', notes: ['the fixture is in test/fixtures now'] })
})

test('the retried round\'s prompt is the retried message, resumed on the thread', async (t) => {
  const { r, xc } = await blocked(t)
  retry(r, 'a')
  await leafOpen(xc, { node: 'a' })
  const [m] = retriedOf(r)
  assert.deepEqual(deliveryPlan(xc.log.entries(), 'producer:a'), { action: 'deliver', carries: [m.seq], prompt: renderMessage(m) })
})

test('a retried message is recorded once, however often its round is opened, a relaunch included', async (t) => {
  const { r, xc } = await blocked(t)
  retry(r, 'a')
  await leafOpen(xc, { node: 'a' })
  await leafOpen(xc, { node: 'a' })
  const relaunched = executionContext({ repo: r, effort: E, execution: STAMP, log: executionLog(r, E, STAMP) })
  assert.equal((await leafOpen(relaunched, { node: 'a' })).round, 2)
  const [m] = retriedOf(r)
  ran(xc, { node: 'a', round: 2, role: 'implementer', thread: 'producer:a', log: relaunched.log })
  assert.equal((await leafOpen(relaunched, { node: 'a' })).round, 2, 'the started round is reopened')
  assert.deepEqual(retriedOf(r).map((e) => e.seq), [m.seq])
})

test('a reopened round records no retried message: its call resumes as it was started', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', ret: { status: 'done' } })
  const dispatch = ran(xc, { node: 'a', round: 2, role: 'implementer', thread: 'producer:a' })
  xc.log.append('returned', { dispatch, session: 's', status: 'failed', cause: 'host_error', usage: null, cost_total: null, cost_usd: null, denials: [] })
  retry(r, 'a')
  assert.equal((await leafOpen(xc, { node: 'a' })).round, 2)
  assert.deepEqual(retriedOf(r), [])
})

test('a stop recorded after the retry is not the one the retry cleared', async (t) => {
  const { r, xc } = await blocked(t)
  retry(r, 'a')
  xc.log.append('escalated', { node: 'a', reason: 'fix_without_commits', detail: '' })
  await leafOpen(xc, { node: 'a' })
  assert.deepEqual(retriedOf(r).map((m) => m.payload.reason), ['blocked'])
})

test('a retry before any dispatch records no message: the first round\'s brief carries on', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  xc.log.append('escalated', { node: 'a', reason: 'open_refused', detail: 'a lock was stuck' })
  retry(r, 'a')
  const out = await leafOpen(xc, { node: 'a' })
  assert.deepEqual([out.status, out.round], ['opened', 1])
  assert.deepEqual(retriedOf(r), [])
})

test('a retry after a round another execution dispatched records no message: this execution\'s call is a fresh session', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  const other = executionLog(r, E, '20260924-120000')
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', ret: { status: 'blocked' }, log: other })
  other.append('escalated', { node: 'a', reason: 'blocked', detail: '' })
  retry(r, 'a')
  assert.equal((await leafOpen(xc, { node: 'a' })).round, 2)
  assert.deepEqual(retriedOf(r), [])
})

test('a note left before the stop, or on another node, is not quoted', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', ret: { status: 'blocked' } })
  note(r, 'a', 'before the stop')
  xc.log.append('escalated', { node: 'a', reason: 'blocked', detail: '' })
  note(r, 'a', 'after one')
  note(r, '.', 'on the root')
  note(r, 'a', 'after two')
  retry(r, 'a')
  await leafOpen(xc, { node: 'a' })
  assert.deepEqual(retriedOf(r).map((m) => m.payload.notes), [['after one', 'after two']])
})

test('a retry that cleared a park names the park\'s return as the reason', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', ret: { status: 'done' } })
  xc.log.append('parked', { node: 'a', return: 'contract_drift', question: '' })
  retry(r, 'a')
  await leafOpen(xc, { node: 'a' })
  assert.deepEqual(retriedOf(r).map((m) => m.payload), [{ reason: 'contract_drift', notes: [] }])
})

test('a second retry after the retried round returned is told again, with the notes since the second stop', async (t) => {
  const { r, xc } = await blocked(t)
  note(r, 'a', 'first')
  retry(r, 'a')
  await leafOpen(xc, { node: 'a' })
  const [first] = retriedOf(r)
  ran(xc, { node: 'a', round: 2, role: 'implementer', thread: 'producer:a', ret: { status: 'blocked' } })
  xc.log.append('escalated', { node: 'a', reason: 'fix_without_commits', detail: '' })
  retry(r, '.')
  assert.equal(append(r, E, 'events', [{ kind: 'replanned', node: 'a', execution: STAMP, reason: 'answered', by: 'session' }]).ok, true)
  await leafOpen(xc, { node: 'a' })
  assert.deepEqual(retriedOf(r).map((m) => m.seq), [first.seq], 'no retry of a since its round returned: nothing owed')
  note(r, 'a', 'second')
  retry(r, 'a')
  assert.equal((await leafOpen(xc, { node: 'a' })).round, 3)
  assert.deepEqual(retriedOf(r).map((m) => [m.round, m.payload]),
    [[2, first.payload], [3, { reason: 'fix_without_commits', notes: ['second'] }]])
})

test('a round with a failures message waiting delivers it with the retried message, oldest first', async (t) => {
  const { r, xc } = await blocked(t)
  const failure = { check: 'suite', claim: 'the merged head fails', evidence: 'test/a.test.mjs:3' }
  const { seq } = xc.log.append('message', { node: 'a', thread: 'producer:a', from: 'code', msg: 'failures', payload: { source: 'integration', failures: [failure] }, round: 2 })
  retry(r, 'a')
  await leafOpen(xc, { node: 'a' })
  const [m] = retriedOf(r)
  const failures = readLog(r, E, 'events').entries.find((e) => e.seq === seq)
  const plan = deliveryPlan(xc.log.entries(), 'producer:a')
  assert.deepEqual(plan.carries, [seq, m.seq])
  for (const text of [renderMessage(failures), renderMessage(m)]) assert.ok(plan.prompt.includes(text), text)
})
