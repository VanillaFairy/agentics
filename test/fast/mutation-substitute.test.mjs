// test/fast/mutation-substitute.test.mjs — pins that a declared mutation is matched whatever line
// endings the checkout gave the file: an agent writes `find` against the committed blob (LF), and a
// `core.autocrlf` checkout holds it CRLF.
//
// Design: docs/DESIGN.md#verify-payload.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { substitute } from '../../lib/verify.mjs'

const LF = "export function drop(store, area) {\n    store.remove(area, 'record');\n}\n"
const CRLF = LF.replace(/\n/g, '\r\n')
const FIND = "    store.remove(area, 'record');\n"
const REPLACE = '    // removed\n'

test('an LF find matches a CRLF checkout once, and the replace is written in the file\'s endings', () => {
  const { hits, mutated } = substitute(CRLF, FIND, REPLACE)
  assert.equal(hits, 1)
  assert.equal(mutated, CRLF.replace(FIND.replace(/\n/g, '\r\n'), REPLACE.replace(/\n/g, '\r\n')))
  assert.equal(mutated.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF is left in a CRLF file')
})

test('a find as written is matched as written, in an LF file or a CRLF one', () => {
  assert.equal(substitute(LF, FIND, REPLACE).mutated, LF.replace(FIND, REPLACE))
  const crlfFind = FIND.replace(/\n/g, '\r\n')
  assert.equal(substitute(CRLF, crlfFind, 'x').mutated, CRLF.replace(crlfFind, 'x'))
})

test('a find in neither form, or an empty one, is no hit', () => {
  assert.deepEqual(substitute(CRLF, 'store.add(', 'x'), { hits: 0, mutated: CRLF })
  assert.equal(substitute(CRLF, '', 'x').hits, 0)
})
