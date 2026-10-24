// test/verify-commands.test.mjs — lib/verify.mjs, against real repositories: the build and the
// typecheck, absent only when declared so. See test/verify-series.test.mjs for the whole family.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeNode } from '../lib/tree.mjs'
import { measurementOk } from '../lib/verdict.mjs'
import { verify, parseArgs } from '../lib/verify.mjs'
import { BUILD, git, options, order, repository, rev, SUITE, TEST_ONE } from './harness/verify-fixture.mjs'

// ---------------------------------------------------------------- absent, and unknown

test('an absent build command is recorded absent only when somebody declared it so', (t) => {
  const { worktree, base, head } = order(t)

  const declared = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--expects', 'src/widget.mjs', '--expects', 'test/widget.test.mjs',
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
    '--expects', 'src/widget.mjs', '--expects', 'test/widget.test.mjs',
    '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  assert.equal(payload.build, 'absent')
  assert.equal(payload.stop_reason, 'environment_broken',
    'a caller that never reads `error` must still fail safe')
  assert.equal(payload.error.kind, 'command_unknown')
  assert.match(payload.error.message, /build/)
})

// ---------------------------------------------------------------- the typecheck at base

/** A leaf whose test passes at base and now, and a "typecheck" that rejects the base's source. */
function typeLevelLeaf(t) {
  const dir = repository(t)
  writeFileSync(join(dir, 'tools', 'typecheck.mjs'),
    "import { readFileSync } from 'node:fs'\nprocess.exit(readFileSync('src/widget.mjs', 'utf8').includes(\"'hi'\") ? 0 : 1)\n")
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'a typecheck')
  const worktree = dir + '/wt'
  git(dir, 'worktree', 'add', '-q', '-b', 'agentics/widget--w1', worktree, 'main')
  writeFileSync(join(worktree, 'src', 'widget.mjs'), "export const label = () => 'hi'\n")
  writeFileSync(join(worktree, 'test', 'kept.test.mjs'), "import { test } from 'node:test'\ntest('the widget module loads', async () => { await import('../src/widget.mjs') })\n")
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-qm', 'feat: label the widget hi')
  return { worktree, base: rev(dir, 'main'), head: rev(worktree, 'HEAD') }
}

test('a tdd leaf whose tests held at base asks the typecheck there, its tests restored, and that check discriminates it', (t) => {
  const { worktree, base, head } = typeLevelLeaf(t)
  const typecheck = 'node tools/typecheck.mjs'
  const check = typecheck + ' && node -e "0"'
  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head, '--rigor', 'tdd',
    '--expects', 'src/widget.mjs', '--expects', 'test/kept.test.mjs',
    '--build', BUILD, '--typecheck', typecheck, '--suite', SUITE, '--test-one', TEST_ONE,
    '--check-b64', Buffer.from(check, 'utf8').toString('base64'),
  ]))
  assert.equal(payload.stop_reason, 'completed', payload.notes)
  assert.deepEqual(payload.discriminator.map((d) => [d.test_id, d.failed_on_base, d.passes_now]), [['test/kept.test.mjs', false, true]])
  assert.deepEqual(payload.static_on_base, [
    { kind: 'typecheck', command: typecheck, failed_on_base: true },
    { kind: 'check', command: check, failed_on_base: true },
  ])
  const leaf = normalizeNode({ id: 'w1', kind: 'leaf', rigor: 'tdd', expects: ['src/widget.mjs'] })
  assert.equal(measurementOk(payload, leaf).ok, true, 'the typecheck that failed at base is the discriminator')
})

test('a tdd leaf with a test that fails at base asks nothing static there', (t) => {
  const { worktree, base, head } = order(t)
  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head, '--rigor', 'tdd',
    '--expects', 'src/widget.mjs', '--expects', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck', 'node -e "process.exit(1)"', '--suite', SUITE, '--test-one', TEST_ONE,
  ]))
  assert.equal(payload.discriminator[0].failed_on_base, true)
  assert.deepEqual(payload.static_on_base, [], 'a behaviour change keeps its test-first discriminator alone')
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
    '--expects', 'src/widget.mjs', '--expects', 'test/widget.test.mjs',
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
    '--expects', 'src/widget.mjs', '--expects', 'test/widget.test.mjs',
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
