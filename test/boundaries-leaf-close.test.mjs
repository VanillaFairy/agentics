// test/boundaries-leaf-close.test.mjs — lib/boundaries/leaf-close.mjs: what a leaf's close reads from a
// producer's stored return, what it commits, reverts, measures, writes and decides, and what it
// records, over real git and the real measurement.
//
// What is pinned here:
//
//   producerOutcome  (pure) the round's status — an auditor's return reads `done`, whatever it
//                    carries — and the outcome of each status, in the spec's order: held, park,
//                    escalation, route to the planner or park, needs_tests, declined,
//                    fix_without_commits, measure
//   leafClose        before measuring: a role fault, a park, a route, needs_tests and a decline
//                    answered with a message; on measure: a shell-less author's commit, the locus
//                    (revert, breach_reverted, needs_locus), series-done, the measurement through
//                    `measure`, the gotchas (a producer never establishes a command), the decision
//                    and the messages it records, the close record, and a close run again
//   recordCommands   the investigator's command gotchas, written and refused
//
// A close is never seeded by hand: every close record and every `breach_reverted` line comes from
// a `leafClose` call. Expected ids, shas, paths and keys are computed.
//
// Design: docs/DESIGN.md#boundaries.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { leafClose, producerOutcome, recordCommands } from '../lib/boundaries/leaf-close.mjs'
import { approved, escalated, executionContext, message, parked } from '../lib/boundaries/records.mjs'
import { commandsOf, gotchaId, listGotchas, writeGotcha } from '../lib/gotchas.mjs'
import { attach } from '../lib/integration.mjs'
import { executionLog, readLog } from '../lib/ledger.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { branchOf, closePath, executionDir, mkdirState, readJson, returnPath, worktreeOf } from '../lib/store.mjs'
import { normalizeNode } from '../lib/tree.mjs'
import { greenRoundRole } from '../lib/verdict.mjs'
import { A_TEST, COMMANDS, STAMP, git, leaf, repo, root } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const OTHER_STAMP = '20260926-120000'
const SLOW = { timeout: 180_000 }
const PASS = "node -e 'process.exit(0)'"
const FAIL = "node -e 'process.exit(1)'"
const posix = (p) => String(p).split('\\').join('/')

// ================================================================== producerOutcome (pure)

const node = (extra) => normalizeNode({ id: 'a', kind: 'leaf', title: 'do a', rigor: 'tdd', role: 'none', locus: ['src/a.mjs'], decisions: ['D1'], ...extra })
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

test("a test-author's return with no status holds the round", () => {
  assert.equal(po({ role: 'test-author', ret: { text: TEXT } }).next, 'held')
})

test("an auditor's return, which carries no status, is measured", () => {
  assert.equal(po({ leaf: AUDIT, role: 'auditor', ret: AUDITOR_RETURN }).next, 'measure')
})

test('an auditor that returned nothing holds the round', () => {
  assert.equal(po({ leaf: AUDIT, role: 'auditor', ret: null }).next, 'held')
})

test("an auditor's return is read the same with a status field as without one", () => {
  const at = (ret) => po({ leaf: AUDIT, role: 'auditor', round: 2, head_before: 'h1', head: 'h1', answering: 'needs_tests', red: 'r', ret })
  const without = at(AUDITOR_RETURN)
  assert.equal(without.next, 'measure')
  for (const status of ['needs_tests', 'blocked', 'declined', 'needs_decision', 'needs_locus']) {
    assert.deepEqual(at({ ...AUDITOR_RETURN, status }), without, status)
  }
})

test('a leaf with no producer is measured without a return', () => {
  assert.equal(po({ role: '', ret: null }).next, 'measure')
  assert.equal(po({ role: '', ret: { status: 'blocked', text: TEXT } }).next, 'measure', 'no return is read for a leaf with no producer')
})

test('done is measured', () => {
  assert.equal(po({ ret: { status: 'done', text: TEXT } }).next, 'measure')
})

test('done_with_concerns is measured', () => {
  assert.equal(po({ ret: { status: 'done_with_concerns', text: TEXT, concerns: ['c'] } }).next, 'measure')
})

test('blocked escalates, said the dispatch', () => {
  const out = po({ ret: { status: 'blocked', text: TEXT } })
  assert.equal(out.next, 'stop')
  assert.deepEqual(out.records, [escalated('a', 'blocked', '', 'd7')])
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

const ROUTED = ['needs_context', 'needs_locus', 'decompose', 'unsplittable', 'premise_mismatch']
const PATHS = ['src/helper.mjs', 'lib/other.mjs']
const routedReturn = (status) => ({ status, text: TEXT, ...(status === 'needs_locus' ? { needs_locus: { paths: PATHS, why: 'the source imports them' } } : {}) })

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

test('needs_locus parks the leaf needs_respec under a folder the user wrote, its paths the question', () => {
  const out = po({ author: 'you', ret: routedReturn('needs_locus') })
  assert.equal(out.next, 'route')
  assert.equal(out.to, 'park')
  assert.equal(out.records.length, 1)
  const [park] = out.records
  assert.equal(park.kind, 'parked')
  assert.equal(park.fields.node, 'a')
  assert.equal(park.fields.return, 'needs_respec')
  assert.equal(park.fields.said, 'd7')
  for (const path of PATHS) assert.ok(park.fields.question.includes(path), 'the question names ' + path)
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

test("an implementer's later round that moved nothing escalates fix_without_commits", () => {
  const out = po({ round: 2, head_before: 'h1', head: 'h1' })
  assert.equal(out.next, 'stop')
  assert.equal(out.records.length, 1)
  assert.equal(out.records[0].kind, 'escalated')
  assert.equal(out.records[0].fields.node, 'a')
  assert.equal(out.records[0].fields.reason, 'fix_without_commits')
  assert.equal(out.records[0].fields.said, 'd7')
})

test("an implementer's first round that moved nothing is measured", () => {
  assert.equal(po({ round: 1, head_before: 'h1', head: 'h1' }).next, 'measure')
})

test("a test-author's later round is measured though the head has not moved: its files are committed for it", () => {
  assert.equal(po({ leaf: GREEN, role: 'test-author', round: 2, red: 'r', head_before: 'h1', head: 'h1' }).next, 'measure')
})

test("an implementer's later round whose head moved, or with no head_before given, is measured", () => {
  assert.equal(po({ round: 2, head_before: 'h1', head: 'h2' }).next, 'measure')
  assert.equal(po({ round: 2, head_before: '', head: '' }).next, 'measure')
})

test("an earlier status in the order wins over fix_without_commits", () => {
  const still = { round: 2, head_before: 'h1', head: 'h1' }
  assert.deepEqual(po({ ...still, ret: { status: 'blocked', text: TEXT } }).records, [escalated('a', 'blocked', '', 'd7')])
  assert.deepEqual(po({ ...still, ret: { status: 'needs_tests', text: TEXT } }).records, [escalated('a', 'needs_tests', '', 'd7')])
  assert.equal(po({ ...still, author: 'planner', ret: routedReturn('decompose') }).next, 'route')
})

// ================================================================== a world to close in

/** A repository, a seeded tree, the branches an execution stands on, and the execution's context. */
function world(t, nodesOf, { commands = COMMANDS, stamp = STAMP } = {}) {
  const r = repo()
  t.after(() => { try { rmSync(r, { recursive: true, force: true, maxRetries: 3 }) } catch { /* a handle held on Windows */ } })
  const nodes = typeof nodesOf === 'function' ? nodesOf(r) : nodesOf
  const seeded = seedTree(r, E, nodes)
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems || seeded.error))
  const base = git(r, 'rev-parse', 'HEAD')
  git(r, 'branch', branchOf(E, '.'), base)
  for (const n of nodes) if (n.kind !== 'leaf' && n.id !== '.') git(r, 'branch', branchOf(E, n.id), base)
  const dir = executionDir(r, E, stamp)
  mkdirState(dir)
  writeFileSync(join(dir, 'execution.json'), JSON.stringify({ stamp, root: '.', base_branch: 'main', base_sha: base, ...(commands ? { commands } : {}) }))
  const xc = executionContext({ repo: r, effort: E, execution: stamp, log: executionLog(r, E, stamp) })
  return { r, xc, base, stamp }
}

/** A leaf opened: its branch cut at `from` (the base commit unless said) and attached at its worktree. */
function open(w, id, { from } = {}) {
  const branch = branchOf(E, id)
  git(w.r, 'branch', branch, from || w.base)
  const worktree = worktreeOf(w.r, E, id)
  const attached = attach(w.r, branch, worktree)
  assert.equal(attached.ok, true, attached.error)
  return { worktree, branch, base_sha: git(w.r, 'rev-parse', branch) }
}

/** A commit of `files` in a worktree, its sha. */
function commit(worktree, files, subject) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true })
    writeFileSync(join(worktree, path), text)
  }
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-q', '-m', subject)
  return git(worktree, 'rev-parse', 'HEAD')
}

const write = (worktree, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true })
    writeFileSync(join(worktree, path), text)
  }
}

/** An auditor's return as the host would accept it: the schema's keys only, its required ones present. */
function assertAuditorShape(ret) {
  const schema = schemaOf('auditor')
  for (const key of Object.keys(ret)) assert.ok(Object.hasOwn(schema.properties, key), 'an auditor never returns ' + key)
  for (const key of schema.required) assert.ok(Object.hasOwn(ret, key), 'an auditor always returns ' + key)
}

/**
 * A round as the runner leaves it: `dispatched` and, unless `returned` is false, `returned`, through
 * the execution's log, and the return written where the runner keeps it unless the test means none.
 */
function stored(w, { node: id, role, round = 1, thread = 'producer:' + id, ret, carries = [], dispatch, returned = 'returned', cause }) {
  const key = dispatch || 'd-' + id.replace(/[^A-Za-z0-9]/g, '-') + '-' + (role || 'none') + '-r' + round
  w.xc.log.append('dispatched', { dispatch: key, node: id, round, thread, role, model: 'sonnet', effort: 'medium', carries })
  if (returned) w.xc.log.append('returned', { dispatch: key, status: returned, ...(cause ? { cause } : {}) })
  if (ret !== undefined && ret !== null) {
    if (role === 'auditor') assertAuditorShape(ret)
    mkdirSync(dirname(returnPath(w.xc.dir, key)), { recursive: true })
    writeFileSync(returnPath(w.xc.dir, key), JSON.stringify(ret))
  }
  return key
}

/** `leafClose` over a round already stored. */
const close = (w, { node: id, role = 'implementer', round = 1, thread = 'producer:' + id, dispatch, base_sha = '', head_before = '', ports } = {}) =>
  leafClose(w.xc, { node: id, role, round, thread, dispatch, head_before, base_sha }, ports)

/** A round stored, then closed. */
async function run(w, spec) {
  const dispatch = stored(w, spec)
  const out = await close(w, { ...spec, dispatch })
  return { out, dispatch }
}

const logsOf = (w) => ({
  events: readLog(w.r, E, 'events').entries,
  state: readLog(w.r, E, 'state:' + w.stamp).entries,
  journal: readLog(w.r, E, 'journal:' + w.stamp).entries,
})
const recs = (w, kind, id) => {
  const l = logsOf(w)
  return [...l.events, ...l.state, ...l.journal].filter((e) => e.kind === kind && (id === undefined || e.node === id))
}
const msgs = (w, msg, id) => recs(w, 'message', id).filter((m) => m.msg === msg)
const sizes = (w) => { const l = logsOf(w); return [l.events.length, l.state.length, l.journal.length] }
const observed = (w, id) => recs(w, 'verify-observed', id)
const rec = (w, id, role, round) => readJson(closePath(w.r, E, w.stamp, id, role || 'none', round))
const head = (worktree) => git(worktree, 'rev-parse', 'HEAD')
const filesOf = (worktree, sha) => git(worktree, 'show', '--name-only', '--format=', sha).split('\n').filter(Boolean)
const subjectOf = (worktree, ref = 'HEAD') => git(worktree, 'log', '-1', '--format=%s', ref)
/** The close record's measurement as its stop reason, whether the record keeps the payload or only the reason. */
const stopOf = (record) => (typeof record.measurement === 'string' ? record.measurement : record.measurement && record.measurement.stop_reason)
const shapeOf = (out) => ({ next: out.decision.next, reason: out.decision.reason, failures: out.decision.failures.map((f) => f.check + ':' + f.claim) })
const claimsOf = (out) => out.decision.failures.map((f) => f.claim)

const DONE = { status: 'done', text: 'it is done' }
const A_SRC = 'export const a = () => 1\n'
const A_FILES = { 'test/a.test.mjs': A_TEST, 'src/a.mjs': A_SRC }
const MORE_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/add.mjs'\ntest('adds negatives', () => assert.equal(add(-1, -2), -3))\n"
const ADD_BITE = { file: 'src/add.mjs', find: 'a + b', replace: 'a - b', expect_failing: ['test/more.test.mjs'] }

const crit = (id, check = PASS) => [{ text: id + ' works', check, decisions: ['D1'] }]
const lf = (id, extra = {}) => leaf(id, { acceptance: crit(id), ...extra })
const planner = (id = 'c') => ({ id, kind: 'composite', title: id, author: 'planner', decisions: ['D1'] })

/** A tdd leaf `a` opened. */
function tdd(t, extra = {}) {
  const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'], ...extra })])
  return { w, o: open(w, 'a') }
}

/** A trivial leaf `a` over README.md, opened, its edit committed. */
function trivial(t, check = PASS) {
  const w = world(t, (r) => [root(), lf('a', { rigor: 'trivial', locus: ['README.md'], acceptance: crit('a', typeof check === 'function' ? check(r) : check) })])
  const o = open(w, 'a')
  commit(o.worktree, { 'README.md': 'hello\nmore\n' }, 'Edit the readme')
  return { w, o }
}

/** A tests-only leaf `t`, opened. */
function testsOnly(t, locus = ['test/more.test.mjs']) {
  const w = world(t, [root(), lf('t', { rigor: 'tests-only', locus })])
  return { w, o: open(w, 't') }
}

const R_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { r } from '../src/r.mjs'\ntest('doubles 2', () => assert.equal(r(2), 4))\n"
const R_TEST_TWO = R_TEST + "test('doubles 3', () => assert.equal(r(3), 6))\n"
const R_SRC = 'export const r = (x) => x * 2\n'
const TABLE = 'export const table = () => ({ capacity: 1 })\n'
const TABLE_LABELLED = "export const table = () => ({ capacity: 1, label: 'x' })\n"
const TABLE_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { table } from './table.mjs'\ntest('holds one letter', () => assert.equal(table().capacity, 1))\n"
const CAPACITY_BITE = { file: 'src/table.mjs', find: 'capacity: 1', replace: 'capacity: 2', expect_failing: ['src/table.test.mjs'] }
const R_BITES = { file: 'src/r.mjs', find: 'x * 2', replace: 'x * 3', expect_failing: ['test/r.test.mjs'] }
const R_SURVIVES = { file: 'src/r.mjs', find: 'x * 2', replace: 'x + 2', expect_failing: ['test/r.test.mjs'] }

/**
 * A cycle: the red's test committed on its branch and approved, the green cut from that head with its
 * implementation committed, and, when `triad`, an audit cut from the green's head.
 */
function cycle(t, { triad = false, greenLocus = ['src/r.mjs'], greenFiles = { 'src/r.mjs': R_SRC }, redTest = R_TEST } = {}) {
  const rigor = triad ? 'tdd-triad' : 'tdd-pair'
  const w = world(t, [root(),
    lf('r', { rigor, role: 'red', locus: ['test/r.test.mjs'] }),
    lf('g', { rigor, role: 'green', deps: ['r'], locus: greenLocus }),
    ...(triad ? [lf('au', { rigor, role: 'audit', deps: ['g'], locus: ['docs/audit.md'] })] : [])])
  const red = open(w, 'r')
  const redHead = commit(red.worktree, { 'test/r.test.mjs': redTest }, 'Pin r')
  const ok = approved('r', redHead, 1, false)
  w.xc.log.append(ok.kind, ok.fields)
  const green = open(w, 'g', { from: redHead })
  const greenHead = commit(green.worktree, greenFiles, 'Implement r')
  const audit = triad ? open(w, 'au', { from: greenHead }) : null
  return { w, red, redHead, green, greenHead, audit }
}

/** A message the round answered: its event, its seq. */
const answered = (w, { node: id, thread, msg, payload = {}, round, from = 'code' }) =>
  w.xc.log.append('message', { node: id, thread, from, msg, payload, round }).seq

/**
 * A leaf whose implementer committed work and a change outside its locus, under the user's folder or
 * a planner's. `work` is what the implementer committed beside the README edit.
 */
async function outside(t, { under = 'you', helper = false, failing = false, ret = DONE, noReadme = false } = {}) {
  const id = under === 'planner' ? 'c/a' : 'a'
  const w = world(t, [root(), ...(under === 'planner' ? [planner()] : []), lf(id, { locus: ['src/a.mjs', 'test/a.test.mjs'] })])
  const o = open(w, id)
  const src = helper ? "import { h } from './helper.mjs'\nexport const a = () => h()\n" : failing ? 'export const a = () => 2\n' : A_SRC
  const files = { ...A_FILES, 'src/a.mjs': src, ...(helper ? { 'src/helper.mjs': 'export const h = () => 1\n' } : {}), ...(noReadme || helper ? {} : { 'README.md': 'hello\nedited\n' }) }
  const pre = commit(o.worktree, files, 'Add a')
  const spec = { node: id, role: 'implementer', round: 1, ret, base_sha: o.base_sha, head_before: o.base_sha }
  const dispatch = stored(w, spec)
  const first = await close(w, { ...spec, dispatch })
  return { w, o, id, pre, spec, dispatch, first }
}

const gotcha = (trigger, extra = {}) => ({ kind: 'pitfall', roles: ['implementer'], paths: [], trigger, action: 'do it differently', evidence: { command: 'node x.mjs', output: 'boom' }, ...extra })
const command = (name, value) => ({ kind: 'command', roles: ['implementer', 'investigator'], paths: [], trigger: 'running ' + name, action: 'use it', evidence: { command: name, output: 'ok' }, command: { name, value } })
const absent = (name) => ({ ...command(name, ''), command: { name, value: '', absent: true } })
const ESTABLISHED = () => [absent('build'), absent('typecheck'), command('suite', COMMANDS.suite), command('test_one', COMMANDS.test_one)]
const establish = (w) => { for (const g of ESTABLISHED()) assert.equal(writeGotcha(w.r, E, g, { source: { role: 'investigator' } }).ok, true) }
const gotchaOf = (w, id) => listGotchas(w.r, E).find((g) => g.id === id)

// ================================================================== before measuring

describe('leaf-close before it measures', { concurrency: 4 }, () => {
  test('leafClose refuses a node that is not a leaf', SLOW, async (t) => {
    const { w } = tdd(t)
    await assert.rejects(async () => close(w, { node: '.', role: 'implementer', round: 1, dispatch: 'none' }))
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
    const w = world(t, [root(), planner(), lf('c/a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })])
    const o = open(w, 'c/a')
    const ret = { status: 'needs_locus', text: 'the source imports a helper', needs_locus: { paths: ['src/helper.mjs'], why: 'imported' } }
    const dispatch = stored(w, { node: 'c/a', role: 'implementer', round: 1, ret })
    const before = sizes(w)
    const out = await close(w, { node: 'c/a', role: 'implementer', round: 1, dispatch, base_sha: o.base_sha })
    assert.equal(out.decision.next, 'route')
    assert.equal(out.decision.reason, 'needs_locus')
    assert.equal(out.route.to, 'planner')
    assert.equal(out.route.folder, 'c')
    assert.equal(out.route.request.node, 'c/a')
    assert.equal(out.route.request.status, 'needs_locus')
    assert.equal(out.route.request.text, ret.text)
    assert.deepEqual(out.route.request.paths, ['src/helper.mjs'])
    assert.deepEqual(out.stops, [])
    assert.deepEqual(sizes(w), before, 'nothing recorded beyond the round\'s own dispatched and returned')
    assert.equal(rec(w, 'c/a', 'implementer', 1).status, 'needs_locus')
  })

  test('a route to the planner carries no paths when the producer named none', SLOW, async (t) => {
    const w = world(t, [root(), planner(), lf('c/a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })])
    const o = open(w, 'c/a')
    const { out } = await run(w, { node: 'c/a', role: 'implementer', round: 1, base_sha: o.base_sha, ret: { status: 'decompose', text: 'two jobs' } })
    assert.equal(out.decision.next, 'route')
    assert.equal(out.decision.reason, 'decompose')
    assert.deepEqual(out.route.request.paths, [])
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

  test('an implementer round that moved nothing is escalated fix_without_commits, said the dispatch, nothing measured', SLOW, async (t) => {
    const { w, o } = tdd(t)
    const first = commit(o.worktree, A_FILES, 'Add a')
    const { out, dispatch } = await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: first })
    assert.equal(out.decision.next, 'stop')
    assert.deepEqual(out.stops.map((s) => [s.id, s.status, s.reason, s.said]), [['a', 'escalated', 'fix_without_commits', dispatch]])
    assert.equal(observed(w, 'a').length, 0)
  })
})

// ================================================================== the locus

describe('leaf-close and the locus', { concurrency: 4 }, () => {
  test("a shell-less author's admitted files are committed and journalled authored", SLOW, async (t) => {
    const { w, o } = testsOnly(t)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST })
    const ret = { status: 'done', text: 'Cases: adds negatives.', commit: 'Test add with negatives', mutations: [ADD_BITE] }
    const { out } = await run(w, { node: 't', role: 'test-author', round: 1, ret, base_sha: o.base_sha })
    const tip = head(o.worktree)
    assert.equal(subjectOf(o.worktree), 'Test add with negatives')
    assert.deepEqual(filesOf(o.worktree, tip), ['test/more.test.mjs'])
    assert.equal(git(o.worktree, 'rev-list', '--count', o.base_sha + '..HEAD'), '1')
    const authored = recs(w, 'authored', 't')
    assert.equal(authored.length, 1)
    assert.deepEqual([authored[0].role, authored[0].round, authored[0].sha], ['test-author', 1, tip])
    assert.equal(rec(w, 't', 'test-author', 1).committed, tip)
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
    assert.deepEqual(recs(w, 'approved', 't').map((e) => e.head_sha), [tip])
  })

  test('a shell-less author whose locus is a directory has the files under it committed, none reverted', SLOW, async (t) => {
    const { w, o } = testsOnly(t, ['test/'])
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST })
    const ret = { status: 'done', text: 'Cases: adds negatives.', commit: 'Test add with negatives', mutations: [ADD_BITE] }
    const { out } = await run(w, { node: 't', role: 'test-author', round: 1, ret, base_sha: o.base_sha })
    assert.deepEqual(filesOf(o.worktree, head(o.worktree)), ['test/more.test.mjs'])
    assert.equal(recs(w, 'breach_reverted', 't').length, 0)
    assert.equal(rec(w, 't', 'test-author', 1).breach, null)
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
  })

  test("a shell-less author's files outside its locus are left out of its commit and taken out", SLOW, async (t) => {
    const { w, o } = testsOnly(t)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST, 'stray.txt': 'oops\n' })
    const ret = { status: 'done', text: 'Cases: adds negatives.', commit: 'Test add with negatives', mutations: [ADD_BITE] }
    await run(w, { node: 't', role: 'test-author', round: 1, ret, base_sha: o.base_sha })
    const authored = recs(w, 'authored', 't')
    assert.equal(authored.length, 1)
    assert.deepEqual(filesOf(o.worktree, authored[0].sha), ['test/more.test.mjs'], 'the stray file is not in the authored commit')
    assert.equal(existsSync(join(o.worktree, 'stray.txt')), false)
    assert.equal(git(o.worktree, 'ls-files', 'stray.txt'), '')
    const reverted = recs(w, 'breach_reverted', 't')
    assert.equal(reverted.length, 1)
    assert.deepEqual(reverted[0].paths, ['stray.txt'])
    const record = rec(w, 't', 'test-author', 1)
    assert.deepEqual(record.breach.paths, ['stray.txt'])
    assert.equal(record.breach.sha, reverted[0].sha)
    assert.equal(reverted[0].sha, head(o.worktree), 'the revert commit is the head')
  })

  test('a path outside the locus is reverted in a commit of its own and recorded breach_reverted', SLOW, async (t) => {
    const s = await outside(t)
    const tip = head(s.o.worktree)
    assert.equal(subjectOf(s.o.worktree), 'agentics: revert outside locus')
    assert.equal(git(s.o.worktree, 'show', 'HEAD:README.md'), git(s.o.worktree, 'show', s.o.base_sha + ':README.md'), 'the file is back to its base content')
    assert.equal(git(s.o.worktree, 'show', 'HEAD:src/a.mjs'), git(s.o.worktree, 'show', s.pre + ':src/a.mjs'), 'the work inside the locus stays')
    const reverted = recs(s.w, 'breach_reverted', 'a')
    assert.equal(reverted.length, 1)
    assert.deepEqual(reverted[0].paths, ['README.md'])
    assert.equal(reverted[0].sha, tip)
    const record = rec(s.w, 'a', 'implementer', 1)
    assert.deepEqual(record.breach.paths, ['README.md'])
    assert.equal(record.breach.sha, tip)
  })

  test('the head before the revert is measured as well as the head after it', SLOW, async (t) => {
    const s = await outside(t)
    const lines = observed(s.w, 'a')
    assert.ok(lines.some((l) => l.head_sha === s.pre), 'the head before the revert was measured')
    assert.ok(lines.some((l) => l.head_sha === head(s.o.worktree)), 'the reverted head was measured')
    assert.equal(rec(s.w, 'a', 'implementer', 1).breach.pre_sha, s.pre)
  })

  test('a breach whose reverted head still passes is no route: the leaf is decided on the reverted head', SLOW, async (t) => {
    const s = await outside(t)
    assert.equal(s.first.decision.next, 'approve', JSON.stringify(s.first.decision))
    assert.equal(s.first.route, undefined)
    assert.equal(recs(s.w, 'parked', 'a').length, 0)
    assert.deepEqual(recs(s.w, 'approved', 'a').map((e) => e.head_sha), [head(s.o.worktree)])
  })

  test('needs_locus parks the leaf needs_respec when the head before the revert passed and the reverted one fails, under a folder the user wrote', SLOW, async (t) => {
    const s = await outside(t, { helper: true })
    assert.deepEqual([s.first.decision.next, s.first.decision.reason], ['stop', 'needs_respec'])
    const parks = recs(s.w, 'parked', 'a')
    assert.equal(parks.length, 1)
    assert.equal(parks[0].return, 'needs_respec')
    assert.ok(parks[0].question.includes('src/helper.mjs'), 'the question names the helper')
    assert.equal(rec(s.w, 'a', 'implementer', 1).breach.pre_passed, true)
    assert.equal(s.first.route, undefined)
  })

  test("needs_locus goes to the folder's planner when the head before the revert passed and the reverted one fails, under a planner's folder", SLOW, async (t) => {
    const s = await outside(t, { helper: true, under: 'planner' })
    assert.equal(s.first.decision.next, 'route')
    assert.equal(s.first.route.to, 'planner')
    assert.equal(s.first.route.folder, 'c')
    assert.equal(s.first.route.request.node, 'c/a')
    assert.equal(s.first.route.request.status, 'needs_locus')
    assert.deepEqual(s.first.route.request.paths, ['src/helper.mjs'])
    assert.equal(recs(s.w, 'parked', 'c/a').length, 0)
  })

  test('no needs_locus when the head before the revert failed as well', SLOW, async (t) => {
    const s = await outside(t, { failing: true })
    assert.equal(s.first.decision.next, 'fix', JSON.stringify(s.first.decision))
    assert.equal(rec(s.w, 'a', 'implementer', 1).breach.pre_passed, false)
    assert.equal(recs(s.w, 'parked', 'a').length, 0)
    assert.equal(s.first.route, undefined)
  })

  test('a new test file another unmerged leaf holds is outside the locus and reverted', SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] }), lf('b', { rigor: 'tests-only', locus: ['test/extra.test.mjs'] })])
    const o = open(w, 'a')
    commit(o.worktree, { ...A_FILES, 'test/extra.test.mjs': A_TEST }, 'Add a')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    const reverted = recs(w, 'breach_reverted', 'a')
    assert.equal(reverted.length, 1)
    assert.ok(reverted[0].paths.includes('test/extra.test.mjs'))
  })

  test('a new test file beside a listed file nobody else holds is inside the locus', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, { ...A_FILES, 'test/extra.test.mjs': A_TEST }, 'Add a')
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(recs(w, 'breach_reverted', 'a').length, 0)
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
  })

  test("a green implementer's new test file is outside its locus and reverted", SLOW, async (t) => {
    const c = cycle(t, { greenFiles: { 'src/r.mjs': R_SRC, 'src/extra.test.mjs': "import { test } from 'node:test'\ntest('extra', () => {})\n" } })
    await run(c.w, { node: 'g', role: 'implementer', round: 1, ret: DONE, base_sha: c.green.base_sha, head_before: c.green.base_sha })
    const reverted = recs(c.w, 'breach_reverted', 'g')
    assert.equal(reverted.length, 1)
    assert.ok(reverted[0].paths.includes('src/extra.test.mjs'))
  })

  test('a test round commits a new test beside a cycle source and never the source', SLOW, async (t) => {
    const c = cycle(t, { greenLocus: ['src/r.mjs', 'src/table.mjs'], greenFiles: { 'src/r.mjs': R_SRC, 'src/table.mjs': TABLE } })
    write(c.green.worktree, { 'src/table.test.mjs': TABLE_TEST, 'src/table.mjs': 'export const table = () => ({ capacity: 9 })\n' })
    const ret = { status: 'done', text: 'pinned', commit: 'Pin the capacity', mutations: [CAPACITY_BITE] }
    const { out } = await run(c.w, { node: 'g', role: 'test-author', round: 2, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: c.greenHead })
    const authored = recs(c.w, 'authored', 'g')
    assert.equal(authored.length, 1)
    assert.deepEqual(filesOf(c.green.worktree, authored[0].sha), ['src/table.test.mjs'], 'the authored commit holds only the test')
    assert.equal(git(c.green.worktree, 'show', 'HEAD:src/table.mjs'), git(c.green.worktree, 'show', c.greenHead + ':src/table.mjs'), 'the source at the head is the green\'s')
    const line = observed(c.w, 'g').find((l) => l.head_sha === head(c.green.worktree))
    assert.ok(line, 'the head was measured')
    assert.deepEqual((line.series_findings || []).filter((f) => f.blocking), [])
    assert.equal(out.decision.next, 'review', JSON.stringify(out.decision))
  })

  test('a close run again after it took the stray files into a commit of their own takes them out as before', SLOW, async (t) => {
    const c = cycle(t, { greenLocus: ['src/r.mjs', 'src/table.mjs'], greenFiles: { 'src/r.mjs': R_SRC, 'src/table.mjs': TABLE } })
    commit(c.green.worktree, { 'src/table.mjs': 'export const table = () => ({ capacity: 9 })\n' }, 'agentics: outside locus')
    const ret = { status: 'done', text: 'nothing to add', mutations: [R_BITES] }
    await run(c.w, { node: 'g', role: 'test-author', round: 2, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: c.greenHead })
    assert.equal(subjectOf(c.green.worktree), 'agentics: revert outside locus')
    assert.equal(git(c.green.worktree, 'show', 'HEAD:src/table.mjs'), git(c.green.worktree, 'show', c.greenHead + ':src/table.mjs'), 'the source is the green\'s again')
    assert.ok(rec(c.w, 'g', 'test-author', 2).breach.paths.includes('src/table.mjs'))
  })

  test("a test round after the red's approval is measured against the red's approved tests", SLOW, async (t) => {
    const c = cycle(t, { redTest: R_TEST_TWO })
    write(c.green.worktree, { 'test/r.test.mjs': R_TEST })
    const ret = { status: 'done', text: 'trimmed', commit: 'Drop a case', mutations: [R_BITES] }
    const { out } = await run(c.w, { node: 'g', role: 'test-author', round: 2, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: c.greenHead })
    const line = observed(c.w, 'g').find((l) => l.head_sha === head(c.green.worktree))
    assert.ok(line, 'the head was measured')
    assert.ok((line.series_findings || []).some((f) => f.check === 'test-removed' && f.blocking), JSON.stringify(line.series_findings))
    assert.equal(out.decision.next, 'fix')
  })

  test('leaf-close never commits outside a linked worktree', SLOW, async (t) => {
    const { w, o } = testsOnly(t)
    // The worktree path exists but is no registered worktree: git -C would resolve to the user's repository.
    rmSync(o.worktree, { recursive: true, force: true })
    git(w.r, 'worktree', 'prune')
    mkdirSync(o.worktree, { recursive: true })
    writeFileSync(join(w.r, 'staged.txt'), "the user's staged work\n")
    git(w.r, 'add', 'staged.txt')
    const userHead = git(w.r, 'rev-parse', 'HEAD')
    const ret = { status: 'done', text: 'Cases.', commit: 'Test it', mutations: [ADD_BITE] }
    const { out } = await run(w, { node: 't', role: 'test-author', round: 1, ret, base_sha: userHead })
    assert.ok(out && out.decision, 'the close still decides')
    assert.equal(git(w.r, 'rev-parse', 'HEAD'), userHead, "the user's branch did not move")
    assert.equal(git(w.r, 'diff', '--cached', '--name-only'), 'staged.txt', "the user's staged work is still staged")
    assert.equal(recs(w, 'authored', 't').length, 0)
    const record = rec(w, 't', 'test-author', 1)
    assert.ok(Array.isArray(record.notes) && record.notes.length > 0, 'a note says why nothing was committed')
  })
})

// ================================================================== the series and the measurement

describe('leaf-close and the measurement', { concurrency: 4 }, () => {
  test('series-done is journalled from git when the producer said done', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, { 'test/a.test.mjs': A_TEST }, 'Add the test')
    commit(o.worktree, { 'src/a.mjs': A_SRC }, 'Add a')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    const done = recs(w, 'series-done', 'a')
    assert.equal(done.length, 1)
    assert.equal(done[0].branch, o.branch)
    assert.equal(done[0].head_sha, head(o.worktree))
    const expected = git(o.worktree, 'log', '--reverse', '--no-merges', '--format=%H%x09%s', o.base_sha + '..HEAD').split('\n')
      .map((l) => ({ sha: l.split('\t')[0], subject: l.split('\t')[1] }))
    assert.equal(expected.length, 2)
    assert.deepEqual(done[0].commits, expected, 'oldest first')
  })

  test('series-done is journalled when the producer said done_with_concerns', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: { status: 'done_with_concerns', text: 'done', concerns: ['slow'] }, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(recs(w, 'series-done', 'a').length, 1)
  })

  test("an auditor's round over commits of its branch journals series-done as a done round does", SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    write(c.audit.worktree, { 'docs/audit.md': 'the net holds\n' })
    const ret = { mutations: [R_BITES], units: [], text: 'audited' }
    await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret, base_sha: c.audit.base_sha })
    const tip = head(c.audit.worktree)
    const done = recs(c.w, 'series-done', 'au')
    assert.equal(done.length, 1)
    assert.equal(done[0].head_sha, tip)
    assert.deepEqual(done[0].commits.map((x) => x.sha), [tip])
  })

  test('the measurement is taken through measure, journalled with its key', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    const lines = observed(w, 'a')
    assert.equal(lines.length, 1)
    assert.match(lines[0].key, /^[0-9a-f]{8}$/)
    assert.equal(lines[0].head_sha, head(o.worktree))
    assert.equal(lines[0].producer, 'implementer')
    assert.equal(stopOf(rec(w, 'a', 'implementer', 1)), lines[0].stop_reason)
  })

  test('a second close at the same key measures nothing', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    let spawned = 0
    const ports = { spawn: (cmd, args, opts) => { spawned++; return spawn(cmd, args, opts) } }
    const spec = { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha, ports }
    const dispatch = stored(w, spec)
    const first = await close(w, { ...spec, dispatch })
    const after = spawned
    assert.ok(after > 0, 'the first close measured')
    const second = await close(w, { ...spec, dispatch })
    assert.equal(spawned, after, 'the second close spawned nothing')
    assert.equal(observed(w, 'a').length, 1)
    assert.deepEqual(shapeOf(second), shapeOf(first))
  })

  test("a green is measured on its red's tests: one that breaks them fails, and the failures go to the green's producer", SLOW, async (t) => {
    const c = cycle(t, { greenFiles: { 'src/r.mjs': 'export const r = (x) => x + 3\n' } })
    const { out } = await run(c.w, { node: 'g', role: 'implementer', round: 1, ret: DONE, base_sha: c.green.base_sha, head_before: c.green.base_sha })
    assert.equal(out.decision.next, 'fix', JSON.stringify(out.decision))
    const sent = msgs(c.w, 'failures', 'g')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:g')
    assert.equal(sent[0].round, 2)
    assert.equal(sent[0].payload.source, 'verification')
  })

  test('a user ref moved during the check is a checkout fault on the leaf', SLOW, async (t) => {
    const { w, o } = trivial(t, (r) => "git -C '" + posix(r) + "' branch moved-by-check")
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual([out.decision.next, out.decision.reason], ['stop', 'checkout'])
    const faults = recs(w, 'fault', 'a')
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'checkout')
    assert.deepEqual(out.stops, [{ id: 'a', status: 'held', reason: 'checkout', said: '' }])
  })

  test("a watch that cannot read the user's checkout is a checkout fault on the leaf", SLOW, async (t) => {
    const { w, o } = trivial(t)
    const ports = { watch: { before: () => { throw new Error('unreadable') }, after: () => ({ moved: [] }) } }
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha, ports })
    assert.deepEqual([out.decision.next, out.decision.reason], ['stop', 'checkout'])
    const faults = recs(w, 'fault', 'a')
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'checkout')
  })

  test('a measurement that could not be taken escalates the leaf by its error kind', SLOW, async (t) => {
    const { w, o } = trivial(t)
    const ports = { spawn: (cmd, args, opts) => spawn(process.execPath, ['-e', 'process.exit(3)'], opts) }
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha, ports })
    assert.deepEqual([out.decision.next, out.decision.reason], ['stop', 'measure_failed'])
    assert.equal(out.stops.length, 1)
    assert.deepEqual([out.stops[0].id, out.stops[0].status, out.stops[0].reason], ['a', 'escalated', 'measure_failed'])
  })

  test('an escalation the measurement decides is recorded with its reason and the failing claims', SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { locus: ['test/more.test.mjs'] })])
    const o = open(w, 'a')
    commit(o.worktree, { 'test/more.test.mjs': MORE_TEST }, 'Add a test of what exists')
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual([out.decision.next, out.decision.reason], ['stop', 'discriminator_undecidable'])
    assert.ok(out.decision.failures.length > 0)
    const events = recs(w, 'escalated', 'a')
    assert.equal(events.length, 1)
    assert.equal(events[0].reason, 'discriminator_undecidable')
    for (const claim of claimsOf(out)) assert.ok(events[0].detail.includes(claim), 'the detail holds ' + claim)
  })

  test("uncommitted work left in a shell producer's worktree is put back to the head before measuring", SLOW, async (t) => {
    const { w, o } = tdd(t)
    const tip = commit(o.worktree, A_FILES, 'Add a')
    write(o.worktree, { 'src/a.mjs': A_SRC + '// wip\n' })
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(git(o.worktree, 'status', '--porcelain'), '', 'the worktree is clean at the head')
    assert.equal(head(o.worktree), tip)
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
    assert.deepEqual(recs(w, 'approved', 'a').map((e) => e.head_sha), [tip])
    assert.ok(rec(w, 'a', 'implementer', 1).notes.some((n) => n.includes('src/a.mjs')), 'a note names the file')
  })
})

// ================================================================== the gotchas

describe('leaf-close and the gotchas', { concurrency: 4 }, () => {
  test('returned gotchas are written, observed at the head and sourced to the round', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    const g = gotcha('the helper is imported before it is built')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: { ...DONE, gotchas: [g] }, base_sha: o.base_sha, head_before: o.base_sha })
    const id = gotchaId(g)
    assert.deepEqual(rec(w, 'a', 'implementer', 1).gotchas_written, [id])
    const written = gotchaOf(w, id)
    assert.ok(written, 'the gotcha is on disk')
    assert.equal(written.observed_at, head(o.worktree))
    assert.deepEqual(written.source, { node: 'a', role: 'implementer' })
  })

  test('stale gotchas the return names are deleted', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    const here = gotcha('a trap that no longer holds')
    const gone = gotcha('a trap that was never written')
    assert.equal(writeGotcha(w.r, E, here, { source: { node: 'a', role: 'implementer' } }).ok, true)
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: { ...DONE, gotchas_stale: [gotchaId(here), gotchaId(gone)] }, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual(rec(w, 'a', 'implementer', 1).gotchas_deleted, [gotchaId(here)], 'only the id that had a file is listed')
    assert.equal(gotchaOf(w, gotchaId(here)), undefined)
  })

  test('a refused gotcha is noted on the close record and the others are written', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    const bad = gotcha('a trap with no proof', { evidence: { command: '', output: '' } })
    const good = gotcha('a trap with proof')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: { ...DONE, gotchas: [bad, good] }, base_sha: o.base_sha, head_before: o.base_sha })
    const record = rec(w, 'a', 'implementer', 1)
    assert.deepEqual(record.gotchas_written, [gotchaId(good)])
    assert.ok(record.notes.some((n) => /gotcha refused/.test(n)), 'a note says one was refused')
  })

  test("a producer's command gotchas are not written, a note names each, and its other gotchas are", SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })], { commands: null })
    const o = open(w, 'a')
    commit(o.worktree, A_FILES, 'Add a')
    establish(w)
    const before = JSON.stringify(gotchaOf(w, 'command-build') || null)
    const pit = gotcha('a pitfall beside the commands')
    const ret = { ...DONE, gotchas: [command('suite', 'echo not-the-suite'), command('build', 'make'), pit] }
    await run(w, { node: 'a', role: 'implementer', round: 1, ret, base_sha: o.base_sha, head_before: o.base_sha })
    const record = rec(w, 'a', 'implementer', 1)
    assert.deepEqual(record.gotchas_written, [gotchaId(pit)], 'the pitfall is the one entry')
    assert.ok(gotchaOf(w, gotchaId(pit)), 'the pitfall is on disk')
    assert.equal(gotchaOf(w, 'command-suite').source.role, 'investigator', 'the investigator keeps command-suite')
    assert.equal(commandsOf(w.r, E).suite, COMMANDS.suite)
    assert.equal(JSON.stringify(gotchaOf(w, 'command-build') || null), before, 'command-build is what it was before the round')
    assert.ok(record.notes.some((n) => n.includes('command-suite')))
    assert.ok(record.notes.some((n) => n.includes('command-build')))
  })

  test("a producer's stale id naming a command gotcha deletes nothing, and a note names it", SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })], { commands: null })
    const o = open(w, 'a')
    commit(o.worktree, A_FILES, 'Add a')
    establish(w)
    const pit = gotcha('a pitfall that went stale')
    assert.equal(writeGotcha(w.r, E, pit, { source: { node: 'a', role: 'implementer' } }).ok, true)
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: { ...DONE, gotchas_stale: ['command-suite', gotchaId(pit)] }, base_sha: o.base_sha, head_before: o.base_sha })
    const record = rec(w, 'a', 'implementer', 1)
    assert.deepEqual(record.gotchas_deleted, [gotchaId(pit)], 'only the pitfall went')
    assert.ok(gotchaOf(w, 'command-suite'), 'the command-suite file stays')
    assert.equal(commandsOf(w.r, E).suite, COMMANDS.suite)
    assert.ok(record.notes.some((n) => n.includes('command-suite')))
  })
})

// ================================================================== the decision

describe('leaf-close and the decision', { concurrency: 4 }, () => {
  test('a leaf measured green with no review of its own is approved at its head, reviewed at integration', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
    const ok = recs(w, 'approved', 'a')
    assert.equal(ok.length, 1)
    assert.equal(ok[0].head_sha, head(o.worktree))
    assert.equal(ok[0].at_integration, true)
  })

  test('a leaf measured green with a review of its own goes to review, nothing recorded', SLOW, async (t) => {
    const { w, o } = tdd(t, { provides: [{ name: 'api', paths: ['src/a.mjs'] }] })
    commit(o.worktree, A_FILES, 'Add a')
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(out.decision.next, 'review', JSON.stringify(out.decision))
    assert.equal(recs(w, 'approved', 'a').length, 0)
    assert.equal(recs(w, 'message', 'a').length, 0)
  })

  test("a failing measurement records failures to the producer's thread for the next round", SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, { ...A_FILES, 'src/a.mjs': 'export const a = () => 2\n' }, 'Add a')
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(out.decision.next, 'fix', JSON.stringify(out.decision))
    assert.ok(out.decision.failures.length > 0)
    const sent = msgs(w, 'failures', 'a')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:a')
    assert.equal(sent[0].from, 'code')
    assert.equal(sent[0].round, 2)
    assert.equal(sent[0].payload.source, 'verification')
    assert.deepEqual(sent[0].payload.failures, out.decision.failures)
  })

  test("the failures of a green's test round that failed only on what it wrote go back to the cycle's test session", SLOW, async (t) => {
    const c = cycle(t, { greenLocus: ['src/r.mjs', 'src/table.mjs'], greenFiles: { 'src/r.mjs': R_SRC, 'src/table.mjs': TABLE_LABELLED } })
    write(c.green.worktree, { 'src/table.test.mjs': TABLE_TEST })
    const unbitten = { file: 'src/table.mjs', find: "label: 'x'", replace: "label: 'y'", expect_failing: ['src/table.test.mjs'] }
    const ret = { status: 'done', text: 'pinned', commit: 'Pin the capacity', mutations: [unbitten] }
    const { out } = await run(c.w, { node: 'g', role: 'test-author', round: 2, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: c.greenHead })
    assert.equal(out.decision.next, 'fix', JSON.stringify(out.decision))
    const sent = msgs(c.w, 'failures', 'g')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:r')
    assert.equal(sent[0].round, 3)
    assert.equal(sent[0].from, 'code')
  })

  test("an audit's surviving mutation records surviving_mutations to the cycle's test session", SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    const ret = { mutations: [R_SURVIVES], units: [], text: 'x + 2 doubles 2 too' }
    const { out } = await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret, base_sha: c.audit.base_sha })
    assert.equal(out.decision.next, 'fix', JSON.stringify(out.decision))
    const sent = msgs(c.w, 'surviving_mutations', 'au')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:r')
    assert.equal(sent[0].round, 2)
    assert.equal(sent[0].from, 'code')
    assert.ok(sent[0].payload.mutations.some((m) => m.file === R_SURVIVES.file && m.find === R_SURVIVES.find && m.replace === R_SURVIVES.replace))
    assert.equal(msgs(c.w, 'failures', 'au').length, 0)
  })

  test('an audit is measured on every mutation an earlier round applied', SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    const first = { mutations: [R_SURVIVES], units: [], text: 'x + 2 doubles 2 too' }
    await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret: first, base_sha: c.audit.base_sha })
    const easy = { file: 'src/r.mjs', find: '(x) =>', replace: '() =>', expect_failing: ['test/r.test.mjs'] }
    const { out } = await run(c.w, { node: 'au', role: 'test-author', round: 2, thread: 'producer:r', ret: { status: 'done', text: 'tried another', mutations: [easy] }, base_sha: c.audit.base_sha })
    assert.equal(out.decision.next, 'fix', 'the surviving mutation is still measured, so dropping it does not pass')
    const latest = observed(c.w, 'au').at(-1)
    const survivor = latest.mutations.find((m) => m.find === R_SURVIVES.find)
    assert.ok(survivor && survivor.applied && !survivor.bites, 'the earlier mutation is measured again and still gets through')
    assert.ok(latest.mutations.some((m) => m.find === easy.find), 'and so is the new one')
  })

  test("an auditor's round, whose return has no status, is measured and closes as done", SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    const ret = { mutations: [R_BITES], units: [], text: 'the net holds' }
    const { out } = await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret, base_sha: c.audit.base_sha })
    assert.equal(observed(c.w, 'au').length, 1, 'measured once')
    const line = observed(c.w, 'au')[0]
    assert.ok(line.mutations[0].applied && line.mutations[0].bites)
    assert.equal(recs(c.w, 'fault', 'au').length, 0)
    assert.equal(rec(c.w, 'au', 'auditor', 1).status, 'done')
    assert.equal(out.decision.next, 'review', JSON.stringify(out.decision))
  })

  /** A green's test round carrying `msg`, that adds a biting test. */
  async function testRoundAnswering(t, msg) {
    const c = cycle(t, { greenLocus: ['src/r.mjs', 'src/table.mjs'], greenFiles: { 'src/r.mjs': R_SRC, 'src/table.mjs': TABLE } })
    const seq = answered(c.w, { node: 'g', thread: 'producer:r', msg, payload: msg === 'needs_tests' ? { text: 'pin it' } : { findings: [] }, round: 3, from: msg === 'needs_tests' ? 'implementer' : 'code' })
    write(c.green.worktree, { 'src/table.test.mjs': TABLE_TEST })
    const ret = { status: 'done', text: 'pinned', commit: 'Pin the capacity', mutations: [CAPACITY_BITE] }
    const { out } = await run(c.w, { node: 'g', role: 'test-author', round: 3, thread: 'producer:r', ret, carries: [seq], base_sha: c.green.base_sha, head_before: c.greenHead })
    return { c, out }
  }

  test('a test round answering needs_tests, measured, records tests_ready with its test files to the implementer', SLOW, async (t) => {
    const { c, out } = await testRoundAnswering(t, 'needs_tests')
    assert.equal(rec(c.w, 'g', 'test-author', 3).answering, 'needs_tests')
    assert.equal(out.decision.next, 'review', JSON.stringify(out.decision))
    const ready = msgs(c.w, 'tests_ready', 'g')
    assert.equal(ready.length, 1)
    assert.equal(ready[0].thread, 'producer:g')
    assert.equal(ready[0].round, 4)
    assert.equal(ready[0].from, 'code')
    assert.deepEqual(ready[0].payload.files, ['src/table.test.mjs'])
  })

  test('a test round answering anything else records no tests_ready', SLOW, async (t) => {
    const { c } = await testRoundAnswering(t, 'findings')
    assert.equal(rec(c.w, 'g', 'test-author', 3).answering, 'findings')
    assert.equal(msgs(c.w, 'tests_ready', 'g').length, 0)
  })

  /** A leaf whose two criteria are decided by files the implementer commits. */
  function twoChecks(t) {
    const ok1 = 'node -e "process.exit(require(\'fs\').existsSync(\'ok1.txt\')?0:1)"'
    const bad2 = 'node -e "process.exit(require(\'fs\').existsSync(\'bad2.txt\')?1:0)"'
    const w = world(t, [root(), lf('a', {
      locus: ['src/a.mjs', 'test/a.test.mjs', 'ok1.txt', 'bad2.txt'],
      acceptance: [{ text: 'ok1 exists', check: ok1, decisions: ['D1'] }, { text: 'bad2 is absent', check: bad2, decisions: ['D1'] }],
    })])
    return { w, o: open(w, 'a') }
  }

  test('a close raises when every failure key of the previous close fails again', SLOW, async (t) => {
    const { w, o } = twoChecks(t)
    const one = commit(o.worktree, A_FILES, 'Add a')
    const first = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(first.out.decision.next, 'fix', JSON.stringify(first.out.decision))
    assert.equal(first.out.raise, false)
    assert.equal(rec(w, 'a', 'implementer', 1).raise, false)
    commit(o.worktree, { 'bad2.txt': 'x\n' }, 'Break the second')
    const second = await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: one })
    assert.equal(second.out.decision.next, 'fix', JSON.stringify(second.out.decision))
    assert.ok(claimsOf(second.out).length > claimsOf(first.out).length, 'round 2 keeps the failure and adds one')
    assert.equal(second.out.raise, true)
    assert.equal(rec(w, 'a', 'implementer', 2).raise, true)
  })

  test('a close does not raise when one failure of the previous close cleared', SLOW, async (t) => {
    const { w, o } = twoChecks(t)
    const one = commit(o.worktree, A_FILES, 'Add a')
    const first = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(first.out.decision.next, 'fix', JSON.stringify(first.out.decision))
    commit(o.worktree, { 'ok1.txt': 'x\n', 'bad2.txt': 'x\n' }, 'Clear the first, break the second')
    const second = await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: one })
    assert.equal(second.out.decision.next, 'fix', JSON.stringify(second.out.decision))
    assert.equal(second.out.raise, false)
    assert.equal(rec(w, 'a', 'implementer', 2).raise, false)
  })

  test('two consecutive closes failing identically at a moved head escalate verify_not_converging', SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'], acceptance: crit('a', FAIL) })])
    const o = open(w, 'a')
    const one = commit(o.worktree, A_FILES, 'Add a')
    const first = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(first.out.decision.next, 'fix', JSON.stringify(first.out.decision))
    commit(o.worktree, { 'src/a.mjs': A_SRC + '// second try\n' }, 'Try again')
    const second = await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: one })
    assert.deepEqual([second.out.decision.next, second.out.decision.reason], ['stop', 'verify_not_converging'])
    assert.equal(second.out.stops.length, 1)
    assert.deepEqual([second.out.stops[0].id, second.out.stops[0].status, second.out.stops[0].reason], ['a', 'escalated', 'verify_not_converging'])
    assert.equal(recs(w, 'escalated', 'a').filter((e) => e.reason === 'verify_not_converging').length, 1)
  })

  /** A leaf with no commands anywhere, its first close done. */
  async function unknownCommands(t) {
    const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })], { commands: null })
    const o = open(w, 'a')
    commit(o.worktree, A_FILES, 'Add a')
    const spec = { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha }
    const dispatch = stored(w, spec)
    const first = await close(w, { ...spec, dispatch })
    return { w, spec, dispatch, first, again: () => close(w, { ...spec, dispatch }) }
  }

  const escalations = (w) => recs(w, 'escalated', 'a').filter((e) => e.reason === 'command_unknown')

  test('command_unknown is handed back while no investigator was dispatched in this execution', SLOW, async (t) => {
    const s = await unknownCommands(t)
    assert.equal(s.first.decision.next, 'command_unknown')
    assert.deepEqual(s.first.stops, [])
    assert.equal(escalations(s.w).length, 0)
  })

  test('command_unknown escalates once the investigator dispatched in this execution has returned', SLOW, async (t) => {
    const s = await unknownCommands(t)
    stored(s.w, { node: 'a', role: 'investigator', round: 1, thread: 'investigator', dispatch: 'inv-1' })
    const out = await s.again()
    assert.deepEqual([out.decision.next, out.decision.reason], ['stop', 'command_unknown'])
    assert.deepEqual(out.stops.map((x) => [x.id, x.status, x.reason]), [['a', 'escalated', 'command_unknown']])
    assert.equal(escalations(s.w).length, 1)
  })

  test('command_unknown is handed back while the investigator dispatched in this execution has not returned', SLOW, async (t) => {
    const s = await unknownCommands(t)
    stored(s.w, { node: 'a', role: 'investigator', round: 1, thread: 'investigator', dispatch: 'inv-1', returned: false })
    const out = await s.again()
    assert.equal(out.decision.next, 'command_unknown')
    assert.deepEqual(out.stops, [])
    assert.equal(escalations(s.w).length, 0)
  })

  test('command_unknown is handed back when the investigator dispatched in this execution failed', SLOW, async (t) => {
    const s = await unknownCommands(t)
    stored(s.w, { node: 'a', role: 'investigator', round: 1, thread: 'investigator', dispatch: 'inv-1', returned: 'failed', cause: 'host_error' })
    const out = await s.again()
    assert.equal(out.decision.next, 'command_unknown')
    assert.deepEqual(out.stops, [])
    assert.equal(escalations(s.w).length, 0)
  })

  test('command_unknown is handed back when only another execution has an investigator that returned', SLOW, async (t) => {
    const s = await unknownCommands(t)
    const other = executionLog(s.w.r, E, OTHER_STAMP)
    other.append('dispatched', { dispatch: 'inv-other', node: 'a', round: 1, thread: 'investigator', role: 'investigator', model: 'sonnet', effort: 'medium', carries: [] })
    other.append('returned', { dispatch: 'inv-other', status: 'returned' })
    const out = await s.again()
    assert.equal(out.decision.next, 'command_unknown')
    assert.equal(escalations(s.w).length, 0)
  })

  /** A verify leaf `v` whose one check fails, under the root or a planner's folder. */
  async function verifyLeaf(t, id) {
    const w = world(t, [root(), ...(id === 'c/v' ? [planner()] : []), lf(id, { rigor: 'verify', locus: [], acceptance: crit(id, FAIL) })])
    const o = open(w, id)
    const out = await close(w, { node: id, role: '', round: 1, thread: '', dispatch: '', base_sha: o.base_sha })
    return { w, out }
  }

  test("a verify leaf's failing check escalates verify_finding and parks the folder the user wrote needs_respec", SLOW, async (t) => {
    const { w, out } = await verifyLeaf(t, 'v')
    assert.equal(out.decision.next, 'stop')
    const found = recs(w, 'escalated', 'v')
    assert.equal(found.length, 1)
    assert.equal(found[0].reason, 'verify_finding')
    const parks = recs(w, 'parked', '.')
    assert.equal(parks.length, 1)
    assert.equal(parks[0].return, 'needs_respec')
  })

  test("a verify leaf's failing check under a planner's folder routes the folder to its planner", SLOW, async (t) => {
    const { w, out } = await verifyLeaf(t, 'c/v')
    assert.equal(out.decision.next, 'route')
    assert.equal(out.route.folder, 'c')
    assert.equal(out.route.request.status, 'verify_finding')
    assert.equal(out.route.request.node, 'c/v')
    assert.equal(recs(w, 'parked', 'c').length, 0)
    assert.equal(recs(w, 'escalated', 'c/v').filter((e) => e.reason === 'verify_finding').length, 1)
  })
})

// ================================================================== recordCommands

describe('recordCommands', { concurrency: 4 }, () => {
  test("recordCommands writes the investigator's command gotchas, and the next close measures with them", SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })], { commands: null })
    const o = open(w, 'a')
    commit(o.worktree, A_FILES, 'Add a')
    const spec = { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha }
    const dispatch = stored(w, spec)
    assert.equal((await close(w, { ...spec, dispatch })).decision.next, 'command_unknown')

    const commands = ESTABLISHED()
    const inv = stored(w, { node: 'a', role: 'investigator', round: 1, thread: 'investigator', dispatch: 'inv-1', ret: { commands, established: ['suite', 'test_one'], unresolved: [], text: 'found them' } })
    const result = recordCommands(w.xc, { dispatch: inv })
    assert.deepEqual([...result.written].sort(), commands.map(gotchaId).sort())
    assert.deepEqual(result.unresolved, [])
    assert.equal(commandsOf(w.r, E).suite, COMMANDS.suite)
    for (const id of result.written) assert.equal(gotchaOf(w, id).source.role, 'investigator')
    const out = await close(w, { ...spec, dispatch })
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
  })

  test('recordCommands reports what the investigator left unresolved and every command refused', SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })], { commands: null })
    const refused = { ...command('suite', 'node --test'), evidence: { command: '', output: '' } }
    const inv = stored(w, { node: 'a', role: 'investigator', round: 1, thread: 'investigator', dispatch: 'inv-1', ret: { commands: [refused], established: [], unresolved: ['typecheck'], text: 'could not find them' } })
    const result = recordCommands(w.xc, { dispatch: inv })
    assert.deepEqual(result.written, [])
    assert.ok(result.unresolved[0].startsWith('typecheck'), 'the return\'s own unresolved come first')
    assert.ok(result.unresolved.some((u) => u.startsWith('suite:')), 'a refusal is `<command name>: <refusal>`')
    assert.deepEqual(commandsOf(w.r, E).suite, '')
  })

  test('recordCommands with no stored return writes nothing and says so', SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })], { commands: null })
    const inv = stored(w, { node: 'a', role: 'investigator', round: 1, thread: 'investigator', dispatch: 'inv-1' })
    const result = recordCommands(w.xc, { dispatch: inv })
    assert.deepEqual(result.written, [])
    assert.equal(result.unresolved.length, 1)
    assert.equal(listGotchas(w.r, E).length, 0)
  })
})

// ================================================================== the close record, and a close run again

describe('leaf-close record and a close run again', { concurrency: 4 }, () => {
  test('the close record holds the round, its measurement, its decision and what the close did', SLOW, async (t) => {
    const g = gotcha('a trap met on the way')
    const s = await outside(t, { ret: { ...DONE, gotchas: [g] } })
    const record = rec(s.w, 'a', 'implementer', 1)
    assert.equal(record.node, 'a')
    assert.equal(record.role, 'implementer')
    assert.equal(record.round, 1)
    assert.equal(record.thread, 'producer:a')
    assert.equal(record.dispatch, s.dispatch)
    assert.equal(record.status, 'done')
    assert.equal(record.answering, '')
    assert.equal(record.head_sha, head(s.o.worktree))
    assert.equal(stopOf(record), 'completed')
    assert.deepEqual([record.decision.next, record.decision.reason], [s.first.decision.next, s.first.decision.reason])
    assert.equal(typeof record.raise, 'boolean')
    assert.deepEqual(record.breach.paths, ['README.md'])
    assert.deepEqual(record.gotchas_written, [gotchaId(g)])
    assert.deepEqual(record.gotchas_deleted, [])
    assert.equal(record.committed, '')
    assert.ok(Array.isArray(record.notes))
  })

  test('a close run twice records nothing twice and commits nothing twice', SLOW, async (t) => {
    const { w, o } = testsOnly(t)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST, 'stray.txt': 'oops\n' })
    const ret = { status: 'done', text: 'Cases.', commit: 'Test add with negatives', mutations: [ADD_BITE] }
    const spec = { node: 't', role: 'test-author', round: 1, ret, base_sha: o.base_sha }
    const dispatch = stored(w, spec)
    const first = await close(w, { ...spec, dispatch })
    const tip = head(o.worktree)
    const [commits, size] = [git(o.worktree, 'rev-list', '--count', 'HEAD'), sizes(w)]
    const second = await close(w, { ...spec, dispatch })
    assert.deepEqual(sizes(w), size, 'the second close added no event, state or journal line')
    assert.equal(head(o.worktree), tip, 'and left the head where it was')
    assert.equal(git(o.worktree, 'rev-list', '--count', 'HEAD'), commits)
    assert.deepEqual(shapeOf(second), shapeOf(first))
  })

  test('a failing close run twice records its failures message once', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, { ...A_FILES, 'src/a.mjs': 'export const a = () => 2\n' }, 'Add a')
    const spec = { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha }
    const dispatch = stored(w, spec)
    const first = await close(w, { ...spec, dispatch })
    const second = await close(w, { ...spec, dispatch })
    assert.equal(first.decision.next, 'fix', JSON.stringify(first.decision))
    assert.equal(msgs(w, 'failures', 'a').length, 1)
    assert.deepEqual(shapeOf(second), shapeOf(first))
  })

  test('a close run again after its revert reads the breach back and decides as before', SLOW, async (t) => {
    const s = await outside(t, { helper: true })
    const breach = rec(s.w, 'a', 'implementer', 1).breach
    assert.ok(breach && breach.paths.includes('src/helper.mjs'))
    const second = await close(s.w, { ...s.spec, dispatch: s.dispatch })
    assert.deepEqual(shapeOf(second), shapeOf(s.first))
    assert.deepEqual([second.decision.next, second.decision.reason], ['stop', 'needs_respec'])
    assert.deepEqual(rec(s.w, 'a', 'implementer', 1).breach, breach)
    assert.equal(recs(s.w, 'parked', 'a').length, 1)
    assert.equal(recs(s.w, 'breach_reverted', 'a').length, 1)
  })
})
