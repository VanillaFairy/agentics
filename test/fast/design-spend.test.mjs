// test/fast/design-spend.test.mjs — pins `designSpend` (lib/programs/execute/folder.mjs): a folder's
// design spend is its own planner's, surveys' and probe rounds' dispatches, never a nested folder's.
//
// Design: docs/DESIGN.md#autonomous-review.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { designSpend } from '../../lib/programs/execute/folder.mjs'

const call = (dispatch, thread, usd) => [{ kind: 'dispatched', dispatch, thread }, { kind: 'returned', dispatch, cost_usd: usd }]

test("a folder's design spend sums its planner, survey and probe dispatches, nested scopes included, and no other folder's", () => {
  const entries = [
    ...call('d1', 'planner:a', 1), ...call('d2', 'survey:a:write:1:0/scout:x', 2), ...call('d3', 'unit/probe:a:3/prober:1', 4),
    ...call('d4', 'planner:a/b', 8), ...call('d5', 'probe:a/b:1/prober:1', 16), ...call('d6', 'leaf:a', 32),
  ]
  assert.equal(designSpend(entries, 'a'), 1 + 2 + 4)
  assert.equal(designSpend(entries, 'a/b'), 8 + 16)
})

test('a dispatch with no cost figure adds nothing', () => {
  assert.equal(designSpend([{ kind: 'dispatched', dispatch: 'd', thread: 'planner:a' }, { kind: 'returned', dispatch: 'd', cost_usd: null }], 'a'), 0)
})
