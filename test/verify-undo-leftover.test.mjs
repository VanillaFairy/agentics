// test/verify-undo-leftover.test.mjs — lib/verify.mjs `undoLeftover` over a detached HEAD: the leaf's
// branch is checked out again, and commits made on the detached HEAD that the branch does not hold
// are named by their sha, never dropped silently.
//
// Design: docs/DESIGN.md#verification.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { undoLeftover } from '../lib/verify.mjs'
import { BRANCH, git, order, rev } from './harness/verify-fixture.mjs'

const onBranch = (worktree) => git(worktree, 'symbolic-ref', '-q', 'HEAD').stdout.trim()

function commitHere(worktree, file, text, subject) {
  writeFileSync(join(worktree, file), text)
  git(worktree, 'add', '-A')
  const c = git(worktree, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', subject)
  assert.equal(c.status, 0, c.stderr)
}

test('commits made on a detached HEAD the branch does not hold are named by their sha', { timeout: 60_000 }, (t) => {
  const { worktree } = order(t)
  assert.equal(onBranch(worktree), 'refs/heads/' + BRANCH, "the fixture's worktree is on the leaf branch")
  git(worktree, 'checkout', '-q', '--detach')
  commitHere(worktree, 'stray.txt', 'made while detached\n', 'Work on a detached HEAD')
  const lost = rev(worktree, 'HEAD')

  const notes = undoLeftover(worktree, BRANCH)
  assert.equal(onBranch(worktree), 'refs/heads/' + BRANCH)
  assert.ok(notes.some((n) => n.includes(lost)), JSON.stringify(notes))
})

test('a HEAD a cut-off verify left detached at the base names no sha', { timeout: 60_000 }, (t) => {
  const { worktree, base } = order(t)
  git(worktree, 'checkout', '-q', '--detach', base)

  const notes = undoLeftover(worktree, BRANCH)
  assert.equal(onBranch(worktree), 'refs/heads/' + BRANCH)
  assert.ok(notes.length > 0, 'the checkout is noted')
  assert.ok(!notes.some((n) => n.includes(base)), JSON.stringify(notes))
})
