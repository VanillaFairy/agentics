// test/boundary-land.test.mjs — lib/boundary.mjs against real git: landing, drift, and records sent twice.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { freshRecords, land } from '../lib/boundary.mjs'
import { append } from '../lib/ledger.mjs'
import { renderLanding } from '../lib/render.mjs'
import { deriveStatus, normalizeNode, readTree } from '../lib/tree.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { git, leaf, repo, root, STAMP } from './harness/boundary-fixture.mjs'

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
  assert.equal(out.unexamined, 1)
  assert.deepEqual(driftOf(tree, ['p'], ['src/api.mjs']).drift, [], 'the provider landing its own contract is expected work')
  append(r, 'e1', 'events', { kind: 'escalated', node: 'c', execution: STAMP, reason: 'blocked' })
  const stopped = driftOf(readTree(r, 'e1'), ['x'], ['src/api.mjs']).drift
  assert.deepEqual(stopped, [{ node: 'c', contract: 'api', files: ['src/api.mjs'], stopped: 'escalated' }], 'a stopped consumer is reported, marked, never skipped')
})

test('land check carries the root integration review\'s latest claim verdicts', () => {
  const r = repo()
  assert.equal(land(r, 'e1', 'check').root_claims, null, 'no review, no verdicts: never an empty pass')
  const first = [{ claim: 'it builds', verdict: 'met', evidence: 'ci' }]
  const second = [{ claim: 'it builds', verdict: 'met', evidence: 'ci' }, { claim: 'retries are bounded', verdict: 'under', evidence: 'src/r.js:9' }]
  assert.equal(append(r, 'e1', 'events', { kind: 'claims', node: '.', execution: STAMP, head_sha: 'h1', claims: first }).ok, true)
  assert.equal(append(r, 'e1', 'events', { kind: 'claims', node: '.', execution: STAMP, head_sha: 'h2', claims: second }).ok, true)
  assert.equal(append(r, 'e1', 'events', { kind: 'claims', node: 'sub', execution: STAMP, head_sha: 'h3', claims: [] }).ok, true)
  assert.deepEqual(land(r, 'e1', 'check').root_claims, second)
})

test('land check carries the landing view', () => {
  const r = repo()
  assert.equal(land(r, 'e1', 'check').landing, renderLanding(r, 'e1'))
})

test('land check lists every HUMAN: criterion, a promoted task\'s composite included', () => {
  const r = repo()
  const onComposite = { text: 'HUMAN: the messages read well', check: '', decisions: ['D1'] }
  const onLeaf = { text: 'HUMAN: x reads well', check: '', decisions: ['D1'] }
  const seeded = seedTree(r, 'e1', [
    { id: '.', kind: 'composite', title: 'the change', defines: [{ id: 'D1', text: 'do it' }] },
    { id: 'p', kind: 'composite', title: 'promoted', author: 'planner', decisions: ['D1'], acceptance: [onComposite] },
    { id: 'p/x', kind: 'leaf', title: 'do x', rigor: 'tdd', locus: ['src/x.js'], decisions: ['D1'], acceptance: [onLeaf] },
  ])
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems))
  assert.deepEqual(land(r, 'e1', 'check').human.map((h) => [h.node, h.text]).sort(),
    [['p', onComposite.text], ['p/x', onLeaf.text]])
})

test('landing never counts .agentics/ as dirt, and still refuses any other untracked file', () => {
  const r = repo()
  git(r, 'branch', 'agentics/e1')
  mkdirSync(join(r, '.agentics', 'e1'), { recursive: true })
  writeFileSync(join(r, '.agentics', 'e1', 'DESIGN.md'), '# x\n')
  const clean = land(r, 'e1', 'merge')
  assert.equal(clean.ok, true, JSON.stringify(clean.error))

  writeFileSync(join(r, 'stray.txt'), 'x\n')
  const dirty = land(r, 'e1', 'merge')
  assert.equal(dirty.ok, false)
  assert.match(dirty.error, /dirty/)
})

test('landing sweeps what it merged and keeps, with why, an unmerged branch and a dirty worktree', () => {
  const r = repo()
  git(r, 'checkout', '-q', '-b', 'agentics/e1')
  writeFileSync(join(r, 'work.txt'), 'the effort\n')
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'the effort')
  git(r, 'checkout', '-q', 'main')
  const wt = (branch, name) => {
    const path = join(r, '.claude', 'worktrees', name)
    git(r, 'worktree', 'add', '-q', path, branch)
    return path
  }
  git(r, 'branch', 'agentics/e1--merged')
  const clean = wt('agentics/e1--merged', 'e1--merged')
  git(r, 'branch', 'agentics/e1--dirty')
  writeFileSync(join(wt('agentics/e1--dirty', 'e1--dirty'), 'README.md'), 'edited\n')
  git(r, 'branch', 'agentics/e1--open')
  const open = wt('agentics/e1--open', 'e1--open')
  writeFileSync(join(open, 'later.txt'), 'x\n')
  git(open, 'add', '-A')
  git(open, 'commit', '-q', '-m', 'not landed')

  const landed = land(r, 'e1', 'merge')
  assert.equal(landed.ok, true, landed.error)
  assert.deepEqual(landed.removed.sort(), ['agentics/e1', 'agentics/e1--merged'])
  assert.deepEqual(landed.kept.map((k) => k.branch).sort(), ['agentics/e1--dirty', 'agentics/e1--open'])
  assert.ok(landed.kept.every((k) => k.why), 'every kept branch says why')
  assert.ok(!existsSync(clean), 'the clean worktree went with its branch')
  assert.equal(git(r, 'rev-parse', '--verify', '--quiet', 'refs/heads/agentics/e1--open') !== '', true, 'the unmerged branch is never forced')

  git(join(r, '.claude', 'worktrees', 'e1--dirty'), 'checkout', '--', 'README.md')
  const again = land(r, 'e1', 'merge')
  assert.equal(again.already, true)
  assert.deepEqual(again.removed, ['agentics/e1--dirty'], 'landing again finishes the sweep')
})

test('a decision lands once while it is the node\'s word, and again once something has cleared it', () => {
  const nodes = new Map([['a', normalizeNode({ id: 'a', kind: 'leaf', rigor: 'tdd' })]])
  const disk = (events) => ({ nodes, events, status: deriveStatus(nodes, events), state: [], journal: [] })
  const approve = { file: 'events', entry: { kind: 'approved', node: 'a', head_sha: 'h1' } }
  const block = { file: 'events', entry: { kind: 'escalated', node: 'a', reason: 'blocked', detail: '' } }
  assert.equal(freshRecords([approve, approve], disk([{ kind: 'dispatched', node: 'a', seq: 1 }])).length, 1, 'one call deciding it twice lands it once')
  const approvedOnDisk = [{ kind: 'dispatched', node: 'a', seq: 1 }, { ...approve.entry, seq: 2 }]
  assert.deepEqual(freshRecords([approve], disk(approvedOnDisk)), [], 'decided again after a lost courier')
  assert.equal(freshRecords([approve], disk([...approvedOnDisk, { kind: 'dispatched', node: 'a', seq: 3 }])).length, 1, 'approved again after a new round')
  const blocked = [{ kind: 'dispatched', node: 'a', seq: 1 }, { ...block.entry, seq: 2 }]
  assert.deepEqual(freshRecords([block, approve], disk(blocked)), [], 'a stopped node is neither stopped twice nor approved under its stop')
  assert.equal(freshRecords([block], disk([...blocked, { kind: 'replanned', node: 'a', seq: 3 }])).length, 1, 'escalated again after a retry')
})
