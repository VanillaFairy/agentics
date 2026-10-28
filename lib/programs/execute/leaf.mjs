// lib/programs/execute/leaf.mjs — one leaf of an execution, driven until it is approved, stopped,
// requeued or routed: its rounds through leaf-open, the producer's dispatch and leaf-close, the
// investigator once per execution, and the review loop with a fresh reviewer each round and the
// convergence ruling askAfter asks for.
//
// Design: docs/DESIGN.md#executors-and-review.

import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { leafClose, recordCommands, routeOf } from '../../boundaries/leaf-close.mjs'
import { pausedAt } from '../../boundaries/execution.mjs'
import { leafOpen } from '../../boundaries/leaf-open.mjs'
import { convergenceRuling, leafReview, reviewResumed, reviewUnits } from '../../boundaries/leaf-review.mjs'
import { channelOf, faultRecords, recordAll } from '../../boundaries/records.mjs'
import { guidanceOf, leafBrief } from '../../brief.mjs'
import { convergenceBrief, investigatorBrief, reviewerBrief } from '../../briefs/execute.mjs'
import { commandsOf } from '../../gotchas.mjs'
import { readLog } from '../../ledger.mjs'
import { clearedReviewStop, isRound, measureFirst } from '../../resume.mjs'
import { loadRole, reviewerTier } from '../../roles.mjs'
import { ROOT_ID, branchOf, closePath, git, readConfig, readJson, returnPath, revParse, reviewPath, worktreeOf } from '../../store.mjs'
import { readTree } from '../../tree.mjs'
import { unruledUnit } from '../../verdict.mjs'
import { dispatch, dispatchJudge, step, stepped, threadOf } from '../common.mjs'
import { askAfter } from '../converge.mjs'

const SCHEMA = { implementer: 'producer', 'test-author': 'producer', auditor: 'auditor' }

const list = (v) => (Array.isArray(v) ? v : [])
const latest = (entries, pred) => entries.reduce((found, e) => (pred(e) && (!found || e.seq > found.seq) ? e : found), null)

/** Pure. A round thread's owner: the node its name carries (`producer:<red>` is the red's). */
const threadOwner = (thread) => thread.slice(thread.indexOf(':') + 1)

/** Pure. Whether every open entry of a review is a unit its reviewer left unruled: the reviewer's miss, no producer's. */
const unruledOnly = (open) => list(open).length > 0 && list(open).every(unruledUnit)

/** Record a fault on `id` (and the `contract_drift` park it may owe). */
function fault(xc, id, channel, detail) {
  const tree = readTree(xc.repo, xc.effort)
  const state = readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries
  recordAll(xc, faultRecords(id, channel, detail, { nodes: tree.nodes, events: tree.events, state }))
}

/**
 * The latest round of `id` this execution dispatched: its record, whether its call returned, and its
 * close record (null while it was never closed), or null before the first.
 */
function lastRound(xc, id) {
  const entries = xc.log.entries()
  const d = latest(entries, (e) => isRound(e) && e.node === id)
  if (!d) return null
  return {
    d,
    returned: entries.some((e) => e.kind === 'returned' && e.dispatch === d.dispatch && e.status === 'returned'),
    close: readJson(closePath(xc.repo, xc.effort, xc.execution, id, d.role || 'none', d.round)),
  }
}

/** The head the latest review record of round `round` of `id` in this execution judged, or ''. */
function reviewedAt(xc, id, round) {
  let head = ''
  for (let n = 1, rec; (rec = readJson(reviewPath(xc.repo, xc.effort, xc.execution, id, n))); n++) {
    if (rec.round === round) head = rec.head_sha || ''
  }
  return head
}

/** A round's facts as its first open recorded them: its base and the head it opened on. */
function openedAt(ctx, id, round) {
  const rec = stepped(ctx, (e) => e.key === 'opened:' + id + ':' + round)[0]
  return rec ? rec.value : { base_sha: '', head_sha: '' }
}

/**
 * The round a dispatched record names, as leaf-close and the review take it: its dispatch the one
 * whose return its close read, '' once it was closed again over commits made by hand.
 */
function roundFrom(ctx, id, d, close = null) {
  const at = openedAt(ctx, id, d.round)
  const dispatch = close && typeof close.dispatch === 'string' ? close.dispatch : d.dispatch
  return { role: d.role, round: d.round, thread: d.thread, owner: threadOwner(d.thread), dispatch, base_sha: at.base_sha, head_before: at.head_sha }
}

const closeArgs = (id, r) => ({ node: id, role: r.role, round: r.round, thread: r.thread, dispatch: r.dispatch, head_before: r.head_before, base_sha: r.base_sha })

const investigating = new WeakMap()

/** Remove a throwaway worktree, dirty or not, and what is left of its folder. */
function dropWorktree(repo, path) {
  git(repo, ['worktree', 'remove', '--force', path])
  rmSync(path, { recursive: true, force: true })
  git(repo, ['worktree', 'prune'])
}

/**
 * The investigator's one dispatch of this execution, in a throwaway worktree at the execution's
 * base; every leaf that asks while it runs, or after, gets the same call.
 */
function investigate(ctx, xc) {
  if (!investigating.has(ctx.log)) {
    investigating.set(ctx.log, (async () => {
      const env = xc.envelope() || {}
      const path = join(xc.repo, '.claude', 'worktrees', 'investigate-' + xc.effort + '-' + xc.execution)
      dropWorktree(xc.repo, path)
      const made = git(xc.repo, ['worktree', 'add', '--detach', path, env.base_sha || 'HEAD'])
      if (!made.ok) throw new Error('the investigator worktree could not be made: ' + made.stderr.trim())
      try {
        const brief = investigatorBrief({
          worktree: resolve(path), known: commandsOf(xc.repo, xc.effort), guidance: guidanceOf(xc.repo, { config: readConfig(xc.repo) }),
        })
        return await dispatch(ctx, { role: 'investigator', schema: 'investigator', thread: 'investigator', node: env.root || ROOT_ID, brief, cwd: resolve(path) })
      } finally {
        dropWorktree(xc.repo, path)
      }
    })())
  }
  return investigating.get(ctx.log)
}

/**
 * The convergence ruling `askAfter` asks for after review round `n` of `id` ended in a fix: a fresh
 * ruler on `ruler:converge:<id>:<n>`, guarded so it never rules from the producer's session,
 * handed every review record of the loop so far, then convergence-ruling. A relaunch replays a
 * ruling that returned and resumes one cut off, so a round is never ruled twice. Returns the
 * leaf's outcome, or '' when the loop goes on.
 */
async function ruleConvergence(ctx, xc, { id, leaf, intelligence, r, n, cwd, producer }) {
  const thread = 'ruler:converge:' + id + ':' + n
  const judge = threadOf(ctx, { role: 'ruler', node: id, thread })
  const reviews = Array.from({ length: n }, (_, i) => readJson(reviewPath(xc.repo, xc.effort, xc.execution, id, i + 1))).filter(Boolean)
  const done = await dispatchJudge({
    producer: { session: producer.session, thread: producer.key },
    judge: { session: judge.session, thread: judge.key },
    run: () => dispatch(ctx, {
      role: 'ruler', schema: 'ruler_convergence', thread, node: id, round: r.round, intelligence, cwd,
      brief: convergenceBrief({ leaf, reviews }),
    }),
  })
  if (done.status !== 'returned') {
    fault(xc, id, channelOf(done.cause), 'the convergence ruling ' + (done.dispatch || thread) + ' failed: ' + (done.cause || 'refused'))
    return 'faulted'
  }
  const out = convergenceRuling(xc, { node: id, review_round: n, dispatch: done.dispatch })
  return out.decision.next === 'escalate' ? 'stopped' : out.decision.next === 'held' ? 'faulted' : ''
}

/**
 * The review of round `r` of `id`: a fresh reviewer per review round, guarded so it never judges
 * its producer's session, then leaf-review. A review whose open set is only units its reviewer left
 * unruled goes to the next fresh reviewer, not to the producer. After a
 * round that ends in a fix, when `askAfter` picks it, a ruler rules whether the loop converges. Returns the leaf's outcome, or ''
 * when a fix round or the cycle's consolidation round follows.
 */
async function review(ctx, xc, { id, intelligence, r, seen }) {
  const tree = readTree(xc.repo, xc.effort)
  const leaf = tree.nodes.get(id)
  const reviewers = xc.log.entries().filter((e) => e.kind === 'dispatched' && e.node === id && e.role === 'reviewer')
  const numberOf = (e) => Number(String(e.thread).split(':').pop()) || 0
  // The round's latest reviewer goes on while it is in flight or judged the head as it stands; one
  // that judged a head commits made by hand have since moved is done, and a fresh one follows.
  const at = latest(reviewers, (e) => e.round === r.round)
  const judged = at ? readJson(reviewPath(xc.repo, xc.effort, xc.execution, id, numberOf(at))) : null
  const stands = at && (!judged || judged.head_sha === revParse(xc.repo, 'refs/heads/' + branchOf(xc.effort, id)))
  let n = stands ? numberOf(at) : Math.max(0, ...reviewers.map(numberOf)) + 1
  const loaded = loadRole('reviewer')
  if (!loaded.ok) throw new Error(loaded.error.message)
  const close = readJson(closePath(xc.repo, xc.effort, xc.execution, id, r.role || 'none', r.round)) || {}
  const ret = (r.dispatch && readJson(returnPath(xc.dir, r.dispatch))) || {}
  const cwd = resolve(worktreeOf(xc.repo, xc.effort, id))
  const brief = leafBrief(xc.repo, xc.effort, r.owner, { role: r.role || undefined, worktree: cwd, commands: commandsOf(xc.repo, xc.effort) })
  for (;;) {
    seen.review_rounds = n
    const prior = n > 1 ? readJson(reviewPath(xc.repo, xc.effort, xc.execution, id, n - 1)) : null
    const head = revParse(xc.repo, 'refs/heads/' + branchOf(xc.effort, id))
    const base = (prior && prior.head_sha) || r.base_sha
    const changed = git(xc.repo, ['diff', '--name-only', base, head])
    const units = reviewUnits(leaf, {
      changed: changed.ok ? changed.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [],
      approved_failing: list(close.measurement && close.measurement.approved_failing),
    })
    const thread = 'reviewer:' + id + ':' + n
    const producer = threadOf(ctx, { role: r.role, node: id, owner: r.owner, thread: r.thread })
    const judge = threadOf(ctx, { role: 'reviewer', node: id, thread })
    const done = await dispatchJudge({
      producer: { session: producer.session, thread: producer.key },
      judge: { session: judge.session, thread: judge.key },
      run: () => dispatch(ctx, {
        role: 'reviewer', schema: 'reviewer', thread, node: id, round: r.round, cwd,
        tier: reviewerTier(leaf, loaded.role, { intelligence }),
        brief: reviewerBrief({
          leaf, brief: brief.text, span: { base, head }, units,
          producer: { status: String(ret.status || ''), concerns: list(ret.concerns), text: String(ret.text || '') },
          prior: list(prior && prior.open).map((f) => ({
            id: f.id, severity: f.severity, claim: f.claim, evidence: f.evidence, failure_scenario: f.failure_scenario, remedy: f.remedy,
          })),
          rewritten: list(close.measurement && close.measurement.tests_rewritten),
        }),
      }),
    })
    if (done.status !== 'returned') {
      fault(xc, id, channelOf(done.cause), 'the reviewer dispatch ' + (done.dispatch || thread) + ' failed: ' + (done.cause || 'refused'))
      return 'faulted'
    }
    const out = leafReview(xc, { node: id, round: r.round, review_round: n, dispatch: done.dispatch, units })
    if (out.decision.next === 'held') return 'faulted'
    if (out.decision.next === 'approve') return 'approved'
    if (out.decision.next === 'escalate') return 'stopped'
    // The approval owes the cycle's consolidation round: no loop to rule on, the round opens next.
    if (out.decision.reason === 'consolidate') return ''
    if (askAfter(n)) {
      const ruled = await ruleConvergence(ctx, xc, { id, leaf, intelligence, r, n, cwd, producer })
      if (ruled) return ruled
    }
    if (!unruledOnly((readJson(reviewPath(xc.repo, xc.effort, xc.execution, id, n)) || {}).open)) return ''
    n += 1
  }
}

/**
 * Drive one leaf of the execution `xc` (`executionContext`) through `ctx` (its `programContext`)
 * until it is approved, stopped, requeued, routed or faulted. A relaunch rebuilds where it stands
 * from the records: a round whose call returned but was never closed is closed, not dispatched
 * again; a round routed to its planner, the leaf unrevised since, is routed again; a round closed for
 * review, or for an unknown command, goes on from there; a round whose review loop
 * stopped and was retried opens the next round, its open findings waiting for it; anything else
 * opens the next round, which leaf-open reopens while its dispatch is unreturned. A throw inside
 * is a `program` fault on the leaf.
 * It never rejects: a fault that cannot be recorded still ends the leaf `faulted`.
 *
 * @param {object} ctx the program's context
 * @param {object} xc the execution's boundary context
 * @param {{id: string, intelligence?: string}} leaf
 * @returns {Promise<{outcome: 'approved'|'stopped'|'requeue'|'route'|'faulted', round: number,
 *   review_rounds: number, salvaged: boolean, route?: object}>}
 */
/** Whether the session paused the execution: a leaf then dispatches no new round, and the run takes it up where it stood once resumed. */
const paused = (xc) => pausedAt(readLog(xc.repo, xc.effort, 'events').entries, xc.execution) > 0

export async function runLeaf(ctx, xc, { id, intelligence }) {
  const seen = { round: 0, review_rounds: 0, salvaged: false }
  const end = (outcome, extra = {}) => ({ outcome, round: seen.round, review_rounds: seen.review_rounds, salvaged: seen.salvaged, ...extra })
  try {
    let left = lastRound(xc, id)
    // Read from the effort's events on disk: the session's `retry` is appended outside the execution's log.
    const tree = readTree(xc.repo, xc.effort)
    const events = tree.events
    // A round routed to its folder's planner stays routed until a plan revises the leaf or the session
    // retries it: the leaf still where it was dispatched goes back to that planner, whatever run closed it.
    const unrevised = left && left.close && ((tree.nodes.get(id) || {}).seq || 0) < left.d.seq &&
      !events.some((e) => e.kind === 'replanned' && e.node === id && e.seq > left.d.seq)
    const route = unrevised ? routeOf(tree.nodes, left.close, left.close.dispatch ? readJson(returnPath(xc.dir, left.close.dispatch)) : null) : null
    if (route) {
      seen.round = left.d.round
      return end('route', { route })
    }
    const base = left ? openedAt(ctx, id, left.d.round).base_sha : ''
    const pending = measureFirst(xc.repo, xc.effort, xc.execution, events, id, base)
    const remeasure = Boolean(left && left.close && pending.round && pending.round.dispatch === left.d.dispatch && pending.commits.length > 0)
    // A review loop the session retried after its stop is over: its open findings wait for the
    // next round, which leaf-open opens with the `retried` message — unless the session committed
    // by hand over it first, or the round's close has since measured such commits (its head is no
    // longer the one the stopping review judged): then the loop goes on with a fresh reviewer.
    if (!remeasure && left && left.close && left.close.decision && left.close.decision.next === 'review' &&
      clearedReviewStop(events, id, left.d.round) && reviewedAt(xc, id, left.d.round) === left.close.head_sha) {
      reviewResumed(xc, { node: id, round: left.d.round })
      left = null
    }
    for (;;) {
      let r
      let closed
      if (left && left.returned && !left.close) {
        r = roundFrom(ctx, id, left.d)
        closed = await leafClose(xc, closeArgs(id, r))
      } else if (left && remeasure) {
        // The work on the branch is measured as it stands before any producer is asked to go on:
        // the round is closed again, with no return to read.
        r = { ...roundFrom(ctx, id, left.d), dispatch: '' }
        closed = await leafClose(xc, closeArgs(id, r))
      } else if (left && left.close && ['review', 'command_unknown'].includes(left.close.decision && left.close.decision.next)) {
        r = roundFrom(ctx, id, left.d, left.close)
        closed = { decision: left.close.decision, raise: left.close.raise, stops: [] }
      } else {
        if (paused(xc)) return end('requeue')
        const opened = await leafOpen(xc, { node: id, intelligence, sleep: ctx.sleep })
        if (opened.status === 'stopped') return end('stopped')
        if (opened.status !== 'opened') return end('requeue')
        seen.salvaged = seen.salvaged || opened.salvaged
        const first = await step(ctx, 'opened:' + id + ':' + opened.round, () => ({ base_sha: opened.base_sha, head_sha: opened.head_sha }))
        r = { role: opened.role, round: opened.round, thread: opened.thread, owner: opened.owner, dispatch: '', base_sha: opened.base_sha, head_before: first.head_sha }
        seen.round = r.round
        if (r.role) {
          const done = await dispatch(ctx, {
            role: r.role, schema: SCHEMA[r.role], thread: r.thread, node: id, owner: r.owner, round: r.round,
            threadBrief: opened.brief, briefParts: opened.brief_parts, tier: opened.tier, permissions: opened.permissions,
            cwd: opened.cwd, fresh: opened.fresh,
          })
          if (done.status !== 'returned') {
            fault(xc, id, channelOf(done.cause), 'the ' + r.role + ' dispatch ' + (done.dispatch || r.thread) + ' failed: ' + (done.cause || 'refused') + (done.message ? ': ' + done.message : ''))
            return end('faulted')
          }
          r.dispatch = done.dispatch
        }
        closed = await leafClose(xc, closeArgs(id, r))
      }
      left = null
      seen.round = r.round
      if (closed.decision.next === 'command_unknown') {
        const established = await investigate(ctx, xc)
        if (established.status !== 'returned') {
          fault(xc, id, channelOf(established.cause), 'the investigator dispatch ' + (established.dispatch || 'investigator') + ' failed: ' + (established.cause || 'refused'))
          return end('faulted')
        }
        recordCommands(xc, { dispatch: established.dispatch })
        closed = await leafClose(xc, closeArgs(id, r))
      }
      const next = closed.decision.next
      if (next === 'approve') return end('approved')
      if (next === 'route') return end('route', { route: closed.route })
      if (next === 'review') {
        if (paused(xc)) return end('requeue')
        const outcome = await review(ctx, xc, { id, intelligence, r, seen })
        if (outcome) return end(outcome)
        continue
      }
      if (next === 'fix') continue
      return end(list(closed.stops).some((s) => s.status === 'held') ? 'faulted' : 'stopped')
    }
  } catch (err) {
    try {
      fault(xc, id, 'program', 'the leaf unit threw: ' + (err && err.message ? err.message : String(err)))
    } catch {
      // The fault could not be recorded (the tree or the log refused): the leaf still ends faulted
      // here, so the program goes on with its other units rather than ending the run.
    }
    return end('faulted')
  }
}
