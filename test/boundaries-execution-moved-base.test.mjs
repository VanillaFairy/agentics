// test/boundaries-execution-moved-base.test.mjs — lib/boundaries/execution.mjs in process, against
// real git and a real ledger: an execution's preflight over a moved base: the stale brief and its
// record, the rulings that are asked or not asked again, and what counts as a move under a leaf.
//
// Every boundary takes an execution's context `xc` (`executionContext` over the execution's log
// port); a refusal is `{ok: false, error: {kind, message}}` and writes nothing. A new run of an
// execution is a fresh context whose log appends `run` first: what follows the latest `run` is the
// current run's. The 4.x courier is gone, so nothing here goes through argv or an envelope payload.
// The fixtures the parts share are in test/harness/execution-world.mjs.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#resume-and-checkpoints, docs/DESIGN.md#scheduling.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preflight } from '../lib/boundaries/execution.mjs'
import { guidanceOf } from '../lib/brief.mjs'
import { staleBrief } from '../lib/briefs/execute.mjs'
import { branchOf, git as storeGit, posix, readConfig, stalePath, worktreeOf } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { STAMP, commitIn, git, leaf, root } from './harness/boundary-fixture.mjs'
import {
  E, ADD, world, ctxOf, commandsFile, envelopeOf, stateKind, head, NO_GAPS, started,
} from './harness/execution-world.mjs'

const SWAPPED = 'export const add = (a, b) => b + a\n'
const SWAPPED_ZERO = 'export const add = (a, b) => b + a + 0\n'
const ORIGINAL_LINE = '-export const add = (a, b) => a + b'

/** The stale brief the contract says preflight writes, from the pieces it names. */
function expectedBrief(r, now, items) {
  const tree = readTree(r, E)
  return staleBrief({
    nodes: items.map(({ node, anchor, writes, reads = [] }) => ({ node, anchor, writes, reads, entry: tree.nodes.get(node) })),
    base_now: now,
    diffs: Object.fromEntries(items.map(({ node, anchor, writes, reads = [] }) =>
      [node, storeGit(r, ['diff', anchor + '..' + now, '--', ...writes, ...reads]).stdout])),
    guidance: guidanceOf(r, { config: readConfig(r) }),
  })
}

// ------------------------------------------------------------------ preflight: a moved base

test('a base that moved under a leaf writes the stale brief and its record beside the state log, and no checkpoint', async (t) => {
  const { r, cf, base } = await started(t)
  const now = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(out.ok, true)
  assert.equal(out.checkpoint, null)
  assert.deepEqual(out.stale.nodes, ['a'], 'b files did not move')
  assert.equal(out.stale.now, now)
  assert.equal(posix(out.stale.brief), stalePath(r, E, STAMP, now))
  assert.equal(posix(out.stale.record), stalePath(r, E, STAMP, now).replace(/\.md$/, '.json'))
  assert.equal(readFileSync(out.stale.brief, 'utf8'), expectedBrief(r, now, [{ node: 'a', anchor: base, writes: [ADD] }]))
  const record = JSON.parse(readFileSync(out.stale.record, 'utf8'))
  assert.equal(record.now, now)
  assert.deepEqual(record.nodes, ['a'])
  assert.equal(stateKind(r, 'checkpoint').length, 0)
})

test('a moved base under a checkpoint writes no stale brief', async (t) => {
  const { r, cf } = await started(t)
  const now = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  const out = await preflight(ctxOf(r), { plan_only: true, commands_file: cf })
  assert.equal(out.checkpoint.reason, 'parked')
  assert.equal(out.stale, null)
  assert.equal(existsSync(stalePath(r, E, STAMP, now)), false)
  assert.equal(existsSync(stalePath(r, E, STAMP, now).replace(/\.md$/, '.json')), false)
})

test('a leaf ruled unaffected against a head is not asked again at that head', async (t) => {
  const { r, cf } = await started(t)
  const now = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  const xc = ctxOf(r)
  assert.deepEqual((await preflight(xc, { commands_file: cf })).stale.nodes, ['a'])
  xc.log.append('stale-ruled', { node: 'a', base_now: now, ruling: 'unaffected', why: 'same sum' })
  const again = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(again.checkpoint, null)
  assert.equal(again.stale, null)
})

test('an affected ruling anchors only once a stop or a replan answers it on disk', async (t) => {
  const { r, cf } = await started(t)
  const now = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  const xc = ctxOf(r)
  assert.deepEqual((await preflight(xc, { commands_file: cf })).stale.nodes, ['a'])
  xc.log.append('stale-ruled', { node: 'a', base_now: now, ruling: 'affected', why: 'the sum moved', question: 'keep the order?' })

  const unanswered = ctxOf(r)
  assert.deepEqual((await preflight(unanswered, { commands_file: cf })).stale.nodes, ['a'], 'a replan that never came leaves the ruling unanswered')

  unanswered.log.append('parked', { node: 'a', return: 'needs_decision', question: '' })
  unanswered.log.append('replanned', { node: 'a', reason: 'answered', by: 'session' })
  const answered = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(answered.stale, null, 'a stop and a replan answered it: the head it was ruled at is the anchor')
})

test('a leaf ruled against one base head is asked only about what moved after it', async (t) => {
  const { r, cf } = await started(t)
  const n1 = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  ctxOf(r).log.append('stale-ruled', { node: 'a', base_now: n1, ruling: 'unaffected', why: 'same sum' })

  commitIn(r, { 'README.md': 'hello again\n' }, 'Greet again')
  const second = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(second.stale.nodes, ['b'], "a new head that leaves a's files alone does not reopen a")

  const n3 = commitIn(r, { [ADD]: SWAPPED_ZERO }, 'Add nothing')
  const third = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual([...third.stale.nodes].sort(), ['a', 'b'])
  assert.equal(third.stale.now, n3)
  const brief = readFileSync(third.stale.brief, 'utf8')
  const diffFromRuled = storeGit(r, ['diff', n1 + '..' + n3, '--', ADD]).stdout.trimEnd()
  assert.ok(brief.includes(diffFromRuled), "a's block shows the change after the head it was ruled at")
  assert.ok(!brief.includes(ORIGINAL_LINE), 'the change a was already ruled against is not shown again')
})

test("a base head the execution's own branch already merged is not a move under its leaves", async (t) => {
  const r = world(t, NO_GAPS)
  const cf = commandsFile(t)
  git(r, 'worktree', 'add', '-q', '-b', branchOf(E, '.'), worktreeOf(r, E, '.'), 'HEAD')
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).ok, true)

  const n1 = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  git(worktreeOf(r, E, '.'), 'merge', '-q', n1)
  const merged = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(merged.checkpoint, null)
  assert.equal(merged.stale, null, 'the head the branch holds is the ground its leaves are cut from')

  const n2 = commitIn(r, { [ADD]: SWAPPED_ZERO }, 'Add nothing')
  const later = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(later.stale.nodes, ['a'])
  const brief = readFileSync(later.stale.brief, 'utf8')
  assert.ok(!brief.includes(ORIGINAL_LINE), 'only what the branch does not hold yet')
  assert.equal(brief, expectedBrief(r, n2, [{ node: 'a', anchor: n1, writes: [ADD] }]))
})

test('a stopped or merged leaf is not asked about a moved base', async (t) => {
  const nodes = [root(), ...['p', 'x', 'm', 'd'].map((id) => leaf(id, { locus: ['src/' + id + '.mjs'] }))]
  const { r, cf } = await started(t, nodes)
  const xc = ctxOf(r)
  xc.log.append('parked', { node: 'p', return: 'needs_decision', question: '' })
  xc.log.append('escalated', { node: 'x', reason: 'blocked', detail: '' })
  xc.log.append('merged', { node: 'm' })
  commitIn(r, Object.fromEntries(['p', 'x', 'm', 'd'].map((id) => ['src/' + id + '.mjs', 'export const v = 1\n'])), 'Touch every file')
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(out.stale.nodes, ['d'], 'only the planned leaf is asked')
  for (const id of ['p', 'x', 'm']) assert.ok(!readFileSync(out.stale.brief, 'utf8').includes('# ' + id + ' '), id + ' is not in the brief')

  const stopped = [root(), ...['p', 'x', 'm'].map((id) => leaf(id, { locus: ['src/' + id + '.mjs'] }))]
  const second = await started(t, stopped)
  const two = ctxOf(second.r)
  two.log.append('parked', { node: 'p', return: 'needs_decision', question: '' })
  two.log.append('escalated', { node: 'x', reason: 'blocked', detail: '' })
  two.log.append('merged', { node: 'm' })
  commitIn(second.r, Object.fromEntries(['p', 'x', 'm'].map((id) => ['src/' + id + '.mjs', 'export const v = 1\n'])), 'Touch every file')
  const none = await preflight(ctxOf(second.r), { commands_file: second.cf })
  assert.equal(none.stale, null)
})

test('a moved file a leaf only reads makes it stale, listed under its reads', async (t) => {
  const { r, cf, base } = await started(t, [root(), leaf('a', { locus: ['src/a.mjs'], reads: [ADD] })])
  const now = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(out.stale.nodes, ['a'])
  assert.equal(readFileSync(out.stale.brief, 'utf8'), expectedBrief(r, now, [{ node: 'a', anchor: base, writes: [], reads: [ADD] }]))
})

test("only the leaves of the execution's folder are asked about a moved base", async (t) => {
  const r = world(t, [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { locus: [ADD] }), leaf('d', { locus: ['README.md'] })])
  const cf = commandsFile(t)
  assert.equal((await preflight(ctxOf(r), { folder: 'c', commands_file: cf })).ok, true)
  commitIn(r, { [ADD]: SWAPPED, 'README.md': 'hello again\n' }, 'Touch both')
  const out = await preflight(ctxOf(r), { folder: 'c', commands_file: cf })
  assert.deepEqual(out.stale.nodes, ['c/a'], 'd is outside the folder this execution runs')
})

test('a ruling at a head outside the span from the held base to now anchors nothing', async (t) => {
  const { r, cf, base } = await started(t)
  const initial = git(r, 'rev-list', '--max-parents=0', 'HEAD')
  const side = join(mkdtempSync(join(tmpdir(), 'agentics-side-')), 'wt')
  t.after(() => rmSync(join(side, '..'), { recursive: true, force: true }))
  git(r, 'worktree', 'add', '-q', '-b', 'side', side, initial)
  const aside = commitIn(side, { [ADD]: 'export const add = () => 42\n' }, 'Diverge')
  const now = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  const xc = ctxOf(r)
  xc.log.append('stale-ruled', { node: 'a', base_now: aside, ruling: 'unaffected', why: 'elsewhere' })
  const out = await preflight(xc, { commands_file: cf })
  assert.deepEqual(out.stale.nodes, ['a'])
  assert.equal(readFileSync(out.stale.brief, 'utf8'), expectedBrief(r, now, [{ node: 'a', anchor: base, writes: [ADD] }]), 'the held base is the anchor')
})

test("the nearest integration branch of the folder decides what its leaves were cut from, not an ancestor's", async (t) => {
  const r = world(t, [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { locus: [ADD] })])
  const cf = commandsFile(t)
  const base = head(r)
  for (const id of ['.', 'c']) git(r, 'worktree', 'add', '-q', '-b', branchOf(E, id), worktreeOf(r, E, id), 'HEAD')
  assert.equal((await preflight(ctxOf(r), { folder: 'c', commands_file: cf })).ok, true)

  const now = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  git(worktreeOf(r, E, '.'), 'merge', '-q', now)
  const out = await preflight(ctxOf(r), { folder: 'c', commands_file: cf })
  assert.deepEqual(out.stale.nodes, ['c/a'], "the root's branch holds the head, but c's branch, which its leaves are cut from, does not")
  assert.equal(readFileSync(out.stale.brief, 'utf8'), expectedBrief(r, now, [{ node: 'c/a', anchor: base, writes: [ADD] }]))

  git(worktreeOf(r, E, 'c'), 'merge', '-q', now)
  assert.equal((await preflight(ctxOf(r), { folder: 'c', commands_file: cf })).stale, null)
})

test('an integration branch that does not hold the envelope base is no ground for what moved', async (t) => {
  const r = world(t, NO_GAPS)
  const cf = commandsFile(t)
  const initial = git(r, 'rev-list', '--max-parents=0', 'HEAD')
  git(r, 'worktree', 'add', '-q', '-b', branchOf(E, '.'), worktreeOf(r, E, '.'), initial)
  const base = commitIn(r, { [ADD]: SWAPPED }, 'Settle the operands before the execution starts')
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).ok, true)
  assert.equal(envelopeOf(r).base_sha, base)

  const now = commitIn(r, { 'README.md': 'hello again\n' }, 'Greet again')
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(out.stale.nodes, ['b'], "a's file changed before the base, not since it")
  assert.equal(readFileSync(out.stale.brief, 'utf8'), expectedBrief(r, now, [{ node: 'b', anchor: base, writes: ['README.md'] }]))
})
