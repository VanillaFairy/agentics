// test/harness/seed-tree.mjs — put a tree on disk the way compile does: `by: 'compile'`, with each
// node's `defines` admitted against an approved copy equal to itself. For tests that need a tree
// and are not about the decision guard.

import { addNodes } from '../../lib/tree.mjs'

export function seedTree(repo, effort, nodes, opts = {}) {
  const approved = new Map(nodes.filter((n) => Array.isArray(n.defines) && n.defines.length > 0).map((n) => [n.id, n.defines]))
  return addNodes(repo, effort, nodes, { by: 'compile', approved, ...opts })
}
