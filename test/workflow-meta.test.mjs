// test/workflow-meta.test.mjs — pins the workflow-meta rule against the two silent failures it
// exists to prevent.
//
// An unprefixed workflow name collides in the workflow namespace, which is flat and global across
// every installed plugin. And a `phase('X')` call with no matching `meta.phases` entry silently
// gets its own ungrouped box in the progress display — nothing throws, the display is just
// quietly wrong. Neither failure shows up in a test run, so the rule is the only thing catching
// them.
//
// The fixtures below are deliberately shaped like the workflow scripts this plugin actually
// ships: `meta.phases` spans many lines, both quote styles appear, and phase titles turn up in
// comments and in unrelated object literals. A rule that scans line by line, scans the whole file
// instead of the `meta` literal, or forgets to blank comments will pass a lazy suite and fail in
// production. Every fixture carries its line numbers in trailing comments, because the line a
// violation reports is half the contract.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { id, applies, check } from '../tools/rules/workflow-meta.mjs'

/** A realistic POSIX-style repo-relative path, as `lint.mjs` hands one to a rule. */
const WF = 'workflows/agentics-survey.workflow.js'

/** Build fixture source from one line per argument, so line N is argument N. */
const src = (...lines) => lines.join('\n')

/** The single violation reported, asserting there is exactly one. */
function onlyViolation(violations) {
  assert.equal(
    violations.length,
    1,
    `expected exactly one violation, got ${JSON.stringify(violations)}`,
  )
  return violations[0]
}

// --- the rule contract -----------------------------------------------------------

test('applies to workflow scripts', () => {
  assert.equal(applies.test(WF), true)
})

test('applies to nothing but workflow scripts', () => {
  assert.equal(applies.test('agents/scout.md'), false)
  assert.equal(applies.test('tools/lint.mjs'), false)
  assert.equal(applies.test('skills/investigate/SKILL.md'), false)
  assert.equal(applies.test('docs/notes.workflow.js.md'), false)
})

test('applies is stateless, so lint can reuse one instance across every file', () => {
  assert.deepEqual([applies.test(WF), applies.test(WF), applies.test(WF)], [true, true, true])
})

// --- the clean case --------------------------------------------------------------
//
// The shape every agentics-* workflow has: a prefixed name, phases declared one entry per line, and a
// phase() call for each. A rule that flags this flags everything.

const clean = src(
  'export const meta = {', //                       1
  "  name: 'agentics-survey',", //                       2
  "  description: 'Gather evidence and stop.',", // 3
  '  phases: [', //                                 4
  "    { title: 'Plan' },", //                      5
  "    { title: 'Scout' },", //                     6
  "    { title: 'Analyze' },", //                   7
  '  ],', //                                        8
  '}', //                                           9
  '', //                                           10
  "phase('Plan')", //                              11
  "phase('Scout')", //                             12
  "phase('Analyze')", //                           13
)

test('a well-formed workflow with several phases is clean', () => {
  assert.deepEqual(check(clean, WF), [])
})

// --- V1: the meta literal must be exported ---------------------------------------

test('V1: a script with no meta literal is flagged against the whole file', () => {
  const noMeta = src(
    "const topics = ['auth', 'routing']", // 1
    'return { topics }', //                 2
  )

  const violation = onlyViolation(check(noMeta, WF))

  assert.equal(violation.line, 0)
  assert.match(violation.message, /meta/i)
})

test('V1: a meta that is declared but never exported does not count', () => {
  const unexported = src(
    'const meta = {', //          1
    "  name: 'agentics-survey',", //   2
    '  phases: [],', //           3
    '}', //                       4
  )

  const violation = onlyViolation(check(unexported, WF))

  assert.equal(violation.line, 0)
  assert.match(violation.message, /meta/i)
})

// --- V2: meta.name must carry the agentics- prefix ------------------------------------

const unprefixedName = src(
  'export const meta = {', //                       1
  "  name: 'survey',", //                           2
  "  description: 'Gather evidence and stop.',", // 3
  '  phases: [', //                                 4
  "    { title: 'Plan' },", //                      5
  '  ],', //                                        6
  '}', //                                           7
  '', //                                            8
  "phase('Plan')", //                               9
)

test('V2: a name without the agentics- prefix is flagged on the name line', () => {
  const violation = onlyViolation(check(unprefixedName, WF))

  assert.equal(violation.line, 2)
  assert.match(violation.message, /survey/)
  assert.match(violation.message, /agentics-/)
})

test('a violation carries a numeric line and a non-empty message', () => {
  const violation = onlyViolation(check(unprefixedName, WF))

  assert.equal(Number.isInteger(violation.line), true)
  assert.equal(typeof violation.message, 'string')
  assert.notEqual(violation.message.trim(), '')
})

test('V2: a name starting with agentics but not agentics- is still flagged', () => {
  const nearMiss = src(
    'export const meta = {', //   1
    "  name: 'agenticssurvey',", //    2
    '  phases: [],', //           3
    '}', //                       4
  )

  const violation = onlyViolation(check(nearMiss, WF))

  assert.equal(violation.line, 2)
  assert.match(violation.message, /agenticssurvey/)
})

test('V2: a meta with no name key is flagged against the whole file', () => {
  const nameless = src(
    'export const meta = {', //                       1
    "  description: 'Gather evidence and stop.',", // 2
    '  phases: [', //                                 3
    "    { title: 'Plan' },", //                      4
    '  ],', //                                        5
    '}', //                                           6
    '', //                                            7
    "phase('Plan')", //                               8
  )

  const violation = onlyViolation(check(nameless, WF))

  assert.equal(violation.line, 0)
  assert.match(violation.message, /name/i)
})

test('V2: a name key outside the meta literal is not meta.name', () => {
  const withOtherName = src(
    clean, //                                lines 1-13
    "const options = { name: 'scout' }", //  14
  )

  assert.deepEqual(check(withOtherName, WF), [])
})

// --- V3: every phase() call needs a declared title --------------------------------

test('V3: a phase call with no declared title is flagged on its own line', () => {
  const extraPhase = src(
    clean, //             lines 1-13
    "phase('Verify')", // 14
  )

  const violation = onlyViolation(check(extraPhase, WF))

  assert.equal(violation.line, 14)
  assert.match(violation.message, /Verify/)
})

test('V3: two unmatched titles produce two violations on their own lines', () => {
  const twoUnmatched = src(
    'export const meta = {', //   1
    "  name: 'agentics-survey',", //   2
    '  phases: [', //             3
    "    { title: 'Plan' },", //  4
    '  ],', //                    5
    '}', //                       6
    '', //                        7
    "phase('Plan')", //           8
    "phase('Verify')", //         9
    "phase('Report')", //        10
  )

  const violations = check(twoUnmatched, WF)
  const byLine = new Map(violations.map((v) => [v.line, v.message]))

  assert.equal(violations.length, 2)
  assert.deepEqual([...byLine.keys()].sort((a, b) => a - b), [9, 10])
  assert.match(byLine.get(9), /Verify/)
  assert.match(byLine.get(10), /Report/)
})

test('V3: phase titles must agree exactly, not by prefix', () => {
  const almost = src(
    'export const meta = {', //     1
    "  name: 'agentics-survey',", //     2
    '  phases: [', //               3
    "    { title: 'Scout' },", //   4
    '  ],', //                      5
    '}', //                         6
    '', //                          7
    "phase('Scout')", //            8
    "phase('Scout the docs')", //   9
  )

  const violation = onlyViolation(check(almost, WF))

  assert.equal(violation.line, 9)
  assert.match(violation.message, /Scout the docs/)
})

test('V3: a meta with no phases key leaves every phase call unmatched', () => {
  const noPhases = src(
    'export const meta = {', //                       1
    "  name: 'agentics-survey',", //                       2
    "  description: 'Gather evidence and stop.',", // 3
    '}', //                                           4
    '', //                                            5
    "phase('Plan')", //                               6
  )

  const violation = onlyViolation(check(noPhases, WF))

  assert.equal(violation.line, 6)
  assert.match(violation.message, /Plan/)
})

// --- V3: what counts as a declaration, and what does not --------------------------
//
// The declared set lives in the meta literal, which in the real workflows is formatted across
// many lines. Titles that merely look like declarations — commented out, or sitting in some
// other object — declare nothing, and the phase() calls relying on them must still be flagged.

test('V3: a declaration whose entry spans several lines is still found', () => {
  const spreadEntries = src(
    'export const meta = {', //   1
    "  name: 'agentics-survey',", //   2
    '  phases: [', //             3
    '    {', //                   4
    "      title: 'Plan',", //    5
    '    },', //                  6
    '    {', //                   7
    "      title: 'Scout',", //   8
    '    },', //                  9
    '  ],', //                   10
    '}', //                      11
    '', //                       12
    "phase('Plan')", //          13
    "phase('Scout')", //         14
  )

  assert.deepEqual(check(spreadEntries, WF), [])
})

test('V3: declarations packed onto a single line are all found', () => {
  const oneLine = src(
    "export const meta = { name: 'agentics-survey', phases: [{ title: 'Plan' }, { title: 'Scout' }] }",
    '', //                2
    "phase('Plan')", //   3
    "phase('Scout')", //  4
  )

  assert.deepEqual(check(oneLine, WF), [])
})

test('V3: a double-quoted phase call is recognised as a call', () => {
  const doubleQuotedCall = src(
    clean, //             lines 1-13
    'phase("Verify")', // 14
  )

  const violation = onlyViolation(check(doubleQuotedCall, WF))

  assert.equal(violation.line, 14)
  assert.match(violation.message, /Verify/)
})

test('V3: a double-quoted title declaration satisfies a single-quoted call', () => {
  const doubleQuotedTitle = src(
    'export const meta = {', //     1
    "  name: 'agentics-survey',", //     2
    '  phases: [', //               3
    '    { title: "Plan" },', //    4
    '    { title: "Scout" },', //   5
    '  ],', //                      6
    '}', //                         7
    '', //                          8
    "phase('Plan')", //             9
    "phase('Scout')", //           10
  )

  assert.deepEqual(check(doubleQuotedTitle, WF), [])
})

test('V3: a commented-out declaration outside meta declares nothing', () => {
  const commentedOutside = src(
    "export const meta = { name: 'agentics-x', phases: [] }", // 1
    "// { title: 'Scout' }", //                            2
    "phase('Scout')", //                                   3
  )

  const violation = onlyViolation(check(commentedOutside, WF))

  assert.equal(violation.line, 3)
  assert.match(violation.message, /Scout/)
})

test('V3: a commented-out declaration inside meta.phases declares nothing', () => {
  const commentedInside = src(
    'export const meta = {', //         1
    "  name: 'agentics-survey',", //         2
    '  phases: [', //                   3
    "    { title: 'Plan' },", //        4
    "    // { title: 'Scout' },", //    5
    '  ],', //                          6
    '}', //                             7
    '', //                              8
    "phase('Plan')", //                 9
    "phase('Scout')", //               10
  )

  const violation = onlyViolation(check(commentedInside, WF))

  assert.equal(violation.line, 10)
  assert.match(violation.message, /Scout/)
})

test('V3: a block-commented declaration inside meta.phases declares nothing', () => {
  const blockCommented = src(
    'export const meta = {', //           1
    "  name: 'agentics-survey',", //           2
    '  phases: [', //                     3
    "    { title: 'Plan' },", //          4
    "    /* { title: 'Scout' }, */", //   5
    '  ],', //                            6
    '}', //                               7
    '', //                                8
    "phase('Plan')", //                   9
    "phase('Scout')", //                 10
  )

  const violation = onlyViolation(check(blockCommented, WF))

  assert.equal(violation.line, 10)
  assert.match(violation.message, /Scout/)
})

test('V3: a title in an unrelated object literal is not a phase declaration', () => {
  const strayTitle = src(
    'export const meta = {', //              1
    "  name: 'agentics-survey',", //              2
    '  phases: [', //                        3
    "    { title: 'Plan' },", //             4
    '  ],', //                               5
    '}', //                                  6
    '', //                                   7
    "const box = { title: 'Scout' }", //     8
    '', //                                   9
    "phase('Plan')", //                     10
    "phase('Scout')", //                    11
  )

  const violation = onlyViolation(check(strayTitle, WF))

  assert.equal(violation.line, 11)
  assert.match(violation.message, /Scout/)
})

// --- V4: the meta literal is literal ---------------------------------------------
//
// The failure this catches has already happened in this plugin. `agentics-probe` shipped with a
// `description` written as a three-line concatenation — ordinary, readable JavaScript that
// every check above passed — and the runtime, which reads meta statically instead of
// evaluating it, refused to register the workflow. Nothing reported that. The workflow was
// just not there, and stayed not there, until somebody went looking for why a skill's
// Workflow call could not resolve its own plugin's name.
//
// So the fixtures below are ordinary code, not contrived code. That is the point.

test('V4: a concatenated description is flagged — the bug that shipped', () => {
  const concatenated = src(
    'export const meta = {', //                                    1
    "  name: 'agentics-probe',", //                                     2
    "  description: 'Adversarially probe an artefact with ' +", // 3
    "    'independent analysts.',", //                             4
    '  phases: [],', //                                            5
    '}', //                                                        6
  )

  const violation = onlyViolation(check(concatenated, WF))

  assert.equal(violation.line, 3)
  assert.match(violation.message, /pure literal/)
})

test('V4: each concatenation operator is reported where it sits', () => {
  const twoJoins = src(
    'export const meta = {', //                1
    "  name: 'agentics-survey',", //                2
    "  description: 'one ' +", //              3
    "    'two ' +", //                         4
    "    'three',", //                         5
    '  phases: [],', //                        6
    '}', //                                    7
  )

  const found = check(twoJoins, WF)

  assert.deepEqual(found.map((v) => v.line), [3, 4])
})

test('V4: an interpolating template literal is flagged', () => {
  const interpolated = src(
    'const SUBJECT = "the repository"', //          1
    'export const meta = {', //                    2
    "  name: 'agentics-survey',", //                    3
    '  description: `Gather evidence about ${SUBJECT}.`,', // 4
    '  phases: [],', //                            5
    '}', //                                        6
  )

  const violation = onlyViolation(check(interpolated, WF))

  assert.equal(violation.line, 4)
  assert.match(violation.message, /template literal/)
})

test('V4: a template literal with no interpolation is a literal and passes', () => {
  const plain = src(
    'export const meta = {', //                1
    '  name: `agentics-survey`,', //                2
    '  description: `plain backticks`,', //    3
    '  phases: [],', //                        4
    '}', //                                    5
  )

  assert.deepEqual(check(plain, WF), [])
})

test('V4: a function call inside meta is flagged', () => {
  const called = src(
    'export const meta = {', //                        1
    "  name: 'agentics-survey',", //                        2
    "  description: describe('survey'),", //           3
    '  phases: [],', //                                4
    '}', //                                            5
  )

  // The call parenthesis and the bare `describe` are two different ways of saying the same
  // thing, and both are reported: a reader fixing one has already fixed the other, and a
  // rule that reports only the parenthesis reads as if the identifier were fine.
  const found = check(called, WF)

  assert.equal(found.length, 2)
  assert.ok(found.every((v) => v.line === 3))
  assert.match(found[0].message, /function call/)
})

test('V4: a spread inside meta is flagged', () => {
  const spread = src(
    'export const meta = {', //                1
    "  name: 'agentics-survey',", //                2
    '  phases: [...BASE_PHASES],', //          3
    '}', //                                    4
  )

  const found = check(spread, WF)

  assert.ok(found.some((v) => /spread/.test(v.message)))
  assert.ok(found.every((v) => v.line === 3))
})

test('V4: a bare identifier standing in for a value is flagged', () => {
  const borrowed = src(
    'export const meta = {', //                1
    "  name: 'agentics-survey',", //                2
    '  description: SURVEY_BLURB,', //         3
    '  phases: [],', //                        4
    '}', //                                    5
  )

  const violation = onlyViolation(check(borrowed, WF))

  assert.equal(violation.line, 3)
  assert.match(violation.message, /SURVEY_BLURB/)
})

test('V4: keys are identifiers too and are never flagged as values', () => {
  const keys = src(
    'export const meta = {', //                                1
    "  name: 'agentics-survey',", //                                2
    "  whenToUse: 'when evidence is wanted',", //              3
    '  phases: [', //                                          4
    "    { title: 'Plan', detail: 'scope the topics' },", //   5
    '  ],', //                                                 6
    '}', //                                                    7
  )

  assert.deepEqual(check(keys, WF), [])
})

test('V4: true, false and null are literals and pass', () => {
  const flags = src(
    'export const meta = {', //                1
    "  name: 'agentics-survey',", //                2
    '  hidden: false,', //                     3
    '  owner: null,', //                       4
    '  phases: [],', //                        5
    '}', //                                    6
  )

  assert.deepEqual(check(flags, WF), [])
})

test('V4: only the meta block is judged — the script body concatenates freely', () => {
  const body = src(
    clean, //                                                     1-13
    "const prompt = 'a ' + 'b' + `${clean}`", //                  14
    'export function build(x) { return [...x] }', //              15
  )

  assert.deepEqual(check(body, WF), [])
})

test('V4: a comment inside meta may say anything', () => {
  const commented = src(
    'export const meta = {', //                                  1
    "  name: 'agentics-survey',", //                                  2
    '  // built from parts elsewhere: NAME + SUFFIX, ${x}', //   3
    '  phases: [],', //                                          4
    '}', //                                                      5
  )

  assert.deepEqual(check(commented, WF), [])
})

test('V4: every shipped workflow has a literal meta', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')

  const dir = fileURLToPath(new URL('../workflows/', import.meta.url))

  for (const name of readdirSync(dir).filter((n) => n.endsWith('.workflow.js'))) {
    const found = check(readFileSync(dir + name, 'utf8'), 'workflows/' + name)
      .filter((v) => /pure literal/.test(v.message))

    assert.deepEqual(found, [], `${name} has a non-literal meta: ${JSON.stringify(found)}`)
  }
})

// --- purity ----------------------------------------------------------------------
//
// Rules hold no mutable state (../shared/conventions.md). A module-level global regex whose
// lastIndex survives a call would make findings depend on scan order — every workflow after the
// first would be judged differently.

test('check is stateless: the same source always yields the same violations', () => {
  const dirty = src(
    clean, //             lines 1-13
    "phase('Verify')", // 14
  )

  const first = check(dirty, WF)
  check(clean, WF)
  const second = check(dirty, WF)

  assert.equal(first.length, 1)
  assert.deepEqual(second, first)
})
