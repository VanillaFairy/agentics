// lib/programs/execute/folder.mjs — the execute program's folder unit: a planner-written folder
// surveyed when its ground is unknown, written or replanned in its planner's session, checked,
// attacked by nested probe rounds and settled in that same session until the gate opens, then
// prepared and compiled.
//
// Design: docs/DESIGN.md#autonomous-review.

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import { channelOf, faultRecords, recordAll } from '../../boundaries/records.mjs'
import { specCheck, specGate, specPrepare, specReviewed, specSettle } from '../../boundaries/spec.mjs'
import { guidanceOf } from '../../brief.mjs'
import { plannerBrief } from '../../briefs/execute.mjs'
import { PLAN_AXIS } from '../../briefs/probe.mjs'
import { changedFiles } from '../../integration.mjs'
import { readLog } from '../../ledger.mjs'
import { permissionsFor, readOnlyPermissions } from '../../locus.mjs'
import { loadRole } from '../../roles.mjs'
import { pinShaOf, pinTree } from '../../search/pin.mjs'
import { posix, readConfig, readJson, specPath } from '../../store.mjs'
import { definedFor, readTree } from '../../tree.mjs'
import { deliver, dispatch, scoped, step } from '../common.mjs'
import { probe } from '../probe.mjs'
import { survey } from '../survey.mjs'

const list = (v) => (Array.isArray(v) ? v : [])

/** A file's text; '' when there is none to read. */
function textOf(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** The findings a probe round wrote to its file, in full; [] when there is none to read. */
function findingsIn(path) {
  const read = path ? readJson(path) : null
  return Array.isArray(read) ? read : list(read && read.findings)
}

/** The requests that reach the planner as a message of their own, each with the payload its template renders. */
const MESSAGES = {
  needs_context: (r) => ({ node: r.node, text: String(r.text || '') }),
  needs_locus: (r) => ({ node: r.node, paths: list(r.paths), why: String(r.text || '') }),
}
/** The requests whose answer must revise the asking leaf: a replan that leaves it as it was does not converge. */
const REPLANS = ['needs_context', 'needs_locus', 'decompose', 'unsplittable', 'premise_mismatch']

/** The latest round dispatched on `thread` in this execution; 0 before any. */
const lastRound = (xc, thread) => xc.log.entries()
  .filter((e) => e.kind === 'dispatched' && e.thread === thread).reduce((n, e) => Math.max(n, e.round || 0), 0)

/** The planner reads what its role reads and writes the folder's spec alone. */
function plannerPermissions(xc, folder) {
  const { role } = loadRole('planner')
  const writes = permissionsFor({ locus: [posix(relative(xc.repo, specPath(xc.repo, xc.effort, folder)))], tests: false })
  return { allowed: [...readOnlyPermissions(role).allowed, ...writes.allowed], disallowed: writes.disallowed }
}

/**
 * Plan one folder the planner writes: survey its ground when unknown (nested under
 * `survey:<folder>:<basis>`), have the planner write it, or answer `request` (a producer's
 * `{node, status, text, paths}`), check it, and attack it in probe rounds (nested under
 * `probe:<folder>:<n>`, `n` the planner round the round follows, each narrowed to the round
 * before's snapshot), both over the tree pinned for this plan (`tree:<folder>:<basis>`), whose fresh findings the planner settles, until the gate opens and the folder
 * is prepared, or a boundary stops it. Every planner round runs in the folder's one planner session
 * (`planner:<folder>`), each message delivered as its next prompt. Every boundary's answer is
 * journaled under its folder and round, so a relaunch replays what was decided and calls nothing
 * that returned. `survey` is the nested survey's coverage and context file, or null.
 *
 * @param {object} ctx the execute program's context
 * @param {object} xc the execution's boundary context (`executionContext`)
 * @param {{folder: string, intelligence?: string, request?: {node: string, status: string, text?: string, paths?: string[]} | null}} args
 * @returns {Promise<{outcome: 'prepared' | 'stopped' | 'faulted', survey: {complete: boolean, context: string} | null}>}
 */
export async function planFolder(ctx, xc, { folder, intelligence, request = null }) {
  const tree = readTree(xc.repo, xc.effort)
  const node = tree.nodes.get(folder)
  if (!node || node.kind === 'leaf' || node.kind === 'group') throw new Error(folder + ' is not a folder of ' + xc.effort)
  const thread = 'planner:' + folder
  const now = tree.status.get(folder) || {}
  const rederive = now.status === 'parked' && Boolean(now.last) && now.last.return === 'spec_changed'
  const asker = request ? tree.nodes.get(request.node) : null
  const replanning = request && REPLANS.includes(request.status) && asker && asker.kind === 'leaf' ? { node: request.node, rev: asker.seq || 0 } : null
  // A retry of the folder's stop is a new plan: under the stopped plan's basis every step replays,
  // up to the stop the user just cleared.
  const retried = tree.events.reduce((at, e) => (e.kind === 'replanned' && e.reason === 'retry_escalated' && e.node === folder ? Math.max(at, e.seq || 0) : at), 0)
  const basis = (request ? 'answer:' + request.node + ':' + request.status + ':' + ((asker && asker.seq) || 0)
    : 'write:' + (node.seq || 0) + ':' + (rederive ? now.last.seq : 0)) + (retried ? ':retry:' + retried : '')
  let round = await step(ctx, 'plan:' + folder + ':' + basis, () => lastRound(xc, thread) + 1)

  // One tree per plan: the survey and every probe round search the head this plan was made on.
  const env = xc.envelope() || {}
  const sha = await step(ctx, 'tree:' + folder + ':' + basis, () => pinShaOf(xc, folder))
  let pinned = null
  const searched = () => (pinned ??= pinTree(xc.repo, xc.effort, sha))

  let surveyed = null
  let context = ''
  if (!request && !rederive && node.ground_known === false) {
    const found = await survey(scoped(ctx, 'survey:' + folder + ':' + basis, { intelligence }), {
      question: [node.title, node.intent].filter(Boolean).join('\n\n'), roots: ['.'], notes: '', prior: '', max_topics: 8,
      pace: env.pace || 'balanced', ground: [],
      tree: searched(),
      changed: await step(ctx, 'changed:' + folder + ':' + basis, () => (env.base_sha && sha ? changedFiles(xc.repo, env.base_sha, sha) : [])),
    })
    context = found.context ? textOf(found.context) : ''
    surveyed = { complete: found.coverage.complete, context: found.context }
  }

  const path = specPath(xc.repo, xc.effort, folder)
  const defined = definedFor(tree.nodes, folder)
  const about = {
    folder: { id: folder, title: node.title, intent: node.intent, spec_path: path, why: rederive ? 'spec_changed' : '' },
    spec: textOf(path), decisions: node.decisions.map((id) => ({ id, text: (defined.get(id) || {}).text || '' })),
    guidance: guidanceOf(xc.repo, { config: readConfig(xc.repo) }), context,
  }
  const answer = request && !MESSAGES[request.status] ? plannerBrief({ ...about, mode: 'answer', request }) : ''
  const planner = {
    role: 'planner', schema: 'planner_write', node: folder, thread, intelligence, cwd: xc.repo,
    permissions: plannerPermissions(xc, folder), threadBrief: answer || plannerBrief({ ...about, mode: 'write' }),
  }

  const end = (outcome) => ({ outcome, survey: surveyed })
  const fault = (channel, detail) => {
    const t = readTree(xc.repo, xc.effort)
    recordAll(xc, faultRecords(folder, channel, detail, { nodes: t.nodes, events: t.events, state: readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries }))
    return end('faulted')
  }
  const failed = (d) => fault(channelOf(d.cause), 'the planner dispatch ' + d.dispatch + ' failed: ' + d.cause)
  const refused = (error) => fault('program', 'a spec boundary refused ' + folder + ': ' + error.kind + ': ' + error.message)

  /** Check the spec the planner's latest round left, sending its problems back until it checks or stops. */
  const check = async (latest) => {
    for (let d = latest; ;) {
      if (d.status !== 'returned') return { end: failed(d) }
      const checked = await step(ctx, 'check:' + folder + ':' + round, () => specCheck(xc, { folder, dispatch: d.dispatch }))
      if (checked.status === 'held') return { end: end('faulted') }
      if (checked.status === 'stopped') return { end: end('stopped') }
      if (checked.status === 'checked') return { checked }
      round += 1
      d = await dispatch(ctx, { ...planner, round })
    }
  }

  /** The planner settles the round's fresh findings in its session; refusals go back until it settles or stops. */
  const settle = async (result, fresh) => {
    const handles = list(result.findings).filter((f) => fresh.includes(f.id))
    round += 1
    let d = await deliver(ctx, {
      ...planner, schema: 'planner_settle', round, msg: 'findings', payload: { findings: findingsIn(result.findings_file).filter((f) => fresh.includes(f.id)) },
    })
    for (;;) {
      if (d.status !== 'returned') return { end: failed(d) }
      const settled = await step(ctx, 'settle:' + folder + ':' + round, () => specSettle(xc, { folder, dispatch: d.dispatch, findings: handles }))
      if (settled.ok === false) return { end: refused(settled.error) }
      if (settled.status === 'held') return { end: end('faulted') }
      if (settled.status === 'stopped') return { end: end('stopped') }
      if (settled.status === 'settled') return { edited: settled.incorporated_n > 0, latest: d }
      round += 1
      d = await dispatch(ctx, { ...planner, schema: 'planner_settle', round })
    }
  }

  const first = request && MESSAGES[request.status]
    ? await deliver(ctx, { ...planner, round, msg: request.status, payload: MESSAGES[request.status](request) })
    : await dispatch(ctx, { ...planner, round, brief: planner.threadBrief })
  let at = await check(first)
  if (at.end) return at.end
  let previous = null
  for (;;) {
    const n = round
    const result = await probe(scoped(ctx, 'probe:' + folder + ':' + n, { intelligence }), {
      artifact: path, artifact_text: textOf(path), roots: ['.'], context: '', per_axis: false, since: previous ? previous.snapshot : '',
      tree: searched(), axes: [PLAN_AXIS],
    })
    const reviewed = await step(ctx, 'reviewed:' + folder + ':' + n, () => specReviewed(xc, { folder, result, previous }))
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
    const gate = await step(ctx, 'gate:' + folder + ':' + n, () => specGate(xc, { folder, edited }))
    if (gate.ratifiable) {
      const prepared = await step(ctx, 'prepare:' + folder + ':' + n, () =>
        specPrepare(xc, { folder, review: result.review || result.snapshot || at.checked.hash, replanning }))
      if (prepared.ok === false) return refused(prepared.error)
      return end(prepared.status === 'prepared' ? 'prepared' : 'stopped')
    }
    if (gate.status === 'stopped' || !latest) return end('stopped')
    at = await check(latest)
    if (at.end) return at.end
    previous = result
  }
}
