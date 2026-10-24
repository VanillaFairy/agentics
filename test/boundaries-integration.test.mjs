// test/boundaries-integration.test.mjs — pins a folder's integration review and a ruler's close,
// in-process: claim rulings recorded at the head judged with the one park they earn, and what a
// ruler's rulings on drift or a moved base decide for each node it was asked about.
//
// Design: docs/DESIGN.md#executors-and-review and docs/DESIGN.md#landing-and-drift.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

import { executionContext } from '../lib/boundaries/records.mjs'
import { folderReview, ruleClose } from '../lib/boundaries/integration.mjs'
import { executionLog, readLog } from '../lib/ledger.mjs'
import { dispatchKey, posix, returnPath, specPath, writeJson } from '../lib/store.mjs'
import { readTree, unsettledClaims } from '../lib/tree.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { leaf, repo, root, STAMP } from './harness/boundary-fixture.mjs'

const E = 'e1'

/** A seeded effort, an execution log port over it and its context. */
function setup(t, nodes) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  const seeded = seedTree(r, E, [root(), ...nodes])
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems))
  return { r, xc: executionContext({ repo: r, effort: E, execution: STAMP, log: executionLog(r, E, STAMP) }) }
}

/** A dispatch on `node` whose return is stored where the runner stores one, with its `returned` record. */
function stored(xc, node, role, thread, value) {
  const dispatch = dispatchKey({ node, role, thread, round: 1 })
  xc.log.append('dispatched', {
    dispatch, node, round: 1, thread, role, model: 'opus', effort: 'medium', session: 's-' + thread,
    brief_digest: 'd', brief_parts: {}, carries: [], pid: 1,
  })
  writeJson(returnPath(xc.dir, dispatch), value)
  xc.log.append('returned', { dispatch, session: 's', status: 'returned', cause: '', usage: null, cost_total: null, cost_usd: null, denials: [] })
  return dispatch
}

const review = (xc, value) => stored(xc, '.', 'reviewer', 'integration:.:1',
  { units: [], findings: [], fix_rulings: [], claims: [], notes: '', ...value })
const ruler = (xc, rulings) => stored(xc, '.', 'ruler', 'ruler:drift:x', { rulings })
const claim = (ruling, text = 'claim ' + ruling) => ({ claim: text, ruling, evidence: 'src/a.mjs:1', failure_scenario: '' })
const drifting = (ruling, text) => ({ ...claim(ruling, text), failure_scenario: 'a save written now reads back empty' })
const critical = { id: 'F1', severity: 'critical', claim: 'wrong', evidence: 'src/a.mjs:1', failure_scenario: 'it breaks' }
const events = (r, kind) => readLog(r, E, 'events').entries.filter((e) => e.kind === kind)
const state = (r, kind) => readLog(r, E, 'state:' + STAMP).entries.filter((e) => e.kind === kind)
const A = leaf('a', { expects: ['src/a.mjs'] })

// ---------------------------------------------------------------- folder review

test('a folder review records claims with ruling at the head judged, said the reviewer\'s dispatch', (t) => {
  const { r, xc } = setup(t, [A])
  const dispatch = review(xc, { claims: [claim('met', 'it builds'), claim('met', 'it adds')], findings: [{ ...critical, severity: 'minor' }] })
  const out = folderReview(xc, { target: '.', head: 'h1', dispatch, spec_path: 'S' })
  assert.equal(out.status, 'recorded')
  assert.equal(out.claims_n, 2)
  assert.equal(out.findings_n, 1)
  const [c] = events(r, 'claims')
  assert.equal(c.node, '.')
  assert.equal(c.head_sha, 'h1')
  assert.equal(c.review, 'done')
  assert.equal(c.said, dispatch)
  assert.deepEqual(c.claims.map((x) => [x.claim, x.ruling]), [['it builds', 'met'], ['it adds', 'met']])
})

test('every claim met and no critical parks nothing', (t) => {
  const { r, xc } = setup(t, [A])
  const out = folderReview(xc, { target: '.', head: 'h1', dispatch: review(xc, { claims: [claim('met')] }), spec_path: 'S' })
  assert.deepEqual(out.stops, [])
  assert.equal(events(r, 'parked').length, 0)
})

test('a spec_defect parks the folder spec_defect on its spec, before every other class', (t) => {
  const { r, xc } = setup(t, [A])
  const spec = posix(specPath(r, E, '.'))
  const dispatch = review(xc, { claims: [claim('cant_tell'), claim('under'), claim('spec_defect')], findings: [critical] })
  const out = folderReview(xc, { target: '.', head: 'h1', dispatch, spec_path: spec })
  assert.deepEqual(out.stops, [{ id: '.', status: 'parked', reason: 'spec_defect', said: dispatch }])
  const [p] = events(r, 'parked')
  assert.equal(p.return, 'spec_defect')
  assert.ok(p.question.startsWith('the spec ' + spec + ': '), p.question)
  assert.equal(p.said, dispatch)
})

test('a critical finding, or an under, over or deviates claim naming its failure, parks integration_critical', (t) => {
  const { r, xc } = setup(t, [A])
  const cases = [
    { claims: [claim('met')], findings: [critical] },
    { claims: [drifting('under')] }, { claims: [drifting('over')] }, { claims: [drifting('deviates')] },
    { claims: [claim('cant_tell')], findings: [critical] },
  ]
  for (const [i, value] of cases.entries()) {
    const out = folderReview(xc, { target: '.', head: 'h' + i, dispatch: review(xc, value), spec_path: 'S' })
    assert.deepEqual(out.stops.map((s) => s.reason), ['integration_critical'], JSON.stringify(value))
  }
  const parks = events(r, 'parked')
  assert.equal(parks.length, cases.length, 'each review records the park it earns after its claims, which clear the park before')
  const tree = readTree(r, E)
  assert.equal(tree.status.get('.').status, 'parked')
  assert.ok(parks.at(-1).seq > events(r, 'claims').at(-1).seq && tree.status.get('.').last.seq === parks.at(-1).seq)
})

test('a cant_tell, or a drift naming no failure, parks nothing and stands unsettled for landing, never as a pass', (t) => {
  const { r, xc } = setup(t, [A])
  const claims = [claim('met'), claim('cant_tell'), claim('under'), claim('over'), claim('deviates')]
  const out = folderReview(xc, { target: '.', head: 'h1', dispatch: review(xc, { claims }), spec_path: 'S' })
  assert.deepEqual(out.stops, [])
  assert.equal(events(r, 'parked').length, 0)
  const tree = readTree(r, E)
  assert.deepEqual(unsettledClaims(tree.nodes, tree.events).map((c) => [c.node, c.ruling]),
    [['.', 'cant_tell'], ['.', 'under'], ['.', 'over'], ['.', 'deviates']])
})

test('a drift that names its failure keeps the scenario in its claims event; any other claim records none', (t) => {
  const { r, xc } = setup(t, [A])
  folderReview(xc, { target: '.', head: 'h1', dispatch: review(xc, { claims: [drifting('under', 'u'), claim('over', 'o'), claim('met', 'm')] }), spec_path: 'S' })
  const [c] = events(r, 'claims')
  assert.deepEqual(c.claims, [
    { claim: 'u', ruling: 'under', failure_scenario: 'a save written now reads back empty' },
    { claim: 'o', ruling: 'over' }, { claim: 'm', ruling: 'met' },
  ])
  const tree = readTree(r, E)
  assert.deepEqual(unsettledClaims(tree.nodes, tree.events).map((x) => x.claim), ['o'], 'the drift that parked is no unsettled claim')
})

test('a review earning several classes parks the folder once', (t) => {
  const { r, xc } = setup(t, [A])
  folderReview(xc, { target: '.', head: 'h1', dispatch: review(xc, { claims: [claim('over'), claim('cant_tell')], findings: [critical] }), spec_path: 'S' })
  assert.deepEqual(events(r, 'parked').map((p) => p.return), ['integration_critical'])
})

test('a folder review with no stored return is a role fault on the folder, and records no claims', (t) => {
  const { r, xc } = setup(t, [A])
  const out = folderReview(xc, { target: '.', head: 'h1', dispatch: dispatchKey({ node: '.', role: 'reviewer', thread: 'integration:.:1', round: 1 }), spec_path: 'S' })
  assert.equal(out.status, 'held')
  assert.deepEqual(out.stops, [{ id: '.', status: 'held', reason: 'role', said: '' }])
  assert.deepEqual(state(r, 'fault').map((f) => [f.node, f.channel]), [['.', 'role']])
  assert.equal(events(r, 'claims').length, 0)
})

test('a folder review run twice records nothing twice and reports the same', (t) => {
  const { r, xc } = setup(t, [A])
  const args = { target: '.', head: 'h1', dispatch: review(xc, { claims: [drifting('under')] }), spec_path: 'S' }
  const first = folderReview(xc, args)
  assert.deepEqual(folderReview(xc, args), first)
  assert.equal(events(r, 'claims').length, 1)
  assert.equal(events(r, 'parked').length, 1)
})

test('a folder review of a node not in the tree throws', (t) => {
  const { xc } = setup(t, [A])
  assert.throws(() => folderReview(xc, { target: 'nope', head: 'h1', dispatch: review(xc, {}), spec_path: 'S' }), /no such node/)
})

// ---------------------------------------------------------------- a re-rule

const unit = (name) => ({ unit: name, ruling: 'clean', why: 'ruled' })
const PRIOR = {
  claims: [
    { claim: 'a', ruling: 'met' }, { claim: 'b', ruling: 'equivalent' }, { claim: 'c', ruling: 'accepted' },
    { claim: 'd', ruling: 'under', failure_scenario: 'it breaks' }, { claim: 'e', ruling: 'cant_tell' },
  ],
  head_sha: 'h1',
}

test('a re-rule keeps the prior claims it passed, replaces the ones the return restates and records rerule', (t) => {
  const { r, xc } = setup(t, [A])
  const dispatch = review(xc, {
    units: [unit('claim:4'), unit('claim:5'), unit('change')],
    claims: [{ ...claim('met', 'd as the spec now words it'), unit: 'claim:4' }, { ...claim('met', 'e as the spec now words it'), unit: 'claim:5' }, claim('met', 'b'), claim('met', 'a new claim')],
  })
  const out = folderReview(xc, { target: '.', head: 'h1', dispatch, spec_path: 'S', prior: PRIOR })

  assert.deepEqual(out.stops, [], 'every unit claim was ruled a pass')
  const [c] = events(r, 'claims')
  assert.equal(c.rerule, true)
  assert.deepEqual(c.claims.map((x) => [x.claim, x.ruling]), [
    ['a', 'met'], ['c', 'accepted'],
    ['d as the spec now words it', 'met'], ['e as the spec now words it', 'met'], ['b', 'met'], ['a new claim', 'met'],
  ])
  assert.equal(out.claims_n, 6)
})

test('a re-rule carries a prior claim whose unit the return did not rule, so it still parks', (t) => {
  const { r, xc } = setup(t, [A])
  const dispatch = review(xc, { units: [unit('claim:5'), unit('change')], claims: [{ ...claim('met', 'e as the spec now words it'), unit: 'claim:5' }] })
  const out = folderReview(xc, { target: '.', head: 'h1', dispatch, spec_path: 'S', prior: PRIOR })

  assert.deepEqual(out.stops.map((s) => s.reason), ['integration_critical'])
  const [c] = events(r, 'claims')
  assert.deepEqual(c.claims.filter((x) => x.ruling === 'under').map((x) => x.claim), ['d'], 'd was not ruled again: its last ruling stands')
  assert.ok(events(r, 'parked')[0].question.includes('[under] d'))
})

test('a prior open critical stays open until ruled fixed: a finding of another severity under its id does not close it', (t) => {
  const prior = { claims: [], head_sha: 'h1', open: [{ id: 'F1', claim: 'saves are lost', failure_scenario: 'a reload reads empty' }] }
  const cases = [
    ['a minor under the same id', { findings: [{ ...critical, severity: 'minor', claim: 'a name' }] }, ['F1'], 'saves are lost'],
    ['no ruling at all', {}, ['F1'], 'saves are lost'],
    ['the same critical again', { findings: [{ ...critical, claim: 'saves are still lost' }] }, ['F1'], 'saves are still lost'],
    ['ruled fixed', { fix_rulings: [{ id: 'F1', status: 'fixed', evidence: 'src/a.mjs:1' }] }, [], ''],
  ]
  for (const [what, value, ids, text] of cases) {
    const { r, xc } = setup(t, [A])
    const out = folderReview(xc, { target: '.', head: 'h1', dispatch: review(xc, value), spec_path: 'S', prior })
    const [c] = events(r, 'claims')
    assert.deepEqual(c.open.map((o) => o.id), ids, what)
    if (text) assert.equal(c.open[0].claim, text, what)
    assert.deepEqual(out.stops.map((s) => s.reason), ids.length ? ['integration_critical'] : [], what)
  }
})

test('over a moved head a prior pass nobody ruled again reads cant_tell; one ruled again is the return\'s', (t) => {
  const { r, xc } = setup(t, [A])
  const prior = { claims: [{ claim: 'saves round-trip', ruling: 'met' }, { claim: 'names match', ruling: 'met' }], head_sha: 'h0', open: [] }
  const dispatch = review(xc, { units: [unit('claim:2')], claims: [{ ...claim('met', 'names match as now worded'), unit: 'claim:2' }] })
  folderReview(xc, { target: '.', head: 'h1', dispatch, spec_path: 'S', prior })
  const [c] = events(r, 'claims')
  assert.deepEqual(c.claims.map((x) => [x.claim, x.ruling]), [['saves round-trip', 'cant_tell'], ['names match as now worded', 'met']])
})

test('a unit ruled in units but left out of claims restates nothing: its prior claim is carried', (t) => {
  const prior = { claims: [{ claim: 'names match', ruling: 'met' }, { claim: 'loads survive reload', ruling: 'under', failure_scenario: 'a reload reads empty' }], head_sha: 'h0', open: [] }
  const { r, xc } = setup(t, [A])
  const out = folderReview(xc, { target: '.', head: 'h1', dispatch: review(xc, { units: [unit('claim:1'), unit('claim:2')], claims: [] }), spec_path: 'S', prior })
  const [c] = events(r, 'claims')
  assert.deepEqual(c.claims.map((x) => [x.claim, x.ruling]), [['names match', 'cant_tell'], ['loads survive reload', 'under']])
  assert.deepEqual(out.stops.map((s) => s.reason), ['integration_critical'], 'the drift that parked still parks')
})

test('a review without a prior records the return as it is, and no rerule', (t) => {
  const { r, xc } = setup(t, [A])
  folderReview(xc, { target: '.', head: 'h1', dispatch: review(xc, { claims: [claim('met', 'only')] }), spec_path: 'S' })
  const [c] = events(r, 'claims')
  assert.deepEqual(c.claims.map((x) => x.claim), ['only'])
  assert.equal(c.rerule, undefined)
})

// ---------------------------------------------------------------- rule close

const TREE = [
  A,
  { id: 'p', kind: 'composite', title: 'planned', author: 'planner', decisions: ['D1'], acceptance: [{ text: 'p works', check: '', decisions: ['D1'] }] },
  leaf('p/x', { expects: ['src/x.mjs'] }),
  { id: 'u', kind: 'composite', title: 'the user\'s', decisions: ['D1'], acceptance: [{ text: 'u works', check: '', decisions: ['D1'] }] },
  leaf('u/y', { expects: ['src/y.mjs'] }),
]

/** A drift record as merge-batch writes it: the merged head and each consumer it drifted. */
function driftRecord(xc, drift) {
  const path = join(xc.dir, 'merges', 'm.json')
  writeJson(path, { target: '.', pre: 'p0', head_sha: 'h9', drift })
  return path
}

/** A stale record as preflight writes it: the base head now and the nodes it moved under. */
function staleRecord(xc, nodes) {
  const path = join(xc.dir, 'stale-b2.json')
  writeJson(path, { kind: 'stale', now: 'b2', nodes })
  return path
}

const drift = (node, contract = 'api') => ({ node, contract, files: ['src/api.mjs'] })

test('an unaffected drift ruling records drift-ruled with the ruler\'s why and said, and replans nothing', (t) => {
  const { r, xc } = setup(t, TREE)
  const dispatch = ruler(xc, [{ node: 'p/x', ruling: 'unaffected', why: 'it reads none of it', question: '' }])
  const out = ruleClose(xc, { kind: 'drift', record: driftRecord(xc, [drift('p/x'), drift('p/x', 'shape')]), dispatch })
  assert.deepEqual(out.replan, [])
  assert.deepEqual(out.stops, [])
  const ruled = state(r, 'drift-ruled')
  assert.deepEqual(ruled.map((e) => [e.node, e.contract, e.head_sha, e.ruling, e.why, e.said]),
    [['p/x', 'api', 'h9', 'unaffected', 'it reads none of it', dispatch], ['p/x', 'shape', 'h9', 'unaffected', 'it reads none of it', dispatch]])
})

test('an affected drift ruling on a node the planner writes hands it to the planner with the ruler\'s question', (t) => {
  const { r, xc } = setup(t, TREE)
  const dispatch = ruler(xc, [{ node: 'p', ruling: 'affected', why: 'the api moved', question: 'does p still hold?' }])
  const out = ruleClose(xc, { kind: 'drift', record: driftRecord(xc, [drift('p')]), dispatch })
  assert.deepEqual(out.replan, [{ id: 'p', question: 'does p still hold?' }])
  assert.deepEqual(out.stops, [])
  assert.deepEqual(state(r, 'drift-ruled').map((e) => [e.node, e.ruling, e.why]), [['p', 'affected', 'the api moved']])
})

test('an affected drift ruling on a folder the user wrote parks it needs_respec on its spec', (t) => {
  const { r, xc } = setup(t, TREE)
  const dispatch = ruler(xc, [{ node: 'u', ruling: 'affected', why: 'moved', question: 'does u hold?' }])
  const out = ruleClose(xc, { kind: 'drift', record: driftRecord(xc, [drift('u')]), dispatch })
  assert.deepEqual(out.replan, [])
  assert.deepEqual(out.stops, [{ id: 'u', status: 'parked', reason: 'needs_respec', said: dispatch }])
  assert.ok(events(r, 'parked')[0].question.includes(posix(specPath(r, E, 'u'))))
})

test('an affected ruling on a leaf with approved work standing parks contract_drift, never replans it', (t) => {
  const { r, xc } = setup(t, TREE)
  xc.log.append('approved', { node: 'a', head_sha: 'ha', review_rounds: 1, at_integration: false })
  const dispatch = ruler(xc, [{ node: 'a', ruling: 'affected', why: 'moved', question: 'does a hold?' }])
  const out = ruleClose(xc, { kind: 'drift', record: driftRecord(xc, [drift('a')]), dispatch })
  assert.deepEqual(out.replan, [])
  assert.deepEqual(out.stops, [{ id: 'a', status: 'parked', reason: 'contract_drift', said: dispatch }])
  assert.equal(events(r, 'parked')[0].question, 'does a hold?')
})

test('an affected ruling on a folder a running unit works under parks contract_drift', (t) => {
  const { xc } = setup(t, TREE)
  const dispatch = ruler(xc, [{ node: 'p', ruling: 'affected', why: 'moved', question: 'q' }])
  const out = ruleClose(xc, { kind: 'drift', record: driftRecord(xc, [drift('p')]), dispatch, running: ['leaf:p/x'] })
  assert.deepEqual(out.replan, [])
  assert.deepEqual(out.stops.map((s) => [s.id, s.reason]), [['p', 'contract_drift']])
})

test('a drifted consumer no ruling reached parks contract_drift, naming the files and the contract', (t) => {
  const { r, xc } = setup(t, TREE)
  const dispatch = ruler(xc, [{ node: 'p', ruling: 'unaffected', why: 'fine', question: '' }])
  const out = ruleClose(xc, { kind: 'drift', record: driftRecord(xc, [drift('p'), drift('p/x')]), dispatch })
  assert.deepEqual(out.stops.map((s) => [s.id, s.reason]), [['p/x', 'contract_drift']])
  const [p] = events(r, 'parked')
  assert.ok(p.question.includes('src/api.mjs') && p.question.includes('api'), p.question)
})

test('a consumer already stopped, or drift marked stopped, is left out of the ruling', (t) => {
  const { r, xc } = setup(t, TREE)
  xc.log.append('escalated', { node: 'p/x', reason: 'blocked', detail: '' })
  const dispatch = ruler(xc, [])
  const out = ruleClose(xc, { kind: 'drift', record: driftRecord(xc, [drift('p/x'), { ...drift('a'), stopped: 'escalated' }]), dispatch })
  assert.deepEqual(out, { replan: [], stops: [] })
  assert.equal(events(r, 'parked').length, 0)
})

test('a stale ruling records stale-ruled at the base head now, with the ruler\'s why and said', (t) => {
  const { r, xc } = setup(t, TREE)
  const dispatch = ruler(xc, [{ node: 'a', ruling: 'unaffected', why: 'untouched', question: '' }, { node: 'p/x', ruling: 'affected', why: 'moved', question: 'q' }])
  const out = ruleClose(xc, { kind: 'stale', record: staleRecord(xc, ['a', 'p/x']), dispatch })
  assert.deepEqual(out.replan, [{ id: 'p/x', question: 'q' }])
  assert.deepEqual(state(r, 'stale-ruled').map((e) => [e.node, e.base_now, e.ruling, e.why, e.said]),
    [['a', 'b2', 'unaffected', 'untouched', dispatch], ['p/x', 'b2', 'affected', 'moved', dispatch]])
})

test('an affected stale ruling on an approved leaf parks premise_mismatch', (t) => {
  const { xc } = setup(t, TREE)
  xc.log.append('approved', { node: 'a', head_sha: 'ha', review_rounds: 1, at_integration: false })
  const dispatch = ruler(xc, [{ node: 'a', ruling: 'affected', why: 'moved', question: 'q' }])
  const out = ruleClose(xc, { kind: 'stale', record: staleRecord(xc, ['a']), dispatch })
  assert.deepEqual(out.stops, [{ id: 'a', status: 'parked', reason: 'premise_mismatch', said: dispatch }])
})

test('a leaf the base moved under that no ruling reached is held on a role fault', (t) => {
  const { r, xc } = setup(t, TREE)
  const dispatch = ruler(xc, [{ node: 'a', ruling: 'unaffected', why: 'untouched', question: '' }])
  const out = ruleClose(xc, { kind: 'stale', record: staleRecord(xc, ['a', 'p/x']), dispatch })
  assert.deepEqual(out.stops, [{ id: 'p/x', status: 'held', reason: 'role', said: '' }])
  assert.deepEqual(state(r, 'fault').map((f) => [f.node, f.channel]), [['p/x', 'role']])
})

test('a ruler with no stored return holds every leaf of a moved base', (t) => {
  const { xc } = setup(t, TREE)
  const out = ruleClose(xc, { kind: 'stale', record: staleRecord(xc, ['a', 'p/x']), dispatch: dispatchKey({ node: '.', role: 'ruler', thread: 'ruler:stale:b2', round: 1 }) })
  assert.deepEqual(out.stops.map((s) => [s.id, s.status]), [['a', 'held'], ['p/x', 'held']])
})

test('a rule close run twice records nothing twice', (t) => {
  const { r, xc } = setup(t, TREE)
  const dispatch = ruler(xc, [{ node: 'p', ruling: 'affected', why: 'moved', question: 'q' }, { node: 'u', ruling: 'unaffected', why: 'fine', question: '' }])
  const args = { kind: 'drift', record: driftRecord(xc, [drift('p'), drift('u'), drift('a')]), dispatch }
  const first = ruleClose(xc, args)
  const second = ruleClose(xc, args)
  assert.deepEqual(second.replan, first.replan)
  assert.equal(state(r, 'drift-ruled').length, 2)
  assert.equal(events(r, 'parked').length, 1)
})

test('a consumer already parked is left out of the ruling', (t) => {
  const { r, xc } = setup(t, TREE)
  xc.log.append('parked', { node: 'p/x', return: 'cant_tell', question: 'q', said: '' })
  const dispatch = ruler(xc, [{ node: 'p/x', ruling: 'affected', why: 'moved', question: 'q2' }])
  const out = ruleClose(xc, { kind: 'drift', record: driftRecord(xc, [drift('p/x')]), dispatch })
  assert.deepEqual(out, { replan: [], stops: [] })
  assert.equal(state(r, 'drift-ruled').length, 0)
})

test('a ruling with no question hands the planner its why', (t) => {
  const { xc } = setup(t, TREE)
  const dispatch = ruler(xc, [{ node: 'p', ruling: 'affected', why: 'the api moved', question: '' }])
  const out = ruleClose(xc, { kind: 'drift', record: driftRecord(xc, [drift('p')]), dispatch })
  assert.deepEqual(out.replan, [{ id: 'p', question: 'the api moved' }])
})

test('a review whose call ended failed is not read, though its return was kept', (t) => {
  const { r, xc } = setup(t, [A])
  const dispatch = dispatchKey({ node: '.', role: 'reviewer', thread: 'integration:.:1', round: 1 })
  xc.log.append('dispatched', {
    dispatch, node: '.', round: 1, thread: 'integration:.:1', role: 'reviewer', model: 'opus', effort: 'medium', session: 's',
    brief_digest: 'd', brief_parts: {}, carries: [], pid: 1,
  })
  writeJson(returnPath(xc.dir, dispatch), { units: [], findings: [], fix_rulings: [], claims: [claim('met')], notes: '' })
  xc.log.append('returned', { dispatch, session: 's', status: 'watch_failed', cause: 'watch_failed', usage: null, cost_total: null, cost_usd: null, denials: [] })
  const out = folderReview(xc, { target: '.', head: 'h1', dispatch, spec_path: 'S' })
  assert.equal(out.status, 'held')
  assert.equal(events(r, 'claims').length, 0)
})
