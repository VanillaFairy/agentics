// lib/runner.mjs — the one way anything in agentics starts an agent: a headless Claude Code
// session per call, confined, schema-checked, resumed by id, and recorded as it goes.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { spawn } from 'node:child_process'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { hostProcess } from './host.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import { livePath, mkdirState, returnPath } from './store.mjs'
import { checkoutWatch } from './watch.mjs'

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

/**
 * The CLAUDE_CODE_ names that are the user's own settings, not the launching session's: the child
 * reads them to authenticate and to find its shell the way the user's own sessions do. Every other
 * CLAUDE_CODE_ name is dropped, so a new session-owned variable in a host release needs no edit here.
 */
export const KEPT_HOST_VARIABLES = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
]

/** Pure. The child's environment: the launching session's variables dropped, the user's settings and the rest kept. */
export function cleanEnv(env) {
  const owned = (k) => (k.startsWith('CLAUDE_CODE_') && !KEPT_HOST_VARIABLES.includes(k)) || k === 'CLAUDECODE' || k === 'AI_AGENT'
  return Object.fromEntries(Object.entries(env).filter(([k]) => !owned(k)))
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
  // The CLI ignores an `--effort` value it does not know and exits 0 at its default effort: that
  // return was paid for at a tier nobody chose.
  const rejected = code === 0 ? String(stderr).match(/^.*Unknown --effort value.*$/im) : null
  if (rejected) return { status: 'failed', cause: 'host_error', message: rejected[0].trim() }
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
  if (status === 503 || /service unavailable|\b503\b/i.test(said)) return { status: 'stopped', cause: 'unavailable', until: '' }
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

/**
 * Pure. The `dispatched` entry of a call: its brief's digest is `call.briefDigest` when given, and
 * `brief_parts` the digest of each of the brief's sections (`call.briefParts`, `{}` when absent).
 */
export const dispatchedEntry = (call, { pid, session }) => ({
  dispatch: call.dispatch, node: call.node, round: call.round, thread: call.thread.key, role: call.role.name,
  model: call.tier.model, effort: call.tier.effort || '', session, brief_digest: call.briefDigest || fnv1a(String(call.brief)),
  brief_parts: call.briefParts || {}, carries: call.carries || [], pid,
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
    const answered = rows.some((r) => (r.kind === 'returned' || r.kind === 'host_stop') && r.dispatch === d.dispatch && r.seq > d.seq)
    if (!answered && d.pid && proc.alive(d.pid)) {
      proc.kill(d.pid)
      log.append('returned', { dispatch: d.dispatch, session, status: 'cut_off', cause: 'orphan_ended', usage: null, cost_total: null, cost_usd: null, denials: [] })
    }
  }
}

const MORE = 'Continue: return the rest of your structured output, in the same shape.'
const WINDOW = 200000

/** A session whose last call filled more than half its model's window is not resumed. */
function tooLarge(call, log) {
  const last = log.entries().filter((r) => r.kind === 'returned' && r.session === call.thread.session && r.usage).pop()
  if (!last) return false
  const u = last.usage
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) > (call.tier.window || WINDOW) / 2
}

/** The thread's next generation: a fresh session, briefed with everything the thread holds. */
function renew(call, log, why) {
  log.append('thread_renewed', { thread: call.thread.key, gen: call.thread.gen + 1, why })
  return { ...call, resume: false, brief: call.freshBrief, thread: { ...call.thread, session: call.thread.nextSession, gen: call.thread.gen + 1 } }
}

/** Pure. Two parts of one long return: arrays concatenated, everything else from the later part. */
function mergeParts(a, b) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = Array.isArray(a[k]) && Array.isArray(v) ? [...a[k], ...v] : v
  return out
}

/** Pure. Whether a part adds to the return merged so far: an array element not already in it, or a changed scalar. */
function progressed(merged, part) {
  const has = (list, e) => Array.isArray(list) && list.some((m) => canonical(m) === canonical(e))
  return Object.entries(part).some(([k, v]) => (Array.isArray(v) ? v.some((e) => !has(merged[k], e)) : canonical(v) !== canonical(merged[k])))
}

/** Pure. A return as it is stored: without the `more` that only carried it. */
const finished = (whole) => { const { more, ...rest } = whole; return rest }

/** Start or resume one agent call, record it, and return its outcome (docs/DESIGN.md#the-agent-runner). */
export async function runAgent(given, ports) {
  const call = given.briefDigest ? given : { ...given, briefDigest: fnv1a(String(given.brief)) }
  const renewable = Boolean(call.freshBrief && call.thread.nextSession)
  let current = call.resume && renewable && tooLarge(call, ports.log) ? renew(call, ports.log, 'too_large') : call
  let out = await callOnce(current, ports)
  if (out.status === 'failed' && out.cause === 'session_missing' && renewable && current.resume) {
    current = renew(current, ports.log, 'session_missing')
    out = await callOnce(current, ports)
  }
  while (out.status === 'part') out = await callOnce({ ...current, resume: true, brief: MORE }, ports, { merged: out.merged })
  return out
}

/** One CLI start. `merged` is the long return so far when this call continues one. */
async function callOnce(call, ports, { merged = null, retried = false } = {}) {
  const { spawnCli, log, fsx, proc, watch = null, now, env = process.env } = ports
  const session = call.thread.session
  if (call.resume) endOrphans(session, log, proc)
  let snapshot = null
  try {
    snapshot = watch ? watch.before() : null
  } catch (err) {
    log.append('dispatched', dispatchedEntry(call, { pid: 0, session }))
    log.append('returned', returnedEntry(call, { session, status: 'failed', cause: 'watch_failed' }))
    return { status: 'failed', cause: 'watch_failed', until: '', output: null, usage: null, cost_usd: null, denials: [], session, checkout: { moved: [], changed: [] }, message: err.message }
  }
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
  let checkout = { moved: [], changed: [] }
  let watchError = null
  try {
    if (snapshot) checkout = watch.after(snapshot)
  } catch (err) {
    watchError = err
  }
  if (checkout.changed.length) log.append('checkout_changed', { dispatch: call.dispatch, paths: checkout.changed })
  const costUsd = costOf(parsed.costTotal, session, log)
  const facts = { session, usage: parsed.usage, costTotal: parsed.costTotal, costUsd, denials: parsed.denials }
  const outcome = (status, cause, extra = {}) => ({
    status, cause, until: '', output: null, usage: parsed.usage, cost_usd: costUsd, denials: parsed.denials, session, checkout, ...extra,
  })

  const output = cls.status === 'returned' ? parsed.structured : null
  const whole = output && merged ? mergeParts(merged, output) : output

  // A watch that could not read the checkout cannot vouch for it: the call fails, but a completed
  // return it paid for is kept. A part is not a return, so a watch failure on one keeps nothing.
  if (watchError) {
    const complete = whole && whole.more !== true
    if (complete) fsx.writeJson(returnPath(call.dir, call.dispatch), finished(whole))
    log.append('returned', returnedEntry(call, { ...facts, status: 'failed', cause: 'watch_failed' }))
    return outcome('failed', 'watch_failed', { message: watchError.message, output: complete ? finished(whole) : null })
  }
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
    if (cls.cause === 'schema_failed' && !retried) return callOnce({ ...call, resume: true, brief: SCHEMA_AGAIN(cls.message) }, ports, { merged, retried: true })
    return outcome('failed', cls.cause, { message: cls.message })
  }
  // A part is not a return: nothing is stored until the call that completes it, so a `returned`
  // record with status `returned` always has its whole return on disk.
  if (output.more === true) {
    if (merged && !progressed(merged, output)) {
      log.append('returned', returnedEntry(call, { ...facts, status: 'failed', cause: 'no_progress' }))
      return outcome('failed', 'no_progress')
    }
    log.append('returned', returnedEntry(call, { ...facts, status: 'part' }))
    return outcome('part', '', { merged: whole })
  }
  fsx.writeJson(returnPath(call.dir, call.dispatch), finished(whole))
  log.append('returned', returnedEntry(call, { ...facts, status: 'returned' }))
  return outcome('returned', '', { output: finished(whole) })
}

// ------------------------------------------------------------------ the production ports

/** The production files port: a JSON file is replaced whole or not at all; a file already gone is removed quietly. */
const files = {
  writeJson(path, value) {
    mkdirState(dirname(path))
    const temporary = path + '.' + process.pid + '.tmp'
    writeFileSync(temporary, JSON.stringify(value), 'utf8')
    renameSync(temporary, path)
  },
  remove(path) {
    rmSync(path, { force: true })
  },
}

/**
 * The production runner: runAgent bound to real ports. `prefix` goes before every call's own
 * arguments, for a `cli` that is a script's interpreter. A role that runs commands is watched.
 */
export function boundRunner({ repo, cli, prefix = [], log, env = process.env, now = () => new Date().toISOString() }) {
  const spawnCli = spawner(cli, prefix)
  const proc = hostProcess(cli)
  return (call) => runAgent(call, { spawnCli, log, fsx: files, proc, watch: call.role.tools.includes('Bash') ? checkoutWatch(repo) : null, now, env })
}
