// test/boundaries-records.test.mjs — pins the records core of the in-process boundaries: the
// builders, which records are not yet the node's word (`freshRecords`), faults and the drift park
// they carry, the nodes a run holds, the stops a call reports, an execution's context, and
// `recordAll`, which appends only the fresh records through the execution's log port.
//
// Design: docs/DESIGN.md#boundaries and docs/DESIGN.md#faults.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  approved, escalated, executionContext, fault, faultRecords, freshRecords, heldOf, message, parked, recordAll, stopsOf,
} from '../lib/boundaries/records.mjs'
import { executionLog, readLog } from '../lib/ledger.mjs'
import { acquireAsync, heldBy } from '../lib/locks.mjs'
import { executionDir } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const S = '20261005-120000'

function store(t) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-boundaries-records-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const out = seedTree(repo, E, [
    { id: '.', kind: 'composite', title: 't', defines: [{ id: 'D1', text: 'do it' }] },
    { id: 'a', kind: 'leaf', title: 'do a', rigor: 'tdd', expects: ['a.mjs'], decisions: ['D1'], acceptance: [{ text: 'a works', check: 'node --test', decisions: ['D1'] }] },
    { id: 'b', kind: 'leaf', title: 'do b', rigor: 'tdd', expects: ['b.mjs'], decisions: ['D1'], acceptance: [{ text: 'b works', check: 'node --test', decisions: ['D1'] }] },
  ])
  assert.equal(out.ok, true, JSON.stringify(out))
  return repo
}

/** What `recordAll` reads: the tree and this execution's state and journal, from disk. */
function disk(repo) {
  const tree = readTree(repo, E)
  return {
    nodes: tree.nodes, status: tree.status, events: tree.events,
    state: readLog(repo, E, 'state:' + S).entries, journal: readLog(repo, E, 'journal:' + S).entries,
  }
}

const fresh = (repo, records) => freshRecords(records, disk(repo))
const write = (repo, record) => executionLog(repo, E, S).append(record.kind, record.fields)

// ------------------------------------------------------------------ builders

test('each builder returns its kind and fields, and no field is named kind', () => {
  const built = [
    [escalated('a', 'blocked', 'why', 'd1'), 'escalated', { node: 'a', reason: 'blocked', detail: 'why', said: 'd1' }],
    [parked('a', 'needs_decision', 'which?', 'd2'), 'parked', { node: 'a', return: 'needs_decision', question: 'which?', said: 'd2' }],
    [approved('a', 'h1', 2, false), 'approved', { node: 'a', head_sha: 'h1', review_rounds: 2, at_integration: false }],
    [message('a', 'producer:a', 'failures', { failing: ['t1'] }, 3), 'message', { node: 'a', thread: 'producer:a', from: 'code', msg: 'failures', payload: { failing: ['t1'] }, round: 3 }],
    [message('a', 'producer:a', 'findings', {}, 1, 'reviewer'), 'message', { node: 'a', thread: 'producer:a', from: 'reviewer', msg: 'findings', payload: {}, round: 1 }],
    [fault('a', 'role', 'no return'), 'fault', { node: 'a', channel: 'role', detail: 'no return' }],
  ]
  for (const [record, kind, fields] of built) {
    assert.equal(record.kind, kind)
    assert.deepEqual(record.fields, fields)
    assert.equal(Object.hasOwn(record.fields, 'kind'), false, kind + ' fields hold kind')
  }
})

test('a stop names no said when none is given, and its text is cut to length', () => {
  assert.equal(Object.hasOwn(escalated('a', 'blocked').fields, 'said'), false)
  assert.equal(Object.hasOwn(parked('a', 'needs_decision').fields, 'said'), false)
  assert.equal(escalated('a', 'blocked').fields.detail, '')
  assert.equal(parked('a', 'needs_decision').fields.question, '')
  assert.equal(escalated('a', 'blocked', 'x'.repeat(3000)).fields.detail.length, 2000)
  assert.equal(parked('a', 'needs_decision', 'x'.repeat(3000)).fields.question.length, 2000)
  assert.equal(fault('a', 'program', 'x'.repeat(3000)).fields.detail.length, 500)
  assert.equal(fault('a', 'program').fields.detail, '')
})

// ------------------------------------------------------------------ freshRecords

test('a stop stands while it is the node\'s word, and lands again once a replan clears it', (t) => {
  const repo = store(t)
  write(repo, { kind: 'dispatched', fields: { node: 'a', round: 1 } })
  write(repo, escalated('a', 'blocked'))
  assert.deepEqual(fresh(repo, [escalated('a', 'blocked', 'again')]), [], 'the same escalation while it stands')
  assert.equal(fresh(repo, [escalated('a', 'fix_without_commits')]).length, 1, 'another reason is a new stop')
  assert.equal(fresh(repo, [parked('a', 'needs_decision')]).length, 1, 'a park is not the escalation')
  write(repo, { kind: 'replanned', fields: { node: 'a', reason: 'retry' } })
  assert.equal(fresh(repo, [escalated('a', 'blocked')]).length, 1, 'escalated again after a retry')
})

test('a park stands while it is the node\'s word with the same return', (t) => {
  const repo = store(t)
  write(repo, parked('a', 'needs_decision'))
  assert.deepEqual(fresh(repo, [parked('a', 'needs_decision')]), [])
  assert.equal(fresh(repo, [parked('a', 'contract_changed')]).length, 1)
  assert.equal(fresh(repo, [parked('b', 'needs_decision')]).length, 1, 'another node')
})

test('an approval stands at the same head, and lands again at another head or after a new round', (t) => {
  const repo = store(t)
  write(repo, { kind: 'dispatched', fields: { node: 'a', round: 1 } })
  write(repo, approved('a', 'h1', 1, false))
  assert.deepEqual(fresh(repo, [approved('a', 'h1', 1, false)]), [], 'decided again after a crash')
  assert.equal(fresh(repo, [approved('a', 'h2', 1, false)]).length, 1, 'another head')
  write(repo, { kind: 'dispatched', fields: { node: 'a', round: 2 } })
  assert.equal(fresh(repo, [approved('a', 'h1', 2, false)]).length, 1, 'approved again after a new round')
})

test('a stopped or merged node is not approved under its stop', (t) => {
  const repo = store(t)
  write(repo, escalated('a', 'blocked'))
  write(repo, { kind: 'merged', fields: { node: 'b', merged_sha: 'm1' } })
  assert.deepEqual(fresh(repo, [approved('a', 'h1', 1, false), approved('b', 'h1', 1, false)]), [])
})

test('claims stand at the same head while nothing cleared them', (t) => {
  const repo = store(t)
  const claims = (head) => ({ kind: 'claims', fields: { node: '.', head_sha: head, review: 'done', claims: [{ claim: 'c1', ruling: 'met' }], said: 'd1' } })
  write(repo, claims('h1'))
  assert.deepEqual(fresh(repo, [claims('h1')]), [], 'the same head')
  assert.equal(fresh(repo, [claims('h2')]).length, 1, 'another head')
  assert.equal(fresh(repo, [{ ...claims('h1'), fields: { ...claims('h1').fields, review: 'partial' } }]).length, 1, 'another review')
  write(repo, { kind: 'replanned', fields: { node: '.', reason: 'spec_rederived' } })
  assert.equal(fresh(repo, [claims('h1')]).length, 1, 'cleared by a replan')
})

test('a fault lands once per node and channel in a run, and again after a new run', (t) => {
  const repo = store(t)
  write(repo, { kind: 'run', fields: { program: 'execute', scope: { effort: E, folder: '.' }, pid: 1 } })
  write(repo, fault('a', 'program', 'threw'))
  assert.deepEqual(fresh(repo, [fault('a', 'program', 'threw again')]), [], 'the same node and channel in the run')
  assert.equal(fresh(repo, [fault('a', 'role')]).length, 1, 'another channel')
  assert.equal(fresh(repo, [fault('b', 'program')]).length, 1, 'another node')
  write(repo, { kind: 'run', fields: { program: 'execute', scope: { effort: E, folder: '.' }, pid: 2 } })
  assert.equal(fresh(repo, [fault('a', 'program')]).length, 1, 'a new run')
})

test('a drift ruling lands once per node, contract and head; a stale ruling once per node and base', (t) => {
  const repo = store(t)
  const drift = (head, contract = 'C1') => ({ kind: 'drift-ruled', fields: { node: 'a', contract, head_sha: head, ruling: 'unaffected', why: 'w', said: 'd1' } })
  const stale = (base) => ({ kind: 'stale-ruled', fields: { node: 'a', base_now: base, ruling: 'unaffected', why: 'w', said: 'd2' } })
  write(repo, drift('h1'))
  write(repo, stale('b1'))
  assert.deepEqual(fresh(repo, [drift('h1'), stale('b1')]), [])
  assert.equal(fresh(repo, [drift('h2')]).length, 1, 'another head')
  assert.equal(fresh(repo, [drift('h1', 'C2')]).length, 1, 'another contract')
  assert.equal(fresh(repo, [stale('b2')]).length, 1, 'another base')
})

test('a message lands once per node, thread, round and msg', (t) => {
  const repo = store(t)
  write(repo, message('a', 'producer:a', 'failures', { failing: ['t1'] }, 2))
  assert.deepEqual(fresh(repo, [message('a', 'producer:a', 'failures', { failing: ['t2'] }, 2)]), [], 'the same key, another payload')
  assert.equal(fresh(repo, [message('a', 'producer:a', 'failures', {}, 3)]).length, 1, 'another round')
  assert.equal(fresh(repo, [message('a', 'producer:a', 'findings', {}, 2)]).length, 1, 'another msg')
  assert.equal(fresh(repo, [message('a', 'producer:b', 'failures', {}, 2)]).length, 1, 'another thread')
  assert.equal(fresh(repo, [message('b', 'producer:a', 'failures', {}, 2)]).length, 1, 'another node')
})

test('a series-done lands once per node and head; an authored once per node and sha', (t) => {
  const repo = store(t)
  const done = (head) => ({ kind: 'series-done', fields: { node: 'a', branch: 'agentics/e1--a', head_sha: head, commits: [] } })
  const authored = (sha) => ({ kind: 'authored', fields: { node: 'a', role: 'test-author', round: 1, sha } })
  write(repo, done('h1'))
  write(repo, authored('s1'))
  assert.deepEqual(fresh(repo, [done('h1'), authored('s1')]), [])
  assert.equal(fresh(repo, [done('h2')]).length, 1)
  assert.equal(fresh(repo, [authored('s2')]).length, 1)
})

test('one batch deciding a record twice lands it once', (t) => {
  const repo = store(t)
  const out = fresh(repo, [approved('a', 'h1', 1, false), approved('a', 'h1', 1, false), fault('b', 'role'), fault('b', 'role')])
  assert.deepEqual(out.map((r) => r.kind), ['approved', 'fault'])
})

test('a record of a kind with no rule is always fresh', (t) => {
  const repo = store(t)
  const breach = { kind: 'breach_reverted', fields: { node: 'a', paths: ['x.mjs'], sha: 's1' } }
  write(repo, breach)
  assert.equal(fresh(repo, [breach]).length, 1)
})

// ------------------------------------------------------------------ faults and holds

test('faultRecords is the fault alone when no drift ruling waits on the node', (t) => {
  const repo = store(t)
  const out = faultRecords('a', 'program', 'threw', disk(repo))
  assert.deepEqual(out, [fault('a', 'program', 'threw')])
})

test('faultRecords parks contract_drift with the ruler\'s said when an affected ruling is unanswered', (t) => {
  const repo = store(t)
  write(repo, { kind: 'drift-ruled', fields: { node: 'a', contract: 'C1', head_sha: 'h1', ruling: 'affected', why: 'w', said: 'ruler-1' } })
  const out = faultRecords('a', 'checkout', 'moved', disk(repo))
  assert.deepEqual(out, [fault('a', 'checkout', 'moved'), parked('a', 'contract_drift', '', 'ruler-1')])
})

test('faultRecords adds no park for an unaffected ruling, nor for one answered on disk', (t) => {
  const repo = store(t)
  write(repo, { kind: 'drift-ruled', fields: { node: 'b', contract: 'C1', head_sha: 'h1', ruling: 'unaffected', why: 'w', said: 'r1' } })
  assert.deepEqual(faultRecords('b', 'role', '', disk(repo)), [fault('b', 'role', '')], 'unaffected')
  write(repo, { kind: 'drift-ruled', fields: { node: 'a', contract: 'C1', head_sha: 'h1', ruling: 'affected', why: 'w', said: 'r2' } })
  write(repo, { kind: 'replanned', fields: { node: 'a', reason: 'drift' } })
  assert.deepEqual(faultRecords('a', 'role', '', disk(repo)), [fault('a', 'role', '')], 'answered by a replan')
})

test('heldOf reads only the faults after the latest run', (t) => {
  const repo = store(t)
  write(repo, fault('a', 'program'))
  assert.deepEqual([...heldOf(disk(repo).state)], ['a'], 'no run yet: every fault holds')
  write(repo, { kind: 'run', fields: { program: 'execute', scope: {}, pid: 1 } })
  write(repo, fault('b', 'role'))
  write(repo, fault('b', 'checkout'))
  const held = heldOf(disk(repo).state)
  assert.ok(held instanceof Set)
  assert.deepEqual([...held], ['b'])
  write(repo, { kind: 'run', fields: { program: 'execute', scope: {}, pid: 2 } })
  assert.equal(heldOf(disk(repo).state).size, 0)
})

test('stopsOf reports escalations, parks and faults as handles, and nothing else', () => {
  const stops = stopsOf([
    escalated('a', 'blocked', 'd', 'x1'), parked('b', 'needs_decision'), fault('a', 'role', 'gone'),
    approved('a', 'h', 1, false), message('a', 't', 'failures', {}, 1),
  ])
  assert.deepEqual(stops, [
    { id: 'a', status: 'escalated', reason: 'blocked', said: 'x1' },
    { id: 'b', status: 'parked', reason: 'needs_decision', said: '' },
    { id: 'a', status: 'held', reason: 'role', said: '' },
  ])
})

// ------------------------------------------------------------------ the execution context

test('executionContext names the execution\'s directory and reads its envelope when asked', (t) => {
  const repo = store(t)
  const log = executionLog(repo, E, S)
  const xc = executionContext({ repo, effort: E, execution: S, log })
  assert.equal(xc.dir, executionDir(repo, E, S))
  assert.equal(xc.log, log)
  assert.equal(xc.repo, repo)
  assert.equal(xc.effort, E)
  assert.equal(xc.execution, S)
  assert.equal(xc.envelope(), null, 'no execution.json yet')
  mkdirSync(xc.dir, { recursive: true })
  writeFileSync(join(xc.dir, 'execution.json'), JSON.stringify({ stamp: S, root: '.' }))
  assert.deepEqual(xc.envelope(), { stamp: S, root: '.' }, 'written after the context was made')
})

// ------------------------------------------------------------------ recordAll

test('recordAll appends each fresh record through the log port, into its file', (t) => {
  const repo = store(t)
  const xc = executionContext({ repo, effort: E, execution: S, log: executionLog(repo, E, S) })
  const out = recordAll(xc, [approved('a', 'h1', 1, false), fault('b', 'role', 'gone')])
  assert.deepEqual(out.recorded.map((r) => r.kind), ['approved', 'fault'])
  const entries = xc.log.entries()
  for (const r of out.recorded) {
    const entry = entries.find((e) => e.seq === r.seq)
    assert.equal(entry.kind, r.kind)
    assert.equal(entry.node, r.fields.node)
  }
  assert.equal(readLog(repo, E, 'events').entries.find((e) => e.kind === 'approved').execution, S)
  assert.equal(readLog(repo, E, 'state:' + S).entries.filter((e) => e.kind === 'fault').length, 1)
  assert.deepEqual(out.stops, [{ id: 'b', status: 'held', reason: 'role', said: '' }])
})

test('recordAll run again appends nothing and reports the same stops', (t) => {
  const repo = store(t)
  const xc = executionContext({ repo, effort: E, execution: S, log: executionLog(repo, E, S) })
  const records = [escalated('a', 'blocked', 'd', 'x1'), message('b', 'producer:b', 'failures', {}, 1), fault('b', 'program')]
  const first = recordAll(xc, records)
  const count = xc.log.entries().length
  const again = recordAll(xc, records)
  assert.deepEqual(again.recorded, [])
  assert.equal(xc.log.entries().length, count)
  assert.deepEqual(again.stops, first.stops)
})

test('recordAll reads the records on disk, not only its own port\'s', (t) => {
  const repo = store(t)
  const xc = executionContext({ repo, effort: E, execution: S, log: executionLog(repo, E, S) })
  write(repo, fault('a', 'host_error'))
  assert.deepEqual(recordAll(xc, [fault('a', 'host_error')]).recorded, [])
})

test('recordAll with no records appends nothing', (t) => {
  const repo = store(t)
  const xc = executionContext({ repo, effort: E, execution: S, log: executionLog(repo, E, S) })
  assert.deepEqual(recordAll(xc, []), { recorded: [], stops: [] })
  assert.equal(xc.log.entries().length, 0)
})

test('a fault recorded gives its node\'s slot in this execution back', async (t) => {
  const repo = store(t)
  const on = () => true
  assert.equal((await acquireAsync(repo, { effort: E, execution: S, node: 'a', holderActive: on, waitMs: 0 })).ok, true)
  assert.equal((await acquireAsync(repo, { effort: E, execution: S, node: 'b', holderActive: on, waitMs: 0 })).ok, true)
  const xc = executionContext({ repo, effort: E, execution: S, log: executionLog(repo, E, S) })
  recordAll(xc, [fault('a', 'program')])
  assert.deepEqual(heldBy(repo).slots.map((s) => s.node), ['b'])
})
