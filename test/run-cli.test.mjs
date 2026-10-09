// test/run-cli.test.mjs — pins lib/run.mjs: how a start resolves its arguments or refuses them, how
// it claims, resumes or refuses a run, what an attached run records and returns, the heartbeat,
// the context a program receives, faults and cost, detached starts and their child, and the CLI.
//
// Design: docs/DESIGN.md#programs, docs/DESIGN.md#detached-runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readRunLog, runState } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { coverageOf, dispatch, step } from '../lib/programs/common.mjs'
import { HEARTBEAT_MS, PROGRAM_NAMES, launch } from '../lib/run.mjs'
import {
  configPath, effortDir, mainCheckout, posix, projectStateDir, readJson, resultPath, runDir, runJsonPath,
  runLogFile, runLogPath, specPath, stampNow, writeJson,
} from '../lib/store.mjs'
import { scriptedRunner } from './fast/harness/scripted-runner.mjs'
import { DEAD_PID } from './harness/dead-pid.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN_MJS = join(HERE, '..', 'lib', 'run.mjs')
const STORE_MJS = join(HERE, '..', 'lib', 'store.mjs')

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const NOW = () => new Date(T0)
const QUESTION = 'Where does the store write\nits return files?'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
const childEnv = () => ({ ...process.env, NODE_TEST_CONTEXT: '' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const same = (a, b) => {
  const n = (p) => { const s = posix(resolve(p)); return process.platform === 'win32' ? s.toLowerCase() : s }
  return n(a) === n(b)
}

function makeRepo(t, { content = QUESTION + '\n' } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-run-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-q', '.')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'q.md'), content)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  return repo
}

/** The run directories under the project's state, without the claims folder. */
function runDirs(repo) {
  const root = join(projectStateDir(repo), 'runs')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort()
}

const kinds = (repo, run) => readRunLog(repo, run).entries.map((e) => e.kind)
const entries = (repo, run) => readRunLog(repo, run).entries

/** A program module named `name`: `fn` gives the result's own fields; every result carries coverage. */
function program(fn = async () => ({}), { name = 'survey', ARGS = {}, scopeOf = () => ({}), attachedOnly } = {}) {
  const seen = { calls: [] }
  const mod = {
    ARGS, scopeOf,
    [name]: async (ctx, args) => {
      seen.calls.push({ ctx, args })
      const r = (await fn(ctx, args)) || {}
      return { coverage: coverageOf({}), ...r }
    },
  }
  if (attachedOnly) mod.attachedOnly = attachedOnly
  return { mod, seen }
}

const noChild = () => { throw new Error('this test starts no child') }

/** One in-process start over `repo` with the test's ports; `over` replaces any of them. */
function start(repo, argv, mod, over = {}) {
  const built = over.built || []
  const script = over.script || {}
  const { built: _b, script: _s, ...rest } = over
  return launch({
    argv, cwd: repo, env: {}, now: NOW, heartbeatMs: 20,
    load: async () => mod,
    runner: (o) => { built.push(o); return scriptedRunner(script, { log: o.log }).runAgent },
    spawnChild: noChild,
    ...rest,
  })
}

/** A run left as a killed process leaves it: its log cut as `cut` says, a dead pid in run.json. */
function stop(repo, run, { cut = 'ended', pid = DEAD_PID, heartbeat_at } = {}) {
  const all = entries(repo, run)
  let kept
  if (cut === 'ended') kept = all.filter((e) => e.kind !== 'ended')
  else if (cut === 'after-run') kept = all.slice(0, all.findLastIndex((e) => e.kind === 'run') + 1)
  else if (cut === 'empty') kept = []
  else throw new Error('stop: unknown cut ' + cut)
  writeFileSync(runLogPath(repo, run), kept.map((e) => JSON.stringify(e) + '\n').join(''))
  const meta = readJson(runJsonPath(repo, run))
  writeFileSync(runJsonPath(repo, run), JSON.stringify({ ...meta, pid, ...(heartbeat_at ? { heartbeat_at } : {}) }))
}

const FILE_ARGS = { question_file: { kind: 'file', required: true, as: 'question' } }
const fileScope = (args) => ({ question: fnv1a(args.question) })
const TEXT_ARGS = { topic: { kind: 'text', required: true } }

/** A program whose first act is a journaled step, so a killed run of it has something to resume. */
const stepping = (opts = {}) => program(async (ctx) => { await step(ctx, 'first', async () => 1); return {} }, opts)

/** A gate the test opens, and a promise the program resolves when it has started. */
function held() {
  let open, started
  const gate = new Promise((r) => { open = r })
  const began = new Promise((r) => { started = r })
  return { gate, began, open, started }
}

// --- an attached run -------------------------------------------------------------------------

test('an attached run prints its run, result file and result', async (t) => {
  const repo = makeRepo(t)
  const { mod } = program(async () => ({ answer: 42 }))
  const out = await start(repo, ['survey'], mod)
  assert.equal(out.ok, true)
  assert.equal(typeof out.run, 'string')
  assert.equal(out.result_file, resultPath(repo, out.run))
  assert.equal(out.result.answer, 42)
  assert.equal(out.result.run, out.run)
  assert.equal(typeof out.result.cost, 'object')
  assert.ok(out.result.cost)
  assert.equal(out.result.coverage.complete, true)
})

test('the result file holds the result with its run and cost', async (t) => {
  const repo = makeRepo(t)
  const { mod } = program(async () => ({ answer: 'there', items: [1, 2] }))
  const out = await start(repo, ['survey'], mod)
  assert.deepEqual(JSON.parse(readFileSync(out.result_file, 'utf8')), out.result)
})

test('the log opens with the run record and closes with ended', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async (ctx) => { await step(ctx, 'mine', async () => 'v'); return {} },
    { ARGS: FILE_ARGS, scopeOf: fileScope })
  const out = await start(repo, ['survey', '--question-file', 'q.md'], mod)
  assert.equal(out.ok, true)
  const log = entries(repo, out.run)
  assert.deepEqual(log.map((e) => e.kind), ['run', 'step', 'ended'])
  assert.equal(log[0].program, 'survey')
  assert.deepEqual(log[0].scope, fileScope(seen.calls[0].args))
  assert.equal(log[0].pid, process.pid)
  assert.equal(log[1].key, 'mine')
  assert.equal(log[2].result.status, 'done')
  assert.equal(log[2].result.file, out.result_file)
  assert.equal(log[2].result.complete, true)
})

test("ended's complete is the result's coverage.complete", async (t) => {
  const repo = makeRepo(t)
  const { mod } = program(async () => ({ coverage: coverageOf({ declared: ['a'], unreached: ['a'] }) }))
  const out = await start(repo, ['survey'], mod)
  assert.equal(out.result.coverage.complete, false)
  const ended = entries(repo, out.run).findLast((e) => e.kind === 'ended')
  assert.equal(ended.result.complete, false)
  assert.equal(ended.result.status, 'done')
})

test('run.json holds the run, its program, scope, arguments and pid', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}), { ARGS: { ...FILE_ARGS, deep: { kind: 'bool' } }, scopeOf: fileScope })
  const out = await start(repo, ['survey', '--question-file', 'q.md', '--deep'], mod)
  const meta = readJson(runJsonPath(repo, out.run))
  const args = seen.calls[0].args
  const scope = fileScope(args)
  assert.equal(meta.run, out.run)
  assert.equal(meta.program, 'survey')
  assert.deepEqual(meta.scope, scope)
  assert.equal(meta.scope_key, fnv1a(canonical(scope)))
  assert.deepEqual(meta.args, args)
  assert.equal(meta.args_digest, fnv1a(canonical(args)))
  assert.deepEqual(meta.raw, { question_file: 'q.md', deep: true })
  assert.equal(meta.pid, process.pid)
  assert.ok(Number.isFinite(Date.parse(meta.started_at)))
  assert.ok(Number.isFinite(Date.parse(meta.heartbeat_at)))
})

test('each program name is loaded by its name', async (t) => {
  const repo = makeRepo(t)
  for (const name of PROGRAM_NAMES) {
    const asked = []
    const { mod, seen } = program(async () => ({}), { name })
    const out = await start(repo, [name], mod, { load: async (n) => { asked.push(n); return mod } })
    assert.equal(out.ok, true, name)
    assert.deepEqual(asked, [name])
    assert.equal(seen.calls.length, 1, name)
  }
})

// --- arguments -------------------------------------------------------------------------------

test('a file argument resolves to its absolute path and its text', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}), { ARGS: FILE_ARGS, scopeOf: fileScope })
  const out = await start(repo, ['survey', '--question-file', 'q.md'], mod)
  assert.equal(out.ok, true)
  const args = seen.calls[0].args
  assert.ok(same(args.question_file, join(repo, 'q.md')), args.question_file)
  assert.ok(isAbsolute(args.question_file), args.question_file)
  assert.equal(args.question, QUESTION)
})

test('a file argument reads the same whatever its line endings', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}), { ARGS: FILE_ARGS, scopeOf: fileScope })
  const first = await start(repo, ['survey', '--question-file', 'q.md'], mod)
  writeFileSync(join(repo, 'q.md'), QUESTION.split('\n').join('\r\n') + '\r\n')
  const second = await start(repo, ['survey', '--question-file', 'q.md'], mod)
  assert.equal(seen.calls[1].args.question, seen.calls[0].args.question)
  assert.equal(seen.calls[1].args.question, QUESTION)
  const a = readJson(runJsonPath(repo, first.run))
  const b = readJson(runJsonPath(repo, second.run))
  assert.equal(b.args_digest, a.args_digest)
  assert.equal(b.scope_key, a.scope_key)
})

test('a list argument is its trimmed entries, empty ones dropped', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}), { ARGS: { roots: { kind: 'list', required: true } } })
  await start(repo, ['survey', '--roots', ' lib, test,,docs '], mod)
  assert.deepEqual(seen.calls[0].args.roots, ['lib', 'test', 'docs'])
})

test('an int argument is a non-negative integer', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}), { ARGS: { n: { kind: 'int', required: true } } })
  await start(repo, ['survey', '--n', '12'], mod)
  await start(repo, ['survey', '--n', '0'], mod)
  assert.equal(seen.calls[0].args.n, 12)
  assert.equal(seen.calls[1].args.n, 0)
})

test('a bool argument is true when present and false when absent', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}), { ARGS: { deep: { kind: 'bool' } } })
  await start(repo, ['survey', '--deep'], mod)
  await start(repo, ['survey'], mod)
  assert.equal(seen.calls[0].args.deep, true)
  assert.equal(seen.calls[1].args.deep, false)
})

test('an effort, a folder in it and a run resolve to their names', async (t) => {
  const repo = makeRepo(t)
  mkdirSync(effortDir(repo, 'eff'), { recursive: true })
  mkdirSync(dirname(specPath(repo, 'eff', 'a')), { recursive: true })
  writeFileSync(specPath(repo, 'eff', 'a'), '# A\n')
  const prior = await start(repo, ['probe'], program(async () => ({}), { name: 'probe' }).mod)
  assert.equal(prior.ok, true)
  const { mod, seen } = program(async () => ({}), {
    ARGS: { effort: { kind: 'effort', required: true }, folder: { kind: 'folder', required: true }, prior: { kind: 'run', required: true } },
  })
  const out = await start(repo, ['survey', '--effort', 'eff', '--folder', 'a', '--prior', prior.run], mod)
  assert.equal(out.ok, true)
  const args = seen.calls[0].args
  assert.equal(args.effort, 'eff')
  assert.equal(args.folder, 'a')
  assert.equal(args.prior, prior.run)
})

test('a ref argument resolves to its commit sha in the repository', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}), { ARGS: { base: { kind: 'ref', required: true } } })
  const out = await start(repo, ['survey', '--base', 'HEAD'], mod)
  assert.equal(out.ok, true)
  assert.equal(seen.calls[0].args.base, git(repo, 'rev-parse', 'HEAD'))
})

test("an absent optional argument takes its default, else its kind's empty value", async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}), {
    ARGS: {
      brief_file: { kind: 'file', as: 'brief' },
      note: { kind: 'text' },
      tag: { kind: 'text', default: 'plain' },
      paths: { kind: 'list' },
      n: { kind: 'int' },
      m: { kind: 'int', default: 7 },
      deep: { kind: 'bool' },
      mode: { kind: 'enum', values: ['a', 'b'] },
      pick: { kind: 'enum', values: ['a', 'b'], default: 'b' },
      effort: { kind: 'effort' },
      folder: { kind: 'folder' },
      prior: { kind: 'run' },
      base: { kind: 'ref' },
    },
  })
  const out = await start(repo, ['survey'], mod)
  assert.equal(out.ok, true)
  const args = seen.calls[0].args
  for (const key of ['brief_file', 'brief', 'note', 'mode', 'effort', 'folder', 'prior', 'base']) assert.equal(args[key], '', key)
  assert.equal(args.tag, 'plain')
  assert.deepEqual(args.paths, [])
  assert.equal(args.n, 0)
  assert.equal(args.m, 7)
  assert.equal(args.deep, false)
  assert.equal(args.pick, 'b')
})

test('a missing required argument is refused missing_arg', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}), { ARGS: FILE_ARGS, scopeOf: fileScope })
  const out = await start(repo, ['survey'], mod)
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'missing_arg')
  assert.equal(seen.calls.length, 0)
  assert.deepEqual(runDirs(repo), [])
})

test('a value its kind refuses is refused bad_arg', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}), {
    ARGS: { n: { kind: 'int' }, mode: { kind: 'enum', values: ['quick', 'deep'] } },
  })
  for (const argv of [['--n', 'x'], ['--n', '-1'], ['--n', '1.5'], ['--mode', 'slow']]) {
    const out = await start(repo, ['survey', ...argv], mod)
    assert.equal(out.ok, false, argv.join(' '))
    assert.equal(out.error.kind, 'bad_arg', argv.join(' '))
  }
  assert.equal(seen.calls.length, 0)
  assert.deepEqual(runDirs(repo), [])
})

test('a handle that names nothing is refused as its kind', async (t) => {
  const repo = makeRepo(t)
  mkdirSync(effortDir(repo, 'eff'), { recursive: true })
  const cases = [
    [{ effort: { kind: 'effort', required: true } }, ['--effort', 'nosuch'], 'unknown_effort'],
    [{ effort: { kind: 'effort', required: true }, folder: { kind: 'folder', required: true } }, ['--effort', 'eff', '--folder', 'nosuch'], 'unknown_folder'],
    [{ prior: { kind: 'run', required: true } }, ['--prior', '20250101-000000-nosuch'], 'unknown_run'],
    [{ base: { kind: 'ref', required: true } }, ['--base', 'no-such-ref'], 'unknown_ref'],
    [FILE_ARGS, ['--question-file', 'missing.md'], 'unknown_file'],
  ]
  for (const [ARGS, argv, kind] of cases) {
    const { mod, seen } = program(async () => ({}), { ARGS, scopeOf: () => ({}) })
    const out = await start(repo, ['survey', ...argv], mod)
    assert.equal(out.ok, false, kind)
    assert.equal(out.error.kind, kind)
    assert.equal(seen.calls.length, 0, kind)
  }
})

test('an unknown program is refused unknown_program', async (t) => {
  const repo = makeRepo(t)
  const asked = []
  const out = await start(repo, ['nosuch'], null, { load: async (n) => { asked.push(n); throw new Error('load was called') } })
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'unknown_program')
  assert.deepEqual(asked, [])
})

test('an unknown flag, or a flag without its value, is refused bad_arg', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}), { ARGS: { topic: { kind: 'text' }, mode: { kind: 'enum', values: ['deep'] } } })
  for (const argv of [['--nope', 'x'], ['--topic'], ['--topic', '--mode', 'deep'], ['stray'], ['--topic', 'x', 'stray']]) {
    const out = await start(repo, ['survey', ...argv], mod)
    assert.equal(out.ok, false, argv.join(' '))
    assert.equal(out.error.kind, 'bad_arg', argv.join(' '))
  }
  assert.equal(seen.calls.length, 0)
})

test('flags are the argument keys with dashes for underscores', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}), { ARGS: FILE_ARGS, scopeOf: fileScope })
  const good = await start(repo, ['survey', '--question-file', 'q.md'], mod)
  assert.equal(good.ok, true)
  const bad = await start(repo, ['survey', '--question_file', 'q.md'], mod)
  assert.equal(bad.ok, false)
  assert.equal(bad.error.kind, 'bad_arg')
  assert.equal(seen.calls.length, 1)
})

// --- the host and the runner -----------------------------------------------------------------

test('with no host CLI and no runner, a start is refused host_missing before any run', async (t) => {
  const repo = makeRepo(t)
  writeJson(configPath(repo), { claude_cli: join(repo, 'no-such-claude.exe') })
  const { mod, seen } = program(async () => ({}))
  const out = await start(repo, ['survey'], mod, { runner: null })
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'host_missing')
  assert.equal(seen.calls.length, 0)
  assert.deepEqual(runDirs(repo), [])
})

test('the runner watches the main checkout when --repo is a linked worktree', async (t) => {
  const repo = makeRepo(t)
  const wt = mkdtempSync(join(tmpdir(), 'agentics-run-wt-'))
  rmSync(wt, { recursive: true, force: true })
  t.after(() => rmSync(wt, { recursive: true, force: true }))
  git(repo, 'worktree', 'add', '-q', '-b', 'side', wt)
  const built = []
  const env = { AGENTICS_TEST_SENTINEL: 'run-cli' }
  const { mod } = program(async () => ({}))
  const out = await start(wt, ['survey', '--repo', wt], mod, { built, env })
  assert.equal(out.ok, true)
  assert.equal(built.length, 1)
  assert.equal(built[0].repo, mainCheckout(repo))
  assert.ok(!same(built[0].repo, wt))
  assert.equal(built[0].env, env)
  assert.equal(built[0].cli, '')
  assert.equal(built[0].log.entries()[0].kind, 'run')
})

// --- the claim -------------------------------------------------------------------------------

test('a second start of a live run is refused, naming it', { timeout: 10_000 }, async (t) => {
  const repo = makeRepo(t)
  const h = held()
  const { mod } = program(async () => { h.started(); await h.gate; return {} }, { ARGS: TEXT_ARGS })
  const first = start(repo, ['survey', '--topic', 'x'], mod)
  await h.began
  const [run] = runDirs(repo)
  const second = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(second.ok, false)
  assert.equal(second.error.kind, 'run_live')
  assert.equal(second.error.run, run)
  assert.equal(second.error.pid, process.pid)
  assert.equal(second.error.log, runLogFile(repo, run))
  h.open()
  const done = await first
  assert.equal(done.ok, true)
  assert.equal(done.run, run)
  assert.deepEqual(runDirs(repo), [run])
})

test('two starts at once give one run and one run_live', { timeout: 10_000 }, async (t) => {
  const repo = makeRepo(t)
  const h = held()
  const { mod } = program(async () => { h.started(); await h.gate; return {} }, { ARGS: TEXT_ARGS })
  const a = start(repo, ['survey', '--topic', 'x'], mod)
  const b = start(repo, ['survey', '--topic', 'x'], mod)
  const refused = await Promise.race([a, b])
  assert.equal(refused.ok, false)
  h.open()
  const outs = await Promise.all([a, b])
  assert.equal(outs.filter((o) => o.ok === true).length, 1)
  const live = outs.filter((o) => o.ok === false)
  assert.equal(live.length, 1)
  assert.equal(live[0].error.kind, 'run_live')
  assert.deepEqual(runDirs(repo), [outs.find((o) => o.ok).run])
})

test('a start begun while another process holds the claim lock waits, then is refused run_live naming its run', { timeout: 30_000 }, async (t) => {
  const repo = makeRepo(t)
  const scope = { area: 'store' }
  const scopeKey = fnv1a(canonical(scope))
  const lock = join(projectStateDir(repo), 'runs', '.claims', 'survey-' + scopeKey + '.lock')
  const other = '20251231-235959-survey'
  const at = NOW().toISOString()
  const meta = {
    run: other, program: 'survey', scope, scope_key: scopeKey, args: {}, args_digest: fnv1a(canonical({})), raw: {},
    started_at: at, heartbeat_at: at,
  }
  const code = [
    "import { mkdirSync, writeFileSync } from 'node:fs'",
    'const s = JSON.parse(process.env.CLAIM_SPEC)',
    'const { withLock, runDir, runJsonPath } = await import(s.store)',
    'withLock(s.lock, () => {',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)',
    '  mkdirSync(runDir(s.repo, s.meta.run), { recursive: true })',
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
    const { mod, seen } = program(async () => ({}), { scopeOf: () => scope })
    const out = await start(repo, ['survey'], mod)
    assert.equal(out.ok, false)
    assert.equal(out.error.kind, 'run_live')
    assert.equal(out.error.run, other)
    assert.equal(out.error.pid, child.pid)
    assert.equal(seen.calls.length, 0)
    assert.deepEqual(runDirs(repo), [other])
  } finally {
    child.kill()
    await exited
  }
})

test('a stopped run started again with the same arguments is resumed under its own id', async (t) => {
  const repo = makeRepo(t)
  const got = []
  const { mod } = program(async (ctx) => {
    got.push(await dispatch(ctx, { role: 'scout', schema: 'scout_hits', thread: 'plan', brief: 'Find the store.' }))
    return {}
  }, { ARGS: TEXT_ARGS })
  const output = { hits: [{ path: 'lib/store.mjs', line: 12, note: 'there' }], searched: [], no_match: '', not_reached: '', stop_reason: 'exhausted' }
  const first = await start(repo, ['survey', '--topic', 'x'], mod, { script: { 'scout||plan': [{ output }] } })
  assert.equal(first.ok, true)
  assert.equal(got[0].status, 'returned')
  stop(repo, first.run)
  let calls = 0
  const second = await start(repo, ['survey', '--topic', 'x'], mod, {
    runner: (o) => { const r = scriptedRunner({}, { log: o.log }); return (call) => { calls++; return r.runAgent(call) } },
  })
  assert.equal(second.ok, true)
  assert.equal(second.run, first.run)
  assert.deepEqual(runDirs(repo), [first.run])
  assert.equal(entries(repo, first.run).filter((e) => e.kind === 'run').length, 2)
  assert.equal(got[1].replayed, true)
  assert.deepEqual(got[1].output, got[0].output)
  assert.equal(calls, 0)
  assert.equal(kinds(repo, first.run).at(-1), 'ended')
})

test('a stopped run started again with other arguments is left, and a new run starts', async (t) => {
  const repo = makeRepo(t)
  const { mod } = stepping({ ARGS: TEXT_ARGS })
  const first = await start(repo, ['survey', '--topic', 'x'], mod)
  stop(repo, first.run)
  const before = kinds(repo, first.run)
  const second = await start(repo, ['survey', '--topic', 'y'], mod)
  assert.equal(second.ok, true)
  assert.notEqual(second.run, first.run)
  assert.deepEqual(kinds(repo, first.run), before)
  assert.equal(runState(repo, first.run).state, 'stopped')
  assert.deepEqual(runDirs(repo), [first.run, second.run].sort())
})

test('a stopped run whose log holds nothing after its last run record is refused launch_failed', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = stepping({ ARGS: TEXT_ARGS })
  const first = await start(repo, ['survey', '--topic', 'x'], mod)
  stop(repo, first.run, { cut: 'after-run' })
  assert.deepEqual(kinds(repo, first.run), ['run'])
  const out = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'launch_failed')
  assert.equal(out.error.run, first.run)
  assert.equal(seen.calls.length, 1)
  const log = entries(repo, first.run)
  assert.deepEqual(log.map((e) => e.kind), ['run', 'fault', 'ended'])
  assert.equal(log[1].node, '')
  assert.equal(log[1].channel, 'launch_failed')
  assert.equal(log[2].result.status, 'launch_failed')
})

test('a run claimed and never recorded is launch_failed on the next start', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = stepping({ ARGS: TEXT_ARGS })
  const first = await start(repo, ['survey', '--topic', 'x'], mod)
  stop(repo, first.run, { cut: 'empty' })
  assert.deepEqual(kinds(repo, first.run), [], 'the cut emptied the log')
  const out = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'launch_failed')
  assert.equal(seen.calls.length, 1)
  assert.deepEqual(kinds(repo, first.run), ['fault', 'ended'])
})

test('a launch_failed run is not resumed again', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = stepping({ ARGS: TEXT_ARGS })
  const first = await start(repo, ['survey', '--topic', 'x'], mod)
  stop(repo, first.run, { cut: 'after-run' })
  const refused = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(refused.error.kind, 'launch_failed')
  const failedLog = kinds(repo, first.run)
  const next = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(next.ok, true)
  assert.notEqual(next.run, first.run)
  assert.equal(seen.calls.length, 2)
  assert.deepEqual(kinds(repo, first.run), failedLog)
})

test('a run whose heartbeat went stale is resumed even while its pid lives', async (t) => {
  const repo = makeRepo(t)
  const { mod } = stepping({ ARGS: TEXT_ARGS })
  const first = await start(repo, ['survey', '--topic', 'x'], mod)
  stop(repo, first.run, { pid: process.pid, heartbeat_at: new Date(T0 - 121_000).toISOString() })
  const second = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(second.ok, true)
  assert.equal(second.run, first.run)
  assert.deepEqual(runDirs(repo), [first.run])
  assert.equal(entries(repo, first.run).filter((e) => e.kind === 'run').length, 2)
})

test('a run whose run.json cannot be read is not claimed', async (t) => {
  const repo = makeRepo(t)
  const { mod } = stepping({ ARGS: TEXT_ARGS })
  const first = await start(repo, ['survey', '--topic', 'x'], mod)
  stop(repo, first.run)
  writeFileSync(runJsonPath(repo, first.run), '{"run": "torn')
  const later = new Date(T0 + 3_600_000)
  const second = await start(repo, ['survey', '--topic', 'x'], mod, { now: () => later })
  assert.equal(second.ok, true)
  assert.equal(second.run, stampNow(later) + '-survey')
  assert.notEqual(second.run, first.run)
  assert.equal(readFileSync(runJsonPath(repo, first.run), 'utf8'), '{"run": "torn')
})

test('an ended run is not resumed', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = stepping({ ARGS: TEXT_ARGS })
  const first = await start(repo, ['survey', '--topic', 'x'], mod)
  const second = await start(repo, ['survey', '--topic', 'x'], mod)
  assert.equal(second.ok, true)
  assert.notEqual(second.run, first.run)
  assert.equal(seen.calls.length, 2)
  assert.deepEqual(kinds(repo, first.run), ['run', 'step', 'ended'])
})

// --- run ids and the heartbeat ---------------------------------------------------------------

test('a run whose name is taken takes the next free -n', async (t) => {
  const repo = makeRepo(t)
  const { mod } = program(async () => ({}), { ARGS: TEXT_ARGS })
  const base = stampNow(NOW()) + '-survey'
  const a = await start(repo, ['survey', '--topic', 'a'], mod)
  const b = await start(repo, ['survey', '--topic', 'b'], mod)
  const c = await start(repo, ['survey', '--topic', 'c'], mod)
  assert.equal(a.run, base)
  assert.equal(b.run, base + '-2')
  assert.equal(c.run, base + '-3')
})

test('the heartbeat rewrites heartbeat_at while the program runs and stops after its end', { timeout: 20_000 }, async (t) => {
  const repo = makeRepo(t)
  let ticks = 0
  const clock = () => new Date(T0 + 1000 * ticks++)
  const h = held()
  const { mod } = program(async () => { h.started(); await h.gate; return {} })
  const running = start(repo, ['survey'], mod, { now: clock })
  await h.began
  const [run] = runDirs(repo)
  let first
  for (let i = 0; !(first = readJson(runJsonPath(repo, run))?.heartbeat_at); i++) {
    if (i > 500) assert.fail('run.json never readable')
    await sleep(10)
  }
  let moved = first
  for (let i = 0; moved === first; i++) {
    if (i > 500) assert.fail('heartbeat_at never changed while the program ran')
    await sleep(10)
    moved = readJson(runJsonPath(repo, run))?.heartbeat_at ?? first
  }
  assert.ok(Date.parse(moved) > Date.parse(first))
  h.open()
  await running
  const after = readJson(runJsonPath(repo, run))?.heartbeat_at
  assert.ok(after, 'run.json is readable after the end')
  await sleep(200)
  const later = readJson(runJsonPath(repo, run))?.heartbeat_at
  assert.ok(later, 'run.json is readable after the end')
  assert.equal(later, after)
})

test('a run beating every HEARTBEAT_MS reads as live', async (t) => {
  const repo = makeRepo(t)
  const { mod } = stepping()
  const out = await start(repo, ['survey'], mod)
  stop(repo, out.run, { pid: process.pid, heartbeat_at: new Date(T0 - HEARTBEAT_MS).toISOString() })
  assert.equal(runState(repo, out.run, { now: T0 }).state, 'live')
})

// --- the context -----------------------------------------------------------------------------

test('max_agents from the config reaches the context, six otherwise', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}))
  const cases = [[undefined, 6], [3, 3], [0, 6], ['many', 6], [2.5, 6]]
  for (const [value, want] of cases) {
    if (value === undefined) rmSync(configPath(repo), { force: true })
    else writeJson(configPath(repo), { max_agents: value })
    const out = await start(repo, ['survey'], mod)
    assert.equal(out.ok, true, String(value))
    assert.equal(seen.calls.at(-1).ctx.maxAgents, want, String(value))
  }
})

test('the context is resumable as its program, its scope and the flags as given', async (t) => {
  const repo = makeRepo(t)
  const ARGS = { ...FILE_ARGS, deep: { kind: 'bool' }, n: { kind: 'int' }, note: { kind: 'text' } }
  const { mod, seen } = program(async () => ({}), { ARGS, scopeOf: fileScope })
  const out = await start(repo, ['survey', '--question-file', 'q.md', '--deep', '--n', '3'], mod)
  assert.equal(out.ok, true)
  const { ctx, args } = seen.calls[0]
  assert.equal(ctx.resumable.program, 'survey')
  assert.deepEqual(ctx.resumable.scope, fileScope(args))
  assert.deepEqual(ctx.resumable.args, { question_file: 'q.md', deep: true, n: '3' })
})

test('the context carries the console and the ask launch was given', async (t) => {
  const repo = makeRepo(t)
  const ask = async () => 'yes'
  const { mod, seen } = program(async () => ({}))
  await start(repo, ['survey'], mod, { stdinIsTTY: true, ask })
  assert.equal(seen.calls[0].ctx.stdinIsTTY, true)
  assert.equal(seen.calls[0].ctx.ask, ask)
})

test('--root reaches the context, the repository without it', async (t) => {
  const repo = makeRepo(t)
  const other = makeRepo(t, { content: 'another repository\n' })
  const { mod, seen } = program(async () => ({}))
  await start(repo, ['survey', '--root', relative(repo, other)], mod)
  await start(repo, ['survey'], mod)
  const [withRoot, without] = seen.calls.map((c) => c.ctx)
  assert.ok(same(withRoot.root, other), withRoot.root)
  assert.ok(same(withRoot.repo, repo), withRoot.repo)
  assert.ok(same(without.repo, repo), without.repo)
  assert.equal(without.root, without.repo)
})

// --- faults and cost -------------------------------------------------------------------------

test('a program that throws records a program fault and ends failed', async (t) => {
  const repo = makeRepo(t)
  const { mod } = program(async (ctx) => { await step(ctx, 'before', async () => 1); throw new Error('the program broke') })
  const out = await start(repo, ['survey'], mod)
  assert.equal(out.error, 'the program broke')
  assert.equal('ok' in out, false)
  const [run] = runDirs(repo)
  const log = entries(repo, run)
  const [fault, ended] = log.slice(-2)
  assert.equal(fault.kind, 'fault')
  assert.equal(fault.node, '')
  assert.equal(fault.channel, 'program')
  assert.equal(fault.detail, 'the program broke')
  assert.equal(ended.kind, 'ended')
  assert.equal(ended.result.status, 'failed')
  assert.equal(ended.result.file, '')
  assert.equal(ended.result.complete, false)
})

test("the cost sums the run's returned records", async (t) => {
  const repo = makeRepo(t)
  const returned = (dispatch, usage, cost) => ({
    dispatch, session: 's-' + dispatch, status: 'returned', cause: '', usage, cost_total: cost, cost_usd: cost, denials: [],
  })
  const { mod } = program(async (ctx) => {
    ctx.log.append('returned', returned('d1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 1 }, 0.5))
    ctx.log.append('returned', returned('d2', { input_tokens: 4, output_tokens: 1 }, 0.25))
    ctx.log.append('returned', returned('d3', null, null))
    return {}
  })
  const out = await start(repo, ['survey'], mod)
  const cost = out.result.cost
  assert.equal(cost.dispatches, 3)
  assert.equal(cost.tokens, 10 + 5 + 100 + 1 + 4 + 1)
  assert.equal(cost.usd, 0.5 + 0.25)
  assert.equal(cost.unmeasured, 1)
  assert.deepEqual(readJson(out.result_file).cost, cost)
})

// --- detached runs ---------------------------------------------------------------------------

function detacher() {
  const seen = []
  return { seen, spawnChild: (o) => { seen.push(o); return 4242 } }
}

test('a detached start prints its run, pid, log and result file at once', async (t) => {
  const repo = makeRepo(t)
  const d = detacher()
  const { mod, seen } = program(async () => ({}), { ARGS: TEXT_ARGS })
  const out = await start(repo, ['survey', '--topic', 'x', '--detach'], mod, { spawnChild: d.spawnChild })
  assert.equal(out.ok, true)
  assert.equal(typeof out.run, 'string')
  assert.equal(out.pid, 4242)
  assert.equal(out.log, runLogFile(repo, out.run))
  assert.equal(out.result_file, resultPath(repo, out.run))
  assert.equal(seen.calls.length, 0)
  assert.deepEqual(entries(repo, out.run), [])
})

test('the detached child is the same command with --child, its output to run.log', async (t) => {
  const repo = makeRepo(t)
  const d = detacher()
  const { mod } = program(async () => ({}), { ARGS: { ...TEXT_ARGS, deep: { kind: 'bool' } } })
  const out = await start(repo, ['survey', '--topic', 'x', '--detach', '--deep'], mod, { spawnChild: d.spawnChild })
  assert.equal(d.seen.length, 1)
  assert.deepEqual(d.seen[0].args, ['survey', '--topic', 'x', '--deep', '--child', out.run])
  assert.equal(d.seen[0].logFile, runLogFile(repo, out.run))
  assert.equal(d.seen[0].cwd, repo)
})

test("a detached run's claim names the child's pid", async (t) => {
  const repo = makeRepo(t)
  const d = detacher()
  const { mod } = program(async () => ({}), { ARGS: TEXT_ARGS })
  const out = await start(repo, ['survey', '--topic', 'x', '--detach'], mod, { spawnChild: d.spawnChild })
  assert.equal(readJson(runJsonPath(repo, out.run)).pid, 4242)
})

test('a detached child that does not start is launch_failed', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}), { ARGS: TEXT_ARGS })
  const out = await start(repo, ['survey', '--topic', 'x', '--detach'], mod, { spawnChild: () => 0 })
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'launch_failed')
  assert.equal(seen.calls.length, 0)
  const [run] = runDirs(repo)
  assert.deepEqual(kinds(repo, run), ['fault', 'ended'])
})

test('a program that runs attached only refuses --detach', async (t) => {
  const repo = makeRepo(t)
  const d = detacher()
  const asked = []
  const { mod } = program(async () => ({}), {
    ARGS: { user_approved: { kind: 'bool' } },
    attachedOnly: (args) => { asked.push(args); return args.user_approved === true },
  })
  const refused = await start(repo, ['survey', '--user-approved', '--detach'], mod, { spawnChild: d.spawnChild })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.kind, 'attached_only')
  assert.equal(d.seen.length, 0)
  assert.deepEqual(runDirs(repo), [])
  const detached = await start(repo, ['survey', '--detach'], mod, { spawnChild: d.spawnChild })
  assert.equal(detached.ok, true)
  assert.equal(detached.pid, 4242)
  assert.equal(d.seen.length, 1)
  assert.ok(asked.some((a) => a.user_approved === false))
})

test('a child runs the program under its run with the arguments its claim recorded', async (t) => {
  const repo = makeRepo(t)
  const d = detacher()
  const { mod, seen } = program(async () => ({}), { ARGS: FILE_ARGS, scopeOf: fileScope })
  const parent = await start(repo, ['survey', '--question-file', 'q.md', '--detach'], mod, { spawnChild: d.spawnChild })
  assert.equal(parent.ok, true)
  const claimed = readJson(runJsonPath(repo, parent.run))
  writeFileSync(join(repo, 'q.md'), 'A different question entirely.\n')
  const child = await start(repo, d.seen[0].args, mod)
  assert.equal(child.ok, true)
  assert.equal(child.run, parent.run)
  assert.deepEqual(runDirs(repo), [parent.run])
  assert.deepEqual(kinds(repo, parent.run), ['run', 'ended'])
  assert.deepEqual(seen.calls[0].args, claimed.args)
  assert.equal(seen.calls[0].args.question, QUESTION)
  assert.equal(readJson(runJsonPath(repo, parent.run)).pid, process.pid)
})

test('a child of no recorded run is refused unknown_run', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}))
  const out = await start(repo, ['survey', '--child', '20250101-000000-survey'], mod)
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'unknown_run')
  assert.equal(seen.calls.length, 0)
})

// --- the CLI ---------------------------------------------------------------------------------

test('the CLI prints a refusal and exits 0', { timeout: 30_000 }, (t) => {
  const repo = makeRepo(t)
  const r = spawnSync(process.execPath, [RUN_MJS, 'nosuch'], { cwd: repo, env: childEnv(), encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
  const printed = JSON.parse(r.stdout)
  assert.equal(printed.ok, false)
  assert.equal(printed.error.kind, 'unknown_program')
})

test('a program that throws makes the CLI exit 1 with {error}', { timeout: 30_000 }, (t) => {
  const repo = makeRepo(t)
  writeJson(configPath(repo), { claude_cli: process.execPath })
  const fixture = join(repo, 'fixture-survey.mjs')
  writeFileSync(fixture, [
    'export const ARGS = {}',
    'export const scopeOf = () => ({})',
    "export const survey = async () => { throw new Error('the fixture broke') }",
    '',
  ].join('\n'))
  const hooks = join(repo, 'hooks.mjs')
  writeFileSync(hooks, [
    "import { registerHooks } from 'node:module'",
    'const fixture = ' + JSON.stringify(pathToFileURL(fixture).href),
    'registerHooks({',
    "  resolve(specifier, context, next) { return specifier === './programs/survey.mjs' ? { url: fixture, shortCircuit: true } : next(specifier, context) },",
    '})',
    '',
  ].join('\n'))
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(hooks).href, RUN_MJS, 'survey'], {
    cwd: repo, env: childEnv(), encoding: 'utf8', windowsHide: true, timeout: 25_000,
  })
  assert.equal(r.status, 1, r.stderr)
  const printed = JSON.parse(r.stdout)
  assert.equal(printed.error, 'the fixture broke')
})

test('a value that is not a handle, or a free text past its line, is refused args_unreadable before any run', async (t) => {
  const repo = makeRepo(t)
  const ARGS = { notes: { kind: 'text' }, base: { kind: 'token' }, roots: { kind: 'list' }, question_file: { kind: 'file' } }
  const { mod, seen } = program(async () => ({}), { ARGS })
  for (const argv of [
    ['--notes', 'one\ntwo'], ['--notes', 'x'.repeat(301)], ['--base', 'main branch'], ['--roots', 'src\nlib'],
    ['--question-file', 'q"x.md'], ['--repo', repo + '\n'],
  ]) {
    const out = await start(repo, ['survey', ...argv], mod)
    assert.deepEqual([out.ok, out.error && out.error.kind], [false, 'args_unreadable'], argv.join(' '))
  }
  assert.equal(seen.calls.length, 0)
  assert.deepEqual(runDirs(repo), [])
})

test('a line of free text under a text flag, spaces and quotes and all, reaches the program as given', async (t) => {
  const repo = makeRepo(t)
  const { mod, seen } = program(async () => ({}), { ARGS: { notes: { kind: 'text' }, base: { kind: 'token' } } })
  const notes = 'the "loader" is untested, see `load()`'
  await start(repo, ['survey', '--notes', notes, '--base', 'origin/main'], mod)
  assert.deepEqual([seen.calls[0].args.notes, seen.calls[0].args.base], [notes, 'origin/main'])
})

test('survey reads its prior from the file the session wrote, and takes no --prior', async (t) => {
  const repo = makeRepo(t)
  writeFileSync(join(repo, 'q.md'), 'how are configs loaded\n')
  writeFileSync(join(repo, 'prior.md'), 'An earlier pass concluded:\r\nthe loader caches.\n')
  const survey = await import('../lib/programs/survey.mjs')
  const started = []
  const detached = (...argv) => start(repo, ['survey', '--detach', ...argv], survey, { spawnChild: () => { started.push(argv); return 4242 } })
  const out = await detached('--question-file', 'q.md', '--prior-file', 'prior.md')
  assert.equal(out.ok, true, JSON.stringify(out))
  const meta = readJson(runJsonPath(repo, out.run))
  assert.equal(meta.args.prior, 'An earlier pass concluded:\nthe loader caches.')
  assert.equal(meta.raw.prior_file, 'prior.md')
  const refused = await detached('--question-file', 'q.md', '--prior', 'the loader caches')
  assert.deepEqual([refused.ok, refused.error.kind], [false, 'bad_arg'])
  assert.equal(started.length, 1, 'only the start with a prior file launched')
})

// ------------------------------------------------------------------ free text longer than a line

const NOTES_ARGS = { notes: { kind: 'text' }, notes_file: { kind: 'file', as: 'notes' } }
const LONG_NOTES = ['What the user said:', 'a change over several lines', 'n'.repeat(400)].join('\n')

test('a text past its line is refused naming its -file twin, where the program declares one', async (t) => {
  const repo = makeRepo(t)
  const twin = program(async () => ({}), { ARGS: NOTES_ARGS })
  const out = await start(repo, ['survey', '--notes', 'n'.repeat(301)], twin.mod)
  assert.deepEqual([out.ok, out.error.kind], [false, 'args_unreadable'])
  assert.match(out.error.message, /--notes-file/)

  const alone = program(async () => ({}), { ARGS: { notes: { kind: 'text' } } })
  const none = await start(repo, ['survey', '--notes', 'n'.repeat(301)], alone.mod)
  assert.doesNotMatch(none.error.message, /file/, 'no flag is named where the program has none')
  assert.deepEqual(runDirs(repo), [])
})

test('a text under its -file twin reaches the program whole, and one under --notes is not lost to the absent twin', async (t) => {
  const repo = makeRepo(t)
  writeFileSync(join(repo, 'notes.txt'), LONG_NOTES.replace(/\n/g, '\r\n') + '\r\n')
  const { mod, seen } = program(async () => ({}), { ARGS: NOTES_ARGS })
  assert.equal((await start(repo, ['survey', '--notes-file', 'notes.txt'], mod)).ok, true)
  assert.equal(seen.calls[0].args.notes, LONG_NOTES, 'the file\'s text, not its path')
  assert.equal((await start(repo, ['survey', '--notes', 'one line'], mod)).ok, true)
  assert.equal(seen.calls[1].args.notes, 'one line')
})

test('a text given by its flag and by its file is refused bad_arg, and by a file that is none unknown_file', async (t) => {
  const repo = makeRepo(t)
  writeFileSync(join(repo, 'notes.txt'), 'x')
  const { mod, seen } = program(async () => ({}), { ARGS: NOTES_ARGS })
  const both = await start(repo, ['survey', '--notes', 'y', '--notes-file', 'notes.txt'], mod)
  assert.deepEqual([both.ok, both.error.kind], [false, 'bad_arg'])
  const none = await start(repo, ['survey', '--notes-file', 'missing.txt'], mod)
  assert.deepEqual([none.ok, none.error.kind], [false, 'unknown_file'])
  assert.equal(seen.calls.length, 0)
})
