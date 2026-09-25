// test/design-gate.test.mjs — the rule that keeps the design phase a phase.
//
// The rule is three substring checks, so the tests worth writing are the ones about SCOPE
// (it must not fire on other skills) and INDEPENDENCE (dropping one clause reports one
// violation, not three or zero), plus one that runs it against the real file — a rule whose
// own subject fails it is a rule nobody notices is wrong.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { id, applies, check } from '../tools/rules/design-gate.mjs'

const PATH = 'skills/design/SKILL.md'

const WHOLE = [
  'Hand off with Skill agentics:develop once ratified.',
  'HARD GATE. Nothing is implemented until the user ratifies.',
  'A design with an open blocking question does not hand off.',
  "Where the build runs is the user's call: ask before chaining into develop.",
].join('\n')

const without = (line) => WHOLE.split('\n').filter((l) => l !== WHOLE.split('\n')[line]).join('\n')

test('the module satisfies the rule contract', () => {
  assert.equal(id, 'design-gate')
  assert.ok(applies instanceof RegExp)
  assert.equal(typeof check, 'function')
})

test('a source carrying all three clauses is clean', () => {
  assert.deepEqual(check(WHOLE, PATH), [])
})

test('a missing terminal handoff is one violation naming develop', () => {
  const found = check(without(0), PATH)

  assert.equal(found.length, 1)
  assert.match(found[0].message, /agentics:develop/)
  assert.equal(found[0].line, 0)
})

test('a missing hard gate is one violation naming the gate', () => {
  const found = check(without(1), PATH)

  assert.equal(found.length, 1)
  assert.match(found[0].message, /HARD GATE/)
})

test('a missing blocking-question refusal is one violation naming it', () => {
  const found = check(without(2), PATH)

  assert.equal(found.length, 1)
  assert.match(found[0].message, /blocking/)
})

test('a missing where-the-build-runs question is one violation naming it', () => {
  const found = check(without(3), PATH)

  assert.equal(found.length, 1)
  assert.match(found[0].message, /where the build runs/)
})

test('the question survives however the section is capitalised', () => {
  // The phrase heads a section, so it is naturally capitalised; a rule that fires on a
  // capital letter teaches people to phrase around it rather than to mean it.
  const heading = WHOLE.replace(
    "Where the build runs is the user's call: ask before chaining into develop.",
    '### where the build runs - ask, do not assume')

  assert.deepEqual(check(heading, PATH), [])
})

test('an empty source reports all four, so a rewrite cannot lose them quietly', () => {
  assert.equal(check('', PATH).length, 4)
})

test('the handoff must be namespaced — a bare develop does not resolve', () => {
  const bare = WHOLE.replace('agentics:develop', 'develop')
  assert.equal(check(bare, PATH).length, 1)
})

test('applies to the two gated skills and to nothing else', () => {
  assert.ok(applies.test('skills/design/SKILL.md'))
  assert.ok(applies.test('skills/programme/SKILL.md'))
  assert.ok(!applies.test('skills/develop/SKILL.md'))
  assert.ok(!applies.test('skills/investigate/SKILL.md'))
  assert.ok(!applies.test('skills/plan/SKILL.md'))
  assert.ok(!applies.test('agents/analyst.md'))
  assert.ok(!applies.test('workflows/agentics-develop.workflow.js'))
  // Anchored at both ends: a path that merely ends this way belongs to another plugin.
  assert.ok(!applies.test('vendor/skills/design/SKILL.md'))
})

// --- the per-file clause map ------------------------------------------------------------
//
// The rule widened from one path to a map when a second gated skill appeared, and the two
// clause sets differ. That difference is not an oversight to tidy up later: the design skill
// gates on a human act of ratification, and the programme skill deliberately has no
// ratification at all — authorization there is the plan artifact existing, which can only
// happen through a session with the user. Demanding a HARD GATE of it would pin a ceremony
// the design removed on purpose.

const PROG = 'skills/programme/SKILL.md'

const PROGRAMME_WHOLE = [
  'On programme-complete the session asks once, then merges the programme branch.',
  "Slices land on a branch this layer owns; the user's checkout is untouched until then.",
].join('\n')

test('a programme skill carrying both its clauses is clean', () => {
  assert.deepEqual(check(PROGRAMME_WHOLE, PROG), [])
})

test('a programme skill that never names the landing merge is flagged', () => {
  const lines = PROGRAMME_WHOLE.split('\n')
  const found = check(lines[1], PROG)

  assert.equal(found.length, 1)
  assert.match(found[0].message, /merge the programme branch/)
})

test("a programme skill that drops the untouched-checkout sentence is flagged", () => {
  const lines = PROGRAMME_WHOLE.split('\n')
  const found = check(lines[0], PROG)

  assert.equal(found.length, 1)
  assert.match(found[0].message, /untouched/)
})

test('the programme skill is NOT asked for a HARD GATE', () => {
  assert.ok(!check('', PROG).some((v) => /HARD GATE/.test(v.message)),
    'per-leaf ratification was abolished by design; requiring it here would pin a bug')
  assert.equal(check('', PROG).length, 2)
})

test("design's clauses are not applied to the programme skill, or the reverse", () => {
  // Each file is judged by its own set. A shared list would have made the two skills answer
  // for each other's contracts, which is how the widening goes wrong.
  assert.deepEqual(check(WHOLE, PATH), [])
  assert.equal(check(WHOLE, PROG).length, 2)
  assert.equal(check(PROGRAMME_WHOLE, PATH).length, 4)
})

test('a file the map does not name is not judged at all', () => {
  assert.deepEqual(check('', 'skills/plan/SKILL.md'), [])
})

test("the programme clauses do not care where a sentence sits in a paragraph", () => {
  // Both sentences naturally open a line, and a rule that fires on a capital letter teaches
  // people to phrase around it rather than to mean it.
  const capitalised = [
    'Merges the programme branch once the user says so.',
    "The user's checkout is untouched until then.",
  ].join('\n')

  assert.deepEqual(check(capitalised, PROG), [])
})

test('the shipped programme skill passes its own rule', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../skills/programme/SKILL.md', import.meta.url)), 'utf8')

  assert.deepEqual(check(source, PROG), [])
})

test('the shipped design skill passes its own rule', () => {
  const source = readFileSync(fileURLToPath(new URL('../skills/design/SKILL.md', import.meta.url)), 'utf8')
  assert.deepEqual(check(source, PATH), [])
})

test('check is stateless: the same source always yields the same violations', () => {
  assert.deepEqual(check('', PATH), check('', PATH))
  assert.deepEqual(check(WHOLE, PATH), check(WHOLE, PATH))
})
