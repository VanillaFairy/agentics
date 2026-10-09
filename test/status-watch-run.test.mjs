// test/status-watch-run.test.mjs — pins the one watch: on a program run, a line per host stop and
// per fault recorded after it began, then the run's end, or how to resume a run that stopped; on an
// execution's run, also a line per stop still open when printed, and only the current run's end.
//
// Design: docs/DESIGN.md#detached-runs, docs/DESIGN.md#progress.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { append, appendRun, readRunLog, seqMax } from '../lib/ledger.mjs'
import { efforts, runWatchLines } from '../lib/status.mjs'
import { executionRunId, runJsonPath, writeJson } from '../lib/store.mjs'
import { DEAD_PID } from './harness/dead-pid.mjs'

const CLI = fileURLToPath(new URL('../lib/status.mjs', import.meta.url))
const RUN = '20260101-000000-survey'

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-watch-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const watch = (r, run) => execFileSync(process.execPath, [CLI, 'watch', '--repo', r, '--run', run], {
  encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' }, timeout: 20000,
})

const stop = (seq, until = '2026-01-01T01:00:00.000Z') => ({ kind: 'host_stop', dispatch: 'scout.r1', cause: 'rate_limit', until, seq })
const ended = (seq) => ({ kind: 'ended', result: { status: 'done', file: '/r/result.json', complete: true }, seq })

test('a host stop after since is a line naming its dispatch, cause and until', () => {
  assert.deepEqual(runWatchLines([stop(1)], 0).lines, ['host_stop scout.r1: rate_limit until 2026-01-01T01:00:00.000Z'])
  assert.deepEqual(runWatchLines([stop(1, '')], 0).lines, ['host_stop scout.r1: rate_limit until -'])
})

test('a fault after since is a line naming its channel and detail', () => {
  const fault = { kind: 'fault', node: '', channel: 'program', detail: 'TypeError: x is undefined', seq: 4 }
  assert.deepEqual(runWatchLines([fault], 3).lines, ['fault program: TypeError: x is undefined'])
})

test('records at or before since are not lines', () => {
  const out = runWatchLines([stop(1), stop(2), { kind: 'fault', channel: 'program', detail: 'late', seq: 3 }], 2)
  assert.deepEqual(out.lines, ['fault program: late'])
})

test('other records are not lines', () => {
  const entries = [{ kind: 'run', seq: 1 }, { kind: 'dispatched', seq: 2 }, { kind: 'returned', seq: 3 }, { kind: 'step', seq: 4 }]
  assert.deepEqual(runWatchLines(entries, 0).lines, [])
})

test('an ended record ends the watch wherever it sits', () => {
  assert.deepEqual(runWatchLines([ended(1)], 5).ended, ended(1))
  assert.equal(runWatchLines([stop(1)], 0).ended, null)
})

test('seq_max is the highest seq in the log', () => {
  assert.equal(runWatchLines([stop(2), stop(7), stop(5)], 0).seq_max, 7)
  assert.equal(runWatchLines([], 0).seq_max, 0)
})

test('watch on a run that ended prints its end and nothing recorded before it began', (t) => {
  const r = repo(t)
  writeJson(runJsonPath(r, RUN), { run: RUN, pid: process.pid, heartbeat_at: new Date().toISOString() })
  appendRun(r, RUN, [{ kind: 'run', program: 'survey' }, stop(0), ended(0)])
  assert.equal(watch(r, RUN), 'ended done: complete=true result=/r/result.json\n')
})

test('watch on a run whose process is gone prints how to resume it', (t) => {
  const r = repo(t)
  const gone = DEAD_PID
  writeJson(runJsonPath(r, RUN), { run: RUN, pid: gone, heartbeat_at: new Date().toISOString() })
  appendRun(r, RUN, [{ kind: 'run', program: 'survey' }, { kind: 'fault', node: '', channel: 'program', detail: 'before' }])
  assert.equal(watch(r, RUN), 'stopped: start the same command again to resume run ' + RUN + '\n')
})

test('--since prints records appended before the watch started (a run)', (t) => {
  const r = repo(t)
  writeJson(runJsonPath(r, RUN), { run: RUN, pid: process.pid, heartbeat_at: new Date().toISOString() })
  appendRun(r, RUN, [{ kind: 'run', program: 'survey' }])
  const since = runWatchLines(readRunLog(r, RUN).entries, 0).seq_max
  appendRun(r, RUN, [{ kind: 'fault', node: '', channel: 'program', detail: 'after since' }, ended(0)])
  const out = execFileSync(process.execPath, [CLI, 'watch', '--repo', r, '--run', RUN, '--since', String(since)], {
    encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' }, timeout: 20000,
  })
  assert.equal(out, 'fault program: after since\nended done: complete=true result=/r/result.json\n')
})

test('watch follows a live run, printing a fault as it lands, then its end', { timeout: 20000 }, async (t) => {
  const r = repo(t)
  writeJson(runJsonPath(r, RUN), { run: RUN, pid: process.pid, heartbeat_at: new Date().toISOString() })
  appendRun(r, RUN, [{ kind: 'run', program: 'survey' }])
  const since = runWatchLines(readRunLog(r, RUN).entries, 0).seq_max
  const child = spawn(process.execPath, [CLI, 'watch', '--repo', r, '--run', RUN, '--since', String(since)], { env: { ...process.env, NODE_TEST_CONTEXT: '' } })
  const exited = new Promise((resolve) => child.on('close', resolve))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  })
  let out = ''
  const printed = new Promise((resolve) => child.stdout.on('data', (d) => { out += d; if (out.includes('fault program: live')) resolve() }))
  appendRun(r, RUN, [{ kind: 'fault', node: '', channel: 'program', detail: 'live' }])
  await printed
  appendRun(r, RUN, [ended(0)])
  assert.equal(await exited, 0)
  assert.equal(out, 'fault program: live\nended done: complete=true result=/r/result.json\n')
})

test('watch on an unknown run prints the refusal and exits 0', (t) => {
  const r = repo(t)
  const out = JSON.parse(watch(r, '20260101-000000-nothing'))
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'unknown_run')
})

const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: '' }

test('watch refuses a --since that is not a non-negative integer', (t) => {
  const r = repo(t)
  writeJson(runJsonPath(r, RUN), { run: RUN, pid: process.pid, heartbeat_at: new Date().toISOString() })
  appendRun(r, RUN, [{ kind: 'run', program: 'survey' }, ended(0)])
  for (const tail of [['--since', 'abc'], ['--since', '-1'], ['--since', '1.5'], ['--since']]) {
    const out = spawnSync(process.execPath, [CLI, 'watch', '--repo', r, '--run', RUN, ...tail], { encoding: 'utf8', env: CHILD_ENV, timeout: 20000 })
    assert.equal(out.status, 1, tail.join(' '))
    assert.match(JSON.parse(out.stdout).error, /--since/, tail.join(' '))
  }
})

test('watch refuses a --since beyond the largest safe integer', { timeout: 30_000 }, (t) => {
  const r = repo(t)
  writeJson(runJsonPath(r, RUN), { run: RUN, pid: process.pid, heartbeat_at: new Date().toISOString() })
  appendRun(r, RUN, [{ kind: 'run', program: 'survey' }, ended(0)])
  const beyond = String(BigInt(Number.MAX_SAFE_INTEGER) + 2n)
  const out = spawnSync(process.execPath, [CLI, 'watch', '--repo', r, '--run', RUN, '--since', beyond], { encoding: 'utf8', env: CHILD_ENV, timeout: 20000 })
  assert.equal(out.status, 1, out.stdout)
  assert.match(JSON.parse(out.stdout).error, /--since/)
})

test('watch refuses a run name with a space around it: a handle is one token', { timeout: 30_000 }, (t) => {
  const r = repo(t)
  writeJson(runJsonPath(r, RUN), { run: RUN, pid: process.pid, heartbeat_at: new Date().toISOString() })
  appendRun(r, RUN, [{ kind: 'run', program: 'survey' }, ended(0)])
  const out = spawnSync(process.execPath, [CLI, 'watch', '--repo', r, '--run', ' ' + RUN + ' '], { encoding: 'utf8', env: CHILD_ENV, timeout: 10000 })
  assert.equal(out.status, 1, out.stdout)
  assert.equal(JSON.parse(out.stdout).kind, 'args_unreadable')
})

test('an ended record before the latest run is not the current run\'s end', () => {
  const entries = [{ kind: 'run', seq: 1 }, ended(2), { kind: 'run', seq: 3 }, stop(4)]
  assert.equal(runWatchLines(entries, 0).ended, null)
  assert.deepEqual(runWatchLines([...entries, ended(5)], 4).ended, ended(5))
})

// ------------------------------------------------------------------ an execution's run

const EFFORT = 'e1'
const STAMP = '20260101-000000'
const XRUN = executionRunId(EFFORT, STAMP)
const leaf = (id) => ({ id, title: 'do ' + id, kind: 'leaf', rigor: 'trivial', locus: ['src/' + id + '.js'], acceptance: [{ text: 't', check: 'c' }] })
const event = (r, kind, node, fields = {}) => append(r, EFFORT, 'events', { kind, node, execution: STAMP, ...fields })
const state = (r, kind, fields = {}) => append(r, EFFORT, 'state:' + STAMP, { kind, ...fields })

/** An execution home whose current run started with `run`: live (this process) unless given a pid and heartbeat. */
function execution(t, { pid = process.pid, heartbeat = new Date() } = {}) {
  const r = repo(t)
  append(r, EFFORT, 'nodes', [{ id: '.', title: 'the root', kind: 'composite' }, leaf('a'), leaf('b')].map((node) => ({ kind: 'node', node })))
  writeJson(runJsonPath(r, XRUN), { run: XRUN, pid, heartbeat_at: heartbeat.toISOString() })
  state(r, 'run', { program: 'execute', scope: { effort: EFFORT, folder: '.' }, pid })
  return r
}
const watchFrom = (r, since) => execFileSync(process.execPath, [CLI, 'watch', '--repo', r, '--run', XRUN, '--since', String(since)], {
  encoding: 'utf8', env: CHILD_ENV, timeout: 20000,
})
const done = { status: 'done', file: '/r/result.json', complete: true }

test('a stop raised after since prints once, as the watch follows the execution', { timeout: 20000 }, async (t) => {
  const r = execution(t)
  const child = spawn(process.execPath, [CLI, 'watch', '--repo', r, '--run', XRUN, '--since', String(seqMax(r, EFFORT))], { env: CHILD_ENV })
  const exited = new Promise((resolve) => child.on('close', resolve))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  })
  let out = ''
  const printed = new Promise((resolve) => child.stdout.on('data', (d) => { out += d; if (out.includes('a parked needs_decision')) resolve() }))
  event(r, 'parked', 'a', { return: 'needs_decision', question: 'keep the cache?' })
  await printed
  state(r, 'ended', { result: done })
  assert.equal(await exited, 0)
  assert.equal(out, 'a parked needs_decision\nended done: complete=true result=/r/result.json\n')
})

test('a stop cleared before the watch prints it is not printed; one still open is', (t) => {
  const r = execution(t)
  const since = seqMax(r, EFFORT)
  event(r, 'escalated', 'a', { reason: 'no_commit', detail: '' })
  event(r, 'replanned', 'a', { reason: 'retry_escalated', by: 'session' })
  event(r, 'escalated', 'b', { reason: 'blocked', detail: '' })
  state(r, 'ended', { result: done })
  assert.equal(watchFrom(r, since), 'b escalated blocked\nended done: complete=true result=/r/result.json\n')
})

test('a parked stop that a replan cleared, and an escalation a later stop of its node replaced, are not printed', (t) => {
  const r = execution(t)
  const since = seqMax(r, EFFORT)
  event(r, 'parked', 'a', { return: 'needs_decision', question: 'keep the cache?' })
  event(r, 'replanned', 'a', { reason: 'answered', by: 'session' })
  event(r, 'escalated', 'b', { reason: 'blocked', detail: '' })
  event(r, 'escalated', 'b', { reason: 'no_commit', detail: '' })
  state(r, 'ended', { result: done })
  assert.equal(watchFrom(r, since), 'b escalated no_commit\nended done: complete=true result=/r/result.json\n')
})

test('a fault and a host stop of the execution print', (t) => {
  const r = execution(t)
  const since = seqMax(r, EFFORT)
  state(r, 'host_stop', { dispatch: 'a.implementer.producer-a.r1', cause: 'rate_limit', until: '' })
  state(r, 'fault', { node: 'b', channel: 'role', detail: 'the implementer dispatch returned nothing' })
  state(r, 'ended', { result: done })
  assert.equal(watchFrom(r, since), [
    'host_stop a.implementer.producer-a.r1: rate_limit until -',
    'fault role: the implementer dispatch returned nothing',
    'ended done: complete=true result=/r/result.json',
  ].join('\n') + '\n')
})

test('an earlier run\'s end is not printed; a run whose process is gone and heartbeat is stale prints stopped', (t) => {
  const r = execution(t, { pid: DEAD_PID, heartbeat: new Date(Date.now() - 600000) })
  state(r, 'ended', { result: { status: 'checkpoint', file: '/r/old.json', complete: false } })
  state(r, 'run', { program: 'execute', scope: { effort: EFFORT, folder: '.' }, pid: 0 })
  assert.equal(watchFrom(r, 0), 'stopped: start the same command again to resume run ' + XRUN + '\n')
})

test('a relaunch\'s watch does not end on the previous run\'s end before the new run has begun', { timeout: 30000 }, async (t) => {
  const r = execution(t)
  state(r, 'ended', { result: { status: 'checkpoint', file: '/r/old.json', complete: false } })
  const child = spawn(process.execPath, [CLI, 'watch', '--repo', r, '--run', XRUN, '--since', String(seqMax(r, EFFORT))], { env: CHILD_ENV })
  const exited = new Promise((resolve) => child.on('close', resolve))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  })
  let out = ''
  const looked = new Promise((resolve) => child.stdout.on('data', (d) => { out += d; if (out.includes('a parked needs_decision')) resolve() }))
  event(r, 'parked', 'a', { return: 'needs_decision', question: 'keep the cache?' })
  await looked
  state(r, 'run', { program: 'execute', scope: { effort: EFFORT, folder: '.' }, pid: process.pid })
  state(r, 'ended', { result: done })
  assert.equal(await exited, 0)
  assert.equal(out, 'a parked needs_decision\nended done: complete=true result=/r/result.json\n')
})

test('an execution\'s end after the since the watch was given is printed to a watch armed after it', (t) => {
  const r = execution(t)
  const since = seqMax(r, EFFORT)
  state(r, 'ended', { result: done })
  assert.equal(watchFrom(r, since), 'ended done: complete=true result=/r/result.json\n')
})

test('watch takes --run only: watch --execution is refused', (t) => {
  const r = execution(t)
  const out = spawnSync(process.execPath, [CLI, 'watch', '--repo', r, '--effort', EFFORT, '--execution', STAMP], { encoding: 'utf8', env: CHILD_ENV, timeout: 20000 })
  assert.equal(out.status, 1)
  assert.match(JSON.parse(out.stdout).error, /--run/)
})

test('list prints each effort\'s seq_max, the seq a watch starts from', (t) => {
  const r = execution(t)
  event(r, 'escalated', 'a', { reason: 'blocked', detail: '' })
  const json = JSON.parse(execFileSync(process.execPath, [CLI, 'list', '--repo', r, '--json'], { encoding: 'utf8', env: CHILD_ENV }))
  assert.equal(json.payload.efforts.find((e) => e.effort === EFFORT).seq_max, seqMax(r, EFFORT))
  assert.equal(efforts(r).efforts[0].seq_max, seqMax(r, EFFORT))
  assert.ok(execFileSync(process.execPath, [CLI, 'list', '--repo', r], { encoding: 'utf8', env: CHILD_ENV }).includes('seq ' + seqMax(r, EFFORT)))
})
