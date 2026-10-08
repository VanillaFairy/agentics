// test/fast/schemas.test.mjs — pins the return schemas the runner hands the host: their kinds, the
// coverage every searcher declares, the per-unit rulings every judge returns, and what no
// producer or searcher may carry.
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
const propertyNames = (schema) => walk(schema).filter(([k, v]) => k === 'properties' && v && typeof v === 'object')
  .flatMap(([, v]) => Object.keys(v))

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

test('every searcher declares its coverage', () => {
  assert.ok(ofKind('searcher').length > 0)
  for (const [name, { schema }] of ofKind('searcher')) {
    for (const field of ['searched', 'no_match', 'not_reached', 'stop_reason']) assert.ok(schema.required.includes(field), name + ' lacks ' + field)
    for (const reason of ['exhausted', 'unfinished', 'stuck']) assert.ok(schema.properties.stop_reason.enum.includes(reason), name + ' cannot say ' + reason)
  }
})

test('every judge rules per unit', () => {
  const PER_UNIT = { items: 'units', prober: 'units', rejudge: 'rulings', assessment: 'units', reviewer: 'units',
    ruler_premises: 'rulings', auditor: 'units' }
  assert.deepEqual(Object.keys(PER_UNIT).sort(), ofKind('judge').map(([n]) => n).filter((n) => n !== 'ruler_convergence').sort())
  for (const [name, field] of Object.entries(PER_UNIT)) {
    const schema = schemaOf(name)
    assert.ok(schema.required.includes(field), name + ' does not require ' + field)
    assert.equal(schema.properties[field].type, 'array', name + '.' + field)
  }
  assert.ok(schemaOf('ruler_convergence').required.includes('ruling'))
})

test('no producer or searcher carries a ruling field', () => {
  for (const [name, { schema }] of [...ofKind('producer'), ...ofKind('searcher')]) {
    for (const banned of ['ruling', 'rulings', 'units', 'verdict']) assert.ok(!propertyNames(schema).includes(banned), name + ' carries ' + banned)
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

test('every searcher and judge may continue a long return', () => {
  for (const [name, { schema }] of [...ofKind('searcher'), ...ofKind('judge')]) {
    assert.equal(schema.properties.more.type, 'boolean', name)
    assert.ok(!schema.required.includes('more'), name + ' requires more')
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
  assert.deepEqual(r.claims.items.properties.ruling.enum, ['met', 'under', 'over', 'deviates', 'spec_defect', 'cant_tell'])
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
