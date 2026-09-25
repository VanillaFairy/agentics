// test/no-turn-caps.test.mjs — pins IL1: completion is defined by the goal,
// never by a counter.
//
// The hard part is not detecting `maxTurns`. It is NOT detecting the three legitimate
// numeric patterns that ship in this very plugin: MAX_ROUNDS (the §3 resume threshold),
// the "around N tool calls, check for convergence" self-check in every search agent, and
// content bounds like "at most 12 tasks". A rule that flags those is worse than no rule,
// because it will be switched off and take §1 with it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { id, applies, check } from '../tools/rules/no-turn-caps.mjs'

const WF = 'workflows/agentics-survey.workflow.js'
const SKILL = 'skills/investigate/SKILL.md'

test('it applies to workflow scripts, SKILL.md, and agent charters — not to tools', () => {
  // Agent charters were originally out of scope; the self-audit widened the rule, since
  // CLAUDE.md's clause table assigns IL1 to this rule alone and a cap written
  // into a charter reaches every dispatch of that agent.
  assert.ok(applies.test(WF))
  assert.ok(applies.test(SKILL))
  assert.ok(applies.test('agents/scout.md'))
  assert.ok(!applies.test('tools/lint.mjs'))
  assert.ok(!applies.test('docs/superpowers/plans/x/tasks/T05-agents.md'))
})

test('flags maxTurns and reports its line', () => {
  const src = ['const opts = {', '  maxTurns: 5,', '}'].join('\n')

  const found = check(src, WF)
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 2)
  assert.match(found[0].message, /IL1/)
})

test('flags every identifier spelling of a turn or tool-call cap', () => {
  for (const key of ['maxTurns', 'max_turns', 'maxToolCalls', 'max_tool_calls']) {
    assert.equal(check(`  ${key}: 20,`, WF).length, 1, `${key} should be flagged`)
  }
})

test('flags a prose stop tied to an effort unit', () => {
  assert.equal(check('Stop after 10 tool calls and report.', SKILL).length, 1)
  assert.equal(check('stop after 3 turns', SKILL).length, 1)
})

test('flags MAX_ROUNDS — the resume loops are progress-gated, not counted', () => {
  const src = [
    'const MAX_ROUNDS = 3',
    'while (round < MAX_ROUNDS) {',
    '}',
  ].join('\n')

  assert.equal(check(src, WF).length, 2, 'both mentions should be flagged')
  assert.equal(check('  maxRounds: 3,', WF).length, 1)
})

test('a bare round counter used only for labels is not a cap', () => {
  assert.deepEqual(check('  const label = `scout round ${round}`', WF), [])
  assert.deepEqual(check('  round += 1', WF), [])
})

test('does NOT flag a convergence self-check', () => {
  const src = 'Around 25 tool calls, pause and check yourself: are you converging?'
  assert.deepEqual(check(src, SKILL), [])
})

test('does NOT flag a content bound', () => {
  assert.deepEqual(check('Return at most 12 tasks — merge rather than exceed.', SKILL), [])
  assert.deepEqual(check('at most 4 topics', SKILL), [])
})

test('a clean workflow produces no violations', () => {
  const src = [
    'const found = await agent(prompt, { agentType: "agentics:scout", effort: "low" })',
    'if (found.stop_reason !== "exhausted") continue',
  ].join('\n')

  assert.deepEqual(check(src, WF), [])
})
