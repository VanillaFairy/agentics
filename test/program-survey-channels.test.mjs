// test/program-survey-channels.test.mjs — pins the survey's history and docs channels: which
// searcher answers which question, what a channel that fails or ends short costs, what the
// result and the context file carry of them.
//
// Design: docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { schemaOf } from '../lib/schemas.mjs'
import { posix, returnPath } from '../lib/store.mjs'
import {
  Q, TOPIC, plan, channelOut, CLAIM, COMMON, HQ, DQ, fullScript, runSurvey, on, pool, cov,
} from './harness/survey-world.mjs'

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

test("declared names each channel's stop as it stated it", async (t) => {
  const { result } = await runSurvey(t, fullScript({
    'analyst||plan': [{ output: plan({ topics: [TOPIC.loader], history_question: HQ, docs_question: DQ }) }],
    'historian||history': [
      { output: channelOut({ findings: 'h1', stop_reason: 'unfinished', not_reached: 'NR-old tags' }) },
      { output: channelOut({ findings: 'h1', stop_reason: 'unfinished', not_reached: 'NR-old tags' }) },
    ],
    'doc-researcher||docs': [{ output: channelOut({ findings: 'd1', not_reached: 'NR-v1 docs' }) }],
  }))
  const declared = cov(result).declared
  assert.ok(declared.includes('history: unfinished, not reached: NR-old tags (ended short: no_progress)'), JSON.stringify(declared))
  assert.ok(declared.includes('docs: exhausted, not reached: NR-v1 docs'), JSON.stringify(declared))
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
