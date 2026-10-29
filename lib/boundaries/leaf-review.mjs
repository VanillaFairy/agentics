// lib/boundaries/leaf-review.mjs — one review round of a leaf, in-process: the units its reviewer
// rules, the round's exit computed from the reviewer's stored return against the round before, and
// what that exit records — the approval, the escalation, or each open finding as a message to the
// session that fixes it;
// and the convergence ruling asked for after it.
//
// Design: docs/DESIGN.md#executors-and-review.

import { readLog } from '../ledger.mjs'
import { journalsOf } from '../resume.mjs'
import { branchOf, executionDir, readJson, returnPath, revParse, reviewPath, writeJson } from '../store.mjs'
import { clearedAt, cycleOf, isYardstick, readTree } from '../tree.mjs'
import { anchorOf, fileUnits } from '../review-delta.mjs'
import { consolidationDue, greenRoundRole, heldMutations, remedyOf, retires, reviewExit, unitsOpen, unruledUnit } from '../verdict.mjs'
import { approved, escalated, faultRecords, message, recordAll, storedReturn } from './records.mjs'

const list = (v) => (Array.isArray(v) ? v : [])

/**
 * Pure. The units a leaf review rules, each anchored to what its ruling stands on
 * (docs/DESIGN.md#review-delta): each acceptance criterion (counted from 1) to its text and the
 * head, each changed file to its blob there (`fileUnits`), each approved case that fails at the
 * head to that head; then each unit an earlier reviewer left unruled (`unruled`) that is none of
 * those, at the head, so a unit the span no longer reaches is still ruled.
 *
 * @param {{acceptance: object[]}} leaf
 * @param {{head?: string, changed?: string[], blobs?: Map<string, string>, approved_failing?: {file: string, id: string}[], unruled?: string[]}} span
 * @returns {{unit: string, anchor: string}[]}
 */
export function reviewUnits(leaf, { head = '', changed = [], blobs = new Map(), approved_failing = [], unruled = [] } = {}) {
  const units = [
    ...list(leaf.acceptance).map((c, i) => ({ unit: 'criterion:' + (i + 1), anchor: anchorOf({ text: String((c && c.text) || ''), head }) })),
    ...fileUnits(changed, blobs),
    ...list(approved_failing).map((c) => ({ unit: 'approved-case:' + c.file + '#' + c.id, anchor: head })),
  ]
  const named = new Set(units.map((u) => u.unit))
  return [...units, ...[...new Set(list(unruled))].filter((u) => !named.has(u)).map((unit) => ({ unit, anchor: head }))]
}

/**
 * Pure. The rulings a leaf review's record keeps: each that stood, each unit the return ruled
 * examined at its anchor (`ruling` by unit), and each `gone` — a unit out of this span keeps its
 * ruling, which stands again at its anchor when the unit returns.
 */
export function heldRulings(delta, open, ruling) {
  return [
    ...list(delta.stand),
    ...list(delta.rule).filter((r) => !open.has(r.unit)).map((r) => ({ unit: r.unit, anchor: r.anchor, ruling: ruling.get(r.unit) })),
    ...list(delta.gone),
  ]
}

const PRODUCERS = ['implementer', 'test-author']

/** Pure. The role of the latest producer dispatch of round `round` of `id`: a reviewer dispatched at that round is not its producer. */
function producerRole(events, id, round) {
  const mine = events.filter((e) => e.kind === 'dispatched' && e.node === id && e.round === round && PRODUCERS.includes(e.role))
  return mine.length ? mine[mine.length - 1].role : ''
}

/** Pure. The remedy the reviewed round's producer could apply, on a green; '' on a leaf whose one producer owns every finding. */
const reviewedProducer = (leaf, role) => (leaf.role !== 'green' ? '' : role === 'test-author' ? 'tests' : 'code')

const asFinding = (f) => ({ id: f.id, severity: f.severity, claim: f.claim, evidence: f.evidence, failure_scenario: f.failure_scenario })

/**
 * Pure. The `findings` messages of an open set, one per thread, for round `round`. A cycle's tests
 * findings go to its test session (`producer:<red>`), on a green only once no code finding is open
 * (until then they are carried); an audit's code findings to its auditor; every other finding to
 * the leaf's own producer. A unit the reviewer left unruled is no finding: it goes to the next fresh
 * reviewer, never to a producer, so an open set of those alone sends nothing.
 */
function findingsMessages(nodes, leaf, entries, round) {
  const open = entries.filter((f) => !unruledUnit(f))
  const cycleMember = leaf.role === 'green' || leaf.role === 'audit'
  const tests = 'producer:' + (cycleOf(nodes, leaf.id)[0] || leaf.id)
  const code = leaf.role === 'audit' ? 'auditor:' + leaf.id : 'producer:' + leaf.id
  const carried = leaf.role === 'green' && greenRoundRole({ review: { next: 'fix', open } }) === 'implementer'
  const byThread = new Map()
  for (const f of open) {
    const toTests = cycleMember && remedyOf(f) === 'tests'
    if (toTests && carried) continue
    const thread = toTests ? tests : code
    byThread.set(thread, [...(byThread.get(thread) || []), asFinding(f)])
  }
  return [...byThread].map(([thread, findings]) => message(leaf.id, thread, 'findings', { findings }, round))
}

/** Pure. A judge's request to retire or merge a test, as the `consolidate` message carries it. */
const asRetire = (f) => ({ claim: String(f.claim || ''), evidence: String(f.evidence || '') })

/**
 * The tests the cycle's judges asked to retire or merge: each review record of a member, of any
 * execution, and each return of its auditor; each request once.
 */
function retireRequests(xc, events, cycle) {
  const seen = new Map()
  for (const e of events) {
    if (e.kind !== 'dispatched' || !cycle.includes(e.node)) continue
    const execution = e.execution || xc.execution
    const from = e.role === 'reviewer'
      ? readJson(reviewPath(xc.repo, xc.effort, execution, e.node, Number(String(e.thread).split(':').pop()) || 0))
      : e.role === 'auditor' ? readJson(returnPath(executionDir(xc.repo, xc.effort, execution), e.dispatch)) : null
    for (const r of list(from && from.retire).map(asRetire)) seen.set(JSON.stringify(r), r)
  }
  return [...seen.values()]
}

/**
 * The units each earlier reviewer of producer round `round` of `node` in this execution left
 * unruled, since the node was cleared, before review round `review_round`: the misses `reviewExit`
 * holds the next reviewer's against (`missedAgain`).
 */
function missedBy(xc, tree, { node, round, review_round }) {
  const since = clearedAt(tree.nodes, tree.events, node)
  const at = (dispatch) => (tree.events.findLast((e) => e.kind === 'dispatched' && e.dispatch === dispatch) || {}).seq || 0
  const missed = []
  // A number with no record is a reviewer dispatch that faulted: the records after it still count.
  for (let n = 1; n < review_round; n++) {
    const rec = readJson(reviewPath(xc.repo, xc.effort, xc.execution, node, n))
    if (rec && rec.round === round && at(rec.dispatch) > since) missed.push(...list(rec.open).filter(unruledUnit).map((f) => String(f.id).slice('unit:'.length)))
  }
  return missed
}

/**
 * One review round of a leaf: the reviewer's stored return, the exit (`reviewExit`) over the units
 * `delta` rules against what the round before left open and the units earlier reviewers of the
 * round missed, the review record, and what the exit records. The record keeps the round's
 * `rulings` (`heldRulings`), which the next review's delta reads. An approval of a
 * cycle's last member that owes the consolidation round (`consolidationDue`) records the
 * `consolidate` message to the cycle's test session instead, its exit `fix` for `consolidate`. A
 * dispatch that returned no review holds the leaf on a `role` fault.
 *
 * @param {{repo: string, effort: string, execution: string, dir: string, log: {append: Function, entries: Function}}} xc
 * @param {{node: string, round: number, review_round: number, dispatch: string,
 *   delta: {rule: {unit: string, anchor: string}[], stand: {unit: string, anchor: string, ruling: string}[], gone?: {unit: string, anchor: string, ruling: string}[]}}} args
 * @returns {{decision: {next: 'approve'|'fix'|'escalate'|'held', reason: string}, raise: boolean, stops: object[]}}
 */
export function leafReview(xc, { node, round, review_round, dispatch, delta = { rule: [], stand: [], gone: [] } }) {
  const tree = readTree(xc.repo, xc.effort)
  const leaf = tree.nodes.get(node)
  if (!leaf || leaf.kind !== 'leaf') throw new Error('leaf-review: not a leaf: ' + JSON.stringify(node))
  const ret = storedReturn(xc, dispatch)
  if (!ret || !Array.isArray(ret.findings)) {
    const state = readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries
    const { stops } = recordAll(xc, faultRecords(node, 'role', 'review round ' + review_round + ' of ' + node + ' returned no review',
      { nodes: tree.nodes, events: tree.events, state }))
    return { decision: { next: 'held', reason: 'role' }, raise: false, stops }
  }
  const prior = review_round > 1 ? readJson(reviewPath(xc.repo, xc.effort, xc.execution, node, review_round - 1)) : null
  const units = delta.rule.map((r) => r.unit)
  const open = new Set(unitsOpen(units, list(ret.units)))
  const ruling = new Map(list(ret.units).map((u) => [u.unit, u.ruling]))
  const rulings = heldRulings(delta, open, ruling)
  const exit = reviewExit({
    yardstick: isYardstick(leaf), findings: ret.findings, verdicts: list(ret.fix_rulings), prior: prior || {},
    producer: reviewedProducer(leaf, producerRole(tree.events, node, round)), units, rulings: list(ret.units),
    missedBefore: missedBy(xc, tree, { node, round, review_round }),
  })
  const head = revParse(xc.repo, 'refs/heads/' + branchOf(xc.effort, node))
  writeJson(reviewPath(xc.repo, xc.effort, xc.execution, node, review_round),
    { node, round, review_round, dispatch, head_sha: head, units, rulings, ...exit, retire: ret.findings.filter(retires).map(asRetire) })
  const cycle = cycleOf(tree.nodes, node)
  if (exit.next === 'approve' && consolidationDue(leaf, cycle, tree.events, round)) {
    const retire = retireRequests(xc, tree.events, cycle)
    const measured = journalsOf(xc.repo, xc.effort, xc.execution).filter((e) => e.kind === 'verify-observed' && e.node === node)
    const held = heldMutations(leaf, measured, [])
    const { stops } = recordAll(xc, [message(node, 'producer:' + cycle[0], 'consolidate', { retire, held }, round + 1)])
    return { decision: { next: 'fix', reason: 'consolidate' }, raise: false, stops }
  }
  const records = exit.next === 'approve' ? [approved(node, head, review_round, false)]
    : exit.next === 'escalate' ? [escalated(node, exit.reason, exit.detail, dispatch)]
      : findingsMessages(tree.nodes, leaf, exit.open, round + 1)
  const { stops } = recordAll(xc, records)
  return { decision: { next: exit.next, reason: exit.reason }, raise: exit.raise, stops }
}

/**
 * The convergence ruling on a leaf's loop after its round `round` was sent back, read from the
 * ruler's stored return: `not_converging` escalates the leaf `not_converging`, `said` the ruler's
 * dispatch; `converging` records nothing, and the loop goes on. A return with no ruling holds the
 * leaf on a `role` fault.
 *
 * @param {{repo: string, effort: string, execution: string, dir: string, log: {append: Function, entries: Function}}} xc
 * @param {{node: string, round: number, dispatch: string}} args
 * @returns {{decision: {next: 'continue'|'escalate'|'held', reason: string}, stops: object[]}}
 */
export function convergenceRuling(xc, { node, round, dispatch }) {
  const ret = storedReturn(xc, dispatch)
  const ruling = ret ? ret.ruling : ''
  if (ruling === 'converging') return { decision: { next: 'continue', reason: '' }, stops: [] }
  if (ruling !== 'not_converging') {
    const tree = readTree(xc.repo, xc.effort)
    const state = readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries
    const { stops } = recordAll(xc, faultRecords(node, 'role', 'the convergence ruling after round ' + round + ' of ' + node +
      ' returned no ruling', { nodes: tree.nodes, events: tree.events, state }))
    return { decision: { next: 'held', reason: 'role' }, stops }
  }
  const { stops } = recordAll(xc, [escalated(node, 'not_converging',
    'the convergence ruling after round ' + round + ': ' + String(ret.why || ''), dispatch)])
  return { decision: { next: 'escalate', reason: 'not_converging' }, stops }
}

/**
 * The open findings of the review that stopped round `round` of a leaf, recorded as the `findings`
 * messages its next round carries, once the session cleared that stop by retry. A review that
 * escalated recorded none; a convergence ruling's stop came after leafReview recorded them; either
 * way each lands once (`freshRecords`). The review is the latest record of that producer round.
 *
 * @param {{repo: string, effort: string, execution: string, dir: string, log: {append: Function, entries: Function}}} xc
 * @param {{node: string, round: number}} args
 * @returns {{recorded: object[], stops: object[]}}
 */
export function reviewResumed(xc, { node, round }) {
  const tree = readTree(xc.repo, xc.effort)
  const leaf = tree.nodes.get(node)
  if (!leaf || leaf.kind !== 'leaf') throw new Error('leaf-review: not a leaf: ' + JSON.stringify(node))
  let last = null
  for (let n = 1, rec; (rec = readJson(reviewPath(xc.repo, xc.effort, xc.execution, node, n))); n++) {
    if (rec.round === round) last = rec
  }
  return recordAll(xc, last ? findingsMessages(tree.nodes, leaf, list(last.open), round + 1) : [])
}
