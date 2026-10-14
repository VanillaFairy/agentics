// lib/search/pin.mjs — the tree a search runs over: a standalone program's root at its HEAD.
//
// Design: docs/DESIGN.md#evidence.

import { resolve } from 'node:path'

import { posix, revParse } from '../store.mjs'

/** The tree of a standalone program: `root`, absolute with posix separators, at its HEAD. */
export function treeOf(root) {
  return { root: posix(resolve(root)), sha: revParse(root, 'HEAD') }
}
