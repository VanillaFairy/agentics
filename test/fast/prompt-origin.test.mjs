// test/fast/prompt-origin.test.mjs — pins the lint rule that keeps every prompt in the brief modules:
// in a program or a boundary, a `brief`, `threadBrief` or `prompt` whose value is text made on the
// spot (a string literal, a template literal, a `+` concatenation), directly or through a name
// bound to it, is a finding; a value a call returns is not.
//
// Design: docs/DESIGN.md#self-checks and docs/DESIGN.md#briefs-and-returns.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { id, applies, check } from '../../tools/rules/prompt-origin.mjs'

const lines = (src) => check(src).map((v) => v.line)

test('its id is prompt-origin', () => {
  assert.equal(id, 'prompt-origin')
})

test('it applies to the programs and the boundaries, and nothing else', () => {
  for (const path of ['lib/programs/survey.mjs', 'lib/programs/execute/leaf.mjs', 'lib/boundaries/leaf-open.mjs']) {
    assert.ok(applies.test(path), path)
  }
  for (const path of ['lib/brief.mjs', 'lib/briefs/survey.mjs', 'lib/conversation.mjs', 'lib/run.mjs', 'lib/respec.mjs',
    'tools/lint.mjs', 'skills/design/SKILL.md', 'test/fast/prompt-origin.test.mjs']) {
    assert.ok(!applies.test(path), path)
  }
})

test('a string literal as a brief is one finding on its line', () => {
  assert.deepEqual(lines("const a = 1\nawait dispatch(ctx, { role: 'scout', brief: 'Find the parser.' })"), [2])
})

test('a template literal as a brief is a finding', () => {
  assert.deepEqual(lines('await dispatch(ctx, { role: \'scout\', brief: `Find ${x}.` })'), [1])
})

test('a concatenation as a brief is a finding', () => {
  assert.deepEqual(lines("await dispatch(ctx, { role: 'scout', brief: 'Find ' + x })"), [1])
  assert.deepEqual(lines('await dispatch(ctx, { brief: head + tail })'), [1])
  assert.deepEqual(lines("await dispatch(ctx, {\n  role: 'scout',\n  brief: 'Find ' +\n    topic,\n})"), [3])
})

test('threadBrief and prompt are judged as brief is', () => {
  assert.deepEqual(lines("const spec = { role: 'analyst', threadBrief: 'Judge these.' }"), [1])
  assert.deepEqual(lines('deliver(ctx, { prompt: `Go on.` })'), [1])
})

test('a name bound to made text is judged by its binding, on the property line', () => {
  assert.deepEqual(lines("const text = 'Find ' + topic\nawait dispatch(ctx, { brief: text })"), [2])
  assert.deepEqual(lines("let p = scoutBrief(a)\nif (b) p = 'Search again.'\nawait dispatch(ctx, { brief: p })"), [3])
  assert.deepEqual(lines('const brief = `Find ${x}`\nawait dispatch(ctx, { role: \'scout\', brief })'), [2])
})

test("each branch of a conditional and each operand of ||, ?? and && is judged", () => {
  assert.deepEqual(lines("await dispatch(ctx, { brief: fresh ? scoutBrief(a) : 'Go on.' })"), [1])
  assert.deepEqual(lines("await dispatch(ctx, { threadBrief: answer || 'Write the spec.' })"), [1])
  assert.deepEqual(lines("await dispatch(ctx, { brief: given ?? 'Write the spec.' })"), [1])
})

test('a default in a pattern is judged as its value', () => {
  assert.deepEqual(lines("function f({ brief = 'Find it.' }) {}"), [1])
})

test('a value a call returns is no finding', () => {
  assert.deepEqual(lines('await dispatch(ctx, { brief: scoutBrief({ question, topic }) })'), [])
  assert.deepEqual(lines("await dispatch(ctx, { brief: renderMessage({ msg: 'cut_off' }) })"), [])
  assert.deepEqual(lines("await dispatch(ctx, { brief: readFileSync(path, 'utf8') })"), [])
  assert.deepEqual(lines('const brief = leafBrief(repo, effort, id)\nawait dispatch(ctx, { brief: brief.text })'), [])
})

test('a member, and a name bound to a call, are no finding', () => {
  assert.deepEqual(lines('await dispatch(ctx, { threadBrief: opened.brief })'), [])
  assert.deepEqual(lines("const answer = q ? plannerBrief(a) : ''\nconst planner = { threadBrief: answer || plannerBrief(b) }"), [])
})

test('an empty string is no prompt', () => {
  assert.deepEqual(lines("return { brief: '' }"), [])
})

test('other properties, a ternary operand named prompt, comments and strings are no finding', () => {
  assert.deepEqual(lines("await dispatch(ctx, { thread: 'scout:' + key, brief: scoutBrief(a) })"), [])
  assert.deepEqual(lines('const x = cond ? prompt : other'), [])
  assert.deepEqual(lines("// dispatch(ctx, { brief: 'x' })\nconst s = \"{ brief: 'x' }\""), [])
  assert.deepEqual(lines('export async function deliver(ctx, { thread, brief, carries }) { return go(brief) }'), [])
})

test('the message names the property and the brief modules', () => {
  const [v] = check("await dispatch(ctx, { threadBrief: 'Judge these.' })")
  assert.match(v.message, /threadBrief/)
  assert.match(v.message, /lib\/brief\.mjs/)
  assert.match(v.message, /renderMessage/)
})
