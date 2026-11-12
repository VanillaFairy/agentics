// test/boundaries-leaf-close-lint.test.mjs — lib/boundaries/leaf-close.mjs over the established
// lint: a finding the leaf's change made goes back to its producer as a fix round, and one its base
// already reports does not, over real git and the real measurement.
//
// Design: docs/DESIGN.md#verification.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { branchOf } from '../lib/store.mjs'
import { COMMANDS, git, root } from './harness/boundary-fixture.mjs'
import { E, SLOW, DONE, PASS, world, open, commit, run, msgs, observed, lf, crit } from './harness/leaf-close-world.mjs'

/** A lint over src/: one finding line per file declaring an `any`, then a count, exit 1 on any finding. */
const LINT_SRC = "import { readdirSync, readFileSync } from 'node:fs'\n" +
  "const bad = readdirSync('src').filter((f) => readFileSync('src/' + f, 'utf8').includes(': any'))\n" +
  "for (const f of bad) console.log('src/' + f + ':1:12  error  Unexpected any  no-explicit-any')\n" +
  "console.log(bad.length + ' problems')\n" +
  'process.exit(bad.length ? 1 : 0)\n'
const FINDING = (file) => file + ':1:12  error  Unexpected any  no-explicit-any'

/** A trivial leaf `a`, cut from a base whose src/old.mjs the lint already reports. */
function linted(t) {
  const w = world(t, [root(), lf('a', { rigor: 'trivial', expects: ['src/a.mjs', 'README.md'], acceptance: crit('a', PASS) })],
    { commands: { ...COMMANDS, lint: 'node lint.mjs', absent: { ...COMMANDS.absent, lint: false } } })
  const base = commit(w.r, { 'lint.mjs': LINT_SRC, 'src/old.mjs': 'export const old = (x: any) => x\n' }, 'Add the lint and an old finding')
  git(w.r, 'branch', '-f', branchOf(E, '.'), base)
  return { w, o: open(w, 'a', { from: base }) }
}

describe('leaf-close and the lint', { concurrency: 2 }, () => {
  test('a finding the change made is not passed, and goes to the producer with that finding alone', SLOW, async (t) => {
    const { w, o } = linted(t)
    commit(o.worktree, { 'src/a.mjs': 'export const a = (x: any) => x\n' }, 'Add a')
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(out.decision.next, 'fix', JSON.stringify(out.decision))
    const lint = out.decision.failures.filter((f) => f.check === 'lint')
    assert.equal(lint.length, 1, JSON.stringify(out.decision.failures))
    assert.ok(lint[0].evidence.includes(FINDING('src/a.mjs')), lint[0].evidence)
    assert.ok(!lint[0].evidence.includes(FINDING('src/old.mjs')), 'a finding the base reports is not the change\'s: ' + lint[0].evidence)
    const sent = msgs(w, 'failures', 'a')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:a')
    assert.ok(JSON.stringify(sent[0].payload).includes(FINDING('src/a.mjs')), JSON.stringify(sent[0].payload))
  })

  test('a lint that reports at the head only what it reports at the base passes the leaf', SLOW, async (t) => {
    const { w, o } = linted(t)
    commit(o.worktree, { 'README.md': 'hello\nmore\n' }, 'Edit the readme')
    const { out } = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
    const [m] = observed(w, 'a')
    assert.deepEqual([m.lint, m.lint_base, m.lint_new], ['failed', 'failed', []])
  })
})
