// test/verify-setup.test.mjs — lib/verify.mjs prepares the tree it measures by the established
// setup: at the head, at the base after its checkout, and at the head again. A tdd leaf whose test
// reads a gitignored file the setup generates from the source is measured at base against the
// base's source, not against what the head's setup left behind. See test/verify-no-test-ran.test.mjs
// for the fixture's shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeNode } from '../lib/tree.mjs'
import { closeDecision } from '../lib/verdict.mjs'
import { parseArgs, verify } from '../lib/verify.mjs'
import { BUILD, TEST_ONE, git, repository, rev } from './harness/verify-fixture.mjs'

const SPEC = 'test/label.test.mjs'
const SOURCE = 'src/widget.mjs'
const GEN = "import { label } from '../src/widget.mjs'\nimport { mkdirSync, writeFileSync } from 'node:fs'\nmkdirSync('gen', { recursive: true })\nwriteFileSync('gen/label.txt', label())\n"
const LABEL_TEST = [
  "import { test } from 'node:test'",
  "import assert from 'node:assert/strict'",
  "import { readFileSync } from 'node:fs'",
  "test('the generated label is hi', () => assert.equal(readFileSync('gen/label.txt', 'utf8'), 'hi'))",
  '',
].join('\n')
const SETUP = 'node tools/gen.mjs'

/** A tdd leaf adding `SPEC` and the source change it pins, in a repository whose `gen/` is generated and ignored. */
function leaf(t) {
  const dir = repository(t)
  writeFileSync(join(dir, 'tools', 'gen.mjs'), GEN)
  writeFileSync(join(dir, '.gitignore'), 'gen/\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'chore: a generated label')
  const worktree = dir + '/wt'
  git(dir, 'worktree', 'add', '-q', '-b', 'agentics/widget--w1', worktree, 'main')
  mkdirSync(join(worktree, 'test'), { recursive: true })
  writeFileSync(join(worktree, SPEC), LABEL_TEST)
  writeFileSync(join(worktree, SOURCE), "export const label = () => 'hi'\n")
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-qm', 'feat: label the widget hi')
  return { worktree, base: rev(dir, 'main'), head: rev(worktree, 'HEAD') }
}

const measure = ({ worktree, base, head }, over = {}) => verify({
  ...parseArgs([
    '--worktree', worktree, '--base', base, '--head', head, '--expects', SOURCE, '--expects', SPEC, '--rigor', 'tdd',
    '--build', BUILD, '--typecheck-absent', '--lint-absent', '--suite', 'node --test --test-reporter=spec test/', '--test-one', TEST_ONE,
  ]),
  ...over,
})
const tdd = normalizeNode({ id: 'w1', kind: 'leaf', rigor: 'tdd', title: 'x' })

test('setup prepares the head and the base: the test fails at base and passes now, and the leaf passes', (t) => {
  const payload = measure(leaf(t), { setup: SETUP })
  assert.equal(payload.stop_reason, 'completed', payload.notes)
  assert.equal(payload.setup, 'passed')
  const [d] = payload.discriminator
  assert.deepEqual([d.test_id, d.failed_on_base, d.passes_now], [SPEC, true, true], payload.notes)
  assert.equal(payload.suite, 'passed', payload.notes)
  assert.equal(closeDecision(payload, tdd).next, 'approve')
})

test('without a setup the unprepared tree fails the test now', (t) => {
  const payload = measure(leaf(t))
  assert.equal(payload.setup, 'absent')
  assert.equal(payload.discriminator[0].passes_now, false)
})

test('a scoped setup is not run where the checkout holds no such folder', (t) => {
  const payload = measure(leaf(t), { setupByPath: { viewer: 'node -e "process.exit(4)"' } })
  assert.equal(payload.error, null, payload.notes)
  assert.match(payload.notes, /setup of viewer\/ not run at head/)
})

test('a setup that fails is its own outcome, escalated setup_failed, with nothing measured', (t) => {
  const payload = measure(leaf(t), { setup: 'node -e "process.exit(4)"' })
  assert.equal(payload.stop_reason, 'environment_broken')
  assert.equal(payload.setup, 'failed')
  assert.equal(payload.error.kind, 'setup_failed')
  assert.equal(payload.suite, 'not_run')
  const decided = closeDecision(payload, tdd)
  assert.deepEqual([decided.next, decided.reason], ['escalate', 'setup_failed'])
})
