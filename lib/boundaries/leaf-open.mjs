// lib/boundaries/leaf-open.mjs — leaf-open, in-process: a slot and the locus locks, the integration
// branch and the leaf's branch and worktree, and what the round's dispatch takes from the records —
// its round, role, thread, owner, tier, permissions and thread brief.
//
// Design: docs/DESIGN.md#boundaries.

import { resolve } from 'node:path'

import { heldAgainst } from '../atomicity.mjs'
import { leafBrief } from '../brief.mjs'
import { commandsOf } from '../gotchas.mjs'
import { ensureLeaf, integrationSteps } from '../integration.mjs'
import { readLog } from '../ledger.mjs'
import { acquireAsync, withBranchLockAsync } from '../locks.mjs'
import { permissionsFor } from '../locus.mjs'
import { isRound } from '../resume.mjs'
import { loadRole, producerTier, raiseTier, roleCommands } from '../roles.mjs'
import { branchOf, closePath, executionDir, git, isTestPath, readJson, returnPath, reviewPath, revParse } from '../store.mjs'
import { cycleOf, cycleTestLocus, executorRole, ownerOf, readTree } from '../tree.mjs'
import { auditGap, greenRoundRole } from '../verdict.mjs'
import { escalated, message, recordAll } from './records.mjs'

const list = (v) => (Array.isArray(v) ? v : [])
const lines = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
const latest = (entries, pred) => entries.reduce((found, e) => (pred(e) && (!found || e.seq > found.seq) ? e : found), null)

/** A lock not taken in time: the branch is being merged into, which is a wait, not a failure. */
const BUSY = Symbol('busy')

/** The message of lib/store.mjs's lock timeout, the one lock error that is a wait; any other is a fault. */
const LOCK_TIMEOUT = /^could not take the lock /

/**
 * `fn` (synchronous) under one integration branch's lock, waited for with an awaited `sleep`; BUSY
 * when the lock was not taken in time. A throw inside `fn` stays a throw.
 */
async function underLock(xc, branch, fn, sleep) {
  let thrown = null
  let out
  try {
    out = await withBranchLockAsync(xc.repo, xc.effort, branch, () => {
      try {
        return fn()
      } catch (err) {
        thrown = err
        return null
      }
    }, sleep ? { sleep } : {})
  } catch (err) {
    if (!LOCK_TIMEOUT.test(String(err && err.message))) throw err
    return BUSY
  }
  if (thrown) throw thrown
  return out
}

/** What one earlier round left on disk: its stored return's status, its close and its review record. */
function roundRecords(xc, leafId, d) {
  if (!d) return { status: '', close: null, review: null }
  const execution = d.execution || xc.execution
  const ret = readJson(returnPath(executionDir(xc.repo, xc.effort, execution), d.dispatch))
  let review = null
  for (let n = 1, rec; (rec = readJson(reviewPath(xc.repo, xc.effort, execution, leafId, n))); n++) {
    if (rec.round === d.round) review = rec
  }
  return {
    status: (ret && ret.status) || '',
    close: readJson(closePath(xc.repo, xc.effort, execution, leafId, d.role, d.round)),
    review,
  }
}

/**
 * Pure. The findings recorded as messages for `leaf`, as the open set `greenRoundRole` reads: one
 * that went to the cycle's test session is a `tests` finding. Before a leaf's first 5.0 round only
 * tools/migrate-v5.mjs has recorded any, from the 4.x review that left them open.
 */
function recordedOpen(events, leaf, cycle) {
  const tests = 'producer:' + (cycle[0] || leaf.id)
  return events.filter((e) => e.kind === 'message' && e.node === leaf.id)
    .flatMap((m) => list(m.payload && m.payload.findings).map((f) => ({ ...f, remedy: m.thread === tests ? 'tests' : 'code' })))
}

/**
 * The role a round of `leaf` goes to (docs/DESIGN.md#rigor). An audit's goes to the cycle's test
 * session from the first measurement whose tests let an applied mutation through; a green's later
 * round by `greenRoundRole` over the round before (a test round whose failures went back to the test
 * session records no `tests_ready`, so the test session keeps the green; one that goes on to review
 * or the implementer has the implementer next, unless its review left only test findings);
 * a review that escalated and whose stop the session cleared counts as a fix's; every
 * other round to the leaf's executor. A green's first round goes by `greenRoundRole` over the
 * findings already recorded for it (`recorded`): on a migrated store, those its 4.x review left open.
 */
function roundRole(xc, leaf, round, byRound, journal, recorded) {
  if (leaf.role === 'audit') {
    return auditGap(journal.filter((e) => e.kind === 'verify-observed' && e.node === leaf.id)) ? 'test-author' : 'auditor'
  }
  if (leaf.role !== 'green') return executorRole(leaf)
  if (round === 1) return greenRoundRole({ review: { next: 'fix', open: recorded } })
  const before = byRound(round - 1)
  const prev = roundRecords(xc, leaf.id, before)
  // A round after a review that escalated opens only once the session cleared that stop by retry:
  // its open set then routes as a fix's would.
  const review = prev.review && prev.review.next === 'escalate' ? { ...prev.review, next: 'fix' } : prev.review
  return greenRoundRole({ close: before ? { ...(prev.close || {}), role: before.role, status: prev.status } : null, review })
}

/**
 * The files a green's own commits changed since its red's head, outside the cycle's tests: what the
 * cycle's test session may not read (docs/DESIGN.md#conversations).
 */
function greenSource(xc, cycle) {
  const red = revParse(xc.repo, 'refs/heads/' + branchOf(xc.effort, cycle[0]))
  const green = cycle[1] ? revParse(xc.repo, 'refs/heads/' + branchOf(xc.effort, cycle[1])) : ''
  if (!red || !green) return []
  const r = git(xc.repo, ['log', '--no-merges', '--name-only', '--format=', red + '..' + green])
  return r.ok ? [...new Set(lines(r.stdout))].filter((p) => !isTestPath(p)) : []
}

/**
 * Pure. The `retried` message a new round of `id` owes its thread, or null. A thread this execution
 * dispatched before is resumed, and a resumed call must deliver something: once the session cleared
 * the leaf's stop (`replanned {reason: 'retry_escalated'}`) after the thread's latest return, the
 * round tells the session why it resumes — the cleared stop's reason and the text of every note
 * left on the leaf since that stop or the thread's latest return, whichever is later, so a note an
 * earlier round was told is never told again. A thread new to this execution starts a fresh session on its
 * brief, and owes nothing.
 */
function retriedRecord({ id, thread, round, execution, events, back }) {
  const calls = new Set(events.filter((e) => e.kind === 'dispatched' && e.execution === execution && e.thread === thread).map((e) => e.dispatch))
  if (calls.size === 0) return null
  const since = Math.max(0, ...back.filter((e) => calls.has(e.dispatch)).map((e) => e.seq))
  const retry = latest(events, (e) => e.kind === 'replanned' && e.node === id && e.reason === 'retry_escalated' && e.seq > since)
  if (!retry) return null
  const stop = latest(events, (e) => (e.kind === 'escalated' || e.kind === 'parked') && e.node === id && e.seq < retry.seq)
  const from = Math.max(stop ? stop.seq : 0, since)
  const notes = events.filter((e) => e.kind === 'noted' && e.node === id && e.seq > from).map((e) => String(e.text || ''))
  const reason = !stop ? '' : stop.kind === 'parked' ? stop.return : stop.reason
  return message(id, thread, 'retried', { reason: reason || '', notes }, round)
}

/**
 * Pure. The `notes` message a new round of `id` owes a thread this execution has not dispatched:
 * every `noted` text on the leaf newer than its latest dispatch of any execution, the notes no
 * session of it has seen. A thread this execution dispatched gets `retried` instead.
 */
function notesRecord({ id, thread, round, execution, events }) {
  if (events.some((e) => e.kind === 'dispatched' && e.execution === execution && e.thread === thread)) return null
  const seen = Math.max(0, ...events.filter((e) => e.kind === 'dispatched' && e.node === id).map((e) => e.seq))
  const notes = events.filter((e) => e.kind === 'noted' && e.node === id && e.seq > seen).map((e) => String(e.text || ''))
  return notes.length ? message(id, thread, 'notes', { notes }, round) : null
}

/**
 * Open one round of a leaf of the execution `xc` (`executionContext`). A new round on a thread this
 * execution dispatched before, after the session cleared the leaf's stop, records the `retried`
 * message that round delivers; a new round on a thread this execution never dispatched records the
 * `notes` message that round delivers.
 *
 * @param {object} xc
 * @param {{node: string, intelligence?: string, sleep?: (ms: number) => Promise<void>}} args
 *   `sleep` paces every lock wait, so a wait never stops the event loop
 * @returns {Promise<object>} `{status: 'opened', role, thread, owner, round, fresh, tier, permissions,
 *   cwd, brief, brief_parts, base_sha, head_sha, branch, salvaged}`; `{status: 'no_slot' |
 *   'locus_held' | 'busy', held_by}`; `{status: 'stopped', stops}` once `open_refused` is recorded
 * @throws when `node` is not a leaf of the live tree or the execution has no envelope: the caller's bug
 */
export async function leafOpen(xc, { node: id, intelligence = 'normal', sleep } = {}) {
  const tree = readTree(xc.repo, xc.effort)
  const leaf = tree.nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf') throw new Error('no live leaf ' + JSON.stringify(id) + ' in effort ' + xc.effort)
  const env = xc.envelope()
  if (!env) throw new Error('execution ' + xc.execution + ' has no envelope: preflight writes it first')
  const refuse = (detail) => ({ status: 'stopped', stops: recordAll(xc, [escalated(id, 'open_refused', detail)]).stops })

  const got = await acquireAsync(xc.repo, { effort: xc.effort, execution: xc.execution, node: id, locus: leaf.locus, waitMs: 0 }, sleep ? { sleep } : {})
  if (!got.ok) {
    if (got.reason === 'invalid') return refuse(got.error)
    return { status: got.reason, held_by: list(got.held_by).map((h) => ({ node: h.node || '', status: h.status || '' })) }
  }

  const parent = ownerOf(tree.nodes, id)
  const parentBranch = branchOf(xc.effort, parent)
  const cycle = cycleOf(tree.nodes, id)
  const existed = Boolean(revParse(xc.repo, 'refs/heads/' + branchOf(xc.effort, id)))
  const isGroup = (a) => (tree.nodes.get(a) || {}).kind === 'group'
  for (const step of integrationSteps(xc.repo, xc.effort, parent, env, { isGroup })) {
    const done = await underLock(xc, step.branch, () => step.run(), sleep)
    if (done === BUSY) return { status: 'busy', held_by: [] }
    if (!done.ok) return refuse(done.error)
  }
  // The cut reads the parent's head under its lock: a merge-batch bisecting into the parent moves
  // that head through unverified states, and none of them is a base. A green or an audit is cut
  // from its cycle predecessor's head (red is held, never merged alone).
  const made = await underLock(xc, parentBranch, () => {
    const at = cycle.indexOf(id)
    let from = revParse(xc.repo, 'refs/heads/' + parentBranch)
    if (at > 0) {
      from = revParse(xc.repo, 'refs/heads/' + branchOf(xc.effort, cycle[at - 1]))
      if (!from) return { ok: false, error: cycle[at - 1] + ' has no branch to cut ' + id + ' from' }
    }
    return ensureLeaf(xc.repo, xc.effort, id, { from, parentBranch, cycleMember: at > 0 })
  }, sleep)
  if (made === BUSY) return { status: 'busy', held_by: [] }
  if (!made.ok) return refuse(made.error)

  const rounds = tree.events.filter((e) => isRound(e) && e.node === id)
  const back = readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries.filter((e) => e.kind === 'returned' && e.status === 'returned')
  const returned = new Set(back.map((e) => e.dispatch))
  const open = latest(rounds, (e) => e.execution === xc.execution && !returned.has(e.dispatch))
  const round = open ? open.round : Math.max(0, ...rounds.map((e) => (Number.isInteger(e.round) ? e.round : 0))) + 1
  const byRound = (n) => latest(rounds, (e) => e.round === n)
  const journal = readLog(xc.repo, xc.effort, 'journal:' + xc.execution).entries

  const role = open ? open.role : roundRole(xc, leaf, round, byRound, journal, recordedOpen(tree.events, leaf, cycle))
  const testRound = role === 'test-author' && (leaf.role === 'green' || leaf.role === 'audit')
  const owner = testRound ? cycle[0] || id : id
  const thread = open ? open.thread : role === 'auditor' ? 'auditor:' + id : role ? 'producer:' + owner : ''

  const commands = commandsOf(xc.repo, xc.effort)
  const cwd = resolve(made.worktree)
  const brief = leafBrief(xc.repo, xc.effort, owner, { role: testRound ? 'test-author' : role || undefined, worktree: cwd, commands })
  const salvaged = existed && made.head !== made.base && !rounds.some((e) => e.execution === xc.execution)
  const opened = {
    status: 'opened', role, thread, owner, round, fresh: '', tier: null, permissions: null, cwd,
    brief: brief.text, brief_parts: brief.parts, base_sha: made.base, head_sha: made.head, branch: made.branch, salvaged,
  }
  if (!role) return opened
  // A reopened round's call is resumed as it was started; only a new round delivers a message.
  const owed = open ? null
    : retriedRecord({ id, thread, round, execution: xc.execution, events: tree.events, back }) ||
      notesRecord({ id, thread, round, execution: xc.execution, events: tree.events })
  if (owed) recordAll(xc, [owed])

  const loaded = loadRole(role)
  if (!loaded.ok) throw new Error(loaded.error.message)
  // A raise renews the session whose round cleared nothing; a round on another thread did not fail.
  const before = byRound(round - 1)
  const prev = roundRecords(xc, id, before)
  const raised = Boolean(before) && before.thread === thread &&
    ((prev.close && prev.close.raise === true) || (prev.review && prev.review.raise === true))
  const threadTier = latest(tree.events, (e) => e.kind === 'dispatched' && e.thread === thread)
  const base = producerTier(tree.nodes.get(owner), loaded.role, { intelligence })
  const tier = open ? { model: open.model, effort: open.effort }
    : raised ? raiseTier(threadTier ? { model: threadTier.model, effort: threadTier.effort } : base) : base

  const scope = testRound ? cycleTestLocus(tree.nodes, tree.status, leaf) : null
  const listed = git(xc.repo, ['ls-tree', '-r', '--name-only', made.base])
  const permissions = permissionsFor({
    locus: scope ? scope.tests : leaf.locus,
    testDirs: scope ? scope.dirs : [],
    baseFiles: listed.ok ? lines(listed.stdout) : [],
    held: heldAgainst(tree.nodes, tree.status, id),
    tests: role !== 'auditor' && !(role === 'implementer' && leaf.role === 'green'),
    commands: roleCommands(loaded.role, commands, leaf),
    denyRead: testRound ? greenSource(xc, cycle) : [],
  })
  return { ...opened, fresh: raised ? 'raised' : '', tier, permissions }
}
