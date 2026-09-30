// test/boundary-land.test.mjs — lib/boundary.mjs against real git: landing, drift, and records sent twice.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { land, recordsToAppend } from '../lib/boundary.mjs'
import { append } from '../lib/ledger.mjs'
import { renderLanding } from '../lib/render.mjs'
import { readTree } from '../lib/tree.mjs'
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

test('a record lands once however often it is sent, and the same decision taken again lands again', () => {
  const approved = (rid) => ({ rid, file: 'events', entry: { kind: 'approved', node: 'a', head_sha: 'h1' } })
  const first = recordsToAppend([approved('1.4'), approved('1.4')], { execution: 'x' })
  assert.equal(first.events.length, 1)
  const onDisk = first.events.map((e, i) => ({ ...e, seq: i + 1 }))
  assert.equal(recordsToAppend([approved('1.4')], { events: onDisk, execution: 'x' }).events.length, 0, 'sent again after a lost courier')
  assert.equal(recordsToAppend([approved('2.1')], { events: onDisk, execution: 'x' }).events.length, 1, 'approved again at the same head after a retry')
})
