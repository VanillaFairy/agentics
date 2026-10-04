// lib/run.mjs — the CLI that starts a program: resolves its arguments or refuses them, claims the
// run for its program and scope, runs it attached or in a detached child, keeps its heartbeat, and
// writes its result with what it cost.
//
// Design: docs/DESIGN.md#programs.

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { askLine, resolveCli } from './host.mjs'
import { appendRun, readRunLog, runLog, runState } from './ledger.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import { programContext } from './programs/common.mjs'
import { boundRunner } from './runner.mjs'
import {
  isRunId, mainCheckout, mkdirState, pidAlive, projectStateDir, readConfig, readJson, resolveHandle, resultPath, revParse,
  runDir, runJsonPath, runLogFile, stampNow, withLock,
} from './store.mjs'

export const PROGRAM_NAMES = ['survey', 'probe', 'solutions', 'investigate', 'drafts', 'rule', 'review']
export const HEARTBEAT_MS = 10000

const RUN_MJS = fileURLToPath(import.meta.url)
const refuse = (kind, message, more = {}) => ({ ok: false, error: { kind, message, ...more } })
const flagName = (key) => key.replace(/_/g, '-')
const keyName = (flag) => flag.replace(/-/g, '_')

/** Each argument kind: its value when the flag is absent, and how a given value resolves; `at` is {repo, root, cwd, args so far}. */
const KINDS = {
  file: { empty: '', resolve: (v, at) => resolveHandle(at.repo, 'file', resolve(at.cwd, v)) },
  text: { empty: '', resolve: (v) => ({ ok: true, value: v }) },
  list: { empty: [], resolve: (v) => ({ ok: true, value: v.split(',').map((s) => s.trim()).filter(Boolean) }) },
  int: { empty: 0, resolve: (v) => (/^\d+$/.test(v) ? { ok: true, value: Number(v) } : refuse('bad_arg', JSON.stringify(v) + ' is not a whole number')) },
  bool: { empty: false, resolve: () => ({ ok: true, value: true }) },
  enum: {
    empty: '',
    resolve: (v, at, a) => (a.values.includes(v) ? { ok: true, value: v } : refuse('bad_arg', JSON.stringify(v) + ' is not one of ' + a.values.join(', '))),
  },
  effort: { empty: '', resolve: (v, at) => resolveHandle(at.repo, 'effort', v) },
  folder: { empty: '', resolve: (v, at) => resolveHandle(at.repo, 'folder', v, { effort: at.args.effort }) },
  run: { empty: '', resolve: (v, at) => resolveHandle(at.repo, 'run', v) },
  ref: {
    empty: '',
    resolve: (v, at) => {
      const sha = revParse(at.root, v)
      return sha ? { ok: true, value: sha } : refuse('unknown_ref', 'no commit named ' + JSON.stringify(v))
    },
  },
}

/** The flags after the program's name: `--name value`, or `--name` alone for one that takes none. */
function readFlags(argv, takesNone) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) return { problem: 'not a flag: ' + JSON.stringify(argv[i]) }
    const name = argv[i].slice(2)
    if (takesNone(name)) {
      flags[name] = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) return { problem: '--' + name + ' needs a value' }
    flags[name] = value
    i++
  }
  return { flags }
}

/** Every argument a program declares, resolved from its flag in declaration order, or the first refusal. */
function resolveArgs(spec, flags, at) {
  const args = {}
  const raw = {}
  for (const [key, a] of Object.entries(spec)) {
    const kind = KINDS[a.kind]
    if (!kind) throw new Error('the argument ' + key + ' has no kind ' + JSON.stringify(a.kind))
    const given = flags[flagName(key)]
    if (given === undefined) {
      if (a.required) return { refusal: refuse('missing_arg', '--' + flagName(key) + ' is required') }
      args[key] = Object.hasOwn(a, 'default') ? a.default : kind.empty
      if (a.kind === 'file' && a.as) args[a.as] = ''
      continue
    }
    const out = kind.resolve(given, { ...at, args }, a)
    if (!out.ok) return { refusal: { ok: false, error: out.error } }
    raw[key] = given
    args[key] = out.value
    if (a.kind === 'file' && a.as) args[a.as] = readFileSync(out.value, 'utf8').replace(/\r\n/g, '\n').trim()
  }
  return { args, raw }
}

/** A JSON file replaced whole: a reader never sees half of it. */
function writeWhole(path, value) {
  mkdirState(dirname(path))
  const staged = path + '.' + process.pid + '.tmp'
  writeFileSync(staged, JSON.stringify(value), 'utf8')
  renameSync(staged, path)
}

/** A new run's id, taken by making its directory: `<base>`, else the first free `<base>-<n>`. */
function freshRun(repo, base) {
  mkdirState(join(projectStateDir(repo), 'runs'))
  for (let n = 1; ; n++) {
    const run = n === 1 ? base : base + '-' + n
    try {
      mkdirSync(runDir(repo, run))
      return run
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
}

/** The runs of one program and scope, by their run.json; a run.json that cannot be read claims nothing. */
function runsOf(repo, program, scopeKey) {
  let names = []
  try {
    names = readdirSync(join(projectStateDir(repo), 'runs')).filter(isRunId)
  } catch {
    return []
  }
  return names.filter((run) => {
    const meta = readJson(runJsonPath(repo, run))
    return meta && meta.program === program && meta.scope_key === scopeKey
  })
}

const launchFailed = (repo, run, detail) => appendRun(repo, run, [
  { kind: 'fault', node: '', channel: 'launch_failed', detail },
  { kind: 'ended', result: { status: 'launch_failed', file: '', complete: false } },
])

/**
 * Under the claim's lock: refuse a live run of this program and scope, resume a stopped one with the
 * same arguments, or mint a new run; then `start(run)` gives the pid that drives it.
 */
function claim(repo, { program, scope, scopeKey, args, argsDigest, raw, at, alive, start }) {
  const mine = runsOf(repo, program, scopeKey).map((run) => ({ run, st: runState(repo, run, { now: at.getTime(), alive }) }))
  const live = mine.find(({ st }) => st.state === 'live')
  if (live) {
    return refuse('run_live', program + ' already runs over this scope as ' + live.run, { run: live.run, pid: live.st.run.pid, log: runLogFile(repo, live.run) })
  }
  const stopped = mine.filter(({ st }) => st.state === 'stopped' && st.run.args_digest === argsDigest).sort((a, b) => (a.run < b.run ? -1 : 1)).pop()
  let run
  let meta
  if (stopped) {
    const entries = readRunLog(repo, stopped.run).entries
    if (entries.slice(entries.findLastIndex((e) => e.kind === 'run') + 1).length === 0) {
      launchFailed(repo, stopped.run, 'nothing was recorded since the run last started')
      return refuse('launch_failed', stopped.run + ' recorded nothing since it last started; start it again for a new run', { run: stopped.run })
    }
    run = stopped.run
    meta = stopped.st.run
  } else {
    run = freshRun(repo, stampNow(at) + '-' + program)
    meta = { run, program, scope, scope_key: scopeKey, args, args_digest: argsDigest, raw, started_at: at.toISOString() }
  }
  writeWhole(runJsonPath(repo, run), { ...meta, pid: 0, heartbeat_at: at.toISOString() })
  const pid = start(run)
  if (!(Number.isInteger(pid) && pid > 0)) {
    launchFailed(repo, run, 'the run\'s process did not start')
    return refuse('launch_failed', 'the process for ' + run + ' did not start', { run })
  }
  writeWhole(runJsonPath(repo, run), { ...meta, pid, heartbeat_at: at.toISOString() })
  return { ok: true, run, pid }
}

/** Pure. What a run's calls cost, from its `returned` records: a call without a cost figure is unmeasured. */
function costOf(entries) {
  const returned = entries.filter((e) => e.kind === 'returned')
  const tokensOf = (u) => ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .reduce((sum, k) => sum + (u && Number.isFinite(u[k]) ? u[k] : 0), 0)
  return {
    dispatches: returned.length,
    tokens: returned.reduce((sum, e) => sum + tokensOf(e.usage), 0),
    usd: returned.reduce((sum, e) => sum + (typeof e.cost_usd === 'number' ? e.cost_usd : 0), 0),
    unmeasured: returned.filter((e) => typeof e.cost_usd !== 'number').length,
  }
}

/** Run a claimed run in this process: records its start, beats, runs the program, writes its result and its end. */
async function runProgram({ mod, program, repo, root, run, scope, args, raw, cli, runner, env, now, stdinIsTTY, ask, heartbeatMs }) {
  const log = runLog(repo, run)
  log.append('run', { program, scope, pid: process.pid })
  const beat = () => {
    try {
      const meta = readJson(runJsonPath(repo, run))
      if (meta) writeWhole(runJsonPath(repo, run), { ...meta, pid: process.pid, heartbeat_at: now().toISOString() })
    } catch {
      // a beat missed is caught up by the next; a run whose beats stop reads as stopped
    }
  }
  beat()
  const timer = setInterval(beat, heartbeatMs)
  timer.unref()
  try {
    const config = readConfig(repo)
    const ctx = programContext({
      repo, root, run, log, runAgent: (runner || boundRunner)({ repo: mainCheckout(repo), cli, log, env }),
      now: () => now().toISOString(), sleep: (ms) => new Promise((wake) => setTimeout(wake, ms)), env,
      maxAgents: Number.isInteger(config.max_agents) && config.max_agents > 0 ? config.max_agents : 6,
      resumable: { program, scope, args: raw }, stdinIsTTY, ask,
    })
    let result
    try {
      result = await mod[program](ctx, args)
    } catch (err) {
      const detail = err && err.message ? err.message : String(err)
      log.append('fault', { node: '', channel: 'program', detail })
      log.append('ended', { result: { status: 'failed', file: '', complete: false } })
      return { error: detail }
    }
    const file = resultPath(repo, run)
    const whole = { ...result, run, cost: costOf(log.entries()) }
    writeWhole(file, whole)
    log.append('ended', { result: { status: 'done', file, complete: result?.coverage?.complete === true } })
    return { ok: true, run, result_file: file, result: whole }
  } finally {
    clearInterval(timer)
  }
}

/** The production child: this CLI again, detached, its output to the run's log file. */
function spawnDetached({ args, logFile, cwd, env }) {
  mkdirState(dirname(logFile))
  const fd = openSync(logFile, 'a')
  try {
    const child = spawn(process.execPath, [RUN_MJS, ...args], { cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
    child.on('error', () => {})
    child.unref()
    return child.pid ?? 0
  } finally {
    closeSync(fd)
  }
}

/**
 * One start of the CLI, in-process: what it prints, as an object. `load(name)` gives a program's
 * module; `runner({repo, cli, log, env})` the runAgent its calls go through (the main checkout is
 * `repo`); `spawnChild({args, logFile, cwd, env})` starts a detached child and gives its pid.
 */
export async function launch({
  argv, cwd = process.cwd(), env = process.env, now = () => new Date(), stdinIsTTY = false, ask = null,
  load = (name) => import('./programs/' + name + '.mjs'), runner = null, spawnChild = null, heartbeatMs = HEARTBEAT_MS,
  alive = pidAlive,
}) {
  const [program, ...rest] = argv
  if (!PROGRAM_NAMES.includes(program)) return refuse('unknown_program', 'no program named ' + JSON.stringify(program ?? '') + ': ' + PROGRAM_NAMES.join(', '))
  const mod = await load(program)
  const spec = mod.ARGS || {}
  const read = readFlags(rest, (name) => name === 'detach' || spec[keyName(name)]?.kind === 'bool')
  if (read.problem) return refuse('bad_arg', read.problem)
  const { flags } = read
  const known = new Set(['repo', 'root', 'detach', 'child', ...Object.keys(spec).map(flagName)])
  const unknown = Object.keys(flags).find((f) => !known.has(f))
  if (unknown) return refuse('bad_arg', 'no flag --' + unknown + ' for ' + program)
  const repo = resolve(cwd, flags.repo || '.')
  const root = flags.root ? resolve(cwd, flags.root) : repo
  const host = runner ? { ok: true, path: '' } : resolveCli({ config: readConfig(repo), env })
  const go = (run, meta) => runProgram({
    mod, program, repo, root, run, scope: meta.scope, args: meta.args, raw: meta.raw, cli: host.path, runner, env, now,
    stdinIsTTY, ask, heartbeatMs,
  })

  if (flags.child) {
    const meta = isRunId(flags.child) ? readJson(runJsonPath(repo, flags.child)) : null
    if (!meta || meta.program !== program) return refuse('unknown_run', 'no run of ' + program + ' named ' + JSON.stringify(flags.child))
    if (!host.ok) return host
    return go(flags.child, meta)
  }

  const resolved = resolveArgs(spec, flags, { repo, root, cwd })
  if (resolved.refusal) return resolved.refusal
  const { args, raw } = resolved
  const detach = flags.detach === true
  if (detach && mod.attachedOnly?.(args)) return refuse('attached_only', program + ' with these arguments takes the user\'s word at this console: run it without --detach')
  if (!host.ok) return host

  const scope = mod.scopeOf(args, { repo, root })
  const scopeKey = fnv1a(canonical(scope))
  const childArgs = (run) => [program, ...rest.filter((a) => a !== '--detach'), '--child', run]
  const start = detach
    ? (run) => (spawnChild || spawnDetached)({ args: childArgs(run), logFile: runLogFile(repo, run), cwd, env })
    : () => process.pid
  const claimed = withLock(join(projectStateDir(repo), 'runs', '.claims', program + '-' + scopeKey + '.lock'), () =>
    claim(repo, { program, scope, scopeKey, args, argsDigest: fnv1a(canonical(args)), raw, at: now(), alive, start }))
  if (!claimed.ok) return claimed
  if (detach) return { ok: true, run: claimed.run, pid: claimed.pid, log: runLogFile(repo, claimed.run), result_file: resultPath(repo, claimed.run) }
  return go(claimed.run, { scope, args, raw })
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  launch({ argv: process.argv.slice(2), stdinIsTTY: process.stdin.isTTY === true, ask: askLine }).then(
    (out) => {
      console.log(JSON.stringify(out))
      process.exit(Object.hasOwn(out, 'ok') ? 0 : 1)
    },
    (err) => {
      console.log(JSON.stringify({ error: err.message }))
      process.exit(1)
    },
  )
}
