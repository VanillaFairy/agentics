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
// arrives on an entry is ignored and overwritten.
//
// Why the check is thin. This is a transport check, not a schema: every entry must be an object
// with a `kind`. A writer that validated every record kind's full shape would refuse a line
// written by a newer workflow against an older installed lib — a forward-compatible append turned
// into a lost record, which is the exact damage this file exists to prevent. Shapes are checked
// by their owners (`lib/tree.mjs` for nodes) before they reach here.

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { canonical, fnv1a } from './plan-digest.mjs'
import { STAMP, effortDir, flagOf, posix, safeSlug, withLock, mkdirState } from './store.mjs'

/** The effort-level logs, and the per-execution ones. */
const EFFORT_FILES = { nodes: 'nodes.jsonl', events: 'events.jsonl' }
const EXECUTION_FILES = { state: 'state.jsonl', journal: 'journal.jsonl' }

/** The node events. Readers ignore a kind they do not know; writers use only these. */
export const EVENT_KINDS = ['planned', 'replanned', 'dispatched', 'approved', 'merged',
  'escalated', 'parked', 'landed']

/** Pure. The digest a batch of entries travels under — the same canonical form everywhere. */
export const digestEntries = (entries) => fnv1a(canonical(entries))

/**
 * Pure. The file a ledger name refers to, or an error. `nodes`, `events`, `state:<stamp>`,
 * `journal:<stamp>`.
 */
export function fileFor(repo, effort, name) {
  const slug = safeSlug(effort)
  if (!slug) return { error: 'not an effort name: ' + JSON.stringify(effort) }
  const dir = effortDir(repo, slug)
  if (Object.hasOwn(EFFORT_FILES, name)) return { path: join(dir, EFFORT_FILES[name]), dir }

  const [kind, stamp] = String(name || '').split(':')
  if (Object.hasOwn(EXECUTION_FILES, kind) && STAMP.test(stamp || '')) {
    return { path: join(dir, 'executions', stamp, EXECUTION_FILES[kind]), dir }
  }
  return { error: 'unknown ledger file ' + JSON.stringify(name) + ' — expected nodes, events, state:<stamp> or journal:<stamp>' }
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
function maxSeqOnDisk(dir) {
  let max = 0
  const scan = (path) => {
    if (!existsSync(path)) return
    for (const e of parseLog(readFileSync(path, 'utf8')).entries) {
      if (Number.isInteger(e.seq) && e.seq > max) max = e.seq
    }
  }
  for (const file of Object.values(EFFORT_FILES)) scan(join(dir, file))
  const executions = join(dir, 'executions')
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
 * @param {string} name   nodes | events | state:<stamp> | journal:<stamp>
 * @param {object|object[]} entries
 * @param {{digest?: string}} [opts] the digest the caller minted over `entries` as sent
 * @returns {{ok: true, seqs: number[], path: string} | {ok: false, error: string}}
 */
export function append(repo, effort, name, entries, { digest = '' } = {}) {
  const where = fileFor(repo, effort, name)
  if (where.error) return { ok: false, error: where.error }

  if (digest) {
    const actual = digestEntries(entries)
    if (actual !== digest) {
      return {
        ok: false,
        error: 'digest mismatch: the caller minted ' + digest + ', these entries digest to ' + actual +
          ' — something changed between there and here, so nothing was written. Copy them again, exactly.',
      }
    }
  }

  const batch = Array.isArray(entries) ? entries : [entries]
  if (batch.length === 0) return { ok: false, error: 'nothing to append' }
  for (const [i, entry] of batch.entries()) {
    const problem = entryProblem(entry)
    if (problem) return { ok: false, error: 'entry ' + i + ': ' + problem + ' — nothing was written' }
  }

  try {
    return withLock(join(where.dir, '.lock'), () => {
      mkdirState(join(where.path, '..'))
      const counter = join(where.dir, 'seq')
      let last = Number.parseInt(existsSync(counter) ? readFileSync(counter, 'utf8') : '', 10)
      if (!Number.isInteger(last)) last = maxSeqOnDisk(where.dir)

      const seqs = batch.map((_, i) => last + 1 + i)
      const text = batch.map((entry, i) => JSON.stringify({ ...entry, seq: seqs[i] }) + '\n').join('')
      appendFileSync(where.path, text, 'utf8')
      // The counter moves after the lines land: a crash between the two leaves the counter
      // behind the log, and the next append's rebuild-free read would then reuse a number. So a
      // stale counter is repaired on the next append by taking the max of both.
      writeFileSync(counter, String(seqs[seqs.length - 1]), 'utf8')
      return { ok: true, seqs, path: posix(where.path) }
    })
  } catch (err) {
    return { ok: false, error: 'the append failed: ' + err.message }
  }
}

/** The highest seq the effort has minted, 0 when none. */
export function seqMax(repo, effort) {
  const slug = safeSlug(effort)
  if (!slug) return 0
  const dir = effortDir(repo, slug)
  const counter = join(dir, 'seq')
  const fromCounter = Number.parseInt(existsSync(counter) ? readFileSync(counter, 'utf8') : '', 10)
  return Math.max(Number.isInteger(fromCounter) ? fromCounter : 0, maxSeqOnDisk(dir))
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
