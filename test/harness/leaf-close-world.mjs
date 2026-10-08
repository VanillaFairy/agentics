// test/harness/leaf-close-world.mjs — the world builders the boundaries-leaf-close-outcome, -locus,
// -breach, -measure, -decision, -escalation and -record tests share: a repository with a tree and
// open leaves, a producer's stored return, `leafClose` run over it, and the readers of what the
// close wrote. Nothing here runs at import.

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeSessionCommands } from '../../lib/boundaries/execution.mjs'
import { leafClose } from '../../lib/boundaries/leaf-close.mjs'
import { approved, executionContext } from '../../lib/boundaries/records.mjs'
import { listGotchas } from '../../lib/gotchas.mjs'
import { attach } from '../../lib/integration.mjs'
import { executionLog, readLog } from '../../lib/ledger.mjs'
import { schemaOf } from '../../lib/schemas.mjs'
import { branchOf, closePath, executionDir, mkdirState, readJson, returnPath, worktreeOf } from '../../lib/store.mjs'
import { A_TEST, COMMANDS, STAMP, git, leaf, repo, root } from './boundary-fixture.mjs'
import { seedTree } from './seed-tree.mjs'

export const E = 'e1'

export const SLOW = { timeout: 180_000 }
export const PASS = "node -e 'process.exit(0)'"

// ================================================================== a world to close in

/** A repository, a seeded tree, the branches an execution stands on, and the execution's context. */
export function world(t, nodesOf, { commands = COMMANDS, stamp = STAMP } = {}) {
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
  writeSessionCommands(xc, xc.envelope())
  return { r, xc, base, stamp }
}

/** A leaf opened: its branch cut at `from` (the base commit unless said) and attached at its worktree. */
export function open(w, id, { from } = {}) {
  const branch = branchOf(E, id)
  git(w.r, 'branch', branch, from || w.base)
  const worktree = worktreeOf(w.r, E, id)
  const attached = attach(w.r, branch, worktree)
  assert.equal(attached.ok, true, attached.error)
  return { worktree, branch, base_sha: git(w.r, 'rev-parse', branch) }
}

/** A commit of `files` in a worktree, its sha. */
export function commit(worktree, files, subject) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true })
    writeFileSync(join(worktree, path), text)
  }
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-q', '-m', subject)
  return git(worktree, 'rev-parse', 'HEAD')
}

export const write = (worktree, files) => {
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
export function stored(w, { node: id, role, round = 1, thread = 'producer:' + id, ret, carries = [], dispatch, returned = 'returned', cause }) {
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
export const close = (w, { node: id, role = 'implementer', round = 1, thread = 'producer:' + id, dispatch, base_sha = '', head_before = '', ports } = {}) =>
  leafClose(w.xc, { node: id, role, round, thread, dispatch, head_before, base_sha }, ports)

/** A round stored, then closed. */
export async function run(w, spec) {
  const dispatch = stored(w, spec)
  const out = await close(w, { ...spec, dispatch })
  return { out, dispatch }
}

const logsOf = (w) => ({
  events: readLog(w.r, E, 'events').entries,
  state: readLog(w.r, E, 'state:' + w.stamp).entries,
  journal: readLog(w.r, E, 'journal:' + w.stamp).entries,
})
export const recs = (w, kind, id) => {
  const l = logsOf(w)
  return [...l.events, ...l.state, ...l.journal].filter((e) => e.kind === kind && (id === undefined || e.node === id))
}
export const msgs = (w, msg, id) => recs(w, 'message', id).filter((m) => m.msg === msg)
export const sizes = (w) => { const l = logsOf(w); return [l.events.length, l.state.length, l.journal.length] }
export const observed = (w, id) => recs(w, 'verify-observed', id)
export const rec = (w, id, role, round) => readJson(closePath(w.r, E, w.stamp, id, role || 'none', round))
export const head = (worktree) => git(worktree, 'rev-parse', 'HEAD')

export const subjectOf = (worktree, ref = 'HEAD') => git(worktree, 'log', '-1', '--format=%s', ref)
/** The close record's measurement as its stop reason, whether the record keeps the payload or only the reason. */
export const stopOf = (record) => (typeof record.measurement === 'string' ? record.measurement : record.measurement && record.measurement.stop_reason)
export const shapeOf = (out) => ({ next: out.decision.next, reason: out.decision.reason, failures: out.decision.failures.map((f) => f.check + ':' + f.claim) })
export const claimsOf = (out) => out.decision.failures.map((f) => f.claim)

export const DONE = { status: 'done', text: 'it is done' }
export const A_SRC = 'export const a = () => 1\n'
export const A_FILES = { 'test/a.test.mjs': A_TEST, 'src/a.mjs': A_SRC }
export const MORE_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/add.mjs'\ntest('adds negatives', () => assert.equal(add(-1, -2), -3))\n"
export const ADD_BITE = { file: 'src/add.mjs', find: 'a + b', replace: 'a - b', expect_failing: ['test/more.test.mjs'] }

export const crit = (id, check = PASS) => [{ text: id + ' works', check, decisions: ['D1'] }]
export const lf = (id, extra = {}) => leaf(id, { acceptance: crit(id), ...extra })
export const planner = (id = 'c') => ({ id, kind: 'composite', title: id, author: 'planner', decisions: ['D1'] })

/** A tdd leaf `a` opened. */
export function tdd(t, extra = {}) {
  const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'], ...extra })])
  return { w, o: open(w, 'a') }
}

/** A tests-only leaf `t`, opened. */
export function testsOnly(t, locus = ['test/more.test.mjs']) {
  const w = world(t, [root(), lf('t', { rigor: 'tests-only', locus })])
  return { w, o: open(w, 't') }
}

export const R_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { r } from '../src/r.mjs'\ntest('doubles 2', () => assert.equal(r(2), 4))\n"

export const R_SRC = 'export const r = (x) => x * 2\n'
export const TABLE = 'export const table = () => ({ capacity: 1 })\n'

export const TABLE_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { table } from './table.mjs'\ntest('holds one letter', () => assert.equal(table().capacity, 1))\n"
export const CAPACITY_BITE = { file: 'src/table.mjs', find: 'capacity: 1', replace: 'capacity: 2', expect_failing: ['src/table.test.mjs'] }
export const R_BITES = { file: 'src/r.mjs', find: 'x * 2', replace: 'x * 3', expect_failing: ['test/r.test.mjs'] }
export const R_SURVIVES = { file: 'src/r.mjs', find: 'x * 2', replace: 'x + 2', expect_failing: ['test/r.test.mjs'] }

/**
 * A cycle: the red's test committed on its branch and approved, the green cut from that head with its
 * implementation committed, and, when `triad`, an audit cut from the green's head.
 */
export function cycle(t, { triad = false, greenLocus = ['src/r.mjs'], greenFiles = { 'src/r.mjs': R_SRC }, redTest = R_TEST } = {}) {
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
export const answered = (w, { node: id, thread, msg, payload = {}, round, from = 'code' }) =>
  w.xc.log.append('message', { node: id, thread, from, msg, payload, round }).seq

/**
 * A leaf whose implementer committed work and a change outside its locus, under the user's folder or
 * a planner's. `work` is what the implementer committed beside the README edit.
 */
export async function outside(t, { under = 'you', helper = false, failing = false, ret = DONE, noReadme = false } = {}) {
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

export const gotcha = (trigger, extra = {}) => ({ kind: 'pitfall', roles: ['implementer'], paths: [], trigger, action: 'do it differently', evidence: { command: 'node x.mjs', output: 'boom' }, ...extra })
export const command = (name, value) => ({ kind: 'command', roles: ['implementer', 'investigator'], paths: [], trigger: 'running ' + name, action: 'use it', evidence: { command: name, output: 'ok' }, command: { name, value } })
const absent = (name) => ({ ...command(name, ''), command: { name, value: '', absent: true } })
export const ESTABLISHED = () => [absent('build'), absent('typecheck'), command('suite', COMMANDS.suite), command('test_one', COMMANDS.test_one)]

export const gotchaOf = (w, id) => listGotchas(w.r, E).find((g) => g.id === id)
