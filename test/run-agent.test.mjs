// test/run-agent.test.mjs — pins runAgent: how one call starts or resumes its session, what it records
// and when, what it costs, where its return and live activity go, and how stops, retries and orphans end.
//
// Design: docs/DESIGN.md#the-agent-runner and docs/DESIGN.md#host-stops.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyCall, cleanEnv, dispatchedEntry, parseStream, returnedEntry, runAgent, spawner } from '../lib/runner.mjs'
import { dispatchKey, livePath, returnPath, sessionOf } from '../lib/store.mjs'
import { memoryLog } from './harness/memory-log.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE = join(here, 'harness', 'fake-claude.mjs')
const fixture = (name) => readFileSync(join(here, 'fixtures', 'runner', name), 'utf8')

const NODE = 'a/b'
const ROLE = 'executor'
const THREAD = 'producer'
const ids = { effort: 'e1', execution: '20261004-120000', node: NODE, role: ROLE, thread: THREAD }
const S = sessionOf(ids)
const OTHER = sessionOf({ ...ids, thread: 'reviewer' })
const D = dispatchKey({ node: NODE, role: ROLE, thread: THREAD, round: 2 })
const PREV = dispatchKey({ node: NODE, role: ROLE, thread: THREAD, round: 1 })
const OLDER = dispatchKey({ node: NODE, role: ROLE, thread: THREAD, round: 0 })
const DIR = join(tmpdir(), 'agentics-run-agent-dir')
const CWD = join(tmpdir(), 'agentics-run-agent-worktree')
const NOW = '2026-10-04T12:00:00.000Z'
const SCHEMA = { type: 'object', properties: { status: { enum: ['done', 'blocked'] }, text: { type: 'string' } }, required: ['status'] }

/** The fixture's stream, its session replaced by the thread's. */
function streamOf(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const from = JSON.parse(lines[0]).session_id
  return lines.map((l) => l.split(from).join(S))
}
const SUCCESS = streamOf(fixture('stream-success.jsonl'))
const SCHEMA_FAILED = streamOf(fixture('stream-schema-failed.jsonl'))
const RESULT = JSON.parse(SUCCESS.at(-1))
const OUT = RESULT.structured_output
const INIT = SUCCESS[0]
/** A stream ending in the fixture's result with `over` laid on it; an `undefined` field is dropped. */
const ok = (over = {}) => [INIT, JSON.stringify({ ...RESULT, ...over })]
const PARSED = parseStream(SUCCESS.join('\n'))

const makeCall = (over = {}) => ({
  dispatch: D, node: NODE, round: 2,
  thread: { key: THREAD, session: S, gen: 0, nextSession: sessionOf({ ...ids, gen: 1 }) },
  role: { name: ROLE, tools: ['Read', 'Edit', 'Bash'], systemPromptFile: join(tmpdir(), 'agentics-plugin', 'roles', 'executor.md') },
  cwd: CWD, brief: 'Make the failing test in test/a.test.mjs pass.',
  tier: { model: 'opus', effort: 'high', window: 200000 },
  permissions: { allowed: ['Read', 'Edit(src/a.ts)'], disallowed: ['Bash(git push:*)'] },
  schema: SCHEMA, carries: [4, 7], dir: DIR, resume: false, freshBrief: '',
  ...over,
})

const BASE_ENV = { PATH: join(tmpdir(), 'agentics-bin'), CLAUDE_CODE_SESSION_ID: 'the-launching-session', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', AI_AGENT: 'claude', CLAUDE_CONFIG_DIR: join(tmpdir(), 'agentics-claude-config') }

const earlierDispatched = (over = {}) => ['dispatched', { dispatch: PREV, node: NODE, round: 1, thread: THREAD, role: ROLE, model: 'opus', effort: 'high', session: S, brief_digest: 'earlier', carries: [], pid: 101, ...over }]
const earlierReturned = (over = {}) => ['returned', { dispatch: PREV, session: S, status: 'returned', cause: '', usage: null, cost_total: 0.01, cost_usd: 0.01, denials: [], ...over }]
/** An earlier call on the session that ended, so a resume finds no orphan. */
const ENDED = [earlierDispatched({ pid: 101 }), earlierReturned()]

const tick = () => new Promise((resolve) => setImmediate(resolve))
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

/**
 * Every port runAgent takes, in memory. `script` holds one step per CLI start:
 * {pid, lines, stderr, code, hang}; a step without `pid` never calls onSpawn.
 */
function rig({ script = [], seed = [], alive = [], checkout = null, env = BASE_ENV, files = [], log = memoryLog() } = {}) {
  for (const [kind, fields] of seed) log.append(kind, fields)
  const store = new Map(files)
  const removed = []
  const fsx = { writeJson(path, value) { store.set(path, clone(value)) }, remove(path) { store.delete(path); removed.push(path) } }
  const running = new Set(alive)
  const killed = []
  const proc = { alive: (pid) => running.has(pid), kill: (pid) => { killed.push(pid); running.delete(pid) } }
  const order = []
  const SNAPSHOT = { head: 'abc123', refs: { 'refs/heads/main': 'abc123' } }
  const watched = { snapshot: SNAPSHOT, given: [] }
  const watch = checkout && {
    before() { order.push('before'); return SNAPSHOT },
    after(snapshot) { order.push('after'); watched.given.push(snapshot); return clone(checkout) },
  }
  const spawns = []
  const spawnCli = async (args, opts) => {
    const step = script[spawns.length] || { code: 9, stderr: 'unscripted call ' + spawns.length }
    const seen = { args, stdin: opts.stdin, env: opts.env, cwd: opts.cwd, killedBefore: [...killed], atSpawn: null, files: [] }
    spawns.push(seen)
    order.push('spawn')
    if (step.pid) {
      opts.onSpawn(step.pid)
      seen.atSpawn = log.entries()
    }
    if (step.hang) return new Promise(() => {})
    for (const line of step.lines || []) {
      opts.onLine(line)
      await tick()
      seen.files.push(new Map([...store].map(([k, v]) => [k, clone(v)])))
    }
    const lines = step.lines || []
    return { code: step.code === undefined ? 0 : step.code, stdout: lines.length ? lines.join('\n') + '\n' : '', stderr: step.stderr || '' }
  }
  const ports = { spawnCli, log, fsx, proc, watch, now: () => NOW, env }
  return { ports, log, store, removed, killed, spawns, order, watched }
}

async function run(callOver = {}, rigOver = {}) {
  const r = rig({ script: [{ pid: 4242, lines: SUCCESS }], ...rigOver })
  const call = makeCall(callOver)
  const out = await runAgent(call, r.ports)
  return { ...r, call, out }
}

const rows = (log, kind, dispatch) => log.entries().filter((e) => e.kind === kind && (dispatch === undefined || e.dispatch === dispatch))
const fieldsOf = (row) => { const { kind, seq, ...rest } = row; return rest }
const valueAfter = (args, flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }
const close = (actual, expected) => assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`)
const DISPATCHED_FIELDS = ['dispatch', 'node', 'round', 'thread', 'role', 'model', 'effort', 'session', 'brief_digest', 'brief_parts', 'carries', 'pid']
const RETURNED_FIELDS = ['dispatch', 'session', 'status', 'cause', 'usage', 'cost_total', 'cost_usd', 'denials']

// ------------------------------------------------------------------ spawner

function scenario(t, calls) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-spawner-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'scenario.json')
  writeFileSync(file, JSON.stringify({ calls }))
  const record = join(dir, 'given.jsonl')
  const env = { ...process.env, FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_LOG: record }
  const given = () => readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { dir, env, given }
}

test('the spawner runs the CLI and streams its lines', async (t) => {
  const lines = [INIT, '{"type":"assistant","message":{"content":[]}}', 'not json at all', SUCCESS.at(-1)]
  const { dir, env, given } = scenario(t, [{ stdout: lines, stderr: 'a warning', code: 3 }])
  const args = ['-p', '--setting-sources', '', '--json-schema', JSON.stringify(SCHEMA), '--allowedTools', 'Bash(npm test:*)', 'two words']
  const stdin = 'The brief,\nwith a second line and ünïcode.'
  const events = []
  const res = await spawner(process.execPath, [FAKE])(args, {
    stdin, env, cwd: dir,
    onSpawn: (pid) => events.push(['spawn', pid]),
    onLine: (line) => events.push(['line', line]),
  })
  const spawned = events.filter(([what]) => what === 'spawn')
  assert.equal(spawned.length, 1, 'onSpawn is called once')
  assert.ok(Number.isInteger(spawned[0][1]) && spawned[0][1] > 0, 'onSpawn gets the child pid')
  assert.equal(events[0][0], 'spawn', 'the pid is reported before any line')
  assert.deepEqual(events.filter(([what]) => what === 'line').map(([, l]) => l), lines)
  assert.equal(res.code, 3)
  assert.equal(res.stderr, 'a warning')
  assert.deepEqual(res.stdout.split(/\r?\n/).filter(Boolean), lines)
  const [seen, ...more] = given()
  assert.equal(more.length, 0, 'the CLI is started once')
  assert.deepEqual(seen.argv, args, 'the prefix is followed by the args, each one intact')
  assert.equal(seen.stdin, stdin)
})

test('a line split across output chunks is streamed whole', async (t) => {
  const big = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(200 * 1024) }] } })
  const lines = [INIT, big, SUCCESS.at(-1)]
  const { dir, env } = scenario(t, [{ stdout: lines }])
  const got = []
  const res = await spawner(process.execPath, [FAKE])([], { stdin: '', env, cwd: dir, onSpawn: () => {}, onLine: (l) => got.push(l) })
  assert.equal(res.code, 0)
  assert.equal(got.length, lines.length, `onLine was called ${got.length} times for ${lines.length} lines`)
  assert.ok(got[1] === big, `the long line arrived as ${got[1].length} characters, not ${big.length}`)
  assert.equal(got.filter((l) => l === big).length, 1, 'the long line reaches onLine once')
  assert.equal(got[0], INIT)
  assert.equal(got[2], SUCCESS.at(-1))
})

/** The lines `onLine` gets from a real child whose stdout is exactly `raw`. */
async function linesOf(t, raw) {
  const { dir, env } = scenario(t, [{ raw }])
  const got = []
  const res = await spawner(process.execPath, [FAKE])([], { stdin: '', env, cwd: dir, onSpawn: () => {}, onLine: (l) => got.push(l) })
  assert.equal(res.code, 0)
  return got
}

test('a final line with no trailing newline is streamed whole', async (t) => {
  const last = SUCCESS.at(-1)
  const got = await linesOf(t, [INIT, last].join('\n'))
  assert.deepEqual(got, [INIT, last])
  assert.equal(got.filter((l) => l === last).length, 1, 'the last line reaches onLine once')
})

test('lines ended by \\r\\n are streamed without the \\r', async (t) => {
  const lines = [INIT, '{"type":"assistant","message":{"content":[]}}', SUCCESS.at(-1)]
  const got = await linesOf(t, lines.map((l) => l + '\r\n').join(''))
  assert.deepEqual(got, lines)
})

// ------------------------------------------------------------------ the call

test('a first call starts its session with the brief', async () => {
  const { spawns, call } = await run()
  assert.equal(spawns.length, 1)
  const { args, stdin } = spawns[0]
  assert.equal(valueAfter(args, '--session-id'), S)
  assert.ok(!args.includes('--resume'), 'a first call does not resume')
  assert.equal(stdin, call.brief)
  assert.ok(!args.includes(call.brief), 'the brief goes on stdin, not the command line')
})

test('a resumed call resumes its session', async () => {
  const { spawns } = await run({ resume: true }, { seed: ENDED })
  assert.equal(spawns.length, 1)
  assert.equal(valueAfter(spawns[0].args, '--resume'), S)
  assert.ok(!spawns[0].args.includes('--session-id'), 'a resumed call does not start a session')
})

test('the call gets a clean environment', async () => {
  const { spawns } = await run()
  const { env } = spawns[0]
  assert.ok(!('CLAUDE_CODE_SESSION_ID' in env), 'the launching session id is dropped')
  assert.equal(env.CLAUDE_CONFIG_DIR, BASE_ENV.CLAUDE_CONFIG_DIR)
  assert.deepEqual(env, cleanEnv(BASE_ENV), 'the environment is ports.env, cleaned, and nothing from elsewhere')
})

test('the call runs in its own working folder', async () => {
  assert.notEqual(CWD, process.cwd())
  const { spawns } = await run()
  assert.equal(spawns[0].cwd, CWD)
})

// ------------------------------------------------------------------ records

test('a first call records its dispatch before its return', async () => {
  const { spawns, log, out } = await run()
  assert.equal(out.status, 'returned')
  const atSpawn = spawns[0].atSpawn.filter((e) => e.dispatch === D)
  assert.deepEqual(atSpawn.map((e) => e.kind), ['dispatched'], 'onSpawn has appended the dispatch, and nothing has returned yet')
  assert.equal(atSpawn[0].pid, 4242)
  const dispatched = rows(log, 'dispatched', D)
  const returned = rows(log, 'returned', D)
  assert.equal(dispatched.length, 1)
  assert.equal(returned.length, 1)
  assert.ok(dispatched[0].seq < returned[0].seq)
  for (const f of DISPATCHED_FIELDS) assert.ok(f in dispatched[0], `dispatched carries ${f}`)
  const d = dispatched[0]
  assert.equal(d.dispatch, D)
  assert.equal(d.node, NODE)
  assert.equal(d.round, 2)
  assert.equal(d.session, S)
  assert.equal(d.model, 'opus')
  assert.equal(d.effort, 'high')
  assert.deepEqual(d.carries, [4, 7])
  assert.equal(d.pid, 4242)
})

test('a returned call records what it cost and what was denied', async () => {
  const { log, out } = await run()
  const [r] = rows(log, 'returned', D)
  for (const f of RETURNED_FIELDS) assert.ok(f in r, `returned carries ${f}`)
  assert.equal(r.status, 'returned')
  assert.equal(r.session, S)
  assert.deepEqual(r.usage, RESULT.usage)
  assert.equal(r.cost_total, RESULT.total_cost_usd)
  close(r.cost_usd, RESULT.total_cost_usd)
  assert.deepEqual(r.denials, RESULT.permission_denials)
  assert.ok(r.denials.length > 0, 'the fixture holds a denial')
  assert.deepEqual(out.usage, RESULT.usage)
  close(out.cost_usd, RESULT.total_cost_usd)
  assert.deepEqual(out.denials, RESULT.permission_denials)
  assert.equal(out.session, S)
})

test('a dispatched record is dispatchedEntry', async () => {
  const call = makeCall()
  const e = dispatchedEntry(call, { pid: 9876, session: OTHER })
  for (const f of DISPATCHED_FIELDS) assert.ok(f in e, `dispatchedEntry gives ${f}`)
  assert.equal(e.dispatch, D)
  assert.equal(e.node, NODE)
  assert.equal(e.round, 2)
  assert.equal(e.pid, 9876)
  assert.equal(e.session, OTHER, 'the session is the one given, not the thread\'s')
  assert.equal(e.model, call.tier.model)
  assert.equal(e.effort, call.tier.effort)
  assert.deepEqual(e.carries, call.carries)
  assert.ok(JSON.stringify(e.thread).includes(THREAD), 'the record names the thread')
  assert.ok(JSON.stringify(e.role).includes(ROLE), 'the record names the role')
  assert.deepEqual(JSON.parse(JSON.stringify(e)), e, 'the entry is a ledger line')
  assert.ok(typeof e.brief_digest === 'string' && e.brief_digest !== '', 'the brief has a digest')
  assert.ok(!e.brief_digest.includes(call.brief), 'the digest is not the brief')
  assert.equal(dispatchedEntry(makeCall(), { pid: 9876, session: OTHER }).brief_digest, e.brief_digest, 'the same brief, the same digest')
  assert.notEqual(dispatchedEntry(makeCall({ brief: call.brief + ' Then stop.' }), { pid: 9876, session: OTHER }).brief_digest, e.brief_digest)

  const { log } = await run()
  const [row] = rows(log, 'dispatched', D)
  assert.deepEqual(fieldsOf(row), dispatchedEntry(makeCall(), { pid: 4242, session: S }))
})

test('a dispatched record names its thread by key', () => {
  const call = makeCall()
  assert.equal(dispatchedEntry(call, { pid: 9876, session: S }).thread, call.thread.key)
})

test('a dispatched record names its role by name', () => {
  const call = makeCall()
  assert.equal(dispatchedEntry(call, { pid: 9876, session: S }).role, call.role.name)
})

test('a returned record is returnedEntry', async () => {
  const call = makeCall()
  const bare = returnedEntry(call, { session: S, status: 'returned' })
  for (const f of RETURNED_FIELDS) assert.ok(f in bare, `returnedEntry gives ${f}`)
  assert.equal(bare.dispatch, D)
  assert.equal(bare.session, S)
  assert.equal(bare.status, 'returned')
  assert.equal(bare.cause, '')
  assert.equal(bare.usage, null)
  assert.equal(bare.cost_total, null)
  assert.equal(bare.cost_usd, null)
  assert.deepEqual(bare.denials, [])
  const full = returnedEntry(call, { session: OTHER, status: 'failed', cause: 'host_error', usage: { output_tokens: 3 }, costTotal: 0.5, costUsd: 0.25, denials: [{ tool_name: 'Write' }] })
  assert.equal(full.session, OTHER)
  assert.equal(full.status, 'failed')
  assert.equal(full.cause, 'host_error')
  assert.deepEqual(full.usage, { output_tokens: 3 })
  assert.equal(full.cost_total, 0.5)
  assert.equal(full.cost_usd, 0.25)
  assert.deepEqual(full.denials, [{ tool_name: 'Write' }])

  const { log } = await run()
  const [row] = rows(log, 'returned', D)
  assert.deepEqual(fieldsOf(row), returnedEntry(makeCall(), {
    session: S, status: 'returned', usage: PARSED.usage, costTotal: PARSED.costTotal, costUsd: row.cost_usd, denials: PARSED.denials,
  }))
  close(row.cost_usd, PARSED.costTotal)
})

// ------------------------------------------------------------------ cost

test('a first call costs its whole total', async () => {
  const { log, out } = await run({}, { seed: [earlierDispatched({ session: OTHER }), earlierReturned({ session: OTHER, cost_total: 0.005 })] })
  close(out.cost_usd, RESULT.total_cost_usd)
  close(rows(log, 'returned', D)[0].cost_usd, RESULT.total_cost_usd)
})

test("a resumed call costs the difference from the session's last total", async () => {
  const seed = [
    earlierDispatched({ dispatch: OLDER, pid: 100 }), earlierReturned({ dispatch: OLDER, cost_total: 0.004 }),
    earlierDispatched({ pid: 101 }), earlierReturned({ cost_total: 0.01 }),
    earlierDispatched({ dispatch: 'elsewhere', session: OTHER, pid: 102 }), earlierReturned({ dispatch: 'elsewhere', session: OTHER, cost_total: 0.5 }),
  ]
  const { log, out } = await run({ resume: true }, { seed })
  const expected = RESULT.total_cost_usd - 0.01
  close(out.cost_usd, expected)
  const [r] = rows(log, 'returned', D)
  close(r.cost_usd, expected)
  assert.equal(r.cost_total, RESULT.total_cost_usd, 'cost_total stays the host\'s running total')
})

test('a call without a total has no cost', async () => {
  const { log, out } = await run({}, { script: [{ pid: 4242, lines: ok({ total_cost_usd: undefined }) }] })
  assert.equal(out.status, 'returned')
  assert.equal(out.cost_usd, null)
  const [r] = rows(log, 'returned', D)
  assert.equal(r.cost_usd, null)
  assert.equal(r.cost_total, null)
})

test("a return with no total leaves the session's cost baseline alone", async () => {
  const seed = [
    earlierDispatched({ dispatch: OLDER, pid: 100 }), earlierReturned({ dispatch: OLDER, cost_total: 0.004 }),
    earlierDispatched({ pid: 101 }), earlierReturned({ status: 'cut_off', cause: 'orphan_ended', cost_total: null, cost_usd: null }),
  ]
  const { log, out } = await run({ resume: true }, { seed })
  const expected = RESULT.total_cost_usd - 0.004
  close(out.cost_usd, expected)
  close(rows(log, 'returned', D)[0].cost_usd, expected)
})

test('a call without a total has no cost even after a baseline', async () => {
  const { log, out } = await run({ resume: true }, { seed: ENDED, script: [{ pid: 4242, lines: ok({ total_cost_usd: undefined }) }] })
  assert.equal(out.status, 'returned')
  assert.equal(out.cost_usd, null)
  assert.equal(rows(log, 'returned', D)[0].cost_usd, null)
})

// ------------------------------------------------------------------ files

test('the output is stored and returned', async () => {
  const { store, out } = await run()
  assert.deepEqual(out.output, OUT)
  assert.deepEqual(store.get(returnPath(DIR, D)), OUT)
})

test('a later return replaces an earlier one for the same dispatch', async () => {
  const stale = { status: 'blocked', text: 'from an earlier attempt' }
  const first = await run({}, { files: [[returnPath(DIR, D), stale]] })
  assert.deepEqual(first.store.get(returnPath(DIR, D)), OUT)

  const second = { status: 'done', text: 'the second return' }
  const r = rig({ script: [{ pid: 4243, lines: ok({ structured_output: second, total_cost_usd: 0.02 }) }], log: first.log, files: [...first.store] })
  const out = await runAgent(makeCall({ resume: true }), r.ports)
  assert.equal(out.status, 'returned')
  assert.deepEqual(r.store.get(returnPath(DIR, D)), second)
  assert.deepEqual(out.output, second)
})

test('live activity is written while the call runs and removed after', async () => {
  const { spawns, store, removed } = await run()
  const live = livePath(DIR, D)
  const seen = spawns[0].files.map((files) => files.get(live))
  const toolAt = SUCCESS.map((l) => JSON.parse(l)).flatMap((e, i) =>
    e.type === 'assistant' ? e.message.content.filter((c) => c.type === 'tool_use').map((c) => ({ i, name: c.name })) : [])
  assert.equal(toolAt.length, 2, 'the fixture streams two tool calls')
  const [a, b] = toolAt.map(({ i }) => seen[i])
  for (const [snap, { name }] of [[a, toolAt[0]], [b, toolAt[1]]]) {
    assert.ok(snap, `live activity exists once ${name} has streamed`)
    for (const f of ['turns', 'tool', 'at']) assert.ok(f in snap, `live activity carries ${f}`)
    assert.ok(JSON.stringify(snap.tool).includes(name), `live activity names ${name}`)
    assert.equal(snap.at, NOW)
  }
  assert.ok(!JSON.stringify(a.tool).includes(toolAt[1].name), 'the first snapshot is not the last tool')
  assert.ok(a.turns >= 1 && b.turns > a.turns, `turns grow: ${a.turns} then ${b.turns}`)
  assert.ok(!store.has(live), 'live activity is gone after the call')
  assert.ok(removed.includes(live))
})

// ------------------------------------------------------------------ one driver per session

test('an orphan on the session is ended before a resume', async () => {
  const seed = [
    earlierDispatched({ dispatch: OLDER, pid: 503 }), earlierReturned({ dispatch: OLDER }),
    earlierDispatched({ pid: 499 }), ['host_stop', { dispatch: PREV, cause: 'rate_limit', until: '' }],
    earlierDispatched({ pid: 501 }),
    earlierDispatched({ dispatch: 'elsewhere', session: OTHER, pid: 502 }),
  ]
  const { log, killed, spawns, out } = await run({ resume: true }, { seed, alive: [501, 502, 503] })
  assert.deepEqual(killed, [501], 'only the live, unreturned call on this session is killed')
  assert.deepEqual(spawns[0].killedBefore, [501], 'it is killed before the resume starts')
  const cut = log.entries().filter((e) => e.kind === 'returned' && e.status === 'cut_off')
  assert.equal(cut.length, 1)
  assert.equal(cut[0].dispatch, PREV)
  assert.equal(cut[0].session, S)
  assert.equal(cut[0].cause, 'orphan_ended')
  const [mine] = rows(log, 'dispatched', D)
  assert.ok(cut[0].seq < mine.seq, 'the orphan is recorded ended before the resume is dispatched')
  assert.equal(out.status, 'returned')
})

test('a host-stopped call is never killed, even when its pid is alive again', async () => {
  const seed = [earlierDispatched({ pid: 499 }), ['host_stop', { dispatch: PREV, cause: 'usage_limit', until: '5pm' }]]
  const { log, killed, out } = await run({ resume: true }, { seed, alive: [499] })
  assert.deepEqual(killed, [], 'the runner saw that process exit: a live pid is a stranger that reused it')
  assert.equal(log.entries().filter((e) => e.kind === 'returned' && e.status === 'cut_off').length, 0)
  assert.equal(out.status, 'returned')
})

test('a dead earlier call is left alone', async () => {
  const { killed, out } = await run({ resume: true }, { seed: [earlierDispatched({ pid: 777 })], alive: [4242] })
  assert.deepEqual(killed, [])
  assert.equal(out.status, 'returned')
})

test("an earlier attempt's return does not answer a later dispatch of the same call", async () => {
  const seed = [earlierDispatched({ pid: 101 }), earlierReturned(), earlierDispatched({ pid: 202 })]
  const { log, killed, out } = await run({ resume: true }, { seed, alive: [202] })
  assert.deepEqual(killed, [202])
  const cut = log.entries().filter((e) => e.kind === 'returned' && e.status === 'cut_off')
  assert.equal(cut.length, 1)
  assert.equal(cut[0].dispatch, PREV)
  assert.equal(cut[0].cause, 'orphan_ended')
  const [, second] = rows(log, 'dispatched', PREV)
  assert.ok(cut[0].seq > second.seq, 'the cut-off answers the second dispatch')
  assert.equal(out.status, 'returned')
})

test('a dispatch whose CLI never started is not killed', async () => {
  const r = rig({ script: [{ pid: 4242, lines: SUCCESS }], seed: [earlierDispatched({ pid: 0 })] })
  const killed = []
  r.ports.proc = { alive: () => true, kill: (pid) => killed.push(pid) }
  const out = await runAgent(makeCall({ resume: true }), r.ports)
  assert.ok(!killed.includes(0), 'pid 0 is no process')
  assert.equal(r.log.entries().filter((e) => e.kind === 'returned' && e.status === 'cut_off').length, 0)
  assert.equal(out.status, 'returned')
})

test('a first call ends no orphan', async () => {
  const { log, killed, out } = await run({ resume: false }, { seed: [earlierDispatched({ pid: 501 })], alive: [501] })
  assert.deepEqual(killed, [])
  assert.equal(log.entries().filter((e) => e.kind === 'returned' && e.status === 'cut_off').length, 0)
  assert.equal(out.status, 'returned')
})

test('a call cut off and resumed records both calls', async () => {
  const log = memoryLog()
  const first = rig({ script: [{ pid: 333, hang: true }], log })
  runAgent(makeCall(), first.ports)
  for (let i = 0; i < 20 && first.spawns.length === 0; i++) await tick()
  assert.equal(first.spawns.length, 1, 'the first call started')

  const again = rig({ script: [{ pid: 444, lines: SUCCESS }], log })
  const out = await runAgent(makeCall({ resume: true }), again.ports)
  assert.equal(out.status, 'returned')
  assert.deepEqual(again.killed, [], 'the cut-off call is dead and is not killed')
  const dispatched = rows(log, 'dispatched', D)
  assert.deepEqual(dispatched.map((e) => e.pid), [333, 444])
  const returned = rows(log, 'returned', D)
  assert.equal(returned.length, 1)
  assert.equal(returned[0].status, 'returned')
  assert.ok(returned[0].seq > dispatched[1].seq)
})

// ------------------------------------------------------------------ how a call ends

test('a host stop records a stop and no return', async () => {
  const stderr = 'Claude AI usage limit reached; resets at 5pm (Europe/London).'
  const lines = [INIT]
  const expected = classifyCall({ code: 1, stderr, parsed: parseStream(lines.join('\n')) })
  assert.equal(expected.status, 'stopped')
  const { log, spawns, out } = await run({}, { script: [{ pid: 4242, lines, code: 1, stderr }] })
  assert.equal(out.status, 'stopped')
  assert.equal(out.cause, expected.cause)
  assert.equal(out.until, expected.until)
  const stops = rows(log, 'host_stop', D)
  assert.equal(stops.length, 1)
  assert.equal(stops[0].cause, expected.cause)
  assert.equal(stops[0].until, expected.until)
  assert.equal(rows(log, 'returned', D).length, 0, 'a stopped call stays in progress')
  assert.equal(spawns.length, 1, 'the runner does not wait and ask again itself')
})

test('a ref that moved during a host stop fails the call', async () => {
  const stderr = 'Claude AI usage limit reached; resets at 5pm (Europe/London).'
  const moved = ['refs/heads/main']
  const { log, out } = await run({}, { script: [{ pid: 4242, lines: [INIT], code: 1, stderr }], checkout: { moved, changed: [] } })
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'checkout')
  assert.deepEqual(out.checkout.moved, moved)
  const last = log.entries().filter((e) => e.dispatch === D).at(-1)
  assert.equal(last.kind, 'returned', 'the call does not stay in progress')
  assert.equal(last.status, 'failed')
  assert.equal(last.cause, 'checkout')
  assert.equal(rows(log, 'host_stop', D).length, 0, 'the fault names the call, so no stop is recorded')
})

test('a host error records a failed return', async () => {
  const stderr = 'Error: something exploded inside the host'
  const expected = classifyCall({ code: 1, stderr, parsed: parseStream('') })
  assert.equal(expected.cause, 'host_error')
  const { log, spawns, out } = await run({}, { script: [{ pid: 4242, lines: [], code: 1, stderr }] })
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'host_error')
  const returned = rows(log, 'returned', D)
  assert.equal(returned.length, 1)
  assert.equal(returned[0].status, 'failed')
  assert.equal(returned[0].cause, 'host_error')
  assert.ok(returned[0].seq > rows(log, 'dispatched', D)[0].seq)
  assert.equal(spawns.length, 1)
})

test('a CLI that never starts records a dispatch and a failure', async () => {
  const { log, out } = await run({}, { script: [{ code: -1, stderr: 'spawn ' + join(tmpdir(), 'missing', 'claude.exe') + ' ENOENT' }] })
  assert.equal(out.status, 'failed')
  const dispatched = rows(log, 'dispatched', D)
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].pid, 0)
  const returned = rows(log, 'returned', D)
  assert.equal(returned.length, 1)
  assert.equal(returned[0].status, 'failed')
  assert.ok(returned[0].seq > dispatched[0].seq, 'no call is left looking in progress')
})

const VALIDATION = 'Structured output does not match the schema: must have required property \'status\''
const MISSED = ok({ structured_output: undefined, result: VALIDATION, total_cost_usd: 0.002 })

test('a return that misses its schema is asked again once', async () => {
  const expected = classifyCall({ code: 0, parsed: parseStream(MISSED.join('\n')) })
  assert.equal(expected.cause, 'schema_failed')
  const { spawns, out } = await run({}, { script: [{ pid: 4242, lines: MISSED }, { pid: 4243, lines: ok({ total_cost_usd: 0.005 }) }] })
  assert.equal(spawns.length, 2)
  const retry = spawns[1]
  assert.equal(valueAfter(retry.args, '--resume'), S, 'the retry resumes the same session')
  assert.ok(!retry.args.includes('--session-id'))
  assert.ok(retry.stdin.includes(expected.message), `the retry's message names the failure: ${retry.stdin}`)
  assert.equal(retry.cwd, CWD)
  assert.equal(out.status, 'returned')
  assert.deepEqual(out.output, OUT)
})

test('a return that misses its schema twice fails', async () => {
  const { log, spawns, out } = await run({}, { script: [{ pid: 4242, lines: MISSED }, { pid: 4243, lines: SCHEMA_FAILED }, { pid: 4244, lines: SUCCESS }] })
  assert.equal(spawns.length, 2, 'a schema miss is asked again once, not twice')
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'schema_failed')
  const last = log.entries().filter((e) => e.dispatch === D).at(-1)
  assert.equal(last.kind, 'returned', 'the call does not stay in progress')
  assert.equal(last.status, 'failed')
  assert.equal(last.cause, 'schema_failed')
})

test('a schema retry carries what the call carried', async () => {
  const { log } = await run({}, { script: [{ pid: 4242, lines: MISSED }, { pid: 4243, lines: SUCCESS }] })
  const dispatched = log.entries().filter((e) => e.kind === 'dispatched')
  assert.equal(dispatched.length, 2)
  for (const d of dispatched) {
    assert.equal(d.dispatch, D)
    assert.deepEqual(d.carries, [4, 7])
  }
  assert.deepEqual(dispatched.map((d) => d.pid), [4242, 4243])
})

// ------------------------------------------------------------------ brief parts

const PARTS = { Intent: 'a1b2c3d4', Locus: 'e5f6a7b8' }

test("a first call records its brief's parts on its dispatch", async () => {
  const { log } = await run({ briefParts: PARTS })
  const [d] = rows(log, 'dispatched', D)
  assert.deepEqual(d.brief_parts, PARTS)
})

test("a schema retry records the brief's parts on each dispatch", async () => {
  const { log, out } = await run({ briefParts: PARTS }, { script: [{ pid: 4242, lines: MISSED }, { pid: 4243, lines: SUCCESS }] })
  assert.equal(out.status, 'returned')
  const dispatched = rows(log, 'dispatched', D)
  assert.equal(dispatched.length, 2)
  for (const d of dispatched) assert.deepEqual(d.brief_parts, PARTS)
})

test("a continuation part records the brief's parts on each dispatch", async () => {
  const part = ok({ structured_output: { status: 'blocked', text: 'first', more: true } })
  const rest = ok({ structured_output: { status: 'done', text: 'second' } })
  const { log, out } = await run({ briefParts: PARTS }, { script: [{ pid: 4242, lines: part }, { pid: 4243, lines: rest }] })
  assert.equal(out.status, 'returned')
  const dispatched = rows(log, 'dispatched', D)
  assert.equal(dispatched.length, 2)
  for (const d of dispatched) assert.deepEqual(d.brief_parts, PARTS)
})

test('a call given no brief parts records none', async () => {
  const { log } = await run()
  const [d] = rows(log, 'dispatched', D)
  assert.deepEqual(d.brief_parts, {})
})

test('a call whose effort the CLI rejected fails and stores no return', async () => {
  const stderr = "Warning: Unknown --effort value 'ultra' — ignoring it\n"
  const { log, store, out } = await run({}, { script: [{ pid: 4242, lines: SUCCESS, stderr }] })
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'host_error')
  assert.equal(store.has(returnPath(DIR, D)), false)
  const [r] = rows(log, 'returned', D)
  assert.equal(r.status, 'failed')
  assert.equal(r.cause, 'host_error')
})

test('a missing session without a fresh brief fails as missing', async () => {
  const stderr = 'No conversation found with session ID: ' + S
  const { spawns, log, out } = await run({ resume: true, freshBrief: '' }, { seed: ENDED, script: [{ pid: 4242, lines: [], code: 1, stderr }] })
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'session_missing')
  assert.equal(spawns.length, 1, 'without a fresh brief no fresh session is started')
  assert.equal(rows(log, 'thread_renewed').length, 0)
})

// ------------------------------------------------------------------ the user's checkout

test('a changed checkout is recorded', async () => {
  const changed = ['src/notes.md', 'package-lock.json']
  const { log, order, watched, out } = await run({}, { checkout: { moved: [], changed } })
  assert.deepEqual(order, ['before', 'spawn', 'after'])
  assert.deepEqual(watched.given, [watched.snapshot], 'after() gets what before() took')
  const rec = rows(log, 'checkout_changed', D)
  assert.equal(rec.length, 1)
  assert.deepEqual(rec[0].paths, changed)
  assert.equal(out.status, 'returned', 'a changed working tree is not a fault')
  assert.deepEqual(out.output, OUT)
  assert.deepEqual(out.checkout.changed, changed)
})

test('a moved ref fails the call', async () => {
  const moved = ['refs/heads/main']
  const { log, out } = await run({}, { checkout: { moved, changed: [] } })
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'checkout')
  assert.deepEqual(out.checkout.moved, moved)
  const last = log.entries().filter((e) => e.dispatch === D && (e.kind === 'dispatched' || e.kind === 'returned')).at(-1)
  assert.equal(last.kind, 'returned', 'the call does not stay in progress')
  assert.equal(last.status, 'failed')
  assert.equal(last.cause, 'checkout')
})

// A watch whose git read fails (lib/watch.mjs throws) cannot vouch for the checkout.

const throwingWatch = ({ before = false, after = false } = {}) => ({
  before() { if (before) throw new Error('git status failed in the checkout'); return { head: 'abc123' } },
  after() { if (after) throw new Error('git hash-object failed in the checkout'); return { moved: [], changed: [] } },
})

test('a watch that fails after the call fails the call and keeps its return', async () => {
  const r = rig({ script: [{ pid: 4242, lines: SUCCESS }] })
  r.ports.watch = throwingWatch({ after: true })
  const out = await runAgent(makeCall(), r.ports)
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'watch_failed')
  assert.ok(out.message.includes('hash-object'), `the failure is named: ${out.message}`)
  const returned = rows(r.log, 'returned', D)
  assert.equal(returned.length, 1, 'the call does not stay in progress')
  assert.equal(returned[0].status, 'failed')
  assert.equal(returned[0].cause, 'watch_failed')
  assert.ok(returned[0].seq > rows(r.log, 'dispatched', D)[0].seq)
  assert.deepEqual(r.store.get(returnPath(DIR, D)), OUT, 'the output the call paid for is stored')
  close(returned[0].cost_usd, RESULT.total_cost_usd)
})

test('a watch that fails after a host stop fails the call as well', async () => {
  const stderr = 'Claude AI usage limit reached; resets at 5pm (Europe/London).'
  const r = rig({ script: [{ pid: 4242, lines: [INIT], code: 1, stderr }] })
  r.ports.watch = throwingWatch({ after: true })
  const out = await runAgent(makeCall(), r.ports)
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'watch_failed')
  assert.equal(rows(r.log, 'host_stop', D).length, 0, 'the checkout cannot be vouched for, so the stop is not recorded as resumable')
  assert.equal(rows(r.log, 'returned', D).at(-1).cause, 'watch_failed')
  assert.ok(!r.store.has(returnPath(DIR, D)), 'a call that returned nothing stores nothing')
})

test('a watch that fails before the call starts no CLI and records the failure', async () => {
  const r = rig({ script: [{ pid: 4242, lines: SUCCESS }] })
  r.ports.watch = throwingWatch({ before: true })
  const out = await runAgent(makeCall(), r.ports)
  assert.equal(r.spawns.length, 0, 'no agent runs on a checkout nobody can watch')
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'watch_failed')
  const dispatched = rows(r.log, 'dispatched', D)
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].pid, 0)
  const returned = rows(r.log, 'returned', D)
  assert.equal(returned.length, 1)
  assert.equal(returned[0].cause, 'watch_failed')
  assert.ok(returned[0].seq > dispatched[0].seq, 'no call is left looking in progress')
})
