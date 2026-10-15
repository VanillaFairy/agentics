// test/fast/search-consume.test.mjs — one way to consume a search: what a search's result means to
// its consumer (`outcomeOf`), how a want is named (`canonicalWant`), the wants loop that reruns a
// search for its consumers' wants and re-dispatches them (`wantsRounds`), and the lines a lost round
// leaves (`judgeLines`). Pure parts only, with fake `rerun`/`redispatch`/`merge`.
//
// Design: docs/DESIGN.md#searches.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const consume = () => import('../../lib/programs/search/consume.mjs')

// --- search results as the loop gives them -----------------------------------------------------

const noLines = () => ({ declared: [], incomplete: [], unreached: [], failed: [] })
/** One ask of a search result; `over` replaces any field. */
const ask = (over = {}) => ({
  end: 'done', answer: '', label: 'ruled', why: '', declared: [], hits: [], dismissed: [], looked: [], unreached: [], lines: noLines(), ...over,
})
const HIT = { key: 'src/a.js', line: 3, note: 'the line' }
/** A search result named `name` over `asks` ({key: ask fields}). */
const resultOf = (asks, { name = 'locate', status = 'complete', cause = null } = {}) => ({
  name, status, cause, tree: null, ground: null, sessions: [], entries_n: 0, kinds: {}, refusals: [], queries: [],
  coverage: { declared: [], incomplete: [], unreached: [], failed_channels: [] },
  asks: Object.fromEntries(Object.entries(asks).map(([k, a]) => [k, ask(a)])),
})
const sorted = (list) => [...list].sort()

// --- outcomeOf ---------------------------------------------------------------------------------

test('a failed search gives nothing', async () => {
  const { outcomeOf } = await consume()
  const out = outcomeOf(resultOf({ guidance: { hits: [HIT] } }, { status: 'failed', cause: 'host_error' }))
  assert.equal(out.nothing, true)
  assert.equal(out.short, false, 'nothing is never short')
  assert.equal(typeof out.why, 'string')
})

test('stopped with nothing is nothing', async () => {
  const { outcomeOf } = await consume()
  const stopped = { end: 'stopped', label: 'ruler', why: 'unruled twice' }
  const none = outcomeOf(resultOf({ a: stopped, b: stopped, 'want:1': { end: 'done', hits: [HIT] } }))
  assert.equal(none.nothing, true, 'every non-want ask stopped with no hit; a want hit does not count')
  assert.equal(none.short, false)
  const one = outcomeOf(resultOf({ a: stopped, b: { ...stopped, hits: [HIT] } }))
  assert.equal(one.nothing, false, 'a stopped ask holding a hit is something')
  const mixed = outcomeOf(resultOf({ a: stopped, b: { end: 'done' } }))
  assert.equal(mixed.nothing, false, 'an ask that ended otherwise is something')
})

test('short', async () => {
  const { outcomeOf } = await consume()
  assert.equal(outcomeOf(resultOf({ a: { end: 'done' }, b: { end: 'done' } })).short, false, 'every ask done')
  for (const end of ['no_progress', 'not_converging', 'stopped', null]) {
    const out = outcomeOf(resultOf({ a: { end: 'done' }, b: { end, hits: [HIT] } }))
    assert.equal(out.nothing, false)
    assert.equal(out.short, true, 'an ask ended ' + end + ' leaves it short')
  }
  const wantOnly = outcomeOf(resultOf({ a: { end: 'done' }, 'want:1': { end: 'no_progress', why: 'w' } }))
  assert.equal(wantOnly.short, false, "a want's end never makes the search short")
})

test('want lines are by key', async () => {
  const { outcomeOf } = await consume()
  const out = outcomeOf(resultOf({
    a: { end: 'done', lines: { declared: ['locate:a: ruled x'], incomplete: [], unreached: ['locate:a: lead src/b.js (x)'], failed: [] } },
    b: { end: 'no_progress', why: 'b why', lines: { declared: [], incomplete: ['locate:b: no_progress, b why'], unreached: ['locate:b: no call ran under it'], failed: ['converge:locate'] } },
    'want:2': {
      end: 'no_progress', why: 'nothing moved',
      lines: { declared: ['locate:want:2: W-DECL'], incomplete: ['locate:want:2: W-INC'], unreached: ['locate:want:2: W-UNR'], failed: ['W-FAIL'] },
    },
    'want:3': { end: 'done', lines: { declared: ['locate:want:3: ruled W3'], incomplete: [], unreached: ['locate:want:3: W3-UNR'], failed: [] } },
  }))
  assert.deepEqual(sorted(out.declared), sorted(['locate:a: ruled x', 'want 2: ended no_progress: nothing moved']))
  assert.deepEqual(sorted(out.incomplete), ['locate:b: no_progress, b why'])
  assert.deepEqual(sorted(out.unreached), sorted(['locate:a: lead src/b.js (x)', 'locate:b: no call ran under it']))
  assert.deepEqual(out.failed, ['converge:locate'])
})

test('no prefix matching', async () => {
  const { outcomeOf } = await consume()
  const out = outcomeOf(resultOf({
    'want-list': { end: 'no_progress', why: 'list why', lines: { declared: [], incomplete: ['locate:want-list: no_progress, list why'], unreached: [], failed: [] } },
    'ground:x': { end: 'done', lines: { declared: [], incomplete: [], unreached: ['locate:want:9: a line that only looks like a want'], failed: [] } },
  }))
  assert.equal(out.short, true, 'want-list is an ask like any other: its end makes the search short')
  assert.deepEqual(out.incomplete, ['locate:want-list: no_progress, list why'])
  assert.deepEqual(out.unreached, ['locate:want:9: a line that only looks like a want'], "a non-want ask's lines are kept whatever they read")
  assert.ok(!out.declared.some((l) => l.startsWith('want ')), 'no want line for a non-want: ' + JSON.stringify(out.declared))
  const stopped = outcomeOf(resultOf({ 'want-list': { end: 'stopped' }, a: { end: 'stopped' } }))
  assert.equal(stopped.nothing, true)
  const listHit = outcomeOf(resultOf({ 'want-list': { end: 'stopped', hits: [HIT] }, a: { end: 'stopped' } }))
  assert.equal(listHit.nothing, false, "want-list's hit counts: it is not a want")
})

// --- canonicalWant -----------------------------------------------------------------------------

test('canonicalWant collapses whitespace', async () => {
  const { canonicalWant } = await consume()
  assert.equal(canonicalWant('  find   the\tthing '), 'find the thing')
  assert.equal(canonicalWant('a\n\n b'), 'a b')
  assert.equal(canonicalWant(canonicalWant('  x  y ')), 'x y', 'idempotent')
})

// --- wantsRounds -------------------------------------------------------------------------------

const ruled = (units, ruling = 'clean') => units.map((unit) => ({ unit, ruling, ids: [], why: 'why ' + unit }))
/** A consumer's return ruling `units`, wanting `wants` ([unit, text]). */
const ret = (units, wants = [], ruling = 'clean') => ({ units: ruled(units, ruling), wants: wants.map(([unit, want]) => ({ unit, want })), findings: [], not_reached: '' })

/**
 * A fake search per name: each rerun answers every want ask it has not seen before with a fresh hit and
 * a fresh call, unless `adds` is false. Records each call.
 */
function fakeSearches({ adds = true, delay = {} } = {}) {
  const calls = []
  const held = new Map()
  let n = 0
  const rerun = async (name, asks) => {
    calls.push({ name, asks: [...asks] })
    if (calls.length > 20) throw new Error('rerun called more than 20 times: the loop does not end')
    if (delay[name]) await delay[name]()
    const mine = held.get(name) || {}
    for (const a of asks) {
      if (mine[a.key]) continue
      n++
      mine[a.key] = adds
        ? { end: 'done', hits: [{ key: 'src/f' + n + '.js', line: n, note: 'n' + n }], looked: [{ seq: n, tool: 'grep', what: 'p' + n, where: ['.'], total: 1 }] }
        : { end: 'no_progress', why: 'nothing moved', hits: [], looked: [] }
    }
    held.set(name, mine)
    return resultOf(mine, { name })
  }
  return { rerun, calls }
}
const mergeFake = (calls = []) => (prev, next, units) => {
  calls.push({ prev, next, units: [...units] })
  return { ...next, merged_from: prev }
}
const unitsArg = (units) => sorted([...units])

test('consumers of one search share a pass', async () => {
  const { wantsRounds, canonicalWant } = await consume()
  const s = fakeSearches()
  const order = []
  const redispatched = []
  const redispatch = async (consumer, units, found, round) => {
    order.push('redispatch:' + consumer.id)
    redispatched.push({ id: consumer.id, units: unitsArg(units), round })
    return { status: 'returned', output: ret([...units]) }
  }
  const rerun = async (name, asks) => { order.push('rerun'); return s.rerun(name, asks) }
  const consumers = [
    { id: 1, search: 'locate', held: ['u1', 'u1b'], latest: ret(['u1', 'u1b'], [['u1', '  where is  the store ']]) },
    { id: 2, search: 'locate', held: ['u2'], latest: ret(['u2'], [['u2', 'where the timer is set']]) },
  ]
  const state = await wantsRounds({}, { consumers, rerun, redispatch, merge: mergeFake() })
  assert.equal(s.calls.length, 1, 'one rerun for the pass: ' + JSON.stringify(s.calls))
  assert.equal(s.calls[0].name, 'locate')
  const finds = s.calls[0].asks.map((a) => a.find)
  assert.deepEqual(sorted(finds), sorted([canonicalWant('  where is  the store '), 'where the timer is set']), 'both wants, canonical')
  for (const a of s.calls[0].asks) assert.match(a.key, /^want:\d+$/)
  assert.equal(new Set(s.calls[0].asks.map((a) => a.key)).size, 2, 'one ask per want')
  assert.equal(order[0], 'rerun', 'the rerun runs before any consumer is re-dispatched')
  assert.deepEqual(sorted(redispatched.map((r) => r.id)), [1, 2])
  assert.deepEqual(redispatched.find((r) => r.id === 1).units, ['u1'], 'consumer 1 for its wanted unit alone')
  assert.deepEqual(redispatched.find((r) => r.id === 2).units, ['u2'])
  assert.ok(state[1] && state[2], 'a state per consumer id')
  assert.ok(state[1].passes.length >= 1)
})

test('one want worded two ways by two consumers is one ask', async () => {
  const { wantsRounds } = await consume()
  const s = fakeSearches()
  const redispatch = async (c, units) => ({ status: 'returned', output: ret([...units]) })
  const consumers = [
    { id: 1, search: 'locate', held: ['u1'], latest: ret(['u1'], [['u1', 'where  the store is']]) },
    { id: 2, search: 'locate', held: ['u2'], latest: ret(['u2'], [['u2', ' where the store is ']]) },
  ]
  await wantsRounds({}, { consumers, rerun: s.rerun, redispatch, merge: mergeFake() })
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0].asks.length, 1, JSON.stringify(s.calls[0].asks))
})

test('different searches run independently', async () => {
  const { wantsRounds } = await consume()
  const events = []
  let releaseA
  const aHeld = new Promise((r) => { releaseA = r })
  const s = fakeSearches({
    delay: {
      // A's rerun resolves only after B's rerun resolved; a loop that waits on A before starting B never gets there
      A: () => Promise.race([aHeld, new Promise((_, rej) => setTimeout(() => rej(new Error('A waited on B: the groups ran in sequence')), 2000))]),
    },
  })
  const rerun = async (name, asks) => {
    events.push('start:' + name)
    const out = await s.rerun(name, asks)
    events.push('end:' + name)
    if (name === 'B') releaseA()
    return out
  }
  const redispatch = async (c, units) => ({ status: 'returned', output: ret([...units]) })
  const consumers = [
    { id: 'a', search: 'A', held: ['u'], latest: ret(['u'], [['u', 'want a']]) },
    { id: 'b', search: 'B', held: ['v'], latest: ret(['v'], [['v', 'want b']]) },
  ]
  await wantsRounds({}, { consumers, rerun, redispatch, merge: mergeFake() })
  assert.ok(events.indexOf('end:B') < events.indexOf('end:A'), "B's rerun resolved first: " + events.join(' '))
  assert.ok(events.indexOf('start:B') < events.indexOf('end:A'), 'B started while A was still running')
  assert.deepEqual(sorted(s.calls.map((c) => c.name)), ['A', 'B'], 'each search rerun for its own consumers')
})

test('nothing new ends it', async () => {
  const { wantsRounds } = await consume()
  const s = fakeSearches()
  let n = 0
  // the consumer asks the same want again, reworded only in whitespace
  const redispatch = async (c, units) => {
    if (++n > 10) throw new Error('re-dispatched more than 10 times')
    return { status: 'returned', output: ret([...units], [['u', ' want   one ']], n % 2 ? 'findings' : 'clean') }
  }
  const consumers = [{ id: 1, search: 'locate', held: ['u'], latest: ret(['u'], [['u', 'want one']]) }]
  await wantsRounds({}, { consumers, rerun: s.rerun, redispatch, merge: mergeFake() })
  assert.equal(s.calls.length, 1, 'a want asked before asks nothing new')

  const t = fakeSearches()
  const idle = async () => { throw new Error('nothing wanted: nothing to re-dispatch') }
  const quiet = [{ id: 1, search: 'locate', held: ['u'], latest: ret(['u']) }]
  const state = await wantsRounds({}, { consumers: quiet, rerun: t.rerun, redispatch: idle, merge: mergeFake() })
  assert.equal(t.calls.length, 0, 'no want, no rerun')
  assert.deepEqual(state[1].merged, quiet[0].latest, 'the return stands')
})

test('a reworded want that adds nothing ends it', async () => {
  const { wantsRounds } = await consume()
  const s = fakeSearches({ adds: false })
  let n = 0
  const redispatch = async (c, units) => {
    n++
    if (n > 10) throw new Error('re-dispatched more than 10 times')
    return { status: 'returned', output: ret([...units], [['u', 'reworded want number ' + n]], n % 2 ? 'findings' : 'clean') }
  }
  const consumers = [{ id: 1, search: 'locate', held: ['u'], latest: ret(['u'], [['u', 'first wording']]) }]
  await wantsRounds({}, { consumers, rerun: s.rerun, redispatch, merge: mergeFake() })
  assert.equal(s.calls.length, 1, 'the loop ends after the pass whose rerun added nothing: ' + JSON.stringify(s.calls.map((c) => c.asks.map((a) => a.find))))
})

test('the same rulings end it', async () => {
  const { wantsRounds } = await consume()
  const s = fakeSearches()
  let n = 0
  // every pass a new want and a fresh hit for it; the rulings never move
  const redispatch = async (c, units) => {
    n++
    if (n > 10) throw new Error('re-dispatched more than 10 times')
    return { status: 'returned', output: ret([...units], [['u', 'want number ' + n]]) }
  }
  const consumers = [{ id: 1, search: 'locate', held: ['u'], latest: ret(['u'], [['u', 'first want']]) }]
  await wantsRounds({}, { consumers, rerun: s.rerun, redispatch, merge: mergeFake() })
  assert.ok(s.calls.length <= 2, 'the loop ends once the rulings repeat: ' + s.calls.length + ' reruns')
})

test('a want on a foreign unit is ignored', async () => {
  const { wantsRounds } = await consume()
  const s = fakeSearches()
  const redispatch = async () => { throw new Error('a foreign want re-dispatches nobody') }
  const consumers = [{ id: 1, search: 'locate', held: ['u'], latest: ret(['u'], [['other', 'a want on a unit not held']]) }]
  const state = await wantsRounds({}, { consumers, rerun: s.rerun, redispatch, merge: mergeFake() })
  assert.equal(s.calls.length, 0, 'no ask for it')
  assert.deepEqual(state[1].merged, consumers[0].latest)

  const t = fakeSearches()
  const sent = []
  const mixed = [{ id: 1, search: 'locate', held: ['u'], latest: ret(['u'], [['other', 'foreign'], ['u', 'own']]) }]
  await wantsRounds({}, {
    consumers: mixed, rerun: t.rerun, merge: mergeFake(),
    redispatch: async (c, units) => { sent.push(unitsArg(units)); return { status: 'returned', output: ret([...units]) } },
  })
  assert.deepEqual(t.calls[0].asks.map((a) => a.find), ['own'], 'only the held unit\'s want is asked')
  assert.deepEqual(sent, [['u']])
})

test('a failed round keeps the earlier return', async () => {
  const { wantsRounds } = await consume()
  const s = fakeSearches()
  const merges = []
  const redispatch = async () => ({ status: 'failed', cause: 'host_error' })
  const consumers = [{ id: 7, search: 'locate', held: ['u', 'w'], latest: ret(['u', 'w'], [['u', 'where it is']]) }]
  const state = await wantsRounds({}, { consumers, rerun: s.rerun, redispatch, merge: mergeFake(merges) })
  const failed = state[7].passes.filter((p) => p.status === 'failed')
  assert.equal(failed.length, 1, JSON.stringify(state[7].passes))
  assert.equal(failed[0].cause, 'host_error')
  assert.deepEqual(unitsArg(failed[0].units), ['u'])
  assert.deepEqual(state[7].merged, consumers[0].latest, 'the earlier return stands')
  assert.equal(merges.length, 0, 'nothing is merged from a failed round')
  assert.deepEqual(state[7].held, ['u', 'w'])
})

test('a returned round is merged over the earlier return for its units', async () => {
  const { wantsRounds } = await consume()
  const s = fakeSearches()
  const merges = []
  const second = ret(['u'], [], 'findings')
  const redispatch = async () => ({ status: 'returned', output: second })
  const consumers = [{ id: 1, search: 'locate', held: ['u', 'w'], latest: ret(['u', 'w'], [['u', 'where it is']]) }]
  const state = await wantsRounds({}, { consumers, rerun: s.rerun, redispatch, merge: mergeFake(merges) })
  assert.equal(merges.length, 1)
  assert.deepEqual(merges[0].prev, consumers[0].latest)
  assert.deepEqual(merges[0].next, second)
  assert.deepEqual(merges[0].units, ['u'])
  assert.equal(state[1].merged.merged_from, consumers[0].latest, 'the merged return is what merge gave')
})

// --- judgeLines --------------------------------------------------------------------------------

test('a lost round is one line', async () => {
  const { judgeLines } = await consume()
  const state = {
    1: {
      held: ['loader', 'store'], merged: {},
      passes: [
        { round: 2, units: ['loader'], status: 'failed', cause: 'host_error', not_reached: '' },
      ],
    },
    2: { held: ['cache'], merged: {}, passes: [{ round: 2, units: ['cache'], status: 'returned', cause: null, not_reached: '' }] },
  }
  const { unreached } = judgeLines(state, 'judge')
  assert.deepEqual(unreached, ['judge 1 did not return for its wants (host_error): its earlier items on loader stand'])
})

test('not_reached is deduplicated', async () => {
  const { judgeLines } = await consume()
  const state = {
    3: {
      held: ['u'], merged: {},
      passes: [
        { round: 2, units: ['u'], status: 'returned', cause: null, not_reached: 'NR-the refill timer' },
        { round: 3, units: ['u'], status: 'returned', cause: null, not_reached: 'NR-the refill timer' },
        { round: 4, units: ['u'], status: 'returned', cause: null, not_reached: 'NR-the bucket store' },
      ],
    },
  }
  const { unreached } = judgeLines(state, 'prober')
  assert.equal(unreached.filter((l) => l.includes('NR-the refill timer')).length, 1, JSON.stringify(unreached))
  assert.equal(unreached.filter((l) => l.includes('NR-the bucket store')).length, 1, 'a different text is its own line')
  assert.ok(!unreached.some((l) => l.includes('did not return')), 'no round was lost')
})
