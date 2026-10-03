// lib/programs/common.mjs — what every program shares when it dispatches: a judge never rules on
// its own work.
//
// Design: docs/DESIGN.md#l3--separate-judges.

/** Pure. A judge never rules on what its own session or thread produced. */
export const judgeAllowed = ({ producer, judge }) => judge.session !== producer.session && judge.thread !== producer.thread

/** Refuse a judge dispatch on its own work, else run it. */
export async function dispatchJudge({ producer, judge, run }) {
  if (!judgeAllowed({ producer, judge })) {
    return { status: 'failed', error: { kind: 'self_judging', message: 'a judge may not rule on the work of ' + producer.thread } }
  }
  return run()
}
