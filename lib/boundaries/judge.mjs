// lib/boundaries/judge.mjs — the judge at the merge: the contention facts of a unit about to merge,
// and judge-close, which records what the ruler's per-unit rulings decide.
//
// Design: docs/DESIGN.md#the-judge.

import { combineRulings, contentionOf } from '../contention.mjs'
import { leafNet } from '../integration.mjs'
import { readLog } from '../ledger.mjs'
import { roleAdmits, writesOf } from '../permissions.mjs'
import { branchOf, revParse } from '../store.mjs'
import { cycleOf, executorRole, readTree } from '../tree.mjs'
import { clearedAt, sendBack, sendBacks } from './loop-guard.mjs'
import { escalated, faultRecords, recordAll, storedReturn } from './records.mjs'

const list = (v) => (Array.isArray(v) ? v : [])

/** Pure. A leaf's latest round: the round of its latest `dispatched` event, 0 before any. */
const latestRound = (events, id) =>
  events.filter((e) => e.kind === 'dispatched' && e.node === id).reduce((m, e) => Math.max(m, Number.isInteger(e.round) ? e.round : 0), 0)

/** Pure. The seq of a leaf's first dispatch in any execution; a leaf never dispatched comes after every other. */
const firstDispatch = (events) => (id) => {
  const seqs = events.filter((e) => e.kind === 'dispatched' && e.node === id).map((e) => e.seq)
  return seqs.length ? Math.min(...seqs) : Infinity
}

/**
 * The contention facts of the merge unit led by `id` at `head` (its approved head), from git: the
 * unit's net diff and every other leaf's. `[]` for a unit with nothing to compare.
 */
export function contentionFacts(xc, tree, id, head) {
  const heads = new Map()
  const headOf = (o) => {
    if (!heads.has(o)) heads.set(o, revParse(xc.repo, 'refs/heads/' + branchOf(xc.effort, o)))
    return heads.get(o)
  }
  const net = leafNet(xc.repo, xc.effort, tree.nodes, id, head)
  if (net.length === 0) return { facts: [], heads: {} }
  const facts = contentionOf(tree, id, { head, net, netOf: (o) => (headOf(o) ? leafNet(xc.repo, xc.effort, tree.nodes, o) : []), headOf })
  return { facts, heads: Object.fromEntries([...new Set(facts.map((f) => f.node))].map((o) => [o, headOf(o)])) }
}

/**
 * Pure. Whether a conflict of leaf unit `id` goes to the judge: a leaf whose executor has a shell
 * to conclude a merge — a cycle's tip only when every conflicting path is one its role may write — and no `resolve` of a conflict on the same paths at an
 * earlier approved head — a remedy that failed is the user's.
 */
/** Pure. The units of a contention or conflict ruling: the leaves the facts name, or the one `integration` of a conflict. */
export const judgedUnits = (trigger, facts) => (trigger === 'conflict' ? ['integration'] : [...new Set(list(facts).map((f) => f.node))])

export function conflictJudged({ nodes, events }, id, head, paths) {
  const leaf = nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf' || executorRole(leaf) !== 'implementer') return false
  // A cycle merges through its tip: its implementer may conclude a merge of the paths its role writes, never a test.
  const cycle = cycleOf(nodes, id)
  if (cycle.length && (cycle[cycle.length - 1] !== id || list(paths).some((p) => !roleAdmits(writesOf('implementer', leaf), p)))) return false
  return !events.some((e) => e.kind === 'judged' && e.node === id && e.trigger === 'conflict' && e.outcome === 'resolve' &&
    e.head_sha !== head && list(paths).every((p) => list(e.paths).includes(p)))
}

/**
 * Judge-close: read the ruler's stored rulings over the units it was handed (and those of each call in
 * `also`, re-asked for the units the first left out, which rule first), combine them
 * (`combineRulings`) and record the `judged` event and what it decides — the escalation when it
 * could not rule, the `rebase` message a conflict's resolve sends the leaf's next round. A return
 * with no rulings holds the node on a `role` fault.
 *
 * @param {object} xc the execution's context
 * @param {{node: string, trigger: 'contention'|'conflict', head: string, heads?: Object<string, string>,
 *   facts?: object[], paths?: string[], dispatch: string}} args
 * @returns {{outcome: 'cant_rule'|'replan'|'serialize'|'resolve'|'held', after: string[], why: string,
 *   question: string, rebase: boolean, stops: object[]}}
 */
export function judgeClose(xc, { node, trigger, head, heads = {}, facts = [], paths = [], dispatch, also = [] }) {
  const tree = readTree(xc.repo, xc.effort)
  const first = storedReturn(xc, dispatch)
  // A unit the first call left out and a second was asked for: its ruling is the second's.
  const later = list(also).map((d) => storedReturn(xc, d)).filter((r) => r && Array.isArray(r.rulings))
  const ret = first && Array.isArray(first.rulings) ? { ...first, rulings: [...later.flatMap((r) => r.rulings), ...first.rulings] } : first
  if (!ret || !Array.isArray(ret.rulings)) {
    const state = readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries
    const { stops } = recordAll(xc, faultRecords(node, 'role', 'the ' + trigger + ' ruling ' + dispatch + ' returned no rulings',
      { nodes: tree.nodes, events: tree.events, state }))
    return { outcome: 'held', after: [], why: '', question: '', rebase: false, stops }
  }
  const units = judgedUnits(trigger, facts)
  const decided = combineRulings({ trigger, id: node, units, rulings: ret.rulings, firstOf: firstDispatch(tree.events) })
  const question = list(ret.rulings).map((r) => String((r && r.question) || '').trim()).filter(Boolean).join(' ')
  const judged = {
    kind: 'judged',
    fields: {
      node, trigger, head_sha: head, heads, facts: list(facts), paths: list(paths), outcome: decided.outcome,
      after: decided.after, why: decided.why.slice(0, 2000), said: dispatch,
    },
  }
  const records = [judged]
  if (decided.outcome === 'cant_rule') {
    records.push(escalated(node, trigger === 'conflict' ? 'merge_conflict' : 'contention_unruled', decided.why, dispatch))
  }
  const rebase = trigger === 'conflict' && decided.outcome === 'resolve'
  if (rebase) {
    const round = latestRound(tree.events, node) + 1
    const out = sendBack(sendBacks(tree.events, node, clearedAt(tree.nodes.get(node), tree.events), round), {
      node, thread: 'producer:' + node, msg: 'rebase', payload: { paths: list(paths), why: decided.why }, round,
      guard: { kind: 'rebase', key: list(paths).join('\n'), at: head },
    })
    records.push(out.record)
  }
  const { stops } = recordAll(xc, records)
  return { outcome: decided.outcome, after: decided.after, why: decided.why, question: question || decided.why, rebase, stops }
}

