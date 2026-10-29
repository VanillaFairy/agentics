// test/boundaries-merge-stops.test.mjs — lib/boundaries/merge.mjs: what stops a batch, a batch
// killed and run again, and the drift it records, in process, over real git and the real
// measurement.
//
// What is pinned here:
//
//   mergeBatch  what stops (a composite or a cycle failing alone, a conflict, no progress, a batch
//               that cannot run); a batch run again after each point it can be killed at; the
//               drift record and the ruler's brief; the event loop running while the merge
//               measures; the user's checkout moving during a measurement (a checkout fault,
//               nothing decided); the refusals
//   driftOf     (pure) what a landed diff touched under a contract a pending node consumes
//
// Every repository is built with the fixture's seeding helpers; preflight and leaf-open are stood
// in for by the lib calls they make (`execution.json`, `acquireAsync`, `ensureIntegration`,
// `ensureLeaf`, a `dispatched` event). Expected heads, branches, rounds and record paths are
// computed. The worlds the parts share are in test/harness/merge-world.mjs.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#merging, docs/DESIGN.md#landing-and-drift.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { driftOf, mergeBatch } from '../lib/boundaries/merge.mjs'
import { append as appendTo, executionLog, fileFor } from '../lib/ledger.mjs'
import { branchOf, readJson, worktreeOf } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { STAMP, commitIn, git, leaf, repo, root } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import {
  E, SLOW, BREAK_ADD, FLIP_ADD, R_TEST, rm, inTest, ctxOf, stateOf, eventsOf, headOf, statusOf, ids, stopsOf,
  kindOf, world, integrationOf, ready, handed, batch, takeWorktree, moveCheckout, addOne,
} from './harness/merge-world.mjs'

const PAIR_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { existsSync } from 'node:fs'\ntest('not both', () => assert.ok(!(existsSync('p.txt') && existsSync('q.txt'))))\n"

// ================================================================== what stops

test('children that pass alone and fail together are a combination failure, and nothing merges', SLOW, async (t) => {
  const w = world(inTest(t), [root(), leaf('p', { rigor: 'trivial', expects: ['p.txt'] }), leaf('q', { rigor: 'trivial', expects: ['q.txt'] })], {
    prepare: (r) => {
      writeFileSync(join(r, 'test', 'pair.test.mjs'), PAIR_TEST)
      git(r, 'add', '-A')
      git(r, 'commit', '-q', '-m', 'pair rule')
    },
  })
  const p = await ready(w, 'p', { 'p.txt': 'p\n' }, 'Add p')
  const q = await ready(w, 'q', { 'q.txt': 'q\n' }, 'Add q')
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
    leaf('c/z', { rigor: 'trivial', expects: ['src/z.mjs'] })])
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
    leaf('r', { rigor: 'tdd-pair', role: 'red', expects: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], expects: ['src/r.mjs'] })])
  const r = await ready(w, 'r', { 'test/r.test.mjs': R_TEST }, 'Pin r')
  const g = await ready(w, 'g', { 'src/r.mjs': 'export const r = () => 2\n' }, 'Implement r wrongly', { from: r.head_sha, cycleMember: true })
  const out = await mergeBatch(w.xc, { target: '.', children: handed(r, g), cycles: [['r', 'g']] })

  assert.deepEqual(stopsOf(out).sort(), [['g', 'escalated', 'fails_on_integration'], ['r', 'escalated', 'fails_on_integration']])
  assert.deepEqual(['r', 'g'].map((id) => statusOf(w.r, id)), ['escalated', 'escalated'])
  assert.deepEqual(out.failed_alone, [])
  assert.deepEqual(out.merged, [])
})

test('a conflict of a leaf with a shell is handed back for the judge, naming the paths; what merged before it stays merged', SLOW, async (t) => {
  const w = world(inTest(t), [root(),
    leaf('m', { rigor: 'trivial', expects: ['README.md'] }),
    leaf('n', { rigor: 'trivial', expects: ['NOTES.md'], deps: ['m'] })])
  const m = await ready(w, 'm', { 'README.md': 'from m\n' }, 'Say m')
  // n and the merged leaf both changed README.md: the merge conflicts.
  const n = await ready(w, 'n', { 'README.md': 'from n\n' }, 'Say n')
  const out = await batch(w, handed(m, n))

  assert.deepEqual(ids(out.merged), ['m'])
  assert.deepEqual(stopsOf(out), [], 'the user is not asked before the judge rules')
  assert.deepEqual(out.conflict, { id: 'n', head: n.head_sha, paths: ['README.md'] })
  assert.equal(statusOf(w.r, 'm'), 'merged')
  assert.notEqual(statusOf(w.r, 'n'), 'escalated')
  assert.equal(out.head_sha, headOf(w.r, '.'))
})

test('a conflict the first merge met stands through the bisect of a red head, and a shell-less leaf\'s escalates', SLOW, async (t) => {
  const w = world(inTest(t), [root(),
    leaf('m', { rigor: 'trivial', expects: ['src/add.mjs', 'README.md'] }),
    leaf('n', { rigor: 'tests-only', expects: ['NOTES.md'], deps: ['m'] })])
  // m breaks the suite, so the merged head is red and bisected; n wrote README.md, which m changed
  // too, so the first merge stopped at n, which no bisect measures.
  const m = await ready(w, 'm', { 'src/add.mjs': BREAK_ADD, 'README.md': 'from m\n' }, 'Break add, say m')
  const n = await ready(w, 'n', { 'README.md': 'from n\n' }, 'Say n')
  const out = await batch(w, handed(m, n))

  assert.deepEqual(ids(out.merged), [])
  assert.deepEqual(ids(out.failed_alone), ['m'], 'm fails alone and goes back to a fix round')
  assert.ok(stopsOf(out).some(([id, status, reason]) => id === 'n' && status === 'escalated' && reason === 'merge_conflict'), JSON.stringify(stopsOf(out)))
  assert.equal(statusOf(w.r, 'n'), 'escalated', 'a tests-only leaf has no shell to conclude a merge')
  assert.ok(readTree(w.r, E).status.get('n').last.detail.includes('README.md'), 'the record names the conflicting path')
  assert.equal(kindOf(stateOf(w.r), 'batch').at(-1).conflict, 'n')
})

test('a cycle whose tip conflicts on a file its implementer writes is handed to the judge, not escalated', SLOW, async (t) => {
  const w = world(inTest(t), [root(),
    leaf('m', { rigor: 'trivial', expects: ['src/r.mjs'] }),
    leaf('r', { rigor: 'tdd-pair', role: 'red', expects: ['test/r.test.mjs'], deps: ['m'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], expects: ['src/r.mjs'] })])
  const m = await ready(w, 'm', { 'src/r.mjs': 'export const r = () => 0\n' }, 'Seed r')
  const r = await ready(w, 'r', { 'test/r.test.mjs': R_TEST }, 'Pin r')
  const g = await ready(w, 'g', { 'src/r.mjs': 'export const r = () => 1\n' }, 'Implement r', { from: r.head_sha, cycleMember: true })
  const out = await mergeBatch(w.xc, { target: '.', children: handed(m, r, g), cycles: [['r', 'g']] })

  assert.deepEqual(ids(out.merged), ['m'])
  assert.deepEqual(stopsOf(out), [], 'the judge rules before anyone asks the user')
  assert.deepEqual(out.conflict, { id: 'g', head: g.head_sha, paths: ['src/r.mjs'] })
  assert.notEqual(statusOf(w.r, 'g'), 'escalated')
})

test('a conflict holds back its own unit and what is built on it; an unrelated sibling after it still merges', SLOW, async (t) => {
  const w = world(inTest(t), [root(),
    leaf('m', { rigor: 'trivial', expects: ['README.md'] }),
    leaf('n', { rigor: 'trivial', expects: ['README.md'], deps: ['m'] }),
    leaf('o', { rigor: 'trivial', expects: ['OTHER.md'], deps: ['m'] }),
    leaf('p', { rigor: 'trivial', expects: ['LATER.md'], deps: ['n'] })])
  const m = await ready(w, 'm', { 'README.md': 'from m\n' }, 'Say m')
  const n = await ready(w, 'n', { 'README.md': 'from n\n' }, 'Say n')
  const o = await ready(w, 'o', { 'OTHER.md': 'other\n' }, 'Say other')
  const later = await ready(w, 'p', { 'LATER.md': 'later\n' }, 'Say later', { from: n.head_sha })
  const out = await batch(w, handed(m, n, o, later))

  assert.deepEqual(ids(out.merged), ['m', 'o'], 'o neither conflicts nor is built on n')
  assert.deepEqual(out.conflict, { id: 'n', head: n.head_sha, paths: ['README.md'] })
  assert.equal(statusOf(w.r, 'o'), 'merged')
  assert.notEqual(statusOf(w.r, 'p'), 'merged', 'p is built on n, so it waits with it')
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
  const x = await ready(w, 'x', { 'src/add.mjs': FLIP_ADD }, 'Add in the other order')
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
  const x = await ready(w, 'x', { 'src/add.mjs': BREAK_ADD }, 'Break add')
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

test('a batch killed after its outcome and before its merged events records them when run again', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('x')])
  const x = await ready(w, 'x', { 'src/add.mjs': FLIP_ADD }, 'Add in the other order')
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
  leaf('p', { rigor: 'trivial', expects: ['README.md'] }),
  leaf('c', { rigor: 'trivial', expects: ['src/use.mjs'], consumes: [{ name: 'docs', paths: ['README.md'] }] })])

test('a merge under a contract a pending node consumes writes the drift record and one ruler brief', SLOW, async (t) => {
  const w = driftWorld(t)
  const p = await ready(w, 'p', { 'README.md': 'hello world\n' }, 'Greet the world')
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

/**
 * The user's ruling that c's contract is unaffected, as the records hold it: a ruler's affected
 * ruling at `head`, the `contract_drift` park on it, the answer, and the retry that cleared the park.
 */
function userRuledUnaffected(w, head) {
  w.xc.log.append('drift-ruled', { node: 'c', contract: 'docs', head_sha: head, ruling: 'affected', why: 'README now greets the world', said: 'r-drift' })
  w.xc.log.append('parked', { node: 'c', return: 'contract_drift', question: 'Does c still read README as it did?', said: 'r-drift' })
  appendTo(w.r, E, 'ledger', [{ kind: 'answered', asked: 1, nodes: ['c'], answers: [{ question: 'Does c still read README?', answer: 'USER_ANSWER_TOKEN: c never reads the greeting' }], by: 'user' }])
  w.xc.log.append('replanned', { node: 'c', reason: 'retry_escalated', by: 'session' })
}

test("drift on a contract the user ruled unaffected, over files that read as they did then, stands: no ruler is asked", SLOW, async (t) => {
  const w = driftWorld(t)
  const p = await ready(w, 'p', { 'README.md': 'hello world\n' }, 'Greet the world')
  userRuledUnaffected(w, p.head_sha)
  const out = await batch(w, handed(p))

  const retry = kindOf(eventsOf(w.r), 'replanned', 'c').at(-1)
  assert.deepEqual(out.drift, [{ node: 'c', contract: 'docs', stopped: '', standing: retry.seq }])
  assert.equal(out.drift_brief, '', 'no ruler brief')
  assert.equal(readJson(out.drift_record).drift[0].standing.by, 'user')
})

test('drift on a contract ruled unaffected whose files moved since is ruled again, handed that ruling and the answer', SLOW, async (t) => {
  const w = driftWorld(t)
  const p = await ready(w, 'p', { 'README.md': 'hello world\n' }, 'Greet the world')
  const before = headOf(w.r, '.')
  userRuledUnaffected(w, before)
  const out = await batch(w, handed(p))

  assert.deepEqual(out.drift, [{ node: 'c', contract: 'docs', stopped: '' }])
  const brief = readFileSync(out.drift_brief, 'utf8')
  assert.ok(brief.includes('Ruled before: at ' + before), 'the earlier ruling, at its head')
  assert.ok(brief.includes('USER_ANSWER_TOKEN: c never reads the greeting'), "the user's answer")
  assert.ok(brief.includes('README now greets the world'), "the ruler's why")
  assert.match(brief, /^\+hello world$/m, 'the change since the ruling')
})

test("a stopped consumer's drift is recorded and briefed to no ruler", SLOW, async (t) => {
  const w = driftWorld(t)
  const p = await ready(w, 'p', { 'README.md': 'hello world\n' }, 'Greet the world')
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
    leaf('p', { rigor: 'trivial', expects: ['src/api.mjs'], provides: [{ name: 'api', paths: ['src/api.mjs'] }] }),
    leaf('c', { rigor: 'trivial', expects: ['src/use.mjs'], consumes: [{ name: 'api', paths: ['src/api.mjs'] }], deps: ['p'] }),
    leaf('x', { rigor: 'trivial', expects: ['src/other.mjs'] }),
    leaf('d', { rigor: 'trivial', expects: ['src/d.mjs'], consumes: [{ name: 'shape', paths: ['src/shape/'] }] }),
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
  const x = await ready(w, 'x', { 'src/add.mjs': FLIP_ADD }, 'Add in the other order')
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
  assert.ok(ticks >= 1, 'a timer ticked between batch-started and the batch line: ' + ticks)
})

test('a checkout moved while the merge measured is a checkout fault on the target, and nothing is decided', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('x')])
  const x = await ready(w, 'x', { 'src/add.mjs': FLIP_ADD }, 'Add in the other order')
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
