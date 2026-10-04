// test/scripted-runner.test.mjs — pins the scripted runner programs are tested against: it answers
// each call from a script, in order, and records exactly as the real runner does.
//
// Design: docs/DESIGN.md#self-checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dispatchedEntry, returnedEntry } from '../lib/runner.mjs'
import { memoryLog } from './harness/memory-log.mjs'
import { scriptedRunner } from './harness/scripted-runner.mjs'

const call = (thread = 'producer') => ({
  dispatch: 'a.implementer.' + thread + '.r1', node: 'a', round: 1, thread: { key: thread, session: 's-' + thread, gen: 0 },
  role: { name: 'implementer', tools: ['Read'], systemPromptFile: 'x' }, cwd: '.', brief: 'do it', tier: { model: 'sonnet', effort: 'medium' },
  permissions: { allowed: [], disallowed: [] }, schema: {}, carries: [], dir: '.', resume: false,
})

test('calls are answered from the script in order', async () => {
  const log = memoryLog()
  const r = scriptedRunner({ 'implementer|a|producer': [{ output: { status: 'done', text: '1' } }, { output: { status: 'done', text: '2' } }] }, { log })
  assert.equal((await r.runAgent(call())).output.text, '1')
  assert.equal((await r.runAgent({ ...call(), resume: true })).output.text, '2')
  assert.equal(r.calls.length, 2)
})

test('a returned call is recorded as the real runner records it', async () => {
  const log = memoryLog()
  const r = scriptedRunner({ 'implementer|a|producer': [{ output: { status: 'done', text: 'x' }, cost_total: 0.5 }] }, { log })
  await r.runAgent(call())
  const [d, ret] = log.entries()
  assert.equal(d.kind, 'dispatched')
  assert.deepEqual(Object.keys(d).filter((k) => k !== 'kind' && k !== 'seq').sort(), Object.keys(dispatchedEntry(call(), { pid: 0, session: 's' })).sort())
  assert.equal(ret.kind, 'returned')
  assert.deepEqual(Object.keys(ret).filter((k) => k !== 'kind' && k !== 'seq').sort(), Object.keys(returnedEntry(call(), { session: 's', status: 'returned' })).sort())
  assert.equal(ret.status, 'returned')
})

test('a scripted host stop records a stop and no return', async () => {
  const log = memoryLog()
  const r = scriptedRunner({ 'implementer|a|producer': [{ status: 'stopped', cause: 'usage_limit', until: '5pm' }] }, { log })
  const out = await r.runAgent(call())
  assert.equal(out.status, 'stopped')
  assert.deepEqual(log.entries().map((e) => e.kind), ['dispatched', 'host_stop'])
})

test('a scripted failure records a failed return', async () => {
  const log = memoryLog()
  const r = scriptedRunner({ 'implementer|a|producer': [{ status: 'failed', cause: 'host_error' }] }, { log })
  const out = await r.runAgent(call())
  assert.equal(out.status, 'failed')
  assert.equal(log.entries().at(-1).status, 'failed')
})

test('a call the script does not cover throws, naming its key', async () => {
  const r = scriptedRunner({}, { log: memoryLog() })
  await assert.rejects(r.runAgent(call('tests')), /implementer\|a\|tests/)
})

test('threads are scripted separately', async () => {
  const log = memoryLog()
  const r = scriptedRunner({
    'implementer|a|producer': [{ output: { status: 'done', text: 'p' } }],
    'implementer|a|tests': [{ output: { status: 'done', text: 't' } }],
  }, { log })
  assert.equal((await r.runAgent(call('tests'))).output.text, 't')
  assert.equal((await r.runAgent(call('producer'))).output.text, 'p')
})
