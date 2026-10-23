// test/verify-output.test.mjs — lib/verify.mjs, against real repositories: the suite's output, its
// tail carried verbatim and its failures placed in their files. See test/verify-series.test.mjs
// for the whole family.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { verify, parseArgs, extractFailures } from '../lib/verify.mjs'
import { isTestPath } from '../lib/store.mjs'
import { BUILD, options, order, SUITE, SUITE_TAP, TEST_ONE, WIDGET_TEST } from './harness/verify-fixture.mjs'

// ---------------------------------------------------------------- verbatim output

test('suite_output_tail is the suite\'s own last lines, byte for byte', (t) => {
  const { worktree, base, head } = order(t, { implemented: false })

  const payload = verify(options({ worktree, base, head, extra: ['--mode', 'integration'] }))

  const direct = spawnSync(SUITE, { cwd: worktree, shell: true, encoding: 'utf8' })
  const expected = ((direct.stdout || '') + (direct.stderr || '')).split('\n').slice(-40).join('\n')

  // Timings differ run to run; the SHAPE and the content that is not a clock must not. Both
  // spellings a node reporter uses are normalized — `(1.2ms)` and `duration_ms 1.2` in spec,
  // `duration_ms: 1.2` in TAP's YAML blocks — so the comparison is deterministic whichever the
  // runner wrote.
  const scrub = (text) => text.replace(/\(\d+(\.\d+)?ms\)/g, '(Xms)')
    .replace(/duration_ms:?\s*[\d.]+/g, 'duration_ms X')
  assert.equal(scrub(payload.suite_output_tail), scrub(expected))
  assert.ok(payload.suite_output_tail.split('\n').length <= 40)
})

// Every byte in the payload is retyped by a model on the way back, and the tail is the only
// unbounded field in it. It rides when a fix round will read it and not otherwise.
test('a passing suite carries no tail: nothing downstream ever opens one', (t) => {
  const { worktree, base, head } = order(t, { implemented: true })

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.suite, 'passed')
  assert.equal(payload.suite_scope, 'scoped', 'a leaf runs the test files it changed, not the suite')
  assert.match(payload.notes, /leaf tests: test\/widget\.test\.mjs/)
  assert.equal(payload.suite_output_tail, '',
    'a passing suite\'s output has no reader and is the largest field a courier carries')
})

test('a failing suite still carries its tail, because that IS the fix round\'s evidence', (t) => {
  const { worktree, base, head } = order(t, { implemented: false })

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.suite, 'failed')
  assert.ok(payload.suite_output_tail.length > 0)
})

// The banner rules a runner draws around a failure are the one part of a tail a courier has to
// COUNT rather than read, and counting is where the single corrupted payload of run
// 20260902-124933 was damaged. Collapsing them costs no word of the evidence.
test('a runner\'s banner rules collapse, and everything that is not a rule survives', (t) => {
  const { worktree } = order(t, { implemented: true })

  writeFileSync(join(worktree, 'noisy.mjs'),
    "process.stdout.write('\\u23af'.repeat(24) + ' Failed Suites 1 ' + '\\u23af'.repeat(7) + '\\n')\n" +
    "process.stdout.write('\\u276f zażółć gęślą jaźń \\u2014 an assertion diff\\n')\n" +
    'process.exit(1)\n')

  const payload = verify(parseArgs([
    '--worktree', worktree, '--mode', 'integration', '--build-absent',
    '--suite', 'node noisy.mjs',
  ]))

  assert.equal(payload.suite, 'failed')
  assert.ok(!/\u23af{2}/.test(payload.suite_output_tail),
    'a run of identical rule glyphs is decoration a courier must count; one of them says the same')
  assert.match(payload.suite_output_tail, /Failed Suites 1/)
  assert.match(payload.suite_output_tail, /\u276f zażółć gęślą jaźń \u2014 an assertion diff/,
    'non-ASCII that is not a repeated rule is evidence and is never touched')
})

test('blank lines are shape, not decoration, and survive the collapse', (t) => {
  const { worktree } = order(t, { implemented: true })

  writeFileSync(join(worktree, 'noisy.mjs'),
    "process.stdout.write('first\\n\\n\\n\\nlast\\n')\nprocess.exit(1)\n")

  const payload = verify(parseArgs([
    '--worktree', worktree, '--mode', 'integration', '--build-absent',
    '--suite', 'node noisy.mjs',
  ]))

  assert.match(payload.suite_output_tail, /first\n\n\n\nlast/,
    'a line terminator is outside printable ASCII too, and collapsing it would change the ' +
    'tail\'s shape rather than its decoration')
})

// ---------------------------------------------------------------- TAP output
//
// On Node 22 `node --test` writes TAP whenever its stdout is not a terminal — which is always,
// under this program — and TAP names a failure's file AFTER its marker, in the YAML block under
// it. Placing by the path printed before the marker placed nothing, raised
// `suite_failures_unnamed`, and made an ordinary red leaf unmeasurable on that runtime.

test('a red leaf whose suite writes TAP is placed by each failure\'s own location line', (t) => {
  const { worktree, base, head } = order(t, { implemented: false })

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--expects', 'src/widget.mjs', '--expects', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE_TAP, '--test-one', TEST_ONE,
  ]))

  assert.equal(payload.error, null)
  assert.equal(payload.stop_reason, 'completed')
  assert.equal(payload.suite, 'failed')
  assert.deepEqual([...new Set(payload.failing_tests.map((f) => f.file))], ['test/widget.test.mjs'])
})

test('two TAP failures in two files are each placed in their own, never the previous one\'s', (t) => {
  const { worktree } = order(t, { implemented: true })
  writeFileSync(join(worktree, 'test', 'other.test.mjs'), WIDGET_TEST)
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
  const { worktree } = order(t, { implemented: true })

  const found = extractFailures([
    '# Subtest: ' + worktree + '/test/widget.test.mjs', 'not ok 1 - test/widget.test.mjs', '  ---', '  ...',
    'not ok 2 - nameless', '  ---', "  type: 'test'", '  ...',
  ].join('\n'), worktree)

  assert.deepEqual(found.failures.map((f) => f.file), ['test/widget.test.mjs', 'test/widget.test.mjs'])
  assert.equal(found.unplaced, 0)
})

// ---------------------------------------------------------------- the closed pattern set

test('the test-file pattern set recognises the shapes it claims to', () => {
  for (const path of ['test/a.test.mjs', 'tests/b.py', 'src/__tests__/c.js', 'spec/d.rb',
    'lib/e.spec.ts', 'pkg/f_test.go', 'app/test_g.py', 'src/WidgetTest.java']) {
    assert.ok(isTestPath(path), path + ' should read as a test file')
  }
  for (const path of ['src/widget.mjs', 'docs/testing.md', 'latest/thing.js', 'src/protest.c']) {
    assert.ok(!isTestPath(path), path + ' should not read as a test file')
  }
})

// ---------------------------------------------------------------- summary lines vs paths
//
// The scanner's summary guard exists so a runner's counters are not attributed to whatever file
// was printed last. Its cost, until 20260902-124933, was that `tests/` is also how most of the
// world names its test directory: `\b` treats `/` as a word boundary, so every vitest and jest
// `FAIL tests/…` line read as the summary word `tests` and was discarded. The suite then failed
// while naming nothing, which is `suite_failures_unnamed`, which is `environment_broken`, which
// `verifiable()` refuses — so a correct red order could not be verified at all and the fix round
// sent at it had no defect to find.

test('a FAIL line naming a path under tests/ is a failure, not a summary counter', (t) => {
  const { worktree } = order(t, { implemented: true })
  writeFileSync(join(worktree, 'test', 'widget.test.mjs'), WIDGET_TEST)

  const found = extractFailures(
    ' FAIL  test/widget.test.mjs [ test/widget.test.mjs ]\n' +
    "Error: Cannot find module '../src/nothing.mjs'\n", worktree)

  assert.equal(found.unplaced, 0)
  assert.deepEqual(found.failures.map((f) => f.file), ['test/widget.test.mjs'],
    'the runner named the file on its own FAIL line; nothing here has to guess')
})

test('a runner\'s own counters are still discarded, which is what the guard is for', (t) => {
  const { worktree } = order(t, { implemented: true })

  for (const line of ['✖ tests 5', '✖ pass 4', '✖ fail 1',
    '✖ duration_ms 12.5', '✖ cancelled 0', 'FAIL  Tests  3 failed']) {
    const found = extractFailures(line + '\n', worktree)
    assert.deepEqual(found.failures, [], line + ' names no test and must place nothing')
    assert.equal(found.unplaced, 0, line + ' is a counter, not a failure nobody could place')
  }
})
