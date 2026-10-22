// test/fast/schemas.test.mjs — pins the return schemas the runner hands the host: their kinds, the
// searcher return, and the ladders their judges grade on. Which fields carry a
// ruling, and that every judge rules per unit, is the no-self-verdict lint rule's
// (test/fast/no-self-verdict.test.mjs).
//
// Design: docs/DESIGN.md#briefs-and-returns and docs/DESIGN.md#l3--separate-judges.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { KINDS, SCHEMAS, kindOf, schemaOf } from '../../lib/schemas.mjs'

const entries = Object.entries(SCHEMAS)
const ofKind = (kind) => entries.filter(([, s]) => s.kind === kind)

/** Every [key, value] at any depth of a schema, so a rule can see nested properties. */
function walk(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => walk(v, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push([k, v]); walk(v, out) }
  }
  return out
}

test('every schema has a known kind', () => {
  for (const [name, s] of entries) assert.ok(KINDS.includes(s.kind), name + ' has kind ' + s.kind)
})

test('every schema is an object schema whose required names are properties', () => {
  for (const [name, { schema }] of entries) {
    assert.equal(schema.type, 'object', name)
    assert.equal(schema.additionalProperties, false, name)
    for (const r of schema.required) assert.ok(Object.hasOwn(schema.properties, r), name + ' requires ' + r + ', which it does not define')
  }
})

test('no schema carries a size bound', () => {
  for (const [name, { schema }] of entries) {
    for (const [k] of walk(schema)) assert.ok(!['minItems', 'maxItems', 'minLength', 'maxLength'].includes(k), name + ' carries ' + k)
  }
})

test('no schema carries a verdict-named boolean', () => {
  const BANNED = ['approved', 'approve', 'passed', 'ok', 'accepted', 'lgtm', 'complete', 'success', 'valid']
  for (const [name, { schema }] of entries) {
    for (const [k, v] of walk(schema)) {
      if (k === 'properties') for (const [p, d] of Object.entries(v)) assert.ok(!(BANNED.includes(p) && d.type === 'boolean'), name + '.' + p)
    }
  }
})

test('a judge holding an array may continue a long return', () => {
  for (const [name, { schema }] of ofKind('judge').filter(([, s]) => Object.values(s.schema.properties).some((p) => p.type === 'array'))) {
    assert.equal(schema.properties.more.type, 'boolean', name)
    assert.ok(!schema.required.includes('more'), name + ' requires more')
  }
})

test('no schema offers more where a part could not progress: a searcher, or a return without an array', () => {
  for (const [name, { schema }] of entries) {
    const progressable = Object.entries(schema.properties).some(([k, p]) => k !== 'more' && p.type === 'array')
    if (SCHEMAS[name].kind === 'searcher' || !progressable) assert.ok(!Object.hasOwn(schema.properties, 'more'), name + ' offers more')
  }
})

test('a producer returns one of the 5.0 statuses', () => {
  assert.deepEqual(schemaOf('producer').properties.status.enum, ['done', 'done_with_concerns', 'blocked', 'needs_context',
    'needs_tests', 'needs_locus', 'decompose', 'unsplittable', 'premise_mismatch', 'needs_decision', 'contract_changed', 'declined'])
})

test('declined is a producer status no other schema offers', () => {
  assert.ok(schemaOf('producer').properties.status.enum.includes('declined'))
  for (const [name, { schema }] of entries.filter(([n]) => n !== 'producer')) {
    const status = schema.properties.status
    assert.ok(!(status && (status.enum || []).includes('declined')), name + ' offers declined')
  }
})

test('a reviewer grades findings, rules fixes and rules claims on the fixed ladders', () => {
  const r = schemaOf('reviewer').properties
  assert.deepEqual(r.findings.items.properties.severity.enum, ['critical', 'major', 'minor'])
  assert.deepEqual(r.fix_rulings.items.properties.status.enum, ['fixed', 'not_fixed', 'regressed'])
  assert.deepEqual(r.claims.items.properties.ruling.enum, ['met', 'equivalent', 'under', 'over', 'deviates', 'spec_defect', 'cant_tell'])
  assert.deepEqual(r.units.items.properties.ruling.enum, ['clean', 'findings'])
})

test('a prober grades findings on the design ladder', () => {
  assert.deepEqual(schemaOf('prober').properties.findings.items.properties.severity.enum, ['ambiguity', 'gap', 'note'])
})

test('schemaOf and kindOf answer for every name and refuse an unknown one', () => {
  for (const [name, s] of entries) {
    assert.equal(schemaOf(name), s.schema)
    assert.equal(kindOf(name), s.kind)
  }
  assert.equal(schemaOf('nothing'), null)
  assert.equal(kindOf('nothing'), '')
})

test('the searcher return is a summary and what it left unsearched', () => {
  assert.equal(SCHEMAS.search.kind, 'searcher')
  assert.deepEqual(SCHEMAS.search.schema.required, ['summary', 'unsearched'])
})
