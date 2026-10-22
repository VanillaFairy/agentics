// lib/programs/execute/integrate.mjs — the execute program's integration units: a merge-batch and
// the ruler on its drift, a composite's suite gate and integration review, a ruler on drift or on a
// moved base.
//
// Design: docs/DESIGN.md#landing-and-drift.

import { readFileSync } from 'node:fs'

import { folderReview, ruleClose } from '../../boundaries/integration.mjs'
import { mergeBatch, suiteGate } from '../../boundaries/merge.mjs'
import { channelOf, faultRecords, recordAll } from '../../boundaries/records.mjs'
import { guidanceOf } from '../../brief.mjs'
import { integrationBrief, integrationRerule } from '../../briefs/execute.mjs'
import { changedFiles } from '../../integration.mjs'
import { readLog } from '../../ledger.mjs'
import { outsideWorkOf } from '../../schedule.mjs'
import { keptSpecDiff } from '../../spec.mjs'
import { ROOT_ID, executionDir, nodeKey, posix, readConfig, readJson, returnPath, specPath } from '../../store.mjs'
import { isHuman, readTree, rerulableReview } from '../../tree.mjs'
import { dispatch } from '../common.mjs'

const list = (v) => (Array.isArray(v) ? v : [])
const stateOf = (xc) => readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries
const rootOf = (xc) => (xc.envelope() || {}).root || ROOT_ID

/** A fault on `node`, recorded: it holds the node for the rest of the run. */
function fault(xc, node, channel, detail) {
  const tree = readTree(xc.repo, xc.effort)
  recordAll(xc, faultRecords(node, channel, detail, { nodes: tree.nodes, events: tree.events, state: stateOf(xc) }))
}

/**
 * A ruler's rulings on drift (`kind: drift`: merge-batch's record and brief), on a base that
 * moved under the execution (`kind: stale`) or on work adopted on the user's word
 * (`kind: adopted`; both preflight's record and brief): one fresh ruler on its own thread, minted
 * from the execution's root and recorded on it, handed the brief the boundary wrote as its prompt;
 * then rule-close, which records what the rulings decide. `running` lists the units in flight
 * (`<unit>:<id>`). The nodes the planner must answer come back in `replan`.
 *
 * @param {object} ctx the program's context
 * @param {object} xc the execution's context
 * @param {{kind: 'drift'|'stale'|'adopted', record: string, brief: string, intelligence?: string, running?: string[]}} args
 * @returns {Promise<{outcome: 'ruled'|'unruled', dispatch: string, replan: {id: string, question: string}[]}>}
 */
export async function ruleUnit(ctx, xc, { kind, record, brief, intelligence, running = [] }) {
  const rec = readJson(record) || {}
  const root = rootOf(xc)
  const thread = kind === 'drift'
    ? 'ruler:drift:' + (nodeKey(rec.target || ROOT_ID) || 'root') + ':' + String(rec.pre || '').slice(0, 8)
    : kind === 'adopted' ? 'ruler:adopted:' + (list(rec.seqs).slice(-1)[0] ?? 0)
      : 'ruler:stale:' + rec.now
  const ruled = await dispatch(ctx, { role: 'ruler', schema: 'ruler_premises', node: root, thread, brief: readFileSync(brief, 'utf8'), intelligence })
  const { replan } = ruleClose(xc, { kind, record, dispatch: ruled.dispatch, running })
  return { outcome: ruled.status === 'returned' ? 'ruled' : 'unruled', dispatch: ruled.dispatch, replan }
}

/**
 * A merge-batch into `target` (`schedule`'s merge launch), then the ruler on the drift it found in
 * consumers that are not stopped. A refusal is a `program` fault on the target. The leaves that
 * failed alone come back for the program to relaunch (their failures wait as a message), and the
 * consumers ruled affected for the planner.
 *
 * @param {object} ctx the program's context
 * @param {object} xc the execution's context
 * @param {{target: string, children?: {id: string, head_sha: string}[], cycles?: string[][], intelligence?: string, running?: string[]}} args
 * @returns {Promise<{outcome: 'done'|'stopped'|'held'|'faulted', merged: {id: string, merged_sha: string}[],
 *   failed_alone: {id: string}[], drift: {node: string, contract: string, stopped: string}[],
 *   replan: {id: string, question: string}[], unexamined_n: number}>}
 */
export async function mergeUnit(ctx, xc, { target, children = [], cycles = [], intelligence, running = [] }) {
  const out = await mergeBatch(xc, { target, children, cycles, sleep: ctx.sleep })
  if (!out.ok) {
    fault(xc, target, 'program', out.error.kind + ': ' + out.error.message)
    return { outcome: 'faulted', merged: [], failed_alone: [], drift: [], replan: [], unexamined_n: 0 }
  }
  const done = { outcome: out.status, merged: out.merged, failed_alone: out.failed_alone, drift: out.drift, replan: [], unexamined_n: out.unexamined_n }
  if (!out.drift_brief) return done
  const ruled = await ruleUnit(ctx, xc, { kind: 'drift', record: out.drift_record, brief: out.drift_brief, intelligence, running })
  return { ...done, replan: ruled.replan }
}

/**
 * The suite gate on `target`'s integration head. A refusal is a `program` fault on the target.
 * A passed gate's `review` says whether the integration review is earned there.
 *
 * @param {object} ctx the program's context
 * @param {object} xc the execution's context
 * @param {{target: string}} args
 * @returns {Promise<{outcome: 'passed'|'failed'|'stopped'|'held'|'faulted', review: ''|'earned'|'not_earned', head_sha: string}>}
 */
export async function gateUnit(ctx, xc, { target }) {
  const out = await suiteGate(xc, { target, sleep: ctx.sleep })
  if (!out.ok) {
    fault(xc, target, 'program', out.error.kind + ': ' + out.error.message)
    return { outcome: 'faulted', review: '', head_sha: '' }
  }
  return { outcome: out.status !== 'done' ? out.status : out.passed ? 'passed' : 'failed', review: out.review, head_sha: out.head_sha }
}

/**
 * What a re-rule is briefed from, or null when the folder's review is due whole: the finished
 * review that stands no more only because the folder itself changed (`rerulableReview`), over the
 * head it judged, with no critical in its return, and the edit to the spec since the text it
 * judged, which is the folder's latest `compiled` line before it (ledger and events share a seq).
 */
function rerulePlan(xc, tree, id, head) {
  const prior = rerulableReview(tree.nodes, tree.events, id)
  if (!prior || prior.head_sha !== head || !prior.said || !prior.execution) return null
  const ret = readJson(returnPath(executionDir(xc.repo, xc.effort, prior.execution), prior.said))
  if (!ret || list(ret.findings).some((f) => f && f.severity === 'critical')) return null
  const judged = readLog(xc.repo, xc.effort, 'ledger').entries
    .filter((l) => l.kind === 'compiled' && l.folder === id && l.seq < prior.seq)
    .reduce((best, l) => (!best || l.seq > best.seq ? l : best), null)
  const change = judged ? keptSpecDiff(xc.repo, xc.effort, id, judged.hash) : { ok: false }
  return change.ok ? { prior, diff: change.diff } : null
}

/**
 * A finished composite (`schedule`'s review launch: `{id, where, unreviewed}`): its suite gate,
 * then, where the gate passed and earned the review, a fresh integration reviewer on
 * `integration:<folder>:<n>`, read-only in the folder's worktree, handed the folder's spec, the
 * merged span, the work agentics did not produce (`outsideWorkOf`: adopted leaves and outside commits) and the units it rules — each decision the folder defines, each criterion of a child
 * with no review of its own (a `HUMAN:` one is the user's), each changed file; then folder-review.
 * `n` counts the folder's recorded reviews in this execution, so a relaunch before one is recorded
 * resumes the same thread. A review that returned nothing is a fault on the folder and a lost check.
 * Over a head the last review judged, with the spec edited since and no critical in that review, it is a
 * re-rule instead (`rerulePlan`): the edit and the claims not ruled a pass, the rest standing.
 *
 * @param {object} ctx the program's context
 * @param {object} xc the execution's context
 * @param {{id: string, where?: {base: string, worktree: string}|null, unreviewed?: string[], intelligence?: string}} args
 * @returns {Promise<{outcome: 'reviewed'|'lost'|'not_earned'|'failed'|'stopped'|'held'|'faulted', said: string}>}
 */
export async function reviewUnit(ctx, xc, { id, where = null, unreviewed = [], intelligence }) {
  const gate = await gateUnit(ctx, xc, { target: id })
  if (gate.outcome !== 'passed') return { outcome: gate.outcome, said: '' }
  if (gate.review !== 'earned') return { outcome: 'not_earned', said: '' }
  const tree = readTree(xc.repo, xc.effort)
  const folder = tree.nodes.get(id)
  const span = { base: (where && where.base) || '', head: gate.head_sha }
  const worktree = (where && where.worktree) || ''
  const units = [
    ...folder.defines.map((d) => 'decision:' + d.id),
    ...list(unreviewed).flatMap((k) => tree.nodes.get(k).acceptance.map((c, i) => (isHuman(c) ? '' : 'criterion:' + k + '#' + (i + 1)))).filter(Boolean),
    ...changedFiles(xc.repo, span.base, span.head).map((f) => 'file:' + f),
  ]
  const spec_path = posix(specPath(xc.repo, xc.effort, id))
  const n = ctx.log.entries().filter((e) => e.kind === 'claims' && e.node === id && e.review === 'done').length + 1
  const spec = readFileSync(spec_path, 'utf8')
  const guidance = guidanceOf(xc.repo, { config: readConfig(xc.repo) })
  const plan = rerulePlan(xc, tree, id, gate.head_sha)
  const reviewed = await dispatch(ctx, {
    role: 'reviewer', schema: 'reviewer', node: id, thread: 'integration:' + id + ':' + n, intelligence, cwd: worktree || undefined,
    brief: plan
      ? integrationRerule({ folder: { id, title: folder.title, worktree }, spec, diff: plan.diff, prior: plan.prior.claims, span, guidance })
      : integrationBrief({ folder: { id, title: folder.title, worktree }, spec, units, span, outside: outsideWorkOf(tree.events, id, list(unreviewed)), guidance }),
  })
  if (reviewed.status !== 'returned') {
    fault(xc, id, channelOf(reviewed.cause), 'the integration review of ' + id + ' failed: ' + (reviewed.message || reviewed.cause))
    return { outcome: 'lost', said: '' }
  }
  const out = folderReview(xc, { target: id, head: gate.head_sha, dispatch: reviewed.dispatch, spec_path, prior: plan ? plan.prior : null })
  return out.status === 'recorded' ? { outcome: 'reviewed', said: reviewed.dispatch } : { outcome: 'lost', said: '' }
}
