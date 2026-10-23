// test/program-execute-relaunch.test.mjs — pins the execute program (lib/programs/execute.mjs) end
// to end: a relaunch and the dial, started through lib/run.mjs or called directly over the
// execution rig (real git, the real measurement, a scripted runner).
//
// What is pinned here:
//
//   relaunches   a run killed between a return and its close, or while a reviewer's host stop is
//                waited out, resumes where it stood and lands nothing twice
//   the dial     every unit is tiered from the envelope's dial; a fresh execution's dial is the
//                argument
//
// Every claim is read from the records (`executionLog(...).entries()`, `readTree(...).status`), the
// result and the calls the runner received. Expected values are computed: heads with `git
// rev-parse`, sessions with `sessionOf`, stamps with `stampNow`, tiers with `producerTier` and
// `tierFor`. Where the contract leaves a value open (a note's wording beyond its named start, a
// park's question beyond what the ruler gave) nothing here pins it. The execution rig and the specs
// the parts share are in test/harness/execute-program-world.mjs.
//
// Design: docs/DESIGN.md#execution, docs/DESIGN.md#resume-and-checkpoints.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { renderMessage } from '../lib/conversation.mjs'
import { executionLog } from '../lib/ledger.mjs'
import { loadRole, producerTier, tierFor } from '../lib/roles.mjs'
import { closePath, writeJson } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { DEAD_PID } from './harness/dead-pid.mjs'
import {
  T, E, YIELD, done, ruling, rulings, claim, staleRuler, rootReview, IMPL, world, kinds, stateOf, callsOf,
  startsOf, commandsFile, moveBase, assertComplete,
} from './harness/execute-program-world.mjs'

// leaf-close, merge-batch and the suite gate measure through `node --test` grandchildren, which
// refuse to run under the test runner's marker; the rig does not clear it.
delete process.env.NODE_TEST_CONTEXT

const NEVER = () => new Promise(() => {})

const stopped = () => ({ status: 'stopped', cause: 'rate_limit' })

/** A promise a test awaits and a hung run resolves: the signal that a run reached the point it is killed at. */
function signal() {
  let hit
  const reached = new Promise((resolveIt) => { hit = resolveIt })
  return { reached, hit }
}

// ================================================================== the tests

describe('the execute program', { concurrency: 4 }, () => {

  // ------------------------------------------------------------------ a relaunch

  test('a run killed between a return and its close is closed on relaunch at its own round, nothing dispatched again', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    w.script({ [IMPL('a')]: [done()] })
    const killed = signal()
    w.after.push(async (call) => {
      if (call.role.name === 'implementer') {
        killed.hit()
        await NEVER()
      }
    })
    const first = w.run()
    const at = await Promise.race([
      killed.reached.then(() => 'killed'),
      first.then((r) => 'returned ' + JSON.stringify(r && r.status), (e) => 'threw ' + e.message),
    ])
    first.catch(() => {})
    assert.equal(at, 'killed', 'the first run reached the point it is killed at')
    const closeFile = closePath(w.rig.repo, E, w.rig.stamp, 'a', 'implementer', 1)
    assert.equal(existsSync(closeFile), false, 'killed before the close')

    w.relaunch()
    w.after.length = 0
    w.script(rootReview(1, claim('D1 holds')))
    const res = await w.run()

    assert.equal(callsOf(w, 'implementer').length, 0, 'no producer call')
    assert.equal(existsSync(closeFile), true, 'the close record of round 1 exists')
    assert.equal(kinds(w.rig, 'approved', 'a').length, 1, 'one approved')
    assert.deepEqual(res.implemented.map((i) => [i.id, i.rounds]), [['a', 1]])
    assertComplete(res)
  })

  test('a relaunch resumes the open dispatches in their own sessions and lands nothing twice', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    w.script({ [IMPL('a')]: [done()], 'reviewer|.|integration:.:1': [stopped()] })
    const killed = signal()
    const sleep = () => {
      if (callsOf(w, 'reviewer').length === 0) return YIELD()
      killed.hit()
      return NEVER()
    }
    const first = w.run({}, { sleep })
    const at = await Promise.race([
      killed.reached.then(() => 'killed'),
      first.then((r) => 'returned ' + JSON.stringify(r && r.status), (e) => 'threw ' + e.message),
    ])
    first.catch(() => {})
    assert.equal(at, 'killed', 'the first run reached the point it is killed at')
    const [cut] = startsOf(w, 'reviewer', '.')
    assert.ok(cut, 'the first run called the root reviewer')

    w.relaunch()
    w.script(rootReview(1, claim('D1 holds')))
    const res = await w.run()

    assert.equal(w.calls.length, 1, 'the relaunch\'s one call')
    const [call] = w.calls
    assert.equal(call.role.name, 'reviewer')
    assert.equal(call.dispatch, cut.dispatch, 'is that reviewer\'s dispatch')
    assert.equal(call.resume, true)
    assert.equal(call.thread.session, cut.thread.session, 'in the same session')
    assert.equal(call.brief, renderMessage({ msg: 'cut_off' }), 'briefed cut_off')
    assert.equal(kinds(w.rig, 'approved', 'a').length, 1)
    assert.equal(kinds(w.rig, 'merged', 'a').length, 1)
    assert.equal(kinds(w.rig, 'claims', '.').length, 1)
    assert.equal(kinds(w.rig, 'batch').length, 1)
    assert.equal(stateOf(w.rig).filter((e) => e.kind === 'closed').length, 1)
    assertComplete(res)
  })


  test('a start closes the call a dead run left open on a thread no unit asks for again', T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const gone = 'root.analyst.probe-gone'
    executionLog(w.rig.repo, E, w.rig.stamp).append('dispatched', {
      dispatch: gone, node: '', round: 1, thread: 'probe:a:1/prober:1', role: 'analyst', model: 'opus', effort: 'medium',
      session: 's-gone', brief_digest: 'b', brief_parts: {}, carries: [], prompt: 'p', cwd: w.rig.repo, pid: DEAD_PID,
    })
    w.script({ [IMPL('a')]: [done()] }, rootReview(1, claim('D1 holds')))
    const out = await w.start(['--effort', E])

    assert.equal(out.ok, true, JSON.stringify(out))
    const ended = stateOf(w.rig).filter((e) => e.kind === 'returned' && e.dispatch === gone)
    assert.deepEqual(ended.map((e) => [e.status, e.cause]), [['cut_off', 'process_gone']])
    assert.equal(callsOf(w, 'analyst').length, 0, 'the closed call is not dispatched again')
    assert.ok(out.result.notes.some((n) => n.startsWith('1 dispatch(es) a dead run left open, closed cut off')), JSON.stringify(out.result.notes))
  })

  // ------------------------------------------------------------------ the dial

  /** The tier each unit's call must have at `dial`, computed from the roles. */
  const tierAt = (rig, dial) => ({
    ruler: tierFor(loadRole('ruler').role, { intelligence: dial }),
    reviewer: tierFor(loadRole('reviewer').role, { intelligence: dial }),
    producer: producerTier(readTree(rig.repo, E).nodes.get('a'), loadRole('implementer').role, { intelligence: dial }),
  })

  test("a relaunch with no --intelligence tiers every unit, the stale ruler first, at its envelope's dial", T, async (t) => {
    const w = world(t, { leaves: ['a'] })
    const { rig } = w
    writeJson(join(rig.dir, 'execution.json'), { ...rig.envelope, dial: 'max' })
    const head = moveBase(rig, 'src/a.txt')
    w.script(staleRuler(head, rulings(ruling('a', 'unaffected', 'the base change is elsewhere'))), { [IMPL('a')]: [done()] }, rootReview(1, claim('D1 holds')))
    const out = await w.start(['--effort', E])

    assert.equal(out.ok, true, JSON.stringify(out))
    assert.deepEqual(w.calls.map((c) => c.role.name), ['ruler', 'implementer', 'reviewer'], 'the stale ruler first')
    const max = tierAt(rig, 'max')
    const normal = tierAt(rig, 'normal')
    for (const key of ['ruler', 'producer', 'reviewer']) assert.notDeepEqual(max[key], normal[key], 'the fixture: max tiers the ' + key + ' otherwise than normal')
    assert.deepEqual(w.calls.map((c) => c.tier), [max.ruler, max.producer, max.reviewer])
    assert.equal(JSON.parse(readFileSync(join(rig.dir, 'execution.json'), 'utf8')).dial, 'max')
  })

  test("a relaunch's --intelligence leaves its envelope's dial in force; a fresh execution's dial is the argument", T, async (t) => {
    const resumed = world(t, { leaves: ['a'] })
    writeJson(join(resumed.rig.dir, 'execution.json'), { ...resumed.rig.envelope, dial: 'max' })
    resumed.script({ [IMPL('a')]: [done()] }, rootReview(1, claim('D1 holds')))
    await resumed.run({ intelligence: 'low' })

    const max = tierAt(resumed.rig, 'max')
    assert.notDeepEqual(max.reviewer, tierAt(resumed.rig, 'low').reviewer, 'the fixture: the dials tier differently')
    assert.deepEqual(resumed.calls.map((c) => c.role.name), ['implementer', 'reviewer'])
    assert.deepEqual(resumed.calls.map((c) => c.tier), [max.producer, max.reviewer], 'each at the tier max gives it')
    assert.equal(JSON.parse(readFileSync(join(resumed.rig.dir, 'execution.json'), 'utf8')).dial, 'max')

    const fresh = world(t, { leaves: ['a'] })
    rmSync(join(fresh.rig.dir, 'execution.json'))
    fresh.script({ [IMPL('a')]: [done()] }, rootReview(1, claim('D1 holds')))
    await fresh.run({ intelligence: 'low', commands_file: commandsFile(fresh.rig) })

    const low = tierAt(fresh.rig, 'low')
    assert.equal(JSON.parse(readFileSync(join(fresh.rig.dir, 'execution.json'), 'utf8')).dial, 'low', 'the envelope written has the argument\'s dial')
    assert.deepEqual(fresh.calls.map((c) => c.role.name), ['implementer', 'reviewer'])
    assert.deepEqual(fresh.calls.map((c) => c.tier), [low.producer, low.reviewer], 'each at the tier low gives it')
  })
})
