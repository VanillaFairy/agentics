// test/verify-mutations.test.mjs — lib/verify.mjs, against real repositories: the mutation check.
// See test/verify-series.test.mjs for the whole family. A mutation that bites is pinned by the
// tests-only and audit tests in test/verify-rigor.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { verify } from '../lib/verify.mjs'
import { git, mutations, options, order } from './harness/verify-fixture.mjs'

// Every mutation is applied and undone in its own turn, so one order carries one spec per claim
// and each is read at its own index.
test('a net that survives its break does not bite, and a stale, an ambiguous or a testless spec is unapplied', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: mutations([
    // The tests pass, they passed at base, and they would pass with the thing they claim to guard
    // broken: nothing else in the pipeline can see that.
    { file: 'src/widget.mjs', find: 'const label', replace: 'const  label', expect_failing: ['test/widget.test.mjs'] },
    // A `find` that no longer occurs is a defect in the SPEC — the plan is out of date — and
    // reading it as evidence about the test is the laundering IRON LAW §2 forbids.
    { file: 'src/widget.mjs', find: "'this text is not in the file'", replace: 'x', expect_failing: ['test/widget.test.mjs'] },
    // Which site was broken decides what the run learned; a substitution applied to all of them
    // is a different experiment from the one the plan described.
    { file: 'test/widget.test.mjs', find: 'label', replace: 'nope', expect_failing: ['test/widget.test.mjs'] },
    { file: 'src/widget.mjs', find: "'hi'", replace: "'bye'", expect_failing: [] },
  ]) }))
  const [survives, stale, ambiguous, testless] = payload.mutations

  assert.equal(payload.mutations.length, 4)
  assert.equal(payload.stop_reason, 'completed', 'a net that does not bite is a measurement outcome, not a broken environment')

  assert.equal(survives.applied, true, 'a net that survives the break it exists to catch: applied')
  assert.equal(survives.bites, false, 'does NOT bite')
  assert.deepEqual(survives.observed_failing, [])

  assert.equal(stale.applied, false, 'a stale spec is unapplied')
  assert.equal(stale.bites, false, 'and never reported as a net that does not bite')
  assert.match(stale.unapplied_reason, /stale/)

  assert.equal(ambiguous.applied, false, 'a spec whose text occurs more than once is refused as ambiguous')
  assert.match(ambiguous.unapplied_reason, /occurs \d+ times/)

  assert.equal(testless.applied, false, 'a spec naming no failing test asks nothing')
  assert.match(testless.unapplied_reason, /names no test/, 'and says so')

  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '', 'no spec leaves its break in the tree')
})
