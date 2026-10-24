// lib/atomicity.mjs — the computable half of "when to stop splitting".
//
// Design: docs/DESIGN.md#atomicity-when-to-stop-splitting.
//
// A leaf is the recovery grain, the review grain and the parallelism grain, so the conditions
// that make a node a leaf are correctness properties. Three of the seven are arithmetic and live
// here: one rigor and one role (2), a check per criterion (4), and a fit in one executor's context
// (7). The other four — one concern (1), its own files (3), green when done (5), decided (6) — are
// judgment and stay with whoever writes the node. This file never reports them, because a
// script that claimed to check "one concern" would be a script whose silence meant nothing.

import { statSync } from 'node:fs'
import { join } from 'node:path'

import { BYTES_PER_TOKEN } from './roles.mjs'
import { ancestorsOf, entriesOverlap, parentOf } from './store.mjs'
import { isHuman } from './tree.mjs'

/** The context window each executor model is planned against, in tokens. */
const MODEL_CONTEXT = { haiku: 200000, sonnet: 200000, opus: 200000 }

/** The share of the window the brief and files may take; the rest is the executor's turns. */
const HEADROOM = 0.5

/** Tokens estimated from bytes at the first read's measured figure, so the estimate errs high. */
const tokensOf = (bytes) => Math.ceil(bytes / BYTES_PER_TOKEN)

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
 * Condition 7, computed: brief + expected files + reads against the executor model's budget.
 * A file that does not exist yet counts zero and is listed, because a leaf that creates a file
 * starts from nothing.
 */
export function fitOf(repo, leaf, { model = 'sonnet', briefBytes = BRIEF_ESTIMATE } = {}) {
  const files = [...new Set([...leaf.expects, ...leaf.reads])].map((p) => sizeOf(repo, p))
  const bytes = briefBytes + files.reduce((sum, f) => sum + f.bytes, 0)
  const budget = Math.floor((MODEL_CONTEXT[model] || MODEL_CONTEXT.sonnet) * HEADROOM)
  const tokens = tokensOf(bytes)
  return { tokens, budget, fits: tokens <= budget, model, files }
}

/** Pure. Whether a leaf expects a shared file designated by any ancestor composite. */
export function coupledOf(nodes, id) {
  const leaf = nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf') return false
  const shared = ancestorsOf(id).flatMap((a) => (nodes.get(a) ? nodes.get(a).shared : []))
  return leaf.expects.some((p) => shared.some((s) => entriesOverlap(p, s)))
}

/** A node's deps as ordering sees them: its own and every ancestor's (a group's `after` binds its
 * tasks), with a group dep standing for every task in it. */
const orderDeps = (nodes, id) => [id, ...ancestorsOf(id)]
  .flatMap((a) => (nodes.get(a) || { deps: [] }).deps)
  .flatMap((d) => ((nodes.get(d) || {}).kind === 'group' ? [...nodes.keys()].filter((k) => parentOf(k) === d) : [d]))

/**
 * Pure. Whether node `from` waits on `to` through deps: its own, its group's and every ancestor's
 * `after`, transitively, where a dep on a folder or group waits on everything beneath it, `to`
 * included when the folder holds it.
 */
function dependsOn(nodes, from, to) {
  const seen = new Set()
  const waits = (id) => {
    if (seen.has(id) || !nodes.has(id)) return false
    seen.add(id)
    const beneath = (nodes.get(id).kind === 'leaf' ? [] : [...nodes.keys()].filter((k) => parentOf(k) === id))
    return orderDeps(nodes, id).some((d) => d === to || ancestorsOf(to).includes(d) || waits(d)) || beneath.some(waits)
  }
  return waits(from)
}

/** Pure. Whether a dependency orders two leaves, either way: then they never run side by side. */
export const ordered = (nodes, a, b) => dependsOn(nodes, a, b) || dependsOn(nodes, b, a)

/**
 * The computable atomicity conditions of one leaf, as `{node, condition, detail}`.
 *
 * @param {Map<string, object>} nodes live nodes
 * @param {string} id the leaf
 * @param {{repo?: string, model?: string}} [opts] `repo` enables the fit check.
 */
export function checkAtomicity(nodes, id, { repo = '', model = '' } = {}) {
  const leaf = nodes.get(id)
  if (!leaf || leaf.kind !== 'leaf') return []
  const out = []
  const at = (condition, detail) => out.push({ node: id, condition, detail })

  const cycle = leaf.rigor === 'tdd-pair' ? ['red', 'green'] : leaf.rigor === 'tdd-triad' ? ['red', 'green', 'audit'] : ['none']
  if (!cycle.includes(leaf.role)) at(2, 'rigor ' + leaf.rigor + ' with role ' + leaf.role + ' is not one rigor and one role')

  for (const a of leaf.acceptance) {
    if (!isHuman(a) && a.check.trim() === '') at(4, 'criterion "' + a.text + '" names no check')
  }

  if (repo) {
    const producer = (leaf.dispatch.producer && leaf.dispatch.producer.model) || model || 'sonnet'
    const fit = fitOf(repo, leaf, { model: producer })
    if (!fit.fits) at(7, 'brief + expected files + reads is ~' + fit.tokens + ' tokens against a ' + fit.budget + '-token budget on ' + producer)
  }
  return out
}
