// lib/boundaries/execution.mjs — an execution's own boundaries, run in-process: preflight (the
// envelope and the session's commands as gotchas, checkpoints confirmed by seq, a moved base,
// cleanup, the dispatches a dead run left open), schedule (what to launch, and what a tick records
// about it) and postflight (the summary and `closed`).
//
// Design: docs/DESIGN.md#boundaries.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { guidanceOf } from '../brief.mjs'
import { staleBrief } from '../briefs/execute.mjs'
import { COMMAND_NAMES, commandsOf, writeGotcha } from '../gotchas.mjs'
import { changedFiles, contains, detach, effortBase, worktrees } from '../integration.mjs'
import { readLog } from '../ledger.mjs'
import { holderReader, maxParallel, releaseSlots } from '../locks.mjs'
import { approvedHead, resumeLeaves } from '../resume.mjs'
import { schedule as ready, summarize } from '../schedule.mjs'
import {
  ROOT_ID, STAMP, ancestorsOf, branchExists, branchOf, executionsRoot, git, inLocus, isAncestorOrSelf, posix, readConfig,
  readJson, revParse, specPath, stalePath, worktreeOf, worktreeOfBranch, writeWhole,
} from '../store.mjs'
import { trace } from '../traceability.mjs'
import { ownReview, ownerOf, readTree, subtreeOf } from '../tree.mjs'
import { approved, heldOf, parked, recordAll, rulingAnswered } from './records.mjs'

const list = (v) => (Array.isArray(v) ? v : [])
const seqOf = (e) => (e && Number.isInteger(e.seq) ? e.seq : -1)
const latest = (entries, pred) => entries.reduce((found, e) => (pred(e) && (!found || e.seq > found.seq) ? e : found), null)
const refuse = (kind, message, extra = {}) => ({ ok: false, error: { kind, message }, ...extra })

/** This execution's state log, read from disk: a session CLI's writes count too. */
const stateOf = (xc) => readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries

// ------------------------------------------------------------------ preflight

/** Executions of this effort that never closed, other than this one, oldest first. */
export function openExecutions(xc) {
  let stamps = []
  try {
    stamps = readdirSync(executionsRoot(xc.repo, xc.effort))
  } catch {
    return []
  }
  const out = []
  for (const stamp of stamps.sort()) {
    if (stamp === xc.execution || !STAMP.test(stamp)) continue
    const env = readJson(join(executionsRoot(xc.repo, xc.effort), stamp, 'execution.json'))
    if (!env) continue
    const closed = readLog(xc.repo, xc.effort, 'state:' + stamp).entries.some((e) => e.kind === 'closed')
    if (!closed) out.push({ stamp, root: env.root || ROOT_ID })
  }
  return out
}

/** The envelope a first preflight writes: the base it is cut from, the dial, the pace, the commands the session wrote. */
function envelopeFor(xc, { root, dial, pace, base_ref, commands_file }) {
  const base_branch = base_ref || git(xc.repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  const base_sha = revParse(xc.repo, base_ref || 'HEAD')
  if (!base_sha) return refuse('no_base', 'the base ' + JSON.stringify(base_ref || 'HEAD') + ' names no commit')
  const commands = commands_file ? readJson(commands_file) : null
  if (commands_file && !commands) return refuse('commands_unreadable', 'the commands file ' + commands_file + ' cannot be read as JSON')
  return { ok: true, envelope: { stamp: xc.execution, root, base_branch, base_sha, dial: dial || 'normal', pace: pace || 'balanced', commands } }
}

/**
 * Write each command the envelope names, and each its `absent` map marks `true`, as a `command`
 * gotcha from the session, so the command gotchas are the one source of the established commands.
 * A command marked absent is written absent even when a value is given too (a measurement runs no
 * command declared absent); `test_one` has no absent. A command `commandsOf` already names (an
 * investigator's, or this session's from an earlier run) stands; an empty one writes nothing.
 * Returns the commands the store refused, `[{name, error}]`, empty when every one was written.
 * `write` has `writeGotcha`'s shape: `(repo, effort, gotcha, {observed_at, source}) → {ok, error?}`.
 */
export function writeSessionCommands(xc, env, { write = writeGotcha } = {}) {
  const given = env.commands && typeof env.commands === 'object' ? env.commands : {}
  const marked = given.absent && typeof given.absent === 'object' ? given.absent : {}
  const known = commandsOf(xc.repo, xc.effort)
  const refused = []
  for (const name of COMMAND_NAMES) {
    if (known[name] || known.absent[name] === true) continue
    const absent = name in known.absent && marked[name] === true
    const value = !absent && typeof given[name] === 'string' ? given[name].trim() : ''
    if (!absent && !value) continue
    const out = write(xc.repo, xc.effort, {
      kind: 'command', roles: ['implementer', 'investigator'], paths: [],
      trigger: 'running the ' + name + ' command',
      action: absent ? 'there is no ' + name + ' command: do not look for one' : 'run `' + value + '`',
      evidence: { command: value || name, output: (absent ? 'declared absent' : 'named') + ' by the session for execution ' + xc.execution },
      command: { name, value, absent },
    }, { observed_at: env.base_sha, source: { role: 'session' } })
    if (!out.ok) refused.push({ name, error: String(out.error) })
  }
  return refused
}

/** The checkpoints the user may confirm past; `parked` is proceeded from by launching without `plan_only`. */
const CONFIRMABLE = ['existing_execution', 'blocking_gaps']

/** Pure. The checkpoint reasons the user confirmed: each `checkpoint-confirmed` confirms the checkpoint line just before it. */
function passedOf(state) {
  const passed = new Set()
  for (const c of state.filter((e) => e.kind === 'checkpoint-confirmed')) {
    const line = latest(state, (e) => e.kind === 'checkpoint' && e.seq < c.seq)
    if (line) passed.add(line.reason)
  }
  return passed
}

/** Record the user's word on the latest checkpoint line when `confirmed` is its seq, once; the state as it now stands. */
function confirm(xc, state, confirmed) {
  const line = latest(state, (e) => e.kind === 'checkpoint')
  if (!line || line.seq !== confirmed || !CONFIRMABLE.includes(line.reason)) return state
  if (state.some((e) => e.kind === 'checkpoint-confirmed' && e.seq > line.seq)) return state
  xc.log.append('checkpoint-confirmed', line.reason === 'blocking_gaps' ? { gaps: list(line.gaps) } : {})
  return stateOf(xc)
}

/** Pure. The first checkpoint the execution stops at, with the lists it found, or null. */
function checkpointFor({ overlapping, gaps, plan_only }, passed) {
  if (overlapping.length && !passed.has('existing_execution')) {
    return { reason: 'existing_execution', detail: overlapping.map((e) => e.stamp + ' (root ' + e.root + ')').join(', '), executions: overlapping }
  }
  if (gaps.length && !passed.has('blocking_gaps')) {
    return { reason: 'blocking_gaps', detail: gaps.length + ' decision(s) no entry realises, or evidence a node needs was not reached', gaps }
  }
  if (plan_only) return { reason: 'parked', detail: 'plan_only: the plan is on disk and nothing was dispatched' }
  return null
}

/** The seq of the checkpoint's line: the one this run already wrote for the same reason, else a new one. */
function checkpointLine(xc, state, checkpoint) {
  const line = latest(state, (e) => e.kind === 'checkpoint')
  const since = Math.max(-1, ...state.filter((e) => ['run', 'checkpoint-confirmed', 'closed'].includes(e.kind)).map(seqOf))
  if (line && line.reason === checkpoint.reason && line.seq > since) return line.seq
  return xc.log.append('checkpoint', checkpoint).seq
}

/**
 * The leaves the base branch moved under since the head each was last ruled against, with the
 * moved files each writes and reads. A head the execution's own branch already merged is ground,
 * not a move; an affected ruling anchors only once something answered it on disk.
 */
function movedUnder(xc, tree, env, root, state) {
  const now = revParse(xc.repo, env.base_branch || 'HEAD')
  if (!now || !env.base_sha) return { now, stale: [] }
  const ground = [root, ...ancestorsOf(root)].map((id) => branchOf(xc.effort, id)).find((b) => branchExists(xc.repo, b))
  const fork = ground ? git(xc.repo, ['merge-base', ground, now]).stdout.trim() : ''
  const held = contains(xc.repo, fork, env.base_sha) ? fork : env.base_sha
  const ruledAt = new Map(state
    .filter((e) => e.kind === 'stale-ruled' && (e.ruling === 'unaffected' || rulingAnswered(e, tree)))
    .map((e) => [e.node, e.base_now]))
  const movedSince = new Map()
  const stale = []
  for (const id of subtreeOf(tree.nodes, root)) {
    const n = tree.nodes.get(id)
    // A stopped leaf is the user's already; it is looked at again once its stop clears.
    if (n.kind !== 'leaf' || ['merged', 'escalated', 'parked'].includes((tree.status.get(id) || {}).status)) continue
    const last = ruledAt.get(id) || ''
    const anchor = contains(xc.repo, last, held) && contains(xc.repo, now, last) ? last : held
    if (anchor === now) continue
    if (!movedSince.has(anchor)) movedSince.set(anchor, changedFiles(xc.repo, anchor, now))
    const moved = movedSince.get(anchor)
    const writes = moved.filter((f) => inLocus(n.locus, f))
    const reads = moved.filter((f) => inLocus(n.reads, f))
    if (writes.length || reads.length) stale.push({ node: id, anchor, writes, reads })
  }
  return { now, stale }
}

/** The ruler's brief on a moved base and its record, written beside the state log. */
function writeStale(xc, tree, now, stale) {
  const brief = stalePath(xc.repo, xc.effort, xc.execution, now)
  const record = brief.replace(/\.md$/, '.json')
  writeWhole(brief, staleBrief({
    nodes: stale.map((st) => ({ ...st, entry: tree.nodes.get(st.node) })),
    base_now: now,
    diffs: Object.fromEntries(stale.map((st) => [st.node, git(xc.repo, ['diff', st.anchor + '..' + now, '--', ...st.writes, ...st.reads]).stdout])),
    guidance: guidanceOf(xc.repo, { config: readConfig(xc.repo) }),
  }))
  writeWhole(record, { now, nodes: stale.map((st) => st.node) })
  return { nodes: stale.map((st) => st.node), now, brief, record }
}

/**
 * This plugin's leftover checkouts of the effort's branches: one away from its branch's own path
 * (git refuses a branch in two worktrees), and a merged leaf's own. A clean one is removed, its
 * branch kept; a dirty one is never forced and is reported. A checkout outside
 * `.claude/worktrees/` is the user's.
 */
function clearWorktrees(xc, tree) {
  const prefix = 'agentics/' + xc.effort
  const own = posix(join(xc.repo, '.claude', 'worktrees')) + '/'
  const nodeOf = new Map([...tree.nodes.keys()].map((id) => [branchOf(xc.effort, id), id]))
  const mergedLeaf = (id) => (tree.nodes.get(id) || {}).kind === 'leaf' && (tree.status.get(id) || {}).status === 'merged'
  const dirty = []
  for (const [path, w] of worktrees(xc.repo)) {
    if (!(w.branch === prefix || w.branch.startsWith(prefix + '--'))) continue
    if (worktreeOfBranch(xc.repo, w.branch) === path && !mergedLeaf(nodeOf.get(w.branch))) continue
    if (!path.startsWith(own)) continue
    if (detach(xc.repo, path) === 'dirty') dirty.push(path)
  }
  git(xc.repo, ['worktree', 'prune'])
  return dirty
}

/** Pure. Each dispatch whose latest `dispatched` has no `returned` and no `host_stop` after it, in seq order. */
function openDispatches(entries) {
  const started = new Map()
  for (const e of entries) if (e.kind === 'dispatched' && seqOf(e) > seqOf(started.get(e.dispatch))) started.set(e.dispatch, e)
  return [...started.values()]
    .filter((d) => !entries.some((e) => (e.kind === 'returned' || e.kind === 'host_stop') && e.dispatch === d.dispatch && e.seq > d.seq))
    .sort((a, b) => a.seq - b.seq)
    .map((d) => ({ dispatch: d.dispatch, node: d.node, thread: d.thread, role: d.role, round: d.round }))
}

/**
 * Open the execution's run: refuse what cannot run, adopt or write the envelope, write the
 * session's commands as gotchas, refusing `commands_unwritable` when the store refuses one, stop at a checkpoint the user has not confirmed past, brief the
 * ruler on a moved base, free this execution's slots and leftover worktrees, and name the
 * dispatches a dead run left open.
 *
 * @param {object} xc `executionContext`
 * @param {{folder?: string, confirmed?: number, plan_only?: boolean, dial?: string, pace?: string,
 *   base_ref?: string, commands_file?: string, write?: function}} args `confirmed` is a checkpoint line's seq;
 *   `write` is `writeSessionCommands`' port
 */
export function preflight(xc, { folder = ROOT_ID, confirmed = 0, plan_only = false, dial, pace, base_ref, commands_file, write = writeGotcha } = {}) {
  const tree = readTree(xc.repo, xc.effort)
  if (tree.error) return refuse('unreadable', 'the effort ' + JSON.stringify(xc.effort) + ' cannot be read: ' + tree.error)
  const root = typeof folder === 'string' && folder ? folder : ROOT_ID
  if (!tree.nodes.has(root)) return refuse('no_such_node', 'the effort holds no node ' + JSON.stringify(root))
  if (root === ROOT_ID && tree.nodes.get(root).kind === 'leaf') return refuse('root_is_leaf', 'the effort root is a leaf: run it as a task')

  let env = xc.envelope()
  const resumed = Boolean(env)
  if (env && env.root !== root) return refuse('wrong_root', 'execution ' + xc.execution + ' runs ' + env.root + ', not ' + root)
  if (!env) {
    const made = envelopeFor(xc, { root, dial, pace, base_ref, commands_file })
    if (!made.ok) return made
    env = made.envelope
    writeWhole(join(xc.dir, 'execution.json'), env)
  }
  const unwritten = writeSessionCommands(xc, env, { write })
  if (unwritten.length) {
    return refuse('commands_unwritable', "the session's commands could not be written as gotchas: " +
      unwritten.map((u) => u.name + ': ' + u.error).join('; '))
  }

  const { gaps, untraced } = trace(tree.nodes, root)
  const overlapping = openExecutions(xc).filter((e) => isAncestorOrSelf(e.root, root) || isAncestorOrSelf(root, e.root))
  const state = confirm(xc, stateOf(xc), confirmed)
  const found = checkpointFor({ overlapping, gaps, plan_only }, passedOf(state))
  const checkpoint = found ? { reason: found.reason, detail: found.detail, seq: checkpointLine(xc, state, found) } : null

  let stale = null
  if (resumed && !checkpoint) {
    const moved = movedUnder(xc, tree, env, root, state)
    if (moved.stale.length) stale = writeStale(xc, tree, moved.now, moved.stale)
  }

  releaseSlots(xc.repo, { effort: xc.effort, execution: xc.execution })
  const dirty = clearWorktrees(xc, tree)
  const ids = subtreeOf(tree.nodes, root)
  return {
    ok: true, error: null, checkpoint, stale,
    counts: { nodes: ids.length, leaves: ids.filter((id) => tree.nodes.get(id).kind === 'leaf').length, gaps: gaps.length, untraced: untraced.length },
    dirty_worktrees: dirty,
    open_dispatches: openDispatches(xc.log.entries()),
    max_parallel: maxParallel(xc.repo),
  }
}

// ------------------------------------------------------------------ schedule

/** Where a composite's work integrates: its branch, worktree, head and the base it was cut from; null with no branch. */
function integrationOf(xc, tree, node) {
  // A group has no branch: its work integrates in its folder's.
  const id = (tree.nodes.get(node) || {}).kind === 'group' ? ownerOf(tree.nodes, node) : node
  const branch = branchOf(xc.effort, id)
  if (!branchExists(xc.repo, branch)) return null
  const head = revParse(xc.repo, 'refs/heads/' + branch)
  let base = ''
  if (id === ROOT_ID) base = effortBase(xc.repo, xc.effort).base_sha
  else {
    const mb = git(xc.repo, ['merge-base', branch, branchOf(xc.effort, ownerOf(tree.nodes, id))])
    base = mb.ok ? mb.stdout.trim() : ''
  }
  return { branch, worktree: worktreeOf(xc.repo, xc.effort, id), head, base }
}

/** What `lib/schedule.mjs` reads, bound to this execution's disk. */
function scheduleInput(xc, tree, env, { running = [], planning = [], stopping = false } = {}) {
  const integrations = new Map()
  const holder = holderReader(xc.repo)
  return {
    nodes: tree.nodes, status: tree.status, events: tree.events, root: env.root || ROOT_ID,
    running: list(running), planning: list(planning), held: [...heldOf(stateOf(xc))], stopping: stopping === true,
    maxParallel: maxParallel(xc.repo),
    integrationOf: (id) => {
      if (!integrations.has(id)) integrations.set(id, integrationOf(xc, tree, id))
      return integrations.get(id)
    },
    lockedBy: (id) => holder({ effort: xc.effort, node: id, locus: tree.nodes.get(id).locus }),
    approvedHead: (id) => approvedHead(tree.events, id),
  }
}

/** The resume ladder's word on the named leaves only: it reads git per leaf, so never the whole tree. */
function ladderOf(xc, tree, ids) {
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
    if (!ownerHeads.has(owner)) ownerHeads.set(owner, revParse(xc.repo, 'refs/heads/' + branchOf(xc.effort, owner)))
    parentHeads[id] = ownerHeads.get(owner)
  }
  return new Map(resumeLeaves(xc.repo, xc.effort, xc.execution, wanted, parentHeads)
    .filter((l) => ids.includes(l.id)).map((l) => [l.id, l]))
}

/**
 * Pure. What a tick records about what it launches: a folder the user writes that has nothing
 * planned beneath it is theirs to design, never the planner's; a leaf the ladder finds measured
 * green, with no review loop of its own and no approval standing, is approved at that head.
 */
function launchRecords(launch, { nodes, events }, ladder, specOf) {
  const out = []
  for (const l of launch) {
    const n = nodes.get(l.id)
    if (l.unit === 'plan' && n.kind !== 'leaf' && n.author !== 'planner' && l.why !== 'spec_changed') {
      out.push(parked(l.id, 'needs_design', n.kind === 'design'
        ? 'sub-effort ' + l.id + ' has no approved spec: run the design skill on it'
        : 'folder ' + l.id + ' plans nothing: its spec ' + specOf(l.id) + ' needs a Plan'))
    }
    const f = l.unit === 'leaf' ? ladder.get(l.id) : null
    if (f && f.next_action === 'merge' && !ownReview(n) && !approvedHead(events, l.id)) out.push(approved(l.id, f.head_sha, 0, true))
  }
  return out
}

/**
 * What to launch now, from the records: `lib/schedule.mjs` over this execution's disk, given what
 * the program has in flight. What a tick decides about its launches is recorded first, and the
 * launches computed again over it, until a pass records nothing: a parked folder launches
 * nowhere, an approved leaf goes to its merge.
 *
 * @param {object} xc `executionContext`
 * @param {{running?: string[], planning?: string[], stopping?: boolean}} inFlight `running` as
 *   `<unit>:<id>`, `planning` the folders a running unit replans
 */
export function schedule(xc, { running = [], planning = [], stopping = false } = {}) {
  const env = xc.envelope()
  if (!env) return refuse('no_execution', 'execution ' + xc.execution + ' has no envelope: preflight writes it', { launch: [], idle: false, stops: [] })
  const stops = []
  for (;;) {
    const tree = readTree(xc.repo, xc.effort)
    if (tree.error) return refuse('unreadable', 'the effort ' + JSON.stringify(xc.effort) + ' cannot be read: ' + tree.error, { launch: [], idle: false, stops })
    const { launch, idle } = ready(scheduleInput(xc, tree, env, { running, planning, stopping }))
    const ladder = ladderOf(xc, tree, launch.filter((l) => l.unit === 'leaf').map((l) => l.id))
    const records = launchRecords(launch, tree, ladder, (id) => posix(specPath(xc.repo, xc.effort, id)))
    const out = recordAll(xc, records)
    stops.push(...out.stops)
    if (out.recorded.length === 0) {
      const designed = new Set(records.filter((r) => r.kind === 'parked').map((r) => r.fields.node))
      return { ok: true, error: null, launch: launch.filter((l) => !designed.has(l.id)), idle, stops }
    }
  }
}

// ------------------------------------------------------------------ postflight

/**
 * Close the run: free this execution's slots, summarize its subtree from the records, append
 * `closed {status: done}` once every leaf in scope merged, and count the branches cleanup may take.
 * The run's `ended` is `lib/run.mjs`'s.
 *
 * @param {object} xc `executionContext`
 */
export function postflight(xc) {
  releaseSlots(xc.repo, { effort: xc.effort, execution: xc.execution })
  const tree = readTree(xc.repo, xc.effort)
  if (tree.error) return refuse('unreadable', 'the effort ' + JSON.stringify(xc.effort) + ' cannot be read: ' + tree.error, { stops: [] })
  const env = xc.envelope() || { root: ROOT_ID }
  const root = env.root || ROOT_ID
  const input = scheduleInput(xc, tree, env)
  const summary = summarize(input)
  let cleanup = 0
  let unmerged = 0
  for (const id of subtreeOf(tree.nodes, root)) {
    if (id === ROOT_ID || !branchExists(xc.repo, branchOf(xc.effort, id))) continue
    if ((tree.status.get(id) || {}).status === 'merged') cleanup++
    else unmerged++
  }
  if (summary.done && !stateOf(xc).some((e) => e.kind === 'closed')) xc.log.append('closed', { status: 'done' })
  const where = input.integrationOf(root) || {}
  return {
    ok: true, error: null, summary,
    integration: { branch: where.branch || '', head_sha: where.head || '' },
    cleanup_n: cleanup, unmerged_n: unmerged, closed: summary.done, stops: [],
  }
}
