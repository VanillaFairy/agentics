// test/fast/loop-guard.test.mjs — pins how a loop that sends a producer back ends: on the state its
// send-backs left since the node was cleared, never on a count.
//
//   unmoved    a send-back at a head the node was sent back at already stops, whatever kind sent it
//   repeated   the same failures as the kind's last send-back, at a moved head, stop
//   recurred   an exact state any earlier send-back of the kind held stops
//   failuresKey  a line that only moved is no progress; one diagnostic of three gone is
//
// Design: docs/DESIGN.md#l2--states-end-work-counts-dont.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clearedAt, failuresKey, sendBack, sendBacks, sentBackFiles } from '../../lib/boundaries/loop-guard.mjs'

let seq = 0
/** A recorded send-back of node `a`, as the events hold it. */
const was = (round, guard, node = 'a') => ({ kind: 'message', seq: ++seq, node, thread: 'producer:' + node, msg: 'failures', round, guard })
const ask = (history, guard, round = 9) => sendBack(history, { node: 'a', thread: 'producer:a', msg: 'failures', payload: {}, round, guard })
const fails = (...claims) => claims.map((claim) => ({ check: 'suite', claim, evidence: '' }))

test('a send-back goes out as its message, carrying the state it was sent in', () => {
  const out = ask([], { kind: 'verification', key: 'k', at: 'h1' })
  assert.equal(out.record.kind, 'message')
  assert.deepEqual(out.record.fields.guard, { kind: 'verification', key: 'k', at: 'h1' })
  assert.equal(out.record.fields.msg, 'failures')
})

test('work sent back at a head it was already sent back at returned unmoved, whatever sent it', () => {
  const history = [was(2, { kind: 'adhoc', key: 'adhoc', at: 'h1' })]
  assert.equal(ask(history, { kind: 'verification', key: 'k', at: 'h1' }).stop.reason, 'fix_without_commits')
  assert.equal(ask(history, { kind: 'integration', key: 'k', at: 'h1' }).stop.reason, 'fix_without_commits')
  assert.equal(ask(history, { kind: 'merge', key: 'p', at: 'h1' }).stop.reason, 'merge_conflict')
  assert.ok(ask(history, { kind: 'verification', key: 'k', at: 'h2' }).record, 'the round moved the head')
})

test('a request that claims no work is never stopped for an unmoved head', () => {
  const history = [was(2, { kind: 'verification', key: 'k', at: 'h1' })]
  assert.ok(ask(history, { kind: 'adhoc', key: 'adhoc', at: 'h1' }).record)
  assert.ok(ask(history, { kind: 'needs_tests', key: '', at: 'h1' }).record)
  assert.ok(ask(history, { kind: 'rebase', key: 'p', at: 'h1' }).record)
})

test('the same failures as the last send-back of the kind, at a moved head, stop', () => {
  const history = [was(2, { kind: 'verification', key: 'k1', at: 'h1' }), was(3, { kind: 'verification', key: 'k2', at: 'h2' })]
  assert.equal(ask(history, { kind: 'verification', key: 'k2', at: 'h3' }).stop.reason, 'verify_not_converging')
  assert.ok(ask(history, { kind: 'verification', key: 'k1', at: 'h3' }).record, 'only the last send-back of the kind is compared')
  assert.ok(ask(history, { kind: 'verification', key: '', at: 'h3' }).record, 'an empty state is never the same as another')
})

test('an exact state any earlier send-back of the kind held stops', () => {
  const history = [was(2, { kind: 'adhoc', key: 'adhoc', at: 'h1' }), was(3, { kind: 'verification', key: 'k', at: 'h2' })]
  assert.equal(ask(history, { kind: 'adhoc', key: 'adhoc', at: 'h3' }).stop.reason, 'blocked')
})

test('history is the node\'s send-backs since it was cleared and before the round asked, so a replayed close is no repeat', () => {
  const events = [
    was(2, { kind: 'adhoc', key: 'adhoc', at: 'h0' }),
    { kind: 'replanned', seq: ++seq, node: 'a', reason: 'retry_escalated' },
    was(3, { kind: 'verification', key: 'k', at: 'h1' }),
    was(4, { kind: 'verification', key: 'k', at: 'h2' }),
    was(3, { kind: 'verification', key: 'k', at: 'h1' }, 'b'),
    { kind: 'message', seq: ++seq, node: 'a', msg: 'tests_ready', round: 3 },
  ]
  const since = clearedAt({ id: 'a', seq: 1 }, events)
  assert.deepEqual(sendBacks(events, 'a', since, 4).map((e) => e.round), [3])
  assert.equal(clearedAt({ id: 'a', seq: 99 }, events), 99, 'a revision of the node clears it too')
})

test('every file a discriminator send-back named counts as told, whichever round named it', () => {
  const history = [was(2, { kind: 'discriminator', key: 'a.test.js', at: 'h1' }), was(3, { kind: 'discriminator', key: 'b.test.js\nc.test.js', at: 'h2' })]
  assert.deepEqual(sentBackFiles(history).sort(), ['a.test.js', 'b.test.js', 'c.test.js'])
})

test('a diagnostic that only moved lines is the same failure; one of three gone is progress', () => {
  const tsc = (...lines) => [{ check: 'typecheck', claim: 'the typecheck failed', evidence: lines.map((l) => 'src/a.ts(' + l + ',3): error TS2322: x').join('\n') }]
  assert.equal(failuresKey(tsc(10, 20, 30)), failuresKey(tsc(11, 21, 31)))
  assert.notEqual(failuresKey(tsc(10, 20, 30)), failuresKey(tsc(10, 20)))
  assert.equal(failuresKey(fails('x', 'y')), failuresKey(fails('y', 'x')))
  const tests = (ms) => [{ check: 'suite', claim: 'fails', evidence: '✖ adds two numbers (' + ms + 'ms)' }]
  assert.equal(failuresKey(tests(3)), failuresKey(tests(40)), 'a duration is no failure')
})
