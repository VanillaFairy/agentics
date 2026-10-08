// test/boundaries-execution-schedule.test.mjs — lib/boundaries/execution.mjs in process, against
// real git and a real ledger: the rest of an execution's preflight (cleanup of slots and worktrees,
// the dispatches a dead run left open), its schedule (what launches, what it records before it
// returns) and its postflight (the summary, the close).
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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { postflight, preflight, schedule } from '../lib/boundaries/execution.mjs'
import { executionContext, fault, recordAll } from '../lib/boundaries/records.mjs'
import { executionLog, readLog } from '../lib/ledger.mjs'
import { acquire, heldBy, maxParallel } from '../lib/locks.mjs'
import { branchExists, branchOf, configPath, executionDir, posix, worktreeOf } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { COMMANDS, STAMP, commitIn, git, leaf, root } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import {
  E, STAMP2, ADD, world, ctxOf, commandsFile, envPath, stateOf, journalOf, stateKind, head, NO_GAPS, started,
} from './harness/execution-world.mjs'

const eventsOf = (r, kind) => readLog(r, E, 'events').entries.filter((e) => e.kind === kind)

const worktreeList = (r) => git(r, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => posix(l.slice(9).trim()))

/** An execution's envelope written the way a first preflight writes it, for the boundaries after it. */
function envelopeFor(r, stamp = STAMP, rootId = '.') {
  mkdirSync(executionDir(r, E, stamp), { recursive: true })
  const env = { stamp, root: rootId, base_branch: 'main', base_sha: head(r), dial: 'normal', pace: 'balanced', commands: COMMANDS }
  writeFileSync(envPath(r, stamp), JSON.stringify(env, null, 1) + '\n')
}

/** The fields of a `verify-observed` line that measured a leaf green at `sha` (its `kind` is the port's). */
const greenFields = (id, sha) => ({
  node: id, branch: branchOf(E, id), worktree: '', base_sha: '', head_sha: sha,
  stop_reason: 'completed', build: 'passed', typecheck: 'absent', suite: 'passed', failing_tests: [],
  discriminator: [{ test_id: 'test/x.test.mjs', failed_on_base: true, passes_now: true }],
  mutations: [], series_findings: [], checks: [],
})

/** Leaf `id`'s branch under the root's integration branch, one commit on it, measured green there. Its head. */
function greenLeaf(r, xc, id, file) {
  if (!branchExists(r, branchOf(E, '.'))) git(r, 'branch', branchOf(E, '.'), 'HEAD')
  git(r, 'worktree', 'add', '-q', '-b', branchOf(E, id), worktreeOf(r, E, id), branchOf(E, '.'))
  const sha = commitIn(worktreeOf(r, E, id), { [file]: 'export const x = 1\n' }, 'feat(' + id + '): done')
  xc.log.append('verify-observed', greenFields(id, sha))
  return sha
}

const dispatchedFields = (dispatch, over = {}) =>
  ({ dispatch, node: 'a', round: 1, thread: 'a:implementer', role: 'implementer', session: 's-' + dispatch, pid: 0, ...over })

const ids = (launch) => launch.map((l) => l.unit + ':' + l.id)

// ------------------------------------------------------------------ preflight: cleanup

test("preflight frees this execution's slots and no other execution's", async (t) => {
  const r = world(t, NO_GAPS)
  assert.equal(acquire(r, { effort: E, execution: STAMP, node: 'a', locus: [ADD] }).ok, true)
  assert.equal(acquire(r, { effort: E, execution: STAMP2, node: 'b', locus: ['README.md'] }).ok, true)
  assert.equal(heldBy(r).slots.length, 2)
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  assert.deepEqual(heldBy(r).slots.map((s) => [s.execution, s.node]), [[STAMP2, 'b']])
})

/** A leaf `a` branch checked out in a worktree at `path`. */
const checkoutOf = (r, path) => git(r, 'worktree', 'add', '-q', '-b', branchOf(E, 'a'), path, 'HEAD')

test("a leftover worktree of the effort's branch away from its own path is removed, its branch kept", async (t) => {
  const r = world(t, NO_GAPS)
  const stray = join(r, '.claude', 'worktrees', 'stray')
  checkoutOf(r, stray)
  assert.ok(worktreeList(r).some((p) => p.endsWith('/.claude/worktrees/stray')))
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  assert.ok(!worktreeList(r).some((p) => p.endsWith('/.claude/worktrees/stray')), 'the leftover is gone from git worktree list')
  assert.deepEqual(out.dirty_worktrees, [])
  assert.equal(branchExists(r, branchOf(E, 'a')), true, 'the branch is kept')
})

test("a merged leaf's clean worktree is removed, its branch kept", async (t) => {
  const { r, cf } = await started(t)
  const own = worktreeOf(r, E, 'a')
  checkoutOf(r, own)
  ctxOf(r).log.append('merged', { node: 'a' })
  assert.ok(worktreeList(r).includes(posix(own)))
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(out.ok, true)
  assert.ok(!worktreeList(r).includes(posix(own)))
  assert.deepEqual(out.dirty_worktrees, [])
  assert.equal(branchExists(r, branchOf(E, 'a')), true)
})

test("an unmerged leaf's own worktree is kept", async (t) => {
  const { r, cf } = await started(t)
  const own = worktreeOf(r, E, 'a')
  checkoutOf(r, own)
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(out.ok, true)
  assert.ok(worktreeList(r).includes(posix(own)), 'a leaf at its own path is its work in progress')
  assert.deepEqual(out.dirty_worktrees, [])
})

test('a dirty leftover worktree is reported and left in place', async (t) => {
  const r = world(t, NO_GAPS)
  const stray = join(r, '.claude', 'worktrees', 'stray')
  checkoutOf(r, stray)
  writeFileSync(join(stray, 'unsaved.txt'), 'work in progress\n')
  const listed = worktreeList(r).find((p) => p.endsWith('/.claude/worktrees/stray'))
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  assert.deepEqual(out.dirty_worktrees.map(posix), [listed])
  assert.ok(worktreeList(r).includes(listed), 'a dirty checkout is never forced')
  assert.equal(existsSync(join(stray, 'unsaved.txt')), true)
})

test('a checkout of an effort branch outside .claude/worktrees is never touched', async (t) => {
  const r = world(t, NO_GAPS)
  const outside = join(mkdtempSync(join(tmpdir(), 'agentics-outside-')), 'mine')
  t.after(() => rmSync(join(outside, '..'), { recursive: true, force: true }))
  checkoutOf(r, outside)
  assert.ok(worktreeList(r).some((p) => p.endsWith('/mine')))
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  assert.ok(worktreeList(r).some((p) => p.endsWith('/mine')), 'it stays listed')
  assert.deepEqual(out.dirty_worktrees, [])
  assert.equal(existsSync(outside), true)
})

test('a worktree under .claude/worktrees on a branch that is not this effort\'s is left alone', async (t) => {
  const r = world(t, NO_GAPS)
  const kept = ['feature', 'other'].map((name) => join(r, '.claude', 'worktrees', name))
  git(r, 'worktree', 'add', '-q', '-b', 'feature/x', kept[0], 'HEAD')
  git(r, 'worktree', 'add', '-q', '-b', branchOf('e10', 'a'), kept[1], 'HEAD')
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  const listed = worktreeList(r)
  assert.ok(listed.some((p) => p.endsWith('/.claude/worktrees/feature')), 'another branch is not the effort\'s')
  assert.ok(listed.some((p) => p.endsWith('/.claude/worktrees/other')), "effort e10's branch is not effort e1's")
  assert.deepEqual(out.dirty_worktrees, [])
})

// ------------------------------------------------------------------ preflight: what it reports

test('open_dispatches lists each dispatched with no returned and no host_stop after it', async (t) => {
  const { r, cf } = await started(t)
  const run = ctxOf(r)
  run.log.append('dispatched', dispatchedFields('d-a', { node: 'a', round: 2, thread: 'a:implementer', role: 'implementer' }))
  run.log.append('dispatched', dispatchedFields('d-b', { node: 'b' }))
  run.log.append('returned', { dispatch: 'd-b', session: 's-d-b', status: 'returned', cause: '' })
  run.log.append('dispatched', dispatchedFields('d-c', { node: 'b' }))
  run.log.append('host_stop', { dispatch: 'd-c', cause: 'rate_limit', until: '' })
  run.log.append('dispatched', dispatchedFields('d-e', { node: 'b', round: 3, thread: 'b:reviewer', role: 'reviewer' }))

  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(out.ok, true)
  const open = out.open_dispatches.map(({ dispatch, node, thread, role, round }) => ({ dispatch, node, thread, role, round }))
  assert.deepEqual(open, [
    { dispatch: 'd-a', node: 'a', thread: 'a:implementer', role: 'implementer', round: 2 },
    { dispatch: 'd-e', node: 'b', thread: 'b:reviewer', role: 'reviewer', round: 3 },
  ], 'in the order they were dispatched')
})

test('a dispatch started again after its host stop is open, once', async (t) => {
  const { r, cf } = await started(t)
  const run = ctxOf(r)
  run.log.append('dispatched', dispatchedFields('d-a', { round: 1 }))
  run.log.append('host_stop', { dispatch: 'd-a', cause: 'rate_limit', until: '' })
  run.log.append('dispatched', dispatchedFields('d-a', { round: 2 }))
  run.log.append('dispatched', dispatchedFields('d-r', { node: 'b', round: 1 }))
  run.log.append('returned', { dispatch: 'd-r', session: 's-d-r', status: 'returned', cause: '' })
  run.log.append('dispatched', dispatchedFields('d-r', { node: 'b', round: 2 }))

  const out = await preflight(ctxOf(r), { commands_file: cf })
  const open = out.open_dispatches.map(({ dispatch, round }) => ({ dispatch, round }))
  assert.deepEqual(open, [{ dispatch: 'd-a', round: 2 }, { dispatch: 'd-r', round: 2 }], 'each key once, at its latest dispatched')
})

// ------------------------------------------------------------------ schedule

test('schedule refuses an execution with no envelope, and an unreadable tree', async (t) => {
  const r = world(t, NO_GAPS)
  const none = await schedule(ctxOf(r, STAMP, { run: false }), {})
  assert.equal(none.ok, false)
  assert.equal(none.error.kind, 'no_execution')
  assert.deepEqual(stateOf(r), [], 'a refusal records nothing')

  const bad = executionContext({ repo: r, effort: 'Not An Effort!', execution: STAMP, log: executionLog(r, E, STAMP) })
  mkdirSync(bad.dir, { recursive: true })
  writeFileSync(join(bad.dir, 'execution.json'), JSON.stringify({ stamp: STAMP, root: '.', base_branch: 'main', base_sha: head(r), dial: 'normal', pace: 'balanced', commands: COMMANDS }))
  const unreadable = await schedule(bad, {})
  assert.equal(unreadable.ok, false)
  assert.equal(unreadable.error.kind, 'unreadable')
})

test('schedule launches the ready leaves, and none behind an unmerged dependency', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'], deps: ['a'] })])
  envelopeFor(r)
  const out = await schedule(ctxOf(r), {})
  assert.equal(out.ok, true)
  assert.deepEqual(ids(out.launch), ['leaf:a'])
  assert.deepEqual(out.stops, [])
  assert.equal(out.idle, false)
})

test('schedule launches nothing beneath a folder being planned', async (t) => {
  const r = world(t, [root(), { id: 'f', kind: 'composite', title: 'f', decisions: ['D1'] }, leaf('f/a', { locus: ['src/fa.mjs'] }), leaf('b', { locus: ['src/b.mjs'] })])
  envelopeFor(r)
  const xc = ctxOf(r)
  assert.deepEqual(ids((await schedule(xc, { planning: [] })).launch).sort(), ['leaf:b', 'leaf:f/a'])
  assert.deepEqual(ids((await schedule(xc, { planning: ['f'] })).launch), ['leaf:b'])
})

test("schedule launches no more leaves than the pool allows, and only those of the execution's folder", async (t) => {
  const r = world(t, [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { locus: ['src/ca.mjs'] }), leaf('c/b', { locus: ['src/cb.mjs'] }), leaf('d', { locus: ['src/d.mjs'] })])
  mkdirSync(join(configPath(r), '..'), { recursive: true })
  writeFileSync(configPath(r), JSON.stringify({ max_parallel: 1 }))
  envelopeFor(r, STAMP, 'c')
  const xc = ctxOf(r)
  const first = await schedule(xc, {})
  assert.equal(first.launch.length, 1, 'the pool is one')
  assert.ok(first.launch[0].id.startsWith('c/'), 'd is outside the execution folder')
  assert.deepEqual(ids((await schedule(xc, { running: ['leaf:c/a'] })).launch), [], 'the one slot is taken')
})

test('schedule holds a node with a fault after the latest run, and takes it up in the next run', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'] })])
  envelopeFor(r)
  const xc = ctxOf(r)
  recordAll(xc, [fault('a', 'role', 'the dispatch returned nothing')])
  assert.deepEqual(ids((await schedule(xc, { running: [] })).launch), ['leaf:b'], 'a held node is not launched again in this run')
  assert.deepEqual(ids((await schedule(xc, { running: [] })).launch), ['leaf:b'])
  assert.equal(stateKind(r, 'fault').length, 1)

  const next = await schedule(ctxOf(r), { running: [] })
  assert.deepEqual(ids(next.launch).sort(), ['leaf:a', 'leaf:b'], 'the next run takes it up')
})

test('schedule parks a childless folder the user writes needs_design and launches it nowhere', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] }), { id: 'mine', kind: 'design', title: 'my part', author: 'you' }])
  envelopeFor(r)
  const out = await schedule(ctxOf(r), {})
  assert.equal(out.ok, true)
  assert.deepEqual(out.launch.map((l) => l.id), ['a'])
  assert.deepEqual(out.stops, [{ id: 'mine', status: 'parked', reason: 'needs_design', said: '' }])
  const now = readTree(r, E).status.get('mine')
  assert.equal(now.status, 'parked')
  assert.equal(now.last.return, 'needs_design')
})

test('schedule parks every childless folder the user writes in one call, past the pool', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] })])
  const n = Math.max(5, maxParallel(r) + 1)
  const mine = Array.from({ length: n }, (_, i) => 'mine' + i)
  const seeded = seedTree(r, E, mine.map((id) => ({ id, kind: 'design', title: 'part ' + id, author: 'you' })))
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems))
  envelopeFor(r)
  const out = await schedule(ctxOf(r), {})
  assert.equal(out.ok, true)
  assert.deepEqual(out.stops.map((s) => s.id).sort(), [...mine].sort())
  assert.ok(out.stops.every((s) => s.status === 'parked' && s.reason === 'needs_design'))
  assert.deepEqual(out.launch.map((l) => l.id), ['a'])
  const status = readTree(r, E).status
  assert.ok(mine.every((id) => status.get(id).status === 'parked'))
})

test('a childless folder the planner writes is launched to plan', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] }), { id: 'later', kind: 'design', title: 'later part', author: 'planner' }])
  envelopeFor(r)
  const out = await schedule(ctxOf(r), {})
  assert.equal(out.ok, true)
  assert.ok(out.launch.some((l) => l.unit === 'plan' && l.id === 'later'))
  assert.deepEqual(out.stops, [])
  assert.notEqual(readTree(r, E).status.get('later').status, 'parked')
})

/** A leaf `a` measured green at its head with no approval: the world the ladder sends to merge. */
function ladderWorld(t, extra = {}) {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'], ...extra })])
  envelopeFor(r)
  const xc = ctxOf(r)
  return { r, xc, sha: greenLeaf(r, xc, 'a', 'src/a.mjs') }
}

test('schedule approves a ladder-green leaf with no review loop of its own at the head that measured green, and merges it', async (t) => {
  const { r, xc, sha } = ladderWorld(t)
  const out = await schedule(xc, {})
  assert.equal(out.ok, true)
  const approvals = eventsOf(r, 'approved').filter((e) => e.node === 'a')
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].head_sha, sha)
  assert.equal(approvals[0].review_rounds, 0)
  assert.equal(approvals[0].at_integration, true)
  assert.ok(!out.launch.some((l) => l.unit === 'leaf' && l.id === 'a'), 'an approved leaf is not launched as a leaf')
  const merge = out.launch.find((l) => l.unit === 'merge')
  assert.deepEqual(merge.children, [{ id: 'a', head_sha: sha }])
  assert.deepEqual(out.stops, [], 'an approval is no stop')
  assert.equal(out.idle, false)
})

test('a ladder-green leaf with a review loop of its own is launched, not approved', async (t) => {
  const { r, xc } = ladderWorld(t, { provides: [{ name: 'api', paths: ['src/a.mjs'] }] })
  const out = await schedule(xc, {})
  assert.equal(out.ok, true)
  assert.ok(out.launch.some((l) => l.unit === 'leaf' && l.id === 'a'))
  assert.equal(eventsOf(r, 'approved').length, 0)
})

test('a ladder-green leaf whose approval stands is not approved again', async (t) => {
  const { r, xc, sha } = ladderWorld(t)
  xc.log.append('approved', { node: 'a', head_sha: sha, review_rounds: 0, at_integration: true })
  const out = await schedule(xc, {})
  assert.equal(out.ok, true)
  assert.equal(eventsOf(r, 'approved').filter((e) => e.node === 'a').length, 1)
  assert.deepEqual(out.launch.find((l) => l.unit === 'merge').children, [{ id: 'a', head_sha: sha }])
})

test('schedule run twice records nothing twice', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] }), { id: 'mine', kind: 'design', title: 'my part', author: 'you' }])
  envelopeFor(r)
  const xc = ctxOf(r)
  const sha = greenLeaf(r, xc, 'a', 'src/a.mjs')
  const lines = () => [readLog(r, E, 'events').entries.length, stateOf(r).length, journalOf(r).length]
  const before = lines()
  const first = await schedule(xc, {})
  const after = lines()
  assert.ok(after[0] >= before[0] + 2, 'the park and the approval were recorded')
  assert.deepEqual(first.stops.map((s) => s.id), ['mine'])
  assert.equal(eventsOf(r, 'approved')[0].head_sha, sha)

  const again = await schedule(executionContext({ repo: r, effort: E, execution: STAMP, log: executionLog(r, E, STAMP) }), {})
  assert.equal(again.ok, true)
  assert.deepEqual(lines(), after, 'a second schedule over the same disk appends no event')
})

// ------------------------------------------------------------------ postflight

test('postflight appends closed {status: done} once every leaf in scope merged', async (t) => {
  const r = world(t, NO_GAPS)
  envelopeFor(r)
  const xc = ctxOf(r)
  xc.log.append('merged', { node: 'a' })
  const partial = await postflight(xc)
  assert.equal(partial.ok, true)
  assert.equal(partial.closed, false)
  assert.equal(stateKind(r, 'closed').length, 0)

  xc.log.append('merged', { node: 'b' })
  const done = await postflight(xc)
  assert.equal(done.closed, true)
  assert.equal(done.summary.done, true)
  const closed = stateKind(r, 'closed')
  assert.equal(closed.length, 1)
  assert.equal(closed[0].status, 'done')
})

test('postflight run twice appends closed once', async (t) => {
  const r = world(t, NO_GAPS)
  envelopeFor(r)
  const xc = ctxOf(r)
  xc.log.append('merged', { node: 'a' })
  xc.log.append('merged', { node: 'b' })
  assert.equal((await postflight(xc)).closed, true)
  assert.equal((await postflight(xc)).closed, true)
  const fresh = await postflight(executionContext({ repo: r, effort: E, execution: STAMP, log: executionLog(r, E, STAMP) }))
  assert.equal(fresh.closed, true)
  assert.equal(stateKind(r, 'closed').length, 1)
})

test('below the effort root, postflight closes only once the root folder merged too', async (t) => {
  const r = world(t, [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { locus: ['src/a.mjs'] })])
  envelopeFor(r, STAMP, 'c')
  const xc = ctxOf(r)
  xc.log.append('merged', { node: 'c/a' })
  assert.equal((await postflight(xc)).closed, false)
  assert.equal(stateKind(r, 'closed').length, 0)
  xc.log.append('merged', { node: 'c' })
  assert.equal((await postflight(xc)).closed, true)
  assert.equal(stateKind(r, 'closed').length, 1)
})

test("postflight frees this execution's slots", async (t) => {
  const r = world(t, NO_GAPS)
  envelopeFor(r)
  assert.equal(acquire(r, { effort: E, execution: STAMP, node: 'a', locus: [ADD] }).ok, true)
  assert.equal(acquire(r, { effort: E, execution: STAMP2, node: 'b', locus: ['README.md'] }).ok, true)
  const out = await postflight(ctxOf(r))
  assert.equal(out.ok, true)
  assert.deepEqual(heldBy(r).slots.map((s) => [s.execution, s.node]), [[STAMP2, 'b']])
})

test("postflight names the root's integration branch and head, and counts merged and unmerged branches", async (t) => {
  const r = world(t, NO_GAPS)
  envelopeFor(r)
  const xc = ctxOf(r)
  const bare = await postflight(xc)
  assert.deepEqual({ branch: bare.integration.branch, head_sha: bare.integration.head_sha }, { branch: '', head_sha: '' }, 'no integration branch yet')
  assert.equal(bare.cleanup_n, 0)
  assert.equal(bare.unmerged_n, 0)

  git(r, 'worktree', 'add', '-q', '-b', branchOf(E, '.'), worktreeOf(r, E, '.'), 'HEAD')
  const rootHead = commitIn(worktreeOf(r, E, '.'), { 'docs/integrated.md': 'merged work\n' }, 'Integrate')
  git(r, 'branch', branchOf(E, 'a'), 'HEAD')
  git(r, 'branch', branchOf(E, 'b'), 'HEAD')
  xc.log.append('merged', { node: 'a' })
  const out = await postflight(xc)
  assert.equal(out.integration.branch, branchOf(E, '.'))
  assert.equal(out.integration.head_sha, rootHead)
  assert.notEqual(rootHead, head(r))
  assert.equal(out.cleanup_n, 1)
  assert.equal(out.unmerged_n, 1)
  assert.deepEqual(out.stops, [])
})

test('postflight summarizes the subtree: the stopped nodes and the leaves waiting behind each', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'], deps: ['a'] })])
  envelopeFor(r)
  const xc = ctxOf(r)
  xc.log.append('escalated', { node: 'a', reason: 'blocked', detail: '' })
  const out = await postflight(xc)
  assert.equal(out.ok, true)
  assert.deepEqual(out.summary.stopped, [{ id: 'a', status: 'escalated', reason: 'blocked' }])
  assert.deepEqual(out.summary.blocked, [{ blocked_by: 'a', leaves_n: 1 }])
  assert.equal(out.summary.leaves_n, 2)
  assert.equal(out.closed, false)
})
