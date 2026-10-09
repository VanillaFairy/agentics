// test/fast/no-loop-bounds.test.mjs — pins the lint rule that keeps a count from ending a program's
// loop: a loop whose condition, or an `if` in its body that leaves it, compares a counter the loop
// increments against a bound is a finding; a loop over a collection, a loop that ends on a state
// and a loop that asks through askAfter are not.
//
// Design: docs/DESIGN.md#l2--states-end-work-counts-dont and docs/DESIGN.md#self-checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { id, applies, check } from '../../tools/rules/no-loop-bounds.mjs'

const lines = (src) => check(src).map((v) => v.line)

test('its id is no-loop-bounds', () => {
  assert.equal(id, 'no-loop-bounds')
})

test('it applies to the programs, the execute units and lib/run.mjs, and nothing else', () => {
  for (const path of ['lib/programs/survey.mjs', 'lib/programs/common.mjs', 'lib/programs/execute/leaf.mjs', 'lib/run.mjs']) {
    assert.ok(applies.test(path), path)
  }
  for (const path of ['lib/runner.mjs', 'lib/boundaries/merge.mjs', 'lib/brief.mjs', 'tools/lint.mjs', 'skills/develop/SKILL.md',
    'test/fast/no-loop-bounds.test.mjs', 'lib/programs/survey.md']) {
    assert.ok(!applies.test(path), path)
  }
})

test('a for loop whose condition compares its counter to a number is one finding on the loop line', () => {
  assert.deepEqual(lines('const x = 1\nfor (let round = 1; round <= 3; round++) {\n  await go()\n}'), [2])
})

test('a SCREAMING_CASE bound is a bound', () => {
  assert.deepEqual(lines('for (let n = 0; n < MAX_ROUNDS; n++) go()'), [1])
})

test('a name with a max, limit or cap part is a bound', () => {
  assert.deepEqual(lines('let tries = 0\nwhile (tries < limit) {\n  tries += 1\n}'), [2])
  assert.deepEqual(lines('while (attempt < maxAttempts) { attempt++ }'), [1])
  assert.deepEqual(lines('while (r < opts.roundCap) { r = r + 1 }'), [1])
  assert.deepEqual(lines('while (r < max_rounds) { r++ }'), [1])
})

test('a bound on the left of the comparison is a bound', () => {
  assert.deepEqual(lines('for (let i = 0; 5 > i; i++) {}'), [1])
})

test('a do-while whose condition compares its counter is a finding on the while line', () => {
  assert.deepEqual(lines('let n = 0\ndo {\n  n++\n} while (n !== 4)'), [4])
})

test('an if that leaves the loop on its counter is a finding on the if line', () => {
  assert.deepEqual(lines('for (let round = 1; ; round++) {\n  if (round > 3) break\n}'), [2])
  assert.deepEqual(lines('for (;;) {\n  n += 1\n  if (n >= MAX) {\n    return end()\n  }\n}'), [3])
  assert.deepEqual(lines('while (true) {\n  tries++\n  if (tries === 5) throw new Error(why)\n}'), [3])
})

test("an if on the counter that does not leave the loop is no finding", () => {
  assert.deepEqual(lines('for (let n = 0; ; n++) {\n  if (n > 3) log(n)\n  if (done) break\n}'), [])
})

test("a collection's length or size is not a bound", () => {
  assert.deepEqual(lines('for (let i = 0; i < items.length; i++) {}'), [])
  assert.deepEqual(lines('for (let i = 0; i < suspect.length; i += BATCH) batches.push(i)'), [])
  assert.deepEqual(lines('while (i < seen.size) { i++ }'), [])
})

test('a for…of or for…in loop has no counter', () => {
  assert.deepEqual(lines('for (const x of xs) { if (x > 3) break }'), [])
  assert.deepEqual(lines('for (const k in o) { if (k > 3) break }'), [])
})

test('a loop that ends on a state is no finding', () => {
  assert.deepEqual(lines('for (let n = 2; taken.has(key); n++) key = base + n'), [])
  assert.deepEqual(lines('for (let i = 0; i < n; i++) {}'), [])
  assert.deepEqual(lines('while (pending > 0) { pending = await next() }'), [])
})

test('a loop that asks through askAfter is no finding', () => {
  assert.deepEqual(lines('for (let round = 1; ; round++) {\n  if (askAfter(round)) await rule()\n  if (approved) return end()\n}'), [])
})

test('a review loop that asks for a convergence ruling through askAfter is no finding', () => {
  const src = [
    'for (;;) {',
    "  const done = await dispatch(ctx, { role: 'reviewer', brief: reviewerBrief(x) })",
    "  if (done.status !== 'returned') return 'faulted'",
    '  if (askAfter(n)) {',
    "    const ruled = await dispatch(ctx, { role: 'ruler', schema: 'ruler_convergence', brief: convergenceBrief(rounds) })",
    "    if (ruled.output.ruling === 'not_converging') return 'stopped'",
    '  }',
    '  n += 1',
    '}',
  ].join('\n')
  assert.deepEqual(lines(src), [])
})

test('a counter compared outside an exit, or to a call, is no finding', () => {
  assert.deepEqual(lines('for (let n = 1; ; n++) {\n  const s = n === 1 ? a : b\n  if (made(s)) return s\n}'), [])
  assert.deepEqual(lines('for (let i = 0; i < Math.max(a, b); i++) {}'), [])
  assert.deepEqual(lines('for (let i = 0; i < capability; i++) {}'), [])
})

test('a loop in a comment or a string is no finding', () => {
  assert.deepEqual(lines('// for (let i = 0; i < 3; i++) {}\nconst x = "while (n < 3) { n++ }"'), [])
})

test('the message names the counter and askAfter', () => {
  const [v] = check('for (let round = 1; round <= 3; round++) {}')
  assert.match(v.message, /round/)
  assert.match(v.message, /askAfter/)
})
