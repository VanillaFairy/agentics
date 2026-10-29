// test/fast/send-back-guard.test.mjs — pins the lint rule that keeps every send-back behind the loop
// guard: a lib line that builds a message handing a producer more work is a finding anywhere but in
// the guard itself; a message that hands no work is not.
//
// Design: docs/DESIGN.md#l2--states-end-work-counts-dont.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SEND_BACKS } from '../../lib/boundaries/loop-guard.mjs'
import { check } from '../../tools/rules/send-back-guard.mjs'

test('a send-back built outside the guard is a finding on its line', () => {
  for (const msg of SEND_BACKS) {
    const src = '// a close\nrecordAll(xc, [message(node, thread, \'' + msg + '\', {}, round + 1)])'
    assert.deepEqual(check(src, 'lib/boundaries/leaf-close.mjs').map((v) => v.line), [2], msg)
  }
})

test('the guard builds them, and a message that hands no work is built anywhere', () => {
  assert.deepEqual(check("message(node, thread, 'failures', {}, 2)", 'lib/boundaries/loop-guard.mjs'), [])
  assert.deepEqual(check("message(node, thread, 'tests_ready', {}, 2)", 'lib/boundaries/leaf-close.mjs'), [])
})

test('a send-back laid out over lines, in double quotes, or built as a record by hand is a finding', () => {
  assert.equal(check('message(node, thread,\n  "failures", {}, 2)', 'lib/x.mjs').length, 1)
  assert.equal(check("({ kind: 'message', fields: { node, msg: 'rebase' } })", 'lib/x.mjs').length, 1)
  assert.equal(check("sendBack(history, { node, msg: 'failures', guard })", 'lib/x.mjs').length, 0, 'asking the guard is no building')
})
