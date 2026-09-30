// test/verify-mutations.test.mjs — lib/verify.mjs, against real repositories: the mutation check.
// See test/verify-series.test.mjs for the whole family.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { verify } from '../lib/verify.mjs'
import { git, mutations, options, order } from './harness/verify-fixture.mjs'

test('a regression net that catches its own mutation bites, and the tree is put back', (t) => {
  // The right question for a regression net, which is excused the base question. The
  // fixture's test asserts `label() === 'hi'`; breaking the source is what makes it fail, and
  // a net that fails under the break is a net.
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: mutations([
    { file: 'src/widget.mjs', find: "'hi'", replace: "'bye'",
      expect_failing: ['test/widget.test.mjs'] },
  ]) }))

  assert.equal(payload.mutations.length, 1)
  assert.equal(payload.mutations[0].applied, true)
  assert.equal(payload.mutations[0].bites, true)
  assert.deepEqual(payload.mutations[0].observed_failing, ['test/widget.test.mjs'])
  assert.equal(payload.stop_reason, 'completed')

  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '',
    'a deliberate break left in the tree sends the next fix round after a defect nobody wrote')
  assert.equal(readFileSync(join(worktree, 'src', 'widget.mjs'), 'utf8').includes("'hi'"), true)
})

test('a net that survives the break it exists to catch does NOT bite', (t) => {
  // The finding this check exists to produce: the tests pass, they passed at base, and they would
  // pass with the thing they claim to guard broken. Nothing else in the pipeline can see that.
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: mutations([
    { file: 'src/widget.mjs', find: 'const label', replace: 'const  label',
      expect_failing: ['test/widget.test.mjs'] },
  ]) }))

  assert.equal(payload.mutations[0].applied, true)
  assert.equal(payload.mutations[0].bites, false)
  assert.deepEqual(payload.mutations[0].observed_failing, [])
  assert.equal(payload.stop_reason, 'completed',
    'a net that does not bite is a measurement outcome, not a broken environment')
})

test('a stale spec is unapplied, and is never reported as a net that does not bite', (t) => {
  // The two must not collapse into each other. A `find` that no longer occurs is a defect in the
  // SPEC — the plan is out of date — and reading it as evidence about the test is the laundering
  // IRON LAW §2 forbids.
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: mutations([
    { file: 'src/widget.mjs', find: "'this text is not in the file'", replace: 'x',
      expect_failing: ['test/widget.test.mjs'] },
  ]) }))

  assert.equal(payload.mutations[0].applied, false)
  assert.equal(payload.mutations[0].bites, false)
  assert.match(payload.mutations[0].unapplied_reason, /stale/)
  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '')
})

test('a spec whose text occurs more than once is refused as ambiguous', (t) => {
  // Which site was broken decides what the run learned, and a substitution applied to all of them
  // is a different experiment from the one the plan described.
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: mutations([
    { file: 'test/widget.test.mjs', find: 'label', replace: 'nope',
      expect_failing: ['test/widget.test.mjs'] },
  ]) }))

  assert.equal(payload.mutations[0].applied, false)
  assert.match(payload.mutations[0].unapplied_reason, /occurs \d+ times/)
  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '')
})

test('a spec naming no failing test asks nothing, and says so', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: mutations([
    { file: 'src/widget.mjs', find: "'hi'", replace: "'bye'", expect_failing: [] },
  ]) }))

  assert.equal(payload.mutations[0].applied, false)
  assert.match(payload.mutations[0].unapplied_reason, /names no test/)
})

test('an order declaring no mutation records an empty list and runs nothing', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head }))

  assert.deepEqual(payload.mutations, [],
    'every order written before this field existed is this case, and must be untouched')
})
