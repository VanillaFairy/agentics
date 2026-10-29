// lib/offload.mjs — the one long-lived offload worker: lib work whose git count grows with its input
// runs on a worker thread of its own, so the run's main thread keeps turning (every live call's
// stream, the watchdog) while it runs.
//
// Design: docs/DESIGN.md#the-process-model.
//
// The worker is started on first use and kept warm for the process's life; it holds no reference
// while idle, so it never keeps a process alive. There is no in-process fallback: a request the
// worker could not answer rejects, and its caller's unit faults on it. A git the worker killed at
// its ceiling rejects as `GitHung`, the environment's stop.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

import { GitHung } from './store.mjs'

/** A request running this long is recorded `stalled` by the watchdog while it still runs. */
const STALL_MS = 15000
/** How often the watchdog looks. */
const WATCH_MS = 1000

let worker = null
let next = 0
/** The requests in flight, by id: `{resolve, reject, label, since, reported}`. */
const pending = new Map()

/** Reject every request in flight with `err` and drop the worker, so the next request starts a new one. */
function lost(err) {
  const gone = worker
  worker = null
  if (gone) gone.removeAllListeners()
  for (const [id, p] of pending) {
    pending.delete(id)
    p.reject(err)
  }
}

/** A rejection as the main thread throws it: a hung git is `GitHung` again, anything else an Error. */
function revived(error) {
  if (error && error.code === 'git_hung') {
    const hung = new GitHung([], 0)
    hung.message = error.message
    hung.label = error.label
    return hung
  }
  return new Error((error && error.message) || 'the offload worker failed')
}

function started() {
  if (worker) return worker
  const w = new Worker(new URL(import.meta.url), { workerData: { offload: true } })
  w.unref()
  w.on('message', ({ id, ok, value, error }) => {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (pending.size === 0) w.unref()
    if (ok) p.resolve(value)
    else p.reject(revived(error))
  })
  w.on('error', (err) => lost(new Error('the offload worker failed: ' + err.message)))
  w.on('exit', (code) => lost(new Error('the offload worker exited ' + code)))
  worker = w
  return w
}

/**
 * Run `name` of the lib module `module` (a path relative to `lib/`) with `args` on the offload worker
 * and await its value. Arguments and value cross by structured clone. `label` names the request to
 * the watchdog. Rejects when the worker cannot answer: never answered in-process instead.
 */
export function offload(module, name, args, { label = module + ' ' + name } = {}) {
  return new Promise((resolve, reject) => {
    const id = ++next
    pending.set(id, { resolve, reject, label, since: Date.now(), reported: false })
    let w
    try {
      w = started()
      w.ref()
      w.postMessage({ id, module, name, args })
    } catch (err) {
      pending.delete(id)
      reject(new Error('the offload worker could not take ' + label + ': ' + err.message))
    }
  })
}

/**
 * Watch the requests in flight from the main thread: `record({label, since})` once for each that has
 * run past `stallMs`, while it still runs. Returns `stop()`.
 */
export function watchdog(record, { stallMs = STALL_MS, everyMs = WATCH_MS, now = Date.now } = {}) {
  const timer = setInterval(() => {
    for (const p of pending.values()) {
      if (p.reported || now() - p.since <= stallMs) continue
      p.reported = true
      record({ label: p.label, since: new Date(p.since).toISOString() })
    }
  }, everyMs)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}

if (!isMainThread && workerData && workerData.offload) {
  parentPort.on('message', async ({ id, module, name, args }) => {
    try {
      const mod = await import(new URL(String(module), import.meta.url).href)
      if (typeof mod[name] !== 'function') throw new Error(module + ' exports no function ' + name)
      const value = await mod[name](...(Array.isArray(args) ? args : []))
      parentPort.postMessage({ id, ok: true, value: value === undefined ? null : value })
    } catch (err) {
      parentPort.postMessage({ id, ok: false, error: { message: err && err.message ? err.message : String(err), code: err && err.code, label: err && err.label } })
    }
  })
}
