// test/fast/worktree-reads.test.mjs — lib/boundaries/leaf-close.mjs `worktreeReads`: a read git
// refuses is an empty, unborn worktree and is not kept; a git killed at its ceiling is no refusal and
// is thrown as `GitHung`, so the unit's `git_hung` stop records it.
//
// Design: docs/DESIGN.md#the-process-model.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { worktreeReads } from '../../lib/boundaries/leaf-close.mjs'
import { GitHung } from '../../lib/store.mjs'

test('a read git refuses is an unborn worktree, and the next read asks again', () => {
  let asked = 0
  const reads = worktreeReads('/w', () => { asked++; throw new Error('fatal: not a git repository') })
  assert.deepEqual([reads.now().head, reads.now().paths], ['', []])
  assert.equal(asked, 2)
  assert.equal(reads.held(), null)
})

test('a hung read throws GitHung, never an unborn worktree', () => {
  const reads = worktreeReads('/w', () => { throw new GitHung(['status'], 1) })
  assert.throws(() => reads.now(), (err) => err instanceof GitHung && err.label === 'git status')
})
