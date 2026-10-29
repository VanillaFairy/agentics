// test/boundaries-leaf-close-outcome.test.mjs — lib/boundaries/leaf-close.mjs: what a close reads
// from the round's stored return before it measures, over real git and the real measurement.
//
// What is pinned here:
//
//   leafClose  before measuring: a role fault, a park, a route, needs_tests and a decline
//              answered with a message
//
// `producerOutcome`, the pure half, is test/fast/leaf-close-outcome.test.mjs.
//
// A close is never seeded by hand: every close record and every `breach_reverted` line comes from a
// `leafClose` call. Expected ids, shas, paths and keys are computed. The world builders the
// leaf-close files share are in test/harness/leaf-close-world.mjs.
//
// Design: docs/DESIGN.md#boundaries.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { greenRoundRole } from '../lib/verdict.mjs'
import { root } from './harness/boundary-fixture.mjs'
import {
  SLOW, world, open, commit, stored, close, run, recs, msgs, sizes, observed, rec, DONE, A_FILES, lf, planner,
  tdd, R_SURVIVES, cycle, answered, crit, claimsOf, stopOf,
} from './harness/leaf-close-world.mjs'

const TEXT = 'the words the producer returned'
const FAIL = "node -e 'process.exit(1)'"

// ================================================================== before measuring

describe('leaf-close before it measures', { concurrency: 4 }, () => {
  test("a cycle test round's unread source is dropped only by the deny_read its dispatched line records", SLOW, async (t) => {
    const ret = { status: 'done_with_concerns', text: TEXT, unread: [{ kind: 'source', path: 'src/r.mjs', what: 'kept from me' }] }
    const round = { node: 'g', role: 'test-author', round: 2, thread: 'producer:r', ret }
    const denied = cycle(t)
    const kept = await run(denied.w, { ...round, denyRead: ['src/r.mjs'], base_sha: denied.green.base_sha, head_before: denied.greenHead })
    assert.notEqual(kept.out.decision.reason, 'unread_reference', JSON.stringify(kept.out.decision))
    const open = cycle(t)
    const gap = await run(open.w, { ...round, base_sha: open.green.base_sha, head_before: open.greenHead })
    assert.deepEqual(gap.out.stops.map((s) => s.reason), ['unread_reference'])
  })

  test('a dispatch with no stored return holds the leaf on a role fault, and nothing is measured', SLOW, async (t) => {
    const { w, o } = tdd(t)
    const { out, dispatch } = await run(w, { node: 'a', role: 'implementer', round: 1, base_sha: o.base_sha })
    assert.deepEqual(out.stops, [{ id: 'a', status: 'held', reason: 'role', said: '' }])
    assert.equal(out.decision.next, 'stop')
    const faults = recs(w, 'fault', 'a')
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'role')
    assert.equal(observed(w, 'a').length, 0, 'nothing was measured')
    const record = rec(w, 'a', 'implementer', 1)
    assert.equal(record.dispatch, dispatch)
    assert.equal(record.status, '', 'a record is written on every path, with no status when nothing came back')
    assert.equal(record.decision.next, 'stop')
    await assert.rejects(async () => close(w, { node: '.', role: 'implementer', round: 1, dispatch: 'none' }), /is not a leaf/, 'a folder is no leaf')
  })

  test("an auditor's dispatch with no stored return holds the audit on a role fault, and nothing is measured", SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    const { out } = await run(c.w, { node: 'au', role: 'auditor', round: 1, base_sha: c.audit.base_sha })
    assert.deepEqual(out.stops, [{ id: 'au', status: 'held', reason: 'role', said: '' }])
    const faults = recs(c.w, 'fault', 'au')
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'role')
    assert.equal(observed(c.w, 'au').length, 0)
  })

  test('a park the producer returned is recorded said the dispatch, and nothing is measured', SLOW, async (t) => {
    const { w, o } = tdd(t)
    const { out, dispatch } = await run(w, { node: 'a', role: 'implementer', round: 1, base_sha: o.base_sha, ret: { status: 'needs_decision', text: 'which format?' } })
    assert.deepEqual(out.stops, [{ id: 'a', status: 'parked', reason: 'needs_decision', said: dispatch }])
    const parks = recs(w, 'parked', 'a')
    assert.equal(parks.length, 1)
    assert.equal(parks[0].return, 'needs_decision')
    assert.equal(parks[0].said, dispatch)
    assert.equal(observed(w, 'a').length, 0)
    const record = rec(w, 'a', 'implementer', 1)
    assert.equal(record.status, 'needs_decision')
    assert.equal(record.dispatch, dispatch)
    assert.equal(out.decision.next, 'stop')
  })

  test("a route to the folder's planner records nothing and hands back the producer's request", SLOW, async (t) => {
    const w = world(t, [root(), planner(), lf('c/a', { expects: ['src/a.mjs', 'test/a.test.mjs'] })])
    const o = open(w, 'c/a')
    const ret = { status: 'needs_context', text: 'which tokenizer does the source use?' }
    const dispatch = stored(w, { node: 'c/a', role: 'implementer', round: 1, ret })
    const before = sizes(w)
    const out = await close(w, { node: 'c/a', role: 'implementer', round: 1, dispatch, base_sha: o.base_sha })
    assert.equal(out.decision.next, 'route')
    assert.equal(out.decision.reason, 'needs_context')
    assert.equal(out.route.to, 'planner')
    assert.equal(out.route.folder, 'c')
    assert.equal(out.route.request.node, 'c/a')
    assert.equal(out.route.request.status, 'needs_context')
    assert.equal(out.route.request.text, ret.text)
    assert.deepEqual(out.route.request.paths, [])
    assert.deepEqual(out.stops, [])
    assert.deepEqual(sizes(w), before, 'nothing recorded beyond the round\'s own dispatched and returned')
    assert.equal(rec(w, 'c/a', 'implementer', 1).status, 'needs_context')

    const second = await run(w, { node: 'c/a', role: 'implementer', round: 2, base_sha: o.base_sha, ret: { status: 'decompose', text: 'two jobs' } })
    assert.equal(second.out.decision.next, 'route')
    assert.equal(second.out.decision.reason, 'decompose')
  })

  test('a route under a folder the user wrote parks the leaf', SLOW, async (t) => {
    const { w, o } = tdd(t)
    const { out, dispatch } = await run(w, { node: 'a', role: 'implementer', round: 1, base_sha: o.base_sha, ret: { status: 'decompose', text: 'two jobs' } })
    assert.equal(out.decision.next, 'stop')
    assert.equal(out.route, undefined)
    assert.deepEqual(out.stops, [{ id: 'a', status: 'parked', reason: 'needs_respec', said: dispatch }])
    assert.equal(recs(w, 'parked', 'a').length, 1)
    assert.equal(observed(w, 'a').length, 0)
  })

  test("a green implementer's needs_tests writes the close record with its status and what the round answered", SLOW, async (t) => {
    const c = cycle(t)
    const seq = answered(c.w, { node: 'g', thread: 'producer:g', msg: 'findings', payload: { findings: [] }, round: 2 })
    const ret = { status: 'needs_tests', text: 'the table already holds one letter; only a test can pin it' }
    const { out, dispatch } = await run(c.w, { node: 'g', role: 'implementer', round: 2, ret, carries: [seq], base_sha: c.green.base_sha, head_before: c.greenHead })
    assert.equal(out.decision.next, 'fix')
    const record = rec(c.w, 'g', 'implementer', 2)
    assert.equal(record.status, 'needs_tests')
    assert.equal(record.answering, 'findings')
    assert.equal(record.role, 'implementer')
    assert.equal(record.round, 2)
    assert.equal(record.dispatch, dispatch)
    assert.equal(greenRoundRole({ close: record }), 'test-author')
    assert.equal(observed(c.w, 'g').length, 0, 'nothing was measured')
  })

  test("a green implementer's needs_tests records needs_tests to the cycle's test session", SLOW, async (t) => {
    const c = cycle(t)
    const ret = { status: 'needs_tests', text: 'only a test can pin the table' }
    const { out } = await run(c.w, { node: 'g', role: 'implementer', round: 2, ret, base_sha: c.green.base_sha, head_before: c.greenHead })
    assert.deepEqual(out.stops, [])
    const sent = msgs(c.w, 'needs_tests', 'g')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:r')
    assert.equal(sent[0].from, 'implementer')
    assert.equal(sent[0].round, 3)
    assert.equal(sent[0].payload.text, ret.text)
  })

  test('a decline of needs_tests records declined to the implementer', SLOW, async (t) => {
    const c = cycle(t)
    const seq = answered(c.w, { node: 'g', thread: 'producer:r', msg: 'needs_tests', payload: { text: 'pin it' }, round: 3, from: 'implementer' })
    const ret = { status: 'declined', text: 'a test of that would pin an implementation detail' }
    const { out } = await run(c.w, { node: 'g', role: 'test-author', round: 3, thread: 'producer:r', ret, carries: [seq], base_sha: c.green.base_sha, head_before: c.greenHead })
    assert.equal(out.decision.next, 'fix')
    assert.deepEqual(out.stops, [])
    const sent = msgs(c.w, 'declined', 'g')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:g')
    assert.equal(sent[0].from, 'test-author')
    assert.equal(sent[0].round, 4)
    assert.equal(sent[0].payload.why, ret.text)
    assert.equal(rec(c.w, 'g', 'test-author', 3).status, 'declined')
    assert.equal(observed(c.w, 'g').length, 0, 'nothing was measured')
  })

  test('a decline of surviving mutations escalates tests_declined', SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    const seq = answered(c.w, { node: 'au', thread: 'producer:r', msg: 'surviving_mutations', payload: { mutations: [R_SURVIVES] }, round: 2 })
    const ret = { status: 'declined', text: 'x + 2 doubles 2 as well; no test of 2 can tell' }
    const { out, dispatch } = await run(c.w, { node: 'au', role: 'test-author', round: 2, thread: 'producer:r', ret, carries: [seq], base_sha: c.audit.base_sha })
    assert.equal(out.decision.next, 'stop')
    assert.deepEqual(out.stops, [{ id: 'au', status: 'escalated', reason: 'tests_declined', said: dispatch }])
    assert.equal(msgs(c.w, 'declined', 'au').length, 0, 'a decline of surviving mutations is no message')
  })

  test('an implementer round that moved nothing and was sent no failures of its head is measured, and approved when it passes', SLOW, async (t) => {
    const { w, o } = tdd(t)
    const first = commit(o.worktree, A_FILES, 'Add a')
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: first })
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
    assert.deepEqual(out.stops, [])
    assert.ok(observed(w, 'a').some((l) => l.head_sha === first))
  })

  test('an implementer round sent the failures of the head it returned unmoved escalates fix_without_commits with the measured failures', SLOW, async (t) => {
    const { w, o } = tdd(t, { acceptance: crit('a', FAIL) })
    const first = commit(o.worktree, A_FILES, 'Add a')
    const one = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(one.out.decision.next, 'fix', JSON.stringify(one.out.decision))
    const { out, dispatch } = await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: first })
    assert.equal(out.decision.next, 'stop')
    assert.deepEqual(out.stops.map((s) => [s.id, s.status, s.reason, s.said]), [['a', 'escalated', 'fix_without_commits', dispatch]])
    const stop = recs(w, 'escalated', 'a').find((e) => e.reason === 'fix_without_commits')
    for (const claim of claimsOf(out)) assert.ok(stop.detail.includes(claim), 'the escalation carries ' + claim)
    assert.ok(claimsOf(out).length > 0)
    assert.equal(stopOf(rec(w, 'a', 'implementer', 2)), 'completed', 'the head was measured')
  })

  test("a blocked round reads the host's Bash denials from its returned line", SLOW, async (t) => {
    const { w, o } = tdd(t)
    const command = 'npm run asset:rename -- prop.burrow prop.beastling-burrow'
    const denials = [
      { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command } },
      { tool_name: 'Bash', tool_use_id: 't2', tool_input: { command } },
      { tool_name: 'Write', tool_use_id: 't3', tool_input: { file_path: 'x' } },
    ]
    const { out, dispatch } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: { status: 'blocked', text: TEXT }, denials, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual(out.stops.map((s) => [s.id, s.reason, s.said]), [['a', 'command_not_in_runs', dispatch]])
    assert.equal(recs(w, 'escalated', 'a').find((e) => e.reason === 'command_not_in_runs').detail, command + '\n\n' + TEXT)
  })

  test('a round blocked on ad-hoc denials is sent them as failures; blocked on ad-hoc lines again, any lines, it escalates blocked with what it said', SLOW, async (t) => {
    const { w, o } = tdd(t)
    const command = "python3 - <<'EOF'\nopen('src/a.mjs').read()\nEOF"
    const denials = [{ tool_name: 'Bash', tool_use_id: 't1', tool_input: { command } }]
    const first = await run(w, { node: 'a', role: 'implementer', round: 1, ret: { status: 'blocked', text: TEXT }, denials, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual([first.out.decision.next, first.out.decision.reason], ['fix', 'ad_hoc_command'])
    assert.deepEqual(first.out.stops, [])
    const told = msgs(w, 'failures', 'a').at(-1)
    assert.equal(told.payload.source, 'the permission check')
    assert.match(told.payload.failures[0].evidence, /Edit and Write/)
    const other = [{ tool_name: 'Bash', tool_use_id: 't9', tool_input: { command: 'cat src/a.mjs' } }]
    const second = await run(w, { node: 'a', role: 'implementer', round: 2, ret: { status: 'blocked', text: TEXT }, denials: other, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual(second.out.stops.map((s) => [s.id, s.reason]), [['a', 'blocked']])
    assert.ok(recs(w, 'escalated', 'a').find((e) => e.reason === 'blocked').detail.includes(TEXT))
  })

  test('an implementer round that moved nothing over commits made by hand since the round before closed is measured', SLOW, async (t) => {
    const { w, o } = tdd(t)
    const before = await run(w, { node: 'a', role: 'implementer', round: 1, ret: { status: 'blocked', text: TEXT }, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(before.out.decision.next, 'stop')
    const hand = commit(o.worktree, A_FILES, 'Add a by hand')
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: hand })
    assert.deepEqual(out.stops.filter((s) => s.reason === 'fix_without_commits'), [])
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
    assert.ok(observed(w, 'a').some((l) => l.head_sha === hand))
  })
})
