// test/boundary-merge.test.mjs — lib/boundary.mjs against real git: merge-batch.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { append, readLog } from '../lib/ledger.mjs'
import { readTree } from '../lib/tree.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { worktreeOf } from '../lib/store.mjs'
import { B, COMMANDS, commitIn, git, leaf, repo, root, STAMP, wrote } from './harness/boundary-fixture.mjs'

test('a failing merged head is bisected: the leaf that fails alone is named, the rest merge', () => {
  const r = repo()
  seedTree(r, 'e1', [root(),
    leaf('x', { rigor: 'trivial', locus: ['src/add.mjs'] }),
    leaf('y', { rigor: 'trivial', locus: ['README.md'] })])
  const pre = B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.equal(pre.ok, true)
  const x = B(r, 'leaf-open', { node: 'x', role: 'implementer', round: 1 })
  const xs = commitIn(x.worktree, { 'src/add.mjs': 'export const add = (a, b) => a - b\n' }, 'Break add')
  const y = B(r, 'leaf-open', { node: 'y', role: 'implementer', round: 1 })
  const ys = commitIn(y.worktree, { 'README.md': 'hello world\n' }, 'Greet the world')

  const out = B(r, 'merge-batch', { target: '.', children: [{ id: 'x', head_sha: xs }, { id: 'y', head_sha: ys }], cycles: [] })
  assert.deepEqual(out.failed_alone.map((f) => f.id), ['x'])
  assert.equal(JSON.parse(readFileSync(out.record, 'utf8')).failed_alone[0].failures[0].check, 'suite', 'what failed, and how, stays on disk')
  assert.equal(out.failed_alone[0].row.kind, 'leaf', 'a leaf failing alone comes back with its row and card for its fix round')
  assert.equal(JSON.parse(readFileSync(out.failed_alone[0].card, 'utf8')).id, 'x')
  assert.equal(out.failed_alone[0].facts.rounds, 1)
  assert.deepEqual(out.merged.map((m) => m.id), ['y'])
  assert.deepEqual(out.stops, [], 'a leaf failing alone is no stop: it gets a fix round')
  assert.equal(readTree(r, 'e1').status.get('x').status, 'active')
  const again = B(r, 'leaf-open', { node: 'x', role: 'implementer', round: out.failed_alone[0].facts.rounds + 1 })
  assert.match(readFileSync(again.brief_path, 'utf8'), /## Fix round 2[\s\S]*\[integration\] the suite fails on the merged head[\s\S]*```text/,
    'the fix round the workflow opens reads the failure and its evidence merge-batch left for it')
})

test('a merged leaf loses its worktree and keeps its branch; a leaf failing alone keeps both', () => {
  const r = repo()
  seedTree(r, 'e1', [root(),
    leaf('x', { rigor: 'trivial', locus: ['src/add.mjs'] }),
    leaf('y', { rigor: 'trivial', locus: ['README.md'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const x = B(r, 'leaf-open', { node: 'x', role: 'implementer', round: 1 })
  const xs = commitIn(x.worktree, { 'src/add.mjs': 'export const add = (a, b) => a - b\n' }, 'Break add')
  const y = B(r, 'leaf-open', { node: 'y', role: 'implementer', round: 1 })
  const ys = commitIn(y.worktree, { 'README.md': 'hello world\n' }, 'Greet the world')

  const out = B(r, 'merge-batch', { target: '.', children: [{ id: 'x', head_sha: xs }, { id: 'y', head_sha: ys }], cycles: [] })
  assert.deepEqual(out.merged.map((m) => m.id), ['y'])
  assert.equal(existsSync(y.worktree), false)
  assert.equal(git(r, 'worktree', 'list').includes(y.worktree), false, 'git forgets it too')
  assert.equal(git(r, 'rev-parse', 'agentics/e1--y'), ys)
  assert.equal(git(x.worktree, 'rev-parse', 'HEAD'), xs, 'the fix round works where it worked')
})

test('preflight removes a merged leaf\'s clean worktree and reports a dirty one', () => {
  const r = repo()
  seedTree(r, 'e1', [root(),
    leaf('x', { rigor: 'trivial', locus: ['src/add.mjs'] }),
    leaf('y', { rigor: 'trivial', locus: ['README.md'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const x = B(r, 'leaf-open', { node: 'x', role: 'implementer', round: 1 })
  const xs = commitIn(x.worktree, { 'src/add.mjs': 'export const add = (a, b) => b + a\n' }, 'Add in the other order')
  const y = B(r, 'leaf-open', { node: 'y', role: 'implementer', round: 1 })
  const ys = commitIn(y.worktree, { 'README.md': 'hello world\n' }, 'Greet the world')
  B(r, 'merge-batch', { target: '.', children: [{ id: 'x', head_sha: xs }, { id: 'y', head_sha: ys }], cycles: [] })
  // Worktrees an earlier run left behind: one clean, one holding uncommitted work.
  git(r, 'worktree', 'add', '-q', x.worktree, 'agentics/e1--x')
  git(r, 'worktree', 'add', '-q', y.worktree, 'agentics/e1--y')
  writeFileSync(join(y.worktree, 'README.md'), 'unsaved\n')

  const pre = B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.equal(existsSync(x.worktree), false)
  assert.deepEqual(pre.dirty_worktrees, [y.worktree])
  assert.equal(readFileSync(join(y.worktree, 'README.md'), 'utf8'), 'unsaved\n', 'never forced')
})

test('preflight removes a merged leaf\'s worktree when its key is bounded', () => {
  const r = repo()
  const long = 'growth-axes-and-ports-of-the-entity-layer-x'
  seedTree(r, 'e1', [root(), leaf(long, { rigor: 'trivial', locus: ['README.md'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const x = B(r, 'leaf-open', { node: long, role: 'implementer', round: 1 })
  const xs = commitIn(x.worktree, { 'README.md': 'hello world\n' }, 'Greet the world')
  B(r, 'merge-batch', { target: '.', children: [{ id: long, head_sha: xs }], cycles: [] })
  git(r, 'worktree', 'add', '-q', x.worktree, x.branch)

  B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.equal(existsSync(x.worktree), false)
})

test('a reopened leaf follows its moved parent: the parent head is its base, and the merge is not its work', () => {
  const r = repo()
  seedTree(r, 'e1', [root(),
    leaf('x', { rigor: 'trivial', locus: ['src/add.mjs'] }),
    leaf('y', { rigor: 'trivial', locus: ['README.md'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const x = B(r, 'leaf-open', { node: 'x', role: 'implementer', round: 1 })
  const xs = commitIn(x.worktree, { 'src/add.mjs': 'export const add = (a, b) => b + a\n' }, 'Add in the other order')
  const y = B(r, 'leaf-open', { node: 'y', role: 'implementer', round: 1 })
  const ys = commitIn(y.worktree, { 'README.md': 'hello world\n' }, 'Greet the world')
  assert.deepEqual(B(r, 'merge-batch', { target: '.', children: [{ id: 'y', head_sha: ys }], cycles: [] }).merged.map((m) => m.id), ['y'])
  const parentHead = git(r, 'rev-parse', 'agentics/e1')

  const again = B(r, 'leaf-open', { node: 'x', role: 'implementer', round: 2 })
  assert.equal(again.base_sha, parentHead, 'the base is the head it was brought up to, not the merge')
  assert.equal(git(r, 'merge-base', '--is-ancestor', ys, again.head_sha), '')
  assert.equal(git(r, 'log', '--format=%H', again.base_sha + '..' + again.head_sha).split('\n').includes(xs), true,
    'its own commit stays in its series')

  const close = B(r, 'leaf-close', { node: 'x', role: 'implementer', round: 2, status: 'done', base_sha: again.base_sha })
  const measurement = JSON.parse(readFileSync(close.record, 'utf8')).measurement
  assert.deepEqual(measurement.series_findings, [], 'the refresh merge is neither empty work nor a locus breach')
})

test('children that pass alone and fail together are a combination failure, and nothing merges', () => {
  const r = repo()
  writeFileSync(join(r, 'test', 'pair.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { existsSync } from 'node:fs'\ntest('not both', () => assert.ok(!(existsSync('p.txt') && existsSync('q.txt'))))\n")
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'pair rule')
  seedTree(r, 'e1', [root(), leaf('p', { rigor: 'trivial', locus: ['p.txt'] }), leaf('q', { rigor: 'trivial', locus: ['q.txt'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const p = B(r, 'leaf-open', { node: 'p', role: 'implementer', round: 1 })
  const ps = commitIn(p.worktree, { 'p.txt': 'p\n' }, 'Add p')
  const q = B(r, 'leaf-open', { node: 'q', role: 'implementer', round: 1 })
  const qs = commitIn(q.worktree, { 'q.txt': 'q\n' }, 'Add q')
  const out = B(r, 'merge-batch', { target: '.', children: [{ id: 'p', head_sha: ps }, { id: 'q', head_sha: qs }], cycles: [] })
  assert.deepEqual(out.stops.map((s) => [s.id, s.reason]).sort(), [['p', 'combination_failure'], ['q', 'combination_failure']])
  assert.deepEqual(['p', 'q'].map((id) => readTree(r, 'e1').status.get(id).status), ['escalated', 'escalated'], 'recorded by the batch that saw it')
  assert.deepEqual(out.merged, [])
  assert.equal(git(worktreeOf(r, 'e1', '.'), 'rev-parse', 'HEAD'), out.head_sha)
})

test('a conflict stops the batch and names the paths; what merged before it stays merged', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('m', { rigor: 'trivial', locus: ['README.md'] }), leaf('n', { rigor: 'trivial', locus: ['NOTES.md'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const m = B(r, 'leaf-open', { node: 'm', role: 'implementer', round: 1 })
  const ms = commitIn(m.worktree, { 'README.md': 'from m\n' }, 'Say m')
  // n declared a disjoint locus and wrote README.md anyway: the plan was wrong about independence.
  const n = B(r, 'leaf-open', { node: 'n', role: 'implementer', round: 1 })
  const ns = commitIn(n.worktree, { 'README.md': 'from n\n' }, 'Say n')
  const out = B(r, 'merge-batch', { target: '.', children: [{ id: 'm', head_sha: ms }, { id: 'n', head_sha: ns }], cycles: [] })
  assert.deepEqual(out.merged.map((x) => x.id), ['m'])
  assert.deepEqual(out.stops.map((s) => [s.id, s.reason]), [['n', 'merge_conflict']])
  assert.match(readTree(r, 'e1').status.get('n').last.detail, /conflicting paths: README\.md/, 'the record names the paths')
})

test('a merge-batch that merged nothing and saw nothing fail stops its target', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('x', { rigor: 'trivial', locus: ['src/add.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const out = B(r, 'merge-batch', { target: '.', children: [], cycles: [] })
  assert.deepEqual(out.stops.map((s) => [s.id, s.reason]), [['.', 'merge_no_progress']])
})

test('a merge-batch that died before recording its outcome is redone from where it started', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('x', { rigor: 'trivial', locus: ['src/add.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const x = B(r, 'leaf-open', { node: 'x', role: 'implementer', round: 1 })
  const xs = commitIn(x.worktree, { 'src/add.mjs': 'export const add = (a, b) => a - b\n' }, 'Break add')
  // Simulate the kill: the batch started, the merge landed, nothing was measured or recorded.
  const wt = worktreeOf(r, 'e1', '.')
  const pre = git(wt, 'rev-parse', 'HEAD')
  append(r, 'e1', 'state:' + STAMP, { kind: 'batch-started', target: '.', pre, children: ['x'] })
  git(wt, 'merge', '--no-ff', '--no-edit', 'agentics/e1--x')
  const out = B(r, 'merge-batch', { target: '.', children: [{ id: 'x', head_sha: xs }], cycles: [] })
  assert.deepEqual(out.merged, [], 'the red merge is not recorded as landed: ' + JSON.stringify(JSON.parse(readFileSync(out.record, 'utf8')).notes) + ' ' + out.verified)
  assert.deepEqual(out.failed_alone.map((f) => f.id), ['x'])
  assert.equal(out.head_sha, pre)
  assert.notEqual(readTree(r, 'e1').status.get('x').status, 'merged')
})

test('a merge under a contract a pending node consumes writes the ruler one brief: the consumer as planned, and the change', () => {
  const r = repo()
  seedTree(r, 'e1', [root(),
    leaf('p', { rigor: 'trivial', locus: ['README.md'] }),
    leaf('c', { rigor: 'trivial', locus: ['src/use.mjs'], consumes: [{ name: 'docs', paths: ['README.md'] }] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const p = B(r, 'leaf-open', { node: 'p', role: 'implementer', round: 1 })
  const ps = commitIn(p.worktree, { 'README.md': 'hello world\n' }, 'Greet the world')

  const out = B(r, 'merge-batch', { target: '.', children: [{ id: 'p', head_sha: ps }], cycles: [] })
  assert.deepEqual(out.drift, [{ node: 'c', contract: 'docs', stopped: '' }])
  const brief = readFileSync(out.drift_brief, 'utf8')
  assert.match(brief, /^# c — do c$/m)
  assert.ok(brief.includes('contract docs (README.md)') && brief.includes('- docs: README.md') && brief.includes('- c works'))
  assert.match(brief, /^\+hello world$/m)

  // The ruler writes its rulings to one file; rule-close reads it back over the merge's record.
  const ruled = B(r, 'rule-close', { kind: 'drift', record: out.record, rulings_file: wrote({ rulings: [{ node: 'c', ruling: 'affected', why: 'the docs moved', question: 'does c still read them?' }] }) })
  assert.deepEqual(ruled.replan.map((x) => x.id), ['c'], 'an affected consumer no work stands on goes to the planner')
  const lines = readLog(r, 'e1', 'state:' + STAMP).entries.filter((e) => e.kind === 'drift-ruled')
  assert.deepEqual(lines.map((e) => [e.node, e.contract, e.ruling, e.head_sha]), [['c', 'docs', 'affected', out.head_sha]])
  assert.match(readFileSync(lines[0].said, 'utf8'), /^does c still read them\?/)
  B(r, 'rule-close', { kind: 'drift', record: out.record, rulings_file: wrote({ rulings: [] }), running: ['leaf:c'] })
  assert.deepEqual(readTree(r, 'e1').status.get('c').status, 'parked', 'no ruling reached it: drift is found once, so it parks')
})
