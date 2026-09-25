// test/agentics-develop-kb.test.mjs — the knowledge base's two seams inside a run.
//
// The knowledge base adds exactly two dispatches to `agentics-develop`, and everything worth pinning is
// about who receives what:
//
//   3e, before the first order   one chain read for every locus this plan touches. Fresh entries
//                                reach that locus's own coder; stale ones reach nobody; command
//                                entries reach the check runner as ARGUMENTS, never as prose.
//   5b, at the run's end         approved orders' discoveries and the commands a verification
//                                established go into the repository's base, under one digest.
//
// The asymmetry the whole design rests on is tested from both sides: a coder may act on hearsay
// and be caught by verification, and verification has nothing behind it — so a verify dispatch
// receives no entry, and the one thing it does take from the base carries a source that only a
// verification can have written.
//
// Design: docs/DESIGN.md#inside-a-run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carriedChain, carriedEnvelope, carriedPayload, recordedLine, runWorkflow, scriptedAgents } from './harness/workflow-host.mjs'

const WF = fileURLToPath(new URL('../workflows/agentics-develop.workflow.js', import.meta.url))

const A40 = 'a'.repeat(40)
const B40 = 'b'.repeat(40)
const M40 = 'e'.repeat(40)

const RUN_DIR = 'C:/repo/.claude/agentics/runs/20260830-101500'
const ARGS = { change: 'add the thing', roots: 'C:/repo', plugin_root: 'C:/plugin' }

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')

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

const plan = (orders, waves) => ({
  work_orders: orders,
  shared_files: [],
  partition_raw: JSON.stringify({ waves: waves || [orders.map((o) => o.id)], coupled: [] }),
  blocking_gaps: [],
  plan_path: RUN_DIR,
  notes: '',
})

const coded = (id, over = {}) => ({
  status: 'done', worktree: 'C:/wt/' + id, branch: 'wo-' + id, base_sha: A40, head_sha: B40,
  commits: [{ sha: B40, subject: 'feat: ' + id }], concerns: [], discovered: [], summary: 's',
  ...over,
})

const verified = (over = {}) => carriedPayload({
  stop_reason: 'completed', build: 'passed', suite: 'passed', suite_output_tail: 'ok',
  failing_tests: [],
  discriminator: [{ test_id: 'test/w1.test.js', failed_on_base: true, passes_now: true }],
  series_findings: [], notes: 'ran the checks', ...over,
})

/** A whole, correctly digested payload that says the runner could not answer. */
const refused = (kind, message) => carriedPayload({
  stop_reason: 'environment_broken', build: 'absent', suite: 'absent',
  notes: message, error: { kind, message },
})

const investigated = (over = {}) => ({
  stop_reason: 'completed', build: 'passed', suite: 'passed', suite_output_tail: 'ok',
  failing_tests: [],
  discriminator: [{ test_id: 'test/w1.test.js', failed_on_base: true, passes_now: true }],
  series_findings: [],
  commands: { build: 'npm run build', suite: 'npm test', test_one: 'npm test -- {file}' },
  notes: 'read package.json and ran both commands by hand',
  ...over,
})

const byLabel = (map, fallback) => (prompt, opts) => {
  const found = map[opts.label]
  return found === undefined ? fallback : found
}

const cast = (over = {}) => scriptedAgents({
  'existing-runs': { stop_reason: 'observed', runs: [], notes: 'no runs directory' },
  plan: plan([order('W1')]),
  'integration-setup': {
    stop_reason: 'completed', worktree: 'C:/repo/.claude/worktrees/int',
    branch: 'agentics/20260830-101500-integration', head_sha: A40, notes: 'created',
  },
  'merge:': { stop_reason: 'completed', merged_sha: M40, conflicts: [], notes: 'git merge --no-ff' },
  'wave-verify:': verified({ discriminator: [], notes: 'the merged head' }),
  'record:': { stop_reason: 'recorded', path: RUN_DIR + '/state.jsonl', notes: 'appended' },
  'review:integration': { findings: [], fix_verdicts: [] },
  'code:': (prompt, opts) => coded((opts.label || '').split(':')[1] || 'W1'),
  'verify:': verified(),
  'review:': { findings: [], fix_verdicts: [] },
  'kb-chain': carriedChain(),
  'kb-write': { stop_reason: 'recorded', path: 'C:/repo/.claude/agentics/kb', notes: 'appended' },
  ...over,
})

const run = (over) => runWorkflow(WF, {
  args: ARGS, workflow: () => surveyResult(), agent: cast(over),
})

const promptFor = (prompts, label) => (prompts.find((p) => p.opts.label === label) || {}).prompt || ''
const labelsOf = (prompts) => prompts.map((p) => p.opts.label || '')

/** The batch the deposit dispatch actually carries, decoded out of its base64 token. */
const deposited = (prompts) => recordedLine(promptFor(prompts, 'kb-write')).entry.entries

// ── 3e: the chain is bought once, for the ground this plan touches ───────────────────────────

test('one chain read covers every locus in the plan, before the first order is dispatched', async () => {
  const orders = [order('W1'), order('W2')]
  const { prompts } = await run({ plan: plan(orders, [['W1', 'W2']]) })

  const reads = labelsOf(prompts).filter((l) => l === 'kb-chain')
  assert.deepEqual(reads, ['kb-chain'],
    'the chains are independent of anything a wave does, so buying them per order buys the ' +
    'same dispatch twice for a payload that could arrive once')

  const at = labelsOf(prompts).indexOf('kb-chain')
  const firstCoder = labelsOf(prompts).findIndex((l) => l.startsWith('code:'))
  assert.ok(at >= 0 && at < firstCoder, 'a seeding read after the coder seeds nothing')

  const read = promptFor(prompts, 'kb-chain')
  assert.match(read, /node "C:\/plugin\/lib\/kb\.mjs" chain "C:\/repo"/)
  assert.match(read, /"src\/W1\.js" "src\/W2\.js"/)
  assert.match(read, /CHAIN MODE/)
})

test('the chain read runs at courier grade — reading a payload back is not judgment', async () => {
  const { prompts } = await run()
  const read = prompts.find((p) => p.opts.label === 'kb-chain')

  assert.equal(read.opts.agentType, 'agentics:kb')
  assert.equal(read.opts.model, 'haiku')
})

test('a plan with no locus anywhere buys no chain at all', async () => {
  const { prompts } = await run({ plan: plan([order('W1', { locus: [] })]) })

  assert.ok(!labelsOf(prompts).includes('kb-chain'),
    'there is no ground to ask about, and a chain over nothing is a dispatch bought for nothing')
})

test('a run whose orders all go to the session buys no chain either', async () => {
  const { prompts } = await run({
    plan: {
      ...plan([order('W1')]),
      partition_raw: JSON.stringify({ waves: [], coupled: ['W1'] }),
    },
  })

  assert.ok(!labelsOf(prompts).includes('kb-chain'),
    'a coupled order is implemented by the session, which is not dispatched from here')
})

// ── seeding: fresh reaches its own coder, stale reaches nobody ───────────────────────────────

test('a fresh entry reaches the coder working on the ground it is about', async () => {
  const { prompts } = await run({
    'kb-chain': carriedChain({
      'src/W1.js': [{ claim: 'W1 is unimportable under the test runner: it touches window at load' }],
    }),
  })

  const code = promptFor(prompts, 'code:W1')
  assert.match(code, /KNOWN ABOUT THIS GROUND BEFORE THIS RUN/)
  assert.match(code, /unimportable under the test runner/)
  assert.match(code, /Verify before relying on any of them/,
    'the existing wording transfers unchanged: observations, not instructions')
})

test('a stale entry rides nothing — a lead is not worth a coder\'s attention mid-order', async () => {
  const { prompts } = await run({
    'kb-chain': carriedChain({
      'src/W1.js': [
        { claim: 'a claim whose ground has since moved', state: 'stale' },
        { claim: 'a claim about ground that is gone', state: 'orphaned' },
      ],
    }),
  })

  const code = promptFor(prompts, 'code:W1')
  assert.ok(!/ground has since moved/.test(code))
  assert.ok(!/ground that is gone/.test(code))
  assert.ok(!/KNOWN ABOUT THIS GROUND/.test(code),
    'a section with nothing fresh in it is not printed empty')
})

test('an order is seeded from its own chain and not from another order\'s', async () => {
  const orders = [order('W1'), order('W2')]
  const { prompts } = await run({
    plan: plan(orders, [['W1', 'W2']]),
    'kb-chain': carriedChain({
      'src/W1.js': [{ claim: 'a fact about W1 ground' }],
      'src/W2.js': [{ claim: 'a fact about W2 ground' }],
    }),
  })

  assert.match(promptFor(prompts, 'code:W1'), /a fact about W1 ground/)
  assert.ok(!/a fact about W2 ground/.test(promptFor(prompts, 'code:W1')),
    'chains are bounded by path, and so is what a coder is taxed with reading')
})

test('a fix round carries the same chain the first dispatch did', async () => {
  const { prompts } = await run({
    'kb-chain': carriedChain({ 'src/W1.js': [{ claim: 'a fact about W1 ground' }] }),
    'verify:': byLabel({ 'verify:W1': verified({ build: 'failed' }) }, verified()),
    'fix:W1': coded('W1', { status: 'blocked', commits: [], summary: 'cannot fix' }),
  })

  assert.match(promptFor(prompts, 'fix:W1'), /a fact about W1 ground/)
})

// ── the verifier's asymmetry, from both sides ────────────────────────────────────────────────

test('a verify dispatch carries no entry, fresh or otherwise', async () => {
  const { prompts } = await run({
    'kb-chain': carriedChain({
      'src/W1.js': [{ claim: 'a fresh fact nobody should measure anything against' }],
    }),
  })

  const verify = promptFor(prompts, 'verify:W1')
  assert.ok(!/a fresh fact nobody should measure/.test(verify))
  assert.ok(!/KNOWN ABOUT THIS GROUND/.test(verify),
    'a measurement built on hearsay is the one substitution the IRON LAW names outright')
})

test('a command entry reaches the check runner as an argument, not as prose', async () => {
  const { prompts, logs } = await run({
    'kb-chain': carriedChain({
      'src/W1.js': [{
        id: 'command:build', kind: 'command', state: 'fresh',
        claim: 'the build command for this repository is: npm run build',
        source: { runstamp: '20260829-120000', via: 'verify-established' },
        command: { name: 'build', value: 'npm run build', absent: false },
      }],
    }),
  })

  const verify = promptFor(prompts, 'verify:W1')
  assert.match(verify, new RegExp('--build-b64 ' + b64('npm run build')),
    'data for a script, carried the way every other command in this pipeline is carried')
  assert.match(logs.join(' '), /comes from the knowledge base/)
  assert.ok(!labelsOf(prompts).some((l) => l.startsWith('verify-investigate')),
    'the whole point: the run does not buy the investigator a previous run already paid for')
})

test('a command entry the base holds but no verification wrote is never adopted', async () => {
  // The one-way rule, made mechanical. A coder's report can enter the base as a claim; it can
  // never enter it wearing the source that says a measurement established it.
  const { prompts } = await run({
    'kb-chain': carriedChain({
      'src/W1.js': [{
        id: 'command:build', kind: 'command', state: 'fresh',
        claim: 'the build command for this repository is: npm run build',
        source: { runstamp: '20260829-120000', via: 'coder-discovered' },
        command: { name: 'build', value: 'npm run build', absent: false },
      }],
    }),
  })

  const verify = promptFor(prompts, 'verify:W1')
  assert.ok(!new RegExp('--build-b64').test(verify),
    'a wave-1 coder\'s guessed build command becoming a later verdict\'s command is the ' +
    'laundering the asymmetry exists to prevent — durability does not launder it either')
  assert.match(promptFor(prompts, 'code:W1'), /npm run build/,
    'it is still advisory context for a coder, which is what the claim always was')
})

test('a stale command entry is not adopted — the manifests it was read from have moved', async () => {
  const { prompts } = await run({
    'kb-chain': carriedChain({
      'src/W1.js': [{
        id: 'command:build', kind: 'command', state: 'stale',
        claim: 'the build command for this repository is: npm run build',
        source: { runstamp: '20260829-120000', via: 'verify-established' },
        command: { name: 'build', value: 'npm run build', absent: false },
      }],
    }),
  })

  assert.ok(!new RegExp('--build-b64').test(promptFor(prompts, 'verify:W1')))
})

// ── 5b: what the run deposits ────────────────────────────────────────────────────────────────

test('an approved order\'s discoveries are deposited, anchored to its own locus', async () => {
  const { prompts } = await run({
    'code:': () => coded('W1', { discovered: ['the suite needs --pool=forks under this runner'] }),
  })

  const entries = deposited(prompts)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].claim, 'the suite needs --pool=forks under this runner')
  assert.equal(entries[0].kind, 'gotcha')
  assert.deepEqual(entries[0].about, ['src/W1.js'], 'the ground its coder was looking at')
  assert.equal(entries[0].observed_at, A40, 'the run\'s base sha, which is what the run saw')
  assert.equal(entries[0].source.via, 'coder-discovered')
  assert.equal(entries[0].source.order, 'W1')
})

test('an escalated order\'s discoveries stay out — unreviewed claims about a rejecting repo', async () => {
  const orders = [order('W1'), order('W2')]
  const { result, prompts } = await run({
    plan: plan(orders, [['W1', 'W2']]),
    'code:': (p, opts) => coded((opts.label || '').split(':')[1], {
      discovered: ['a fact from ' + (opts.label || '').split(':')[1]],
    }),
    'verify:': byLabel({ 'verify:W2': verified({ build: 'failed' }) }, verified()),
    'fix:W2': coded('W2', { status: 'blocked', commits: [], summary: 'cannot fix' }),
  })

  assert.deepEqual(result.escalations.map((e) => e.id), ['W2'])

  const claims = deposited(prompts).map((e) => e.claim)
  assert.deepEqual(claims, ['a fact from W1'])
})

test('the deposit travels base64 under a digest that covers the whole batch', async () => {
  const { prompts } = await run({
    'code:': () => coded('W1', { discovered: ['a fact worth keeping'] }),
  })

  const carried = recordedLine(promptFor(prompts, 'kb-write'))
  assert.ok(/^[A-Za-z0-9+/=]+$/.test(carried.token),
    'nothing in it for a shell to interpret: no path to escape, no apostrophe to close')
  assert.equal(carried.entry.entries[0].claim, 'a fact worth keeping')
  assert.match(promptFor(prompts, 'kb-write'), /node "C:\/plugin\/lib\/kb\.mjs" append "C:\/repo"/)
  assert.match(promptFor(prompts, 'kb-write'), /You do not choose where an entry lands/)
})

test('a run that learned nothing deposits nothing', async () => {
  const { prompts } = await run()

  assert.ok(!labelsOf(prompts).includes('kb-write'),
    'an empty batch is a dispatch bought to write no entries')
})

// ── the deposit is split to fit a command line, in the script rather than by the courier ─────
//
// A command line is finite and a deposit is as large as the run was interesting. Run
// 20260902-124933 minted ten entries as one 8.1 KB command, Windows truncated it mid-quote, and
// the courier's three attempts — plain, heredoc, script file — each put the same token on the
// same one line and failed identically. Splitting is arithmetic, so it happens here (SR6).

/** Every batch the deposit dispatch carries, decoded, in the order the prompt names them. */
const depositBatches = (prompts) =>
  [...promptFor(prompts, 'kb-write').matchAll(/--digest (\S+) --b64 (\S+)/g)].map((m) => ({
    digest: m[1],
    entries: JSON.parse(Buffer.from(m[2], 'base64').toString('utf8')).entries,
  }))

test('a deposit too large for one command line is split into several, each under its own digest', async () => {
  const long = (n) => 'a fact worth keeping, number ' + n + ', ' + 'x'.repeat(600)
  const { prompts } = await run({
    'code:': () => coded('W1', { discovered: [long(1), long(2), long(3), long(4), long(5)] }),
  })

  const batches = depositBatches(prompts)
  assert.ok(batches.length > 1, 'five long entries do not fit one command line')

  for (const batch of batches) {
    const command = '--digest ' + batch.digest + ' --b64 ' +
      Buffer.from(JSON.stringify({ entries: batch.entries }), 'utf8').toString('base64')
    assert.ok(command.length < 8000, 'every batch fits a command line with room for the rest of it')
    assert.ok(batch.entries.length > 0, 'an empty batch is a command bought to write nothing')
  }

  const claims = batches.flatMap((b) => b.entries.map((e) => e.claim))
  assert.deepEqual(claims, [long(1), long(2), long(3), long(4), long(5)],
    'splitting is a transport decision — every entry still arrives, in the run\'s own order')

  const digests = batches.map((b) => b.digest)
  assert.equal(new Set(digests).size, digests.length,
    'each batch is refused or accepted alone, so each carries a digest over its own entries')
})

test('a deposit that fits stays one command, and the prompt still says ONE line', async () => {
  const { prompts } = await run({
    'code:': () => coded('W1', { discovered: ['a fact worth keeping'] }),
  })

  assert.equal(depositBatches(prompts).length, 1)
  assert.match(promptFor(prompts, 'kb-write'), /Run exactly this, as ONE line/)
})

test('the deposit names the by-path route, because retyping a truncated line never works', async () => {
  const { prompts } = await run({
    'code:': () => coded('W1', { discovered: ['a fact worth keeping'] }),
  })

  const prompt = promptFor(prompts, 'kb-write')
  assert.match(prompt, /--b64-file/,
    'the bottom rung: a path is short whatever the deposit weighs')
  assert.match(prompt, /Do not try a heredoc or a script file/,
    'the two workarounds a courier reaches for first, both of which put the same token on the ' +
    'same one command line')
})

test('the same claim from two orders is deposited once', async () => {
  const orders = [order('W1'), order('W2')]
  const { prompts } = await run({
    plan: plan(orders, [['W1', 'W2']]),
    'code:': (p, opts) => coded((opts.label || '').split(':')[1], {
      discovered: ['the same trap, met twice'],
    }),
  })

  assert.equal(deposited(prompts).length, 1,
    'a claim re-observed word for word mints the same id, and one line is what the base needs')
})

test('a command a verification established this run is deposited as a command entry', async () => {
  const { prompts } = await run({
    'verify:': byLabel({
      'verify:W1': refused('command_unknown', 'no build command was named and none was declared absent'),
    }, verified()),
    'verify-investigate:W1': investigated(),
  })

  const entries = deposited(prompts)
  const build = entries.find((e) => e.id === 'command:build')

  assert.ok(build, 'an established command is written down for the next run')
  assert.equal(build.kind, 'command')
  assert.deepEqual(build.command, { name: 'build', value: 'npm run build', absent: false })
  assert.equal(build.source.via, 'verify-established',
    'the source is the gate the reader checks, so only a verification can write it')
  assert.ok(build.about.includes('package.json'),
    'a build fact is about the files that declare how this repository is built')
  assert.deepEqual(entries.map((e) => e.id).sort(),
    ['command:build', 'command:suite', 'command:test_one'])
})

test('a command adopted from the base is not deposited again', async () => {
  const { prompts } = await run({
    'kb-chain': carriedChain({
      'src/W1.js': [{
        id: 'command:build', kind: 'command', state: 'fresh',
        claim: 'the build command for this repository is: npm run build',
        source: { runstamp: '20260829-120000', via: 'verify-established' },
        command: { name: 'build', value: 'npm run build', absent: false },
      }],
    }),
    'code:': () => coded('W1', { discovered: ['a fact worth keeping'] }),
  })

  assert.deepEqual(deposited(prompts).map((e) => e.kind), ['gotcha'],
    're-writing it would restamp somebody else\'s measurement with this run\'s base sha')
})

// ── the null survey: the first phase whose PRESENCE is derived ───────────────────────────────
//
// Two halves of two kinds. The judgment — is this change's shape settled —
// stays in the caller's seat and arrives as a flag; the arithmetic — does the base cover every
// path the caller named, with entries a program found still standing — is computed here and is
// never anybody's claim. Both must hold. A survey skipped on the strength of leads would be the
// laundering the whole plugin exists to prevent, so the stale case is pinned as hard as the
// firing case.

const GROUND = { ...ARGS, settled_shape: true, ground: ['src/W1.js'] }

/** A run that never reaches the nested survey needs no survey handler to prove it. */
const runGround = (over, args = GROUND) => runWorkflow(WF, {
  args,
  workflow: () => { throw new Error('the survey was invoked') },
  agent: cast({ 'kb-ground': carriedChain({ 'src/W1.js': [{ claim: 'a fact about W1 ground' }] }), ...over }),
})

test('a fully fresh chain over the named ground collapses the survey to nothing', async () => {
  const { result, prompts, logs } = await runGround()

  assert.deepEqual(labelsOf(prompts).filter((l) => l === 'kb-ground'), ['kb-ground'],
    'one chain read decides the whole question')
  assert.match(logs.join(' '), /No survey: the knowledge base covers every named path/)
  assert.deepEqual(result.integration.merged, ['W1'], 'everything downstream runs as it would have')

  // The evidence phase did not run, and this block is the only account of that anybody gets.
  const from = result.coverage.from_kb
  assert.ok(from.length >= 2)
  assert.match(from[0], /no survey phase ran/)
  assert.match(from[0], /NOTHING BELOW WAS RE-SEARCHED BY THIS RUN/)
  assert.match(from[1], /^src\/W1\.js: 1 fresh entry, observed at base1234$/)
  assert.equal(result.coverage.complete, true,
    'nothing was dropped and nothing left unreached — what makes that honest is that the ' +
    'block above says where the evidence came from')
})

test('the chain becomes the planner\'s evidence base, named as recalled rather than searched', async () => {
  const { prompts } = await runGround()
  const plan = promptFor(prompts, 'plan')

  assert.match(plan, /EVIDENCE BASE: THE PROJECT KNOWLEDGE BASE, NOT A SEARCH RUN TODAY/)
  assert.match(plan, /a fact about W1 ground/)
  assert.match(plan, /It is not a search: anything this change needs that these entries do not name/)
  assert.ok(!/no survey evidence was gathered/.test(plan),
    'a run with a fresh chain in hand is not a run planning blind, and saying so would be false')
})

test('a stale chain REFUSES the collapse — a lead is not evidence', async () => {
  const { logs } = await runWorkflow(WF, {
    args: GROUND,
    workflow: () => surveyResult(),
    agent: cast({
      'kb-ground': carriedChain({
        'src/W1.js': [{ claim: 'a claim whose ground has since moved', state: 'stale' }],
      }),
    }),
  })

  assert.match(logs.join(' '), /Surveying in full: the knowledge base does not cover src\/W1\.js/)
  assert.match(logs.join(' '), /1 entry, none fresh — a lead is not evidence/)
})

test('one uncovered path among several refuses the collapse for all of them', async () => {
  const { logs } = await runWorkflow(WF, {
    args: { ...GROUND, ground: ['src/W1.js', 'src/W2.js'] },
    workflow: () => surveyResult(),
    agent: cast({
      'kb-ground': carriedChain({
        'src/W1.js': [{ claim: 'a fact about W1 ground' }],
        'src/W2.js': [],
      }),
    }),
  })

  assert.match(logs.join(' '), /does not cover src\/W2\.js \(nothing recorded for this path, though the base exists\)/,
    'a base that exists and does not know this path is a different fact from no base at all')
  assert.ok(!/No survey:/.test(logs.join(' ')),
    'the ground is what the caller named, all of it — a partial chain covers a partial change')
})

test('a repository with no knowledge base at all is told so, not told its chain is thin',
  async () => {
    // The two refusals used to be one message. A project that has never had a base — this
    // plugin's own repository is one — read every refusal as routine staleness, paid a full
    // survey every run, and had nothing to tell it the feature it was relying on was not
    // installed. Only one of these is a setup fact the user can act on once.
    const { logs } = await runWorkflow(WF, {
      args: { ...GROUND, ground: ['src/W1.js'] },
      workflow: () => surveyResult(),
      agent: cast({ 'kb-ground': carriedChain({ 'src/W1.js': [] }, undefined, false) }),
    })

    const said = logs.join(' ')
    assert.match(said, /NO KNOWLEDGE BASE at \.claude\/agentics\/kb/,
      'the path is named, because that is the whole of what a user needs to act')
    assert.match(said, /cannot fire here for any change/,
      'and that it is about every change, not this one')
    assert.ok(!/nothing recorded for this path/.test(said),
      'the stale-chain wording would read as routine, which is the confusion being removed')
    assert.ok(!/No survey:/.test(said), 'and the collapse still refuses, as it must')
  })

test('a settled shape with no named ground surveys in full and buys no chain', async () => {
  const { prompts } = await runWorkflow(WF, {
    args: { ...ARGS, settled_shape: true },
    workflow: () => surveyResult(),
    agent: cast(),
  })

  assert.ok(!labelsOf(prompts).includes('kb-ground'),
    'with nothing named there is no arithmetic to do, and a chain over nothing decides nothing')
})

test('named ground without the settled-shape judgment surveys in full', async () => {
  const { prompts } = await runWorkflow(WF, {
    args: { ...ARGS, ground: ['src/W1.js'] },
    workflow: () => surveyResult(),
    agent: cast(),
  })

  assert.ok(!labelsOf(prompts).includes('kb-ground'),
    'the judgment half is the caller\'s, and this script never infers it from the paths')
})

test('a ground chain that cannot be read surveys in full rather than assuming either way', async () => {
  const { result, logs } = await runWorkflow(WF, {
    args: GROUND,
    workflow: () => surveyResult(),
    agent: cast({
      'kb-ground': { stop_reason: 'failed', payload_raw: '', notes: 'node is not on the PATH' },
    }),
  })

  assert.match(logs.join(' '), /could not be read.*surveying in full/i)
  assert.deepEqual(result.coverage.from_kb, [],
    'nothing was recalled, and a result that claimed otherwise would be claiming provenance ' +
    'for evidence it does not have')
})

test('a survey that used the base carries that provenance out of the run', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    workflow: () => ({
      ...surveyResult(),
      coverage: {
        ...surveyResult().coverage,
        from_kb: ['loader: 2 fresh knowledge-base entries for src/game, observed at abc1234'],
      },
    }),
    agent: cast(),
  })

  assert.deepEqual(result.coverage.from_kb,
    ['loader: 2 fresh knowledge-base entries for src/game, observed at abc1234'],
    'the evidence phase decides what was recalled; this layer inherits it rather than re-deriving it')
  assert.equal(result.coverage.complete, true)
})

test('a run whose survey named no provenance reads as nothing recalled', async () => {
  // The degrade direction that matters. An older survey carries no `from_kb` at all, and the
  // safe reading of a missing field is "nothing came from cache" — never the reverse.
  const { result } = await run()

  assert.deepEqual(result.coverage.from_kb, [])
})

// ── the side channel degrades, and says so ───────────────────────────────────────────────────

test('a knowledge base that cannot be read costs the run nothing it already paid for', async () => {
  const { result, prompts, logs } = await run({
    'kb-chain': { stop_reason: 'failed', payload_raw: '', notes: 'node is not on the PATH' },
  })

  assert.match(logs.join(' '), /the knowledge base could not be read/)
  assert.ok(result.coverage.failed_channels.includes('kb'))
  assert.equal(result.coverage.complete, true,
    'the base is advisory by construction, and nothing is verified on it')
  assert.deepEqual(result.integration.merged, ['W1'])
  assert.ok(!/KNOWN ABOUT THIS GROUND/.test(promptFor(prompts, 'code:W1')))
})

test('a chain damaged in transit is refused rather than believed', async () => {
  const { result, logs } = await run({
    'kb-chain': carriedChain(
      { 'src/W1.js': [{ claim: 'a fact' }] },
      (env) => { env.payload.chains[0].entries[0].state = 'stale' },
    ),
  })

  assert.match(logs.join(' '), /digest mismatch/)
  assert.ok(result.coverage.failed_channels.includes('kb'))
  assert.equal(result.coverage.complete, true)
})

test('a deposit that cannot be written is reported, not swallowed', async () => {
  const { result, logs } = await run({
    'code:': () => coded('W1', { discovered: ['a fact worth keeping'] }),
    'kb-write': { stop_reason: 'unwritable', path: '', notes: 'the writer refused twice' },
  })

  assert.match(logs.join(' '), /was not deposited in the knowledge base/)
  assert.ok(result.coverage.failed_channels.includes('kb'))
  assert.equal(result.coverage.complete, true,
    'the run did the work; what failed is the record of what it learned while doing it')
})

// ── the standing survey: a design pass's survey, not bought twice ────────────────────────────
//
// Same two halves as the null survey, a different store. The caller's settled shape, and
// lib/effort.mjs's computed answer that the effort's anchored survey reported complete coverage
// and that nothing has touched its ground since. The program decides; the courier carries; the
// planner reads the survey from disk, so its bytes never ride a model.

const EFFORT = { ...ARGS, settled_shape: true, effort: '2026-09-22-a-change' }

const standing = (over = {}) => carriedEnvelope({
  standing: true, why: 'no commit since abc123 reaches the survey\'s ground',
  effort: '2026-09-22-a-change', survey_path: 'C:/repo/.claude/agentics/efforts/e/surveys/s.json',
  stamp: 's', observed_at: 'abc123', head: 'def456', ground: ['src/a', 'src/b'],
  commits_since: [], dirty: [], ...over,
})

test('a standing effort survey collapses the survey, and the planner reads it from disk', async () => {
  const { result, prompts, logs } = await runWorkflow(WF, {
    args: EFFORT,
    workflow: () => { throw new Error('the survey was invoked') },
    agent: cast({ 'effort-standing': standing() }),
  })

  assert.match(logs.join(' '), /No survey: the effort's recorded survey .* stands/)
  const plan = promptFor(prompts, 'plan')
  assert.match(plan, /A SURVEY THIS CHANGE'S DESIGN PASS ALREADY RAN/)
  assert.match(plan, /efforts\/e\/surveys\/s\.json/)
  assert.match(plan, /Anything this change needs outside that ground was not looked for by anybody/)

  const from = result.coverage.from_kb
  assert.match(from[0], /NOTHING WAS RE-SEARCHED BY THIS RUN/)
  assert.match(from[1], /taken at abc123, ground: src\/a, src\/b/)
  assert.equal(result.coverage.complete, true)
})

test('a survey that does not stand is surveyed in full, with the program\'s reason', async () => {
  const { logs, prompts } = await runWorkflow(WF, {
    args: EFFORT,
    workflow: () => surveyResult(),
    agent: cast({
      'effort-standing': standing({ standing: false, why: '2 commit(s) since the survey touch its ground' }),
    }),
  })

  assert.match(logs.join(' '), /does not stand — 2 commit\(s\) since the survey touch its ground/)
  assert.ok(!/DESIGN PASS ALREADY RAN/.test(promptFor(prompts, 'plan')))
})

test('an effort without the settled-shape judgment is never asked about', async () => {
  const { prompts } = await runWorkflow(WF, {
    args: { ...ARGS, effort: '2026-09-22-a-change' },
    workflow: () => surveyResult(),
    agent: cast(),
  })

  assert.ok(!labelsOf(prompts).includes('effort-standing'),
    'the shape is the caller\'s judgment; the tree check alone never skips a phase')
})

test('an unreadable standing answer surveys in full rather than assuming either way', async () => {
  const { logs } = await runWorkflow(WF, {
    args: EFFORT,
    workflow: () => surveyResult(),
    agent: cast({ 'effort-standing': { stop_reason: 'failed', payload_raw: '', notes: 'no node' } }),
  })

  assert.match(logs.join(' '), /could not be checked .*surveying in full/)
})
