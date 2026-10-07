// lib/boundaries/merge.mjs — merge-batch and the suite gate, in-process: approved children merged
// into a composite's integration branch, measured, bisected and recorded; the full suite run once
// on a composite whose children have all merged.
//
// Design: docs/DESIGN.md#boundaries.
//
// Both run their measurements through `measure`, an awaited child, so the execution's event loop
// keeps running for minutes of suite. A measurement during which the user's checkout moved is a
// `checkout` fault on the target and decides nothing: the batch is put back where it started.

import { driftBrief } from '../briefs/execute.mjs'
import { guidanceOf } from '../brief.mjs'
import { commandsOf } from '../gotchas.mjs'
import { attach, changedFiles, contains, detach, effortBase, ensureIntegration, mergeUnits, resetTo } from '../integration.mjs'
import { readLog } from '../ledger.mjs'
import { releaseLocus, withBranchLockAsync } from '../locks.mjs'
import { measure } from '../measure.mjs'
import { reviewOf } from '../schedule.mjs'
import {
  ROOT_ID, ancestorsOf, branchExists, branchOf, gatePath, git, mergePath, readConfig, revParse, worktreeOf, writeJson, writeWhole,
} from '../store.mjs'
import { childrenOf, ownerOf, readTree, subtreeOf } from '../tree.mjs'
import { suiteFailed } from '../verdict.mjs'
import { escalated, faultRecords, message, recordAll } from './records.mjs'

const list = (v) => (Array.isArray(v) ? v : [])
const refuse = (kind, text) => ({ ok: false, error: { kind, message: text }, stops: [] })
const stateOf = (xc) => readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries
const isGroupIn = (tree) => (id) => (tree.nodes.get(id) || {}).kind === 'group'
const isComposite = (tree, id) => tree.nodes.has(id) && !['leaf', 'group'].includes(tree.nodes.get(id).kind)

/** The commands verification runs: the `command` gotchas an investigator wrote, else the envelope's. */
function commandsFor(xc) {
  const given = (xc.envelope() || {}).commands || {}
  const found = commandsOf(xc.repo, xc.effort)
  const pick = (name) => found[name] || given[name] || ''
  const absent = (name) => Boolean((found.absent && found.absent[name]) || (given.absent && given.absent[name]))
  return {
    build: pick('build'), typecheck: pick('typecheck'), suite: pick('suite'), suiteFast: pick('suite_fast'), testOne: pick('test_one'),
    buildAbsent: absent('build'), typecheckAbsent: absent('typecheck'), suiteAbsent: absent('suite'), suiteFastAbsent: absent('suite_fast'),
  }
}

/** Pure. Whether the repository splits its tests: then a merge-batch runs the fast suite, and the gate the full one. */
const splitSuite = (cmd) => Boolean(cmd.suiteFast) && !cmd.suiteFastAbsent

const integrationOk = (m) => m && m.stop_reason === 'completed' && m.build !== 'failed' && m.typecheck !== 'failed' && !suiteFailed(m)

/** Pure. What a measurement of an integration head says failed, as `failures` carry it: `{check, claim, evidence}`. */
function integrationFailures(m, head = 'the merged head') {
  const out = []
  if (!m || m.stop_reason !== 'completed') out.push({ check: 'environment', claim: (m && m.error && m.error.message) || head + ' could not be measured', evidence: '' })
  for (const k of ['build', 'typecheck', 'suite']) {
    const what = k === 'suite' && m && m.suite_scope === 'fast' ? 'fast suite' : k
    if (m && (k === 'suite' ? suiteFailed(m) : m[k] === 'failed')) out.push({ check: k, claim: 'the ' + what + ' fails on ' + head, evidence: k === 'suite' ? (m.suite_output_tail || '') : (m.notes || '') })
  }
  return out
}

/** Pure. A batch in an order where a child merges after any sibling it depends on. */
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

/**
 * Pure. What a landed diff touched that a pending node was designed against: the landed files
 * intersected with the `consumes` path prefixes of every node not yet merged. A contract the
 * landed work itself provides is expected to move and is not drift; a design node with no
 * contracts to check against is counted unexamined, because "no flag" and "nothing to check" differ.
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
    if (['merged', 'landed', 'reviewing', 'integrated'].includes(s)) continue
    if (n.consumes.length === 0) {
      if (n.kind === 'design' && childrenOf(tree.nodes, id).length === 0) unexamined++
      continue
    }
    for (const c of n.consumes) {
      if (providedHere.has(c.name)) continue
      const hit = files.filter((f) => c.paths.some((p) => under(f, p)))
      // A stopped node is the user's already: its drift is reported, never ruled over its stop.
      if (hit.length) drift.push({ node: id, contract: c.name, files: hit, ...(['escalated', 'parked'].includes(s) ? { stopped: s } : {}) })
    }
  }
  return { drift, unexamined }
}

/**
 * Pure. The stops a batch decides from what it observed: a conflict is a planner defect; leaves
 * that each pass alone and fail together are a combination failure; a composite, or a cycle that
 * lands as a unit, failing alone has no one producer a fix round could go to; and a batch that
 * moved nothing and saw nothing fail stops its target.
 */
function mergeRecords(target, { merged = [], conflict = null, combination = [], failedAlone = [], isLeaf }) {
  const out = []
  if (conflict) out.push(escalated(conflict.node, 'merge_conflict', 'conflicting paths: ' + conflict.paths.join(', ') + ' — loci were declared disjoint; this is a planner defect'))
  for (const id of combination) out.push(escalated(id, 'combination_failure', 'passes alone, fails merged with ' + combination.filter((x) => x !== id).join(', ')))
  for (const f of failedAlone) {
    if (f.ids.length === 1 && isLeaf(f.id)) continue
    const why = f.failures.map((x) => x.claim).join('; ')
    for (const m of f.ids) out.push(escalated(m, 'fails_on_integration', why))
  }
  if (merged.length + failedAlone.length + combination.length + (conflict ? 1 : 0) === 0) {
    out.push(escalated(target, 'merge_no_progress', 'a merge-batch into ' + target + ' merged nothing and reported no failure'))
  }
  return out
}

/** Pure. A leaf's latest round: the round of its latest `dispatched` event, 0 before any. */
const latestRound = (events, id) =>
  events.filter((e) => e.kind === 'dispatched' && e.node === id).reduce((m, e) => Math.max(m, Number.isInteger(e.round) ? e.round : 0), 0)

/** Pure. The integration branches `id` is refreshed from, root first; a group has none. */
function branchesAbove(tree, id) {
  if (id === ROOT_ID) return []
  return [...ancestorsOf(id)].filter((a) => !isGroupIn(tree)(a)).reverse()
}

/** Run `fn` holding every branch of `branches`, taken in order, each waited for without blocking. */
function holding(xc, branches, fn, sleep) {
  if (branches.length === 0) return fn()
  return withBranchLockAsync(xc.repo, xc.effort, branches[0], () => holding(xc, branches.slice(1), fn, sleep), { sleep })
}

/** Whether a measurement can be trusted: the user's checkout stayed put and the watch could read it. */
function unwatched({ payload, moved }) {
  if (moved) return "the user's checkout moved while the check ran"
  return payload && payload.error && payload.error.kind === 'watch_failed' ? payload.error.message : ''
}

/** The `checkout` fault on `node` a measurement nobody could vouch for ends in. */
function heldOn(xc, node, why) {
  const tree = readTree(xc.repo, xc.effort)
  return recordAll(xc, faultRecords(node, 'checkout', why, { nodes: tree.nodes, events: tree.events, state: stateOf(xc) })).stops
}

// ------------------------------------------------------------------ merge-batch

/**
 * Merge `children` (`{id, head_sha}[]`, approved) into `target`'s integration branch under its
 * lock: in dependency order, a cycle (`cycles`, each `[id…]` in order) through its tip; the merged
 * head measured with the fast suite, or the full one where the tests are not split; a red head
 * bisected. Records `batch-started`, the `batch` outcome, `merged`, `merge-observed`, the stops,
 * and a `failures` message to each leaf failing alone; releases the merged leaves' locus locks and
 * removes their clean worktrees, keeping their branches; writes the drift record and the ruler's
 * brief. A batch started and never finished is reset to where it started and done again.
 *
 * @param {object} xc the execution's context (`executionContext`)
 * @param {{target: string, children?: {id: string, head_sha: string}[], cycles?: string[][], sleep?: (ms: number) => Promise}} args
 *   `sleep` paces the branch lock waits
 */
export async function mergeBatch(xc, { target, children = [], cycles = [], sleep } = {}) {
  const tree = readTree(xc.repo, xc.effort)
  if (!isComposite(tree, target)) return refuse('not_a_composite', JSON.stringify(target) + ' is no composite of ' + xc.effort)
  const env = xc.envelope()
  if (!env) return refuse('no_execution', 'execution ' + xc.execution + ' has no envelope')
  const given = list(children).filter((c) => c && tree.nodes.has(c.id))

  // Units: a cycle merges through its tip, which carries every member's commits.
  const inCycle = new Map()
  for (const cycle of list(cycles)) for (const m of cycle) inCycle.set(m, cycle)
  const units = []
  const done = new Set()
  for (const id of dependencyOrder(tree.nodes, given.map((c) => c.id))) {
    if (done.has(id)) continue
    const cycle = inCycle.get(id)
    const ids = cycle ? cycle.filter((m) => given.some((c) => c.id === m)) : [id]
    ids.forEach((m) => done.add(m))
    const tip = ids[ids.length - 1]
    const branch = branchOf(xc.effort, tip)
    units.push({ ids, branch, head: (given.find((c) => c.id === tip) || {}).head_sha || revParse(xc.repo, 'refs/heads/' + branch) })
  }
  return withBranchLockAsync(xc.repo, xc.effort, branchOf(xc.effort, target), () => batch(xc, tree, env, target, units, sleep), { sleep })
}

/** The batch itself, under the target's branch lock. */
async function batch(xc, tree, env, target, units, sleep) {
  const nothing = { ok: true, target, head_sha: '', verified: null, merged: [], failed_alone: [], drift: [], drift_brief: '', drift_record: '' }
  // The branches above are refreshed into the target under their own locks, held only meanwhile.
  const integ = await holding(xc, branchesAbove(tree, target).map((a) => branchOf(xc.effort, a)), () =>
    ensureIntegration(xc.repo, xc.effort, target, env, { isGroup: isGroupIn(tree) }), sleep)
  if (!integ.ok) {
    // The batch cannot run at all: the target stops, and nothing is batched into it until the user acts.
    return { ...nothing, status: 'stopped', stops: recordAll(xc, [escalated(target, 'merge_batch_failed', integ.error)]).stops }
  }
  const wt = integ.worktree

  // A batch that started and never recorded its outcome died between merging and measuring, or
  // mid-bisect: its merges are unverified. Back to the head it started from, and do it again.
  const state = stateOf(xc)
  const started = state.findLast((e) => e.kind === 'batch-started' && e.target === target)
  const finished = state.findLast((e) => e.kind === 'batch' && e.target === target)
  const notes = []
  if (started && (!finished || finished.seq < started.seq) && started.pre && contains(xc.repo, revParse(wt, 'HEAD'), started.pre)) {
    git(wt, ['merge', '--abort'])
    resetTo(wt, started.pre)
    notes.push('an earlier batch into ' + target + ' died before recording its outcome; reset to ' + started.pre + ' and merged again')
  }
  const pre = revParse(wt, 'HEAD')
  const options = { worktree: wt, mode: 'integration', scope: 'fast', base: pre, ...commandsFor(xc), node: target, branch: integ.branch }
  let distrust = ''
  const measured = async () => {
    const taken = await measure(xc, options)
    distrust = unwatched(taken)
    return taken.payload
  }
  const held = () => {
    resetTo(wt, pre)
    return { ...nothing, status: 'held', head_sha: pre, stops: heldOn(xc, target, distrust) }
  }

  const pending = units.filter((u) => !contains(xc.repo, pre, u.head))
  if (pending.length) xc.log.append('batch-started', { target, pre, children: pending.flatMap((u) => u.ids) })
  let out = mergeUnits(xc.repo, wt, units)
  let merged = out.merged
  let measurement = null
  let verified = null
  const failedAlone = []
  let combination = []

  const fresh = merged.filter((m) => !m.already)
  // Everything already contained and nothing started: a run again after the outcome was recorded.
  if (fresh.length === 0 && merged.length > 0) verified = true
  if (fresh.length > 0) {
    measurement = await measured()
    if (distrust) return held()
    verified = integrationOk(measurement)
    if (!verified) {
      // Bisect: back to the last green head, each unit alone, then the ones that pass together.
      resetTo(wt, pre)
      const passers = []
      for (const u of units.filter((x) => fresh.some((f) => f.ids === x.ids))) {
        const alone = mergeUnits(xc.repo, wt, [u])
        const m = alone.conflict ? null : await measured()
        if (distrust) return held()
        if (m && integrationOk(m)) passers.push(u)
        else failedAlone.push({ id: u.ids[u.ids.length - 1], ids: u.ids, failures: m ? integrationFailures(m) : [{ check: 'merge', claim: alone.conflict.reason, evidence: '' }] })
        resetTo(wt, pre)
      }
      out = mergeUnits(xc.repo, wt, passers)
      merged = out.merged
      if (passers.length > 1) {
        measurement = await measured()
        if (distrust) return held()
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
  const conflict = out.conflict ? { node: out.conflict.ids[out.conflict.ids.length - 1], nodes: out.conflict.ids, paths: out.conflict.paths, reason: out.conflict.reason } : null
  // The outcome first: once it stands, a batch run again finds its merges verified and never
  // resets them, and records whichever `merged` events a kill kept from landing.
  if (pending.length) {
    xc.log.append('batch', {
      target, merged: landed.map((l) => l.id), head_sha: head, verified,
      failed_alone: failedAlone.map((f) => f.id), combination, conflict: conflict ? conflict.node : '',
    })
  }
  const unmerged = landed.filter((l) => (tree.status.get(l.id) || {}).status !== 'merged')
  for (const l of unmerged) {
    const unit = units.find((u) => u.ids.includes(l.id)) || {}
    xc.log.append('merged', { node: l.id, into: integ.branch, merged_sha: l.merged_sha, head_sha: unit.head || '' })
  }
  for (const l of unmerged) {
    xc.log.append('merge-observed', { node: l.id, branch: branchOf(xc.effort, l.id), into: integ.branch, merged_sha: l.merged_sha, head_sha: head })
  }
  if (landed.length) {
    const kindOf = (id) => tree.nodes.get(id).kind
    const leafIds = landed.map((l) => l.id).filter((id) => kindOf(id) === 'leaf')
    const under = landed.map((l) => l.id).filter((id) => kindOf(id) !== 'leaf')
      .flatMap((c) => subtreeOf(tree.nodes, c)).filter((id) => kindOf(id) === 'leaf')
    releaseLocus(xc.repo, xc.effort, [...leafIds, ...under])
    // A merged leaf's worktree has nothing left to do; its branch stays until landing.
    for (const id of leafIds) detach(xc.repo, worktreeOf(xc.repo, xc.effort, id))
  }

  const { drift, unexamined } = landed.length ? driftOf(tree, landed.map((l) => l.id), changedFiles(xc.repo, pre, head)) : { drift: [], unexamined: 0 }
  const record = mergePath(xc.repo, xc.effort, xc.execution, target, pre)
  writeJson(record, { target, pre, head_sha: head, merged: landed, conflict, verified, measurement, failed_alone: failedAlone, combination, drift, notes })
  // What the drifted consumers are ruled against: each one as planned, and the merged change to
  // the files it consumes.
  const open = drift.filter((d) => !d.stopped)
  const brief = open.length ? record.replace(/\.json$/, '.drift.md') : ''
  if (brief) {
    const diffs = {}
    for (const id of new Set(open.map((d) => d.node))) {
      const files = [...new Set(open.filter((d) => d.node === id).flatMap((d) => d.files))]
      diffs[id] = git(wt, ['diff', pre + '..' + head, '--', ...files]).stdout
    }
    writeWhole(brief, driftBrief({
      target: integ.branch,
      records: open.map((d) => ({ node: d.node, contract: d.contract, files: d.files, entry: tree.nodes.get(d.node) })),
      diffs,
      guidance: guidanceOf(xc.repo, { config: readConfig(xc.repo) }),
    }))
  }

  const isLeaf = (id) => (tree.nodes.get(id) || {}).kind === 'leaf'
  // A single leaf that fails alone on the integration head goes back to a fix round: its producer
  // is told what failed, as the message that round delivers.
  const alone = failedAlone.filter((f) => f.ids.length === 1 && isLeaf(f.id))
  const messages = alone.map((f) =>
    message(f.id, 'producer:' + f.id, 'failures', { source: 'integration', failures: f.failures }, latestRound(tree.events, f.id) + 1))
  const { stops } = recordAll(xc, [...messages, ...mergeRecords(target, { merged: landed, conflict, combination, failedAlone, isLeaf })])
  return {
    ok: true, status: 'done', target, head_sha: head, verified,
    merged: landed, failed_alone: alone.map((f) => ({ id: f.id })),
    drift: drift.map((d) => ({ node: d.node, contract: d.contract, stopped: d.stopped || '' })), drift_brief: brief, drift_record: record,
    unexamined_n: unexamined, stops,
  }
}

// ------------------------------------------------------------------ suite-gate

/** A composite's integration branch, worktree, head and the head it was cut from; null before it is cut. */
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

/** A gate that passed at `head`: whether the integration review is earned, and `claims` `not_earned` when it is not. */
function passedAt(xc, target, head, ran, record) {
  const tree = readTree(xc.repo, xc.effort)
  const env = xc.envelope() || {}
  const review = reviewOf({ nodes: tree.nodes, status: tree.status, root: env.root || ROOT_ID, integrationOf: (id) => integrationOf(xc, tree, id) }, target)
  const records = review.earned ? [] : [{ kind: 'claims', fields: { node: target, head_sha: head, review: 'not_earned', claims: [] } }]
  return { ok: true, status: 'done', target, head_sha: head, ran, passed: true, review: review.earned ? 'earned' : 'not_earned', record, stops: recordAll(xc, records).stops }
}

/**
 * The full suite on `target`'s integration head, once every child has merged, against the head it
 * was cut from: recorded with a `gate` line, a failure escalated `fails_full_suite`. Nothing runs
 * where the tests are not split, or where the full suite already passed at that head in this
 * execution; a failing gate is asked again.
 *
 * @param {object} xc the execution's context
 * @param {{target: string, sleep?: (ms: number) => Promise}} args
 */
export async function suiteGate(xc, { target, sleep } = {}) {
  const tree = readTree(xc.repo, xc.effort)
  if (!isComposite(tree, target)) return refuse('not_a_composite', JSON.stringify(target) + ' is no composite of ' + xc.effort)
  const where = integrationOf(xc, tree, target)
  if (!where) return refuse('no_integration', target + ' has no integration branch yet')
  const cmd = commandsFor(xc)
  if (!splitSuite(cmd)) return passedAt(xc, target, where.head, false, '')
  if (stateOf(xc).some((e) => e.kind === 'gate' && e.target === target && e.head_sha === where.head && e.passed)) return passedAt(xc, target, where.head, false, '')

  return withBranchLockAsync(xc.repo, xc.effort, where.branch, async () => {
    const wt = attach(xc.repo, where.branch, where.worktree)
    if (!wt.ok) {
      const { stops } = recordAll(xc, [escalated(target, 'suite_gate_failed', wt.error)])
      return { ok: true, status: 'stopped', target, head_sha: where.head, ran: false, passed: false, review: '', record: '', stops }
    }
    const head = revParse(wt.path, 'HEAD')
    const taken = await measure(xc, { worktree: wt.path, mode: 'integration', scope: 'full', base: where.base, ...cmd, node: target, branch: where.branch })
    const distrust = unwatched(taken)
    if (distrust) return { ok: true, status: 'held', target, head_sha: head, ran: true, passed: false, review: '', record: '', stops: heldOn(xc, target, distrust) }
    const m = taken.payload
    const passed = integrationOk(m)
    const failures = passed ? [] : integrationFailures(m, 'the integration head')
    const record = gatePath(xc.repo, xc.effort, xc.execution, target, head)
    writeJson(record, { target, head_sha: head, base: where.base, passed, measurement: m, failures })
    xc.log.append('gate', { target, head_sha: head, passed })
    if (passed) return passedAt(xc, target, head, true, record)
    const { stops } = recordAll(xc, [escalated(target, 'fails_full_suite', failures.map((f) => f.claim).join('; ') + ' (the measurement: ' + record + ')')])
    return { ok: true, status: 'done', target, head_sha: head, ran: true, passed: false, review: '', record, stops }
  }, { sleep })
}
