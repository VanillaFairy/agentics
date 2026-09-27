// lib/tree.mjs — the execution tree: node records, their validation, and every node's status,
// derived.
//
// Design: docs/DESIGN.md#the-execution-tree.
//
// All work is one tree. The repository is the root; an effort is a subtree; every node is a
// `design`, `composite` or `leaf` node with the same schema, the same event log and a status
// derived the same way at every depth. That is the whole reason this file is small: one recursive
// node, rather than a layer per grain with a vocabulary, a store and a scheduler each.
//
// Two logs, two kinds of fact. `nodes.jsonl` holds what was AUTHORED — a node revision per line,
// the latest by `seq` winning, so a replan appends and nothing is rewritten. `events.jsonl` holds
// what HAPPENED — dispatched, approved, merged, escalated. A status is never stored: it is a
// function over the two, recomputed on every read, because a status written down outlives the
// thing it described.
//
// This file refuses; it never repairs. A tree the tool patched is a tree nobody authored.

import { pathToFileURL } from 'node:url'

import { checkAtomicity } from './atomicity.mjs'
import { EVENT_KINDS, append, digestEntries, readLog } from './ledger.mjs'
import { trace } from './traceability.mjs'
import {
  ROOT_ID, ancestorsOf, flagOf, nodeIdProblem, parentOf, safePath, safeSlug,
} from './store.mjs'

const KINDS = ['design', 'composite', 'leaf']
const AUTHORS = ['you', 'planner']
export const RIGORS = ['verify', 'trivial', 'tests-only', 'tdd', 'tdd-pair', 'tdd-triad']
const ROLES = ['none', 'red', 'green', 'audit']

const DECISION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const str = (v) => (typeof v === 'string' ? v : '')
const list = (v) => (Array.isArray(v) ? v : [])
const strings = (v) => list(v).filter((x) => typeof x === 'string')
const contracts = (v) => list(v)
  .filter((c) => c && typeof c === 'object')
  .map((c) => ({ name: str(c.name), paths: strings(c.paths) }))
const tier = (v) => (v && typeof v === 'object'
  ? { ...(typeof v.model === 'string' ? { model: v.model } : {}), ...(typeof v.effort === 'string' ? { effort: v.effort } : {}) }
  : undefined)

/**
 * Pure. Every field present, each with its empty value when the author left it out. Unknown keys
 * are dropped: a field the schema does not define carries nothing the pipeline reads.
 */
export function normalizeNode(raw) {
  const n = raw && typeof raw === 'object' ? raw : {}
  const dispatch = {}
  if (n.dispatch && typeof n.dispatch === 'object') {
    for (const stage of ['producer', 'reviewer']) {
      const t = tier(n.dispatch[stage])
      if (t && Object.keys(t).length) dispatch[stage] = t
    }
  }
  return {
    id: str(n.id),
    title: str(n.title),
    intent: str(n.intent),
    kind: str(n.kind),
    author: str(n.author) || 'you',
    defines: list(n.defines).filter((d) => d && typeof d === 'object').map((d) => ({ id: str(d.id), text: str(d.text) })),
    decisions: strings(n.decisions),
    acceptance: list(n.acceptance).map((a) => (typeof a === 'string'
      ? { text: a, check: '', decisions: [] }
      : { text: str(a && a.text), check: str(a && a.check), decisions: strings(a && a.decisions) })),
    ground: strings(n.ground),
    ground_known: n.ground_known !== false,
    locus: strings(n.locus),
    reads: strings(n.reads),
    deps: strings(n.deps),
    provides: contracts(n.provides),
    consumes: contracts(n.consumes),
    shared: strings(n.shared),
    rigor: str(n.rigor),
    role: str(n.role) || 'none',
    dispatch,
    context: str(n.context),
    retired: n.retired === true,
  }
}

export const isHuman = (criterion) => /^HUMAN:/.test(criterion.text)

/** Pure. Whether a leaf's role fits its rigor's cycle, judged from the node alone (no deps
 * needed): a `tdd` leaf's role must be `none`, a `tdd-pair`'s `red` or `green`, a `tdd-triad`'s
 * one of the three. The problem sentence, or null when it fits. */
export function roleFitsRigor(node) {
  const cycle = node.rigor === 'tdd-pair' ? ['red', 'green'] : node.rigor === 'tdd-triad' ? ['red', 'green', 'audit'] : ['none']
  return cycle.includes(node.role) ? null : 'a ' + node.rigor + ' leaf has role ' + cycle.join(' or ') + ', not ' + node.role
}

/** Pure. Shape problems of one normalized node, as sentences: what compile's node validation
 * would refuse. Used both by compile itself (through `treeProblems`) and, entry by entry, by
 * `lib/spec.mjs`'s `checkFolder`, so a draft the Draft gate passes is one compile will not refuse. */
export function nodeProblems(node) {
  const out = []
  const idProblem = nodeIdProblem(node.id)
  if (idProblem) return [idProblem]
  const at = (msg) => out.push(node.id + ': ' + msg)

  if (node.retired) return out
  if (!KINDS.includes(node.kind)) at('kind must be one of ' + KINDS.join(', ') + ', not ' + JSON.stringify(node.kind))
  if (node.title.trim() === '') at('title is empty')
  if (!AUTHORS.includes(node.author)) at('author must be you or planner, not ' + JSON.stringify(node.author))
  else if (node.author === 'planner' && node.kind === 'leaf') at('a leaf has no author: only a design or composite node\'s spec is written by the planner')

  for (const field of ['locus', 'reads', 'ground', 'shared']) {
    for (const p of node[field]) if (safePath(p) === null) at(field + ' path ' + JSON.stringify(p) + ' is not a repo-relative path')
  }
  for (const c of [...node.provides, ...node.consumes]) {
    if (c.name.trim() === '') at('a contract has no name')
    if (c.paths.length === 0) at('contract ' + JSON.stringify(c.name) + ' names no paths — drift detection needs them')
    for (const p of c.paths) if (safePath(p) === null) at('contract path ' + JSON.stringify(p) + ' is not a repo-relative path')
  }
  for (const d of node.defines) {
    if (!DECISION_ID.test(d.id)) at('decision id ' + JSON.stringify(d.id) + ' is not a valid id')
    if (d.text.trim() === '') at('decision ' + d.id + ' has no text')
  }
  for (const d of node.decisions) if (!DECISION_ID.test(d)) at('decision id ' + JSON.stringify(d) + ' is not a valid id')
  for (const dep of node.deps) {
    const p = nodeIdProblem(dep)
    if (p) at('dep ' + p)
    if (dep === node.id) at('depends on itself')
  }

  if (node.kind === 'leaf') {
    if (!RIGORS.includes(node.rigor)) at('a leaf needs a rigor: ' + RIGORS.join(', '))
    if (!ROLES.includes(node.role)) at('role must be one of ' + ROLES.join(', '))
    if (node.rigor !== 'verify' && node.locus.length === 0) at('a leaf that writes needs a locus')
    if (node.rigor === 'verify' && node.locus.length > 0) at('a verify leaf writes nothing, so its locus is empty')
    if (node.acceptance.length === 0) at('a leaf needs acceptance criteria')
    for (const a of node.acceptance) {
      if (a.text.trim() === '') at('an acceptance criterion is empty')
      if (!isHuman(a) && a.check.trim() === '') at('criterion ' + JSON.stringify(a.text) + ' names no check (prefix HUMAN: to route it to the user)')
      for (const d of a.decisions) if (!node.decisions.includes(d)) at('criterion traces to ' + d + ', which the leaf does not list in decisions')
    }
    if (node.shared.length) at('only a composite designates shared files')
  } else {
    if (node.rigor !== '') at('only a leaf has a rigor')
    if (node.role !== 'none') at('only a leaf has a role')
    if (node.locus.length || node.reads.length) at('only a leaf declares locus and reads')
  }
  return out
}

/** Pure. The live tree: the latest revision per id, retired ones dropped. */
export function liveNodes(nodeLines) {
  const latest = new Map()
  for (const line of nodeLines) {
    if (!line || line.kind !== 'node' || !line.node) continue
    const node = normalizeNode(line.node)
    const prev = latest.get(node.id)
    const seq = Number.isInteger(line.seq) ? line.seq : 0
    if (!prev || prev.seq <= seq) latest.set(node.id, { ...node, seq })
  }
  const live = new Map()
  for (const [id, node] of latest) if (!node.retired) live.set(id, node)
  return live
}

/** Pure. The ids of a node's live children, in id order. */
export const childrenOf = (nodes, id) =>
  [...nodes.keys()].filter((k) => k !== ROOT_ID && parentOf(k) === id).sort()

/** Pure. A subtree's ids, pre-order, starting at `rootId`. */
export function subtreeOf(nodes, rootId) {
  if (!nodes.has(rootId)) return []
  const out = [rootId]
  for (const child of childrenOf(nodes, rootId)) out.push(...subtreeOf(nodes, child))
  return out
}


/** Pure. Every decision a node may realise: those defined by itself or any ancestor. */
export function definedFor(nodes, id) {
  const out = new Map()
  for (const at of [id, ...ancestorsOf(id)]) {
    const n = nodes.get(at)
    if (n) for (const d of n.defines) if (!out.has(d.id)) out.set(d.id, { ...d, defined_at: at })
  }
  return out
}

/** Pure. Problems of the whole live tree, as `{node, problem}`. */
export function treeProblems(nodes) {
  const out = []
  const at = (node, problem) => out.push({ node, problem })

  if (nodes.size && !nodes.has(ROOT_ID)) at(ROOT_ID, 'the effort has nodes but no root node "."')

  const definedAt = new Map()
  for (const [id, n] of nodes) {
    for (const p of nodeProblems(n)) at(id, p)
    const parent = parentOf(id)
    if (parent !== null && !nodes.has(parent)) at(id, 'its parent ' + parent + ' is not in the tree')
    if (parent !== null && nodes.has(parent) && nodes.get(parent).kind === 'leaf') at(id, 'its parent ' + parent + ' is a leaf')
    for (const d of n.defines) {
      if (definedAt.has(d.id)) at(id, 'decision ' + d.id + ' is already defined by ' + definedAt.get(d.id))
      else definedAt.set(d.id, id)
    }
  }

  const providers = new Map()
  for (const [id, n] of nodes) {
    for (const c of n.provides) {
      if (providers.has(c.name)) at(id, 'contract ' + c.name + ' is already provided by ' + providers.get(c.name))
      else providers.set(c.name, id)
    }
  }

  for (const [id, n] of nodes) {
    const defined = definedFor(nodes, id)
    for (const d of n.decisions) if (!defined.has(d)) at(id, 'realises decision ' + d + ', which neither it nor an ancestor defines')
    for (const dep of n.deps) if (!nodes.has(dep)) at(id, 'depends on ' + dep + ', which is not in the tree')

    if (n.kind === 'leaf') {
      const fit = roleFitsRigor(n)
      if (fit) at(id, fit)
      const needs = n.role === 'green' ? 'red' : n.role === 'audit' ? 'green' : ''
      if (needs) {
        const up = n.deps.map((d) => nodes.get(d)).filter((d) => d && d.kind === 'leaf' && d.role === needs && d.rigor === n.rigor)
        if (up.length !== 1) at(id, 'a ' + n.role + ' leaf depends on exactly one ' + needs + ' leaf of the same rigor')
      }
    }
  }

  // Dependency cycles, by depth-first search over live deps.
  const state = new Map()
  const visit = (id, path) => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'open') {
      at(id, 'dependency cycle: ' + [...path.slice(path.indexOf(id)), id].join(' -> '))
      return
    }
    state.set(id, 'open')
    for (const dep of (nodes.get(id) || { deps: [] }).deps) if (nodes.has(dep)) visit(dep, [...path, id])
    state.set(id, 'done')
  }
  for (const id of nodes.keys()) visit(id, [])

  return out
}

// ------------------------------------------------------------------ roles and cycles

/** Pure. Which agent authors a leaf: '' for a verify leaf, which has no producer. */
export function executorRole(leaf) {
  if (leaf.rigor === 'verify') return ''
  if (leaf.role === 'red' || leaf.rigor === 'tests-only') return 'test-author'
  if (leaf.role === 'audit') return 'auditor'
  return 'implementer'
}

/** Pure. Whether a leaf buys a review loop of its own, rather than review at integration. */
export const ownReview = (leaf) =>
  leaf.rigor === 'tdd-pair' || leaf.rigor === 'tdd-triad' || leaf.provides.length > 0

/** Pure. Whether a leaf's output is a yardstick later work is measured against. */
export const isYardstick = (leaf) => leaf.role === 'red' || leaf.role === 'audit' || leaf.provides.length > 0

/**
 * Pure. The red → green (→ audit) cycle a leaf belongs to, in order, or [] for a leaf in none.
 * Read from `role` and `deps` alone, so nothing new is asked of a plan.
 */
export function cycleOf(nodes, id) {
  const leaf = nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf' || leaf.role === 'none') return []
  let red = leaf
  while (red && red.role !== 'red') {
    const want = red.role === 'audit' ? 'green' : 'red'
    red = red.deps.map((d) => nodes.get(d)).find((d) => d && d.role === want && d.rigor === leaf.rigor)
  }
  if (!red) return []
  const out = [red.id]
  for (const want of ['green', 'audit']) {
    const prev = out[out.length - 1]
    const next = [...nodes.values()].find((n) => n.kind === 'leaf' && n.role === want && n.rigor === red.rigor && n.deps.includes(prev))
    if (!next) break
    out.push(next.id)
  }
  return out
}

// ------------------------------------------------------------------ derived status

/**
 * Pure. Every live node's status, derived from its revisions and its events.
 *
 * A leaf, first match wins: `merged`; `escalated` / `parked` when that event is newer than the
 * node's last replan and last revision (a replan or a user's answer clears it); `approved` when
 * newer than the last dispatch (a held cycle member is approved and not merged); `active` while a
 * dispatch has nothing terminal after it; otherwise `planned`. A composite is `merged` on its own
 * event, the root `landed` on its, and otherwise summarizes its children.
 *
 * @param {Map<string, object>} nodes liveNodes()
 * @param {object[]} events the effort's event log
 * @returns {Map<string, {status: string, last: object}>}
 */
export function deriveStatus(nodes, events) {
  const byNode = new Map()
  for (const e of events) {
    if (!e || typeof e.node !== 'string' || !EVENT_KINDS.includes(e.kind)) continue
    if (!byNode.has(e.node)) byNode.set(e.node, [])
    byNode.get(e.node).push(e)
  }
  const lastOf = (id, kind) => {
    let found = null
    for (const e of byNode.get(id) || []) if (e.kind === kind && (!found || e.seq > found.seq)) found = e
    return found
  }
  const seqOf = (e) => (e && Number.isInteger(e.seq) ? e.seq : -1)

  const out = new Map()
  const leafStatus = (id) => {
    const n = nodes.get(id)
    const cleared = Math.max(seqOf(lastOf(id, 'replanned')), n.seq || 0)
    const merged = lastOf(id, 'merged')
    if (merged) return { status: 'merged', last: merged }
    const escalated = lastOf(id, 'escalated')
    const parked = lastOf(id, 'parked')
    const approved = lastOf(id, 'approved')
    const dispatched = lastOf(id, 'dispatched')
    const open = [escalated, parked].filter((e) => seqOf(e) > cleared).sort((a, b) => b.seq - a.seq)[0]
    if (open) return { status: open.kind, last: open }
    if (approved && seqOf(approved) > seqOf(dispatched) && seqOf(approved) > cleared) return { status: 'approved', last: approved }
    if (dispatched && seqOf(dispatched) > cleared) return { status: 'active', last: dispatched }
    return { status: 'planned', last: null }
  }

  const visit = (id) => {
    if (out.has(id)) return out.get(id)
    const n = nodes.get(id)
    let result
    if (n.kind === 'leaf') {
      result = leafStatus(id)
    } else {
      const own = lastOf(id, 'merged')
      const landed = id === ROOT_ID ? lastOf(id, 'landed') : null
      const cleared = Math.max(seqOf(lastOf(id, 'replanned')), n.seq || 0)
      // A composite's own escalation or park (a merge that conflicted, a critical at integration,
      // a plan the user must rule on) holds it exactly as a leaf's holds the leaf.
      const open = [lastOf(id, 'escalated'), lastOf(id, 'parked')].filter((e) => seqOf(e) > cleared).sort((a, b) => b.seq - a.seq)[0]
      const kids = childrenOf(nodes, id).map((c) => visit(c).status)
      if (landed) result = { status: 'landed', last: landed }
      else if (own) result = { status: 'merged', last: own }
      else if (open) result = { status: open.kind, last: open }
      else if (kids.length === 0) result = { status: n.kind === 'design' ? 'open' : 'planned', last: null }
      else if (kids.every((s) => s === 'merged')) result = { status: 'integrated', last: null }
      else if (kids.some((s) => s === 'active' || s === 'approved' || s === 'integrated')) result = { status: 'active', last: null }
      else if (kids.some((s) => s === 'parked' || s === 'open')) result = { status: 'parked', last: null }
      else if (kids.some((s) => s === 'escalated')) result = { status: 'escalated', last: null }
      else if (kids.some((s) => s === 'merged')) result = { status: 'active', last: null }
      else result = { status: 'planned', last: null }
    }
    out.set(id, result)
    return result
  }
  for (const id of nodes.keys()) visit(id)
  return out
}

/** Pure. The claim verdicts of the latest integration review recorded for `id`, or null when none was. */
export function claimsOf(events, id) {
  let found = null
  for (const e of events) {
    if (e && e.kind === 'claims' && e.node === id && Array.isArray(e.claims) && (!found || e.seq > found.seq)) found = e
  }
  return found ? found.claims : null
}


// ------------------------------------------------------------------ reading an effort

/** Read an effort's live tree and its events from disk. */
export function readTree(repo, effort) {
  const nodeLog = readLog(repo, effort, 'nodes')
  const eventLog = readLog(repo, effort, 'events')
  const nodes = liveNodes(nodeLog.entries)
  return {
    nodes,
    events: eventLog.entries,
    status: deriveStatus(nodes, eventLog.entries),
    malformed: nodeLog.malformed + eventLog.malformed,
    error: nodeLog.error || eventLog.error || '',
  }
}

/** The decisions the tree realises: a leaf's, and a design node's (the frontier is not unrealised). */
const realisedBy = (nodes) => {
  const out = new Set()
  for (const n of nodes.values()) if (n.kind === 'leaf' || n.kind === 'design') for (const d of n.decisions) out.add(d)
  return out
}

/**
 * Pure. IL4's guard, for every writer. A batch may not state or change a decision (`defines`)
 * except from compile, and only as the approved copy on the ledger says it. A contract a node provides
 * is a decision too: compile may change it only on a node whose entry sits in a spec the user
 * approved (`owned`). And no batch may leave a decision that a leaf or the frontier realised
 * before realised by none after it, except one a user-approved `dropped` entry gave up
 * (`accepted`, compile only). Retiring a node is no way round either guard: outside compile,
 * retiring a live node that provides a contract or defines a decision is refused the same as
 * changing or stating one. Who designs a node (`author`) is a decision too: only compile may
 * set or change it.
 */
function decisionProblems(before, after, batch, { by, approved, owned, accepted }) {
  const compile = by === 'compile'
  const out = []
  for (const n of batch) {
    const was = before.get(n.id)
    if (!compile && !n.retired && n.author !== (was ? was.author : 'you')) {
      out.push({ node: n.id, problem: 'a batch may not set or change who designs a node (author) except from compile' })
    }
    const defines = (x) => canonicalList(x ? x.defines : [])
    if (defines(was) !== defines(n.retired ? was : n)) {
      const copy = compile && approved instanceof Map ? approved.get(n.id) : undefined
      if (!Array.isArray(copy)) {
        out.push({ node: n.id, problem: 'a batch may not state or change a decision (defines) except from compile, against the approved spec on the ledger — return needs_decision' })
      } else if (canonicalList(copy.map((d) => ({ id: str(d && d.id), text: str(d && d.text) }))) !== defines(n)) {
        out.push({ node: n.id, problem: 'these defines differ from the approved copy on the ledger — the spec changed since it was approved; approve it again' })
      }
    }
    const mayMoveContract = compile && owned instanceof Set && owned.has(n.id)
    if (was && !n.retired && !mayMoveContract && canonicalList(was.provides) !== canonicalList(n.provides)) {
      out.push({ node: n.id, problem: 'a replan may not change a contract this node provides — return contract_changed' })
    }
    if (was && !n.retired && !mayMoveContract && canonicalList(was.consumes) !== canonicalList(n.consumes)) {
      out.push({ node: n.id, problem: 'a replan may not drop or re-path a contract this node consumes — return contract_changed' })
    }
    if (n.retired && was && !compile) {
      if (was.provides.length) {
        out.push({ node: n.id, problem: 'retiring ' + n.id + ' drops the contract ' + was.provides.map((c) => c.name).join(', ') + ' it provides — return contract_changed' })
      }
      if (was.defines.length) {
        out.push({ node: n.id, problem: 'retiring ' + n.id + ' drops the decision ' + was.defines.map((d) => d.id).join(', ') + ' it defines — return needs_decision' })
      }
    }
  }
  const exempt = compile && accepted instanceof Set ? accepted : new Set()
  const lost = [...realisedBy(before)].filter((d) => !realisedBy(after).has(d) && definedAnywhere(after, d) && !exempt.has(d))
  for (const d of lost) out.push({ node: '', problem: 'decision ' + d + ' was realised before this replan and is realised by no leaf or design node after it' })
  return out
}

const canonicalList = (list) => JSON.stringify((list || []).map((x) => JSON.stringify(x)).sort())
const definedAnywhere = (nodes, id) => [...nodes.values()].some((n) => n.defines.some((d) => d.id === id))

/**
 * Validate a batch of node revisions against the tree on disk and append it, all or nothing.
 *
 * Shape and tree problems refuse the batch. Atomicity conditions a script can compute, and
 * traceability gaps, are returned as warnings: whether to split further or accept a gap is the
 * author's call, and the gate that refuses dispatch over a gap is preflight's checkpoint.
 *
 * @param {string} by the writer; only 'compile' may state or change a decision.
 * @param {string} reason the replan reason logged for every node in the batch, unless `reasons` names it.
 * @param {Map<string,string>} [reasons] a per-node replan reason, overriding `reason`.
 * @param {string} digest guards against a batch that changed in transit since it was computed.
 * @param {Map<string, {id,text}[]>} [approved] compile's approved copy of each node's `defines`.
 * @param {Set<string>} [owned] compile's nodes whose contract may move because its spec was approved.
 * @param {Set<string>} [accepted] compile's decisions a user-approved dropped entry may retire.
 * @returns {{ok, problems: object[], warnings: {atomicity: object[], gaps: object[], untraced: object[]}, seqs?: number[]}}
 */
export function addNodes(repo, effort, revisions, { by = 'planner', reason = '', reasons, digest = '', approved, owned, accepted } = {}) {
  if (!safeSlug(effort)) return { ok: false, problems: [{ node: '', problem: 'not an effort name: ' + JSON.stringify(effort) }] }
  const batch = (Array.isArray(revisions) ? revisions : [revisions])
  if (digest && digestEntries(batch) !== digest) {
    return { ok: false, problems: [{ node: '', problem: 'digest mismatch — the batch changed in transit; nothing was written' }] }
  }
  const normalized = batch.map(normalizeNode)
  const current = readTree(repo, effort)
  if (current.error) return { ok: false, problems: [{ node: '', problem: current.error }] }

  const merged = new Map(current.nodes)
  const ids = new Set()
  const problems = []
  for (const n of normalized) {
    if (ids.has(n.id)) problems.push({ node: n.id, problem: 'appears twice in one batch' })
    ids.add(n.id)
    if (n.retired) merged.delete(n.id)
    else merged.set(n.id, { ...n, seq: Number.MAX_SAFE_INTEGER })
  }
  problems.push(...treeProblems(merged))
  problems.push(...decisionProblems(current.nodes, merged, normalized, { by, approved, owned, accepted }))
  if (problems.length) return { ok: false, problems, warnings: { atomicity: [], gaps: [], untraced: [] } }

  const warnings = {
    atomicity: [...ids].filter((id) => merged.has(id) && merged.get(id).kind === 'leaf')
      .flatMap((id) => checkAtomicity(merged, id, { repo, status: current.status })),
    ...trace(merged, ROOT_ID),
  }

  const written = append(repo, effort, 'nodes', normalized.map((node) => ({ kind: 'node', node })))
  if (!written.ok) return { ok: false, problems: [{ node: '', problem: written.error }], warnings }
  const reasonOf = (n) => (reasons instanceof Map && reasons.get(n.id)) || reason || (n.retired ? 'retired' : 'revised')
  const events = normalized.map((n) => (current.nodes.has(n.id) || n.retired
    ? { kind: 'replanned', node: n.id, execution: '', reason: reasonOf(n), by }
    : { kind: 'planned', node: n.id, execution: '', by }))
  const logged = append(repo, effort, 'events', events)
  if (!logged.ok) return { ok: false, problems: [{ node: '', problem: 'nodes written, events refused: ' + logged.error }], warnings }
  return { ok: true, problems: [], warnings, seqs: written.seqs }
}

/** Pure. A human-readable render of a subtree with derived status, one node per line. */
export function renderTree(nodes, status, rootId = ROOT_ID) {
  const lines = []
  const walk = (id, depth) => {
    const n = nodes.get(id)
    if (!n) return
    const s = status.get(id)
    const detail = n.kind === 'leaf' ? ' [' + n.rigor + (n.role !== 'none' ? '/' + n.role : '') + ']' : n.kind === 'design' ? ' [design]' : ''
    lines.push('  '.repeat(depth) + (id === ROOT_ID ? '.' : id.split('/').pop()) + detail + ' — ' + (s ? s.status : '?') + ' — ' + n.title)
    for (const c of childrenOf(nodes, id)) walk(c, depth + 1)
  }
  walk(rootId, 0)
  return lines.join('\n')
}

// ------------------------------------------------------------------ CLI

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const argv = process.argv.slice(2)
    const [command] = argv
    const repo = flagOf(argv, 'repo') || '.'
    const effort = flagOf(argv, 'effort')

    if (command === 'show') {
      const tree = readTree(repo, effort)
      const root = flagOf(argv, 'root') || ROOT_ID
      if (argv.includes('--json')) {
        const rows = subtreeOf(tree.nodes, root).map((id) => ({ ...tree.nodes.get(id), status: tree.status.get(id).status }))
        console.log(JSON.stringify({ effort, root, nodes: rows, malformed: tree.malformed }))
      } else {
        console.log(renderTree(tree.nodes, tree.status, root) || '(no nodes)')
      }
      process.exit(0)
    }

    throw new Error('unknown command ' + JSON.stringify(command || '') + ' — expected show; only compile appends to the node log (addNodes), never this CLI')
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
