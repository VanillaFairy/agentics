// test/fast/harness/scripted-runner.mjs — the real runAgent over a scripted CLI. Each start of a call's
// CLI plays the next step scripted for its `role|node|thread` as the stream, stderr and exit code the
// host gives, so a program test sees the records, stored returns, retries, parts and renewals
// production does. A usage limit's `until` reaches the record as classifyCall reads the host's text:
// up to its first '.'; the other stop classes carry none. A step's `calls` are appended to the call log
// its call's MCP config names, standing in for the search server.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { runAgent as realRunAgent } from '../../../lib/runner.mjs'
import { mkdirState } from '../../../lib/store.mjs'

const STOPS = {
  rate_limit: () => 'API Error: rate limit exceeded',
  usage_limit: (until) => 'Claude AI usage limit reached' + (until ? '; resets at ' + until : ''),
  overloaded: () => 'API Error: 529 Overloaded',
  network: () => 'Error: read ECONNRESET',
}
const FAILURES = {
  schema_failed: (result) => ({ code: 1, lines: [result({ subtype: 'error_max_structured_output_retries', is_error: true })], stderr: '' }),
  session_missing: (result, session) => ({ code: 1, lines: [], stderr: 'No conversation found with session ID: ' + session }),
  host_error: () => ({ code: 1, lines: [], stderr: '' }),
  context_exceeded: () => ({ code: 1, lines: [], stderr: 'Prompt is too long' }),
  budget: (result) => ({ code: 1, lines: [result({ subtype: 'error_max_budget_usd', is_error: true, errors: ['Reached maximum budget'] })], stderr: '' }),
}

const valueAfter = (args, flag) => { const i = args.indexOf(flag); return i < 0 ? '' : args[i + 1] }

/** The call log of a call's search server: the `calls` path of the spec its MCP config names. */
function callLogOf(call, key) {
  if (!call.mcpConfig) throw new Error(key + ': a step with calls needs a call with an mcpConfig')
  const path = typeof call.mcpConfig === 'function' ? call.mcpConfig(call.thread.session) : call.mcpConfig
  const args = JSON.parse(readFileSync(path, 'utf8')).mcpServers.search.args
  return JSON.parse(readFileSync(args[args.indexOf('--spec') + 1], 'utf8')).calls
}

/** Append a step's records to the call log as the server does, each numbered after the log's last. */
function appendCalls(path, records) {
  const rows = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []
  let seq = rows.reduce((n, r) => Math.max(n, r.seq || 0), 0)
  mkdirState(dirname(path))
  for (const r of records) appendFileSync(path, JSON.stringify({ seq: ++seq, ...r }) + '\n')
}

/** One CLI start as the host plays a step: the stream's lines, the stderr and the exit code. */
function play(step, session, key) {
  const line = (event) => JSON.stringify({ ...event, session_id: session })
  const result = (over) => line({ type: 'result', usage: step.usage ?? null, total_cost_usd: step.cost_total, permission_denials: step.denials || [], ...over })
  const init = line({ type: 'system', subtype: 'init' })
  // `context` is what the model turn read; `webSearches` its WebSearch tool_uses
  const usage = typeof step.context === 'number' ? { usage: { input_tokens: step.context } } : {}
  const turn = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }], ...usage } })
  const searched = (step.webSearches || []).map((input) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input }] } }))
  if (step.status === 'stopped') {
    if (!STOPS[step.cause]) throw new Error(key + ': no host stop is named ' + JSON.stringify(step.cause))
    return { code: 1, lines: [init], stderr: STOPS[step.cause](step.until || '') }
  }
  if (step.status === 'failed') {
    if (!FAILURES[step.cause]) throw new Error(key + ': no scripted failure is named ' + JSON.stringify(step.cause))
    const out = FAILURES[step.cause](result, session)
    return { ...out, lines: out.lines.length ? [init, turn, ...out.lines] : [] }
  }
  if (!step.output || typeof step.output !== 'object') throw new Error(key + ': a step needs an output or a status')
  const output = step.more ? { ...step.output, more: true } : step.output
  return { code: 0, lines: [init, ...searched, turn, result({ subtype: 'success', is_error: false, structured_output: output })], stderr: '' }
}

export function scriptedRunner(script, { log, now = () => '2026-01-01T00:00:00.000Z' }) {
  const next = new Map()
  const calls = []
  let pid = 1000
  const fsx = {
    writeJson(path, value) { mkdirState(dirname(path)); writeFileSync(path, JSON.stringify(value)) },
    remove(path) { rmSync(path, { force: true }) },
  }
  const proc = { alive: () => false, kill() {} }
  const starts = []
  const spawnFor = (key, call) => async (args, { stdin = '', onSpawn = () => {}, onLine = () => {} } = {}) => {
    const steps = script[key] || []
    const i = next.get(key) || 0
    if (i >= steps.length) throw new Error('the script has no start ' + (i + 1) + ' for ' + key)
    next.set(key, i + 1)
    const session = valueAfter(args, '--resume') || valueAfter(args, '--session-id')
    starts.push({ key, round: call.round, session, resume: args.includes('--resume'), stdin, args })
    const out = play(steps[i], session, key)
    onSpawn(++pid)
    if (steps[i].calls) appendCalls(callLogOf(call, key), steps[i].calls)
    for (const l of out.lines) onLine(l)
    return { code: out.code, stdout: out.lines.map((l) => l + '\n').join(''), stderr: out.stderr }
  }
  async function runAgent(call) {
    calls.push(call)
    const key = call.role.name + '|' + call.node + '|' + call.thread.key
    return realRunAgent(call, { spawnCli: spawnFor(key, call), log, fsx, proc, watch: null, now, env: {} })
  }
  return { runAgent, calls, starts }
}
