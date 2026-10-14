// test/fast/no-turn-caps.test.mjs — pins IL1: completion is defined by the goal,
// never by a counter.
//
// The hard part is not detecting `maxTurns`. It is NOT detecting the three legitimate
// numeric patterns that ship in this very plugin: MAX_ROUNDS (the §3 resume threshold),
// the "around N tool calls, check for convergence" self-check in every search agent, and
// content bounds like "at most 12 tasks". A rule that flags those is worse than no rule,
// because it will be switched off and take §1 with it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { lintSource } from '../../tools/lint.mjs'
import { id, applies, check } from '../../tools/rules/no-turn-caps.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const PROGRAM = 'lib/programs/survey.mjs'
const SKILL = 'skills/investigate/SKILL.md'

test('it applies to SKILL.md, the role files, the programs and lib/run.mjs — not to workflows, tools or the rest of lib', () => {
  // A cap written into a role file reaches every dispatch of that role, and CLAUDE.md's clause
  // table assigns IL1 to this rule alone. The programs and lib/run.mjs start every dispatch, so
  // they are in scope too.
  assert.ok(applies.test(PROGRAM))
  assert.ok(!applies.test('service-workflows/gather-evidence-without-concluding.workflow.js'))
  assert.ok(applies.test(SKILL))
  assert.ok(applies.test('roles/scout.md'))
  assert.ok(!applies.test('roles/drafts/scout.md'))
  assert.ok(!applies.test('agents/scout.md'))
  assert.ok(applies.test('lib/programs/survey.mjs'))
  assert.ok(applies.test('lib/programs/common.mjs'))
  assert.ok(applies.test('lib/programs/converge.mjs'))
  assert.ok(applies.test('lib/programs/search/loop.mjs'))
  assert.ok(applies.test('lib/programs/execute/leaf.mjs'))
  assert.ok(!applies.test('lib/programs/search/nested/x.mjs'))
  assert.ok(applies.test('lib/run.mjs'))
  assert.ok(!applies.test('lib/store.mjs'))
  assert.ok(!applies.test('lib/briefs/survey.mjs'))
  assert.ok(!applies.test('tools/lint.mjs'))
  assert.ok(!applies.test('docs/superpowers/plans/x/tasks/T05-agents.md'))
})

test('flags a max_turns in a program file and in lib/run.mjs, on its line', () => {
  const src = ['const call = {', '  max_turns: 30,', '}'].join('\n')
  for (const path of ['lib/programs/survey.mjs', 'lib/run.mjs']) {
    const found = lintSource(src, path, [{ id, applies, check }])
    assert.deepEqual(found.map((f) => [f.file, f.rule, f.line]), [[path, id, 2]], path)
  }
})

test('a cap written into a role file is flagged on its line', () => {
  const src = ['---', 'name: scout', '---', 'Search until you are done.', 'Stop after 10 tool calls and report.'].join('\n')
  const found = lintSource(src, 'roles/scout.md', [{ id, applies, check }])
  assert.deepEqual(found.map((f) => [f.file, f.rule, f.line]), [['roles/scout.md', id, 5]])
})

test('the shipped role files are judged and carry no cap', () => {
  const roles = readdirSync(join(ROOT, 'roles')).filter((name) => name.endsWith('.md'))
  assert.ok(roles.length > 0, 'no role files found')
  for (const name of roles) {
    const path = 'roles/' + name
    assert.ok(applies.test(path), path + ' is not judged')
    assert.deepEqual(check(readFileSync(join(ROOT, path), 'utf8'), path), [], path)
  }
})

test('a loop that ends on a state is not a cap, however it counts', () => {
  for (const src of ['  for (let n = 2; taken.has(key); n++) {', '  for (let round = 1; ; round++) {']) {
    assert.deepEqual(check(src, 'lib/programs/probe.mjs'), [], src)
  }
})

test('the shipped programs and lib/run.mjs are judged and carry no cap', () => {
  const paths = [
    ...readdirSync(join(ROOT, 'lib', 'programs'), { recursive: true }).map((name) => 'lib/programs/' + name.replaceAll('\\', '/')).filter((p) => p.endsWith('.mjs')),
    'lib/run.mjs',
  ]
  for (const path of paths) {
    assert.ok(applies.test(path), path + ' is not judged')
    assert.deepEqual(check(readFileSync(join(ROOT, path), 'utf8'), path), [], path)
  }
})

test('flags maxTurns and reports its line', () => {
  const src = ['const opts = {', '  maxTurns: 5,', '}'].join('\n')

  const found = check(src, PROGRAM)
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 2)
  assert.match(found[0].message, /IL1/)
})

test('flags every identifier spelling of a turn or tool-call cap', () => {
  for (const key of ['maxTurns', 'max_turns', 'maxToolCalls', 'max_tool_calls']) {
    assert.equal(check(`  ${key}: 20,`, PROGRAM).length, 1, `${key} should be flagged`)
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

  assert.equal(check(src, PROGRAM).length, 2, 'both mentions should be flagged')
  assert.equal(check('  maxRounds: 3,', PROGRAM).length, 1)
})

test('a bare round counter used only for labels is not a cap', () => {
  assert.deepEqual(check('  const label = `scout round ${round}`', PROGRAM), [])
  assert.deepEqual(check('  round += 1', PROGRAM), [])
})

test('does NOT flag a convergence self-check', () => {
  const src = 'Around 25 tool calls, pause and check yourself: are you converging?'
  assert.deepEqual(check(src, SKILL), [])
})

test('does NOT flag a content bound', () => {
  assert.deepEqual(check('Return at most 12 tasks — merge rather than exceed.', SKILL), [])
  assert.deepEqual(check('at most 4 topics', SKILL), [])
})

test('a clean program loop produces no violations', () => {
  const src = [
    "const found = await dispatch(ctx, { role: 'scout', schema: 'scout_hits', brief })",
    "if (found.stop_reason !== 'exhausted') continue",
  ].join('\n')

  assert.deepEqual(check(src, PROGRAM), [])
})
