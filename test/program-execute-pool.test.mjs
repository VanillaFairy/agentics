// test/program-execute-pool.test.mjs — pins the execute program (lib/programs/execute.mjs) end to
// end: the slot pool, pause, the budget and the stops carried and answered, started through
// lib/run.mjs or called directly over the execution rig (real git, the real measurement, a scripted
// runner).
//
// What is pinned here:
//
//   the tick loop  faults that hold a leaf without crowding out the pool, a leaf beside a stopped one, a
//                  leaf that finds no slot, pause, the budget
//   stops          a stop carried from an earlier run and a stop answered while the run goes on
//
// Every claim is read from the records (`executionLog(...).entries()`, `readTree(...).status`), the
// result and the calls the runner received. Expected values are computed: heads with `git
// rev-parse`, sessions with `sessionOf`, stamps with `stampNow`, tiers with `producerTier` and
// `tierFor`. Where the contract leaves a value open (a note's wording beyond its named start, a
// park's question beyond what the ruler gave) nothing here pins it. The execution rig and the specs
// the parts share are in test/harness/execute-program-world.mjs.
//
// Design: docs/DESIGN.md#execution, docs/DESIGN.md#scheduling.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { append } from '../lib/ledger.mjs'
import { acquireAsync, releaseSlots } from '../lib/locks.mjs'
import { dispatchKey } from '../lib/store.mjs'
import {
  T, E, YIELD, leafEntry, specText, done, failed, claim, reviewed, rootReview, IMPL, work, world, entriesOf,
  statusOf, callsOf, dispatchedOf, producerKey, idsOf, assertComplete, chainSpec,
} from './harness/execute-program-world.mjs'

// leaf-close, merge-batch and the suite gate measure through `node --test` grandchildren, which
// refuse to run under the test runner's marker; the rig does not clear it.
delete process.env.NODE_TEST_CONTEXT

// ================================================================== the tests

describe('the execute program', { concurrency: 4 }, () => {
  test('leaves held on faults never crowd out the pool', T, async (t) => {
    const w = world(t, { leaves: ['a', 'b', 'c', 'd'], config: { max_parallel: 2 } })
    w.script({ [IMPL('a')]: [failed('host_error')], [IMPL('b')]: [failed('host_error')], [IMPL('c')]: [done()], [IMPL('d')]: [done()] })
    const res = await w.run()

    assert.deepEqual(res.faults.map((f) => [f.id, f.channel]).sort(), [['a', 'host_error'], ['b', 'host_error']])
    assert.equal(statusOf(w.rig, 'c'), 'merged')
    assert.equal(statusOf(w.rig, 'd'), 'merged')
    assert.equal(dispatchedOf(w.rig, 'a').length, 1, 'a dispatched once')
    assert.equal(dispatchedOf(w.rig, 'b').length, 1, 'b dispatched once')
    assert.ok(res.coverage.unreached.some((l) => l.startsWith('a: held on a fault (host_error)')), JSON.stringify(res.coverage.unreached))
    assert.equal(res.coverage.complete, false)
  })

  test('a leaf that expects a file a stopped leaf expects runs all the same: an expectation blocks nothing', T, async (t) => {
    const w = world(t, { spec: specText([leafEntry('z', { expects: ['src/z.txt', 'src/b.txt'] }), leafEntry('b')]) })
    const { rig } = w
    rig.log.append('escalated', { node: 'z', reason: 'blocked', detail: 'stopped before the run' })
    w.script({ [IMPL('b')]: [done()] })
    const res = await w.run()

    assert.deepEqual(res.blocked, [])
    assert.deepEqual(w.calls.filter((c) => c.role.name === 'implementer').map((c) => c.node), ['b'])
    assert.equal(res.coverage.complete, false, 'z is still stopped')
  })

  test('a leaf that finds no slot waits in the tick loop, then runs once one frees', T, async (t) => {
    const w = world(t, {
      spec: specText([leafEntry('z'), leafEntry('x', { after: 'z' }), leafEntry('b')]), config: { max_parallel: 1 },
    })
    const { rig } = w
    rig.log.append('escalated', { node: 'z', reason: 'blocked', detail: 'stopped before the run' })
    const held = await acquireAsync(rig.repo, { effort: E, execution: '20250101-000000', node: 'x', waitMs: 0 })
    assert.equal(held.ok, true, JSON.stringify(held))
    w.script({ [IMPL('b')]: [done()] })
    const sleepsAtFirstCall = []
    w.before.push((call) => { if (call.role.name === 'implementer' && call.node === 'b') sleepsAtFirstCall.push(w.sleeps.length) })
    const frees = () => { releaseSlots(rig.repo, { effort: E, node: 'x' }); return YIELD() }
    const res = await w.run({}, { sleep: frees })

    assert.ok(sleepsAtFirstCall.length > 0 && sleepsAtFirstCall[0] >= 1, 'the program slept before b\'s first call: ' + JSON.stringify(sleepsAtFirstCall))
    assert.equal(dispatchedOf(rig, 'b').length, 1, 'b dispatched once')
    assert.equal(statusOf(rig, 'b'), 'merged')
    assert.deepEqual(idsOf(res.implemented), ['b'])
  })

  test('pause stops new leaves after the next merge-batch, and the relaunch costs every call of every run once, by model', T, async (t) => {
    const w = world(t, { spec: chainSpec('a', 'b') })
    const { rig } = w
    const A = { input_tokens: 10, output_tokens: 5 }
    const B = { input_tokens: 20, output_tokens: 5 }
    const R = { input_tokens: 7, output_tokens: 3 }
    w.script({
      [IMPL('a')]: [done('a', A, 0.5)], [IMPL('b')]: [done('b', B, 0.25)],
    }, { 'reviewer|.|integration:.:1': [{ ...reviewed(claim('D1 holds')), usage: R, cost_total: 0.125 }] })

    const first = await w.start(['--effort', E, '--pause'])
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.result.stopped, 'pause')
    assert.equal(statusOf(rig, 'a'), 'merged')
    assert.equal(statusOf(rig, 'b'), 'planned')
    assert.equal(dispatchedOf(rig, 'b').length, 0, 'b planned and never called')
    assert.ok(first.result.coverage.unreached.includes('1 of 2 leaves not merged (stopped: pause)'), JSON.stringify(first.result.coverage.unreached))

    const second = await w.start(['--effort', E])
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.equal(second.result.stopped, '')
    assert.deepEqual(idsOf(second.result.implemented), ['b'], 'implemented is this run\'s')
    assertComplete(second.result)
    const cost = second.result.cost
    assert.equal(cost.dispatches, 3, 'every returned of both runs')
    assert.equal(cost.tokens, 15 + 25 + 10)
    assert.ok(Math.abs(cost.usd - 0.875) < 1e-9, 'usd ' + cost.usd)
    const modelOf = (key) => entriesOf(rig).filter((e) => e.kind === 'dispatched' && e.dispatch === key).at(-1).model
    const calls = [[producerKey('a'), 15, 0.5], [producerKey('b'), 25, 0.25], [dispatchKey({ node: '.', role: 'reviewer', thread: 'integration:.:1', round: 1 }), 10, 0.125]]
    const want = {}
    for (const [key, tokens, usd] of calls) {
      const m = (want[modelOf(key)] ||= { dispatches: 0, tokens: 0, usd: 0 })
      m.dispatches += 1
      m.tokens += tokens
      m.usd += usd
    }
    assert.deepEqual(Object.keys(cost.by_model).sort(), Object.keys(want).sort())
    for (const [model, m] of Object.entries(want)) {
      assert.equal(cost.by_model[model].dispatches, m.dispatches, model)
      assert.equal(cost.by_model[model].tokens, m.tokens, model)
      assert.ok(Math.abs(cost.by_model[model].usd - m.usd) < 1e-9, model)
    }
  })

  test('budget: a leaf the target cannot cover at the measured tokens per merged leaf is not started', T, async (t) => {
    const w = world(t, { spec: chainSpec('a', 'b', 'c') })
    const { rig } = w
    const U = { input_tokens: 10, output_tokens: 5 }
    w.script({ [IMPL('a')]: [done('a', U, 0.1)], [IMPL('b')]: [done('b', U, 0.1)], [IMPL('c')]: [done('c', U, 0.1)] }, rootReview(1, claim('D1 holds')))
    const res = await w.run({ budget: 40 })

    assert.equal(statusOf(rig, 'a'), 'merged')
    assert.equal(statusOf(rig, 'b'), 'merged', '25 tokens left cover 15 per leaf')
    assert.equal(statusOf(rig, 'c'), 'planned')
    assert.equal(dispatchedOf(rig, 'c').length, 0, 'c planned and never called: 10 left do not')
    assert.equal(res.stopped, 'budget')
    assert.ok(res.coverage.unreached.includes('1 of 3 leaves not merged (stopped: budget)'), JSON.stringify(res.coverage.unreached))

    const more = await w.run({ budget: 0 })
    assert.equal(more.stopped, '', 'with no budget the same execution goes on')
    assert.equal(statusOf(rig, 'c'), 'merged')
    assertComplete(more)
  })

  // ------------------------------------------------------------------ stops carried and answered

  test('an escalation carried from an earlier run leads the result and keeps it incomplete', T, async (t) => {
    const w = world(t, { leaves: ['a', 'b'] })
    w.rig.log.append('escalated', { node: 'a', reason: 'blocked', detail: 'from an earlier run' })
    w.script({ [IMPL('b')]: [done()] })
    const res = await w.run()

    assert.deepEqual(res.escalations, [{ id: 'a', reason: 'blocked', said: '' }])
    assert.equal(res.coverage.unreached[0], 'a: escalated — blocked')
    assert.equal(res.coverage.complete, false)
    assert.equal(statusOf(w.rig, 'b'), 'merged')
    assert.equal(callsOf(w, 'implementer', 'a').length, 0)
  })

  test('a stop answered while the run goes on is taken up by the same run', T, async (t) => {
    const w = world(t, { leaves: ['a', 'b'] })
    const { rig } = w
    rig.log.append('escalated', { node: 'a', reason: 'blocked', detail: 'from an earlier run' })
    // The session answered and another writer recorded the retry, while b is running.
    w.jobs['implementer|b#1'] = (cwd) => {
      append(rig.repo, E, 'events', { kind: 'replanned', node: 'a', execution: rig.stamp, reason: 'retry_escalated', by: 'session' })
      return work(cwd, { 'src/b.txt': 'ok\n' }, 'make b')
    }
    w.script({ [IMPL('a')]: [done()], [IMPL('b')]: [done()] }, rootReview(1, claim('D1 holds')))
    const res = await w.run()

    assert.equal(dispatchedOf(rig, 'a').length, 1, 'a ran, once')
    assert.equal(statusOf(rig, 'a'), 'merged')
    assert.deepEqual(res.escalations, [])
    assertComplete(res)
  })
})
