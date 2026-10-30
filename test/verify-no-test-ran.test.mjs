// test/verify-no-test-ran.test.mjs — lib/verify.mjs over a test file the single-test command does not
// own: its runner exits as it is configured to and executes nothing. See test/verify-series.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeNode } from '../lib/tree.mjs'
import { closeDecision, measurementOk } from '../lib/verdict.mjs'
import { parseArgs, verify } from '../lib/verify.mjs'
import { BUILD, git, mutations, repository, rev } from './harness/verify-fixture.mjs'

const SPEC = 'e2e/widget.spec.mjs'
const SOURCE = 'src/widget.mjs'

// The unit runner: owns no `e2e/` file, and says so the way vitest does, exiting as configured.
const unitRunner = (exit) => [
  'const file = process.argv[2]',
  `if (file.startsWith('e2e/')) { console.log('No test files found, exiting with code ${exit}'); process.exit(${exit}) }`,
  "console.log('Tests  1 passed (1)')",
].join('\n')

// The other runner: executes the spec, and on a failure names it the way Playwright does.
const E2E_RUNNER = [
  "import { label } from '../src/widget.mjs'",
  "if (label() === 'hi') { console.log('1 passed'); process.exit(0) }",
  "console.log('  1) ' + process.argv[2] + ':3:1 > the widget says hi')",
  "console.log('1 failed')",
  'process.exit(1)',
].join('\n')

// A runner that fails at base before reaching any test, as a web server that will not start.
const SERVER_RUNNER = [
  "import { label } from '../src/widget.mjs'",
  "if (label() !== 'hi') { console.log('the web server did not start'); process.exit(1) }",
  "console.log('1 passed')",
].join('\n')

const E2E = 'node tools/e2e.mjs ' + SPEC
const TEST_ONE = 'node tools/unit.mjs {file}'

/** A leaf that adds `SPEC` and the source change it pins, in a repository with both runners. */
function leaf(t, { exit = 0 } = {}) {
  const dir = repository(t)
  writeFileSync(join(dir, 'tools', 'unit.mjs'), unitRunner(exit))
  writeFileSync(join(dir, 'tools', 'e2e.mjs'), E2E_RUNNER)
  writeFileSync(join(dir, 'tools', 'server.mjs'), SERVER_RUNNER)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'chore: two runners')
  const worktree = dir + '/wt'
  git(dir, 'worktree', 'add', '-q', '-b', 'agentics/widget--w1', worktree, 'main')
  mkdirSync(join(worktree, 'e2e'))
  writeFileSync(join(worktree, SPEC), "test('the widget says hi', () => {})\n")
  writeFileSync(join(worktree, SOURCE), "export const label = () => 'hi'\n")
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-qm', 'feat: label the widget hi')
  return { worktree, base: rev(dir, 'main'), head: rev(worktree, 'HEAD') }
}

const measure = ({ worktree, base, head }, ...extra) => verify(parseArgs([
  '--worktree', worktree, '--base', base, '--head', head, '--expects', SOURCE, '--expects', SPEC,
  '--build', BUILD, '--typecheck-absent', '--suite', 'node tools/unit.mjs all', '--test-one', TEST_ONE, ...extra,
]))

const check = (command) => ['--check-b64', Buffer.from(command, 'utf8').toString('base64')]
const node = (rigor) => normalizeNode({ id: 'w1', kind: 'leaf', rigor, title: 'x' })

for (const exit of [0, 1]) {
  test('a file its single-test command ran no test of, exiting ' + exit + ', is unmeasured and stops by saying so', (t) => {
    const payload = measure(leaf(t, { exit }), '--rigor', 'tdd')
    assert.equal(payload.stop_reason, 'completed', payload.notes)
    const [d] = payload.discriminator
    assert.deepEqual([d.test_id, d.failed_on_base, d.passes_now], [SPEC, null, null])
    assert.deepEqual(payload.unmeasured.map((u) => u.at).sort(), ['base', 'head'])
    assert.equal(payload.suite, 'not_run')

    const decision = closeDecision(payload, node('tdd'))
    assert.deepEqual([decision.next, decision.reason], ['escalate', 'test_not_measured'])
    const said = decision.failures.map((f) => f.claim).join('\n')
    assert.ok(said.includes('could not be run by the known command'), said)
    assert.ok(said.includes('node tools/unit.mjs ' + SPEC), said)
    assert.ok(!said.includes('passes at base'), said)
  })
}

test('a criterion check that runs the file measures it at the head and at base', (t) => {
  const world = leaf(t)
  const payload = measure(world, '--rigor', 'tdd', ...check(E2E))
  assert.equal(payload.stop_reason, 'completed', payload.notes)
  const [d] = payload.discriminator
  assert.deepEqual([d.failed_on_base, d.passes_now, d.measured_by], [true, true, E2E])
  assert.deepEqual(payload.unmeasured, [])
  assert.equal(payload.suite, 'passed')
  assert.ok(measurementOk(payload, node('tdd')).ok, JSON.stringify(measurementOk(payload, node('tdd')).failures))
  assert.equal(git(world.worktree, 'status', '--porcelain').stdout.trim(), '', 'the tree is put back')
  assert.equal(rev(world.worktree, 'HEAD'), world.head)
})

test('a check that fails at base without naming the file says nothing of it', (t) => {
  const payload = measure(leaf(t), '--rigor', 'tdd', ...check('node tools/server.mjs ' + SPEC))
  const [d] = payload.discriminator
  assert.deepEqual([d.failed_on_base, d.passes_now], [null, true])
  assert.equal(closeDecision(payload, node('tdd')).reason, 'test_not_measured')
})

test('a check over two test files or a compound command does not measure one of them', (t) => {
  const world = leaf(t)
  for (const command of [E2E + ' test/base.test.mjs', 'node tools/build.mjs && ' + E2E]) {
    assert.equal(measure(world, '--rigor', 'tdd', ...check(command)).discriminator[0].failed_on_base, null, command)
  }
})

test('a named check that executed no test proved nothing', (t) => {
  const payload = measure(leaf(t), '--rigor', 'trivial', ...check('node tools/unit.mjs ' + SPEC))
  assert.equal(payload.checks[0].status, 'unrunnable')
  assert.equal(closeDecision(payload, node('trivial')).reason, 'test_not_measured')
})

test('a mutation whose named file ran no test neither bites nor reads as a net that holds', (t) => {
  const world = leaf(t, { exit: 1 })
  const spec = [{ file: SOURCE, find: "'hi'", replace: "'no'", expect_failing: [SPEC] }]
  const blind = measure(world, '--rigor', 'tests-only', ...mutations(spec))
  assert.equal(blind.mutations[0].bites, false, 'a runner exiting 1 over nothing is no bite')
  assert.ok(blind.unmeasured.some((u) => u.file === SPEC && u.at === 'mutation'), JSON.stringify(blind.unmeasured))
  assert.equal(closeDecision(blind, node('tests-only')).reason, 'test_not_measured')

  const asked = measure(world, '--rigor', 'tests-only', ...mutations(spec), ...check(E2E))
  assert.equal(asked.mutations[0].bites, true, 'the check that runs the file asks it under the mutation')
  assert.deepEqual(asked.unmeasured, [])
})
