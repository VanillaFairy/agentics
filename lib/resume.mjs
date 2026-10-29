// lib/resume.mjs — where each leaf of an execution picks up, computed rather than reconstructed.
//
// Design: docs/DESIGN.md#resume-and-checkpoints.
//
// Each leaf's lifecycle is a fixed sequence — code → verify → review → merge — and this file
// names the single NEXT UNDONE action per leaf. A stage is adopted only where two independent
// sources agree: the record says the stage closed, and git still holds the head it closed over.
// Rebuilding from scratch is the bottom of that ladder, not the top. A whole-leaf rebuild while
// committed work sits on its branch is the failure this file exists to prevent, and it is at its
// most expensive exactly when the budget already ran out once.
//
// The two regimes, and why they are asymmetric on purpose.
//
//   CLEAN — no leaf branch exists. Node branches are named deterministically
//   (`agentics/<effort>--<flat>`), so ONE `git branch --list` bounds everything a dead invocation
//   could have left in git. With no branch there is no head to agree with, so nothing further is
//   asked of git at all: the records alone settle each leaf (a `merged` event is `none`; anything
//   else is `code`). This is what makes opening a parked plan as cheap as planning it.
//
//   DIRTY — a leaf with a branch resumes exactly where it stopped: its head, its fork point, its
//   commits, the tip's checkpoint mark, whether the parent's integration head already holds it,
//   and whether its worktree carries uncommitted work.
//
// Committed work is salvaged by right, because commits live on the branch and survive a lost
// worktree. Uncommitted work is reported (`dirty`) and adopted by nobody. Escalations are not
// read here at all: whether one is retried is the user's lever (`retry_escalated`), and status
// derivation (lib/tree.mjs) is where an escalated leaf is held back.
//
// Nothing here is stored. The event log and the journals are append-only records of what
// happened; a next action computed over them cannot be stale, while one written down outlives
// the thing it described.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { CHECKPOINT_TRAILER, isCheckpoint } from './commit-series.mjs'
import { leafBase } from './integration.mjs'
import { readLog } from './ledger.mjs'
import {
  branchOf, closePath, executionsRoot, executionDir, git as runGit, nodeBranchGlob, parentOf, readJson, sameBlob, worktreeOf,
} from './store.mjs'
import { normalizeNode, ownReview, ownerOf } from './tree.mjs'
import { CONSOLIDATION, measurementOk, netsAt } from './verdict.mjs'

/** Every value `next_action` can take, in lifecycle order. */
export const ACTIONS = ['code', 'continue-series', 'verify', 'review', 'merge', 'none']

const SHA = /^[0-9a-f]{7,64}$/i
const seqOf = (e) => (e && Number.isInteger(e.seq) ? e.seq : -1)
const latest = (entries, test) => entries.reduce((best, e) => (test(e) && seqOf(e) >= seqOf(best) ? e : best), null)

/** Pure. Whether a dispatch is one of a leaf's rounds: its producer's or its auditor's, never a reviewer's. */
export const isRound = (e) => e.kind === 'dispatched' && /^(producer|auditor):/.test(String(e.thread || ''))

/**
 * The commits on `to`'s own line above `from`: first parents only and merges aside, so a refresh
 * merged in from a parent is none of them. None when `from` is no sha or git cannot say.
 */
function ownLine(repo, from, to, run = runGit) {
  if (!SHA.test(String(from || ''))) return []
  const r = run(repo, ['rev-list', '--first-parent', '--no-merges', from + '..' + to])
  return r.ok ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
}

/**
 * Pure. The stop the review loop of round `round` of `id` recorded — said by one of that round's
 * reviewers or its ruler — once the session cleared it by retry, or null.
 */
export function clearedReviewStop(events, id, round) {
  const judged = new Set(events.filter((e) => e.kind === 'dispatched' && e.node === id && e.round === round &&
    /^(reviewer|ruler):/.test(String(e.thread || ''))).map((e) => e.dispatch))
  const stop = latest(events, (e) => e.kind === 'escalated' && e.node === id && judged.has(e.said))
  return stop && events.some((e) => e.kind === 'replanned' && e.node === id && e.reason === 'retry_escalated' && e.seq > stop.seq) ? stop : null
}

/**
 * The commits on leaf `id`'s branch that are measured before any producer goes on, the one reader
 * the resume ladder and the leaf unit share. `round` is the leaf's latest round in any execution;
 * there are commits only when that round is `execution`'s — the unit closes again only a round of
 * its own execution. When its close stopped the leaf, they are the branch's whole own line above
 * `base` (`ownLine`): the work a retry measures as it stands, whoever made it and whether or not any
 * close measured it. When its close went to a review loop whose stop the session cleared, they are
 * those above the head that close left: commits made by hand over the reviewed head. A close that
 * sent a fix round its messages, or that the unit goes on from as it stands, is left as it is.
 * @param {string} base the leaf's fork point; '' reads the stop's commits from the close's head
 */
export function measureFirst(repo, effort, execution, events, id, base = '', run = runGit) {
  const round = latest(events, (e) => isRound(e) && e.node === id)
  if (!round || !execution || round.execution !== execution) return { round, commits: [] }
  const close = readJson(closePath(repo, effort, execution, id, round.role || 'none', round.round))
  const next = close && close.decision ? close.decision.next : ''
  const branch = 'refs/heads/' + branchOf(effort, id)
  if (next === 'stop') return { round, commits: ownLine(repo, base || close.head_sha, branch, run) }
  if (next === 'review' && clearedReviewStop(events, id, round.round)) return { round, commits: ownLine(repo, close.head_sha, branch, run) }
  return { round, commits: [] }
}

// ---------------------------------------------------------------- the ladder

/**
 * Pure. The single action one leaf resumes at.
 *
 * The ladder walks the lifecycle backwards and stops at the first rung two independent sources
 * agree on. Where they disagree the stage is redone over what is actually there — not a problem,
 * just a branch that moved after the stage closed.
 *
 * @param {object} leaf a normalized leaf
 * @param {{events: object[], journal: object[], git: object|null}} facts
 *   `events` and `journal` are the lines about this leaf (others are ignored); `git` is this
 *   leaf's entry from `gitFacts` — null when it has no branch — with `measure_first`, its `measureFirst`;
 *   `sameAt` is `netsAt`'s git port
 * @returns {{next_action: string, note: string}}
 */
export function nextActionFor(leaf, { events = [], journal = [], git = null, sameAt = () => false } = {}) {
  const id = leaf.id
  const mine = (e) => e && e.node === id
  const ev = events.filter(mine)
  const jl = journal.filter(mine)
  const at = (next_action, note) => ({ next_action, note })

  if (latest(ev, (e) => e.kind === 'merged')) return at('none', 'merged, per the event log')

  // A verify leaf writes nothing, so there is no series to salvage and no head to agree with: it
  // is measured again until something records it merged.
  if (leaf.rigor === 'verify') return at('verify', 'a verify leaf is measured until it is recorded merged')

  const head = git ? git.head_sha : ''
  const branch = git ? git.branch : ''

  // The approval that still stands: newer than the last dispatch and the last replan. A replan
  // or a fresh dispatch after an approval means the approved head is no longer the word on this
  // leaf.
  const reset = Math.max(seqOf(latest(ev, (e) => e.kind === 'dispatched')), seqOf(latest(ev, (e) => e.kind === 'replanned')))
  const approved = latest(ev, (e) => e.kind === 'approved')
  const standing = approved && seqOf(approved) > reset ? approved : null

  // Git says the parent's integration head already holds this branch. Ancestry alone cannot
  // stand: an executor cuts its branch AT the integration head, so a branch whose executor died
  // before its first commit is an ancestor too, and marking that one merged would land a leaf
  // nobody implemented. A second witness is required — the approval written the instant review
  // closed, or the `merge-observed` line merge-batch wrote inside the merge itself. They fail
  // independently, which is the point of having both.
  if (git && git.merged_into_parent) {
    const witness = (approved && approved.head_sha === head) ||
      jl.some((l) => l.kind === 'merge-observed' && (l.head_sha === head || l.branch === git.branch))
    if (witness) return at('none', 'already in the parent\'s integration branch; the merge was made but never recorded')
  }

  if (standing && git && standing.head_sha === head) return at('merge', 'approved and unchanged in git')

  // The last measurement at THIS head, not the last green one: a later red measurement of the
  // same head is the newer word and must not be shadowed by an earlier green.
  const measured = git && latest(jl, (l) => l.kind === 'verify-observed' && l.head_sha === head)
  const nets = (netsAt(ev, id, head, sameAt) || { files: [] }).files
  if (measured && measurementOk(measured, leaf, measured.producer, { nets }).ok) {
    // A consolidation round is measured after its leaf's review approved, and is approved on that measurement.
    return ownReview(leaf) && measured.producer !== CONSOLIDATION
      ? at('review', 'measured green at this exact head; verification is not re-bought')
      : at('merge', 'measured green at this exact head; reviewed at integration')
  }

  // The work on a branch whose latest round stopped, or whose cleared review the session committed
  // over by hand, is measured as it stands before any producer is asked to go on: none is asked to
  // redo or certify work that already passes.
  if (git && Array.isArray(git.measure_first) && git.measure_first.length > 0) {
    return at('verify', git.measure_first.length + ' commit(s) on ' + branch + ' measured as they stand before any producer goes on')
  }

  if (git && git.commits.length > 0) {
    // A checkpoint at the tip settles the question before anything else is consulted. It is the
    // executor's own signature on "I stopped here, unfinished", written in the execution that
    // stopped — and it outranks a `series-done` line for the same head, because the safe reading
    // of that contradiction carries the series on rather than measuring it as whole.
    if (git.checkpoint_head) {
      return at('continue-series', 'the tip is a checkpoint its executor committed on the way out')
    }
    // `series-done` is the only thing that tells "finished and never measured" from "died halfway
    // through commit four" — git sees commits either way, and only the author knows.
    if (jl.some((l) => l.kind === 'series-done' && l.head_sha === head)) {
      return at('verify', 'a finished series an interrupted invocation left unmeasured on ' + branch)
    }
    return at('continue-series', 'commits on ' + branch + ' that no executor recorded finishing')
  }

  return at('code', git ? 'a branch with no commits on it' : 'nothing in git for this leaf')
}

// ---------------------------------------------------------------- the git reader

/**
 * The cycle predecessor whose branch a leaf was cut from: a green's red, an audit's green. Read
 * from `role` and `deps` alone. '' for a leaf in no cycle, or when its predecessor is not among
 * `leaves` (then the parent's integration head is the fork point).
 */
function predecessorOf(leaf, byId) {
  const want = leaf.role === 'green' ? 'red' : leaf.role === 'audit' ? 'green' : ''
  if (!want) return ''
  const dep = leaf.deps.map((d) => byId.get(d)).find((d) => d && d.role === want && d.rigor === leaf.rigor)
  return dep ? dep.id : ''
}

/**
 * What git holds for these leaves.
 *
 * The branch listing comes FIRST and bounds everything else: one glob says exactly which leaves
 * were ever started. A leaf with no branch costs nothing further, so an execution with no leaf
 * branch at all runs exactly one git command.
 *
 * @param {string} repo
 * @param {string} effort
 * @param {Array<object|string>} leaves normalized leaves (ids are accepted, and then cycle
 *   members are measured from the parent's head rather than their predecessor's branch)
 * @param {Object<string, string>} [parentHeads] integration head per parent node id (a leaf id
 *   key is honoured too); a parent missing here is resolved from its branch
 * @param {{fallbackBase?: string, owners?: Object<string, string>, run?: Function}} [opts]
 *   `owners` — the folder a leaf merges into, per leaf id, where that is not its parent (a leaf
 *   in a group); `fallbackBase` — the fork point when
 *   no parent head can be found (the execution's base); `run` — the git runner, for tests
 * @returns {{clean: boolean, calls: number, branches: Object<string, object>}}
 */
function gitFacts(repo, effort, leaves, parentHeads = {}, { fallbackBase = '', owners = {}, run = runGit } = {}) {
  let calls = 0
  const git = (cwd, args) => {
    calls += 1
    return run(cwd, args)
  }

  const nodes = leaves.map((l) => (typeof l === 'string' ? normalizeNode({ id: l, kind: 'leaf' }) : l))
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const listed = git(repo, ['branch', '--list', nodeBranchGlob(effort), '--format=%(refname:short)'])
  const present = new Set(listed.ok ? listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [])
  const started = nodes.filter((n) => present.has(branchOf(effort, n.id)))

  // Nothing built. There is no head for any record to agree with, so the question is settled
  // without another git call.
  if (started.length === 0) return { clean: true, calls, branches: {} }

  const revParse = (ref) => {
    const r = git(repo, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'])
    return r.ok && SHA.test(r.stdout.trim()) ? r.stdout.trim() : ''
  }

  const parentHeadCache = new Map()
  const parentHeadOf = (id) => {
    const parent = owners[id] || parentOf(id)
    const given = parentHeads[id] || parentHeads[parent]
    if (given) return given
    if (!parentHeadCache.has(parent)) parentHeadCache.set(parent, revParse('refs/heads/' + branchOf(effort, parent)))
    return parentHeadCache.get(parent)
  }

  const branches = {}
  for (const leaf of started) {
    const branch = branchOf(effort, leaf.id)
    const head = revParse('refs/heads/' + branch)
    if (!head) continue

    const parentHead = parentHeadOf(leaf.id)

    // The base leaf-open reports, observed the same way. A cycle member is cut from its
    // predecessor's branch, so measuring it from the parent's head would count the red's commits
    // as the green's — and a green nobody started would read as a series to verify.
    const pred = predecessorOf(leaf, byId)
    const predHead = pred && present.has(branchOf(effort, pred)) ? revParse('refs/heads/' + branchOf(effort, pred)) : ''
    const base = leafBase(repo, branch, { pred: predHead, parentHead: parentHead || fallbackBase }, git)

    // Exit 0 is yes, 1 is no, anything else is git unable to answer — which is not the same as
    // answering no, so it stays false and the leaf falls to a lower rung rather than being
    // marked merged on a failure to ask.
    const ancestor = parentHead ? git(repo, ['merge-base', '--is-ancestor', branch, parentHead]) : { status: 1 }

    // The trailer sits between the sha and the subject so the subject stays the last field and
    // may contain anything; a trailer value cannot contain a tab.
    const format = '%H%x09%(trailers:key=' + CHECKPOINT_TRAILER + ',valueonly,separator=%x2C)%x09%s'
    const log = base ? git(repo, ['log', '--reverse', '--format=' + format, base + '..' + branch]) : { ok: false, stdout: '' }
    const entries = log.ok
      ? log.stdout.split('\n').filter(Boolean).map((line) => {
        const first = line.indexOf('\t')
        const second = line.indexOf('\t', first + 1)
        return {
          sha: line.slice(0, first),
          trailers: second === -1 ? '' : line.slice(first + 1, second),
          subject: second === -1 ? line.slice(first + 1) : line.slice(second + 1),
        }
      })
      : []
    const tip = entries.length > 0 ? entries[entries.length - 1] : null

    branches[leaf.id] = {
      branch,
      head_sha: head,
      base_sha: base,
      // The trailers do not travel: the one thing a resume decides on — is the TIP a checkpoint —
      // is a single boolean derived here.
      commits: entries.map(({ sha, subject }) => ({ sha, subject })),
      checkpoint_head: tip ? isCheckpoint(tip) : false,
      merged_into_parent: ancestor.status === 0,
    }
  }

  return { clean: false, calls, branches }
}

// ---------------------------------------------------------------- reading the logs

/**
 * One log (`state` or `journal`) of every execution of the effort — each execution folder on disk,
 * and `execution`, which may have none yet — its entries in stamp order.
 */
export function executionLogs(repo, effort, execution, log) {
  const dir = executionsRoot(repo, effort)
  const stamps = new Set(existsSync(dir) ? readdirSync(dir) : [])
  if (execution) stamps.add(execution)
  const out = []
  for (const stamp of [...stamps].sort()) out.push(...readLog(repo, effort, log + ':' + stamp).entries)
  return out
}

/**
 * The effort's `events` with the `returned` lines of every execution that dispatched leaf `id`:
 * what `rebaseOwed` in lib/tree.mjs reads, whichever execution a round of the leaf returned in.
 */
export function withReturns(repo, effort, events, id) {
  const stamps = new Set(events.filter((e) => e.kind === 'dispatched' && e.node === id && e.execution).map((e) => e.execution))
  const back = [...stamps].flatMap((stamp) => readLog(repo, effort, 'state:' + stamp).entries.filter((e) => e.kind === 'returned'))
  return [...events, ...back]
}

/**
 * Every journal line of the effort, across its executions. A leaf's history can span executions
 * (a relaunch under a new stamp), and a line is only ever trusted where git agrees with the head
 * it names — so reading all of them widens what can be salvaged without widening what is trusted.
 */
export function journalsOf(repo, effort, execution) {
  return executionLogs(repo, effort, execution, 'journal')
}

/** The head of a leaf's live approval, or '' — one a later dispatch or replan superseded is not live. */
export function approvedHead(events, id) {
  let approved = null
  let later = -1
  for (const e of events) {
    if (e.node !== id) continue
    if (e.kind === 'approved' && (!approved || e.seq > approved.seq)) approved = e
    if ((e.kind === 'dispatched' || e.kind === 'replanned') && e.seq > later) later = e.seq
  }
  return approved && approved.seq > later && typeof approved.head_sha === 'string' ? approved.head_sha : ''
}

/**
 * The resume ladder for every leaf among `nodes`, reading the logs and git itself.
 *
 * @param {string} repo
 * @param {string} effort
 * @param {string} execution the execution's stamp
 * @param {Map<string, object>|object[]} nodes live nodes (non-leaves are skipped)
 * @param {Object<string, string>} [parentHeads] see `gitFacts`
 * @param {{run?: Function}} [opts]
 * @returns {Array<{id, next_action, note, branch, worktree, head_sha, base_sha, approved_head, commits, dirty}>}
 */
export function resumeLeaves(repo, effort, execution, nodes, parentHeads = {}, { run = runGit } = {}) {
  const all = (nodes instanceof Map ? [...nodes.values()] : nodes || []).map(normalizeNode)
  const leaves = all.filter((n) => n.kind === 'leaf' && !n.retired)
  const ids = new Set(leaves.map((l) => l.id))

  const events = readLog(repo, effort, 'events').entries.filter((e) => ids.has(e.node))
  const journal = journalsOf(repo, effort, execution).filter((e) => ids.has(e.node))
  const envelopeOnDisk = execution ? readJson(join(executionDir(repo, effort, execution), 'execution.json')) : null
  const fallbackBase = envelopeOnDisk && typeof envelopeOnDisk.base_sha === 'string' ? envelopeOnDisk.base_sha : ''

  const byId = new Map(all.map((n) => [n.id, n]))
  const owners = Object.fromEntries(leaves.map((l) => [l.id, ownerOf(byId, l.id)]).filter(([id, o]) => o !== parentOf(id)))
  const facts = gitFacts(repo, effort, leaves, parentHeads, { fallbackBase, owners, run })

  return leaves.map((leaf) => {
    const g = facts.branches[leaf.id] || null
    const worktree = worktreeOf(repo, effort, leaf.id)
    // Uncommitted work is reported as a fact and adopted by nobody. Asked only where a branch
    // exists: on the clean path there is nothing a worktree could hold that a branch does not.
    let dirty = []
    if (g && existsSync(worktree)) {
      const status = run(worktree, ['status', '--porcelain'])
      dirty = status.ok ? status.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
    }
    const measure_first = g ? measureFirst(repo, effort, execution, events, leaf.id, g.base_sha, run).commits : []
    const { next_action, note } = nextActionFor(leaf, {
      events, journal, git: g && { ...g, measure_first }, sameAt: (a, b, file) => sameBlob(repo, a, b, file, run),
    })
    return {
      id: leaf.id,
      next_action,
      note,
      branch: branchOf(effort, leaf.id),
      worktree,
      head_sha: g ? g.head_sha : '',
      // Where the series starts — the discriminator's baseline and the review span's — and the
      // head an approval named: a resumed merge merges what was approved, never what moved since.
      base_sha: g ? g.base_sha || '' : '',
      approved_head: approvedHead(events, leaf.id),
      commits: g ? g.commits : [],
      dirty,
    }
  })
}
