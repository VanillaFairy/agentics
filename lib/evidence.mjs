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
//
// Why the anchor check is the first rung. Before a model re-reads anything, the anchor check asks
// only whether the text an item rests on moved: `checkAnchors` derives standing, suspect or stale
// from `git diff` hunks, deterministic and free of judgment. Whether text changed is decided by
// those hunks alone (D20) — no normaliser, no whitespace folding, no language awareness — so the
// same check reads code and prose alike.
//
// A later solutions sweep of a capability supersedes the earlier sweep's items in `itemsFor`;
// their lines stay in the log.
//
// The prune (T26a, spec §4.9). A stale item no live folder's latest citation names has left the
// live pool: `itemsFor` leaves it out whatever `states` asks for and `recordCites` refuses it. Its
// lines stay in `items.jsonl`; a survey that records it again as a new revision is what brings it back.

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { append, appendProject, readLog, readProjectLog } from './ledger.mjs'
import { mergeRanges, pruneWeekOld, writeContext } from './citations.mjs'
import { pathsOverlap } from './gotchas.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import { hashSpec } from './spec.mjs'
import {
  AGENTICS_DIR, contextDir, effortsRoot, evidenceInboxDir, evidenceReturnsDir, evidenceSnapshotsDir, flagsOf, git, handleArgs,
  handleEnvelope, mainCheckout, mkdirState, nodeIdProblem, posix, readConfig, revParse, safePath, safeSlug, stampNow,
} from './store.mjs'
import { liveNodes } from './tree.mjs'

export const ITEM_KINDS = ['behaviour', 'absence', 'enumeration', 'relation', 'external', 'derived']

/** The anchors each kind must carry at least one of. `checkItem` refuses an item without them. */
export const REQUIRED = {
  behaviour: ['spans'], absence: ['queries'], enumeration: ['queries'],
  relation: ['spans', 'queries'], external: ['sources'], derived: ['rests_on'],
}

/** What a raw return can be the return of. An `approach` draft carries no items of its own. */
export const RETURN_KINDS = ['survey', 'probe', 'solutions', 'approach']
const EMPTY_KEPT = ['approach', 'probe']   // a draft cites, a clean review found nothing

const ANCHORS = ['spans', 'queries', 'sources', 'rests_on']
const SHA = /^[0-9a-f]{40}$/
const SNAPSHOT = /^snapshot:([0-9a-f]{8})$/
const ITEM_ID = /^I[0-9a-f]{8}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const VERDICTS = ['holds', 'fails', 'unsure']
const DAY = 24 * 60 * 60 * 1000

/** The checkout whose tree a call reads: the one the run is in, else the main checkout. The store is always the main checkout's. */
const rootOf = (repo, root) => (root ? posix(resolve(root)) : mainCheckout(repo))

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

/**
 * Save a text the store can diff against later, named by its spec hash. Idempotent: an existing
 * file is kept only when it already hashes to its own name, so a torn write (a killed writer left
 * half a file behind) is repaired on the next call rather than read as the old text. The write
 * itself is atomic — a temp file, then a rename over the target — so a reader never sees half a file.
 */
export function snapshotSpec(repo, text) {
  const normal = String(text == null ? '' : text).replace(/\r\n/g, '\n')
  const hash = hashSpec(normal)
  mkdirState(evidenceSnapshotsDir(repo))
  const file = snapshotFile(repo, hash)
  const intact = existsSync(file) && hashSpec(readFileSync(file, 'utf8')) === hash
  if (!intact) {
    const tmp = file + '.' + process.pid + '.tmp'
    writeFileSync(tmp, normal, 'utf8')
    renameSync(tmp, file)
  }
  return 'snapshot:' + hash
}

/**
 * Where a span read from the working tree is anchored: HEAD when the file is tracked and unchanged
 * against it, otherwise a snapshot of the text it was read from. Anchoring an edited file at HEAD
 * would make the item suspect the moment it was recorded. `write: false` (T22b calls with four
 * arguments and gets the default) returns the id the snapshot would have without saving it, so a
 * caller can defer the write until it knows the whole batch will be kept.
 */
function anchorFor(repo, root, path, text, { write = true } = {}) {
  const tracked = git(root, ['ls-files', '--error-unmatch', '--', path]).ok
  if (tracked && git(root, ['diff', '--quiet', 'HEAD', '--', path]).ok) {
    const head = revParse(root, 'HEAD')
    if (head) return head
  }
  if (!write) return 'snapshot:' + hashSpec(String(text == null ? '' : text).replace(/\r\n/g, '\n'))
  return snapshotSpec(repo, text)
}

/** Run one query as the store re-runs it. Line numbers are dropped: an item is about what, not where. */
function runQuery(root, pattern, scope) {
  if (pattern.includes('\0') || scope.some((p) => p.includes('\0'))) {
    return { error: 'a query pattern or scope path may not hold a NUL byte' }
  }
  const r = git(root, [
    'grep', '-n', '-z', '-E', '--text', '--untracked', '-e', pattern, '--',
    ...(scope.length ? scope : ['.']), ':(exclude)' + AGENTICS_DIR,
  ])
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

/**
 * One raw item made ready for the pool: shape defaults, observations filled, identity minted.
 * A span whose `at` a fresh read must decide is anchored without writing its snapshot yet — `pending`
 * carries the text each such span would need, so the caller can save it only once the whole batch
 * is known to pass.
 */
function prepare(repo, root, raw, returnName, today) {
  const src = isPlainObject(raw) ? raw : {}
  const list = (v) => (Array.isArray(v) ? v : [])
  const problems = []
  const pending = []

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
    if (span.at === '') {
      span.at = anchorFor(repo, root, path, text, { write: false })
      if (SNAPSHOT.test(span.at)) pending.push(text)
    }
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
  return { item, problems, pending }
}

/**
 * Record a batch of items, all or nothing. Each is prepared (observations filled), then checked;
 * one refused item refuses the batch and nothing is written, because a judge's return with a
 * refused item goes back to that judge rather than into the pool. `root` is the checkout the judge
 * read: every observation (a span's text and `at`, a query's result) is read there, while the
 * store (`items.jsonl`, `snapshots/`, `returns/`) is always the main checkout's.
 */
export function recordItems(repo, returnName, items, { now = new Date(), root: given } = {}) {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'there are no items to record' }
  const root = rootOf(repo, given)
  const today = now.toISOString().slice(0, 10)
  const refused = []
  const pendingTexts = []
  const ready = items.map((raw, index) => {
    const { item, problems, pending } = prepare(repo, root, raw, returnName, today)
    const all = problems.concat(checkItem(item))
    if (all.length > 0) refused.push({ index, problems: all })
    else pendingTexts.push(...pending)
    return item
  })
  if (refused.length > 0) return { ok: false, refused }
  for (const text of pendingTexts) snapshotSpec(repo, text)
  const out = appendProject(repo, 'items', ready.map((item) => ({ kind: 'item', item })))
  return out.ok ? { ok: true, ids: ready.map((i) => i.id), seqs: out.seqs } : { ok: false, error: out.error }
}

/**
 * Keep a raw return and record the items in it. The return's name is `<stamp>[-<n>]-<kind>`, reserved
 * by an exclusive create so two recorders in one second can't share it. A refused return is deleted
 * again, so what stays in `returns/` is exactly what entered the pool. An approach draft names
 * items already in the store in its `cites` and brings none of its own, and a clean probe found
 * nothing to record — both are kept with none, so a clean review still names a real return a
 * `prepared` line can point to.
 */
export function recordRaw(repo, kind, payload, { now = new Date(), root } = {}) {
  if (!RETURN_KINDS.includes(kind)) {
    return { ok: false, error: { kind: 'bad_kind', message: 'the kind must be one of ' + RETURN_KINDS.join(', ') + ', not ' + JSON.stringify(kind) } }
  }
  const items = kind === 'approach' && isPlainObject(payload) && payload.items === undefined ? [] : (payload || {}).items
  if (!isPlainObject(payload) || !Array.isArray(items) || (items.length === 0 && !EMPTY_KEPT.includes(kind))) {
    return {
      ok: false,
      error: {
        kind: 'bad_payload',
        message: 'a raw return must be an object carrying a non-empty items list (an approach draft or a clean probe may carry none)',
      },
    }
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
  const out = recordItems(repo, name, items, { now, root })
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

// ------------------------------------------------------------------ cites

/**
 * Record which items a folder rests on, and the coverage gaps it rests on them despite. A folder's
 * latest line is its whole citation; its evidence.md renders from that line. An id the store
 * doesn't hold is refused: a citation of nothing would render as evidence.
 */
export function recordCites(repo, effort, folderId, { items = [], gaps = [] } = {}) {
  const problem = nodeIdProblem(folderId)
  if (problem) return { ok: false, error: problem }
  const ids = [...new Set((Array.isArray(items) ? items : []).map(String))]
  const notes = (Array.isArray(gaps) ? gaps : []).map(String).map((g) => g.trim()).filter(Boolean)
  if (ids.length === 0 && notes.length === 0) return { ok: false, error: 'nothing to cite: no item and no gap' }
  const live = liveItems(repo)
  const unknown = ids.filter((id) => !live.has(id))
  if (unknown.length > 0) {
    return { ok: false, error: 'not in the evidence store: ' + unknown.join(', ') + ' — nothing was recorded' }
  }
  const pruned = prunedOf(repo, ids)
  if (pruned.length > 0) {
    return { ok: false, error: 'stale and cited by no folder, so out of the pool: ' + pruned.join(', ') + ' — survey its topic again; nothing was recorded' }
  }
  const out = append(repo, effort, 'cites', { kind: 'cites', folder: folderId, items: ids, gaps: notes })
  return out.ok ? { ok: true, seq: out.seqs[0] } : { ok: false, error: out.error }
}

/** Pure. Each folder's latest cites line, by seq: a folder's citation is replaced whole, never merged. */
export function latestCites(entries) {
  const out = new Map()
  for (const line of entries) {
    if (!line || line.kind !== 'cites' || typeof line.folder !== 'string') continue
    const prev = out.get(line.folder)
    if (!prev || (line.seq || 0) > (prev.seq || 0)) out.set(line.folder, line)
  }
  return out
}

/** Every item id a live folder of some effort cites in its latest line. A folder whose node compile retired cites nothing. */
function citedAnywhere(repo) {
  const ids = new Set()
  let efforts = []
  try {
    efforts = readdirSync(effortsRoot(repo), { withFileTypes: true })
      .filter((e) => e.isDirectory() && safeSlug(e.name) === e.name).map((e) => e.name)
  } catch {
    efforts = []
  }
  for (const effort of efforts) {
    const nodeLines = readLog(repo, effort, 'nodes').entries
    const live = liveNodes(nodeLines)
    const retired = new Set(nodeLines.filter((l) => l && l.kind === 'node' && l.node && !live.has(l.node.id)).map((l) => l.node.id))
    for (const [folder, line] of latestCites(readLog(repo, effort, 'cites').entries)) {
      if (!retired.has(folder)) for (const id of line.items || []) ids.add(id)
    }
  }
  return ids
}

/** The ids among `ids` that have left the live pool: stale, and cited by no live folder. */
function prunedOf(repo, ids) {
  const cited = citedAnywhere(repo)
  const stale = new Set(checkAnchors(repo, ids.filter((id) => !cited.has(id))).filter((s) => s.state === 'stale').map((s) => s.id))
  return ids.filter((id) => stale.has(id))
}

// ------------------------------------------------------------------ anchor checks

/** Pure. The hunks of a `git diff -U0`: old and new ranges, an omitted count meaning 1. */
export function hunksOf(diff) {
  const out = []
  for (const m of String(diff || '').matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    out.push({
      oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]),
    })
  }
  return out
}

/**
 * Pure. Where the lines [start, end] sit after `hunks`, and whether any hunk touched them. A hunk
 * wholly above shifts the span by its net delta; one overlapping it changes it; one below leaves it.
 * A pure insertion (old count 0) sits AFTER old line `oldStart`: it is above when that line is
 * above the span, inside when it falls between two span lines, and below from the last line on.
 * A hunk straddling the first line starts the span at the hunk's first new line; one straddling
 * the last line ends it at the hunk's last new line (the line before, for a pure deletion), so only
 * the part of a hunk inside the span moves its end. `end < start` means no line of it is left.
 */
export function mapSpan(hunks, start, end) {
  let changed = false
  let before = 0   // net delta of the hunks wholly above the first line
  let upto = 0     // net delta of the hunks that end at or before the last line
  let from = null
  let to = null
  for (const h of hunks) {
    const d = h.newCount - h.oldCount
    if (h.oldCount === 0) {
      if (h.oldStart < start) before += d
      if (h.oldStart < end) upto += d
      if (h.oldStart >= start && h.oldStart < end) changed = true
      continue
    }
    const last = h.oldStart + h.oldCount - 1
    if (last < start) before += d
    else if (h.oldStart < start) from = h.oldStart + before
    if (h.oldStart <= end && last >= start) changed = true
    if (last <= end) upto += d
    else if (h.oldStart <= end) to = h.oldStart + upto + h.newCount - 1
  }
  return { changed, start: from ?? start + before, end: to ?? end + upto }
}

const sliceLines = (text, s, e) => text.split('\n').slice(s - 1, e).join('\n')

/**
 * Where a rename took `at`'s `path`, per `git diff --name-status -M`; null when it was deleted
 * with no rename found (a plain `mv` git hasn't staged, or one below the similarity threshold).
 * Falls back to `path` unchanged when the name-status diff itself fails.
 */
function followRename(root, at, path) {
  const r = git(root, ['diff', '--name-status', '-z', '-M', at])
  if (!r.ok) return path
  const fields = r.stdout.split('\0')
  for (let i = 0; i < fields.length && fields[i] !== '';) {
    const status = fields[i]
    if (/^[RC]\d*$/.test(status)) {
      const [from, to] = [fields[i + 1], fields[i + 2]]
      if (status[0] === 'R' && from === path) return to
      i += 3
    } else {
      const p = fields[i + 1]
      if (status === 'D' && p === path) return null
      i += 2
    }
  }
  return path
}

/**
 * Check one span, deriving only, never writing. Returns `{error}`, or `{changed, old, now, to}`
 * where `to` is the span's place in the working tree (`{path, start, end}`), or null when its
 * file is gone. A snapshot span diffs the snapshot file against the current one; a committed span
 * diffs `at` against the working tree, uncommitted edits included, following a rename.
 */
function spanCheck(repo, root, span) {
  const { path, start, end, at } = span
  const snap = SNAPSHOT.exec(at)
  const finish = (diffOut, newPath, old) => {
    const m = mapSpan(hunksOf(diffOut), start, end)
    const to = { path: newPath, start: m.start, end: m.end }
    const now = m.changed ? sliceLines(readText(root, newPath), m.start, m.end) : ''
    return { changed: m.changed, old, now, to }
  }

  if (snap) {
    const file = snapshotFile(repo, snap[1])
    if (!existsSync(file)) return { error: 'its snapshot ' + at + ' is gone from the store' }
    const fullOld = readFileSync(file, 'utf8')
    if (hashSpec(fullOld) !== snap[1]) return { error: 'its snapshot ' + at + ' is damaged' }
    const old = sliceLines(fullOld, start, end)
    if (readText(root, path) === null) return { changed: true, old, now: '', to: null }
    const r = git(root, ['diff', '--no-index', '-U0', '--ignore-cr-at-eol', '--', file, join(root, ...path.split('/'))])
    if (r.status !== 0 && r.status !== 1) return { error: 'git diff --no-index failed: ' + (r.stderr.trim() || String(r.status)) }
    return finish(r.stdout, path, old)
  }

  const fullOld = readAt(root, at, path)
  if (fullOld === null) return { error: 'the commit ' + at + ' or ' + path + ' in it is not in this repository' }
  const old = sliceLines(fullOld, start, end)
  const newPath = followRename(root, at, path)
  if (newPath === null) return { changed: true, old, now: '', to: null }
  const paths = [...new Set([path, newPath])]
  const r = git(root, ['diff', '-U0', '-M', '--ignore-cr-at-eol', at, '--', ...paths])
  if (!r.ok) return { error: 'git diff failed: ' + (r.stderr.trim() || String(r.status)) }
  return finish(r.stdout, newPath, old)
}

/** Re-run one query anchor; a difference in the {path, text} set is a change, line numbers ignored. */
function queryCheck(root, q) {
  const ran = runQuery(root, q.pattern, q.scope)
  if (ran.error) return { error: ran.error }
  const key = (r) => r.path + '\0' + r.text
  const before = new Set(q.result.map(key))
  const after = new Set(ran.result.map(key))
  if (before.size === after.size && [...before].every((k) => after.has(k))) return { changed: false }
  const line = (r) => r.path + ': ' + r.text
  return { changed: true, old: q.result.map(line).join('\n'), now: ran.result.map(line).join('\n') }
}

function ageLimit(repo) {
  const days = readConfig(repo).evidence_max_age_days
  return Number.isInteger(days) && days > 0 ? days : 30
}

/** Derive each item's state: standing, suspect or stale. Deterministic, no model, no writes. */
export function checkAnchors(repo, ids, { now = new Date(), root: given } = {}) {
  const { items, judged } = readStore(repo)
  const root = rootOf(repo, given)
  const maxAge = ageLimit(repo)
  const memo = new Map()

  const derive = (id, trail) => {
    if (memo.has(id)) return memo.get(id)
    const done = (state, why, changed = []) => {
      const out = { id, state, changed, why }
      memo.set(id, out)
      return out
    }
    const item = items.get(id)
    if (!item) return done('stale', 'no item ' + id + ' is in the store')
    if (trail.has(id)) return done('stale', id + ' rests on itself')
    const j = judged.get(id)
    if (j && j.seq > item.seq && j.verdict !== 'holds') return done('stale', 'judged ' + j.verdict)

    const changed = []
    for (const [i, s] of item.sources.entries()) {
      const expires = Date.parse(s.retrieved + 'T00:00:00Z') + maxAge * DAY
      if (!(expires > now.getTime())) return done('stale', 'source ' + i + ' was retrieved ' + s.retrieved + ', more than ' + maxAge + ' day(s) ago')
    }
    for (const [i, r] of item.rests_on.entries()) {
      const base = derive(r, new Set([...trail, id]))
      if (base.state === 'stale') return done('stale', 'it rests on ' + r + ', which is stale')
      if (base.state === 'suspect') changed.push({ anchor: 'rests_on', index: i, old: r, now: 'suspect' })
    }
    for (const [i, s] of item.spans.entries()) {
      const c = spanCheck(repo, root, s)
      if (c.error) return done('stale', 'span ' + i + ': ' + c.error)
      if (c.changed) changed.push({ anchor: 'span', index: i, old: c.old, now: c.now })
    }
    for (const [i, q] of item.queries.entries()) {
      const c = queryCheck(root, q)
      if (c.error) return done('stale', 'query ' + i + ': ' + c.error)
      if (c.changed) changed.push({ anchor: 'query', index: i, old: c.old, now: c.now })
    }
    return changed.length > 0
      ? done('suspect', changed.length + ' anchor(s) changed and not yet judged', changed)
      : done('standing', j && j.seq > item.seq ? 'judged holds' : 'every anchor is unchanged')
  }

  const wanted = Array.isArray(ids) ? ids : [...items.keys()].sort()
  return wanted.map((id) => derive(id, new Set()))
}

/**
 * Record a re-judge's verdict. `holds` re-anchors the item at `root`'s HEAD, its spans and
 * queries re-read there, in the same batch as the `judged` line so the revision's seq is the
 * higher one. A span or query that can't be re-anchored (its lines gone, its search unrunnable,
 * or the reanchored item itself refused) leaves the item unrevised and stale, stored as
 * `unsure`/`requested: holds`. `fails` and `unsure` always leave it stale. An unknown verdict or
 * item is refused, writing nothing.
 */
export function recordJudgement(repo, id, verdict, { root: given } = {}) {
  if (!VERDICTS.includes(verdict)) {
    return { ok: false, error: 'verdict must be one of ' + VERDICTS.join(', ') + ', not ' + JSON.stringify(verdict) }
  }
  const { items } = readStore(repo)
  const item = items.get(id)
  if (!item) return { ok: false, error: 'no item ' + id + ' is in the store' }

  const root = rootOf(repo, given)
  const head = revParse(root, 'HEAD') || ''

  if (verdict !== 'holds') {
    const out = appendProject(repo, 'items', [{ kind: 'judged', id, verdict, at: head }])
    return out.ok ? { ok: true, state: 'stale', why: 'judged ' + verdict } : { ok: false, error: out.error }
  }

  const problems = []
  const spans = item.spans.map((s, i) => {
    const c = spanCheck(repo, root, s)
    if (c.error) { problems.push('span ' + i + ': ' + c.error); return s }
    if (!c.to || c.to.end < c.to.start) { problems.push('span ' + i + ' has no lines left to re-anchor to'); return s }
    return { path: c.to.path, start: c.to.start, end: c.to.end, at: anchorFor(repo, root, c.to.path, readText(root, c.to.path)) }
  })
  const queries = item.queries.map((q, i) => {
    const ran = runQuery(root, q.pattern, q.scope)
    if (ran.error) { problems.push('query ' + i + ': ' + ran.error); return q }
    return { ...q, result: ran.result }
  })

  let reanchored = null
  if (problems.length === 0) {
    const { seq, ...rest } = item
    reanchored = { ...rest, spans, queries }
    problems.push(...checkItem(reanchored))
  }

  if (problems.length === 0) {
    const out = appendProject(repo, 'items', [
      { kind: 'judged', id, verdict: 'holds', at: head },
      { kind: 'item', item: reanchored },
    ])
    if (!out.ok) return { ok: false, error: out.error }
    const st = checkAnchors(repo, [id], { root })[0]
    return { ok: true, state: st.state, why: st.why }
  }

  const why = problems.join('; ')
  const out = appendProject(repo, 'items', [{ kind: 'judged', id, verdict: 'unsure', requested: 'holds', at: head, why }])
  return out.ok ? { ok: true, state: 'stale', why } : { ok: false, error: out.error }
}

const SWEEP = /-solutions$/

/**
 * Per question and topic, the solutions return that recorded it last. A sweep answers its
 * capability whole, so only the latest sweep's items stand (latest by seq wins). A return is
 * dated by the seq it first recorded at: a re-judged revision of an old sweep's item carries the
 * old return's name at a newer seq, and must not make that sweep the latest.
 */
function latestSweeps(repo) {
  const first = new Map()
  const latest = new Map()
  for (const e of readProjectLog(repo, 'items').entries) {
    const it = e.kind === 'item' && isPlainObject(e.item) ? e.item : null
    if (!it || !SWEEP.test(String(it.from_return || ''))) continue
    if (!first.has(it.from_return)) first.set(it.from_return, e.seq)
    const key = it.question + '\0' + it.topic
    const at = latest.get(key)
    if (!at || first.get(it.from_return) > first.get(at)) latest.set(key, it.from_return)
  }
  return latest
}

/**
 * The live items whose ground overlaps `ground`, each with its state derived in `root`, filtered
 * by state. A later solutions sweep of a capability supersedes the earlier sweep's items here;
 * their lines stay in the log.
 */
export function itemsFor(repo, { ground = [], states = ['standing', 'suspect'], now = new Date(), root } = {}) {
  const sweeps = latestSweeps(repo)
  const current = (it) => !SWEEP.test(String(it.from_return || '')) || sweeps.get(it.question + '\0' + it.topic) === it.from_return
  const hits = [...readStore(repo).items.values()]
    .filter((it) => it.ground.some((g) => ground.some((p) => pathsOverlap(g, p))))
  const st = new Map(checkAnchors(repo, hits.map((i) => i.id), { now, root }).map((s) => [s.id, s]))
  const cited = citedAnywhere(repo)
  return hits
    .map((it) => ({ ...it, state: st.get(it.id).state, changed: st.get(it.id).changed, why: st.get(it.id).why }))
    .filter(current)
    .filter((it) => it.state !== 'stale' || cited.has(it.id))
    .filter((it) => states.includes(it.state))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * The narrowed re-review of an artefact: the lines changed since the `since` snapshot, and the
 * standing `challenge:` findings on it no edit touched. `file` may name a path in a linked
 * worktree or in the main checkout; it resolves to one repository-relative path, read from `root`.
 */
export function reviewScope(repo, file, since = '', { root: given } = {}) {
  const root = rootOf(repo, given)
  const path = artefactPath(repo, file, root)
  if (!path) {
    return { ok: false, error: { kind: 'outside', message: file + ' names no path inside a checkout this can read' } }
  }
  const text = readText(root, path)
  if (text === null) return { ok: false, error: { kind: 'unreadable', message: path + ' could not be read' } }

  const snapshot = snapshotSpec(repo, text)
  const lines = lineCount(text)
  const full = { ok: true, path, snapshot, lines, since, full: true, changed: lines ? [{ start: 1, end: lines }] : [], carried: [] }

  const sinceMatch = SNAPSHOT.exec(since)
  const sinceFile = sinceMatch ? snapshotFile(repo, sinceMatch[1]) : null
  if (!sinceFile || !existsSync(sinceFile)) return full
  if (hashSpec(readFileSync(sinceFile, 'utf8')) !== sinceMatch[1]) return full

  const r = git(root, ['diff', '--no-index', '-U0', '--ignore-cr-at-eol', '--', sinceFile, snapshotFile(repo, snapshot.slice('snapshot:'.length))])
  if (r.status !== 0 && r.status !== 1) return full

  const ranges = hunksOf(r.stdout).map((h) => (h.newCount > 0
    ? { from: h.newStart, to: h.newStart + h.newCount - 1 }
    : { from: Math.max(1, h.newStart), to: Math.max(1, Math.min(lines, h.newStart + 1)) }))
  const changed = mergeRanges(ranges).map((rg) => ({ start: rg.from, end: rg.to }))

  return { ok: true, path, snapshot, lines, since, full: false, changed, carried: carriedSince(repo, path, since, root) }
}

/**
 * `file` as one repository-relative path, or null. It may name a path in a linked worktree or in
 * the main checkout.
 */
function artefactPath(repo, file, root) {
  const topRes = git(repo, ['rev-parse', '--show-toplevel'])
  const top = topRes.ok ? topRes.stdout.trim() : resolve(repo)
  const abs = resolve(top, file)
  let path = posix(relative(top, abs))
  if (path.startsWith('..')) path = posix(relative(root, abs))
  if (path.startsWith('..')) path = posix(relative(mainCheckout(repo), abs))
  return safePath(path) === null || path.startsWith('..') ? null : path
}

/**
 * The standing `challenge:` findings on the artefact at `path` that a review narrowed by `since`
 * carries forward: none unless `since` is a snapshot this store holds intact.
 */
function carriedSince(repo, path, since, root) {
  const m = SNAPSHOT.exec(since || '')
  const file = m ? snapshotFile(repo, m[1]) : null
  if (!file || !existsSync(file) || hashSpec(readFileSync(file, 'utf8')) !== m[1]) return []
  return itemsFor(repo, { ground: [path], states: ['standing'], root })
    .filter((it) => it.question === path && it.topic.startsWith('challenge:') && it.spans.every((s) => s.path === path))
}

/// ------------------------------------------------------------------ return files
//
// An agent whose output this store consumes writes it itself, with its Write tool, to the file its
// dispatch names; a courier hands this module only that path
// (docs/DESIGN.md#gp6--couriers-carry-handles-data-stays-where-its-author-wrote-it). What an agent
// wrote is mapped to items here, never in a workflow.

/** An agent's return file, parsed; null when it is missing or not a JSON object. */
function readReturn(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

const listOf = (v) => (Array.isArray(v) ? v : [])
const textOf = (v) => (typeof v === 'string' ? v.trim() : '')

/** Pure. A section name as a handle: lower case, words joined by dashes. */
export const sectionSlug = (s) => textOf(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

/** Pure. One item as a reader reads it: id, topic, kind, claim, and what it rests on. */
function itemLine(it) {
  const anchors = [
    ...listOf(it.spans).map((s) => `${s.path}:${s.start}-${s.end}`),
    ...listOf(it.queries).map((q) => `search /${q.pattern}/ in ${listOf(q.scope).join(', ') || 'the repository'}`),
    ...listOf(it.sources).map((s) => s.url + (s.version ? '@' + s.version : '')),
    ...listOf(it.rests_on).map((id) => 'rests on ' + id),
  ]
  return `- [${it.id}] (${it.topic}, ${it.kind}${it.state ? ', ' + it.state : ''}) ${it.claim}` +
    (anchors.length ? ` — ${anchors.join('; ')}` : '')
}

/** What a dry run of the recorder says is wrong with one item; [] when it would be kept. */
function problemsOf(repo, root, raw, today) {
  const { item, problems } = prepare(repo, root, raw, '', today)
  return problems.concat(checkItem(item))
}

/** The refused items as their author reads them back: each as written, with what is wrong with it. */
function writeRefusals(repo, refused, what) {
  const text = `The evidence store refused ${refused.length} ${what} for their anchors. Each is below as ` +
    'it was written, with what is wrong with it. Write corrected versions of exactly these, fixing ' +
    'what each problem names, and nothing else.\n\n' +
    refused.map((r, i) => `--- ${i + 1} of ${refused.length}\n${JSON.stringify(r.raw, null, 2)}\nproblems:\n` +
      r.problems.map((p) => '- ' + p).join('\n')).join('\n\n') + '\n'
  return writeContext(repo, text).path
}

/** Every refused item's topic, counted. */
const topicCounts = (list) => [...list.reduce((m, r) => m.set(r.topic, (m.get(r.topic) || 0) + 1), new Map())]
  .map(([topic, n]) => ({ topic, n }))

/**
 * Record what a survey's judges wrote. The question comes from the plan file its planner wrote,
 * checked against the digest of the one the survey was asked; each topic's ground is its subtree.
 * `from` are the judges' return files, `fix` the corrections of refused items in the order they
 * were asked for: an item the last of them refuses refuses the whole record, written back to a
 * refusals file for its judge, while an earlier one that fails was re-asked and is dropped.
 */
export function recordSurvey(repo, { plan, question_digest, topics, from, fix = [] }, { now = new Date(), root: given } = {}) {
  const planned = readReturn(plan)
  const question = planned ? textOf(planned.question) : ''
  if (!question) return { ok: false, error: { kind: 'plan_unreadable', message: plan + ' holds no question' } }
  if (fnv1a(question) !== question_digest) {
    return { ok: false, error: { kind: 'question_mismatch', message: 'the plan\'s question digests to ' + fnv1a(question) + ', the survey asked ' + question_digest } }
  }
  const groups = [from, ...fix.map((f) => [f])]
  const unread = groups.flat().filter((f) => readReturn(f) === null)
  if (unread.length > 0) return { ok: false, error: { kind: 'return_unreadable', message: 'could not read ' + unread.join(', ') } }

  const keys = topics.map((t) => t.key)
  const rows = []
  groups.forEach((files, g) => files.forEach((file) => {
    for (const raw of listOf(readReturn(file).items)) {
      const src = isPlainObject(raw) ? raw : {}
      const topic = keys.length === 1 ? keys[0] : textOf(src.topic)
      const t = topics.find((x) => x.key === topic)
      const item = {
        question, topic, ground: [relPath(t ? t.subtree : '')], kind: src.kind, claim: textOf(src.claim),
        spans: listOf(src.spans).map((s) => (isPlainObject(s) ? { path: posix(s.path), start: s.start, end: s.end, at: '' } : s)),
        queries: listOf(src.queries).map((q) => (isPlainObject(q) ? { pattern: q.pattern, scope: listOf(q.scope).map(posix) } : q)),
        sources: listOf(src.sources).map((s) => (isPlainObject(s) ? { url: s.url, version: typeof s.version === 'string' ? s.version : '', retrieved: '' } : s)),
        rests_on: listOf(src.rests_on),
      }
      rows.push({ g, raw, topic, item, known: Boolean(t) })
    }
  }))

  // A derived item names its siblings by claim; the recorder takes ids.
  const byClaim = new Map(rows.map((r) => [r.item.claim, itemId(r.item)]))
  for (const r of rows) r.item.rests_on = r.item.rests_on.map((x) => (ITEM_ID.test(x) ? x : byClaim.get(textOf(x)) || x))

  const root = rootOf(repo, given)
  const today = now.toISOString().slice(0, 10)
  const last = groups.length - 1
  for (const r of rows) {
    r.problems = (r.known ? [] : ['topic ' + JSON.stringify(r.topic) + ' is not one of the topics you were given: ' + keys.join(', ')])
      .concat(problemsOf(repo, root, r.item, today))
  }
  const refused = rows.filter((r) => r.g === last && r.problems.length > 0)
  const kept = rows.filter((r) => r.problems.length === 0)
  const dropped = rows.length - kept.length - refused.length
  if (refused.length > 0) {
    // A topic the judge invented is its words, not a handle; it is counted under one name.
    const counted = topicCounts(refused.map((r) => ({ topic: r.known ? r.topic : 'unknown-topic' })))
    return { ok: false, refused: counted, refused_n: refused.length, refusals_file: writeRefusals(repo, refused, 'item(s)') }
  }
  if (kept.length === 0) return { ok: true, return: '', recorded_n: 0, dropped_n: dropped }
  const out = recordRaw(repo, 'survey', { items: kept.map((r) => r.item) }, { now, root: given })
  if (!out.ok) return out.refused ? { ok: false, refused: [], refused_n: out.refused.length, refusals_file: '' } : out
  return { ok: true, return: out.return, recorded_n: out.ids.length, dropped_n: dropped }
}

const SEVERITIES = ['ambiguity', 'gap', 'note']

/** A finding the narrowed review carries forward: its item, as a finding. */
function carriedFinding(it) {
  const d = isPlainObject(it.detail) ? it.detail : {}
  const s = it.spans[0] || {}
  return {
    item: it.id, axis: textOf(d.axis) || String(it.topic || '').replace(/^challenge:/, ''),
    severity: SEVERITIES.includes(d.severity) ? d.severity : 'note', section: textOf(d.section),
    claim: it.claim, evidence: textOf(d.evidence), start: s.start || 0, end: s.end || 0, carried: true,
  }
}

/** Pure. Findings as their reader reads them, by id. */
function renderFindings(findings) {
  if (findings.length === 0) return '(no findings)\n'
  return findings.map((f) => `${f.id} [${f.severity}, ${f.axis}]${f.carried ? ' (carried from an earlier review)' : ''}` +
    ` — section: ${f.section || '(none named)'}; lines ${f.start}-${f.end}${f.item ? '; item ' + f.item : ''}\n` +
    `  claim: ${f.claim}\n  evidence: ${f.evidence}`).join('\n\n') + '\n'
}

/**
 * Every finding in full, as JSON under its id: the boundary that records a review round reads it,
 * and the planner settling the round Reads it. Named by its content, so a retried round rewrites it.
 */
function writeFindings(repo, findings) {
  const text = JSON.stringify({ findings }, null, 1)
  const dir = resolve(contextDir(repo))
  mkdirState(dir)
  pruneWeekOld(dir, Date.now())
  const path = posix(join(dir, fnv1a(text) + '-findings.json'))
  writeFileSync(path, text, 'utf8')
  return path
}

/** An axis key as a handle: an older finding may carry one written before keys were slugs. */
const axisHandle = (axis) => String(axis || '').replace(/[\s"`]+/g, '-')

/** A finding as its handle: what the probe's caller branches and keys on. */
const findingHandle = (f) => ({ id: f.id, item: f.item, severity: f.severity, axis: axisHandle(f.axis), section: sectionSlug(f.section), carried: f.carried })

/**
 * Record a probe round. `from` are the analysts' return files and `bundle[i]` the `+`-joined axes
 * the analyst of `from[i]` held. Every finding the narrowed review carries is listed first. With a
 * `snapshot` each new finding is recorded as a `behaviour` item anchored to its lines in it — a
 * range outside the snapshot anchors the whole document — and a round with none records an empty
 * return; without one nothing is recorded. Either way every finding is written in full to one file.
 */
export function recordProbe(repo, { file, snapshot, since = '', from = [], bundle = [] }, { now = new Date(), root: given } = {}) {
  if (bundle.length !== from.length) return { ok: false, error: { kind: 'bad_args', message: 'every --from needs its --bundle' } }
  const root = rootOf(repo, given)
  const path = artefactPath(repo, file, root)
  if (!path) return { ok: false, error: { kind: 'outside', message: file + ' names no path inside a checkout this can read' } }

  const snap = SNAPSHOT.exec(snapshot || '')
  const snapText = snap && existsSync(snapshotFile(repo, snap[1])) ? readFileSync(snapshotFile(repo, snap[1]), 'utf8') : null
  const lines = snapText === null ? 0 : lineCount(snapText)

  const findings = carriedSince(repo, path, since, root).map(carriedFinding)
  const fresh = []
  const unread = []
  from.forEach((f, i) => {
    const ret = readReturn(f)
    if (!ret) { unread.push(i); return }
    const keys = String(bundle[i]).split('+').filter(Boolean)
    for (const raw of listOf(ret.findings)) {
      const src = isPlainObject(raw) ? raw : {}
      const axis = keys.length === 1 ? keys[0] : keys.includes(src.axis) ? src.axis : keys.join('+')
      const inRange = lines > 0 && Number.isInteger(src.start) && Number.isInteger(src.end) && src.start >= 1 && src.start <= src.end && src.end <= lines
      const f2 = {
        axis, severity: SEVERITIES.includes(src.severity) ? src.severity : 'ambiguity', section: textOf(src.section),
        claim: textOf(src.claim), evidence: textOf(src.evidence),
        start: inRange ? src.start : lines > 0 ? 1 : Number.isInteger(src.start) ? src.start : 0,
        end: inRange ? src.end : lines > 0 ? lines : Number.isInteger(src.end) ? src.end : 0,
        item: '', carried: false,
      }
      fresh.push(f2)
    }
  })

  let recorded = false
  let returnName = ''
  let refusedN = 0
  let refusalsFile = ''
  if (snapText !== null) {
    const items = fresh.map((f) => ({
      question: path, topic: 'challenge:' + f.axis, ground: [path], kind: 'behaviour', claim: f.claim,
      spans: [{ path, start: f.start, end: f.end, at: snapshot }], queries: [], sources: [], rests_on: [],
      detail: { axis: f.axis, severity: f.severity, section: f.section, evidence: f.evidence },
    }))
    const out = recordRaw(repo, 'probe', { items }, { now, root: given })
    if (out.ok) {
      recorded = true
      returnName = out.return
      fresh.forEach((f, i) => { f.item = out.ids[i] })
    } else if (out.refused) {
      refusedN = out.refused.length
      refusalsFile = writeRefusals(repo, out.refused.map((r) => ({ raw: items[r.index], problems: r.problems })), 'finding(s)')
    }
  }

  const all = findings.concat(fresh).map((f, i) => ({ ...f, id: 'P' + (i + 1) }))
  return {
    recorded, return: returnName, findings: all.map(findingHandle),
    findings_file: writeFindings(repo, all), refused_n: refusedN, refusals_file: refusalsFile, unread,
  }
}

/**
 * Record what an existing-solutions sweep established, and decide what it means. The question is
 * the capability the frame file holds, checked against the digest of the one the sweep was asked.
 * The assessor's rows are the candidates; without a readable assessment the researchers' are,
 * exact-name duplicates merged and nothing measured. A candidate is viable when it hit none of the
 * frame's disqualifiers — a ground the frame never declared rules nothing out — and a candidate a
 * researcher reported and the assessor dropped is named as lost. Each candidate with a source is
 * an `external` item, each hit the repository already carries a `behaviour` item at its line. All
 * of it is written to one summary file.
 */
export function recordSolutions(repo, { frame, question_digest, assessed = '', candidates = [], present = '' }, { now = new Date(), root: given } = {}) {
  const framed = readReturn(frame)
  const question = framed ? textOf(framed.capability) : ''
  if (!question) return { ok: false, error: { kind: 'frame_unreadable', message: frame + ' holds no capability' } }
  if (fnv1a(question) !== question_digest) {
    return { ok: false, error: { kind: 'question_mismatch', message: 'the frame\'s capability digests to ' + fnv1a(question) + ', the sweep asked ' + question_digest } }
  }
  const nameKey = (n) => textOf(n).toLowerCase()
  const distinct = (rows) => [...new Map(rows.map((r) => [nameKey(r.name), r])).values()]
  const researched = candidates.map(readReturn)
  const unread = researched.filter((r) => r === null).length
  const gathered = researched.flatMap((r) => (r ? listOf(r.candidates) : [])).filter(isPlainObject)
  const assessment = assessed ? readReturn(assessed) : null
  const measured = Boolean(assessment && Array.isArray(assessment.assessed))
  const rows = measured ? assessment.assessed.filter(isPlainObject) : distinct(gathered).map((c) => ({ ...c, disqualifiers_hit: [] }))

  const declared = new Set(listOf(framed.disqualifiers).map(nameKey))
  const invented = []
  for (const r of rows) {
    r.grounds = listOf(r.disqualifiers_hit).map(String).filter((h) => {
      if (declared.has(nameKey(h))) return true
      invented.push(`${r.name}: ${h}`)
      return false
    })
  }
  const kept = new Set(rows.map((r) => nameKey(r.name)))
  const lost = measured ? distinct(gathered.filter((c) => !kept.has(nameKey(c.name)))).map((c) => c.name) : []
  const viable = measured ? rows.filter((r) => r.grounds.length === 0) : []
  const ruledOut = measured ? rows.filter((r) => r.grounds.length > 0) : []

  const scan = present ? readReturn(present) : null
  const hits = scan ? listOf(scan.hits).filter(isPlainObject) : []
  const items = []
  const unanchored = []
  for (const c of rows) {
    if (!textOf(c.source_url)) { unanchored.push(String(c.name)); continue }
    items.push({
      question, topic: 'candidates', ground: [], kind: 'external',
      claim: `${c.name} — ${c.what_it_is}. Covers: ${c.covers}. Does not cover: ${c.does_not_cover}.`,
      spans: [], queries: [], rests_on: [], sources: [{ url: textOf(c.source_url), version: textOf(c.latest_version), retrieved: '' }],
      detail: { name: String(c.name), license: textOf(c.license), maintenance: textOf(c.maintenance), disqualifiers_hit: listOf(c.disqualifiers_hit) },
    })
  }
  for (const h of hits) {
    const path = posix(h.path)
    if (!path || !Number.isInteger(h.line) || h.line < 1) { unanchored.push(`${path}:${h.line}`); continue }
    items.push({
      question, topic: 'already-present', ground: [path], kind: 'behaviour', claim: `${path}: ${textOf(h.note)}`,
      spans: [{ path, start: h.line, end: h.line, at: '' }], queries: [], sources: [], rests_on: [],
    })
  }

  let recorded = false
  let returnName = ''
  let ids = []
  let refusedN = 0
  let refusalsFile = ''
  if (items.length > 0) {
    const out = recordRaw(repo, 'solutions', { items }, { now, root: given })
    if (out.ok) { recorded = true; returnName = out.return; ids = out.ids }
    else if (out.refused) {
      refusedN = out.refused.length
      refusalsFile = writeRefusals(repo, out.refused.map((r) => ({ raw: items[r.index], problems: r.problems })), 'item(s)')
    }
  }

  const facts = (c) => `- ${c.name} (${c.source_url})\n  is: ${c.what_it_is}\n  version: ${c.latest_version}\n` +
    `  licence: ${c.license}\n  maintenance: ${c.maintenance}\n  covers: ${c.covers}\n  does not cover: ${c.does_not_cover}`
  const section = (title, list, line) => `${title}\n${list.length ? list.map(line).join('\n') : '(none)'}`
  const text = [
    `CAPABILITY: ${question}`,
    section('ALREADY IN THE REPOSITORY — check these before anything below:', hits, (h) => `- ${posix(h.path)}:${h.line} — ${textOf(h.note)}`),
    measured
      ? section('VIABLE — hit no declared disqualifier (a count, never a recommendation):', viable, facts)
      : section('UNMEASURED — nobody ruled on these, so an empty disqualifier list means nobody checked:', rows, facts),
    measured ? section('RULED OUT:', ruledOut, (c) => facts(c) + `\n  ruled out by: ${c.grounds.join('; ')}`) : '',
    invented.length ? section('GROUNDS NOBODY DECLARED — cited by the assessor, not counted against anyone:', invented, (s) => '- ' + s) : '',
    lost.length ? section('FOUND BUT NEVER RULED ON — a researcher reported these and the assessment dropped them:', lost, (s) => '- ' + s) : '',
    measured && textOf(assessment.notes) ? `WHAT THE ASSESSMENT COULD NOT SETTLE:\n${textOf(assessment.notes)}` : '',
    unanchored.length ? section('NOT ANCHORABLE, SO NOT IN THE EVIDENCE POOL:', unanchored, (s) => '- ' + s) : '',
  ].filter(Boolean).join('\n\n') + '\n'

  return {
    recorded, return: returnName, items: ids.map((id, i) => ({ id, topic: items[i].topic, kind: items[i].kind })),
    refused_n: refusedN, refusals_file: refusalsFile, summary_file: writeContext(repo, text).path, measured,
    counts: {
      present: hits.length, candidates: rows.length, viable: viable.length, ruled_out: ruledOut.length,
      invented: invented.length, lost: lost.length, unanchored: unanchored.length, unread,
      unsettled: measured && textOf(assessment.notes) ? 1 : 0, present_read: present ? (scan ? 1 : 0) : 0,
    },
  }
}

/** Record a re-judge's verdicts on `ids` from the file its analyst wrote: an id it gave no verdict, or a file it never wrote, is `unsure`. */
function recordJudgements(repo, file, ids, { root } = {}) {
  const ret = readReturn(file)
  const given = new Map(listOf(ret && ret.judgements).filter(isPlainObject).map((j) => [j.id, j.verdict]))
  const out = ids.map((id) => {
    const verdict = VERDICTS.includes(given.get(id)) ? given.get(id) : 'unsure'
    return recordJudgement(repo, id, verdict, { root })
  })
  return {
    read: ret !== null,
    recorded_n: out.filter((o) => o.ok).length,
    standing_n: out.filter((o) => o.ok && o.state === 'standing').length,
    failed_n: out.filter((o) => !o.ok).length,
  }
}

// ------------------------------------------------------------------ what a reader reads

const handleOf = (it) => ({ id: it.id, state: it.state, topic: it.topic, kind: it.kind, seq: it.seq, ground: it.ground })

/** Pure. The pool over a ground as its readers read it: standing, then suspect with what changed, then stale by topic. */
function renderPool(items) {
  const of = (state) => items.filter((it) => it.state === state)
  const changes = (it) => listOf(it.changed).map((c) => `  ${c.anchor} ${c.index} was:\n${c.old}\n  is now:\n${c.now}`).join('\n')
  return [
    'STANDING — anchored, and no edit has touched what they rest on:\n' + (of('standing').map(itemLine).join('\n') || '(none)'),
    'SUSPECT — text an anchor rests on changed since it was recorded:\n' +
      (of('suspect').map((it) => itemLine(it) + (changes(it) ? '\n' + changes(it) : '')).join('\n\n') || '(none)'),
    'STALE — these no longer hold as recorded:\n' + (of('stale').map(itemLine).join('\n') || '(none)'),
  ].join('\n\n') + '\n'
}

/** Pure. One evidence channel's rounds as a reader reads them: what it found, and the limit of how. */
function renderChannel(title, files) {
  const rounds = files.map(readReturn)
  const last = rounds[rounds.length - 1]
  return `${title}\n` + rounds.map((r, i) => (r
    ? textOf(r.findings) + (textOf(r.no_match) ? `\nLooked for and did not find: ${textOf(r.no_match)}` : '')
    : `(round ${i + 1}'s report could not be read)`)).join('\n\n') +
    (last && textOf(last.stop_reason) !== 'exhausted'
      ? `\n\nCOVERAGE LIMIT (${textOf(last.stop_reason) || 'unstated'}) — never reached: ${textOf(last.not_reached) || 'not named'}. ` +
        'Any claim depending on the unreached part is provisional.'
      : '')
}

/**
 * Everything a survey returns, in one file for its reader: the standing items over `ground` from
 * earlier surveys of the same kind, every item `returns` recorded, the risks its judges wrote, and
 * its history and documentation channels.
 */
export function surveyContext(repo, { ground = [], return_kind = '', returns = [], from = [], history = [], docs = [] }, { root } = {}) {
  const kindOf = (it) => !return_kind || String(it.from_return || '').endsWith('-' + return_kind)
  const known = ground.length ? itemsFor(repo, { ground, states: ['standing'], root }).filter(kindOf) : []
  const store = readStore(repo).items
  const own = [...store.values()].filter((it) => returns.includes(it.from_return) && !known.some((k) => k.id === it.id))
  const states = new Map(checkAnchors(repo, own.map((it) => it.id), { root }).map((s) => [s.id, s.state]))
  const items = known.concat(own.map((it) => ({ ...it, state: states.get(it.id) })))
  const risks = from.flatMap((f) => listOf((readReturn(f) || {}).risks)).filter(isPlainObject)

  const topics = [...new Set(items.map((it) => it.topic))]
  const text = [
    'EVIDENCE ITEMS — one claim each, with its state and what it rests on:\n' +
      (topics.map((t) => `[${t}]\n` + items.filter((it) => it.topic === t).map(itemLine).join('\n')).join('\n\n') || '(none)'),
    risks.length ? 'RISKS THE JUDGES NAMED:\n' + risks.map((r) => `- [${textOf(r.topic)}] ${textOf(r.text)}`).join('\n') : '',
    history.length ? renderChannel('GIT HISTORY:', history) : '',
    docs.length ? renderChannel('EXTERNAL DOCUMENTATION:', docs) : '',
  ].filter(Boolean).join('\n\n') + '\n'
  return {
    items: items.map((it) => ({ id: it.id, topic: it.topic, kind: it.kind, state: it.state, return: it.from_return })),
    context: writeContext(repo, text).path,
    counts: { items: items.length, risks: risks.length, history: history.length, docs: docs.length },
  }
}

// ------------------------------------------------------------------ CLI

/** A refusal a courier carries: its kind only; the reason goes to stderr. */
function refused(error) {
  if (error && error.message) process.stderr.write(error.message + '\n')
  return { ok: false, error: { kind: (error && error.kind) || 'refused' } }
}

const csv = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean)

/** Parse a verb's handles and run it; a damaged argument is a refusal like any other. */
const verb = (spec, run) => (argv) => {
  const { value, problem } = handleArgs(argv, { repo: 'one', root: 'one', ...spec })
  if (problem) return refused(problem)
  const repo = value.repo || '.'
  const out = run(value, repo, { root: value.root || undefined })
  return out && out.ok === false && out.error ? refused(out.error) : out
}

/** Each verb reads its handles and returns the payload it prints; every verb prints a handle envelope. */
const COMMANDS = {
  record: verb({
    kind: 'one', from: 'many', fix: 'many', plan: 'one', frame: 'one', 'question-digest': 'one', topic: 'many', subtree: 'many',
    file: 'one', snapshot: 'one', since: 'one', bundle: 'many', assessed: 'one', present: 'one',
  }, (v, repo, opts) => {
    pruneWeekOld(evidenceInboxDir(repo))
    if (v.kind === 'survey') {
      if (v.topic.length !== v.subtree.length) return { ok: false, error: { kind: 'bad_args', message: 'every --topic needs its --subtree' } }
      const topics = v.topic.map((key, i) => ({ key, subtree: v.subtree[i] }))
      return recordSurvey(repo, { plan: v.plan, question_digest: v['question-digest'], topics, from: v.from, fix: v.fix }, opts)
    }
    if (v.kind === 'probe') return recordProbe(repo, { file: v.file, snapshot: v.snapshot, since: v.since, from: v.from, bundle: v.bundle }, opts)
    if (v.kind === 'solutions') {
      return recordSolutions(repo, {
        frame: v.frame, question_digest: v['question-digest'], assessed: v.assessed, candidates: v.from, present: v.present,
      }, opts)
    }
    if (v.kind === 'approach') {
      const draft = readReturn(v.from[0] || '')
      if (!draft) return { ok: false, error: { kind: 'return_unreadable', message: 'could not read ' + (v.from[0] || 'a --from file') } }
      const out = recordRaw(repo, 'approach', draft, opts)
      return out.ok ? { ok: true, return: out.return } : out.refused ? { ok: false, error: { kind: 'refused' } } : out
    }
    return { ok: false, error: { kind: 'bad_kind', message: 'the kind must be one of survey, probe, solutions, approach, not ' + JSON.stringify(v.kind) } }
  }),
  items: verb({ ground: 'one', states: 'one', 'return-kind': 'one' }, (v, repo, opts) => {
    const items = itemsFor(repo, { ground: csv(v.ground), states: csv(v.states || 'standing,suspect'), root: opts.root })
      .filter((it) => !v['return-kind'] || String(it.from_return || '').endsWith('-' + v['return-kind']))
    return { items: items.map(handleOf), context: items.length ? writeContext(repo, renderPool(items)).path : '' }
  }),
  judge: verb({ from: 'one', id: 'many' }, (v, repo, opts) => recordJudgements(repo, v.from, v.id, opts)),
  context: verb({ ground: 'one', 'return-kind': 'one', return: 'many', from: 'many', history: 'many', docs: 'many' }, (v, repo, opts) =>
    surveyContext(repo, { ground: csv(v.ground), return_kind: v['return-kind'], returns: v.return, from: v.from, history: v.history, docs: v.docs }, opts)),
  'review-scope': verb({ file: 'one', since: 'one' }, (v, repo, opts) => {
    const out = reviewScope(repo, v.file, v.since, opts)
    if (!out.ok) return out
    const carried = out.carried.map(carriedFinding).map((f, i) => ({ ...f, id: 'P' + (i + 1) }))
    return {
      ...out,
      carried: carried.map((f) => ({ item: f.item, severity: f.severity, axis: axisHandle(f.axis), section: sectionSlug(f.section) })),
      context: carried.length ? writeContext(repo, renderFindings(carried)).path : '',
    }
  }),
  cite: verb({ effort: 'one', folder: 'one', items: 'one' }, (v, repo) => {
    const out = recordCites(repo, v.effort, v.folder, { items: csv(v.items), gaps: flagsOf(process.argv, 'gap') })
    return out.ok ? out : { ok: false, error: { kind: 'refused', message: out.error } }
  }),
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
    console.log(JSON.stringify(handleEnvelope(COMMANDS[command](argv))))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
