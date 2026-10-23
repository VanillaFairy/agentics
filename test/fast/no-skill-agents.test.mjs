// test/fast/no-skill-agents.test.mjs — pins the lint rule that keeps every agent behind a program: a
// skill line that calls or names the host's Agent or Task tool, a `subagent_type`, or an
// `agentics:<name>` that is no skill is a finding; the task-list tools, skill names and the
// verbatim markers are not.
//
// Design: docs/DESIGN.md#self-checks and
// docs/DESIGN.md#p2--code-does-what-is-deterministic-models-only-judge.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { id, applies, check } from '../../tools/rules/no-skill-agents.mjs'

const lines = (src) => check(src, 'skills/x/SKILL.md').map((v) => v.line)

test('its id is no-skill-agents', () => {
  assert.equal(id, 'no-skill-agents')
})

test('it applies to every markdown file under skills/, and nothing else', () => {
  for (const path of ['skills/develop/SKILL.md', 'skills/develop/landing.md', 'skills/design/SKILL.md']) assert.ok(applies.test(path), path)
  for (const path of ['roles/scout.md', 'docs/DESIGN.md', 'lib/run.mjs', 'skills/develop/notes.txt', 'README.md']) {
    assert.ok(!applies.test(path), path)
  }
})

test('a call to the Agent or Task tool is a finding on its line', () => {
  assert.deepEqual(lines('# Skill\nRun Task(description) for each topic.'), [2])
  assert.ok(lines("Dispatch it with `Agent({ prompt })`.").length > 0)
})

test('the Agent or Task tool named as a tool is a finding', () => {
  assert.deepEqual(lines('Use the `Agent` tool to start a reviewer.'), [1])
  assert.deepEqual(lines('Start one `Task` per topic.'), [1])
  assert.deepEqual(lines('Start a reviewer with the Agent tool.'), [1])
  assert.deepEqual(lines('Hand it to the Task tool.'), [1])
})

test('a subagent_type is a finding', () => {
  assert.deepEqual(lines('set subagent_type to the role'), [1])
})

test('an agentics: name that is no skill is a finding', () => {
  assert.deepEqual(lines('Hand the topic to agentics:scout.'), [1])
  assert.deepEqual(lines('agentics:courier carries it'), [1])
})

test('every finding on a line is reported', () => {
  assert.equal(lines("`Agent({ subagent_type: 'agentics:scout' })`").length, 3)
})

test('a skill name after agentics: is no finding', () => {
  assert.deepEqual(lines('run `agentics:develop` on it, then `/agentics:design`'), [])
  assert.deepEqual(lines("`Skill({ skill: 'agentics:task', args: '<the request>' })`"), [])
  assert.deepEqual(lines("`Skill({ skill: 'agentics:<skill>', args: '<words>' })`"), [])
})

test('the verbatim markers are no finding', () => {
  assert.deepEqual(lines('<!-- agentics:verbatim effort-store -->\ntext\n<!-- /agentics:verbatim -->'), [])
})

test('the task-list tools and the word Task elsewhere are no finding', () => {
  assert.deepEqual(lines('If the Task tools are not available, fall back to `TodoWrite`.'), [])
  assert.deepEqual(lines('One `TaskCreate` per task, then `TaskUpdate` with `addBlockedBy`; `TaskList` shows them.'), [])
  assert.deepEqual(lines('**Task mode:** list them.'), [])
  assert.deepEqual(lines('An agent session reads it. Agent sessions differ.'), [])
})

test('the message says a program dispatches every agent', () => {
  const [v] = check('Hand the topic to agentics:scout.', 'skills/x/SKILL.md')
  assert.match(v.message, /agentics:scout/)
  assert.match(v.message, /program/)
})

test("the self-improve skill alone may start the plugin's fix agent, and names no agentics agent either", () => {
  const text = 'Hand the fix to one fix agent: start it with the host\'s `Agent` tool.'
  assert.deepEqual(check(text, 'skills/self-improve/SKILL.md'), [])
  assert.ok(check(text, 'skills/develop/SKILL.md').length > 0, 'every other skill still may not')
  assert.ok(check('Start agentics:reviewer.', 'skills/self-improve/SKILL.md').length > 0)
})
