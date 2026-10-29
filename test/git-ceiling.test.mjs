// test/git-ceiling.test.mjs — every git is killed at its ceiling: a synchronous one throws `GitHung`,
// so no caller reads a killed git as an answer, and an awaited one resolves with its message.
//
// Design: docs/DESIGN.md#the-process-model.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'

import { GitHung, gitAsync, gitSync } from '../lib/store.mjs'

/** A git that waits on nothing it will ever get: an alias that sleeps far past the ceiling. */
const HANG = ['-c', 'alias.hang=!sleep 60', 'hang']

test('a synchronous git past its ceiling is killed and throws GitHung, and one inside it returns', () => {
  const t0 = Date.now()
  assert.throws(() => gitSync(tmpdir(), HANG, { ceilingMs: 300 }), (err) => err instanceof GitHung && err.code === 'git_hung')
  assert.ok(Date.now() - t0 < 30000, 'killed, not waited out')
  assert.equal(gitSync(tmpdir(), ['version'], { ceilingMs: 30000 }).status, 0)
})

test('an awaited git past its ceiling is killed and resolves failed with the hang', async () => {
  const r = await gitAsync(tmpdir(), HANG, { ceilingMs: 300 })
  assert.equal(r.status, -1)
  assert.match(r.stderr, /ran past 300 ms/)
})
