// test/agentics-develop-review-tuning.test.mjs — the retuned review loop (the 2026-08-19 field
// data).
//
// Sixty agents into a Stage 2 run, the pattern was implement -> verify -> review ->
// (fix -> verify -> review) x5 — and the findings data showed why: only ONE critical across
// two runs, fixes ruled `fixed` round after round, and every marathon happening on a
// contract order where a fresh reviewer minted new majors each round — contract prose,
// test-strength taste, and one commit-subject nit that recurred four rounds as a minor and
// then returned as a major. Three mechanical answers, each tested here: majors block only
// with a named failure scenario, follow-up rounds review the fix span rather than
// re-adjudicating the series, and clean-fix churn escalates instead of buying round N+1.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carriedChain, carriedPayload, runWorkflow, scriptedAgents } from './harness/workflow-host.mjs'

const WF = fileURLToPath(new URL('../workflows/agentics-develop.workflow.js', import.meta.url))

const A40 = 'a'.repeat(40)
const B40 = 'b'.repeat(40)
const C40 = 'c'.repeat(40)
const M40 = 'e'.repeat(40)

const RUN_DIR = 'C:/repo/.claude/agentics/runs/20260816-143005'
const ARGS = { change: 'add the thing', roots: '.', plugin_root: 'C:/plugin' }

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

const plan = (orders) => ({
  work_orders: orders,
  shared_files: [],
  partition_raw: JSON.stringify({ waves: [orders.map((o) => o.id)], coupled: [] }),
  blocking_gaps: [],
  plan_path: RUN_DIR,
  notes: '',
})

const coded = (over = {}) => ({
  status: 'done', worktree: 'C:/wt/w1', branch: 'wo-w1', base_sha: A40, head_sha: B40,
  commits: [{ sha: B40, subject: 'feat: w1' }], concerns: [], discovered: [], summary: 's',
  ...over,
})

// One digest-covered line of lib/verify.mjs stdout, the way a verify courier delivers it.
const verified = () => carriedPayload({
  stop_reason: 'completed', build: 'passed', suite: 'passed', suite_output_tail: 'ok',
  failing_tests: [],
  discriminator: [{ test_id: 'test/w1.test.js', failed_on_base: true, passes_now: true }],
  series_findings: [], notes: 'ran node --test',
})

const major = (id, over = {}) => ({
  id, severity: 'major', file: 'src/W1.js', line: 1, claim: id + ' claim',
  evidence: 'cited code', failure_scenario: 'a consumer of the contract misreads ' + id,
  ...over,
})

const fixed = (id) => ({ id, status: 'fixed' })

const cast = (over = {}) => scriptedAgents({
  'existing-runs': { stop_reason: 'observed', runs: [], notes: 'no runs directory' },
  plan: plan([order('W1', { contract: true })]),
  'integration-setup': {
    stop_reason: 'completed', worktree: 'C:/repo/.claude/worktrees/int',
    branch: 'agentics/20260816-143005-integration', head_sha: A40, notes: 'created',
  },
  'merge:': { stop_reason: 'completed', merged_sha: M40, conflicts: [], notes: 'merged' },
  'wave-verify:': verified(),
  'record:': { stop_reason: 'recorded', path: RUN_DIR + '/state.jsonl', notes: 'appended' },
  'kb-chain': carriedChain(),
  'kb-write': { stop_reason: 'recorded', path: '.claude/agentics/kb', notes: 'appended' },
  'review:integration': { findings: [], fix_verdicts: [] },
  'code:': coded(),
  'verify:': verified(),
  'fix:': (prompt, opts) => {
    // Each round's fix lands a distinct head, or the loop reads it as no_fix_progress.
    const r = parseInt((opts.label || '').split('#')[1] || '1', 10)
    const sha = String(r % 10).repeat(40)
    return coded({ head_sha: sha, commits: [{ sha, subject: 'fix: round ' + r }] })
  },
  'review:': { findings: [], fix_verdicts: [] },
  ...over,
})

const run = (over) => runWorkflow(WF, {
  args: ARGS, workflow: () => surveyResult(), agent: cast(over),
})

/** Reviewer scripted per round via the callIndex the harness counts per label prefix. */
const reviewerRounds = (rounds) => (prompt, opts) => {
  const n = parseInt((opts.label || '').split('#')[1] || '1', 10)
  return rounds[Math.min(n, rounds.length) - 1]
}

test('clean-fix churn escalates as review_churn instead of buying round four', async () => {
  const { result, prompts } = await run({
    'review:': reviewerRounds([
      { findings: [major('M1')], fix_verdicts: [] },
      { findings: [major('M2')], fix_verdicts: [fixed('M1')] },
      { findings: [major('M3')], fix_verdicts: [fixed('M2')] },
    ]),
  })

  assert.equal(result.escalations.length, 1)
  assert.equal(result.escalations[0].reason, 'review_churn')
  assert.ok(!prompts.some((p) => p.opts.label === 'fix:W1#3'),
    'the escalation fires INSTEAD of paying the third fix round')
  assert.ok(prompts.some((p) => p.opts.label === 'review:W1#3'))
})

test('a loop that churns, carries, then converges is not escalated', async () => {
  // One churn-shaped round does not close the gate. This sequence ends with nothing open,
  // which is the only exit that says the work is done, and it reaches it — a single bout of
  // reviewer disagreement followed by convergence is exactly the loop working.
  const { result } = await run({
    'review:': reviewerRounds([
      { findings: [major('M1')], fix_verdicts: [] },
      { findings: [major('M2')], fix_verdicts: [fixed('M1')] },
      { findings: [major('M2', { claim: 'M2 restated' })], fix_verdicts: [{ id: 'M2', status: 'not_fixed' }] },
      { findings: [], fix_verdicts: [{ id: 'M2', status: 'fixed' }] },
    ]),
  })

  assert.deepEqual(result.escalations, [])
  assert.deepEqual(result.integration.merged, ['W1'])
})

test('churn alternating with a carry round still escalates — adjacency was defeatable', async () => {
  // The period-2 cycle that defeated all three exits. Round 2 is churn-shaped. Round 3 rules
  // that finding not_fixed exactly once, which cannot trip `review_not_converging` (nothing
  // was unfixed the round before) and which used to CLEAR the churn marker. Round 4 is
  // churn-shaped again against a freshly cleared marker, and round 5 repeats round 3 — fixes
  // always land, no id is ever unfixed twice running, no two churn rounds are adjacent.
  //
  // Left alone this ran until something outside the workflow killed it. Two churn rounds
  // anywhere in the loop is a fact about the trail, not a cap on effort.
  const { result, prompts } = await run({
    'review:': reviewerRounds([
      { findings: [major('M1')], fix_verdicts: [] },
      { findings: [major('M2')], fix_verdicts: [fixed('M1')] },
      { findings: [major('M2', { claim: 'M2 restated' })], fix_verdicts: [{ id: 'M2', status: 'not_fixed' }] },
      { findings: [major('M3')], fix_verdicts: [fixed('M2')] },
      { findings: [major('M3', { claim: 'M3 restated' })], fix_verdicts: [{ id: 'M3', status: 'not_fixed' }] },
      { findings: [major('M4')], fix_verdicts: [fixed('M3')] },
    ]),
  })

  assert.equal(result.escalations.length, 1)
  assert.equal(result.escalations[0].reason, 'review_churn')
  assert.ok(!prompts.some((p) => p.opts.label === 'review:W1#5'),
    'the second churn round ends it, rather than the cycle running on')
})

test('a major with no failure scenario cannot block, even on a contract order', async () => {
  const { result, prompts, logs } = await run({
    'review:': { findings: [major('M1', { failure_scenario: '' })], fix_verdicts: [] },
  })

  assert.deepEqual(result.escalations, [])
  assert.deepEqual(result.integration.merged, ['W1'],
    'the order is approved: a major that names no harm is advisory')
  assert.ok(!prompts.some((p) => p.opts.label === 'fix:W1#1'), 'no fix round is paid for it')
  assert.ok(logs.some((l) => /carried no failure scenario and cannot block/.test(l)))
})

test('a critical blocks with or without a scenario — the gate is deliberately asymmetric', async () => {
  const { prompts } = await run({
    'review:': reviewerRounds([
      { findings: [{ id: 'C1', severity: 'critical', file: 'src/W1.js', line: 2,
                     claim: 'wrong output', evidence: 'code', failure_scenario: '' }],
        fix_verdicts: [] },
      { findings: [], fix_verdicts: [fixed('C1')] },
    ]),
  })

  assert.ok(prompts.some((p) => p.opts.label === 'fix:W1#1'),
    'a lazily-stated critical still costs a round; a missed critical would cost the change')
})

test('round 1 reviews the whole series; follow-up rounds review the fix span', async () => {
  const { prompts } = await run({
    'review:': reviewerRounds([
      { findings: [major('M1')], fix_verdicts: [] },
      { findings: [], fix_verdicts: [fixed('M1')] },
    ]),
  })

  const r1 = prompts.find((p) => p.opts.label === 'review:W1#1').prompt
  const r2 = prompts.find((p) => p.opts.label === 'review:W1#2').prompt

  assert.match(r1, /SERIES UNDER REVIEW/)
  assert.ok(!/FIX SPAN/.test(r1))
  assert.match(r2, /FIX SPAN UNDER REVIEW/)
  assert.match(r2, new RegExp(B40 + '\\.\\.'), 'the span starts at the head round 1 reviewed')
  assert.match(r2, /still a critical/, 'criticals are never silenced by scope')
})
