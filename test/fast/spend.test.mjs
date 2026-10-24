// test/fast/spend.test.mjs — pins the spend view's pure parts (lib/status.mjs): which design owns a
// thread, the units an effort's calls make, and the outliers flagged among them, computed by code so
// a session only judges them.
//
// Design: docs/DESIGN.md#self-checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { probersFor } from '../../lib/programs/probe.mjs'
import { OUTLIER_MULTIPLE as MULTIPLE, designPlace, flagSpend, lineRatio, spendUnits } from '../../lib/status.mjs'

const call = (thread, usd, { node = '', role = 'analyst', model = 'opus', round = 1, measured = true } = {}) =>
  ({ node, thread, role, model, round, tokens: 1, usd, measured })
const tree = (ids) => {
  const nodes = new Map(ids.map(([id, kind]) => [id, { id, kind }]))
  const status = new Map(ids.map(([id]) => [id, { status: 'merged' }]))
  return { nodes, status }
}
const reasonsOf = (flagged) => Object.fromEntries(flagged.map((f) => [f.kind + ' ' + f.id, f.reasons]))

test("a thread belongs to the design of the folder it names, a probe round's with its round and its own thread", () => {
  assert.deepEqual(designPlace('planner:a/b', 'a/b'), { probe: null, sub: '' })
  assert.deepEqual(designPlace('survey:a:write:1/scout:x', 'a'), { probe: null, sub: '' })
  assert.deepEqual(designPlace('probe:a/b:2/prober:1', 'a/b'), { probe: '2', sub: 'prober:1' })
  assert.deepEqual(designPlace('unit/probe:a:3/axes', 'a'), { probe: '3', sub: 'axes' })
  assert.equal(designPlace('probe:a/b:2/prober:1', 'a'), null, "a nested folder's round is not its parent's")
  assert.equal(designPlace('producer:a', 'a'), null)
})

test("an effort's calls make leaves, folder designs and probe rounds, a retried prober counted once", () => {
  const { nodes, status } = tree([['.', 'composite'], ['a', 'composite'], ['a/x', 'leaf']])
  const units = spendUnits([
    call('producer:a/x', 1, { node: 'a/x', role: 'implementer', model: 'sonnet' }),
    call('reviewer:a/x:2', 1, { node: 'a/x', role: 'reviewer', round: 3 }),
    call('planner:a', 2, { role: 'planner' }),
    call('probe:a:1/axes', 1), call('probe:a:1/prober:1', 1), call('probe:a:1/prober:1', 1), call('probe:a:1/prober:2', 1),
    call('probe:a:2/prober:1', 1),
  ], nodes, status)
  const [leaf] = units.leaf
  assert.deepEqual([leaf.id, leaf.dispatches, leaf.usd, leaf.rounds], ['a/x', 2, 2, 3])
  const [folder] = units.folder
  assert.deepEqual([folder.id, folder.dispatches, folder.usd, folder.rounds], ['a', 6, 7, 2])
  const rounds = Object.fromEntries(units.probe.map((p) => [p.id, [p.probers, p.axes, p.dispatches]]))
  assert.deepEqual(rounds, { 'a:1': [2, true, 4], 'a:2': [1, false, 1] })
  assert.equal(units.by_role.implementer.sonnet.dispatches, 1)
  assert.equal(units.by_role.analyst.opus.dispatches, 5)
})

const unit = (id, usd, extra = {}) => ({ id, dispatches: 1, tokens: 1, usd, unmeasured: 0, rounds: 1, ...extra })
const none = { leaf: [], folder: [], probe: [] }

test("a unit is flagged above the multiple of its kind's mean in this effort, and not at it", () => {
  const leaves = [unit('a', 1), unit('b', 1), unit('c', 1), unit('d', 1), unit('big', 1 + 4 * MULTIPLE)]
  const mean = leaves.reduce((s, u) => s + u.usd, 0) / leaves.length
  assert.ok(leaves[4].usd > MULTIPLE * mean && leaves[0].usd <= MULTIPLE * mean, 'the fixture: one leaf past the multiple')
  const { means, flagged } = flagSpend({ ...none, leaf: leaves })
  assert.equal(means.effort.leaf.usd, mean)
  assert.deepEqual(reasonsOf(flagged), { 'leaf big': ['usd_over_effort_mean'] })
})

test("rounds are measured as dollars are, and an earlier effort's mean flags what this effort's own does not", () => {
  const folders = [unit('f', 10, { rounds: 9 }), unit('g', 10, { rounds: 9 })]
  const earlier = { ...none, folder: [unit('old', 1, { rounds: 2 })] }
  const { means, flagged } = flagSpend({ ...none, folder: folders }, earlier)
  assert.equal(means.earlier.folder.usd, 1)
  assert.deepEqual(reasonsOf(flagged), {
    'folder f': ['usd_over_earlier_mean', 'rounds_over_earlier_mean'], 'folder g': ['usd_over_earlier_mean', 'rounds_over_earlier_mean'],
  })
})

test('a unit with an unmeasured call is never flagged on its dollars, nor counted in the mean', () => {
  const leaves = [unit('a', 1), unit('b', 1), unit('c', 1), unit('lost', 100, { unmeasured: 1 })]
  const { means, flagged } = flagSpend({ ...none, leaf: leaves })
  assert.equal(means.effort.leaf.units, 3)
  assert.deepEqual(flagged, [])
})

test('a probe round with more probers than its spec earns is flagged, and one that earned them is not', () => {
  const short = 300
  const long = 801
  assert.equal(probersFor(short), 1, 'the fixture: a short spec earns one prober')
  const probe = [
    unit('a:1', 1, { folder: 'a', round: '1', probers: 2, axes: true, spec_lines: short }),
    unit('b:1', 1, { folder: 'b', round: '1', probers: probersFor(long), axes: true, spec_lines: long }),
  ]
  assert.deepEqual(reasonsOf(flagSpend({ ...none, probe }).flagged), { 'probe a:1': ['probers_over_size'] })
})

test("a probe round past its folder's first that derived the axes again is flagged", () => {
  const probe = [
    unit('a:1', 1, { folder: 'a', round: '1', probers: 1, axes: true, spec_lines: 10 }),
    unit('a:2', 1, { folder: 'a', round: '2', probers: 1, axes: false, spec_lines: 10 }),
    unit('a:10', 1, { folder: 'a', round: '10', probers: 1, axes: true, spec_lines: 10 }),
  ]
  assert.deepEqual(reasonsOf(flagSpend({ ...none, probe }).flagged), { 'probe a:10': ['axes_again'] })
})

test("an effort's lines split into tests and source; docs, the store and binaries count as neither", () => {
  const numstat = ['30\t2\tlib/a.mjs', '70\t0\ttest/a.test.mjs', '9\t0\tREADME.md', '4\t0\t.agentics/e/DESIGN.md', '-\t-\tart.png'].join('\n')
  assert.deepEqual(lineRatio(numstat), { test_lines: 70, source_lines: 30, ratio: 2.33 })
  assert.equal(lineRatio('').ratio, null, 'no source line, no ratio')
})
