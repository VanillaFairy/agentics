// test/agentics-survey-scenarios.test.mjs — the survey workflow's accounting arithmetic, executed.
//
// Lint judges form and cannot reach any of this: whether a channel nobody ran is recorded,
// whether a ruling is matched to its topic by position or by a string the model retyped,
// whether a half-finished channel still reports complete. Each test below pins a way a
// PARTIAL result could come back wearing the shape of a WHOLE one (IL2), or a way data could
// travel through a model that should have stayed where its author wrote it (GP6).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import {
  carriedEnvelope, contextPath, courierCommand, courierProblems, flagValues, returnFileOf, runWorkflow, scriptedAgents,
} from './harness/workflow-host.mjs'
import { ITEM_KINDS } from '../lib/evidence.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import { nameKey } from '../lib/store.mjs'
import { overruns } from './harness/path-limits.mjs'

const WF = fileURLToPath(new URL('../service-workflows/gather-evidence-without-concluding.workflow.js', import.meta.url))
const QUESTION = 'how does X work'

const PLAN = (over = {}) => ({
  topics: [{ key: 'a', subtree: 'src/a' }], common_ground: false, docs_needed: false, history_needed: false, ...over,
})

const HITS = (over = {}) => ({ hits: [{ path: 'src/x.js', line: 1 }], stop_reason: 'exhausted', not_reached: '', ...over })

const CHANNEL = (over = {}) => ({ stop_reason: 'exhausted', not_reached: '', ...over })

/** The topic keys a judge dispatch was given — its schema's closed enum. */
const keysOf = (opts) => opts.schema.properties.topics.items.properties.topic.enum

/** A judge that writes one item for every topic it holds. */
const judgeAll = (prompt, opts) => ({ topics: keysOf(opts).map((topic) => ({ topic, items_n: 1, risks_n: 0 })) })
const ruling = (topic, items_n = 1, risks_n = 0) => ({ topic, items_n, risks_n })

const idOf = (topic, n = 1) => 'I' + fnv1a(topic + ':' + n)

/**
 * The lib side of a run, simulated: a record courier stores one item per topic it is handed and
 * names its return; the context courier lists what the returns it is handed stored, after the
 * pool's standing items when it is handed the caller's ground. Every answer is a handle envelope.
 */
function store(poolItems = () => []) {
  const stored = new Map()
  let n = 0
  return {
    stored,
    record: (prompt) => {
      const topics = flagValues(courierCommand(prompt), 'topic')
      const name = `20260926-12000${n++}-survey`
      stored.set(name, topics.map((topic) => ({ id: idOf(topic), topic, kind: 'behaviour', state: 'standing', return: name })))
      return carriedEnvelope({ ok: true, return: name, recorded_n: topics.length, dropped_n: 0 })
    },
    context: (prompt) => {
      const command = courierCommand(prompt)
      const known = /--ground /.test(command) ? poolItems().filter((it) => it.state === 'standing')
        .map(({ id, topic, kind, state }) => ({ id, topic, kind, state, return: '20260920-101500-survey' })) : []
      const own = flagValues(command, 'return').flatMap((r) => stored.get(r) || [])
      return carriedEnvelope({
        items: known.concat(own), context: contextPath('survey'),
        counts: { items: known.length + own.length, risks: 0, history: 0, docs: 0 },
      })
    },
  }
}

const assembleAll = (prompt) => carriedEnvelope({
  context: contextPath('assemble-' + fnv1a(courierCommand(prompt))),
  counts: { locations: 1, files: 1, excerpts: 1, unresolved: 0, reports: 1, unread_reports: 0, bytes: 10 },
})

/** The topics the result holds items for, in the order its items came. */
const itemTopics = (result) => [...new Set(result.items.map((i) => i.topic))]

// Every survey that finds a location assembles it, judges it, records what the judge wrote and
// writes its one context file, so every scenario scripts those with the ordinary case — which is
// what keeps the tests below about the thing each one is testing.
const run = (script, over = {}, pool) => {
  const lib = store(pool)
  return runWorkflow(WF, {
    args: { question: QUESTION, plugin_root: 'C:/plugin', ...over },
    agent: scriptedAgents({
      assemble: assembleAll, 'assemble:': assembleAll, judge: judgeAll, 'judge:': judgeAll,
      record: lib.record, 'record:': lib.record, context: lib.context, ...script,
    }),
  })
}

const promptFor = (prompts, label) => (prompts.find((p) => p.opts.label === label) || {}).prompt || ''
const labelsOf = (prompts) => prompts.map((p) => p.opts.label || '')
const commandFor = (prompts, label) => courierCommand(promptFor(prompts, label))

// ------------------------------------------- couriers carry handles

test('every courier in a full run carries handles only, both ways', async () => {
  const pool = [POOL_ITEM(1), POOL_ITEM(2, SUSPECT)]
  const { prompts, result } = await run({
    reuse: POOL(pool), 'rejudge:': { written_n: 1 }, 'record-judgements:': JUDGED,
    'reuse-after': POOL([pool[0], { ...pool[1], state: 'standing' }]),
    plan: PLAN({ history_needed: true }), 'scout:': HITS(), history: CHANNEL(),
    record: refuseOnce(), 'record:anchors:1': store().record, 'judge:anchors:1': { written_n: 1 },
  }, GROUND, () => pool)

  assert.deepEqual(courierProblems(prompts), [])
  const couriers = prompts.filter((p) => p.opts.agentType === 'agentics:courier').map((p) => p.opts.label)
  for (const label of ['reuse', 'record-judgements:1', 'reuse-after', 'assemble', 'record', 'record:anchors:1', 'context']) {
    assert.ok(couriers.includes(label), label)
  }
  assert.equal(result.coverage.complete, true)
})

test('every agent whose output lib reads is named a return file, under the inbox, distinct per dispatch', async () => {
  const { prompts } = await run({ plan: PLAN({ docs_needed: true }), 'scout:': HITS(), docs: CHANNEL() })
  const files = ['plan', 'scout:a', 'docs', 'judge'].map((label) => returnFileOf(promptFor(prompts, label)))
  for (const f of files) assert.match(f, /^\.\/\.agentics\/\.state\/evidence\/inbox\/[A-Za-z0-9._-]+-[0-9a-f]{8}\.json$/)
  assert.equal(new Set(files).size, files.length)
  assert.match(promptFor(prompts, 'judge'), /"items": \[\{"topic"/, 'the dispatch states the shape the file takes')
})

test('the same dispatch names the same return file, so a retry rewrites it', async () => {
  const a = await run({ plan: PLAN(), 'scout:': HITS() })
  const b = await run({ plan: PLAN(), 'scout:': HITS() })
  for (const label of ['plan', 'scout:a', 'judge']) {
    assert.equal(returnFileOf(promptFor(a.prompts, label)), returnFileOf(promptFor(b.prompts, label)), label)
  }
})

test('the plan is a file: scouts and judges are pointed at it, and the store checks its question', async () => {
  const { prompts } = await run({ plan: PLAN(), 'scout:': HITS() })
  const planFile = returnFileOf(promptFor(prompts, 'plan'))
  assert.match(promptFor(prompts, 'plan'), /Copy the QUESTION into the file exactly/)
  assert.ok(promptFor(prompts, 'scout:a').includes(`the topic keyed "a" in the plan file ${planFile}`))
  assert.ok(promptFor(prompts, 'judge').includes(planFile))

  const record = commandFor(prompts, 'record')
  assert.deepEqual(flagValues(record, 'plan'), [planFile])
  assert.deepEqual(flagValues(record, 'question-digest'), [fnv1a(QUESTION)])
  assert.deepEqual([flagValues(record, 'topic'), flagValues(record, 'subtree')], [['a'], ['src/a']])
  assert.deepEqual(flagValues(record, 'from'), [returnFileOf(promptFor(prompts, 'judge'))])
})

// ------------------------------------------- the intelligence dial

// `develop` forwards its own dial into this nested call, so a run dialled to `low` reaches
// its analysis here and nowhere else. The dial is only real where it reaches an `opts.model`.
test('`low` puts the analysts on sonnet and leaves the search tier alone', async () => {
  const { prompts } = await run({ plan: PLAN(), 'scout:': HITS() }, { intelligence: 'low' })
  const modelOf = (label) => prompts.find((p) => p.opts.label === label).opts.model

  assert.equal(modelOf('plan'), 'sonnet', 'the analyst that plans the topics is a judging agent')
  assert.equal(modelOf('judge'), 'sonnet', 'and so is the one that rules on each')
  assert.equal(modelOf('scout:a'), undefined, 'search never moves with the dial')
})

test('`normal` names opus rather than inheriting it', async () => {
  const { prompts } = await run({ plan: PLAN(), 'scout:': HITS() }, { intelligence: 'normal' })
  const modelOf = (label) => prompts.find((p) => p.opts.label === label).opts.model

  assert.equal(modelOf('plan'), 'opus')
  assert.equal(modelOf('judge'), 'opus')
  assert.equal(modelOf('scout:a'), undefined, 'the search tier is not on the dial')
})

test('a tier this script does not define is served as normal, not as itself', async () => {
  const { prompts } = await run({ plan: PLAN(), 'scout:': HITS() }, { intelligence: 'cheap' })
  assert.equal(prompts.find((p) => p.opts.label === 'plan').opts.model, 'opus')
})

// ------------------------------------------- a requested channel that produced nothing

test('a channel that throws is recorded without discarding the work already paid for', async () => {
  const { result } = await run({
    plan: PLAN({ docs_needed: true }), 'scout:': HITS(), docs: () => { throw new Error('network is down') },
  })

  assert.deepEqual(result.coverage.failed_channels, ['docs'])
  assert.equal(result.docs, null)
  assert.deepEqual(itemTopics(result), ['a'], 'a failed channel must not empty the items')
})

// ---------------------------------------------------------------- reconciliation

test('a ruling under a key the judge was not given rules on nothing, and its topic is continued', async () => {
  const { result, prompts } = await run({
    plan: PLAN({ topics: [{ key: 'a', subtree: '' }, { key: 'b', subtree: '' }] }),
    'scout:': HITS(),
    judge: { topics: [ruling('b')] },
    'judge#2': { topics: [] },
  })

  assert.deepEqual(result.coverage.dropped, ['a'])
  assert.equal(result.coverage.complete, false)
  assert.deepEqual(keysOf(prompts.find((p) => p.opts.label === 'judge#2').opts), ['a'], 'the unruled topic is continued first')
})

test('a topic whose judge fails is dropped exactly once and fails coverage', async () => {
  const { result } = await run({
    plan: PLAN({ topics: [{ key: 'a', subtree: '' }, { key: 'b', subtree: '' }] }),
    'scout:': HITS(),
    'judge:a': () => { throw new Error('analyst died') },
  }, { pace: 'fast' })

  assert.deepEqual(itemTopics(result), ['b'])
  assert.deepEqual(result.coverage.dropped, ['a'])
  assert.deepEqual(result.coverage.incomplete, [], 'a dropped topic must not also count as incomplete')
  assert.equal(result.coverage.complete, false)
})

// ---------------------------------------------------------------- the resume loop

test('the resume round is handed what was never reached and the earlier reports, not what was proven absent', async () => {
  const { result, prompts } = await run({
    plan: PLAN(),
    'scout:a#2': HITS({ hits: [{ path: 'src/legacy/x.js', line: 4 }] }),
    'scout:a': HITS({ stop_reason: 'unfinished', not_reached: 'src/legacy/ was never opened' }),
  })

  const resume = promptFor(prompts, 'scout:a#2')
  assert.ok(resume, 'a non-exhausted scout must be resumed rather than reported')
  assert.match(resume, /STILL NOT REACHED[\s\S]*src\/legacy\/ was never opened/)
  assert.ok(resume.includes(returnFileOf(promptFor(prompts, 'scout:a'))), 'what round 1 searched and found is read from its file')
  assert.notEqual(returnFileOf(resume), returnFileOf(promptFor(prompts, 'scout:a')))
  assert.deepEqual(flagValues(commandFor(prompts, 'assemble'), 'hits'),
    [returnFileOf(promptFor(prompts, 'scout:a')), returnFileOf(resume)], 'both rounds reach the judge')
  assert.equal(result.coverage.complete, true)
})

test('a search still finding new ground is resumed past any round count', async () => {
  const rounds = 5
  const { result, prompts } = await run({
    plan: PLAN(),
    'scout:': (prompt, opts) => {
      const suffix = /#(\d+)$/.exec(String(opts.label))
      const r = suffix ? Number(suffix[1]) : 1
      return r < rounds
        ? HITS({ hits: [{ path: 'src/x.js', line: r }], stop_reason: 'unfinished', not_reached: `surface ${r + 1}` })
        : HITS({ hits: [{ path: 'src/x.js', line: r }] })
    },
  })

  // Progress is the only licence to continue, and while it holds, no counter may end the search (IL1).
  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:')).length, rounds)
  assert.equal(result.coverage.complete, true)
})

test('a resumed round that covers no new ground ends the loop as stuck, not another round', async () => {
  const { result, prompts, logs } = await run({
    plan: PLAN(),
    'scout:': HITS({ stop_reason: 'unfinished', not_reached: 'src/legacy/ was never opened' }),
  })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:')).length, 2)
  assert.deepEqual(result.coverage.incomplete, ['a'])
  assert.equal(result.coverage.complete, false)
  assert.ok(logs.some((l) => /brought back nothing new/.test(l)))
})

test('a scout that rewords its remainder but finds nothing new is stuck, not progressing', async () => {
  let round = 0
  const { result, prompts } = await run({
    plan: PLAN(),
    'scout:': () => HITS({ stop_reason: 'unfinished', not_reached: round++ % 2 ? 'src/legacy/  was never opened' : 'SRC/legacy/ was never opened' }),
  })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:')).length, 2,
    'case and whitespace are not new ground')
  assert.deepEqual(result.coverage.incomplete, ['a'])
})

test('a round that narrows the remainder keeps going even with no new hits', async () => {
  const remainders = ['src/legacy/ and src/vendor/', 'src/vendor/ only', '']
  let round = 0
  const { prompts } = await run({
    plan: PLAN(),
    'scout:': () => {
      const not_reached = remainders[Math.min(round++, remainders.length - 1)]
      return HITS({ hits: [], stop_reason: not_reached ? 'unfinished' : 'exhausted', not_reached })
    },
  })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:')).length, 3,
    'a shrinking remainder is progress even when nothing new is found')
})

test('every planned topic is searched — the topic cap guides the planner, it never drops work', async () => {
  const topics = ['a', 'b', 'c'].map((key) => ({ key, subtree: '' }))
  const { result, prompts, logs } = await run({ plan: PLAN({ topics }), 'scout:': HITS() }, { max_topics: 2 })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:')).length, 3)
  assert.deepEqual(result.coverage.dropped, [])
  assert.equal(result.coverage.complete, true)
  assert.ok(logs.some((l) => /searching all of them/.test(l)))
})

test('a planner\'s key is spelled as a handle, and the scout is pointed at the planner\'s own spelling', async () => {
  const { result, prompts } = await run({ plan: PLAN({ topics: [{ key: 'Config Loader', subtree: 'src' }] }), 'scout:': HITS() })
  assert.deepEqual(result.topics, ['config-loader'])
  assert.match(promptFor(prompts, 'scout:config-loader'), /the topic keyed "Config Loader" in the plan file/)
  assert.deepEqual(flagValues(commandFor(prompts, 'record'), 'topic'), ['config-loader'])
})

test('a scout that stops without naming what it missed is a dead end, not a resume', async () => {
  const { result, prompts } = await run({ plan: PLAN(), 'scout:a': HITS({ stop_reason: 'stuck', not_reached: '   ' }) })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:')).length, 1)
  assert.deepEqual(result.coverage.incomplete, ['a'])
  assert.equal(result.coverage.complete, false)
})

// ------------------------------------------------------ omitted coverage fields
//
// The schema requires only the payload field; the coverage fields are normalized here in
// JS. Absence must degrade toward incomplete, never toward false completeness — and never
// toward a dropped result.

test('an exhausted report missing the empty coverage fields is complete, not dropped', async () => {
  const { result } = await run({ plan: PLAN(), 'scout:': { hits: [{ path: 'src/x.js', line: 1 }], stop_reason: 'exhausted' } })

  assert.equal(itemTopics(result).length, 1)
  assert.deepEqual(result.coverage.incomplete, [])
  assert.equal(result.coverage.complete, true)
})

test('a report with no stop_reason at all reads as incomplete, never as exhausted', async () => {
  const { result } = await run({ plan: PLAN(), 'scout:': { hits: [{ path: 'src/x.js', line: 1 }] } })

  assert.equal(itemTopics(result).length, 1, 'the evidence gathered is kept and analyzed')
  assert.deepEqual(result.coverage.incomplete, ['a'])
  assert.equal(result.coverage.complete, false)
})

// ------------------------------------------------------ evidence-channel coverage

test('a channel that cannot finish makes coverage incomplete, after the resume is spent', async () => {
  const stalled = CHANNEL({ stop_reason: 'unfinished', not_reached: 'every ref older than 2024' })
  const { result, prompts } = await run({
    plan: PLAN({ history_needed: true }), 'scout:': HITS(), history: stalled, 'history#2': stalled,
  })

  assert.ok(prompts.some((p) => p.opts.label === 'history#2'), 'an unfinished channel is resumed before it may be reported')
  assert.deepEqual(result.coverage.failed_channels, [])
  assert.ok(result.coverage.incomplete.includes('history'))
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.resumable.remaining.includes('history'))
  assert.deepEqual(result.history, [returnFileOf(promptFor(prompts, 'history')), returnFileOf(promptFor(prompts, 'history#2'))])
})

test('an unfinished evidence channel is resumed to exhaustion, and its reports reach the context file', async () => {
  const { result, prompts } = await run({
    plan: PLAN({ history_needed: true }), 'scout:': HITS(),
    history: CHANNEL({ stop_reason: 'unfinished', not_reached: 'refs older than 2024' }),
    'history#2': CHANNEL(),
  })

  const resumed = promptFor(prompts, 'history#2')
  assert.match(resumed, /STILL NOT REACHED[\s\S]*refs older than 2024/)
  assert.ok(promptFor(prompts, 'history').includes('history_question in the plan file'))
  assert.equal(result.coverage.complete, true)
  assert.deepEqual(flagValues(commandFor(prompts, 'context'), 'history'), result.history)
})

// ------------------------------------------------------------------ shared ground
//
// `common_ground` is the planner's way to name a surface several topics share once; these tests
// pin that it is searched once, excluded from the topic scouts, delivered to every judge, and —
// when it does not finish — visible as a limit rather than as silence.

test('shared ground is scouted once, kept out of the topic scouts, and reaches every judge', async () => {
  const { result, prompts } = await run({
    plan: PLAN({ topics: [{ key: 'a', subtree: '' }, { key: 'b', subtree: '' }], common_ground: true }),
    'scout:common-ground': HITS({ hits: [{ path: 'src/main.ts', line: 12 }] }),
    'scout:': HITS(),
  })

  const common = prompts.filter((p) => String(p.opts.label).startsWith('scout:common-ground'))
  assert.equal(common.length, 1, 'the shared surface is searched once, not once per topic')
  assert.match(common[0].prompt, /Your charge is the common_ground instruction in the plan file/)
  assert.doesNotMatch(common[0].prompt, /A separate scout covers/)

  for (const key of ['a', 'b']) assert.match(promptFor(prompts, `scout:${key}`), /A separate scout covers the common_ground instruction/)

  const commonFile = returnFileOf(common[0].prompt)
  assert.ok(flagValues(commandFor(prompts, 'assemble'), 'hits').includes(commonFile), 'its report is assembled with the rest')
  assert.match(promptFor(prompts, 'judge'), /SHARED GROUND — scouted once for every topic/)
  assert.equal(result.coverage.complete, true)
  assert.deepEqual(result.coverage.unreached.concat(result.coverage.resumable.remaining), [])
})

test('no common ground changes nothing about the run', async () => {
  const { result, prompts } = await run({ plan: PLAN({ common_ground: false }), 'scout:': HITS() })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:common-ground')).length, 0)
  assert.doesNotMatch(promptFor(prompts, 'scout:a'), /A separate scout covers/)
  assert.doesNotMatch(promptFor(prompts, 'judge'), /SHARED GROUND/)
  assert.equal(result.coverage.complete, true)
})

test('a shared scout that cannot finish is incomplete work and warns every judge', async () => {
  const stalled = HITS({ stop_reason: 'unfinished', not_reached: 'src/scenes/ was never opened' })
  const { result, prompts } = await run({
    plan: PLAN({ common_ground: true }), 'scout:common-ground': stalled, 'scout:common-ground#2': stalled, 'scout:': HITS(),
  })

  assert.equal(prompts.filter((p) => String(p.opts.label).startsWith('scout:common-ground')).length, 2)
  assert.ok(result.coverage.incomplete.includes('common-ground'))
  assert.equal(result.coverage.complete, false)
  assert.match(promptFor(prompts, 'judge'), /the shared-ground search did NOT finish[\s\S]*src\/scenes\/ was never opened/)
})

// ------------------------------------------------------------- prior context

test('prior context reaches the planner and no searching agent', async () => {
  const { prompts } = await run({ plan: PLAN(), 'scout:': HITS() }, { prior: 'an earlier pass concluded the loader lives in src/boot' })

  assert.match(promptFor(prompts, 'plan'), /an earlier pass concluded/)
  assert.match(promptFor(prompts, 'plan'), /NEVER to decide a topic does not need searching/)
  for (const label of ['scout:a', 'judge']) assert.doesNotMatch(promptFor(prompts, label), /an earlier pass concluded/, label)
})

test('the result names the ground its topics searched, repository-wide as "."', async () => {
  const { result } = await run({
    plan: PLAN({ topics: [{ key: 'a', subtree: 'src/a/' }, { key: 'b', subtree: '' }, { key: 'c', subtree: 'src/a' }] }),
    'scout:': HITS(),
  })
  assert.deepEqual([...result.ground].sort(), ['.', 'src/a'])
})

// ------------------------------------------------------------------ assemble
//
// Each judge's scout reports are read ONCE, by a script, into one file the judge Reads. The
// courier carries the reports' paths in and the file's path back.

const assemblies = (prompts) => prompts.filter((p) => /^assemble/.test(p.opts.label))

test('a judge\'s scout reports, the shared ground\'s included, are assembled once into a file it reads', async () => {
  const { prompts } = await run({
    plan: PLAN({ topics: [{ key: 'a', subtree: '' }, { key: 'b', subtree: '' }], common_ground: true }),
    'scout:common-ground': HITS({ hits: [{ path: 'src/config.js', line: 7 }] }),
    'scout:': HITS(),
  })

  const [courier] = assemblies(prompts)
  assert.deepEqual(assemblies(prompts).map((p) => p.opts.label), ['assemble'], 'one judge, one courier')
  assert.equal(courier.opts.model, 'haiku', 'carrying a file path back is not judgment')
  assert.match(courierCommand(courier.prompt), /^node "C:\/plugin\/lib\/citations\.mjs" excerpts --repo "\." --hits "/)
  assert.deepEqual(flagValues(courierCommand(courier.prompt), 'hits'),
    ['scout:a', 'scout:b', 'scout:common-ground'].map((l) => returnFileOf(promptFor(prompts, l))))

  const judged = promptFor(prompts, 'judge')
  assert.match(judged, /CONTEXT FILE — read it whole before judging/)
  assert.ok(judged.includes(contextPath('assemble-' + fnv1a(courierCommand(courier.prompt)))))
  assert.doesNotMatch(judged, /SCOUT REPORTS — the script could not assemble them/)
})

test('a search that found nothing assembles nothing and is still judged', async () => {
  const { result, prompts, logs } = await run({ plan: PLAN(), 'scout:': HITS({ hits: [] }) })

  assert.equal(assemblies(prompts).length, 0, 'no locations, no courier')
  assert.ok(logs.some((l) => /No context to assemble/.test(l)))
  assert.match(promptFor(prompts, 'judge'), /SCOUT REPORTS[\s\S]*inbox/, 'its report, absence included, is the judge\'s to read')
  assert.equal(result.coverage.complete, true)
})

test('a context payload damaged in transit is refetched on a stronger courier, then believed', async () => {
  const { result, prompts } = await run({
    plan: PLAN(), 'scout:': HITS(),
    assemble: (p) => carriedEnvelope({ context: contextPath('x'), counts: {} }, (env) => { env.payload.context = 'C:/forged.md' }),
    'assemble#2': assembleAll,
  })

  const retry = prompts.find((p) => p.opts.label === 'assemble#2')
  assert.equal(retry.opts.model, 'sonnet')
  assert.doesNotMatch(promptFor(prompts, 'judge'), /forged/)
  assert.equal(result.coverage.complete, true)
})

test('a handle the program refused as damaged on its way in is carried again by the stronger courier', async () => {
  const refusal = carriedEnvelope({ ok: false, error: { kind: 'args_unreadable' } })
  const { prompts } = await run({
    plan: PLAN(), 'scout:': HITS(),
    // A courier may call a typed refusal a failed run: the program's output decides, not that label.
    assemble: { ...refusal, stop_reason: 'failed' }, 'assemble#2': assembleAll,
  })

  assert.equal(prompts.find((p) => p.opts.label === 'assemble#2').opts.model, 'sonnet')
  assert.match(promptFor(prompts, 'judge'), /CONTEXT FILE/)
})

test('context that cannot be carried is a side channel: the judge reads the scout reports itself', async () => {
  const failed = { stop_reason: 'failed', payload_raw: '', notes: 'node is not on the PATH' }
  const { result, prompts, logs } = await run({ plan: PLAN(), 'scout:': HITS(), assemble: failed, 'assemble#2': failed })

  assert.equal(assemblies(prompts).length, 2, 'retried once, then let go')
  assert.ok(logs.some((l) => /not assembled[\s\S]*node is not on the PATH/.test(l)))
  const judged = promptFor(prompts, 'judge')
  assert.ok(judged.includes('SCOUT REPORTS — the script could not assemble them for you'))
  assert.ok(judged.includes(returnFileOf(promptFor(prompts, 'scout:a'))))
  assert.equal(result.coverage.complete, true, 'more turns for the judge, not less evidence')
})

// ------------------------------------------------------------------ judge

const topicsOf = (n) => Array.from({ length: n }, (_, i) => ({ key: `t${i + 1}`, subtree: '' }))

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
  const spread = (key) => HITS({ hits: Array.from({ length: 40 }, (_, i) => ({ path: `src/${key}.js`, line: 100 * i + 50 })) })
  const { result, prompts, logs } = await run({
    plan: PLAN({ topics: topicsOf(3) }), 'scout:t1': spread('t1'), 'scout:t2': spread('t2'), 'scout:t3': HITS(),
  })

  const judges = prompts.filter((p) => /^judge/.test(p.opts.label))
  assert.equal(judges.length, 2)
  assert.deepEqual(judges.map((j) => keysOf(j.opts)).flat().sort(), ['t1', 't2', 't3'])
  assert.ok(logs.some((l) => /81 location\(s\) earn 2 analysts/.test(l)))
  assert.deepEqual(itemTopics(result).sort(), ['t1', 't2', 't3'])

  const holdsT1 = judges.find((j) => keysOf(j.opts).includes('t1'))
  assert.ok(!keysOf(holdsT1.opts).includes('t2'), 'the two heavy topics land on different judges')
  const courier = assemblies(prompts).find((p) => p.opts.label === holdsT1.opts.label.replace(/^judge/, 'assemble'))
  assert.ok(!flagValues(courierCommand(courier.prompt), 'hits').includes(returnFileOf(promptFor(prompts, 'scout:t2'))))
})

test('pace fast buys one judge per topic, and says it bought them for wall-clock', async () => {
  const { prompts, logs } = await run({ plan: PLAN({ topics: topicsOf(3) }), 'scout:': HITS() }, { pace: 'fast' })

  assert.deepEqual(prompts.filter((p) => /^judge/.test(p.opts.label)).map((p) => p.opts.label), ['judge:t1', 'judge:t2', 'judge:t3'])
  assert.ok(logs.some((l) => /pace is fast/.test(l)))
  assert.deepEqual(prompts.filter((p) => /^record/.test(p.opts.label)).map((p) => p.opts.label), ['record:t1', 'record:t2', 'record:t3'])
})

test('a judge that skips a topic is continued on exactly that topic until it adds none', async () => {
  const { result, prompts } = await run({
    plan: PLAN({ topics: topicsOf(3) }), 'scout:': HITS(),
    judge: { topics: [ruling('t1')] }, 'judge#2': { topics: [ruling('t3')] }, 'judge#3': { topics: [] },
  })

  assert.deepEqual(keysOf(prompts.find((p) => p.opts.label === 'judge#2').opts), ['t2', 't3'])
  assert.match(promptFor(prompts, 'judge#2'), /A CONTINUATION/)
  assert.deepEqual(keysOf(prompts.find((p) => p.opts.label === 'judge#3').opts), ['t2'])
  assert.ok(!labelsOf(prompts).includes('judge#4'), 'a pass that rules on nothing ends the charge')
  assert.deepEqual(flagValues(commandFor(prompts, 'record'), 'from'),
    ['judge', 'judge#2', 'judge#3'].map((l) => returnFileOf(promptFor(prompts, l))), 'every pass\'s file is recorded')

  assert.deepEqual(result.coverage.dropped, ['t2'])
  assert.equal(result.coverage.complete, false)
})

test('the judge is told which anchor each kind of claim needs, and the file shape offers exactly the kinds the store takes', async () => {
  const { prompts } = await run({ plan: PLAN(), 'scout:': HITS() })
  const judge = promptFor(prompts, 'judge')
  assert.ok(judge.includes('"kind": "' + ITEM_KINDS.join('|') + '"'))
  for (const kind of ITEM_KINDS) assert.match(judge, new RegExp('\\b' + kind + ':'))
  assert.doesNotMatch(judge, /"at"|"result"|"retrieved"/, 'what the recorder observes is never asked of the judge')
})

test('the recorded items are the result\'s, as handles, and the context file is named', async () => {
  const { result, prompts } = await run({ plan: PLAN(), 'scout:': HITS() })

  const rec = prompts.find((p) => p.opts.label === 'record')
  assert.equal(rec.opts.model, 'haiku', 'carrying a command is not judgment')
  assert.match(courierCommand(rec.prompt), /^node "C:\/plugin\/lib\/evidence\.mjs" record --repo "\." --root "\." --kind survey --plan "/)
  assert.deepEqual(flagValues(commandFor(prompts, 'context'), 'return'), ['20260926-120000-survey'])

  assert.deepEqual(result.items, [{ id: idOf('a'), topic: 'a', kind: 'behaviour', state: 'standing' }])
  assert.equal(result.context, contextPath('survey'))
  assert.deepEqual(result.unrecorded, [])
  assert.equal(result.coverage.complete, true)
})

test('a survey run from a linked worktree records spans read in the worktree', async () => {
  const { prompts } = await run({ plan: PLAN(), 'scout:': HITS() }, { roots: 'C:/wt/e1-a' })
  assert.match(commandFor(prompts, 'record'), /record --repo "C:\/wt\/e1-a" --root "C:\/wt\/e1-a" --kind survey /)
  assert.match(returnFileOf(promptFor(prompts, 'judge')), /^C:\/wt\/e1-a\/\.agentics\/\.state\/evidence\/inbox\//)
})

/** A record courier that refuses its first call, naming the refusals file, and leaves the rest to `then`. */
function refuseOnce() {
  return () => carriedEnvelope({ ok: false, refused: [{ topic: 'a', n: 1 }], refused_n: 1, refusals_file: contextPath('refused') })
}

test('an item refused for its anchors goes back to its judge, who reads the refusals file and writes a correction', async () => {
  const lib = store()
  const { result, prompts } = await run({
    plan: PLAN(), 'scout:': HITS(), record: refuseOnce(), 'record:anchors:1': lib.record, 'judge:anchors:1': { written_n: 1 },
  })

  const reask = promptFor(prompts, 'judge:anchors:1')
  assert.ok(reask.includes(contextPath('refused')), 'the refused items are read from the file lib wrote')
  const fix = returnFileOf(reask)
  assert.match(fix, /judge-anchors-1-[0-9a-f]{8}\.json$/)
  const again = commandFor(prompts, 'record:anchors:1')
  assert.deepEqual(flagValues(again, 'from'), [returnFileOf(promptFor(prompts, 'judge'))])
  assert.deepEqual(flagValues(again, 'fix'), [fix])
  assert.equal(result.coverage.complete, true)
})

test('an item its judge cannot anchor is dropped from the result and leaves its topic incomplete', async () => {
  const refuse = refuseOnce()
  const { result, prompts } = await run({
    plan: PLAN(), 'scout:': HITS(), record: refuse, 'record:anchors:1': refuse, 'judge:anchors:1': { written_n: 1 },
  })

  assert.ok(!labelsOf(prompts).includes('judge:anchors:2'), 'a pass that anchors nothing more ends the loop')
  assert.deepEqual(result.items, [])
  assert.deepEqual(result.coverage.dropped, [])
  assert.deepEqual(result.coverage.incomplete, ['a'])
  assert.deepEqual(result.unrecorded, ['a'])
  assert.ok(result.coverage.unreached.some((u) => u.startsWith('a: 1 item(s) refused') && u.includes(contextPath('refused'))))
  assert.equal(result.coverage.complete, false)
})

test('items the store could not be reached to record keep their topic incomplete', async () => {
  const failed = { stop_reason: 'failed', payload_raw: '', notes: 'node is not on the PATH' }
  const { result } = await run({ plan: PLAN(), 'scout:': HITS(), record: failed, 'record#2': failed })

  assert.deepEqual(result.unrecorded, ['a'])
  assert.deepEqual(result.coverage.incomplete, ['a'])
  assert.match(result.coverage.unreached.join(' '), /a: 1 item\(s\) not recorded \(.*node is not on the PATH/)
  assert.equal(result.coverage.complete, false)
})

test('a topic ruled only by a risk is not dropped, buys no record, and its risk reaches the context file', async () => {
  const { result, prompts } = await run({ plan: PLAN(), 'scout:': HITS(), judge: { topics: [ruling('a', 0, 1)] } })
  assert.deepEqual(result.coverage.dropped, [])
  assert.deepEqual(result.risks, [{ topic: 'a', n: 1 }])
  assert.ok(!labelsOf(prompts).some((l) => /^record/.test(l)), 'nothing to record buys no courier')
  assert.deepEqual(flagValues(commandFor(prompts, 'context'), 'from'), [returnFileOf(promptFor(prompts, 'judge'))])
})

test('a context file that cannot be written leaves the reader item-less, and says so', async () => {
  const failed = { stop_reason: 'failed', payload_raw: '', notes: 'node is not on the PATH' }
  const { result } = await run({ plan: PLAN(), 'scout:': HITS(), context: failed, 'context#2': failed })
  assert.equal(result.context, '')
  assert.ok(result.coverage.failed_channels.includes('context'))
  assert.equal(result.coverage.complete, false)
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
// model's call — the pool's states come from lib/evidence.mjs, as handles, with what the items say
// in a file lib wrote.

const poolId = (n) => 'I' + String(n).padStart(8, '0')
const POOL_ITEM = (n, over = {}) => ({ id: poolId(n), state: 'standing', topic: 'loader', kind: 'behaviour', seq: n, ground: ['src/boot'], ...over })
const SUSPECT = { state: 'suspect' }
const STALE = { state: 'stale' }
const POOL_FILE = contextPath('pool')
const POOL = (items, context = POOL_FILE) => carriedEnvelope({ items, context })
const GROUND = { ground: ['src/boot/load.js', 'src/boot'] }
const JUDGED = carriedEnvelope({ read: true, recorded_n: 1, standing_n: 1, failed_n: 0 })
const failedCourier = { stop_reason: 'failed', payload_raw: '', notes: 'node is not on the PATH' }

test('standing items whose ground overlaps reach the planner and the judge as known ground, and are returned', async () => {
  const pool = [POOL_ITEM(1)]
  const { result, prompts } = await run({ reuse: POOL(pool), plan: PLAN(), 'scout:': HITS() }, GROUND, () => pool)

  assert.match(commandFor(prompts, 'reuse'),
    /^node "C:\/plugin\/lib\/evidence\.mjs" items --repo "\." --root "\." --ground "src\/boot\/load\.js,src\/boot" --states standing,suspect,stale --return-kind survey$/)
  assert.ok(labelsOf(prompts).indexOf('reuse') < labelsOf(prompts).indexOf('plan'), 'the pool is read before anything is planned')
  assert.match(promptFor(prompts, 'plan'), /ESTABLISHED[\s\S]*under STANDING in C:\/repo\/\.agentics\/\.state\/context\/pool-1\.md/)
  assert.ok(promptFor(prompts, 'judge').includes('the items under STANDING in ' + POOL_FILE))
  assert.match(commandFor(prompts, 'context'), /--ground "src\/boot\/load\.js,src\/boot" --return-kind survey/)

  assert.deepEqual(result.reused, [poolId(1)])
  assert.deepEqual(result.items.map((i) => i.id), [poolId(1), idOf('a')], 'reused first, then new in plan order')
  assert.ok(!labelsOf(prompts).some((l) => /^rejudge/.test(l)), 'nothing standing is re-judged')
})

test('a pool the planner finds complete buys no search, and says so', async () => {
  const pool = [POOL_ITEM(1)]
  const { result, prompts, logs } = await run({ reuse: POOL(pool), plan: PLAN({ topics: [] }) }, GROUND, () => pool)
  assert.deepEqual(labelsOf(prompts), ['reuse', 'plan', 'context'])
  assert.deepEqual(result.items.map((i) => i.id), [poolId(1)])
  assert.equal(result.context, contextPath('survey'))
  assert.equal(result.coverage.complete, true)
  assert.ok(logs.some((l) => /nothing left to search/.test(l)))
})

test('suspect items are re-judged in batches of twenty on the cheapest tier, from the pool file, by id', async () => {
  const pool = Array.from({ length: 25 }, (_, i) => POOL_ITEM(i + 1, SUSPECT))
  const { prompts } = await run({
    reuse: POOL(pool), 'rejudge:': { written_n: 20 }, 'record-judgements:': JUDGED,
    'reuse-after': POOL(pool.map((it) => ({ ...it, state: 'standing' }))), plan: PLAN({ topics: [] }),
  }, { ...GROUND, intelligence: 'max' })

  const rejudges = prompts.filter((p) => /^rejudge:/.test(p.opts.label))
  assert.deepEqual(rejudges.map((p) => p.opts.label), ['rejudge:1', 'rejudge:2'])
  const idsIn = (prompt) => [...prompt.matchAll(/I[0-9a-f]{8}/g)].map((m) => m[0])
  assert.deepEqual(rejudges.map((p) => idsIn(p.prompt).length), [20, 5])
  for (const p of rejudges) {
    assert.equal(p.opts.model, 'haiku', 'the re-judge is the stated exception to the dial')
    assert.ok(p.prompt.includes(POOL_FILE), 'the old and the new text are read from the pool file')
  }

  const recorded = prompts.filter((p) => /^record-judgements:/.test(p.opts.label))
  assert.deepEqual(recorded.map((p) => p.opts.label), ['record-judgements:1', 'record-judgements:2'])
  const first = courierCommand(recorded[0].prompt)
  assert.match(first, /^node "C:\/plugin\/lib\/evidence\.mjs" judge --repo "\." --root "\." --from "/)
  assert.deepEqual(flagValues(first, 'from'), [returnFileOf(rejudges[0].prompt)])
  assert.deepEqual(flagValues(first, 'id'), pool.slice(0, 20).map((it) => it.id))
  assert.ok(labelsOf(prompts).indexOf('reuse-after') > labelsOf(prompts).indexOf('record-judgements:2'))
})

test('a re-judge that died still has its batch recorded, which lib reads as unsure', async () => {
  const pool = [POOL_ITEM(1, SUSPECT)]
  const { prompts } = await run({
    reuse: POOL(pool), 'rejudge:': () => { throw new Error('overloaded') }, 'record-judgements:': JUDGED,
    'reuse-after': POOL([{ ...pool[0], state: 'stale' }]), plan: PLAN({ topics: [] }), 'scout:': HITS(),
  }, GROUND)
  assert.deepEqual(flagValues(commandFor(prompts, 'record-judgements:1'), 'id'), [poolId(1)])
})

test('holds keeps an item as known ground; fails sends its topic to a narrowed re-survey', async () => {
  const kept = POOL_ITEM(1)
  const held = POOL_ITEM(2, { topic: 'config', ...SUSPECT })
  const broke = POOL_ITEM(3, { topic: 'cache', ground: ['src/cache'], ...SUSPECT })
  const after = [kept, { ...held, state: 'standing' }, { ...broke, state: 'stale' }]
  const { result, prompts } = await run({
    reuse: POOL([kept, held, broke]), 'rejudge:': { written_n: 2 }, 'record-judgements:': JUDGED,
    'reuse-after': POOL(after, contextPath('pool-after')), plan: PLAN({ topics: [] }), 'scout:': HITS(),
  }, GROUND, () => after)

  assert.match(promptFor(prompts, 'plan'), /RE-SURVEYED[\s\S]*cache/)
  assert.deepEqual(labelsOf(prompts).filter((l) => /^scout:/.test(l)), ['scout:cache'], 'only the stale topic is bought again')
  assert.ok(promptFor(prompts, 'scout:cache').includes(`recorded claims of topic "cache" said about src/cache. They are listed under that topic in ${contextPath('pool-after')}`))
  assert.deepEqual(flagValues(commandFor(prompts, 'record'), 'subtree'), ['src/cache'])

  assert.deepEqual(result.topics, ['cache'])
  assert.deepEqual([...result.reused].sort(), [kept.id, held.id].sort())
  assert.ok(!result.items.some((i) => i.id === broke.id), 'a stale item is replaced, never returned')
  assert.equal(result.coverage.complete, true)
})

test('an item still suspect after the re-judge is re-surveyed, never reused', async () => {
  const a = POOL_ITEM(1, SUSPECT)
  const { result, prompts } = await run({
    reuse: POOL([a]), 'rejudge:': { written_n: 1 }, 'record-judgements:': JUDGED, 'reuse-after': POOL([a]),
    plan: PLAN({ topics: [] }), 'scout:': HITS(),
  }, GROUND)
  assert.deepEqual(result.reused, [])
  assert.ok(labelsOf(prompts).includes('scout:loader'))
})

test('a pool that cannot be read again after the re-judge counts every re-judged item as stale', async () => {
  const kept = POOL_ITEM(1)
  const a = POOL_ITEM(2, { topic: 'config', ...SUSPECT })
  const { result, prompts } = await run({
    reuse: POOL([kept, a]), 'rejudge:': { written_n: 1 }, 'record-judgements:': JUDGED,
    'reuse-after': failedCourier, 'reuse-after#2': failedCourier, plan: PLAN({ topics: [] }), 'scout:': HITS(),
  }, GROUND, () => [kept])
  assert.deepEqual(result.reused, [kept.id])
  assert.ok(labelsOf(prompts).includes('scout:config'))
})

test('stale items in the pool send their topics to the re-survey without a re-judge', async () => {
  const { result, prompts } = await run({ reuse: POOL([POOL_ITEM(1, STALE)]), plan: PLAN({ topics: [] }), 'scout:': HITS() }, GROUND)
  assert.ok(!labelsOf(prompts).some((l) => /^rejudge|^reuse-after/.test(l)))
  assert.deepEqual(result.topics, ['loader'])
})

// A narrowed re-survey's new items get new ids, so the stale item they replaced stays in the pool.
// The newer item of its topic, by seq, is what says it was replaced (spec §4.9).
test('a second survey over the same ground, after a narrowed re-survey replaced a stale topic, dispatches no scout for that topic', async () => {
  const broke = POOL_ITEM(3, { topic: 'cache', ground: ['src/cache'], ...STALE })
  const replaced = POOL_ITEM(7, { topic: 'cache', ground: ['src/cache'] })
  const pool = [POOL_ITEM(1), broke, replaced]
  const { result, prompts } = await run({ reuse: POOL(pool), plan: PLAN({ topics: [] }), 'scout:': HITS() }, GROUND, () => pool)
  assert.ok(!labelsOf(prompts).some((l) => /^scout:/.test(l)), 'nothing is bought again')
  assert.doesNotMatch(promptFor(prompts, 'plan'), /RE-SURVEYED/)
  assert.deepEqual([...result.reused].sort(), [poolId(1), poolId(7)])
  assert.equal(result.coverage.complete, true)
})

test('an older standing item of a topic, or one on other ground, never hides a stale one', async () => {
  const older = POOL_ITEM(2, { topic: 'cache', ground: ['src/cache'] })
  const broke = POOL_ITEM(5, { topic: 'cache', ground: ['src/cache'], ...STALE })
  const elsewhere = POOL_ITEM(9, { topic: 'cache', ground: ['src/other'] })
  const { result, prompts } = await run({ reuse: POOL([older, broke, elsewhere]), plan: PLAN({ topics: [] }), 'scout:': HITS() }, GROUND)
  assert.ok(labelsOf(prompts).includes('scout:cache'))
  assert.deepEqual(result.topics, ['cache'])
})

test('no reuse without ground to overlap, nor over ground a command cannot carry', async () => {
  for (const over of [{}, { ground: [] }, { ground: ['src"; rm -rf ~; echo "'] }, { ground: ['src/$HOME'] }]) {
    const { prompts } = await run({ plan: PLAN(), 'scout:': HITS() }, over)
    assert.ok(!labelsOf(prompts).includes('reuse'), JSON.stringify(over))
  }
  const { prompts } = await run({ reuse: POOL([]), plan: PLAN(), 'scout:': HITS() }, { ground: ['docs/my notes'] })
  assert.match(commandFor(prompts, 'reuse'), /--ground "docs\/my notes"/, 'a path with a space is a handle')
})

test('a pool that cannot be read costs a full survey, never a skipped one', async () => {
  const unreadable = { reuse: failedCourier, 'reuse#2': failedCourier }
  const malformed = { reuse: carriedEnvelope({ items: 'not a list', context: '' }) }
  for (const pool of [unreadable, malformed]) {
    const { result, prompts } = await run({ ...pool, plan: PLAN(), 'scout:': HITS() }, GROUND)
    assert.ok(labelsOf(prompts).includes('scout:a'))
    assert.deepEqual(result.reused, [])
    assert.equal(result.coverage.complete, true)
  }
})

test('the caller\'s ground travels in the resume args', async () => {
  const { result } = await run({ plan: PLAN(), 'scout:': HITS() }, GROUND)
  assert.deepEqual(result.coverage.resumable.args.ground, GROUND.ground)
})

test('a judge holding many topics writes to a return file that fits on Windows', async () => {
  const root = 'C:/Users/firstname.lastname/source/repos/project-name'
  const topics = Array.from({ length: 12 }, (_, i) => ({ key: 'entity-action-queue-topic-' + i, subtree: 'src/t' + i }))
  const hits = (prompt, opts) => HITS({ hits: Array.from({ length: 11 }, (_, i) => ({ path: opts.label + '.js', line: i + 1 })) })
  const { prompts } = await run({ plan: PLAN({ topics }), 'scout:': hits }, { roots: root })
  const judges = prompts.filter((p) => /^judge:entity/.test(p.opts.label))
  assert.ok(judges.length > 1 && judges.every((p) => p.opts.label.length > 40), 'judges are named by the topics they hold')
  for (const p of judges) {
    assert.ok(returnFileOf(p.prompt).startsWith(root + '/.agentics/.state/evidence/inbox/' +
      nameKey(p.opts.label.replace(/[^A-Za-z0-9.-]+/g, '-')) + '-'), p.opts.label)
  }
  for (const p of prompts.filter((x) => returnFileOf(x.prompt))) assert.deepEqual(overruns(returnFileOf(p.prompt)), [], p.opts.label)
})
