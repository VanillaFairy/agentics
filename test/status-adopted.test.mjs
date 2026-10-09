// test/status-adopted.test.mjs — adopted work as the snapshot entry and the landing view show it,
// from records on disk.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { append } from '../lib/ledger.mjs'
import { renderLanding } from '../lib/render.mjs'
import { nodeOf } from '../lib/status.mjs'
import { executionDir, returnPath, writeJson } from '../lib/store.mjs'
import { leaf, repo, root, STAMP } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const NODES = [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { locus: ['src/a.mjs'] }), leaf('c/b', { locus: ['src/b.mjs'] })]
function world(t) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  assert.equal(seedTree(r, E, NODES).ok, true)
  return r
}
const adopted = (r, node = 'c/a') => append(r, E, 'events', { kind: 'merged', node, execution: '', into: 'agentics/e1--c', merged_sha: 'm1', head_sha: 'c1c1c1c1c1', by: 'user', commits: ['c1c1c1c1c1'] }).seqs[0]
const outside = (r) => append(r, E, 'events', { kind: 'outside', node: 'c', execution: '', commits: ['s1s1s1s1s1'], by: 'terminal' }).seqs[0]

test("the snapshot entry of an adopted leaf carries the merged event: who, and which commits", (t) => {
  const r = world(t)
  const seq = adopted(r)
  const n = nodeOf(r, E, 'c/a')
  assert.equal(n.status, 'merged')
  assert.equal(n.event.kind, 'merged')
  assert.equal(n.event.seq, seq)
  assert.equal(n.event.by, 'user')
  assert.deepEqual(n.event.commits, ['c1c1c1c1c1'])
})

test("an agentics merge carries no event, as today", (t) => {
  const r = world(t)
  append(r, E, 'events', { kind: 'merged', node: 'c/a', execution: STAMP, into: 'agentics/e1--c', merged_sha: 'm1', head_sha: 'h' })
  assert.equal(nodeOf(r, E, 'c/a').event, null)
})

test("a folder with outside events carries them: the latest's seq and by, every commit", (t) => {
  const r = world(t)
  outside(r)
  const later = append(r, E, 'events', { kind: 'outside', node: 'c', execution: '', commits: ['s2s2s2s2s2'], by: 'user' }).seqs[0]
  const n = nodeOf(r, E, 'c')
  assert.equal(n.event.kind, 'outside')
  assert.equal(n.event.seq, later)
  assert.equal(n.event.by, 'user')
  assert.deepEqual(n.event.commits, ['s1s1s1s1s1', 's2s2s2s2s2'])
})

test('a stop on a folder still comes first', (t) => {
  const r = world(t)
  outside(r)
  append(r, E, 'events', { kind: 'parked', node: 'c', execution: STAMP, return: 'needs_respec', question: 'edit it' })
  assert.equal(nodeOf(r, E, 'c').event.kind, 'parked')
})

test('the landing view has no outside-work section when nothing was adopted', (t) => {
  const r = world(t)
  assert.equal(renderLanding(r, E).includes('Work agentics did not build'), false)
})

test("the landing view lists each adopted leaf, not yet judged before its folder's review, then the outside commits", (t) => {
  const r = world(t)
  adopted(r)
  outside(r)
  const text = renderLanding(r, E)
  assert.ok(text.includes('## Work agentics did not build'))
  assert.ok(text.includes('c/a') && text.includes('adopted by user'), text)
  assert.ok(text.includes('not yet judged'), text)
  assert.ok(text.includes('s1s1s1s1'), text)
})

test("once the folder's review judged it, the landing view shows its ruling on each criterion", (t) => {
  const r = world(t)
  adopted(r)
  const said = 'reviewer.c.integration-c-1.r1'
  writeJson(returnPath(executionDir(r, E, STAMP), said), {
    units: [{ unit: 'criterion:c/a#1', ruling: 'findings', ids: ['F1'], why: 'it misses a case' }], findings: [], fix_rulings: [], claims: [], notes: '',
  })
  append(r, E, 'events', { kind: 'claims', node: 'c', execution: STAMP, head_sha: 'h', review: 'done', claims: [], said })
  const text = renderLanding(r, E)
  assert.ok(text.includes('findings') && text.includes('c/a works'), text)
  assert.equal(text.includes('not yet judged'), false)
})

test("a folder review older than the adoption has not judged it", (t) => {
  const r = world(t)
  const said = 'reviewer.c.integration-c-1.r1'
  writeJson(returnPath(executionDir(r, E, STAMP), said), {
    units: [{ unit: 'criterion:c/a#1', ruling: 'findings', ids: ['F1'], why: 'old' }], findings: [], fix_rulings: [], claims: [], notes: '',
  })
  append(r, E, 'events', { kind: 'claims', node: 'c', execution: STAMP, head_sha: 'h', review: 'done', claims: [], said })
  adopted(r)
  const text = renderLanding(r, E)
  assert.ok(text.includes('not yet judged'), text)
  assert.equal(text.includes('findings: c/a works'), false)
})

test('a folder only rolled up from a parked leaf carries no event, whatever outside records it holds', (t) => {
  const r = world(t)
  outside(r)
  append(r, E, 'events', { kind: 'parked', node: 'c/a', execution: STAMP, return: 'needs_respec', question: 'edit it' })
  const n = nodeOf(r, E, 'c')
  assert.equal(n.status, 'parked')
  assert.equal(n.event, null)
})

test('a folder only rolled up from an escalated leaf carries no event either', (t) => {
  const r = world(t)
  outside(r)
  append(r, E, 'events', { kind: 'escalated', node: 'c/a', execution: STAMP, reason: 'stuck' })
  const n = nodeOf(r, E, 'c')
  assert.equal(n.status, 'escalated')
  assert.equal(n.event, null)
})
