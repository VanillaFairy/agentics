// test/evidence-rounds.test.mjs — what one round of a resumed evidence agent established, read from
// the return file it wrote, and whether its search goes on.
//
// Design: docs/DESIGN.md#continued-searches.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roundOf } from '../lib/evidence.mjs'

const hit = (path, line, kind = 'ground') => ({ path, line, note: 'n', kind })
const report = (over = {}) => ({ hits: [hit('src/a.js', 1)], searched: ['src/'], no_match: '', not_reached: '', stop_reason: 'exhausted', ...over })

test('an unfinished round goes on over what its file names as unreached', () => {
  const out = roundOf(report({ stop_reason: 'unfinished', not_reached: 'lines 356-768 never read' }))
  assert.equal(out.next, 'continue')
  assert.equal(out.named, true)
})

test('an exhausted round ends the search as done', () => {
  assert.equal(roundOf(report()).next, 'done')
})

test('a first round that stops unfinished without naming what it missed goes on over the unread remainder', () => {
  const out = roundOf(report({ stop_reason: 'unfinished' }))
  assert.equal(out.next, 'continue')
  assert.equal(out.named, false)
})

test('a round with no stop reason at all is never done', () => {
  const { stop_reason, ...silent } = report()
  assert.equal(roundOf(silent).next, 'continue')
})

test('a later round that names nothing and finds nothing new ends the search as making no progress', () => {
  const first = report({ stop_reason: 'unfinished' })
  const out = roundOf(report({ stop_reason: 'unfinished' }), [first])
  assert.deepEqual([out.next, out.why], ['stop', 'no_progress'])
})

test('a later round that names nothing but finds new locations goes on', () => {
  const first = report({ stop_reason: 'unfinished' })
  const out = roundOf(report({ stop_reason: 'unfinished', hits: [hit('src/b.js', 9)] }), [first])
  assert.equal(out.next, 'continue')
  assert.equal(out.gained_n, 1)
})

test('a round that rewords the same remainder and finds nothing new makes no progress', () => {
  const first = report({ stop_reason: 'unfinished', not_reached: 'SRC/legacy/ never opened' })
  const out = roundOf(report({ stop_reason: 'unfinished', not_reached: 'src/legacy/   never opened' }), [first])
  assert.deepEqual([out.next, out.why], ['stop', 'no_progress'])
})

test('a round that narrows the remainder goes on even with nothing new found', () => {
  const first = report({ stop_reason: 'unfinished', not_reached: 'src/legacy/ and src/vendor/' })
  assert.equal(roundOf(report({ stop_reason: 'unfinished', not_reached: 'src/vendor/' }), [first]).next, 'continue')
})

test('a round that restates the remainder in other words, no shorter, and finds nothing new makes no progress', () => {
  const first = report({ stop_reason: 'unfinished', not_reached: 'src/vendor/ never opened' })
  const out = roundOf(report({ stop_reason: 'unfinished', not_reached: 'never opened: src/vendor/ tree' }), [first])
  assert.deepEqual([out.next, out.why], ['stop', 'no_progress'])
})

test('a gainless remainder must be shorter than every earlier one, so alternating wordings end the search', () => {
  const rounds = ['src/vendor/ never opened', 'src/vendor/ and docs/ never opened in full', 'src/vendor/ was never opened']
    .map((not_reached) => report({ stop_reason: 'unfinished', not_reached }))
  const out = roundOf(rounds[2], rounds.slice(0, 2))
  assert.deepEqual([out.next, out.why], ['stop', 'no_progress'])
})

test('a later round that drops its remainder without finding anything new makes no progress', () => {
  const first = report({ stop_reason: 'unfinished', not_reached: 'src/vendor/' })
  const out = roundOf(report({ stop_reason: 'unfinished' }), [first])
  assert.deepEqual([out.next, out.why], ['stop', 'no_progress'])
})

test('a stuck round that names nothing is a dead end; one that names a remainder goes on', () => {
  const dead = roundOf(report({ stop_reason: 'stuck' }))
  assert.deepEqual([dead.next, dead.why], ['stop', 'dead_end'])
  assert.equal(roundOf(report({ stop_reason: 'stuck', not_reached: 'docs/adr/' })).next, 'continue')
})

test('an artefact the prober could not read ends its attack whatever it names', () => {
  const out = roundOf({ findings: [], stop_reason: 'artefact_unreadable', not_reached: 'all of it' })
  assert.deepEqual([out.next, out.why], ['stop', 'dead_end'])
})

test('a round whose file is missing or not JSON is unreadable, and ends the search', () => {
  const out = roundOf(null, [report({ stop_reason: 'unfinished', not_reached: 'x' })])
  assert.deepEqual([out.read, out.next, out.why], [false, 'stop', 'unreadable'])
})

test('locations are counted once across rounds, and by kind', () => {
  const first = report({ stop_reason: 'unfinished', not_reached: 'x', hits: [hit('CLAUDE.md', 9, 'guidance'), hit('src/a.js', 1)] })
  const out = roundOf(report({ hits: [hit('src/a.js', 1), hit('src\\b.js', 2)] }), [first])
  assert.equal(out.gained_n, 1)
  assert.equal(out.entries_n, 3)
  assert.deepEqual(out.kinds, { guidance: 1, ground: 2 })
})

test('a researcher\'s candidates are its progress, by name', () => {
  const first = { candidates: [{ name: 'Ajv' }], stop_reason: 'unfinished', not_reached: 'crates.io' }
  const out = roundOf({ candidates: [{ name: 'ajv' }, { name: 'zod' }], stop_reason: 'unfinished', not_reached: 'crates.io' }, [first])
  assert.deepEqual([out.gained_n, out.entries_n, out.next], [1, 2, 'continue'])
})

test('a round says whether it names something it looked for and did not find', () => {
  assert.equal(roundOf(report({ no_match: 'no maintained crate' })).absent, true)
  assert.equal(roundOf(report()).absent, false)
})
