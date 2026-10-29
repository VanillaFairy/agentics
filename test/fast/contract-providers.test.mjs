// test/fast/contract-providers.test.mjs — pins compile's rule for a contract's providers: a node may
// deliver the contract an ancestor promises, at its paths or under them; any other second provider is
// refused; and a consumer builds against the promise.
//
// Design: docs/DESIGN.md#nodes.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeNode, promiserOf, treeProblems } from '../../lib/tree.mjs'

const api = (...paths) => [{ name: 'api', paths }]
const composite = (id, extra = {}) => ({ id, kind: 'composite', title: id, decisions: [], ...extra })
const leaf = (id, extra = {}) => ({
  id, kind: 'leaf', title: id, rigor: 'trivial', acceptance: [{ text: 'it works', check: 'npm test', decisions: [] }], ...extra,
})
const treeOf = (...nodes) => new Map([composite('.'), ...nodes].map((n) => [n.id, normalizeNode(n)]))
const contractProblemsOf = (nodes) => treeProblems(nodes).filter((p) => /contract api/.test(p.problem))

test('a task delivering the contract its sub-effort promises, at the same paths or under them, is no clash', () => {
  const same = treeOf(composite('roamers', { provides: api('src/core/critters') }), leaf('roamers/g/feature', { provides: api('src/core/critters') }))
  assert.deepEqual(contractProblemsOf(same), [])
  const narrower = treeOf(composite('roamers', { provides: api('src/core/critters') }), leaf('roamers/feature', { provides: api('src/core/critters/kinds.ts') }))
  assert.deepEqual(contractProblemsOf(narrower), [])
})

test('a second provider outside the promiser, a sibling deliverer or a path past the promise is refused', () => {
  const unrelated = treeOf(composite('roamers', { provides: api('src/a') }), leaf('other', { provides: api('src/a') }))
  assert.equal(contractProblemsOf(unrelated).length, 1)
  const siblings = treeOf(composite('roamers', { provides: api('src/a') }), leaf('roamers/x', { provides: api('src/a') }), leaf('roamers/y', { provides: api('src/a') }))
  assert.equal(contractProblemsOf(siblings).length, 1)
  const wider = treeOf(composite('roamers', { provides: api('src/a') }), leaf('roamers/x', { provides: api('src/a', 'src/b') }))
  assert.deepEqual(contractProblemsOf(wider).map((p) => p.node), ['roamers/x'])
})

test("a consumer builds against the promise, not the task delivering it below", () => {
  const nodes = [...treeOf(leaf('roamers/x', { provides: api('src/a/kinds.ts') }), composite('roamers', { provides: api('src/a') })).values()]
  assert.deepEqual(promiserOf(nodes, 'api').contract.paths, ['src/a'])
  assert.equal(promiserOf(nodes, 'api').id, 'roamers')
  assert.equal(promiserOf(nodes, 'none'), null)
})
