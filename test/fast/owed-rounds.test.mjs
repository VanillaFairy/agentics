// test/fast/owed-rounds.test.mjs — lib/programs/execute.mjs `owedRounds`: the approved leaves a merge
/// sent a round that no run has opened, which a relaunch takes up instead of merging them again; and
// lib/tree.mjs `rebaseOwed`, the rebase a leaf still owes.
//
// Design: docs/DESIGN.md#merging.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mergeable, owedRounds } from '../../lib/programs/execute.mjs'
import { normalizeNode, rebaseOwed } from '../../lib/tree.mjs'

const leaf = (id, extra = {}) => normalizeNode({ id, kind: 'leaf', title: id, rigor: 'trivial', expects: ['src/' + id + '.mjs'], decisions: ['D1'], ...extra })
const tree = (nodes, events, approved) => ({
  nodes: new Map(nodes.map((n) => [n.id, n])),
  status: new Map(nodes.map((n) => [n.id, { status: approved.includes(n.id) ? 'approved' : 'merged' }])),
  events,
})
const message = (node, msg, round, seq) => ({ kind: 'message', node, thread: 'producer:' + node, msg, round, seq })
const dispatched = (node, round, seq, thread = 'producer:' + node) => ({ kind: 'dispatched', node, thread, round, seq, dispatch: thread + '#' + round })
const returned = (dispatch, status, seq) => ({ kind: 'returned', dispatch, status, seq })

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

test('a rebase is owed until a round opened for it returned, a round opened and never returned included', () => {
  const events = [dispatched('a', 1, 1), message('a', 'rebase', 2, 2)]
  assert.equal(rebaseOwed(events, 'a').seq, 2)
  events.push(dispatched('a', 2, 3), returned('producer:a#2', 'cut_off', 4))
  assert.equal(rebaseOwed(events, 'a').seq, 2, 'the round opened for it has not settled it')
  events.push(dispatched('a', 3, 5))
  assert.equal(rebaseOwed(events, 'a').seq, 2, 'nor has the next round, opened before any returned')
  events.push(dispatched('a', 3, 6, 'reviewer:a:1'), returned('reviewer:a:1#3', 'returned', 7))
  assert.equal(rebaseOwed(events, 'a').seq, 2, "another thread's return is no round of the rebase's")
  events.push(returned('producer:a#3', 'returned', 8))
  assert.equal(rebaseOwed(events, 'a'), null, 'every round after the one that returned is an ordinary round')
})

test('a rebase is owed until the leaf is approved or merged after it', () => {
  const events = [dispatched('a', 1, 1), message('a', 'rebase', 2, 2), { kind: 'approved', node: 'a', seq: 3 }]
  assert.equal(rebaseOwed(events, 'a'), null)
  events.push(message('a', 'rebase', 3, 4))
  assert.equal(rebaseOwed(events, 'a').seq, 4, 'a later conflict owes its own')
  events.push({ kind: 'merged', node: 'a', seq: 5 })
  assert.equal(rebaseOwed(events, 'a'), null)
  assert.equal(rebaseOwed(events, 'b'), null)
})
