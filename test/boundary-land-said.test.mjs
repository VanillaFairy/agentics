// test/boundary-land-said.test.mjs — land's parked list carries what the stop's stored return said.
// Design: docs/DESIGN.md#node-record-and-events.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { land } from '../lib/boundary.mjs'
import { append } from '../lib/ledger.mjs'
import { executionDir, returnPath, writeJson } from '../lib/store.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { leaf, repo, root, STAMP } from './harness/boundary-fixture.mjs'

test('land check gives each parked node the question its dispatch\'s stored return holds', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('x', { rigor: 'trivial', locus: ['src/x.mjs'] })])
  const dispatch = 'x.implementer.producer-x.r1'
  const text = 'Keep the cache on disk or in memory?'
  writeJson(returnPath(executionDir(r, 'e1', STAMP), dispatch), { status: 'blocked', text })
  assert.equal(append(r, 'e1', 'events', { kind: 'parked', node: 'x', execution: STAMP, return: 'needs_decision', question: 'needs a decision', said: dispatch }).ok, true)
  const mine = land(r, 'e1', 'check').parked.find((p) => p.node === 'x')
  assert.equal(mine.question, 'needs a decision\n' + text)
})
