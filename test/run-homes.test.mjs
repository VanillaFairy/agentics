// test/run-homes.test.mjs — pins where a run lives: an execution's run id resolves to its execution
// directory, every run file and the run's log port follow it, a home ends only after its latest run,
// a program that names its home is claimed there, cost is split by model, a launch_failed that
// cannot be recorded says so, and one atomic writer serves every whole-file write.
//
// Design: docs/DESIGN.md#detached-runs and docs/DESIGN.md#run-directory.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { appendRun, fileFor, logOf, readLog, readRunLog, runState } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { coverageOf, step } from '../lib/programs/common.mjs'
import { launch } from '../lib/run.mjs'
import { costOf as costReport } from '../lib/status.mjs'
import {
  claimLockPath, executionDir, executionRunId, posix, readJson, resolveHandle, resultPath, runDir,
  runHome, runJsonPath, runLogFile, runLogPath, runsDir, writeJson, writeWhole,
} from '../lib/store.mjs'
import { scriptedRunner } from './fast/harness/scripted-runner.mjs'
import { DEAD_PID } from './harness/dead-pid.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STORE_MJS = join(HERE, '..', 'lib', 'store.mjs')

const E = 'e1'
const S = '20260101-000000'
const OTHER = '20260101-010000'
const HOME = executionRunId(E, S)
const RUN = '20260101-000000-survey'
const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const NOW = () => new Date(T0)
const TEXT_ARGS = { topic: { kind: 'text', required: true } }

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
const childEnv = () => ({ ...process.env, NODE_TEST_CONTEXT: '' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const same = (a, b) => {
  const n = (p) => { const s = posix(resolve(p)); return process.platform === 'win32' ? s.toLowerCase() : s }
  return n(a) === n(b)
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-run-homes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeRepo(t) {
  const repo = scratch(t)
  git(repo, 'init', '-q', '.')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'q.md'), 'q\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  return repo
}

/** The run directories under runs/, without the claims folder. */
function runDirs(repo) {
  if (!existsSync(runsDir(repo))) return []
  return readdirSync(runsDir(repo), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name)
}

const stateOf = (repo, stamp = S) => readLog(repo, E, 'state:' + stamp).entries
const kinds = (list) => list.map((e) => e.kind)

/** A program module under the name `survey` whose home is `run`; `fn` gives the result's own fields. */
function homed(fn = async (ctx) => { await step(ctx, 'first', async () => 1); return {} }, { run = HOME, ARGS = TEXT_ARGS } = {}) {
  const seen = { calls: [], homes: [] }
  const mod = {
    ARGS,
    scopeOf: () => ({ effort: E, folder: '.' }),
    homeOf: (args, at) => { seen.homes.push({ args, at }); return { run } },
    survey: async (ctx, args) => {
      seen.calls.push({ ctx, args })
      const r = (await fn(ctx, args)) || {}
      return { coverage: coverageOf({}), ...r }
    },
  }
  return { mod, seen }
}

/** A program module under the name `survey` with no home of its own. */
function plain(fn) {
  return { ARGS: TEXT_ARGS, scopeOf: () => ({}), survey: async (ctx, args) => ({ coverage: coverageOf({}), ...((await fn(ctx, args)) || {}) }) }
}

function start(repo, argv, mod, over = {}) {
  return launch({
    argv, cwd: repo, env: {}, now: NOW, heartbeatMs: 20,
    load: async () => mod,
    runner: (o) => scriptedRunner({}, { log: o.log }).runAgent,
    spawnChild: () => { throw new Error('this test starts no child') },
    ...over,
  })
}

/** A home left as a killed process leaves it: its state cut as `cut` says, a dead pid in run.json. */
function stopHome(repo, { cut = 'ended', pid = DEAD_PID, heartbeat_at } = {}) {
  const all = stateOf(repo)
  const kept = cut === 'ended' ? all.filter((e) => e.kind !== 'ended') : all.slice(0, all.findLastIndex((e) => e.kind === 'run') + 1)
  writeFileSync(runLogPath(repo, HOME), kept.map((e) => JSON.stringify(e) + '\n').join(''))
  const meta = readJson(runJsonPath(repo, HOME))
  writeFileSync(runJsonPath(repo, HOME), JSON.stringify({ ...meta, pid, ...(heartbeat_at ? { heartbeat_at } : {}) }))
}

function held() {
  let open, started
  const gate = new Promise((r) => { open = r })
  const began = new Promise((r) => { started = r })
  return { gate, began, open, started }
}

// --- where a run lives -----------------------------------------------------------------------

test('an execution run id resolves to its execution directory, any other run id to runs/', (t) => {
  const repo = scratch(t)
  assert.equal(HOME, E + '.' + S)
  assert.deepEqual(runHome(repo, HOME), { dir: executionDir(repo, E, S), effort: E, stamp: S })
  assert.deepEqual(runHome(repo, executionRunId(E, S + '-2')), { dir: executionDir(repo, E, S + '-2'), effort: E, stamp: S + '-2' })
  for (const run of [RUN, 'e1.20260101', 'e--x.' + S, E + '.' + S + '.x']) {
    assert.deepEqual(runHome(repo, run), { dir: runDir(repo, run), effort: '', stamp: '' }, run)
  }
})

test('resolveHandle accepts an execution run id once its home exists', (t) => {
  const repo = scratch(t)
  assert.equal(resolveHandle(repo, 'run', HOME).ok, false)
  assert.equal(resolveHandle(repo, 'run', HOME).error.kind, 'unknown_run')
  mkdirSync(executionDir(repo, E, S), { recursive: true })
  assert.deepEqual(resolveHandle(repo, 'run', HOME), { ok: true, value: HOME })
  assert.equal(resolveHandle(repo, 'run', executionRunId(E, OTHER)).ok, false)
})

test('the run files of an execution id sit in its execution directory', (t) => {
  const repo = scratch(t)
  const files = [runJsonPath, runLogPath, resultPath, runLogFile].map((f) => f(repo, HOME))
  for (const f of files) assert.equal(dirname(f), executionDir(repo, E, S))
  assert.equal(new Set(files).size, files.length)
  assert.equal(runLogPath(repo, HOME), fileFor(repo, E, 'state:' + S).path)
})

test('runsDir and claimLockPath name the runs folder and one claim lock per program and scope', (t) => {
  const repo = scratch(t)
  assert.equal(runsDir(repo), dirname(runDir(repo, RUN)))
  assert.equal(dirname(dirname(claimLockPath(repo, 'survey', 'k1'))), runsDir(repo))
  const locks = [claimLockPath(repo, 'survey', 'k1'), claimLockPath(repo, 'survey', 'k2'), claimLockPath(repo, 'probe', 'k1')]
  assert.equal(new Set(locks).size, locks.length)
})

// --- the run's log port ----------------------------------------------------------------------

test("logOf gives an execution's port for an execution id", (t) => {
  const repo = scratch(t)
  const log = logOf(repo, HOME)
  log.append('run', { program: 'survey', scope: {}, pid: 1 })
  log.append('dispatched', { node: 'a', dispatch: 'd1', model: 'opus' })
  assert.deepEqual(kinds(stateOf(repo)), ['run'])
  const events = readLog(repo, E, 'events').entries
  assert.deepEqual(kinds(events), ['dispatched'])
  assert.equal(events[0].execution, S)
  assert.deepEqual(kinds(log.entries()), ['run', 'dispatched'])
  assert.equal(existsSync(runDir(repo, HOME)), false)
})

test('logOf gives the run log for any other run id', (t) => {
  const repo = scratch(t)
  const { seq } = logOf(repo, RUN).append('step', { key: 'k' })
  assert.equal(seq, 1)
  assert.deepEqual(readRunLog(repo, RUN).entries.map((e) => [e.kind, e.key, e.seq]), [['step', 'k', 1]])
})

test("readRunLog reads an execution home's events, state and journal merged by seq", (t) => {
  const repo = scratch(t)
  logOf(repo, executionRunId(E, OTHER)).append('dispatched', { node: 'b', dispatch: 'other' })
  const log = logOf(repo, HOME)
  log.append('run', { program: 'survey' })
  log.append('dispatched', { node: 'a', dispatch: 'd1' })
  log.append('verify-observed', { node: 'a' })
  log.append('ended', { result: { status: 'done' } })
  const read = readRunLog(repo, HOME)
  assert.deepEqual(kinds(read.entries), ['run', 'dispatched', 'verify-observed', 'ended'])
  assert.deepEqual(read.entries.map((e) => e.seq), [...read.entries.map((e) => e.seq)].sort((a, b) => a - b))
  assert.equal(read.malformed, 0)
  appendFileSync(runLogPath(repo, HOME), 'not json' + String.fromCharCode(10))
  assert.equal(readRunLog(repo, HOME).malformed, 1)
})

test('appendRun refuses an execution run id and writes nothing', (t) => {
  const repo = scratch(t)
  const out = appendRun(repo, HOME, { kind: 'step', key: 'k' })
  assert.equal(out.ok, false)
  assert.match(out.error, /execution/)
  assert.equal(existsSync(runLogPath(repo, HOME)), false)
})

// --- where a run stands ----------------------------------------------------------------------

test('runState reads ended only when an ended record follows the latest run', (t) => {
  const repo = scratch(t)
  writeJson(runJsonPath(repo, RUN), { run: RUN, pid: 4242, heartbeat_at: NOW().toISOString() })
  appendRun(repo, RUN, [{ kind: 'run' }, { kind: 'ended', result: { status: 'done' } }])
  assert.equal(runState(repo, RUN, { now: T0, alive: () => true }).state, 'ended')
  appendRun(repo, RUN, { kind: 'run' })
  const live = runState(repo, RUN, { now: T0, alive: () => true })
  assert.equal(live.state, 'live')
  assert.equal(live.ended, null)
  assert.equal(runState(repo, RUN, { now: T0, alive: () => false }).state, 'stopped')
  appendRun(repo, RUN, { kind: 'ended', result: { status: 'done' } })
  assert.equal(runState(repo, RUN, { now: T0, alive: () => true }).state, 'ended')
})

test("runState of an execution home reads its run.json and its execution's records", (t) => {
  const repo = scratch(t)
  assert.equal(runState(repo, HOME).state, 'absent')
  writeJson(runJsonPath(repo, HOME), { run: HOME, pid: 4242, heartbeat_at: NOW().toISOString() })
  const log = logOf(repo, HOME)
  log.append('run', { program: 'survey' })
  assert.equal(runState(repo, HOME, { now: T0, alive: (pid) => pid === 4242 }).state, 'live')
  log.append('ended', { result: { status: 'done' } })
  assert.equal(runState(repo, HOME, { now: T0, alive: () => true }).state, 'ended')
  log.append('run', { program: 'survey' })
  assert.equal(runState(repo, HOME, { now: T0, alive: () => false }).state, 'stopped')
})

// --- a program's home ------------------------------------------------------------------------

test('a program with homeOf is claimed and run in its home: run.json, the log, the result and ended land there', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = homed()
  const out = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(out.ok, true)
  assert.equal(out.run, HOME)
  assert.equal(seen.homes.length, 1)
  assert.deepEqual(seen.homes[0].args, seen.calls[0].args)
  assert.ok(same(seen.homes[0].at.repo, repo))
  assert.equal(seen.calls[0].ctx.run, HOME)
  assert.ok(same(out.result_file, join(executionDir(repo, E, S), 'result.json')))
  assert.deepEqual(readJson(out.result_file), out.result)
  const meta = readJson(runJsonPath(repo, HOME))
  assert.equal(meta.run, HOME)
  assert.equal(meta.program, 'survey')
  assert.deepEqual(meta.args, seen.calls[0].args)
  assert.equal(meta.pid, process.pid)
  const state = stateOf(repo)
  assert.deepEqual(kinds(state), ['run', 'step', 'ended'])
  assert.equal(state[2].result.status, 'done')
  assert.equal(state[2].result.file, out.result_file)
  assert.deepEqual(runDirs(repo), [])
})

test('a live home refuses run_live, naming its run, pid and log', { timeout: 15_000 }, async (t) => {
  const repo = makeRepo(t)
  const h = held()
  const { mod, seen } = homed(async () => { h.started(); await h.gate; return {} })
  const first = start(repo, ['survey', '--topic', 'x'], mod)
  await h.began
  const second = await start(repo, ['survey', '--topic', 'y'], mod)
  assert.equal(second.ok, false)
  assert.equal(second.error.kind, 'run_live')
  assert.equal(second.error.run, HOME)
  assert.equal(second.error.pid, process.pid)
  assert.equal(second.error.log, runLogFile(repo, HOME))
  h.open()
  assert.equal((await first).ok, true)
  assert.equal(seen.calls.length, 1)
})

test('a stopped home starts again with the new arguments and run.json rewritten', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = homed()
  const first = await start(repo, ['survey', '--topic', 'x'], mod)
  stopHome(repo)
  const second = await start(repo, ['survey', '--topic', 'y'], mod)
  assert.equal(second.ok, true)
  assert.equal(second.run, first.run)
  assert.equal(seen.calls[1].args.topic, 'y')
  const meta = readJson(runJsonPath(repo, HOME))
  assert.deepEqual(meta.args, seen.calls[1].args)
  assert.equal(meta.args_digest, fnv1a(canonical(seen.calls[1].args)))
  assert.deepEqual(meta.raw, { topic: 'y' })
  assert.equal(stateOf(repo).filter((e) => e.kind === 'run').length, 2)
  assert.equal(kinds(stateOf(repo)).at(-1), 'ended')
})

test('an ended home starts again in the same home', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = homed()
  await start(repo, ['survey', '--topic', 'x'], mod)
  const again = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(again.ok, true)
  assert.equal(again.run, HOME)
  assert.equal(seen.calls.length, 2)
  assert.deepEqual(kinds(stateOf(repo)), ['run', 'step', 'ended', 'run', 'ended'])
})

test('a stopped home whose current run recorded nothing since its run refuses launch_failed and records it', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = homed()
  await start(repo, ['survey', '--topic', 'x'], mod)
  stopHome(repo, { cut: 'after-run' })
  const out = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'launch_failed')
  assert.equal(out.error.run, HOME)
  assert.equal(seen.calls.length, 1)
  const state = stateOf(repo)
  assert.deepEqual(kinds(state).slice(-3), ['run', 'fault', 'ended'])
  assert.equal(state.at(-2).channel, 'launch_failed')
  assert.equal(state.at(-2).node, '')
  assert.equal(state.at(-1).result.status, 'launch_failed')
  const next = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(next.ok, true)
  assert.equal(next.run, HOME)
  assert.equal(seen.calls.length, 2)
})

test('a home claimed and cut off before its child started is launch_failed on the next start', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = homed()
  writeJson(runJsonPath(repo, HOME), { run: HOME, program: 'survey', pid: 0, heartbeat_at: NOW().toISOString() })
  const out = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'launch_failed')
  assert.deepEqual(kinds(stateOf(repo)), ['fault', 'ended'])
  assert.equal(seen.calls.length, 0)
  const next = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(next.ok, true)
  assert.equal(seen.calls.length, 1)
})

test("a home whose run.json cannot be read is started there, its run.json written whole", async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = homed()
  mkdirSync(executionDir(repo, E, S), { recursive: true })
  writeFileSync(runJsonPath(repo, HOME), '{"run": "torn')
  const out = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(out.ok, true)
  assert.equal(out.run, HOME)
  assert.equal(seen.calls.length, 1)
  assert.equal(readJson(runJsonPath(repo, HOME)).run, HOME)
})

test('a home whose heartbeat went stale starts again even while its pid lives', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = homed()
  await start(repo, ['survey', '--topic', 'x'], mod)
  stopHome(repo, { pid: process.pid, heartbeat_at: new Date(T0 - 121_000).toISOString() })
  const out = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(out.ok, true)
  assert.equal(out.run, HOME)
  assert.equal(seen.calls.length, 2)
})

test('a start racing another process that holds the claim lock on a home waits, then is refused run_live', { timeout: 30_000 }, async (t) => {
  const repo = makeRepo(t)
  const scope = { effort: E, folder: '.' }
  const lock = claimLockPath(repo, 'survey', fnv1a(canonical(scope)))
  const meta = { run: HOME, program: 'survey', scope, heartbeat_at: NOW().toISOString() }
  const code = [
    "import { mkdirSync, writeFileSync } from 'node:fs'",
    "import { dirname } from 'node:path'",
    'const s = JSON.parse(process.env.CLAIM_SPEC)',
    'const { withLock, runJsonPath } = await import(s.store)',
    'withLock(s.lock, () => {',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)',
    '  mkdirSync(dirname(runJsonPath(s.repo, s.meta.run)), { recursive: true })',
    '  writeFileSync(runJsonPath(s.repo, s.meta.run), JSON.stringify({ ...s.meta, pid: process.pid }))',
    '})',
    'setInterval(() => {}, 1000)',
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...childEnv(), CLAIM_SPEC: JSON.stringify({ store: pathToFileURL(STORE_MJS).href, lock, repo, meta }) },
    stdio: 'ignore', windowsHide: true,
  })
  const exited = new Promise((r) => child.once('exit', r))
  try {
    for (let i = 0; !existsSync(lock); i++) {
      if (i > 1000) assert.fail('the child never took the claim lock')
      await sleep(10)
    }
    const { mod, seen } = homed()
    const out = await start(repo, ['survey', '--topic', 'x'], mod)
    assert.equal(out.ok, false)
    assert.equal(out.error.kind, 'run_live')
    assert.equal(out.error.run, HOME)
    assert.equal(out.error.pid, child.pid)
    assert.equal(seen.calls.length, 0)
  } finally {
    child.kill()
    await exited
  }
})

test("a detached start of a home prints the home's log and result file, and its child runs there", async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = homed()
  const spawned = []
  const out = await start(repo, ['survey', '--topic', 'x', '--detach'], mod, { spawnChild: (o) => { spawned.push(o); return 4242 } })
  assert.deepEqual(out, { ok: true, run: HOME, pid: 4242, log: runLogFile(repo, HOME), result_file: resultPath(repo, HOME) })
  assert.ok(same(dirname(out.log), executionDir(repo, E, S)))
  assert.deepEqual(spawned[0].args, ['survey', '--topic', 'x', '--child', HOME])
  assert.equal(spawned[0].logFile, runLogFile(repo, HOME))
  assert.equal(readJson(runJsonPath(repo, HOME)).pid, 4242)
  const child = await start(repo, spawned[0].args, mod)
  assert.equal(child.ok, true)
  assert.equal(child.run, HOME)
  assert.equal(seen.calls[0].args.topic, 'x')
  assert.ok(existsSync(resultPath(repo, HOME)))
})

test('a homeOf that names no run id throws', async (t) => {
  const repo = makeRepo(t)
  const { mod } = homed(undefined, { run: '../escape' })
  await assert.rejects(start(repo, ['survey', '--topic', 'x'], mod), /run id/)
  assert.equal(existsSync(join(runsDir(repo), '..', 'escape')), false)
})

// --- cost ------------------------------------------------------------------------------------

const returned = (dispatch, usage, cost) => ({
  dispatch, session: 's-' + dispatch, status: 'returned', cause: '', usage, cost_total: cost, cost_usd: cost, denials: [],
})

test('the cost carries by_model, each returned record joined to the latest dispatched of its dispatch before it', async (t) => {
  const repo = makeRepo(t)
  const a = { input_tokens: 10, output_tokens: 5 }
  const b = { input_tokens: 3, cache_read_input_tokens: 100 }
  const c = { output_tokens: 7 }
  const mod = plain(async (ctx) => {
    ctx.log.append('dispatched', { dispatch: 'd1', model: 'sonnet' })
    ctx.log.append('returned', returned('d1', a, 0.5))
    ctx.log.append('dispatched', { dispatch: 'd1', model: 'opus' })
    ctx.log.append('dispatched', { dispatch: 'd2', model: 'opus' })
    ctx.log.append('returned', returned('d1', b, 0.25))
    ctx.log.append('returned', returned('d2', c, null))
    ctx.log.append('returned', returned('d3', a, 1))
    return {}
  })
  const out = await start(repo, ['survey', '--topic', 'x'], mod)
  const cost = out.result.cost
  const tokens = (u) => Object.values(u).reduce((s, n) => s + n, 0)
  assert.equal(cost.dispatches, 4)
  assert.equal(cost.tokens, tokens(a) + tokens(b) + tokens(c) + tokens(a))
  assert.equal(cost.usd, 0.5 + 0.25 + 1)
  assert.equal(cost.unmeasured, 1)
  assert.deepEqual(cost.by_model, {
    sonnet: { dispatches: 1, tokens: tokens(a), usd: 0.5, unmeasured: 0 },
    opus: { dispatches: 2, tokens: tokens(b) + tokens(c), usd: 0.25, unmeasured: 1 },
  })
  assert.deepEqual(readJson(out.result_file).cost, cost)
})

test("a home's cost joins its returned records to the dispatched events of its execution, earlier runs' included", async (t) => {
  const repo = makeRepo(t)
  const u = { input_tokens: 4, output_tokens: 2 }
  logOf(repo, HOME).append('dispatched', { node: 'a', dispatch: 'd1', model: 'haiku' })
  const { mod } = homed(async (ctx) => {
    ctx.log.append('dispatched', { node: 'b', dispatch: 'd2', model: 'opus' })
    ctx.log.append('returned', returned('d1', u, 0.125))
    ctx.log.append('returned', returned('d2', u, 0.25))
    return {}
  })
  const out = await start(repo, ['survey', '--topic', 'x'], mod)
  const events = readLog(repo, E, 'events').entries
  assert.deepEqual(events.map((e) => [e.kind, e.execution]), [['dispatched', S], ['dispatched', S]])
  assert.deepEqual(out.result.cost.by_model, {
    haiku: { dispatches: 1, tokens: 6, usd: 0.125, unmeasured: 0 },
    opus: { dispatches: 1, tokens: 6, usd: 0.25, unmeasured: 0 },
  })
  assert.equal(out.result.cost.dispatches, 2)
})

test("a home's cost is the effort cost report's over the same execution, unmeasured calls per model included", async (t) => {
  const repo = makeRepo(t)
  const u = { input_tokens: 4, output_tokens: 2 }
  const { mod } = homed(async (ctx) => {
    ctx.log.append('dispatched', { node: 'a', dispatch: 'd1', model: 'haiku' })
    ctx.log.append('dispatched', { node: 'b', dispatch: 'd2', model: 'opus' })
    ctx.log.append('returned', returned('d1', u, 0.125))
    ctx.log.append('returned', returned('d2', u, null))
    return {}
  })
  const out = await start(repo, ['survey', '--topic', 'x'], mod)
  const report = costReport(repo, E)
  const pick = (s) => ({ dispatches: s.dispatches, tokens: s.tokens, usd: s.usd, unmeasured: s.unmeasured })
  assert.deepEqual(pick(out.result.cost), pick(report))
  assert.deepEqual(out.result.cost.by_model, Object.fromEntries(Object.entries(report.by_model).map(([m, s]) => [m, pick(s)])))
  assert.equal(out.result.cost.by_model.opus.unmeasured, 1, 'the call with no cost figure is unmeasured under its model')
})

// --- launch_failed that cannot be recorded ---------------------------------------------------

test("a launch_failed that cannot be recorded names the append's refusal", async (t) => {
  const repo = makeRepo(t)
  const mod = plain(async (ctx) => { await step(ctx, 'first', async () => 1); return {} })
  const first = await start(repo, ['survey', '--topic', 'x'], mod)
  const all = readRunLog(repo, first.run).entries
  writeFileSync(runLogPath(repo, first.run), JSON.stringify(all[0]) + '\n')
  writeJson(runJsonPath(repo, first.run), { ...readJson(runJsonPath(repo, first.run)), pid: DEAD_PID })
  const counter = join(runDir(repo, first.run), 'seq')
  rmSync(counter)
  mkdirSync(counter)
  let refusal = ''
  try {
    logOf(repo, first.run).append('fault', { node: '', channel: 'launch_failed', detail: 'probe' })
  } catch (err) {
    refusal = err.message
  }
  assert.notEqual(refusal, '')
  const out = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'launch_failed')
  assert.ok(out.error.message.includes(refusal), out.error.message)
  assert.deepEqual(kinds(readRunLog(repo, first.run).entries), ['run'])
})

// --- one whole-file writer -------------------------------------------------------------------

test('writeWhole replaces a file whole, JSON or text, making its folder and leaving no staged file', (t) => {
  const dir = join(scratch(t), 'deep', 'er')
  const json = join(dir, 'x.json')
  const text = join(dir, 't.md')
  writeWhole(json, { a: 1 })
  assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')), { a: 1 })
  writeWhole(json, { b: [2] })
  assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')), { b: [2] })
  writeWhole(text, '# prompt\nbody\n')
  assert.equal(readFileSync(text, 'utf8'), '# prompt\nbody\n')
  assert.deepEqual(readdirSync(dir).sort(), ['t.md', 'x.json'])
})
