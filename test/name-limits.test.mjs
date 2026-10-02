import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  NAME_KEY_MAX, ROOT_ID, branchOf, briefPath, cardPath, closePath, fixesPath, gatePath, mergePath, nameKey,
  nodeIdProblem, nodeKey, progressPath, reportPath, respecPath, reviewPath, specCopyPath, stalePath, worktreeOf,
} from '../lib/store.mjs'
import { EFFORT, ROOT, overruns } from './harness/path-limits.mjs'

// The longest node id the id rule admits, nested as deep as its length allows.
const LONGEST_ID = Array.from({ length: 8 }, (_, i) => 'growth-axes-and-ports-' + i).join('/').padEnd(200, 'x')
const SHA = 'f'.repeat(40)
const DIGEST = 'f'.repeat(8)
const STAMP = '20261002-075950-12'

test('the longest node id is one the id rule admits', () => {
  assert.equal(LONGEST_ID.length, 200)
  assert.equal(nodeIdProblem(LONGEST_ID), null)
})

test('a name that fits is its own key; a longer one is bounded and keeps a readable head', () => {
  assert.equal(nameKey('wire.switch-over'), 'wire.switch-over')
  assert.equal(nameKey('x'.repeat(NAME_KEY_MAX)), 'x'.repeat(NAME_KEY_MAX))
  const long = 'probe-ambiguity-invariants-yagni-reinvention-growth-axes'
  assert.equal(nameKey(long).length, NAME_KEY_MAX)
  assert.ok(nameKey(long).startsWith(long.slice(0, 20)))
})

test('two long names sharing their head never share a key', () => {
  const head = 'a'.repeat(NAME_KEY_MAX)
  assert.notEqual(nameKey(head + '-one'), nameKey(head + '-two'))
})

test('a bounded key never equals the key of a name that fit', () => {
  // A node key or a label carries no `_`; a bounded key always does.
  assert.ok(nodeKey(LONGEST_ID).includes('_'))
  assert.ok(!nodeKey('a/b').includes('_'))
})

test('every name minted from the longest node id fits on Windows under a long checkout', () => {
  const byAgents = {
    report: reportPath(ROOT, EFFORT, STAMP, LONGEST_ID, 'test-author', 99),
    progress: progressPath(ROOT, EFFORT, STAMP, LONGEST_ID, 'test-author', 99),
    respec_rulings: respecPath(ROOT, EFFORT, LONGEST_ID, DIGEST + '-' + DIGEST, 'rulings.json'),
  }
  const byLib = {
    worktree: worktreeOf(ROOT, EFFORT, LONGEST_ID),
    spec_copy: specCopyPath(ROOT, EFFORT, LONGEST_ID, DIGEST),
    brief: briefPath(ROOT, EFFORT, STAMP, LONGEST_ID, 'test-author', 99),
    close: closePath(ROOT, EFFORT, STAMP, LONGEST_ID, 'test-author', 99),
    merge_drift: mergePath(ROOT, EFFORT, STAMP, LONGEST_ID, SHA).replace(/\.json$/, '.drift.md'),
    gate: gatePath(ROOT, EFFORT, STAMP, LONGEST_ID, SHA),
    stale: stalePath(ROOT, EFFORT, STAMP, SHA),
    card: cardPath(ROOT, EFFORT, STAMP, 'review', LONGEST_ID, DIGEST),
    review: reviewPath(ROOT, EFFORT, STAMP, LONGEST_ID, 99),
    fixes: fixesPath(ROOT, EFFORT, STAMP, LONGEST_ID, 99),
  }
  for (const [what, path] of Object.entries(byAgents)) assert.deepEqual(overruns(path), [], what)
  for (const [what, path] of Object.entries(byLib)) assert.deepEqual(overruns(path, ''), [], what)
  assert.deepEqual(overruns(ROOT + '/.git/refs/heads/' + branchOf(EFFORT, LONGEST_ID), '.lock'), [])
})

test('the root keeps its plain names', () => {
  assert.equal(branchOf(EFFORT, ROOT_ID), 'agentics/' + EFFORT)
  assert.ok(reviewPath(ROOT, EFFORT, STAMP, ROOT_ID, 1).endsWith('/reviews/root-r1.json'))
})
