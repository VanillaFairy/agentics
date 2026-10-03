// lib/runner.mjs — the one way anything in agentics starts an agent: a headless Claude Code
// session per call, confined, schema-checked, resumed by id, and recorded as it goes.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { spawn } from 'node:child_process'

import { fnv1a } from './plan-digest.mjs'
import { livePath, returnPath } from './store.mjs'

export const PERMISSION_FLAGS = ['--permission-mode', 'dontAsk', '--permission-prompts', 'none']
export const LEAN_FLAGS = ['--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands']

/** Pure. The CLI arguments of one call. */
export function buildArgs({ systemPromptFile, tools, allowed = [], disallowed = [], model, effort = '', schema, session, resume = false }) {
  if (!schema || typeof schema !== 'object') throw new Error('every call returns structured output: no schema given')
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--system-prompt-file', systemPromptFile,
    '--tools', tools.join(','),
    ...(allowed.length ? ['--allowedTools', ...allowed] : []),
    ...(disallowed.length ? ['--disallowedTools', ...disallowed] : []),
    ...PERMISSION_FLAGS, ...LEAN_FLAGS,
    '--model', model,
    ...(effort ? ['--effort', effort] : []),
    '--json-schema', JSON.stringify(schema),
    ...(resume ? ['--resume', session] : ['--session-id', session]),
  ]
}

/** Pure. The child's environment: the launching session's variables dropped, the host's configuration kept. */
export function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE' && k !== 'AI_AGENT'))
}

const targetOf = (input) => (input && (input.file_path || input.command || input.pattern || input.path || input.url)) || ''

/** Pure. One call's stream-json output, read whole. */
export function parseStream(text) {
  let result = null
  let sessionId = ''
  let turns = 0
  let lastTool = null
  let malformed = 0
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '') continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      malformed++
      continue
    }
    if (e.session_id) sessionId = e.session_id
    if (e.type === 'assistant') {
      turns++
      for (const c of (e.message && e.message.content) || []) {
        if (c && c.type === 'tool_use') lastTool = { name: c.name, target: targetOf(c.input) }
      }
    }
    if (e.type === 'result') result = e
  }
  return {
    result,
    structured: result && result.structured_output !== undefined ? result.structured_output : null,
    usage: (result && result.usage) || null,
    costTotal: result && typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
    denials: (result && Array.isArray(result.permission_denials)) ? result.permission_denials : [],
    sessionId,
    turns,
    lastTool,
    malformed,
  }
}

/** Pure. What a finished call amounts to (docs/DESIGN.md#host-stops). */
export function classifyCall({ code, stderr = '', parsed }) {
  const r = (parsed && parsed.result) || {}
  const said = String(stderr) + '\n' + String(r.result || '')
  if (code === 0 && r.subtype === 'success' && !r.is_error && parsed.structured !== null) return { status: 'returned' }
  if (/No conversation found with session ID/i.test(said)) return { status: 'failed', cause: 'session_missing', message: said.trim() }
  if (r.subtype === 'error_max_structured_output_retries' || (r.subtype === 'success' && !r.is_error && parsed.structured === null)) {
    return { status: 'failed', cause: 'schema_failed', message: String(r.result || r.subtype) }
  }
  const status = r.api_error_status
  if (status === 429 || /rate.?limit/i.test(said)) return { status: 'stopped', cause: 'rate_limit', until: '' }
  const usage = said.match(/usage limit[^\n]*?reset(?:s)?(?: at)? ([^\n.]+)/i)
  if (usage || /usage limit|limit reached/i.test(said)) return { status: 'stopped', cause: 'usage_limit', until: usage ? usage[1].trim() : '' }
  if (status === 529 || /overloaded/i.test(said)) return { status: 'stopped', cause: 'overloaded', until: '' }
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(said)) return { status: 'stopped', cause: 'network', until: '' }
  return { status: 'failed', cause: 'host_error', message: (said.trim() || 'exit ' + code).slice(-400) }
}

// ------------------------------------------------------------------ runAgent

/** The production spawnCli: runs `command` with `[...prefix, ...args]`, no shell. */
export function spawner(command, prefix = []) {
  return (args, { stdin = '', env, cwd, onSpawn = () => {}, onLine = () => {} } = {}) => new Promise((resolve) => {
    const child = spawn(command, [...prefix, ...args], { cwd, env, shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let partial = ''
    child.on('spawn', () => onSpawn(child.pid))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      stdout += d
      partial += d
      const lines = partial.split(/\r?\n/)
      partial = lines.pop()
      for (const l of lines) if (l.trim() !== '') onLine(l)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + String(err.message) }))
    child.on('close', (code) => {
      if (partial.trim() !== '') onLine(partial)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })
}

/** Pure. The `dispatched` entry of a call. */
export const dispatchedEntry = (call, { pid, session }) => ({
  dispatch: call.dispatch, node: call.node, round: call.round, thread: call.thread.key, role: call.role.name,
  model: call.tier.model, effort: call.tier.effort || '', session, brief_digest: fnv1a(String(call.brief)),
  carries: call.carries || [], pid,
})

/** Pure. The `returned` entry of a call. */
export const returnedEntry = (call, { session, status, cause = '', usage = null, costTotal = null, costUsd = null, denials = [] }) => ({
  dispatch: call.dispatch, session, status, cause, usage, cost_total: costTotal, cost_usd: costUsd, denials,
})

const SCHEMA_AGAIN = (why) => 'Your last reply did not match the structured output your schema requires (' + why +
  '). Reply again with the structured output only.'

/** The host's cost total accumulates over a session's calls: this call's share is the difference. */
function costOf(total, session, log) {
  if (typeof total !== 'number') return null
  const before = log.entries().filter((r) => r.kind === 'returned' && r.session === session && typeof r.cost_total === 'number')
  return before.length ? total - before[before.length - 1].cost_total : total
}

/** One process drives a session: an earlier call still alive on it is ended before a resume. */
function endOrphans(session, log, proc) {
  const rows = log.entries()
  for (const d of rows.filter((r) => r.kind === 'dispatched' && r.session === session)) {
    const answered = rows.some((r) => r.kind === 'returned' && r.dispatch === d.dispatch && r.seq > d.seq)
    if (!answered && d.pid && proc.alive(d.pid)) {
      proc.kill(d.pid)
      log.append('returned', { dispatch: d.dispatch, session, status: 'cut_off', cause: 'orphan_ended', usage: null, cost_total: null, cost_usd: null, denials: [] })
    }
  }
}

/** Start or resume one agent call, record it, and return its outcome (docs/DESIGN.md#the-agent-runner). */
export async function runAgent(call, ports) {
  return callOnce(call, ports, false)
}

async function callOnce(call, ports, retried) {
  const { spawnCli, log, fsx, proc, watch = null, now, env = process.env } = ports
  const session = call.thread.session
  if (call.resume) endOrphans(session, log, proc)
  const snapshot = watch ? watch.before() : null
  const live = livePath(call.dir, call.dispatch)
  let dispatched = false
  let turns = 0
  const out = await spawnCli(buildArgs({
    systemPromptFile: call.role.systemPromptFile, tools: call.role.tools, allowed: call.permissions.allowed,
    disallowed: call.permissions.disallowed, model: call.tier.model, effort: call.tier.effort, schema: call.schema,
    session, resume: call.resume,
  }), {
    stdin: call.brief, env: cleanEnv(env), cwd: call.cwd,
    onSpawn: (pid) => { log.append('dispatched', dispatchedEntry(call, { pid, session })); dispatched = true },
    onLine: (line) => {
      const p = parseStream(line)
      if (p.turns === 0) return
      turns += p.turns
      if (p.lastTool) fsx.writeJson(live, { turns, tool: p.lastTool, at: now() })
    },
  })
  if (!dispatched) log.append('dispatched', dispatchedEntry(call, { pid: 0, session }))
  fsx.remove(live)

  const parsed = parseStream(out.stdout)
  const cls = classifyCall({ code: out.code, stderr: out.stderr, parsed })
  const checkout = snapshot ? watch.after(snapshot) : { moved: [], changed: [] }
  if (checkout.changed.length) log.append('checkout_changed', { dispatch: call.dispatch, paths: checkout.changed })
  const costUsd = costOf(parsed.costTotal, session, log)
  const facts = { session, usage: parsed.usage, costTotal: parsed.costTotal, costUsd, denials: parsed.denials }
  const outcome = (status, cause, extra = {}) => ({
    status, cause, until: '', output: null, usage: parsed.usage, cost_usd: costUsd, denials: parsed.denials, session, checkout, ...extra,
  })

  // A moved ref is a fault naming the call, so it outranks a host stop.
  if (checkout.moved.length) {
    log.append('returned', returnedEntry(call, { ...facts, status: 'failed', cause: 'checkout' }))
    return outcome('failed', 'checkout')
  }
  if (cls.status === 'stopped') {
    log.append('host_stop', { dispatch: call.dispatch, cause: cls.cause, until: cls.until || '' })
    return outcome('stopped', cls.cause, { until: cls.until || '' })
  }
  if (cls.status === 'failed') {
    log.append('returned', returnedEntry(call, { ...facts, status: 'failed', cause: cls.cause }))
    if (cls.cause === 'schema_failed' && !retried) return callOnce({ ...call, resume: true, brief: SCHEMA_AGAIN(cls.message) }, ports, true)
    return outcome('failed', cls.cause, { message: cls.message })
  }
  fsx.writeJson(returnPath(call.dir, call.dispatch), parsed.structured)
  log.append('returned', returnedEntry(call, { ...facts, status: 'returned' }))
  return outcome('returned', '', { output: parsed.structured })
}
