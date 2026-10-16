// test/boundaries-leaf-open-notes.test.mjs — a round on a thread this execution never dispatched
// records a `notes` message carrying every note on the leaf no session of it has seen, once; a
// thread this execution dispatched is left to the `retried` message.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { leafOpen } from '../lib/boundaries/leaf-open.mjs'
import { pendingMessages } from '../lib/conversation.mjs'
import { append, executionLog, readLog } from '../lib/ledger.mjs'
import { leaf } from './harness/boundary-fixture.mjs'
import { E, ran, setup } from './harness/leaf-open-world.mjs'

const notesOf = (r) => readLog(r, E, 'events').entries.filter((e) => e.kind === 'message' && e.msg === 'notes')
const note = (r, node, text) => append(r, E, 'events', { kind: 'noted', node, execution: '', by: 'user', text }).seqs[0]
const OTHER = '20260925-110000'

test("a leaf's first round carries the notes left on it, in a notes message to its thread", async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  note(r, 'a', 'handed over from hand/a at abc123')
  note(r, 'a', 'the cache is warm')
  const opened = await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.equal(opened.status, 'opened')
  const msgs = notesOf(r)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].thread, opened.thread)
  assert.equal(msgs[0].round, opened.round)
  assert.deepEqual(msgs[0].payload.notes, ['handed over from hand/a at abc123', 'the cache is warm'])
  assert.deepEqual(pendingMessages(xc.log.entries(), opened.thread).map((m) => m.msg), ['notes'], 'the fresh call delivers it')
})

test('opening the same round again records the notes message once', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  note(r, 'a', 'one note')
  await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.equal(notesOf(r).length, 1)
})

test('no note, no message', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.equal(notesOf(r).length, 0)
})

test('a note a session of the leaf already started after is not carried again', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  note(r, 'a', 'old news')
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', log: executionLog(r, E, OTHER) })
  note(r, 'a', 'new news')
  await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.deepEqual(notesOf(r).map((m) => m.payload.notes), [['new news']])
})

test('a thread this execution dispatched gets no notes message', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', ret: { status: 'done', text: 'did it' } })
  note(r, 'a', 'after the round')
  await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.equal(notesOf(r).length, 0)
})
