// test/status-watch-run.test.mjs — pins the watch on one program run: a line per host stop and per
// fault recorded after it began, then the run's end, or how to resume a run that stopped.
//
// Design: docs/DESIGN.md#detached-runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { appendRun } from '../lib/ledger.mjs'
import { runWatchLines } from '../lib/status.mjs'
import { runJsonPath, writeJson } from '../lib/store.mjs'

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
  const gone = spawnSync(process.execPath, ['-e', ''], { env: { ...process.env, NODE_TEST_CONTEXT: '' } }).pid
  writeJson(runJsonPath(r, RUN), { run: RUN, pid: gone, heartbeat_at: new Date().toISOString() })
  appendRun(r, RUN, [{ kind: 'run', program: 'survey' }, { kind: 'fault', node: '', channel: 'program', detail: 'before' }])
  assert.equal(watch(r, RUN), 'stopped: start the same command again to resume run ' + RUN + '\n')
})

test('watch on an unknown run prints the refusal and exits 0', (t) => {
  const r = repo(t)
  const out = JSON.parse(watch(r, '20260101-000000-nothing'))
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'unknown_run')
})
