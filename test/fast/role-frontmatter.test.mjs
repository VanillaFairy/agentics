// test/fast/role-frontmatter.test.mjs — pins the role-frontmatter rule: a role file's frontmatter
// is judged when it is committed, by the shape lib/roles.mjs loads at run time.
//
// Design: docs/DESIGN.md#roles and docs/DESIGN.md#self-checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EFFORTS, MODELS, ROLE_KINDS, ROLE_NAMES } from '../../lib/roles.mjs'
import { SCHEMAS } from '../../lib/schemas.mjs'
import { lintSource } from '../../tools/lint.mjs'
import * as rule from '../../tools/rules/role-frontmatter.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const FILE = 'roles/scout.md'
const GOOD = [
  '---', 'name: scout', 'kind: searcher', 'tools: Read, Grep, Glob', 'schemas: search_repo',
  'model: sonnet', 'effort: low', '---', '', 'You find code.',
].join('\n')

const lint = (source, path = FILE) => lintSource(source, path, [rule])
/** The 1-based line of the first line of `source` starting with `prefix`. */
const lineOf = (source, prefix) => {
  const i = source.split('\n').findIndex((l) => l.startsWith(prefix))
  assert.ok(i >= 0, 'no line starts with ' + JSON.stringify(prefix))
  return i + 1
}
/** The source with the line starting `prefix` replaced by `line`, or dropped when `line` is null. */
const edit = (prefix, line) => GOOD.split('\n').flatMap((l) => (l.startsWith(prefix) ? (line === null ? [] : [line]) : [l])).join('\n')

test('the rule id matches its file and it applies to roles/*.md only', () => {
  assert.equal(rule.id, 'role-frontmatter')
  for (const [path, judged] of [
    ['roles/scout.md', true], ['roles/drafts/scout.md', false], ['agents/scout.md', false],
    ['skills/develop/SKILL.md', false], ['lib/roles.mjs', false],
  ]) {
    assert.equal(rule.applies.test(path), judged, path)
    assert.equal(rule.applies.test(path), judged, path + ', asked again')
  }
})

test('a well-formed role passes', () => {
  assert.deepEqual(lint(GOOD), [])
})

test('every shipped role file is judged and passes', () => {
  const names = readdirSync(join(ROOT, 'roles')).filter((f) => f.endsWith('.md'))
  assert.deepEqual(names.map((f) => f.slice(0, -3)).sort(), [...ROLE_NAMES].sort())
  for (const name of names) {
    const path = 'roles/' + name
    assert.ok(rule.applies.test(path), path + ' is not judged')
    assert.deepEqual(lint(readFileSync(join(ROOT, path), 'utf8'), path), [], path)
  }
})

test('a file without a closed frontmatter block is flagged once, at line 0', () => {
  for (const source of ['You find code.', GOOD.replace(/\n---\n/, '\n')]) {
    const found = lint(source)
    assert.deepEqual(found.map((f) => [f.file, f.rule, f.line]), [[FILE, 'role-frontmatter', 0]], source)
  }
})

test('each required key missing is flagged, naming it', () => {
  for (const key of ['name', 'kind', 'tools', 'schemas', 'model', 'effort']) {
    const found = lint(edit(key + ':', null))
    assert.ok(found.some((f) => f.message.includes('`' + key + '`')), key + ': ' + JSON.stringify(found))
  }
})

test('each required key left empty is flagged on its line', () => {
  for (const key of ['name', 'kind', 'tools', 'schemas', 'model', 'effort']) {
    const source = edit(key + ':', key + ':')
    const found = lint(source).filter((f) => f.message.includes('`' + key + '`'))
    assert.deepEqual(found.map((f) => f.line), [lineOf(source, key + ':')], key)
  }
})

test('commands may be left out', () => {
  assert.ok(!GOOD.includes('commands:'))
  assert.deepEqual(lint(GOOD), [])
})

test('a name that is not the file name is flagged on its line, naming both', () => {
  const source = edit('name:', 'name: searcher')
  const found = lint(source)
  assert.equal(found.length, 1, JSON.stringify(found))
  assert.equal(found[0].line, lineOf(source, 'name:'))
  assert.match(found[0].message, /searcher/)
  assert.match(found[0].message, /scout/)
})

test('a role file whose name is no role of lib/roles.mjs is flagged', () => {
  const source = edit('name:', 'name: boss')
  const found = lint(source, 'roles/boss.md')
  assert.equal(found.length, 1, JSON.stringify(found))
  assert.match(found[0].message, /boss/)
})

test('a kind, a model or an effort outside its table is flagged on its line, naming it', () => {
  for (const [key, bad] of [['kind', 'boss'], ['model', 'gpt-4'], ['effort', 'extreme']]) {
    const source = edit(key + ':', key + ': ' + bad)
    const found = lint(source)
    assert.equal(found.length, 1, key + ': ' + JSON.stringify(found))
    assert.equal(found[0].line, lineOf(source, key + ':'), key)
    assert.match(found[0].message, new RegExp(bad), key)
  }
})

test('every kind, model and effort of the tables passes', () => {
  for (const kind of ROLE_KINDS) assert.deepEqual(lint(edit('kind:', 'kind: ' + kind)), [], kind)
  for (const model of MODELS) assert.deepEqual(lint(edit('model:', 'model: ' + model)), [], model)
  for (const effort of EFFORTS) assert.deepEqual(lint(edit('effort:', 'effort: ' + effort)), [], effort)
})

test('a schema lib/schemas.mjs does not export is flagged, naming it', () => {
  assert.ok(!Object.hasOwn(SCHEMAS, 'scout_guesses'))
  const source = edit('schemas:', 'schemas: search_repo, scout_guesses')
  const found = lint(source)
  assert.equal(found.length, 1, JSON.stringify(found))
  assert.equal(found[0].line, lineOf(source, 'schemas:'))
  assert.match(found[0].message, /scout_guesses/)
})

test('commands on a role without Bash are flagged; with Bash they pass', () => {
  const without = edit('effort:', 'effort: low\ncommands: git log')
  const found = lint(without)
  assert.equal(found.length, 1, JSON.stringify(found))
  assert.equal(found[0].line, lineOf(without, 'commands:'))
  assert.match(found[0].message, /Bash/)
  assert.deepEqual(lint(without.replace('tools: Read, Grep, Glob', 'tools: Read, Grep, Bash')), [])
})

test('a key the loader does not read is flagged on its line', () => {
  for (const key of ['schema', 'Tools', 'description']) {
    const source = edit('effort:', 'effort: low\n' + key + ': x')
    const found = lint(source)
    assert.ok(found.some((f) => f.line === lineOf(source, key + ':') && f.message.includes(key)), key + ': ' + JSON.stringify(found))
  }
})

test('a CRLF role file is judged like an LF one, on the same lines', () => {
  assert.deepEqual(lint(GOOD.replace(/\n/g, '\r\n')), [])
  const source = edit('model:', 'model: nope')
  assert.deepEqual(lint(source.replace(/\n/g, '\r\n')).map((f) => f.line), [lineOf(source, 'model:')])
})
