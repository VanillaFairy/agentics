// lib/schedule.mjs — what an execution launches next, computed from the tree on disk.
//
// Design: docs/DESIGN.md#scheduling. Pure: the `schedule` boundary reads the node records, the
// event log and this execution's state log, records the plugin faults the execute program names
// first, and hands everything here. The program holds no copy of the tree; it says what it has in
// flight and runs what comes back.

import { ROOT_ID, ancestorsOf, entriesOverlap } from './store.mjs'
import { coupledOf, ordered } from './atomicity.mjs'
import { judgedAt, mergedWhereTheyMeet, waitsOn } from './contention.mjs'
import { childrenOf, cycleOf, ownReview, ownerOf, subtreeOf, unitsOf } from './tree.mjs'

const STOPPED = ['escalated', 'parked']
const list = (v) => (Array.isArray(v) ? v : [])

/** Why a node stopped: an escalation's `reason`, a park's `return`. */
const whyOf = (e) => (e ? e.reason || e.return || '' : '')

/**
 * Pure. The facts every rule reads, bound once.
 *
 * @param {{nodes: Map, status: Map, events?: object[], root: string,
 *   running?: string[], planning?: string[], held?: string[], integrationOf?: (id: string) => object|null,
 *   unprepared?: (id: string) => boolean}} input `unprepared`: whether a folder's spec is edited past
 *   its last approved or prepared line
 */
function view(input) {
  const { nodes, status, root } = input
  const running = new Set(input.running || [])
  const planning = new Set(input.planning || [])
  // Held by the invocation on a plugin fault: nothing launches it again until the next one.
  const held = new Set(input.held || [])
  const integrationOf = input.integrationOf || (() => null)
  const unprepared = input.unprepared || (() => false)
  const events = input.events || []
  /** The node's latest stop, a park or an escalation, is cleared: a `replanned` (a retry, an answer) is newer. */
  const stopCleared = (id) => {
    const stop = events.filter((e) => (e.kind === 'parked' || e.kind === 'escalated') && e.node === id).pop()
    return Boolean(stop) && events.some((e) => e.kind === 'replanned' && e.node === id && e.seq > stop.seq)
  }
  const statusOf = (id) => (status.get(id) || {}).status || 'planned'
  const lastOf = (id) => (status.get(id) || {}).last || null
  const inScope = (id) => id === root || ancestorsOf(id).includes(root)
  const scope = subtreeOf(nodes, root)
  const isLeaf = (id) => nodes.has(id) && nodes.get(id).kind === 'leaf'
  const isGroup = (id) => nodes.has(id) && nodes.get(id).kind === 'group'
  const depsOf = (id) => [...new Set([id, ...ancestorsOf(id)].flatMap((a) => (nodes.get(a) || {}).deps || []))]

  /** A running or replanning unit on the node or an ancestor: nothing below it moves meanwhile. */
  const busy = (id) => held.has(id) || [id, ...ancestorsOf(id)].some((a) => running.has('leaf:' + a) || running.has('plan:' + a) || planning.has(a))

  /** A cycle predecessor needs only approval: green is cut from red's branch. */
  const cyclePredecessor = (id, dep) => {
    const a = nodes.get(id)
    const d = nodes.get(dep)
    return Boolean(a && d) && a.rigor === d.rigor &&
      ((a.role === 'green' && d.role === 'red') || (a.role === 'audit' && d.role === 'green'))
  }

  /** The dep (or its ancestor just below the lowest common ancestor) merged where this leaf is cut.
   * Groups have no branch, so the chains pass over them: a dep in another group of the same folder
   * is ready once it merged, not once its whole group did. A dep that is itself a group is ready
   * once every task in it merged. */
  const depReady = (id, dep) => {
    if (!nodes.has(dep)) return false
    if (cyclePredecessor(id, dep)) return ['approved', 'merged'].includes(statusOf(dep))
    const up = [id, ...ancestorsOf(id).filter((a) => !isGroup(a))]
    const chain = [dep, ...ancestorsOf(dep).filter((a) => !isGroup(a))]
    const lca = up.find((x) => chain.includes(x))
    const at = chain.indexOf(lca)
    if (at <= 0) return true
    return ['merged', 'landed'].includes(statusOf(chain[at - 1]))
  }

  /** The escalated or parked node a leaf waits behind, through its dependencies, or ''. */
  const blockedBy = (id, seen = new Set()) => {
    if (seen.has(id)) return ''
    seen.add(id)
    if (!nodes.has(id)) return ''
    for (const dep of depsOf(id)) {
      if (STOPPED.includes(statusOf(dep))) return dep
      const deeper = blockedBy(dep, seen)
      if (deeper) return deeper
    }
    return ''
  }

  /** Two leaves that expect a common file and no dependency orders: the scheduler keeps them apart. */
  const meets = (a, b) => {
    const x = nodes.get(a)
    const y = nodes.get(b)
    return a !== b && x.expects.some((p) => y.expects.some((q) => entriesOverlap(p, q))) && !ordered(nodes, a, b)
  }

  /** The leaf `id` meets that runs in this execution, or is active or approved and unmerged anywhere, or ''. */
  const contendedBy = (id) => [...nodes.keys()].find((o) => isLeaf(o) && meets(id, o) &&
    (running.has('leaf:' + o) || ['active', 'approved'].includes(statusOf(o)))) || ''

  return {
    ...input, running, planning, integrationOf, statusOf, lastOf, inScope, scope, isLeaf, isGroup,
    busy, depReady, depsOf, blockedBy, unprepared, stopCleared, meets, contendedBy,
  }
}

const runningOf = (v, unit) => [...v.running].filter((k) => k.startsWith(unit + ':')).length

/**
 * The ready leaves, up to the pool. A leaf whose `expects` meets a running, active or approved leaf
 * waits, and so does one that meets a leaf this pass launches; `advisory` launches such leaves too,
 * one per pass, for a pass that would otherwise launch nothing while nothing runs: a prediction
 * defers work, it never holds it.
 */
function leavesToLaunch(v, maxParallel, stopping, { advisory = false } = {}) {
  if (stopping) return []
  const out = []
  const coupledRunning = [...v.running].some((k) => k.startsWith('leaf:') && coupledOf(v.nodes, k.slice(5)))
  for (const id of v.scope) {
    if (!v.isLeaf(id) || !['planned', 'active'].includes(v.statusOf(id)) || v.busy(id)) continue
    if (v.blockedBy(id) || !v.depsOf(id).every((d) => v.depReady(id, d))) continue
    if (coupledOf(v.nodes, id) && (coupledRunning || out.some((o) => coupledOf(v.nodes, o)))) continue
    if (out.some((o) => v.meets(id, o))) continue
    if (v.contendedBy(id) && !advisory) continue
    out.push(id)
    if (advisory) break
  }
  return out.slice(0, Math.max(0, maxParallel - runningOf(v, 'leaf')))
}

/** Every folder whose plan is due now, whatever the free plan slots: `schedule` launches as many as fit. */
function plansDue(v) {
  const out = []
  for (const id of v.scope) {
    const n = v.nodes.get(id)
    if (n.kind === 'leaf' || n.kind === 'group' || v.busy(id)) continue
    const s = v.statusOf(id)
    if (childrenOf(v.nodes, id).length === 0 && !['parked', 'escalated', 'merged', 'landed'].includes(s)) {
      out.push({ unit: 'plan', id, why: '' })
      continue
    }
    // A planner-written folder whose spec is edited past its last preparation, under a park the
    // session answers by an edit, or a stop since cleared (retried, answered): the edit is reviewed and prepared. A plan
    // that stops leaves a stop of its own, and one that prepares leaves nothing edited.
    const park = v.lastOf(id)
    const answerable = s === 'parked' && !['spec_changed', 'design_spend'].includes(whyOf(park))
    if (n.author === 'planner' && v.unprepared(id) && (answerable || v.stopCleared(id))) {
      out.push({ unit: 'plan', id, why: 'spec_edited' })
      continue
    }
    // A planner-written folder its compile parked `spec_changed`: re-derived once per park, so
    // again only while no planner dispatch on it is newer than the park.
    if (n.author !== 'planner' || s !== 'parked' || whyOf(park) !== 'spec_changed') continue
    const tried = (v.events || []).some((e) => e.kind === 'dispatched' && e.role === 'planner' && e.node === id && e.seq > park.seq)
    if (!tried) out.push({ unit: 'plan', id, why: 'spec_changed' })
  }
  return out
}

/** The leaf a judge's serialize ruling makes the unit led by `id` wait on, while its work has not merged where they meet, or ''. */
const waitingOn = (v, id, approvedHead) =>
  waitsOn(v.events || [], id, approvedHead(id)).find((o) => !mergedWhereTheyMeet(v, id, o)) || ''

/** Whether a judge ruled the unit led by `id`, at its approved head, a replan: it merges only once its plan revised it. */
const replanRuled = (v, id, approvedHead) =>
  ['contention', 'conflict'].some((t) => (judgedAt(v.events || [], id, t, approvedHead(id)) || {}).outcome === 'replan')

/** Approved children waiting on one integration branch, a cycle only whole and led by its red; a unit a serialize ruling holds waits. */
function mergesToLaunch(v, maxParallel, approvedHead) {
  const byTarget = new Map()
  const add = (target, child) => {
    if (!byTarget.has(target)) byTarget.set(target, { unit: 'merge', target, children: [], cycles: [] })
    byTarget.get(target).children.push(child)
  }
  for (const id of v.scope) {
    if (v.isGroup(id)) continue
    const target = ownerOf(v.nodes, id)
    if (target === null || v.running.has('merge:' + target) || STOPPED.includes(v.statusOf(target))) continue
    if (v.isLeaf(id)) {
      if (v.statusOf(id) !== 'approved' || v.running.has('leaf:' + id)) continue
      const cycle = cycleOf(v.nodes, id)
      if (cycle.length) {
        if (cycle[0] !== id || !cycle.every((m) => v.statusOf(m) === 'approved' && !v.running.has('leaf:' + m))) continue
        const tip = cycle[cycle.length - 1]
        if (waitingOn(v, tip, approvedHead) || replanRuled(v, tip, approvedHead)) continue
        for (const m of cycle) add(target, { id: m, head_sha: approvedHead(m) })
        byTarget.get(target).cycles.push(cycle)
        continue
      }
      if (waitingOn(v, id, approvedHead) || replanRuled(v, id, approvedHead)) continue
      add(target, { id, head_sha: approvedHead(id) })
    } else if (v.statusOf(id) === 'integrated') {
      add(target, { id, head_sha: (v.integrationOf(id) || {}).head || '' })
    }
  }
  return [...byTarget.values()].slice(0, maxParallel)
}

/** Pure. Whether leaf `id` was adopted on the user's word: a `merged` event that carries `by`. */
const adoptedIn = (events, id) => events.some((e) => e.kind === 'merged' && e.node === id && typeof e.by === 'string' && e.by !== '')

/** Pure. Composite `id`'s work agentics did not produce: its adopted units (among `units`) with their commits, and the commits of its `outside` events. */
export function outsideWorkOf(events, id, units) {
  const leaves = list(units).filter((k) => adoptedIn(events, k))
    .map((k) => ({ id: k, commits: list((events.findLast((e) => e.kind === 'merged' && e.node === k) || {}).commits) }))
  const commits = events.filter((e) => e.kind === 'outside' && e.node === id).flatMap((e) => list(e.commits))
  return { leaves, commits }
}

/**
 * A composite's integration review: what it covers, and whether it is earned — at the root
 * whenever something merged there, below it when a child had no review loop of its own or two or
 * more children with work meet there. Work adopted or committed outside an execution earns it too.
 */
function reviewFor(v, id) {
  const events = v.events || []
  const kids = unitsOf(v.nodes, id)
  const unreviewed = kids.filter((k) => v.isLeaf(k) && (!ownReview(v.nodes.get(k)) || adoptedIn(events, k)))
  const withWork = kids.filter((k) => !v.isLeaf(k) || v.nodes.get(k).rigor !== 'verify')
  const outside = outsideWorkOf(events, id, kids)
  const where = v.integrationOf(id)
  const earned = Boolean(where) && (id === ROOT_ID ||
    unreviewed.some((k) => v.nodes.get(k).rigor !== 'verify') || withWork.length >= 2 ||
    outside.leaves.length > 0 || outside.commits.length > 0)
  return { unit: 'review', id, earned, where, children: kids, unreviewed }
}

/** Pure. The integration review of composite `id` as `schedule` would launch it; see `view` for `input`. */
export const reviewOf = (input, id) => reviewFor(view(input), id)

/**
 * The integration review of every composite `reviewing`: its children merged, no review standing,
 * and no plan of it or an ancestor running or due (`planned`, every due plan, launched now or once a
 * slot frees), which may add the work its spec's claims describe.
 */
function reviewsToLaunch(v, maxParallel, planned) {
  const out = []
  for (const id of v.scope) {
    if (v.running.has('review:' + id) || v.statusOf(id) !== 'reviewing') continue
    // A planner's folder whose spec is edited past its last preparation is reviewed once the edit is compiled.
    if (v.nodes.get(id).author === 'planner' && v.unprepared(id)) continue
    if (v.busy(id) || [id, ...ancestorsOf(id)].some((a) => planned.has(a))) continue
    out.push(reviewFor(v, id))
  }
  return out.slice(0, Math.max(0, maxParallel - runningOf(v, 'review')))
}

/**
 * Pure. What to launch now: leaves by readiness under the pool, folders to plan, merge batches,
 * integration reviews. Every list is capped by `maxParallel`, so what comes back is bounded by the
 * pool, never by the size of the effort. `idle` when nothing runs and nothing launches.
 *
 * @param {object} input see `view`, plus `stopping`, `maxParallel`, `approvedHead(id)`
 * @returns {{launch: object[], idle: boolean}}
 */
export function schedule(input) {
  const v = view(input)
  const max = Number.isInteger(input.maxParallel) && input.maxParallel > 0 ? input.maxParallel : 1
  const due = plansDue(v)
  const plans = due.slice(0, Math.max(0, max - runningOf(v, 'plan')))
  const merges = mergesToLaunch(v, max, input.approvedHead || (() => ''))
  const reviews = reviewsToLaunch(v, max, new Set(due.map((p) => p.id)))
  let leaves = leavesToLaunch(v, max, input.stopping)
  if (leaves.length + plans.length + merges.length + reviews.length === 0 && v.running.size === 0) {
    leaves = leavesToLaunch(v, max, input.stopping, { advisory: true })
  }
  const launch = [...plans, ...leaves.map((id) => ({ unit: 'leaf', id })), ...merges, ...reviews]
  return { launch, idle: launch.length === 0 && v.running.size === 0 }
}

/**
 * Pure. Where an execution's subtree stands, for its return: counts, one line per node the user
 * must act on, how many leaves wait behind each stopped node, through their dependencies, and the
 * approved leaves held: behind a stopped member of their cycle, or behind the leaf a serialize
 * ruling makes them wait on.
 */
export function summarize(input) {
  const v = view(input)
  const leaves = v.scope.filter(v.isLeaf)
  const waiting = leaves.filter((id) => ['planned', 'active'].includes(v.statusOf(id)))
  const behind = new Map()
  for (const id of waiting) {
    const by = v.blockedBy(id)
    if (by) behind.set(by, (behind.get(by) || 0) + 1)
  }
  const stopped = v.scope.filter((id) => STOPPED.includes(v.statusOf(id)) && v.lastOf(id))
    .map((id) => {
      const last = v.lastOf(id)
      return { id, status: v.statusOf(id), reason: whyOf(last) }
    })
  const approvedHead = input.approvedHead || (() => '')
  const held = leaves.filter((id) => v.statusOf(id) === 'approved')
    .map((id) => ({ id, behind: cycleOf(v.nodes, id).find((m) => STOPPED.includes(v.statusOf(m))) || waitingOn(v, id, approvedHead) }))
    .filter((h) => h.behind)
  const merged = leaves.filter((id) => v.statusOf(id) === 'merged').length
  const rootStatus = v.statusOf(v.root)
  return {
    nodes_n: v.scope.length,
    leaves_n: leaves.length,
    merged_n: merged,
    not_merged_n: leaves.length - merged,
    blocked_n: [...behind.values()].reduce((a, b) => a + b, 0),
    blocked: [...behind].map(([by, n]) => ({ blocked_by: by, leaves_n: n })),
    root_status: rootStatus,
    root_done: ['integrated', 'merged', 'landed'].includes(rootStatus),
    done: merged === leaves.length && (v.root === ROOT_ID || rootStatus === 'merged'),
    stopped,
    held,
  }
}
