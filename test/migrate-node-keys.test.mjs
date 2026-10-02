// test/migrate-node-keys.test.mjs — the one-shot rename of a long node's branch, worktree and
// state files to its bounded key: in-flight work follows its node, records keep the paths they
// point at, and a second run changes nothing.
//
// Design: docs/DESIGN.md#storage.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  branchOf, cardPath, effortStateDir, executionDir, flat, nodeKey, posix, reportPath, reviewPath, specCopyPath, worktreeOf,
} from '../lib/store.mjs'
import { apply, plan } from '../tools/migrate-node-keys.mjs'
import * as worktreeKeys from '../tools/migrate-worktree-keys.mjs'
import { git, leaf, repo, root } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const EFFORT = 'e1'
const STAMP = '20261002-075950'
const PARENT = 'growth-axes-and-ports-of-the-entity-layer'
const LONG = PARENT + '/action-queue-owner'
const OLD = flat(LONG)

function put(path, text = '{}') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** A repository whose long node was built under its spelled-out name, before keys were bounded. */
function before(t) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  const seeded = seedTree(r, EFFORT, [root(), { id: PARENT, kind: 'composite', title: 'p' }, leaf(LONG, { locus: ['src/a.mjs'] }), leaf('short', { locus: ['src/b.mjs'] })])
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems))
  git(r, 'branch', 'agentics/' + EFFORT + '--' + OLD)
  git(r, 'worktree', 'add', '-q', join(r, '.claude', 'worktrees', EFFORT + '--' + OLD), 'agentics/' + EFFORT + '--' + OLD)
  const state = effortStateDir(r, EFFORT)
  const exec = executionDir(r, EFFORT, STAMP)
  const old = {
    report: join(state, 'reports', STAMP + '-' + OLD + '-implementer-r1.md'),
    progress: join(state, 'reports', STAMP + '-' + OLD + '-implementer-r1.progress.json'),
    spec: join(state, 'specs', OLD + '@deadbeef.md'),
    review: join(exec, 'reviews', OLD + '-r1.json'),
    card: join(exec, 'cards', 'leaf-' + OLD + '-12345678.json'),
    said: join(exec, 'said', '1-1-implementer-' + OLD + '-1.md'),
    short: join(state, 'reports', STAMP + '-short-implementer-r1.md'),
  }
  for (const p of Object.values(old)) put(p)
  return { r, old }
}

test('a long node\'s branch, worktree and files move to its key; records and short nodes stay', (t) => {
  const { r, old } = before(t)
  assert.notEqual(nodeKey(LONG), OLD, 'the node is long enough to have a bounded key')

  const p = plan(r)
  assert.deepEqual(p.refused, [])
  const counts = apply(p)
  assert.deepEqual(counts, { branches: 1, worktrees: 1, files: 5 })

  assert.equal(git(r, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + branchOf(EFFORT, LONG)).length, 40)
  assert.equal(git(worktreeOf(r, EFFORT, LONG), 'rev-parse', '--abbrev-ref', 'HEAD'), branchOf(EFFORT, LONG))
  assert.ok(existsSync(reportPath(r, EFFORT, STAMP, LONG, 'implementer', 1)))
  assert.ok(existsSync(reportPath(r, EFFORT, STAMP, LONG, 'implementer', 1).replace(/\.md$/, '.json')))
  assert.ok(existsSync(specCopyPath(r, EFFORT, LONG, 'deadbeef')))
  assert.ok(existsSync(reviewPath(r, EFFORT, STAMP, LONG, 1)))
  assert.ok(existsSync(cardPath(r, EFFORT, STAMP, 'leaf', LONG, '12345678')))
  assert.ok(existsSync(old.said), 'a said file is pointed at by a record, so it keeps its path')
  assert.ok(existsSync(old.short), 'a node that fits keeps its name')
  for (const k of ['report', 'progress', 'spec', 'review', 'card']) assert.ok(!existsSync(old[k]), k)

  const again = plan(r)
  assert.deepEqual([again.branches, again.worktrees, again.files, again.refused], [[], [], [], []])
})

test('a dry run renames nothing', (t) => {
  const { r, old } = before(t)
  const p = plan(r)
  assert.ok(p.files.length > 0 && p.branches.length === 1 && p.worktrees.length === 1)
  for (const path of Object.values(old)) assert.ok(existsSync(path), posix(path))
  assert.ok(existsSync(join(r, '.claude', 'worktrees', EFFORT + '--' + OLD)))
})

test('a target that already exists refuses that node whole', (t) => {
  const { r, old } = before(t)
  put(reviewPath(r, EFFORT, STAMP, LONG, 1))
  const p = plan(r)
  assert.deepEqual(p.refused.map((x) => x.id), [LONG])
  assert.deepEqual([p.branches, p.worktrees], [[], []])
  assert.ok(!p.files.some((f) => f.from === posix(old.review)))
})

test('a worktree another migration already moved still follows its node', (t) => {
  const { r } = before(t)
  worktreeKeys.apply(worktreeKeys.plan(r))
  const p = plan(r)
  assert.deepEqual([p.refused, p.worktrees.length], [[], 1])
  apply(p)
  assert.equal(git(worktreeOf(r, EFFORT, LONG), 'rev-parse', '--abbrev-ref', 'HEAD'), branchOf(EFFORT, LONG))
})
