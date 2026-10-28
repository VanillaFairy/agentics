// test/fast/rename-over.test.mjs — pins that a whole-file write survives Windows refusing a rename
// over a file another process holds open for a moment, and gives up on anything else.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renameOver } from '../../lib/store.mjs'

const refusal = (code) => Object.assign(new Error(code + ': operation not permitted, rename'), { code })

/** A rename that throws each of `codes` once, in turn, then succeeds; the calls and waits it saw. */
function flaky(codes) {
  const seen = { renames: 0, waits: [] }
  const rename = () => {
    seen.renames++
    if (seen.renames <= codes.length) throw refusal(codes[seen.renames - 1])
  }
  return { seen, rename, pause: (ms) => seen.waits.push(ms) }
}

test('a rename refused while the destination is held open is tried again until it lands', () => {
  const { seen, rename, pause } = flaky(['EPERM', 'EACCES', 'EBUSY'])
  renameOver('a.tmp', 'a', rename, pause)
  assert.equal(seen.renames, 4)
  assert.equal(seen.waits.length, 3)
})

test('a refusal that is not a held file is thrown at once', () => {
  const { seen, rename, pause } = flaky(['ENOENT'])
  assert.throws(() => renameOver('a.tmp', 'a', rename, pause), /ENOENT/)
  assert.equal(seen.renames, 1)
})

test('a destination held past the waits is thrown, not waited on for ever', () => {
  const { seen, rename, pause } = flaky(Array(1000).fill('EPERM'))
  assert.throws(() => renameOver('a.tmp', 'a', rename, pause), /EPERM/)
  assert.ok(seen.renames < 1000, String(seen.renames))
})
