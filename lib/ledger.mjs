// lib/ledger.mjs — the only writer of an effort's durable records, and the one place `seq` is
// minted.
//
// Design: docs/DESIGN.md#the-ledger.
//
// Why a CLI at all. A workflow script has no filesystem, so every byte that crosses between disk
// and the script has to ride an agent — and an agent's OUTPUT is where corruption lives. A
// recorder handed an exact JSON line once un-escaped the Windows paths in it while typing the
// Bash command, and five of one run's ten state lines landed as invalid JSON. The fix is not a
// better-instructed recorder. It is to make the append refuse what it cannot prove intact: the
// caller mints the lines, digests them, and hands the agent both; this file recomputes the digest
// over what actually arrived and writes only on a match. Corruption becomes impossible at rest,
// at the cost of being loud in transit.
//
// Why the counter lives here. Records are ordered by `seq`, one monotonic integer per effort,
// across the node log, the event log and every execution's state and journal. It is a counter
// rather than a clock because an agent that can read a clock can invent one, and a fabricated
// timestamp orders two records confidently and wrongly. It used to be minted by the workflow and
// copied by each writer; now the writer mints it, under the effort's lock file, so no agent ever
// supplies one and concurrent executions of one effort cannot mint the same number. A `seq` that
// arrives on an entry is ignored and overwritten. The project `.state/` has its own counter and
// lock for the project-wide logs.
//
// Why the check is thin. This is a transport check, not a schema: every entry must be an object
// with a `kind`. A writer that validated every record kind's full shape would refuse a line
// written by a newer workflow against an older installed lib — a forward-compatible append turned
// into a lost record, which is the exact damage this file exists to prevent. Shapes are checked
// by their owners (`lib/tree.mjs` for nodes) before they reach here.

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { canonical, fnv1a } from './plan-digest.mjs'
import {
  STAMP, effortStateDir, evidenceItemsPath, executionsRoot, flagOf, posix, projectStateDir, safeSlug,
  withLock, mkdirState,
} from './store.mjs'

/** The effort-level logs, and the per-execution ones. */
const EFFORT_FILES = { nodes: 'nodes.jsonl', events: 'events.jsonl', ledger: 'ledger.jsonl', cites: 'cites.jsonl' }
const EXECUTION_FILES = { state: 'state.jsonl', journal: 'journal.jsonl' }

/** The node events. Readers ignore a kind they do not know; writers use only these. */
export const EVENT_KINDS = ['planned', 'replanned', 'dispatched', 'approved', 'merged',
  'escalated', 'parked', 'landed', 'claims']

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

/** The highest seq on disk across every log of the effort — the counter's rebuild. */
function maxSeqOnDisk(dir, executions) {
  let max = 0
  const scan = (path) => {
    if (!existsSync(path)) return
    for (const e of parseLog(readFileSync(path, 'utf8')).entries) {
      if (Number.isInteger(e.seq) && e.seq > max) max = e.seq
    }
  }
  for (const file of Object.values(EFFORT_FILES)) scan(join(dir, file))
  if (existsSync(executions)) {
    for (const stamp of readdirSync(executions)) {
      for (const file of Object.values(EXECUTION_FILES)) scan(join(executions, stamp, file))
    }
  }
  return max
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
  // parseable counter as-is; the project log has no such cost, so `appendProject` reconciles on
  // every call, taking the max of the counter and what's already on disk.
  if (!Number.isInteger(last)) last = rebuild()
  else if (reconcile) last = Math.max(last, rebuild())

  const seqs = batch.map((_, i) => last + 1 + i)
  appendFileSync(path, batch.map((entry, i) => JSON.stringify({ ...entry, seq: seqs[i] }) + '\n').join(''), 'utf8')
  writeFileSync(counter, String(seqs[seqs.length - 1]), 'utf8')
  return { ok: true, seqs, path: posix(path) }
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

function projectSeqOnDisk(repo) {
  let max = 0
  for (const pathOf of Object.values(PROJECT_FILES)) {
    const path = pathOf(repo)
    if (!existsSync(path)) continue
    for (const e of parseLog(readFileSync(path, 'utf8')).entries) {
      if (Number.isInteger(e.seq) && e.seq > max) max = e.seq
    }
  }
  return max
}

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

// ------------------------------------------------------------------ CLI

const readStdin = () => {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The entries' bytes: a base64 token (`--b64`), a file holding one (`--b64-file`, for a batch
 * too long for one command line — Windows caps a command line at 8191 characters), or raw JSON
 * on stdin (the heredoc an agent writes a journal line with: values only it knows, so there is
 * nothing to encode ahead of time).
 */
function entriesFrom(argv) {
  const file = flagOf(argv, 'b64-file')
  const token = file ? readFileSync(file, 'utf8').trim() : flagOf(argv, 'b64')
  const text = token ? Buffer.from(token, 'base64').toString('utf8') : readStdin()
  return JSON.parse(text)
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const argv = process.argv.slice(2)
    const [command] = argv
    if (command !== 'append') throw new Error('unknown command ' + JSON.stringify(command || '') + ' — expected append')

    let entries
    try {
      entries = entriesFrom(argv)
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: 'the entries are not JSON (' + err.message + ') — they did not survive transcription' }))
      process.exit(1)
    }
    const out = append(flagOf(argv, 'repo') || '.', flagOf(argv, 'effort'), flagOf(argv, 'file'),
      entries, { digest: flagOf(argv, 'digest') })
    console.log(JSON.stringify(out))
    process.exit(out.ok ? 0 : 1)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
