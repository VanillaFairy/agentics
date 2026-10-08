// test/agentics-find-existing-solutions-scenarios.test.mjs — executes the build-or-adopt sweep
// through the harness with scripted agents.
//
// One mechanism here matters more than the rest, and most of these scenarios are about it:
// **an empty candidate list means two opposite things.** After an exhausted search it says
// "nothing exists, build it". After a search that never opened the registry it says nothing
// at all. Everywhere else in this plugin an incomplete search weakens a conclusion; here it can
// license weeks of writing code that already exists. So the coverage derivation is the unit
// under test, not a footnote to it.
//
// What the candidates are and which are viable is decided by lib/evidence.mjs from the files the
// agents wrote (test/evidence-returns.test.mjs); here the record courier answers with lib's counts,
// and the scenarios pin what the workflow hands it and what it makes of the answer.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import {
  WROTE, carriedEnvelope, contextPath, courierCommand, courierProblems, flagValues, returnFileOf, runWorkflow, scriptedAgents,
} from './fast/harness/workflow-host.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import { nameKey } from '../lib/store.mjs'
import { overruns } from './fast/harness/path-limits.mjs'

const WF = fileURLToPath(new URL('../service-workflows/search-for-existing-solutions-before-building.workflow.js', import.meta.url))

const ARGS = { capability: 'rate-limit inbound HTTP requests per API key', roots: '.' }

const frame = (keys = ['stdlib', 'registry']) => ({ angles: keys.map((key) => ({ key })) })
const found = (n = 1, over = {}) => ({ candidates_n: n, stop_reason: 'exhausted', no_match: '', not_reached: '', ...over })
const scouted = (n = 0, over = {}) => ({ hits_n: n, stop_reason: 'exhausted', no_match: '', not_reached: '', ...over })

const COUNTS = { present: 0, candidates: 1, viable: 1, ruled_out: 0, invented: 0, lost: 0, unanchored: 0, unread: 0, unsettled: 0, present_read: 1 }
const SUMMARY = contextPath('summary')
const decided = (counts = {}, over = {}) => carriedEnvelope({
  recorded: true, return: '20260926-120000-solutions', items: [{ id: 'I0000000a', topic: 'candidates', kind: 'external' }],
  refused_n: 0, refusals_file: '', summary_file: SUMMARY, measured: true, counts: { ...COUNTS, ...counts }, ...over,
})

// Overrides go in FIRST, then the defaults fill the gaps. `scriptedAgents` takes the first
// key that matches, and the default `'find:'` is a PREFIX.
const happy = (over = {}) => scriptedAgents({
  frame: frame(), 'find:': found(), repo: scouted(), assess: { assessed_n: 1 }, record: decided(), ...over,
})

const run = (opts) => runWorkflow(WF, { args: ARGS, ...opts })
const byLabel = (prompts, l) => (prompts.find((p) => p.opts.label === l) || {}).prompt || ''
const failedCourier = { stop_reason: 'failed', payload_raw: '', notes: 'node is not on the PATH' }

// The dial reaches here for the same reason it reaches investigate: one derivation rule, shared
// verbatim by every skill that passes `intelligence`.
test('the framing and assessing analysts follow the dial; the search tier does not', async () => {
  const tiersAt = async (intelligence) => {
    const { prompts } = await run({ args: { ...ARGS, intelligence }, agent: happy() })
    const at = (label) => {
      const { model, effort } = prompts.find((p) => p.opts.label === label).opts
      return `${model}/${effort}`
    }
    return { frame: at('frame'), assess: at('assess'), find: at('find:stdlib') }
  }

  assert.deepEqual(await tiersAt('low'), { frame: 'sonnet/high', assess: 'sonnet/xhigh', find: 'undefined/low' })
  assert.deepEqual(await tiersAt('normal'), { frame: 'opus/medium', assess: 'opus/medium', find: 'undefined/low' })
  assert.deepEqual(await tiersAt('max'), { frame: 'opus/high', assess: 'opus/high', find: 'undefined/low' })
  assert.deepEqual(await tiersAt(undefined), { frame: 'opus/medium', assess: 'opus/medium', find: 'undefined/low' })
})

// --- what travels where ----------------------------------------------------------------------

test('every agent writes its return file, and the one courier hands lib all of them, handles only', async () => {
  const { prompts, result } = await run({ agent: happy() })
  const file = (l) => returnFileOf(byLabel(prompts, l))
  for (const l of ['frame', 'find:stdlib', 'find:registry', 'repo', 'assess']) {
    assert.match(file(l), /^\.\/\.agentics\/\.state\/evidence\/inbox\/[A-Za-z0-9._-]+-[0-9a-f]{8}\.json$/, l)
  }
  assert.deepEqual(courierProblems(prompts), [])

  const command = courierCommand(byLabel(prompts, 'record'))
  assert.match(command, /^node "\$CLAUDE_PLUGIN_ROOT\/lib\/evidence\.mjs" record --repo "\." --root "\." --kind solutions /)
  assert.deepEqual(flagValues(command, 'frame'), [file('frame')])
  assert.deepEqual(flagValues(command, 'question-digest'), [fnv1a(ARGS.capability)])
  assert.deepEqual(flagValues(command, 'assessed'), [file('assess')])
  assert.deepEqual(flagValues(command, 'present'), [file('repo')])
  assert.deepEqual(flagValues(command, 'from'), [file('find:stdlib'), file('find:registry')])

  assert.deepEqual([result.frame, result.summary, result.measured, result.recorded], [file('frame'), SUMMARY, true, true])
  assert.deepEqual(result.items, [{ id: 'I0000000a', topic: 'candidates', kind: 'external' }])
  assert.equal(result.coverage.complete, true)
})

test('the frame is a file every later agent reads, and the store checks its capability', async () => {
  const { prompts } = await run({ agent: happy() })
  const frameFile = returnFileOf(byLabel(prompts, 'frame'))
  assert.match(byLabel(prompts, 'frame'), /Copy the CAPABILITY into the file exactly/)
  assert.ok(byLabel(prompts, 'find:stdlib').includes(`Read the frame file ${frameFile}`))
  assert.ok(byLabel(prompts, 'find:stdlib').includes('the angle keyed "stdlib"'))
  assert.ok(byLabel(prompts, 'repo').includes(frameFile))
  assert.ok(byLabel(prompts, 'assess').includes(frameFile))
  for (const l of ['find:stdlib', 'find:registry']) assert.ok(byLabel(prompts, 'assess').includes(returnFileOf(byLabel(prompts, l))))
})

test('the prompts carry the clauses that keep the search honest', async () => {
  const { prompts } = await run({ agent: happy() })
  assert.match(byLabel(prompts, 'frame'), /ANY implementation of it would qualify/)
  assert.match(byLabel(prompts, 'frame'), /standard library/)
  assert.match(byLabel(prompts, 'find:stdlib'), /listicle/)
  assert.match(byLabel(prompts, 'find:stdlib'), /TODAY/)
  assert.match(byLabel(prompts, 'repo'), /dependency manifests/)
  assert.match(byLabel(prompts, 'assess'), /VERBATIM/)
  assert.match(byLabel(prompts, 'assess'), /caller's decision/)
})

test('no analyst here is asked to search, and none is dispatched with a search agent type', async () => {
  const { prompts } = await run({ agent: happy() })
  const opts = (l) => prompts.find((p) => p.opts.label === l).opts
  assert.match(byLabel(prompts, 'frame'), /nothing that searches/)
  assert.match(byLabel(prompts, 'assess'), /you have no search tools/)
  for (const label of ['frame', 'assess']) assert.equal(opts(label).agentType, 'agentics:analyst')
  assert.equal(opts('repo').agentType, 'agentics:scout')
})

// --- what lib decided, accounted for ---------------------------------------------------------

test('a candidate the assessor dropped, a ground nobody declared, and what could not be settled all travel', async () => {
  const { result } = await run({ agent: happy({ record: decided({ lost: 1, invented: 2, unsettled: 1 }) }) })
  const unreached = result.coverage.unreached.join(' | ')
  assert.match(unreached, /1 candidate\(s\) were found but never ruled on/)
  assert.match(unreached, /2 ground\(s\) the assessment cited are not in the frame's disqualifier list/)
  assert.match(unreached, /could not settle questions/)
  assert.ok(result.coverage.unreached.every((u) => !/never ruled|disqualifier list|could not settle/.test(u) || u.includes(SUMMARY)),
    'each names the summary file that holds what it is about')
  assert.equal(result.coverage.complete, false)
})

test('an assessment that never ran: lib carries the candidates unmeasured, and the emptiness is explained', async () => {
  const { result, prompts, logs } = await run({
    agent: happy({ assess: () => { throw new Error('budget') }, record: decided({ viable: 0 }, { measured: false }) }),
  })
  assert.deepEqual(flagValues(courierCommand(byLabel(prompts, 'record')), 'assessed'), [], 'no assessment file is handed over')
  assert.ok(result.coverage.failed_channels.includes('assess'))
  assert.ok(result.coverage.unreached.some((u) => /neither viable nor ruled out, because nobody checked/.test(u)))
  assert.equal(result.coverage.complete, false)
  assert.ok(logs.some((l) => /INCOMPLETE SWEEP WITH NO VIABLE CANDIDATE/.test(l)))
})

test('a sweep that cannot be read back holds no verdict, fails coverage, and says nothing was recorded', async () => {
  const { result } = await run({ agent: happy({ record: failedCourier, 'record#2': failedCourier }) })
  assert.ok(result.coverage.failed_channels.includes('record'))
  assert.equal(result.coverage.complete, false)
  assert.deepEqual([result.summary, result.items, result.counts.viable], ['', [], 0])
})

test('a refused batch is named in the log, not retried, and costs no coverage', async () => {
  const { result, prompts, logs } = await run({
    agent: happy({ record: decided({}, { recorded: false, return: '', items: [], refused_n: 2, refusals_file: contextPath('refused') }) }),
  })
  assert.equal(prompts.filter((p) => /^record/.test(p.opts.label)).length, 1)
  assert.equal(result.recorded, false)
  assert.equal(result.coverage.complete, true)
  assert.ok(logs.some((l) => l.includes('2 item(s) refused') && l.includes(contextPath('refused'))))
})

test('a handle the store refused as damaged is carried again by the stronger courier', async () => {
  const { prompts } = await run({ agent: happy({ record: carriedEnvelope({ ok: false, error: { kind: 'args_unreadable' } }), 'record#2': decided() }) })
  assert.deepEqual(prompts.filter((p) => /^record/.test(p.opts.label)).map((p) => p.opts.model), ['haiku', 'sonnet'])
})

test('a sweep run from a linked worktree hands lib files and a root under the worktree', async () => {
  const { prompts } = await run({ args: { ...ARGS, roots: 'C:/wt/e1-a', plugin_root: 'C:/plugin' }, agent: happy() })
  assert.match(courierCommand(byLabel(prompts, 'record')), /^node "C:\/plugin\/lib\/evidence\.mjs" record --repo "C:\/wt\/e1-a" --root "C:\/wt\/e1-a" --kind solutions /)
  assert.match(returnFileOf(byLabel(prompts, 'repo')), /^C:\/wt\/e1-a\/\.agentics\/\.state\/evidence\/inbox\//)
})

// --- an empty result means two opposite things ----------------------------------------------

test('an exhausted search that found nothing says what it covered, and keeps complete false', async () => {
  const { result } = await run({
    agent: happy({ 'find:': found(0, { no_match: 'no maintained npm package does per-key limiting' }), record: decided({ candidates: 0, viable: 0 }) }),
  })
  assert.ok(result.coverage.unreached.some((u) => /^stdlib searched and did not find what \S+ name under no_match$/.test(u)))
  assert.equal(result.coverage.complete, false, 'a no_match line is a finding worth reading, never a silent empty list')
})

// A resumed round is labelled `find:<key>#2`, so per-angle scripting across rounds dispatches on
// the label inside one handler.
const byAngle = (stdlib, registry) => (prompt, opts) =>
  opts.label.startsWith('find:stdlib') ? stdlib(prompt, opts) : registry(prompt, opts)

test('an unexhausted angle is carried as never-reached, worded apart from found-nothing', async () => {
  const { result } = await run({
    agent: happy({
      'find:': byAngle(() => found(0), () => found(0, { stop_reason: 'unfinished', not_reached: 'crates.io and PyPI' })),
    }),
  })
  assert.ok(result.coverage.incomplete.includes('registry'))
  assert.ok(result.coverage.unreached.some((u) => /^registry never reached what \S+ names under not_reached$/.test(u)))
  assert.ok(!result.coverage.unreached.some((u) => /registry searched and did not find/.test(u)))
  assert.ok(result.coverage.resumable.remaining.includes('registry'))
})

test('an unexhausted angle is resumed from its own report rather than reported', async () => {
  let rounds = 0
  const { result, prompts } = await run({
    agent: happy({
      'find:': byAngle(() => found(1), () => (++rounds === 1 ? found(0, { stop_reason: 'unfinished', not_reached: 'crates.io' }) : found(1))),
    }),
  })
  assert.equal(rounds, 2, 'IL1: an incomplete search is resumed, not reported')
  const resumed = byLabel(prompts, 'find:registry#2')
  assert.match(resumed, /do not start over[\s\S]*STILL NOT REACHED — this is your job now: what the last of those reports names under not_reached/)
  assert.ok(resumed.includes(returnFileOf(byLabel(prompts, 'find:registry'))))
  assert.equal(flagValues(courierCommand(byLabel(prompts, 'record')), 'from').length, 3, 'both rounds\' reports reach lib')
  assert.equal(result.coverage.complete, true)
})

test('an angle that stops without naming what it missed is a dead end, not another round', async () => {
  let rounds = 0
  const { result } = await run({
    agent: happy({ 'find:': byAngle(() => found(1), () => { rounds += 1; return found(0, { stop_reason: 'stuck', not_reached: '' }) }) }),
  })
  assert.equal(rounds, 1)
  assert.ok(result.coverage.unreached.some((u) => /stopped "stuck" without naming it/.test(u)))
  assert.equal(result.coverage.complete, false)
})

test('a researcher round is read from the report it wrote, not from what it echoed back', async () => {
  let rounds = 0
  const { result } = await run({
    agent: happy({
      'find:': byAngle(() => found(1), () => (++rounds === 1
        ? { ...found(1), [WROTE]: found(1, { stop_reason: 'unfinished', not_reached: 'crates.io' }) }
        : found(1))),
    }),
  })
  assert.equal(rounds, 2, 'an echoed "exhausted" over an unfinished report is resumed')
  assert.equal(result.coverage.complete, true)
})

test('a repo scan that echoes "exhausted" over a report that says otherwise is partial', async () => {
  const { result } = await run({
    agent: happy({ repo: { ...scouted(1), [WROTE]: scouted(1, { stop_reason: 'unfinished', not_reached: 'vendor/' }) } }),
  })
  assert.ok(result.coverage.incomplete.includes('repo'))
  assert.ok(result.coverage.unreached.some((u) => /^the repository scan never reached what \S+ names under not_reached/.test(u)))
})

// --- the repo channel: the cheapest answer, and a real side channel --------------------------

test('what the repository already carries is counted and its file reaches lib', async () => {
  const { result, logs } = await run({ agent: happy({ repo: scouted(1), record: decided({ present: 1 }) }) })
  assert.equal(result.counts.present, 1)
  assert.ok(logs.some((l) => /ALREADY IN THE TREE: 1 hit/.test(l)))
  assert.equal(result.coverage.complete, true)
})

test('a failed repo scan degrades the run, says the claim is unsupported, and hands lib no scan', async () => {
  const { result, prompts } = await run({ agent: happy({ repo: () => { throw new Error('grep exploded') } }) })
  assert.ok(result.coverage.failed_channels.includes('repo'))
  assert.ok(result.coverage.unreached.some((u) => /already depend on something that does this/.test(u)))
  assert.deepEqual(flagValues(courierCommand(byLabel(prompts, 'record')), 'present'), [])
  assert.equal(result.coverage.complete, false)
})

test('a repo scan whose report lib could not read is a failed channel too', async () => {
  const { result } = await run({ agent: happy({ record: decided({ present_read: 0 }) }) })
  assert.ok(result.coverage.failed_channels.includes('repo'))
})

// --- framing failures ------------------------------------------------------------------------

test('no framing means no search, and the result says so rather than reading as empty', async () => {
  const { result, prompts } = await run({ agent: scriptedAgents({ frame: () => { throw new Error('budget') } }) })
  assert.ok(result.coverage.failed_channels.includes('frame'))
  assert.ok(result.coverage.unreached.some((u) => /says nothing about whether an existing solution exists/.test(u)))
  assert.ok(!prompts.some((p) => (p.opts.label || '').startsWith('find:')))
  assert.deepEqual([result.frame, result.summary, result.items], ['', '', []])
})

test('angles beyond the cap are dropped by name, never silently', async () => {
  const { result } = await run({ args: { ...ARGS, max_angles: 2 }, agent: happy({ frame: frame(['a', 'b', 'c', 'd']) }) })
  assert.deepEqual(result.coverage.dropped, ['c', 'd'])
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.resumable.remaining.includes('c'))
})

test('no capability supplied searches nothing and says nothing was searched', async () => {
  const { result, prompts } = await runWorkflow(WF, { args: { roots: '.' }, agent: scriptedAgents({}) })
  assert.deepEqual(prompts, [])
  assert.equal(result.coverage.complete, false)
  assert.match(result.coverage.unreached[0], /no capability was supplied/)
})

test('no researcher report means no assessor is dispatched, and lib still decides', async () => {
  const { prompts } = await run({ agent: happy({ 'find:': () => null }) })
  assert.ok(!prompts.some((p) => p.opts.label === 'assess'))
  assert.ok(prompts.some((p) => p.opts.label === 'record'), 'what the repository carries is still read and recorded')
})

test('a researcher on a long angle writes to a return file that fits on Windows', async () => {
  const root = 'C:/Users/firstname.lastname/source/repos/project-name'
  const angle = 'token-bucket-rate-limiters-in-maintained-http-middleware-packages'
  const { prompts } = await runWorkflow(WF, { args: { ...ARGS, roots: root }, agent: happy({ frame: frame([angle]) }) })
  const label = 'find:' + angle
  assert.ok(returnFileOf(byLabel(prompts, label)).startsWith(root + '/.agentics/.state/evidence/inbox/' +
    nameKey(label.replace(/[^A-Za-z0-9.-]+/g, '-')) + '-'))
  for (const p of prompts.filter((x) => returnFileOf(x.prompt))) assert.deepEqual(overruns(returnFileOf(p.prompt)), [], p.opts.label)
})
