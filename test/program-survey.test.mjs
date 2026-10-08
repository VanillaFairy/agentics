// test/program-survey.test.mjs — pins the survey program without reuse: its scope, the plan, the
// topics and their scouts, the history and docs channels, how judges are dealt and what each is
// handed, recording through the store with refusals sent back to the judge's own session, the
// context file, the result and its coverage block, the agent bound, relaunch, and a run from a
// linked worktree.
//
// Design: docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderMessage } from '../lib/conversation.mjs'
import { ITEM_KINDS, liveItems, recordItems, recordJudgement } from '../lib/evidence.mjs'
import { readProjectLog } from '../lib/ledger.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import { programContext } from '../lib/programs/common.mjs'
import { scopeOf, survey } from '../lib/programs/survey.mjs'
import { loadRole, tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { posix, returnPath, runLogPath } from '../lib/store.mjs'
import { programRig } from './harness/program-rig.mjs'

// --- the world --------------------------------------------------------------------------------

const Q = 'How does the loader resolve a module path?'
const GUIDE = 'GUIDE-7f3a: name every loader path you cite.'
const lines = (word, n) => Array.from({ length: n }, (_, i) => `${word} line ${i + 1}`).join('\n') + '\n'
const FILES = {
  'CLAUDE.md': '# Project\n\n' + GUIDE + '\n',
  'src/loader/index.mjs': lines('alpha', 80),
  'src/store/index.mjs': lines('beta', 80),
  'src/cache/index.mjs': lines('gamma', 80),
  'src/shared/index.mjs': lines('delta', 40),
}
const FILE = { loader: 'src/loader/index.mjs', store: 'src/store/index.mjs', cache: 'src/cache/index.mjs', shared: 'src/shared/index.mjs' }
const TOPIC = {
  loader: { key: 'loader', find: 'FIND-loader where module paths resolve', subtree: 'src/loader' },
  store: { key: 'store', find: 'FIND-store where returns are written', subtree: 'src/store' },
  cache: { key: 'cache', find: 'FIND-cache where results are kept', subtree: 'src/cache' },
}
/** A line of a file as an excerpt shows it, not mistaken for a longer line number. */
const lineRe = (word, n) => new RegExp(`${word} line ${n}(?!\\d)`)

const plan = ({ topics = [TOPIC.loader], common_ground = '', history_question = '', docs_question = '' } = {}) =>
  ({ topics, common_ground, history_question, docs_question })
const hit = (path, line, note = 'seen at ' + path + ':' + line) => ({ path, line, note })
const hitsIn = (path, n, from = 1) => Array.from({ length: n }, (_, i) => hit(path, from + i))
const scoutOut = ({ hits = [], searched = ['src'], no_match = '', not_reached = '', stop_reason = 'exhausted' } = {}) =>
  ({ hits, searched, no_match, not_reached, stop_reason })
const channelOut = ({ findings = '', searched = ['git log'], no_match = '', not_reached = '', stop_reason = 'exhausted' } = {}) =>
  ({ findings, searched, no_match, not_reached, stop_reason })
const behaviour = (topic, claim, line = 7) =>
  ({ topic, kind: 'behaviour', claim, spans: [{ path: FILE[topic], start: line, end: line }], queries: [], sources: [], rests_on: [] })
const unanchored = (topic, claim) => ({ topic, kind: 'behaviour', claim, spans: [], queries: [], sources: [], rests_on: [] })
const anchoredUnit = (topic) => ({ unit: topic, ruling: 'anchored', ids: [], why: 'every claim is anchored' })
const judgeOut = ({ items = [], risks = [], units = [] } = {}) => ({ items, risks, units })

const ARGS = (over = {}) => ({
  question: Q, roots: ['src'], notes: '', prior: '', max_topics: 8, intelligence: 'normal', pace: 'balanced', ground: [], ...over,
})

const CLAIM = 'CLAIM-loader resolves a path at line 7'
const basicScript = (over = {}) => ({
  'analyst||plan': [{ output: plan() }],
  'scout||scout:loader': [{ output: scoutOut({ hits: [hit(FILE.loader, 7, 'NOTE-loader resolves here')] }) }],
  'analyst||judge:1': [{ output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader')] }) }],
  ...over,
})

/** Every port, every searcher: two topics, common ground, both channels, one judge. */
const COMMON = 'COMMON-4d2e the shared helpers'
const HQ = 'HQ-1a2b when did the loader last change'
const DQ = 'DQ-3c4d what does node document about resolution'
const fullScript = (over = {}) => ({
  'analyst||plan': [{ output: plan({ topics: [TOPIC.loader, TOPIC.store], common_ground: COMMON, history_question: HQ, docs_question: DQ }) }],
  'scout||scout:loader': [{ output: scoutOut({ hits: [hit(FILE.loader, 7)] }) }],
  'scout||scout:store': [{ output: scoutOut({ hits: [hit(FILE.store, 9)] }) }],
  'scout||common': [{ output: scoutOut({ hits: [hit(FILE.shared, 3)] }) }],
  'historian||history': [{ output: channelOut({ findings: 'HIST-FINDINGS-8a1b' }) }],
  'doc-researcher||docs': [{ output: channelOut({ findings: 'DOCS-FINDINGS-9b2c', searched: ['nodejs.org'] }) }],
  'analyst||judge:1': [{
    output: judgeOut({
      items: [behaviour('loader', CLAIM), behaviour('store', 'CLAIM-store writes at line 9', 9)],
      risks: [{ topic: 'store', text: 'RISK-5e6f the store may race' }],
      units: [anchoredUnit('loader'), anchoredUnit('store')],
    }),
  }],
  ...over,
})

const emptyJudges = (n = 4) => Object.fromEntries(Array.from({ length: n }, (_, i) => ['analyst||judge:' + (i + 1), [{ output: judgeOut() }]]))

function rigFor(t, script, opts = {}) {
  const rig = programRig({ files: FILES, script, ...opts })
  t.after(() => rig.cleanup())
  return rig
}
async function runSurvey(t, script, over = {}) {
  const rig = rigFor(t, script)
  const result = await survey(rig.ctx, ARGS(over))
  return { rig, result }
}

const on = (rig, thread) => rig.calls.filter((c) => c.thread.key === thread)
const judgeCalls = (rig) => rig.calls.filter((c) => /^judge:\d+$/.test(c.thread.key))
const judgeThreads = (rig) => [...new Set(judgeCalls(rig).map((c) => c.thread.key))].sort()
const pool = (rig) => [...liveItems(rig.repo).values()]
const itemLines = (rig) => readProjectLog(rig.repo, 'items').entries.filter((e) => e.kind === 'item').length
const roleOf = (name) => loadRole(name).role
const cov = (result) => result.coverage
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
    ['topic loader', ['exhausted', 'NR-vendor dir']],
    ['common ground', ['exhausted', 'NR-common tests']],
    ['history', ['unfinished', 'NR-old tags', 'no_progress']],
    ['docs', ['exhausted', 'NR-v1 docs']],
  ]
  for (const [prefix, parts] of expect) {
    const found = lineStarting(result, prefix)
    assert.equal(found.length, 1, prefix + ' in ' + JSON.stringify(cov(result).declared))
    for (const part of parts) assert.ok(found[0].includes(part), prefix + ': ' + part)
  }
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

test("a judge is the analyst's at the dial, base high", async (t) => {
  for (const intelligence of ['low', 'normal', 'max']) {
    const { rig } = await runSurvey(t, basicScript(), { intelligence })
    const calls = on(rig, 'judge:1')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].role.name, 'analyst')
    assert.deepEqual(calls[0].schema, schemaOf('items'))
    assert.deepEqual(calls[0].tier, tierFor(roleOf('analyst'), { intelligence, base: 'high' }), intelligence)
  }
})

test("a judge's brief holds its scouts' excerpts and coverage inline", async (t) => {
  const { rig } = await runSurvey(t, fullScript({
    'analyst||plan': [{ output: plan({ topics: [TOPIC.loader], common_ground: COMMON }) }],
    'scout||scout:loader': [{
      output: scoutOut({
        hits: [hit(FILE.loader, 7, 'NOTE-a1 resolves'), hit(FILE.loader, 40, 'NOTE-a2 falls back')],
        searched: ['SEARCHED-src/loader/**'], no_match: 'NOMATCH-no dynamic import',
      }),
    }],
    'scout||common': [{ output: scoutOut({ hits: [hit(FILE.shared, 3, 'NOTE-common helper')] }) }],
    'analyst||judge:1': [{ output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader')] }) }],
  }))
  const brief = on(rig, 'judge:1')[0].brief
  assert.match(brief, lineRe('alpha', 7))
  assert.match(brief, lineRe('alpha', 40))
  assert.match(brief, lineRe('delta', 3))
  for (const part of ['NOTE-a1 resolves', 'NOTE-a2 falls back', 'SEARCHED-src/loader/**', 'NOMATCH-no dynamic import', 'NOTE-common helper']) {
    assert.ok(brief.includes(part), part)
  }
})

test("a judge's brief names each kind's anchor and the units it rules", async (t) => {
  const { rig } = await runSurvey(t, fullScript())
  const brief = on(rig, 'judge:1')[0].brief
  for (const kind of ITEM_KINDS) assert.ok(brief.includes(kind), kind)
  for (const key of ['loader', 'store']) assert.ok(brief.includes(key), key)
})

/** Every port and every kind of later round: a continued scout and a refusals round. */
const everyRoundScript = () => fullScript({
  'scout||scout:loader': [
    { output: scoutOut({ hits: [hit(FILE.loader, 7)], stop_reason: 'unfinished', not_reached: 'the tests folder' }) },
    { output: scoutOut({ hits: [hit(FILE.loader, 9)] }) },
  ],
  'analyst||judge:1': [
    { output: judgeOut({ items: [unanchored('loader', CLAIM)], units: [anchoredUnit('loader'), anchoredUnit('store')] }) },
    { output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader'), anchoredUnit('store')] }) },
  ],
})
const everyThread = ['plan', 'scout:loader', 'scout:store', 'common', 'history', 'docs', 'judge:1']

test('no brief points at a file for its evidence', async (t) => {
  const { rig } = await runSurvey(t, everyRoundScript())
  for (const thread of everyThread) assert.ok(on(rig, thread).length > 0, thread)
  for (const c of rig.calls) {
    assert.ok(!c.brief.includes('.agentics'), c.thread.key + ' round ' + c.round + ' brief')
    assert.ok(!c.freshBrief.includes('.agentics'), c.thread.key + ' round ' + c.round + ' freshBrief')
  }
})

test("every brief carries the repository's guidance", async (t) => {
  const { rig } = await runSurvey(t, everyRoundScript())
  for (const thread of everyThread) assert.ok(on(rig, thread).length > 0, thread)
  assert.ok(on(rig, 'judge:1').some((c) => c.round === 2), 'a refusals round ran')
  for (const c of rig.calls) {
    assert.ok(c.freshBrief.includes(GUIDE), c.thread.key + ' round ' + c.round + ' freshBrief')
    if (c.round === 1) assert.ok(c.brief.includes(GUIDE), c.thread.key + ' brief')
  }
})

// --- the record -------------------------------------------------------------------------------

test("a judge's items are recorded under the question, grounded at their topic's subtree", async (t) => {
  const { rig, result } = await runSurvey(t, basicScript())
  const item = pool(rig).find((it) => it.claim === CLAIM)
  assert.ok(item, 'the item is in the pool')
  assert.equal(item.question, Q)
  assert.equal(item.topic, 'loader')
  assert.deepEqual(item.ground, [TOPIC.loader.subtree])
  assert.ok(result.items.some((it) => it.id === item.id))
})

test("a refused item goes back to its judge's own session with what is wrong", async (t) => {
  const { rig, result } = await runSurvey(t, basicScript({
    'analyst||judge:1': [
      { output: judgeOut({ items: [unanchored('loader', CLAIM)], units: [anchoredUnit('loader')] }) },
      { output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader')] }) },
    ],
  }))
  const messages = rig.log.entries().filter((e) => e.kind === 'message' && e.thread === 'judge:1' && e.msg === 'refusals')
  assert.equal(messages.length, 1)
  const m = messages[0]
  assert.equal(m.payload.refusals[0].claim, CLAIM)
  assert.equal(typeof m.payload.refusals[0].problem, 'string')
  assert.ok(m.payload.refusals[0].problem.trim() !== '')
  const calls = on(rig, 'judge:1')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].round, 2)
  assert.equal(calls[1].resume, true)
  assert.equal(calls[1].thread.session, calls[0].thread.session)
  assert.equal(calls[1].brief, renderMessage({ msg: m.msg, payload: m.payload }))
  assert.deepEqual(calls[1].carries, [m.seq])
  assert.ok(pool(rig).some((it) => it.claim === CLAIM))
  assert.equal(cov(result).complete, true, JSON.stringify(cov(result)))
})

test('each pass that refuses fewer is asked again', async (t) => {
  const A = 'CLAIM-A loader reads at line 7'
  const B = 'CLAIM-B loader falls back at line 12'
  const { rig, result } = await runSurvey(t, basicScript({
    'analyst||judge:1': [
      { output: judgeOut({ items: [unanchored('loader', A), unanchored('loader', B)], units: [anchoredUnit('loader')] }) },
      { output: judgeOut({ items: [behaviour('loader', A, 7), unanchored('loader', B)], units: [anchoredUnit('loader')] }) },
      { output: judgeOut({ items: [behaviour('loader', B, 12)], units: [anchoredUnit('loader')] }) },
    ],
  }))
  assert.equal(on(rig, 'judge:1').length, 3)
  const claims = pool(rig).map((it) => it.claim)
  assert.ok(claims.includes(A) && claims.includes(B), JSON.stringify(claims))
  assert.deepEqual(result.unrecorded, [])
})

test('a judge that refuses no fewer leaves its topics unrecorded and incomplete', async (t) => {
  const { rig, result } = await runSurvey(t, basicScript({
    'analyst||judge:1': [
      { output: judgeOut({ items: [unanchored('loader', CLAIM)], units: [anchoredUnit('loader')] }) },
      { output: judgeOut({ items: [unanchored('loader', CLAIM)], units: [anchoredUnit('loader')] }) },
      { output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader')] }) },
    ],
  }))
  assert.equal(on(rig, 'judge:1').length, 2)
  assert.deepEqual(result.unrecorded, ['loader'])
  assert.deepEqual(cov(result).incomplete, ['loader'])
  assert.equal(pool(rig).length, 0)
})

// --- context, result and coverage -------------------------------------------------------------

test('the context file holds the items, the risks and the channels', async (t) => {
  const { result } = await runSurvey(t, fullScript())
  const text = readFileSync(result.context, 'utf8')
  for (const part of [CLAIM, 'CLAIM-store writes at line 9', 'RISK-5e6f the store may race', 'HIST-FINDINGS-8a1b', 'DOCS-FINDINGS-9b2c']) {
    assert.ok(text.includes(part), part)
  }
})

test('items come in plan topic order', async (t) => {
  const { result } = await runSurvey(t, fullScript({
    'analyst||judge:1': [{
      output: judgeOut({
        items: [behaviour('store', 'CLAIM-store writes at line 9', 9), behaviour('loader', CLAIM)],
        units: [anchoredUnit('loader'), anchoredUnit('store')],
      }),
    }],
  }))
  assert.deepEqual(result.items.map((it) => it.topic), ['loader', 'store'])
  for (const it of result.items) {
    for (const key of ['id', 'topic', 'kind', 'state']) assert.equal(typeof it[key], 'string', key)
  }
})

test('risks are counted per topic from the judges', async (t) => {
  const { result } = await runSurvey(t, fullScript({
    'analyst||judge:1': [{
      output: judgeOut({
        items: [behaviour('loader', CLAIM), behaviour('store', 'CLAIM-store writes at line 9', 9)],
        risks: [{ topic: 'loader', text: 'r1' }, { topic: 'store', text: 'r2' }, { topic: 'loader', text: 'r3' }],
        units: [anchoredUnit('loader'), anchoredUnit('store')],
      }),
    }],
  }))
  const n = (topic) => (result.risks.find((r) => r.topic === topic) || {}).n
  assert.equal(n('loader'), 2)
  assert.equal(n('store'), 1)
})

test('a topic given neither items nor risks is dropped', async (t) => {
  const { result } = await runSurvey(t, fullScript({
    'analyst||judge:1': [{ output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader'), anchoredUnit('store')] }) }],
  }))
  assert.deepEqual(cov(result).dropped, ['store'])
  assert.ok(!cov(result).incomplete.includes('store'))
  assert.equal(cov(result).complete, false)
})

test('a failed judge drops its topics, naming why', async (t) => {
  const { rig, result } = await runSurvey(t, basicScript({ 'analyst||judge:1': [{ status: 'failed', cause: 'host_error' }] }))
  assert.ok(cov(result).dropped.includes('loader'))
  assert.ok(cov(result).unreached.some((l) => l.includes('judge 1') && l.includes('host_error')), JSON.stringify(cov(result).unreached))
  assert.equal(pool(rig).length, 0)
  assert.deepEqual(result.items, [])
})

test('a topic whose unit the judge left open is incomplete', async (t) => {
  const { result } = await runSurvey(t, fullScript({
    'analyst||judge:1': [{
      output: judgeOut({
        items: [behaviour('loader', CLAIM), behaviour('store', 'CLAIM-store writes at line 9', 9)],
        units: [{ unit: 'store', ruling: 'unanchored', ids: [], why: 'the write is not shown' }],
      }),
    }],
  }))
  assert.ok(cov(result).incomplete.includes('loader'), 'never ruled')
  assert.ok(cov(result).incomplete.includes('store'), 'ruled unanchored')
})

test("a topic whose unit the judge's corrected answer rules anchored is complete", async (t) => {
  const { result } = await runSurvey(t, basicScript({
    'analyst||judge:1': [
      { output: judgeOut({ items: [unanchored('loader', CLAIM)], units: [] }) },
      { output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader')] }) },
    ],
  }))
  assert.ok(!cov(result).incomplete.includes('loader'))
  assert.equal(cov(result).complete, true, JSON.stringify(cov(result)))
})

test('a survey whose every search finished and every item stands is complete', async (t) => {
  const { rig, result } = await runSurvey(t, basicScript())
  const c = cov(result)
  assert.equal(c.complete, true, JSON.stringify(c))
  for (const list of ['dropped', 'incomplete', 'failed_channels', 'unreached']) assert.deepEqual(c[list], [], list)
  assert.deepEqual(c.resumable, rig.ctx.resumable)
})

test('a survey returning an item that does not stand is not complete', async (t) => {
  const rig = rigFor(t, {})
  const old = recordItems(rig.repo, '20250101-000000-survey', [{
    question: 'An older question?', topic: 'old', ground: ['src/loader'], kind: 'behaviour', claim: 'the old claim',
    spans: [{ path: FILE.loader, start: 3, end: 3 }], queries: [], sources: [], rests_on: [],
  }])
  assert.equal(old.ok, true, JSON.stringify(old))
  const staleId = old.ids[0]
  assert.equal(recordJudgement(rig.repo, staleId, 'fails').ok, true)
  const DERIVED = 'CLAIM-derived from the old claim'
  const rel = rig.relaunch(basicScript({
    'analyst||judge:1': [{
      output: judgeOut({
        items: [{ topic: 'loader', kind: 'derived', claim: DERIVED, spans: [], queries: [], sources: [], rests_on: [staleId] }],
        units: [anchoredUnit('loader')],
      }),
    }],
  }))
  const result = await survey(rel.ctx, ARGS())
  const derived = pool(rel).find((it) => it.claim === DERIVED)
  assert.ok(derived, 'the derived item is recorded')
  const listed = result.items.find((it) => it.id === derived.id)
  assert.ok(listed, 'the result lists it')
  assert.equal(listed.state, 'stale')
  for (const list of ['dropped', 'incomplete', 'failed_channels', 'unreached']) assert.deepEqual(cov(result)[list], [], list)
  assert.equal(cov(result).complete, false)
})

// --- bound, relaunch and root -----------------------------------------------------------------

test('a relaunch calls nothing that returned', async (t) => {
  const { rig, result } = await runSurvey(t, fullScript())
  const before = itemLines(rig)
  const rel = rig.relaunch({})
  const again = await survey(rel.ctx, ARGS())
  assert.equal(rel.calls.length, 0)
  assert.deepEqual(again, result)
  assert.equal(itemLines(rel), before)
})

test('a relaunch cut off before its record was journaled records the same items again under the same ids', async (t) => {
  const { rig, result } = await runSurvey(t, fullScript())
  const path = runLogPath(rig.repo, rig.run)
  const kept = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '' && JSON.parse(l).kind !== 'step')
  assert.ok(kept.length < readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').length, 'the run journaled steps')
  writeFileSync(path, kept.join('\n') + '\n')
  const rel = rig.relaunch({})
  const again = await survey(rel.ctx, ARGS())
  assert.equal(rel.calls.length, 0)
  const ids = result.items.map((it) => it.id).sort()
  assert.ok(ids.length > 0)
  assert.deepEqual(again.items.map((it) => it.id).sort(), ids)
  assert.deepEqual([...liveItems(rel.repo).keys()].sort(), ids)
})

test("a survey given a root reads its excerpts and guidance there and records into the repository's pool", async (t) => {
  const rig = rigFor(t, basicScript())
  const parent = mkdtempSync(join(tmpdir(), 'agentics-survey-root-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const wt = join(parent, 'wt')
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
  git(rig.repo, 'worktree', 'add', '-q', '-b', 'side', wt)
  const ROOT_GUIDE = 'ROOT-GUIDE-2b9c: the worktree has its own rules.'
  const changed = FILES[FILE.loader].replace(/^alpha line 7$/m, 'ROOT-ONLY line 7')
  writeFileSync(join(wt, 'src', 'loader', 'index.mjs'), changed)
  writeFileSync(join(wt, 'CLAUDE.md'), '# Project\n\n' + ROOT_GUIDE + '\n')
  git(wt, 'commit', '-qam', 'side change')
  const wtHead = git(wt, 'rev-parse', 'HEAD')
  assert.notEqual(wtHead, git(rig.repo, 'rev-parse', 'HEAD'))

  await survey(programContext({ ...rig.ctx, root: wt }), ARGS())
  const brief = on(rig, 'judge:1')[0].brief
  assert.ok(brief.includes('ROOT-ONLY line 7'), 'the root\'s line')
  assert.ok(brief.includes(ROOT_GUIDE), 'the root\'s guidance')
  const item = pool(rig).find((it) => it.claim === CLAIM)
  assert.ok(item, 'the item is in the main checkout\'s pool')
  assert.equal(item.spans[0].at, wtHead)
})
