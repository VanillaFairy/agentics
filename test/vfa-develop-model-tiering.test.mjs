// test/vfa-develop-model-tiering.test.mjs — the coder tier rising on EVIDENCED difficulty
// (the 2026-08-30 change). `coderFor` used to floor only `red` and `contract` orders at opus,
// because their defects are the ones nothing downstream can catch. A fix round that follows a
// round which did not clear its blockers is the same kind of fact, arriving later: it is
// measured evidence the tier was too low, not a guess that it might be, so the second fix round
// onward floors at opus too — and a `light` order's discount does not survive being proven
// wrong. These tests read the tier straight off `opts.model` on the scripted dispatches, the
// way `test/vfa-develop-scenarios.test.mjs` already does for the run-level dial.
//
// The scenarios here deliberately use a NON-structural order (role 'none', contract false) —
// vfa-develop-review-tuning.test.mjs's default order is a contract order, which floors at opus
// from round 1 and would never show the escalation these tests exist to pin.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carriedChain, carriedPayload, recordedLine, runWorkflow, scriptedAgents } from './harness/workflow-host.mjs'

const WF = fileURLToPath(new URL('../workflows/vfa-develop.workflow.js', import.meta.url))

const A40 = 'a'.repeat(40)
const B40 = 'b'.repeat(40)
const M40 = 'e'.repeat(40)

const RUN_DIR = 'C:/repo/.claude/vfa/runs/20260830-091500'
// These scenarios pin the per-order review loop, so they ask for it on every order; the default,
// which reviews only yardstick orders per order, is pinned in vfa-develop-review-scope.
const ARGS = { change: 'add the thing', roots: '.', plugin_root: 'C:/plugin', review_every_order: true }

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

const verified = () => carriedPayload({
  stop_reason: 'completed', build: 'passed', suite: 'passed', suite_output_tail: 'ok',
  failing_tests: [],
  discriminator: [{ test_id: 'test/w1.test.js', failed_on_base: true, passes_now: true }],
  series_findings: [], notes: 'ran node --test',
})

// A blocking finding for a NON-contract order — only `critical` blocks one, per reviewLoop's
// `blocks` predicate, since a major blocks only a contract order and these orders are not one.
const critical = (id, over = {}) => ({
  id, severity: 'critical', file: 'src/W1.js', line: 1, claim: id + ' claim',
  evidence: 'cited code', failure_scenario: 'a caller of W1 hits the bug ' + id,
  ...over,
})

const fixed = (id) => ({ id, status: 'fixed' })
const notFixed = (id) => ({ id, status: 'not_fixed' })

const cast = (workOrder, over = {}) => scriptedAgents({
  'existing-runs': { stop_reason: 'observed', runs: [], notes: 'no runs directory' },
  plan: plan([workOrder]),
  'integration-setup': {
    stop_reason: 'completed', worktree: 'C:/repo/.claude/worktrees/int',
    branch: 'vfa/20260830-091500-integration', head_sha: A40, notes: 'created',
  },
  'merge:': { stop_reason: 'completed', merged_sha: M40, conflicts: [], notes: 'merged' },
  'wave-verify:': verified(),
  'record:': { stop_reason: 'recorded', path: RUN_DIR + '/state.jsonl', notes: 'appended' },
  'kb-chain': carriedChain(),
  'kb-write': { stop_reason: 'recorded', path: '.claude/vfa/kb', notes: 'appended' },
  'review:integration': { findings: [], fix_verdicts: [] },
  'code:': coded(),
  'verify:': verified(),
  // Each fix round lands a distinct head, exactly as vfa-develop-review-tuning.test.mjs's cast
  // does — a repeated head reads as no_fix_progress and escalates instead of looping.
  'fix:': (prompt, opts) => {
    const r = parseInt((opts.label || '').split('#')[1] || '1', 10)
    const sha = String(r % 10).repeat(40)
    return coded({ head_sha: sha, commits: [{ sha, subject: 'fix: round ' + r }] })
  },
  'review:': { findings: [], fix_verdicts: [] },
  ...over,
})

/** Reviewer scripted per round via the callIndex the harness counts per label prefix. */
const reviewerRounds = (rounds) => (prompt, opts) => {
  const n = parseInt((opts.label || '').split('#')[1] || '1', 10)
  return rounds[Math.min(n, rounds.length) - 1]
}

const run = (workOrder, over, args = ARGS) => runWorkflow(WF, {
  args, workflow: () => surveyResult(), agent: cast(workOrder, over),
})

test('the first fix round does not escalate', async () => {
  const { result, prompts } = await run(order('W1'), {
    'review:': reviewerRounds([
      { findings: [critical('C1')], fix_verdicts: [] },
      { findings: [], fix_verdicts: [fixed('C1')] },
    ]),
  })

  assert.deepEqual(result.escalations, [])
  assert.deepEqual(result.integration.merged, ['W1'])

  const fix1 = prompts.find((p) => p.opts.label === 'fix:W1#1')
  assert.ok(fix1, 'the round-1 fix round was dispatched')
  assert.equal(fix1.opts.model, undefined,
    'a standard order at the run\'s default dial implements at whatever the frontmatter says — unescalated')
})

test('the second fix round escalates to opus', async () => {
  const { result, prompts } = await run(order('W1'), {
    'review:': reviewerRounds([
      { findings: [critical('C1')], fix_verdicts: [] },
      { findings: [], fix_verdicts: [notFixed('C1')] },
      { findings: [], fix_verdicts: [fixed('C1')] },
    ]),
  })

  assert.deepEqual(result.escalations, [])
  assert.deepEqual(result.integration.merged, ['W1'])

  const fix1 = prompts.find((p) => p.opts.label === 'fix:W1#1')
  const fix2 = prompts.find((p) => p.opts.label === 'fix:W1#2')
  assert.ok(fix1 && fix2, 'both fix rounds were dispatched')
  assert.notEqual(fix1.opts.model, 'opus', 'round 1 has not yet proven the order hard')
  assert.equal(fix2.opts.model, 'opus',
    'round 2 follows a fix that did not clear — that is evidence, not a guess')
})

test('the escalation never exceeds opus, even at --intelligence=max', async () => {
  const { prompts } = await run(order('W1'), {
    'review:': reviewerRounds([
      { findings: [critical('C1')], fix_verdicts: [] },
      { findings: [], fix_verdicts: [notFixed('C1')] },
      { findings: [], fix_verdicts: [fixed('C1')] },
    ]),
  }, { ...ARGS, intelligence: 'max' })

  const fix2 = prompts.find((p) => p.opts.label === 'fix:W1#2')
  assert.ok(fix2, 'the round-2 fix round was dispatched')
  assert.equal(fix2.opts.model, 'opus', 'doubling the coder tier past opus was never the fix')
})

test('a light order starts cheap and still escalates on a second fix round', async () => {
  const { prompts } = await run(order('W1', { weight: 'light' }), {
    'review:': reviewerRounds([
      { findings: [critical('C1')], fix_verdicts: [] },
      { findings: [], fix_verdicts: [notFixed('C1')] },
      { findings: [], fix_verdicts: [fixed('C1')] },
    ]),
  })

  assert.equal(prompts.find((p) => p.opts.label === 'code:W1').opts.model, 'sonnet',
    'a light order implements at sonnet before anything has proven it otherwise')
  assert.equal(prompts.find((p) => p.opts.label === 'fix:W1#1').opts.model, 'sonnet',
    'round 1 has not yet been proven wrong about the weight')
  assert.equal(prompts.find((p) => p.opts.label === 'fix:W1#2').opts.model, 'opus',
    'the light discount does not survive being proven wrong')
})

test('the order-approved line carries the weight, the tiers, and the review-round count', async () => {
  const { prompts } = await run(order('W1', { weight: 'heavy' }), {
    'review:': reviewerRounds([
      { findings: [critical('C1')], fix_verdicts: [] },
      { findings: [], fix_verdicts: [fixed('C1')] },
    ]),
  })

  const record = prompts.find((p) => p.opts.label === 'record:W1')
  assert.ok(record, 'the approved order was recorded')
  const { entry } = recordedLine(record.prompt)

  assert.equal(entry.kind, 'order-approved')
  assert.equal(entry.weight, 'heavy')
  assert.equal(entry.coder_model, 'charter',
    'the dial spread {} and named no model, so the record says so rather than guessing')
  assert.equal(entry.judge_model, 'opus', 'the run\'s default judge tier')
  assert.equal(entry.review_rounds, 2, 'both review rounds this scenario scripted')
})
