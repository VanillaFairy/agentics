// lib/status.mjs — every status a person reads about agentics work, derived from the logs on each
// call: the efforts in a repository, one effort's tree, one execution's todo list, and what an
// effort's dispatches cost.
//
// Design: docs/DESIGN.md#progress, docs/DESIGN.md#self-checks.
//
// Why nothing here is stored. A status written down outlives the thing it described (GP5), so this
// file only renders: node status comes from `deriveStatus` over `nodes.jsonl` and `events.jsonl`,
// an execution is closed when its `state.jsonl` says so, and a cost is a sum over `dispatch` lines.
// Nothing reads a rendering back as state — not the todo list, not the ONGOING / DONE /
// NEEDS_INPUT header, which is display and nothing else.
//
// Why a todo list is derived here at all. The live todo list is moved by the boundary couriers.
// When the host cannot grant task tools to a subagent, or the user asked for `--no-progress`, the
// session derives the same list from the logs instead (`todos`), on launch, on wake and on return.
// It is the same function of the same facts, so the two paths cannot tell different stories.
//
// Why the cost report. Every execution records one `dispatch` line per agent it bought, with the
// model and the effort, and `lib/usage.mjs` records what each agent spent as `usage` lines. Summing
// them is how the next triage quotes a measured figure instead of a guess; a dispatch with no usage
// recorded is counted as unreported rather than as zero, because a zero would read as "free".
//
// Why the snapshot. The agentics viewer (a separate, read-only renderer) draws one effort from a
// single call rather than five, and needs the same facts a person would piece together from `show`,
// `todos` and `cost` plus a folder's approval and a leaf's git history. `snapshotOf` is that one
// call: read-only, so it writes no file, no lock and no `seq`. Its folder walk is `foldersOf`,
// moved here from `next.mjs` (which imports it back) so the walk exists once; `approval.mjs` and
// `spec.mjs` (imported below) import neither `status.mjs` nor `next.mjs`, so this file importing
// them is not a cycle — only importing `next.mjs` back into this file would be.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { approvalState } from './approval.mjs'
import { executionsOf } from './effort.mjs'
import { readLog, seqMax } from './ledger.mjs'
import { resumeLeaves } from './resume.mjs'
import { ownerEntry, parseSpec } from './spec.mjs'
import {
  AGENTICS_DIR, ROOT_ID, agenticsRoot, branchOf, briefPath, effortsRoot, effortStateDir, envelope,
  executionDir, flagOf, folderDir, git, mainCheckout, parentOf, posix, progressPath, readJson, reportPath, revParse,
  safeSlug, saidFile, saidOf, sleepMs, specPath, worktreeOf,
} from './store.mjs'
import { cycleOf, ownerOf, readTree, renderTree, subtreeOf } from './tree.mjs'
import { tokensOf, usdOf } from './usage.mjs'

const DONE_STATUSES = new Set(['merged', 'integrated', 'landed'])

/** What a dispatched producer is doing, by the role it was dispatched as. */
const STAGE = {
  implementer: 'implementing',
  'test-author': 'writing tests',
  auditor: 'auditing',
  reviewer: 'in review',
}
const PRODUCERS = new Set(['implementer', 'test-author', 'auditor'])

// ------------------------------------------------------------------ executions

/** An execution's root, from the envelope preflight wrote; the effort root when there is none yet. */
function executionRoot(repo, effort, stamp) {
  const env = readJson(join(executionDir(repo, effort, stamp), 'execution.json'))
  return env && typeof env.root === 'string' && env.root !== '' ? env.root : ROOT_ID
}

/**
 * One execution's summary: closed when its state log carries a `closed` line (postflight writes
 * one only on `done`); otherwise `checkpoint` when the last thing it decided was a checkpoint, and
 * `open` for anything else — running, paused, or killed, which the logs cannot tell apart.
 */
export function executionSummary(repo, effort, stamp) {
  const state = readLog(repo, effort, 'state:' + stamp).entries
  const closed = [...state].reverse().find((e) => e.kind === 'closed')
  const last = state.length ? state[state.length - 1] : null
  return {
    stamp,
    root: executionRoot(repo, effort, stamp),
    closed: Boolean(closed),
    status: closed ? (typeof closed.status === 'string' && closed.status ? closed.status : 'done')
      : last && last.kind === 'checkpoint' ? 'checkpoint' : 'open',
    // What the execution's merge-batches did, for the status table: how many ran, how many
    // children landed, and how many batches had to be bisected.
    batches: state.filter((e) => e.kind === 'batch').length,
    merged: state.filter((e) => e.kind === 'batch').reduce((n, e) => n + (Array.isArray(e.merged) ? e.merged.length : 0), 0),
    bisected: state.filter((e) => e.kind === 'batch' && e.verified === false).length,
  }
}

/**
 * The questions an execution raised after `since` (a seq): every `escalated` and `parked` event of
 * that execution, one line each, and whether an invocation `ended` after `since`. What a session
 * watching a running execution asks the user the moment it lands.
 */
export function questionsSince(repo, effort, stamp, since) {
  const newer = (e) => Number.isInteger(e.seq) && e.seq > since
  const lines = readLog(repo, effort, 'events').entries
    .filter((e) => newer(e) && e.execution === stamp && (e.kind === 'escalated' || e.kind === 'parked'))
    .map((e) => ({
      seq: e.seq,
      line: e.kind + ' ' + e.node + ' (' + (e.kind === 'parked' ? e.return : e.reason) + '): ' +
        saidOf(e).split('\n')[0] + (saidFile(e) ? ' (in full: ' + saidFile(e) + ')' : ''),
    }))
  const ended = readLog(repo, effort, 'state:' + stamp).entries.some((e) => newer(e) && e.kind === 'ended')
  return { lines, ended, seq_max: seqMax(repo, effort) }
}

/**
 * The checkpoint an execution last stopped at, with everything it found: the overlapping
 * executions, the gaps. Null when it stopped at none.
 */
export function checkpointOf(repo, effort, stamp) {
  const last = [...readLog(repo, effort, 'state:' + stamp).entries].reverse()
    .find((e) => e.kind === 'checkpoint' || e.kind === 'checkpoint-confirmed')
  if (!last) return null
  const { kind, seq: _s, ...checkpoint } = last
  return kind === 'checkpoint' ? checkpoint : { reason: 'confirmed', detail: 'the user confirmed past these', ...checkpoint }
}

function renderCheckpoint(c) {
  if (!c) return '(no checkpoint)'
  const lines = [c.reason + ': ' + (c.detail || '')]
  for (const e of c.executions || []) lines.push('  execution ' + e.stamp + ' (root ' + e.root + ')')
  for (const g of c.gaps || []) lines.push('  ' + g.decision + ' at ' + g.at + ': ' + g.why)
  return lines.join('\n')
}

// ------------------------------------------------------------------ efforts

/**
 * Every effort in the repository with its derived root status, its node count per status, its
 * executions and the last `seq` it minted. Newest name first, as `listEfforts` orders them.
 * An effort with no root node yet reports `root_status: 'unplanned'`.
 */
export function efforts(repo) {
  let entries
  try {
    entries = readdirSync(effortsRoot(repo), { withFileTypes: true })
  } catch {
    return {
      repo: posix(repo), store_present: false, store: posix(agenticsRoot(repo)), efforts: [],
      notes: 'no effort store exists at ' + AGENTICS_DIR + ' in this repository',
    }
  }

  const out = entries
    .filter((e) => e.isDirectory() && safeSlug(e.name) === e.name)
    .map((e) => {
      const effort = e.name
      const tree = readTree(repo, effort)
      const counts = {}
      for (const s of tree.status.values()) counts[s.status] = (counts[s.status] || 0) + 1
      const identity = readJson(join(effortStateDir(repo, effort), 'effort.json')) || {}
      return {
        effort,
        about: typeof identity.about === 'string' ? identity.about : '',
        root_status: tree.status.has(ROOT_ID) ? tree.status.get(ROOT_ID).status : 'unplanned',
        counts,
        executions: executionsOf(repo, effort).map((stamp) => executionSummary(repo, effort, stamp)),
        seq_max: seqMax(repo, effort),
        malformed: tree.malformed,
      }
    })
    .sort((a, b) => (a.effort < b.effort ? 1 : -1))

  return {
    repo: posix(repo), store_present: true, store: posix(agenticsRoot(repo)), efforts: out,
    notes: 'listed ' + out.length + ' effort(s)',
  }
}

// ------------------------------------------------------------------ todos

/**
 * Pure. The todo item for one node, from its derived status and its events.
 *
 * `status` is one of the host's three task states; `activeForm` names the stage — what happens
 * next — as the boundaries set it on the live list.
 */
export function todoFor(nodes, status, events, id, { executionRootId = ROOT_ID } = {}) {
  const n = nodes.get(id)
  const s = status.get(id) ? status.get(id).status : 'planned'
  const item = (st, activeForm) => ({ key: id, subject: id + ' — ' + n.title, status: st, activeForm, node_status: s })

  if (s === 'merged' || s === 'landed') return item('completed', 'merged')
  if (s === 'integrated') {
    // The execution's own root has nothing after integration but the user's landing; a composite
    // below it still waits for the merge-batch that takes it into its parent.
    return id === executionRootId ? item('completed', 'integrated') : item('in_progress', 'awaiting merge')
  }
  if (s === 'escalated') {
    const e = status.get(id).last
    return item('pending', 'escalated: ' + (e && e.reason ? e.reason : 'below'))
  }
  if (s === 'parked') return item('pending', 'waiting on user')
  if (s === 'open') return item('pending', 'awaiting design')
  if (s === 'planned') return item('pending', 'queued')

  if (s === 'approved') {
    // A cycle member is held until the cycle's last member is approved; the tips merge together.
    const cycle = cycleOf(nodes, id)
    const tip = cycle.length ? cycle[cycle.length - 1] : id
    const tipStatus = status.get(tip) ? status.get(tip).status : 'planned'
    return item('in_progress', tip !== id && tipStatus !== 'approved' && tipStatus !== 'merged' ? 'held' : 'awaiting merge')
  }

  // active
  if (n.kind !== 'leaf') return item('in_progress', 'in progress')
  let last = null
  for (const e of events) if (e.kind === 'dispatched' && e.node === id && (!last || e.seq > last.seq)) last = e
  const role = last && typeof last.role === 'string' ? last.role : ''
  const round = last && Number.isInteger(last.round) ? last.round : 1
  if (round > 1 && PRODUCERS.has(role)) return item('in_progress', 'fix round ' + round)
  return item('in_progress', STAGE[role] || 'checking')
}

/**
 * The derived todo list of one execution — the `--no-progress` path. One item per live node in
 * the execution's subtree, pre-order, subject `<id> — <title>`, plus the display header:
 * DONE when the execution's root is merged, integrated or landed; NEEDS_INPUT when something in
 * the subtree is parked or escalated and nothing is active; ONGOING otherwise.
 */
export function todosOf(repo, effort, execution) {
  const root = executionRoot(repo, effort, execution)
  const tree = readTree(repo, effort)
  const ids = subtreeOf(tree.nodes, root)
  const todos = ids.map((id) => todoFor(tree.nodes, tree.status, tree.events, id, { executionRootId: root }))

  const statuses = ids.map((id) => tree.status.get(id).status)
  const rootStatus = tree.status.has(root) ? tree.status.get(root).status : ''
  const header = DONE_STATUSES.has(rootStatus) ? 'DONE'
    : statuses.some((s) => s === 'parked' || s === 'escalated') && !statuses.includes('active') ? 'NEEDS_INPUT'
      : 'ONGOING'

  return {
    effort, execution, root, header, todos,
    ...(ids.length === 0 ? { notes: 'no live node ' + JSON.stringify(root) + ' in this effort — nothing to list' } : {}),
    ...(tree.error ? { error: tree.error } : {}),
  }
}

/** Pure. The todo list as a person reads it. */
export function renderTodos(list) {
  const mark = { completed: '[x]', in_progress: '[>]', pending: '[ ]' }
  return [list.header + ' — ' + list.effort + ' / ' + list.execution + ' (root ' + list.root + ')',
    ...list.todos.map((t) => mark[t.status] + ' ' + t.subject + ' — ' + t.activeForm)].join('\n')
}

// ------------------------------------------------------------------ cost

/** Add one agent's `models` (the five counts per model, as a `usage` line holds them) into `into`. */
function addUsage(into, models) {
  for (const [model, counts] of Object.entries(models || {})) {
    const sum = into[model] ||= { input: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, output: 0 }
    for (const f of Object.keys(sum)) sum[f] += Number.isFinite(counts[f]) ? counts[f] : 0
  }
}

/** Pure. Summed counts as the report shows them: per model, the two cache writes as one, with dollars. */
function spendOf(models) {
  const usage = {}
  let tokens = 0
  let usd = 0
  for (const [model, c] of Object.entries(models)) {
    const cost = usdOf(model, c)
    usage[model] = { input: c.input, cache_write: c.cache_write_5m + c.cache_write_1h, cache_read: c.cache_read, output: c.output, usd: cost }
    tokens += tokensOf(c)
    usd += cost || 0
  }
  return { tokens, usd, usage }
}

/**
 * The cost report: every `dispatch` line across the effort's executions, counted per model and
 * per role, and what their agents spent, from the `usage` lines (the last one per agent). A
 * dispatch with no usage under its label in its execution is counted as unreported. `usage` is
 * the spend per model actually billed, `usd` its dollars over the models that have a price (a
 * model without one carries `usd: null`). `per_leaf` is each leaf's own spend: an agent's is the
 * leaf its label names (`<what>:<node id>#<round>`), since an agent whose run died before its
 * dispatch was recorded still has a label. `leaf_mean_tokens` and `leaf_mean_usd` average the
 * merged leaves with no unreported dispatch — the measured cost-per-leaf a scheduler or a triage
 * quotes — and are null when no leaf qualifies, never 0.
 */
export function costOf(repo, effort) {
  const tree = readTree(repo, effort)
  const stamps = executionsOf(repo, effort)
  const out = { effort, executions: stamps, dispatches: 0, by_model: {}, by_role: {}, tokens_unreported: 0 }
  const total = {}
  const leaves = {}
  const leafOf = (id) => {
    const node = tree.nodes.get(id)
    return node && node.kind === 'leaf' ? (leaves[id] ||= { dispatches: 0, tokens_unreported: 0, models: {} }) : null
  }

  for (const stamp of stamps) {
    const entries = readLog(repo, effort, 'state:' + stamp).entries
    const byAgent = new Map()
    for (const e of entries) if (e.kind === 'usage') byAgent.set(e.agent, e)
    const reported = new Set()
    for (const e of byAgent.values()) {
      const label = String(e.label || '')
      reported.add(label)
      addUsage(total, e.models)
      const leaf = leafOf(label.replace(/(#\d+)+$/, '').split(':').pop())
      if (leaf) addUsage(leaf.models, e.models)
    }

    for (const d of entries) {
      if (d.kind !== 'dispatch') continue
      out.dispatches++
      const model = typeof d.model === 'string' && d.model ? d.model : 'unknown'
      const role = typeof d.role === 'string' && d.role ? d.role : 'unknown'
      out.by_model[model] = (out.by_model[model] || 0) + 1
      out.by_role[role] = (out.by_role[role] || 0) + 1
      const unreported = reported.has(d.label) ? 0 : 1
      out.tokens_unreported += unreported

      const leaf = leafOf(d.node)
      if (leaf) {
        leaf.dispatches++
        leaf.tokens_unreported += unreported
      }
    }
  }

  Object.assign(out, spendOf(total))
  out.per_leaf = Object.fromEntries(Object.entries(leaves).map(([id, l]) => [id, {
    dispatches: l.dispatches, ...spendOf(l.models), tokens_unreported: l.tokens_unreported, status: tree.status.get(id).status,
  }]))

  const measured = Object.values(out.per_leaf).filter((l) => l.status === 'merged' && l.tokens_unreported === 0)
  const mean = (field) => (measured.length ? measured.reduce((a, l) => a + l[field], 0) / measured.length : null)
  out.leaf_mean_tokens = measured.length ? Math.round(mean('tokens')) : null
  out.leaf_mean_usd = mean('usd')
  out.leaves_measured = measured.length
  return out
}

const dollars = (usd) => '$' + usd.toFixed(2)

/** Pure. The cost report as a person reads it. */
function renderCost(cost) {
  const pairs = (o) => Object.entries(o).sort().map(([k, v]) => k + ' ' + v).join(', ') || '—'
  return [
    cost.effort + ': ' + cost.dispatches + ' dispatch(es) over ' + cost.executions.length + ' execution(s)',
    'by model: ' + pairs(cost.by_model),
    'by role:  ' + pairs(cost.by_role),
    'spent:    ' + dollars(cost.usd) + ', ' + cost.tokens + ' tokens' +
      (cost.tokens_unreported ? ' (+ ' + cost.tokens_unreported + ' dispatch(es) unreported)' : ''),
    ...Object.entries(cost.usage).sort().map(([model, u]) => '  ' + model + ': ' + (u.usd === null ? 'no price' : dollars(u.usd)) +
      ' — input ' + u.input + ', cache write ' + u.cache_write + ', cache read ' + u.cache_read + ', output ' + u.output),
    'per leaf: ' + (cost.leaf_mean_usd === null ? 'no merged leaf fully measured'
      : dollars(cost.leaf_mean_usd) + ', ' + cost.leaf_mean_tokens + ' tokens mean over ' + cost.leaves_measured + ' merged leaf(s)'),
  ].join('\n')
}

/** Pure. The efforts listing as a person reads it. */
function renderEfforts(list) {
  if (!list.store_present) return list.notes
  if (list.efforts.length === 0) return '(no efforts)'
  return list.efforts.map((e) => {
    const counts = Object.entries(e.counts).sort().map(([k, v]) => k + ' ' + v).join(', ') || 'no nodes'
    const open = e.executions.filter((x) => !x.closed).map((x) => x.stamp + ' (' + x.status + ', root ' + x.root + ')')
    return e.effort + ' — ' + e.root_status + ' — ' + counts +
      (e.about ? '\n  ' + e.about : '') +
      '\n  executions: ' + e.executions.length + (open.length ? ', open: ' + open.join('; ') : '') +
      ' · seq ' + e.seq_max
  }).join('\n')
}

// ------------------------------------------------------------------ snapshot

/** The root folder and every folder below it that holds a spec, depth-first. Exported so
 * `next.mjs` can import it back instead of keeping its own copy of the walk. */
export function foldersOf(repo, effort) {
  const out = []
  const walk = (id) => {
    const path = specPath(repo, effort, id)
    const exists = existsSync(path)
    if (exists || id === ROOT_ID) {
      out.push({ id, path: posix(path), exists, spec: parseSpec(exists ? readFileSync(path, 'utf8') : '', { file: posix(path) }) })
    }
    let names = []
    try {
      names = readdirSync(folderDir(repo, effort, id), { withFileTypes: true })
        .filter((e) => e.isDirectory() && safeSlug(e.name) === e.name).map((e) => e.name).sort()
    } catch {
      names = []
    }
    for (const name of names) walk(id === ROOT_ID ? name : id + '/' + name)
  }
  walk(ROOT_ID)
  return out
}

/** A folder's spec, parsed once and cached by folder id; null when there is none to read. */
function readSpecCached(repo, effort, id, cache) {
  if (cache.has(id)) return cache.get(id)
  const path = specPath(repo, effort, id)
  let result = null
  try {
    result = parseSpec(readFileSync(path, 'utf8'), { file: posix(path) })
  } catch {
    result = null
  }
  cache.set(id, result)
  return result
}

/** One folder's snapshot entry: its own spec's title, its approval state, and its blocking count. */
function folderOf(repo, effort, id, cache) {
  const spec = readSpecCached(repo, effort, id, cache)
  return {
    id,
    title: spec ? spec.title : '',
    approval: approvalState(repo, effort, id).state,
    blocking: spec ? spec.questions.filter((q) => q.grade === 'blocking').length : 0,
    spec: { path: posix(specPath(repo, effort, id)) },
  }
}

/**
 * A leaf's spec line is the line of its folder's plan entry named after it, and a group's the line
 * of its heading there; a composite or design node links its own folder's spec, at no particular
 * line.
 */
function specFileOf(repo, effort, node, cache) {
  const specAt = (id) => readSpecCached(repo, effort, id, cache)
  if (node.kind === 'group') {
    const folder = parentOf(node.id)
    const spec = specAt(folder)
    const group = spec ? (spec.groups || []).find((g) => g.name === node.id.slice(node.id.lastIndexOf('/') + 1)) : null
    return { path: posix(specPath(repo, effort, folder)), line: group ? group.line : null }
  }
  if (node.kind !== 'leaf') return { path: posix(specPath(repo, effort, node.id)), line: null }
  const { folder, entry } = ownerEntry(node.id, specAt)
  return { path: posix(specPath(repo, effort, folder)), line: entry ? entry.line : null }
}

/** The briefs and reports actually on disk for one node, across every dispatch its events record. */
function filesOf(repo, effort, tree, node, cache) {
  const briefs = []
  const reports = []
  for (const d of tree.events) {
    if (d.kind !== 'dispatched' || d.node !== node.id) continue
    const stamp = typeof d.execution === 'string' ? d.execution : ''
    if (!stamp) continue
    const role = typeof d.role === 'string' ? d.role : ''
    const round = Number.isInteger(d.round) ? d.round : 1
    const brief = briefPath(repo, effort, stamp, node.id, role, round)
    const report = reportPath(repo, effort, stamp, node.id, role, round)
    if (existsSync(brief)) briefs.push(brief)
    if (existsSync(report)) reports.push(report)
  }
  return { spec: specFileOf(repo, effort, node, cache), briefs, reports }
}

/** The event a person needs explained: why a node is escalated or parked. Null otherwise — every
 * other status is already legible from `status` and `stage` alone. */
function eventOf(s) {
  if (!s.last) return null
  if (s.status === 'escalated') return { kind: 'escalated', seq: s.last.seq, reason: s.last.reason, detail: saidOf(s.last), said: saidFile(s.last) }
  if (s.status === 'parked') return { kind: 'parked', seq: s.last.seq, return: s.last.return, question: saidOf(s.last), said: saidFile(s.last) }
  return null
}

/** A report's first paragraph of prose, on one line: what its author led with. */
function leadOf(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return ''
  }
  const lead = text.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#') && !p.startsWith('```'))
  return lead ? lead.replace(/\s*\n\s*/g, ' ') : ''
}

/** The report of a node's latest dispatch that left one, with its lead; null when none did. */
function reportOf(repo, effort, events, id) {
  const dispatches = events.filter((e) => e.kind === 'dispatched' && e.node === id && typeof e.execution === 'string' && e.execution)
    .sort((a, b) => b.seq - a.seq)
  for (const d of dispatches) {
    const path = reportPath(repo, effort, d.execution, id, typeof d.role === 'string' ? d.role : '', Number.isInteger(d.round) ? d.round : 1)
    if (existsSync(path)) return { path, lead: leadOf(path) }
  }
  return null
}

const PROGRESS_STATES = new Set(['pending', 'working', 'done'])

/**
 * Pure. A progress file's text as `{items, error}`: the items when every one is `{name, state}`
 * with a known state, else no items and what is wrong — a file caught mid-rewrite reads as
 * unreadable, never as fewer pieces.
 */
export function parseProgress(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch (err) {
    return { items: null, error: 'not JSON (' + err.message + ')' }
  }
  const items = doc && Array.isArray(doc.items) ? doc.items : null
  if (!items) return { items: null, error: 'no items array' }
  const bad = items.findIndex((it) => !it || typeof it.name !== 'string' || !it.name.trim() || !PROGRESS_STATES.has(it.state))
  if (bad !== -1) return { items: null, error: 'item ' + bad + ' is not {name, state: pending | working | done}' }
  return { items: items.map((it) => ({ name: it.name.trim(), state: it.state })), error: null }
}

/**
 * The progress file of an unfinished leaf's latest dispatch that left one, as `{path, items,
 * error}`; null for anything else. A finished leaf's commits say what it did.
 */
function progressOf(repo, effort, events, node, status) {
  if (node.kind !== 'leaf' || DONE_STATUSES.has(status)) return null
  const dispatches = events.filter((e) => e.kind === 'dispatched' && e.node === node.id && typeof e.execution === 'string' && e.execution)
    .sort((a, b) => b.seq - a.seq)
  for (const d of dispatches) {
    const path = progressPath(repo, effort, d.execution, node.id, typeof d.role === 'string' ? d.role : '', Number.isInteger(d.round) ? d.round : 1)
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    return { path, ...parseProgress(text) }
  }
  return null
}

/** How many commits a leaf's folder branch holds that the leaf's own lacks; null when either is missing. */
function behindOf(main, effort, nodes, id) {
  const parentBranch = branchOf(effort, ownerOf(nodes, id))
  const leafBranch = branchOf(effort, id)
  if (!revParse(main, parentBranch) || !revParse(main, leafBranch)) return null
  const r = git(main, ['rev-list', '--count', leafBranch + '..' + parentBranch])
  const n = r.ok ? Number.parseInt(r.stdout.trim(), 10) : NaN
  return Number.isInteger(n) ? n : null
}

/**
 * What the cards of `ids` share: the open executions, and the resume ladder's row for each
 * unfinished leaf among them, asked of git once for all of them.
 */
function cardGround(repo, effort, tree, ids) {
  const open = executionsOf(repo, effort).map((stamp) => executionSummary(repo, effort, stamp)).filter((x) => !x.closed)
  const unfinished = new Set(ids.filter((id) => tree.nodes.get(id).kind === 'leaf' && !DONE_STATUSES.has(tree.status.get(id).status)))
  const asked = [...tree.nodes.values()].filter((n) => n.kind !== 'leaf' || unfinished.has(n.id))
  const latest = open.length ? open[open.length - 1].stamp : ''
  const rows = unfinished.size ? resumeLeaves(repo, effort, latest, asked) : []
  return { open, unfinished, rows: new Map(rows.map((r) => [r.id, r])) }
}

/**
 * A node's card: what a session needs to move it on, beyond its status and its stop. The next
 * action is the resume ladder's, so the card and a relaunch cannot disagree.
 */
function cardOf(repo, main, effort, tree, ground, id) {
  const status = tree.status.get(id)
  const row = ground.rows.get(id)
  const held = ground.open.filter((x) => x.root === ROOT_ID || x.root === id || id.startsWith(x.root + '/')).pop()
  return {
    next: row ? { action: row.next_action, why: row.note } : null,
    behind: ground.unfinished.has(id) ? behindOf(main, effort, tree.nodes, id) : null,
    report: reportOf(repo, effort, tree.events, id),
    notes: tree.events.filter((e) => e.kind === 'noted' && e.node === id).sort((a, b) => b.seq - a.seq)
      .map((e) => ({ seq: e.seq, by: e.by, text: e.text })),
    relaunch: held
      ? { execution: held.stamp, root: held.root, retry_escalated: status.status === 'escalated' && status.last ? [id] : [] }
      : null,
  }
}

/** The snapshot's entries for `ids`, in that order. */
function nodeEntries(repo, effort, tree, ids, specCache) {
  const main = mainCheckout(repo)
  const ground = cardGround(repo, effort, tree, ids)
  return ids.map((id) => {
    const n = tree.nodes.get(id)
    const s = tree.status.get(id)
    const todo = todoFor(tree.nodes, tree.status, tree.events, id)
    const wt = worktreeOf(main, effort, id)
    return {
      id: n.id,
      // What the viewer draws: the entry's own label, else the last segment of its id.
      label: n.label || (id === ROOT_ID ? effort : id.split('/').pop()),
      parent: parentOf(id),
      kind: n.kind,
      author: n.author,
      title: n.title,
      intent: n.intent,
      context: n.context,
      rigor: n.rigor,
      role: n.role,
      locus: n.locus,
      deps: n.deps,
      acceptance: n.acceptance,
      status: s.status,
      event: eventOf(s),
      stage: todo.status === 'in_progress' ? todo.activeForm : null,
      branch: branchOf(effort, id),
      worktree: existsSync(wt) ? wt : null,
      commits: commitsOf(main, effort, tree.nodes, n, s.status),
      progress: progressOf(repo, effort, tree.events, n, s.status),
      files: filesOf(repo, effort, tree, n, specCache),
      card: cardOf(repo, main, effort, tree, ground, id),
    }
  })
}

/** One node as the snapshot holds it: what a session starting on that node reads first. */
export function nodeOf(repo, effort, id) {
  const tree = readTree(repo, effort)
  if (!tree.nodes.has(id)) throw new Error('no live node ' + JSON.stringify(id) + ' in ' + effort)
  return nodeEntries(repo, effort, tree, [id], new Map())[0]
}

const PROGRESS_MARK = { done: '[x]', working: '[>]', pending: '[ ]' }

/** Pure. A node's entry as a person reads it, ending with how to relaunch it. */
export function renderNode(n) {
  const lines = [n.id + ' — ' + n.title, 'status: ' + n.status + (n.stage ? ', ' + n.stage : '')]
  if (n.progress) {
    lines.push(n.progress.items
      ? 'progress: ' + n.progress.items.map((it) => PROGRESS_MARK[it.state] + ' ' + it.name).join(', ')
      : 'progress: unreadable, ' + n.progress.error + ' — ' + n.progress.path)
  }
  if (n.event) {
    const text = n.event.kind === 'parked' ? n.event.question : n.event.detail
    lines.push(n.event.kind + ' (' + (n.event.kind === 'parked' ? n.event.return : n.event.reason) + '), seq ' + n.event.seq + ':',
      ...String(text || '').split('\n').map((l) => '  ' + l))
    if (n.event.said) lines.push('  in full: ' + n.event.said)
  }
  const c = n.card
  if (c.next) lines.push('next: ' + c.next.action + ' — ' + c.next.why)
  if (c.behind) lines.push('behind: ' + n.branch + ' lacks ' + c.behind + ' commit' + (c.behind === 1 ? '' : 's') + ' of its folder\'s branch')
  if (c.report) lines.push('report: ' + c.report.lead, '  in full: ' + c.report.path)
  if (c.notes.length) lines.push('notes, newest first:', ...c.notes.map((x) => '  #' + x.seq + ' ' + x.by + ': ' + x.text))
  if (n.files.spec.path) lines.push('spec: ' + n.files.spec.path + (n.files.spec.line !== null ? ':' + n.files.spec.line : ''))
  lines.push(c.relaunch
    ? 'relaunch: execution ' + c.relaunch.execution + ', root ' + c.relaunch.root +
      (c.relaunch.retry_escalated.length ? ', retry_escalated ' + JSON.stringify(c.relaunch.retry_escalated) : '')
    : 'relaunch: no open execution holds this node')
  return lines.join('\n')
}

/**
 * A leaf's commit count and last commit on its own branch, over its folder's: null when either
 * branch does not exist, and never attempted for a leaf that is not `active` or for anything that
 * is not a leaf — a git call each other node would never use.
 */
function commitsOf(main, effort, nodes, node, status) {
  if (node.kind !== 'leaf' || status !== 'active') return null
  const parentBranch = branchOf(effort, ownerOf(nodes, node.id))
  const leafBranch = branchOf(effort, node.id)
  if (!revParse(main, parentBranch) || !revParse(main, leafBranch)) return null
  const r = git(main, ['log', '--format=%s%x1f%cI', parentBranch + '..' + leafBranch])
  if (!r.ok) return null
  const lines = r.stdout.split('\n').filter(Boolean)
  if (!lines.length) return null
  const [last_subject, last_at] = lines[0].split('\x1f')
  return { count: lines.length, last_subject, last_at }
}

/**
 * The viewer's whole read of one effort in a single call: format 3 of the Snapshot contract
 * (agentics-viewer/shared/interfaces.md § Snapshot contract). Read-only — it writes no file, no
 * lock and no `seq` — and reads through the main checkout even when `repo` is a linked worktree, so
 * a snapshot taken from either place agrees.
 */
export function snapshotOf(repo, effort) {
  const tree = readTree(repo, effort)
  const identity = readJson(join(effortStateDir(repo, effort), 'effort.json')) || {}
  const specCache = new Map()

  const folders = foldersOf(repo, effort).map((f) => folderOf(repo, effort, f.id, specCache))

  const reached = subtreeOf(tree.nodes, ROOT_ID)
  const reachedSet = new Set(reached)
  const order = [...reached, ...[...tree.nodes.keys()].filter((id) => !reachedSet.has(id)).sort()]

  const nodes = nodeEntries(repo, effort, tree, order, specCache)

  const c = costOf(repo, effort)
  const spend = (s) => ({ dispatches: s.dispatches, tokens: s.tokens, usd: s.usd, tokens_unreported: s.tokens_unreported, usage: s.usage })
  const cost = {
    ...spend(c),
    per_leaf: Object.fromEntries(Object.entries(c.per_leaf).map(([id, l]) => [id, spend(l)])),
  }

  return {
    format: 3,
    store: posix(agenticsRoot(repo)),
    effort,
    about: typeof identity.about === 'string' ? identity.about : '',
    seq_max: seqMax(repo, effort),
    malformed: tree.malformed,
    folders,
    nodes,
    cost,
  }
}

// ------------------------------------------------------------------ CLI

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const argv = process.argv.slice(2)
    const [command] = argv
    const repo = flagOf(argv, 'repo') || '.'
    const effort = flagOf(argv, 'effort')
    const json = argv.includes('--json')
    const needEffort = () => {
      if (!safeSlug(effort)) throw new Error('--effort must name an effort, not ' + JSON.stringify(effort))
    }
    const print = (payload, render) => console.log(json ? JSON.stringify(envelope(payload)) : render(payload))

    if (command === 'list') {
      print(efforts(repo), renderEfforts)
    } else if (command === 'show') {
      needEffort()
      const tree = readTree(repo, effort)
      const root = flagOf(argv, 'root') || ROOT_ID
      print({
        effort, root,
        nodes: subtreeOf(tree.nodes, root).map((id) => ({ ...tree.nodes.get(id), status: tree.status.get(id).status })),
        malformed: tree.malformed,
      }, () => renderTree(tree.nodes, tree.status, root) || '(no nodes)')
    } else if (command === 'todos') {
      needEffort()
      const execution = flagOf(argv, 'execution')
      if (!execution) throw new Error('--execution <stamp> is required')
      print(todosOf(repo, effort, execution), renderTodos)
    } else if (command === 'checkpoint') {
      needEffort()
      const execution = flagOf(argv, 'execution')
      if (!execution) throw new Error('--execution <stamp> is required')
      print(checkpointOf(repo, effort, execution), renderCheckpoint)
    } else if (command === 'watch') {
      // One line per question as it lands, until the running invocation ends. Read-only.
      needEffort()
      const execution = flagOf(argv, 'execution')
      if (!execution) throw new Error('--execution <stamp> is required')
      const start = seqMax(repo, effort)
      const printed = new Set()
      for (;;) {
        const q = questionsSince(repo, effort, execution, start)
        for (const l of q.lines.filter((x) => !printed.has(x.seq))) {
          printed.add(l.seq)
          console.log(l.line)
        }
        if (q.ended) break
        sleepMs(2000)
      }
    } else if (command === 'cost') {
      needEffort()
      print(costOf(repo, effort), renderCost)
    } else if (command === 'node') {
      needEffort()
      print(nodeOf(repo, effort, flagOf(argv, 'node')), renderNode)
    } else if (command === 'snapshot') {
      needEffort()
      print(snapshotOf(repo, effort), () => {
        const tree = readTree(repo, effort)
        return renderTree(tree.nodes, tree.status) || '(no nodes)'
      })
    } else {
      throw new Error('unknown command ' + JSON.stringify(command || '') + ' — expected list, show, todos, checkpoint, watch, cost, node or snapshot')
    }
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
