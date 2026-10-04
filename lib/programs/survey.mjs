// lib/programs/survey.mjs — the survey program: plans a question into topics, scouts each topic and
// the common ground beside the history and docs channels, deals the judges their excerpts, records
// their items and writes the one context file. It never concludes.
//
// Design: docs/DESIGN.md#survey.

import { guidanceOf } from '../brief.mjs'
import { channelBrief, commonBrief, judgeBrief, planBrief, scoutBrief } from '../briefs/survey.mjs'
import { excerptsText } from '../citations.mjs'
import { recordSurvey, surveyContext } from '../evidence.mjs'
import { fnv1a } from '../plan-digest.mjs'
import { readConfig, returnPath } from '../store.mjs'
import { coverageOf, deliver, dispatch, searchRounds, step } from './common.mjs'

export const ARGS = {
  question_file: { kind: 'file', required: true, as: 'question' },
  roots: { kind: 'list', default: ['.'] },
  notes: { kind: 'text' },
  prior: { kind: 'text' },
  max_topics: { kind: 'int', default: 8 },
  intelligence: { kind: 'enum', values: ['low', 'normal', 'max'], default: 'normal' },
  pace: { kind: 'enum', values: ['frugal', 'balanced', 'fast'], default: 'balanced' },
  ground: { kind: 'list', default: [] },
}

/** Pure. What a second survey may not run over while this one is live. */
export const scopeOf = (args) => ({ question: fnv1a(args.question), roots: args.roots, ground: args.ground })

const LOCATIONS_PER_JUDGE = 60
const NOTHING_ASKED = 'no question was asked, so nothing was searched'
const NO_TOPICS = 'planning produced no topics, so nothing was searched'

const text = (v) => (typeof v === 'string' ? v.trim() : '')
const listOf = (v) => (Array.isArray(v) ? v : [])
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const slug = (s) => text(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'topic'

/** Pure. The plan's topics, each keyed by its slug, a repeated key numbered from -2. */
function topicsOf(planned) {
  const taken = new Set()
  return listOf(planned).filter(isObject).map((t) => {
    const base = slug(t.key)
    let key = base
    for (let n = 2; taken.has(key); n++) key = base + '-' + n
    taken.add(key)
    return { key, find: text(t.find), subtree: text(t.subtree), forced: false }
  })
}

/**
 * Pure. The topics dealt to judges: one each at pace fast; otherwise one judge per 60 locations,
 * topics taken heaviest first onto the lightest judge (the one holding fewer topics on a tie), each
 * judge's topics in plan order and the judges in the plan order of their first topic.
 */
function deal(topics, weightOf, commonWeight, pace) {
  if (pace === 'fast') return topics.map((t) => [t])
  const total = topics.reduce((n, t) => n + weightOf(t), commonWeight)
  const loads = Array.from({ length: Math.min(topics.length, Math.max(1, Math.ceil(total / LOCATIONS_PER_JUDGE))) }, () => ({ weight: 0, topics: [] }))
  for (const t of [...topics].sort((a, b) => weightOf(b) - weightOf(a))) {
    const lightest = loads.reduce((a, b) => (b.weight < a.weight || (b.weight === a.weight && b.topics.length < a.topics.length) ? b : a))
    lightest.weight += weightOf(t)
    lightest.topics.push(t)
  }
  const at = (t) => topics.indexOf(t)
  return loads.map((l) => l.topics.sort((a, b) => at(a) - at(b))).sort((a, b) => at(a[0]) - at(b[0]))
}

/** Pure. A search's end as a judge's brief names it. */
const endOf = (s) => ({ outcome: s.outcome, why: s.why, cause: s.cause, rounds: s.rounds.length })

/** Pure. A searcher's stop as it stated it, under `label`; nothing when it returned no round. */
function declaredOf(label, s) {
  if (!s || s.rounds.length === 0) return []
  const last = s.rounds[s.rounds.length - 1].output
  return [label + ': ' + (text(last.stop_reason) || 'no stop reason') + (text(last.not_reached) ? ', not reached: ' + text(last.not_reached) : '') +
    (s.outcome === 'stop' ? ' (ended short: ' + s.why + ')' : '')]
}

/**
 * One judge: its items recorded, the refused ones delivered back to its own session while each
 * pass refuses fewer than the one before. A pass that refuses no fewer leaves its items unrecorded.
 * `outputs` are its returns in order: the first, then each corrected answer.
 */
async function judge(ctx, { n, question, group, brief, intelligence }) {
  const spec = { role: 'analyst', schema: 'items', thread: 'judge:' + n, threadBrief: brief, intelligence, base: 'high' }
  const first = await dispatch(ctx, { ...spec, brief })
  if (first.status !== 'returned') return { n, group, failed: first.cause, outputs: [], recorded: '' }
  const topics = group.map(({ key, subtree }) => ({ key, subtree }))
  const fix = []
  const end = (over) => ({ n, group, dispatch: first.dispatch, outputs: [first.output, ...fix], recorded: '', unrecorded: false, ...over })
  let before = Infinity
  for (let pass = 0; ; pass++) {
    const out = await step(ctx, 'record:' + n + ':' + pass, () =>
      recordSurvey(ctx.repo, { question, topics, from: [first.output], fix }, { root: ctx.root, now: new Date(ctx.now()) }))
    if (out.ok) return end({ recorded: out.return })
    const refusals = listOf(out.refusals)
    if (refusals.length === 0 || refusals.length >= before) return end({ unrecorded: true })
    before = refusals.length
    const answer = await deliver(ctx, {
      ...spec, msg: 'refusals', round: pass + 2,
      payload: { refusals: refusals.map((r) => ({ claim: r.claim, problem: r.problems.join('; ') })) },
    })
    if (answer.status !== 'returned') return end({ unrecorded: true })
    fix.push(answer.output)
  }
}

export async function survey(ctx, args) {
  const question = text(args.question)
  const { roots = ['.'], notes = '', prior = '', max_topics: maxTopics = 8, intelligence = 'normal', pace = 'balanced', ground = [] } = args
  const resumable = ctx.resumable
  if (!question) return resultOf({ question, ground, lists: { unreached: [NOTHING_ASKED] }, resumable })
  const guidance = guidanceOf(ctx.root, { dirs: roots, config: readConfig(ctx.repo) })

  const plan = await dispatch(ctx, {
    role: 'analyst', schema: 'survey_plan', thread: 'plan', intelligence, base: 'medium',
    brief: planBrief({ question, roots, notes, prior, maxTopics, guidance }),
  })
  if (plan.status !== 'returned') {
    return resultOf({ question, ground, lists: { failed_channels: ['plan'], unreached: ['planning failed (' + plan.cause + '), so nothing was searched'] }, resumable })
  }
  const topics = topicsOf(plan.output.topics)
  if (topics.length === 0) return resultOf({ question, ground, lists: { unreached: [NO_TOPICS] }, resumable })
  const common = text(plan.output.common_ground)

  const channel = (thread, role, schema, ask) => (ask
    ? searchRounds(ctx, { role, schema, thread, brief: channelBrief({ channel: thread, question, ask, roots, guidance }) })
    : Promise.resolve(null))
  const channels = Promise.all([
    channel('history', 'historian', 'historian', text(plan.output.history_question)),
    channel('docs', 'doc-researcher', 'doc_research', text(plan.output.docs_question)),
  ])
  channels.catch(() => {}) // awaited once the judges are done, where a rejection surfaces

  const scout = { role: 'scout', schema: 'scout_hits' }
  const [scouts, commonRun] = await Promise.all([
    Promise.all(topics.map((topic) => searchRounds(ctx, { ...scout, thread: 'scout:' + topic.key, brief: scoutBrief({ question, topic, common, roots, guidance }) }))),
    common ? searchRounds(ctx, { ...scout, thread: 'common', brief: commonBrief({ question, common, roots, guidance }) }) : null,
  ])
  const scouted = new Map(topics.map((t, i) => [t.key, scouts[i]]))
  const weight = (s) => (s && s.rounds.length > 0 ? s.entries_n : 0)
  const reportsOf = (label, s) => s.rounds.map((r, i) => ({ label: label + (i > 0 ? '#' + (i + 1) : ''), output: r.output }))

  const judged = await Promise.all(deal(topics, (t) => weight(scouted.get(t.key)), weight(commonRun), pace).map((group, i) => judge(ctx, {
    n: i + 1, question, group, intelligence,
    brief: judgeBrief({
      question, guidance,
      topics: group.map((t) => ({ ...t, search: endOf(scouted.get(t.key)) })),
      common: commonRun ? endOf(commonRun) : null,
      excerpts: excerptsText(ctx.root, group.flatMap((t) => reportsOf('scout:' + t.key, scouted.get(t.key)))
        .concat(commonRun ? reportsOf('common', commonRun) : [])).text,
    }),
  })))
  const [history, docs] = await channels

  const stored = (s) => (s ? s.rounds.map((r) => returnPath(ctx.dir, r.dispatch)) : [])
  const written = await step(ctx, 'context', () => {
    const { text: _, ...out } = surveyContext(ctx.repo, {
      ground: [], return_kind: '', returns: judged.map((j) => j.recorded).filter(Boolean),
      from: judged.filter((j) => j.outputs.length > 0).map((j) => returnPath(ctx.dir, j.dispatch)),
      history: stored(history), docs: stored(docs),
    }, { root: ctx.root })
    return out
  })

  // What each judge gave each of its topics in its first return (a judge holding one topic gave it
  // everything it wrote), and how its latest return to rule a topic's unit ruled it.
  const given = new Map(topics.map((t) => [t.key, { items: 0, risks: 0, open: true, judge: null }]))
  for (const j of judged) {
    for (const t of j.group) given.get(t.key).judge = j
    if (j.outputs.length === 0) continue
    const topicOf = (x) => (j.group.length === 1 ? j.group[0].key : text(x.topic))
    for (const it of listOf(j.outputs[0].items).filter(isObject)) if (given.has(topicOf(it))) given.get(topicOf(it)).items++
    for (const r of listOf(j.outputs[0].risks).filter(isObject)) if (given.has(topicOf(r))) given.get(topicOf(r)).risks++
    for (const u of j.outputs.flatMap((o) => listOf(o.units)).filter(isObject)) {
      if (j.group.some((t) => t.key === u.unit)) given.get(u.unit).open = u.ruling !== 'anchored'
    }
  }
  const dropped = topics.filter((t) => given.get(t.key).items + given.get(t.key).risks === 0).map((t) => t.key)
  const unrecorded = topics.filter((t) => given.get(t.key).items > 0 && given.get(t.key).judge.unrecorded).map((t) => t.key)
  const short = (s) => s && s.outcome !== 'done'
  const incomplete = [...new Set([
    ...topics.filter((t) => !dropped.includes(t.key) &&
      (short(scouted.get(t.key)) || unrecorded.includes(t.key) || (given.get(t.key).items > 0 && given.get(t.key).open))).map((t) => t.key),
    ...(short(commonRun) ? ['common'] : []),
    ...[['history', history], ['docs', docs]].filter(([, s]) => s && s.outcome === 'stop').map(([name]) => name),
  ])]
  const failed = (label, s) => (s && s.outcome === 'failed' ? [label + ': failed (' + s.cause + ')'] : [])
  const lists = {
    declared: [
      ...topics.flatMap((t) => declaredOf('topic ' + t.key, scouted.get(t.key))),
      ...declaredOf('common ground', commonRun), ...declaredOf('history', history), ...declaredOf('docs', docs),
    ],
    dropped,
    incomplete,
    failed_channels: [['history', history], ['docs', docs]].filter(([, s]) => s && s.outcome === 'failed').map(([name]) => name),
    unreached: [
      ...topics.flatMap((t) => failed('topic ' + t.key + "'s scout", scouted.get(t.key))),
      ...failed('the common ground scout', commonRun),
      ...judged.filter((j) => j.failed).map((j) => 'judge ' + j.n + ' failed (' + j.failed + '), so ' + j.group.map((t) => t.key).join(', ') + ' went unjudged'),
      ...failed('history', history), ...failed('docs', docs),
    ],
  }

  const at = (it) => topics.findIndex((t) => t.key === it.topic)
  const lastStored = (s) => (s && s.rounds.length > 0 ? stored(s)[s.rounds.length - 1] : null)
  return resultOf({
    question, ground, unrecorded, resumable, lists,
    topics: topics.map(({ key, subtree, forced }) => ({ key, subtree, forced })),
    items: [...written.items].sort((a, b) => at(a) - at(b)).map(({ id, topic, kind, state }) => ({ id, topic, kind, state })),
    context: written.context,
    risks: topics.filter((t) => given.get(t.key).risks > 0).map((t) => ({ topic: t.key, n: given.get(t.key).risks })),
    history: lastStored(history),
    docs: lastStored(docs),
  })
}

/** The survey's result and its coverage block: complete only when nothing is lost and every item it returns stands. */
function resultOf({ question, topics = [], ground = [], items = [], reused = [], unrecorded = [], context = '', risks = [], history = null, docs = null, lists = {}, resumable = null }) {
  return {
    question, topics, ground, items, reused, unrecorded, context, risks, history, docs,
    coverage: coverageOf({ ...lists, resumable, also: items.every((it) => it.state === 'standing') }),
  }
}
