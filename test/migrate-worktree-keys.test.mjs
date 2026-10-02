// test/migrate-worktree-keys.test.mjs — the one-shot move of framework worktrees to the bounded
// directory their branch names: in-flight work follows its branch, short names and checkouts the
// framework does not own stay, and a second run moves nothing.
//
// Design: docs/DESIGN.md#storage.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT_ID, branchOf, worktreeOf } from '../lib/store.mjs'
import { apply, plan } from '../tools/migrate-worktree-keys.mjs'
import { git, repo } from './harness/boundary-fixture.mjs'

const EFFORT = '2026-09-26-reshape-pets-onto-entities-action-queues'
const NODE = 'wishing/wishing-rules-green'

/** A repository whose worktrees were checked out under their branch's whole name. */
function before(t) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  const old = (name) => join(r, '.claude', 'worktrees', name)
  const add = (branch, path) => {
    git(r, 'branch', branch)
    git(r, 'worktree', 'add', '-q', path, branch)
    return path
  }
  return {
    r,
    root: add(branchOf(EFFORT, ROOT_ID), old(EFFORT)),
    node: add(branchOf(EFFORT, NODE), old(EFFORT + '--wishing.wishing-rules-green')),
    short: add(branchOf('e1', 'a'), old('e1--a')),
    theirs: add('feature/' + EFFORT, old('feature-' + EFFORT)),
  }
}

test('every long worktree moves to the directory its branch names, work and all', (t) => {
  const { r, root, node, short, theirs } = before(t)
  writeFileSync(join(node, 'unsaved.txt'), 'in flight\n')

  const p = plan(r)
  assert.deepEqual(p.refused, [])
  assert.deepEqual(apply(p), { worktrees: 2 })

  for (const id of [ROOT_ID, NODE]) {
    assert.equal(git(worktreeOf(r, EFFORT, id), 'rev-parse', '--abbrev-ref', 'HEAD'), branchOf(EFFORT, id))
  }
  assert.ok(existsSync(join(worktreeOf(r, EFFORT, NODE), 'unsaved.txt')), 'uncommitted work moves with it')
  assert.ok(!existsSync(root) && !existsSync(node))
  assert.ok(existsSync(short), 'a name that fits stays')
  assert.ok(existsSync(theirs), 'a checkout of a branch the framework does not own stays')

  const again = plan(r)
  assert.deepEqual([again.worktrees, again.refused], [[], []])
})

test('a dry run moves nothing', (t) => {
  const { r, root, node } = before(t)
  assert.equal(plan(r).worktrees.length, 2)
  assert.ok(existsSync(root) && existsSync(node))
})

test('a target that already exists refuses that worktree and moves the rest', (t) => {
  const { r, node } = before(t)
  mkdirSync(worktreeOf(r, EFFORT, NODE), { recursive: true })
  const p = plan(r)
  assert.deepEqual(p.refused.map((x) => x.branch), [branchOf(EFFORT, NODE)])
  assert.deepEqual(p.worktrees.map((x) => x.branch), [branchOf(EFFORT, ROOT_ID)])
  apply(p)
  assert.ok(existsSync(node))
})
