// test/fast/search-ledger-ending.test.mjs — how an ask of a search ends. No declaration ends one. A
// stall (every open ask in a state it was in at an earlier returned turn) sends each open ask to the
// ruler, or ends it when some ruling already saw that state. Only a ruling ends an ask done. The
// coverage lines say what each end rests on.
//
// Design: docs/DESIGN.md#searches and docs/DESIGN.md#l2--states-end-work-counts-dont.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as ledger from '../../lib/search/ledger.mjs'

const { coverageLines, foldLedger, REFUSAL_REASON, standingRefusals, stateOf } = ledger
/** An export the ending work adds: a test of it fails on its own when it is missing. */
const exported = (name) => {
  assert.equal(typeof ledger[name], 'function', 'lib/search/ledger.mjs exports ' + name)
  return ledger[name]
}

// ------------------------------------------------------------------ builders

const NAME = 'probe:locate'
const NONE = { rows: [], seeds: [] }
/** An ask that holds its material as a closed seed: its agenda starts empty. */
const ask = (key, extra = {}) => ({ key, find: 'what ' + key + ' asks', scope: ['.'], domain: 'repo', seeds: [{ key: 'MATERIAL.md', as: 'closed', reason: 'the material' }], ...extra })
/** A scope-owing ask: no seed, no row, the scope's files as `owes`. */
const owing = (key, owes, extra = {}) => ask(key, { seeds: [], owes, ...extra })
const pathRow = (key, asks = ['a']) => ({ kind: 'path', mention: key, key, exists: true, asks, defs: [], refs: [], files: 0 })
const ground = (...rows) => ({ rows, seeds: [] })

let uid = 0
/** A grep call (seq is given by `script`) under `asks` that showed `lines`, each [key, line]; a pattern of its own unless one is given. */
const grep = (asks, lines = [], { pattern = 'p' + ++uid, paths = [] } = {}) => ({
  tool: 'grep', args: { pattern, fixed: false, ignore_case: false, paths, page: 1 }, asks: [].concat(asks), ok: true,
  total: lines.length, page: 1, pages: 1, observed: lines.map(([key, line]) => ({ key, line })), keys: [...new Set(lines.map(([key]) => key))],
})
/** A call that shows `asks` a query and a line nothing showed before: their state moves. */
const move = (asks) => grep(asks, [['moved/' + ++uid + '.js', 1]])
/** A read call under `asks` of a file of `to` lines, read whole. */
const read = (asks, key, to) => ({
  tool: 'read', args: { path: key, from: 1, to }, asks: [].concat(asks), ok: true,
  observed: Array.from({ length: to }, (_, i) => ({ key, line: i + 1 })), keys: [key], ended: { key, to, total_lines: to },
})

const hit = (asks, path, line, note = 'it is here') => ({ ask: [].concat(asks), path, line, note })
const dismiss = (asks, target, why = 'not about this ask') => ({ ask: [].concat(asks), ...target, why })
const unit = (u, value, why = 'because ' + u + ' is ' + value) => ({ unit: u, ruling: value, why })
/** A Ruling record at `turn` over the asks of `units`. */
const ruled = (turn, ...units) => ({ turn, asks: units.map((u) => u.unit), units })

/** Turn specs → the call log (numbered in order) and the turn records. A spec: {calls, hits, dismissed, leads, declare: [[ask, declared]], missing, stop}. */
function script(specs, base = {}) {
  const calls = []
  const turns = specs.map((s, i) => {
    for (const c of s.calls ?? []) calls.push({ ...c, seq: calls.length + 1 })
    const head = { turn: i + 1, calls_through: calls.length }
    if (s.missing) return { ...head, missing: s.missing }
    if (s.stop) return { ...head, stop: s.stop }
    const asks = (s.declare ?? []).map(([a, declared]) => ({ ask: a, declared }))
    return { ...head, output: { hits: s.hits ?? [], dismissed: s.dismissed ?? [], leads: s.leads ?? [], asks } }
  })
  return { ...base, calls, turns }
}
const fold = ({ asks = [ask('a')], ground: g = NONE, calls = [], turns = [], rulings = [] } = {}) => foldLedger({ asks, ground: g, calls, turns, rulings })
/** The ledger of script `x` through its first n turns, with the rulings journaled for those turns. */
const through = (x, n, rulings = []) => fold({ ...x, turns: x.turns.slice(0, n), rulings: rulings.filter((r) => r.turn <= n) })
const sent = (l, turn, checkin = false) => stateOf(l, { turn, checkin }).toRuler
const classes = (l) => l.refusals.map((r) => r.class)

/** Plays the loop over script `x`: after each turn it folds, asks stateOf who goes to the ruler, and journals `ruler(ask, turn)` for each of them. */
function play(x, ruler, checkin = () => false) {
  const rulings = []
  const toRulers = []
  let l
  for (let n = 1; n <= x.turns.length; n++) {
    l = through(x, n, rulings)
    const toRuler = sent(l, n, checkin(n))
    toRulers.push(toRuler)
    if (toRuler.length > 0) {
      rulings.push({ turn: n, asks: toRuler, units: toRuler.map((a) => ruler(a, n)) })
      l = through(x, n, rulings)
    }
  }
  return { l, rulings, toRulers }
}
const alwaysOpen = (a, n) => unit(a, 'open', 'go on, as of turn ' + n)

// ------------------------------------------------------------------ declarations end nothing (N5.4)

test('a declaration ends nothing', () => {
  for (const declared of ['answered', 'absent', 'open']) {
    const l = fold(script([{ calls: [move('a')], declare: [['a', declared]] }]))
    assert.equal(l.asks.a.declared, declared)
    assert.equal(l.asks.a.end, null, declared)
    assert.deepEqual(stateOf(l, { turn: 1, checkin: false }).ending, [], declared)
    assert.deepEqual(stateOf(l, { turn: 1, checkin: false }).open, ['a'], declared)
  }
  const emptyAgenda = fold(script([{ calls: [grep('a', [['src/a.ts', 2]])], hits: [hit('a', 'src/a.ts', 2)], dismissed: [dismiss('a', { glob: '**' })], declare: [['a', 'answered']] }, { declare: [['a', 'answered']] }]))
  assert.deepEqual(emptyAgenda.asks.a.agenda, [], 'the old condition for done holds: declared, and nothing left on the agenda')
  assert.equal(emptyAgenda.asks.a.end, null, 'and the declaration still ends nothing')

  // no fold path without a ruling reaches done: at every prefix of every scenario, an ask is open or stopped
  const g = ground(pathRow('src/a.ts', ['a', 'b', 'c']))
  const scenarios = {
    'answered, then the same again and idle turns': { specs: [{ calls: [move('a')], declare: [['a', 'answered']] }, { declare: [['a', 'answered']] }, {}, {}] },
    'absent after a zero-hit grep, repeated': { specs: [{ calls: [grep('a', [])], declare: [['a', 'absent']] }, { declare: [['a', 'absent']] }, {}, {}] },
    'a two-value flip-flop': { specs: [{ calls: [move('a')], declare: [['a', 'answered']] }, { declare: [['a', 'open']] }, { declare: [['a', 'answered']] }, { declare: [['a', 'open']] }, { declare: [['a', 'answered']] }] },
    'a three-value cycle': { specs: [{ calls: [move('a')], declare: [['a', 'answered']] }, { declare: [['a', 'absent']] }, { declare: [['a', 'open']] }, { declare: [['a', 'answered']] }, { declare: [['a', 'absent']] }, { declare: [['a', 'open']] }, { declare: [['a', 'answered']] }] },
    'answered beside a hit with every dismissal made': { specs: [{ calls: [grep('a', [['src/a.ts', 2]])], hits: [hit('a', 'src/a.ts', 2)], dismissed: [dismiss('a', { glob: '**' })], declare: [['a', 'answered']] }, { declare: [['a', 'answered']] }, {}] },
    'every ask declares': { asks: [ask('a'), ask('b'), ask('c')], specs: [{ calls: [move(['a', 'b', 'c'])], declare: [['a', 'answered'], ['b', 'absent'], ['c', 'answered']] }, {}, {}] },
    'answered over a refused citation, repeated': { specs: [{ calls: [move('a')] }, { hits: [hit('a', 'src/ghost.js', 1)], declare: [['a', 'answered']] }, { hits: [hit('a', 'src/ghost.js', 1)] }, {}] },
    'answered, then a navigator that goes missing': { specs: [{ calls: [move('a')], declare: [['a', 'answered']] }, { missing: 'schema_failed' }, { missing: 'host_error' }] },
  }
  for (const [what, { asks = [ask('a')], specs }] of Object.entries(scenarios)) {
    const x = script(specs, { asks, ground: g })
    for (let n = 1; n <= x.turns.length; n++) {
      for (const [key, view] of Object.entries(through(x, n).asks)) {
        assert.ok(view.end === null || view.end.state === 'stopped', what + ', after turn ' + n + ', ask ' + key + ': ' + JSON.stringify(view.end))
      }
    }
  }
})

test('V3-B: a zero-hit absence is not an end', () => {
  const x = script([{ calls: [grep('a', [], { paths: [] })], declare: [['a', 'absent']] }, {}], { asks: [ask('a', { scope: ['src'] })] })
  const one = through(x, 1)
  assert.equal(one.asks.a.declared, 'absent')
  assert.equal(one.asks.a.end, null, 'a grep over the whole scope matched nothing, and the ask is still open')
  assert.equal(Object.hasOwn(one.asks.a, 'absence'), false, 'no checked absence exists')
  const two = through(x, 2)
  assert.equal(two.asks.a.end, null, 'a stall sends it to the ruler; it does not end it')
  assert.equal(two.asks.a.due, true)
  assert.deepEqual(sent(two, 2), ['a'])
  const c = coverageLines(two, NAME)
  assert.deepEqual(c.declared, [], 'a navigator that declared absent leaves no declared line')
  assert.deepEqual(c.incomplete, [NAME + ':a: no end'])
  const ended = through(x, 2, [ruled(2, unit('a', 'absent', 'nothing in src names it'))])
  assert.deepEqual([ended.asks.a.end.state, ended.asks.a.end.answer, ended.asks.a.end.label], ['done', 'absent', 'ruled'], 'the ruler can end it done')
})

// ------------------------------------------------------------------ stall (N5.2)

test('a repeated state is a stall', () => {
  const x = script([{ calls: [move('a')] }, {}])
  assert.equal(through(x, 1).stalled, null, 'the first turn compares with nothing')
  const l = through(x, 2)
  assert.deepEqual(l.stalled, { turn: 2, k: 1 })
  assert.equal(l.asks.a.end, null, 'a stall alone ends nothing')
  const reworded = script([{ calls: [grep('a', [['src/a.js', 1]])], hits: [hit('a', 'src/a.js', 1, 'first')] }, { hits: [hit('a', 'src/a.js', 1, 'the same, in other words')] }])
  assert.deepEqual(fold(reworded).stalled, { turn: 2, k: 1 }, 'a note is no part of the state')
  const moving = script([{ calls: [move('a')] }, { calls: [move('a')] }])
  assert.equal(fold(moving).stalled, null, 'a turn that moved the ask is no stall')
  const queried = script([{ calls: [move('a')] }, { calls: [grep('a', [])] }])
  assert.equal(fold(queried).stalled, null, 'a new query that matched nothing is a move')
})

test('one moving ask keeps the others open', () => {
  const x = script([{ calls: [move('a')] }, { calls: [move('b')] }, {}], { asks: [ask('a'), ask('b')] })
  const two = through(x, 2)
  assert.equal(two.stalled, null, 'b moved at turn 2, though a repeated its turn-1 state')
  assert.deepEqual([two.asks.a.end, two.asks.b.end], [null, null])
  assert.deepEqual([two.asks.a.due, two.asks.b.due], [false, false])
  assert.deepEqual(sent(two, 2), [])
  const three = through(x, 3)
  assert.deepEqual(three.stalled, { turn: 3, k: 2 })
  assert.deepEqual([three.asks.a.due, three.asks.b.due], [true, true])
})

test('a turn about ended asks moves nothing', () => {
  const asks = [ask('a'), ask('b')]
  const shown = grep(['a', 'b'], [['src/x.js', 3]])
  const aboutA = { hits: [hit('a', 'src/x.js', 3)], dismissed: [dismiss('a', { path: 'src/x.js' })], leads: [{ ask: 'a', path: 'src/y.js', why: 'w' }], declare: [['a', 'open']] }
  const x = script([{ calls: [shown] }, { calls: [move('b')] }, aboutA], { asks })
  const rulings = [ruled(1, unit('a', 'answered', 'src/x.js:3 is the answer'))]
  const l = through(x, 3, rulings)
  assert.equal(l.asks.a.end.state, 'done')
  assert.deepEqual(l.stalled, { turn: 3, k: 2 }, 'the open ask b repeats its turn-2 state')
  assert.equal(l.asks.b.due, true)
  assert.deepEqual(sent(l, 3), ['b'])
  assert.deepEqual(l.refusals, [], 'the items are dropped, not refused')
  const withCall = script([{ calls: [shown] }, { calls: [move('b')] }, { ...aboutA, calls: [move('b')] }], { asks })
  assert.equal(through(withCall, 3, rulings).stalled, null, 'the same turn with a call under b is no stall')
})

test('only returned turns compare', () => {
  const x = script([{ calls: [move('a')] }, { missing: 'schema_failed' }, {}])
  assert.equal(through(x, 2).stalled, null, 'a missing turn is no stall')
  assert.deepEqual(through(x, 3).stalled, { turn: 3, k: 1 }, 'turn 3 equals turn 1, with a missing turn between')
  const worked = script([{ calls: [move('a')] }, { calls: [move('a')], missing: 'schema_failed' }, {}])
  assert.equal(through(worked, 3).stalled, null, 'the calls of the missing turn are in the state turn 3 returns, and the missing turn is no point to compare with')
})

test('a join resets the comparison', () => {
  const flips = [{ calls: [move('a')] }, { declare: [['a', 'answered']] }, { declare: [['a', 'open']] }, { declare: [['a', 'answered']] }]
  const control = fold(script(flips, { asks: [ask('a'), ask('b')] }))
  assert.deepEqual(control.stalled, { turn: 4, k: 2 }, 'without a join, a is back in its turn-2 state and b has not moved')
  const joined = fold(script(flips, { asks: [ask('a'), ask('b', { from: 4 })] }))
  assert.equal(joined.stalled, null, 'with b joining at turn 4, turn 2 is no comparison point')
  assert.deepEqual([joined.asks.a.end, joined.asks.b.end], [null, null])
  assert.deepEqual([joined.asks.a.due, joined.asks.b.due], [false, false])
  assert.deepEqual(sent(joined, 4), [])
})

test('a joined ask gets its first turn', () => {
  const x = script([{ calls: [move('a')] }, { calls: [move('a')] }, { calls: [move('a')] }, {}, {}], { asks: [ask('a'), ask('b', { from: 4 })] })
  const four = through(x, 4)
  assert.equal(four.stalled, null, 'b is idle at its first turn, and a repeats turn 3: not a stall')
  assert.deepEqual([four.asks.a.due, four.asks.b.due], [false, false])
  assert.deepEqual(sent(four, 4), [])
  const five = through(x, 5)
  assert.deepEqual(five.stalled, { turn: 5, k: 4 }, 'the next idle turn compares with the first')
  assert.deepEqual([five.asks.a.due, five.asks.b.due], [true, true])
  const alone = fold(script([{}]))
  assert.equal(alone.stalled, null, 'an ask that is idle at turn 1 has no earlier turn')
  assert.equal(alone.asks.a.due, false)
})

test('stalled agrees with the stamps of a pseudo-random search', () => {
  const lcg = (seed) => { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32 }
  for (let seed = 1; seed <= 80; seed++) {
    const rnd = lcg(seed)
    const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
    const keys = ['a', 'b', 'c']
    const asks = [ask('a', { from: 1 }), ask('b', { from: pick([1, 2, 3]) }), ask('c', { from: pick([1, 1, 2]) })]
    const joined = Math.max(...asks.map((s) => s.from))
    const specs = []
    for (let n = 1; n <= 9; n++) {
      const r = rnd()
      const target = pick(keys)
      if (r < 0.25) specs.push({})
      else if (r < 0.5) specs.push({ calls: [move([...new Set([target, pick(keys)])])] })
      else if (r < 0.65) specs.push({ calls: [grep(target, [])] })
      else if (r < 0.8) specs.push({ declare: [[target, pick(['answered', 'open', 'absent'])]] })
      else if (r < 0.9) specs.push({ hits: [hit(target, 'src/ghost/' + ++uid + '.js', 1)] })
      else specs.push(specs.at(-1)?.missing || n === 1 ? {} : { missing: 'schema_failed' })
    }
    const x = script(specs, { asks })
    for (let n = joined; n <= specs.length; n++) {
      if (specs[n - 1].missing) continue
      const l = through(x, n)
      const histories = Object.values(l.asks).map((s) => s.history)
      const entry = (h, turn) => h.find((e) => e.turn === turn)
      const equal = []
      for (let k = joined; k < n; k++) {
        if (histories.every((h) => entry(h, k) && entry(h, n) && entry(h, k).stamp === entry(h, n).stamp)) equal.push(k)
      }
      const what = 'seed ' + seed + ', turn ' + n
      if (equal.length === 0) {
        assert.equal(l.stalled, null, what)
      } else {
        assert.equal(l.stalled?.turn, n, what)
        assert.ok(equal.includes(l.stalled.k), what + ': k ' + l.stalled?.k + ' is not one of ' + equal)
        for (const [key, s] of Object.entries(l.asks)) assert.equal(s.due, true, what + ', ask ' + key)
      }
      for (const s of Object.values(l.asks)) assert.equal(s.end, null, what + ': with no ruling nothing ends')
    }
  }
})

// ------------------------------------------------------------------ at a stall (N5.3)

test('a stall sends an unruled ask to the ruler', () => {
  const x = script([{ calls: [move('a')] }, {}])
  const one = through(x, 1)
  assert.equal(one.asks.a.due, false)
  assert.deepEqual(sent(one, 1), [])
  const two = through(x, 2)
  assert.equal(two.asks.a.due, true)
  assert.equal(two.asks.a.end, null)
  const s = stateOf(two, { turn: 2, checkin: false })
  assert.deepEqual(s.toRuler, ['a'])
  assert.deepEqual(s.open, ['a'])
  assert.deepEqual(s.ending, [])
})

test('a stall after an open ruling ends the ask', () => {
  const x = script([{ calls: [move('a')] }, { calls: [move('a')] }, { calls: [move('a')] }, {}])
  const open = ruled(3, unit('a', 'open', 'read the lease code'))
  const three = through(x, 3, [open])
  assert.equal(three.asks.a.end, null)
  assert.equal(three.asks.a.due, false, 'ruling it settles the due')
  const l = through(x, 4, [open])
  assert.deepEqual(l.stalled, { turn: 4, k: 3 })
  const end = l.asks.a.end
  assert.deepEqual([end.state, end.label, end.turn], ['no_progress', 'observed', 4])
  assert.match(end.why, /\b3\b/, 'it names the turn whose state it equals')
  assert.ok(end.why.includes('read the lease code'), 'and the standing open ruling: ' + end.why)
  assert.equal(l.asks.a.due, false)
  assert.deepEqual(stateOf(l, { turn: 4, checkin: false }).ending.map((e) => [e.ask, e.state, e.label, e.why]), [['a', 'no_progress', 'observed', end.why]])
  assert.deepEqual(stateOf(l, { turn: 4, checkin: false }).toRuler, [])
  assert.equal(through(x, 4).asks.a.end, null, 'with no ruling the same stall ends nothing')
})

test('one stall ends one ask and rules the other', () => {
  const x = script([{ calls: [move('a')] }, { calls: [move('a')] }, { calls: [move('a')] }, {}], { asks: [ask('a'), ask('b')] })
  const checkin = ruled(3, unit('a', 'open', 'read the lease code'))
  assert.deepEqual(sent(through(x, 3), 3, true), ['a'], 'at the check-in b has not moved since it joined')
  const l = through(x, 4, [checkin])
  assert.deepEqual(l.stalled, { turn: 4, k: 3 })
  assert.equal(l.asks.a.end.state, 'no_progress')
  assert.equal(l.asks.b.end, null)
  assert.deepEqual([l.asks.a.due, l.asks.b.due], [false, true])
  const s = stateOf(l, { turn: 4, checkin: false })
  assert.deepEqual(s.toRuler, ['b'])
  assert.deepEqual(s.ending.map((e) => e.ask), ['a'])
  assert.deepEqual(s.open, ['b'])
})

test('an idle want is ruled before it ends', () => {
  const idle = script([{}, {}, {}], { asks: [ask('w')] })
  assert.equal(through(idle, 1).asks.w.due, false, 'idle at its first turn')
  const two = through(idle, 2)
  assert.equal(two.asks.w.due, true, 'idle again')
  assert.deepEqual(sent(two, 2), ['w'])
  assert.equal(two.asks.w.end, null)
  const open = ruled(2, unit('w', 'open', 'grep for X'))
  const ruledTwo = through(idle, 2, [open])
  assert.deepEqual([ruledTwo.asks.w.end, ruledTwo.asks.w.due], [null, false])
  const three = through(idle, 3, [open])
  assert.deepEqual([three.asks.w.end.state, three.asks.w.end.label, three.asks.w.end.turn], ['no_progress', 'observed', 3])
  assert.ok(three.asks.w.end.why.includes('grep for X'), three.asks.w.end.why)

  // the want joins after turn 1, beside an ask a ruling ended
  const late = script([{ calls: [move('a')] }, {}, {}, {}], { asks: [ask('a'), ask('w', { from: 2 })] })
  const answered = ruled(1, unit('a', 'answered', 'src/a.ts holds it'))
  assert.equal(through(late, 2, [answered]).asks.w.due, false, 'its first turn')
  const lateTwo = through(late, 3, [answered])
  assert.deepEqual([lateTwo.asks.w.due, lateTwo.asks.w.end], [true, null])
  assert.deepEqual(sent(lateTwo, 3), ['w'])
  const openW = ruled(3, unit('w', 'open', 'grep for X'))
  assert.equal(through(late, 4, [answered, openW]).asks.w.end?.state, 'no_progress')
})

test('a fresh refusal reaches a ruling before an end', () => {
  const ghost = (path) => ({ hits: [hit('a', path, 3)] })
  const x = script([{ calls: [move('a')] }, {}, ghost('src/nowhere.js'), ghost('src/nowhere.js')])
  const open = (turn) => ruled(turn, unit('a', 'open', 'go on'))
  const two = through(x, 2)
  assert.equal(two.asks.a.due, true)
  const three = through(x, 3, [open(2)])
  assert.deepEqual(classes(three), ['unobserved'])
  assert.equal(three.asks.a.stamp, three.asks.a.history.at(-2).stamp, 'a refusal moves no stamp')
  assert.notEqual(three.asks.a.refused, three.asks.a.history.at(-2).refused, 'but it changes the refused set')
  assert.equal(three.stalled?.turn, 3)
  assert.equal(three.asks.a.end, null, 'a ruling that did not see the refusal does not end the ask')
  assert.equal(three.asks.a.due, true)
  assert.deepEqual(sent(three, 3), ['a'])
  const four = through(x, 4, [open(2), open(3)])
  assert.equal(four.asks.a.end?.state, 'no_progress', 'the same citation again is a state a ruling saw')

  // every kind of item refused unobserved is a refusal to be ruled upon
  const kinds = {
    'a hit on a line no call showed': { hits: [hit('a', 'src/b.js', 9)] },
    'a dismissal naming no path, glob or call': { dismissed: [{ ask: ['a'], why: 'w' }] },
    'a lead naming no path': { leads: [{ ask: 'a', why: 'w' }] },
    'a declaration that is none of the three': { declare: [['a', 'bogus']] },
  }
  for (const [what, item] of Object.entries(kinds)) {
    const k = script([{ calls: [move('a')] }, {}, item])
    const l = through(k, 3, [open(2)])
    assert.deepEqual(classes(l), ['unobserved'], what)
    assert.equal(l.asks.a.end, null, what)
    assert.equal(l.asks.a.due, true, what)
  }
})

test('a reworded refusal is the same refusal', () => {
  const cite = (note) => ({ hits: [hit('a', 'src/nowhere.js', 3, note)] })
  const x = script([{ calls: [move('a')] }, cite('one wording'), cite('another wording')])
  const l = through(x, 3)
  const [r0, r1, r2] = [1, 2, 3].map((n) => through(x, n).asks.a.refused)
  assert.notEqual(r1, r0, 'the first citation is refused')
  assert.equal(r2, r1, 'the same citation in other words changes nothing')
  assert.equal(l.asks.a.history.at(-1).refused, l.asks.a.history.at(-2).refused)
  assert.deepEqual([l.asks.a.end, l.asks.a.due], [null, true], 'with no ruling the stall sends it to the ruler')
  const ended = through(x, 3, [ruled(2, unit('a', 'open', 'go on'))])
  assert.equal(ended.asks.a.end?.state, 'no_progress', 'a ruling that saw the refusal ends the ask when it comes again')
})

test('a two-value flip-flop ends', () => {
  const flip = Array.from({ length: 12 }, (_, i) => ({ ...(i === 0 ? { calls: [move('a')] } : {}), declare: [['a', i % 2 === 0 ? 'answered' : 'open']] }))
  const { l, rulings } = play(script(flip), alwaysOpen)
  assert.equal(l.asks.a.end?.state, 'no_progress')
  assert.ok(rulings.length <= 3, 'ruled ' + rulings.length + ' times')
  assert.ok(l.asks.a.end.turn <= 9, 'ended at turn ' + l.asks.a.end.turn)
  assert.equal(l.asks.a.end.label, 'observed')
})

test('a three-value flip-flop ends', () => {
  const values = ['answered', 'absent', 'open']
  const flip = Array.from({ length: 15 }, (_, i) => ({ ...(i === 0 ? { calls: [move('a')] } : {}), declare: [['a', values[i % 3]]] }))
  const { l, rulings } = play(script(flip), alwaysOpen)
  assert.equal(l.asks.a.end?.state, 'no_progress')
  assert.ok(rulings.length <= 3, 'ruled ' + rulings.length + ' times')
  assert.ok(l.asks.a.end.turn <= 12, 'ended at turn ' + l.asks.a.end.turn)
})

test('any earlier ruling at this state counts', () => {
  const x = script([
    { calls: [move('a')], declare: [['a', 'answered']] }, {},
    { declare: [['a', 'open']] },
    { declare: [['a', 'answered']] },
  ])
  const atS1 = ruled(2, unit('a', 'open', 'say what is missing'))
  const atS2 = ruled(3, unit('a', 'open', 'still undecided'))
  const three = through(x, 3, [atS1])
  assert.deepEqual(sent(three, 3, true), ['a'], 'the declaration moved the state since the turn-2 ruling')
  const ruledTwice = through(x, 3, [atS1, atS2])
  assert.deepEqual([ruledTwice.asks.a.end, ruledTwice.asks.a.due], [null, false])
  const l = through(x, 4, [atS1, atS2])
  assert.equal(l.stalled?.turn, 4)
  assert.deepEqual([l.asks.a.end?.state, l.asks.a.end?.label, l.asks.a.end?.turn], ['no_progress', 'observed', 4], 'back in the state the turn-2 ruling saw, though the latest ruling saw another')
  const latestOnly = through(x, 4, [atS2])
  assert.deepEqual([latestOnly.asks.a.end, latestOnly.asks.a.due], [null, true], 'with only the later ruling the state was never ruled upon')
})

test('alternating idle turns', () => {
  const alternate = script(Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? { calls: [grep('a', [])], ...(i === 0 ? { declare: [['a', 'answered']] } : {}) } : {})))
  const keepGoing = play(alternate, alwaysOpen)
  assert.deepEqual(keepGoing.toRulers, [[], ['a'], [], ['a'], [], ['a']], 'one entry per stall, none between')
  assert.equal(keepGoing.l.asks.a.end, null, 'new queries are progress; the ruler keeps it going')
  assert.equal(keepGoing.rulings.length, 3)
  const answers = play(alternate, (a, n) => unit(a, 'answered', 'src/a.ts holds it'))
  assert.deepEqual(answers.toRulers, [[], ['a'], [], [], [], []])
  const end = answers.l.asks.a.end
  assert.deepEqual([end.state, end.answer, end.label, end.turn], ['done', 'answered', 'ruled', 2])
})

// ------------------------------------------------------------------ check-in (stateOf)

test('a check-in rules what moved', () => {
  const asks = ['a', 'b', 'c', 'd', 'e'].map((k) => ask(k))
  const x = script([{ calls: [move(['a', 'b', 'd', 'e'])] }, { calls: [move('a')] }, { calls: [move('a')] }], { asks })
  const rulings = [ruled(1, unit('a', 'open', 'go on'), unit('b', 'open', 'go on'), unit('d', 'answered', 'it is in src/a.ts'))]
  const l = through(x, 3, rulings)
  assert.equal(l.stalled, null)
  assert.deepEqual([...sent(l, 3, true)].sort(), ['a', 'e'], 'a moved since its ruling, e since it joined; b did not move, c never did, d ended')
  assert.deepEqual(sent(l, 3, false), [], 'a turn that is no check-in sends nothing')
})

test('due and checked-in are one list', () => {
  const x = script([{ calls: [move(['a', 'b'])] }, {}, { hits: [hit('a', 'src/nowhere.js', 3)] }], { asks: [ask('a'), ask('b')] })
  const l = through(x, 3, [ruled(2, unit('a', 'open', 'go on'))])
  assert.deepEqual(l.stalled?.turn, 3)
  assert.deepEqual([l.asks.a.due, l.asks.b.due], [true, true], 'a: a refusal its ruling never saw; b: never ruled')
  for (const checkin of [true, false]) {
    const list = sent(l, 3, checkin)
    assert.deepEqual([...list].sort(), ['a', 'b'], 'checkin ' + checkin)
    assert.equal(new Set(list).size, list.length, 'each once')
  }
})

// ------------------------------------------------------------------ rulings (applyRuling)

test('a ruled answer ends done', () => {
  const x = script([{ calls: [grep('a', [['src/a.js', 2]])], hits: [hit('a', 'src/a.js', 2)] }])
  const l = through(x, 1, [ruled(1, unit('a', 'answered', 'src/a.js:2 defines it'))])
  const end = l.asks.a.end
  assert.deepEqual([end.state, end.answer, end.label, end.why, end.turn], ['done', 'answered', 'ruled', 'src/a.js:2 defines it', 1])
  assert.deepEqual(stateOf(l, { turn: 1, checkin: false }).open, [])
  assert.equal(l.asks.a.due, false)
  const overridden = through(script([{ calls: [move('a')], declare: [['a', 'open']] }]), 1, [ruled(1, unit('a', 'answered', 'the ruler decides'))])
  assert.equal(overridden.asks.a.end.state, 'done', 'a navigator that declared open does not override the ruler')
  const refused = through(script([{ calls: [move('a')], declare: [['a', 'answered']] }]), 1, [ruled(1, unit('a', 'open', 'not yet'))])
  assert.equal(refused.asks.a.end, null, 'nor one that declared answered')
})

test('a ruled absence ends done', () => {
  const x = script([{ calls: [grep('a', [])], declare: [['a', 'answered']] }])
  const end = through(x, 1, [ruled(1, unit('a', 'absent', 'the grep matched nothing'))]).asks.a.end
  assert.deepEqual([end.state, end.answer, end.label, end.why, end.turn], ['done', 'absent', 'ruled', 'the grep matched nothing', 1])
})

test('ruled absent with hits', () => {
  const x = script([{ calls: [grep('a', [['src/a.js', 2]])], hits: [hit('a', 'src/a.js', 2)] }])
  const l = through(x, 1, [ruled(1, unit('a', 'absent', 'src/a.js:2 is not what the ask asks'))])
  assert.deepEqual([l.asks.a.end.state, l.asks.a.end.answer, l.asks.a.end.label], ['done', 'absent', 'ruled'])
  assert.deepEqual(l.asks.a.hits.map((h) => h.key + ':' + h.line), ['src/a.js:2'], 'the hits stay in the view')
})

test('a ruled end stands', () => {
  const asks = [ask('a'), ask('b')]
  const x = script([{ calls: [move(['a', 'b'])] }, { calls: [grep(['a', 'b'], [['src/late.js', 5]])], hits: [hit(['a', 'b'], 'src/late.js', 5)] }], { asks })
  const rulings = [ruled(1, unit('a', 'answered', 'it is there'))]
  const one = through(x, 1, rulings)
  const l = through(x, 2, rulings)
  assert.equal(l.asks.a.end.turn, 1)
  assert.deepEqual(l.asks.a.hits, [], 'the hit is not added to an ended ask')
  assert.deepEqual(l.asks.a.observed, one.asks.a.observed, 'nor is what the later call showed')
  assert.deepEqual(l.asks.b.hits.map((h) => h.key), ['src/late.js'], 'the open ask it also names takes it')
  assert.deepEqual(l.refusals, [])
})

test('not_converging ends', () => {
  const x = script([{ calls: [move('a')] }, {}])
  const ruling = ruled(1, unit('a', 'not_converging', 'every new line is another fixture'))
  const l = through(x, 1, [ruling])
  const end = l.asks.a.end
  assert.deepEqual([end.state, end.label, end.why, end.turn], ['not_converging', 'ruled', 'every new line is another fixture', 1])
  const held = script([{ calls: [move('a')] }, {}, { hits: [hit('a', 'src/nowhere.js', 3)] }])
  const fresh = through(held, 3, [ruled(3, unit('a', 'not_converging', 'only refused citations since the last ruling'))])
  assert.equal(fresh.asks.a.due, false)
  assert.equal(fresh.asks.a.end.state, 'not_converging', 'it ends an ask a fresh refusal had made due')
})

test('open stands as the ask\'s ruling', () => {
  const x = script([{ calls: [move('a')] }, { calls: [move('a')] }, { calls: [move('a')] }])
  assert.equal(through(x, 3).asks.a.ruling, null)
  const first = through(x, 3, [ruled(2, unit('a', 'open', 'read the lease code'))])
  assert.equal(first.asks.a.end, null)
  assert.deepEqual([first.asks.a.ruling.turn, first.asks.a.ruling.why], [2, 'read the lease code'])
  const second = through(x, 3, [ruled(2, unit('a', 'open', 'read the lease code')), ruled(3, unit('a', 'open', 'then the settings'))])
  assert.deepEqual([second.asks.a.ruling.turn, second.asks.a.ruling.why], [3, 'then the settings'], 'the latest open ruling stands')
})

test('missed twice stops', () => {
  const asks = [ask('a'), ask('b')]
  const x = script([{ calls: [move(['a', 'b'])] }, { calls: [move(['a', 'b'])] }, { calls: [move(['a', 'b'])] }], { asks })
  const miss = (why, ...names) => ({ turn: 3, asks: names, missing: why })
  const once = fold({ ...x, rulings: [miss('schema_failed', 'a', 'b')] })
  assert.deepEqual([once.asks.a.end, once.asks.b.end], [null, null])
  const twice = fold({ ...x, rulings: [miss('schema_failed', 'a', 'b'), { turn: 3, asks: ['a', 'b'], units: [unit('a', 'open')] }] })
  assert.equal(twice.asks.a.end, null, 'a was ruled the second time')
  assert.deepEqual([twice.asks.b.end.state, twice.asks.b.end.by, twice.asks.b.end.label], ['stopped', 'ruler', 'observed'])
  const back = fold({ ...x, rulings: [miss('x', 'b'), miss('y', 'b'), ruled(3, unit('b', 'open'))] })
  assert.equal(back.asks.b.end, null, 'a later ruling of it reopens it')
  const between = fold({ ...x, rulings: [miss('x', 'a'), ruled(3, unit('a', 'open')), miss('y', 'a')] })
  assert.equal(between.asks.a.end, null, 'a ruling between two misses resets the count')
})

test('contradicts_hit refuses the navigator only', () => {
  const x = script([{ calls: [grep('a', [['src/a.js', 3]])], hits: [hit('a', 'src/a.js', 3)] }, { declare: [['a', 'absent']] }])
  const l = through(x, 2)
  assert.deepEqual(classes(l), ['contradicts_hit'])
  assert.equal(l.asks.a.declared, '')
  const ruledAbsent = through(x, 2, [ruled(2, unit('a', 'absent', 'the hit is not what the ask asks'))])
  assert.deepEqual([ruledAbsent.asks.a.end.state, ruledAbsent.asks.a.end.answer], ['done', 'absent'])
  assert.deepEqual(classes(ruledAbsent), ['contradicts_hit'], 'the refusal stays recorded')
})

// ------------------------------------------------------------------ coverage lines (N7)

test('a ruled done is declared with what it rests on', () => {
  const lookedSummary = exported('lookedSummary')
  const asks = [ask('a', { scope: ['src'] }), ask('b', { scope: ['src'] }), ask('c', { scope: ['src'] })]
  const x = script([{
    calls: [grep(['a', 'c'], [['src/a.ts', 2], ['src/b.ts', 5]], { pattern: 'seatDay' }), grep('b', [], { pattern: 'seatNight' })],
    hits: [hit('a', 'src/a.ts', 2, 'defines it')], declare: [['c', 'answered']],
  }], { asks })
  const l = through(x, 1, [ruled(1, unit('a', 'answered', 'src/a.ts:2 defines seatDay'), unit('b', 'absent', 'nothing in src names seatNight'))])
  const c = coverageLines(l, NAME)
  assert.deepEqual([...c.declared].sort(), [
    NAME + ':a: ruled answered: src/a.ts:2 defines seatDay — looked ' + lookedSummary(l.asks.a.looked),
    NAME + ':b: ruled absent: nothing in src names seatNight — looked ' + lookedSummary(l.asks.b.looked),
  ].sort())
  assert.deepEqual(c.incomplete, [NAME + ':c: no end'], 'c declared answered and nothing ruled: it is not done')
})

test('a scope-owing done names what each directory rests on', () => {
  const owes = ['src/a.ts', 'src/b/c.ts', 'lib/d.ts', 'docs/x.md']
  const x = script([{ calls: [grep('t', [], { pattern: 'foo', paths: ['src'] }), read('t', 'lib/d.ts', 40)] }], { asks: [owing('t', owes)] })
  const l = through(x, 1, [ruled(1, unit('t', 'absent', 'nothing in the files looked at'))])
  const covered = l.asks.t.covered
  assert.deepEqual(Object.keys(covered).sort(), ['lib', 'src', 'src/b'])
  const lines = coverageLines(l, NAME).declared
  assert.equal(lines.filter((line) => line.startsWith(NAME + ':t: ruled absent: nothing in the files looked at')).length, 1)
  const rests = lines.filter((line) => line.includes(') rests on '))
  assert.equal(rests.length, 3, 'one line per covered directory: ' + JSON.stringify(lines))
  for (const [dir, { files, by }] of Object.entries(covered)) {
    const mine = rests.filter((line) => line.startsWith(NAME + ':t: ' + dir + '/ (' + files + ' file'))
    assert.equal(mine.length, 1, dir)
    for (const text of by) assert.ok(mine[0].includes(text), dir + ' rests on ' + text + ': ' + mine[0])
  }
  const plain = through(script([{ calls: [move('a')] }]), 1, [ruled(1, unit('a', 'answered', 'it is there'))])
  assert.equal(coverageLines(plain, NAME).declared.filter((line) => line.includes(' rests on ')).length, 0, 'an ask that owes no files has no directory lines')
})

test('unopened dismissals are declared', () => {
  const rows = ground(...['src/x/a.ts', 'src/x/b.ts', 'src/y/c.ts', 'lib/m.ts', 'lib/sub/n.ts', 'docs/z.md'].map((k) => pathRow(k)))
  const x = script([{
    calls: [read('a', 'src/y/c.ts', 3)],
    dismissed: [dismiss('a', { glob: 'src/x/**' }, 'generated fixtures'), dismiss('a', { path: 'src/y/c.ts' }, 'read it, nothing'), dismiss('a', { path: 'lib' }, 'vendored')],
  }], { ground: rows })
  const l = through(x, 1, [ruled(1, unit('a', 'absent', 'nothing in the files opened'))])
  const lines = coverageLines(l, NAME).declared.filter((line) => line.includes('dismissed unopened'))
  assert.deepEqual([...lines].sort(), [
    NAME + ':a: dismissed unopened: 2 under src/x/ (generated fixtures)',
    NAME + ':a: dismissed unopened: 1 under lib/ (vendored)',
    NAME + ':a: dismissed unopened: 1 under lib/sub/ (vendored)',
  ].sort(), 'grouped by directory; the file read to its end was opened')

  const owes = ['src/a.ts', 'docs/x.md', 'docs/y.md']
  const owed = script([{ calls: [read('t', 'src/a.ts', 5)], dismissed: [dismiss('t', { glob: 'docs/**' }, 'prose')] }], { asks: [owing('t', owes)] })
  const files = coverageLines(through(owed, 1, [ruled(1, unit('t', 'absent', 'nothing in src'))]), NAME).declared.filter((line) => line.includes('dismissed unopened'))
  assert.deepEqual(files, [NAME + ':t: dismissed unopened: 2 under docs/ (prose)'], 'owed files are agenda items too')
})

test('other ends are incomplete', () => {
  const asks = ['np', 'nc', 'dn', 'op'].map((k) => ask(k))
  const x = script([{ calls: [move(['np', 'nc', 'dn', 'op'])] }, {}], { asks })
  const l = through(x, 2, [ruled(1, unit('np', 'open', 'read the config loader'), unit('nc', 'not_converging', 'every new line is another fixture'), unit('dn', 'answered', 'it is in the loader'))])
  assert.equal(l.asks.np.end.state, 'no_progress')
  const c = coverageLines(l, NAME)
  assert.deepEqual([...c.incomplete].sort(), [
    NAME + ':np: no_progress, ' + l.asks.np.end.why,
    NAME + ':nc: not_converging, every new line is another fixture',
    NAME + ':op: no end',
  ].sort())
  assert.equal(c.declared.length, 1, 'only the ruled done is declared')
  assert.ok(c.declared[0].startsWith(NAME + ':dn: ruled answered: it is in the loader'), c.declared[0])
})

test('owed files fold by directory', () => {
  const owes = ['src/a.ts', 'src/b.ts', 'src/x/c.ts', 'lib/d.ts', 'lib/e.ts']
  const x = script([{ calls: [read('t', 'lib/d.ts', 40)] }], { asks: [owing('t', owes)] })
  const l = through(x, 1)
  const lines = coverageLines(l, NAME).unreached
  assert.deepEqual([...lines].sort(), [
    NAME + ':t: files src/ (2 not covered)',
    NAME + ':t: files src/x/ (1 not covered)',
    NAME + ':t: files lib/ (1 not covered)',
  ].sort())
  assert.equal(lines.some((line) => line.includes('src/a.ts')), false, 'never one line per file')
  const ended = coverageLines(through(x, 1, [ruled(1, unit('t', 'not_converging', 'stuck'))]), NAME).unreached
  assert.equal(ended.filter((line) => line.includes(' files ')).length, 3, 'an ended ask reports what it left')
})

test('never looked is distinct from found nothing', () => {
  const asks = [ask('a'), ask('b')]
  const x = script([{ calls: [grep('b', [], { pattern: 'nothing like this' })] }], { asks })
  const l = through(x, 1, [ruled(1, unit('a', 'absent', 'the scope holds nothing'), unit('b', 'absent', 'the grep matched nothing'))])
  assert.deepEqual(l.asks.a.looked, [])
  assert.equal(l.asks.b.looked.length, 1)
  const unreached = coverageLines(l, NAME).unreached
  assert.deepEqual(unreached, [NAME + ':a: no call ran under it'])
})

test('the ended-asks refusal is gone', () => {
  assert.equal(Object.hasOwn(REFUSAL_REASON, 'names_only_ended_asks'), false)
  for (const cls of ['unobserved', 'unknown_ask', 'contradicts_hit']) assert.equal(typeof REFUSAL_REASON[cls], 'string', cls + ' stays')
})

test('an item about ended asks is dropped', () => {
  const asks = [ask('a'), ask('b')]
  const everyKind = { hits: [hit('a', 'src/x.js', 2), hit('a', 'src/ghost.js', 9)], dismissed: [dismiss('a', { path: 'y.js' })], leads: [{ ask: 'a', path: 'src/l.js', why: 'w' }], declare: [['a', 'open']] }
  const x = script([{ calls: [grep('a', [['src/x.js', 2]])], declare: [['a', 'answered']] }, everyKind], { asks })
  const rulings = [ruled(1, unit('a', 'answered', 'it is in src/x.js'))]
  const one = through(x, 1, rulings)
  const l = through(x, 2, rulings)
  assert.deepEqual(l.refusals, [], 'no refusal, not names_only_ended_asks and not unobserved')
  assert.deepEqual(standingRefusals(l), [])
  assert.deepEqual([l.asks.a.hits, l.asks.a.dismissed, l.asks.a.leads, l.asks.a.declared], [one.asks.a.hits, one.asks.a.dismissed, one.asks.a.leads, one.asks.a.declared], 'no fact')
  assert.equal(l.asks.a.end.turn, 1)

  const both = script([{ calls: [grep(['a', 'b'], [['src/x.js', 2]])] }, { dismissed: [dismiss(['a', 'b'], { path: 'y.js' })], hits: [hit(['a', 'b'], 'src/x.js', 2)] }], { asks })
  const m = through(both, 2, rulings)
  assert.deepEqual(m.asks.b.dismissed.map((d) => d.key), ['y.js'], 'naming an ended and an open ask, it applies to the open one')
  assert.deepEqual(m.asks.b.hits.map((h) => h.key), ['src/x.js'])
  assert.deepEqual(m.asks.a.dismissed, [])
  assert.deepEqual(m.refusals, [])
})

// ------------------------------------------------------------------ fileGroups and lookedSummary (pure)

test('fileGroups by parent directory', () => {
  const fileGroups = exported('fileGroups')
  assert.deepEqual(fileGroups(['a.ts', 'src/b.ts', 'src/c.ts', 'src/x/d.ts']), [{ dir: '.', n: 1 }, { dir: 'src', n: 2 }, { dir: 'src/x', n: 1 }])
  const keys = ['src/x/d.ts', 'lib/e.ts', 'README.md', 'src/b.ts', 'docs/x.md', 'docs/y.md']
  const groups = fileGroups(keys)
  assert.deepEqual(groups, [{ dir: '.', n: 1 }, { dir: 'docs', n: 2 }, { dir: 'lib', n: 1 }, { dir: 'src', n: 1 }, { dir: 'src/x', n: 1 }])
  assert.deepEqual(fileGroups([...keys].reverse()), groups, 'the order of the keys is no part of the answer')
  assert.equal(groups.reduce((n, g) => n + g.n, 0), keys.length)
  assert.deepEqual(fileGroups([]), [])
})

test('lookedSummary is distinct queries', () => {
  const lookedSummary = exported('lookedSummary')
  const e = (seq, tool, what, where, total) => ({ seq, tool, what, where, total, pages: 1, pages_seen: 1 })
  const looked = [e(1, 'grep', 'seatDay', ['src'], 3), e(2, 'log', 'seatDay', ['lib'], 1), e(3, 'grep', 'seatDay', ['src'], 3), e(4, 'grep', 'seatDay', ['lib'], 0)]
  const parts = lookedSummary(looked).split('; ')
  assert.deepEqual([...parts].sort(), ['grep seatDay@lib→0', 'grep seatDay@src→3', 'log seatDay@lib→1'], 'each distinct query once, as tool what@where→total')
  const view = through(script([{ calls: [grep('a', [['src/a.ts', 1]], { pattern: 'seatDay', paths: ['src'] }), grep('a', [], { pattern: 'seatDay', paths: ['lib'] })] }]), 1).asks.a.looked
  assert.deepEqual(lookedSummary(view).split('; ').sort(), ['grep seatDay@lib→0', 'grep seatDay@src→1'], 'over the view the fold gives')
})

// ------------------------------------------------------------------ failure modes

test('a replayed ruling folds the same', () => {
  const x = script([{ calls: [move('a')] }, { calls: [move('a')] }, { calls: [move('a')] }, {}])
  const rulings = [ruled(3, unit('a', 'open', 'read the lease code'))]
  const facts = { ...x, rulings }
  const frozen = JSON.stringify(facts)
  const once = fold(facts)
  assert.deepEqual(fold(structuredClone(facts)), once)
  assert.equal(JSON.stringify(facts), frozen, 'folding changes no input')
  assert.equal(once.asks.a.end.state, 'no_progress')
  assert.equal(through(x, 3, rulings).asks.a.ruling?.turn, 3, 'the open ruling is part of the folded state')
  const stall = script([{ calls: [move('a')] }, {}])
  const journaled = [ruled(2, unit('a', 'open', 'go on'))]
  assert.deepEqual(through(stall, 2, journaled), fold({ ...stall, rulings: journaled }), 'a ruling journaled after its turn folds as if it came with it')
})

test('a ruling for an unknown ask is ignored', () => {
  const x = script([{ calls: [move('a')] }, {}])
  const base = fold(x)
  const alone = fold({ ...x, rulings: [{ turn: 2, asks: ['zzz'], units: [unit('zzz', 'answered', 'nobody asked')] }] })
  assert.deepEqual(alone.asks, base.asks)
  const beside = fold({ ...x, rulings: [{ turn: 2, asks: ['a', 'zzz'], units: [unit('a', 'open', 'go on'), unit('zzz', 'not_converging', 'nobody asked')] }] })
  assert.deepEqual(Object.keys(beside.asks), ['a'])
  assert.equal(beside.asks.a.ruling?.why, 'go on', 'the ask it does name is ruled')
})

test('a ruling after an end changes nothing', () => {
  const x = script([{ calls: [move('a')] }, { calls: [move('a')] }, { calls: [move('a')] }, {}])
  const first = ruled(1, unit('a', 'answered', 'it is in src/a.ts'))
  const later = [ruled(2, unit('a', 'not_converging', 'too late')), ruled(3, unit('a', 'open', 'too late')), ruled(3, unit('a', 'absent', 'too late'))]
  assert.deepEqual(through(x, 3, [first, ...later]).asks.a, through(x, 3, [first]).asks.a, 'after a ruled end')
  const open = ruled(3, unit('a', 'open', 'read the lease code'))
  const stalled = through(x, 4, [open])
  assert.equal(stalled.asks.a.end.state, 'no_progress')
  assert.deepEqual(through(x, 4, [open, ruled(4, unit('a', 'answered', 'too late'))]).asks.a, stalled.asks.a, 'after an end by a stall')
})

// ------------------------------------------------------------------ stops and reopening (unchanged)

test('a stop turn stops every open ask, by the navigator, and an ask that already ended keeps its end', () => {
  const asks = [ask('a'), ask('b'), ask('c')]
  const x = script([{ calls: [move(['a', 'b', 'c'])] }, { stop: 'host_limit' }], { asks })
  const l = through(x, 2, [ruled(1, unit('b', 'answered', 'it is there'))])
  assert.equal(l.asks.b.end.state, 'done')
  for (const k of ['a', 'c']) assert.deepEqual([l.asks[k].end.state, l.asks[k].end.by, l.asks[k].end.turn, l.asks[k].end.label, l.asks[k].end.why], ['stopped', 'navigator', 2, 'observed', 'host_limit'], k)
  assert.deepEqual(stateOf(l, { turn: 2, checkin: false }).open, [])
  const later = script([{ calls: [move(['a', 'b', 'c'])] }, { stop: 'host_limit' }, { calls: [move('a')] }], { asks })
  const back = through(later, 3, [ruled(1, unit('b', 'answered', 'it is there'))])
  assert.deepEqual([back.asks.a.end, back.asks.c.end], [null, null], 'a later returned turn reopens them')
  assert.equal(back.asks.b.end.state, 'done')
})

test('a navigator stop stops an ask whose from is ahead too, and a returned turn reopens one that has not joined yet', () => {
  const ahead = script([{ calls: [move('a')] }, { stop: 'host_limit' }], { asks: [ask('a'), ask('w', { from: 5 })] })
  const stopped = fold(ahead)
  assert.deepEqual([stopped.asks.w.end.state, stopped.asks.w.end.by, stopped.asks.w.end.turn], ['stopped', 'navigator', 2])
  assert.deepEqual(stateOf(stopped, { turn: 2, checkin: false }).open, [])
  const missed = fold(script([{ calls: [move('a')] }, { missing: 'host_error' }, { missing: 'schema_failed' }], { asks: [ask('a'), ask('w', { from: 5 })] }))
  assert.deepEqual([missed.asks.w.end.state, missed.asks.w.end.by, missed.asks.w.end.turn], ['stopped', 'navigator', 3])

  const rejoin = script([{ calls: [move('a')] }, { stop: 'host_limit' }, { calls: [move('a')] }, {}], { asks: [ask('a'), ask('w', { from: 4 })] })
  const reopened = through(rejoin, 3)
  assert.equal(reopened.asks.w.end, null)
  assert.deepEqual(reopened.asks.w.history.map((h) => h.turn), [3], 'turn 3 is before its from')
  const joined = through(rejoin, 4)
  assert.equal(joined.asks.w.end, null, 'its first turn is idle and no stall')
  assert.deepEqual(joined.asks.w.history.map((h) => h.turn), [3, 4])
})
