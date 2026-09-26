import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { land, runBoundary } from '../lib/boundary.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { heldBy } from '../lib/locks.mjs'
import { addNodes, readTree } from '../lib/tree.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { branchExists, executionDir, worktreeOf } from '../lib/store.mjs'

// The fixtures' own suites run `node --test`; a grandchild that sees this runner's marker runs
// nothing and exits 0, which would make every measurement a pass.
delete process.env.NODE_TEST_CONTEXT
process.env.AGENTICS_INLINE_JOBS = '1'

const STAMP = '20260925-120000'
const COMMANDS = {
  suite: 'node --test --test-reporter=spec', test_one: 'node --test --test-reporter=spec {file}',
  absent: { build: true, typecheck: true },
}

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr)
  return r.stdout.trim()
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-boundary-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'test'))
  writeFileSync(join(dir, '.gitignore'), '.claude/\n')
  writeFileSync(join(dir, 'src', 'add.mjs'), 'export const add = (a, b) => a + b\n')
  writeFileSync(join(dir, 'test', 'add.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/add.mjs'\ntest('adds', () => assert.equal(add(1, 2), 3))\n")
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return dir
}

const leaf = (id, extra = {}) => ({
  id, kind: 'leaf', title: 'do ' + id, rigor: 'tdd', decisions: ['D1'],
  acceptance: [{ text: id + ' works', check: 'node --test', decisions: ['D1'] }], ...extra,
})
const root = (extra = {}) => ({ id: '.', kind: 'composite', title: 'the change', defines: [{ id: 'D1', text: 'do it' }], ...extra })

const B = (r, name, args, stamp = STAMP) => runBoundary(name, r, 'e1', stamp, args)

function commitIn(wt, files, subject) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(wt, path, '..'), { recursive: true })
    writeFileSync(join(wt, path), text)
  }
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '-m', subject)
  return git(wt, 'rev-parse', 'HEAD')
}

const A_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { a } from '../src/a.mjs'\ntest('a is 1', () => assert.equal(a(), 1))\n"

test('a leaf from preflight to landing: open, measure, merge, close, land, clean up', () => {
  const r = repo()
  assert.equal(seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })]).ok, true)

  const pre = B(r, 'preflight', { root: '.', commands: COMMANDS, task_ids: {} })
  assert.equal(pre.ok, true, JSON.stringify(pre.error))
  assert.equal(pre.checkpoint, null)
  assert.equal(pre.envelope.base_branch, 'main')
  assert.deepEqual(pre.leaves.map((l) => [l.id, l.next_action]), [['a', 'code']])
  assert.deepEqual(pre.todos.map((t) => [t.op, t.key]), [['create', '.'], ['create', 'a']])
  assert.ok(existsSync(join(executionDir(r, 'e1', STAMP), 'execution.json')))

  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1, dispatch: { model: 'sonnet', effort: 'high' }, task_ids: { a: 'T2' } })
  assert.equal(open.status, 'opened', JSON.stringify(open))
  assert.equal(open.branch, 'agentics/e1--a')
  assert.equal(open.worktree, worktreeOf(r, 'e1', 'a'))
  assert.ok(branchExists(r, 'agentics/e1'), 'the effort branch was cut lazily')
  assert.match(readFileSync(open.brief_path, 'utf8'), /a works/)
  assert.deepEqual(open.todos, [{ op: 'update', key: 'a', task_id: 'T2', subject: 'a — do a', activeForm: 'implementing', status: 'in_progress' }])
  assert.equal(heldBy(r).slots.length, 1)

  commitIn(open.worktree, { 'test/a.test.mjs': A_TEST, 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  const close = B(r, 'leaf-close', { node: 'a', role: 'implementer', round: 1, executor_status: 'done', base_sha: open.base_sha })
  assert.equal(close.decision.next, 'approve', JSON.stringify(close.decision) + '\n' + close.measurement.notes)
  assert.equal(close.measurement.suite, 'passed')
  assert.equal(close.measurement.discriminator[0].failed_on_base, true)
  assert.ok(readLog(r, 'e1', 'journal:' + STAMP).entries.some((e) => e.kind === 'verify-observed' && e.node === 'a'))

  const merged = B(r, 'merge-batch', {
    target: '.', children: [{ id: 'a', head_sha: close.head_sha }], cycles: [],
    records: [{ file: 'events', entry: { kind: 'approved', node: 'a', head_sha: close.head_sha, review_rounds: 0, at_integration: true } }],
  })
  assert.deepEqual(merged.merged.map((m) => m.id), ['a'])
  assert.equal(merged.conflict, null)
  assert.equal(merged.verified, true)
  assert.equal(readTree(r, 'e1').status.get('a').status, 'merged')
  assert.equal(readTree(r, 'e1').status.get('.').status, 'integrated')
  assert.deepEqual(heldBy(r).locus, [], 'the merge released the locus locks')

  const again = B(r, 'merge-batch', { target: '.', children: [{ id: 'a', head_sha: close.head_sha }], cycles: [] })
  assert.equal(again.head_sha, merged.head_sha, 'a re-run converges: nothing merged twice')

  const post = B(r, 'postflight', { status: 'done' })
  assert.equal(post.closed, true)
  assert.deepEqual(post.cleanup.map((c) => c.node), ['a'])
  assert.deepEqual(heldBy(r).slots, [])

  const check = land(r, 'e1', 'check')
  assert.deepEqual(check.open_escalations, [])
  assert.equal(check.drift.base_moved, false)
  const landed = land(r, 'e1', 'merge')
  assert.equal(landed.ok, true, landed.error)
  assert.ok(existsSync(join(r, 'src', 'a.mjs')), 'the user branch now has the work')
  assert.equal(readTree(r, 'e1').status.get('.').status, 'landed')
  const clean = land(r, 'e1', 'cleanup')
  assert.deepEqual(clean.removed.sort(), ['agentics/e1', 'agentics/e1--a'])
})

test('a shell-less author: its locus files are committed, a stray file is reverted and reported', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('t', { rigor: 'tests-only', locus: ['test/more.test.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const open = B(r, 'leaf-open', { node: 't', role: 'test-author', round: 1 })
  writeFileSync(join(open.worktree, 'test', 'more.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/add.mjs'\ntest('adds negatives', () => assert.equal(add(-1, -2), -3))\n")
  writeFileSync(join(open.worktree, 'stray.txt'), 'oops\n')
  writeFileSync(open.report_path, [
    'Cases: adds negatives.',
    '```agentics-commit', 'Test add with negatives', '```',
    '```agentics-mutations', JSON.stringify([{ file: 'src/add.mjs', find: 'a + b', replace: 'a - b', expect_failing: ['test/more.test.mjs'] }]), '```',
  ].join('\n'))
  const close = B(r, 'leaf-close', { node: 't', role: 'test-author', round: 1, base_sha: open.base_sha })
  assert.equal(close.committed, true)
  assert.equal(git(open.worktree, 'log', '-1', '--format=%s'), 'Test add with negatives')
  assert.equal(existsSync(join(open.worktree, 'stray.txt')), false)
  assert.ok(close.measurement.series_findings.some((f) => f.check === 'locus-breach' && /stray\.txt/.test(f.message)))
  assert.equal(close.measurement.mutations[0].bites, true)
  assert.equal(close.decision.next, 'fix', 'the breach blocks, so the author gets a fix round')
})

test('a red/green cycle: green is cut from red, measured on red\'s tests, and the pair merges through its tip', () => {
  const r = repo()
  seedTree(r, 'e1', [root(),
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], locus: ['src/r.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })

  const red = B(r, 'leaf-open', { node: 'r', role: 'test-author', round: 1 })
  writeFileSync(join(red.worktree, 'test', 'r.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('r is 2', async () => { const { r } = await import('../src/r.mjs'); assert.equal(r(), 2) })\n")
  writeFileSync(red.report_path, '```agentics-commit\nPin r\n```\n')
  const redClose = B(r, 'leaf-close', { node: 'r', role: 'test-author', round: 1, base_sha: red.base_sha })
  assert.equal(redClose.decision.next, 'review', JSON.stringify(redClose.decision))

  const green = B(r, 'leaf-open', {
    node: 'g', role: 'implementer', round: 1,
    records: [{ file: 'events', entry: { kind: 'approved', node: 'r', head_sha: redClose.head_sha, review_rounds: 1, at_integration: false } }],
  })
  assert.equal(green.base_sha, redClose.head_sha, 'green is cut from red\'s head')
  commitIn(green.worktree, { 'src/r.mjs': 'export const r = () => 2\n' }, 'Implement r')
  const greenClose = B(r, 'leaf-close', { node: 'g', role: 'implementer', round: 1, base_sha: green.base_sha })
  assert.equal(greenClose.decision.next, 'review', JSON.stringify(greenClose.decision) + greenClose.measurement.notes)

  const merged = B(r, 'merge-batch', {
    target: '.', children: [{ id: 'r', head_sha: redClose.head_sha }, { id: 'g', head_sha: greenClose.head_sha }], cycles: [['r', 'g']],
    records: [{ file: 'events', entry: { kind: 'approved', node: 'g', head_sha: greenClose.head_sha, review_rounds: 1, at_integration: false } }],
  })
  assert.deepEqual(merged.merged.map((m) => m.id), ['r', 'g'])
  assert.equal(merged.verified, true)
})

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
  assert.equal(out.failed_alone[0].failures[0].check, 'suite')
  assert.deepEqual(out.merged.map((m) => m.id), ['y'])
  assert.deepEqual(out.combination, [])
  assert.equal(readTree(r, 'e1').status.get('x').status, 'active')
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
  assert.deepEqual(out.combination.sort(), ['p', 'q'])
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
  assert.equal(out.conflict.node, 'n')
  assert.deepEqual(out.conflict.paths, ['README.md'])
})

test('preflight checkpoints: an overlapping open execution, a blocking gap, a parked plan', () => {
  const r = repo()
  seedTree(r, 'e1', [root({ defines: [{ id: 'D1', text: 'x' }, { id: 'D2', text: 'y' }] }), leaf('a', { locus: ['src/a.mjs'] })])
  const gaps = B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.equal(gaps.checkpoint.reason, 'blocking_gaps')
  assert.match(gaps.checkpoint.detail, /D2/)

  const other = B(r, 'preflight', { root: 'a', commands: COMMANDS, confirmed_gaps: true }, '20260925-130000')
  assert.equal(other.checkpoint.reason, 'existing_execution', 'the first execution never closed and its root contains this one')
  const forced = B(r, 'preflight', { root: 'a', commands: COMMANDS, confirmed_duplicate: true, confirmed_gaps: true, plan_only: true }, '20260925-130000')
  assert.equal(forced.checkpoint.reason, 'parked')

  const reload = B(r, 'preflight', { root: '.', reload: true }, '20260925-140000')
  assert.equal(reload.checkpoint, null)
  assert.equal(existsSync(join(executionDir(r, 'e1', '20260925-140000'), 'execution.json')), false, 'a reload writes no envelope')
})

test('resume: a preflight after a lost invocation names each leaf\'s next undone action', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] }), leaf('b', { rigor: 'trivial', locus: ['README.md'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1 })
  commitIn(open.worktree, { 'test/a.test.mjs': A_TEST, 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  B(r, 'leaf-close', { node: 'a', role: 'implementer', round: 1, base_sha: open.base_sha })
  // The invocation dies here. The next one resumes the same execution.
  const again = B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.equal(again.envelope.resumed, true)
  const next = Object.fromEntries(again.leaves.map((l) => [l.id, l.next_action]))
  assert.deepEqual(next, { a: 'merge', b: 'code' })
  const a = again.leaves.find((l) => l.id === 'a')
  assert.equal(a.base_sha, open.base_sha, 'the fork point travels, so a salvaged close measures the right series')
  assert.equal(a.rounds, 1)
  assert.equal(a.brief_path, open.brief_path)
  assert.deepEqual(heldBy(r).slots, [], 'the dead invocation\'s slots were freed')
})

test('a long boundary runs detached: pending past the poll limit, collected by the next call', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1 })
  commitIn(open.worktree, { 'test/a.test.mjs': A_TEST, 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  const args = { node: 'a', role: 'implementer', round: 1, base_sha: open.base_sha }
  const run = (wait) => spawnSync('node', [fileURLToPath(new URL('../lib/boundary.mjs', import.meta.url)), 'leaf-close', '--repo', r, '--effort', 'e1', '--execution', STAMP,
    '--b64', Buffer.from(JSON.stringify(args)).toString('base64')], { encoding: 'utf8', env: { ...process.env, AGENTICS_INLINE_JOBS: '', AGENTICS_BOUNDARY_WAIT_MS: String(wait) } })
  const first = JSON.parse(run(1).stdout)
  assert.equal(first.payload.status, 'pending')
  const second = JSON.parse(run(60000).stdout)
  assert.equal(second.payload.status, 'done')
  assert.equal(second.payload.decision.next, 'approve')
  const verifies = readLog(r, 'e1', 'journal:' + STAMP).entries.filter((e) => e.kind === 'verify-observed')
  assert.equal(verifies.length, 1, 'the job ran once, whoever collected it')
})

test('the CLI refuses a damaged argument token and prints an envelope either way', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs'] })])
  const token = Buffer.from(JSON.stringify({ root: '.' })).toString('base64')
  const out = spawnSync('node', [fileURLToPath(new URL('../lib/boundary.mjs', import.meta.url)), 'preflight', '--repo', r, '--effort', 'e1', '--execution', STAMP, '--digest', 'deadbeef', '--b64', token], { encoding: 'utf8' })
  assert.equal(out.status, 0)
  const env = JSON.parse(out.stdout)
  assert.equal(env.payload.error.kind, 'digest_mismatch')
  assert.equal(existsSync(join(executionDir(r, 'e1', STAMP), 'execution.json')), false)
})

test('drift: a landed diff under a contract a pending node consumes is flagged; its own provider is not', async () => {
  const { driftOf } = await import('../lib/boundary.mjs')
  const r = repo()
  seedTree(r, 'e1', [root(),
    leaf('p', { rigor: 'trivial', locus: ['src/api.mjs'], provides: [{ name: 'api', paths: ['src/api.mjs'] }] }),
    leaf('c', { rigor: 'trivial', locus: ['src/use.mjs'], consumes: [{ name: 'api', paths: ['src/api.mjs'] }], deps: ['p'] }),
    leaf('x', { rigor: 'trivial', locus: ['src/other.mjs'] }),
    leaf('d', { rigor: 'trivial', locus: ['src/d.mjs'], consumes: [{ name: 'shape', paths: ['src/shape/'] }] }),
    { id: 'later', kind: 'design', title: 'later part' }])
  const tree = readTree(r, 'e1')
  const out = driftOf(tree, ['x'], ['src/other.mjs', 'src/shape/one.mjs', 'src/api.mjs'])
  assert.deepEqual(out.drift.map((d) => [d.node, d.contract]).sort(), [['c', 'api'], ['d', 'shape']])
  assert.deepEqual(out.unexamined, ['later'])
  assert.deepEqual(driftOf(tree, ['p'], ['src/api.mjs']).drift, [], 'the provider landing its own contract is expected work')
})

const BOUNDARY = fileURLToPath(new URL('../lib/boundary.mjs', import.meta.url))
const cli = (r, name, args, env = {}) => {
  const out = spawnSync('node', [BOUNDARY, name, '--repo', r, '--effort', 'e1', '--execution', STAMP,
    '--b64', Buffer.from(JSON.stringify(args)).toString('base64')], { encoding: 'utf8', env: { ...process.env, ...env } })
  return JSON.parse(out.stdout).payload
}

test('a detached close re-measures once its inputs change: commands established after command_unknown', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })])
  B(r, 'preflight', { root: '.' })
  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1 })
  commitIn(open.worktree, { 'test/a.test.mjs': A_TEST, 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  const args = { node: 'a', role: 'implementer', round: 1, base_sha: open.base_sha }
  const detachedEnv = { AGENTICS_INLINE_JOBS: '', AGENTICS_BOUNDARY_WAIT_MS: '60000' }
  assert.equal(cli(r, 'leaf-close', args, detachedEnv).decision.next, 'command_unknown')
  const add = spawnSync('node', [fileURLToPath(new URL('../lib/gotchas.mjs', import.meta.url)), 'add', '--repo', r, '--effort', 'e1', '--role', 'investigator', '--stdin'],
    { encoding: 'utf8', input: JSON.stringify(['build', 'typecheck', 'suite', 'test_one'].map((name) => ({
      kind: 'command', roles: ['implementer', 'investigator'], paths: [], trigger: 'running ' + name, action: 'use it',
      evidence: { command: name, output: 'ok' },
      command: { name, value: name === 'suite' ? COMMANDS.suite : name === 'test_one' ? COMMANDS.test_one : '', absent: name === 'build' || name === 'typecheck' },
    }))) })
  assert.equal(add.status, 0, add.stdout + add.stderr)
  assert.equal(cli(r, 'leaf-close', args, detachedEnv).decision.next, 'approve', 'the same arguments over new commands are a new job')
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
  assert.deepEqual(out.merged, [], 'the red merge is not recorded as landed: ' + JSON.stringify(out.notes) + ' ' + out.verified)
  assert.deepEqual(out.failed_alone.map((f) => f.id), ['x'])
  assert.equal(out.head_sha, pre)
  assert.notEqual(readTree(r, 'e1').status.get('x').status, 'merged')
})

test('a leaf decomposed in place releases its claim: its children are not locked out by it', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { rigor: 'trivial', locus: ['src/a.mjs', 'src/b.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.equal(B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1 }).status, 'opened')
  const split = addNodes(r, 'e1', [
    { id: 'a', kind: 'composite', title: 'do a', decisions: ['D1'] },
    leaf('a/x', { rigor: 'trivial', locus: ['src/a.mjs'] }), leaf('a/y', { rigor: 'trivial', locus: ['src/b.mjs'] }),
  ], { by: 'planner', reason: 'decompose' })
  assert.equal(split.ok, true, JSON.stringify(split.problems))
  assert.equal(B(r, 'leaf-open', { node: 'a/x', role: 'implementer', round: 1, wait_ms: 2000 }).status, 'opened')
})

test('concurrent leaf-opens under one fresh composite all open', async () => {
  const r = repo()
  seedTree(r, 'e1', [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] },
    ...['p', 'q', 's', 't'].map((id) => leaf('c/' + id, { rigor: 'trivial', locus: ['src/' + id + '.mjs'] }))])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const opens = await Promise.all(['p', 'q', 's', 't'].map((id) => new Promise((resolve) => {
    const child = spawn('node', [BOUNDARY, 'leaf-open', '--repo', r, '--effort', 'e1', '--execution', STAMP,
      '--b64', Buffer.from(JSON.stringify({ node: 'c/' + id, role: 'implementer', round: 1 })).toString('base64')])
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('close', () => resolve(JSON.parse(out).payload.status))
  })))
  assert.deepEqual(opens, ['opened', 'opened', 'opened', 'opened'])
})

test('leaf-close never commits outside a linked worktree', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('t', { rigor: 'tests-only', locus: ['test/t.test.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  // The worktree path exists but is not a registered worktree: git -C would resolve to the user's repo.
  mkdirSync(worktreeOf(r, 'e1', 't'), { recursive: true })
  writeFileSync(join(r, 'staged.txt'), 'the user\'s staged work\n')
  git(r, 'add', 'staged.txt')
  const head = git(r, 'rev-parse', 'HEAD')
  B(r, 'leaf-close', { node: 't', role: 'test-author', round: 1, base_sha: head })
  assert.equal(git(r, 'rev-parse', 'HEAD'), head, 'the user\'s branch did not move')
})

test('an escalation repeated after a retry is recorded again, and a composite escalation stops landing', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { rigor: 'trivial', locus: ['src/a.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const esc = { file: 'events', entry: { kind: 'escalated', node: 'c/a', reason: 'blocked', detail: '' } }
  B(r, 'postflight', { status: 'paused', records: [esc] })
  B(r, 'preflight', { root: '.', commands: COMMANDS, retry_escalated: ['c/a'], confirmed_duplicate: true })
  assert.equal(readTree(r, 'e1').status.get('c/a').status, 'planned')
  B(r, 'postflight', { status: 'paused', records: [esc] })
  assert.equal(readTree(r, 'e1').status.get('c/a').status, 'escalated', 'the second occurrence landed in the ledger')

  B(r, 'postflight', { status: 'paused', records: [{ file: 'events', entry: { kind: 'escalated', node: 'c', reason: 'merge_conflict', detail: '' } }] })
  assert.equal(readTree(r, 'e1').status.get('c').status, 'escalated')
  const check = land(r, 'e1', 'check')
  assert.ok(check.open_escalations.some((e) => e.node === 'c'))
})

test('a green is cut from its red and brought up to the parent head, so its other dependencies are there', () => {
  const r = repo()
  seedTree(r, 'e1', [root(),
    leaf('l', { rigor: 'trivial', locus: ['src/l.mjs'] }),
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r', 'l'], locus: ['src/r.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const red = B(r, 'leaf-open', { node: 'r', role: 'test-author', round: 1 })
  const redHead = commitIn(red.worktree, { 'test/r.test.mjs': "import { test } from 'node:test'\ntest('r', () => {})\n" }, 'Pin r')
  const l = B(r, 'leaf-open', { node: 'l', role: 'implementer', round: 1 })
  const ls = commitIn(l.worktree, { 'src/l.mjs': 'export const l = 1\n' }, 'Add l')
  B(r, 'merge-batch', { target: '.', children: [{ id: 'l', head_sha: ls }], cycles: [] })
  const green = B(r, 'leaf-open', { node: 'g', role: 'implementer', round: 1 })
  assert.ok(existsSync(join(green.worktree, 'src', 'l.mjs')), 'l merged before g was cut, so g builds on it')
  assert.ok(existsSync(join(green.worktree, 'test', 'r.test.mjs')), 'and on red\'s tests')
  assert.notEqual(redHead, green.base_sha)
})
