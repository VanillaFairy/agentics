// test/boundary-suite-gate.test.mjs — lib/boundary.mjs against real git: the suite gate over a split suite.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readLog } from '../lib/ledger.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { worktreeOf } from '../lib/store.mjs'
import { A_TEST, B, COMMANDS, commitIn, git, leaf, repo, root, STAMP } from './harness/boundary-fixture.mjs'

test('a split suite: merge-batch runs the fast tests, the suite gate the full suite, once per passing head', () => {
  const r = repo()
  mkdirSync(join(r, 'test', 'big'))
  writeFileSync(join(r, 'test', 'big', 'add.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../../src/add.mjs'\ntest('adds big', () => assert.equal(add(2, 2), 4))\n")
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'a big test')
  const commands = { ...COMMANDS, suite_fast: 'node --test --test-reporter=spec test/add.test.mjs' }
  const trivial = { rigor: 'trivial', locus: ['src/add.mjs'], acceptance: [{ text: 'adds', check: 'node --test test/add.test.mjs', decisions: ['D1'] }] }
  assert.equal(seedTree(r, 'e1', [root(), leaf('a', trivial)]).ok, true)
  assert.equal(B(r, 'preflight', { root: '.', commands }).ok, true)

  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1, dispatch: { model: 'sonnet', effort: 'high' } })
  const head = commitIn(open.worktree, { 'src/add.mjs': 'export const add = (a, b) => (a === 2 && b === 2 ? 5 : a + b)\n' }, 'Break only the big test')
  const merged = B(r, 'merge-batch', { target: '.', children: [{ id: 'a', head_sha: head }], cycles: [] })
  assert.equal(merged.verified, true, 'the fast suite does not run the big test')
  assert.equal(JSON.parse(readFileSync(merged.record, 'utf8')).measurement.suite_scope, 'fast')

  const gate = B(r, 'suite-gate', { target: '.' })
  assert.equal(gate.ran, true)
  assert.equal(gate.passed, false)
  assert.deepEqual(gate.failures.map((f) => f.check), ['suite'])
  assert.equal(JSON.parse(readFileSync(gate.record, 'utf8')).measurement.suite_scope, 'full')
  assert.equal(B(r, 'suite-gate', { target: '.' }).ran, true, 'a failing gate is asked again')

  const wt = worktreeOf(r, 'e1', '.')
  commitIn(wt, { 'src/add.mjs': 'export const add = (a, b) => a + b\n' }, 'Mend the big test')
  const mended = B(r, 'suite-gate', { target: '.' })
  assert.equal(mended.passed, true, JSON.stringify(mended))
  assert.ok(readLog(r, 'e1', 'state:' + STAMP).entries.some((e) => e.kind === 'gate' && e.head_sha === mended.head_sha && e.passed))
  assert.equal(B(r, 'suite-gate', { target: '.' }).ran, false, 'a head the full suite passed at is not measured again')
})

test('the suite gate runs nothing where the repository does not split its tests', () => {
  const r = repo()
  assert.equal(seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })]).ok, true)
  assert.equal(B(r, 'preflight', { root: '.', commands: COMMANDS }).ok, true)
  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1, dispatch: { model: 'sonnet', effort: 'high' } })
  const head = commitIn(open.worktree, { 'test/a.test.mjs': A_TEST, 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  const merged = B(r, 'merge-batch', { target: '.', children: [{ id: 'a', head_sha: head }], cycles: [] })
  assert.equal(JSON.parse(readFileSync(merged.record, 'utf8')).measurement.suite_scope, 'full')
  const gate = B(r, 'suite-gate', { target: '.' })
  assert.deepEqual([gate.ran, gate.passed, gate.record], [false, true, ''])
})
