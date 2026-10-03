// test/roles.test.mjs — pins how a role file is read: its frontmatter into a role, its body into
// the system prompt the runner hands the host, and every way a role file is refused.
//
// Design: docs/DESIGN.md#roles.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROLE_KINDS, ROLE_NAMES, loadRole, parseRole, roleFile } from '../lib/roles.mjs'

const front = (fields) => '---\n' + Object.entries(fields).map(([k, v]) => k + ': ' + v).join('\n') + '\n---\n'
const IMPLEMENTER = {
  name: 'implementer', kind: 'producer', tools: 'Read, Grep, Glob, Edit, Write, Bash',
  commands: '<build>, <test>, git add, git commit', schemas: 'producer', model: 'sonnet', effort: 'medium',
}
const BODY = 'You implement one leaf.\n\nReturn your result as the structured output.\n'

test('a role file reads into its name, kind, tools, commands, schemas, tier and prompt', () => {
  const out = parseRole(front(IMPLEMENTER) + BODY, 'implementer')
  assert.equal(out.ok, true)
  assert.equal(out.role.name, 'implementer')
  assert.equal(out.role.kind, 'producer')
  assert.deepEqual(out.role.tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'])
  assert.deepEqual(out.role.commands, ['<build>', '<test>', 'git add', 'git commit'])
  assert.deepEqual(out.role.schemas, ['producer'])
  assert.deepEqual(out.role.tier, { model: 'sonnet', effort: 'medium' })
  assert.equal(out.role.prompt, BODY.trim())
})

test('a role with no commands reads them as none', () => {
  const { commands, ...rest } = IMPLEMENTER
  assert.deepEqual(parseRole(front(rest) + BODY, 'implementer').role.commands, [])
})

test('CRLF role files read like LF ones', () => {
  const text = (front(IMPLEMENTER) + BODY).replace(/\n/g, '\r\n')
  assert.deepEqual(parseRole(text, 'implementer').role.tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'])
})

const refused = (text, name = 'implementer') => {
  const out = parseRole(text, name)
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'role_unreadable')
  assert.ok(out.error.message.length > 0)
}

test('a file without frontmatter is refused', () => refused(BODY))
test('a name that is not the file name is refused', () => refused(front(IMPLEMENTER) + BODY, 'reviewer'))
test('an unknown kind is refused', () => refused(front({ ...IMPLEMENTER, kind: 'boss' }) + BODY))
test('a schema the schema table lacks is refused', () => refused(front({ ...IMPLEMENTER, schemas: 'producer, nothing' }) + BODY))
test('a role with no tools is refused', () => refused(front({ ...IMPLEMENTER, tools: '' }) + BODY))
test('a role with no model is refused', () => refused(front({ ...IMPLEMENTER, model: '' }) + BODY))
test('an empty prompt is refused', () => refused(front(IMPLEMENTER) + '\n'))

test('the role names and kinds are the design table', () => {
  assert.deepEqual(ROLE_NAMES, ['scout', 'historian', 'doc-researcher', 'analyst', 'ruler', 'reviewer', 'auditor',
    'planner', 'implementer', 'test-author', 'investigator'])
  assert.deepEqual(ROLE_KINDS, ['producer', 'searcher', 'judge'])
})

test('loadRole reads roles/<name>.md under the given root', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agentics-roles-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'roles'))
  writeFileSync(join(root, 'roles', 'implementer.md'), front(IMPLEMENTER) + BODY)
  assert.equal(roleFile('implementer', root), join(root, 'roles', 'implementer.md'))
  assert.equal(loadRole('implementer', { root }).role.kind, 'producer')
  assert.equal(loadRole('reviewer', { root }).error.kind, 'role_unreadable')
})
