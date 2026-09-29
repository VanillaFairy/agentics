// test/verify.test.mjs — lib/verify.mjs, against real repositories.
//
// Which checks run is the leaf's rigor and role (see `checksFor`); the verdict over what they
// observed is lib/verdict.mjs's, tested purely in test/verdict.test.mjs. This file pins the
// observations.
//
// These are slow tests: each one stands in a real git worktree and runs a real node test suite
// inside it, several times. That cost is the point — the whole value of this file is that the
// discriminator moves HEAD, restores files, runs a suite there and puts the tree back, and none
// of that is observable against a mock.
//
// The repositories themselves come from test/harness/verify-fixture.mjs, which builds each
// distinct shape once and copies it per test. Construction is not the thing under test and used
// to cost more than everything that is; the copy is licensed by the equivalence test at the
// bottom of this file, which pins that a clone and a freshly built fixture produce the same
// verify() payload byte for byte.
//
// The properties worth pinning, in the order they matter:
//
//   the environment refusal — the procedure stashes and moves HEAD, so it must refuse the tree a
//     human is working in BEFORE it touches anything;
//   absent is never inferred — a command nobody named is not a repository with no command;
//   a failed measurement never wears a clean one's shape — an unreadable series is an error with
//     an empty findings array, and the error is what the caller routes on;
//   the tree is put back — a worktree left detached strands every later fix commit;
//   the log format is IMPORTED — a checkpoint trailer with an ordinary subject is only detectable
//     through lib/commit-series.mjs's own format string, so this file re-implementing it would
//     silently stop finding them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  verify, parseArgs, isTestPath, worktreeProblem, extractFailures, checksFor, journalLine,
} from '../lib/verify.mjs'
import { readLog } from '../lib/ledger.mjs'
import { measurementOk } from '../lib/verdict.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import {
  BRANCH, BUILD, EFFORT, NODE, SUITE, SUITE_TAP, TEST_ONE, WIDGET_TEST,
  cycle, git, rev, order, orderBuiltFresh, repository,
} from './harness/verify-fixture.mjs'

const CLI = fileURLToPath(new URL('../lib/verify.mjs', import.meta.url))

const options = (over = {}) => parseArgs([
  '--worktree', over.worktree,
  '--base', over.base,
  '--head', over.head,
  '--locus', 'src/widget.mjs',
  '--locus', 'test/widget.test.mjs',
  '--build', BUILD,
  '--typecheck-absent',
  '--suite', SUITE,
  '--test-one', TEST_ONE,
  ...(over.extra || []),
])

// ---------------------------------------------------------------- the environment refusal

test('it refuses the repository\'s main working tree, where moving HEAD destroys work', (t) => {
  const dir = repository(t)

  const problem = worktreeProblem(dir)
  assert.ok(problem, 'the main working tree is exactly what this procedure must not touch')
  assert.equal(problem.kind, 'main_worktree')

  const payload = verify(options({ worktree: dir, base: rev(dir, 'HEAD'), head: rev(dir, 'HEAD') }))
  assert.equal(payload.stop_reason, 'environment_broken')
  assert.equal(payload.error.kind, 'main_worktree')
  assert.deepEqual(payload.discriminator, [], 'nothing was measured, so nothing is reported')
  assert.deepEqual(payload.series_findings, [])
})

test('a path that is no working tree at all is refused before anything runs', (t) => {
  const dir = repository(t)

  assert.equal(worktreeProblem('').kind, 'no_worktree',
    'no worktree at all is the case that used to be a sentence in a prompt')
  assert.equal(worktreeProblem(dir + '/nowhere').kind, 'no_worktree')

  const outside = mkdtempSync(join(tmpdir(), 'agentics-not-a-repo-')).split('\\').join('/')
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  assert.equal(worktreeProblem(outside).kind, 'no_worktree')
})

test('a linked worktree is accepted', (t) => {
  const { worktree } = order(t)
  assert.equal(worktreeProblem(worktree), null)
})

// ---------------------------------------------------------------- the green series

test('a green series: build passes, suite passes, and the new test discriminates', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.stop_reason, 'completed')
  assert.equal(payload.error, null)
  assert.equal(payload.build, 'passed')
  assert.equal(payload.suite, 'passed')
  assert.deepEqual(payload.failing_tests, [])
  assert.deepEqual(payload.series_findings, [], 'both changed files are inside the declared locus')
  assert.deepEqual(payload.discriminator, [
    { test_id: 'test/widget.test.mjs', failed_on_base: true, passes_now: true },
  ])
  assert.ok(payload.notes.includes(BUILD), 'the commands actually run are named')
})

test('the worktree is left on its branch, clean, whatever the discriminator checked out', (t) => {
  const { worktree, base, head } = order(t)

  verify(options({ worktree, base, head }))

  assert.equal(git(worktree, 'branch', '--show-current').stdout.trim(), BRANCH)
  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '')
  assert.equal(rev(worktree, 'HEAD'), head)
})

test('uncommitted work in the worktree survives the discriminator', (t) => {
  const { worktree, base, head } = order(t)
  writeFileSync(join(worktree, 'src', 'scratch.txt'), 'not committed\n')

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.stop_reason, 'completed')
  assert.match(git(worktree, 'status', '--porcelain').stdout, /scratch\.txt/,
    'the stash was popped — uncommitted work is nobody else\'s to discard')
})

// ---------------------------------------------------------------- the red series

test('a red order: its test fails now and at base, and the failure is placed in its own file', (t) => {
  const { worktree, base, head } = order(t, { implemented: false })

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.stop_reason, 'completed')
  assert.equal(payload.error, null, 'a red suite is an observation, not a broken environment')
  assert.equal(payload.build, 'passed')
  assert.equal(payload.suite, 'failed')
  assert.deepEqual(payload.discriminator, [
    { test_id: 'test/widget.test.mjs', failed_on_base: true, passes_now: false },
  ])

  const files = payload.failing_tests.map((f) => f.file)
  assert.ok(files.length > 0, 'a suite that failed while naming nothing is failing everywhere')
  assert.deepEqual([...new Set(files)], ['test/widget.test.mjs'],
    'every failure is placed in the order\'s own test file, repo-relative')
  assert.ok(payload.failing_tests.every((f) => f.id.trim() !== ''))
})

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

// ---------------------------------------------------------------- the mutation check

const mutations = (specs) => ['--mutations-b64', Buffer.from(JSON.stringify(specs)).toString('base64')]

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

test('a failing build is an observed exit, and its output travels as evidence', (t) => {
  const { worktree, base, head } = order(t)
  writeFileSync(join(worktree, 'tools', 'build.mjs'), 'process.exit(3)\n')

  const payload = verify(options({ worktree, base, head }))

  assert.equal(payload.build, 'failed')
  assert.equal(payload.stop_reason, 'completed', 'a broken build is a fact to report')
  assert.match(payload.notes, /exited 3/)
})

// ---------------------------------------------------------------- a measurement that failed

test('a series that could not be read is an error, never an empty findings array', (t) => {
  const { worktree, head } = order(t)

  const payload = verify(options({ worktree, base: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', head }))

  assert.deepEqual(payload.series_findings, [])
  assert.equal(payload.stop_reason, 'environment_broken')
  assert.equal(payload.error.kind, 'series_unreadable',
    'an empty findings array means "checked, found nothing" and must not be reachable any other way')
})

test('a changed test file with no way to run one test escalates instead of skipping it', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE,
  ]))

  assert.deepEqual(payload.discriminator, [])
  assert.equal(payload.error.kind, 'command_unknown')
  assert.match(payload.error.message, /single-test/)
})

// ---------------------------------------------------------------- the imported log format

test('a checkpoint trailer under an ordinary subject is still a blocking finding', (t) => {
  // The trailer is the load-bearing half of the mark and the subject here is unremarkable, so
  // this only ever fires through lib/commit-series.mjs's own LOG_FORMAT. A log format
  // re-implemented in this file would pass every other test in it and silently lose this one.
  const { worktree, base, head } = order(t, { trailer: 'agentics-checkpoint: ran long' })

  const payload = verify(options({ worktree, base, head }))

  const checkpoint = payload.series_findings.find((f) => f.check === 'checkpoint-commit')
  assert.ok(checkpoint, 'the checkpoint mark reached the findings through the shared format')
  assert.equal(checkpoint.blocking, true)
})

test('a commit outside the declared locus is a blocking finding', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  const breach = payload.series_findings.find((f) => f.check === 'locus-breach')
  assert.ok(breach)
  assert.match(breach.message, /src\/widget\.mjs/)
})

// ---------------------------------------------------------------- verbatim output

test('suite_output_tail is the suite\'s own last lines, byte for byte', (t) => {
  const { worktree, base, head } = order(t, { implemented: false })

  const payload = verify(options({ worktree, base, head }))

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

// ---------------------------------------------------------------- the integration head

test('integration mode measures the merged head and reports honest emptiness', (t) => {
  const { worktree } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--mode', 'integration', '--build', BUILD, '--typecheck-absent', '--suite', SUITE,
  ]))

  assert.equal(payload.stop_reason, 'completed')
  assert.equal(payload.build, 'passed')
  assert.equal(payload.suite, 'passed')
  assert.deepEqual(payload.series_findings, [])
  assert.deepEqual(payload.discriminator, [])
  assert.match(payload.notes, /merged head/)
})

// ---------------------------------------------------------------- the transport

test('the CLI prints one line whose digest covers the payload it carries', (t) => {
  const { worktree, base, head } = order(t)

  const run = spawnSync(process.execPath, [CLI,
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
  ], { encoding: 'utf8' })

  assert.equal(run.status, 0, 'a payload was printed, which is what this tool produces')
  assert.equal(run.stdout.trim().split('\n').length, 1, 'ONE line, for a courier to paste')

  const parsed = JSON.parse(run.stdout)
  assert.equal(fnv1a(canonical(parsed.payload)), parsed.payload_digest)

  const tampered = { ...parsed.payload, suite: 'absent' }
  assert.notEqual(fnv1a(canonical(tampered)), parsed.payload_digest,
    'a payload that drifted by one field digests differently, which is the whole point')
})

test('a typed error still travels under a digest, and still exits 0', (t) => {
  const dir = repository(t)

  const run = spawnSync(process.execPath, [CLI, '--worktree', dir, '--base', rev(dir, 'HEAD'),
    '--head', rev(dir, 'HEAD'), '--build', BUILD, '--typecheck-absent', '--suite', SUITE], { encoding: 'utf8' })

  assert.equal(run.status, 0,
    'a refusal is a measurement outcome, and a non-zero exit would read as the tool failing')
  const parsed = JSON.parse(run.stdout)
  assert.equal(parsed.payload.error.kind, 'main_worktree')
  assert.equal(fnv1a(canonical(parsed.payload)), parsed.payload_digest)
})

test('base64 command transport decodes to the same commands', () => {
  const encoded = Buffer.from('npm run build --workspace "a b"', 'utf8').toString('base64')
  assert.equal(parseArgs(['--build-b64', encoded]).build, 'npm run build --workspace "a b"')
})

// ---------------------------------------------------------------- the journal

const EXECUTION = '20260925-120000'

test('the observation is journalled by the process that observed it, through the ledger', (t) => {
  const { dir, worktree, base, head } = order(t)

  const run = spawnSync(process.execPath, [CLI,
    '--worktree', worktree, '--base', base, '--head', head,
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
    '--repo', dir, '--effort', EFFORT, '--execution', EXECUTION, '--node', NODE, '--branch', BRANCH,
  ], { encoding: 'utf8' })

  const parsed = JSON.parse(run.stdout)
  assert.equal(parsed.payload.journal.written, true)
  assert.equal(fnv1a(canonical(parsed.payload)), parsed.payload_digest,
    'the journal outcome is part of the payload the digest covers')

  const { entries, malformed } = readLog(dir, EFFORT, 'journal:' + EXECUTION)
  assert.equal(malformed, 0)
  assert.equal(entries.length, 1)
  const [line] = entries
  assert.equal(line.kind, 'verify-observed')
  assert.ok(Number.isInteger(line.seq) && line.seq >= 1, 'the ledger minted the seq; nobody supplied one')
  assert.equal(line.node, NODE)
  assert.equal(line.branch, BRANCH)
  assert.equal(line.head_sha, head)
  assert.equal(line.build, 'passed')
  assert.equal(line.typecheck, 'absent')
  assert.equal(line.suite, 'passed')
  assert.deepEqual(line.discriminator, parsed.payload.discriminator)
  assert.deepEqual(line.checks, [])
  assert.deepEqual(Object.keys(line).sort(), [
    'base_sha', 'baseline_failing', 'branch', 'build', 'checks', 'discriminator', 'failing_tests', 'head_sha', 'kind',
    'mutations', 'node', 'seq', 'series_findings', 'stop_reason', 'suite', 'typecheck',
    'worktree',
  ], 'a resume re-derives the verdict from this line alone, so it carries every field ' +
     'lib/verdict.mjs reads — `typecheck`, `mutations` and `checks` included')
})

test('verify() journals in-process, and each append mints the next seq', (t) => {
  const { dir, worktree, base, head } = order(t)
  const opts = options({ worktree, base, head, extra: [
    '--repo', dir, '--effort', EFFORT, '--execution', EXECUTION, '--node', NODE, '--branch', BRANCH,
  ] })

  const first = verify({ ...opts, rigor: 'trivial' })
  const second = verify({ ...opts, rigor: 'trivial' })

  assert.deepEqual(first.journal, { written: true, error: '' })
  assert.deepEqual(second.journal, { written: true, error: '' })
  const seqs = readLog(dir, EFFORT, 'journal:' + EXECUTION).entries.map((e) => e.seq)
  assert.equal(seqs.length, 2)
  assert.ok(seqs[1] > seqs[0], 'one monotonic counter per effort, minted under its lock')
})

test('a test that fails at the base too is baseline, and a test the change broke is not', (t) => {
  const { worktree } = order(t)
  const commit = (files, subject) => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(worktree, path), text)
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-q', '-m', subject)
    return rev(worktree, 'HEAD')
  }
  const broken = (extra) => "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { label } from '../src/widget.mjs'\n" +
    "test('broken before', () => assert.fail('already broken'))\ntest('widget labels', () => assert.equal(typeof label, 'function'))\n" + extra
  const base = commit({ 'test/broken.test.mjs': broken('') }, 'Add a broken test')
  const leaf = { rigor: 'trivial', locus: ['README.md', 'src/widget.mjs'] }
  const measure = (head) => verify({ ...options({ worktree, base, head }), locus: leaf.locus, rigor: 'trivial' })

  const readme = measure(commit({ 'README.md': 'changed\n' }, 'Touch the readme'))
  assert.equal(readme.suite, 'failed')
  assert.deepEqual(readme.baseline_failing.map((f) => f.file), ['test/broken.test.mjs'], readme.notes)
  assert.equal(readme.baseline_failing.length, readme.failing_tests.length, 'every failure there fails at the base too')
  assert.deepEqual(measurementOk(readme, leaf).failures, [], 'a failure that was already there is not this change\'s')

  const broke = measure(commit({ 'src/widget.mjs': 'export const widget = () => { throw new Error(\'no\') }\n' }, 'Break the widget'))
  assert.ok(broke.failing_tests.length > broke.baseline_failing.length, 'the change broke tests that pass at the base: ' + JSON.stringify(broke.failing_tests))
  assert.ok(broke.baseline_failing.every((f) => f.file === 'test/broken.test.mjs'))
  assert.ok(measurementOk(broke, leaf).failures.some((f) => f.check === 'suite'), 'a regression in a file already failing at the base is not excused')
})

test('the tests run under the project\'s test lock, and the build outside it', (t) => {
  const { dir, worktree, base, head } = order(t)
  const lock = join(dir, '.agentics', '.state', 'locks', 'tests.lock').split('\\').join('/')
  const held = (want) => 'node -e "process.exit(require(\'fs\').existsSync(\'' + lock + '\') === ' + want + ' ? 0 : 1)"'
  const payload = verify({
    ...options({ worktree, base, head, extra: ['--repo', dir, '--effort', EFFORT, '--execution', EXECUTION, '--node', NODE] }),
    rigor: 'trivial', build: held(false), suite: held(true),
  })
  assert.equal(payload.build, 'passed', 'the build ran with the lock free: ' + payload.notes)
  assert.equal(payload.suite, 'passed', 'the suite ran holding the lock: ' + payload.notes)
  assert.equal(existsSync(lock), false, 'released once the tests ran')
})

test('without somewhere to write, nothing is journalled and the payload says so by null', (t) => {
  const { worktree, base, head } = order(t)
  const payload = verify(options({ worktree, base, head, extra: ['--rigor', 'trivial'] }))
  assert.equal(payload.journal, null)
})

test('a refused append is reported on the payload rather than thrown', (t) => {
  const { dir, worktree, base, head } = order(t)
  const payload = verify(options({ worktree, base, head, extra: [
    '--rigor', 'trivial', '--repo', dir, '--effort', 'bad--slug', '--execution', EXECUTION, '--node', NODE,
  ] }))
  assert.equal(payload.journal.written, false)
  assert.match(payload.journal.error, /not an effort name/)
  assert.equal(payload.stop_reason, 'completed', 'the measurement itself is unaffected')
})

test('journalLine is pure and carries the observed head', () => {
  const line = journalLine({ node: 'a/b', branch: 'agentics/e--a.b', worktree: 'C:\\w', base: 'b0' },
    { stop_reason: 'completed', build: 'passed', typecheck: 'absent', suite: 'passed', failing_tests: [],
      discriminator: [], mutations: [], series_findings: [], checks: [{ command: 'x', status: 'passed' }] },
    'h1')
  assert.equal(line.node, 'a/b')
  assert.equal(line.worktree, 'C:/w')
  assert.equal(line.head_sha, 'h1')
  assert.equal(line.base_sha, 'b0')
  assert.equal('seq' in line, false, 'the ledger mints seq; a line never carries one in')
  assert.deepEqual(line.checks, [{ command: 'x', status: 'passed' }])
})

// ---------------------------------------------------------------- rigor selects the checks

test('checksFor: the SPEC table, a role outranking its rigor and integration outranking both', () => {
  const pick = (o) => {
    const c = checksFor(o)
    return [c.profile, c.series, c.discriminator, c.mutations, c.checks, c.emptySeriesExpected]
  }
  assert.deepEqual(pick({ rigor: 'verify' }), ['verify', false, false, false, true, false])
  assert.deepEqual(pick({ rigor: 'trivial' }), ['trivial', true, false, false, true, false])
  assert.deepEqual(pick({ rigor: 'tests-only' }), ['tests-only', true, true, true, true, false])
  assert.deepEqual(pick({ rigor: 'tdd' }), ['tdd', true, true, true, true, false])
  assert.deepEqual(pick({ rigor: 'tdd-pair', role: 'red' }), ['red', true, true, false, false, false])
  assert.deepEqual(pick({ rigor: 'tdd-triad', role: 'green' }), ['green', true, true, false, false, false])
  assert.deepEqual(pick({ rigor: 'tdd-triad', role: 'audit' }), ['audit', true, false, true, false, true])
  assert.deepEqual(pick({}), ['tdd', true, true, true, true, false], 'no rigor measures as before rigor existed')
  assert.deepEqual(pick({ mode: 'integration', rigor: 'tdd-pair', role: 'red' }),
    ['integration', false, false, false, true, false])
})

const check = (command) => ['--check-b64', Buffer.from(command, 'utf8').toString('base64')]

test('a trivial leaf asks no discriminator, and runs its named checks', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: [
    '--rigor', 'trivial', ...check('node -e "process.exit(0)"'), ...check('node -e "process.exit(4)"'),
  ] }))

  assert.equal(payload.stop_reason, 'completed')
  assert.deepEqual(payload.discriminator, [], 'a trivial change has no test that would not restate it')
  assert.deepEqual(payload.series_findings, [], 'but its series is still held to the locus')
  assert.deepEqual(payload.checks, [
    { command: 'node -e "process.exit(0)"', status: 'passed' },
    { command: 'node -e "process.exit(4)"', status: 'failed' },
  ])
  assert.match(payload.notes, /check "node -e \\"process.exit\(4\)\\"": failed \(exit 4\)/)
})

test('a named check that cannot be launched is unrunnable, never failed', (t) => {
  // 127 is the shell's own "no such command". A check nobody could launch was never observed,
  // and a fix round sent after it would look for a defect in code that is really in the criterion.
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: [
    '--rigor', 'trivial', ...check('agentics-no-such-command-anywhere --flag'),
  ] }))

  assert.deepEqual(payload.checks, [{ command: 'agentics-no-such-command-anywhere --flag', status: 'unrunnable' }])
  assert.equal(payload.stop_reason, 'completed', 'an unrunnable check is an outcome the verdict reads')
})

test('a verify leaf runs no series and no discriminator: it writes nothing', (t) => {
  // Measured in a worktree whose branch carries commits outside any locus — which a verify leaf
  // would have to be blamed for if its series were checked. It is not.
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head, '--rigor', 'verify',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE,
    ...check('node -e "process.exit(0)"'),
  ]))

  assert.equal(payload.stop_reason, 'completed')
  assert.equal(payload.error, null, 'no single-test command is needed where no discriminator runs')
  assert.deepEqual(payload.series_findings, [])
  assert.deepEqual(payload.discriminator, [])
  assert.deepEqual(payload.checks, [{ command: 'node -e "process.exit(0)"', status: 'passed' }])
  assert.equal(payload.build, 'passed')
  assert.equal(payload.suite, 'passed')
  assert.match(payload.notes, /series check not run/)
})

test('a verify leaf still refuses a command nobody named: absent is never inferred', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', base, '--head', head, '--rigor', 'verify',
    '--typecheck-absent', '--suite', SUITE, ...check('node -e "0"'),
  ]))

  assert.equal(payload.error.kind, 'command_unknown')
  assert.match(payload.error.message, /build/)
})

test('a red leaf runs no mutation and no named check, and says what it was given', (t) => {
  const { worktree, base, head } = order(t, { implemented: false })

  const payload = verify(options({ worktree, base, head, extra: [
    '--rigor', 'tdd-pair', '--role', 'red', ...check('node -e "0"'),
    ...mutations([{ file: 'src/widget.mjs', find: "'plain'", replace: "'x'", expect_failing: ['test/widget.test.mjs'] }]),
  ] }))

  assert.equal(payload.stop_reason, 'completed')
  assert.deepEqual(payload.discriminator, [
    { test_id: 'test/widget.test.mjs', failed_on_base: true, passes_now: false },
  ])
  assert.deepEqual(payload.mutations, [])
  assert.deepEqual(payload.checks, [])
  assert.match(payload.notes, /1 mutation spec\(s\) given and not run/)
  assert.match(payload.notes, /1 named check\(s\) given and not run/)
})

test('a green leaf is discriminated over its cycle\'s tests, which its own diff does not touch', (t) => {
  const { worktree, red, head } = cycle(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', red, '--head', head,
    '--rigor', 'tdd-pair', '--role', 'green', '--locus', 'src/widget.mjs',
    '--test-file', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  assert.equal(payload.stop_reason, 'completed')
  assert.deepEqual(payload.series_findings, [], 'the green series touches only its own locus')
  assert.deepEqual(payload.discriminator, [
    { test_id: 'test/widget.test.mjs', failed_on_base: true, passes_now: true },
  ], 'the red test fails at the red head and passes now')
  assert.equal(git(worktree, 'status', '--porcelain').stdout.trim(), '')
  assert.equal(rev(worktree, 'HEAD'), head)
})

test('a green leaf with no cycle tests named measures its own diff, finds none, and says so', (t) => {
  const { worktree, red, head } = cycle(t)

  const payload = verify(parseArgs([
    '--worktree', worktree, '--base', red, '--head', head,
    '--rigor', 'tdd-pair', '--role', 'green', '--locus', 'src/widget.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE, '--test-one', TEST_ONE,
  ]))

  assert.deepEqual(payload.discriminator, [])
  assert.match(payload.notes, /none of the red tests was measured/)
})

test('an audit leaf expects an empty series, and its declared mutations are run', (t) => {
  // An auditor edits nothing, so its branch is its green's head with no commit of its own.
  const { worktree, head } = order(t)

  const payload = verify(options({ worktree, base: head, head, extra: [
    '--rigor', 'tdd-triad', '--role', 'audit',
    ...mutations([{ file: 'src/widget.mjs', find: "'hi'", replace: "'bye'", expect_failing: ['test/widget.test.mjs'] }]),
  ] }))

  assert.equal(payload.stop_reason, 'completed')
  assert.deepEqual(payload.series_findings, [], 'an empty series is the audit\'s expected shape')
  assert.deepEqual(payload.discriminator, [])
  assert.equal(payload.mutations.length, 1)
  assert.equal(payload.mutations[0].bites, true)
})

test('an empty series is still a blocking finding for every other rigor', (t) => {
  const { worktree, head } = order(t)
  const payload = verify(options({ worktree, base: head, head, extra: ['--rigor', 'trivial'] }))
  assert.equal(payload.series_findings[0].check, 'empty-series')
  assert.equal(payload.series_findings[0].blocking, true)
})

test('a tests-only leaf runs the discriminator and its declared mutations', (t) => {
  const { worktree, base, head } = order(t)

  const payload = verify(options({ worktree, base, head, extra: [
    '--rigor', 'tests-only',
    ...mutations([{ file: 'src/widget.mjs', find: "'hi'", replace: "'bye'", expect_failing: ['test/widget.test.mjs'] }]),
  ] }))

  assert.equal(payload.discriminator.length, 1)
  assert.equal(payload.discriminator[0].passes_now, true)
  assert.equal(payload.mutations[0].bites, true)
})

test('named checks travel only as base64, and every option parses', () => {
  const o = parseArgs(['--rigor', 'tdd-pair', '--role', 'green', '--test-file', 'test/a.test.mjs',
    ...check("npm run e2e -- 'login flow'"), '--repo', '/r', '--effort', 'e', '--execution', EXECUTION,
    '--node', 'a/b', '--branch', 'agentics/e--a.b'])
  assert.equal(o.rigor, 'tdd-pair')
  assert.equal(o.role, 'green')
  assert.deepEqual(o.tests, ['test/a.test.mjs'])
  assert.deepEqual(o.checks, ["npm run e2e -- 'login flow'"])
  assert.equal(o.repo, '/r')
  assert.equal(o.effort, 'e')
  assert.equal(o.execution, EXECUTION)
  assert.equal(o.node, 'a/b')
  assert.equal(parseArgs([]).role, 'none')
  assert.deepEqual(parseArgs([]).checks, [])
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
    '--locus', 'src/widget.mjs', '--locus', 'test/widget.test.mjs',
    '--build', BUILD, '--typecheck-absent', '--suite', SUITE_TAP, '--test-one', TEST_ONE,
  ]))

  assert.equal(payload.error, null)
  assert.equal(payload.stop_reason, 'completed')
  assert.equal(payload.suite, 'failed')
  assert.deepEqual([...new Set(payload.failing_tests.map((f) => f.file))], ['test/widget.test.mjs'])
})

test('two TAP failures in two files are each placed in their own, never the previous one\'s', (t) => {
  const { worktree } = order(t, { implemented: true })
  writeFileSync(join(worktree, 'test', 'other.test.mjs'), WIDGET_TEST)
  const at = (file) => "  location: '" + worktree + '/test/' + file + ":5:1'"

  const found = extractFailures([
    'not ok 1 - first failure', '  ---', at('widget.test.mjs'), '  ...',
    'not ok 2 - second failure', '  ---', "  type: 'test'", at('other.test.mjs'), '  ...',
  ].join('\n'), worktree)

  assert.equal(found.unplaced, 0)
  assert.deepEqual(found.failures, [
    { file: 'test/widget.test.mjs', id: 'first failure' },
    { file: 'test/other.test.mjs', id: 'second failure' },
  ])
})

test('a TAP failure whose block names no location falls back to the path in force at its marker', (t) => {
  const { worktree } = order(t, { implemented: true })

  const found = extractFailures([
    '# Subtest: ' + worktree + '/test/widget.test.mjs', 'not ok 1 - test/widget.test.mjs', '  ---', '  ...',
    'not ok 2 - nameless', '  ---', "  type: 'test'", '  ...',
  ].join('\n'), worktree)

  assert.deepEqual(found.failures.map((f) => f.file), ['test/widget.test.mjs', 'test/widget.test.mjs'])
  assert.equal(found.unplaced, 0)
})

// ---------------------------------------------------------------- the closed pattern set

test('the test-file pattern set recognises the shapes it claims to', () => {
  for (const path of ['test/a.test.mjs', 'tests/b.py', 'src/__tests__/c.js', 'spec/d.rb',
    'lib/e.spec.ts', 'pkg/f_test.go', 'app/test_g.py', 'src/WidgetTest.java']) {
    assert.ok(isTestPath(path), path + ' should read as a test file')
  }
  for (const path of ['src/widget.mjs', 'docs/testing.md', 'latest/thing.js', 'src/protest.c']) {
    assert.ok(!isTestPath(path), path + ' should not read as a test file')
  }
})

// ---------------------------------------------------------------- summary lines vs paths
//
// The scanner's summary guard exists so a runner's counters are not attributed to whatever file
// was printed last. Its cost, until 20260902-124933, was that `tests/` is also how most of the
// world names its test directory: `\b` treats `/` as a word boundary, so every vitest and jest
// `FAIL tests/…` line read as the summary word `tests` and was discarded. The suite then failed
// while naming nothing, which is `suite_failures_unnamed`, which is `environment_broken`, which
// `verifiable()` refuses — so a correct red order could not be verified at all and the fix round
// sent at it had no defect to find.

test('a FAIL line naming a path under tests/ is a failure, not a summary counter', (t) => {
  const { worktree } = order(t, { implemented: true })
  writeFileSync(join(worktree, 'test', 'widget.test.mjs'), WIDGET_TEST)

  const found = extractFailures(
    ' FAIL  test/widget.test.mjs [ test/widget.test.mjs ]\n' +
    "Error: Cannot find module '../src/nothing.mjs'\n", worktree)

  assert.equal(found.unplaced, 0)
  assert.deepEqual(found.failures.map((f) => f.file), ['test/widget.test.mjs'],
    'the runner named the file on its own FAIL line; nothing here has to guess')
})

test('a runner\'s own counters are still discarded, which is what the guard is for', (t) => {
  const { worktree } = order(t, { implemented: true })

  for (const line of ['✖ tests 5', '✖ pass 4', '✖ fail 1',
    '✖ duration_ms 12.5', '✖ cancelled 0', 'FAIL  Tests  3 failed']) {
    const found = extractFailures(line + '\n', worktree)
    assert.deepEqual(found.failures, [], line + ' names no test and must place nothing')
    assert.equal(found.unplaced, 0, line + ' is a counter, not a failure nobody could place')
  }
})

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
