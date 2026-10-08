// test/agent-frontmatter.test.mjs — this rule is the test for the four agent files.
//
// Agent markdown cannot be imported or unit-tested, so its correctness is enforced here.
// The name/filename check is the one that matters most: a mismatch produces an agent that
// exists but is unreachable under the name every workflow uses to call it, and nothing
// fails until a run is already underway.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { id, applies, check } from '../../tools/rules/agent-frontmatter.mjs'

const FILE = 'agents/scout.md'

const good = [
  '---',
  'name: scout',
  'description: Read-only code search across one or more repositories.',
  'tools: Read, Grep, Glob',
  'model: sonnet',
  '---',
  '',
  'You find code.',
].join('\n')

test('it applies to agents/*.md only', () => {
  assert.ok(applies.test('agents/scout.md'))
  assert.ok(!applies.test('skills/investigate/SKILL.md'))
  assert.ok(!applies.test('workflows/agentics-survey.workflow.js'))
  assert.ok(!applies.test('CLAUDE.md'))
})

test('a well-formed agent produces no violations', () => {
  assert.deepEqual(check(good, FILE), [])
})

test('flags a missing frontmatter block at line 0', () => {
  const found = check('You find code.', FILE)
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 0)
  assert.match(found[0].message, /frontmatter/)
})

test('flags each missing required key', () => {
  for (const key of ['name', 'description', 'tools', 'model']) {
    const src = good.split('\n').filter((l) => !l.startsWith(`${key}:`)).join('\n')
    const found = check(src, FILE)
    assert.ok(
      found.some((v) => v.message.includes(key)),
      `removing ${key} should be flagged`,
    )
  }
})

test('flags an empty required value', () => {
  const src = good.replace('tools: Read, Grep, Glob', 'tools:')
  const found = check(src, FILE)
  assert.ok(found.some((v) => v.message.includes('tools')))
})

test('flags a name that does not match the filename stem', () => {
  const src = good.replace('name: scout', 'name: searcher')
  const found = check(src, FILE)

  assert.equal(found.length, 1)
  assert.match(found[0].message, /searcher/)
  assert.match(found[0].message, /scout/)
})

test('flags an unknown model', () => {
  const src = good.replace('model: sonnet', 'model: gpt-4')
  const found = check(src, FILE)

  assert.equal(found.length, 1)
  assert.match(found[0].message, /gpt-4/)
})

test('accepts every allowed model', () => {
  for (const model of ['sonnet', 'opus', 'haiku', 'fable', 'inherit']) {
    const src = good.replace('model: sonnet', `model: ${model}`)
    assert.deepEqual(check(src, FILE), [], `${model} should be allowed`)
  }
})

test('a CRLF file is parsed exactly like an LF one', () => {
  // Every fixture above is LF-joined, but `core.autocrlf` is true on Windows, so files on
  // disk after a checkout carry \r\n. The opening delimiter was matched with .trim() while
  // the closing one used an exact indexOf, so the terminator "---\r" was never found and
  // every real agent file was reported as having no frontmatter. Invisible in the authoring
  // worktree (the Write tool emits LF), visible on any fresh clone.
  assert.deepEqual(check(good.replace(/\n/g, '\r\n'), FILE), [])
})

test('a bad value in a CRLF file is still reported on the real line', () => {
  const src = good.replace('model: sonnet', 'model: nope').replace(/\n/g, '\r\n')
  const found = check(src, FILE)

  assert.equal(found.length, 1)
  assert.equal(found[0].line, 5)
  assert.match(found[0].message, /nope/)
})

test('reports the real line for a bad value', () => {
  const src = good.replace('model: sonnet', 'model: nope')
  const found = check(src, FILE)
  assert.equal(found[0].line, 5)
})
