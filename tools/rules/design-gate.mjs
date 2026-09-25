// tools/rules/design-gate.mjs — pins the clauses that make a gated skill a gate.
//
// Two skills in this plugin end by moving something the user owns, and each carries a small
// number of sentences that are the whole of that contract. All of them are the kind of thing
// an edit softens without meaning to, and none of them fails loudly when it goes: the skill
// still reads well, still runs, and has quietly stopped doing the one thing it existed for.
//
// A MAP rather than one list, keyed by file. When this rule was written it was scoped to
// `skills/design/SKILL.md` alone, and its own header said so: "widening this rule is a
// decision to make when a second gated skill exists, not before." The programme skill is that
// second skill, and it settles the question the same way — by widening the shape rather than
// by generalising the clauses. Most skills have no terminal handoff and no gate; asking every
// SKILL.md for one would be noise, and a rule that produces noise gets ignored wholesale.
//
// The clause sets are DIFFERENT on purpose, and the difference is the interesting part. The
// design skill has a HARD GATE because ratification is a human act at a moment where a wrong
// shape still costs one paragraph. The programme skill has none, because the programme design
// abolishes per-leaf ratification outright: authorization there flows from
// the plan artifact existing at all, and that artifact can only come into being through a
// session with the user. Forcing design's clauses onto it would pin a ceremony the design
// deliberately removed — which is to say the rule would enforce a bug.
//
// DECIDABLE HALF ONLY, deliberately — the same split `tools/rules/task-tool-fallback.mjs`
// and `tools/rules/coverage-block.mjs` make. This rule checks that each clause is NAMED. It
// cannot check that the surrounding prose still means it; that is review's half, and a rule
// pretending otherwise would be the laundering the IRON LAW forbids.
//
// Known limit, accepted: each check is satisfied by the token appearing anywhere, including
// inside a sentence that rules it out ("this skill has no HARD GATE"). Naming the clause is
// the half a regex can decide; meaning it is review's.
//
// Turn caps are NOT checked here — `tools/rules/no-turn-caps.mjs` already covers every
// SKILL.md in the plugin, and a second rule saying the same thing would report every
// violation twice.

export const id = 'design-gate'

export const applies = /^skills\/(design|programme|find-existing-solutions)\/SKILL\.md$/

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

const PROGRAMME_CLAUSES = [
  {
    // Tolerant of inflection and of case. A rule that fails on "merges" rather than "merge",
    // or on a sentence that happens to open a paragraph, is a rule people phrase around — and
    // phrasing around a rule costs more than the rule ever caught.
    pattern: /\bmerges?\s+the\s+programme\s+branch\b/i,
    message:
      `The programme skill never names the act that ends a programme. Slices accumulate on a ` +
      `branch this layer owns, and if nothing says "merge the programme branch" the work ` +
      `never reaches the user at all — a programme that reports itself complete while every ` +
      `deliverable sits on a branch nobody asked about.`,
  },
  {
    // Case-insensitive: the sentence naturally opens a paragraph, and a rule that fires on a
    // capital letter teaches people to phrase around it rather than to mean it.
    pattern: /the user's checkout is untouched/i,
    message:
      `The programme skill does not state that the user's checkout is untouched. That is the ` +
      `invariant the whole branch-and-worktree arrangement exists to hold — the layer runs ` +
      `for days across many runs, and the moment it is unstated, one slice's convenience ` +
      `merge lands in the tree the user is sitting in.`,
  },
  // Deliberately NOT here: HARD GATE. The programme design abolished per-leaf ratification —
  // authorization flows from the plan artifact existing, and a leaf is dispatchable when the
  // plan exists and its markers are present. A rule demanding a gate here would pin a
  // ceremony the design removed on purpose.
]

// A third skill whose whole purpose is one sentence. It does not end by moving something the
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
  'skills/programme/SKILL.md': PROGRAMME_CLAUSES,
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
