// lib/runner.mjs — the one way anything in agentics starts an agent: a headless Claude Code
// session per call, confined, schema-checked, resumed by id, and recorded as it goes.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { spawn } from 'node:child_process'
import { rmSync, statSync } from 'node:fs'
import { basename } from 'node:path'

import { hostProcess } from './host.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import { BRIEF_BYTES, MODEL_WINDOW } from './roles.mjs'
import { livePath, returnPath, writeWhole } from './store.mjs'
import { checkoutWatch } from './watch.mjs'

export const PERMISSION_FLAGS = ['--permission-mode', 'dontAsk', '--permission-prompts', 'none']
export const LEAN_FLAGS = ['--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands']

/** Pure. The CLI arguments of one call. An `mcp__` tool is served by the call's MCP config, so `--tools` names only the host's own. */
export function buildArgs({ systemPromptFile, tools, allowed = [], disallowed = [], model, effort = '', schema, session, resume = false, mcpConfig = '', maxBudgetUsd = null }) {
  if (!schema || typeof schema !== 'object') throw new Error('every call returns structured output: no schema given')
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--system-prompt-file', systemPromptFile,
    '--tools', tools.filter((t) => !t.startsWith('mcp__')).join(','),
    ...(allowed.length ? ['--allowedTools', ...allowed] : []),
    ...(disallowed.length ? ['--disallowedTools', ...disallowed] : []),
    ...PERMISSION_FLAGS, ...LEAN_FLAGS,
    ...(mcpConfig ? ['--mcp-config', mcpConfig] : []),
    ...(maxBudgetUsd !== null ? ['--max-budget-usd', String(maxBudgetUsd)] : []),
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
  let context = null
  let opened = null
  const webSearches = []
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
      const u = e.message && e.message.usage
      if (u && typeof u === 'object') context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      if (opened === null) opened = context
      for (const c of (e.message && e.message.content) || []) {
        if (c && c.type === 'tool_use') lastTool = { name: c.name, target: targetOf(c.input) }
        if (c && c.type === 'tool_use' && c.name === 'WebSearch') webSearches.push(c.input ?? {})
      }
    }
    if (e.type === 'result') result = e
  }
  return {
    result,
    structured: result && result.structured_output !== undefined ? result.structured_output : null,
    usage: (result && result.usage) || null,
    context,
    opened,
    costTotal: result && typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
    denials: (result && Array.isArray(result.permission_denials)) ? result.permission_denials : [],
    sessionId,
    turns,
    lastTool,
    malformed,
    webSearches,
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
  if (r.subtype === 'error_max_budget_usd') return { status: 'failed', cause: 'budget', message: String((r.errors || [])[0] || 'the budget ran out') }
  if (code === 0 && r.subtype === 'success' && !r.is_error && parsed.structured !== null) return { status: 'returned' }
  if (/No conversation found with session ID/i.test(said)) return { status: 'failed', cause: 'session_missing', message: said.trim() }
  if (r.subtype === 'error_max_structured_output_retries' || (r.subtype === 'success' && !r.is_error && parsed.structured === null)) {
    return { status: 'failed', cause: 'schema_failed', message: String(r.result || r.subtype) }
  }
  if (/prompt is too long|context length|maximum context|exceed context limit/i.test(said)) return { status: 'failed', cause: 'context_exceeded', message: said.trim().slice(-400) }
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

/** Pure. The digest in a system-prompt file's name (`<role>-<digest>.md`): the one thing that says which prompt a call ran under. A call with no such file has none. */
export const promptDigestOf = (systemPromptFile) => {
  if (!systemPromptFile) return undefined
  const name = basename(systemPromptFile, '.md')
  return name.slice(name.lastIndexOf('-') + 1)
}

/**
 * Pure. The `dispatched` entry of a call: its brief's digest is `call.briefDigest` when given, and
 * `brief_parts` the digest of each of the brief's sections (`call.briefParts`, `{}` when absent).
 * `prompt` is the system prompt's digest and `cwd` where the call ran.
 */
export const dispatchedEntry = (call, { pid, session }) => ({
  dispatch: call.dispatch, node: call.node, round: call.round, thread: call.thread.key, role: call.role.name,
  model: call.tier.model, effort: call.tier.effort || '', session, brief_digest: call.briefDigest || fnv1a(String(call.brief)),
  brief_parts: call.briefParts || {}, carries: call.carries || [], prompt: promptDigestOf(call.role.systemPromptFile), cwd: call.cwd, pid,
})

/** Pure. The `returned` entry of a call: `usage` the host's figure over the whole call, `context` what its last model turn read, `opened` what its first did. */
export const returnedEntry = (call, { session, status, cause = '', usage = null, context = null, opened = null, costTotal = null, costUsd = null, denials = [] }) => ({
  dispatch: call.dispatch, session, status, cause, usage, context, opened, cost_total: costTotal, cost_usd: costUsd, denials,
})

const SCHEMA_AGAIN = (why) => 'Your last reply did not match the structured output your schema requires (' + why +
  '). Reply again with the structured output only.'

/** The host's cost total accumulates over a session's calls: this call's share is the difference. */
function costOf(total, session, log) {
  if (typeof total !== 'number') return null
  const before = log.entries().filter((r) => r.kind === 'returned' && r.session === session && typeof r.cost_total === 'number')
  return before.length ? total - before[before.length - 1].cost_total : total
}

/** Pure. Each call whose latest `dispatched` has no `returned` and no `host_stop` after it, oldest first. */
export function openCalls(entries) {
  const latest = new Map()
  for (const e of entries) if (e.kind === 'dispatched' && typeof e.dispatch === 'string') latest.set(e.dispatch, e)
  return [...latest.values()]
    .filter((d) => !entries.some((r) => (r.kind === 'returned' || r.kind === 'host_stop') && r.dispatch === d.dispatch && r.seq > d.seq))
    .sort((a, b) => a.seq - b.seq)
}

/** Record an open call ended: `cut_off`, with why. */
const cutOff = (log, d, cause) => log.append('returned', {
  dispatch: d.dispatch, session: d.session, status: 'cut_off', cause, usage: null, context: null, opened: null, cost_total: null, cost_usd: null, denials: [],
})

/** One process drives a session: an earlier call still alive on it is ended before a resume. */
function endOrphans(session, log, proc) {
  for (const d of openCalls(log.entries()).filter((r) => r.session === session)) {
    if (d.pid && proc.alive(d.pid)) {
      proc.kill(d.pid)
      cutOff(log, d, 'orphan_ended')
    }
  }
}

/**
 * Close every call an earlier run of this log left open, at the start of the run that now owns the
 * log: one still alive is ended (`orphan_ended`), one whose process is gone is `process_gone`; each
 * is recorded `cut_off` and its live file removed. A unit that asks for one again resumes it in its
 * session; one nothing asks for again stays ended.
 */
export function closeLeftOpen({ log, proc, dir, remove = (path) => rmSync(path, { force: true }) }) {
  const closed = []
  for (const d of openCalls(log.entries())) {
    const alive = d.pid > 0 && proc.alive(d.pid)
    if (alive) proc.kill(d.pid)
    const cause = alive ? 'orphan_ended' : 'process_gone'
    cutOff(log, d, cause)
    remove(livePath(dir, d.dispatch))
    closed.push({ dispatch: d.dispatch, node: d.node, thread: d.thread, role: d.role, round: d.round, cause })
  }
  return closed
}

const MORE = 'Continue: return the rest of your structured output, in the same shape.'

/**
 * A session is not resumed once its last measured model turn read past the midpoint between its
 * floor and its model's window. The floor is what the session's first model turn read � its system
 * prompt and first brief, which a fresh session carries again � so a renewal sheds turns, never the
 * charge. A session whose first measured call recorded no `opened` has floor 0; an unmeasured one is resumed.
 */
function tooLarge(call, log) {
  const measured = log.entries().filter((r) => r.kind === 'returned' && r.session === call.thread.session && typeof r.context === 'number')
  if (measured.length === 0) return false
  const floor = typeof measured[0].opened === 'number' ? measured[0].opened : 0
  return measured.at(-1).context > ((call.tier.window || MODEL_WINDOW) + floor) / 2
}

/**
 * The thread's next generation: a fresh session, briefed with everything the thread holds, or with
 * `brief` when given. A thread that can name later generations (`sessionAt`) can be renewed again.
 */
function renew(call, log, why, brief = call.briefNow ? call.briefNow() : call.freshBrief) {
  const gen = call.thread.gen + 1
  log.append('thread_renewed', { thread: call.thread.key, gen, why })
  const nextSession = call.thread.sessionAt ? call.thread.sessionAt(gen + 1) : undefined
  return { ...call, resume: false, brief, thread: { ...call.thread, session: call.thread.nextSession, gen, nextSession } }
}

/** Pure. Two parts of one long return: arrays concatenated, everything else from the later part. */
function mergeParts(a, b) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = Array.isArray(a[k]) && Array.isArray(v) ? [...a[k], ...v] : v
  return out
}

/**
 * Pure. Whether a part adds to the return merged so far: an array element not already in it, or a
 * field the merged return holds empty. A reworded field is not progress, so parts cannot go on forever.
 */
function progressed(merged, part) {
  const has = (list, e) => Array.isArray(list) && list.some((m) => canonical(m) === canonical(e))
  const empty = (v) => v === undefined || v === null || v === ''
  return Object.entries(part).some(([k, v]) => (Array.isArray(v) ? v.some((e) => !has(merged[k], e)) : empty(merged[k]) && !empty(v)))
}

/** Pure. A return as it is stored: without the `more` that only carried it. */
const finished = (whole) => { const { more, ...rest } = whole; return rest }

/** Start or resume one agent call, record it, and return its outcome (docs/DESIGN.md#the-agent-runner). */
export async function runAgent(given, ports) {
  const call = given.briefDigest ? given : { ...given, briefDigest: fnv1a(String(given.brief)) }
  const renewable = Boolean((call.briefNow || call.freshBrief) && call.thread.nextSession)
  let current = call.resume && renewable && tooLarge(call, ports.log) ? renew(call, ports.log, 'too_large') : call
  let out = await callOnce(current, ports)
  if (out.status === 'failed' && out.cause === 'session_missing' && renewable && current.resume) {
    current = renew(current, ports.log, 'session_missing')
    out = await callOnce(current, ports)
  }
  // A prompt refused as too long gets one fresh session, briefed with what the journal holds now.
  if (call.briefNow && out.status === 'failed' && out.cause === 'context_exceeded' && current.thread.nextSession) {
    current = renew(current, ports.log, 'context_exceeded')
    out = await callOnce(current, ports)
  }
  while (out.status === 'part') out = await callOnce({ ...current, resume: true, brief: MORE }, ports, { merged: out.merged })
  return out
}

const fileBytes = (path) => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Pure. Why a fresh session's first read — system prompt and brief — is not sent: past what its model can read; '' when it fits. */
export function oversize({ systemBytes, brief, room = BRIEF_BYTES }) {
  const bytes = systemBytes + Buffer.byteLength(String(brief), 'utf8')
  return bytes > room ? 'the first read is ' + bytes + ' bytes and a call may read ' + room + ' (system prompt ' + systemBytes + ')' : ''
}

/** One CLI start. `merged` is the long return so far when this call continues one. */
async function callOnce(call, ports, { merged = null, retried = false } = {}) {
  const { spawnCli, log, fsx, proc, watch = null, now, env = process.env } = ports
  const session = call.thread.session
  const refused = (cause, message) => ({ status: 'failed', cause, until: '', output: null, usage: null, cost_usd: null, denials: [], session, checkout: { moved: [], changed: [] }, message })
  if (call.resume) endOrphans(session, log, proc)
  const left = typeof call.budgetNow === 'function' ? call.budgetNow() : null
  if (left !== null && !(left > 0)) return refused('budget', 'no budget left')
  const over = call.resume ? '' : oversize({ systemBytes: fileBytes(call.role.systemPromptFile), brief: call.brief })
  if (over) return refused('brief_too_large', over)
  const mcpConfig = typeof call.mcpConfig === 'function' ? call.mcpConfig(session) : call.mcpConfig || ''
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
    session, resume: call.resume, mcpConfig, maxBudgetUsd: left,
  }), {
    stdin: call.brief, env: cleanEnv(env), cwd: call.cwd,
    onSpawn: (pid) => { log.append('dispatched', dispatchedEntry(call, { pid, session })); dispatched = true },
    onLine: (line) => {
      const p = parseStream(line)
      for (const input of p.webSearches) log.append('tool_used', { dispatch: call.dispatch, thread: call.thread.key, tool: 'WebSearch', input })
      if (p.turns === 0) return
      turns += p.turns
      if (!p.lastTool) return
      // The live file is a view: one that cannot be written now keeps its last, and the next turn writes it again.
      try {
        fsx.writeJson(live, { turns, tool: p.lastTool, at: now() })
      } catch {}
    },
  })
  if (!dispatched) log.append('dispatched', dispatchedEntry(call, { pid: 0, session }))
  try {
    fsx.remove(live)
  } catch {}

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
  const facts = { session, usage: parsed.usage, context: parsed.context, opened: parsed.opened, costTotal: parsed.costTotal, costUsd, denials: parsed.denials }
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
  writeJson: writeWhole,
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
