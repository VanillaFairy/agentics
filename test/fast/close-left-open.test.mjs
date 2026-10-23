// test/fast/close-left-open.test.mjs — pins how a run's start ends the calls an earlier run left open:
// each is recorded `cut_off`, a live orphan ended and a gone one named so, its live file removed,
// and a call that was answered or host-stopped left as it is.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { closeLeftOpen, openCalls } from '../../lib/runner.mjs'
import { livePath } from '../../lib/store.mjs'
import { memoryLog } from './harness/memory-log.mjs'

const DIR = '/runs/r1'
const sent = (dispatch, over = {}) => ['dispatched', { dispatch, node: '', round: 1, thread: 't:' + dispatch, role: 'analyst', session: 's-' + dispatch, pid: 0, ...over }]

function seeded(rows, alive = []) {
  const log = memoryLog()
  for (const [kind, fields] of rows) log.append(kind, fields)
  const killed = []
  const removed = []
  const proc = { alive: (pid) => alive.includes(pid), kill: (pid) => killed.push(pid) }
  return { log, killed, removed, proc, remove: (p) => removed.push(p) }
}

const cutOffs = (log) => log.entries().filter((e) => e.kind === 'returned' && e.status === 'cut_off')

test('a call whose process is gone is recorded cut off, process_gone, and its live file removed', () => {
  const r = seeded([sent('gone', { pid: 197804 })])
  const closed = closeLeftOpen({ log: r.log, proc: r.proc, dir: DIR, remove: r.remove })
  assert.deepEqual(cutOffs(r.log).map((e) => [e.dispatch, e.session, e.cause]), [['gone', 's-gone', 'process_gone']])
  assert.deepEqual(closed.map((c) => [c.dispatch, c.thread, c.cause]), [['gone', 't:gone', 'process_gone']])
  assert.deepEqual(r.removed, [livePath(DIR, 'gone')])
  assert.deepEqual(r.killed, [])
  assert.deepEqual(openCalls(r.log.entries()), [], 'nothing reads as running afterwards')
})

test('a call still alive is ended and recorded orphan_ended', () => {
  const r = seeded([sent('live', { pid: 501 })], [501])
  closeLeftOpen({ log: r.log, proc: r.proc, dir: DIR, remove: r.remove })
  assert.deepEqual(r.killed, [501])
  assert.deepEqual(cutOffs(r.log).map((e) => [e.dispatch, e.cause]), [['live', 'orphan_ended']])
})

test('an answered call, a host-stopped one and one answered after its resume are left alone', () => {
  const r = seeded([
    sent('done', { pid: 11 }), ['returned', { dispatch: 'done', session: 's-done', status: 'returned', cause: '' }],
    sent('stopped', { pid: 12 }), ['host_stop', { dispatch: 'stopped', cause: 'rate_limit', until: '' }],
    sent('again', { pid: 13 }), sent('again', { pid: 14 }), ['returned', { dispatch: 'again', session: 's-again', status: 'failed', cause: 'host_error' }],
  ], [11, 12, 13, 14])
  const closed = closeLeftOpen({ log: r.log, proc: r.proc, dir: DIR, remove: r.remove })
  assert.deepEqual(closed, [])
  assert.deepEqual(cutOffs(r.log), [])
  assert.deepEqual(r.killed, [])
})

test('a call dispatched twice and never answered is closed once, after its latest start', () => {
  const r = seeded([sent('twice', { pid: 21 }), sent('twice', { pid: 22 })])
  closeLeftOpen({ log: r.log, proc: r.proc, dir: DIR, remove: r.remove })
  const [cut] = cutOffs(r.log)
  assert.equal(cutOffs(r.log).length, 1)
  const latest = r.log.entries().filter((e) => e.kind === 'dispatched' && e.dispatch === 'twice').at(-1)
  assert.ok(cut.seq > latest.seq)
})
