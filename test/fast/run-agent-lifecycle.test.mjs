// test/fast/run-agent-lifecycle.test.mjs — pins how runAgent carries a thread past its session: a session the
// host lost or one grown past half its window goes on fresh, and a return marked `more` is continued.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyCall, parseStream, runAgent } from '../../lib/runner.mjs'
import { dispatchKey, livePath, returnPath, sessionOf } from '../../lib/store.mjs'
import { memoryLog } from './harness/memory-log.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(join(here, '..', 'fixtures', 'runner', 'stream-success.jsonl'), 'utf8').split(/\r?\n/).filter((l) => l.trim())

const NODE = 'a/b'
const ROLE = 'executor'
const THREAD = 'producer'
const ids = { effort: 'e1', execution: '20261004-120000', node: NODE, role: ROLE, thread: THREAD }
const S = sessionOf(ids)
const NEXT = sessionOf({ ...ids, gen: 1 })
const OTHER = sessionOf({ ...ids, thread: 'reviewer' })
const D = dispatchKey({ node: NODE, role: ROLE, thread: THREAD, round: 2 })
const PREV = dispatchKey({ node: NODE, role: ROLE, thread: THREAD, round: 1 })
const DIR = join(tmpdir(), 'agentics-run-agent-lifecycle-dir')
const CWD = join(tmpdir(), 'agentics-run-agent-lifecycle-worktree')
const NOW = '2026-10-04T12:00:00.000Z'
const SCHEMA = { type: 'object', properties: { status: { enum: ['done', 'blocked'] }, text: { type: 'string' } }, required: ['status'] }
const BRIEF = 'Make the failing test in test/a.test.mjs pass.'
const FRESH = 'The thread brief, then every message recorded on the thread.'
const MISSING = 'No conversation found with session ID: ' + S
const LIMIT = 'Claude AI usage limit reached; resets at 5pm (Europe/London).'

const FIXTURE_SESSION = JSON.parse(fixture[0]).session_id
const RESULT = JSON.parse(fixture.at(-1))
const contextLines = readFileSync(join(here, '..', 'fixtures', 'runner', 'stream-context.jsonl'), 'utf8').split(/\r?\n/).filter((l) => l.trim())
const CONTEXT_SESSION = JSON.parse(contextLines[0]).session_id
/** The context fixture's stream in `session`. */
const contextIn = (session) => contextLines.map((l) => l.split(CONTEXT_SESSION).join(session))
/** A two-line stream in `session`: the fixture's init, then its result with `over` laid on it. */
const streamIn = (session, over = {}) => [
  fixture[0].split(FIXTURE_SESSION).join(session),
  JSON.stringify({ ...RESULT, session_id: session, ...over }),
]
const part = (output, over = {}) => streamIn(S, { structured_output: output, ...over })

const makeCall = (over = {}) => ({
  dispatch: D, node: NODE, round: 2,
  thread: { key: THREAD, session: S, gen: 0, nextSession: NEXT },
  role: { name: ROLE, tools: ['Read', 'Edit', 'Bash'], systemPromptFile: join(tmpdir(), 'agentics-plugin', 'roles', 'executor.md') },
  cwd: CWD, brief: BRIEF,
  tier: { model: 'opus', effort: 'high', window: 200000 },
  permissions: { allowed: ['Read'], disallowed: [] },
  schema: SCHEMA, carries: [4], dir: DIR, resume: false, freshBrief: FRESH,
  ...over,
})

const usageOf = (input, read, creation, output = 50) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: creation, output_tokens: output })
const sizeOf = (u) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
const earlierDispatched = (over = {}) => ['dispatched', { dispatch: PREV, node: NODE, round: 1, thread: THREAD, role: ROLE, model: 'opus', effort: 'high', session: S, brief_digest: 'earlier', carries: [], pid: 101, ...over }]
const earlierReturned = (over = {}) => ['returned', { dispatch: PREV, session: S, status: 'returned', cause: '', usage: null, cost_total: 0.01, cost_usd: 0.01, denials: [], ...over }]
/** An ended earlier call on the session whose last return measured `usage`. */
const endedWith = (usage, over = {}) => [earlierDispatched(over), earlierReturned({ usage, ...over })]

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

/** Every port runAgent takes, in memory; `script` holds one step per CLI start: {pid, lines, stderr, code}. */
function rig({ script = [], seed = [] } = {}) {
  const log = memoryLog()
  for (const [kind, fields] of seed) log.append(kind, fields)
  const store = new Map()
  const fsx = { writeJson(path, value) { store.set(path, clone(value)) }, remove(path) { store.delete(path) } }
  const proc = { alive: () => false, kill: () => {} }
  const spawns = []
  const spawnCli = async (args, opts) => {
    const step = script[spawns.length] || { code: 9, stderr: 'unscripted call ' + spawns.length }
    spawns.push({ args, stdin: opts.stdin, cwd: opts.cwd })
    if (step.pid) opts.onSpawn(step.pid)
    for (const line of step.lines || []) opts.onLine(line)
    const lines = step.lines || []
    return { code: step.code === undefined ? 0 : step.code, stdout: lines.length ? lines.join('\n') + '\n' : '', stderr: step.stderr || '' }
  }
  return { ports: { spawnCli, log, fsx, proc, watch: null, now: () => NOW, env: {} }, log, store, spawns, seeded: seed.length }
}

async function run(callOver = {}, rigOver = {}) {
  const r = rig(rigOver)
  const call = makeCall(callOver)
  const out = await runAgent(call, r.ports)
  const mine = r.log.entries().filter((e) => e.seq > r.seeded)
  return { ...r, call, out, mine }
}

const valueAfter = (args, flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }
const close = (actual, expected) => assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`)
const ofKind = (entries, kind) => entries.filter((e) => e.kind === kind)

function assertStartsFresh(spawn, session, stdin) {
  assert.equal(valueAfter(spawn.args, '--session-id'), session, 'the fresh session is started by its id')
  assert.ok(!spawn.args.includes('--resume'), 'a fresh session is started, not resumed')
  assert.equal(spawn.stdin, stdin, 'the fresh session gets the fresh brief on stdin')
  assert.equal(spawn.cwd, CWD)
}

function assertRenewed(mine, why) {
  const renewed = ofKind(mine, 'thread_renewed')
  assert.equal(renewed.length, 1, 'the thread is renewed once')
  assert.ok(JSON.stringify(renewed[0].thread).includes(THREAD), 'the record names the thread')
  assert.equal(renewed[0].gen, 1, 'the next generation is the one after gen 0')
  assert.equal(renewed[0].why, why)
  const fresh = ofKind(mine, 'dispatched').filter((e) => e.session === NEXT)
  assert.equal(fresh.length, 1, 'the fresh session is dispatched once')
  assert.ok(renewed[0].seq < fresh[0].seq, 'the renewal is recorded before the fresh session starts')
}

// ------------------------------------------------------------------ a session the host lost

test('a missing session goes on in a fresh one', async () => {
  const { spawns, mine, store, out } = await run({ resume: true }, {
    seed: endedWith(null),
    script: [{ pid: 4242, code: 1, stderr: MISSING }, { pid: 4243, lines: streamIn(NEXT) }],
  })
  assert.equal(spawns.length, 2, 'the refused resume, then the fresh session')
  assert.equal(valueAfter(spawns[0].args, '--resume'), S, 'the thread\'s own session is tried first')
  assertStartsFresh(spawns[1], NEXT, FRESH)
  assertRenewed(mine, 'session_missing')
  assert.equal(out.status, 'returned')
  assert.equal(out.session, NEXT, 'the call reports the session the thread now lives in')
  assert.deepEqual(out.output, RESULT.structured_output)
  assert.deepEqual(store.get(returnPath(DIR, D)), RESULT.structured_output)
  const last = mine.filter((e) => e.dispatch === D).at(-1)
  assert.equal(last.kind, 'returned', 'the call ends returned')
  assert.equal(last.status, 'returned')
  assert.equal(last.session, NEXT)
  close(out.cost_usd, RESULT.total_cost_usd)
  close(last.cost_usd, RESULT.total_cost_usd)
})

test('a missing session without a next one fails as missing', async () => {
  const thread = { key: THREAD, session: S, gen: 0 }
  const { spawns, mine, out } = await run({ resume: true, thread }, {
    seed: endedWith(null),
    script: [{ pid: 4242, code: 1, stderr: MISSING }, { pid: 4243, lines: streamIn(NEXT) }],
  })
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'session_missing')
  assert.equal(spawns.length, 1, 'no fresh session is started without its id')
  assert.equal(ofKind(mine, 'thread_renewed').length, 0)
  const last = mine.filter((e) => e.dispatch === D).at(-1)
  assert.equal(last.kind, 'returned', 'the call does not stay in progress')
  assert.equal(last.status, 'failed')
  assert.equal(last.cause, 'session_missing')
})

// ------------------------------------------------------------------ a session grown too large

/** An ended earlier call on the session whose last model turn read `context` tokens, its whole call far more. */
const endedAt = (context, over = {}) => [earlierDispatched(over), earlierReturned({ usage: usageOf(10, 10 * context + 1000, 0), context, ...over })]

test("a session whose last turn read past half its window goes on fresh", async () => {
  const window = 100000
  const seed = [
    ...endedAt(10, { dispatch: 'older', pid: 100 }),
    ...endedAt(window / 2 + 1),
    ...endedAt(1, { dispatch: 'elsewhere', session: OTHER, pid: 102 }),
  ]
  const { spawns, mine, out } = await run({ resume: true, tier: { model: 'opus', effort: 'high', window } }, {
    seed, script: [{ pid: 4242, lines: streamIn(NEXT) }],
  })
  assert.ok(spawns.every((s) => !s.args.includes('--resume')), 'the large session is never resumed')
  assert.equal(spawns.length, 1)
  assertStartsFresh(spawns[0], NEXT, FRESH)
  assertRenewed(mine, 'too_large')
  assert.equal(out.status, 'returned')
  assert.equal(out.session, NEXT)
})

test("a session's floor is its first call's first model turn: it is renewed past the midpoint between floor and window, not before", async () => {
  const window = 100000
  const floor = 70000
  const seed = (last) => [
    ...endedAt(floor + 5000, { dispatch: 'first', pid: 100, opened: floor }),
    ...endedAt(last, { opened: last - 1000 }),
  ]
  const at = await run({ resume: true, tier: { model: 'opus', effort: 'high', window } }, {
    seed: seed((window + floor) / 2), script: [{ pid: 4242, lines: streamIn(S) }],
  })
  assert.equal(valueAfter(at.spawns[0].args, '--resume'), S, 'a charge past half the window is no reason to renew')
  assert.equal(ofKind(at.mine, 'thread_renewed').length, 0)

  const past = await run({ resume: true, tier: { model: 'opus', effort: 'high', window } }, {
    seed: seed((window + floor) / 2 + 1), script: [{ pid: 4242, lines: streamIn(NEXT) }],
  })
  assertStartsFresh(past.spawns[0], NEXT, FRESH)
  assertRenewed(past.mine, 'too_large')
})

test('a session whose last turn read half its window is resumed, however much the whole call read', async () => {
  const window = 100000
  const seed = [
    ...endedAt(window, { dispatch: 'older', pid: 100 }),
    ...endedAt(window / 2),
    ...endedAt(window, { dispatch: 'elsewhere', session: OTHER, pid: 102 }),
  ]
  assert.ok(sizeOf(seed[3][1].usage) > window, 'the whole call read more than the window')
  const { spawns, mine, out } = await run({ resume: true, tier: { model: 'opus', effort: 'high', window } }, {
    seed, script: [{ pid: 4242, lines: streamIn(S) }],
  })
  assert.equal(spawns.length, 1)
  assert.equal(valueAfter(spawns[0].args, '--resume'), S, 'a session at half its window is resumed')
  assert.ok(!spawns[0].args.includes('--session-id'))
  assert.equal(ofKind(mine, 'thread_renewed').length, 0)
  assert.equal(out.status, 'returned')
  assert.equal(out.session, S)
})

test('a session no return measured is resumed, whatever its usage', async () => {
  const window = 100000
  const { spawns, mine } = await run({ resume: true, tier: { model: 'opus', effort: 'high', window } }, {
    seed: endedWith(usageOf(10, 10 * window, 0)), script: [{ pid: 4242, lines: streamIn(S) }],
  })
  assert.equal(valueAfter(spawns[0].args, '--resume'), S, 'a record without a context is no measure of the session')
  assert.equal(ofKind(mine, 'thread_renewed').length, 0)
})

test('a later return without a context leaves the last measured one deciding', async () => {
  const window = 100000
  const seed = [
    ...endedAt(window / 2 + 1, { dispatch: 'measured', pid: 100 }),
    ['returned', { dispatch: PREV, session: S, status: 'cut_off', cause: 'orphan_ended', usage: null, cost_total: null, cost_usd: null, denials: [] }],
  ]
  const { spawns, mine } = await run({ resume: true, tier: { model: 'opus', effort: 'high', window } }, {
    seed, script: [{ pid: 4242, lines: streamIn(NEXT) }],
  })
  assertStartsFresh(spawns[0], NEXT, FRESH)
  assertRenewed(mine, 'too_large')
})

test('without a fresh brief a large session is resumed', async (t) => {
  const window = 100000
  const tier = { model: 'opus', effort: 'high', window }
  const withoutKey = async () => {
    const r = rig({ seed: endedAt(window), script: [{ pid: 4242, lines: streamIn(S) }] })
    const call = makeCall({ resume: true, tier })
    delete call.freshBrief
    const out = await runAgent(call, r.ports)
    return { ...r, out, mine: r.log.entries().filter((e) => e.seq > r.seeded) }
  }
  const cases = {
    'an empty freshBrief': () => run({ resume: true, freshBrief: '', tier }, { seed: endedAt(window), script: [{ pid: 4242, lines: streamIn(S) }] }),
    'an absent freshBrief': withoutKey,
  }
  for (const [name, go] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { spawns, mine, out } = await go()
      assert.equal(spawns.length, 1)
      assert.equal(valueAfter(spawns[0].args, '--resume'), S)
      assert.ok(!spawns[0].args.includes('--session-id'))
      assert.equal(ofKind(mine, 'thread_renewed').length, 0)
      assert.equal(out.status, 'returned')
      assert.equal(out.session, S)
    })
  }
})

test('the window defaults to 200000 tokens', async () => {
  const tier = { model: 'opus', effort: 'high' }
  const large = await run({ resume: true, tier }, { seed: endedAt(100001), script: [{ pid: 4242, lines: streamIn(NEXT) }] })
  assertStartsFresh(large.spawns[0], NEXT, FRESH)
  assertRenewed(large.mine, 'too_large')
  assert.equal(large.spawns.length, 1)
  assert.ok(!large.spawns.some((sp) => sp.args.includes('--resume')), 'no spawn resumes the large session')

  const small = await run({ resume: true, tier }, { seed: endedAt(100000), script: [{ pid: 4242, lines: streamIn(S) }] })
  assert.equal(small.spawns.length, 1)
  assert.equal(valueAfter(small.spawns[0].args, '--resume'), S)
  assert.equal(ofKind(small.mine, 'thread_renewed').length, 0)
})

test("a returned record carries its last turn's context beside the whole call's usage", async () => {
  const { mine } = await run({}, { script: [{ pid: 4242, lines: contextIn(S) }] })
  const events = contextLines.map((l) => JSON.parse(l))
  const turns = events.filter((e) => e.type === 'assistant' && e.message.usage)
  const last = turns.at(-1).message.usage
  const [row] = ofKind(mine, 'returned')
  assert.equal(row.opened, sizeOf(turns[0].message.usage), "opened is what the call's first model turn read")
  assert.notEqual(row.opened, row.context)
  assert.equal(row.status, 'returned')
  assert.equal(row.context, sizeOf(last))
  assert.deepEqual(row.usage, events.find((e) => e.type === 'result').usage)
})

// ------------------------------------------------------------------ a return too large for one response

const PARTS = [
  { status: 'blocked', text: 'first', items: ['a', 'b'], notes: [{ n: 1 }], more: true },
  { status: 'blocked', text: 'second', items: [], notes: [{ n: 2 }, { n: 3 }], more: true },
  { status: 'done', text: 'third', items: ['c'], notes: [{ n: 4 }] },
]
const MERGED = { status: 'done', text: 'third', items: ['a', 'b', 'c'], notes: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] }
const TOTALS = [0.01, 0.02, 0.035]
const LONG = PARTS.map((p, i) => ({ pid: 5000 + i, lines: part(p, { total_cost_usd: TOTALS[i] }) }))

test('a return marked more is continued and merged', async () => {
  const { spawns, out } = await run({}, { script: LONG })
  assert.equal(spawns.length, PARTS.length, 'one call per part, and none after the last')
  assert.equal(valueAfter(spawns[0].args, '--session-id'), S)
  for (const s of spawns.slice(1)) {
    assert.equal(valueAfter(s.args, '--resume'), S, 'a continuation resumes the same session')
    assert.ok(!s.args.includes('--session-id'))
    assert.equal(s.cwd, CWD)
    assert.ok(typeof s.stdin === 'string' && s.stdin.trim() !== '', 'a continuation asks for the rest')
  }
  assert.equal(out.status, 'returned')
  assert.equal(out.session, S)
  assert.ok(!('more' in out.output), 'the merged return drops `more`')
  assert.deepEqual(out.output.items, MERGED.items, 'arrays are concatenated in order')
  assert.deepEqual(out.output.notes, MERGED.notes, 'every array is concatenated, in order')
  assert.equal(out.output.status, MERGED.status, 'other fields come from the last part')
  assert.equal(out.output.text, MERGED.text)
})

test('the stored return is the merged one', async () => {
  const { store, out } = await run({}, { script: LONG })
  const stored = store.get(returnPath(DIR, D))
  assert.ok(stored, 'the return is stored')
  assert.ok(!('more' in stored))
  assert.deepEqual(stored.items, MERGED.items)
  assert.deepEqual(stored.notes, MERGED.notes)
  assert.equal(stored.status, MERGED.status)
  assert.equal(stored.text, MERGED.text)
  assert.deepEqual(stored, out.output, 'what is stored is what is returned')
})

test('every part of a long return is recorded', async () => {
  const { mine } = await run({}, { script: LONG })
  const calls = mine.filter((e) => e.kind === 'dispatched' || e.kind === 'returned')
  assert.deepEqual(calls.map((e) => e.kind), PARTS.flatMap(() => ['dispatched', 'returned']), 'each part is dispatched, then returns')
  assert.deepEqual(ofKind(calls, 'dispatched').map((e) => e.pid), LONG.map((s) => s.pid))
  for (const e of calls) assert.equal(e.session, S, 'every part is in the same session')
  const returned = ofKind(calls, 'returned')
  assert.deepEqual(returned.map((r) => r.status), PARTS.map((p) => (p.more ? 'part' : 'returned')), 'a part returns as a part; the call that completes the return, as returned')
  assert.deepEqual(returned.map((r) => r.cost_total), TOTALS, 'each part records its own running total')
  returned.forEach((r, i) => close(r.cost_usd, TOTALS[i] - (i ? TOTALS[i - 1] : 0)))
})

test('a continuation that repeats itself ends without progress', async () => {
  const same = { status: 'blocked', text: 'again', items: ['a'], more: true }
  const { spawns, mine, out } = await run({}, {
    script: [{ pid: 6000, lines: part(same) }, { pid: 6001, lines: part(same) }, { pid: 6002, lines: part({ status: 'done', text: 'end', items: ['z'] }) }],
  })
  assert.equal(spawns.length, 2, 'a part that repeats the one before is not continued')
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'no_progress')
  const last = mine.filter((e) => e.dispatch === D).at(-1)
  assert.equal(last.kind, 'returned', 'the call does not stay in progress')
  assert.equal(last.status, 'failed')
  assert.equal(last.cause, 'no_progress')
})

test('a continuation stopped by the host stops the call', async () => {
  const expected = classifyCall({ code: 1, stderr: LIMIT, parsed: parseStream(streamIn(S)[0]) })
  assert.equal(expected.status, 'stopped')
  const { spawns, mine, out } = await run({}, {
    script: [{ pid: 7000, lines: part(PARTS[0]) }, { pid: 7001, lines: [streamIn(S)[0]], code: 1, stderr: LIMIT }, { pid: 7002, lines: part(PARTS[2]) }],
  })
  assert.equal(spawns.length, 2, 'the runner does not go on past a host stop itself')
  assert.equal(out.status, 'stopped')
  assert.equal(out.cause, expected.cause)
  assert.equal(out.until, expected.until)
  const stopped = ofKind(mine, 'dispatched').at(-1)
  assert.equal(stopped.pid, 7001)
  const after = mine.filter((e) => e.seq > stopped.seq)
  assert.deepEqual(after.filter((e) => e.kind === 'host_stop').map((e) => e.cause), [expected.cause])
  assert.equal(ofKind(after, 'returned').length, 0, 'a stopped continuation stays in progress')
})

// ------------------------------------------------------------------ a prompt the host refused as too long

const TOO_LONG = 'Prompt is too long'

test('a refused prompt fails as context_exceeded', async () => {
  const { spawns, mine, out } = await run({}, { script: [{ pid: 4242, code: 1, stderr: TOO_LONG }] })
  assert.equal(spawns.length, 1)
  assert.equal(out.cause, 'context_exceeded')
  assert.equal(ofKind(mine, 'thread_renewed').length, 0)
})

// ------------------------------------------------------------------ what a call records of its stream

const webSearchLine = (query) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' + query, name: 'WebSearch', input: { query } }] }, session_id: S })

test('WebSearch is journaled as it streams', async () => {
  const { mine, out } = await run({}, { script: [{ pid: 4242, code: 1, stderr: 'boom', lines: [streamIn(S)[0], webSearchLine('first'), webSearchLine('second')] }] })
  assert.equal(out.cause, 'host_error')
  const used = ofKind(mine, 'tool_used')
  assert.deepEqual(used.map(({ dispatch, thread, tool, input }) => ({ dispatch, thread, tool, input })), [
    { dispatch: D, thread: THREAD, tool: 'WebSearch', input: { query: 'first' } },
    { dispatch: D, thread: THREAD, tool: 'WebSearch', input: { query: 'second' } },
  ])
  assert.ok(used.every((u) => u.seq < ofKind(mine, 'returned')[0].seq), 'each is journaled before its call returns')
})

test('only WebSearch is journaled as tool_used', async () => {
  const { mine } = await run({}, { script: [{ pid: 4242, lines: contextIn(S) }] })
  assert.equal(ofKind(mine, 'tool_used').length, 0)
})

test('tool_used survives a cut-off once', async () => {
  const r = rig({ script: [
    { pid: 4242, code: 1, stderr: LIMIT, lines: [streamIn(S)[0], webSearchLine('before the cut')] },
    { pid: 4243, lines: [streamIn(S)[0], webSearchLine('after the resume'), ...streamIn(S).slice(1)] },
  ] })
  const first = await runAgent(makeCall(), r.ports)
  assert.equal(first.status, 'stopped')
  const second = await runAgent(makeCall({ resume: true }), r.ports)
  assert.equal(second.status, 'returned')
  assert.deepEqual(ofKind(r.log.entries(), 'tool_used').map((e) => e.input.query), ['before the cut', 'after the resume'])
})

// ------------------------------------------------------------------ the live view

test('a live file that cannot be written leaves the call running to its return', async () => {
  const r = rig({ script: [{ pid: 4242, lines: contextIn(S) }] })
  const live = livePath(DIR, D)
  const refused = []
  const write = r.ports.fsx.writeJson
  r.ports.fsx.writeJson = (path, value) => {
    if (path === live) {
      refused.push(path)
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    }
    write(path, value)
  }
  r.ports.fsx.remove = (path) => {
    if (path === live) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
  }
  const out = await runAgent(makeCall(), r.ports)
  assert.ok(refused.length > 0, 'the stream named a tool, so the live file was written')
  assert.equal(out.status, 'returned')
  assert.ok(r.store.has(returnPath(DIR, D)), 'the return is kept')
})
