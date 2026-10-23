// lib/contention.mjs — where two folders' work meets before either has merged: the facts merge-batch
// hands the judge for a unit about to merge, and the rulings that order or clear them.
//
// Design: docs/DESIGN.md#the-judge.
//
// Inside one folder merge-batch already serializes: a later unit merges on top of an earlier one and
// the fast suite measures the combination. Two folders meet only when both have merged up to where
// their branches join, as a composite conflict no producer can resolve, so that is what a fact is
// about: a path a unit changed that a leaf of another folder changed too (`overlap`), or expects to
// change (`folder`), while that leaf's work has not reached where the two meet.

import { ordered } from './atomicity.mjs'
import { ancestorsOf, inPaths } from './store.mjs'
import { cycleOf, ownerOf } from './tree.mjs'

const list = (v) => (Array.isArray(v) ? v : [])
const latest = (entries, pred) => entries.reduce((found, e) => (pred(e) && (!found || e.seq > found.seq) ? e : found), null)

/**
 * Pure. Whether `other`'s work has merged where it meets `id`'s: its ancestor just below their
 * lowest common ancestor, groups passed over (they have no branch), has merged.
 */
export function mergedWhereTheyMeet({ nodes, status }, id, other) {
  const kindOf = (x) => (nodes.get(x) || {}).kind
  const up = [id, ...ancestorsOf(id).filter((a) => kindOf(a) !== 'group')]
  const chain = [other, ...ancestorsOf(other).filter((a) => kindOf(a) !== 'group')]
  const at = chain.indexOf(up.find((x) => chain.includes(x)))
  return at > 0 && ['merged', 'landed'].includes((status.get(chain[at - 1]) || {}).status)
}

/** Pure. The `judged` event of `id` at `head` for `trigger`, or null. */
export const judgedAt = (events, id, trigger, head) =>
  latest(list(events), (e) => e.kind === 'judged' && e.node === id && e.trigger === trigger && e.head_sha === head)

/**
 * Pure. The leaves a standing serialize ruling makes `id` wait on: those of its latest contention
 * ruling, at the head it was approved at, while that ruling says serialize.
 */
export function waitsOn(events, id, head) {
  const j = judgedAt(events, id, 'contention', head)
  return j && j.outcome === 'serialize' ? list(j.after) : []
}

/** Pure. Whether a standing serialize ruling orders `a` and `b`, either way. */
const serialized = (events, a, b) => list(events).some((e) => e.kind === 'judged' && e.outcome === 'serialize' &&
  ((e.node === a && list(e.after).includes(b)) || (e.node === b && list(e.after).includes(a))))

/**
 * Pure. The contention facts of merge unit `id` (a leaf outside a cycle, or a cycle by its last
 * member) at `head`, `{node, kind, paths}` per other leaf: against every leaf of another folder,
 * outside the unit's cycle, that no dependency or standing serialize ruling orders with it and whose
 * work has not merged where the two meet. A path that leaf's own net diff holds is an `overlap`;
 * one it only expects is `folder`. A fact a `resolve` ruling of this unit covers is none: one at the
 * same unit head whose `heads` gave the other leaf the head it has now and whose facts name the path.
 *
 * @param {{nodes: Map, status: Map, events: object[]}} tree
 * @param {string} id
 * @param {{head: string, net: string[], netOf: (id: string) => string[], headOf: (id: string) => string}} reads
 */
export function contentionOf(tree, id, { head, net, netOf, headOf }) {
  const { nodes, events } = tree
  const cycle = cycleOf(nodes, id)
  const folder = ownerOf(nodes, cycle[0] || id)
  const ruled = judgedAt(events, id, 'contention', head)
  const covered = (other, path) => Boolean(ruled) && ruled.outcome === 'resolve' &&
    (ruled.heads || {})[other] === headOf(other) &&
    list(ruled.facts).some((f) => f.node === other && list(f.paths).includes(path))
  const out = []
  for (const other of nodes.values()) {
    const o = other.id
    if (other.kind !== 'leaf' || o === id || cycle.includes(o) || ownerOf(nodes, o) === folder) continue
    if (ordered(nodes, id, o) || serialized(events, id, o) || mergedWhereTheyMeet(tree, id, o)) continue
    const theirs = new Set(netOf(o))
    const overlap = net.filter((p) => theirs.has(p) && !covered(o, p))
    const expected = net.filter((p) => !theirs.has(p) && inPaths(other.expects, p) && !covered(o, p))
    if (overlap.length) out.push({ node: o, kind: 'overlap', paths: overlap })
    if (expected.length) out.push({ node: o, kind: 'folder', paths: expected })
  }
  return out
}

/**
 * Pure. What one contention or conflict ruling decides, from the ruler's per-unit rulings: any unit
 * unruled or `cant_rule` reaches the user; else any `replan` replans; else any admissible `serialize`
 * makes the unit wait; else it is resolved. A unit may wait only on a leaf first dispatched before it
 * (`firstOf`), so waits never form a cycle: a serialize against a later leaf reads as resolve, and that
 * leaf's own merge meets this unit. A conflict's one unit is `integration`, and serialize reads as
 * resolve there: what it conflicts with has already merged.
 *
 * @param {{trigger: 'contention'|'conflict', units: string[], rulings: {unit: string, ruling: string, why: string}[],
 *   firstOf?: (id: string) => number, id: string}} args
 * @returns {{outcome: 'cant_rule'|'replan'|'serialize'|'resolve', after: string[], why: string}}
 */
export function combineRulings({ trigger, id, units, rulings, firstOf = () => 0 }) {
  const by = new Map(list(rulings).filter((r) => r && typeof r.unit === 'string').map((r) => [r.unit, r]))
  const whys = (pred) => units.filter((u) => pred(by.get(u))).map((u) => u + ': ' + String((by.get(u) || {}).why || 'left unruled')).join('; ')
  const unruled = (r) => !r || !['serialize', 'resolve', 'replan'].includes(r.ruling)
  if (units.some((u) => unruled(by.get(u)))) return { outcome: 'cant_rule', after: [], why: whys(unruled) }
  const replan = (r) => r.ruling === 'replan'
  if (units.some((u) => replan(by.get(u)))) return { outcome: 'replan', after: [], why: whys(replan) }
  const after = trigger === 'contention'
    ? units.filter((u) => by.get(u).ruling === 'serialize' && firstOf(u) < firstOf(id))
    : []
  if (after.length) return { outcome: 'serialize', after, why: whys((r) => r.ruling === 'serialize') }
  return { outcome: 'resolve', after: [], why: whys(() => true) }
}
