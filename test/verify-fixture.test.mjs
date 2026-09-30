// test/verify-fixture.test.mjs — the licence of test/harness/verify-fixture.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { verify } from '../lib/verify.mjs'
import { BRANCH, git, options, order, orderBuiltFresh } from './harness/verify-fixture.mjs'

// ---------------------------------------------------------------- the fixture's own licence
//
// Every test above stands in a COPY of a template rather than in a repository built for it, and
// the saving is worth roughly half this file's wall clock. What makes that legitimate is not the
// argument in the fixture module's header — it is this comparison. A clone and a freshly built
// fixture are handed to the same real verify(), and every field of the payload must agree.
//
// Both roles are covered because they exercise different halves of the machinery: a green order
// takes the discriminator's "passes now" path and leaves the suite green, a red one fails the
// suite, populates failing_tests and takes the other branch. A clone that diverged on either —
// a worktree whose repair left it pointing at the template, a stale index, a HEAD that did not
// come back — shows up here as a diff instead of as a mystery months later.

/** The fields a caller's verdict is computed from. Timings and shas are neither. */
const verdictShape = (p) => ({
  stop_reason: p.stop_reason,
  build: p.build,
  suite: p.suite,
  failing_tests: p.failing_tests,
  discriminator: p.discriminator,
  series_findings: p.series_findings,
  error: p.error,
})

for (const implemented of [true, false]) {
  const role = implemented ? 'green' : 'red'

  test(`a cloned fixture and a built one measure identically — ${role} order`, (t) => {
    const cloned = verify(options(order(t, { implemented })))
    const built = verify(options(orderBuiltFresh(t, { implemented })))

    assert.deepEqual(verdictShape(cloned), verdictShape(built),
      'the copy is only sound while it is indistinguishable from real construction')
    assert.equal(cloned.suite, implemented ? 'passed' : 'failed',
      'and the comparison is only worth anything while it covers both roles')
  })
}

test('a clone comes back on its branch and clean, exactly as a built fixture does', (t) => {
  const fixture = order(t)
  const { worktree } = fixture

  verify(options(fixture))

  assert.equal(git(worktree, 'branch', '--show-current').stdout.trim(), BRANCH,
    'a worktree left detached strands every commit a later fix round makes in it')
  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '',
    'the discriminator stashes and moves HEAD; what it borrowed it puts back')
})

test('two clones share a template and nothing else', (t) => {
  const a = order(t)
  const b = order(t)

  writeFileSync(join(a.worktree, 'src', 'widget.mjs'), "export const label = () => 'mutated'\n")

  assert.notEqual(a.dir, b.dir)
  assert.equal(git(b.worktree, 'status', '--porcelain').stdout.trim(), '',
    'a template poisoned by one test would reach every test taken after it')
})
