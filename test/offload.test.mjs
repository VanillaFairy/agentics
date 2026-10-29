// test/offload.test.mjs — lib/offload.mjs: lib work runs on one warm worker thread, its failures
// reject (no in-process fallback), a hung git stays GitHung, a worker that died is replaced, and the
// watchdog records a long request while it still runs.
//
// Design: docs/DESIGN.md#the-process-model.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { offload, watchdog } from '../lib/offload.mjs'
import { GitHung } from '../lib/store.mjs'

const WORK = '../test/fixtures/offload-work.mjs'

test('a lib function runs on the worker and its value comes back', async () => {
  assert.equal(await offload('store.mjs', 'posix', ['a' + String.fromCharCode(92) + 'b']), 'a/b')
})

test('a failure rejects with its message, and a hung git rejects as GitHung', async () => {
  await assert.rejects(offload(WORK, 'fails', []), /it failed/)
  await assert.rejects(offload(WORK, 'hangs', []), (err) => err instanceof GitHung && err.code === 'git_hung' && err.label === 'git merge')
})

test('a worker that died rejects what it held, and the next request is answered by a new one', async () => {
  await assert.rejects(offload(WORK, 'dies', []), /exited/)
  assert.equal(await offload(WORK, 'hold', [1]), 1)
})

test('the watchdog records a long request while it still runs, once, with its label', async () => {
  const seen = []
  const dog = watchdog((s) => seen.push({ ...s, settled }), { stallMs: 100, everyMs: 20 })
  let settled = false
  const work = offload(WORK, 'hold', [800], { label: 'the long one' }).then((v) => { settled = true; return v })
  assert.equal(await work, 800)
  dog.stop()
  assert.deepEqual(seen.map((s) => [s.label, s.settled]), [['the long one', false]])
  assert.ok(Number.isFinite(Date.parse(seen[0].since)))
})
