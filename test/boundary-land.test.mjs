// test/boundary-land.test.mjs — lib/boundary.mjs against real git: what a landing check reports, merges, refuses and sweeps.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { land } from '../lib/boundary.mjs'
import { append } from '../lib/ledger.mjs'
import { renderLanding } from '../lib/render.mjs'
import { pinTree } from '../lib/search/pin.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { git, repo, STAMP } from './harness/boundary-fixture.mjs'

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

test("landing removes the effort's pinned search trees", () => {
  const r = repo()
  git(r, 'checkout', '-q', '-b', 'agentics/e1')
  writeFileSync(join(r, 'work.txt'), 'the effort\n')
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'the effort')
  git(r, 'checkout', '-q', 'main')
  const pinned = pinTree(r, 'e1', git(r, 'rev-parse', 'agentics/e1').trim())
  const landed = land(r, 'e1', 'merge')
  assert.equal(landed.ok, true, landed.error)
  assert.ok(!existsSync(pinned.root), 'the pinned tree went with the effort')
})
