// lib/programs/converge.mjs — when a loop asks a ruler whether it converges. A count decides when to
// ask, never the answer.
//
// Design: docs/DESIGN.md#l2--states-end-work-counts-dont.

/** Pure. */
export const askAfter = (round, every = 3) => round > 0 && round % every === 0
