// test/agentics-develop-existing-run.test.mjs — the existing-run guard (the 2026-08-19 field
// incident).
//
// The 2026-08-17 incident got step 0 in the develop skill: look for a run before planning
// one. Two days later the same failure recurred through a crack the skill cannot reach: a
// relaunch with the harness's own resumeFromRunId, whose cache silently missed after the
// prior resumed task was hard-killed. The workflow saw a perfectly ordinary fresh invocation
// — no resume_path, a change string it had no reason to distrust — and re-bought the survey,
// the plan and half of wave 1 for a change whose 13-order plan and eight part-built order
// branches sat on disk throughout (~4M tokens for a duplicate partition under a new
// runstamp, which also renamed every order id and thereby blinded the scavenger).
//
// The guard is the mechanical end of it: before a fresh invocation surveys anything, one
// cheap observation of .claude/agentics/runs, and an exact string comparison — computed by the
// script, never judged by the agent — between this change and every planned or in-flight
// run's recorded one. A match is a checkpoint, not a plan.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carriedChain, carriedPayload, runWorkflow, scriptedAgents } from './harness/workflow-host.mjs'

/**
 * Expand a single-loader-era fixture into the resume fan's two dispatch surfaces: the
 * 'resume-index' answer (everything but the orders) and a 'load:' prefix responder that
 * serves each order slice out of the same fixture, retry labels included.
 */
const resumeLoad = (v) => ({
  'resume-index': {
    stop_reason: v.stop_reason,
    order_ids: v.plan ? (v.plan.work_orders || []).map((o) => o.id) : [],
    shared_files: v.plan ? v.plan.shared_files : [],
    partition_raw: v.plan ? v.plan.partition_raw : '',
    blocking_gaps: v.plan ? v.plan.blocking_gaps : [],
    plan_path: v.plan ? v.plan.plan_path : '',
    plan_notes: v.plan ? (v.plan.notes || '') : '',
    envelope: v.envelope || { change: '', roots: '', caller_notes: '', intelligence: '',
                              base_branch: '', base_sha: '', programme: '', slice: '' },
    manifest: v.manifest || [],
    state: v.state || [],
    notes: v.notes || '',
  },
  'load:': (prompt, opts) => {
    const id = (opts.label || '').replace(/^load:/, '').replace(/#\d+$/, '')
    const wo = v.plan && (v.plan.work_orders || []).find((o) => o.id === id)
    return wo ? { stop_reason: 'loaded', orders: [wo], notes: '' }
              : { stop_reason: 'not_found', orders: [], notes: 'no order ' + id }
  },
})


const WF = fileURLToPath(new URL('../workflows/agentics-develop.workflow.js', import.meta.url))

const A40 = 'a'.repeat(40)
const B40 = 'b'.repeat(40)
const M40 = 'e'.repeat(40)

const RUN_DIR = 'C:/repo/.claude/agentics/runs/20260819-062330'
const ARGS = { change: 'add the thing', roots: '.', plugin_root: 'C:/plugin' }

const surveyResult = () => ({
  question: 'q', topics: [], verdicts: [], history: null, docs: null,
  coverage: {
    complete: true, dropped: [], incomplete: [], failed_channels: [], unreached: [],
    resumable: { runId: 'r', remaining: [] },
  },
})

const order = (id) => ({
  id, title: 'do ' + id, role: 'none', locus: ['src/' + id + '.js'], reads: [],
  acceptance: ['builds'], context: 'ctx', deps: [], contract: false,
})

const plan = () => ({
  work_orders: [order('W1')],
  shared_files: [],
  partition_raw: JSON.stringify({ waves: [['W1']], coupled: [] }),
  blocking_gaps: [],
  plan_path: RUN_DIR,
  notes: '',
})

const runRow = (over = {}) => ({
  runstamp: '20260819-062330', path: RUN_DIR, change: 'add the thing', status: 'in-flight',
  ...over,
})

const observed = (runs = []) =>
  ({ stop_reason: 'observed', runs, notes: runs.length ? 'runs found' : 'no runs directory' })

const cast = (over = {}) => scriptedAgents({
  'existing-runs': observed(),
  plan: plan(),
  'integration-setup': {
    stop_reason: 'completed', worktree: 'C:/repo/.claude/worktrees/agentics-20260819-062330-integration',
    branch: 'agentics/20260819-062330-integration', head_sha: A40, notes: 'created',
  },
  'merge:': { stop_reason: 'completed', merged_sha: M40, conflicts: [], notes: 'merged' },
  'wave-verify:': carriedPayload({
    stop_reason: 'completed', build: 'passed', suite: 'passed', suite_output_tail: 'ok',
    failing_tests: [], discriminator: [], series_findings: [], notes: 'merged head',
  }),
  'record:': { stop_reason: 'recorded', path: RUN_DIR + '/state.jsonl', notes: 'appended' },
  'kb-chain': carriedChain(),
  'kb-write': { stop_reason: 'recorded', path: '.claude/agentics/kb', notes: 'appended' },
  'review:integration': { findings: [], fix_verdicts: [] },
  'code:': {
    status: 'done', worktree: 'C:/wt/w1', branch: 'wo-w1', base_sha: A40, head_sha: B40,
    commits: [{ sha: B40, subject: 'feat: w1' }], concerns: [], discovered: [], summary: 's',
  },
  'verify:': carriedPayload({
    stop_reason: 'completed', build: 'passed', suite: 'passed', suite_output_tail: 'ok',
    failing_tests: [],
    discriminator: [{ test_id: 'test/w1.test.js', failed_on_base: true, passes_now: true }],
    series_findings: [], notes: 'ran node --test',
  }),
  'review:': { findings: [], fix_verdicts: [] },
  ...over,
})

const run = (over, args = {}) => runWorkflow(WF, {
  args: { ...ARGS, ...args }, workflow: () => surveyResult(), agent: cast(over),
})

test('a planned run recording the same change halts at a checkpoint, before the survey', async () => {
  let surveyCalls = 0
  const { result, prompts } = await runWorkflow(WF, {
    args: ARGS,
    workflow: () => { surveyCalls += 1; return surveyResult() },
    agent: cast({ 'existing-runs': observed([runRow({ status: 'planned' })]) }),
  })

  assert.ok(result.checkpoint)
  assert.equal(result.checkpoint.reason, 'existing_run')
  assert.equal(result.checkpoint.resume_path, RUN_DIR)
  assert.equal(result.checkpoint.existing_run.status, 'planned')
  assert.equal(surveyCalls, 0, 'the survey is the first spend the guard exists to withhold')
  assert.ok(!prompts.some((p) => p.opts.label === 'plan'))
  assert.ok(!prompts.some((p) => p.opts.label === 'integration-setup'),
    'nothing is created for a run that was refused')
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.unreached.some((u) => /already exists/.test(u)))
})

test('an in-flight run blocks exactly the same way', async () => {
  const { result } = await run({ 'existing-runs': observed([runRow()]) })

  assert.equal(result.checkpoint.reason, 'existing_run')
})

test('the comparison is exact: a different change plans normally', async () => {
  const { result } = await run({
    'existing-runs': observed([runRow({ change: 'add the other thing' })]),
  })

  assert.equal(result.checkpoint, null)
  assert.deepEqual(result.integration.merged, ['W1'])
})

test('integrated and landed runs do not block — re-implementing landed work is rework, not a duplicate', async () => {
  const { result } = await run({
    'existing-runs': observed([runRow({ status: 'landed' }), runRow({ status: 'integrated' })]),
  })

  assert.equal(result.checkpoint, null)
  assert.deepEqual(result.integration.merged, ['W1'])
})

test('confirmed_duplicate bypasses the guard without dispatching it', async () => {
  const { result, prompts } = await run({}, { confirmed_duplicate: true })

  assert.ok(!prompts.some((p) => p.opts.label === 'existing-runs'),
    'a deliberate duplicate does not pay for the observation it has already answered')
  assert.equal(result.checkpoint, null)
  assert.deepEqual(result.integration.merged, ['W1'])
})

test('a resume dispatches no guard — resume_path is already the answer', async () => {
  const { prompts } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: cast({
      ...resumeLoad({ stop_reason: 'unreadable', plan: null, manifest: [], state: [], notes: 'x' }),
    }),
  })

  assert.ok(!prompts.some((p) => p.opts.label === 'existing-runs'))
})

test('an unobservable runs directory halts loudly instead of planning blind', async () => {
  const { result, prompts } = await run({
    'existing-runs': { stop_reason: 'unobservable', runs: [], notes: 'node not on PATH' },
  })

  assert.equal(result.checkpoint, null)
  assert.deepEqual(result.work_orders, [])
  assert.ok(result.coverage.failed_channels.includes('existing-runs'))
  assert.ok(result.coverage.unreached.some((u) => /could not observe/.test(u)))
  assert.ok(!prompts.some((p) => p.opts.label === 'plan'),
    'planning blind here is the duplicate run the guard exists to prevent')
  assert.equal(result.coverage.complete, false)
})

test('a guard agent that throws is the same loud halt', async () => {
  const { result } = await run({
    'existing-runs': () => { throw new Error('session limit') },
  })

  assert.deepEqual(result.work_orders, [])
  assert.ok(result.coverage.failed_channels.includes('existing-runs'))
})

test('unreadable rows never match and never block, but are named in the log', async () => {
  const { result, logs } = await run({
    'existing-runs': observed([runRow({ status: 'unreadable', change: '' })]),
  })

  assert.equal(result.checkpoint, null)
  assert.deepEqual(result.integration.merged, ['W1'])
  assert.ok(logs.some((l) => /unreadable/.test(l)))
})

test('the guard prompt names the CLI and forbids the agent a verdict', async () => {
  const { prompts } = await run({})
  const guard = prompts.find((p) => p.opts.label === 'existing-runs')

  assert.ok(guard, 'a fresh invocation dispatches the guard')
  assert.match(guard.prompt, /run-status\.mjs/)
  assert.match(guard.prompt, /VERBATIM/i)
  assert.match(guard.prompt, /judge nothing/)
  assert.equal(guard.opts.agentType, 'agentics:verifier')
})
