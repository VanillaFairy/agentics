// lib/programs/execute.mjs — the execute program: one execution of an effort's subtree, run in its
// own home, from preflight through a tick loop that runs the execution's units as promises — a
// leaf's rounds, a planner's folder, merges, integration reviews, rulers — to postflight and the
// result.
//
// Design: docs/DESIGN.md#execution.

import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { pausedAt, postflight, preflight, schedule } from '../boundaries/execution.mjs'
import { executionContext, faultRecords, parked, recordAll } from '../boundaries/records.mjs'
import { lastMinted, readLog } from '../ledger.mjs'
import { releaseSlots } from '../locks.mjs'
import { costOf } from '../run.mjs'
import { ROOT_ID, STAMP, executionDir, executionRunId, executionsRoot, mkdirState, readJson, runJsonPath, sameBlob, stampNow } from '../store.mjs'
import { cycleOf, ownerOf, readTree } from '../tree.mjs'
import { netsAt } from '../verdict.mjs'
import { coverageOf } from './common.mjs'
import { planFolder } from './execute/folder.mjs'
import { mergeUnit, reviewUnit, ruleUnit } from './execute/integrate.mjs'
import { runLeaf } from './execute/leaf.mjs'

export const ARGS = {
  effort: { kind: 'effort', required: true },
  folder: { kind: 'folder', default: ROOT_ID },
  intelligence: { kind: 'enum', values: ['low', 'normal', 'max'], default: 'normal' },
  pace: { kind: 'enum', values: ['frugal', 'balanced', 'fast'], default: 'balanced' },
  plan_only: { kind: 'bool' },
  pause: { kind: 'bool' },
  budget: { kind: 'int' },
  confirmed: { kind: 'int' },
  base_ref: { kind: 'token' },
  commands_file: { kind: 'file' },
}

/** Pure. An execution is claimed for its effort and the folder it runs. */
export const scopeOf = (args) => ({ effort: args.effort, folder: args.folder })

/** How long the tick loop waits before it asks again for a slot or a lock it found taken, when nothing else runs. */
const SLOT_WAIT_MS = 2000

const list = (v) => (Array.isArray(v) ? v : [])
const messageOf = (err) => (err && err.message ? err.message : String(err))
const seqOf = (e) => (e && Number.isInteger(e.seq) ? e.seq : -1)
/** The merge messages that ask an approved leaf for a round of its own. */
const OWED = new Set(['rebase', 'failures'])

/**
 * Pure. The approved leaves a merge sent a `rebase` or `failures` message for a round no dispatch has
 * opened yet. A cycle member other than its tip is never one: a cycle merges through its tip, so
 * what a merge sent a member alone is no round it owes.
 */
export function owedRounds({ nodes, status, events }) {
  const latest = new Map()
  for (const e of events) if (e.kind === 'dispatched' && Number.isInteger(e.round)) latest.set(e.node, Math.max(latest.get(e.node) || 0, e.round))
  const tipOrSingle = (id) => {
    const cycle = cycleOf(nodes, id)
    return cycle.length === 0 || cycle[cycle.length - 1] === id
  }
  return [...nodes.keys()].filter((id) => (status.get(id) || {}).status === 'approved' && tipOrSingle(id) &&
    events.some((e) => e.kind === 'message' && e.node === id && OWED.has(e.msg) && e.round > (latest.get(id) || 0)))
}

/** What a tick launches. */
const UNITS = { planFolder, runLeaf, mergeUnit, reviewUnit }
/** One turn of the event loop: timers and I/O callbacks (the heartbeat, a child's spawn and exit) run before the loop goes on. */
const nextTurn = () => new Promise((go) => setImmediate(go))

/**
 * The executions of `effort` on disk, oldest first: the folder each runs, from its envelope, or
 * from its run.json while a start cut before preflight left nothing else, and whether it closed.
 */
function executionsOf(repo, effort) {
  let stamps = []
  try {
    stamps = readdirSync(executionsRoot(repo, effort)).filter((s) => STAMP.test(s)).sort()
  } catch {
    return []
  }
  return stamps.map((stamp) => {
    const env = readJson(join(executionDir(repo, effort, stamp), 'execution.json'))
    const meta = readJson(runJsonPath(repo, executionRunId(effort, stamp)))
    const claimed = meta && meta.program === 'execute' && meta.scope ? meta.scope.folder || ROOT_ID : ''
    const closed = readLog(repo, effort, 'state:' + stamp).entries.some((e) => e.kind === 'closed')
    return { stamp, root: env ? env.root || ROOT_ID : claimed, closed }
  })
}

/**
 * The run's home (`lib/run.mjs` asks under the claim lock): the open execution of the effort on
 * this folder, else a new stamp minted from `now` (`-2`, `-3`… when taken), taken by making its
 * directory.
 */
export function homeOf(args, { repo, now }) {
  const open = executionsOf(repo, args.effort).filter((e) => !e.closed && e.root === args.folder)
  if (open.length) return { run: executionRunId(args.effort, open[open.length - 1].stamp) }
  mkdirState(executionsRoot(repo, args.effort))
  const base = stampNow(now)
  for (let n = 1; ; n++) {
    const stamp = n === 1 ? base : base + '-' + n
    try {
      mkdirSync(executionDir(repo, args.effort, stamp))
      return { run: executionRunId(args.effort, stamp) }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
}

/** This execution's state lines, read from disk: a session CLI's writes count too. */
const stateOf = (xc) => readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries

/** Record a fault on `node` (and the `contract_drift` park it may owe). */
function fault(xc, node, channel, detail) {
  const tree = readTree(xc.repo, xc.effort)
  recordAll(xc, faultRecords(node, channel, detail, { nodes: tree.nodes, events: tree.events, state: stateOf(xc) }))
}

/** The nodes a fault of this run holds. */
function heldNow(xc) {
  const state = stateOf(xc)
  const since = Math.max(-1, ...state.filter((e) => e.kind === 'run').map(seqOf))
  return new Set(state.filter((e) => e.kind === 'fault' && seqOf(e) > since).map((e) => e.node))
}

/**
 * Whether the token target cannot cover another leaf: nothing left of it, or less left than the
 * execution's measured tokens per merged leaf, over every run of the execution.
 */
function overBudget(xc, budget, tree) {
  if (!(Number.isInteger(budget) && budget > 0)) return false
  const entries = xc.log.entries()
  const { tokens } = costOf(entries)
  const merged = new Set(entries.filter((e) => e.kind === 'merged' && (tree.nodes.get(e.node) || {}).kind === 'leaf').map((e) => e.node)).size
  const left = budget - tokens
  return left <= 0 || (merged > 0 && left < tokens / merged)
}

/**
 * The tick loop: what `schedule` launches runs as a unit promise, and the loop waits for the first
 * to settle before it asks again, until nothing runs and nothing is ready. A unit records its own
 * faults; one that still rejects is a `program` fault on its node. A unit that settled with nothing
 * recorded by anyone while it ran would settle the same way on the same records: it is not launched
 * again until something is recorded. Every pass gives the event loop a turn. What only this loop
 * holds — the units in flight, the folders being planned, the leaves waiting on a planner or a slot,
 * the units that settled idle — lives in memory and is rebuilt from the records by the next run.
 * `units` are the functions the ticks launch; a test hands its own.
 */
export async function runUnits(ctx, xc, args, pre, seen, units = UNITS) {
  // The envelope's dial, never the relaunch's argument: a resumed execution keeps the dial it started with.
  const intelligence = xc.envelope().dial
  const running = new Map()
  const planning = new Set()
  const queued = new Map()
  // A round a merge sent an approved leaf (a rebase, its integration failures) that no run has opened
  // yet is still owed: a relaunch takes it up, rather than merging the head that round must change.
  const fixing = new Set(owedRounds(readTree(xc.repo, xc.effort)))
  const awaiting = new Map()
  const deferred = new Set()
  const idle = new Map()
  const note = (text) => seen.notes.push(text)
  const minted = () => lastMinted(xc.repo, xc.effort)

  const launch = (key, node, fn, job = null) => {
    const at = minted()
    running.set(key, Promise.resolve().then(fn).catch((err) => {
      note(key + ' threw: ' + messageOf(err))
      fault(xc, node, 'program', 'the unit ' + key + ' threw: ' + messageOf(err))
      return { outcome: 'faulted' }
    }).then((out) => ({ key, out, job, at })))
  }

  /** The next request waiting on a folder's planner, launched once no plan of that folder runs. */
  const planNext = (folder) => {
    if (running.has('plan:' + folder)) return
    const waiting = queued.get(folder) || []
    if (waiting.length === 0) return
    const request = waiting.shift()
    planning.add(folder)
    launch('plan:' + folder, folder, () => units.planFolder(ctx, xc, { folder, intelligence, request }), request)
  }

  /**
   * A node a ruler ruled affected: the planner of a folder it wrote replans it, with the ruler's
   * question as a `premise_mismatch`; a leaf whose folder the user wrote parks `needs_respec` with
   * that question. A replanned leaf runs again only once its plan revised it.
   */
  const replan = ({ id, question }) => {
    const tree = readTree(xc.repo, xc.effort)
    const node = tree.nodes.get(id)
    if (!node) return
    const folder = node.kind === 'leaf' ? ownerOf(tree.nodes, id) : id
    const ruled = stateOf(xc).filter((e) => (e.kind === 'drift-ruled' || e.kind === 'stale-ruled') && e.node === id).pop()
    const said = (ruled && ruled.said) || ''
    if ((tree.nodes.get(folder) || {}).author !== 'planner') {
      recordAll(xc, [parked(id, 'needs_respec', question, said)])
      return
    }
    if (node.kind === 'leaf') awaiting.set(id, node.seq || 0)
    note(id + ': ruled affected — its planner replans it')
    queued.set(folder, [...(queued.get(folder) || []), { node: id, status: 'premise_mismatch', text: question, paths: [] }])
    planNext(folder)
  }

  const launchLeaf = (id) => launch('leaf:' + id, id, () => units.runLeaf(ctx, xc, { id, intelligence }))

  /** What a settled unit tells the loop. */
  const settle = (key, out, job) => {
    const at = key.indexOf(':')
    const unit = key.slice(0, at)
    const id = key.slice(at + 1)
    if (unit === 'leaf') {
      if (out.outcome === 'requeue') {
        deferred.add(id)
        return
      }
      fixing.delete(id)
      seen.leaves.set(id, out)
      if (out.outcome === 'route' && out.route) {
        awaiting.set(id, (readTree(xc.repo, xc.effort).nodes.get(id) || {}).seq || 0)
        releaseSlots(xc.repo, { effort: xc.effort, execution: xc.execution, node: id })
        note(id + ': ' + out.route.request.status + ' — the planner of ' + out.route.folder + ' answers it')
        queued.set(out.route.folder, [...(queued.get(out.route.folder) || []), out.route.request])
        planNext(out.route.folder)
      }
      return
    }
    if (unit === 'plan') {
      planning.delete(id)
      if (out.survey && out.survey.complete === false) {
        seen.surveysLost.push(id)
        note('the survey of ' + id + ' is incomplete')
      }
      if (out.survey && out.survey.invalidated.length > 0) {
        note('the survey of ' + id + ' found inherited evidence no longer holds: ' + out.survey.invalidated.join(', '))
      }
      if (job && out.outcome === 'faulted') fault(xc, job.node, 'program', 'its replan in ' + id + ' ended on a fault')
      planNext(id)
      return
    }
    if (unit === 'merge') {
      for (const d of list(out.drift)) {
        if (d.standing) {
          note(d.node + ' consumes ' + d.contract + ', which merged work touched as it stood when ruled unaffected (#' + d.standing + '): not ruled again')
          continue
        }
        if (!seen.drift.some((x) => x.node === d.node && x.contract === d.contract)) seen.drift.push({ node: d.node, contract: d.contract })
        if (d.stopped) note(d.node + ' (' + d.stopped + ') consumes ' + d.contract + ', which merged work touched')
      }
      for (const f of list(out.failed_alone)) {
        fixing.add(f.id)
        note(f.id + ': fails on the integration head alone — a fix round on its branch')
      }
      for (const r of list(out.rebase)) {
        fixing.add(r.id)
        note(r.id + ': its merge conflicted and the judge ruled it resolvable — a rebase round on its branch')
      }
      if (out.unexamined_n) note(out.unexamined_n + ' undesigned node(s) not examined for drift')
      for (const r of list(out.replan)) replan(r)
      if (args.pause && !seen.stopped) seen.stopped = 'pause'
      return
    }
    if (unit === 'review') {
      if (out.outcome === 'reviewed') seen.reviews.push({ target: id, said: out.said })
      if (out.outcome === 'lost') {
        seen.reviewsLost.push(id)
        note('the integration review of ' + id + ' was lost')
      }
    }
  }

  if (pre.stale) {
    note('the base moved under ' + pre.stale.nodes.join(', ') + ': ruled before anything runs')
    try {
      const ruled = await ruleUnit(ctx, xc, { kind: 'stale', record: pre.stale.record, brief: pre.stale.brief, intelligence, running: [] })
      for (const r of ruled.replan) replan(r)
    } catch (err) {
      note('the ruler on the moved base threw: ' + messageOf(err))
      for (const id of pre.stale.nodes) fault(xc, id, 'program', 'the ruler on the moved base threw: ' + messageOf(err))
    }
  }

  if (pre.adopted && pre.adopted.error) note(pre.adopted.error + ': that work is not ruled on until it can be read')
  else if (pre.adopted) {
    note("work adopted on the user's word touched what " + pre.adopted.nodes.join(', ') + ' consume: ruled before anything runs')
    try {
      const ruled = await ruleUnit(ctx, xc, { kind: 'adopted', record: pre.adopted.record, brief: pre.adopted.brief, intelligence, running: [] })
      for (const r of ruled.replan) replan(r)
    } catch (err) {
      note('the ruler on adopted work threw: ' + messageOf(err))
      for (const id of pre.adopted.nodes) fault(xc, id, 'program', 'the ruler on adopted work threw: ' + messageOf(err))
    }
  }

  for (;;) {
    const tree = readTree(xc.repo, xc.effort)
    if (!seen.stopped && overBudget(xc, args.budget, tree)) seen.stopped = 'budget'
    // The session's pause starts nothing at all, a merge included, while what runs finishes; a
    // resume before the run ends lets it go on.
    const paused = pausedAt(tree.events, xc.execution)
    if (paused && paused !== seen.paused) note('paused by the session (#' + paused + '): what runs finishes, nothing new starts')
    if (!paused && seen.paused) note('resumed by the session')
    seen.paused = paused
    const stopping = Boolean(seen.stopped) || paused > 0
    const tick = schedule(xc, { running: [...running.keys()], planning: [...planning], stopping })
    if (!tick.ok) {
      note('the schedule refused: ' + tick.error.kind + ': ' + tick.error.message + ' — nothing new starts')
      seen.failed.push('schedule')
      while (running.size) {
        const { key, out, job } = await Promise.race(running.values())
        running.delete(key)
        settle(key, out, job)
      }
      return
    }
    const held = heldNow(xc)
    const merging = [...running.keys()].some((k) => k.startsWith('merge:'))
    const now = minted()
    for (const item of paused ? [] : tick.launch) {
      const id = item.unit === 'merge' ? item.target : item.id
      const key = item.unit + ':' + id
      if (running.has(key)) continue
      if (idle.has(key) && idle.get(key) === now) continue
      idle.delete(key)
      if (item.unit === 'leaf') {
        const node = tree.nodes.get(id) || {}
        if (deferred.has(id) || fixing.has(id)) continue
        if (awaiting.has(id) && awaiting.get(id) === (node.seq || 0)) continue
        awaiting.delete(id)
        // A consumer's drift is known only once the merge running now has been ruled on.
        if (merging && list(node.consumes).length) continue
        launchLeaf(id)
      } else if (item.unit === 'plan') {
        planning.add(id)
        launch(key, id, () => units.planFolder(ctx, xc, { folder: id, intelligence, request: null, why: item.why || '' }))
      } else if (item.unit === 'merge') {
        const children = list(item.children).filter((c) => !fixing.has(c.id) && !held.has(c.id))
        if (held.has(id) || children.length === 0) continue
        launch(key, id, () => units.mergeUnit(ctx, xc, { target: id, children, cycles: list(item.cycles), intelligence, running: [...running.keys()] }))
      } else if (item.unit === 'review') {
        if (held.has(id)) continue
        launch(key, id, () => units.reviewUnit(ctx, xc, { id, where: item.where, unreviewed: list(item.unreviewed), intelligence }))
      }
    }
    if (!stopping) for (const id of fixing) if (!running.has('leaf:' + id) && !deferred.has(id) && !held.has(id)) launchLeaf(id)
    if (running.size === 0) {
      if (deferred.size === 0 || stopping) return
      await ctx.sleep(SLOT_WAIT_MS)
      deferred.clear()
      continue
    }
    const { key, out, job, at } = await Promise.race(running.values())
    running.delete(key)
    deferred.clear()
    if (out.outcome !== 'requeue' && minted() === at) {
      if (!idle.has(key)) note(key + ' settled with nothing recorded: it is not launched again until something is')
      idle.set(key, at)
    }
    settle(key, out, job)
    await nextTurn()
  }
}

/**
 * Run one execution of `args.folder` (`ctx` from `lib/run.mjs`, whose home is the execution's):
 * preflight, the tick loop unless a checkpoint stops it, postflight, the result.
 *
 * @param {object} ctx the run's context: `log` the execution's port, `execution` its stamp
 * @param {{effort: string, folder: string, intelligence: string, pace: string, plan_only: boolean,
 *   pause: boolean, budget: number, confirmed: number, base_ref: string, commands_file: string}} args
 */
export async function execute(ctx, args) {
  const xc = executionContext({ repo: ctx.repo, effort: args.effort, execution: ctx.execution, log: ctx.log })
  const seen = { notes: [], leaves: new Map(), reviews: [], reviewsLost: [], surveysLost: [], drift: [], failed: [], stopped: '', paused: 0 }
  const pre = preflight(xc, {
    folder: args.folder, confirmed: args.confirmed || 0, plan_only: args.plan_only === true, dial: args.intelligence, pace: args.pace,
    base_ref: args.base_ref || '', commands_file: args.commands_file || '',
  })
  if (!pre.ok) {
    seen.notes.push('preflight refused: ' + pre.error.kind + ': ' + pre.error.message)
    return resultOf(ctx, xc, args, seen, { refused: pre.error })
  }
  for (const path of pre.dirty_worktrees) seen.notes.push('dirty worktree left in place (never forced): ' + path)
  if (pre.counts.gaps) seen.notes.push(pre.counts.gaps + ' traceability gap(s): lib/status.mjs checkpoint lists them')
  if (pre.counts.untraced) seen.notes.push(pre.counts.untraced + ' criterion/criteria tracing to no decision')
  if (list(ctx.closed).length) seen.notes.push(list(ctx.closed).length + ' dispatch(es) a dead run left open, closed cut off: a unit that asks for one again resumes it in its session')
  if (pre.checkpoint) {
    seen.notes.push('checkpoint ' + pre.checkpoint.reason + ' (seq ' + pre.checkpoint.seq + '): ' + pre.checkpoint.detail)
  } else {
    await runUnits(ctx, xc, args, pre, seen)
  }
  if (seen.paused && !seen.stopped) seen.stopped = 'pause'
  if (seen.paused) seen.notes.push('paused by the session (#' + seen.paused + '): boundary.mjs resume lets it go on')
  else if (seen.stopped) seen.notes.push('stopped starting new leaves after a merge-batch: ' + seen.stopped)
  return resultOf(ctx, xc, args, seen, { checkpoint: pre.checkpoint, post: postflight(xc) })
}

const NO_SUMMARY = { nodes_n: 0, leaves_n: 0, merged_n: 0, not_merged_n: 0, blocked: [], root_status: '', root_done: false, stopped: [], held: [] }

/**
 * The result, from the records as postflight summarized them and what this run was told: every
 * stopped node in scope (carried from an earlier run or not) with the dispatch whose return holds
 * its words, this run's faults and approvals, the integration and its reviews, and the coverage
 * block, complete only with no checkpoint, every leaf merged, the root integrated, nothing stopped
 * or held, and no integration review or survey lost.
 */
function resultOf(ctx, xc, args, seen, { checkpoint = null, post = null, refused = null }) {
  const tree = readTree(xc.repo, xc.effort)
  const s = post && post.ok ? post.summary : NO_SUMMARY
  const state = stateOf(xc)
  const since = Math.max(-1, ...state.filter((e) => e.kind === 'run').map(seqOf))
  const lastOf = (id) => (tree.status.get(id) || {}).last || {}
  const escalations = s.stopped.filter((x) => x.status === 'escalated').map((x) => ({ id: x.id, reason: x.reason, said: lastOf(x.id).said || '' }))
  const parks = s.stopped.filter((x) => x.status === 'parked').map((x) => ({ id: x.id, return: x.reason, said: lastOf(x.id).said || '' }))
  const faults = []
  for (const e of state) {
    if (e.kind !== 'fault' || seqOf(e) <= since || !e.node) continue
    if (!faults.some((f) => f.id === e.node && f.channel === e.channel)) faults.push({ id: e.node, channel: e.channel })
  }
  const approvals = new Map()
  for (const e of xc.log.entries()) if (e.kind === 'approved' && seqOf(e) > since && (tree.nodes.get(e.node) || {}).kind === 'leaf') approvals.set(e.node, e)
  const implemented = [...approvals.values()]
    .filter((e) => !['escalated', 'parked'].includes((tree.status.get(e.node) || {}).status))
    .map((e) => {
      const node = tree.nodes.get(e.node)
      const ran = seen.leaves.get(e.node)
      const ruled = netsAt(tree.events, e.node, e.head_sha, (a, b, file) => sameBlob(xc.repo, a, b, file))
      return {
        id: e.node, rigor: node.rigor || '', role: node.role || '', rounds: ran ? ran.round : 0, review_rounds: e.review_rounds || 0,
        at_integration: e.at_integration === true, salvaged: Boolean(ran && ran.salvaged),
        nets: list(ruled && ruled.files), undiscriminated: Boolean(ruled && ruled.all),
      }
    })
  const failed = [...new Set([...seen.failed, ...(seen.reviewsLost.length ? ['integration-review'] : []), ...(seen.surveysLost.length ? ['survey'] : [])])]
  const unreached = [
    ...(refused ? ['preflight refused (' + refused.kind + '): nothing was dispatched'] : []),
    ...(checkpoint ? ['checkpoint ' + checkpoint.reason + ': nothing was dispatched — relaunch to proceed'] : []),
    ...s.held.map((h) => h.id + ': held — its cycle member ' + h.behind + ' stopped, and a cycle lands as a unit'),
    ...escalations.map((e) => e.id + ': escalated — ' + e.reason),
    ...parks.map((p) => p.id + ': parked — ' + p.return),
    ...faults.map((f) => f.id + ': held on a fault (' + f.channel + ') — the next run takes it up'),
    ...s.blocked.map((b) => b.leaves_n + ' leaf/leaves blocked — ' + b.blocked_by + ' did not land'),
    ...(s.not_merged_n > 0 ? [s.not_merged_n + ' of ' + s.leaves_n + ' leaves not merged' + (seen.stopped ? ' (stopped: ' + seen.stopped + ')' : '')] : []),
    ...(post && post.ok && !s.root_done ? [args.folder + ' is not integrated: ' + (s.root_status || 'planned')] : []),
  ]
  const integration = (post && post.integration) || { branch: '', head_sha: '' }
  return {
    effort: args.effort, root: args.folder, execution: xc.execution, checkpoint, nodes_n: s.nodes_n,
    implemented, escalations, parked: parks, faults, blocked: s.blocked,
    integration: { branch: integration.branch, head_sha: integration.head_sha, reviews: seen.reviews },
    drift: seen.drift, cleanup_n: (post && post.cleanup_n) || 0, stopped: seen.stopped, notes: seen.notes,
    ...(refused ? { error: refused } : {}),
    coverage: coverageOf({ failed_channels: failed, unreached, resumable: ctx.resumable }),
  }
}
