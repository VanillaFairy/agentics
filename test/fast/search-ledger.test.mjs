// test/fast/search-ledger.test.mjs — the search ledger: one search's facts (the calls code ran,
// the navigator's returns, the ruler's rulings) folded into each ask's state, and the state each
// ask ends on. Every fact keeps its source: code observed it, the navigator declared it, the ruler
// ruled it.
//
// Design: docs/DESIGN.md#searches and docs/DESIGN.md#l2--states-end-work-counts-dont.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { candidateKey, canonicalUrl, coverageLines, foldLedger, standingRefusals, stateOf, verifyReturn } from '../../lib/search/ledger.mjs'

// ------------------------------------------------------------------ builders

const NONE = { rows: [], seeds: [] }
/** An ask that holds its material as a closed seed, so its scope is no agenda of its own; `bare` builds one that has nothing. */
const ask = (key, extra = {}) => ({ key, find: 'what ' + key + ' asks', scope: ['.'], domain: 'repo', seeds: [{ key: 'MATERIAL.md', as: 'closed', reason: 'the material' }], ...extra })
const bare = (key, extra = {}) => ask(key, { seeds: [], ...extra })

/** A grep call under `asks` that showed `lines`, each [key, line]. */
function grep(seq, asks, lines, { pattern = 'p' + seq, paths = [], page = 1, pages = 1, total = lines.length } = {}) {
  return {
    seq, tool: 'grep', args: { pattern, fixed: false, ignore_case: false, paths, page }, asks, ok: true,
    total, page, pages, observed: lines.map(([key, line]) => ({ key, line })), keys: [...new Set(lines.map(([key]) => key))],
  }
}
/** A read call under `asks` that showed lines from..to of a file of total_lines lines. */
function read(seq, asks, key, from, to, total_lines) {
  const observed = []
  for (let line = from; line <= to; line++) observed.push({ key, line })
  return { seq, tool: 'read', args: { path: key, from, to }, asks, ok: true, observed, keys: [key], ended: { key, to, total_lines } }
}
/** A files call under `asks` that listed `keys` and showed no line. */
const listed = (seq, asks, keys) => ({
  seq, tool: 'files', args: { glob: '**', page: 1 }, asks, ok: true, total: keys.length, page: 1, pages: 1, observed: [], keys,
})
/** A call that shows `asks` a line nothing showed before, so their state moves. */
const move = (seq, asks) => grep(seq, [].concat(asks), [['moved/' + seq + '.js', 1]])

const out = (o = {}) => ({ hits: [], dismissed: [], leads: [], asks: [], ...o })
const ret = (turn, calls_through, o = {}) => ({ turn, calls_through, output: out(o) })
const lost = (turn, calls_through, missing = 'schema_failed') => ({ turn, calls_through, missing })
const hit = (asks, path, line, note = 'it is here') => ({ ask: [].concat(asks), path, line, note })
const dismiss = (asks, target, why = 'not about this ask') => ({ ask: [].concat(asks), ...target, why })
const declare = (a, declared) => ({ ask: a, declared })
const unit = (u, ruling, why = 'the ruler says so') => ({ unit: u, ruling, why })

/** A ground row the material of `asks` named (ask 'a' unless said). */
const pathRow = (key, exists = true, asks = ['a']) => ({ kind: 'path', mention: key, key, exists, asks, defs: [], refs: [], files: 0 })
const symbolRow = (mention, defs, asks = ['a']) => ({
  kind: 'symbol', mention, key: mention, exists: defs.length > 0, asks, defs: defs.map(([key, line]) => ({ key, line })), refs: [], files: 0,
})
const ground = (...rows) => ({ rows, seeds: [] })

const fold = ({ asks = [ask('a')], ground: g = NONE, calls = [], turns = [], rulings = [] } = {}) =>
  foldLedger({ asks, ground: g, calls, turns, rulings })
const agendaOf = (l, a) => {
  assert.ok(Array.isArray(l.asks[a].agenda), 'ask ' + a + ' has an agenda')
  return l.asks[a].agenda
}
const front = (l, a) => agendaOf(l, a).map((f) => f.kind + ' ' + f.key)
const classes = (l) => l.refusals.map((r) => r.class)
const hitsOf = (l, a) => l.asks[a].hits.map((h) => h.key + ':' + h.line)
const SHA = 'a'.repeat(40)
const NAME = 'probe:locate'

// ------------------------------------------------------------------ keys

test('canonicalUrl lowercases the scheme and the host and keeps the path as written', () => {
  assert.equal(canonicalUrl('HTTPS://GitHub.COM/PMNDRS/Zustand'), 'https://github.com/PMNDRS/Zustand')
})

test('canonicalUrl drops the default port, the fragment and a trailing slash', () => {
  assert.equal(canonicalUrl('https://example.com:443/docs/#intro'), 'https://example.com/docs')
  assert.equal(canonicalUrl('http://example.com:80/a/'), 'http://example.com/a')
  assert.notEqual(canonicalUrl('http://example.com:8080/a'), canonicalUrl('http://example.com/a'), 'a port that is not the default stays')
})

test('canonicalUrl drops utm_*, gclid and fbclid and keeps every other query parameter in order', () => {
  assert.equal(canonicalUrl('https://x.io/p?b=2&utm_source=news&a=1&gclid=z&fbclid=y&utm_medium=m'), 'https://x.io/p?b=2&a=1')
  assert.equal(canonicalUrl('https://x.io/p?utm_source=news'), 'https://x.io/p')
})

test('canonicalUrl is idempotent and never throws on text that is not a URL', () => {
  for (const u of ['https://Example.com/a/?utm_x=1#f', 'not a url', '', 'ftp://host/x']) {
    const once = canonicalUrl(u)
    assert.equal(typeof once, 'string', u)
    assert.equal(canonicalUrl(once), once, u)
  }
})

test('candidateKey makes "zustand", "Zustand" and "pmndrs/zustand" one key', () => {
  const k = candidateKey({ name: 'zustand' })
  assert.equal(candidateKey({ name: 'Zustand' }), k)
  assert.equal(candidateKey({ name: 'pmndrs/zustand' }), k)
  assert.notEqual(candidateKey({ name: 'jotai' }), k)
})

test('candidateKey drops an @scope/ prefix and collapses punctuation', () => {
  const k = candidateKey({ name: 'react-query' })
  assert.equal(candidateKey({ name: '@tanstack/react-query' }), k)
  assert.equal(candidateKey({ name: 'React_Query' }), k)
  assert.equal(candidateKey({ name: 'react..query' }), k)
})

test('candidateKey is the canonical source URL when one is given', () => {
  assert.equal(candidateKey({ name: 'Zustand', source_url: 'https://GitHub.com/pmndrs/zustand/' }), canonicalUrl('https://github.com/pmndrs/zustand'))
})

// ------------------------------------------------------------------ folding calls

test('a call folds into the observed state of every ask it names, and of no other', () => {
  const l = fold({ asks: [ask('a'), ask('b'), ask('c')], calls: [grep(1, ['a', 'b'], [['src/x.js', 3]])], turns: [ret(1, 1)] })
  // the observed set holds both forms; the rules fix no array order for it
  assert.deepEqual([...l.asks.a.observed].sort(), ['src/x.js', 'src/x.js:3'])
  assert.deepEqual([...l.asks.b.observed].sort(), ['src/x.js', 'src/x.js:3'])
  assert.deepEqual(l.asks.c.observed, [])
})

test("calls_n and turns_n count what was folded, and a call past the latest turn's calls_through is not folded", () => {
  const l = fold({ calls: [grep(1, ['a'], [['a.js', 1]]), grep(2, ['a'], [['b.js', 2]])], turns: [ret(1, 1)] })
  assert.equal(l.asks.a.observed.includes('b.js:2'), false)
  assert.equal(l.calls_n, 1)
  assert.equal(l.turns_n, 1)
  assert.deepEqual(l.calls.map((c) => c.seq), [1])
})

test('a refused call adds nothing to any ask', () => {
  const refused = { ...grep(1, ['a'], [['a.js', 1]]), ok: false, refusal: 'unsupported_syntax', detail: '\\b' }
  assert.deepEqual(fold({ calls: [refused], turns: [ret(1, 1)] }).asks.a.observed, [])
})

test("a repeat call adds the original call's lines to the asks it names, and moves nothing for an ask that had them", () => {
  const first = grep(1, ['a'], [['src/a.js', 4]], { pattern: 'same' })
  const again = { ...first, seq: 2, asks: ['a', 'b'], repeat_of: 1 }   // the server copies the first call's observations
  const l = fold({ asks: [ask('a'), ask('b')], calls: [first, again], turns: [ret(1, 1), ret(2, 2)] })
  assert.ok(l.asks.b.observed.includes('src/a.js:4'), "the repeat shows b the original's lines")
  const [b1, b2] = l.asks.b.history.slice(-2).map((h) => h.stamp)
  const [a1, a2] = l.asks.a.history.slice(-2).map((h) => h.stamp)
  assert.notEqual(b2, b1, 'b moved at turn 2')
  assert.equal(a2, a1, 'a already had them')
})

test("a missing turn's calls are folded and the missing turn ends nothing; the next return counts them", () => {
  const calls = [grep(1, ['a'], [['a.js', 1]])]
  const l = fold({ calls, turns: [lost(1, 1)] })
  assert.ok(l.asks.a.observed.includes('a.js:1'))
  assert.equal(l.asks.a.end, null)
  assert.deepEqual(stateOf(l, { turn: 1, checkin: false }).ending, [])
  const next = fold({ calls, turns: [lost(1, 1), ret(2, 1, { leads: [{ ask: 'a', path: 'a.js', why: 'read it next' }] })] })
  assert.equal(next.asks.a.end, null, "the missing turn's call moved a since the last return")
})

// ------------------------------------------------------------------ fold order and purity

test('within one return, hits apply before dismissals: dismissing a key hit in the same return leaves the hit', () => {
  const l = fold({
    calls: [grep(1, ['a'], [['src/a.js', 7]])],
    turns: [ret(1, 1, { hits: [hit('a', 'src/a.js', 7)], dismissed: [dismiss('a', { path: 'src/a.js' })] })],
  })
  assert.deepEqual(hitsOf(l, 'a'), ['src/a.js:7'])
})

test('within one return, hits apply before declarations: absent beside a hit on the same ask is refused contradicts_hit', () => {
  const l = fold({
    calls: [grep(1, ['a'], [['src/a.js', 7]])],
    turns: [ret(1, 1, { hits: [hit('a', 'src/a.js', 7)], asks: [declare('a', 'absent')] })],
  })
  assert.equal(l.asks.a.declared, '')
  assert.deepEqual(l.refusals.map((r) => [r.turn, r.class, r.item.kind]), [[1, 'contradicts_hit', 'ask']])
})

test('folding the same facts twice gives the same ledger, as a relaunch does, and no input is changed', () => {
  const x = {
    asks: [ask('a'), ask('b')], ground: ground(pathRow('src/a.js')), rulings: [],
    calls: [grep(1, ['a'], [['src/a.js', 2]]), read(2, ['b'], 'src/a.js', 1, 5, 5)],
    turns: [ret(1, 2, { hits: [hit('a', 'src/a.js', 2)], leads: [{ ask: 'b', path: 'src/c.js', why: 'imports it' }] }), lost(2, 2), ret(3, 2)],
  }
  const frozen = JSON.stringify(x)
  assert.deepEqual(foldLedger(x), foldLedger(structuredClone(x)))
  assert.equal(JSON.stringify(x), frozen)
})

// ------------------------------------------------------------------ verification

test('a hit on a line a call of one of its asks returned is accepted', () => {
  const l = fold({ calls: [grep(1, ['a'], [['src/a.js', 7]])], turns: [ret(1, 1, { hits: [hit('a', 'src/a.js', 7, 'defines it')] })] })
  assert.deepEqual(l.asks.a.hits.map(({ key, line, note, turn }) => ({ key, line, note, turn })), [{ key: 'src/a.js', line: 7, note: 'defines it', turn: 1 }])
  assert.deepEqual(l.refusals, [])
})

test('a hit on a line no call returned is refused unobserved and is in no hits list', () => {
  const l = fold({ calls: [grep(1, ['a'], [['src/a.js', 7]])], turns: [ret(1, 1, { hits: [hit('a', 'src/a.js', 8)] })] })
  assert.deepEqual(hitsOf(l, 'a'), [])
  assert.deepEqual(l.refusals.map((r) => [r.turn, r.class, r.item.kind, r.item.path, r.item.line]), [[1, 'unobserved', 'hit', 'src/a.js', 8]])
})

test('a hit at line 1 of a file a call only listed, or named past the page it showed, is refused unobserved', () => {
  const paged = { ...grep(2, ['a'], [['src/a.js', 3]], { pages: 2, total: 400 }), keys: ['src/a.js', 'src/b.js'] }
  const l = fold({
    calls: [listed(1, ['a'], ['CLAUDE.md']), paged],
    turns: [ret(1, 2, { hits: [hit('a', 'CLAUDE.md', 1, 'the guidance'), hit('a', 'src/b.js', 1)] })],
  })
  assert.deepEqual(hitsOf(l, 'a'), [])
  assert.deepEqual(classes(l), ['unobserved', 'unobserved'])
})

test('a hit on a line observed only under another ask is refused unobserved', () => {
  const l = fold({ asks: [ask('a'), ask('b')], calls: [grep(1, ['b'], [['src/x.js', 2]])], turns: [ret(1, 1, { hits: [hit('a', 'src/x.js', 2)] })] })
  assert.deepEqual(hitsOf(l, 'a'), [])
  assert.deepEqual(classes(l), ['unobserved'])
})

test('a hit naming two asks is accepted when one of them observed the line, and applies to both', () => {
  const l = fold({ asks: [ask('a'), ask('b')], calls: [grep(1, ['b'], [['src/x.js', 2]])], turns: [ret(1, 1, { hits: [hit(['a', 'b'], 'src/x.js', 2)] })] })
  assert.deepEqual(hitsOf(l, 'a'), ['src/x.js:2'])
  assert.deepEqual(hitsOf(l, 'b'), ['src/x.js:2'])
})

test('an item naming an ask the search does not have, or none, is refused unknown_ask', () => {
  const l = fold({
    calls: [grep(1, ['a'], [['src/a.js', 1]])],
    turns: [ret(1, 1, {
      hits: [hit('zzz', 'src/a.js', 1), hit(['a', 'zzz'], 'src/a.js', 1)],
      leads: [{ ask: 'zzz', path: 'src/b.js', why: 'w' }],
      asks: [declare('zzz', 'answered'), { declared: 'answered' }],
    })],
  })
  assert.deepEqual(classes(l), ['unknown_ask', 'unknown_ask', 'unknown_ask', 'unknown_ask', 'unknown_ask'])
  assert.deepEqual(hitsOf(l, 'a'), [])
})

test('a history hit is accepted only on a full sha a call under its ask returned', () => {
  const logCall = { seq: 1, tool: 'log', args: { mode: 'G', pattern: 'seatDay', paths: [], page: 1 }, asks: ['h'], ok: true, total: 1, page: 1, pages: 1, observed: [], keys: [SHA] }
  const l = fold({
    asks: [ask('h', { domain: 'history' })], calls: [logCall],
    turns: [ret(1, 1, { hits: [{ ask: ['h'], commit: SHA, note: 'adds seatDay' }, { ask: ['h'], commit: 'b'.repeat(40), note: 'x' }, { ask: ['h'], commit: SHA.slice(0, 7), note: 'short' }] })],
  })
  assert.deepEqual(l.asks.h.hits.map((h) => h.key), [SHA])
  assert.deepEqual(classes(l), ['unobserved', 'unobserved'])
})

test('a web hit is accepted only on a url a fetch under its ask returned, compared by canonicalUrl', () => {
  const key = canonicalUrl('https://github.com/pmndrs/zustand')
  const fetched = { seq: 1, tool: 'fetch', args: { url: 'https://github.com/pmndrs/zustand' }, asks: ['w'], ok: true, observed: [], keys: [key] }
  const candidate = { name: 'Zustand', source_url: 'https://github.com/pmndrs/zustand', what_it_is: 'a store', latest_version: '5.0.0', license: 'MIT', maintenance: 'active', covers: 'state', does_not_cover: 'sync' }
  const l = fold({
    asks: [ask('w', { domain: 'web', scope: [] })], calls: [fetched],
    turns: [ret(1, 1, { hits: [
      { ask: ['w'], url: 'https://GitHub.com/pmndrs/zustand/#readme', note: 'the library', candidate },
      { ask: ['w'], url: 'https://www.npmjs.com/package/zustand', note: 'seen in a search result only' },
    ] })],
  })
  assert.deepEqual(l.asks.w.hits.map((h) => h.key), [key])
  assert.equal(l.asks.w.hits[0].candidate.key, candidateKey(candidate))
  assert.deepEqual(classes(l), ['unobserved'])
})

test('a hit path written with backslashes or a leading ./ is the same key', () => {
  const l = fold({
    calls: [grep(1, ['a'], [['src/core/a.ts', 5]])],
    turns: [ret(1, 1, { hits: [hit('a', 'src\\core\\a.ts', 5), hit('a', './src/core/a.ts', 5)] })],
  })
  assert.deepEqual(hitsOf(l, 'a'), ['src/core/a.ts:5'])
  assert.deepEqual(l.refusals, [])
})

test('a re-reported hit in new words adds nothing: the first note stands and the stamp does not move', () => {
  const l = fold({
    calls: [grep(1, ['a'], [['src/a.js', 7]])],
    turns: [ret(1, 1, { hits: [hit('a', 'src/a.js', 7, 'first')] }), ret(2, 1, { hits: [hit('a', 'src/a.js', 7, 'the same, reworded')] })],
  })
  assert.deepEqual(l.asks.a.hits.map((h) => h.note), ['first'])
  const [one, two] = l.asks.a.history.slice(-2).map((h) => h.stamp)
  assert.equal(two, one)
})

test('a malformed item is refused, and a turn with neither output nor missing counts as missing', () => {
  const l = fold({ turns: [ret(1, 0, { hits: [{ ask: ['a'], note: 'no path' }, { ask: ['a'], path: 'src/a.js', line: 'seven', note: 'x' }, 'junk', null] })] })
  assert.deepEqual(classes(l), ['unobserved', 'unobserved', 'unknown_ask', 'unknown_ask'])
  const empty = fold({ calls: [move(1, 'a')], turns: [ret(1, 1), { turn: 2, calls_through: 1 }, { turn: 3, calls_through: 1 }] })
  assert.equal(empty.asks.a.end.state, 'stopped')
})

test('verifyReturn sorts a return into accepted items and refusals, against the ledger before it', () => {
  const calls = [grep(1, ['a'], [['src/a.js', 3]])]
  const l = fold({ calls, turns: [ret(1, 1)] })
  const frozen = JSON.stringify(l)
  const v = verifyReturn(l, calls, out({
    hits: [hit('a', 'src/a.js', 3), hit('a', 'src/a.js', 4)],
    leads: [{ ask: 'a', path: 'src/b.js', why: 'imports a' }],
    asks: [declare('a', 'answered')],
  }))
  assert.deepEqual(v.accepted.hits.map((h) => [h.asks, h.key, h.line]), [[['a'], 'src/a.js', 3]])
  assert.deepEqual(v.accepted.leads.map((x) => [x.ask, x.key]), [['a', 'src/b.js']])
  assert.deepEqual(v.accepted.asks, [{ ask: 'a', declared: 'answered' }])
  assert.deepEqual(v.refusals.map((r) => r.class), ['unobserved'])
  assert.equal(JSON.stringify(l), frozen, 'the ledger is not changed')
})

// ------------------------------------------------------------------ agenda

test("a lead is on its ask's agenda until a read of it under that ask, or a dismissal", () => {
  const x = { asks: [ask('a'), ask('b')], calls: [move(1, 'a')], turns: [ret(1, 1, { leads: [{ ask: 'a', path: 'src/lead.js', why: 'imports the store' }] })] }
  assert.deepEqual(front(fold(x), 'a'), ['lead src/lead.js'])
  const byB = fold({ ...x, calls: [...x.calls, read(2, ['b'], 'src/lead.js', 1, 3, 40)], turns: [...x.turns, ret(2, 2)] })
  assert.deepEqual(front(byB, 'a'), ['lead src/lead.js'], 'a read under b does not read it for a')
  const byA = fold({ ...x, calls: [...x.calls, read(2, ['a'], 'src/lead.js', 1, 3, 40)], turns: [...x.turns, ret(2, 2)] })
  assert.deepEqual(front(byA, 'a'), [], 'a partial read is a read of a lead')
  const dropped = fold({ ...x, turns: [...x.turns, ret(2, 1, { dismissed: [dismiss('a', { path: 'src/lead.js' })] })] })
  assert.deepEqual(front(dropped, 'a'), [])
})

test('unfetched overflow pages are agenda, one per page, until fetched under the ask or their call is dismissed', () => {
  const big = (seq, a, page) => grep(seq, [a], [['src/p' + page + '.js', 1]], { pattern: 'big', page, pages: 3, total: 600 })
  const calls = [big(1, 'a', 1), big(2, 'a', 2), big(3, 'b', 3)]
  const l = fold({ asks: [ask('a'), ask('b')], calls, turns: [ret(1, 3)] })
  assert.deepEqual(l.asks.a.agenda.map((f) => [f.kind, f.key, f.detail]), [['overflow', 'call:1', 'page 3 of 3']])
  assert.deepEqual(l.asks.b.agenda.map((f) => [f.kind, f.key, f.detail]), [['overflow', 'call:3', 'page 1 of 3'], ['overflow', 'call:3', 'page 2 of 3']])
  const d = fold({ asks: [ask('a'), ask('b')], calls, turns: [ret(1, 3, { dismissed: [dismiss('a', { call: 2 })] })] })
  assert.deepEqual(d.asks.a.agenda, [], 'any call of the query closes its pages')
})

const GROUND = ground(
  pathRow('src/drop/stall.ts', true, ['s', 'all']), pathRow('src/drop/new.ts', false, ['s']),
  symbolRow('ITEM_STAND', [['src/data/items.ts', 12], ['src/data/items.ts', 40]], ['s', 'all']),
  pathRow('docs/kb/MODULE_MAP.md', true, ['all']),
  pathRow('docs/context.md', true, []),
  pathRow('src/elsewhere.ts', true, ['h', 'w']),
)

test("a repo ask's own ground rows are its agenda: a path's key, a symbol's definition files", () => {
  const l = fold({ asks: [ask('s', { scope: ['src'] }), ask('all')], ground: GROUND })
  assert.deepEqual(front(l, 's'), ['ground src/drop/stall.ts', 'ground src/data/items.ts'])
  assert.deepEqual(front(l, 'all'), ['ground src/drop/stall.ts', 'ground src/data/items.ts', 'ground docs/kb/MODULE_MAP.md'])
})

test("another ask's row, a row only context material named, a missing path, and every row of a history or web ask stay off the agenda", () => {
  const l = fold({ asks: [ask('s'), ask('x'), ask('h', { domain: 'history' }), ask('w', { domain: 'web', scope: [] })], ground: GROUND })
  assert.deepEqual(front(l, 's'), ['ground src/drop/stall.ts', 'ground src/data/items.ts'])
  assert.deepEqual(front(l, 'x'), [])
  assert.deepEqual(front(l, 'h'), [])
  assert.deepEqual(front(l, 'w'), [])
})

/** A symbol row whose references the resolver found in `files`. */
const referenced = (mention, defs, files, asks = ['a']) => ({ ...symbolRow(mention, defs, asks), refs: files.map((key) => ({ key, count: 1, test: false })), files: files.length })
const refsCall = (seq, asks, symbol, files) => ({ seq, tool: 'refs', args: { symbol }, asks, ok: true, total: files.length, observed: [], keys: files })

test('a symbol the material names with reference sites is one agenda item until a refs call of it under the ask', () => {
  const g = ground(referenced('composeArea', [['src/area.ts', 3]], ['src/meadow.ts', 'src/install.ts'], ['a', 'b']))
  const before = fold({ asks: [ask('a'), ask('b')], ground: g })
  assert.deepEqual(front(before, 'a'), ['ground src/area.ts', 'symbol symbol:composeArea'])
  const after = fold({ asks: [ask('a'), ask('b')], ground: g, calls: [refsCall(1, ['a'], 'composeArea', ['src/meadow.ts', 'src/install.ts'])], turns: [ret(1, 1)] })
  assert.deepEqual(front(after, 'a'), ['ground src/area.ts'])
  assert.deepEqual(front(after, 'b'), ['ground src/area.ts', 'symbol symbol:composeArea'], 'the call named a only')
})

test("a grep whose pattern names the symbol closes its item; one naming another symbol does not", () => {
  const g = ground(referenced('composeArea', [], ['src/meadow.ts']))
  const by = (pattern) => fold({ ground: g, calls: [grep(1, ['a'], [['src/meadow.ts', 8]], { pattern })], turns: [ret(1, 1)] })
  assert.deepEqual(front(by('\bcomposeArea\('), 'a'), [])
  assert.deepEqual(front(by('composeEndless'), 'a'), ['symbol symbol:composeArea'])
  const dismissed = fold({ ground: g, calls: [move(1, 'a')], turns: [ret(1, 1, { dismissed: [dismiss('a', { path: 'symbol:composeArea' })] })] })
  assert.deepEqual(front(dismissed, 'a'), [], 'a dismissal of the item closes it')
})

test('a refs call is a new query under the ask and moves the stamp though its files were observed; the same refs again moves nothing', () => {
  const g = ground(referenced('composeArea', [], ['src/meadow.ts']))
  const refs = (seq, symbol) => refsCall(seq, ['a'], symbol, ['src/meadow.ts'])
  const x = {
    ground: g,
    calls: [listed(1, ['a'], ['src/meadow.ts']), refs(2, 'composeArea'), refs(3, 'composeEndless'), { ...refs(4, 'composeEndless'), repeat_of: 3 }, refs(5, 'composeEndless')],
    turns: [ret(1, 1), ret(2, 2), ret(3, 3), ret(4, 4), ret(5, 5)],
  }
  const stampAfter = (n) => fold({ ...x, turns: x.turns.slice(0, n) }).asks.a.stamp
  assert.notEqual(stampAfter(2), stampAfter(1), 'following the symbol is a query the ask had not run')
  assert.notEqual(stampAfter(3), stampAfter(2), 'so is a refs of a symbol no ground row names, over files already observed')
  assert.equal(fold({ ...x, turns: x.turns.slice(0, 3) }).asks.a.end, null, 'turn 3 ran a new query: progress, not no_progress')
  assert.equal(stampAfter(4), stampAfter(3), 'a repeat_of record is the same query')
  assert.equal(stampAfter(5), stampAfter(3), 'so is the same tool and args again')
})

const filesCall = (seq, asks, glob, keys = []) => ({ seq, tool: 'files', args: { glob, page: 1 }, asks, ok: true, total: keys.length, page: 1, pages: 1, observed: [], keys })

test('a symbol with no reference site is no agenda item of its own', () => {
  assert.deepEqual(front(fold({ ground: ground(symbolRow('ITEM_STAND', [['src/data/items.ts', 12]])) }), 'a'), ['ground src/data/items.ts'])
})

test("a symbol item nobody followed is the ask's unreached at its end", () => {
  const l = fold({ ground: ground(referenced('composeArea', [], ['src/meadow.ts'])), turns: [ret(1, 0, { asks: [declare('a', 'answered')] })] })
  assert.ok(coverageLines(l, NAME).unreached.some((u) => u.includes('symbol:composeArea')))
})

test('a read to the end closes a ground row for the asks the reads named, and a partial read does not', () => {
  const g = ground(pathRow('src/a.ts', true, ['a', 'b']), pathRow('src/b.ts', true, ['a', 'b']), pathRow('src/empty.ts', true, ['a', 'b']))
  const calls = [
    read(1, ['a'], 'src/a.ts', 1, 6, 10), read(2, ['a'], 'src/a.ts', 7, 10, 10), read(3, ['b'], 'src/a.ts', 1, 4, 10),
    read(4, ['a'], 'src/b.ts', 1, 4, 10), read(5, ['a'], 'src/b.ts', 6, 10, 10), read(6, ['a'], 'src/empty.ts', 1, 0, 0),
  ]
  const l = fold({ asks: [ask('a'), ask('b')], ground: g, calls, turns: [ret(1, 6)] })
  assert.deepEqual(front(l, 'a'), ['ground src/b.ts'], 'a.ts read 1–10 across two reads, the empty file read whole, b.ts missing line 5')
  assert.deepEqual(front(l, 'b'), ['ground src/a.ts', 'ground src/b.ts', 'ground src/empty.ts'])
})

test("a hit on a ground row's key closes it for the hit's asks", () => {
  const l = fold({
    asks: [ask('a'), ask('b')], ground: ground(pathRow('src/a.ts', true, ['a', 'b'])),
    calls: [grep(1, ['a', 'b'], [['src/a.ts', 9]])], turns: [ret(1, 1, { hits: [hit('a', 'src/a.ts', 9)] })],
  })
  assert.deepEqual(front(l, 'a'), [])
  assert.deepEqual(front(l, 'b'), ['ground src/a.ts'])
})

test('an open seed is agenda until closed; a closed seed never is, even when it is a ground row', () => {
  const g = ask('g', { seeds: [{ key: 'CLAUDE.md', as: 'open', reason: 'guidance' }, { key: 'docs/drop/DESIGN.md', as: 'closed', reason: "the probe's artefact, held whole by its probers" }] })
  const x = { asks: [g], ground: ground(pathRow('docs/drop/DESIGN.md', true, ['g']), pathRow('src/a.ts', true, ['g'])) }
  assert.deepEqual(front(fold(x), 'g'), ['seed CLAUDE.md', 'ground src/a.ts'])
  const readIt = fold({ ...x, calls: [read(1, ['g'], 'CLAUDE.md', 1, 12, 12)], turns: [ret(1, 1)] })
  assert.deepEqual(front(readIt, 'g'), ['ground src/a.ts'])
})

test('an agenda key appears once, under the first of seed, lead and ground', () => {
  const g = ask('g', { seeds: [{ key: 'CLAUDE.md', as: 'open', reason: 'guidance' }] })
  const l = fold({
    asks: [g], ground: ground(pathRow('CLAUDE.md', true, ['g']), pathRow('src/a.ts', true, ['g'])), calls: [move(1, 'g')],
    turns: [ret(1, 1, { leads: [{ ask: 'g', path: 'CLAUDE.md', why: 'w' }, { ask: 'g', path: 'src/a.ts', why: 'w' }] })],
  })
  assert.deepEqual(front(l, 'g'), ['seed CLAUDE.md', 'lead src/a.ts'])
})

test("a web ask's leads and dismissals are keyed by canonicalUrl of their path", () => {
  const w = ask('w', { domain: 'web', scope: [] })
  const lead = fold({ asks: [w], calls: [move(1, 'w')], turns: [ret(1, 1, { leads: [{ ask: 'w', path: 'https://Docs.Example.com/guide/#install', why: 'the install page' }] })] })
  assert.deepEqual(front(lead, 'w'), ['lead ' + canonicalUrl('https://docs.example.com/guide')])
  const gone = fold({
    asks: [w], calls: [move(1, 'w')],
    turns: [ret(1, 1, { leads: [{ ask: 'w', path: 'https://Docs.Example.com/guide/#install', why: 'w' }], dismissed: [dismiss('w', { path: 'https://docs.example.com/guide/' })] })],
  })
  assert.deepEqual(front(gone, 'w'), [])
})

// ------------------------------------------------------------------ dismissals

test('a path dismissal closes the key and every key under it as a directory, and nothing that only shares its prefix', () => {
  const g = ground(pathRow('vendor/a.js'), pathRow('vendor/b/c.js'), pathRow('vendorx.js'), pathRow('src/a.js'))
  const l = fold({ ground: g, turns: [ret(1, 0, { dismissed: [dismiss('a', { path: 'vendor' })] })] })
  assert.deepEqual(front(l, 'a'), ['ground vendorx.js', 'ground src/a.js'])
})

test('a glob dismissal closes keys by the search dialect: * stays inside a segment, ** crosses directories', () => {
  const g = ground(pathRow('src/a.js'), pathRow('src/x/b.js'), pathRow('src/x/c.ts'))
  const one = fold({ ground: g, turns: [ret(1, 0, { dismissed: [dismiss('a', { glob: 'src/*.js' })] })] })
  assert.deepEqual(front(one, 'a'), ['ground src/x/b.js', 'ground src/x/c.ts'])
  const deep = fold({ ground: g, turns: [ret(1, 0, { dismissed: [dismiss('a', { glob: 'src/**/*.js' })] })] })
  assert.deepEqual(front(deep, 'a'), ['ground src/x/c.ts'])
  const all = fold({ ground: g, turns: [ret(1, 0, { dismissed: [dismiss('a', { glob: '**' })] })] })
  assert.deepEqual(front(all, 'a'), [])
})

test('a path with brackets is literal: dismissing app/[id]/page.tsx closes exactly that key', () => {
  const g = ground(pathRow('app/[id]/page.tsx'), pathRow('app/i/page.tsx'))
  const l = fold({ ground: g, turns: [ret(1, 0, { dismissed: [dismiss('a', { path: 'app/[id]/page.tsx' })] })] })
  assert.deepEqual(front(l, 'a'), ['ground app/i/page.tsx'])
})

test('brackets in a glob are literal too: app/[id]/* closes app/[id]/page.tsx and nothing a class would reach', () => {
  const g = ground(pathRow('app/[id]/page.tsx'), pathRow('app/i/page.tsx'), pathRow('app/d/page.tsx'))
  const closedBy = (glob) => {
    const l = fold({ ground: g, turns: [ret(1, 0, { dismissed: [dismiss('a', { glob })] })] })
    return front(l, 'a')
  }
  assert.deepEqual(closedBy('app/[id]/*'), ['ground app/i/page.tsx', 'ground app/d/page.tsx'])
  assert.deepEqual(closedBy('app/[a-z]/*'), ['ground app/[id]/page.tsx', 'ground app/i/page.tsx', 'ground app/d/page.tsx'], 'a class is not a class: it closes nothing')
  assert.deepEqual(closedBy('app/[!x]*/page.tsx'), ['ground app/[id]/page.tsx', 'ground app/i/page.tsx', 'ground app/d/page.tsx'], 'nor is a negated one')
})

test("a call dismissal closes every key that call returned and its query's unfetched pages", () => {
  const g = ground(pathRow('src/a.js'), pathRow('src/b.js'), pathRow('src/c.js'))
  const paged = grep(1, ['a'], [['src/a.js', 1], ['src/b.js', 2]], { pages: 2, total: 300 })
  const l = fold({ ground: g, calls: [paged], turns: [ret(1, 1, { dismissed: [dismiss('a', { call: 1 })] })] })
  assert.deepEqual(front(l, 'a'), ['ground src/c.js'])
})

test('a dismissal records whether its key was read to the end under its asks', () => {
  const l = fold({
    ground: ground(pathRow('src/a.ts'), pathRow('src/b.ts')), calls: [read(1, ['a'], 'src/a.ts', 1, 3, 3)],
    turns: [ret(1, 1, { dismissed: [dismiss('a', { path: 'src/a.ts' }), dismiss('a', { path: 'src/b.ts' })] })],
  })
  assert.deepEqual(l.asks.a.dismissed.map((d) => [d.key, d.read_to_end, d.turn]), [['src/a.ts', true, 1], ['src/b.ts', false, 1]])
})

test('a dismissal naming no path, glob or known call is refused unobserved', () => {
  const l = fold({ turns: [ret(1, 0, { dismissed: [{ ask: ['a'], why: 'nothing named' }, dismiss('a', { call: 99 })] })] })
  assert.deepEqual(classes(l), ['unobserved', 'unobserved'])
  assert.deepEqual(l.asks.a.dismissed, [])
})

test('a dismissal that repeats an earlier one in new words adds nothing', () => {
  const l = fold({
    ground: ground(pathRow('src/a.js'), pathRow('src/b.js')),
    turns: [ret(1, 0, { dismissed: [dismiss('a', { path: 'src/a.js' }, 'one reason')] }), ret(2, 0, { dismissed: [dismiss('a', { path: 'src/a.js' }, 'another reason')] })],
  })
  assert.deepEqual(l.asks.a.dismissed.map((d) => d.why), ['one reason'])
  const [one, two] = l.asks.a.history.slice(-2).map((h) => h.stamp)
  assert.equal(two, one, 'the same dismissal again moves nothing')
})

// ------------------------------------------------------------------ declarations

test('a declaration stands until the navigator changes it, and open withdraws it', () => {
  const g = ground(pathRow('src/a.ts'))
  const calls = [move(1, 'a'), move(2, 'a'), move(3, 'a')]
  const turns = [ret(1, 1, { asks: [declare('a', 'answered')] }), ret(2, 2), ret(3, 3, { asks: [declare('a', 'open')] })]
  assert.equal(fold({ ground: g, calls, turns: turns.slice(0, 1) }).asks.a.declared, 'answered')
  assert.equal(fold({ ground: g, calls, turns: turns.slice(0, 2) }).asks.a.declared, 'answered')
  assert.equal(fold({ ground: g, calls, turns }).asks.a.declared, 'open')
})

test('a hit accepted after a standing absent withdraws the declaration', () => {
  const x = {
    ground: ground(pathRow('src/a.ts')), calls: [grep(1, ['a'], []), grep(2, ['a'], [['src/b.ts', 4]])],
    turns: [ret(1, 1, { asks: [declare('a', 'absent')] }), ret(2, 2, { hits: [hit('a', 'src/b.ts', 4)] })],
  }
  const first = fold({ ...x, turns: x.turns.slice(0, 1) })
  assert.deepEqual([first.asks.a.declared, first.asks.a.end], ['absent', null])
  const l = fold(x)
  assert.deepEqual([l.asks.a.declared, l.asks.a.end], ['', null])
})

// ------------------------------------------------------------------ refusals carry their asks

test('a refusal carries the open asks its item named', () => {
  const l = fold({ asks: [ask('a'), ask('b')], calls: [move(1, ['a', 'b'])], turns: [ret(1, 1), ret(2, 1, { hits: [hit(['a', 'b'], 'src/nowhere.js', 3)] })] })
  assert.deepEqual(l.refusals.map((r) => r.asks), [['a', 'b']])
  const contradicted = fold({
    calls: [grep(1, ['a'], [['src/a.js', 3]])],
    turns: [ret(1, 1, { hits: [hit('a', 'src/a.js', 3)] }), ret(2, 1, { asks: [declare('a', 'absent')] })],
  })
  assert.deepEqual(contradicted.refusals.map((r) => [r.class, r.asks]), [['contradicts_hit', ['a']]])
})

// ------------------------------------------------------------------ the refusals still standing

const standing = (l) => standingRefusals(l).map((r) => [r.turn, r.class, r.item.kind, r.asks])

test('a refusal stands at the end of the search unless the ask holds the hit it refused', () => {
  const calls = [grep(1, ['a'], [['src/a.js', 3]]), read(2, ['a'], 'src/b.js', 9, 9, 20)]
  const refused = ret(1, 1, { hits: [hit('a', 'src/b.js', 9), hit('a', 'src/c.js', 2)] })
  assert.deepEqual(standing(fold({ calls: calls.slice(0, 1), turns: [refused] })), [[1, 'unobserved', 'hit', ['a']], [1, 'unobserved', 'hit', ['a']]])
  const cured = fold({ calls, turns: [refused, ret(2, 2, { hits: [hit('a', 'src/b.js', 9)] })] })
  assert.deepEqual(standing(cured), [[1, 'unobserved', 'hit', ['a']]], 'only the line nothing showed stays')
  assert.equal(standingRefusals(cured)[0].item.path, 'src/c.js')
})

test('a refusal stands while any ask it named lacks the hit', () => {
  const calls = [grep(1, ['a'], [['src/a.js', 3]]), read(2, ['a'], 'src/b.js', 9, 9, 20)]
  const l = fold({
    asks: [ask('a'), ask('b')], calls,
    turns: [ret(1, 1, { hits: [hit(['a', 'b'], 'src/b.js', 9)] }), ret(2, 2, { hits: [hit('a', 'src/b.js', 9)] })],
  })
  assert.deepEqual(hitsOf(l, 'a'), ['src/b.js:9'])
  assert.deepEqual(standing(l), [[1, 'unobserved', 'hit', ['a', 'b']]])
})

test('a refusal of any class stands: an unknown ask, a contradicted declaration, a dismissal naming nothing', () => {
  const calls = [grep(1, ['a'], [['src/a.js', 3]])]
  const l = fold({
    calls, turns: [ret(1, 1, { hits: [hit('a', 'src/a.js', 3), hit('zzz', 'src/z.js', 1)], asks: [declare('a', 'absent')], dismissed: [{ ask: ['a'], why: 'w' }, dismiss('zzz', { path: 'x.js' })] })],
  })
  assert.deepEqual(standing(l).map((r) => r[1]).sort(), ['contradicts_hit', 'unknown_ask', 'unknown_ask', 'unobserved'])
  assert.deepEqual(coverageLines(l, NAME).unreached.filter((x) => x.includes('refused')).length, 1, 'only the unobserved one is a line')
})

test('coverageLines: unreached names each ask a refusal for an unobserved item stands against', () => {
  const l = fold({ asks: [ask('a'), ask('b')], calls: [move(1, ['a', 'b'])], turns: [ret(1, 1), ret(2, 1, { hits: [hit(['a', 'b'], 'src/nowhere.js', 3)] })] })
  const lines = coverageLines(l, NAME).unreached
  assert.ok(lines.some((x) => x.startsWith(NAME + ':a: ') && x.includes('src/nowhere.js:3') && x.includes('unobserved')), JSON.stringify(lines))
  assert.ok(lines.some((x) => x.startsWith(NAME + ':b: ') && x.includes('src/nowhere.js:3')), JSON.stringify(lines))
})

test('coverageLines: a hit the navigator re-cited after reading is not unreached', () => {
  const calls = [grep(1, ['a'], [['src/a.js', 3]]), read(2, ['a'], 'src/b.js', 9, 9, 20)]
  const l = fold({ calls, turns: [ret(1, 1, { hits: [hit('a', 'src/b.js', 9)] }), ret(2, 2, { hits: [hit('a', 'src/b.js', 9)] })] })
  assert.deepEqual(coverageLines(l, NAME).unreached.filter((x) => x.includes('unobserved')), [])
})

test('leads and notes do not move the stamp; observed lines, hits, a dismissal of an observed key and declarations do', () => {
  const base = { calls: [grep(1, ['a'], [['src/a.js', 1], ['src/b.js', 2]])], turns: [ret(1, 1, { hits: [hit('a', 'src/a.js', 1, 'first')] })] }
  const before = fold(base).asks.a.stamp
  const after = (calls, o) => fold({ calls: [...base.calls, ...calls], turns: [...base.turns, ret(2, 1 + calls.length, o)] }).asks.a.stamp
  const line2 = () => grep(2, ['a'], [['src/a.js', 2]])
  assert.equal(after([], { leads: [{ ask: 'a', path: 'src/b.js', why: 'w' }] }), before, 'a lead')
  assert.equal(after([], { hits: [hit('a', 'src/a.js', 1, 'reworded')] }), before, 'a new note')
  assert.notEqual(after([line2()], {}), before, 'a new observed line')
  assert.notEqual(after([line2()], { hits: [hit('a', 'src/a.js', 2)] }), after([line2()], {}), 'a hit')
  assert.notEqual(after([], { dismissed: [dismiss('a', { path: 'src/b.js' })] }), before, 'a dismissal of a key that was observed')
  assert.equal(after([], { dismissed: [dismiss('a', { path: 'src/c.js' })] }), before, 'a dismissal that closes nothing')
  assert.notEqual(after([], { asks: [declare('a', 'open')] }), before, 'a declaration')
})

// ------------------------------------------------------------------ check-ins and rulings

test('at a check-in, toRuler lists the open asks whose stamp moved since their previous check-in', () => {
  const l = fold({ asks: [ask('a'), ask('b'), ask('c')], calls: [move(1, ['a', 'b']), move(2, 'a'), move(3, 'a')], turns: [ret(1, 1), ret(2, 2), ret(3, 3)] })
  assert.deepEqual(stateOf(l, { turn: 3, checkin: true }).toRuler, ['a', 'b'])
})

test('toRuler is empty when the turn is not a check-in', () => {
  const l = fold({ calls: [move(1, 'a')], turns: [ret(1, 1)] })
  assert.deepEqual(stateOf(l, { turn: 1, checkin: false }).toRuler, [])
})

test("an ask's previous check-in is the latest ruling that named it", () => {
  const calls = [move(1, ['a', 'b']), move(2, 'a'), move(3, 'a'), move(4, 'a'), move(5, 'a'), move(6, 'a')]
  const l = fold({
    asks: [ask('a'), ask('b')], calls, turns: [1, 2, 3, 4, 5, 6].map((n) => ret(n, n)),
    rulings: [{ turn: 3, asks: ['a', 'b'], units: [unit('a', 'open'), unit('b', 'open')] }],
  })
  assert.deepEqual(stateOf(l, { turn: 6, checkin: true }).toRuler, ['a'], 'b has not moved since it was ruled at turn 3')
})

const RULED = { asks: [ask('a'), ask('b')], calls: [move(1, ['a', 'b']), move(2, ['a', 'b']), move(3, ['a', 'b'])], turns: [ret(1, 1), ret(2, 2), ret(3, 3)] }

test('two navigator turns missing in a row stop every open ask; one miss between returns stops nothing', () => {
  const l = fold({ asks: [ask('a'), ask('b')], calls: [move(1, ['a', 'b'])], turns: [ret(1, 1), lost(2, 1, 'host_error'), lost(3, 1, 'schema_failed')] })
  for (const k of ['a', 'b']) {
    assert.deepEqual([l.asks[k].end.state, l.asks[k].end.turn, l.asks[k].end.by, l.asks[k].end.label], ['stopped', 3, 'navigator', 'observed'])
    assert.match(l.asks[k].end.why, /host_error/)
    assert.match(l.asks[k].end.why, /schema_failed/)
  }
  const apart = fold({ calls: [move(1, 'a'), move(2, 'a')], turns: [ret(1, 1), lost(2, 1), ret(3, 2), lost(4, 2)] })
  assert.equal(apart.asks.a.end, null)
})

// ------------------------------------------------------------------ history, matching, order, joining

test('history holds one entry at from−1 and one per returned turn for every open ask, worked or not, with the observed set and hit counts', () => {
  const l = fold({
    asks: [ask('a'), ask('b'), ask('w', { from: 2 })],
    calls: [grep(1, ['a'], [['src/a.js', 1], ['src/a.js', 2]]), grep(2, ['a'], [['src/b.js', 4]])],
    turns: [ret(1, 1, { hits: [hit('a', 'src/a.js', 1)] }), ret(2, 2)],
  })
  const shape = (k) => l.asks[k].history.map(({ turn, observed_n, hits_n }) => [turn, observed_n, hits_n])
  assert.deepEqual(shape('a'), [[0, 0, 0], [1, 3, 1], [2, 5, 1]], "observed_n counts the observed set, whole keys included: 'src/a.js', ':1', ':2', then 'src/b.js', ':4'")
  assert.deepEqual(shape('b'), [[0, 0, 0], [1, 0, 0], [2, 0, 0]], 'an open ask no turn worked still gets an entry per returned turn')
  assert.deepEqual(shape('w'), [[1, 0, 0], [2, 0, 0]], 'an ask that joins at turn 2 starts at turn 1')
  assert.equal(new Set(l.asks.b.history.map((h) => h.stamp)).size, 1)
  assert.equal(new Set(l.asks.a.history.map((h) => h.stamp)).size, 3)
  assert.equal(l.asks.a.history.at(-1).stamp, l.asks.a.stamp)
})

test('dismissal paths and globs match the way the search dialect does', () => {
  const keys = ['src/a.js', 'src/x/y/a.js', 'src/xa.js', 'src/b.js', 'src/c.js', 'src/cc.js', 'docs/x.md', 'docsy.md', 'README.md', 'a b/c*.js', 'a b/cd.js', 'src/[!a]x.js']
  const g = ground(...keys.map((k) => pathRow(k)))
  const closed = (target) => {
    const l = fold({ ground: g, turns: [ret(1, 0, { dismissed: [dismiss('a', target)] })] })
    const open = new Set(l.asks.a.agenda.map((f) => f.key))
    return keys.filter((k) => !open.has(k))
  }
  assert.deepEqual(closed({ glob: 'src/**/a.js' }), ['src/a.js', 'src/x/y/a.js'], '** matches zero or more directories')
  assert.deepEqual(closed({ glob: 'src/[!a]*.js' }), ['src/[!a]x.js'], '[!a] is those four characters, not a class')
  assert.deepEqual(closed({ glob: 'src/?.js' }), ['src/a.js', 'src/b.js', 'src/c.js'], '? is one character, never a /')
  assert.deepEqual(closed({ glob: '**/*.md' }), ['docs/x.md', 'docsy.md', 'README.md'], 'a leading **/ also matches at the root')
  assert.deepEqual(closed({ path: 'docs/' }), ['docs/x.md'], 'a literal directory, trailing slash or not')
  assert.deepEqual(closed({ path: 'a b/c*.js' }), ['a b/c*.js'], 'a literal path takes * and spaces as they are')
})

test("an ask's stamp, end and agenda do not depend on the order of calls, items or the asks a call names", () => {
  const calls = [
    grep(1, ['a', 'b'], [['src/a.js', 1]]), read(2, ['b', 'a'], 'src/c.ts', 1, 4, 4),
    grep(3, ['a'], [['src/d.js', 2], ['src/e.js', 3]], { pages: 2, total: 300 }),
  ]
  const o = {
    hits: [hit(['a', 'b'], 'src/a.js', 1, 'one'), hit('a', 'src/d.js', 2, 'two')],
    dismissed: [dismiss('a', { path: 'src/z.ts' }), dismiss(['b', 'a'], { glob: 'vendor/**' })],
    leads: [{ ask: 'a', path: 'src/l1.ts', why: 'w' }, { ask: 'b', path: 'src/l2.ts', why: 'w' }],
    asks: [declare('a', 'answered'), declare('b', 'open')],
  }
  const g = ground(pathRow('src/c.ts', true, ['a', 'b']), pathRow('src/f.ts', true, ['a', 'b']))
  const x = fold({ asks: [ask('a'), ask('b')], ground: g, calls, turns: [ret(1, 3, o)] })
  const flipped = {
    hits: [...o.hits].reverse().map((h) => ({ ...h, ask: [...h.ask].reverse() })),
    dismissed: [...o.dismissed].reverse().map((d) => ({ ...d, ask: [...d.ask].reverse() })),
    leads: [...o.leads].reverse(), asks: [...o.asks].reverse(),
  }
  const y = fold({ asks: [ask('a'), ask('b')], ground: g, calls: [...calls].reverse().map((c) => ({ ...c, asks: [...c.asks].reverse() })), turns: [ret(1, 3, flipped)] })
  for (const k of ['a', 'b']) {
    assert.equal(y.asks[k].stamp, x.asks[k].stamp, k + ' stamp')
    assert.deepEqual(y.asks[k].end, x.asks[k].end, k + ' end')
    assert.deepEqual(y.asks[k].observed, x.asks[k].observed, k + ' observed')
    assert.deepEqual(new Set(y.asks[k].agenda.map((f) => f.kind + ' ' + f.key)), new Set(x.asks[k].agenda.map((f) => f.kind + ' ' + f.key)), k + ' agenda')
  }
})

test("with no ruling yet, an ask's check-in baseline is its first history entry, at from−1", () => {
  const l = fold({
    asks: [ask('a'), ask('w', { from: 2 }), ask('v', { from: 2 })],
    calls: [move(1, 'a'), move(2, 'w'), move(3, 'a')],
    turns: [ret(1, 1), ret(2, 2), ret(3, 3)],
  })
  assert.deepEqual(stateOf(l, { turn: 3, checkin: true }).toRuler, ['a', 'w'], 'v joined at turn 2 and has not moved since its turn-1 entry')
})

test('a call or an item naming an ask before its from is refused unknown_ask and adds nothing (D25)', () => {
  const l = fold({
    asks: [ask('a'), ask('want:1', { from: 3 })],
    calls: [grep(1, ['a', 'want:1'], [['src/x.js', 2]])],
    turns: [
      ret(1, 1, { hits: [hit('want:1', 'src/x.js', 2), hit(['a', 'want:1'], 'src/x.js', 2)], leads: [{ ask: 'want:1', path: 'src/y.js', why: 'w' }] }),
      ret(2, 1), ret(3, 1),
    ],
  })
  assert.deepEqual(classes(l), ['unknown_ask', 'unknown_ask', 'unknown_ask'])
  assert.ok(l.asks.a.observed.includes('src/x.js:2'), 'the call still counts for an ask that was open')
  assert.deepEqual(l.asks['want:1'].observed, [], 'the call made before it joined adds nothing to it')
  assert.deepEqual(l.asks['want:1'].hits, [])
  assert.deepEqual(l.asks['want:1'].leads, [])
})

// ------------------------------------------------------------------ labels and coverage

test("coverageLines: unreached holds one line per item of an ask's agenda at its end", () => {
  const l = fold({ ground: ground(pathRow('src/a.ts'), pathRow('src/b.ts')), calls: [move(1, 'a')], turns: [ret(1, 1), ret(2, 1)] })
  const c = coverageLines(l, NAME)
  assert.equal(c.unreached.length, 2)
  for (const key of ['src/a.ts', 'src/b.ts']) assert.ok(c.unreached.some((line) => line.startsWith(NAME + ':a') && line.includes(key)), key)
})

test('coverageLines: failed_channels names a navigator stop by its ask and a ruler stop as converge:<name>', () => {
  const nav = coverageLines(fold({ calls: [move(1, 'a')], turns: [ret(1, 1), lost(2, 1), lost(3, 1)] }), NAME)
  assert.deepEqual(nav.failed_channels, [NAME + ':a'])
  const ruler = coverageLines(fold({ calls: [move(1, 'a')], turns: [ret(1, 1)], rulings: [{ turn: 1, asks: ['a'], missing: 'x' }, { turn: 1, asks: ['a'], missing: 'y' }] }), NAME)
  assert.deepEqual(ruler.failed_channels, ['converge:' + NAME])
})

// ------------------------------------------------------------------ added by the test author

test('a partial read does not close an open seed, and a hit on it does', () => {
  const g = ask('g', { seeds: [{ key: 'CLAUDE.md', as: 'open', reason: 'guidance' }] })
  const partial = fold({ asks: [g], calls: [read(1, ['g'], 'CLAUDE.md', 1, 5, 12)], turns: [ret(1, 1)] })
  assert.deepEqual(front(partial, 'g'), ['seed CLAUDE.md'])
  const hitOn = fold({ asks: [g], calls: [grep(1, ['g'], [['CLAUDE.md', 3]])], turns: [ret(1, 1, { hits: [hit('g', 'CLAUDE.md', 3)] })] })
  assert.deepEqual(front(hitOn, 'g'), [])
})

test('a query ran twice over has its overflow reported once per query, each keyed by its own first call', () => {
  const q = (seq, pattern, page) => grep(seq, ['a'], [['src/' + pattern + page + '.js', 1]], { pattern, page, pages: 2, total: 300 })
  const l = fold({ calls: [q(1, 'x', 1), q(2, 'y', 1)], turns: [ret(1, 2)] })
  assert.deepEqual(l.asks.a.agenda.map((f) => f.kind + ' ' + f.key + ' ' + f.detail).sort(), ['overflow call:1 page 2 of 2', 'overflow call:2 page 2 of 2'])
})

test('a glob dismissal never closes an overflow page, and neither does a path dismissal of the files it showed', () => {
  const calls = [grep(1, ['a'], [['src/a.js', 1]], { pages: 2, total: 300 })]
  for (const target of [{ glob: '**' }, { path: 'src' }]) {
    const l = fold({ calls, turns: [ret(1, 1, { dismissed: [dismiss('a', target)] })] })
    assert.deepEqual(l.asks.a.agenda.map((f) => [f.kind, f.key]), [['overflow', 'call:1']], JSON.stringify(target))
  }
})

test('only a path dismissal of a key read to its end records read_to_end', () => {
  const l = fold({
    ground: ground(pathRow('src/a.ts')), calls: [read(1, ['a'], 'src/a.ts', 1, 3, 3)],
    turns: [ret(1, 1, { dismissed: [dismiss('a', { glob: 'src/*.ts' }), dismiss('a', { call: 1 })] })],
  })
  assert.deepEqual(l.asks.a.dismissed.map((d) => d.read_to_end), [false, false])
})

test('stateOf reports only done and no_progress endings; a ruled or stopped end is not an ending of its turn, and a stopped ask is not sent to the ruler', () => {
  const ruled = fold({ ...RULED, rulings: [{ turn: 3, asks: ['a', 'b'], units: [unit('a', 'not_converging'), unit('b', 'open')] }] })
  const s = stateOf(ruled, { turn: 3, checkin: true })
  assert.deepEqual(s.ending, [])
  assert.deepEqual(s.open, ['b'])
  const stopped = fold({ calls: [move(1, 'a')], turns: [ret(1, 1), lost(2, 1), lost(3, 1)] })
  assert.deepEqual(stateOf(stopped, { turn: 3, checkin: true }).ending, [])
  assert.deepEqual(stateOf(stopped, { turn: 3, checkin: true }).toRuler, [])
})

test('the same ruling stream folds the same ledger whatever the order of rulings at different turns', () => {
  const rulings = [
    { turn: 2, asks: ['a'], units: [unit('a', 'open')] },
    { turn: 3, asks: ['a'], units: [unit('a', 'not_converging', 'late')] },
  ]
  const l = fold({ ...RULED, rulings })
  const r = fold({ ...RULED, rulings: [...rulings].reverse() })
  assert.deepEqual(r.asks.a.end, l.asks.a.end)
  assert.equal(l.asks.a.end.turn, 3)
})

// ------------------------------------------------------------------ added by the T03 audit

test("an ask's previous check-in is the latest of the rulings that named it", () => {
  const l = fold({
    asks: [ask('a'), ask('b')],
    calls: [move(1, ['a', 'b']), move(2, ['a', 'b']), move(3, 'a'), move(4, ['a', 'b']), move(5, 'b')],
    turns: [1, 2, 3, 4, 5].map((n) => ret(n, n)),
    rulings: [
      { turn: 2, asks: ['a'], units: [unit('a', 'open')] },
      { turn: 4, asks: ['a'], units: [unit('a', 'open')] },
    ],
  })
  assert.equal(l.asks.a.end, null)
  assert.deepEqual(stateOf(l, { turn: 5, checkin: true }).toRuler, ['b'], 'a has not moved since it was ruled at turn 4, though it moved after turn 2')
})

test("a ruling at the queried turn is not its ask's previous check-in: a refold that holds it reports the same toRuler", () => {
  const x = { calls: [move(1, 'a'), move(2, 'a')], turns: [ret(1, 1), ret(2, 2)] }
  const without = stateOf(fold(x), { turn: 2, checkin: true }).toRuler
  const ruled = fold({ ...x, rulings: [{ turn: 2, asks: ['a'], units: [unit('a', 'open')] }] })
  assert.deepEqual(without, ['a'])
  assert.deepEqual(stateOf(ruled, { turn: 2, checkin: true }).toRuler, without)
})

test('a ruling folds once however many turn records carry its turn: one miss stops nothing', () => {
  const x = { calls: [move(1, 'a'), move(2, 'a')], turns: [ret(1, 1), ret(1, 2)] }
  assert.equal(fold({ ...x, rulings: [{ turn: 1, asks: ['a'], missing: 'schema_failed' }] }).asks.a.end, null)
})

test('a ruling folds once however many turn records carry its turn: it ends the ask once and is listed once', () => {
  const ruling = { turn: 1, asks: ['a'], units: [unit('a', 'not_converging', 'stuck')] }
  const l = fold({ calls: [move(1, 'a'), move(2, 'a')], turns: [ret(1, 1), ret(1, 2)], rulings: [ruling] })
  assert.deepEqual([l.asks.a.end.state, l.asks.a.end.turn, l.asks.a.end.label, l.asks.a.end.why], ['not_converging', 1, 'ruled', 'stuck'])
  assert.deepEqual(l.rulings, [{ turn: 1, asks: ['a'] }])
})

/** The journal of 4 repo asks, 1000 grep calls of 200 observed lines each, and 200 returned turns. */
function bigJournal() {
  const asks = ['a', 'b', 'c', 'd'].map((k) => ask(k))
  const calls = []
  for (let i = 1; i <= 1000; i++) {
    const lines = []
    for (let j = 0; j < 200; j++) lines.push(['src/m' + (i % 50) + '/f' + (j % 10) + '.js', i * 200 + j])
    calls.push(grep(i, [asks[i % 4].key], lines, { pattern: 'p' + i }))
  }
  const turns = []
  for (let t = 1; t <= 200; t++) turns.push(ret(t, t * 5))
  return { asks, calls, turns }
}

test("a fold's cost grows linearly in the journal: folding 200 turns costs at most 3 times folding the first 100", () => {
  const { asks, calls, turns } = bigJournal()
  const best = (n) => {
    const part = { asks, ground: NONE, turns: turns.slice(0, n), calls: calls.filter((c) => c.seq <= n * 5) }
    let fastest = Infinity
    for (let run = 0; run < 3; run++) {
      const start = performance.now()
      foldLedger(part)
      fastest = Math.min(fastest, performance.now() - start)
    }
    return fastest
  }
  const half = best(100)
  const whole = best(200)
  assert.ok(whole <= 3 * half, 'folding 200 turns took ' + whole.toFixed(0) + ' ms, the first 100 took ' + half.toFixed(0) + ' ms')
})

test('in the web domain a path dismissal names exactly its URL: a lead under it stays', () => {
  const w = ask('w', { domain: 'web', scope: [] })
  const l = fold({
    asks: [w], calls: [move(1, 'w')],
    turns: [ret(1, 1, { leads: [{ ask: 'w', path: 'https://a.com/docs/x', why: 'w' }], dismissed: [dismiss('w', { path: 'https://a.com' })] })],
  })
  assert.deepEqual(front(l, 'w'), ['lead https://a.com/docs/x'])
})

test('in the web domain a path dismissal closes a lead on the same canonical URL', () => {
  const w = ask('w', { domain: 'web', scope: [] })
  const l = fold({
    asks: [w], calls: [move(1, 'w')],
    turns: [ret(1, 1, { leads: [{ ask: 'w', path: 'https://A.com/docs/x#top', why: 'w' }], dismissed: [dismiss('w', { path: 'https://a.com/docs/x/' })] })],
  })
  assert.deepEqual(front(l, 'w'), [])
})

// ------------------------------------------------------------------ added by the T04a test author: the agenda, what an ask owes, what it looked for, the stamp

const OWED = ['src/a.ts', 'src/b/c.ts', 'lib/d.ts']
/** A scope-owing ask: no seed, no row, the scope's files as `owes`. */
const owing = (key, owes, extra = {}) => bare(key, { scope: ['.'], owes, ...extra })
const through = (calls) => Math.max(0, ...calls.map((c) => c.seq))
/** Ask t owing `owes`, folded over `calls` returned in one turn (or over `turns`). */
const owed = (calls, { owes = OWED, scope = ['.'], turns } = {}) => fold({ asks: [owing('t', owes, { scope })], calls, turns: turns ?? [ret(1, through(calls))] })
const sorted = (keys) => [...keys].sort()
const keysOf = (l, a, kind) => sorted(agendaOf(l, a).filter((f) => f.kind === kind).map((f) => f.key))
const owedLeft = (l, a = 't') => keysOf(l, a, 'file')
/** How many files the directories of ask a say they covered. */
const coveredN = (l, a = 't') => Object.values(l.asks[a].covered ?? {}).reduce((n, d) => n + d.files, 0)
const lookedOf = (l, a) => {
  assert.ok(Array.isArray(l.asks[a].looked), 'ask ' + a + ' has a looked list')
  return l.asks[a].looked
}
const GREP_ARGS = (pattern, paths = []) => ({ pattern, fixed: false, ignore_case: false, paths, page: 1 })
/** A call the server refused: it shows nothing. */
const refusedCall = (seq, asks, tool, args, refusal = 'outside_scope') => ({ seq, tool, args, asks, ok: false, refusal, detail: 'refused', observed: [], keys: [] })
const fetchCall = (seq, asks, url) => ({ seq, tool: 'fetch', args: { url, page: 1 }, asks, ok: true, page: 1, pages: 1, observed: [{ key: url, line: 1 }], keys: [url] })
const logCall = (seq, asks, pattern, paths = []) => ({ seq, tool: 'log', args: { mode: 'G', pattern, paths, page: 1 }, asks, ok: true, total: 1, page: 1, pages: 1, observed: [], keys: [SHA] })
const showCall = (seq, asks, commit, path = '') => ({ seq, tool: 'show', args: { commit, path }, asks, ok: true, observed: [{ key: commit, line: 1 }], keys: [commit] })
const websearch = (seq, asks, query) => ({ seq, tool: 'websearch', args: { query }, asks, ok: true, observed: [], keys: [] })
/** The stamp of ask `a` as it stands after each turn of `x`, each from a fold of that prefix of its turns. */
const stampsOf = (x, a = 'a') => x.turns.map((_, i) => fold({ ...x, turns: x.turns.slice(0, i + 1) }).asks[a].stamp)
/** The stamps after a first turn that moves ask a and 40 more turns, each carrying `item(n)`. */
const stampsOver40 = (item) => {
  const turns = [ret(1, 1)]
  for (let n = 2; n <= 41; n++) turns.push(ret(n, 1, item(n)))
  return stampsOf({ calls: [move(1, 'a')], turns })
}

// ---- the agenda (N1)

test('the view calls it agenda', () => {
  const l = fold({ asks: [ask('a', { seeds: [{ key: 'CLAUDE.md', as: 'open', reason: 'guidance' }] })] })
  assert.deepEqual(agendaOf(l, 'a').map((f) => f.key), ['CLAUDE.md'])
  assert.equal(Object.hasOwn(l.asks.a, 'frontier'), false)
})

test('agenda kinds', () => {
  const g = ask('a', { seeds: [{ key: 'CLAUDE.md', as: 'open', reason: 'guidance' }] })
  const rows = ground(pathRow('src/a.ts'), referenced('composeArea', [['src/area.ts', 3]], ['src/meadow.ts']))
  const l = fold({
    asks: [g], ground: rows, calls: [grep(1, ['a'], [['src/p.js', 1]], { pattern: 'big', pages: 2, total: 300 })],
    turns: [ret(1, 1, { leads: [{ ask: 'a', path: 'src/lead.js', why: 'imports it' }] })],
  })
  const byKind = {}
  for (const f of agendaOf(l, 'a')) (byKind[f.kind] ??= []).push(f.key)
  assert.deepEqual(Object.keys(byKind).sort(), ['ground', 'lead', 'overflow', 'seed', 'symbol'])
  assert.deepEqual(byKind.seed, ['CLAUDE.md'])
  assert.deepEqual(byKind.lead, ['src/lead.js'])
  assert.deepEqual(sorted(byKind.ground), ['src/a.ts', 'src/area.ts'])
  assert.deepEqual(byKind.symbol, ['symbol:composeArea'])
  assert.equal(byKind.overflow.length, 1)
})

test('no scope item', () => {
  const cases = {
    'nothing happened': {},
    'an empty owes list': { extra: { owes: [] } },
    'a grep over the whole scope': { calls: [grep(1, ['t'], [['src/a.ts', 1]])], turns: [ret(1, 1)] },
    'a dismissal of a root': { calls: [move(1, 't')], turns: [ret(1, 1, { dismissed: [dismiss('t', { path: 'src' })] })] },
    'a files call that recurses from the root': { calls: [filesCall(1, ['t'], 'src/**', ['src/a.ts'])], turns: [ret(1, 1)] },
  }
  for (const [what, x] of Object.entries(cases)) {
    const l = fold({ asks: [bare('t', { scope: ['src', 'lib'], ...x.extra }), bare('w', { domain: 'web', scope: [] })], calls: x.calls, turns: x.turns })
    for (const k of ['t', 'w']) {
      assert.equal(agendaOf(l, k).some((f) => f.kind === 'scope'), false, what + ': ' + k)
      assert.deepEqual(agendaOf(l, k).filter((f) => f.kind !== 'overflow'), [], what + ': ' + k + ' has nothing to reach')
    }
  }
})

// ---- what a scope-owing ask owes (N2)

test('a scope-owing ask owes its files', () => {
  const l = fold({ asks: [owing('t', OWED)] })
  assert.deepEqual(agendaOf(l, 't').map((f) => f.kind), ['file', 'file', 'file'])
  assert.deepEqual(owedLeft(l), sorted(OWED))
  assert.equal(l.asks.t.owes, true)
  assert.equal(fold({ asks: [bare('t')] }).asks.t.owes, false, 'an ask that owes nothing says so')
})

test('a grep covers the files under its paths', () => {
  const l = owed([grep(1, ['t'], [], { pattern: 'foo', paths: ['src'] })])
  assert.deepEqual(owedLeft(l), ['lib/d.ts'])
})

test('a grep path covers as a path key or a glob of the search dialect, and a directory is not a name prefix', () => {
  const files = ['src/a.ts', 'src/b/c.ts', 'srcx/e.ts', 'app/[id]/page.tsx', 'app/i/page.tsx']
  const cases = [
    [['src'], ['src/a.ts', 'src/b/c.ts']],
    [['./src/'], ['src/a.ts', 'src/b/c.ts']],
    [['src/a.ts'], ['src/a.ts']],
    [['src/*.ts'], ['src/a.ts']],
    [['src/**/*.ts'], ['src/a.ts', 'src/b/c.ts']],
    [['app/[id]'], ['app/[id]/page.tsx']],
    [['src', 'app/i'], ['src/a.ts', 'src/b/c.ts', 'app/i/page.tsx']],
  ]
  for (const [paths, covered] of cases) {
    const l = owed([grep(1, ['t'], [], { pattern: 'foo', paths })], { owes: files })
    assert.deepEqual(owedLeft(l), sorted(files.filter((f) => !covered.includes(f))), JSON.stringify(paths))
  }
})

test('a grep without paths covers the scope', () => {
  const owes = [...OWED, 'docs/x.md']
  const calls = [grep(1, ['t'], [], { pattern: 'foo' })]
  assert.deepEqual(owedLeft(owed(calls, { owes, scope: ['src', 'lib'] })), ['docs/x.md'], 'every owed file inside the scope, and none outside it')
  assert.deepEqual(owedLeft(owed(calls, { owes, scope: ['.'] })), [])
})

test('a refused call covers nothing', () => {
  const calls = [refusedCall(1, ['t'], 'grep', GREP_ARGS('foo'), 'unsupported_syntax'), refusedCall(2, ['t'], 'read', { path: 'lib/d.ts', from: 1, to: 0 })]
  const l = owed(calls)
  assert.deepEqual(owedLeft(l), sorted(OWED))
  assert.equal(coveredN(l), 0)
})

test('a read covers its file', () => {
  const l = fold({ asks: [owing('t', OWED), owing('u', OWED)], calls: [read(1, ['t'], 'lib/d.ts', 1, 40, 40)], turns: [ret(1, 1)] })
  assert.deepEqual(owedLeft(l, 't'), ['src/a.ts', 'src/b/c.ts'])
  assert.deepEqual(owedLeft(l, 'u'), sorted(OWED), 'a read under t covers nothing for u')
})

test('files covers nothing', () => {
  const l = owed([filesCall(1, ['t'], '**', OWED)])
  assert.deepEqual(owedLeft(l), sorted(OWED))
  assert.equal(coveredN(l), 0, 'a listing is not a look inside')
})

test('a dismissal closes owed files', () => {
  const dismissedBy = (target) => owed([], { turns: [ret(1, 0, { dismissed: [dismiss('t', target)] })] })
  const byGlob = dismissedBy({ glob: 'src/**' })
  assert.deepEqual(owedLeft(byGlob), ['lib/d.ts'])
  assert.equal(byGlob.asks.t.dismissed[0].closes, 2, 'the two files it closed')
  assert.deepEqual(owedLeft(dismissedBy({ path: 'src' })), ['lib/d.ts'])
  assert.deepEqual(owedLeft(dismissedBy({ path: 'lib/d.ts' })), ['src/a.ts', 'src/b/c.ts'])
})

test('an outside_scope call covers no owed file and is not in looked', () => {
  const calls = [refusedCall(1, ['t'], 'read', { path: 'lib/d.ts', from: 1, to: 0 }), refusedCall(2, ['t'], 'grep', GREP_ARGS('foo', ['src', 'lib']))]
  const l = owed(calls, { owes: ['src/a.ts', 'lib/d.ts'], scope: ['src'] })
  assert.deepEqual(owedLeft(l), ['lib/d.ts', 'src/a.ts'])
  assert.deepEqual(lookedOf(l, 't'), [])
})

test('covered says what each directory rests on', () => {
  const calls = [
    grep(1, ['t'], [], { pattern: 'foo', paths: ['src'] }), read(2, ['t'], 'lib/d.ts', 1, 40, 40),
    grep(3, ['t'], [], { pattern: 'foo', paths: ['src/b'] }),
  ]
  const l = owed(calls)
  const c = l.asks.t.covered
  assert.deepEqual(Object.keys(c).sort(), ['lib', 'src', 'src/b'])
  assert.deepEqual(['lib', 'src', 'src/b'].map((dir) => c[dir].files), [1, 1, 1])
  assert.ok(c.src.by.includes('grep foo'), JSON.stringify(c.src))
  assert.ok(c['src/b'].by.includes('grep foo'), JSON.stringify(c['src/b']))
  assert.ok(c.lib.by.some((s) => s.startsWith('read lib/d.ts:')), JSON.stringify(c.lib))
  assert.equal(c.lib.by.includes('grep foo'), false, 'lib rests on the read alone')
  for (const dir of Object.keys(c)) assert.equal(new Set(c[dir].by).size, c[dir].by.length, dir + ': the distinct strings, once each')
  assert.deepEqual(owedLeft(l), [])
})

test('covered counts the files a directory has covered, not the calls', () => {
  const calls = [
    grep(1, ['t'], [], { pattern: 'one', paths: ['src/a.ts'] }), grep(2, ['t'], [], { pattern: 'two', paths: ['src/a.ts'] }),
    grep(3, ['t'], [], { pattern: 'three', paths: ['src'] }),
  ]
  const at = (n) => owed(calls.slice(0, n), { owes: ['src/a.ts', 'src/b.ts'] }).asks.t.covered
  assert.equal(at(1).src.files, 1)
  assert.equal(at(2).src.files, 1, 'a second query over the same file')
  assert.deepEqual(sorted(at(2).src.by), ['grep one', 'grep two'])
  assert.equal(at(3).src.files, 2)
})

test('owes only without rows', () => {
  const own = fold({ asks: [owing('t', OWED)], ground: ground(pathRow('src/a.ts', true, ['t'])) })
  assert.deepEqual(front(own, 't'), ['ground src/a.ts'], 'an ask with its own row owes that row, not the scope')
  const others = ground(pathRow('src/a.ts', true, ['x']), pathRow('docs/context.md', true, []))
  const l = fold({ asks: [owing('t', OWED), ask('x')], ground: others })
  assert.deepEqual(owedLeft(l), sorted(OWED), "another ask's row and a row only context named are not this ask's rows")
  assert.deepEqual(keysOf(l, 't', 'ground'), [])
})

test('the owes list is the journal: the fold neither changes it nor depends on its order', () => {
  const x = { asks: [owing('t', [...OWED])], calls: [grep(1, ['t'], [], { pattern: 'foo', paths: ['src'] })], turns: [ret(1, 1)] }
  const frozen = JSON.stringify(x)
  const l = fold(x)
  assert.equal(JSON.stringify(x), frozen)
  assert.deepEqual(fold(structuredClone(x)), l)
  const flipped = fold({ ...x, asks: [owing('t', [...OWED].reverse())] })
  assert.deepEqual(owedLeft(flipped), owedLeft(l))
  assert.deepEqual(flipped.asks.t.covered, l.asks.t.covered)
  assert.equal(flipped.asks.t.stamp, l.asks.t.stamp)
})

// ---- what an ask looked for (N3)

test('looked lists what was looked for', () => {
  const calls = [
    grep(1, ['a'], [['src/a.ts', 2]], { pattern: 'seatDay' }),
    filesCall(2, ['a', 'b'], 'src/**/*.ts', ['src/a.ts', 'src/b.ts']),
    refsCall(3, ['a'], 'composeArea', ['src/m.ts']),
    grep(4, ['b'], [], { pattern: 'only b' }),
    grep(5, ['a'], [['src/late.ts', 1]], { pattern: 'after the turn' }),
  ]
  const l = fold({ asks: [ask('a', { scope: ['src'] }), ask('b', { scope: ['src'] })], calls: [...calls].reverse(), turns: [ret(1, 4)] })
  const row = (e) => [e.seq, e.tool, e.what, e.total]
  assert.deepEqual(lookedOf(l, 'a').map(row), [[1, 'grep', 'seatDay', 1], [2, 'files', 'src/**/*.ts', 2], [3, 'refs', 'composeArea', 1]])
  assert.deepEqual(lookedOf(l, 'b').map(row), [[2, 'files', 'src/**/*.ts', 2], [4, 'grep', 'only b', 0]])
  for (const e of [...lookedOf(l, 'a'), ...lookedOf(l, 'b')]) assert.ok(Array.isArray(e.where), 'seq ' + e.seq + ' has a where')
})

test('looked holds ok calls only', () => {
  const calls = [
    grep(1, ['a'], [['src/a.ts', 2]], { pattern: 'kept' }), refusedCall(2, ['a', 'b'], 'grep', GREP_ARGS('refused'), 'unsupported_syntax'),
    grep(3, ['a'], [['src/b.ts', 4]], { pattern: 'also kept' }),
  ]
  const l = fold({ asks: [ask('a'), ask('b')], calls, turns: [ret(1, 3)] })
  assert.deepEqual(lookedOf(l, 'a').map((e) => e.seq), [1, 3])
  assert.deepEqual(lookedOf(l, 'b'), [])
})

test('what and where per tool', () => {
  const url = 'https://github.com/pmndrs/zustand'
  const calls = [
    grep(1, ['a'], [['src/a.ts', 2]], { pattern: 'seatDay' }), filesCall(2, ['a'], 'src/**/*.ts', ['src/a.ts']),
    refsCall(3, ['a'], 'composeArea', ['src/m.ts']), read(4, ['a'], 'src/a.ts', 3, 9, 40), fetchCall(5, ['w'], url),
  ]
  const l = fold({ asks: [ask('a', { scope: ['src', 'lib'] }), ask('w', { domain: 'web', scope: [] })], calls, turns: [ret(1, 5)] })
  assert.deepEqual(lookedOf(l, 'a').map((e) => [e.tool, e.what]), [['grep', 'seatDay'], ['files', 'src/**/*.ts'], ['refs', 'composeArea'], ['read', 'src/a.ts:3-9']])
  assert.deepEqual(lookedOf(l, 'w').map((e) => [e.tool, e.what]), [['fetch', url]])
  assert.deepEqual(lookedOf(l, 'a')[0].where, ['src', 'lib'], 'a grep with no paths looked in the ask scope')
})

test('where per tool', () => {
  const url = 'https://github.com/pmndrs/zustand'
  const calls = [
    grep(1, ['a'], [['src/a.ts', 2]], { paths: ['src', 'lib'] }), filesCall(2, ['a'], 'src/**/*.ts', ['src/a.ts']),
    refsCall(3, ['a'], 'composeArea', ['src/m.ts']), read(4, ['a'], 'src/a.ts', 3, 9, 40),
    logCall(5, ['h'], 'seatDay', ['lib']), showCall(6, ['h'], SHA, 'src/a.ts'), fetchCall(7, ['w'], url),
  ]
  const asks = [ask('a'), ask('h', { domain: 'history' }), ask('w', { domain: 'web', scope: [] })]
  const l = fold({ asks, calls, turns: [ret(1, 7)] })
  assert.deepEqual(lookedOf(l, 'a').map((e) => [e.tool, e.where]), [['grep', ['src', 'lib']], ['files', []], ['refs', []], ['read', ['src/a.ts']]])
  assert.deepEqual(lookedOf(l, 'h').map((e) => [e.tool, e.where]), [['log', ['lib']], ['show', [SHA]]])
  assert.deepEqual(lookedOf(l, 'w').map((e) => [e.tool, e.where]), [['fetch', [url]]])
})

test('looked counts pages seen', () => {
  const page = (seq, n) => grep(seq, ['a'], [['src/p' + n + '.js', 1]], { pattern: 'big', page: n, pages: 3, total: 600 })
  const l = fold({ calls: [page(1, 1), page(2, 3)], turns: [ret(1, 2)] })
  const mine = lookedOf(l, 'a').filter((e) => e.what === 'big')
  assert.ok(mine.length >= 1)
  for (const e of mine) {
    assert.equal(e.pages, 3)
    assert.ok(e.pages_seen >= 1 && e.pages_seen <= 2, 'pages_seen ' + e.pages_seen + ' of the two fetched')
  }
  assert.equal(Math.max(...mine.map((e) => e.pages_seen)), 2, 'pages 1 and 3 are two pages seen')
  const whole = fold({ calls: [grep(1, ['a'], [['src/a.js', 1]], { pattern: 'small' })], turns: [ret(1, 1)] })
  assert.deepEqual(lookedOf(whole, 'a').map((e) => [e.pages, e.pages_seen]), [[1, 1]])
})

test('what for history and web tools', () => {
  const calls = [logCall(1, ['h'], 'seatDay'), showCall(2, ['h'], SHA, 'src/a.ts'), showCall(3, ['h'], SHA), websearch(4, ['w'], 'zustand vs jotai')]
  const l = fold({ asks: [ask('h', { domain: 'history' }), ask('w', { domain: 'web', scope: [] })], calls, turns: [ret(1, 4)] })
  assert.deepEqual(lookedOf(l, 'h').map((e) => [e.tool, e.what]), [['log', 'seatDay'], ['show', SHA + ' src/a.ts'], ['show', SHA]])
  assert.deepEqual(lookedOf(l, 'w').map((e) => [e.tool, e.what]), [['websearch', 'zustand vs jotai']])
})

test('a websearch is search-wide', () => {
  const search = { ...websearch(2, [], 'zustand vs jotai'), from_log: 7 }
  const x = { asks: [ask('a'), ask('w', { domain: 'web', scope: [] })], calls: [move(1, 'a'), search], turns: [ret(1, 2)] }
  const l = fold(x)
  assert.deepEqual(l.queries.map((c) => [c.seq, c.tool]), [[2, 'websearch']], 'the view holds it, and not a call that names an ask')
  for (const k of ['a', 'w']) assert.equal(lookedOf(l, k).some((e) => e.tool === 'websearch'), false, k)
  const without = fold({ ...x, calls: [x.calls[0]] })
  for (const k of ['a', 'w']) assert.equal(l.asks[k].stamp, without.asks[k].stamp, k + ' stamp')
  assert.deepEqual(without.queries, [])
})

// ---- the stamp (N4)

test('a new query moves the stamp', () => {
  const zero = (seq, pattern) => grep(seq, ['a'], [], { pattern })
  const x = { calls: [move(1, 'a'), zero(2, 'no such name'), zero(3, 'nor this'), zero(4, 'nor that')], turns: [ret(1, 1), ret(2, 2), ret(3, 3), ret(4, 4)] }
  assert.equal(new Set(stampsOf(x)).size, 4, 'each 0-hit grep of a new pattern is new evidence')
  const l = fold(x)
  assert.equal(l.asks.a.end, null, 'an ask exploring with new queries is not stalled')
  assert.deepEqual(l.asks.a.observed, fold({ ...x, turns: x.turns.slice(0, 1) }).asks.a.observed, 'the greps showed nothing: it is the queries that moved it')
})

test('a repeat moves nothing', () => {
  const first = grep(2, ['a'], [], { pattern: 'same' })
  const x = { calls: [move(1, 'a'), first, { ...first, seq: 3, repeat_of: 2 }, { ...first, seq: 4 }], turns: [ret(1, 1), ret(2, 2), ret(3, 3), ret(4, 4)] }
  const [one, afterFirst, afterRepeat, afterAgain] = stampsOf(x)
  assert.notEqual(afterFirst, one, 'the first run is new')
  assert.equal(afterRepeat, afterFirst, 'a repeat_of record')
  assert.equal(afterAgain, afterFirst, 'the same tool and args again')
})

test('a later page is the same query', () => {
  const seen = [['moved/1.js', 1]]
  const page = (seq, n, shown = seen) => grep(seq, ['a'], shown, { pattern: 'big', page: n, pages: 3, total: 600 })
  const same = { calls: [move(1, 'a'), page(2, 1), page(3, 2)], turns: [ret(1, 1), ret(2, 2), ret(3, 3)] }
  const [afterMove, afterPage1, afterPage2] = stampsOf(same)
  assert.notEqual(afterPage1, afterMove, 'page 1 is a query the ask had not run')
  assert.equal(afterPage2, afterPage1, 'page 2 ran no new query and showed no line the ask had not seen')
  const fresh = { ...same, calls: [move(1, 'a'), page(2, 1), page(3, 2, [['src/r.js', 3]])] }
  const [, freshPage1, freshPage2] = stampsOf(fresh)
  assert.notEqual(freshPage2, freshPage1, 'a line page 2 shows that was not seen still moves it')
})

test('a query differs by any argument but the page, and not by the order the arguments were written in', () => {
  const base = grep(1, ['a'], [], { pattern: 'foo' })
  const stampWith = (args) => fold({ calls: [base, { ...base, seq: 2, args }], turns: [ret(1, 1), ret(2, 2)] }).asks.a.stamp
  const alone = fold({ calls: [base], turns: [ret(1, 1)] }).asks.a.stamp
  const variants = { 'other paths': { ...base.args, paths: ['src'] }, 'ignore_case': { ...base.args, ignore_case: true }, 'fixed': { ...base.args, fixed: true }, 'other pattern': { ...base.args, pattern: 'bar' } }
  for (const [what, args] of Object.entries(variants)) assert.notEqual(stampWith(args), alone, what)
  assert.equal(stampWith({ page: 1, paths: [], ignore_case: false, fixed: false, pattern: 'foo' }), alone, 'the same arguments in another order')
  assert.equal(stampWith({ ...base.args, page: 2 }), alone, 'page 2')
})

test('a refused call is no query, and a query under another ask is not this ask\'s', () => {
  const refused = { calls: [move(1, 'a'), refusedCall(2, ['a'], 'grep', GREP_ARGS('refused pattern'), 'unsupported_syntax')], turns: [ret(1, 1), ret(2, 2)] }
  const [one, two] = stampsOf(refused)
  assert.equal(two, one, 'a refused call ran nothing')
  const other = { asks: [ask('a'), ask('b')], calls: [move(1, ['a', 'b']), grep(2, ['b'], [], { pattern: 'only b' })], turns: [ret(1, 1), ret(2, 2)] }
  const [a1, a2] = stampsOf(other, 'a')
  const [b1, b2] = stampsOf(other, 'b')
  assert.equal(a2, a1)
  assert.notEqual(b2, b1)
})

test('a declaration changed back restores the stamp', () => {
  const x = {
    ground: ground(pathRow('src/a.ts')), calls: [move(1, 'a')],
    turns: [ret(1, 1, { asks: [declare('a', 'answered')] }), ret(2, 1, { asks: [declare('a', 'open')] }), ret(3, 1, { asks: [declare('a', 'answered')] })],
  }
  const [first, second, third] = stampsOf(x)
  assert.notEqual(second, first, 'the declaration is in the stamp')
  assert.equal(third, first)
})

test('a dismissal that closes nothing moves nothing', () => {
  const base = { calls: [move(1, 'a')], turns: [ret(1, 1)] }
  const before = fold(base).asks.a.stamp
  for (const target of [{ path: 'nowhere/x.ts' }, { glob: 'nowhere/**' }]) {
    const l = fold({ ...base, turns: [...base.turns, ret(2, 1, { dismissed: [dismiss('a', target, 'a dead end')] })] })
    const what = JSON.stringify(target)
    assert.equal(l.asks.a.stamp, before, what)
    assert.equal(l.asks.a.dismissed.length, 1, what + ' is kept')
    assert.equal(l.asks.a.dismissed[0].closes, 0, what)
    assert.equal(l.asks.a.dismissed[0].why, 'a dead end', what)
    assert.deepEqual(l.refusals, [], what + ' is no refusal')
    assert.deepEqual(coverageLines(l, NAME).unreached.filter((u) => u.includes('nowhere')), [], what + ' is no unreached line')
  }
})

test('fresh empty dismissals never move the stamp', () => {
  const stamps = stampsOver40((n) => ({ dismissed: [dismiss('a', { path: 'nowhere/' + n + '.ts' })] }))
  assert.equal(stamps.length, 41)
  assert.equal(new Set(stamps).size, 1)
})

test('fresh empty glob dismissals never move the stamp', () => {
  const stamps = stampsOver40((n) => ({ dismissed: [dismiss('a', { glob: 'nowhere' + n + '/**' })] }))
  assert.equal(stamps.length, 41)
  assert.equal(new Set(stamps).size, 1)
})

test('refused citations never move the stamp', () => {
  const stamps = stampsOver40((n) => ({ hits: [hit('a', 'src/x.ts', n)] }))
  assert.equal(stamps.length, 41)
  assert.equal(new Set(stamps).size, 1)
  const turns = [ret(1, 1)]
  for (let n = 2; n <= 41; n++) turns.push(ret(n, 1, { hits: [hit('a', 'src/x.ts', n)] }))
  const l = fold({ calls: [move(1, 'a')], turns })
  assert.ok(classes(l).includes('unobserved'), 'the refusals are recorded')
  assert.notEqual(l.asks.a.refused, fold({ calls: [move(1, 'a')], turns: turns.slice(0, 1) }).asks.a.refused, 'in the refused digest, not the stamp')
})

test('a dismissal moves the stamp by what it closes', () => {
  const x = {
    ground: ground(pathRow('src/a.ts')), calls: [move(1, 'a')],
    turns: [ret(1, 1), ret(2, 1, { dismissed: [dismiss('a', { glob: 'src/**' })] }), ret(3, 1, { dismissed: [dismiss('a', { glob: 'src/*.ts' })] })],
  }
  const [one, two, three] = stampsOf(x)
  assert.notEqual(two, one, 'it closed an agenda item')
  assert.equal(three, two, 'the same item again, by another glob')
  const l = fold(x)
  assert.equal(l.asks.a.dismissed[0].closes, 1)
  assert.deepEqual(agendaOf(l, 'a'), [])
})

test('history records refused citations', () => {
  const x = {
    calls: [move(1, 'a'), move(2, 'a'), move(3, 'a'), move(4, 'a')],
    turns: [
      ret(1, 1), ret(2, 2, { hits: [hit('a', 'src/nowhere.js', 3, 'one wording')] }),
      ret(3, 3, { hits: [hit('a', 'src/nowhere.js', 3, 'another wording')] }), ret(4, 4, { hits: [hit('a', 'src/elsewhere.js', 5)] }),
    ],
  }
  const l = fold(x)
  const history = l.asks.a.history
  assert.deepEqual(history.map((h) => h.turn), [0, 1, 2, 3, 4])
  for (const h of history) assert.ok(Object.hasOwn(h, 'refused'), 'turn ' + h.turn)
  const [r0, r1, r2, r3, r4] = history.map((h) => h.refused)
  assert.equal(r1, r0, 'nothing refused yet')
  assert.notEqual(r2, r1, 'a citation was refused')
  assert.equal(r3, r2, 'the same citation in other words is the same refusal')
  assert.notEqual(r4, r3, 'another citation was refused')
  assert.notEqual(r4, r2)
  assert.equal(l.asks.a.refused, r4, 'the view holds the latest')
})
