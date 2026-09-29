// test/status.test.mjs — every status a person reads, derived from the logs on each call.
//
// What is pinned here:
//
//   efforts   root status, node counts per status, executions (closed / checkpoint / open), seq
//   todos     the --no-progress list: one item per node of the execution's subtree, the stage as
//             activeForm (implementing, writing tests, fix round N, held, awaiting merge, waiting
//             on user, escalated: <reason>), and the ONGOING / DONE / NEEDS_INPUT header
//   cost      dispatches per model and role, tokens summed where reported and counted where not,
//             and the measured cost per merged leaf
//   CLI       --json prints the envelope; the default is for a person
//
// Design: docs/DESIGN.md#progress, docs/DESIGN.md#self-checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { append } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { checkpointOf, costOf, efforts, renderTodos, todosOf } from '../lib/status.mjs'
import { effortDir, effortStateDir, executionDir } from '../lib/store.mjs'

const CLI = fileURLToPath(new URL('../lib/status.mjs', import.meta.url))
const fresh = () => mkdtempSync(join(tmpdir(), 'agentics-status-')).split('\\').join('/')

const E = 'eff'
const X1 = '20260904-100000'
const X2 = '20260905-100000'

const leaf = (id, extra = {}) => ({
  id, title: 'do ' + id, kind: 'leaf', rigor: 'trivial', locus: ['src/' + id + '.js'],
  acceptance: [{ text: 't', check: 'c' }], ...extra,
})
const composite = (id) => ({ id, title: 'make ' + id, kind: 'composite' })

/** Write the tree straight into the ledger; shape validation is lib/tree.mjs's to test. */
function effortWith(nodes, { root = '.', stamp = X1 } = {}) {
  const repo = fresh()
  append(repo, E, 'nodes', nodes.map((node) => ({ kind: 'node', node })))
  mkdirSync(executionDir(repo, E, stamp), { recursive: true })
  writeFileSync(join(executionDir(repo, E, stamp), 'execution.json'), JSON.stringify({ root }))
  return repo
}

const ev = (repo, kind, node, extra = {}) => append(repo, E, 'events', { kind, node, execution: X1, ...extra })
const dispatched = (repo, node, role, round = 1) => ev(repo, 'dispatched', node, { role, round, model: 'sonnet', effort: 'medium' })

const TREE = [
  composite('.'),
  composite('a'),
  leaf('a/impl'), leaf('a/fix'), leaf('a/tests', { rigor: 'tests-only' }), leaf('a/check', { rigor: 'verify', locus: [] }),
  composite('b'),
  leaf('b/red', { rigor: 'tdd-pair', role: 'red' }),
  leaf('b/green', { rigor: 'tdd-pair', role: 'green', deps: ['b/red'] }),
  leaf('c'), leaf('d'), leaf('e'),
]

const byKey = (list) => Object.fromEntries(list.todos.map((t) => [t.key, t]))

test('the todo list names each node\'s stage as the boundaries would', () => {
  const repo = effortWith(TREE)
  dispatched(repo, 'a/impl', 'implementer')
  dispatched(repo, 'a/fix', 'implementer')
  dispatched(repo, 'a/fix', 'implementer', 2)
  dispatched(repo, 'a/tests', 'test-author')
  dispatched(repo, 'a/check', '')
  dispatched(repo, 'b/red', 'test-author')
  ev(repo, 'approved', 'b/red', { head_sha: 'r1', review_rounds: 1, at_integration: false })
  dispatched(repo, 'b/green', 'implementer')
  dispatched(repo, 'c', 'implementer')
  ev(repo, 'escalated', 'c', { reason: 'verify_oscillating', detail: '' })
  ev(repo, 'parked', 'd', { return: 'needs_design', question: 'which?' })

  const list = todosOf(repo, E, X1)
  const t = byKey(list)
  assert.equal(list.root, '.')
  assert.deepEqual(list.todos.map((x) => x.key),
    ['.', 'a', 'a/check', 'a/fix', 'a/impl', 'a/tests', 'b', 'b/green', 'b/red', 'c', 'd', 'e'],
    'one item per node, pre-order')
  assert.equal(t['a/impl'].subject, 'a/impl — do a/impl')
  assert.deepEqual([t['a/impl'].status, t['a/impl'].activeForm], ['in_progress', 'implementing'])
  assert.equal(t['a/fix'].activeForm, 'fix round 2')
  assert.equal(t['a/tests'].activeForm, 'writing tests')
  assert.equal(t['a/check'].activeForm, 'checking')
  assert.deepEqual([t['b/red'].status, t['b/red'].activeForm], ['in_progress', 'held'],
    'a red approved before its green is held, not awaiting merge')
  assert.deepEqual([t.c.status, t.c.activeForm], ['pending', 'escalated: verify_oscillating'])
  assert.deepEqual([t.d.status, t.d.activeForm], ['pending', 'waiting on user'])
  assert.deepEqual([t.e.status, t.e.activeForm], ['pending', 'queued'])
  assert.equal(t.a.status, 'in_progress')
  assert.equal(list.header, 'ONGOING', 'something is active')
})

test('a cycle whose last member is approved is awaiting merge as a whole; a merge completes', () => {
  const repo = effortWith(TREE)
  dispatched(repo, 'b/red', 'test-author')
  ev(repo, 'approved', 'b/red', { head_sha: 'r1' })
  dispatched(repo, 'b/green', 'implementer')
  ev(repo, 'approved', 'b/green', { head_sha: 'g1' })
  dispatched(repo, 'a/impl', 'implementer')
  ev(repo, 'merged', 'a/impl', { into: 'agentics/eff--a', merged_sha: 'm', head_sha: 'h' })

  const t = byKey(todosOf(repo, E, X1))
  assert.equal(t['b/red'].activeForm, 'awaiting merge')
  assert.equal(t['b/green'].activeForm, 'awaiting merge')
  assert.deepEqual([t['a/impl'].status, t['a/impl'].activeForm], ['completed', 'merged'])
})

test('the header reads NEEDS_INPUT when something waits on the user and nothing is active', () => {
  const repo = effortWith(TREE)
  ev(repo, 'escalated', 'c', { reason: 'no_commit', detail: '' })
  assert.equal(todosOf(repo, E, X1).header, 'NEEDS_INPUT')

  dispatched(repo, 'e', 'implementer')
  assert.equal(todosOf(repo, E, X1).header, 'ONGOING', 'an active leaf is still moving')

  ev(repo, 'replanned', 'c', { reason: 'retry_escalated', by: 'session' })
  ev(repo, 'approved', 'e', { head_sha: 'x' })
  assert.equal(todosOf(repo, E, X1).header, 'ONGOING', 'a retried escalation is no longer input needed')
})

test('the header reads DONE when the execution\'s root is integrated, and the root item completes', () => {
  const repo = effortWith([composite('.'), composite('a'), leaf('a/x'), leaf('a/y'), leaf('b')], { root: 'a' })
  for (const id of ['a/x', 'a/y']) {
    dispatched(repo, id, 'implementer')
    ev(repo, 'merged', id, { into: 'agentics/eff--a', merged_sha: 'm', head_sha: 'h' })
  }
  const list = todosOf(repo, E, X1)
  assert.equal(list.root, 'a', 'the root comes from execution.json')
  assert.deepEqual(list.todos.map((t) => t.key), ['a', 'a/x', 'a/y'], 'only the execution\'s subtree')
  assert.equal(list.header, 'DONE')
  assert.equal(byKey(list).a.status, 'completed')
  assert.match(renderTodos(list), /^DONE — eff \/ 20260904-100000 \(root a\)\n\[x\] a — make a/)
})

test('an execution without an envelope lists the whole effort', () => {
  const repo = effortWith([composite('.'), leaf('x')])
  const list = todosOf(repo, E, '20260101-000000')
  assert.equal(list.root, '.')
  assert.equal(list.todos.length, 2)
})

test('the efforts list derives root status, counts, executions and the last seq', () => {
  const repo = effortWith(TREE)
  mkdirSync(effortStateDir(repo, E), { recursive: true })
  writeFileSync(join(effortStateDir(repo, E), 'effort.json'), JSON.stringify({ about: 'the change' }))
  dispatched(repo, 'a/impl', 'implementer')
  append(repo, E, 'state:' + X1, { kind: 'closed', status: 'done' })
  mkdirSync(executionDir(repo, E, X2), { recursive: true })
  writeFileSync(join(executionDir(repo, E, X2), 'execution.json'), JSON.stringify({ root: 'b' }))
  append(repo, E, 'state:' + X2, { kind: 'checkpoint', reason: 'stale' })

  const out = efforts(repo)
  assert.equal(out.store_present, true)
  const [e] = out.efforts
  assert.equal(e.effort, E)
  assert.equal(e.about, 'the change')
  assert.equal(e.root_status, 'active')
  assert.equal(e.counts.planned, 9)
  assert.equal(e.counts.active, 3, 'a/impl, a and the root')
  assert.deepEqual(e.executions, [
    { stamp: X1, root: '.', closed: true, status: 'done', batches: 0, merged: 0, bisected: 0 },
    { stamp: X2, root: 'b', closed: false, status: 'checkpoint', batches: 0, merged: 0, bisected: 0 },
  ])
  assert.equal(e.seq_max, TREE.length + 3, 'node lines, one event, two state lines — one counter across every log')

  assert.equal(efforts(fresh()).store_present, false)
})

test('an effort with no tree yet reads as unplanned', () => {
  const repo = fresh()
  mkdirSync(effortDir(repo, 'bare'), { recursive: true })
  assert.equal(efforts(repo).efforts[0].root_status, 'unplanned')
})

test('the cost report counts per model and role, and never reads an unreported token as zero', () => {
  const repo = effortWith([composite('.'), leaf('x'), leaf('y'), leaf('z')])
  mkdirSync(executionDir(repo, E, X2), { recursive: true })
  const d = (stamp, node, role, model, tokens) =>
    append(repo, E, 'state:' + stamp, { kind: 'dispatch', label: node + ':' + role, node, role, model, effort: 'medium', tokens })
  d(X1, 'x', 'implementer', 'sonnet', 1000)
  d(X1, 'x', 'reviewer', 'opus', 500)
  d(X2, 'y', 'implementer', 'sonnet', 2000)
  d(X2, 'z', 'implementer', 'sonnet', null)
  d(X2, '.', 'reviewer', 'opus', 300)
  append(repo, E, 'state:' + X2, { kind: 'checkpoint', reason: 'x' })
  for (const id of ['x', 'y', 'z']) ev(repo, 'merged', id, { into: 'agentics/eff', merged_sha: 'm', head_sha: 'h' })

  const c = costOf(repo, E)
  assert.equal(c.dispatches, 5)
  assert.deepEqual(c.by_model, { sonnet: 3, opus: 2 })
  assert.deepEqual(c.by_role, { implementer: 3, reviewer: 2 })
  assert.equal(c.tokens, 3800)
  assert.equal(c.tokens_unreported, 1)
  assert.deepEqual(c.per_leaf.x, { dispatches: 2, tokens: 1500, tokens_unreported: 0, status: 'merged' })
  assert.equal(c.per_leaf.z.tokens_unreported, 1)
  assert.equal(c.per_leaf['.'], undefined, 'a composite\'s dispatch is cost, not a leaf\'s')
  assert.equal(c.leaves_measured, 2, 'z has an unreported dispatch, so it is not measured')
  assert.equal(c.leaf_mean_tokens, 1750)

  assert.equal(costOf(effortWith([composite('.')]), E).leaf_mean_tokens, null, 'nothing measured is null, not 0')
})

const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

test('the CLI prints an envelope with --json and a readable view without it', () => {
  const repo = effortWith(TREE)
  dispatched(repo, 'a/impl', 'implementer')
  append(repo, E, 'state:' + X1, { kind: 'dispatch', label: 'l', node: 'a/impl', role: 'implementer', model: 'sonnet', effort: 'low', tokens: 10 })

  for (const verb of [['list'], ['show', '--effort', E], ['todos', '--effort', E, '--execution', X1], ['cost', '--effort', E]]) {
    const out = JSON.parse(cli(...verb, '--repo', repo, '--json'))
    assert.equal(out.payload_digest, fnv1a(canonical(out.payload)), verb[0] + ' prints under its digest')
  }

  assert.match(cli('list', '--repo', repo), /^eff — active — /)
  assert.match(cli('show', '--repo', repo, '--effort', E), /impl \[trivial\] — active — do a\/impl/)
  assert.match(cli('todos', '--repo', repo, '--effort', E, '--execution', X1), /\[>\] a\/impl — do a\/impl — implementing/)
  assert.match(cli('cost', '--repo', repo, '--effort', E), /by model: sonnet 1/)

  assert.throws(() => execFileSync(process.execPath, [CLI, 'todos', '--repo', repo, '--effort', E], { stdio: 'pipe' }),
    'todos without an execution is refused')
})

test('an execution summary counts its merge-batches, what they landed and which were bisected', () => {
  const repo = effortWith(TREE)
  mkdirSync(executionDir(repo, E, X1), { recursive: true })
  writeFileSync(join(executionDir(repo, E, X1), 'execution.json'), JSON.stringify({ root: '.' }))
  append(repo, E, 'state:' + X1, [
    { kind: 'batch', target: 'a', merged: ['a/impl', 'a/tests'], verified: true },
    { kind: 'batch', target: '.', merged: ['a'], verified: false },
  ])
  const [e] = efforts(repo).efforts
  const [x] = e.executions
  assert.deepEqual([x.batches, x.merged, x.bisected], [2, 3, 1])
})

test('the checkpoint an execution last stopped at keeps its lists for the session to read', () => {
  const repo = effortWith(TREE)
  assert.equal(checkpointOf(repo, E, X1), null)
  const stale = [{ node: 'c', writes: ['src/c.js'], reads: [] }]
  append(repo, E, 'state:' + X1, { kind: 'checkpoint', reason: 'stale', detail: '1 leaf', stale })
  assert.deepEqual(checkpointOf(repo, E, X1), { reason: 'stale', detail: '1 leaf', stale })
  const out = execFileSync(process.execPath, [CLI, 'checkpoint', '--repo', repo, '--effort', E, '--execution', X1], { encoding: 'utf8' })
  assert.match(out, /c — writes moved: src\/c\.js/)
})
