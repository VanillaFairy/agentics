// test/leaf-close-git-reads.test.mjs — lib/boundaries/leaf-close.mjs reads git once per question:
// inside one close, no git question is asked twice in one directory without a write there between;
// a read after a write sees the write; nothing read outlives the close.
//
// Processes are counted in-process: node:child_process's `spawnSync` and `spawn` are wrapped and
// `syncBuiltinESMExports` carries the wrappers to lib's named imports (as test/fast/harness/no-spawn.mjs
// does). A question is `status`, `HEAD` (a rev-parse naming HEAD), or else the exact git command; a
// write is a git verb that changes a repository, or a lib/verify.mjs child.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#verification.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { git, root } from './harness/boundary-fixture.mjs'
import {
  SLOW, world, open, commit, write, stored, close, run, observed, rec, head, lf, testsOnly,
  DONE, A_FILES, MORE_TEST,
} from './harness/leaf-close-world.mjs'

const cp = process.getBuiltinModule('node:child_process')

/** Every git process and every lib/verify.mjs child started until `stop`, in order. */
function counting(t) {
  const seen = []
  const { spawnSync, spawn } = cp
  cp.spawnSync = function (file, args, ...rest) {
    if (file === 'git') seen.push({ git: args })
    return spawnSync.call(this, file, args, ...rest)
  }
  cp.spawn = function (file, args, ...rest) {
    if (Array.isArray(args) && String(args[0]).endsWith('verify.mjs')) seen.push({ verify: true })
    return spawn.call(this, file, args, ...rest)
  }
  syncBuiltinESMExports()
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    cp.spawnSync = spawnSync
    cp.spawn = spawn
    syncBuiltinESMExports()
  }
  t.after(stop)
  return { seen, stop }
}

const WRITES = new Set(['add', 'apply', 'branch', 'checkout', 'cherry-pick', 'commit', 'merge', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'tag', 'update-ref', 'worktree'])

const dirOf = (p) => {
  let real = String(p)
  try { real = realpathSync.native(p) } catch { /* gone: its spelling stands */ }
  real = real.split('\\').join('/')
  return process.platform === 'win32' ? real.toLowerCase() : real
}

/** The git verb after any `-c <key=value>` pairs, and its arguments. */
function verbOf(rest) {
  let i = 0
  while (rest[i] === '-c') i += 2
  return { verb: rest[i], args: rest.slice(i + 1) }
}

function questionOf(verb, args) {
  if (verb === 'status') return 'status'
  if (verb === 'rev-parse' && args.some((a) => a === 'HEAD' || a === 'HEAD^{commit}')) return 'HEAD'
  return verb + ' ' + args.join(' ')
}

/** Each question asked twice in one directory with no write there between, as `<dir>: <question>`. */
function repeats(seen) {
  const asked = new Map()
  const out = []
  for (const s of seen) {
    if (s.verify) { asked.clear(); continue }
    const [flag, cwd, ...rest] = s.git
    if (flag !== '-C') continue
    const dir = dirOf(cwd)
    const { verb, args } = verbOf(rest)
    if (WRITES.has(verb)) { asked.delete(dir); continue }
    const q = questionOf(verb, args)
    const mine = asked.get(dir) || new Set()
    if (mine.has(q)) out.push(dir + ': ' + q)
    mine.add(q)
    asked.set(dir, mine)
  }
  return out
}

const gits = (seen) => seen.filter((s) => s.git).length
const children = (seen) => seen.filter((s) => s.verify).length

/** A leaf `a` whose implementer committed its work and an edit to README.md it did not expect. */
/** A leaf whose implementer committed its work and left an edit uncommitted. */
function stray(t) {
  const w = world(t, [root(), lf('a', { expects: ['src/a.mjs', 'test/a.test.mjs'] })])
  const o = open(w, 'a')
  commit(o.worktree, A_FILES, 'Add a')
  write(o.worktree, { 'README.md': 'hello\nedited\n' })
  const spec = { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha }
  return { w, o, spec, dispatch: stored(w, spec) }
}

test('a close that puts work back and measures asks no git question twice in one directory without a write between', SLOW, async (t) => {
  const { w, spec, dispatch } = stray(t)
  const counter = counting(t)
  const out = await close(w, { ...spec, dispatch })
  counter.stop()
  assert.ok(out.decision, JSON.stringify(out))
  assert.ok(gits(counter.seen) > 0, "the counter saw the close's git processes")
  assert.equal(children(counter.seen), 1, 'the head is measured once')
  assert.deepEqual(repeats(counter.seen), [])
})

test('a shell-less close asks no git question twice in one directory without a write between', SLOW, async (t) => {
  const { w, o } = testsOnly(t)
  write(o.worktree, { 'test/more.test.mjs': MORE_TEST })
  const spec = { node: 't', role: 'test-author', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha }
  const dispatch = stored(w, spec)
  const counter = counting(t)
  await close(w, { ...spec, dispatch })
  counter.stop()
  assert.ok(gits(counter.seen) > 0, "the counter saw the close's git processes")
  assert.equal(children(counter.seen), 1)
  assert.deepEqual(repeats(counter.seen), [])
})

test('a status read after the close puts work back sees it put back', SLOW, async (t) => {
  const { w, o, spec, dispatch } = stray(t)
  const tip = head(o.worktree)
  await close(w, { ...spec, dispatch })

  assert.equal(head(o.worktree), tip, 'nothing is committed for the stray edit')
  assert.equal(git(o.worktree, 'status', '--porcelain'), '', 'the stray edit is put back')
  const lines = observed(w, 'a')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].head_sha, tip)

  // Run again, the close keys its measurement by the head and status as they stand: had the first
  // run keyed it on a read from before it put the edit back, this one would measure again.
  await close(w, { ...spec, dispatch })
  assert.equal(observed(w, 'a').length, 1, 'the measurement is reused')
  assert.equal(rec(w, 'a', 'implementer', 1).head_sha, tip)
})

test('a commit made between two closes is the head the second close reads', SLOW, async (t) => {
  const w = world(t, [root(), lf('a', { expects: ['src/a.mjs', 'test/a.test.mjs'] })])
  const o = open(w, 'a')
  const first = commit(o.worktree, A_FILES, 'Add a')
  await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
  const second = commit(o.worktree, { 'src/a.mjs': 'export const a = () => 1 // again\n' }, 'Again')
  await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: first })

  assert.equal(rec(w, 'a', 'implementer', 2).head_sha, second)
  assert.equal(observed(w, 'a').at(-1).head_sha, second)
})

test("a move of the user's checkout between two closes is no fault of the second", SLOW, async (t) => {
  const w = world(t, [root(), lf('a', { expects: ['src/a.mjs', 'test/a.test.mjs'] })])
  const o = open(w, 'a')
  const first = commit(o.worktree, A_FILES, 'Add a')
  await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
  git(w.r, 'branch', 'side')
  commit(o.worktree, { 'src/a.mjs': 'export const a = () => 1 // again\n' }, 'Again')
  const { out } = await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: first })

  assert.notEqual(out.decision.reason, 'checkout', JSON.stringify(out.decision))
})
