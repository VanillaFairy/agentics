// lib/ledger.mjs — the only writer of an effort's durable records, and the one place `seq` is
// minted.
//
// Design: docs/DESIGN.md#the-ledger.
//
// Why a digest. A caller that hands over a batch with its digest gets it written only if what
// arrived is what was digested: corruption is refused at rest rather than discovered later.
//
// Why the counter lives here. Records are ordered by `seq`, one monotonic integer per effort,
// across the node log, the event log and every execution's state and journal. It is a counter
// rather than a clock because an agent that can read a clock can invent one, and a fabricated
// timestamp orders two records confidently and wrongly. The writer mints it, under the effort's
// lock file, so no agent ever supplies one and concurrent executions of one effort cannot mint the
// same number. A `seq` that arrives on an entry is ignored and overwritten. The project `.state/`
// has its own counter and lock for the project-wide logs.
//
// Why the check is thin. This is a transport check, not a schema: every entry must be an object
// with a `kind`. A writer that validated every record kind's full shape would refuse a line
// written by a newer plugin against an older installed lib — a forward-compatible append turned
// into a lost record, which is the exact damage this file exists to prevent. Shapes are checked
// by their owners (`lib/tree.mjs` for nodes) before they reach here.

import {
  appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { runProcess } from './host.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import {
  STAMP, effortStateDir, evidenceItemsPath, executionsRoot, isRunId, pidAlive, posix, projectStateDir, readJson,
  runHome, runJsonPath, runLogPath, safeSlug, withLock, mkdirState,
} from './store.mjs'

/** The effort-level logs, and the per-execution ones. */
const EFFORT_FILES = { nodes: 'nodes.jsonl', events: 'events.jsonl', ledger: 'ledger.jsonl', cites: 'cites.jsonl' }
const EXECUTION_FILES = { state: 'state.jsonl', journal: 'journal.jsonl' }

/** The node events. Readers ignore a kind they do not know; writers use only these. */
export const EVENT_KINDS = ['planned', 'replanned', 'dispatched', 'approved', 'merged',
  'escalated', 'parked', 'landed', 'claims', 'noted', 'message', 'outside', 'nets', 'judged', 'withdrawn', 'paused', 'resumed']

/** Pure. The digest a batch of entries travels under — the same canonical form everywhere. */
export const digestEntries = (entries) => fnv1a(canonical(entries))

/**
 * Pure. The file a ledger name refers to, or an error. `nodes`, `events`, `state:<stamp>`,
 * `journal:<stamp>`.
 */
export function fileFor(repo, effort, name) {
  const slug = safeSlug(effort)
  if (!slug) return { error: 'not an effort name: ' + JSON.stringify(effort) }
  const dir = effortStateDir(repo, slug)
  if (Object.hasOwn(EFFORT_FILES, name)) return { path: join(dir, EFFORT_FILES[name]), dir, executions: executionsRoot(repo, slug) }

  const [kind, stamp] = String(name || '').split(':')
  if (Object.hasOwn(EXECUTION_FILES, kind) && STAMP.test(stamp || '')) {
    return { path: join(executionsRoot(repo, slug), stamp, EXECUTION_FILES[kind]), dir, executions: executionsRoot(repo, slug) }
  }
  return { error: 'unknown ledger file ' + JSON.stringify(name) + ' — expected nodes, events, ledger, cites, state:<stamp> or journal:<stamp>' }
}

/** Pure. What is wrong with one entry about to be appended, or null. */
function entryProblem(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'a ledger line must be a JSON object'
  if (typeof entry.kind !== 'string' || entry.kind === '') return 'a ledger line must carry a non-empty "kind"'
  return null
}

/**
 * Read one log tolerantly: unparseable lines are counted, never thrown on. A torn last line from
 * a killed writer must not make the whole history unreadable.
 * @returns {{entries: object[], malformed: number}}
 */
export function parseLog(text) {
  const entries = []
  let malformed = 0
  for (const line of String(text || '').split('\n')) {
    if (line.trim() === '') continue
    try {
      const entry = JSON.parse(line)
      if (entryProblem(entry) === null) entries.push(entry)
      else malformed++
    } catch {
      malformed++
    }
  }
  return { entries, malformed }
}

export function readLog(repo, effort, name) {
  const where = fileFor(repo, effort, name)
  if (where.error) return { entries: [], malformed: 0, error: where.error }
  if (!existsSync(where.path)) return { entries: [], malformed: 0 }
  return parseLog(readFileSync(where.path, 'utf8'))
}

/** The highest seq in one log file, 0 when it is absent or holds none. */
function fileSeqMax(path) {
  if (!existsSync(path)) return 0
  return parseLog(readFileSync(path, 'utf8')).entries
    .reduce((max, e) => (Number.isInteger(e.seq) && e.seq > max ? e.seq : max), 0)
}

/** The highest seq on disk across every log of the effort — the counter's rebuild. */
function maxSeqOnDisk(dir, executions) {
  const paths = Object.values(EFFORT_FILES).map((file) => join(dir, file))
  if (existsSync(executions)) {
    for (const stamp of readdirSync(executions)) {
      for (const file of Object.values(EXECUTION_FILES)) paths.push(join(executions, stamp, file))
    }
  }
  return Math.max(0, ...paths.map(fileSeqMax))
}

/**
 * Append entries, all or nothing, minting one `seq` per entry under the effort's lock.
 *
 * Append, never read-then-write: a rewrite has a window where the file is truncated, and a run
 * that dies inside it loses every line rather than one.
 *
 * @param {string} repo
 * @param {string} effort
 * @param {string} name   nodes | events | ledger | cites | state:<stamp> | journal:<stamp>
 * @param {object|object[]} entries
 * @param {{digest?: string}} [opts] the digest the caller minted over `entries` as sent
 * @returns {{ok: true, seqs: number[], path: string} | {ok: false, error: string}}
 */
export function append(repo, effort, name, entries, { digest = '' } = {}) {
  const where = fileFor(repo, effort, name)
  if (where.error) return { ok: false, error: where.error }
  const refusal = batchRefusal(entries, digest)
  if (refusal) return { ok: false, error: refusal }
  const batch = Array.isArray(entries) ? entries : [entries]

  try {
    return withLock(join(where.dir, '.lock'), () => {
      mkdirState(join(where.path, '..'))
      return mintAndAppend(join(where.dir, 'seq'), where.path, batch, () => maxSeqOnDisk(where.dir, where.executions))
    })
  } catch (err) {
    return { ok: false, error: 'the append failed: ' + err.message }
  }
}

/** The refusal a batch earns before anything is locked, or '' when it may be written. */
function batchRefusal(entries, digest) {
  if (digest) {
    const actual = digestEntries(entries)
    if (actual !== digest) {
      return 'digest mismatch: the caller minted ' + digest + ', these entries digest to ' + actual +
        ' — something changed between there and here, so nothing was written. Copy them again, exactly.'
    }
  }
  const batch = Array.isArray(entries) ? entries : [entries]
  if (batch.length === 0) return 'nothing to append'
  for (const [i, entry] of batch.entries()) {
    const problem = entryProblem(entry)
    if (problem) return 'entry ' + i + ': ' + problem + ' — nothing was written'
  }
  return ''
}

/** Under a lock the caller holds: mint one seq per entry, append the lines, then move the counter. */
function mintAndAppend(counter, path, batch, rebuild, { reconcile = false } = {}) {
  let last = Number.parseInt(existsSync(counter) ? readFileSync(counter, 'utf8') : '', 10)
  // The counter moves after the lines land: a crash between the two leaves the counter behind the
  // log. A missing or unparseable counter always rebuilds from disk. `reconcile` additionally
  // guards against a stale-but-parseable counter left behind by that crash: the effort log skips
  // this (a scan would cost every execution directory per append), so `append` still trusts a
  // parseable counter as-is; the project and run logs have no such cost, so `appendProject` and
  // `appendRun` reconcile on every call, taking the max of the counter and what's already on disk.
  if (!Number.isInteger(last)) last = rebuild()
  else if (reconcile) last = Math.max(last, rebuild())

  const seqs = batch.map((_, i) => last + 1 + i)
  const lines = batch.map((entry, i) => JSON.stringify({ ...entry, seq: seqs[i] }) + '\n').join('')
  appendFileSync(path, (endsTorn(path) ? '\n' : '') + lines, 'utf8')
  writeFileSync(counter, String(seqs[seqs.length - 1]), 'utf8')
  return { ok: true, seqs, path: posix(path) }
}

/** Whether a log ends in a line a killed writer tore: it holds bytes and no final newline. */
function endsTorn(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const { size } = fstatSync(fd)
    if (size === 0) return false
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * The project-wide logs: machinery every effort in the project shares, under the project `.state/`,
 * with one seq and one lock of their own. Evidence items are here because a fact about the code
 * belongs to no single effort.
 */
const PROJECT_FILES = { items: evidenceItemsPath }

function projectFileFor(repo, name) {
  if (!Object.hasOwn(PROJECT_FILES, name)) {
    return { error: 'unknown project log ' + JSON.stringify(name) + ' — expected ' + Object.keys(PROJECT_FILES).join(', ') }
  }
  return { path: PROJECT_FILES[name](repo), dir: projectStateDir(repo) }
}

export function readProjectLog(repo, name) {
  const where = projectFileFor(repo, name)
  if (where.error) return { entries: [], malformed: 0, error: where.error }
  if (!existsSync(where.path)) return { entries: [], malformed: 0 }
  return parseLog(readFileSync(where.path, 'utf8'))
}

const projectSeqOnDisk = (repo) => Math.max(0, ...Object.values(PROJECT_FILES).map((pathOf) => fileSeqMax(pathOf(repo))))

/** `append`, for a project-wide log: all or nothing, seq minted under `<projectStateDir>/.lock`. */
export function appendProject(repo, name, entries, { digest = '' } = {}) {
  const where = projectFileFor(repo, name)
  if (where.error) return { ok: false, error: where.error }
  const refusal = batchRefusal(entries, digest)
  if (refusal) return { ok: false, error: refusal }
  const batch = Array.isArray(entries) ? entries : [entries]
  try {
    return withLock(join(where.dir, '.lock'), () => {
      mkdirState(dirname(where.path))
      return mintAndAppend(join(where.dir, 'seq'), where.path, batch, () => projectSeqOnDisk(repo), { reconcile: true })
    })
  } catch (err) {
    return { ok: false, error: 'the append failed: ' + err.message }
  }
}

/** The highest seq the effort has minted, 0 when none. */
export function seqMax(repo, effort) {
  const slug = safeSlug(effort)
  if (!slug) return 0
  const dir = effortStateDir(repo, slug)
  const counter = join(dir, 'seq')
  const fromCounter = Number.parseInt(existsSync(counter) ? readFileSync(counter, 'utf8') : '', 10)
  return Math.max(Number.isInteger(fromCounter) ? fromCounter : 0, maxSeqOnDisk(dir, executionsRoot(repo, slug)))
}

/** The effort's counter as it stands, read alone: it moves whenever any writer records anything. 0 when unreadable. */
export function lastMinted(repo, effort) {
  const slug = safeSlug(effort)
  if (!slug) return 0
  const counter = join(effortStateDir(repo, slug), 'seq')
  const n = Number.parseInt(existsSync(counter) ? readFileSync(counter, 'utf8') : '', 10)
  return Number.isInteger(n) ? n : 0
}

// ------------------------------------------------------------------ an execution's log port

/** The kinds an execution journals: what was observed, by whoever observed it. */
const JOURNAL_KINDS = ['verify-observed', 'merge-observed', 'series-done', 'authored']

const seqOf = (e) => (Number.isInteger(e.seq) ? e.seq : 0)

/** One execution's records as on disk, merged by seq: its events, every `message` and `withdrawn` of no execution, its state and its journal. */
function executionEntries(repo, effort, stamp) {
  const ours = (e) => e.execution === stamp || ((e.kind === 'message' || e.kind === 'withdrawn') && e.execution === '')
  const events = readLog(repo, effort, 'events')
  const state = readLog(repo, effort, 'state:' + stamp)
  const journal = readLog(repo, effort, 'journal:' + stamp)
  return {
    entries: [...events.entries.filter(ours), ...state.entries, ...journal.entries].sort((a, b) => seqOf(a) - seqOf(b)),
    malformed: events.malformed + state.malformed + journal.malformed,
  }
}

/**
 * One execution's log port, the run log's shape. `append(kind, fields) → {seq}` routes a node event
 * to `events` with `execution` set to the stamp, a journal kind to `journal:<stamp>` and every
 * other kind to `state:<stamp>`; it throws on a field named kind, on an event without a node and
 * when the ledger refuses the write (L1). `entries()` is this execution's events, every `message`
 * and `withdrawn` of no execution (`''`), its state and its journal, merged by seq.
 *
 * Read once when made, then each append mirrored: one port per execution in a process. A second
 * port on the same execution sees this one's appends only when it is made again.
 */
export function executionLog(repo, effort, stamp) {
  if (!STAMP.test(String(stamp || ''))) throw new Error('not an execution stamp: ' + JSON.stringify(stamp))
  const mirror = executionEntries(repo, effort, stamp).entries
  return {
    append(kind, fields = {}) {
      if (Object.hasOwn(fields, 'kind')) throw new Error('a ' + kind + ' record has a field named kind; its class is its cause')
      const event = EVENT_KINDS.includes(kind)
      if (event && typeof fields.node !== 'string') throw new Error('a ' + kind + ' event names no node')
      const name = event ? 'events' : JOURNAL_KINDS.includes(kind) ? 'journal:' + stamp : 'state:' + stamp
      const entry = event ? { kind, ...fields, execution: stamp } : { kind, ...fields }
      const out = append(repo, effort, name, entry)
      if (!out.ok) throw new Error('the execution log refused a ' + kind + ' record: ' + out.error)
      const seq = out.seqs[0]
      mirror.push(JSON.parse(JSON.stringify({ ...entry, seq })))
      return { seq }
    },
    entries: () => mirror.slice(),
  }
}

// ------------------------------------------------------------------ program runs

/**
 * A program run outside an execution keeps its own log, `runs/<run>/state.jsonl`, with its own seq
 * under `runs/<run>/.lock`: a `dispatched` line in an effort's events would change its tree's status.
 */
function runFileFor(repo, run) {
  if (!isRunId(run)) return { error: 'not a run id: ' + JSON.stringify(run) }
  if (runHome(repo, run).stamp) return { error: run + " is an execution's run: its records go through executionLog" }
  const path = runLogPath(repo, run)
  return { path, dir: dirname(path) }
}

/** Append to one run's log, minting the run's own seq under runs/<run>/.lock. All or nothing. */
export function appendRun(repo, run, entries) {
  const where = runFileFor(repo, run)
  if (where.error) return { ok: false, error: where.error }
  const refusal = batchRefusal(entries, '')
  if (refusal) return { ok: false, error: refusal }
  const batch = Array.isArray(entries) ? entries : [entries]
  try {
    return withLock(join(where.dir, '.lock'), () =>
      mintAndAppend(join(where.dir, 'seq'), where.path, batch, () => fileSeqMax(where.path), { reconcile: true }))
  } catch (err) {
    return { ok: false, error: 'the append failed: ' + err.message }
  }
}

/** A run's records: an execution home's through its execution, any other run's from its own log. */
export function readRunLog(repo, run) {
  const home = runHome(repo, run)
  if (home.stamp) return executionEntries(repo, home.effort, home.stamp)
  const where = runFileFor(repo, run)
  if (where.error) return { entries: [], malformed: 0, error: where.error }
  if (!existsSync(where.path)) return { entries: [], malformed: 0 }
  return parseLog(readFileSync(where.path, 'utf8'))
}

/**
 * The run log as runAgent's and a program's log port. append throws when the write fails (L1).
 * One process drives a run, so the log is read once and each append is mirrored as it reads back
 * from disk.
 */
export function runLog(repo, run) {
  const mirror = readRunLog(repo, run).entries
  return {
    append(kind, fields = {}) {
      if (Object.hasOwn(fields, 'kind')) throw new Error('a ' + kind + ' record has a field named kind; its class is its cause')
      const out = appendRun(repo, run, { kind, ...fields })
      if (!out.ok) throw new Error('the run log refused a ' + kind + ' record: ' + out.error)
      const seq = out.seqs[0]
      mirror.push(JSON.parse(JSON.stringify({ kind, ...fields, seq })))
      return { seq }
    },
    entries: () => mirror.slice(),
  }
}

/** A run's log port: an execution home's `executionLog`, any other run's `runLog`. */
export function logOf(repo, run) {
  const home = runHome(repo, run)
  return home.stamp ? executionLog(repo, home.effort, home.stamp) : runLog(repo, run)
}

/**
 * Where a run stands: ended (an `ended` record after its latest `run`), live, or stopped. A run is
 * live while its pid is alive and its heartbeat fresh (`beating`, which a worker thread writes, so
 * synchronous work on the main thread never stales it; `turning` while the main thread's loop has
 * turned within the same window too), or while its pid, its heartbeat
 * stale, is still a run's process (`runs`): a blocked event loop stops the heartbeat, not the run.
 * A home that starts again begins with a new `run`, so an `ended` before it belongs to an earlier run.
 */
export function runState(repo, run, { now = Date.now(), alive = pidAlive, runs = runProcess, staleMs = 120000 } = {}) {
  const meta = isRunId(run) ? readJson(runJsonPath(repo, run)) : null
  if (!meta || typeof meta !== 'object') return { state: 'absent', run: null, ended: null }
  const { entries } = readRunLog(repo, run)
  const ended = entries.slice(entries.findLastIndex((e) => e.kind === 'run') + 1).findLast((e) => e.kind === 'ended') || null
  if (ended) return { state: 'ended', run: meta, ended }
  const pid = Number.isInteger(meta.pid) && meta.pid > 0 && alive(meta.pid) ? meta.pid : 0
  const beating = pid > 0 && now - Date.parse(meta.heartbeat_at) <= staleMs
  const live = beating || (pid > 0 && runs(pid))
  // A beat older than `loop_at` tracking: a run from before the worker heartbeat turns as it beats.
  const turning = beating && (!meta.loop_at || now - Date.parse(meta.loop_at) <= staleMs)
  return { state: live ? 'live' : 'stopped', run: meta, ended: null, beating, turning }
}
