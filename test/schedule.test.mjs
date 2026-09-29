import { test } from 'node:test'
import assert from 'node:assert/strict'

import { schedule, summarize } from '../lib/schedule.mjs'
import { deriveStatus, liveNodes } from '../lib/tree.mjs'
import { flat } from '../lib/store.mjs'

const leaf = (id, extra = {}) => ({ id, kind: 'leaf', title: 'do ' + id, rigor: 'tdd', locus: ['src/' + flat(id) + '.js'], ...extra })
const folder = (id, extra = {}) => ({ id, kind: 'composite', title: 'folder ' + id, ...extra })

/** An effort on disk, in memory: node records, then events, one seq each in that order. */
function effort(nodeList, eventList = [], extra = {}) {
  const nodes = liveNodes(nodeList.map((node, i) => ({ kind: 'node', node, seq: i + 1 })))
  const events = eventList.map((e, i) => ({ ...e, seq: nodeList.length + i + 1 }))
  return { nodes, events, status: deriveStatus(nodes, events), root: '.', maxParallel: 4, ...extra }
}

const launched = (input, unit) => schedule(input).launch.filter((l) => l.unit === unit)
const leafIds = (input) => launched(input, 'leaf').map((l) => l.id)

test('a leaf launches once every dependency has merged where it is cut', () => {
  const nodes = [folder('.'), leaf('a'), leaf('b', { deps: ['a'] })]
  assert.deepEqual(leafIds(effort(nodes)), ['a'])
  assert.deepEqual(leafIds(effort(nodes, [{ kind: 'dispatched', node: 'a' }, { kind: 'approved', node: 'a' }])), [])
  assert.deepEqual(leafIds(effort(nodes, [{ kind: 'merged', node: 'a' }])), ['b'])
})

test('a dependency in another folder is ready when its folder merged into the common ancestor', () => {
  const nodes = [folder('.'), folder('x'), leaf('x/a'), folder('y'), leaf('y/b', { deps: ['x/a'] })]
  assert.deepEqual(leafIds(effort(nodes, [{ kind: 'merged', node: 'x/a' }])), [])
  assert.deepEqual(leafIds(effort(nodes, [{ kind: 'merged', node: 'x/a' }, { kind: 'merged', node: 'x' }])), ['y/b'])
})

test('a cycle predecessor needs only approval', () => {
  const nodes = [folder('.'), leaf('r', { rigor: 'tdd-pair', role: 'red' }), leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'] })]
  assert.deepEqual(leafIds(effort(nodes, [{ kind: 'dispatched', node: 'r' }, { kind: 'approved', node: 'r' }])), ['g'])
})

test('a leaf behind an escalated dependency, directly or through another, does not launch and is counted behind it', () => {
  const nodes = [folder('.'), leaf('a'), leaf('b', { deps: ['a'] }), leaf('c', { deps: ['b'] })]
  const input = effort(nodes, [{ kind: 'escalated', node: 'a', reason: 'blocked' }])
  assert.deepEqual(leafIds(input), [])
  const s = summarize(input)
  assert.deepEqual(s.stopped, [{ id: 'a', status: 'escalated', reason: 'blocked' }])
  assert.equal(s.blocked_n, 2)
  assert.deepEqual(s.blocked, [{ blocked_by: 'a', leaves_n: 2 }])
})

test('a leaf whose files a stopped leaf holds does not launch and is counted behind the holder', () => {
  const input = effort([folder('.'), leaf('a'), leaf('b')], [], { lockedBy: (id) => (id === 'b' ? 'z' : '') })
  assert.deepEqual(leafIds(input), ['a'])
  assert.deepEqual(summarize(input).blocked, [{ blocked_by: 'z', leaves_n: 1 }])
})

test('leaves launch up to the pool less the leaves running, and none while stopping', () => {
  const nodes = [folder('.'), leaf('a'), leaf('b'), leaf('c')]
  assert.equal(leafIds(effort(nodes, [], { maxParallel: 2, running: ['leaf:a'] })).length, 1)
  assert.deepEqual(leafIds(effort(nodes, [], { stopping: true })), [])
})

test('nothing launches below a node that is running or being replanned', () => {
  const nodes = [folder('.'), folder('x'), leaf('x/a'), leaf('b')]
  assert.deepEqual(leafIds(effort(nodes, [], { planning: ['x'] })), ['b'])
  assert.deepEqual(leafIds(effort(nodes, [], { running: ['leaf:x'] })), ['b'])
  assert.deepEqual(leafIds(effort(nodes, [], { running: ['leaf:b'] })), ['x/a'])
})

test('coupled leaves run one at a time', () => {
  const nodes = [folder('.', { shared: ['src/a.js', 'src/b.js'] }), leaf('a'), leaf('b'), leaf('c')]
  assert.deepEqual(leafIds(effort(nodes)), ['a', 'c'])
  assert.deepEqual(leafIds(effort(nodes, [], { running: ['leaf:a'] })), ['c'])
})

test('a folder with nothing planned beneath it is planned, under the pool', () => {
  const nodes = [folder('.'), folder('x'), folder('y'), folder('z', { kind: 'design' })]
  assert.deepEqual(launched(effort(nodes), 'plan').map((l) => l.id), ['x', 'y', 'z'])
  assert.deepEqual(launched(effort(nodes, [], { maxParallel: 2, running: ['plan:x'] }), 'plan').map((l) => l.id), ['y'])
  assert.deepEqual(launched(effort(nodes, [{ kind: 'parked', node: 'y', return: 'needs_design' }], { running: ['plan:x'] }), 'plan').map((l) => l.id), ['z'])
})

test('a planner folder parked spec_changed is re-derived once per park', () => {
  const nodes = [folder('.'), folder('x', { author: 'planner' }), leaf('x/a')]
  const park = { kind: 'parked', node: 'x', return: 'spec_changed' }
  const first = launched(effort(nodes, [park]), 'plan')
  assert.deepEqual(first.map((l) => l.id), ['x'])
  assert.match(first[0].why, /^spec_changed/)
  const parkSeq = nodes.length + 1
  assert.deepEqual(launched(effort(nodes, [park], { state: [{ kind: 'dispatch', label: 'plan:x', seq: parkSeq + 1 }] }), 'plan'), [])
  assert.equal(launched(effort(nodes, [park], { state: [{ kind: 'dispatch', label: 'plan:x', seq: parkSeq - 1 }] }), 'plan').length, 1)
  assert.deepEqual(launched(effort([folder('.'), folder('x'), leaf('x/a')], [park]), 'plan'), [])
})

test('approved leaves merge into their parent at the head they were approved at, never while running', () => {
  const nodes = [folder('.'), leaf('a'), leaf('b')]
  const events = ['a', 'b'].flatMap((id) => [{ kind: 'dispatched', node: id }, { kind: 'approved', node: id }])
  const head = (id) => 'h-' + id
  assert.deepEqual(launched(effort(nodes, events, { approvedHead: head }), 'merge'),
    [{ unit: 'merge', target: '.', children: [{ id: 'a', head_sha: 'h-a' }, { id: 'b', head_sha: 'h-b' }], cycles: [] }])
  assert.deepEqual(launched(effort(nodes, events, { approvedHead: head, running: ['leaf:a'] }), 'merge')[0].children.map((c) => c.id), ['b'])
  assert.deepEqual(launched(effort(nodes, events, { running: ['merge:.'] }), 'merge'), [])
})

test('a cycle merges only whole', () => {
  const nodes = [folder('.'), leaf('r', { rigor: 'tdd-pair', role: 'red' }), leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'] })]
  const red = [{ kind: 'dispatched', node: 'r' }, { kind: 'approved', node: 'r' }]
  assert.deepEqual(launched(effort(nodes, red), 'merge'), [])
  const both = [...red, { kind: 'dispatched', node: 'g' }, { kind: 'approved', node: 'g' }]
  assert.deepEqual(launched(effort(nodes, both), 'merge')[0].cycles, [['r', 'g']])
})

test('an integrated folder is reviewed at its head, merges up once reviewed, and again after its park is answered', () => {
  const nodes = [folder('.'), folder('x'), leaf('x/a'), leaf('x/b')]
  const where = { branch: 'agentics/e--x', worktree: '/wt/x', head: 'h2', base: 'h0' }
  const merged = [{ kind: 'merged', node: 'x/a' }, { kind: 'merged', node: 'x/b' }]
  const extra = { integrationOf: (id) => (id === 'x' ? where : null) }
  const review = launched(effort(nodes, merged, extra), 'review')
  assert.deepEqual(review, [{ unit: 'review', id: 'x', earned: true, where, children: ['x/a', 'x/b'], unreviewed: ['x/a', 'x/b'] }])

  const done = [...merged, { kind: 'claims', node: 'x', head_sha: 'h2', review: 'done', claims: [] }]
  assert.deepEqual(launched(effort(nodes, done, extra), 'review'), [])
  assert.deepEqual(launched(effort(nodes, done, extra), 'merge')[0].children, [{ id: 'x', head_sha: 'h2' }])

  const moved = [...merged, { kind: 'claims', node: 'x', head_sha: 'h1', review: 'done', claims: [] }]
  assert.equal(launched(effort(nodes, moved, extra), 'review').length, 1)

  const answered = [...done, { kind: 'parked', node: 'x', return: 'integration_critical' }, { kind: 'replanned', node: 'x' }]
  assert.equal(launched(effort(nodes, answered, extra), 'review').length, 1)
  assert.deepEqual(launched(effort(nodes, answered, extra), 'merge'), [])
})

test('an integration review is not earned by one child with its own review loop', () => {
  const nodes = [folder('.'), folder('x'), leaf('x/a', { rigor: 'tdd-pair', role: 'none', provides: [{ name: 'c', paths: ['src'] }] })]
  const input = effort(nodes, [{ kind: 'merged', node: 'x/a' }], { integrationOf: () => ({ head: 'h' }) })
  assert.equal(launched(input, 'review')[0].earned, false)
})

test('idle only when nothing runs and nothing launches', () => {
  const nodes = [folder('.'), leaf('a')]
  assert.equal(schedule(effort(nodes)).idle, false)
  assert.equal(schedule(effort(nodes, [{ kind: 'escalated', node: 'a' }])).idle, true)
  assert.equal(schedule(effort(nodes, [{ kind: 'escalated', node: 'a' }], { running: ['review:.'] })).idle, false)
})

test('a cycle member approved behind a stopped member is held', () => {
  const nodes = [folder('.'), leaf('r', { rigor: 'tdd-pair', role: 'red' }), leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'] })]
  const s = summarize(effort(nodes, [{ kind: 'dispatched', node: 'r' }, { kind: 'approved', node: 'r' }, { kind: 'escalated', node: 'g' }]))
  assert.deepEqual(s.held, [{ id: 'r', behind: 'g' }])
  assert.equal(s.done, false)
})

test('done when every leaf in scope merged; below the effort root, only once the root merged too', () => {
  const nodes = [folder('.'), folder('x'), leaf('x/a')]
  assert.equal(summarize(effort(nodes, [{ kind: 'merged', node: 'x/a' }])).done, true)
  assert.equal(summarize(effort(nodes, [{ kind: 'merged', node: 'x/a' }], { root: 'x' })).done, false)
  assert.equal(summarize(effort(nodes, [{ kind: 'merged', node: 'x/a' }, { kind: 'merged', node: 'x' }], { root: 'x' })).done, true)
})
