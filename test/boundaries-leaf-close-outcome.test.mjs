// test/boundaries-leaf-close-outcome.test.mjs — lib/boundaries/leaf-close.mjs: what a close reads
// from the round's stored return before it measures, over real git and the real measurement.
//
// What is pinned here:
//
//   producerOutcome  (pure) the round's status — an auditor's return reads `done`, whatever it
//                    carries — and the outcome of each status, in the spec's order: held, park,
//                    escalation, route to the planner or park, needs_tests, declined,
//                    measure
//   leafClose        before measuring: a role fault, a park, a route, needs_tests and a decline
//                    answered with a message
//
// A close is never seeded by hand: every close record and every `breach_reverted` line comes from a
// `leafClose` call. Expected ids, shas, paths and keys are computed. The world builders the
// leaf-close files share are in test/harness/leaf-close-world.mjs.
//
// Design: docs/DESIGN.md#boundaries.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { producerOutcome } from '../lib/boundaries/leaf-close.mjs'
import { escalated, message, parked } from '../lib/boundaries/records.mjs'
import { normalizeNode } from '../lib/tree.mjs'
import { greenRoundRole } from '../lib/verdict.mjs'
import { root } from './harness/boundary-fixture.mjs'
import {
  SLOW, world, open, commit, stored, close, run, recs, msgs, sizes, observed, rec, DONE, A_FILES, lf, planner,
  tdd, R_SURVIVES, cycle, answered, crit, claimsOf, stopOf,
} from './harness/leaf-close-world.mjs'

// ================================================================== producerOutcome (pure)

const node = (extra) => normalizeNode({ id: 'a', kind: 'leaf', title: 'do a', rigor: 'tdd', role: 'none', expects: ['src/a.mjs'], decisions: ['D1'], ...extra })
const PLAIN = node({})
const RED = node({ id: 'r', rigor: 'tdd-pair', role: 'red' })
const GREEN = node({ id: 'g', rigor: 'tdd-pair', role: 'green' })
const AUDIT = node({ id: 'au', rigor: 'tdd-triad', role: 'audit' })
const AUDITOR_RETURN = { mutations: [], units: [], text: 'looked at it' }
const TEXT = 'the words the producer returned'
const FAIL = "node -e 'process.exit(1)'"

const po = (o) => producerOutcome({ leaf: PLAIN, role: 'implementer', round: 1, ret: { status: 'done', text: TEXT }, dispatch: 'd7', ...o })

test('no stored return holds the round', () => {
  for (const role of ['implementer', 'test-author', 'auditor']) {
    assert.equal(po({ role, ret: null }).next, 'held', role)
  }
})

test('a return with no status holds the round', () => {
  assert.equal(po({ ret: { text: TEXT } }).next, 'held')
  assert.equal(po({ ret: { status: 3, text: TEXT } }).next, 'held', 'a status that is not a string is no status')
})

test('a done return naming a document it could not read escalates unread_reference at every rigor, never measured', () => {
  const ret = { status: 'done_with_concerns', text: TEXT, concerns: ['shapes guessed'], unread: ['the Design\'s "Ports" block', ' '] }
  for (const leaf of [node({ rigor: 'trivial' }), PLAIN, GREEN]) {
    const out = po({ leaf, ret })
    assert.equal(out.next, 'stop', leaf.rigor)
    assert.deepEqual(out.records, [escalated(leaf.id, 'unread_reference', 'the Design\'s "Ports" block', 'd7')], leaf.rigor)
  }
  assert.equal(po({ ret: { status: 'done', text: TEXT, unread: [] } }).next, 'measure', 'an empty list reads nothing unread')
  assert.equal(po({ ret: { status: 'done', text: TEXT, unread: ['', '  '] } }).next, 'measure', 'blank lines name nothing')
})

test("a cycle's test round naming the implementation it is kept from as unread is measured; a document it names still escalates", () => {
  const ret = (unread) => ({ status: 'done_with_concerns', text: TEXT, unread })
  const source = ['src/core/critters/RoamBrain.ts — denied to this role; mutation placed in steering.ts instead']
  assert.equal(po({ leaf: GREEN, role: 'test-author', ret: ret(source) }).next, 'measure', 'withheld by design, not a reference it was told to match')
  const spec = ['.agentics/e1/roamers/DESIGN.md, the Ports block of the Design']
  assert.equal(po({ leaf: GREEN, role: 'test-author', ret: ret(spec) }).next, 'stop', 'a document it was told to follow')
  assert.equal(po({ ret: ret(source) }).next, 'stop', 'an implementer is never kept from the source: the same entry is a real gap')
})

test("an auditor's return, which carries no status, is measured", () => {
  assert.equal(po({ leaf: AUDIT, role: 'auditor', ret: AUDITOR_RETURN }).next, 'measure')
})

test("an auditor's return is read the same with a status field as without one", () => {
  const at = (ret) => po({ leaf: AUDIT, role: 'auditor', round: 2, head_before: 'h1', head: 'h1', answering: 'needs_tests', red: 'r', ret })
  const without = at(AUDITOR_RETURN)
  assert.equal(without.next, 'measure')
  for (const status of ['needs_tests', 'blocked', 'declined', 'needs_decision', 'decompose']) {
    assert.deepEqual(at({ ...AUDITOR_RETURN, status }), without, status)
  }
})

test('a leaf with no producer is measured without a return', () => {
  assert.equal(po({ role: '', ret: null }).next, 'measure')
  assert.equal(po({ role: '', ret: { status: 'blocked', text: TEXT } }).next, 'measure', 'no return is read for a leaf with no producer')
})

test('blocked escalates, said the dispatch', () => {
  const out = po({ ret: { status: 'blocked', text: TEXT } })
  assert.equal(out.next, 'stop')
  assert.deepEqual(out.records, [escalated('a', 'blocked', '', 'd7')])
})

test('blocked after a denied command stops as command_denied, naming the command', () => {
  const denied = ['npm run asset:rename -- prop.burrow prop.beastling-burrow']
  const out = po({ ret: { status: 'blocked', text: TEXT }, denied })
  assert.equal(out.next, 'stop')
  assert.deepEqual(out.records, [escalated('a', 'command_denied', denied[0], 'd7')])
})

test('blocked after only ad-hoc denied lines (reading or rewriting files, an inline script) goes back to the producer, not the session', () => {
  const denied = ['cd src/core/critters; cat RoamBrain.ts; git log --oneline | head -5', "python3 - <<'EOF'"]
  assert.deepEqual(po({ ret: { status: 'blocked', text: TEXT }, denied }), { next: 'denied', denied })
  const mixed = po({ ret: { status: 'blocked', text: TEXT }, denied: [...denied, 'npm run asset:rename'] })
  assert.equal(mixed.next, 'stop', "a project command among them is still the spec's gap")
  const wrapped = ['eval "npm run asset:add -- prop.x --tiles 1x1"', 'for id in a b; do npm run asset:add -- $id; done']
  assert.equal(po({ ret: { status: 'blocked', text: TEXT }, denied: wrapped }).next, 'denied', 'a project command in a loop or eval runs as one plain line instead')
})

test('needs_decision parks the leaf on it, said the dispatch', () => {
  const out = po({ ret: { status: 'needs_decision', text: TEXT } })
  assert.equal(out.next, 'stop')
  assert.deepEqual(out.records, [parked('a', 'needs_decision', '', 'd7')])
})

test('contract_changed parks the leaf on it, said the dispatch', () => {
  const out = po({ ret: { status: 'contract_changed', text: TEXT } })
  assert.equal(out.next, 'stop')
  assert.deepEqual(out.records, [parked('a', 'contract_changed', '', 'd7')])
})

const ROUTED = ['needs_context', 'decompose', 'unsplittable', 'premise_mismatch']
const routedReturn = (status) => ({ status, text: TEXT })

for (const status of ROUTED) {
  test(`${status} goes to the planner when the planner wrote the folder`, () => {
    const out = po({ author: 'planner', ret: routedReturn(status) })
    assert.equal(out.next, 'route')
    assert.equal(out.to, 'planner')
    assert.deepEqual(out.records, [])
  })
}

test('needs_context parks the leaf needs_context under a folder the user wrote', () => {
  const out = po({ author: 'you', ret: routedReturn('needs_context') })
  assert.equal(out.next, 'route')
  assert.equal(out.to, 'park')
  assert.deepEqual(out.records, [parked('a', 'needs_context', '', 'd7')])
})

for (const status of ['decompose', 'unsplittable', 'premise_mismatch']) {
  test(`${status} parks the leaf needs_respec under a folder the user wrote`, () => {
    const out = po({ author: 'you', ret: routedReturn(status) })
    assert.equal(out.next, 'route')
    assert.equal(out.to, 'park')
    assert.deepEqual(out.records, [parked('a', 'needs_respec', '', 'd7')])
  })
}

test('a route is the same from an implementer and from a test-author', () => {
  for (const role of ['implementer', 'test-author']) {
    const out = po({ role, author: 'planner', ret: routedReturn('decompose') })
    assert.deepEqual([out.next, out.to], ['route', 'planner'], role)
  }
})

test("a green's implementer returning needs_tests asks the cycle's test session in the next round", () => {
  const out = po({ leaf: GREEN, role: 'implementer', round: 2, red: 'r', ret: { status: 'needs_tests', text: TEXT } })
  assert.equal(out.next, 'needs_tests')
  assert.deepEqual(out.records, [message('g', 'producer:r', 'needs_tests', { text: TEXT }, 3, 'implementer')])
})

test("needs_tests from a plain leaf's implementer escalates", () => {
  const out = po({ leaf: PLAIN, role: 'implementer', round: 2, ret: { status: 'needs_tests', text: TEXT } })
  assert.equal(out.next, 'stop')
  assert.deepEqual(out.records, [escalated('a', 'needs_tests', '', 'd7')])
})

test("needs_tests from a red's test-author escalates", () => {
  const out = po({ leaf: RED, role: 'test-author', round: 1, ret: { status: 'needs_tests', text: TEXT } })
  assert.equal(out.next, 'stop')
  assert.deepEqual(out.records, [escalated('r', 'needs_tests', '', 'd7')])
})

test("needs_tests from a green's test-author round escalates", () => {
  const out = po({ leaf: GREEN, role: 'test-author', round: 2, red: 'r', ret: { status: 'needs_tests', text: TEXT } })
  assert.equal(out.next, 'stop')
  assert.deepEqual(out.records, [escalated('g', 'needs_tests', '', 'd7')])
})

test('a cycle test round declining needs_tests answers the implementer with declined', () => {
  const out = po({ leaf: GREEN, role: 'test-author', round: 3, red: 'r', answering: 'needs_tests', ret: { status: 'declined', text: TEXT } })
  assert.equal(out.next, 'declined')
  assert.deepEqual(out.records, [message('g', 'producer:g', 'declined', { why: TEXT }, 4, 'test-author')])
})

test('a cycle test round declining findings escalates tests_declined', () => {
  const out = po({ leaf: GREEN, role: 'test-author', round: 3, red: 'r', answering: 'findings', ret: { status: 'declined', text: TEXT } })
  assert.equal(out.next, 'declined')
  assert.deepEqual(out.records, [escalated('g', 'tests_declined', '', 'd7')])
})

test('a cycle test round declining surviving_mutations escalates tests_declined', () => {
  const out = po({ leaf: AUDIT, role: 'test-author', round: 2, red: 'r', answering: 'surviving_mutations', ret: { status: 'declined', text: TEXT } })
  assert.equal(out.next, 'declined')
  assert.deepEqual(out.records, [escalated('au', 'tests_declined', '', 'd7')])
})

test("declined from a plain leaf's implementer escalates", () => {
  const out = po({ leaf: PLAIN, role: 'implementer', round: 2, ret: { status: 'declined', text: TEXT } })
  assert.equal(out.next, 'stop')
  assert.deepEqual(out.records, [escalated('a', 'declined', '', 'd7')])
})

test("declined from a red's test-author escalates", () => {
  const out = po({ leaf: RED, role: 'test-author', round: 1, ret: { status: 'declined', text: TEXT } })
  assert.equal(out.next, 'stop')
  assert.deepEqual(out.records, [escalated('r', 'declined', '', 'd7')])
})

test("declined from a green's implementer escalates", () => {
  const out = po({ leaf: GREEN, role: 'implementer', round: 2, red: 'r', answering: 'needs_tests', ret: { status: 'declined', text: TEXT } })
  assert.equal(out.next, 'stop')
  assert.deepEqual(out.records, [escalated('g', 'declined', '', 'd7')])
})

test("an implementer's round is measured whether it moved or not: no status alone escalates a round with no commits", () => {
  for (const round of [1, 2, 3]) assert.equal(po({ round }).next, 'measure')
  assert.equal(po({ leaf: GREEN, role: 'test-author', round: 2, red: 'r' }).next, 'measure')
})

// ================================================================== before measuring

describe('leaf-close before it measures', { concurrency: 4 }, () => {
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
    assert.deepEqual(out.stops.map((s) => [s.id, s.reason, s.said]), [['a', 'command_denied', dispatch]])
    assert.equal(recs(w, 'escalated', 'a').find((e) => e.reason === 'command_denied').detail, command)
  })

  test('a round blocked on ad-hoc denials is sent them as failures and fixes; the same denials again escalate command_denied', SLOW, async (t) => {
    const { w, o } = tdd(t)
    const command = "python3 - <<'EOF'\nopen('src/a.mjs').read()\nEOF"
    const denials = [{ tool_name: 'Bash', tool_use_id: 't1', tool_input: { command } }]
    const first = await run(w, { node: 'a', role: 'implementer', round: 1, ret: { status: 'blocked', text: TEXT }, denials, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual([first.out.decision.next, first.out.decision.reason], ['fix', 'command_denied'])
    assert.deepEqual(first.out.stops, [])
    const told = msgs(w, 'failures', 'a').at(-1)
    assert.equal(told.payload.source, 'the permission check')
    assert.match(told.payload.failures[0].evidence, /Edit and Write/)
    const second = await run(w, { node: 'a', role: 'implementer', round: 2, ret: { status: 'blocked', text: TEXT }, denials, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual(second.out.stops.map((s) => [s.id, s.reason]), [['a', 'command_denied']])
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
