// test/fast/dispatch-search.test.mjs — pins what a search's dispatch hands the runner: its charge
// written after the role's body as the system prompt, and its tool server's config on the call and
// on the host's command line.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dispatch, programContext } from '../../lib/programs/common.mjs'
import { loadRole } from '../../lib/roles.mjs'
import { runAgent } from '../../lib/runner.mjs'
import { writeWhole } from '../../lib/store.mjs'
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
  return programContext({ repo: dir, run: RUN, dir, log, runAgent: runnerOf(log), now: NOW, sleep: async () => {}, env: {} })
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
