// test/fast/verify-output.test.mjs — lib/verify.mjs, pure over a directory: how `extractFailures`
// places a suite's failures in their files, and the closed test-file pattern set (`isTestPath`).
// The suite's output carried through a real verify() is test/verify-output.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import { extractFailures } from '../../lib/verify.mjs'
import { isTestPath } from '../../lib/store.mjs'

/** A directory holding the empty `files`: a failure is placed only in a test file that exists there. */
function tree(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-failures-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), '')
  }
  return dir.split(sep).join('/')
}

test('two TAP failures in two files are each placed in their own, never the previous one\'s', (t) => {
  const worktree = tree(t, ['test/widget.test.mjs', 'test/other.test.mjs'])
  const at = (file) => "  location: '" + worktree + '/test/' + file + ":5:1'"

  const found = extractFailures([
    'not ok 1 - first failure', '  ---', at('widget.test.mjs'), '  ...',
    'not ok 2 - second failure', '  ---', "  type: 'test'", at('other.test.mjs'), '  ...',
  ].join('\n'), worktree)

  assert.equal(found.unplaced, 0)
  assert.deepEqual(found.failures, [
    { file: 'test/widget.test.mjs', id: 'first failure' },
    { file: 'test/other.test.mjs', id: 'second failure' },
  ])
})

test('a TAP failure whose block names no location falls back to the path in force at its marker', (t) => {
  const worktree = tree(t, ['test/widget.test.mjs'])

  const found = extractFailures([
    '# Subtest: ' + worktree + '/test/widget.test.mjs', 'not ok 1 - test/widget.test.mjs', '  ---', '  ...',
    'not ok 2 - nameless', '  ---', "  type: 'test'", '  ...',
  ].join('\n'), worktree)

  assert.deepEqual(found.failures.map((f) => f.file), ['test/widget.test.mjs', 'test/widget.test.mjs'])
  assert.equal(found.unplaced, 0)
})

test('the test-file pattern set recognises the shapes it claims to', () => {
  for (const path of ['test/a.test.mjs', 'tests/b.py', 'src/__tests__/c.js', 'spec/d.rb',
    'lib/e.spec.ts', 'pkg/f_test.go', 'app/test_g.py', 'src/WidgetTest.java']) {
    assert.ok(isTestPath(path), path + ' should read as a test file')
  }
  for (const path of ['src/widget.mjs', 'docs/testing.md', 'latest/thing.js', 'src/protest.c']) {
    assert.ok(!isTestPath(path), path + ' should not read as a test file')
  }
})

//
// The scanner's summary guard exists so a runner's counters are not attributed to whatever file
// was printed last. Its cost, until 20260902-124933, was that `tests/` is also how most of the
// world names its test directory: `\b` treats `/` as a word boundary, so every vitest and jest
// `FAIL tests/…` line read as the summary word `tests` and was discarded. The suite then failed
// while naming nothing, which is `suite_failures_unnamed`, which is `environment_broken`, which
// `verifiable()` refuses — so a correct red order could not be verified at all and the fix round
// sent at it had no defect to find.

test('a FAIL line naming a path under tests/ is a failure, not a summary counter', (t) => {
  const worktree = tree(t, ['test/widget.test.mjs'])

  const found = extractFailures(
    ' FAIL  test/widget.test.mjs [ test/widget.test.mjs ]\n' +
    "Error: Cannot find module '../src/nothing.mjs'\n", worktree)

  assert.equal(found.unplaced, 0)
  assert.deepEqual(found.failures.map((f) => f.file), ['test/widget.test.mjs'],
    'the runner named the file on its own FAIL line; nothing here has to guess')
})

test('a runner\'s own counters are still discarded, which is what the guard is for', (t) => {
  const worktree = tree(t, [])

  for (const line of ['✖ tests 5', '✖ pass 4', '✖ fail 1',
    '✖ duration_ms 12.5', '✖ cancelled 0', 'FAIL  Tests  3 failed']) {
    const found = extractFailures(line + '\n', worktree)
    assert.deepEqual(found.failures, [], line + ' names no test and must place nothing')
    assert.equal(found.unplaced, 0, line + ' is a counter, not a failure nobody could place')
  }
})
