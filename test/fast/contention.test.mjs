// test/fast/contention.test.mjs — what the judge at the merge is asked about, and what its rulings decide.
//
// What is pinned here:
//
//   contentionOf        an overlap with another folder's leaf, a path another folder's leaf expects,
//                       never a leaf of the same folder, an ordered one, one of the unit's cycle, one
//                       merged where the two meet, one a standing serialize orders; a resolve covers its
//                       facts only at the heads it was given
//   mergedWhereTheyMeet the ancestor just below the lowest common ancestor, groups passed over
//   combineRulings      an unruled unit or cant_rule reaches the user, then replan, then an admissible
//                       serialize, else resolve; a wait only on a leaf dispatched first; a conflict
//                       never serializes
//   waitsOn             a standing serialize at the unit's head
//
// Design: docs/DESIGN.md#the-judge.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { combineRulings, contentionOf, mergedWhereTheyMeet, waitsOn } from '../../lib/contention.mjs'
import { conflictJudged, judgeThread } from '../../lib/boundaries/judge.mjs'
import { deriveStatus, liveNodes } from '../../lib/tree.mjs'

const leaf = (id, extra = {}) => ({ id, kind: 'leaf', title: 'do ' + id, rigor: 'tdd', expects: [], ...extra })
const folder = (id, extra = {}) => ({ id, kind: 'composite', title: 'folder ' + id, ...extra })

/** An effort in memory: nodes, then events, one seq each in that order. */
function effort(nodeList, eventList = []) {
  const nodes = liveNodes(nodeList.map((node, i) => ({ kind: 'node', node, seq: i + 1 })))
  const events = eventList.map((e, i) => ({ ...e, seq: nodeList.length + i + 1 }))
  return { nodes, events, status: deriveStatus(nodes, events) }
}

/** Git as contentionOf reads it: each leaf's net diff and head from a table. */
const reads = (nets, heads = {}) => ({ netOf: (id) => nets[id] || [], headOf: (id) => heads[id] || 'h-' + id })

const TWO_FOLDERS = [folder('.'), folder('x'), leaf('x/a'), folder('y'), leaf('y/b', { expects: ['src/shared.js', 'src/b.js'] }), leaf('y/c')]

test('a path the unit changed that another folder\'s leaf changed is an overlap; one it only expects is a folder fact', () => {
  const tree = effort(TWO_FOLDERS)
  const facts = contentionOf(tree, 'x/a', { head: 'A', net: ['src/shared.js', 'src/b.js', 'src/a.js'], ...reads({ 'y/b': ['src/shared.js'] }) })
  assert.deepEqual(facts, [
    { node: 'y/b', kind: 'overlap', paths: ['src/shared.js'] },
    { node: 'y/b', kind: 'folder', paths: ['src/b.js'] },
  ])
})

test('a leaf of the same folder is no fact: the merge into that folder already serializes the two', () => {
  const tree = effort([folder('.'), leaf('a'), leaf('b', { expects: ['src/x.js'] })])
  assert.deepEqual(contentionOf(tree, 'a', { head: 'A', net: ['src/x.js'], ...reads({ b: ['src/x.js'] }) }), [])
})

test('an ordered leaf, a leaf of the unit\'s cycle, and a leaf merged where the two meet are no facts', () => {
  const nodes = [
    folder('.'), folder('x'), leaf('x/r', { rigor: 'tdd-pair', role: 'red' }), leaf('x/g', { rigor: 'tdd-pair', role: 'green', deps: ['x/r'] }),
    folder('y'), leaf('y/after', { deps: ['x'] }), folder('z'), leaf('z/done'),
  ]
  const net = ['src/s.js']
  const all = { 'x/r': net, 'y/after': net, 'z/done': net }
  assert.deepEqual(contentionOf(effort(nodes), 'x/g', { head: 'G', net, ...reads(all) }).map((f) => f.node), ['z/done'])
  const merged = effort(nodes, [{ kind: 'merged', node: 'z/done' }, { kind: 'merged', node: 'z' }])
  assert.deepEqual(contentionOf(merged, 'x/g', { head: 'G', net, ...reads(all) }), [], 'z merged up to the root, where x meets it')
  const leafOnly = effort(nodes, [{ kind: 'merged', node: 'z/done' }])
  assert.deepEqual(contentionOf(leafOnly, 'x/g', { head: 'G', net, ...reads(all) }).map((f) => f.node), ['z/done'], 'merged into its folder is not yet where they meet')
})

test('a standing serialize orders the two either way', () => {
  const judged = { kind: 'judged', node: 'y/b', trigger: 'contention', head_sha: 'B', outcome: 'serialize', after: ['x/a'] }
  const tree = effort(TWO_FOLDERS, [judged])
  assert.deepEqual(contentionOf(tree, 'x/a', { head: 'A', net: ['src/shared.js'], ...reads({ 'y/b': ['src/shared.js'] }) }), [])
})

test('a resolve covers its facts only while both heads are the ones it was given', () => {
  const resolve = (heads) => ({
    kind: 'judged', node: 'x/a', trigger: 'contention', head_sha: 'A', heads, outcome: 'resolve',
    facts: [{ node: 'y/b', kind: 'overlap', paths: ['src/shared.js'] }],
  })
  const ask = (tree, head = 'A', theirs = 'B1') => contentionOf(tree, 'x/a', { head, net: ['src/shared.js'], ...reads({ 'y/b': ['src/shared.js'] }, { 'y/b': theirs }) })
  assert.deepEqual(ask(effort(TWO_FOLDERS, [resolve({ 'y/b': 'B1' })])), [])
  assert.equal(ask(effort(TWO_FOLDERS, [resolve({ 'y/b': 'B1' })]), 'A', 'B2').length, 1, 'the other leaf moved')
  assert.equal(ask(effort(TWO_FOLDERS, [resolve({ 'y/b': 'B1' })]), 'A2').length, 1, 'the unit moved')
})

test('two leaves meet where their branches join, groups passed over', () => {
  const tree = effort([folder('.'), folder('x'), { id: 'x/g', kind: 'group', title: 'g' }, leaf('x/g/a'), folder('y'), leaf('y/b')],
    [{ kind: 'merged', node: 'y/b' }])
  assert.equal(mergedWhereTheyMeet(tree, 'x/g/a', 'y/b'), false, 'y/b merged into y, which has not merged into the root')
  const up = effort([folder('.'), folder('x'), leaf('x/a'), folder('y'), leaf('y/b')], [{ kind: 'merged', node: 'y/b' }, { kind: 'merged', node: 'y' }])
  assert.equal(mergedWhereTheyMeet(up, 'x/a', 'y/b'), true)
})

// ---------------------------------------------------------------- combining rulings

const ruled = (pairs) => pairs.map(([unit, ruling]) => ({ unit, ruling, why: unit + ' ' + ruling }))
const first = (order) => (id) => order.indexOf(id)

test('an unruled unit or a cant_rule reaches the user, before any other ruling', () => {
  const units = ['p', 'q']
  assert.equal(combineRulings({ trigger: 'contention', id: 'u', units, rulings: ruled([['p', 'replan']]) }).outcome, 'cant_rule', 'q left unruled')
  assert.equal(combineRulings({ trigger: 'contention', id: 'u', units, rulings: ruled([['p', 'replan'], ['q', 'cant_rule']]) }).outcome, 'cant_rule')
})

test('a replan wins over serialize and resolve', () => {
  const out = combineRulings({ trigger: 'contention', id: 'u', units: ['p', 'q'], rulings: ruled([['p', 'serialize'], ['q', 'replan']]) })
  assert.deepEqual([out.outcome, out.after], ['replan', []])
})

test('a unit waits only on a leaf dispatched before it; a serialize against a later one reads as resolve', () => {
  const firstOf = first(['p', 'u', 'q'])
  const both = combineRulings({ trigger: 'contention', id: 'u', units: ['p', 'q'], rulings: ruled([['p', 'serialize'], ['q', 'serialize']]), firstOf })
  assert.deepEqual([both.outcome, both.after], ['serialize', ['p']])
  const later = combineRulings({ trigger: 'contention', id: 'u', units: ['q'], rulings: ruled([['q', 'serialize']]), firstOf })
  assert.deepEqual([later.outcome, later.after], ['resolve', []])
})

test('two units ruled to wait on each other never both wait', () => {
  const firstOf = first(['a', 'b'])
  const a = combineRulings({ trigger: 'contention', id: 'a', units: ['b'], rulings: ruled([['b', 'serialize']]), firstOf })
  const b = combineRulings({ trigger: 'contention', id: 'b', units: ['a'], rulings: ruled([['a', 'serialize']]), firstOf })
  assert.deepEqual([a.outcome, b.outcome], ['resolve', 'serialize'])
})

test('a conflict never serializes: what it conflicts with has already merged', () => {
  const out = combineRulings({ trigger: 'conflict', id: 'u', units: ['integration'], rulings: ruled([['integration', 'serialize']]), firstOf: () => -1 })
  assert.equal(out.outcome, 'resolve')
})

test('a standing serialize makes the unit wait at its head only', () => {
  const tree = effort([folder('.'), leaf('u'), leaf('p')], [{ kind: 'judged', node: 'u', trigger: 'contention', head_sha: 'H', outcome: 'serialize', after: ['p'] }])
  assert.deepEqual(waitsOn(tree, 'u', 'H'), ['p'])
  assert.deepEqual(waitsOn(tree, 'u', 'H2'), [])
})

test('a ruling from before its node was cleared orders and covers nothing: the retried or revised node is a new question', () => {
  const judged = { kind: 'judged', node: 'y/b', trigger: 'contention', head_sha: 'B', outcome: 'serialize', after: ['x/a'] }
  const cleared = { kind: 'replanned', node: 'y/b', reason: 'retry_escalated', by: 'session' }
  const ask = (tree) => contentionOf(tree, 'x/a', { head: 'A', net: ['src/shared.js'], ...reads({ 'y/b': ['src/shared.js'] }) })
  assert.deepEqual(ask(effort(TWO_FOLDERS, [judged])), [], 'the serialize stands')
  assert.equal(ask(effort(TWO_FOLDERS, [judged, cleared])).length, 1, 'the retry cleared it')
  assert.deepEqual(waitsOn(effort(TWO_FOLDERS, [judged]), 'y/b', 'B'), ['x/a'])
  assert.deepEqual(waitsOn(effort(TWO_FOLDERS, [judged, cleared]), 'y/b', 'B'), [], 'a cleared serialize holds nothing')
})

// ---------------------------------------------------------------- the ruler's replay identity

test('a judge question replays on the same observations of an uncleared node; changed facts or a clearing ask a fresh ruler', () => {
  const facts = [{ node: 'y/b', kind: 'overlap', paths: ['src/shared.js'] }]
  const ask = { trigger: 'contention', id: 'x/a', head: 'A'.repeat(40), facts, heads: { 'y/b': 'B1' }, paths: ['src/shared.js'] }
  const tree = effort(TWO_FOLDERS)
  const thread = judgeThread(tree, ask)
  assert.equal(judgeThread(effort(TWO_FOLDERS), ask), thread, 'the same question, the same thread')
  assert.notEqual(judgeThread(tree, { ...ask, heads: { 'y/b': 'B2' } }), thread, 'the other leaf moved')
  assert.notEqual(judgeThread(tree, { ...ask, facts: [...facts, { node: 'y/b', kind: 'folder', paths: ['src/b.js'] }] }), thread, 'another fact')
  const retried = effort(TWO_FOLDERS, [{ kind: 'replanned', node: 'x/a', reason: 'retry_escalated', by: 'session' }])
  assert.notEqual(judgeThread(retried, ask), thread, "the user's word on the unit re-asks it")
  assert.equal(judgeThread(effort(TWO_FOLDERS, [{ kind: 'replanned', node: 'y/b', reason: 'retry_escalated' }]), ask), thread, "another node's clearing is not this question's")
})

// ---------------------------------------------------------------- which conflicts the judge rules

test('a conflict goes to the judge only for a leaf whose executor can conclude a merge on paths it writes, and not again after a resolve that failed', () => {
  const tree = effort([
    folder('.'), leaf('a'), leaf('t', { rigor: 'tests-only' }),
    leaf('r', { rigor: 'tdd-pair', role: 'red' }), leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'] }),
  ])
  assert.equal(conflictJudged(tree, 'a', 'H1', ['src/x.js']), true)
  assert.equal(conflictJudged(tree, 't', 'H1', ['test/x.test.js']), false, 'a test-author has no shell to conclude a merge')
  assert.equal(conflictJudged(tree, 'g', 'H1', ['src/x.js']), true, 'a cycle merges through its tip, whose implementer writes its code')
  assert.equal(conflictJudged(tree, 'g', 'H1', ['src/x.js', 'test/x.test.js']), false, 'a test file is not for its implementer to resolve')
  assert.equal(conflictJudged(tree, 'r', 'H1', ['test/x.test.js']), false, 'the red is no tip and has no shell')
  const resolved = { ...tree, events: [{ kind: 'judged', node: 'a', trigger: 'conflict', outcome: 'resolve', head_sha: 'H1', paths: ['src/x.js'], seq: 9 }] }
  assert.equal(conflictJudged(resolved, 'a', 'H1', ['src/x.js']), true, 'the same head again is a replay, ruled once')
  assert.equal(conflictJudged(resolved, 'a', 'H2', ['src/x.js']), false, 'the same paths at the rebased head: the remedy failed')
  assert.equal(conflictJudged(resolved, 'a', 'H2', ['src/y.js']), true, 'a new conflict is a new question')
})
