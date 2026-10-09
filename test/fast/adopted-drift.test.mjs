// test/fast/adopted-drift.test.mjs — which adopted records still owe a drift ruling, and the drift
// each one's files cause, tagged with the record.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { adoptedDrift, adoptedUnruled } from '../../lib/boundaries/execution.mjs'
import { deriveStatus, liveNodes } from '../../lib/tree.mjs'

const NODES = [
  { id: '.', kind: 'composite', title: 'root' },
  { id: 'a', kind: 'leaf', title: 'a', rigor: 'tdd', locus: ['src/api.mjs'] },
  { id: 'p', kind: 'leaf', title: 'p', rigor: 'tdd', locus: ['src/api.mjs'], provides: [{ name: 'api', paths: ['src/api.mjs'] }] },
  { id: 'b', kind: 'leaf', title: 'b', rigor: 'tdd', locus: ['src/b.mjs'], consumes: [{ name: 'api', paths: ['src/api.mjs'] }] },
  { id: 'm', kind: 'leaf', title: 'm', rigor: 'tdd', locus: ['src/m.mjs'], consumes: [{ name: 'api', paths: ['src/api.mjs'] }] },
]
function treeOf(events = []) {
  const nodes = liveNodes(NODES.map((node, i) => ({ kind: 'node', node, seq: i + 1 })))
  const ev = events.map((e, i) => ({ execution: '', ...e, seq: e.seq ?? NODES.length + i + 1 }))
  return { nodes, events: ev, status: deriveStatus(nodes, ev) }
}

test('a merged record with by and every outside record owe a ruling, oldest first; agentics\' own merges do not', () => {
  const events = [
    { kind: 'outside', node: '.', commits: ['c2'], by: 'user', seq: 20 },
    { kind: 'merged', node: 'a', commits: ['c1'], by: 'terminal', seq: 10 },
    { kind: 'merged', node: 'p', head_sha: 'h', seq: 11 },
    { kind: 'merged', node: 'm', by: '', seq: 12 },
    { kind: 'noted', node: 'b', by: 'user', seq: 13 },
  ]
  assert.deepEqual(adoptedUnruled(events, []).map((e) => e.seq), [10, 20])
})

test('a drift-ruled line naming the record\'s seq covers it, from whichever execution wrote it', () => {
  const events = [{ kind: 'merged', node: 'a', commits: ['c1'], by: 'user', seq: 10 }, { kind: 'outside', node: '.', commits: ['c2'], by: 'user', seq: 11 }]
  const states = [{ kind: 'drift-ruled', node: 'b', contract: 'api', head_sha: '', adopted_seq: 10, ruling: 'unaffected', seq: 30 },
    { kind: 'drift-ruled', node: 'b', contract: 'api', head_sha: 'h', ruling: 'unaffected', seq: 31 }]
  assert.deepEqual(adoptedUnruled(events, states).map((e) => e.seq), [11], 'a merge-batch ruling covers no adopted record')
})

test("an adopted record's files drift the consumers not yet merged, each item carrying the record's seq", () => {
  const tree = treeOf([{ kind: 'merged', node: 'm', head_sha: 'h' }])
  const records = [{ kind: 'merged', node: 'a', commits: ['c1'], by: 'user', seq: 40 }, { kind: 'outside', node: '.', commits: ['c2'], by: 'user', seq: 41 }]
  const drift = adoptedDrift(tree, records, () => ['src/api.mjs'])
  assert.deepEqual(drift.map((d) => [d.node, d.contract, d.adopted_seq]), [['b', 'api', 40], ['b', 'api', 41]])
  assert.deepEqual(drift[0].files, ['src/api.mjs'])
})

test('a contract the adopted leaf provides is not drift, and a stopped consumer is reported stopped', () => {
  const provided = adoptedDrift(treeOf(), [{ kind: 'merged', node: 'p', commits: ['c1'], by: 'user', seq: 40 }], () => ['src/api.mjs'])
  assert.deepEqual(provided, [])
  const stopped = adoptedDrift(treeOf([{ kind: 'escalated', node: 'b', reason: 'x' }]), [{ kind: 'outside', node: '.', commits: ['c2'], by: 'user', seq: 41 }], () => ['src/api.mjs'])
  assert.equal(stopped.find((d) => d.node === 'b').stopped, 'escalated')
})

test('files nobody consumes drift nothing', () => {
  assert.deepEqual(adoptedDrift(treeOf(), [{ kind: 'outside', node: '.', commits: ['c2'], by: 'user', seq: 41 }], () => ['docs/x.md']), [])
})

test('a merged record with commits but no by is agentics\' own and owes nothing; with nothing recorded nothing is owed', () => {
  assert.deepEqual(adoptedUnruled([{ kind: 'merged', node: 'a', commits: ['c1'], head_sha: 'h', seq: 5 }], []), [])
  assert.deepEqual(adoptedUnruled([], []), [])
})

test('a record is covered only by its own seq: every record ruled leaves nothing owed, a ruling for another seq covers neither', () => {
  const events = [{ kind: 'merged', node: 'a', commits: ['c1'], by: 'user', seq: 10 }, { kind: 'outside', node: '.', commits: ['c2'], by: 'user', seq: 11 }]
  const ruled = (adopted_seq, seq) => ({ kind: 'drift-ruled', node: 'b', contract: 'api', head_sha: '', adopted_seq, ruling: 'unaffected', seq })
  assert.deepEqual(adoptedUnruled(events, [ruled(10, 30), ruled(11, 31)]), [])
  assert.deepEqual(adoptedUnruled(events, [ruled(99, 30)]).map((e) => e.seq), [10, 11])
  assert.deepEqual(adoptedUnruled(events, [{ kind: 'noted', node: 'b', adopted_seq: 10, seq: 32 }]).map((e) => e.seq), [10, 11], 'only a drift-ruled line covers')
})

test('no records drift nothing', () => {
  assert.deepEqual(adoptedDrift(treeOf(), [], () => ['src/api.mjs']), [])
})

test("each record's own files make its drift: filesOf is asked per record and the items are not pooled", () => {
  const records = [{ kind: 'merged', node: 'a', commits: ['c1'], by: 'user', seq: 40 }, { kind: 'outside', node: '.', commits: ['c2'], by: 'user', seq: 41 }]
  const filesOf = (record) => (record.seq === 41 ? ['src/api.mjs'] : ['docs/x.md'])
  assert.deepEqual(adoptedDrift(treeOf(), records, filesOf).map((d) => [d.node, d.contract, d.adopted_seq]), [['b', 'api', 41], ['m', 'api', 41]])
})

test('an item names only the files a consumer reads, and a file beside the contract path is not under it', () => {
  const one = [{ kind: 'outside', node: '.', commits: ['c2'], by: 'user', seq: 41 }]
  const drift = adoptedDrift(treeOf(), one, () => ['src/api.mjs', 'docs/x.md'])
  assert.ok(drift.length > 0)
  for (const d of drift) assert.deepEqual(d.files, ['src/api.mjs'])
  assert.deepEqual(adoptedDrift(treeOf(), one, () => ['src/api.mjs.bak']), [])
})

test('a consumer that is parked is reported parked, and one that is not stopped carries no stop', () => {
  const one = [{ kind: 'outside', node: '.', commits: ['c2'], by: 'user', seq: 41 }]
  const parked = adoptedDrift(treeOf([{ kind: 'parked', node: 'b', return: 'x', question: 'q' }]), one, () => ['src/api.mjs'])
  assert.equal(parked.find((d) => d.node === 'b').stopped, 'parked')
  assert.ok(!parked.find((d) => d.node === 'm').stopped, 'm is not stopped')
})
