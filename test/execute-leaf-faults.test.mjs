// test/execute-leaf-faults.test.mjs — pins the leaf unit of the execute program (`runLeaf`): one
// leaf driven over the execution rig, with scripted agents, to a requeue, a route or a fault, and
// through a relaunch.
//
// What is pinned here:
//
//   requeues, routes and faults  by cause: no slot, needs_context, a
//                                failed dispatch, and a throw inside the unit, but a hung
//                                git, which rejects as GitHung
//   a relaunch                   rebuilt from the records
//
// The rig, the scripted answers and the worlds the parts share are in
// test/harness/execute-leaf-world.mjs.
//
// Design: docs/DESIGN.md#executors-and-review.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { runLeaf } from '../lib/programs/execute/leaf.mjs'
import { heldOf } from '../lib/boundaries/records.mjs'
import { renderMessage } from '../lib/conversation.mjs'
import { append } from '../lib/ledger.mjs'
import { acquireAsync } from '../lib/locks.mjs'
import { GitHung, closePath, configPath, returnPath, writeJson } from '../lib/store.mjs'
import { PART_BYTES } from '../lib/roles.mjs'
import { readTree } from '../lib/tree.mjs'
import {
  T, E, leafEntry, specText, YARD, bLeaf, git, work, world, ofKind, stateOf, faultsOf, startsOf, approvals,
  stopsOn, stepsOf, keyOf, IMPL, REV, done, said, failed, verdict,
} from './harness/execute-leaf-world.mjs'

// The rig does not clear NODE_TEST_CONTEXT, and a measurement's nested `node --test` that inherits
// it reports to this runner and exits 0, so every red or tdd test file would read as passing.
delete process.env.NODE_TEST_CONTEXT

const stopped = () => ({ status: 'stopped', cause: 'rate_limit' })

/** A reviewer thread's quiet end of a killed run: resolves the promise a test awaits and never resolves itself. */
function killer() {
  let hit
  const reached = new Promise((resolveIt) => { hit = resolveIt })
  return { reached, hit, sleep: () => { hit(); return new Promise(() => {}) } }
}

// ------------------------------------------------------------------ one round

describe('the leaf unit', { concurrency: 4 }, () => {

  // ------------------------------------------------------------------ requeues, routes and faults

  test('no slot: the leaf goes back to the scheduler, nothing dispatched', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(), leafEntry('x', { expects: ['src/x.txt'] })] })
    writeJson(configPath(w.rig.repo), { max_parallel: 1 })
    const held = await acquireAsync(w.rig.repo, { effort: E, execution: w.rig.stamp, node: 'x', waitMs: 0 })
    assert.equal(held.ok, true, JSON.stringify(held))
    w.rig.script({})
    const out = await w.run('b')
    assert.equal(out.outcome, 'requeue')
    assert.equal(w.rig.calls.length, 0)
    assert.equal(ofKind(w.rig, 'dispatched', 'b').length, 0)
    assert.deepEqual(faultsOf(w.rig), [])
    assert.deepEqual(stopsOn(w.rig), [])
  })

  test('no free slot: the leaf goes back to the scheduler, nothing dispatched', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(), leafEntry('x', { expects: ['src/x.txt', 'src/b.txt'] })] })
    mkdirSync(dirname(configPath(w.rig.repo)), { recursive: true })
    writeFileSync(configPath(w.rig.repo), JSON.stringify({ max_parallel: 1 }))
    const held = await acquireAsync(w.rig.repo, { effort: E, execution: w.rig.stamp, node: 'x', waitMs: 0 })
    assert.equal(held.ok, true, JSON.stringify(held))
    w.rig.script({})
    const out = await w.run('b')
    assert.equal(out.outcome, 'requeue')
    assert.equal(w.rig.calls.length, 0)
    assert.equal(ofKind(w.rig, 'dispatched', 'b').length, 0)
    assert.deepEqual(faultsOf(w.rig), [])
  })

  test("needs_context under a planner's folder comes back as a route to that planner", T, async (t) => {
    const root = specText([['- **f** — sub-effort · realises: D1 · author: planner', '  Fold f', '']])
    // A planner-written spec states no decision of its own: its task realises the root's D1.
    const sub = specText([leafEntry('b', { expects: ['src/b.txt'] })], { decisions: false })
    const w = world(t, { spec: { '.': root, f: sub } })
    const ASKED = 'which format does the folder want?'
    w.rig.script({ 'implementer|f/b|producer:f/b': [said('needs_context', ASKED)] })
    const out = await w.run('f/b')
    assert.equal(out.outcome, 'route')
    assert.equal(out.route.folder, 'f')
    assert.equal(out.route.request.node, 'f/b')
    assert.equal(out.route.request.status, 'needs_context')
    assert.equal(out.route.request.text, ASKED)
    assert.deepEqual(stopsOn(w.rig, 'f/b'), [], 'the leaf is not parked')
    assert.deepEqual(stopsOn(w.rig, 'f'), [], 'nor the folder')
  })

  // Repository guidance past what one part of a brief may hold: the user's file, which no plan shrinks.
  const HUGE_GUIDANCE = { 'CLAUDE.md': 'g'.repeat(PART_BYTES + 1) + '\n' }
  // A task whose own intent is past what one part of a brief may hold: the leaf's own work.
  const hugeLeaf = (id) => {
    const [head, ...rest] = leafEntry(id, { expects: ['src/' + id + '.txt'] })
    return [head, '  ' + 'w'.repeat(PART_BYTES + 1), ...rest]
  }
  const PLANNED = specText([['- **f** — sub-effort · realises: D1 · author: planner', '  Fold f', '']])

  test("a leaf whose own task is past its budget, under a planner's folder, goes to that planner to split, nothing sent", T, async (t) => {
    const w = world(t, { spec: { '.': PLANNED, f: specText([hugeLeaf('b')], { decisions: false }) } })
    w.rig.script({})
    const out = await w.run('f/b')
    assert.equal(w.rig.calls.length, 0, 'no producer is started')
    assert.equal(out.outcome, 'route')
    assert.equal(out.route.folder, 'f')
    assert.deepEqual([out.route.request.node, out.route.request.status], ['f/b', 'decompose'])
    assert.ok(out.route.request.text.includes('"Task"'), out.route.request.text)
    assert.deepEqual(faultsOf(w.rig, 'f/b'), [])
    assert.deepEqual(stopsOn(w.rig, 'f/b'), [])
  })

  test('a leaf its planner revised that is refused on the same part again escalates replan_not_converging, not routed again', T, async (t) => {
    const w = world(t, { spec: { '.': PLANNED, f: specText([hugeLeaf('b'), hugeLeaf('c')], { decisions: false }) } })
    w.rig.script({})
    assert.equal((await w.run('f/b')).outcome, 'route')
    const sibling = await w.run('f/c')
    assert.equal(sibling.outcome, 'route', 'a leaf of the folder no plan revised since is routed, its own request')
    const again = w.relaunch()
    again.rig.script({})
    assert.equal((await again.run('f/b')).outcome, 'route', 'the unrevised leaf is routed again on a relaunch')

    const b = readTree(again.rig.repo, E).nodes.get('f/b')
    assert.equal(append(again.rig.repo, E, 'nodes', [{ kind: 'node', node: { ...b, title: b.title + ', split' } }]).ok, true)
    const revised = w.relaunch()
    revised.rig.script({})
    const out = await revised.run('f/b')
    assert.equal(revised.rig.calls.length, 0, 'no producer is started')
    assert.equal(out.outcome, 'stopped')
    assert.equal(out.route, undefined)
    const stops = stopsOn(revised.rig, 'f/b')
    assert.deepEqual(stops.map((s) => [s.kind, s.reason]), [['escalated', 'replan_not_converging']])
    assert.ok(stops[0].detail.includes('"Task"'), stops[0].detail)
  })

  test("a leaf whose repository guidance is past its budget escalates brief_too_large naming the file, never its planner's", T, async (t) => {
    const w = world(t, { spec: { '.': PLANNED, f: specText([leafEntry('b', { expects: ['src/b.txt'] })], { decisions: false }) }, files: HUGE_GUIDANCE })
    w.rig.script({})
    const out = await w.run('f/b')
    assert.equal(w.rig.calls.length, 0, 'no producer is started')
    assert.equal(out.outcome, 'stopped')
    assert.equal(out.route, undefined, 'no planner is asked to split what it cannot shrink')
    const stops = stopsOn(w.rig, 'f/b')
    assert.deepEqual(stops.map((s) => [s.kind, s.reason]), [['escalated', 'brief_too_large']])
    assert.ok(stops[0].detail.includes('"CLAUDE.md"') && stops[0].detail.includes(String(PART_BYTES)), stops[0].detail)
    assert.deepEqual(faultsOf(w.rig), [])
  })

  test('a leaf whose own task is past its budget, in a folder the user wrote, parks needs_respec, nothing sent', T, async (t) => {
    const w = world(t, { leaves: [hugeLeaf('b')] })
    w.rig.script({})
    const out = await w.run('b')
    assert.equal(w.rig.calls.length, 0, 'no producer is started')
    assert.equal(out.outcome, 'stopped')
    assert.deepEqual(stopsOn(w.rig).map((s) => [s.kind, s.return]), [['parked', 'needs_respec']])
    assert.deepEqual(faultsOf(w.rig), [])
  })

  test("a relaunch routes a needs_context round again while the leaf is unrevised, and opens the next round once a plan revised it", T, async (t) => {
    const root = specText([['- **f** — sub-effort · realises: D1 · author: planner', '  Fold f', '']])
    const sub = specText([leafEntry('b', { expects: ['src/b.txt'] })], { decisions: false })
    const w = world(t, { spec: { '.': root, f: sub } })
    const WHY = 'src/c.txt must change too'
    w.job('implementer|f/b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ 'implementer|f/b|producer:f/b': [{ output: { status: 'needs_context', text: WHY } }] })
    const first = await w.run('f/b')
    assert.equal(first.outcome, 'route')

    const again = w.relaunch()
    again.rig.script({})
    const out = await again.run('f/b')
    assert.deepEqual(faultsOf(again.rig, 'f/b'), [], 'no fault: the routed round is not resumed with nothing to say')
    assert.equal(again.rig.calls.length, 0, 'no producer is dispatched')
    assert.equal(out.outcome, 'route')
    assert.deepEqual(out.route, first.route, 'the route the first run held in memory')

    const b = readTree(again.rig.repo, E).nodes.get('f/b')
    assert.equal(append(again.rig.repo, E, 'nodes', [{ kind: 'node', node: { ...b, expects: ['src/b.txt', 'src/c.txt'] } }]).ok, true)
    const revised = w.relaunch()
    revised.rig.script({ 'implementer|f/b|producer:f/b': [done()] })
    const next = await revised.run('f/b')
    assert.deepEqual(faultsOf(revised.rig, 'f/b'), [])
    assert.equal(next.outcome, 'approved')
    assert.equal(next.round, 2)
    assert.equal(startsOf(revised.rig, 'implementer', 'f/b').length, 1, 'the revised leaf runs its next round')
  })

  /** A dispatch that failed: the fault it records, the leaf it holds, and no question. */
  function assertFaulted(w, out, channel) {
    assert.equal(out.outcome, 'faulted')
    const faults = faultsOf(w.rig)
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, channel)
    assert.ok(heldOf(stateOf(w.rig)).has('b'), 'the leaf is held')
    assert.deepEqual(stopsOn(w.rig), [], 'no escalation, no park')
    assert.equal(approvals(w.rig).length, 0)
  }

  test('a dispatch that failed schema_failed is a role fault, and the leaf is held', T, async (t) => {
    const w = world(t)
    w.rig.script({ [IMPL]: [failed('schema_failed'), failed('schema_failed')] })
    assertFaulted(w, await w.run('b'), 'role')
  })

  test('a dispatch that failed host_error is a host_error fault, and the leaf is held', T, async (t) => {
    const w = world(t)
    w.rig.script({ [IMPL]: [failed('host_error')] })
    assertFaulted(w, await w.run('b'), 'host_error')
  })

  for (const cause of ['checkout', 'watch_failed']) {
    test(`a dispatch that failed ${cause} is a checkout fault, and the leaf is held`, T, async (t) => {
      const w = world(t)
      const around = async (call) => ({ status: 'failed', cause, message: 'the host said ' + cause, session: call.thread.session })
      assertFaulted(w, await w.leg({ around }).run('b'), 'checkout')
    })
  }

  test('a throw inside the unit is a program fault on the leaf', T, async (t) => {
    const w = world(t)
    w.rig.script({})
    const out = await w.run('b')
    assert.equal(out.outcome, 'faulted')
    const faults = faultsOf(w.rig)
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'program')
    assert.ok(heldOf(stateOf(w.rig)).has('b'))
    assert.deepEqual(stopsOn(w.rig), [])
  })

  test('a git hung inside the unit rejects as GitHung for the git_hung stop, recording no program fault', T, async (t) => {
    const w = world(t)
    w.rig.script({ [IMPL]: [done()] })
    w.job('implementer|b#1', () => { throw new GitHung(['status'], 1) })
    await assert.rejects(w.run('b'), (err) => err instanceof GitHung && err.label === 'git status')
    assert.deepEqual(faultsOf(w.rig), [])
  })

  test('a throw inside the unit whose fault cannot be recorded still ends the leaf faulted', T, async (t) => {
    const w = world(t)
    w.rig.script({})
    const refusing = { ...w.rig.xc, log: { ...w.rig.xc.log, append() { throw new Error('the ledger refused the write') } } }
    const out = await runLeaf(w.ctx, refusing, { id: 'b', intelligence: 'normal' })
    assert.equal(out.outcome, 'faulted')
    assert.deepEqual(faultsOf(w.rig), [])
  })

  // ------------------------------------------------------------------ a relaunch

  test('a relaunch resumes a cut-off producer in its own session', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [stopped()] })
    const k = killer()
    w.leg({ sleep: k.sleep }).run('b').catch(() => {})
    await k.reached
    const cut = startsOf(w.rig, 'implementer', 'b')[0]
    assert.ok(cut, 'the first run called the producer')
    const again = w.relaunch()
    again.rig.script({ [IMPL]: [done()] })
    const out = await again.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 1)
    assert.equal(again.rig.calls.length, 1)
    const [call] = again.rig.calls
    assert.equal(call.dispatch, cut.dispatch, 'the same dispatch')
    assert.equal(call.resume, true)
    assert.equal(call.thread.session, cut.thread.session)
    assert.equal(call.brief, renderMessage({ msg: 'cut_off' }))
  })

  test('a fix round cut off after it committed is judged on relaunch against the head it first opened on', T, async (t) => {
    const w = world(t)
    let headBefore = ''
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'no\n' }, 'first try'))
    w.job('implementer|b#2', (cwd) => {
      headBefore = git(cwd, 'rev-parse', 'HEAD')
      work(cwd, { 'src/b.txt': 'ok\n' }, 'fix')
    })
    w.rig.script({ [IMPL]: [done(), stopped()] })
    const k = killer()
    w.leg({ sleep: k.sleep }).run('b').catch(() => {})
    await k.reached
    assert.notEqual(headBefore, '')
    const again = w.relaunch()
    again.rig.script({ [IMPL]: [done()] })
    const out = await again.run('b')
    assert.equal(ofKind(again.rig, 'escalated', 'b').length, 0, 'a head moved by the round itself is not a fix without commits')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 2)
    const opened = stepsOf(again.rig, 'opened:b:2')
    assert.equal(opened.length, 1)
    assert.equal(opened[0].value.head_sha, headBefore, 'the head the round first opened on')
    assert.equal(again.rig.calls.length, 1)
    assert.equal(again.rig.calls[0].resume, true)
  })

  test('a round whose call returned but was never closed is closed on relaunch, not dispatched again', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [done()] })
    const k = killer()
    const around = async (call, real) => {
      await real(call)
      k.hit()
      return new Promise(() => {})
    }
    w.leg({ around }).run('b').catch(() => {})
    await k.reached
    const closePathB = closePath(w.rig.repo, w.rig.effort, w.rig.stamp, 'b', 'implementer', 1)
    assert.equal(existsSync(closePathB), false, 'killed before the close')
    const again = w.relaunch()
    again.rig.script({})
    const out = await again.run('b')
    assert.equal(again.rig.calls.length, 0, 'no call')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 1)
    assert.equal(existsSync(closePathB), true, 'its close record is written')
    assert.equal(approvals(again.rig).length, 1)
  })

  test('a round closed on relaunch whose stored return is gone holds the leaf on a role fault', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [done()] })
    const k = killer()
    const around = async (call, real) => {
      await real(call)
      k.hit()
      return new Promise(() => {})
    }
    w.leg({ around }).run('b').catch(() => {})
    await k.reached
    rmSync(returnPath(w.rig.dir, keyOf('b', 'implementer', 'producer:b', 1)))
    const again = w.relaunch()
    again.rig.script({})
    const out = await again.run('b')
    assert.equal(again.rig.calls.length, 0, 'no call')
    assert.equal(out.outcome, 'faulted')
    const faults = faultsOf(again.rig)
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'role')
    assert.ok(heldOf(stateOf(again.rig)).has('b'))
    assert.equal(approvals(again.rig).length, 0)
  })

  test('a relaunch resumes a reviewer cut off mid-review in its own session and dispatches no producer round', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [done()], [REV(1)]: [stopped()] })
    const k = killer()
    w.leg({ sleep: k.sleep }).run('b').catch(() => {})
    await k.reached
    const cut = startsOf(w.rig, 'reviewer', 'b')[0]
    assert.ok(cut, 'the first run called the reviewer')
    const again = w.relaunch()
    again.rig.script({ [REV(1)]: [verdict()] })
    const out = await again.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.review_rounds, 1)
    assert.equal(out.round, 1)
    assert.equal(again.rig.calls.length, 1, "the relaunch's only call is the reviewer's")
    const [call] = again.rig.calls
    assert.equal(call.role.name, 'reviewer')
    assert.equal(call.dispatch, cut.dispatch)
    assert.equal(call.resume, true)
    assert.equal(call.thread.session, cut.thread.session)
    assert.equal(call.brief, renderMessage({ msg: 'cut_off' }))
    assert.equal(approvals(again.rig).length, 1)
    assert.equal(approvals(again.rig)[0].review_rounds, 1)
  })
})
