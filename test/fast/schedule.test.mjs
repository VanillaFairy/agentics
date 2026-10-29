import { test } from 'node:test'
import assert from 'node:assert/strict'

import { outsideWorkOf, reviewOf, schedule, summarize } from '../../lib/schedule.mjs'
import { deriveStatus, liveNodes } from '../../lib/tree.mjs'
import { flat } from '../../lib/store.mjs'
import { stale } from '../../lib/approval.mjs'

const leaf = (id, extra = {}) => ({ id, kind: 'leaf', title: 'do ' + id, rigor: 'tdd', expects: ['src/' + flat(id) + '.js'], ...extra })
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

test('a leaf that expects a file a running or approved unmerged leaf expects waits, and launches once that one merged', () => {
  const nodes = [folder('.'), leaf('a', { expects: ['src/x.js'] }), leaf('b', { expects: ['src/x.js', 'src/b.js'] }), leaf('c')]
  assert.deepEqual(leafIds(effort(nodes, [], { running: ['leaf:a'] })), ['c'])
  const approved = [{ kind: 'dispatched', node: 'a' }, { kind: 'approved', node: 'a' }]
  assert.deepEqual(leafIds(effort(nodes, approved, { running: ['leaf:c'] })), [])
  assert.deepEqual(leafIds(effort(nodes, [...approved, { kind: 'merged', node: 'a' }])), ['b', 'c'])
})

test('of two ready leaves that expect one file, one launches per pass', () => {
  const nodes = [folder('.'), leaf('a', { expects: ['src/'] }), leaf('b', { expects: ['src/x.js'] }), leaf('c', { expects: ['lib/c.js'] })]
  assert.deepEqual(leafIds(effort(nodes)), ['a', 'c'])
})

test('a dependency orders two leaves that expect one file, so neither defers the other', () => {
  const nodes = [folder('.'), leaf('r', { rigor: 'tdd-pair', role: 'red', expects: ['src/x.js'] }), leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], expects: ['src/x.js'] })]
  assert.deepEqual(leafIds(effort(nodes, [{ kind: 'dispatched', node: 'r' }, { kind: 'approved', node: 'r' }])), ['g'])
})

test('a deferral is advisory: a leaf deferred behind work nothing in this execution runs launches when nothing else would', () => {
  const nodes = [folder('.'), folder('x'), leaf('x/a', { expects: ['src/x.js'] }), folder('y'), leaf('y/b', { expects: ['src/x.js'] })]
  const elsewhere = [{ kind: 'dispatched', node: 'x/a', execution: 'other' }]
  assert.deepEqual(leafIds(effort(nodes, elsewhere, { root: 'y' })), ['y/b'], 'x/a stands active in another execution and nothing here runs')
  assert.deepEqual(leafIds(effort(nodes, elsewhere, { root: 'y', running: ['plan:z'] })), [], 'while anything runs here, it waits')
  assert.deepEqual(summarize(effort(nodes, elsewhere, { root: 'y' })).blocked, [], 'a deferral blocks nothing and escalates nothing')
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
  const planner = { kind: 'dispatched', node: 'x', role: 'planner' }
  assert.deepEqual(launched(effort(nodes, [park, planner]), 'plan'), [], 'a planner dispatch on the folder newer than the park answers it')
  assert.equal(launched(effort(nodes, [planner, park]), 'plan').length, 1, 'a planner dispatch older than the park does not')
  const withY = [...nodes, folder('y', { author: 'planner' }), leaf('y/a')]
  assert.deepEqual(launched(effort(withY, [park, { ...planner, node: 'y' }]), 'plan').map((l) => l.id), ['x'], 'a planner dispatch on another folder does not')
  assert.equal(launched(effort(nodes, [park, { ...planner, role: 'reviewer' }]), 'plan').length, 1, 'a dispatch of another role does not')
  assert.equal(launched(effort(nodes, [park], { state: [{ kind: 'dispatch', label: 'plan:x', seq: 99 }] }), 'plan').length, 1, 'a 4.x dispatch state line counts for nothing')
  assert.deepEqual(launched(effort([folder('.'), folder('x'), leaf('x/a')], [park]), 'plan'), [])
})

test("a stale planner folder, under a park or a cleared stop, plans the edit", () => {
  const nodes = [folder('.'), folder('x', { author: 'planner' }), leaf('x/a')]
  const park = { kind: 'parked', node: 'x', return: 'integration_critical' }
  const retry = { kind: 'replanned', node: 'x', reason: 'retry_escalated' }
  const edited = () => true
  assert.deepEqual(launched(effort(nodes, [park], { stale: edited }), 'plan').map((l) => [l.id, l.why]), [['x', 'spec_edited']])
  assert.deepEqual(launched(effort(nodes, [park, retry], { stale: edited }), 'plan').map((l) => l.why), ['spec_edited'], 'a retried park too')
  assert.deepEqual(launched(effort(nodes, [park]), 'plan'), [], 'an unedited spec plans nothing')
  assert.deepEqual(launched(effort(nodes, [], { stale: edited }), 'plan'), [], 'nor an edit over no park: the plan that made it runs on')
  const stop = { kind: 'escalated', node: 'x', reason: 'review_incomplete' }
  assert.deepEqual(launched(effort(nodes, [stop], { stale: edited }), 'plan'), [], 'an escalation waits for the session')
  const asked = { kind: 'parked', node: 'x', return: 'needs_decision' }
  const answered = { kind: 'replanned', node: 'x', reason: 'answered' }
  assert.deepEqual(launched(effort(nodes, [asked, answered], { stale: edited }), 'plan').map((l) => l.why), ['spec_edited'], 'an answered park too')
  const spent = { kind: 'parked', node: 'x', return: 'design_spend' }
  assert.deepEqual(launched(effort(nodes, [spent], { stale: edited }), 'plan'), [], 'a design_spend park waits for the user')
  assert.deepEqual(launched(effort(nodes, [spent, retry], { stale: edited }), 'plan').map((l) => l.why), ['spec_edited'], 'and goes on once retried')
  assert.deepEqual(launched(effort(nodes, [stop, retry], { stale: edited }), 'plan').map((l) => l.why), ['spec_edited'], 'a retried one plans the edit')
  assert.deepEqual(launched(effort([folder('.'), folder('x'), leaf('x/a')], [park], { stale: edited }), 'plan'), [], "the user's folder is the user's")
})

test("a stale planner folder is not integration-reviewed over the old graph", () => {
  const nodes = [folder('.'), folder('x', { author: 'planner' }), leaf('x/a')]
  const merged = [{ kind: 'dispatched', node: 'x/a' }, { kind: 'approved', node: 'x/a' }, { kind: 'merged', node: 'x/a' }]
  const reviews = (extra) => launched(effort(nodes, merged, extra), 'review').map((l) => l.id)
  assert.deepEqual(reviews({}), ['x'], 'the fixture: x is reviewing')
  assert.deepEqual(reviews({ stale: (id) => id === 'x' }), [])
})

test('a folder is not integration-reviewed while a plan of it or an ancestor runs or launches beside the review', () => {
  const nodes = [folder('.'), folder('x', { author: 'planner' }), leaf('x/a')]
  const merged = [{ kind: 'dispatched', node: 'x/a' }, { kind: 'approved', node: 'x/a' }, { kind: 'merged', node: 'x/a' }]
  const reviews = (events, extra) => launched(effort(nodes, events, extra), 'review').map((l) => l.id)
  assert.deepEqual(reviews(merged, {}), ['x'], 'the fixture: x is reviewing')
  assert.deepEqual(reviews(merged, { running: ['plan:x'] }), [], 'its plan runs')
  assert.deepEqual(reviews(merged, { running: ['plan:.'] }), [], "an ancestor's plan runs")
  // A retried stop on an edited planner spec above x launches its plan: x's review waits for what that plan compiles.
  const deep = [folder('.'), folder('p', { author: 'planner' }), folder('p/x'), leaf('p/x/a'), leaf('p/b')]
  const under = [{ kind: 'merged', node: 'p/x/a' }, { kind: 'escalated', node: 'p', reason: 'review_not_converging' }, { kind: 'replanned', node: 'p', reason: 'retry_escalated' }]
  const both = effort(deep, under, { stale: (id) => id === 'p' })
  assert.deepEqual(launched(both, 'plan').map((l) => l.id), ['p'])
  assert.deepEqual(launched(both, 'review'), [])
  assert.deepEqual(launched(effort(deep, under), 'review').map((l) => l.id), ['p/x'], 'with no plan launching, p/x is reviewed')
  const full = effort(deep, under, { stale: (id) => id === 'p', maxParallel: 1, running: ['plan:q'] })
  assert.deepEqual(launched(full, 'plan'), [], 'no plan slot is free')
  assert.deepEqual(launched(full, 'review'), [], 'a due plan waiting for a slot holds the review too')
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

test('a folder whose children merged is reviewed, merges up once its review stands, and is reviewed again after a later merge or an answered park', () => {
  const nodes = [folder('.'), folder('x'), leaf('x/a'), leaf('x/b')]
  const where = { branch: 'agentics/e--x', worktree: '/wt/x', head: 'h2', base: 'h0' }
  const merged = [{ kind: 'merged', node: 'x/a' }, { kind: 'merged', node: 'x/b' }]
  const extra = { integrationOf: (id) => (id === 'x' ? where : null) }
  const review = launched(effort(nodes, merged, extra), 'review')
  assert.deepEqual(review, [{ unit: 'review', id: 'x', earned: true, where, children: ['x/a', 'x/b'], unreviewed: ['x/a', 'x/b'] }])

  const done = [...merged, { kind: 'claims', node: 'x', head_sha: 'h2', review: 'done', claims: [] }]
  assert.deepEqual(launched(effort(nodes, done, extra), 'review'), [])
  assert.deepEqual(launched(effort(nodes, done, extra), 'merge')[0].children, [{ id: 'x', head_sha: 'h2' }])

  const mergedSince = [...done, { kind: 'merged', node: 'x/b' }]
  assert.equal(launched(effort(nodes, mergedSince, extra), 'review').length, 1)
  assert.deepEqual(launched(effort(nodes, mergedSince, extra), 'merge'), [])

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

const group = (id, extra = {}) => ({ id, kind: 'group', title: 'gather ' + id, ...extra })

test('a group has no branch: a dependency in another group is ready once it merged, and a group dependency once every task in it did', () => {
  const nodes = [folder('.'), group('x'), leaf('x/a'), leaf('x/b'), group('y'), leaf('y/c', { deps: ['x/a'] }), leaf('d', { deps: ['x'] })]
  assert.deepEqual(leafIds(effort(nodes, [{ kind: 'merged', node: 'x/a' }])), ['x/b', 'y/c'])
  assert.deepEqual(leafIds(effort(nodes, [{ kind: 'merged', node: 'x/a' }, { kind: 'merged', node: 'x/b' }])), ['d', 'y/c'])
  const behind = [folder('.'), group('x', { deps: ['a'] }), leaf('x/b'), leaf('a')]
  assert.deepEqual(leafIds(effort(behind)), ['a'], 'a group\'s after binds every task in it')
})

test('a task in a group merges into the group\'s folder, and the folder reviews it as its own unit', () => {
  const nodes = [folder('.'), group('x'), leaf('x/a'), leaf('x/b')]
  const approved = effort(nodes, [{ kind: 'dispatched', node: 'x/a' }, { kind: 'approved', node: 'x/a' }])
  assert.deepEqual(launched(approved, 'merge').map((m) => [m.target, m.children.map((c) => c.id)]), [['.', ['x/a']]])
  const done = effort(nodes, [{ kind: 'merged', node: 'x/a' }, { kind: 'merged', node: 'x/b' }], { integrationOf: (id) => (id === '.' ? { head: 'h' } : null) })
  const [review] = launched(done, 'review')
  assert.equal(review.id, '.')
  assert.deepEqual(review.children, ['x/a', 'x/b'])
  assert.equal(launched(done, 'plan').length, 0, 'a group is never planned')
})

test('an execution rooted at a group runs its tasks and is done when they have all merged', () => {
  const nodes = [folder('.'), group('x'), leaf('x/a'), leaf('x/b'), leaf('c')]
  assert.deepEqual(leafIds(effort(nodes, [], { root: 'x' })), ['x/a', 'x/b'])
  assert.equal(summarize(effort(nodes, [{ kind: 'merged', node: 'x/a' }, { kind: 'merged', node: 'x/b' }], { root: 'x' })).done, true)
})

const WHERE = () => ({ base: 'b', head: 'h', worktree: '' })
const byHand = (node, commits = ['c1']) => ({ kind: 'merged', node, into: 'agentics/e1--c', merged_sha: commits[0], head_sha: commits[commits.length - 1], by: 'user', commits })

test('an adopted leaf counts as unreviewed whatever its rigor', () => {
  const nodes = [folder('.'), folder('c'), leaf('c/p', { rigor: 'tdd-pair', role: 'red' }), leaf('c/q', { rigor: 'tdd-pair', role: 'red' })]
  const input = effort(nodes, [byHand('c/p'), { kind: 'merged', node: 'c/q', head_sha: 'h' }], { integrationOf: WHERE })
  assert.deepEqual(reviewOf(input, 'c').unreviewed, ['c/p'])
})

test('an adopted verify leaf earns its folder review; one agentics merged does not', () => {
  const nodes = [folder('.'), folder('c'), leaf('c/v', { rigor: 'verify' })]
  assert.equal(reviewOf(effort(nodes, [byHand('c/v')], { integrationOf: WHERE }), 'c').earned, true)
  assert.equal(reviewOf(effort(nodes, [{ kind: 'merged', node: 'c/v', head_sha: 'h' }], { integrationOf: WHERE }), 'c').earned, false)
})

test("an outside event on the folder earns its review; one on another folder does not", () => {
  const nodes = [folder('.'), folder('c'), leaf('c/v', { rigor: 'verify' }), folder('d'), leaf('d/w', { rigor: 'verify' })]
  const merged = [{ kind: 'merged', node: 'c/v', head_sha: 'h' }, { kind: 'merged', node: 'd/w', head_sha: 'h' }]
  const outside = { kind: 'outside', node: 'd', commits: ['s1'], by: 'user' }
  assert.equal(reviewOf(effort(nodes, [...merged, outside], { integrationOf: WHERE }), 'd').earned, true)
  assert.equal(reviewOf(effort(nodes, [...merged, outside], { integrationOf: WHERE }), 'c').earned, false)
})

test("outsideWorkOf names a folder's adopted units with their commits and its own outside commits", () => {
  const events = [byHand('c/a', ['a1', 'a2']), { kind: 'merged', node: 'c/b', head_sha: 'h' },
    { kind: 'outside', node: 'c', commits: ['s1'], by: 'user' }, { kind: 'outside', node: 'd', commits: ['s9'], by: 'user' },
    { kind: 'outside', node: 'c', commits: ['s2', 's3'], by: 'terminal' }]
  assert.deepEqual(outsideWorkOf(events, 'c', ['c/a', 'c/b']), { leaves: [{ id: 'c/a', commits: ['a1', 'a2'] }], commits: ['s1', 's2', 's3'] })
  assert.deepEqual(outsideWorkOf([], 'c', ['c/a']), { leaves: [], commits: [] })
})

test('a folder compile parked spec_changed is stale while the park stands, whatever its spec reads', () => {
  const nodes = [folder('.'), folder('x', { author: 'planner' }), leaf('x/a')]
  const parkedTree = effort(nodes, [{ kind: 'dispatched', node: 'x/a' }, { kind: 'parked', node: 'x', return: 'spec_changed' }])
  assert.equal(stale('/no/such/repo', 'e', parkedTree, 'x'), true)
})
