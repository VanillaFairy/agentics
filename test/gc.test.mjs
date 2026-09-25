// test/gc.test.mjs — lib/gc.mjs, against real repositories.
//
// The property worth pinning is the reference point. `git branch -d` refuses an unmerged
// branch, and that refusal is the entire safety of this file — but "merged" is a question about
// HEAD, so it is only the right question when HEAD is the checkout that accepted the run. Asked
// from anywhere else it is answered confidently and about the wrong tree. So the first test
// below is the one that matters: from a checkout that does not carry the integration merge,
// nothing is swept at all.
//
// The second property is that unmerged work survives without gc being told which orders were
// escalated or held. A held red whose green never landed and an escalated order look identical
// to git — neither is in HEAD — and that one test covers both.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { collect } from '../lib/gc.mjs'

const RUNSTAMP = '20260830-120000'
const INTEGRATION = 'agentics/' + RUNSTAMP + '-integration'
const orderBranch = (id) => 'agentics/' + RUNSTAMP + '-' + id

const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const branches = (dir) =>
  git(dir, 'branch', '--list', 'agentics/*', '--format=%(refname:short)')
    .stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean)

/**
 * A run as it stands the moment a human accepts it: W1 approved and merged into the
 * integration branch, integration merged into `main`, W2 still sitting on its own branch.
 */
function acceptedRun(t, { acceptOnMain = true, worktrees = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-gc-')).split('\\').join('/')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  git(dir, 'init', '-q', '-b', 'main', '.')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')

  git(dir, 'branch', INTEGRATION)

  for (const id of ['W1', 'W2']) {
    git(dir, 'checkout', '-q', '-b', orderBranch(id), 'main')
    writeFileSync(join(dir, id + '.txt'), 'work\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'feat: ' + id)
  }

  git(dir, 'checkout', '-q', INTEGRATION)
  git(dir, 'merge', '-q', '--no-ff', '--no-edit', orderBranch('W1'))
  git(dir, 'checkout', '-q', 'main')
  if (acceptOnMain) git(dir, 'merge', '-q', '--no-ff', '--no-edit', INTEGRATION)

  for (const id of worktrees) {
    git(dir, 'worktree', 'add', '-q', dir + '/wt-' + id, orderBranch(id))
  }

  return dir
}

test('a checkout that does not carry the integration merge sweeps nothing', (t) => {
  // The whole point. From here `git branch -d` would refuse everything and a caller could
  // easily read that as "there was nothing to collect" — so the refusal is stated up front,
  // before a single branch is touched.
  const dir = acceptedRun(t, { acceptOnMain: false })
  const before = branches(dir)

  const result = collect(dir, RUNSTAMP)

  assert.equal(result.ok, false)
  assert.match(result.reason, /does not contain/)
  assert.deepEqual(result.deleted_branches, [])
  assert.deepEqual(result.removed_worktrees, [])
  assert.deepEqual(branches(dir), before, 'every branch is exactly where it was')
})

test('a missing integration branch is a missing reference point, not an empty run', (t) => {
  const dir = acceptedRun(t)
  git(dir, 'branch', '-D', INTEGRATION)
  const before = branches(dir)

  const result = collect(dir, RUNSTAMP)

  assert.equal(result.ok, false)
  assert.match(result.reason, /no reference point/)
  assert.deepEqual(branches(dir), before)
})

test('merged branches are deleted and unmerged ones are kept, with a reason', (t) => {
  const dir = acceptedRun(t)

  const result = collect(dir, RUNSTAMP)

  assert.equal(result.ok, true)
  assert.deepEqual(result.deleted_branches.map((b) => b.branch).sort(),
    [INTEGRATION, orderBranch('W1')].sort())

  const keptW2 = result.kept.find((k) => k.branch === orderBranch('W2') && k.what === 'branch')
  assert.ok(keptW2, 'the branch nobody merged is reported, not silently skipped')
  assert.match(keptW2.reason, /not in HEAD/)

  assert.deepEqual(branches(dir), [orderBranch('W2')],
    'and it is still there afterwards')
})

test("a held pair's unlanded half keeps its branch AND its worktree", (t) => {
  // A red order held for a green that never landed, and an escalated order, are the same fact
  // to git: not in HEAD. Neither the ledger nor a list of escalated ids is consulted — the one
  // merged-into-HEAD test answers for both.
  const dir = acceptedRun(t, { worktrees: ['W2'] })

  const result = collect(dir, RUNSTAMP)

  assert.equal(result.ok, true)
  assert.ok(existsSync(dir + '/wt-W2'), 'the worktree is the resumable state; it survives')
  assert.ok(result.kept.some((k) => k.what === 'worktree' && k.branch === orderBranch('W2')),
    'and it is reported as kept rather than quietly left behind')
  assert.deepEqual(result.removed_worktrees, [])
})

test('a merged order\'s worktree is pruned before its branch is deleted', (t) => {
  const dir = acceptedRun(t, { worktrees: ['W1'] })

  const result = collect(dir, RUNSTAMP)

  assert.equal(result.ok, true)
  assert.ok(!existsSync(dir + '/wt-W1'), 'the tree is gone')
  assert.deepEqual(result.removed_worktrees.map((w) => w.branch), [orderBranch('W1')])
  assert.ok(result.deleted_branches.some((b) => b.branch === orderBranch('W1')),
    'a branch still checked out somewhere cannot be deleted, so the order matters')
})

test('a dirty worktree is kept, and so is the branch it holds', (t) => {
  const dir = acceptedRun(t, { worktrees: ['W1'] })
  writeFileSync(join(dir, 'wt-W1', 'scratch.txt'), 'uncommitted\n')

  const result = collect(dir, RUNSTAMP)

  assert.equal(result.ok, true)
  assert.ok(existsSync(dir + '/wt-W1'), 'never --force: uncommitted work is nobody else\'s to discard')
  assert.ok(result.kept.some((k) => k.what === 'branch' && k.branch === orderBranch('W1')),
    'and the branch stays with it, since the tree still holds it')
  assert.ok(branches(dir).includes(orderBranch('W1')))
})

test('a worktree swept by hand no longer blocks its branch', (t) => {
  // The 2026-08-27 state: trees deleted by a human, registrations left behind, and every
  // branch reading as "checked out somewhere" forever.
  const dir = acceptedRun(t, { worktrees: ['W1'] })
  rmSync(dir + '/wt-W1', { recursive: true, force: true })

  const result = collect(dir, RUNSTAMP)

  assert.equal(result.ok, true)
  assert.ok(result.deleted_branches.some((b) => b.branch === orderBranch('W1')))
})

test("another run's branches are never in scope", (t) => {
  const dir = acceptedRun(t)
  git(dir, 'branch', 'agentics/20260101-000000-W1', 'main')

  const result = collect(dir, RUNSTAMP)

  assert.equal(result.ok, true)
  assert.ok(!result.deleted_branches.some((b) => b.branch.startsWith('agentics/20260101')))
  assert.ok(branches(dir).includes('agentics/20260101-000000-W1'),
    'a repository holds several runs at once; a sweep bounded by anything looser is a hazard')
})

test('a repository that is not one is a value, not a throw', () => {
  const result = collect(join(tmpdir(), 'agentics-gc-does-not-exist'), RUNSTAMP)

  assert.equal(result.ok, false)
  assert.deepEqual(result.kept, [])
})

test('no runstamp collects nothing at all', (t) => {
  const dir = acceptedRun(t)
  const before = branches(dir)

  assert.equal(collect(dir, '').ok, false)
  assert.deepEqual(branches(dir), before)
})
