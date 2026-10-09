// test/fast/no-self-verdict.test.mjs — pins the two checks of the no-self-verdict rule over the return
// schemas: no verdict-named boolean (`approved`, `passed`, `ok`, …) while fact names such as
// `build_ok` stay legal; and the ruling fields — none in a producer's or a searcher's schema, and
// per-unit rulings required in every judge's.
//
// Design: docs/DESIGN.md#l3--separate-judges and docs/DESIGN.md#self-checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { id, applies, check } from '../../tools/rules/no-self-verdict.mjs'

const FILE = 'lib/schemas.mjs'
const SCHEMAS = readFileSync(new URL('../../lib/schemas.mjs', import.meta.url), 'utf8')
const lines = (src) => check(src, FILE).map((v) => v.line)

/** A schema table in lib/schemas.mjs's shape, one entry per argument. */
const table = (...entries) => ['export const SCHEMAS = {', ...entries, '}'].join('\n')

test('its id is no-self-verdict', () => {
  assert.equal(id, 'no-self-verdict')
})

test('it applies to the return schemas, and nothing else', () => {
  assert.ok(applies.test('lib/schemas.mjs'))
  for (const path of ['lib/runner.mjs', 'roles/reviewer.md', 'tools/lint.mjs', 'lib/programs/review.mjs', 'test/fast/schemas.test.mjs']) {
    assert.ok(!applies.test(path), path)
  }
})

test('lib/schemas.mjs as it stands passes both checks', () => {
  assert.deepEqual(check(SCHEMAS, FILE), [])
})

// --- verdict booleans ---------------------------------------------------------------------------

test('flags approved declared as a boolean schema property', () => {
  const found = check(['const FINDINGS = {', '  type: "object",', "  properties: { approved: { type: 'boolean' } },", '}'].join('\n'), FILE)
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 3)
  assert.match(found[0].message, /approved/)
})

test('flags every key in the banned list', () => {
  for (const key of ['approved', 'approve', 'passed', 'ok', 'accepted', 'lgtm', 'complete', 'success', 'valid']) {
    const found = check(`${key}: { type: 'boolean' }`, FILE)
    assert.equal(found.length, 1, `${key} should be flagged`)
    assert.match(found[0].message, new RegExp(key))
  }
})

test('flags two banned keys on one line, and a key whose type is on the next line, on the key line', () => {
  assert.deepEqual(lines("{ ok: { type: 'boolean' }, valid: { type: 'boolean' } }"), [1, 1])
  assert.deepEqual(lines(['properties: {', '  accepted: {', "    type: 'boolean',", '  },', '}'].join('\n')), [2])
})

test('does not flag fact names, a banned key as a substring, a non-boolean, or prose', () => {
  assert.deepEqual(lines("build_ok: { type: 'boolean' },\nsuite_pass: { type: 'boolean' },"), [])
  assert.deepEqual(lines("passed_tests: { type: 'boolean' }"), [])
  assert.deepEqual(lines("passed: { type: 'array', items: { type: 'string' } }"), [])
  assert.deepEqual(lines('const PROMPT = `\n  Say whether it passed the suite and whether the fix is complete.\n`'), [])
})

// --- ruling fields -------------------------------------------------------------------------------

test('a producer schema with a ruling field is a finding on that field', () => {
  for (const field of ['ruling', 'rulings', 'units', 'verdict']) {
    const src = table("  draft: {\n    kind: 'producer',", `    schema: obj({ text: str, ${field}: strings }),`, '  },')
    const found = check(src, FILE)
    assert.deepEqual(found.map((v) => v.line), [4], field)
    assert.match(found[0].message, new RegExp(field))
    assert.match(found[0].message, /draft/)
  }
})

test('a ruling field nested in a searcher schema is a finding', () => {
  const src = table("  hits: { kind: 'searcher', schema: long({ hits: arr(obj({ path: str, verdict: str })), searched: strings }) },")
  assert.deepEqual(lines(src), [2])
})

test('a producer schema that builds a per-unit ruling is a finding', () => {
  const src = table("  draft: { kind: 'producer', schema: obj({ text: str, parts: arr(unit('a', 'b')) }) },")
  assert.deepEqual(lines(src), [2])
})

test('a judge schema that requires a units array, a rulings array or one ruling passes', () => {
  assert.deepEqual(lines(table("  j: { kind: 'judge', schema: long({ notes: str, units: arr(unit('clean', 'findings')) }) },")), [])
  assert.deepEqual(lines(table("  j: { kind: 'judge', schema: long({ rulings: arr(obj({ id: str, why: str })) }, ['rulings']) },")), [])
  assert.deepEqual(lines(table("  j: { kind: 'judge', schema: long({ ruling: one('converging', 'not_converging'), why: str }, ['ruling', 'why']) },")), [])
})

test('a judge schema with no ruling field is a finding on its entry line', () => {
  const src = table("  j: { kind: 'judge', schema: long({ notes: str, text: str }) },")
  const found = check(src, FILE)
  assert.deepEqual(found.map((v) => v.line), [2])
  assert.match(found[0].message, /\bj\b/)
})

test('a judge whose units are not required is a finding', () => {
  assert.deepEqual(lines(table("  j: { kind: 'judge', schema: long({ notes: str, units: arr(unit('a')) }, ['notes']) },")), [2])
})

test('a judge whose units are not an array is a finding', () => {
  assert.deepEqual(lines(table("  j: { kind: 'judge', schema: long({ units: str }) },")), [2])
})

test("a ruling nested under another of a judge's fields does not count as its rulings", () => {
  assert.deepEqual(lines(table("  j: { kind: 'judge', schema: long({ found: arr(obj({ id: str, ruling: one('a', 'b') })) }) },")), [2])
})

test('a judge written as a JSON Schema object is read through its properties and required', () => {
  const judge = (required) => table(
    "  j: { kind: 'judge', schema: { type: 'object', properties: { units: { type: 'array', items: {} } }" + required + ' } },')
  assert.deepEqual(lines(judge(", required: ['units']")), [])
  assert.deepEqual(lines(judge(", required: ['notes']")), [2])
  assert.deepEqual(lines(judge('')), [2])
})

test('a schema entry in a comment is no finding', () => {
  assert.deepEqual(lines("// j: { kind: 'judge', schema: obj({ text: str }) },\n// p: { kind: 'producer', schema: obj({ units: strings }) },"), [])
})

test('lib/schemas.mjs with a ruling field added to a producer fails the rule', () => {
  const broken = SCHEMAS.replace("investigate_report: { kind: 'producer', schema: obj({ report: str }) }",
    "investigate_report: { kind: 'producer', schema: obj({ report: str, units: strings }) }")
  assert.notEqual(broken, SCHEMAS, 'the fixture edit applies')
  assert.equal(check(broken, FILE).length, 1)
})
