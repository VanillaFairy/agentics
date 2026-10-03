// test/watch.test.mjs — pins the watch on the user's checkout: a moved HEAD or branch is named,
// a changed working tree is listed, and the framework's own refs and folders are not the user's.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkoutWatch, compareCheckout, snapshotCheckout } from '../lib/watch.mjs'

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-watch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  g('add', '.'); g('commit', '-q', '-m', 'one')
  return { dir, g }
}

test('nothing changed reads as nothing moved and nothing changed', (t) => {
  const { dir } = repo(t)
  const before = snapshotCheckout(dir)
  assert.deepEqual(compareCheckout(before, snapshotCheckout(dir)), { moved: [], changed: [] })
})

test('an edited file is a changed path', (t) => {
  const { dir } = repo(t)
  const before = snapshotCheckout(dir)
  writeFileSync(join(dir, 'a.txt'), 'b\n')
  assert.deepEqual(compareCheckout(before, snapshotCheckout(dir)).changed, ['a.txt'])
})

test('a new commit moves HEAD and the branch', (t) => {
  const { dir, g } = repo(t)
  const before = snapshotCheckout(dir)
  writeFileSync(join(dir, 'b.txt'), 'b\n'); g('add', '.'); g('commit', '-q', '-m', 'two')
  const refs = compareCheckout(before, snapshotCheckout(dir)).moved.map((m) => m.ref)
  assert.ok(refs.includes('HEAD'))
  assert.ok(refs.includes('refs/heads/main'))
})

test('switching branch moves HEAD', (t) => {
  const { dir, g } = repo(t)
  g('branch', 'side')
  const before = snapshotCheckout(dir)
  g('switch', '-q', 'side')
  assert.ok(compareCheckout(before, snapshotCheckout(dir)).moved.some((m) => m.ref === 'HEAD'))
})

test('a new or deleted user branch is a moved ref', (t) => {
  const { dir, g } = repo(t)
  const before = snapshotCheckout(dir)
  g('branch', 'extra')
  assert.ok(compareCheckout(before, snapshotCheckout(dir)).moved.some((m) => m.ref === 'refs/heads/extra'))
})

test("the framework's own branches are not the user's", (t) => {
  const { dir, g } = repo(t)
  const before = snapshotCheckout(dir)
  g('branch', 'agentics/e1')
  g('branch', 'agentics/e1--a.b')
  assert.deepEqual(compareCheckout(before, snapshotCheckout(dir)).moved, [])
})

test("the framework's own folders are not the user's changes", (t) => {
  const { dir } = repo(t)
  const before = snapshotCheckout(dir)
  mkdirSync(join(dir, '.agentics')); writeFileSync(join(dir, '.agentics', 'x'), 'x')
  mkdirSync(join(dir, '.claude')); writeFileSync(join(dir, '.claude', 'y'), 'y')
  assert.deepEqual(compareCheckout(before, snapshotCheckout(dir)).changed, [])
})

test('a path already dirty before is not changed by the call', (t) => {
  const { dir } = repo(t)
  writeFileSync(join(dir, 'a.txt'), 'dirty\n')
  const before = snapshotCheckout(dir)
  assert.deepEqual(compareCheckout(before, snapshotCheckout(dir)).changed, [])
})

test('a dirty path edited again during the call is changed', (t) => {
  const { dir } = repo(t)
  writeFileSync(join(dir, 'a.txt'), 'dirty\n')
  const before = snapshotCheckout(dir)
  writeFileSync(join(dir, 'a.txt'), 'dirtier\n')
  assert.deepEqual(compareCheckout(before, snapshotCheckout(dir)).changed, ['a.txt'])
})

test('a dirty path restored during the call is changed', (t) => {
  const { dir, g } = repo(t)
  writeFileSync(join(dir, 'a.txt'), 'dirty\n')
  const before = snapshotCheckout(dir)
  g('checkout', '--', 'a.txt')
  assert.deepEqual(compareCheckout(before, snapshotCheckout(dir)).changed, ['a.txt'])
})

test('a deleted file is a changed path', (t) => {
  const { dir } = repo(t)
  const before = snapshotCheckout(dir)
  rmSync(join(dir, 'a.txt'))
  assert.deepEqual(compareCheckout(before, snapshotCheckout(dir)).changed, ['a.txt'])
})

test('a path with a space is named as it is', (t) => {
  const { dir } = repo(t)
  const before = snapshotCheckout(dir)
  writeFileSync(join(dir, 'my file.txt'), 'x\n')
  assert.deepEqual(compareCheckout(before, snapshotCheckout(dir)).changed, ['my file.txt'])
})

test('checkoutWatch pairs a snapshot with its comparison', (t) => {
  const { dir } = repo(t)
  const watch = checkoutWatch(dir)
  const snap = watch.before()
  writeFileSync(join(dir, 'c.txt'), 'c\n')
  assert.deepEqual(watch.after(snap).changed, ['c.txt'])
})
