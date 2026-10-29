// test/program-dispatch.test.mjs — pins the dispatch layer every program runs on: the context, what a
// call carries to the runner, reading the stored return, replay and cut-off resume on relaunch, host
// stops and the agent slots, steps, delivered messages, the coverage block, the
// wait after a host stop, and judges kept apart from every producer.
//
// Design: docs/DESIGN.md#programs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { renderMessage } from '../lib/conversation.mjs'
import { readOnlyPermissions } from '../lib/permissions.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import {
  briefRoomOf, coverageOf, deliver, dispatch, dispatchJudge, programContext, step, waitFor,
} from '../lib/programs/common.mjs'
import { loadRole, tierFor } from '../lib/roles.mjs'
import { dispatchedEntry } from '../lib/runner.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { dispatchKey, returnPath, runDir, sessionOf } from '../lib/store.mjs'
import { programRig } from './harness/program-rig.mjs'

const UNTIL = '2026-01-01T00:05:00Z'
const BRIEF = 'Find where the store writes its return files.'
const KEY = 'scout||plan'

function rigFor(t, opts) {
  const rig = programRig(opts)
  t.after(() => rig.cleanup())
  return rig
}

const spec = (over = {}) => ({ role: 'scout', schema: 'search', thread: 'plan', brief: BRIEF, ...over })
const hit = (path, line) => ({ ask: ['plan'], path, line, note: 'there' })
const scoutOut = ({ hits = [hit('lib/store.mjs', 12)] } = {}) => ({ hits, dismissed: [], leads: [], asks: [] })

const sessionFor = (rig, { thread = 'plan', node = '', role = 'scout', gen = 0 } = {}) =>
  sessionOf({ effort: rig.ctx.effort, execution: rig.run, node, role, thread, gen })
const keyFor = ({ thread = 'plan', node = '', role = 'scout', round = 1 } = {}) => dispatchKey({ node, role, thread, round })
const ofKind = (rig, kind) => rig.log.entries().filter((e) => e.kind === kind)
const CUT_OFF = () => renderMessage({ msg: 'cut_off' })

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

test('the context holds six agents at once by default', { timeout: 60_000 }, async (t) => {
  const threads = ['t1', 't2', 't3', 't4', 't5', 't6', 't7']
  const rig = rigFor(t, { script: Object.fromEntries(threads.map((th) => ['scout||' + th, [{ output: scoutOut() }]])) })
  const g = gated(rig.ctx.runAgent)
  const ctx = programContext({ intelligence: 'normal', repo: rig.repo, run: rig.run, log: rig.log, runAgent: g.runAgent, now: rig.ctx.now, sleep: rig.ctx.sleep, env: {} })
  assert.equal(ctx.maxAgents, 6)
  let settled = false
  const all = Promise.all(threads.map((thread) => dispatch(ctx, spec({ thread }))))
  all.then(() => { settled = true }, () => { settled = true })
  await until(() => g.waiting.length === 6, 'six calls in flight')
  await quiet()
  assert.equal(g.inFlight, 6, 'a seventh waits for a slot')
  while (!settled) { g.openAll(); await quiet(5) }
  const results = await all
  assert.equal(g.peak, 6)
  for (const r of results) assert.equal(r.status, 'returned')
})

// --- a first call ----------------------------------------------------------------------------

async function firstCall(t, { over = {}, rigOpts = {}, ctxOver = null, key = KEY } = {}) {
  const rig = rigFor(t, { script: { [key]: [{ output: scoutOut() }] }, ...rigOpts })
  const ctx = ctxOver ? programContext({ intelligence: 'normal', ...rig.ctx, ...ctxOver }) : rig.ctx
  const result = await dispatch(ctx, spec(over))
  assert.equal(rig.calls.length, 1, 'one call')
  return { rig, ctx, call: rig.calls[0], result }
}

test("a first call carries the role's name and tools", async (t) => {
  const { call } = await firstCall(t)
  assert.equal(call.role.name, 'scout')
  assert.deepEqual(call.role.tools, loadRole('scout').role.tools)
})

test("a first call's system prompt file holds the role's body", async (t) => {
  const { call } = await firstCall(t)
  assert.equal(readFileSync(call.role.systemPromptFile, 'utf8'), loadRole('scout').role.prompt)
})

test('a first call carries the schema it names', async (t) => {
  const rig = rigFor(t, { script: { 'ruler||a': [{ output: { rulings: [] } }], 'ruler||b': [{ output: { ruling: 'converging', why: 'w' } }] } })
  await dispatch(rig.ctx, { role: 'ruler', schema: 'ruler_premises', thread: 'a', brief: BRIEF })
  await dispatch(rig.ctx, { role: 'ruler', schema: 'ruler_convergence', thread: 'b', brief: BRIEF })
  assert.deepEqual(rig.calls[0].schema, schemaOf('ruler_premises'))
  assert.deepEqual(rig.calls[1].schema, schemaOf('ruler_convergence'))
})

test("a first call runs in the thread's first session", async (t) => {
  const { rig, call } = await firstCall(t, { over: { node: 'a/b' }, rigOpts: { effort: 'effort-kiwi' }, key: 'scout|a/b|plan' })
  const ids = { effort: 'effort-kiwi', execution: rig.run, node: 'a/b', role: 'scout', thread: 'plan' }
  assert.equal(call.thread.key, 'plan')
  assert.equal(call.thread.gen, 0)
  assert.equal(call.thread.session, sessionOf(ids))
  assert.equal(call.thread.nextSession, sessionOf({ ...ids, gen: 1 }))
})

test("a first call's dispatch is keyed by node, role, thread and round", async (t) => {
  const rig = rigFor(t, { script: { [KEY]: [{ output: scoutOut() }], 'scout|x/y|other': [{ output: scoutOut() }] } })
  await dispatch(rig.ctx, spec())
  await dispatch(rig.ctx, spec({ thread: 'other', node: 'x/y' }))
  assert.equal(rig.calls[0].dispatch, dispatchKey({ node: '', role: 'scout', thread: 'plan', round: 1 }))
  assert.equal(rig.calls[0].node, '')
  assert.equal(rig.calls[0].round, 1)
  assert.equal(rig.calls[1].dispatch, dispatchKey({ node: 'x/y', role: 'scout', thread: 'other', round: 1 }))
  assert.equal(rig.calls[1].node, 'x/y')
})

test('a first call starts its session with the brief', async (t) => {
  const { call } = await firstCall(t)
  assert.equal(call.resume, false)
  assert.equal(call.brief, BRIEF)
})

test("a first call's fresh brief is the thread's brief, and its digest is the thread brief's", async (t) => {
  const threadBrief = 'The whole charge of the plan thread, as first briefed.'
  const { call } = await firstCall(t, { over: { threadBrief } })
  assert.equal(call.freshBrief, threadBrief)
  assert.equal(call.briefDigest, fnv1a(threadBrief))
})

test('a first call runs in the root and stores under the run', async (t) => {
  const { ctx, call } = await firstCall(t, { rigOpts: { files: { 'sub/a.txt': 'a' } }, ctxOver: { root: join('sub-root-of', 'the-run') } })
  assert.equal(call.cwd, ctx.root)
  assert.equal(call.cwd, join('sub-root-of', 'the-run'))
  assert.equal(call.dir, ctx.dir)
  assert.equal(call.dir, runDir(ctx.repo, ctx.run))
})

test("a first call's tier is the role's at the dial", async (t) => {
  const rig = rigFor(t, {
    script: {
      'scout||s': [{ output: scoutOut() }],
      'analyst||max': [{ output: { axes: [], guidance_read: [], notes: '', stop_reason: 'completed' } }],
      'analyst||low': [{ output: { axes: [], guidance_read: [], notes: '', stop_reason: 'completed' } }],
    },
  })
  const cases = [
    { role: 'scout', schema: 'search', thread: 's', intelligence: 'normal', base: 'high' },
    { role: 'analyst', schema: 'axes', thread: 'max', intelligence: 'max', base: '' },
    { role: 'analyst', schema: 'axes', thread: 'low', intelligence: 'low', base: 'medium' },
  ]
  for (const c of cases) await dispatch(rig.ctx, { ...c, brief: BRIEF })
  cases.forEach((c, i) => {
    const want = tierFor(loadRole(c.role).role, { intelligence: c.intelligence, base: c.base })
    assert.equal(rig.calls[i].tier.model, want.model, c.thread)
    assert.equal(rig.calls[i].tier.effort, want.effort, c.thread)
  })
})

test("a first call's permissions are the role's read-only rules", async (t) => {
  const rig = rigFor(t, { script: { [KEY]: [{ output: scoutOut() }], 'historian||h': [{ output: { hits: [], dismissed: [], leads: [], asks: [] } }] } })
  await dispatch(rig.ctx, spec())
  await dispatch(rig.ctx, { role: 'historian', schema: 'search', thread: 'h', brief: BRIEF })
  assert.deepEqual(rig.calls[0].permissions, readOnlyPermissions(loadRole('scout').role))
  assert.deepEqual(rig.calls[1].permissions, readOnlyPermissions(loadRole('historian').role))
})

test('a given tier, permissions and cwd are used as given', async (t) => {
  const tier = { model: 'opus', effort: 'xhigh' }
  const permissions = { allowed: ['Read', 'Edit(/x.md)'], disallowed: ['Bash(git push:*)'] }
  const cwd = join('somewhere', 'else')
  const { call } = await firstCall(t, { over: { tier, permissions, cwd } })
  assert.equal(call.tier.model, tier.model)
  assert.equal(call.tier.effort, tier.effort)
  assert.deepEqual(call.permissions, permissions)
  assert.equal(call.cwd, cwd)
})

// --- results ---------------------------------------------------------------------------------

test('a returned dispatch gives the stored return', async (t) => {
  const output = scoutOut({ hits: [hit('lib/alpha.mjs', 3), hit('lib/beta.mjs', 9)] })
  const rig = rigFor(t, { script: { [KEY]: [{ output }] } })
  const r = await dispatch(rig.ctx, spec())
  assert.equal(r.status, 'returned')
  assert.deepEqual(r.output, output)
  assert.equal(r.dispatch, keyFor())
  assert.equal(r.session, sessionFor(rig))
  assert.equal(r.replayed, false)
})

test("dispatch reads the stored return, not the runner's word", async (t) => {
  const rewritten = scoutOut({ hits: [hit('lib/rewritten-on-disk.mjs', 77)] })
  const rig = rigFor(t, { script: { [KEY]: [{ output: scoutOut() }] } })
  const runAgent = async (call) => {
    const out = await rig.ctx.runAgent(call)
    writeFileSync(returnPath(call.dir, call.dispatch), JSON.stringify(rewritten))
    return out
  }
  const r = await dispatch(programContext({ intelligence: 'normal', ...rig.ctx, runAgent }), spec())
  assert.equal(r.status, 'returned')
  assert.deepEqual(r.output, rewritten)
})

test('a returned call whose stored return cannot be read fails return_unreadable', async (t) => {
  const rig = rigFor(t, { script: { [KEY]: [{ output: scoutOut() }] } })
  const runAgent = async (call) => {
    const out = await rig.ctx.runAgent(call)
    rmSync(returnPath(call.dir, call.dispatch), { force: true })
    return out
  }
  const r = await dispatch(programContext({ intelligence: 'normal', ...rig.ctx, runAgent }), spec())
  assert.equal(r.status, 'failed')
  assert.equal(r.cause, 'return_unreadable')
})

test('a schema the role does not list throws', async (t) => {
  const rig = rigFor(t, { script: { [KEY]: [{ output: scoutOut() }, { output: scoutOut() }] } })
  await assert.rejects(dispatch(rig.ctx, spec({ schema: 'producer' })))
  await assert.rejects(dispatch(rig.ctx, spec({ schema: 'no_such_schema' })))
  assert.equal(rig.calls.length, 0)
})

test('an unknown role fails role_unreadable without a call', async (t) => {
  const rig = rigFor(t)
  const r = await dispatch(rig.ctx, spec({ role: 'no-such-role' }))
  assert.equal(r.status, 'failed')
  assert.equal(r.cause, 'role_unreadable')
  assert.equal(rig.calls.length, 0)
})

test('a later round resumes the thread, its fresh brief the thread brief then every message rendered', async (t) => {
  const threadBrief = 'The plan thread was first told this.'
  const rig = rigFor(t, { script: { [KEY]: [{ output: scoutOut() }, { output: scoutOut() }] } })
  await dispatch(rig.ctx, spec({ brief: threadBrief }))
  const mine = [
    { msg: 'declined', payload: { why: 'kiwi-first-reason' } },
    { msg: 'tests_ready', payload: { files: ['test/quokka-second.test.mjs'] } },
  ]
  const theirs = { msg: 'declined', payload: { why: 'wombat-other-thread' } }
  rig.log.append('message', { thread: 'plan', from: 'code', round: 2, ...mine[0] })
  rig.log.append('message', { thread: 'other', from: 'code', round: 2, ...theirs })
  rig.log.append('message', { thread: 'plan', from: 'code', round: 2, ...mine[1] })
  await dispatch(rig.ctx, spec({ round: 2, brief: 'Round two, go on.', threadBrief }))
  const call = rig.calls[1]
  assert.equal(call.resume, true)
  assert.equal(call.brief, 'Round two, go on.')
  assert.ok(call.freshBrief.startsWith(threadBrief), 'starts with the thread brief')
  const at = mine.map((m) => call.freshBrief.indexOf(renderMessage(m)))
  for (const i of at) assert.ok(i >= threadBrief.length, 'every message on the thread is rendered after the thread brief')
  assert.ok(at[0] < at[1], 'in seq order')
  assert.ok(!call.freshBrief.includes(renderMessage(theirs)), "another thread's message is not in it")
  assert.equal(call.briefDigest, fnv1a(threadBrief))
})

test('a fresh session whose brief is past its room is refused by its largest part, nothing sent, while a resumed one is sent its message', async (t) => {
  const settled = { output: { status: 'settled', dispositions: [] } }
  const rig = rigFor(t, { script: { 'planner||planner:p': [settled, settled, settled] } })
  const threadBrief = '# Plan folder p\n\n## Findings to settle\n\n(the findings are the messages after this brief)\n\n## Product invariants\n\n- never a timer'
  const planner = { role: 'planner', schema: 'planner_settle', thread: 'planner:p', threadBrief }
  await dispatch(rig.ctx, { ...planner, round: 1, brief: threadBrief })
  const big = (n) => ({ findings: [{ id: 'P' + n, severity: 'gap', claim: 'answered-' + n + ' ' + 'x'.repeat(briefRoomOf('planner') / 3) }] })
  await deliver(rig.ctx, { ...planner, round: 2, msg: 'findings', payload: big(1) })
  await deliver(rig.ctx, { ...planner, round: 3, msg: 'findings', payload: big(2) })
  assert.equal(rig.calls.length, 3, 'the fixture: a resumed session reads only its message, so it is sent')
  const out = await deliver(rig.ctx, { ...planner, round: 4, fresh: 'raised', msg: 'findings', payload: big(3) })
  assert.equal(rig.calls.length, 3, 'the fresh session is never started')
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'brief_too_large')
  assert.match(out.part, /^message \d+ findings$/)
  assert.ok(out.bytes > out.budget, JSON.stringify(out))
})

test("a call that fails is failed with the runner's cause", async (t) => {
  const rig = rigFor(t, {
    script: {
      'scout||schema': [{ status: 'failed', cause: 'schema_failed' }, { status: 'failed', cause: 'schema_failed' }],
      'scout||host': [{ status: 'failed', cause: 'host_error' }],
    },
  })
  for (const [thread, cause] of [['schema', 'schema_failed'], ['host', 'host_error']]) {
    const r = await dispatch(rig.ctx, spec({ thread }))
    assert.equal(r.status, 'failed', thread)
    assert.equal(r.cause, cause, thread)
    assert.equal(r.dispatch, keyFor({ thread }), thread)
  }
})

// --- relaunch --------------------------------------------------------------------------------

const sameResult = (a, b) => {
  for (const k of ['status', 'output', 'dispatch', 'session']) assert.deepEqual(a[k], b[k], k)
}

test('a dispatch that returned is replayed on relaunch without a call', async (t) => {
  const rig = rigFor(t, { script: { [KEY]: [{ output: scoutOut({ hits: [hit('lib/replayed.mjs', 5)] }) }] } })
  const first = await dispatch(rig.ctx, spec())
  const again = rig.relaunch({})
  const second = await dispatch(again.ctx, spec())
  assert.equal(second.replayed, true)
  sameResult(second, first)
  assert.equal(again.calls.length, 0)
})

test('a returned dispatch is replayed even when its brief has changed since', async (t) => {
  const rig = rigFor(t, { script: { [KEY]: [{ output: scoutOut() }] } })
  const first = await dispatch(rig.ctx, spec())
  const again = rig.relaunch({})
  const second = await dispatch(again.ctx, spec({ brief: 'A brief rewritten since the first run.' }))
  assert.equal(second.replayed, true)
  sameResult(second, first)
  assert.equal(again.calls.length, 0)
})

test('a returned dispatch whose stored return is gone is resumed with the cut_off brief, not replayed', async (t) => {
  const rig = rigFor(t, { script: { [KEY]: [{ output: scoutOut() }] } })
  const first = await dispatch(rig.ctx, spec())
  rmSync(returnPath(rig.ctx.dir, first.dispatch))
  const later = scoutOut({ hits: [hit('lib/second-time.mjs', 2)] })
  const again = rig.relaunch({ [KEY]: [{ output: later }] })
  const second = await dispatch(again.ctx, spec())
  assert.equal(again.calls.length, 1)
  assert.equal(again.calls[0].resume, true)
  assert.equal(again.calls[0].brief, CUT_OFF())
  assert.equal(second.replayed, false)
  assert.deepEqual(second.output, later)
})

test('a dispatch started and never returned is resumed in its own session with the cut_off brief', async (t) => {
  const threadBrief = 'The plan thread, briefed before the program was killed.'
  const rig = rigFor(t)
  const scout = loadRole('scout').role
  rig.log.append('dispatched', dispatchedEntry({
    dispatch: keyFor(), node: '', round: 1, thread: { key: 'plan' }, role: { name: 'scout' }, tier: tierFor(scout, { intelligence: 'normal' }),
    brief: threadBrief, briefDigest: fnv1a(threadBrief), carries: [],
  }, { pid: 4242, session: sessionFor(rig) }))
  const again = rig.relaunch({ [KEY]: [{ output: scoutOut() }] })
  const r = await dispatch(again.ctx, spec({ brief: threadBrief }))
  assert.equal(again.calls.length, 1)
  const call = again.calls[0]
  assert.equal(call.dispatch, keyFor())
  assert.equal(call.resume, true)
  assert.equal(call.brief, CUT_OFF())
  assert.equal(call.thread.gen, 0)
  assert.equal(call.thread.session, sessionFor(rig))
  assert.equal(call.freshBrief, threadBrief)
  assert.equal(r.status, 'returned')
})

test('a relaunch replays every returned call and runs no step twice', async (t) => {
  let ran = 0
  async function program(ctx) {
    const a = await dispatch(ctx, spec({ thread: 'a' }))
    const b = await dispatch(ctx, spec({ thread: 'b' }))
    const picked = await step(ctx, 'pick', async () => { ran++; return { n: a.output.hits.length + b.output.hits.length } })
    return { a: a.output, b: b.output, picked }
  }
  const rig = rigFor(t, {
    script: {
      'scout||a': [{ output: scoutOut({ hits: [hit('lib/a.mjs', 1)] }) }],
      'scout||b': [{ output: scoutOut({ hits: [hit('lib/b.mjs', 2), hit('lib/b.mjs', 3)] }) }],
    },
  })
  const first = await program(rig.ctx)
  const again = rig.relaunch({})
  const second = await program(again.ctx)
  assert.deepEqual(second, first)
  assert.equal(again.calls.length, 0)
  assert.equal(ran, 1)
  assert.equal(ofKind(again, 'step').filter((s) => s.key === 'pick').length, 1)
})

// --- host stops and slots --------------------------------------------------------------------

test("a host stop sleeps waitFor's time, then resumes the call with the cut_off brief", async (t) => {
  const output = scoutOut({ hits: [hit('lib/after-the-stop.mjs', 4)] })
  const rig = rigFor(t, { script: { [KEY]: [{ status: 'stopped', cause: 'usage_limit', until: UNTIL }, { output }] } })
  const r = await dispatch(rig.ctx, spec())
  assert.deepEqual(rig.sleeps, [waitFor({ until: UNTIL, attempt: 0, now: rig.ctx.now() })])
  assert.equal(rig.calls.length, 2)
  assert.equal(rig.calls[1].dispatch, rig.calls[0].dispatch)
  assert.equal(rig.calls[1].resume, true)
  assert.equal(rig.calls[1].brief, CUT_OFF())
  assert.equal(r.status, 'returned')
  assert.deepEqual(r.output, output)
})

test('each further host stop of a call waits by its attempt', async (t) => {
  const rig = rigFor(t, { script: { [KEY]: [{ status: 'stopped', cause: 'rate_limit' }, { status: 'stopped', cause: 'rate_limit' }, { output: scoutOut() }] } })
  const r = await dispatch(rig.ctx, spec())
  const now = rig.ctx.now()
  assert.deepEqual(rig.sleeps, [waitFor({ attempt: 0, now }), waitFor({ attempt: 1, now })])
  assert.ok(rig.sleeps[1] > rig.sleeps[0], 'the second wait is longer')
  assert.equal(r.status, 'returned')
})

test('a host-stopped call gives up its slot while it sleeps', { timeout: 60_000 }, async (t) => {
  const rig = rigFor(t, { script: { 'scout||a': [{ status: 'stopped', cause: 'rate_limit' }, { output: scoutOut() }], 'scout||b': [{ output: scoutOut() }] } })
  let wake = null
  const sleep = () => new Promise((r) => { wake = r })
  const ctx = programContext({ intelligence: 'normal', ...rig.ctx, maxAgents: 1, sleep })
  let aDone = false
  const a = dispatch(ctx, spec({ thread: 'a' })).then((r) => { aDone = true; return r })
  await until(() => wake !== null, 'the first call sleeps')
  const b = await dispatch(ctx, spec({ thread: 'b' }))
  assert.equal(b.status, 'returned')
  assert.equal(aDone, false, 'the first is still asleep')
  wake()
  assert.equal((await a).status, 'returned')
})

test('no more than maxAgents calls are in flight at once', { timeout: 60_000 }, async (t) => {
  const threads = ['t1', 't2', 't3', 't4', 't5']
  const rig = rigFor(t, { script: Object.fromEntries(threads.map((th) => ['scout||' + th, [{ output: scoutOut() }]])) })
  const g = gated(rig.ctx.runAgent)
  const ctx = programContext({ intelligence: 'normal', ...rig.ctx, runAgent: g.runAgent, maxAgents: 2 })
  let settled = false
  const all = Promise.all(threads.map((thread) => dispatch(ctx, spec({ thread }))))
  all.then(() => { settled = true }, () => { settled = true })
  await until(() => g.waiting.length === 2, 'two calls in flight')
  await quiet()
  assert.equal(g.inFlight, 2)
  while (!settled) {
    g.openAll()
    await quiet(5)
    assert.ok(g.peak <= 2, 'never more than two at once')
  }
  const results = await all
  assert.equal(g.peak, 2, 'two are reached')
  for (const r of results) assert.equal(r.status, 'returned')
})

const renewedScript = (extra = []) => ({ [KEY]: [{ output: scoutOut() }, { status: 'failed', cause: 'session_missing' }, { output: scoutOut() }, ...extra] })

test("a thread the runner renewed goes on in the next generation's session", async (t) => {
  const rig = rigFor(t, { script: renewedScript([{ output: scoutOut() }]) })
  await dispatch(rig.ctx, spec())
  const two = await dispatch(rig.ctx, spec({ round: 2, brief: 'Round two.', threadBrief: BRIEF }))
  assert.equal(two.status, 'returned')
  await dispatch(rig.ctx, spec({ round: 3, brief: 'Round three.', threadBrief: BRIEF }))
  const call = rig.calls[2]
  assert.equal(call.thread.gen, 1)
  assert.equal(call.thread.session, sessionFor(rig, { gen: 1 }))
  assert.equal(call.thread.nextSession, sessionFor(rig, { gen: 2 }))
})

test('a relaunch after a renewal goes on in the renewed session', async (t) => {
  const rig = rigFor(t, { script: renewedScript() })
  await dispatch(rig.ctx, spec())
  await dispatch(rig.ctx, spec({ round: 2, brief: 'Round two.', threadBrief: BRIEF }))
  const again = rig.relaunch({ [KEY]: [{ output: scoutOut() }] })
  await dispatch(again.ctx, spec({ round: 3, brief: 'Round three.', threadBrief: BRIEF }))
  assert.equal(again.calls.length, 1)
  assert.equal(again.calls[0].thread.gen, 1)
  assert.equal(again.calls[0].thread.session, sessionFor(rig, { gen: 1 }))
})

// --- steps -----------------------------------------------------------------------------------

test('a step runs its function once and records its value', async (t) => {
  const rig = rigFor(t)
  const value = { picked: ['lib/a.mjs'], n: 1 }
  let ran = 0
  const got = await step(rig.ctx, 'pick', async () => { ran++; return value })
  assert.equal(ran, 1)
  assert.deepEqual(got, value)
  const records = ofKind(rig, 'step')
  assert.equal(records.length, 1)
  assert.equal(records[0].key, 'pick')
  assert.deepEqual(records[0].value, value)
})

test("a relaunch returns a step's value without running it", async (t) => {
  const rig = rigFor(t)
  const values = { obj: { a: [1, 2] }, zero: 0, no: false, empty: '', nothing: null }
  for (const [key, value] of Object.entries(values)) await step(rig.ctx, key, () => value)
  const again = rig.relaunch({})
  for (const [key, value] of Object.entries(values)) {
    let ran = false
    const got = await step(again.ctx, key, () => { ran = true; return 'fresh' })
    assert.equal(ran, false, key + ' is not run again')
    assert.deepEqual(got, value, key)
  }
})

test('a step that throws records nothing', async (t) => {
  const rig = rigFor(t)
  await assert.rejects(step(rig.ctx, 'sync', () => { throw new Error('boom') }))
  await assert.rejects(step(rig.ctx, 'async', async () => { throw new Error('boom') }))
  assert.equal(ofKind(rig, 'step').length, 0)
  for (const key of ['sync', 'async']) {
    let ran = 0
    assert.equal(await step(rig.ctx, key, () => { ran++; return 7 }), 7)
    assert.equal(ran, 1, key + ' runs its function the next time')
  }
})

// --- messages --------------------------------------------------------------------------------

const MSG = { msg: 'declined', payload: { why: 'the kiwi case is pinned already' } }
const deliverSpec = (over = {}) => ({ role: 'scout', schema: 'search', thread: 'plan', threadBrief: BRIEF, ...MSG, round: 2, ...over })
const twoRounds = () => ({ [KEY]: [{ output: scoutOut() }, { output: scoutOut() }] })

test('a message is recorded before the dispatch that carries it', async (t) => {
  const rig = rigFor(t, { script: twoRounds() })
  await dispatch(rig.ctx, spec())
  await deliver(rig.ctx, deliverSpec())
  const messages = ofKind(rig, 'message')
  assert.equal(messages.length, 1)
  const m = messages[0]
  assert.equal(m.thread, 'plan')
  assert.equal(m.from, 'code')
  assert.equal(m.msg, MSG.msg)
  assert.deepEqual(m.payload, MSG.payload)
  assert.equal(m.round, 2)
  const carrier = ofKind(rig, 'dispatched').find((d) => (d.carries || []).includes(m.seq))
  assert.ok(carrier, 'a dispatched record carries the message')
  assert.ok(m.seq < carrier.seq, 'the message is recorded first')
  assert.deepEqual(rig.calls[1].carries, [m.seq])
})

test("a delivered message's brief is its rendering", async (t) => {
  const rig = rigFor(t, { script: twoRounds() })
  await dispatch(rig.ctx, spec())
  await deliver(rig.ctx, deliverSpec())
  assert.equal(rig.calls[1].brief, renderMessage(MSG))
  assert.equal(rig.calls[1].round, 2)
  assert.equal(rig.calls[1].dispatch, keyFor({ round: 2 }))
})

test('a relaunch delivers a recorded message without recording it again', async (t) => {
  const rig = rigFor(t, { script: twoRounds() })
  await dispatch(rig.ctx, spec())
  const first = await deliver(rig.ctx, deliverSpec())
  const again = rig.relaunch({})
  const second = await deliver(again.ctx, deliverSpec())
  assert.equal(ofKind(again, 'message').length, 1)
  assert.equal(second.replayed, true)
  sameResult(second, first)
  assert.equal(again.calls.length, 0)
})

test('a message recorded whose dispatch never started is delivered once on relaunch', async (t) => {
  const rig = rigFor(t, { script: { [KEY]: [{ output: scoutOut() }] } })
  await dispatch(rig.ctx, spec())
  const { seq } = rig.log.append('message', { thread: 'plan', from: 'code', round: 2, ...MSG })
  const again = rig.relaunch({ [KEY]: [{ output: scoutOut() }] })
  await deliver(again.ctx, deliverSpec())
  assert.equal(ofKind(again, 'message').length, 1)
  assert.equal(again.calls.length, 1)
  assert.deepEqual(again.calls[0].carries, [seq])
  assert.equal(again.calls[0].brief, renderMessage(MSG))
  assert.equal(again.calls[0].resume, true)
})

// --- coverage and waiting --------------------------------------------------------------------

test('coverage with nothing given is complete', () => {
  assert.equal(coverageOf({}).complete, true)
})

test('coverage with only declared entries is complete', () => {
  assert.equal(coverageOf({ declared: ['topic-a', 'topic-b'] }).complete, true)
})

test('coverage with a dropped entry is not complete', () => {
  assert.equal(coverageOf({ dropped: ['topic-a'] }).complete, false)
})

test('coverage with an incomplete entry is not complete', () => {
  assert.equal(coverageOf({ incomplete: ['topic-a'] }).complete, false)
})

test('coverage with a failed channel is not complete', () => {
  assert.equal(coverageOf({ failed_channels: ['historian'] }).complete, false)
})

test('coverage with an unreached entry is not complete', () => {
  assert.equal(coverageOf({ unreached: ['lib/'] }).complete, false)
})

test('coverage with also false is not complete', () => {
  assert.equal(coverageOf({ also: false }).complete, false)
  assert.equal(coverageOf({ declared: ['topic-a'], also: false }).complete, false)
})

test('coverage carries each list and resumable as given', () => {
  const given = {
    declared: ['d1', 'd2'], dropped: ['x1'], incomplete: ['i1'], failed_channels: ['f1'], unreached: ['u1', 'u2'],
    resumable: { program: 'survey', scope: { q: 'kiwi' }, args: { n: 2 } },
  }
  const c = coverageOf(given)
  for (const k of Object.keys(given)) assert.deepEqual(c[k], given[k], k)
})

const NOW = '2026-01-01T00:00:00.000Z'

test('a stop with a readable until waits until a minute after it', () => {
  for (const until of [UNTIL, '2026-01-01T02:30:00Z', '2026-01-01T00:00:30.000Z']) {
    assert.equal(waitFor({ until, attempt: 0, now: NOW }), Date.parse(until) - Date.parse(NOW) + 60000, until)
    assert.equal(waitFor({ until, attempt: 4, now: NOW }), Date.parse(until) - Date.parse(NOW) + 60000, until + ', whatever the attempt')
  }
})

test('a stop whose until has passed waits a minute', () => {
  for (const until of ['2025-12-31T23:00:00Z', '2025-01-01T00:00:00Z', NOW]) {
    assert.equal(waitFor({ until, attempt: 0, now: NOW }), 60000, until)
    assert.equal(waitFor({ until, attempt: 3, now: NOW }), 60000, until + ', whatever the attempt')
  }
})

test('a stop with no readable until backs off from a minute, doubling, up to thirty', () => {
  for (let attempt = 0; attempt <= 8; attempt++) {
    const want = Math.min(60000 * 2 ** attempt, 1800000)
    assert.equal(waitFor({ until: '', attempt, now: NOW }), want, 'empty until, attempt ' + attempt)
    assert.equal(waitFor({ until: 'not a time at all', attempt, now: NOW }), want, 'unreadable until, attempt ' + attempt)
    assert.equal(waitFor({ attempt, now: NOW }), want, 'no until, attempt ' + attempt)
  }
})

// --- judges ----------------------------------------------------------------------------------

const PRODUCERS = [{ session: 's-producer-a', thread: 'implementer:a' }, { session: 's-producer-b', thread: 'test-author:a' }]

test("dispatchJudge refuses a judge on any producer's work without running it", async () => {
  for (const judge of [{ session: PRODUCERS[1].session, thread: 'reviewer:a:1' }, { session: 's-judge', thread: PRODUCERS[1].thread }]) {
    let ran = false
    const out = await dispatchJudge({ producer: PRODUCERS, judge, run: async () => { ran = true; return { status: 'returned' } } })
    assert.equal(ran, false)
    assert.equal(out.status, 'failed')
    assert.equal(out.error.kind, 'self_judging')
  }
  const allowed = await dispatchJudge({ producer: PRODUCERS, judge: { session: 's-judge', thread: 'reviewer:a:1' }, run: async () => ({ status: 'returned' }) })
  assert.equal(allowed.status, 'returned')
})
