// test/search-pin.test.mjs — pins lib/search/pin.mjs over real git: a standalone tree, the sha an
// execution folder's searches pin (the nearest existing integration head, else the base), and the
// detached worktree that holds it, for every state the path can be found in.
//
// Design: docs/DESIGN.md#autonomous-review.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { pinShaOf, pinTree, sweepTrees, treeOf } from '../lib/search/pin.mjs'
import { branchOf, posix } from '../lib/store.mjs'
import { seededRepo } from './harness/seeded-repo.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
const E = 'e1'

function repoFor(t) {
  const repo = seededRepo('agentics-pin-', { message: 'base', files: { 'a.txt': 'a\n', '.gitignore': '.claude/\n' }, autocrlf: false })
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  return repo
}
/** A new commit on top of `ref` with nothing changed, its sha. */
const commitOn = (repo, ref, message) => git(repo, 'commit-tree', git(repo, 'rev-parse', ref + '^{tree}'), '-p', ref, '-m', message)
const xcOf = (repo, envelope = {}) => ({ repo, effort: E, envelope: () => envelope })
const registered = (repo, path) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l === 'worktree ' + path).length

test("a standalone program's tree is its root and that root's HEAD", (t) => {
  const repo = repoFor(t)
  assert.deepEqual(treeOf(repo), { root: posix(resolve(repo)), sha: git(repo, 'rev-parse', 'HEAD') })
})

test('a folder pins the head of its own integration branch when it exists', (t) => {
  const repo = repoFor(t)
  git(repo, 'branch', branchOf(E, '.'), commitOn(repo, 'HEAD', 'root'))
  const own = commitOn(repo, 'HEAD', 'p')
  git(repo, 'branch', branchOf(E, 'p'), own)
  assert.equal(pinShaOf(xcOf(repo), 'p'), own)
})

test("a folder with no branch of its own pins its nearest ancestor's head", (t) => {
  const repo = repoFor(t)
  const root = commitOn(repo, 'HEAD', 'root')
  git(repo, 'branch', branchOf(E, '.'), root)
  const p = commitOn(repo, 'HEAD', 'p')
  git(repo, 'branch', branchOf(E, 'p'), p)
  assert.equal(pinShaOf(xcOf(repo), 'p/q'), p)
  assert.equal(pinShaOf(xcOf(repo), 'r'), root)
})

test('with no integration branch in the chain the pin falls back to the base_sha', (t) => {
  const repo = repoFor(t)
  const base = git(repo, 'rev-parse', 'HEAD')
  assert.equal(pinShaOf(xcOf(repo, { base_sha: base }), 'p'), base)
})

test('with no branch and no base_sha there is nothing to pin, and pinShaOf says so', (t) => {
  const repo = repoFor(t)
  assert.throws(() => pinShaOf(xcOf(repo, {}), 'p'), /no tree to pin for p/)
})

test('pinTree makes a detached tree at the sha', (t) => {
  const repo = repoFor(t)
  const sha = commitOn(repo, 'HEAD', 'later')
  const tree = pinTree(repo, E, sha)
  assert.deepEqual(tree, { root: posix(join(resolve(repo), '.claude', 'worktrees', 'search-' + E + '-' + sha.slice(0, 8))), sha })
  assert.equal(git(tree.root, 'rev-parse', 'HEAD'), sha)
  assert.equal(git(tree.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached')
})

test('pinTree reuses the tree it made', (t) => {
  const repo = repoFor(t)
  const sha = git(repo, 'rev-parse', 'HEAD')
  const first = pinTree(repo, E, sha)
  // An ignored file survives only while the tree itself does.
  appendFileSync(resolve(first.root, git(first.root, 'rev-parse', '--git-path', 'info/exclude')), 'kept.txt\n')
  writeFileSync(join(first.root, 'kept.txt'), 'x\n')
  assert.deepEqual(pinTree(repo, E, sha), first)
  assert.equal(registered(repo, first.root), 1)
  assert.ok(existsSync(join(first.root, 'kept.txt')), 'the tree was reused, not made again')
})

test('a tree moved off its sha is made again at it', (t) => {
  const repo = repoFor(t)
  const sha = git(repo, 'rev-parse', 'HEAD')
  const { root } = pinTree(repo, E, sha)
  git(root, 'checkout', '-q', '--detach', commitOn(repo, 'HEAD', 'elsewhere'))
  assert.equal(git(pinTree(repo, E, sha).root, 'rev-parse', 'HEAD'), sha)
})

test('a dirty tree is made again clean', (t) => {
  const repo = repoFor(t)
  const sha = git(repo, 'rev-parse', 'HEAD')
  const { root } = pinTree(repo, E, sha)
  writeFileSync(join(root, 'a.txt'), 'edited\n')
  pinTree(repo, E, sha)
  assert.equal(git(root, 'status', '--porcelain'), '')
})

test('a plain directory at the path is replaced by the tree', (t) => {
  const repo = repoFor(t)
  const sha = git(repo, 'rev-parse', 'HEAD')
  const path = join(repo, '.claude', 'worktrees', 'search-' + E + '-' + sha.slice(0, 8))
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'stray.txt'), 'x\n')
  const { root } = pinTree(repo, E, sha)
  assert.equal(git(root, 'rev-parse', 'HEAD'), sha)
  assert.ok(!existsSync(join(root, 'stray.txt')))
})

test('a registration whose folder is gone is pruned and the tree made again', (t) => {
  const repo = repoFor(t)
  const sha = git(repo, 'rev-parse', 'HEAD')
  const { root } = pinTree(repo, E, sha)
  rmSync(root, { recursive: true, force: true })
  const again = pinTree(repo, E, sha)
  assert.equal(git(again.root, 'rev-parse', 'HEAD'), sha)
  assert.equal(registered(repo, again.root), 1)
})

test('pinTree refuses what is not a full sha', (t) => {
  const repo = repoFor(t)
  assert.throws(() => pinTree(repo, E, ''), /not a commit sha/)
  assert.throws(() => pinTree(repo, E, 'abc123'), /not a commit sha/)
})

test("sweepTrees removes the effort's clean pinned trees and keeps what it is told", (t) => {
  const repo = repoFor(t)
  const a = git(repo, 'rev-parse', 'HEAD')
  const b = commitOn(repo, 'HEAD', 'later')
  const [ta, tb] = [pinTree(repo, E, a), pinTree(repo, E, b)]
  const out = sweepTrees(repo, E, new Set([b]))
  assert.deepEqual(out, { removed: [ta.root], dirty: [] })
  assert.ok(!existsSync(ta.root))
  assert.ok(existsSync(tb.root), 'a kept sha stays')
  assert.equal(registered(repo, ta.root), 0)
})

test("sweepTrees never forces a dirty tree and never touches another effort's", (t) => {
  const repo = repoFor(t)
  const sha = git(repo, 'rev-parse', 'HEAD')
  const mine = pinTree(repo, E, sha)
  writeFileSync(join(mine.root, 'a.txt'), 'edited\n')
  const other = pinTree(repo, E + '-x', sha)
  const misnamed = ['search-' + E + '-notasha', 'search-' + E + '-' + sha.slice(0, 8) + '-old', 'old-search-' + E + '-' + sha.slice(0, 8)]
    .map((name) => join(repo, '.claude', 'worktrees', name))
  for (const path of misnamed) git(repo, 'worktree', 'add', '-q', '--detach', path, sha)
  const out = sweepTrees(repo, E)
  assert.deepEqual(out, { removed: [], dirty: [mine.root] })
  for (const p of [mine.root, other.root, ...misnamed]) assert.ok(existsSync(p), p)
})
