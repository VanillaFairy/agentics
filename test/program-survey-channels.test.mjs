// test/program-survey-channels.test.mjs — pins the survey's history and docs channels: which
// searcher answers which question, what a channel that fails or ends short costs, what the
// result and the context file carry of them.
//
// Design: docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { schemaOf } from '../lib/schemas.mjs'
import { endSearch, fetchCall, webReturn } from './harness/navigator.mjs'
import {
  Q, TOPIC, plan, CLAIM, COMMON, HQ, DQ, DOCS_URL, fullScript, runSurvey, on, pool, cov,
} from './harness/survey-world.mjs'

const chargeOf = (call) => readFileSync(call.role.systemPromptFile, 'utf8')

test('a history question runs the historian with it, and a docs question the doc-researcher', async (t) => {
  const { rig } = await runSurvey(t, fullScript())
  const [history] = on(rig, 'history')
  assert.equal(on(rig, 'history').length, 2, 'its turn and the stall the ruler ends it on')
  assert.equal(history.role.name, 'historian')
  assert.deepEqual(history.schema, schemaOf('search_history'))
  for (const part of [HQ, Q]) assert.ok(chargeOf(history).includes(part), 'history charge holds ' + part)
  const [docs] = on(rig, 'docs')
  assert.equal(on(rig, 'docs').length, 2, 'its turn and the stall the ruler ends it on')
  assert.equal(docs.role.name, 'doc-researcher')
  assert.deepEqual(docs.schema, schemaOf('search_web'))
  for (const part of [DQ, Q]) assert.ok(chargeOf(docs).includes(part), 'docs charge holds ' + part)
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

test('a channel that produced nothing fails alone', async (t) => {
  const FAIL = { status: 'failed', cause: 'host_error' }
  const { rig, result } = await runSurvey(t, fullScript({ 'historian||history': [FAIL, FAIL] }))
  assert.deepEqual(cov(result).failed_channels, ['history'])
  assert.ok(cov(result).unreached.some((l) => l.includes('history')), JSON.stringify(cov(result).unreached))
  assert.ok(pool(rig).some((it) => it.claim === CLAIM), 'the topic item is recorded')
  assert.equal(result.history.hits, 0)
})

test('a channel whose state stops moving is incomplete', async (t) => {
  const stuck = { calls: [fetchCall('docs', DOCS_URL)], output: webReturn({ leads: [{ ask: 'docs', path: DOCS_URL, why: 'read the rest' }] }) }
  const end = endSearch({ name: 'docs', turn: 1, asks: 'docs', ruling: 'not_converging' })
  const { result } = await runSurvey(t, fullScript({ 'doc-researcher||docs': [stuck, { output: webReturn({}) }], [end.ruler.key]: end.ruler.steps }))
  assert.deepEqual(cov(result).incomplete, ['docs'])
  assert.equal(result.docs.end, 'not_converging')
  assert.deepEqual(cov(result).failed_channels, [])
})

test('declared holds each channel ask that the ruler ruled done, in its ruled form', async (t) => {
  const { result } = await runSurvey(t, fullScript())
  for (const name of ['history', 'docs']) assert.ok(cov(result).declared.some((l) => l.startsWith(name + ':') && l.includes(': ruled answered: ')), name + ': ' + JSON.stringify(cov(result).declared))
})

test("the result names each channel's end and its hit count, and the context holds its findings", async (t) => {
  const { result } = await runSurvey(t, fullScript())
  assert.deepEqual(result.history, { status: 'returned', end: 'done', hits: 1 })
  assert.deepEqual(result.docs, { status: 'returned', end: 'done', hits: 1 })
  const context = readFileSync(result.context, 'utf8')
  for (const part of ['GIT HISTORY:', 'HIST-FINDINGS-8a1b', 'EXTERNAL DOCUMENTATION:', 'DOCS-FINDINGS-9b2c']) assert.ok(context.includes(part), part)
})
