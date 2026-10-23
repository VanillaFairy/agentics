// test/adopt-e2e.test.mjs — the four shapes of outside work, from a launch that stops at
// outside_work, through the check and the act on the user's word, to a relaunch that reads the
// records: no outside work left, the adopted leaves merged, a handed-over leaf carried on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { adopt } from '../lib/adopt.mjs'
import { adoptAct } from '../lib/boundary.mjs'
import { leafOpen } from '../lib/boundaries/leaf-open.mjs'
import { preflight } from '../lib/boundaries/execution.mjs'
import { readLog } from '../lib/ledger.mjs'
import { resumeLeaves } from '../lib/resume.mjs'
import { branchOf, worktreeOf } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { commitIn, git, leaf, root } from './harness/boundary-fixture.mjs'
import { E, STAMP2, commandsFile, ctxOf, started } from './harness/execution-world.mjs'

const NODES = [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] },
  leaf('c/a', { expects: ['src/a.mjs'] }), leaf('c/b', { expects: ['src/b.mjs'] }),
  leaf('c/r', { rigor: 'tdd-pair', role: 'red', expects: ['test/g.test.mjs'] }),
  leaf('c/g', { rigor: 'tdd-pair', role: 'green', expects: ['src/g.mjs'], deps: ['c/r'] })]

/** A started execution, the effort and folder c's branches cut at its base, c checked out, and a place for map files. */
async function handWorld(t) {
  const { r, cf, base } = await started(t, NODES)
  git(r, 'branch', branchOf(E, '.'), base)
  git(r, 'branch', branchOf(E, 'c'), base)
  const wt = worktreeOf(r, E, 'c')
  git(r, 'worktree', 'add', '-q', wt, branchOf(E, 'c'))
  const dir = mkdtempSync(join(tmpdir(), 'agentics-map-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let n = 0
  const mapFile = (doc) => {
    const path = join(dir, 'map-' + n++ + '.json')
    writeFileSync(path, JSON.stringify(doc))
    return path
  }
  return { r, cf, base, wt, mapFile }
}
const terminal = (typed) => ({ env: {}, stdinIsTTY: true, ask: async () => typed })
async function adoptOnWord(w, doc) {
  const map = w.mapFile(doc)
  const check = adopt(w.r, E, 'c', map, 'check')
  assert.equal(check.ok, true, JSON.stringify(check.refusals))
  const out = await adoptAct(w.r, E, 'c', map, terminal(check.token))
  assert.equal(out.ok, true, JSON.stringify(out))
  return out
}
const statusOf = (r, id) => readTree(r, E).status.get(id).status
const relaunch = (w) => preflight(ctxOf(w.r), { commands_file: w.cf })

test('a leaf done by hand straight on its folder branch: stop, adopt on the word, relaunch clear and the leaf merged', async (t) => {
  const w = await handWorld(t)
  const one = commitIn(w.wt, { 'src/a.mjs': 'export const a = 1\n' }, 'a, by hand')
  assert.equal((await relaunch(w)).checkpoint.reason, 'outside_work')
  await adoptOnWord(w, { done: [{ node: 'c/a', commits: [one] }] })
  const after = await relaunch(w)
  assert.notEqual(after.checkpoint && after.checkpoint.reason, 'outside_work')
  assert.equal(statusOf(w.r, 'c/a'), 'merged')
  assert.equal(readLog(w.r, E, 'events').entries.find((e) => e.kind === 'merged' && e.node === 'c/a').by, 'terminal')
  const [row] = resumeLeaves(w.r, E, '', readTree(w.r, E).nodes).filter((l) => l.id === 'c/a')
  assert.equal(row.next_action, 'none')
})

test('a leaf built on its own branch and merged by hand with --no-ff: adopted by its branch', async (t) => {
  const w = await handWorld(t)
  const hand = join(w.r, '.claude', 'worktrees', 'hand-a')
  git(w.r, 'worktree', 'add', '-q', '-b', 'hand/a', hand, branchOf(E, 'c'))
  commitIn(hand, { 'src/a.mjs': 'export const a = 1\n' }, 'a, first')
  commitIn(hand, { 'src/a.mjs': 'export const a = 2\n' }, 'a, second')
  git(w.wt, 'merge', '--no-ff', '--no-edit', 'hand/a')
  assert.equal((await relaunch(w)).checkpoint.reason, 'outside_work')
  await adoptOnWord(w, { done: [{ node: 'c/a', branch: 'hand/a' }] })
  assert.notEqual(((await relaunch(w)).checkpoint || {}).reason, 'outside_work')
  assert.equal(statusOf(w.r, 'c/a'), 'merged')
})

test('a folder built before compile: its red and green, adopted together in one batch, both merged and the guard clear', async (t) => {
  const w = await handWorld(t)
  const red = commitIn(w.wt, { 'test/g.test.mjs': "import { test } from 'node:test'\ntest('g', () => {})\n" }, 'g tests, by hand')
  const green = commitIn(w.wt, { 'src/g.mjs': 'export const g = 1\n' }, 'g, by hand')
  assert.equal((await relaunch(w)).checkpoint.reason, 'outside_work')
  const out = await adoptOnWord(w, { done: [{ node: 'c/r', commits: [red] }, { node: 'c/g', commits: [green] }] })
  assert.equal(out.recorded.length, 2)
  assert.notEqual(((await relaunch(w)).checkpoint || {}).reason, 'outside_work')
  assert.equal(statusOf(w.r, 'c/r'), 'merged')
  assert.equal(statusOf(w.r, 'c/g'), 'merged')
})

test('commits that belong to no leaf: adopted as outside, and the guard clears', async (t) => {
  const w = await handWorld(t)
  const stray = commitIn(w.wt, { 'docs/notes.md': 'notes\n' }, 'notes, by hand')
  assert.equal((await relaunch(w)).checkpoint.reason, 'outside_work')
  await adoptOnWord(w, { outside: [{ commits: [stray] }] })
  assert.notEqual(((await relaunch(w)).checkpoint || {}).reason, 'outside_work')
  assert.deepEqual(readLog(w.r, E, 'events').entries.filter((e) => e.kind === 'outside').map((e) => e.commits), [[stray]])
})

test('half-done work handed over: the canonical branch continues the series, salvaged, and the note reaches its first round', async (t) => {
  const w = await handWorld(t)
  const hand = join(w.r, '.claude', 'worktrees', 'hand-b')
  git(w.r, 'worktree', 'add', '-q', '-b', 'hand/b', hand, branchOf(E, 'c'))
  const tip = commitIn(hand, { 'src/b.mjs': 'export const b = 0 // half\n' }, 'b, started by hand')
  await adoptOnWord(w, { handover: [{ node: 'c/b', branch: 'hand/b' }] })
  const [row] = resumeLeaves(w.r, E, '', readTree(w.r, E).nodes).filter((l) => l.id === 'c/b')
  assert.equal(row.next_action, 'continue-series')
  const xc = ctxOf(w.r, STAMP2)
  assert.equal((await preflight(xc, { folder: 'c', commands_file: commandsFile(t, undefined, 'b.json') })).ok, true)
  const opened = await leafOpen(xc, { node: 'c/b', intelligence: 'normal' })
  assert.equal(opened.status, 'opened', JSON.stringify(opened))
  assert.equal(opened.salvaged, true)
  const notes = readLog(w.r, E, 'events').entries.filter((e) => e.kind === 'message' && e.msg === 'notes' && e.node === 'c/b')
  assert.equal(notes.length, 1)
  assert.ok(notes[0].payload.notes.some((n) => n.includes('hand/b') && n.includes(tip)))
})
