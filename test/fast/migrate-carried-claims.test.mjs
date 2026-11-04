// test/fast/migrate-carried-claims.test.mjs — pins the one-shot replay of a folder's recorded claims:
// a pass a narrowed review ruled clean gets back the ruling the old rule turned to cant_tell.
//
// Design: docs/DESIGN.md#migrations.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { effortRewrite } from '../../tools/migrate-carried-claims.mjs'

/** A state dir holding one stored return per `[execution, said, value]`. */
function stateWith(t, returns) {
  const state = mkdtempSync(join(tmpdir(), 'mcc-'))
  t.after(() => rmSync(state, { recursive: true, force: true }))
  for (const [execution, said, value] of returns) {
    mkdirSync(join(state, 'executions', execution, 'returns'), { recursive: true })
    writeFileSync(join(state, 'executions', execution, 'returns', said + '.json'), JSON.stringify(value))
  }
  return state
}

const ev = (seq, execution, head, claims) => ({ kind: 'claims', node: '.', execution, head_sha: head, review: 'done', claims, open: [], said: 'r' + seq, anchors: {}, seq })
const ret = (units, claims) => ({ units: units.map(([unit, ruling]) => ({ unit, ruling, why: '' })), findings: [], fix_rulings: [], claims, notes: '' })
const rulings = (e) => e.claims.map((c) => [c.claim, c.ruling])

test('a pass the next executions ruled clean is met again; one ruled findings and not restated stays cant_tell', (t) => {
  const first = ev(1, 'x1', 'h0', [{ claim: 'a', ruling: 'met' }, { claim: 'b', ruling: 'met' }, { claim: 'c', ruling: 'under' }])
  const second = ev(2, 'x2', 'h1', [{ claim: 'a', ruling: 'cant_tell' }, { claim: 'b', ruling: 'cant_tell' }, { claim: 'c now', ruling: 'met' }])
  const third = ev(3, 'x3', 'h2', [{ claim: 'a', ruling: 'cant_tell' }, { claim: 'b', ruling: 'cant_tell' }, { claim: 'c now', ruling: 'cant_tell' }])
  const state = stateWith(t, [
    ['x1', 'r1', ret([], [{ claim: 'a' }, { claim: 'b' }, { claim: 'c' }])],
    ['x2', 'r2', ret([['claim:1', 'clean'], ['claim:2', 'findings'], ['claim:3', 'clean']], [{ claim: 'c now', unit: 'claim:3' }])],
    ['x3', 'r3', ret([['claim:1', 'clean'], ['claim:2', 'clean'], ['claim:3', 'clean']], [])],
  ])
  const text = [first, second, third].map((e) => JSON.stringify(e)).join('\n') + '\n'
  const out = effortRewrite(state, text)
  const lines = out.text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.deepEqual(rulings(lines[1]), [['a', 'met'], ['b', 'cant_tell'], ['c now', 'met']])
  assert.deepEqual(rulings(lines[2]), [['a', 'met'], ['b', 'cant_tell'], ['c now', 'met']], 'b was ruled findings once, so no later clean brings it back')
  assert.deepEqual(lines.map((e) => e.seq), [1, 2, 3])
  assert.deepEqual(out.left, [])
  assert.equal(effortRewrite(state, out.text).changed.length, 0, 'a second run changes nothing')
})

test('a folder whose stored return is missing is left untouched', (t) => {
  const state = stateWith(t, [['x1', 'r1', ret([], [{ claim: 'a' }])]])
  const text = [ev(1, 'x1', 'h0', [{ claim: 'a', ruling: 'met' }]), ev(2, 'x2', 'h1', [{ claim: 'a', ruling: 'cant_tell' }])].map((e) => JSON.stringify(e)).join('\n')
  const out = effortRewrite(state, text)
  assert.equal(out.text, text)
  assert.deepEqual(out.left.map((l) => l.node), ['.'])
})
