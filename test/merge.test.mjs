// test/merge.test.mjs — lib/merge.mjs, against real repositories.
//
// The property worth pinning is the one a prompt could only ask for: a conflict leaves the
// worktree clean and the integration head where it was. A merge that half-happened is worse
// than one that did not, because the next thing to touch that worktree inherits a conflicted
// index and may well finish the merge by hand — which is the outcome this file exists to make
// impossible.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { mergeBranch } from '../lib/merge.mjs'

const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const head = (cwd) => git(cwd, 'rev-parse', 'HEAD').stdout.trim()

/** A repo on `main` with one commit, plus a `feature` branch forked from it. */
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-merge-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')

  writeFileSync(join(dir, 'shared.txt'), 'base\n', 'utf8')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')

  return dir
}

const commitOn = (dir, branch, file, text, message) => {
  git(dir, 'checkout', '-q', '-B', branch)
  writeFileSync(join(dir, file), text, 'utf8')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

test('a clean merge reports the sha it read back', (t) => {
  const dir = repo(t)
  commitOn(dir, 'feature', 'feature.txt', 'work\n', 'feat: the work')
  git(dir, 'checkout', '-q', 'main')

  const before = head(dir)
  const result = mergeBranch(dir, 'feature')

  assert.equal(result.ok, true)
  assert.equal(result.conflicts.length, 0)
  assert.equal(result.head_before, before)
  // Read back, never predicted: the caller advances the integration head to this value and
  // every later wave is built on it.
  assert.equal(result.merged_sha, head(dir))
  assert.notEqual(result.merged_sha, before, '--no-ff always produces a commit')
})

test('a conflict aborts itself, names the paths, and leaves the head where it was', (t) => {
  const dir = repo(t)
  commitOn(dir, 'feature', 'shared.txt', 'theirs\n', 'feat: theirs')
  git(dir, 'checkout', '-q', 'main')
  writeFileSync(join(dir, 'shared.txt'), 'ours\n', 'utf8')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'ours')

  const before = head(dir)
  const result = mergeBranch(dir, 'feature')

  assert.equal(result.ok, false)
  assert.deepEqual(result.conflicts, ['shared.txt'])
  assert.equal(result.merged_sha, '')
  assert.equal(head(dir), before, 'the integration head never moved')
  assert.equal(result.aborted, true)

  // The decisive one. A conflicted index left behind is an invitation to finish the merge by
  // hand, and a hand-finished merge is indistinguishable downstream from a clean one.
  assert.equal(git(dir, 'status', '--porcelain').stdout.trim(), '',
    'the worktree is clean — nothing is left half-merged')
})

test('an unexpected head refuses before touching anything', (t) => {
  const dir = repo(t)
  commitOn(dir, 'feature', 'feature.txt', 'work\n', 'feat: the work')
  git(dir, 'checkout', '-q', 'main')

  const before = head(dir)
  const result = mergeBranch(dir, 'feature', 'f'.repeat(40))

  assert.equal(result.ok, false)
  assert.match(result.reason, /expected/)
  assert.equal(head(dir), before, 'something moved this branch, so nothing was merged onto it')
})

test('a branch that does not exist is a value, not a throw', (t) => {
  const dir = repo(t)
  const result = mergeBranch(dir, 'no-such-branch')

  assert.equal(result.ok, false)
  assert.equal(result.merged_sha, '')
})

test('an unreadable worktree is a value, not a throw', () => {
  const result = mergeBranch(join(tmpdir(), 'agentics-merge-does-not-exist'), 'feature')

  assert.equal(result.ok, false)
  assert.match(result.reason, /could not be read/)
})
