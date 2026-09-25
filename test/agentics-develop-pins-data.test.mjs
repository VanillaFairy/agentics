// test/agentics-develop-pins-data.test.mjs — regression-net orders, and the round nobody can win.
//
// The discriminator asks one question of every test an order lands: did it fail before the
// change under it? That is the right question for a test written to pin a behaviour change,
// and it catches the real defect of a test written to be green.
//
// It is the wrong question for a test written to pin EXISTING CORRECT DATA. "The shipped
// bundle is still valid" was true at base too — that is the point of the assertion — and the
// only way to make it fail there would be to break the data first. Run 20260902-124933 held a
// correct test-only order for two fix rounds and needed a human to override the gate.
//
// Two mechanisms are pinned here, and they are deliberately independent. `pins: 'data'` lets
// the plan say what kind of test it commissioned, so the base question is not asked at all.
// `discriminator_undecidable` catches the order the plan FAILED to mark: a discriminator
// standing alone as the only failing fact cannot be moved by any commit inside the order's
// locus, so it goes to a person on round one instead of buying a round to learn that again.
//
// Both mechanisms were shown to bite the way this file's own subject demands: disabling
// `pinsData` fails the first and fifth tests here, disabling `discriminatorUndecidable` fails
// the sixth and seventh, and the rest are the negative controls that hold either way.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carriedChain, carriedPayload, scriptedAgents, runWorkflow } from './harness/workflow-host.mjs'

const WF = fileURLToPath(new URL('../workflows/agentics-develop.workflow.js', import.meta.url))

const A40 = 'a'.repeat(40)
const B40 = 'b'.repeat(40)
const M40 = 'e'.repeat(40)

const RUN_DIR = 'C:/repo/.claude/agentics/runs/20260903-101500'
const ARGS = { change: 'add a regression net over the shipped bundle', roots: '.', plugin_root: 'C:/plugin' }

// The order from the field report, reduced to its shape: test files only, no production code,
// and acceptance criteria that name the mutation which DOES make the cases bite.
const NET = {
  id: 'W1', title: 'assert the shipped bundle stays valid',
  role: 'none', pins: 'data', weight: 'standard',
  locus: ['test/unit/assetBundles.test.ts'], reads: ['src/assets/core.json'],
  acceptance: [
    'the real core.json obeys every composed-set rule',
    "deleting slices from prop.woodboard's row makes the card-texture case fail",
  ],
  context: 'defence in depth over real data', deps: [], contract: false,
}

const plan = (orders) => ({
  work_orders: orders,
  shared_files: [],
  partition_raw: JSON.stringify({ waves: [orders.map((o) => o.id)], coupled: [] }),
  blocking_gaps: [],
  plan_path: RUN_DIR,
  notes: '',
})

const coded = (over = {}) => ({
  status: 'done', worktree: 'C:/wt/x', branch: 'wo-x', base_sha: A40, head_sha: B40,
  commits: [{ sha: B40, subject: 'test: bundle rules' }], concerns: [], discovered: [],
  summary: 's', ...over,
})

/** A regression net as it really measures: it passes now, and it passed at base as well. */
const netVerified = (over = {}) => carriedPayload({
  stop_reason: 'completed', build: 'passed', suite: 'passed', suite_output_tail: 'ok',
  discriminator: [{ test_id: 'test/unit/assetBundles.test.ts', failed_on_base: false, passes_now: true }],
  failing_tests: [], series_findings: [], notes: 'ran vitest', ...over,
})

const setUp = (over = {}) => ({
  stop_reason: 'completed', worktree: 'C:/repo/.claude/worktrees/x',
  branch: 'agentics/20260903-101500-integration', head_sha: A40, notes: 'created', ...over,
})

const cast = (over = {}) => scriptedAgents({
  'existing-runs': { stop_reason: 'observed', runs: [], notes: 'no runs directory' },
  plan: plan([NET]),
  drift: { stop_reason: 'completed', user_head: A40, moved_files: [], notes: 'unchanged' },
  'integration-setup': setUp(),
  'merge:': { stop_reason: 'completed', merged_sha: M40, conflicts: [], notes: 'merged' },
  'wave-verify:': carriedPayload({
    stop_reason: 'completed', build: 'passed', suite: 'passed', suite_output_tail: 'ok',
    discriminator: [], failing_tests: [], series_findings: [], notes: 'ran vitest',
  }),
  'record:': { stop_reason: 'recorded', path: RUN_DIR, notes: 'appended' },
  'kb-chain': carriedChain(),
  'kb-write': { stop_reason: 'recorded', path: '.claude/agentics/kb', notes: 'appended' },
  'review:integration': { findings: [], fix_verdicts: [] },
  ...over,
  'code:': over['code:'] || coded(),
  'verify:': over['verify:'] || netVerified(),
  'fix:': over['fix:'] || coded(),
  'review:': over['review:'] || { findings: [], fix_verdicts: [] },
})

const run = (over = {}, orders = [NET]) =>
  runWorkflow(WF, {
    args: ARGS,
    workflow: () => ({ coverage: { complete: true, dropped: [], incomplete: [],
      failed_channels: [], unreached: [], resumable: { runId: 'r', remaining: [] } } }),
    agent: cast({ plan: plan(orders), ...over }),
  })

const unmarked = { ...NET, pins: 'behaviour' }

// --- the marker ------------------------------------------------------------------------

test("a pins:'data' order whose tests pass now is verified, though they passed at base too",
  async () => {
    const { result, prompts } = await run()

    assert.ok(!prompts.some((p) => p.opts.label === 'fix:W1'),
      'nothing is wrong with this order, so no fix round is bought')
    assert.deepEqual(result.escalations, [])
    assert.deepEqual(result.implemented.map((e) => e.id), ['W1'])
  })

test("pins:'data' waives the base question and nothing else — a test that does not pass now still fails",
  async () => {
    // The waiver is one conjunct wide. A regression net that does not actually pass is a
    // broken regression net, and marking the order changes nothing about that.
    const { result } = await run({
      'verify:': netVerified({
        discriminator: [{ test_id: 'test/unit/assetBundles.test.ts', failed_on_base: false, passes_now: false }],
      }),
      'fix:': coded({ commits: [], head_sha: A40 }),
    })

    assert.ok(result.escalations.some((e) => e.id === 'W1'),
      'passes_now is still asked of a data-pinning test')
  })

test("pins:'data' is inert on a red order, whose tests must fail at base by definition",
  async () => {
    const red = {
      ...NET, id: 'R1', role: 'red', pins: 'data',
      locus: ['test/widget.test.js'],
    }

    const { result } = await run({
      'verify:': netVerified({
        discriminator: [{ test_id: 'test/widget.test.js', failed_on_base: false, passes_now: false }],
        suite: 'failed', suite_output_tail: '1 failing',
        failing_tests: [{ file: 'test/widget.test.js', id: 'widget > rejects an empty label' }],
      }),
      'fix:': coded({ commits: [], head_sha: A40 }),
    }, [red])

    assert.ok(result.escalations.some((e) => e.id === 'R1'),
      'a red order still has to fail at base — the two markers make opposite claims')
  })

test("the planner is told what pins means and what to write in the criteria when it is 'data'",
  async () => {
    const { prompts } = await run()
    const planPrompt = (prompts.find((p) => p.opts.label === 'plan') || { prompt: '' }).prompt

    assert.match(planPrompt, /Set pins on every order/)
    assert.match(planPrompt, /REGRESSION NET/)
    assert.match(planPrompt, /WRITE THE MUTATION INTO ITS ACCEPTANCE CRITERIA/)
  })

test("a pins:'data' coder is told to run the mutation by hand rather than break the data",
  async () => {
    const { prompts } = await run()
    const codePrompt = (prompts.find((p) => p.opts.label === 'code:W1') || { prompt: '' }).prompt

    assert.match(codePrompt, /PIN DATA, NOT A BEHAVIOUR CHANGE/)
    assert.match(codePrompt, /NOT required to fail against the base commit/)
    assert.match(codePrompt, /still required to PASS now/)
  })

// --- the unwinnable round --------------------------------------------------------------

test('an unmarked order failing ONLY the discriminator escalates on round one, buying no fix round',
  async () => {
    const { result, prompts } = await run({ 'verify:': netVerified() }, [unmarked])

    assert.ok(!prompts.some((p) => p.opts.label === 'fix:W1'),
      'no commit inside this locus can move the base answer, so the round is not bought')

    const esc = result.escalations.find((e) => e.id === 'W1')
    assert.ok(esc, 'it still does not merge — a person rules on it')
    assert.equal(esc.reason, 'discriminator_undecidable')
  })

test('the undecidable escalation quotes the order\'s own acceptance criteria', async () => {
  const { result } = await run({ 'verify:': netVerified() }, [unmarked])

  const esc = result.escalations.find((e) => e.id === 'W1')
  const quoted = esc.unresolved.map((f) => f.evidence || '').join('\n')

  assert.match(quoted, /ACCEPTANCE CRITERIA AS PLANNED/)
  assert.match(quoted, /deleting slices from prop\.woodboard/,
    'the check that DOES fit this order is in its criteria, and a person needs to see it')
  assert.match(quoted, /pins: 'data'/, 'and the marker that would have prevented this')
})

test('a discriminator failure alongside a real one still buys a fix round', async () => {
  // The short-circuit fires only when the discriminator is the ONLY thing failing. A broken
  // suite beside it is something a coder can genuinely move, and withholding the round there
  // would trade one false verdict for another.
  const { result, prompts } = await run({
    'verify:': netVerified({
      suite: 'failed', suite_output_tail: '3 failing',
      failing_tests: [{ file: 'src/other.ts', id: 'other > works' }],
    }),
    'fix:': coded({ commits: [], head_sha: A40 }),
  }, [unmarked])

  assert.ok(prompts.some((p) => p.opts.label === 'fix:W1'),
    'a failing suite is fixable, so the round is worth buying')
  assert.ok(result.escalations.some((e) => e.reason !== 'discriminator_undecidable'))
})

test('a build failure is not read as an undecidable discriminator', async () => {
  // `verifiable` is false here, so the order fails for a reason that has nothing to do with
  // the discriminator — and dropping the discriminator would not rescue it either.
  const { result, prompts } = await run({
    'verify:': netVerified({ build: 'failed' }),
    'fix:': coded({ commits: [], head_sha: A40 }),
  }, [unmarked])

  assert.ok(prompts.some((p) => p.opts.label === 'fix:W1'), 'a broken build is a coder\'s problem')
  assert.ok(!result.escalations.some((e) => e.reason === 'discriminator_undecidable'))
})


// --- the mutation, executed ----------------------------------------------------------------

const SPEC = {
  file: 'src/assets/core.json',
  find: '"slices": [1, 2, 3]',
  replace: '',
  expect_failing: ['test/unit/assetBundles.test.ts'],
}

/** The same regression net, with its prose mutation also written as an executable spec. */
const NET_WITH_SPEC = { ...NET, mutations: [SPEC] }

const bit = (over = {}) => ({
  file: SPEC.file, applied: true, unapplied_reason: '',
  expect_failing: SPEC.expect_failing, observed_failing: SPEC.expect_failing, bites: true, ...over,
})

test('a declared mutation that makes the net bite verifies the order', async () => {
  const { result, prompts } = await run({ 'verify:': netVerified({ mutations: [bit()] }) },
    [NET_WITH_SPEC])

  assert.ok(!prompts.some((p) => p.opts.label === 'fix:W1'))
  assert.deepEqual(result.escalations, [])
  assert.deepEqual(result.implemented.map((e) => e.id), ['W1'])
})

test('a net that survives its own mutation fails the order, though every test passes', async () => {
  // The whole point of executing the mutation. `pins: 'data'` waived the base question, which
  // left this class of test with NOTHING mechanical asking whether it can fail at all. Here the
  // suite is green, the discriminator is waived, and the order still does not pass.
  const { result, prompts } = await run({
    'verify:': netVerified({ mutations: [bit({ observed_failing: [], bites: false })] }),
    'fix:': coded({ commits: [], head_sha: A40 }),
  }, [NET_WITH_SPEC])

  const fix = prompts.find((p) => p.opts.label === 'fix:W1')
  assert.ok(fix, 'a net that cannot fail is a defect a coder can fix')
  assert.match(fix.prompt, /did not make the net bite/)
  assert.match(fix.prompt, /survives the break it exists to catch/)
  assert.ok(!result.implemented.some((e) => e.id === 'W1'))
})

test('a mutation the program could not apply is never read as a net that holds', async () => {
  // The two must not collapse. A stale `find` is a defect in the PLAN's spec and says nothing
  // about the test, so it fails the order under its own name and points at the spec.
  const { prompts } = await run({
    'verify:': netVerified({ mutations: [bit({
      applied: false, bites: false, observed_failing: [],
      unapplied_reason: 'the text to replace does not occur in this file, so the spec is stale',
    })] }),
    'fix:': coded({ commits: [], head_sha: A40 }),
  }, [NET_WITH_SPEC])

  const fix = prompts.find((p) => p.opts.label === 'fix:W1')
  assert.ok(fix)
  assert.match(fix.prompt, /could not be applied/)
  assert.match(fix.prompt, /fix the spec, in the plan, rather than the test/,
    'a spec nobody could apply is not evidence about the test')
})

test('an order declaring no mutation is verified exactly as it was before', async () => {
  // Every order written before this field existed is this case, and the field is worth having
  // only if it costs them nothing.
  const { result } = await run({ 'verify:': netVerified({ mutations: [] }) })

  assert.deepEqual(result.escalations, [])
  assert.deepEqual(result.implemented.map((e) => e.id), ['W1'])
})

test('the coder is shown the mutation its verification will run', async () => {
  const { prompts } = await run({ 'verify:': netVerified({ mutations: [bit()] }) }, [NET_WITH_SPEC])

  const code = prompts.find((p) => p.opts.label === 'code:W1')
  assert.match(code.prompt, /EXECUTABLE MUTATION/)
  assert.match(code.prompt, /src\/assets\/core\.json/,
    'a coder writing a net it cannot see the break for is writing blind')
  assert.match(code.prompt, /never the data, which is what the marker exists to protect/,
    'the one move that would make this check pass dishonestly is named and forbidden')
})
