// lib/locks.mjs — the slot pool and the lock files: who may run a leaf now, who may write a file,
// who may merge into an integration branch.
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
//
// Why all or nothing. A leaf that took its slot and then found a locus path held would sit on the
// slot while waiting for the path, starving the leaves that could have run. So an attempt writes
// nothing unless it can write everything: every locus lock and the slot, together.

import {
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { fnv1a } from './plan-digest.mjs'
import {
  configPath, effortStateDir, effortsRoot, posix, projectStateDir, safePath, safeSlug, slotsDir, withLock, withLockAsync,
  mkdirState,
} from './store.mjs'
import { cycleOf, readTree } from './tree.mjs'

const DEFAULT_MAX_PARALLEL = 4
// How long a slot is waited for when the caller names no `waitMs`; leaf-open asks once and hands
// `no_slot` back to the program, which waits. Only a slot is waited for: a held locus frees at a
// merge, which the scheduler sees, so it is answered at once.
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
const locusDir = (repo, effort) => join(effortStateDir(repo, effort), 'locks', 'locus')
const testLockPath = (repo) => join(projectStateDir(repo), 'locks', 'tests.lock')
const branchLockPath = (repo, effort, branch) =>
  join(effortStateDir(repo, effort), 'locks', 'branch', fnv1a(String(branch)) + '.lock')

/** Pure. The lock-file name a locus path takes: its fnv1a, so any path is one flat file name. */
export const locusFileOf = (path) => fnv1a(path) + '.lock'

const readJsonFile = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Write a file whole or not at all: a reader outside the mutex never sees a torn holder. */
function writeAtomic(path, value) {
  mkdirState(join(path, '..'))
  const tmp = path + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(value), 'utf8')
  renameSync(tmp, path)
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

/** The current locus of a holder leaf, or null — a path a revision dropped is no longer claimed. */
function locusReader(repo) {
  return ({ effort, node }) => {
    try {
      const n = readTree(repo, effort).nodes.get(node)
      return n && n.kind === 'leaf' ? n.locus : null
    } catch {
      return null
    }
  }
}

/** The cycle a leaf belongs to, or [] — a cycle holds its files as one unit. */
function cycleReader(repo) {
  return ({ effort, node }) => {
    try {
      return cycleOf(readTree(repo, effort).nodes, node)
    } catch {
      return []
    }
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

/** Every locus lock of one effort, with its holder (null when unreadable). */
function readLocus(repo, effort) {
  const dir = locusDir(repo, effort)
  return listDir(dir).filter((name) => name.endsWith('.lock')).map((name) => {
    const held = readJsonFile(join(dir, name))
    return { file: name, holder: held && typeof held === 'object' ? held : null }
  })
}

// ------------------------------------------------------------------ one attempt

/**
 * The holders of any of `paths` other than `node` itself, with their status. An approved member of
 * `node`'s own cycle is not in the way: the cycle is cut as one chain of branches and lands as one
 * merge, so what a member wrote is already under the next one, which takes the lock over.
 */
function locusBlockers(repo, { effort, node, paths, statusOf, locusOf, matesOf }) {
  const blockers = []
  let mates = null
  for (const path of paths) {
    const held = readJsonFile(join(locusDir(repo, effort), locusFileOf(path)))
    if (!held || typeof held !== 'object') continue // absent, or debris nobody can name
    if (held.path === path && held.node === node) continue
    let status = ''
    if (held.path === path) {
      status = statusOf({ effort, node: held.node })
      if (status === null || status === 'merged') continue // retired, unknown, or its work has landed
      const claimed = locusOf({ effort, node: held.node })
      if (claimed && !claimed.includes(path)) continue // a revision took this path out of its locus
      if (status === 'approved') {
        mates = mates || matesOf({ effort, node })
        if (mates.includes(held.node)) continue
      }
    }
    // A different path under the same hash is treated as held: a collision must never let two
    // leaves write the same file, and waiting on one is merely slow.
    blockers.push({ effort, path: held.path, node: held.node, execution: held.execution, status: status || '' })
  }
  return blockers
}

/**
 * A reader of the leaf whose locus locks keep a node from opening, or '' when nothing holds a
 * path. It is the check leaf-open makes, so the scheduler never launches a leaf leaf-open would
 * turn away. One reader reads each holder's status once, however many nodes it is asked about.
 */
export function holderReader(repo) {
  const statusOf = statusReader(repo)
  const locusOf = locusReader(repo)
  const matesOf = cycleReader(repo)
  return ({ effort, node, locus = [] }) => {
    const paths = (Array.isArray(locus) ? locus : []).map(safePath).filter((p) => p !== null)
    const blockers = locusBlockers(repo, { effort, node, paths, statusOf, locusOf, matesOf })
    return blockers.length ? blockers[0].node : ''
  }
}

/**
 * One check-and-write, run under the mutex. Returns a success, or the reason and the holders in
 * the way. Writes nothing unless it writes everything.
 */
function attempt(repo, { effort, execution, node, paths, holderActive, statusOf, locusOf, matesOf }) {
  const notes = []
  const { max_parallel: max, note } = poolConfig(repo)
  if (note) notes.push(note)

  // Locus first: a path held by an unmerged sibling is ordered by a merge, which no amount of
  // free slots can hasten, so it is the more informative reason when both are busy.
  const blockers = locusBlockers(repo, { effort, node, paths, statusOf, locusOf, matesOf })
  if (blockers.length) return { ok: false, reason: 'locus_held', held_by: blockers, notes }

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

  // Everything is free: write it all. The slot is (re)written so it names this execution, which
  // is what `releaseSlots` at this execution's postflight matches on.
  for (const path of paths) {
    writeAtomic(join(locusDir(repo, effort), locusFileOf(path)), { path, node, execution })
  }
  writeAtomic(slotPath(repo, slot), { effort, execution, node })
  for (const s of mine) if (s.n !== slot) rmSync(slotPath(repo, s.n), { force: true })
  return { ok: true, slot, locks: paths, notes }
}

// ------------------------------------------------------------------ the entry points

/**
 * Take one slot and a lock on every locus path for `node`, all or nothing, waiting for a slot
 * until one comes free or `waitMs` passes, each pause an awaited `sleep(ms)`, so the caller's event
 * loop keeps running. A held locus is answered at once: it frees when its holder merges, and the
 * scheduler launches the leaf then. The global mutex is held only for each attempt.
 *
 * @param {string} repo
 * @param {{effort: string, execution: string, node: string, locus?: string[],
 *   holderActive?: (h: {effort: string, node: string}) => boolean, waitMs?: number, pollMs?: number}} spec
 *   `holderActive` says whether a slot's holder still occupies it; the default derives it from the
 *   holder's effort tree (status `active` or `planned`; see the header).
 * @returns {Promise<{ok: true, slot: number, locks: string[], notes: string[]}
 *   | {ok: false, reason: 'no_slot'|'locus_held'|'invalid', held_by: object[], notes: string[], error?: string}>}
 */
export async function acquireAsync(repo, spec = {}, { sleep = delay } = {}) {
  const { waitMs = DEFAULT_WAIT_MS, pollMs = DEFAULT_POLL_MS } = spec
  const { refusal, paths } = requestOf(spec)
  if (refusal) return refusal
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    const result = tryAcquire(repo, spec, paths)
    const pause = pauseAfter(result, deadline, pollMs)
    if (pause === null) return result
    await sleep(pause)
  }
}

/** The locus paths an acquire asks for, each once, or its `invalid` refusal. */
function requestOf({ effort, node, locus = [] }) {
  const invalid = (error) => ({ refusal: { ok: false, reason: 'invalid', held_by: [], notes: [], error } })
  if (!safeSlug(effort)) return invalid('not an effort name: ' + JSON.stringify(effort))
  if (typeof node !== 'string' || node === '') return invalid('a node id is required')
  const paths = []
  for (const raw of Array.isArray(locus) ? locus : []) {
    const p = safePath(raw)
    if (p === null) return invalid('not a repo-relative locus path: ' + JSON.stringify(raw))
    if (!paths.includes(p)) paths.push(p)
  }
  return { paths }
}

/** One attempt that never waits, under the mutex: acquire's result as things stand. */
function tryAcquire(repo, { effort, execution, node, holderActive }, paths) {
  const statusOf = statusReader(repo)
  const predicate = typeof holderActive === 'function' ? holderActive : occupyingBy(statusOf)
  return withLock(mutexPath(repo), () =>
    attempt(repo, { effort, execution: String(execution || ''), node, paths, holderActive: predicate, statusOf, locusOf: locusReader(repo), matesOf: cycleReader(repo) }))
}

/** How long to pause before the next attempt, or null when `result` is the answer. */
function pauseAfter(result, deadline, pollMs) {
  if (result.ok || result.reason === 'locus_held') return null
  const left = deadline - Date.now()
  return left <= 0 ? null : Math.min(Math.max(1, pollMs), left)
}

/**
 * Delete the locus locks held by `nodes` in one effort — merge-batch, once their work has landed.
 * Under the mutex, so a release cannot delete a lock another leaf-open has just taken over.
 * @returns {{released: string[]}} the paths released
 */
export function releaseLocus(repo, effort, nodes) {
  if (!safeSlug(effort)) return { released: [] }
  const ids = new Set(Array.isArray(nodes) ? nodes : [nodes])
  return withLock(mutexPath(repo), () => {
    const released = []
    for (const { file, holder } of readLocus(repo, effort)) {
      if (holder && ids.has(holder.node)) {
        rmSync(join(locusDir(repo, effort), file), { force: true })
        released.push(holder.path)
      }
    }
    return { released }
  })
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
 * holders keep them until released) with whether its holder still occupies it, and every locus
 * lock of every effort. Read without the mutex — a snapshot for a human, not a decision.
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
  const locus = []
  for (const effort of listDir(effortsRoot(repo)).filter((e) => safeSlug(e)).sort()) {
    for (const { holder } of readLocus(repo, effort)) {
      if (holder) locus.push({ effort, path: holder.path, node: holder.node, execution: holder.execution })
    }
  }
  locus.sort((a, b) => (a.effort + '\0' + a.path).localeCompare(b.effort + '\0' + b.path))
  return { max_parallel, slots, locus, notes: note ? [note] : [] }
}
