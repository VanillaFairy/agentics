// test/fast/leaf-close-outcome.test.mjs — `producerOutcome` in lib/boundaries/leaf-close.mjs, pure:
// the round's status — an auditor's return reads `done`, whatever it carries — and the outcome of
// each status, in the spec's order: held, park, escalation, route to the planner or park,
// needs_tests, declined, measure. What a close does with each outcome, over real git, is
// test/boundaries-leaf-close-outcome.test.mjs.
//
// Design: docs/DESIGN.md#boundaries.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { producerOutcome } from '../../lib/boundaries/leaf-close.mjs'
import { escalated, message, parked } from '../../lib/boundaries/records.mjs'
import { normalizeNode } from '../../lib/tree.mjs'

const node = (extra) => normalizeNode({ id: 'a', kind: 'leaf', title: 'do a', rigor: 'tdd', role: 'none', expects: ['src/a.mjs'], decisions: ['D1'], ...extra })
const PLAIN = node({})
const RED = node({ id: 'r', rigor: 'tdd-pair', role: 'red' })
const GREEN = node({ id: 'g', rigor: 'tdd-pair', role: 'green' })
const AUDIT = node({ id: 'au', rigor: 'tdd-triad', role: 'audit' })
const AUDITOR_RETURN = { mutations: [], units: [], text: 'looked at it' }
const TEXT = 'the words the producer returned'

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
  const ports = { kind: 'doc', path: '.agentics/e1/DESIGN.md', what: 'the Ports part of the Design' }
  const ret = { status: 'done_with_concerns', text: TEXT, concerns: ['shapes guessed'], unread: [ports, { kind: 'doc', path: ' ', what: '' }] }
  for (const leaf of [node({ rigor: 'trivial' }), PLAIN, GREEN]) {
    const out = po({ leaf, ret })
    assert.equal(out.next, 'stop', leaf.rigor)
    assert.deepEqual(out.records, [escalated(leaf.id, 'unread_reference', '[doc] .agentics/e1/DESIGN.md — the Ports part of the Design', 'd7')], leaf.rigor)
  }
  assert.equal(po({ ret: { status: 'done', text: TEXT, unread: [] } }).next, 'measure', 'an empty list reads nothing unread')
  assert.equal(po({ ret: { status: 'done', text: TEXT, unread: [{ kind: 'doc', path: '', what: ' ' }] } }).next, 'measure', 'an entry naming nothing names nothing')
})

test('an unread entry is dropped only when its path is exactly one the round was denied reading', () => {
  const ret = (unread) => ({ status: 'done_with_concerns', text: TEXT, unread })
  const denyRead = ['src/core/critters/RoamBrain.ts']
  const source = { kind: 'source', path: 'src/core/critters/RoamBrain.ts', what: 'denied; mutation placed in steering.ts instead' }
  assert.equal(po({ leaf: GREEN, role: 'test-author', denyRead, ret: ret([source]) }).next, 'measure', 'withheld by design, not a reference it was told to match')
  const worktree = 'C:\\work\\game\\.agentics\\.worktrees\\g'
  const spelled = ['./src/core/critters/RoamBrain.ts', 'src\\core\\critters\\RoamBrain.ts', worktree + '\\src\\core\\critters\\RoamBrain.ts', 'c:/work/game/.agentics/.worktrees/g/src/core/critters/RoamBrain.ts']
  for (const path of spelled) {
    assert.equal(po({ leaf: GREEN, role: 'test-author', denyRead, worktree, ret: ret([{ ...source, path }]) }).next, 'measure', 'the same path, spelled otherwise: ' + path)
  }
  const near = [{ ...source, path: 'src/core/critters/roambrain.ts' }, { ...source, path: 'src/core/critters' }, { ...source, path: 'C:/elsewhere/src/core/critters/RoamBrain.ts' }]
  for (const u of near) assert.equal(po({ leaf: GREEN, role: 'test-author', denyRead, worktree, ret: ret([u]) }).next, 'stop', 'no near match drops: ' + u.path)
  const spec = { kind: 'doc', path: '.agentics/e1/roamers/DESIGN.md', what: 'the Ports part of the Design' }
  assert.equal(po({ leaf: GREEN, role: 'test-author', denyRead, ret: ret([source, spec]) }).next, 'stop', 'a document it was told to follow')
  assert.equal(po({ leaf: GREEN, role: 'test-author', ret: ret([source]) }).next, 'stop', 'a round denied nothing has no entry dropped, whatever its role')
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

test('blocked escalates with what the producer said, said the dispatch', () => {
  const out = po({ ret: { status: 'blocked', text: TEXT } })
  assert.equal(out.next, 'stop')
  assert.deepEqual(out.records, [escalated('a', 'blocked', TEXT, 'd7')])
})

test("blocked after a denied project command its entry's runs does not name stops as command_not_in_runs, naming it and what the producer said", () => {
  const denied = ['npm run asset:rename -- prop.burrow prop.beastling-burrow']
  const out = po({ ret: { status: 'blocked', text: TEXT }, denied })
  assert.equal(out.next, 'stop')
  assert.deepEqual(out.records, [escalated('a', 'command_not_in_runs', denied[0] + '\n\n' + TEXT, 'd7')])
})

test('blocked after only ad-hoc denied lines (reading or rewriting files, an inline script) goes back to the producer, not the session', () => {
  const denied = ['cd src/core/critters; cat RoamBrain.ts; git log --oneline | head -5', "python3 - <<'EOF'"]
  assert.deepEqual(po({ ret: { status: 'blocked', text: TEXT }, denied }), { next: 'adhoc', denied, text: TEXT })
  const mixed = po({ ret: { status: 'blocked', text: TEXT }, denied: [...denied, 'npm run asset:rename'] })
  assert.equal(mixed.next, 'stop', "a project command among them is still the spec's gap")
  const wrapped = ['eval "npm run asset:add -- prop.x --tiles 1x1"', 'for id in a b; do npm run asset:add -- $id; done']
  assert.equal(po({ ret: { status: 'blocked', text: TEXT }, denied: wrapped }).next, 'adhoc', 'a project command in a loop or eval runs as one plain line instead')
  const granted = { grants: ['npm run asset:add'] }
  assert.equal(po({ ret: { status: 'blocked', text: TEXT }, denied: ['cd assets && npm run asset:add -- x'], ...granted }).next, 'adhoc',
    'a granted command behind a cd runs as one plain line instead')
})

test("blocked after a denied line the round was granted as it stands is the plugin's, never the producer's or the spec's", () => {
  const denied = ['npm run asset:add -- x']
  assert.deepEqual(po({ ret: { status: 'blocked', text: TEXT }, denied, grants: ['npm run asset:add'] }), { next: 'mismatch', denied })
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
  assert.deepEqual(out, { next: 'needs_tests', text: TEXT })
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
