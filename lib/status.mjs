// lib/status.mjs — every status a person reads about agentics work, derived from the logs on each
// call: the efforts in a repository, one effort's tree, one execution's todo list, what an
// effort's dispatches cost, and where that spend went per unit of work.
//
// Design: docs/DESIGN.md#progress, docs/DESIGN.md#self-checks.
//
// Why nothing here is stored. A status written down outlives the thing it described (GP5), so this
// file only renders: node status comes from `deriveStatus` over `nodes.jsonl` and `events.jsonl`,
// an execution is closed when its `state.jsonl` says so, and a cost is a sum over the runner's
// `returned` lines. Nothing reads a rendering back as state — not the todo list, not the ONGOING /
// DONE / NEEDS_INPUT header, which is display and nothing else.
//
// Why a todo list is derived here. The session that launched an execution writes its todo list
// from the records (`todos`), on launch, on every line its watch prints and when the run ends.
//
// Why the cost report. The runner records every call's usage and cost, the host's own figures, on
// its `returned` line, and the `dispatched` line before it names the call's node and model. Summing
// them is how the next triage quotes a measured figure instead of a guess; a call with no cost
// figure, or one that never returned, is counted as unmeasured rather than as zero, because a zero
// would read as "free".
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
import { rootBase } from './integration.mjs'
import { readLog, readRunLog, runState, seqMax } from './ledger.mjs'
import { addCall, callsOf, spend } from './run.mjs'
import { probersFor } from './programs/probe.mjs'
import { resumeLeaves } from './resume.mjs'
import { BRIEF_TOKENS } from './roles.mjs'
import { ownerEntry, parseSpec } from './spec.mjs'
import {
  AGENTICS_DIR, ROOT_ID, agenticsRoot, ancestorsOf, branchOf, effortsRoot, effortStateDir, envelope,
  executionDir, executionRunId, flagOf, handleArgs, folderDir, git, livePath, mainCheckout, parentOf, posix, readJson,
  isTestPath, resolveHandle, returnPath, revParse, runHome, safeSlug, saidOf, sleepMs, specPath, worktreeOf,
} from './store.mjs'
import { childrenOf, claimsEventOf, cycleOf, ownerOf, readTree, renderTree, reviewIdOf, subtreeOf, unsettledClaims } from './tree.mjs'

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
 * one only on `done`); otherwise `checkpoint` while its latest `checkpoint` line has no
 * `checkpoint-confirmed`, `run` or `closed` line after it, and `open` for anything else.
 */
export function executionSummary(repo, effort, stamp) {
  const state = readLog(repo, effort, 'state:' + stamp).entries
  const closed = [...state].reverse().find((e) => e.kind === 'closed')
  const after = state.slice(state.findLastIndex((e) => e.kind === 'checkpoint') + 1)
  const atCheckpoint = state.some((e) => e.kind === 'checkpoint') &&
    !after.some((e) => e.kind === 'checkpoint-confirmed' || e.kind === 'run' || e.kind === 'closed')
  return {
    stamp,
    root: executionRoot(repo, effort, stamp),
    closed: Boolean(closed),
    status: closed ? (typeof closed.status === 'string' && closed.status ? closed.status : 'done')
      : atCheckpoint ? 'checkpoint' : 'open',
    // What the execution's merge-batches did, for the status table: how many ran, how many
    // children landed, and how many batches had to be bisected.
    batches: state.filter((e) => e.kind === 'batch').length,
    merged: state.filter((e) => e.kind === 'batch').reduce((n, e) => n + (Array.isArray(e.merged) ? e.merged.length : 0), 0),
    bisected: state.filter((e) => e.kind === 'batch' && e.verified === false).length,
  }
}

/**
 * Pure. The watch's lines for records after `since`, and the current run's end: a line per
 * `escalated` or `parked` event that `open(e)` says is still its node's open stop
 * (`<id> escalated <reason>`, `<id> parked <return>`), per `host_stop`, `fault`, `paused`, `resumed` and `stalled`. `ended` is
 * the `ended` record after the latest `run` record, wherever it stands against `since`, so a watch
 * started after the end still sees it and an earlier run's end never ends this one; with
 * `endedAfter` it is only an `ended` above that seq, so a run not yet begun cannot end on the
 * previous run's (docs/DESIGN.md#detached-runs).
 */
export function runWatchLines(entries, since, { open = () => true, endedAfter = null } = {}) {
  const lines = []
  for (const e of entries.filter((x) => Number.isInteger(x.seq) && x.seq > since)) {
    if (e.kind === 'escalated' && open(e)) lines.push(e.node + ' escalated ' + e.reason)
    if (e.kind === 'parked' && open(e)) lines.push(e.node + ' parked ' + e.return)
    if (e.kind === 'host_stop') lines.push('host_stop ' + e.dispatch + ': ' + e.cause + ' until ' + (e.until || '-'))
    if (e.kind === 'fault') lines.push('fault ' + e.channel + ': ' + e.detail)
    if (e.kind === 'paused') lines.push('paused: what runs finishes, nothing new starts; the run then ends stopped: pause')
    if (e.kind === 'resumed') lines.push('resumed: the run goes on')
    if (e.kind === 'stalled') {
      const spent = (Array.isArray(e.spent) ? e.spent : []).map((s) => s.label + ' x' + s.n + ' ' + Math.round(s.ms / 1000) + 's').join(', ')
      lines.push('stalled: synchronous work held the main thread ' + Math.round(e.ms / 1000) + 's from ' + e.since + (spent ? ' (' + spent + ')' : '') + '; the records around seq ' + e.seq + ' name it')
    }
  }
  const ended = entries.slice(entries.findLastIndex((e) => e.kind === 'run') + 1)
    .findLast((e) => e.kind === 'ended' && (endedAfter === null || e.seq > endedAfter)) || null
  const seq_max = entries.reduce((max, e) => (Number.isInteger(e.seq) && e.seq > max ? e.seq : max), 0)
  return { lines, ended, seq_max }
}

/** Whether a stop event is still its node's open stop: the node's derived status is that event. */
const openStopIn = (tree) => (e) => {
  const s = tree.status.get(e.node)
  return Boolean(s && s.status === e.kind && s.last && s.last.seq === e.seq)
}

/**
 * Follow one run: print each line `runWatchLines` gives after `from` (null: the log's highest seq
 * now) as it lands, until the run ends or stops. An execution's stops are printed while they are
 * still open, read against the effort's tree at each look, and its end is only an `ended` above
 * `from`: an execution's log spans every run of it, and `from` was read before this run started.
 * The state is read before the log, so whatever a stopped run wrote is printed before `stopped`.
 * A live run whose heartbeat went stale prints `unresponsive` once, and `beating again` if it beats;
 * one that beats while its main thread has not turned prints `busy`, and `turning again` after.
 * `given` is resolved first, and every read after it uses the run it names.
 */
function watchRun(repo, given, from) {
  const found = resolveHandle(repo, 'run', given)
  if (!found.ok) {
    console.log(JSON.stringify({ ok: false, error: found.error }))
    return
  }
  const run = found.value
  const home = runHome(repo, run)
  const look = (since) => {
    // The log before the tree: a stop that lands between the two reads is then judged by a tree
    // that holds it, or left for the next look. Read the other way round, a stop landing after the
    // tree was read would be judged not open, and `since` would pass it for good.
    const entries = readRunLog(repo, run).entries
    const opts = home.stamp ? { open: openStopIn(readTree(repo, home.effort)), endedAfter: from } : {}
    return runWatchLines(entries, since, opts)
  }
  let since = from ?? runWatchLines(readRunLog(repo, run).entries, 0).seq_max
  let silent = false
  let busy = false
  for (;;) {
    const { state, run: meta, beating, turning } = runState(repo, run)
    const w = look(since)
    for (const line of w.lines) console.log(line)
    since = w.seq_max
    if (w.ended) {
      const r = w.ended.result || {}
      console.log('ended ' + r.status + ': complete=' + r.complete + ' result=' + r.file)
      return
    }
    if (state === 'stopped') {
      console.log('stopped: start the same command again to resume run ' + run)
      return
    }
    const stale = state === 'live' && !beating
    if (stale !== silent) {
      silent = stale
      console.log(silent ? 'unresponsive: pid ' + meta.pid + ' still runs ' + run + ' but has not beaten since ' + meta.heartbeat_at + '; it is not stopped, so do not start it again while it lives'
        : 'beating again: ' + run)
    }
    const held = state === 'live' && beating && !turning
    if (held !== busy) {
      busy = held
      console.log(busy ? 'busy: pid ' + meta.pid + ' beats, but its main thread has not turned since ' + meta.loop_at + ': synchronous work holds it'
        : 'turning again: ' + run)
    }
    sleepMs(2000)
  }
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

export function renderCheckpoint(c) {
  if (!c) return '(no checkpoint)'
  const lines = [c.reason + ': ' + (c.detail || '')]
  for (const e of c.executions || []) lines.push('  execution ' + e.stamp + ' (root ' + e.root + ')')
  for (const g of c.gaps || []) lines.push('  ' + g.decision + ' at ' + g.at + ': ' + g.why)
  for (const b of c.branches || []) lines.push('  ' + b.branch + ': ' + b.commits.join(', '))
  for (const l of c.lost || []) lines.push('  ' + l.branch + (l.exists ? '' : ' (gone)') + ': ' + l.node + ' merged at ' + l.merged_sha + '; held by ' + (l.reachable_from.join(', ') || 'no branch'))
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
 * What one read of an effort asks of each of its executions, each asked once: `records(stamp)`,
 * the execution's records merged by seq (its events, its state and its journal), and
 * `isLive(stamp)`, whether its run is live. A snapshot shares one, so its cost and its nodes'
 * `live` read the same answer and each execution's records are read once.
 */
function runReads(repo, effort) {
  const records = new Map()
  const live = new Map()
  const once = (memo, stamp, read) => {
    if (!memo.has(stamp)) memo.set(stamp, read())
    return memo.get(stamp)
  }
  return {
    records: (stamp) => once(records, stamp, () => readRunLog(repo, executionRunId(effort, stamp)).entries),
    isLive: (stamp) => once(live, stamp, () => runState(repo, executionRunId(effort, stamp)).state === 'live'),
  }
}

/**
 * The dispatches waiting out a host stop now, as `<execution> <dispatch>`: each whose latest
 * `dispatched` has a `host_stop` after it and no `returned`.
 */
function hostWaits(repo, effort, reads = runReads(repo, effort)) {
  const waiting = new Set()
  for (const stamp of executionsOf(repo, effort)) {
    const stopped = new Map()
    for (const e of reads.records(stamp)) {
      if (typeof e.dispatch !== 'string') continue
      if (e.kind === 'dispatched' || e.kind === 'returned') stopped.set(e.dispatch, false)
      else if (e.kind === 'host_stop' && stopped.has(e.dispatch)) stopped.set(e.dispatch, true)
    }
    for (const [dispatch, yes] of stopped) if (yes) waiting.add(stamp + ' ' + dispatch)
  }
  return waiting
}

/**
 * Pure. The todo item for one node, from its derived status and its events.
 *
 * `status` is one of the host's three task states; `activeForm` names the stage — what happens
 * next — as the session writes it on the list. `waiting` is `hostWaits`'s set.
 */
export function todoFor(nodes, status, events, id, { executionRootId = ROOT_ID, waiting = new Set() } = {}) {
  const n = nodes.get(id)
  const s = status.get(id) ? status.get(id).status : 'planned'
  const item = (st, activeForm) => ({ key: id, subject: id + ' — ' + n.title, status: st, activeForm, node_status: s })

  if (s === 'merged' || s === 'landed') {
    const last = status.get(id).last
    return item('completed', s === 'merged' && last && last.kind === 'merged' && last.by ? 'merged (adopted)' : 'merged')
  }
  if (s === 'reviewing') return item('in_progress', 'awaiting review')
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
  if (last && waiting.has(last.execution + ' ' + last.dispatch)) return item('in_progress', 'waiting on host')
  const role = last && typeof last.role === 'string' ? last.role : ''
  const round = last && Number.isInteger(last.round) ? last.round : 1
  if (round > 1 && PRODUCERS.has(role)) return item('in_progress', 'fix round ' + round)
  return item('in_progress', STAGE[role] || 'checking')
}

/**
 * Pure. The todo item for a composite's integration review, its own row after the composite's
 * children; null while the composite's children have not all merged. A finished review that left
 * `unsettled` claims for the user at landing is pending on them, never completed.
 */
function reviewTodoFor(status, id, unsettled = 0) {
  const s = status.get(id) || {}
  if (!s.review) return null
  const key = reviewIdOf(id)
  const item = (st, activeForm) => ({ key, subject: key + ' — integration review of ' + id, status: st, activeForm, node_status: s.review })
  if (s.review === 'done') return unsettled ? item('pending', unsettled + ' unsettled claim' + (unsettled === 1 ? '' : 's') + ' for landing') : item('completed', 'reviewed')
  if (s.review === 'not_earned') return item('completed', 'not earned')
  return s.status === 'reviewing' ? item('in_progress', 'in review') : item('pending', 'waiting on ' + id)
}

/** Pure. A subtree's todo rows in pre-order, each composite's review after its children. */
/** Pure. How many claims each folder's standing review leaves unsettled for landing (`unsettledClaims`). */
function unsettledCounts(nodes, events) {
  const out = new Map()
  for (const c of unsettledClaims(nodes, events)) out.set(c.node, (out.get(c.node) || 0) + 1)
  return out
}

function todoRows(nodes, status, events, root, waiting) {
  const rows = []
  const unsettled = unsettledCounts(nodes, events)
  const walk = (id) => {
    if (!nodes.has(id)) return
    rows.push(todoFor(nodes, status, events, id, { executionRootId: root, waiting }))
    for (const c of childrenOf(nodes, id)) walk(c)
    const review = reviewTodoFor(status, id, unsettled.get(id) || 0)
    if (review) rows.push(review)
  }
  walk(root)
  return rows
}

/**
 * The derived todo list of one execution — the `--no-progress` path. One item per live node in
 * the execution's subtree, pre-order, subject `<id> — <title>`, and one per composite's
 * integration review once its children have merged, plus the display header:
 * DONE when the execution's root is merged, integrated or landed and no claim in its subtree waits
 * unsettled for landing; NEEDS_INPUT when one does, or when something in the subtree is parked or
 * escalated and nothing is active; ONGOING otherwise.
 */
export function todosOf(repo, effort, execution) {
  const root = executionRoot(repo, effort, execution)
  const tree = readTree(repo, effort)
  const ids = subtreeOf(tree.nodes, root)
  const todos = todoRows(tree.nodes, tree.status, tree.events, root, hostWaits(repo, effort))

  const statuses = ids.map((id) => tree.status.get(id).status)
  const rootStatus = tree.status.has(root) ? tree.status.get(root).status : ''
  const waitsOnUser = unsettledClaims(tree.nodes, tree.events).some((c) => ids.includes(c.node))
  const header = DONE_STATUSES.has(rootStatus) && !waitsOnUser ? 'DONE'
    : DONE_STATUSES.has(rootStatus) ? 'NEEDS_INPUT'
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

/**
 * The cost report (docs/DESIGN.md#self-checks): every call across the effort's executions, from the
 * runner's `returned` lines — the host's own figures — summed for the effort, per model, per leaf
 * (the leaf the call's `dispatched` names) and per folder (every call at or below it). A call with
 * no cost figure, or one that never returned in a run that is not live, counts as unmeasured, never
 * as zero. `leaf_mean_tokens` and `leaf_mean_usd` average the merged leaves with nothing unmeasured
 * — the measured cost per leaf a triage quotes — and are null when no leaf qualifies, never 0.
 * `reads` is the caller's `runReads` when it shares one.
 */
export function costOf(repo, effort, reads = runReads(repo, effort)) {
  const tree = readTree(repo, effort)
  const stamps = executionsOf(repo, effort)
  const out = { effort, executions: stamps, ...spend(), by_model: {}, per_leaf: {}, per_folder: {} }
  for (const stamp of stamps) {
    for (const call of callsOf(reads.records(stamp), reads.isLive(stamp))) {
      addCall(out, call)
      if (call.model) addCall(out.by_model[call.model] ||= spend(), call)
      if (!tree.nodes.has(call.node)) continue
      if (tree.nodes.get(call.node).kind === 'leaf') addCall(out.per_leaf[call.node] ||= spend(), call)
      for (const id of [call.node, ...ancestorsOf(call.node)]) {
        if (tree.nodes.has(id) && tree.nodes.get(id).kind !== 'leaf') addCall(out.per_folder[id] ||= spend(), call)
      }
    }
  }
  for (const [id, leaf] of Object.entries(out.per_leaf)) leaf.status = tree.status.get(id).status
  const measured = Object.values(out.per_leaf).filter((l) => l.status === 'merged' && l.unmeasured === 0)
  const mean = (field) => (measured.length ? measured.reduce((a, l) => a + l[field], 0) / measured.length : null)
  out.leaf_mean_tokens = measured.length ? Math.round(mean('tokens')) : null
  out.leaf_mean_usd = mean('usd')
  out.leaves_measured = measured.length
  return out
}

const dollars = (usd) => '$' + usd.toFixed(2)

/** Pure. The cost report as a person reads it. */
function renderCost(cost) {
  const models = Object.entries(cost.by_model).sort()
    .map(([model, m]) => model + ' ' + m.dispatches + ' (' + dollars(m.usd) + ', ' + m.tokens + ' tokens)').join(', ') || '—'
  return [
    cost.effort + ': ' + cost.dispatches + ' dispatch(es) over ' + cost.executions.length + ' execution(s)',
    'by model: ' + models,
    'spent:    ' + dollars(cost.usd) + ', ' + cost.tokens + ' tokens' +
      (cost.unmeasured ? ' (+ ' + cost.unmeasured + ' dispatch(es) unmeasured)' : ''),
    'per leaf: ' + (cost.leaf_mean_usd === null ? 'no merged leaf fully measured'
      : dollars(cost.leaf_mean_usd) + ', ' + cost.leaf_mean_tokens + ' tokens mean over ' + cost.leaves_measured + ' merged leaf(s)'),
  ].join('\n')
}

// ------------------------------------------------------------------ spend

// A unit is an outlier when it spends more than this multiple of its kind's mean, in dollars or rounds.
export const OUTLIER_MULTIPLE = 2
const SPEND_KINDS = ['leaf', 'folder', 'probe']

/**
 * Pure. Where `thread` sits in `folder`'s design, or null when that design does not own it: its
 * planner and its surveys are `{probe: null}`, a probe round's dispatch `{probe: <round>, sub}`, `sub`
 * the round's own thread (`axes`, `prober:<n>`, `locate…`). A thread may sit under a scope (`x/probe:…`).
 */
export function designPlace(thread, folder) {
  const key = String(thread || '')
  for (const rest of [key, ...[...key.matchAll(/\//g)].map((m) => key.slice(m.index + 1))]) {
    if (rest === 'planner:' + folder || rest.startsWith('survey:' + folder + ':')) return { probe: null, sub: '' }
    if (rest.startsWith('probe:' + folder + ':')) {
      const [round, ...sub] = rest.slice(('probe:' + folder + ':').length).split('/')
      return { probe: round, sub: sub.join('/') }
    }
  }
  return null
}

/** Pure. Whether a call's first read, as measured, held more than a first read may (`BRIEF_TOKENS`). */
const readOver = (call) => typeof call.first_read === 'number' && call.first_read > BRIEF_TOKENS

/**
 * Pure. An effort's calls as units of work: each leaf (its calls, and its rounds the highest round
 * they name), each folder's design (its planner, surveys and probe rounds; its rounds the probe
 * rounds) and each probe round (its probers and whether it derived the axes again), and every call
 * per role and model; each unit counts in `briefs_over` its calls whose first read held more than a
 * first read may. `nodes` is the tree's, `status` its derived status.
 */
export function spendUnits(calls, nodes, status) {
  const leaf = new Map()
  const folder = new Map()
  const probe = new Map()
  const byRole = {}
  const folders = [...nodes.values()].filter((n) => n.kind !== 'leaf').map((n) => n.id)
  for (const call of calls) {
    addCall((byRole[call.role || '?'] ||= {})[call.model || '?'] ||= spend(), call)
    if (nodes.has(call.node) && nodes.get(call.node).kind === 'leaf') {
      const u = leaf.get(call.node) || { id: call.node, status: status.get(call.node).status, ...spend(), rounds: 0, briefs_over: 0 }
      addCall(u, call)
      if (readOver(call)) u.briefs_over += 1
      u.rounds = Math.max(u.rounds, call.round || 0)
      leaf.set(call.node, u)
      continue
    }
    for (const id of folders) {
      const at = designPlace(call.thread, id)
      if (!at) continue
      const f = folder.get(id) || { id, ...spend(), rounds: 0, briefs_over: 0 }
      addCall(f, call)
      if (readOver(call)) f.briefs_over += 1
      folder.set(id, f)
      if (at.probe !== null) {
        const key = id + ':' + at.probe
        const p = probe.get(key) || { id: key, folder: id, round: at.probe, ...spend(), probers: new Set(), axes: false, briefs_over: 0 }
        addCall(p, call)
        if (readOver(call)) p.briefs_over += 1
        if (/^prober:\d+$/.test(at.sub)) p.probers.add(at.sub)
        if (at.sub === 'axes') p.axes = true
        probe.set(key, p)
      }
      break
    }
  }
  for (const p of probe.values()) folder.get(p.folder).rounds += 1
  const probes = [...probe.values()].map((p) => ({ ...p, probers: p.probers.size }))
  return { leaf: [...leaf.values()], folder: [...folder.values()], probe: probes, by_role: byRole }
}

/** Pure. The mean dollars and rounds of a kind's fully measured units; null when none is. */
function meanOf(units) {
  const measured = units.filter((u) => u.unmeasured === 0)
  if (measured.length === 0) return null
  const avg = (field) => measured.reduce((a, u) => a + (u[field] || 0), 0) / measured.length
  return { units: measured.length, usd: avg('usd'), rounds: avg('rounds') }
}

/**
 * Pure. The outliers among `units` (`spendUnits`' kinds, a probe round carrying `spec_lines`), each
 * with its reasons: its dollars or rounds above `OUTLIER_MULTIPLE` × the mean of its kind in this
 * effort or in the `earlier` efforts' units; a probe round with more probers than its folder's spec
 * earns (`probersFor`); a probe round past its folder's first that derived the axes again; a unit
 * with a call whose first read held more than a first read may.
 */
export function flagSpend(units, earlier = { leaf: [], folder: [], probe: [] }) {
  const means = { effort: {}, earlier: {} }
  for (const kind of SPEND_KINDS) {
    means.effort[kind] = meanOf(units[kind])
    means.earlier[kind] = meanOf(earlier[kind] || [])
  }
  const firstRound = new Map()
  for (const p of units.probe) firstRound.set(p.folder, Math.min(firstRound.get(p.folder) ?? Infinity, Number(p.round)))
  const flagged = []
  for (const kind of SPEND_KINDS) {
    for (const u of units[kind]) {
      const reasons = []
      for (const [of, mean] of [['effort', means.effort[kind]], ['earlier', means.earlier[kind]]]) {
        if (!mean) continue
        if (u.unmeasured === 0 && u.usd > OUTLIER_MULTIPLE * mean.usd) reasons.push('usd_over_' + of + '_mean')
        if (kind !== 'probe' && u.rounds > OUTLIER_MULTIPLE * mean.rounds) reasons.push('rounds_over_' + of + '_mean')
      }
      if (kind === 'probe' && u.spec_lines > 0 && u.probers > probersFor(u.spec_lines)) reasons.push('probers_over_size')
      if (kind === 'probe' && u.axes && Number(u.round) > firstRound.get(u.folder)) reasons.push('axes_again')
      if (u.briefs_over > 0) reasons.push('brief_over_bound')
      if (reasons.length) flagged.push({ kind, ...u, reasons })
    }
  }
  return { means, flagged }
}

/** An effort's spend units, each probe round given its folder's spec length as it stands. */
function unitsOfEffort(repo, effort) {
  const tree = readTree(repo, effort)
  const reads = runReads(repo, effort)
  const calls = executionsOf(repo, effort).flatMap((stamp) => callsOf(reads.records(stamp), reads.isLive(stamp)))
  const units = spendUnits(calls, tree.nodes, tree.status)
  const lines = new Map()
  for (const p of units.probe) {
    if (!lines.has(p.folder)) {
      let text = ''
      try { text = readFileSync(specPath(repo, effort, p.folder), 'utf8') } catch { /* a folder with no spec has no length */ }
      lines.set(p.folder, text === '' ? 0 : text.replace(/\r?\n$/, '').split(/\r?\n/).length)
    }
    p.spec_lines = lines.get(p.folder)
  }
  return units
}

/**
 * The spend view (docs/DESIGN.md#self-checks): the effort's units with their dispatches, rounds and
 * dollars, the means of each kind in this effort and in the repository's earlier efforts (each whose
 * first execution started before this one's), the spend per role and model, and the outliers flagged.
 */
/** Docs: lines of neither tests nor source. */
const PROSE = /\.(md|mdx|markdown|rst|txt)$/i

/**
 * Pure. The lines a `git diff --numstat --no-renames` adds, split into test files (`isTestPath`) and
 * source; docs, the effort's store and binary files count as neither. `ratio` is tests per source
 * line, null with no source line: a measurement, and it gates nothing.
 */
export function lineRatio(numstat) {
  let test = 0
  let source = 0
  for (const line of String(numstat || '').split('\n')) {
    const [added, , path] = line.split('\t')
    const n = Number(added)
    if (!path || added === '-' || !Number.isFinite(n)) continue
    const p = posix(path)
    if (isTestPath(p)) test += n
    else if (!PROSE.test(p) && !p.startsWith(AGENTICS_DIR + '/')) source += n
  }
  return { test_lines: test, source_lines: source, ratio: source ? Math.round((test / source) * 100) / 100 : null }
}

/**
 * The effort's diff as `lineRatio` counts it, from where the effort branch was cut to its head: the
 * branch, or once a landing swept it, the effort's side of the landing merge. Null when either end
 * is unknown.
 */
function effortLines(repo, effort) {
  const base = rootBase(repo, effort).base_sha
  const landed = readTree(repo, effort).events.findLast((e) => e.kind === 'landed' && e.node === ROOT_ID)
  const merged = landed && landed.merged_sha ? revParse(repo, landed.merged_sha + '^2') || landed.merged_sha : ''
  const head = revParse(repo, 'refs/heads/' + branchOf(effort, ROOT_ID)) || merged
  if (!base || !head) return null
  const diff = git(repo, ['diff', '--numstat', '--no-renames', base, head])
  return diff.ok ? lineRatio(diff.stdout) : null
}

export function spendOf(repo, effort) {
  const units = unitsOfEffort(repo, effort)
  const first = executionsOf(repo, effort)[0]
  let others = []
  try {
    others = readdirSync(effortsRoot(repo), { withFileTypes: true })
      .filter((e) => e.isDirectory() && safeSlug(e.name) === e.name && e.name !== effort).map((e) => e.name)
  } catch { /* no store, no earlier effort */ }
  const earlierEfforts = first ? others.filter((e) => { const s = executionsOf(repo, e)[0]; return s && s < first }).sort() : []
  const earlier = { leaf: [], folder: [], probe: [] }
  for (const e of earlierEfforts) {
    const theirs = unitsOfEffort(repo, e)
    for (const kind of SPEND_KINDS) earlier[kind].push(...theirs[kind])
  }
  const { means, flagged } = flagSpend(units, earlier)
  return {
    effort, multiple: OUTLIER_MULTIPLE, earlier_efforts: earlierEfforts, means, by_role: units.by_role,
    units: { leaf: units.leaf, folder: units.folder, probe: units.probe }, flagged, lines: effortLines(repo, effort),
  }
}

/** Pure. The spend view as a person reads it: the means, the spend per role, and every flagged unit. */
function renderSpend(view) {
  const NAMES = { leaf: 'leaf', folder: 'folder design', probe: 'probe round' }
  const meansLine = (means) => SPEND_KINDS.map((k) => NAMES[k] + ' ' + (means[k]
    ? dollars(means[k].usd) + (k === 'probe' ? '' : ', ' + means[k].rounds.toFixed(1) + ' rounds') + ' (' + means[k].units + ')'
    : '—')).join(' · ')
  const roles = Object.entries(view.by_role).sort().map(([role, models]) => role + ': ' +
    Object.entries(models).sort().map(([m, s]) => m + ' ' + s.dispatches + ' (' + dollars(s.usd) + ')').join(', ')).join(' · ')
  const total = SPEND_KINDS.reduce((n, k) => n + view.units[k].length, 0)
  const row = (u) => '  ' + u.kind + ' ' + u.id + '  ' + dollars(u.usd) + ' · ' + u.dispatches + ' dispatch(es)' +
    (u.kind === 'probe' ? ' · ' + u.probers + ' prober(s) on ' + u.spec_lines + ' lines' + (u.axes ? ' · axes derived' : '') : ' · ' + u.rounds + ' round(s)') +
    (u.briefs_over ? ' · ' + u.briefs_over + ' first read(s) over ' + BRIEF_TOKENS + ' tokens' : '') +
    ' · ' + u.reasons.join(', ')
  return [
    view.effort + ': spend per unit, an outlier above ' + view.multiple + 'x a mean',
    'mean       ' + meansLine(view.means.effort),
    'earlier    ' + (view.earlier_efforts.length ? view.earlier_efforts.join(', ') + ': ' + meansLine(view.means.earlier) : 'none'),
    'by role    ' + (roles || '—'),
    'lines      ' + (view.lines ? view.lines.test_lines + ' test / ' + view.lines.source_lines + ' source added' +
      (view.lines.ratio === null ? '' : ' (' + view.lines.ratio + 'x)') : 'the diff of the effort could not be read'),
    'flagged    ' + view.flagged.length + ' of ' + total + ' unit(s)',
    ...view.flagged.map(row),
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

/** Pure. A node's `dispatched` events of an execution, oldest first. */
const dispatchesOf = (events, id) => events
  .filter((e) => e.kind === 'dispatched' && e.node === id && typeof e.execution === 'string' && typeof e.dispatch === 'string')
  .sort((a, b) => a.seq - b.seq)

/** The stored return of one dispatch, or null. */
const storedReturn = (repo, effort, d) => {
  const ret = readJson(returnPath(executionDir(repo, effort, d.execution), d.dispatch))
  return ret && typeof ret === 'object' ? ret : null
}

/** The node's spec, and its stored returns on disk, oldest first, once each. */
function filesOf(repo, effort, tree, node, cache) {
  const returns = []
  for (const d of dispatchesOf(tree.events, node.id)) {
    const path = posix(returnPath(executionDir(repo, effort, d.execution), d.dispatch))
    if (!returns.includes(path) && existsSync(path)) returns.push(path)
  }
  return { spec: specFileOf(repo, effort, node, cache), returns }
}

/**
 * The event a person needs explained: why a node is escalated or parked, and, for work agentics
 * did not build, who adopted it and which commits. Null otherwise.
 */
function eventOf(repo, effort, s, events = [], id = '') {
  const last = s.last
  const said = last && typeof last.said === 'string' ? last.said : ''
  if (last && s.status === 'escalated') return { kind: 'escalated', seq: last.seq, reason: last.reason, detail: saidOf(repo, effort, last), said }
  if (last && s.status === 'parked') return { kind: 'parked', seq: last.seq, return: last.return, question: saidOf(repo, effort, last), said }
  if (last && s.status === 'merged' && last.kind === 'merged' && typeof last.by === 'string' && last.by) {
    return { kind: 'merged', seq: last.seq, by: last.by, commits: Array.isArray(last.commits) ? last.commits : [], into: last.into || '', merged_sha: last.merged_sha || '' }
  }
  // A status rolled up from a descendant has no `last`: the node waiting on a person is the one that carries the stop.
  if (s.status === 'escalated' || s.status === 'parked') return null
  const outside = events.filter((e) => e.kind === 'outside' && e.node === id)
  if (outside.length === 0) return null
  const newest = outside.reduce((a, b) => (b.seq > a.seq ? b : a))
  return { kind: 'outside', seq: newest.seq, by: newest.by || '', commits: outside.flatMap((e) => (Array.isArray(e.commits) ? e.commits : [])) }
}

/** Pure. A text's first paragraph of prose, on one line: what its author led with. */
function leadOf(text) {
  const lead = String(text).replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#') && !p.startsWith('```'))
  return lead ? lead.replace(/\s*\n\s*/g, ' ') : ''
}

/** Pure. The words a stored return carries: its `text`, else its `notes`. */
const returnText = (ret) => [ret.text, ret.notes].find((s) => typeof s === 'string' && s.trim()) || ''

/** The latest of a node's returns that carries text, as `{dispatch, lead}`; null when none does. */
function reportOf(repo, effort, events, id) {
  for (const d of dispatchesOf(events, id).reverse()) {
    const ret = storedReturn(repo, effort, d)
    const text = ret ? returnText(ret) : ''
    if (text) return { dispatch: d.dispatch, lead: leadOf(text) }
  }
  return null
}

/**
 * The running dispatch's activity on node `id` (docs/DESIGN.md#live-activity): the live file of the
 * node's latest dispatch, while that execution's run is live (`isLive(stamp)`); null otherwise.
 */
function liveIn(repo, effort, events, id, isLive) {
  const last = dispatchesOf(events, id).pop()
  if (!last || !isLive(last.execution)) return null
  const live = readJson(livePath(executionDir(repo, effort, last.execution), last.dispatch))
  return live && typeof live === 'object' ? { dispatch: last.dispatch, turns: live.turns, tool: live.tool, at: live.at } : null
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
 * The latest `checkout_changed` record of each node, `{dispatch, paths, seq}`: a call that wrote
 * into the user's checkout outside its own paths, put to the node its `dispatched` names.
 */
function checkoutsOf(repo, effort, reads) {
  const out = new Map()
  for (const stamp of executionsOf(repo, effort)) {
    const nodeByDispatch = new Map()
    for (const e of reads.records(stamp)) {
      if (e.kind === 'dispatched' && typeof e.dispatch === 'string') nodeByDispatch.set(e.dispatch, e.node)
      if (e.kind !== 'checkout_changed' || !nodeByDispatch.has(e.dispatch)) continue
      const node = nodeByDispatch.get(e.dispatch)
      if (!out.has(node) || out.get(node).seq < e.seq) out.set(node, { dispatch: e.dispatch, paths: e.paths, seq: e.seq })
    }
  }
  return out
}

/**
 * What the cards of `ids` share: the open executions, the resume ladder's row for each unfinished
 * leaf among them (asked of git once for all of them), the dispatches waiting out a host stop,
 * each node's latest checkout change, and whether each execution's run is live.
 */
function cardGround(repo, effort, tree, ids, reads) {
  const open = executionsOf(repo, effort).map((stamp) => executionSummary(repo, effort, stamp)).filter((x) => !x.closed)
  const unfinished = new Set(ids.filter((id) => tree.nodes.get(id).kind === 'leaf' && !DONE_STATUSES.has(tree.status.get(id).status)))
  const asked = [...tree.nodes.values()].filter((n) => n.kind !== 'leaf' || unfinished.has(n.id))
  const latest = open.length ? open[open.length - 1].stamp : ''
  const rows = unfinished.size ? resumeLeaves(repo, effort, latest, asked) : []
  return {
    open, unfinished, rows: new Map(rows.map((r) => [r.id, r])), waiting: hostWaits(repo, effort, reads),
    checkouts: checkoutsOf(repo, effort, reads), isLive: reads.isLive,
  }
}

/**
 * A node's card: what a session needs to move it on, beyond its status and its stop. The next
 * action is the resume ladder's, so the card and a relaunch cannot disagree.
 */
function cardOf(repo, main, effort, tree, ground, id) {
  const status = tree.status.get(id)
  const row = ground.rows.get(id)
  const held = ground.open.filter((x) => x.root === ROOT_ID || x.root === id || id.startsWith(x.root + '/')).pop()
  const checkout = ground.checkouts.get(id)
  return {
    next: row ? { action: row.next_action, why: row.note } : null,
    behind: ground.unfinished.has(id) ? behindOf(main, effort, tree.nodes, id) : null,
    report: reportOf(repo, effort, tree.events, id),
    notes: tree.events.filter((e) => e.kind === 'noted' && e.node === id).sort((a, b) => b.seq - a.seq)
      .map((e) => ({ seq: e.seq, by: e.by, text: e.text })),
    relaunch: held
      ? { execution: held.stamp, root: held.root, retry: status.status === 'escalated' && status.last ? [id] : [] }
      : null,
    checkout_changed: checkout ? { dispatch: checkout.dispatch, paths: checkout.paths } : null,
  }
}

/** The snapshot's entries for `ids`, in that order. */
function nodeEntries(repo, effort, tree, ids, specCache, reads) {
  const main = mainCheckout(repo)
  const ground = cardGround(repo, effort, tree, ids, reads)
  return ids.map((id) => {
    const n = tree.nodes.get(id)
    const s = tree.status.get(id)
    const todo = todoFor(tree.nodes, tree.status, tree.events, id, { waiting: ground.waiting })
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
      expects: n.expects,
      deps: n.deps,
      acceptance: n.acceptance,
      status: s.status,
      event: eventOf(repo, effort, s, tree.events, id),
      stage: todo.status === 'in_progress' ? todo.activeForm : null,
      branch: branchOf(effort, id),
      worktree: existsSync(wt) ? wt : null,
      commits: commitsOf(main, effort, tree.nodes, n, s.status),
      live: liveIn(repo, effort, tree.events, id, ground.isLive),
      files: filesOf(repo, effort, tree, n, specCache),
      card: cardOf(repo, main, effort, tree, ground, id),
    }
  })
}

/**
 * A composite's integration review as an entry of its own, beside the composite's children: the
 * review's state for its status, and its latest reviewer's stored return (the dispatch its latest
 * `claims` names). Null while the composite's children have not all merged.
 */
function reviewEntryOf(repo, effort, tree, folder) {
  const todo = reviewTodoFor(tree.status, folder.id, unsettledCounts(tree.nodes, tree.events).get(folder.id) || 0)
  if (!todo) return null
  const claims = claimsEventOf(tree.events, folder.id)
  const named = claims && typeof claims.said === 'string' && claims.said && typeof claims.execution === 'string'
  const path = named ? posix(returnPath(executionDir(repo, effort, claims.execution), claims.said)) : ''
  const ret = named ? storedReturn(repo, effort, { execution: claims.execution, dispatch: claims.said }) : null
  const text = ret ? returnText(ret) : ''
  return {
    id: todo.key, label: 'integration review', parent: folder.id, kind: 'review', author: '',
    title: 'Integration review of ' + folder.title, intent: '', context: '', rigor: '', role: '',
    expects: [], deps: [], acceptance: [],
    status: todo.node_status, event: null, stage: todo.status === 'in_progress' ? todo.activeForm : null,
    branch: folder.branch, worktree: folder.worktree, commits: null, live: null,
    files: { spec: folder.files.spec, returns: ret ? [path] : [] },
    card: { next: null, behind: null, report: text ? { dispatch: claims.said, lead: leadOf(text) } : null, notes: [], relaunch: null, checkout_changed: null },
  }
}

/** One node as the snapshot holds it: what a session starting on that node reads first. */
export function nodeOf(repo, effort, id) {
  const tree = readTree(repo, effort)
  if (!tree.nodes.has(id)) throw new Error('no live node ' + JSON.stringify(id) + ' in ' + effort)
  return nodeEntries(repo, effort, tree, [id], new Map(), runReads(repo, effort))[0]
}

/** Pure. A node's entry as a person reads it, ending with how to relaunch it. */
export function renderNode(n) {
  const lines = [n.id + ' — ' + n.title, 'status: ' + n.status + (n.stage ? ', ' + n.stage : '')]
  if (n.live) {
    const tool = n.live.tool || {}
    lines.push('live: ' + n.live.dispatch + ', ' + n.live.turns + ' turn(s), last ' + [tool.name, tool.target].filter(Boolean).join(' ') + ' at ' + n.live.at)
  }
  if (n.event && (n.event.kind === 'merged' || n.event.kind === 'outside')) {
    lines.push((n.event.kind === 'merged' ? 'merged, adopted by ' : 'commits outside any leaf, adopted by ') + n.event.by + ', seq ' + n.event.seq + ':',
      ...n.event.commits.map((c) => '  ' + c))
  } else if (n.event) {
    const text = n.event.kind === 'parked' ? n.event.question : n.event.detail
    lines.push(n.event.kind + ' (' + (n.event.kind === 'parked' ? n.event.return : n.event.reason) + '), seq ' + n.event.seq + ':',
      ...String(text || '').split('\n').map((l) => '  ' + l))
  }
  const c = n.card
  if (c.next) lines.push('next: ' + c.next.action + ' — ' + c.next.why)
  if (c.behind) lines.push('behind: ' + n.branch + ' lacks ' + c.behind + ' commit' + (c.behind === 1 ? '' : 's') + ' of its folder\'s branch')
  if (c.report) lines.push('report (' + c.report.dispatch + '): ' + c.report.lead)
  if (c.checkout_changed) lines.push('checkout changed by ' + c.checkout_changed.dispatch + ': ' + c.checkout_changed.paths.join(', '))
  if (c.notes.length) lines.push('notes, newest first:', ...c.notes.map((x) => '  #' + x.seq + ' ' + x.by + ': ' + x.text))
  if (n.files.spec.path) lines.push('spec: ' + n.files.spec.path + (n.files.spec.line !== null ? ':' + n.files.spec.line : ''))
  lines.push(c.relaunch
    ? 'relaunch: execution ' + c.relaunch.execution + ', root ' + c.relaunch.root +
      (c.relaunch.retry.length ? ', retry ' + JSON.stringify(c.relaunch.retry) : '')
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
 * The viewer's whole read of one effort in a single call: format 4 of the Snapshot contract
 * (docs/DESIGN.md#snapshot). Read-only — it writes no file, no
 * lock and no `seq` — and reads through the main checkout even when `repo` is a linked worktree, so
 * a snapshot taken from either place agrees.
 */
export function snapshotOf(repo, effort) {
  const tree = readTree(repo, effort)
  const identity = readJson(join(effortStateDir(repo, effort), 'effort.json')) || {}
  const specCache = new Map()
  const reads = runReads(repo, effort)

  const folders = foldersOf(repo, effort).map((f) => folderOf(repo, effort, f.id, specCache))

  const reached = subtreeOf(tree.nodes, ROOT_ID)
  const reachedSet = new Set(reached)
  const unreached = [...tree.nodes.keys()].filter((id) => !reachedSet.has(id)).sort()

  const byId = new Map(nodeEntries(repo, effort, tree, [...reached, ...unreached], specCache, reads).map((e) => [e.id, e]))
  const nodes = []
  const walk = (id) => {
    nodes.push(byId.get(id))
    for (const c of childrenOf(tree.nodes, id)) walk(c)
    const review = reviewEntryOf(repo, effort, tree, byId.get(id))
    if (review) nodes.push(review)
  }
  if (reached.length) walk(ROOT_ID)
  for (const id of unreached) nodes.push(byId.get(id))

  const c = costOf(repo, effort, reads)
  const sum = (s) => ({ dispatches: s.dispatches, tokens: s.tokens, usd: s.usd, unmeasured: s.unmeasured })
  const each = (byKey) => Object.fromEntries(Object.entries(byKey).map(([k, s]) => [k, sum(s)]))
  const cost = { ...sum(c), by_model: each(c.by_model), per_leaf: each(c.per_leaf), per_folder: each(c.per_folder) }

  return {
    format: 4,
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

/** The flags this CLI takes, each by its kind: a skill's session passes handles only (`handleArgs`). */
const FLAGS = {
  '--repo': 'path', '--effort': 'handle', '--root': 'handle', '--execution': 'handle', '--run': 'handle',
  '--since': 'handle', '--node': 'handle', '--json': 'switch',
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const argv = process.argv.slice(2)
    const bad = handleArgs(argv, FLAGS, { from: 1 })
    if (bad) {
      console.log(JSON.stringify({ error: bad.message, kind: bad.kind }))
      process.exit(1)
    }
    const [command] = argv
    const repo = flagOf(argv, 'repo') || '.'
    const effort = flagOf(argv, 'effort')
    const json = argv.includes('--json')
    const needEffort = () => {
      if (!safeSlug(effort)) throw new Error('--effort must name an effort, not ' + JSON.stringify(effort))
    }
    // A watch starts from the seq its caller read before launching, so nothing lands unseen in between.
    const sinceOf = () => {
      if (!argv.includes('--since')) return null
      const raw = flagOf(argv, 'since')
      const n = /^\d+$/.test(raw) ? Number(raw) : NaN
      if (!Number.isSafeInteger(n)) {
        throw new Error('--since must be a non-negative integer no larger than ' + Number.MAX_SAFE_INTEGER + ', not ' + JSON.stringify(raw))
      }
      return n
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
      if (!argv.includes('--run')) throw new Error('watch needs --run <run>: an execution\'s run is <effort>.<stamp>')
      watchRun(repo, flagOf(argv, 'run'), sinceOf())
    } else if (command === 'cost') {
      needEffort()
      print(costOf(repo, effort), renderCost)
    } else if (command === 'spend') {
      needEffort()
      print(spendOf(repo, effort), renderSpend)
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
      throw new Error('unknown command ' + JSON.stringify(command || '') + ' — expected list, show, todos, checkpoint, watch, cost, spend, node or snapshot')
    }
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
