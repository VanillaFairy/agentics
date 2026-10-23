// test/boundaries-execution-outside.test.mjs — preflight stops at outside_work while an
// integration branch in the execution's scope holds commits no record accounts for, on every
// launch, and no confirmation passes it.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { preflight } from '../lib/boundaries/execution.mjs'
import { append } from '../lib/ledger.mjs'
import { branchOf, worktreeOf } from '../lib/store.mjs'
import { commitIn, git, leaf, root } from './harness/boundary-fixture.mjs'
import { E, STAMP2, commandsFile, ctxOf, started, stateKind } from './harness/execution-world.mjs'

const NODES = [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { expects: ['src/a.mjs'] }),
  { id: 'd', kind: 'composite', title: 'd', decisions: ['D1'] }, leaf('d/x', { expects: ['src/x.mjs'] })]

/** A branch of `id` cut at `from`, checked out in its worktree: the worktree. */
function cut(r, id, from) {
  git(r, 'branch', branchOf(E, id), from)
  const wt = worktreeOf(r, E, id)
  git(r, 'worktree', 'add', '-q', wt, branchOf(E, id))
  return wt
}

test('no integration branch yet: nothing to account for', async (t) => {
  const { r, cf } = await started(t, NODES)
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).checkpoint, null)
})

test('a commit straight on the effort branch stops the launch at outside_work, naming the branch and the commit', async (t) => {
  const { r, cf, base } = await started(t, NODES)
  const stray = commitIn(cut(r, '.', base), { 'docs/stray.md': 's\n' }, 'by hand')
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(out.ok, true)
  assert.equal(out.checkpoint.reason, 'outside_work')
  assert.ok(out.checkpoint.detail.includes(branchOf(E, '.')) && out.checkpoint.detail.includes(stray.slice(0, 8)), out.checkpoint.detail)
  assert.deepEqual(stateKind(r, 'checkpoint').pop().branches, [{ branch: branchOf(E, '.'), commits: [stray] }])
  assert.equal(out.stale, null, 'nothing else is examined at a checkpoint')
})

test('a confirmation does not pass outside_work', async (t) => {
  const { r, cf, base } = await started(t, NODES)
  commitIn(cut(r, '.', base), { 'docs/stray.md': 's\n' }, 'by hand')
  const first = await preflight(ctxOf(r), { commands_file: cf })
  const again = await preflight(ctxOf(r), { commands_file: cf, confirmed: first.checkpoint.seq })
  assert.equal(again.checkpoint.reason, 'outside_work')
  assert.equal(stateKind(r, 'checkpoint-confirmed').length, 0)
})

test('it is raised on every launch while the commits remain, and a record naming them clears it', async (t) => {
  const { r, cf, base } = await started(t, NODES)
  const stray = commitIn(cut(r, '.', base), { 'docs/stray.md': 's\n' }, 'by hand')
  for (let i = 0; i < 2; i++) assert.equal((await preflight(ctxOf(r), { commands_file: cf })).checkpoint.reason, 'outside_work')
  append(r, E, 'events', { kind: 'outside', node: '.', execution: '', commits: [stray], by: 'user' })
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).checkpoint, null)
})

test("a descendant composite's branch is checked, and one outside the execution's scope is not", async (t) => {
  const { r, cf, base } = await started(t, NODES)
  cut(r, '.', base)
  const stray = commitIn(cut(r, 'd', base), { 'src/x.mjs': 'x\n' }, 'by hand in d')
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(stateKind(r, 'checkpoint').pop().branches, [{ branch: branchOf(E, 'd'), commits: [stray] }])
  assert.equal(out.checkpoint.reason, 'outside_work')
  const beside = await preflight(ctxOf(r, STAMP2), { folder: 'c', commands_file: commandsFile(t, undefined, 'c.json') })
  assert.notEqual(beside.checkpoint && beside.checkpoint.reason, 'outside_work', 'd is not under c')
})

test('outside_work is the first checkpoint, before an overlapping execution', async (t) => {
  const { r, cf, base } = await started(t, NODES)
  commitIn(cut(r, '.', base), { 'docs/stray.md': 's\n' }, 'by hand')
  const out = await preflight(ctxOf(r, STAMP2), { folder: 'c', commands_file: cf })
  assert.equal(out.checkpoint.reason, 'existing_execution', 'the root branch is not in c\'s scope')
  const rootRun = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(rootRun.checkpoint.reason, 'outside_work', 'the open execution over c overlaps, and outside work is named first')
})

test("a leaf merged the way merge-batch merges, with its approval recorded, is no outside work", async (t) => {
  const { r, cf, base } = await started(t, NODES)
  cut(r, '.', base)
  const c = cut(r, 'c', base)
  const leafWt = cut(r, 'c/a', base)
  const tip = commitIn(leafWt, { 'src/a.mjs': 'a\n' }, 'feat(c/a): done')
  append(r, E, 'events', { kind: 'approved', node: 'c/a', execution: '', head_sha: tip, review_rounds: 1, at_integration: false })
  git(c, 'merge', '--no-ff', '--no-edit', branchOf(E, 'c/a'))
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).checkpoint, null)
})

test('a leaf branch still at work, ahead of its folder, is no outside work', async (t) => {
  const { r, cf, base } = await started(t, NODES)
  cut(r, '.', base)
  cut(r, 'c', base)
  commitIn(cut(r, 'c/a', base), { 'src/a.mjs': 'a\n' }, 'feat(c/a): wip')
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).checkpoint, null)
})
