// lib/programs/converge.mjs — when a loop asks a ruler whether it converges. A count decides when to
// ask, never the answer.
//
// Design: docs/DESIGN.md#l2--states-end-work-counts-dont.

/** Pure. */
export const askAfter = (round, every = 3) => round > 0 && round % every === 0

/**
 * Pure. The round whose outcome a leaf's convergence ruler rules before the last round of `loop`
 * (`producerLoop` in lib/boundaries/loop-guard.mjs) opens — the round that one answers — or 0:
 * after every third round sent back, and at once when the last send-back repeated a lossy state of
 * an earlier one.
 */
export function rulingDue(loop) {
  const last = loop[loop.length - 1]
  if (!last) return 0
  return askAfter(loop.length) || last.messages.some((m) => m.guard && m.guard.ask) ? last.round - 1 : 0
}
