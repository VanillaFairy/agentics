// test/agentics-survey-scenarios.test.mjs — the survey workflow's accounting arithmetic, executed.
//
// Lint judges form and cannot reach any of this: whether a channel nobody ran is recorded,
// whether an item is matched to its topic by position or by a string the model retyped,
// whether a half-finished channel still reports complete. Each test below pins a way a
// PARTIAL result could come back wearing the shape of a WHOLE one (IL2) — three of
// them were live defects, found by diffing against the sibling `investigate` plugin that had
// already been through a field run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import {
  carriedContext, carriedEnvelope, contextPathFor, contextPayload, excerptLocations, jsonChunks, recordedLine, runWorkflow,
  scriptedAgents,
} from './harness/workflow-host.mjs'
import { ITEM_KINDS, itemId } from '../lib/evidence.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'

const WF = fileURLToPath(new URL('../service-workflows/gather-evidence-without-concluding.workflow.js', import.meta.url))

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

const ITEM = (topic, over = {}) => ({
  topic, kind: 'behaviour', claim: 'what ' + topic + ' found', spans: [{ path: 'src/x.js', start: 1, end: 3 }],
  queries: [], sources: [], rests_on: [], ...over,
})

/** The topic keys a judge dispatch was given — its schema's closed enum. */
const keysOf = (opts) => opts.schema.properties.items.items.properties.topic.enum

/** A judge that returns one item for every topic it holds. */
const judgeAll = (prompt, opts) => ({ items: keysOf(opts).map((k) => ITEM(k)), risks: [] })

/** A record courier whose store accepts everything, answering with the ids lib/evidence.mjs mints. */
const recordAll = (prompt) => carriedEnvelope({
  ok: true, return: '20260926-120000-survey', ids: recordedLine(prompt).entry.items.map(itemId),
})

/** A record courier whose store refuses every item it is handed, for `problem`. */
const refuseAll = (problem) => (prompt) => carriedEnvelope({
  ok: false, refused: recordedLine(prompt).entry.items.map((_, index) => ({ index, problems: [problem] })),
})

/** The topics the result holds items for, in the order its items came. */
const itemTopics = (result) => [...new Set(result.items.map((i) => i.topic))]

const resolveAll = carriedContext
const locationsIn = excerptLocations

// Every survey that finds a location resolves it, judges it and records what the judge found, so
// every scenario scripts the courier, the judge and the recorder with the ordinary case — which is
// what keeps the tests below about the thing each one is testing.
const run = (script, over = {}) => runWorkflow(WF, {
  args: { question: 'how does X work', plugin_root: 'C:/plugin', ...over },
  agent: scriptedAgents({
    assemble: resolveAll, 'assemble:': resolveAll, judge: judgeAll, 'judge:': judgeAll,
    record: recordAll, 'record:': recordAll, ...script,
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
  assert.deepEqual(itemTopics(result), ['a'], 'a failed channel must not empty the items')
})

// ---------------------------------------------------------------- reconciliation

test('a lone topic\'s items are that topic\'s, whatever key the judge echoed', async () => {
  const { result } = await run({
    plan: PLAN({ topics: [{ key: 'a', find: 'find a' }, { key: 'b', find: 'find b' }] }),
    'scout:': HITS(),
    'judge:a': { items: [ITEM('typo-not-a')], risks: [] },
  }, { pace: 'fast' })

  // Matching on the echoed string counted this item as evidence AND its topic as dropped,
  // at the same time: the answer was built on both topics while reporting one as missing.
  assert.deepEqual(itemTopics(result), ['a', 'b'])
  assert.equal(result.items[0].topic, 'a')
  assert.deepEqual(result.coverage.dropped, [])
  assert.equal(result.coverage.complete, true)
})

test('an item under a key the judge was not given is evidence for nothing', async () => {
  const { result, prompts } = await run({
    plan: PLAN({ topics: [{ key: 'a', find: 'find a' }, { key: 'b', find: 'find b' }] }),
    'scout:': HITS(),
    judge: { items: [ITEM('b'), ITEM('invented')], risks: [] },
    'judge#2': { items: [], risks: [] },
  })

  assert.deepEqual(itemTopics(result), ['b'])
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

  assert.deepEqual(itemTopics(result), ['b'])
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

  assert.equal(itemTopics(result).length, 1)
  assert.deepEqual(result.coverage.incomplete, [])
  assert.equal(result.coverage.complete, true)
})

test('a report with no stop_reason at all reads as incomplete, never as exhausted', async () => {
  const { result } = await run({
    plan: PLAN(),
    'scout:': { hits: [{ path: 'src/x.js', line: 1, note: 'the thing' }] },
  })

  assert.equal(itemTopics(result).length, 1, 'the evidence gathered is kept and analyzed')
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

test('a token the program refused as damaged on its way in is copied again by the stronger courier', async () => {
  const refusal = carriedEnvelope({ ok: false, error: { kind: 'digest_mismatch', message: 'the token changed' } })
  const { prompts } = await run({
    plan: PLAN(), 'scout:': HITS(),
    // A courier may call a typed refusal a failed run: the program's output decides, not that label.
    assemble: { ...refusal, stop_reason: 'failed' },
    'assemble#2': resolveAll,
  })

  assert.equal(prompts.find((p) => p.opts.label === 'assemble#2').opts.model, 'sonnet')
  assert.match(promptFor(prompts, 'judge'), /CONTEXT FILES/)
})

test('context that cannot be carried is a side channel: the judge reads the locations itself', async () => {
  const failed = { stop_reason: 'failed', payload_raw: '', task_tools: 'skipped', notes: 'node is not on the PATH' }
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
  assert.equal(itemTopics(result).length, 1)
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
  assert.deepEqual(itemTopics(result), ['t1', 't2', 't3'])
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
  assert.deepEqual(itemTopics(result).sort(), ['t1', 't2', 't3'])
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
    judge: { items: [ITEM('t1')], risks: [] },
    'judge#2': { items: [ITEM('t3')], risks: [] },
    'judge#3': { items: [], risks: [] },
  })

  assert.deepEqual(keysOf(prompts.find((p) => p.opts.label === 'judge#2').opts), ['t2', 't3'])
  assert.match(promptFor(prompts, 'judge#2'), /A CONTINUATION/)
  assert.deepEqual(keysOf(prompts.find((p) => p.opts.label === 'judge#3').opts), ['t2'])
  assert.ok(!labelsOf(prompts).includes('judge#4'), 'a pass that rules on nothing ends the charge')

  assert.deepEqual(itemTopics(result), ['t1', 't3'])
  assert.deepEqual(result.coverage.dropped, ['t2'])
  assert.equal(result.coverage.complete, false)
})

// ------------------------------------------------------------------ evidence items
//
// A judge returns items, one claim each with the anchor its kind needs. The recorder, not the
// judge, decides whether an item is anchored: a refused item goes back to the judge that wrote
// it, and what never gets anchored is dropped out loud rather than returned as evidence.

test('the judge is told which anchor each kind of claim needs, and its schema offers exactly the kinds the store takes', async () => {
  const { prompts } = await run({ plan: PLAN(), 'scout:': HITS() })
  const judge = prompts.find((p) => p.opts.label === 'judge')
  assert.deepEqual(judge.opts.schema.properties.items.items.properties.kind.enum, ITEM_KINDS)
  for (const kind of ITEM_KINDS) assert.match(judge.prompt, new RegExp('\\b' + kind + '\\b'))
  assert.match(judge.prompt, /one claim/i)
})

test('every judged item is recorded, and the result carries the ids the store gave them', async () => {
  const { result, prompts } = await run({ plan: PLAN(), 'scout:': HITS() })

  const rec = prompts.find((p) => p.opts.label === 'record')
  assert.equal(rec.opts.agentType, 'agentics:courier')
  assert.equal(rec.opts.model, 'haiku', 'carrying a command is not judgment')
  assert.match(rec.prompt, /node "C:\/plugin\/lib\/evidence\.mjs" record --repo "\." --root "\." --kind survey --digest [0-9a-f]{8} --json-file "[^"]+\.json"/)

  const { entry, digest } = recordedLine(rec.prompt)
  assert.equal(digest, fnv1a(canonical(entry)))
  const [sent] = entry.items
  assert.equal(entry.items.length, 1)
  assert.equal(sent.question, 'how does X work')
  assert.equal(sent.topic, 'a')
  assert.deepEqual(sent.ground, ['src/a'], "an item's ground is its topic's subtree")
  assert.equal(sent.kind, 'behaviour')
  assert.deepEqual(sent.spans, [{ path: 'src/x.js', start: 1, end: 3, at: '' }], 'the recorder fills at, never the judge')

  assert.deepEqual(result.items.map((i) => i.id), entry.items.map(itemId))
  assert.deepEqual(result.unrecorded, [])
  assert.equal(result.coverage.complete, true)
})

test('a survey run from a linked worktree records spans read in the worktree', async () => {
  const { prompts } = await run({ plan: PLAN(), 'scout:': HITS() }, { roots: 'C:/wt/e1-a' })
  assert.match(promptFor(prompts, 'record'), /record --repo "C:\/wt\/e1-a" --root "C:\/wt\/e1-a" --kind survey /,
    'the store is found from the repo; the spans are read where the judge read them')
})

test('a judge group over many items records with one courier, its JSON written to a file in chunks that each fit one line', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ITEM('a', { claim: 'claim ' + i + ' ' + 'x'.repeat(600) }))
  const { result, prompts } = await run({
    plan: PLAN({ topics: [{ key: 'a', find: 'find a', subtree: 'src/a' }, { key: 'b', find: 'find b', subtree: 'src/b' }] }),
    'scout:': HITS(), 'judge:a': { items: many, risks: [] },
  }, { pace: 'fast' })

  const recs = prompts.filter((p) => /^record/.test(p.opts.label))
  assert.deepEqual(recs.map((p) => p.opts.label).sort(), ['record:a', 'record:b'])

  const ofA = promptFor(prompts, 'record:a')
  const chunks = jsonChunks(ofA)
  assert.ok(chunks.length > 1, 'twelve long items do not fit one line')
  for (const chunk of chunks) assert.ok(chunk.length <= 6000 && !chunk.includes('\\'))
  assert.match(ofA, /record --repo "\." --root "\." --kind survey --digest [0-9a-f]{8} --json-file "\.\/\.agentics\/\.state\/token-[0-9a-f]{8}\.json"; rm -f /)

  const { entry, digest } = recordedLine(ofA)
  assert.equal(digest, fnv1a(canonical(entry)))
  assert.deepEqual(entry.items.map((i) => i.claim).sort(), many.map((i) => i.claim).sort(), 'every item sent once')
  assert.equal(result.items.filter((i) => i.topic === 'a').length, many.length)
})

test('the judge schema offers risks keyed by topic and no at on spans', async () => {
  const { prompts } = await run({ plan: PLAN(), 'scout:': HITS() })
  const { schema } = prompts.find((p) => p.opts.label === 'judge').opts
  const item = schema.properties.items.items
  for (const field of ['topic', 'kind', 'claim', 'spans', 'queries', 'sources', 'rests_on']) {
    assert.ok(item.required.includes(field), field)
  }
  const span = item.properties.spans.items.properties
  assert.equal(span.start.type, 'integer')
  assert.equal(span.end.type, 'integer')
  assert.ok(!('at' in span), 'where a span was read is the recorder\'s observation')
  assert.ok(!('result' in item.properties.queries.items.properties))
  assert.ok(!('retrieved' in item.properties.sources.items.properties))
  const risk = schema.properties.risks.items.properties
  assert.deepEqual(risk.topic.enum, ['a'])
  assert.equal(risk.text.type, 'string')
})

test('an item refused for its anchors goes back to its judge, and what then passes is kept', async () => {
  const bad = { items: [ITEM('a', { kind: 'absence', spans: [] })], risks: [] }
  const good = { items: [ITEM('a', { kind: 'absence', spans: [], queries: [{ pattern: 'retry', scope: ['src'] }] })], risks: [] }
  const { result, prompts } = await run({
    plan: PLAN(), 'scout:': HITS(), judge: bad,
    record: refuseAll('a absence item needs at least one anchor in queries'),
    'judge:anchors:1': good,
  })

  const reask = prompts.find((p) => p.opts.label === 'judge:anchors:1')
  assert.ok(reask, 'the refused item went back to the judge that wrote it')
  assert.equal(reask.opts.agentType, 'agentics:analyst')
  assert.deepEqual(keysOf(reask.opts), ['a'])
  assert.match(reask.prompt, /needs at least one anchor in queries/)
  assert.ok(labelsOf(prompts).includes('record:anchors:1'))
  assert.deepEqual(result.items.map((i) => i.kind), ['absence'])
  assert.equal(result.coverage.complete, true)
})

test('an item its judge cannot anchor is dropped from the result and leaves its topic incomplete', async () => {
  const bad = { items: [ITEM('a', { spans: [] })], risks: [] }
  const refuse = refuseAll('a behaviour item needs at least one anchor in spans')
  const { result, prompts } = await run({
    plan: PLAN(), 'scout:': HITS(), judge: bad, 'judge:anchors:1': bad, record: refuse, 'record:anchors:1': refuse,
  })

  assert.ok(!labelsOf(prompts).includes('judge:anchors:2'), 'a pass that anchors nothing more ends the loop')
  assert.deepEqual(result.items, [])
  assert.deepEqual(result.coverage.dropped, [], 'the topic was ruled on; what it lost is incomplete, not dropped')
  assert.deepEqual(result.coverage.incomplete, ['a'])
  assert.match(result.coverage.unreached.join(' '), /a: 1 item\(s\) refused[\s\S]*needs at least one anchor in spans/)
  assert.equal(result.coverage.complete, false)
})

test('items the store could not be reached to record are returned unchecked, and keep their topic incomplete', async () => {
  const failed = { stop_reason: 'failed', payload_raw: '', notes: 'node is not on the PATH' }
  const { result } = await run({ plan: PLAN(), 'scout:': HITS(), record: failed, 'record#2': failed })

  assert.equal(result.items.length, 1, 'the judge was paid for; its items are not thrown away')
  assert.deepEqual(result.unrecorded, result.items.map((i) => i.id))
  assert.deepEqual(result.coverage.incomplete, ['a'])
  assert.match(result.coverage.unreached.join(' '), /not recorded/)
  assert.equal(result.coverage.complete, false)
})

test("a derived item may rest on a sibling's claim; the recorder is handed that sibling's id", async () => {
  const known = 'I00000009'
  const judge = {
    items: [
      ITEM('a', { claim: 'the base' }),
      ITEM('a', { kind: 'derived', spans: [], claim: 'the conclusion', rests_on: ['the base', known] }),
    ],
    risks: [],
  }
  const { prompts } = await run({ plan: PLAN(), 'scout:': HITS(), judge })
  const [, derived] = recordedLine(promptFor(prompts, 'record')).entry.items
  assert.deepEqual(derived.rests_on, [itemId({ question: 'how does X work', topic: 'a', claim: 'the base' }), known])
})

test('a topic ruled only by a risk is not dropped, and the risk travels in the result', async () => {
  const { result, prompts } = await run({
    plan: PLAN(), 'scout:': HITS(), judge: { items: [], risks: [{ topic: 'a', text: 'no surface to anchor' }] },
  })
  assert.deepEqual(result.coverage.dropped, [])
  assert.deepEqual(result.risks, [{ topic: 'a', text: 'no surface to anchor' }])
  assert.ok(!labelsOf(prompts).some((l) => /^record/.test(l)), 'nothing to record buys no courier')
})

test('a plan with no topics and nothing reused is no survey, and says so', async () => {
  const { result } = await run({ plan: PLAN({ topics: [] }) })
  assert.deepEqual(result.items, [])
  assert.equal(result.coverage.complete, false)
  assert.match(result.coverage.unreached.join(' '), /planning produced no topics/)
})

// ------------------------------------------------------------------ reuse: the pool before the plan
//
// Before planning, the survey reads the project's pool for items whose ground overlaps the
// caller's. Standing ones are known ground; suspect ones get the cheapest re-judge there is;
// stale ones send their topic to a narrowed re-survey. Nothing about whether text changed is a
// model's call — the pool's states come from lib/evidence.mjs.

const SHA = 'a'.repeat(40)
const poolId = (n) => 'I' + String(n).padStart(8, '0')
const POOL_ITEM = (n, over = {}) => ({
  id: poolId(n), question: 'how does boot work', topic: 'loader', ground: ['src/boot'], kind: 'behaviour',
  claim: 'pool claim ' + n, spans: [{ path: 'src/boot/load.js', start: 3, end: 9, at: SHA }],
  queries: [], sources: [], rests_on: [], from_return: '20260920-101500-survey', seq: n,
  state: 'standing', changed: [], why: 'every anchor is unchanged', ...over,
})
const SUSPECT = { state: 'suspect', changed: [{ anchor: 'span', index: 0, old: 'const a = 1', now: 'const a = 2' }], why: '1 anchor(s) changed' }
const POOL = (items) => carriedEnvelope({ ground: ['src/boot/load.js', 'src/boot'], items })
const GROUND = { ground: ['src/boot/load.js', 'src/boot'] }
const idsIn = (prompt) => [...prompt.matchAll(/\[(I[0-9a-f]{8})\]/g)].map((m) => m[1])
const holdAll = (prompt) => ({ judgements: idsIn(prompt).map((id) => ({ id, verdict: 'holds', why: 'cosmetic' })) })
const judgedOk = (prompt) => carriedEnvelope({
  recorded: recordedLine(prompt).entry.judgements.map((j) => ({ ...j, ok: true, state: 'standing', why: '' })),
})
const verdictsSent = (prompts, label) =>
  recordedLine(promptFor(prompts, label)).entry.judgements.map((j) => [j.id, j.verdict])
const failedCourier = { stop_reason: 'failed', payload_raw: '', notes: 'node is not on the PATH' }

test('standing items whose ground overlaps reach the planner and the judge as known ground, and are returned', async () => {
  const { result, prompts } = await run({
    reuse: POOL([POOL_ITEM(1), POOL_ITEM(2, { topic: 'challenge:yagni', from_return: '20260920-101500-probe' })]),
    plan: PLAN(), 'scout:': HITS(),
  }, GROUND)

  const reuse = prompts.find((p) => p.opts.label === 'reuse')
  assert.equal(reuse.opts.agentType, 'agentics:courier')
  assert.match(reuse.prompt,
    /node "C:\/plugin\/lib\/evidence\.mjs" items --repo "\." --root "\." --ground "src\/boot\/load\.js,src\/boot" --states standing,suspect,stale/)
  assert.ok(labelsOf(prompts).indexOf('reuse') < labelsOf(prompts).indexOf('plan'), 'the pool is read before anything is planned')

  const plan = promptFor(prompts, 'plan')
  assert.match(plan, /ESTABLISHED/)
  assert.match(plan, /pool claim 1/)
  assert.doesNotMatch(plan, /pool claim 2/, "a challenge finding is not a survey's evidence")
  assert.match(promptFor(prompts, 'judge'), /pool claim 1/)

  assert.deepEqual(result.reused, [poolId(1)])
  assert.deepEqual(result.items.map((i) => i.id),
    [poolId(1), itemId({ question: 'how does X work', topic: 'a', claim: 'what a found' })])
  assert.ok(!labelsOf(prompts).some((l) => /^rejudge/.test(l)), 'nothing standing is re-judged')
})

test('the survey result carries no verdicts field, and its ground is the topic subtrees', async () => {
  const { result } = await run({ reuse: POOL([POOL_ITEM(1)]), plan: PLAN(), 'scout:': HITS() }, GROUND)
  assert.ok(!('verdicts' in result))
  assert.deepEqual(result.reused, [poolId(1)])
  assert.deepEqual(result.ground, ['src/a'], "a reused item's ground is not ground this survey searched")
})

test('a pool the planner finds complete buys no search, and says so', async () => {
  const { result, prompts, logs } = await run({ reuse: POOL([POOL_ITEM(1)]), plan: PLAN({ topics: [] }) }, GROUND)
  assert.deepEqual(labelsOf(prompts), ['reuse', 'plan'])
  assert.deepEqual(result.items.map((i) => i.id), [poolId(1)])
  assert.deepEqual(result.topics, [])
  assert.equal(result.coverage.complete, true)
  assert.ok(logs.some((l) => /nothing left to search/.test(l)))
})

test('suspect items are re-judged in batches of twenty on the cheapest tier, whatever the dial', async () => {
  const pool = Array.from({ length: 25 }, (_, i) => POOL_ITEM(i + 1, SUSPECT))
  const { prompts } = await run({
    reuse: POOL(pool), 'rejudge:': holdAll, 'record-judgements:': judgedOk,
    'reuse-after': POOL(pool.map((it) => ({ ...it, state: 'standing', changed: [] }))),
    plan: PLAN({ topics: [] }),
  }, { ...GROUND, intelligence: 'max' })

  const rejudges = prompts.filter((p) => /^rejudge:/.test(p.opts.label))
  assert.deepEqual(rejudges.map((p) => p.opts.label), ['rejudge:1', 'rejudge:2'])
  assert.deepEqual(rejudges.map((p) => idsIn(p.prompt).length), [20, 5])
  assert.deepEqual(rejudges.flatMap((p) => idsIn(p.prompt)).sort(), pool.map((it) => it.id).sort())
  for (const p of rejudges) {
    assert.equal(p.opts.agentType, 'agentics:analyst')
    assert.equal(p.opts.model, 'haiku', 'the re-judge is the stated exception to the dial')
    assert.match(p.prompt, /const a = 1[\s\S]*const a = 2/, 'the old and the new text of what changed')
  }

  const recorded = prompts.filter((p) => /^record-judgements:/.test(p.opts.label))
  assert.deepEqual(recorded.map((p) => p.opts.label), ['record-judgements:1', 'record-judgements:2'])
  for (const p of recorded) {
    assert.equal(p.opts.agentType, 'agentics:courier')
    assert.equal(p.opts.model, 'haiku', 'carrying a verdict is not judgment')
  }
  assert.match(recorded[0].prompt, /node "C:\/plugin\/lib\/evidence\.mjs" judge --repo "\." --root "\." --digest [0-9a-f]{8} --json-file "[^"]+\.json"/)
  assert.ok(labelsOf(prompts).indexOf('reuse-after') > labelsOf(prompts).indexOf('record-judgements:2'),
    'the pool is read again only after every verdict is recorded')
})

test('a survey run from a linked worktree reads and judges its pool in the worktree', async () => {
  const a = POOL_ITEM(1, SUSPECT)
  const { prompts } = await run({
    reuse: POOL([a]), 'rejudge:': holdAll, 'record-judgements:': judgedOk,
    'reuse-after': POOL([{ ...a, state: 'standing', changed: [] }]), plan: PLAN({ topics: [] }),
  }, { ...GROUND, roots: 'C:/wt/e1-a' })
  for (const label of ['reuse', 'reuse-after']) {
    assert.match(promptFor(prompts, label), /items --repo "C:\/wt\/e1-a" --root "C:\/wt\/e1-a" --ground /,
      label + ': the pool\'s states are derived where the survey reads')
  }
  assert.match(promptFor(prompts, 'record-judgements:1'), /judge --repo "C:\/wt\/e1-a" --root "C:\/wt\/e1-a" --digest /,
    'a holds re-anchors where the re-judge was shown the text')
})

test('holds keeps an item as known ground; fails sends its topic to a narrowed re-survey', async () => {
  const kept = POOL_ITEM(1)
  const held = POOL_ITEM(2, { topic: 'config', claim: 'config is read once', ...SUSPECT })
  const broke = POOL_ITEM(3, { topic: 'cache', claim: 'the cache is never flushed', ground: ['src/cache'], ...SUSPECT })
  const { result, prompts } = await run({
    reuse: POOL([kept, held, broke]),
    'rejudge:': { judgements: [{ id: held.id, verdict: 'holds', why: 'cosmetic' }, { id: broke.id, verdict: 'fails', why: 'a flush was added' }] },
    'record-judgements:': judgedOk,
    'reuse-after': POOL([kept, { ...held, state: 'standing', changed: [] }, { ...broke, state: 'stale', changed: [] }]),
    plan: PLAN({ topics: [] }), 'scout:': HITS(),
  }, GROUND)

  assert.deepEqual(verdictsSent(prompts, 'record-judgements:1'), [[held.id, 'holds'], [broke.id, 'fails']])
  assert.match(promptFor(prompts, 'plan'), /RE-SURVEYED[\s\S]*cache/)
  assert.deepEqual(labelsOf(prompts).filter((l) => /^scout:/.test(l)), ['scout:cache'], 'only the stale topic is bought again')
  assert.match(promptFor(prompts, 'scout:cache'), /the cache is never flushed/)
  assert.match(promptFor(prompts, 'scout:cache'), /src\/cache/)
  assert.match(promptFor(prompts, 'judge'), /config is read once/, 'the re-survey is handed every standing item as known ground')

  assert.deepEqual(result.topics, ['cache'])
  assert.deepEqual([...result.reused].sort(), [kept.id, held.id].sort())
  assert.ok(!result.items.some((i) => i.id === broke.id), 'a stale item is replaced, never returned')
  assert.equal(result.coverage.complete, true)
})

test('an item the re-judge skipped, or a re-judge that died, is unsure: never a pass', async () => {
  const a = POOL_ITEM(1, SUSPECT)
  const b = POOL_ITEM(2, { claim: 'second', ...SUSPECT })
  const script = (rejudge) => ({
    reuse: POOL([a, b]), 'rejudge:': rejudge, 'record-judgements:': judgedOk,
    'reuse-after': POOL([{ ...a, state: 'stale' }, { ...b, state: 'stale' }]), plan: PLAN({ topics: [] }), 'scout:': HITS(),
  })

  const skipped = await run(script({ judgements: [{ id: a.id, verdict: 'holds', why: 'ok' }] }), GROUND)
  assert.deepEqual(verdictsSent(skipped.prompts, 'record-judgements:1'), [[a.id, 'holds'], [b.id, 'unsure']])

  const died = await run(script(() => { throw new Error('overloaded') }), GROUND)
  assert.deepEqual(verdictsSent(died.prompts, 'record-judgements:1'), [[a.id, 'unsure'], [b.id, 'unsure']])
})

test('an item still suspect after the re-judge is re-surveyed, never reused', async () => {
  const a = POOL_ITEM(1, SUSPECT)
  const { result, prompts } = await run({
    reuse: POOL([a]), 'rejudge:': holdAll, 'record-judgements:': judgedOk, 'reuse-after': POOL([a]),
    plan: PLAN({ topics: [] }), 'scout:': HITS(),
  }, GROUND)
  assert.deepEqual(result.reused, [])
  assert.ok(labelsOf(prompts).includes('scout:loader'))
})

test('a pool that cannot be read again after the re-judge counts every re-judged item as stale', async () => {
  const kept = POOL_ITEM(1)
  const a = POOL_ITEM(2, { topic: 'config', ...SUSPECT })
  const { result, prompts } = await run({
    reuse: POOL([kept, a]), 'rejudge:': holdAll, 'record-judgements:': judgedOk,
    'reuse-after': failedCourier, 'reuse-after#2': failedCourier, plan: PLAN({ topics: [] }), 'scout:': HITS(),
  }, GROUND)
  assert.deepEqual(result.reused, [kept.id])
  assert.ok(labelsOf(prompts).includes('scout:config'))
})

test('stale items in the pool send their topics to the re-survey without a re-judge', async () => {
  const { result, prompts } = await run({
    reuse: POOL([POOL_ITEM(1, { state: 'stale', why: 'judged fails' })]), plan: PLAN({ topics: [] }), 'scout:': HITS(),
  }, GROUND)
  assert.ok(!labelsOf(prompts).some((l) => /^rejudge|^reuse-after/.test(l)))
  assert.deepEqual(result.topics, ['loader'])
})

// A narrowed re-survey's new items get new ids, so the stale item they replaced stays in the pool.
// The newer item of its topic, by seq, is what says it was replaced (spec §4.9).
const STALE = { state: 'stale', why: 'judged fails' }

test('a second survey over the same ground, after a narrowed re-survey replaced a stale topic, dispatches no scout for that topic', async () => {
  const broke = POOL_ITEM(3, { topic: 'cache', claim: 'the cache is never flushed', ground: ['src/cache'], ...STALE })
  const replaced = POOL_ITEM(7, { topic: 'cache', claim: 'the cache is flushed on write', ground: ['src/cache'], from_return: '20260921-090000-survey' })
  const { result, prompts } = await run({
    reuse: POOL([POOL_ITEM(1), broke, replaced]), plan: PLAN({ topics: [] }), 'scout:': HITS(),
  }, GROUND)
  assert.ok(!labelsOf(prompts).some((l) => /^scout:/.test(l)), 'nothing is bought again')
  assert.doesNotMatch(promptFor(prompts, 'plan'), /RE-SURVEYED/)
  assert.deepEqual([...result.reused].sort(), [poolId(1), poolId(7)])
  assert.ok(!result.items.some((i) => i.id === broke.id), 'a superseded item is never returned')
  assert.equal(result.coverage.complete, true)
})

test('an older standing item of a topic, or one on other ground, never hides a stale one', async () => {
  const older = POOL_ITEM(2, { topic: 'cache', claim: 'the cache has one entry', ground: ['src/cache'] })
  const broke = POOL_ITEM(5, { topic: 'cache', claim: 'the cache is never flushed', ground: ['src/cache'], ...STALE })
  const elsewhere = POOL_ITEM(9, { topic: 'cache', claim: 'another cache', ground: ['src/other'] })
  const { result, prompts } = await run({
    reuse: POOL([older, broke, elsewhere]), plan: PLAN({ topics: [] }), 'scout:': HITS(),
  }, GROUND)
  assert.ok(labelsOf(prompts).includes('scout:cache'))
  assert.deepEqual(result.topics, ['cache'])
})

test('no reuse without ground to overlap, nor over ground a command cannot carry', async () => {
  for (const over of [{}, { ground: [] }, { ground: ['src/my boot'] }, { ground: ['src"; rm -rf ~; echo "'] }]) {
    const { prompts } = await run({ plan: PLAN(), 'scout:': HITS() }, over)
    assert.ok(!labelsOf(prompts).includes('reuse'), JSON.stringify(over))
  }
})

test('a pool that cannot be read costs a full survey, never a skipped one', async () => {
  const unreadable = { reuse: failedCourier, 'reuse#2': failedCourier }
  const malformed = { reuse: carriedEnvelope({ ground: GROUND.ground, items: 'not a list' }) }
  for (const pool of [unreadable, malformed]) {
    const { result, prompts } = await run({ ...pool, plan: PLAN(), 'scout:': HITS() }, GROUND)
    assert.ok(labelsOf(prompts).includes('scout:a'), JSON.stringify(pool.reuse).slice(0, 40))
    assert.deepEqual(result.reused, [])
    assert.equal(result.coverage.complete, true)
  }
})

test('the caller\'s ground travels in the resume args, and the retired standing inputs do not', async () => {
  const { result } = await run({ plan: PLAN(), 'scout:': HITS() }, GROUND)
  assert.deepEqual(result.coverage.resumable.args.ground, GROUND.ground)
  assert.ok(!('settled_shape' in result.coverage.resumable.args))
  assert.ok(!('effort' in result.coverage.resumable.args))
})
