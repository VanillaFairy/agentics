// lib/boundaries/integration.mjs — a folder's integration review and a ruler's close, in-process:
// the claim rulings recorded at the head the review judged, with the one park they earn, and what a
// ruler's rulings on drift or on a moved base decide for each node it was asked about.
//
// Design: docs/DESIGN.md#landing-and-drift.

import { readLog } from '../ledger.mjs'
import { posix, readJson, specPath } from '../store.mjs'
import { readTree } from '../tree.mjs'
import { PASSING, harmfulDrift, integrationPark } from '../verdict.mjs'
import { faultRecords, parked, recordAll, storedReturn } from './records.mjs'

const list = (v) => (Array.isArray(v) ? v : [])

const stateOf = (xc) => readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries

/** Pure. A claim as a `claims` event records it: its failure scenario kept only on a drift that names one, the one that parks. */
const recordedClaim = (c) => ({ claim: c.claim, ruling: c.ruling, ...(harmfulDrift(c) ? { failure_scenario: c.failure_scenario } : {}) })

/**
 * Pure. The criticals a review leaves open: its own, then each blocker the review before left open
 * (`prior.open`) that this one did not rule `fixed` in `fix_rulings`. A prior one is dropped only
 * as the same critical reported again: a finding of another severity under its id does not close it.
 */
function openBlockers(findings, ret, prior) {
  const fixed = new Set(list(ret.fix_rulings).filter((v) => v && v.status === 'fixed').map((v) => v.id))
  const own = findings.filter((f) => f.severity === 'critical')
  const again = new Set(own.map((f) => f.id))
  const carried = prior ? list(prior.open).filter((o) => !fixed.has(o.id) && !again.has(o.id)) : []
  return [...own, ...carried].map((f) => ({ id: f.id, claim: f.claim, failure_scenario: String(f.failure_scenario || '') }))
}

/**
 * Pure. The claims a narrowed review leaves the folder with; the return's own claims come after
 * the prior ones it carried. A prior claim the return restates — a claim naming its `claim:<n>` in
 * `unit`, in whatever current wording, or one with its very text — is the return's. Every other
 * prior claim is carried, a unit ruled in `units` and not restated included: a ruling that is not a
 * pass as it was, so it still parks; a pass over the same head as it was, and over a moved head as
 * `cant_tell`, never a pass.
 */
function reruledClaims(prior, ret, moved) {
  const answered = new Set(ret.claims.map((c) => c.unit).filter(Boolean))
  const restated = new Set(ret.claims.map((c) => c.claim))
  const carried = prior.claims.filter((c, i) => !restated.has(c.claim) && !answered.has('claim:' + (i + 1)))
    .map((c) => (moved && PASSING.includes(c.ruling) ? { claim: c.claim, ruling: 'cant_tell' } : recordedClaim(c)))
  return [...carried, ...ret.claims]
}

/**
 * A folder's integration review: the claim rulings of the reviewer's stored return, recorded at
 * the head it judged with `said` its dispatch, and the one park they earn (`integrationPark`). A
 * review that returned nothing is a `role` fault on the folder, never a question.
 *
 * With `prior`, the earlier review's `claims` event, the review was narrowed (`rerule: true`):
 * the return holds only the claims it ruled, and the folder's claims are those and the prior ones
 * it left standing (`reruledClaims`). Every review records the criticals it leaves `open`, the
 * prior's carried until one is ruled fixed (`openBlockers`); they park as its own do.
 *
 * @param {{repo: string, effort: string, execution: string, dir: string, log: {append: Function, entries: Function}}} xc
 * @param {{target: string, head: string, dispatch: string, spec_path: string,
 *   prior?: {claims: {claim: string, ruling: string}[], open?: {id: string, claim: string, failure_scenario: string}[]}}} args
 */
export function folderReview(xc, { target, head, dispatch, spec_path = '', prior = null }) {
  const tree = readTree(xc.repo, xc.effort)
  if (!tree.nodes.has(target)) throw new Error('folder-review: no such node: ' + JSON.stringify(target))
  const ret = storedReturn(xc, dispatch)
  if (!ret || !Array.isArray(ret.claims)) {
    const { stops } = recordAll(xc, faultRecords(target, 'role', 'the integration review of ' + target + ' returned no review',
      { nodes: tree.nodes, events: tree.events, state: stateOf(xc) }))
    return { status: 'held', claims_n: 0, findings_n: 0, stops }
  }
  const findings = list(ret.findings)
  const claims = prior ? reruledClaims(prior, ret, prior.head_sha !== head) : ret.claims
  const open = openBlockers(findings, ret, prior)
  const park = integrationPark(open.map((o) => ({ ...o, severity: 'critical' })), claims, spec_path)
  const records = [{
    kind: 'claims',
    fields: { node: target, head_sha: head, review: 'done', claims: claims.map(recordedClaim), open, said: dispatch, ...(prior ? { rerule: true } : {}) },
  }]
  if (park) records.push(parked(target, park.why, park.question, dispatch))
  const { stops } = recordAll(xc, records)
  return { status: 'recorded', claims_n: claims.length, findings_n: findings.length, stops }
}

/**
 * Pure. The ruling of unaffected that stands on each consumer's contract, by `<node> <contract>`: the
 * latest of a ruler's `drift-ruled` line ruling it unaffected, at the head it ruled, and the user's
 * ruling — a `contract_drift` park on an affected ruling that a `retry` cleared (a `replanned
 * retry_escalated` on the node after the park) — at that ruling's head, with the park's question and
 * the answers the user recorded on the node between the park and the retry. A later affected ruling
 * no retry cleared stands in its place, so the contract has no standing ruling. `states` are the
 * state lines of every execution of the effort, `events` its events, `ledger` its ledger lines.
 *
 * @returns {Map<string, {by: 'ruler'|'user', seq: number, head_sha: string, why: string, said: string,
 *   question: string, answers: {question: string, answer: string}[]}>}
 */
export function standingRulings({ states = [], events = [], ledger = [] }) {
  const verdicts = []
  for (const r of list(states)) {
    if (r.kind !== 'drift-ruled' || !r.head_sha || Number.isInteger(r.adopted_seq)) continue
    const key = r.node + ' ' + r.contract
    const at = { head_sha: r.head_sha, why: String(r.why || ''), said: String(r.said || '') }
    if (r.ruling === 'unaffected') {
      verdicts.push({ key, seq: r.seq, standing: { by: 'ruler', seq: r.seq, ...at, question: '', answers: [] } })
      continue
    }
    verdicts.push({ key, seq: r.seq, standing: null })
    const park = list(events).find((e) => e.kind === 'parked' && e.node === r.node && e.return === 'contract_drift' && e.said === r.said && e.seq > r.seq)
    const retry = park && list(events).find((e) => e.kind === 'replanned' && e.node === r.node && e.reason === 'retry_escalated' && e.seq > park.seq)
    if (!retry) continue
    const answers = list(ledger).filter((l) => l.kind === 'answered' && list(l.nodes).includes(r.node) && l.seq > park.seq && l.seq < retry.seq)
      .flatMap((l) => list(l.answers))
    verdicts.push({ key, seq: retry.seq, standing: { by: 'user', seq: retry.seq, ...at, question: String(park.question || ''), answers } })
  }
  const latest = new Map()
  for (const v of verdicts.sort((a, b) => a.seq - b.seq)) latest.set(v.key, v.standing)
  return new Map([...latest].filter(([, s]) => s))
}

/** Pure. Whether work already stands on the node as planned: a leaf approved and waiting for its merge, or a folder with children dispatched or merged. */
const underWay = (tree, id) => (tree.status.get(id) || {}).status === (tree.nodes.get(id).kind === 'leaf' ? 'approved' : 'active')

/**
 * Pure. What a ruler's rulings decide, on drift after a merge (`kind: drift`, merge-batch's record),
 * on a base that moved under a resumed execution (`kind: stale`, preflight's record) or on work
 * adopted on the user's word (`kind: adopted`, preflight's record, each ruling under its record's
 * seq). Each ruling is recorded with the ruler's `why` and `said` its dispatch; an affected node
 * goes to the planner unless work already stands on it or a running unit works under it (it parks with the
 * ruler's question), or it is a folder the user writes (it parks `needs_respec`). A node no ruling
 * reached parks for drift, which would not be found again, and is held for a moved base or adopted
 * work, which the next run rules again. A node already stopped is left out until its stop clears.
 */
function rulingOutcome({ kind, record, rulings, running, tree, state, dispatch, specOf }) {
  const { nodes, status, events } = tree
  const stale = kind === 'stale'
  const adopted = kind === 'adopted'
  const items = stale ? list(record.nodes).map((node) => ({ node })) : list(record.drift).filter((d) => !d.stopped && !d.standing)
  const ids = [...new Set(items.map((i) => i.node))]
    .filter((id) => nodes.has(id) && !['escalated', 'parked'].includes((status.get(id) || {}).status))
  const inFlight = list(running).map((k) => k.slice(k.indexOf(':') + 1))
  const runningUnder = (id) => inFlight.some((at) => at === id || at.startsWith(id + '/'))
  const records = []
  const replan = []
  for (const id of ids) {
    const r = rulings.get(id)
    const mine = items.filter((i) => i.node === id)
    if (!r) {
      if (stale || adopted) {
        records.push(...faultRecords(id, 'role', stale ? 'the base moved under it and no ruler ruled on it'
          : "work adopted on the user's word touched what it consumes and no ruler ruled on it", { nodes, events, state }))
      } else {
        records.push(parked(id, 'contract_drift', 'merged work touched ' + mine.flatMap((d) => list(d.files)).join(', ') + ' under contract ' +
          mine.map((d) => d.contract).join(', ') + ', which ' + id + ' consumes, and no ruler could rule on it: rule it unaffected, re-design it or re-slice it'))
      }
      continue
    }
    const affected = r.ruling !== 'unaffected'
    const ruling = affected ? 'affected' : 'unaffected'
    const why = String(r.why || '')
    if (stale) records.push({ kind: 'stale-ruled', fields: { node: id, base_now: record.now || '', ruling, why, said: dispatch } })
    else for (const d of mine) records.push({ kind: 'drift-ruled', fields: { node: id, contract: d.contract, head_sha: record.head_sha || '', ...(adopted ? { adopted_seq: d.adopted_seq } : {}), ruling, why, said: dispatch } })
    if (!affected) continue
    const question = String(r.question || r.why || '')
    if (underWay(tree, id) || runningUnder(id)) records.push(parked(id, stale ? 'premise_mismatch' : 'contract_drift', question, dispatch))
    else if (nodes.get(id).kind !== 'leaf' && nodes.get(id).author !== 'planner') {
      records.push(parked(id, 'needs_respec', 'edit ' + specOf(id) + ', re-approve it and recompile', dispatch))
    } else replan.push({ id, question })
  }
  return { records, replan }
}

/**
 * A ruler's rulings, recorded: see `rulingOutcome`. `record` is the path of merge-batch's drift
 * record or preflight's stale or adopted record; `running` the units in flight (`<unit>:<id>`).
 *
 * @param {{repo: string, effort: string, execution: string, dir: string, log: {append: Function, entries: Function}}} xc
 * @param {{kind: 'drift'|'stale'|'adopted', record: string, dispatch: string, running?: string[]}} args
 * @returns {{replan: {id: string, question: string}[], stops: object[]}}
 */
export function ruleClose(xc, { kind, record, dispatch, running = [] }) {
  const tree = readTree(xc.repo, xc.effort)
  const ret = storedReturn(xc, dispatch)
  const rulings = new Map(list(ret && ret.rulings).filter((r) => r && r.node).map((r) => [r.node, r]))
  const out = rulingOutcome({
    kind, record: readJson(record) || {}, rulings, running, tree, state: stateOf(xc), dispatch,
    specOf: (id) => posix(specPath(xc.repo, xc.effort, id)),
  })
  const { stops } = recordAll(xc, out.records)
  return { replan: out.replan, stops }
}
