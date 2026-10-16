// test/program-wants.test.mjs — pins wants: a survey judge that
// names ground it lacked reopens its program's own search with the want as a new ask, the
// navigator's session resumed; only the judges whose wants ended are dispatched again, for those
// units alone, and what they return for them replaces what they returned before; a want asked
// before adds nothing, so the loop ends.
//
// Design: docs/DESIGN.md#searches, docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { programContext } from '../lib/programs/common.mjs'
import { judgeLines } from '../lib/programs/search/consume.mjs'
import { survey } from '../lib/programs/survey.mjs'
import { hitTurn, repoReturn } from './harness/navigator.mjs'
import { ARGS, FILE, TOPIC, anchoredUnit, behaviour, endedRounds, plan, pool, rescouted, rigFor, scouted } from './harness/survey-world.mjs'

const on = (rig, thread) => rig.calls.filter((c) => c.thread.key === thread)
const chargeOf = (call) => readFileSync(call.role.systemPromptFile, 'utf8')

// --- the survey --------------------------------------------------------------------------------

const WANT_L = 'WANT-where a module path falls back'
const LOADER_CLAIM = 'CLAIM-loader falls back at line 30'
const STORE_CLAIM = 'CLAIM-store writes at line 9'
const loaderFound = { turns: [hitTurn('loader', [[FILE.loader, 7]])], asks: 'loader' }
const fallbackFound = { turns: [hitTurn('want:1', [[FILE.loader, 30, 'NOTE-the fallback']])], asks: 'want:1' }
/**
 * One judge holds loader and store; loader's search runs again for the judge's want. `loader` lists
 * the loader search's rounds, each ended by the ruler (`endedRounds`).
 */
const surveyScript = (judge, loader = [loaderFound, fallbackFound]) => ({
  'analyst||plan': [{ output: plan({ topics: [TOPIC.loader, TOPIC.store] }) }],
  ...endedRounds('scout', 'scout:loader', loader),
  ...scouted('store', [hitTurn('store', [[FILE.store, 9]])]),
  'analyst||judge:1': judge,
})
const firstJudge = { output: {
  items: [behaviour('store', STORE_CLAIM, 9)], risks: [],
  units: [{ unit: 'loader', ruling: 'unanchored', ids: [], why: 'the fallback was not located' }, anchoredUnit('store')],
  wants: [{ unit: 'loader', want: WANT_L }],
} }
const secondJudge = (wants = []) => ({ output: { items: [behaviour('loader', LOADER_CLAIM, 30)], risks: [], units: [anchoredUnit('loader')], wants } })

async function surveyIn(t, script) {
  const rig = rigFor(t, script)
  const result = await survey(rig.ctx, ARGS())
  return { rig, result }
}

test('a want that ends short in a survey is declared and leaves its topic complete', async (t) => {
  const nothingFound = { turns: [{ output: repoReturn({}) }], asks: 'want:1', ruling: 'not_converging', quiet: true }
  const { rig, result } = await surveyIn(t, surveyScript([firstJudge, secondJudge()], [loaderFound, nothingFound]))
  assert.equal(on(rig, 'judge:1').length, 2, 'the wanted topic is judged again though the want found nothing')
  assert.ok(result.coverage.declared.some((l) => l.startsWith('want 1: ended ')), JSON.stringify(result.coverage.declared))
  for (const list of ['incomplete', 'unreached', 'failed_channels']) {
    assert.ok(!result.coverage[list].some((l) => l.startsWith('scout:loader:want:')), list + ' holds no want line')
  }
  assert.ok(!result.coverage.incomplete.includes('loader'))
})

test('a judge whose wants round does not return leaves an unreached line and the survey incomplete', async (t) => {
  const { rig, result } = await surveyIn(t, surveyScript([firstJudge, { status: 'failed', cause: 'host_error' }]))
  assert.equal(on(rig, 'scout:loader').length, 3, 'the want was searched')
  const line = result.coverage.unreached.find((l) => l.startsWith('judge 1 did not return for its wants'))
  assert.ok(line, JSON.stringify(result.coverage.unreached))
  assert.ok(line.includes('loader'), 'the line names the topic whose second look never happened')
  assert.equal(result.coverage.complete, false)
})

test("a survey judge's want reopens its topic's search, its navigator session resumed", async (t) => {
  const { rig } = await surveyIn(t, surveyScript([firstJudge, secondJudge()]))
  const calls = on(rig, 'scout:loader')
  assert.equal(calls.length, 3, 'its turn, the stall, and the turn for the want')
  assert.ok(calls[2].brief.includes('want:1'))
  assert.ok(calls[2].brief.includes(WANT_L) || chargeOf(calls[2]).includes(WANT_L))
  assert.equal(calls[2].resume, true)
  assert.equal(calls[2].thread.session, calls[0].thread.session)
  assert.equal(on(rig, 'scout:store').length, 2, 'a topic nobody wanted more of is not searched again')
})

test('the judge is dispatched again for the wanted topic alone, with what the want found', async (t) => {
  const { rig } = await surveyIn(t, surveyScript([firstJudge, secondJudge()]))
  const calls = on(rig, 'judge:1')
  assert.equal(calls.length, 2)
  const again = calls[1]
  assert.equal(again.resume, true)
  assert.ok(again.brief.includes('loader'), 'the wanted topic is to be judged again')
  assert.ok(!again.brief.includes(TOPIC.store.find), 'the topic nobody wanted more of is not')
  assert.ok(again.brief.includes('alpha line 30'), 'the lines the want found')
})

test("what the judge returns for a wanted topic is recorded beside its first return's other topics", async (t) => {
  const { rig, result } = await surveyIn(t, surveyScript([firstJudge, secondJudge()]))
  const claims = pool(rig).map((it) => it.claim)
  assert.ok(claims.includes(LOADER_CLAIM), "the wanted topic's item")
  assert.ok(claims.includes(STORE_CLAIM), "the first return's item for the other topic")
  assert.ok(!result.coverage.incomplete.includes('loader'), 'the wanted topic is anchored now')
})

test('a judge whose second return wants something new opens want:2 and is dispatched a third time', async (t) => {
  const WANT_2 = 'WANT-where the fallback is logged'
  const logFound = { turns: [hitTurn('want:2', [[FILE.loader, 31, 'NOTE-the log']])], asks: 'want:2' }
  const script = surveyScript([firstJudge, secondJudge([{ unit: 'loader', want: WANT_2 }]), secondJudge()], [loaderFound, fallbackFound, logFound])
  const { rig } = await surveyIn(t, script)
  const calls = on(rig, 'scout:loader')
  assert.equal(calls.length, 5, 'a second want is a second turn, and its stall')
  assert.ok(calls[3].brief.includes('want:2'))
  assert.ok(calls[3].brief.includes(WANT_2) || chargeOf(calls[3]).includes(WANT_2))
  assert.equal(calls[3].thread.session, calls[0].thread.session)
  assert.equal(on(rig, 'judge:1').length, 3)
})

test("a judge's want asked again adds nothing, and the survey ends", async (t) => {
  const { rig } = await surveyIn(t, surveyScript([firstJudge, secondJudge([{ unit: 'loader', want: WANT_L }])]))
  assert.equal(on(rig, 'scout:loader').length, 3, 'no navigator turn after the want')
  assert.equal(on(rig, 'judge:1').length, 2, 'no third judge round')
})

test('survey judges keep their own pace', async (t) => {
  const WANT_S = 'WANT-where a return is flushed'
  const storeFirst = { output: {
    items: [behaviour('store', STORE_CLAIM, 9)], risks: [],
    units: [{ unit: 'store', ruling: 'unanchored', ids: [], why: 'the flush was not located' }], wants: [{ unit: 'store', want: WANT_S }],
  } }
  const rig = rigFor(t, {
    'analyst||plan': [{ output: plan({ topics: [TOPIC.loader, TOPIC.store] }) }],
    ...rescouted('loader', [hitTurn('loader', [[FILE.loader, 7]])], [hitTurn('want:1', [[FILE.loader, 30, 'NOTE-the fallback']])]),
    ...rescouted('store', [hitTurn('store', [[FILE.store, 9]])], [hitTurn('want:1', [[FILE.store, 12, 'NOTE-the flush']])]),
    'analyst||judge:1': [firstJudge, secondJudge()],
    'analyst||judge:2': [storeFirst, { output: { items: [behaviour('store', STORE_CLAIM, 12)], risks: [], units: [anchoredUnit('store')], wants: [] } }],
  })
  // Judge 1's want search is held until judge 2 is dispatched for its own want (or a timeout gives up waiting).
  const order = []
  let release
  const judge2Again = new Promise((resolve) => { release = resolve })
  const timer = setTimeout(() => release(), 3000)
  t.after(() => clearTimeout(timer))
  const runAgent = async (call) => {
    const at = call.thread.key + '#' + call.round
    order.push(at)
    if (at === 'judge:2#2') release()
    if (call.thread.key === 'scout:loader' && call.brief.includes('want:1')) await judge2Again
    return rig.ctx.runAgent(call)
  }
  await survey(programContext({ intelligence: 'normal', ...rig.ctx, runAgent }), ARGS({ pace: 'fast' }))
  assert.ok(order.includes('judge:2#2'), 'judge 2 was dispatched for its want: ' + order.join(' '))
  assert.ok(on(rig, 'scout:loader').some((c) => c.brief.includes('want:1')), "judge 1's want was searched")
  assert.ok(order.indexOf('judge:2#2') < order.lastIndexOf('judge:1#2'), "judge 2's re-dispatch does not wait for judge 1's topic search: " + order.join(' '))
})

test('one wording for a lost round', async (t) => {
  const { result } = await surveyIn(t, surveyScript([firstJudge, { status: 'failed', cause: 'host_error' }]))
  const [line] = judgeLines({ 1: { passes: [{ round: 2, units: ['loader'], status: 'failed', cause: 'host_error', not_reached: '' }] } }, 'judge').unreached
  assert.ok(result.coverage.unreached.includes(line), JSON.stringify(result.coverage.unreached))
})

test('a reworded want ends', async (t) => {
  const REWORDED = 'WANT-where, exactly, a module path falls back'
  const nothingNew = { turns: [{ output: repoReturn({}) }], asks: 'want:2', ruling: 'not_converging', quiet: true }
  // Its third return rules the topic otherwise, so only the pass that added no fact can end the loop.
  const reruled = { output: { items: [behaviour('loader', LOADER_CLAIM, 30)], risks: [], units: [{ unit: 'loader', ruling: 'unanchored', ids: [], why: 'still unsure' }], wants: [{ unit: 'loader', want: REWORDED + ' again' }] } }
  const script = surveyScript([firstJudge, secondJudge([{ unit: 'loader', want: REWORDED }]), reruled],
    [loaderFound, fallbackFound, nothingNew])
  const { rig } = await surveyIn(t, script)
  assert.ok(on(rig, 'scout:loader').some((c) => c.brief.includes('want:2')), 'the reworded want was searched')
  assert.ok(!on(rig, 'scout:loader').some((c) => c.brief.includes('want:3')), 'a pass that added no fact ends the loop')
  assert.equal(on(rig, 'judge:1').length, 3, 'no round after the pass that added nothing')
})
