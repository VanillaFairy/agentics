// test/program-survey-scouts.test.mjs — pins the survey program without reuse: its scope, the plan,
// the topics and their scouts, the history and docs channels, and how judges are dealt.
//
// The scripts, the rig and the surveys the parts share are in test/harness/survey-world.mjs.
//
// Design: docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fnv1a } from '../lib/plan-digest.mjs'
import { scopeOf, survey } from '../lib/programs/survey.mjs'
import { tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { posix, returnPath } from '../lib/store.mjs'
import {
  Q, FILE, TOPIC, plan, hit, scoutOut, channelOut, behaviour, anchoredUnit, judgeOut, ARGS, CLAIM,
  basicScript, COMMON, HQ, DQ, fullScript, rigFor, runSurvey, on, pool, roleOf, cov,
} from './harness/survey-world.mjs'

const hitsIn = (path, n, from = 1) => Array.from({ length: n }, (_, i) => hit(path, from + i))

const emptyJudges = (n = 4) => Object.fromEntries(Array.from({ length: n }, (_, i) => ['analyst||judge:' + (i + 1), [{ output: judgeOut() }]]))

const judgeCalls = (rig) => rig.calls.filter((c) => /^judge:\d+$/.test(c.thread.key))
const judgeThreads = (rig) => [...new Set(judgeCalls(rig).map((c) => c.thread.key))].sort()

const lineStarting = (result, prefix) => cov(result).declared.filter((l) => String(l).startsWith(prefix))

// --- arguments and scope ----------------------------------------------------------------------

test("the survey's scope is its question, roots and ground", () => {
  const where = { repo: '/r', root: '/r' }
  const base = ARGS({ ground: ['src/loader'] })
  const scope = scopeOf(base, where)
  assert.equal(scope.question, fnv1a(Q))
  for (const [key, value] of [['notes', 'other notes'], ['prior', 'other prior'], ['max_topics', 3], ['intelligence', 'max'], ['pace', 'fast']]) {
    assert.deepEqual(scopeOf({ ...base, [key]: value }, where), scope, key + ' must not change the scope')
  }
  for (const [key, value] of [['question', 'Another question?'], ['roots', ['lib']], ['ground', ['src/store']]]) {
    assert.notDeepEqual(scopeOf({ ...base, [key]: value }, where), scope, key + ' must change the scope')
  }
})

// --- the plan ---------------------------------------------------------------------------------

test('an empty question returns at once, unreached, with no dispatch', async (t) => {
  const rig = rigFor(t, basicScript())
  for (const question of ['', '   ']) {
    const result = await survey(rig.ctx, ARGS({ question }))
    assert.equal(rig.calls.length, 0, JSON.stringify(question))
    assert.equal(cov(result).unreached.length, 1)
    assert.deepEqual(result.items, [])
    assert.equal(cov(result).complete, false)
  }
})

test("the plan is the analyst's at the dial, base medium", async (t) => {
  for (const intelligence of ['low', 'normal', 'max']) {
    const { rig } = await runSurvey(t, basicScript(), { intelligence })
    const calls = on(rig, 'plan')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].role.name, 'analyst')
    assert.deepEqual(calls[0].schema, schemaOf('survey_plan'))
    assert.deepEqual(calls[0].tier, tierFor(roleOf('analyst'), { intelligence, base: 'medium' }), intelligence)
  }
})

test('the plan brief holds the question, the roots, the notes and max_topics', async (t) => {
  const notes = 'NOTES-5c1d prefer the newer loader'
  const { rig } = await runSurvey(t, basicScript(), { roots: ['src/loader', 'src/store'], notes, max_topics: 37 })
  const brief = on(rig, 'plan')[0].brief
  for (const part of [Q, 'src/loader', 'src/store', notes]) assert.ok(brief.includes(part), part)
  assert.match(brief, /(?<!\d)37(?!\d)/)
})

test('prior reaches the planner and no one else', async (t) => {
  const prior = 'PRIOR-9e2b the loader was rewritten last spring'
  const { rig } = await runSurvey(t, fullScript(), { prior })
  assert.ok(on(rig, 'plan')[0].brief.includes(prior))
  const others = rig.calls.filter((c) => c.thread.key !== 'plan')
  for (const thread of ['scout:loader', 'scout:store', 'common', 'history', 'docs', 'judge:1']) {
    assert.ok(others.some((c) => c.thread.key === thread), 'no call on ' + thread)
  }
  for (const c of others) {
    assert.ok(!c.brief.includes(prior), c.thread.key + ' brief')
    assert.ok(!c.freshBrief.includes(prior), c.thread.key + ' freshBrief')
  }
})

test('a failed plan ends the survey, naming the plan as failed', async (t) => {
  const { rig, result } = await runSurvey(t, basicScript({ 'analyst||plan': [{ status: 'failed', cause: 'host_error' }] }))
  assert.equal(rig.calls.length, 1)
  assert.deepEqual(cov(result).failed_channels, ['plan'])
  assert.equal(cov(result).unreached.length, 1)
  assert.equal(cov(result).complete, false)
})

// --- topics -----------------------------------------------------------------------------------

test('topic keys are slugged, and a repeated key is numbered', async (t) => {
  const topics = [
    { key: 'Loader Path!', find: 'FIND-1', subtree: 'src/loader' },
    { key: '--Store__X--', find: 'FIND-2', subtree: 'src/store' },
    { key: 'loader path', find: 'FIND-3', subtree: 'src/cache' },
    { key: 'LOADER  path', find: 'FIND-4', subtree: 'src/shared' },
  ]
  const { rig, result } = await runSurvey(t, {
    'analyst||plan': [{ output: plan({ topics }) }],
    'scout||scout:loader-path': [{ output: scoutOut({ hits: [hit(FILE.loader, 2)] }) }],
    'scout||scout:store-x': [{ output: scoutOut({ hits: [hit(FILE.store, 2)] }) }],
    'scout||scout:loader-path-2': [{ output: scoutOut({ hits: [hit(FILE.cache, 2)] }) }],
    'scout||scout:loader-path-3': [{ output: scoutOut({ hits: [hit(FILE.shared, 2)] }) }],
    ...emptyJudges(),
  })
  const expected = [
    { key: 'loader-path', subtree: 'src/loader', forced: false },
    { key: 'store-x', subtree: 'src/store', forced: false },
    { key: 'loader-path-2', subtree: 'src/cache', forced: false },
    { key: 'loader-path-3', subtree: 'src/shared', forced: false },
  ]
  assert.deepEqual(result.topics.map(({ key, subtree, forced }) => ({ key, subtree, forced })), expected)
  for (const { key } of expected) assert.equal(on(rig, 'scout:' + key).length, 1, key)
})

test('every planned topic is scouted, beyond max_topics', async (t) => {
  const { rig, result } = await runSurvey(t, {
    'analyst||plan': [{ output: plan({ topics: [TOPIC.loader, TOPIC.store, TOPIC.cache] }) }],
    'scout||scout:loader': [{ output: scoutOut({ hits: [hit(FILE.loader, 2)] }) }],
    'scout||scout:store': [{ output: scoutOut({ hits: [hit(FILE.store, 2)] }) }],
    'scout||scout:cache': [{ output: scoutOut({ hits: [hit(FILE.cache, 2)] }) }],
    ...emptyJudges(),
  }, { max_topics: 1 })
  for (const key of ['loader', 'store', 'cache']) assert.equal(on(rig, 'scout:' + key).length, 1, key)
  assert.deepEqual(result.topics.map((x) => x.key), ['loader', 'store', 'cache'])
})

test('a plan with no topics searches nothing and says so', async (t) => {
  const { rig, result } = await runSurvey(t, {
    'analyst||plan': [{ output: plan({ topics: [], history_question: HQ }) }],
    'historian||history': [{ output: channelOut({ findings: 'unused' }) }],
  })
  assert.equal(rig.calls.length, 1)
  assert.equal(cov(result).unreached.length, 1)
  assert.equal(cov(result).complete, false)
})

// --- scouts and channels ----------------------------------------------------------------------

test("a scout's brief holds the question and its topic's find and subtree", async (t) => {
  for (const intelligence of ['low', 'max']) {
    const { rig } = await runSurvey(t, fullScript(), { intelligence })
    for (const key of ['loader', 'store']) {
      const calls = on(rig, 'scout:' + key)
      assert.equal(calls.length, 1, key)
      assert.equal(calls[0].role.name, 'scout')
      assert.deepEqual(calls[0].schema, schemaOf('scout_hits'))
      assert.deepEqual(calls[0].tier, tierFor(roleOf('scout'), { intelligence }), intelligence)
      for (const part of [Q, TOPIC[key].find, TOPIC[key].subtree]) assert.ok(calls[0].brief.includes(part), key + ': ' + part)
    }
  }
})

test('common ground is scouted once, and every topic scout is told to leave it alone', async (t) => {
  const { rig } = await runSurvey(t, fullScript())
  const common = on(rig, 'common')
  assert.equal(common.length, 1)
  assert.equal(common[0].role.name, 'scout')
  assert.ok(common[0].brief.includes(COMMON))
  for (const key of ['loader', 'store']) assert.ok(on(rig, 'scout:' + key)[0].brief.includes(COMMON), key)
})

test('no common scout runs when the plan names no common ground', async (t) => {
  const { rig } = await runSurvey(t, fullScript({
    'analyst||plan': [{ output: plan({ topics: [TOPIC.loader, TOPIC.store], history_question: HQ, docs_question: DQ }) }],
  }))
  assert.equal(on(rig, 'common').length, 0)
})

test('an unfinished scout is continued on its own thread', async (t) => {
  const { rig, result } = await runSurvey(t, basicScript({
    'scout||scout:loader': [
      { output: scoutOut({ hits: [hit(FILE.loader, 7)], stop_reason: 'unfinished', not_reached: 'the tests folder' }) },
      { output: scoutOut({ hits: [hit(FILE.loader, 9)], stop_reason: 'exhausted' }) },
    ],
  }))
  const calls = on(rig, 'scout:loader')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].round, 2)
  assert.equal(calls[1].resume, true)
  assert.ok(!cov(result).incomplete.includes('loader'))
})

test('a scout that ends short leaves its topic incomplete, declared as it stated', async (t) => {
  const { result } = await runSurvey(t, basicScript({
    'scout||scout:loader': [{ output: scoutOut({ hits: [hit(FILE.loader, 7)], stop_reason: 'stuck', not_reached: '' }) }],
  }))
  assert.deepEqual(cov(result).incomplete, ['loader'])
  const declared = lineStarting(result, 'topic loader')
  assert.equal(declared.length, 1, JSON.stringify(cov(result).declared))
  assert.ok(declared[0].includes('stuck'))
  assert.ok(declared[0].includes('dead_end'))
  assert.equal(cov(result).complete, false)
})

test('a failed scout leaves its topic incomplete, its failure named, and the topic still judged', async (t) => {
  const { rig, result } = await runSurvey(t, basicScript({
    'scout||scout:loader': [{ status: 'failed', cause: 'host_error' }],
    'analyst||judge:1': [{ output: judgeOut({ risks: [{ topic: 'loader', text: 'nothing was found' }] }) }],
  }))
  assert.ok(cov(result).incomplete.includes('loader'))
  assert.ok(cov(result).unreached.some((l) => l.includes('loader') && l.includes('host_error')), JSON.stringify(cov(result).unreached))
  const judges = judgeCalls(rig)
  assert.equal(judges.length, 1)
  assert.ok(judges[0].brief.includes('loader'))
})

test("declared names each searcher's stop as it stated it", async (t) => {
  const { result } = await runSurvey(t, fullScript({
    'analyst||plan': [{ output: plan({ topics: [TOPIC.loader], common_ground: COMMON, history_question: HQ, docs_question: DQ }) }],
    'scout||scout:loader': [{ output: scoutOut({ hits: [hit(FILE.loader, 7)], not_reached: 'NR-vendor dir' }) }],
    'scout||common': [{ output: scoutOut({ hits: [hit(FILE.shared, 3)], not_reached: 'NR-common tests' }) }],
    'historian||history': [
      { output: channelOut({ findings: 'h1', stop_reason: 'unfinished', not_reached: 'NR-old tags' }) },
      { output: channelOut({ findings: 'h2', stop_reason: 'unfinished', not_reached: 'NR-old tags' }) },
    ],
    'doc-researcher||docs': [{ output: channelOut({ findings: 'd1', not_reached: 'NR-v1 docs' }) }],
    'analyst||judge:1': [{ output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader')] }) }],
  }))
  const expect = [
    'topic loader: exhausted, not reached: NR-vendor dir',
    'common ground: exhausted, not reached: NR-common tests',
    'history: unfinished, not reached: NR-old tags (ended short: no_progress)',
    'docs: exhausted, not reached: NR-v1 docs',
  ]
  assert.deepEqual([...cov(result).declared].sort(), [...expect].sort())
})

test('a history question runs the historian with it, and a docs question the doc-researcher', async (t) => {
  const { rig } = await runSurvey(t, fullScript())
  const history = on(rig, 'history')
  assert.equal(history.length, 1)
  assert.equal(history[0].role.name, 'historian')
  assert.deepEqual(history[0].schema, schemaOf('historian'))
  assert.ok(history[0].brief.includes(HQ))
  assert.ok(history[0].brief.includes(Q))
  const docs = on(rig, 'docs')
  assert.equal(docs.length, 1)
  assert.equal(docs[0].role.name, 'doc-researcher')
  assert.deepEqual(docs[0].schema, schemaOf('doc_research'))
  assert.ok(docs[0].brief.includes(DQ))
  assert.ok(docs[0].brief.includes(Q))
})

test('no channel runs when the plan asks none', async (t) => {
  const { rig, result } = await runSurvey(t, fullScript({
    'analyst||plan': [{ output: plan({ topics: [TOPIC.loader, TOPIC.store], common_ground: COMMON }) }],
  }))
  assert.equal(on(rig, 'history').length, 0)
  assert.equal(on(rig, 'docs').length, 0)
  assert.equal(result.history, null)
  assert.equal(result.docs, null)
})

test('a failed channel fails alone', async (t) => {
  const { rig, result } = await runSurvey(t, fullScript({ 'historian||history': [{ status: 'failed', cause: 'host_error' }] }))
  assert.deepEqual(cov(result).failed_channels, ['history'])
  assert.ok(cov(result).unreached.some((l) => l.includes('history') && l.includes('host_error')), JSON.stringify(cov(result).unreached))
  const loader = pool(rig).find((it) => it.claim === CLAIM)
  assert.ok(loader, 'the topic item is recorded')
  assert.ok(result.items.some((it) => it.id === loader.id))
  assert.equal(result.history, null)
})

test('a channel that ends short is incomplete', async (t) => {
  const { result } = await runSurvey(t, fullScript({
    'doc-researcher||docs': [{ output: channelOut({ findings: 'd1', stop_reason: 'stuck', not_reached: '' }) }],
  }))
  assert.deepEqual(cov(result).incomplete, ['docs'])
  assert.deepEqual(cov(result).failed_channels, [])
})

test("the result names each channel's last stored return", async (t) => {
  const { rig, result } = await runSurvey(t, fullScript({
    'historian||history': [
      { output: channelOut({ findings: 'h1', stop_reason: 'unfinished', not_reached: 'the tags' }) },
      { output: channelOut({ findings: 'h2', stop_reason: 'exhausted' }) },
    ],
  }))
  const history = on(rig, 'history')
  assert.equal(history.length, 2)
  assert.equal(posix(result.history), posix(returnPath(rig.ctx.dir, history[1].dispatch)))
  const docs = on(rig, 'docs')
  assert.equal(posix(result.docs), posix(returnPath(rig.ctx.dir, docs[docs.length - 1].dispatch)))
})

// --- judges -----------------------------------------------------------------------------------

/** Topics and scouts with `counts` distinct locations each, over their own files. */
function weighedScript(counts, { common = 0 } = {}) {
  const keys = Object.keys(counts)
  const script = {
    'analyst||plan': [{ output: plan({ topics: keys.map((k) => TOPIC[k]), common_ground: common ? COMMON : '' }) }],
    ...emptyJudges(),
  }
  for (const k of keys) script['scout||scout:' + k] = [{ output: scoutOut({ hits: hitsIn(FILE[k], counts[k]) }) }]
  if (common) script['scout||common'] = [{ output: scoutOut({ hits: hitsIn(FILE.shared, common) }) }]
  return script
}
const holds = (call, key) => call.brief.includes(TOPIC[key].find)

test('sixty locations or fewer earn one judge', async (t) => {
  const { rig } = await runSurvey(t, weighedScript({ loader: 30, store: 30 }))
  assert.deepEqual(judgeThreads(rig), ['judge:1'])
  const j = on(rig, 'judge:1')[0]
  assert.ok(holds(j, 'loader') && holds(j, 'store'))
})

test('sixty-one locations earn two judges', async (t) => {
  const { rig } = await runSurvey(t, weighedScript({ loader: 31, store: 30 }))
  assert.deepEqual(judgeThreads(rig), ['judge:1', 'judge:2'])
  const [j1, j2] = [on(rig, 'judge:1')[0], on(rig, 'judge:2')[0]]
  assert.ok(holds(j1, 'loader') && !holds(j1, 'store'))
  assert.ok(holds(j2, 'store') && !holds(j2, 'loader'))
})

test("the common ground's locations count toward the judges' total", async (t) => {
  const { rig } = await runSurvey(t, weighedScript({ loader: 20, store: 20 }, { common: 21 }))
  assert.deepEqual(judgeThreads(rig), ['judge:1', 'judge:2'])
})

test('pace fast buys one judge per topic', async (t) => {
  const keys = ['loader', 'store', 'cache']
  const { rig } = await runSurvey(t, weighedScript({ loader: 2, store: 2, cache: 2 }), { pace: 'fast' })
  assert.deepEqual(judgeThreads(rig), ['judge:1', 'judge:2', 'judge:3'])
  keys.forEach((key, i) => {
    const j = on(rig, 'judge:' + (i + 1))[0]
    for (const other of keys) assert.equal(holds(j, other), other === key, 'judge:' + (i + 1) + ' and ' + other)
  })
})

test('topics are dealt heaviest first onto the lightest judge, numbered in plan order', async (t) => {
  // a = loader (10), b = store (50), c = cache (30)
  const { rig } = await runSurvey(t, weighedScript({ loader: 10, store: 50, cache: 30 }))
  assert.deepEqual(judgeThreads(rig), ['judge:1', 'judge:2'])
  const [j1, j2] = [on(rig, 'judge:1')[0], on(rig, 'judge:2')[0]]
  assert.ok(holds(j1, 'loader') && holds(j1, 'cache') && !holds(j1, 'store'))
  assert.ok(j1.brief.indexOf(TOPIC.loader.find) < j1.brief.indexOf(TOPIC.cache.find))
  assert.ok(holds(j2, 'store') && !holds(j2, 'loader') && !holds(j2, 'cache'))
})
