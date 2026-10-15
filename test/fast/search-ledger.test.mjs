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
/** An ask that holds its material as a closed seed, so its scope is no frontier of its own; `bare` builds one that has nothing. */
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
const front = (l, a) => l.asks[a].frontier.map((f) => f.kind + ' ' + f.key)
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
  assert.equal(l.asks.b.end, null, 'b moved at turn 2')
  assert.equal(l.asks.a.end.state, 'no_progress', 'a already had them')
  assert.equal(l.asks.a.end.turn, 2)
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

test('an item naming only ended asks is refused names_only_ended_asks; naming an ended and an open ask, it applies to the open one', () => {
  const l = fold({
    asks: [ask('a'), ask('b')],
    turns: [ret(1, 0, { asks: [declare('a', 'answered')] }), ret(2, 0, { dismissed: [dismiss('a', { path: 'x.js' }), dismiss(['a', 'b'], { path: 'y.js' })] })],
  })
  assert.equal(l.asks.a.end.turn, 1)
  assert.deepEqual(classes(l), ['names_only_ended_asks'])
  assert.deepEqual(l.asks.b.dismissed.map((d) => d.key), ['y.js'])
  assert.deepEqual(l.asks.a.dismissed, [])
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

test('a re-reported hit in new words adds nothing: the first note stands and the ask ends no_progress', () => {
  const l = fold({
    calls: [grep(1, ['a'], [['src/a.js', 7]])],
    turns: [ret(1, 1, { hits: [hit('a', 'src/a.js', 7, 'first')] }), ret(2, 1, { hits: [hit('a', 'src/a.js', 7, 'the same, reworded')] })],
  })
  assert.deepEqual(l.asks.a.hits.map((h) => h.note), ['first'])
  assert.deepEqual([l.asks.a.end.state, l.asks.a.end.turn], ['no_progress', 2])
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

// ------------------------------------------------------------------ frontier

test("a lead is on its ask's frontier until a read of it under that ask, or a dismissal", () => {
  const x = { asks: [ask('a'), ask('b')], calls: [move(1, 'a')], turns: [ret(1, 1, { leads: [{ ask: 'a', path: 'src/lead.js', why: 'imports the store' }] })] }
  assert.deepEqual(front(fold(x), 'a'), ['lead src/lead.js'])
  const byB = fold({ ...x, calls: [...x.calls, read(2, ['b'], 'src/lead.js', 1, 3, 40)], turns: [...x.turns, ret(2, 2)] })
  assert.deepEqual(front(byB, 'a'), ['lead src/lead.js'], 'a read under b does not read it for a')
  const byA = fold({ ...x, calls: [...x.calls, read(2, ['a'], 'src/lead.js', 1, 3, 40)], turns: [...x.turns, ret(2, 2)] })
  assert.deepEqual(front(byA, 'a'), [], 'a partial read is a read of a lead')
  const dropped = fold({ ...x, turns: [...x.turns, ret(2, 1, { dismissed: [dismiss('a', { path: 'src/lead.js' })] })] })
  assert.deepEqual(front(dropped, 'a'), [])
})

test('unfetched overflow pages are frontier, one per page, until fetched under the ask or their call is dismissed', () => {
  const big = (seq, a, page) => grep(seq, [a], [['src/p' + page + '.js', 1]], { pattern: 'big', page, pages: 3, total: 600 })
  const calls = [big(1, 'a', 1), big(2, 'a', 2), big(3, 'b', 3)]
  const l = fold({ asks: [ask('a'), ask('b')], calls, turns: [ret(1, 3)] })
  assert.deepEqual(l.asks.a.frontier.map((f) => [f.kind, f.key, f.detail]), [['overflow', 'call:1', 'page 3 of 3']])
  assert.deepEqual(l.asks.b.frontier.map((f) => [f.kind, f.key, f.detail]), [['overflow', 'call:3', 'page 1 of 3'], ['overflow', 'call:3', 'page 2 of 3']])
  const d = fold({ asks: [ask('a'), ask('b')], calls, turns: [ret(1, 3, { dismissed: [dismiss('a', { call: 2 })] })] })
  assert.deepEqual(d.asks.a.frontier, [], 'any call of the query closes its pages')
})

const GROUND = ground(
  pathRow('src/drop/stall.ts', true, ['s', 'all']), pathRow('src/drop/new.ts', false, ['s']),
  symbolRow('ITEM_STAND', [['src/data/items.ts', 12], ['src/data/items.ts', 40]], ['s', 'all']),
  pathRow('docs/kb/MODULE_MAP.md', true, ['all']),
  pathRow('docs/context.md', true, []),
  pathRow('src/elsewhere.ts', true, ['h', 'w']),
)

test("a repo ask's own ground rows are its frontier: a path's key, a symbol's definition files", () => {
  const l = fold({ asks: [ask('s', { scope: ['src'] }), ask('all')], ground: GROUND })
  assert.deepEqual(front(l, 's'), ['ground src/drop/stall.ts', 'ground src/data/items.ts'])
  assert.deepEqual(front(l, 'all'), ['ground src/drop/stall.ts', 'ground src/data/items.ts', 'ground docs/kb/MODULE_MAP.md'])
})

test("another ask's row, a row only context material named, a missing path, and every row of a history or web ask stay off the frontier", () => {
  const l = fold({ asks: [ask('s'), ask('x'), ask('h', { domain: 'history' }), ask('w', { domain: 'web', scope: [] })], ground: GROUND })
  assert.deepEqual(front(l, 's'), ['ground src/drop/stall.ts', 'ground src/data/items.ts'])
  assert.deepEqual(front(l, 'x'), [])
  assert.deepEqual(front(l, 'h'), [])
  assert.deepEqual(front(l, 'w'), [])
})

/** A symbol row whose references the resolver found in `files`. */
const referenced = (mention, defs, files, asks = ['a']) => ({ ...symbolRow(mention, defs, asks), refs: files.map((key) => ({ key, count: 1, test: false })), files: files.length })
const refsCall = (seq, asks, symbol, files) => ({ seq, tool: 'refs', args: { symbol }, asks, ok: true, total: files.length, observed: [], keys: files })

test('a symbol the material names with reference sites is one frontier item until a refs call of it under the ask', () => {
  const g = ground(referenced('composeArea', [['src/area.ts', 3]], ['src/meadow.ts', 'src/install.ts'], ['a', 'b']))
  const before = fold({ asks: [ask('a'), ask('b')], ground: g })
  assert.deepEqual(front(before, 'a'), ['ground src/area.ts', 'ground symbol:composeArea'])
  const after = fold({ asks: [ask('a'), ask('b')], ground: g, calls: [refsCall(1, ['a'], 'composeArea', ['src/meadow.ts', 'src/install.ts'])], turns: [ret(1, 1)] })
  assert.deepEqual(front(after, 'a'), ['ground src/area.ts'])
  assert.deepEqual(front(after, 'b'), ['ground src/area.ts', 'ground symbol:composeArea'], 'the call named a only')
})

test("a grep whose pattern names the symbol closes its item; one naming another symbol does not", () => {
  const g = ground(referenced('composeArea', [], ['src/meadow.ts']))
  const by = (pattern) => fold({ ground: g, calls: [grep(1, ['a'], [['src/meadow.ts', 8]], { pattern })], turns: [ret(1, 1)] })
  assert.deepEqual(front(by('\bcomposeArea\('), 'a'), [])
  assert.deepEqual(front(by('composeEndless'), 'a'), ['ground symbol:composeArea'])
  const dismissed = fold({ ground: g, calls: [move(1, 'a')], turns: [ret(1, 1, { dismissed: [dismiss('a', { path: 'symbol:composeArea' })] })] })
  assert.deepEqual(front(dismissed, 'a'), [], 'a dismissal of the item closes it')
})

test('following a symbol moves the stamp even when its reference files were already observed', () => {
  const g = ground(referenced('composeArea', [], ['src/meadow.ts']))
  const l = fold({ ground: g, calls: [listed(1, ['a'], ['src/meadow.ts']), refsCall(2, ['a'], 'composeArea', ['src/meadow.ts'])], turns: [ret(1, 1), ret(2, 2)] })
  assert.equal(l.asks.a.end, null, 'turn 2 followed the symbol: progress, not no_progress')
})

const filesCall = (seq, asks, glob, keys = []) => ({ seq, tool: 'files', args: { glob, page: 1 }, asks, ok: true, total: keys.length, page: 1, pages: 1, observed: [], keys })

test('a repo ask with no seed and no ground row of its own has each scope root on its frontier', () => {
  const l = fold({ asks: [bare('t', { scope: ['src', 'lib'] }), bare('w', { domain: 'web', scope: [] })], ground: ground(pathRow('src/a.ts', true, [])) })
  assert.deepEqual(front(l, 't'), ['scope src', 'scope lib'])
  assert.deepEqual(front(l, 'w'), [])
  assert.deepEqual(front(fold({ asks: [bare('a')], ground: ground(pathRow('src/a.ts')) }), 'a'), ['ground src/a.ts'], 'an ask with its own rows has no scope item')
  assert.deepEqual(front(fold({ asks: [ask('a')] }), 'a'), [], 'nor one with a seed')
})

test('a grep over the whole root, or a files glob that recurses from it, closes its scope item; a narrower call does not', () => {
  const t = bare('t', { scope: ['src'] })
  const by = (call) => front(fold({ asks: [t], calls: [call], turns: [ret(1, 1)] }), 't')
  assert.deepEqual(by(grep(1, ['t'], [['src/a.ts', 1]])), [], 'no paths: the whole scope')
  assert.deepEqual(by(grep(1, ['t'], [['src/a.ts', 1]], { paths: ['src'] })), [])
  assert.deepEqual(by(grep(1, ['t'], [['src/game/a.ts', 1]], { paths: ['src/game'] })), ['scope src'])
  assert.deepEqual(by(filesCall(1, ['t'], 'src/**/*.ts', ['src/a.ts'])), [])
  assert.deepEqual(by(filesCall(1, ['t'], '**/index.ts', ['src/index.ts'])), [])
  assert.deepEqual(by(filesCall(1, ['t'], 'src/game/*.ts', ['src/game/a.ts'])), ['scope src'])
  assert.deepEqual(by(grep(1, ['x'], [['src/a.ts', 1]])), ['scope src'], 'a call under another ask')
})

test('a dismissal of the root closes its scope item, and a scope item nobody looked at is unreached at the end', () => {
  const t = bare('t', { scope: ['src'] })
  const dismissed = fold({ asks: [t], calls: [move(1, 't')], turns: [ret(1, 1, { dismissed: [dismiss('t', { path: 'src' })] })] })
  assert.deepEqual(front(dismissed, 't'), [])
  const idle = fold({ asks: [t], turns: [ret(1, 0, { asks: [declare('t', 'open')] }), ret(2, 0, { asks: [declare('t', 'open')] })] })
  assert.equal(idle.asks.t.end.state, 'no_progress')
  assert.ok(coverageLines(idle, NAME).unreached.some((u) => u.endsWith(':t: scope src (' + idle.asks.t.frontier[0].detail + ')')))
})

test('a symbol with no reference site is no frontier item of its own', () => {
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

test('an open seed is frontier until closed; a closed seed never is, even when it is a ground row', () => {
  const g = ask('g', { seeds: [{ key: 'CLAUDE.md', as: 'open', reason: 'guidance' }, { key: 'docs/drop/DESIGN.md', as: 'closed', reason: "the probe's artefact, held whole by its probers" }] })
  const x = { asks: [g], ground: ground(pathRow('docs/drop/DESIGN.md', true, ['g']), pathRow('src/a.ts', true, ['g'])) }
  assert.deepEqual(front(fold(x), 'g'), ['seed CLAUDE.md', 'ground src/a.ts'])
  const readIt = fold({ ...x, calls: [read(1, ['g'], 'CLAUDE.md', 1, 12, 12)], turns: [ret(1, 1)] })
  assert.deepEqual(front(readIt, 'g'), ['ground src/a.ts'])
})

test('a frontier key appears once, under the first of seed, lead and ground', () => {
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

test('a glob dismissal closes keys by git glob rules: * stays inside a segment, ** crosses directories', () => {
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
  assert.deepEqual([l.asks.a.end.state, l.asks.a.end.turn], ['no_progress', 2])
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

test('absent is checked when a grep under the ask over its whole scope matched nothing, and declared otherwise', () => {
  const asks = [ask('a', { scope: ['src'] }), ask('b', { scope: ['src'] }), ask('c', { scope: ['src'] })]
  const calls = [grep(1, ['a'], [], { paths: [] }), grep(2, ['b'], [], { paths: ['src'] })]
  const l = fold({ asks, calls, turns: [ret(1, 2, { asks: [declare('a', 'absent'), declare('b', 'absent'), declare('c', 'absent')] })] })
  assert.deepEqual(['a', 'b', 'c'].map((k) => l.asks[k].absence), ['checked', 'checked', 'declared'])
  assert.deepEqual(['a', 'b', 'c'].map((k) => l.asks[k].end.state), ['done', 'done', 'done'])
})

test('a grep over part of the scope, or one that matched, does not check an absence', () => {
  const asks = [ask('a', { scope: ['src'] }), ask('b', { scope: ['src'] })]
  const calls = [grep(1, ['a'], [], { paths: ['src/core'] }), grep(2, ['b'], [['src/x.js', 4]], { paths: [] })]
  const l = fold({ asks, calls, turns: [ret(1, 2, { asks: [declare('a', 'absent'), declare('b', 'absent')] })] })
  assert.deepEqual([l.asks.a.absence, l.asks.b.absence], ['declared', 'declared'])
})

test('a hit accepted after a standing absent withdraws the absence', () => {
  const x = {
    ground: ground(pathRow('src/a.ts')), calls: [grep(1, ['a'], []), grep(2, ['a'], [['src/b.ts', 4]])],
    turns: [ret(1, 1, { asks: [declare('a', 'absent')] }), ret(2, 2, { hits: [hit('a', 'src/b.ts', 4)] })],
  }
  const first = fold({ ...x, turns: x.turns.slice(0, 1) })
  assert.deepEqual([first.asks.a.declared, first.asks.a.absence, first.asks.a.end], ['absent', 'checked', null])
  const l = fold(x)
  assert.deepEqual([l.asks.a.declared, l.asks.a.absence, l.asks.a.end], ['', '', null])
})

// ------------------------------------------------------------------ ending

test('done: answered or absent with an empty frontier ends the ask done at that turn', () => {
  const l = fold({ asks: [ask('a'), ask('b')], calls: [grep(1, ['b'], [])], turns: [ret(1, 1, { asks: [declare('a', 'answered'), declare('b', 'absent')] })] })
  assert.deepEqual(stateOf(l, { turn: 1, checkin: false }).ending.map(({ ask: a, state, label }) => [a, state, label]),
    [['a', 'done', 'declared'], ['b', 'done', 'observed']])
  assert.equal(typeof l.asks.a.end.why, 'string')
})

test('done waits while the frontier holds anything', () => {
  const x = { ground: ground(pathRow('src/a.ts')), turns: [ret(1, 0, { asks: [declare('a', 'answered')] }), ret(2, 0, { dismissed: [dismiss('a', { path: 'src/a.ts' })] })] }
  assert.equal(fold({ ...x, turns: x.turns.slice(0, 1) }).asks.a.end, null)
  assert.deepEqual([fold(x).asks.a.end.state, fold(x).asks.a.end.turn], ['done', 2])
})

test('a turn whose only act is answered, on an ask with an empty frontier, ends it done and not no_progress', () => {
  const l = fold({ calls: [move(1, 'a')], turns: [ret(1, 1), ret(2, 1, { asks: [declare('a', 'answered')] })] })
  assert.deepEqual([l.asks.a.end.state, l.asks.a.end.turn], ['done', 2])
})

test('no_progress: a worked ask whose state equals its state after an earlier return ends no_progress, observed', () => {
  const first = grep(1, ['a'], [['src/a.js', 1]])
  const l = fold({
    calls: [first, { ...first, seq: 2, repeat_of: 1 }],
    turns: [ret(1, 1, { hits: [hit('a', 'src/a.js', 1, 'first')] }), ret(2, 2, { hits: [hit('a', 'src/a.js', 1, 'again, in other words')] })],
  })
  assert.deepEqual([l.asks.a.end.state, l.asks.a.end.turn, l.asks.a.end.label], ['no_progress', 2, 'observed'])
})

test('no_progress catches a declaration that returns to an earlier state', () => {
  const l = fold({
    ground: ground(pathRow('src/a.ts')), calls: [move(1, 'a')],
    turns: [ret(1, 1, { asks: [declare('a', 'answered')] }), ret(2, 1, { asks: [declare('a', 'open')] }), ret(3, 1, { asks: [declare('a', 'answered')] })],
  })
  assert.deepEqual([l.asks.a.end.state, l.asks.a.end.turn], ['no_progress', 3])
})

test('an ask the turn did not work stays open while another ask moves', () => {
  const l = fold({ asks: [ask('a'), ask('b')], calls: [move(1, 'a'), move(2, 'a'), move(3, 'a')], turns: [ret(1, 1), ret(2, 2), ret(3, 3)] })
  assert.deepEqual([l.asks.a.end, l.asks.b.end], [null, null])
})

test('a quiet turn, with no call and no item, ends every open ask no_progress', () => {
  const l = fold({ asks: [ask('a'), ask('b')], calls: [move(1, 'a')], turns: [ret(1, 1), ret(2, 1)] })
  assert.deepEqual([l.asks.a.end.state, l.asks.a.end.turn, l.asks.b.end.state, l.asks.b.end.turn], ['no_progress', 2, 'no_progress', 2])
})

test('a turn whose items name only ended asks named no open ask: it answers for every open ask', () => {
  const l = fold({
    asks: [ask('a'), ask('want:1', { from: 2 })], calls: [move(1, 'a')],
    turns: [ret(1, 1, { asks: [declare('a', 'answered')] }), ret(2, 1, { dismissed: [dismiss('a', { path: 'x.js' })] })],
  })
  assert.deepEqual(classes(l), ['names_only_ended_asks'])
  assert.deepEqual([l.asks['want:1'].end.state, l.asks['want:1'].end.turn], ['no_progress', 2])
})

test('a turn whose only items are refused unobserved, and refused again, ends the asks they name no_progress', () => {
  const l = fold({ asks: [ask('a'), ask('b')], calls: [move(1, ['a', 'b'])], turns: [ret(1, 1), ret(2, 1, { hits: [hit('a', 'src/nowhere.js', 3)] }), ret(3, 1, { hits: [hit('a', 'src/nowhere.js', 3)] })] })
  assert.deepEqual(classes(l), ['unobserved', 'unobserved'])
  assert.deepEqual([l.asks.a.end.state, l.asks.a.end.turn, l.asks.b.end], ['no_progress', 3, null])
})

// ------------------------------------------------------------------ a refusal the navigator has not yet seen

test('a refusal carries the open asks its item named', () => {
  const l = fold({ asks: [ask('a'), ask('b')], calls: [move(1, ['a', 'b'])], turns: [ret(1, 1), ret(2, 1, { hits: [hit(['a', 'b'], 'src/nowhere.js', 3)] })] })
  assert.deepEqual(l.refusals.map((r) => r.asks), [['a', 'b']])
  const contradicted = fold({
    calls: [grep(1, ['a'], [['src/a.js', 3]])],
    turns: [ret(1, 1, { hits: [hit('a', 'src/a.js', 3)] }), ret(2, 1, { asks: [declare('a', 'absent')] })],
  })
  assert.deepEqual(contradicted.refusals.map((r) => [r.class, r.asks]), [['contradicts_hit', ['a']]])
})

test('an ask declared done in the return that cites an unobserved line stays open one more turn, then ends done', () => {
  const calls = [grep(1, ['a'], [['src/a.js', 3]])]
  const first = ret(1, 1, { hits: [hit('a', 'src/b.js', 9)], asks: [declare('a', 'answered')] })
  const one = fold({ calls, turns: [first] })
  assert.deepEqual(classes(one), ['unobserved'])
  assert.equal(one.asks.a.end, null, 'the navigator has not seen the refusal')
  assert.equal(hitsOf(one, 'a').length, 0, 'the hit is not counted')
  const two = fold({ calls, turns: [first, ret(2, 1)] })
  assert.deepEqual([two.asks.a.end.state, two.asks.a.end.turn, two.asks.a.end.label], ['done', 2, 'declared'])
})

test('an ask whose return cites its unread lead without a call stays open one more turn, then ends no_progress', () => {
  const calls = [move(1, 'a')]
  const turns = [ret(1, 1, { leads: [{ ask: 'a', path: 'src/lead.js', why: 'next' }], asks: [declare('a', 'open')] }), ret(2, 1, { hits: [hit('a', 'src/lead.js', 4)] })]
  const two = fold({ calls, turns })
  assert.deepEqual(classes(two), ['unobserved'])
  assert.equal(two.asks.a.end, null)
  const three = fold({ calls, turns: [...turns, ret(3, 1)] })
  assert.deepEqual([three.asks.a.end.state, three.asks.a.end.turn], ['no_progress', 3])
})

test('every kind of item refused unobserved holds its ask open one more turn: a hit, a dismissal, a lead, a declaration', () => {
  const items = {
    'a hit on a line no call showed': { hits: [hit('a', 'src/b.js', 9)] },
    'a dismissal naming no path, glob or call': { dismissed: [{ ask: ['a'], why: 'w' }] },
    'a lead naming no path': { leads: [{ ask: 'a', why: 'w' }] },
    'a declaration that is none of the three': { asks: [{ ask: 'a', declared: 'bogus' }] },
  }
  for (const [what, o] of Object.entries(items)) {
    const l = fold({ calls: [move(1, 'a')], turns: [ret(1, 1), ret(2, 1, o)] })
    assert.deepEqual(classes(l), ['unobserved'], what)
    assert.equal(l.asks.a.end, null, what)
  }
})

test('a refusal of another class does not hold an ask open', () => {
  const calls = [grep(1, ['a'], [['src/a.js', 3]])]
  const l = fold({ calls, turns: [ret(1, 1, { hits: [hit('a', 'src/a.js', 3)] }), ret(2, 1, { asks: [declare('a', 'absent')] })] })
  assert.deepEqual(classes(l), ['contradicts_hit'])
  assert.deepEqual([l.asks.a.end.state, l.asks.a.end.turn], ['no_progress', 2])
})

test('the same refusal again does not hold an ask open: the navigator was shown it', () => {
  const calls = [move(1, 'a')]
  const l = fold({
    calls,
    turns: [ret(1, 1), ret(2, 1, { hits: [hit('a', 'src/lead.js', 4, 'one wording')] }), ret(3, 1, { hits: [hit('a', 'src/lead.js', 4, 'another wording')] })],
  })
  assert.deepEqual([l.asks.a.end.state, l.asks.a.end.turn], ['no_progress', 3])
})

test('a different refusal holds the ask open once more', () => {
  const calls = [move(1, 'a')]
  const l = fold({ calls, turns: [ret(1, 1), ret(2, 1, { hits: [hit('a', 'src/x.js', 4)] }), ret(3, 1, { hits: [hit('a', 'src/y.js', 4)] })] })
  assert.equal(l.asks.a.end, null)
})

test('an ask the refusal does not name still ends on the return that refused another', () => {
  const calls = [move(1, ['a', 'b'])]
  const l = fold({ asks: [ask('a'), ask('b')], calls, turns: [ret(1, 1, { asks: [declare('b', 'open')] }), ret(2, 1, { hits: [hit('a', 'src/nowhere.js', 3)], asks: [declare('b', 'open')] })] })
  assert.equal(l.asks.a.end, null)
  assert.equal(l.asks.b.end.state, 'no_progress')
})

test("the ruler's not_converging and a stop still end an ask the refusal holds open", () => {
  const calls = [move(1, 'a')]
  const turns = [ret(1, 1), ret(2, 1, { hits: [hit('a', 'src/nowhere.js', 3)] })]
  const ruled = fold({ calls, turns, rulings: [{ turn: 2, asks: ['a'], units: [unit('a', 'not_converging')] }] })
  assert.equal(ruled.asks.a.end.state, 'not_converging')
  const stopped = fold({ calls, turns: [...turns, { turn: 3, calls_through: 1, stop: 'brief_over_budget' }] })
  assert.equal(stopped.asks.a.end.state, 'stopped')
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

test('leads and notes do not move the stamp; observed lines, hits, dismissals and declarations do', () => {
  const base = { calls: [grep(1, ['a'], [['src/a.js', 1]])], turns: [ret(1, 1, { hits: [hit('a', 'src/a.js', 1, 'first')] })] }
  const before = fold(base).asks.a.stamp
  const after = (calls, o) => fold({ calls: [...base.calls, ...calls], turns: [...base.turns, ret(2, 1 + calls.length, o)] }).asks.a.stamp
  const line2 = () => grep(2, ['a'], [['src/a.js', 2]])
  assert.equal(after([], { leads: [{ ask: 'a', path: 'src/b.js', why: 'w' }] }), before, 'a lead')
  assert.equal(after([], { hits: [hit('a', 'src/a.js', 1, 'reworded')] }), before, 'a new note')
  assert.notEqual(after([line2()], {}), before, 'a new observed line')
  assert.notEqual(after([line2()], { hits: [hit('a', 'src/a.js', 2)] }), after([line2()], {}), 'a hit')
  assert.notEqual(after([], { dismissed: [dismiss('a', { path: 'src/c.js' })] }), before, 'a dismissal')
  assert.notEqual(after([], { asks: [declare('a', 'open')] }), before, 'a declaration')
})

test("an ended ask takes no new facts: later calls and items naming it change nothing", () => {
  const x = { asks: [ask('a'), ask('b')], calls: [move(1, 'b'), grep(2, ['a', 'b'], [['src/late.js', 5]])], turns: [ret(1, 1, { asks: [declare('a', 'answered')] }), ret(2, 2)] }
  const one = fold({ ...x, turns: x.turns.slice(0, 1) })
  const two = fold(x)
  assert.equal(two.asks.a.end.turn, 1)
  assert.deepEqual(two.asks.a.observed, one.asks.a.observed)
  assert.equal(two.asks.a.stamp, one.asks.a.stamp)
  assert.ok(two.asks.b.observed.includes('src/late.js:5'))
})

test('an ask whose from is k is neither evaluated nor ended before turn k, and is open', () => {
  const asks = [ask('a'), ask('want:1', { from: 3 })]
  const calls = [move(1, 'a'), move(2, 'want:1')]
  const l = fold({ asks, calls, turns: [ret(1, 1), ret(2, 1)] })
  assert.equal(l.asks.a.end.state, 'no_progress')
  assert.equal(l.asks['want:1'].end, null)
  assert.deepEqual(stateOf(l, { turn: 2, checkin: false }).open, ['want:1'])
  assert.equal(fold({ asks, calls, turns: [ret(1, 1), ret(2, 1), ret(3, 2)] }).asks['want:1'].end, null, 'it moved at turn 3')
  assert.equal(fold({ asks, calls, turns: [ret(1, 1), ret(2, 1), ret(3, 1)] }).asks['want:1'].end.state, 'no_progress', 'a quiet turn 3 ends it')
})

test('stateOf reports the endings of the turn it is asked about, and open lists every ask with no end', () => {
  const l = fold({ asks: [ask('a'), ask('b'), ask('c')], calls: [move(1, 'b')], turns: [ret(1, 1, { asks: [declare('a', 'answered')] })] })
  const s = stateOf(l, { turn: 1, checkin: false })
  assert.deepEqual(s.ending.map((e) => [e.ask, e.state]), [['a', 'done']])
  assert.deepEqual(s.toRuler, [])
  assert.deepEqual(s.open, ['b', 'c'])
  assert.deepEqual(stateOf(l, { turn: 2, checkin: false }).ending, [])
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

test('toRuler leaves out an ask that ended at this turn', () => {
  const l = fold({
    asks: [ask('a'), ask('b')], calls: [move(1, ['a', 'b']), move(2, 'a'), move(3, 'a')],
    turns: [ret(1, 1), ret(2, 2), ret(3, 3, { asks: [declare('b', 'answered')] })],
  })
  assert.deepEqual(stateOf(l, { turn: 3, checkin: true }).toRuler, ['a'])
})

test("an ask's previous check-in is the latest ruling that named it", () => {
  const calls = [move(1, ['a', 'b']), move(2, 'a'), move(3, 'a'), move(4, 'a'), move(5, 'a'), move(6, 'a')]
  const l = fold({
    asks: [ask('a'), ask('b')], calls, turns: [1, 2, 3, 4, 5, 6].map((n) => ret(n, n)),
    rulings: [{ turn: 3, asks: ['a', 'b'], units: [unit('a', 'converging'), unit('b', 'converging')] }],
  })
  assert.deepEqual(stateOf(l, { turn: 6, checkin: true }).toRuler, ['a'], 'b has not moved since it was ruled at turn 3')
})

const RULED = { asks: [ask('a'), ask('b')], calls: [move(1, ['a', 'b']), move(2, ['a', 'b']), move(3, ['a', 'b'])], turns: [ret(1, 1), ret(2, 2), ret(3, 3)] }

test("not_converging ends the ask at the ruling's turn, labelled ruled, with the ruler's why; converging leaves it open", () => {
  const l = fold({ ...RULED, rulings: [{ turn: 3, asks: ['a', 'b'], units: [unit('a', 'not_converging', 'every new line is another fixture'), unit('b', 'converging', 'the chain is still opening')] }] })
  assert.deepEqual(l.asks.a.end, { state: 'not_converging', turn: 3, label: 'ruled', why: 'every new line is another fixture' })
  assert.equal(l.asks.b.end, null)
})

test('a ruling that misses an ask ends nothing; a second miss in a row stops it, from the ruler', () => {
  const once = fold({ ...RULED, rulings: [{ turn: 3, asks: ['a', 'b'], missing: 'schema_failed' }] })
  assert.deepEqual([once.asks.a.end, once.asks.b.end], [null, null])
  const twice = fold({ ...RULED, rulings: [{ turn: 3, asks: ['a', 'b'], missing: 'schema_failed' }, { turn: 3, asks: ['a', 'b'], units: [unit('a', 'converging')] }] })
  assert.equal(twice.asks.a.end, null)
  assert.deepEqual([twice.asks.b.end.state, twice.asks.b.end.by, twice.asks.b.end.label], ['stopped', 'ruler', 'observed'])
  const back = fold({ ...RULED, rulings: [{ turn: 3, asks: ['b'], missing: 'x' }, { turn: 3, asks: ['b'], missing: 'y' }, { turn: 3, asks: ['b'], units: [unit('b', 'converging')] }] })
  assert.equal(back.asks.b.end, null, 'a later ruling of it reopens it')
})

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

test('a turn that stopped for an over-budget brief stops every open ask at once, by the navigator', () => {
  const l = fold({ asks: [ask('a'), ask('b')], calls: [move(1, ['a', 'b'])], turns: [ret(1, 1, { asks: [declare('b', 'answered')] }), { turn: 2, calls_through: 1, stop: 'brief_over_budget' }] })
  assert.equal(l.asks.b.end.state, 'done', 'an ask that already ended keeps its end')
  assert.deepEqual(l.asks.a.end, { state: 'stopped', turn: 2, label: 'observed', why: 'brief_over_budget', by: 'navigator' })
  assert.deepEqual(stateOf(l, { turn: 2, checkin: false }).open, [])
  const later = fold({ calls: [move(1, 'a'), move(2, 'a')], turns: [ret(1, 1), { turn: 2, calls_through: 1, stop: 'brief_over_budget' }, ret(3, 2)] })
  assert.equal(later.asks.a.end, null, 'a later returned turn reopens it')
})

test('a returned turn after a navigator stop reopens the stopped asks', () => {
  const l = fold({ calls: [move(1, 'a'), move(2, 'a')], turns: [ret(1, 1), lost(2, 1), lost(3, 1), ret(4, 2)] })
  assert.equal(l.asks.a.end, null)
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

test('dismissal paths and globs match the way git pathspecs do', () => {
  const keys = ['src/a.js', 'src/x/y/a.js', 'src/xa.js', 'src/b.js', 'src/c.js', 'src/cc.js', 'docs/x.md', 'docsy.md', 'README.md', 'a b/c*.js', 'a b/cd.js']
  const g = ground(...keys.map((k) => pathRow(k)))
  const closed = (target) => {
    const l = fold({ ground: g, turns: [ret(1, 0, { dismissed: [dismiss('a', target)] })] })
    const open = new Set(l.asks.a.frontier.map((f) => f.key))
    return keys.filter((k) => !open.has(k))
  }
  assert.deepEqual(closed({ glob: 'src/**/a.js' }), ['src/a.js', 'src/x/y/a.js'], '** matches zero or more directories')
  assert.deepEqual(closed({ glob: 'src/[!a]*.js' }), ['src/xa.js', 'src/b.js', 'src/c.js', 'src/cc.js'], '[!a] is a negated class inside one segment')
  assert.deepEqual(closed({ glob: 'src/?.js' }), ['src/a.js', 'src/b.js', 'src/c.js'], '? is one character, never a /')
  assert.deepEqual(closed({ glob: '**/*.md' }), ['docs/x.md', 'docsy.md', 'README.md'], 'a leading **/ also matches at the root')
  assert.deepEqual(closed({ path: 'docs/' }), ['docs/x.md'], 'a literal directory, trailing slash or not')
  assert.deepEqual(closed({ path: 'a b/c*.js' }), ['a b/c*.js'], 'a literal path takes * and spaces as they are')
})

test("an ask's stamp, end and frontier do not depend on the order of calls, items or the asks a call names", () => {
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
    assert.deepEqual(new Set(y.asks[k].frontier.map((f) => f.kind + ' ' + f.key)), new Set(x.asks[k].frontier.map((f) => f.kind + ' ' + f.key)), k + ' frontier')
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

test('labels: done on answered is declared, a checked absence observed, no_progress observed, not_converging ruled, stopped observed', () => {
  assert.equal(fold({ turns: [ret(1, 0, { asks: [declare('a', 'answered')] })] }).asks.a.end.label, 'declared')
  assert.equal(fold({ calls: [grep(1, ['a'], [])], turns: [ret(1, 1, { asks: [declare('a', 'absent')] })] }).asks.a.end.label, 'observed')
  assert.equal(fold({ calls: [move(1, 'a')], turns: [ret(1, 1), ret(2, 1)] }).asks.a.end.label, 'observed')
  assert.equal(fold({ calls: [move(1, 'a')], turns: [ret(1, 1)], rulings: [{ turn: 1, asks: ['a'], units: [unit('a', 'not_converging')] }] }).asks.a.end.label, 'ruled')
  assert.equal(fold({ calls: [move(1, 'a')], turns: [ret(1, 1), lost(2, 1), lost(3, 1)] }).asks.a.end.label, 'observed')
})

test('a checked absence resting on a dismissal of a file not read to its end is declared', () => {
  const g = ground(pathRow('src/a.ts'))
  const o = { dismissed: [dismiss('a', { path: 'src/a.ts' })], asks: [declare('a', 'absent')] }
  const unread = fold({ ground: g, calls: [grep(1, ['a'], [])], turns: [ret(1, 1, o)] })
  assert.deepEqual([unread.asks.a.end.state, unread.asks.a.absence, unread.asks.a.end.label], ['done', 'checked', 'declared'])
  const whole = fold({ ground: g, calls: [grep(1, ['a'], []), read(2, ['a'], 'src/a.ts', 1, 8, 8)], turns: [ret(1, 2, o)] })
  assert.equal(whole.asks.a.end.label, 'observed')
})

test('coverageLines: declared names each ask done on a declaration, and not a checked absence', () => {
  const l = fold({ asks: [ask('guidance'), ask('ground:intro')], calls: [grep(1, ['ground:intro'], [])], turns: [ret(1, 1, { asks: [declare('guidance', 'answered'), declare('ground:intro', 'absent')] })] })
  const c = coverageLines(l, NAME)
  assert.equal(c.declared.length, 1)
  assert.ok(c.declared[0].startsWith(NAME + ':guidance'), c.declared[0])
  assert.match(c.declared[0], /answered/)
  assert.deepEqual([c.incomplete, c.unreached, c.failed_channels], [[], [], []])
})

test('coverageLines: incomplete names every ask that ended no_progress, not_converging or stopped, or has no end', () => {
  const l = fold({
    asks: [ask('np'), ask('nc'), ask('op')], calls: [move(1, ['np', 'nc']), move(2, 'nc')],
    turns: [ret(1, 1), ret(2, 2, { hits: [hit('np', 'src/none.js', 1)] })],
    rulings: [{ turn: 2, asks: ['nc'], units: [unit('nc', 'not_converging', 'stuck')] }],
  })
  const c = coverageLines(l, NAME)
  for (const k of ['np', 'nc', 'op']) assert.ok(c.incomplete.some((line) => line.startsWith(NAME + ':' + k)), k)
  assert.equal(c.incomplete.length, 3)
  const stopped = coverageLines(fold({ calls: [move(1, 'a')], turns: [ret(1, 1), lost(2, 1), lost(3, 1)] }), NAME)
  assert.ok(stopped.incomplete.some((line) => line.startsWith(NAME + ':a')))
})

test("coverageLines: unreached holds one line per item of an ask's frontier at its end", () => {
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

test('an ask done on a checked absence with an empty frontier adds no coverage line', () => {
  const c = coverageLines(fold({ calls: [grep(1, ['a'], [])], turns: [ret(1, 1, { asks: [declare('a', 'absent')] })] }), NAME)
  assert.deepEqual(c, { declared: [], incomplete: [], unreached: [], failed_channels: [] })
})

// ------------------------------------------------------------------ added by the test author

test("a missing turn's calls count as work at the next return: the ask they named stays open, and an ask they did not name is not taken for worked", () => {
  const l = fold({ asks: [ask('a'), ask('b')], calls: [move(1, 'a')], turns: [lost(1, 1), ret(2, 1)] })
  assert.deepEqual([l.asks.a.end, l.asks.b.end], [null, null], 'a was worked by call 1 since the last return, and moved; b is open while the turn worked a')
})

test('a hit is accepted only on a line observed under one of its open asks: a line only an ended ask observed does not verify it', () => {
  const l = fold({
    asks: [ask('a'), ask('b')], calls: [grep(1, ['a'], [['src/x.js', 2]])],
    turns: [ret(1, 1, { asks: [declare('a', 'answered')] }), ret(2, 1, { hits: [hit(['a', 'b'], 'src/x.js', 2)] })],
  })
  assert.equal(l.asks.a.end.turn, 1)
  assert.deepEqual(hitsOf(l, 'b'), [])
  assert.deepEqual(classes(l), ['unobserved'])
})

test('every kind of item naming only ended asks is refused names_only_ended_asks, and the ended ask keeps its declaration', () => {
  const l = fold({
    calls: [move(1, 'a')],
    turns: [ret(1, 1, { asks: [declare('a', 'answered')] }), ret(2, 1, {
      hits: [hit('a', 'moved/1.js', 1)], leads: [{ ask: 'a', path: 'src/l.js', why: 'w' }], asks: [declare('a', 'open')],
    })],
  })
  assert.equal(l.asks.a.end.state, 'done')
  assert.equal(l.asks.a.declared, 'answered')
  assert.deepEqual(classes(l), ['names_only_ended_asks', 'names_only_ended_asks', 'names_only_ended_asks'])
  assert.deepEqual([l.asks.a.hits, l.asks.a.leads], [[], []])
})

test('an absence that is only declared, with an empty frontier, ends done labelled declared and is a declared coverage line', () => {
  const l = fold({ turns: [ret(1, 0, { asks: [declare('a', 'absent')] })] })
  assert.deepEqual([l.asks.a.absence, l.asks.a.end.state, l.asks.a.end.label], ['declared', 'done', 'declared'])
  const c = coverageLines(l, NAME)
  assert.equal(c.declared.length, 1)
  assert.ok(c.declared[0].startsWith(NAME + ':a'), c.declared[0])
})

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
  assert.deepEqual(l.asks.a.frontier.map((f) => f.kind + ' ' + f.key + ' ' + f.detail).sort(), ['overflow call:1 page 2 of 2', 'overflow call:2 page 2 of 2'])
})

test('a glob dismissal never closes an overflow page, and neither does a path dismissal of the files it showed', () => {
  const calls = [grep(1, ['a'], [['src/a.js', 1]], { pages: 2, total: 300 })]
  for (const target of [{ glob: '**' }, { path: 'src' }]) {
    const l = fold({ calls, turns: [ret(1, 1, { dismissed: [dismiss('a', target)] })] })
    assert.deepEqual(l.asks.a.frontier.map((f) => [f.kind, f.key]), [['overflow', 'call:1']], JSON.stringify(target))
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
  const ruled = fold({ ...RULED, rulings: [{ turn: 3, asks: ['a', 'b'], units: [unit('a', 'not_converging'), unit('b', 'converging')] }] })
  const s = stateOf(ruled, { turn: 3, checkin: true })
  assert.deepEqual(s.ending, [])
  assert.deepEqual(s.open, ['b'])
  const stopped = fold({ calls: [move(1, 'a')], turns: [ret(1, 1), lost(2, 1), lost(3, 1)] })
  assert.deepEqual(stateOf(stopped, { turn: 3, checkin: true }).ending, [])
  assert.deepEqual(stateOf(stopped, { turn: 3, checkin: true }).toRuler, [])
})

test('stateOf reports a no_progress ending with its state and label', () => {
  const l = fold({ calls: [move(1, 'a')], turns: [ret(1, 1), ret(2, 1)] })
  const e = stateOf(l, { turn: 2, checkin: false }).ending
  assert.deepEqual(e.map(({ ask: a, state, label }) => [a, state, label]), [['a', 'no_progress', 'observed']])
  assert.equal(typeof e[0].why, 'string')
})

test('the same ruling stream folds the same ledger whatever the order of rulings at different turns', () => {
  const rulings = [
    { turn: 2, asks: ['a'], units: [unit('a', 'converging')] },
    { turn: 3, asks: ['a'], units: [unit('a', 'not_converging', 'late')] },
  ]
  const l = fold({ ...RULED, rulings })
  const r = fold({ ...RULED, rulings: [...rulings].reverse() })
  assert.deepEqual(r.asks.a.end, l.asks.a.end)
  assert.equal(l.asks.a.end.turn, 3)
})

// ------------------------------------------------------------------ added by the T03 audit

const STOP = (turn, calls_through) => ({ turn, calls_through, stop: 'brief_over_budget' })

test('an ask that is both done and unmoved since an earlier return ends done, not no_progress', () => {
  const l = fold({
    calls: [grep(1, ['a'], [['src/b.js', 1]]), read(2, ['a'], 'src/b.js', 1, 1, 5)],
    turns: [ret(1, 1, { leads: [{ ask: 'a', path: 'src/b.js', why: 'imports it' }], asks: [declare('a', 'answered')] }), ret(2, 2)],
  })
  assert.equal(l.asks.a.history.at(-1).stamp, l.asks.a.history.at(-2).stamp, 'the read added nothing the stamp covers')
  assert.deepEqual([l.asks.a.end.state, l.asks.a.end.turn], ['done', 2])
})

test('a stop turn stops every open ask, by the navigator, at that turn', () => {
  const l = fold({ asks: [ask('a'), ask('b'), ask('c')], calls: [move(1, ['a', 'b', 'c'])], turns: [ret(1, 1), STOP(2, 1)] })
  for (const k of ['a', 'b', 'c']) assert.deepEqual([l.asks[k].end.state, l.asks[k].end.by, l.asks[k].end.turn], ['stopped', 'navigator', 2], k)
})

test('an item refused unknown_ask still works the known asks it names: they are accountable, an unnamed ask is not', () => {
  const calls = [move(1, ['a', 'b']), move(2, 'b')]
  for (const [other, extra] of [['zzz', []], ['want:1', [ask('want:1', { from: 5 })]]]) {
    const l = fold({
      asks: [ask('a'), ask('b'), ...extra], calls,
      turns: [ret(1, 1), ret(2, 2, { hits: [hit(['a', other], 'src/nowhere.js', 1)] })],
    })
    assert.deepEqual(classes(l), ['unknown_ask'], other)
    assert.deepEqual([l.asks.a.end?.state, l.asks.a.end?.turn], ['no_progress', 2], other + ': a was named, and nothing moved it')
    assert.equal(l.asks.b.end, null, other + ': b moved')
  }
})

test("an ask's previous check-in is the latest of the rulings that named it", () => {
  const l = fold({
    asks: [ask('a'), ask('b')],
    calls: [move(1, ['a', 'b']), move(2, ['a', 'b']), move(3, 'a'), move(4, ['a', 'b']), move(5, 'b')],
    turns: [1, 2, 3, 4, 5].map((n) => ret(n, n)),
    rulings: [
      { turn: 2, asks: ['a'], units: [unit('a', 'converging')] },
      { turn: 4, asks: ['a'], units: [unit('a', 'converging')] },
    ],
  })
  assert.equal(l.asks.a.end, null, 'turn 5 did not work a')
  assert.deepEqual(stateOf(l, { turn: 5, checkin: true }).toRuler, ['b'], 'a has not moved since it was ruled at turn 4, though it moved after turn 2')
})

test("a ruling at the queried turn is not its ask's previous check-in: a refold that holds it reports the same toRuler", () => {
  const x = { calls: [move(1, 'a'), move(2, 'a')], turns: [ret(1, 1), ret(2, 2)] }
  const without = stateOf(fold(x), { turn: 2, checkin: true }).toRuler
  const ruled = fold({ ...x, rulings: [{ turn: 2, asks: ['a'], units: [unit('a', 'converging')] }] })
  assert.deepEqual(without, ['a'])
  assert.deepEqual(stateOf(ruled, { turn: 2, checkin: true }).toRuler, without)
})

test('a ruling of the ask between two ruler misses resets the count: the ask is not stopped', () => {
  const l = fold({
    ...RULED,
    rulings: [
      { turn: 3, asks: ['a'], missing: 'x' },
      { turn: 3, asks: ['a'], units: [unit('a', 'converging')] },
      { turn: 3, asks: ['a'], missing: 'y' },
    ],
  })
  assert.equal(l.asks.a.end, null)
})

test('a ruling folds once however many turn records carry its turn: one miss stops nothing', () => {
  const x = { calls: [move(1, 'a'), move(2, 'a')], turns: [ret(1, 1), ret(1, 2)] }
  assert.equal(fold({ ...x, rulings: [{ turn: 1, asks: ['a'], missing: 'schema_failed' }] }).asks.a.end, null)
})

test('a ruling folds once however many turn records carry its turn: it ends the ask once and is listed once', () => {
  const ruling = { turn: 1, asks: ['a'], units: [unit('a', 'not_converging', 'stuck')] }
  const l = fold({ calls: [move(1, 'a'), move(2, 'a')], turns: [ret(1, 1), ret(1, 2)], rulings: [ruling] })
  assert.deepEqual(l.asks.a.end, { state: 'not_converging', turn: 1, label: 'ruled', why: 'stuck' })
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

test('a navigator stop stops an ask whose from is ahead too, and nothing is left open', () => {
  const asks = [ask('a'), ask('w', { from: 5 })]
  const stop = fold({ asks, calls: [move(1, 'a')], turns: [ret(1, 1), STOP(2, 1)] })
  assert.deepEqual([stop.asks.w.end.state, stop.asks.w.end.by, stop.asks.w.end.turn], ['stopped', 'navigator', 2])
  assert.deepEqual(stateOf(stop, { turn: 2, checkin: false }).open, [])
  const missed = fold({ asks, calls: [move(1, 'a')], turns: [ret(1, 1), lost(2, 1), lost(3, 1)] })
  assert.deepEqual([missed.asks.w.end.state, missed.asks.w.end.by, missed.asks.w.end.turn], ['stopped', 'navigator', 3])
  assert.deepEqual(stateOf(missed, { turn: 3, checkin: false }).open, [])
})

test('a returned turn reopens a stopped ask that has not joined yet, and it is evaluated only from its from on', () => {
  const asks = [ask('a'), ask('w', { from: 4 })]
  const calls = [move(1, 'a'), move(2, 'a')]
  const reopened = fold({ asks, calls, turns: [ret(1, 1), STOP(2, 1), ret(3, 2)] })
  assert.equal(reopened.asks.w.end, null)
  assert.deepEqual(reopened.asks.w.history.map((h) => h.turn), [3], 'turn 3 is before its from')
  const joined = fold({ asks, calls, turns: [ret(1, 1), STOP(2, 1), ret(3, 2), ret(4, 2)] })
  assert.deepEqual([joined.asks.w.end.state, joined.asks.w.end.turn], ['no_progress', 4])
  assert.deepEqual(joined.asks.w.history.map((h) => h.turn), [3, 4])
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
