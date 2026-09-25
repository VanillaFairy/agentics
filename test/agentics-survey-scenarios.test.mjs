// test/agentics-survey-scenarios.test.mjs — the survey workflow's accounting arithmetic, executed.
//
// Lint judges form and cannot reach any of this: whether a channel nobody ran is recorded,
// whether a verdict is matched to its topic by position or by a string the model retyped,
// whether a half-finished channel still reports complete. Each test below pins a way a
// PARTIAL result could come back wearing the shape of a WHOLE one (IL2) — three of
// them were live defects, found by diffing against the sibling `investigate` plugin that had
// already been through a field run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import {
  carriedContext, carriedEnvelope, contextPathFor, contextPayload, excerptLocations, runWorkflow, scriptedAgents,
} from './harness/workflow-host.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'

const WF = fileURLToPath(new URL('../workflows/agentics-survey.workflow.js', import.meta.url))

const PLAN = (over = {}) => ({
  topics: [{ key: 'a', find: 'find a', subtree: 'src/a' }],
  docs_needed: false, docs_question: '',
  history_needed: false, history_question: '',
  ...over,
})

const HITS = (over = {}) => ({
  hits: [{ path: 'src/x.js', line: 1, note: 'the thing' }],
  searched: ['grep thing'], stop_reason: 'exhausted', no_match: '', not_reached: '',
  ...over,
})

const EVIDENCE = (over = {}) => ({
  findings: 'what the channel established',
  searched: ['git log -S thing'], stop_reason: 'exhausted', no_match: '', not_reached: '',
  ...over,
})

const VERDICT = (topic) => ({ topic, conclusion: 'c', evidence: ['src/x.js:1'], risks: [] })

/** The topic keys a judge dispatch was given — its schema's closed enum. */
const keysOf = (opts) => opts.schema.properties.verdicts.items.properties.topic.enum

/** A judge that rules on every topic it holds. */
const judgeAll = (prompt, opts) => ({ verdicts: keysOf(opts).map(VERDICT) })

const resolveAll = carriedContext
const locationsIn = excerptLocations

// Every survey that finds a location resolves it and judges it, so every scenario scripts the
// courier and the judge with the ordinary case — every location read, every topic ruled on —
// which is what keeps the tests below about the thing each one is testing.
const run = (script, over = {}) => runWorkflow(WF, {
  args: { question: 'how does X work', plugin_root: 'C:/plugin', ...over },
  agent: scriptedAgents({
    assemble: resolveAll, 'assemble:': resolveAll, judge: judgeAll, 'judge:': judgeAll, ...script,
  }),
})

const promptFor = (prompts, label) => (prompts.find((p) => p.opts.label === label) || {}).prompt || ''
const labelsOf = (prompts) => prompts.map((p) => p.opts.label || '')

// ------------------------------------------- the intelligence dial

// `develop` forwards its own dial into this nested call, so a run dialled to `low` reaches
// its analysis here and nowhere else. The dial is only real where it reaches an `opts.model`.
test('`low` puts the analysts on sonnet and leaves the search tier alone', async () => {
  const { prompts } = await run(
    { plan: PLAN(), 'scout:': HITS() },
    { intelligence: 'low' },
  )
  const modelOf = (label) => prompts.find((p) => p.opts.label === label).opts.model

  assert.equal(modelOf('plan'), 'sonnet', 'the analyst that plans the topics is a judging agent')
  assert.equal(modelOf('judge'), 'sonnet', 'and so is the one that rules on each')
  assert.equal(modelOf('scout:a'), undefined, 'search never moves with the dial')
})

test('`normal` names opus rather than inheriting it', async () => {
  const { prompts } = await run(
    { plan: PLAN(), 'scout:': HITS() },
    { intelligence: 'normal' },
  )
  const modelOf = (label) => prompts.find((p) => p.opts.label === label).opts.model

  assert.equal(modelOf('plan'), 'opus')
  assert.equal(modelOf('judge'), 'opus')
  assert.equal(modelOf('scout:a'), undefined, 'the search tier is not on the dial')
})

test('a tier this script does not define is served as normal, not as itself', async () => {
  const { prompts } = await run(
    { plan: PLAN(), 'scout:': HITS() },
    { intelligence: 'cheap' },
  )

  assert.equal(prompts.find((p) => p.opts.label === 'plan').opts.model, 'opus',
    'an unrecognised tier that dispatches at one tier while the caller reports the one it ' +
    'typed is a run billed at one price and described at another')
})

// ------------------------------------------- a requested channel that produced nothing

test('a channel marked necessary with no question is a failure, not a silent skip', async () => {
  const { result, logs } = await run({
    plan: PLAN({ history_needed: true, history_question: '   ' }),
    'scout:': HITS(),
  })

  // The planner asked for history and then named no question, so nothing was searched. If
  // that reads as "not requested", the run comes back complete with the history evidence
  // simply absent — which is the exact shape of a finished investigation.
  assert.deepEqual(result.coverage.failed_channels, ['history'])
  assert.equal(result.coverage.complete, false)
  assert.equal(result.history, null)
  assert.ok(logs.some((l) => /marked necessary but the planner produced no question/i.test(l)),
    'the vanished channel must be logged, not just recorded')
})

test('a channel that throws is recorded without discarding the work already paid for', async () => {
  const { result } = await run({
    plan: PLAN({ docs_needed: true, docs_question: 'what does the vendor say' }),
    'scout:': HITS(),
    docs: () => { throw new Error('network is down') },
  })

  assert.deepEqual(result.coverage.failed_channels, ['docs'])
  assert.equal(result.docs, null)
  assert.equal(result.verdicts.length, 1, 'a failed channel must not empty the verdicts')
})

// ---------------------------------------------------------------- reconciliation

test('a lone topic\'s verdict is that topic\'s, whatever key the judge echoed', async () => {
  const { result } = await run({
    plan: PLAN({ topics: [{ key: 'a', find: 'find a' }, { key: 'b', find: 'find b' }] }),
    'scout:': HITS(),
    'judge:a': { verdicts: [VERDICT('typo-not-a')] },
  }, { pace: 'fast' })

  // Matching on the echoed string counted this verdict as evidence AND its topic as dropped,
  // at the same time: the answer was built on both topics while reporting one as missing.
  assert.equal(result.verdicts.length, 2)
  assert.equal(result.verdicts[0].topic, 'a')
  assert.deepEqual(result.coverage.dropped, [])
  assert.equal(result.coverage.complete, true)
})

test('a verdict under a key the judge was not given is evidence for nothing', async () => {
  const { result, prompts } = await run({
    plan: PLAN({ topics: [{ key: 'a', find: 'find a' }, { key: 'b', find: 'find b' }] }),
    'scout:': HITS(),
    judge: { verdicts: [VERDICT('b'), VERDICT('invented')] },
    'judge#2': { verdicts: [] },
  })

  assert.deepEqual(result.verdicts.map((v) => v.topic), ['b'])
  assert.deepEqual(result.coverage.dropped, ['a'])
  assert.equal(result.coverage.complete, false)
  assert.ok(prompts.some((p) => p.opts.label === 'judge#2'), 'the unruled topic is continued first')
})

test('a topic whose judge fails is dropped exactly once and fails coverage', async () => {
  const { result } = await run({
    plan: PLAN({ topics: [{ key: 'a', find: 'find a' }, { key: 'b', find: 'find b' }] }),
    'scout:': HITS(),
    'judge:a': () => { throw new Error('analyst died') },
  }, { pace: 'fast' })

  assert.equal(result.verdicts.length, 1)
  assert.deepEqual(result.coverage.dropped, ['a'])
  assert.deepEqual(result.coverage.incomplete, [], 'a dropped topic must not also count as incomplete')
  assert.equal(result.coverage.complete, false)
})

// ---------------------------------------------------------------- the resume loop

test('the resume round is handed what was never reached, not what was proven absent', async () => {
  const { result, prompts } = await run({
    plan: PLAN(),
    'scout:a#2': HITS({ searched: ['grep legacy'] }),
    'scout:a': HITS({
      stop_reason: 'unfinished',
      no_match: 'nothing under tests/',
      not_reached: 'src/legacy/ was never opened',
    }),
  })

  const resume = prompts.find((p) => p.opts.label === 'scout:a#2')
  assert.ok(resume, 'a non-exhausted scout must be resumed rather than reported')
  assert.match(resume.prompt, /STILL NOT REACHED[\s\S]*src\/legacy\/ was never opened/)
  assert.doesNotMatch(resume.prompt, /nothing under tests\//,
    're-sending proven-absent ground buys a second search of a place already known to be empty')

  // Round 2 exhausted, so the topic really is complete.
  assert.equal(result.coverage.complete, true)
})

test('what a scout proved absent reaches the analyst as evidence of absence', async () => {
  const { prompts } = await run({
    plan: PLAN(),
    'scout:a': HITS({ no_match: 'nothing under tests/' }),
  })

  const judged = promptFor(prompts, 'judge')
  assert.match(judged, /SEARCHED AND NOT FOUND \(this is evidence of absence\)/)
  assert.match(judged, /nothing under tests\//)
})

test('a search still finding new ground is resumed past any round count', async () => {
  const rounds = 5
  const { result, prompts } = await run({
    plan: PLAN(),
    'scout:': (prompt, opts) => {
      // Labels run scout:a, scout:a#2 … scout:a#5, so the round is read off the label.
      const suffix = /#(\d+)$/.exec(String(opts.label))
      const r = suffix ? Number(suffix[1]) : 1
      return r < rounds
        ? HITS({ searched: [`grep pass ${r}`], stop_reason: 'unfinished', not_reached: `surface ${r + 1}` })
        : HITS({ searched: [`grep pass ${r}`] })
    },
  })

  // The old loop cut this search off after 3 rounds and reported the topic incomplete —
  // a budget wearing the name of a threshold. Progress is the only licence to continue,
  // and while it holds, no counter may end the search (IL1).
  const scoutCalls = prompts.filter((p) => String(p.opts.label).startsWith('scout:'))
  assert.equal(scoutCalls.length, rounds)
  assert.equal(result.coverage.complete, true)
})

test('a resumed round that covers no new ground ends the loop as stuck, not another round', async () => {
  const { result, prompts, logs } = await run({
    plan: PLAN(),
    'scout:': HITS({ stop_reason: 'unfinished', not_reached: 'src/legacy/ was never opened' }),
  })

  // Every round returns the identical hits and searched surface, so round 2 gains nothing.
  // Without the progress gate this is the loop that never converges; with it, the second
  // round is the proof of stuckness and there is no third.
  const scoutCalls = prompts.filter((p) => String(p.opts.label).startsWith('scout:'))
  assert.equal(scoutCalls.length, 2)
  assert.deepEqual(result.coverage.incomplete, ['a'])
  assert.equal(result.coverage.complete, false)
  assert.ok(logs.some((l) => /brought back nothing new/.test(l)))
})

test('a scout that rewords its account of the same ground is stuck, not progressing', async () => {
  // The signature of the loop that does not converge. Every round finds the SAME hit and
  // leaves the SAME ground unreached, but obeys "do not repeat yourself" by describing its
  // search differently each time. Counting those fresh descriptions as progress resumed such
  // a scout until something outside the workflow killed it.
  let round = 0
  const { result, prompts, logs } = await run({
    plan: PLAN(),
    'scout:': () => {
      round++
      return HITS({
        searched: [`pass ${round}: looked through the legacy tree`],
        stop_reason: 'unfinished',
        not_reached: 'src/legacy/ was never opened',
      })
    },
  })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:')).length, 2,
    'new prose about old ground is not new ground')
  assert.ok(logs.some((l) => /brought back nothing new/.test(l)))
  assert.deepEqual(result.coverage.incomplete, ['a'])
})

test('a round that narrows the remainder keeps going even with no new hits', async () => {
  // The other half of the rule. A round can legitimately come back empty-handed and still
  // have advanced — it looked at an area, found nothing there, and that area leaves the
  // remainder. Stopping on "no new hits" alone would cut those searches short.
  const remainders = ['src/legacy/ and src/vendor/', 'src/vendor/ only', '']
  let round = 0
  const { prompts } = await run({
    plan: PLAN(),
    'scout:': () => {
      const not_reached = remainders[Math.min(round++, remainders.length - 1)]
      return HITS({
        hits: [], searched: ['same search every time'],
        stop_reason: not_reached ? 'unfinished' : 'exhausted',
        not_reached,
      })
    },
  })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:')).length, 3,
    'a shrinking remainder is progress even when nothing new is found')
})

test('every planned topic is searched — the topic cap guides the planner, it never drops work', async () => {
  const topics = ['a', 'b', 'c'].map((k) => ({ key: k, find: 'find ' + k }))
  const { result, prompts, logs } = await run({
    plan: PLAN({ topics }),
    'scout:': HITS(),
  }, { max_topics: 2 })

  // Slicing the overflow off left planned topics unsearched while every later stage read
  // the result as the evidence base. The cap stays in the planner's prompt as sizing
  // guidance; what the planner decided the question needs is searched, all of it.
  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:')).length, 3)
  assert.deepEqual(result.coverage.dropped, [])
  assert.equal(result.coverage.complete, true)
  assert.ok(logs.some((l) => /searching all of them/.test(l)))
})

test('a scout that stops without naming what it missed is a dead end, not a resume', async () => {
  const { result, prompts } = await run({
    plan: PLAN(),
    'scout:a': HITS({ stop_reason: 'stuck', not_reached: '   ' }),
  })

  // Another round would be handed an empty task and would return "exhausted" having done
  // nothing — paying for a round that launders truncation into completeness.
  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:')).length, 1)
  assert.deepEqual(result.coverage.incomplete, ['a'])
  assert.equal(result.coverage.complete, false)
})

// ------------------------------------------------------ omitted coverage fields
//
// The schema requires only the payload field; the coverage fields are normalized here in
// JS. The failure this guards: an exhausted scout read "must be non-empty when not
// exhausted" as "must be non-empty", omitted the field it had nothing for, and the
// validator rejected the same finished search five times until the agent died with all
// its evidence. Absence must degrade toward incomplete, never toward false completeness —
// and never toward a dropped result.

test('an exhausted report missing the empty coverage fields is complete, not dropped', async () => {
  const { result } = await run({
    plan: PLAN(),
    'scout:': { hits: [{ path: 'src/x.js', line: 1, note: 'the thing' }], stop_reason: 'exhausted' },
  })

  assert.equal(result.verdicts.length, 1)
  assert.deepEqual(result.coverage.incomplete, [])
  assert.equal(result.coverage.complete, true)
})

test('a report with no stop_reason at all reads as incomplete, never as exhausted', async () => {
  const { result } = await run({
    plan: PLAN(),
    'scout:': { hits: [{ path: 'src/x.js', line: 1, note: 'the thing' }] },
  })

  assert.equal(result.verdicts.length, 1, 'the evidence gathered is kept and analyzed')
  assert.deepEqual(result.coverage.incomplete, ['a'])
  assert.equal(result.coverage.complete, false)
})

test('a channel that returns only findings keeps its evidence and reads as incomplete', async () => {
  const { result } = await run({
    plan: PLAN({ history_needed: true, history_question: 'when did X change' }),
    'scout:': HITS(),
    history: { findings: 'the vendor moved the API in 2024' },
  })

  assert.deepEqual(result.coverage.failed_channels, [])
  assert.ok(result.coverage.incomplete.includes('history'))
  assert.equal(result.coverage.complete, false)
  assert.match(result.history, /the vendor moved the API in 2024/)
  assert.match(result.history, /COVERAGE LIMIT \(unfinished\)/)
})

// ------------------------------------------------------ evidence-channel coverage

test('a channel that cannot finish makes coverage incomplete, after the resume is spent', async () => {
  // Both rounds return the identical evidence, so the resume gains no new ground and the
  // channel genuinely cannot finish — the case that must surface as incomplete.
  const stalled = EVIDENCE({ stop_reason: 'unfinished', not_reached: 'every ref older than 2024' })
  const { result, prompts } = await run({
    plan: PLAN({ history_needed: true, history_question: 'when did X change' }),
    'scout:': HITS(),
    history: stalled,
    'history#2': stalled,
  })

  // Truncated is neither failed nor finished. Before the channels carried a stop_reason this
  // was invisible in JS, and a half-read history came back complete.
  assert.ok(prompts.some((p) => p.opts.label === 'history#2'),
    'an unfinished channel is resumed before it may be reported')
  assert.deepEqual(result.coverage.failed_channels, [])
  assert.ok(result.coverage.incomplete.includes('history'))
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.resumable.remaining.includes('history'),
    'a truncated channel is resumable work and must say so')
  assert.match(result.history, /COVERAGE LIMIT \(unfinished\)/)
  assert.match(result.history, /every ref older than 2024/)
})

test('an unfinished evidence channel is resumed to exhaustion like a scout', async () => {
  const { result, prompts } = await run({
    plan: PLAN({ history_needed: true, history_question: 'when did X change' }),
    'scout:': HITS(),
    history: EVIDENCE({ stop_reason: 'unfinished', not_reached: 'refs older than 2024' }),
    'history#2': EVIDENCE({ findings: 'the 2023 refactor moved it', searched: ['git log --before 2024'] }),
  })

  // The channels used to be single-shot: a historian handing back an honest partial was
  // merely recorded as truncated, and the evidence stayed half-read while develop planned
  // on it. Now the same resume engine that drives the scouts drives the channels.
  const resumed = prompts.find((p) => p.opts.label === 'history#2')
  assert.ok(resumed, 'an unfinished channel must be resumed rather than recorded')
  assert.match(resumed.prompt, /STILL NOT REACHED[\s\S]*refs older than 2024/)
  assert.equal(result.coverage.complete, true)
  assert.doesNotMatch(result.history, /COVERAGE LIMIT/)
  assert.match(result.history, /the 2023 refactor moved it/)
})

// ------------------------------------------------------------------ shared ground
//
// A plan whose topics all touch one subsystem used to have every topic scout re-read the
// same files, and then every analyst — the expensive tier — read the same code again. In a
// field run 44% of the files came back from two or more scouts, one of them from four.
// `common_ground` is the planner's way to name that surface once; these tests pin that it is
// searched once, excluded from the topic scouts, delivered to every analyst, and — when it
// does not finish — visible as a limit rather than as silence.

test('shared ground is scouted once, kept out of the topic scouts, and reaches every analyst', async () => {
  const { result, prompts } = await run({
    plan: PLAN({
      topics: [{ key: 'a', find: 'find a' }, { key: 'b', find: 'find b' }],
      common_ground: 'the Phaser game config in src/main.ts',
    }),
    'scout:common-ground': HITS({ hits: [{ path: 'src/main.ts', line: 12, note: 'the game config' }] }),
    'scout:': HITS(),
  })

  const common = prompts.filter((p) => String(p.opts.label).startsWith('scout:common-ground'))
  assert.equal(common.length, 1, 'the shared surface is searched once, not once per topic')
  assert.doesNotMatch(common[0].prompt, /A separate scout covers this shared ground/,
    'the common scout must never be told to skip the very ground it was sent for')

  for (const key of ['a', 'b']) {
    const scout = prompts.find((p) => p.opts.label === `scout:${key}`)
    assert.match(scout.prompt, /A separate scout covers this shared ground — do not search it/)
    assert.match(scout.prompt, /the Phaser game config in src\/main\.ts/)

  }

  const judged = promptFor(prompts, 'judge')
  assert.match(judged, /SHARED GROUND \(scouted once for every topic — treat it as part of your evidence\):/)
  assert.match(judged, /src\/main\.ts:12 — the game config/,
    'excluding the shared ground from a scout only works if the judge is handed it')
  const courier = prompts.find((p) => p.opts.label === 'assemble')
  assert.ok(locationsIn(courier.prompt).locations.some((l) => l.path === 'src/main.ts' && l.line === 12),
    'and its lines are assembled with the rest')
  assert.ok(judged.indexOf('SHARED GROUND') < judged.indexOf('You have no search tools'),
    'the shared ground is evidence, so it belongs before the closing instructions')

  // The shared scout exhausted, so it is not resumable work and must not appear as any.
  assert.equal(result.coverage.complete, true)
  assert.deepEqual(
    result.coverage.dropped
      .concat(result.coverage.incomplete, result.coverage.unreached,
        result.coverage.failed_channels, result.coverage.resumable.remaining),
    [])
})

test('an empty common_ground changes nothing about the run', async () => {
  const { result, prompts } = await run({
    plan: PLAN({ common_ground: '' }),
    'scout:': HITS(),
  })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:common-ground')).length, 0,
    'no shared ground means no shared scout to pay for')
  assert.doesNotMatch(prompts.find((p) => p.opts.label === 'scout:a').prompt,
    /A separate scout covers this shared ground/)
  assert.doesNotMatch(promptFor(prompts, 'judge'), /SHARED GROUND/)
  assert.equal(result.coverage.complete, true)
})

test('a shared scout that cannot finish is incomplete work and warns every analyst', async () => {
  // Both rounds return the identical hits and searched surface, so the resume gains no new
  // ground and the shared search genuinely cannot finish.
  const stalled = HITS({ stop_reason: 'unfinished', not_reached: 'src/scenes/ was never opened' })
  const { result, prompts } = await run({
    plan: PLAN({ common_ground: 'the Phaser game config in src/main.ts' }),
    'scout:common-ground': stalled,
    'scout:common-ground#2': stalled,
    'scout:': HITS(),
  })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:common-ground')).length, 2,
    'the shared scout is resumed before it may be reported, then stops as stuck')

  // Evidence shared by every topic is the worst place for a half-done search to go quiet:
  // one unfinished scout would otherwise leave every verdict resting on it (IL2).
  assert.ok(result.coverage.incomplete.includes('common-ground'))
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.resumable.remaining.includes('common-ground'))

  const judged = promptFor(prompts, 'judge')
  assert.match(judged, /WARNING: the shared-ground search did NOT finish/)
  assert.match(judged, /src\/scenes\/ was never opened/)
})

test('a plan from before common_ground existed reads as no shared ground, not as a crash', async () => {
  const legacy = {
    topics: [{ key: 'a', find: 'find a' }],
    docs_needed: false, docs_question: '',
    history_needed: false, history_question: '',
  }
  assert.ok(!('common_ground' in legacy), 'the legacy plan shape genuinely omits the field')

  const { result, prompts } = await run({
    plan: legacy,
    'scout:': HITS(),
  })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:common-ground')).length, 0)
  assert.doesNotMatch(promptFor(prompts, 'judge'), /SHARED GROUND/)
  assert.equal(result.coverage.complete, true)
})

test("a channel's evidence of absence travels with its findings", async () => {
  const { result } = await run({
    plan: PLAN({ history_needed: true, history_question: 'when did X change' }),
    'scout:': HITS(),
    history: EVIDENCE({ no_match: 'no commit ever touched the timer path' }),
  })

  // "Searched and genuinely not there" is a finding, and often the one that settles the
  // question. It must reach synthesis, and it must not read as a coverage limit.
  assert.match(result.history, /Looked for and did not find: no commit ever touched the timer path/)
  assert.doesNotMatch(result.history, /COVERAGE LIMIT/)
  assert.equal(result.coverage.complete, true)
})

// ------------------------------------------------------------- prior context
//
// An effort's stored survey is durable scratch. The whole rule is where it may go: one prompt,
// and no gate. What is pinned here is the "no gate" half, which is invisible by reading.

test('prior context reaches the planner and no searching agent', async () => {
  const { prompts } = await run(
    { plan: PLAN(), 'scout:': HITS() },
    { prior: 'an earlier pass concluded the loader lives in src/boot' },
  )

  assert.match(promptFor(prompts, 'plan'), /an earlier pass concluded/)
  assert.match(promptFor(prompts, 'plan'), /somebody's notes, not\s+evidence/)
  assert.match(promptFor(prompts, 'plan'), /NEVER to decide a topic does not need searching/)

  for (const label of ['scout:a', 'judge']) {
    assert.doesNotMatch(promptFor(prompts, label), /an earlier pass concluded/,
      `${label} was handed unverified prior context`)
  }
})

test('prior context changes no count: every topic is still searched', async () => {
  const { result } = await run(
    { plan: PLAN({ topics: [
      { key: 'a', find: 'find a', subtree: 'src/a' },
      { key: 'b', find: 'find b', subtree: 'src/b' },
    ] }), 'scout:': HITS() },
    { prior: 'both of these were answered last week' },
  )

  assert.deepEqual(result.topics, ['a', 'b'])
  assert.equal(result.coverage.complete, true)
})

test('the result names the ground its topics searched, repository-wide as "."', async () => {
  const { result } = await run({
    plan: PLAN({
      topics: [
        { key: 'a', find: 'find a', subtree: 'src/a/' },
        { key: 'b', find: 'find b', subtree: '' },
        { key: 'c', find: 'find c', subtree: 'src/a' },
      ],
    }),
    'scout:': HITS(),
  })

  assert.deepEqual([...result.ground].sort(), ['.', 'src/a'],
    'one entry per subtree, so a later freshness check asks git once per path')
})

test('nothing about the knowledge base survives in the coverage block', async () => {
  const { result, prompts } = await run({ plan: PLAN(), 'scout:': HITS() })
  assert.ok(!('from_kb' in result.coverage))
  assert.ok(!labelsOf(prompts).some((l) => /^kb-/.test(l)))
})

// ------------------------------------------------------------------ assemble
//
// Each judge's locations are read ONCE, by a script, and written to context files the judge
// Reads. The workflow mints the locations as a plain-text list on one argv slot with its digest
// beside it, and believes the file paths that come back only after recomputing their digest.

const assemblies = (prompts) => prompts.filter((p) => /^assemble/.test(p.opts.label))
const contextPathOf = (prompt) => contextPathFor(locationsIn(prompt).digest)

test('a judge\'s locations, the shared ground included, are written once to a file it reads', async () => {
  const { prompts } = await run({
    plan: PLAN({
      topics: [{ key: 'a', find: 'find a' }, { key: 'b', find: 'find b' }],
      common_ground: 'the config',
    }),
    'scout:common-ground': HITS({ hits: [{ path: 'src/config.js', line: 7, note: 'config' }] }),
    'scout:a': HITS({ hits: [{ path: 'src/a.js', line: 10, note: 'a' }, { path: 'src/x.js', line: 1, note: 'x' }] }),
    'scout:b': HITS({ hits: [{ path: 'src/x.js', line: 1, note: 'x again' }] }),
  })

  const couriers = assemblies(prompts)
  assert.deepEqual(couriers.map((p) => p.opts.label), ['assemble'], 'one judge, one courier')
  assert.equal(couriers[0].opts.agentType, 'agentics:courier')
  assert.equal(couriers[0].opts.model, 'haiku', 'carrying a file path back is not judgment')
  assert.match(couriers[0].prompt, /node "C:\/plugin\/lib\/citations\.mjs" excerpts --repo "\." --locs "[^"]+" --digest [0-9a-f]{8}\n/)

  const { digest, list, locations } = locationsIn(couriers[0].prompt)
  assert.equal(digest, fnv1a(list), 'the digest is taken over exactly the list the courier copies')
  assert.deepEqual(locations.map((l) => l.path + ':' + l.line).sort(),
    ['src/a.js:10', 'src/config.js:7', 'src/x.js:1'], 'a location two scouts found is read once')

  const judged = promptFor(prompts, 'judge')
  assert.match(judged, /CONTEXT FILES — every location above, read once for you by a script/)
  assert.ok(judged.includes(contextPathOf(couriers[0].prompt)))
  assert.doesNotMatch(judged, /LOCATIONS NOT EXCERPTED/)
})

test('a search that found nothing assembles nothing and is still judged', async () => {
  const { result, prompts, logs } = await run({
    plan: PLAN(), 'scout:': HITS({ hits: [], no_match: 'no retry helper anywhere' }),
  })

  assert.equal(assemblies(prompts).length, 0, 'no locations, no courier')
  assert.ok(logs.some((l) => /No context to assemble/.test(l)))
  assert.match(promptFor(prompts, 'judge'), /no retry helper anywhere/, 'absence is evidence to judge')
  assert.equal(result.coverage.complete, true)
})

test('a context payload damaged in transit is refetched on a stronger courier, then believed', async () => {
  const { result, prompts } = await run({
    plan: PLAN(), 'scout:': HITS(),
    assemble: (p) => carriedEnvelope(contextPayload(p), (env) => { env.payload.context.parts[0].path = 'C:/forged.md' }),
    'assemble#2': resolveAll,
  })

  const retry = prompts.find((p) => p.opts.label === 'assemble#2')
  assert.ok(retry, 'a digest mismatch buys a refetch')
  assert.equal(retry.opts.model, 'sonnet')
  assert.doesNotMatch(promptFor(prompts, 'judge'), /forged/)
  assert.ok(promptFor(prompts, 'judge').includes(contextPathOf(retry.prompt)))
  assert.equal(result.coverage.complete, true)
})

test('a token the program refused as damaged on its way in is sent again', async () => {
  const { prompts } = await run({
    plan: PLAN(), 'scout:': HITS(),
    assemble: carriedEnvelope({ ok: false, error: { kind: 'digest_mismatch', message: 'the token changed' } }),
    'assemble#2': resolveAll,
  })

  assert.equal(prompts.find((p) => p.opts.label === 'assemble#2').opts.model, 'haiku')
  assert.match(promptFor(prompts, 'judge'), /CONTEXT FILES/)
})

test('context that cannot be carried is a side channel: the judge reads the locations itself', async () => {
  const failed = { stop_reason: 'failed', payload_raw: '', task_ids: [], task_tools: 'skipped', notes: 'node is not on the PATH' }
  const { result, prompts, logs } = await run({
    plan: PLAN(), 'scout:': HITS({ hits: [{ path: 'src/x.js', line: 42, note: 'the thing' }] }),
    assemble: failed, 'assemble#2': failed,
  })

  assert.equal(assemblies(prompts).length, 2, 'retried once, then let go')
  assert.ok(logs.some((l) => /not assembled[\s\S]*node is not on the PATH/.test(l)))

  const judged = promptFor(prompts, 'judge')
  assert.match(judged, /LOCATIONS NOT EXCERPTED[\s\S]*src\/x\.js:42 — the thing/)
  assert.doesNotMatch(judged, /CONTEXT FILES/)

  // More turns for the judge, not less evidence: nothing was lost that a reader cannot get back.
  assert.deepEqual(result.coverage.failed_channels, [])
  assert.equal(result.coverage.complete, true)
  assert.equal(result.verdicts.length, 1)
})

test('a path the list cannot carry unquoted is not sent: the judge reads it itself', async () => {
  const { prompts, logs } = await run({
    plan: PLAN(),
    'scout:': HITS({ hits: [{ path: 'src/x.js', line: 3, note: 'here' }, { path: 'docs/my notes.md', line: 9, note: 'spaced' }] }),
  })

  assert.deepEqual(locationsIn(promptFor(prompts, 'assemble')).locations, [{ path: 'src/x.js', line: 3 }])
  assert.match(promptFor(prompts, 'judge'), /LOCATIONS NOT EXCERPTED[\s\S]*docs\/my notes\.md:9 — spaced/)
  assert.ok(logs.some((l) => /cannot carry unquoted/.test(l)))
})

test('locations too many for one argv slot travel in batches, one file never split across two', async () => {
  const hits = Array.from({ length: 400 }, (_, i) => ({ path: `src/dir-${i % 200}/file-${i % 200}.js`, line: 10 * i + 1, note: 'n' }))
  const { prompts } = await run({ plan: PLAN(), 'scout:': HITS({ hits }) })

  const couriers = assemblies(prompts)
  assert.ok(couriers.length > 1)
  const pathsPer = couriers.map((p) => new Set(locationsIn(p.prompt).locations.map((l) => l.path)))
  const all = pathsPer.flatMap((set) => [...set])
  assert.equal(all.length, new Set(all).size, 'every location of one file rides the same batch')
  assert.equal(couriers.reduce((n, p) => n + locationsIn(p.prompt).locations.length, 0), 400)
  for (const p of couriers) assert.ok(locationsIn(p.prompt).list.length <= 6000)

  const judged = promptFor(prompts, 'judge')
  for (const p of couriers) assert.ok(judged.includes(contextPathOf(p.prompt)), 'the judge reads every batch\'s file')
})

// ------------------------------------------------------------------ judge
//
// One analyst without search tools judges every topic, unless volume or pace earns more.

const topicsOf = (n) => Array.from({ length: n }, (_, i) => ({ key: `t${i + 1}`, find: `find ${i + 1}` }))

test('one judge holds every topic by default, and says so', async () => {
  const { result, prompts, logs } = await run({ plan: PLAN({ topics: topicsOf(3) }), 'scout:': HITS() })

  const judges = prompts.filter((p) => /^judge/.test(p.opts.label))
  assert.equal(judges.length, 1)
  assert.equal(judges[0].opts.agentType, 'agentics:analyst')
  assert.deepEqual(keysOf(judges[0].opts), ['t1', 't2', 't3'])
  assert.ok(logs.some((l) => /one analyst holds all 3 topic\(s\)/.test(l)))
  assert.deepEqual(result.verdicts.map((v) => v.topic), ['t1', 't2', 't3'])
  assert.equal(result.coverage.complete, true)
})

test('more than sixty locations earn a second judge, each with its own context', async () => {
  // Each topic's scout reports forty separate locations, so eighty-one across three topics.
  const spread = (key) => HITS({ hits: Array.from({ length: 40 }, (_, i) => ({ path: `src/${key}.js`, line: 100 * i + 50, note: 'n' })) })
  const { result, prompts, logs } = await run({
    plan: PLAN({ topics: topicsOf(3) }),
    'scout:t1': spread('t1'), 'scout:t2': spread('t2'), 'scout:t3': HITS(),
  })

  const judges = prompts.filter((p) => /^judge/.test(p.opts.label))
  assert.equal(judges.length, 2)
  assert.deepEqual(judges.map((j) => keysOf(j.opts)).flat().sort(), ['t1', 't2', 't3'],
    'the topics are dealt across the judges, each exactly once')
  assert.ok(judges.every((j) => /^judge:/.test(j.opts.label)))
  assert.ok(logs.some((l) => /81 location\(s\) earn 2 analysts/.test(l)))
  assert.equal(result.verdicts.length, 3)
  assert.equal(result.coverage.complete, true)

  // A judge's courier carries the locations of its own topics, not every judge's.
  const holdsT1 = judges.find((j) => keysOf(j.opts).includes('t1'))
  assert.ok(!keysOf(holdsT1.opts).includes('t2'), 'the two heavy topics land on different judges')
  const courier = assemblies(prompts).find((p) => p.opts.label === holdsT1.opts.label.replace(/^judge/, 'assemble'))
  assert.ok(courier, 'one courier per judge, named after it')
  assert.ok(!locationsIn(courier.prompt).locations.some((l) => l.path === 'src/t2.js'))
  assert.ok(holdsT1.prompt.includes(contextPathOf(courier.prompt)))
})

test('ground two judges share is written into each judge\'s own context', async () => {
  const { prompts } = await run({
    plan: PLAN({ topics: topicsOf(2), common_ground: 'the config' }),
    'scout:common-ground': HITS({ hits: [{ path: 'src/config.js', line: 7, note: 'config' }] }),
    'scout:': HITS(),
  }, { pace: 'fast' })

  const couriers = assemblies(prompts)
  assert.deepEqual(couriers.map((p) => p.opts.label).sort(), ['assemble:t1', 'assemble:t2'])
  for (const p of couriers) {
    assert.ok(locationsIn(p.prompt).locations.some((l) => l.path === 'src/config.js'))
  }
})

test('pace fast buys one judge per topic, and says it bought them for wall-clock', async () => {
  const { prompts, logs } = await run({ plan: PLAN({ topics: topicsOf(3) }), 'scout:': HITS() }, { pace: 'fast' })

  assert.deepEqual(prompts.filter((p) => /^judge/.test(p.opts.label)).map((p) => p.opts.label),
    ['judge:t1', 'judge:t2', 'judge:t3'])
  assert.ok(logs.some((l) => /pace is fast/.test(l)))
})

test('a judge that skips a topic is continued on exactly that topic until it adds none', async () => {
  const { result, prompts } = await run({
    plan: PLAN({ topics: topicsOf(3) }),
    'scout:': HITS(),
    judge: { verdicts: [VERDICT('t1')] },
    'judge#2': { verdicts: [VERDICT('t3')] },
    'judge#3': { verdicts: [] },
  })

  assert.deepEqual(keysOf(prompts.find((p) => p.opts.label === 'judge#2').opts), ['t2', 't3'])
  assert.match(promptFor(prompts, 'judge#2'), /A CONTINUATION/)
  assert.deepEqual(keysOf(prompts.find((p) => p.opts.label === 'judge#3').opts), ['t2'])
  assert.ok(!labelsOf(prompts).includes('judge#4'), 'a pass that rules on nothing ends the charge')

  assert.deepEqual(result.verdicts.map((v) => v.topic), ['t1', 't3'])
  assert.deepEqual(result.coverage.dropped, ['t2'])
  assert.equal(result.coverage.complete, false)
})

// ------------------------------------------------------------------ a standing survey
//
// A settled shape (the caller's judgment) over ground a recorded survey covers and git says is
// untouched (computed by lib/effort.mjs) buys no survey. Every refusal surveys in full.

const RECORDED = {
  question: 'how does X work (last week)',
  topics: ['loader'],
  ground: ['src/boot'],
  verdicts: [{ topic: 'loader', conclusion: 'the loader lives in src/boot/load.js', evidence: ['src/boot/load.js:3'], risks: [] }],
  history: null,
  docs: null,
  coverage: { complete: true, dropped: [], incomplete: [], failed_channels: [], unreached: [], resumable: {} },
}

const STANDS = (over = {}) => carriedEnvelope({
  standing: true, why: 'nothing touched it', effort: 'boot', survey_path: 'x', stamp: '20260920-101500',
  observed_at: 'abc1234', head: 'def5678', ground: ['src/boot'], commits_since: [], dirty: [], ...over,
})

const READS = (over = {}) => carriedEnvelope({
  effort: 'boot', exists: true, evidence: [], nodes_n: 0, executions: [],
  latest: { kind: 'survey', stamp: '20260920-101500', path: 'x', payload: RECORDED, ...over },
})

const settled = { settled_shape: true, effort: 'boot', ground: ['src/boot/load.js', 'src/boot'] }

test('a standing survey that covers the ground stands in, and the coverage block says so', async () => {
  const { result, prompts, logs } = await run({ standing: STANDS(), 'standing-read': READS() }, settled)

  assert.deepEqual(labelsOf(prompts), ['standing', 'standing-read'], 'nothing else is bought')
  assert.match(promptFor(prompts, 'standing'), /node "C:\/plugin\/lib\/effort\.mjs" standing "\." "boot"/)
  assert.match(promptFor(prompts, 'standing-read'), /node "C:\/plugin\/lib\/effort\.mjs" read "\." "boot" --latest survey/)
  assert.ok(prompts.every((p) => p.opts.agentType === 'agentics:courier'))

  assert.deepEqual(result.verdicts, RECORDED.verdicts)
  assert.deepEqual(result.topics, ['loader'])
  assert.deepEqual(result.ground, ['src/boot'])
  assert.equal(result.question, 'how does X work')
  assert.deepEqual(result.coverage.standing, { stamp: '20260920-101500', observed_at: 'abc1234' })
  assert.equal(result.coverage.complete, true)
  assert.ok(logs.some((l) => /nothing was\s+re-searched/.test(l)))
})

test('a survey that does not stand is refused, said out loud, and the survey runs in full', async () => {
  const { result, prompts, logs } = await run({
    standing: STANDS({ standing: false, why: '2 commit(s) since the survey touch its ground' }),
    plan: PLAN(), 'scout:': HITS(),
  }, settled)

  assert.ok(!labelsOf(prompts).includes('standing-read'))
  assert.ok(labelsOf(prompts).includes('plan'))
  assert.ok(logs.some((l) => /does not stand — 2 commit\(s\) since the survey touch its ground/.test(l)))
  assert.ok(!('standing' in result.coverage))
})

test('a standing survey whose ground misses a caller path is refused, naming the path', async () => {
  const { prompts, logs } = await run({
    standing: STANDS(), plan: PLAN(), 'scout:': HITS(),
  }, { ...settled, ground: ['src/boot', 'src/render/'] })

  assert.ok(!labelsOf(prompts).includes('standing-read'))
  assert.ok(logs.some((l) => /does not cover src\/render/.test(l)))
})

test('a repository-wide survey covers any ground', async () => {
  const { result } = await run({ standing: STANDS({ ground: ['.'] }), 'standing-read': READS() },
    { ...settled, ground: ['anything/at/all.js'] })
  assert.ok(result.coverage.standing)
})

test('a survey read back that is not the one that stood is refused', async () => {
  const { result, logs } = await run({
    standing: STANDS(), 'standing-read': READS({ stamp: '20260921-090000' }), plan: PLAN(), 'scout:': HITS(),
  }, settled)

  assert.ok(logs.some((l) => /is not the one that stood/.test(l)))
  assert.ok(!('standing' in result.coverage))
})

test('a standing check that cannot be carried costs a survey, never a skipped one', async () => {
  const failed = { stop_reason: 'failed', payload_raw: '', task_ids: [], task_tools: 'skipped', notes: 'no node' }
  const { result, prompts } = await run({
    standing: failed, 'standing#2': failed, plan: PLAN(), 'scout:': HITS(),
  }, settled)

  assert.ok(labelsOf(prompts).includes('plan'))
  assert.equal(result.coverage.complete, true)
  assert.ok(!('standing' in result.coverage))
})

test('no standing check without a settled shape, an effort, and ground to cover', async () => {
  for (const over of [
    { ...settled, settled_shape: false },
    { ...settled, effort: '' },
    { ...settled, ground: [] },
    { ...settled, effort: 'boot"; rm -rf ~; echo "' },
  ]) {
    const { prompts } = await run({ plan: PLAN(), 'scout:': HITS() }, over)
    assert.ok(!labelsOf(prompts).includes('standing'), JSON.stringify(over))
  }
})
