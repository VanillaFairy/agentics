// test/fast/coverage-block-programs.test.mjs — pins L1 over the programs: a program's result is built by
// its module-local `resultOf`, and `resultOf` returns an object carrying a coverage block. The
// shared modules `common.mjs` and `converge.mjs` build no program result and are not judged.
//
// Design: docs/DESIGN.md#coverage-block and docs/DESIGN.md#self-checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROGRAM_NAMES } from '../../lib/run.mjs'
import { lintSource } from '../../tools/lint.mjs'
import * as rule from '../../tools/rules/coverage-block.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PROGRAM = 'lib/programs/drafts.mjs'
const lint = (lines, path = PROGRAM) => lintSource(lines.join('\n'), path, [rule])
const lineOf = (lines, exact) => {
  const i = lines.indexOf(exact)
  assert.ok(i >= 0, 'the fixture has no line ' + JSON.stringify(exact))
  return i + 1
}

/** A program module around the lines given: an import, its ARGS, those lines, and its entry. */
const program = (...body) => [
  "import { coverageOf } from './common.mjs'",
  '',
  'export const ARGS = { question_file: { kind: \'file\', required: true, as: \'question\' } }',
  '',
  ...body,
  '',
  'export async function drafts(ctx, args) {',
  '  return resultOf(ctx, [])',
  '}',
]

const RESULT_OF = 'function resultOf(ctx, drafted) {'

test('a program whose resultOf returns a coverage block passes', () => {
  assert.deepEqual(lint(program(RESULT_OF, '  return { drafts: drafted, coverage: coverageOf({ resumable: ctx.resumable }) }', '}')), [])
})

test('the shorthand coverage key passes, as a resultOf that names its block first writes it', () => {
  assert.deepEqual(lint(program(
    RESULT_OF,
    '  const coverage = coverageOf({ resumable: ctx.resumable })',
    '  return {',
    '    drafts: drafted,',
    '    coverage,',
    '  }',
    '}',
  )), [])
})

test('a program file without resultOf is flagged, naming the file', () => {
  const found = lint(program('const unused = 1'))
  assert.equal(found.length, 1)
  assert.deepEqual([found[0].file, found[0].rule, found[0].line], [PROGRAM, 'coverage-block', 0])
  assert.match(found[0].message, /resultOf/)
})

test('a program whose resultOf builds no coverage is flagged at its resultOf', () => {
  const lines = program(RESULT_OF, '  return { drafts: drafted }', '}')
  const found = lint(lines)
  assert.equal(found.length, 1)
  assert.deepEqual([found[0].file, found[0].line], [PROGRAM, lineOf(lines, RESULT_OF)])
  assert.match(found[0].message, /coverage/)
})

test('a coverage block built outside resultOf does not satisfy the rule', () => {
  const lines = program(
    RESULT_OF,
    '  return { drafts: drafted }',
    '}',
    '',
    'function other(ctx) {',
    '  return { coverage: coverageOf({ resumable: ctx.resumable }) }',
    '}',
  )
  const found = lint(lines)
  assert.equal(found.length, 1)
  assert.equal(found[0].line, lineOf(lines, RESULT_OF))
})

test('a coverage key inside a string or a comment in resultOf does not count', () => {
  for (const body of ["  return { drafts: drafted, note: ', coverage: x' }", '  return { drafts: drafted /* , coverage: x */ }']) {
    const lines = program(RESULT_OF, body, '}')
    assert.equal(lint(lines).length, 1, body)
  }
})

test('an empty or null coverage in resultOf is flagged', () => {
  for (const value of ['{}', 'null']) {
    const lines = program(RESULT_OF, '  return { drafts: drafted, coverage: ' + value + ' }', '}')
    const found = lint(lines)
    assert.equal(found.length, 1, value)
    assert.equal(found[0].line, lineOf(lines, RESULT_OF), value)
  }
})

test('resultOf is read to its body past braces and parentheses in its parameters', () => {
  const head = 'function resultOf({ question, lists = {}, resumable = null }, { rulerLost = false } = {}, at = now(), { extra = {} } = {}) {'
  assert.deepEqual(lint(program(head, '  return { question, coverage: coverageOf({ ...lists, resumable }) }', '}')), [])
  const lines = program(head, '  return { question }', '}')
  assert.deepEqual(lint(lines).map((f) => f.line), [lineOf(lines, head)])
})

test('a bare return in a program\'s helper is not flagged', () => {
  assert.deepEqual(lint(program(
    'function skip(x) {',
    '  if (!x) {',
    '    return',
    '  }',
    '}',
    '',
    RESULT_OF,
    '  return { drafts: drafted, coverage: coverageOf({ resumable: ctx.resumable }) }',
    '}',
  )), [])
})

test('common.mjs and converge.mjs are not judged', () => {
  for (const name of ['common.mjs', 'converge.mjs']) {
    const path = 'lib/programs/' + name
    assert.equal(rule.applies.test(path), false, path)
    assert.deepEqual(lintSource(readFileSync(join(ROOT, path), 'utf8'), path, [rule]), [], path)
  }
})

test('every shipped program is judged and passes', () => {
  const judged = readdirSync(join(ROOT, 'lib', 'programs')).map((name) => 'lib/programs/' + name).filter((path) => rule.applies.test(path))
  for (const name of PROGRAM_NAMES) assert.ok(judged.includes('lib/programs/' + name + '.mjs'), name + ' is not judged')
  for (const path of judged) assert.deepEqual(lintSource(readFileSync(join(ROOT, path), 'utf8'), path, [rule]), [], path)
})

test('the rule applies to the program files and to nothing else, whatever it was asked before', () => {
  // A /g flag would make RegExp.test() carry lastIndex between calls, and tools/lint.mjs tests this
  // one object against every file in the tree, so each path is asked twice.
  for (const [path, judged] of [
    [PROGRAM, true], ['lib/programs/execute/leaf.mjs', false], ['lib/run.mjs', false],
    ['service-workflows/gather-evidence-without-concluding.workflow.js', false], ['roles/scout.md', false],
  ]) {
    assert.equal(rule.applies.test(path), judged, path)
    assert.equal(rule.applies.test(path), judged, path + ', asked again')
  }
})

test('braces and an apostrophe in template literals do not hide the coverage resultOf returns', () => {
  assert.deepEqual(lint(program(
    "const NOTE = `Don't stop: reply with { hits: [] } and write nothing after the closing }.`",
    '',
    RESULT_OF,
    '  return { drafts: drafted, note: `Reply with { hits: [] }. Nothing after }.`, coverage: coverageOf({ resumable: ctx.resumable }) }',
    '}',
  )), [])
})

test('a key that merely ends in coverage, or a coverage key inside a template literal, does not count', () => {
  for (const body of ['  return { drafts: drafted, has_coverage: true }', '  return { drafts: drafted, note: `{ coverage: { complete: true } }` }']) {
    const lines = program(RESULT_OF, body, '}')
    assert.deepEqual(lint(lines).map((f) => f.line), [lineOf(lines, RESULT_OF)], body)
  }
})
