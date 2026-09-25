// test/vfa-develop-review-scope.test.mjs — which orders buy a review loop of their own.
//
// A yardstick order (a contract, or a red) is reviewed per order, because nothing downstream can
// check it and later waves build on it. Every other order is verified per order and reviewed
// once, inside the integration review, which is charged with its criteria and its coder's
// concerns. `review_every_order` buys the loop for every order.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carriedPayload, scriptedAgents, runWorkflow } from './harness/workflow-host.mjs'

const WF = fileURLToPath(new URL('../workflows/vfa-develop.workflow.js', import.meta.url))

const A40 = 'a'.repeat(40)
const B40 = 'b'.repeat(40)
const M40 = 'e'.repeat(40)
const RUN_DIR = 'C:/repo/.claude/vfa/runs/20260925-100000'

const ARGS = { change: 'add the thing', roots: '.', plugin_root: 'C:/plugin' }

const order = (id, over = {}) => ({
  id, title: 'do ' + id, role: 'none', pins: 'behaviour', weight: 'standard',
  locus: ['src/' + id + '.js'], reads: [], acceptance: [id + ' works'], context: 'ctx',
  deps: [], contract: false, ...over,
})

const planOf = (orders) => ({
  work_orders: orders,
  shared_files: [],
  partition_raw: JSON.stringify({ waves: [orders.map((o) => o.id)], coupled: [] }),
  blocking_gaps: [],
  plan_path: RUN_DIR,
  notes: '',
})

const coded = (over = {}) => ({
  status: 'done', worktree: 'C:/wt/x', branch: 'vfa/x', base_sha: A40, head_sha: B40,
  commits: [{ sha: B40, subject: 'feat: the thing' }],
  concerns: ['unsure whether empty input should throw'], discovered: [], summary: 's', ...over,
})

const verified = (over = {}) => carriedPayload({
  stop_reason: 'completed', build: 'passed', typecheck: 'absent', suite: 'passed',
  suite_output_tail: 'ok',
  discriminator: [{ test_id: 'test/x.test.js', failed_on_base: true, passes_now: true }],
  failing_tests: [], series_findings: [], notes: 'ran', ...over,
})

const cast = (orders, over = {}) => scriptedAgents({
  'existing-runs': { stop_reason: 'observed', runs: [], notes: 'no runs directory' },
  plan: planOf(orders),
  drift: { stop_reason: 'completed', user_head: A40, moved_files: [], notes: 'unchanged' },
  'integration-setup': { stop_reason: 'completed', worktree: 'C:/repo/.claude/worktrees/x',
    branch: 'vfa/20260925-100000-integration', head_sha: A40, notes: 'created' },
  'merge:': { stop_reason: 'completed', merged_sha: M40, conflicts: [], notes: 'merged' },
  'wave-verify:': verified({ discriminator: [] }),
  'record:': { stop_reason: 'recorded', path: RUN_DIR, notes: 'appended' },
  'kb-write': { stop_reason: 'recorded', path: '.claude/vfa/kb', notes: 'appended' },
  ...over,
  'code:': coded(),
  'verify:': verified(),
  'fix:': coded(),
  'review:': over['review:'] || { findings: [], fix_verdicts: [] },
})

const run = (orders, args = {}) => runWorkflow(WF, {
  args: { ...ARGS, ...args },
  workflow: () => ({ coverage: { complete: true, dropped: [], incomplete: [], failed_channels: [],
    unreached: [], resumable: { runId: 'r', remaining: [] } } }),
  agent: cast(orders),
})

const labels = (prompts) => prompts.map((p) => p.opts.label)
const integrationPrompt = (prompts) =>
  prompts.find((p) => p.opts.label === 'review:integration').prompt

test('an ordinary order buys no loop of its own; the integration review carries it', async () => {
  const { result, prompts } = await run([order('W1')])

  assert.ok(!labels(prompts).some((l) => l.startsWith('review:W1')))
  const review = integrationPrompt(prompts)
  assert.match(review, /ORDERS WHOSE ONLY ADVERSARIAL REVIEW IS THIS ONE/)
  assert.match(review, /— W1: do W1/)
  assert.match(review, /unsure whether empty input should throw/,
    'the coder\'s doubts reach the one reviewer who will read this order')
  assert.deepEqual(result.implemented.map((e) => e.id), ['W1'])
  assert.equal(result.implemented[0].review.at_integration, true)
})

test('a contract order keeps its own loop, and is not charged to integration', async () => {
  const { result, prompts } = await run([order('W1'), order('W2', { contract: true })])

  assert.ok(labels(prompts).includes('review:W2#1'))
  assert.ok(!labels(prompts).some((l) => l.startsWith('review:W1')))
  assert.doesNotMatch(integrationPrompt(prompts), /— W2: /)
  assert.equal(result.implemented.find((e) => e.id === 'W2').review.at_integration, false)
})

test('with every order reviewed per order, the integration review is told so', async () => {
  const { prompts } = await run([order('W1')], { review_every_order: true })

  assert.ok(labels(prompts).includes('review:W1#1'))
  const review = integrationPrompt(prompts)
  assert.doesNotMatch(review, /ORDERS WHOSE ONLY ADVERSARIAL REVIEW IS THIS ONE/)
  assert.match(review, /every order below passed its own review/)
})
