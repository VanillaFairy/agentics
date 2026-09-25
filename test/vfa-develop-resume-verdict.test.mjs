// test/vfa-develop-resume-verdict.test.mjs — the single-verdict transport ladder.
//
// This file used to be about a fan. Three designs stood here, and the first two failed the
// same way:
//
//   - 2026-08-19: ONE loader was asked to re-emit a 118KB plan byte-exact through a schema. It
//     copied 1 of 14 orders and paraphrased the rest — an output-length cliff, not a
//     comprehension failure — and the digest gate's halt cost a diagnosis and a relaunch.
//   - 2026-08: the fan that replaced it bounded every ORDER by its own size, but the index that
//     opened the fan still carried the envelope, the manifest, the state and `partition_raw`
//     through a model with nothing checking what came back. Three times running on one
//     repository the courier damaged the escaping in `partition_raw` — the one field with no
//     digest behind it — so it parsed as "no waves", and the run degraded to "every order is
//     coupled", handing four orders that were already built, reviewed and merged back to the
//     session to be reimplemented. One retry burned ~418k tokens and produced nothing.
//
// The lesson both times was structural: bytes must not ride a model. So the fan is gone and
// nothing is transcribed any more. `lib/run-verdict.mjs` computes the entire resume decision on
// disk and prints it with its own FNV-1a digest; ONE courier runs that command and pastes its
// stdout; the workflow recomputes the digest over what arrived. What is left to test here is
// therefore not comprehension but TRANSPORT — and the ladder around it:
//
//   damaged in transit  → one retry, one tier up, then the run carries on as if nothing happened
//   refused by the CLI  → carried through verbatim, NEVER retried
//   unreachable courier → a different answer again, and reported as itself
//   carried by no tier  → an honest halt that hands back NOTHING to reimplement
//
// The fixtures come from test/harness/resume-fixture.mjs, which builds each payload by calling
// the real `deriveVerdict`, so these tests pin what the ladder actually decides rather than what
// the author of the test believed it decides.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carriedChain, carriedPayload, runWorkflow, scriptedAgents } from './harness/workflow-host.mjs'
import { resumeVerdict, gitFacts } from './harness/resume-fixture.mjs'

const resumeLoad = resumeVerdict

const WF = fileURLToPath(new URL('../workflows/vfa-develop.workflow.js', import.meta.url))

const A40 = 'a'.repeat(40)
const B40 = 'b'.repeat(40)
const M40 = 'e'.repeat(40)
const N40 = 'f'.repeat(40)

const RUN_DIR = 'C:/repo/.claude/vfa/runs/20260819-062330'
// These scenarios pin the per-order review loop, so they ask for it on every order; the default,
// which reviews only yardstick orders per order, is pinned in vfa-develop-review-scope.
const ARGS = { change: 'add the thing', roots: '.', plugin_root: 'C:/plugin', review_every_order: true }

const order = (id, over = {}) => ({
  id, title: 'do ' + id, role: 'none', locus: ['src/' + id + '.js'], reads: [],
  acceptance: ['builds'], context: 'ctx', deps: [], contract: false, ...over,
})

const ORDERS = [order('W1'), order('W2', { deps: ['W1'] })]

const envelope = (over = {}) => ({
  change: 'add the thing', roots: '.', caller_notes: '', intelligence: 'normal',
  base_branch: 'master', base_sha: A40, programme: '', slice: '', ...over,
})

/** W1 already merged by an earlier invocation; a resume has only W2 left to build. */
const waveLine = () => ({
  kind: 'wave', seq: 0, wave: 1, merged: ['W1'], approved_unmerged: [], escalated: [],
  discovered: [], integration_base: A40, integration_head: M40, order: '', branch: '',
  worktree: '', head_sha: '',
})

/** The fixture every case here starts from: a half-finished run, readable and coherent. */
const loaded = (over = {}) => ({
  stop_reason: 'loaded',
  plan: {
    work_orders: ORDERS, shared_files: [],
    partition_raw: JSON.stringify({ waves: [['W1'], ['W2']], coupled: [] }),
    blocking_gaps: [], plan_path: RUN_DIR, notes: '',
  },
  envelope: envelope(),
  state: [waveLine()],
  notes: 'read plan.json and one state entry',
  ...over,
})

const cast = (over = {}) => scriptedAgents({
  ...resumeLoad(loaded()),
  drift: { stop_reason: 'completed', user_head: A40, moved_files: [], notes: 'unchanged' },
  worktrees: { stop_reason: 'completed', made: [], notes: 'no branch needed a tree' },
  'integration-setup': {
    stop_reason: 'completed',
    worktree: 'C:/repo/.claude/worktrees/vfa-20260819-062330-integration',
    branch: 'vfa/20260819-062330-integration', head_sha: M40, notes: 'attached',
  },
  'merge:': { stop_reason: 'completed', merged_sha: N40, conflicts: [], notes: 'merged' },
  'wave-verify:': carriedPayload({
    stop_reason: 'completed', build: 'passed', suite: 'passed', suite_output_tail: 'ok',
    failing_tests: [], discriminator: [], series_findings: [], notes: 'the merged head',
  }),
  'record:': { stop_reason: 'recorded', path: RUN_DIR + '/state.jsonl', notes: 'appended' },
  'kb-chain': carriedChain(),
  'kb-write': { stop_reason: 'recorded', path: '.claude/vfa/kb', notes: 'appended' },
  'review:integration': { findings: [], fix_verdicts: [] },
  'code:': {
    status: 'done', worktree: 'C:/wt/w2', branch: 'wo-w2', base_sha: A40, head_sha: B40,
    commits: [{ sha: B40, subject: 'feat: w2' }], concerns: [], discovered: [], summary: 's',
  },
  'verify:': carriedPayload({
    stop_reason: 'completed', build: 'passed', suite: 'passed', suite_output_tail: 'ok',
    failing_tests: [],
    discriminator: [{ test_id: 'test/w2.test.js', failed_on_base: true, passes_now: true }],
    series_findings: [], notes: 'ran node --test',
  }),
  'fix:': {
    status: 'done', worktree: 'C:/wt/w2', branch: 'wo-w2', base_sha: A40, head_sha: B40,
    commits: [{ sha: B40, subject: 'fix: w2' }], concerns: [], discovered: [], summary: 's',
  },
  'review:': { findings: [], fix_verdicts: [] },
  ...over,
})

const resumed = (over, fixture) => runWorkflow(WF, {
  args: { ...ARGS, resume_path: RUN_DIR },
  workflow: () => { throw new Error('a resume never surveys') },
  agent: fixture ? cast({ ...resumeLoad(loaded(fixture)), ...over }) : cast(over),
})

/**
 * The exact field damage, reproduced: a courier mangles the wave layout on the way in. Applied
 * AFTER the digest is taken, so what the workflow recomputes cannot match — which is the only
 * thing standing between this payload and a run that reports four merged orders as coupled.
 */
const mangleThePartition = (env) => { env.payload.partition.waves = [] }

/** One courier answer carrying that damage. */
const mangled = () => resumeLoad(loaded(), mangleThePartition)['resume-verdict']

const labels = (prompts) => prompts.map((p) => p.opts.label || '')

// ── one courier, and nothing else ────────────────────────────────────────────────────────────

test('a clean resume buys exactly one verdict courier, at the frontmatter tier', async () => {
  // The fan's whole cost model was per-order: an index dispatch plus one dispatch per work
  // order, each one a chance to paraphrase. A resume now pays for one dispatch whose entire job
  // is "run this command, paste the output", and pays it once.
  const { result, prompts } = await resumed()

  const verdicts = prompts.filter((p) => /^resume-verdict/.test(p.opts.label || ''))
  assert.equal(verdicts.length, 1, 'one dispatch reads the whole run directory')
  assert.equal(verdicts[0].opts.label, 'resume-verdict')
  assert.equal(verdicts[0].opts.model, undefined,
    'the first attempt runs at the frontmatter tier — the raise is what a failure buys')

  assert.ok(!labels(prompts).some((l) => l.startsWith('load:') || l === 'resume-index'),
    'no per-order loader of any kind survives: the plan is read on disk, by its consumer')

  assert.deepEqual(result.implemented.map((e) => e.id), ['W2'],
    'W1 was merged by the earlier invocation and is not re-bought')
  assert.equal(result.coverage.complete, true)
})

// ── damaged in transit ───────────────────────────────────────────────────────────────────────

test('a payload damaged in transit is healed by the sonnet retry, and the run continues',
  async () => {
    // The 2026-08 partition corruption, now caught by arithmetic instead of surviving as a
    // plausible-looking "no waves". The digest covers every field of the payload, so the
    // un-digested `partition_raw` that let this through simply no longer exists.
    const clean = resumeLoad(loaded())
    const { result, prompts, logs } = await resumed({
      ...resumeLoad(loaded(), mangleThePartition),
      'resume-verdict#2': clean['resume-verdict'],
    })

    const retry = prompts.find((p) => p.opts.label === 'resume-verdict#2')
    assert.ok(retry, 'a damaged copy must buy a second tier rather than a degraded run')
    assert.equal(retry.opts.model, 'sonnet', 'the retry is the tier raise, not the default')
    assert.match(logs.join(' '), /did not survive the trip/,
      'a healed payload is reported, not silent')

    assert.deepEqual(result.implemented.map((e) => e.id), ['W2'],
      'the healed run carries on exactly as a clean one would')
    assert.deepEqual(result.coupled, [],
      'the damage this ladder exists to prevent is precisely a coupled list built from a lie')
    assert.equal(result.coverage.complete, true)
  })

test('exactly one retry is bought — the ladder has two rungs, not a loop', async () => {
  const { prompts } = await resumed({
    'resume-verdict': mangled(), 'resume-verdict#2': mangled(),
  })

  const verdicts = labels(prompts).filter((l) => /^resume-verdict/.test(l))
  assert.deepEqual(verdicts, ['resume-verdict', 'resume-verdict#2'],
    'a courier that cannot carry the payload twice will not carry it on the third attempt either')
})

// ── refused by the CLI ───────────────────────────────────────────────────────────────────────

test('a payload the CLI refused is carried through and reported, never retried', async () => {
  // A refusal is the tool WORKING: an unreadable plan.json, a dependency cycle, a run directory
  // that is not one. Retrying it one tier up buys the same honest answer at a higher price —
  // and the reason to keep this pinned is that a refusal and a mangled copy arrive through the
  // same string, so it is one `if` that keeps them apart.
  const { result, prompts } = await resumed({
    'resume-verdict': {
      stop_reason: 'loaded',
      payload_raw: JSON.stringify({ error: 'dependency cycle W1 -> W2 -> W1' }),
      notes: 'the command ran and refused',
    },
  })

  assert.ok(!prompts.some((p) => p.opts.label === 'resume-verdict#2'),
    'a planning defect is not a transcription defect')

  const said = result.coverage.unreached.join(' ')
  assert.match(said, /REFUSED: dependency cycle W1 -> W2 -> W1/,
    "the CLI's own words reach the caller, not a paraphrase of them")
  assert.equal(result.coverage.complete, false)
  assert.deepEqual(result.coupled, [])
})

// ── the courier could not run the command at all ─────────────────────────────────────────────

test("a courier that never ran the command is not reported as a refusal", async () => {
  // IRON LAW §7: "I couldn't" and "there is nothing there" are different answers. `failed` is
  // the courier unable to run the command — a broken environment, a path that does not exist —
  // and unlike a refusal it is worth a second courier, because the next one may reach the disk.
  const unreachable = {
    stop_reason: 'failed',
    payload_raw: '',
    notes: 'node is not on PATH in this environment',
  }
  const { result, prompts } = await resumed({
    'resume-verdict': unreachable,
    'resume-verdict#2': unreachable,
  })

  assert.ok(prompts.some((p) => p.opts.label === 'resume-verdict#2'),
    'an environment failure gets its second chance; a refusal does not')

  const said = result.coverage.unreached.join(' ')
  assert.match(said, /node is not on PATH in this environment/,
    "the courier's own account of why it could not run reaches the caller")
  assert.ok(!/REFUSED/.test(said),
    'a command that never ran did not refuse anything, and must not be described as if it had')
  assert.equal(result.coverage.complete, false)
})

// ── carried by no tier ───────────────────────────────────────────────────────────────────────

test('a payload no tier can carry halts, and never reports the plan as all-coupled', async () => {
  // The strongest assertion in this file, and the one the whole rework was for. When the resume
  // cannot read its own state the tempting fallback is "hand the plan to the session" — which
  // is what the mangled partition did by accident, offering four already-merged orders back for
  // reimplementation. A resume that cannot read its plan knows NOTHING about what is already
  // built, so the only honest output is an empty hand and a named reason.
  const { result, prompts } = await resumed({
    'resume-verdict': mangled(), 'resume-verdict#2': mangled(),
  })

  assert.ok(result.coverage.failed_channels.includes('run-state'))
  assert.equal(result.coupled.length, 0,
    'handing every order to the session is the damage this halt exists to prevent')
  assert.equal(result.coverage.complete, false)

  const said = result.coverage.unreached.join(' ')
  assert.match(said, /digest mismatch/, 'the halt names the defect it caught')
  assert.match(said, /no order was reported as coupled/,
    'and says so out loud, because silence here reads exactly like nothing being wrong')

  assert.ok(!labels(prompts).some((l) => l.startsWith('code:') || l === 'integration-setup'),
    'nothing is dispatched against a plan that is not the plan that was written')
})

// ── the guard that runs before the ladder can matter ─────────────────────────────────────────

test('a wrong change halts on the verdict alone — nothing is dispatched for feature B',
  async () => {
    // Implementing feature A's plan under feature B's description is a wrong run that reports
    // itself as a right one. The comparison is the first thing done with a carried verdict, so
    // the mistake costs one courier rather than a wave of coders.
    const { result, prompts } = await resumed(
      resumeLoad(loaded({ envelope: envelope({ change: 'a different change entirely' }) })))

    assert.match(result.coverage.unreached.join(' '), /written for a different change/)
    assert.ok(!labels(prompts).some((l) => l.startsWith('code:') || l === 'integration-setup'),
      'building the wrong plan is the spend the early comparison withholds')
    assert.equal(result.coverage.complete, false)
  })

// --- continuing a series nobody reported finishing ------------------------------------------
//
// The rung between "adopt these commits and measure them" and "build this order from scratch".
// Git shows commits on a branch whether the coder finished or was killed mid-series, and only
// the coder knows which — so it now says so, and the absence of that line means something.

const C40 = 'c'.repeat(40)

/** W2's branch holds commits; some OTHER order recorded a coder-done, so this run speaks it. */
const halfBuilt = (over = {}) => ({
  journal_raw: JSON.stringify({
    kind: 'coder-done', seq: 4, order: 'W1', head_sha: M40,
    commits: [{ sha: M40, subject: 'feat: w1' }],
  }),
  git: gitFacts([{
    id: 'W2', branch: 'vfa/20260819-062330-W2', head_sha: C40, base_sha: M40,
    commits: [{ sha: C40, subject: 'feat: w2, partly' }],
    worktree: 'C:/wt/w2', dirty: [], already_merged: false,
  }]),
  ...over,
})

test('an unfinished series is continued from its last commit, never rebuilt', async () => {
  const { prompts } = await resumed({
    'continue:W2': {
      status: 'done', worktree: 'C:/wt/w2', branch: 'vfa/20260819-062330-W2',
      base_sha: M40, head_sha: B40,
      commits: [{ sha: C40, subject: 'feat: w2, partly' }, { sha: B40, subject: 'feat: w2, rest' }],
      concerns: [], discovered: [], summary: 'carried on',
    },
  }, halfBuilt())

  assert.ok(!prompts.some((p) => p.opts.label === 'code:W2'),
    'rebuilding over commits that are already there pays for that work twice')

  const carry = prompts.find((p) => p.opts.label === 'continue:W2')
  assert.ok(carry, 'the continuation coder is dispatched instead')
  assert.match(carry.prompt, /CONTINUE an unfinished commit series/)
  assert.match(carry.prompt, /do not amend, do not rebase, do not squash/)
  assert.ok(carry.prompt.includes(C40), 'it is shown the commits it is continuing from')
  assert.ok(prompts.some((p) => p.opts.label === 'verify:W2'),
    'and the finished series is measured like any other — adoption is never trust')
})

test('a continuation that finds nothing left to add is a real answer, not an escalation', async () => {
  // `done` with no NEW commits means opposite things for a fresh series and a continued one:
  // nothing was implemented, versus the series was already complete. The two results look
  // identical, so escalating the honest one would throw away a finished order.
  const { result, prompts } = await resumed({
    'continue:W2': {
      status: 'done', worktree: 'C:/wt/w2', branch: 'vfa/20260819-062330-W2',
      base_sha: M40, head_sha: C40, commits: [], concerns: [],
      discovered: [], summary: 'the series was already complete against every criterion',
    },
  }, halfBuilt())

  assert.equal(result.escalations.length, 0,
    'an honest "there was nothing left to do" must not be read as "I did nothing"')
  assert.ok(prompts.some((p) => p.opts.label === 'verify:W2'),
    'it still goes through verification — the caller measures, it does not take the word')
  assert.deepEqual(result.integration.merged, ['W2'])
})

// The per-order dial has to survive the transport too, and its failure is the quiet kind: no
// error, no wrong field, just every resumed order priced at the run's ceiling because
// `weightOf` reads a missing `weight` as `standard`. In run 20260902-124933 the same order was
// coded at sonnet on the fresh dispatch and at the ceiling on the resume, and nothing said so.
test('a light order resumes light: the dial is not left behind by the transport', async () => {
  const light = [order('W1'), order('W2', { deps: ['W1'], weight: 'light' })]
  const { prompts } = await resumed({}, {
    plan: {
      work_orders: light, shared_files: [],
      partition_raw: JSON.stringify({ waves: [['W1'], ['W2']], coupled: [] }),
      blocking_gaps: [], plan_path: RUN_DIR, notes: '',
    },
  })

  const review = prompts.find((p) => (p.opts.label || '').startsWith('review:W2'))
  assert.ok(review, 'W2 was reviewed')
  assert.equal(review.opts.model, 'sonnet',
    'a light order is judged one tier under the run\'s ceiling, on a resume exactly as when fresh')
})

test('a legacy run — commits, and no coder-done anywhere — is measured, never continued', async () => {
  // Every run planned before this version has exactly this shape. Reading the absence as "the
  // coder died mid-series" would buy a continuation round at every adopted series in every one
  // of them, and invite commits nobody asked for.
  const { prompts } = await resumed({}, halfBuilt({ journal_raw: '' }))

  assert.ok(!prompts.some((p) => p.opts.label === 'continue:W2'))
  assert.ok(prompts.some((p) => p.opts.label === 'verify:W2'),
    'the older, safe reading: measure what is on the branch as it stands')
})
