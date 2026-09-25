// test/agentics-develop-typecheck.test.mjs — the third mechanical answer, and the note that reached
// nobody.
//
// A passing suite is not evidence that the tree compiles. Vitest and Jest transform TypeScript
// with esbuild, which strips types without checking them, so a missing key in a typed record is
// invisible to the suite and fatal to the build. In the field an order's branch tip carried 826
// passing tests over a tree `tsc --noEmit` rejected, and the suite result was the only thing
// anybody had to go on — the branch was left at a literal `Revert` commit with a broken build.
//
// `typecheck` is therefore its own field beside `build` and `suite`, never derived from either.
// Two properties are what make it safe to add rather than merely strict:
//
//   `absent` is the ordinary answer. Most repositories define no separate typecheck, and one
//   whose test command runs the compiler first is covered by `suite`. Nothing here manufactures
//   a gate out of that — an absent typecheck is a fact about the repository, exactly as an
//   absent build is, and it keeps `measured` honest rather than padding it.
//
//   A line written before the field existed reads back as `absent`, so a run planned under the
//   old verdict resumes under the old verdict. That half is pinned in test/run-verdict.test.mjs.
//
// The second subject here is F40's: a coder wrote a stage-blocking defect into `discovered`,
// which had one consumer — the knowledge-base deposit — and no reader before review. The defect
// cleared three green gates and surfaced at integration. Both of the coder's prose channels now
// reach the reviewer, so a misfiling costs a paragraph rather than a run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carriedChain, carriedPayload, scriptedAgents, runWorkflow } from './harness/workflow-host.mjs'

const WF = fileURLToPath(new URL('../workflows/agentics-develop.workflow.js', import.meta.url))

const A40 = 'a'.repeat(40)
const B40 = 'b'.repeat(40)
const M40 = 'e'.repeat(40)

const RUN_DIR = 'C:/repo/.claude/agentics/runs/20260904-113000'
// These scenarios pin the per-order review loop, so they ask for it on every order; the default,
// which reviews only yardstick orders per order, is pinned in agentics-develop-review-scope.
const ARGS = { change: 'add a member to the closed union', roots: '.', plugin_root: 'C:/plugin', review_every_order: true }

const W1 = {
  id: 'W1', title: 'tuck the new row in', role: 'none', pins: 'behaviour', weight: 'standard',
  locus: ['src/rows.ts'], reads: [], acceptance: ['the row renders'], context: 'ctx',
  deps: [], contract: false,
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
  status: 'done', worktree: 'C:/wt/W1', branch: 'agentics/20260904-113000-W1',
  base_sha: A40, head_sha: B40,
  commits: [{ sha: B40, subject: 'feat: tuck the row in' }],
  concerns: [], discovered: [], summary: 's', ...over,
})

/** A green measurement in a repository that defines no separate typecheck — the common case. */
const verified = (over = {}) => carriedPayload({
  stop_reason: 'completed', build: 'passed', typecheck: 'absent', suite: 'passed',
  suite_output_tail: 'ok',
  discriminator: [{ test_id: 'test/rows.test.ts', failed_on_base: true, passes_now: true }],
  failing_tests: [], series_findings: [], notes: 'ran the suite', ...over,
})

const cast = (over = {}) => scriptedAgents({
  'existing-runs': { stop_reason: 'observed', runs: [], notes: 'no runs directory' },
  plan,
  drift: { stop_reason: 'completed', user_head: A40, moved_files: [], notes: 'unchanged' },
  'integration-setup': { stop_reason: 'completed', worktree: 'C:/repo/.claude/worktrees/x',
    branch: 'agentics/20260904-113000-integration', head_sha: A40, notes: 'created' },
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

// ── the field it was added for ───────────────────────────────────────────────────────────────

test('a failing typecheck stops an order whose suite is entirely green', async () => {
  // The exact field shape: every test passes and the tree does not compile. Before this field
  // existed the run had one answer for two questions and took the reassuring one.
  const { prompts } = await run({
    'verify:': verified({ typecheck: 'failed', notes: 'typecheck output tail:\nTS2741 missing key' }),
  })

  const fix = promptFor(prompts, 'fix:W1')
  assert.ok(fix, 'the order does not pass its gate on a green suite alone')
  assert.match(fix, /typecheck/,
    'and the fix round is told which of the three questions failed')
})

test('the typecheck failure is its own finding, not folded into the build', async () => {
  const { prompts } = await run({
    'verify:': verified({ typecheck: 'failed', notes: 'TS2741 missing key' }),
  })

  const fix = promptFor(prompts, 'fix:W1')
  assert.match(fix, /W1-typecheck/,
    'a coder sent after a broken build would find one that works')
  assert.ok(!/W1-build/.test(fix), 'the build passed and nothing should say otherwise')
})

test('an absent typecheck is a repository fact and passes the gate untouched', async () => {
  const { result } = await run()

  assert.deepEqual(result.implemented.map((e) => e.id), ['W1'])
  assert.equal(result.coverage.complete, true,
    'no separate typecheck is the ordinary state of most repositories, not a gap')
})

test('an absent typecheck is not counted as a check that ran', async () => {
  const { result } = await run()

  assert.deepEqual(result.implemented[0].review.measured, ['build', 'suite', 'discriminator:1'],
    'counting it would let an unverified order clear the vacuity check — IRON LAW §4')
})

test('a typecheck that ran and passed is counted, and says so', async () => {
  const { result } = await run({ 'verify:': verified({ typecheck: 'passed' }) })

  assert.deepEqual(result.implemented[0].review.measured,
    ['build', 'typecheck', 'suite', 'discriminator:1'])
})

test('the investigator is asked to establish the typecheck, and told absent is the usual answer',
  async () => {
    // Without this the schema would require a field nobody was asked to look for, which is how a
    // model invents one. The charge has to name both halves: go and look, and do not invent.
    const { prompts } = await run({
      'verify:': carriedPayload({
        stop_reason: 'environment_broken', build: 'absent', typecheck: 'absent', suite: 'absent',
        error: { kind: 'command_unknown', message: 'no build command was named' },
        notes: 'nothing established',
      }),
      'verify-investigate:W1': {
        stop_reason: 'completed', build: 'passed', typecheck: 'absent', suite: 'passed',
        suite_output_tail: 'ok', failing_tests: [],
        discriminator: [{ test_id: 'test/rows.test.ts', failed_on_base: true, passes_now: true }],
        series_findings: [],
        commands: { build: 'npm run build', typecheck: '', suite: 'npm test',
                    test_one: 'npm test -- {file}' },
        notes: 'read package.json; there is no separate typecheck script',
      },
    })

    const investigate = promptFor(prompts, 'verify-investigate:W1')
    assert.match(investigate, /TYPECHECK/, 'the command is asked for by name')
    assert.match(investigate, /most repositories do not have/i,
      'and absent is named as the ordinary right answer, so nothing is invented')
    assert.match(investigate, /strips types without checking them/,
      'with the reason it cannot be read off the suite')
  })

// ── F40: the note that reached nobody ────────────────────────────────────────────────────────

test('the reviewer is handed what the coder discovered, not only what it doubted', async () => {
  const { prompts } = await run({
    'code:': coded({
      concerns: ['the row order may matter'],
      discovered: ['the shared reducer has to pick one of two remedies and I picked neither'],
    }),
  })

  const review = promptFor(prompts, 'review:W1#1')

  assert.match(review, /the row order may matter/, 'concerns reached it before and still do')
  assert.match(review, /picked neither/,
    'and the channel a stage-blocking defect actually travelled in now reaches it too')
  assert.match(review, /WHAT THE CODER DISCOVERED/)
  assert.match(review, /rule on it/,
    'handed without a charge, a reviewer reads it as trivia — which is what happened')
})

test('an empty discovered channel is still shown, so its emptiness is legible', async () => {
  const { prompts } = await run({ 'code:': coded({ concerns: [], discovered: [] }) })

  const review = promptFor(prompts, 'review:W1#1')
  assert.match(review, /WHAT THE CODER DISCOVERED/,
    'a section that vanishes when empty teaches a reader nothing about the case where it is not')
})
