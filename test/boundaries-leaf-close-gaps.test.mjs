// test/boundaries-leaf-close-gaps.test.mjs — lib/boundaries/leaf-close.mjs where the first two test
// files leave a path open: a close run again after a kill or in a later execution, what a killed
// verify leaves in a worktree, the decisions D1-D4, and the sites those files do not guard. Every
// close here is a `leafClose` call over real git and the real measurement; expected ids, shas,
// paths and keys are computed.
//
// What is pinned here, by the gap it closes:
//
//   G1   a close run again after a kill between a shell-less author's commit and its `authored` line
//   G2   what a killed verify leaves (a file rewritten in place, a detached HEAD, kept work), and
//        what verify notes so a close can tell it from the round's work
//   G3   [D1] a decline of a round that carried `needs_tests` and findings
//   G4   the measurement before a revert is never read as the round's
//   G5   [D2] an implementer's `needs_tests` is answered by the test round that finally measures
//   G6   [D3] a verify finding under a planner's folder
//   G7   the previous close and the breach record across executions
//   G8   [D4] held mutations and the audit gap across executions
//   G9   only this round's `agentics:` commits are read back
//   G10  a staged rename
//   G11-G17  what a round answered, the pick order of commands, locus admission, the pre-revert
//        measurement's own outcomes, the series and `committed`, the next round's messages and the
//        raise, and `recordCommands`
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#verification.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { leafClose, recordCommands } from '../lib/boundaries/leaf-close.mjs'
import { approved, executionContext } from '../lib/boundaries/records.mjs'
import { gotchaId, listGotchas, writeGotcha } from '../lib/gotchas.mjs'
import { attach } from '../lib/integration.mjs'
import { executionLog, readLog } from '../lib/ledger.mjs'
import { branchOf, closePath, executionDir, mkdirState, readJson, returnPath, worktreeOf } from '../lib/store.mjs'
import { addNodes, readTree } from '../lib/tree.mjs'
import { verify } from '../lib/verify.mjs'
import { A_TEST, COMMANDS, STAMP, git, leaf, repo, root } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { WIDGET_TEST, cycle as verifyCycle, git as plainGit, mutations as mutationFlags, options as verifyOptions } from './harness/verify-fixture.mjs'

const E = 'e1'
const OTHER_STAMP = '20260926-120000'
const SLOW = { timeout: 180_000 }
const PASS = "node -e 'process.exit(0)'"
const FAIL = "node -e 'process.exit(1)'"
const NOTE = 'agentics-verify-rewriting'
const KEPT = 'refs/worktree/agentics-verify/'
const OUTSIDE = 'agentics: outside locus'
const REVERT = 'agentics: revert outside locus'
const posix = (p) => String(p).split('\\').join('/')
const lf = (text) => String(text).replace(/\r\n/g, '\n')

// ================================================================== a world to close in

/** A scenario built once and read by several tests; its repositories go when its group ends. */
function scenario(build) {
  const cleanups = []
  let built
  return {
    get: () => (built ??= build({ after: (fn) => cleanups.push(fn) })),
    end: () => { for (const fn of cleanups) fn() },
  }
}

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

/** The same world under a later execution: its own directory, envelope, log and context. */
function elsewhere(w, stamp = OTHER_STAMP) {
  const dir = executionDir(w.r, E, stamp)
  mkdirState(dir)
  writeFileSync(join(dir, 'execution.json'), JSON.stringify({ stamp, root: '.', base_branch: 'main', base_sha: w.base, commands: COMMANDS }))
  return { ...w, stamp, xc: executionContext({ repo: w.r, effort: E, execution: stamp, log: executionLog(w.r, E, stamp) }) }
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

const write = (worktree, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true })
    writeFileSync(join(worktree, path), text)
  }
}

/** A commit of `files` in a worktree, its sha. */
function commit(worktree, files, subject) {
  write(worktree, files)
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-q', '-m', subject)
  return git(worktree, 'rev-parse', 'HEAD')
}

/** An auditor's return as the host would accept it: the schema's keys only. */
const auditor = (mutations, text = 'looked at it') => ({ mutations, units: [], text })

/**
 * A round as the runner leaves it: `dispatched` and `returned` through the execution's log, and the
 * return written where the runner keeps it unless the test means none.
 */
function stored(w, { node: id, role, round = 1, thread = 'producer:' + id, ret, carries = [], dispatch, returned = 'returned' }) {
  const key = dispatch || 'd-' + id.replace(/[^A-Za-z0-9]/g, '-') + '-' + (role || 'none') + '-r' + round
  w.xc.log.append('dispatched', { dispatch: key, node: id, round, thread, role, model: 'sonnet', effort: 'medium', carries })
  if (returned) w.xc.log.append('returned', { dispatch: key, status: returned })
  if (ret !== undefined && ret !== null) {
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
const observed = (w, id) => recs(w, 'verify-observed', id)
const rec = (w, id, role, round) => readJson(closePath(w.r, E, w.stamp, id, role || 'none', round))
const head = (worktree) => git(worktree, 'rev-parse', 'HEAD')
const filesOf = (worktree, sha) => git(worktree, 'show', '--name-only', '--format=', sha).split('\n').filter(Boolean)
const subjectsOver = (worktree, from) => git(worktree, 'log', '--format=%s', from + '..HEAD').split('\n').filter(Boolean)
const holds = (worktree, ref) => spawnSync('git', ['-C', worktree, 'cat-file', '-e', ref], { encoding: 'utf8' }).status === 0
const isAncestor = (worktree, ancestor, of) => spawnSync('git', ['-C', worktree, 'merge-base', '--is-ancestor', ancestor, of], { encoding: 'utf8' }).status === 0
const shown = (worktree, ref) => lf(spawnSync('git', ['-C', worktree, 'show', ref], { encoding: 'utf8' }).stdout)
const text = (worktree, path) => lf(readFileSync(join(worktree, path), 'utf8'))
const claimsOf = (out) => out.decision.failures.map((f) => f.claim)

const DONE = { status: 'done', text: 'it is done' }
const A_SRC = 'export const a = () => 1\n'
const A_FILES = { 'test/a.test.mjs': A_TEST, 'src/a.mjs': A_SRC }
const MORE_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/add.mjs'\ntest('adds negatives', () => assert.equal(add(-1, -2), -3))\n"
const ADD_BITE = { file: 'src/add.mjs', find: 'a + b', replace: 'a - b', expect_failing: ['test/more.test.mjs'] }
const ADD_SURVIVES = { file: 'src/add.mjs', find: 'a + b', replace: 'b + a', expect_failing: ['test/more.test.mjs'] }
const ADD_BITE_TOO = { file: 'src/add.mjs', find: 'a + b', replace: 'a * b', expect_failing: ['test/more.test.mjs'] }

const crit = (id, check = PASS) => [{ text: id + ' works', check, decisions: ['D1'] }]
const lfNode = (id, extra = {}) => leaf(id, { acceptance: crit(id), ...extra })
const planner = (id = 'c') => ({ id, kind: 'composite', title: id, author: 'planner', decisions: ['D1'] })

/** A tdd leaf `a` opened. */
function tdd(t, extra = {}) {
  const w = world(t, [root(), lfNode('a', { locus: ['src/a.mjs', 'test/a.test.mjs'], ...extra })])
  return { w, o: open(w, 'a') }
}

/** A tests-only leaf `t` opened. */
function testsOnly(t, locus = ['test/more.test.mjs']) {
  const w = world(t, [root(), lfNode('t', { rigor: 'tests-only', locus })])
  return { w, o: open(w, 't') }
}

const R_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { r } from '../src/r.mjs'\ntest('doubles 2', () => assert.equal(r(2), 4))\n"
const R_TEST_TWO = R_TEST + "test('doubles 3', () => assert.equal(r(3), 6))\n"
const R_SRC = 'export const r = (x) => x * 2\n'
const R_BITES = { file: 'src/r.mjs', find: 'x * 2', replace: 'x * 3', expect_failing: ['test/r.test.mjs'] }
const R_SURVIVES = { file: 'src/r.mjs', find: 'x * 2', replace: 'x + 2', expect_failing: ['test/r.test.mjs'] }
const R_STALE = { file: 'src/r.mjs', find: 'x * 9', replace: 'x * 3', expect_failing: ['test/r.test.mjs'] }
const TABLE = 'export const table = () => ({ capacity: 1 })\n'
const TABLE_LABELLED = "export const table = () => ({ capacity: 1, label: 'x' })\n"
const TABLE_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { table } from './table.mjs'\ntest('holds one letter', () => assert.equal(table().capacity, 1))\n"
const LABEL_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { table } from './table.mjs'\ntest('is labelled x', () => assert.equal(table().label, 'x'))\n"
const CAPACITY_BITE = { file: 'src/table.mjs', find: 'capacity: 1', replace: 'capacity: 2', expect_failing: ['src/table.test.mjs'] }
const LABEL_BITE = { file: 'src/table.mjs', find: "label: 'x'", replace: "label: 'y'", expect_failing: ['src/table.label.test.mjs'] }
const LABEL_UNBITTEN = { ...LABEL_BITE, expect_failing: ['src/table.test.mjs'] }
const TABLE_GREEN = { greenLocus: ['src/r.mjs', 'src/table.mjs'], greenFiles: { 'src/r.mjs': R_SRC, 'src/table.mjs': TABLE } }

/**
 * A cycle: the red's test committed on its branch and approved, the green cut from that head with its
 * implementation committed, and, when `triad`, an audit cut from the green's head. `redLocus` is the
 * red's locus; `greenSubject` the subject of the green's commit.
 */
function cycle(t, { triad = false, greenLocus = ['src/r.mjs'], greenFiles = { 'src/r.mjs': R_SRC }, redTest = R_TEST, redLocus = ['test/r.test.mjs'], greenSubject = 'Implement r', check = PASS } = {}) {
  const rigor = triad ? 'tdd-triad' : 'tdd-pair'
  const w = world(t, [root(),
    lfNode('r', { rigor, role: 'red', locus: redLocus }),
    lfNode('g', { rigor, role: 'green', deps: ['r'], locus: greenLocus, acceptance: crit('g', check) }),
    ...(triad ? [lfNode('au', { rigor, role: 'audit', deps: ['g'], locus: ['docs/audit.md'] })] : [])])
  const red = open(w, 'r')
  const redHead = commit(red.worktree, { 'test/r.test.mjs': redTest }, 'Pin r')
  const ok = approved('r', redHead, 1, false)
  w.xc.log.append(ok.kind, ok.fields)
  const green = open(w, 'g', { from: redHead })
  const greenHead = commit(green.worktree, greenFiles, greenSubject)
  const audit = triad ? open(w, 'au', { from: greenHead }) : null
  return { w, red, redHead, green, greenHead, audit }
}

/** A message the round answered: its seq. */
const answered = (w, { node: id, thread, msg, payload = {}, round, from = 'code' }) =>
  w.xc.log.append('message', { node: id, thread, from, msg, payload, round }).seq

/**
 * A leaf whose implementer committed work and a change outside its locus, closed once. `after` runs
 * between the commit and the close (more uncommitted work); `ports` are `measure`'s.
 */
async function outside(t, { helper = false, failing = false, ret = DONE, ports, uncommitted } = {}) {
  const w = world(t, [root(), lfNode('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })])
  const o = open(w, 'a')
  const src = helper ? "import { h } from './helper.mjs'\nexport const a = () => h()\n" : failing ? 'export const a = () => 2\n' : A_SRC
  const files = { ...A_FILES, 'src/a.mjs': src, ...(helper ? { 'src/helper.mjs': 'export const h = () => 1\n' } : { 'README.md': 'hello\nedited\n' }) }
  const pre = commit(o.worktree, files, 'Add a')
  if (uncommitted) write(o.worktree, uncommitted)
  const spec = { node: 'a', role: 'implementer', round: 1, ret, base_sha: o.base_sha, head_before: o.base_sha, ports }
  const dispatch = stored(w, spec)
  const first = await close(w, { ...spec, dispatch })
  return { w, o, pre, spec, dispatch, first }
}

const gotcha = (trigger, extra = {}) => ({ kind: 'pitfall', roles: ['implementer'], paths: [], trigger, action: 'do it differently', evidence: { command: 'node x.mjs', output: 'boom' }, ...extra })
const command = (name, value) => ({ kind: 'command', roles: ['implementer', 'investigator'], paths: [], trigger: 'running ' + name, action: 'use it', evidence: { command: name, output: 'ok' }, command: { name, value } })

// ================================================================== G1

describe('G1: a close run again after a kill between a shell-less author\'s commit and its authored line', { concurrency: 2 }, () => {
  const s = scenario(async (t) => {
    const c = cycle(t, TABLE_GREEN)
    // The close's own commit as it stands when the process died before it journalled `authored`.
    const made = commit(c.green.worktree, { 'src/table.test.mjs': TABLE_TEST }, 'Pin the capacity')
    const ret = { status: 'done', text: 'pinned', commit: 'Pin the capacity', mutations: [CAPACITY_BITE] }
    const { out } = await run(c.w, { node: 'g', role: 'test-author', round: 2, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: c.greenHead })
    return { c, made, out }
  })
  after(() => s.end())

  test('G1.1 the commit stands with no authored line: its test file is still at the head and no revert commit is made', SLOW, async () => {
    const { c, made } = await s.get()
    assert.equal(shown(c.green.worktree, 'HEAD:src/table.test.mjs'), shown(c.green.worktree, made + ':src/table.test.mjs'))
    assert.ok(isAncestor(c.green.worktree, made, 'HEAD'), 'the commit is still in the series')
    assert.ok(!subjectsOver(c.green.worktree, c.greenHead).includes(REVERT), subjectsOver(c.green.worktree, c.greenHead).join(' | '))
  })

  test('G1.2 that close records no breach_reverted', SLOW, async () => {
    const { c } = await s.get()
    assert.deepEqual(recs(c.w, 'breach_reverted', 'g'), [])
    assert.equal(rec(c.w, 'g', 'test-author', 2).breach, null)
  })

  test('G1.3 that close journals authored naming the commit, and committed is that sha', SLOW, async () => {
    const { c, made } = await s.get()
    const authored = recs(c.w, 'authored', 'g')
    assert.equal(authored.length, 1)
    assert.deepEqual([authored[0].role, authored[0].round, authored[0].sha], ['test-author', 2, made])
    assert.equal(rec(c.w, 'g', 'test-author', 2).committed, made)
  })

  test('G1.4 an implementer round commits are never journalled authored', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual(recs(w, 'authored', 'a'), [])
  })
})

// ================================================================== G3

describe('G3: [D1] a decline of a round that carried needs_tests and findings', { concurrency: 2 }, () => {
  const s = scenario(async (t) => {
    const c = cycle(t)
    const asked = answered(c.w, { node: 'g', thread: 'producer:r', msg: 'needs_tests', payload: { text: 'pin it' }, round: 3, from: 'implementer' })
    const found = answered(c.w, { node: 'g', thread: 'producer:r', msg: 'findings', payload: { findings: [] }, round: 3 })
    const ret = { status: 'declined', text: 'a test of that would pin an implementation detail' }
    const { out, dispatch } = await run(c.w, { node: 'g', role: 'test-author', round: 3, thread: 'producer:r', ret, carries: [asked, found], base_sha: c.green.base_sha, head_before: c.greenHead })
    return { c, out, dispatch }
  })
  after(() => s.end())

  test('G3.1 the decline escalates tests_declined, said the dispatch, and stops', SLOW, async () => {
    const { out, dispatch } = await s.get()
    assert.equal(out.decision.next, 'stop')
    assert.deepEqual(out.stops, [{ id: 'g', status: 'escalated', reason: 'tests_declined', said: dispatch }])
  })

  test('G3.2 that close records no declined message', SLOW, async () => {
    const { c } = await s.get()
    assert.deepEqual(msgs(c.w, 'declined', 'g'), [])
  })
})

// ================================================================== G4

describe('G4: the measurement before a revert is never read as the round\'s', { concurrency: 2 }, () => {
  const GONE = { file: 'src/extra.mjs', find: 'x = 1', replace: 'x = 2', expect_failing: ['test/more.test.mjs'] }

  const tests = scenario(async (t) => {
    const { w, o } = testsOnly(t)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST, 'src/extra.mjs': 'export const x = 1\n' })
    await run(w, { node: 't', role: 'test-author', round: 1, ret: { status: 'done', text: 'one', commit: 'Test add', mutations: [ADD_BITE, GONE] }, base_sha: o.base_sha })
    const afterOne = head(o.worktree)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST + '// again\n' })
    const { out } = await run(w, { node: 't', role: 'test-author', round: 2, ret: { status: 'done', text: 'two', commit: 'Test add again', mutations: [ADD_BITE] }, base_sha: o.base_sha, head_before: afterOne })
    return { w, o, out }
  })
  after(() => tests.end())

  test('G4.1 the next round does not apply a mutation the pre-revert measurement applied, and the close approves', SLOW, async () => {
    const { w, o, out } = await tests.get()
    const line = observed(w, 't').find((l) => l.head_sha === head(o.worktree))
    assert.ok(line, 'the round measured its head')
    assert.deepEqual(line.mutations.filter((m) => m.file === GONE.file), [])
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
  })

  test('G4.2 an audit failures go to the round thread when only the pre-revert measurement let a mutation through, however often the close is run', SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    write(c.audit.worktree, { 'src/extra.mjs': 'export const x = 1\n' })
    const unseen = { ...GONE, expect_failing: ['test/r.test.mjs'] }
    const spec = { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret: auditor([unseen]), base_sha: c.audit.base_sha, head_before: c.audit.base_sha }
    const dispatch = stored(c.w, spec)
    const first = await close(c.w, { ...spec, dispatch })
    assert.equal(first.decision.next, 'fix', JSON.stringify(first.decision))
    await close(c.w, { ...spec, dispatch })
    assert.deepEqual(msgs(c.w, 'failures', 'au').map((m) => m.thread), ['producer:au'])
    assert.deepEqual(msgs(c.w, 'surviving_mutations', 'au'), [])
  })
})

// ================================================================== G5

describe('G5: [D2] an implementer\'s needs_tests is answered by the test round that finally measures', { concurrency: 2 }, () => {
  const s = scenario(async (t) => {
    const c = cycle(t, { greenLocus: ['src/r.mjs', 'src/table.mjs'], greenFiles: { 'src/r.mjs': R_SRC, 'src/table.mjs': TABLE_LABELLED } })
    const asked = answered(c.w, { node: 'g', thread: 'producer:r', msg: 'needs_tests', payload: { text: 'pin it' }, round: 3, from: 'implementer' })
    write(c.green.worktree, { 'src/table.test.mjs': TABLE_TEST })
    const one = { status: 'done', text: 'pinned', commit: 'Pin the capacity', mutations: [LABEL_UNBITTEN] }
    const first = await run(c.w, { node: 'g', role: 'test-author', round: 3, thread: 'producer:r', ret: one, carries: [asked], base_sha: c.green.base_sha, head_before: c.greenHead })
    const sent = msgs(c.w, 'failures', 'g')
    write(c.green.worktree, { 'src/table.label.test.mjs': LABEL_TEST })
    const two = { status: 'done', text: 'pinned the label', commit: 'Pin the label', mutations: [CAPACITY_BITE, LABEL_BITE] }
    const second = await run(c.w, { node: 'g', role: 'test-author', round: 4, thread: 'producer:r', ret: two, carries: sent.map((m) => m.seq), base_sha: c.green.base_sha, head_before: head(c.green.worktree) })
    return { c, first: first.out, second: second.out, sent }
  })
  after(() => s.end())

  test('G5.1 the next test round, carrying only the failures, measures review and records tests_ready to the green at the round after', SLOW, async () => {
    const { c, first, second, sent } = await s.get()
    assert.deepEqual([first.decision.next, sent.length, sent[0].thread], ['fix', 1, 'producer:r'], 'the first round sent its failures back to the test session')
    assert.equal(second.decision.next, 'review', JSON.stringify(second.decision))
    assert.equal(rec(c.w, 'g', 'test-author', 4).answering, 'failures')
    const ready = msgs(c.w, 'tests_ready', 'g')
    assert.equal(ready.length, 1)
    assert.deepEqual([ready[0].thread, ready[0].round], ['producer:g', 5])
  })

  test('G5.2 its files are the test files the cycle test session committed since the request', SLOW, async () => {
    const { c } = await s.get()
    const expected = recs(c.w, 'authored', 'g').flatMap((a) => filesOf(c.green.worktree, a.sha))
    assert.equal(expected.length, 2)
    assert.deepEqual([...msgs(c.w, 'tests_ready', 'g')[0].payload.files].sort(), [...expected].sort())
  })
})

// ================================================================== G6

describe('G6: [D3] a verify finding under a planner\'s folder', () => {
  test('G6.1 the folder replanned without the leaf leaves the leaf not escalated', SLOW, async (t) => {
    const w = world(t, [root(), planner(), lfNode('c/v', { rigor: 'verify', locus: [], acceptance: crit('c/v', FAIL) })])
    const o = open(w, 'c/v')
    const out = await close(w, { node: 'c/v', role: '', round: 1, thread: '', dispatch: '', base_sha: o.base_sha })
    assert.equal(out.decision.next, 'route')
    assert.equal(out.route.request.status, 'verify_finding')
    const replanned = addNodes(w.r, E, [{ ...planner(), title: 'c, rewritten by its planner' }], { by: 'planner', reason: 'verify_finding' })
    assert.equal(replanned.ok, true, JSON.stringify(replanned.problems))
    const tree = readTree(w.r, E)
    assert.notEqual(tree.status.get('c/v').status, 'escalated')
  })
})

// ================================================================== G7

describe('G7: the previous close and the breach record across executions', { concurrency: 2 }, () => {
  test('G7.1 a round-2 close in a later execution escalates verify_not_converging against the earlier execution round-1 close', SLOW, async (t) => {
    const first = world(t, [root(), lfNode('a', { locus: ['src/a.mjs', 'test/a.test.mjs'], acceptance: crit('a', FAIL) })])
    const o = open(first, 'a')
    const one = commit(o.worktree, A_FILES, 'Add a')
    const r1 = await run(first, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(r1.out.decision.next, 'fix', JSON.stringify(r1.out.decision))
    const later = elsewhere(first)
    commit(o.worktree, { 'src/a.mjs': A_SRC + '// second try\n' }, 'Try again')
    const r2 = await run(later, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: one })
    assert.deepEqual([r2.out.decision.next, r2.out.decision.reason], ['stop', 'verify_not_converging'])
  })

  test('G7.2 a round-2 close in a later execution that fails on every earlier key and one more raises', SLOW, async (t) => {
    const ok1 = 'node -e "process.exit(require(\'fs\').existsSync(\'ok1.txt\')?0:1)"'
    const bad2 = 'node -e "process.exit(require(\'fs\').existsSync(\'bad2.txt\')?1:0)"'
    const first = world(t, [root(), lfNode('a', {
      locus: ['src/a.mjs', 'test/a.test.mjs', 'ok1.txt', 'bad2.txt'],
      acceptance: [{ text: 'ok1 exists', check: ok1, decisions: ['D1'] }, { text: 'bad2 is absent', check: bad2, decisions: ['D1'] }],
    })])
    const o = open(first, 'a')
    const one = commit(o.worktree, A_FILES, 'Add a')
    const r1 = await run(first, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    const later = elsewhere(first)
    commit(o.worktree, { 'bad2.txt': 'x\n' }, 'Break the second')
    const r2 = await run(later, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: one })
    assert.ok(claimsOf(r2.out).length > claimsOf(r1.out).length, 'round 2 keeps the failure and adds one')
    assert.equal(r2.out.raise, true)
    assert.equal(rec(later, 'a', 'implementer', 2).raise, true)
  })

  test('G7.3 a close run again under a new execution records no second breach_reverted for the node and sha', SLOW, async (t) => {
    const s = await outside(t)
    const reverted = recs(s.w, 'breach_reverted', 'a')
    assert.equal(reverted.length, 1)
    const later = elsewhere(s.w)
    const dispatch = stored(later, s.spec)
    const second = await close(later, { ...s.spec, dispatch })
    assert.equal(second.decision.next, s.first.decision.next)
    assert.deepEqual(recs(later, 'breach_reverted', 'a'), [])
    assert.deepEqual(recs(s.w, 'breach_reverted', 'a'), reverted)
  })
})

// ================================================================== G8

describe('G8: [D4] held mutations and the audit gap across executions', { concurrency: 2 }, () => {
  test('G8.1 a close in a later execution applies a mutation an earlier execution applied that did not bite, beside its own', SLOW, async (t) => {
    const { w, o } = testsOnly(t)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST })
    const r1 = await run(w, { node: 't', role: 'test-author', round: 1, ret: { status: 'done', text: 'one', commit: 'Test add', mutations: [ADD_BITE, ADD_SURVIVES] }, base_sha: o.base_sha })
    assert.equal(r1.out.decision.next, 'fix', JSON.stringify(r1.out.decision))
    const later = elsewhere(w)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST + '// again\n' })
    await run(later, { node: 't', role: 'test-author', round: 2, ret: { status: 'done', text: 'two', commit: 'Test add again', mutations: [ADD_BITE_TOO] }, base_sha: o.base_sha, head_before: head(o.worktree) })
    const line = observed(later, 't').find((l) => l.head_sha === head(o.worktree))
    assert.ok(line, 'the later execution measured the head')
    const replaces = line.mutations.map((m) => m.replace)
    assert.ok(replaces.includes(ADD_SURVIVES.replace), 'the earlier mutation that got through is applied again: ' + replaces.join(', '))
    assert.ok(replaces.includes(ADD_BITE_TOO.replace), 'and so is the new one')
  })

  test('G8.2 an audit fix close in a later execution with no surviving mutation sends its failures to the red when an earlier execution let one through', SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    const r1 = await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret: auditor([R_SURVIVES]), base_sha: c.audit.base_sha, head_before: c.audit.base_sha })
    assert.equal(r1.out.decision.next, 'fix', JSON.stringify(r1.out.decision))
    const later = elsewhere(c.w)
    write(c.audit.worktree, { 'test/r.test.mjs': R_TEST_TWO })
    // The thread is whatever the caller passed; the cycle's test session is picked from the records.
    const r2 = await run(later, { node: 'au', role: 'test-author', round: 2, thread: 'producer:au', ret: { status: 'done', text: 'a case more', commit: 'Pin r at 3', mutations: [R_STALE] }, base_sha: c.audit.base_sha, head_before: c.audit.base_sha })
    assert.equal(r2.out.decision.next, 'fix', JSON.stringify(r2.out.decision))
    assert.deepEqual(msgs(later, 'surviving_mutations', 'au').filter((m) => m.round === 3), [])
    const sent = msgs(later, 'failures', 'au')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:r')
  })
})

// ================================================================== G9

describe('G9: only this round\'s agentics: commits are read back', { concurrency: 2 }, () => {
  const strays = scenario(async (t) => {
    const { w, o } = testsOnly(t)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST, 'stray.txt': 'one\n' })
    await run(w, { node: 't', role: 'test-author', round: 1, ret: { status: 'done', text: 'one', commit: 'Test add', mutations: [ADD_BITE] }, base_sha: o.base_sha })
    const afterOne = head(o.worktree)
    assert.equal(subjectsOver(o.worktree, o.base_sha)[0], REVERT)
    write(o.worktree, { 'stray2.txt': 'two\n' })
    await run(w, { node: 't', role: 'test-author', round: 2, ret: { status: 'done', text: 'two', mutations: [ADD_BITE] }, base_sha: o.base_sha, head_before: afterOne })
    return { w, o }
  })
  after(() => strays.end())

  test('G9.1 a later round that starts on the revert commit of an earlier one has its own stray file taken out', SLOW, async () => {
    const { o } = await strays.get()
    assert.equal(existsSync(join(o.worktree, 'stray2.txt')), false)
    assert.equal(holds(o.worktree, 'HEAD:stray2.txt'), false)
  })

  test('G9.2 its breach paths name that file and none of the earlier round', SLOW, async () => {
    const { w } = await strays.get()
    assert.deepEqual(rec(w, 't', 'test-author', 2).breach.paths, ['stray2.txt'])
  })

  test('G9.3 an audit cut from a green head ending in a revert records no breach when its auditor writes nothing', SLOW, async (t) => {
    const c = cycle(t, { triad: true, greenSubject: REVERT })
    await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret: auditor([R_BITES]), base_sha: c.audit.base_sha, head_before: c.audit.base_sha })
    assert.deepEqual(recs(c.w, 'breach_reverted', 'au'), [])
    assert.equal(rec(c.w, 'au', 'auditor', 1).breach, null)
  })

  test('G9.4 a round that starts on an outside-locus commit of an earlier round takes out its own stray file and leaves the earlier files out of its breach', SLOW, async (t) => {
    const c = cycle(t, TABLE_GREEN)
    const earlier = commit(c.green.worktree, { 'src/table.mjs': 'export const table = () => ({ capacity: 9 })\n' }, OUTSIDE)
    write(c.green.worktree, { 'stray.txt': 'oops\n' })
    const ret = { status: 'done', text: 'nothing to add', mutations: [R_BITES] }
    await run(c.w, { node: 'g', role: 'test-author', round: 3, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: earlier })
    assert.equal(existsSync(join(c.green.worktree, 'stray.txt')), false)
    assert.deepEqual(rec(c.w, 'g', 'test-author', 3).breach.paths, ['stray.txt'])
  })
})

// ================================================================== G10

describe('G10: a staged rename', () => {
  test('G10.1 a rename inside the locus left staged and uncommitted is put back whole: both paths as at the head, git status clean', SLOW, async (t) => {
    const w = world(t, [root(), lfNode('a', { locus: ['src/a.mjs', 'test/a.test.mjs', 'src/add.mjs', 'src/moved.mjs'] })])
    const o = open(w, 'a')
    commit(o.worktree, A_FILES, 'Add a')
    git(o.worktree, 'mv', 'src/add.mjs', 'src/moved.mjs')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(existsSync(join(o.worktree, 'src/moved.mjs')), false)
    assert.equal(text(o.worktree, 'src/add.mjs'), shown(o.worktree, 'HEAD:src/add.mjs'))
    assert.equal(git(o.worktree, 'status', '--porcelain'), '')
  })
})

