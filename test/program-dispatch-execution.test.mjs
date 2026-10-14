// test/program-dispatch-execution.test.mjs — pins dispatch inside an execution: a context whose dir and
// execution come from the execution, a thread's session minted from its owner, a raise that starts the
// thread's next session, a resumed call's tier, the prompt composed from the thread brief and the
// messages waiting, one delivery per node, thread, round and kind, `brief_changed`, a failed return's
// cause, `threadOf`, `stepped`, and `scoped` (prefixed thread names and step keys over one log and one
// set of slots), through to the rule program reading its journal through `stepped`.
//
// Design: docs/DESIGN.md#conversations, docs/DESIGN.md#the-agent-runner, docs/DESIGN.md#programs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { recordApproval } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { renderMessage } from '../lib/conversation.mjs'
import { executionLog, readLog, runLog } from '../lib/ledger.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import {
  deliver, dispatch, programContext, scoped, step, stepped, threadOf,
} from '../lib/programs/common.mjs'
import { rule } from '../lib/programs/rule.mjs'
import { respecBrief } from '../lib/respec.mjs'
import { loadRole, tierFor } from '../lib/roles.mjs'
import { dispatchedEntry } from '../lib/runner.mjs'
import { dispatchKey, executionDir, returnPath, runDir, sessionOf, specPath } from '../lib/store.mjs'
import { programRig } from './harness/program-rig.mjs'
import { scriptedRunner } from './fast/harness/scripted-runner.mjs'

const E = 'e1'
const STAMP = '20261005-120000'
const BRIEF = 'Find where the store writes its return files.'
const TB = 'THREAD-BRIEF: the whole charge of the plan thread.'
const TB1 = 'THREAD-BRIEF one: the charge as first briefed.'
const TB2 = 'THREAD-BRIEF two: the charge as it reads now.'
const CUT_OFF = () => renderMessage({ msg: 'cut_off' })

const scoutOut = () => ({ hits: [{ ask: ['plan'], path: 'lib/store.mjs', line: 12, note: 'there' }], dismissed: [], leads: [], asks: [] })
const ONE = [{ output: scoutOut() }]
const TWO = [{ output: scoutOut() }, { output: scoutOut() }]
const THREE = [{ output: scoutOut() }, { output: scoutOut() }, { output: scoutOut() }]

/** The scripted runner's key of one start: `role|node|thread`. */
const K = (node, thread) => 'scout|' + node + '|' + thread

/** A call with no `brief`: the dispatch composes its prompt. */
const target = (over = {}) => ({ role: 'scout', schema: 'search_repo', thread: 'plan', node: 'a', threadBrief: TB, ...over })
const spec = (over = {}) => ({ ...target(), brief: BRIEF, ...over })

// --- worlds ----------------------------------------------------------------------------------

/** An execution's context over a rig: its log port, its scripted runner, its dir and stamp. */
function bootAt(rig, script, over = {}) {
  const log = executionLog(rig.repo, E, STAMP)
  const runner = scriptedRunner(script, { log, now: rig.ctx.now })
  const ctx = programContext({
    ...rig.ctx, log, runAgent: runner.runAgent, dir: executionDir(rig.repo, E, STAMP), execution: STAMP, ...over,
  })
  return { rig, log, ctx, runner, calls: runner.calls, relaunch: (next = {}, more = {}) => bootAt(rig, next, more) }
}

function world(t, { script = {} } = {}) {
  const rig = programRig({ effort: E })
  t.after(() => rig.cleanup())
  return bootAt(rig, script)
}

/** The same context with another runner: a call that dies before or after it started. */
const withAgent = (w, runAgent) => programContext({ ...w.ctx, runAgent })
const dies = () => { throw new Error('killed before the call started') }
const diesStarted = (log, pid = 4242) => async (call) => {
  log.append('dispatched', dispatchedEntry(call, { pid, session: call.thread.session }))
  throw new Error('killed after the call started')
}

const ofKind = (w, kind) => w.log.entries().filter((e) => e.kind === kind)
const messages = (w, thread = 'plan') => ofKind(w, 'message').filter((e) => e.thread === thread)
const briefChanges = (w, thread = 'plan') => messages(w, thread).filter((e) => e.msg === 'brief_changed')
const dispatchedOf = (w, key) => ofKind(w, 'dispatched').filter((e) => e.dispatch === key)
const renewals = (w, thread = 'plan') => ofKind(w, 'thread_renewed').filter((e) => e.thread === thread)
const keyOf = ({ node = 'a', thread = 'plan', round = 1 } = {}) => dispatchKey({ node, role: 'scout', thread, round })
const ids = ({ node = 'a', thread = 'plan' } = {}) => ({ effort: E, execution: STAMP, node, role: 'scout', thread })

/** A message from code, recorded on the log the way a boundary does; its seq. */
const note = (w, { node = 'a', thread = 'plan', msg, payload, round }) =>
  w.log.append('message', { node, thread, from: 'code', msg, payload, round }).seq

const failuresPayload = (tag) => ({ source: 'verification', failures: [{ check: 'check-' + tag, claim: 'claim-' + tag }] })
const findingsPayload = (tag) => ({ findings: [{ id: 'F-' + tag, severity: 'major', claim: 'finding-claim-' + tag, evidence: 'ev-' + tag }] })
const failuresText = (tag) => renderMessage({ msg: 'failures', payload: failuresPayload(tag) })
const findingsText = (tag) => renderMessage({ msg: 'findings', payload: findingsPayload(tag) })

/** Every text is in `text`, the first before the second, and so on. */
function assertInOrder(text, parts, label) {
  let at = -1
  for (const p of parts) {
    const i = text.indexOf(p, at + 1)
    assert.ok(i > at, label + ': ' + JSON.stringify(p.slice(0, 40)) + ' is missing or out of order')
    at = i
  }
}

const tick = () => new Promise((r) => setImmediate(r))
async function until(pred, label) {
  for (let i = 0; i < 5000; i++) {
    if (pred()) return
    await tick()
  }
  assert.fail('never reached: ' + label)
}
async function quiet(n = 50) { for (let i = 0; i < n; i++) await tick() }

/** A runAgent that holds each call at a gate until the test opens it, counting the calls in flight. */
function gated(inner) {
  const g = { inFlight: 0, peak: 0, waiting: [] }
  g.runAgent = async (call) => {
    g.inFlight++
    g.peak = Math.max(g.peak, g.inFlight)
    try {
      await new Promise((r) => g.waiting.push(r))
      return await inner(call)
    } finally {
      g.inFlight--
    }
  }
  g.openAll = () => g.waiting.splice(0).forEach((r) => r())
  return g
}

// --- the context -----------------------------------------------------------------------------

test('an execution context stores each return under its dir', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: ONE } })
  const dir = executionDir(w.rig.repo, E, STAMP)
  assert.equal(w.ctx.dir, dir)
  assert.equal(w.ctx.execution, STAMP)
  const r = await dispatch(w.ctx, spec())
  assert.equal(r.status, 'returned')
  assert.equal(w.calls[0].dir, dir)
  assert.ok(existsSync(returnPath(dir, r.dispatch)), 'the stored return is under the execution')
  assert.ok(!existsSync(returnPath(runDir(w.rig.repo, w.rig.run), r.dispatch)), 'nothing is stored under the run')
})

test('an execution context mints each session from its execution', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: ONE } })
  const r = await dispatch(w.ctx, spec())
  const mine = sessionOf({ ...ids(), gen: 0 })
  assert.equal(w.calls[0].thread.session, mine)
  assert.equal(w.calls[0].thread.nextSession, sessionOf({ ...ids(), gen: 1 }))
  assert.equal(r.session, mine)
  assert.notEqual(mine, sessionOf({ ...ids(), execution: w.rig.run, gen: 0 }), 'not the run\'s')
})

test('a context given no dir or execution runs in the run directory and mints sessions from the run', async (t) => {
  const rig = programRig({ effort: E })
  t.after(() => rig.cleanup())
  const log = runLog(rig.repo, rig.run)
  const runner = scriptedRunner({ [K('a', 'plan')]: ONE }, { log, now: rig.ctx.now })
  const ctx = programContext({
    repo: rig.repo, run: rig.run, effort: E, log, runAgent: runner.runAgent, now: rig.ctx.now, sleep: rig.ctx.sleep, env: {},
  })
  assert.equal(ctx.dir, runDir(rig.repo, rig.run))
  assert.equal(ctx.execution, rig.run)
  assert.equal(ctx.prefix, '')
  const r = await dispatch(ctx, spec())
  assert.equal(r.status, 'returned')
  assert.equal(runner.calls[0].dir, runDir(rig.repo, rig.run))
  assert.equal(runner.calls[0].thread.session, sessionOf({ ...ids(), execution: rig.run, gen: 0 }))
})

// --- sessions from the owner -----------------------------------------------------------------

async function sharedThread(t) {
  const w = world(t, { script: { [K('red', 'producer:red')]: ONE, [K('green', 'producer:red')]: ONE } })
  const red = await dispatch(w.ctx, spec({ node: 'red', thread: 'producer:red' }))
  const green = await dispatch(w.ctx, spec({ node: 'green', owner: 'red', thread: 'producer:red', brief: 'Again.' }))
  return { w, red, green }
}

test('two dispatches on one thread from two nodes with one owner run in one session', async (t) => {
  const { w, red, green } = await sharedThread(t)
  const redsSession = sessionOf({ ...ids({ node: 'red', thread: 'producer:red' }), gen: 0 })
  assert.equal(red.status, 'returned')
  assert.equal(green.status, 'returned')
  assert.equal(w.calls[0].thread.session, redsSession)
  assert.equal(w.calls[1].thread.session, redsSession)
  assert.equal(red.session, redsSession)
  assert.equal(green.session, redsSession)
  assert.equal(w.calls[0].resume, false)
  assert.equal(w.calls[1].resume, true)
  assert.notEqual(redsSession, sessionOf({ ...ids({ node: 'green', thread: 'producer:red' }), gen: 0 }), 'the green\'s own session is not used')
})

test('each dispatch on a shared thread is recorded on its own node', async (t) => {
  const { w, red, green } = await sharedThread(t)
  assert.equal(red.dispatch, keyOf({ node: 'red', thread: 'producer:red' }))
  assert.equal(green.dispatch, keyOf({ node: 'green', thread: 'producer:red' }))
  assert.notEqual(red.dispatch, green.dispatch)
  assert.equal(w.calls[0].node, 'red')
  assert.equal(w.calls[1].node, 'green')
  const [onRed] = dispatchedOf(w, red.dispatch)
  const [onGreen] = dispatchedOf(w, green.dispatch)
  assert.equal(onRed.node, 'red')
  assert.equal(onGreen.node, 'green')
  assert.equal(onRed.execution, STAMP)
  assert.equal(onGreen.execution, STAMP)
})

// --- a raise ---------------------------------------------------------------------------------

const T_LOW = { model: 'sonnet', effort: 'medium' }
const T_FIRST = { model: 'opus', effort: 'xhigh' }
const T_RAISED = { model: 'opus', effort: 'high' }
const T_OTHER = { model: 'sonnet', effort: 'low' }
const tierOf = (call) => [call.tier.model, call.tier.effort]
const tierPair = (tier) => [tier.model, tier.effort]

test('a raised call records thread_renewed raised before it starts', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: TWO } })
  await dispatch(w.ctx, spec({ round: 1 }))
  const r2 = await dispatch(w.ctx, spec({ round: 2, fresh: 'raised', brief: 'Redo.' }))
  assert.equal(r2.status, 'returned')
  const renewed = renewals(w)
  assert.equal(renewed.length, 1)
  assert.equal(renewed[0].gen, 1)
  assert.equal(renewed[0].why, 'raised')
  const started = dispatchedOf(w, r2.dispatch)
  assert.ok(started.length > 0)
  assert.ok(renewed[0].seq < Math.min(...started.map((e) => e.seq)), 'the renewal comes before round 2 started')
})

test('a raised call runs in a new session', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: TWO } })
  await dispatch(w.ctx, spec({ round: 1 }))
  const r2 = await dispatch(w.ctx, spec({ round: 2, fresh: 'raised', brief: 'Redo.' }))
  const [first, raised] = w.calls
  assert.equal(first.thread.gen, 0)
  assert.equal(first.thread.session, sessionOf({ ...ids(), gen: 0 }))
  assert.equal(raised.resume, false)
  assert.equal(raised.thread.gen, 1)
  assert.equal(raised.thread.session, sessionOf({ ...ids(), gen: 1 }))
  assert.notEqual(raised.thread.session, first.thread.session)
  assert.equal(raised.thread.nextSession, sessionOf({ ...ids(), gen: 2 }))
  assert.equal(r2.session, raised.thread.session)
  const now = threadOf(w.ctx, { role: 'scout', node: 'a', thread: 'plan' })
  assert.equal(now.gen, 1)
  assert.equal(now.session, raised.thread.session)
})

test('the next resume of a raised thread runs in the raised session at the raised tier', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: THREE } })
  await dispatch(w.ctx, spec({ round: 1, tier: T_LOW }))
  await dispatch(w.ctx, spec({ round: 2, fresh: 'raised', brief: 'Redo.', tier: T_RAISED }))
  const r3 = await dispatch(w.ctx, spec({ round: 3, brief: 'Go on.', tier: T_OTHER }))
  assert.equal(r3.status, 'returned')
  const call = w.calls[2]
  assert.equal(call.resume, true)
  assert.equal(call.thread.session, sessionOf({ ...ids(), gen: 1 }))
  assert.deepEqual(tierOf(call), tierPair(T_RAISED))
  assert.equal(renewals(w).length, 1, 'no second renewal')
})

test('a raised call cut off before it started renews its thread once', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: ONE } })
  await dispatch(w.ctx, spec({ round: 1 }))
  await assert.rejects(dispatch(withAgent(w, dies), spec({ round: 2, fresh: 'raised', brief: 'Redo.' })))

  const again = w.relaunch({ [K('a', 'plan')]: ONE })
  const r = await dispatch(again.ctx, spec({ round: 2, fresh: 'raised', brief: 'Redo.' }))
  assert.equal(r.status, 'returned')
  assert.equal(renewals(again).length, 1)
  assert.equal(again.calls.length, 1)
  assert.equal(again.calls[0].resume, false)
  assert.equal(again.calls[0].thread.gen, 1)
  assert.equal(again.calls[0].thread.session, sessionOf({ ...ids(), gen: 1 }))
})

test('a raised call cut off after it started resumes in the raised session with the cut_off brief', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: ONE } })
  await dispatch(w.ctx, spec({ round: 1 }))
  const raise = spec({ round: 2, fresh: 'raised', brief: 'Redo.', tier: T_RAISED })
  await assert.rejects(dispatch(withAgent(w, diesStarted(w.log)), raise))

  const again = w.relaunch({ [K('a', 'plan')]: ONE })
  const r = await dispatch(again.ctx, raise)
  assert.equal(r.status, 'returned')
  assert.equal(renewals(again).length, 1)
  const [call] = again.calls
  assert.equal(call.resume, true)
  assert.equal(call.brief, CUT_OFF())
  assert.equal(call.thread.session, sessionOf({ ...ids(), gen: 1 }))
  assert.deepEqual(tierOf(call), tierPair(T_RAISED))
})

// --- tiers -----------------------------------------------------------------------------------

test("a resumed call runs at the tier of the thread's latest dispatched, whatever tier it is given", async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: THREE } })
  await dispatch(w.ctx, spec({ round: 1, tier: T_LOW }))
  await dispatch(w.ctx, spec({ round: 2, brief: 'Go on.', tier: T_FIRST }))
  await dispatch(w.ctx, spec({ round: 3, brief: 'Go on.' }))
  assert.deepEqual(tierOf(w.calls[0]), tierPair(T_LOW))
  assert.deepEqual(tierOf(w.calls[1]), tierPair(T_LOW))
  assert.deepEqual(tierOf(w.calls[2]), tierPair(T_LOW))
})

test('a first call and a raised call run at the tier they are given', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: THREE, [K('a', 'other')]: ONE } })
  const base = tierFor(loadRole('scout').role)
  for (const given of [T_FIRST, T_RAISED]) assert.notDeepEqual(tierPair(base), tierPair(given), 'the role\'s own tier must differ from a given one')

  await dispatch(w.ctx, spec({ round: 1, tier: T_FIRST }))
  await dispatch(w.ctx, spec({ round: 2, fresh: 'raised', brief: 'Redo.', tier: T_RAISED }))
  await dispatch(w.ctx, spec({ round: 3, fresh: 'raised', brief: 'Redo.' }))
  await dispatch(w.ctx, spec({ thread: 'other' }))
  assert.deepEqual(tierOf(w.calls[0]), tierPair(T_FIRST))
  assert.deepEqual(tierOf(w.calls[1]), tierPair(T_RAISED))
  assert.deepEqual(tierOf(w.calls[2]), tierPair(base), 'a raised call given none runs at the role\'s tier')
  assert.deepEqual(tierOf(w.calls[3]), tierPair(base), 'a first call given none runs at the role\'s tier')
})

// --- composed prompts ------------------------------------------------------------------------

test('a first call given no brief is briefed with the thread brief and every waiting message', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: ONE } })
  const s1 = note(w, { msg: 'failures', payload: failuresPayload('one'), round: 1 })
  const s2 = note(w, { msg: 'findings', payload: findingsPayload('two'), round: 1 })
  note(w, { thread: 'other', msg: 'findings', payload: findingsPayload('stranger'), round: 1 })
  const r = await dispatch(w.ctx, target({ round: 1 }))
  assert.equal(r.status, 'returned')
  const [call] = w.calls
  assert.equal(call.resume, false)
  assert.ok(call.brief.startsWith(TB), 'starts with the thread brief')
  assertInOrder(call.brief, [TB, failuresText('one'), findingsText('two')], 'the brief')
  assert.ok(!call.brief.includes(findingsText('stranger')), 'no other thread\'s message')
  assert.deepEqual(call.carries, [s1, s2])
})

test('a raised call given no brief is briefed with the thread brief and every waiting message', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: TWO } })
  await dispatch(w.ctx, spec({ round: 1 }))
  const s = note(w, { msg: 'failures', payload: failuresPayload('raise'), round: 2 })
  const r = await dispatch(w.ctx, target({ round: 2, fresh: 'raised' }))
  assert.equal(r.status, 'returned')
  const call = w.calls[1]
  assert.equal(call.resume, false)
  assert.ok(call.brief.startsWith(TB), 'starts with the thread brief')
  assertInOrder(call.brief, [TB, failuresText('raise')], 'the brief')
  assert.deepEqual(call.carries, [s])
})

test('a raised call given no brief is also briefed with the messages an earlier call carried', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: TWO } })
  const s1 = note(w, { msg: 'findings', payload: findingsPayload('carried'), round: 1 })
  await dispatch(w.ctx, target({ round: 1 }))
  const s2 = note(w, { msg: 'failures', payload: failuresPayload('raise'), round: 2 })
  const r = await dispatch(w.ctx, target({ round: 2, fresh: 'raised' }))
  assert.equal(r.status, 'returned')
  const call = w.calls[1]
  assert.equal(call.resume, false)
  assertInOrder(call.brief, [TB, findingsText('carried'), failuresText('raise')], 'the brief')
  assert.deepEqual(call.carries, [s1, s2])
})

test('a resumed call given no brief is briefed with the waiting messages alone', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: TWO } })
  note(w, { msg: 'findings', payload: findingsPayload('carried'), round: 1 })
  await dispatch(w.ctx, target({ round: 1 }))
  const s1 = note(w, { msg: 'failures', payload: failuresPayload('one'), round: 2 })
  const s2 = note(w, { msg: 'findings', payload: findingsPayload('two'), round: 2 })
  note(w, { thread: 'other', msg: 'findings', payload: findingsPayload('stranger'), round: 2 })
  const r = await dispatch(w.ctx, target({ round: 2 }))
  assert.equal(r.status, 'returned')
  const call = w.calls[1]
  assert.equal(call.resume, true)
  assertInOrder(call.brief, [failuresText('one'), findingsText('two')], 'the brief')
  assert.ok(!call.brief.includes(TB), 'not the thread brief')
  assert.ok(!call.brief.includes(findingsText('carried')), 'not a message an earlier dispatched carried')
  assert.ok(!call.brief.includes(findingsText('stranger')), 'no other thread\'s message')
  assert.deepEqual(call.carries, [s1, s2])
})

test('a resumed call given no brief with nothing waiting throws', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: TWO } })
  await dispatch(w.ctx, spec({ round: 1 }))
  await assert.rejects(dispatch(w.ctx, target({ round: 2 })))
  assert.equal(w.calls.length, 1, 'no call is made')
  assert.equal(dispatchedOf(w, keyOf({ round: 2 })).length, 0)
})

// --- two messages in one round ---------------------------------------------------------------

const DELIVERY = () => ({ ...target(), msg: 'findings', payload: findingsPayload('delivered'), round: 2 })

/** Round 1 returned, a `failures` message recorded for round 2, then `findings` delivered for round 2. */
async function twoInOneRound(t) {
  const w = world(t, { script: { [K('a', 'plan')]: TWO } })
  await dispatch(w.ctx, spec({ round: 1 }))
  const failuresSeq = note(w, { msg: 'failures', payload: failuresPayload('both'), round: 2 })
  return { w, failuresSeq }
}

test('two messages to one thread in one round are delivered together, once', async (t) => {
  const { w, failuresSeq } = await twoInOneRound(t)
  const out = await deliver(w.ctx, DELIVERY())
  assert.equal(out.status, 'returned')
  assert.equal(w.calls.length, 2, 'one call for the round')
  const findingsSeq = messages(w).find((m) => m.msg === 'findings').seq
  const call = w.calls[1]
  assert.deepEqual([...call.carries].sort((a, b) => a - b), [failuresSeq, findingsSeq].sort((a, b) => a - b))
  assert.ok(call.brief.includes(failuresText('both')))
  assert.ok(call.brief.includes(findingsText('delivered')))
  assert.equal(messages(w).length, 2)
})

test('a relaunch after the round returned delivers neither message again', async (t) => {
  const { w } = await twoInOneRound(t)
  const first = await deliver(w.ctx, DELIVERY())
  const again = w.relaunch({})
  const out = await deliver(again.ctx, DELIVERY())
  assert.equal(again.calls.length, 0, 'no call')
  assert.equal(out.replayed, true)
  assert.equal(out.dispatch, first.dispatch)
  assert.equal(messages(again).length, 2)
})

test('a relaunch after the round was cut off resumes it without delivering either message again', async (t) => {
  const { w } = await twoInOneRound(t)
  await assert.rejects(deliver(withAgent(w, diesStarted(w.log)), DELIVERY()))
  const again = w.relaunch({ [K('a', 'plan')]: ONE })
  const out = await deliver(again.ctx, DELIVERY())
  assert.equal(out.status, 'returned')
  assert.equal(again.calls.length, 1)
  const [call] = again.calls
  assert.equal(call.resume, true)
  assert.equal(call.brief, CUT_OFF())
  assert.ok(!call.brief.includes(failuresText('both')))
  assert.ok(!call.brief.includes(findingsText('delivered')))
  assert.equal(messages(again).length, 2)
})

// --- deliver ---------------------------------------------------------------------------------

test('deliver records a message once per node, thread, round and msg', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: ONE } })
  const body = { ...target(), msg: 'findings', round: 1 }
  const first = await deliver(w.ctx, { ...body, payload: findingsPayload('first') })
  const second = await deliver(w.ctx, { ...body, payload: findingsPayload('second') })
  assert.equal(first.status, 'returned')
  assert.equal(second.status, 'returned')
  const held = messages(w).filter((m) => m.msg === 'findings' && m.node === 'a' && m.round === 1)
  assert.equal(held.length, 1)
  assert.deepEqual(held[0].payload, findingsPayload('first'), 'the message recorded first stands')
})

test('a message recorded without a node reads as the empty node', async (t) => {
  const rig = programRig({ effort: E, script: { 'scout||plan': ONE, [K('a', 'plan')]: ONE } })
  t.after(() => rig.cleanup())
  const legacy = () => rig.log.append('message', { thread: 'plan', from: 'code', msg: 'findings', payload: findingsPayload('old'), round: 1 })
  legacy()
  await deliver(rig.ctx, { ...target({ node: '' }), msg: 'findings', payload: findingsPayload('old'), round: 1 })
  const held = () => rig.log.entries().filter((e) => e.kind === 'message' && e.thread === 'plan' && e.msg === 'findings' && e.round === 1)
  assert.equal(held().length, 1, 'the empty node already holds it')

  const other = programRig({ effort: E, script: { [K('a', 'plan')]: ONE } })
  t.after(() => other.cleanup())
  other.log.append('message', { thread: 'plan', from: 'code', msg: 'findings', payload: findingsPayload('old'), round: 1 })
  await deliver(other.ctx, { ...target({ node: 'a' }), msg: 'findings', payload: findingsPayload('old'), round: 1 })
  const both = other.log.entries().filter((e) => e.kind === 'message' && e.thread === 'plan' && e.msg === 'findings' && e.round === 1)
  assert.equal(both.length, 2, 'node a is not the empty node')
})

test('two kinds of message to one thread in one round both land', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: ONE } })
  await deliver(w.ctx, { ...target(), msg: 'findings', payload: findingsPayload('x'), round: 1 })
  await deliver(w.ctx, { ...target(), msg: 'failures', payload: failuresPayload('y'), round: 1 })
  assert.deepEqual(messages(w).map((m) => m.msg).sort(), ['failures', 'findings'])
})

test('the same message to one thread and round for another node lands', async (t) => {
  const w = world(t, { script: { [K('green', 'producer:red')]: ONE, [K('blue', 'producer:red')]: ONE } })
  const base = { ...target({ thread: 'producer:red', owner: 'red' }), msg: 'findings', payload: findingsPayload('same'), round: 1 }
  const green = await deliver(w.ctx, { ...base, node: 'green' })
  const blue = await deliver(w.ctx, { ...base, node: 'blue' })
  assert.equal(green.status, 'returned')
  assert.equal(blue.status, 'returned')
  assert.deepEqual(messages(w, 'producer:red').map((m) => m.node).sort(), ['blue', 'green'])
})

test("a delivered message names the dispatch's node", async (t) => {
  const w = world(t, { script: { [K('n1', 'plan')]: ONE, 'scout||plan': ONE } })
  const payload = findingsPayload('named')
  await deliver(w.ctx, { ...target({ node: 'n1' }), msg: 'findings', payload, round: 3 })
  const [m] = messages(w)
  assert.equal(m.node, 'n1')
  assert.equal(m.thread, 'plan')
  assert.equal(m.from, 'code')
  assert.equal(m.msg, 'findings')
  assert.deepEqual(m.payload, payload)
  assert.equal(m.round, 3)
  assert.equal(m.execution, STAMP)
  const onDisk = readLog(w.rig.repo, E, 'events').entries.filter((e) => e.kind === 'message' && e.execution === STAMP)
  assert.equal(onDisk.length, 1, 'the record lands on the effort\'s event log')
  assert.equal(onDisk[0].node, 'n1')

  const { node, ...noNode } = target()
  await deliver(w.ctx, { ...noNode, msg: 'findings', payload, round: 3 })
  const empty = messages(w).filter((e) => e.node === '')
  assert.equal(empty.length, 1, 'a delivery with no node is recorded under the empty node')
})

// --- brief_changed ---------------------------------------------------------------------------

const parts = (headings) => Object.fromEntries(Object.entries(headings).map(([h, text]) => [h, fnv1a(text)]))
const P1 = parts({ Goal: 'g1', Rules: 'r1', Old: 'o1' })
const P2 = parts({ Goal: 'g1', Rules: 'r2', New: 'n1' })
const CHANGED = ['New', 'Old', 'Rules']
const sorted = (list) => [...list].sort()

/** Round 1 with the first brief and parts, then round 2 composed with the changed ones. */
async function briefMoved(t) {
  const w = world(t, { script: { [K('a', 'plan')]: TWO } })
  await dispatch(w.ctx, spec({ round: 1, threadBrief: TB1, briefParts: P1 }))
  const r2 = await dispatch(w.ctx, target({ round: 2, threadBrief: TB2, briefParts: P2 }))
  assert.equal(r2.status, 'returned')
  return { w, r2 }
}

test('resuming a thread whose brief changed records brief_changed', async (t) => {
  const { w } = await briefMoved(t)
  const found = briefChanges(w)
  assert.equal(found.length, 1)
  const [m] = found
  assert.equal(m.node, 'a')
  assert.equal(m.thread, 'plan')
  assert.equal(m.from, 'code')
  assert.equal(m.round, 2)
  assert.equal(m.payload.brief, TB2)
})

test('brief_changed names the headings whose digest differs', async (t) => {
  const { w } = await briefMoved(t)
  assert.deepEqual(sorted(briefChanges(w)[0].payload.changed), CHANGED)
})

test('brief_changed is delivered by the resumed call', async (t) => {
  const { w, r2 } = await briefMoved(t)
  const [m] = briefChanges(w)
  const call = w.calls[1]
  assert.equal(call.resume, true)
  assert.ok(call.brief.includes(renderMessage({ msg: 'brief_changed', payload: m.payload })))
  assert.deepEqual(call.carries, [m.seq])
  const [second] = dispatchedOf(w, r2.dispatch)
  assert.deepEqual(second.brief_parts, P2)
  assert.equal(second.brief_digest, fnv1a(TB2))
  const [first] = dispatchedOf(w, keyOf({ round: 1 }))
  assert.deepEqual(first.brief_parts, P1)
  assert.equal(first.brief_digest, fnv1a(TB1))
})

test('brief_changed is recorded once', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: ONE } })
  await dispatch(w.ctx, spec({ round: 1, threadBrief: TB1, briefParts: P1 }))
  const moved = target({ round: 2, threadBrief: TB2, briefParts: P2 })
  await assert.rejects(dispatch(withAgent(w, dies), moved))
  assert.equal(briefChanges(w).length, 1, 'recorded before the call died')

  const again = w.relaunch({ [K('a', 'plan')]: TWO })
  const r2 = await dispatch(again.ctx, moved)
  assert.equal(r2.status, 'returned')
  const [m] = briefChanges(again)
  assert.equal(briefChanges(again).length, 1, 'the relaunch records none again')
  assert.deepEqual(again.calls[0].carries, [m.seq], 'the call not yet started delivers it')

  await dispatch(again.ctx, spec({ round: 3, threadBrief: TB2, briefParts: P2, brief: 'Go on.' }))
  assert.equal(briefChanges(again).length, 1, 'a later round on the same brief records none')
})

test('a cut-off call whose brief changed is resumed with brief_changed instead of cut_off', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: ONE } })
  await dispatch(w.ctx, spec({ round: 1, threadBrief: TB1, briefParts: P1 }))
  await assert.rejects(dispatch(withAgent(w, diesStarted(w.log)), spec({ round: 2, threadBrief: TB1, briefParts: P1, brief: 'Go on.' })))
  assert.equal(briefChanges(w).length, 0)

  const again = w.relaunch({ [K('a', 'plan')]: ONE })
  const out = await dispatch(again.ctx, spec({ round: 2, threadBrief: TB2, briefParts: P2, brief: 'Go on.' }))
  assert.equal(out.status, 'returned')
  const found = briefChanges(again)
  assert.equal(found.length, 1)
  assert.equal(found[0].round, 2)
  assert.equal(found[0].node, 'a')
  assert.deepEqual(sorted(found[0].payload.changed), CHANGED)
  const [call] = again.calls
  assert.equal(call.resume, true)
  assert.equal(call.brief, renderMessage({ msg: 'brief_changed', payload: found[0].payload }))
  assert.notEqual(call.brief, CUT_OFF())
  assert.deepEqual(call.carries, [found[0].seq])
})

test('without briefParts a cut-off call is resumed with cut_off though its brief changed', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: ONE } })
  await dispatch(w.ctx, spec({ round: 1, threadBrief: TB1 }))
  await assert.rejects(dispatch(withAgent(w, diesStarted(w.log)), spec({ round: 2, threadBrief: TB1, brief: 'Go on.' })))
  const again = w.relaunch({ [K('a', 'plan')]: ONE })
  const out = await dispatch(again.ctx, spec({ round: 2, threadBrief: TB2, brief: 'Go on.' }))
  assert.equal(out.status, 'returned')
  assert.equal(again.calls[0].resume, true)
  assert.equal(again.calls[0].brief, CUT_OFF())
  assert.equal(briefChanges(again).length, 0)
})

test('without briefParts a resumed thread whose brief changed records no brief_changed', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: TWO } })
  await dispatch(w.ctx, spec({ round: 1, threadBrief: TB1, briefParts: P1 }))
  const r2 = await dispatch(w.ctx, spec({ round: 2, threadBrief: TB2, brief: 'Go on.' }))
  assert.equal(r2.status, 'returned')
  assert.equal(briefChanges(w).length, 0)
})

test('a resumed thread whose brief is unchanged records no brief_changed', async (t) => {
  const w = world(t, { script: { [K('a', 'plan')]: TWO } })
  await dispatch(w.ctx, spec({ round: 1, threadBrief: TB1, briefParts: P1 }))
  const r2 = await dispatch(w.ctx, spec({ round: 2, threadBrief: TB1, briefParts: P1, brief: 'Go on.' }))
  assert.equal(r2.status, 'returned')
  assert.equal(briefChanges(w).length, 0)
})

// --- a failed return -------------------------------------------------------------------------

test("a failed return's cause falls back to its status", async (t) => {
  const w = world(t)
  const returning = (out) => withAgent(w, async () => out)
  const cutOff = await dispatch(returning({ status: 'cut_off' }), spec({ thread: 'one' }))
  const blank = await dispatch(returning({ status: 'failed', cause: '' }), spec({ thread: 'two' }))
  const named = await dispatch(returning({ status: 'failed', cause: 'host_error' }), spec({ thread: 'three' }))
  assert.deepEqual([cutOff.status, cutOff.cause], ['failed', 'cut_off'])
  assert.deepEqual([blank.status, blank.cause], ['failed', 'failed'])
  assert.deepEqual([named.status, named.cause], ['failed', 'host_error'])
})

// --- threadOf, stepped and the rule program --------------------------------------------------

test('threadOf gives the session a dispatch runs in', async (t) => {
  const red = 'producer:red'
  const w = world(t, {
    script: { [K('red', red)]: [...ONE, { status: 'failed', cause: 'session_missing' }, ...ONE], [K('green', red)]: ONE },
  })
  const at = (node, owner) => threadOf(w.ctx, { role: 'scout', node, thread: red, ...(owner ? { owner } : {}) })
  const before = at('red')
  assert.equal(before.gen, 0)
  assert.equal(before.session, sessionOf({ ...ids({ node: 'red', thread: red }), gen: 0 }))

  await dispatch(w.ctx, spec({ node: 'red', thread: red, round: 1 }))
  const r2 = await dispatch(w.ctx, spec({ node: 'red', thread: red, round: 2, brief: 'Go on.' }))
  assert.equal(r2.status, 'returned')
  assert.equal(renewals(w, red).length, 1, 'the runner renewed the thread')

  const renewed = at('red')
  assert.equal(renewed.key, red)
  assert.equal(renewed.gen, 1)
  assert.equal(renewed.session, r2.session, 'the renewed call\'s session')
  assert.equal(renewed.session, sessionOf({ ...ids({ node: 'red', thread: red }), gen: 1 }))
  assert.equal(renewed.nextSession, sessionOf({ ...ids({ node: 'red', thread: red }), gen: 2 }))

  const owned = at('green', 'red')
  assert.equal(owned.session, r2.session, 'the session the red\'s call ran in')
  assert.equal(owned.gen, 1)
  assert.notEqual(at('green').session, r2.session, 'without an owner the node owns its thread')

  await dispatch(w.ctx, spec({ node: 'green', owner: 'red', thread: red, round: 1, brief: 'Green.' }))
  const call = w.calls.at(-1)
  for (const k of ['key', 'gen', 'session', 'nextSession']) assert.equal(call.thread[k], owned[k], k)
})

test('stepped gives the step records match accepts, oldest first', async (t) => {
  const w = world(t)
  await step(w.ctx, 'settle:1', () => 'one')
  await step(w.ctx, 'other', () => 'x')
  await step(w.ctx, 'settle:2', () => ({ n: 2 }))
  w.log.append('marker', { key: 'settle:fake', value: 'not a step' })
  await step(w.ctx, 'settle:3', () => 3)
  const got = stepped(w.ctx, (e) => e.key.startsWith('settle:'))
  assert.deepEqual(got.map((e) => [e.key, e.value]), [['settle:1', 'one'], ['settle:2', { n: 2 }], ['settle:3', 3]])
  assert.deepEqual(got.map((e) => e.seq), got.map((e) => e.seq).sort((a, b) => a - b))
  assert.equal(stepped(w.ctx, (e) => e.key === 'nothing').length, 0)
})

test("stepped under scoped gives the scope's step records by the keys the scope named", async (t) => {
  const w = world(t)
  const scope = scoped(w.ctx, 'probe:f:1')
  await step(w.ctx, 'pick', () => 'parent')
  await step(scope, 'pick', () => 'scope')
  await step(scoped(w.ctx, 'probe:g:1'), 'pick', () => 'sibling')
  const mine = stepped(scope, (e) => e.key === 'pick')
  assert.deepEqual(mine.map((e) => [e.key, e.value]), [['pick', 'scope']])
  assert.deepEqual(stepped(scope, () => true).map((e) => e.key), ['pick'], 'only the scope\'s own steps')
  assert.deepEqual(stepped(w.ctx, (e) => e.key === 'pick').map((e) => e.value), ['parent'])
})

const FIXTURES = fileURLToPath(new URL('./fixtures/compile/', import.meta.url))
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n')
const ROOT = read('root.md')
const API = read('api.md')
const WORDING = API.replace('`load(path)`, then `parse(text)`.', '`load(path)` returns a frozen object.')
const rulerSteps = (...steps) => new Proxy({}, { get: (_, key) => (String(key).startsWith('ruler||') ? steps : undefined) })

function writeSpec(repo, id, text) {
  mkdirSync(dirname(specPath(repo, E, id)), { recursive: true })
  writeFileSync(specPath(repo, E, id), text)
}

test('the rule program reads its journal through stepped', async (t) => {
  const rig = programRig({ files: { 'CLAUDE.md': 'GUIDE-MARK: a ruling names the node it rules\n' } })
  t.after(() => rig.cleanup())
  writeSpec(rig.repo, '.', ROOT)
  writeSpec(rig.repo, 'api', API)
  for (const id of ['.', 'api']) assert.equal(recordApproval(rig.repo, E, id).ok, true)
  assert.equal(compileEffort(rig.repo, E).ok, true)
  writeSpec(rig.repo, 'api', WORDING)
  const brief = respecBrief(rig.repo, E, 'api')
  assert.equal(brief.status, 'brief', JSON.stringify(brief))
  const rulings = { rulings: brief.nodes.map((node) => ({ node, ruling: 'unaffected', why: 'nothing it uses moved', question: '', fix: '' })) }

  const args = { effort: E, folder: 'api' }
  const first = await rule(scoped(rig.relaunch(rulerSteps({ output: rulings })).ctx, 'nest'), args)
  assert.equal(first.status, 'approved', JSON.stringify(first))
  const relaunched = rig.relaunch({})
  const again = await rule(scoped(relaunched.ctx, 'nest'), args)
  assert.deepEqual(again, first)
  assert.equal(relaunched.calls.length, 0, 'a settled spec dispatches nothing')
})

// --- scoped ----------------------------------------------------------------------------------

test('scoped prefixes every thread name of a dispatch', async (t) => {
  const w = world(t, { script: { [K('a', 'survey:f/plan')]: ONE } })
  const named = 'survey:f/plan'
  const r = await dispatch(scoped(w.ctx, 'survey:f'), spec())
  assert.equal(r.status, 'returned')
  const [call] = w.calls
  assert.equal(call.thread.key, named)
  assert.equal(call.thread.session, sessionOf({ ...ids({ thread: named }), gen: 0 }))
  assert.equal(call.dispatch, keyOf({ thread: named }))
  assert.equal(r.dispatch, keyOf({ thread: named }))
  assert.equal(dispatchedOf(w, r.dispatch)[0].thread, named)
})

test('scoped prefixes every step key', async (t) => {
  const w = world(t)
  const scope = scoped(w.ctx, 'survey:f')
  const ran = []
  const fn = (label) => () => { ran.push(label); return label }
  assert.equal(await step(scope, 'pick', fn('scope')), 'scope')
  assert.equal(await step(w.ctx, 'pick', fn('parent')), 'parent')
  assert.deepEqual(ran, ['scope', 'parent'], 'each ran')
  assert.deepEqual(ofKind(w, 'step').map((e) => e.key), ['survey:f/pick', 'pick'])
  assert.equal(await step(scope, 'pick', fn('again')), 'scope', 'the scope\'s own record answers')
  assert.deepEqual(ran, ['scope', 'parent'])
})

test('scoped prefixes the thread of a delivery', async (t) => {
  const w = world(t, { script: { [K('a', 'survey:f/plan')]: ONE } })
  const out = await deliver(scoped(w.ctx, 'survey:f'), { ...target(), msg: 'findings', payload: findingsPayload('scoped'), round: 1 })
  assert.equal(out.status, 'returned')
  const found = ofKind(w, 'message')
  assert.deepEqual(found.map((m) => m.thread), ['survey:f/plan'])
  assert.equal(w.calls[0].thread.key, 'survey:f/plan')
  assert.deepEqual(w.calls[0].carries, [found[0].seq])
})

test('scoped inside scoped prefixes both', async (t) => {
  const named = 'probe:f:1/survey:g/plan'
  const w = world(t, { script: { [K('a', named)]: ONE } })
  const r = await dispatch(scoped(scoped(w.ctx, 'probe:f:1'), 'survey:g'), spec())
  assert.equal(r.status, 'returned')
  assert.equal(w.calls[0].thread.key, named)
})

test('a scoped context shares the slots', { timeout: 60_000 }, async (t) => {
  const w = world(t, { script: { [K('a', 't1')]: ONE, [K('a', 's/t2')]: ONE } })
  const g = gated(w.runner.runAgent)
  const parent = programContext({ ...w.ctx, runAgent: g.runAgent, maxAgents: 1 })
  let settled = false
  const both = Promise.all([dispatch(parent, spec({ thread: 't1' })), dispatch(scoped(parent, 's'), spec({ thread: 't2' }))])
  both.then(() => { settled = true }, () => { settled = true })
  await until(() => g.waiting.length >= 1, 'a call in flight')
  await quiet()
  assert.equal(g.inFlight, 1, 'the second call waits for the one slot')
  while (!settled) { g.openAll(); await quiet(5) }
  const results = await both
  assert.equal(g.peak, 1)
  for (const r of results) assert.equal(r.status, 'returned')
})
