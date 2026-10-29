// test/fast/git-hung.test.mjs — lib/boundaries/records.mjs `hungRecords`: a git killed at its ceiling
// is the environment's stop, held for the run and relaunched past; the same hang on the same node
// at the same head, with nothing cleared since, is no progress and goes to the user.
//
// Design: docs/DESIGN.md#faults.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { hungRecords } from '../../lib/boundaries/records.mjs'
import { normalizeNode } from '../../lib/tree.mjs'

const nodes = new Map([['a', { ...normalizeNode({ id: 'a', kind: 'leaf', title: 'a', rigor: 'trivial', expects: ['src/a.mjs'], decisions: ['D1'] }), seq: 1 }]])
const at = (state, events = []) => hungRecords('a', { label: 'git merge', head: 'h1' }, { nodes, events, state })
const asFault = (r, seq) => ({ kind: r.kind, ...r.fields, seq })

test('a first hang is a git_hung stop held for the run, never a fault of the plugin\'s', () => {
  const [first] = at([])
  assert.deepEqual([first.kind, first.fields.node, first.fields.channel], ['fault', 'a', 'git_hung'])
})

test('the same hang at the same head escalates; another head, another git or a clearing since is a stop again', () => {
  const before = [asFault(at([])[0], 10)]
  assert.deepEqual(at(before).map((r) => [r.kind, r.fields.reason]), [['escalated', 'git_hung']])
  const moved = hungRecords('a', { label: 'git merge', head: 'h2' }, { nodes, events: [], state: before })
  assert.equal(moved[0].kind, 'fault', 'at a moved head the relaunch made progress')
  const other = hungRecords('a', { label: 'git log', head: 'h1' }, { nodes, events: [], state: before })
  assert.equal(other[0].kind, 'fault', 'another git is another hang')
  assert.equal(at(before, [{ kind: 'replanned', node: 'a', seq: 11 }])[0].kind, 'fault', "the user's retry asks again")
})
