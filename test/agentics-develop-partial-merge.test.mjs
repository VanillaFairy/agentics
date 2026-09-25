// test/agentics-develop-partial-merge.test.mjs — an integration review over a tree that is not the
// whole change.
//
// The integration review exists to see what per-order review structurally cannot: two orders
// that each honoured their own contract and disagreed with each other. It reads the integration
// head, and when some orders escalated or were blocked, that head is only part of the change.
//
// A review of a partial merge can be entirely accurate about the state it saw and still point
// the wrong way. Run 20260902-124933 produced exactly that: an integration finding whose
// correct fix ran OPPOSITE to the one proposed, because two coupled orders were still missing.
// Nothing in the finding said the tree was incomplete, so nothing warned the person acting on
// it. That is the gap pinned here — in the reviewer's dispatch, and in every finding reported
// out of it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carriedChain, carriedPayload, scriptedAgents, runWorkflow } from './harness/workflow-host.mjs'

const WF = fileURLToPath(new URL('../workflows/agentics-develop.workflow.js', import.meta.url))

const A40 = 'a'.repeat(40)
const B40 = 'b'.repeat(40)
const M40 = 'e'.repeat(40)

const RUN_DIR = 'C:/repo/.claude/agentics/runs/20260903-120000'
const ARGS = { change: 'wire the manifest through', roots: '.', plugin_root: 'C:/plugin' }

const order = (id, over = {}) => ({
  id, title: 'do ' + id, role: 'none', pins: 'behaviour', weight: 'standard',
  locus: ['src/' + id + '.js'], reads: [], acceptance: ['builds'], context: 'ctx',
  deps: [], contract: false, ...over,
})

const W1 = order('W1', { title: 'read the manifest' })
const W2 = order('W2', { title: 'write the manifest' })

const plan = {
  work_orders: [W1, W2],
  shared_files: [],
  partition_raw: JSON.stringify({ waves: [['W1', 'W2']], coupled: [] }),
  blocking_gaps: [],
  plan_path: RUN_DIR,
  notes: '',
}

const coded = (over = {}) => ({
  status: 'done', worktree: 'C:/wt/x', branch: 'wo-x', base_sha: A40, head_sha: B40,
  commits: [{ sha: B40, subject: 'feat: manifest' }], concerns: [], discovered: [],
  summary: 's', ...over,
})

const verified = (over = {}) => carriedPayload({
  stop_reason: 'completed', build: 'passed', suite: 'passed', suite_output_tail: 'ok',
  discriminator: [{ test_id: 'test/x.test.js', failed_on_base: true, passes_now: true }],
  failing_tests: [], series_findings: [], notes: 'ran node --test', ...over,
})

const critical = (id) => ({
  findings: [{
    id, severity: 'critical', file: 'src/manifest.js', line: 12,
    claim: 'the reader and the writer disagree about the manifest shape',
    evidence: 'src/manifest.js:12',
  }],
  fix_verdicts: [],
})

const cast = (over = {}) => scriptedAgents({
  'existing-runs': { stop_reason: 'observed', runs: [], notes: 'no runs directory' },
  plan,
  drift: { stop_reason: 'completed', user_head: A40, moved_files: [], notes: 'unchanged' },
  'integration-setup': { stop_reason: 'completed', worktree: 'C:/repo/.claude/worktrees/x',
    branch: 'agentics/20260903-120000-integration', head_sha: A40, notes: 'created' },
  'merge:': { stop_reason: 'completed', merged_sha: M40, conflicts: [], notes: 'merged' },
  'wave-verify:': verified({ discriminator: [] }),
  'record:': { stop_reason: 'recorded', path: RUN_DIR, notes: 'appended' },
  'kb-chain': carriedChain(),
  'kb-write': { stop_reason: 'recorded', path: '.claude/agentics/kb', notes: 'appended' },
  ...over,
  'code:': over['code:'] || coded(),
  'verify:': over['verify:'] || verified(),
  'fix:': over['fix:'] || coded(),
  'review:': over['review:'] || { findings: [], fix_verdicts: [] },
})

const run = (over = {}) =>
  runWorkflow(WF, {
    args: ARGS,
    workflow: () => ({ coverage: { complete: true, dropped: [], incomplete: [],
      failed_channels: [], unreached: [], resumable: { runId: 'r', remaining: [] } } }),
    agent: cast(over),
  })

const promptFor = (prompts, label) =>
  (prompts.find((p) => p.opts.label === label) || { prompt: '' }).prompt

/** W2 never lands: its coder returns nothing, so W1 merges alone. */
const w2Escalates = (over = {}) => run({
  'code:': (prompt, opts) => ((opts.label || '') === 'code:W2'
    ? { status: 'blocked', worktree: '', branch: '', base_sha: '', head_sha: '',
        commits: [], concerns: ['cannot proceed'], discovered: [], summary: 'blocked' }
    : coded()),
  'review:integration': { findings: [], fix_verdicts: [] },
  ...over,
})

test('a reviewer reading a partial merge is told which orders are missing, and their titles',
  async () => {
    const { prompts } = await w2Escalates()
    const review = promptFor(prompts, 'review:integration')

    assert.match(review, /THIS IS A PARTIAL MERGE/)
    assert.match(review, /W2 {3}write the manifest/,
      'the id alone does not tell a reviewer what hole to expect')
    assert.match(review, /can be exactly wrong once they land/)
  })

test('a whole merge carries no partial-merge warning at all', async () => {
  const { prompts } = await run({ 'review:integration': { findings: [], fix_verdicts: [] } })
  const review = promptFor(prompts, 'review:integration')

  assert.ok(!/PARTIAL MERGE/.test(review),
    'a caveat that is always there is a caveat nobody reads')
})

test('every integration finding from a partial merge says so where a person will read it',
  async () => {
    const { result } = await w2Escalates({ 'review:integration': critical('I1') })

    const note = result.coverage.unreached.find((u) => /integration review \[I1\]/.test(u))
    assert.ok(note, 'the finding still surfaces')
    assert.match(note, /REVIEWED OVER A PARTIAL MERGE: W2 did not land/)
    assert.match(note, /point the other way, once they do/)
  })

test('an integration finding over a whole merge is reported without the caveat', async () => {
  const { result } = await run({ 'review:integration': critical('I1') })

  const note = result.coverage.unreached.find((u) => /integration review \[I1\]/.test(u))
  assert.ok(note)
  assert.ok(!/PARTIAL MERGE/.test(note))
})
