// test/fast/schemas.test.mjs — pins the return schemas the runner hands the host: their kinds, the
// envelope every navigator returns, and the ladders their judges grade on. Which fields carry a
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

/** The searcher schemas the old search machinery still dispatches; they go with it. */
const OLD_SEARCHERS = ['scout_hits', 'scout_located', 'historian', 'doc_research', 'candidates']
const navigators = () => ofKind('searcher').filter(([name]) => !OLD_SEARCHERS.includes(name))

test('every navigator returns hits, dismissals, leads and a declaration per ask', () => {
  assert.ok(navigators().length > 0)
  for (const [name, { schema }] of navigators()) {
    for (const field of ['hits', 'dismissed', 'leads', 'asks']) {
      assert.ok(schema.required.includes(field), name + ' lacks ' + field)
      assert.equal(schema.properties[field].type, 'array', name + '.' + field)
    }
    const asks = schema.properties.asks.items
    assert.deepEqual(asks.properties.declared.enum, ['answered', 'absent', 'open'], name)
    for (const field of ['ask', 'declared']) assert.ok(asks.required.includes(field), name + ' asks.' + field)
    assert.equal(asks.properties.ask.type, 'string', name)
    for (const field of ['hits', 'dismissed']) {
      const item = schema.properties[field].items
      assert.deepEqual([item.properties.ask.type, item.properties.ask.items.type], ['array', 'string'], name + '.' + field + ' names its asks')
      assert.ok(item.required.includes('ask'), name + '.' + field + ' requires ask')
    }
    const dismissal = schema.properties.dismissed.items
    assert.ok(dismissal.required.includes('why'), name + ' dismissals say why')
    for (const field of ['path', 'glob', 'call']) assert.ok(!dismissal.required.includes(field), name + ' dismissal requires ' + field)
    assert.equal(dismissal.properties.call.type, 'integer', name)
    const lead = schema.properties.leads.items
    for (const field of ['ask', 'path', 'why']) assert.ok(lead.required.includes(field), name + ' lead.' + field)
  }
})

test('no navigator declares its own coverage or a stop reason', () => {
  for (const [name, { schema }] of navigators()) {
    for (const field of ['stop_reason', 'searched', 'no_match', 'not_reached']) assert.ok(!Object.hasOwn(schema.properties, field), name + ' carries ' + field)
  }
})

test("a navigator's hit names its location in its domain's terms", () => {
  const hitOf = (name) => schemaOf(name).properties.hits.items
  for (const [name, fields] of [['search_repo', ['ask', 'path', 'line', 'note']], ['search_history', ['ask', 'commit', 'note']], ['search_web', ['ask', 'url', 'note']]]) {
    assert.equal(kindOf(name), 'searcher', name)
    for (const field of fields) assert.ok(hitOf(name).required.includes(field), name + ' hit requires ' + field)
  }
  assert.equal(hitOf('search_repo').properties.line.type, 'integer')
  const web = hitOf('search_web')
  assert.ok(!web.required.includes('candidate'), 'a web hit need not be a candidate')
  for (const field of ['name', 'source_url', 'what_it_is', 'latest_version', 'license', 'maintenance', 'covers', 'does_not_cover']) {
    assert.ok(web.properties.candidate.required.includes(field), 'a candidate requires ' + field)
  }
})

test('a search convergence ruling is one unit per ask, converging or not', () => {
  assert.equal(kindOf('ruler_search'), 'judge')
  const schema = schemaOf('ruler_search')
  assert.ok(schema.required.includes('units'))
  const unit = schema.properties.units.items
  assert.deepEqual(unit.properties.ruling.enum, ['converging', 'not_converging'])
  for (const field of ['unit', 'ruling', 'why']) assert.ok(unit.required.includes(field), field)
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
