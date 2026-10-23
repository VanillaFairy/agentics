// test/adopted-drift-reads.test.mjs — the git reads behind adopted drift, against real git: a hand
// merge and a root commit contribute their files, and a read that fails is reported, never read as nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { preflight } from '../lib/boundaries/execution.mjs'
import { append } from '../lib/ledger.mjs'
import { commitIn, git, leaf, root } from './harness/boundary-fixture.mjs'
import { E, commandsFile, ctxOf, world } from './harness/execution-world.mjs'

const NODES = [
  root(),
  leaf('p', { expects: ['src/p.mjs'], provides: [{ name: 'api', paths: ['src/api.mjs'] }, { name: 'add', paths: ['src/add.mjs'] }] }),
  leaf('b', { expects: ['src/b.mjs'], deps: ['p'], consumes: [{ name: 'api', paths: ['src/api.mjs'] }, { name: 'add', paths: ['src/add.mjs'] }] }),
]
const OUTSIDE = (commits) => ({ kind: 'outside', node: '.', execution: '', commits, by: 'user' })

async function started(t) {
  const r = world(t, NODES)
  const cf = commandsFile(t)
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).checkpoint, null)
  return { r, cf }
}

test('a hand merge named by its own sha contributes the files it brought in', async (t) => {
  const { r, cf } = await started(t)
  const side = join(r, '.claude', 'worktrees', 'side')
  git(r, 'worktree', 'add', '-q', '-b', 'side', side, 'HEAD')
  const sideSha = commitIn(side, { 'src/api.mjs': 'export const api = 2\n' }, 'by hand')
  const into = join(r, '.claude', 'worktrees', 'into')
  git(r, 'worktree', 'add', '-q', '-b', 'into', into, 'HEAD')
  commitIn(into, { 'docs/n.md': 'n\n' }, 'other')
  git(into, 'merge', '-q', '--no-ff', sideSha, '-m', 'hand merge')
  const merge = git(into, 'rev-parse', 'HEAD')
  const seq = append(r, E, 'events', OUTSIDE([merge])).seqs[0]
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(out.adopted.nodes, ['b'])
  assert.deepEqual(out.adopted.seqs, [seq])
  const record = JSON.parse(readFileSync(out.adopted.record, 'utf8'))
  assert.deepEqual(record.drift.map((d) => d.files), [['src/api.mjs']])
  assert.ok(readFileSync(out.adopted.brief, 'utf8').includes('export const api = 2'), 'the brief carries the merge\'s diff')
})

test('a root commit contributes the files it holds', async (t) => {
  const { r, cf } = await started(t)
  const first = git(r, 'rev-list', '--max-parents=0', 'HEAD')
  const seq = append(r, E, 'events', OUTSIDE([first])).seqs[0]
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(out.adopted.seqs, [seq])
  assert.deepEqual(JSON.parse(readFileSync(out.adopted.record, 'utf8')).drift.map((d) => d.files), [['src/add.mjs']])
})

test('a commit git cannot read is reported on the result, not read as no files', async (t) => {
  const { r, cf } = await started(t)
  const seq = append(r, E, 'events', OUTSIDE(['0'.repeat(40)])).seqs[0]
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(out.ok, true)
  assert.ok(out.adopted && typeof out.adopted.error === 'string' && out.adopted.error.includes('0'.repeat(8)), JSON.stringify(out.adopted))
  assert.deepEqual(out.adopted.nodes, [])
  assert.deepEqual(out.adopted.seqs, [seq])
  const again = await preflight(ctxOf(r), { commands_file: cf })
  assert.ok(again.adopted && again.adopted.error, 'nothing covers the record, so the next launch reports it again')
})
