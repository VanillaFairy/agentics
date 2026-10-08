// test/no-schema-bounds.test.mjs — pins the ban on unsupported schema length constraints.
//
// minItems/maxItems/minLength/maxLength are silently dropped by structured outputs. An
// author who writes one believes a bound is enforced when nothing is enforcing it. The
// clean cases below matter as much as the flagged ones: a rule that fires on `minimum`
// or on prose would make the whole lint untrustworthy and get switched off.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { id, applies, check } from '../../tools/rules/no-schema-bounds.mjs'

const FILE = 'workflows/agentics-survey.workflow.js'

test('it applies to workflow scripts and the return schemas, and nothing else', () => {
  assert.ok(applies.test('workflows/agentics-survey.workflow.js'))
  assert.ok(!applies.test('agents/scout.md'))
  assert.ok(!applies.test('tools/lint.mjs'))
  assert.ok(applies.test('lib/schemas.mjs'))
  assert.ok(!applies.test('lib/runner.mjs'))
})

test('flags maxItems and reports its line', () => {
  const src = [
    'const S = {',
    '  type: "array",',
    '  maxItems: 40,',
    '}',
  ].join('\n')

  const found = check(src, FILE)
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 3)
  assert.match(found[0].message, /maxItems/)
})

test('flags all four banned keys', () => {
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) {
    const found = check(`  ${key}: 3,`, FILE)
    assert.equal(found.length, 1, `${key} should be flagged`)
    assert.match(found[0].message, new RegExp(key))
  }
})

test('reports one violation per occurrence, not per line', () => {
  const found = check('{ minItems: 1, maxItems: 9 }', FILE)
  assert.equal(found.length, 2)
  assert.deepEqual(found.map((v) => v.line), [1, 1])
})

test('tolerates whitespace before the colon', () => {
  assert.equal(check('  maxItems : 4,', FILE).length, 1)
})

test('does not flag minimum or maximum', () => {
  assert.deepEqual(check('{ minimum: 1, maximum: 9 }', FILE), [])
})

test('does not flag prose that merely names the keys', () => {
  const src = '// never write maxItems or minLength in a schema'
  assert.deepEqual(check(src, FILE), [])
})

test('a clean schema produces no violations', () => {
  const src = [
    'const HITS = {',
    '  type: "object",',
    '  required: ["hits", "stop_reason"],',
    '  properties: { stop_reason: { type: "string", enum: ["exhausted"] } },',
    '}',
  ].join('\n')

  assert.deepEqual(check(src, FILE), [])
})
