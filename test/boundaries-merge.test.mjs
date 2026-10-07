// test/boundaries-merge.test.mjs — lib/boundaries/merge.mjs: the merge batch and the suite gate, in
// process, over real git and the real measurement.
//
// What is pinned here:
//
//   mergeBatch  dependency order and a cycle's one merge; the fast or the full suite, through
//               `measure`; the bisect of a red merged head (the leaf failing alone, the rest merge);
//               the worktrees, locks, records and messages a batch leaves; what stops (a combination
//               failure, a composite or a cycle failing alone, a conflict, no progress, a batch that
//               cannot run); a batch run again after each point it can be killed at; the drift
//               record and the ruler's brief; the event loop running while the merge measures; the
//               user's checkout moving during a measurement (a checkout fault, nothing decided);
//               the refusals
//   driftOf     (pure) what a landed diff touched under a contract a pending node consumes
//   suiteGate   the full suite on the integration head, once per passing head; nothing run where
//               the tests are not split; a review that is not earned recorded once; a worktree that
//               cannot be attached; the checkout moving; the refusals
//
// Every repository is built with the fixture's seeding helpers; preflight and leaf-open are stood in
// for by the lib calls they make (`execution.json`, `acquire`, `ensureIntegration`, `ensureLeaf`, a
// `dispatched` event). Expected heads, branches, rounds and record paths are computed.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#merging, docs/DESIGN.md#the-suite-gate,
// docs/DESIGN.md#landing-and-drift.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { driftOf, mergeBatch, suiteGate } from '../lib/boundaries/merge.mjs'
import { executionContext } from '../lib/boundaries/records.mjs'
import { ensureIntegration, ensureLeaf, worktrees } from '../lib/integration.mjs'
import { executionLog, fileFor, readLog } from '../lib/ledger.mjs'
import { acquire, heldBy } from '../lib/locks.mjs'
import { branchOf, executionDir, mkdirState, posix, readJson, worktreeOf } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { COMMANDS, STAMP, commitIn, git, leaf, repo, root } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const SLOW = { timeout: 300_000 }
const SPLIT = { ...COMMANDS, suite_fast: 'node --test --test-reporter=spec test/add.test.mjs' }
const BREAK_ADD = 'export const add = (a, b) => a - b\n'
const FLIP_ADD = 'export const add = (a, b) => b + a\n'
const BREAK_BIG = 'export const add = (a, b) => (a === 2 && b === 2 ? 5 : a + b)\n'
const MEND_ADD = 'export const add = (a, b) => a + b\n'
const R_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { r } from '../src/r.mjs'\ntest('r is 1', () => assert.equal(r(), 1))\n"
const BIG_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../../src/add.mjs'\ntest('adds big', () => assert.equal(add(2, 2), 4))\n"
const PAIR_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { existsSync } from 'node:fs'\ntest('not both', () => assert.ok(!(existsSync('p.txt') && existsSync('q.txt'))))\n"

// ================================================================== a world to merge in

const rm = (r) => { try { rmSync(r, { recursive: true, force: true, maxRetries: 3 }) } catch { /* a handle held on Windows */ } }
const inTest = (t) => (fn) => t.after(fn)

const ctxOf = (r) => executionContext({ repo: r, effort: E, execution: STAMP, log: executionLog(r, E, STAMP) })
const stateOf = (r) => readLog(r, E, 'state:' + STAMP).entries
const eventsOf = (r) => readLog(r, E, 'events').entries
const journalOf = (r) => readLog(r, E, 'journal:' + STAMP).entries
const headOf = (r, id) => git(r, 'rev-parse', 'refs/heads/' + branchOf(E, id))
const statusOf = (r, id) => readTree(r, E).status.get(id).status
const ids = (list) => list.map((x) => x.id)
const stopsOf = (out) => out.stops.map((s) => [s.id, s.status, s.reason])
const kindOf = (entries, kind, node) => entries.filter((e) => e.kind === kind && (node === undefined || e.node === node))

/**
 * A repository, a seeded tree and the envelope preflight would have written. `register` takes the
 * cleanup (`t.after`, or the module's `after`); `prepare` changes the repository before the base
 * commit is read; `envelope: false` leaves the execution without its `execution.json`.
 */
function world(register, nodesOf, { commands = COMMANDS, prepare, envelope = true } = {}) {
  const r = repo()
  register(() => rm(r))
  if (prepare) prepare(r)
  const nodes = typeof nodesOf === 'function' ? nodesOf(r) : nodesOf
  const seeded = seedTree(r, E, nodes)
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems || seeded.error))
  const base = git(r, 'rev-parse', 'HEAD')
  const dir = executionDir(r, E, STAMP)
  mkdirState(dir)
  if (envelope) {
    writeFileSync(join(dir, 'execution.json'), JSON.stringify({
      stamp: STAMP, root: '.', base_branch: 'main', base_sha: base, dial: 'normal', pace: 'balanced', commands,
    }))
  }
  return { r, xc: ctxOf(r), base }
}

function integrationOf(w, folder = '.') {
  const out = ensureIntegration(w.r, E, folder, w.xc.envelope())
  assert.equal(out.ok, true, out.error)
  return out
}

const dispatch = (w, id, round) => w.xc.log.append('dispatched', {
  dispatch: 'd-' + id.replace(/[^A-Za-z0-9]/g, '-') + '-r' + round, node: id, round, thread: 'producer:' + id, role: 'implementer',
})

/** What leaf-open does: the locus, the folder's branch, the leaf's branch and worktree, round 1. */
function openLeaf(w, id, { folder = '.', from, cycleMember = false } = {}) {
  const node = readTree(w.r, E).nodes.get(id)
  const held = acquire(w.r, { effort: E, execution: STAMP, node: id, locus: node.locus })
  assert.equal(held.ok, true, JSON.stringify(held))
  const integ = integrationOf(w, folder)
  const made = ensureLeaf(w.r, E, id, { from: from || integ.head, parentBranch: integ.branch, cycleMember })
  assert.equal(made.ok, true, made.error)
  dispatch(w, id, 1)
  return { id, worktree: made.worktree, branch: made.branch }
}

/** A leaf opened and its change committed: `{id, head_sha, worktree, branch}`. */
function ready(w, id, files, subject, opts) {
  const open = openLeaf(w, id, opts)
  return { ...open, head_sha: commitIn(open.worktree, files, subject) }
}

const handed = (...leaves) => leaves.map((l) => ({ id: l.id, head_sha: l.head_sha }))
const batch = (w, children, extra = {}) => mergeBatch(w.xc, { target: '.', children, cycles: [], ...extra })

/** Put another branch where the integration worktree was, so nothing can attach it again. */
function takeWorktree(w, integ) {
  git(w.r, 'worktree', 'remove', '--force', integ.worktree)
  git(w.r, 'worktree', 'add', '-q', '-b', 'other', integ.worktree)
}

/** Create a branch in the user's checkout, from a timer; the failure is kept, never thrown into the loop. */
function moveCheckout(w, state) {
  try {
    git(w.r, 'branch', 'side')
    state.moved = true
  } catch (e) {
    state.error = e
  }
}

const addBigTest = (r) => {
  mkdirSync(join(r, 'test', 'big'))
  writeFileSync(join(r, 'test', 'big', 'add.test.mjs'), BIG_TEST)
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'a big test')
}

const addOne = (id, extra) => leaf(id, { rigor: 'trivial', locus: ['src/add.mjs'], ...extra })

// ------------------------------------------------------------------ shared batches
// A bisect costs three measurements: the tests that read one batch share it, built once and removed
// when the file ends. A test that runs a shared batch again comes after every test that reads it.

let bisectedP
/** x breaks the suite alone, y does not; x has been dispatched twice. */
const bisected = () => (bisectedP ??= (async () => {
  const w = world(after, [root(), addOne('x'), leaf('y', { rigor: 'trivial', locus: ['README.md'] })])
  const x = ready(w, 'x', { 'src/add.mjs': BREAK_ADD }, 'Break add')
  dispatch(w, 'x', 2)
  const y = ready(w, 'y', { 'README.md': 'hello world\n' }, 'Greet the world')
  const pre = headOf(w.r, '.')
  const children = handed(x, y)
  const out = await batch(w, children)
  return { w, x, y, pre, children, out }
})())

let passingP
/** x passes: the one leaf of the root, merged. */
const passing = () => (passingP ??= (async () => {
  const w = world(after, [root(), addOne('x')])
  const x = ready(w, 'x', { 'src/add.mjs': FLIP_ADD }, 'Add in the other order')
  const pre = headOf(w.r, '.')
  const children = handed(x)
  const out = await batch(w, children)
  return { w, x, pre, children, out }
})())

// ================================================================== merging

test('children merge in dependency order, whatever order they are handed in', SLOW, async (t) => {
  const w = world(inTest(t), [root(),
    leaf('x', { rigor: 'trivial', locus: ['x.txt'] }),
    leaf('y', { rigor: 'trivial', locus: ['y.txt'], deps: ['x'] })])
  const x = ready(w, 'x', { 'x.txt': 'x\n' }, 'Add x')
  const y = ready(w, 'y', { 'y.txt': 'y\n' }, 'Add y')
  const pre = headOf(w.r, '.')
  const out = await batch(w, handed(y, x))

  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.deepEqual(ids(out.merged), ['x', 'y'])
  assert.deepEqual(kindOf(eventsOf(w.r), 'merged').map((e) => e.node), ['x', 'y'])
  const merges = git(w.r, 'rev-list', '--first-parent', '--merges', '--reverse', pre + '..' + out.head_sha).split('\n').filter(Boolean)
  assert.deepEqual(merges.map((c) => git(w.r, 'rev-parse', c + '^2')), [x.head_sha, y.head_sha], 'the second parents of the merges, oldest first')
  assert.deepEqual(out.merged.map((m) => m.merged_sha), merges, 'each child at its own merge commit')
})

test('a cycle merges through its tip in one merge, and every member is recorded merged at that sha', SLOW, async (t) => {
  const w = world(inTest(t), [root(),
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], locus: ['src/r.mjs'] })])
  const r = ready(w, 'r', { 'test/r.test.mjs': R_TEST }, 'Pin r')
  const g = ready(w, 'g', { 'src/r.mjs': 'export const r = () => 1\n' }, 'Implement r', { from: r.head_sha, cycleMember: true })
  const pre = headOf(w.r, '.')
  const out = await mergeBatch(w.xc, { target: '.', children: handed(r, g), cycles: [['r', 'g']] })

  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.deepEqual(ids(out.merged), ['r', 'g'])
  const sha = out.merged[1].merged_sha
  assert.equal(out.merged[0].merged_sha, sha, 'one merge for the cycle')
  assert.equal(git(w.r, 'rev-parse', sha + '^2'), g.head_sha, 'its second parent is the tip')
  assert.deepEqual(git(w.r, 'rev-list', '--first-parent', '--merges', pre + '..' + out.head_sha).split('\n').filter(Boolean), [sha], 'one merge commit in all')
  const events = kindOf(eventsOf(w.r), 'merged')
  assert.deepEqual(events.map((e) => e.node), ['r', 'g'])
  assert.deepEqual(events.map((e) => e.merged_sha), [sha, sha])
})

test('the merged head is measured with the fast suite, through measure', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('a')], { commands: SPLIT, prepare: addBigTest })
  const a = ready(w, 'a', { 'src/add.mjs': BREAK_BIG }, 'Break only the big test')
  const out = await batch(w, handed(a))

  assert.equal(out.verified, true, 'the fast suite does not run the big test')
  assert.equal(readJson(out.drift_record).measurement.suite_scope, 'fast')
  const seen = kindOf(journalOf(w.r), 'verify-observed', '.')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].suite_scope, 'fast')
  assert.equal(typeof seen[0].key, 'string')
  assert.notEqual(seen[0].key, '')
})

test('the merged head is measured with the full suite where the tests are not split', SLOW, async () => {
  const { out } = await passing()
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(readJson(out.drift_record).measurement.suite_scope, 'full')
})

test('a red merged head is bisected: the leaf failing alone is named, the rest merge', SLOW, async () => {
  const { w, out } = await bisected()

  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.status, 'done')
  assert.deepEqual(ids(out.merged), ['y'])
  assert.deepEqual(ids(out.failed_alone), ['x'])
  assert.equal(out.verified, true, 'what merged is green')
  assert.equal(readJson(out.drift_record).failed_alone[0].failures[0].check, 'suite', 'what failed, and how, stays on disk')
  assert.deepEqual(out.stops, [], 'a leaf failing alone is no stop: it gets a fix round')
  assert.equal(statusOf(w.r, 'x'), 'active')
  assert.equal(statusOf(w.r, 'y'), 'merged')
})

test('a merged leaf loses its worktree and keeps its branch; a leaf failing alone keeps both', SLOW, async () => {
  const { w, x, y, out } = await bisected()
  assert.deepEqual(ids(out.merged), ['y'])

  assert.equal(existsSync(y.worktree), false)
  assert.equal(worktrees(w.r).has(posix(y.worktree)), false, 'git lists it no more')
  assert.equal(git(w.r, 'rev-parse', y.branch), y.head_sha, 'the branch stays at its head')
  assert.equal(existsSync(x.worktree), true)
  assert.equal(worktrees(w.r).has(posix(x.worktree)), true)
  assert.equal(git(x.worktree, 'rev-parse', 'HEAD'), x.head_sha, 'the fix round works where it worked')
  assert.equal(git(w.r, 'rev-parse', x.branch), x.head_sha)
})

test("a merge releases the merged leaves' locus locks and keeps the others'", SLOW, async () => {
  const { w, out } = await bisected()
  assert.deepEqual(ids(out.merged), ['y'])
  const held = heldBy(w.r).locus.filter((l) => l.effort === E)
  assert.deepEqual(held.map((l) => l.node), ['x'])
})

test('a batch records batch-started, merged, merge-observed and its batch line', SLOW, async () => {
  const { w, x, y, pre, out } = await bisected()
  const state = stateOf(w.r)
  const events = eventsOf(w.r)
  const journal = journalOf(w.r)

  const started = kindOf(state, 'batch-started')
  assert.equal(started.length, 1)
  assert.equal(started[0].target, '.')
  assert.equal(started[0].pre, pre)
  assert.deepEqual([...started[0].children].sort(), ['x', 'y'])

  const merged = kindOf(events, 'merged')
  assert.equal(merged.length, 1, 'one merged event, of the merged leaf')
  assert.equal(merged[0].node, 'y')
  assert.equal(merged[0].into, branchOf(E, '.'))
  assert.equal(merged[0].merged_sha, out.merged[0].merged_sha)
  assert.equal(merged[0].head_sha, y.head_sha, 'the child\'s approved head')
  assert.equal(merged[0].execution, STAMP)

  const observed = kindOf(journal, 'merge-observed')
  assert.equal(observed.length, 1)
  assert.equal(observed[0].node, 'y')
  assert.equal(observed[0].branch, branchOf(E, 'y'))
  assert.equal(observed[0].into, branchOf(E, '.'))
  assert.equal(observed[0].merged_sha, out.merged[0].merged_sha)
  assert.equal(observed[0].head_sha, headOf(w.r, '.'), 'the integration head')

  const lines = kindOf(state, 'batch')
  assert.equal(lines.length, 1)
  const line = lines[0]
  assert.deepEqual(
    { target: line.target, merged: line.merged, head_sha: line.head_sha, verified: line.verified, failed_alone: line.failed_alone, combination: line.combination, conflict: line.conflict },
    { target: '.', merged: ['y'], head_sha: out.head_sha, verified: true, failed_alone: [x.id], combination: [], conflict: '' })
  assert.ok(started[0].seq < line.seq, 'the batch line follows batch-started')
  assert.ok(line.seq < merged[0].seq && line.seq < observed[0].seq, 'and lands before the merged and merge-observed lines')
  assert.equal(out.head_sha, headOf(w.r, '.'), 'the return\'s head is the integration branch\'s')
})

test('a leaf failing alone is sent its failures from integration for its next round, once', SLOW, async () => {
  const { w, children, out } = await bisected()
  assert.deepEqual(ids(out.failed_alone), ['x'])
  const rounds = kindOf(eventsOf(w.r), 'dispatched', 'x').map((e) => e.round)
  const latest = Math.max(...rounds)
  assert.ok(latest >= 2, 'the fixture dispatched x more than once')

  const sent = () => kindOf(eventsOf(w.r), 'message')
  assert.equal(sent().length, 1, 'one message in all: the merged leaf is sent none')
  const m = sent()[0]
  assert.equal(m.node, 'x')
  assert.equal(m.thread, 'producer:x')
  assert.equal(m.from, 'code')
  assert.equal(m.msg, 'failures')
  assert.equal(m.round, latest + 1, 'one past its latest dispatched round')
  assert.equal(m.payload.source, 'integration')
  assert.equal(m.payload.failures[0].check, 'suite')
  for (const f of m.payload.failures) assert.deepEqual(Object.keys(f).sort(), ['check', 'claim', 'evidence'])

  const again = await batch(w, children)
  assert.deepEqual(ids(again.failed_alone), ['x'], 'still failing alone')
  assert.equal(sent().length, 1, 'and not sent the same words twice')
})

test('merged children leave their composite to its review', SLOW, async () => {
  const { w, out } = await passing()
  assert.deepEqual(ids(out.merged), ['x'])
  assert.equal(statusOf(w.r, 'x'), 'merged')
  assert.equal(statusOf(w.r, '.'), 'reviewing')
})

// ================================================================== what stops

test('children that pass alone and fail together are a combination failure, and nothing merges', SLOW, async (t) => {
  const w = world(inTest(t), [root(), leaf('p', { rigor: 'trivial', locus: ['p.txt'] }), leaf('q', { rigor: 'trivial', locus: ['q.txt'] })], {
    prepare: (r) => {
      writeFileSync(join(r, 'test', 'pair.test.mjs'), PAIR_TEST)
      git(r, 'add', '-A')
      git(r, 'commit', '-q', '-m', 'pair rule')
    },
  })
  const p = ready(w, 'p', { 'p.txt': 'p\n' }, 'Add p')
  const q = ready(w, 'q', { 'q.txt': 'q\n' }, 'Add q')
  const pre = headOf(w.r, '.')
  const out = await batch(w, handed(p, q))

  assert.deepEqual(stopsOf(out).sort(), [['p', 'escalated', 'combination_failure'], ['q', 'escalated', 'combination_failure']])
  assert.deepEqual(['p', 'q'].map((id) => statusOf(w.r, id)), ['escalated', 'escalated'], 'recorded by the batch that saw it')
  assert.deepEqual(out.merged, [])
  assert.equal(headOf(w.r, '.'), pre)
  assert.equal(out.head_sha, pre)
  assert.equal(git(worktreeOf(w.r, E, '.'), 'rev-parse', 'HEAD'), pre)
})

test('a composite failing alone on the merged head escalates fails_on_integration', SLOW, async (t) => {
  const w = world(inTest(t), [root(),
    { id: 'c', kind: 'composite', title: 'part', author: 'planner', decisions: ['D1'], acceptance: [{ text: 'c works', check: 'node --test', decisions: ['D1'] }] },
    leaf('c/z', { rigor: 'trivial', locus: ['src/z.mjs'] })])
  const integ = integrationOf(w, 'c')
  const head = commitIn(integ.worktree, { 'src/add.mjs': BREAK_ADD }, 'Break add')
  const out = await batch(w, [{ id: 'c', head_sha: head }])

  assert.deepEqual(stopsOf(out), [['c', 'escalated', 'fails_on_integration']])
  assert.deepEqual(out.failed_alone, [], 'no one producer to send a fix round to')
  assert.deepEqual(out.merged, [])
  assert.equal(statusOf(w.r, 'c'), 'escalated')
  assert.deepEqual(kindOf(eventsOf(w.r), 'message'), [], 'and no message')
})

test('a cycle failing alone on the merged head escalates every member fails_on_integration', SLOW, async (t) => {
  const w = world(inTest(t), [root(),
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], locus: ['src/r.mjs'] })])
  const r = ready(w, 'r', { 'test/r.test.mjs': R_TEST }, 'Pin r')
  const g = ready(w, 'g', { 'src/r.mjs': 'export const r = () => 2\n' }, 'Implement r wrongly', { from: r.head_sha, cycleMember: true })
  const out = await mergeBatch(w.xc, { target: '.', children: handed(r, g), cycles: [['r', 'g']] })

  assert.deepEqual(stopsOf(out).sort(), [['g', 'escalated', 'fails_on_integration'], ['r', 'escalated', 'fails_on_integration']])
  assert.deepEqual(['r', 'g'].map((id) => statusOf(w.r, id)), ['escalated', 'escalated'])
  assert.deepEqual(out.failed_alone, [])
  assert.deepEqual(out.merged, [])
})

test('a conflict escalates merge_conflict naming the paths; what merged before it stays merged', SLOW, async (t) => {
  const w = world(inTest(t), [root(),
    leaf('m', { rigor: 'trivial', locus: ['README.md'] }),
    leaf('n', { rigor: 'trivial', locus: ['NOTES.md'], deps: ['m'] })])
  const m = ready(w, 'm', { 'README.md': 'from m\n' }, 'Say m')
  // n declared a disjoint locus and wrote README.md anyway: the plan was wrong about independence.
  const n = ready(w, 'n', { 'README.md': 'from n\n' }, 'Say n')
  const out = await batch(w, handed(m, n))

  assert.deepEqual(ids(out.merged), ['m'])
  assert.deepEqual(stopsOf(out), [['n', 'escalated', 'merge_conflict']])
  assert.equal(statusOf(w.r, 'm'), 'merged')
  assert.equal(statusOf(w.r, 'n'), 'escalated')
  assert.ok(readTree(w.r, E).status.get('n').last.detail.includes('README.md'), 'the record names the conflicting path')
  assert.equal(out.head_sha, headOf(w.r, '.'))
})

test('a batch that merged nothing and saw nothing fail escalates merge_no_progress', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('x')])
  integrationOf(w)
  const out = await batch(w, [])
  assert.deepEqual(stopsOf(out), [['.', 'escalated', 'merge_no_progress']])
  assert.equal(statusOf(w.r, '.'), 'escalated')
})

test('a batch that cannot run escalates merge_batch_failed, once', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('x')])
  const x = ready(w, 'x', { 'src/add.mjs': FLIP_ADD }, 'Add in the other order')
  takeWorktree(w, integrationOf(w))

  const first = await batch(w, handed(x))
  const second = await batch(w, handed(x))
  for (const out of [first, second]) {
    assert.equal(out.ok, true)
    assert.equal(out.status, 'stopped')
    assert.deepEqual(stopsOf(out), [['.', 'escalated', 'merge_batch_failed']])
    assert.deepEqual(out.merged, [])
  }
  assert.equal(kindOf(eventsOf(w.r), 'escalated').length, 1, 'one escalation in all')
  assert.deepEqual(kindOf(stateOf(w.r), 'batch-started'), [])
  assert.notEqual(statusOf(w.r, 'x'), 'merged')
})

// ================================================================== run again

test('a batch started and never finished is reset to where it started and done again', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('x')])
  const x = ready(w, 'x', { 'src/add.mjs': BREAK_ADD }, 'Break add')
  // The kill: the batch started and the merge landed; nothing was measured or recorded.
  const wt = integrationOf(w).worktree
  const pre = git(wt, 'rev-parse', 'HEAD')
  w.xc.log.append('batch-started', { target: '.', pre, children: ['x'] })
  git(wt, 'merge', '--no-ff', '--no-edit', x.branch)
  assert.notEqual(git(wt, 'rev-parse', 'HEAD'), pre)

  const out = await batch(w, handed(x))
  assert.deepEqual(out.merged, [], 'the red merge is not recorded as landed')
  assert.deepEqual(ids(out.failed_alone), ['x'])
  assert.equal(out.head_sha, pre)
  assert.equal(headOf(w.r, '.'), pre)
  assert.notEqual(statusOf(w.r, 'x'), 'merged')
})

test('a batch run again after its outcome merges nothing twice', SLOW, async () => {
  const { w, children, out } = await passing()
  assert.deepEqual(out.stops, [])
  const again = await batch(w, children)

  assert.equal(again.ok, true)
  assert.equal(again.head_sha, out.head_sha)
  assert.deepEqual(again.stops, [])
  assert.equal(kindOf(eventsOf(w.r), 'merged').length, 1)
  assert.equal(kindOf(journalOf(w.r), 'merge-observed').length, 1)
  assert.equal(kindOf(stateOf(w.r), 'batch-started').length, 1)
  assert.equal(kindOf(stateOf(w.r), 'batch').length, 1)
})

test('a batch killed after its outcome and before its merged events records them when run again', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('x')])
  const x = ready(w, 'x', { 'src/add.mjs': FLIP_ADD }, 'Add in the other order')
  const first = await batch(w, handed(x))
  assert.deepEqual(ids(first.merged), ['x'])
  const head = headOf(w.r, '.')

  // The kill: the batch line landed, the merged events did not.
  const path = fileFor(w.r, E, 'events').path
  const kept = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() && JSON.parse(line).kind !== 'merged')
  writeFileSync(path, kept.map((line) => line + '\n').join(''))
  assert.equal(kindOf(eventsOf(w.r), 'merged').length, 0)
  w.xc = ctxOf(w.r)

  const again = await batch(w, handed(x))
  assert.equal(again.ok, true)
  assert.equal(headOf(w.r, '.'), head, 'no reset')
  assert.equal(kindOf(eventsOf(w.r), 'merged', 'x').length, 1)
  assert.equal(statusOf(w.r, 'x'), 'merged')
  assert.equal(kindOf(stateOf(w.r), 'batch-started').length, 1)
})

// ================================================================== drift

/** A provider p that merges README.md, and a pending consumer c of it. */
const driftWorld = (t) => world(inTest(t), [root(),
  leaf('p', { rigor: 'trivial', locus: ['README.md'] }),
  leaf('c', { rigor: 'trivial', locus: ['src/use.mjs'], consumes: [{ name: 'docs', paths: ['README.md'] }] })])

test('a merge under a contract a pending node consumes writes the drift record and one ruler brief', SLOW, async (t) => {
  const w = driftWorld(t)
  const p = ready(w, 'p', { 'README.md': 'hello world\n' }, 'Greet the world')
  const out = await batch(w, handed(p))

  assert.deepEqual(out.drift, [{ node: 'c', contract: 'docs', stopped: '' }])
  const record = readJson(out.drift_record)
  assert.equal(record.drift.length, 1)
  assert.equal(record.drift[0].node, 'c')
  assert.equal(record.drift[0].contract, 'docs')
  assert.deepEqual(record.drift[0].files, ['README.md'])
  assert.equal(record.head_sha, out.head_sha)
  assert.equal(out.drift_brief, out.drift_record.replace(/\.json$/, '.drift.md'))

  const brief = readFileSync(out.drift_brief, 'utf8')
  assert.match(brief, /^# c — do c$/m, 'the node\'s heading')
  assert.ok(brief.includes('contract docs (README.md)'), 'the contract with its files')
  assert.ok(brief.includes('- docs: README.md'), 'the consumed contract')
  assert.ok(brief.includes('- c works'), 'the criterion')
  assert.ok(brief.includes(branchOf(E, '.')), 'the integration branch')
  assert.match(brief, /^\+hello world$/m, 'the diff')
})

test("a stopped consumer's drift is recorded and briefed to no ruler", SLOW, async (t) => {
  const w = driftWorld(t)
  const p = ready(w, 'p', { 'README.md': 'hello world\n' }, 'Greet the world')
  w.xc.log.append('escalated', { node: 'c', reason: 'blocked' })
  const out = await batch(w, handed(p))

  assert.deepEqual(out.drift, [{ node: 'c', contract: 'docs', stopped: 'escalated' }])
  assert.equal(out.drift_brief, '')
  assert.equal(existsSync(out.drift_record.replace(/\.json$/, '.drift.md')), false, 'no brief is written')
  const record = readJson(out.drift_record)
  assert.deepEqual(record.drift.map((d) => [d.node, d.contract, d.stopped]), [['c', 'docs', 'escalated']])
})

test('drift: a landed diff under a contract a pending node consumes is flagged; its own provider is not', SLOW, async (t) => {
  const r = repo()
  t.after(() => rm(r))
  const seeded = seedTree(r, E, [root(),
    leaf('p', { rigor: 'trivial', locus: ['src/api.mjs'], provides: [{ name: 'api', paths: ['src/api.mjs'] }] }),
    leaf('c', { rigor: 'trivial', locus: ['src/use.mjs'], consumes: [{ name: 'api', paths: ['src/api.mjs'] }], deps: ['p'] }),
    leaf('x', { rigor: 'trivial', locus: ['src/other.mjs'] }),
    leaf('d', { rigor: 'trivial', locus: ['src/d.mjs'], consumes: [{ name: 'shape', paths: ['src/shape/'] }] }),
    { id: 'later', kind: 'design', title: 'later part' }])
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems))

  const tree = readTree(r, E)
  const out = driftOf(tree, ['x'], ['src/other.mjs', 'src/shape/one.mjs', 'src/api.mjs'])
  assert.deepEqual(out.drift.map((d) => [d.node, d.contract]).sort(), [['c', 'api'], ['d', 'shape']], 'a prefix ending in a slash covers the files under it')
  assert.equal(out.unexamined, 1, 'a childless design node with no contracts is unexamined')
  assert.deepEqual(driftOf(tree, ['p'], ['src/api.mjs']).drift, [], 'the provider landing its own contract is expected work')

  const log = executionLog(r, E, STAMP)
  log.append('escalated', { node: 'c', reason: 'blocked' })
  const stopped = driftOf(readTree(r, E), ['x'], ['src/api.mjs']).drift
  assert.deepEqual(stopped, [{ node: 'c', contract: 'api', files: ['src/api.mjs'], stopped: 'escalated' }], 'a stopped consumer is reported, marked, never skipped')
})

// ================================================================== the event loop and the checkout

test('the event loop runs while the merge measures', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('x')])
  const x = ready(w, 'x', { 'src/add.mjs': FLIP_ADD }, 'Add in the other order')
  let ticks = 0
  const timer = setInterval(() => {
    const state = stateOf(w.r)
    if (kindOf(state, 'batch-started').length > 0 && kindOf(state, 'batch').length === 0) ticks++
  }, 5)
  let out
  try {
    out = await batch(w, handed(x))
  } finally {
    clearInterval(timer)
  }
  assert.equal(out.status, 'done')
  assert.equal(kindOf(stateOf(w.r), 'batch').length, 1)
  assert.ok(ticks >= 2, 'a timer ticked between batch-started and the batch line: ' + ticks)
})

test('a checkout moved while the merge measured is a checkout fault on the target, and nothing is decided', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('x')])
  const x = ready(w, 'x', { 'src/add.mjs': FLIP_ADD }, 'Add in the other order')
  const pre = headOf(w.r, '.')
  const seen = { moved: false, error: null }
  const timer = setInterval(() => {
    if (!seen.moved && !seen.error && kindOf(stateOf(w.r), 'batch-started').length > 0) {
      clearInterval(timer)
      moveCheckout(w, seen)
    }
  }, 5)
  let out
  try {
    out = await batch(w, handed(x))
  } finally {
    clearInterval(timer)
  }
  assert.equal(seen.error, null)
  assert.equal(seen.moved, true, 'the checkout moved during the measurement')

  assert.equal(out.status, 'held')
  assert.deepEqual(stopsOf(out), [['.', 'held', 'checkout']])
  assert.deepEqual(out.merged, [])
  const faults = kindOf(stateOf(w.r), 'fault')
  assert.equal(faults.length, 1)
  assert.equal(faults[0].node, '.')
  assert.equal(faults[0].channel, 'checkout')
  assert.deepEqual(kindOf(eventsOf(w.r), 'merged'), [])
  assert.deepEqual(kindOf(stateOf(w.r), 'batch'), [], 'no batch line')
  assert.equal(kindOf(stateOf(w.r), 'batch-started').length, 1, 'batch-started stays open')
  assert.equal(headOf(w.r, '.'), pre, 'the integration branch is back where the batch started')
  assert.equal(git(worktreeOf(w.r, E, '.'), 'rev-parse', 'HEAD'), pre)
})

// ================================================================== refusals

test('merge-batch refuses a target that is no composite', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('x')])
  for (const target of ['x', 'nope']) {
    const out = await mergeBatch(w.xc, { target, children: [], cycles: [] })
    assert.equal(out.ok, false, target)
    assert.equal(out.error.kind, 'not_a_composite', target)
    assert.deepEqual(out.stops, [], target)
  }
  assert.deepEqual(kindOf(eventsOf(w.r), 'escalated'), [], 'a refusal records nothing')
})

test('merge-batch refuses an execution with no envelope', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('x')], { envelope: false })
  const out = await batch(w, [])
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'no_execution')
  assert.deepEqual(out.stops, [])
  assert.deepEqual(kindOf(eventsOf(w.r), 'escalated'), [])
})

// ================================================================== the suite gate

/** A split suite whose integration head breaks only the big test: `{w, integ, head}`. */
function brokenGate(t, nodes = [root(), addOne('a')]) {
  const w = world(inTest(t), nodes, { commands: SPLIT, prepare: addBigTest })
  const integ = integrationOf(w)
  const head = commitIn(integ.worktree, { 'src/add.mjs': BREAK_BIG }, 'Break only the big test')
  return { w, integ, head }
}
const gateLines = (r) => kindOf(stateOf(r), 'gate')

test('the gate runs the full suite on the integration head and escalates fails_full_suite', SLOW, async (t) => {
  const { w, head } = brokenGate(t)
  const out = await suiteGate(w.xc, { target: '.' })

  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.status, 'done')
  assert.equal(out.ran, true)
  assert.equal(out.passed, false)
  assert.equal(out.head_sha, head)
  assert.equal(out.head_sha, headOf(w.r, '.'))
  assert.deepEqual(stopsOf(out), [['.', 'escalated', 'fails_full_suite']])
  const record = readJson(out.record)
  assert.equal(record.measurement.suite_scope, 'full')
  assert.equal(record.base, w.base, 'the head the branch was cut from')
  const lines = gateLines(w.r)
  assert.equal(lines.length, 1)
  assert.deepEqual({ target: lines[0].target, head_sha: lines[0].head_sha, passed: lines[0].passed }, { target: '.', head_sha: head, passed: false })
  const seen = kindOf(journalOf(w.r), 'verify-observed', '.')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].suite_scope, 'full')
  assert.equal(typeof seen[0].key, 'string')
  assert.notEqual(seen[0].key, '')
})

test('a failing gate is asked again', SLOW, async (t) => {
  const { w } = brokenGate(t)
  const first = await suiteGate(w.xc, { target: '.' })
  const second = await suiteGate(w.xc, { target: '.' })

  assert.equal(second.ran, true)
  assert.equal(second.passed, false)
  assert.equal(second.head_sha, first.head_sha)
  assert.deepEqual(stopsOf(second), [['.', 'escalated', 'fails_full_suite']])
  const escalations = kindOf(eventsOf(w.r), 'escalated', '.').filter((e) => e.reason === 'fails_full_suite')
  assert.equal(escalations.length, 1, 'one escalation in all')
})

test('a passing gate is recorded against its head and not run again there', SLOW, async (t) => {
  const { w, integ, head } = brokenGate(t)
  const failed = await suiteGate(w.xc, { target: '.' })
  assert.equal(failed.passed, false)

  const mended = commitIn(integ.worktree, { 'src/add.mjs': MEND_ADD }, 'Mend the big test')
  assert.notEqual(mended, head)
  const passed = await suiteGate(w.xc, { target: '.' })
  assert.equal(passed.ran, true)
  assert.equal(passed.passed, true, JSON.stringify(passed.stops))
  assert.deepEqual(passed.stops, [])
  assert.equal(passed.head_sha, mended, 'the head it moved to is the one measured')
  assert.ok(gateLines(w.r).some((e) => e.target === '.' && e.head_sha === mended && e.passed === true))

  const measured = kindOf(journalOf(w.r), 'verify-observed', '.').length
  const again = await suiteGate(w.xc, { target: '.' })
  assert.equal(again.ran, false)
  assert.equal(again.passed, true)
  assert.equal(again.head_sha, mended)
  assert.equal(kindOf(journalOf(w.r), 'verify-observed', '.').length, measured, 'no new measurement')
})

test('the gate runs nothing where the repository does not split its tests', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('a')])
  const integ = integrationOf(w)
  const out = await suiteGate(w.xc, { target: '.' })

  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.ran, false)
  assert.equal(out.passed, true)
  assert.equal(out.record, '')
  assert.equal(out.review, 'earned')
  assert.equal(out.head_sha, integ.head)
  assert.equal(out.head_sha, headOf(w.r, '.'))
  assert.deepEqual(journalOf(w.r), [], 'nothing journalled')
  assert.deepEqual(kindOf(eventsOf(w.r), 'claims'), [], 'no claims recorded')
})

test('a passing gate records claims not_earned when the review is not earned, once', SLOW, async (t) => {
  const w = world(inTest(t), [root(),
    { id: 'c', kind: 'composite', title: 'part', author: 'planner', decisions: ['D1'], acceptance: [{ text: 'c works', check: 'node --test', decisions: ['D1'] }] },
    leaf('c/v', { rigor: 'verify' })])
  integrationOf(w, 'c')
  const first = await suiteGate(w.xc, { target: 'c' })
  const second = await suiteGate(w.xc, { target: 'c' })

  for (const out of [first, second]) {
    assert.equal(out.ok, true, JSON.stringify(out.error))
    assert.equal(out.passed, true)
    assert.equal(out.review, 'not_earned')
  }
  const claims = kindOf(eventsOf(w.r), 'claims', 'c')
  assert.equal(claims.length, 1, 'one in all')
  assert.equal(claims[0].head_sha, headOf(w.r, 'c'))
  assert.equal(claims[0].review, 'not_earned')
  assert.deepEqual(claims[0].claims, [])
})

test('a gate that cannot attach its worktree escalates suite_gate_failed', SLOW, async (t) => {
  const { w, integ } = brokenGate(t)
  takeWorktree(w, integ)
  const out = await suiteGate(w.xc, { target: '.' })

  assert.equal(out.status, 'stopped')
  assert.deepEqual(stopsOf(out), [['.', 'escalated', 'suite_gate_failed']])
  assert.deepEqual(gateLines(w.r), [], 'no gate line')
})

test('a checkout moved while the gate measured is a checkout fault, and no gate line', SLOW, async (t) => {
  const { w } = brokenGate(t)
  const seen = { moved: false, error: null }
  const call = suiteGate(w.xc, { target: '.' })
  // Everything the gate does before its measurement's child is synchronous: the timer fires after it.
  const timer = setTimeout(() => moveCheckout(w, seen), 0)
  let out
  try {
    out = await call
  } finally {
    clearTimeout(timer)
  }
  assert.equal(seen.error, null)
  assert.equal(seen.moved, true)

  assert.equal(out.status, 'held')
  assert.deepEqual(stopsOf(out), [['.', 'held', 'checkout']])
  const faults = kindOf(stateOf(w.r), 'fault')
  assert.equal(faults.length, 1)
  assert.equal(faults[0].node, '.')
  assert.equal(faults[0].channel, 'checkout')
  assert.deepEqual(gateLines(w.r), [], 'no gate line')
  assert.deepEqual(kindOf(eventsOf(w.r), 'escalated'), [], 'no escalation')
})

test('suite-gate refuses a target that is no composite, and one with no integration branch', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('a'),
    { id: 'c', kind: 'composite', title: 'part', author: 'planner', decisions: ['D1'], acceptance: [{ text: 'c works', check: 'node --test', decisions: ['D1'] }] },
    leaf('c/z', { rigor: 'trivial', locus: ['src/z.mjs'] })])
  const notComposite = await suiteGate(w.xc, { target: 'a' })
  assert.equal(notComposite.ok, false)
  assert.equal(notComposite.error.kind, 'not_a_composite')
  assert.deepEqual(notComposite.stops, [])

  const uncut = await suiteGate(w.xc, { target: 'c' })
  assert.equal(uncut.ok, false)
  assert.equal(uncut.error.kind, 'no_integration')
  assert.deepEqual(uncut.stops, [])
  assert.deepEqual(kindOf(eventsOf(w.r), 'escalated'), [], 'a refusal records nothing')
})
