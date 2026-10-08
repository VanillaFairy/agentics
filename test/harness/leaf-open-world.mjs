// test/harness/leaf-open-world.mjs — what the boundaries-leaf-open-* tests share: a repository with a
// tree and an execution, a dispatch ran with its return, and the readers of the records leaf-open
// leaves. Nothing here runs at import.

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { leafOpen } from '../../lib/boundaries/leaf-open.mjs'
import { executionContext } from '../../lib/boundaries/records.mjs'
import { executionLog } from '../../lib/ledger.mjs'
import { TEST_GLOBS } from '../../lib/locus.mjs'
import { loadRole } from '../../lib/roles.mjs'
import { closePath, dispatchKey, returnPath, reviewPath, writeWhole } from '../../lib/store.mjs'
import { readTree } from '../../lib/tree.mjs'
import { COMMANDS, STAMP, commitIn, git, leaf, repo, root } from './boundary-fixture.mjs'
import { seedTree } from './seed-tree.mjs'

export const E = 'e1'
export const RED = "import { test } from 'node:test'\ntest('r', () => {})\n"

export const globRule = (rule) => TEST_GLOBS.some((g) => rule.endsWith(`${g})`))

/** A repository with `nodes` under the root, compiled, and an execution whose envelope stands. */
export function setup(t, nodes, envelope = {}) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  const seeded = seedTree(r, E, [root(), ...nodes])
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems))
  const xc = executionContext({ repo: r, effort: E, execution: STAMP, log: executionLog(r, E, STAMP) })
  mkdirSync(xc.dir, { recursive: true })
  writeFileSync(join(xc.dir, 'execution.json'), JSON.stringify({
    stamp: STAMP, root: '.', base_branch: 'main', base_sha: git(r, 'rev-parse', 'HEAD'), dial: 'normal', pace: 'balanced',
    commands: COMMANDS, ...envelope,
  }))
  return { r, xc }
}

/** A round the runner dispatched: its `dispatched` event and, given `ret`, its stored return and `returned`. */
export function ran(xc, { node, round, role, thread, model = 'opus', effort = 'medium', ret = null, log = xc.log }) {
  const dispatch = dispatchKey({ node, role, thread, round })
  log.append('dispatched', { dispatch, node, round, thread, role, model, effort, session: 's-' + dispatch, brief_digest: 'd', brief_parts: {}, carries: [], pid: 0 })
  if (ret) {
    writeWhole(returnPath(xc.dir, dispatch), ret)
    log.append('returned', { dispatch, session: 's-' + dispatch, status: 'returned', cause: '', usage: null, cost_total: null, cost_usd: null, denials: [] })
  }
  return dispatch
}

/** A close record where leaf-close writes it. */
export const closed = (xc, { node, role, round, ...fields }) =>
  writeWhole(closePath(xc.repo, E, STAMP, node, role, round), { node, role, round, raise: false, measurement: null, decision: { next: 'fix', reason: '', failures: [] }, ...fields })

/** A review record where leaf-review writes it. */
export const reviewed = (xc, { node, round, review_round, ...fields }) =>
  writeWhole(reviewPath(xc.repo, E, STAMP, node, review_round), { node, round, review_round, next: 'fix', open: [], raise: false, ...fields })

export const nodeOf = (r, id) => readTree(r, E).nodes.get(id)
export const roleOf = (name) => loadRole(name).role

/** A red approved at its head and its green opened at round 1: the ground of the cycle's test session. */
export async function cycle(t, rigor = 'tdd-pair', extra = []) {
  const { r, xc } = setup(t, [
    leaf('r', { rigor, role: 'red', locus: ['test/r.test.mjs'] }),
    leaf('g', { rigor, role: 'green', deps: ['r'], locus: ['src/r.mjs'] }),
    ...extra,
  ])
  const red = await leafOpen(xc, { node: 'r' })
  const redHead = commitIn(red.cwd, { 'test/r.test.mjs': RED }, 'Pin r')
  ran(xc, { node: 'r', round: 1, role: 'test-author', thread: 'producer:r', ret: { status: 'done' } })
  xc.log.append('approved', { node: 'r', head_sha: redHead, review_rounds: 1, at_integration: false })
  const green = await leafOpen(xc, { node: 'g' })
  return { r, xc, green, redHead }
}

/** The green's implementer returned `needs_tests` at `round` and was closed so: leaf-close records the request at `round + 1`. */
export function askedForTests(xc, round = 1) {
  ran(xc, { node: 'g', round, role: 'implementer', thread: 'producer:g', ret: { status: 'needs_tests' } })
  closed(xc, { node: 'g', role: 'implementer', round })
  xc.log.append('message', { node: 'g', thread: 'producer:r', from: 'implementer', msg: 'needs_tests', payload: { text: 'nothing pins the empty case' }, round: round + 1 })
}
