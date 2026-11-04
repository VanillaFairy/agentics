// tools/migrate-carried-claims.mjs — the one-shot correction of the claim rulings a folder's narrowed
// integration reviews recorded as `cant_tell` over a pass whose unit the reviewer ruled `clean`, run
// once after upgrading, on the user's go.
//
// Design: docs/DESIGN.md#migrations.
//
// For each composite of each effort under `.agentics/`, this replays its `claims` events with
// `review: done` in seq order under the rule `folderReview` records by now: a prior claim the
// review's stored return did not restate is carried as the replayed prior holds it, and a pass whose
// head moved under it reads `cant_tell` only when the return left its `claim:<n>` unruled or ruled it
// `findings`. A review's own claims are kept as recorded; an accept keeps the claims it accepted
// and takes every other from the replayed review it accepted over. Each event the replay changes is
// rewritten in place, its seq and every other field kept, under its effort's lock; every other line
// is kept byte for byte. A folder whose stored return is missing, whose recorded claims do not
// split into carried and own as the return says, or whose review before kept no anchors is listed
// in `left` and not touched. The default is a dry run; `--yes` writes. A second run changes nothing.
//
// A frozen copy: the passes, the restatement rule and a return's path are spelled here as they were
// when these events were recorded, and it imports from lib/ only `mainCheckout` and `withLock`.

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { mainCheckout, withLock } from '../lib/store.mjs'

const PASSING = ['met', 'equivalent', 'accepted']
const list = (v) => (Array.isArray(v) ? v : [])

const dirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}
const parsed = (line) => {
  try {
    const v = JSON.parse(line)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** Pure. A prior as the next review read it: whole when it kept anchors, else only its claims other than a pass or `accepted`. */
const asPrior = (e) => (e.anchors && typeof e.anchors === 'object' ? e : null)

/**
 * Pure. The claims one recorded review `e` holds under the current rule, over `stored`, the event
 * before it as recorded, and `fixed`, that event replayed; `ret` is the review's stored return.
 * Null with a `why` where the replay cannot tell.
 */
export function replayed(e, stored, fixed, ret) {
  if (e.by === 'session') {
    if (!fixed) return { claims: list(e.claims) }
    return { claims: list(e.claims).map((c, i) => (c.ruling === 'accepted' || !fixed.claims[i] ? c : fixed.claims[i])) }
  }
  if (!ret || !Array.isArray(ret.claims)) return { why: 'the review\'s stored return is missing' }
  const n = ret.claims.length
  const own = list(e.claims).slice(list(e.claims).length - n)
  if (!stored) return { claims: list(e.claims) }
  if (!asPrior(stored)) return { why: 'the review before kept no anchors' }
  const answered = new Set(ret.claims.map((c) => c.unit).filter(Boolean))
  const restated = new Set(ret.claims.map((c) => c.claim))
  const clean = new Set(list(ret.units).filter((u) => u && u.ruling === 'clean').map((u) => u.unit))
  const kept = list(stored.claims).map((c, i) => i).filter((i) => !restated.has(stored.claims[i].claim) && !answered.has('claim:' + (i + 1)))
  if (kept.length + n !== list(e.claims).length) return { why: 'its recorded claims do not split into carried and own as its return says' }
  const again = e.head_sha !== stored.head_sha
  const carried = kept.map((i) => {
    const c = fixed.claims[i]
    return again && PASSING.includes(c.ruling) && !clean.has('claim:' + (i + 1)) ? { claim: c.claim, ruling: 'cant_tell' } : c
  })
  return { claims: [...carried, ...own] }
}

/** Write `text` to `path` through a temporary file renamed over it. */
function replace(path, text) {
  const staged = path + '.' + process.pid + '.tmp'
  writeFileSync(staged, text, 'utf8')
  renameSync(staged, path)
}

/**
 * Pure over the files it reads. The events text of one effort's state dir with its `claims` events
 * replayed: `{text, changed[{node, seq, before, after}], left[{node, why}]}`, `before` and `after`
 * each ruling's count.
 */
export function effortRewrite(state, text) {
  const lines = text.split('\n')
  const events = lines.map((line, at) => ({ at, e: parsed(line) })).filter((x) => x.e && x.e.kind === 'claims' && x.e.review === 'done' && typeof x.e.node === 'string')
  const nodes = [...new Set(events.map((x) => x.e.node))]
  const counts = (claims) => list(claims).reduce((o, c) => ({ ...o, [c.ruling]: (o[c.ruling] || 0) + 1 }), {})
  const changed = []
  const left = []
  const rewrites = new Map()
  for (const node of nodes) {
    const mine = events.filter((x) => x.e.node === node).sort((a, b) => a.e.seq - b.e.seq)
    let stored = null
    let fixed = null
    const out = []
    let why = ''
    for (const { at, e } of mine) {
      const file = e.said ? join(state, 'executions', String(e.execution || ''), 'returns', e.said + '.json') : ''
      const ret = file && existsSync(file) ? parsed(readFileSync(file, 'utf8')) : null
      const r = !e.said && e.by !== 'session' ? { claims: list(e.claims) } : replayed(e, stored, fixed, ret)
      if (!r.claims) {
        why = r.why
        break
      }
      const next = { ...e, claims: r.claims }
      if (JSON.stringify(next.claims) !== JSON.stringify(e.claims)) out.push({ at, next, before: counts(e.claims), after: counts(r.claims) })
      stored = e
      fixed = next
    }
    if (why) {
      left.push({ node, why })
      continue
    }
    for (const o of out) {
      rewrites.set(o.at, JSON.stringify(o.next) + (lines[o.at].endsWith('\r') ? '\r' : ''))
      changed.push({ node, seq: o.next.seq, before: o.before, after: o.after })
    }
  }
  return { text: lines.map((line, at) => (rewrites.has(at) ? rewrites.get(at) : line)).join('\n'), changed, left }
}

/** What the migration would do to the store of `repo`: `{efforts[{effort, changed, left}]}`; with `write`, it does it. */
export function migrate(repo, { write = false } = {}) {
  const store = join(mainCheckout(resolve(repo)), '.agentics')
  const out = { efforts: [] }
  for (const effort of dirs(store).filter((e) => !e.startsWith('.') && existsSync(join(store, e, '.state', 'events.jsonl')))) {
    const state = join(store, effort, '.state')
    const path = join(state, 'events.jsonl')
    const run = () => {
      const r = effortRewrite(state, readFileSync(path, 'utf8'))
      if (r.changed.length || r.left.length) out.efforts.push({ effort, changed: r.changed, left: r.left })
      if (write && r.changed.length) replace(path, r.text)
    }
    if (write) withLock(join(state, '.lock'), run)
    else run()
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
    out = { ok: true, written: write, ...migrate(repo, { write }) }
  } catch (err) {
    out = { ok: false, error: err.message }
  }
  console.log(JSON.stringify(out, null, 1))
  process.exit(out.ok ? 0 : 1)
}
