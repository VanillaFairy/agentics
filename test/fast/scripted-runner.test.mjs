// test/scripted-runner.test.mjs — pins the scripted runner programs are tested against: the real
// runAgent over a scripted CLI, each start playing the next step of its role, node and thread, so a
// program test sees the records, stored returns, retries, parts and renewals production does.
//
// Design: docs/DESIGN.md#self-checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dispatchedEntry, returnedEntry } from '../../lib/runner.mjs'
import { dispatchKey, returnPath, sessionOf } from '../../lib/store.mjs'
import { memoryLog } from './harness/memory-log.mjs'
import { scriptedRunner } from './harness/scripted-runner.mjs'

const ids = { effort: '', execution: '20260101-000000-test', node: '', role: 'scout', thread: 'plan' }
const S = sessionOf(ids)
const NEXT = sessionOf({ ...ids, gen: 1 })
const SCHEMA = { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] }
const KEY = 'scout||plan'

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-scripted-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const callIn = (dir, { thread = 'plan', round = 1, ...over } = {}) => ({
  dispatch: dispatchKey({ node: '', role: 'scout', thread, round }), node: '', round,
  thread: { key: thread, session: sessionOf({ ...ids, thread }), gen: 0, nextSession: sessionOf({ ...ids, thread, gen: 1 }) },
  role: { name: 'scout', tools: ['Read', 'Grep', 'Glob'], systemPromptFile: join(dir, 'scout.md') },
  cwd: dir, brief: 'Find where the store is written.', tier: { model: 'sonnet', effort: 'medium' },
  permissions: { allowed: ['Read', 'Grep', 'Glob'], disallowed: [] }, schema: SCHEMA, carries: [], dir, resume: false, freshBrief: '',
  ...over,
})

const ofKind = (log, kind) => log.entries().filter((e) => e.kind === kind)
const fieldsOf = (row) => { const { kind, seq, ...rest } = row; return rest }

test("a step's output is the call's output and is stored at returnPath", async (t) => {
  const dir = scratch(t)
  const output = { items: ['lib/store.mjs:12'] }
  const r = scriptedRunner({ [KEY]: [{ output }] }, { log: memoryLog() })
  const call = callIn(dir)
  const out = await r.runAgent(call)
  assert.equal(out.status, 'returned')
  assert.deepEqual(out.output, output)
  assert.deepEqual(JSON.parse(readFileSync(returnPath(dir, call.dispatch), 'utf8')), output)
})

test('a call records dispatched then returned exactly as runAgent writes them', async (t) => {
  const dir = scratch(t)
  const log = memoryLog()
  const usage = { input_tokens: 10, output_tokens: 5 }
  const denials = [{ tool_name: 'Write', tool_input: { file_path: 'x' } }]
  const r = scriptedRunner({ [KEY]: [{ output: { items: [] }, usage, cost_total: 0.5, denials }] }, { log })
  const call = callIn(dir)
  await r.runAgent(call)
  const [d, ret] = log.entries()
  assert.deepEqual([d.kind, ret.kind], ['dispatched', 'returned'])
  assert.deepEqual(fieldsOf(d), dispatchedEntry(call, { pid: d.pid, session: S }))
  assert.ok(Number.isInteger(d.pid) && d.pid > 0, 'the CLI start reports a pid')
  assert.deepEqual(fieldsOf(ret), returnedEntry(call, { session: S, status: 'returned', usage, costTotal: 0.5, costUsd: 0.5, denials }))
})

test('steps are consumed in order per role, node and thread', async (t) => {
  const dir = scratch(t)
  const r = scriptedRunner({
    [KEY]: [{ output: { items: ['p1'] } }, { output: { items: ['p2'] } }],
    'scout||common': [{ output: { items: ['c1'] } }],
  }, { log: memoryLog() })
  assert.deepEqual((await r.runAgent(callIn(dir))).output.items, ['p1'])
  assert.deepEqual((await r.runAgent(callIn(dir, { thread: 'common' }))).output.items, ['c1'])
  assert.deepEqual((await r.runAgent(callIn(dir, { round: 2, resume: true }))).output.items, ['p2'])
})

test('a host stop records host_stop and no returned', async (t) => {
  const dir = scratch(t)
  for (const [cause, until] of [['rate_limit', ''], ['usage_limit', '5pm'], ['usage_limit', ''], ['overloaded', ''], ['network', '']]) {
    const log = memoryLog()
    const r = scriptedRunner({ [KEY]: [{ status: 'stopped', cause, until }] }, { log })
    const out = await r.runAgent(callIn(dir))
    assert.equal(out.status, 'stopped', cause)
    assert.equal(out.cause, cause)
    assert.deepEqual(log.entries().map((e) => e.kind), ['dispatched', 'host_stop'], cause)
    assert.deepEqual([ofKind(log, 'host_stop')[0].cause, ofKind(log, 'host_stop')[0].until], [cause, until], cause)
  }
})

test('a host error records a failed return', async (t) => {
  const dir = scratch(t)
  const log = memoryLog()
  const out = await scriptedRunner({ [KEY]: [{ status: 'failed', cause: 'host_error' }] }, { log }).runAgent(callIn(dir))
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'host_error')
  assert.deepEqual(ofKind(log, 'returned').map((e) => [e.status, e.cause]), [['failed', 'host_error']])
})

test('steps marked more are merged into one stored return with part records', async (t) => {
  const dir = scratch(t)
  const log = memoryLog()
  const r = scriptedRunner({ [KEY]: [{ output: { items: ['a'] }, more: true }, { output: { items: ['b'] } }] }, { log })
  const call = callIn(dir)
  const out = await r.runAgent(call)
  assert.deepEqual(out.output, { items: ['a', 'b'] })
  assert.deepEqual(JSON.parse(readFileSync(returnPath(dir, call.dispatch), 'utf8')), { items: ['a', 'b'] })
  assert.deepEqual(ofKind(log, 'returned').map((e) => e.status), ['part', 'returned'])
  assert.deepEqual(ofKind(log, 'dispatched').map((e) => e.session), [S, S])
  assert.equal(r.calls.length, 1)
})

test('a schema_failed step then an output step is one call retried in its own session', async (t) => {
  const dir = scratch(t)
  const log = memoryLog()
  const r = scriptedRunner({ [KEY]: [{ status: 'failed', cause: 'schema_failed' }, { output: { items: ['x'] } }] }, { log })
  const call = callIn(dir)
  const out = await r.runAgent(call)
  assert.equal(out.status, 'returned')
  assert.deepEqual(out.output, { items: ['x'] })
  assert.deepEqual(ofKind(log, 'dispatched').map((e) => [e.dispatch, e.session]), [[call.dispatch, S], [call.dispatch, S]])
  assert.deepEqual(ofKind(log, 'returned').map((e) => [e.status, e.cause]), [['failed', 'schema_failed'], ['returned', '']])
  assert.equal(r.calls.length, 1)
})

test('session_missing with a fresh brief renews the thread', async (t) => {
  const dir = scratch(t)
  const log = memoryLog()
  const r = scriptedRunner({ [KEY]: [{ status: 'failed', cause: 'session_missing' }, { output: { items: ['y'] } }] }, { log })
  const out = await r.runAgent(callIn(dir, { round: 2, resume: true, freshBrief: 'The thread brief, then its messages.' }))
  assert.equal(out.status, 'returned')
  assert.equal(out.session, NEXT)
  const [renewed] = ofKind(log, 'thread_renewed')
  assert.deepEqual([renewed.thread, renewed.gen, renewed.why], ['plan', 1, 'session_missing'])
  assert.deepEqual(ofKind(log, 'dispatched').map((e) => e.session), [S, NEXT])
})

test('a start with no step left rejects, naming its key', async (t) => {
  const dir = scratch(t)
  const r = scriptedRunner({ [KEY]: [{ output: { items: [] } }] }, { log: memoryLog() })
  await r.runAgent(callIn(dir))
  await assert.rejects(r.runAgent(callIn(dir, { round: 2, resume: true })), /scout\|\|plan/)
  await assert.rejects(r.runAgent(callIn(dir, { thread: 'tests' })), /scout\|\|tests/)
})

test('calls lists every call passed in', async (t) => {
  const dir = scratch(t)
  const r = scriptedRunner({ [KEY]: [{ output: { items: [] } }, { output: { items: [] } }] }, { log: memoryLog() })
  const first = callIn(dir)
  const second = callIn(dir, { round: 2, resume: true })
  await r.runAgent(first)
  await r.runAgent(second)
  assert.equal(r.calls.length, 2)
  assert.equal(r.calls[0], first)
  assert.equal(r.calls[1], second)
})
