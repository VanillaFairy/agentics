// test/qualified-agent-types.test.mjs — pins that every agent reference is namespaced.
//
// Agent types resolve from one flat global registry shared across installed plugins. A
// bare name resolves by luck and fails mid-run when another plugin defines the same name.
// The existing `investigate` plugin ships this exact bug; this rule is why it cannot
// happen here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { id, applies, check } from '../../tools/rules/qualified-agent-types.mjs'

const WF = 'workflows/agentics-survey.workflow.js'

test('it applies only to workflow scripts', () => {
  assert.ok(applies.test(WF))
  assert.ok(!applies.test('agents/scout.md'))
})

test('flags a bare agent name and names the offending value', () => {
  const src = ["const r = await agent(p, { agentType: 'scout' })"].join('\n')

  const found = check(src, WF)
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 1)
  assert.match(found[0].message, /scout/)
  assert.match(found[0].message, /agentics:scout/)
})

test('accepts a fully-qualified name', () => {
  assert.deepEqual(check("{ agentType: 'agentics:analyst' }", WF), [])
})

test('accepts all three quote styles', () => {
  assert.deepEqual(check('{ agentType: "agentics:scout" }', WF), [])
  assert.deepEqual(check("{ agentType: 'agentics:scout' }", WF), [])
  assert.deepEqual(check('{ agentType: `agentics:scout` }', WF), [])
})

test('flags a malformed qualification', () => {
  assert.equal(check("{ agentType: 'agentics:' }", WF).length, 1)
  assert.equal(check("{ agentType: ':scout' }", WF).length, 1)
  assert.equal(check("{ agentType: 'a:b:c' }", WF).length, 1)
  assert.equal(check("{ agentType: 'VF:Scout' }", WF).length, 1)
})

test('reports the correct line in a multi-line script', () => {
  const src = ['const a = 1', '', "await agent(p, { agentType: 'analyst' })"].join('\n')

  const found = check(src, WF)
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 3)
})

test('does NOT flag agentType as a schema property', () => {
  const src = "const S = { properties: { agentType: { type: 'string' } } }"
  assert.deepEqual(check(src, WF), [])
})

test('a clean workflow produces no violations', () => {
  const src = [
    "await agent(p, { agentType: 'agentics:scout', effort: 'low' })",
    "await agent(q, { agentType: 'agentics:analyst', effort: 'high' })",
  ].join('\n')

  assert.deepEqual(check(src, WF), [])
})
