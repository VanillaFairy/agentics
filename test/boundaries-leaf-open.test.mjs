// test/boundaries-leaf-open.test.mjs — pins leaf-open in-process: the slot and locus locks, the
// integration branch and the leaf cut under their branch locks, and what a round's dispatch takes
// from the records — its round, role, thread, owner, tier, permissions, working folder and thread
// brief — with the refusals it records and the waits it answers.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#rigor and docs/DESIGN.md#the-locus.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { leafOpen } from '../lib/boundaries/leaf-open.mjs'
import { executionContext } from '../lib/boundaries/records.mjs'
import { leafBrief } from '../lib/brief.mjs'
import { deliveryPlan, renderMessage } from '../lib/conversation.mjs'
import { commandsOf, writeGotcha } from '../lib/gotchas.mjs'
import { append, executionLog, readLog } from '../lib/ledger.mjs'
import { acquire, withBranchLockAsync } from '../lib/locks.mjs'
import { TEST_GLOBS, permissionsFor } from '../lib/locus.mjs'
import { loadRole, producerTier, raiseTier, roleCommands } from '../lib/roles.mjs'
import { branchOf, closePath, configPath, dispatchKey, effortStateDir, returnPath, reviewPath, worktreeOf, writeWhole } from '../lib/store.mjs'
import { addNodes, readTree } from '../lib/tree.mjs'
import { COMMANDS, STAMP, commitIn, git, leaf, repo, root } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const RED = "import { test } from 'node:test'\ntest('r', () => {})\n"
const editWrite = (target) => [`Edit(${target})`, `Write(${target})`]
const globRule = (rule) => TEST_GLOBS.some((g) => rule.endsWith(`${g})`))

/** A repository with `nodes` under the root, compiled, and an execution whose envelope stands. */
function setup(t, nodes, envelope = {}) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  const seeded = seedTree(r, E, [root(), ...nodes])
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems))
  const xc = executionContext({ repo: r, effort: E, execution: STAMP, log: executionLog(r, E, STAMP) })
  mkdirSync(xc.dir, { recursive: true })
  writeFileSync(join(xc.dir, 'execution.json'), JSON.stringify({
    stamp: STAMP, root: '.', base_branch: 'main', base_sha: git(r, 'rev-parse', 'HEAD'), dial: 'normal', pace: 'balanced',
    commands: COMMANDS, ...envelope,
  }))
  return { r, xc }
}

/** A round the runner dispatched: its `dispatched` event and, given `ret`, its stored return and `returned`. */
function ran(xc, { node, round, role, thread, model = 'opus', effort = 'medium', ret = null, log = xc.log }) {
  const dispatch = dispatchKey({ node, role, thread, round })
  log.append('dispatched', { dispatch, node, round, thread, role, model, effort, session: 's-' + dispatch, brief_digest: 'd', brief_parts: {}, carries: [], pid: 0 })
  if (ret) {
    writeWhole(returnPath(xc.dir, dispatch), ret)
    log.append('returned', { dispatch, session: 's-' + dispatch, status: 'returned', cause: '', usage: null, cost_total: null, cost_usd: null, denials: [] })
  }
  return dispatch
}

/** A close record where leaf-close writes it. */
const closed = (xc, { node, role, round, ...fields }) =>
  writeWhole(closePath(xc.repo, E, STAMP, node, role, round), { node, role, round, raise: false, measurement: null, decision: { next: 'fix', reason: '', failures: [] }, ...fields })

/** A review record where leaf-review writes it. */
const reviewed = (xc, { node, round, review_round, ...fields }) =>
  writeWhole(reviewPath(xc.repo, E, STAMP, node, review_round), { node, round, review_round, next: 'fix', open: [], raise: false, ...fields })

/** The suite command an investigator established, as `commandsOf` reads it. */
const established = (r, value) => writeGotcha(r, E, {
  kind: 'command', roles: ['implementer', 'investigator'], paths: [], trigger: 'running suite', action: 'use it',
  evidence: { command: 'suite', output: 'ok' }, command: { name: 'suite', value, absent: false },
}, { source: { role: 'investigator' } })

const nodeOf = (r, id) => readTree(r, E).nodes.get(id)
const roleOf = (name) => loadRole(name).role

/** A red approved at its head and its green opened at round 1: the ground of the cycle's test session. */
async function cycle(t, rigor = 'tdd-pair', extra = []) {
  const { r, xc } = setup(t, [
    leaf('r', { rigor, role: 'red', locus: ['test/r.test.mjs'] }),
    leaf('g', { rigor, role: 'green', deps: ['r'], locus: ['src/r.mjs'] }),
    ...extra,
  ])
  const red = await leafOpen(xc, { node: 'r' })
  const redHead = commitIn(red.cwd, { 'test/r.test.mjs': RED }, 'Pin r')
  ran(xc, { node: 'r', round: 1, role: 'test-author', thread: 'producer:r', ret: { status: 'done' } })
  xc.log.append('approved', { node: 'r', head_sha: redHead, review_rounds: 1, at_integration: false })
  const green = await leafOpen(xc, { node: 'g' })
  return { r, xc, green, redHead }
}

/** The green's implementer returned `needs_tests` at `round` and was closed so: leaf-close records the request at `round + 1`. */
function askedForTests(xc, round = 1) {
  ran(xc, { node: 'g', round, role: 'implementer', thread: 'producer:g', ret: { status: 'needs_tests' } })
  closed(xc, { node: 'g', role: 'implementer', round })
  xc.log.append('message', { node: 'g', thread: 'producer:r', from: 'implementer', msg: 'needs_tests', payload: { text: 'nothing pins the empty case' }, round: round + 1 })
}

/** What the session's `retry` and `note` append for `node`: a `replanned {reason: 'retry_escalated'}` or a `noted` event under this execution. */
const retry = (r, node) => assert.equal(append(r, E, 'events', [{ kind: 'replanned', node, execution: STAMP, reason: 'retry_escalated', by: 'session' }]).ok, true)
const note = (r, node, text) => assert.equal(append(r, E, 'events', [{ kind: 'noted', node, execution: STAMP, by: 'session', text }]).ok, true)

/** Every `retried` message on disk, oldest first. */
const retriedOf = (r) => readLog(r, E, 'events').entries.filter((e) => e.kind === 'message' && e.msg === 'retried')

/** Leaf `a`'s round 1 returned `blocked` and escalated so, in this execution. */
async function blocked(t) {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  const said = ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', ret: { status: 'blocked', text: 'no fixture' } })
  xc.log.append('escalated', { node: 'a', reason: 'blocked', detail: '', said })
  return { r, xc }
}

// ------------------------------------------------------------------ the round, its role and thread

test('round 1 goes to the leaf\'s executor on its own thread, at its producer tier, in its own worktree', async (t) => {
  const { r, xc } = setup(t, [
    leaf('a', { locus: ['src/a.mjs'] }),
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] }),
  ])
  const a = await leafOpen(xc, { node: 'a' })
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
  await leafOpen(xc, { node: 'a' })
  assert.deepEqual(readLog(r, E, 'events').entries.filter((e) => e.kind === 'dispatched'), [])
  assert.equal(readTree(r, E).status.get('a').status, 'planned')
})

test('a started, unreturned dispatch\'s round is opened again with its role, thread and tier', async (t) => {
  const { xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  const dispatch = ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', model: 'sonnet', effort: 'high' })
  const again = await leafOpen(xc, { node: 'a' })
  assert.deepEqual([again.round, again.role, again.thread], [1, 'implementer', 'producer:a'])
  assert.deepEqual(again.tier, { model: 'sonnet', effort: 'high' }, 'the session resumes at its own tier')

  writeWhole(returnPath(xc.dir, dispatch), { status: 'done' })
  xc.log.append('returned', { dispatch, session: 's', status: 'returned', cause: '', usage: null, cost_total: null, cost_usd: null, denials: [] })
  assert.equal((await leafOpen(xc, { node: 'a' })).round, 2, 'once it returned, the next round opens')
})

test('a dispatch whose call failed is still open: its round is opened again', async (t) => {
  const { xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  const dispatch = ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a' })
  xc.log.append('returned', { dispatch, session: 's', status: 'failed', cause: 'host_error', usage: null, cost_total: null, cost_usd: null, denials: [] })
  assert.equal((await leafOpen(xc, { node: 'a' })).round, 1)
})

test('a dispatch another execution started is not resumed here: the round after it opens', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', log: executionLog(r, E, '20260924-120000') })
  assert.equal((await leafOpen(xc, { node: 'a' })).round, 2)
})

test('a reviewer\'s dispatch is no round of the leaf', async (t) => {
  const { xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', ret: { status: 'done' } })
  ran(xc, { node: 'a', round: 1, role: 'reviewer', thread: 'reviewer:a:1' })
  const out = await leafOpen(xc, { node: 'a' })
  assert.deepEqual([out.round, out.role, out.thread], [2, 'implementer', 'producer:a'])
})

test('a green\'s round after its implementer returned needs_tests goes to the red\'s session', async (t) => {
  const { xc } = await cycle(t)
  askedForTests(xc)
  const out = await leafOpen(xc, { node: 'g' })
  assert.deepEqual([out.round, out.role, out.thread, out.owner], [2, 'test-author', 'producer:r', 'r'])
  rmSync(closePath(xc.repo, E, STAMP, 'g', 'implementer', 1))
  assert.equal((await leafOpen(xc, { node: 'g' })).role, 'test-author', 'the stored return says it, with no close on disk')
  closed(xc, { node: 'g', role: 'implementer', round: 1, measurement: { stop_reason: 'completed' } })
  assert.equal((await leafOpen(xc, { node: 'g' })).role, 'test-author', 'a measured implementer round is no test round answering the request')
})

test('a green\'s round after a review that left only test findings goes to the red\'s session', async (t) => {
  const { xc } = await cycle(t)
  ran(xc, { node: 'g', round: 1, role: 'implementer', thread: 'producer:g', ret: { status: 'done' } })
  closed(xc, { node: 'g', role: 'implementer', round: 1, decision: { next: 'review', reason: '', failures: [] } })
  const gap = { id: 'T1', severity: 'critical', claim: 'no test pins it', evidence: 'src/r.mjs:1', failure_scenario: 'x', remedy: 'tests' }
  reviewed(xc, { node: 'g', round: 1, review_round: 1, open: [gap] })
  const out = await leafOpen(xc, { node: 'g' })
  assert.deepEqual([out.role, out.thread, out.owner], ['test-author', 'producer:r', 'r'])
  reviewed(xc, { node: 'g', round: 1, review_round: 2, open: [{ ...gap, id: 'F1', remedy: 'code' }] })
  assert.equal((await leafOpen(xc, { node: 'g' })).role, 'implementer', 'the latest review of the round decides')
  reviewed(xc, { node: 'g', round: 2, review_round: 3, open: [{ ...gap, id: 'T2' }] })
  assert.equal((await leafOpen(xc, { node: 'g' })).role, 'implementer', 'a review of another round decides nothing')
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
  const out = await leafOpen(xc, { node: 'g' })
  assert.deepEqual([out.round, out.role, out.thread, out.owner, out.fresh], [1, 'implementer', 'producer:g', 'g', ''])
})

/** leaf-close's answer to the implementer's request: the close that measured the test round records `tests_ready` at the round after it. */
const testsReady = (xc, round, node = 'g') =>
  xc.log.append('message', { node, thread: 'producer:' + node, from: 'code', msg: 'tests_ready', payload: { files: ['test/r.test.mjs'] }, round })

test('a green\'s round after a measured test round that recorded tests_ready goes to the implementer', async (t) => {
  const { xc } = await cycle(t)
  askedForTests(xc)
  ran(xc, { node: 'g', round: 2, role: 'test-author', thread: 'producer:r', ret: { status: 'done' } })
  closed(xc, { node: 'g', role: 'test-author', round: 2, measurement: { stop_reason: 'completed' }, decision: { next: 'review', reason: '', failures: [] } })
  testsReady(xc, 3)
  const out = await leafOpen(xc, { node: 'g' })
  assert.deepEqual([out.round, out.role, out.thread, out.owner], [3, 'implementer', 'producer:g', 'g'])
})

test('a test round that failed only on its own mutations records no tests_ready: the red\'s session keeps the green', async (t) => {
  const { xc } = await cycle(t)
  askedForTests(xc)
  ran(xc, { node: 'g', round: 2, role: 'test-author', thread: 'producer:r', ret: { status: 'done' } })
  const own = { check: 'mutation', claim: 'the break survives', evidence: '' }
  closed(xc, { node: 'g', role: 'test-author', round: 2, measurement: { stop_reason: 'completed' }, decision: { next: 'fix', reason: '', failures: [own] } })
  const out = await leafOpen(xc, { node: 'g' })
  assert.deepEqual([out.round, out.role, out.thread, out.owner], [3, 'test-author', 'producer:r', 'r'])
})

test('a green\'s round after a test round that recorded tests_ready follows the review of that round', async (t) => {
  const { xc } = await cycle(t)
  askedForTests(xc)
  ran(xc, { node: 'g', round: 2, role: 'test-author', thread: 'producer:r', ret: { status: 'done' } })
  closed(xc, { node: 'g', role: 'test-author', round: 2, measurement: { stop_reason: 'completed' }, decision: { next: 'review', reason: '', failures: [] } })
  testsReady(xc, 3)
  const gap = { id: 'T1', severity: 'critical', claim: 'no test pins it', evidence: 'src/r.mjs:1', failure_scenario: 'x', remedy: 'tests' }
  reviewed(xc, { node: 'g', round: 2, review_round: 1, open: [gap] })
  assert.equal((await leafOpen(xc, { node: 'g' })).role, 'test-author', 'a review that left only test findings decides, whatever was recorded for the implementer')
  reviewed(xc, { node: 'g', round: 2, review_round: 2, open: [{ ...gap, id: 'F1', remedy: 'code' }] })
  assert.equal((await leafOpen(xc, { node: 'g' })).role, 'implementer')
})

test('a test round that answered no needs_tests, or was not measured, leaves the green\'s role to its close', async (t) => {
  const { xc } = await cycle(t)
  ran(xc, { node: 'g', round: 1, role: 'implementer', thread: 'producer:g', ret: { status: 'done' } })
  closed(xc, { node: 'g', role: 'implementer', round: 1 })
  ran(xc, { node: 'g', round: 2, role: 'test-author', thread: 'producer:r', ret: { status: 'done' } })
  const own = { check: 'mutation', claim: 'the break survives', evidence: '' }
  closed(xc, { node: 'g', role: 'test-author', round: 2, measurement: { stop_reason: 'completed' }, decision: { next: 'fix', reason: '', failures: [own] } })
  // A request of another node is no request of the green's.
  xc.log.append('message', { node: 'r', thread: 'producer:r', from: 'implementer', msg: 'needs_tests', payload: { text: 'x' }, round: 2 })
  assert.equal((await leafOpen(xc, { node: 'g' })).role, 'test-author', 'its own failures stay its own')

  askedForTests(xc, 3)
  ran(xc, { node: 'g', round: 4, role: 'test-author', thread: 'producer:r', ret: { status: 'done' } })
  closed(xc, { node: 'g', role: 'test-author', round: 4, measurement: null, decision: { next: 'fix', reason: '', failures: [own] } })
  assert.equal((await leafOpen(xc, { node: 'g' })).role, 'test-author', 'an unmeasured round answers nothing yet')
})

test('a measured implementer round is no test round answering a request, even while the request is open', async (t) => {
  const { xc } = await cycle(t)
  askedForTests(xc)
  ran(xc, { node: 'g', round: 2, role: 'test-author', thread: 'producer:r', ret: { status: 'done' } })
  closed(xc, { node: 'g', role: 'test-author', round: 2, measurement: null })
  ran(xc, { node: 'g', round: 3, role: 'implementer', thread: 'producer:g', ret: { status: 'done' } })
  closed(xc, { node: 'g', role: 'implementer', round: 3, measurement: { stop_reason: 'completed' }, decision: { next: 'review', reason: '', failures: [] } })
  const gap = { id: 'T1', severity: 'critical', claim: 'no test pins it', evidence: 'src/r.mjs:1', failure_scenario: 'x', remedy: 'tests' }
  reviewed(xc, { node: 'g', round: 3, review_round: 1, open: [gap] })
  assert.equal((await leafOpen(xc, { node: 'g' })).role, 'test-author')
})

test('an audit goes to the red\'s session once a measurement let an applied mutation through', async (t) => {
  const { r, xc } = await cycle(t, 'tdd-triad', [leaf('au', { rigor: 'tdd-triad', role: 'audit', deps: ['g'], locus: ['docs/audit.md'] })])
  const greenHead = commitIn(resolve(worktreeOf(r, E, 'g')), { 'src/r.mjs': 'export const r = (x) => x * 2\n' }, 'Implement r')
  ran(xc, { node: 'g', round: 1, role: 'implementer', thread: 'producer:g', ret: { status: 'done' } })
  xc.log.append('approved', { node: 'g', head_sha: greenHead, review_rounds: 1, at_integration: false })

  const first = await leafOpen(xc, { node: 'au' })
  assert.deepEqual([first.round, first.role, first.thread, first.owner], [1, 'auditor', 'auditor:au', 'au'])
  assert.deepEqual(first.permissions.allowed.filter(globRule), [], 'an auditor may write no test file')
  ran(xc, { node: 'au', round: 1, role: 'auditor', thread: 'auditor:au', ret: { status: 'done' } })
  const mutation = { file: 'src/r.mjs', find: 'x * 2', replace: 'x + 2', expect_failing: ['test/r.test.mjs'], applied: true }
  xc.log.append('verify-observed', { node: 'au', mutations: [{ ...mutation, bites: true }] })
  assert.equal((await leafOpen(xc, { node: 'au' })).role, 'auditor', 'every applied mutation bit')

  xc.log.append('verify-observed', { node: 'au', mutations: [{ ...mutation, bites: false }] })
  const gap = await leafOpen(xc, { node: 'au' })
  assert.deepEqual([gap.round, gap.role, gap.thread, gap.owner], [2, 'test-author', 'producer:r', 'r'])
})

test('a verify leaf opens its worktree with no role, thread or tier', async (t) => {
  const { xc } = setup(t, [leaf('v', { rigor: 'verify', locus: [] })])
  const out = await leafOpen(xc, { node: 'v' })
  assert.equal(out.status, 'opened')
  assert.deepEqual([out.role, out.thread, out.owner, out.fresh, out.tier, out.permissions], ['', '', 'v', '', null, null])
  assert.ok(existsSync(out.cwd))
})

test('a node that is no live leaf, or an execution with no envelope, is the caller\'s bug', async (t) => {
  const { xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await assert.rejects(leafOpen(xc, { node: 'nope' }), /no live leaf/)
  await assert.rejects(leafOpen(xc, { node: '.' }), /no live leaf/)
  rmSync(join(xc.dir, 'execution.json'))
  await assert.rejects(leafOpen(xc, { node: 'a' }), /no envelope/)
})

// ------------------------------------------------------------------ the raise

test('a raise on the previous round\'s close renews the thread on the raised tier', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', model: 'haiku', effort: 'low', ret: { status: 'done' } })
  closed(xc, { node: 'a', role: 'implementer', round: 1, raise: false })
  const plain = await leafOpen(xc, { node: 'a' })
  assert.equal(plain.fresh, '')
  assert.deepEqual(plain.tier, producerTier(nodeOf(r, 'a'), roleOf('implementer'), { intelligence: 'normal' }))

  closed(xc, { node: 'a', role: 'implementer', round: 1, raise: true })
  const raised = await leafOpen(xc, { node: 'a' })
  assert.equal(raised.fresh, 'raised')
  assert.deepEqual(raised.tier, raiseTier({ model: 'haiku', effort: 'low' }), 'one step above the thread\'s own tier')
})

test('a raise on the previous round\'s review renews the thread on the raised tier', async (t) => {
  const { xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'], provides: [{ name: 'A', paths: ['src/a.mjs'] }] })])
  await leafOpen(xc, { node: 'a' })
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', model: 'opus', effort: 'medium', ret: { status: 'done' } })
  closed(xc, { node: 'a', role: 'implementer', round: 1, decision: { next: 'review', reason: '', failures: [] } })
  reviewed(xc, { node: 'a', round: 1, review_round: 1, raise: true })
  const out = await leafOpen(xc, { node: 'a' })
  assert.deepEqual([out.fresh, out.tier], ['raised', raiseTier({ model: 'opus', effort: 'medium' })])
})

test('a raise on another thread\'s round renews nothing', async (t) => {
  const { r, xc } = await cycle(t)
  ran(xc, { node: 'g', round: 1, role: 'implementer', thread: 'producer:g', ret: { status: 'needs_tests' } })
  closed(xc, { node: 'g', role: 'implementer', round: 1, raise: true })
  const out = await leafOpen(xc, { node: 'g' })
  assert.deepEqual([out.thread, out.fresh], ['producer:r', ''])
  assert.deepEqual(out.tier, producerTier(nodeOf(r, 'r'), roleOf('test-author'), { intelligence: 'normal' }), 'the owner\'s producer tier')
})

// ------------------------------------------------------------------ a retried round

test('a round after a retry on a thread this execution dispatched records a retried message: the stop\'s reason and the notes since it', async (t) => {
  const { r, xc } = await blocked(t)
  note(r, 'a', 'the fixture is in test/fixtures now')
  retry(r, 'a')
  const out = await leafOpen(xc, { node: 'a' })
  assert.deepEqual([out.status, out.round, out.thread, out.fresh], ['opened', 2, 'producer:a', ''])
  const [m] = retriedOf(r)
  assert.deepEqual([m.node, m.thread, m.round, m.from, m.execution], ['a', 'producer:a', 2, 'code', STAMP])
  assert.deepEqual(m.payload, { reason: 'blocked', notes: ['the fixture is in test/fixtures now'] })
})

test('the retried round\'s prompt is the retried message, resumed on the thread', async (t) => {
  const { r, xc } = await blocked(t)
  retry(r, 'a')
  await leafOpen(xc, { node: 'a' })
  const [m] = retriedOf(r)
  assert.deepEqual(deliveryPlan(xc.log.entries(), 'producer:a'), { action: 'deliver', carries: [m.seq], prompt: renderMessage(m) })
})

test('a retried message is recorded once, however often its round is opened, a relaunch included', async (t) => {
  const { r, xc } = await blocked(t)
  retry(r, 'a')
  await leafOpen(xc, { node: 'a' })
  await leafOpen(xc, { node: 'a' })
  const relaunched = executionContext({ repo: r, effort: E, execution: STAMP, log: executionLog(r, E, STAMP) })
  assert.equal((await leafOpen(relaunched, { node: 'a' })).round, 2)
  const [m] = retriedOf(r)
  ran(xc, { node: 'a', round: 2, role: 'implementer', thread: 'producer:a', log: relaunched.log })
  assert.equal((await leafOpen(relaunched, { node: 'a' })).round, 2, 'the started round is reopened')
  assert.deepEqual(retriedOf(r).map((e) => e.seq), [m.seq])
})

test('a reopened round records no retried message: its call resumes as it was started', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', ret: { status: 'done' } })
  const dispatch = ran(xc, { node: 'a', round: 2, role: 'implementer', thread: 'producer:a' })
  xc.log.append('returned', { dispatch, session: 's', status: 'failed', cause: 'host_error', usage: null, cost_total: null, cost_usd: null, denials: [] })
  retry(r, 'a')
  assert.equal((await leafOpen(xc, { node: 'a' })).round, 2)
  assert.deepEqual(retriedOf(r), [])
})

test('a stop recorded after the retry is not the one the retry cleared', async (t) => {
  const { r, xc } = await blocked(t)
  retry(r, 'a')
  xc.log.append('escalated', { node: 'a', reason: 'fix_without_commits', detail: '' })
  await leafOpen(xc, { node: 'a' })
  assert.deepEqual(retriedOf(r).map((m) => m.payload.reason), ['blocked'])
})

test('a retry before any dispatch records no message: the first round\'s brief carries on', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  xc.log.append('escalated', { node: 'a', reason: 'open_refused', detail: 'a lock was stuck' })
  retry(r, 'a')
  const out = await leafOpen(xc, { node: 'a' })
  assert.deepEqual([out.status, out.round], ['opened', 1])
  assert.deepEqual(retriedOf(r), [])
})

test('a retry after a round another execution dispatched records no message: this execution\'s call is a fresh session', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  const other = executionLog(r, E, '20260924-120000')
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', ret: { status: 'blocked' }, log: other })
  other.append('escalated', { node: 'a', reason: 'blocked', detail: '' })
  retry(r, 'a')
  assert.equal((await leafOpen(xc, { node: 'a' })).round, 2)
  assert.deepEqual(retriedOf(r), [])
})

test('a note left before the stop, or on another node, is not quoted', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', ret: { status: 'blocked' } })
  note(r, 'a', 'before the stop')
  xc.log.append('escalated', { node: 'a', reason: 'blocked', detail: '' })
  note(r, 'a', 'after one')
  note(r, '.', 'on the root')
  note(r, 'a', 'after two')
  retry(r, 'a')
  await leafOpen(xc, { node: 'a' })
  assert.deepEqual(retriedOf(r).map((m) => m.payload.notes), [['after one', 'after two']])
})

test('a retry that cleared a park names the park\'s return as the reason', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  await leafOpen(xc, { node: 'a' })
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a', ret: { status: 'done' } })
  xc.log.append('parked', { node: 'a', return: 'contract_drift', question: '' })
  retry(r, 'a')
  await leafOpen(xc, { node: 'a' })
  assert.deepEqual(retriedOf(r).map((m) => m.payload), [{ reason: 'contract_drift', notes: [] }])
})

test('a second retry after the retried round returned is told again, with the notes since the second stop', async (t) => {
  const { r, xc } = await blocked(t)
  note(r, 'a', 'first')
  retry(r, 'a')
  await leafOpen(xc, { node: 'a' })
  const [first] = retriedOf(r)
  ran(xc, { node: 'a', round: 2, role: 'implementer', thread: 'producer:a', ret: { status: 'blocked' } })
  xc.log.append('escalated', { node: 'a', reason: 'fix_without_commits', detail: '' })
  retry(r, '.')
  assert.equal(append(r, E, 'events', [{ kind: 'replanned', node: 'a', execution: STAMP, reason: 'answered', by: 'session' }]).ok, true)
  await leafOpen(xc, { node: 'a' })
  assert.deepEqual(retriedOf(r).map((m) => m.seq), [first.seq], 'no retry of a since its round returned: nothing owed')
  note(r, 'a', 'second')
  retry(r, 'a')
  assert.equal((await leafOpen(xc, { node: 'a' })).round, 3)
  assert.deepEqual(retriedOf(r).map((m) => [m.round, m.payload]),
    [[2, first.payload], [3, { reason: 'fix_without_commits', notes: ['second'] }]])
})

test('a round with a failures message waiting delivers it with the retried message, oldest first', async (t) => {
  const { r, xc } = await blocked(t)
  const failure = { check: 'suite', claim: 'the merged head fails', evidence: 'test/a.test.mjs:3' }
  const { seq } = xc.log.append('message', { node: 'a', thread: 'producer:a', from: 'code', msg: 'failures', payload: { source: 'integration', failures: [failure] }, round: 2 })
  retry(r, 'a')
  await leafOpen(xc, { node: 'a' })
  const [m] = retriedOf(r)
  const failures = readLog(r, E, 'events').entries.find((e) => e.seq === seq)
  const plan = deliveryPlan(xc.log.entries(), 'producer:a')
  assert.deepEqual(plan.carries, [seq, m.seq])
  for (const text of [renderMessage(failures), renderMessage(m)]) assert.ok(plan.prompt.includes(text), text)
})

// ------------------------------------------------------------------ permissions

test('a round\'s permissions come from its leaf\'s locus, with its role\'s commands', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  established(r, 'node --test --test-reporter=spec')
  const { permissions } = await leafOpen(xc, { node: 'a' })
  const commands = roleCommands(roleOf('implementer'), commandsOf(r, E), nodeOf(r, 'a'))
  assert.ok(commands.includes('node --test --test-reporter=spec'), 'the established suite is the role\'s <test>')
  for (const c of commands) assert.ok(permissions.allowed.includes('Bash(' + c + ':*)'), c)
  for (const rule of editWrite('src/a.mjs')) assert.ok(permissions.allowed.includes(rule), rule)
  for (const g of TEST_GLOBS) for (const rule of editWrite('src/' + g)) assert.ok(permissions.allowed.includes(rule), rule)
  for (const rule of editWrite('test/add.test.mjs')) assert.ok(!permissions.allowed.includes(rule), 'no unlisted file: ' + rule)
})

test('paths another unmerged leaf holds are denied, and freed once it merged', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'] })])
  assert.equal(acquire(r, { effort: E, execution: STAMP, node: 'b', locus: ['src/b.mjs'], waitMs: 0 }).ok, true)
  const held = await leafOpen(xc, { node: 'a' })
  for (const rule of editWrite('src/b.mjs')) assert.ok(held.permissions.disallowed.includes(rule), rule)
  xc.log.append('merged', { node: 'b', merged_sha: git(r, 'rev-parse', 'main') })
  const freed = await leafOpen(xc, { node: 'a' })
  for (const rule of editWrite('src/b.mjs')) assert.ok(!freed.permissions.disallowed.includes(rule), rule)
})

test('a green\'s implementer may write no test file', async (t) => {
  const { green } = await cycle(t)
  assert.equal(green.role, 'implementer')
  assert.deepEqual(green.permissions.allowed.filter(globRule), [])
  for (const rule of editWrite('src/r.mjs')) assert.ok(green.permissions.allowed.includes(rule), rule)
  for (const rule of [...editWrite('src/r.mjs'), ...editWrite('test/r.test.mjs')]) assert.ok(!green.permissions.disallowed.includes(rule), 'neither the leaf\'s own locus nor its cycle\'s is held against it: ' + rule)
})

test('a test round writes the cycle\'s tests: the red\'s test files and new tests beside every member\'s locus', async (t) => {
  const { xc } = await cycle(t)
  askedForTests(xc)
  const { permissions } = await leafOpen(xc, { node: 'g' })
  for (const rule of editWrite('test/r.test.mjs')) assert.ok(permissions.allowed.includes(rule), rule)
  for (const folder of ['test', 'src']) {
    for (const g of TEST_GLOBS) for (const rule of editWrite(folder + '/' + g)) assert.ok(permissions.allowed.includes(rule), rule)
  }
  for (const rule of editWrite('src/r.mjs')) assert.ok(!permissions.allowed.includes(rule), 'never a source file: ' + rule)
  assert.deepEqual(permissions.allowed.filter((p) => p.startsWith('Bash')), [], 'a test author runs no command')
})

test('the cycle\'s test session may not read what the green\'s own commits changed outside the cycle\'s tests', async (t) => {
  const { xc, green } = await cycle(t)
  assert.deepEqual(green.permissions.disallowed.filter((p) => p.startsWith('Read(')), [], 'the implementer reads its own code')
  commitIn(green.cwd, { 'src/r.mjs': 'export const r = () => 1\n', 'src/r-help.mjs': 'export const h = 1\n' }, 'Implement r')
  commitIn(green.cwd, { 'test/r.test.mjs': RED + "test('more', () => {})\n" }, 'Pin more')
  askedForTests(xc)
  const { permissions } = await leafOpen(xc, { node: 'g' })
  const denied = permissionsFor({ locus: [], denyRead: ['src/r.mjs', 'src/r-help.mjs'] }).disallowed.filter((p) => p.startsWith('Read('))
  for (const rule of denied) assert.ok(permissions.disallowed.includes(rule), rule)
  const tests = permissionsFor({ locus: [], denyRead: ['test/r.test.mjs'] }).disallowed.filter((p) => p.startsWith('Read('))
  for (const rule of tests) assert.ok(!permissions.disallowed.includes(rule), 'the cycle\'s tests stay readable: ' + rule)
})

// ------------------------------------------------------------------ the brief and the worktree

test('the brief and its parts are the round\'s leaf brief over the established commands', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  established(r, 'node --test --test-reporter=spec')
  const out = await leafOpen(xc, { node: 'a' })
  const expected = leafBrief(r, E, 'a', { role: 'implementer', worktree: out.cwd, commands: commandsOf(r, E) })
  assert.equal(out.brief, expected.text)
  assert.deepEqual(out.brief_parts, expected.parts)
  assert.match(out.brief, /node --test --test-reporter=spec/)
})

test('the cycle\'s test session is briefed with the red\'s leaf brief on a green\'s round', async (t) => {
  const { r, xc } = await cycle(t)
  askedForTests(xc)
  const out = await leafOpen(xc, { node: 'g' })
  const commands = commandsOf(r, E)
  const red = leafBrief(r, E, 'r', { role: 'test-author', worktree: out.cwd, commands })
  assert.equal(out.brief, red.text)
  assert.deepEqual(out.brief_parts, red.parts)
  assert.notEqual(out.brief, leafBrief(r, E, 'g', { role: 'test-author', worktree: out.cwd, commands }).text, 'not the green\'s')
  assert.equal(out.cwd, resolve(worktreeOf(r, E, 'g')), 'it works in the green\'s worktree')
})

test('a green is cut from its red\'s head, and opened again names the same base', async (t) => {
  const { xc, green, redHead } = await cycle(t)
  assert.equal(green.base_sha, redHead)
  assert.equal(green.head_sha, redHead)
  assert.equal((await leafOpen(xc, { node: 'g' })).base_sha, green.base_sha)
})

test('a green is cut from its red and brought up to the parent\'s head, so its other dependencies are there', async (t) => {
  const { r, xc } = setup(t, [
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], locus: ['src/r.mjs'] }),
  ])
  const red = await leafOpen(xc, { node: 'r' })
  const redHead = commitIn(red.cwd, { 'test/r.test.mjs': RED }, 'Pin r')
  commitIn(resolve(worktreeOf(r, E, '.')), { 'src/l.mjs': 'export const l = 1\n' }, 'Merge l')
  const green = await leafOpen(xc, { node: 'g' })
  assert.ok(existsSync(join(green.cwd, 'src', 'l.mjs')), 'what merged into the parent is there')
  assert.ok(existsSync(join(green.cwd, 'test', 'r.test.mjs')), 'and the red\'s tests')
  assert.equal(green.salvaged, false, 'a refresh merge is no work of an earlier round')
  assert.equal(git(r, 'rev-parse', green.base_sha + '^1'), redHead, 'the base is the refresh merge on the red\'s head')
})

test('committed work on the branch no dispatch of this execution made is reported salvaged', async (t) => {
  const { xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  const first = await leafOpen(xc, { node: 'a' })
  assert.equal(first.salvaged, false, 'a new branch holds nothing')
  commitIn(first.cwd, { 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  assert.equal((await leafOpen(xc, { node: 'a' })).salvaged, true)
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a' })
  assert.equal((await leafOpen(xc, { node: 'a' })).salvaged, false, 'this execution\'s own round')
})

// ------------------------------------------------------------------ waits and refusals

test('a full pool answers no_slot, naming the holder', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'] })])
  mkdirSync(join(configPath(r), '..'), { recursive: true })
  writeFileSync(configPath(r), JSON.stringify({ max_parallel: 1 }))
  assert.equal(acquire(r, { effort: E, execution: STAMP, node: 'b', locus: ['src/b.mjs'], waitMs: 0 }).ok, true)
  const out = await leafOpen(xc, { node: 'a' })
  assert.equal(out.status, 'no_slot')
  assert.deepEqual(out.held_by.map((h) => h.node), ['b'])
})

test('a locus path another leaf holds answers locus_held, naming the holder', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/a.mjs'] })])
  assert.equal(acquire(r, { effort: E, execution: STAMP, node: 'b', locus: ['src/a.mjs'], waitMs: 0 }).ok, true)
  const out = await leafOpen(xc, { node: 'a' })
  assert.equal(out.status, 'locus_held')
  assert.deepEqual(out.held_by, [{ node: 'b', status: 'planned' }])
})

test('an invalid locus escalates open_refused, once', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  assert.equal(append(r, E, 'nodes', [{ kind: 'node', node: { ...nodeOf(r, 'a'), locus: ['../out.mjs'] } }]).ok, true)
  const out = await leafOpen(xc, { node: 'a' })
  assert.equal(out.status, 'stopped')
  assert.deepEqual(out.stops, [{ id: 'a', status: 'escalated', reason: 'open_refused', said: '' }])
  const again = await leafOpen(xc, { node: 'a' })
  assert.deepEqual(again.stops, out.stops)
  const refusals = readLog(r, E, 'events').entries.filter((e) => e.kind === 'escalated' && e.node === 'a')
  assert.deepEqual(refusals.map((e) => [e.reason, e.execution]), [['open_refused', STAMP]])
})

test('an integration branch that cannot be made escalates open_refused', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })], { base_sha: '' })
  const out = await leafOpen(xc, { node: 'a' })
  assert.deepEqual([out.status, out.stops.map((s) => s.reason)], ['stopped', ['open_refused']])
  assert.match(readLog(r, E, 'events').entries.find((e) => e.kind === 'escalated').detail, /no base commit/)
})

test('two leaf-opens at once under one fresh composite both open', async (t) => {
  const { xc } = setup(t, [{ id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] },
    leaf('c/p', { locus: ['src/p.mjs'] }), leaf('c/q', { locus: ['src/q.mjs'] })])
  const [p, q] = await Promise.all([leafOpen(xc, { node: 'c/p' }), leafOpen(xc, { node: 'c/q' })])
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
  const out = await leafOpen(xc, { node: 'a', sleep })
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
  const out = await leafOpen(xc, { node: 'a', sleep })
  release()
  await holding
  assert.deepEqual(out, { status: 'busy', held_by: [] })
})

test('a lock fault other than the timeout is thrown, never answered as busy', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  const locks = join(effortStateDir(r, E), 'locks')
  mkdirSync(locks, { recursive: true })
  writeFileSync(join(locks, 'branch'), 'a file where the branch locks go')
  await assert.rejects(leafOpen(xc, { node: 'a' }), (err) => !/could not take the lock/.test(err.message))
})

test('a composite in a group is cut from the group\'s folder: the group has no branch', async (t) => {
  const { r, xc } = setup(t, [{ id: 'x', kind: 'group', title: 'gather x' },
    { id: 'x/c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('x/c/a', { locus: ['src/a.mjs'] })])
  const out = await leafOpen(xc, { node: 'x/c/a' })
  assert.equal(out.status, 'opened')
  assert.equal(git(r, 'branch', '--list', branchOf(E, 'x')), '', 'no branch for the group')
  assert.notEqual(git(r, 'branch', '--list', branchOf(E, 'x/c')), '', 'the composite has its own')
  assert.equal(out.base_sha, git(r, 'rev-parse', branchOf(E, 'x/c')), 'the leaf is cut from the composite')
  assert.equal(git(r, 'rev-parse', branchOf(E, 'x/c')), git(r, 'rev-parse', 'main'), 'the composite is cut from the effort branch, the group passed over')
})

test('a leaf decomposed in place releases its claim: its children open', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { rigor: 'trivial', locus: ['src/a.mjs', 'src/b.mjs'] })])
  assert.equal((await leafOpen(xc, { node: 'a' })).status, 'opened')
  const split = addNodes(r, E, [
    { id: 'a', kind: 'composite', title: 'do a', decisions: ['D1'] },
    leaf('a/x', { rigor: 'trivial', locus: ['src/a.mjs'] }), leaf('a/y', { rigor: 'trivial', locus: ['src/b.mjs'] }),
  ], { by: 'planner', reason: 'decompose' })
  assert.equal(split.ok, true, JSON.stringify(split.problems))
  assert.equal((await leafOpen(xc, { node: 'a/x' })).status, 'opened')
})
