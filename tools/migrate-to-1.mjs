// tools/migrate-to-1.mjs — the one-shot rewrite of a store that predates the store stamp into
// version 1, run once after upgrading, on the user's go.
//
// Design: docs/DESIGN.md#migrations (a format change ships a one-shot migration, never a permanent
// second reader).
//
// A frozen copy: what it reads and writes is spelled here as version 1 has it, and it imports from
// lib/ only `mainCheckout`, which finds the store. For each effort under `.agentics/`, its
// `events.jsonl` loses every `withdrawn` event, every message one names and every message of a kind
// version 1 has no template for (`RENDERED`): version 1 reads a thread's messages as they stand. Each
// stored return under an execution's or a run's `returns/` whose `unread` holds a line of text has it
// typed: a blank line is dropped, a line that is one path becomes `{kind: 'doc', path}`, any other
// `{kind: 'doc', what}`. Then the store is stamped `{version: 1}`. Every other line and file is kept
// byte for byte. The default is a dry run; `--yes` writes. A store already stamped is left alone, so
// a second run writes nothing; exit 1 for a store stamped past 1 or a file it could not rewrite.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { mainCheckout } from '../lib/store.mjs'

const VERSION = 1
// The message kinds version 1 renders.
const RENDERED = new Set(['brief_changed', 'consolidate', 'cut_off', 'declined', 'failures', 'findings', 'needs_context',
  'needs_tests', 'notes', 'problems', 'rebase', 'refusals', 'retried', 'surviving_mutations', 'tests_ready'])

const dirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}
const parsed = (line) => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/** Write `text` to `path` through a temporary file renamed over it. */
function replace(path, text) {
  const staged = path + '.' + process.pid + '.tmp'
  writeFileSync(staged, text, 'utf8')
  renameSync(staged, path)
}

/** Pure. An events log's text with its withdrawn events and the messages version 1 drops left out, and what went. */
export function eventsRewrite(text) {
  const lines = text.split('\n')
  const rows = lines.map(parsed)
  const named = new Set(rows.filter((r) => r && r.kind === 'withdrawn').flatMap((r) => (Array.isArray(r.messages) ? r.messages : [])))
  const dropped = { withdrawn: 0, messages: [] }
  const kept = lines.filter((line, i) => {
    const r = rows[i]
    if (!r) return true
    if (r.kind === 'withdrawn') return (dropped.withdrawn++, false)
    if (r.kind === 'message' && (named.has(r.seq) || !RENDERED.has(r.msg))) return (dropped.messages.push({ seq: r.seq, msg: r.msg }), false)
    return true
  })
  return { text: kept.join('\n'), dropped }
}

/** Pure. A stored return with each line of text in its `unread` typed; null when it holds none. */
export function returnRewrite(ret) {
  if (!ret || typeof ret !== 'object' || !Array.isArray(ret.unread) || !ret.unread.some((u) => typeof u === 'string')) return null
  const unread = ret.unread.flatMap((u) => {
    if (typeof u !== 'string') return [u]
    const line = u.trim()
    if (line === '') return []
    return [/\s/.test(line) ? { kind: 'doc', path: '', what: line } : { kind: 'doc', path: line, what: '' }]
  })
  return { ...ret, unread }
}

/** Every stored return of the store: each execution's and each run's `returns/*.json`. */
function returnFiles(store, efforts) {
  const homes = [
    ...efforts.flatMap((e) => dirs(join(store, e, '.state', 'executions')).map((x) => join(store, e, '.state', 'executions', x))),
    ...dirs(join(store, '.state', 'runs')).map((r) => join(store, '.state', 'runs', r)),
  ]
  return homes.flatMap((home) => {
    try {
      return readdirSync(join(home, 'returns')).filter((n) => n.endsWith('.json')).map((n) => join(home, 'returns', n))
    } catch {
      return []
    }
  })
}

/**
 * What the migration would do to the store of `repo`: `{stamped, events[{effort, withdrawn,
 * messages}], returns[path], refused[{path, why}]}`; with `write`, it does it.
 */
export function migrate(repo, { write = false } = {}) {
  const store = join(mainCheckout(resolve(repo)), '.agentics')
  const stampFile = join(store, '.state', 'store.json')
  const stamp = existsSync(stampFile) ? parsed(readFileSync(stampFile, 'utf8')) : null
  const at = stamp && Number.isInteger(stamp.version) ? stamp.version : 0
  const out = { from: at, events: [], returns: [], refused: [] }
  if (at > VERSION) return { ...out, refused: [{ path: stampFile, why: 'the store is at version ' + at + ', past ' + VERSION }] }
  if (at === VERSION || !existsSync(store)) return out
  const efforts = dirs(store).filter((e) => !e.startsWith('.') && existsSync(join(store, e, '.state')))
  for (const effort of efforts) {
    const path = join(store, effort, '.state', 'events.jsonl')
    if (!existsSync(path)) continue
    const r = eventsRewrite(readFileSync(path, 'utf8'))
    if (r.dropped.withdrawn === 0 && r.dropped.messages.length === 0) continue
    out.events.push({ effort, withdrawn: r.dropped.withdrawn, messages: r.dropped.messages })
    if (write) replace(path, r.text)
  }
  for (const path of returnFiles(store, efforts)) {
    const ret = parsed(readFileSync(path, 'utf8'))
    const typed = returnRewrite(ret)
    if (!typed) continue
    out.returns.push(path)
    if (write) replace(path, JSON.stringify(typed))
  }
  if (write) {
    mkdirSync(join(store, '.state'), { recursive: true })
    replace(stampFile, JSON.stringify({ version: VERSION }) + '\n')
  }
  return out
}

const isMain = import.meta.main ?? (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--repo')
  const repo = at >= 0 && argv[at + 1] ? argv[at + 1] : '.'
  const write = argv.includes('--yes')
  let out
  try {
    out = migrate(repo, { write })
  } catch (err) {
    out = { refused: [{ path: '', why: err.message }] }
  }
  console.log(JSON.stringify({ ok: out.refused.length === 0, written: write && out.refused.length === 0, ...out }, null, 1))
  process.exit(out.refused.length ? 1 : 0)
}
