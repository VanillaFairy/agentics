// lib/programs/execute/folder.mjs — the execute program's folder unit: a planner-written folder
// surveyed when its ground is unknown, written or replanned in its planner's session, checked,
// attacked by nested probe rounds and settled in that same session until the gate opens, then
// prepared and compiled; parked for the user when its design outspends its plan's build cost.
//
// Design: docs/DESIGN.md#autonomous-review.

import { relative } from 'node:path'

import { dispatchFailed, faultRecords, parked, recordAll } from '../../boundaries/records.mjs'
import { approvalState } from '../../approval.mjs'
import { editedPlanKey, stoppedAt } from '../../boundaries/execution.mjs'
import { specCheck, specGate, specPrepare, specReviewed, specSettle } from '../../boundaries/spec.mjs'
import { guidanceOf } from '../../brief.mjs'
import { plannerBrief } from '../../briefs/execute.mjs'
import { PLAN_AXIS } from '../../briefs/probe.mjs'
import { latestCites } from '../../evidence.mjs'
import { changedFiles } from '../../integration.mjs'
import { readLog } from '../../ledger.mjs'
import { readOnlyPermissions, writePermissions } from '../../permissions.mjs'
import { loadRole } from '../../roles.mjs'
import { pinShaOf, pinTree } from '../../search/pin.mjs'
import { parseSpec } from '../../spec.mjs'
import { costOf, designPlace } from '../../status.mjs'
import { ancestorsOf, posix, readConfig, readJson, readText, specPath } from '../../store.mjs'
import { clearedAt, definedFor, readTree } from '../../tree.mjs'
import { deliver, dispatch, scoped, step, stepped } from '../common.mjs'
import { probe } from '../probe.mjs'
import { survey } from '../survey.mjs'

const list = (v) => (Array.isArray(v) ? v : [])

/** A file's text; '' when there is none to read. */
const fileText = (path) => readText(path) ?? ''

/**
 * The items the nearest live ancestor with a citation rests on, which a survey of `folder` starts from:
 * that citation already holds what its own ancestors' did, so a union over all of them would only grow.
 */
function inheritedItems(repo, effort, folder, nodes) {
  const cites = latestCites(readLog(repo, effort, 'cites').entries)
  const from = ancestorsOf(folder).find((id) => nodes.has(id) && cites.has(id))
  return from ? list(cites.get(from).items).map(String) : []
}

/** The findings a probe round wrote to its file, in full; [] when there is none to read. */
function findingsIn(path) {
  const read = path ? readJson(path) : null
  return Array.isArray(read) ? read : list(read && read.findings)
}

/** The requests that reach the planner as a message of their own, each with the payload its template renders. */
const MESSAGES = {
  needs_context: (r) => ({ node: r.node, text: String(r.text || '') }),
}
/** What a planner is told of a spec the session edited on the user's word. */
const EDITED = "spec_edited: the session edited this spec on the user's word; keep its edits, and change only what a finding asks for"

/** The requests about the asking leaf itself: only a revision of that leaf answers them. */
const REVISES = ['needs_context', 'decompose', 'unsplittable', 'premise_mismatch']

/**
 * Pure. What a planner's answer to a request a leaf routed must change, or null for a folder's own
 * request: `{node, rev}`, the leaf at the revision it asked from, which a request about the leaf
 * itself must revise; any other (a verify finding) is answered as well by a spec other than `from`,
 * the folder's spec hash the answer started from, so it carries `from`. An answer that changes
 * neither does not converge.
 */
export const replanOf = (request, asker, from = '') => (request && asker && asker.kind === 'leaf'
  ? { node: request.node, rev: asker.seq || 0, ...(REVISES.includes(request.status) ? {} : { from }) } : null)

// What a folder's design may spend, as a multiple of its plan's build cost, before the user is asked
// whether to go on (`design_spend_multiple` in the project's config overrides it).
const DESIGN_SPEND_MULTIPLE = 5
// One entry's build cost while the effort has no merged leaf fully measured.
const LEAF_USD_DEFAULT = 2
const BUILT = ['task', 'sub-effort']

/** Pure. What this execution's dispatches for `folder`'s design cost: its planner, its surveys, its probe rounds. */
export function designSpend(entries, folder) {
  const mine = new Set(entries.filter((e) => e.kind === 'dispatched' && designPlace(e.thread, folder)).map((e) => e.dispatch))
  return entries.reduce((usd, e) => (e.kind === 'returned' && mine.has(e.dispatch) && typeof e.cost_usd === 'number' ? usd + e.cost_usd : usd), 0)
}

/**
 * Pure. The design spend a folder may reach before it parks `design_spend`: the multiple of its
 * frozen plan's build cost, once more for every time the user already went on past it.
 */
const designAllowance = ({ entries, leafUsd, multiple, parks }) => multiple * Math.max(1, entries) * leafUsd * (parks + 1)

/** Park the folder `design_spend` when its design has spent past its allowance; whether it stopped. */
function spendCheck(xc, folder, entries) {
  const usd = designSpend(xc.log.entries(), folder)
  const parks = readTree(xc.repo, xc.effort).events.filter((e) => e.kind === 'parked' && e.node === folder && e.return === 'design_spend').length
  const configured = Number(readConfig(xc.repo).design_spend_multiple)
  const multiple = configured > 0 ? configured : DESIGN_SPEND_MULTIPLE
  const measured = costOf(xc.repo, xc.effort).leaf_mean_usd
  const leafUsd = measured ?? LEAF_USD_DEFAULT
  const allowance = designAllowance({ entries, leafUsd, multiple, parks })
  if (usd <= allowance) return { stopped: false, usd, allowance }
  const question = 'designing ' + folder + ' has spent $' + usd.toFixed(2) + ' (planner, survey and review) against $' +
    allowance.toFixed(2) + ' = ' + multiple + ' x ' + entries + ' entries x $' + leafUsd.toFixed(2) + ' per leaf (' +
    (measured === null ? 'no merged leaf measured yet' : 'the effort\'s merged leaves') + ')' +
    (parks ? ', after ' + parks + ' earlier go-on' : '') + ': go on, cut the scope, or hand it to a task'
  const { stops } = recordAll(xc, [parked(folder, 'design_spend', question)])
  return { stopped: stops.length > 0, usd, allowance }
}

/** The snapshot of the folder's latest complete review, as a probe's `since`; '' before any. */
function lastReviewed(xc, folder) {
  const done = readLog(xc.repo, xc.effort, 'ledger').entries.filter((l) => l.kind === 'reviewed' && l.folder === folder && l.complete === true && l.hash)
  return done.length ? 'snapshot:' + done[done.length - 1].hash : ''
}

/**
 * The round a new plan of `folder` starts on: past every round dispatched on `thread` in this
 * execution and past every earlier plan's start, since a plan of an edit journals its first steps
 * at its start round without dispatching on it.
 */
const firstRound = (ctx, xc, folder, thread) => 1 + Math.max(
  ...xc.log.entries().filter((e) => e.kind === 'dispatched' && e.thread === thread).map((e) => e.round || 0),
  ...stepped(ctx, (e) => e.key.startsWith('plan:' + folder + ':')).map((e) => (Number.isInteger(e.value) ? e.value : 0)),
  0,
)

/** The planner reads what its role reads and writes the folder's spec alone. */
function plannerPermissions(xc, folder) {
  const { role } = loadRole('planner')
  const writes = writePermissions([posix(relative(xc.repo, specPath(xc.repo, xc.effort, folder)))])
  return { allowed: [...readOnlyPermissions(role).allowed, ...writes.allowed], disallowed: writes.disallowed }
}

/**
 * Plan one folder the planner writes: survey its ground when unknown (nested under
 * `survey:<folder>:<basis>`), have the planner write it, or answer `request` (a producer's
 * `{node, status, text, paths}`), check it, and attack it in probe rounds (nested under
 * `probe:<folder>:<n>`, `n` the planner round the round follows, each narrowed to the round
 * before's snapshot), both over the tree pinned for this plan (`tree:<folder>:<basis>`), whose fresh findings the planner settles, until the gate opens and the folder
 * is prepared, or a boundary stops it. Before each probe round the folder's design spend is held to
 * its allowance over the plan's entries as first checked (`entries:<folder>`). Every planner round runs in the folder's one planner session
 * (`planner:<folder>`), each message delivered as its next prompt. Every boundary's answer is
 * journaled under its folder and round, so a relaunch replays what was decided and calls nothing
 * that returned. `survey` is the nested survey's coverage and context file, or null. With `why`
 * `spec_edited` the spec is the session's edit, made on the user's word over the folder's park: the
 * planner writes nothing first, the edit is checked as the user's, reviewed, settled by the planner
 * and prepared, and the park it answers is cleared (basis `edited:<hash>`).
 *
 * @param {object} ctx the execute program's context
 * @param {object} xc the execution's boundary context (`executionContext`)
 * @param {{folder: string, intelligence?: string, request?: {node: string, status: string, text?: string, paths?: string[]} | null,
 *   why?: string}} args
 * @returns {Promise<{outcome: 'prepared' | 'stopped' | 'faulted', survey: {complete: boolean, context: string, invalidated: string[]} | null}>}
 */
export async function planFolder(ctx, xc, { folder, intelligence, request = null, why = '' }) {
  const tree = readTree(xc.repo, xc.effort)
  const node = tree.nodes.get(folder)
  if (!node || node.kind === 'leaf' || node.kind === 'group') throw new Error(folder + ' is not a folder of ' + xc.effort)
  const thread = 'planner:' + folder
  const now = tree.status.get(folder) || {}
  const rederive = now.status === 'parked' && Boolean(now.last) && now.last.return === 'spec_changed'
  const asker = request ? tree.nodes.get(request.node) : null
  // A folder cleared since its revision (a retry of its stop, an answer) is a new plan: under the
  // stopped plan's basis every step replays, up to the stop the user just cleared.
  const cleared = clearedAt(tree.nodes, tree.events, folder)
  const editing = why === 'spec_edited' && !request
  const answering = editing && now.status === 'parked' && now.last ? now.last.seq || 0 : 0
  const basis = editing ? editedPlanKey(folder, stoppedAt(tree.events, folder), cleared).slice(('plan:' + folder + ':').length)
    : (request ? 'answer:' + request.node + ':' + request.status + ':' + ((asker && asker.seq) || 0)
      : 'write:' + (node.seq || 0) + ':' + (rederive ? now.last.seq : 0)) + (cleared > (node.seq || 0) ? ':cleared:' + cleared : '')
  const planKey = 'plan:' + folder + ':' + basis
  let round = await step(ctx, planKey, () => firstRound(ctx, xc, folder, thread))
  // What this plan journaled is all it replays: a step at a round an earlier plan used is that plan's answer.
  const own = { ...ctx, replayAfter: stepped(ctx, (e) => e.key === planKey)[0].seq }
  const from = request ? await step(own, 'from:' + folder + ':' + basis, () => approvalState(xc.repo, xc.effort, folder).hash) : ''
  const replanning = replanOf(request, asker, from)

  // One tree per plan: the survey and every probe round search the head this plan was made on.
  const env = xc.envelope() || {}
  const sha = await step(own, 'tree:' + folder + ':' + basis, () => pinShaOf(xc, folder))
  let pinned = null
  const searched = () => (pinned ??= pinTree(xc.repo, xc.effort, sha))

  let surveyed = null
  let context = ''
  if (!request && !rederive && !editing && node.ground_known === false) {
    const found = await survey(scoped(own, 'survey:' + folder + ':' + basis, { intelligence }), {
      question: [node.title, node.intent].filter(Boolean).join('\n\n'), roots: ['.'], notes: '', prior: '', max_topics: 8,
      pace: env.pace || 'balanced', ground: [],
      items: await step(own, 'inherited:' + folder + ':' + basis, () => inheritedItems(xc.repo, xc.effort, folder, tree.nodes)),
      tree: searched(),
      changed: await step(own, 'changed:' + folder + ':' + basis, () => (env.base_sha && sha ? changedFiles(xc.repo, env.base_sha, sha) : [])),
    })
    context = found.context ? fileText(found.context) : ''
    surveyed = { complete: found.coverage.complete, context: found.context, invalidated: list(found.invalidated) }
  }

  const path = specPath(xc.repo, xc.effort, folder)
  const defined = definedFor(tree.nodes, folder)
  const about = {
    folder: { id: folder, title: node.title, intent: node.intent, spec_path: path, why: rederive ? 'spec_changed' : editing ? EDITED : '' },
    spec: fileText(path), decisions: node.decisions.map((id) => ({ id, text: (defined.get(id) || {}).text || '' })),
    guidance: guidanceOf(xc.repo, { config: readConfig(xc.repo) }), context,
  }
  const answer = request && !MESSAGES[request.status] ? plannerBrief({ ...about, mode: 'answer', request }) : ''
  const planner = {
    role: 'planner', schema: 'planner_write', node: folder, thread, intelligence, cwd: xc.repo,
    permissions: plannerPermissions(xc, folder), threadBrief: answer || plannerBrief({ ...about, mode: editing ? 'settle' : 'write' }),
  }

  const end = (outcome) => ({ outcome, survey: surveyed })
  const standing = () => {
    const t = readTree(xc.repo, xc.effort)
    return { nodes: t.nodes, events: t.events, state: readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries }
  }
  const failed = (d) => {
    const records = dispatchFailed(folder, 'the planner dispatch ' + d.dispatch, d, standing())
    recordAll(xc, records)
    return end(records[0].kind === 'escalated' ? 'stopped' : 'faulted')
  }
  const refused = (error) => {
    recordAll(xc, faultRecords(folder, 'program', 'a spec boundary refused ' + folder + ': ' + error.kind + ': ' + error.message, standing()))
    return end('faulted')
  }

  /** Check the spec the planner's latest round left, sending its problems back until it checks or stops. */
  const check = async (latest) => {
    for (let d = latest; ;) {
      if (d.status !== 'returned') return { end: failed(d) }
      const checked = await step(own, 'check:' + folder + ':' + round, () => specCheck(xc, { folder, dispatch: d.dispatch }))
      if (checked.status === 'held') return { end: end('faulted') }
      if (checked.status === 'stopped') return { end: end('stopped') }
      if (checked.status === 'checked') return { checked }
      round += 1
      d = await dispatch(own, { ...planner, round })
    }
  }

  /** The planner settles the round's fresh findings in its session; refusals go back until it settles or stops. */
  const settle = async (result, fresh) => {
    const handles = list(result.findings).filter((f) => fresh.includes(f.id))
    round += 1
    let d = await deliver(own, {
      ...planner, schema: 'planner_settle', round, msg: 'findings', payload: { findings: findingsIn(result.findings_file).filter((f) => fresh.includes(f.id)) },
    })
    for (;;) {
      if (d.status !== 'returned') return { end: failed(d) }
      const settled = await step(own, 'settle:' + folder + ':' + round, () => specSettle(xc, { folder, dispatch: d.dispatch, findings: handles }))
      if (settled.ok === false) return { end: refused(settled.error) }
      if (settled.status === 'held') return { end: end('faulted') }
      if (settled.status === 'stopped') return { end: end('stopped') }
      if (settled.status === 'settled') return { edited: settled.incorporated_n > 0, latest: d }
      round += 1
      d = await dispatch(own, { ...planner, schema: 'planner_settle', round })
    }
  }

  let at
  if (editing) {
    const checked = await step(own, 'check:' + folder + ':' + round, () => specCheck(xc, { folder, dispatch: '', users: true }))
    if (checked.status === 'held') return end('faulted')
    if (checked.status !== 'checked') return end('stopped')
    at = { checked }
    // A gate already open on this very text (its review recorded, its findings settled) is prepared now.
    const pre = await step(own, 'gate:' + folder + ':' + round + ':before', () => specGate(xc, { folder, edited: true }))
    if (pre.ratifiable) {
      const prepared = await step(own, 'prepare:' + folder + ':' + round + ':before', () =>
        specPrepare(xc, { folder, review: checked.hash, replanning, answering }))
      if (prepared.ok === false) return refused(prepared.error)
      return end(prepared.status === 'prepared' ? 'prepared' : 'stopped')
    }
  } else {
    const first = request && MESSAGES[request.status]
      ? await deliver(own, { ...planner, round, msg: request.status, payload: MESSAGES[request.status](request) })
      : await dispatch(own, { ...planner, round, brief: planner.threadBrief })
    at = await check(first)
    if (at.end) return at.end
  }
  const entries = await step(ctx, 'entries:' + folder, () => parseSpec(fileText(path)).entries.filter((e) => BUILT.includes(e.kind)).length)
  let previous = null
  // A plan's first round is narrowed to what changed since the folder's last complete review: the
  // text that review read was judged, and its standing findings are carried, whichever plan made it.
  const reviewedBefore = await step(own, 'since:' + folder + ':' + basis, () => lastReviewed(xc, folder))
  for (;;) {
    const n = round
    const spent = await step(own, 'spend:' + folder + ':' + n, () => spendCheck(xc, folder, entries))
    if (spent.stopped) return end('stopped')
    const result = await probe(scoped(own, 'probe:' + folder + ':' + n, { intelligence }), {
      artifact: path, artifact_text: fileText(path), roots: ['.'], context: '', per_axis: false, since: previous ? previous.snapshot : reviewedBefore,
      tree: searched(), axes: [PLAN_AXIS],
    })
    const reviewed = await step(own, 'reviewed:' + folder + ':' + n, () => specReviewed(xc, { folder, result, previous }))
    if (reviewed.ok === false) return refused(reviewed.error)
    if (reviewed.status === 'held') return end('faulted')
    if (reviewed.status === 'stopped') return end('stopped')
    let edited = false
    let latest = null
    if (reviewed.fresh.length) {
      const settled = await settle(result, reviewed.fresh)
      if (settled.end) return settled.end
      edited = settled.edited
      latest = settled.latest
    }
    const gate = await step(own, 'gate:' + folder + ':' + n, () => specGate(xc, { folder, edited }))
    if (gate.ratifiable) {
      const prepared = await step(own, 'prepare:' + folder + ':' + n, () =>
        specPrepare(xc, { folder, review: result.review || result.snapshot || at.checked.hash, replanning, answering }))
      if (prepared.ok === false) return refused(prepared.error)
      return end(prepared.status === 'prepared' ? 'prepared' : 'stopped')
    }
    if (gate.status === 'stopped' || !latest) return end('stopped')
    at = await check(latest)
    if (at.end) return at.end
    previous = result
  }
}
