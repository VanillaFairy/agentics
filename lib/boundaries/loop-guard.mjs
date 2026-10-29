// lib/boundaries/loop-guard.mjs — the one way code sends a producer back for more work, and the one
// place that decides such a loop is going nowhere: from the state the send-backs left, never a count.
//
// Design: docs/DESIGN.md#l2--states-end-work-counts-dont.

import { message } from './records.mjs'

/** The messages that hand a producer more work: only `sendBack` records them. */
export const SEND_BACKS = ['failures', 'rebase', 'surviving_mutations', 'needs_tests']

/**
 * What ends a loop of each kind, by the stop reason it records:
 * - `unmoved`: a send-back at a head the node was already sent back at since it was cleared — the
 *   round in between claimed its work and moved nothing;
 * - `repeated`: the same failures as the kind's previous send-back, at a moved head;
 * - `recurred`: the same exact state as any earlier send-back of the kind.
 * A kind with none records history only.
 */
const KINDS = {
  verification: { unmoved: 'fix_without_commits', repeated: 'verify_not_converging' },
  discriminator: { unmoved: 'fix_without_commits' },
  integration: { unmoved: 'fix_without_commits', repeated: 'verify_not_converging' },
  // A test round may answer survivors by redeclaring a mutation, with no commit: the survivors are the state.
  mutations: { recurred: 'verify_not_converging' },
  merge: { unmoved: 'merge_conflict' },
  adhoc: { recurred: 'blocked' },
  rebase: {},
  needs_tests: {},
}

const list = (v) => (Array.isArray(v) ? v : [])

/**
 * Pure. Where a node's loop history starts: its latest replan (a retry is one) or its own revision,
 * as its status reads it. A send-back before it was answered by the user's word or a new plan.
 */
export function clearedAt(node, events) {
  const replans = list(events).filter((e) => e.kind === 'replanned' && e.node === node.id).map((e) => e.seq || 0)
  return Math.max(node.seq || 0, ...replans)
}

/** Pure. The guarded send-backs of `node` since `since` and before round `round`, oldest first. */
export function sendBacks(events, node, since, round) {
  return list(events).filter((e) => e.kind === 'message' && e.node === node && e.guard && (e.seq || 0) > since && e.round < round)
    .sort((a, b) => a.seq - b.seq)
}

/** Pure. Every file a `discriminator` send-back of `history` named: what the producer was already told about. */
export const sentBackFiles = (history) => [...new Set(history.filter((e) => e.guard.kind === 'discriminator').flatMap((e) => String(e.guard.key).split('\n')).filter(Boolean))]

/**
 * Pure. Send `node`'s producer back on `thread` with message `msg` for `round`, or stop the loop
 * (docs/DESIGN.md#l2--states-end-work-counts-dont). `guard` names the loop's `kind` (`KINDS`), its
 * state `key` and the head `at` the work is sent back at. Returns `{record}`, the message, or
 * `{stop: {reason, detail}}`. A send-back recorded for the same round already is the same one
 * replayed, never history.
 *
 * @param {object[]} history `sendBacks` of the node
 * @param {{node: string, thread: string, msg: string, payload: object, round: number, from?: string,
 *   guard: {kind: string, key: string, at: string}}} sent
 */
export function sendBack(history, { node, thread, msg, payload, round, from = 'code', guard }) {
  const ends = KINDS[guard.kind]
  if (!ends) throw new Error('no loop kind ' + guard.kind)
  if (!SEND_BACKS.includes(msg)) throw new Error(msg + ' hands a producer no work')
  const at = String(guard.at || '')
  const key = String(guard.key || '')
  const short = (sha) => sha.slice(0, 8)
  const unmoved = at && history.find((e) => e.guard.at === at)
  if (ends.unmoved && unmoved) {
    return { stop: { reason: ends.unmoved, detail: 'sent back at ' + short(at) + ' already (' + unmoved.guard.kind + ', round ' + unmoved.round + ') and returned it unmoved' } }
  }
  const mine = history.filter((e) => e.guard.kind === guard.kind)
  const previous = mine[mine.length - 1]
  if (ends.repeated && key && previous && previous.guard.key === key && previous.guard.at !== at) {
    return { stop: { reason: ends.repeated, detail: 'the same failures as round ' + previous.round + ', at a moved head' } }
  }
  const before = mine.find((e) => e.guard.key === key)
  if (ends.recurred && before) {
    return { stop: { reason: ends.recurred, detail: 'sent back for the same ' + guard.kind + ' in round ' + before.round + ' already' } }
  }
  const record = message(node, thread, msg, payload, round, from)
  return { record: { ...record, fields: { ...record.fields, guard: { kind: guard.kind, key, at } } } }
}

/** A compiler diagnostic's head, `file(line,col): error TS1234` or `file:line:col - error TS1234`. */
const DIAGNOSTIC = /([\w./\\@-]+)(?:\((\d+),\d+\)|:(\d+):\d+)\s*:?\s*-?\s*error\s+([A-Z]+\d+)/g
/** A failing test's line, as the common runners print one. */
const FAILING_TEST = /^\s*(?:✖|×|✗|FAIL\b|not ok \d+ -)\s*(.+)$/

/**
 * Pure. What a failure's evidence names as failed, each as often as it is named: a compiler
 * diagnostic as `file:code`, its line dropped so an edit that only moved it is no progress, and a
 * failing test's line with its duration dropped. Fixing one diagnostic of three that share a code
 * moves it. Evidence naming neither gives ''.
 */
function diagnosticsOf(evidence) {
  const text = String(evidence || '')
  const out = [...text.matchAll(DIAGNOSTIC)].map((m) => m[1].replace(/\\/g, '/') + ':' + m[4])
  for (const line of text.split(/\n|; /)) {
    const t = FAILING_TEST.exec(line)
    if (t) out.push(t[1].replace(/\(?\d+(\.\d+)?\s*(ms|s)\)?/g, '').replace(/\s+/g, ' ').trim())
  }
  return out.sort().join('\n')
}

/** Pure. A set of failures as a loop's state: each failure's check, claim and what its evidence names failed. */
export const failuresKey = (failures) => list(failures).map((f) => f.check + ':' + f.claim + ':' + diagnosticsOf(f.evidence)).sort().join('|')
