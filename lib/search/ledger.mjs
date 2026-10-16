// lib/search/ledger.mjs — one search's facts folded into each ask's state, with no I/O: what code
// observed (the calls the tool server journaled), what the navigator declared (its returns), what
// the ruler ruled, and the state each ask ends on. A declaration stands until the navigator changes
// it and ends nothing. A turn that leaves every open ask where it was at an earlier returned turn is
// a stall: it sends each open ask to the ruler, or ends it when some ruling already saw it in that
// state. Only a ruling ends an ask done. Every end is a state, an equality of states or a ruling,
// never a count.
//
// Design: docs/DESIGN.md#searches and docs/DESIGN.md#l2--states-end-work-counts-dont.

import { canonical, fnv1a } from '../plan-digest.mjs'
import { candidateKey, canonicalUrl, globOf, pathKey, within } from './query.mjs'

export { canonicalUrl, candidateKey } from './query.mjs'

// ------------------------------------------------------------------ keys

/** The key a path (a lead's, a dismissal's) names under an ask of `domain`. */
const keyOf = (domain, path) => (domain === 'web' ? canonicalUrl(path) : pathKey(path))

/** Whether `key` lies under the literal path `p` ('.' is everything; a directory holds what is under it). */
const underLiteral = (key, p) => {
  const part = pathKey(p)
  return part === '.' || key === part || key.startsWith(part + '/')
}

/** The identity of a query: its tool and args without the page. */
const queryId = (call) => call.tool + ' ' + canonical({ ...call.args, page: undefined })

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const listOf = (v) => (Array.isArray(v) ? v : [])
const textOf = (v) => (typeof v === 'string' ? v : '')
const isEnded = (s) => s.end !== null && s.end.state !== 'stopped'

// ------------------------------------------------------------------ verification

const DECLARATIONS = new Set(['answered', 'absent', 'open'])

/** The distinct ask names an item carries, or null when it names none or a non-name. */
function askNames(item) {
  if (!isObject(item)) return null
  const raw = [].concat(item.ask ?? [])
  if (raw.length === 0 || raw.some((n) => typeof n !== 'string')) return null
  return [...new Set(raw)]
}

/** The open asks an item applies to, the class it is refused for, or `dropped` when it names only ended asks. */
function resolve(asks, item, turn) {
  const names = askNames(item)
  if (!names || names.some((n) => !Object.hasOwn(asks, n) || asks[n].from > turn)) return { refusal: 'unknown_ask' }
  const open = names.filter((n) => !isEnded(asks[n]))
  return open.length > 0 ? { open } : { dropped: true }
}

/** A hit's key, its line, and the observation that must stand under one of its asks. */
function hitOf(item) {
  if (typeof item.commit === 'string' && item.commit !== '') return { key: item.commit, line: 0, seen: item.commit }
  if (typeof item.url === 'string' && item.url.trim() !== '') {
    const key = canonicalUrl(item.url)
    return { key, line: 0, seen: key }
  }
  if (typeof item.path === 'string' && item.path !== '' && Number.isInteger(item.line)) {
    const key = pathKey(item.path)
    return { key, line: item.line, seen: key + ':' + item.line }
  }
  return null
}

function targetOf(item, domain, bySeq) {
  if (typeof item.path === 'string' && item.path.trim() !== '') return { key: keyOf(domain, item.path) }
  if (typeof item.glob === 'string' && item.glob !== '') return { glob: item.glob }
  if (Number.isInteger(item.call) && bySeq.has(item.call)) return { call: item.call }
  return null
}

/** asks: { [key]: { from, domain, end, hits, observed: Set } }. Pure. */
function verify(asks, bySeq, output, turn) {
  const accepted = { hits: [], dismissed: [], leads: [], asks: [] }
  const refusals = []
  const source = isObject(output) ? output : {}
  const refuse = (kind, raw, cls, names = []) => refusals.push({ item: { kind, ...(isObject(raw) ? raw : { raw }) }, class: cls, asks: names })

  for (const raw of listOf(source.hits)) {
    const r = resolve(asks, raw, turn)
    if (r.dropped) continue
    if (r.refusal) { refuse('hit', raw, r.refusal); continue }
    const h = hitOf(raw)
    if (!h || !r.open.some((n) => asks[n].observed.has(h.seen))) { refuse('hit', raw, 'unobserved', r.open); continue }
    accepted.hits.push({
      asks: r.open, key: h.key, line: h.line, note: textOf(raw.note),
      ...(isObject(raw.candidate) ? { candidate: { ...raw.candidate, key: candidateKey(raw.candidate) } } : {}),
    })
  }

  for (const raw of listOf(source.dismissed)) {
    const r = resolve(asks, raw, turn)
    if (r.dropped) continue
    if (r.refusal) { refuse('dismissed', raw, r.refusal); continue }
    const target = targetOf(raw, asks[r.open[0]].domain, bySeq)
    if (!target) { refuse('dismissed', raw, 'unobserved', r.open); continue }
    accepted.dismissed.push({ asks: r.open, ...target, why: textOf(raw.why) })
  }

  for (const raw of listOf(source.leads)) {
    const r = resolve(asks, raw, turn)
    if (r.dropped) continue
    if (r.refusal) { refuse('lead', raw, r.refusal); continue }
    if (typeof raw.path !== 'string' || raw.path.trim() === '') { refuse('lead', raw, 'unobserved', r.open); continue }
    for (const n of r.open) accepted.leads.push({ ask: n, key: keyOf(asks[n].domain, raw.path), why: textOf(raw.why) })
  }

  for (const raw of listOf(source.asks)) {
    const r = resolve(asks, raw, turn)
    if (r.dropped) continue
    if (r.refusal) { refuse('ask', raw, r.refusal); continue }
    if (!DECLARATIONS.has(raw.declared)) { refuse('ask', raw, 'unobserved', r.open); continue }
    const hasHit = (n) => asks[n].hits.length > 0 || accepted.hits.some((h) => h.asks.includes(n))
    if (raw.declared === 'absent' && r.open.some(hasHit)) { refuse('ask', raw, 'contradicts_hit', r.open); continue }
    for (const n of r.open) accepted.asks.push({ ask: n, declared: raw.declared })
  }

  return { accepted, refusals }
}

/**
 * Pure. Sorts a navigator return into what the ledger accepts and what it refuses, against the
 * ledger before it. The return is for the turn after the ledger's last.
 */
export function verifyReturn(ledger, calls, output) {
  const asks = {}
  for (const [key, a] of Object.entries(ledger.asks)) {
    asks[key] = { from: a.from, domain: a.domain, end: a.end, hits: a.hits, observed: new Set(a.observed) }
  }
  const known = Array.isArray(calls) ? calls : ledger.calls
  const bySeq = new Map(known.map((c) => [c.seq, c]))
  return verify(asks, bySeq, output, ledger.turns_n + 1)
}

// ------------------------------------------------------------------ one ask's state

function groundKeys(ground, askKey) {
  const keys = []
  for (const row of listOf(ground?.rows)) {
    if (!isObject(row) || !listOf(row.asks).includes(askKey)) continue
    const detail = row.kind + ' ' + row.mention
    if (row.kind === 'symbol') {
      for (const def of listOf(row.defs)) if (isObject(def) && typeof def.key === 'string') keys.push({ key: def.key, detail })
      if (listOf(row.refs).length > 0 && typeof row.mention === 'string') keys.push({ key: 'symbol:' + row.mention, detail, symbol: row.mention, refs: listOf(row.refs).length })
    } else if ((row.kind === 'path' || row.kind === 'doc' || row.kind === 'change') && row.exists && typeof row.key === 'string') {
      keys.push({ key: row.key, detail })
    }
  }
  return keys
}

const inRange = (line, total) => Number.isInteger(total) && line >= 1 && line <= total

function readToEnd(s, key) {
  const r = s.reads.get(key)
  return r !== undefined && Number.isInteger(r.total) && r.seen === r.total
}

// A set the stamp covers is kept as a digest that grows with the set: its size and the sum of its
// members' hashes. A sum does not depend on the order members arrive in, and adding a member
// costs that member alone, so a stamp costs the same on every turn.
const newDigest = () => ({ n: 0, sum: 0 })
const digestMove = (d, text, sign) => {
  d.n += sign
  d.sum = (d.sum + sign * parseInt(fnv1a(text), 16)) >>> 0
}

/** An ask's stamp: its observed set, hits, what dismissals closed, reads to the end, closed seeds, the distinct queries that ran ok under it and its declaration. */
const stampOf = (s) => fnv1a(canonical({
  observed: s.observedDigest,
  hits: s.hitDigest,
  closed: s.closedDigest,
  read: s.readDigest,
  seeds: s.closedSeeds,
  queries: s.queryDigest,
  declared: s.declared,
}))

/** A digest over the citations refused against an ask, as the history and the view keep it. */
const refusedOf = (s) => fnv1a(canonical(s.refusedDigest))

const entryOf = (turn, s) => ({ turn, stamp: stampOf(s), refused: refusedOf(s), observed_n: s.observed.size, hits_n: s.hits.length, calls_n: s.calls_n })

/** Appends an entry to an ask's history; `at` finds the entry of a turn. */
function record(s, entry) {
  s.history.push(entry)
  s.at.set(entry.turn, entry)
}

function newState(ask, ground) {
  const from = Number.isInteger(ask.from) ? ask.from : 1
  const seeds = listOf(ask.seeds).filter((x) => isObject(x) && typeof x.key === 'string')
  const own = ask.domain === 'repo' ? groundKeys(ground, ask.key) : []
  // an ask its own material gave nowhere to start owes the files of its scope
  const owed = ask.domain === 'repo' && seeds.length === 0 && own.length === 0 ? [...new Set(listOf(ask.owes).filter((f) => typeof f === 'string'))].sort() : []
  const s = {
    key: ask.key, domain: ask.domain, scope: listOf(ask.scope).map(String), find: ask.find, from,
    seeds, closedSeeds: seeds.filter((x) => x.as === 'closed').map((x) => x.key).sort(),
    ground: own, owed, coveredBy: new Map(),
    observed: new Set(), keys: new Set(), reads: new Map(), touched: new Set(), queries: new Map(), followed: new Set(),
    hits: [], dismissed: [], targets: new Set(), covers: [], dismissedQueries: new Set(), closedKeys: new Set(),
    looked: [], queryIds: new Set(), calls_n: 0,
    leads: [], declared: '', end: null, rulerMisses: [], history: [], at: new Map(), refused: new Set(),
    ruling: null, ruledAt: [], seen: new Set(), due: false,
    observedDigest: newDigest(), hitDigest: newDigest(), closedDigest: newDigest(), readDigest: newDigest(), queryDigest: newDigest(),
    refusedDigest: newDigest(), readDone: new Set(),
  }
  record(s, entryOf(from - 1, s))
  return s
}

const covered = (s, key) => s.covers.some((cover) => cover(key))
const closedKey = (s, key) => s.hits.some((h) => h.key === key) || covered(s, key) || readToEnd(s, key)

/** Pure. An ask's agenda: open seeds, unread leads, own ground rows not closed, symbols with references not followed, owed files not covered, grep pages not fetched. */
function agendaOf(s) {
  const items = []
  const seen = new Set(s.seeds.filter((x) => x.as === 'closed').map((x) => x.key))
  const add = (kind, key, detail, closed, refs) => {
    if (seen.has(key) || closed) return
    seen.add(key)
    items.push(refs === undefined ? { kind, key, detail } : { kind, key, detail, refs })
  }
  for (const x of s.seeds) if (x.as === 'open') add('seed', x.key, textOf(x.reason), closedKey(s, x.key))
  for (const l of s.leads) add('lead', l.key, l.why, s.touched.has(l.key) || covered(s, l.key))
  for (const g of s.ground) add(g.symbol ? 'symbol' : 'ground', g.key, g.detail, g.symbol ? s.followed.has(g.symbol) || covered(s, g.key) : closedKey(s, g.key), g.refs)
  for (const file of s.owed) add('file', file, 'in the scope; no read or grep of it has covered it', s.coveredBy.has(file) || covered(s, file))
  for (const [id, q] of s.queries) {
    if (s.dismissedQueries.has(id)) continue
    for (let page = 1; page <= q.pages; page++) {
      if (!q.fetched.has(page)) items.push({ kind: 'overflow', key: 'call:' + q.first, detail: 'page ' + page + ' of ' + q.pages })
    }
  }
  return items
}

// ------------------------------------------------------------------ folding calls

const READING = new Set(['read', 'show', 'fetch'])

function see(s, text) {
  if (s.observed.has(text)) return
  s.observed.add(text)
  digestMove(s.observedDigest, text, 1)
}

/** What a call looked for: the pattern, glob, symbol, `path:from-to`, commit or URL, or query. */
function whatOf(call) {
  const a = isObject(call.args) ? call.args : {}
  switch (call.tool) {
    case 'grep': case 'log': return textOf(a.pattern)
    case 'files': return textOf(a.glob)
    case 'refs': return textOf(a.symbol)
    case 'read': return (listOf(call.keys)[0] ?? textOf(a.path)) + ':' + (a.from ?? 1) + '-' + (call.ended?.to ?? a.to ?? 0)
    case 'show': return textOf(a.commit) + (textOf(a.path) === '' ? '' : ' ' + a.path)
    case 'fetch': return textOf(a.url)
    case 'websearch': return textOf(a.query)
    default: return ''
  }
}

/** Where a call looked: a grep's or a log's paths, else the ask's scope; the one key a read, show or fetch opened; nothing for the rest. */
function whereOf(s, call) {
  if (call.tool === 'grep' || call.tool === 'log') {
    const paths = listOf(call.args?.paths).map(String)
    return paths.length ? paths : [...s.scope]
  }
  return READING.has(call.tool) ? listOf(call.keys).slice(0, 1) : []
}

const dirOf = (file) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.')

/** Marks the owed files a call covered: a read of one, or a grep whose paths (else the ask's scope) hold it. */
function coverOwed(s, call, what) {
  let files = []
  if (call.tool === 'read') {
    const opened = new Set(listOf(call.keys))
    files = s.owed.filter((f) => opened.has(f))
  } else if (call.tool === 'grep') {
    const given = listOf(call.args?.paths).map(String)
    const parts = given.length ? given : s.scope.length ? s.scope : ['.']
    files = s.owed.filter((f) => parts.some((p) => within(f, p)))
  }
  const by = call.tool + ' ' + what
  for (const f of files) {
    if (!s.coveredBy.has(f)) s.coveredBy.set(f, new Set())
    s.coveredBy.get(f).add(by)
  }
}

/** Records that a read of `key` showed `lines` of a file of `total` lines, and whether that read it to the end. */
function noteRead(s, key, lines, total) {
  const r = s.reads.get(key) ?? { lines: new Set(), total: undefined, seen: 0 }
  const added = lines.filter((line) => !r.lines.has(line))
  for (const line of added) r.lines.add(line)
  if (r.total === total) {
    r.seen += added.filter((line) => inRange(line, total)).length
  } else {
    r.total = total
    r.seen = [...r.lines].filter((line) => inRange(line, total)).length
  }
  s.reads.set(key, r)
  s.touched.add(key)
  const done = readToEnd(s, key)
  if (done !== s.readDone.has(key)) {
    if (done) s.readDone.add(key)
    else s.readDone.delete(key)
    digestMove(s.readDigest, key, done ? 1 : -1)
  }
}

/** What a call showed an ask it names. A refused call shows nothing. */
function absorb(s, call) {
  for (const o of listOf(call.observed)) {
    if (isObject(o) && typeof o.key === 'string' && Number.isInteger(o.line)) see(s, o.key + ':' + o.line)
  }
  const keys = listOf(call.keys).filter((k) => typeof k === 'string')
  for (const key of keys) {
    see(s, key)
    s.keys.add(key)
  }

  if (READING.has(call.tool)) for (const key of keys) s.touched.add(key)
  if (isObject(call.ended) && typeof call.ended.key === 'string') {
    const { key, total_lines: total } = call.ended
    const lines = listOf(call.observed).filter((o) => isObject(o) && o.key === key && Number.isInteger(o.line)).map((o) => o.line)
    noteRead(s, key, [...new Set(lines)], total)
  }

  const id = queryId(call)
  const paged = Number.isInteger(call.pages)
  if (!s.queryIds.has(id)) {
    s.queryIds.add(id)
    digestMove(s.queryDigest, id, 1)
  }
  const what = whatOf(call)
  s.looked.push({ seq: call.seq, tool: call.tool, what, where: whereOf(s, call), total: Number.isInteger(call.total) ? call.total : null, id: paged ? id : null })
  if (s.owed.length) coverOwed(s, call, what)

  if (paged) {
    const q = s.queries.get(id) ?? { first: call.seq, pages: 0, fetched: new Set() }
    q.pages = Math.max(q.pages, call.pages)
    q.fetched.add(call.page ?? call.args?.page ?? 1)
    s.queries.set(id, q)
  }
  // a symbol is followed by a refs call of it, or a grep whose pattern names it; its unfetched pages stay on the agenda
  const pattern = call.tool === 'refs' ? call.args?.symbol : call.tool === 'grep' ? call.args?.pattern : null
  if (typeof pattern === 'string') {
    for (const g of s.ground) if (g.symbol && (call.tool === 'refs' ? pattern === g.symbol : pattern.includes(g.symbol))) s.followed.add(g.symbol)
  }
}

/** Folds `call` into every ask it names that is open at `turn`. */
function foldCall(st, call, turn) {
  for (const name of listOf(call.asks)) {
    const s = Object.hasOwn(st.asks, name) ? st.asks[name] : undefined
    if (!s || s.from > turn || isEnded(s)) continue
    s.calls_n++
    if (call.ok === true) absorb(s, call)
  }
}

// ------------------------------------------------------------------ applying a return

// A repo path names a directory's worth of keys; a web path names its one URL.
function coverOf(target, domain, bySeq) {
  if (target.key !== undefined) return domain === 'web' ? (key) => key === target.key : (key) => underLiteral(key, target.key)
  if (target.glob !== undefined) {
    const { re } = globOf(target.glob)
    return (key) => re.test(key)
  }
  const call = bySeq.get(target.call)
  const keys = new Set([...listOf(call.keys), ...listOf(call.observed).map((o) => o?.key)])
  return (key) => keys.has(key)
}

const FILE_KINDS = new Set(['seed', 'lead', 'ground', 'file'])

/**
 * What the dismissal just added to `s.covers` closed, given the agenda before it: `closes` counts
 * the agenda keys that were open and are not now and the observed keys its cover matches, less what
 * an earlier dismissal closed; `files` lists the agenda files it closed.
 */
function closeKeys(s, before) {
  const left = new Set(agendaOf(s).map((item) => item.key))
  const open = new Set(before.map((item) => item.key).filter((key) => !left.has(key)))
  const files = before.filter((item) => FILE_KINDS.has(item.kind) && !left.has(item.key)).map((item) => item.key)
  const cover = s.covers.at(-1)
  for (const key of s.keys) if (cover(key)) open.add(key)
  let closes = 0
  for (const key of open) {
    if (s.closedKeys.has(key)) continue
    s.closedKeys.add(key)
    digestMove(s.closedDigest, key, 1)
    closes++
  }
  return { closes, files }
}

function apply(st, accepted, bySeq, turn) {
  for (const h of accepted.hits) {
    for (const name of h.asks) {
      const s = st.asks[name]
      if (!s.hits.some((x) => x.key === h.key && x.line === h.line)) {
        s.hits.push({ key: h.key, line: h.line, note: h.note, turn, ...(h.candidate ? { candidate: h.candidate } : {}) })
        digestMove(s.hitDigest, h.key + ':' + h.line, 1)
      }
      if (s.declared === 'absent') s.declared = ''
    }
  }
  for (const d of accepted.dismissed) {
    const target = d.key !== undefined ? 'key:' + d.key : d.glob !== undefined ? 'glob:' + d.glob : 'call:' + d.call
    for (const name of d.asks) {
      const s = st.asks[name]
      if (s.targets.has(target)) continue
      const { asks, why, ...aim } = d
      s.targets.add(target)
      const before = agendaOf(s)
      s.covers.push(coverOf(d, s.domain, bySeq))
      if (d.call !== undefined) s.dismissedQueries.add(queryId(bySeq.get(d.call)))
      const { closes, files } = closeKeys(s, before)
      s.dismissed.push({ ...aim, why, turn, read_to_end: d.key !== undefined && readToEnd(s, d.key), closes, files })
    }
  }
  for (const l of accepted.leads) {
    const s = st.asks[l.ask]
    if (!s.leads.some((x) => x.key === l.key)) s.leads.push({ key: l.key, why: l.why, turn })
  }
  for (const a of accepted.asks) st.asks[a.ask].declared = a.declared
}

// ------------------------------------------------------------------ ending

/** What a refusal is about, by what the navigator cited, and why each class is refused. */
export function refusedWhat(item) {
  if (item.kind === 'hit') return item.path !== undefined ? item.path + ':' + item.line : item.commit || item.url || ''
  if (item.kind === 'dismissed') return item.path || item.glob || (item.call !== undefined ? 'call ' + item.call : '')
  if (item.kind === 'lead') return item.path || ''
  return (item.ask || '') + ' ' + (item.declared || '')
}
export const REFUSAL_REASON = {
  unobserved: 'no call of this search showed it under its asks',
  unknown_ask: 'it names an ask this search does not have',
  contradicts_hit: 'the ask has a hit',
}

/** An item as the navigator cited it, without its asks and its wording: the same citation again is the same refusal. */
const refusalId = (item) => {
  const { ask: _ask, note: _note, why: _why, ...cited } = item
  return canonical(cited)
}

function stopOpen(st, turn, by, why) {
  for (const key of st.order) {
    const s = st.asks[key]
    if (s.end === null) s.end = { state: 'stopped', turn, label: 'observed', why, by }
  }
}

function reopen(st) {
  for (const key of st.order) {
    const s = st.asks[key]
    if (s.end?.state === 'stopped' && s.end.by === 'navigator') s.end = null
  }
}

/**
 * After a returned turn: records each open ask's entry, then looks for a stall: an earlier returned
 * turn k, no earlier than the last join, at which every open ask had the stamp it has now. At a
 * stall an ask some ruling saw in its current state (stamp and refused set) ends; every other open
 * ask is due for a ruling. Returns the stall, or null.
 */
function evaluate(st, turn, returned) {
  const open = st.order.map((key) => st.asks[key]).filter((s) => s.from <= turn && s.end === null)
  for (const s of open) record(s, entryOf(turn, s))
  const joined = Math.max(0, ...open.map((s) => s.from))
  let k = null
  for (let i = returned.length - 1; i >= 0 && k === null; i--) {
    const at = returned[i]
    if (at >= turn || at < joined) continue
    if (open.every((s) => s.at.get(at)?.stamp === s.at.get(turn).stamp)) k = at
  }
  if (k === null) return null
  for (const s of open) {
    if (!s.seen.has(seenOf(s.at.get(turn)))) {
      s.due = true
      continue
    }
    s.end = { state: 'no_progress', turn, label: 'observed', why: 'its state equals the one after turn ' + k + ', and the ruler ruled it open in that state at turn ' + s.ruling.turn + ': ' + s.ruling.why }
    s.due = false
  }
  return { turn, k }
}

const RULINGS = new Set(['answered', 'absent', 'open', 'not_converging'])

/** The entry an ask had at `turn`: its own, else the latest before it. */
function entryAt(s, turn) {
  return s.history.findLast((e) => e.turn <= turn) ?? s.history[0]
}

const seenOf = (entry) => entry.stamp + ' ' + entry.refused

function applyRuling(st, ruling) {
  const asks = listOf(ruling.asks).filter((n) => typeof n === 'string' && Object.hasOwn(st.asks, n))
  for (const name of asks) {
    const s = st.asks[name]
    if (isEnded(s)) continue
    const unit = ruling.missing ? undefined : listOf(ruling.units).find((u) => isObject(u) && u.unit === name && RULINGS.has(u.ruling))
    if (unit) {
      s.ruledAt.push(ruling.turn)
      s.rulerMisses = []
      if (s.end?.by === 'ruler') s.end = null
      s.due = false
      if (unit.ruling === 'open') {
        s.ruling = { turn: ruling.turn, why: textOf(unit.why) }
        s.seen.add(seenOf(entryAt(s, ruling.turn)))
      } else if (s.end === null) {
        s.end = unit.ruling === 'not_converging'
          ? { state: 'not_converging', turn: ruling.turn, label: 'ruled', why: textOf(unit.why) }
          : { state: 'done', answer: unit.ruling, turn: ruling.turn, label: 'ruled', why: textOf(unit.why) }
      }
    } else {
      s.rulerMisses.push(ruling.missing ? String(ruling.missing) : 'unruled')
      if (s.rulerMisses.length >= 2 && s.end === null) {
        s.end = { state: 'stopped', turn: ruling.turn, label: 'observed', why: 'ruling missed twice in a row: ' + s.rulerMisses.slice(-2).join(', '), by: 'ruler' }
        s.due = false
      }
    }
  }
}

// ------------------------------------------------------------------ the fold

const byText = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)

/** Pure. Counts files by parent directory ('.' for the top level): [{dir, n}] sorted by dir. */
export function fileGroups(keys) {
  const counts = new Map()
  for (const key of keys) counts.set(dirOf(key), (counts.get(dirOf(key)) ?? 0) + 1)
  return [...counts].sort(byText).map(([dir, n]) => ({ dir, n }))
}

/** The files ok calls covered, per parent directory: how many, and the distinct `tool what` strings that covered them. */
function coveredView(s) {
  const dirs = new Map()
  for (const [file, by] of s.coveredBy) {
    const dir = dirOf(file)
    const d = dirs.get(dir) ?? { files: 0, by: new Set() }
    d.files++
    for (const b of by) d.by.add(b)
    dirs.set(dir, d)
  }
  return Object.fromEntries([...dirs].sort(byText).map(([dir, d]) => [dir, { files: d.files, by: [...d.by].sort() }]))
}

/** A looked entry with the pages of its query: the pages it has and the distinct ones fetched under the ask. */
function lookedView(s, e) {
  const q = e.id === null ? undefined : s.queries.get(e.id)
  return { seq: e.seq, tool: e.tool, what: e.what, where: [...e.where], total: e.total, pages: q ? q.pages : 1, pages_seen: q ? q.fetched.size : 1 }
}

function view(st, folded, queries, refusals, ruled, turnsN, stalled) {
  const asks = {}
  for (const key of st.order) {
    const s = st.asks[key]
    asks[key] = {
      key, domain: s.domain, scope: [...s.scope], find: s.find, from: s.from,
      observed: [...s.observed].sort(),
      hits: s.hits.map((h) => ({ ...h })),
      // unopened: the files it closed that no read opened, before or after it
      dismissed: s.dismissed.map(({ files, ...d }) => ({ ...d, unopened: fileGroups(files.filter((key) => !s.touched.has(key))) })),
      leads: s.leads.map((l) => ({ ...l })),
      declared: s.declared,
      owes: s.owed.length > 0,
      agenda: agendaOf(s),
      covered: coveredView(s),
      looked: s.looked.map((e) => lookedView(s, e)),
      end: s.end ? { ...s.end } : null,
      ruling: s.ruling ? { ...s.ruling } : null,
      ruled_at: [...s.ruledAt],
      due: s.due,
      stamp: stampOf(s),
      refused: refusedOf(s),
      history: s.history.map((h) => ({ ...h })),
    }
  }
  return { asks, refusals, calls: folded, calls_n: folded.length, turns_n: turnsN, rulings: ruled, queries, stalled }
}

/**
 * Pure. Folds one search's facts into the ledger: each ask's observed lines, verified hits,
 * dismissals, leads, declaration, agenda, what it looked for and end. Turn records fold in array order; the same
 * facts give the same ledger.
 */
export function foldLedger({ asks, ground, calls, turns, rulings = [] }) {
  const st = { asks: {}, order: [] }
  for (const ask of listOf(asks)) {
    if (!isObject(ask) || typeof ask.key !== 'string' || Object.hasOwn(st.asks, ask.key)) continue
    st.asks[ask.key] = newState(ask, ground)
    st.order.push(ask.key)
  }

  const pending = listOf(calls).filter((c) => isObject(c) && Number.isInteger(c.seq)).sort((a, b) => a.seq - b.seq)
  const bySeq = new Map()
  const folded = []
  const queries = []
  const refusals = []
  const ruled = []
  const records = listOf(turns).map((t) => (isObject(t) ? t : {}))
  let next = 0
  let through = 0
  const returned = []
  let stalled = null
  let misses = []
  const rulingsAt = new Map()
  for (const ruling of listOf(rulings)) {
    if (isObject(ruling)) rulingsAt.set(ruling.turn, [...(rulingsAt.get(ruling.turn) ?? []), ruling])
  }

  for (const t of records) {
    through = Math.max(through, Number.isInteger(t.calls_through) ? t.calls_through : 0)
    while (next < pending.length && pending[next].seq <= through) {
      const call = pending[next++]
      if (bySeq.has(call.seq)) continue
      bySeq.set(call.seq, call)
      folded.push(call)
      if (call.ok === true && listOf(call.asks).length === 0) queries.push(call)
      foldCall(st, call, t.turn)
    }

    if (isObject(t.output)) {
      reopen(st)
      misses = []
      const verdict = verify(st.asks, bySeq, t.output, t.turn)
      for (const r of verdict.refusals) {
        refusals.push({ turn: t.turn, ...r })
        if (r.class !== 'unobserved') continue
        const id = refusalId(r.item)
        for (const name of r.asks) if (!st.asks[name].refused.has(id)) { st.asks[name].refused.add(id); digestMove(st.asks[name].refusedDigest, id, 1) }
      }
      apply(st, verdict.accepted, bySeq, t.turn)
      stalled = evaluate(st, t.turn, returned)
      returned.push(t.turn)
    } else if (t.stop) {
      stopOpen(st, t.turn, 'navigator', String(t.stop))
    } else {
      misses.push(t.missing ? String(t.missing) : 'no_output')
      if (misses.length >= 2) stopOpen(st, t.turn, 'navigator', 'no return twice in a row: ' + misses.slice(-2).join(', '))
    }

    // a ruling folds once, at the first record that carries its turn
    for (const ruling of rulingsAt.get(t.turn) ?? []) {
      applyRuling(st, ruling)
      ruled.push({ turn: ruling.turn, asks: listOf(ruling.asks).filter((n) => typeof n === 'string') })
    }
    rulingsAt.delete(t.turn)
  }

  return view(st, folded, queries, refusals, ruled, records.length, stalled)
}

// ------------------------------------------------------------------ reading the ledger

const stampAt = (history, turn) => {
  let at = history[0]
  for (const h of history) if (h.turn <= turn) at = h
  return at.stamp
}

/** Whether an ask's state moved since its previous check-in: the latest ruling before `turn` that ruled it, else its first entry. */
function movedSince(ledger, key, turn) {
  const history = ledger.asks[key].history
  const prior = ledger.asks[key].ruled_at.filter((t) => t < turn).at(-1)
  const before = prior !== undefined ? stampAt(history, prior) : history[0].stamp
  return stampAt(history, turn) !== before
}

/** Pure. Reports the endings the fold applied at `turn`, the asks the ruler is owed (those a stall made due, and at a check-in those that moved since their latest ruling), and the asks still open. */
export function stateOf(ledger, { turn, checkin }) {
  const keys = Object.keys(ledger.asks)
  const open = keys.filter((k) => ledger.asks[k].end === null)
  return {
    ending: keys
      .filter((k) => {
        const end = ledger.asks[k].end
        return end !== null && end.turn === turn && (end.state === 'done' || end.state === 'no_progress')
      })
      .map((k) => ({ ask: k, state: ledger.asks[k].end.state, label: ledger.asks[k].end.label, why: ledger.asks[k].end.why })),
    toRuler: open.filter((k) => ledger.asks[k].due || (checkin && movedSince(ledger, k, turn))),
    open,
  }
}

/**
 * Pure. The refusals still standing: every one except a hit the asks it named now hold. A standing
 * refusal is a citation the navigator made that no call showed, or an item that named no live ask.
 */
export function standingRefusals(ledger) {
  return ledger.refusals.filter((r) => {
    const cited = r.item.kind === 'hit' ? hitOf(r.item) : null
    return !(cited && r.asks.length > 0 && r.asks.every((n) => ledger.asks[n].hits.some((h) => h.key === cited.key && h.line === cited.line)))
  })
}

/** Pure. The distinct queries an ask looked up, as `tool what@where→total`, joined by '; '. */
export function lookedSummary(looked) {
  const parts = looked.map((e) => e.tool + ' ' + e.what + (e.where.length > 0 ? '@' + e.where.join(',') : '') + (e.total === null ? '' : '→' + e.total))
  return [...new Set(parts)].join('; ')
}

/** The lines a ruled done owes: what it looked at, what each directory of its scope rests on, the files dismissed unopened. */
function doneLines(a, at) {
  const lines = [at + ': ruled ' + a.end.answer + ': ' + a.end.why + ' — looked ' + lookedSummary(a.looked)]
  if (a.owes) for (const [dir, { files, by }] of Object.entries(a.covered)) lines.push(at + ': ' + dir + '/ (' + files + ' files) rests on ' + by.join(', '))
  for (const d of a.dismissed) for (const { dir, n } of d.unopened) lines.push(at + ': dismissed unopened: ' + n + ' under ' + dir + '/ (' + d.why + ')')
  return lines
}

/** Pure. The coverage lines a search owes: ruled ends and what they rest on, incomplete asks, what was never reached, failed channels. */
export function coverageLines(ledger, name) {
  const declared = []
  const incomplete = []
  const unreached = []
  const failed = []
  let rulerStopped = false
  for (const a of Object.values(ledger.asks)) {
    const at = name + ':' + a.key
    if (a.end?.state === 'done') declared.push(...doneLines(a, at))
    else incomplete.push(at + ': ' + (a.end ? a.end.state + ', ' + a.end.why : 'no end'))
    for (const f of a.agenda) if (f.kind !== 'file') unreached.push(at + ': ' + f.kind + ' ' + f.key + (f.detail ? ' (' + f.detail + ')' : ''))
    for (const { dir, n } of fileGroups(a.agenda.filter((f) => f.kind === 'file').map((f) => f.key))) unreached.push(at + ': files ' + dir + '/ (' + n + ' not covered)')
    if (a.looked.length === 0) unreached.push(at + ': no call ran under it')
    if (a.end?.state === 'stopped') {
      if (a.end.by === 'ruler') rulerStopped = true
      else failed.push(at)
    }
  }
  for (const r of standingRefusals(ledger)) {
    if (r.class !== 'unobserved') continue
    for (const ask of r.asks) unreached.push(name + ':' + ask + ': refused ' + r.item.kind + ' ' + refusedWhat(r.item) + ' (' + r.class + ': ' + REFUSAL_REASON[r.class] + ')')
  }
  if (rulerStopped) failed.push('converge:' + name)
  return { declared, incomplete, unreached, failed_channels: failed }
}
