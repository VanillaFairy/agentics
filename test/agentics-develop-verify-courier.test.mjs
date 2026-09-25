// test/agentics-develop-verify-courier.test.mjs — the verify dispatch's transport ladder.
//
// Verification used to be a sonnet agent running four commands and typing what it saw into a
// schema, once per order and again per fix round. The commands are one program now
// (lib/verify.mjs), so the dispatch names it, a courier pastes its stdout, and this script
// recomputes the digest that stdout carries before believing a field of it.
//
// That leaves four things to pin here, and none of them is about whether an order passed —
// the predicates that decide THAT are untouched, and their tests needed no edits:
//
//   the happy path      — one courier, at courier grade, pointed at this order's own fence
//   damaged in transit  — one refetch, one tier up, and the run carries on as if nothing happened
//   carried by no tier  — an escalation that names the transport rather than the work
//   the runner refused  — a typed error is judgment, and buys an investigator instead
//
// The fourth is the one worth stating twice: `command_unknown` is what a repository whose
// verification commands nobody has established looks like, and what the investigator establishes
// then rides the rest of the run — which is what makes every later check a script.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carriedChain, carriedPayload, runWorkflow, scriptedAgents } from './harness/workflow-host.mjs'

const WF = fileURLToPath(new URL('../workflows/agentics-develop.workflow.js', import.meta.url))

const A40 = 'a'.repeat(40)
const B40 = 'b'.repeat(40)
const M40 = 'e'.repeat(40)
const N40 = 'f'.repeat(40)

const RUN_DIR = 'C:/repo/.claude/agentics/runs/20260816-143005'
const ARGS = { change: 'add the thing', roots: '.', plugin_root: 'C:/plugin' }

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')

const surveyResult = () => ({
  question: 'q', topics: [], verdicts: [], history: null, docs: null,
  coverage: {
    complete: true, dropped: [], incomplete: [], failed_channels: [], unreached: [],
    resumable: { runId: 'r', remaining: [] },
  },
})

const order = (id, over = {}) => ({
  id, title: 'do ' + id, role: 'none', locus: ['src/' + id + '.js'], reads: [],
  acceptance: ['builds'], context: 'ctx', deps: [], contract: false, ...over,
})

const plan = (orders, waves) => ({
  work_orders: orders,
  shared_files: [],
  partition_raw: JSON.stringify({ waves: waves || [orders.map((o) => o.id)], coupled: [] }),
  blocking_gaps: [],
  plan_path: RUN_DIR,
  notes: '',
})

const coded = (id, over = {}) => ({
  status: 'done', worktree: 'C:/wt/' + id, branch: 'wo-' + id, base_sha: A40, head_sha: B40,
  commits: [{ sha: B40, subject: 'feat: ' + id }], concerns: [], discovered: [], summary: 's',
  ...over,
})

/** The measurement a green order produces, wrapped the way the courier delivers it. */
const verified = (over = {}, damage) => carriedPayload({
  stop_reason: 'completed', build: 'passed', suite: 'passed', suite_output_tail: 'ok',
  failing_tests: [],
  discriminator: [{ test_id: 'test/w1.test.js', failed_on_base: true, passes_now: true }],
  series_findings: [], notes: 'ran the checks',
}, damage)

/** The same, with a field changed AFTER its digest was taken — a courier that dropped a byte. */
const damagedInTransit = () => verified({}, (env) => { env.payload.suite = 'failed' })

/** A whole, correctly digested payload that says the runner could not answer. */
const refused = (kind, message) => carriedPayload({
  stop_reason: 'environment_broken', build: 'absent', suite: 'absent',
  notes: message, error: { kind, message },
})

/** What an investigator returns: the same facts, measured by hand, plus what it established. */
const investigated = (over = {}) => ({
  // A repository with no separate typecheck, which is the ordinary case: the investigator went
  // and looked, found none, and says so. That is a fact it established, not a question it ducked.
  stop_reason: 'completed', build: 'passed', typecheck: 'absent', suite: 'passed',
  suite_output_tail: 'ok',
  failing_tests: [],
  discriminator: [{ test_id: 'test/w1.test.js', failed_on_base: true, passes_now: true }],
  series_findings: [],
  commands: { build: 'npm run build', typecheck: '', suite: 'npm test', test_one: 'npm test -- {file}' },
  notes: 'read package.json and ran both commands by hand',
  ...over,
})

/**
 * A verify answer per EXACT label, falling back to a green measurement.
 *
 * The prefix routing in `scriptedAgents` cannot express "the first attempt fails and the second
 * succeeds" — `verify:` matches both — and that is precisely the ladder under test.
 */
const courierSaying = (byLabel, fallback = verified()) => (prompt, opts) => {
  const entry = byLabel[opts.label]
  return entry === undefined ? fallback : entry
}

const mergeSequence = (shas) => {
  let i = 0
  return () => ({
    stop_reason: 'completed', merged_sha: shas[Math.min(i++, shas.length - 1)],
    conflicts: [], notes: 'git merge --no-ff',
  })
}

const cast = (over = {}) => scriptedAgents({
  'existing-runs': { stop_reason: 'observed', runs: [], notes: 'no runs directory' },
  plan: plan([order('W1')]),
  'integration-setup': {
    stop_reason: 'completed', worktree: 'C:/repo/.claude/worktrees/int',
    branch: 'agentics/20260816-143005-integration', head_sha: A40, notes: 'created',
  },
  'merge:': mergeSequence([M40, N40]),
  'wave-verify:': verified({ discriminator: [], notes: 'the merged head' }),
  'record:': { stop_reason: 'recorded', path: RUN_DIR + '/state.jsonl', notes: 'appended' },
  'kb-chain': carriedChain(),
  'kb-write': { stop_reason: 'recorded', path: '.claude/agentics/kb', notes: 'appended' },
  'review:integration': { findings: [], fix_verdicts: [] },
  'code:': (prompt, opts) => coded((opts.label || '').split(':')[1] || 'W1'),
  'verify:': verified(),
  'review:': { findings: [], fix_verdicts: [] },
  ...over,
})

const run = (over) => runWorkflow(WF, {
  args: ARGS, workflow: () => surveyResult(), agent: cast(over),
})

const promptFor = (prompts, label) => (prompts.find((p) => p.opts.label === label) || {}).prompt || ''
const labelsMatching = (prompts, re) =>
  prompts.map((p) => p.opts.label || '').filter((l) => re.test(l))

// ── the happy path ───────────────────────────────────────────────────────────────────────────

test('one courier at courier grade carries the whole measurement', async () => {
  const { result, prompts } = await run()

  const verifies = prompts.filter((p) => /^verify/.test(p.opts.label || ''))
  assert.deepEqual(verifies.map((p) => p.opts.label), ['verify:W1'],
    'a measurement that arrives intact buys nothing else — no retry, no investigator')
  assert.equal(verifies[0].opts.model, 'haiku',
    'running a command and pasting its output is courier work, and is priced as courier work')

  assert.deepEqual(result.implemented.map((e) => e.id), ['W1'])
  assert.deepEqual(result.implemented[0].review.measured, ['build', 'suite', 'discriminator:1'])
  assert.deepEqual(result.integration.merged, ['W1'])
  assert.equal(result.coverage.complete, true)
})

test('the dispatch names the runner, the tree, the range and this order\'s own fence', async () => {
  const { prompts } = await run()
  const verify = promptFor(prompts, 'verify:W1')

  assert.match(verify, /node "C:\/plugin\/lib\/verify\.mjs"/)
  assert.match(verify, /--worktree "C:\/wt\/W1"/)
  assert.match(verify, new RegExp('--base ' + A40 + ' --head ' + B40))
  assert.match(verify, /--locus "src\/W1\.js"/,
    'the fence every series finding is measured against travels as an argument, not as prose')

  // The durability law, one writer down: the program writes the journal line inside the process
  // that made the measurement, so the courier is handed the run directory and the ordering and
  // is told to append nothing of its own.
  assert.match(verify, new RegExp('--journal "' + RUN_DIR + '" --seq \\d+ --order W1 --branch wo-W1'))
  assert.match(verify, /writes this run's journal line itself/)
})

// ── damaged in transit ───────────────────────────────────────────────────────────────────────

test('a measurement damaged in transit is refetched once, one tier up', async () => {
  // A courier that drops a byte is the failure the digest exists to catch, and catching it is
  // only half the answer: the other half is that the run recovers rather than escalating an
  // order whose work was never in question.
  const { result, prompts, logs } = await run({
    'verify:': courierSaying({ 'verify:W1': damagedInTransit() }),
  })

  assert.deepEqual(labelsMatching(prompts, /^verify/), ['verify:W1', 'verify:W1#2'])
  assert.equal(prompts.find((p) => p.opts.label === 'verify:W1#2').opts.model, undefined,
    'the refetch is the tier raise — the courier tier already failed at this')
  assert.match(logs.join(' '), /did not survive the trip/,
    'a healed measurement is reported, not silent')

  assert.deepEqual(result.implemented.map((e) => e.id), ['W1'])
  assert.deepEqual(result.escalations, [],
    'the work was never the problem, and must not be escalated as though it were')
  assert.equal(result.coverage.complete, true)
})

test('a measurement no tier can carry escalates, naming the transport and not the work', async () => {
  const { result, prompts } = await run({
    'verify:': courierSaying({
      'verify:W1': damagedInTransit(), 'verify:W1#2': damagedInTransit(),
    }),
  })

  assert.deepEqual(labelsMatching(prompts, /^verify/), ['verify:W1', 'verify:W1#2'],
    'two rungs, not a loop: a third courier types into the same shell as the second')
  assert.ok(!prompts.some((p) => (p.opts.label || '').startsWith('fix:')),
    'a fix round would send a coder at a defect nobody has actually observed')

  assert.equal(result.escalations.length, 1)
  assert.equal(result.escalations[0].reason, 'verify_untransportable')
  assert.match(result.escalations[0].unresolved.map((f) => f.claim).join(' '), /digest mismatch/)
  assert.deepEqual(result.integration.merged, [],
    'an order verified on a payload nothing vouches for is an order nobody verified')
  assert.equal(result.coverage.complete, false)
})

// ── the runner ran and could not answer ──────────────────────────────────────────────────────

test('a typed error is judgment, and buys an investigator rather than a second courier', async () => {
  const { result, prompts } = await run({
    'verify:': courierSaying({
      'verify:W1': refused('command_unknown', 'no build command was named and none was declared absent'),
    }),
    'verify-investigate:W1': investigated(),
  })

  assert.ok(!prompts.some((p) => p.opts.label === 'verify:W1#2'),
    'a payload that arrived whole and said no is not a transcription defect')

  const investigate = promptFor(prompts, 'verify-investigate:W1')
  assert.match(investigate, /command_unknown/, 'the runner\'s own words reach the model, verbatim')
  assert.match(investigate, /commit-series\.mjs/, 'and the by-hand procedure is what it performs')
  assert.match(investigate, /NAME THE COMMANDS/)

  assert.deepEqual(result.implemented.map((e) => e.id), ['W1'],
    'the investigator\'s facts are measured facts, and the verdict is computed from them as ever')
  assert.deepEqual(result.implemented[0].review.measured, ['build', 'suite', 'discriminator:1'])
  assert.equal(result.coverage.complete, true)
})

test('an environment the investigator could not fix still fails, through the ordinary path',
  async () => {
    // The escalation is not a way out of a verdict. An investigator that reports a broken
    // environment produces exactly what a broken environment always produced: findings, a fix
    // round, and an escalation when nothing moves.
    const { result, prompts } = await run({
      'verify:': courierSaying({ 'verify:W1': refused('tree_not_restored', 'HEAD is detached') }),
      'verify-investigate:W1': investigated({
        stop_reason: 'environment_broken', notes: 'the worktree is still detached',
      }),
      'fix:W1': coded('W1', { commits: [], head_sha: B40 }),
    })

    assert.ok(prompts.some((p) => p.opts.label === 'fix:W1'))
    assert.equal(result.escalations.length, 1)
    assert.equal(result.escalations[0].reason, 'verify_failed_repeatedly')
    assert.equal(result.coverage.complete, false)
  })

// ── what an investigation establishes outlives the order that bought it ──────────────────────

test('the commands an investigator establishes are what every later check runs', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { prompts } = await run({
    plan: plan(orders, [['W1'], ['W2']]),
    'verify:': courierSaying({
      'verify:W1': refused('command_unknown', 'no build command was named'),
    }),
    'verify-investigate:W1': investigated(),
  })

  const w2 = promptFor(prompts, 'verify:W2')
  assert.ok(w2.includes('--build-b64 ' + b64('npm run build')),
    'the second order runs a script with the command the first order bought a model to find')
  assert.ok(w2.includes('--suite-b64 ' + b64('npm test')))
  assert.ok(w2.includes('--test-one-b64 ' + b64('npm test -- {file}')),
    'commands travel base64 for the reason state lines do: they are free shell text')
  assert.ok(!prompts.some((p) => p.opts.label === 'verify-investigate:W2'),
    'choosing a build command is bought once per run, not once per order')

  assert.match(promptFor(prompts, 'code:W2'), /build command, established by verification: npm run build/,
    'and what was established is advisory context for the coders too')
})

test('a coder\'s discovered command never becomes the command a measurement runs', async () => {
  // The standing asymmetry, restated for the new shape: what an order's coder reports is a
  // model's claim, and what a verdict is computed from must be a measurement. The commands the
  // runner is invoked with therefore come only from the verification role's own establishment —
  // which is why they are not read back out of the knowledge set they are written into.
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { prompts } = await run({
    plan: plan(orders, [['W1'], ['W2']]),
    'code:': (prompt, opts) => coded((opts.label || '').split(':')[1],
      { discovered: ['build with `make -j8`'] }),
  })

  const w2 = promptFor(prompts, 'verify:W2')
  assert.ok(!/make -j8/.test(w2), 'plainly')
  assert.ok(!/--build-b64|--build-absent/.test(w2),
    'and structurally: nothing established the build command, so the runner is told nothing ' +
    'and returns command_unknown, which escalates to somebody who can go and look')

  assert.match(promptFor(prompts, 'code:W2'), /make -j8/,
    'the coders still get it, as the advisory report it is')
})

// ── the merged head ──────────────────────────────────────────────────────────────────────────

test('wave verification is the same courier with a different mode', async () => {
  const { result, prompts } = await run()
  const wave = promptFor(prompts, 'wave-verify:1')

  assert.match(wave, /--mode integration/)
  assert.ok(!/--locus/.test(wave),
    'there is no single declared locus at the merged head, so none is named')
  assert.ok(!/--journal/.test(wave),
    'a wave is recorded by its state line; a journal line here would name an order there is none of')
  assert.equal(prompts.find((p) => p.opts.label === 'wave-verify:1').opts.model, 'haiku')

  assert.deepEqual(result.integration.wave_verify, [{ wave: 1, build: 'passed', suite: 'passed' }])
})

test('a merged head the runner could not measure is measured by hand, not assumed', async () => {
  const { result, prompts } = await run({
    'wave-verify:': refused('shell_refused', 'the shell could not start "npm test"'),
    'wave-investigate:1': investigated({ discriminator: [], notes: 'ran both by hand' }),
  })

  const investigate = promptFor(prompts, 'wave-investigate:1')
  assert.match(investigate, /shell_refused/)
  assert.match(investigate, /Skip the commit-series check and skip the discriminator/)

  assert.deepEqual(result.integration.wave_verify, [{ wave: 1, build: 'passed', suite: 'passed' }])
  assert.deepEqual(result.integration.merged, ['W1'],
    'the line is not stopped by a measurement that was obtainable another way')
})

test('a merged head nobody could measure stops the line', async () => {
  const { result, logs } = await run({
    'wave-verify:': { stop_reason: 'failed', payload_raw: '', notes: 'node is not on PATH' },
  })

  assert.match(logs.join(' '), /two couriers could not carry the merged head/)
  assert.equal(result.integration.wave_verify[0].build, 'unobserved')
  assert.equal(result.coverage.complete, false)
})
