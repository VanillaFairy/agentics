// lib/programs/execute/integrate.mjs — the execute program's integration units: a merge-batch, the
// ruler on what it set aside or met as a conflict and on its drift, a composite's suite gate and
// integration review, a ruler on drift or on a moved base.
//
// Design: docs/DESIGN.md#landing-and-drift.

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import { pausedAt } from '../../boundaries/execution.mjs'
import { folderReview, ruleClose } from '../../boundaries/integration.mjs'
import { judgeClose } from '../../boundaries/judge.mjs'
import { mergeBatch, suiteGate } from '../../boundaries/merge.mjs'
import { channelOf, faultRecords, recordAll } from '../../boundaries/records.mjs'
import { guidanceOf } from '../../brief.mjs'
import { contentionBrief, integrationBrief, integrationRerule } from '../../briefs/execute.mjs'
import { changedFiles, leafNet } from '../../integration.mjs'
import { readLog } from '../../ledger.mjs'
import { outsideWorkOf } from '../../schedule.mjs'
import { keptSpecDiff } from '../../spec.mjs'
import { ROOT_ID, ancestorsOf, branchOf, git, nodeKey, parentOf, posix, readConfig, readJson, sameBlob, specPath } from '../../store.mjs'
import { journalsOf } from '../../resume.mjs'
import { dependsOn } from '../../atomicity.mjs'
import { cycleOf, definedFor, narrowableReview, ownerOf, readTree, subtreeOf } from '../../tree.mjs'
import { undiscriminated } from '../../verdict.mjs'
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

/** A unit's change to `paths` from where it was cut (a cycle's from its red's cut) to `head`. */
function unitDiff(xc, tree, id, head, paths) {
  const first = cycleOf(tree.nodes, id)[0] || id
  const cut = git(xc.repo, ['merge-base', head, 'refs/heads/' + branchOf(xc.effort, ownerOf(tree.nodes, first))])
  return cut.ok && paths.length ? git(xc.repo, ['diff', cut.stdout.trim(), head, '--', ...paths]).stdout : ''
}

/**
 * The ruler on each unit merge-batch set aside for contention, and on a leaf whose merge conflicted:
 * one fresh ruler per unit and head (`ruler:<trigger>:<unit>:<head>`) on the folder being merged into, handed both sides' plan
 * entries and changes, then judge-close. A serialize or a resolve of contention needs nothing more
 * here: the schedule holds the unit or merges it. The leaves a conflict's resolve sends to a rebase
 * round come back in `rebase`, the units ruled a replan in `replan`.
 */
async function judgeUnits(ctx, xc, out, intelligence) {
  const tree = readTree(xc.repo, xc.effort)
  const asks = [
    ...list(out.contended).map((c) => ({ ...c, trigger: 'contention' })),
    ...(out.conflict ? [{ ...out.conflict, trigger: 'conflict' }] : []),
  ]
  const rebase = []
  const replan = []
  for (const a of asks) {
    const paths = a.trigger === 'conflict' ? list(a.paths) : [...new Set(list(a.facts).flatMap((f) => f.paths))]
    const others = [...new Set(list(a.facts).map((f) => f.node))].map((o) => ({
      id: o, entry: tree.nodes.get(o), status: (tree.status.get(o) || {}).status || 'planned',
      facts: list(a.facts).filter((f) => f.node === o),
      diff: unitDiff(xc, tree, o, (a.heads || {})[o] || 'refs/heads/' + branchOf(xc.effort, o), paths.filter((p) => leafNet(xc.repo, xc.effort, tree.nodes, o).includes(p))),
    }))
    const folderHead = 'refs/heads/' + branchOf(xc.effort, ownerOf(tree.nodes, a.id))
    const cut = git(xc.repo, ['merge-base', a.head, folderHead])
    const merged = a.trigger === 'conflict' && cut.ok ? git(xc.repo, ['diff', cut.stdout.trim(), folderHead, '--', ...paths]).stdout : ''
    const thread = 'ruler:' + a.trigger + ':' + nodeKey(a.id) + ':' + String(a.head).slice(0, 8)
    // On the folder being merged into: a dispatch on the approved leaf would read as its next round.
    const ruled = await dispatch(ctx, {
      role: 'ruler', schema: 'ruler_contention', node: ownerOf(tree.nodes, a.id), thread, intelligence,
      brief: contentionBrief({
        trigger: a.trigger, unit: a.id, entry: tree.nodes.get(a.id), diff: unitDiff(xc, tree, a.id, a.head, paths), others, paths, merged,
        guidance: guidanceOf(xc.repo, { config: readConfig(xc.repo) }),
      }),
    })
    if (ruled.status !== 'returned') {
      fault(xc, a.id, channelOf(ruled.cause), 'the ' + a.trigger + ' ruling ' + (ruled.dispatch || thread) + ' failed: ' + (ruled.cause || 'refused'))
      continue
    }
    const judged = judgeClose(xc, { node: a.id, trigger: a.trigger, head: a.head, heads: a.heads || {}, facts: list(a.facts), paths: list(a.paths), dispatch: ruled.dispatch })
    if (judged.rebase) rebase.push({ id: a.id })
    if (judged.outcome === 'replan') replan.push({ id: a.id, question: judged.question })
  }
  return { rebase, replan }
}

/**
 * A merge-batch into `target` (`schedule`'s merge launch), then the ruler on the drift it found in
 * consumers that are not stopped. A refusal is a `program` fault on the target. What the batch set
 * aside for contention, and a leaf whose merge conflicted, go to the judge first (`judgeUnits`). The
 * leaves that failed alone, and those a conflict sends to a rebase round, come back for the program
 * to relaunch (their failures or the rebase wait as a message), and the consumers ruled affected, and
 * the units ruled a replan, for the planner.
 *
 * @param {object} ctx the program's context
 * @param {object} xc the execution's context
 * @param {{target: string, children?: {id: string, head_sha: string}[], cycles?: string[][], intelligence?: string, running?: string[]}} args
 * @returns {Promise<{outcome: 'done'|'stopped'|'held'|'faulted', merged: {id: string, merged_sha: string}[],
 *   failed_alone: {id: string}[], rebase: {id: string}[], drift: {node: string, contract: string, stopped: string}[],
 *   replan: {id: string, question: string}[], unexamined_n: number}>}
 */
export async function mergeUnit(ctx, xc, { target, children = [], cycles = [], intelligence, running = [] }) {
  const out = await mergeBatch(xc, { target, children, cycles, sleep: ctx.sleep, paused: () => pausedAt(readLog(xc.repo, xc.effort, 'events').entries, xc.execution) > 0 })
  if (!out.ok) {
    fault(xc, target, 'program', out.error.kind + ': ' + out.error.message)
    return { outcome: 'faulted', merged: [], failed_alone: [], rebase: [], drift: [], replan: [], unexamined_n: 0 }
  }
  const judged = await judgeUnits(ctx, xc, out, intelligence)
  const done = {
    outcome: out.status, merged: out.merged, failed_alone: out.failed_alone, rebase: judged.rebase, drift: out.drift, replan: judged.replan,
    unexamined_n: out.unexamined_n,
  }
  if (!out.drift_brief) return done
  const ruled = await ruleUnit(ctx, xc, { kind: 'drift', record: out.drift_record, brief: out.drift_brief, intelligence, running })
  return { ...done, replan: [...judged.replan, ...ruled.replan] }
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
  return { outcome: out.status !== 'done' ? out.status : out.passed ? 'passed' : 'failed', review: out.review, head_sha: out.head_sha, record: out.record }
}

/**
 * What a narrowed review is briefed from, or null when the folder's review is due whole: the
 * finished review that stands no more (`narrowableReview`) and what moved since it — the edit to
 * the spec since the text it judged (the folder's latest `compiled` line before it; ledger and
 * events share a seq), the files changed from the head it judged to `head`, the folder's decisions
 * a leaf merged since realises, the leaves merged since — with the blockers it left open and the
 * user's answers on the folder, the latest per question. A spec whose judged text cannot be
 * diffed, and a moved head git cannot diff, are reviewed whole.
 */
function narrowPlan(xc, tree, id, head) {
  const prior = narrowableReview(tree.nodes, tree.events, id)
  if (!prior || !prior.said || !prior.execution) return null
  const ledger = readLog(xc.repo, xc.effort, 'ledger').entries
  const judged = ledger.filter((l) => l.kind === 'compiled' && l.folder === id && l.seq < prior.seq)
    .reduce((best, l) => (!best || l.seq > best.seq ? l : best), null)
  const change = judged ? keptSpecDiff(xc.repo, xc.effort, id, judged.hash) : { ok: false, kind: 'no_copy' }
  if (!change.ok && change.kind !== 'no_diff') return null
  const moved = prior.head_sha !== head
  const files = moved ? git(xc.repo, ['diff', '--name-only', prior.head_sha, head]) : null
  if (files && !files.ok) return null
  const since = tree.events.filter((e) => e.kind === 'merged' && e.seq > prior.seq && typeof e.node === 'string' && ancestorsOf(e.node).includes(id))
  const merged = new Set(since.flatMap((e) => subtreeOf(tree.nodes, e.node)))
  const realised = new Set([...merged].flatMap((k) => list((tree.nodes.get(k) || {}).decisions)))
  const answers = new Map()
  for (const l of ledger) if (l.kind === 'answered' && list(l.nodes).includes(id)) for (const a of list(l.answers)) answers.set(a.question, a)
  return {
    prior,
    diff: change.ok ? change.diff : '',
    delta: files ? { base: prior.head_sha, head, files: files.stdout.split('\n').map((l) => l.trim()).filter(Boolean) } : null,
    decisions: tree.nodes.get(id).defines.map((d) => d.id).filter((d) => realised.has(d)),
    merged,
    answers: [...answers.values()],
  }
}

/**
 * The existing tests the approved leaves under `folder` rewrote outside what they expected: the
 * `tests_rewritten` of each one's measurement at its approved head, from every execution's journal.
 */
function rewrittenUnder(xc, tree, folder) {
  const observed = journalsOf(xc.repo, xc.effort, xc.execution).filter((e) => e.kind === 'verify-observed')
  const files = []
  for (const id of subtreeOf(tree.nodes, folder).filter((k) => (tree.nodes.get(k) || {}).kind === 'leaf')) {
    const approval = tree.events.filter((e) => e.kind === 'approved' && e.node === id).pop()
    const line = approval && observed.filter((e) => e.node === id && e.head_sha === approval.head_sha).pop()
    files.push(...list(line && line.tests_rewritten))
  }
  return [...new Set(files)]
}

/** The spec of each sub-effort of folder `id`, its children with a spec of their own: `{id, path, text}`. */
function childSpecs(xc, tree, id) {
  return [...tree.nodes.values()].filter((n) => parentOf(n.id) === id && n.id !== id && ['composite', 'design'].includes(n.kind)).flatMap((n) => {
    const path = specPath(xc.repo, xc.effort, n.id)
    try {
      return [{ id: n.id, path: posix(relative(xc.repo, path)), text: readFileSync(path, 'utf8') }]
    } catch {
      return []
    }
  })
}

/**
 * Pure. The entries outside folder `id` that wait on it and have not merged, each the topmost such
 * (a waiting folder stands for its entries), with the decisions it realises: `{id, title, context, decisions}`.
 */
function laterEntries(tree, id) {
  const inside = new Set(subtreeOf(tree.nodes, id))
  const waits = new Set([...tree.nodes.keys()].filter((k) => !inside.has(k) && !ancestorsOf(id).includes(k) && k !== ROOT_ID &&
    !['merged', 'integrated'].includes((tree.status.get(k) || {}).status) && dependsOn(tree.nodes, k, id)))
  return [...waits].filter((k) => !waits.has(parentOf(k))).map((k) => {
    const n = tree.nodes.get(k)
    const defined = definedFor(tree.nodes, k)
    return { id: k, title: n.title, context: String(n.context || '').trim(), decisions: list(n.decisions).map((d) => ({ id: d, text: (defined.get(d) || {}).text || '' })) }
  })
}

/**
 * A finished composite (`schedule`'s review launch: `{id, where, unreviewed}`): its suite gate,
 * then, where the gate passed and earned the review, a fresh integration reviewer on
 * `integration:<folder>:<n>`, read-only in the folder's worktree, handed the folder's spec, the
 * merged span, the work agentics did not produce (`outsideWorkOf`: adopted leaves and outside commits), its sub-efforts' specs
 * (`childSpecs`), the entries that run after it (`laterEntries`) and the units it rules — each decision the folder defines, each criterion of a child
 * with no review of its own (a `HUMAN:` one is the user's), each changed file; then folder-review.
 * `n` counts the folder's recorded reviews in this execution, so a relaunch before one is recorded
 * resumes the same thread. A review that returned nothing is a fault on the folder and a lost check.
 * Once a finished review of the folder stands no more, the next is narrowed to what moved since it
 * (`narrowPlan`): the spec's edit, the files changed since its head, the decisions newly realised,
 * its open blockers and its claims not ruled a pass, every other ruling standing.
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
  // Every plan criterion is the gate's observation at this head (a check) or the user's (HUMAN:), never a unit a reviewer rules.
  const measured = list(((gate.record && readJson(gate.record)) || {}).measurement?.checks).map((c) => ({ command: c.command, status: c.status }))
  const units = [
    ...folder.defines.map((d) => 'decision:' + d.id),
    ...changedFiles(xc.repo, span.base, span.head).map((f) => 'file:' + f),
  ]
  const spec_path = posix(specPath(xc.repo, xc.effort, id))
  const n = ctx.log.entries().filter((e) => e.kind === 'claims' && e.node === id && e.review === 'done').length + 1
  const spec = readFileSync(spec_path, 'utf8')
  const guidance = guidanceOf(xc.repo, { config: readConfig(xc.repo) })
  const plan = narrowPlan(xc, tree, id, gate.head_sha)
  const sameAt = (a, b, file) => sameBlob(xc.repo, a, b, file)
  const beyond = { children: childSpecs(xc, tree, id), later: laterEntries(tree, id) }
  const reviewed = await dispatch(ctx, {
    role: 'reviewer', schema: 'reviewer', node: id, thread: 'integration:' + id + ':' + n, intelligence, cwd: worktree || undefined,
    brief: plan
      ? integrationRerule({
        folder: { id, title: folder.title, worktree }, spec, diff: plan.diff, prior: plan.prior.claims, span, delta: plan.delta,
        decisions: plan.decisions, blockers: plan.prior.open, answers: plan.answers, guidance, measured,
        undiscriminated: undiscriminated(tree.nodes, tree.events, id, sameAt).filter((l) => plan.merged.has(l.id)),
        rewritten: rewrittenUnder(xc, tree, id).filter((f) => plan.delta && plan.delta.files.includes(f)), ...beyond,
      })
      : integrationBrief({
        folder: { id, title: folder.title, worktree }, spec, units, span, outside: outsideWorkOf(tree.events, id, list(unreviewed)), guidance,
        undiscriminated: undiscriminated(tree.nodes, tree.events, id, sameAt),
        rewritten: rewrittenUnder(xc, tree, id), measured, ...beyond,
      }),
  })
  if (reviewed.status !== 'returned') {
    fault(xc, id, channelOf(reviewed.cause), 'the integration review of ' + id + ' failed: ' + (reviewed.message || reviewed.cause))
    return { outcome: 'lost', said: '' }
  }
  const out = folderReview(xc, { target: id, head: gate.head_sha, dispatch: reviewed.dispatch, spec_path, prior: plan ? plan.prior : null })
  return out.status === 'recorded' ? { outcome: 'reviewed', said: reviewed.dispatch } : { outcome: 'lost', said: '' }
}
