// test/fast/search-replay.test.mjs — the failure shapes a field search showed, replayed on the fold.
// Each fixture in test/fixtures/search-replay/ is synthetic: asks, ground, a call log, turn records
// and rulings, with an oracle of how each ask ends, the coverage lines it owes, and which asks go
// to the ruler after each turn. The test folds every prefix of turns the way the loop does: after
// turn n it holds the rulings journaled before n, asks stateOf who is owed a ruling, and checks it.
//
// Design: docs/DESIGN.md#searches and docs/DESIGN.md#l2--states-end-work-counts-dont.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { coverageLines, foldLedger, stateOf } from '../../lib/search/ledger.mjs'

const DIR = join(import.meta.dirname, '..', 'fixtures', 'search-replay')
const NAMES = ['v3-prose-absence', 'idle-want', 'drain-after-answer', 'rewording-loop']
const load = (name) => JSON.parse(readFileSync(join(DIR, name + '.json'), 'utf8'))

/** The fixture folded through its first n turns, with the rulings of turns before `upTo` (default: through n). */
const foldPrefix = (f, n, upTo = n) => foldLedger({
  asks: f.asks, ground: f.ground, calls: f.calls, turns: f.turns.slice(0, n),
  rulings: f.rulings.filter((r) => r.turn <= upTo),
})
const full = (f) => foldPrefix(f, f.turns.length)
const sorted = (xs) => [...xs].sort()

/** A coverage line with what the contract leaves to the implementation taken out: the order of a directory's `rests on` list, and an agenda item's detail. */
function norm(line) {
  const rests = / rests on (.*)$/.exec(line)
  if (rests) return line.slice(0, rests.index) + ' rests on ' + rests[1].split(', ').sort().join(', ')
  const item = /^([^:]+:[^:]+: (?:seed|lead|ground|symbol|overflow) \S+)(?: \(.*\))?$/.exec(line)
  return item ? item[1] : line
}

test('every fixture is on disk, and synthetic in shape', () => {
  assert.deepEqual(sorted(readdirSync(DIR).filter((f) => f.endsWith('.json'))), sorted(NAMES.map((n) => n + '.json')))
  for (const name of NAMES) {
    const f = load(name)
    assert.equal(f.name, name)
    for (const key of ['asks', 'ground', 'calls', 'turns', 'rulings', 'oracle']) assert.ok(key in f, name + ' has ' + key)
    assert.deepEqual(sorted(Object.keys(f.oracle.toRulerAt).map(Number)), f.turns.map((t) => t.turn).sort((a, b) => a - b), name + ': an oracle for every turn')
  }
})

for (const name of NAMES) {
  const f = load(name)
  const checkins = new Set(f.checkins ?? [])

  test(name + ': the asks sent to the ruler, turn by turn', () => {
    for (const t of f.turns) {
      // the loop asks who is owed before it journals that turn's ruling
      const l = foldPrefix(f, t.turn, t.turn - 1)
      const toRuler = stateOf(l, { turn: t.turn, checkin: checkins.has(t.turn) }).toRuler
      assert.deepEqual(sorted(toRuler), sorted(f.oracle.toRulerAt[t.turn]), name + ' turn ' + t.turn)
    }
  })

  test(name + ': every ruling the fixture journals answers an ask the fold sent', () => {
    for (const r of f.rulings) {
      const l = foldPrefix(f, r.turn, r.turn - 1)
      const toRuler = stateOf(l, { turn: r.turn, checkin: checkins.has(r.turn) }).toRuler
      for (const a of r.asks) assert.ok(toRuler.includes(a), name + ': ' + a + ' was sent at ' + r.turn)
    }
  })

  test(name + ': how each ask ends', () => {
    const l = full(f)
    assert.deepEqual(sorted(Object.keys(l.asks)), sorted(f.asks.map((a) => a.key)))
    for (const [key, want] of Object.entries(f.oracle.ends)) {
      const end = l.asks[key].end
      assert.ok(end, name + ': ' + key + ' ends')
      assert.equal(end.state, want.state, name + ': ' + key)
      assert.equal(end.label, want.label, name + ': ' + key)
      if (want.answer !== undefined) assert.equal(end.answer, want.answer, name + ': ' + key)
      assert.equal(typeof end.why, 'string')
      assert.ok(end.why.length > 0, name + ': ' + key + ' ends with a why')
    }
  })

  test(name + ': no done without a ruling that ruled it, at any prefix (U2)', () => {
    for (const t of f.turns) {
      for (const upTo of [t.turn - 1, t.turn]) {
        const l = foldPrefix(f, t.turn, upTo)
        for (const [key, a] of Object.entries(l.asks)) {
          if (a.end?.state !== 'done') continue
          assert.equal(a.end.label, 'ruled', name + ': ' + key + ' done at prefix ' + t.turn)
          const ruling = f.rulings.find((r) => r.turn <= upTo && r.units.some((u) => u.unit === key && u.ruling === a.end.answer))
          assert.ok(ruling, name + ': ' + key + ' done at prefix ' + t.turn + ' rests on a journaled ' + a.end.answer + ' ruling')
        }
      }
    }
  })

  test(name + ': coverage lines', () => {
    const lines = coverageLines(full(f), name)
    assert.deepEqual(sorted(lines.declared.map(norm)), sorted(f.oracle.declared.map(norm)), name + ' declared')
    assert.deepEqual(sorted(lines.unreached.map(norm)), sorted(f.oracle.unreached.map(norm)), name + ' unreached')
    for (const [key, want] of Object.entries(f.oracle.ends)) {
      const prefix = name + ':' + key + ': '
      if (want.state === 'done') assert.ok(!lines.incomplete.some((x) => x.startsWith(prefix)), name + ': ' + key + ' is not incomplete')
      else assert.ok(lines.incomplete.some((x) => x.startsWith(prefix + want.state + ', ')), name + ': ' + key + ' is ' + want.state)
    }
  })
}

test('v3-prose-absence: a declared absence ends nothing and holds the ask open until the ruler rules', () => {
  const f = load('v3-prose-absence')
  const one = foldPrefix(f, 1)
  assert.equal(one.asks.a.declared, 'absent')
  assert.equal(one.asks.a.end, null)
  const three = foldPrefix(f, 3)
  assert.equal(three.asks.a.end, null, 'an open ruling ends nothing')
  assert.ok(three.asks.a.ruling, 'the open ruling stands')
})

test('v3-prose-absence: a scope-owing ask shows its directories, each with the patterns that covered it', () => {
  const a = full(load('v3-prose-absence')).asks.a
  assert.equal(a.owes, true)
  assert.deepEqual(sorted(Object.keys(a.covered)), ['src/app', 'src/config', 'src/data', 'src/lib', 'src/ui', 'src/util'])
  for (const d of Object.values(a.covered)) assert.equal(d.files, 5)
  assert.ok(a.covered['src/ui'].by.includes('grep loadConfig('), 'a 0-hit grep still covers the files it searched')
  assert.ok(!a.covered['src/config'].by.includes('grep loadConfig('), 'a grep covers only its own paths')
  assert.ok(!a.agenda.some((x) => x.kind === 'file'), 'every owed file was covered')
})

test('rewording-loop: every new 0-hit query moves the stamp, so no turn stalls (U4)', () => {
  const f = load('rewording-loop')
  const l = full(f)
  const stamps = l.asks.a.history.map((h) => h.stamp)
  assert.equal(new Set(stamps).size, stamps.length)
  for (const t of f.turns) assert.equal(foldPrefix(f, t.turn, t.turn - 1).stalled, null, 'no stall at ' + t.turn)
})

test('idle-want: a want that joins later is not compared against turns before it joined', () => {
  const f = load('idle-want')
  const three = foldPrefix(f, 3)
  assert.equal(three.asks.w.due, false)
  assert.equal(three.stalled, null)
  const five = full(f)
  assert.ok(five.asks.w.end.why.includes('run grep legacyFlag'), 'no_progress names the standing open ruling')
})
