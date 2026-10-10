// lib/atomicity.mjs — the computable half of "when to stop splitting".
//
// Design: docs/DESIGN.md#atomicity-when-to-stop-splitting.
//
// A leaf is the recovery grain, the review grain and the parallelism grain, so the conditions
// that make a node a leaf are correctness properties. Four of the seven are arithmetic and live
// here: one rigor and one role (2), a closed locus (3), a check per criterion (4), and a fit in
// one executor's context (7). The other three — one concern (1), green when done (5), decided (6)
// — are judgment and stay with whoever writes the node. This file never reports them, because a
// script that claimed to check "one concern" would be a script whose silence meant nothing.

import { statSync } from 'node:fs'
import { join } from 'node:path'

import { ancestorsOf, entriesOverlap, parentOf } from './store.mjs'
import { isHuman } from './tree.mjs'

/** The context window each executor model is planned against, in tokens. */
const MODEL_CONTEXT = { haiku: 200000, sonnet: 200000, opus: 200000 }

/** The share of the window the brief and files may take; the rest is the executor's turns. */
const HEADROOM = 0.5

/** Tokens estimated from bytes — deliberately pessimistic for code. */
const tokensOf = (bytes) => Math.ceil(bytes / 3.5)

/** The default brief size assumed before a brief exists. */
const BRIEF_ESTIMATE = 12000

const sizeOf = (repo, path) => {
  try {
    return { path, bytes: statSync(join(repo, path)).size, missing: false }
  } catch {
    return { path, bytes: 0, missing: true }
  }
}

/**
 * Condition 7, computed: brief + locus files + reads against the executor model's budget.
 * A file that does not exist yet counts zero and is listed, because a leaf that creates a file
 * starts from nothing.
 */
export function fitOf(repo, leaf, { model = 'sonnet', briefBytes = BRIEF_ESTIMATE } = {}) {
  const files = [...new Set([...leaf.locus, ...leaf.reads])].map((p) => sizeOf(repo, p))
  const bytes = briefBytes + files.reduce((sum, f) => sum + f.bytes, 0)
  const budget = Math.floor((MODEL_CONTEXT[model] || MODEL_CONTEXT.sonnet) * HEADROOM)
  const tokens = tokensOf(bytes)
  return { tokens, budget, fits: tokens <= budget, model, files }
}

/** Pure. Whether a leaf's locus meets a shared file designated by any ancestor composite. */
export function coupledOf(nodes, id) {
  const leaf = nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf') return false
  const shared = ancestorsOf(id).flatMap((a) => (nodes.get(a) ? nodes.get(a).shared : []))
  return leaf.locus.some((p) => shared.some((s) => entriesOverlap(p, s)))
}

/** A node's deps as ordering sees them: its own and every ancestor's (a group's `after` binds its
 * tasks), with a group dep standing for every task in it. */
const orderDeps = (nodes, id) => [id, ...ancestorsOf(id)]
  .flatMap((a) => (nodes.get(a) || { deps: [] }).deps)
  .flatMap((d) => ((nodes.get(d) || {}).kind === 'group' ? [...nodes.keys()].filter((k) => parentOf(k) === d) : [d]))

/** Pure. Whether `from` reaches `to` through deps. */
function reaches(nodes, from, to, seen = new Set()) {
  if (from === to) return true
  if (seen.has(from)) return false
  seen.add(from)
  return nodes.has(from) && orderDeps(nodes, from).some((d) => reaches(nodes, d, to, seen))
}

/**
 * Pure. Whether two leaves may not share a file (condition 3): no dependency orders them, so they
 * may run side by side, and they are not both in the coupled lane, which runs one at a time.
 */
function contend(nodes, a, b) {
  if (reaches(nodes, a, b) || reaches(nodes, b, a)) return false
  return !(coupledOf(nodes, a) && coupledOf(nodes, b))
}

/**
 * Pure. The locus entries held against leaf `id`: those of every other leaf not yet merged that
 * contends with it. A file a leaf ordered before or after `id` also lists stays `id`'s own.
 */
export function heldAgainst(nodes, status, id) {
  const merged = (other) => ((status && status.get(other)) || {}).status === 'merged'
  return [...new Set([...nodes.values()]
    .filter((n) => n.kind === 'leaf' && n.id !== id && !merged(n.id) && contend(nodes, id, n.id))
    .flatMap((n) => n.locus))]
}

/**
 * The computable atomicity conditions of one leaf, as `{node, condition, detail}`.
 *
 * @param {Map<string, object>} nodes live nodes
 * @param {string} id the leaf
 * @param {{repo?: string, status?: Map, model?: string}} [opts] `status` lets merged leaves
 *   release their files; `repo` enables the fit check.
 */
export function checkAtomicity(nodes, id, { repo = '', status = new Map(), model = '' } = {}) {
  const leaf = nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf') return []
  const out = []
  const at = (condition, detail) => out.push({ node: id, condition, detail })

  const cycle = leaf.rigor === 'tdd-pair' ? ['red', 'green'] : leaf.rigor === 'tdd-triad' ? ['red', 'green', 'audit'] : ['none']
  if (!cycle.includes(leaf.role)) at(2, 'rigor ' + leaf.rigor + ' with role ' + leaf.role + ' is not one rigor and one role')

  for (const [other, n] of nodes) {
    if (other === id || n.kind !== 'leaf') continue
    const s = status.get(other)
    if (s && s.status === 'merged') continue
    const overlap = leaf.locus.filter((p) => n.locus.some((q) => entriesOverlap(p, q)))
    if (overlap.length === 0 || !contend(nodes, id, other)) continue
    at(3, 'shares ' + overlap.join(', ') + ' with unmerged leaf ' + other + ' and no dependency orders them')
  }

  for (const a of leaf.acceptance) {
    if (!isHuman(a) && a.check.trim() === '') at(4, 'criterion "' + a.text + '" names no check')
  }

  if (repo) {
    const producer = (leaf.dispatch.producer && leaf.dispatch.producer.model) || model || 'sonnet'
    const fit = fitOf(repo, leaf, { model: producer })
    if (!fit.fits) at(7, 'brief + locus + reads is ~' + fit.tokens + ' tokens against a ' + fit.budget + '-token budget on ' + producer)
  }
  return out
}
