// tools/migrate-to-2.mjs — the one-shot rewrite of a version 1 store into version 2, run once after
// upgrading, on the user's go.
//
// Design: docs/DESIGN.md#migrations (a format change ships a one-shot migration, never a permanent
// second reader).
//
// A frozen copy: what it reads and writes is spelled here as version 2 has it, and it imports from
// lib/ only `mainCheckout`, which finds the store, and `withLock`, which takes an effort's lock.
// Version 2 keys a regression net by its file's blob. For each effort under `.agentics/`, each
// `nets` event in its `events.jsonl` has every net given `blob`, the file's blob at the event's
// `head_sha`, and loses `all`; each `verify-observed` line of each execution's `journal.jsonl` has
// every `discriminator` entry given what it lacks of `blob`, its `test_id`'s blob at the line's
// `head_sha`, and `base_blob`, the same at its `base_sha`. A blob git cannot find (a commit gone, or
// a file the base lacks) is '', which no net or measured head matches: that net stands nowhere. Every
// other line is kept byte for byte, each log rewritten under its effort's lock. Then the store is
// stamped `{version: 2}`. The default is a dry run; `--yes` writes. A store at 2 is left alone, so a
// second run writes nothing; exit 1 for a store at any version but 1 or 2, or a file it could not
// rewrite.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { mainCheckout, withLock } from '../lib/store.mjs'

const VERSION = 2

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

/** The blob each `<sha>:<path>` names in the repository at `cwd`, '' for one git does not hold, in one `git cat-file --batch-check`. */
function blobsOf(cwd, specs) {
  const out = new Map()
  const asked = [...new Set(specs)]
  if (asked.length === 0) return out
  const r = spawnSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { cwd, input: asked.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 26 })
  if (r.status !== 0) throw new Error('git cat-file in ' + cwd + ' failed: ' + (r.stderr || r.error || 'exit ' + r.status))
  const answers = r.stdout.split('\n')
  asked.forEach((spec, i) => {
    const [sha, type] = String(answers[i] || '').split(' ')
    out.set(spec, type === 'blob' ? sha : '')
  })
  return out
}

/** Pure. The `<sha>:<path>` specs a log's text asks: each net of a `nets` event, each entry of a `verify-observed` line. */
export function specsOf(text) {
  const specs = []
  for (const r of text.split('\n').map(parsed)) {
    if (!r || typeof r.head_sha !== 'string' || !r.head_sha) continue
    if (r.kind === 'nets') for (const n of Array.isArray(r.nets) ? r.nets : []) if (n && typeof n.file === 'string') specs.push(r.head_sha + ':' + n.file)
    if (r.kind === 'verify-observed') {
      for (const d of Array.isArray(r.discriminator) ? r.discriminator : []) {
        if (!d || typeof d.test_id !== 'string') continue
        specs.push(r.head_sha + ':' + d.test_id)
        if (typeof r.base_sha === 'string' && r.base_sha) specs.push(r.base_sha + ':' + d.test_id)
      }
    }
  }
  return specs
}

/** Pure. A log's text with its nets and discriminator entries keyed by blob (`blobs`, by spec), and how many lines changed. */
export function logRewrite(text, blobs) {
  let changed = 0
  const blob = (head, path) => blobs.get(head + ':' + path) || ''
  const lines = text.split('\n').map((line) => {
    const r = parsed(line)
    if (!r || (r.kind !== 'nets' && r.kind !== 'verify-observed')) return line
    if (r.kind === 'nets') {
      const { all, ...rest } = r
      const nets = (Array.isArray(r.nets) ? r.nets : []).map((n) => (n && typeof n.file === 'string' && !('blob' in n)
        ? { file: n.file, blob: blob(r.head_sha, n.file), why: n.why } : n))
      const next = JSON.stringify({ ...rest, nets })
      if (next === line) return line
      changed++
      return next
    }
    const entries = Array.isArray(r.discriminator) ? r.discriminator : []
    const unkeyed = (d) => d && typeof d.test_id === 'string' && (!('blob' in d) || !('base_blob' in d))
    if (!entries.some(unkeyed)) return line
    changed++
    return JSON.stringify({ ...r, discriminator: entries.map((d) => (unkeyed(d)
      ? { test_id: d.test_id, blob: blob(r.head_sha, d.test_id), base_blob: blob(r.base_sha, d.test_id), ...d } : d)) })
  })
  return { text: lines.join('\n'), changed }
}

/**
 * What the migration would do to the store of `repo`: `{from, logs[{path, lines}], refused[{path,
 * why}]}`; with `write`, it does it.
 */
export function migrate(repo, { write = false } = {}) {
  const checkout = mainCheckout(resolve(repo))
  const store = join(checkout, '.agentics')
  const stampFile = join(store, '.state', 'store.json')
  const stamp = existsSync(stampFile) ? parsed(readFileSync(stampFile, 'utf8')) : null
  const at = stamp && Number.isInteger(stamp.version) ? stamp.version : 0
  const out = { from: at, logs: [], refused: [] }
  if (at === VERSION || !existsSync(store)) return out
  if (at !== VERSION - 1) {
    return { ...out, refused: [{ path: stampFile, why: 'the store is at version ' + at + ': this brings a store at ' + (VERSION - 1) + ' to ' + VERSION }] }
  }
  const efforts = dirs(store).filter((e) => !e.startsWith('.') && existsSync(join(store, e, '.state')))
  for (const effort of efforts) {
    const state = join(store, effort, '.state')
    const logs = [join(state, 'events.jsonl'), ...dirs(join(state, 'executions')).map((x) => join(state, 'executions', x, 'journal.jsonl'))]
    const rewrite = () => {
      for (const path of logs.filter(existsSync)) {
        const text = readFileSync(path, 'utf8')
        const r = logRewrite(text, blobsOf(checkout, specsOf(text)))
        if (r.changed === 0) continue
        out.logs.push({ path, lines: r.changed })
        if (write) replace(path, r.text)
      }
    }
    if (write) withLock(join(state, '.lock'), rewrite)
    else rewrite()
  }
  if (write) replace(stampFile, JSON.stringify({ version: VERSION }) + '\n')
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
