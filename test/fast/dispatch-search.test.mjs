// test/fast/dispatch-search.test.mjs — pins what a search's dispatch hands the runner: its charge
// written after the role's body as the system prompt, and its tool server's config on the call and
// on the host's command line.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderMessage } from '../../lib/conversation.mjs'
import { dispatch, programContext, threadOf } from '../../lib/programs/common.mjs'
import { loadRole } from '../../lib/roles.mjs'
import { runAgent } from '../../lib/runner.mjs'
import { dispatchKey, writeWhole } from '../../lib/store.mjs'
import { memoryLog } from './harness/memory-log.mjs'
import { scriptedRunner } from './harness/scripted-runner.mjs'

const RUN = '20260101-000000-test'
const NOW = () => '2026-01-01T00:00:00.000Z'
const CHARGE = 'ASKS\n- guidance: the review guidance'
const CONFIG = 'C:/run/searches/probe~a/mcp-0a1b2c3d.json'
const RULING = { ruling: 'converging', why: 'the evidence still moves' }
const spec = (over = {}) => ({ role: 'ruler', schema: 'ruler_convergence', thread: 'ruler:t', brief: 'Rule it.', ...over })

/** A run's context over a scratch directory; `runnerOf(log)` builds the runner on the context's own log. */
function context(t, runnerOf) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-dispatch-search-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = memoryLog()
  return programContext({ intelligence: 'normal', repo: dir, run: RUN, dir, log, runAgent: runnerOf(log), now: NOW, sleep: async () => {}, env: {} })
}

test("a charge becomes the system prompt after the role's body", async (t) => {
  let runner
  const ctx = context(t, (log) => (runner = scriptedRunner({ 'ruler||ruler:t': [{ output: RULING }] }, { log })).runAgent)
  const out = await dispatch(ctx, spec({ charge: CHARGE }))
  assert.equal(out.status, 'returned')
  const [call] = runner.calls
  assert.equal(readFileSync(call.role.systemPromptFile, 'utf8'), loadRole('ruler').role.prompt + '\n\n' + CHARGE)
})

test("without a charge the system prompt is the role's body alone, and the call carries no config", async (t) => {
  let runner
  const ctx = context(t, (log) => (runner = scriptedRunner({ 'ruler||ruler:t': [{ output: RULING }] }, { log })).runAgent)
  await dispatch(ctx, spec())
  const [call] = runner.calls
  assert.equal(readFileSync(call.role.systemPromptFile, 'utf8'), loadRole('ruler').role.prompt)
  assert.equal(call.mcpConfig, '')
})

test("a dispatch's mcpConfig reaches the call and the host's command line", async (t) => {
  const starts = []
  const calls = []
  const result = (session) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: session,
    structured_output: RULING, usage: null, total_cost_usd: 0.001, permission_denials: [] })
  const spawnCli = async (args, { onSpawn }) => {
    starts.push(args)
    onSpawn(4242)
    return { code: 0, stdout: result(args[args.indexOf('--session-id') + 1]) + '\n', stderr: '' }
  }
  const ports = (log) => ({ spawnCli, log, fsx: { writeJson: writeWhole, remove() {} }, proc: { alive: () => false, kill() {} }, watch: null, now: NOW, env: {} })
  const ctx = context(t, (log) => (call) => { calls.push(call); return runAgent(call, ports(log)) })
  const out = await dispatch(ctx, spec({ mcpConfig: CONFIG }))
  assert.equal(out.status, 'returned')
  assert.equal(calls[0].mcpConfig, CONFIG)
  assert.equal(starts[0][starts[0].indexOf('--mcp-config') + 1], CONFIG)
})

// ------------------------------------------------------------------ a search thread that renews when its prompt or cwd changed

const THREAD = 'ruler:t'
const CUT_OFF = renderMessage({ msg: 'cut_off' })
const SEPARATOR = '\n\n---\n\n'
const LIMIT = 'Claude AI usage limit reached; resets at 5pm.'
const keyOf = (round) => dispatchKey({ node: '', role: 'ruler', thread: THREAD, round })
const valueAfter = (args, flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }

/**
 * A run over the real runner and a fake host. `steps[n]` is what the host's n-th start does: 'return' (the
 * default) or 'stop' (a usage limit). `starts` holds each start's arguments, stdin, cwd and session.
 */
function host(t, steps = []) {
  const starts = []
  const calls = []
  const spawnCli = async (args, { onSpawn, stdin, cwd }) => {
    const step = steps[starts.length] ?? 'return'
    const session = valueAfter(args, '--resume') ?? valueAfter(args, '--session-id')
    starts.push({ args, stdin, cwd, session })
    onSpawn(4000 + starts.length)
    if (step === 'stop') return { code: 1, stdout: '', stderr: LIMIT }
    return { code: 0, stderr: '', stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: session,
      structured_output: RULING, usage: null, total_cost_usd: 0.001, permission_denials: [] }) + '\n' }
  }
  const ports = (log) => ({ spawnCli, log, fsx: { writeJson: writeWhole, remove() {} }, proc: { alive: () => false, kill() {} }, watch: null, now: NOW, env: {} })
  const ctx = context(t, (log) => (call) => { calls.push(call); return runAgent(call, ports(log)) })
  const renewals = () => ctx.log.entries().filter((e) => e.kind === 'thread_renewed')
  return { ctx, starts, calls, renewals }
}

const round = (n, over = {}) => spec({ thread: THREAD, round: n, brief: 'brief ' + n, ...over })
const renewing = (n, over = {}) => round(n, { renewOnChange: true, ...over })

/** Record a dispatch as an earlier run left it: started, with `over` laid on the fields it writes. */
function dispatchedBefore(ctx, n, over = {}) {
  ctx.log.append('dispatched', { dispatch: keyOf(n), node: '', round: n, thread: THREAD, role: 'ruler', model: 'opus', effort: '',
    session: 'older-session', brief_digest: 'x', brief_parts: {}, carries: [], pid: 1, ...over })
}

/** The `dispatched` entry the first real dispatch of a context wrote. */
const firstDispatched = (ctx) => ctx.log.entries().find((e) => e.kind === 'dispatched')

test('dispatch passes refits through', async (t) => {
  const { ctx, calls } = host(t)
  await dispatch(ctx, round(1, { refits: ['a', 'b'] }))
  await dispatch(ctx, round(2))
  assert.deepEqual(calls[0].refits, ['a', 'b'])
  assert.deepEqual(calls[1].refits, [], 'no refits is an empty list')
})

test('a dispatched entry records the prompt digest and the cwd of its call', async (t) => {
  const { ctx, calls } = host(t)
  await dispatch(ctx, round(1, { charge: 'A', cwd: 'C:/elsewhere' }))
  const entry = firstDispatched(ctx)
  assert.ok(calls[0].role.systemPromptFile.endsWith('-' + entry.prompt + '.md'), 'the digest is the one in the system-prompt file name')
  assert.equal(entry.cwd, 'C:/elsewhere')
})

test('renewOnChange renews on a new prompt', async (t) => {
  const { ctx, starts, renewals } = host(t)
  await dispatch(ctx, renewing(1, { charge: 'A' }))
  assert.equal(renewals().length, 0, 'a first call renews nothing')
  const out = await dispatch(ctx, renewing(2, { charge: 'B' }))
  assert.equal(out.status, 'returned')
  assert.deepEqual(renewals().map((e) => [e.thread, e.gen, e.why]), [[THREAD, 1, 'prompt_changed']])
  assert.ok(!starts[1].args.includes('--resume'), 'the changed thread starts fresh')
  assert.notEqual(starts[1].session, starts[0].session)
  assert.equal(starts[1].session, out.session)
  assert.equal(starts[1].stdin, 'brief 2')
})

test('renewOnChange renews on a new cwd', async (t) => {
  const { ctx, starts, renewals } = host(t)
  await dispatch(ctx, renewing(1, { cwd: 'C:/checkout-a' }))
  await dispatch(ctx, renewing(2, { cwd: 'C:/checkout-b' }))
  assert.deepEqual(renewals().map((e) => e.why), ['cwd_changed'])
  assert.ok(!starts[1].args.includes('--resume'))
  assert.equal(starts[1].cwd, 'C:/checkout-b')
})

test('renewOnChange resumes a thread nothing changed on', async (t) => {
  const { ctx, starts, renewals } = host(t)
  await dispatch(ctx, renewing(1, { charge: 'A', cwd: 'C:/checkout-a' }))
  await dispatch(ctx, renewing(2, { charge: 'A', cwd: 'C:/checkout-a' }))
  assert.equal(renewals().length, 0)
  assert.equal(valueAfter(starts[1].args, '--resume'), starts[0].session)
})

test('prompt is checked before cwd', async (t) => {
  const { ctx, renewals } = host(t)
  await dispatch(ctx, renewing(1, { charge: 'A', cwd: 'C:/checkout-a' }))
  await dispatch(ctx, renewing(2, { charge: 'B', cwd: 'C:/checkout-b' }))
  assert.deepEqual(renewals().map((e) => e.why), ['prompt_changed'])
})

test('prompt change outranks started', async (t) => {
  const { ctx, starts, renewals } = host(t)
  await dispatch(ctx, renewing(1, { charge: 'A' }))
  const first = firstDispatched(ctx)
  dispatchedBefore(ctx, 2, { prompt: first.prompt, cwd: first.cwd, session: starts[0].session })
  const out = await dispatch(ctx, renewing(2, { charge: 'B' }))
  assert.equal(out.status, 'returned')
  assert.deepEqual(renewals().map((e) => e.why), ['prompt_changed'])
  assert.ok(!starts[1].args.includes('--resume'), 'a started call whose prompt changed is not resumed')
  assert.notEqual(starts[1].session, starts[0].session)
  assert.equal(starts[1].stdin, CUT_OFF + SEPARATOR + 'brief 2')
})

test('a started call whose prompt did not change is resumed without a renewal', async (t) => {
  const { ctx, starts, renewals } = host(t)
  await dispatch(ctx, renewing(1, { charge: 'A' }))
  const first = firstDispatched(ctx)
  dispatchedBefore(ctx, 2, { prompt: first.prompt, cwd: first.cwd, session: starts[0].session })
  await dispatch(ctx, renewing(2, { charge: 'A' }))
  assert.equal(renewals().length, 0)
  assert.equal(valueAfter(starts[1].args, '--resume'), starts[0].session)
  assert.equal(starts[1].stdin, CUT_OFF, 'without resendOnCutOff the cut-off message goes alone')
})

test('an old dispatched entry is unchanged', async (t) => {
  const { ctx, starts, renewals } = host(t)
  const session = threadOf(ctx, { role: 'ruler', thread: THREAD }).session
  dispatchedBefore(ctx, 1, { session })
  ctx.log.append('returned', { dispatch: keyOf(1), session, status: 'returned', cause: '', usage: null, cost_total: null, cost_usd: null, denials: [] })
  await dispatch(ctx, renewing(2, { charge: 'B', cwd: 'C:/elsewhere' }))
  assert.equal(renewals().length, 0, 'an entry with no prompt or cwd is not a change')
  assert.equal(valueAfter(starts[0].args, '--resume'), session)
})

test('other threads keep resuming', async (t) => {
  const { ctx, starts, renewals } = host(t)
  await dispatch(ctx, round(1, { charge: 'A', cwd: 'C:/checkout-a' }))
  await dispatch(ctx, round(2, { charge: 'B', cwd: 'C:/checkout-b' }))
  assert.equal(renewals().length, 0, 'without renewOnChange a changed prompt or cwd is no reason to renew')
  assert.equal(valueAfter(starts[1].args, '--resume'), starts[0].session)
})

test('a prompt changed back does not resurrect an old session', async (t) => {
  const { ctx, starts, renewals } = host(t)
  await dispatch(ctx, renewing(1, { charge: 'A' }))
  await dispatch(ctx, renewing(2, { charge: 'B' }))
  await dispatch(ctx, renewing(3, { charge: 'A' }))
  assert.deepEqual(renewals().map((e) => [e.gen, e.why]), [[1, 'prompt_changed'], [2, 'prompt_changed']])
  assert.ok(!starts[2].args.includes('--resume'))
  assert.equal(new Set(starts.map((s) => s.session)).size, 3, 'every generation has its own session')
  await dispatch(ctx, renewing(4, { charge: 'A' }))
  assert.equal(valueAfter(starts[3].args, '--resume'), starts[2].session, 'the newest session is the one resumed')
})

test('a rewritten prompt file is the same prompt', async (t) => {
  const { ctx, calls, starts, renewals } = host(t)
  await dispatch(ctx, renewing(1, { charge: 'A' }))
  rmSync(calls[0].role.systemPromptFile)
  await dispatch(ctx, renewing(2, { charge: 'A' }))
  assert.ok(existsSync(calls[1].role.systemPromptFile), 'the file is written again')
  assert.equal(renewals().length, 0)
  assert.equal(valueAfter(starts[1].args, '--resume'), starts[0].session)
})

test('one renewal record per renewal', async (t) => {
  const replayed = host(t)
  await dispatch(replayed.ctx, renewing(1, { charge: 'A' }))
  await dispatch(replayed.ctx, renewing(2, { charge: 'B' }))
  await dispatch(replayed.ctx, renewing(2, { charge: 'B' }))
  assert.equal(replayed.renewals().length, 1, 'a replayed dispatch renews nothing')

  const killed = host(t)
  await dispatch(killed.ctx, renewing(1, { charge: 'A' }))
  const live = killed.ctx.runAgent
  killed.ctx.runAgent = () => { throw new Error('killed') }
  await assert.rejects(dispatch(killed.ctx, renewing(2, { charge: 'B' })), /killed/)
  killed.ctx.runAgent = live
  await dispatch(killed.ctx, renewing(2, { charge: 'B' }))
  assert.equal(killed.renewals().length, 1, 'a run killed between the renewal and the start does not renew twice')
  assert.ok(!killed.starts[1].args.includes('--resume'))
})

test('resendOnCutOff resends the brief', async (t) => {
  const { ctx, starts, renewals } = host(t)
  await dispatch(ctx, round(1, { charge: 'A' }))
  const first = firstDispatched(ctx)
  dispatchedBefore(ctx, 2, { prompt: first.prompt, cwd: first.cwd, session: starts[0].session })
  await dispatch(ctx, renewing(2, { charge: 'A', resendOnCutOff: true }))
  assert.equal(renewals().length, 0)
  assert.equal(valueAfter(starts[1].args, '--resume'), starts[0].session)
  assert.equal(starts[1].stdin, CUT_OFF + SEPARATOR + 'brief 2')
})

test('a host stop resends the brief', async (t) => {
  const resent = host(t, ['stop', 'return'])
  const out = await dispatch(resent.ctx, round(1, { resendOnCutOff: true }))
  assert.equal(out.status, 'returned')
  assert.equal(valueAfter(resent.starts[1].args, '--resume'), resent.starts[0].session)
  assert.equal(resent.starts[1].stdin, CUT_OFF + SEPARATOR + 'brief 1')

  const alone = host(t, ['stop', 'return'])
  await dispatch(alone.ctx, round(1))
  assert.equal(alone.starts[1].stdin, CUT_OFF, 'without resendOnCutOff the cut-off message goes alone')
})

test('a thread names the session of every later generation', async (t) => {
  const { ctx } = host(t)
  const at = threadOf(ctx, { role: 'ruler', thread: THREAD })
  assert.equal(at.sessionAt(0), at.session)
  assert.equal(at.sessionAt(1), at.nextSession)
  assert.notEqual(at.sessionAt(2), at.nextSession)
})
