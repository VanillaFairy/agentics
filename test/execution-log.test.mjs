// test/execution-log.test.mjs — pins the execution's log port: one port per execution routes each
// record to the effort's event log (with `execution` set), the stamp's journal or the stamp's
// state, refuses a field named kind, an event without a node and a write the ledger refuses, and
// mirrors this execution's records merged by seq.
//
// Design: docs/DESIGN.md#the-ledger and docs/DESIGN.md#state-and-journal-lines.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EVENT_KINDS, append, executionLog, readLog } from '../lib/ledger.mjs'
import { effortStateDir, executionDir } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const S = '20261005-120000'
const OTHER = '20261005-130000'
const JOURNAL = ['verify-observed', 'merge-observed', 'series-done', 'authored']
const STATE = ['run', 'returned', 'host_stop', 'thread_renewed', 'checkout_changed', 'step', 'fault', 'gate', 'ended']
const MESSAGE = { thread: 'producer', from: 'code', msg: 'failures', payload: { failing: ['t1'] }, round: 2 }

function store(t) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-execution-log-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  return repo
}

const lines = (repo, name) => readLog(repo, E, name).entries
const kindsOf = (entries) => entries.map((e) => e.kind)

function seedLeaf(repo) {
  const out = seedTree(repo, E, [
    { id: '.', kind: 'composite', title: 't', defines: [{ id: 'D1', text: 'do it' }] },
    { id: 'a', kind: 'leaf', title: 'do a', rigor: 'tdd', locus: ['a.mjs'], decisions: ['D1'], acceptance: [{ text: 'a works', check: 'node --test', decisions: ['D1'] }] },
  ])
  assert.equal(out.ok, true, JSON.stringify(out))
}

test('every event kind lands in events.jsonl with execution set to the stamp', (t) => {
  const repo = store(t)
  const log = executionLog(repo, E, S)
  for (const kind of EVENT_KINDS) {
    const { seq } = log.append(kind, { node: 'a' })
    const line = lines(repo, 'events').find((e) => e.seq === seq)
    assert.equal(line.kind, kind)
    assert.equal(line.node, 'a')
    assert.equal(line.execution, S)
  }
  assert.equal(lines(repo, 'state:' + S).length, 0)
  assert.equal(lines(repo, 'journal:' + S).length, 0)
})

test("an event's execution is the port's stamp, whatever the fields say", (t) => {
  const repo = store(t)
  const { seq } = executionLog(repo, E, S).append('noted', { node: 'a', by: 'code', text: 'seen', execution: OTHER })
  assert.equal(lines(repo, 'events').find((e) => e.seq === seq).execution, S)
})

test("each journal kind lands in the stamp's journal", (t) => {
  const repo = store(t)
  const log = executionLog(repo, E, S)
  for (const kind of JOURNAL) log.append(kind, { node: 'a', head_sha: 'abc' })
  assert.deepEqual(kindsOf(lines(repo, 'journal:' + S)), JOURNAL)
  assert.equal(lines(repo, 'events').length, 0)
  assert.equal(lines(repo, 'state:' + S).length, 0)
})

test("any other kind lands in the stamp's state", (t) => {
  const repo = store(t)
  const log = executionLog(repo, E, S)
  for (const kind of STATE) log.append(kind, { node: '' })
  assert.deepEqual(kindsOf(lines(repo, 'state:' + S)), STATE)
  assert.equal(lines(repo, 'events').length, 0)
  assert.equal(lines(repo, 'journal:' + S).length, 0)
})

test('entries() holds the events, the state and the journal of the stamp merged by seq', (t) => {
  const repo = store(t)
  append(repo, E, 'state:' + S, { kind: 'run', program: 'execute', scope: {}, pid: 1 })
  append(repo, E, 'events', { kind: 'dispatched', node: 'a', execution: S })
  append(repo, E, 'journal:' + S, { kind: 'series-done', node: 'a' })
  append(repo, E, 'state:' + S, { kind: 'returned', dispatch: 'd1' })
  append(repo, E, 'events', { kind: 'approved', node: 'a', execution: S })
  const log = executionLog(repo, E, S)
  log.append('verify-observed', { node: 'a' })
  log.append('merged', { node: 'a' })
  const entries = log.entries()
  assert.deepEqual(kindsOf(entries), ['run', 'dispatched', 'series-done', 'returned', 'approved', 'verify-observed', 'merged'])
  for (const e of entries) assert.ok(typeof e.kind === 'string' && Number.isInteger(e.seq), JSON.stringify(e))
  const seqs = entries.map((e) => e.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
  assert.deepEqual(kindsOf(executionLog(repo, E, S).entries()), kindsOf(entries))
})

test("another execution's records are not in entries()", (t) => {
  const repo = store(t)
  const other = executionLog(repo, E, OTHER)
  other.append('dispatched', { node: 'a' })
  other.append('message', { node: 'a', ...MESSAGE })
  other.append('returned', { dispatch: 'd1' })
  other.append('series-done', { node: 'a' })
  assert.deepEqual(executionLog(repo, E, S).entries(), [])
})

test("a message with execution '' is in every execution's entries(), and no other event of no execution is", (t) => {
  const repo = store(t)
  seedLeaf(repo)
  append(repo, E, 'events', { kind: 'noted', node: 'a', execution: '', by: 'session', text: 'x' })
  const { seqs: [seq] } = append(repo, E, 'events', { kind: 'message', node: 'a', execution: '', ...MESSAGE })
  for (const stamp of [S, OTHER]) {
    const entries = executionLog(repo, E, stamp).entries()
    assert.deepEqual(entries.map((e) => [e.kind, e.seq]), [['message', seq]])
  }
})

test('a field named kind throws and writes nothing', (t) => {
  const repo = store(t)
  const log = executionLog(repo, E, S)
  assert.throws(() => log.append('fault', { node: '', channel: 'role', kind: 'role' }), /fault/)
  assert.throws(() => log.append('noted', { node: 'a', kind: 'x' }), /noted/)
  assert.equal(lines(repo, 'state:' + S).length, 0)
  assert.equal(lines(repo, 'events').length, 0)
  assert.deepEqual(log.entries(), [])
})

test('an event without a string node throws naming the kind and writes nothing', (t) => {
  const repo = store(t)
  const log = executionLog(repo, E, S)
  assert.throws(() => log.append('noted', { by: 'code', text: 'x' }), /noted/)
  assert.throws(() => log.append('message', { ...MESSAGE, node: 3 }), /message/)
  assert.equal(lines(repo, 'events').length, 0)
  assert.deepEqual(log.entries(), [])
})

test('a port for a name that is not a stamp throws', (t) => {
  const repo = store(t)
  assert.throws(() => executionLog(repo, E, 'latest'), /stamp/)
  assert.throws(() => executionLog(repo, E, ''), /stamp/)
})

test('a refused write throws naming the kind', (t) => {
  const repo = store(t)
  const log = executionLog(repo, E, S)
  mkdirSync(join(executionDir(repo, E, S), 'state.jsonl'), { recursive: true })
  assert.throws(() => log.append('gate', { target: '.', head_sha: 'abc', passed: true }), /refused a gate record/)
})

test('a refused append changes neither entries() nor the counter', (t) => {
  const repo = store(t)
  const log = executionLog(repo, E, S)
  const { seq: before } = log.append('dispatched', { node: 'a' })
  mkdirSync(join(executionDir(repo, E, S), 'state.jsonl'), { recursive: true })
  assert.throws(() => log.append('returned', { dispatch: 'd1' }), /returned/)
  assert.deepEqual(kindsOf(log.entries()), ['dispatched'])
  assert.equal(log.append('approved', { node: 'a' }).seq, before + 1)
})

test('an append is in the very next entries()', (t) => {
  const repo = store(t)
  const log = executionLog(repo, E, S)
  const { seq } = log.append('step', { key: 'k1', value: { done: true } })
  const last = log.entries().at(-1)
  assert.equal(last.kind, 'step')
  assert.equal(last.seq, seq)
  assert.deepEqual(last.value, { done: true })
})

test('a torn last line is set apart before the next append', (t) => {
  const repo = store(t)
  mkdirSync(executionDir(repo, E, S), { recursive: true })
  appendFileSync(join(executionDir(repo, E, S), 'state.jsonl'), '{"kind":"run","seq":', 'utf8')
  const log = executionLog(repo, E, S)
  assert.deepEqual(log.entries(), [])
  const { seq } = log.append('run', { program: 'execute', scope: {}, pid: 1 })
  assert.deepEqual(executionLog(repo, E, S).entries().map((e) => [e.kind, e.seq]), [['run', seq]])
  assert.equal(readLog(repo, E, 'state:' + S).malformed, 1)
})

test('a lost counter file is rebuilt above every seq on disk', (t) => {
  const repo = store(t)
  const log = executionLog(repo, E, S)
  const seqs = [log.append('dispatched', { node: 'a' }), log.append('returned', { dispatch: 'd1' }), log.append('series-done', { node: 'a' })].map((o) => o.seq)
  rmSync(join(effortStateDir(repo, E), 'seq'))
  assert.equal(log.append('approved', { node: 'a' }).seq, Math.max(...seqs) + 1)
})

test('two ports on one execution each mirror only their own appends; a port made after sees both', (t) => {
  const repo = store(t)
  const first = executionLog(repo, E, S)
  const second = executionLog(repo, E, S)
  const x = first.append('returned', { dispatch: 'd1' }).seq
  const y = second.append('returned', { dispatch: 'd2' }).seq
  assert.deepEqual(first.entries().map((e) => e.seq), [x])
  assert.deepEqual(second.entries().map((e) => e.seq), [y])
  assert.deepEqual(executionLog(repo, E, S).entries().map((e) => e.seq), [x, y])
})

test('deriveStatus ignores a message event on a leaf', (t) => {
  const repo = store(t)
  seedLeaf(repo)
  const log = executionLog(repo, E, S)
  const statusOfA = () => readTree(repo, E).status.get('a').status
  log.append('message', { node: 'a', ...MESSAGE })
  assert.equal(statusOfA(), 'planned')
  log.append('dispatched', { node: 'a', role: 'implementer', round: 1 })
  log.append('message', { node: 'a', ...MESSAGE })
  assert.equal(statusOfA(), 'active')
  log.append('approved', { node: 'a', head_sha: 'abc' })
  log.append('message', { node: 'a', ...MESSAGE })
  assert.equal(statusOfA(), 'approved')
})
