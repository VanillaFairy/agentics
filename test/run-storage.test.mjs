// test/run-storage.test.mjs — pins a program run's own storage: its paths, the `file` handle, its
// log with its own seq under its own lock, the torn-line guard every log shares, the log port
// programs and the runner write through, and where a run stands (live, stopped, ended, absent).
//
// Design: docs/DESIGN.md#storage and docs/DESIGN.md#detached-runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import {
  append, appendProject, appendRun, readLog, readProjectLog, readRunLog, runLog, runState,
} from '../lib/ledger.mjs'
import {
  posix, resolveHandle, resultPath, runDir, runJsonPath, runLogFile, runLogPath, writeJson,
} from '../lib/store.mjs'
import { DEAD_PID } from './harness/dead-pid.mjs'

const RUN = '20260101-000000-survey'
const NOW = Date.parse('2026-01-01T00:10:00.000Z')
const ago = (ms) => new Date(NOW - ms).toISOString()

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-run-storage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const seqFile = (r) => join(runDir(r, RUN), 'seq')
const runJson = (fields) => ({ run: RUN, program: 'survey', pid: 4242, heartbeat_at: ago(10000), ...fields })

test('every run file sits in the run directory, each under its own name', (t) => {
  const r = repo(t)
  const files = [runLogPath, runJsonPath, resultPath, runLogFile].map((f) => f(r, RUN))
  for (const f of files) assert.equal(dirname(f), runDir(r, RUN))
  assert.equal(new Set(files).size, files.length)
})

test('appendRun writes the run log at runLogPath, minting seq from 1', (t) => {
  const r = repo(t)
  const out = appendRun(r, RUN, [{ kind: 'run', program: 'survey' }, { kind: 'dispatched', dispatch: 'd1' }])
  assert.equal(out.ok, true)
  assert.deepEqual(out.seqs, [1, 2])
  assert.equal(out.path, posix(runLogPath(r, RUN)))
  assert.deepEqual(readRunLog(r, RUN).entries.map((e) => [e.kind, e.seq]), [['run', 1], ['dispatched', 2]])
})

test('a seq the caller supplies is overwritten', (t) => {
  const r = repo(t)
  appendRun(r, RUN, { kind: 'step', key: 'k', seq: 99 })
  assert.equal(readRunLog(r, RUN).entries[0].seq, 1)
})

test('two runs count separately', (t) => {
  const r = repo(t)
  appendRun(r, RUN, [{ kind: 'a' }, { kind: 'b' }])
  assert.deepEqual(appendRun(r, '20260101-000000-probe', { kind: 'a' }).seqs, [1])
  assert.deepEqual(appendRun(r, RUN, { kind: 'c' }).seqs, [3])
})

test('a run id resolveHandle would refuse is refused and nothing is written', (t) => {
  const r = repo(t)
  for (const bad of ['../escape', 'Upper', '', 'a/b']) {
    const out = appendRun(r, bad, { kind: 'a' })
    assert.equal(out.ok, false, bad)
    assert.match(out.error, /run id/)
  }
  assert.equal(readRunLog(r, '../escape').entries.length, 0)
})

test('an empty batch and an entry without a kind are refused, writing nothing', (t) => {
  const r = repo(t)
  assert.equal(appendRun(r, RUN, []).ok, false)
  const out = appendRun(r, RUN, [{ kind: 'a' }, { dispatch: 'd1' }])
  assert.equal(out.ok, false)
  assert.match(out.error, /entry 1/)
  const log = readRunLog(r, RUN)
  assert.deepEqual(log.entries, [])
  assert.equal(log.malformed, 0)
})

test('a torn last line is counted as malformed and the next append lands on its own line', (t) => {
  const r = repo(t)
  appendRun(r, RUN, [{ kind: 'a' }, { kind: 'b' }])
  appendFileSync(runLogPath(r, RUN), '{"kind":"dispatched","dispatch":"d3"')
  assert.deepEqual(appendRun(r, RUN, { kind: 'c' }).seqs, [3])
  const log = readRunLog(r, RUN)
  assert.deepEqual(log.entries.map((e) => [e.kind, e.seq]), [['a', 1], ['b', 2], ['c', 3]])
  assert.equal(log.malformed, 1)
})

test('a torn last line of an effort log is counted as malformed and the next append lands on its own line', (t) => {
  const r = repo(t)
  const { path } = append(r, 'e1', 'events', { kind: 'noted', note: 'a' })
  appendFileSync(path, '{"kind":"noted","note":"b"')
  assert.deepEqual(append(r, 'e1', 'events', { kind: 'noted', note: 'c' }).seqs, [2])
  const log = readLog(r, 'e1', 'events')
  assert.deepEqual(log.entries.map((e) => [e.note, e.seq]), [['a', 1], ['c', 2]])
  assert.equal(log.malformed, 1)
})

test('a torn last line of a project log is counted as malformed and the next append lands on its own line', (t) => {
  const r = repo(t)
  const { path } = appendProject(r, 'items', { kind: 'item', id: 'a' })
  appendFileSync(path, '{"kind":"item","id":"b"')
  assert.deepEqual(appendProject(r, 'items', { kind: 'item', id: 'c' }).seqs, [2])
  const log = readProjectLog(r, 'items')
  assert.deepEqual(log.entries.map((e) => [e.id, e.seq]), [['a', 1], ['c', 2]])
  assert.equal(log.malformed, 1)
})

test('a lost counter is rebuilt from the log', (t) => {
  const r = repo(t)
  appendRun(r, RUN, [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }])
  rmSync(seqFile(r))
  assert.deepEqual(appendRun(r, RUN, { kind: 'd' }).seqs, [4])
})

test('a counter behind the log after a crash is reconciled with it', (t) => {
  const r = repo(t)
  appendRun(r, RUN, [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }])
  writeFileSync(seqFile(r), '1')
  assert.deepEqual(appendRun(r, RUN, { kind: 'd' }).seqs, [4])
})

test('the log port appends a record under its kind and returns its seq', (t) => {
  const r = repo(t)
  const log = runLog(r, RUN)
  assert.equal(log.append('step', { key: 'k', value: 1 }).seq, 1)
  assert.equal(log.append('step', { key: 'l', value: 2 }).seq, 2)
  assert.deepEqual(readRunLog(r, RUN).entries.map((e) => [e.kind, e.key, e.seq]), [['step', 'k', 1], ['step', 'l', 2]])
})

test('the log port starts from the log on disk and mirrors exactly what it wrote', (t) => {
  const r = repo(t)
  appendRun(r, RUN, { kind: 'run', program: 'survey', scope: { question: 'q' }, pid: 1 })
  const log = runLog(r, RUN)
  log.append('returned', { dispatch: 'd1', usage: null, cause: undefined, at: new Date(NOW) })
  assert.deepEqual(log.entries(), readRunLog(r, RUN).entries)
  assert.deepEqual(log.entries().map((e) => e.kind), ['run', 'returned'])
})

test('the log port refuses a field named kind and writes nothing', (t) => {
  const r = repo(t)
  const log = runLog(r, RUN)
  assert.throws(() => log.append('returned', { kind: 'failed' }), /kind/)
  assert.deepEqual(readRunLog(r, RUN).entries, [])
  assert.deepEqual(log.entries(), [])
})

test('the log port throws when the write is refused', (t) => {
  const r = repo(t)
  const log = runLog(r, '../escape')
  assert.throws(() => log.append('step', { key: 'k' }), /run id/)
  assert.deepEqual(log.entries(), [])
})

test('a run without run.json is absent', (t) => {
  const r = repo(t)
  appendRun(r, RUN, { kind: 'run' })
  const st = runState(r, RUN, { now: NOW, alive: () => true })
  assert.deepEqual([st.state, st.run, st.ended], ['absent', null, null])
})

test('a run whose pid is alive and whose heartbeat is fresh is live', (t) => {
  const r = repo(t)
  writeJson(runJsonPath(r, RUN), runJson())
  const st = runState(r, RUN, { now: NOW, alive: (pid) => pid === 4242 })
  assert.equal(st.state, 'live')
  assert.equal(st.run.pid, 4242)
  assert.equal(st.ended, null)
})

test('a live pid with a stale heartbeat is stopped', (t) => {
  const r = repo(t)
  writeJson(runJsonPath(r, RUN), runJson({ heartbeat_at: ago(120001) }))
  assert.equal(runState(r, RUN, { now: NOW, alive: () => true }).state, 'stopped')
  assert.equal(runState(r, RUN, { now: NOW, alive: () => true, staleMs: 200000 }).state, 'live')
})

test('a dead pid with a fresh heartbeat is stopped', (t) => {
  const r = repo(t)
  writeJson(runJsonPath(r, RUN), runJson())
  assert.equal(runState(r, RUN, { now: NOW, alive: () => false }).state, 'stopped')
})

test('a run.json without a pid is stopped whatever the liveness check says', (t) => {
  const r = repo(t)
  writeJson(runJsonPath(r, RUN), runJson({ pid: 0 }))
  assert.equal(runState(r, RUN, { now: NOW, alive: () => true }).state, 'stopped')
})

test('an ended record ends the run whatever its pid', (t) => {
  const r = repo(t)
  writeJson(runJsonPath(r, RUN), runJson())
  appendRun(r, RUN, [{ kind: 'run' }, { kind: 'ended', result: { status: 'done', file: 'x', complete: true } }])
  for (const alive of [() => true, () => false]) {
    const st = runState(r, RUN, { now: NOW, alive })
    assert.equal(st.state, 'ended')
    assert.deepEqual(st.ended.result, { status: 'done', file: 'x', complete: true })
  }
})

test('by default this process reads as alive', (t) => {
  const r = repo(t)
  writeJson(runJsonPath(r, RUN), runJson({ pid: process.pid, heartbeat_at: new Date().toISOString() }))
  assert.equal(runState(r, RUN).state, 'live')
  const gone = DEAD_PID
  writeJson(runJsonPath(r, RUN), runJson({ pid: gone, heartbeat_at: new Date().toISOString() }))
  assert.equal(runState(r, RUN).state, 'stopped')
})

test('a file handle resolves an existing file to its absolute path', (t) => {
  const r = repo(t)
  const file = join(r, 'question.md')
  writeFileSync(file, 'q\n')
  const h = resolveHandle(r, 'file', file)
  assert.equal(h.ok, true)
  assert.equal(h.value, resolve(file))
})

test('a relative file handle is resolved against the working directory', (t) => {
  const r = repo(t)
  const file = join(r, 'criteria.md')
  writeFileSync(file, 'c\n')
  const h = resolveHandle(r, 'file', relative(process.cwd(), file))
  assert.equal(h.ok, true)
  assert.equal(h.value, resolve(file))
})

test('a file handle refuses a directory, a missing path and an empty name', (t) => {
  const r = repo(t)
  mkdirSync(join(r, 'dir'))
  for (const bad of [join(r, 'dir'), join(r, 'missing.md'), '']) {
    const out = resolveHandle(r, 'file', bad)
    assert.equal(out.ok, false, bad)
    assert.equal(out.error.kind, 'unknown_file')
    assert.equal(typeof out.error.message, 'string')
  }
})
