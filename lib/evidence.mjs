// lib/evidence.mjs — the project-wide evidence item store: what an item must carry for its kind,
// the one writer that records items from a raw return, and (T22) the anchor checks that derive
// whether an item still stands.
//
// Design: docs/DESIGN.md#evidence.
//
// Why items. A survey that stands or falls whole re-buys everything when one line of its ground
// moves. An item is one claim with the anchors it rests on, so an edit re-buys only the claims
// whose anchors it touched. Nothing unanchored enters the pool: `checkItem` refuses an item whose
// kind lacks its anchor, and `recordItems` writes a batch only when every item passes.
//
// Why the recorder fills some anchor fields. A judge reads lines. It can't know the commit it read
// them at, what a search returns on disk, or today's date. Those are observations, so the recorder
// makes them: a span's `at`, a query's `result`, a source's `retrieved`.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { appendProject, readProjectLog } from './ledger.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import { hashSpec } from './spec.mjs'
import {
  decodeArgs, envelope, evidenceReturnsDir, evidenceSnapshotsDir, flagOf, git, mainCheckout, mkdirState,
  posix, revParse, safePath, stampNow,
} from './store.mjs'

export const ITEM_KINDS = ['behaviour', 'absence', 'enumeration', 'relation', 'external', 'derived']

/** The anchors each kind must carry at least one of. `checkItem` refuses an item without them. */
export const REQUIRED = {
  behaviour: ['spans'], absence: ['queries'], enumeration: ['queries'],
  relation: ['spans', 'queries'], external: ['sources'], derived: ['rests_on'],
}

/** What a raw return can be the return of. An `approach` draft carries no items of its own. */
export const RETURN_KINDS = ['survey', 'probe', 'solutions', 'approach']

const ANCHORS = ['spans', 'queries', 'sources', 'rests_on']
const SHA = /^[0-9a-f]{40}$/
const SNAPSHOT = /^snapshot:([0-9a-f]{8})$/
const ITEM_ID = /^I[0-9a-f]{8}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const isText = (v) => typeof v === 'string' && v.trim() !== ''
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Pure. A repository-relative path normalised the way `ground` is: posix, trimmed, no leading
 * `./`, no trailing `/`, empty becomes `.`. Shared by `ground` and a query's `scope`. */
const relPath = (p) => posix(p).trim().replace(/^\.\//, '').replace(/\/+$/, '') || '.'

/** Pure. An item's identity: its question, topic and claim. Where it is anchored is not identity. */
export const itemId = (item) =>
  'I' + fnv1a(canonical({ question: item.question, topic: item.topic, claim: item.claim }))

/** Pure. What keeps one item out of the pool; [] when nothing does. */
export function checkItem(item) {
  if (!isPlainObject(item)) return ['an item must be an object']
  const out = []
  if (!ITEM_KINDS.includes(item.kind)) out.push('kind ' + JSON.stringify(item.kind) + ' is not one of ' + ITEM_KINDS.join(', '))
  for (const field of ['question', 'topic', 'claim']) if (!isText(item[field])) out.push('an item needs a non-empty ' + field)
  if (!Array.isArray(item.ground) || item.ground.some((g) => safePath(g) === null)) {
    out.push('ground must be a list of repository-relative paths')
  }
  for (const a of ANCHORS) if (!Array.isArray(item[a])) out.push(a + ' must be a list')
  if (item.detail !== undefined && !isPlainObject(item.detail)) out.push('detail, when present, must be an object')
  if (out.length > 0) return out

  for (const a of REQUIRED[item.kind] || []) {
    if (item[a].length === 0) out.push('a ' + item.kind + ' item needs at least one anchor in ' + a)
  }
  item.spans.forEach((s, i) => {
    const where = 'span ' + i + ': '
    if (!isPlainObject(s) || safePath(s.path) === null) out.push(where + 'the path must be repository-relative')
    else if (!Number.isInteger(s.start) || s.start < 1) out.push(where + 'start must be a line number from 1')
    else if (!Number.isInteger(s.end) || s.end < s.start) out.push(where + 'end must be a line number at or after start')
    else if (!SHA.test(s.at || '') && !SNAPSHOT.test(s.at || '')) out.push(where + 'at must be a commit sha or snapshot:<hash>')
  })
  item.queries.forEach((q, i) => {
    const where = 'query ' + i + ': '
    if (!isPlainObject(q) || !isText(q.pattern)) out.push(where + 'the pattern must be non-empty')
    else if (!Array.isArray(q.scope) || q.scope.some((p) => safePath(p) === null)) out.push(where + 'scope must be a list of repository-relative paths')
    else if (!Array.isArray(q.result) || q.result.some((r) => !isPlainObject(r) || typeof r.path !== 'string' || typeof r.text !== 'string')) {
      out.push(where + 'result must be a list of {path, text}')
    } else if (item.kind === 'absence' && q.result.length > 0) {
      out.push(where + 'an absence item\'s search must find nothing, and this one finds ' + q.result.length + ' line(s)')
    }
  })
  item.sources.forEach((s, i) => {
    const where = 'source ' + i + ': '
    if (!isPlainObject(s) || !isText(s.url)) out.push(where + 'the url must be non-empty')
    else if (typeof s.version !== 'string') out.push(where + 'version must be a string, empty when unversioned')
    else if (!DATE.test(s.retrieved || '')) out.push(where + 'retrieved must be an ISO date (YYYY-MM-DD)')
  })
  item.rests_on.forEach((id, i) => {
    if (!ITEM_ID.test(id)) out.push('rests_on ' + i + ': ' + JSON.stringify(id) + ' is not an item id')
  })
  return out
}

// ------------------------------------------------------------------ reading files and git

/** A file's text with line endings normalised, or null when it can't be read. */
function readText(root, path) {
  try {
    return readFileSync(join(root, ...path.split('/')), 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return null
  }
}

/** The text of `path` as of commit `sha`, CRLF normalised, or null when the blob isn't there. */
function readAt(root, sha, path) {
  const r = git(root, ['show', sha + ':' + path])
  return r.ok ? r.stdout.replace(/\r\n/g, '\n') : null
}

const lineCount = (text) => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length)
const snapshotFile = (repo, hash) => join(evidenceSnapshotsDir(repo), hash + '.txt')

/** Save a text the store can diff against later, named by its spec hash. Idempotent. */
export function snapshotSpec(repo, text) {
  const normal = String(text == null ? '' : text).replace(/\r\n/g, '\n')
  const hash = hashSpec(normal)
  mkdirState(evidenceSnapshotsDir(repo))
  const file = snapshotFile(repo, hash)
  if (!existsSync(file)) writeFileSync(file, normal, 'utf8')
  return 'snapshot:' + hash
}

/**
 * Where a span read from the working tree is anchored: HEAD when the file is tracked and unchanged
 * against it, otherwise a snapshot of the text it was read from. Anchoring an edited file at HEAD
 * would make the item suspect the moment it was recorded.
 */
function anchorFor(repo, root, path, text) {
  const tracked = git(root, ['ls-files', '--error-unmatch', '--', path]).ok
  if (tracked && git(root, ['diff', '--quiet', 'HEAD', '--', path]).ok) {
    const head = revParse(root, 'HEAD')
    if (head) return head
  }
  return snapshotSpec(repo, text)
}

/** Run one query as the store re-runs it. Line numbers are dropped: an item is about what, not where. */
function runQuery(root, pattern, scope) {
  const r = git(root, ['grep', '-n', '-z', '-E', '--text', '--untracked', '-e', pattern, '--', ...(scope.length ? scope : ['.'])])
  if (r.status === 1) return { result: [] }
  if (!r.ok) return { error: (r.stderr.trim() || 'git grep failed').split('\n')[0] }
  const seen = new Map()
  for (const line of r.stdout.split('\n')) {
    if (!line) continue
    const [path, , ...rest] = line.split('\0')
    const hit = { path: posix(path), text: rest.join('\0').replace(/\r$/, '') }
    seen.set(hit.path + '\0' + hit.text, hit)
  }
  return { result: [...seen.values()].sort((a, b) => (a.path + '\0' + a.text < b.path + '\0' + b.text ? -1 : 1)) }
}

// ------------------------------------------------------------------ recording

/** One raw item made ready for the pool: shape defaults, observations filled, identity minted. */
function prepare(repo, root, raw, returnName, today) {
  const src = isPlainObject(raw) ? raw : {}
  const list = (v) => (Array.isArray(v) ? v : [])
  const problems = []

  const spans = list(src.spans).map((s, i) => {
    const path = isPlainObject(s) ? safePath(s.path) : null
    const span = { path: path || String(isPlainObject(s) ? s.path : ''), start: s && s.start, end: s && s.end, at: isPlainObject(s) && isText(s.at) ? s.at : '' }
    if (path === null) return span
    const snap = SNAPSHOT.exec(span.at)
    const sha = SHA.test(span.at) ? span.at : null
    let text
    if (snap) {
      text = existsSync(snapshotFile(repo, snap[1])) ? readFileSync(snapshotFile(repo, snap[1]), 'utf8') : null
      if (text === null) {
        problems.push('span ' + i + ': ' + span.at + ' is not a snapshot this store holds')
        return span
      }
    } else if (sha) {
      if (revParse(root, sha) !== sha) {
        problems.push('span ' + i + ': ' + sha + ' is not a commit this repository has')
        return span
      }
      text = readAt(root, sha, path)
      if (text === null) {
        problems.push('span ' + i + ': ' + path + ' does not exist at ' + sha)
        return span
      }
    } else {
      text = readText(root, path)
      if (text === null) {
        problems.push('span ' + i + ': ' + path + ' does not exist in the working tree')
        return span
      }
    }
    if (Number.isInteger(span.end) && span.end > lineCount(text)) {
      problems.push('span ' + i + ': ' + path + ' has ' + lineCount(text) + ' line(s), so it has no line ' + span.end)
    }
    if (span.at === '') span.at = anchorFor(repo, root, path, text)
    return span
  })

  const queries = list(src.queries).map((q, i) => {
    const pattern = isPlainObject(q) ? q.pattern : ''
    const scope = isPlainObject(q) ? list(q.scope).map((p) => relPath(p)) : []
    if (!isText(pattern)) return { pattern, scope, result: [] }
    const ran = runQuery(root, pattern, scope)
    if (ran.error) problems.push('query ' + i + ': git could not run ' + JSON.stringify(pattern) + ' (' + ran.error + ')')
    return { pattern, scope, result: ran.result || [] }
  })

  const sources = list(src.sources).map((s) => ({
    url: isPlainObject(s) ? s.url : '',
    version: isPlainObject(s) && typeof s.version === 'string' ? s.version : '',
    retrieved: isPlainObject(s) && isText(s.retrieved) ? s.retrieved : today,
  }))

  const item = {
    question: src.question, topic: src.topic, kind: src.kind, claim: src.claim,
    ground: list(src.ground).map((g) => relPath(g)),
    spans, queries, sources, rests_on: list(src.rests_on),
    ...(src.detail !== undefined ? { detail: src.detail } : {}),
    from_return: returnName,
  }
  item.id = itemId(item)
  return { item, problems }
}

/**
 * Record a batch of items, all or nothing. Each is prepared (observations filled), then checked;
 * one refused item refuses the batch and nothing is written, because a judge's return with a
 * refused item goes back to that judge rather than into the pool.
 */
export function recordItems(repo, returnName, items, { now = new Date() } = {}) {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'there are no items to record' }
  const root = mainCheckout(repo)
  const today = now.toISOString().slice(0, 10)
  const refused = []
  const ready = items.map((raw, index) => {
    const { item, problems } = prepare(repo, root, raw, returnName, today)
    const all = problems.concat(checkItem(item))
    if (all.length > 0) refused.push({ index, problems: all })
    return item
  })
  if (refused.length > 0) return { ok: false, refused }
  const out = appendProject(repo, 'items', ready.map((item) => ({ kind: 'item', item })))
  return out.ok ? { ok: true, ids: ready.map((i) => i.id), seqs: out.seqs } : { ok: false, error: out.error }
}

/**
 * Keep a raw return and record the items in it. The return's name is `<stamp>[-<n>]-<kind>`, reserved
 * by an exclusive create so two recorders in one second can't share it. A refused return is deleted
 * again, so what stays in `returns/` is exactly what entered the pool. An approach draft names
 * items already in the store in its `cites` and brings none of its own, so it is kept with none.
 */
export function recordRaw(repo, kind, payload, { now = new Date() } = {}) {
  if (!RETURN_KINDS.includes(kind)) {
    return { ok: false, error: { kind: 'bad_kind', message: 'the kind must be one of ' + RETURN_KINDS.join(', ') + ', not ' + JSON.stringify(kind) } }
  }
  const items = kind === 'approach' && isPlainObject(payload) && payload.items === undefined ? [] : (payload || {}).items
  if (!isPlainObject(payload) || !Array.isArray(items) || (items.length === 0 && kind !== 'approach')) {
    return { ok: false, error: { kind: 'bad_payload', message: 'a raw return must be an object carrying a non-empty items list (an approach draft may carry none)' } }
  }
  const dir = evidenceReturnsDir(repo)
  mkdirState(dir)
  const base = stampNow(now)
  let name = base + '-' + kind
  for (let n = 2; ; n++) {
    try {
      writeFileSync(join(dir, name + '.json'), JSON.stringify(payload) + '\n', { encoding: 'utf8', flag: 'wx' })
      break
    } catch (err) {
      if (err.code !== 'EEXIST') return { ok: false, error: { kind: 'write_failed', message: err.message } }
      name = base + '-' + n + '-' + kind
    }
  }
  if (items.length === 0) return { ok: true, return: name, ids: [] }
  const out = recordItems(repo, name, items, { now })
  if (out.ok) return { ok: true, return: name, ids: out.ids }
  rmSync(join(dir, name + '.json'), { force: true })
  return out.refused ? { ok: false, refused: out.refused } : { ok: false, error: { kind: 'append_failed', message: out.error } }
}

// ------------------------------------------------------------------ reading the store

/** The latest revision of every item, and the latest judgement of each, both by seq. */
function readStore(repo) {
  const items = new Map()
  const judged = new Map()
  for (const e of readProjectLog(repo, 'items').entries) {
    if (e.kind === 'item' && isPlainObject(e.item) && ITEM_ID.test(e.item.id || '')) {
      const prev = items.get(e.item.id)
      if (!prev || e.seq > prev.seq) items.set(e.item.id, { ...e.item, seq: e.seq })
    } else if (e.kind === 'judged' && ITEM_ID.test(e.id || '')) {
      const prev = judged.get(e.id)
      if (!prev || e.seq > prev.seq) judged.set(e.id, e)
    }
  }
  return { items, judged }
}

export const liveItems = (repo) => readStore(repo).items

// ------------------------------------------------------------------ CLI

/** Each verb reads argv and returns the payload it prints; every verb prints an envelope. */
const COMMANDS = {
  record: (argv, repo) => {
    const { value, problem } = decodeArgs(argv)
    return problem ? { ok: false, error: problem } : recordRaw(repo, flagOf(argv, 'kind'), value)
  },
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const argv = process.argv.slice(2)
    const [command] = argv
    if (!Object.hasOwn(COMMANDS, command || '')) {
      throw new Error('unknown command ' + JSON.stringify(command || '') + ' — expected ' + Object.keys(COMMANDS).join(', '))
    }
    console.log(JSON.stringify(envelope(COMMANDS[command](argv, flagOf(argv, 'repo') || '.'))))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
