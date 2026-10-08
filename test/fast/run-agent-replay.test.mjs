// test/run-agent-replay.test.mjs — pins what runAgent records for a relaunched program to replay
// from: the brief's digest on every dispatched entry of a call, and a long return's parts recorded as
// parts, with the whole return on disk before the one record that says it returned.
//
// Design: docs/DESIGN.md#the-agent-runner and docs/DESIGN.md#detached-runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fnv1a } from '../../lib/plan-digest.mjs'
import { runAgent } from '../../lib/runner.mjs'
import { dispatchKey, returnPath, sessionOf } from '../../lib/store.mjs'
import { memoryLog } from './harness/memory-log.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(join(here, '..', 'fixtures', 'runner', 'stream-success.jsonl'), 'utf8').split(/\r?\n/).filter((l) => l.trim())

const NODE = 'a/b'
const ROLE = 'executor'
const THREAD = 'producer'
const ids = { effort: 'e1', execution: '20261004-120000', node: NODE, role: ROLE, thread: THREAD }
const S = sessionOf(ids)
const NEXT = sessionOf({ ...ids, gen: 1 })
const D = dispatchKey({ node: NODE, role: ROLE, thread: THREAD, round: 2 })
const PREV = dispatchKey({ node: NODE, role: ROLE, thread: THREAD, round: 1 })
const DIR = join(tmpdir(), 'agentics-run-agent-replay-dir')
const CWD = join(tmpdir(), 'agentics-run-agent-replay-worktree')
const NOW = '2026-10-04T12:00:00.000Z'
const SCHEMA = { type: 'object', properties: { status: { enum: ['done', 'blocked'] }, text: { type: 'string' } }, required: ['status'] }
const BRIEF = 'Make the failing test in test/a.test.mjs pass.'
const FRESH = 'The thread brief, then every message recorded on the thread.'
const CUT_OFF = 'Your last turn was cut off. Finish the task your brief set and return your structured output.'
const DIGEST = fnv1a('The thread brief as the program first wrote it.')
const MISSING = 'No conversation found with session ID: ' + S

const FIXTURE_SESSION = JSON.parse(fixture[0]).session_id
const RESULT = JSON.parse(fixture.at(-1))
/** A two-line stream in `session`: the fixture's init, then its result with `over` laid on it. */
const streamIn = (session, over = {}) => [
  fixture[0].split(FIXTURE_SESSION).join(session),
  JSON.stringify({ ...RESULT, session_id: session, ...over }),
]
const part = (output) => streamIn(S, { structured_output: output })
const MISSED = streamIn(S, { structured_output: undefined, result: 'Structured output does not match the schema' })

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

const usageOf = (input, read) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: 0, output_tokens: 50 })
const endedWith = (usage) => [
  ['dispatched', { dispatch: PREV, node: NODE, round: 1, thread: THREAD, role: ROLE, model: 'opus', effort: 'high', session: S, brief_digest: 'earlier', carries: [], pid: 101 }],
  ['returned', { dispatch: PREV, session: S, status: 'returned', cause: '', usage, cost_total: 0.01, cost_usd: 0.01, denials: [] }],
]

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const tick = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Every port runAgent takes, in memory. `script` holds one step per CLI start: {pid, lines, stderr,
 * code, hang}. `onDisk` holds, for each `returned` entry appended, its status and what its dispatch's
 * return file held at that moment (null when absent).
 */
function rig({ script = [], seed = [], log = memoryLog(), store = new Map() } = {}) {
  for (const [kind, fields] of seed) log.append(kind, fields)
  const seeded = log.entries().length
  const onDisk = []
  const port = {
    append(kind, fields) {
      if (kind === 'returned') onDisk.push({ status: fields.status, stored: clone(store.get(returnPath(DIR, fields.dispatch)) ?? null) })
      return log.append(kind, fields)
    },
    entries: () => log.entries(),
  }
  const fsx = { writeJson(path, value) { store.set(path, clone(value)) }, remove(path) { store.delete(path) } }
  const spawns = []
  const spawnCli = async (args, opts) => {
    const step = script[spawns.length] || { code: 9, stderr: 'unscripted call ' + spawns.length }
    spawns.push({ args, stdin: opts.stdin })
    if (step.pid) opts.onSpawn(step.pid)
    if (step.hang) return new Promise(() => {})
    for (const line of step.lines || []) opts.onLine(line)
    const lines = step.lines || []
    return { code: step.code === undefined ? 0 : step.code, stdout: lines.length ? lines.join('\n') + '\n' : '', stderr: step.stderr || '' }
  }
  const ports = { spawnCli, log: port, fsx, proc: { alive: () => false, kill: () => {} }, watch: null, now: () => NOW, env: {} }
  return { ports, log, store, spawns, onDisk, mine: () => log.entries().slice(seeded) }
}

async function run(callOver = {}, rigOver = {}) {
  const r = rig(rigOver)
  const out = await runAgent(makeCall(callOver), r.ports)
  return { ...r, out, mine: r.mine() }
}

/** Starts a call whose CLI hangs at its `n`th start and waits until it has started: the program died there. */
async function crashAt(r, n) {
  runAgent(makeCall(), r.ports)
  for (let i = 0; i < 50 && r.spawns.length < n; i++) await tick()
  assert.equal(r.spawns.length, n, 'the call reached the start it dies in')
}

const valueAfter = (args, flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }
const ofKind = (entries, kind) => entries.filter((e) => e.kind === kind)
const digestsOf = (entries) => ofKind(entries, 'dispatched').map((e) => e.brief_digest)
const statusesOf = (entries) => ofKind(entries, 'returned').map((e) => e.status)

const PARTS = [
  { status: 'blocked', text: 'first', items: ['a', 'b'], notes: [{ n: 1 }], more: true },
  { status: 'blocked', text: 'second', items: [], notes: [{ n: 2 }, { n: 3 }], more: true },
  { status: 'done', text: 'third', items: ['c'], notes: [{ n: 4 }] },
]
const MERGED = { status: 'done', text: 'third', items: ['a', 'b', 'c'], notes: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] }
const LONG = PARTS.map((p, i) => ({ pid: 5000 + i, lines: part(p) }))

// ------------------------------------------------------------------ the brief's digest

test('a given brief digest is recorded on the first call', async () => {
  const { mine } = await run({ briefDigest: DIGEST }, { script: [{ pid: 4242, lines: streamIn(S) }] })
  assert.deepEqual(digestsOf(mine), [DIGEST])
})

test('a given brief digest is recorded on a schema retry', async () => {
  const { spawns, mine, out } = await run({ briefDigest: DIGEST }, { script: [{ pid: 4242, lines: MISSED }, { pid: 4243, lines: streamIn(S) }] })
  assert.equal(out.status, 'returned')
  assert.equal(spawns.length, 2)
  assert.notEqual(spawns[1].stdin, BRIEF, 'the retry is asked something else')
  assert.deepEqual(digestsOf(mine), [DIGEST, DIGEST])
})

test('a given brief digest is recorded on every continuation part', async () => {
  const { spawns, mine } = await run({ briefDigest: DIGEST }, { script: LONG })
  assert.equal(spawns.length, PARTS.length)
  assert.deepEqual(digestsOf(mine), PARTS.map(() => DIGEST))
})

test('a given brief digest is recorded on a renewal', async () => {
  const { spawns, mine, out } = await run({ briefDigest: DIGEST, resume: true }, {
    seed: endedWith(null), script: [{ pid: 4242, code: 1, stderr: MISSING }, { pid: 4243, lines: streamIn(NEXT) }],
  })
  assert.equal(out.status, 'returned')
  assert.equal(ofKind(mine, 'thread_renewed').length, 1)
  assert.equal(spawns[1].stdin, FRESH, 'the renewal is briefed afresh')
  assert.deepEqual(digestsOf(mine), [DIGEST, DIGEST])
})

test("without a given digest a schema retry records the first call's digest", async () => {
  const { mine } = await run({}, { script: [{ pid: 4242, lines: MISSED }, { pid: 4243, lines: streamIn(S) }] })
  assert.deepEqual(digestsOf(mine), [fnv1a(BRIEF), fnv1a(BRIEF)])
})

test("without a given digest every continuation part records the first call's digest", async () => {
  const { mine } = await run({}, { script: LONG })
  assert.deepEqual(digestsOf(mine), PARTS.map(() => fnv1a(BRIEF)))
})

test('without a given digest a renewal records the digest of the call as given', async () => {
  const missing = await run({ resume: true }, {
    seed: endedWith(null), script: [{ pid: 4242, code: 1, stderr: MISSING }, { pid: 4243, lines: streamIn(NEXT) }],
  })
  assert.deepEqual(digestsOf(missing.mine), [fnv1a(BRIEF), fnv1a(BRIEF)], 'a lost session')
  const window = 100000
  const large = await run({ resume: true, tier: { model: 'opus', effort: 'high', window } }, {
    seed: endedWith(usageOf(10, window)), script: [{ pid: 4242, lines: streamIn(NEXT) }],
  })
  assert.equal(large.spawns[0].stdin, FRESH, 'a session too large is renewed before its first start')
  assert.deepEqual(digestsOf(large.mine), [fnv1a(BRIEF)], 'a session too large')
})

// ------------------------------------------------------------------ a long return's parts

/** What the return file held when the one record saying the call returned was appended. */
async function storedWhenReturned(callOver, rigOver) {
  const { onDisk } = await run(callOver, rigOver)
  const done = onDisk.filter((r) => r.status === 'returned')
  assert.equal(done.length, 1, 'one record says the call returned')
  return done[0].stored
}

test('a first call records returned once its whole return is on disk', async () => {
  const stored = await storedWhenReturned({}, { script: [{ pid: 4242, lines: streamIn(S) }] })
  assert.deepEqual(stored, RESULT.structured_output)
})

test('a schema retry records returned once its whole return is on disk', async () => {
  const stored = await storedWhenReturned({}, { script: [{ pid: 4242, lines: MISSED }, { pid: 4243, lines: streamIn(S) }] })
  assert.deepEqual(stored, RESULT.structured_output)
})

test('a renewal records returned once its whole return is on disk', async () => {
  const stored = await storedWhenReturned({ resume: true }, {
    seed: endedWith(null), script: [{ pid: 4242, code: 1, stderr: MISSING }, { pid: 4243, lines: streamIn(NEXT) }],
  })
  assert.deepEqual(stored, RESULT.structured_output)
})

test('the last part of a long return records returned once the whole merged return is on disk', async () => {
  assert.deepEqual(await storedWhenReturned({}, { script: LONG }), MERGED)
})

test('a part stores nothing', async () => {
  const { onDisk } = await run({}, { script: LONG })
  const parts = onDisk.filter((r) => r.status === 'part')
  assert.equal(parts.length, PARTS.length - 1)
  for (const p of parts) assert.equal(p.stored, null, 'nothing is on disk while parts come in')
})

test('a crash between parts leaves no return on disk', async () => {
  const r = rig({ script: [{ pid: 5000, lines: part(PARTS[0]) }, { pid: 5001, hang: true }] })
  await crashAt(r, 2)
  assert.deepEqual(r.log.entries().map((e) => e.kind), ['dispatched', 'returned', 'dispatched'])
  assert.deepEqual(statusesOf(r.log.entries()), ['part'])
  assert.equal(r.store.has(returnPath(DIR, D)), false)
})

test('a call resumed after a crash mid-continuation stores its own return whole', async () => {
  const log = memoryLog()
  const store = new Map()
  await crashAt(rig({ log, store, script: [{ pid: 5000, lines: part(PARTS[0]) }, { pid: 5001, hang: true }] }), 2)
  const whole = { status: 'done', text: 'all of it again', items: ['x'], notes: [] }
  const again = rig({ log, store, script: [{ pid: 5002, lines: part(whole) }] })
  const out = await runAgent(makeCall({ resume: true, brief: CUT_OFF }), again.ports)
  assert.equal(valueAfter(again.spawns[0].args, '--resume'), S, 'the cut-off call is resumed in its session')
  assert.equal(out.status, 'returned')
  assert.deepEqual(out.output, whole)
  assert.deepEqual(store.get(returnPath(DIR, D)), whole, 'no part from before the crash is merged in')
  assert.deepEqual(statusesOf(log.entries()), ['part', 'returned'])
})

test('a watch that fails on a part stores nothing and returns no output', async () => {
  const r = rig({ script: LONG })
  let afters = 0
  r.ports.watch = { before: () => ({}), after() { afters += 1; if (afters === 2) throw new Error('git status failed'); return { moved: [], changed: [] } } }
  const out = await runAgent(makeCall(), r.ports)
  assert.equal(r.spawns.length, 2, 'the call ends at the part whose watch failed')
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'watch_failed')
  assert.equal(out.output, null, 'a return cut off mid-continuation is not handed back as whole')
  assert.equal(r.store.has(returnPath(DIR, D)), false, 'nothing is stored for a part')
  assert.deepEqual(statusesOf(r.mine()), ['part', 'failed'])
})

// ------------------------------------------------------------------ progress

test('a part that only changes a scalar makes progress', async () => {
  const parts = [
    { status: 'blocked', text: 'one', items: ['a'], more: true },
    { status: 'blocked', text: 'two', items: ['a'], more: true },
    { status: 'done', text: 'three', items: [] },
  ]
  const { spawns, out } = await run({}, { script: parts.map((p, i) => ({ pid: 8000 + i, lines: part(p) })) })
  assert.equal(spawns.length, parts.length)
  assert.equal(out.status, 'returned')
  assert.equal(out.output.text, 'three')
})

test('parts that alternate end without progress', async () => {
  const A = { status: 'blocked', text: 'same', items: ['a'], more: true }
  const B = { status: 'blocked', text: 'same', items: ['b'], more: true }
  const script = [A, B, A, B, { status: 'done', text: 'end', items: ['z'] }].map((p, i) => ({ pid: 8100 + i, lines: part(p) }))
  const { spawns, mine, store, out } = await run({}, { script })
  assert.equal(spawns.length, 3, 'the third part adds nothing already returned and changes nothing')
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'no_progress')
  assert.deepEqual(ofKind(mine, 'returned').map((e) => [e.status, e.cause]), [['part', ''], ['part', ''], ['failed', 'no_progress']])
  assert.equal(store.has(returnPath(DIR, D)), false, 'a return that never completed is not stored')
})

test('an element already returned, its keys in another order, is no progress', async () => {
  const script = [
    { status: 'blocked', notes: [{ n: 1, m: 2 }], more: true },
    { status: 'blocked', notes: [{ n: 3 }], more: true },
    { notes: [{ m: 2, n: 1 }], status: 'blocked', more: true },
    { status: 'done', notes: [] },
  ].map((p, i) => ({ pid: 8200 + i, lines: part(p) }))
  const { spawns, out } = await run({}, { script })
  assert.equal(spawns.length, 3)
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'no_progress')
})
