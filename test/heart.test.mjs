// test/heart.test.mjs — pins lib/heart.mjs and the staged-file sweep in lib/store.mjs: a run beats
// while synchronous work holds its main thread, says when that thread last turned, records the
// stall once it turns again, stops beating when stopped; a staged file whose writer is gone is
// removed, a living writer's never.
//
// Design: docs/DESIGN.md#detached-runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startHeart } from '../lib/heart.mjs'
import { readJson, sleepMs, sweepStaged, writeJson } from '../lib/store.mjs'

const dir = (t) => {
  const d = mkdtempSync(join(tmpdir(), 'agentics-heart-'))
  t.after(() => rmSync(d, { recursive: true, force: true }))
  return d
}
const pause = (ms) => new Promise((go) => setTimeout(go, ms))

test('the heart beats while synchronous work holds the main thread, and the stall is told once the thread turns', { timeout: 20000 }, async (t) => {
  const file = join(dir(t), 'run.json')
  writeJson(file, { run: 'r', pid: 0, heartbeat_at: new Date(0).toISOString() })
  const stalls = []
  const heart = startHeart({ file, everyMs: 50, stallMs: 500, stalled: (ms, since) => stalls.push({ ms, since }) })
  await pause(1300)
  const held = Date.now()
  sleepMs(2500)
  const during = readJson(file)
  await pause(1300)
  await heart.stop()

  assert.ok(Date.parse(during.heartbeat_at) > held + 1000, 'a beat landed while the main thread was held: ' + during.heartbeat_at)
  assert.ok(Date.parse(during.loop_at) <= held, 'loop_at is the last turn before the hold: ' + during.loop_at)
  assert.equal(during.pid, process.pid)
  assert.equal(stalls.length, 1, JSON.stringify(stalls))
  assert.ok(stalls[0].ms >= 1000, JSON.stringify(stalls))
  const after = readJson(file).heartbeat_at
  await pause(300)
  assert.equal(readJson(file).heartbeat_at, after, 'no beat after stop')
})

test('sweepStaged removes a staged file whose writer is gone, at any depth, and keeps a living writer\'s and its own', (t) => {
  const d = dir(t)
  mkdirSync(join(d, 'live'))
  const dead = join(d, 'live', 'call.json.86164.tmp')
  const living = join(d, 'live', 'other.json.4242.tmp')
  const own = join(d, 'run.json.' + process.pid + '.tmp')
  const plain = join(d, 'live', 'call.json')
  for (const f of [dead, living, own, plain]) writeFileSync(f, '{}')
  const removed = sweepStaged(d, { alive: (pid) => pid === 4242 })
  assert.deepEqual(removed, [dead])
  assert.deepEqual(readdirSync(join(d, 'live')).sort(), ['call.json', 'other.json.4242.tmp'])
  assert.ok(readdirSync(d).includes('run.json.' + process.pid + '.tmp'))
})
