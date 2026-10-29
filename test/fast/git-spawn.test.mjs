// test/fast/git-spawn.test.mjs — pins the lint rule that keeps every git start in lib/store.mjs.
//
// Design: docs/DESIGN.md#the-process-model.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { check } from '../../tools/rules/git-spawn.mjs'

test('a git started outside the store is a finding on its line, however it is called', () => {
  for (const call of ["spawn('git', argv)", 'spawnSync("git", argv)', "execFileSync(\n  'git', ['status'])", "exec(`git status`)", "execFile('git.exe', a)"]) {
    assert.deepEqual(check('// a unit\n' + call, 'lib/boundaries/x.mjs').map((v) => v.line), [2], call)
  }
})

test('the store starts git, and a child that is no git starts anywhere', () => {
  assert.deepEqual(check("spawnSync('git', argv)", 'lib/store.mjs'), [])
  assert.deepEqual(check("spawn(process.execPath, [VERIFY])", 'lib/measure.mjs'), [])
  assert.deepEqual(check("spawn('github-cli', argv)", 'lib/x.mjs'), [])
})
