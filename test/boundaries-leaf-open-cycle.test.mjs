// test/boundaries-leaf-open-cycle.test.mjs — pins leaf-open in-process: the round of a red-green
// cycle: a green's round goes to the red's session after needs_tests or test findings, to the
// implementer after a measured test round recorded tests_ready, and to the red's session for an
// audit.
//
// The setup the parts share is in test/harness/leaf-open-world.mjs.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#rigor and docs/DESIGN.md#the-locus.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { leafOpen } from '../lib/boundaries/leaf-open.mjs'
import { closePath, worktreeOf } from '../lib/store.mjs'
import { STAMP, commitIn, leaf } from './harness/boundary-fixture.mjs'
import { E, globRule, ran, closed, reviewed, cycle, askedForTests } from './harness/leaf-open-world.mjs'

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
