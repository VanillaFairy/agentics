// test/spec-criterion-paths.test.mjs — pins the check that a producing task's criterion runs only
// paths that exist or that its locus admits, so a test the plan runs is in the plan's locus.
//
// Design: docs/DESIGN.md#the-locus.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { criterionPathProblems } from '../lib/spec.mjs'

const spec = (entries) => ({ file: 'DESIGN.md', entries })
const task = (locus, check, extra = {}) => ({
  name: 't', kind: 'task', rigor: 'tdd', locus, criteria: [{ text: 'c', check, line: 7 }], ...extra,
})
const none = () => false

test('a prefix of a listed file is admitted', () => {
  assert.deepEqual(criterionPathProblems(spec([task(['src/core/wishing/GroundSupply.ts'], 'npx vitest run src/core/wishing/GroundSupply')]), { isPrefix: none }), [])
})

test('a new test beside a listed file is admitted', () => {
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], 'node --test src/a/X.test.mjs')]), { isPrefix: none }), [])
})

test('a path under a directory entry is admitted', () => {
  assert.deepEqual(criterionPathProblems(spec([task(['src/endless/'], 'npx vitest run src/endless/mode.test.ts')]), { isPrefix: none }), [])
})

test('an existing repository path is fine', () => {
  const isPrefix = (t) => 'test/other.test.mjs'.startsWith(t)
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], 'node --test test/other.test.mjs')]), { isPrefix }), [])
})

test('a new test in an unlisted folder is a problem at its criterion line', () => {
  const out = criterionPathProblems(spec([task(['src/a/X.ts'], 'pytest tests/test_x.py')]), { isPrefix: none })
  assert.equal(out.length, 1)
  assert.equal(out[0].line, 7)
  assert.equal(out[0].file, 'DESIGN.md')
  assert.match(out[0].problem, /tests\/test_x\.py/)
})

test('flags, urls and words without a slash are not paths', () => {
  const check = 'npm test -- --reporter=dot https://example.com/x and words'
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], check)]), { isPrefix: none }), [])
})

test('quoted paths are read without their quotes', () => {
  const out = criterionPathProblems(spec([task(['src/a/X.ts'], 'node --test "tests/y.test.mjs"')]), { isPrefix: none })
  assert.match(out[0].problem, /tests\/y\.test\.mjs/)
  assert.doesNotMatch(out[0].problem, /"tests/)
})

test('a verify task and a sub-effort are not checked', () => {
  const verify = task(['src/a/X.ts'], 'node --test tests/z.test.mjs', { rigor: 'verify' })
  const sub = { ...task([], 'node --test tests/z.test.mjs'), kind: 'sub-effort' }
  assert.deepEqual(criterionPathProblems(spec([verify, sub]), { isPrefix: none }), [])
})

test('a criterion with no check is not checked', () => {
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], '')]), { isPrefix: none }), [])
})

test('a non-test file under a directory entry is admitted', () => {
  assert.deepEqual(criterionPathProblems(spec([task(['src/endless/'], 'node src/endless/run.mjs')]), { isPrefix: none }), [])
})

test('a flag that carries a path is not a path', () => {
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], 'node --test --out=tmp/x.json')]), { isPrefix: none }), [])
})
