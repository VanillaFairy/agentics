// test/fast/owed-rounds.test.mjs — lib/programs/execute.mjs `owedRounds`: the approved leaves a merge
// sent a round that no run has opened, which a relaunch takes up instead of merging them again.
//
// Design: docs/DESIGN.md#merging.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mergeable, owedRounds } from '../../lib/programs/execute.mjs'
import { normalizeNode } from '../../lib/tree.mjs'

const leaf = (id, extra = {}) => normalizeNode({ id, kind: 'leaf', title: id, rigor: 'trivial', expects: ['src/' + id + '.mjs'], decisions: ['D1'], ...extra })
const tree = (nodes, events, approved) => ({
  nodes: new Map(nodes.map((n) => [n.id, n])),
  status: new Map(nodes.map((n) => [n.id, { status: approved.includes(n.id) ? 'approved' : 'merged' }])),
  events,
})
const message = (node, msg, round, seq) => ({ kind: 'message', node, msg, round, seq })
const dispatched = (node, round, seq) => ({ kind: 'dispatched', node, round, seq })

test('an approved leaf a merge sent a rebase or its failures for a round not yet opened is owed it; one opened since is not', () => {
  const nodes = [leaf('a'), leaf('b'), leaf('c')]
  const events = [dispatched('a', 1, 1), message('a', 'rebase', 2, 2), dispatched('b', 1, 3), message('b', 'failures', 2, 4),
    dispatched('b', 2, 5), dispatched('c', 1, 6), message('c', 'findings', 2, 7)]
  assert.deepEqual(owedRounds(tree(nodes, events, ['a', 'b', 'c'])), ['a'])
  assert.deepEqual(owedRounds(tree(nodes, events, [])), [], 'a merged leaf owes nothing')
})

test("a cycle's red is never owed what a merge sent it alone; its tip is", () => {
  const nodes = [leaf('r', { rigor: 'tdd-pair', role: 'red' }), leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'] })]
  const events = [dispatched('r', 1, 1), message('r', 'failures', 2, 2), dispatched('g', 1, 3), message('g', 'rebase', 2, 4)]
  assert.deepEqual(owedRounds(tree(nodes, events, ['r', 'g'])), ['g'])
})

test('a cycle with one member owed a round or held stays out of the merge whole; the rest of the launch goes', () => {
  const item = { children: [{ id: 'r' }, { id: 'g' }, { id: 'a' }, { id: 'b' }], cycles: [['r', 'g']] }
  assert.deepEqual(mergeable(item, (id) => id === 'r'), { children: [{ id: 'a' }, { id: 'b' }], cycles: [] }, 'the red is owed: the green waits with it')
  assert.deepEqual(mergeable(item, (id) => id === 'b'), { children: [{ id: 'r' }, { id: 'g' }, { id: 'a' }], cycles: [['r', 'g']] })
})
