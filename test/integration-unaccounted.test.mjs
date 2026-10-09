// test/integration-unaccounted.test.mjs — which commits on an integration branch no record
// accounts for, against real git: stray commits, records naming them, agentics' merges, refresh
// merges, hand --no-ff merges and a child composite's merge.
//
// Design: the spec's "Accounted commits".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { rootBase, unaccountedOf } from '../lib/integration.mjs'
import { branchOf, effortStateDir, executionDir, git as storeGit, worktreeOf, writeJson } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { commitIn, git, leaf, repo, root } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const NODES = [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { locus: ['src/a.mjs'] })]

/** A repository with the tree seeded, the effort branch and folder c's branch cut at `main`, and c checked out. */
function world(t) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  assert.equal(seedTree(r, E, NODES).ok, true)
  const base = git(r, 'rev-parse', 'HEAD')
  git(r, 'branch', branchOf(E, '.'), base)
  git(r, 'branch', branchOf(E, 'c'), base)
  const wt = worktreeOf(r, E, 'c')
  git(r, 'worktree', 'add', '-q', wt, branchOf(E, 'c'))
  return { r, base, wt, nodes: readTree(r, E).nodes }
}

const ev = (kind, fields) => ({ kind, execution: '', ...fields })
const of = (w, id, events = []) => unaccountedOf(w.r, E, id, { nodes: w.nodes, events, base: { base_branch: 'main', base_sha: w.base } })

/** A branch `name` cut from `from` in its own worktree, with one commit per file: the shas, oldest first. */
function handBranch(w, name, from, files) {
  const path = w.r + '/.claude/worktrees/hand-' + name.replace(/\W/g, '-')
  git(w.r, 'worktree', 'add', '-q', '-b', name, path, from)
  return { path, shas: files.map((f) => commitIn(path, { [f]: 'x\n' }, 'hand ' + f)) }
}

test('a composite with no integration branch has nothing to account for', (t) => {
  const w = world(t)
  assert.equal(unaccountedOf(w.r, E, 'c/none', { nodes: w.nodes, events: [] }), null)
})

test('a branch at its cut holds no unaccounted commit', (t) => {
  const w = world(t)
  const out = of(w, 'c')
  assert.equal(out.branch, branchOf(E, 'c'))
  assert.deepEqual(out.commits, [])
  assert.equal(out.error, '')
})

test('stray commits straight on a folder branch are unaccounted, oldest first', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/one.mjs': '1\n' }, 'one')
  const two = commitIn(w.wt, { 'src/two.mjs': '2\n' }, 'two')
  assert.deepEqual(of(w, 'c').commits, [one, two])
})

test('a commit an outside record names is accounted', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/one.mjs': '1\n' }, 'one')
  assert.deepEqual(of(w, 'c', [ev('outside', { node: 'c', commits: [one], by: 'user' })]).commits, [])
})

test("a commit a merged record names in commits, or as its merged_sha, is accounted", (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const two = commitIn(w.wt, { 'src/a.mjs': '2\n' }, 'two')
  const events = [ev('merged', { node: 'c/a', into: branchOf(E, 'c'), merged_sha: two, head_sha: two, by: 'user', commits: [one] })]
  assert.deepEqual(of(w, 'c', events).commits, [])
})

test("agentics' merge of an approved leaf head is accounted by the approval alone", (t) => {
  const w = world(t)
  const leafBranch = handBranch(w, branchOf(E, 'c/a'), branchOf(E, 'c'), ['src/a.mjs'])
  const tip = leafBranch.shas[0]
  git(w.wt, 'merge', '--no-ff', '--no-edit', branchOf(E, 'c/a'))
  assert.deepEqual(of(w, 'c', [ev('approved', { node: 'c/a', head_sha: tip, review_rounds: 1, at_integration: false })]).commits, [])
})

test("agentics' merge is accounted by a merged record's head_sha", (t) => {
  const w = world(t)
  const tip = handBranch(w, branchOf(E, 'c/a'), branchOf(E, 'c'), ['src/a.mjs']).shas[0]
  git(w.wt, 'merge', '--no-ff', '--no-edit', branchOf(E, 'c/a'))
  const merge = git(w.wt, 'rev-parse', 'HEAD')
  assert.deepEqual(of(w, 'c', [ev('merged', { node: 'c/a', into: branchOf(E, 'c'), merged_sha: merge, head_sha: tip })]).commits, [])
})

test('a merge of a branch nothing recorded is unaccounted, reported by the merge', (t) => {
  const w = world(t)
  handBranch(w, 'hand/x', branchOf(E, 'c'), ['src/x.mjs'])
  git(w.wt, 'merge', '--no-ff', '--no-edit', 'hand/x')
  const merge = git(w.wt, 'rev-parse', 'HEAD')
  assert.deepEqual(of(w, 'c').commits, [merge])
})

test("a hand --no-ff merge passes once every commit it brings in is adopted", (t) => {
  const w = world(t)
  const hand = handBranch(w, 'hand/x', branchOf(E, 'c'), ['src/x.mjs', 'src/y.mjs'])
  git(w.wt, 'merge', '--no-ff', '--no-edit', 'hand/x')
  const all = [ev('outside', { node: 'c', commits: hand.shas, by: 'user' })]
  assert.deepEqual(of(w, 'c', all).commits, [])
  const merge = git(w.wt, 'rev-parse', 'HEAD')
  assert.deepEqual(of(w, 'c', [ev('outside', { node: 'c', commits: [hand.shas[0]], by: 'user' })]).commits, [merge],
    'one commit it brought in is nobody\'s: the merge stays unaccounted')
})

test("a refresh merge from the parent's integration branch is accounted", (t) => {
  const w = world(t)
  const rootWt = worktreeOf(w.r, E, '.')
  git(w.r, 'worktree', 'add', '-q', rootWt, branchOf(E, '.'))
  commitIn(rootWt, { 'docs/up.md': 'up\n' }, 'up')
  git(w.wt, 'merge', '--no-ff', '--no-edit', branchOf(E, '.'))
  assert.deepEqual(of(w, 'c').commits, [])
})

test("the root's merge of the moved base branch is accounted, and a stray root commit is not", (t) => {
  const w = world(t)
  const rootWt = worktreeOf(w.r, E, '.')
  git(w.r, 'worktree', 'add', '-q', rootWt, branchOf(E, '.'))
  commitIn(w.r, { 'docs/main.md': 'moved\n' }, 'main moved')
  git(rootWt, 'merge', '--no-ff', '--no-edit', 'main')
  assert.deepEqual(of(w, '.').commits, [])
  const stray = commitIn(rootWt, { 'docs/stray.md': 's\n' }, 'stray')
  assert.deepEqual(of(w, '.').commits, [stray])
})

test("commits the base branch holds are the root's ground, even fast-forwarded onto it", (t) => {
  const w = world(t)
  const rootWt = worktreeOf(w.r, E, '.')
  git(w.r, 'worktree', 'add', '-q', rootWt, branchOf(E, '.'))
  commitIn(w.r, { 'docs/main.md': 'moved\n' }, 'main moved')
  git(rootWt, 'merge', '--ff-only', 'main')
  assert.deepEqual(of(w, '.').commits, [])
})

test("a merged child composite's merge into its parent is accounted, by its record or by its branch head", (t) => {
  const w = world(t)
  commitIn(w.wt, { 'src/c.mjs': 'c\n' }, 'work in c')
  const head = git(w.wt, 'rev-parse', 'HEAD')
  const rootWt = worktreeOf(w.r, E, '.')
  git(w.r, 'worktree', 'add', '-q', rootWt, branchOf(E, '.'))
  git(rootWt, 'merge', '--no-ff', '--no-edit', branchOf(E, 'c'))
  const merge = git(rootWt, 'rev-parse', 'HEAD')
  assert.deepEqual(of(w, '.').commits, [], "c's branch still holds what merged: a merge killed before its record")
  git(w.r, 'worktree', 'remove', '--force', w.wt)
  git(w.r, 'branch', '-D', branchOf(E, 'c'))
  assert.deepEqual(of(w, '.', [ev('merged', { node: 'c', into: branchOf(E, '.'), merged_sha: merge, head_sha: head })]).commits, [])
  assert.deepEqual(of(w, '.').commits, [merge], 'with its branch gone and no record, nothing accounts for it')
})

test("the root's base is branch.json's cut when agentics cut the effort branch", (t) => {
  const w = world(t)
  writeJson(executionDir(w.r, E, '20261009-120000') + '/execution.json', { stamp: '20261009-120000', root: '.', base_branch: 'other', base_sha: 'f'.repeat(40) })
  writeJson(effortStateDir(w.r, E) + '/branch.json', { base_branch: 'main', base_sha: w.base })
  assert.deepEqual(rootBase(w.r, E), { base_branch: 'main', base_sha: w.base })
})

test("without branch.json, the root's base is the newest execution envelope's", (t) => {
  const w = world(t)
  writeJson(executionDir(w.r, E, '20261009-120000') + '/execution.json', { stamp: '20261009-120000', root: '.', base_branch: 'old', base_sha: 'e'.repeat(40) })
  writeJson(executionDir(w.r, E, '20261009-130000') + '/execution.json', { stamp: '20261009-130000', root: 'c', base_branch: 'main', base_sha: w.base })
  assert.deepEqual(rootBase(w.r, E), { base_branch: 'main', base_sha: w.base })
})

test('with neither, the root has no base', (t) => {
  const w = world(t)
  assert.deepEqual(rootBase(w.r, E), { base_branch: '', base_sha: '' })
})

test('a git read that fails is an error, never an empty list', (t) => {
  const w = world(t)
  commitIn(w.wt, { 'src/one.mjs': '1\n' }, 'one')
  const failing = (cwd, args, input) => (args[0] === 'rev-list' ? { ok: false, status: 128, stdout: '', stderr: 'boom' } : storeGit(cwd, args, input))
  const out = unaccountedOf(w.r, E, 'c', { nodes: w.nodes, events: [], base: { base_branch: 'main', base_sha: w.base } }, failing)
  assert.notEqual(out.error, '')
  assert.deepEqual(out.commits, [])
})

test('a fork point git cannot find is an error, never the whole history', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/one.mjs': '1\n' }, 'one')
  const noFork = (cwd, args, input) => (args[0] === 'merge-base' && !args.includes('--is-ancestor') ? { ok: false, status: 1, stdout: '', stderr: 'boom' } : storeGit(cwd, args, input))
  const out = unaccountedOf(w.r, E, 'c', { nodes: w.nodes, events: [], base: { base_branch: 'main', base_sha: w.base } }, noFork)
  assert.notEqual(out.error, '')
  assert.deepEqual(out.commits, [])
  assert.deepEqual(of(w, 'c').commits, [one], 'with git answering, the same branch holds only its own commit')
})

test('the root with no known base is an error, never the whole history', (t) => {
  const w = world(t)
  commitIn(worktreeOf(w.r, E, '.') && w.r, { 'docs/x.md': 'x\n' }, 'x')
  const out = unaccountedOf(w.r, E, '.', { nodes: w.nodes, events: [] })
  assert.notEqual(out.error, '')
  assert.deepEqual(out.commits, [])
})

test("a folder whose parent has no integration branch is an error: its cut cannot be placed", (t) => {
  const w = world(t)
  git(w.r, 'branch', '-D', branchOf(E, '.'))
  const out = of(w, 'c')
  assert.match(out.error, /no integration branch/)
  assert.deepEqual(out.commits, [])
})
