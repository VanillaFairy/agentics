// test/verify-test-one-scope.test.mjs — lib/verify.mjs in a repository with two test runners: a
// test file is run by the `test_one` of the most specific scope holding it, and every other file by
// the whole tree's. See test/verify-no-test-ran.test.mjs for the fixture's shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { testOneFor } from '../lib/gotchas.mjs'
import { normalizeNode } from '../lib/tree.mjs'
import { closeDecision } from '../lib/verdict.mjs'
import { parseArgs, verify } from '../lib/verify.mjs'
import { BUILD, git, mutations, repository, rev } from './harness/verify-fixture.mjs'

const SPEC = 'viewer/test/widget.test.mjs'
const SOURCE = 'src/widget.mjs'

// The tree's runner loads a viewer file and crashes before any test registers, counting the file
// as one failing test, as `node --test` does over a vitest file.
const ROOT_RUNNER = [
  'const file = process.argv[2]',
  "if (file.startsWith('viewer/')) { console.log('Error: Vitest failed to find the current suite'); console.log('ℹ tests 1'); console.log('ℹ fail 1'); process.exit(1) }",
  "console.log('ℹ tests 1')",
].join('\n')

// The viewer's runner: executes the file, passing once the source labels the widget hi, and
// reports as vitest run with `--root viewer` does, its paths relative to that folder.
const VIEWER_RUNNER = [
  "import { label } from '../src/widget.mjs'",
  "if (label() === 'hi') { console.log('Tests  1 passed (1)'); process.exit(0) }",
  "const file = process.argv[2].replace(/^viewer[/]/, '')",
  "console.log(' ❯ ' + file + ' (1 test | 1 failed) 9ms')",
  "console.log('   × the widget says hi 2ms')",
  "console.log(' FAIL  ' + file + ' > the widget says hi')",
  "console.log(' Test Files  1 failed (1)')",
  "console.log('      Tests  1 failed (1)')",
  'process.exit(1)',
].join('\n')

const TEST_ONE = 'node tools/root.mjs {file}'
const BY_PATH = { viewer: 'node tools/viewer.mjs {file}' }

/** A leaf that adds `SPEC` and the source change it pins, in a repository with both runners. */
function leaf(t) {
  const dir = repository(t)
  writeFileSync(join(dir, 'tools', 'root.mjs'), ROOT_RUNNER)
  writeFileSync(join(dir, 'tools', 'viewer.mjs'), VIEWER_RUNNER)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'chore: two runners')
  const worktree = dir + '/wt'
  git(dir, 'worktree', 'add', '-q', '-b', 'agentics/widget--w1', worktree, 'main')
  mkdirSync(join(worktree, 'viewer', 'test'), { recursive: true })
  writeFileSync(join(worktree, SPEC), "test('the widget says hi', () => {})\n")
  writeFileSync(join(worktree, SOURCE), "export const label = () => 'hi'\n")
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-qm', 'feat: label the widget hi')
  return { worktree, base: rev(dir, 'main'), head: rev(worktree, 'HEAD') }
}

const measure = ({ worktree, base, head }, testOneByPath, extra = []) => verify({
  ...parseArgs([
    '--worktree', worktree, '--base', base, '--head', head, '--expects', SOURCE, '--expects', SPEC, '--rigor', 'tdd',
    '--build', BUILD, '--typecheck-absent', '--suite', 'node tools/root.mjs all', '--test-one', TEST_ONE, ...extra,
  ]),
  testOneByPath,
})

test('a file under a scope is measured by that scope\'s test_one, and its leaf passes', (t) => {
  const payload = measure(leaf(t), BY_PATH)
  assert.equal(payload.stop_reason, 'completed', payload.notes)
  const [d] = payload.discriminator
  assert.deepEqual([d.test_id, d.failed_on_base, d.passes_now], [SPEC, true, true], payload.notes)
  assert.equal(payload.suite, 'passed', payload.notes)
  assert.equal(closeDecision(payload, normalizeNode({ id: 'w1', kind: 'leaf', rigor: 'tdd', title: 'x' })).next, 'approve')
})

test('a mutation of a file under a scope bites where that scope\'s runner names the expected test failing', (t) => {
  const spec = { file: SOURCE, find: "'hi'", replace: "'ho'", expect_failing: ['the widget says hi'] }
  const [m] = measure(leaf(t), BY_PATH, mutations([spec])).mutations
  assert.equal(m.applied, true)
  assert.deepEqual([m.observed_failing, m.failing_files, m.bites], [['the widget says hi'], [SPEC], true])
})

test('without the scope the tree\'s runner measures the file, and the crash reads as a failure', (t) => {
  const payload = measure(leaf(t), {})
  assert.equal(payload.suite, 'failed')
  assert.equal(payload.discriminator[0].passes_now, false)
})

test('testOneFor picks the most specific scope holding the file, segment by segment, else the tree\'s', () => {
  const byPath = { viewer: 'v {file}', 'viewer/e2e': 'e {file}' }
  assert.equal(testOneFor('n {file}', byPath, 'viewer/test/a.ts'), 'v {file}')
  assert.equal(testOneFor('n {file}', byPath, 'viewer/e2e/a.ts'), 'e {file}')
  assert.equal(testOneFor('n {file}', byPath, 'viewerx/a.ts'), 'n {file}')
  assert.equal(testOneFor('n {file}', byPath, 'test/a.mjs'), 'n {file}')
  assert.equal(testOneFor('', byPath, 'test/a.mjs'), '')
})
