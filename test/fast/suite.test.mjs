// test/fast/suite.test.mjs — what tools/suite.mjs decides: which tests were flakes and which
// red, and what a command line means. The runs themselves are node's and are not repeated here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONCURRENCY, classify, parseArgs, readFailures } from '../../tools/suite.mjs'

const run = (code, failed = []) => ({ code, failed })

test('a green first run has nothing to classify', () => {
  assert.deepEqual(classify(run(0), run(0)), { flake: [], red: [], ok: true })
})

test('a test that fails the repeat too is red, one that passes it is a flake', () => {
  const verdict = classify(run(1, ['a', 'b', 'c']), run(1, ['b']))
  assert.deepEqual(verdict.flake, ['a', 'c'])
  assert.deepEqual(verdict.red, ['b'])
  assert.equal(verdict.ok, false)
})

test('every failure of the first run passing the repeat leaves nothing red', () => {
  const verdict = classify(run(1, ['a', 'b']), run(0))
  assert.deepEqual(verdict.flake, ['a', 'b'])
  assert.deepEqual(verdict.red, [])
  assert.equal(verdict.ok, true)
})

test('a failure only the repeat reports is red, and listed once', () => {
  const verdict = classify(run(1, ['a']), run(1, ['a', 'z']))
  assert.deepEqual(verdict.red, ['a', 'z'])
  assert.deepEqual(verdict.flake, [])
})

test('a repeat that fails without naming a test is not ok', () => {
  assert.equal(classify(run(1, ['a']), run(1)).ok, false)
  assert.equal(classify(run(1), run(1)).ok, false)
})

test('the command line selects the fast tier, named files or everything, never two of them', () => {
  assert.deepEqual(parseArgs([]), { fast: false, concurrency: DEFAULT_CONCURRENCY, files: [] })
  assert.deepEqual(parseArgs(['--fast']), { fast: true, concurrency: DEFAULT_CONCURRENCY, files: [] })
  assert.deepEqual(parseArgs(['a.test.mjs', 'b.test.mjs']).files, ['a.test.mjs', 'b.test.mjs'])
  assert.ok(parseArgs(['--fast', 'a.test.mjs']).error)
})

test('concurrency is a positive integer in either spelling', () => {
  assert.equal(parseArgs(['--concurrency', '3']).concurrency, 3)
  assert.equal(parseArgs(['--concurrency=5', '--fast']).concurrency, 5)
  for (const bad of [['--concurrency'], ['--concurrency', '0'], ['--concurrency=-1'], ['--concurrency', 'x'], ['--concurrency=2.5']]) {
    assert.ok(parseArgs(bad).error, bad.join(' '))
  }
})

test('an unknown option is refused rather than taken for a file', () => {
  assert.match(parseArgs(['--fats']).error, /unknown option/)
})

test('failures are read back as repo-relative ids, and a missing file is no failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'suite-test-'))
  try {
    const file = join(dir, 'failures.jsonl')
    assert.deepEqual(readFailures(file, dir), [])
    const lines = [
      { name: 'one', file: join(dir, 'test', 'x.test.mjs'), line: 3, column: 1 },
      { name: 'two', file: undefined, line: 1, column: 1 },
    ]
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    assert.deepEqual(readFailures(file, dir), ['test/x.test.mjs:3:1 one', '(no file):1:1 two'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
