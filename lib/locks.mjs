// lib/locks.mjs — the slot pool and the lock files: who may run a leaf now, who may merge into an
// integration branch, who may run the tests.
//
// Design: docs/DESIGN.md#scheduling, docs/DESIGN.md#integration-branches.
//
// Why a lock-file pool. Parallelism lives at the leaves and is controlled from outside any one
// execution: every execution and every session on the machine shares `.agentics/.state/slots/`,
// and the pool survives any of them dying. Admission is decided here, inside leaf-open; the
// `schedule` boundary only decides which leaves are ready. The pool is arithmetic over files and
// events, so it costs no tokens and puts no model on the scheduling path.
//
// Why release needs no write. A slot names its holder leaf, and a slot is free the moment that
// leaf's derived status says it no longer runs (approved, merged, escalated, parked, or the leaf
// is gone). The status is derived from the effort's event log on every check, so a leaf that
// finished — or a session that died after recording that it finished — frees its slot without
// anyone remembering to delete a file. The files that do linger (a holder whose execution died
// mid-dispatch) are deleted by that execution's next preflight via `releaseSlots`, or by the user.
//
// Why a holder that is still `planned` occupies its slot. Leaf-open takes the slot BEFORE it
// appends `dispatched`, so for a moment the holder's status is `planned`. Were `planned` free, a
// second leaf-open inside that moment would take the same slot and the pool limit would break
// exactly when it is contended. So "not active" in the design's sense is read as "has moved past
// active": approved, merged, escalated, parked, or retired/unknown. `planned` and `active` hold.
//
// Why the mutex is held only for the check-and-write. The wait for a slot can last minutes; a
// mutex held across it would serialize every leaf-open on the machine behind the slowest one. So
// each attempt takes `slots/.mutex`, decides, writes (or not), and lets go; the waiting is a
// poll outside it, which costs nothing but a sleeping process.

import {
  readFileSync, readdirSync, rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { fnv1a } from './plan-digest.mjs'
import {
  configPath, effortStateDir, posix, projectStateDir, safeSlug, slotsDir, withLock, withLockAsync, writeWhole,
} from './store.mjs'
import { readTree } from './tree.mjs'

const DEFAULT_MAX_PARALLEL = 4
// How long a slot is waited for when the caller names no `waitMs`; leaf-open asks once and hands
// `no_slot` back to the program, which waits.
const DEFAULT_WAIT_MS = 90000
const DEFAULT_POLL_MS = 2000
const DEFAULT_BRANCH_WAIT_MS = 10 * 60 * 1000
const TEST_WAIT_MS = 4 * 60 * 60 * 1000

/** Statuses under which a slot's holder still occupies it. See the header for why `planned` does. */
const OCCUPYING = new Set(['active', 'planned'])

const SLOT_FILE = /^([1-9][0-9]*)\.lock$/

// ------------------------------------------------------------------ paths

const mutexPath = (repo) => join(slotsDir(repo), '.mutex')
const slotPath = (repo, n) => join(slotsDir(repo), n + '.lock')
const testLockPath = (repo) => join(projectStateDir(repo), 'locks', 'tests.lock')
const branchLockPath = (repo, effort, branch) =>
  join(effortStateDir(repo, effort), 'locks', 'branch', fnv1a(String(branch)) + '.lock')

const readJsonFile = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const listDir = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// ------------------------------------------------------------------ the pool size

/**
 * The pool size and, when `.agentics/config.json` could not be used, why. Read on every call —
 * never cached — so an edit to it takes effect at the next leaf-open in every execution.
 * A missing file is the default without comment; a present but unusable one is the default WITH a
 * note, because a limit the user wrote and the tool silently ignored reads like a limit obeyed.
 *
 * @returns {{max_parallel: number, note: string}}
 */
export function poolConfig(repo) {
  const path = configPath(repo)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { max_parallel: DEFAULT_MAX_PARALLEL, note: '' }
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { max_parallel: DEFAULT_MAX_PARALLEL, note: posix(path) + ' is not JSON — using the default max_parallel ' + DEFAULT_MAX_PARALLEL }
  }
  const n = value && typeof value === 'object' ? value.max_parallel : undefined
  if (!Number.isInteger(n) || n < 1) {
    return {
      max_parallel: DEFAULT_MAX_PARALLEL,
      note: posix(path) + ' max_parallel ' + JSON.stringify(n ?? null) +
        ' is not an integer ≥ 1 — using the default ' + DEFAULT_MAX_PARALLEL,
    }
  }
  return { max_parallel: n, note: '' }
}

/** How many leaves may run at once, machine-wide. */
export const maxParallel = (repo) => poolConfig(repo).max_parallel

// ------------------------------------------------------------------ holders

/**
 * A per-call cache of derived statuses, one `readTree` per effort. Per call, never longer: a
 * status is derived fresh at every attempt, because the point of polling is to see it change.
 */
function statusReader(repo) {
  const trees = new Map()
  return ({ effort, node }) => {
    if (!safeSlug(effort)) return null
    if (!trees.has(effort)) {
      let tree = null
      try {
        tree = readTree(repo, effort)
      } catch {
        tree = null
      }
      trees.set(effort, tree)
    }
    const tree = trees.get(effort)
    // `liveNodes` drops retired revisions, so a retired node and an unknown one both read null.
    // So does a node a replan turned into a composite: a composite writes nothing and holds
    // nothing, and the leaf that took the claim no longer exists — its children must not wait on it.
    if (!tree || !tree.nodes.has(node) || tree.nodes.get(node).kind !== 'leaf') return null
    const s = tree.status.get(node)
    return s ? s.status : null
  }
}

/** The default slot predicate over a status reader. */
const occupyingBy = (statusOf) => (holder) => OCCUPYING.has(statusOf(holder))

/** Every slot file on disk, any index, with its holder (null when unreadable). */
function readSlots(repo) {
  const out = []
  for (const name of listDir(slotsDir(repo))) {
    const m = SLOT_FILE.exec(name)
    if (!m) continue
    const held = readJsonFile(join(slotsDir(repo), name))
    out.push({ n: Number(m[1]), holder: held && typeof held === 'object' ? held : null })
  }
  return out.sort((a, b) => a.n - b.n)
}

// ------------------------------------------------------------------ one attempt

/** One check-and-write, run under the mutex: a slot taken, or `no_slot` and the holders in the way. */
function attempt(repo, { effort, execution, node, holderActive }) {
  const notes = []
  const { max_parallel: max, note } = poolConfig(repo)
  if (note) notes.push(note)

  const slots = readSlots(repo)
  const mine = slots.filter((s) => s.holder && s.holder.effort === effort && s.holder.node === node)
  // Idempotent: a slot this node already holds, inside the current limit, is its slot. One held
  // above a shrunk limit is not reused — the limit is honoured at every leaf-open, fix rounds too.
  let slot = mine.find((s) => s.n <= max)?.n ?? null
  const busy = []
  if (slot === null) {
    const taken = new Map(slots.map((s) => [s.n, s.holder]))
    for (let n = 1; n <= max; n++) {
      const holder = taken.get(n)
      // A file above `max` never counts, so shrinking the pool cannot deadlock it: those holders
      // keep their files until released, and only indices 1..max are ever handed out.
      if (!holder || !holderActive({ effort: holder.effort, node: holder.node })) {
        slot = n
        break
      }
      busy.push({ n, effort: holder.effort, execution: holder.execution, node: holder.node })
    }
  }
  if (slot === null) return { ok: false, reason: 'no_slot', held_by: busy, notes }

  // The slot is (re)written so it names this execution, which is what `releaseSlots` at this
  // execution's postflight matches on.
  writeWhole(slotPath(repo, slot), { effort, execution, node })
  for (const s of mine) if (s.n !== slot) rmSync(slotPath(repo, s.n), { force: true })
  return { ok: true, slot, notes }
}

// ------------------------------------------------------------------ the entry points

/**
 * Take one slot for `node`, waiting until one comes free or `waitMs` passes, each pause an awaited
 * `sleep(ms)`, so the caller's event loop keeps running. The global mutex is held only for each
 * attempt.
 *
 * @param {string} repo
 * @param {{effort: string, execution: string, node: string,
 *   holderActive?: (h: {effort: string, node: string}) => boolean, waitMs?: number, pollMs?: number}} spec
 *   `holderActive` says whether a slot's holder still occupies it; the default derives it from the
 *   holder's effort tree (status `active` or `planned`; see the header).
 * @returns {Promise<{ok: true, slot: number, notes: string[]}
 *   | {ok: false, reason: 'no_slot'|'invalid', held_by: object[], notes: string[], error?: string}>}
 */
export async function acquireAsync(repo, spec = {}, { sleep = delay } = {}) {
  const { waitMs = DEFAULT_WAIT_MS, pollMs = DEFAULT_POLL_MS } = spec
  const refusal = requestOf(spec)
  if (refusal) return refusal
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    const result = tryAcquire(repo, spec)
    const pause = pauseAfter(result, deadline, pollMs)
    if (pause === null) return result
    await sleep(pause)
  }
}

/** An acquire's `invalid` refusal, or null when it names an effort and a node. */
function requestOf({ effort, node }) {
  const invalid = (error) => ({ ok: false, reason: 'invalid', held_by: [], notes: [], error })
  if (!safeSlug(effort)) return invalid('not an effort name: ' + JSON.stringify(effort))
  if (typeof node !== 'string' || node === '') return invalid('a node id is required')
  return null
}

/** One attempt that never waits, under the mutex: acquire's result as things stand. */
function tryAcquire(repo, { effort, execution, node, holderActive }) {
  const predicate = typeof holderActive === 'function' ? holderActive : occupyingBy(statusReader(repo))
  return withLock(mutexPath(repo), () =>
    attempt(repo, { effort, execution: String(execution || ''), node, holderActive: predicate }))
}

/** How long to pause before the next attempt, or null when `result` is the answer. */
function pauseAfter(result, deadline, pollMs) {
  if (result.ok) return null
  const left = deadline - Date.now()
  return left <= 0 ? null : Math.min(Math.max(1, pollMs), left)
}

/**
 * Delete the slot files held by one execution (and, given `node`, by that node only) — preflight
 * of a resume, and postflight. A slot is normally freed by its holder's status alone; this is for
 * the holders that never reached a status that frees it.
 * @returns {{released: number[]}} the slot indices released
 */
export function releaseSlots(repo, { effort, execution, node } = {}) {
  return withLock(mutexPath(repo), () => {
    const released = []
    for (const { n, holder } of readSlots(repo)) {
      if (!holder || holder.effort !== effort) continue
      if (execution !== undefined && holder.execution !== execution) continue
      if (node !== undefined && holder.node !== node) continue
      rmSync(slotPath(repo, n), { force: true })
      released.push(n)
    }
    return { released }
  })
}

/**
 * Run `fn` holding the exclusive lock on one integration branch, so merges into it serialize
 * across executions; the lock is waited for with an awaited `sleep`, so the caller's event loop
 * keeps running. `fn` may be async: the branch is held until the promise it returns settles.
 *
 * The lock's holder file holds `{pid, host, at}` (what `withLockAsync` writes). A holder on this
 * host is never broken while its pid lives, however long it verifies; a dead one always is.
 */
export async function withBranchLockAsync(repo, effort, branch, fn, { waitMs = DEFAULT_BRANCH_WAIT_MS, sleep } = {}) {
  if (!safeSlug(effort)) throw new Error('not an effort name: ' + JSON.stringify(effort))
  return withLockAsync(branchLockPath(repo, effort, branch), fn, { waitMs, sleep })
}

/**
 * Run `fn` holding the project's test lock, so one test run at a time happens across every
 * execution and session: suites that share the machine time out for it. `fn` must be synchronous.
 * The wait is long because its caller is a verify child, which no host time limit cuts off.
 */
export function withTestLock(repo, fn, { waitMs = TEST_WAIT_MS } = {}) {
  return withLock(testLockPath(repo), fn, { waitMs })
}

/**
 * What is held right now, for status: every slot file (including any above a shrunk limit, whose
 * holders keep them until released) with whether its holder still occupies it. Read without the
 * mutex — a snapshot for a human, not a decision.
 */
export function heldBy(repo) {
  const { max_parallel, note } = poolConfig(repo)
  const occupying = occupyingBy(statusReader(repo))
  const slots = readSlots(repo).map(({ n, holder }) => ({
    n,
    effort: holder?.effort ?? null,
    execution: holder?.execution ?? null,
    node: holder?.node ?? null,
    active: holder ? occupying({ effort: holder.effort, node: holder.node }) : false,
  }))
  return { max_parallel, slots, notes: note ? [note] : [] }
}
