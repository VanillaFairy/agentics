// test/migrate-messages.test.mjs — tools/migrate-messages.mjs: the one-shot withdrawal of messages
// whose kind this version has no template for, on a store an older version left.
//
// Design: docs/DESIGN.md#conversations.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readLog } from '../lib/ledger.mjs'
import { preflight } from '../lib/boundaries/execution.mjs'
import { dispatch } from '../lib/programs/common.mjs'
import { migrate } from '../tools/migrate-messages.mjs'
import { executionRig } from './harness/program-rig.mjs'

delete process.env.NODE_TEST_CONTEXT

test('continue_search messages are withdrawn once, so an execution holding them resumes and their thread dispatches again', { timeout: 120_000 }, async (t) => {
  let rig = executionRig(t)
  // A 6.8 search thread: two continue_search rounds, each carried by the next dispatch; one never delivered; then a findings message.
  const sent = [1, 2, 3].map((round) => rig.log.append('message', {
    node: '.', thread: 'planner:.', from: 'code', msg: 'continue_search', payload: { not_reached: 'x' + round }, round,
  }).seq)
  sent.slice(0, 2).forEach((seq, i) => rig.log.append('dispatched', { node: '.', dispatch: 'd' + i, thread: 'planner:.', round: i + 2, carries: [seq], role: 'planner' }))
  rig.log.append('message', { node: '.', thread: 'planner:.', from: 'code', msg: 'findings', payload: { findings: [] }, round: 4 })
  const refused = preflight(rig.xc, {})
  assert.deepEqual([refused.ok, refused.error && refused.error.kind], [false, 'messages_unrenderable'], 'the fixture: the run refuses')
  const planner = () => dispatch(rig.ctx, { role: 'planner', schema: 'planner_write', node: '.', thread: 'planner:.', round: 5, brief: 'Write it.' })
  await assert.rejects(planner(), /no template for message "continue_search"/, 'the fixture: the thread cannot be dispatched on')

  const dry = migrate(rig.repo)
  assert.deepEqual(dry.withdrawn.map((w) => [w.messages, w.kinds, w.undelivered]), [[sent, ['continue_search'], [sent[2]]]])
  assert.equal(readLog(rig.repo, rig.effort, 'events').entries.filter((e) => e.kind === 'withdrawn').length, 0, 'a dry run writes nothing')
  assert.deepEqual(migrate(rig.repo, { yes: true }).refused, [])
  assert.deepEqual(migrate(rig.repo, { yes: true }).withdrawn, [], 'a second run withdraws nothing')

  rig = rig.relaunch()
  rig.script({ 'planner|.|planner:.': [{ output: { status: 'written', text: '' } }] })
  assert.notEqual((preflight(rig.xc, {}).error || {}).kind, 'messages_unrenderable')
  assert.equal((await planner()).status, 'returned')
  const carried = rig.log.entries().filter((e) => e.kind === 'dispatched' && e.round === 5).flatMap((e) => e.carries || [])
  assert.ok(carried.every((seq) => !sent.includes(seq)), 'the round carries no withdrawn message')
})
