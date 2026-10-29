// lib/heart.mjs — a run's heartbeat, beaten from a worker thread of its own, so synchronous work on
// the run's main thread (git, a lock wait, a rename retried) never stops it.
//
// Design: docs/DESIGN.md#detached-runs.
//
// The beat says the process lives; `loop_at` says when the main thread's event loop last turned,
// read from memory the main thread writes. A watch tells a frozen process (no beat) from a main
// thread held by synchronous work (a beat, `loop_at` old).

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

import { readJson, takeSync, writeWhole } from './store.mjs'

/** How often the main thread marks a turn of its event loop. */
const TURN_MS = 1000

/** A gap between two turns past this is recorded: what held the main thread is then named by the records around it. */
const STALL_MS = 15000

/** Write one beat into run.json at `file`: the pid, now, and the main loop's last turn. A run.json that cannot be read is left alone. */
function beat({ file, pid, turns }) {
  const meta = readJson(file)
  if (!meta) return
  writeWhole(file, { ...meta, pid, heartbeat_at: new Date().toISOString(), loop_at: new Date(Number(Atomics.load(turns, 0))).toISOString() })
}

/**
 * Start the heartbeat of the run whose run.json is `file`: a worker beats every `everyMs`, and the
 * main thread marks each turn of its loop. `stalled(ms, since, spent)` is called on the main thread for a
 * turn that came `ms` later than due, past `stallMs`, with the synchronous work counted meanwhile (`takeSync`). `stop()` ends both, resolving once the worker has.
 */
export function startHeart({ file, everyMs, stalled = () => {}, stallMs = STALL_MS }) {
  const turns = new BigInt64Array(new SharedArrayBuffer(8))
  let last = Date.now()
  Atomics.store(turns, 0, BigInt(last))
  const turn = setInterval(() => {
    const now = Date.now()
    Atomics.store(turns, 0, BigInt(now))
    const spent = takeSync()
    if (now - last - TURN_MS > stallMs) stalled(now - last - TURN_MS, new Date(last).toISOString(), spent.slice(0, 5))
    last = now
  }, TURN_MS)
  turn.unref()
  const worker = new Worker(new URL(import.meta.url), { workerData: { heart: { file, pid: process.pid, turns, everyMs } } })
  worker.unref()
  worker.on('error', () => {})
  return {
    async stop() {
      clearInterval(turn)
      // Held while it winds down: an unreferenced worker and timer would let the process end here, before its caller prints.
      worker.ref()
      worker.postMessage('stop')
      await new Promise((done) => {
        const late = setTimeout(done, 2000)
        worker.once('exit', () => {
          clearTimeout(late)
          done()
        })
      })
    },
  }
}

if (!isMainThread && workerData && workerData.heart) {
  const at = workerData.heart
  const tick = () => {
    try {
      beat(at)
    } catch {
      // a beat missed is caught up by the next; a run whose beats stop reads as stopped
    }
  }
  tick()
  const timer = setInterval(tick, at.everyMs)
  parentPort.on('message', (m) => {
    if (m === 'stop') {
      clearInterval(timer)
      parentPort.close()
    }
  })
}
