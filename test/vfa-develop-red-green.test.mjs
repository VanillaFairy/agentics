// test/vfa-develop-red-green.test.mjs — the RED/GREEN work-order split.
//
// A work order may declare `role: 'red' | 'green'`. A RED order lands tests that MUST fail —
// that is its entire purpose — so the ordinary verification verdict, which treats a failing
// suite as a defect, would spiral it through fix rounds forever. A GREEN order implements
// against those tests and cannot touch them, because they are outside its declared locus and
// lib/commit-series.mjs already blocks any commit that reaches outside one.
//
// The separation itself is free: `deps` waves GREEN after RED, and the locus fence is the
// same fence every order already stands behind. What is NOT free, and what this file pins, is
// that a red order's success condition is inverted in four specific ways — and that a wave
// whose merged head is knowingly red is distinguished from one that is merely broken.
//
// Written before the implementation. Every assertion here failed first.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carriedChain, carriedPayload, runWorkflow, scriptedAgents } from './harness/workflow-host.mjs'
import { resumeVerdict } from './harness/resume-fixture.mjs'
import { manifestOf } from '../lib/plan-digest.mjs'
import { digestEntry } from '../lib/ledger.mjs'

/**
 * Expand a plan-and-ledger fixture into the ONE dispatch surface a resume has: the
 * 'resume-verdict' answer, carrying `lib/run-verdict.mjs`'s stdout and its digest. The fan of
 * per-order loaders this used to feed is gone; the orders are read off disk by the agents that
 * consume them.
 */
const resumeLoad = resumeVerdict


const WF = fileURLToPath(new URL('../workflows/vfa-develop.workflow.js', import.meta.url))

const A40 = 'a'.repeat(40)
const B40 = 'b'.repeat(40)
const M40 = 'e'.repeat(40)
const N40 = 'f'.repeat(40)

const RUN_DIR = 'C:/repo/.claude/vfa/runs/20260816-143005'
// These scenarios pin the per-order review loop, so they ask for it on every order; the default,
// which reviews only yardstick orders per order, is pinned in vfa-develop-review-scope.
const ARGS = { change: 'add the widget', roots: '.', plugin_root: 'C:/plugin', review_every_order: true }

// A red/green pair: R1 owns the test file, G1 owns the implementation and depends on R1.
const RED = {
  id: 'R1', title: 'author the widget tests', role: 'red',
  locus: ['test/widget.test.js'], acceptance: ['a failing test pins the widget contract'],
  context: 'ctx', deps: [], contract: false,
}

const GREEN = {
  id: 'G1', title: 'implement the widget', role: 'green',
  locus: ['src/widget.js'], acceptance: ['the widget tests pass'],
  context: 'ctx', deps: ['R1'], contract: false,
}

const plainOrder = (id, over = {}) => ({
  id, title: 'do ' + id, role: 'none', locus: ['src/' + id + '.js'],
  acceptance: ['builds'], context: 'ctx', deps: [], contract: false, ...over,
})

const pairPlan = (orders = [RED, GREEN], waves = [['R1'], ['G1']]) => ({
  work_orders: orders,
  shared_files: [],
  partition_raw: JSON.stringify({ waves, coupled: [] }),
  blocking_gaps: [],
  plan_path: RUN_DIR,
  notes: '',
})

const coded = (over = {}) => ({
  status: 'done', worktree: 'C:/wt/x', branch: 'wo-x', base_sha: A40, head_sha: B40,
  commits: [{ sha: B40, subject: 'test: widget' }], concerns: [], discovered: [], summary: 's',
  ...over,
})

/**
 * An ordinary green verification: everything passes and the new test discriminates.
 *
 * Wrapped as a carried payload, because a verify dispatch answers with lib/verify.mjs's stdout
 * now. The measurement a scenario writes is unchanged; only the trip around it is.
 */
const verified = (over = {}) => carriedPayload({
  stop_reason: 'completed', build: 'passed', suite: 'passed', suite_output_tail: 'ok',
  discriminator: [{ test_id: 'src/G1.js', failed_on_base: true, passes_now: true }],
  failing_tests: [], series_findings: [], notes: 'ran node --test', ...over,
})

/**
 * A correct RED verification: the suite fails, every failure is in the order's own test file,
 * and the new tests fail now as well as at base — they pin behaviour nobody has built.
 */
const redVerified = (over = {}) => verified({
  suite: 'failed',
  suite_output_tail: '1 failing',
  discriminator: [{ test_id: 'test/widget.test.js', failed_on_base: true, passes_now: false }],
  failing_tests: [{ file: 'test/widget.test.js', id: 'widget > rejects an empty label' }],
  ...over,
})

const setUp = (over = {}) => ({
  stop_reason: 'completed', worktree: 'C:/repo/.claude/worktrees/x',
  branch: 'vfa/20260816-143005-integration', head_sha: A40, notes: 'created', ...over,
})

const merged = (sha = M40, over = {}) => ({
  stop_reason: 'completed', merged_sha: sha, conflicts: [], notes: 'merged', ...over,
})

const mergeSequence = (shas) => {
  let i = 0
  return () => merged(shas[Math.min(i++, shas.length - 1)])
}

const recorded = () => ({ stop_reason: 'recorded', path: RUN_DIR, notes: 'appended' })
const reviewed = (over = {}) => ({ findings: [], fix_verdicts: [], ...over })

/**
 * Verifier answers routed by label. `verify:` is a PREFIX key and scriptedAgents takes the
 * first entry that matches, so per-order answers come from a function on that one key.
 */
const verifierSaying = (byLabel, fallback = verified()) =>
  (prompt, opts, n) => {
    const entry = byLabel[opts.label]
    const value = entry === undefined ? fallback : entry
    return typeof value === 'function' ? value(prompt, opts, n) : value
  }

const cast = (over = {}) => scriptedAgents({
  'existing-runs': { stop_reason: 'observed', runs: [], notes: 'no runs directory' },
  plan: pairPlan(),
  drift: { stop_reason: 'completed', user_head: A40, moved_files: [], notes: 'unchanged' },
  'integration-setup': setUp(),
  'merge:': merged(),
  'wave-verify:': verified({ discriminator: [], suite: 'passed' }),
  'record:': recorded(),
  'kb-chain': carriedChain(),
  'kb-write': { stop_reason: 'recorded', path: '.claude/vfa/kb', notes: 'appended' },
  'review:integration': reviewed(),
  ...over,
  'code:': over['code:'] || coded(),
  'verify:': over['verify:'] || verified(),
  'fix:': over['fix:'] || coded(),
  'review:': over['review:'] || reviewed(),
})

const run = (over = {}, args = ARGS) =>
  runWorkflow(WF, { args, workflow: () => ({ coverage: { complete: true, dropped: [],
    incomplete: [], failed_channels: [], unreached: [], resumable: { runId: 'r', remaining: [] } } }),
  agent: cast(over) })

const promptFor = (prompts, label) =>
  (prompts.find((p) => p.opts.label === label) || { prompt: '' }).prompt

// --- the inverted verdict ------------------------------------------------------------------

test('a red order whose tests fail in its own files is verified, not sent to a fix round',
  async () => {
    const { result, prompts } = await run({
      'verify:': verifierSaying({ 'verify:R1': redVerified() }),
      'merge:': mergeSequence([M40, N40]),
    })

    assert.ok(!prompts.some((p) => p.opts.label === 'fix:R1'),
      'a red order landing failing tests has done exactly its job')
    assert.deepEqual(result.implemented.map((e) => e.id), ['R1', 'G1'])
    assert.deepEqual(result.escalations, [])
  })

test('a red order whose suite passes has pinned nothing and is not verified', async () => {
  // The whole point of a red order is a test that fails for want of an implementation. A
  // green suite means the tests assert something that was already true.
  const { result, prompts } = await run({
    'verify:': verifierSaying({
      'verify:R1': redVerified({ suite: 'passed', failing_tests: [],
                                 discriminator: [{ test_id: 'test/widget.test.js',
                                                   failed_on_base: false, passes_now: true }] }),
    }),
    'fix:': coded({ commits: [], head_sha: A40 }),
  })

  assert.ok(prompts.some((p) => p.opts.label === 'fix:R1'), 'it must draw a fix round')
  assert.ok(result.escalations.some((e) => e.id === 'R1'))
  assert.equal(result.coverage.complete, false)
})

test('a red order that added no test at all is not verified', async () => {
  const { result } = await run({
    'verify:': verifierSaying({ 'verify:R1': redVerified({ discriminator: [] }) }),
    'fix:': coded({ commits: [], head_sha: A40 }),
  })

  assert.ok(result.escalations.some((e) => e.id === 'R1'),
    'a red order is its tests; without one it produced nothing')
})

test('a red order that broke something outside its own tests is not verified', async () => {
  const { result } = await run({
    'verify:': verifierSaying({
      'verify:R1': redVerified({
        failing_tests: [
          { file: 'test/widget.test.js', id: 'widget > rejects an empty label' },
          { file: 'test/unrelated.test.js', id: 'auth > signs a token' },
        ],
      }),
    }),
    'fix:': coded({ commits: [], head_sha: A40 }),
  })

  assert.ok(result.escalations.some((e) => e.id === 'R1'),
    'a failure outside the declared tests is collateral damage, not the point of the order')
})

test('a red order still has to build', async () => {
  const { result } = await run({
    'verify:': verifierSaying({ 'verify:R1': redVerified({ build: 'failed' }) }),
    'fix:': coded({ commits: [], head_sha: A40 }),
  })

  assert.ok(result.escalations.some((e) => e.id === 'R1'))
})

test('an ordinary order is unaffected by any of this', async () => {
  const { result } = await run({
    plan: pairPlan([plainOrder('W1')], [['W1']]),
    'verify:': verifierSaying({
      'verify:W1': verified({ discriminator: [{ test_id: 't', failed_on_base: true, passes_now: true }] }),
    }),
  })

  assert.deepEqual(result.implemented.map((e) => e.id), ['W1'])
  assert.equal(result.coverage.complete, true)
})

test('a green order is verified the ordinary way — its tests must pass', async () => {
  const { result } = await run({
    'verify:': verifierSaying({
      'verify:R1': redVerified(),
      'verify:G1': verified({ suite: 'failed', failing_tests: [
        { file: 'test/widget.test.js', id: 'widget > rejects an empty label' }] }),
    }),
    'fix:': coded({ commits: [], head_sha: A40 }),
    'merge:': mergeSequence([M40, N40]),
  })

  assert.ok(result.escalations.some((e) => e.id === 'G1'),
    'the red tests still failing after the green order is the green order failing')
})

// --- the cycle merges as a unit --------------------------------------------------------------

test('a red order is held rather than merged, and lands with its green', async () => {
  const { result, logs } = await run({
    'verify:': verifierSaying({ 'verify:R1': redVerified() }),
    'merge:': mergeSequence([M40, N40]),
  })

  assert.deepEqual(result.integration.merged, ['R1', 'G1'],
    'both are in the integration branch once the pair closes')
  assert.deepEqual(result.escalations, [])
  assert.ok(logs.some((l) => /HELD R1/.test(l)),
    'and the hold is stated rather than silent — a wave that merges nothing must say why')
  assert.deepEqual(result.integration.approved_unmerged, [],
    'a held order that later lands is no longer approved-and-unmerged')
})

test('the green coder is anchored on its red\'s branch, not on the integration head', async () => {
  const { prompts } = await run({
    'verify:': verifierSaying({ 'verify:R1': redVerified() }),
    'merge:': mergeSequence([M40, N40]),
  })

  const green = promptFor(prompts, 'code:G1')
  assert.match(green, new RegExp('git checkout -B \\S+ ' + B40),
    'it builds on the head R1 left, which is where the tests it implements actually are')
  assert.ok(!green.includes(M40),
    'the integration head is not its base — that tree does not carry its tests')
})

test('a red whose green never lands is reported unmerged, not merged alone', async () => {
  // The honest end state when a pair does not close. Merging the red on its own would put a
  // failing test in the integration branch with nothing to satisfy it, and would leave the
  // branch unusable for everything downstream.
  const { result } = await run({
    'verify:': verifierSaying({
      'verify:R1': redVerified(),
      'verify:G1': verified({ suite: 'failed', failing_tests: [
        { file: 'test/widget.test.js', id: 'widget > rejects an empty label' }] }),
    }),
    'fix:': coded({ commits: [], head_sha: A40 }),
  })

  assert.ok(result.escalations.some((e) => e.id === 'G1'))
  assert.deepEqual(result.integration.merged, [], 'nothing reached the integration branch')
  assert.deepEqual(result.integration.approved_unmerged, ['R1'],
    'R1 is finished work that is deliberately not merged, and a human is told exactly that')
  assert.equal(result.coverage.complete, false)
})

// --- the knowingly-red integration head, which only a legacy resume can still produce ---------
//
// Before the cycle hold, a red merged on its own and the integration head between waves was
// red by design. A run PLANNED under that behaviour and resumed under this one still has those
// merges in its branch — run 20260829-140744 is exactly such a run — so the excuse that lets a
// pending red's failures past wave verification has to survive for it. What this run will not
// do is create the state: the two cases below reach it only through a resumed ledger.

const RESUMED = 'C:/repo/.claude/vfa/runs/20260816-143005'

/** A ledger from a pre-hold invocation: R1 merged alone, G1 still to build. */
const legacyRedMerged = (over = {}) => resumeLoad({
  stop_reason: 'loaded',
  plan: pairPlan(),
  envelope: { change: 'add the widget', roots: '.', caller_notes: '', intelligence: 'normal',
              base_branch: 'master', base_sha: A40, programme: '', slice: '' },
  state: [{
    kind: 'wave', seq: 0, wave: 1, merged: ['R1'], approved_unmerged: [], escalated: [],
    discovered: [], integration_base: A40, integration_head: M40, order: '', branch: '',
    worktree: '', head_sha: '',
  }],
  notes: 'loaded',
  ...over,
})

const runResumed = (over = {}) =>
  runWorkflow(WF, {
    args: { ...ARGS, resume_path: RESUMED },
    workflow: () => ({ coverage: { complete: true, dropped: [], incomplete: [],
      failed_channels: [], unreached: [], resumable: { runId: 'r', remaining: [] } } }),
    agent: cast({ ...legacyRedMerged(), ...over }),
  })

test('a resumed run whose red already merged alone does not stop on its tests', async () => {
  const { result } = await runResumed({
    'wave-verify:': verifierSaying({
      'wave-verify:2': verified({
        discriminator: [], suite: 'failed',
        failing_tests: [{ file: 'test/widget.test.js', id: 'widget > rejects an empty label' }],
      }),
    }),
  })

  assert.deepEqual(result.escalations, [],
    'the head is red because a previous invocation merged R1 alone, not because G1 is wrong')
})

test('a resumed run does not re-escalate the green its old head is poisoning', async () => {
  // The whole point of keeping the excuse. R1 is in the integration branch on its own because
  // a pre-hold invocation put it there, so G1 is coded and measured in a tree whose suite fails
  // on R1's tests until the moment G1 satisfies them — and a verifier that runs the suite while
  // ANOTHER pair's red is also sitting in that head reports those failures against G1.
  //
  // Escalating for them is exactly what run 20260829-140744 did to five orders of correct work.
  // Doing it again on the resume of that same run would be the same mistake twice.
  const { result, prompts } = await runResumed({
    'verify:': verifierSaying({
      'verify:G1': verified({
        suite: 'failed',
        failing_tests: [{ file: 'test/widget.test.js', id: 'widget > rejects an empty label' }],
      }),
    }),
  })

  assert.ok(!prompts.some((p) => p.opts.label === 'fix:G1'),
    'the failing tests belong to a pair a previous invocation half-merged, not to G1')
  assert.deepEqual(result.escalations, [])
  assert.ok(result.integration.merged.includes('G1'))
})

test('a resumed run still stops when the head fails outside the pending red set', async () => {
  const { result } = await runResumed({
    'wave-verify:': verifierSaying({
      'wave-verify:2': verified({
        discriminator: [], suite: 'failed',
        failing_tests: [
          { file: 'test/widget.test.js', id: 'widget > rejects an empty label' },
          { file: 'test/auth.test.js', id: 'auth > signs a token' },
        ],
      }),
    }),
  })

  assert.equal(result.integration.merge_stopped_at === null, true)
  assert.equal(result.coverage.complete, false,
    'a failure outside the pending red set is the merge breaking something')
})

test('once the green has landed, its red tests are no longer excused', async () => {
  // Both orders in the branch. A suite still failing on the red tests now means the
  // implementation does not satisfy them, which is the defect the pair existed to surface.
  const { result } = await run({
    'verify:': verifierSaying({ 'verify:R1': redVerified() }),
    'wave-verify:': verifierSaying({
      'wave-verify:2': verified({
        discriminator: [], suite: 'failed',
        failing_tests: [{ file: 'test/widget.test.js', id: 'widget > rejects an empty label' }],
      }),
    }),
    'merge:': mergeSequence([M40, N40]),
  })

  assert.ok(result.coverage.complete === false,
    'after the green lands, a red test still failing is the pair having failed')
})

// --- the dispatch side ----------------------------------------------------------------------

test('the red coder is told to write failing tests and not to implement', async () => {
  const { prompts } = await run({
    'verify:': verifierSaying({ 'verify:R1': redVerified() }),
    'merge:': mergeSequence([M40, N40]),
  })

  const red = promptFor(prompts, 'code:R1')
  assert.match(red, /must fail/i)
  assert.match(red, /do not implement/i)
})

test('the green coder is told the tests are locked and outside its fence', async () => {
  const { prompts } = await run({
    'verify:': verifierSaying({ 'verify:R1': redVerified() }),
    'merge:': mergeSequence([M40, N40]),
  })

  const green = promptFor(prompts, 'code:G1')
  assert.match(green, /locked/i)
  assert.match(green, /escalate/i)
})

test('the red order is measured against its own declared locus, by the check runner', async () => {
  // Which tests failed, by FILE, used to be an instruction in this prompt. It is a script now —
  // lib/verify.mjs places every failure against a real test file and test/verify.test.mjs pins
  // that it does. What still has to be true HERE is that the runner is pointed at this order's
  // fence: the red verdict asks whether every failure sits inside the locus, and a dispatch that
  // named the wrong one would answer a different question convincingly.
  const { prompts } = await run({
    'verify:': verifierSaying({ 'verify:R1': redVerified() }),
    'merge:': mergeSequence([M40, N40]),
  })

  const red = promptFor(prompts, 'verify:R1')
  assert.match(red, /lib\/verify\.mjs/)
  assert.match(red, /--locus "test\/widget\.test\.js"/)
  assert.ok(!red.includes('--locus "src/widget.js"'),
    "the green order's files are not the fence a red order's failures are placed against")
})

test('the planner is told when to split a behaviour into a pair', async () => {
  const { prompts } = await run()
  const plan = promptFor(prompts, 'plan')

  assert.match(plan, /\brole\b/)
  assert.match(plan, /red/)
  assert.match(plan, /green/)
})

// --- the digest, which both sides must compute identically ------------------------------------

test('a role-bearing order reaches its coder under the digest the library recorded', async () => {
  // lib/plan-digest.mjs and lib/run-verdict.mjs must agree about how `role` digests, or every
  // resume of a plan containing a pair breaks.
  //
  // Where that breakage LANDS moved in 0.17.0 and the assertion moved with it. The plan no
  // longer travels through a courier to be re-checked against a carried manifest in-script;
  // the verdict CLI computes each order's digest off the same disk the plan sits on, the
  // workflow quotes that number in the coder's dispatch, and the coder fetches the order with
  // `ledger.mjs order` and refuses to implement anything whose digest does not read exactly
  // that. So the number the coder is told to confirm is the thing worth pinning: if the two
  // implementations of the conditional `role` treatment ever diverge, every coder on a
  // red/green plan stops dead holding an order it is not allowed to build.
  const orders = [RED, GREEN]
  const recorded = new Map(manifestOf(orders).map((entry) => [entry.id, entry.digest]))

  const { result, prompts } = await runWorkflow(WF, {
    args: { ...ARGS, resume_path: RUN_DIR },
    workflow: () => ({ coverage: { complete: true, dropped: [], incomplete: [],
      failed_channels: [], unreached: [], resumable: { runId: 'r', remaining: [] } } }),
    agent: cast({
      ...resumeLoad({
        stop_reason: 'loaded',
        plan: pairPlan(orders),
        envelope: { change: 'add the widget', roots: '.', caller_notes: '',
                    intelligence: 'normal', base_branch: 'master', base_sha: A40 },
        state: [],
        notes: 'loaded',
      }),
      'verify:': verifierSaying({ 'verify:R1': redVerified() }),
      'merge:': mergeSequence([M40, N40]),
    }),
  })

  for (const id of ['R1', 'G1']) {
    const sent = promptFor(prompts, 'code:' + id)
    assert.match(sent, /CONFIRM that digest reads exactly/,
      'a resumed order is fetched from disk under a pin, never quoted into the prompt')
    assert.ok(sent.includes(recorded.get(id)),
      id + ': the coder is told to confirm ' + recorded.get(id) +
      ', the digest lib/plan-digest.mjs computed for the same order')
  }

  assert.deepEqual(result.implemented.map((e) => e.id), ['R1', 'G1'],
    'and the pair runs through to the end on those digests')
})

test('a plan written before roles existed still matches its stored manifest', async () => {
  // Backward compatibility is the reason `role: 'none'` must not enter the digest: manifests
  // already on disk were computed without the field, and a plan that halts on a false
  // mismatch is indistinguishable from one that was actually corrupted.
  const legacy = [{ id: 'W1', title: 'do W1', locus: ['src/W1.js'], acceptance: ['builds'],
                    context: 'ctx', deps: [], contract: false }]
  const legacyManifest = manifestOf(legacy)

  const withDefault = legacy.map((o) => ({ ...o, role: 'none' }))
  assert.deepEqual(manifestOf(withDefault), legacyManifest,
    "an explicit 'none' and an absent role are the same order")
})

// --- the third phase ------------------------------------------------------------------------
//
// REFACTOR completes the cycle. It restructures implementation with the tests locked and
// green: it adds no tests, changes no behaviour, and its locus excludes every test file, so
// lib/commit-series.mjs blocks it from touching one. Its verdict inverts in one specific way
// that matters — for an ordinary order an absent suite is a repo-state fact, but a refactor
// whose suite never ran is an unverified rewrite with nothing underneath it.

const REFACTOR = {
  id: 'F1', title: 'extract the widget validator', role: 'refactor',
  locus: ['src/widget.js'], acceptance: ['the widget tests still pass'],
  context: 'ctx', deps: ['G1'], contract: false,
}

const triadPlan = () => pairPlan([RED, GREEN, REFACTOR], [['R1'], ['G1'], ['F1']])

test('a refactor order with a green suite and no new tests is verified', async () => {
  const { result } = await run({
    plan: triadPlan(),
    'verify:': verifierSaying({
      'verify:R1': redVerified(),
      'verify:F1': verified({ discriminator: [], suite: 'passed' }),
    }),
    'merge:': mergeSequence([M40, N40, B40]),
  })

  assert.deepEqual(result.implemented.map((e) => e.id), ['R1', 'G1', 'F1'])
  assert.deepEqual(result.escalations, [])
})

test('a refactor whose suite never ran is an unverified rewrite', async () => {
  // The one place `absent` is not an acceptable answer. Everywhere else in this pipeline a
  // repository with no suite is a fact about the repository; here it means the safety net
  // the entire order depends on was never observed.
  const { result } = await run({
    plan: triadPlan(),
    'verify:': verifierSaying({
      'verify:R1': redVerified(),
      'verify:F1': verified({ discriminator: [], suite: 'absent' }),
    }),
    'fix:': coded({ commits: [], head_sha: A40 }),
    'merge:': mergeSequence([M40, N40, B40]),
  })

  assert.ok(result.escalations.some((e) => e.id === 'F1'),
    'a restructuring nothing checked is not a verified refactor')
})

test('a refactor that added a discriminating test is not a refactor', async () => {
  const { result } = await run({
    plan: triadPlan(),
    'verify:': verifierSaying({
      'verify:R1': redVerified(),
      'verify:F1': verified({
        discriminator: [{ test_id: 'test/new.test.js', failed_on_base: true, passes_now: true }],
      }),
    }),
    'fix:': coded({ commits: [], head_sha: A40 }),
    'merge:': mergeSequence([M40, N40, B40]),
  })

  assert.ok(result.escalations.some((e) => e.id === 'F1'),
    'new behaviour pinned by a new test is a green order wearing a refactor label')
})

test('the refactor coder is told to change no behaviour and add no tests', async () => {
  const { prompts } = await run({
    plan: triadPlan(),
    'verify:': verifierSaying({
      'verify:R1': redVerified(),
      'verify:F1': verified({ discriminator: [], suite: 'passed' }),
    }),
    'merge:': mergeSequence([M40, N40, B40]),
  })

  const f = promptFor(prompts, 'code:F1')
  assert.match(f, /no behaviour change|change no behaviour/i)
  assert.match(f, /add no test|do not add/i)
})

// --- the reviewer's charge follows the role -------------------------------------------------

test('the green order\'s reviewer is not told the author wrote its own tests', async () => {
  // For an ordinary order that premise is true and it is the whole point of the charge. For a
  // green order it is false — a separate agent authored the tests without seeing this code —
  // and a reviewer sent hunting a collusion that did not happen spends the round there while
  // the real risk, a contortion around an over-specified locked test, goes unexamined.
  const { prompts } = await run({
    'verify:': verifierSaying({ 'verify:R1': redVerified() }),
    'merge:': mergeSequence([M40, N40]),
  })

  const green = promptFor(prompts, 'review:G1#1')
  assert.match(green, /WRITTEN BY SOMEONE ELSE/)
  assert.match(green, /over-specified/)
  assert.ok(!green.includes('wrote its tests'),
    'the ordinary premise is false here and must not be asserted')
})

test('the refactor reviewer attacks the no-behaviour-change claim', async () => {
  const { prompts } = await run({
    plan: triadPlan(),
    'verify:': verifierSaying({
      'verify:R1': redVerified(),
      'verify:F1': verified({ discriminator: [], suite: 'passed' }),
    }),
    'merge:': mergeSequence([M40, N40, B40]),
  })

  const f = promptFor(prompts, 'review:F1#1')
  assert.match(f, /CHANGE NO BEHAVIOUR/i)
  assert.match(f, /untested margin/)
})

test('an ordinary order keeps the original charge', async () => {
  const { prompts } = await run({
    plan: pairPlan([plainOrder('W1')], [['W1']]),
    'verify:': verifierSaying({
      'verify:W1': verified({ discriminator: [{ test_id: 't', failed_on_base: true, passes_now: true }] }),
    }),
  })

  assert.match(promptFor(prompts, 'review:W1#1'), /wrote its tests/)
})

// --- TWO pairs: the state that poisoned a field run ------------------------------------------
//
// Everything above this line uses ONE red/green pair, and with one pair the defect below is
// invisible: the only red test in the tree belongs to the only green order, which implements it,
// so the suite the green is measured against comes back clean.
//
// Add a second pair and the arithmetic changes completely. The partition packs file-disjoint
// reds into the same wave, so R1 and R2 both merge into the integration head; every wave-2 order
// then branches from a head carrying BOTH red test files. G1 implements R1 and is measured on a
// suite still failing R2's tests — which are not its own, not in its locus, and not its to fix.
// Its verification fails, a fix round opens, the coder correctly answers "these are not my
// tests, there is nothing here to change", and returning no commits escalates it.
//
// That is not a hypothetical. Run 20260829-140744 in the field (2026-08-29, 22 orders) escalated
// five orders this way and left thirteen more blocked behind them, having merged nothing but the
// test halves of pairs whose implementations were all correct: merged by hand afterwards, the
// same commits passed 1154/1154. The pipeline rejected finished work for a scheduling reason.
//
// The fixture below models the WORLD rather than the fix — `redTestsIn` answers "which red test
// files does the tree this order is being verified in actually contain", derived from what has
// been merged into the integration head at the moment of the dispatch. Any implementation that
// stops a lone red from reaching that head satisfies it; nothing here pins how.

const RED2 = {
  id: 'R2', title: 'author the gadget tests', role: 'red',
  locus: ['test/gadget.test.js'], acceptance: ['a failing test pins the gadget contract'],
  context: 'ctx', deps: [], contract: false,
}

const GREEN2 = {
  id: 'G2', title: 'implement the gadget', role: 'green',
  locus: ['src/gadget.js'], acceptance: ['the gadget tests pass'],
  context: 'ctx', deps: ['R2'], contract: false,
}

const REDS = { R1: 'test/widget.test.js', R2: 'test/gadget.test.js' }
const IMPLEMENTS = { G1: 'R1', G2: 'R2' }

const twoPairPlan = () =>
  pairPlan([RED, RED2, GREEN, GREEN2], [['R1', 'R2'], ['G1', 'G2']])

/**
 * A scripted world for two pairs, standing in for the repository the agents would really see.
 *
 * `mergedIds` grows as the workflow merges branches — the fake's only input, and the same fact
 * a real tree would carry. A green order is verified against its own branch stacked on whatever
 * the workflow gave it as a base, so the red tests present in that tree are: its own red's (which
 * it has just implemented, so they pass) plus every OTHER red already sitting in the integration
 * head it was told to anchor on (which nobody has implemented, so they fail).
 */
function twoPairWorld() {
  const mergedIds = []

  const mergeHandler = (prompt, opts) => {
    const id = String(opts.label || '').split(':')[1] || ''
    mergedIds.push(id)
    return merged('c'.repeat(39) + String(mergedIds.length))
  }

  /** Red test files a tree anchored on the current integration head carries, minus `ownRed`. */
  const strayRedTests = (ownRed) =>
    mergedIds.filter((id) => REDS[id] && id !== ownRed).map((id) => REDS[id])

  const verifyHandler = (prompt, opts) => {
    const id = String(opts.label || '').split(':')[1] || ''

    if (REDS[id]) {
      // A red order, measured on its own branch: its tests fail, which is the order.
      return redVerified({
        discriminator: [{ test_id: REDS[id], failed_on_base: true, passes_now: false }],
        failing_tests: [{ file: REDS[id], id: id + ' > pins the contract' }],
      })
    }

    const stray = strayRedTests(IMPLEMENTS[id])
    if (stray.length === 0) return verified()

    // The poisoned measurement: this order's own tests pass, and a sibling pair's unimplemented
    // tests fail in the same suite run.
    return verified({
      suite: 'failed',
      suite_output_tail: stray.join(', ') + ' failing',
      failing_tests: stray.map((file) => ({ file, id: file + ' > pins the contract' })),
    })
  }

  const waveVerifyHandler = () => {
    const pendingReds = mergedIds
      .filter((id) => REDS[id] && !mergedIds.includes('G' + id.slice(1)))
      .map((id) => REDS[id])

    return pendingReds.length === 0
      ? verified({ discriminator: [], suite: 'passed' })
      : verified({
        discriminator: [], suite: 'failed',
        failing_tests: pendingReds.map((file) => ({ file, id: file + ' > pins the contract' })),
      })
  }

  return { mergedIds, mergeHandler, verifyHandler, waveVerifyHandler }
}

const runTwoPairs = () => {
  const world = twoPairWorld()

  return run({
    plan: twoPairPlan(),
    'verify:': world.verifyHandler,
    'merge:': world.mergeHandler,
    'wave-verify:': world.waveVerifyHandler,
    // A fix round for someone else's failing test has nothing to change, and says so.
    'fix:': coded({ status: 'done', commits: [], head_sha: B40 }),
  }).then((out) => ({ ...out, world }))
}

test('two red/green pairs both run to completion', async () => {
  const { result } = await runTwoPairs()

  assert.deepEqual(result.escalations, [],
    'no order here is defective: each green implements its own red and breaks nothing')
  assert.deepEqual(result.implemented.map((e) => e.id).sort(), ['G1', 'G2', 'R1', 'R2'])
  assert.equal(result.coverage.complete, true)
})

test('a green order is never measured against a sibling pair\'s unimplemented tests', async () => {
  const { prompts } = await runTwoPairs()

  for (const id of ['G1', 'G2']) {
    assert.ok(!prompts.some((p) => p.opts.label === 'fix:' + id),
      id + ' drew a fix round for a failure it does not own — the tree it was verified in ' +
      'carried another pair\'s red tests')
  }
})

test('every state line the workflow mints decodes to the line its digest was taken over', async () => {
  // The two implementations that must agree: the workflow encodes base64 by hand, because a
  // workflow script has no Buffer and no imports, and lib/ledger.mjs decodes with Buffer. A
  // padding slip or a surrogate mishandled on one side would produce tokens the writer refuses
  // — and the run would still finish, reporting a degraded side channel, with the resume point
  // silently gone. That is the failure this run already had once, from the other direction.
  //
  // Checked end to end rather than by unit-testing the encoder: what matters is that the exact
  // command the recorder is told to run is a command the writer accepts.
  const { prompts } = await runTwoPairs()
  const records = prompts.filter((p) => /^record:/.test(p.opts.label || ''))

  assert.ok(records.length > 0, 'the run recorded something')

  for (const { prompt, opts } of records) {
    const call = /--digest (\S+) --b64 (\S+)/.exec(prompt)
    assert.ok(call, opts.label + ': the dispatch does not carry a digest and a token')

    const decoded = Buffer.from(call[2], 'base64').toString('utf8')
    const entry = JSON.parse(decoded)

    assert.equal(digestEntry(entry), call[1],
      opts.label + ': what the token decodes to is not what the digest was minted over')
    assert.ok(/[\u0100-\uffff]/.test(decoded) === false || decoded.length > 0)
    assert.ok(!/\s/.test(call[2]), opts.label + ': the token must be one unbroken string')
  }
})

test('a state line carrying a Windows path survives the transport intact', async () => {
  // The shape that broke the heredoc. The worktree path reaches the recorder through the same
  // token as everything else, so the backslashes never meet a shell at all.
  const { prompts } = await run({
    plan: pairPlan([plainOrder('W1')], [['W1']]),
    'verify:': verifierSaying({
      'verify:W1': verified({ discriminator: [{ test_id: 't', failed_on_base: true, passes_now: true }] }),
    }),
    'code:': coded({ worktree: 'C:\\repo\\.claude\\worktrees\\wf-1' }),
  })

  const record = prompts.find((p) => /^record:W1/.test(p.opts.label || ''))
  assert.ok(record, 'the approved order was recorded')

  const call = /--digest (\S+) --b64 (\S+)/.exec(record.prompt)
  const entry = JSON.parse(Buffer.from(call[2], 'base64').toString('utf8'))

  assert.equal(digestEntry(entry), call[1])
  assert.ok(!/VFASTATE/.test(record.prompt),
    'no heredoc remains on the path that mints its own lines')
})

test('a coder reporting nothing to fix is escalated for THAT, not as incoherent', async () => {
  // The second line of defence. Whatever puts a defect that is not this order's in front of a
  // fix round, the coder that reads it, looks in its own locus and truthfully answers "there is
  // nothing here to change" must not be the party recorded as impossible. `incoherent_result`
  // says the RESULT cannot be true of any work; here the result is not only possible, it is
  // correct, and it carries the one sentence a human needs.
  //
  // In the field this arrived the other way round: five orders escalated as incoherent_result
  // while every coder had correctly reported that the failing tests belonged elsewhere.
  const { result } = await run({
    plan: pairPlan([plainOrder('W1')], [['W1']]),
    'verify:': verifierSaying({
      'verify:W1': verified({ suite: 'failed', failing_tests: [
        { file: 'test/somebody-else.test.js', id: 'other > pins something' }] }),
    }),
    'fix:': coded({ status: 'done', commits: [], head_sha: B40 }),
  })

  const esc = result.escalations.find((e) => e.id === 'W1')
  assert.ok(esc, 'the order still stops — the suite is failing and nothing changed it')
  assert.notEqual(esc.reason, 'incoherent_result',
    'the coder answered honestly; the incoherent party is not it')
  assert.ok(esc.unresolved.some((f) => /nothing in its own locus to change/.test(f.claim || '')),
    'and the escalation says what the coder actually reported')
})

test('a red order never reaches the integration head without its green', async () => {
  // The invariant underneath both assertions above, stated directly: whatever order the merges
  // happen in, the integration head never holds a red whose implementation is not there with it.
  // A head that is green between waves is also what makes an interrupted run's branch usable.
  const { world } = await runTwoPairs()

  const seen = []
  for (const id of world.mergedIds) {
    seen.push(id)
    const orphanReds = seen.filter((m) => REDS[m] && !seen.includes('G' + m.slice(1)))
    assert.deepEqual(orphanReds, [],
      'after merging ' + seen.join(', ') + ' the head carries a red with no implementation')
  }
})

test('by default the red is reviewed per order and its green at integration', async () => {
  const { review_every_order: _, ...defaults } = ARGS
  const { prompts } = await run({
    'verify:': verifierSaying({ 'verify:R1': redVerified() }),
    'merge:': mergeSequence([M40, N40]),
  }, defaults)

  const labels = prompts.map((p) => p.opts.label)
  assert.ok(labels.includes('review:R1#1'), 'a red pins the criteria nothing downstream can check')
  assert.ok(!labels.some((l) => l.startsWith('review:G1')), 'a green is measured by the red\'s tests')
  assert.match(promptFor(prompts, 'review:integration'), /— G1: /)
})
