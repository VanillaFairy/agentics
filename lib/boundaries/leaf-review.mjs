// lib/boundaries/leaf-review.mjs — one review round of a leaf, in-process: the units its reviewer
// rules, the round's exit computed from the reviewer's stored return against the round before, and
// what that exit records — the approval, the escalation, or each open finding as a message to the
// session that fixes it;
// and the convergence ruling asked for after it.
//
// Design: docs/DESIGN.md#executors-and-review.

import { readLog } from '../ledger.mjs'
import { branchOf, readJson, revParse, reviewPath, writeJson } from '../store.mjs'
import { cycleOf, isYardstick, readTree } from '../tree.mjs'
import { greenRoundRole, remedyOf, reviewExit, unruledUnit } from '../verdict.mjs'
import { approved, escalated, faultRecords, message, recordAll, storedReturn } from './records.mjs'

const list = (v) => (Array.isArray(v) ? v : [])

/**
 * Pure. The units a leaf review rules: each acceptance criterion (counted from 1), each changed
 * file, each approved case that fails at the round's head.
 *
 * @param {{acceptance: object[]}} leaf
 * @param {{changed?: string[], approved_failing?: {file: string, id: string}[]}} span
 */
export function reviewUnits(leaf, { changed = [], approved_failing = [] } = {}) {
  return [
    ...list(leaf.acceptance).map((_, i) => 'criterion:' + (i + 1)),
    ...list(changed).map((path) => 'file:' + path),
    ...list(approved_failing).map((c) => 'approved-case:' + c.file + '#' + c.id),
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

/**
 * One review round of a leaf: the reviewer's stored return, the exit (`reviewExit`) against what
 * the round before left open, the review record, and what the exit records. A dispatch that
 * returned no review holds the leaf on a `role` fault.
 *
 * @param {{repo: string, effort: string, execution: string, dir: string, log: {append: Function, entries: Function}}} xc
 * @param {{node: string, round: number, review_round: number, dispatch: string, units: string[]}} args
 * @returns {{decision: {next: 'approve'|'fix'|'escalate'|'held', reason: string}, raise: boolean, stops: object[]}}
 */
export function leafReview(xc, { node, round, review_round, dispatch, units = [] }) {
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
  const exit = reviewExit({
    yardstick: isYardstick(leaf), findings: ret.findings, verdicts: list(ret.fix_rulings), prior: prior || {},
    producer: reviewedProducer(leaf, producerRole(tree.events, node, round)), units: list(units), rulings: list(ret.units),
  })
  const head = revParse(xc.repo, 'refs/heads/' + branchOf(xc.effort, node))
  writeJson(reviewPath(xc.repo, xc.effort, xc.execution, node, review_round),
    { node, round, review_round, dispatch, head_sha: head, units: list(units), ...exit })
  const records = exit.next === 'approve' ? [approved(node, head, review_round, false)]
    : exit.next === 'escalate' ? [escalated(node, exit.reason, exit.detail, dispatch)]
      : findingsMessages(tree.nodes, leaf, exit.open, round + 1)
  const { stops } = recordAll(xc, records)
  return { decision: { next: exit.next, reason: exit.reason }, raise: exit.raise, stops }
}

/**
 * The convergence ruling asked for after review round `review_round` of a leaf, read from the
 * ruler's stored return: `not_converging` escalates the leaf `review_not_converging`, `said` the
 * ruler's dispatch; `converging` records nothing, and the loop goes on. A return with no ruling
 * holds the leaf on a `role` fault.
 *
 * @param {{repo: string, effort: string, execution: string, dir: string, log: {append: Function, entries: Function}}} xc
 * @param {{node: string, review_round: number, dispatch: string}} args
 * @returns {{decision: {next: 'continue'|'escalate'|'held', reason: string}, stops: object[]}}
 */
export function convergenceRuling(xc, { node, review_round, dispatch }) {
  const ret = storedReturn(xc, dispatch)
  const ruling = ret ? ret.ruling : ''
  if (ruling === 'converging') return { decision: { next: 'continue', reason: '' }, stops: [] }
  if (ruling !== 'not_converging') {
    const tree = readTree(xc.repo, xc.effort)
    const state = readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries
    const { stops } = recordAll(xc, faultRecords(node, 'role', 'the convergence ruling after review round ' + review_round + ' of ' + node +
      ' returned no ruling', { nodes: tree.nodes, events: tree.events, state }))
    return { decision: { next: 'held', reason: 'role' }, stops }
  }
  const { stops } = recordAll(xc, [escalated(node, 'review_not_converging',
    'the convergence ruling after review round ' + review_round + ': ' + String(ret.why || ''), dispatch)])
  return { decision: { next: 'escalate', reason: 'review_not_converging' }, stops }
}
