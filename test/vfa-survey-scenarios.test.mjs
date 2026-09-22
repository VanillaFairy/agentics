// test/vfa-survey-scenarios.test.mjs — the survey workflow's accounting arithmetic, executed.
//
// Lint judges form and cannot reach any of this: whether a channel nobody ran is recorded,
// whether a verdict is matched to its topic by position or by a string the model retyped,
// whether a half-finished channel still reports complete. Each test below pins a way a
// PARTIAL result could come back wearing the shape of a WHOLE one (IRON LAW §4) — three of
// them were live defects, found by diffing against the sibling `investigate` plugin that had
// already been through a field run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carriedChain, carriedEnvelope, runWorkflow, scriptedAgents } from './harness/workflow-host.mjs'

const WF = fileURLToPath(new URL('../workflows/vfa-survey.workflow.js', import.meta.url))

const PLAN = (over = {}) => ({
  topics: [{ key: 'a', find: 'find a', kb_path: 'src/a' }],
  docs_needed: false, docs_question: '',
  history_needed: false, history_question: '',
  ...over,
})

/** `lib/kb.mjs index`'s payload, carried: `{ '<node>': { <kind>: <count> } }`. */
const INDEX = (byNode = {}, damage) => {
  const nodes = Object.entries(byNode).map(([node, kinds]) => ({
    node, entries: Object.values(kinds).reduce((a, b) => a + b, 0), kinds,
  }))
  return carriedEnvelope({
    repo: 'C:/repo',
    nodes,
    counts: { nodes: nodes.length, entries: nodes.reduce((n, x) => n + x.entries, 0) },
    malformed: 0,
    notes: 'indexed ' + nodes.length + ' node(s)',
  }, damage)
}

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

// Every survey reads the knowledge base, so every scenario scripts the two couriers. The
// defaults are the ordinary state of a repository nobody has surveyed twice — an index holding
// nothing, and no chain bought over it — which is what keeps the tests below about the thing
// each one is testing.
const run = (script, over = {}) => runWorkflow(WF, {
  args: { question: 'how does X work', plugin_root: 'C:/plugin', ...over },
  agent: scriptedAgents({ 'kb-index': INDEX(), 'kb-chain': carriedChain(), ...script }),
})

const promptFor = (prompts, label) => (prompts.find((p) => p.opts.label === label) || {}).prompt || ''
const labelsOf = (prompts) => prompts.map((p) => p.opts.label || '')

// ------------------------------------------- the intelligence dial

// `develop` forwards its own dial into this nested call, so a run dialled to `low` reaches
// its analysis here and nowhere else. The dial is only real where it reaches an `opts.model`.
test('`low` puts the analysts on sonnet and leaves the search tier alone', async () => {
  const { prompts } = await run(
    { plan: PLAN(), 'scout:': HITS(), 'analyze:': VERDICT('a') },
    { intelligence: 'low' },
  )
  const modelOf = (label) => prompts.find((p) => p.opts.label === label).opts.model

  assert.equal(modelOf('plan'), 'sonnet', 'the analyst that plans the topics is a judging agent')
  assert.equal(modelOf('analyze:a'), 'sonnet', 'and so is the one that rules on each')
  assert.equal(modelOf('scout:a'), undefined, 'search never moves with the dial')
})

test('`normal` names opus rather than inheriting it', async () => {
  const { prompts } = await run(
    { plan: PLAN(), 'scout:': HITS(), 'analyze:': VERDICT('a') },
    { intelligence: 'normal' },
  )
  const modelOf = (label) => prompts.find((p) => p.opts.label === label).opts.model

  assert.equal(modelOf('plan'), 'opus')
  assert.equal(modelOf('analyze:a'), 'opus')
  assert.equal(modelOf('scout:a'), undefined, 'the search tier is not on the dial')
})

test('a tier this script does not define is served as normal, not as itself', async () => {
  const { prompts } = await run(
    { plan: PLAN(), 'scout:': HITS(), 'analyze:': VERDICT('a') },
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
    'analyze:': VERDICT('a'),
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
    'analyze:': VERDICT('a'),
    docs: () => { throw new Error('network is down') },
  })

  assert.deepEqual(result.coverage.failed_channels, ['docs'])
  assert.equal(result.docs, null)
  assert.equal(result.verdicts.length, 1, 'a failed channel must not empty the verdicts')
})

// ---------------------------------------------------------------- reconciliation

test('a verdict is matched to its topic by position, not by the key the analyst echoed', async () => {
  const { result } = await run({
    plan: PLAN({ topics: [{ key: 'a', find: 'find a' }, { key: 'b', find: 'find b' }] }),
    'scout:': HITS(),
    'analyze:a': VERDICT('typo-not-a'),
    'analyze:b': VERDICT('b'),
  })

  // Matching on the echoed string counted this verdict as evidence AND its topic as dropped,
  // at the same time: the answer was built on both topics while reporting one as missing.
  assert.equal(result.verdicts.length, 2)
  assert.deepEqual(result.coverage.dropped, [])
  assert.equal(result.coverage.complete, true)
})

test('a topic whose analysis fails is dropped exactly once and fails coverage', async () => {
  const { result } = await run({
    plan: PLAN({ topics: [{ key: 'a', find: 'find a' }, { key: 'b', find: 'find b' }] }),
    'scout:': HITS(),
    'analyze:a': () => { throw new Error('analyst died') },
    'analyze:b': VERDICT('b'),
  })

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
    'analyze:': VERDICT('a'),
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
    'analyze:': VERDICT('a'),
  })

  const analyze = prompts.find((p) => p.opts.label === 'analyze:a')
  assert.match(analyze.prompt, /SEARCHED AND NOT FOUND \(this is evidence of absence\)/)
  assert.match(analyze.prompt, /nothing under tests\//)
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
    'analyze:': VERDICT('a'),
  })

  // The old loop cut this search off after 3 rounds and reported the topic incomplete —
  // a budget wearing the name of a threshold. Progress is the only licence to continue,
  // and while it holds, no counter may end the search (IRON LAW §1).
  const scoutCalls = prompts.filter((p) => String(p.opts.label).startsWith('scout:'))
  assert.equal(scoutCalls.length, rounds)
  assert.equal(result.coverage.complete, true)
})

test('a resumed round that covers no new ground ends the loop as stuck, not another round', async () => {
  const { result, prompts, logs } = await run({
    plan: PLAN(),
    'scout:': HITS({ stop_reason: 'unfinished', not_reached: 'src/legacy/ was never opened' }),
    'analyze:': VERDICT('a'),
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
    'analyze:': VERDICT('a'),
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
    'analyze:': VERDICT('a'),
  })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:')).length, 3,
    'a shrinking remainder is progress even when nothing new is found')
})

test('every planned topic is searched — the topic cap guides the planner, it never drops work', async () => {
  const topics = ['a', 'b', 'c'].map((k) => ({ key: k, find: 'find ' + k }))
  const { result, prompts, logs } = await run({
    plan: PLAN({ topics }),
    'scout:': HITS(),
    'analyze:a': VERDICT('a'),
    'analyze:b': VERDICT('b'),
    'analyze:c': VERDICT('c'),
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
    'analyze:': VERDICT('a'),
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
    'analyze:': VERDICT('a'),
  })

  assert.equal(result.verdicts.length, 1)
  assert.deepEqual(result.coverage.incomplete, [])
  assert.equal(result.coverage.complete, true)
})

test('a report with no stop_reason at all reads as incomplete, never as exhausted', async () => {
  const { result } = await run({
    plan: PLAN(),
    'scout:': { hits: [{ path: 'src/x.js', line: 1, note: 'the thing' }] },
    'analyze:': VERDICT('a'),
  })

  assert.equal(result.verdicts.length, 1, 'the evidence gathered is kept and analyzed')
  assert.deepEqual(result.coverage.incomplete, ['a'])
  assert.equal(result.coverage.complete, false)
})

test('a channel that returns only findings keeps its evidence and reads as incomplete', async () => {
  const { result } = await run({
    plan: PLAN({ history_needed: true, history_question: 'when did X change' }),
    'scout:': HITS(),
    'analyze:': VERDICT('a'),
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
    'analyze:': VERDICT('a'),
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
    'analyze:': VERDICT('a'),
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
    'analyze:a': VERDICT('a'),
    'analyze:b': VERDICT('b'),
  })

  const common = prompts.filter((p) => String(p.opts.label).startsWith('scout:common-ground'))
  assert.equal(common.length, 1, 'the shared surface is searched once, not once per topic')
  assert.doesNotMatch(common[0].prompt, /A separate scout covers this shared ground/,
    'the common scout must never be told to skip the very ground it was sent for')

  for (const key of ['a', 'b']) {
    const scout = prompts.find((p) => p.opts.label === `scout:${key}`)
    assert.match(scout.prompt, /A separate scout covers this shared ground — do not search it/)
    assert.match(scout.prompt, /the Phaser game config in src\/main\.ts/)

    const analyze = prompts.find((p) => p.opts.label === `analyze:${key}`)
    assert.match(analyze.prompt,
      /SHARED GROUND \(scouted once for every topic — treat it as part of your evidence\):/)
    assert.match(analyze.prompt, /src\/main\.ts/,
      'excluding the shared ground from a scout only works if the analyst is handed it')
    assert.ok(analyze.prompt.indexOf('SHARED GROUND') < analyze.prompt.indexOf('Do not search yourself'),
      'the shared ground is evidence, so it belongs before the closing instructions')
  }

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
    'analyze:': VERDICT('a'),
  })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:common-ground')).length, 0,
    'no shared ground means no shared scout to pay for')
  assert.doesNotMatch(prompts.find((p) => p.opts.label === 'scout:a').prompt,
    /A separate scout covers this shared ground/)
  assert.doesNotMatch(prompts.find((p) => p.opts.label === 'analyze:a').prompt, /SHARED GROUND/)
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
    'analyze:': VERDICT('a'),
  })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:common-ground')).length, 2,
    'the shared scout is resumed before it may be reported, then stops as stuck')

  // Evidence shared by every topic is the worst place for a half-done search to go quiet:
  // one unfinished scout would otherwise leave every verdict resting on it (IRON LAW §4).
  assert.ok(result.coverage.incomplete.includes('common-ground'))
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.resumable.remaining.includes('common-ground'))

  const analyze = prompts.find((p) => p.opts.label === 'analyze:a')
  assert.match(analyze.prompt, /WARNING: the shared-ground search did NOT finish/)
  assert.match(analyze.prompt, /src\/scenes\/ was never opened/)
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
    'analyze:': VERDICT('a'),
  })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:common-ground')).length, 0)
  assert.doesNotMatch(prompts.find((p) => p.opts.label === 'analyze:a').prompt, /SHARED GROUND/)
  assert.equal(result.coverage.complete, true)
})

// ------------------------------------------------------ the knowledge base, consumed
//
// The Plan phase receives the tree INDEX — where
// this repository knows anything, and of what kind — because before a decomposition exists the
// only known paths are the roots, whose chain is the repository-wide node alone. Chains are then
// bought per topic, at the subtree each topic named.
//
// Everything below is about who receives what, and in which of the two grades. Fresh entries are
// EVIDENCE and turn their topic into a verification; stale ones are LEADS for the search and
// reach no analyst; and a finding resting on either kind is distinguishable from one this run
// searched for, because `from_kb` says so and is computed here rather than claimed by a model.
//
// Design: docs/DESIGN.md#knowledge-base-consumption.

test('the index is read before the decomposition, at courier grade, and reaches the planner', async () => {
  const { prompts } = await run({
    'kb-index': INDEX({ 'src/game': { gotcha: 3 }, 'src/game/ui/Gate.ts': { gotcha: 1, command: 1 } }),
    plan: PLAN(),
    'scout:': HITS(),
    'analyze:': VERDICT('a'),
  })

  const at = labelsOf(prompts).indexOf('kb-index')
  assert.equal(at, 0, 'an index read after the decomposition informs no decomposition')

  const index = prompts[at]
  assert.equal(index.opts.agentType, 'vf-agentics:kb')
  assert.equal(index.opts.model, 'haiku', 'pasting a payload back is not judgment')
  assert.match(index.prompt, /node "C:\/plugin\/lib\/kb\.mjs" index "\."/)

  const plan = promptFor(prompts, 'plan')
  assert.match(plan, /WHAT THIS REPOSITORY ALREADY KNOWS, AND WHERE/)
  assert.match(plan, /src\/game — 3 entries \(gotcha: 3\)/)
  assert.match(plan, /src\/game\/ui\/Gate\.ts — 2 entries \(gotcha: 1, command: 1\)/)
  assert.match(plan, /Give every topic a kb_path/)
})

test('the chain is fetched at the subtree the topic named, not at the roots', async () => {
  // The probe's finding, pinned. A chain at the roots reaches the repository-wide node alone,
  // so a deep entry — the kind a mature base is mostly made of — would never reach anybody.
  const { prompts } = await run({
    'kb-index': INDEX({ 'src/game/ui/Gate.ts': { gotcha: 1 } }),
    plan: PLAN({ topics: [{ key: 'a', find: 'find a', kb_path: 'src/game/ui/Gate.ts' }] }),
    'kb-chain': carriedChain({
      'src/game/ui/Gate.ts': [{ claim: 'the gate swallows pointer events while a tween runs' }],
    }),
    'scout:': HITS(),
    'analyze:': VERDICT('a'),
  })

  const chain = promptFor(prompts, 'kb-chain')
  assert.match(chain, /node "C:\/plugin\/lib\/kb\.mjs" chain "\." "src\/game\/ui\/Gate\.ts"/)
  assert.match(promptFor(prompts, 'scout:a'), /the gate swallows pointer events while a tween runs/)
})

test('a fresh entry makes its topic a verification and reaches the analyst as cached evidence', async () => {
  const { result, prompts } = await run({
    'kb-index': INDEX({ 'src/a': { gotcha: 1 } }),
    'kb-chain': carriedChain({
      'src/a': [{ claim: 'the loader is registered in src/a/boot.ts', observed_at: 'abc1234' }],
    }),
    plan: PLAN(),
    'scout:': HITS(),
    'analyze:': VERDICT('a'),
  })

  const scout = promptFor(prompts, 'scout:a')
  assert.match(scout, /ALREADY RECORDED ABOUT THIS GROUND/)
  assert.match(scout, /They are EVIDENCE, not a search you have to redo/)
  assert.match(scout, /this topic is a VERIFICATION rather than a rediscovery/)
  assert.match(scout, /the loader is registered in src\/a\/boot\.ts/)

  const analyze = promptFor(prompts, 'analyze:a')
  assert.match(analyze, /KNOWN BEFORE THIS RUN/)
  assert.match(analyze, /this run did not go and see it again/)
  assert.match(analyze, /from the knowledge base, observed at <commit>/,
    'a conclusion resting on cache has to be sayable as one')

  assert.equal(result.coverage.complete, true)
  assert.equal(result.coverage.from_kb.length, 2)
  assert.match(result.coverage.from_kb[0], /^a: 1 fresh knowledge-base entry for src\/a/)
  assert.match(result.coverage.from_kb[0], /observed at abc1234/)
  assert.match(result.coverage.from_kb[0], /did not re-establish what they carry/)
})

test('a stale entry is a lead for the search and reaches no analyst', async () => {
  const { result, prompts } = await run({
    'kb-index': INDEX({ 'src/a': { gotcha: 2 } }),
    'kb-chain': carriedChain({
      'src/a': [
        { claim: 'the loader used to be registered in src/a/boot.ts', state: 'stale' },
        { claim: 'a claim about ground that is gone', state: 'orphaned' },
      ],
    }),
    plan: PLAN(),
    'scout:': HITS(),
    'analyze:': VERDICT('a'),
  })

  const scout = promptFor(prompts, 'scout:a')
  assert.match(scout, /LEADS — the base held these and the ground has moved since/)
  assert.match(scout, /never report a location you have not seen for yourself/)
  assert.match(scout, /the loader used to be registered/)
  assert.ok(!/ground that is gone/.test(scout), 'orphaned ground is not a place to look')
  assert.ok(!/ALREADY RECORDED ABOUT THIS GROUND/.test(scout),
    'a lead is not evidence, and a scout told otherwise reports a claim as a location')

  const analyze = promptFor(prompts, 'analyze:a')
  assert.ok(!/KNOWN BEFORE THIS RUN/.test(analyze))
  assert.ok(!/the loader used to be registered/.test(analyze),
    'an analyst judges what was found; a lead is for somebody going looking')

  assert.deepEqual(result.coverage.from_kb, [],
    'no verdict rests on a lead, so claiming provenance for one would make the field mean less')
})

test('a topic on ground the base knows nothing about is planned and searched exactly as before', async () => {
  const { result, prompts } = await run({
    'kb-index': INDEX({ 'src/a': { gotcha: 1 } }),
    plan: PLAN({
      topics: [{ key: 'a', find: 'find a', kb_path: 'src/a' }, { key: 'b', find: 'find b', kb_path: 'src/b' }],
    }),
    'kb-chain': carriedChain({ 'src/a': [{ claim: 'a fact about a ground' }], 'src/b': [] }),
    'scout:': HITS(),
    'analyze:a': VERDICT('a'),
    'analyze:b': VERDICT('b'),
  })

  assert.ok(!/ALREADY RECORDED|LEADS —/.test(promptFor(prompts, 'scout:b')))
  assert.ok(!/a fact about a ground/.test(promptFor(prompts, 'scout:b')),
    'chains are bounded by path, and so is what a search is taxed with reading')
  assert.equal(result.coverage.from_kb.length, 1)
  assert.match(result.coverage.from_kb[0], /^a: /)
})

test('every topic on fresh ground is stated as a verification pass, not left to be inferred', async () => {
  const { result, logs } = await run({
    'kb-index': INDEX({ 'src/a': { gotcha: 1 } }),
    'kb-chain': carriedChain({ 'src/a': [{ claim: 'a fact about a ground' }] }),
    plan: PLAN(),
    'scout:': HITS(),
    'analyze:': VERDICT('a'),
  })

  // The degenerate case of the topology rule: a phase that shrank must say it shrank, or the
  // leanness is invisible and re-maximalizes the moment nobody is watching.
  assert.ok(result.coverage.from_kb.some((l) => /verification pass rather than a discovery survey/.test(l)))
  assert.ok(logs.some((l) => /ran as a verification pass/.test(l)))
  assert.equal(result.coverage.complete, true)
})

test('an empty index buys no chain at all', async () => {
  const { result, prompts } = await run({ plan: PLAN(), 'scout:': HITS(), 'analyze:': VERDICT('a') })

  assert.ok(!labelsOf(prompts).includes('kb-chain'),
    'a chain over a tree holding nothing is a dispatch bought for nothing')
  assert.deepEqual(result.coverage.from_kb, [])
  assert.equal(result.coverage.complete, true)
})

test('a knowledge base that cannot be read costs the survey nothing it was going to have', async () => {
  const { result, prompts, logs } = await run({
    'kb-index': { stop_reason: 'failed', payload_raw: '', notes: 'node is not on the PATH' },
    plan: PLAN(),
    'scout:': HITS(),
    'analyze:': VERDICT('a'),
  })

  assert.match(logs.join(' '), /the knowledge base could not be read/)
  assert.ok(!labelsOf(prompts).includes('kb-chain'))

  // An unreadable base means MORE searching, not less evidence: every topic is searched from
  // scratch, exactly as a survey with no knowledge base runs. So it is not a failed channel
  // here — `failed_channels` is a conjunct of `complete` in this workflow — and the loss is
  // recorded where a reader looks for provenance.
  assert.deepEqual(result.coverage.failed_channels, [])
  assert.equal(result.coverage.complete, true)
  assert.ok(result.coverage.from_kb.some((l) => /could not be read/.test(l)))
  assert.ok(result.coverage.from_kb.some((l) => /searched from scratch/.test(l)))
  assert.ok(!/ALREADY RECORDED|LEADS —/.test(promptFor(prompts, 'scout:a')))
})

test('a chain damaged in transit is refused rather than believed', async () => {
  const { result, prompts, logs } = await run({
    'kb-index': INDEX({ 'src/a': { gotcha: 1 } }),
    'kb-chain': carriedChain(
      { 'src/a': [{ claim: 'a fact about a ground' }] },
      (env) => { env.payload.chains[0].entries[0].claim = 'a claim nobody wrote' },
    ),
    plan: PLAN(),
    'scout:': HITS(),
    'analyze:': VERDICT('a'),
  })

  assert.match(logs.join(' '), /digest mismatch/)
  assert.ok(!/a claim nobody wrote/.test(promptFor(prompts, 'scout:a')))
  assert.deepEqual(result.coverage.failed_channels, [])
  assert.equal(result.coverage.complete, true)
  assert.ok(result.coverage.from_kb.some((l) => /chains could not be read/.test(l)))
})

test('a plan from before kb_path existed reads as repository-wide, not as a crash', async () => {
  const legacy = {
    topics: [{ key: 'a', find: 'find a' }],
    docs_needed: false, docs_question: '',
    history_needed: false, history_question: '',
  }
  assert.ok(!('kb_path' in legacy.topics[0]), 'the legacy topic shape genuinely omits the field')

  const { result, prompts } = await run({
    'kb-index': INDEX({ '': { gotcha: 1 } }),
    plan: legacy,
    'kb-chain': carriedChain({ '': [{ claim: 'this repository builds with npm' }] }),
    'scout:': HITS(),
    'analyze:': VERDICT('a'),
  })

  assert.match(promptFor(prompts, 'kb-chain'), /chain "\." "\."/,
    'the repository-wide level travels as ".", because an empty argv slot is unreadable')
  assert.match(promptFor(prompts, 'scout:a'), /this repository builds with npm/)
  assert.match(result.coverage.from_kb[0], /\(repository-wide\)/)
  assert.equal(result.coverage.complete, true)
})

test("a channel's evidence of absence travels with its findings", async () => {
  const { result } = await run({
    plan: PLAN({ history_needed: true, history_question: 'when did X change' }),
    'scout:': HITS(),
    'analyze:': VERDICT('a'),
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
    { plan: PLAN(), 'scout:': HITS(), 'analyze:': VERDICT('a') },
    { prior: 'an earlier pass concluded the loader lives in src/boot' },
  )

  assert.match(promptFor(prompts, 'plan'), /an earlier pass concluded/)
  assert.match(promptFor(prompts, 'plan'), /somebody's notes, not\s+evidence/)
  assert.match(promptFor(prompts, 'plan'), /NEVER to decide a topic does not need searching/)

  for (const label of ['scout:a', 'analyze:a']) {
    assert.doesNotMatch(promptFor(prompts, label), /an earlier pass concluded/,
      `${label} was handed unverified prior context`)
  }
})

test('prior context changes no count: every topic is still searched', async () => {
  const { result } = await run(
    { plan: PLAN({ topics: [
      { key: 'a', find: 'find a', kb_path: 'src/a' },
      { key: 'b', find: 'find b', kb_path: 'src/b' },
    ] }), 'scout:': HITS(), 'analyze:': (p) => VERDICT(/THIS TOPIC: find b/.test(p) ? 'b' : 'a') },
    { prior: 'both of these were answered last week' },
  )

  assert.deepEqual(result.topics, ['a', 'b'])
  assert.equal(result.coverage.complete, true)
})

// ------------------------------------------------------------- absence deposits

const recorded = { stop_reason: 'recorded', path: '.claude/vfa/kb', notes: 'written' }
const EMPTY = (over = {}) => HITS({ hits: [], no_match: 'no retry helper anywhere under src/a', ...over })

test('an exhausted search that found nothing is deposited as an absence', async () => {
  const { prompts, result } = await run({
    plan: PLAN(), 'scout:': EMPTY(), 'analyze:': VERDICT('a'), 'kb-deposit': recorded,
  })

  const deposit = promptFor(prompts, 'kb-deposit')
  assert.match(deposit, /DEPOSIT MODE/)
  assert.match(deposit, /lib\/kb\.mjs" append "\."/)
  assert.match(result.coverage.from_kb.join(' '), /deposited to\s+the project knowledge base/)
  assert.match(result.coverage.from_kb.join(' '), /Nothing in THIS result came from them/)
})

test('a search that found something deposits nothing — absence is not "we are done here"', async () => {
  const { prompts } = await run({
    plan: PLAN(), 'scout:': HITS(), 'analyze:': VERDICT('a'),
  })

  assert.equal(labelsOf(prompts).includes('kb-deposit'), false)
})

test('a search that stopped short deposits nothing, whatever it did not find', async () => {
  const { prompts } = await run({
    plan: PLAN(),
    'scout:': EMPTY({ stop_reason: 'unfinished', not_reached: 'the whole of src/a/deep' }),
    'analyze:': VERDICT('a'),
  })

  assert.equal(labelsOf(prompts).includes('kb-deposit'), false,
    'an absence from a search that never finished is a false negative filed as evidence')
})

test('a repository-wide topic deposits nothing — an absence about everything says nothing', async () => {
  const { prompts } = await run({
    plan: PLAN({ topics: [{ key: 'a', find: 'find a', kb_path: '' }] }),
    'scout:': EMPTY(), 'analyze:': VERDICT('a'),
  })

  assert.equal(labelsOf(prompts).includes('kb-deposit'), false)
})

test('the id is minted from the subtree and the key, so a reworded claim shadows rather than piles up', async () => {
  const idOf = async (noMatch) => {
    const { prompts } = await run({
      plan: PLAN(), 'scout:': EMPTY({ no_match: noMatch }), 'analyze:': VERDICT('a'),
      'kb-deposit': recorded,
    })
    const token = promptFor(prompts, 'kb-deposit').match(/--b64 ([A-Za-z0-9+/=]+)/)[1]
    return JSON.parse(Buffer.from(token, 'base64').toString('utf8')).entries[0]
  }

  const first = await idOf('no retry helper anywhere under src/a')
  const second = await idOf('searched src/a for a retry helper; there is none')

  assert.equal(first.id, second.id, 'the same ground searched twice mints the same id')
  assert.notEqual(first.claim, second.claim, 'the prose still carries what was actually looked for')
  assert.equal(first.kind, 'absence')
  assert.deepEqual(first.about, ['src/a'])
  assert.equal(first.observed_at, 'HEAD', 'the commit is measured by the writer, not guessed here')
  assert.equal(first.source.via, 'survey-absence')
})

test('a deposit that does not land costs the result nothing and is said out loud', async () => {
  const { result } = await run({
    plan: PLAN(), 'scout:': EMPTY(), 'analyze:': VERDICT('a'),
    'kb-deposit': { stop_reason: 'unwritable', path: '', notes: 'the writer refused' },
  })

  assert.equal(result.coverage.complete, true, 'a deposit is written for the NEXT run')
  assert.match(result.coverage.from_kb.join(' '), /pays\s+for the same empty searches again/)
})

test('the result names the ground its topics searched, repository-wide as "."', async () => {
  const { result } = await run({
    plan: PLAN({
      topics: [
        { key: 'a', find: 'find a', kb_path: 'src/a/' },
        { key: 'b', find: 'find b', kb_path: '' },
        { key: 'c', find: 'find c', kb_path: 'src/a' },
      ],
    }),
    'scout:': HITS(),
    'analyze:': VERDICT('a'),
  })

  assert.deepEqual([...result.ground].sort(), ['.', 'src/a'],
    'one entry per subtree, so a later freshness check asks git once per path')
})
