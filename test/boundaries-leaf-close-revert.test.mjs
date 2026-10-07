// test/boundaries-leaf-close-revert.test.mjs — lib/boundaries/leaf-close.mjs when a git commit of its
// revert path fails: the failure is a note in the close record, and `breach_reverted` names only a
// revert commit that exists. A commit-msg hook in the test repository refuses one commit subject.
//
// Design: docs/DESIGN.md#boundaries.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { leafClose } from '../lib/boundaries/leaf-close.mjs'
import { executionContext } from '../lib/boundaries/records.mjs'
import { attach } from '../lib/integration.mjs'
import { executionLog, readLog } from '../lib/ledger.mjs'
import { branchOf, closePath, executionDir, mkdirState, readJson, returnPath, worktreeOf } from '../lib/store.mjs'
import { A_TEST, COMMANDS, STAMP, git, leaf, repo, root } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const SLOW = { timeout: 180_000 }
const A_SRC = 'export const a = () => 1\n'

/** A leaf `a` whose implementer committed work and an edit outside its locus; a commit-msg hook refuses `refuse`. */
async function breached(t, { refuse, stray = false }) {
  const r = repo()
  t.after(() => { try { rmSync(r, { recursive: true, force: true, maxRetries: 3 }) } catch { /* a handle held on Windows */ } })
  const seeded = seedTree(r, E, [root(), leaf('a', { acceptance: [{ text: 'a works', check: "node -e 'process.exit(0)'", decisions: ['D1'] }], locus: ['src/a.mjs', 'test/a.test.mjs'] })])
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems || seeded.error))
  const base = git(r, 'rev-parse', 'HEAD')
  git(r, 'branch', branchOf(E, '.'), base)
  const dir = executionDir(r, E, STAMP)
  mkdirState(dir)
  writeFileSync(join(dir, 'execution.json'), JSON.stringify({ stamp: STAMP, root: '.', base_branch: 'main', base_sha: base, commands: COMMANDS }))
  const xc = executionContext({ repo: r, effort: E, execution: STAMP, log: executionLog(r, E, STAMP) })
  const branch = branchOf(E, 'a')
  git(r, 'branch', branch, base)
  const worktree = worktreeOf(r, E, 'a')
  assert.equal(attach(r, branch, worktree).ok, true)
  const files = { 'test/a.test.mjs': A_TEST, 'src/a.mjs': A_SRC, ...(stray ? {} : { 'README.md': 'hello\nedited\n' }) }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true })
    writeFileSync(join(worktree, path), text)
  }
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-q', '-m', 'Add a')
  if (stray) writeFileSync(join(worktree, 'stray.txt'), 'oops\n')
  const hooks = resolve(worktree, git(worktree, 'rev-parse', '--git-common-dir'), 'hooks')
  mkdirSync(hooks, { recursive: true })
  const hook = join(hooks, 'commit-msg')
  writeFileSync(hook, '#!/bin/sh\nif grep -q "^' + refuse + '" "$1"; then echo refused >&2; exit 1; fi\n')
  chmodSync(hook, 0o755)
  const dispatch = 'd-a-r1'
  xc.log.append('dispatched', { dispatch, node: 'a', round: 1, thread: 'producer:a', role: 'implementer', model: 'sonnet', effort: 'medium', carries: [] })
  xc.log.append('returned', { dispatch, status: 'returned' })
  mkdirSync(dirname(returnPath(xc.dir, dispatch)), { recursive: true })
  writeFileSync(returnPath(xc.dir, dispatch), JSON.stringify({ status: 'done', text: 'it is done' }))
  const base_sha = base
  const out = await leafClose(xc, { node: 'a', role: 'implementer', round: 1, thread: 'producer:a', dispatch, head_before: base_sha, base_sha })
  const reverted = readLog(r, E, 'state:' + STAMP).entries.filter((e) => e.kind === 'breach_reverted' && e.node === 'a')
  return { out, reverted, record: readJson(closePath(r, E, STAMP, 'a', 'implementer', 1)), worktree }
}

test('a revert commit that fails is a note, and breach_reverted names no commit', SLOW, async (t) => {
  const s = await breached(t, { refuse: 'agentics: revert outside locus' })
  assert.notEqual(git(s.worktree, 'log', '-1', '--format=%s'), 'agentics: revert outside locus')
  assert.deepEqual(s.reverted, [])
  assert.ok(s.record.notes.some((n) => n.includes('revert') && n.includes('README.md')), JSON.stringify(s.record.notes))
})

test('an outside-paths commit that fails is a note', SLOW, async (t) => {
  const s = await breached(t, { refuse: 'agentics: outside locus', stray: true })
  assert.ok(s.record.notes.some((n) => n.includes('stray.txt') && n.includes('failed')), JSON.stringify(s.record.notes))
})
