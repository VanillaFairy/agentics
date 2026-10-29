// lib/review-delta.mjs — what a review owes: the one delta over a judge's earlier per-unit rulings.
// A unit's ruling stands while what it was ruled on, its anchor, stands; every review — a leaf's,
// a folder's integration review, a probe's — is the rulings that stand plus the units it rules.
//
// Design: docs/DESIGN.md#review-delta.

import { canonical, fnv1a } from './plan-digest.mjs'

const list = (v) => (Array.isArray(v) ? v : [])

/** Pure. An anchor over what a unit stands on, given as any JSON value: the same value, the same anchor. */
export const anchorOf = (value) => fnv1a(canonical(value))

/** Pure. A changed file as a unit, `file:<path>`, anchored to its blob at the head under review: `deleted` where the head holds none. */
export const fileUnits = (paths, blobs) => list(paths).map((p) => ({ unit: 'file:' + p, anchor: blobs.get(p) || 'deleted' }))

/**
 * Pure. The delta of a review: `prior`, the rulings that stand from earlier reviews, each keyed by
 * its `unit` and the `anchor` it was ruled at, against `current`, the units under review now with
 * their anchors. A prior ruling of a current unit at the same anchor stands, carried whole; a
 * current unit with none is ruled, `was` the prior ruling at another anchor or null; a prior
 * ruling of a unit no longer current is gone. A whole review is the empty prior. The caller hands
 * in only rulings that may stand: one that left the unit open is no prior, so its unit is ruled.
 *
 * @template {{unit: string, anchor: string}} P
 * @param {P[]} prior
 * @param {{unit: string, anchor: string}[]} current
 * @returns {{stand: P[], rule: {unit: string, anchor: string, was: P|null}[], gone: P[]}}
 */
export function reviewDelta(prior, current) {
  const before = new Map(list(prior).map((p) => [p.unit, p]))
  const now = new Map()
  for (const c of list(current)) if (!now.has(c.unit)) now.set(c.unit, c)
  const stand = []
  const rule = []
  for (const c of now.values()) {
    const p = before.get(c.unit) || null
    if (p && p.anchor === c.anchor) stand.push(p)
    else rule.push({ unit: c.unit, anchor: c.anchor, was: p })
  }
  return { stand, rule, gone: [...before.values()].filter((p) => !now.has(p.unit)) }
}
