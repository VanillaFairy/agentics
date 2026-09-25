// test/task-tool-fallback.test.mjs — pins the rule that a skill depending on the host's
// optional Task tools must name a fallback (IL2, applied to the landing step).
//
// The failure this guards is quiet by construction: on a host with no Task tools the session
// improvises into TodoWrite, `blocked_by` has nowhere to go, and the user gets an unordered
// list that looks exactly like an ordered one. Nothing throws, so only a rule catches it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { id, applies, check } from '../tools/rules/task-tool-fallback.mjs'

const FILE = 'skills/investigate/SKILL.md'

test('it applies to skills and nothing else', () => {
  assert.ok(applies.test('skills/investigate/SKILL.md'))
  assert.ok(applies.test('skills/develop/SKILL.md'))
  assert.ok(!applies.test('agents/scout.md'))
  assert.ok(!applies.test('workflows/agentics-survey.workflow.js'))
  assert.ok(!applies.test('docs/superpowers/specs/design.md'))
})

test('flags a skill that lands through the Task tools with no fallback named', () => {
  const src = [
    '## Step 3 — Land the result',
    '',
    '1. `TaskList` first, to avoid duplicating tasks that already exist.',
    '2. One `TaskCreate` per returned task.',
  ].join('\n')

  const found = check(src, FILE)
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 3, 'anchors to the first Task-tool mention')
  assert.match(found[0].message, /TaskList/)
  assert.match(found[0].message, /TodoWrite/)
})

test('one finding per file, not one per mention — the gap is the missing fallback', () => {
  // Three mentions are one defect. Reporting each would bury the single fix under repeats.
  const src = 'Use `TaskCreate`, then `TaskUpdate`, having called `TaskList` first.'
  assert.equal(check(src, FILE).length, 1)
})

test('accepts a skill that names the fallback', () => {
  const src = [
    '1. `TaskCreate` per returned task.',
    '',
    'If the Task tools are not available, fall back to `TodoWrite` and say that you did.',
  ].join('\n')

  assert.deepEqual(check(src, FILE), [])
})

test('a skill that never touches the Task tools is not asked for a fallback', () => {
  const src = '## Step 3 — Land the result\n\nHand back `result.report` as it stands.'
  assert.deepEqual(check(src, FILE), [])
})

test('the fallback counts wherever it appears, before or after the dependency', () => {
  const before = 'TodoWrite is the fallback.\n\nNormally use `TaskCreate`.'
  const after = 'Normally use `TaskCreate`.\n\nTodoWrite is the fallback.'
  assert.deepEqual(check(before, FILE), [])
  assert.deepEqual(check(after, FILE), [])
})

test('a bare mention of the word Task is not a tool reference', () => {
  const src = 'Do not start the work. The Task tools are the host\'s, not yours.'
  assert.deepEqual(check(src, FILE), [])
})

test('check is stateless: the same source always yields the same violations', () => {
  // The tool pattern is a /g regex shared across calls. matchAll clones it, but a stray
  // .test() on it would carry lastIndex and make every second call disagree with the first.
  const src = '`TaskCreate` per returned task, then `TaskUpdate`.'
  assert.deepEqual(check(src, FILE), check(src, FILE))
  assert.deepEqual(check(src, FILE), check(src, FILE))
})

test('every skill shipped in this plugin satisfies the rule', () => {
  // The rule is only worth having if the plugin's own skills pass it. This is the integration
  // check every rule's suite ends with.
  const root = fileURLToPath(new URL('..', import.meta.url))
  const skills = readdirSync(new URL('../skills', import.meta.url), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `skills/${e.name}/SKILL.md`)

  assert.ok(skills.length > 0, 'no skills found — the glob or the layout changed')

  for (const rel of skills) {
    const found = check(readFileSync(root + rel, 'utf8'), rel)
    assert.deepEqual(found, [], `${rel}: ${found.map((f) => f.message).join(' ')}`)
  }
})
