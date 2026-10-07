// test/status.test.mjs — every status a person reads, derived from the logs on each call.
//
// What is pinned here:
//
//   efforts   root status, node counts per status, executions (closed / checkpoint / open), seq
//   todos     the --no-progress list: one item per node of the execution's subtree, the stage as
//             activeForm (implementing, writing tests, fix round N, held, awaiting merge, waiting
//             on user, escalated: <reason>), and the ONGOING / DONE / NEEDS_INPUT header
//   cost      dispatches per model and role, tokens and dollars per model where usage was
//             recorded, dispatches counted where it was not, and the measured cost per merged leaf
//   CLI       --json prints the envelope; the default is for a person
//
// Design: docs/DESIGN.md#progress, docs/DESIGN.md#self-checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { append, seqMax } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { checkpointOf, costOf, efforts, questionsSince, renderTodos, snapshotOf, todosOf } from '../lib/status.mjs'
import { effortDir, effortStateDir, executionDir, returnPath, writeJson } from '../lib/store.mjs'
import { tokensOf, usdOf } from '../lib/usage.mjs'

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

test('the cost report counts per model and role, and never reads an unreported token as zero', () => {
  const repo = effortWith([composite('.'), leaf('x'), leaf('y'), leaf('z')])
  mkdirSync(executionDir(repo, E, X2), { recursive: true })
  const SONNET = 'claude-sonnet-5'
  const OPUS = 'claude-opus-5-5'
  const spent = (input, cache_read, output) => ({ input, cache_write_5m: 0, cache_write_1h: 0, cache_read, output })
  let agents = 0
  const d = (stamp, node, role, model, models) => {
    const label = role + ':' + node + '#1'
    append(repo, E, 'state:' + stamp, { kind: 'dispatch', label, node, role, model, effort: 'medium' })
    if (models) append(repo, E, 'state:' + stamp, { kind: 'usage', agent: 'a' + agents++, label, models })
  }
  const x1 = spent(100, 800, 100)
  const x2 = spent(50, 400, 50)
  const y = spent(200, 1600, 200)
  const root = spent(30, 240, 30)
  d(X1, 'x', 'implementer', 'sonnet', { [SONNET]: x1 })
  d(X1, 'x', 'reviewer', 'opus', { [OPUS]: x2 })
  d(X2, 'y', 'implementer', 'sonnet', { [SONNET]: y })
  d(X2, 'z', 'implementer', 'sonnet', null)
  d(X2, '.', 'reviewer', 'opus', { 'claude-next': root })
  append(repo, E, 'state:' + X2, { kind: 'checkpoint', reason: 'x' })
  for (const id of ['x', 'y', 'z']) ev(repo, 'merged', id, { into: 'agentics/eff', merged_sha: 'm', head_sha: 'h' })

  // A later line for the same agent replaces its earlier one.
  append(repo, E, 'state:' + X1, { kind: 'usage', agent: 'a0', label: 'implementer:x#1', models: { [SONNET]: spent(1, 1, 1) } })
  append(repo, E, 'state:' + X1, { kind: 'usage', agent: 'a0', label: 'implementer:x#1', models: { [SONNET]: x1 } })
  // An agent whose dispatch was never recorded is still its leaf's spend, by its label.
  const lost = spent(7, 70, 7)
  append(repo, E, 'state:' + X2, { kind: 'usage', agent: 'lost', label: 'close:z#2#2', models: { [SONNET]: lost } })

  const shown = (c, usd) => ({ input: c.input, cache_write: 0, cache_read: c.cache_read, output: c.output, usd })
  const xUsd = usdOf(SONNET, x1) + usdOf(OPUS, x2)
  const c = costOf(repo, E)
  assert.equal(c.dispatches, 5)
  assert.deepEqual(c.by_model, { sonnet: 3, opus: 2 })
  assert.deepEqual(c.by_role, { implementer: 3, reviewer: 2 })
  assert.equal(c.tokens, [x1, x2, y, root, lost].reduce((sum, s) => sum + tokensOf(s), 0))
  assert.ok(Math.abs(c.usd - (xUsd + usdOf(SONNET, y) + usdOf(SONNET, lost))) < 1e-9, 'a model with no price adds no dollars')
  assert.equal(c.usage['claude-next'].usd, null, 'and says so, never 0')
  assert.deepEqual(c.usage[OPUS], shown(x2, usdOf(OPUS, x2)))
  assert.equal(c.usage[SONNET].input, x1.input + y.input + lost.input)
  assert.equal(c.tokens_unreported, 1)
  assert.deepEqual(c.per_leaf.x, {
    dispatches: 2, tokens: tokensOf(x1) + tokensOf(x2), usd: xUsd, tokens_unreported: 0,
    usage: { [SONNET]: shown(x1, usdOf(SONNET, x1)), [OPUS]: shown(x2, usdOf(OPUS, x2)) }, status: 'merged',
  })
  assert.equal(c.per_leaf.z.tokens_unreported, 1)
  assert.equal(c.per_leaf.z.tokens, tokensOf(lost))
  assert.equal(c.per_leaf.z.dispatches, 1)
  assert.equal(c.per_leaf['.'], undefined, 'a composite\'s dispatch is cost, not a leaf\'s')
  assert.equal(c.leaves_measured, 2, 'z has an unreported dispatch, so it is not measured')
  assert.equal(c.leaf_mean_tokens, Math.round((c.per_leaf.x.tokens + c.per_leaf.y.tokens) / 2))
  assert.equal(c.leaf_mean_usd, (c.per_leaf.x.usd + c.per_leaf.y.usd) / 2)

  const bare = costOf(effortWith([composite('.')]), E)
  assert.equal(bare.leaf_mean_tokens, null, 'nothing measured is null, not 0')
  assert.equal(bare.leaf_mean_usd, null)
})

const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

test('the CLI prints an envelope with --json and a readable view without it', () => {
  const repo = effortWith(TREE)
  dispatched(repo, 'a/impl', 'implementer')
  append(repo, E, 'state:' + X1, { kind: 'dispatch', label: 'l', node: 'a/impl', role: 'implementer', model: 'sonnet', effort: 'low' })

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
  const gaps = [{ decision: 'D2', at: '.', why: 'no entry realises it' }]
  append(repo, E, 'state:' + X1, { kind: 'checkpoint', reason: 'blocking_gaps', detail: '1 gap', gaps })
  assert.deepEqual(checkpointOf(repo, E, X1), { reason: 'blocking_gaps', detail: '1 gap', gaps })
  const out = execFileSync(process.execPath, [CLI, 'checkpoint', '--repo', repo, '--effort', E, '--execution', X1], { encoding: 'utf8' })
  assert.match(out, /D2 at \.: no entry realises it/)
})

test('a watch sees each question an execution raises after it started, and stops when an invocation ends', () => {
  const repo = effortWith(TREE)
  append(repo, E, 'events', { kind: 'escalated', node: 'a', execution: X1, reason: 'old', detail: 'before the watch' })
  const start = seqMax(repo, E)
  append(repo, E, 'events', { kind: 'parked', node: 'b', execution: X1, return: 'needs_decision', question: 'keep the cache?\nor drop it' })
  append(repo, E, 'events', { kind: 'escalated', node: 'c', execution: X2, reason: 'blocked', detail: 'another execution' })
  const q = questionsSince(repo, E, X1, start)
  assert.deepEqual(q.lines.map((l) => l.line), ['parked b (needs_decision): keep the cache?'], 'one line: the rest is in the file or the snapshot')
  assert.equal(q.ended, false)

  append(repo, E, 'state:' + X1, { kind: 'ended' })
  assert.equal(questionsSince(repo, E, X1, start).ended, true)
})

const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: '' }

test('the watch command prints each question as it lands and exits when the invocation ends', { timeout: 20000 }, async (t) => {
  const repo = effortWith(TREE)
  const since = seqMax(repo, E)
  const child = spawn(process.execPath, [CLI, 'watch', '--repo', repo, '--effort', E, '--execution', X1, '--since', String(since)], { env: CHILD_ENV })
  const exited = new Promise((resolve) => child.on('close', resolve))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  append(repo, E, 'events', { kind: 'escalated', node: 'a', execution: X1, reason: 'blocked', detail: 'needs a key' })
  append(repo, E, 'state:' + X1, { kind: 'ended' })
  assert.equal(await exited, 0)
  assert.equal(out.trim(), 'escalated a (blocked): needs a key')
})

test('--since prints records appended before the watch started (an execution)', () => {
  const repo = effortWith(TREE)
  const since = seqMax(repo, E)
  append(repo, E, 'events', { kind: 'escalated', node: 'a', execution: X1, reason: 'blocked', detail: 'needs a key' })
  append(repo, E, 'state:' + X1, { kind: 'ended' })
  const out = execFileSync(process.execPath, [CLI, 'watch', '--repo', repo, '--effort', E, '--execution', X1, '--since', String(since)], {
    encoding: 'utf8', env: CHILD_ENV, timeout: 20000,
  })
  assert.equal(out, 'escalated a (blocked): needs a key\n')
})

test('watch refuses a --since that is not a non-negative integer', () => {
  const repo = effortWith(TREE)
  append(repo, E, 'state:' + X1, { kind: 'ended' })
  for (const tail of [['--since', 'abc'], ['--since', '-1'], ['--since', '1.5'], ['--since']]) {
    const r = spawnSync(process.execPath, [CLI, 'watch', '--repo', repo, '--effort', E, '--execution', X1, ...tail], {
      encoding: 'utf8', env: CHILD_ENV, timeout: 20000,
    })
    assert.equal(r.status, 1, tail.join(' '))
    assert.match(JSON.parse(r.stdout).error, /--since/, tail.join(' '))
  }
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
  assert.deepEqual(entry.files.reports, [], 'the stored return is no report file')
  ev(repo, 'claims', '.', { head_sha: 'h2', review: 'done', claims: [], said: 'gone.reviewer.r1' })
  assert.equal(snapshotOf(repo, E).nodes.find((n) => n.id === '@review').card.report, null, 'a return never stored leads with nothing')
})

test('the snapshot says who writes each node\'s spec', () => {
  const repo = effortWith([...TREE, { id: 'f', title: 'shape f', kind: 'design', author: 'planner' }])
  const authors = Object.fromEntries(snapshotOf(repo, E).nodes.map((n) => [n.id, n.author]))
  assert.equal(authors.f, 'planner', 'the viewer queues a planner-written design instead of asking the user')
  assert.equal(authors.a, 'you')
})
