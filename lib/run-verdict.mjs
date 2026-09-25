// lib/run-verdict.mjs — what a run has already done, computed rather than reconstructed.
//
// Design: docs/DESIGN.md#resume-verdict.
//
// This is the deterministic half of a resume. Given a run directory and a repository it emits
// ONE small payload saying, per work order, which single action comes next — and nothing else
// about the run needs deciding by a model.
//
// What it replaces. A resume used to reconstruct that answer inside the workflow script from
// state lines, journal lines and a scavenge agent's report, all of which reached the script
// through a courier's structured output. Every field was at risk of a paraphrase, and the one
// field with no digest behind it — `partition_raw` — was mangled three times running on one
// repository in 2026-08. A partition that will not parse reads as "no waves", which degraded
// the whole run to "every order is coupled" and offered four already-merged orders back to the
// session to be reimplemented. Here it is `JSON.parse` over a file.
//
// The two regimes, and why they are asymmetric on purpose.
//
//   CLEAN — an empty ledger and no branches for this runstamp means there is nothing to
//   salvage BY DEFINITION, and the machinery must know that without dispatching anyone to look.
//   Order branches are named deterministically, so one `git branch --list` bounds everything a
//   dead invocation could possibly have left. Nothing there, nothing recorded: every order is
//   `code`, and no further git runs. This is what makes opening a parked plan as cheap as
//   planning it.
//
//   DIRTY — each order's lifecycle is a fixed sequence, the records say which steps closed, git
//   says whether the commits those steps closed over are still there, and the next undone
//   action is where that order resumes. Never earlier. A whole-order rebuild while committed
//   work sits on its branch is the failure this file exists to prevent, and it is at its most
//   expensive in exactly the situation where the budget already ran out once.
//
// Nothing here is stored. `plan.json` records what was decided and the two JSONL files are
// append-only records of what happened; a status computed over them cannot be stale, while a
// status written down outlives the thing it described. Same stance as lib/run-status.mjs, one
// question deeper: that file answers "where is this run", this one answers "what do I do next".

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { canonical, digestOrder, fnv1a } from './plan-digest.mjs'
import { CHECKPOINT_TRAILER, isCheckpoint } from './commit-series.mjs'

/**
 * Every value `next_action` can take, in lifecycle order.
 *
 * The four stages an order passes through, plus two that are not stages: `continue-series`
 * re-enters `code` on work that already exists, and `none` means there is nothing left to do.
 * Exported so a caller can check the set rather than hard-coding a list that silently stops
 * matching when a rung is added.
 */
export const ACTIONS = ['code', 'continue-series', 'verify', 'review', 'merge', 'none']

const posix = (p) => String(p || '').split('\\').join('/')
const str = (v) => (typeof v === 'string' ? v : '')
const SHA_RE = /^[0-9a-f]{7,40}$/i

// ---------------------------------------------------------------- derived verdicts
//
// A behavioural copy of the same block in workflows/agentics-develop.workflow.js, which cannot
// import. Pinned together by test/run-verdict.test.mjs, the same way the plan digest is pinned
// across its two homes. It lives in both places for one reason: a resume must re-derive a
// measurement's verdict with the SAME function that derived it the first time, or an order
// green in one invocation is red in the next for no reason anybody can see.
//
// No verdict is ever read off disk. Agents record what they OBSERVED — build, suite, failing
// tests, discriminator — and pass/fail is computed here from those facts. That is what lets an
// agent write its own durability record without certifying its own work.

const OUTCOME = new Set(['passed', 'failed', 'absent'])

const failuresOutside = (failing, allowed) => {
  const fence = new Set((allowed || []).map(posix))
  return (failing || []).filter((f) => !f || !fence.has(posix(f.file)))
}

const seriesClean = (v) => !(v.series_findings || []).some((f) => !f || f.blocking)

const verifiable = (v) =>
  v.stop_reason === 'completed' && v.build !== 'failed' && v.typecheck !== 'failed' && seriesClean(v)

const failuresConfinedTo = (v, allowed) =>
  (v.failing_tests || []).length > 0 && failuresOutside(v.failing_tests, allowed).length === 0

// `pins: 'data'` marks a regression net over something already correct — the shipped bundle is
// still valid, the generated file still matches its source. Those assertions hold at base BY
// DESIGN, so `failed_on_base` is not a question they can answer; `passes_now` still is, and is
// still required. Inert on a red order, where failing at base is the whole point.
const pinsData = (wo) => Boolean(wo) && wo.pins === 'data' && ((wo && wo.role) || 'none') === 'none'

const discriminates = (d, wo) => Boolean(d) && d.passes_now && (pinsData(wo) || d.failed_on_base)

// The behavioural copy of `mutationsBite` in workflows/agentics-develop.workflow.js. A declared
// mutation that could not be applied, or that did not make its named tests fail, fails the order
// on both paths — an order green in a live run and red on resume for no visible reason is what
// this duplication exists to prevent. An order with no declared mutation is unaffected.
const mutationsBite = (v) => (v.mutations || []).every((m) => m && m.applied && m.bites)

const plainVerifyOk = (v, wo) => verifiable(v) &&
  v.suite !== 'failed' &&
  mutationsBite(v) &&
  (v.discriminator || []).every((d) => discriminates(d, wo))

const redVerifyOk = (v, wo) => verifiable(v) &&
  (v.discriminator || []).length > 0 &&
  (v.discriminator || []).every((d) => d && d.failed_on_base && !d.passes_now) &&
  v.suite !== 'passed' &&
  (v.suite !== 'failed' || failuresConfinedTo(v, wo.locus))

const refactorVerifyOk = (v) => verifiable(v) &&
  v.suite === 'passed' &&
  (v.discriminator || []).length === 0

/** Pure. Whether a recorded measurement is a pass, judged against the order's own role. */
export function verifyOk(v, wo) {
  const role = (wo && wo.role) || 'none'
  if (role === 'red') return redVerifyOk(v, wo)
  if (role === 'refactor') return refactorVerifyOk(v)
  return plainVerifyOk(v, wo)
}

/**
 * Pure. Parse journal.jsonl leniently, normalizing every field to its declared type.
 *
 * A torn last line is the expected shape of this file rather than corruption of the run:
 * several agents append here and a kill can land mid-write. Everything the journal carries is
 * either an optimization or corroboration for something git also holds, so a lost line costs
 * tokens and never correctness.
 *
 * `recorded` is the load-bearing field. The predicates above are written against a
 * schema-validated verifier result where the arrays are required; a journal line has no schema,
 * and every field a predicate reaches for is missing in the PERMISSIVE direction — a series
 * finding with no `blocking` reads as clean, a discriminator with no `passes_now` reads as
 * validly red. So a line that did not record everything the derivation reads is never asked the
 * question: what is MISSING must not be read as what is EMPTY.
 */
export function parseJournal(raw) {
  const lines = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean)
  const entries = []
  let torn = 0

  const arr = (v) => (Array.isArray(v) ? v.filter((e) => e && typeof e === 'object') : [])
  const has = (o, k, test) => Object.prototype.hasOwnProperty.call(o, k) && test(o[k])
  const field = (e, k, type) =>
    Object.prototype.hasOwnProperty.call(e, k) && typeof e[k] === type
  const elements = (spec) => (v) => Array.isArray(v) &&
    v.every((e) => e && typeof e === 'object' && spec.every(([k, type]) => field(e, k, type)))

  const wholeFindings = elements([['blocking', 'boolean']])
  const wholeDiscriminator = elements([['failed_on_base', 'boolean'], ['passes_now', 'boolean']])
  const wholeFailures = elements([['file', 'string']])

  for (const line of lines) {
    let parsed = null
    try {
      parsed = JSON.parse(line)
    } catch {
      torn += 1
      continue
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.kind) {
      torn += 1
      continue
    }

    entries.push({
      kind: str(parsed.kind),
      // `0` for a line written before the counter existed — true rather than defaulted: such a
      // line really does precede every stamped one.
      seq: Number.isInteger(parsed.seq) ? parsed.seq : 0,
      order: str(parsed.order),
      branch: str(parsed.branch),
      worktree: posix(parsed.worktree),
      base_sha: str(parsed.base_sha),
      head_sha: str(parsed.head_sha),
      stop_reason: str(parsed.stop_reason),
      notes: str(parsed.notes),
      build: str(parsed.build),
      // Normalized to 'absent' when the key is missing, which is every line written before the
      // field existed. That is the honest reading — such a run never asked the question — and it
      // is what lets a run planned under the old verdict resume under the old verdict. It is
      // deliberately absent from `recorded` below for the same reason: an older line is a whole
      // record of what its version measured, not a torn one.
      typecheck: OUTCOME.has(parsed.typecheck) ? parsed.typecheck : 'absent',
      suite: str(parsed.suite),
      failing_tests: arr(parsed.failing_tests),
      discriminator: arr(parsed.discriminator),
      // Absent on every line written before mutations existed, and an empty list asks nothing —
      // so such a run resumes under the verdict it was planned under, the same rule `typecheck`
      // and `pins` follow. Deliberately not part of `recorded`: an older line is a whole record
      // of what its version measured.
      mutations: arr(parsed.mutations),
      series_findings: arr(parsed.series_findings),
      commits: Array.isArray(parsed.commits) ? parsed.commits.filter((c) => c && typeof c === 'object') : [],
      recorded: has(parsed, 'stop_reason', (v) => typeof v === 'string') &&
        has(parsed, 'build', (v) => OUTCOME.has(v)) &&
        has(parsed, 'suite', (v) => OUTCOME.has(v)) &&
        has(parsed, 'failing_tests', wholeFailures) &&
        has(parsed, 'discriminator', wholeDiscriminator) &&
        has(parsed, 'series_findings', wholeFindings),
    })
  }

  return { entries, torn }
}

/** Pure. Parse state.jsonl leniently. A line that will not parse is a note, never a throw. */
export function parseState(raw) {
  const lines = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean)
  const entries = []
  let torn = 0

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries.push(parsed)
      else torn += 1
    } catch {
      torn += 1
    }
  }

  return { entries, torn }
}

/**
 * Pure. The waves and coupled set a plan's stored partition names.
 *
 * Three distinct failures get three distinct labels, because a plan the partition REFUSED is a
 * planning defect and reporting it as "did not parse" sends the reader after the wrong bug.
 * This is the parse that used to happen after two model hops.
 */
export function partitionOf(plan) {
  const unknown = (note) => ({ waves: [], coupled: [], note })

  let parsed
  try {
    parsed = JSON.parse(plan.partition_raw ?? '')
  } catch (err) {
    return unknown('partition_raw is not JSON (' + err.message + ') — the planner paraphrased ' +
      'the CLI output instead of pasting it')
  }

  if (parsed && parsed.error) {
    return unknown('the partition refused the plan: ' + parsed.error + ' — a planning defect ' +
      '(a dependency cycle, a dep naming no order, or a provider routed to the session), not ' +
      'a parse failure')
  }
  if (!parsed || !Array.isArray(parsed.waves)) return unknown('partition output carries no waves array')

  return {
    waves: parsed.waves.map((w) => (Array.isArray(w) ? w.filter((id) => typeof id === 'string') : [])),
    coupled: Array.isArray(parsed.coupled) ? parsed.coupled.filter((id) => typeof id === 'string') : [],
    note: '',
  }
}

// ---------------------------------------------------------------- the replay
//
// One pass over each file, IN FILE ORDER. What is known about an order is whatever its LAST
// line said, and the only thing that can establish "last" is the order an append-only log is
// in. Resolving by kind precedence instead is wrong in both directions: an `order-verified`
// line is written before the review loop opens, so every review-stage escalation is later than
// a verified line rather than earlier — and treating verified as the deeper record would cancel
// exactly the escalations a resume most needs to carry.

/**
 * Pure. Reduce the two ledgers to what each order reached, plus the run's shared facts.
 *
 * @param {Array<object>} state parsed state.jsonl entries, oldest first
 * @param {{entries: Array<object>, torn: number}} journal parsed journal.jsonl
 * @param {Map<string, object>} orderById the plan's work orders
 */
export function replay(state, journal, orderById) {
  const landed = new Set()
  const approved = new Map()
  const verified = new Map()
  const escalated = new Map()
  const mergeObserved = new Map()
  const coderDone = new Map()
  const reviewRounds = new Map()
  const knowledge = new Set()
  const integration = { base_sha: '', head_sha: '' }
  let seqMax = 0
  let incomplete = 0
  let unusable = 0

  const bump = (e) => { seqMax = Math.max(seqMax, Number.isInteger(e.seq) ? e.seq : 0) }

  for (const entry of state) {
    bump(entry)
    // A line with no `kind` predates the multi-type log, and every line written then was a wave
    // line. Reading it as one is the file's own history, not a guess.
    const kind = entry.kind || 'wave'

    if (kind === 'order-approved' || kind === 'order-verified') {
      if (!entry.order) continue
      const stage = {
        branch: str(entry.branch),
        worktree: posix(entry.worktree),
        head_sha: str(entry.head_sha),
        measured: Array.isArray(entry.measured) ? entry.measured : [],
        seq: Number.isInteger(entry.seq) ? entry.seq : 0,
        source: 'state',
      }
      // The two stages are exclusive, and this line is the newer word on which one the order
      // reached — whichever direction that moves it. A success recorded after an escalation
      // supersedes it: the retry that produced this line is what the escalation was waiting for.
      if (kind === 'order-approved') {
        approved.set(entry.order, stage)
        verified.delete(entry.order)
      } else {
        verified.set(entry.order, stage)
        approved.delete(entry.order)
      }
      escalated.delete(entry.order)
      continue
    }

    // Escalations recorded where they happened rather than only in the wave line that closes
    // over them. A run that dies mid-wave loses the wave line and, with it, every escalation
    // this invocation reached — which a resume then re-buys in full.
    if (kind === 'order-escalated') {
      if (!entry.order || landed.has(entry.order)) continue
      const already = escalated.get(entry.order)
      escalated.set(entry.order, {
        wave: already ? already.wave : (entry.wave || 0),
        seq: Math.max(already ? already.seq : 0, Number.isInteger(entry.seq) ? entry.seq : 0),
        reason: str(entry.reason) || (already && already.reason) || '',
      })
      continue
    }

    for (const id of entry.merged || []) {
      landed.add(id)
      approved.delete(id)
      verified.delete(id)
      escalated.delete(id)
    }

    // The two facts kept about an escalation aggregate in OPPOSITE directions, and conflating
    // them is a real defect. `wave` — FIRST line wins: the first line naming an id is the wave
    // it actually escalated in, and last-wins would report a wave the order was never in.
    // `seq` — LAST line wins: this is the ordering, and the question is whether the escalation
    // is still the newest word about the order. Holding the first seq would let a retry's green
    // clear a verdict the run had just reached for the second time.
    for (const id of entry.escalated || []) {
      if (!id || landed.has(id)) continue
      const already = escalated.get(id)
      escalated.set(id, {
        wave: already ? already.wave : (entry.wave || 0),
        seq: Math.max(already ? already.seq : 0, Number.isInteger(entry.seq) ? entry.seq : 0),
        reason: already ? already.reason : '',
      })
    }

    for (const item of entry.discovered || []) {
      if (typeof item === 'string' && item.trim()) knowledge.add(item.trim())
    }
    if (entry.integration_base) integration.base_sha = entry.integration_base
    if (entry.integration_head) integration.head_sha = entry.integration_head
  }

  for (const entry of journal.entries) {
    bump(entry)

    if (entry.kind === 'discovery') {
      // Journalled by whoever learned it, once, instead of re-listed cumulatively on every
      // wave line. `order` is optional here — a discovery belongs to the run, not to an order.
      if (entry.notes.trim()) knowledge.add(entry.notes.trim())
      continue
    }

    if (!entry.order || !orderById.has(entry.order)) {
      unusable += 1
      continue
    }

    if (entry.kind === 'merge-observed') {
      mergeObserved.set(entry.order, { branch: entry.branch, head_sha: entry.head_sha })
      continue
    }

    // A coder saying its series is COMPLETE. Without it, "the branch has commits" cannot be
    // told apart from "the branch has commits and the coder died halfway through commit four",
    // and git cannot answer that question — only the author knows.
    if (entry.kind === 'coder-done') {
      coderDone.set(entry.order, { head_sha: entry.head_sha, commits: entry.commits })
      continue
    }

    if (entry.kind === 'review-observed') {
      reviewRounds.set(entry.order, (reviewRounds.get(entry.order) || 0) + 1)
      continue
    }

    if (entry.kind !== 'verify-observed') {
      unusable += 1
      continue
    }

    if (!entry.recorded) incomplete += 1

    // Last line wins per order, in file order: a fix round moves the head and measures again,
    // and a later red measurement must not be shadowed by an earlier green one.
    if (entry.recorded && verifyOk(entry, orderById.get(entry.order))) {
      verified.set(entry.order, {
        branch: entry.branch,
        worktree: entry.worktree,
        head_sha: entry.head_sha,
        measured: measuredOf(entry),
        seq: entry.seq,
        source: 'journal',
      })
    } else {
      verified.delete(entry.order)
    }
  }

  // A stage the workflow already recorded as closed outranks a measurement of it: an approved
  // order is not also waiting to be reviewed.
  for (const id of approved.keys()) verified.delete(id)
  for (const id of landed) verified.delete(id)

  // A later green clears an earlier escalation across both files, which works only because both
  // share one counter. Strictly greater: equal means neither preceded the other — two lines
  // written before the counter existed both sit at 0 — and there the honest answer is that the
  // log cannot say, so the escalation stands.
  for (const [id, prior] of [...escalated]) {
    const green = verified.get(id)
    if (green && green.seq > prior.seq) escalated.delete(id)
  }

  return {
    landed, approved, verified, escalated, mergeObserved, coderDone, reviewRounds,
    knowledge, integration, seqMax, incomplete, unusable,
    // Whether this run's coders were writing completion lines at all. It is what makes the
    // absence of one for a given order mean something rather than nothing.
    speaksCoderDone: coderDone.size > 0,
  }
}

/**
 * What a recorded measurement mechanically CHECKED. Informational; never a verdict.
 *
 * `absent` does not count, and the asymmetry is the whole point of the field. An absent build
 * is a fact about the repository, not a check that ran — and an order with an empty `measured`
 * is one the caller reports as reviewed but mechanically unverified. Counting `absent` here
 * would let a docs-only order in a repository with no build and no suite come back "measured:
 * build, suite" and clear the vacuity check, which is IRON LAW §4 exactly: a partial result
 * wearing a complete one's label.
 *
 * A behavioural copy of the same function in workflows/agentics-develop.workflow.js, pinned by
 * test/run-verdict.test.mjs. An earlier version of this copy inverted the `absent` case, so the
 * same verifier observation produced `[]` on the fresh path and `['build','suite']` on the
 * resume path — and flipped `coverage.complete` between them.
 */
export function measuredOf(entry) {
  const out = []
  if (entry.build !== 'absent') out.push('build')
  if (entry.typecheck !== 'absent') out.push('typecheck')
  if (entry.suite !== 'absent') out.push('suite')
  if ((entry.discriminator || []).length > 0) out.push('discriminator:' + entry.discriminator.length)
  return out
}

/**
 * Pure. The single action one order resumes at.
 *
 * The ladder walks the lifecycle backwards and stops at the first rung two independent sources
 * agree on: the run said the stage closed, AND git still holds the head it closed over. Where
 * they disagree the stage is redone over what is actually there — not a problem, just a branch
 * that moved after the stage closed.
 *
 * `escalated` is reported rather than acted on. Whether an escalation is retried is the
 * caller's policy (`retry_escalated`), and a lib that decided it here would take that lever
 * away from the human holding it.
 */
export function nextActionFor(id, wo, r, git) {
  const branchFacts = git.branches[id] || null
  const approvedRec = r.approved.get(id)
  const verifiedRec = r.verified.get(id)
  const merged = r.mergeObserved.get(id)

  // `merged_source` is the machine-readable half and `stage_note` is the human half. They are
  // separate fields on purpose: the caller acts on the first and prints the second, so the
  // wording can be improved without changing what any code does. An earlier draft had the
  // caller sniff a prefix of the prose, which made every reconciled merge depend on a sentence
  // nobody would think to treat as an interface.
  const note = (next, why, merged_source = '') => ({ next_action: next, stage_note: why, merged_source })

  if (r.landed.has(id)) {
    return note('none', 'merged by an earlier invocation, per the run log', 'log')
  }

  // Git says this branch is already in the integration branch. Ancestry alone cannot stand:
  // a coder cuts its branch AT the integration head, so a branch whose coder died before its
  // first commit is an ancestor too, and marking that one merged would land an order nobody
  // implemented. A second witness is required — the approval line written the instant the
  // review closed, or the merge line the merging agent wrote inside the merge itself. The two
  // fail independently, which is the point of having both.
  if (branchFacts && branchFacts.already_merged) {
    const witnessed = (approvedRec && approvedRec.head_sha === branchFacts.head_sha) ||
      (merged && merged.branch === branchFacts.branch)
    // `git` rather than `log`: the merge happened and no wave line mentions it, so the caller
    // owes this run a corrective record. Without one, `runs` reports the order unreached
    // forever and every later resume asks git the same question again.
    if (witnessed) {
      return note('none', 'already in the integration branch; the merge was made but never recorded', 'git')
    }
  }

  if (approvedRec && branchFacts && approvedRec.head_sha === branchFacts.head_sha) {
    return note('merge', 'approved by an earlier invocation and unchanged in git')
  }

  if (verifiedRec && branchFacts && verifiedRec.head_sha === branchFacts.head_sha) {
    return note('review', 'verified green at this exact head; verification is not re-bought')
  }

  if (branchFacts && branchFacts.commits.length > 0) {
    // A checkpoint at the tip settles the question before anything else is consulted. It is
    // the coder's own signature on "I stopped here, unfinished", written in the execution that
    // stopped — the strongest evidence anything in this ladder ever gets. It outranks a
    // `coder-done` line for the same order (they contradict, and the safe reading of a
    // contradiction is the one that carries the series on rather than measuring it as whole)
    // and it does not need `speaksCoderDone`, because it is positive evidence rather than an
    // absence somebody has to interpret. That is the difference between an inheritance that is
    // vouched for and one adopted by grace.
    if (branchFacts.checkpoint_head) {
      return note('continue-series',
        'the tip is a checkpoint its coder committed on the way out; the series is unfinished ' +
        'by its author\'s own word')
    }

    // The coder finished and the run died before verification, or the coder itself died
    // mid-series. `coder-done` is the only thing that can tell those apart — git sees commits
    // either way — and the difference decides whether the series is measured as it stands or
    // carried on from its last commit.
    const done = r.coderDone.get(id)
    if (done) {
      return note('verify', done.head_sha === branchFacts.head_sha
        ? 'a completed series an interrupted invocation left on its branch'
        : 'a series whose completion was recorded at a different head; measured as it stands')
    }

    // No completion record for THIS order. Whether that means "the coder died mid-series"
    // depends on whether this run's coders were writing the line at all: `speaksCoderDone` is
    // true only when some other order in the same run recorded one. Without that evidence the
    // absence says nothing — every run planned before this version has commits and no
    // `coder-done` anywhere — and dispatching a coder to "continue" a series that was actually
    // finished would buy a wasted round and, worse, invite commits nobody asked for. Measuring
    // what is there is the older, safe reading, and it is what a legacy run gets.
    return r.speaksCoderDone
      ? note('continue-series', 'commits on the branch that no coder ever reported finishing')
      : note('verify', 'commits an interrupted invocation left on its branch, measured as they stand')
  }

  return note('code', branchFacts ? 'a branch with no commits on it' : 'nothing on disk for this order')
}

/**
 * Pure. The whole verdict.
 *
 * @param {string} runstamp
 * @param {object|null} plan parsed plan.json, or null when it could not be read
 * @param {string} stateRaw raw state.jsonl
 * @param {string} journalRaw raw journal.jsonl
 * @param {object} git the answers gathered below, or the empty set on the clean path
 * @param {string[]} readNotes what the reader could not read, carried in rather than lost
 */
export function deriveVerdict(runstamp, plan, stateRaw, journalRaw, git, readNotes = []) {
  const notes = readNotes.slice()

  if (!plan) {
    return { stop_reason: 'unreadable', runstamp, clean: false, notes, orders: [] }
  }

  const workOrders = Array.isArray(plan.work_orders) ? plan.work_orders : []
  const orderById = new Map(workOrders.filter((wo) => wo && wo.id).map((wo) => [wo.id, wo]))

  const state = parseState(stateRaw)
  const journal = parseJournal(journalRaw)
  if (state.torn > 0) notes.push(state.torn + ' state line(s) would not parse and were skipped')
  if (journal.torn > 0) {
    notes.push(journal.torn + ' journal line(s) would not parse and were skipped — a torn line ' +
      'is what an interrupted append looks like')
  }

  const r = replay(state.entries, journal, orderById)

  if (r.incomplete > 0) {
    notes.push(r.incomplete + ' journalled measurement(s) did not record everything a verdict ' +
      'is computed from and were not read as one; those orders are measured again')
  }
  if (r.unusable > 0) {
    notes.push(r.unusable + ' journal line(s) named no order this plan carries, or a kind this ' +
      'version does not read, and were skipped')
  }

  const partition = partitionOf(plan)
  if (partition.note) notes.push(partition.note)

  const orders = workOrders.filter((wo) => wo && wo.id).map((wo) => {
    const facts = git.branches[wo.id] || null
    const esc = r.escalated.get(wo.id)
    const verifiedRec = r.verified.get(wo.id)
    const { next_action, stage_note, merged_source } = nextActionFor(wo.id, wo, r, git)

    return {
      id: wo.id,
      title: str(wo.title),
      role: str(wo.role) || 'none',
      // Both of the planner's per-order dials, and they travel for the same reason `role` does:
      // they are read by arithmetic on the other side, not by a human. `weight` was missing here
      // until 20260902-124933, where the omission was invisible in the ordinary way — every
      // resumed order simply priced as `standard`, because that is what `weightOf` calls a
      // missing field. In that run `assetpaths` was planned `light`, coded at sonnet on the
      // fresh dispatch, and on the resume coded and REVIEWED at the run's ceiling instead.
      // A dial nobody can see moving is a dial that does nothing.
      weight: str(wo.weight) || 'standard',
      // Path lists are arithmetic, not prose: the staleness gate, the independence partition
      // and the verifier's own locus flags all read them here. The prose — context, acceptance,
      // reads' rationale — never enters this payload and is fetched from plan.json by whoever
      // consumes it.
      locus: Array.isArray(wo.locus) ? wo.locus : [],
      reads: Array.isArray(wo.reads) ? wo.reads : [],
      deps: Array.isArray(wo.deps) ? wo.deps : [],
      contract: wo.contract === true,
      acceptance_n: Array.isArray(wo.acceptance) ? wo.acceptance.length : 0,
      locus_n: Array.isArray(wo.locus) ? wo.locus.length : 0,
      // The pin. Whoever fetches this order's prose recomputes this over what it read, so an
      // order edited on disk since the plan was ratified cannot reach a coder unnoticed.
      digest: digestOrder(wo),
      next_action,
      stage_note,
      // '' unless the order is merged; 'log' when a wave line records it, 'git' when only git
      // holds it and the caller still owes this run the corrective line.
      merged_source,
      branch: facts ? facts.branch : '',
      worktree: facts ? facts.worktree : '',
      base_sha: facts ? facts.base_sha : '',
      head_sha: facts ? facts.head_sha : '',
      commits: facts ? facts.commits : [],
      dirty: facts ? facts.dirty : [],
      already_merged: facts ? facts.already_merged === true : false,
      // What the closing stage mechanically checked. The APPROVAL record wins where there is
      // one: an approved order is merged as it stands, and its line is the newer word about
      // what was measured. Reading only the verification record would report an approved order
      // as having measured nothing, which is how a salvaged merge loses the evidence behind it.
      measured: (r.approved.get(wo.id) || verifiedRec || {}).measured || [],
      verified_source: verifiedRec ? verifiedRec.source : '',
      verified_seq: verifiedRec ? verifiedRec.seq : 0,
      escalated: esc ? true : false,
      escalated_wave: esc ? esc.wave : 0,
      escalated_seq: esc ? esc.seq : 0,
      // The cause, where the ledger recorded one. Without it the carried-escalation report
      // tells a human the run holds ids and no trail and sends them to a transcript from a
      // session that may be gone — while state.jsonl holds the answer. `order-escalated`
      // carries this field for no other purpose.
      escalated_reason: esc ? (esc.reason || '') : '',
      review_rounds: r.reviewRounds.get(wo.id) || 0,
    }
  })

  const callerNotes = str(plan.caller_notes)

  return {
    stop_reason: 'loaded',
    runstamp,
    // Said out loud so the caller can log it, and so a test can pin that the short-circuit
    // really did fire rather than merely producing the same answer the long way round.
    clean: git.clean === true,
    plan_path: str(plan.plan_path) || '',
    // The conditions the run was planned under. `caller_notes` is described rather than
    // carried: it is the largest string in the envelope and every consumer of it is an agent
    // that can read it off disk, so it travels by reference like the order prose does.
    envelope: {
      change: str(plan.change),
      roots: str(plan.roots),
      intelligence: str(plan.intelligence),
      base_branch: str(plan.base_branch),
      base_sha: str(plan.base_sha),
      programme: str(plan.programme),
      slice: str(plan.slice),
      caller_notes_len: callerNotes.length,
      caller_notes_digest: callerNotes ? fnv1a(callerNotes) : '',
    },
    // `blocking_gaps` and nothing else. The plan's own `notes` and its `shared_files` used to
    // ride the resume too, and neither was ever read on that path — `shared_files` is an input
    // to the partition the planner already ran, and the notes are prose for a human who has
    // plan.md in front of them. Carrying 8KB of unread prose is not free: transcription
    // fidelity falls off with payload length, so every field that travels has to earn it.
    plan: {
      blocking_gaps: Array.isArray(plan.blocking_gaps) ? plan.blocking_gaps : [],
    },
    partition: { waves: partition.waves, coupled: partition.coupled, note: partition.note },
    orders,
    integration: {
      base_sha: r.integration.base_sha,
      head_sha: r.integration.head_sha,
      branch: git.integration_branch || '',
      observed_head: git.integration_head || '',
    },
    knowledge: [...r.knowledge],
    seq_max: r.seqMax,
    last_wave: state.entries.reduce(
      (n, e) => Math.max(n, (e.kind || 'wave') === 'wave' ? (e.wave || 0) : 0), 0),
    notes,
  }
}

// ---------------------------------------------------------------- the git reader
//
// Everything below shells out. Kept apart from the core above so the arithmetic can be tested
// without building a repository per case — the same split lib/run-status.mjs uses.

const git = (root, args) => {
  const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (run.error || run.status === null) return { ok: false, out: '', status: -1 }
  return { ok: run.status === 0, out: (run.stdout || '').trim(), status: run.status }
}

/** Worktree path per branch, from git's own porcelain listing. */
function worktreesByBranch(root) {
  const out = new Map()
  const res = git(root, ['worktree', 'list', '--porcelain'])
  if (!res.ok) return out

  let path = ''
  for (const line of res.out.split('\n')) {
    if (line.startsWith('worktree ')) path = posix(line.slice('worktree '.length).trim())
    else if (line.startsWith('branch ')) {
      out.set(line.slice('branch refs/heads/'.length).trim(), path)
    }
  }
  return out
}

/**
 * What git holds for this run, per order.
 *
 * The branch listing comes FIRST and bounds everything else. Order branches are named
 * deterministically, so one glob says exactly which of this run's orders were ever started —
 * and when it comes back empty alongside an empty ledger, nothing further is asked. That is the
 * clean-state short-circuit: a parked plan opens for the cost of one `git branch --list`.
 */
export function gitFacts(root, runstamp, orderIds, hasRecords, planBase = '') {
  const empty = { clean: true, branches: {}, integration_branch: '', integration_head: '' }
  if (!runstamp) return empty

  const integrationBranch = 'agentics/' + runstamp + '-integration'
  const listed = git(root, ['branch', '--list', 'agentics/' + runstamp + '-*',
    '--format=%(refname:short)'])
  const present = new Set(listed.ok && listed.out ? listed.out.split('\n').map((s) => s.trim()) : [])

  const started = orderIds.filter((id) => present.has('agentics/' + runstamp + '-' + id))

  // Nothing recorded and nothing built. There is no third source of salvage, so the question is
  // settled without another git call, and every order is `code` by definition rather than by
  // investigation.
  if (!hasRecords && started.length === 0) return empty

  const head = git(root, ['rev-parse', integrationBranch])
  const integrationHead = head.ok ? head.out : ''
  const worktrees = worktreesByBranch(root)
  const branches = {}

  for (const id of started) {
    const branch = 'agentics/' + runstamp + '-' + id
    const rev = git(root, ['rev-parse', branch])
    if (!rev.ok || !SHA_RE.test(rev.out)) continue

    // The fork point, observed rather than assumed: it is the baseline a discriminator gets
    // measured against, so an assumed value is a verdict computed against the wrong tree.
    //
    // The integration branch is the natural other side of that merge-base, and it is NOT always
    // there. The develop skill tells the session to delete it once the human has accepted the
    // change, while escalated and blocked orders keep their branches and the run directory is
    // kept for a retry. Falling back to the plan's own base_sha is what keeps those branches
    // readable: without it every one of them reported `commits: []`, which `nextActionFor`
    // reads as `code` — and a coder dispatched at `code` re-anchors the branch, so a committed,
    // reviewed series would have survived only in the reflog. "Committed work is scavengeable
    // by right" failing at exactly the moment it is most expensive.
    const against = integrationHead ? integrationBranch : (planBase || '')
    const forkPoint = against ? git(root, ['merge-base', branch, against]) : { ok: false, out: '' }
    const base = forkPoint.ok ? forkPoint.out : ''
    // Exit 0 is yes, 1 is no, anything else is git unable to answer — which is not the same as
    // answering no, so it is left false and the order falls to a lower rung rather than being
    // marked merged on a failure to ask.
    const ancestor = integrationHead
      ? git(root, ['merge-base', '--is-ancestor', branch, integrationBranch])
      : { status: 1 }

    // The `agentics-checkpoint` trailer sits between the sha and the subject rather than after it,
    // so the subject stays the last field and may contain anything at all. A trailer value
    // cannot contain a tab; a subject, in principle, can.
    const format = '%H%x09%(trailers:key=' + CHECKPOINT_TRAILER +
      ',valueonly,separator=%x2C)%x09%s'
    const log = base
      ? git(root, ['log', '--reverse', '--format=' + format, base + '..' + branch])
      : { ok: false, out: '' }

    const entries = log.ok && log.out
      ? log.out.split('\n').map((line) => {
        const first = line.indexOf('\t')
        const second = line.indexOf('\t', first + 1)
        return {
          sha: line.slice(0, first),
          trailers: second === -1 ? '' : line.slice(first + 1, second),
          subject: second === -1 ? line.slice(first + 1) : line.slice(second + 1),
        }
      })
      : []

    // The trailers do NOT travel: the payload carries `{sha, subject}` per commit exactly as
    // before, and the one thing a resume decides on — is the TIP a checkpoint — is a single
    // boolean derived here. A per-commit trailer field would ride every resume of every run to
    // be read by nobody.
    const commits = entries.map(({ sha, subject }) => ({ sha, subject }))
    const tip = entries.length > 0 ? entries[entries.length - 1] : null

    const worktree = worktrees.get(branch) || ''
    // Uncommitted work is reported as a fact and adopted by nobody automatically. It is the one
    // thing no record vouches for, so the ledger names it and a coder rules on it.
    const dirtyRes = worktree ? git(worktree, ['status', '--porcelain']) : { ok: false, out: '' }
    const dirty = dirtyRes.ok && dirtyRes.out
      ? dirtyRes.out.split('\n').map((l) => l.trim()).filter(Boolean)
      : []

    branches[id] = {
      branch,
      head_sha: rev.out,
      base_sha: base,
      commits,
      worktree,
      dirty,
      already_merged: ancestor.status === 0,
      checkpoint_head: tip ? isCheckpoint(tip) : false,
    }
  }

  return {
    clean: false,
    branches,
    integration_branch: integrationBranch,
    integration_head: integrationHead,
  }
}

/** Read a file, returning '' when it is not there — absence is a fact about how far a run got. */
const readOr = (path, notes, what) => {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if (err && err.code !== 'ENOENT' && notes) notes.push(what + ' could not be read: ' + err.message)
    return ''
  }
}

/** The whole computation, from a repository root and a run directory. */
/**
 * Pure. The repository a run belongs to, worked out from the run itself.
 *
 * A run directory is `<root>/.claude/agentics/runs/<runstamp>` by construction — RUNS_DIR is fixed —
 * so the root is four segments up. That derivation is what makes this function answerable
 * WITHOUT being told, which matters more than it looks: the caller that asks for a verdict does
 * not yet know the run's roots, because the roots are recorded inside the plan the verdict is
 * about to read. Asking it to supply one first is a chicken-and-egg that resolves, in practice,
 * to whatever directory the shell happened to be in.
 *
 * Order of trust: what the PLAN recorded, then the caller's hint, then the derivation. The plan
 * wins because it is the only one of the three that was written by the run being resumed.
 */
export function rootFor(plan, runDir, hint) {
  const recorded = plan && typeof plan.roots === 'string' ? plan.roots.split(',')[0].trim() : ''
  if (recorded) return posix(recorded).replace(/\/+$/, '')

  const parts = posix(runDir).replace(/\/+$/, '').split('/')
  const at = parts.lastIndexOf('.claude')
  if (at > 0 && parts.slice(at).join('/').startsWith('.claude/agentics/runs/')) {
    return parts.slice(0, at).join('/')
  }

  return posix(hint || '').replace(/\/+$/, '') || '.'
}

export function verdictFor(hint, runDir) {
  const notes = []
  const runstamp = posix(runDir).replace(/\/+$/, '').split('/').pop() || ''
  const wrap = (payload) => ({ payload, payload_digest: fnv1a(canonical(payload)) })

  let plan = null
  try {
    plan = JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8'))
  } catch (err) {
    notes.push('plan.json could not be read: ' + err.message)
  }

  // Wrapped like every other answer. An unwrapped payload here used to make the caller's
  // envelope check reject it as a TRANSPORT failure — so a run whose plan.json was deleted
  // bought a pointless retry one tier up and was told the courier had failed, while the real
  // reason sat in `notes` and never reached anyone. IRON LAW §7: "I couldn't" and "there is
  // nothing there" are different answers.
  if (!plan) return wrap(deriveVerdict(runstamp, null, '', '', { clean: false, branches: {} }, notes))

  const root = rootFor(plan, runDir, hint)
  const stateRaw = readOr(join(runDir, 'state.jsonl'), notes, 'state.jsonl')
  const journalRaw = readOr(join(runDir, 'journal.jsonl'), notes, 'journal.jsonl')
  const orderIds = (Array.isArray(plan.work_orders) ? plan.work_orders : [])
    .map((wo) => wo && wo.id).filter(Boolean)

  const facts = gitFacts(root, runstamp, orderIds,
    stateRaw.trim() !== '' || journalRaw.trim() !== '',
    typeof plan.base_sha === 'string' ? plan.base_sha : '')

  const payload = deriveVerdict(runstamp, plan, stateRaw, journalRaw, facts, notes)
  payload.root = root
  return wrap(payload)
}

// The CLI, guarded the way this plugin's other libs are. `import.meta.main` is undefined before
// Node 24.2; the argv comparison keeps the CLI alive there — a silently no-op verdict would
// tell a resume that a repository full of finished work holds none.
const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const root = process.argv[2] || process.cwd()
    const runDir = process.argv[3]
    if (!runDir) throw new Error('usage: run-verdict.mjs <repo-root> <run-directory>')

    console.log(JSON.stringify(verdictFor(root, runDir)))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
