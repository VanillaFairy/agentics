// test/fast/locus-held.test.mjs — what other leaves hold against a leaf (`heldAgainst`), the one
// answer leaf-open's permissions, leaf-close's revert and a cycle's test round all read.
//
// What is pinned here:
//
//   heldAgainst     a leaf ordered before or after this one, at any distance, holds nothing
//                   against it, and neither does a coupled partner; a leaf no dependency orders
//                   holds its locus until it merged
//
// Design: docs/DESIGN.md#the-locus, docs/DESIGN.md#atomicity-when-to-stop-splitting.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkAtomicity, heldAgainst } from '../../lib/atomicity.mjs'
import { admits } from '../../lib/locus.mjs'
import { cycleTestLocus, deriveStatus, liveNodes, testLocusAdmits } from '../../lib/tree.mjs'

const leaf = (id, extra = {}) => ({
  id, kind: 'leaf', title: 'do ' + id, rigor: 'tdd', locus: ['src/' + id + '.js'],
  decisions: ['D1'], acceptance: [{ text: id + ' works', check: 'node --test', decisions: ['D1'] }], ...extra,
})
const root = (extra = {}) => ({ id: '.', kind: 'composite', title: 'the change', defines: [{ id: 'D1', text: 'do it' }], ...extra })
const tree = (...nodes) => liveNodes(nodes.map((node, i) => ({ kind: 'node', node, seq: i + 1 })))
const statusOf = (nodes, events = []) => deriveStatus(nodes, events)
const ownLocusKept = (nodes, id, status = statusOf(nodes)) => {
  const held = heldAgainst(nodes, status, id)
  return nodes.get(id).locus.filter((path) => !admits({ locus: nodes.get(id).locus, path, held }))
}

test('a file leaves ordered after this one also list stays this leaf\'s own', () => {
  const nodes = tree(root(),
    leaf('fixes', { locus: ['src/items.ts', 'src/Hands.ts', 'src/bodies.ts', 'src/bodies.test.ts'] }),
    leaf('tests', { rigor: 'tests-only', locus: ['tests/session.test.ts', 'src/bodies.test.ts'], deps: ['fixes'] }),
    leaf('retire', { rigor: 'trivial', locus: ['src/old.ts', 'src/items.ts', 'src/Hands.ts'], deps: ['fixes', 'tests'] }))
  for (const id of ['fixes', 'tests', 'retire']) {
    assert.deepEqual(checkAtomicity(nodes, id).filter((f) => f.condition === 3), [], 'the tree is atomic: ' + id)
    assert.deepEqual(ownLocusKept(nodes, id), [], id + ' keeps its whole locus')
  }
})

test('an ordering reached through a chain or a group frees the shared file too', () => {
  const chain = tree(root(), leaf('a', { locus: ['src/x.js'] }), leaf('b', { deps: ['a'] }), leaf('c', { locus: ['src/x.js'], deps: ['b'] }))
  assert.deepEqual(ownLocusKept(chain, 'a'), [])
  assert.deepEqual(ownLocusKept(chain, 'c'), [])
  const group = (id, extra = {}) => ({ id, kind: 'group', title: 'gather ' + id, ...extra })
  const byGroup = tree(root(), group('g'), leaf('g/a', { locus: ['src/x.js'] }), leaf('b', { locus: ['src/x.js'], deps: ['g'] }))
  assert.deepEqual(ownLocusKept(byGroup, 'g/a'), [])
  assert.deepEqual(ownLocusKept(byGroup, 'b'), [])
})

test('a coupled partner holds nothing against the leaf it shares the lane with', () => {
  const nodes = tree(root({ shared: ['package.json'] }),
    leaf('e', { locus: ['package.json', 'src/e.js'] }), leaf('f', { locus: ['package.json', 'src/f.js'] }))
  assert.deepEqual(ownLocusKept(nodes, 'e'), [])
  assert.ok(!heldAgainst(nodes, statusOf(nodes), 'e').includes('package.json'))
})

test('a leaf no dependency orders holds its locus against this one until it merged', () => {
  const nodes = tree(root(), leaf('a', { locus: ['src/a.js'] }), leaf('b', { locus: ['src/a.test.js'] }))
  const before = heldAgainst(nodes, statusOf(nodes), 'a')
  assert.ok(before.includes('src/a.test.js'))
  assert.equal(admits({ locus: ['src/a.js'], path: 'src/a.test.js', held: before }), false, 'a new test beside a listed file another leaf lists is not admitted')
  const after = heldAgainst(nodes, statusOf(nodes, [{ kind: 'merged', node: 'b', seq: 10 }]), 'a')
  assert.ok(!after.includes('src/a.test.js'))
  assert.equal(admits({ locus: ['src/a.js'], path: 'src/a.test.js', held: after }), true)
})

test('a cycle\'s test round may add a test a leaf ordered after the cycle lists, never one an unordered leaf lists', () => {
  const nodes = tree(root(),
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', locus: ['src/r.mjs'], deps: ['r'] }),
    leaf('later', { rigor: 'tests-only', locus: ['src/later.test.mjs'], deps: ['g'] }),
    leaf('beside', { rigor: 'tests-only', locus: ['src/beside.test.mjs'] }))
  const scope = cycleTestLocus(nodes, statusOf(nodes), nodes.get('g'))
  const isNew = () => true
  assert.equal(testLocusAdmits(scope, 'src/later.test.mjs', isNew), true)
  assert.equal(testLocusAdmits(scope, 'src/beside.test.mjs', isNew), false)
})
