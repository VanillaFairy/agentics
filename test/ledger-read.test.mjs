// test/ledger-read.test.mjs — pins how lib/ledger.mjs reads a log it read before: only the
// whole lines appended since, the file parsed whole again when its earlier bytes changed or it
// shrank, a line not yet ended counted malformed until it is, and the entries it hands out frozen.
//
// Design: docs/DESIGN.md#storage.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readLog } from '../lib/ledger.mjs'
import { effortStateDir } from '../lib/store.mjs'

const E = 'e1'

function events(t) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-ledger-read-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  mkdirSync(effortStateDir(repo, E), { recursive: true })
  return { repo, path: join(effortStateDir(repo, E), 'events.jsonl') }
}
const line = (seq) => JSON.stringify({ kind: 'noted', node: 'a', text: 'n' + seq, seq }) + '\n'
const seqs = (repo) => readLog(repo, E, 'events').entries.map((e) => e.seq)

test('a log read again gives the lines appended since, and a rewrite of its earlier bytes is read whole', (t) => {
  const { repo, path } = events(t)
  writeFileSync(path, line(1) + line(2))
  assert.deepEqual(seqs(repo), [1, 2])
  appendFileSync(path, line(3))
  assert.deepEqual(seqs(repo), [1, 2, 3])
  writeFileSync(path, line(7) + line(8) + line(9) + line(10))
  assert.deepEqual(seqs(repo), [7, 8, 9, 10], 'longer, but not the same bytes: read whole')
  writeFileSync(path, line(4))
  assert.deepEqual(seqs(repo), [4], 'shorter: read whole')
})

test('a last line not yet ended is malformed until it is whole, then read once', (t) => {
  const { repo, path } = events(t)
  const whole = line(2)
  writeFileSync(path, line(1) + whole.slice(0, 10))
  const torn = readLog(repo, E, 'events')
  assert.deepEqual([torn.entries.map((e) => e.seq), torn.malformed], [[1], 1])
  appendFileSync(path, whole.slice(10))
  const healed = readLog(repo, E, 'events')
  assert.deepEqual([healed.entries.map((e) => e.seq), healed.malformed], [[1, 2], 0])
})

test('the entries handed out are frozen, and each read gets an array of its own', (t) => {
  const { repo, path } = events(t)
  writeFileSync(path, line(1))
  const a = readLog(repo, E, 'events').entries
  assert.throws(() => { a[0].seq = 99 }, TypeError)
  a.push({ kind: 'x' })
  assert.deepEqual(seqs(repo), [1])
})
