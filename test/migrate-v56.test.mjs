// test/migrate-v56.test.mjs — the one-shot move of a store whose searches ran in an old shape.
// An old search is a searcher's dispatch on a search thread (scout:*, common, locate, history, docs,
// research:*, repo, under any scope) whose `searchDir(<run dir>, <thread>)` holds no `server-*.json`
// spec without an `asks` key: a 5.4.1 round search or a 5.5.0 navigator search. A stopped
// program run holding one is faulted and ended; a folder of an open execution holding one is
// replanned by the migration wherever the dry-applied replan changes no derived status, no ruling's
// answer and no review's standing, and is listed with the user's options everywhere else; a live
// home is refused; a dry run writes nothing; a second run appends nothing; a run cut short is
// finished by the next; a linked worktree reaches the main checkout's store.
//
// Design: docs/DESIGN.md#migration-from-4x.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { append, appendRun, readLog, readRunLog, runLog, runState } from '../lib/ledger.mjs'
import { ROLE_NAMES, loadRole } from '../lib/roles.mjs'
import { effortStateDir, executionDir, executionRunId, mainCheckout, posix, runDir, runJsonPath, runLogPath } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { searchDir } from '../lib/search/server.mjs'
import { apply, plan } from '../tools/migrate-v56.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { DEAD_PID } from './harness/dead-pid.mjs'

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'migrate-v56.mjs')
const E = 'e1'
const OPEN = '20261013-100000'
const CLOSED = '20261012-100000'
const LIVE = '20261013-110000'
const RUN = '20261013-090000-probe'
const OLD = new Date(0).toISOString()
const SHA = '1'.repeat(40)

/** Every thread name the round machinery gave a search, with the searcher that ran it. */
const ROUND_THREADS = [
  ['scout:core-exports', 'scout'], ['common', 'scout'], ['locate', 'scout'], ['history', 'historian'],
  ['docs', 'doc-researcher'], ['research:npm-packages', 'doc-researcher'], ['repo', 'scout'],
]

const leaf = (id) => ({
  id, kind: 'leaf', title: 'do ' + id, rigor: 'tdd', expects: [id.split('/').join('-') + '.mjs'],
  acceptance: [{ text: id + ' works', check: 'node --test' }],
})
const composite = (id) => ({ id, kind: 'composite', title: 'folder ' + id })
const NODES = [
  { id: '.', kind: 'composite', title: 'root' },
  composite('f'), leaf('f/a'), composite('f/x'), leaf('f/x/b'),
  composite('p'), leaf('p/a'),
  composite('k'), leaf('k/a'),
  composite('q'), leaf('q/a'),
  composite('r'), leaf('r/a'),
  composite('c'), leaf('c/a'),
]

// ------------------------------------------------------------------ building a store

const ok = (out) => {
  assert.equal(out.ok, true, out.error)
  return out.seqs[0]
}
function put(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const childEnv = () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return env
}
const dispatchOf = (thread) => thread.replace(/[^A-Za-z0-9.-]+/g, '-') + '.r1'
const dispatched = (thread, role) => ({
  kind: 'dispatched', dispatch: dispatchOf(thread), node: '', round: 1, thread, role, model: 'sonnet', effort: '',
  session: 's-' + dispatchOf(thread), brief_digest: 'd', brief_parts: {}, carries: [], pid: 0,
})

function seed(dir) {
  const seeded = seedTree(dir, E, NODES)
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems))
}

/** A fresh store holding effort e1's tree, in no git repository. */
function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-migrate-v56-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(dir)
  return dir
}

/** A run.json: live when its pid is this process and its heartbeat is now; stopped otherwise. */
const runMeta = (run, program, live) => JSON.stringify({
  run, program, scope: {}, scope_key: 'k', args: {}, args_digest: 'a', raw: {}, started_at: OLD,
  pid: live ? process.pid : DEAD_PID, heartbeat_at: live ? new Date().toISOString() : OLD,
})

/** A 5.6.0 server spec: what a lean search writes beside its dispatch. */
const leanSpecBody = (dir, home, thread) => ({
  tree: { root: dir }, scope: ['.'], labels: [], tools: [], calls: join(searchDir(home, thread), 'calls.jsonl'),
  pages: join(home, 'pages'), session: 's-' + dispatchOf(thread),
})
/** Write a lean search's spec for `thread` under run home `home`. */
const leanSearch = (dir, home, thread, name = 'server-x.json') =>
  put(join(searchDir(home, thread), name), JSON.stringify(leanSpecBody(dir, home, thread)))
/** Write a 5.5.0 navigator search's spec for `thread` under run home `home`: the same, with `asks`. */
const navigatorSearch = (dir, home, thread, name = 'server-n.json') =>
  put(join(searchDir(home, thread), name), JSON.stringify({ ...leanSpecBody(dir, home, thread), asks: [{ ask: 'where is x', label: 'guidance' }] }))
/** The run home of execution `stamp` of e1. */
const execHome = (dir, stamp = OPEN) => executionDir(dir, E, stamp)

/**
 * A program run outside an execution holding `threads` ([thread, role]); `ground` names threads the
 * 5.5.0 navigator loop opened (a ground step); `lean` and `navigator` name threads given a spec.
 */
function programRun(dir, run = RUN, { program = 'probe', threads = [['locate', 'scout']], live = false, ended = false, ground = [], lean = [], navigator = [], meta = true } = {}) {
  mkdirSync(runDir(dir, run), { recursive: true })
  if (meta) put(runJsonPath(dir, run), runMeta(run, program, live))
  ok(appendRun(dir, run, { kind: 'run', program, scope: {}, pid: live ? process.pid : DEAD_PID }))
  for (const thread of ground) ok(appendRun(dir, run, { kind: 'step', key: thread + '/ground', value: { rows: 0 } }))
  for (const thread of lean) leanSearch(dir, runDir(dir, run), thread)
  for (const thread of navigator) navigatorSearch(dir, runDir(dir, run), thread)
  for (const [thread, role] of threads) ok(appendRun(dir, run, dispatched(thread, role)))
  if (ended) ok(appendRun(dir, run, { kind: 'ended', result: { status: 'done', file: '', complete: true } }))
}

/** An execution of e1 over `root`: its envelope, its run.json and its `run` line. */
function execution(dir, stamp = OPEN, { live = false, closed = false, root = '.' } = {}) {
  put(join(executionDir(dir, E, stamp), 'execution.json'), JSON.stringify({
    stamp, root, base_branch: 'main', base_sha: '0'.repeat(40), dial: {}, pace: 'balanced', commands: {},
  }))
  put(runJsonPath(dir, executionRunId(E, stamp)), runMeta(executionRunId(E, stamp), 'execute', live))
  ok(append(dir, E, 'state:' + stamp, { kind: 'run', program: 'execute', scope: { effort: E, folder: root }, pid: live ? process.pid : DEAD_PID }))
  if (closed) ok(append(dir, E, 'state:' + stamp, { kind: 'closed', status: 'done' }))
}

/** A searcher's dispatch on `thread` in execution `stamp`; its seq. */
const searched = (dir, thread, role = 'scout', stamp = OPEN) => ok(append(dir, E, 'events', { ...dispatched(thread, role), execution: stamp }))
/** A node event of e1 under execution `stamp`; its seq. */
const event = (dir, kind, node, fields = {}, stamp = OPEN) => ok(append(dir, E, 'events', { kind, node, execution: stamp, ...fields }))
const stateLine = (dir, entry, stamp = OPEN) => ok(append(dir, E, 'state:' + stamp, entry))
/** The session's retry of `node`, as `lib/boundary.mjs retry` writes it. */
const retried = (dir, node) => event(dir, 'replanned', node, { reason: 'retry_escalated', by: 'session' })

/** The fixtures several tests share: an eligible folder f, and p, excluded by its open escalation. */
function eligibleAndExcluded(dir) {
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  event(dir, 'escalated', 'p', { reason: 'blocked', detail: 'p is blocked', said: '' })
  searched(dir, 'probe:p:2/locate')
}

// ------------------------------------------------------------------ reading what is on disk

function walk(dir, base, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name)
    const rel = posix(relative(base, path))
    if (e.isDirectory()) {
      out.set(rel + '/', null)
      walk(path, base, out)
    } else {
      out.set(rel, readFileSync(path))
    }
  }
  return out
}
/** Every file (bytes) and directory under `.agentics/`, by path relative to it. */
const snapshot = (dir) => walk(join(dir, '.agentics'), join(dir, '.agentics'), new Map())
const hexed = (snap) => [...snap].map(([rel, b]) => [rel, b === null ? null : b.toString('hex')]).sort(([a], [b]) => (a < b ? -1 : 1))
const totalLines = (dir) => [...snapshot(dir)].filter(([rel, b]) => b !== null && rel.endsWith('.jsonl'))
  .reduce((n, [, b]) => n + b.toString('utf8').split('\n').filter((l) => l.trim() !== '').length, 0)
const events = (dir) => readLog(dir, E, 'events').entries
const replans = (dir, node) => events(dir).filter((e) => e.kind === 'replanned' && e.node === node && e.by === 'migration')
const statuses = (dir) => Object.fromEntries([...readTree(dir, E).status].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, s]) => [id, s.status]))
/** A run's records since its latest `run` line. */
function sinceRun(dir, run = RUN) {
  const { entries } = readRunLog(dir, run)
  return entries.slice(entries.findLastIndex((e) => e.kind === 'run') + 1)
}
const folderIds = (p) => p.folders.map((f) => f.folder)
const cli = (cwd, ...args) => spawnSync(process.execPath, [TOOL, ...args], { cwd, env: childEnv(), encoding: 'utf8', timeout: 60_000 })
/** Make e1's log refuse every append: its seq counter becomes a directory. */
function blockEffortSeq(dir) {
  const seq = join(effortStateDir(dir, E), 'seq')
  rmSync(seq, { force: true })
  mkdirSync(seq, { recursive: true })
}

// ------------------------------------------------------------------ what a round search is

for (const [thread, role] of ROUND_THREADS) {
  test('a stopped program run holding a round search on ' + thread + ' is planned', (t) => {
    const dir = store(t)
    programRun(dir, RUN, { threads: [[thread, role]] })
    assert.deepEqual(plan(dir).runs, [{ run: RUN, program: 'probe', threads: [thread] }])
  })
}

test('a round search under a scope prefix is a round search', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [['outer:1/locate', 'scout']] })
  assert.deepEqual(plan(dir).runs.map((r) => r.threads), [['outer:1/locate']])
})

test("a run's round searches are listed once each, sorted", (t) => {
  const dir = store(t)
  programRun(dir, RUN, { program: 'survey', threads: [['scout:b', 'scout'], ['scout:a', 'scout'], ['scout:b', 'scout']] })
  assert.deepEqual(plan(dir).runs, [{ run: RUN, program: 'survey', threads: ['scout:a', 'scout:b'] }])
})

test('a ground step beside a search no longer makes it migrated: with no spec it is old', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [['locate', 'scout']], ground: ['locate'] })
  assert.deepEqual(plan(dir).runs, [{ run: RUN, program: 'probe', threads: ['locate'] }])
})

// ------------------------------------------------------------------ old shape against new shape

test('a finished round search is faulted, so its run searches afresh', (t) => {
  const dir = store(t)
  programRun(dir)
  ok(appendRun(dir, RUN, { kind: 'returned', dispatch: dispatchOf('locate'), status: 'done', output: {} }))
  assert.equal(existsSync(searchDir(runDir(dir, RUN), 'locate')), false)
  assert.deepEqual(plan(dir).runs, [{ run: RUN, program: 'probe', threads: ['locate'] }])
  assert.equal(apply(plan(dir)).error, '')
  const since = sinceRun(dir)
  assert.ok(since.some((e) => e.kind === 'fault' && e.channel === 'program' && /^migrate-v56:/.test(e.detail)))
  assert.deepEqual(since.filter((e) => e.kind === 'ended').map((e) => e.result.status), ['failed'])
  assert.equal(runState(dir, RUN).state, 'ended')
})

test('an unfinished round search is faulted', (t) => {
  const dir = store(t)
  programRun(dir)
  assert.equal(readRunLog(dir, RUN).entries.some((e) => e.kind === 'returned'), false)
  assert.deepEqual(plan(dir).runs.map((r) => r.run), [RUN])
  assert.deepEqual(apply(plan(dir)), { applied: 2, error: '' })
  const since = sinceRun(dir)
  assert.equal(since.filter((e) => e.kind === 'fault' && /^migrate-v56:/.test(e.detail)).length, 1)
  assert.equal(runState(dir, RUN).state, 'ended')
})

test('a navigator search is faulted', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [['locate', 'scout']], ground: ['locate'], navigator: ['locate'] })
  assert.deepEqual(plan(dir).runs, [{ run: RUN, program: 'probe', threads: ['locate'] }])
  assert.deepEqual(apply(plan(dir)), { applied: 2, error: '' })
  assert.ok(sinceRun(dir).some((e) => e.kind === 'fault' && /^migrate-v56:/.test(e.detail)))
  assert.equal(runState(dir, RUN).state, 'ended')
})

test('a navigator spec with an empty asks list is still old', (t) => {
  const dir = store(t)
  programRun(dir)
  put(join(searchDir(runDir(dir, RUN), 'locate'), 'server-n.json'), JSON.stringify({ ...leanSpecBody(dir, runDir(dir, RUN), 'locate'), asks: [] }))
  assert.deepEqual(plan(dir).runs.map((r) => r.threads), [['locate']])
})

test('a run mixing old and new searches counts as old', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [['locate', 'scout'], ['common', 'scout']], lean: ['locate'] })
  const p = plan(dir)
  assert.deepEqual(p.runs.map((r) => r.run), [RUN])
  assert.ok(p.runs[0].threads.includes('common'), JSON.stringify(p.runs[0].threads))
  assert.equal(apply(p).error, '')
  assert.equal(runState(dir, RUN).state, 'ended')
})

test('a run of lean searches is left alone', (t) => {
  const dir = store(t)
  programRun(dir, RUN, {
    threads: [['locate', 'scout'], ['history', 'historian'], ['scout:core-exports', 'scout'], ['outer:1/research:npm', 'doc-researcher']],
    lean: ['locate', 'history', 'scout:core-exports', 'outer:1/research:npm'],
  })
  const before = hexed(snapshot(dir))
  const p = plan(dir)
  assert.deepEqual([p.runs, p.refused], [[], []])
  assert.deepEqual(apply(p), { applied: 0, error: '' })
  assert.deepEqual(hexed(snapshot(dir)), before)
  assert.equal(runState(dir, RUN).state, 'stopped')
})

test('a lean spec beside a navigator spec makes the search new', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { lean: ['locate'], navigator: ['locate'] })
  assert.deepEqual(plan(dir).runs, [])
})

test('a lean spec by any server-*.json name counts, and a file of another name does not', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [['locate', 'scout'], ['common', 'scout']] })
  leanSearch(dir, runDir(dir, RUN), 'locate', 'server-0123abcd.json')
  leanSearch(dir, runDir(dir, RUN), 'common', 'spec.json')
  assert.deepEqual(plan(dir).runs.map((r) => r.threads), [['common']])
})

test('a malformed server spec counts as an old search', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [['locate', 'scout'], ['common', 'scout']], lean: ['common'] })
  put(join(searchDir(runDir(dir, RUN), 'locate'), 'server-x.json'), '{"tree": {"root": ')
  let p
  assert.doesNotThrow(() => { p = plan(dir) })
  assert.deepEqual(p.runs, [{ run: RUN, program: 'probe', threads: ['locate'] }])
})

test('a search with no directory counts as old', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [['locate', 'scout'], ['common', 'scout']], lean: ['locate', 'common'] })
  rmSync(searchDir(runDir(dir, RUN), 'common'), { recursive: true, force: true })
  assert.deepEqual(plan(dir).runs, [{ run: RUN, program: 'probe', threads: ['common'] }])
})

test('a search directory holding no spec counts as old', (t) => {
  const dir = store(t)
  programRun(dir)
  mkdirSync(searchDir(runDir(dir, RUN), 'locate'), { recursive: true })
  put(join(searchDir(runDir(dir, RUN), 'locate'), 'calls.jsonl'), '')
  assert.deepEqual(plan(dir).runs.map((r) => r.threads), [['locate']])
})

test("a lean spec under another run's home does not make this run's search new", (t) => {
  const dir = store(t)
  programRun(dir, RUN_A, { threads: [['plan', 'analyst']], lean: ['locate'] })
  programRun(dir)
  assert.deepEqual(plan(dir).runs.map((r) => r.run), [RUN])
})

test('a run the 5.4.1 migration faulted is not faulted again', (t) => {
  const dir = store(t)
  programRun(dir)
  ok(appendRun(dir, RUN, { kind: 'fault', node: '', channel: 'program', detail: 'migrate-search-ledger: 1 of its searches ran in rounds' }))
  assert.equal(runState(dir, RUN).state, 'stopped')
  const p = plan(dir)
  assert.deepEqual([p.runs, p.refused], [[], []])
  const before = readFileSync(runLogPath(dir, RUN))
  assert.deepEqual(apply(p), { applied: 0, error: '' })
  assert.deepEqual(readFileSync(runLogPath(dir, RUN)), before)
})

test('a run the 5.4.1 migration faults between the plan and the apply gets nothing from the apply', (t) => {
  const dir = store(t)
  programRun(dir)
  const p = plan(dir)
  assert.deepEqual(p.runs.map((r) => r.run), [RUN])
  ok(appendRun(dir, RUN, { kind: 'fault', node: '', channel: 'program', detail: 'migrate-search-ledger: 1 of its searches ran in rounds' }))
  const before = readFileSync(runLogPath(dir, RUN))
  assert.deepEqual(apply(p), { applied: 0, error: '' })
  assert.deepEqual(readFileSync(runLogPath(dir, RUN)), before)
})

test('the migration fault names how many of the run searches are old', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [['locate', 'scout'], ['common', 'scout'], ['history', 'historian']], lean: ['history'] })
  assert.equal(apply(plan(dir)).error, '')
  assert.deepEqual(sinceRun(dir).filter((e) => e.kind === 'fault').map((e) => e.detail),
    ['migrate-v56: 2 of its searches are in a shape 5.6.0 does not read; start the program again'])
})

test('a 5.4.1 migration fault from before the latest run does not stand for that run', (t) => {
  const dir = store(t)
  mkdirSync(runDir(dir, RUN), { recursive: true })
  put(runJsonPath(dir, RUN), runMeta(RUN, 'probe', false))
  ok(appendRun(dir, RUN, { kind: 'run', program: 'probe', scope: {}, pid: DEAD_PID }))
  ok(appendRun(dir, RUN, { kind: 'fault', node: '', channel: 'program', detail: 'migrate-search-ledger: earlier' }))
  ok(appendRun(dir, RUN, { kind: 'run', program: 'probe', scope: {}, pid: DEAD_PID }))
  ok(appendRun(dir, RUN, dispatched('locate', 'scout')))
  assert.deepEqual(plan(dir).runs.map((r) => r.run), [RUN])
})

test('a finished program keeps its result', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { ended: true, navigator: ['locate'] })
  programRun(dir, RUN_B, { program: 'survey', threads: [['common', 'scout']] })
  ok(appendRun(dir, RUN_B, { kind: 'ended', result: { status: 'done', file: '', complete: true } }))
  const before = [readFileSync(runLogPath(dir, RUN)), readFileSync(runLogPath(dir, RUN_B))]
  const p = plan(dir)
  assert.deepEqual([p.runs, p.refused], [[], []])
  apply(p)
  assert.deepEqual([readFileSync(runLogPath(dir, RUN)), readFileSync(runLogPath(dir, RUN_B))], before)
})

test('a dispatch by a role that is no searcher is no round search', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [['docs', 'analyst'], ['history', 'planner']] })
  assert.deepEqual(plan(dir).runs, [])
})

test('a searcher thread under any other name is no round search', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [['scout', 'scout'], ['guidance', 'scout'], ['repository', 'scout'], ['locate-2', 'scout']] })
  assert.deepEqual(plan(dir).runs, [])
})


// ------------------------------------------------------------------ program runs

test('apply gives a stopped run a program fault, then a failed end, after which it reads as ended', (t) => {
  const dir = store(t)
  programRun(dir)
  const out = apply(plan(dir))
  assert.equal(out.error, '')
  assert.equal(out.applied, 2)
  const since = sinceRun(dir)
  const faults = since.filter((e) => e.kind === 'fault')
  assert.equal(faults.length, 1)
  assert.equal(faults[0].node, '')
  assert.equal(faults[0].channel, 'program')
  assert.match(faults[0].detail, /^migrate-v56:/)
  assert.deepEqual(since.filter((e) => e.kind === 'ended').map((e) => e.result), [{ status: 'failed', file: '', complete: false }])
  assert.ok(since.findIndex((e) => e.kind === 'fault') < since.findIndex((e) => e.kind === 'ended'), 'the fault comes first')
  assert.equal(runState(dir, RUN).state, 'ended')
})

test('an ended run is not listed', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { ended: true })
  const p = plan(dir)
  assert.deepEqual([p.runs, p.refused], [[], []])
})

test('a run with no run.json is not listed', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { meta: false })
  const p = plan(dir)
  assert.deepEqual([p.runs, p.refused], [[], []])
})

test('a live run holding a round search is refused, and apply writes nothing to it', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { live: true })
  const p = plan(dir)
  assert.deepEqual(p.runs, [])
  assert.equal(p.refused.length, 1)
  assert.ok(p.refused[0].what.includes(RUN), p.refused[0].what)
  assert.match(p.refused[0].why, /live/)
  const before = readFileSync(runLogPath(dir, RUN))
  apply(p)
  assert.deepEqual(readFileSync(runLogPath(dir, RUN)), before)
})

test('a live run holding no round search is not refused', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { live: true, threads: [['plan', 'analyst']] })
  assert.deepEqual(plan(dir).refused, [])
})

test('a run that went live after the plan is not written', (t) => {
  const dir = store(t)
  programRun(dir)
  const p = plan(dir)
  put(runJsonPath(dir, RUN), runMeta(RUN, 'probe', true))
  const before = readFileSync(runLogPath(dir, RUN))
  assert.equal(apply(p).applied, 0)
  assert.deepEqual(readFileSync(runLogPath(dir, RUN)), before)
})

// ------------------------------------------------------------------ open executions

test('a folder of an open execution holding a round probe search is planned', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  assert.deepEqual(plan(dir).folders, [{ effort: E, execution: OPEN, folder: 'f', threads: ['probe:f:3/locate'] }])
})

test("a nested folder's round survey searches are planned under that folder, each once", (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'survey:f/x/scout:dead-code')
  searched(dir, 'survey:f/x/common')
  searched(dir, 'survey:f/x/history', 'historian')
  searched(dir, 'survey:f/x/docs', 'doc-researcher')
  searched(dir, 'survey:f/x/history', 'historian')
  assert.deepEqual(plan(dir).folders, [{
    effort: E, execution: OPEN, folder: 'f/x',
    threads: ['survey:f/x/common', 'survey:f/x/docs', 'survey:f/x/history', 'survey:f/x/scout:dead-code'],
  }])
})

test("the root folder's round search is planned under the root", (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:.:2/locate')
  assert.deepEqual(folderIds(plan(dir)), ['.'])
})

test('each folder holding a round search is planned on its own, in id order', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f:1/locate')
  searched(dir, 'survey:c/common')
  assert.deepEqual(folderIds(plan(dir)), ['c', 'f'])
})

test('apply writes one migration replan per planned folder, under its execution, newer than its round searches', (t) => {
  const dir = store(t)
  execution(dir)
  const last = Math.max(searched(dir, 'probe:f:3/locate'), searched(dir, 'survey:f/history', 'historian'))
  const out = apply(plan(dir))
  assert.equal(out.error, '')
  const written = replans(dir, 'f')
  assert.equal(written.length, 1)
  assert.deepEqual({ ...written[0], seq: 0 }, { kind: 'replanned', node: 'f', execution: OPEN, reason: 'retry_escalated', by: 'migration', seq: 0 })
  assert.ok(written[0].seq > last)
})

test('apply leaves every derived status as it was', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  searched(dir, 'survey:c/scout:t')
  searched(dir, 'probe:.:1/locate')
  const before = statuses(dir)
  assert.equal(apply(plan(dir)).error, '')
  assert.deepEqual(statuses(dir), before)
})

test('a closed execution is not looked at', (t) => {
  const dir = store(t)
  execution(dir, CLOSED, { closed: true })
  searched(dir, 'probe:f:1/locate', 'scout', CLOSED)
  const p = plan(dir)
  assert.deepEqual([p.folders, p.excluded, p.left, p.refused], [[], [], [], []])
})

test('a live execution holding a round search is refused, and none of its folders is planned or written', (t) => {
  const dir = store(t)
  execution(dir, LIVE, { live: true })
  searched(dir, 'probe:f:1/locate', 'scout', LIVE)
  const p = plan(dir)
  assert.deepEqual(p.folders, [])
  assert.ok(p.refused.some((r) => r.what.includes(LIVE) && /live/.test(r.why)), JSON.stringify(p.refused))
  apply(p)
  assert.deepEqual(replans(dir, 'f'), [])
})

test('an execution that went live after the plan is not written', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  const p = plan(dir)
  put(runJsonPath(dir, executionRunId(E, OPEN)), runMeta(executionRunId(E, OPEN), 'execute', true))
  assert.equal(apply(p).applied, 0)
  assert.deepEqual(replans(dir, 'f'), [])
})

test('a folder whose navigator search has a ground step beside it is planned: it is old', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f:4/locate')
  stateLine(dir, { kind: 'step', key: 'probe:f:4/locate/ground', value: { rows: 0 } })
  navigatorSearch(dir, execHome(dir), 'probe:f:4/locate')
  assert.deepEqual(plan(dir).folders, [{ effort: E, execution: OPEN, folder: 'f', threads: ['probe:f:4/locate'] }])
})

test('a folder whose searches all have a lean spec in its execution home is not planned', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f:4/locate')
  searched(dir, 'survey:c/scout:t')
  leanSearch(dir, execHome(dir), 'probe:f:4/locate')
  leanSearch(dir, execHome(dir), 'survey:c/scout:t')
  const p = plan(dir)
  assert.deepEqual([p.folders, p.excluded, p.left, p.refused], [[], [], [], []])
})

test("a folder survey's search under its basis is attributed to the folder", (t) => {
  const dir = store(t)
  execution(dir)
  const thread = 'survey:f:answer:a/b:needs_context:4/scout:loader'
  searched(dir, thread)
  const p = plan(dir)
  assert.deepEqual(p.folders, [{ effort: E, execution: OPEN, folder: 'f', threads: [thread] }])
  assert.deepEqual(p.left, [])
  assert.deepEqual(apply(p), { applied: 1, error: '' })
  assert.equal(replans(dir, 'f').length, 1)
})

test("a nested folder survey's search under its basis is attributed to the nested folder", (t) => {
  const dir = store(t)
  execution(dir)
  const thread = 'survey:f/x:answer:a/b:needs_context:4/scout:loader'
  searched(dir, thread)
  assert.deepEqual(byFolder(plan(dir), 'folders'), { 'f/x': [thread] })
})

test("a folder survey's search under its basis with a lean spec is left alone", (t) => {
  const dir = store(t)
  execution(dir)
  const thread = 'survey:f:answer:a/b:needs_context:4/scout:loader'
  searched(dir, thread)
  leanSearch(dir, execHome(dir), thread)
  assert.deepEqual(plan(dir).folders, [])
})

test('a folder no live node holds is left with why, and not planned', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:gone:1/locate')
  const p = plan(dir)
  assert.deepEqual(p.folders, [])
  assert.deepEqual(p.left.map((x) => [x.folder, x.threads]), [['gone', ['probe:gone:1/locate']]])
  assert.ok(typeof p.left[0].why === 'string' && p.left[0].why.length > 0)
})

test('a round search naming no folder is left with why', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'locate')
  const p = plan(dir)
  assert.deepEqual(p.left.map((x) => [x.folder, x.threads]), [['', ['locate']]])
  assert.ok(p.left[0].why.length > 0)
})

test('a folder retried after its round searches is not listed', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:p:2/locate')
  event(dir, 'escalated', 'p', { reason: 'blocked', detail: 'p is blocked', said: '' })
  retried(dir, 'p')
  const p = plan(dir)
  for (const part of ['folders', 'excluded', 'left']) assert.ok(!p[part].some((x) => x.folder === 'p'), part)
})

test('a folder that gained a stop after the plan is not written', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  const p = plan(dir)
  assert.deepEqual(folderIds(p), ['f'])
  event(dir, 'escalated', 'f', { reason: 'blocked', detail: 'f is blocked', said: '' })
  apply(p)
  assert.deepEqual(replans(dir, 'f'), [])
  assert.equal(readTree(dir, E).status.get('f').status, 'escalated')
})

// ------------------------------------------------------------------ excluded folders

test('a folder with an open escalation is excluded, listing its status change', (t) => {
  const dir = store(t)
  execution(dir)
  event(dir, 'escalated', 'p', { reason: 'blocked', detail: 'p is blocked', said: '' })
  searched(dir, 'probe:p:2/locate')
  const p = plan(dir)
  assert.deepEqual(p.folders, [])
  assert.deepEqual(p.excluded.map((x) => [x.effort, x.execution, x.folder, x.threads]), [[E, OPEN, 'p', ['probe:p:2/locate']]])
  assert.ok(p.excluded[0].changes.some((c) => c.derivation === 'status' && c.node === 'p' && c.before === 'escalated' && c.after !== 'escalated'),
    JSON.stringify(p.excluded[0].changes))
})

test('a folder with an open park is excluded, listing its status change', (t) => {
  const dir = store(t)
  execution(dir)
  event(dir, 'parked', 'k', { return: 'needs_decision', question: 'which k?', said: '' })
  searched(dir, 'survey:k/scout:t')
  const x = plan(dir).excluded.find((e) => e.folder === 'k')
  assert.ok(x, 'k is excluded')
  assert.ok(x.changes.some((c) => c.derivation === 'status' && c.node === 'k' && c.before === 'parked' && c.after !== 'parked'), JSON.stringify(x.changes))
})

test('a folder with an unanswered ruling is excluded, listing the ruling it would answer', (t) => {
  const dir = store(t)
  execution(dir)
  const ruled = stateLine(dir, { kind: 'drift-ruled', node: 'q', contract: 'q-api', head_sha: SHA, ruling: 'affected', why: 'the api moved', said: '' })
  searched(dir, 'survey:q/common')
  const x = plan(dir).excluded.find((e) => e.folder === 'q')
  assert.ok(x, 'q is excluded')
  assert.ok(x.changes.some((c) => c.derivation === 'ruling' && c.node === 'q' && c.seq === ruled && c.before === false && c.after === true),
    JSON.stringify(x.changes))
})

test('a folder whose integration review stands is excluded, listing the review it would outdate', (t) => {
  const dir = store(t)
  execution(dir)
  event(dir, 'merged', 'r/a', { head_sha: SHA })
  const claims = event(dir, 'claims', 'r', { head_sha: SHA, review: 'done', said: '', claims: [{ claim: 'r holds', ruling: 'met' }] })
  searched(dir, 'probe:r:5/locate')
  const x = plan(dir).excluded.find((e) => e.folder === 'r')
  assert.ok(x, 'r is excluded')
  assert.ok(x.changes.some((c) => c.derivation === 'review' && c.node === 'r' && c.before === claims && c.after === null), JSON.stringify(x.changes))
})

test('each excluded folder lists retry, naming the session retry of that folder, and discard', (t) => {
  const dir = store(t)
  eligibleAndExcluded(dir)
  const [x] = plan(dir).excluded
  assert.deepEqual(x.options.map((o) => o.option), ['retry', 'discard'])
  const retry = x.options[0].how
  for (const part of ['boundary.mjs', ' retry ', '--repo', '--effort ' + E, '--node p']) assert.ok(retry.includes(part), part + ' in ' + retry)
  assert.ok(typeof x.options[1].how === 'string' && x.options[1].how.length > 0)
})

test('apply writes nothing for an excluded folder', (t) => {
  const dir = store(t)
  eligibleAndExcluded(dir)
  const out = apply(plan(dir))
  assert.equal(out.error, '')
  assert.deepEqual(replans(dir, 'p'), [])
  assert.equal(replans(dir, 'f').length, 1)
  assert.equal(readTree(dir, E).status.get('p').status, 'escalated')
})

test('a stop cleared before the round searches does not exclude its folder', (t) => {
  const dir = store(t)
  execution(dir)
  event(dir, 'escalated', 'c', { reason: 'blocked', detail: 'c was blocked', said: '' })
  retried(dir, 'c')
  searched(dir, 'probe:c:4/locate')
  const p = plan(dir)
  assert.deepEqual(folderIds(p), ['c'])
  assert.deepEqual(p.excluded, [])
})

// ------------------------------------------------------------------ the dry run and the CLI

test('a dry run writes nothing, and a plan is a function of the disk', (t) => {
  const dir = store(t)
  programRun(dir)
  eligibleAndExcluded(dir)
  const before = hexed(snapshot(dir))
  const p = plan(dir)
  assert.deepEqual(hexed(snapshot(dir)), before)
  assert.deepEqual(plan(dir), p)
})

test('the CLI without --yes prints applied 0 beside the plan, writes nothing and exits 0 when nothing is excluded', { timeout: 90_000 }, (t) => {
  const dir = store(t)
  programRun(dir)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  const before = hexed(snapshot(dir))
  const r = cli(dir, dir)
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.applied, 0)
  assert.equal(out.error, '')
  for (const key of ['root', 'runs', 'folders', 'excluded', 'left', 'refused']) assert.ok(key in out, key + ' is printed')
  assert.deepEqual(out.runs, plan(dir).runs)
  assert.deepEqual(out.folders, plan(dir).folders)
  assert.deepEqual(hexed(snapshot(dir)), before)
})

test('the CLI with --yes prints how many records it appended, and exits 0 when nothing remains', { timeout: 90_000 }, (t) => {
  const dir = store(t)
  programRun(dir)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  const lines = totalLines(dir)
  const r = cli(dir, dir, '--yes')
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.error, '')
  assert.equal(out.applied, 3)
  assert.equal(out.applied, totalLines(dir) - lines)
})

test('the CLI exits 1 while an excluded folder remains, dry run and --yes alike', { timeout: 120_000 }, (t) => {
  const dir = store(t)
  eligibleAndExcluded(dir)
  const dry = cli(dir, dir)
  assert.equal(dry.status, 1, dry.stderr)
  assert.equal(JSON.parse(dry.stdout).excluded.length, 1)
  const wet = cli(dir, dir, '--yes')
  assert.equal(wet.status, 1, wet.stderr)
  assert.equal(JSON.parse(wet.stdout).excluded.length, 1)
})

test('the CLI exits 0 once the user retried the excluded folder', { timeout: 90_000 }, (t) => {
  const dir = store(t)
  eligibleAndExcluded(dir)
  retried(dir, 'p')
  const r = cli(dir, dir)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).excluded, [])
})

test('the CLI exits 1 while a live home is refused', { timeout: 90_000 }, (t) => {
  const dir = store(t)
  programRun(dir, RUN, { live: true })
  const r = cli(dir, dir)
  assert.equal(r.status, 1, r.stderr)
  assert.equal(JSON.parse(r.stdout).refused.length, 1)
})

test('a folder left with no live node does not fail the CLI', { timeout: 90_000 }, (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:gone:1/locate')
  const r = cli(dir, dir)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).left.length, 1)
})

test('the CLI exits 1 and prints what it appended and why when the ledger refuses partway', { timeout: 90_000 }, (t) => {
  const dir = store(t)
  programRun(dir)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  blockEffortSeq(dir)
  const r = cli(dir, dir, '--yes')
  assert.equal(r.status, 1, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.applied, 2, 'the run was written before the folder was refused')
  assert.match(out.error, /refused/)
})

// ------------------------------------------------------------------ a second run, and a run cut short

test('a second plan after apply lists no run and no folder, and still lists what it excluded', (t) => {
  const dir = store(t)
  programRun(dir)
  eligibleAndExcluded(dir)
  const first = plan(dir)
  apply(first)
  const second = plan(dir)
  assert.deepEqual([second.runs, second.folders], [[], []])
  assert.deepEqual(second.excluded, first.excluded)
})

test('applying the same plan twice appends nothing the second time', (t) => {
  const dir = store(t)
  programRun(dir)
  eligibleAndExcluded(dir)
  const p = plan(dir)
  apply(p)
  const lines = totalLines(dir)
  assert.deepEqual(apply(p), { applied: 0, error: '' })
  assert.equal(totalLines(dir), lines)
})

test('an apply cut short to its runs is finished by the next, each record once', (t) => {
  const dir = store(t)
  programRun(dir)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  const p1 = plan(dir)
  apply({ ...p1, folders: [] })
  const p2 = plan(dir)
  assert.deepEqual(p2.runs, [])
  assert.deepEqual(p2.folders, p1.folders)
  apply(p2)
  const p3 = plan(dir)
  assert.deepEqual([p3.runs, p3.folders], [[], []])
  assert.equal(replans(dir, 'f').length, 1)
  assert.equal(sinceRun(dir).filter((e) => e.kind === 'fault').length, 1)
})

test('an apply the ledger refuses partway returns what it appended and why, and the next run finishes the rest', (t) => {
  const dir = store(t)
  programRun(dir)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  const p = plan(dir)
  blockEffortSeq(dir)
  const lines = totalLines(dir)
  const first = apply(p)
  assert.match(first.error, /refused/)
  assert.equal(first.applied, 2)
  assert.equal(first.applied, totalLines(dir) - lines)
  rmSync(join(effortStateDir(dir, E), 'seq'), { recursive: true, force: true })
  const second = apply(plan(dir))
  assert.deepEqual(second, { applied: 1, error: '' })
  const third = plan(dir)
  assert.deepEqual([third.runs, third.folders], [[], []])
})

test('a run whose migration fault landed and whose end tore gets only its end', (t) => {
  const dir = store(t)
  programRun(dir)
  ok(appendRun(dir, RUN, { kind: 'fault', node: '', channel: 'program', detail: 'migrate-v56: cut short' }))
  appendFileSync(runLogPath(dir, RUN), '{"kind":"ended","result":{"stat')
  assert.deepEqual(plan(dir).runs.map((r) => r.run), [RUN])
  assert.deepEqual(apply(plan(dir)), { applied: 1, error: '' })
  const since = sinceRun(dir)
  assert.equal(since.filter((e) => e.kind === 'fault').length, 1)
  assert.equal(since.filter((e) => e.kind === 'ended').length, 1)
  assert.equal(runState(dir, RUN).state, 'ended')
})

test('a torn migration replan leaves its folder planned, and the next apply writes it once', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  appendFileSync(join(effortStateDir(dir, E), 'events.jsonl'), '{"kind":"replanned","node":"f","exec')
  assert.deepEqual(folderIds(plan(dir)), ['f'])
  assert.deepEqual(apply(plan(dir)), { applied: 1, error: '' })
  assert.equal(replans(dir, 'f').length, 1)
  assert.deepEqual(plan(dir).folders, [])
})

test('apply only appends: every file there before keeps its bytes as a prefix', (t) => {
  const dir = store(t)
  programRun(dir)
  eligibleAndExcluded(dir)
  const before = snapshot(dir)
  apply(plan(dir))
  const after = snapshot(dir)
  for (const [rel, bytes] of before) {
    assert.ok(after.has(rel), rel + ' survives')
    if (bytes === null || rel === 'seq' || rel.endsWith('/seq')) continue
    assert.ok(after.get(rel).subarray(0, bytes.length).equals(bytes), rel + ' only grows')
  }
})

test('a store with a stopped program run and an open execution migrates both in one apply', (t) => {
  const dir = store(t)
  programRun(dir)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  searched(dir, 'survey:c/history', 'historian')
  const before = statuses(dir)
  assert.deepEqual(apply(plan(dir)), { applied: 4, error: '' })
  assert.equal(runState(dir, RUN).state, 'ended')
  assert.equal(replans(dir, 'f').length, 1)
  assert.equal(replans(dir, 'c').length, 1)
  assert.deepEqual(statuses(dir), before)
})

// ------------------------------------------------------------------ a linked worktree and the main checkout

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
}

/** A git repository with one commit, a linked worktree beside it, and e1's tree in the main checkout's store. */
function checkouts(t) {
  const base = mkdtempSync(join(tmpdir(), 'agentics-migrate-v56-git-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const main = join(base, 'main')
  mkdirSync(main)
  git(main, 'init', '-q', '-b', 'main')
  writeFileSync(join(main, 'README.md'), 'readme\n')
  git(main, 'add', 'README.md')
  git(main, 'commit', '-q', '-m', 'init')
  const linked = join(base, 'linked')
  git(main, 'worktree', 'add', '-q', '-b', 'side', linked)
  seed(main)
  programRun(main)
  execution(main)
  searched(main, 'probe:f:3/locate')
  return { main, linked }
}

test('a plan made in a linked worktree is the plan made in the main checkout', { timeout: 90_000 }, (t) => {
  const { main, linked } = checkouts(t)
  const fromMain = plan(main)
  const fromLinked = plan(linked)
  assert.equal(realpathSync.native(fromLinked.root), realpathSync.native(fromMain.root))
  assert.deepEqual({ ...fromLinked, root: '' }, { ...fromMain, root: '' })
  assert.deepEqual(fromMain.runs.map((r) => r.run), [RUN])
  assert.deepEqual(folderIds(fromMain), ['f'])
})

test("the CLI run inside a linked worktree with no repo argument migrates the main checkout's store", { timeout: 90_000 }, (t) => {
  const { main, linked } = checkouts(t)
  const r = cli(linked, '--yes')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).applied, 3)
  assert.equal(runState(main, RUN).state, 'ended')
  assert.equal(replans(main, 'f').length, 1)
  assert.equal(existsSync(join(linked, '.agentics')), false, 'nothing is written in the linked worktree')
})

// ------------------------------------------------------------------ adversarial additions
// Each test below pins a sentence of the spec the tests above leave to the implementation's good
// will. They stand apart so one that proves to over-reach can be struck without touching the rest.

const RUN_A = '20261013-080000-probe'
const RUN_B = '20261013-100000-survey'
const OPEN2 = '20261013-120000'
const ruling = (node, said = '') => ({ kind: 'drift-ruled', node, contract: node + '-api', head_sha: SHA, ruling: 'affected', why: 'the api moved', said })
/** The folders (or excluded, or left) of a plan, as `{ folder: threads }`. */
const byFolder = (p, part) => Object.fromEntries(p[part].map((x) => [x.folder, x.threads]))
/** An execution of another effort than e1: its envelope, its run.json and its `run` line. */
function executionOf(dir, effort, stamp) {
  put(join(executionDir(dir, effort, stamp), 'execution.json'), JSON.stringify({
    stamp, root: '.', base_branch: 'main', base_sha: '0'.repeat(40), dial: {}, pace: 'balanced', commands: {},
  }))
  put(runJsonPath(dir, executionRunId(effort, stamp)), runMeta(executionRunId(effort, stamp), 'execute', false))
  ok(append(dir, effort, 'state:' + stamp, { kind: 'run', program: 'execute', scope: { effort, folder: '.' }, pid: DEAD_PID }))
}

// ---- what a round search is, again

test('a thread that only ends in a round name, with no scope prefix before it, is no round search', (t) => {
  const dir = store(t)
  programRun(dir, RUN, {
    threads: [['prelocate', 'scout'], ['mycommon', 'scout'], ['subhistory', 'historian'], ['xdocs', 'doc-researcher'], ['norepo', 'scout'],
      ['xscout:a', 'scout'], ['xresearch:b', 'doc-researcher']],
  })
  const p = plan(dir)
  assert.deepEqual([p.runs, p.refused], [[], []])
})

test('a round search under a scope prefix of several levels is a round search', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [['outer:1/inner:2/locate', 'scout']] })
  assert.deepEqual(plan(dir).runs.map((r) => r.threads), [['outer:1/inner:2/locate']])
})

test('a lean spec opens one thread only: an old search on another thread beside it is still listed', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [['locate', 'scout'], ['common', 'scout']], lean: ['locate'] })
  assert.deepEqual(plan(dir).runs, [{ run: RUN, program: 'probe', threads: ['common'] }])
})

test('the lean spec of an unscoped thread does not open the same name under a scope prefix', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [['outer:1/locate', 'scout']], lean: ['locate'] })
  assert.deepEqual(plan(dir).runs.map((r) => r.threads), [['outer:1/locate']])
})

test('a dispatch by a role that does not load is no round search, and plan does not throw', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [['locate', 'no-such-role']] })
  const p = plan(dir)
  assert.deepEqual([p.runs, p.refused], [[], []])
})

for (const name of ROLE_NAMES) {
  test('a dispatch by the ' + name + ' role is a round search exactly when that role loads as a searcher', (t) => {
    const dir = store(t)
    programRun(dir, RUN, { threads: [['locate', name]] })
    const loaded = loadRole(name)
    const searcher = loaded.ok && loaded.role.kind === 'searcher'
    assert.deepEqual(plan(dir).runs.map((r) => r.threads), searcher ? [['locate']] : [])
  })
}

test('a dispatch line a killed writer tore is no record, so no round search', (t) => {
  const dir = store(t)
  programRun(dir, RUN, { threads: [] })
  appendFileSync(runLogPath(dir, RUN), '{"kind":"dispatched","dispatch":"locate.r1","node":"","round":1,"thread":"locate","role":"scout"')
  assert.equal(readRunLog(dir, RUN).entries.some((e) => e.kind === 'dispatched'), false)
  const p = plan(dir)
  assert.deepEqual([p.runs, p.refused], [[], []])
})

// ---- program runs, again

test('stopped runs are listed in run id order, and a live run refuses only itself', (t) => {
  const dir = store(t)
  programRun(dir, RUN_B, { program: 'survey' })
  programRun(dir, RUN)
  programRun(dir, RUN_A, { live: true })
  const p = plan(dir)
  assert.deepEqual(p.runs, [{ run: RUN, program: 'probe', threads: ['locate'] }, { run: RUN_B, program: 'survey', threads: ['locate'] }])
  assert.equal(p.refused.length, 1)
  assert.ok(p.refused[0].what.includes(RUN_A), p.refused[0].what)
})

test('a run whose run.json is not JSON is not listed', (t) => {
  const dir = store(t)
  programRun(dir)
  put(runJsonPath(dir, RUN), '{"run": "20261013-0900')
  const p = plan(dir)
  assert.deepEqual([p.runs, p.refused], [[], []])
})

test('a migration fault from before the latest run does not stand for that run', (t) => {
  const dir = store(t)
  mkdirSync(runDir(dir, RUN), { recursive: true })
  put(runJsonPath(dir, RUN), runMeta(RUN, 'probe', false))
  ok(appendRun(dir, RUN, { kind: 'run', program: 'probe', scope: {}, pid: DEAD_PID }))
  ok(appendRun(dir, RUN, { kind: 'fault', node: '', channel: 'program', detail: 'migrate-v56: an earlier attempt' }))
  ok(appendRun(dir, RUN, { kind: 'run', program: 'probe', scope: {}, pid: DEAD_PID }))
  ok(appendRun(dir, RUN, dispatched('locate', 'scout')))
  assert.equal(runState(dir, RUN).state, 'stopped')
  assert.deepEqual(plan(dir).runs.map((r) => r.run), [RUN])
  assert.deepEqual(apply(plan(dir)), { applied: 2, error: '' })
  const since = sinceRun(dir)
  assert.equal(since.filter((e) => e.kind === 'fault').length, 1)
  assert.equal(since.filter((e) => e.kind === 'ended').length, 1)
  assert.equal(runState(dir, RUN).state, 'ended')
})

// ---- open executions, again

test('a nested probe folder, the root survey and a research survey search are each planned under their folder', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f/x:2/locate')
  searched(dir, 'survey:./common')
  searched(dir, 'survey:c/research:npm-packages', 'doc-researcher')
  const p = plan(dir)
  assert.deepEqual(p.folders.map((f) => [f.folder, f.threads]).sort(([a], [b]) => (a < b ? -1 : 1)), [
    ['.', ['survey:./common']], ['c', ['survey:c/research:npm-packages']], ['f/x', ['probe:f/x:2/locate']],
  ])
  assert.deepEqual(p.left, [])
})

test('a leaf holds no folder: a round search that names one is left, not planned', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f/a:1/locate')
  const p = plan(dir)
  assert.deepEqual(p.folders, [])
  assert.deepEqual(byFolder(p, 'left'), { 'f/a': ['probe:f/a:1/locate'] })
})

test('a design node is a folder', (t) => {
  const dir = store(t)
  assert.equal(seedTree(dir, E, [{ id: 'dn', kind: 'design', title: 'a design node' }]).ok, true)
  execution(dir)
  searched(dir, 'survey:dn/common')
  const p = plan(dir)
  assert.deepEqual(folderIds(p), ['dn'])
  assert.deepEqual(p.left, [])
})

test('a retired folder is left, not planned', (t) => {
  const dir = store(t)
  assert.equal(seedTree(dir, E, [{ id: 'c/a', kind: 'leaf', title: 'gone', retired: true }, { id: 'c', kind: 'composite', title: 'gone', retired: true }]).ok, true)
  assert.equal(readTree(dir, E).nodes.has('c'), false)
  execution(dir)
  searched(dir, 'survey:c/common')
  const p = plan(dir)
  assert.deepEqual(p.folders, [])
  assert.deepEqual(byFolder(p, 'left'), { c: ['survey:c/common'] })
})

test('a round search journaled under a stamp that has no execution is no open execution\'s', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f:1/locate', 'scout', '20261013-130000')
  const p = plan(dir)
  assert.deepEqual([p.folders, p.excluded, p.left, p.refused], [[], [], [], []])
})

test('a round search belongs to the execution whose home holds it', (t) => {
  const dir = store(t)
  execution(dir)
  execution(dir, OPEN2)
  searched(dir, 'probe:f:3/locate', 'scout', OPEN2)
  assert.deepEqual(plan(dir).folders, [{ effort: E, execution: OPEN2, folder: 'f', threads: ['probe:f:3/locate'] }])
})

test('folders are listed by execution, then by folder', (t) => {
  const dir = store(t)
  execution(dir)
  execution(dir, OPEN2)
  searched(dir, 'survey:c/common', 'scout', OPEN2)
  searched(dir, 'probe:f:1/locate', 'scout', OPEN)
  assert.deepEqual(plan(dir).folders.map((f) => [f.execution, f.folder]), [[OPEN, 'f'], [OPEN2, 'c']])
})

test('a lean spec in another execution\'s home does not open this execution\'s search', (t) => {
  const dir = store(t)
  execution(dir)
  execution(dir, OPEN2)
  searched(dir, 'probe:f:4/locate')
  leanSearch(dir, execHome(dir, OPEN2), 'probe:f:4/locate')
  assert.deepEqual(folderIds(plan(dir)), ['f'])
})

test('an execution whose run ended and never closed is still open', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  stateLine(dir, { kind: 'ended', result: { status: 'failed', file: '', complete: false } })
  assert.equal(runState(dir, executionRunId(E, OPEN)).state, 'ended')
  assert.deepEqual(folderIds(plan(dir)), ['f'])
})

test('a refused live execution is named as the interface spells it: execution <effort>/<stamp>', (t) => {
  const dir = store(t)
  execution(dir, LIVE, { live: true })
  searched(dir, 'probe:f:1/locate', 'scout', LIVE)
  assert.deepEqual(plan(dir).refused.map((r) => r.what), ['execution ' + E + '/' + LIVE])
})

test('a live execution holding no round search is not refused', (t) => {
  const dir = store(t)
  execution(dir, LIVE, { live: true })
  assert.deepEqual(plan(dir).refused, [])
})

test('a live execution refuses only itself: another open execution\'s folder is still planned', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  execution(dir, LIVE, { live: true })
  searched(dir, 'probe:c:1/locate', 'scout', LIVE)
  const p = plan(dir)
  assert.deepEqual(p.folders, [{ effort: E, execution: OPEN, folder: 'f', threads: ['probe:f:3/locate'] }])
  assert.equal(p.refused.length, 1)
  assert.ok(p.refused[0].what.includes(LIVE), p.refused[0].what)
})

test('every effort of the store is searched for open executions, and apply writes into each', (t) => {
  const dir = store(t)
  assert.equal(seedTree(dir, 'e0', NODES).ok, true)
  executionOf(dir, 'e0', OPEN)
  ok(append(dir, 'e0', 'events', { ...dispatched('probe:f:3/locate', 'scout'), execution: OPEN }))
  execution(dir)
  searched(dir, 'probe:c:1/locate')
  const p = plan(dir)
  assert.deepEqual(p.folders.map((f) => [f.effort, f.execution, f.folder]), [['e0', OPEN, 'f'], [E, OPEN, 'c']])
  assert.deepEqual(apply(p), { applied: 2, error: '' })
  assert.equal(readLog(dir, 'e0', 'events').entries.filter((e) => e.kind === 'replanned' && e.node === 'f' && e.by === 'migration').length, 1)
  assert.equal(replans(dir, 'c').length, 1)
})

test('every round search of an open execution lands in exactly one part, or needs nothing', (t) => {
  const dir = store(t)
  execution(dir)
  event(dir, 'escalated', 'p', { reason: 'blocked', detail: 'p is blocked', said: '' })
  event(dir, 'parked', 'k', { return: 'needs_decision', question: 'which k?', said: '' })
  searched(dir, 'probe:f:3/locate')
  searched(dir, 'probe:p:2/locate')
  searched(dir, 'survey:k/scout:t')
  searched(dir, 'probe:gone:1/locate')
  searched(dir, 'survey:c/common')
  searched(dir, 'locate')
  retried(dir, 'c')
  const p = plan(dir)
  assert.deepEqual(byFolder(p, 'folders'), { f: ['probe:f:3/locate'] })
  assert.deepEqual(byFolder(p, 'excluded'), { p: ['probe:p:2/locate'], k: ['survey:k/scout:t'] })
  assert.deepEqual(byFolder(p, 'left'), { gone: ['probe:gone:1/locate'], '': ['locate'] })
  assert.deepEqual(apply(p), { applied: 1, error: '' })
  assert.deepEqual(events(dir).filter((e) => e.kind === 'replanned' && e.by === 'migration').map((e) => e.node), ['f'])
})

// ---- the retry a folder needs nothing after

test('a retry of another folder does not clear a folder', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  retried(dir, 'c')
  assert.deepEqual(folderIds(plan(dir)), ['f'])
})

test('a round search newer than the last retry makes its folder due again', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  retried(dir, 'f')
  const last = searched(dir, 'probe:f:4/locate')
  const p = plan(dir)
  assert.deepEqual(folderIds(p), ['f'])
  assert.ok(p.folders[0].threads.includes('probe:f:4/locate'), JSON.stringify(p.folders[0].threads))
  assert.deepEqual(apply(p), { applied: 1, error: '' })
  assert.ok(replans(dir, 'f')[0].seq > last)
})

test('a retry between the plan and the apply leaves the folder unwritten and uncounted', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  const p = plan(dir)
  assert.deepEqual(folderIds(p), ['f'])
  retried(dir, 'f')
  assert.equal(apply(p).applied, 0)
  assert.deepEqual(replans(dir, 'f'), [])
})

// ---- rulings and reviews

test('an answered ruling does not exclude its folder', (t) => {
  const dir = store(t)
  execution(dir)
  stateLine(dir, ruling('q'))
  retried(dir, 'q')
  searched(dir, 'survey:q/common')
  const p = plan(dir)
  assert.deepEqual(folderIds(p), ['q'])
  assert.deepEqual(p.excluded, [])
})

test('a ruling in a closed execution\'s state does not exclude a folder', (t) => {
  const dir = store(t)
  execution(dir, CLOSED, { closed: true })
  stateLine(dir, ruling('q'), CLOSED)
  execution(dir)
  searched(dir, 'survey:q/common')
  const p = plan(dir)
  assert.deepEqual(folderIds(p), ['q'])
  assert.deepEqual(p.excluded, [])
})

test('an unanswered ruling in another open execution excludes the folder its replan would answer it on', (t) => {
  const dir = store(t)
  execution(dir)
  execution(dir, OPEN2)
  const ruled = stateLine(dir, ruling('q'), OPEN2)
  searched(dir, 'survey:q/common')
  const p = plan(dir)
  assert.deepEqual(p.folders, [])
  assert.deepEqual(p.excluded.map((x) => [x.execution, x.folder]), [[OPEN, 'q']])
  assert.ok(p.excluded[0].changes.some((c) => c.derivation === 'ruling' && c.node === 'q' && c.seq === ruled && c.before === false && c.after === true),
    JSON.stringify(p.excluded[0].changes))
})

test('a merged folder whose review stands is excluded on its review alone', (t) => {
  const dir = store(t)
  execution(dir)
  event(dir, 'merged', 'r/a', { head_sha: SHA })
  const claims = event(dir, 'claims', 'r', { head_sha: SHA, review: 'done', said: '', claims: [{ claim: 'r holds', ruling: 'met' }] })
  event(dir, 'merged', 'r', { head_sha: SHA })
  searched(dir, 'probe:r:5/locate')
  assert.equal(readTree(dir, E).status.get('r').status, 'merged')
  const x = plan(dir).excluded.find((e) => e.folder === 'r')
  assert.ok(x, 'r is excluded')
  assert.equal(x.changes.length, 1, JSON.stringify(x.changes))
  assert.ok(x.changes.some((c) => c.derivation === 'review' && c.node === 'r' && c.before === claims && c.after === null), JSON.stringify(x.changes))
})

test('a folder that gained an unanswered ruling after the plan is not written', (t) => {
  const dir = store(t)
  execution(dir)
  searched(dir, 'survey:q/common')
  const p = plan(dir)
  assert.deepEqual(folderIds(p), ['q'])
  stateLine(dir, ruling('q'))
  assert.equal(apply(p).applied, 0)
  assert.deepEqual(replans(dir, 'q'), [])
})

test('a folder whose review began to stand after the plan is not written', (t) => {
  const dir = store(t)
  execution(dir)
  event(dir, 'merged', 'r/a', { head_sha: SHA })
  event(dir, 'merged', 'r', { head_sha: SHA })
  searched(dir, 'probe:r:5/locate')
  const p = plan(dir)
  assert.deepEqual(folderIds(p), ['r'])
  event(dir, 'claims', 'r', { head_sha: SHA, review: 'done', said: '', claims: [{ claim: 'r holds', ruling: 'met' }] })
  assert.equal(readTree(dir, E).status.get('r').status, 'merged')
  assert.equal(apply(p).applied, 0)
  assert.deepEqual(replans(dir, 'r'), [])
})

test('an excluded folder lists every derivation its replan would move, and nothing that stays', (t) => {
  const dir = store(t)
  execution(dir)
  event(dir, 'escalated', 'p', { reason: 'blocked', detail: 'p is blocked', said: '' })
  const ruled = stateLine(dir, ruling('p'))
  searched(dir, 'probe:p:2/locate')
  const [x] = plan(dir).excluded
  assert.ok(x, 'p is excluded')
  const has = (want) => x.changes.some((c) => Object.entries(want).every(([k, v]) => c[k] === v))
  assert.ok(has({ derivation: 'status', node: 'p', before: 'escalated', after: 'planned' }), JSON.stringify(x.changes))
  assert.ok(has({ derivation: 'status', node: '.', before: 'escalated', after: 'planned' }), JSON.stringify(x.changes))
  assert.ok(has({ derivation: 'ruling', node: 'p', seq: ruled, before: false, after: true }), JSON.stringify(x.changes))
  assert.ok(x.changes.every((c) => c.before !== c.after), JSON.stringify(x.changes))
})

// ---- the options the user is offered

test('the retry option names the main checkout, and the discard option names the execution', (t) => {
  const dir = store(t)
  eligibleAndExcluded(dir)
  const p = plan(dir)
  const [x] = p.excluded
  assert.ok(x.options[0].how.includes(p.root), p.root + ' in ' + x.options[0].how)
  assert.ok(x.options[1].how.includes(OPEN), OPEN + ' in ' + x.options[1].how)
})

test('the retry option names a nested folder by its full id', (t) => {
  const dir = store(t)
  execution(dir)
  event(dir, 'escalated', 'f/x', { reason: 'blocked', detail: 'f/x is blocked', said: '' })
  searched(dir, 'survey:f/x/common')
  const x = plan(dir).excluded.find((e) => e.folder === 'f/x')
  assert.ok(x, 'f/x is excluded')
  assert.ok(x.options[0].how.includes('--node f/x'), x.options[0].how)
})

// ---- apply, once more

test('the CLI run again with --yes appends nothing and exits 0', { timeout: 120_000 }, (t) => {
  const dir = store(t)
  programRun(dir)
  execution(dir)
  searched(dir, 'probe:f:3/locate')
  assert.equal(cli(dir, dir, '--yes').status, 0)
  const lines = totalLines(dir)
  const again = cli(dir, dir, '--yes')
  assert.equal(again.status, 0, again.stderr)
  const out = JSON.parse(again.stdout)
  assert.equal(out.applied, 0)
  assert.equal(out.error, '')
  assert.equal(totalLines(dir), lines)
})

// ---- the roots, and a store with nothing in it

test('the plan root is the absolute posix main checkout, however the repo is named', (t) => {
  const dir = store(t)
  assert.equal(plan(dir).root, posix(mainCheckout(dir)))
  assert.equal(plan(relative(process.cwd(), dir)).root, posix(mainCheckout(dir)))
})

test('a repository with no store plans nothing, writes nothing and applies as zero', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-migrate-v56-empty-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const p = plan(dir)
  assert.deepEqual([p.runs, p.folders, p.excluded, p.left, p.refused], [[], [], [], [], []])
  assert.deepEqual(apply(p), { applied: 0, error: '' })
  assert.equal(existsSync(join(dir, '.agentics')), false)
})

test('the CLI on a repository with no store prints an empty plan, with and without --yes, and exits 0', { timeout: 90_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-migrate-v56-empty-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const args of [[], ['--yes']]) {
    const r = cli(dir, ...args)
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.applied, 0)
    assert.equal(out.error, '')
    assert.deepEqual([out.runs, out.folders, out.excluded, out.left, out.refused], [[], [], [], [], []])
    assert.equal(realpathSync.native(out.root), realpathSync.native(dir))
  }
  assert.equal(existsSync(join(dir, '.agentics')), false)
})

// ---- a group is no folder

test('a group holds no folder: a round search that names one is left, not planned', (t) => {
  const dir = store(t)
  assert.equal(seedTree(dir, E, [{ id: 'f/g', kind: 'group', title: 'gather f/g' }, leaf('f/g/a')]).ok, true)
  assert.equal(readTree(dir, E).nodes.get('f/g').kind, 'group')
  execution(dir)
  searched(dir, 'probe:f/g:1/locate')
  const p = plan(dir)
  assert.ok(!p.folders.some((f) => f.folder === 'f/g'), JSON.stringify(p.folders))
  assert.deepEqual(byFolder(p, 'left'), { 'f/g': ['probe:f/g:1/locate'] })
  assert.ok(p.left[0].why.length > 0)
  assert.deepEqual(apply(p), { applied: 0, error: '' })
  assert.deepEqual(events(dir).filter((e) => e.kind === 'replanned' && e.node === 'f/g'), [])
})

// ---- an unaffected ruling is no reason to exclude a folder

const unaffected = (node) => ({ ...ruling(node), ruling: 'unaffected', why: 'the api moved nothing this node holds' })

test('an unaffected ruling does not exclude its folder', (t) => {
  const dir = store(t)
  execution(dir)
  retried(dir, 'q')
  stateLine(dir, unaffected('q'))
  searched(dir, 'survey:q/common')
  const p = plan(dir)
  assert.deepEqual(folderIds(p), ['q'])
  assert.deepEqual(p.excluded, [])
})

test('an excluded folder lists no change for an unaffected ruling', (t) => {
  const dir = store(t)
  execution(dir)
  event(dir, 'escalated', 'p', { reason: 'blocked', detail: 'p is blocked', said: '' })
  const quiet = stateLine(dir, unaffected('p'))
  searched(dir, 'probe:p:2/locate')
  const [x] = plan(dir).excluded
  assert.ok(x, 'p is excluded')
  assert.ok(x.changes.some((c) => c.derivation === 'status' && c.node === 'p'), JSON.stringify(x.changes))
  assert.ok(!x.changes.some((c) => c.derivation === 'ruling' && c.seq === quiet), JSON.stringify(x.changes))
})
