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
import { canonical, fnv1a, digestOrder, manifestOf } from '../lib/plan-digest.mjs'

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

test('an identical order digests identically', () => {
  assert.equal(digestOrder(order()), digestOrder(order()))
})

test('a paraphrased context changes the digest — the field a count manifest cannot see', () => {
  assert.notEqual(
    digestOrder(order()),
    digestOrder(order({ context: 'The tokenizer already lives in src/lex.js.' })),
  )
})

test('a rewritten locus path changes the digest even at the same length', () => {
  assert.notEqual(
    digestOrder(order()),
    digestOrder(order({ locus: ['src/parser.js', 'test/parse.test.js'] })),
  )
})

test('a dropped acceptance entry changes the digest', () => {
  assert.notEqual(
    digestOrder(order()),
    digestOrder(order({ acceptance: ['node --test passes'] })),
  )
})

test('a flipped contract flag changes the digest', () => {
  assert.notEqual(digestOrder(order()), digestOrder(order({ contract: true })))
})

test('a field outside the seven contract fields does not change the digest', () => {
  // A model that echoes the object with a harmless extra key has corrupted nothing the
  // pipeline reads, and a halt on that would be the linter being wrong about the plan.
  assert.equal(digestOrder(order()), digestOrder({ ...order(), scratch: 'ignored' }))
})

test('key order inside the order object does not change the digest', () => {
  const reordered = { contract: false, deps: [], context: order().context,
                      acceptance: order().acceptance, locus: order().locus,
                      title: order().title, id: 'W1' }
  assert.equal(digestOrder(order()), digestOrder(reordered))
})

// --- the manifest ------------------------------------------------------------------------

test('the manifest carries id, both counts, and the digest per order', () => {
  const [entry] = manifestOf([order()])

  assert.equal(entry.id, 'W1')
  assert.equal(entry.locus_n, 2)
  assert.equal(entry.acceptance_n, 2)
  assert.equal(entry.digest, digestOrder(order()))
  assert.deepEqual(Object.keys(entry).sort(), ['acceptance_n', 'digest', 'id', 'locus_n'])
})

test('a missing locus or acceptance counts as zero rather than throwing', () => {
  const [entry] = manifestOf([{ id: 'W9', title: 't', context: 'c', deps: [], contract: false }])

  assert.equal(entry.locus_n, 0)
  assert.equal(entry.acceptance_n, 0)
})

test('the manifest preserves input order', () => {
  const ids = manifestOf([order({ id: 'W2' }), order({ id: 'W1' })]).map((e) => e.id)
  assert.deepEqual(ids, ['W2', 'W1'])
})

// --- the CLI, which is also the plan file's validator ------------------------------------

test('the CLI prints a manifest for a well-formed plan file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentics-digest-'))
  try {
    const path = join(dir, 'plan.json')
    await writeFile(path, JSON.stringify({ work_orders: [order()] }), 'utf8')

    const out = JSON.parse(execFileSync(process.execPath, [CLI, path], { encoding: 'utf8' }))
    assert.deepEqual(out.manifest, manifestOf([order()]))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('malformed JSON prints an error object rather than a manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentics-digest-'))
  try {
    const path = join(dir, 'plan.json')
    await writeFile(path, '{ "work_orders": [', 'utf8')

    // Non-zero exit, so execFileSync throws; the payload is still on stdout, which is what
    // makes this CLI the planner's write-validator as well as its digest source.
    let stdout = ''
    try {
      execFileSync(process.execPath, [CLI, path], { encoding: 'utf8', stdio: 'pipe' })
      assert.fail('the CLI must exit non-zero on malformed input')
    } catch (err) {
      stdout = err.stdout
    }

    assert.ok(JSON.parse(stdout).error, 'the error travels as data on stdout')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a plan file with no work_orders array is an error, not an empty manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentics-digest-'))
  try {
    const path = join(dir, 'plan.json')
    await writeFile(path, JSON.stringify({ notes: 'nothing here' }), 'utf8')

    let stdout = ''
    try {
      execFileSync(process.execPath, [CLI, path], { encoding: 'utf8', stdio: 'pipe' })
      assert.fail('the CLI must exit non-zero when work_orders is absent')
    } catch (err) {
      stdout = err.stdout
    }

    assert.match(JSON.parse(stdout).error, /work_orders/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
