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
// model, the effort and, where the host reports it, the tokens. Summing them is how the next triage
// quotes a measured figure instead of a guess; a dispatch the host reported no tokens for is
// counted as unreported rather than as zero, because a zero would read as "free".
//
// Why the snapshot. The agentics viewer (a separate, read-only renderer) draws one effort from a
// single call rather than five, and needs the same facts a person would piece together from `show`,
// `todos` and `cost` plus a folder's approval and a leaf's git history. `snapshotOf` is that one
// call: read-only, so it writes no file, no lock and no `seq`. Its folder walk is a private copy of
// `next.mjs`'s `foldersOf` shape, not an import of it — `next.mjs` already imports this file, and
// `approval.mjs` and `spec.mjs` (imported below) import neither `status.mjs` nor `next.mjs`, so this
// file importing them is not a cycle; only importing `next.mjs` back into this file would be.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { approvalState } from './approval.mjs'
import { executionsOf } from './effort.mjs'
import { readLog, seqMax } from './ledger.mjs'
import { parseSpec } from './spec.mjs'
import {
  AGENTICS_DIR, ROOT_ID, agenticsRoot, branchOf, briefPath, effortsRoot, effortStateDir, envelope,
  executionDir, flagOf, folderDir, git, mainCheckout, parentOf, posix, readJson, reportPath, revParse,
  safeSlug, specPath, worktreeOf,
} from './store.mjs'
import { cycleOf, readTree, renderTree, subtreeOf } from './tree.mjs'

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

const isTokens = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * The cost report: every `dispatch` line across the effort's executions, counted per model and
 * per role, with tokens summed where the host reported them and counted as unreported where it
 * did not. `per_leaf` is each leaf's own spend; `leaf_mean_tokens` averages the merged leaves whose
 * every dispatch reported tokens — the measured cost-per-leaf a scheduler or a triage quotes — and
 * is null when no leaf qualifies, never 0.
 */
export function costOf(repo, effort) {
  const tree = readTree(repo, effort)
  const stamps = executionsOf(repo, effort)
  const out = {
    effort, executions: stamps, dispatches: 0, by_model: {}, by_role: {},
    tokens: 0, tokens_unreported: 0, per_leaf: {}, leaf_mean_tokens: null,
  }

  for (const stamp of stamps) {
    for (const d of readLog(repo, effort, 'state:' + stamp).entries) {
      if (d.kind !== 'dispatch') continue
      out.dispatches++
      const model = typeof d.model === 'string' && d.model ? d.model : 'unknown'
      const role = typeof d.role === 'string' && d.role ? d.role : 'unknown'
      out.by_model[model] = (out.by_model[model] || 0) + 1
      out.by_role[role] = (out.by_role[role] || 0) + 1
      const reported = isTokens(d.tokens)
      if (reported) out.tokens += d.tokens
      else out.tokens_unreported++

      const node = tree.nodes.get(d.node)
      if (node && node.kind === 'leaf') {
        const leaf = out.per_leaf[d.node] ||= {
          dispatches: 0, tokens: 0, tokens_unreported: 0, status: tree.status.get(d.node).status,
        }
        leaf.dispatches++
        if (reported) leaf.tokens += d.tokens
        else leaf.tokens_unreported++
      }
    }
  }

  const measured = Object.values(out.per_leaf).filter((l) => l.status === 'merged' && l.tokens_unreported === 0)
  if (measured.length) out.leaf_mean_tokens = Math.round(measured.reduce((a, l) => a + l.tokens, 0) / measured.length)
  out.leaves_measured = measured.length
  return out
}

/** Pure. The cost report as a person reads it. */
function renderCost(cost) {
  const pairs = (o) => Object.entries(o).sort().map(([k, v]) => k + ' ' + v).join(', ') || '—'
  return [
    cost.effort + ': ' + cost.dispatches + ' dispatch(es) over ' + cost.executions.length + ' execution(s)',
    'by model: ' + pairs(cost.by_model),
    'by role:  ' + pairs(cost.by_role),
    'tokens:   ' + cost.tokens + (cost.tokens_unreported ? ' (+ ' + cost.tokens_unreported + ' dispatch(es) unreported)' : ''),
    'per leaf: ' + (cost.leaf_mean_tokens === null ? 'no merged leaf fully measured'
      : cost.leaf_mean_tokens + ' tokens mean over ' + cost.leaves_measured + ' merged leaf(s)'),
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

/**
 * The root folder and every folder below it that holds a spec, depth-first — the same shape as
 * `next.mjs`'s private `foldersOf`, kept local here because importing that file back would cycle
 * (`next.mjs` imports this one).
 */
function folderIdsOf(repo, effort) {
  const out = []
  const walk = (id) => {
    if (id === ROOT_ID || existsSync(specPath(repo, effort, id))) out.push(id)
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
 * A leaf's spec line is the line of its parent spec's plan entry named after it; a composite or
 * design node links its own folder's spec, at no particular line.
 */
function specFileOf(repo, effort, node, cache) {
  if (node.kind !== 'leaf') return { path: posix(specPath(repo, effort, node.id)), line: null }
  const parent = parentOf(node.id)
  const spec = readSpecCached(repo, effort, parent, cache)
  const name = node.id.slice(node.id.lastIndexOf('/') + 1)
  const entry = spec ? spec.entries.find((e) => e.name === name) : null
  return { path: posix(specPath(repo, effort, parent)), line: entry ? entry.line : null }
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
  if (s.status === 'escalated') return { kind: 'escalated', seq: s.last.seq, reason: s.last.reason, detail: s.last.detail }
  if (s.status === 'parked') return { kind: 'parked', seq: s.last.seq, return: s.last.return, question: s.last.question }
  return null
}

/**
 * A leaf's commit count and last commit on its own branch, over its parent's: null when either
 * branch does not exist, and never attempted for a leaf that is not `active` or for anything that
 * is not a leaf — a git call each other node would never use.
 */
function commitsOf(main, effort, node, status) {
  if (node.kind !== 'leaf' || status !== 'active') return null
  const parentBranch = branchOf(effort, parentOf(node.id))
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
 * The viewer's whole read of one effort in a single call: format 1 of the Snapshot contract
 * (agentics-viewer/shared/interfaces.md § Snapshot contract). Read-only — it writes no file, no
 * lock and no `seq` — and reads through the main checkout even when `repo` is a linked worktree, so
 * a snapshot taken from either place agrees.
 */
export function snapshotOf(repo, effort) {
  const main = mainCheckout(repo)
  const tree = readTree(repo, effort)
  const identity = readJson(join(effortStateDir(repo, effort), 'effort.json')) || {}
  const specCache = new Map()

  const folders = folderIdsOf(repo, effort).map((id) => folderOf(repo, effort, id, specCache))

  const reached = subtreeOf(tree.nodes, ROOT_ID)
  const reachedSet = new Set(reached)
  const order = [...reached, ...[...tree.nodes.keys()].filter((id) => !reachedSet.has(id)).sort()]

  const nodes = order.map((id) => {
    const n = tree.nodes.get(id)
    const s = tree.status.get(id)
    const todo = todoFor(tree.nodes, tree.status, tree.events, id)
    const wt = worktreeOf(main, effort, id)
    return {
      id: n.id,
      parent: parentOf(id),
      kind: n.kind,
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
      commits: commitsOf(main, effort, n, s.status),
      files: filesOf(repo, effort, tree, n, specCache),
    }
  })

  const c = costOf(repo, effort)
  const cost = {
    dispatches: c.dispatches,
    tokens: c.tokens,
    tokens_unreported: c.tokens_unreported,
    per_leaf: Object.fromEntries(Object.entries(c.per_leaf).map(([id, l]) =>
      [id, { dispatches: l.dispatches, tokens: l.tokens, tokens_unreported: l.tokens_unreported }])),
  }

  return {
    format: 1,
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
    } else if (command === 'cost') {
      needEffort()
      print(costOf(repo, effort), renderCost)
    } else if (command === 'snapshot') {
      needEffort()
      print(snapshotOf(repo, effort), () => {
        const tree = readTree(repo, effort)
        return renderTree(tree.nodes, tree.status) || '(no nodes)'
      })
    } else {
      throw new Error('unknown command ' + JSON.stringify(command || '') + ' — expected list, show, todos, cost or snapshot')
    }
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
