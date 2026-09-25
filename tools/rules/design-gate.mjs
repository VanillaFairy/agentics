// tools/rules/design-gate.mjs — pins the clauses that make a gated skill a gate.
//
// Two skills in this plugin carry a small number of sentences that are the whole of their
// contract: design, which ends by handing a ratified design to develop, and
// find-existing-solutions, whose one output is whether to build at all. All of them are the kind
// of thing an edit softens without meaning to, and none fails loudly when it goes: the skill still
// reads well, still runs, and has quietly stopped doing the one thing it existed for.
//
// A MAP rather than one list, keyed by file: most skills have no terminal handoff and no gate,
// and asking every SKILL.md for one would be noise that gets ignored wholesale.
//
// DECIDABLE HALF ONLY, deliberately — the same split `tools/rules/task-tool-fallback.mjs`
// and `tools/rules/coverage-block.mjs` make. This rule checks that each clause is NAMED. It
// cannot check that the surrounding prose still means it; that is review's half, and a rule
// pretending otherwise would be the laundering IL2 forbids.
//
// Known limit, accepted: each check is satisfied by the token appearing anywhere, including
// inside a sentence that rules it out ("this skill has no HARD GATE"). Naming the clause is
// the half a regex can decide; meaning it is review's.
//
// Turn caps are NOT checked here — `tools/rules/no-turn-caps.mjs` already covers every
// SKILL.md in the plugin, and a second rule saying the same thing would report every
// violation twice.

export const id = 'design-gate'

export const applies = /^skills\/(design|find-existing-solutions)\/SKILL\.md$/

const DESIGN_CLAUSES = [
  {
    pattern: /\bagentics:develop\b/,
    message:
      `The design skill never names its terminal handoff. A design phase that does not end ` +
      `by invoking "agentics:develop" produces a document and stops: the ratified change ` +
      `it exists to create is never implemented by the pipeline it was written for.`,
  },
  {
    pattern: /\bHARD GATE\b/,
    message:
      `The design skill has no marked HARD GATE. Ratification is a human act, and the point ` +
      `in the pipeline where a wrong shape still costs one paragraph instead of a fix round ` +
      `is exactly here. Unmarked, it erodes into "the design looks settled, let's start".`,
  },
  {
    pattern: /does not hand off/,
    message:
      `The design skill does not state that a design with an open "blocking" question does ` +
      `not hand off. That is the one machine-consequential rule in the interview: every ` +
      `other grade is bookkeeping, and without this sentence an unanswered blocking question ` +
      `reaches the planner as a blocking gap instead — one survey and one planning pass later.`,
  },
  {
    // Tolerant of case: the phrase heads a section, and a rule that fires on a capital letter
    // teaches people to phrase around it rather than to mean it.
    pattern: /\bwhere\s+the\s+build\s+runs\b/i,
    message:
      `The design skill hands off without asking where the build runs. Chaining straight ` +
      `into develop is the reading an edit falls into, and it is the expensive one: the ` +
      `build then inherits the whole design conversation — interview, survey returns, every ` +
      `probe round — and re-reads it on every turn of a run that lasts hours, for context ` +
      `that stopped being load bearing the moment the document was written. The document is ` +
      `the product of this pass, so a fresh session loses nothing; only the user knows which ` +
      `they want, which is why this is a question and not a default.`,
  },
]

// A skill whose whole purpose is one sentence. It does not end by moving something the
// user owns — it ends by telling them whether to build — but the failure shape is the same:
// soften the sentence and the skill still reads well, still runs, and has stopped doing the
// one thing it existed for. The cost is not a fix round; it is weeks spent building what was
// already on a registry.
const EXISTING_SOLUTIONS_CLAUSES = [
  {
    pattern: /coverage\.complete/,
    message:
      `The find-existing-solutions skill never ties its verdict to coverage.complete. The ` +
      `binding rule is that "nothing exists, build it" may not be reported while the sweep ` +
      `is incomplete — without it, a search nobody finished reads exactly like a search that ` +
      `found nothing, which is the one conclusion this skill exists to make safe.`,
  },
  {
    // Tolerant of how the pair gets phrased; what must survive is the distinction itself.
    pattern: /never reached/i,
    message:
      `The find-existing-solutions skill does not separate "searched and found nothing" from ` +
      `"never reached". The first is evidence FOR building and the second is evidence of ` +
      `nothing at all, and a reader who cannot tell them apart will treat an unfinished sweep ` +
      `as a licence to start.`,
  },
]

const CLAUSES = {
  'skills/design/SKILL.md': DESIGN_CLAUSES,
  'skills/find-existing-solutions/SKILL.md': EXISTING_SOLUTIONS_CLAUSES,
}

/**
 * Pure. No filesystem, no other rules, no globals.
 * @param {string} source   full file text
 * @param {string} filePath POSIX-style repo-relative path
 * @returns {Violation[]}   empty array when clean
 */
export function check(source, filePath) {
  return (CLAUSES[filePath] || [])
    .filter((clause) => !clause.pattern.test(source))
    .map((clause) => ({ line: 0, message: clause.message }))
}
