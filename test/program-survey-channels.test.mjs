// test/program-survey-channels.test.mjs — pins the survey's history and docs channels: which
// searcher answers which question, what a channel that fails or ends short costs, what the
// result and the context file carry of them.
//
// Design: docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { schemaOf } from '../lib/schemas.mjs'
import { stalledRecord } from './fast/harness/scout.mjs'
import {
  Q, TOPIC, plan, CLAIM, COMMON, HQ, DQ, DOCS_URL, fullScript, runSurvey, on, pool, cov,
} from './harness/survey-world.mjs'

const chargeOf = (call) => readFileSync(call.role.systemPromptFile, 'utf8')

test('a history question runs the historian with it, and a docs question the doc-researcher', async (t) => {
  const { rig } = await runSurvey(t, fullScript())
  const [history] = on(rig, 'history')
  assert.equal(on(rig, 'history').length, 2)
  assert.equal(history.role.name, 'historian')
  assert.deepEqual(history.schema, schemaOf('search'))
  for (const part of [HQ, Q]) assert.ok(chargeOf(history).includes(part), 'history charge holds ' + part)
  const [docs] = on(rig, 'docs')
  assert.equal(on(rig, 'docs').length, 2)
  assert.equal(docs.role.name, 'doc-researcher')
  assert.deepEqual(docs.schema, schemaOf('search'))
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

test('a channel that failed fails alone', async (t) => {
  const { rig, result } = await runSurvey(t, fullScript({ 'historian||history': [{ status: 'failed', cause: 'host_error' }] }))
  assert.deepEqual(cov(result).failed_channels, ['history'])
  assert.ok(cov(result).unreached.some((l) => l.startsWith('history: failed')), JSON.stringify(cov(result).unreached))
  assert.ok(pool(rig).some((it) => it.claim === CLAIM), 'the topic item is recorded')
  assert.deepEqual(result.history, { status: 'failed', hits: 0 })
})

test('a channel stopped at its budget is incomplete', async (t) => {
  const { result } = await runSurvey(t, fullScript({ 'doc-researcher||docs': [{ status: 'failed', cause: 'budget' }] }), { search_budget: 1 })
  assert.deepEqual(cov(result).incomplete, ['docs'])
  assert.equal(result.docs.status, 'budget')
  assert.deepEqual(cov(result).failed_channels, [])
})

test('a stalled channel is complete, its line declared', async (t) => {
  const { result } = await runSurvey(t, fullScript({ 'doc-researcher||docs': [{ calls: [stalledRecord()], output: { summary: 'stalled' } }] }))
  assert.deepEqual(cov(result).incomplete, [])
  assert.ok(cov(result).declared.some((l) => l.startsWith('docs: stalled')), JSON.stringify(cov(result).declared))
})

test("declared holds each channel search's coverage line", async (t) => {
  const { result } = await runSurvey(t, fullScript())
  for (const name of ['history', 'docs']) assert.ok(cov(result).declared.includes(name + ': done, 0 calls, 1 hit'), name + ': ' + JSON.stringify(cov(result).declared))
})

test("the result names each channel's status and its hit count, and the context holds its findings", async (t) => {
  const { result } = await runSurvey(t, fullScript())
  assert.deepEqual(result.history, { status: 'done', hits: 1 })
  assert.deepEqual(result.docs, { status: 'done', hits: 1 })
  const context = readFileSync(result.context, 'utf8')
  for (const part of ['GIT HISTORY:', 'HIST-FINDINGS-8a1b', 'EXTERNAL DOCUMENTATION:', 'DOCS-FINDINGS-9b2c', DOCS_URL]) assert.ok(context.includes(part), part)
})
