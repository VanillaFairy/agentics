// test/verify-commands.test.mjs — lib/verify.mjs, against real repositories: the build and the
// typecheck, absent only when declared so. See test/verify-series.test.mjs for the whole family.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { verify, parseArgs } from '../lib/verify.mjs'
import { BUILD, options, order, SUITE, TEST_ONE } from './harness/verify-fixture.mjs'

// ---------------------------------------------------------------- absent, and unknown

test('an absent build command is recorded absent only when somebody declared it so', (t) => {
  const { worktree, base, head } = order(t)

  const declared = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
    '--build-absent', '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  assert.equal(declared.build, 'absent')
  assert.equal(declared.stop_reason, 'completed')
  assert.equal(declared.error, null, 'a repository with no build command is a fact, not a fault')
  assert.equal(declared.suite, 'passed')
})

test('a build command nobody named escalates rather than reading as a repository with none', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
    '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  assert.equal(payload.build, 'absent')
  assert.equal(payload.stop_reason, 'environment_broken',
    'a caller that never reads `error` must still fail safe')
  assert.equal(payload.error.kind, 'command_unknown')
  assert.match(payload.error.message, /build/)
})

// ---------------------------------------------------------------- the typecheck

test('a failing typecheck is recorded beside a PASSING suite, which is the whole point', (t) => {
  // The field case, reproduced: 826 tests green over a tree `tsc --noEmit` rejected. Vitest and
  // Jest transform TypeScript with esbuild, which strips types without checking them, so the
  // suite is structurally incapable of answering this question and answering it anyway is how a
  // branch tip ships with a broken build under a green report.
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck', 'node -e "process.exit(2)"',
    '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  assert.equal(payload.suite, 'passed', 'the suite is green and says nothing about the types')
  assert.equal(payload.build, 'passed')
  assert.equal(payload.typecheck, 'failed', 'and the third answer is the one that is not green')
  assert.equal(payload.stop_reason, 'completed',
    'a failed typecheck is a measurement outcome, not a broken environment')
  assert.match(payload.notes, /typecheck output tail:/,
    'the fix round is shown what failed, not just that something did')
})

test('a typecheck nobody named escalates rather than reading as a repository with none', (t) => {
  // The same refusal the build gets, for the same reason and no weaker: defaulting an unnamed
  // typecheck to `absent` would rebuild the exact hole this field was added to close — a check
  // that silently does not run. It costs no extra escalation, because the first verification in
  // a run already escalates to establish the build.
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
    '--build', BUILD, '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  assert.equal(payload.typecheck, 'absent')
  assert.equal(payload.stop_reason, 'environment_broken')
  assert.equal(payload.error.kind, 'command_unknown')
  assert.match(payload.error.message, /typecheck/)
})

test('a declared-absent typecheck is a fact about the repository, not a fault', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.typecheck, 'absent')
  assert.equal(payload.stop_reason, 'completed')
  assert.equal(payload.error, null)
  assert.match(payload.notes, /no typecheck command/)
})

test('a failing build is an observed exit, and its output travels as evidence', (t) => {
  const { worktree, base, head } = order(t)
  writeFileSync(join(worktree, 'tools', 'build.mjs'), 'process.exit(3)\n')

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.build, 'failed')
  assert.equal(payload.stop_reason, 'completed', 'a broken build is a fact to report')
  assert.match(payload.notes, /exited 3/)
})
