// test/commit-series-truncation.test.mjs — pins the self-audit fix to `parseLog`: a
// malformed record now throws instead of being silently skipped.
//
// The defect this pins away: `parseLog` used to `continue` past a record with no field
// separator, so a corrupt or truncated `git log` stream yielded a SHORT series that
// `analyzeSeries` then judged as if it were the whole one — a measurement failure wearing
// the shape of a clean answer, the exact laundering IL2 forbids. The CLI's
// existing catch turns the throw into `{"error": ...}`, which the verifier maps to
// `stop_reason: 'environment_broken'` — unmeasurable, not failed.
//
// What is deliberately preserved: text BEFORE the first \x01 is not a record and is still
// dropped without complaint (real output starts with the delimiter, and the split used to
// produce a leading empty chunk). Only a separator-less chunk AFTER the first delimiter
// is impossible in healthy output.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLog } from '../../lib/commit-series.mjs'

const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a'

test('a record with no field separator throws a TypeError instead of shortening the series', () => {
  // The second record lost its \x02 — the stream was cut mid-record. The old parser
  // returned one commit and no complaint.
  const text =
    `\x01${SHA_A}\x02add the parser\n\nlib/a.mjs\n` +
    `\x01${SHA_B} a subject with no separator\n`

  assert.throws(() => parseLog(text), (err) => {
    assert.ok(err instanceof TypeError)
    assert.match(err.message, /corrupt or truncated/)
    return true
  })
})

test('a lone separator-less chunk after a valid record throws even when tiny', () => {
  const text = `\x01${SHA_A}\x02ok\n\nlib/a.mjs\n\x01garbage`

  assert.throws(() => parseLog(text), TypeError)
})

test('text before the first delimiter is still dropped, not treated as a record', () => {
  // e.g. a stray warning line something printed to stdout ahead of the log.
  const text = `warning: something harmless\n\x01${SHA_A}\x02add the parser\n\nlib/a.mjs\n`

  assert.deepEqual(parseLog(text), [
    { sha: SHA_A, subject: 'add the parser', trailers: '', files: ['lib/a.mjs'] },
  ])
})

test('input with no delimiter at all is an empty series, not an error', () => {
  // An empty range produces empty output; junk-only output produces no records. Both are
  // "zero commits", which analyzeSeries already reports as the blocking empty-series
  // finding — a different statement from "the stream broke mid-record".
  assert.deepEqual(parseLog(''), [])
  assert.deepEqual(parseLog('no records here'), [])
})
