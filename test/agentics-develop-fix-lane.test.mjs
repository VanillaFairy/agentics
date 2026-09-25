// test/agentics-develop-fix-lane.test.mjs — the cheap lane, and what it refuses to make cheap.
//
// The triage section has been honest about its own numbers for a while: a ten-session field
// audit found SEVEN of ten better served by a direct session, and identified what the pipeline
// was actually buying in the other three — the adversarial review and the discriminator, not the
// survey and the decomposition. But triage ended by handing the work back to a plain session, so
// the two-thirds that pays got rebuilt by hand or skipped.
//
// This lane is that two-thirds, bought as a run. It is a lane INSIDE the develop workflow rather
// than a workflow of its own, which is the whole design: worktrees, the check runner, the review
// loop, the ledger, the resume verdict and the collector are inherited entire and unchanged, so
// the lane is resumable on the day it lands rather than after somebody remembers to make it so.
//
// What is pinned here is mostly what the lane does NOT skip. A cheap lane that quietly dropped
// the discriminator or the review would be cheap the way not doing the work is cheap.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carriedPayload, scriptedAgents, runWorkflow } from './harness/workflow-host.mjs'

const WF = fileURLToPath(new URL('../workflows/agentics-develop.workflow.js', import.meta.url))

const A40 = 'a'.repeat(40)
const B40 = 'b'.repeat(40)
const M40 = 'e'.repeat(40)

const RUN_DIR = 'C:/repo/.claude/agentics/runs/20260904-150000'
const LOCUS = ['src/camera.ts']

const ARGS = {
  change: 'the camera rounds the wrong way at zoom 1',
  roots: '.', plugin_root: 'C:/plugin',
  lane: 'fix', locus: LOCUS,
}

const W1 = {
  id: 'W1', title: 'round the camera the other way', role: 'none', pins: 'behaviour',
  weight: 'standard', locus: LOCUS, reads: [], acceptance: ['zoom 1 rounds down'],
  context: 'ctx', deps: [], contract: false,
}

const plan = {
  work_orders: [W1],
  shared_files: [],
  partition_raw: JSON.stringify({ waves: [['W1']], coupled: [] }),
  blocking_gaps: [],
  plan_path: RUN_DIR,
  notes: '',
}

const coded = (over = {}) => ({
  status: 'done', worktree: 'C:/wt/W1', branch: 'agentics/20260904-150000-W1',
  base_sha: A40, head_sha: B40,
  commits: [{ sha: B40, subject: 'fix: round the other way' }],
  concerns: [], discovered: [], summary: 's', ...over,
})

const verified = (over = {}) => carriedPayload({
  stop_reason: 'completed', build: 'passed', typecheck: 'absent', suite: 'passed',
  suite_output_tail: 'ok',
  discriminator: [{ test_id: 'test/camera.test.ts', failed_on_base: true, passes_now: true }],
  failing_tests: [], series_findings: [], notes: 'ran the suite', ...over,
})

const cast = (over = {}) => scriptedAgents({
  'existing-runs': { stop_reason: 'observed', runs: [], notes: 'no runs directory' },
  plan,
  drift: { stop_reason: 'completed', user_head: A40, moved_files: [], notes: 'unchanged' },
  'integration-setup': { stop_reason: 'completed', worktree: 'C:/repo/.claude/worktrees/x',
    branch: 'agentics/20260904-150000-integration', head_sha: A40, notes: 'created' },
  'merge:': { stop_reason: 'completed', merged_sha: M40, conflicts: [], notes: 'merged' },
  'wave-verify:': verified({ discriminator: [] }),
  'record:': { stop_reason: 'recorded', path: RUN_DIR, notes: 'appended' },
  'kb-write': { stop_reason: 'recorded', path: '.claude/agentics/kb', notes: 'appended' },
  history: { stop_reason: 'exhausted',
    findings: 'c0ffee1 2026-08-14 "perf: cache the zoom factor" changed src/camera.ts:88',
    searched: 'main, src/camera.ts, last 90 days' },
  ...over,
  'code:': over['code:'] || coded(),
  'verify:': over['verify:'] || verified(),
  'fix:': over['fix:'] || coded(),
  'review:': over['review:'] || { findings: [], fix_verdicts: [] },
})

let surveyCalls = 0

const run = (args = {}, over = {}) => {
  surveyCalls = 0
  return runWorkflow(WF, {
    args: { ...ARGS, ...args },
    workflow: () => {
      surveyCalls++
      return { coverage: { complete: true, dropped: [], incomplete: [],
        failed_channels: [], unreached: [], resumable: { runId: 'r', remaining: [] } } }
    },
    agent: cast(over),
  })
}

const labels = (prompts) => prompts.map((p) => p.opts.label)
const promptFor = (prompts, label) =>
  (prompts.find((p) => p.opts.label === label) || { prompt: '' }).prompt

// ── what it skips ────────────────────────────────────────────────────────────────────────────

test('the fix lane buys no survey at all', async () => {
  const { result } = await run()

  assert.equal(surveyCalls, 0, 'the survey is the 400-500k-token phase this lane exists to skip')
  assert.deepEqual(result.implemented.map((e) => e.id), ['W1'])
})

test('the full lane still buys its survey, so the skip is the LANE and not a regression',
  async () => {
    await run({ lane: 'full', locus: undefined })
    assert.equal(surveyCalls, 1)
  })

test('an unknown lane falls back to the full pipeline rather than to the cheap one', async () => {
  // Failing open to `fix` would silently strip the survey off a run that asked for neither.
  await run({ lane: 'turbo' })
  assert.equal(surveyCalls, 1)
})

test('the planner is charged as a scribe, not a decomposer', async () => {
  const { prompts } = await run()

  const planPrompt = promptFor(prompts, 'plan')
  assert.match(planPrompt, /ONE-ORDER plan/)
  assert.match(planPrompt, /finding a second order here is a defect/,
    'the failure mode of this lane is a planner rebuilding the ladder the caller left')
  assert.match(planPrompt, /Do not run the partition CLI/)
  assert.ok(!/Decompose this change into work orders/.test(planPrompt))

  const dispatch = prompts.find((p) => p.opts.label === 'plan')
  assert.equal(dispatch.opts.effort, 'low', 'there is nothing here to weigh')
})

test('the caller\'s locus reaches the planner as the fence it is', async () => {
  const { prompts } = await run()

  const planPrompt = promptFor(prompts, 'plan')
  assert.match(planPrompt, /src\/camera\.ts/)
  assert.match(planPrompt, /theirs rather than yours\s+to derive/)
  assert.match(planPrompt, /widen the locus and SAY SO/,
    'a caller naming one file where the fix needs three is the ordinary way this goes wrong')
})

// ── what it refuses to make cheap ────────────────────────────────────────────────────────────

test('the discriminator still gates the order', async () => {
  // The audit named this and the adversarial review as the two things that were paying. A lane
  // that dropped either would be cheap the way not doing the work is cheap.
  const { result, prompts } = await run({}, {
    'verify:': verified({
      discriminator: [{ test_id: 'test/camera.test.ts', failed_on_base: false, passes_now: true }],
    }),
    'fix:': coded({ commits: [], head_sha: A40 }),
  })

  // It routes through `discriminator_undecidable` rather than a fix round — a
  // discriminator standing alone as the only failing fact is not something a further round can
  // move, so a person rules on it. What matters here is that the gate holds at all: this lane
  // inherits the verdict machinery whole, including the parts that decide how to fail.
  assert.ok(!prompts.some((p) => p.opts.label === 'fix:W1'),
    'buying a round to learn the answer again is what this escalation exists to prevent')
  assert.equal(result.escalations[0].reason, 'discriminator_undecidable')
  assert.ok(!result.implemented.some((e) => e.id === 'W1'),
    'a test that passes without the fix pins nothing, on this lane as on any other')
  assert.deepEqual(result.integration.merged, [])
})

test('the adversarial review still runs, as the integration review, and its criticals lead', async () => {
  // A fix-lane order is not one other work is measured against, so it buys no review loop of its
  // own: the integration review over the merged head is its adversarial review, charged with its
  // criteria. Its criticals go to the human gate and keep the run incomplete.
  const { result, prompts } = await run({}, {
    'review:integration': { findings: [{ id: 'R1', severity: 'critical', file: 'src/camera.ts',
      line: 9, claim: 'the rounding is now wrong in the other direction',
      evidence: 'src/camera.ts:9' }], fix_verdicts: [] },
  })

  assert.ok(!labels(prompts).some((l) => l.startsWith('review:W1')), 'no per-order loop is bought')
  const review = prompts.find((p) => p.opts.label === 'review:integration').prompt
  assert.match(review, /ORDERS WHOSE ONLY ADVERSARIAL REVIEW IS THIS ONE/)
  assert.match(review, /— W1: /)
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.unreached.some((u) => /rounding is now wrong/.test(u)),
    'the critical leads the result rather than sitting in a log')
})

test('the integration review still reads the merged head', async () => {
  const { prompts } = await run()
  assert.ok(labels(prompts).includes('review:integration'))
})

// ── the precondition ─────────────────────────────────────────────────────────────────────────

test('the lane refuses without a locus, before anything is dispatched', async () => {
  // What licenses skipping the survey IS the locus. Without one there is nothing standing in for
  // the judgment the survey would have bought, and a planner asked to invent a fence from a
  // change string produces one the coder may not widen and cannot work inside.
  const { result, prompts } = await run({ locus: [] })

  assert.deepEqual(prompts, [], 'nothing is dispatched, not even the existing-run check')
  assert.equal(surveyCalls, 0)
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.unreached.some((u) => /fix lane was asked for with no locus/.test(u)))
  assert.ok(result.coverage.unreached.some((u) => /use\s+the full lane/.test(u)),
    'the refusal names the way forward, rather than only the problem')
})

// ── the history side channel ─────────────────────────────────────────────────────────────────

test('a regression buys one history search, and an ordinary fix buys none', async () => {
  const { prompts: withHistory } = await run({ regression: true })
  assert.ok(labels(withHistory).includes('history'))

  const { prompts: without } = await run()
  assert.ok(!labels(without).includes('history'),
    'an ordinary fix has no commit where the behaviour changed, so there is nothing to buy')
})

test('what the historian found reaches the planner', async () => {
  const { prompts } = await run({ regression: true })

  const planPrompt = promptFor(prompts, 'plan')
  assert.match(planPrompt, /GIT HISTORY/)
  assert.match(planPrompt, /perf: cache the zoom factor/,
    'the commit is the answer; carrying it is the whole reason the search was bought')
})

test('a history search that fails costs the run nothing it had already paid for', async () => {
  // IRON LAW §5: a failing side channel must not discard work. The lane proceeds, the coder
  // searches for itself as it always did, and the loss is named rather than swallowed.
  const { result } = await run({ regression: true }, {
    history: () => { throw new Error('the historian could not start') },
  })

  assert.deepEqual(result.implemented.map((e) => e.id), ['W1'], 'the run still does the work')
  assert.ok(result.coverage.failed_channels.includes('history'))
  assert.ok(result.coverage.unreached.some((u) => /never identified/.test(u)),
    'a claim resting on a channel that failed is unsupported, and says so')
})

// ── the account it gives of itself ───────────────────────────────────────────────────────────

test('the coverage block says a lane ran, not that a knowledge base covered the ground',
  async () => {
    // These must never read alike. A fresh chain is a program's finding that the ground is
    // recorded; a lane is a caller's judgment that it is known. Presenting the second as the
    // first is exactly the laundering the coverage block exists to prevent.
    const { result } = await run()

    const said = result.coverage.from_kb.join(' ')
    assert.match(said, /took the FIX LANE/)
    assert.match(said, /NOTHING WAS SEARCHED BY THIS RUN/)
    assert.match(said, /nothing was recalled from the knowledge base either/,
      'a reader must not take this for a null survey')
    assert.match(said, /declared locus: src\/camera\.ts/)
  })

test('a fix-lane run still records a plan path, which is its whole resume point', async () => {
  const { result } = await run()

  assert.equal(result.plan_path, RUN_DIR,
    'the one dispatch this lane keeps that it could have dropped is kept for exactly this')
  assert.ok(!result.coverage.failed_channels.includes('run-state'))
})
