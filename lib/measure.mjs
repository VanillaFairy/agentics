// lib/measure.mjs — a leaf's or a merge's check as an awaited child, reused by key, the user's checkout watched.
//
// Design: docs/DESIGN.md#verification.
//
// A check runs for minutes, and the execution's event loop carries every other unit, the run's
// heartbeat and every live call's stream; so `lib/verify.mjs` runs in a child this process awaits,
// never in-process. The child journals its own `verify-observed` line, so the journal on disk, not
// the execution's log port, is where a measurement already taken is found.

import { spawn as spawnChild } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { append, readLog } from './ledger.mjs'
import { canonical, fnv1a } from './plan-digest.mjs'
import { mainCheckout } from './store.mjs'
import { checkoutWatch, readCheckout } from './watch.mjs'

const VERIFY = fileURLToPath(new URL('./verify.mjs', import.meta.url))

/**
 * Pure. The key of one measurement: what verify's payload depends on, hashed. The same key is
 * the same measurement, so a journalled one is taken instead of running it again.
 * @param {object} options verify's options
 * @param {{status: object}} at the worktree's status: each path `git status` reports, with its content's blob id
 */
export function measureKey(options, { status }) {
  const o = options || {}
  return fnv1a(canonical({
    head: o.head || '',
    status: status || {},
    base: o.base || '',
    mode: o.mode || 'order',
    rigor: o.rigor || '',
    role: o.role || 'none',
    producer: o.producer || '',
    commands: {
      build: o.build || '', typecheck: o.typecheck || '', suite: o.suite || '', suiteFast: o.suiteFast || '',
      testOne: o.testOne || '', scope: o.scope || 'full',
      buildAbsent: Boolean(o.buildAbsent), typecheckAbsent: Boolean(o.typecheckAbsent),
      suiteAbsent: Boolean(o.suiteAbsent), suiteFastAbsent: Boolean(o.suiteFastAbsent),
    },
    mutations: o.mutations || [],
    tests: o.tests || [],
    checks: o.checks || [],
    approved: o.approved || [],
    locus: o.locus || [],
    fences: o.fences || {},
    held: o.held || [],
  }))
}

const broken = (kind, message) => ({ stop_reason: 'environment_broken', error: { kind, message }, notes: message })

/**
 * The latest `verify-observed` of the execution with this key, as a payload with the `moved` its
 * completion marker carries, or null. A broken measurement observed nothing of the code, and a
 * line no `measure-done` marker follows was never vouched for by the watch (it threw, or the
 * process died first): neither is taken in place of a new measurement.
 */
function journalled(xc, key) {
  const entries = readLog(xc.repo, xc.effort, 'journal:' + xc.execution).entries
  const lines = entries.filter((e) => e.kind === 'verify-observed' && e.key === key && e.stop_reason !== 'environment_broken')
  if (lines.length === 0) return null
  const line = lines[lines.length - 1]
  const marks = entries.filter((e) => e.kind === 'measure-done' && e.key === key && e.seq > line.seq)
  if (marks.length === 0) return null
  const { kind: _, ...payload } = line
  return { payload, moved: marks[marks.length - 1].moved === true }
}

/** Run `lib/verify.mjs --options -` and await its one line. Resolves; never rejects. */
function child(spawn, options) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let proc
    try {
      proc = spawn(process.execPath, [VERIFY, '--options', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      resolve(broken('measure_failed', 'lib/verify.mjs could not be started: ' + e.message))
      return
    }
    proc.stdout.setEncoding('utf8').on('data', (d) => { out += d })
    proc.stderr.setEncoding('utf8').on('data', (d) => { err += d })
    proc.on('error', (e) => resolve(broken('measure_failed', 'lib/verify.mjs could not be started: ' + e.message)))
    proc.on('close', (code) => {
      const said = (out + err).trim().split('\n').slice(-5).join('\n')
      if (code !== 0) return resolve(broken('measure_failed', 'lib/verify.mjs exited ' + code + (said ? ': ' + said : '')))
      let payload = null
      try { payload = JSON.parse(out.trim().split('\n').pop() || 'null') } catch { payload = null }
      if (!payload || typeof payload !== 'object' || typeof payload.stop_reason !== 'string') {
        return resolve(broken('measure_failed', 'lib/verify.mjs printed no payload' + (said ? ': ' + said : '')))
      }
      resolve(payload)
    })
    proc.stdin.on('error', () => {}) // a child that died first closes its input; `close` reports it
    proc.stdin.end(JSON.stringify(options))
  })
}

/**
 * Measure `options` (verify's) in the execution `xc` — `{repo, effort, execution}` — without
 * blocking the event loop. A measurement journalled at the same key is returned instead
 * (`reused`, with the `moved` it was marked with); otherwise verify runs as a child, which journals it
 * and, once the watch has read the checkout, measure marks it. `moved` is whether the user's
 * `HEAD` or one of their branch refs moved while the check ran; the caller records the fault.
 * @param {{spawn?: Function, watch?: {before: () => object, after: (s: object) => {moved: object[]}}}} [ports]
 *   `spawn` is `child_process.spawn`'s shape; `watch` is `checkoutWatch`'s, over the main checkout
 * @param {{at?: {head: string, status: object}}} [given] `at`: the worktree as `readCheckout` read
 *   it since the caller's last write there; without it the worktree is read here
 * @returns {Promise<{payload: object, reused: boolean, moved: boolean}>}
 */
export async function measure(xc, options, { spawn = spawnChild, watch = checkoutWatch(mainCheckout(xc.repo)) } = {}, given = {}) {
  let at = given.at || null
  if (!at) {
    try {
      at = readCheckout(options.worktree)
    } catch (e) {
      return { payload: broken('no_worktree', 'the worktree could not be read: ' + e.message), reused: false, moved: false }
    }
  }
  const head = options.head || at.head
  const key = measureKey({ ...options, head }, { status: at.status })
  const found = journalled(xc, key)
  if (found) return { payload: found.payload, reused: true, moved: found.moved }

  // A watch that cannot read the checkout cannot vouch for it: the measurement is not handed back.
  const unwatched = (e) => ({ payload: broken('watch_failed', "the user's checkout could not be read: " + e.message), reused: false, moved: false })
  let before
  try {
    before = watch.before()
  } catch (e) {
    return unwatched(e)
  }
  const payload = await child(spawn, { ...options, head, key, repo: xc.repo, effort: xc.effort, execution: xc.execution })
  let moved
  try {
    moved = watch.after(before).moved.length > 0
  } catch (e) {
    return unwatched(e)
  }
  // The only line measure writes: the child's line counts as journalled once the watch has read
  // the checkout. A failed append leaves the line unmarked, so the next call measures again.
  if (payload.stop_reason !== 'environment_broken') {
    append(xc.repo, xc.effort, 'journal:' + xc.execution, { kind: 'measure-done', key, moved })
  }
  return { payload, reused: false, moved }
}
