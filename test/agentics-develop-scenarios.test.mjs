// test/agentics-develop-scenarios.test.mjs — executes agentics-develop's orchestration arithmetic
// through the harness with scripted agents. Until the self-audit, no test ever RAN a
// workflow: coverage derivation, escalation routing, the checkpoint gate and the review
// loop's exit conditions were enforced by prose and regex alone. Each scenario here pins
// one of those mechanisms by observing the returned result, never the internals.
//
// The wave loop added a second family: the integration worktree, the merge run, the
// post-merge verification, the dependency gate that produces `blocked`, and resume by
// reference with its content digest. Those are the parts a reader cannot check by reading —
// they are arithmetic over what agents returned, and only running them proves anything.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carriedChain, carriedPayload, recordedLine, runWorkflow, scriptedAgents } from './harness/workflow-host.mjs'
import { resumeVerdict, gitFacts } from './harness/resume-fixture.mjs'
import { digestOrder } from '../lib/plan-digest.mjs'

/**
 * A resume's entire dispatch surface, in one scripted answer.
 *
 * The fan is gone — there is no 'resume-index' and no 'load:<id>' slice any more. One courier
 * runs lib/run-verdict.mjs and pastes its stdout, and `resumeVerdict` builds that stdout by
 * calling the REAL derivation over the fixture, so a scenario pins what the ladder decides
 * rather than what the test author believed it decides. The optional second argument damages
 * the payload AFTER its digest is taken, which is how the transport ladder is exercised.
 */
const resumeLoad = resumeVerdict


const WF = fileURLToPath(new URL('../workflows/agentics-develop.workflow.js', import.meta.url))

const A40 = 'a'.repeat(40)
const B40 = 'b'.repeat(40)
const C40 = 'c'.repeat(40)
const D40 = 'd'.repeat(40)
const M40 = 'e'.repeat(40)   // a merge commit
const N40 = 'f'.repeat(40)   // the next merge commit

const RUN_DIR = 'C:/repo/.claude/agentics/runs/20260816-143005'

// These scenarios pin the per-order review loop, so they ask for it on every order; the default,
// which reviews only yardstick orders per order, is pinned in agentics-develop-review-scope.
const ARGS = { change: 'add the thing', roots: '.', plugin_root: 'C:/plugin', review_every_order: true }

const surveyResult = (over = {}) => ({
  question: 'q', topics: [], verdicts: [], history: null, docs: null,
  coverage: {
    complete: true, dropped: [], incomplete: [], failed_channels: [], unreached: [],
    resumable: { runId: 'r', remaining: [] },
  },
  ...over,
})

const order = (id, over = {}) => ({
  id, title: 'do ' + id, locus: ['src/' + id + '.js'], acceptance: ['builds'],
  context: 'ctx', deps: [], contract: false, ...over,
})

/** One wave holding every order, unless `waves` is overridden. */
const plan = (orders, over = {}) => ({
  work_orders: orders,
  shared_files: [],
  partition_raw: JSON.stringify({ waves: [orders.map((o) => o.id)], coupled: [] }),
  blocking_gaps: [],
  plan_path: RUN_DIR,
  notes: '',
  ...over,
})

/** A plan whose partition lays the orders out one per wave, in the order given. */
const wavedPlan = (orders, waves, over = {}) =>
  plan(orders, { partition_raw: JSON.stringify({ waves, coupled: [] }), ...over })

const coded = (over = {}) => ({
  status: 'done', worktree: 'C:/wt/w1', branch: 'wo-w1', base_sha: A40, head_sha: B40,
  commits: [{ sha: B40, subject: 'feat: w1' }], concerns: [], discovered: [], summary: 's',
  ...over,
})

// A verify dispatch answers with lib/verify.mjs's stdout now, carried by a courier under a
// digest the workflow recomputes. Scenarios still write the MEASUREMENT — the wrapping is the
// trip, and `carriedPayload` performs it exactly as the real one does.
const verified = (over = {}, damage) => carriedPayload({
  stop_reason: 'completed', build: 'passed', suite: 'passed', suite_output_tail: 'ok',
  discriminator: [{ test_id: 'test/w1.test.js', failed_on_base: true, passes_now: true }],
  series_findings: [], notes: 'ran node --test', ...over,
}, damage)

const reviewed = (over = {}) => ({ findings: [], fix_verdicts: [], ...over })

const setUp = (over = {}) => ({
  stop_reason: 'completed', worktree: 'C:/repo/.claude/worktrees/agentics-20260816-143005-integration',
  branch: 'agentics/20260816-143005-integration', head_sha: A40, notes: 'created', ...over,
})

const merged = (sha = M40, over = {}) => ({
  stop_reason: 'completed', merged_sha: sha, conflicts: [], notes: 'git merge --no-ff', ...over,
})

const recorded = (over = {}) => ({ stop_reason: 'recorded', path: RUN_DIR + '/state.jsonl',
                                   notes: 'appended', ...over })

// A merge counter, so a multi-wave scenario advances the head the way a real run does.
const mergeSequence = (shas) => {
  let i = 0
  return () => merged(shas[Math.min(i++, shas.length - 1)])
}

// The full integration cast. `review:integration` is listed BEFORE the `review:` prefix on
// purpose — scriptedAgents takes the first key that matches, and the prefix would otherwise
// swallow the integration review and feed it a per-order reviewer's answer.
const integrationCast = (over = {}) => ({
  'integration-setup': setUp(),
  'merge:': merged(),
  'wave-verify:': verified({ discriminator: [], notes: 'built and tested the merged head' }),
  'record:': recorded(),
  'kb-chain': carriedChain(),
  'kb-write': { stop_reason: 'recorded', path: '.claude/agentics/kb', notes: 'appended' },
  'review:integration': reviewed(),
  ...over,
})

// The fresh-path default for the existing-run guard: the repository has never been planned
// against. Only a fresh (non-resume) invocation dispatches this at all.
const noExistingRuns = { stop_reason: 'observed', runs: [], notes: 'no runs directory' }

const happyAgents = (over = {}) => scriptedAgents({
  'existing-runs': noExistingRuns,
  plan: plan([order('W1')]),
  // The default resumed world is the world the plan was written against: the branch sits
  // exactly on the anchor and nothing moved. Only a resume dispatches this at all.
  drift: { stop_reason: 'completed', user_head: A40, moved_files: [], notes: 'unchanged' },
  // There is no `scavenge` answer here any more. What a predecessor left is not something an
  // agent is asked about: lib/run-verdict.mjs reads it off git, so it is fixture data now —
  // see `loaded()`'s `git:` below.
  ...integrationCast(),
  'code:': coded(),
  'verify:': verified(),
  'fix:': coded(),
  'review:': reviewed(),
  ...over,
})

const run = (opts) => runWorkflow(WF, { args: ARGS, workflow: () => surveyResult(), ...opts })

/** Every incomplete result must name something to resume — IRON LAW §6's other half. */
const assertResumableWhenIncomplete = (result) => {
  if (result.coverage.complete) return
  assert.ok(result.coverage.resumable.remaining.length > 0,
    'coverage.complete is false but resumable.remaining is empty: a halt that names nothing ' +
    'to resume is a loud stop without the resumable half of IRON LAW §6')
}

// --- the baseline: one order, verified, reviewed, merged, integration-verified ------------

test('a clean single-order run implements it, merges it, and reports complete coverage', async () => {
  const { result } = await run({ agent: happyAgents() })

  assert.equal(result.implemented.length, 1)
  assert.equal(result.implemented[0].id, 'W1')
  assert.deepEqual(result.implemented[0].review.measured, ['build', 'suite', 'discriminator:1'])
  assert.deepEqual(result.escalations, [])
  assert.deepEqual(result.blocked, [])
  assert.equal(result.checkpoint, null)
  assert.deepEqual(result.integration.merged, ['W1'])
  assert.equal(result.integration.head_sha, M40)
  assert.equal(result.integration.merge_stopped_at, null)
  assert.deepEqual(result.integration.wave_verify, [{ wave: 1, build: 'passed', suite: 'passed' }])
  assert.equal(result.coverage.complete, true)
})

test('the generated prompts carry the load-bearing clauses', async () => {
  const { prompts } = await run({ agent: happyAgents() })

  const byLabel = (l) => prompts.find((p) => p.opts.label === l).prompt
  assert.match(byLabel('plan'), /blocking_gaps/)
  assert.match(byLabel('plan'), /deps/)
  assert.match(byLabel('plan'), /contract/)
  assert.match(byLabel('plan'), /plan-digest\.mjs/)
  assert.match(byLabel('verify:W1'), /lib\/verify\.mjs/)
  assert.match(byLabel('verify:W1'), /ENTIRE stdout into payload_raw/)
  assert.match(byLabel('wave-verify:1'), /--mode integration/)
  assert.match(byLabel('merge:W1'), /NEVER resolve a conflict/)
  assert.match(byLabel('review:integration'), /only exists once they are together/)
})

test('the plan is persisted and its path travels in the result', async () => {
  const { result } = await run({ agent: happyAgents() })
  assert.equal(result.plan_path, RUN_DIR)
})

// ── a dead invocation's worktree still holding this run's branches ───────────────────────────
//
// Git refuses one branch in two worktrees, so a leftover checkout never announces itself: the
// next dispatch's worktree simply comes up DETACHED, and the coder standing in it can commit
// nowhere that survives. In run 20260902-124933 three coders each improvised a different answer
// to that in parallel — one force-removed the leftover, one invented a new branch name, one was
// denied every remedy and escalated with a reason describing a defect that was never there. The
// question is asked once now, before anything is dispatched.

test('the setup pass is told to free this run\'s branches, and never to force one', async () => {
  const { prompts } = await run({ agent: happyAgents() })
  const setup = prompts.find((p) => p.opts.label === 'integration-setup').prompt

  assert.match(setup, /git worktree list/)
  assert.match(setup, /DETACHED/)
  assert.match(setup, /Never --force/)
})

test('a branch freed by the setup pass is reported and costs the run nothing', async () => {
  const { result } = await run({
    agent: happyAgents({ 'integration-setup': setUp({ released: ['agentics/20260816-143005-W1'] }) }),
  })

  assert.deepEqual(result.integration.merged, ['W1'])
  assert.ok(!result.coverage.failed_channels.includes('worktrees'),
    'a leftover that was cleaned up is not a degraded channel — it is a leftover that was cleaned up')
})

test('a branch still held is named in coverage, and nothing is forced to get it', async () => {
  const { result } = await run({
    agent: happyAgents({
      'integration-setup': setUp({
        held: ['agentics/20260816-143005-W1: dirty at C:/repo/.claude/worktrees/wf_dead-3 — ' +
               'one staged deletion of test/w1.test.js'],
      }),
    }),
  })

  assert.ok(result.coverage.failed_channels.includes('worktrees'))
  assert.ok(result.coverage.unreached.some((u) => /still holds this run's branch/.test(u)),
    'the human is told which branch, and why it was left alone')
  assert.ok(result.coverage.unreached.some((u) => /uncommitted work is not/.test(u)),
    'uncommitted work in somebody else\'s tree is not the pipeline\'s to discard')
})

test('a planner that persisted nothing degrades the run-state channel, loudly', async () => {
  const { result } = await run({
    agent: happyAgents({ plan: plan([order('W1')], { plan_path: '' }) }),
  })

  assert.equal(result.plan_path, '')
  assert.ok(result.coverage.failed_channels.includes('run-state'))
  assert.ok(result.coverage.unreached.some((u) => /no plan_path/.test(u)))
  assert.equal(result.coverage.complete, false)
})

// --- vacuous verification is surfaced, not laundered (self-audit P0) ----------------------

test('verification that measured nothing keeps coverage incomplete and names the order', async () => {
  // The field case: a docs-only order in a repo with no build, no suite, no tests. The
  // old booleans let this ship as verified; now emptiness is a carried fact — and the
  // order's id reaches `remaining`, so the incomplete verdict points at something.
  const { result } = await run({
    agent: happyAgents({ 'verify:': verified({ build: 'absent', suite: 'absent', discriminator: [] }) }),
  })

  assert.equal(result.implemented.length, 1)
  assert.deepEqual(result.implemented[0].review.measured, [])
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.unreached.some((u) => /mechanically measurable/.test(u)))
  assert.ok(result.coverage.resumable.remaining.includes('W1'))
  assertResumableWhenIncomplete(result)
})

// --- the evidence checkpoint (F12), now by reference rather than by echo ------------------

test('blocking_gaps withholds dispatch and hands back the path, not the plan', async () => {
  const planned = plan([order('W1')], {
    blocking_gaps: ['latest-tooling-versions — WO-1 pins versions against it'],
  })
  const { result, prompts } = await run({
    agent: scriptedAgents({ 'existing-runs': noExistingRuns, plan: planned }),
    workflow: () => surveyResult({ coverage: {
      complete: false, dropped: [], incomplete: ['latest-tooling-versions'],
      failed_channels: [], unreached: [], resumable: { runId: 'r', remaining: [] },
    } }),
  })

  assert.ok(result.checkpoint)
  assert.equal(result.checkpoint.resume_path, RUN_DIR)
  assert.deepEqual(result.checkpoint.blocking_gaps, planned.blocking_gaps)
  assert.deepEqual(result.implemented, [])
  assert.equal(result.coverage.complete, false)
  assert.ok(!prompts.some((p) => (p.opts.label || '').startsWith('code:')),
    'no coder may be dispatched past the checkpoint')
  assert.ok(!prompts.some((p) => p.opts.label === 'integration-setup'),
    'no worktree is created for a run that was withheld')
  assertResumableWhenIncomplete(result)
})

test('a checkpoint with no persisted plan says a re-invocation must re-plan', async () => {
  const { result } = await run({
    agent: scriptedAgents({
      'existing-runs': noExistingRuns,
      plan: plan([order('W1')], { blocking_gaps: ['a gap'], plan_path: '' }),
    }),
  })

  assert.equal(result.checkpoint.resume_path, '')
  assert.ok(result.coverage.unreached.some((u) => /re-plan from scratch/.test(u)))
})

test('confirmed_gaps is the confirmation: the same plan dispatches', async () => {
  const { result } = await runWorkflow(WF, {
    args: { ...ARGS, confirmed_gaps: true },
    workflow: () => surveyResult(),
    agent: happyAgents({ plan: plan([order('W1')], { blocking_gaps: ['a gap'] }) }),
  })

  assert.equal(result.checkpoint, null)
  assert.equal(result.implemented.length, 1)
  assert.deepEqual(result.integration.merged, ['W1'])
})

// --- survey failure classes stay distinguishable (F4 + self-audit relabel) ----------------

test('a survey that resolves under neither name stops the run before planning', async () => {
  const { result, prompts } = await run({
    agent: scriptedAgents({ 'existing-runs': noExistingRuns }),
    workflow: (name) => { throw new Error(`Workflow "${name}" not found. Available: x`) },
  })

  assert.deepEqual(result.work_orders, [])
  assert.deepEqual(result.coverage.failed_channels, ['survey'])
  assert.ok(/broken reference/.test(result.coverage.unreached[0]))
  assert.ok(prompts.every((p) => p.opts.label === 'existing-runs'),
    'planning must not proceed on a broken survey reference — only the run guard may have run')
})

test('a survey that throws mid-run degrades, labeled as a throw, and planning continues', async () => {
  const { result } = await run({
    agent: happyAgents(),
    workflow: () => { throw new Error('socket hang up') },
  })

  assert.ok(result.survey_coverage.failed_channels.includes('survey'))
  assert.match(result.survey_coverage.unreached[0], /threw before returning: socket hang up/)
  assert.equal(result.implemented.length, 1, 'IRON LAW §5: the run continues, degraded')
  assert.equal(result.coverage.complete, false)
})

// --- partition failure labels (self-audit relabel) ----------------------------------------

test('a partition that refused the plan is labeled a planning defect, with full coupled bodies', async () => {
  const { result } = await run({
    agent: scriptedAgents({
      'existing-runs': noExistingRuns,
      plan: plan([order('W1')], {
        partition_raw: '{"error":"partition: dependency cycle involving W1"}',
      }),
    }),
  })

  assert.equal(result.coupled.length, 1)
  assert.equal(result.coupled[0].title, 'do W1', 'coupled carries the order body, not a bare id')
  assert.ok(result.coverage.failed_channels.includes('partition'))
  assert.ok(result.coverage.unreached.some((u) => /refused the plan/.test(u)))
  assert.ok(!result.coverage.unreached.some((u) => /not JSON/.test(u)))
})

test('an unparseable partition_raw is labeled a paraphrase, not a refusal', async () => {
  const { result } = await run({
    agent: scriptedAgents({
      'existing-runs': noExistingRuns,
      plan: plan([order('W1')], { partition_raw: 'two waves, no coupling' }),
    }),
  })

  assert.ok(result.coverage.unreached.some((u) => /not JSON/.test(u)))
  assert.ok(!result.coverage.unreached.some((u) => /refused the plan/.test(u)))
})

// --- escalation routing --------------------------------------------------------------------

test('a stalled verify fix round escalates as verify_failed_repeatedly with a verify trail', async () => {
  const { result } = await run({
    agent: happyAgents({
      'verify:': verified({ build: 'failed' }),
      'fix:': coded({ status: 'blocked', commits: [], summary: 'cannot fix the build' }),
    }),
  })

  assert.equal(result.escalations.length, 1)
  assert.equal(result.escalations[0].reason, 'verify_failed_repeatedly')
  const verifyRounds = result.escalations[0].trail.filter((t) => t.kind === 'verify')
  assert.ok(verifyRounds.length >= 1, 'failed verify rounds must appear in the trail')
  assert.ok(verifyRounds[0].findings.some((f) => f.id === 'W1-build'))
  assert.equal(result.coverage.complete, false)
  assert.deepEqual(result.integration.merged, [], 'an escalated order is never merged')
})

test('a fix round oscillating between two failure states escalates instead of cycling forever',
  async () => {
    // The third stall shape, and the one that had no exit. `verify_failed_repeatedly` compares
    // this round's failing facts with the round IMMEDIATELY before, so A, B, A, B never trips it
    // — the coder is moving every round, just in a circle.
    //
    // The field case is an order that widened a closed union whose total records lived in other
    // files' fixtures. Its locus did not name them, so the coder had two moves and both were
    // wrong: edit them (a blocking locus breach) or revert (a tree that no longer compiles). It
    // wrote the same correct row three times, reverted it twice, and left the branch on a
    // literal `Revert` commit. Neither move is a defect the coder can fix, because the fence it
    // is caught against is the plan's.
    let round = 0
    const { result } = await run({
      agent: happyAgents({
        'verify:': () => {
          const sha = 'f'.repeat(39) + (++round)
          // Odd rounds: the edit is outside the locus. Even rounds: it was reverted, so the
          // breach is gone and the build is broken instead. Neither state ever repeats twice
          // running, and the pair repeats forever.
          return round % 2 === 1
            ? verified({ build: 'passed', series_findings: [
                { check: 'locus-breach', blocking: true, sha,
                  message: 'src/fixtures/rows.ts is outside the declared locus' }] })
            : verified({ build: 'failed' })
        },
        'fix:': () => {
          const sha = 'a'.repeat(39) + round
          return coded({ head_sha: sha, commits: [{ sha, subject: 'attempt ' + round }] })
        },
      }),
    })

    assert.equal(result.escalations.length, 1)
    assert.equal(result.escalations[0].reason, 'verify_oscillating')
    assert.ok(result.escalations[0].unresolved.some((f) => /cycling/.test(f.claim)),
      'the escalation says which stall this was')
    assert.ok(result.escalations[0].unresolved.some((f) => /Widen the locus in the plan/.test(f.claim)),
      'and names the plan as the defect, because a coder may not widen its own fence')
    assert.deepEqual(result.integration.merged, [], 'an escalated order is never merged')
    assert.equal(result.coverage.complete, false)
  })

test('an order that fails once and is then fixed is never called oscillating', async () => {
  // The negative control. Visiting a failure state once and leaving it is what a fix round IS,
  // and an escalation that fired on it would end every ordinary round-one failure.
  let round = 0
  const { result } = await run({
    agent: happyAgents({
      'verify:': () => (++round === 1 ? verified({ build: 'failed' }) : verified()),
      'fix:': () => coded({ head_sha: 'c'.repeat(40),
        commits: [{ sha: 'c'.repeat(40), subject: 'fix: the build' }] }),
    }),
  })

  assert.deepEqual(result.escalations, [])
  assert.deepEqual(result.implemented.map((e) => e.id), ['W1'],
    'a round-one failure that the fix round actually fixes is the ordinary happy path')
})

test('a fix round that lands commits and moves nothing escalates on the second identical verdict', async () => {
  // The other stall shape. `noProgress` catches a fix round that lands NOTHING; this is the
  // coder that lands commit after commit against a red it cannot move — a flaky test, a
  // broken toolchain — where git shows progress every round and the failing facts never
  // change. That loop had no exit at all: it ran until the invocation was killed, taking
  // every parallel order in the wave with it.
  let round = 0
  const { result } = await run({
    agent: happyAgents({
      'verify:': verified({ build: 'failed' }),
      // A genuinely moving head every round, so the no-new-commit exit cannot be what fires.
      'fix:': () => {
        const sha = 'f'.repeat(39) + (++round)
        return coded({ head_sha: sha, commits: [{ sha, subject: 'attempt ' + round }] })
      },
    }),
  })

  assert.equal(result.escalations.length, 1)
  assert.equal(result.escalations[0].reason, 'verify_failed_repeatedly')
  assert.ok(result.escalations[0].unresolved.some((f) => /without changing what fails/.test(f.claim)),
    'the escalation says which stall this was')
  assert.deepEqual(result.integration.merged, [])
})

test('a schema-whole but semantically impossible coder result escalates as incoherent_result', async () => {
  const { result } = await run({
    agent: happyAgents({ 'code:': coded({ status: 'done', commits: [] }) }),
  })

  assert.equal(result.escalations.length, 1)
  assert.equal(result.escalations[0].reason, 'incoherent_result')
  assert.match(result.escalations[0].unresolved[0].claim, /no commits/)
})

test('the same finding ruled unfixed in two consecutive rounds escalates as review_not_converging', async () => {
  const F1 = { id: 'F1', severity: 'critical', file: 'src/W1.js', line: 3,
               claim: 'off by one', evidence: 'the loop bound' }
  const { result } = await run({
    agent: happyAgents({
      'review:integration': reviewed(),
      'review:': (prompt, opts) =>
        opts.label.endsWith('#1')
          ? reviewed({ findings: [F1] })
          : reviewed({ fix_verdicts: [{ id: 'F1', status: 'not_fixed' }] }),
      'fix:': (prompt, opts) =>
        opts.label.endsWith('#1')
          ? coded({ commits: [{ sha: C40, subject: 'fix: f1' }], head_sha: C40 })
          : coded({ commits: [{ sha: D40, subject: 'fix: f1 again' }], head_sha: D40 }),
    }),
  })

  assert.equal(result.escalations.length, 1)
  assert.equal(result.escalations[0].reason, 'review_not_converging')
  assert.ok(result.escalations[0].unresolved.some((f) => f.id === 'F1'))
  assert.equal(result.escalations[0].trail.filter((t) => t.kind === 'review').length, 3)
})

// --- contract orders: majors block (F7) ----------------------------------------------------

test('a major blocks a contract order and is driven through a fix round', async () => {
  const M1 = { id: 'M1', severity: 'major', file: 'src/W1.js', line: 1,
               claim: 'TapTarget defined twice', evidence: 'sections disagree',
               failure_scenario: 'a consumer implementing section 2 rejects section 5 input' }
  const { result, prompts } = await run({
    agent: happyAgents({
      plan: plan([order('W1', { contract: true })]),
      'review:integration': reviewed(),
      'review:': (prompt, opts) =>
        opts.label.endsWith('#1')
          ? reviewed({ findings: [M1] })
          : reviewed({ fix_verdicts: [{ id: 'M1', status: 'fixed' }] }),
      'fix:': coded({ commits: [{ sha: C40, subject: 'fix: unify' }], head_sha: C40 }),
    }),
  })

  assert.equal(result.implemented.length, 1)
  assert.equal(result.coverage.complete, true)
  const round1 = prompts.find((p) => p.opts.label === 'review:W1#1')
  assert.match(round1.prompt, /This order is a CONTRACT/)
  assert.ok(prompts.some((p) => p.opts.label === 'fix:W1#1'),
    'the major must have triggered a fix round')
})

test('a major does not loop a non-contract order — it ships to the gate as an open major', async () => {
  const M1 = { id: 'M1', severity: 'major', file: 'src/W1.js', line: 1,
               claim: 'edge case', evidence: 'x' }
  const { result, prompts } = await run({
    agent: happyAgents({ 'review:integration': reviewed(), 'review:': reviewed({ findings: [M1] }) }),
  })

  assert.equal(result.implemented.length, 1)
  assert.equal(result.implemented[0].review.open_majors.length, 1)
  assert.ok(!prompts.some((p) => (p.opts.label || '').startsWith('fix:')))
  const round1 = prompts.find((p) => p.opts.label === 'review:W1#1')
  assert.ok(!/This order is a CONTRACT/.test(round1.prompt))
})

// --- the wave loop: all waves in one invocation ---------------------------------------------

test('every wave runs in one invocation and nothing is deferred', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { result } = await run({
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2']]),
      'merge:': mergeSequence([M40, N40]),
    }),
  })

  assert.deepEqual(result.implemented.map((e) => e.id), ['W1', 'W2'])
  assert.deepEqual(result.implemented.map((e) => e.wave), [1, 2])
  assert.deepEqual(result.integration.merged, ['W1', 'W2'])
  assert.deepEqual(result.deferred, [], 'the whole partition runs in one invocation')
  assert.equal(result.integration.wave_verify.length, 2)
  assert.equal(result.coverage.complete, true)
})

test('a wave-2 coder is re-anchored onto the head wave 1 merged', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { prompts } = await run({
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2']]),
      'merge:': mergeSequence([M40, N40]),
    }),
  })

  const w2 = prompts.find((p) => p.opts.label === 'code:W2').prompt
  assert.match(w2, /RE-ANCHOR FIRST/)
  assert.ok(w2.includes(M40), 'wave 2 must branch from the head wave 1 produced')
  // `agentics/<runstamp>-<order-id>`, derived from the runstamp rather than from the integration
  // branch. Deterministic on purpose: a later invocation of the same run knows the runstamp,
  // so it knows which branches to look for when it goes scavenging. And still a dash rather
  // than a slash between the parts — git stores refs as paths, so `<b>/W2` cannot exist while
  // the ref `<b>` does.
  assert.ok(w2.includes('agentics/20260816-143005-W2'),
    'the order branch is derived from the runstamp with a dash, never a slash')
  assert.ok(!w2.includes('agentics/20260816-143005-integration-W2'),
    'the order branch no longer hangs off the integration branch name')
})

test('the wave-1 coder is re-anchored onto the integration base', async () => {
  const { prompts } = await run({ agent: happyAgents() })
  const w1 = prompts.find((p) => p.opts.label === 'code:W1').prompt

  assert.match(w1, /RE-ANCHOR FIRST/)
  assert.ok(w1.includes(A40), 'wave 1 branches from the integration worktree base')
})

test('each wave is recorded to the run state as it completes', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { prompts } = await run({
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2']]),
      'merge:': mergeSequence([M40, N40]),
    }),
  })

  const records = prompts.filter((p) => (p.opts.label || '').startsWith('record:wave-'))
  assert.equal(records.length, 2)

  const { entry } = recordedLine(records[1].prompt)
  assert.deepEqual(entry.merged, ['W1', 'W2'])
  assert.equal(entry.integration_head, N40)
  assert.equal(entry.integration_base, A40)
  assert.equal(entry.kind, 'wave',
    'the line type is written explicitly — a reader must not have to infer it from shape')
})

// --- order-grain durable state -------------------------------------------------------------
//
// The wave line is written when a wave ENDS, and a wave is the longest single stretch in this
// pipeline. A usage limit landing in the middle of one used to lose every order already
// implemented, verified and approved but not yet merged — that is the field incident of
// 2026-08-17, whose retry started from scratch twice with all of it sitting in git.

test('each approved order is recorded the moment its review closes', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { prompts } = await run({
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2']]),
      'merge:': mergeSequence([M40, N40]),
    }),
  })

  const orderLines = prompts.filter((p) => (p.opts.label || '') === 'record:W1' ||
    (p.opts.label || '') === 'record:W2')

  assert.equal(orderLines.length, 2)

  const { entry } = recordedLine(orderLines[0].prompt)
  assert.equal(entry.kind, 'order-approved')
  assert.equal(entry.order, 'W1')
  // The branch and worktree recorded are the ones the coder REPORTED, never the ones it was
  // asked for. A resume goes looking in the tree, and the tree holds what was actually made.
  assert.equal(entry.branch, 'wo-w1')
  assert.equal(entry.worktree, 'C:/wt/w1')
  assert.equal(entry.head_sha, B40)
})

test('an order-approved line is written before the wave line it belongs to', async () => {
  const { prompts } = await run({ agent: happyAgents() })

  const labels = prompts.map((p) => p.opts.label || '').filter((l) => l.startsWith('record:'))

  assert.deepEqual(labels, ['record:W1', 'record:wave-1'],
    'recording the order after the wave would record nothing an interruption could use')
})

test('an escalated order is never recorded as approved', async () => {
  const { prompts } = await run({
    agent: happyAgents({
      'verify:': verified({ build: 'failed' }),
      'fix:': coded({ status: 'blocked', commits: [], summary: 'cannot fix' }),
    }),
  })

  assert.ok(!prompts.some((p) => (p.opts.label || '') === 'record:W1'),
    'an order that escalated has no approved series to adopt on a resume')
})

test('nothing is recorded when there is no run directory to record into', async () => {
  const { prompts } = await run({
    agent: happyAgents({ plan: plan([order('W1')], { plan_path: '' }) }),
  })

  assert.ok(!prompts.some((p) => (p.opts.label || '').startsWith('record:')),
    'a recorder dispatched at no path would report a write nobody can find')
})

// --- the dependency gate: `blocked`, not `deferred` (AF-5) ----------------------------------

test('an order whose provider escalated is blocked, naming the provider', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { result, prompts } = await run({
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2']]),
      'verify:': verified({ build: 'failed' }),
      'fix:': coded({ status: 'blocked', commits: [], summary: 'cannot fix' }),
    }),
  })

  assert.equal(result.escalations.length, 1)
  assert.deepEqual(result.blocked, [{ id: 'W2', blocked_by: 'W1' }])
  assert.deepEqual(result.deferred, [],
    'a blocked order must never wear the deferred label — deferred means "re-invoke and implement me"')
  assert.ok(!prompts.some((p) => p.opts.label === 'code:W2'),
    'a blocked order is not dispatched at all')
  assert.ok(result.coverage.unreached.some((u) => /W2: blocked — W1 did not land/.test(u)))
  assert.ok(result.coverage.resumable.remaining.includes('W2'))
  assert.equal(result.coverage.complete, false)
  assertResumableWhenIncomplete(result)
})

test('a blocked chain names the escalated root, not the nearest link', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] }), order('W3', { deps: ['W2'] })]
  const { result } = await run({
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2'], ['W3']]),
      'verify:': verified({ build: 'failed' }),
      'fix:': coded({ status: 'blocked', commits: [], summary: 'cannot fix' }),
    }),
  })

  assert.deepEqual(result.blocked, [
    { id: 'W2', blocked_by: 'W1' },
    { id: 'W3', blocked_by: 'W1' },
  ])
})

test('an independent order in a later wave still runs while another is blocked', async () => {
  // IRON LAW §7 is "escalate, never abandon". Abandoning work that depends on nothing
  // broken, because something else broke, is exactly that.
  const orders = [order('W1'), order('W2', { deps: ['W1'] }), order('W3')]
  const { result } = await run({
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2', 'W3']]),
      'verify:': (prompt) => prompt.includes('WORK ORDER W1')
        ? verified({ build: 'failed' })
        : verified(),
      'fix:': coded({ status: 'blocked', commits: [], summary: 'cannot fix' }),
    }),
  })

  assert.deepEqual(result.blocked, [{ id: 'W2', blocked_by: 'W1' }])
  assert.deepEqual(result.implemented.map((e) => e.id), ['W3'])
  assert.deepEqual(result.integration.merged, ['W3'])
})

// --- stop-the-line: merges and post-merge verification (AF-1) --------------------------------

test('a merge conflict stops the line and defers what has not run', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { result, prompts } = await run({
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2']]),
      'merge:': merged('', { conflicts: ['src/W1.js'] }),
    }),
  })

  assert.deepEqual(result.integration.merged, [])
  assert.deepEqual(result.integration.merge_stopped_at, { order: 'W1', conflicts: ['src/W1.js'] })
  assert.deepEqual(result.integration.approved_unmerged, ['W1'])
  assert.deepEqual(result.deferred, ['W2'])
  assert.ok(!prompts.some((p) => p.opts.label === 'code:W2'))
  assert.ok(result.coverage.unreached.some((u) => /planner defect/.test(u)))
  assert.ok(result.coverage.resumable.remaining.includes('W1'))
  assert.equal(result.coverage.complete, false)
  assertResumableWhenIncomplete(result)
})

test('an environment_broken merge with no conflicts is still not a merge', async () => {
  // mergeOk reads all three fields. Reading `conflicts` alone would wave this through — an
  // environment_broken merge has an empty conflict list too.
  const { result } = await run({
    agent: happyAgents({
      'merge:': { stop_reason: 'environment_broken', merged_sha: '', conflicts: [],
                  notes: 'git refused: index.lock exists' },
    }),
  })

  assert.deepEqual(result.integration.merged, [])
  assert.equal(result.integration.merge_stopped_at.order, 'W1')
  assert.equal(result.coverage.complete, false)
})

test('a merged head that fails its own verification stops the line', async () => {
  // Nothing in wave 1 failed; the COMBINATION did. Without this check wave 2 inherits the
  // breakage and reports it as its own orders' defects.
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { result, prompts } = await run({
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2']]),
      'wave-verify:': verified({ suite: 'failed', discriminator: [], notes: 'suite failed at the merged head' }),
    }),
  })

  assert.deepEqual(result.integration.merged, ['W1'], 'the merge itself completed')
  assert.deepEqual(result.integration.wave_verify, [{ wave: 1, build: 'passed', suite: 'failed' }])
  assert.deepEqual(result.deferred, ['W2'])
  assert.ok(!prompts.some((p) => p.opts.label === 'code:W2'))
  assert.ok(result.coverage.unreached.some((u) => /defect in the combination/.test(u)))
  assert.equal(result.coverage.complete, false)
  assertResumableWhenIncomplete(result)
})

test('the integration worktree failing to appear dispatches nothing at all', async () => {
  const { result, prompts } = await run({
    agent: happyAgents({
      'integration-setup': setUp({ stop_reason: 'environment_broken', worktree: '', branch: '',
                                   head_sha: '', notes: 'path exists as a file' }),
    }),
  })

  assert.deepEqual(result.implemented, [])
  assert.deepEqual(result.deferred, ['W1'])
  assert.ok(!prompts.some((p) => (p.opts.label || '').startsWith('code:')),
    'implementing with nowhere to merge would strand every branch')
  assert.ok(result.coverage.failed_channels.includes('integration'))
  assert.equal(result.coverage.complete, false)
  assertResumableWhenIncomplete(result)
})

// --- the optional per-wave gate --------------------------------------------------------------

test('pause_between_waves returns after a wave with the rest deferred', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { result, prompts } = await runWorkflow(WF, {
    args: { ...ARGS, pause_between_waves: true },
    workflow: () => surveyResult(),
    agent: happyAgents({ plan: wavedPlan(orders, [['W1'], ['W2']]) }),
  })

  assert.deepEqual(result.integration.merged, ['W1'])
  assert.deepEqual(result.deferred, ['W2'])
  assert.ok(!prompts.some((p) => p.opts.label === 'code:W2'))
  assert.equal(result.coverage.complete, false)
  assertResumableWhenIncomplete(result)
})

test('pausing is opt-in: the default runs every wave', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { result } = await run({
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2']]),
      'merge:': mergeSequence([M40, N40]),
    }),
  })

  assert.deepEqual(result.deferred, [])
  assert.deepEqual(result.integration.merged, ['W1', 'W2'])
})

// --- the integration review ------------------------------------------------------------------

test('an integration critical keeps coverage incomplete and names something to resume', async () => {
  const F9 = { id: 'F9', severity: 'critical', file: 'src/W1.js', line: 4,
               claim: 'W1 and W2 define the same symbol differently', evidence: 'both diffs' }
  const { result } = await run({
    agent: happyAgents({ 'review:integration': reviewed({ findings: [F9] }) }),
  })

  assert.equal(result.integration.review.findings.length, 1)
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.unreached.some((u) => /integration review \[F9\]/.test(u)))
  assert.ok(result.coverage.resumable.remaining.includes('integration'))
  assertResumableWhenIncomplete(result)
})

test('an integration review that did not run is an unsupported claim, not a pass', async () => {
  const { result } = await run({
    agent: happyAgents({ 'review:integration': () => { throw new Error('budget') } }),
  })

  assert.equal(result.integration.review, null)
  assert.ok(result.coverage.failed_channels.includes('integration-review'))
  assert.ok(result.coverage.unreached.some((u) => /unsupported/.test(u)))
  assert.equal(result.coverage.complete, false)
  assertResumableWhenIncomplete(result)
})

test('nothing merged means no integration review is dispatched', async () => {
  const { prompts } = await run({
    agent: happyAgents({
      'verify:': verified({ build: 'failed' }),
      'fix:': coded({ status: 'blocked', commits: [], summary: 'cannot fix' }),
    }),
  })

  assert.ok(!prompts.some((p) => p.opts.label === 'review:integration'))
})

// --- resume by reference (B2) -----------------------------------------------------------------

const loadedPlan = (orders, over = {}) => ({
  work_orders: orders,
  shared_files: [],
  partition_raw: JSON.stringify({ waves: [['W1'], ['W2']], coupled: [] }),
  blocking_gaps: [],
  plan_path: RUN_DIR,
  notes: '',
  ...over,
})

const envelope = (over = {}) => ({
  change: 'add the thing', roots: '.', caller_notes: '', intelligence: 'normal',
  base_branch: 'master', base_sha: A40, programme: '', slice: '',
  ...over,
})

const loaded = (orders, over = {}) => ({
  stop_reason: 'loaded',
  plan: loadedPlan(orders),
  envelope: envelope(),
  // What git holds for this run — the question the deleted `scavenge` agent used to be sent
  // out to answer, now read from disk by lib/run-verdict.mjs and therefore fixture data. No
  // order branch exists, so every pending order is built from scratch. `clean` is false on
  // purpose: the state line below IS a record, and a run that recorded something is not a
  // clean one however empty git looks.
  git: gitFacts([], { clean: false }),
  state: [{ wave: 1, merged: ['W1'], approved_unmerged: [], escalated: [],
            integration_base: A40, integration_head: M40 }],
  notes: 'read plan.json and one state entry',
  ...over,
})

test('a resumed run skips the survey and the planner entirely', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  let surveyCalls = 0

  const { result, prompts } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => { surveyCalls += 1; return surveyResult() },
    agent: happyAgents({
      ...resumeLoad(loaded(orders)),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  assert.equal(surveyCalls, 0, 'the survey is the expensive half a resume exists to skip')
  assert.ok(!prompts.some((p) => p.opts.label === 'plan'))
  assert.equal(result.plan_path, RUN_DIR)
  assert.deepEqual(result.implemented.map((e) => e.id), ['W2'],
    'an order the run state records as merged is not implemented again')
  assert.deepEqual(result.integration.merged, ['W2'])
  assert.equal(result.coverage.complete, true)
})

test('a resumed run reviews the whole change, not only the waves it ran', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { prompts } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders)),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  const review = prompts.find((p) => p.opts.label === 'review:integration').prompt
  assert.ok(review.includes(A40 + '..' + N40),
    'the diff under review runs from the run\'s original base, carried in the run state')
})

test('a branch that moved between invocations is reported, and the tree wins', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { result } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders)),
      'integration-setup': setUp({ head_sha: C40 }),   // the state recorded M40
      'merge:': merged(N40),
    }),
  })

  assert.ok(result.coverage.unreached.some((u) => /moved between invocations/.test(u)))
  assert.ok(result.coverage.failed_channels.includes('run-state'))
  assert.equal(result.coverage.complete, false)
})

test('an unreadable run directory dispatches nothing and says to re-plan', async () => {
  // The courier now succeeds — it ran the command and pasted the output faithfully — and the
  // PAYLOAD is what says the plan could not be read. So this exits through the corrupt halt
  // rather than through the transport ladder, and the reader's own account of what was wrong
  // has to survive that hop: "plan.json is not there" is actionable, "the run is corrupt" is not.
  const { result, prompts } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: scriptedAgents({
      ...resumeLoad({ stop_reason: 'unreadable', plan: null, state: [],
                       notes: 'plan.json is not there' }),
    }),
  })

  assert.deepEqual(result.implemented, [])
  assert.ok(result.coverage.failed_channels.includes('run-state'))
  assert.ok(result.coverage.unreached.some((u) => /plan integrity: plan\.json is not there/.test(u)),
    "the reader's own words reach the caller, not a paraphrase of them")
  assert.ok(result.coverage.unreached.some((u) => /re-plan/.test(u)),
    'a resume that found no plan has to say what to do instead of resuming')
  assert.deepEqual(result.coupled, [],
    'a run whose plan nobody could read knows nothing about what is already built, so it ' +
    'must hand back nothing to reimplement')
  assert.ok(!prompts.some((p) => p.opts.label === 'integration-setup'))
})

// --- the content digest tripwire (B3 / AF-8) ---------------------------------------------------
//
// The tripwire moved. It used to guard a per-order manifest against a fan of couriers that
// re-emitted every order's prose; there is no fan and no re-emission any more — the orders
// never cross a model on a resume at all. What survives of B3 is two things, and both are
// pinned below: ONE digest over the whole verdict payload, recomputed in-script, and the
// per-order digest quoted into the prompt of whoever fetches the order off disk.

test('a digest computed by lib/plan-digest.mjs is accepted by the in-script recomputation', async () => {
  // This is still the test that pins the two implementations together, one level up. The
  // library digests the verdict payload with `fnv1a(canonical(...))`; the workflow recomputes
  // it from its own copy of both functions, which it must carry because a workflow script has
  // no imports. If they ever diverge, every resume in the world halts on a mismatch that is
  // not there — so the pin is behavioural rather than a comment asking two files to stay in
  // step. The punctuation in the context is deliberate: it is what a naive canonicalization
  // gets wrong.
  const orders = [order('W1'), order('W2', { deps: ['W1'], context: 'a much longer context, with punctuation: commas, colons — and a dash' })]
  const { result, prompts, logs } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders)),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  assert.equal(result.coverage.complete, true)
  assert.ok(!result.coverage.unreached.some((u) => /plan integrity/.test(u)))
  assert.ok(!logs.some((l) => /digest mismatch/.test(l)),
    'two copies of one hash that disagree turn every healthy resume into a false halt')
  assert.ok(!prompts.some((p) => p.opts.label === 'resume-verdict#2'),
    'and buy a second courier tier every time, for nothing')
})

test('a paraphrased context cannot reach a coder: the order is fetched under its digest', async () => {
  // What replaced the manifest comparison. The exact corruption it was built for — same order
  // count, same locus count, same acceptance count, one sentence reworded — can no longer
  // happen in transit, because the prose does not travel: the verdict carries the order's
  // SKELETON and its digest, and the coder is sent to read the words themselves off disk.
  //
  // That leaves exactly one hazard, the one the digest is quoted for: plan.json edited between
  // the verdict and the dispatch. So the pin is on the prompt — the fetch command, the number
  // to confirm, and the absence of the prose this script must never be the source of.
  const w2 = order('W2', { deps: ['W1'], context: 'the transport is scp; rsync is absent here' })
  const { prompts } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded([order('W1'), w2])),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  const code = prompts.find((p) => p.opts.label === 'code:W2').prompt
  assert.ok(code.includes('node "C:/plugin/lib/ledger.mjs" order "' + RUN_DIR + '" "W2"'),
    'the order travels disk -> tool result -> context, the one direction that cannot corrupt')
  assert.ok(code.includes('CONFIRM that digest reads exactly ' + digestOrder(w2)),
    'a coder implementing against an order the plan was not ratified with is the damage the ' +
    'manifest was built to catch, and the digest is where that catch now lives')
  assert.ok(!code.includes('the transport is scp; rsync is absent here'),
    'a prose field this script quotes is a prose field this script can paraphrase')
})

test('a verdict no courier can carry halts the resume with the shape of the damage', async () => {
  // The old halt named the order and what differed about it, because "the plan is corrupt" is
  // not an actionable halt. The same duty survives the rework at the new granularity: when the
  // payload is damaged the reader has to be able to tell transcription damage from a plan that
  // really did change, and that means both numbers, not just the word "mismatch".
  //
  // The damage is applied after the digest is taken, so the mismatch is real rather than
  // asserted — and it is applied to both rungs of the ladder, since one retry one tier up is
  // what a damaged payload buys before the run stops.
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const mangle = (env) => { env.payload.partition.waves = [] }
  const mangled = resumeLoad(loaded(orders), mangle)['resume-verdict']
  const sent = JSON.parse(mangled.payload_raw)

  const { result, prompts } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: scriptedAgents({ 'resume-verdict': mangled, 'resume-verdict#2': mangled }),
  })

  const said = result.coverage.unreached.join(' ')
  assert.ok(said.includes('the verdict was computed as ' + sent.payload_digest),
    'the digest the run-verdict CLI stamped on its own output')
  assert.ok(/what arrived digests to [0-9a-f]{8}/.test(said) &&
    !said.includes('digests to ' + sent.payload_digest),
    'and the digest of what actually turned up, which is the half that says how far it drifted')

  assert.deepEqual(result.implemented, [])
  assert.ok(result.coverage.failed_channels.includes('run-state'))
  assert.ok(!prompts.some((p) => (p.opts.label || '').startsWith('code:')),
    'nothing is dispatched against a plan that is not the plan that was written')
})

// DELETED: 'an order that vanished in transit halts the resume'.
//
// It pinned the manifest's both-directions id comparison — an order in the manifest that the
// loaded plan did not carry. Nothing per-order is loaded any more: lib/run-verdict.mjs reads
// plan.json itself and emits exactly one row per work order, so the two sets cannot disagree,
// and an order lost between the CLI and this script takes the payload digest with it. That
// path is pinned end-to-end in test/agentics-develop-resume-verdict.test.mjs ('a payload no tier
// can carry halts, and never reports the plan as all-coupled'), and the halt it produces is
// the test directly above.

// --- the integration handle survives every exit path (AF-6) -------------------------------------

test('a throw mid-run still hands back the branch that holds the finished work', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  let merges = 0

  const { result } = await run({
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2']]),
      // The second merge answers with a shape no schema would pass — the point is that when
      // something DOES throw, the caller still learns which branch already holds wave 1.
      'merge:': () => (merges++ === 0 ? merged(M40) : { stop_reason: 'completed', merged_sha: N40 }),
    }),
  })

  assert.ok(result.coverage.failed_channels.includes('pipeline'))
  assert.equal(result.integration.branch, 'agentics/20260816-143005-integration')
  assert.deepEqual(result.integration.merged, ['W1'])
  assert.equal(result.integration.head_sha, M40)
  assert.ok(result.coverage.resumable.remaining.includes('integration'))
  assert.equal(result.coverage.complete, false)
  assertResumableWhenIncomplete(result)
})

test('every exit path returns the integration handle, even the ones that dispatch nothing', async () => {
  const { result } = await runWorkflow(WF, {
    args: { roots: '.', plugin_root: 'C:/plugin' },   // no change at all
    agent: scriptedAgents({}),
  })

  assert.ok(result.integration, 'the handle is part of the documented shape on every path')
  assert.deepEqual(result.integration.merged, [])
  assert.equal(result.coverage.complete, false)
})

// ---------------------------------------------------------------- the intelligence dial
//
// Three positions, each moving a different set of agents. A dial is only real where it
// reaches an `opts.model`, so that is what these read — and the absences matter as much as
// the values: a tier that grew a coder override would show up here as a model where there
// should be none.

test('`low` puts every judging agent on sonnet and moves nothing else', async () => {
  const { prompts } = await run({
    args: { ...ARGS, intelligence: 'low' },
    agent: happyAgents(),
  })

  const modelOf = (label) => prompts.find((p) => p.opts.label === label).opts.model

  assert.equal(modelOf('plan'), 'sonnet', 'the planner is a judging agent')
  assert.equal(modelOf('review:W1#1'), 'sonnet', 'so is every per-order reviewer')
  assert.equal(modelOf('review:integration'), 'sonnet', 'and so is the integration reviewer')

  // The coder already runs sonnet by frontmatter, so what these pin is that the dial did not
  // TOUCH it. An explicit model here would mean `low` had grown a coder tier of its own, and
  // the next edit to coder.md would silently stop applying to low-tier runs.
  assert.equal(modelOf('code:W1'), undefined, 'the coder keeps its frontmatter at `low`')
  // Courier grade, and a constant: the verify dispatch runs a script and pastes one line, so
  // its tier is a property of the JOB rather than of what the user is willing to spend. A dial
  // that reached it would be pricing transcription.
  assert.equal(modelOf('verify:W1'), 'haiku', 'the mechanical tier never moves with the dial')
})

test('`max` moves the coder too, but to opus and not to the model the judges get', async () => {
  // Fable-judged, opus-implemented — the configuration the coupled dial could not express.
  // The equality that must NOT hold is the interesting one: a `max` run where the coder and
  // the reviewer share a model is the coupling this position was split to remove, and it
  // returns silently the moment somebody reaches for one ternary to set both.
  const { prompts } = await run({
    args: { ...ARGS, intelligence: 'max' },
    agent: happyAgents(),
  })

  const modelOf = (label) => prompts.find((p) => p.opts.label === label).opts.model

  assert.equal(modelOf('plan'), 'fable')
  assert.equal(modelOf('review:W1#1'), 'fable')
  assert.equal(modelOf('code:W1'), 'opus')
  assert.notEqual(modelOf('code:W1'), modelOf('review:W1#1'),
    'the judge and the generator are priced apart at the top position, deliberately')
  assert.equal(modelOf('verify:W1'), 'haiku', 'even at `max`, pasting one line is pasting one line')
})

test('`normal` names opus rather than inheriting it', async () => {
  // The dial is the authority on what a judge costs. Reading `undefined` here would mean the
  // tier came from whatever agents/reviewer.md happens to say, which prices a run correctly
  // right up until somebody edits that file — while the tier the envelope RECORDS still comes
  // from the dial.
  const { prompts } = await run({ args: { ...ARGS, intelligence: 'normal' }, agent: happyAgents() })
  const modelOf = (label) => prompts.find((p) => p.opts.label === label).opts.model

  assert.equal(modelOf('plan'), 'opus')
  assert.equal(modelOf('review:W1#1'), 'opus')
  assert.equal(modelOf('review:integration'), 'opus')
  assert.equal(modelOf('code:W1'), undefined, 'the coder is not on this table at any position')
})

// ------------------------------------------------- does the next wave fit
//
// Not a budget stop. §1 forbids ending work because effort was spent, and nothing here ends
// anything — it moves the boundary to a seam where stopping is free. A wave killed halfway
// through by a session limit leaves nothing to resume from: the agents that had not returned
// left no record. A wave boundary has the state line written and the next wave branching from
// a head that already exists.

const TWO_WAVES = (over = {}) => plan([order('W1'), order('W2')], {
  partition_raw: JSON.stringify({ waves: [['W1'], ['W2']], coupled: [] }),
  ...over,
})

test('a run with no token target never stops early, however large', async () => {
  const { result, logs } = await run({
    agent: happyAgents({ plan: TWO_WAVES() }),
  })

  // With no target `remaining()` is Infinity. A script cannot see an account's usage limit,
  // and guessing at one would halt runs that would have finished.
  assert.deepEqual(result.integration.merged, ['W1', 'W2'])
  assert.ok(!logs.some((l) => /STOPPING after wave/.test(l)))
})

test('the plan size is reported before any wave is dispatched', async () => {
  const { logs } = await run({ agent: happyAgents({ plan: TWO_WAVES() }) })

  assert.ok(logs.some((l) => /Plan size: 2 order\(s\) across 2 wave\(s\)/.test(l)),
    'the caller can see what the run is about to buy')
})

test('a wave the remaining target cannot cover is deferred at the boundary, not started', async () => {
  const { result, logs } = await run({
    agent: happyAgents({ plan: TWO_WAVES() }),
    // Wave 1 costs enough that the projection for wave 2 exceeds what is left.
    budget: { total: 60_000, perDispatch: 6_000 },
  })

  assert.deepEqual(result.integration.merged, ['W1'], 'wave 1 completed and merged')
  assert.ok(logs.some((l) => /STOPPING after wave 1/.test(l)))

  // The whole point: deferred work is resumable work. A mid-wave death is not.
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.resumable.remaining.includes('W2'))
})

// ------------------------------------------------- the dial, per order
//
// One dial for a whole run prices a ten-order plan as though its orders were the same work.
// `weight` moves an order DOWN from the run's ceiling, and a structural floor holds red and
// contract orders up regardless of the dial. Both are only real where they reach an
// `opts.model`, so that is what these read.

test('a red order implements at opus even when the dial says sonnet', async () => {
  // This is an ALWAYS, never waived. A red order pins the
  // acceptance criteria in failing tests; the green coder is fenced to those criteria and
  // implements a wrong reading faithfully; the reviewer is fenced to the same criteria and
  // has no standing to object. Nothing downstream can catch it.
  const red = order('R1', { role: 'red', locus: ['test/widget.test.js'] })
  const green = order('G1', { role: 'green', locus: ['src/widget.js'], deps: ['R1'] })

  const { prompts } = await run({
    args: { ...ARGS, intelligence: 'low' },
    agent: happyAgents({
      plan: plan([red, green], {
        partition_raw: JSON.stringify({ waves: [['R1'], ['G1']], coupled: [] }),
      }),
      // A red order's suite is REQUIRED to fail; the ordinary verdict would spiral it.
      'verify:R1': verified({ suite: 'failed', discriminator: [
        { test_id: 'test/widget.test.js', failed_on_base: true, passes_now: false },
      ] }),
    }),
  })

  const modelOf = (label) => (prompts.find((p) => p.opts.label === label) || { opts: {} }).opts.model

  assert.equal(modelOf('code:R1'), 'opus', 'the floor holds under the dial')

  // The green order is deliberately NOT floored. Its defects are the catchable kind — the
  // tests the red order pinned either pass or they do not — where a wrong red pin is
  // uncatchable by construction. The floor is about what nothing downstream can see.
  assert.equal(modelOf('code:G1'), undefined)
})

test('a contract order implements at opus, where an ordinary one inherits', async () => {
  const { prompts } = await run({
    args: { ...ARGS, intelligence: 'normal' },
    agent: happyAgents({ plan: plan([order('W1', { contract: true }), order('W2')]) }),
  })

  const modelOf = (label) => prompts.find((p) => p.opts.label === label).opts.model

  // An ambiguity in a contract propagates into every consumer, which is the same
  // uncatchable-downstream shape the red floor exists for.
  assert.equal(modelOf('code:W1'), 'opus')
  assert.equal(modelOf('code:W2'), undefined, 'an ordinary order keeps its frontmatter model')
})

test('a light order is reviewed by the cheap reader, on a max run', async () => {
  const { prompts } = await run({
    args: { ...ARGS, intelligence: 'max' },
    agent: happyAgents({
      plan: plan([order('W1', { weight: 'light' }), order('W2', { weight: 'heavy' })]),
    }),
  })

  const modelOf = (label) => prompts.find((p) => p.opts.label === label).opts.model

  assert.equal(modelOf('review:W1#1'), 'sonnet', 'a rename does not need the most expensive reader')
  assert.equal(modelOf('review:W2#1'), 'fable', 'the hard order still gets the run/s ceiling')
  assert.equal(modelOf('code:W1'), 'sonnet', 'and it is implemented cheaply too')
  assert.equal(modelOf('code:W2'), 'opus')
})

test('weight never buys above the run dial — the ceiling is the user/s', async () => {
  // The planner is an agent the session dispatched. Letting it raise the tier would be the
  // same self-upgrade the derivation rule forbids the session, arriving by proxy.
  const { prompts } = await run({
    args: { ...ARGS, intelligence: 'low' },
    agent: happyAgents({ plan: plan([order('W1', { weight: 'heavy' })]) }),
  })

  const modelOf = (label) => prompts.find((p) => p.opts.label === label).opts.model
  assert.equal(modelOf('review:W1#1'), 'sonnet', 'heavy cannot climb past a low dial')
})

test('a weight nobody set is standard, so an old plan resumes unchanged', async () => {
  const { prompts } = await run({
    args: { ...ARGS, intelligence: 'normal' },
    agent: happyAgents({ plan: plan([order('W1', { weight: undefined })]) }),
  })

  const modelOf = (label) => prompts.find((p) => p.opts.label === label).opts.model
  assert.equal(modelOf('review:W1#1'), 'opus')
  assert.equal(modelOf('code:W1'), undefined)
})

test('a tier nobody defined is served as `normal`, not as itself', async () => {
  // The dial is a closed set of three. A typo that fell through would dispatch at some other
  // tier while every log and every envelope read back the tier the user typed.
  const { prompts } = await run({
    args: { ...ARGS, intelligence: 'cheap' },
    agent: happyAgents(),
  })

  const modelOf = (label) => prompts.find((p) => p.opts.label === label).opts.model

  assert.equal(modelOf('plan'), 'opus')
  assert.equal(modelOf('code:W1'), undefined)
})

test('a resumed run adopts a recorded `low` the same way it adopts any other tier', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { prompts, logs } = await runWorkflow(WF, {
    args: { change: 'add the thing', resume_path: RUN_DIR, plugin_root: 'C:/plugin' },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders, { envelope: envelope({ intelligence: 'low' }) })),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  assert.equal(prompts.find((p) => p.opts.label === 'review:integration').opts.model, 'sonnet',
    'a plan written under `low` is reviewed under `low` when it is picked up again')
  assert.ok(!logs.some((l) => /Override: intelligence/.test(l)),
    'a caller who passed no tier has disagreed with nothing')
})

// ---------------------------------------------------------------- the plan envelope
//
// A resumed run must implement under the conditions its plan was written for, not under
// whatever the caller still remembers a week later. The acute case is `caller_notes`: it
// carries the evidence a design phase settled, and losing it fails silently — the run
// proceeds and quietly re-opens questions somebody already answered.

test('a resumed run adopts the notes and tier its plan was written under', async () => {
  // The notes half changed mechanism and kept its whole point. Settled evidence is the largest
  // string in the envelope, so it is DESCRIBED in the verdict — a length and a digest — and
  // never carried; the coder is handed the command that reads it off disk. What still has to
  // be true is that the evidence REACHES the coder on a week-later resume, which is why the
  // reference and the announced length are both pinned: a run whose evidence went missing must
  // look different from one that never had any.
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const settled = 'rsync is absent; transport is scp'
  const { prompts, logs } = await runWorkflow(WF, {
    // The caller passes neither notes nor intelligence — exactly the week-later resume.
    args: { change: 'add the thing', resume_path: RUN_DIR, plugin_root: 'C:/plugin' },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders, {
        envelope: envelope({
          roots: 'C:/repo', caller_notes: settled, intelligence: 'max',
        }),
      })),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  const code = prompts.find((p) => p.opts.label === 'code:W2')
  assert.ok(code.prompt.includes('node "C:/plugin/lib/ledger.mjs" notes "' + RUN_DIR + '"'),
    'settled evidence recorded at plan time must reach the coder on a resume')
  assert.ok(!code.prompt.includes(settled),
    'by reference, not by copy: the verdict carries a length and a digest, never the text')
  assert.ok(logs.some((l) => l.includes('Settled evidence: ' + settled.length + ' character(s)')),
    'evidence that silently went missing is the failure this envelope exists to prevent, and ' +
    'the announced length is the only way a reader can see it did not')
  assert.ok(code.prompt.includes('C:/repo'), 'the roots the plan was surveyed against win')
  assert.equal(code.opts.model, 'opus', 'the recorded intelligence tier is adopted too')
})

test('an explicit caller value still wins over the record, and says so', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { prompts, logs } = await runWorkflow(WF, {
    args: { ...ARGS, roots: 'C:/elsewhere', resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders, { envelope: envelope({ roots: 'C:/repo' }) })),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  assert.ok(prompts.find((p) => p.opts.label === 'code:W2').prompt.includes('C:/elsewhere'))
  assert.ok(logs.some((l) => /Override: roots/.test(l)),
    'silently disagreeing with the plan on disk is how a resume stops being one')
})

// The tier needs the same log line more urgently than roots does. The skills derive
// `intelligence` from the model the calling session is running, so a resume arrives carrying
// a tier nobody typed — and a run that adopts it in silence implements one plan at another
// plan's cost, with the plan file still claiming the tier it was written under.
test('a caller tier that disagrees with the record wins, and says so', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { prompts, logs } = await runWorkflow(WF, {
    args: { ...ARGS, intelligence: 'normal', resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders, { envelope: envelope({ intelligence: 'max' }) })),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  assert.equal(prompts.find((p) => p.opts.label === 'code:W2').opts.model, undefined,
    'the supplied tier is the one the resumed run implements at')
  assert.ok(logs.some((l) => /Override: intelligence/.test(l)),
    'a silent re-tier is how a resumed plan stops being the plan it resumed')
})

test('a resume that supplies the tier it already recorded is not an override', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { prompts, logs } = await runWorkflow(WF, {
    args: { ...ARGS, intelligence: 'max', resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders, { envelope: envelope({ intelligence: 'max' }) })),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  assert.equal(prompts.find((p) => p.opts.label === 'code:W2').opts.model, 'opus')
  assert.ok(!logs.some((l) => /Override: intelligence/.test(l)),
    'agreeing with the record is not a disagreement to report')
})

test('resuming under a different change halts before anything is dispatched', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { result, prompts } = await runWorkflow(WF, {
    args: { ...ARGS, change: 'add a completely different thing', resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({ ...resumeLoad(loaded(orders) )}),
  })

  assert.equal(result.coverage.complete, false)
  assert.ok(!prompts.some((p) => p.opts.label === 'integration-setup'),
    'a wrong-run resume must not reach the point of creating a worktree')
  assert.deepEqual(result.implemented, [])
  assert.match(result.coverage.unreached.join(' '), /written for a different change/)
})

test('a plan file with no recorded envelope resumes rather than halting', async () => {
  // Plans written before the envelope existed have none. That is a missing field, not a
  // mismatch, and it must not brick every run planned last week.
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { result } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders, { envelope: envelope({ change: '', roots: '' }) })),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  assert.deepEqual(result.integration.merged, ['W2'])
  assert.equal(result.coverage.complete, true)
})

// ---------------------------------------------------------------- plan_only
//
// Parking a plan and stopping on evidence exit through one shape, so the shape has to say
// which happened. Before `reason`, a non-null checkpoint meant "the planner found blocking
// gaps" — the only way it went non-null — and the develop skill reads it that way.

test('plan_only plans in full and dispatches nothing', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: { ...ARGS, plan_only: true },
    workflow: () => surveyResult(),
    agent: happyAgents({ plan: plan([order("W1"), order("W2")]) }),
  })

  assert.equal(result.checkpoint.reason, 'plan_only')
  assert.deepEqual(result.checkpoint.blocking_gaps, [])
  assert.equal(result.checkpoint.resume_path, RUN_DIR)
  assert.equal(result.work_orders.length, 2, 'the plan is the deliverable and travels whole')

  assert.ok(!prompts.some((p) => p.opts.label === 'integration-setup'),
    'a parked plan must not create the worktree it never merges into')
  assert.deepEqual(result.implemented, [])
  assert.equal(result.coverage.complete, false)
  assert.match(result.coverage.unreached.join(' '), /plan_only/)
})

test('a parked plan that also has blocking gaps reports the gaps, not the parking', async () => {
  const { result } = await runWorkflow(WF, {
    args: { ...ARGS, plan_only: true },
    workflow: () => surveyResult(),
    agent: happyAgents({
      plan: plan([order("W1")], { blocking_gaps: ['the auth module was never searched'] }),
    }),
  })

  assert.equal(result.checkpoint.reason, 'blocking_gaps',
    'the caller asked to park; the planner found a reason the plan may not be worth resuming')
  assert.deepEqual(result.checkpoint.blocking_gaps, ['the auth module was never searched'])
  assert.match(result.coverage.unreached.join(' '), /confirmed_gaps true/)
})

test('an ordinary run carries no checkpoint at all', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    workflow: () => surveyResult(),
    agent: happyAgents({ plan: plan([order("W1")]) }),
  })

  assert.equal(result.checkpoint, null)
  assert.deepEqual(result.integration.merged, ['W1'])
})
// ---------------------------------------------------------------- knowledge feed-forward
//
// Coders report `discovered` — reusable commands, setup gotchas. It used to reach only the
// final result, so the one consumer who could act on it (the next coder, in this repository,
// minutes later) was the one who never saw it.
//
// `code:` is a PREFIX key and scriptedAgents takes the first match, so a per-order answer has
// to come from a function on that key rather than a more specific key added after it.

const promptFor = (prompts, label) =>
  (prompts.find((p) => p.opts.label === label) || { prompt: '' }).prompt

const coderSaying = (discoveries) => (prompt, opts) =>
  coded(discoveries[opts.label] ? { discovered: discoveries[opts.label] } : {})

test("a later wave's coder is told what earlier waves learned", async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { prompts } = await runWorkflow(WF, {
    args: ARGS,
    workflow: () => surveyResult(),
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2']]),
      'code:': coderSaying({ 'code:W1': ['run `npm run gen` after touching schema/'] }),
      'merge:': mergeSequence([M40, N40]),
    }),
  })

  const w2 = promptFor(prompts, 'code:W2')
  assert.match(w2, /run `npm run gen` after touching schema\//)
  assert.match(w2, /DISCOVERED EARLIER IN THIS RUN/)

  assert.ok(!promptFor(prompts, 'code:W1').includes('DISCOVERED EARLIER IN THIS RUN'),
    'the first wave has nothing to inherit, and an empty section is noise')
})

test('the verifier is never handed discovered commands', async () => {
  // The asymmetry is deliberate: a coder may act on hearsay and be caught by verification,
  // while verification is what every verdict is computed from. A wave-1 guess reaching a
  // wave-3 verifier would launder a report into a measurement.
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { prompts } = await runWorkflow(WF, {
    args: ARGS,
    workflow: () => surveyResult(),
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2']]),
      'code:': coderSaying({ 'code:W1': ['build with `make -j8`'] }),
      'merge:': mergeSequence([M40, N40]),
    }),
  })

  assert.match(promptFor(prompts, 'code:W2'), /make -j8/, 'the coder half must actually fire')

  for (const p of prompts.filter((x) => /^(verify|wave-verify):/.test(x.opts.label || ''))) {
    assert.ok(!p.prompt.includes('build with `make -j8`'),
      `${p.opts.label} was handed a coder's discovered command`)
  }
})

test('an escalated order teaches the next wave nothing', async () => {
  const orders = [order('W1'), order('W2')]
  const { prompts } = await runWorkflow(WF, {
    args: ARGS,
    workflow: () => surveyResult(),
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2']]),
      'code:': (prompt, opts) => (opts.label === 'code:W1'
        ? coded({ status: 'blocked', commits: [], discovered: ['use the vendored gcc'] })
        : coded()),
      'merge:': mergeSequence([M40, N40]),
    }),
  })

  assert.ok(!promptFor(prompts, 'code:W2').includes('use the vendored gcc'),
    "an escalated order's discoveries are unreviewed claims about a repo that rejected it")
})

test('a wave records what it learned, and a resume inherits it', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]

  // Recorded on the way out...
  const { prompts: writing } = await runWorkflow(WF, {
    args: ARGS,
    workflow: () => surveyResult(),
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2']]),
      'code:': coderSaying({ 'code:W1': ['the suite needs POSTGRES_URL set'] }),
      'merge:': mergeSequence([M40, N40]),
    }),
  })
  assert.ok(recordedLine(promptFor(writing, 'record:wave-1')).entry.discovered
    .some((d) => /POSTGRES_URL/.test(d)))

  // ...and read back on the way in.
  const { prompts: reading } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders, {
        state: [{ wave: 1, merged: ['W1'], approved_unmerged: [], escalated: [],
                  integration_base: A40, integration_head: M40,
                  discovered: ['the suite needs POSTGRES_URL set'] }],
      })),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  assert.match(promptFor(reading, 'code:W2'), /POSTGRES_URL/,
    'the wave after an interruption must not be the one wave that knows nothing')
})

// ---------------------------------------------------------------- the drift gate
//
// Within a run the tree cannot move under the plan — the workflow owns every tree it
// touches. Between invocations that lapses, and the multi-feature story is the lapse: plan
// A, implement and land B, resume A against a repository A's plan has never seen.

const drifted = (over = {}) => ({
  stop_reason: 'completed', user_head: N40, moved_files: [], notes: 'compared', ...over,
})

test('a resume whose tree held still costs one observation and proceeds', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { result, prompts } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders)),
      drift: drifted({ user_head: A40 }),   // exactly the anchor
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  assert.equal(result.checkpoint, null)
  assert.deepEqual(result.integration.merged, ['W2'])
  assert.equal(prompts.filter((p) => p.opts.label === 'drift').length, 1)
})

test('drift that misses every pending locus proceeds without a gate', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'], locus: ['src/W2.js'] })]
  const { result } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders)),
      drift: drifted({ moved_files: ['docs/README.md', 'src/unrelated.js'] }),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  assert.equal(result.checkpoint, null, 'someone else editing other files is not staleness')
  assert.deepEqual(result.integration.merged, ['W2'])
})

test('a pending order whose declared file moved holds the run at a gate', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'], locus: ['src/W2.js'] })]
  const { result, prompts } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders)),
      drift: drifted({ moved_files: ['src/W2.js'] }),
    }),
  })

  assert.equal(result.checkpoint.reason, 'stale')
  assert.deepEqual(result.checkpoint.stale, [{ id: 'W2', writes: ['src/W2.js'], reads: [] }])
  assert.ok(!prompts.some((p) => p.opts.label === 'integration-setup'),
    'a stale exit says nothing was dispatched, so it must not leave a worktree behind')
  assert.equal(result.coverage.complete, false)
})

test('an order already merged is not re-examined for staleness', async () => {
  // W1 merged in an earlier invocation. Its files moving is somebody else building on it.
  const orders = [order('W1', { locus: ['src/W1.js'] }), order('W2', { deps: ['W1'] })]
  const { result } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders)),
      drift: drifted({ moved_files: ['src/W1.js'] }),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  assert.equal(result.checkpoint, null)
  assert.deepEqual(result.integration.merged, ['W2'])
})

test('the caller clears some orders and the rest stay withheld, named', async () => {
  const orders = [
    order('W1'),
    order('W2', { deps: ['W1'], locus: ['src/W2.js'] }),
    order('W5', { deps: ['W1'], locus: ['src/W5.js'] }),
  ]
  const { result } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR, confirmed_stale: ['W2'] },
    workflow: () => surveyResult(),
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1'], ['W2', 'W5']]),
      ...resumeLoad(loaded(orders, {
        plan: { ...loadedPlan(orders),
                partition_raw: JSON.stringify({ waves: [['W1'], ['W2', 'W5']], coupled: [] }) },
      })),
      drift: drifted({ moved_files: ['src/W2.js', 'src/W5.js'] }),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  assert.equal(result.checkpoint, null, 'the human has ruled; the run proceeds')
  assert.deepEqual(result.implemented.map((e) => e.id), ['W2'])
  assert.match(result.coverage.unreached.join(' '), /W5: withheld as stale/)
  assert.ok(result.coverage.resumable.remaining.includes('W5'),
    'a withheld order is work left to do, so it must be resumable')
  assert.equal(result.coverage.complete, false)
})

test('an anchor git cannot resolve halts the whole resume', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const { result, prompts } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders)),
      drift: drifted({ stop_reason: 'anchor_unreachable', user_head: '', moved_files: [],
                       notes: "fatal: ambiguous argument 'master': unknown revision" }),
    }),
  })

  assert.equal(result.checkpoint.reason, 'stale')
  assert.ok(!prompts.some((p) => p.opts.label === 'integration-setup'))
  assert.match(result.coverage.unreached.join(' '), /can no longer be found/)
  assert.match(result.coverage.unreached.join(' '), /unknown revision/)
})

test('a fresh run never pays for a drift observation', async () => {
  const { prompts } = await runWorkflow(WF, {
    args: ARGS,
    workflow: () => surveyResult(),
    agent: happyAgents({ plan: plan([order('W1')]) }),
  })

  assert.ok(!prompts.some((p) => p.opts.label === 'drift'),
    'a run that surveyed the tree minutes ago cannot be stale against it')
})

test('the reviewer is charged with attacking the tests, not only the code', async () => {
  // The coder wrote both artefacts, so they encode one interpretation twice. The reviewer is
  // the only party in the pipeline that wrote neither.
  const { prompts } = await runWorkflow(WF, {
    args: ARGS,
    workflow: () => surveyResult(),
    agent: happyAgents({ plan: plan([order('W1')]) }),
  })

  const review = promptFor(prompts, 'review:W1#1')
  assert.match(review, /TESTS ARE PART OF WHAT YOU ARE ATTACKING/)
  assert.match(review, /wrote neither/)
  assert.match(review, /criterion whose tests could not fail/)
})

// ---------------------------------------------------------------- drift in what an order READS
//
// AP-6. The gate above intersects moved files with each pending order's `locus` — the files
// it will WRITE. What an order builds against is invisible to that: a type it calls, a module
// its context describes, an interface it implements. Those live in files it never touches, so
// the intersection is empty and the order sails through against a description of a world that
// changed underneath it.
//
// The fix is not a re-survey. The planner already knows these files — it wrote the context out
// of survey evidence that named them — it simply never recorded them. `reads` records them.

const reader = (id, reads, over = {}) =>
  order(id, { reads, ...over })

test('a pending order whose read dependency moved is a stale suspect', async () => {
  const orders = [order('W1'), reader('W2', ['src/auth/token.js'], { deps: ['W1'] })]
  const { result } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders)),
      // W2 writes src/W2.js, which nobody touched. It READS the token module, which moved.
      drift: drifted({ moved_files: ['src/auth/token.js'] }),
    }),
  })

  assert.equal(result.checkpoint.reason, 'stale',
    'the order builds against a file that changed; its locus was never the question')
  assert.deepEqual(result.checkpoint.stale.map((s) => s.id), ['W2'])
})

test('the checkpoint says whether an order owns the moved file or depends on it', async () => {
  // Different rulings follow. A file you own moving may only need rebasing; a dependency
  // moving can invalidate the approach the context describes.
  const orders = [
    order('W1'),
    order('W2', { deps: ['W1'], locus: ['src/W2.js'] }),
    reader('W3', ['src/auth/token.js'], { deps: ['W1'], locus: ['src/W3.js'] }),
  ]
  const { result } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders, {
        plan: { ...loadedPlan(orders),
                partition_raw: JSON.stringify({ waves: [['W1'], ['W2', 'W3']], coupled: [] }) },
      })),
      drift: drifted({ moved_files: ['src/W2.js', 'src/auth/token.js'] }),
    }),
  })

  const byId = Object.fromEntries(result.checkpoint.stale.map((s) => [s.id, s]))
  assert.deepEqual(byId.W2.writes, ['src/W2.js'])
  assert.deepEqual(byId.W2.reads, [])
  assert.deepEqual(byId.W3.writes, [])
  assert.deepEqual(byId.W3.reads, ['src/auth/token.js'])
})

test('reads is not a licence to write: the verifier fence is still the locus', async () => {
  const orders = [reader('W1', ['src/auth/token.js'], { locus: ['src/W1.js'] })]
  const { prompts } = await runWorkflow(WF, {
    args: ARGS,
    workflow: () => surveyResult(),
    agent: happyAgents({ plan: plan(orders) }),
  })

  const verify = promptFor(prompts, 'verify:W1')
  assert.match(verify, /--locus "src\/W1\.js"/)
  assert.ok(!verify.includes('--locus "src/auth/token.js"'),
    'widening the commit-series fence to read dependencies would let an order edit them')
})

test('the coder is shown its read dependencies without being allowed to touch them', async () => {
  const orders = [reader('W1', ['src/auth/token.js'], { locus: ['src/W1.js'] })]
  const { prompts } = await runWorkflow(WF, {
    args: ARGS,
    workflow: () => surveyResult(),
    agent: happyAgents({ plan: plan(orders) }),
  })

  const code = promptFor(prompts, 'code:W1')
  assert.match(code, /src\/auth\/token\.js/)
  assert.match(code, /read|depend/i)
})

test('an order that reads nothing behaves exactly as before', async () => {
  const { result } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded([order('W1'), order('W2', { deps: ['W1'] })])),
      drift: drifted({ moved_files: ['docs/README.md'] }),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  assert.equal(result.checkpoint, null)
  assert.deepEqual(result.integration.merged, ['W2'])
})

test('a read-drift suspect is cleared by the same per-order confirmation', async () => {
  const orders = [order('W1'), reader('W2', ['src/auth/token.js'], { deps: ['W1'] })]
  const { result } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR, confirmed_stale: ['W2'] },
    workflow: () => surveyResult(),
    agent: happyAgents({
      ...resumeLoad(loaded(orders)),
      drift: drifted({ moved_files: ['src/auth/token.js'] }),
      'integration-setup': setUp({ head_sha: M40 }),
      'merge:': merged(N40),
    }),
  })

  assert.equal(result.checkpoint, null)
  assert.deepEqual(result.implemented.map((e) => e.id), ['W2'])
})

test('the planner is told to declare what each order reads', async () => {
  const { prompts } = await runWorkflow(WF, {
    args: ARGS,
    workflow: () => surveyResult(),
    agent: happyAgents(),
  })

  const p = promptFor(prompts, 'plan')
  assert.match(p, /\breads\b/)
  assert.match(p, /does not modify|never modif|without modifying/i)
})

// --- the progress ledger --------------------------------------------------------------
//
// The only channel this script has to the session while it runs, because `phase()` cannot
// carry a wave number: meta.phases is a pure literal, so every title in it is fixed, and all
// of a run's waves land in the same `Implement` box. A session watching a twelve-order run
// could see agents start and finish and still not tell wave 1 from wave 4.
//
// What is pinned is that the lines are DERIVED from the sets the result reports, not narrated
// separately. A ledger that can disagree with the result it accompanies is worse than none:
// the reader believes the running commentary and finds out at the end that it was wrong.

const ledgerLines = (logs, caption) => {
  const start = logs.findIndex((l) => l.startsWith(caption))
  if (start === -1) return []
  const rest = logs.slice(start + 1)
  const end = rest.findIndex((l) => !l.startsWith('  '))
  return rest.slice(0, end === -1 ? rest.length : end).map((l) => l.trim())
}

test('the whole order list is reported before the first wave is dispatched', async () => {
  const orders = [order('W1'), order('W2', { deps: ['W1'] }), order('W3')]
  const { logs } = await run({
    agent: happyAgents({ plan: wavedPlan(orders, [['W1'], ['W2', 'W3']]) }),
  })

  const opening = logs.findIndex((l) => l.startsWith('Plan — '))
  const firstDispatch = logs.findIndex((l) => l.startsWith('Wave 1 of 2:'))

  assert.ok(opening !== -1, 'no opening ledger: the run never says what it is about to do')
  assert.ok(opening < firstDispatch, 'the list arrives after the work it lists has started')
  assert.match(logs[opening], /0 of 3 waved order\(s\) merged/)
  assert.deepEqual(ledgerLines(logs, 'Plan — '), ['not started: W1 W2 W3'])
})

test('each order moves buckets as it settles, and the tally moves with it', async () => {
  const orders = [order('W1'), order('W2'), order('W3')]
  const { logs, result } = await run({
    agent: happyAgents({
      plan: wavedPlan(orders, [['W1', 'W2'], ['W3']]),
      'verify:': (prompt) => prompt.includes('WORK ORDER W2')
        ? verified({ build: 'failed' })
        : verified(),
      'fix:': coded({ status: 'blocked', commits: [], summary: 'cannot fix' }),
    }),
  })

  assert.deepEqual(ledgerLines(logs, 'After wave 1 of 2'), ['merged: W1', 'escalated: W2', 'not started: W3'])
  // The point of the whole thing: what the running commentary said and what the result says
  // are the same sets, so a reader who acted on the log was not misled by it.
  assert.deepEqual(result.integration.merged, ['W1', 'W3'])
  assert.deepEqual(result.escalations.map((e) => e.id), ['W2'])
})

test('coupled orders are named apart, never inside the waved denominator', async () => {
  // They go to the session; this loop never touches them. Counting them here would report
  // every run with a coupled order as permanently short of a total it cannot reach.
  const orders = [order('W1'), order('W2')]
  const { logs } = await run({
    agent: happyAgents({
      plan: plan(orders, { partition_raw: JSON.stringify({ waves: [['W1']], coupled: ['W2'] }) }),
    }),
  })

  assert.match(logs.find((l) => l.startsWith('Plan — ')), /of 1 waved order\(s\)/)
  assert.ok(ledgerLines(logs, 'Plan — ').includes('routed to the session, not run here: W2'))
})
