// test/fast/role-allowlists.test.mjs — pins each role's kind, tools, commands and schemas. A change to
// one is a deliberate edit of this table in the same commit (CLAUDE.md).
//
// Design: docs/DESIGN.md#roles.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { loadRole, ROLE_NAMES } from '../../lib/roles.mjs'

const ROLES = fileURLToPath(new URL('../../roles/', import.meta.url))

const PINNED = {
  scout: { kind: 'searcher', tools: ['Glob', 'Grep', 'Read'], commands: [], schemas: ['scout_hits', 'scout_located'] },
  historian: {
    kind: 'searcher', tools: ['Bash', 'Grep', 'Read'], commands: ['git log', 'git show', 'git blame', 'git diff'], schemas: ['historian'],
  },
  'doc-researcher': { kind: 'searcher', tools: ['Read', 'WebFetch', 'WebSearch'], commands: [], schemas: ['doc_research', 'candidates'] },
  planner: { kind: 'producer', tools: ['Edit', 'Glob', 'Grep', 'Read', 'Write'], commands: [], schemas: ['planner_write', 'planner_settle'] },
  implementer: {
    kind: 'producer', tools: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'],
    commands: ['<build>', '<typecheck>', '<test>', 'git add', 'git commit', 'git status', 'git diff', 'git log'], schemas: ['producer'],
  },
  'test-author': { kind: 'producer', tools: ['Edit', 'Glob', 'Grep', 'Read', 'Write'], commands: [], schemas: ['producer'] },
  investigator: { kind: 'producer', tools: ['Bash', 'Glob', 'Grep', 'Read'], commands: ['*'], schemas: ['investigator'] },
  analyst: {
    kind: 'judge', tools: ['Read'], commands: [],
    schemas: ['survey_plan', 'items', 'rejudge', 'axes', 'prober', 'frame', 'assessment', 'approach', 'investigate_tasks', 'investigate_report'],
  },
  ruler: { kind: 'judge', tools: ['Read'], commands: [], schemas: ['ruler_premises', 'ruler_convergence'] },
  reviewer: { kind: 'judge', tools: ['Bash', 'Glob', 'Grep', 'Read'], commands: ['git diff', 'git log', 'git show'], schemas: ['reviewer'] },
  auditor: { kind: 'judge', tools: ['Glob', 'Grep', 'Read'], commands: [], schemas: ['auditor'] },
}

const files = () => readdirSync(ROLES).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))

test('every role file loads', () => {
  for (const name of files()) {
    const out = loadRole(name)
    assert.equal(out.ok, true, name + ': ' + (out.error && out.error.message))
  }
})

test('every role file is pinned', () => {
  for (const name of files()) assert.ok(Object.hasOwn(PINNED, name), 'roles/' + name + '.md has no row here')
})

test('every role keeps its pinned kind, tools, commands and schemas', () => {
  for (const [name, pin] of Object.entries(PINNED)) {
    const { role } = loadRole(name)
    assert.equal(role.kind, pin.kind, name)
    assert.deepEqual([...role.tools].sort(), pin.tools, name)
    assert.deepEqual(role.commands, pin.commands, name)
    assert.deepEqual(role.schemas, pin.schemas, name)
  }
})

test('no role prompt tells the agent to write a file for a reader', () => {
  for (const name of files()) {
    const { role } = loadRole(name)
    assert.doesNotMatch(role.prompt, /return file|said file|report file|progress file|courier|the file your dispatch names/i, name)
  }
})

test('every role the design names has a file', () => {
  assert.deepEqual(files().sort(), [...ROLE_NAMES].sort())
})

test('no judge can write a file', () => {
  for (const [name, pin] of Object.entries(PINNED)) {
    if (pin.kind === 'judge') assert.ok(!pin.tools.includes('Edit') && !pin.tools.includes('Write'), name)
  }
})
