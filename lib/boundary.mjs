// lib/boundary.mjs — the boundaries of an execution, plus landing: every deterministic step an
// execution takes, scheduling and every decision record included, fused per boundary into one
// entry point run by one courier.
//
// Design: docs/DESIGN.md#boundaries.
//
// Why fused. A workflow script has no filesystem, so every step that touches disk is a courier
// dispatch, and every courier is a round trip on the critical path. The count of BOUNDARIES, not
// of facts, sets the floor — so each boundary does everything that happens there in one process:
// leaf-open takes the slot and the locus locks, cuts the branches, attaches the worktree, writes
// the brief and appends `dispatched`; leaf-close reads what the executor returned, commits a
// shell-less author's files, measures, journals, writes gotchas, decides and records.
//
// Why handles. A courier's command carries only handles (ids, paths, shas, enums, counts) and it
// pastes back one line of the same (docs/DESIGN.md#gp6--couriers-carry-handles-data-stays-where-its-author-wrote-it).
// What an agent decided it wrote to a file its dispatch named; the boundary that closes that
// dispatch reads the file, computes what it means and records it. The workflow mints no record.
//
// Why idempotent. A courier can die after the program finished and before anyone saw the output.
// So each step first asks whether its effect already exists — a merge already in the branch, a
// record already the node's word, a worktree already attached — and a re-run converges on the same
// state. That is what licenses re-dispatching a boundary whose outcome was not observed.
//
// Why detached. A host's shell call has a time limit and a build plus a suite can outlast it. So
// leaf-close and merge-batch run their work in a detached child keyed by their arguments and poll
// it; a poll that reaches the limit returns `pending`, and the workflow re-dispatches the same
// boundary, which finds the same job and keeps polling. The shell limit can end a courier, never
// the work.
//
// What it never does: decide a verdict it did not compute from observations, touch the user's
// branch (except `land`, which only the session runs, on the user's go), or repair a record.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { approvalGate, recordDisposition, recordPreparation, recordReviewed } from './approval.mjs'
import { assembleBrief } from './brief.mjs'
import { compileEffort } from './compile.mjs'
import { commandsOf, deleteGotcha, extractReportBlocks, writeGotcha } from './gotchas.mjs'
import {
  attach, changedFiles, contains, detach, effortBase, ensureIntegration, ensureLeaf, mergeUnits, readText,
  resetTo, worktrees,
} from './integration.mjs'
import { acquire, holderReader, maxParallel, releaseLocus, releaseSlots, withBranchLock } from './locks.mjs'
import { append, readLog } from './ledger.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import { renderLanding } from './render.mjs'
import { approvedHead, journalsOf, resumeLeaves } from './resume.mjs'
import { reviewOf, schedule, summarize } from './schedule.mjs'
import { checkFolder } from './spec.mjs'
import {
  ROOT_ID, STAMP, AGENTICS_DIR, ancestorsOf, branchExists, branchOf, briefPath, cardPath, closePath, executionDir, executionsRoot,
  fixesPath, flagOf, gatePath, git, handleArgs, handleEnvelope, inLocus, isAncestorOrSelf, mergePath, mkdirState,
  nameKey, nodeBranchGlob, nodeKey, posix, readJson, reportPath, reviewPath, revParse, safeSlug, saidDir, saidOf, sleepMs, specPath, stalePath,
  worktreeOf, worktreeOfBranch, writeJson,
} from './store.mjs'
import { trace } from './traceability.mjs'
import { collectUsage } from './usage.mjs'
import {
  childrenOf, claimsOf, cycleOf, cycleTestLocus, executorRole, isHuman, isYardstick, ownReview, ownerOf, readTree,
  subtreeOf, testLocusAdmits,
} from './tree.mjs'
import {
  auditGap, closeDecision, failureKey, fixNotConverging, heldMutations, integrationPark, reviewExit, suiteFailed,
} from './verdict.mjs'
import { verify, worktreeProblem } from './verify.mjs'

const SELF = fileURLToPath(import.meta.url)

/** How long one boundary call polls a detached job before answering `pending`. */
// Under the courier's own shell-call limit (its prompt asks for 600 s): a job still running, or
// queued behind the project's test lock, answers `pending` and the workflow re-dispatches, which is
// safe because the same arguments find the same job. Each re-dispatch is a courier, so the wait is
// as long as that limit allows.
const pollLimit = () => Number.parseInt(process.env.AGENTICS_BOUNDARY_WAIT_MS || '', 10) || 540 * 1000

// ------------------------------------------------------------------ arguments

/**
 * Every entry point's argv, as `handleArgs` parses it: `one` a string, `many` a repeated flag,
 * `int` a number, `bool` `1`/`0`. `dispatch` names every agent dispatch the call closes, its own
 * courier's included, as `<label>=<role>/<model>/<effort>`. The workflow builds each flag from
 * the same table, and its digest over the same object.
 */
export const ARGS = {
  preflight: {
    root: 'one', retry: 'many', confirmed_duplicate: 'bool', confirmed_gaps: 'bool', plan_only: 'bool',
    dial: 'one', pace: 'one', base_ref: 'one', commands_file: 'one', dispatch: 'many',
  },
  schedule: { running: 'many', planning: 'many', stopping: 'bool', fault: 'many', dispatch: 'many' },
  'leaf-open': { node: 'one', role: 'one', round: 'int', tier: 'one', wait_ms: 'int', dispatch: 'many' },
  'leaf-close': {
    node: 'one', role: 'one', round: 'int', mode: 'one', status: 'one', said: 'one', head_before: 'one',
    base_sha: 'one', dispatch: 'many',
  },
  'leaf-review': { node: 'one', round: 'int', review_round: 'int', review_file: 'one', dispatch: 'many' },
  'merge-batch': { target: 'one', card: 'one', dispatch: 'many' },
  'suite-gate': { target: 'one', dispatch: 'many' },
  'folder-review': { target: 'one', card: 'one', review_file: 'one', dispatch: 'many' },
  'rule-close': { kind: 'one', record: 'one', rulings_file: 'one', running: 'many', dispatch: 'many' },
  postflight: { fault: 'many', dispatch: 'many' },
  'spec-check': { node: 'one', status: 'one', said: 'one', dispatch: 'many' },
  'spec-reviewed': {
    node: 'one', hash: 'one', findings_file: 'one', previous_file: 'one', previous_hash: 'one', complete: 'bool',
    remaining: 'many', dispatch: 'many',
  },
  'spec-settle': {
    node: 'one', hash: 'one', findings_file: 'one', return_file: 'one', status: 'one', said: 'one', finding: 'many',
    refused: 'many', dispatch: 'many',
  },
  'spec-gate': { node: 'one', edited: 'bool', dispatch: 'many' },
  'spec-prepare': { node: 'one', review: 'one', leaf_rev: 'one', dispatch: 'many' },
}

const list = (v) => (Array.isArray(v) ? v : [])

// ------------------------------------------------------------------ context

function contextOf(repo, effort, execution) {
  if (!safeSlug(effort)) throw new Error('not an effort name: ' + JSON.stringify(effort))
  if (!STAMP.test(execution || '')) throw new Error('not an execution stamp: ' + JSON.stringify(execution))
  const dir = executionDir(repo, effort, execution)
  return { repo: posix(repo), effort, execution, dir, envelopePath: join(dir, 'execution.json') }
}

const readEnvelope = (ctx) => readJson(ctx.envelopePath)

const fail = (boundary, kind, extra = {}) => ({ boundary, ok: false, error: { kind }, stops: [], ...extra })

const stateOf = (ctx) => readLog(ctx.repo, ctx.effort, 'state:' + ctx.execution).entries
const journalOf = (ctx) => readLog(ctx.repo, ctx.effort, 'journal:' + ctx.execution).entries
const measuredOf = (ctx, id) => journalOf(ctx).filter((e) => e.kind === 'verify-observed' && e.node === id)

/**
 * The role a round of a leaf is for: the workflow's word, except on an audit, whose journal
 * decides — a test-author from the first measurement whose tests let an applied mutation through.
 */
function roundRole(ctx, leaf, given) {
  if (leaf.role === 'audit') return auditGap(measuredOf(ctx, leaf.id)) ? 'test-author' : 'auditor'
  return typeof given === 'string' ? given : executorRole(leaf)
}

/** The role leaf-open dispatched a round of a leaf to in this execution, or ''. */
const dispatchedRole = (events, ctx, id, round) =>
  (latest(events, (e) => e.kind === 'dispatched' && e.node === id && e.round === round && e.execution === ctx.execution) || {}).role || ''

/**
 * Pure. The remedy the producer of a reviewed round could apply, on a leaf whose rounds go to both
 * an implementer and a test-author (a green); '' on any other leaf, whose one producer owns every
 * finding.
 */
export const reviewedProducer = (leaf, role) => (leaf.role !== 'green' ? '' : role === 'test-author' ? 'tests' : 'code')

// ------------------------------------------------------------------ records

const seqOf = (e) => (e && Number.isInteger(e.seq) ? e.seq : -1)
const latest = (entries, pred) => entries.reduce((found, e) => (pred(e) && (!found || e.seq > found.seq) ? e : found), null)

/** A stop on the node: an escalation with a reason, a park with the return it waits on. `said` is the file its author wrote. */
export const escalated = (node, reason, detail = '', said = '') =>
  ({ file: 'events', entry: { kind: 'escalated', node, reason, detail: String(detail || '').slice(0, 2000), ...(said ? { said } : {}) } })
export const parked = (node, why, question = '', said = '') =>
  ({ file: 'events', entry: { kind: 'parked', node, return: why, question: String(question || '').slice(0, 2000), ...(said ? { said } : {}) } })
export const approved = (node, head_sha, review_rounds, at_integration) =>
  ({ file: 'events', entry: { kind: 'approved', node, head_sha, review_rounds, at_integration } })

/**
 * Pure. Whether an affected ruling on `node` is answered on disk: a revision of the node newer
 * than the ruling, or a stop or a replan on it after it.
 */
function rulingAnswered(ruling, { nodes, events }) {
  if (!ruling) return true
  if (((nodes.get(ruling.node) || {}).seq || 0) > ruling.seq) return true
  return events.some((e) => e.node === ruling.node && ['escalated', 'parked', 'replanned'].includes(e.kind) && e.seq > ruling.seq)
}

/**
 * Pure. A plugin fault on `node`: a `fault` state line, never a question. A node whose drift a
 * ruler ruled affected and nobody has answered yet is parked as well, with the ruling: drift is
 * found only on the batch that landed it, so a fault alone would let the next invocation run the
 * node on a contract that moved.
 */
export function faultRecords(node, channel, detail, { nodes, events, state }) {
  const out = [{ file: 'state', entry: { kind: 'fault', node, channel, detail: String(detail || '').slice(0, 500) } }]
  const ruling = latest(state, (e) => e.kind === 'drift-ruled' && e.node === node)
  if (ruling && ruling.ruling === 'affected' && !rulingAnswered(ruling, { nodes, events })) {
    out.push(parked(node, 'contract_drift', '', ruling.said || ''))
  }
  return out
}

/** The dispatch lines a call's `dispatch` tokens stand for: `<label>=<role>/<model>/<effort>`. */
function dispatchRecords(nodes, tokens) {
  const out = []
  for (const token of list(tokens)) {
    const at = String(token).lastIndexOf('=')
    if (at <= 0) continue
    const label = token.slice(0, at)
    const [role = '', model = '', effort = ''] = token.slice(at + 1).split('/')
    const named = label.replace(/([#@]\d+)+$/, '').split(':').pop()
    out.push({ file: 'state', entry: { kind: 'dispatch', label, node: nodes.has(named) ? named : '', role, model, effort } })
  }
  return out
}

/**
 * Pure. Which of `records` ({file, entry}) are not yet the word on disk. A boundary run again
 * after a lost courier finds its own records standing and lands nothing twice; the same decision
 * taken anew — after a retry cleared a stop, at another head, in a later invocation — lands again.
 *
 * @param {{file: string, entry: object}[]} records
 * @param {{nodes: Map, status: Map, events: object[], state: object[], journal: object[]}} disk
 */
export function freshRecords(records, { nodes, status, events = [], state = [], journal = [] }) {
  const since = Math.max(-1, ...state.filter((e) => e.kind === 'invocation').map(seqOf))
  const stands = (e) => {
    const now = status.get(e.node) || {}
    const last = now.last || {}
    switch (e.kind) {
      case 'escalated': return now.status === 'escalated' && last.kind === 'escalated' && last.reason === e.reason
      case 'parked': return now.status === 'parked' && last.kind === 'parked' && last.return === e.return
      // A node stopped while its chain ran is the user's first: its approval is re-derived later.
      case 'approved': return ['escalated', 'parked', 'merged'].includes(now.status) || (now.status === 'approved' && last.head_sha === e.head_sha)
      case 'claims': {
        const c = latest(events, (x) => x.kind === 'claims' && x.node === e.node)
        if (!c || c.head_sha !== e.head_sha || c.review !== e.review) return false
        const cleared = Math.max(seqOf(latest(events, (x) => x.kind === 'replanned' && x.node === e.node)), (nodes.get(e.node) || {}).seq || 0)
        return c.seq > cleared
      }
      case 'fault': return state.some((x) => x.kind === 'fault' && x.node === e.node && x.channel === e.channel && seqOf(x) > since)
      case 'drift-ruled': return state.some((x) => x.kind === e.kind && x.node === e.node && x.contract === e.contract && x.head_sha === e.head_sha)
      case 'stale-ruled': return state.some((x) => x.kind === e.kind && x.node === e.node && x.base_now === e.base_now)
      case 'dispatch': return state.some((x) => x.kind === e.kind && x.label === e.label)
      case 'series-done': return journal.some((x) => x.kind === e.kind && x.node === e.node && x.head_sha === e.head_sha)
      case 'authored': return journal.some((x) => x.kind === e.kind && x.node === e.node && x.sha === e.sha)
      default: return false
    }
  }
  const seen = new Set()
  return list(records).filter((r) => {
    const key = r.file + canonical(r.entry)
    if (seen.has(key)) return false
    seen.add(key)
    return !stands(r.entry)
  })
}

/** Append whichever of `records` are not on disk yet; a fault also gives its node's slot back. */
function commit(ctx, records) {
  if (list(records).length === 0) return
  const tree = readTree(ctx.repo, ctx.effort)
  const fresh = freshRecords(records, {
    nodes: tree.nodes, status: tree.status, events: tree.events, state: stateOf(ctx), journal: journalOf(ctx),
  })
  for (const file of ['events', 'state', 'journal']) {
    const entries = fresh.filter((r) => r.file === file).map((r) => (file === 'events' ? { execution: ctx.execution, ...r.entry } : r.entry))
    if (entries.length === 0) continue
    const r = append(ctx.repo, ctx.effort, file === 'events' ? 'events' : file + ':' + ctx.execution, entries)
    if (!r.ok) throw new Error(file + ' refused: ' + r.error)
  }
  for (const r of records) {
    if (r.entry.kind === 'fault') releaseSlots(ctx.repo, { effort: ctx.effort, execution: ctx.execution, node: r.entry.node })
  }
}

/** Pure. The stops and holds a call decided, as the workflow reads them: handles only. */
export const stopsOf = (records) => list(records).flatMap(({ entry: e }) =>
  e.kind === 'escalated' ? [{ id: e.node, status: 'escalated', reason: e.reason, said: e.said || '' }]
    : e.kind === 'parked' ? [{ id: e.node, status: 'parked', reason: e.return, said: e.said || '' }]
      : e.kind === 'fault' ? [{ id: e.node, status: 'held', reason: e.channel, said: '' }]
        : [])

/** Record the faults the workflow names (`<node>:<channel>`), each once per invocation. */
function faultsNamed(ctx, tree, named) {
  const state = stateOf(ctx)
  return list(named).flatMap((token) => {
    const at = String(token).lastIndexOf(':')
    const node = at > 0 ? token.slice(0, at) : ''
    if (!tree.nodes.has(node)) return []
    return faultRecords(node, token.slice(at + 1), '', { nodes: tree.nodes, events: tree.events, state })
  })
}

/** The nodes this invocation holds on a plugin fault: nothing launches them again until the next one. */
function heldOf(state) {
  const since = Math.max(-1, ...state.filter((e) => e.kind === 'invocation').map(seqOf))
  return [...new Set(state.filter((e) => e.kind === 'fault' && seqOf(e) > since).map((e) => e.node))]
}

// ------------------------------------------------------------------ rows and cards

function integrationOf(ctx, tree, node) {
  // A group has no branch: its work integrates in its folder's.
  const id = (tree.nodes.get(node) || {}).kind === 'group' ? ownerOf(tree.nodes, node) : node
  const branch = branchOf(ctx.effort, id)
  if (!branchExists(ctx.repo, branch)) return null
  const head = revParse(ctx.repo, 'refs/heads/' + branch)
  let base = ''
  if (id === ROOT_ID) base = effortBase(ctx.repo, ctx.effort).base_sha
  else {
    const mb = git(ctx.repo, ['merge-base', branch, branchOf(ctx.effort, ownerOf(tree.nodes, id))])
    base = mb.ok ? mb.stdout.trim() : ''
  }
  return { branch, worktree: worktreeOf(ctx.repo, ctx.effort, id), head, base }
}

const isGroupIn = (tree) => (id) => (tree.nodes.get(id) || {}).kind === 'group'
const isMergedLeaf = (tree, id) => (tree.nodes.get(id) || {}).kind === 'leaf' && (tree.status.get(id) || {}).status === 'merged'

/** A node as the workflow branches on it and tiers its dispatches: handles only. */
function rowOf(ctx, tree, id) {
  const n = tree.nodes.get(id)
  return {
    kind: n.kind, author: n.author, rigor: n.rigor, role: n.role, provides_n: n.provides.length, dispatch: n.dispatch,
    ground_known: n.ground_known, rev: n.seq || 0, spec_path: posix(specPath(ctx.repo, ctx.effort, id)),
    children_n: childrenOf(tree.nodes, id).length, own_review: n.kind === 'leaf' && ownReview(n),
  }
}

/** What a leaf waits on: its dependencies and every ancestor's, which the workflow re-checks a launch against. */
const waitsOn = (tree, id) => [...new Set([id, ...ancestorsOf(id)].flatMap((a) => (tree.nodes.get(a) || { deps: [] }).deps))]

/**
 * Whether work already stands on the node as planned: a leaf approved and waiting for its merge,
 * or a folder with children dispatched or merged. Replanning it would pull the plan from under
 * that work.
 */
const underWay = (tree, id) =>
  (tree.status.get(id) || {}).status === (tree.nodes.get(id).kind === 'leaf' ? 'approved' : 'active')

/** Why the planner is sent to a folder, in the words its card gives it. */
const WHY = {
  spec_changed: 'its spec changed while work under it was dispatched — re-derive what is below it, keeping every dispatched or merged task that still stands',
}

/**
 * Write a launch card: everything an agent's prompt, or a later boundary, needs about one unit
 * and that is not a handle — titles, intents, the children a merge takes. Named by its content,
 * so a schedule run again writes the same file.
 */
function writeCard(ctx, card) {
  const path = cardPath(ctx.repo, ctx.effort, ctx.execution, card.unit, card.id, fnv1a(canonical(card)))
  if (!existsSync(path)) {
    mkdirState(dirname(path))
    writeFileSync(path, JSON.stringify(card, null, 1) + '\n')
  }
  return path
}

/** A node's card: its plan entry as an agent reads it, plus `extra`. */
function cardOf(ctx, tree, id, unit, extra = {}) {
  const n = tree.nodes.get(id)
  return writeCard(ctx, {
    unit, id, title: n.title, kind: n.kind, author: n.author, rigor: n.rigor, role: n.role,
    spec_path: posix(specPath(ctx.repo, ctx.effort, id)), decisions: n.decisions, intent: n.intent || '', ...extra,
  })
}

/** A leaf's card: its parent folder rides along, which a verify leaf's finding replans. */
function leafCardOf(ctx, tree, id) {
  const owner = ownerOf(tree.nodes, id)
  const p = tree.nodes.get(owner)
  return cardOf(ctx, tree, id, 'leaf', {
    parent: { id: owner, title: p.title, kind: p.kind, author: p.author, spec_path: posix(specPath(ctx.repo, ctx.effort, owner)) },
  })
}

/** A node the planner (re)writes: its card, its row, and the file that says why, when one does. */
function replanOf(ctx, tree, id, why, said = '') {
  return { id, card: cardOf(ctx, tree, id, 'plan', { why: WHY[why] || why }), row: rowOf(ctx, tree, id), said }
}

/**
 * What a ruler rules on, one block per node: the node as its executor will be briefed, and the
 * change that may have moved its premise. The ruler has no search tools, so this file is all of
 * its evidence.
 * @param {{node: string, note: string, diff: string}[]} items
 */
function rulingBrief(tree, items) {
  const bullets = (xs) => (xs.length ? xs.map((x) => '- ' + x).join('\n') : '(none)')
  return items.map(({ node: id, note, diff }) => {
    const n = tree.nodes.get(id)
    return [
      '# ' + id + ' — ' + n.title, '', note, '',
      '## Plan entry', '',
      'Intent: ' + ((n.intent || '').trim() || '(none)'), '',
      'Context: ' + ((n.context || '').trim() || '(none)'), '',
      'Acceptance criteria:', bullets((n.acceptance || []).map((a) => a.text + (a.check ? ' — check: `' + a.check + '`' : ''))), '',
      'Writes:', bullets(n.locus || []), '',
      'Reads:', bullets(n.reads || []), '',
      'Consumes:', bullets((n.consumes || []).map((c) => c.name + ': ' + c.paths.join(', '))), '',
      '## Change', '',
      '~~~~diff', diff.trimEnd(), '~~~~', '',
    ].join('\n')
  }).join('\n')
}

/**
 * The markdown a record points at for a file an agent wrote as JSON, beside it and named by its
 * name and `suffix`, bounded: `lead` first, the file's text after.
 */
function saidBeside(file, suffix, lead, body) {
  const stem = String(file).replace(/\.json$/, '')
  const path = join(dirname(stem), nameKey(basename(stem) + suffix) + '.md')
  writeFileSync(path, lead.trim() + '\n\n' + body.trim() + '\n')
  return posix(path)
}

// ------------------------------------------------------------------ preflight

/** Executions of this effort that never closed, other than this one. */
function openExecutions(ctx) {
  const dir = executionsRoot(ctx.repo, ctx.effort)
  if (!existsSync(dir)) return []
  const out = []
  for (const stamp of readdirSafe(dir)) {
    if (stamp === ctx.execution || !STAMP.test(stamp)) continue
    const env = readJson(join(dir, stamp, 'execution.json'))
    if (!env) continue
    const closed = readLog(ctx.repo, ctx.effort, 'state:' + stamp).entries.some((e) => e.kind === 'closed')
    if (!closed) out.push({ stamp, root: env.root || ROOT_ID })
  }
  return out
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Clear the named nodes' stops: a `replanned` event, reason `retry_escalated`, newer than each
 * stop. A running execution's next schedule sees the node ready again and relaunches it.
 */
function retryEscalated(ctx, tree, ids) {
  const retry = list(ids).filter((id) => tree.nodes.has(id))
  if (retry.length === 0) return { retried: [], error: null }
  const r = append(ctx.repo, ctx.effort, 'events', retry.map((id) => ({ kind: 'replanned', node: id, execution: ctx.execution, reason: 'retry_escalated', by: 'session' })))
  return { retried: r.ok ? retry : [], error: r.ok ? null : r.error }
}

/**
 * Record what the session learned about a node: a `noted` event. It is an observation, so its
 * actor records it; it is not a status, and no status is derived from it.
 */
function noteNode(ctx, tree, id, text) {
  if (!tree.nodes.has(id)) return { noted: '', error: 'no live node ' + JSON.stringify(id) }
  const said = String(text || '').trim()
  if (!said) return { noted: '', error: '--text must say what was learned' }
  const r = append(ctx.repo, ctx.effort, 'events', [{ kind: 'noted', node: id, execution: ctx.execution, by: 'session', text: said }])
  return { noted: r.ok ? id : '', error: r.ok ? null : r.error }
}

/**
 * Record what the execution's agents have spent so far. It runs where an invocation starts and
 * where it ends, so a run that died is picked up by the next; a failure costs only the report.
 */
function collectSpend(ctx) {
  try {
    collectUsage(ctx.repo, ctx.effort, ctx.execution)
  } catch {
    // The cost report counts what it could not read as unreported.
  }
}

export function preflight(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  if (tree.error) return fail('preflight', 'unreadable')
  const root = typeof args.root === 'string' && args.root ? args.root : ROOT_ID
  if (!tree.nodes.has(root)) return fail('preflight', 'no_such_node')
  if (root === ROOT_ID && tree.nodes.get(root).kind === 'leaf') return fail('preflight', 'root_is_leaf')

  let env = readEnvelope(ctx)
  const resumed = Boolean(env)
  if (!env) {
    const ref = args.base_ref || ''
    const base_branch = ref || git(ctx.repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
    const base_sha = revParse(ctx.repo, ref || 'HEAD')
    if (!base_sha) return fail('preflight', 'no_base')
    const commands = args.commands_file ? readJson(args.commands_file) : null
    if (args.commands_file && !commands) return fail('preflight', 'commands_unreadable')
    env = {
      stamp: ctx.execution, root, base_branch, base_sha, dial: args.dial || 'normal', pace: args.pace || 'balanced', commands,
    }
    mkdirState(ctx.dir)
    writeFileSync(ctx.envelopePath, JSON.stringify(env, null, 1) + '\n')
  } else if (env.root !== root) {
    return fail('preflight', 'wrong_root', { root: env.root })
  }

  // Each invocation is counted: a fault is held, and recorded, once per invocation.
  append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'invocation' })
  const invocation = stateOf(ctx).filter((e) => e.kind === 'invocation').length

  let checkpoint = null
  const stale = []
  let staleOut = null
  const dirty = []
  const overlapping = openExecutions(ctx).filter((e) => isAncestorOrSelf(e.root, root) || isAncestorOrSelf(root, e.root))
  if (overlapping.length && !args.confirmed_duplicate) {
    checkpoint = { reason: 'existing_execution', detail: overlapping.map((e) => e.stamp + ' (root ' + e.root + ')').join(', '), executions: overlapping }
  }

  collectSpend(ctx)
  retryEscalated(ctx, tree, args.retry)

  if (resumed && !checkpoint) {
    const now = revParse(ctx.repo, env.base_branch || 'HEAD')
    if (now && env.base_sha) {
      // What this execution's branch already holds of the base: its root's integration branch, or
      // the nearest one above it that the root will be cut from. A head merged into it is the
      // ground its leaves are cut from, not a move under them.
      const ground = [root, ...ancestorsOf(root)].map((id) => branchOf(ctx.effort, id)).find((b) => branchExists(ctx.repo, b))
      const fork = ground ? git(ctx.repo, ['merge-base', ground, now]).stdout.trim() : ''
      const held = contains(ctx.repo, fork, env.base_sha) ? fork : env.base_sha
      // The head each leaf was last ruled against. An affected ruling counts only once it is
      // answered on disk — the leaf replanned or stopped — so a replan a plugin fault ended is
      // ruled on again. The leaf is asked only about what moved after that head.
      const ruledAt = new Map(stateOf(ctx)
        .filter((e) => e.kind === 'stale-ruled' && (e.ruling === 'unaffected' || rulingAnswered(e, tree)))
        .map((e) => [e.node, e.base_now]))
      const movedSince = new Map()
      for (const id of subtreeOf(tree.nodes, root)) {
        const n = tree.nodes.get(id)
        // A stopped leaf is the user's already; it is looked at again once its stop clears.
        if (n.kind !== 'leaf' || ['merged', 'escalated', 'parked'].includes((tree.status.get(id) || {}).status)) continue
        const last = ruledAt.get(id) || ''
        const anchor = contains(ctx.repo, last, held) && contains(ctx.repo, now, last) ? last : held
        if (anchor === now) continue
        if (!movedSince.has(anchor)) movedSince.set(anchor, new Set(changedFiles(ctx.repo, anchor, now)))
        const moved = movedSince.get(anchor)
        const writes = [...moved].filter((f) => inLocus(n.locus, f))
        const reads = [...moved].filter((f) => inLocus(n.reads, f))
        if (writes.length || reads.length) stale.push({ node: id, anchor, writes, reads })
      }
      if (stale.length) {
        const brief = stalePath(ctx.repo, ctx.effort, ctx.execution, now)
        writeFileSync(brief, rulingBrief(tree, stale.map((st) => ({
          node: st.node,
          note: 'The base branch moved from ' + st.anchor + ' to ' + now + '.' +
            (st.writes.length ? ' Moved files it writes: ' + st.writes.join(', ') + '.' : '') +
            (st.reads.length ? ' Moved files it reads: ' + st.reads.join(', ') + '.' : ''),
          diff: git(ctx.repo, ['diff', st.anchor + '..' + now, '--', ...st.writes, ...st.reads]).stdout,
        }))))
        const record = brief.replace(/\.md$/, '.json')
        writeJson(record, { kind: 'stale', now, nodes: stale.map((st) => st.node) })
        staleOut = { nodes: stale.map((st) => st.node), now, brief, record }
      }
    }
  }

  const { gaps, untraced } = trace(tree.nodes, root)
  if (!checkpoint && gaps.length && !args.confirmed_gaps) {
    checkpoint = { reason: 'blocking_gaps', detail: gaps.length + ' decision(s) no entry realises, or evidence a node needs was not reached', gaps }
  }
  if (!checkpoint && args.plan_only) checkpoint = { reason: 'parked', detail: 'plan_only: the plan is on disk and nothing was dispatched' }

  releaseSlots(ctx.repo, { effort: ctx.effort, execution: ctx.execution })
  // Leftover checkouts of this effort's branches away from their canonical path: git refuses a
  // branch in two worktrees, so a dead invocation's leftover would bring the next one up
  // detached. A merged leaf's own worktree is a leftover too: merge-batch retires it, and this
  // catches one it did not reach. Clean ones are removed; a dirty one is never forced.
  // A bounded key cannot be read back into an id, so a branch's node is looked up in the tree.
  const prefix = 'agentics/' + ctx.effort
  const nodeOf = new Map([...tree.nodes.keys()].map((id) => [branchOf(ctx.effort, id), id]))
  for (const [path, w] of worktrees(ctx.repo)) {
    if (!(w.branch === prefix || w.branch.startsWith(prefix + '--'))) continue
    if (worktreeOfBranch(ctx.repo, w.branch) === path && !isMergedLeaf(tree, nodeOf.get(w.branch))) continue
    // Only this plugin's own leftovers: a checkout the user made elsewhere is theirs.
    if (!path.startsWith(posix(join(ctx.repo, '.claude', 'worktrees')) + '/')) continue
    if (detach(ctx.repo, path) === 'dirty') dirty.push(path)
  }
  git(ctx.repo, ['worktree', 'prune'])

  mkdirState(saidDir(ctx.repo, ctx.effort, ctx.execution))
  const ids = subtreeOf(tree.nodes, root)
  // The lists stay on disk: the session reads them with `lib/status.mjs checkpoint`, also when the
  // user confirmed past them.
  if (checkpoint) append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'checkpoint', ...checkpoint })
  if (!checkpoint && gaps.length && args.confirmed_gaps) {
    append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'checkpoint-confirmed', gaps })
  }

  return {
    boundary: 'preflight', ok: true, error: null, invocation,
    checkpoint: checkpoint ? { reason: checkpoint.reason } : null,
    stale: checkpoint ? null : staleOut,
    said_dir: saidDir(ctx.repo, ctx.effort, ctx.execution),
    counts: { nodes: ids.length, leaves: ids.filter((id) => tree.nodes.get(id).kind === 'leaf').length, gaps: gaps.length, untraced: untraced.length },
    dirty_worktrees: dirty,
    max_parallel: maxParallel(ctx.repo),
    stops: [],
  }
}

// ------------------------------------------------------------------ schedule

/** What `lib/schedule.mjs` reads, bound to this execution's disk. */
function scheduleInput(ctx, tree, env, args) {
  const integrations = new Map()
  const integration = (id) => {
    if (!integrations.has(id)) integrations.set(id, integrationOf(ctx, tree, id))
    return integrations.get(id)
  }
  const holder = holderReader(ctx.repo)
  const state = stateOf(ctx)
  return {
    nodes: tree.nodes, status: tree.status, events: tree.events, root: env.root || ROOT_ID,
    state,
    running: list(args.running),
    planning: list(args.planning),
    held: heldOf(state),
    stopping: args.stopping === true,
    maxParallel: maxParallel(ctx.repo),
    integrationOf: integration,
    lockedBy: (id) => holder({ effort: ctx.effort, node: id, locus: tree.nodes.get(id).locus }),
    approvedHead: (id) => approvedHead(tree.events, id),
  }
}

/** Resume facts for the named leaves only: the ladder reads git per leaf, so never the whole tree. */
function leafFactsOf(ctx, tree, ids) {
  if (ids.length === 0) return new Map()
  const wanted = new Map()
  for (const id of ids) {
    wanted.set(id, tree.nodes.get(id))
    for (const dep of tree.nodes.get(id).deps) if (tree.nodes.has(dep)) wanted.set(dep, tree.nodes.get(dep))
  }
  const ownerHeads = new Map()
  const parentHeads = {}
  for (const id of ids) {
    const owner = ownerOf(tree.nodes, id)
    if (!ownerHeads.has(owner)) ownerHeads.set(owner, revParse(ctx.repo, 'refs/heads/' + branchOf(ctx.effort, owner)))
    parentHeads[id] = ownerHeads.get(owner)
  }
  const out = new Map()
  for (const l of resumeLeaves(ctx.repo, ctx.effort, ctx.execution, wanted, parentHeads)) {
    if (!ids.includes(l.id)) continue
    const rounds = roundsOf(tree.events, l.id)
    const role = roundRole(ctx, tree.nodes.get(l.id))
    const brief = rounds ? briefPath(ctx.repo, ctx.effort, ctx.execution, l.id, role || 'none', rounds) : ''
    out.set(l.id, {
      next_action: l.next_action, branch: l.branch, worktree: l.worktree, head_sha: l.head_sha, base_sha: l.base_sha,
      rounds, brief_path: brief && existsSync(brief) ? brief : '',
    })
  }
  return out
}

/**
 * Pure. What a tick records about what it launches, beyond the launches themselves: a folder the
 * user writes that has nothing planned beneath it is theirs to design, never the planner's; and a
 * leaf the resume ladder finds measured green with no review loop of its own, and no approval
 * standing, is approved at the head that measured green.
 */
export function launchRecords(launch, { nodes, events }, facts, specOf) {
  const out = []
  for (const l of launch) {
    const n = nodes.get(l.id)
    if (l.unit === 'plan' && n.kind !== 'leaf' && n.author !== 'planner' && l.why !== 'spec_changed') {
      out.push(parked(l.id, 'needs_design', n.kind === 'design'
        ? 'sub-effort ' + l.id + ' has no approved spec: run the design skill on it'
        : 'folder ' + l.id + ' plans nothing: its spec ' + specOf(l.id) + ' needs a Plan'))
    }
    const f = l.unit === 'leaf' ? facts.get(l.id) : null
    if (f && f.next_action === 'merge' && !ownReview(n) && !approvedHead(events, l.id)) out.push(approved(l.id, f.head_sha, 0, true))
  }
  return out
}

/**
 * The execution's scheduler: record the faults the workflow names, then say what to launch, each
 * unit with its card and the handles it branches on. The workflow calls it whenever a unit
 * settles, one call at a time.
 */
function scheduleBoundary(ctx, args) {
  const env = readEnvelope(ctx)
  if (!env) return fail('schedule', 'no_execution')
  let tree = readTree(ctx.repo, ctx.effort)
  if (tree.error) return fail('schedule', 'unreadable')
  const faults = faultsNamed(ctx, tree, args.fault)
  commit(ctx, faults)
  tree = readTree(ctx.repo, ctx.effort)
  const { launch, idle } = schedule(scheduleInput(ctx, tree, env, args))
  const facts = leafFactsOf(ctx, tree, launch.filter((l) => l.unit === 'leaf').map((l) => l.id))
  const records = launchRecords(launch, tree, facts, (id) => posix(specPath(ctx.repo, ctx.effort, id)))
  commit(ctx, records)
  const designed = new Set(records.filter((r) => r.entry.kind === 'parked').map((r) => r.entry.node))
  const out = launch.filter((l) => !designed.has(l.id)).map((l) => {
    if (l.unit === 'merge') {
      return { unit: 'merge', target: l.target, card: writeCard(ctx, { unit: 'merge', id: l.target, children: l.children, cycles: l.cycles }) }
    }
    if (l.unit === 'plan') return { unit: 'plan', id: l.id, why: l.why, card: cardOf(ctx, tree, l.id, 'plan', { why: WHY[l.why] || '' }), row: rowOf(ctx, tree, l.id) }
    if (l.unit === 'review') {
      return { unit: 'review', id: l.id, card: cardOf(ctx, tree, l.id, 'review', { where: l.where, children: l.children, unreviewed: l.unreviewed }) }
    }
    return { unit: 'leaf', id: l.id, card: leafCardOf(ctx, tree, l.id), row: rowOf(ctx, tree, l.id), facts: facts.get(l.id) || null, waits_on: waitsOn(tree, l.id) }
  })
  return {
    boundary: 'schedule', ok: true, error: null, launch: out, idle, max_parallel: maxParallel(ctx.repo),
    stops: stopsOf([...faults, ...records]),
  }
}
const roundsOf = (events, id) => events.filter((e) => e.kind === 'dispatched' && e.node === id).reduce((m, e) => Math.max(m, Number.isInteger(e.round) ? e.round : 0), 0)

// ------------------------------------------------------------------ leaf-open

const BRANCH_WAIT_MS = 60 * 1000

function leafOpen(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  const id = args.node
  const leaf = tree.nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf') return fail('leaf-open', 'not_a_leaf')
  const env = readEnvelope(ctx)
  if (!env) return fail('leaf-open', 'no_execution')
  const role = roundRole(ctx, leaf, args.role)
  const round = Number.isInteger(args.round) && args.round > 0 ? args.round : 1
  const refused = (message) => {
    const records = [escalated(id, 'open_refused', message)]
    commit(ctx, records)
    return { boundary: 'leaf-open', ok: true, error: null, status: 'refused', stops: stopsOf(records) }
  }

  const got = acquire(ctx.repo, {
    effort: ctx.effort, execution: ctx.execution, node: id,
    locus: leaf.locus, waitMs: Number.isInteger(args.wait_ms) && args.wait_ms > 0 ? args.wait_ms : undefined,
  })
  if (!got.ok) {
    if (got.reason === 'invalid') return refused(got.error)
    const heldBy = list(got.held_by).map((h) => ({ node: h.node || '', status: h.status || '' }))
    return { boundary: 'leaf-open', ok: true, error: null, status: got.reason, held_by: heldBy, max_parallel: maxParallel(ctx.repo), stops: [] }
  }

  const parent = ownerOf(tree.nodes, id)
  const lock = (branch, fn) => withBranchLock(ctx.repo, ctx.effort, branch, fn, { waitMs: BRANCH_WAIT_MS })
  let integ
  let made
  try {
    integ = ensureIntegration(ctx.repo, ctx.effort, parent, env, { lock, isGroup: isGroupIn(tree) })
    if (!integ.ok) return refused(integ.error)
    // The cut happens under the parent's lock, reading its head there: a merge-batch bisecting
    // into the parent moves that head through unverified states, and none of them is a base.
    made = lock(integ.branch, () => {
      // Where a new branch is cut: the cycle predecessor's head for green and audit (green is
      // coded on red's tests; red is held, never merged alone), then brought up to the parent's
      // head so every other dependency's output is there too; the parent's head otherwise.
      let from = revParse(ctx.repo, 'refs/heads/' + integ.branch)
      const cycle = cycleOf(tree.nodes, id)
      const at = cycle.indexOf(id)
      if (at > 0) {
        const pred = revParse(ctx.repo, 'refs/heads/' + branchOf(ctx.effort, cycle[at - 1]))
        if (!pred) return { ok: false, error: cycle[at - 1] + ' has no branch to cut ' + id + ' from' }
        from = pred
      }
      return ensureLeaf(ctx.repo, ctx.effort, id, { from, parentBranch: integ.branch, cycleMember: at > 0 })
    })
  } catch {
    // The parent is being merged into; this is a wait, not a failure — the workflow re-dispatches.
    return { boundary: 'leaf-open', ok: true, error: null, status: 'busy', held_by: [], max_parallel: maxParallel(ctx.repo), stops: [] }
  }
  if (!made.ok) return refused(made.error)

  const fix = readJson(fixesPath(ctx.repo, ctx.effort, ctx.execution, id, round))
  const brief = assembleBrief(ctx.repo, ctx.effort, ctx.execution, id, {
    role: role || 'none', round, fix: Array.isArray(fix) ? fix : [],
  })
  // Only the dispatch the leaf's status already stands on is this one sent again (a lost courier).
  // After a replan, an approval or a round it is a new dispatch, whatever the log holds.
  const now = tree.status.get(id) || {}
  const standing = now.status === 'active' && now.last.execution === ctx.execution && now.last.role === role && now.last.round === round
  if (!standing) {
    const [model = '', effort = ''] = String(args.tier || '').split('/')
    const r = append(ctx.repo, ctx.effort, 'events', [{ execution: ctx.execution, kind: 'dispatched', node: id, role, round, model, effort }])
    if (!r.ok) throw new Error('events refused: ' + r.error)
  }

  const report = reportPath(ctx.repo, ctx.effort, ctx.execution, id, role || 'none', round)
  mkdirState(dirname(report))
  return {
    boundary: 'leaf-open', ok: true, error: null, status: 'opened', role,
    branch: made.branch, worktree: made.worktree, base_sha: made.base, head_sha: made.head,
    brief_path: brief.path, brief_digest: brief.digest, report_path: report,
    slot: got.slot, max_parallel: maxParallel(ctx.repo), stops: [],
  }
}

// ------------------------------------------------------------------ leaf-close

const REPLAN = ['decompose', 'unsplittable', 'premise_mismatch']
const PARK = ['needs_decision', 'contract_changed']
const BLOCK = ['blocked', 'needs_context']

/**
 * Pure. What an executor's own return decides before anything is measured, or null when its work
 * is to be measured. `head` is the worktree's head now, `head_before` the one the round opened on:
 * a fix round that moved nothing returned no commits.
 */
export function executorOutcome({ node, role, status, said, mode, round, head_before, head }) {
  if (!role) return null
  if (!status) return { next: 'held' }
  if (REPLAN.includes(status)) return { next: 'replan', records: [] }
  if (PARK.includes(status)) return { next: 'stopped', records: [parked(node, status, '', said)] }
  if (BLOCK.includes(status)) return { next: 'stopped', records: [escalated(node, status, '', said)] }
  if (mode === 'fix' && role === 'implementer' && head_before && head === head_before) {
    return { next: 'stopped', records: [escalated(node, 'fix_without_commits', 'fix round ' + round + ' returned no commits')] }
  }
  return null
}

/**
 * Pure. What a close records for its decision. `previous` is the close of the round before, read
 * back from its record: a fix that repeats it at a moved head does not converge, and a second fix
 * in a row raises the producer's tier. A verify leaf's finding is its folder's: a folder the user
 * writes is parked for a re-spec, one the planner writes is replanned. Commands still unknown
 * once an investigator ran (`established`) are no investigator's to find: the leaf escalates.
 */
export function closeOutcome({ node, leaf, parent, head, decision, previous, record, established = false }) {
  const claims = list(decision.failures).map((f) => f.claim).join('; ')
  if (decision.next === 'approve') return { next: 'approve', records: [approved(node, head, 0, !ownReview(leaf))] }
  if (decision.next === 'command_unknown' && established) {
    return { next: 'escalate', records: [escalated(node, 'command_unknown', 'no build or test command could be established for this repository')] }
  }
  if (decision.next === 'fix') {
    if (fixNotConverging(previous, decision, head)) {
      return { next: 'escalate', records: [escalated(node, 'verify_not_converging', 'two consecutive measurements failed identically: ' + failureKey(decision.failures))] }
    }
    return { next: 'fix', raise: Boolean(previous && previous.decision && previous.decision.next === 'fix'), records: [] }
  }
  if (decision.next === 'finding') {
    const records = [escalated(node, 'verify_finding', claims + ' (its measurement: ' + record + ')')]
    const theirs = parent && parent.kind !== 'leaf' && parent.author !== 'planner'
    if (theirs) {
      records.push(parked(parent.id, 'needs_respec', 'verify leaf ' + node + ' found: ' + claims + ' — edit ' + parent.spec_path + ', re-approve it and recompile'))
    }
    return { next: 'finding', replan_parent: Boolean(parent) && !theirs, records }
  }
  if (decision.next === 'escalate') return { next: 'escalate', records: [escalated(node, decision.reason || 'escalated', claims)] }
  return { next: decision.next, records: [] }
}

/** The commands verification runs, from `command` gotchas an investigator wrote, else the envelope. */
function commandsFor(ctx) {
  const env = readEnvelope(ctx) || {}
  const given = env.commands || {}
  const found = commandsOf(ctx.repo, ctx.effort)
  const pick = (name) => found[name] || given[name] || ''
  const absent = (name) => Boolean((found.absent && found.absent[name]) || (given.absent && given.absent[name]))
  return {
    build: pick('build'), typecheck: pick('typecheck'), suite: pick('suite'), suiteFast: pick('suite_fast'), testOne: pick('test_one'),
    buildAbsent: absent('build'), typecheckAbsent: absent('typecheck'), suiteAbsent: absent('suite'), suiteFastAbsent: absent('suite_fast'),
  }
}

/** Whether the repository splits its tests: then a merge-batch runs the fast suite, and the gate the full one. */
const splitSuite = (cmd) => Boolean(cmd.suiteFast) && !cmd.suiteFastAbsent

/**
 * Commit what a shell-less author wrote inside its locus; anything outside it is left out of the
 * commit, reverted, and reported — the series check would call it a breach, and a file nobody
 * committed must not silently ride into the next measurement.
 */
function commitAuthor(ctx, admits, worktree, subject) {
  // `git -C` on a path that is not a registered worktree resolves to the enclosing repository —
  // the user's. Nothing here commits anywhere but the leaf's own linked worktree.
  const broken = worktreeProblem(worktree)
  if (broken) return { committed: false, outside: [], sha: '', error: broken.message }
  const st = git(worktree, ['status', '--porcelain', '--untracked-files=all'])
  const changed = st.stdout.split('\n').filter(Boolean).map((l) => posix(l.slice(3).trim().replace(/^"|"$/g, '')))
  const held = changed.filter(admits)
  const outside = changed.filter((p) => !admits(p))
  for (const p of outside) {
    if (git(worktree, ['ls-files', '--error-unmatch', p]).ok) git(worktree, ['checkout', '--', p])
    else rmSync(join(worktree, p), { force: true })
  }
  if (held.length === 0) return { committed: false, outside, sha: '' }
  const added = git(worktree, ['add', '--', ...held])
  if (!added.ok) return { committed: false, outside, sha: '', error: 'git add failed: ' + added.stderr.trim() }
  const c = git(worktree, ['commit', '-m', subject])
  if (!c.ok) return { committed: false, outside, sha: '', error: c.stderr.trim() }
  return { committed: true, outside, sha: revParse(worktree, 'HEAD') }
}

/**
 * Whether a path is new to a leaf's cycle: absent from its parent's integration head, which holds
 * every file that existed before the cycle and every one another leaf merged since.
 */
function newOnParent(ctx, nodes, id) {
  const parentHead = revParse(ctx.repo, 'refs/heads/' + branchOf(ctx.effort, ownerOf(nodes, id)))
  return (path) => Boolean(parentHead) && !git(ctx.repo, ['cat-file', '-e', parentHead + ':' + path]).ok
}

/**
 * The locus each test-author commit of a green or an audit is held to, by sha: the cycle's tests
 * and the new test files of that commit the scope admits. The leaf's own locus fences the rest.
 */
function testAuthorFences(ctx, worktree, base, id, admits, scope) {
  if (!base) return {}
  const authored = new Set(journalsOf(ctx.repo, ctx.effort, ctx.execution)
    .filter((e) => e.kind === 'authored' && e.node === id && e.role === 'test-author').map((e) => e.sha))
  const range = git(worktree, ['rev-list', base + '..HEAD'])
  const fences = {}
  for (const sha of range.ok ? range.stdout.split('\n').filter(Boolean) : []) {
    if (!authored.has(sha)) continue
    const files = git(worktree, ['show', '--name-only', '--format=', sha]).stdout.split('\n').map((f) => f.trim()).filter(Boolean)
    fences[sha] = [...new Set([...scope.tests, ...files.filter(admits)])]
  }
  return fences
}

/** The series an executor finished, from git: every commit of its own over `base`, oldest first. */
function seriesOf(worktree, base) {
  if (!base) return []
  const r = git(worktree, ['log', '--reverse', '--no-merges', '--format=%H%x09%s', base + '..HEAD'])
  return r.ok ? r.stdout.split('\n').filter(Boolean).map((l) => ({ sha: l.slice(0, l.indexOf('\t')), subject: l.slice(l.indexOf('\t') + 1) })) : []
}

/**
 * What a close decides from the executor's return alone, before any measurement — a stop, a
 * replan, a dispatch that returned nothing — or null when the work goes to be measured.
 */
function leafCloseFront(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  const id = args.node
  const leaf = tree.nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf') return fail('leaf-close', 'not_a_leaf')
  const round = Number.isInteger(args.round) && args.round > 0 ? args.round : 1
  const head = revParse(worktreeOf(ctx.repo, ctx.effort, id), 'HEAD')
  const out = executorOutcome({ node: id, role: args.role || '', status: args.status || '', said: args.said || '', mode: args.mode || '', round, head_before: args.head_before || '', head })
  if (!out) return null
  const records = out.next === 'held'
    ? faultRecords(id, 'dispatch', 'the ' + args.role + ' dispatch returned nothing', { nodes: tree.nodes, events: tree.events, state: stateOf(ctx) })
    : out.records
  commit(ctx, records)
  return {
    boundary: 'leaf-close', ok: true, error: null, status: 'done', node: id, head_sha: head,
    decision: { next: out.next, failures_n: 0 }, raise: false, record: '', replan: null, stops: stopsOf(records),
  }
}

function leafClose(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  const id = args.node
  const leaf = tree.nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf') return fail('leaf-close', 'not_a_leaf')
  const role = roundRole(ctx, leaf, args.role)
  // A green's or an audit's test-author round writes the cycle's tests, and only those.
  const scope = leaf.role === 'green' || leaf.role === 'audit' ? cycleTestLocus(tree.nodes, tree.status, leaf) : null
  const isNew = newOnParent(ctx, tree.nodes, id)
  const admitsTest = (p) => testLocusAdmits(scope, p, isNew)
  const testRound = Boolean(scope) && role === 'test-author'
  const earlier = measuredOf(ctx, id)
  const round = Number.isInteger(args.round) && args.round > 0 ? args.round : 1
  const worktree = worktreeOf(ctx.repo, ctx.effort, id)
  const branch = branchOf(ctx.effort, id)
  const notes = []

  const reportFile = reportPath(ctx.repo, ctx.effort, ctx.execution, id, role || 'none', round)
  const blocks = extractReportBlocks(readText(reportFile))
  if (blocks.problems.length) notes.push(...blocks.problems.map((p) => 'report: ' + p))

  let committed = false
  const breaches = []
  if (role === 'test-author' || role === 'auditor') {
    const c = commitAuthor(ctx, testRound ? admitsTest : (p) => inLocus(leaf.locus, p), worktree, blocks.commit || 'test(' + id + '): ' + leaf.title)
    committed = c.committed
    if (c.error) notes.push('commit refused: ' + c.error)
    if (c.committed) commit(ctx, [{ file: 'journal', entry: { kind: 'authored', node: id, role, round, sha: c.sha } }])
    const fence = testRound ? 'the cycle\'s tests' : 'the locus'
    for (const p of c.outside) breaches.push({ sha: '', check: 'locus-breach', message: role + ' wrote ' + p + ', outside ' + fence + '; not committed and reverted', blocking: role === 'test-author' })
  }
  // The executor said it was done: its series, as git holds it, is journalled as finished.
  if (role && ['done', 'done_with_concerns'].includes(args.status)) {
    const commits = seriesOf(worktree, args.base_sha || '')
    if (commits.length) commit(ctx, [{ file: 'journal', entry: { kind: 'series-done', node: id, branch, head_sha: revParse(worktree, 'HEAD'), commits } }])
  }

  // The tests a leaf is told to run: its criteria's checks, beside its own tests.
  const checks = leaf.acceptance.filter((a) => !isHuman(a) && a.check.trim()).map((a) => a.check)
  // A green and an audit are measured on their red's tests: the cycle's test files, outside their locus.
  const cycle = cycleOf(tree.nodes, id)
  const tests = (leaf.role === 'green' || leaf.role === 'audit') && cycle.length ? tree.nodes.get(cycle[0]).locus : []
  const cmd = commandsFor(ctx)
  const fences = scope ? testAuthorFences(ctx, worktree, args.base_sha || '', id, admitsTest, scope) : {}
  const m = verify({
    worktree, mode: 'order', base: args.base_sha || '', locus: leaf.locus, fences,
    ...cmd, mutations: heldMutations(leaf, earlier, blocks.mutations), rigor: leaf.rigor, role: leaf.role, producer: role, checks, tests,
    repo: ctx.repo, effort: ctx.effort, execution: ctx.execution, node: id, branch,
  })
  if (breaches.length) m.series_findings = [...(m.series_findings || []), ...breaches]
  const history = measuredOf(ctx, id)
  const decision = closeDecision(m, leaf, history.slice(0, -1), role)

  const head = revParse(worktree, 'HEAD')
  const written = []
  const deleted = []
  for (const g of blocks.gotchas) {
    const w = writeGotcha(ctx.repo, ctx.effort, g, { observed_at: head, source: { node: id, role } })
    if (w.ok) written.push(w.id)
    else notes.push('gotcha refused: ' + w.error)
  }
  for (const gid of blocks.stale) if (deleteGotcha(ctx.repo, ctx.effort, gid).deleted) deleted.push(gid)

  // Everything observed stays on disk; the courier carries only what the workflow branches on.
  const record = closePath(ctx.repo, ctx.effort, ctx.execution, id, role || 'none', round)
  const previous = round > 1 ? readJson(closePath(ctx.repo, ctx.effort, ctx.execution, id, role || 'none', round - 1)) : null
  const parentId = ownerOf(tree.nodes, id)
  const p = tree.nodes.get(parentId)
  const parent = p ? { id: parentId, kind: p.kind, author: p.author, spec_path: posix(specPath(ctx.repo, ctx.effort, parentId)) } : null
  const established = stateOf(ctx).some((e) => e.kind === 'dispatch' && e.role === 'investigator')
  const out = closeOutcome({ node: id, leaf, parent, head, decision, previous, record, established })
  writeJson(record, {
    node: id, role, round, head_sha: head, measurement: m, decision, gotchas_written: written,
    gotchas_deleted: deleted, mutations: blocks.mutations, committed, notes,
  })
  // The next round's failures stand only while this close says `fix`; a later close that decided
  // anything else takes them back, so a round opened for another reason never inherits them.
  const nextFixes = fixesPath(ctx.repo, ctx.effort, ctx.execution, id, round + 1)
  if (out.next === 'fix') writeJson(nextFixes, decision.failures.map((f) => ({ source: 'verification', ...f })))
  else rmSync(nextFixes, { force: true })
  commit(ctx, out.records)
  return {
    boundary: 'leaf-close', ok: true, error: null, status: 'done', node: id, head_sha: head,
    decision: { next: out.next, failures_n: decision.failures.length }, raise: Boolean(out.raise),
    record, report_path: reportFile,
    replan: out.replan_parent ? replanOf(ctx, tree, parentId, 'verify_finding', record) : null,
    stops: stopsOf(out.records),
  }
}

// ------------------------------------------------------------------ leaf-review

/** Pure. The open findings of a review round as the next fix round's brief lists them, each under its id. */
export const reviewFixes = (open) => list(open).map((f) => ({
  source: 'review ' + f.severity + ' ' + f.id, claim: f.claim, evidence: [f.evidence, f.failure_scenario].filter(Boolean).join(' — '),
}))

const reviewRecordPath = (ctx, id, reviewRound) => reviewPath(ctx.repo, ctx.effort, ctx.execution, id, reviewRound)

/**
 * One review round of a leaf: read the review its reviewer wrote, compute the loop's exit
 * (`reviewExit`) against what the round before left open, and record it — the approval, the
 * escalation, or the findings the next fix round's brief carries.
 */
function leafReview(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  const id = args.node
  const leaf = tree.nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf') return fail('leaf-review', 'not_a_leaf')
  const round = Number.isInteger(args.round) && args.round > 0 ? args.round : 1
  const reviewRound = Number.isInteger(args.review_round) && args.review_round > 0 ? args.review_round : 1
  const review = readJson(args.review_file)
  if (!review || !Array.isArray(review.findings)) {
    const records = faultRecords(id, 'dispatch', 'review round ' + reviewRound + ' wrote no review', { nodes: tree.nodes, events: tree.events, state: stateOf(ctx) })
    commit(ctx, records)
    return { boundary: 'leaf-review', ok: true, error: null, decision: { next: 'held', reason: '' }, raise: false, record: '', stops: stopsOf(records) }
  }
  const prior = reviewRound > 1 ? readJson(reviewRecordPath(ctx, id, reviewRound - 1)) : null
  const exit = reviewExit({
    yardstick: isYardstick(leaf), findings: review.findings, verdicts: list(review.fix_verdicts), prior: prior || {},
    producer: reviewedProducer(leaf, dispatchedRole(tree.events, ctx, id, round)),
  })
  const head = revParse(worktreeOf(ctx.repo, ctx.effort, id), 'HEAD')
  const record = reviewRecordPath(ctx, id, reviewRound)
  writeJson(record, { node: id, round, review_round: reviewRound, review_file: args.review_file, head_sha: head, ...exit })
  const nextFixes = fixesPath(ctx.repo, ctx.effort, ctx.execution, id, round + 1)
  const records = []
  if (exit.next === 'approve') records.push(approved(id, head, reviewRound, false))
  if (exit.next === 'escalate') {
    const said = saidBeside(args.review_file, '', 'Review round ' + reviewRound + ' of ' + id + ': ' + exit.detail + '.',
      exit.open.map((f) => '- [' + f.severity + ' ' + f.id + '] ' + f.claim + ' — ' + f.evidence).join('\n'))
    records.push(escalated(id, exit.reason, exit.detail, said))
  }
  if (exit.next === 'fix') writeJson(nextFixes, reviewFixes(exit.open))
  commit(ctx, records)
  return {
    boundary: 'leaf-review', ok: true, error: null, decision: { next: exit.next, reason: exit.reason }, raise: exit.raise,
    record, stops: stopsOf(records),
  }
}

// ------------------------------------------------------------------ merge-batch

/** Order a batch so a child merges after any sibling it depends on. */
function dependencyOrder(nodes, ids) {
  const out = []
  const visit = (id, seen = new Set()) => {
    if (out.includes(id) || seen.has(id)) return
    seen.add(id)
    for (const d of (nodes.get(id) || { deps: [] }).deps) if (ids.includes(d)) visit(d, seen)
    out.push(id)
  }
  for (const id of ids) visit(id)
  return out
}

const integrationOk = (m) => m && m.stop_reason === 'completed' && m.build !== 'failed' && m.typecheck !== 'failed' && !suiteFailed(m)
const integrationFailures = (m, head = 'the merged head') => {
  const out = []
  if (!m || m.stop_reason !== 'completed') out.push({ check: 'environment', claim: (m && m.error && m.error.message) || head + ' could not be measured', evidence: '' })
  for (const k of ['build', 'typecheck', 'suite']) {
    const what = k === 'suite' && m && m.suite_scope === 'fast' ? 'fast suite' : k
    if (m && (k === 'suite' ? suiteFailed(m) : m[k] === 'failed')) out.push({ check: k, claim: 'the ' + what + ' fails on ' + head, evidence: k === 'suite' ? (m.suite_output_tail || '') : (m.notes || '') })
  }
  return out
}

/**
 * Pure. What a landed diff touched that a pending node was designed against: the landed files
 * intersected with the `consumes` path prefixes of every node not yet merged. A contract the
 * landed work itself provides is expected to move and is not drift; a node with no contracts to
 * check against is reported as unexamined, because "no flag" and "nothing to check" differ.
 */
export function driftOf(tree, landedIds, files) {
  const landedSet = new Set(landedIds.flatMap((id) => subtreeOf(tree.nodes, id)))
  const providedHere = new Set([...landedSet].flatMap((id) => tree.nodes.get(id).provides.map((c) => c.name)))
  const under = (file, prefix) => file === prefix || file.startsWith(prefix.replace(/\/?$/, '/'))
  const drift = []
  let unexamined = 0
  for (const [id, n] of tree.nodes) {
    if (landedSet.has(id)) continue
    const s = (tree.status.get(id) || {}).status
    if (['merged', 'landed', 'reviewing', 'integrated'].includes(s)) continue
    if (n.consumes.length === 0) {
      if (n.kind === 'design' && childrenOf(tree.nodes, id).length === 0) unexamined++
      continue
    }
    for (const c of n.consumes) {
      if (providedHere.has(c.name)) continue
      const hit = files.filter((f) => c.paths.some((p) => under(f, p)))
      // A stopped node is the user's already: its drift is reported, never parked over its stop.
      if (hit.length) drift.push({ node: id, contract: c.name, files: hit, ...(['escalated', 'parked'].includes(s) ? { stopped: s } : {}) })
    }
  }
  return { drift, unexamined }
}

/**
 * Pure. The stops a merge-batch decides from what it observed: a conflict is a planner defect;
 * leaves that each pass alone and fail together are a combination failure; a composite, or a cycle
 * that lands as a unit, failing alone on the merged head has no one producer a fix round could go
 * to; and a batch that moved nothing and saw nothing fail stops its target.
 */
export function mergeRecords(target, { merged = [], conflict = null, combination = [], failedAlone = [], isLeaf }) {
  const out = []
  if (conflict) out.push(escalated(conflict.node, 'merge_conflict', 'conflicting paths: ' + conflict.paths.join(', ') + ' — loci were declared disjoint; this is a planner defect'))
  for (const id of combination) out.push(escalated(id, 'combination_failure', 'passes alone, fails merged with ' + combination.filter((x) => x !== id).join(', ')))
  for (const f of failedAlone) {
    if (f.ids.length === 1 && isLeaf(f.id)) continue
    const why = f.failures.map((x) => x.claim).join('; ')
    for (const m of f.ids) out.push(escalated(m, 'fails_on_integration', why))
  }
  if (merged.length + failedAlone.length + combination.length + (conflict ? 1 : 0) === 0) {
    out.push(escalated(target, 'merge_no_progress', 'a merge-batch into ' + target + ' merged nothing and reported no failure'))
  }
  return out
}

function mergeBatch(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  const target = args.target
  if (!tree.nodes.has(target) || ['leaf', 'group'].includes(tree.nodes.get(target).kind)) return fail('merge-batch', 'not_a_composite')
  const env = readEnvelope(ctx)
  if (!env) return fail('merge-batch', 'no_execution')
  const card = readJson(args.card) || {}
  const children = list(card.children).filter((c) => c && tree.nodes.has(c.id))
  const cycles = list(card.cycles)

  // Units: a cycle merges through its tip, which carries every member's commits.
  const inCycle = new Map()
  for (const cycle of cycles) for (const m of cycle) inCycle.set(m, cycle)
  const units = []
  const done = new Set()
  for (const id of dependencyOrder(tree.nodes, children.map((c) => c.id))) {
    if (done.has(id)) continue
    const cycle = inCycle.get(id)
    const ids = cycle ? cycle.filter((m) => children.some((c) => c.id === m)) : [id]
    ids.forEach((m) => done.add(m))
    const tip = ids[ids.length - 1]
    const given = children.find((c) => c.id === tip)
    const branch = branchOf(ctx.effort, tip)
    units.push({ ids, branch, head: (given && given.head_sha) || revParse(ctx.repo, 'refs/heads/' + branch) })
  }

  const targetBranch = branchOf(ctx.effort, target)
  const lock = (branch, fn) => withBranchLock(ctx.repo, ctx.effort, branch, fn)
  return lock(targetBranch, () => {
    const integ = ensureIntegration(ctx.repo, ctx.effort, target, env, { lock, held: targetBranch, isGroup: isGroupIn(tree) })
    if (!integ.ok) {
      // The batch cannot run at all (a refresh that conflicted, a dirty integration worktree): the
      // target is stopped, and nothing is re-batched into it until the user acts.
      const records = [escalated(target, 'merge_batch_failed', integ.error)]
      commit(ctx, records)
      return fail('merge-batch', 'integration', { stops: stopsOf(records) })
    }
    const wt = integ.worktree

    // A batch that started and never recorded its outcome died between merging and measuring, or
    // mid-bisect: its merges are unverified. Back to the head it started from, and do it again.
    const log = stateOf(ctx)
    const lastOf = (kind) => [...log].reverse().find((e) => e.kind === kind && e.target === target)
    const started = lastOf('batch-started')
    const finished = lastOf('batch')
    const notes = []
    if (started && (!finished || finished.seq < started.seq) && started.pre && contains(ctx.repo, revParse(wt, 'HEAD'), started.pre)) {
      git(wt, ['merge', '--abort'])
      resetTo(wt, started.pre)
      notes.push('an earlier batch into ' + target + ' died before recording its outcome; reset to ' + started.pre + ' and merged again')
    }
    const pre = revParse(wt, 'HEAD')
    const cmd = commandsFor(ctx)
    const measure = () => verify({ worktree: wt, mode: 'integration', scope: 'fast', base: pre, ...cmd, repo: ctx.repo, effort: ctx.effort, execution: ctx.execution, node: target, branch: integ.branch })

    const pending = units.filter((u) => !contains(ctx.repo, pre, u.head))
    if (pending.length) append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'batch-started', target, pre, children: pending.flatMap((u) => u.ids) })
    let out = mergeUnits(ctx.repo, wt, units)
    let merged = out.merged
    let measurement = null
    let verified = null
    const failedAlone = []
    let combination = []

    const fresh = merged.filter((m) => !m.already)
    // Everything already contained and nothing started: a re-run after the outcome was recorded.
    if (fresh.length === 0 && merged.length > 0) verified = true
    if (fresh.length > 0) {
      measurement = measure()
      verified = integrationOk(measurement)
      if (!verified) {
        // Bisect: back to the last green head, each unit alone, then the ones that pass together.
        resetTo(wt, pre)
        const passers = []
        for (const u of units.filter((x) => fresh.some((f) => f.ids === x.ids))) {
          const alone = mergeUnits(ctx.repo, wt, [u])
          const m = alone.conflict ? null : measure()
          if (m && integrationOk(m)) passers.push(u)
          else failedAlone.push({ id: u.ids[u.ids.length - 1], ids: u.ids, failures: m ? integrationFailures(m) : [{ check: 'merge', claim: alone.conflict.reason, evidence: '' }] })
          resetTo(wt, pre)
        }
        out = mergeUnits(ctx.repo, wt, passers)
        merged = out.merged
        if (passers.length > 1) {
          measurement = measure()
          verified = integrationOk(measurement)
          if (!verified) {
            combination = passers.flatMap((u) => u.ids)
            resetTo(wt, pre)
            merged = []
          }
        } else {
          verified = passers.length === 1
        }
      }
    }

    const head = revParse(wt, 'HEAD')
    const landed = merged.flatMap((m) => m.ids.map((id) => ({ id, merged_sha: m.merged_sha })))
    if (landed.length) {
      commit(ctx, landed.map((l) => ({ file: 'events', entry: { kind: 'merged', node: l.id, into: integ.branch, merged_sha: l.merged_sha, head_sha: (units.find((u) => u.ids.includes(l.id)) || {}).head || '' } })))
      append(ctx.repo, ctx.effort, 'journal:' + ctx.execution, landed.map((l) => ({ kind: 'merge-observed', node: l.id, branch: branchOf(ctx.effort, l.id), into: integ.branch, merged_sha: l.merged_sha, head_sha: head })))
      const leafIds = landed.map((l) => l.id).filter((id) => tree.nodes.get(id).kind === 'leaf')
      const under = landed.map((l) => l.id).filter((id) => tree.nodes.get(id).kind !== 'leaf')
        .flatMap((c) => subtreeOf(tree.nodes, c)).filter((id) => tree.nodes.get(id).kind === 'leaf')
      releaseLocus(ctx.repo, ctx.effort, [...leafIds, ...under])
      // A merged leaf's worktree has nothing left to do; its branch stays until landing.
      for (const id of leafIds) detach(ctx.repo, worktreeOf(ctx.repo, ctx.effort, id))
    }
    const conflict = out.conflict ? { node: out.conflict.ids[out.conflict.ids.length - 1], nodes: out.conflict.ids, paths: out.conflict.paths, reason: out.conflict.reason } : null
    if (pending.length) {
      append(ctx.repo, ctx.effort, 'state:' + ctx.execution, {
        kind: 'batch', target, merged: landed.map((l) => l.id), head_sha: head, verified,
        failed_alone: failedAlone.map((f) => f.id), combination, conflict: conflict ? conflict.node : '',
      })
    }

    const { drift, unexamined } = landed.length ? driftOf(tree, landed.map((l) => l.id), changedFiles(ctx.repo, pre, head)) : { drift: [], unexamined: 0 }
    const record = mergePath(ctx.repo, ctx.effort, ctx.execution, target, pre)
    writeJson(record, { target, pre, head_sha: head, merged: landed, conflict, verified, measurement, failed_alone: failedAlone, combination, drift, notes })
    // What the drifted consumers are ruled against: each one as planned, and the merged change to
    // the files it consumes.
    const open = drift.filter((d) => !d.stopped)
    const driftBrief = open.length ? record.replace(/\.json$/, '.drift.md') : ''
    if (driftBrief) {
      writeFileSync(driftBrief, rulingBrief(tree, [...new Set(open.map((d) => d.node))].map((id) => {
        const hits = open.filter((d) => d.node === id)
        return {
          node: id,
          note: 'Work merged into ' + integ.branch + ' touched ' +
            hits.map((d) => 'contract ' + d.contract + ' (' + d.files.join(', ') + ')').join(' and ') + ', which it consumes.',
          diff: git(wt, ['diff', pre + '..' + head, '--', ...new Set(hits.flatMap((d) => d.files))]).stdout,
        }
      })))
    }
    const isLeaf = (id) => (tree.nodes.get(id) || {}).kind === 'leaf'
    // A single leaf that fails on the integration head alone goes back to a fix round: the
    // failures that round must clear go where its leaf-open reads them.
    const fixRounds = failedAlone.filter((f) => f.ids.length === 1 && isLeaf(f.id)).map((f) => {
      writeJson(fixesPath(ctx.repo, ctx.effort, ctx.execution, f.id, roundsOf(tree.events, f.id) + 1), f.failures.map((x) => ({ source: 'integration', ...x })))
      return { id: f.id, card: leafCardOf(ctx, tree, f.id), row: rowOf(ctx, tree, f.id), facts: leafFactsOf(ctx, tree, [f.id]).get(f.id) || null }
    })
    const records = mergeRecords(target, { merged: landed, conflict, combination, failedAlone, isLeaf })
    commit(ctx, records)
    return {
      boundary: 'merge-batch', ok: true, error: null, status: 'done', target, head_sha: head, verified, record,
      merged: landed, failed_alone: fixRounds,
      drift: drift.map((d) => ({ node: d.node, contract: d.contract, stopped: d.stopped || '' })), drift_brief: driftBrief,
      unexamined_n: unexamined, stops: stopsOf(records),
    }
  })
}

// ------------------------------------------------------------------ suite-gate

/**
 * The full suite on a composite's integration head, once every child has merged: it runs before
 * the integration review, and so before the branch merges up or lands. Where the repository does
 * not split its tests, every merge-batch into this head already ran the full suite. A gate that
 * passes says whether the review is earned, and records a review that is not as `not_earned`.
 */
function suiteGate(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  const target = args.target
  if (!tree.nodes.has(target) || ['leaf', 'group'].includes(tree.nodes.get(target).kind)) return fail('suite-gate', 'not_a_composite')
  const where = integrationOf(ctx, tree, target)
  if (!where) return fail('suite-gate', 'no_integration')
  const cmd = commandsFor(ctx)
  const passedThrough = (head, ran, record) => {
    const env = readEnvelope(ctx) || { root: ROOT_ID }
    const review = reviewOf(scheduleInput(ctx, readTree(ctx.repo, ctx.effort), env, {}), target)
    const records = review.earned ? [] : [{ file: 'events', entry: { kind: 'claims', node: target, head_sha: head, review: 'not_earned', claims: [] } }]
    commit(ctx, records)
    return { boundary: 'suite-gate', ok: true, error: null, status: 'done', target, head_sha: head, ran, passed: true, review: review.earned ? 'earned' : 'not_earned', record, stops: [] }
  }
  if (!splitSuite(cmd)) return passedThrough(where.head, false, '')
  const passedAt = (head) => stateOf(ctx).some((e) => e.kind === 'gate' && e.target === target && e.head_sha === head && e.passed)
  if (passedAt(where.head)) return passedThrough(where.head, false, '')

  return withBranchLock(ctx.repo, ctx.effort, where.branch, () => {
    const wt = attach(ctx.repo, where.branch, where.worktree)
    if (!wt.ok) {
      const records = [escalated(target, 'suite_gate_failed', wt.error)]
      commit(ctx, records)
      return fail('suite-gate', 'integration', { stops: stopsOf(records) })
    }
    const head = revParse(wt.path, 'HEAD')
    const m = verify({
      worktree: wt.path, mode: 'integration', scope: 'full', base: where.base, ...cmd,
      repo: ctx.repo, effort: ctx.effort, execution: ctx.execution, node: target, branch: where.branch,
    })
    const passed = integrationOk(m)
    const failures = passed ? [] : integrationFailures(m, 'the integration head')
    const record = gatePath(ctx.repo, ctx.effort, ctx.execution, target, head)
    writeJson(record, { target, head_sha: head, base: where.base, passed, measurement: m, failures })
    append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'gate', target, head_sha: head, passed })
    if (passed) return passedThrough(head, true, record)
    const records = [escalated(target, 'fails_full_suite', failures.map((f) => f.claim).join('; ') + ' (the measurement: ' + record + ')')]
    commit(ctx, records)
    return { boundary: 'suite-gate', ok: true, error: null, status: 'done', target, head_sha: head, ran: true, passed: false, review: '', record, stops: stopsOf(records) }
  })
}

// ------------------------------------------------------------------ folder-review

/**
 * A folder's integration review, read from the file its reviewer wrote: the claim verdicts are
 * recorded at the head the review judged, and the one park they earn (`integrationPark`) with
 * them. A review nobody wrote is a plugin fault, never a question.
 */
function folderReview(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  const id = args.target
  if (!tree.nodes.has(id)) return fail('folder-review', 'no_such_node')
  const card = readJson(args.card) || {}
  const review = readJson(args.review_file)
  if (!review || !Array.isArray(review.claims)) {
    const records = faultRecords(id, 'dispatch', 'the integration review of ' + id + ' wrote no review', { nodes: tree.nodes, events: tree.events, state: stateOf(ctx) })
    commit(ctx, records)
    return { boundary: 'folder-review', ok: true, error: null, status: 'no_review', stops: stopsOf(records) }
  }
  const findings = list(review.findings)
  const held = integrationPark(findings, review.claims, card.spec_path || '')
  const said = saidBeside(args.review_file, '', 'The integration review of ' + id + ': ' + (held ? held.why + ' — ' + held.question : 'every claim met') + '.',
    review.claims.map((c) => '- [' + c.verdict + '] ' + c.claim + ' — ' + c.evidence)
      .concat(findings.map((f) => '- [' + f.severity + ' ' + f.id + '] ' + f.claim + ' — ' + f.evidence)).join('\n'))
  const records = [{
    file: 'events',
    entry: { kind: 'claims', node: id, head_sha: (card.where || {}).head || '', review: 'done', claims: review.claims.map(({ claim, verdict }) => ({ claim, verdict })), said },
  }]
  if (held) records.push(parked(id, held.why, held.question, said))
  commit(ctx, records)
  return {
    boundary: 'folder-review', ok: true, error: null, status: 'recorded', claims_n: review.claims.length,
    findings_n: findings.length, stops: stopsOf(records),
  }
}

// ------------------------------------------------------------------ rule-close

/**
 * Pure. What a ruler's rulings decide, on drift after a merge (`kind: drift`, the merge's record)
 * or on a base that moved under a resumed execution (`kind: stale`, preflight's record). Each
 * ruling is recorded with the file it points at (`saidFor`, which writes it); an affected node is
 * replanned unless work already stands on it, a unit of this run is in flight beneath it, or it is
 * a folder the user writes — then it parks. A node no ruling reached parks for drift (it would not
 * be found again) and is held for a moved base (the next invocation rules again).
 *
 * @returns {{records: object[], replan: {id: string, said: string}[]}}
 */
export function rulingOutcome({ kind, record, rulings, running, nodes, status, events, state, underWay: standsOn, specOf, saidFor }) {
  const stale = kind === 'stale'
  const items = stale ? list(record.nodes).map((node) => ({ node })) : list(record.drift).filter((d) => !d.stopped)
  const ids = [...new Set(items.map((i) => i.node))]
    .filter((id) => nodes.has(id) && !['escalated', 'parked'].includes((status.get(id) || {}).status))
  const inFlight = list(running).map((k) => k.slice(k.indexOf(':') + 1))
  const runningUnder = (id) => inFlight.some((at) => at === id || at.startsWith(id + '/'))
  const records = []
  const replan = []
  for (const id of ids) {
    const r = rulings && rulings.get(id)
    const mine = items.filter((i) => i.node === id)
    if (!r) {
      if (stale) records.push(...faultRecords(id, 'dispatch', 'the base moved under it and no ruler ruled on it', { nodes, events, state }))
      else {
        records.push(parked(id, 'contract_drift', 'merged work touched ' + mine.flatMap((d) => list(d.files)).join(', ') + ' under contract ' +
          mine.map((d) => d.contract).join(', ') + ', which ' + id + ' consumes, and no ruler could rule on it: rule it unaffected, re-design it or re-slice it'))
      }
      continue
    }
    const affected = r.ruling !== 'unaffected'
    const said = saidFor(id, r, affected)
    const ruling = affected ? 'affected' : 'unaffected'
    if (stale) records.push({ file: 'state', entry: { kind: 'stale-ruled', node: id, base_now: record.now || '', ruling, why: '', said } })
    else for (const d of mine) records.push({ file: 'state', entry: { kind: 'drift-ruled', node: id, contract: d.contract, head_sha: record.head_sha || '', ruling, why: '', said } })
    if (!affected) continue
    const n = nodes.get(id)
    if (standsOn(id) || runningUnder(id)) records.push(parked(id, stale ? 'premise_mismatch' : 'contract_drift', '', said))
    else if (n.kind !== 'leaf' && n.author !== 'planner') records.push(parked(id, 'needs_respec', 'edit ' + specOf(id) + ', re-approve it and recompile', said))
    else replan.push({ id, said })
  }
  return { records, replan }
}

/** The rulings a ruler wrote, recorded: see `rulingOutcome`. */
function ruleClose(ctx, args) {
  const tree = readTree(ctx.repo, ctx.effort)
  const read = readJson(args.rulings_file)
  const out = rulingOutcome({
    kind: args.kind, record: readJson(args.record) || {}, running: args.running,
    rulings: read && Array.isArray(read.rulings) ? new Map(read.rulings.filter((r) => r && r.node).map((r) => [r.node, r])) : null,
    nodes: tree.nodes, status: tree.status, events: tree.events, state: stateOf(ctx),
    underWay: (id) => underWay(tree, id), specOf: (id) => posix(specPath(ctx.repo, ctx.effort, id)),
    saidFor: (id, r, affected) => saidBeside(args.rulings_file, '-' + (id === ROOT_ID ? 'root' : nodeKey(id)),
      String((affected ? r.question : r.why) || r.why || ''), String(r.why || '')),
  })
  commit(ctx, out.records)
  return {
    boundary: 'rule-close', ok: true, error: null,
    replan: out.replan.map((r) => replanOf(ctx, tree, r.id, 'premise_mismatch', r.said)), stops: stopsOf(out.records),
  }
}

// ------------------------------------------------------------------ postflight

export function postflight(ctx, args) {
  let tree = readTree(ctx.repo, ctx.effort)
  const faults = faultsNamed(ctx, tree, args.fault)
  commit(ctx, faults)
  releaseSlots(ctx.repo, { effort: ctx.effort, execution: ctx.execution })
  tree = readTree(ctx.repo, ctx.effort)
  const env = readEnvelope(ctx) || { root: ROOT_ID }
  const root = env.root || ROOT_ID
  const input = scheduleInput(ctx, tree, env, {})
  const summary = summarize(input)
  let cleanup = 0
  let unmerged = 0
  for (const id of subtreeOf(tree.nodes, root)) {
    if (id === ROOT_ID || !branchExists(ctx.repo, branchOf(ctx.effort, id))) continue
    if ((tree.status.get(id) || {}).status === 'merged') cleanup++
    else unmerged++
  }
  if (summary.done && !input.state.some((e) => e.kind === 'closed')) {
    append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'closed', status: 'done' })
  }
  collectSpend(ctx)
  // The invocation is over: a session watching for questions stops here.
  append(ctx.repo, ctx.effort, 'state:' + ctx.execution, { kind: 'ended' })
  const where = input.integrationOf(root) || {}
  return {
    boundary: 'postflight', ok: true, error: null, summary,
    integration: { branch: where.branch || '', head_sha: where.head || '' },
    cleanup_n: cleanup, unmerged_n: unmerged, closed: summary.done, stops: stopsOf(faults),
  }
}

// ------------------------------------------------------------------ planner specs

/**
 * What a planner-written spec says about itself: where it is, its hash, how many decisions it
 * states (a planner may state none) and every problem `checkFolder` finds in its place in the
 * effort. A folder its parent does not give to the planner is refused here too.
 */
function specFacts(ctx, id) {
  const checked = checkFolder(ctx.repo, ctx.effort, id)
  const problems = [...checked.problems]
  if (checked.exists && checked.authoredBy !== 'planner') {
    problems.push({ file: checked.file, line: 1, problem: 'the parent spec gives ' + id + ' to the user, not to the planner' })
  }
  return {
    spec_path: posix(specPath(ctx.repo, ctx.effort, id)), exists: checked.exists, hash: checked.hash,
    decisions_n: checked.spec ? checked.spec.decisions.length : 0, problems,
  }
}

const problemsText = (problems) => list(problems).map((p) => p.file + ':' + p.line + ' ' + p.problem).join('; ')

/**
 * Pure. What a planner's return decides about the spec it was sent to write: nothing when it wrote
 * it; a park for a need only the user can meet; an escalation otherwise. The question or the need
 * is in the file `said` names, which the planner wrote.
 */
export function planOutcome(node, status, said) {
  if (!status) return { next: 'held' }
  if (status === 'written') return null
  if (['needs_decision', 'contract_changed', 'premise_mismatch'].includes(status)) return { next: 'stopped', records: [parked(node, status, '', said)] }
  return { next: 'stopped', records: [escalated(node, 'plan_' + status, '', said)] }
}

/**
 * Pure. What a spec check stops: a Decisions row (only the user states decisions) parks the
 * folder, any other problem escalates it.
 */
export function specStops(node, facts) {
  if (facts.decisions_n > 0) return [parked(node, 'needs_decision', facts.spec_path + ' states ' + facts.decisions_n + ' decision(s): only the user states decisions')]
  if (facts.problems.length) return [escalated(node, 'spec_refused', problemsText(facts.problems))]
  return []
}

/**
 * A planner-written spec, checked — after the planner's own return when this call closes its
 * dispatch (`said` names the file it was told to write).
 */
function specCheck(ctx, args) {
  const id = String(args.node || '')
  const tree = readTree(ctx.repo, ctx.effort)
  if (args.said) {
    const out = planOutcome(id, args.status || '', args.said)
    if (out) {
      const records = out.next === 'held'
        ? faultRecords(id, 'dispatch', 'the planner returned nothing', { nodes: tree.nodes, events: tree.events, state: stateOf(ctx) })
        : out.records
      commit(ctx, records)
      return { boundary: 'spec-check', ok: true, error: null, status: out.next, node: id, stops: stopsOf(records) }
    }
  }
  const facts = specFacts(ctx, id)
  const records = specStops(id, facts)
  commit(ctx, records)
  return {
    boundary: 'spec-check', ok: true, error: null, status: records.length ? 'stopped' : 'checked', node: id,
    spec_path: facts.spec_path, exists: facts.exists, hash: facts.hash, decisions_n: facts.decisions_n,
    problems_n: facts.problems.length, stops: stopsOf(records),
  }
}

/** The findings a review wrote to its file, in full; [] when there is none to read. */
function findingsIn(path) {
  const read = path ? readJson(path) : null
  return Array.isArray(read) ? read : list(read && read.findings)
}

/** What makes two review findings the same finding across rounds: its axis, its section, its claim. */
const findingKey = (f) => [f.axis, f.section, String(f.claim || '').toLowerCase().replace(/\s+/g, ' ').trim()].join('|')

/** A finding's settlement id: its evidence item, or the reviewed hash and its id when the review could not anchor it. */
const settlementId = (hash) => (f) => f.item || hash + '#' + f.id

/**
 * Pure. One autonomous review round, as the ledger records it, and what it stops: a partial
 * review escalates naming what it left; a finding back unchanged after the round before
 * incorporated it escalates as not converging. `fresh` are the ids of findings no disposition on
 * the ledger has settled yet — a finding carried from a settled round stays settled.
 */
export function reviewedOutcome({ node, hash, findings, previous = [], previousHash = '', dispositions = [], complete, remaining = [] }) {
  const idOf = settlementId(hash)
  const ambiguities = findings.filter((f) => f.severity === 'ambiguity').map(idOf)
  if (!complete) {
    const left = remaining.length ? remaining : ['the review reported no coverage']
    return { reviewed: { complete: false, remaining: left, ambiguities }, fresh: [], records: [escalated(node, 'review_incomplete', left.join('; '))] }
  }
  const settled = new Set(dispositions.map((d) => d.finding))
  const fresh = findings.filter((f) => !settled.has(idOf(f)))
  const incorporated = new Set(dispositions.filter((d) => d.outcome === 'incorporated').map((d) => d.finding))
  const prevId = settlementId(previousHash)
  const back = new Set(previous.filter((f) => incorporated.has(prevId(f))).map(findingKey))
  const again = fresh.find((f) => back.has(findingKey(f)))
  return {
    reviewed: { complete: true, remaining: [], ambiguities },
    fresh: fresh.map((f) => f.id),
    records: again ? [escalated(node, 'review_not_converging', 'finding ' + again.id + ' came back unchanged after it was incorporated')] : [],
  }
}

/** One review round examined this much of the spec on disk and raised these ambiguities: the ledger's `reviewed` line. */
function specReviewed(ctx, args) {
  const id = String(args.node || '')
  const dispositions = readLog(ctx.repo, ctx.effort, 'ledger').entries.filter((e) => e.kind === 'disposition' && e.folder === id)
  const out = reviewedOutcome({
    node: id, hash: args.hash || '', findings: findingsIn(args.findings_file), previous: findingsIn(args.previous_file),
    previousHash: args.previous_hash || '', dispositions, complete: args.complete === true, remaining: list(args.remaining),
  })
  const r = recordReviewed(ctx.repo, ctx.effort, id, out.reviewed)
  if (!r.ok) return fail('spec-reviewed', 'ledger')
  commit(ctx, out.records)
  return { boundary: 'spec-reviewed', ok: true, error: null, status: out.records.length ? 'stopped' : 'recorded', fresh: out.fresh, stops: stopsOf(out.records) }
}

/**
 * Pure. The planner's settlement of one round's findings. Every finding asked about needs one
 * disposition, and an ambiguity or a gap can only be incorporated; a settlement that breaks either
 * is refused and sent back once, and the same finding refused twice escalates.
 */
export function settleOutcome({ node, hash, findings, asked, refused = [], status, said, dispositions = [] }) {
  if (!status) return { next: 'held' }
  if (status === 'needs_decision') return { next: 'stopped', records: [parked(node, 'needs_decision', '', said)] }
  if (status === 'blocked') return { next: 'stopped', records: [escalated(node, 'blocked', '', said)] }
  const outcome = new Map(dispositions.filter((d) => d && d.finding).map((d) => [d.finding, d.outcome]))
  const these = findings.filter((f) => asked.includes(f.id))
  const wrong = these.filter((f) => !outcome.has(f.id) || (outcome.get(f.id) === 'discarded' && f.severity !== 'note'))
  if (wrong.length === 0) {
    const idOf = settlementId(hash)
    return { next: 'settled', dispositions: these.map((f) => ({ finding: idOf(f), outcome: outcome.get(f.id) })), records: [] }
  }
  const again = wrong.find((f) => refused.includes(f.id))
  if (again) {
    return { next: 'stopped', records: [escalated(node, 'review_not_converging', 'the planner left ' + again.id + ' (' + again.severity + ') unincorporated after it was refused')] }
  }
  return { next: 'refused', refused: wrong.map((f) => f.id), records: [] }
}

/** Record the planner's dispositions, each once: a re-sent boundary finds its lines already there. */
function specSettle(ctx, args) {
  const id = String(args.node || '')
  const tree = readTree(ctx.repo, ctx.effort)
  const written = readJson(args.return_file)
  const out = settleOutcome({
    node: id, hash: args.hash || '', findings: findingsIn(args.findings_file), asked: list(args.finding), refused: list(args.refused),
    status: args.status || '', said: args.said || '', dispositions: list(written && written.dispositions),
  })
  if (out.next === 'held') {
    const records = faultRecords(id, 'dispatch', 'the planner returned nothing for its findings', { nodes: tree.nodes, events: tree.events, state: stateOf(ctx) })
    commit(ctx, records)
    return { boundary: 'spec-settle', ok: true, error: null, status: 'held', stops: stopsOf(records) }
  }
  commit(ctx, out.records)
  if (out.next !== 'settled') {
    return { boundary: 'spec-settle', ok: true, error: null, status: out.next, refused: out.refused || [], stops: stopsOf(out.records) }
  }
  const seen = new Set(readLog(ctx.repo, ctx.effort, 'ledger').entries
    .filter((e) => e.kind === 'disposition' && e.folder === id).map((e) => e.finding + '|' + e.outcome))
  for (const d of out.dispositions) {
    if (seen.has(d.finding + '|' + d.outcome)) continue
    const r = recordDisposition(ctx.repo, ctx.effort, id, { finding: d.finding, outcome: d.outcome, by: 'planner' })
    if (!r.ok) return fail('spec-settle', 'ledger')
    seen.add(d.finding + '|' + d.outcome)
  }
  return {
    boundary: 'spec-settle', ok: true, error: null, status: 'settled',
    incorporated_n: out.dispositions.filter((d) => d.outcome === 'incorporated').length, stops: [],
  }
}

/**
 * Pure. The review gate of the spec as it stands, and what a shut gate stops: a round that edited
 * nothing cannot open it, so it escalates as not converging.
 */
export function gateOutcome(node, gate, edited) {
  if (gate.ratifiable || edited) return []
  return [escalated(node, 'review_not_converging', 'the gate stays shut on a spec this round did not edit: open ' +
    (list(gate.open).join(', ') || 'none') + (gate.coverage_complete ? '' : '; coverage incomplete'))]
}

/** The review gate of the spec as it stands, from the ledger: `approvalGate`, as the design skill reads it. */
function specGate(ctx, args) {
  const id = String(args.node || '')
  const { ratifiable, open, coverage_complete, reviewed } = approvalGate(ctx.repo, ctx.effort, id)
  const records = gateOutcome(id, { ratifiable, open, coverage_complete }, args.edited === true)
  commit(ctx, records)
  return {
    boundary: 'spec-gate', ok: true, error: null, ratifiable, status: ratifiable ? 'open' : records.length ? 'stopped' : 'shut',
    open, coverage_complete, reviewed, stops: stopsOf(records),
  }
}

/**
 * Pure. What a preparation stops: a refusal, a compile that refused, a folder that compiled with
 * nothing beneath it, or a leaf replanned without the planner changing it (`leafRev` is the
 * revision it was replanned from, '' when it was not a leaf).
 */
export function prepareOutcome(node, { refused, problems, compile, row, leafRev = '' }) {
  if (refused) return [escalated(node, 'prepare_refused', problemsText(problems))]
  if (!compile.ok) return [escalated(node, 'compile_refused', problemsText(compile.problems))]
  if (row && row.kind !== 'leaf' && row.children_n === 0) return [escalated(node, 'planner_wrote_nothing', 'compiled ' + node + ' with no plan entry beneath it')]
  if (row && row.kind === 'leaf' && leafRev !== '' && String(row.rev) === leafRev) {
    return [escalated(node, 'replan_not_converging', 'the planner answered the replan without changing the leaf')]
  }
  return []
}

/**
 * The gate passed: record the preparation against the review it passed, then compile the folder.
 * A compile that parks this very folder `spec_changed` has met the planner's own re-derivation of
 * it under dispatched work: that preparation is the answer, so the park is cleared at once.
 */
function specPrepare(ctx, args) {
  const id = String(args.node || '')
  const facts = specFacts(ctx, id)
  const done = (records, extra) => {
    commit(ctx, records)
    return { boundary: 'spec-prepare', ok: true, error: null, status: records.length ? 'stopped' : 'prepared', ...extra, stops: stopsOf(records) }
  }
  if (!facts.exists || facts.decisions_n > 0 || facts.problems.length > 0) {
    return done(prepareOutcome(id, { refused: true, problems: facts.problems }), {})
  }
  const prepared = recordPreparation(ctx.repo, ctx.effort, id, { review: String(args.review || '') })
  if (!prepared.ok) return fail('spec-prepare', 'ledger')
  const compile = compileEffort(ctx.repo, ctx.effort, { folder: id })
  if (compile.ok && (compile.parked || []).some((p) => p.node === id && p.reason === 'spec_changed')) {
    const cleared = append(ctx.repo, ctx.effort, 'events', { kind: 'replanned', node: id, execution: ctx.execution, reason: 'spec_rederived', by: 'planner' })
    if (!cleared.ok) return fail('spec-prepare', 'ledger')
  }
  const tree = readTree(ctx.repo, ctx.effort)
  const full = tree.nodes.has(id) ? rowOf(ctx, tree, id) : null
  const row = full ? { kind: full.kind, rev: full.rev, children_n: full.children_n } : null
  return done(prepareOutcome(id, { compile, row, leafRev: args.leaf_rev || '' }), {
    hash: prepared.hash, compile: { ok: compile.ok, written_n: (compile.written || []).length }, row,
  })
}

// ------------------------------------------------------------------ land (the session's act)

/**
 * Landing: the one ask. `check` reports what the user needs to decide; `merge` merges the effort
 * branch into the user's checked-out branch, refusing over an open escalation, a parked node or a
 * dirty tree, and then sweeps the branches it merged.
 */
export function land(repo, effort, action) {
  const tree = readTree(repo, effort)
  const effortBranch = branchOf(effort, ROOT_ID)
  const open = [...tree.status].filter(([, s]) => s.status === 'escalated' || s.status === 'parked')
  const human = [...tree.nodes.values()].flatMap((n) => n.acceptance.filter(isHuman).map((a) => ({ node: n.id, text: a.text })))
  const base = effortBase(repo, effort)
  const head = revParse(repo, 'HEAD')
  const into = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  const effortHead = revParse(repo, 'refs/heads/' + effortBranch)

  const report = () => {
    const userCommits = base.base_sha && head ? git(repo, ['log', '--oneline', base.base_sha + '..' + head]).stdout.split('\n').filter(Boolean) : []
    const userFiles = base.base_sha && head ? changedFiles(repo, base.base_sha, head) : []
    const effortFiles = base.base_sha && effortHead ? changedFiles(repo, base.base_sha, effortHead) : []
    return {
      action, effort, into, effort_branch: effortBranch, effort_head: effortHead,
      open_escalations: open.filter(([, s]) => s.status === 'escalated').map(([id, s]) => ({ node: id, reason: (s.last && s.last.reason) || '' })),
      parked: open.filter(([, s]) => s.status === 'parked').map(([id, s]) => ({ node: id, question: saidOf(s.last) })),
      human,
      drift: { base_sha: base.base_sha, base_moved: userCommits.length > 0, commits: userCommits, overlap: effortFiles.filter((f) => userFiles.includes(f)) },
      root_status: (tree.status.get(ROOT_ID) || {}).status || 'planned',
      root_claims: claimsOf(tree.events, ROOT_ID),
      landing: renderLanding(repo, effort),
    }
  }

  if (action === 'check') return { ...report(), ok: true }

  if (action === 'merge') {
    const r = report()
    if (r.open_escalations.length || r.parked.length) return { ...r, ok: false, error: 'never lands over an open escalation or a parked node' }
    const dirty = git(repo, ['status', '--porcelain']).stdout.split('\n')
      .filter((l) => l && !l.slice(3).startsWith('.claude/') && !l.slice(3).startsWith(AGENTICS_DIR + '/'))
    if (dirty.length) return { ...r, ok: false, error: 'the working tree is dirty: ' + dirty.slice(0, 5).join(', ') }
    // A landing that swept its own branch is landed still: asked again, it only sweeps.
    const landedSha = (tree.events.findLast((e) => e.kind === 'landed' && e.node === ROOT_ID) || {}).merged_sha || ''
    if (!effortHead && landedSha && contains(repo, head, landedSha)) return { ...r, ok: true, merged_sha: landedSha, already: true, ...sweep(repo, effort, head, into) }
    if (!effortHead) return { ...r, ok: false, error: 'there is no effort branch ' + effortBranch }
    if (contains(repo, head, effortHead)) return { ...r, ok: true, merged_sha: head, already: true, ...sweep(repo, effort, head, into) }
    const m = git(repo, ['merge', '--no-ff', '--no-edit', '-m', 'Merge agentics effort ' + effort, effortBranch])
    if (!m.ok) {
      git(repo, ['merge', '--abort'])
      return { ...r, ok: false, error: 'the merge failed and was aborted: ' + (m.stderr || m.stdout).trim() }
    }
    const sha = revParse(repo, 'HEAD')
    append(repo, effort, 'events', { kind: 'landed', node: ROOT_ID, execution: '', into, merged_sha: sha })
    return { ...r, ok: true, merged_sha: sha, ...sweep(repo, effort, sha, into) }
  }
  return { action, ok: false, error: 'unknown action ' + JSON.stringify(action) + ' — check or merge' }
}

/**
 * The effort's branches `head` holds, and the clean worktrees on them, removed — from the checkout
 * whose `head` took the landing merge, which is the only place "merged" can be read. `git branch
 * -d` only: a branch git does not see merged is kept, as is a dirty worktree, each with why.
 */
function sweep(repo, effort, head, into) {
  const removed = []
  const kept = []
  git(repo, ['worktree', 'prune'])
  const listed = git(repo, ['branch', '--list', branchOf(effort, ROOT_ID), nodeBranchGlob(effort), '--format=%(refname:short)']).stdout.split('\n').filter(Boolean)
  const known = worktrees(repo)
  for (const branch of listed) {
    if (!contains(repo, head, revParse(repo, 'refs/heads/' + branch))) {
      kept.push({ branch, why: 'not merged into ' + into })
      continue
    }
    const wt = [...known.values()].find((w) => w.branch === branch)
    if (wt) {
      if (git(wt.path, ['status', '--porcelain']).stdout.trim()) {
        kept.push({ branch, why: 'its worktree ' + wt.path + ' is dirty' })
        continue
      }
      const gone = git(repo, ['worktree', 'remove', wt.path])
      if (!gone.ok) {
        kept.push({ branch, why: 'its worktree ' + wt.path + ' could not be removed: ' + gone.stderr.trim() })
        continue
      }
    }
    const d = git(repo, ['branch', '-d', branch])
    if (d.ok) removed.push(branch)
    else kept.push({ branch, why: 'git branch -d refused: ' + d.stderr.trim() })
  }
  return { removed, kept }
}

// ------------------------------------------------------------------ jobs

const COMPUTE = { 'leaf-close': leafClose, 'merge-batch': mergeBatch, 'suite-gate': suiteGate }

/**
 * What a job's answer depends on beyond its arguments. The same arguments over a moved tree are a
 * different question: a close after the investigator established commands, a close after a fix
 * round's commits, a merge onto an integration head that moved. Keying on the arguments alone
 * would hand the old answer back forever.
 */
function fingerprint(ctx, name, args) {
  const commands = JSON.stringify(commandsFor(ctx))
  if (name === 'leaf-close') {
    const wt = worktreeOf(ctx.repo, ctx.effort, args.node)
    const report = readText(reportPath(ctx.repo, ctx.effort, ctx.execution, args.node, args.role || 'none', args.round || 1))
    return [commands, revParse(wt, 'HEAD'), git(wt, ['status', '--porcelain']).stdout, fnv1a(report)].join('|')
  }
  if (name === 'merge-batch') return [commands, revParse(ctx.repo, 'refs/heads/' + branchOf(ctx.effort, args.target))].join('|')
  // A gate that failed is asked again by the next invocation: what failed it may have been the
  // environment, which the user fixes without moving the head.
  if (name === 'suite-gate') {
    const invocations = stateOf(ctx).filter((e) => e.kind === 'invocation').length
    return [commands, revParse(ctx.repo, 'refs/heads/' + branchOf(ctx.effort, args.target)), invocations].join('|')
  }
  return commands
}

/** Bumped whenever a job's payload changes shape, so a result cached in the old shape is never served. */
const JOB_FORMAT = 3

// The dispatches a call closes are recorded before its job starts, and every poll is a courier of
// its own: they are not what the job answers.
const jobKey = (ctx, name, args) => {
  const { dispatch: _d, ...rest } = args
  return fnv1a(canonical({ name, ...rest, fingerprint: fingerprint(ctx, name, args), format: JOB_FORMAT }))
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * Run a long boundary in a detached child and poll for its result; `pending` when the poll limit
 * is reached first. The same arguments find the same job: a finished one answers at once, a live
 * one is polled again, a dead one without a result is started afresh.
 */
function detached(ctx, name, args) {
  const dir = join(ctx.dir, 'jobs')
  mkdirState(dir)
  const key = name + '-' + jobKey(ctx, name, args)
  const result = join(dir, key + '.json')
  const pidFile = join(dir, key + '.pid')
  const argsFile = join(dir, key + '.args.json')

  if (!existsSync(result)) {
    const pid = Number.parseInt(readText(pidFile), 10)
    if (!(Number.isInteger(pid) && alive(pid))) {
      writeFileSync(argsFile, JSON.stringify(args))
      const child = spawn(process.execPath, [SELF, 'job', '--name', name, '--repo', ctx.repo, '--effort', ctx.effort,
        '--execution', ctx.execution, '--args-file', argsFile, '--out', result], { detached: true, stdio: 'ignore', windowsHide: true })
      writeFileSync(pidFile, String(child.pid))
      child.unref()
    }
  }
  const until = Date.now() + pollLimit()
  while (Date.now() < until) {
    if (existsSync(result)) {
      const payload = readJson(result)
      // A job that failed is not an answer to keep: the next identical call runs it again.
      if (payload && payload.error) {
        rmSync(result, { force: true })
        rmSync(pidFile, { force: true })
      }
      if (payload) return payload
    }
    sleepMs(250)
  }
  return { boundary: name, ok: true, error: null, status: 'pending', job: key, stops: [] }
}

/**
 * A job that threw is a plugin fault on the node it ran for, recorded where the message is known;
 * its payload says only that it failed.
 */
function jobFailed(ctx, name, args, err) {
  const node = args.node || args.target || ''
  let records = []
  try {
    const tree = readTree(ctx.repo, ctx.effort)
    if (tree.nodes.has(node)) records = faultRecords(node, 'program', name + ': ' + err.message, { nodes: tree.nodes, events: tree.events, state: stateOf(ctx) })
    commit(ctx, records)
  } catch {
    records = []
  }
  return fail(name, 'job_failed', { stops: stopsOf(records) })
}

// ------------------------------------------------------------------ CLI

const BOUNDARIES = {
  preflight, schedule: scheduleBoundary, 'leaf-open': leafOpen, 'leaf-review': leafReview, 'folder-review': folderReview,
  'rule-close': ruleClose, postflight, 'spec-check': specCheck, 'spec-settle': specSettle, 'spec-reviewed': specReviewed,
  'spec-gate': specGate, 'spec-prepare': specPrepare,
}

/**
 * Run one entry point over its parsed arguments. The dispatches it closes are recorded first,
 * each once by its label, so a courier that dies after this point loses no cost line.
 */
export function runBoundary(name, repo, effort, execution, args) {
  const ctx = contextOf(repo, effort, execution)
  if (!COMPUTE[name] && !BOUNDARIES[name]) throw new Error('unknown boundary ' + JSON.stringify(name))
  if (list(args.dispatch).length) commit(ctx, dispatchRecords(readTree(ctx.repo, ctx.effort).nodes, args.dispatch))
  if (name === 'leaf-close') {
    const early = leafCloseFront(ctx, args)
    if (early) return early
  }
  if (COMPUTE[name]) {
    if (process.env.AGENTICS_INLINE_JOBS === '1') {
      try {
        return COMPUTE[name](ctx, args)
      } catch (err) {
        return jobFailed(ctx, name, args, err)
      }
    }
    return detached(ctx, name, args)
  }
  return BOUNDARIES[name](ctx, args)
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const [name] = argv
  const repo = flagOf(argv, 'repo') || '.'
  const effort = flagOf(argv, 'effort')
  try {
    if (name === 'job') {
      const ctx = contextOf(repo, effort, flagOf(argv, 'execution'))
      const jobName = flagOf(argv, 'name')
      const args = JSON.parse(readFileSync(flagOf(argv, 'args-file'), 'utf8'))
      let payload
      try {
        payload = COMPUTE[jobName](ctx, args)
      } catch (err) {
        payload = jobFailed(ctx, jobName, args, err)
      }
      const out = flagOf(argv, 'out')
      writeFileSync(out + '.tmp', JSON.stringify(payload))
      renameSync(out + '.tmp', out)
      process.exit(0)
    }
    if (name === 'retry') {
      const ctx = contextOf(repo, effort, flagOf(argv, 'execution'))
      const ids = argv.filter((a, i) => argv[i - 1] === '--node')
      console.log(JSON.stringify(retryEscalated(ctx, readTree(ctx.repo, ctx.effort), ids), null, 1))
      process.exit(0)
    }
    if (name === 'note') {
      const ctx = contextOf(repo, effort, flagOf(argv, 'execution'))
      console.log(JSON.stringify(noteNode(ctx, readTree(ctx.repo, ctx.effort), flagOf(argv, 'node'), flagOf(argv, 'text')), null, 1))
      process.exit(0)
    }
    if (name === 'land') {
      console.log(JSON.stringify(land(repo, effort, flagOf(argv, 'action')), null, 1))
      process.exit(0)
    }
    if (!ARGS[name]) throw new Error('unknown boundary ' + JSON.stringify(name))
    const { value, problem } = handleArgs(argv, ARGS[name])
    const payload = problem ? fail(name, problem.kind) : runBoundary(name, repo, effort, flagOf(argv, 'execution'), value)
    console.log(JSON.stringify(handleEnvelope(payload)))
    process.exit(0)
  } catch (err) {
    // What a courier pastes is handles only; the message is for whoever runs the command by hand.
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n')
    console.log(JSON.stringify({ error: 'program_failed' }))
    process.exit(1)
  }
}
