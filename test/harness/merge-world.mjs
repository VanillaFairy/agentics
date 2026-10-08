// test/harness/merge-world.mjs — the worlds the boundaries-merge-batch, -stops and -gate tests share: a
// repository with a tree and the execution preflight would have written, leaves opened and ready,
// and the readers of the records a batch leaves. Nothing here runs at import.

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeSessionCommands } from '../../lib/boundaries/execution.mjs'
import { mergeBatch } from '../../lib/boundaries/merge.mjs'
import { executionContext } from '../../lib/boundaries/records.mjs'
import { ensureIntegration, ensureLeaf } from '../../lib/integration.mjs'
import { executionLog, readLog } from '../../lib/ledger.mjs'
import { acquire } from '../../lib/locks.mjs'
import { branchOf, executionDir, mkdirState } from '../../lib/store.mjs'
import { readTree } from '../../lib/tree.mjs'
import { COMMANDS, STAMP, commitIn, git, leaf, repo } from './boundary-fixture.mjs'
import { seedTree } from './seed-tree.mjs'

export const E = 'e1'
export const SLOW = { timeout: 300_000 }
export const SPLIT = { ...COMMANDS, suite_fast: 'node --test --test-reporter=spec test/add.test.mjs' }
export const BREAK_ADD = 'export const add = (a, b) => a - b\n'
export const FLIP_ADD = 'export const add = (a, b) => b + a\n'
export const BREAK_BIG = 'export const add = (a, b) => (a === 2 && b === 2 ? 5 : a + b)\n'

export const R_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { r } from '../src/r.mjs'\ntest('r is 1', () => assert.equal(r(), 1))\n"
const BIG_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../../src/add.mjs'\ntest('adds big', () => assert.equal(add(2, 2), 4))\n"

// ================================================================== a world to merge in

export const rm = (r) => { try { rmSync(r, { recursive: true, force: true, maxRetries: 3 }) } catch { /* a handle held on Windows */ } }
export const inTest = (t) => (fn) => t.after(fn)

export const ctxOf = (r) => executionContext({ repo: r, effort: E, execution: STAMP, log: executionLog(r, E, STAMP) })
export const stateOf = (r) => readLog(r, E, 'state:' + STAMP).entries
export const eventsOf = (r) => readLog(r, E, 'events').entries
export const journalOf = (r) => readLog(r, E, 'journal:' + STAMP).entries
export const headOf = (r, id) => git(r, 'rev-parse', 'refs/heads/' + branchOf(E, id))
export const statusOf = (r, id) => readTree(r, E).status.get(id).status
export const ids = (list) => list.map((x) => x.id)
export const stopsOf = (out) => out.stops.map((s) => [s.id, s.status, s.reason])
export const kindOf = (entries, kind, node) => entries.filter((e) => e.kind === kind && (node === undefined || e.node === node))

/**
 * A repository, a seeded tree, and the envelope and session commands preflight would have written. `register` takes the
 * cleanup (`t.after`, or the module's `after`); `prepare` changes the repository before the base
 * commit is read; `envelope: false` leaves the execution without its `execution.json`.
 */
export function world(register, nodesOf, { commands = COMMANDS, prepare, envelope = true } = {}) {
  const r = repo()
  register(() => rm(r))
  if (prepare) prepare(r)
  const nodes = typeof nodesOf === 'function' ? nodesOf(r) : nodesOf
  const seeded = seedTree(r, E, nodes)
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems || seeded.error))
  const base = git(r, 'rev-parse', 'HEAD')
  const dir = executionDir(r, E, STAMP)
  mkdirState(dir)
  if (envelope) {
    writeFileSync(join(dir, 'execution.json'), JSON.stringify({
      stamp: STAMP, root: '.', base_branch: 'main', base_sha: base, dial: 'normal', pace: 'balanced', commands,
    }))
  }
  const xc = ctxOf(r)
  if (envelope) writeSessionCommands(xc, xc.envelope())
  return { r, xc, base }
}

export function integrationOf(w, folder = '.') {
  const out = ensureIntegration(w.r, E, folder, w.xc.envelope())
  assert.equal(out.ok, true, out.error)
  return out
}

export const dispatch = (w, id, round) => w.xc.log.append('dispatched', {
  dispatch: 'd-' + id.replace(/[^A-Za-z0-9]/g, '-') + '-r' + round, node: id, round, thread: 'producer:' + id, role: 'implementer',
})

/** What leaf-open does: the locus, the folder's branch, the leaf's branch and worktree, round 1. */
function openLeaf(w, id, { folder = '.', from, cycleMember = false } = {}) {
  const node = readTree(w.r, E).nodes.get(id)
  const held = acquire(w.r, { effort: E, execution: STAMP, node: id, locus: node.locus })
  assert.equal(held.ok, true, JSON.stringify(held))
  const integ = integrationOf(w, folder)
  const made = ensureLeaf(w.r, E, id, { from: from || integ.head, parentBranch: integ.branch, cycleMember })
  assert.equal(made.ok, true, made.error)
  dispatch(w, id, 1)
  return { id, worktree: made.worktree, branch: made.branch }
}

/** A leaf opened and its change committed: `{id, head_sha, worktree, branch}`. */
export function ready(w, id, files, subject, opts) {
  const open = openLeaf(w, id, opts)
  return { ...open, head_sha: commitIn(open.worktree, files, subject) }
}

export const handed = (...leaves) => leaves.map((l) => ({ id: l.id, head_sha: l.head_sha }))
export const batch = (w, children, extra = {}) => mergeBatch(w.xc, { target: '.', children, cycles: [], ...extra })

/** Put another branch where the integration worktree was, so nothing can attach it again. */
export function takeWorktree(w, integ) {
  git(w.r, 'worktree', 'remove', '--force', integ.worktree)
  git(w.r, 'worktree', 'add', '-q', '-b', 'other', integ.worktree)
}

/** Create a branch in the user's checkout, from a timer; the failure is kept, never thrown into the loop. */
export function moveCheckout(w, state) {
  try {
    git(w.r, 'branch', 'side')
    state.moved = true
  } catch (e) {
    state.error = e
  }
}

export const addBigTest = (r) => {
  mkdirSync(join(r, 'test', 'big'))
  writeFileSync(join(r, 'test', 'big', 'add.test.mjs'), BIG_TEST)
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'a big test')
}

export const addOne = (id, extra) => leaf(id, { rigor: 'trivial', locus: ['src/add.mjs'], ...extra })
