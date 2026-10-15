// lib/search/ledger.mjs — one search's facts folded into each ask's state, with no I/O: what code
// observed (the calls the tool server journaled), what the navigator declared (its returns), what
// the ruler ruled (convergence), and the state each ask ends on. Nothing closed reopens; a
// declaration stands until the navigator changes it; every end is a state, an equality of states
// or a ruling, never a count.
//
// Design: docs/DESIGN.md#searches and docs/DESIGN.md#l2--states-end-work-counts-dont.

import { canonical, fnv1a } from '../plan-digest.mjs'

// ------------------------------------------------------------------ keys

const paramName = (part) => {
  const name = part.split('=')[0]
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}
const TRACKING = (part) => /^utm_/i.test(paramName(part)) || /^(gclid|fbclid)$/i.test(paramName(part))

/** Pure. A web key: scheme and host lowercased; default port, fragment, trailing '/' and tracking parameters dropped. */
export function canonicalUrl(url) {
  const raw = String(url ?? '').trim()
  let u
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  const query = u.search.replace(/^\?/, '').split('&').filter((part) => part !== '' && !TRACKING(part))
  const path = u.pathname.replace(/\/+$/, '')
  return u.protocol + '//' + u.host + path + (query.length ? '?' + query.join('&') : '')
}

/** Pure. A candidate's key: its canonical source URL, else its name lowercased, owner or @scope dropped, punctuation collapsed. */
export function candidateKey({ name = '', source_url = '' } = {}) {
  if (String(source_url).trim() !== '') return canonicalUrl(source_url)
  return String(name).trim().toLowerCase().replace(/^@?[^/\s]+\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

const posixKey = (p) => String(p).split('\\').join('/').replace(/^(\.\/)+/, '')

/** The key a path (a lead's, a dismissal's) names under an ask of `domain`. */
const keyOf = (domain, path) => {
  if (domain === 'web') return canonicalUrl(path)
  const key = posixKey(path).replace(/\/+$/, '')
  return key === '' ? '.' : key
}

// A git `:(glob)` pattern as a RegExp: `*` and `?` stay inside a segment, a `**` segment
// crosses directories, `[..]` is a class.
function globRegex(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      const atStart = i === 0 || glob[i - 1] === '/'
      if (atStart && glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; continue }
      if (atStart && i + 2 === glob.length) { re += '.*'; i += 1; continue }
      re += '[^/]*'; i += 1; continue
    }
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[' && glob.indexOf(']', i + 2) !== -1) {
      const end = glob.indexOf(']', i + 2)
      const body = glob.slice(i + 1, end)
      re += '[' + (body[0] === '!' ? '^' + body.slice(1) : body).replace(/\\/g, '\\\\') + ']'
      i = end
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$')
}

/** Whether `key` lies under the literal pathspec `p` ('.' is everything; a directory holds what is under it). */
const underLiteral = (key, p) => {
  const part = posixKey(p).replace(/\/+$/, '')
  return part === '' || part === '.' || key === part || key.startsWith(part + '/')
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

/** The open asks an item applies to, or the class it is refused for. */
function resolve(asks, item, turn) {
  const names = askNames(item)
  if (!names || names.some((n) => !Object.hasOwn(asks, n) || asks[n].from > turn)) return { refusal: 'unknown_ask' }
  const open = names.filter((n) => !isEnded(asks[n]))
  return open.length > 0 ? { open } : { refusal: 'names_only_ended_asks' }
}

/** A hit's key, its line, and the observation that must stand under one of its asks. */
function hitOf(item) {
  if (typeof item.commit === 'string' && item.commit !== '') return { key: item.commit, line: 0, seen: item.commit }
  if (typeof item.url === 'string' && item.url.trim() !== '') {
    const key = canonicalUrl(item.url)
    return { key, line: 0, seen: key }
  }
  if (typeof item.path === 'string' && item.path !== '' && Number.isInteger(item.line)) {
    const key = posixKey(item.path)
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
    if (r.refusal) { refuse('dismissed', raw, r.refusal); continue }
    const target = targetOf(raw, asks[r.open[0]].domain, bySeq)
    if (!target) { refuse('dismissed', raw, 'unobserved', r.open); continue }
    accepted.dismissed.push({ asks: r.open, ...target, why: textOf(raw.why) })
  }

  for (const raw of listOf(source.leads)) {
    const r = resolve(asks, raw, turn)
    if (r.refusal) { refuse('lead', raw, r.refusal); continue }
    if (typeof raw.path !== 'string' || raw.path.trim() === '') { refuse('lead', raw, 'unobserved', r.open); continue }
    for (const n of r.open) accepted.leads.push({ ask: n, key: keyOf(asks[n].domain, raw.path), why: textOf(raw.why) })
  }

  for (const raw of listOf(source.asks)) {
    const r = resolve(asks, raw, turn)
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

const sameScope = (paths, scope) => {
  const a = listOf(paths).map(String)
  if (a.length === 0) return true
  const b = [...scope].sort()
  return a.length === b.length && [...a].sort().every((p, i) => p === b[i])
}

function groundKeys(ground, askKey) {
  const keys = []
  for (const row of listOf(ground?.rows)) {
    if (!isObject(row) || !listOf(row.asks).includes(askKey)) continue
    const detail = row.kind + ' ' + row.mention
    if (row.kind === 'symbol') {
      for (const def of listOf(row.defs)) if (isObject(def) && typeof def.key === 'string') keys.push({ key: def.key, detail })
    } else if ((row.kind === 'path' || row.kind === 'doc' || row.kind === 'change') && row.exists && typeof row.key === 'string') {
      keys.push({ key: row.key, detail })
    }
  }
  return keys
}

const absenceOf = (s) => (s.declared !== 'absent' ? '' : s.zeroGrep ? 'checked' : 'declared')

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

/** An ask's stamp: its observed set, hits, dismissal targets, reads to the end, closed seeds and declaration. */
const stampOf = (s) => fnv1a(canonical({
  observed: s.observedDigest,
  hits: s.hitDigest,
  dismissed: s.targetDigest,
  read: s.readDigest,
  seeds: s.closedSeeds,
  declared: s.declared,
  absence: absenceOf(s),
}))

const entryOf = (turn, s) => ({ turn, stamp: stampOf(s), observed_n: s.observed.size, hits_n: s.hits.length })

/** Appends an entry to an ask's history; `firstAt` finds the earliest entry with a stamp. */
function record(s, entry) {
  s.history.push(entry)
  if (!s.firstAt.has(entry.stamp)) s.firstAt.set(entry.stamp, entry)
}

function newState(ask, ground) {
  const from = Number.isInteger(ask.from) ? ask.from : 1
  const seeds = listOf(ask.seeds).filter((x) => isObject(x) && typeof x.key === 'string')
  const s = {
    key: ask.key, domain: ask.domain, scope: listOf(ask.scope).map(String), find: ask.find, from,
    seeds, closedSeeds: seeds.filter((x) => x.as === 'closed').map((x) => x.key).sort(),
    ground: ask.domain === 'repo' ? groundKeys(ground, ask.key) : [],
    observed: new Set(), reads: new Map(), touched: new Set(), queries: new Map(), zeroGrep: false,
    hits: [], dismissed: [], targets: new Set(), covers: [], dismissedQueries: new Set(),
    leads: [], declared: '', end: null, rulerMisses: [], history: [], firstAt: new Map(), refused: new Set(),
    observedDigest: newDigest(), hitDigest: newDigest(), targetDigest: newDigest(), readDigest: newDigest(), readDone: new Set(),
  }
  record(s, entryOf(from - 1, s))
  return s
}

const covered = (s, key) => s.covers.some((cover) => cover(key))
const closedKey = (s, key) => s.hits.some((h) => h.key === key) || covered(s, key) || readToEnd(s, key)

/** Pure. An ask's frontier: open seeds, unread leads, own ground rows not closed, grep pages not fetched. */
function frontierOf(s) {
  const items = []
  const seen = new Set(s.seeds.filter((x) => x.as === 'closed').map((x) => x.key))
  const add = (kind, key, detail, closed) => {
    if (seen.has(key) || closed) return
    seen.add(key)
    items.push({ kind, key, detail })
  }
  for (const x of s.seeds) if (x.as === 'open') add('seed', x.key, textOf(x.reason), closedKey(s, x.key))
  for (const l of s.leads) add('lead', l.key, l.why, s.touched.has(l.key) || covered(s, l.key))
  for (const g of s.ground) add('ground', g.key, g.detail, closedKey(s, g.key))
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
  for (const key of keys) see(s, key)

  if (READING.has(call.tool)) for (const key of keys) s.touched.add(key)
  if (isObject(call.ended) && typeof call.ended.key === 'string') {
    const { key, total_lines: total } = call.ended
    const lines = listOf(call.observed).filter((o) => isObject(o) && o.key === key && Number.isInteger(o.line)).map((o) => o.line)
    noteRead(s, key, [...new Set(lines)], total)
  }

  if (Number.isInteger(call.pages)) {
    const id = queryId(call)
    const q = s.queries.get(id) ?? { first: call.seq, pages: 0, fetched: new Set() }
    q.pages = Math.max(q.pages, call.pages)
    q.fetched.add(call.page ?? call.args?.page ?? 1)
    s.queries.set(id, q)
  }
  if (call.tool === 'grep' && call.total === 0 && sameScope(call.args?.paths, s.scope)) s.zeroGrep = true
}

/** Folds `call` into every ask it names that is open at `turn`; returns the asks it worked. */
function foldCall(st, call, turn) {
  const worked = []
  for (const name of listOf(call.asks)) {
    const s = Object.hasOwn(st.asks, name) ? st.asks[name] : undefined
    if (!s || s.from > turn || isEnded(s)) continue
    worked.push(name)
    if (call.ok === true) absorb(s, call)
  }
  return worked
}

// ------------------------------------------------------------------ applying a return

// A repo path names a directory's worth of keys; a web path names its one URL.
function coverOf(target, domain, bySeq) {
  if (target.key !== undefined) return domain === 'web' ? (key) => key === target.key : (key) => underLiteral(key, target.key)
  if (target.glob !== undefined) {
    const re = globRegex(target.glob)
    return (key) => re.test(key)
  }
  const call = bySeq.get(target.call)
  const keys = new Set([...listOf(call.keys), ...listOf(call.observed).map((o) => o?.key)])
  return (key) => keys.has(key)
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
      digestMove(s.targetDigest, target, 1)
      s.dismissed.push({ ...aim, why, turn, read_to_end: d.key !== undefined && readToEnd(s, d.key) })
      s.covers.push(coverOf(d, s.domain, bySeq))
      if (d.call !== undefined) s.dismissedQueries.add(queryId(bySeq.get(d.call)))
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
  names_only_ended_asks: 'every ask it names has ended',
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

/** After a returned turn: ends the open asks that are done, or that the turn worked and left where an earlier return did.
 *  An ask in `unseen` was refused an item the navigator has not yet been shown, so it does not end on this return. */
function evaluate(st, turn, worked, unseen) {
  for (const key of st.order) {
    const s = st.asks[key]
    if (s.from > turn || s.end !== null) continue
    const entry = entryOf(turn, s)
    const earlier = s.firstAt.get(entry.stamp)
    record(s, entry)
    if (unseen.has(key)) continue
    if ((s.declared === 'answered' || s.declared === 'absent') && frontierOf(s).length === 0) {
      const observed = s.declared === 'absent' && absenceOf(s) === 'checked' && s.dismissed.every((d) => d.read_to_end)
      s.end = { state: 'done', turn, label: observed ? 'observed' : 'declared', why: 'declared ' + s.declared + ', with nothing left on its frontier' }
    } else if ((worked.size === 0 || worked.has(key)) && earlier) {
      s.end = { state: 'no_progress', turn, label: 'observed', why: 'its state equals the one after turn ' + earlier.turn }
    }
  }
}

function applyRuling(st, ruling) {
  const asks = listOf(ruling.asks).filter((n) => typeof n === 'string' && Object.hasOwn(st.asks, n))
  for (const name of asks) {
    const s = st.asks[name]
    if (isEnded(s)) continue
    const unit = ruling.missing ? undefined : listOf(ruling.units).find((u) => isObject(u) && u.unit === name)
    if (unit) {
      s.rulerMisses = []
      if (s.end?.by === 'ruler') s.end = null
      if (unit.ruling === 'not_converging' && s.end === null) s.end = { state: 'not_converging', turn: ruling.turn, label: 'ruled', why: textOf(unit.why) }
    } else {
      s.rulerMisses.push(ruling.missing ? String(ruling.missing) : 'unruled')
      if (s.rulerMisses.length >= 2 && s.end === null) {
        s.end = { state: 'stopped', turn: ruling.turn, label: 'observed', why: 'ruling missed twice in a row: ' + s.rulerMisses.slice(-2).join(', '), by: 'ruler' }
      }
    }
  }
}

// ------------------------------------------------------------------ the fold

function view(st, folded, refusals, ruled, turnsN) {
  const asks = {}
  for (const key of st.order) {
    const s = st.asks[key]
    asks[key] = {
      key, domain: s.domain, scope: [...s.scope], find: s.find, from: s.from,
      observed: [...s.observed].sort(),
      hits: s.hits.map((h) => ({ ...h })),
      dismissed: s.dismissed.map((d) => ({ ...d })),
      leads: s.leads.map((l) => ({ ...l })),
      declared: s.declared, absence: absenceOf(s),
      frontier: frontierOf(s),
      end: s.end ? { ...s.end } : null,
      stamp: stampOf(s),
      history: s.history.map((h) => ({ ...h })),
    }
  }
  return { asks, refusals, calls: folded, calls_n: folded.length, turns_n: turnsN, rulings: ruled }
}

/**
 * Pure. Folds one search's facts into the ledger: each ask's observed lines, verified hits,
 * dismissals, leads, declaration, frontier and end. Turn records fold in array order; the same
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
  const refusals = []
  const ruled = []
  const records = listOf(turns).map((t) => (isObject(t) ? t : {}))
  let next = 0
  let through = 0
  let worked = new Set()
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
      for (const name of foldCall(st, call, t.turn)) worked.add(name)
    }

    if (isObject(t.output)) {
      reopen(st)
      misses = []
      const items = [...listOf(t.output.hits), ...listOf(t.output.dismissed), ...listOf(t.output.leads), ...listOf(t.output.asks)]
      // an item works every open ask it names, accepted or refused (D20); one naming only ended asks names no open ask
      for (const raw of items) for (const name of askNames(raw) ?? []) if (Object.hasOwn(st.asks, name) && !isEnded(st.asks[name])) worked.add(name)
      const verdict = verify(st.asks, bySeq, t.output, t.turn)
      const unseen = new Set()
      for (const r of verdict.refusals) {
        refusals.push({ turn: t.turn, ...r })
        if (r.class !== 'unobserved') continue
        const id = refusalId(r.item)
        for (const name of r.asks) if (!st.asks[name].refused.has(id)) { st.asks[name].refused.add(id); unseen.add(name) }
      }
      apply(st, verdict.accepted, bySeq, t.turn)
      evaluate(st, t.turn, worked, unseen)
      worked = new Set()
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

  return view(st, folded, refusals, ruled, records.length)
}

// ------------------------------------------------------------------ reading the ledger

const stampAt = (history, turn) => {
  let at = history[0]
  for (const h of history) if (h.turn <= turn) at = h
  return at.stamp
}

/** Whether an ask's state moved since its previous check-in: the latest ruling naming it before `turn`, else its first entry. */
function movedSince(ledger, key, turn) {
  const history = ledger.asks[key].history
  const prior = listOf(ledger.rulings).filter((r) => r.turn < turn && r.asks.includes(key)).at(-1)
  const before = prior ? stampAt(history, prior.turn) : history[0].stamp
  return stampAt(history, turn) !== before
}

/** Pure. Reports the endings the fold applied at `turn`, the asks a check-in sends to the ruler, and the asks still open. */
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
    toRuler: checkin ? open.filter((k) => movedSince(ledger, k, turn)) : [],
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

/** Pure. The coverage lines a search owes: declared ends, incomplete asks, what was never reached, failed channels. */
export function coverageLines(ledger, name) {
  const declared = []
  const incomplete = []
  const unreached = []
  const failed = []
  let rulerStopped = false
  for (const a of Object.values(ledger.asks)) {
    const at = name + ':' + a.key
    if (a.end?.state === 'done' && a.end.label === 'declared') declared.push(at + ': declared ' + a.declared)
    if (a.end?.state !== 'done') incomplete.push(at + ': ' + (a.end ? a.end.state + ', ' + a.end.why : 'no end'))
    for (const f of a.frontier) unreached.push(at + ': ' + f.kind + ' ' + f.key + (f.detail ? ' (' + f.detail + ')' : ''))
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
