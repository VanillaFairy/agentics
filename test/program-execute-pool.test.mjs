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
import { pauseRun, resumeRun } from '../lib/boundary.mjs'
import { afterEnded } from '../lib/programs/execute.mjs'
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

  test('a session pause on a live run starts nothing new while what runs finishes, and a resume starts the run again where it stood', T, async (t) => {
    const w = world(t, { spec: chainSpec('a', 'b') })
    const { rig } = w
    w.script({ [IMPL('a')]: [done()], [IMPL('b')]: [done()] }, rootReview(1, claim('D1 holds')))
    let paused = null
    w.before.push((call) => { if (call.node === 'a' && !paused) paused = pauseRun(rig.repo, rig.run) })

    const first = await w.start(['--effort', E])
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(paused.ok, true, JSON.stringify(paused))
    assert.equal(first.result.stopped, 'pause')
    assert.equal(statusOf(rig, 'a'), 'approved', "a's call in flight finished and recorded; its merge never started")
    assert.equal(dispatchedOf(rig, 'b').length, 0, 'b never called')
    assert.ok(first.result.notes.some((n) => n.startsWith('paused by the session (#' + paused.paused + ')')), JSON.stringify(first.result.notes))
    assert.equal(pauseRun(rig.repo, rig.run).already, true, 'a standing pause is not written again')

    const held = await w.start(['--effort', E])
    assert.equal(held.result.stopped, 'pause', 'a plain relaunch while the pause stands starts nothing')
    assert.equal(dispatchedOf(rig, 'b').length, 0)

    let relaunched = null
    const resumed = await resumeRun(rig.repo, rig.run, { launchRun: (o) => { relaunched = o; return w.start(o.argv.slice(1, -3)) } })
    assert.equal(resumed.ok, true, JSON.stringify(resumed))
    assert.ok(resumed.resumed > paused.paused)
    assert.deepEqual(relaunched.argv, ['execute', '--effort', E, '--repo', rig.repo, '--detach'], 'started again as it was given')
    assertComplete(resumed.relaunched.result)
    assert.equal(statusOf(rig, 'b'), 'merged')
    assert.equal((await resumeRun(rig.repo, rig.run, { launchRun: async () => ({ ok: true }) })).resumed, 0, 'nothing stands to resume')
  })

  test('a resume that saw the run live before its end is read back once it ended: the run starts again, and a second start is refused', T, async (t) => {
    const w = world(t, { spec: chainSpec('a', 'b') })
    const { rig } = w
    w.script({ [IMPL('a')]: [done()], [IMPL('b')]: [done()] }, rootReview(1, claim('D1 holds')))
    let paused = null
    w.before.push((call) => { if (call.node === 'a' && !paused) paused = pauseRun(rig.repo, rig.run) })
    const spawned = []
    const over = { spawnChild: ({ args }) => { spawned.push(args); return 4242 }, alive: () => true }
    const held = await w.start(['--effort', E], over)
    assert.equal(held.result.stopped, 'pause', 'the fixture: the run stopped for the pause')
    assert.deepEqual(spawned, [], 'the pause stood when it ended: nothing started again')

    // The race: the session's resume landed while the run was still live, so resumeRun started nothing.
    append(rig.repo, E, 'events', [{ kind: 'resumed', node: '', execution: rig.stamp, by: 'session' }])
    const launched = []
    const out = await afterEnded({ repo: rig.repo, run: rig.run, execution: rig.stamp }, { effort: E }, held.result, {
      launchRun: async (o) => { launched.push(o.argv); return { ok: true } },
    })
    assert.equal(out.ok, true)
    assert.deepEqual(launched, [['execute', '--effort', E, '--repo', rig.repo, '--detach']], 'read after its ended: the cleared pause starts the run again')

    const first = await w.start(['--effort', E, '--detach'], over)
    assert.equal(first.ok, true, JSON.stringify(first))
    const second = await w.start(['--effort', E, '--detach'], over)
    assert.equal(second.error && second.error.kind, 'run_live', 'the claim saw the first start: ' + JSON.stringify(second))
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
