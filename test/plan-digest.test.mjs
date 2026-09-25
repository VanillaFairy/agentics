// test/plan-digest.test.mjs — pins the tripwire that stands between a plan and a model.
//
// The digest exists to catch a paraphrase, so the tests that matter are the ones that assert
// what it does NOT ignore: a reworded context, a dropped acceptance entry, a rewritten locus.
// The counterpart is just as load-bearing — a key reordered on the way through a model is
// not corruption, and a digest that fired on it would halt every honest resume.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'

const CLI = fileURLToPath(new URL('../lib/plan-digest.mjs', import.meta.url))

const order = (over = {}) => ({
  id: 'W1',
  title: 'add the parser',
  locus: ['src/parse.js', 'test/parse.test.js'],
  acceptance: ['node --test passes', 'HUMAN: the error message reads clearly'],
  context: 'The tokenizer already exists in src/lex.js.',
  deps: [],
  contract: false,
  ...over,
})

// --- canonical serialization -------------------------------------------------------------

test('object keys are sorted, so a reordered plan digests the same', () => {
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }))
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}')
})

test('array order is content, not formatting, and is preserved', () => {
  assert.notEqual(canonical(['a', 'b']), canonical(['b', 'a']))
})

test('nested objects are sorted at every depth', () => {
  assert.equal(canonical({ x: { d: 1, c: 2 } }), '{"x":{"c":2,"d":1}}')
})

test('undefined and null serialize alike — a missing field is not a different field', () => {
  assert.equal(canonical(undefined), 'null')
  assert.equal(canonical({ a: undefined }), canonical({ a: null }))
})

test('strings are JSON-escaped, so a quote in a context cannot forge structure', () => {
  assert.equal(canonical('a"b'), '"a\\"b"')
})

// --- the hash ----------------------------------------------------------------------------

test('fnv1a returns eight lowercase hex digits, zero-padded', () => {
  for (const input of ['', 'a', 'the quick brown fox', '{"a":1}']) {
    assert.match(fnv1a(input), /^[0-9a-f]{8}$/, `bad shape for ${JSON.stringify(input)}`)
  }
})

test('fnv1a matches the published vectors — the constant pair is not a typo', () => {
  // FNV-1a 32-bit reference values. If the offset basis or the prime is ever mistyped, the
  // digest still LOOKS fine and still round-trips within one process — it only stops
  // matching a manifest written by an older build, which is exactly the silent failure a
  // fixed vector catches.
  assert.equal(fnv1a(''), '811c9dc5')
  assert.equal(fnv1a('a'), 'e40c292c')
  assert.equal(fnv1a('foobar'), 'bf9cf968')
})

test('fnv1a is deterministic across calls', () => {
  assert.equal(fnv1a('agentics'), fnv1a('agentics'))
})

// --- what the order digest catches -------------------------------------------------------
