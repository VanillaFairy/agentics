// test/program-survey-scouts.test.mjs — pins the survey program without reuse: its scope, the plan,
// the topics and their searches, and how judges are dealt.
//
// The scripts, the rig and the surveys the parts share are in test/harness/survey-world.mjs.
//
// Design: docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { groundText } from '../lib/briefs/search.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import { scopeOf, survey } from '../lib/programs/survey.mjs'
import { tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { treeOf } from '../lib/search/pin.mjs'
import { groundTable } from '../lib/search/resolve.mjs'
import { EMPTY_GROUND, withGround, openTurn, hitTurn } from './harness/navigator.mjs'
import {
  Q, FILES, FILE, TOPIC, plan, historyTurn, behaviour, anchoredUnit, judgeOut, ARGS, CLAIM,
  basicScript, COMMON, HQ, DQ, fullScript, rigFor, runSurvey, on, pool, roleOf, cov, scouted,
} from './harness/survey-world.mjs'

/** `n` consecutive locations of `path`, as a hit turn takes them. */
const hitsIn = (path, n, from = 1) => Array.from({ length: n }, (_, i) => [path, from + i])
const chargeOf = (call) => readFileSync(call.role.systemPromptFile, 'utf8')

const emptyJudges = (n = 4) => Object.fromEntries(Array.from({ length: n }, (_, i) => ['analyst||judge:' + (i + 1), [{ output: judgeOut() }]]))

const judgeCalls = (rig) => rig.calls.filter((c) => /^judge:\d+$/.test(c.thread.key))
const judgeThreads = (rig) => [...new Set(judgeCalls(rig).map((c) => c.thread.key))].sort()

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
  for (const thread of ['scout:loader', 'scout:store', 'history', 'docs', 'judge:1']) {
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
    ...scouted('loader-path', [hitTurn('loader-path', [[FILE.loader, 2]])]),
    ...scouted('store-x', [hitTurn('store-x', [[FILE.store, 2]])]),
    ...scouted('loader-path-2', [hitTurn('loader-path-2', [[FILE.cache, 2]])]),
    ...scouted('loader-path-3', [hitTurn('loader-path-3', [[FILE.shared, 2]])]),
    ...emptyJudges(),
  })
  const expected = [
    { key: 'loader-path', subtree: 'src/loader', forced: false },
    { key: 'store-x', subtree: 'src/store', forced: false },
    { key: 'loader-path-2', subtree: 'src/cache', forced: false },
    { key: 'loader-path-3', subtree: 'src/shared', forced: false },
  ]
  assert.deepEqual(result.topics.map(({ key, subtree, forced }) => ({ key, subtree, forced })), expected)
  for (const { key } of expected) assert.equal(on(rig, 'scout:' + key).length, 2, key)
})

test('every planned topic is scouted, beyond max_topics', async (t) => {
  const { rig, result } = await runSurvey(t, {
    'analyst||plan': [{ output: plan({ topics: [TOPIC.loader, TOPIC.store, TOPIC.cache] }) }],
    ...scouted('loader', [hitTurn('loader', [[FILE.loader, 2]])]),
    ...scouted('store', [hitTurn('store', [[FILE.store, 2]])]),
    ...scouted('cache', [hitTurn('cache', [[FILE.cache, 2]])]),
    ...emptyJudges(),
  }, { max_topics: 1 })
  for (const key of ['loader', 'store', 'cache']) assert.equal(on(rig, 'scout:' + key).length, 2, key)
  assert.deepEqual(result.topics.map((x) => x.key), ['loader', 'store', 'cache'])
})

test('a plan with no topics searches nothing and says so', async (t) => {
  const { rig, result } = await runSurvey(t, {
    'analyst||plan': [{ output: plan({ topics: [], history_question: HQ }) }],
    'historian||history': [historyTurn('unused')],
  })
  assert.equal(rig.calls.length, 1)
  assert.equal(cov(result).unreached.length, 1)
  assert.equal(cov(result).complete, false)
})

// --- topic searches ---------------------------------------------------------------------------

test("a topic's search runs as the scout at the dial, its charge holding the question, its find and its subtree", async (t) => {
  for (const intelligence of ['low', 'normal', 'max']) {
    const { rig } = await runSurvey(t, fullScript(), { intelligence })
    for (const key of ['loader', 'store']) {
      const calls = on(rig, 'scout:' + key)
      assert.equal(calls.length, 2, key + ': its turn and the stall the ruler ends it on')
      assert.equal(calls[0].role.name, 'scout')
      assert.deepEqual(calls[0].schema, schemaOf('search_repo'))
      assert.deepEqual(calls[0].tier, tierFor(roleOf('scout'), { intelligence }), intelligence)
      const charge = chargeOf(calls[0])
      for (const part of [Q, TOPIC[key].find, TOPIC[key].subtree]) assert.ok(charge.includes(part), key + ' charge holds ' + part)
    }
  }
})

test('the common ground is resolved once by code, every topic sharing it, and reaches every judge', async (t) => {
  const named = { ...TOPIC.loader, find: TOPIC.loader.find + ' in ' + FILE.loader }
  const rig = rigFor(t, fullScript({
    'analyst||plan': [{ output: plan({ topics: [named, TOPIC.store], common_ground: COMMON, history_question: HQ, docs_question: DQ }) }],
  }))
  let runs = 0
  await survey({ ...rig.ctx, groundOf: (tree, opts) => { runs++; return groundTable(tree, opts) } }, ARGS())
  assert.equal(runs, 1, 'one resolver run')
  assert.equal(rig.calls.filter((c) => c.thread.key === 'common').length, 0, 'no common search')
  const steps = rig.log.entries().filter((e) => e.kind === 'step')
  const shared = steps.filter((e) => e.key === 'ground')
  assert.equal(shared.length, 1)
  assert.notEqual(groundText(shared[0].value), '', 'the table holds what the finds name')
  for (const key of ['loader', 'store']) {
    assert.deepEqual(steps.find((e) => e.key === 'scout:' + key + '/ground').value, shared[0].value, key + ' searched over the shared table')
  }
  const brief = on(rig, 'judge:1')[0].brief
  assert.ok(brief.includes(COMMON), 'the judge holds the common ground as planned')
  assert.ok(brief.includes(groundText(shared[0].value)), 'and the ground table')
})

test("the shared table's material is the question and common ground as context and each topic's find as its own", async (t) => {
  const seen = []
  const rig = rigFor(t, fullScript())
  await survey(withGround(rig.ctx, EMPTY_GROUND, seen), ARGS())
  assert.equal(seen.length, 1, 'one resolver run')
  const { material } = seen[0]
  for (const key of ['loader', 'store']) {
    const own = material.filter((m) => (m.asks || []).includes(key))
    assert.equal(own.length, 1, key)
    assert.ok(own[0].text.includes(TOPIC[key].find), key + "'s material is its find")
  }
  for (const text of [Q, COMMON]) {
    const m = material.find((x) => x.text.includes(text))
    assert.ok(m && !(m.asks || []).length, 'context with no asks: ' + text)
  }
})

test("the survey's diff reaches the resolver", async (t) => {
  const seen = []
  const rig = rigFor(t, fullScript())
  const diff = { base: 'a'.repeat(40), head: 'b'.repeat(40) }
  await survey(withGround(rig.ctx, EMPTY_GROUND, seen), ARGS({ diff }))
  assert.deepEqual(seen[0].diff, diff)
})

test('a topic search still open after a turn resumes its own session', async (t) => {
  const { rig } = await runSurvey(t, fullScript({
    ...scouted('loader', [openTurn('loader', [[FILE.loader, 7]], FILE.loader), hitTurn('loader', [[FILE.loader, 9]])]),
  }))
  const calls = on(rig, 'scout:loader')
  assert.equal(calls.length, 3, 'two turns and the stall the ruler ends it on')
  assert.equal(calls[1].resume, true)
  assert.equal(calls[1].thread.session, calls[0].thread.session)
})

test('a topic search whose state stops moving leaves its topic incomplete, its end unreached', async (t) => {
  const { result } = await runSurvey(t, basicScript({
    ...scouted('loader', [openTurn('loader', [[FILE.loader, 7]], FILE.loader)], 'not_converging'),
  }))
  assert.deepEqual(cov(result).incomplete, ['loader'])
  assert.ok(cov(result).unreached.some((l) => l.includes('loader')), JSON.stringify(cov(result)))
  assert.equal(cov(result).complete, false)
})

test('a topic search that never returns leaves its topic incomplete, names it, and the topic is still judged', async (t) => {
  const FAIL = { status: 'failed', cause: 'host_error' }
  const { rig, result } = await runSurvey(t, basicScript({ 'scout||scout:loader': [FAIL, FAIL] }))
  assert.ok(cov(result).incomplete.includes('loader'))
  assert.ok(cov(result).unreached.some((l) => l.includes('topic loader')), JSON.stringify(cov(result)))
  assert.equal(on(rig, 'judge:1').length, 1)
})

test('declared holds each topic ask that the ruler ruled done, in its ruled form', async (t) => {
  const { result } = await runSurvey(t, fullScript())
  for (const key of ['loader', 'store']) assert.ok(cov(result).declared.some((l) => l.includes('scout:' + key) && l.includes(': ruled answered: ')), key + ': ' + JSON.stringify(cov(result).declared))
})

test("a tree handed in-process is searched, and the survey's items are anchored on it", async (t) => {
  const far = 90 // past the checkout's last line of the loader, inside the tree's
  const rig = rigFor(t, basicScript({
    ...scouted('loader', [hitTurn('loader', [[FILE.loader, far]])]),
    'analyst||judge:1': [{ output: judgeOut({ items: [behaviour('loader', CLAIM, far)], units: [anchoredUnit('loader')] }) }],
  }))
  const wt = join(rig.repo, '.claude', 'worktrees', 'other')
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { windowsHide: true })
  git(rig.repo, 'worktree', 'add', '--detach', wt, 'HEAD')
  const more = Array.from({ length: 20 }, (_, i) => 'alpha line ' + (81 + i)).join('\n') + '\n'
  writeFileSync(join(wt, ...FILE.loader.split('/')), FILES[FILE.loader] + more)
  git(wt, 'commit', '-qam', 'the tree grows')
  const result = await survey(rig.ctx, ARGS({ tree: treeOf(wt) }))
  const item = pool(rig).find((it) => it.claim === CLAIM)
  assert.ok(item, 'an item on a line only the tree holds is recorded: its anchor was read from the tree')
  assert.ok(result.items.some((it) => it.id === item.id && it.state === 'standing'), 'and it stands on the tree it was judged on')
})

// --- judges -----------------------------------------------------------------------------------

/** Topics and their searches with `counts` distinct locations each, over their own files. */
function weighedScript(counts) {
  const keys = Object.keys(counts)
  const script = { 'analyst||plan': [{ output: plan({ topics: keys.map((k) => TOPIC[k]) }) }], ...emptyJudges() }
  for (const k of keys) Object.assign(script, scouted(k, [hitTurn(k, hitsIn(FILE[k], counts[k]))]))
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
