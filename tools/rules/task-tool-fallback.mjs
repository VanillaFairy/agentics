// tools/rules/task-tool-fallback.mjs — IL2 support rule, applied to skills.
//
// The Task tools (`TaskCreate` / `TaskList` / `TaskUpdate`) are host-provided and OPTIONAL.
// Some hosts do not expose them at all — the VS Code extension is the one you will actually
// hit — and a skill cannot detect that until the call is already failing.
//
// A skill that routes its result through them with no stated fallback degrades in the one way
// this plugin exists to prevent. The session improvises, most likely into `TodoWrite`, which
// has no dependency edges: `blocked_by` is silently dropped, and a task list that lost its
// ordering looks exactly like one that never had any. The user is handed a partial result
// wearing the shape of a whole one, with nothing saying so — IL2.
//
// So: name the fallback in the skill, or do not depend on the tool. What the fallback must
// actually do is written where it belongs, in the skill itself — carry the graph in the list
// (emit in `blocked_by` order, open dependent descriptions with "After <subject>: …") and say
// out loud that you fell back.
//
// DECIDABLE HALF ONLY, deliberately, and the same split `tools/rules/coverage-block.mjs`
// makes: that rule checks for a coverage KEY and leaves the block's substance to the scenario
// harness. This one checks that a fallback is NAMED and leaves its adequacy to review. Whether
// the prose actually preserves the ordering, and actually announces the degradation, is not
// decidable by regex — and a rule that pretended otherwise would be the laundering it exists
// to catch.
//
// Known limits, both accepted:
//   - False positive: a skill naming a Task tool only to rule it out ("this is not a
//     TaskCreate job") is still asked for the fallback token. Cheap to satisfy, and the
//     alternative is parsing intent.
//   - Vacuous pass: the word `TodoWrite` anywhere in the file satisfies the check, including
//     inside an unrelated sentence. Same trade as above — naming the fallback is the half a
//     regex can decide; meaning it is review's half.

/** Stable rule id. MUST equal the filename without extension. */
export const id = 'task-tool-fallback'

/**
 * RegExp tested against the POSIX-style repo-relative path.
 *
 * Skills only. Agents in this plugin are read-only and never land a result, and workflow
 * scripts cannot call host tools at all — their whole surface is agent/pipeline/parallel.
 * The landing step is a skill's job, so the skill is where the fallback has to be written.
 */
export const applies = /SKILL\.md$/

/** The host-optional tools, and the fallback every dependent skill must name. */
const TASK_TOOLS = /\bTask(?:Create|List|Update)\b/g
const FALLBACK = /\bTodoWrite\b/

/**
 * Pure. No filesystem, no other rules, no globals.
 * @param {string} source   full file text
 * @param {string} filePath POSIX-style repo-relative path
 * @returns {Violation[]}   empty array when clean
 */
export function check(source, filePath) {
  if (FALLBACK.test(source)) return []

  // matchAll clones its argument, so the shared /g regex above carries no lastIndex between
  // calls and `check` stays stateless.
  const first = [...source.matchAll(TASK_TOOLS)][0]
  if (!first) return []

  return [{
    line: source.slice(0, first.index).split('\n').length,
    message:
      `This skill routes its result through the host's Task tools ("${first[0]}") but names ` +
      `no fallback for a host that does not expose them. Say what to do instead — fall back ` +
      `to TodoWrite, carry the blocked_by graph in the list itself, and state that you fell ` +
      `back. IL2: a task list that silently lost its dependency edges is ` +
      `indistinguishable from one that never had any.`,
  }]
}
