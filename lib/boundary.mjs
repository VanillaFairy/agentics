// lib/boundary.mjs — the boundaries of an execution, plus landing: every deterministic step an
// execution takes, scheduling included, fused per boundary into one entry point run by one courier.
//
// Design: docs/DESIGN.md#boundaries.
//
// Why fused. A workflow script has no filesystem, so every step that touches disk is a courier
// dispatch, and every courier is a round trip on the critical path. The count of BOUNDARIES, not
// of facts, sets the floor — so each boundary does everything that happens there in one process:
// leaf-open takes the slot and the locus locks, cuts the branches, attaches the worktree, writes
// the brief and appends `dispatched`; leaf-close commits a shell-less author's files, measures,
// journals, writes gotchas and decides what comes next.
//
// Why idempotent. A courier can die after the program finished and before anyone saw the output.
// So each step first asks whether its effect already exists — a merge already in the branch, a
// record already in the log, a worktree already attached — and a re-run converges on the same
// state. That is what licenses re-dispatching a boundary whose outcome was not observed.
//
// Why detached. A host's shell call has a time limit and a build plus a suite can outlast it. So
// leaf-close and merge-batch run their work in a detached child keyed by their arguments and poll
// it; a poll that reaches the limit returns `pending`, and the workflow re-dispatches the same
// boundary, which finds the same job and keeps polling. The shell limit can end a courier, never
// the work.
//
// What it never does: decide a verdict it did not compute from observations, touch the user's
// branch (except `land`, which only the session runs, on the user's go), or repair a record.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { approvalGate, recordDisposition, recordPreparation, recordReviewed } from './approval.mjs'
import { assembleBrief } from './brief.mjs'
import { compileEffort } from './compile.mjs'
import { commandsOf, deleteGotcha, extractReportBlocks, writeGotcha } from './gotchas.mjs'
import {
  attach, changedFiles, contains, effortBase, ensureIntegration, ensureLeaf, mergeUnits, readText,
  resetTo, worktrees,
} from './integration.mjs'
import { acquire, holderReader, maxParallel, releaseLocus, releaseSlots, withBranchLock } from './locks.mjs'
import { append, readLog } from './ledger.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import { renderLanding } from './render.mjs'
import { approvedHead, resumeLeaves } from './resume.mjs'
import { schedule, summarize } from './schedule.mjs'
import { checkFolder } from './spec.mjs'
import { todoFor } from './status.mjs'
import {
  ROOT_ID, STAMP, AGENTICS_DIR, ancestorsOf, branchExists, branchOf, briefPath, closePath, decodeArgs, envelope, executionDir, executionsRoot,
  fixesPath, flagOf, gatePath, mergePath, saidDir, saidOf, stalePath, git, isAncestorOrSelf, nodeBranchGlob, posix, readJson, reportPath, revParse, safeSlug,
  sleepMs, specPath, worktreeOf, writeJson, mkdirState,
} from './store.mjs'
import { trace } from './traceability.mjs'
import { collectUsage } from './usage.mjs'
import {
  childrenOf, claimsOf, cycleOf, executorRole, isHuman, ownReview, ownerOf, readTree, subtreeOf,
} from './tree.mjs'
import { closeDecision, measurementOk, suiteFailed } from './verdict.mjs'
import { verify, worktreeProblem } from './verify.mjs'

const SELF = fileURLToPath(import.meta.url)

/** How long one boundary call polls a detached job before answering `pending`. */
// Under the courier's own shell-call limit (its prompt asks for 600 s): a job still running, or
// queued behind the project's test lock, answers `pending` and the workflow re-dispatches, which is
// safe because the same arguments find the same job. Each re-dispatch is a courier, so the wait is
// as long as that limit allows.
const pollLimit = () => Number.parseInt(process.env.AGENTICS_BOUNDARY_WAIT_MS || '', 10) || 540 * 1000

// ------------------------------------------------------------------ context

function contextOf(repo, effort, execution) {
  if (!safeSlug(effort)) throw new Error('not an effort name: ' + JSON.stringify(effort))
  if (!STAMP.test(execution || '')) throw new Error('not an execution stamp: ' + JSON.stringify(execution))
  const dir = executionDir(repo, effort, execution)
  return { repo: posix(repo), effort, execution, dir, envelopePath: join(dir, 'execution.json') }
}

const readEnvelope = (ctx) => readJson(ctx.envelopePath)

const fail = (boundary, kind, message, extra = {}) =>
  ({ boundary, ok: false, error: { kind, message }, todos: [], notes: [], ...extra })

// ------------------------------------------------------------------ records

/**
 * What makes two appends one record: the id the workflow gave it, or, for a record the lib writes
 * itself (a merge-batch run again), its content.
 */
const recordKey = (file, e) => (e.rid ? 'rid:' + e.rid : [file, e.kind, e.node || '', e.execution || '', e.head_sha || ''].join('|'))

/**
 * Pure. Which of `records` are not on disk yet, split by file: a record sent again after a lost
 * courier lands once, and a decision taken again (an approval after a retry) is a new record with
 * a new id. Events carry the execution's stamp.
 */
export function recordsToAppend(records, { events = [], state = [], execution }) {
  const seen = new Set([...events.map((e) => recordKey('events', e)), ...state.map((e) => recordKey('state', e))])
  const out = { events: [], state: [] }
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r.entry !== 'object' || !r.entry.kind) continue
    const file = r.file === 'state' ? 'state' : 'events'
    const entry = { ...(file === 'events' ? { execution } : {}), ...r.entry, ...(r.rid ? { rid: r.rid } : {}) }
    const key = recordKey(file, entry)
    if (seen.has(key)) continue
    seen.add(key)
    out[file].push(entry)
  }
  return out
}

/** Append the workflow's decisions (approvals, escalations, parks, integration verdicts, dispatch cost lines), each once. */
function appendRecords(ctx, records) {
  const list = Array.isArray(records) ? records : []
  if (list.length === 0) return { written: 0, skipped: 0 }
  const { events, state } = recordsToAppend(list, {
    events: readLog(ctx.repo, ctx.effort, 'events').entries,
    state: readLog(ctx.repo, ctx.effort, 'state:' + ctx.execution).entries,
    execution: ctx.execution,
  })
  if (events.length) {
    const r = append(ctx.repo, ctx.effort, 'events', events)
    if (!r.ok) throw new Error('events refused: ' + r.error)
  }
  if (state.length) {
    const r = append(ctx.repo, ctx.effort, 'state:' + ctx.execution, state)
    if (!r.ok) throw new Error('state refused: ' + r.error)
  }
  return { written: events.length + state.length, skipped: list.length - events.length - state.length }
}

// ------------------------------------------------------------------ todos

/**
 * Todo moves for the named nodes, from derived status; `override` sets one node's stage. A move
 * names no task id: the courier finds the node's todo by its subject, or creates it.
 */
function todos(ctx, args, ids, override = {}) {
  if (args.progress === false) return []
  const tree = readTree(ctx.repo, ctx.effort)
  const env = readEnvelope(ctx) || {}
  const out = []
  for (const id of new Set(ids)) {
    if (!tree.nodes.has(id)) continue
    const item = { ...todoFor(tree.nodes, tree.status, tree.events, id, { executionRootId: env.root || ROOT_ID }), ...(override[id] || {}) }
    out.push({ key: item.key, subject: item.subject, activeForm: item.activeForm, status: item.status })
  }
  return out
}

// ------------------------------------------------------------------ rows

function integrationOf(ctx, tree, node) {
  // A group has no branch: its work integrates in its folder's.
  const id = (tree.nodes.get(node) || {}).kind === 'group' ? ownerOf(tree.nodes, node) : node
  const branch = branchOf(ctx.effort, id)
  if (!branchExists(ctx.repo, branch)) return null
  const head = revParse(ctx.repo, 'refs/heads/' + branch)
  let base = ''
  if (id === ROOT_ID) base = effortBase(ctx.repo, ctx.effort).base_sha
  else {
    const mb = git(ctx.repo, ['merge-base', branch, branchOf(ctx.effort, ownerOf(tree.nodes, id))])
    base = mb.ok ? mb.stdout.trim() : ''
  }
  return { branch, worktree: worktreeOf(ctx.repo, ctx.effort, id), head, base }
}

const isGroupIn = (tree) => (id) => (tree.nodes.get(id) || {}).kind === 'group'

/** A node as a unit the workflow runs needs it for its prompts and its tiers, and nothing more. */
function rowOf(ctx, tree, id) {
  const n = tree.nodes.get(id)
  return {
    id, title: n.title, kind: n.kind, author: n.author, rigor: n.rigor, role: n.role,
    provides_n: n.provides.length, decisions: n.decisions, dispatch: n.dispatch, ground_known: n.ground_known,
    rev: n.seq || 0,
    spec_path: posix(specPath(ctx.repo, ctx.effort, id)),
    children_n: childrenOf(tree.nodes, id).length,
    own_review: n.kind === 'leaf' && ownReview(n),
  }
}

/** What a leaf waits on: its dependencies and every ancestor's, which the workflow re-checks a launch against. */
const waitsOn = (tree, id) => [...new Set([id, ...ancestorsOf(id)].flatMap((a) => (tree.nodes.get(a) || { deps: [] }).deps))]

/** A leaf's folder, as far as a verify leaf's finding needs it to replan that folder. */
function parentRowOf(ctx, tree, id) {
  const owner = ownerOf(tree.nodes, id)
  const { title, kind, author, spec_path } = rowOf(ctx, tree, owner)
  return { id: owner, title, kind, author, spec_path }
}

/**
 * Whether work already stands on the node as planned: a leaf approved and waiting for its merge,
 * or a folder with children dispatched or merged. Replanning it would pull the plan from under
 * that work.
 */
const underWay = (tree, id) =>
  (tree.status.get(id) || {}).status === (tree.nodes.get(id).kind === 'leaf' ? 'approved' : 'active')

/**
 * What a ruler rules on, one block per node: the node as its executor will be briefed, and the
 * change that may have moved its premise. The ruler has no search tools, so this file is all of
 * its evidence.
 * @param {{node: string, note: string, diff: string}[]} items
 */
function rulingBrief(tree, items) {
  const list = (xs) => (xs.length ? xs.map((x) => '- ' + x).join('\n') : '(none)')
  return items.map(({ node: id, note, diff }) => {
    const n = tree.nodes.get(id)
    return [
      '# ' + id + ' — ' + n.title, '', note, '',
      '## Plan entry', '',
      'Intent: ' + ((n.intent || '').trim() || '(none)'), '',
      'Context: ' + ((n.context || '').trim() || '(none)'), '',
      'Acceptance criteria:', list((n.acceptance || []).map((a) => a.text + (a.check ? ' — check: `' + a.check + '`' : ''))), '',
      'Writes:', list(n.locus || []), '',
      'Reads:', list(n.reads || []), '',
      'Consumes:', list((n.consumes || []).map((c) => c.name + ': ' + c.paths.join(', '))), '',
      '## Change', '',
      '~~~~diff', diff.trimEnd(), '~~~~', '',
    ].join('\n')
  }).join('\n')
}

// ------------------------------------------------------------------ preflight

/** Executions of this effort that never closed, other than this one. */
function openExecutions(ctx) {
  const dir = executionsRoot(ctx.repo, ctx.effort)
  if (!existsSync(dir)) return []
  const out = []
  for (const stamp of readdirSafe(dir)) {
    if (stamp === ctx.execution || !STAMP.test(stamp)) continue
    const env = readJson(join(dir, stamp, 'execution.json'))
    if (!env) continue
    const closed = readLog(ctx.repo, ctx.effort, 'state:' + stamp).entries.some((e) => e.kind === 'closed')
    if (!closed) out.push({ stamp, root: env.root || ROOT_ID })
  }
  return out
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Clear the named nodes' stops: a `replanned` event, reason `retry_escalated`, newer than each
 * stop. A running execution's next schedule sees the node ready again and relaunches it.
 */
function retryEscalated(ctx, tree, ids) {
  const retry = (Array.isArray(ids) ? ids : []).filter((id) => tree.nodes.has(id))
  if (retry.length === 0) return { retried: [], error: null }
  const r = append(ctx.repo, ctx.effort, 'events', retry.map((id) => ({ kind: 'replanned', node: id, execution: ctx.execution, reason: 'retry_escalated', by: 'session' })))
  return { retried: r.ok ? retry : [], error: r.ok ? null : r.error }
}

/**
 * Record what the session learned about a node: a `noted` event. It is an observation, so its
 * actor records it; it is not a status, and no status is derived from it.
 */
function noteNode(ctx, tree, id, text) {
  if (!tree.nodes.has(id)) return { noted: '', error: 'no live node ' + JSON.stringify(id) }
  const said = String(text || '').trim()
  if (!said) return { noted: '', error: '--text must say what was learned' }
  const r = append(ctx.repo, ctx.effort, 'events', [{ kind: 'noted', node: id, execution: ctx.execution, by: 'session', text: said }])
  return { noted: r.ok ? id : '', error: r.ok ? null : r.error }
}

/**
 * Record what the execution's agents have spent so far. It runs where an invocation starts and
 * where it ends, so a run that died is picked up by the next; a failure is a note, never the
 * boundary's.
 */
function usageNotes(ctx) {
  try {
    collectUsage(ctx.repo, ctx.effort, ctx.execution)
    return []
  } catch (err) {
    return ['usage was not collected: ' + err.message]
  }
}

export function preflight(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  if (tree.error) return fail('preflight', 'unreadable', tree.error)
  const root = typeof args.root === 'string' && args.root ? args.root : ROOT_ID
  if (!tree.nodes.has(root)) return fail('preflight', 'no_such_node', 'node ' + root + ' is not in effort ' + ctx.effort)
  if (root === ROOT_ID && tree.nodes.get(root).kind === 'leaf') {
    return fail('preflight', 'root_is_leaf', 'the effort root must be a composite or design node')
  }
  const notes = []

  let env = readEnvelope(ctx)
  const resumed = Boolean(env)
  if (!env) {
    const ref = args.base_ref || ''
    const base_branch = ref || git(ctx.repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
    const base_sha = revParse(ctx.repo, ref || 'HEAD')
    if (!base_sha) return fail('preflight', 'no_base', 'could not resolve ' + (ref || 'HEAD') + ' in ' + ctx.repo)
    env = {
      stamp: ctx.execution, root, base_branch, base_sha, dial: args.dial || 'normal', pace: args.pace || 'balanced',
      commands: args.commands || null,
    }
    mkdirState(ctx.dir)
    writeFileSync(ctx.envelopePath, JSON.stringify(env, null, 1) + '\n')
  } else if (env.root !== root) {
    return fail('preflight', 'wrong_root', 'execution ' + ctx.execution + ' runs ' + env.root + ', not ' + root)
  }

  // Each invocation of an execution numbers its records by this, so an id it mints is its own.
  append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'invocation' })
  const invocation = readLog(ctx.repo, ctx.effort, 'state:' + ctx.execution).entries.filter((e) => e.kind === 'invocation').length

  let checkpoint = null
  const stale = []
  let staleOut = null
  const dirty = []
  const overlapping = openExecutions(ctx).filter((e) => isAncestorOrSelf(e.root, root) || isAncestorOrSelf(root, e.root))
  if (overlapping.length && !args.confirmed_duplicate) {
    checkpoint = { reason: 'existing_execution', detail: overlapping.map((e) => e.stamp + ' (root ' + e.root + ')').join(', '), executions: overlapping }
  }

  notes.push(...usageNotes(ctx))
  const retried = retryEscalated(ctx, tree, args.retry_escalated)
  if (retried.error) notes.push('retry_escalated could not be recorded: ' + retried.error)

  if (resumed && !checkpoint) {
    const now = revParse(ctx.repo, env.base_branch || 'HEAD')
    if (now && env.base_sha) {
      // What this execution's branch already holds of the base: its root's integration branch, or
      // the nearest one above it that the root will be cut from. A head merged into it is the
      // ground its leaves are cut from, not a move under them.
      const ground = [root, ...ancestorsOf(root)].map((id) => branchOf(ctx.effort, id)).find((b) => branchExists(ctx.repo, b))
      const fork = ground ? git(ctx.repo, ['merge-base', ground, now]).stdout.trim() : ''
      const held = contains(ctx.repo, fork, env.base_sha) ? fork : env.base_sha
      // The head each leaf was last ruled against. The workflow records an affected ruling only
      // once its replan has settled or stopped the leaf on disk, so either ruling is an answer.
      // The leaf is asked only about what moved after that head.
      const ruledAt = new Map(readLog(ctx.repo, ctx.effort, 'state:' + ctx.execution).entries
        .filter((e) => e.kind === 'stale-ruled').map((e) => [e.node, e.base_now]))
      const movedSince = new Map()
      for (const id of subtreeOf(tree.nodes, root)) {
        const n = tree.nodes.get(id)
        // A stopped leaf is the user's already; it is looked at again once its stop clears.
        if (n.kind !== 'leaf' || ['merged', 'escalated', 'parked'].includes((tree.status.get(id) || {}).status)) continue
        const last = ruledAt.get(id) || ''
        const anchor = contains(ctx.repo, last, held) && contains(ctx.repo, now, last) ? last : held
        if (anchor === now) continue
        if (!movedSince.has(anchor)) movedSince.set(anchor, new Set(changedFiles(ctx.repo, anchor, now)))
        const moved = movedSince.get(anchor)
        const writes = n.locus.filter((p) => moved.has(p))
        const reads = n.reads.filter((p) => moved.has(p))
        if (writes.length || reads.length) stale.push({ node: id, anchor, writes, reads })
      }
      if (stale.length) {
        const brief = stalePath(ctx.repo, ctx.effort, ctx.execution, now)
        writeFileSync(brief, rulingBrief(tree, stale.map((st) => ({
          node: st.node,
          note: 'The base branch moved from ' + st.anchor + ' to ' + now + '.' +
            (st.writes.length ? ' Moved files it writes: ' + st.writes.join(', ') + '.' : '') +
            (st.reads.length ? ' Moved files it reads: ' + st.reads.join(', ') + '.' : ''),
          diff: git(ctx.repo, ['diff', st.anchor + '..' + now, '--', ...st.writes, ...st.reads]).stdout,
        }))))
        staleOut = { nodes: stale.map((st) => st.node), rows: stale.map((st) => ({ ...rowOf(ctx, tree, st.node), under_way: underWay(tree, st.node) })), now, brief }
      }
    }
  }

  const { gaps, untraced } = trace(tree.nodes, root)
  if (!checkpoint && gaps.length && !args.confirmed_gaps) {
    checkpoint = { reason: 'blocking_gaps', detail: gaps.length + ' decision(s) no entry realises, or evidence a node needs was not reached', gaps }
  }
  if (!checkpoint && args.plan_only) checkpoint = { reason: 'parked', detail: 'plan_only: the plan is on disk and nothing was dispatched' }

  releaseSlots(ctx.repo, { effort: ctx.effort, execution: ctx.execution })
  // Leftover checkouts of this effort's branches away from their canonical path: git refuses a
  // branch in two worktrees, so a dead invocation's leftover would bring the next one up
  // detached. Clean ones are removed; a dirty one is never forced.
  const prefix = 'agentics/' + ctx.effort
  for (const [path, w] of worktrees(ctx.repo)) {
    if (!(w.branch === prefix || w.branch.startsWith(prefix + '--'))) continue
    const id = w.branch === prefix ? ROOT_ID : w.branch.slice(prefix.length + 2).split('.').join('/')
    if (worktreeOf(ctx.repo, ctx.effort, id) === path) continue
    // Only this plugin's own leftovers: a checkout the user made elsewhere is theirs.
    if (!path.startsWith(posix(join(ctx.repo, '.claude', 'worktrees')) + '/')) continue
    if (git(path, ['status', '--porcelain']).stdout.trim()) {
      dirty.push(path)
      continue
    }
    git(ctx.repo, ['worktree', 'remove', path])
  }
  git(ctx.repo, ['worktree', 'prune'])

  mkdirState(saidDir(ctx.repo, ctx.effort, ctx.execution))
  const ids = subtreeOf(tree.nodes, root)
  // The lists stay on disk: the session reads them with `lib/status.mjs checkpoint`, also when the
  // user confirmed past them.
  if (checkpoint) append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'checkpoint', ...checkpoint })
  const confirmed = {
    ...(gaps.length && args.confirmed_gaps ? { gaps } : {}),
  }
  if (!checkpoint && Object.keys(confirmed).length) {
    append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'checkpoint-confirmed', ...confirmed })
  }

  return {
    boundary: 'preflight', ok: true, error: null, invocation,
    checkpoint: checkpoint ? { reason: checkpoint.reason, detail: checkpoint.detail } : null,
    stale: checkpoint ? null : staleOut,
    said_dir: saidDir(ctx.repo, ctx.effort, ctx.execution),
    counts: { nodes: ids.length, leaves: ids.filter((id) => tree.nodes.get(id).kind === 'leaf').length, gaps: gaps.length, untraced: untraced.length },
    dirty_worktrees: dirty,
    max_parallel: maxParallel(ctx.repo),
    todos: checkpoint ? [] : todos(ctx, args, [root]),
    notes,
  }
}

// ------------------------------------------------------------------ schedule

/** What `lib/schedule.mjs` reads, bound to this execution's disk. */
function scheduleInput(ctx, tree, env, args) {
  const integrations = new Map()
  const integration = (id) => {
    if (!integrations.has(id)) integrations.set(id, integrationOf(ctx, tree, id))
    return integrations.get(id)
  }
  const holder = holderReader(ctx.repo)
  return {
    nodes: tree.nodes, status: tree.status, events: tree.events, root: env.root || ROOT_ID,
    state: readLog(ctx.repo, ctx.effort, 'state:' + ctx.execution).entries,
    running: Array.isArray(args.running) ? args.running : [],
    planning: Array.isArray(args.planning) ? args.planning : [],
    held: Array.isArray(args.held) ? args.held : [],
    stopping: args.stopping === true,
    maxParallel: maxParallel(ctx.repo),
    integrationOf: integration,
    lockedBy: (id) => holder({ effort: ctx.effort, node: id, locus: tree.nodes.get(id).locus }),
    approvedHead: (id) => approvedHead(tree.events, id),
  }
}

/** Resume facts for the named leaves only: the ladder reads git per leaf, so never the whole tree. */
function leafFactsOf(ctx, tree, ids) {
  if (ids.length === 0) return new Map()
  const wanted = new Map()
  for (const id of ids) {
    wanted.set(id, tree.nodes.get(id))
    for (const dep of tree.nodes.get(id).deps) if (tree.nodes.has(dep)) wanted.set(dep, tree.nodes.get(dep))
  }
  const ownerHeads = new Map()
  const parentHeads = {}
  for (const id of ids) {
    const owner = ownerOf(tree.nodes, id)
    if (!ownerHeads.has(owner)) ownerHeads.set(owner, revParse(ctx.repo, 'refs/heads/' + branchOf(ctx.effort, owner)))
    parentHeads[id] = ownerHeads.get(owner)
  }
  const out = new Map()
  for (const l of resumeLeaves(ctx.repo, ctx.effort, ctx.execution, wanted, parentHeads)) {
    if (!ids.includes(l.id)) continue
    const rounds = roundsOf(tree.events, l.id)
    const role = executorRole(tree.nodes.get(l.id))
    const brief = rounds ? briefPath(ctx.repo, ctx.effort, ctx.execution, l.id, role || 'none', rounds) : ''
    out.set(l.id, {
      id: l.id, next_action: l.next_action, branch: l.branch, worktree: l.worktree, head_sha: l.head_sha, base_sha: l.base_sha,
      rounds, brief_path: brief && existsSync(brief) ? brief : '',
    })
  }
  return out
}

/**
 * The execution's scheduler: append the workflow's decisions, then say what to launch, each unit
 * with the one row it needs. The workflow calls it whenever a unit settles, one call at a time.
 */
function scheduleBoundary(ctx, args) {
  const records = appendRecords(ctx, args.records)
  // A leaf held on a plugin fault gives its slot back: it runs no more in this invocation.
  for (const r of Array.isArray(args.records) ? args.records : []) {
    if (r && r.entry && r.entry.kind === 'fault') releaseSlots(ctx.repo, { effort: ctx.effort, execution: ctx.execution, node: r.entry.node })
  }
  const env = readEnvelope(ctx)
  if (!env) return fail('schedule', 'no_execution', 'execution ' + ctx.execution + ' has no envelope — run preflight first')
  const tree = readTree(ctx.repo, ctx.effort)
  if (tree.error) return fail('schedule', 'unreadable', tree.error)
  const { launch, idle } = schedule(scheduleInput(ctx, tree, env, args))
  const facts = leafFactsOf(ctx, tree, launch.filter((l) => l.unit === 'leaf').map((l) => l.id))
  const withRows = launch.map((l) => {
    if (l.unit === 'merge') return l
    const row = rowOf(ctx, tree, l.id)
    // A planner surveying unknown ground asks about the folder's intent; nothing else reads prose.
    if (l.unit === 'plan') return { ...l, row: { ...row, intent: tree.nodes.get(l.id).intent } }
    if (l.unit !== 'leaf') return { ...l, row }
    return { ...l, row, parent: parentRowOf(ctx, tree, l.id), facts: facts.get(l.id) || null, waits_on: waitsOn(tree, l.id) }
  })
  const touched = (Array.isArray(args.records) ? args.records : []).map((r) => r && r.entry && r.entry.node).filter(Boolean)
  return {
    boundary: 'schedule', ok: true, error: null, launch: withRows, idle,
    max_parallel: maxParallel(ctx.repo),
    records,
    todos: todos(ctx, args, [...touched, ...launch.map((l) => l.id || l.target)]),
    notes: [],
  }
}
const roundsOf = (events, id) => events.filter((e) => e.kind === 'dispatched' && e.node === id).reduce((m, e) => Math.max(m, Number.isInteger(e.round) ? e.round : 0), 0)

// ------------------------------------------------------------------ leaf-open

const BRANCH_WAIT_MS = 60 * 1000

const STAGE = { implementer: 'implementing', 'test-author': 'writing tests', auditor: 'auditing', '': 'checking' }

function leafOpen(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  const id = args.node
  const leaf = tree.nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf') return fail('leaf-open', 'not_a_leaf', JSON.stringify(id) + ' is not a live leaf')
  const env = readEnvelope(ctx)
  if (!env) return fail('leaf-open', 'no_execution', 'execution ' + ctx.execution + ' has no envelope — run preflight first')
  const role = typeof args.role === 'string' ? args.role : executorRole(leaf)
  const round = Number.isInteger(args.round) && args.round > 0 ? args.round : 1

  const got = acquire(ctx.repo, {
    effort: ctx.effort, execution: ctx.execution, node: id,
    locus: leaf.locus, waitMs: Number.isInteger(args.wait_ms) ? args.wait_ms : undefined,
  })
  if (!got.ok) {
    return { boundary: 'leaf-open', ok: true, error: got.reason === 'invalid' ? { kind: 'invalid', message: got.error } : null, status: got.reason, held_by: got.held_by, max_parallel: maxParallel(ctx.repo), todos: [], notes: got.notes || [] }
  }

  const parent = ownerOf(tree.nodes, id)
  const lock = (branch, fn) => withBranchLock(ctx.repo, ctx.effort, branch, fn, { waitMs: BRANCH_WAIT_MS })
  let integ
  let made
  try {
    integ = ensureIntegration(ctx.repo, ctx.effort, parent, env, { lock, isGroup: isGroupIn(tree) })
    if (!integ.ok) return fail('leaf-open', 'integration', integ.error, { status: 'refused' })
    // The cut happens under the parent's lock, reading its head there: a merge-batch bisecting
    // into the parent moves that head through unverified states, and none of them is a base.
    made = lock(integ.branch, () => {
      // Where a new branch is cut: the cycle predecessor's head for green and audit (green is
      // coded on red's tests; red is held, never merged alone), then brought up to the parent's
      // head so every other dependency's output is there too; the parent's head otherwise.
      let from = revParse(ctx.repo, 'refs/heads/' + integ.branch)
      const cycle = cycleOf(tree.nodes, id)
      const at = cycle.indexOf(id)
      if (at > 0) {
        const pred = revParse(ctx.repo, 'refs/heads/' + branchOf(ctx.effort, cycle[at - 1]))
        if (!pred) return { ok: false, error: cycle[at - 1] + ' has no branch to cut ' + id + ' from' }
        from = pred
      }
      return ensureLeaf(ctx.repo, ctx.effort, id, { from, parentBranch: integ.branch, cycleMember: at > 0 })
    })
  } catch (err) {
    // The parent is being merged into; this is a wait, not a failure — the workflow re-dispatches.
    return { boundary: 'leaf-open', ok: true, error: null, status: 'busy', held_by: [], max_parallel: maxParallel(ctx.repo), todos: [], notes: [err.message] }
  }
  if (!made.ok) return fail('leaf-open', 'branch', made.error, { status: 'refused' })

  const fix = readJson(fixesPath(ctx.repo, ctx.effort, ctx.execution, id, round))
  const brief = assembleBrief(ctx.repo, ctx.effort, ctx.execution, id, {
    role: role || 'none', round, fix: Array.isArray(fix) ? fix : [],
  })
  const tier = args.dispatch && typeof args.dispatch === 'object' ? args.dispatch : {}
  // Only the dispatch the leaf's status already stands on is this one sent again (a lost courier).
  // After a replan, an approval or a round it is a new dispatch, whatever the log holds.
  const now = tree.status.get(id) || {}
  const standing = now.status === 'active' && now.last.execution === ctx.execution && now.last.role === role && now.last.round === round
  if (!standing) {
    const r = append(ctx.repo, ctx.effort, 'events', [{ execution: ctx.execution, kind: 'dispatched', node: id, role, round, model: tier.model || '', effort: tier.effort || '' }])
    if (!r.ok) throw new Error('events refused: ' + r.error)
  }

  const report = reportPath(ctx.repo, ctx.effort, ctx.execution, id, role || 'none', round)
  mkdirState(dirname(report))
  const stage = round > 1 && role ? 'fix round ' + round : STAGE[role] || 'checking'
  return {
    boundary: 'leaf-open', ok: true, error: null, status: 'opened',
    branch: made.branch, worktree: made.worktree, base_sha: made.base, head_sha: made.head, rebased: made.rebased,
    brief_path: brief.path, brief_digest: brief.digest, report_path: report,
    slot: got.slot, max_parallel: maxParallel(ctx.repo),
    todos: todos(ctx, args, [id], { [id]: { status: 'in_progress', activeForm: stage } }),
    notes: [...(got.notes || []), ...integ.created.map((b) => 'created ' + b), ...integ.refreshed.map((b) => 'refreshed ' + b)],
  }
}

// ------------------------------------------------------------------ leaf-close

/** The commands verification runs, from `command` gotchas an investigator wrote, else the envelope. */
function commandsFor(ctx) {
  const env = readEnvelope(ctx) || {}
  const given = env.commands || {}
  const found = commandsOf(ctx.repo, ctx.effort)
  const pick = (name) => found[name] || given[name] || ''
  const absent = (name) => Boolean((found.absent && found.absent[name]) || (given.absent && given.absent[name]))
  return {
    build: pick('build'), typecheck: pick('typecheck'), suite: pick('suite'), suiteFast: pick('suite_fast'), testOne: pick('test_one'),
    buildAbsent: absent('build'), typecheckAbsent: absent('typecheck'), suiteAbsent: absent('suite'), suiteFastAbsent: absent('suite_fast'),
  }
}

/** Whether the repository splits its tests: then a merge-batch runs the fast suite, and the gate the full one. */
const splitSuite = (cmd) => Boolean(cmd.suiteFast) && !cmd.suiteFastAbsent

/**
 * Commit what a shell-less author wrote inside its locus; anything outside it is left out of the
 * commit, reverted, and reported — the series check would call it a breach, and a file nobody
 * committed must not silently ride into the next measurement.
 */
function commitAuthor(ctx, leaf, worktree, subject) {
  // `git -C` on a path that is not a registered worktree resolves to the enclosing repository —
  // the user's. Nothing here commits anywhere but the leaf's own linked worktree.
  const broken = worktreeProblem(worktree)
  if (broken) return { committed: false, outside: [], sha: '', error: broken.message }
  const st = git(worktree, ['status', '--porcelain', '--untracked-files=all'])
  const changed = st.stdout.split('\n').filter(Boolean).map((l) => posix(l.slice(3).trim().replace(/^"|"$/g, '')))
  const inLocus = changed.filter((p) => leaf.locus.includes(p))
  const outside = changed.filter((p) => !leaf.locus.includes(p))
  for (const p of outside) {
    if (git(worktree, ['ls-files', '--error-unmatch', p]).ok) git(worktree, ['checkout', '--', p])
    else rmSync(join(worktree, p), { force: true })
  }
  if (inLocus.length === 0) return { committed: false, outside, sha: '' }
  const added = git(worktree, ['add', '--', ...inLocus])
  if (!added.ok) return { committed: false, outside, sha: '', error: 'git add failed: ' + added.stderr.trim() }
  const c = git(worktree, ['commit', '-m', subject])
  if (!c.ok) return { committed: false, outside, sha: '', error: c.stderr.trim() }
  return { committed: true, outside, sha: revParse(worktree, 'HEAD') }
}

function leafClose(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  const id = args.node
  const leaf = tree.nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf') return fail('leaf-close', 'not_a_leaf', JSON.stringify(id) + ' is not a live leaf')
  const role = typeof args.role === 'string' ? args.role : executorRole(leaf)
  const round = Number.isInteger(args.round) && args.round > 0 ? args.round : 1
  const worktree = worktreeOf(ctx.repo, ctx.effort, id)
  const branch = branchOf(ctx.effort, id)
  const notes = []

  const report = readText(reportPath(ctx.repo, ctx.effort, ctx.execution, id, role || 'none', round))
  const blocks = extractReportBlocks(report)
  if (blocks.problems.length) notes.push(...blocks.problems.map((p) => 'report: ' + p))

  let committed = false
  const breaches = []
  if (role === 'test-author' || role === 'auditor') {
    const c = commitAuthor(ctx, leaf, worktree, blocks.commit || 'test(' + id + '): ' + leaf.title)
    committed = c.committed
    if (c.error) notes.push('commit refused: ' + c.error)
    for (const p of c.outside) breaches.push({ sha: '', check: 'locus-breach', message: role + ' wrote ' + p + ', outside the locus; not committed and reverted', blocking: role === 'test-author' })
    if (c.committed) {
      append(ctx.repo, ctx.effort, 'journal:' + ctx.execution, {
        kind: 'series-done', node: id, branch, head_sha: c.sha,
        commits: [{ sha: c.sha, subject: blocks.commit || 'test(' + id + '): ' + leaf.title }],
      })
    }
  }

  // The tests a leaf is told to run: its criteria's checks, beside its own tests.
  const checks = leaf.acceptance.filter((a) => !isHuman(a) && a.check.trim()).map((a) => a.check)
  // A green and an audit are measured on their red's tests: the cycle's test files, outside their locus.
  const cycle = cycleOf(tree.nodes, id)
  const tests = (leaf.role === 'green' || leaf.role === 'audit') && cycle.length ? tree.nodes.get(cycle[0]).locus : []
  const cmd = commandsFor(ctx)
  const m = verify({
    worktree, mode: 'order', base: args.base_sha || '', locus: leaf.locus,
    ...cmd, mutations: blocks.mutations, rigor: leaf.rigor, role: leaf.role, checks, tests,
    repo: ctx.repo, effort: ctx.effort, execution: ctx.execution, node: id, branch,
  })
  if (breaches.length) m.series_findings = [...(m.series_findings || []), ...breaches]
  const history = readLog(ctx.repo, ctx.effort, 'journal:' + ctx.execution).entries
    .filter((e) => e.kind === 'verify-observed' && e.node === id)
  const decision = closeDecision(m, leaf, history.slice(0, -1))

  const head = revParse(worktree, 'HEAD')
  const written = []
  const deleted = []
  for (const g of blocks.gotchas) {
    const w = writeGotcha(ctx.repo, ctx.effort, g, { observed_at: head, source: { node: id, role } })
    if (w.ok) written.push(w.id)
    else notes.push('gotcha refused: ' + w.error)
  }
  for (const gid of blocks.stale) if (deleteGotcha(ctx.repo, ctx.effort, gid).deleted) deleted.push(gid)

  const stage = {
    review: { status: 'in_progress', activeForm: 'in review' },
    approve: { status: 'in_progress', activeForm: 'awaiting merge' },
    fix: { status: 'in_progress', activeForm: 'fix round ' + (round + 1) },
    command_unknown: { status: 'in_progress', activeForm: 'establishing commands' },
    escalate: { status: 'pending', activeForm: 'escalated: ' + (decision.reason || '') },
    finding: { status: 'pending', activeForm: 'finding for ' + ownerOf(tree.nodes, id) },
  }[decision.next] || {}
  // Everything observed stays on disk; the courier carries only what the workflow branches on.
  const record = closePath(ctx.repo, ctx.effort, ctx.execution, id, role || 'none', round)
  writeJson(record, {
    node: id, role, round, head_sha: head, measurement: m, decision, gotchas_written: written,
    gotchas_deleted: deleted, mutations: blocks.mutations, committed, notes,
  })
  // The next round's failures stand only while this close says `fix`; a later close that decided
  // anything else takes them back, so a round opened for another reason never inherits them.
  const nextFixes = fixesPath(ctx.repo, ctx.effort, ctx.execution, id, round + 1)
  if (decision.next === 'fix') writeJson(nextFixes, decision.failures.map((f) => ({ source: 'verification', ...f })))
  else rmSync(nextFixes, { force: true })
  return {
    boundary: 'leaf-close', ok: true, error: null, status: 'done', node: id, head_sha: head,
    decision: { next: decision.next, reason: decision.reason, failures: decision.failures.map(carriedFailure) },
    record, committed, todos: todos(ctx, args, [id], { [id]: stage }), notes: [],
  }
}

// ------------------------------------------------------------------ merge-batch

/** Order a batch so a child merges after any sibling it depends on. */
function dependencyOrder(nodes, ids) {
  const out = []
  const visit = (id, seen = new Set()) => {
    if (out.includes(id) || seen.has(id)) return
    seen.add(id)
    for (const d of (nodes.get(id) || { deps: [] }).deps) if (ids.includes(d)) visit(d, seen)
    out.push(id)
  }
  for (const id of ids) visit(id)
  return out
}

const integrationOk = (m) => m && m.stop_reason === 'completed' && m.build !== 'failed' && m.typecheck !== 'failed' && !suiteFailed(m)
const integrationFailures = (m, head = 'the merged head') => {
  const out = []
  if (!m || m.stop_reason !== 'completed') out.push({ check: 'environment', claim: (m && m.error && m.error.message) || head + ' could not be measured', evidence: '' })
  for (const k of ['build', 'typecheck', 'suite']) {
    const what = k === 'suite' && m && m.suite_scope === 'fast' ? 'fast suite' : k
    if (m && (k === 'suite' ? suiteFailed(m) : m[k] === 'failed')) out.push({ check: k, claim: 'the ' + what + ' fails on ' + head, evidence: k === 'suite' ? (m.suite_output_tail || '') : (m.notes || '') })
  }
  return out
}

/**
 * Pure. What a landed diff touched that a pending node was designed against: the landed files
 * intersected with the `consumes` path prefixes of every node not yet merged. A contract the
 * landed work itself provides is expected to move and is not drift; a node with no contracts to
 * check against is reported as unexamined, because "no flag" and "nothing to check" differ.
 */
export function driftOf(tree, landedIds, files) {
  const landedSet = new Set(landedIds.flatMap((id) => subtreeOf(tree.nodes, id)))
  const providedHere = new Set([...landedSet].flatMap((id) => tree.nodes.get(id).provides.map((c) => c.name)))
  const under = (file, prefix) => file === prefix || file.startsWith(prefix.replace(/\/?$/, '/'))
  const drift = []
  let unexamined = 0
  for (const [id, n] of tree.nodes) {
    if (landedSet.has(id)) continue
    const s = (tree.status.get(id) || {}).status
    if (['merged', 'landed', 'integrated'].includes(s)) continue
    if (n.consumes.length === 0) {
      if (n.kind === 'design' && childrenOf(tree.nodes, id).length === 0) unexamined++
      continue
    }
    for (const c of n.consumes) {
      if (providedHere.has(c.name)) continue
      const hit = files.filter((f) => c.paths.some((p) => under(f, p)))
      // A stopped node is the user's already: its drift is reported, never parked over its stop.
      if (hit.length) drift.push({ node: id, contract: c.name, files: hit, ...(['escalated', 'parked'].includes(s) ? { stopped: s } : {}) })
    }
  }
  return { drift, unexamined }
}

/**
 * A single leaf that fails on the integration head alone goes back to a fix round: its row and
 * resume facts, and the failures that round must clear, written where its leaf-open reads them.
 */
function withLeafRow(ctx, failure) {
  const tree = readTree(ctx.repo, ctx.effort)
  const round = roundsOf(tree.events, failure.id) + 1
  writeJson(fixesPath(ctx.repo, ctx.effort, ctx.execution, failure.id, round), failure.failures.map((f) => ({ source: 'integration', ...f })))
  return {
    ...failure, row: rowOf(ctx, tree, failure.id), parent: parentRowOf(ctx, tree, failure.id),
    facts: leafFactsOf(ctx, tree, [failure.id]).get(failure.id) || null,
  }
}

/** A failure as the courier carries it: what failed, never the output that shows it. */
const carriedFailure = ({ check, claim }) => ({ check, claim })

function mergeBatch(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  const target = args.target
  if (!tree.nodes.has(target) || ['leaf', 'group'].includes(tree.nodes.get(target).kind)) return fail('merge-batch', 'not_a_composite', JSON.stringify(target) + ' is not a composite in this effort')
  const env = readEnvelope(ctx)
  if (!env) return fail('merge-batch', 'no_execution', 'no envelope for ' + ctx.execution)
  const children = (Array.isArray(args.children) ? args.children : []).filter((c) => c && tree.nodes.has(c.id))
  const cycles = Array.isArray(args.cycles) ? args.cycles : []

  // Units: a cycle merges through its tip, which carries every member's commits.
  const inCycle = new Map()
  for (const cycle of cycles) for (const m of cycle) inCycle.set(m, cycle)
  const units = []
  const done = new Set()
  for (const id of dependencyOrder(tree.nodes, children.map((c) => c.id))) {
    if (done.has(id)) continue
    const cycle = inCycle.get(id)
    const ids = cycle ? cycle.filter((m) => children.some((c) => c.id === m)) : [id]
    ids.forEach((m) => done.add(m))
    const tip = ids[ids.length - 1]
    const given = children.find((c) => c.id === tip)
    const branch = branchOf(ctx.effort, tip)
    units.push({ ids, branch, head: (given && given.head_sha) || revParse(ctx.repo, 'refs/heads/' + branch) })
  }

  const targetBranch = branchOf(ctx.effort, target)
  const lock = (branch, fn) => withBranchLock(ctx.repo, ctx.effort, branch, fn)
  return lock(targetBranch, () => {
    const integ = ensureIntegration(ctx.repo, ctx.effort, target, env, { lock, held: targetBranch, isGroup: isGroupIn(tree) })
    if (!integ.ok) return fail('merge-batch', 'integration', integ.error)
    const wt = integ.worktree

    // A batch that started and never recorded its outcome died between merging and measuring, or
    // mid-bisect: its merges are unverified. Back to the head it started from, and do it again.
    const log = readLog(ctx.repo, ctx.effort, 'state:' + ctx.execution).entries
    const lastOf = (kind) => [...log].reverse().find((e) => e.kind === kind && e.target === target)
    const started = lastOf('batch-started')
    const finished = lastOf('batch')
    const notes = []
    if (started && (!finished || finished.seq < started.seq) && started.pre && contains(ctx.repo, revParse(wt, 'HEAD'), started.pre)) {
      git(wt, ['merge', '--abort'])
      resetTo(wt, started.pre)
      notes.push('an earlier batch into ' + target + ' died before recording its outcome; reset to ' + started.pre + ' and merged again')
    }
    const pre = revParse(wt, 'HEAD')
    const cmd = commandsFor(ctx)
    const measure = () => verify({ worktree: wt, mode: 'integration', scope: 'fast', base: pre, ...cmd, repo: ctx.repo, effort: ctx.effort, execution: ctx.execution, node: target, branch: integ.branch })

    const pending = units.filter((u) => !contains(ctx.repo, pre, u.head))
    if (pending.length) append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'batch-started', target, pre, children: pending.flatMap((u) => u.ids) })
    let out = mergeUnits(ctx.repo, wt, units)
    let merged = out.merged
    let measurement = null
    let verified = null
    const failedAlone = []
    let combination = []

    const fresh = merged.filter((m) => !m.already)
    // Everything already contained and nothing started: a re-run after the outcome was recorded.
    if (fresh.length === 0 && merged.length > 0) verified = true
    if (fresh.length > 0) {
      measurement = measure()
      verified = integrationOk(measurement)
      if (!verified) {
        // Bisect: back to the last green head, each unit alone, then the ones that pass together.
        resetTo(wt, pre)
        const passers = []
        for (const u of units.filter((x) => fresh.some((f) => f.ids === x.ids))) {
          const alone = mergeUnits(ctx.repo, wt, [u])
          const m = alone.conflict ? null : measure()
          if (m && integrationOk(m)) passers.push(u)
          else failedAlone.push({ id: u.ids[u.ids.length - 1], ids: u.ids, failures: m ? integrationFailures(m) : [{ check: 'merge', claim: alone.conflict.reason, evidence: '' }] })
          resetTo(wt, pre)
        }
        out = mergeUnits(ctx.repo, wt, passers)
        merged = out.merged
        if (passers.length > 1) {
          measurement = measure()
          verified = integrationOk(measurement)
          if (!verified) {
            combination = passers.flatMap((u) => u.ids)
            resetTo(wt, pre)
            merged = []
          }
        } else {
          verified = passers.length === 1
        }
      }
    }

    const head = revParse(wt, 'HEAD')
    const landed = merged.flatMap((m) => m.ids.map((id) => ({ id, merged_sha: m.merged_sha })))
    if (landed.length) {
      appendRecords(ctx, landed.map((l) => ({ file: 'events', entry: { kind: 'merged', node: l.id, into: integ.branch, merged_sha: l.merged_sha, head_sha: (units.find((u) => u.ids.includes(l.id)) || {}).head || '' } })))
      append(ctx.repo, ctx.effort, 'journal:' + ctx.execution, landed.map((l) => ({ kind: 'merge-observed', node: l.id, branch: branchOf(ctx.effort, l.id), into: integ.branch, merged_sha: l.merged_sha, head_sha: head })))
      const leafIds = landed.map((l) => l.id).filter((id) => tree.nodes.get(id).kind === 'leaf')
      const under = landed.map((l) => l.id).filter((id) => tree.nodes.get(id).kind !== 'leaf')
        .flatMap((c) => subtreeOf(tree.nodes, c)).filter((id) => tree.nodes.get(id).kind === 'leaf')
      releaseLocus(ctx.repo, ctx.effort, [...leafIds, ...under])
    }
    const conflict = out.conflict ? { node: out.conflict.ids[out.conflict.ids.length - 1], nodes: out.conflict.ids, paths: out.conflict.paths, reason: out.conflict.reason } : null
    if (pending.length) {
      append(ctx.repo, ctx.effort, 'state:' + ctx.execution, {
        kind: 'batch', target, merged: landed.map((l) => l.id), head_sha: head, verified,
        failed_alone: failedAlone.map((f) => f.id), combination, conflict: conflict ? conflict.node : '',
      })
    }

    const where = integrationOf(ctx, tree, target)
    const { drift, unexamined } = landed.length ? driftOf(tree, landed.map((l) => l.id), changedFiles(ctx.repo, pre, head)) : { drift: [], unexamined: 0 }
    const record = mergePath(ctx.repo, ctx.effort, ctx.execution, target, pre)
    writeJson(record, { target, pre, head_sha: head, merged: landed, conflict, verified, measurement, failed_alone: failedAlone, combination, notes })
    // What the drifted consumers are ruled against: each one as planned, and the merged change to
    // the files it consumes.
    const open = drift.filter((d) => !d.stopped)
    const driftBrief = open.length ? record.replace(/\.json$/, '.drift.md') : ''
    if (driftBrief) {
      writeFileSync(driftBrief, rulingBrief(tree, [...new Set(open.map((d) => d.node))].map((id) => {
        const hits = open.filter((d) => d.node === id)
        return {
          node: id,
          note: 'Work merged into ' + integ.branch + ' touched ' +
            hits.map((d) => 'contract ' + d.contract + ' (' + d.files.join(', ') + ')').join(' and ') + ', which it consumes.',
          diff: git(wt, ['diff', pre + '..' + head, '--', ...new Set(hits.flatMap((d) => d.files))]).stdout,
        }
      })))
    }
    return {
      boundary: 'merge-batch', ok: true, error: null, status: 'done', target,
      target_branch: integ.branch, target_worktree: wt, target_base: where ? where.base : '',
      merged: landed, conflict: conflict && { node: conflict.node, nodes: conflict.nodes, paths: conflict.paths }, head_sha: head, verified, record,
      failed_alone: failedAlone.map((f) => ({
        ...(f.ids.length === 1 && tree.nodes.get(f.id).kind === 'leaf' ? withLeafRow(ctx, f) : f),
        failures: f.failures.map(carriedFailure),
      })),
      combination, drift: drift.map((d) => (d.stopped ? d : { ...d, row: { ...rowOf(ctx, tree, d.node), under_way: underWay(tree, d.node) } })), drift_brief: driftBrief,
      unexamined_n: unexamined, todos: todos(ctx, args, landed.map((l) => l.id)), notes: [],
    }
  })
}

// ------------------------------------------------------------------ suite-gate

/**
 * The full suite on a composite's integration head, once every child has merged: it runs before
 * the integration review, and so before the branch merges up or lands. Where the repository does
 * not split its tests, every merge-batch into this head already ran the full suite.
 */
function suiteGate(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  const target = args.target
  if (!tree.nodes.has(target) || ['leaf', 'group'].includes(tree.nodes.get(target).kind)) return fail('suite-gate', 'not_a_composite', JSON.stringify(target) + ' is not a composite in this effort')
  const where = integrationOf(ctx, tree, target)
  if (!where) return fail('suite-gate', 'no_integration', 'composite ' + target + ' has no integration branch')
  const cmd = commandsFor(ctx)
  const done = (head, extra) => ({
    boundary: 'suite-gate', ok: true, error: null, status: 'done', target, head_sha: head,
    ran: false, passed: true, failures: [], record: '', todos: [], notes: [], ...extra,
  })
  if (!splitSuite(cmd)) return done(where.head, { notes: ['no fast suite is established: every merge-batch into ' + target + ' ran the full suite'] })
  const passedAt = (head) => readLog(ctx.repo, ctx.effort, 'state:' + ctx.execution).entries
    .some((e) => e.kind === 'gate' && e.target === target && e.head_sha === head && e.passed)
  if (passedAt(where.head)) return done(where.head, { notes: ['the full suite already passed at ' + where.head] })

  return withBranchLock(ctx.repo, ctx.effort, where.branch, () => {
    const wt = attach(ctx.repo, where.branch, where.worktree)
    if (!wt.ok) return fail('suite-gate', 'integration', wt.error)
    const head = revParse(wt.path, 'HEAD')
    const m = verify({
      worktree: wt.path, mode: 'integration', scope: 'full', base: where.base, ...cmd,
      repo: ctx.repo, effort: ctx.effort, execution: ctx.execution, node: target, branch: where.branch,
    })
    const passed = integrationOk(m)
    const failures = passed ? [] : integrationFailures(m, 'the integration head')
    const record = gatePath(ctx.repo, ctx.effort, ctx.execution, target, head)
    writeJson(record, { target, head_sha: head, base: where.base, passed, measurement: m, failures })
    append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'gate', target, head_sha: head, passed })
    return done(head, { ran: true, passed, failures: failures.map(carriedFailure), record })
  })
}

// ------------------------------------------------------------------ postflight

export function postflight(ctx, args) {
  const records = appendRecords(ctx, args.records)
  releaseSlots(ctx.repo, { effort: ctx.effort, execution: ctx.execution })
  const tree = readTree(ctx.repo, ctx.effort)
  const env = readEnvelope(ctx) || { root: ROOT_ID }
  const root = env.root || ROOT_ID
  const input = scheduleInput(ctx, tree, env, {})
  const summary = summarize(input)
  let cleanup = 0
  let unmerged = 0
  for (const id of subtreeOf(tree.nodes, root)) {
    if (id === ROOT_ID || !branchExists(ctx.repo, branchOf(ctx.effort, id))) continue
    if ((tree.status.get(id) || {}).status === 'merged') cleanup++
    else unmerged++
  }
  if (summary.done && !input.state.some((e) => e.kind === 'closed')) {
    append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'closed', status: 'done' })
  }
  const notes = usageNotes(ctx)
  // The invocation is over: a session watching for questions stops here.
  append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'ended' })
  const where = input.integrationOf(root) || {}
  return {
    boundary: 'postflight', ok: true, error: null, summary,
    integration: { branch: where.branch || '', head_sha: where.head || '' },
    cleanup_n: cleanup, unmerged_n: unmerged, closed: summary.done,
    records, todos: todos(ctx, args, [root]), notes,
  }
}

// ------------------------------------------------------------------ planner specs

/**
 * What a planner-written spec says about itself: where it is, its hash, how many decisions it
 * states (a planner may state none) and every problem `checkFolder` finds in its place in the
 * effort. A folder its parent does not give to the planner is refused here too.
 */
function specFacts(ctx, id) {
  const checked = checkFolder(ctx.repo, ctx.effort, id)
  const problems = [...checked.problems]
  if (checked.exists && checked.authoredBy !== 'planner') {
    problems.push({ file: checked.file, line: 1, problem: 'the parent spec gives ' + id + ' to the user, not to the planner' })
  }
  return {
    spec_path: posix(specPath(ctx.repo, ctx.effort, id)), exists: checked.exists, hash: checked.hash,
    decisions_n: checked.spec ? checked.spec.decisions.length : 0, problems,
  }
}

function specCheck(ctx, args) {
  const id = String(args.node || '')
  return { boundary: 'spec-check', ok: true, error: null, node: id, ...specFacts(ctx, id), todos: [], notes: [] }
}

/** Record the planner's dispositions, each once: a re-sent boundary finds its lines already there. */
function specSettle(ctx, args) {
  const id = String(args.node || '')
  const seen = new Set(readLog(ctx.repo, ctx.effort, 'ledger').entries
    .filter((e) => e.kind === 'disposition' && e.folder === id).map((e) => e.finding + '|' + e.outcome))
  let recorded = 0
  for (const d of Array.isArray(args.dispositions) ? args.dispositions : []) {
    if (seen.has(d.finding + '|' + d.outcome)) continue
    const r = recordDisposition(ctx.repo, ctx.effort, id, { finding: d.finding, outcome: d.outcome, by: 'planner' })
    if (!r.ok) return fail('spec-settle', 'ledger', r.error)
    seen.add(d.finding + '|' + d.outcome)
    recorded++
  }
  return { boundary: 'spec-settle', ok: true, error: null, recorded, todos: [], notes: [] }
}

/** One review round examined this much of the spec on disk and raised these ambiguities: the ledger's `reviewed` line. */
function specReviewed(ctx, args) {
  const id = String(args.node || '')
  const list = (v) => (Array.isArray(v) ? v : [])
  const r = recordReviewed(ctx.repo, ctx.effort, id, {
    complete: args.complete === true, remaining: list(args.remaining), ambiguities: list(args.ambiguities),
  })
  if (!r.ok) return fail('spec-reviewed', 'ledger', r.error)
  return { boundary: 'spec-reviewed', ok: true, error: null, todos: [], notes: [] }
}

/** The review gate of the spec as it stands, from the ledger: `approvalGate`, as the design skill reads it. */
function specGate(ctx, args) {
  const { ratifiable, open, coverage_complete, reviewed } = approvalGate(ctx.repo, ctx.effort, String(args.node || ''))
  return { boundary: 'spec-gate', ok: true, error: null, ratifiable, open, coverage_complete, reviewed, todos: [], notes: [] }
}

/**
 * The gate passed: record the preparation against the review it passed, then compile the folder.
 * A compile that parks this very folder `spec_changed` has met the planner's own re-derivation of
 * it under dispatched work: that preparation is the answer, so the park is cleared at once.
 */
function specPrepare(ctx, args) {
  const id = String(args.node || '')
  const facts = specFacts(ctx, id)
  if (!facts.exists || facts.decisions_n > 0 || facts.problems.length > 0) {
    return { boundary: 'spec-prepare', ok: true, error: null, status: 'refused', problems: facts.problems, todos: [], notes: [] }
  }
  const prepared = recordPreparation(ctx.repo, ctx.effort, id, { review: String(args.review || '') })
  if (!prepared.ok) return fail('spec-prepare', 'ledger', prepared.error)
  const compile = compileEffort(ctx.repo, ctx.effort, { folder: id })
  if (compile.ok && (compile.parked || []).some((p) => p.node === id && p.reason === 'spec_changed')) {
    const cleared = append(ctx.repo, ctx.effort, 'events', { kind: 'replanned', node: id, execution: ctx.execution, reason: 'spec_rederived', by: 'planner' })
    if (!cleared.ok) return fail('spec-prepare', 'ledger', cleared.error)
  }
  const tree = readTree(ctx.repo, ctx.effort)
  const row = tree.nodes.has(id) ? rowOf(ctx, tree, id) : null
  return {
    boundary: 'spec-prepare', ok: true, error: null, status: 'prepared', hash: prepared.hash,
    compile: { ok: compile.ok, problems: compile.problems || [], written_n: (compile.written || []).length }, row, todos: [], notes: [],
  }
}

// ------------------------------------------------------------------ land (the session's act)

/**
 * Landing: the one ask. `check` reports what the user needs to decide; `merge` merges the effort
 * branch into the user's checked-out branch, refusing over an open escalation, a parked node or a
 * dirty tree; `cleanup` removes merged node branches and their clean worktrees.
 */
export function land(repo, effort, action) {
  const tree = readTree(repo, effort)
  const effortBranch = branchOf(effort, ROOT_ID)
  const open = [...tree.status].filter(([, s]) => s.status === 'escalated' || s.status === 'parked')
  const human = [...tree.nodes.values()].flatMap((n) => n.acceptance.filter(isHuman).map((a) => ({ node: n.id, text: a.text })))
  const base = effortBase(repo, effort)
  const head = revParse(repo, 'HEAD')
  const into = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  const effortHead = revParse(repo, 'refs/heads/' + effortBranch)

  const report = () => {
    const userCommits = base.base_sha && head ? git(repo, ['log', '--oneline', base.base_sha + '..' + head]).stdout.split('\n').filter(Boolean) : []
    const userFiles = base.base_sha && head ? changedFiles(repo, base.base_sha, head) : []
    const effortFiles = base.base_sha && effortHead ? changedFiles(repo, base.base_sha, effortHead) : []
    return {
      action, effort, into, effort_branch: effortBranch, effort_head: effortHead,
      open_escalations: open.filter(([, s]) => s.status === 'escalated').map(([id, s]) => ({ node: id, reason: (s.last && s.last.reason) || '' })),
      parked: open.filter(([, s]) => s.status === 'parked').map(([id, s]) => ({ node: id, question: saidOf(s.last) })),
      human,
      drift: { base_sha: base.base_sha, base_moved: userCommits.length > 0, commits: userCommits, overlap: effortFiles.filter((f) => userFiles.includes(f)) },
      root_status: (tree.status.get(ROOT_ID) || {}).status || 'planned',
      root_claims: claimsOf(tree.events, ROOT_ID),
      landing: renderLanding(repo, effort),
    }
  }

  if (action === 'check') return { ...report(), ok: true }

  if (action === 'merge') {
    const r = report()
    if (!effortHead) return { ...r, ok: false, error: 'there is no effort branch ' + effortBranch }
    if (r.open_escalations.length || r.parked.length) return { ...r, ok: false, error: 'never lands over an open escalation or a parked node' }
    const dirty = git(repo, ['status', '--porcelain']).stdout.split('\n')
      .filter((l) => l && !l.slice(3).startsWith('.claude/') && !l.slice(3).startsWith(AGENTICS_DIR + '/'))
    if (dirty.length) return { ...r, ok: false, error: 'the working tree is dirty: ' + dirty.slice(0, 5).join(', ') }
    if (contains(repo, head, effortHead)) return { ...r, ok: true, merged_sha: head, already: true }
    const m = git(repo, ['merge', '--no-ff', '--no-edit', '-m', 'Merge agentics effort ' + effort, effortBranch])
    if (!m.ok) {
      git(repo, ['merge', '--abort'])
      return { ...r, ok: false, error: 'the merge failed and was aborted: ' + (m.stderr || m.stdout).trim() }
    }
    const sha = revParse(repo, 'HEAD')
    append(repo, effort, 'events', { kind: 'landed', node: ROOT_ID, execution: '', into, merged_sha: sha })
    return { ...r, ok: true, merged_sha: sha }
  }

  if (action === 'cleanup') {
    if (!effortHead || !contains(repo, head, effortHead)) return { action, ok: false, error: 'run cleanup from the checkout that took the landing merge' }
    const removed = []
    const kept = []
    const listed = git(repo, ['branch', '--list', effortBranch, nodeBranchGlob(effort), '--format=%(refname:short)']).stdout.split('\n').filter(Boolean)
    const known = worktrees(repo)
    for (const branch of listed) {
      const tip = revParse(repo, 'refs/heads/' + branch)
      if (!contains(repo, head, tip)) {
        kept.push({ branch, why: 'not merged into ' + into })
        continue
      }
      const wt = [...known.values()].find((w) => w.branch === branch)
      if (wt) {
        if (git(wt.path, ['status', '--porcelain']).stdout.trim()) {
          kept.push({ branch, why: 'its worktree ' + wt.path + ' is dirty' })
          continue
        }
        git(repo, ['worktree', 'remove', wt.path])
      }
      if (git(repo, ['branch', '-d', branch]).ok) removed.push(branch)
      else kept.push({ branch, why: 'git branch -d refused' })
    }
    return { action, ok: true, removed, kept }
  }
  return { action, ok: false, error: 'unknown action ' + JSON.stringify(action) + ' — check, merge or cleanup' }
}

// ------------------------------------------------------------------ jobs

const COMPUTE = { 'leaf-close': leafClose, 'merge-batch': mergeBatch, 'suite-gate': suiteGate }

/**
 * What a job's answer depends on beyond its arguments. The same arguments over a moved tree are a
 * different question: a close after the investigator established commands, a close after a fix
 * round's commits, a merge onto an integration head that moved. Keying on the arguments alone
 * would hand the old answer back forever.
 */
function fingerprint(ctx, name, args) {
  const commands = JSON.stringify(commandsFor(ctx))
  if (name === 'leaf-close') {
    const wt = worktreeOf(ctx.repo, ctx.effort, args.node)
    const report = readText(reportPath(ctx.repo, ctx.effort, ctx.execution, args.node, args.role || 'none', args.round || 1))
    return [commands, revParse(wt, 'HEAD'), git(wt, ['status', '--porcelain']).stdout, fnv1a(report)].join('|')
  }
  if (name === 'merge-batch') return [commands, revParse(ctx.repo, 'refs/heads/' + branchOf(ctx.effort, args.target))].join('|')
  // A gate that failed is asked again by the next invocation: what failed it may have been the
  // environment, which the user fixes without moving the head.
  if (name === 'suite-gate') {
    const invocations = readLog(ctx.repo, ctx.effort, 'state:' + ctx.execution).entries.filter((e) => e.kind === 'invocation').length
    return [commands, revParse(ctx.repo, 'refs/heads/' + branchOf(ctx.effort, args.target)), invocations].join('|')
  }
  return commands
}

/** Bumped whenever a job's payload changes shape, so a result cached in the old shape is never served. */
const JOB_FORMAT = 2

const jobKey = (ctx, name, args) => {
  const { progress: _p, ...rest } = args
  return fnv1a(canonical({ name, ...rest, fingerprint: fingerprint(ctx, name, args), format: JOB_FORMAT }))
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * Run a long boundary in a detached child and poll for its result; `pending` when the poll limit
 * is reached first. The same arguments find the same job: a finished one answers at once, a live
 * one is polled again, a dead one without a result is started afresh.
 */
function detached(ctx, name, args) {
  const dir = join(ctx.dir, 'jobs')
  mkdirState(dir)
  const key = name + '-' + jobKey(ctx, name, args)
  const result = join(dir, key + '.json')
  const pidFile = join(dir, key + '.pid')
  const argsFile = join(dir, key + '.args.json')

  if (!existsSync(result)) {
    const pid = Number.parseInt(readText(pidFile), 10)
    if (!(Number.isInteger(pid) && alive(pid))) {
      writeFileSync(argsFile, JSON.stringify(args))
      const child = spawn(process.execPath, [SELF, 'job', '--name', name, '--repo', ctx.repo, '--effort', ctx.effort,
        '--execution', ctx.execution, '--args-file', argsFile, '--out', result], { detached: true, stdio: 'ignore', windowsHide: true })
      writeFileSync(pidFile, String(child.pid))
      child.unref()
    }
  }
  const until = Date.now() + pollLimit()
  while (Date.now() < until) {
    if (existsSync(result)) {
      const payload = readJson(result)
      // A job that failed is not an answer to keep: the next identical call runs it again.
      if (payload && payload.error) {
        rmSync(result, { force: true })
        rmSync(pidFile, { force: true })
      }
      if (payload) return payload
    }
    sleepMs(250)
  }
  return { boundary: name, ok: true, error: null, status: 'pending', job: key, todos: [], notes: ['still running detached; re-dispatch this boundary to collect it'] }
}

// ------------------------------------------------------------------ CLI

const BOUNDARIES = {
  preflight, schedule: scheduleBoundary, 'leaf-open': leafOpen, postflight,
  'spec-check': specCheck, 'spec-settle': specSettle, 'spec-reviewed': specReviewed, 'spec-gate': specGate,
  'spec-prepare': specPrepare,
}

export function runBoundary(name, repo, effort, execution, args) {
  const ctx = contextOf(repo, effort, execution)
  if (COMPUTE[name]) {
    if (process.env.AGENTICS_INLINE_JOBS === '1') return COMPUTE[name](ctx, args)
    return detached(ctx, name, args)
  }
  if (BOUNDARIES[name]) return BOUNDARIES[name](ctx, args)
  throw new Error('unknown boundary ' + JSON.stringify(name))
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const [name] = argv
  const repo = flagOf(argv, 'repo') || '.'
  const effort = flagOf(argv, 'effort')
  try {
    if (name === 'job') {
      const ctx = contextOf(repo, effort, flagOf(argv, 'execution'))
      const jobName = flagOf(argv, 'name')
      const args = JSON.parse(readFileSync(flagOf(argv, 'args-file'), 'utf8'))
      let payload
      try {
        payload = COMPUTE[jobName](ctx, args)
      } catch (err) {
        payload = fail(jobName, 'job_failed', err.message)
      }
      const out = flagOf(argv, 'out')
      writeFileSync(out + '.tmp', JSON.stringify(payload))
      renameSync(out + '.tmp', out)
      process.exit(0)
    }
    if (name === 'retry') {
      const ctx = contextOf(repo, effort, flagOf(argv, 'execution'))
      const ids = argv.filter((a, i) => argv[i - 1] === '--node')
      console.log(JSON.stringify(retryEscalated(ctx, readTree(ctx.repo, ctx.effort), ids), null, 1))
      process.exit(0)
    }
    if (name === 'note') {
      const ctx = contextOf(repo, effort, flagOf(argv, 'execution'))
      console.log(JSON.stringify(noteNode(ctx, readTree(ctx.repo, ctx.effort), flagOf(argv, 'node'), flagOf(argv, 'text')), null, 1))
      process.exit(0)
    }
    if (name === 'land') {
      let action = flagOf(argv, 'action')
      if (!action) {
        const { value } = decodeArgs(argv)
        action = value && value.action
      }
      console.log(JSON.stringify(land(repo, effort, action), null, 1))
      process.exit(0)
    }
    const { value, problem } = decodeArgs(argv)
    if (problem) {
      console.log(JSON.stringify(envelope(fail(name, problem.kind, problem.message))))
      process.exit(0)
    }
    const payload = runBoundary(name, repo, effort, flagOf(argv, 'execution'), value || {})
    console.log(JSON.stringify(envelope(payload)))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
