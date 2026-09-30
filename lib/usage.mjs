// lib/usage.mjs — what an execution's agents spent: token counts read from the host's subagent
// transcripts and recorded as `usage` state lines, and the price list that turns them into dollars.
//
// Design: docs/DESIGN.md#self-checks.
//
// Why the transcripts. A workflow script is told nothing about what an agent it dispatched spent,
// so the only record is the one the host keeps for itself: under its projects directory, each
// workflow run has a folder holding, per agent, `agent-<id>.meta.json` (whose `description` is the
// dispatch label) and `agent-<id>.jsonl` (every API message, each with its `usage`). That layout
// is the host's own and undocumented: whatever cannot be found or parsed is left unrecorded, and
// an unrecorded dispatch reads as unreported.
//
// Why the runs are found by their content. An execution is one or more workflow runs, and the
// session that launched them may be gone. Every run opens with a preflight courier whose prompt
// carries the boundary command, which names the effort and the execution; a run whose preflight
// names this one is this one's. Nothing has to remember a run id.
//
// Why a line per agent, superseded. `preflight` and `postflight` both collect, the second while
// its own courier is still running, so an agent can be seen twice with different totals. A later
// line for the same agent replaces the earlier one on read (`costOf` in `lib/status.mjs`).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { append, readLog } from './ledger.mjs'
import { canonical } from './plan-digest.mjs'

/** USD per million tokens. A cache write costs 1.25× the input rate for five minutes, 2× for an hour. */
export const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cache_read: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cache_read: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cache_read: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cache_read: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cache_read: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cache_read: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cache_read: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cache_read: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1 },
}
const WRITE_5M = 1.25
const WRITE_1H = 2

const FIELDS = ['input', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output']

/** Pure. Every token the model processed, of all five kinds. */
export const tokensOf = (counts) => FIELDS.reduce((sum, f) => sum + counts[f], 0)

/** Pure. What the counts cost on `model`, or null when the model has no price here. */
export function usdOf(model, counts) {
  const p = PRICES[model]
  if (!p) return null
  return (counts.input * p.input + counts.cache_write_5m * p.input * WRITE_5M + counts.cache_write_1h * p.input * WRITE_1H +
    counts.cache_read * p.cache_read + counts.output * p.output) / 1e6
}

const int = (v) => (Number.isFinite(v) && v > 0 ? v : 0)

/**
 * Pure. One transcript's counts per model. The host writes an API message once per content block,
 * every copy under the same message id and only the last with its output counted, so the last copy
 * of each id is the message. A dated model id is folded onto its undated name.
 */
export function usageOfTranscript(text) {
  const last = new Map()
  for (const line of String(text || '').split('\n')) {
    if (line.trim() === '') continue
    let entry = null
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const m = entry && entry.type === 'assistant' ? entry.message : null
    if (m && typeof m.id === 'string' && typeof m.model === 'string' && m.usage) last.set(m.id, m)
  }

  const out = {}
  for (const m of last.values()) {
    const u = m.usage
    const split = u.cache_creation || {}
    const write1h = int(split.ephemeral_1h_input_tokens)
    const counts = {
      input: int(u.input_tokens),
      cache_write_5m: Math.max(int(u.cache_creation_input_tokens) - write1h, 0),
      cache_write_1h: write1h,
      cache_read: int(u.cache_read_input_tokens),
      output: int(u.output_tokens),
    }
    if (tokensOf(counts) === 0) continue
    const model = m.model.replace(/-\d{8}$/, '')
    const sum = out[model] ||= Object.fromEntries(FIELDS.map((f) => [f, 0]))
    for (const f of FIELDS) sum[f] += counts[f]
  }
  return out
}

/** Where the host keeps its transcripts. */
const transcriptsRoot = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')

const dirsIn = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name))
  } catch {
    return []
  }
}

/** A stamp's moment, less a minute for the clock that minted it; a run's folder is made after it. */
function stampMs(execution) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(execution)
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 60000 : 0
}

/** The agents of one run folder: `{id, label, path}`, from the meta files beside the transcripts. */
function agentsIn(dir) {
  const out = []
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const m = /^agent-(.+)\.meta\.json$/.exec(name)
    if (!m) continue
    try {
      const label = JSON.parse(readFileSync(join(dir, name), 'utf8')).description
      if (typeof label === 'string') out.push({ id: m[1], label, path: join(dir, 'agent-' + m[1] + '.jsonl') })
    } catch {
      // A meta file the host has not finished writing: that agent is collected next time.
    }
  }
  return out
}

/**
 * What an agent was dispatched with: the text of every user line ahead of its first answer. The
 * host may relay the session's own request on a line before the prompt.
 */
function promptOf(path) {
  const out = []
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const entry = JSON.parse(line)
      if (entry.type === 'assistant') break
      const content = entry.type === 'user' && entry.message ? entry.message.content : ''
      out.push(typeof content === 'string' ? content : content.map((b) => b.text || '').join('\n'))
    }
  } catch {
    // A line the host is still writing: what was read so far decides.
  }
  return out.join('\n')
}

/** Every run folder whose preflight courier was handed this execution's boundary command. */
function runsOf(root, effort, execution) {
  const since = stampMs(execution)
  const named = '--effort "' + effort + '" --execution "' + execution + '"'
  const out = []
  for (const project of dirsIn(root)) {
    for (const session of dirsIn(project)) {
      for (const dir of dirsIn(join(session, 'subagents', 'workflows'))) {
        if (statSync(dir).mtimeMs < since) continue
        const agents = agentsIn(dir)
        if (agents.some((a) => /^preflight(#\d+)?$/.test(a.label) && promptOf(a.path).includes(named))) out.push(agents)
      }
    }
  }
  return out
}

/**
 * Record what every agent of this execution's runs has spent so far, as `usage {agent, label,
 * models}` state lines; an agent whose counts have not moved since its last line gets none.
 * @returns {{runs: number, agents: number, appended: number}}
 */
export function collectUsage(repo, effort, execution, { root = transcriptsRoot() } = {}) {
  const runs = runsOf(root, effort, execution)
  const recorded = new Map()
  for (const e of readLog(repo, effort, 'state:' + execution).entries) {
    if (e.kind === 'usage') recorded.set(e.agent, canonical(e.models))
  }

  const entries = []
  for (const a of runs.flat()) {
    if (!existsSync(a.path)) continue
    const models = usageOfTranscript(readFileSync(a.path, 'utf8'))
    if (Object.keys(models).length === 0 || recorded.get(a.id) === canonical(models)) continue
    entries.push({ kind: 'usage', agent: a.id, label: a.label, models })
  }
  if (entries.length) {
    const wrote = append(repo, effort, 'state:' + execution, entries)
    if (!wrote.ok) throw new Error(wrote.error)
  }
  return { runs: runs.length, agents: runs.flat().length, appended: entries.length }
}
