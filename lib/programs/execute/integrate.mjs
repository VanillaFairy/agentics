// lib/programs/execute/integrate.mjs — the execute program's integration units: a merge-batch, the
// ruler on what it set aside or met as a conflict and on its drift, a composite's suite gate and
// integration review, a ruler on drift or on a moved base.
//
// Design: docs/DESIGN.md#landing-and-drift.

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import { pausedNow } from '../../boundaries/execution.mjs'
import { folderReview, integrationDelta, integrationUnits, lastReview, ruleClose } from '../../boundaries/integration.mjs'
import { judgeClose, judgeThread, judgedUnits } from '../../boundaries/judge.mjs'
import { mergeBatch, suiteGate } from '../../boundaries/merge.mjs'
import { dispatchFailed, faultRecords, recordAll } from '../../boundaries/records.mjs'
import { guidanceOf } from '../../brief.mjs'
import { contentionBrief, integrationBrief } from '../../briefs/execute.mjs'
import { changedFiles, leafNet } from '../../integration.mjs'
import { readLog } from '../../ledger.mjs'
import { outsideWorkOf } from '../../schedule.mjs'
import { hashSpec, keptSpecDiff } from '../../spec.mjs'
import { ROOT_ID, ancestorsOf, blobsAt, branchOf, git, nodeKey, parentOf, posix, readConfig, readJson, specPath } from '../../store.mjs'
import { journalsOf } from '../../resume.mjs'
import { dependsOn } from '../../atomicity.mjs'
import { cycleOf, definedFor, ownerOf, readTree, subtreeOf } from '../../tree.mjs'
import { missedAgain, undiscriminated } from '../../verdict.mjs'
import { canonical, fnv1a } from '../../plan-digest.mjs'
import { dispatch } from '../common.mjs'

const list = (v) => (Array.isArray(v) ? v : [])
const stateOf = (xc) => readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries
const rootOf = (xc) => (xc.envelope() || {}).root || ROOT_ID

/** The tree's nodes and events and the execution's state as they stand, which fault records read. */
function atNow(xc) {
  const tree = readTree(xc.repo, xc.effort)
  return { nodes: tree.nodes, events: tree.events, state: stateOf(xc) }
}

/** A fault on `node`, recorded: it holds the node for the rest of the run. */
function fault(xc, node, channel, detail) {
  recordAll(xc, faultRecords(node, channel, detail, atNow(xc)))
}

/**
 * Pure. The drift ruler's thread for merge-batch's record `rec`: its target and a digest of the open
 * items it rules — each consumer, contract, files and the ruling it is ruled after — at the head they
 * drifted to. The same drift is the same question, replayed; any other is a fresh ruler.
 */
export function driftThread(rec) {
  const open = list(rec.drift).filter((d) => !d.stopped && !d.standing)
    .map((d) => ({ node: d.node, contract: d.contract, files: list(d.files), before: d.before ? d.before.seq : 0 }))
  return 'ruler:drift:' + (nodeKey(rec.target || ROOT_ID) || 'root') + ':' + fnv1a(canonical({ head: rec.head_sha || '', open }))
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
    ? driftThread(rec)
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
 * one fresh ruler per question (`judgeThread`) on the folder being merged into, handed both sides' plan
 * entries and changes, then judge-close. A unit a ruler left out is its miss, as a reviewer's is
 * (`missedAgain`): it goes to the next fresh ruler (`<thread>:<n>`), handed only the units still
 * unruled, and one an earlier ruler of the question missed too ends the asking, judge-close
 * escalating it `review_incomplete`. A serialize or a resolve of contention needs nothing more
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
    const question = judgeThread(tree, { trigger: a.trigger, id: a.id, head: a.head, facts: a.facts, heads: a.heads || {}, paths })
    const asked = []
    const misses = []
    let missing = judgedUnits(a.trigger, a.facts)
    let failed = false
    for (let n = 1; ; n++) {
      const thread = n === 1 ? question : question + ':' + n
      // On the folder being merged into: a dispatch on the approved leaf would read as its next round.
      const ruled = await dispatch(ctx, {
        role: 'ruler', schema: 'ruler_contention', node: ownerOf(tree.nodes, a.id), thread, intelligence,
        brief: contentionBrief({
          trigger: a.trigger, unit: a.id, entry: tree.nodes.get(a.id), diff: unitDiff(xc, tree, a.id, a.head, paths),
          others: others.filter((o) => missing.includes(o.id)), paths, merged, guidance: guidanceOf(xc.repo, { config: readConfig(xc.repo) }),
        }),
      })
      if (ruled.status !== 'returned') {
        recordAll(xc, dispatchFailed(a.id, 'the ' + a.trigger + ' ruling ' + (ruled.dispatch || thread), ruled, atNow(xc)))
        failed = true
        break
      }
      asked.push(ruled.dispatch)
      const ruledUnits = new Set(list(ruled.output && ruled.output.rulings).map((r) => r && r.unit))
      const left = missing.filter((u) => !ruledUnits.has(u))
      const again = missedAgain(left, misses)
      misses.push(left)
      missing = left
      if (left.length === 0 || again.length) break
    }
    if (failed) continue
    const judged = judgeClose(xc, {
      node: a.id, trigger: a.trigger, head: a.head, heads: a.heads || {}, facts: list(a.facts), paths: list(a.paths), dispatch: asked[0], also: asked.slice(1).reverse(),
    })
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
  const out = await mergeBatch(xc, { target, children, cycles, sleep: ctx.sleep, paused: () => pausedNow(xc) > 0 })
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
 * Each decision folder `id` defines, with the seqs of the merges beneath the folder that carry an
 * entry realising it and the blob at `head` of each file those merges touched, the code it rests
 * on: what a `decision:<id>` unit is anchored to (`integrationUnits`).
 */
function decisionsOf(repo, tree, id, head) {
  const merges = tree.events.filter((e) => e.kind === 'merged' && typeof e.node === 'string' && ancestorsOf(e.node).includes(id))
    .map((e) => ({ seq: e.seq, sha: String(e.merged_sha || ''), realises: new Set(subtreeOf(tree.nodes, e.node).flatMap((k) => list((tree.nodes.get(k) || {}).decisions))) }))
  const touched = new Map()
  const filesOf = (sha) => {
    if (!touched.has(sha)) touched.set(sha, sha ? changedFiles(repo, sha + '^1', sha) : [])
    return touched.get(sha)
  }
  return tree.nodes.get(id).defines.map((d) => {
    const mine = merges.filter((m) => m.realises.has(d.id))
    const paths = [...new Set(mine.flatMap((m) => filesOf(m.sha)))].sort()
    const blobs = blobsAt(repo, head, paths)
    return { id: d.id, text: d.text, merges: mine.map((m) => m.seq), rests: paths.map((p) => [p, blobs.get(p) || 'deleted']) }
  })
}

/** The user's answers recorded on folder `id`, the latest per question. */
function answersOn(xc, id) {
  const answers = new Map()
  for (const l of readLog(xc.repo, xc.effort, 'ledger').entries) {
    if (l.kind === 'answered' && list(l.nodes).includes(id)) for (const a of list(l.answers)) answers.set(a.question, a)
  }
  return [...answers.values()]
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
 * The units are ruled over the folder's last finished review (`integrationDelta` over
 * `lastReview`): a unit whose ruling stands at its anchor is not ruled again, and the reviewer is
 * handed that review's claims, the blockers it left open, the user's answers on the folder and the
 * spec's edit since the text its `spec` ruling was made on (`keptSpecDiff`).
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
  const spec_path = posix(specPath(xc.repo, xc.effort, id))
  const n = ctx.log.entries().filter((e) => e.kind === 'claims' && e.node === id && e.review === 'done').length + 1
  const spec = readFileSync(spec_path, 'utf8')
  const last = lastReview(tree.events.findLast((e) => e.kind === 'claims' && e.node === id && e.review === 'done'))
  const files = changedFiles(xc.repo, span.base, span.head)
  const current = integrationUnits({
    decisions: decisionsOf(xc.repo, tree, id, span.head), files, blobs: blobsAt(xc.repo, span.head, files), specHash: hashSpec(spec), head: span.head, claims: last ? last.claims : [],
  })
  const { delta, edit } = integrationDelta(last, current, (anchor) => keptSpecDiff(xc.repo, xc.effort, id, anchor))
  const ruled = new Set(delta.rule.map((r) => r.unit))
  const journal = journalsOf(xc.repo, xc.effort, xc.execution)
  const reviewed = await dispatch(ctx, {
    role: 'reviewer', schema: 'reviewer', node: id, thread: 'integration:' + id + ':' + n, intelligence, cwd: worktree || undefined,
    brief: integrationBrief({
      folder: { id, title: folder.title, worktree }, spec, delta, span, last, diff: edit && edit.ok ? edit.diff : '', answers: answersOn(xc, id),
      outside: outsideWorkOf(tree.events, id, list(unreviewed)), guidance: guidanceOf(xc.repo, { config: readConfig(xc.repo) }), measured,
      undiscriminated: undiscriminated(tree.nodes, tree.events, journal, id).filter((l) => l.nets.some((x) => ruled.has('file:' + x.file))),
      rewritten: rewrittenUnder(xc, tree, id).filter((f) => ruled.has('file:' + f)),
      children: childSpecs(xc, tree, id), later: laterEntries(tree, id),
    }),
  })
  if (reviewed.status !== 'returned') {
    recordAll(xc, dispatchFailed(id, 'the integration review of ' + id, reviewed, atNow(xc)))
    return { outcome: 'lost', said: '' }
  }
  const out = folderReview(xc, { target: id, head: gate.head_sha, dispatch: reviewed.dispatch, spec_path, prior: last, delta })
  return out.status === 'recorded' ? { outcome: 'reviewed', said: reviewed.dispatch } : { outcome: 'lost', said: '' }
}
