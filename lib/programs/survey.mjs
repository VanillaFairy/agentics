// lib/programs/survey.mjs — the survey program: reads what the pool already holds over the caller's
// ground and re-judges what drifted, plans the question into topics, searches each topic over one
// ground table code resolved, and the history and docs channels likewise, deals the judges their excerpts,
// records their items and writes the one context file. It never concludes.
//
// Design: docs/DESIGN.md#survey.

import { guidanceOf } from '../brief.mjs'
import { groundText } from '../briefs/search.mjs'
import { channelFind, judgeBrief, planBrief, rejudgeBrief, topicFind } from '../briefs/survey.mjs'
import { searchExcerpts } from '../citations.mjs'
import { itemsFor, poolText, recordRulings, recordSurvey, supersede, surveyContext } from '../evidence.mjs'
import { fnv1a } from '../plan-digest.mjs'
import { treeOf } from '../search/pin.mjs'
import { posix, readConfig, returnPath } from '../store.mjs'
import { coverageOf, deliver, dispatch, step } from './common.mjs'
import { groundFor, search } from './search/loop.mjs'

export const ARGS = {
  question_file: { kind: 'file', required: true, as: 'question' },
  roots: { kind: 'list', default: ['.'] },
  notes: { kind: 'text' },
  notes_file: { kind: 'file', as: 'notes' },
  prior_file: { kind: 'file', as: 'prior' },
  max_topics: { kind: 'int', default: 8 },
  intelligence: { kind: 'enum', values: ['low', 'normal', 'max'], default: 'normal' },
  pace: { kind: 'enum', values: ['frugal', 'balanced', 'fast'], default: 'balanced' },
  ground: { kind: 'list', default: [] },
}

/** Pure. What a second survey may not run over while this one is live. */
export const scopeOf = (args) => ({ question: fnv1a(args.question), roots: args.roots, ground: args.ground })

const LOCATIONS_PER_JUDGE = 60
const REJUDGE_BATCH = 20
// The stated exception to the dial (docs/DESIGN.md#the-drift-ladder): any doubt routes to a full search.
const REJUDGE_TIER = { model: 'haiku', effort: 'low' }
const NOTHING_ASKED = 'no question was asked, so nothing was searched'
const NO_TOPICS = 'planning produced no topics, so nothing was searched'

const text = (v) => (typeof v === 'string' ? v.trim() : '')
const listOf = (v) => (Array.isArray(v) ? v : [])
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const slug = (s) => text(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'topic'
/** Pure. A ground path as a topic's subtree: '' for the repository as a whole. */
const subtreeOf = (g) => {
  const p = posix(g).trim().replace(/^\.\//, '').replace(/\/+$/, '')
  return p === '.' ? '' : p
}
const handleOf = ({ id, topic, kind, state }) => ({ id, topic, kind, state })

/**
 * What the pool holds over the caller's ground, read once into the run's log so a relaunch sees what
 * this run saw: standing survey items are known, suspect ones are re-judged twenty to a call, and
 * the stale ones — with every re-judged item that does not stand after — are searched again, less
 * each stale item a newer standing item of its topic replaced. `after` is why the read after the
 * re-judge failed ('' when it did not): every suspect item is then searched again. `root` is the
 * tree the items' anchors are read on.
 */
async function reuse(ctx, { ground, guidance, root }) {
  const read = (key) => step(ctx, key, () => {
    try {
      return { items: itemsFor(ctx.repo, { ground, states: ['standing', 'suspect', 'stale'], now: new Date(ctx.now()), root })
        .filter((it) => String(it.from_return || '').endsWith('-survey')) }
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) }
    }
  })
  const first = await read('pool')
  if (first.error) return { known: [], stale: [], unreadable: first.error, after: '' }
  const suspect = first.items.filter((it) => it.state === 'suspect')
  let known = first.items.filter((it) => it.state === 'standing')
  let stale = first.items.filter((it) => it.state === 'stale')
  let lostAfter = ''
  if (suspect.length > 0) {
    const batches = []
    for (let i = 0; i < suspect.length; i += REJUDGE_BATCH) batches.push(suspect.slice(i, i + REJUDGE_BATCH))
    await Promise.all(batches.map(async (batch, i) => {
      const ids = batch.map((it) => it.id)
      const out = await dispatch(ctx, {
        role: 'analyst', schema: 'rejudge', thread: 'rejudge:' + (i + 1), tier: REJUDGE_TIER,
        brief: rejudgeBrief({ ids, pool: poolText(batch), guidance }),
      })
      if (out.status === 'returned') await step(ctx, 'rulings:' + (i + 1), () => recordRulings(ctx.repo, ids, out.output.rulings, { root }))
    }))
    const second = await read('pool:after')
    lostAfter = second.error || ''
    const after = new Map(listOf(second.items).map((it) => [it.id, it]))
    for (const it of suspect) {
      const now = after.get(it.id)
      if (now && now.state === 'standing') known = known.concat([now])
      else stale = stale.concat([{ ...it, state: 'stale' }])
    }
  }
  return { known, stale: supersede([...known, ...stale]).filter((it) => it.state === 'stale'), unreadable: '', after: lostAfter }
}

/** Pure. One topic searched again per stale topic, at its first item's ground, carrying what it used to claim. */
function forcedOf(stale) {
  const byTopic = new Map()
  for (const it of stale) byTopic.set(it.topic, [...(byTopic.get(it.topic) || []), it])
  return [...byTopic].map(([name, used]) => ({ key: slug(name), find: '', subtree: subtreeOf(listOf(used[0].ground)[0] || ''), forced: true, used }))
}

/** Pure. The forced topics, then the plan's, each keyed by its slug; a planned key a forced topic holds is dropped, a repeated one numbered from -2. */
function topicsOf(planned, forced) {
  const forcedKeys = new Set(forced.map((t) => t.key))
  const taken = new Set(forcedKeys)
  const own = []
  for (const t of listOf(planned).filter(isObject)) {
    const base = slug(t.key)
    if (forcedKeys.has(base)) continue
    let key = base
    for (let n = 2; taken.has(key); n++) key = base + '-' + n
    taken.add(key)
    own.push({ key, find: text(t.find), subtree: text(t.subtree), forced: false })
  }
  return [...forced, ...own]
}

/**
 * Pure. The topics dealt to judges: one each at pace fast; otherwise one judge per 60 locations,
 * topics taken heaviest first onto the lightest judge (the one holding fewer topics on a tie), each
 * judge's topics in plan order and the judges in the plan order of their first topic.
 */
function deal(topics, weightOf, pace) {
  if (pace === 'fast') return topics.map((t) => [t])
  const total = topics.reduce((n, t) => n + weightOf(t), 0)
  const loads = Array.from({ length: Math.min(topics.length, Math.max(1, Math.ceil(total / LOCATIONS_PER_JUDGE))) }, () => ({ weight: 0, topics: [] }))
  for (const t of [...topics].sort((a, b) => weightOf(b) - weightOf(a))) {
    const lightest = loads.reduce((a, b) => (b.weight < a.weight || (b.weight === a.weight && b.topics.length < a.topics.length) ? b : a))
    lightest.weight += weightOf(t)
    lightest.topics.push(t)
  }
  const at = (t) => topics.indexOf(t)
  return loads.map((l) => l.topics.sort((a, b) => at(a) - at(b))).sort((a, b) => at(a[0]) - at(b[0]))
}

/** Pure. A topic search's end for `key`, as a judge's brief names it. */
const endOf = (s, key) => ({
  status: s.status, cause: s.cause || '', end: s.status === 'returned' ? s.asks[key].end : '', why: s.status === 'returned' ? s.asks[key].why : '',
})
/** Pure. Whether a search produced nothing: it failed, or every ask paused with no hit. */
const nothingFrom = (s) => s.status === 'failed' || Object.values(s.asks).every((a) => a.end === 'stopped' && a.hits.length === 0)
/** Pure. Whether a search that produced something left an ask short of done. */
const shortOf = (s) => !nothingFrom(s) && Object.values(s.asks).some((a) => a.end !== 'done')
/** Pure. A channel's search as the result names it. */
const channelOf = (s, key) => (s ? { status: s.status, end: s.status === 'returned' ? s.asks[key].end : '', hits: s.status === 'returned' ? s.asks[key].hits.length : 0 } : null)
/** Pure. A search's distinct hit locations: a topic's weight for the deal. */
const locationsOf = (s) => (s && !nothingFrom(s) ? new Set(Object.values(s.asks).flatMap((a) => a.hits.map((h) => h.key + ':' + h.line))).size : 0)

/** The survey's one context file: the standing survey items over `ground` first, then the items `returns` recorded. */
function contextOf(ctx, { ground, root, returns = [], from = [], history = '', docs = '' }) {
  const { text: _, ...out } = surveyContext(ctx.repo, { ground, return_kind: 'survey', returns, from, history, docs }, { root })
  return out
}

/**
 * One judge: its items recorded, the refused ones delivered back to its own session while each
 * pass refuses fewer than the one before. A pass that refuses no fewer leaves its items unrecorded.
 * `outputs` are its returns in order: the first, then each corrected answer.
 */
async function judge(ctx, { n, question, group, brief, intelligence, root }) {
  const spec = { role: 'analyst', schema: 'items', thread: 'judge:' + n, threadBrief: brief, intelligence, base: 'high' }
  const first = await dispatch(ctx, { ...spec, brief })
  if (first.status !== 'returned') return { n, group, failed: first.cause, outputs: [], recorded: '' }
  const topics = group.map(({ key, subtree }) => ({ key, subtree }))
  const fix = []
  const end = (over) => ({ n, group, dispatch: first.dispatch, outputs: [first.output, ...fix], recorded: '', unrecorded: false, ...over })
  let before = Infinity
  for (let pass = 0; ; pass++) {
    const out = await step(ctx, 'record:' + n + ':' + pass, () =>
      recordSurvey(ctx.repo, { question, topics, from: [first.output], fix }, { root, now: new Date(ctx.now()) }))
    if (out.ok) return end({ recorded: out.return })
    const refusals = listOf(out.refusals)
    if (refusals.length === 0 || refusals.length >= before) return end({ unrecorded: true })
    before = refusals.length
    const answer = await deliver(ctx, {
      ...spec, msg: 'refusals', round: pass + 2,
      payload: { of: 'items', refusals: refusals.map((r) => ({ claim: r.claim, problem: r.problems.join('; ') })) },
    })
    if (answer.status !== 'returned') return end({ unrecorded: true })
    fix.push(answer.output)
  }
}

export async function survey(ctx, args) {
  const question = text(args.question)
  const { roots = ['.'], notes = '', prior = '', max_topics: maxTopics = 8, intelligence = 'normal', pace = 'balanced', ground = [] } = args
  const resumable = ctx.resumable
  const tree = args.tree || treeOf(ctx.root)
  if (!question) return resultOf({ question, ground, lists: { unreached: [NOTHING_ASKED] }, resumable })
  const guidance = guidanceOf(ctx.root, { dirs: roots, config: readConfig(ctx.repo) })

  const pool = ground.length > 0 ? await reuse(ctx, { ground, guidance, root: tree.root }) : { known: [], stale: [], unreadable: '', after: '' }
  const usable = pool.unreadable ? [] : ground
  const reused = pool.known.map((it) => it.id)
  const known = pool.known.length > 0 ? poolText(pool.known) : ''
  const poolLost = pool.unreadable ? 'the evidence pool could not be read (' + pool.unreadable + '), so nothing was reused'
    : pool.after ? 'the evidence pool could not be read after the re-judge (' + pool.after + '), so every suspect item was searched again'
      : ''
  const lost = (lists) => (poolLost
    ? { ...lists, failed_channels: ['pool', ...listOf(lists.failed_channels)], unreached: [poolLost, ...listOf(lists.unreached)] }
    : lists)
  /** A survey that searched nothing: the pool's standing items alone, in their context file. */
  const reusedOnly = async (lists) => {
    const written = reused.length > 0 ? await step(ctx, 'context', () => contextOf(ctx, { ground: usable, root: tree.root })) : { items: [], context: '' }
    return resultOf({ question, ground, reused, resumable, lists: lost(lists), items: written.items.map(handleOf), context: written.context })
  }
  const forced = forcedOf(pool.stale)

  const plan = await dispatch(ctx, {
    role: 'analyst', schema: 'survey_plan', thread: 'plan', intelligence, base: 'medium',
    brief: planBrief({ question, roots, notes, prior, maxTopics, known, forced: forced.map((t) => t.key), guidance }),
  })
  if (plan.status !== 'returned') {
    return reusedOnly({ dropped: forced.map((t) => t.key), failed_channels: ['plan'], unreached: ['planning failed (' + plan.cause + '), so nothing was searched'] })
  }
  const topics = topicsOf(plan.output.topics, forced)
  if (topics.length === 0) return reusedOnly(reused.length > 0 ? {} : { unreached: [NO_TOPICS] })
  const common = text(plan.output.common_ground)

  const context = [{ label: 'the question', text: question }, ...(common ? [{ label: 'the common ground', text: common }] : [])]
  const own = (ask) => ({ label: ask.key, text: ask.find, asks: [ask.key] })
  const topicAsk = (topic) => ({ key: topic.key, find: topicFind(topic), scope: topic.subtree ? [topic.subtree] : roots, domain: 'repo' })
  // `ground` is the caller's ground paths (ARGS); the resolved table is `resolved`.
  const resolved = await step(ctx, 'ground', () => groundFor(ctx, tree, {
    material: [...context, ...topics.map((t) => own(topicAsk(t)))], scope: roots, diff: args.diff || null, config: readConfig(ctx.repo),
  }))
  const searchOf = (name, role, schema, asks) => search(ctx, {
    name, role, schema, tree, ground: resolved, material: [...context, own(asks[0])], intelligence, asks,
  })
  const channel = (name, role, schema, domain, asked) => (asked
    ? searchOf(name, role, schema, [{ key: name, find: channelFind({ channel: name, question, ask: asked }), scope: domain === 'web' ? ['.'] : roots, domain }])
    : Promise.resolve(null))
  const channels = Promise.all([
    channel('history', 'historian', 'search_history', 'history', text(plan.output.history_question)),
    channel('docs', 'doc-researcher', 'search_web', 'web', text(plan.output.docs_question)),
  ])
  channels.catch(() => {}) // awaited once the judges are done, where a rejection surfaces
  const scouts = await Promise.all(topics.map((topic) => searchOf('scout:' + topic.key, 'scout', 'search_repo', [topicAsk(topic)])))
  const scouted = new Map(topics.map((t, i) => [t.key, scouts[i]]))
  const table = groundText(resolved)

  const judged = await Promise.all(deal(topics, (t) => locationsOf(scouted.get(t.key)), pace).map((group, i) => judge(ctx, {
    n: i + 1, question, group, intelligence, root: tree.root,
    brief: judgeBrief({
      question, guidance, known, common, ground: table,
      topics: group.map((t) => ({ ...t, search: endOf(scouted.get(t.key), t.key) })),
      excerpts: group.map((t) => searchExcerpts(scouted.get(t.key)).text).join('\n\n'),
    }),
  })))
  const [history, docs] = await channels

  const findings = (s) => (s && !nothingFrom(s) ? searchExcerpts(s).text : '')
  const written = await step(ctx, 'context', () => contextOf(ctx, {
    ground: usable, root: tree.root, returns: judged.map((j) => j.recorded).filter(Boolean),
    from: judged.filter((j) => j.outputs.length > 0).map((j) => returnPath(ctx.dir, j.dispatch)),
    history: findings(history), docs: findings(docs),
  }))

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
  const topicSearches = topics.map((t) => ['topic ' + t.key, scouted.get(t.key)])
  const searches = [...topicSearches, ['history', history], ['docs', docs]].filter(([, s]) => s)
  const spoke = searches.filter(([, s]) => !nothingFrom(s))
  const incomplete = [...new Set([
    ...topics.filter((t) => !dropped.includes(t.key) &&
      (nothingFrom(scouted.get(t.key)) || shortOf(scouted.get(t.key)) || unrecorded.includes(t.key) || (given.get(t.key).items > 0 && given.get(t.key).open))).map((t) => t.key),
    ...[['history', history], ['docs', docs]].filter(([, s]) => s && shortOf(s)).map(([name]) => name),
  ])]
  const lists = lost({
    declared: spoke.flatMap(([, s]) => s.coverage.declared),
    dropped,
    incomplete,
    failed_channels: [
      ...[['history', history], ['docs', docs]].filter(([, s]) => s && nothingFrom(s)).map(([name]) => name),
      ...spoke.flatMap(([, s]) => s.coverage.failed_channels),
    ],
    unreached: [
      ...searches.filter(([, s]) => nothingFrom(s)).map(([label, s]) => label + "'s search produced nothing (" + (s.cause || 'every ask paused') + ')'),
      ...spoke.flatMap(([, s]) => [...s.coverage.incomplete, ...s.coverage.unreached]),
      ...judged.filter((j) => j.failed).map((j) => 'judge ' + j.n + ' failed (' + j.failed + '), so ' + j.group.map((t) => t.key).join(', ') + ' went unjudged'),
    ],
  })

  // Reused items first, in the pool's order, then this run's in plan topic order.
  const rank = (it) => (reused.includes(it.id) ? reused.indexOf(it.id) : reused.length + Math.max(topics.findIndex((t) => t.key === it.topic), 0))
  return resultOf({
    question, ground, reused, unrecorded, resumable, lists,
    topics: topics.map(({ key, subtree, forced: f }) => ({ key, subtree, forced: f })),
    items: [...written.items].sort((a, b) => rank(a) - rank(b)).map(handleOf),
    context: written.context,
    risks: topics.filter((t) => given.get(t.key).risks > 0).map((t) => ({ topic: t.key, n: given.get(t.key).risks })),
    history: channelOf(history, 'history'),
    docs: channelOf(docs, 'docs'),
  })
}

/** The survey's result and its coverage block: complete only when nothing is lost and every item it returns stands. */
function resultOf({ question, topics = [], ground = [], items = [], reused = [], unrecorded = [], context = '', risks = [], history = null, docs = null, lists = {}, resumable = null }) {
  return {
    question, topics, ground, items, reused, unrecorded, context, risks, history, docs,
    coverage: coverageOf({ ...lists, resumable, also: items.every((it) => it.state === 'standing') }),
  }
}
