// test/verify-output.test.mjs — lib/verify.mjs, against real repositories: the suite's output, its
// tail carried verbatim and its failures placed in their files. See test/verify-series.test.mjs
// for the whole family.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { verify, parseArgs } from '../lib/verify.mjs'
import { BUILD, options, order, SUITE, SUITE_TAP, TEST_ONE } from './harness/verify-fixture.mjs'

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
