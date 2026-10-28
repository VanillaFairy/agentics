// lib/run.mjs — the CLI that starts a program: resolves its arguments or refuses them, claims the
// run for its program and scope, runs it attached or in a detached child, keeps its heartbeat, and
// writes its result with what it cost.
//
// Design: docs/DESIGN.md#programs.

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { SNAPSHOT } from './evidence.mjs'
import { askLine, hostProcess, resolveCli, runProcess } from './host.mjs'
import { logOf, readRunLog, runState } from './ledger.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import { programContext } from './programs/common.mjs'
import { boundRunner, closeLeftOpen } from './runner.mjs'
import {
  argProblem, claimLockPath, isRunId, mainCheckout, mkdirState, pidAlive, readConfig, readJson, resolveHandle, resultPath, revParse,
  runDir, runHome, runJsonPath, runLogFile, runsDir, stampNow, withLock, writeWhole,
} from './store.mjs'

export const PROGRAM_NAMES = ['survey', 'probe', 'solutions', 'investigate', 'drafts', 'rule', 'review', 'execute']
export const HEARTBEAT_MS = 10000

const RUN_MJS = fileURLToPath(import.meta.url)
const refuse = (kind, message, more = {}) => ({ ok: false, error: { kind, message, ...more } })
const flagName = (key) => key.replace(/_/g, '-')
const keyName = (flag) => flag.replace(/-/g, '_')

/**
 * Each argument kind: its value when the flag is absent, the `argProblem` kind its value is checked
 * as (`text` is named free text, one line), and how a given value resolves; `at` is {repo, root,
 * cwd, args so far}.
 */
export const KINDS = {
  file: { empty: '', check: 'path', resolve: (v, at) => resolveHandle(at.repo, 'file', resolve(at.cwd, v)) },
  text: { empty: '', check: 'text', resolve: (v) => ({ ok: true, value: v }) },
  token: { empty: '', check: 'handle', resolve: (v) => ({ ok: true, value: v }) },
  list: { empty: [], check: 'path', resolve: (v) => ({ ok: true, value: v.split(',').map((s) => s.trim()).filter(Boolean) }) },
  int: { empty: 0, check: 'handle', resolve: (v) => (/^\d+$/.test(v) ? { ok: true, value: Number(v) } : refuse('bad_arg', JSON.stringify(v) + ' is not a whole number')) },
  usd: { empty: 0, check: 'handle', resolve: (v) => (/^\d+(\.\d+)?$/.test(v) ? { ok: true, value: Number(v) } : refuse('bad_arg', JSON.stringify(v) + ' is not a dollar amount')) },
  snapshot: {
    empty: '', check: 'handle',
    resolve: (v) => (SNAPSHOT.test(v) ? { ok: true, value: v } : refuse('bad_arg', JSON.stringify(v) + ' is not a snapshot: give snapshot:<8 hex digits>, as a probe returns it')),
  },
  bool: { empty: false, check: 'switch', resolve: () => ({ ok: true, value: true }) },
  enum: {
    empty: '', check: 'handle',
    resolve: (v, at, a) => (a.values.includes(v) ? { ok: true, value: v } : refuse('bad_arg', JSON.stringify(v) + ' is not one of ' + a.values.join(', '))),
  },
  effort: { empty: '', check: 'handle', resolve: (v, at) => resolveHandle(at.repo, 'effort', v) },
  folder: { empty: '', check: 'handle', resolve: (v, at) => resolveHandle(at.repo, 'folder', v, { effort: at.args.effort }) },
  run: { empty: '', check: 'handle', resolve: (v, at) => resolveHandle(at.repo, 'run', v) },
  ref: {
    empty: '', check: 'handle',
    resolve: (v, at) => {
      const sha = revParse(at.root, v)
      return sha ? { ok: true, value: sha } : refuse('unknown_ref', 'no commit named ' + JSON.stringify(v))
    },
  },
}

/** The flag that carries `--flag`'s text from a file, when the program declares one: `--flag-file`, or ''. */
function fileTwinOf(spec, flag) {
  const twin = spec[keyName(flag) + '_file']
  return twin && twin.kind === 'file' && twin.as === keyName(flag) ? '--' + flag + '-file' : ''
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
      if (a.kind === 'file' && a.as && !Object.hasOwn(args, a.as)) args[a.as] = ''
      continue
    }
    const out = kind.resolve(given, { ...at, args }, a)
    if (!out.ok) return { refusal: { ok: false, error: out.error } }
    if (a.kind === 'file' && a.as && flags[flagName(a.as)] !== undefined) {
      return { refusal: refuse('bad_arg', 'give --' + flagName(a.as) + ' or --' + flagName(key) + ', not both') }
    }
    raw[key] = given
    args[key] = out.value
    if (a.kind === 'file' && a.as) args[a.as] = readFileSync(out.value, 'utf8').replace(/\r\n/g, '\n').trim()
  }
  return { args, raw }
}

/** A new run's id, taken by making its directory: `<base>`, else the first free `<base>-<n>`. */
function freshRun(repo, base) {
  mkdirState(runsDir(repo))
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
    names = readdirSync(runsDir(repo)).filter(isRunId)
  } catch {
    return []
  }
  return names.filter((run) => {
    const meta = readJson(runJsonPath(repo, run))
    return meta && meta.program === program && meta.scope_key === scopeKey
  })
}

/** Record a launch that failed on the run's log: '' when both records landed, else the append's refusal. */
function launchFailed(repo, run, detail) {
  try {
    const log = logOf(repo, run)
    log.append('fault', { node: '', channel: 'launch_failed', detail })
    log.append('ended', { result: { status: 'launch_failed', file: '', complete: false } })
    return ''
  } catch (err) {
    return err.message
  }
}

/** The launch_failed refusal; it names the append's refusal when the failure could not be recorded. */
const launchRefusal = (message, run, unrecorded) =>
  refuse('launch_failed', message + (unrecorded ? '; recording it failed: ' + unrecorded : ''), { run })

const liveRefusal = (repo, program, run, st) =>
  refuse('run_live', program + ' already runs over this scope as ' + run, { run, pid: st.run.pid, log: runLogFile(repo, run) })

/** Whether the run's current start recorded nothing: no record follows its latest `run`. */
function recordedNothing(repo, run) {
  const { entries } = readRunLog(repo, run)
  return entries.slice(entries.findLastIndex((e) => e.kind === 'run') + 1).length === 0
}

function refuseUnrecorded(repo, run) {
  const unrecorded = launchFailed(repo, run, 'nothing was recorded since the run last started')
  return launchRefusal(run + ' recorded nothing since it last started; start the same command again', run, unrecorded)
}

/** Write run.json, start the run's process with `start(run)`, and name its pid in run.json. */
function startRun(repo, run, meta, at, start) {
  writeWhole(runJsonPath(repo, run), { ...meta, pid: 0, heartbeat_at: at.toISOString() })
  const pid = start(run)
  if (!(Number.isInteger(pid) && pid > 0)) {
    return launchRefusal('the process for ' + run + ' did not start', run, launchFailed(repo, run, 'the run\'s process did not start'))
  }
  writeWhole(runJsonPath(repo, run), { ...meta, pid, heartbeat_at: at.toISOString() })
  return { ok: true, run, pid }
}

/**
 * Under the claim's lock, for a program with no home of its own: refuse a live run of this program
 * and scope, resume a stopped one with the same arguments, or mint a new run.
 */
function claim(repo, { program, scope, scopeKey, args, argsDigest, raw, session, at, alive, runs, start }) {
  const mine = runsOf(repo, program, scopeKey).map((run) => ({ run, st: runState(repo, run, { now: at.getTime(), alive, runs }) }))
  const live = mine.find(({ st }) => st.state === 'live')
  if (live) return liveRefusal(repo, program, live.run, live.st)
  const stopped = mine.filter(({ st }) => st.state === 'stopped' && st.run.args_digest === argsDigest).sort((a, b) => (a.run < b.run ? -1 : 1)).pop()
  if (stopped) return recordedNothing(repo, stopped.run) ? refuseUnrecorded(repo, stopped.run) : startRun(repo, stopped.run, { ...stopped.st.run, session }, at, start)
  const run = freshRun(repo, stampNow(at) + '-' + program)
  return startRun(repo, run, { run, program, scope, scope_key: scopeKey, args, args_digest: argsDigest, raw, session, started_at: at.toISOString() }, at, start)
}

/**
 * Under the claim's lock, for a program that names its home (`homeOf`): refuse the home while it is
 * live, refuse launch_failed a stopped one whose current run recorded nothing, else start the run
 * there with these arguments, whatever an earlier run of it was given.
 */
function claimHome(repo, run, { program, scope, scopeKey, args, argsDigest, raw, session, at, alive, runs, start }) {
  if (!isRunId(run)) throw new Error(program + "'s homeOf names no run id: " + JSON.stringify(run))
  const st = runState(repo, run, { now: at.getTime(), alive, runs })
  if (st.state === 'live') return liveRefusal(repo, program, run, st)
  if (st.state === 'stopped' && recordedNothing(repo, run)) return refuseUnrecorded(repo, run)
  return startRun(repo, run, { run, program, scope, scope_key: scopeKey, args, args_digest: argsDigest, raw, session, started_at: at.toISOString() }, at, start)
}

const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']

/** Pure. The tokens a host usage figure counts. */
const tokensOf = (usage) => TOKEN_FIELDS.reduce((sum, k) => sum + (usage && Number.isFinite(usage[k]) ? usage[k] : 0), 0)

/** Pure. A spend with nothing in it: what a set of calls cost. */
export const spend = () => ({ dispatches: 0, tokens: 0, usd: 0, unmeasured: 0 })

/** Add one call to a spend. */
export function addCall(into, call) {
  into.dispatches += 1
  into.tokens += call.tokens
  into.usd += call.usd
  if (!call.measured) into.unmeasured += 1
}

const placeOf = ({ node, model, role, thread, round }) => ({ node, model, role, thread, round })

/**
 * Pure. The calls one log's records hold, in seq order: each `returned` line put to the node,
 * model, role, thread and round of the latest `dispatched` of its dispatch before it, measured when
 * it carries a numeric `cost_usd`, and its `first_read` the tokens its first model turn read
 * (`opened`) when that dispatch opened its session, else null; and, unless its run is live, each
 * dispatch whose latest `dispatched` has no `returned` after it, a call that never returned,
 * unmeasured. A `dispatched` line naming no dispatch is no runner call.
 */
export function callsOf(entries, live) {
  const latest = new Map()
  const sessions = new Set()
  const calls = []
  for (const e of entries) {
    if (typeof e.dispatch !== 'string') continue
    if (e.kind === 'dispatched') {
      latest.set(e.dispatch, {
        node: String(e.node || ''), model: String(e.model || ''), role: String(e.role || ''), thread: String(e.thread || ''),
        round: Number.isInteger(e.round) ? e.round : 0, open: true, opens: !sessions.has(e.session),
      })
      sessions.add(e.session)
    }
    if (e.kind !== 'returned') continue
    const d = latest.get(e.dispatch) || { node: '', model: '', role: '', thread: '', round: 0 }
    d.open = false
    const measured = typeof e.cost_usd === 'number'
    const firstRead = d.opens && typeof e.opened === 'number' ? e.opened : null
    calls.push({ ...placeOf(d), tokens: tokensOf(e.usage), usd: measured ? e.cost_usd : 0, measured, first_read: firstRead })
  }
  if (!live) for (const d of latest.values()) if (d.open) calls.push({ ...placeOf(d), tokens: 0, usd: 0, measured: false, first_read: null })
  return calls
}

/**
 * Pure. What a run's calls cost, from its records in seq order: `callsOf` over them while the run
 * goes on, so a call not yet returned is no call yet, summed, and per model; a call put to no model
 * is in the totals alone.
 */
export function costOf(entries) {
  const cost = { ...spend(), by_model: {} }
  for (const call of callsOf(entries, true)) {
    addCall(cost, call)
    if (call.model) addCall(cost.by_model[call.model] ||= spend(), call)
  }
  return cost
}

/**
 * Run a claimed run in this process: records its start, closes the calls an earlier run of its home
 * left open, beats, runs the program, writes its result and its end.
 */
async function runProgram({ mod, program, repo, root, run, scope, args, raw, cli, runner, env, now, stdinIsTTY, ask, heartbeatMs }) {
  const log = logOf(repo, run)
  const home = runHome(repo, run)
  log.append('run', { program, scope, pid: process.pid })
  const closed = closeLeftOpen({ log, proc: hostProcess(cli), dir: home.dir })
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
    const { intelligence = 'normal' } = args
    const ctx = programContext({
      intelligence, repo, root, run, dir: home.dir, execution: home.stamp || run, effort: home.effort, log,
      runAgent: (runner || boundRunner)({ repo: mainCheckout(repo), cli, log, env }),
      now: () => now().toISOString(), sleep: (ms) => new Promise((wake) => setTimeout(wake, ms)), env,
      maxAgents: Number.isInteger(config.max_agents) && config.max_agents > 0 ? config.max_agents : 6,
      resumable: { program, scope, args: raw }, stdinIsTTY, ask, closed,
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
 * `repo`); `spawnChild({args, logFile, cwd, env})` starts a detached child and gives its pid. A
 * module that exports `homeOf(args, {repo, now}) → {run}` is claimed in that home, asked under the
 * claim lock so two starts racing on one home see one another; `now` is this start's clock.
 */
export async function launch({
  argv, cwd = process.cwd(), env = process.env, now = () => new Date(), stdinIsTTY = false, ask = null,
  load = (name) => import('./programs/' + name + '.mjs'), runner = null, spawnChild = null, heartbeatMs = HEARTBEAT_MS,
  alive = pidAlive, runs = runProcess,
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
  // Every value a session passed is a handle, or one line of the free text a `text` argument names.
  const checkOf = (flag) => (flag === 'repo' || flag === 'root' ? 'path' : flag === 'child' ? 'handle' : (KINDS[spec[keyName(flag)].kind] || {}).check || 'handle')
  for (const [flag, value] of Object.entries(flags)) {
    const why = value === true ? '' : argProblem(value, checkOf(flag), fileTwinOf(spec, flag))
    if (why) return refuse('args_unreadable', '--' + flag + ' ' + why)
  }
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
  if (!host.ok) return host

  const scope = mod.scopeOf(args, { repo, root })
  const scopeKey = fnv1a(canonical(scope))
  const childArgs = (run) => [program, ...rest.filter((a) => a !== '--detach'), '--child', run]
  const start = detach
    ? (run) => (spawnChild || spawnDetached)({ args: childArgs(run), logFile: runLogFile(repo, run), cwd, env })
    : () => process.pid
  const claimed = withLock(claimLockPath(repo, program, scopeKey), () => {
    const job = { program, scope, scopeKey, args, argsDigest: fnv1a(canonical(args)), raw, session: env.CLAUDE_CODE_SESSION_ID || '', at: now(), alive, runs, start }
    return mod.homeOf ? claimHome(repo, mod.homeOf(args, { repo, now: job.at }).run, job) : claim(repo, job)
  })
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
