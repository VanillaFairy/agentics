// test/status.test.mjs — every status a person reads, derived from the logs on each call.
//
// What is pinned here:
//
//   efforts   root status, node counts per status, executions (closed / checkpoint / open), seq
//   todos     one item per node of the execution's subtree, the stage as activeForm
//             (implementing, writing tests, fix round N, held, awaiting merge, waiting on user,
//             waiting on host, escalated: <reason>), and the ONGOING / DONE / NEEDS_INPUT header
//   cost      the runner's returned lines joined to their dispatched: totals, per model, per leaf
//             and per folder; unmeasured calls never read as zero; the measured cost per merged leaf
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

import { append, seqMax } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { checkpointOf, costOf, efforts, renderTodos, snapshotOf, todosOf } from '../lib/status.mjs'
import { effortDir, effortStateDir, executionDir, executionRunId, posix, returnPath, runJsonPath, writeJson } from '../lib/store.mjs'

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
  const due = todosOf(repo, E, X1)
  assert.deepEqual(due.todos.map((t) => t.key), ['a', 'a/x', 'a/y', 'a/@review'], 'only the execution\'s subtree, its review last')
  assert.equal(due.header, 'ONGOING', 'children merged is not integrated: the review is still due')
  assert.deepEqual([byKey(due).a.activeForm, byKey(due)['a/@review'].status, byKey(due)['a/@review'].activeForm],
    ['awaiting review', 'in_progress', 'in review'])

  ev(repo, 'claims', 'a', { head_sha: 'h', review: 'done', claims: [] })
  const list = todosOf(repo, E, X1)
  assert.equal(list.root, 'a', 'the root comes from execution.json')
  assert.equal(byKey(list)['a/@review'].status, 'completed')
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
  append(repo, E, 'state:' + X2, { kind: 'checkpoint', reason: 'blocking_gaps' })

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

// ------------------------------------------------------------------ cost

const usage = (input, output, cacheRead = 0, cacheWrite = 0) =>
  ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite })
const tokensIn = (u) => u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
let minted = 0

/**
 * One runner call on `node` in execution `stamp`: its `dispatched` event, and its `returned` line
 * with `returned`'s fields unless `returned` is null (a call that never returned). Returns its dispatch.
 */
function call(repo, stamp, node, model, returned = {}) {
  const dispatch = 'd' + ++minted
  append(repo, E, 'events', { kind: 'dispatched', node, execution: stamp, dispatch, role: 'implementer', round: 1, model, effort: 'medium' })
  if (returned) {
    append(repo, E, 'state:' + stamp, {
      kind: 'returned', dispatch, session: 's', status: 'returned', cause: '', usage: null, cost_total: null, cost_usd: null, denials: [], ...returned,
    })
  }
  return dispatch
}

test('cost joins each returned line to its dispatched: totals, per model, per leaf and per folder', () => {
  const repo = effortWith([composite('.'), composite('a'), leaf('a/x'), leaf('a/y'), leaf('z')])
  mkdirSync(executionDir(repo, E, X2), { recursive: true })
  const spent = [
    { node: 'a/x', model: 'sonnet', usage: usage(100, 50, 800), usd: 0.25, stamp: X1 },
    { node: 'a/x', model: 'opus', usage: usage(40, 20), usd: 1.5, stamp: X1 },
    { node: 'a', model: 'opus', usage: usage(10, 5, 0, 30), usd: 0.5, stamp: X1 },
    { node: 'z', model: 'sonnet', usage: usage(7, 3), usd: 0.125, stamp: X2 },
  ]
  for (const s of spent) call(repo, s.stamp, s.node, s.model, { usage: s.usage, cost_usd: s.usd })
  const total = (list) => ({
    dispatches: list.length, tokens: list.reduce((n, s) => n + tokensIn(s.usage), 0), usd: list.reduce((n, s) => n + s.usd, 0), unmeasured: 0,
  })
  const c = costOf(repo, E)
  assert.deepEqual([c.dispatches, c.tokens, c.usd, c.unmeasured], Object.values(total(spent)))
  for (const model of ['sonnet', 'opus']) assert.deepEqual(c.by_model[model], total(spent.filter((s) => s.model === model)), model)
  const leafOf = (id) => { const { status: _s, ...rest } = c.per_leaf[id]; return rest }
  assert.deepEqual(leafOf('a/x'), total(spent.filter((s) => s.node === 'a/x')))
  assert.deepEqual(leafOf('z'), total(spent.filter((s) => s.node === 'z')))
  assert.equal(c.per_leaf.a, undefined, 'a folder\'s own call is not a leaf\'s')
  assert.deepEqual(c.per_folder.a, total(spent.filter((s) => s.node === 'a' || s.node.startsWith('a/'))), 'a folder holds every call at or below it')
  assert.deepEqual(c.per_folder['.'], total(spent))
  assert.equal(c.per_folder['a/x'], undefined, 'a leaf is no folder')
})

test('a call that never returned is unmeasured while its run is not live, and not counted while it runs', () => {
  const repo = effortWith([composite('.'), leaf('x')])
  call(repo, X1, 'x', 'sonnet', null)
  const stopped = costOf(repo, E)
  assert.deepEqual([stopped.dispatches, stopped.tokens, stopped.usd, stopped.unmeasured], [1, 0, 0, 1])
  assert.equal(stopped.per_leaf.x.unmeasured, 1)
  assert.equal(stopped.by_model.sonnet.unmeasured, 1)
  const run = executionRunId(E, X1)
  writeJson(runJsonPath(repo, run), { run, pid: process.pid, heartbeat_at: new Date().toISOString() })
  const live = costOf(repo, E)
  assert.deepEqual([live.dispatches, live.unmeasured], [0, 0], 'a call in flight is neither spent nor lost yet')
})

test('a call cut off and resumed in its own session counts once, by its returned line', () => {
  const repo = effortWith([composite('.'), leaf('x')])
  const d = call(repo, X1, 'x', 'sonnet', null)
  append(repo, E, 'events', { kind: 'dispatched', node: 'x', execution: X1, dispatch: d, role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  append(repo, E, 'state:' + X1, { kind: 'returned', dispatch: d, session: 's', status: 'returned', cause: '', usage: usage(5, 5), cost_total: 0.5, cost_usd: 0.5, denials: [] })
  const c = costOf(repo, E)
  assert.deepEqual([c.dispatches, c.tokens, c.usd, c.unmeasured], [1, 10, 0.5, 0])
})

test('a returned line with no numeric cost_usd is unmeasured, never zero, and its tokens still count', () => {
  const repo = effortWith([composite('.'), leaf('x')])
  call(repo, X1, 'x', 'sonnet', { usage: usage(30, 10), cost_usd: null })
  const c = costOf(repo, E)
  assert.deepEqual([c.dispatches, c.tokens, c.usd, c.unmeasured], [1, 40, 0, 1])
})

test('the leaf means average the merged leaves with nothing unmeasured, and are null when none qualifies', () => {
  const repo = effortWith([composite('.'), leaf('x'), leaf('y'), leaf('z'), leaf('w')])
  call(repo, X1, 'x', 'sonnet', { usage: usage(100, 100), cost_usd: 1 })
  call(repo, X1, 'x', 'opus', { usage: usage(50, 50), cost_usd: 2 })
  call(repo, X1, 'y', 'sonnet', { usage: usage(10, 10), cost_usd: 0.5 })
  call(repo, X1, 'z', 'sonnet', { usage: usage(9, 9), cost_usd: null })
  call(repo, X1, 'w', 'sonnet', { usage: usage(1, 1), cost_usd: 0.25 })
  for (const id of ['x', 'y', 'z']) ev(repo, 'merged', id, { into: 'agentics/eff', merged_sha: 'm', head_sha: 'h' })
  const c = costOf(repo, E)
  assert.equal(c.leaves_measured, 2, 'z has an unmeasured call, w has not merged')
  assert.equal(c.leaf_mean_tokens, Math.round((c.per_leaf.x.tokens + c.per_leaf.y.tokens) / 2))
  assert.equal(c.leaf_mean_usd, (c.per_leaf.x.usd + c.per_leaf.y.usd) / 2)
  assert.equal(c.per_leaf.x.status, 'merged')

  const bare = costOf(effortWith([composite('.')]), E)
  assert.equal(bare.leaf_mean_tokens, null, 'nothing measured is null, not 0')
  assert.equal(bare.leaf_mean_usd, null)
})

test('4.x dispatch and usage lines, and a dispatched event naming no dispatch, cost nothing', () => {
  const repo = effortWith([composite('.'), leaf('x')])
  dispatched(repo, 'x', 'implementer')
  append(repo, E, 'state:' + X1, { kind: 'dispatch', label: 'implementer:x#1', node: 'x', role: 'implementer', model: 'sonnet', effort: 'medium' })
  append(repo, E, 'state:' + X1, { kind: 'usage', agent: 'a0', label: 'implementer:x#1', models: { sonnet: { input: 5, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, output: 5 } } })
  const c = costOf(repo, E)
  assert.deepEqual([c.dispatches, c.tokens, c.unmeasured, c.by_model, c.per_leaf], [0, 0, 0, {}, {}])
})

test('a leaf whose latest dispatch waits out a host stop is waiting on host until it is dispatched again or returns', () => {
  const repo = effortWith(TREE)
  const d = 'c.implementer.producer-c.r1'
  const again = () => ev(repo, 'dispatched', 'c', { dispatch: d, role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  const hostStop = () => append(repo, E, 'state:' + X1, { kind: 'host_stop', dispatch: d, cause: 'rate_limit', until: '' })
  const stage = () => byKey(todosOf(repo, E, X1)).c.activeForm
  again()
  assert.equal(stage(), 'implementing')
  hostStop()
  assert.equal(stage(), 'waiting on host')
  assert.equal(snapshotOf(repo, E).nodes.find((n) => n.id === 'c').stage, 'waiting on host', 'the snapshot\'s stage is the same')
  again()
  assert.equal(stage(), 'implementing', 'the call made after the stop is not waiting')
  hostStop()
  append(repo, E, 'state:' + X1, { kind: 'returned', dispatch: d, session: 's', status: 'failed', cause: 'host_error', usage: null, cost_total: null, cost_usd: null, denials: [] })
  assert.equal(stage(), 'implementing', 'a call that returned is not waiting')
})

test('an execution reads checkpoint while its latest checkpoint has no later confirmation, run or close', () => {
  const repo = effortWith(TREE)
  const status = () => efforts(repo).efforts[0].executions[0].status
  const state = (kind, fields = {}) => append(repo, E, 'state:' + X1, { kind, ...fields })
  state('run', { program: 'execute', pid: 1 })
  state('checkpoint', { reason: 'blocking_gaps' })
  state('ended', { result: { status: 'checkpoint', file: '', complete: false } })
  assert.equal(status(), 'checkpoint', 'what the run recorded after its checkpoint leaves it standing')
  state('checkpoint-confirmed')
  assert.equal(status(), 'open')
  state('checkpoint', { reason: 'overlap' })
  assert.equal(status(), 'checkpoint')
  state('run', { program: 'execute', pid: 2 })
  assert.equal(status(), 'open', 'a later run of the execution')
  state('checkpoint', { reason: 'overlap' })
  state('closed', { status: 'done' })
  assert.equal(status(), 'done')
})

const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

test('the cost counts a call that never returned as unmeasured, at no dollars', () => {
  const repo = effortWith(TREE)
  call(repo, X1, 'a/impl', 'sonnet', null)
  const cost = costOf(repo, E)
  const spent = ({ dispatches, usd, tokens, unmeasured }) => [dispatches, usd, tokens, unmeasured]
  assert.deepEqual(spent(cost), [1, 0, 0, 1])
  assert.deepEqual(spent(cost.by_model.sonnet), [1, 0, 0, 1])
})

test('the CLI prints an envelope with --json and a readable view without it', () => {
  const repo = effortWith(TREE)
  call(repo, X1, 'a/impl', 'sonnet', { usage: usage(10, 10), cost_usd: 0.5 })

  for (const verb of [['list'], ['show', '--effort', E], ['todos', '--effort', E, '--execution', X1], ['cost', '--effort', E]]) {
    const out = JSON.parse(cli(...verb, '--repo', repo, '--json'))
    assert.equal(out.payload_digest, fnv1a(canonical(out.payload)), verb[0] + ' prints under its digest')
  }

  assert.match(cli('list', '--repo', repo), /^eff — active — /)
  assert.match(cli('show', '--repo', repo, '--effort', E), /impl \[trivial\] — active — do a\/impl/)
  assert.match(cli('todos', '--repo', repo, '--effort', E, '--execution', X1), /\[>\] a\/impl — do a\/impl — implementing/)
  assert.match(cli('cost', '--repo', repo, '--effort', E), /by model: sonnet 1 \(\$0\.50, 20 tokens\)/)
  assert.ok(cli('list', '--repo', repo).includes('seq ' + seqMax(repo, E)), 'list prints the seq a watch starts from')
  const lost = effortWith(TREE)
  call(lost, X1, 'a/impl', 'sonnet', null)
  assert.match(cli('cost', '--repo', lost, '--effort', E), /spent: +\$0\.00, 0 tokens \(\+ 1 dispatch\(es\) unmeasured\)/)

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
  const gaps = [{ decision: 'D2', at: '.', why: 'no entry realises it' }]
  append(repo, E, 'state:' + X1, { kind: 'checkpoint', reason: 'blocking_gaps', detail: '1 gap', gaps })
  assert.deepEqual(checkpointOf(repo, E, X1), { reason: 'blocking_gaps', detail: '1 gap', gaps })
  const out = execFileSync(process.execPath, [CLI, 'checkpoint', '--repo', repo, '--effort', E, '--execution', X1], { encoding: 'utf8' })
  assert.match(out, /D2 at \.: no entry realises it/)
})

test('a stop\'s question reaches the snapshot whole from its dispatch\'s stored return', () => {
  const repo = effortWith(TREE)
  const d = 'a.implementer.producer-a.r1'
  const text = 'Keep the cache?\nIt costs 2 GB.'
  writeJson(returnPath(executionDir(repo, E, X1), d), { status: 'blocked', text })
  append(repo, E, 'events', { kind: 'parked', node: 'a', execution: X1, return: 'needs_decision', question: '', said: d })
  const node = snapshotOf(repo, E).nodes.find((n) => n.id === 'a')
  assert.equal(node.event.question, text, 'the viewer gets the whole question')
  assert.equal(node.event.said, d, 'said names the dispatch whose return holds it')

  const e = 'c.implementer.producer-c.r1'
  writeJson(returnPath(executionDir(repo, E, X1), e), { status: 'blocked', text: 'The merge needs a human.' })
  append(repo, E, 'events', { kind: 'escalated', node: 'c', execution: X1, reason: 'no_commit', detail: 'cut off', said: e })
  const stop = snapshotOf(repo, E).nodes.find((n) => n.id === 'c').event
  assert.deepEqual([stop.detail, stop.said], ['cut off\nThe merge needs a human.', e])
})

test('a folder\'s integration review entry leads with what its reviewer\'s stored return said', () => {
  const repo = effortWith([composite('.'), leaf('x')])
  ev(repo, 'merged', 'x', { into: 'agentics/eff', merged_sha: 'm', head_sha: 'h' })
  const d = 'root.reviewer.integration-.-1.r1'
  writeJson(returnPath(executionDir(repo, E, X1), d), { units: [], findings: [], fix_rulings: [], claims: [], notes: 'The criteria\nhold.\n\nDetails follow.' })
  ev(repo, 'claims', '.', { head_sha: 'h', review: 'done', claims: [], said: d })
  const entry = snapshotOf(repo, E).nodes.find((n) => n.id === '@review')
  assert.deepEqual(entry.card.report, { dispatch: d, lead: 'The criteria hold.' })
  assert.deepEqual(entry.files.returns, [posix(returnPath(executionDir(repo, E, X1), d))], "its reviewer's stored return is the entry's file")
  assert.equal(entry.live, null)
  assert.equal(entry.card.checkout_changed, null)
  ev(repo, 'claims', '.', { head_sha: 'h2', review: 'done', claims: [], said: 'gone.reviewer.r1' })
  assert.equal(snapshotOf(repo, E).nodes.find((n) => n.id === '@review').card.report, null, 'a return never stored leads with nothing')
  assert.deepEqual(snapshotOf(repo, E).nodes.find((n) => n.id === '@review').files.returns, [], 'and names no file')
})

test('the snapshot says who writes each node\'s spec', () => {
  const repo = effortWith([...TREE, { id: 'f', title: 'shape f', kind: 'design', author: 'planner' }])
  const authors = Object.fromEntries(snapshotOf(repo, E).nodes.map((n) => [n.id, n.author]))
  assert.equal(authors.f, 'planner', 'the viewer queues a planner-written design instead of asking the user')
  assert.equal(authors.a, 'you')
})

test('the status CLI refuses a value that is not a handle, and a flag it does not take', () => {
  const refusal = (...args) => {
    try {
      execFileSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NODE_TEST_CONTEXT: '' }, timeout: 30_000,
      })
      return [0, '']
    } catch (err) {
      return [err.status, JSON.parse(err.stdout).kind]
    }
  }
  assert.deepEqual(refusal('show', '--repo', '.', '--effort', 'e f'), [1, 'args_unreadable'])
  assert.deepEqual(refusal('watch', '--repo', '.', '--run', 'e1.2026\n'), [1, 'args_unreadable'])
  assert.deepEqual(refusal('list', '--repo', '.\n'), [1, 'args_unreadable'])
  assert.deepEqual(refusal('list', '--repo', '.', '--verbose', 'x'), [1, 'unknown_flag'])
})
