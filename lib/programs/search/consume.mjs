// lib/programs/search/consume.mjs — what a search's result means to a program: its coverage lines,
// whether it ended complete, its dollar cap, and the tree, config and guidance a program pins.
//
// Design: docs/DESIGN.md#searches.

import { guidanceOf } from '../../brief.mjs'
import { treeOf } from '../../search/pin.mjs'
import { readConfig } from '../../store.mjs'

/** The tree a program reads, its config, and the guidance of that tree. */
export function pinnedOf(ctx, args) {
  const tree = args.tree || treeOf(ctx.root)
  const config = readConfig(ctx.repo)
  return { tree, config, guidance: guidanceOf(tree.root, { dirs: args.roots, config }) }
}

const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's')

const roundsPart = (c) => (c ? ', ' + plural(c.rounds, 'round') + ' (the last added ' + c.last_added + ')' : '')
const scoutPart = (c) => (c?.skipped?.trim() ? "; the scout's own word: " + c.skipped.trim().replace(/\s+/g, ' ') : '')

/** Pure. A search's coverage line: its name, status, counts of calls, hits and rounds, why, and the scout's own word. */
export const coverageLine = (r) => r.name + ': ' + r.status + ', ' + plural(r.calls.length, 'call') + ', ' +
  (r.hits.length ? plural(r.hits.length, 'hit') : 'no hits') + roundsPart(r.coverage) + (r.why ? ': ' + r.why : '') + scoutPart(r.coverage)

/** Pure. Whether a search ended complete: its scout returned, with or without a stall. */
export const searchComplete = (r) => r.status === 'done' || r.status === 'stalled'

/** Pure. Searches' coverage: a complete one's line declared; a budget one incomplete, a failed one a failed channel, each with its line unreached. */
export function searchCoverage(results) {
  const out = { declared: [], incomplete: [], failed_channels: [], unreached: [] }
  for (const r of results.filter(Boolean)) {
    if (searchComplete(r)) { out.declared.push(coverageLine(r)); continue }
    (r.status === 'budget' ? out.incomplete : out.failed_channels).push(r.name)
    out.unreached.push(coverageLine(r))
  }
  return out
}

/** Pure. The per-search dollar cap a program run was given, or null for none. */
export const budgetOf = (args) => (typeof args.search_budget === 'number' && args.search_budget > 0 ? args.search_budget : null)
