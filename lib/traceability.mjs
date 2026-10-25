// lib/traceability.mjs — whether every decision reaches work, and every criterion reaches a
// decision.
//
// Design: docs/DESIGN.md#traceability.
//
// Why a script. A plan that silently drops a decision passes every leaf-level gate, because each
// gate checks a leaf against its own criteria — and a decision no leaf realises has no criteria to
// fail. The only place the drop is visible is the tree as a whole, and walking a tree is
// arithmetic.

import { ROOT_ID } from './store.mjs'
import { subtreeOf, unitsOf } from './tree.mjs'

/**
 * Pure. The decision gaps and untraced criteria of the subtree under `rootId`.
 *
 * A decision is carried down level by level: whoever defines it, or lists it, must have a child
 * that lists it — until a leaf does. A group is passed through: its folder's children are the
 * tasks in it. A node with no children yet has nothing to check (its
 * decomposition has not happened), so the frontier of an unfinished plan is not a gap; only a
 * node that HAS children and hands a decision to none of them is. A folder whose plan is `open` —
 * its spec edited past its compile, to be planned again — is frontier too: its children are the
 * plan it is replacing, and its new plan is traced once it compiles.
 *
 * @param {Map<string, object>} nodes live nodes
 * @param {string} [rootId]
 * @param {{open?: (id: string) => boolean}} [opts]
 * @returns {{gaps: {decision, defined_at, at, why}[], untraced: {node, criterion}[]}}
 */
export function trace(nodes, rootId = ROOT_ID, { open = () => false } = {}) {
  const gaps = []
  const untraced = []
  const definer = new Map()
  for (const [id, n] of nodes) for (const d of n.defines) definer.set(d.id, id)

  for (const id of subtreeOf(nodes, rootId)) {
    const n = nodes.get(id)
    if (n.kind === 'leaf') {
      for (const a of n.acceptance) if (a.decisions.length === 0) untraced.push({ node: id, criterion: a.text })
      continue
    }
    if (n.kind === 'group' || open(id)) continue
    const kids = unitsOf(nodes, id)
    if (kids.length === 0) continue
    const carried = new Set([...n.defines.map((d) => d.id), ...n.decisions])
    for (const decision of carried) {
      if (kids.some((k) => nodes.get(k).decisions.includes(decision))) continue
      gaps.push({
        decision,
        defined_at: definer.get(decision) || '',
        at: id,
        why: 'no child of ' + id + ' realises it',
      })
    }
  }
  return { gaps, untraced }
}
