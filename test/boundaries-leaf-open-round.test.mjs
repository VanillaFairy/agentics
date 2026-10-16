// test/boundaries-leaf-open-round.test.mjs — pins leaf-open in-process: the round a dispatch opens
// (its role, thread and tier, and one that is no round of the leaf), the slot and locus locks, the
// integration branch and the leaf cut under their branch locks, and the refusals it records and the
// waits it answers.
//
// The setup the parts share is in test/harness/leaf-open-world.mjs.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#rigor and docs/DESIGN.md#the-locus.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { leafOpen } from '../lib/boundaries/leaf-open.mjs'
import { append, executionLog, readLog } from '../lib/ledger.mjs'
import { acquireAsync, withBranchLockAsync } from '../lib/locks.mjs'
import { producerTier } from '../lib/roles.mjs'
import {
  branchOf, closePath, configPath, effortStateDir, returnPath, reviewPath, worktreeOf, writeWhole,
} from '../lib/store.mjs'
import { addNodes, readTree } from '../lib/tree.mjs'
import { STAMP, git, leaf } from './harness/boundary-fixture.mjs'
import { E, setup, ran, nodeOf, roleOf, cycle } from './harness/leaf-open-world.mjs'

// ------------------------------------------------------------------ the round, its role and thread

test('round 1 goes to the leaf\'s executor on its own thread, at its producer tier, in its own worktree', async (t) => {
  const { r, xc } = setup(t, [
    leaf('a', { locus: ['src/a.mjs'] }),
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] }),
  ])
  const a = await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.equal(a.status, 'opened')
  assert.deepEqual([a.round, a.role, a.thread, a.owner, a.fresh], [1, 'implementer', 'producer:a', 'a', ''])
  assert.deepEqual(a.tier, producerTier(nodeOf(r, 'a'), roleOf('implementer'), { intelligence: 'normal' }))
  assert.equal(a.branch, branchOf(E, 'a'))
  assert.equal(a.base_sha, git(r, 'rev-parse', 'main'), 'cut from the effort branch, itself cut from the base')
  assert.equal(a.head_sha, a.base_sha)
  assert.ok(isAbsolute(a.cwd), a.cwd)
  assert.equal(a.cwd, resolve(worktreeOf(r, E, 'a')))
  assert.ok(existsSync(join(a.cwd, 'README.md')), 'the worktree is checked out there')

  const red = await leafOpen(xc, { node: 'r', intelligence: 'low' })
  assert.deepEqual([red.round, red.role, red.thread, red.owner], [1, 'test-author', 'producer:r', 'r'])
  assert.deepEqual(red.tier, producerTier(nodeOf(r, 'r'), roleOf('test-author'), { intelligence: 'low' }))
})

test('leaf-open records no dispatch: the runner records it', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.deepEqual(readLog(r, E, 'events').entries.filter((e) => e.kind === 'dispatched'), [])
  assert.equal(readTree(r, E).status.get('a').status, 'planned')
})

test('a started, unreturned dispatch\'s round is opened again with its role, thread and tier', async (t) => {
  const { xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  const dispatch = ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', model: 'sonnet', effort: 'high' })
  const again = await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.deepEqual([again.round, again.role, again.thread], [1, 'implementer', 'producer:a'])
  assert.deepEqual(again.tier, { model: 'sonnet', effort: 'high' }, 'the session resumes at its own tier')

  writeWhole(returnPath(xc.dir, dispatch), { status: 'done' })
  xc.log.append('returned', { dispatch, session: 's', status: 'returned', cause: '', usage: null, cost_total: null, cost_usd: null, denials: [] })
  assert.equal((await leafOpen(xc, { node: 'a', intelligence: 'normal' })).round, 2, 'once it returned, the next round opens')
})

test('a dispatch whose call failed is still open: its round is opened again', async (t) => {
  const { xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  const dispatch = ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a' })
  xc.log.append('returned', { dispatch, session: 's', status: 'failed', cause: 'host_error', usage: null, cost_total: null, cost_usd: null, denials: [] })
  assert.equal((await leafOpen(xc, { node: 'a', intelligence: 'normal' })).round, 1)
})

test('a dispatch another execution started is not resumed here: the round after it opens', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', log: executionLog(r, E, '20260924-120000') })
  assert.equal((await leafOpen(xc, { node: 'a', intelligence: 'normal' })).round, 2)
})

test('a reviewer\'s dispatch is no round of the leaf', async (t) => {
  const { xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', ret: { status: 'done' } })
  ran(xc, { node: 'a', round: 1, role: 'reviewer', thread: 'reviewer:a:1' })
  const out = await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.deepEqual([out.round, out.role, out.thread], [2, 'implementer', 'producer:a'])
})

test('a 4.x execution\'s dispatch is no round: the close and review records beside it are never read', async (t) => {
  const { xc } = await cycle(t)
  // What a 4.x execution left: a state with no `run` line, a `dispatched` with no thread and no
  // dispatch key, and a close and a review record that would send the green's round 2 to the red.
  const old = '20260901-120000'
  assert.equal(append(xc.repo, E, 'state:' + old, [{ kind: 'invocation' }]).ok, true)
  assert.equal(append(xc.repo, E, 'events', [{ kind: 'dispatched', execution: old, node: 'g', role: 'implementer', round: 1, model: 'opus', effort: 'medium' }]).ok, true)
  writeWhole(closePath(xc.repo, E, old, 'g', 'implementer', 1), { node: 'g', role: 'implementer', round: 1, raise: true, measurement: null, decision: { next: 'review', reason: '', failures: [] } })
  const gap = { id: 'T1', severity: 'critical', claim: 'no test pins it', evidence: 'src/r.mjs:1', failure_scenario: 'x', remedy: 'tests' }
  writeWhole(reviewPath(xc.repo, E, old, 'g', 1), { node: 'g', round: 1, review_round: 1, next: 'fix', open: [gap], raise: true })
  const out = await leafOpen(xc, { node: 'g', intelligence: 'normal' })
  assert.deepEqual([out.round, out.role, out.thread, out.owner, out.fresh], [1, 'implementer', 'producer:g', 'g', ''])
})

test('a verify leaf opens its worktree with no role, thread or tier', async (t) => {
  const { xc } = setup(t, [leaf('v', { rigor: 'verify', locus: [] })])
  const out = await leafOpen(xc, { node: 'v', intelligence: 'normal' })
  assert.equal(out.status, 'opened')
  assert.deepEqual([out.role, out.thread, out.owner, out.fresh, out.tier, out.permissions], ['', '', 'v', '', null, null])
  assert.ok(existsSync(out.cwd))
  await assert.rejects(leafOpen(xc, { node: '.', intelligence: 'normal' }), /no live leaf/, 'a folder is no leaf')
})

// ------------------------------------------------------------------ waits and refusals

test('a full pool answers no_slot, naming the holder', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'] })])
  mkdirSync(join(configPath(r), '..'), { recursive: true })
  writeFileSync(configPath(r), JSON.stringify({ max_parallel: 1 }))
  assert.equal((await acquireAsync(r, { effort: E, execution: STAMP, node: 'b', locus: ['src/b.mjs'], waitMs: 0 })).ok, true)
  const out = await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.equal(out.status, 'no_slot')
  assert.deepEqual(out.held_by.map((h) => h.node), ['b'])
})

test('a locus path another leaf holds answers locus_held, naming the holder', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/a.mjs'] })])
  assert.equal((await acquireAsync(r, { effort: E, execution: STAMP, node: 'b', locus: ['src/a.mjs'], waitMs: 0 })).ok, true)
  const out = await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.equal(out.status, 'locus_held')
  assert.deepEqual(out.held_by, [{ node: 'b', status: 'planned' }])
})

test('an invalid locus escalates open_refused, once', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  assert.equal(append(r, E, 'nodes', [{ kind: 'node', node: { ...nodeOf(r, 'a'), locus: ['../out.mjs'] } }]).ok, true)
  const out = await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.equal(out.status, 'stopped')
  assert.deepEqual(out.stops, [{ id: 'a', status: 'escalated', reason: 'open_refused', said: '' }])
  const again = await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.deepEqual(again.stops, out.stops)
  const refusals = readLog(r, E, 'events').entries.filter((e) => e.kind === 'escalated' && e.node === 'a')
  assert.deepEqual(refusals.map((e) => [e.reason, e.execution]), [['open_refused', STAMP]])
})

test('an integration branch that cannot be made escalates open_refused', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })], { base_sha: '' })
  const out = await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.deepEqual([out.status, out.stops.map((s) => s.reason)], ['stopped', ['open_refused']])
  assert.match(readLog(r, E, 'events').entries.find((e) => e.kind === 'escalated').detail, /no base commit/)
})

test('two leaf-opens at once under one fresh composite both open', async (t) => {
  const { xc } = setup(t, [{ id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] },
    leaf('c/p', { locus: ['src/p.mjs'] }), leaf('c/q', { locus: ['src/q.mjs'] })])
  const [p, q] = await Promise.all([leafOpen(xc, { node: 'c/p', intelligence: 'normal' }), leafOpen(xc, { node: 'c/q', intelligence: 'normal' })])
  assert.deepEqual([p.status, q.status], ['opened', 'opened'])
  assert.equal(p.base_sha, q.base_sha, 'both cut from the composite\'s one head')
})

test('a held integration branch is waited for through the given sleep, then the leaf opens', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  let release
  const gate = new Promise((done) => { release = done })
  const holding = withBranchLockAsync(r, E, branchOf(E, '.'), () => gate)
  let slept = 0
  const sleep = async () => {
    slept += 1
    if (slept === 3) release()
    await new Promise((done) => setImmediate(done))
  }
  const out = await leafOpen(xc, { node: 'a', sleep, intelligence: 'normal' })
  await holding
  assert.equal(out.status, 'opened')
  assert.ok(slept >= 3, 'it waited on the lock, ' + slept + ' sleeps')
})

test('a branch lock not taken in time answers busy, with no holder named', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  let release
  const gate = new Promise((done) => { release = done })
  const holding = withBranchLockAsync(r, E, branchOf(E, '.'), () => gate)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const sleep = async () => { now += 60 * 60 * 1000 }
  const out = await leafOpen(xc, { node: 'a', sleep, intelligence: 'normal' })
  release()
  await holding
  assert.deepEqual(out, { status: 'busy', held_by: [] })
})

test('a lock fault other than the timeout is thrown, never answered as busy', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  const locks = join(effortStateDir(r, E), 'locks')
  mkdirSync(locks, { recursive: true })
  writeFileSync(join(locks, 'branch'), 'a file where the branch locks go')
  await assert.rejects(leafOpen(xc, { node: 'a', intelligence: 'normal' }), (err) => !/could not take the lock/.test(err.message))
})

test('a composite in a group is cut from the group\'s folder: the group has no branch', async (t) => {
  const { r, xc } = setup(t, [{ id: 'x', kind: 'group', title: 'gather x' },
    { id: 'x/c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('x/c/a', { locus: ['src/a.mjs'] })])
  const out = await leafOpen(xc, { node: 'x/c/a', intelligence: 'normal' })
  assert.equal(out.status, 'opened')
  assert.equal(git(r, 'branch', '--list', branchOf(E, 'x')), '', 'no branch for the group')
  assert.notEqual(git(r, 'branch', '--list', branchOf(E, 'x/c')), '', 'the composite has its own')
  assert.equal(out.base_sha, git(r, 'rev-parse', branchOf(E, 'x/c')), 'the leaf is cut from the composite')
  assert.equal(git(r, 'rev-parse', branchOf(E, 'x/c')), git(r, 'rev-parse', 'main'), 'the composite is cut from the effort branch, the group passed over')
})

test('a leaf decomposed in place releases its claim: its children open', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { rigor: 'trivial', locus: ['src/a.mjs', 'src/b.mjs'] })])
  assert.equal((await leafOpen(xc, { node: 'a', intelligence: 'normal' })).status, 'opened')
  const split = addNodes(r, E, [
    { id: 'a', kind: 'composite', title: 'do a', decisions: ['D1'] },
    leaf('a/x', { rigor: 'trivial', locus: ['src/a.mjs'] }), leaf('a/y', { rigor: 'trivial', locus: ['src/b.mjs'] }),
  ], { by: 'planner', reason: 'decompose' })
  assert.equal(split.ok, true, JSON.stringify(split.problems))
  assert.equal((await leafOpen(xc, { node: 'a/x', intelligence: 'normal' })).status, 'opened')
})
