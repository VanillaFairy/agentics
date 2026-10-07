// tools/rules/no-turn-caps.mjs — enforces IL1.
//
// "Completion is defined by the goal, never by a counter." An agent capped at N turns
// stops mid-task and reports what it has, and that report is indistinguishable from a
// finished one.
//
// Deliberately NOT flagged, because both ship in this plugin and are correct:
//   - "around N tool calls, check whether you are converging" -> a self-check, not a stop
//   - "at most 12 tasks" -> a content bound, not an effort cap
//
// `rounds` is caught alongside turns and tool calls: a round counter on a resume loop ends a
// search undersurveyed while lint stays green, and every later stage is built on the hole. The
// loops are progress-gated instead.

export const id = 'no-turn-caps'

// Agent definitions are in scope too: CLAUDE.md's enforcement table assigns IL1 to this rule,
// and a turn cap written into an agent's own definition is
// the most damaging place one can appear — every dispatch of that agent inherits it. So are the
// programs and lib/run.mjs, which start every dispatch (docs/DESIGN.md#self-checks).
export const applies = /(\.workflow\.js|SKILL\.md|agents\/[^/]+\.md|^lib\/programs\/(execute\/)?[^/]+\.mjs|^lib\/run\.mjs)$/

/** Option-shaped caps, `rounds` among them — see the header. */
const CAP_IDENTIFIER = /\bmax_?(turns|tool_?calls|rounds)\b/gi

/** A stop verb bound to a countable EFFORT unit. Content units are not effort. */
const CAP_PROSE = /\b(?:stop|halt|give up|abort)\s+(?:after|at)\s+\d+\s+(?:tool\s*calls?|turns?|iterations?)\b/gi

/**
 * "budget" offered as a stop reason — in a stop_reason enum or in a prompt instructing an
 * agent to set it. A field survey stopped partway because its prompt said to stop at about
 * 40 hits and call the truncation "budget"; the fix renamed the honest state to
 * "unfinished" (a partial the caller resumes) and this pattern keeps the cost-framed stop
 * from coming back. Effort spent is never a reason to stop (IL1); only "exhausted" and
 * "stuck" describe the search itself.
 */
const BUDGET_STOP = /\bstop_reason\b[^\n]{0,60}?["']budget["']/gi

export function check(source) {
  const violations = []

  source.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(CAP_IDENTIFIER)) {
      violations.push({
        line: index + 1,
        message:
          `"${match[0]}" caps an agent by effort. IL1: completion is defined by ` +
          `the goal, never by a counter. Budgets may trigger escalation; they may not ` +
          `declare done.`,
      })
    }

    for (const match of text.matchAll(CAP_PROSE)) {
      violations.push({
        line: index + 1,
        message:
          `"${match[0].trim()}" instructs an agent to stop on a counter. IL1 ` +
          `forbids counter-based termination. Say what "done" means instead.`,
      })
    }

    for (const match of text.matchAll(BUDGET_STOP)) {
      violations.push({
        line: index + 1,
        message:
          `"${match[0].trim()}" offers "budget" as a stop reason. IL1: effort ` +
          `spent is never a reason to stop. An honest partial is "unfinished" and gets ` +
          `resumed; the only reasons a search itself ends are "exhausted" and "stuck".`,
      })
    }
  })

  return violations
}
