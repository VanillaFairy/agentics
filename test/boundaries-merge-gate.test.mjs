// test/boundaries-merge-gate.test.mjs — lib/boundaries/merge.mjs: the suite gate, in process, over
// real git and the real measurement.
//
// What is pinned here:
//
//   suiteGate  the full suite on the integration head, once per passing head; nothing run where
//              the tests are not split; a review that is not earned recorded once; a worktree that
//              cannot be attached; the checkout moving; the refusals
//
// Every repository is built with the fixture's seeding helpers; preflight and leaf-open are stood
// in for by the lib calls they make (`execution.json`, `acquire`, `ensureIntegration`,
// `ensureLeaf`, a `dispatched` event). Expected heads, branches, rounds and record paths are
// computed. The worlds the parts share are in test/harness/merge-world.mjs.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#the-suite-gate.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suiteGate } from '../lib/boundaries/merge.mjs'
import { readJson } from '../lib/store.mjs'
import { commitIn, leaf, root } from './harness/boundary-fixture.mjs'
import {
  SLOW, SPLIT, BREAK_BIG, inTest, stateOf, eventsOf, journalOf, headOf, stopsOf, kindOf, world, integrationOf,
  takeWorktree, moveCheckout, addBigTest, addOne,
} from './harness/merge-world.mjs'

const MEND_ADD = 'export const add = (a, b) => a + b\n'

// ================================================================== the suite gate

/** A split suite whose integration head breaks only the big test: `{w, integ, head}`. */
function brokenGate(t, nodes = [root(), addOne('a')]) {
  const w = world(inTest(t), nodes, { commands: SPLIT, prepare: addBigTest })
  const integ = integrationOf(w)
  const head = commitIn(integ.worktree, { 'src/add.mjs': BREAK_BIG }, 'Break only the big test')
  return { w, integ, head }
}
const gateLines = (r) => kindOf(stateOf(r), 'gate')

test('the gate runs the full suite on the integration head and escalates fails_full_suite', SLOW, async (t) => {
  const { w, head } = brokenGate(t)
  const out = await suiteGate(w.xc, { target: '.' })

  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.status, 'done')
  assert.equal(out.ran, true)
  assert.equal(out.passed, false)
  assert.equal(out.head_sha, head)
  assert.equal(out.head_sha, headOf(w.r, '.'))
  assert.deepEqual(stopsOf(out), [['.', 'escalated', 'fails_full_suite']])
  const record = readJson(out.record)
  assert.equal(record.measurement.suite_scope, 'full')
  assert.equal(record.base, w.base, 'the head the branch was cut from')
  const lines = gateLines(w.r)
  assert.equal(lines.length, 1)
  assert.deepEqual({ target: lines[0].target, head_sha: lines[0].head_sha, passed: lines[0].passed }, { target: '.', head_sha: head, passed: false })
  const seen = kindOf(journalOf(w.r), 'verify-observed', '.')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].suite_scope, 'full')
  assert.equal(typeof seen[0].key, 'string')
  assert.notEqual(seen[0].key, '')
})

test('a failing gate is asked again', SLOW, async (t) => {
  const { w } = brokenGate(t)
  const first = await suiteGate(w.xc, { target: '.' })
  const second = await suiteGate(w.xc, { target: '.' })

  assert.equal(second.ran, true)
  assert.equal(second.passed, false)
  assert.equal(second.head_sha, first.head_sha)
  assert.deepEqual(stopsOf(second), [['.', 'escalated', 'fails_full_suite']])
  const escalations = kindOf(eventsOf(w.r), 'escalated', '.').filter((e) => e.reason === 'fails_full_suite')
  assert.equal(escalations.length, 1, 'one escalation in all')
})

test('a passing gate is recorded against its head and not run again there', SLOW, async (t) => {
  const { w, integ, head } = brokenGate(t)
  const failed = await suiteGate(w.xc, { target: '.' })
  assert.equal(failed.passed, false)

  const mended = commitIn(integ.worktree, { 'src/add.mjs': MEND_ADD }, 'Mend the big test')
  assert.notEqual(mended, head)
  const passed = await suiteGate(w.xc, { target: '.' })
  assert.equal(passed.ran, true)
  assert.equal(passed.passed, true, JSON.stringify(passed.stops))
  assert.deepEqual(passed.stops, [])
  assert.equal(passed.head_sha, mended, 'the head it moved to is the one measured')
  assert.ok(gateLines(w.r).some((e) => e.target === '.' && e.head_sha === mended && e.passed === true))

  const measured = kindOf(journalOf(w.r), 'verify-observed', '.').length
  const again = await suiteGate(w.xc, { target: '.' })
  assert.equal(again.ran, false)
  assert.equal(again.passed, true)
  assert.equal(again.head_sha, mended)
  assert.equal(kindOf(journalOf(w.r), 'verify-observed', '.').length, measured, 'no new measurement')
})

test('the gate runs nothing where the repository does not split its tests', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('a')])
  const integ = integrationOf(w)
  const out = await suiteGate(w.xc, { target: '.' })

  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.ran, false)
  assert.equal(out.passed, true)
  assert.equal(out.record, '')
  assert.equal(out.review, 'earned')
  assert.equal(out.head_sha, integ.head)
  assert.equal(out.head_sha, headOf(w.r, '.'))
  assert.deepEqual(journalOf(w.r), [], 'nothing journalled')
  assert.deepEqual(kindOf(eventsOf(w.r), 'claims'), [], 'no claims recorded')
})

test('a passing gate records claims not_earned when the review is not earned, once', SLOW, async (t) => {
  const w = world(inTest(t), [root(),
    { id: 'c', kind: 'composite', title: 'part', author: 'planner', decisions: ['D1'], acceptance: [{ text: 'c works', check: 'node --test', decisions: ['D1'] }] },
    leaf('c/v', { rigor: 'verify' })])
  integrationOf(w, 'c')
  const first = await suiteGate(w.xc, { target: 'c' })
  const second = await suiteGate(w.xc, { target: 'c' })

  for (const out of [first, second]) {
    assert.equal(out.ok, true, JSON.stringify(out.error))
    assert.equal(out.passed, true)
    assert.equal(out.review, 'not_earned')
  }
  const claims = kindOf(eventsOf(w.r), 'claims', 'c')
  assert.equal(claims.length, 1, 'one in all')
  assert.equal(claims[0].head_sha, headOf(w.r, 'c'))
  assert.equal(claims[0].review, 'not_earned')
  assert.deepEqual(claims[0].claims, [])
})

test('a gate that cannot attach its worktree escalates suite_gate_failed', SLOW, async (t) => {
  const { w, integ } = brokenGate(t)
  takeWorktree(w, integ)
  const out = await suiteGate(w.xc, { target: '.' })

  assert.equal(out.status, 'stopped')
  assert.deepEqual(stopsOf(out), [['.', 'escalated', 'suite_gate_failed']])
  assert.deepEqual(gateLines(w.r), [], 'no gate line')
})

test('a checkout moved while the gate measured is a checkout fault, and no gate line', SLOW, async (t) => {
  const { w } = brokenGate(t)
  const seen = { moved: false, error: null }
  const call = suiteGate(w.xc, { target: '.' })
  // Everything the gate does before its measurement's child is synchronous: the timer fires after it.
  const timer = setTimeout(() => moveCheckout(w, seen), 0)
  let out
  try {
    out = await call
  } finally {
    clearTimeout(timer)
  }
  assert.equal(seen.error, null)
  assert.equal(seen.moved, true)

  assert.equal(out.status, 'held')
  assert.deepEqual(stopsOf(out), [['.', 'held', 'checkout']])
  const faults = kindOf(stateOf(w.r), 'fault')
  assert.equal(faults.length, 1)
  assert.equal(faults[0].node, '.')
  assert.equal(faults[0].channel, 'checkout')
  assert.deepEqual(gateLines(w.r), [], 'no gate line')
  assert.deepEqual(kindOf(eventsOf(w.r), 'escalated'), [], 'no escalation')
})

test('suite-gate refuses a target that is no composite, and one with no integration branch', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('a'),
    { id: 'c', kind: 'composite', title: 'part', author: 'planner', decisions: ['D1'], acceptance: [{ text: 'c works', check: 'node --test', decisions: ['D1'] }] },
    leaf('c/z', { rigor: 'trivial', locus: ['src/z.mjs'] })])
  const notComposite = await suiteGate(w.xc, { target: 'a' })
  assert.equal(notComposite.ok, false)
  assert.equal(notComposite.error.kind, 'not_a_composite')
  assert.deepEqual(notComposite.stops, [])

  const uncut = await suiteGate(w.xc, { target: 'c' })
  assert.equal(uncut.ok, false)
  assert.equal(uncut.error.kind, 'no_integration')
  assert.deepEqual(uncut.stops, [])
  assert.deepEqual(kindOf(eventsOf(w.r), 'escalated'), [], 'a refusal records nothing')
})
