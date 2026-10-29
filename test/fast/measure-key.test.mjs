// test/fast/measure-key.test.mjs — `measureKey` in lib/measure.mjs: what a measurement's key
// covers — the checks, the approved files, the expected files, the fences — and none of where or
// for whom the measurement is taken. A measurement taken or reused under its key is
// test/measure.test.mjs.
//
// Design: docs/DESIGN.md#verification.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { measureKey } from '../../lib/measure.mjs'

const KEYED = {
  base: 'b0', head: 'h0', mode: 'order', rigor: 'tdd', role: 'green', producer: 'implementer',
  build: 'node build.mjs', typecheck: '', suite: 'node --test', suiteFast: '', testOne: 'node --test {file}', scope: 'full',
  buildAbsent: false, typecheckAbsent: true, suiteAbsent: false, suiteFastAbsent: false,
  mutations: [{ file: 'src/a.mjs', find: 'a', replace: 'b' }], tests: ['test/a.test.mjs'], checks: ['node lint.mjs'],
  approved: [{ file: 'test/a.test.mjs', sha: 's0' }], expects: ['src/a.mjs'], fences: {},
  worktree: '/w', node: 'n', branch: 'agentics/e--n', repo: '/r', effort: 'e', execution: '20260925-120000', key: '',
}
const STATUS = { status: { 'notes.txt': 'blob0' } }

test('measureKey is the same for the same options and status', () => {
  assert.equal(measureKey({ ...KEYED }, { status: { ...STATUS.status } }), measureKey(KEYED, STATUS))
  assert.match(measureKey(KEYED, STATUS), /^[0-9a-f]{8}$/)
})

const CHANGES = [
  ['the head', { head: 'h1' }],
  ['the base', { base: 'b1' }],
  ['the mode', { mode: 'integration' }],
  ['the rigor', { rigor: 'trivial' }],
  ['the role', { role: 'red' }],
  ['the producer', { producer: 'test-author' }],
  ['the mutations', { mutations: [] }],
  ['the tests', { tests: ['test/b.test.mjs'] }],
  ['the checks', { checks: ['node other.mjs'] }],
  ['the approved files', { approved: [{ file: 'test/a.test.mjs', sha: 's1' }] }],
  ['the expected files', { expects: ['src/a.mjs', 'src/b.mjs'] }],
  ['the fences', { fences: { abc1234: ['src/a.mjs'] } }],
  ['the files read as upkeep', { upkeep: ['test/a.test.mjs'] }],
]
for (const [what, change] of CHANGES) {
  test('measureKey changes with ' + what, () => {
    assert.notEqual(measureKey({ ...KEYED, ...change }, STATUS), measureKey(KEYED, STATUS))
  })
}

test('measureKey changes with the worktree status', () => {
  assert.notEqual(measureKey(KEYED, { status: { 'notes.txt': 'blob1' } }), measureKey(KEYED, STATUS))
  assert.notEqual(measureKey(KEYED, { status: {} }), measureKey(KEYED, STATUS))
})

test('measureKey changes with each command: build, typecheck, suite, suiteFast, testOne, scope and the absent flags', () => {
  const commands = [
    { build: 'node other-build.mjs' }, { typecheck: 'tsc' }, { suite: 'npm test' }, { suiteFast: 'npm run fast' },
    { testOne: 'npx vitest {file}' }, { scope: 'fast' }, { buildAbsent: true }, { typecheckAbsent: false },
    { suiteAbsent: true }, { suiteFastAbsent: true },
  ]
  for (const change of commands) {
    assert.notEqual(measureKey({ ...KEYED, ...change }, STATUS), measureKey(KEYED, STATUS), JSON.stringify(change))
  }
})

test('measureKey ignores where and for whom it measures', () => {
  const elsewhere = { worktree: '/other', node: 'm', branch: 'agentics/e--m', repo: '/s', effort: 'f', execution: '20260926-120000', key: 'k' }
  assert.equal(measureKey({ ...KEYED, ...elsewhere }, STATUS), measureKey(KEYED, STATUS))
})
