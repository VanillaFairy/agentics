// test/measure-retry.test.mjs — `retry` measures again: `measure` never reuses a node's
// verify-observed line older than the node's latest `replanned {reason: retry_escalated}` event,
// for a leaf's check and for a folder's suite gate alike.
//
// The record a retry appends is what `lib/boundary.mjs retry` appends (pinned by
// test/boundary-session-calls.test.mjs); here it is appended through the ledger. An environment the
// user fixed is an environment variable the check reads: the key does not hold it.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#the-suite-gate, docs/DESIGN.md#session-calls.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { append, readLog } from '../lib/ledger.mjs'
import { measure } from '../lib/measure.mjs'
import { suiteGate } from '../lib/boundaries/merge.mjs'
import { commitIn, root } from './harness/boundary-fixture.mjs'
import { BRANCH, EFFORT, EXECUTION, NODE, options, order } from './harness/verify-fixture.mjs'
import { E as LE, SLOW, world as leafWorld, open, close, observed, lf, crit } from './harness/leaf-close-world.mjs'
import {
  world as mergeWorld, inTest, integrationOf, journalOf, kindOf, SPLIT, BREAK_BIG, addBigTest, addOne,
} from './harness/merge-world.mjs'

/** A check that passes once the user has fixed the environment: `name` set to 1. */
const check = (name) => `node -e 'process.exit(process.env.${name} === "1" ? 0 : 1)'`

/** The user fixes the environment. */
function fix(t, name) {
  process.env[name] = '1'
  t.after(() => { delete process.env[name] })
}

/** What `lib/boundary.mjs retry --node <node>` appends. */
function retry(repo, effort, node, execution = '') {
  const r = append(repo, effort, 'events', [{ kind: 'replanned', node, execution, reason: 'retry_escalated', by: 'session' }])
  assert.equal(r.ok, true, JSON.stringify(r.error))
}

/** A linked worktree carrying the widget order, the execution measuring in it, and a `verify` leaf's options running `checks`. */
function rig(t, checks) {
  const { dir, worktree, base, head } = order(t)
  const xc = { repo: dir, effort: EFFORT, execution: EXECUTION }
  const opts = { ...options({ worktree, base, head }), rigor: 'verify', node: NODE, branch: BRANCH, checks }
  return { dir, xc, opts }
}

const lines = (dir, node = NODE) => readLog(dir, EFFORT, 'journal:' + EXECUTION).entries
  .filter((e) => e.kind === 'verify-observed' && e.node === node)
const passed = (payload) => payload.checks.every((c) => c.status === 'passed')

// ------------------------------------------------------------------ measure

test('a failing measurement is reused while the node has no retry', SLOW, async (t) => {
  const { dir, xc, opts } = rig(t, [check('AGENTICS_T16_NONE')])
  const first = await measure(xc, opts)
  assert.equal(first.payload.stop_reason, 'completed', JSON.stringify(first.payload.error))
  assert.equal(passed(first.payload), false)
  const again = await measure(xc, opts)
  assert.equal(again.reused, true)
  assert.equal(lines(dir).length, 1)
})

test('retry on the node makes its next check measure again', SLOW, async (t) => {
  const { dir, xc, opts } = rig(t, [check('AGENTICS_T16_AGAIN')])
  await measure(xc, opts)
  retry(dir, EFFORT, NODE, EXECUTION)
  const again = await measure(xc, opts)
  assert.equal(again.reused, false)
  assert.equal(lines(dir).length, 2)
})

test('a check measured after the retry is reused again', SLOW, async (t) => {
  const { dir, xc, opts } = rig(t, [check('AGENTICS_T16_AFTER')])
  await measure(xc, opts)
  retry(dir, EFFORT, NODE, EXECUTION)
  assert.equal((await measure(xc, opts)).reused, false)
  assert.equal((await measure(xc, opts)).reused, true)
  assert.equal(lines(dir).length, 2)
})

test('a retry recorded before the measurement leaves it reused', SLOW, async (t) => {
  const { dir, xc, opts } = rig(t, [check('AGENTICS_T16_BEFORE')])
  retry(dir, EFFORT, NODE, EXECUTION)
  await measure(xc, opts)
  assert.equal((await measure(xc, opts)).reused, true)
  assert.equal(lines(dir).length, 1)
})

test('a retry of another node leaves the measurement reused', SLOW, async (t) => {
  const { dir, xc, opts } = rig(t, [check('AGENTICS_T16_OTHER')])
  await measure(xc, opts)
  retry(dir, EFFORT, 'another-node', EXECUTION)
  assert.equal((await measure(xc, opts)).reused, true)
  assert.equal(lines(dir).length, 1)
})

test('the fixed environment passes once the user retries the node', SLOW, async (t) => {
  const name = 'AGENTICS_T16_FIXED'
  const { xc, opts } = rig(t, [check(name)])
  assert.equal(passed((await measure(xc, opts)).payload), false)
  fix(t, name)
  const unretried = await measure(xc, opts)
  assert.equal(unretried.reused, true, 'the fix alone changes no key')
  assert.equal(passed(unretried.payload), false)
  retry(xc.repo, EFFORT, NODE, EXECUTION)
  const retried = await measure(xc, opts)
  assert.equal(retried.reused, false)
  assert.equal(passed(retried.payload), true, JSON.stringify(retried.payload.checks))
})

// ------------------------------------------------------------------ a leaf's close

/** A verify leaf `v` whose one check passes once `name` is set, opened, and a close of it. */
function verifyLeaf(t, name) {
  const w = leafWorld(t, [root(), lf('v', { rigor: 'verify', locus: [], acceptance: crit('v', check(name)) })])
  const o = open(w, 'v')
  return { w, again: () => close(w, { node: 'v', role: '', round: 1, thread: '', dispatch: '', base_sha: o.base_sha }) }
}

test("a verify leaf whose environment the user fixed fails again without a retry", SLOW, async (t) => {
  const name = 'AGENTICS_T16_LEAF_UNRETRIED'
  const { w, again } = verifyLeaf(t, name)
  assert.equal((await again()).decision.next, 'stop')
  fix(t, name)
  const second = await again()
  assert.equal(second.decision.next, 'stop', JSON.stringify(second.decision))
  assert.equal(observed(w, 'v').length, 1)
})

test('a verify leaf whose environment the user fixed passes once the user retries it', SLOW, async (t) => {
  const name = 'AGENTICS_T16_LEAF_RETRIED'
  const { w, again } = verifyLeaf(t, name)
  assert.equal((await again()).decision.next, 'stop')
  fix(t, name)
  retry(w.r, LE, 'v', w.stamp)
  const second = await again()
  assert.notEqual(second.decision.next, 'stop', JSON.stringify(second.decision))
  const seen = observed(w, 'v')
  assert.equal(seen.length, 2)
  assert.ok(passed(seen[1]), JSON.stringify(seen[1].checks))
})

// ------------------------------------------------------------------ a folder's suite gate

/** A split suite whose integration head breaks only the big test. */
function brokenGate(t) {
  const w = mergeWorld(inTest(t), [root(), addOne('a')], { commands: SPLIT, prepare: addBigTest })
  commitIn(integrationOf(w).worktree, { 'src/add.mjs': BREAK_BIG }, 'Break only the big test')
  return w
}
const gateLines = (w) => kindOf(journalOf(w.r), 'verify-observed', '.')
/** A gate runs the full suite: the merge tests' timeout. */
const GATE = { timeout: 300_000 }

test('a failing gate asked again without a retry reuses its measurement', GATE, async (t) => {
  const w = brokenGate(t)
  assert.equal((await suiteGate(w.xc, { target: '.' })).passed, false)
  assert.equal((await suiteGate(w.xc, { target: '.' })).passed, false)
  assert.equal(gateLines(w).length, 1)
})

test('retry on a folder measures its gate again', GATE, async (t) => {
  const w = brokenGate(t)
  assert.equal((await suiteGate(w.xc, { target: '.' })).passed, false)
  retry(w.r, LE, '.', w.xc.execution)
  const again = await suiteGate(w.xc, { target: '.' })
  assert.equal(again.ran, true)
  assert.equal(gateLines(w).length, 2)
})
