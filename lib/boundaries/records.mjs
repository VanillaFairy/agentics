// lib/boundaries/records.mjs — the records a boundary decides: their builders, which of them are
// not yet the node's word, faults and the nodes they hold, and the one place they are appended.
//
// Design: docs/DESIGN.md#boundaries.

import { join } from 'node:path'

import { commandsOf } from '../gotchas.mjs'
import { readLog } from '../ledger.mjs'
import { releaseSlots } from '../locks.mjs'
import { canonical } from '../plan-digest.mjs'
import { executionDir, readJson, returnPath } from '../store.mjs'
import { readTree } from '../tree.mjs'

const list = (v) => (Array.isArray(v) ? v : [])
const seqOf = (e) => (e && Number.isInteger(e.seq) ? e.seq : -1)
const latest = (entries, pred) => entries.reduce((found, e) => (pred(e) && (!found || e.seq > found.seq) ? e : found), null)

/** Pure. The seq of the latest `run` line, -1 before any: what follows it is the current run's. */
const runSince = (state) => Math.max(-1, ...state.filter((e) => e.kind === 'run').map(seqOf))

// ------------------------------------------------------------------ builders

/** Pure. An escalation of `node`; `said` is the dispatch whose stored return holds the words. */
export const escalated = (node, reason, detail = '', said = '') =>
  ({ kind: 'escalated', fields: { node, reason, detail: String(detail || '').slice(0, 2000), ...(said ? { said } : {}) } })

/** Pure. A park of `node` on the return it waits for. */
export const parked = (node, ret, question = '', said = '') =>
  ({ kind: 'parked', fields: { node, return: ret, question: String(question || '').slice(0, 2000), ...(said ? { said } : {}) } })

/** Pure. */
export const approved = (node, head_sha, review_rounds, at_integration) =>
  ({ kind: 'approved', fields: { node, head_sha, review_rounds, at_integration } })

/** Pure. A message to `thread`, delivered by the next dispatch of that thread. */
export const message = (node, thread, msg, payload, round, from = 'code') =>
  ({ kind: 'message', fields: { node, thread, from, msg, payload, round } })

/** Pure. A plugin fault on `node`: never a question, held for the rest of the run. */
export const fault = (node, channel, detail) =>
  ({ kind: 'fault', fields: { node, channel, detail: String(detail || '').slice(0, 500) } })

// ------------------------------------------------------------------ the node's word

/**
 * Pure. Whether an affected ruling on its node is answered on disk: a revision of the node newer
 * than the ruling, or a stop or a replan on it after it.
 */
export function rulingAnswered(ruling, { nodes, events }) {
  if (((nodes.get(ruling.node) || {}).seq || 0) > ruling.seq) return true
  return events.some((e) => e.node === ruling.node && ['escalated', 'parked', 'replanned'].includes(e.kind) && e.seq > ruling.seq)
}

/**
 * Pure. A fault on `node`, and the `contract_drift` park when a ruler ruled the node's drift
 * affected and nobody has answered it: drift is found only on the batch that landed it, so a fault
 * alone would let the next run take the node up on a contract that moved.
 */
export function faultRecords(node, channel, detail, { nodes, events, state }) {
  const out = [fault(node, channel, detail)]
  const ruling = latest(state, (e) => e.kind === 'drift-ruled' && e.node === node)
  if (ruling && ruling.ruling === 'affected' && !rulingAnswered(ruling, { nodes, events })) {
    out.push(parked(node, 'contract_drift', '', ruling.said || ''))
  }
  return out
}

/**
 * Pure. Which of `records` are not yet the word on disk, each once. A boundary run again after a
 * crash finds its own records standing and lands nothing twice; the same decision taken anew —
 * after a retry cleared a stop, at another head, in a later run — lands again.
 *
 * @param {{kind: string, fields: object}[]} records
 * @param {{nodes: Map, status: Map, events: object[], state: object[], journal?: object[]}} disk
 *   the tree (`readTree`) and this execution's state and journal
 */
export function freshRecords(records, { nodes, status, events = [], state = [], journal = [] }) {
  const since = runSince(state)
  const stands = ({ kind, fields: e }) => {
    const now = status.get(e.node) || {}
    const last = now.last || {}
    switch (kind) {
      case 'escalated': return now.status === 'escalated' && last.kind === 'escalated' && last.reason === e.reason
      case 'parked': return now.status === 'parked' && last.kind === 'parked' && last.return === e.return
      // A node stopped while its chain ran is the user's first: its approval is derived again later.
      case 'approved': return ['escalated', 'parked', 'merged'].includes(now.status) || (now.status === 'approved' && last.head_sha === e.head_sha)
      case 'claims': {
        const c = latest(events, (x) => x.kind === 'claims' && x.node === e.node)
        if (!c || c.head_sha !== e.head_sha || c.review !== e.review) return false
        const cleared = Math.max(seqOf(latest(events, (x) => x.kind === 'replanned' && x.node === e.node)), (nodes.get(e.node) || {}).seq || 0)
        return c.seq > cleared
      }
      case 'fault': return state.some((x) => x.kind === 'fault' && x.node === e.node && x.channel === e.channel && seqOf(x) > since)
      case 'drift-ruled': return state.some((x) => x.kind === kind && x.node === e.node && x.contract === e.contract && x.head_sha === e.head_sha &&
        (x.adopted_seq ?? null) === (e.adopted_seq ?? null))
      case 'stale-ruled': return state.some((x) => x.kind === kind && x.node === e.node && x.base_now === e.base_now)
      // A message of execution '' is the migration's, numbered by a 4.x round: it never stands for a boundary's own.
      case 'message': return events.some((x) => x.kind === kind && x.execution !== '' && x.node === e.node && x.thread === e.thread && x.round === e.round && x.msg === e.msg)
      case 'series-done': return journal.some((x) => x.kind === kind && x.node === e.node && x.head_sha === e.head_sha)
      case 'authored': return journal.some((x) => x.kind === kind && x.node === e.node && x.sha === e.sha)
      default: return false
    }
  }
  const seen = new Set()
  return list(records).filter((r) => {
    const key = r.kind + canonical(r.fields)
    if (seen.has(key)) return false
    seen.add(key)
    return !stands(r)
  })
}

/** Pure. The nodes the current run holds on a fault: nothing takes them up again until the next run. */
export function heldOf(state) {
  const since = runSince(state)
  return new Set(state.filter((e) => e.kind === 'fault' && seqOf(e) > since).map((e) => e.node))
}

/** Pure. The stops and holds a call decided, as the program reads them. */
export const stopsOf = (records) => list(records).flatMap(({ kind, fields: e }) =>
  kind === 'escalated' ? [{ id: e.node, status: 'escalated', reason: e.reason, said: e.said || '' }]
    : kind === 'parked' ? [{ id: e.node, status: 'parked', reason: e.return, said: e.said || '' }]
      : kind === 'fault' ? [{ id: e.node, status: 'held', reason: e.channel, said: '' }]
        : [])

// ------------------------------------------------------------------ an execution

/**
 * What every boundary of one execution works over. `log` is the execution's log port
 * (`executionLog`): `append(kind, fields) → {seq}`, `entries()`.
 */
export function executionContext({ repo, effort, execution, log }) {
  const dir = executionDir(repo, effort, execution)
  return { repo, effort, execution, dir, log, envelope: () => readJson(join(dir, 'execution.json')) }
}

/** The dispatch's stored return, read only when its call returned (a `watch_failed` call's kept return is not). */
export function storedReturn(xc, dispatch) {
  const done = xc.log.entries().some((e) => e.kind === 'returned' && e.dispatch === dispatch && e.status === 'returned')
  return done ? readJson(returnPath(xc.dir, dispatch)) : null
}

/**
 * The commands verification runs: the `command` gotchas an investigator or the session wrote, and
 * nothing else. Preflight writes the session's commands, named and absent, as gotchas, so the
 * envelope's copy is never read here.
 */
export function commandsFor(xc) {
  const found = commandsOf(xc.repo, xc.effort)
  return {
    build: found.build, typecheck: found.typecheck, suite: found.suite, suiteFast: found.suite_fast, testOne: found.test_one,
    buildAbsent: found.absent.build, typecheckAbsent: found.absent.typecheck, suiteAbsent: found.absent.suite, suiteFastAbsent: found.absent.suite_fast,
  }
}

/** Pure. The fault channel of a dispatch that failed with the runner's `cause`: the host's, the user's checkout's, else the role's. */
export const channelOf = (cause) => (cause === 'host_error' ? 'host_error' : cause === 'checkout' || cause === 'watch_failed' ? 'checkout' : 'role')

/**
 * Append whichever of `records` are not on disk yet through the execution's port; a fault also
 * gives its node's slot back. The tree and the logs are read from disk, so a record a session CLI
 * or another process wrote counts as standing. `stops` are every record's, fresh or not.
 */
export function recordAll(xc, records) {
  const all = list(records)
  if (all.length === 0) return { recorded: [], stops: [] }
  const tree = readTree(xc.repo, xc.effort)
  const fresh = freshRecords(all, {
    nodes: tree.nodes, status: tree.status, events: tree.events,
    state: readLog(xc.repo, xc.effort, 'state:' + xc.execution).entries,
    journal: readLog(xc.repo, xc.effort, 'journal:' + xc.execution).entries,
  })
  const recorded = fresh.map((r) => ({ ...r, seq: xc.log.append(r.kind, r.fields).seq }))
  for (const r of all) {
    if (r.kind === 'fault') releaseSlots(xc.repo, { effort: xc.effort, execution: xc.execution, node: r.fields.node })
  }
  return { recorded, stops: stopsOf(all) }
}
