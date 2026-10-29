// test/boundaries-merge-batch.test.mjs — lib/boundaries/merge.mjs: the merge batch and its
// measurement, in process, over real git and the real measurement.
//
// What is pinned here:
//
//   mergeBatch  dependency order and a cycle's one merge; the fast or the full suite, through
//               `measure`; the bisect of a red merged head (the leaf failing alone, the rest merge);
//               the worktrees, locks, records and messages a batch leaves; a combination failure
//               leaves nothing merged; a batch run again after its outcome merges nothing twice
//
// Every repository is built with the fixture's seeding helpers; preflight and leaf-open are stood
// in for by the lib calls they make (`execution.json`, `acquireAsync`, `ensureIntegration`,
// `ensureLeaf`, a `dispatched` event). Expected heads, branches, rounds and record paths are
// computed. The worlds the parts share are in test/harness/merge-world.mjs.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#merging.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mergeBatch } from '../lib/boundaries/merge.mjs'
import { worktrees } from '../lib/integration.mjs'
import { branchOf, posix, readJson } from '../lib/store.mjs'
import { STAMP, git, leaf, root } from './harness/boundary-fixture.mjs'
import {
  E, SLOW, SPLIT, BREAK_ADD, FLIP_ADD, BREAK_BIG, R_TEST, inTest, stateOf, eventsOf, journalOf, headOf,
  statusOf, ids, kindOf, world, dispatch, ready, handed, batch, addBigTest, addOne,
} from './harness/merge-world.mjs'

// ------------------------------------------------------------------ shared batches
// A bisect costs three measurements: the tests that read one batch share it, built once and removed
// when the file ends. A test that runs a shared batch again comes after every test that reads it.

// A shared repository outlives the test that first awaits it: its cleanup is the file's, registered
// here at module scope (the module's `after` called from inside a test would attach to that test).
const sharedCleanups = []
after(() => { for (const fn of sharedCleanups) fn() })
const whenFileEnds = (fn) => sharedCleanups.push(fn)

let bisectedP
/** x breaks the suite alone, y does not; x has been dispatched twice. */
const bisected = () => (bisectedP ??= (async () => {
  const w = world(whenFileEnds, [root(), addOne('x'), leaf('y', { rigor: 'trivial', expects: ['README.md'] })])
  const x = await ready(w, 'x', { 'src/add.mjs': BREAK_ADD }, 'Break add')
  dispatch(w, 'x', 2)
  const y = await ready(w, 'y', { 'README.md': 'hello world\n' }, 'Greet the world')
  const pre = headOf(w.r, '.')
  const children = handed(x, y)
  const out = await batch(w, children)
  return { w, x, y, pre, children, out }
})())

let passingP
/** x passes: the one leaf of the root, merged. */
const passing = () => (passingP ??= (async () => {
  const w = world(whenFileEnds, [root(), addOne('x')])
  const x = await ready(w, 'x', { 'src/add.mjs': FLIP_ADD }, 'Add in the other order')
  const pre = headOf(w.r, '.')
  const children = handed(x)
  const out = await batch(w, children)
  return { w, x, pre, children, out }
})())

// ================================================================== merging

test('a batch whose execution was paused while it waited for the lock merges nothing and records nothing', SLOW, async (t) => {
  const w = world(inTest(t), [root(), leaf('x', { rigor: 'trivial', expects: ['x.txt'] })])
  const x = await ready(w, 'x', { 'x.txt': 'x\n' }, 'Add x')
  const pre = headOf(w.r, '.')
  const recorded = stateOf(w.r).length
  const out = await mergeBatch(w.xc, { target: '.', children: handed(x), paused: () => true })
  assert.equal(out.status, 'paused')
  assert.deepEqual(out.merged, [])
  assert.equal(headOf(w.r, '.'), pre, 'the integration branch did not move')
  assert.equal(stateOf(w.r).length, recorded, 'no batch-started, no batch')
  assert.notEqual(statusOf(w.r, 'x'), 'merged')
})

test('children merge in dependency order, whatever order they are handed in', SLOW, async (t) => {
  const w = world(inTest(t), [root(),
    leaf('x', { rigor: 'trivial', expects: ['x.txt'] }),
    leaf('y', { rigor: 'trivial', expects: ['y.txt'], deps: ['x'] })])
  const x = await ready(w, 'x', { 'x.txt': 'x\n' }, 'Add x')
  const y = await ready(w, 'y', { 'y.txt': 'y\n' }, 'Add y')
  const pre = headOf(w.r, '.')
  const out = await batch(w, handed(y, x))

  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.deepEqual(ids(out.merged), ['x', 'y'])
  assert.deepEqual(kindOf(eventsOf(w.r), 'merged').map((e) => e.node), ['x', 'y'])
  const merges = git(w.r, 'rev-list', '--first-parent', '--merges', '--reverse', pre + '..' + out.head_sha).split('\n').filter(Boolean)
  assert.deepEqual(merges.map((c) => git(w.r, 'rev-parse', c + '^2')), [x.head_sha, y.head_sha], 'the second parents of the merges, oldest first')
  assert.deepEqual(out.merged.map((m) => m.merged_sha), merges, 'each child at its own merge commit')
})

test('a cycle merges through its tip in one merge, and every member is recorded merged at that sha', SLOW, async (t) => {
  const w = world(inTest(t), [root(),
    leaf('r', { rigor: 'tdd-pair', role: 'red', expects: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], expects: ['src/r.mjs'] })])
  const r = await ready(w, 'r', { 'test/r.test.mjs': R_TEST }, 'Pin r')
  const g = await ready(w, 'g', { 'src/r.mjs': 'export const r = () => 1\n' }, 'Implement r', { from: r.head_sha, cycleMember: true })
  const pre = headOf(w.r, '.')
  const out = await mergeBatch(w.xc, { target: '.', children: handed(r, g), cycles: [['r', 'g']] })

  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.deepEqual(ids(out.merged), ['r', 'g'])
  const sha = out.merged[1].merged_sha
  assert.equal(out.merged[0].merged_sha, sha, 'one merge for the cycle')
  assert.equal(git(w.r, 'rev-parse', sha + '^2'), g.head_sha, 'its second parent is the tip')
  assert.deepEqual(git(w.r, 'rev-list', '--first-parent', '--merges', pre + '..' + out.head_sha).split('\n').filter(Boolean), [sha], 'one merge commit in all')
  const events = kindOf(eventsOf(w.r), 'merged')
  assert.deepEqual(events.map((e) => e.node), ['r', 'g'])
  assert.deepEqual(events.map((e) => e.merged_sha), [sha, sha])
})

test('the merged head is measured with the fast suite, through measure', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('a')], { commands: SPLIT, prepare: addBigTest })
  const a = await ready(w, 'a', { 'src/add.mjs': BREAK_BIG }, 'Break only the big test')
  const out = await batch(w, handed(a))

  assert.equal(out.verified, true, 'the fast suite does not run the big test')
  assert.equal(readJson(out.drift_record).measurement.suite_scope, 'fast')
  const seen = kindOf(journalOf(w.r), 'verify-observed', '.')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].suite_scope, 'fast')
  assert.equal(typeof seen[0].key, 'string')
  assert.notEqual(seen[0].key, '')
})

test('the merged head is measured with the full suite where the tests are not split', SLOW, async () => {
  const { out } = await passing()
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(readJson(out.drift_record).measurement.suite_scope, 'full')
})

test('a red merged head is bisected: the leaf failing alone is named, the rest merge', SLOW, async () => {
  const { w, out } = await bisected()

  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.status, 'done')
  assert.deepEqual(ids(out.merged), ['y'])
  assert.deepEqual(ids(out.failed_alone), ['x'])
  assert.equal(out.verified, true, 'what merged is green')
  assert.equal(readJson(out.drift_record).failed_alone[0].failures[0].check, 'suite', 'what failed, and how, stays on disk')
  assert.deepEqual(out.stops, [], 'a leaf failing alone is no stop: it gets a fix round')
  assert.equal(statusOf(w.r, 'x'), 'active')
  assert.equal(statusOf(w.r, 'y'), 'merged')
})

test('a merged leaf loses its worktree and keeps its branch; a leaf failing alone keeps both', SLOW, async () => {
  const { w, x, y, out } = await bisected()
  assert.deepEqual(ids(out.merged), ['y'])

  assert.equal(existsSync(y.worktree), false)
  assert.equal(worktrees(w.r).has(posix(y.worktree)), false, 'git lists it no more')
  assert.equal(git(w.r, 'rev-parse', y.branch), y.head_sha, 'the branch stays at its head')
  assert.equal(existsSync(x.worktree), true)
  assert.equal(worktrees(w.r).has(posix(x.worktree)), true)
  assert.equal(git(x.worktree, 'rev-parse', 'HEAD'), x.head_sha, 'the fix round works where it worked')
  assert.equal(git(w.r, 'rev-parse', x.branch), x.head_sha)
})

test('a batch records batch-started, merged, merge-observed and its batch line', SLOW, async () => {
  const { w, x, y, pre, out } = await bisected()
  const state = stateOf(w.r)
  const events = eventsOf(w.r)
  const journal = journalOf(w.r)

  const started = kindOf(state, 'batch-started')
  assert.equal(started.length, 1)
  assert.equal(started[0].target, '.')
  assert.equal(started[0].pre, pre)
  assert.deepEqual([...started[0].children].sort(), ['x', 'y'])

  const merged = kindOf(events, 'merged')
  assert.equal(merged.length, 1, 'one merged event, of the merged leaf')
  assert.equal(merged[0].node, 'y')
  assert.equal(merged[0].into, branchOf(E, '.'))
  assert.equal(merged[0].merged_sha, out.merged[0].merged_sha)
  assert.equal(merged[0].head_sha, y.head_sha, 'the child\'s approved head')
  assert.equal(merged[0].execution, STAMP)

  const observed = kindOf(journal, 'merge-observed')
  assert.equal(observed.length, 1)
  assert.equal(observed[0].node, 'y')
  assert.equal(observed[0].branch, branchOf(E, 'y'))
  assert.equal(observed[0].into, branchOf(E, '.'))
  assert.equal(observed[0].merged_sha, out.merged[0].merged_sha)
  assert.equal(observed[0].head_sha, headOf(w.r, '.'), 'the integration head')

  const lines = kindOf(state, 'batch')
  assert.equal(lines.length, 1)
  const line = lines[0]
  assert.deepEqual(
    { target: line.target, merged: line.merged, head_sha: line.head_sha, verified: line.verified, failed_alone: line.failed_alone, combination: line.combination, conflict: line.conflict },
    { target: '.', merged: ['y'], head_sha: out.head_sha, verified: true, failed_alone: [x.id], combination: [], conflict: '' })
  assert.ok(started[0].seq < line.seq, 'the batch line follows batch-started')
  assert.ok(line.seq < merged[0].seq && line.seq < observed[0].seq, 'and lands before the merged and merge-observed lines')
  assert.equal(out.head_sha, headOf(w.r, '.'), 'the return\'s head is the integration branch\'s')
})

test('a leaf failing alone is sent its failures from integration for its next round, once', SLOW, async () => {
  const { w, children, out } = await bisected()
  assert.deepEqual(ids(out.failed_alone), ['x'])
  const rounds = kindOf(eventsOf(w.r), 'dispatched', 'x').map((e) => e.round)
  const latest = Math.max(...rounds)
  assert.ok(latest >= 2, 'the fixture dispatched x more than once')

  const sent = () => kindOf(eventsOf(w.r), 'message')
  assert.equal(sent().length, 1, 'one message in all: the merged leaf is sent none')
  const m = sent()[0]
  assert.equal(m.node, 'x')
  assert.equal(m.thread, 'producer:x')
  assert.equal(m.from, 'code')
  assert.equal(m.msg, 'failures')
  assert.equal(m.round, latest + 1, 'one past its latest dispatched round')
  assert.equal(m.payload.source, 'integration')
  assert.equal(m.payload.failures[0].check, 'suite')
  for (const f of m.payload.failures) assert.deepEqual(Object.keys(f).sort(), ['check', 'claim', 'evidence'])

  const again = await batch(w, children)
  assert.deepEqual(ids(again.failed_alone), ['x'], 'still failing alone')
  assert.equal(sent().length, 1, 'and not sent the same words twice')
})

test('merged children leave their composite to its review', SLOW, async () => {
  const { w, out } = await passing()
  assert.deepEqual(ids(out.merged), ['x'])
  assert.equal(statusOf(w.r, 'x'), 'merged')
  assert.equal(statusOf(w.r, '.'), 'reviewing')
})

test('a batch run again after its outcome merges nothing twice', SLOW, async () => {
  const { w, children, out } = await passing()
  assert.deepEqual(out.stops, [])
  const again = await batch(w, children)

  assert.equal(again.ok, true)
  assert.equal(again.head_sha, out.head_sha)
  assert.deepEqual(again.stops, [])
  assert.equal(kindOf(eventsOf(w.r), 'merged').length, 1)
  assert.equal(kindOf(journalOf(w.r), 'merge-observed').length, 1)
  assert.equal(kindOf(stateOf(w.r), 'batch-started').length, 1)
  assert.equal(kindOf(stateOf(w.r), 'batch').length, 1)
})
