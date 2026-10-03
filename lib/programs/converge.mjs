// lib/programs/converge.mjs — when a loop asks a ruler whether it converges. A count decides when to
// ask, never the answer.
//
// Design: docs/DESIGN.md#l2--states-end-work-counts-dont.

/** Pure. */
export const askAfter = (round, every = 3) => round > 0 && round % every === 0

/** Pure. The brief a convergence ruler reads: each round and what it left open. */
export function convergenceBrief(rounds) {
  return 'A loop has run ' + rounds.length + ' rounds without approval. Rule whether it is converging.\n\n' +
    rounds.map((r) => '## Round ' + r.round + '\n' + (r.open.length ? r.open.map((f) => '- [' + f.id + '] ' + f.claim).join('\n') : '- nothing open')).join('\n\n')
}
