// lib/boundaries/spec.mjs — the autonomous review's boundaries, in-process: a planner-written spec
// checked, each probe round recorded, the planner's settlement read, the gate, and the preparation
// that compiles the folder.
//
// Design: docs/DESIGN.md#autonomous-review.

import { approvalGate, recordDisposition, recordPreparation, reviewedFromResult } from '../approval.mjs'
import { compileEffort } from '../compile.mjs'
import { readLog } from '../ledger.mjs'
import { offload } from '../offload.mjs'
import { checkFolder } from '../spec.mjs'
import { posix, readJson, returnPath, specPath } from '../store.mjs'
import { childrenOf, readTree } from '../tree.mjs'
import { escalated, faultRecords, message, parked, recordAll } from './records.mjs'

const list = (v) => (Array.isArray(v) ? v : [])
const latest = (entries, pred) => entries.reduce((found, e) => (pred(e) && (!found || e.seq > found.seq) ? e : found), null)

const plannerThread = (folder) => 'planner:' + folder
const problemsText = (problems) => list(problems).map((p) => p.file + ':' + p.line + ' ' + p.problem).join('; ')
const refusal = (error) => ({ ok: false, error: typeof error === 'string' ? { kind: 'refused', message: error } : error, stops: [] })

/** The round a planner dispatch ran as, from its `dispatched` record; 0 when the log holds none. */
const roundOf = (xc, dispatch) => (latest(xc.log.entries(), (e) => e.kind === 'dispatched' && e.dispatch === dispatch) || {}).round || 0

/**
 * The `msg` messages code sent the folder's planner for rounds up to `round`: what the round that
 * dispatch ran had been told. A message this boundary sent for the next round is not among them,
 * so a call run again finds only what came before it.
 */
const toldUpTo = (xc, folder, msg, round) => xc.log.entries()
  .filter((e) => e.kind === 'message' && e.node === folder && e.thread === plannerThread(folder) && e.msg === msg && e.round <= round)

const ledgerOf = (xc, folder) => readLog(xc.repo, xc.effort, 'ledger').entries.filter((e) => e.folder === folder)

/** A `role` fault on the folder: the planner or a prober returned nothing. */
function heldOn(xc, folder, detail) {
  const tree = readTree(xc.repo, xc.effort)
  return faultRecords(folder, 'role', detail, {
    nodes: tree.nodes, events: tree.events, state: readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries,
  })
}

/**
 * What a planner-written spec says about itself: where it is, its hash, how many decisions it
 * states and every problem `checkFolder` finds in its place in the effort. A folder its parent does
 * not give to the planner (`users`) is a problem too.
 */
function specFacts(xc, folder) {
  const checked = checkFolder(xc.repo, xc.effort, folder)
  const users = checked.exists && checked.authoredBy !== 'planner'
  return {
    spec_path: posix(specPath(xc.repo, xc.effort, folder)), exists: checked.exists, hash: checked.hash,
    decisions_n: checked.spec ? checked.spec.decisions.length : 0, users,
    problems: [...checked.problems, ...(users ? [{ file: checked.file, line: 1, problem: 'the parent spec gives ' + folder + ' to the user, not to the planner' }] : [])],
  }
}

/** Pure. What makes two problems the same problem: its file and its text, wherever its line moved. */
const problemKey = (p) => p.file + ' ' + p.problem

/**
 * Pure. The problems of the preview that the planner's spec causes: those that vanish when its spec
 * is reverted. A filter by cause, never by file: a refusal that stands without the planner's edit is
 * no revision of its to make.
 */
export function plannerCaused(preview, reverted) {
  const standing = new Set(list(reverted).map(problemKey))
  return list(preview).filter((p) => !standing.has(problemKey(p)))
}

/**
 * What compile would refuse in a planner's spec that checks clean, prepared as it stands, and that its
 * spec causes (`plannerCaused`, over one more compile with the spec reverted): the tree's guards (a
 * contract dropped, a decision stated) bind a planner's spec as they bind its preparation, so the
 * planner meets them while it can still revise, not after the round is spent. Both compiles are
 * dry: the reverted one previews no folder, so the edited spec is kept at the text it was compiled
 * from, and a check writes nothing. Each compile reads every spec of the folder, so a program runs
 * this on the offload worker.
 */
export function compileProblems(repo, effort, folder) {
  const preview = compileEffort(repo, effort, { folder, preview: folder, previewAs: 'prepared' })
  if (preview.ok) return []
  return plannerCaused(preview.problems, compileEffort(repo, effort, { folder, preview: null }).problems)
}

// ------------------------------------------------------------------ check

/**
 * Pure. What the planner's return decides about the spec it was sent to write: nothing when it
 * wrote it, or settled a review by editing it; a park for a need only the user can meet; an
 * escalation otherwise. The words are in the dispatch's stored return, which the stop names.
 */
function planOutcome(node, ret, dispatch) {
  if (!ret) return { next: 'held' }
  if (ret.status === 'written' || ret.status === 'settled') return null
  if (['needs_decision', 'contract_changed', 'premise_mismatch'].includes(ret.status)) return { next: 'stopped', records: [parked(node, ret.status, '', dispatch)] }
  return { next: 'stopped', records: [escalated(node, 'plan_' + ret.status, '', dispatch)] }
}

/** Pure. Two lists of problems are the same problems when they name the same files and texts, wherever the lines moved. */
const problemSet = (problems) => [...new Set(list(problems).map((p) => p.file + ' ' + p.problem))].sort().join('\n')

/**
 * Pure. What a spec check decides: a Decisions row parks the folder (only the user states
 * decisions); a folder the planner does not own, or the problems the planner was already sent,
 * escalate; other problems go to the planner's next round as a `problems` message.
 */
function specStops(node, facts, told, round) {
  if (facts.decisions_n > 0) {
    return [parked(node, 'needs_decision', facts.spec_path + ' states ' + facts.decisions_n + ' decision(s): only the user states decisions')]
  }
  if (facts.problems.length === 0) return []
  const again = told.some((m) => problemSet(m.payload && m.payload.problems) === problemSet(facts.problems))
  if (facts.users || again) return [escalated(node, 'spec_refused', problemsText(facts.problems))]
  return [message(node, plannerThread(node), 'problems', { problems: facts.problems }, round + 1)]
}

/**
 * Close the planner's dispatch on the folder's spec, then check the spec it wrote. With no
 * `dispatch` the spec is the session's edit: there is no return to close, and `users` checks it
 * as the user's, whose problems escalate rather than go to the planner.
 */
export async function specCheck(xc, { folder, dispatch, users = false }) {
  const out = dispatch ? planOutcome(folder, readJson(returnPath(xc.dir, dispatch)), dispatch) : null
  if (out) {
    const records = out.next === 'held' ? heldOn(xc, folder, 'the planner returned nothing') : out.records
    return { status: out.next, stops: recordAll(xc, records).stops }
  }
  const checked = specFacts(xc, folder)
  const facts = checked.problems.length || !checked.exists || checked.users || users ? checked
    : { ...checked, problems: await offload('boundaries/spec.mjs', 'compileProblems', [xc.repo, xc.effort, folder], { label: 'the compile preview of ' + folder }) }
  const round = dispatch ? roundOf(xc, dispatch) : 0
  const records = specStops(folder, users ? { ...facts, users: true } : facts, toldUpTo(xc, folder, 'problems', round), round)
  const { stops } = recordAll(xc, records)
  return {
    status: stops.length ? 'stopped' : records.length ? 'problems' : 'checked',
    spec_path: facts.spec_path, exists: facts.exists, hash: facts.hash, decisions_n: facts.decisions_n, problems_n: facts.problems.length, stops,
  }
}

// ------------------------------------------------------------------ reviewed

/** The findings a probe round wrote to its file, in full; [] when there is none to read. */
function findingsIn(path) {
  const read = path ? readJson(path) : null
  return Array.isArray(read) ? read : list(read && read.findings)
}

/** What makes two review findings the same finding across rounds: its axis, its section, its claim. */
const findingKey = (f) => [f.axis, f.section, String(f.claim || '').toLowerCase().replace(/\s+/g, ' ').trim()].join('|')

/** A finding's settlement id: its evidence item, or the reviewed hash and its id when the round could not anchor it. */
const settlementId = (hash) => (f) => f.item || hash + '#' + f.id

/** The spec hash a probe round read, from its snapshot; '' when it kept none. */
const hashOf = (result) => (/^snapshot:([0-9a-f]{8})$/.exec(String((result && result.snapshot) || '')) || [])[1] || ''

/**
 * Pure. What a recorded round stops: a partial round escalates naming what it left; a finding
 * still to settle that is back unchanged after the round before it was incorporated escalates as
 * not converging. `fresh` are the ids of the ambiguities and gaps no disposition has settled: a
 * note is advisory, so it stays in the round's record and never edits the text it reviewed.
 */
function reviewedOutcome(node, line, { findings, previous, previousHash, dispositions }) {
  if (!line.complete) return { fresh: [], records: [escalated(node, 'review_incomplete', list(line.remaining).join('; '))] }
  const idOf = settlementId(line.hash)
  const settled = new Set(dispositions.map((d) => d.finding))
  const fresh = findings.filter((f) => f.severity !== 'note' && !settled.has(idOf(f)))
  const incorporated = new Set(dispositions.filter((d) => d.outcome === 'incorporated').map((d) => d.finding))
  const prevId = settlementId(previousHash)
  const back = new Set(previous.filter((f) => incorporated.has(prevId(f))).map(findingKey))
  const again = fresh.find((f) => back.has(findingKey(f)))
  return {
    fresh: fresh.map((f) => f.id),
    records: again ? [escalated(node, 'review_not_converging', 'finding ' + again.id + ' came back unchanged after it was incorporated')] : [],
  }
}

/**
 * Record one probe round of the folder's spec from the nested probe's result. A round a prober's
 * brief past its budget left unsent, for a part only the user can shrink (the spec, a guidance
 * file), escalates the folder `brief_too_large`; one a prober's fault cut short records nothing and
 * holds the folder; a result `reviewedFromResult` refuses is returned as its refusal. Run again over
 * one result, it stops nothing twice; a relaunch reaches a round already recorded through the
 * program's journal, never through this call.
 */
export function specReviewed(xc, { folder, result, previous = null }) {
  const owned = list(result && result.refused).find((r) => r.owner !== 'code')
  if (owned) return { status: 'stopped', fresh: [], stops: recordAll(xc, [escalated(folder, 'brief_too_large', owned.prober + ': ' + owned.message)]).stops }
  if (list(result && result.coverage && result.coverage.failed_channels).includes('probe')) {
    const why = [
      ...list(result.coverage.unreached).filter((u) => /^prober:\d+ failed \(/.test(u)).map((u) => u.slice(0, u.indexOf(')') + 1)),
      ...list(result.refused).map((r) => r.prober + ': ' + r.message),
    ]
    return { status: 'held', fresh: [], stops: recordAll(xc, heldOn(xc, folder, 'a prober returned nothing, so the round was not recorded' + (why.length ? ': ' + why.join('; ') : ''))).stops }
  }
  const recorded = reviewedFromResult(xc.repo, xc.effort, folder, result)
  if (!recorded.ok) return { ...refusal(recorded.error), fresh: [] }
  const ledger = ledgerOf(xc, folder)
  const out = reviewedOutcome(folder, ledger.find((e) => e.seq === recorded.seq), {
    findings: findingsIn(result.findings_file), previous: findingsIn(previous && previous.findings_file), previousHash: hashOf(previous),
    dispositions: ledger.filter((e) => e.kind === 'disposition'),
  })
  const { stops } = recordAll(xc, out.records)
  return { status: stops.length ? 'stopped' : 'recorded', fresh: out.fresh, stops }
}

// ------------------------------------------------------------------ settle

/**
 * Pure. The planner's settlement of the findings it was asked about, each an ambiguity or a gap.
 * Every one needs a disposition, and none may be discarded; a settlement that breaks either is
 * refused once, and a finding refused before (`refused`, settlement ids) that is wrong again
 * escalates.
 */
function settleOutcome(node, ret, { findings, hash, refused, dispatch }) {
  if (ret.status === 'needs_decision') return { next: 'stopped', records: [parked(node, 'needs_decision', '', dispatch)] }
  if (ret.status === 'blocked') return { next: 'stopped', records: [escalated(node, 'blocked', '', dispatch)] }
  const idOf = settlementId(hash)
  const outcome = new Map(list(ret.dispositions).filter((d) => d && d.finding).map((d) => [d.finding, d.outcome]))
  const wrong = findings.filter((f) => outcome.get(f.id) !== 'incorporated')
  if (wrong.length === 0) return { next: 'settled', dispositions: findings.map((f) => ({ finding: idOf(f), outcome: outcome.get(f.id) })) }
  const again = wrong.find((f) => refused.has(idOf(f)))
  if (again) {
    return { next: 'stopped', records: [escalated(node, 'review_not_converging', 'the planner left ' + again.id + ' (' + again.severity + ') unincorporated after it was refused')] }
  }
  return {
    next: 'refused',
    refusals: wrong.map((f) => ({
      id: f.id, finding: idOf(f), problem: outcome.has(f.id) ? 'discarded, but an ambiguity or a gap can only be incorporated' : 'it has no disposition',
    })),
  }
}

/**
 * Close the planner's settle dispatch over `findings` (the round's finding handles it was asked
 * about) and record each disposition once, `by: planner`, under its settlement id at the hash the
 * folder's latest `reviewed` line read.
 */
export function specSettle(xc, { folder, dispatch, findings = [] }) {
  const ret = readJson(returnPath(xc.dir, dispatch))
  if (!ret) return { status: 'held', stops: recordAll(xc, heldOn(xc, folder, 'the planner returned nothing for its findings')).stops }
  const ledger = ledgerOf(xc, folder)
  const round = roundOf(xc, dispatch)
  const refused = new Set(toldUpTo(xc, folder, 'refusals', round).flatMap((m) => list(m.payload && m.payload.refusals).map((x) => x.finding)))
  const reviewed = latest(ledger, (e) => e.kind === 'reviewed')
  const out = settleOutcome(folder, ret, { findings: list(findings), hash: reviewed ? reviewed.hash : '', refused, dispatch })
  if (out.next === 'refused') {
    recordAll(xc, [message(folder, plannerThread(folder), 'refusals', { of: 'dispositions', refusals: out.refusals }, round + 1)])
    return { status: 'refused', refused: out.refusals.map((x) => x.id), stops: [] }
  }
  if (out.next === 'stopped') return { status: 'stopped', stops: recordAll(xc, out.records).stops }
  const seen = new Set(ledger.filter((e) => e.kind === 'disposition').map((e) => e.finding + '|' + e.outcome))
  for (const d of out.dispositions) {
    if (seen.has(d.finding + '|' + d.outcome)) continue
    const w = recordDisposition(xc.repo, xc.effort, folder, { ...d, by: 'planner' })
    if (!w.ok) return refusal({ kind: 'ledger', message: String(w.error) })
    seen.add(d.finding + '|' + d.outcome)
  }
  return { status: 'settled', incorporated_n: out.dispositions.filter((d) => d.outcome === 'incorporated').length, stops: [] }
}

// ------------------------------------------------------------------ gate

/** The review gate of the spec as it stands (`approvalGate`); a gate still shut on a round that edited nothing escalates. */
export function specGate(xc, { folder, edited = false }) {
  const { ratifiable, open, coverage_complete, reviewed } = approvalGate(xc.repo, xc.effort, folder)
  const records = ratifiable || edited ? [] : [escalated(folder, 'review_not_converging', 'the gate stays shut on a spec this round did not edit: open ' +
    (open.join(', ') || 'none') + (coverage_complete ? '' : '; coverage incomplete'))]
  const { stops } = recordAll(xc, records)
  return { ratifiable, status: ratifiable ? 'open' : stops.length ? 'stopped' : 'shut', open, coverage_complete, reviewed, stops }
}

// ------------------------------------------------------------------ prepare

/**
 * Pure. What a preparation records once compile ran: a compile that refused, a folder compiled with
 * nothing beneath it, and the leaf a replan was asked of left at the revision it was asked at, each
 * a stop. A leaf whose request a spec other than the one it was asked from (`replanning.from`, when
 * the request allows it) answers is not revised by it, so the answer clears it (`replanned {reason:
 * spec_answered}`): it is measured again against the folder as replanned, never routed again.
 */
function prepareOutcome(node, { compile, row, replanning, nodes, hash }) {
  if (!compile.ok) return [escalated(node, 'compile_refused', problemsText(compile.problems))]
  if (row && row.kind !== 'leaf' && row.children_n === 0) return [escalated(node, 'planner_wrote_nothing', 'compiled ' + node + ' with no plan entry beneath it')]
  const leaf = replanning ? nodes.get(replanning.node) : null
  if (!leaf || leaf.kind !== 'leaf' || (leaf.seq || 0) !== replanning.rev) return []
  if (replanning.from === undefined) return [escalated(replanning.node, 'replan_not_converging', 'the planner answered the replan without changing the leaf')]
  if (replanning.from === hash) return [escalated(replanning.node, 'replan_not_converging', 'the planner answered the request without changing the spec or the leaf')]
  return [{ kind: 'replanned', fields: { node: replanning.node, reason: 'spec_answered', by: 'planner' } }]
}

/**
 * The gate passed: record the preparation against the review it passed (once per hash and
 * review), then compile the folder. A `spec_changed` park the compile raised on this very folder
 * met the planner's own re-derivation: the preparation answers it, so it is cleared at once.
 * `replanning` `{node, rev, from?}`, when the planner answered a request of a leaf, is that leaf,
 * the revision it was asked at and the spec hash the answer started from (`replanOf`).
 */
export function specPrepare(xc, { folder, review, replanning = null, answering = 0 }) {
  const facts = specFacts(xc, folder)
  if (!facts.exists || facts.decisions_n > 0 || facts.problems.length > 0) {
    const why = [problemsText(facts.problems), facts.decisions_n ? facts.spec_path + ' states ' + facts.decisions_n + ' decision(s)' : '']
    return { status: 'stopped', stops: recordAll(xc, [escalated(folder, 'prepare_refused', why.filter(Boolean).join('; '))]).stops }
  }
  const standing = latest(ledgerOf(xc, folder), (e) => e.kind === 'prepared')
  const prepared = standing && standing.hash === facts.hash && standing.review === String(review || '').trim()
    ? standing : recordPreparation(xc.repo, xc.effort, folder, { review })
  if (prepared.ok === false) return refusal(prepared.error)
  const compile = compileEffort(xc.repo, xc.effort, { folder })
  const tree = readTree(xc.repo, xc.effort)
  const now = tree.status.get(folder) || {}
  if (now.status === 'parked' && now.last && now.last.return === 'spec_changed' && now.last.seq > prepared.seq) {
    xc.log.append('replanned', { node: folder, reason: 'spec_rederived', by: 'planner' })
  } else if (answering && now.status === 'parked' && now.last && now.last.seq === answering) {
    xc.log.append('replanned', { node: folder, reason: 'spec_edited', by: 'planner' })
  }
  const n = tree.nodes.get(folder)
  const row = n ? { kind: n.kind, rev: n.seq || 0, children_n: childrenOf(tree.nodes, folder).length } : null
  const { stops } = recordAll(xc, prepareOutcome(folder, { compile, row, replanning, nodes: tree.nodes, hash: prepared.hash }))
  return {
    status: stops.length ? 'stopped' : 'prepared', hash: prepared.hash, compile: { ok: compile.ok, written_n: list(compile.written).length }, row, stops,
  }
}
