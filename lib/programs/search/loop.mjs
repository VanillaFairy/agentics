// lib/programs/search/loop.mjs — one search: the ground table resolved once, one navigator session
// resumed turn by turn over code's tools, the ledger folded from the records after every return,
// each ask ended on its state, and a separate ruler at the check-ins. No count ends a search.
//
// Design: docs/DESIGN.md#searches and docs/DESIGN.md#l2--states-end-work-counts-dont.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { BRIEF_BUDGET_CHARS, chargeOf, digestOf, rulerBrief, turnBrief } from '../../briefs/search.mjs'
import { coverageLines, foldLedger, stateOf } from '../../search/ledger.mjs'
import { groundTable } from '../../search/resolve.mjs'
import { TOOLS_BY_DOMAIN, mcpConfigFor, searchDir } from '../../search/server.mjs'
import { dispatch, dispatchJudge, step, stepped, threadOf } from '../common.mjs'
import { askAfter } from '../converge.mjs'

/** The ground table of a search: the one seam a test replaces (`ctx.groundOf`). */
export function groundFor(ctx, tree, opts) {
  return (ctx.groundOf || groundTable)(tree, opts)
}

/** The call log's records in order. A line that does not parse was cut short before its call answered. */
function callsIn(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : []
    } catch {
      return []
    }
  })
}

const lastSeq = (calls) => calls.reduce((n, c) => Math.max(n, c.seq), 0)
const scopeOf = (asks) => [...new Set(asks.flatMap((a) => a.scope))].sort()
const openOf = (ledger) => Object.values(ledger.asks).filter((a) => !a.end).map((a) => a.key)

/** Every session the navigator's thread ran in, oldest first: the producers no ruler may be. */
const sessionsOf = (ctx, thread) =>
  [...new Set(ctx.log.entries().filter((e) => e.kind === 'dispatched' && e.thread === thread).map((e) => e.session))]
    .map((session) => ({ session, thread }))

/**
 * Each ask with the first turn it is open for (`from`): the first call's asks from turn 1, the
 * asks a later call adds (a consumer's wants) from the turn after those journaled before it. The
 * joining is journaled (`<name>/asks:<n>`), so a relaunch folds every ask from the same turn.
 */
async function joined(ctx, name, asks) {
  const head = name + '/asks:'
  const from = new Map(stepped(ctx, (e) => e.key.startsWith(head))
    .flatMap((e) => e.value.map((key) => [key, Number(e.key.slice(head.length)) + 1])))
  const fresh = asks.filter((a) => !from.has(a.key)).map((a) => a.key)
  if (fresh.length > 0) {
    const at = stepped(ctx, (e) => e.key.startsWith(name + '/turn:')).length
    for (const key of await step(ctx, head + at, () => fresh)) from.set(key, at + 1)
  }
  return asks.map((a) => ({ ...a, from: from.get(a.key) ?? 1 }))
}

/**
 * The check-in after turn `turn`: the asks whose state moved go to a ruler that is none of the
 * navigator's sessions, one unit per ask. What its return leaves unruled, or every ask when it
 * fails, is ruled again at once on the same ledger. Each dispatch is one Ruling record,
 * `{turn, asks, units}` or `{turn, asks, missing}`, and the fold counts the misses. Journaled as
 * one step, so a relaunch never rules a turn twice.
 */
function checkIn(ctx, { name, thread, turn, asks, ledger, intelligence }) {
  const at = 'ruler:search:' + name + ':' + turn
  return step(ctx, name + '/ruling:' + turn, async () => {
    const judge = threadOf(ctx, { role: 'ruler', thread: at })
    const rule = async (round, keys) => {
      const out = await dispatchJudge({
        producer: sessionsOf(ctx, thread),
        judge: { session: judge.session, thread: judge.key },
        run: () => dispatch(ctx, {
          role: 'ruler', schema: 'ruler_search', thread: at, round, intelligence, brief: rulerBrief(ledger, { asks: keys, turn }),
        }),
      })
      return out.status === 'returned' && Array.isArray(out.output.units)
        ? { turn, asks: keys, units: out.output.units.filter((u) => keys.includes(u.unit)) }
        : { turn, asks: keys, missing: out.cause || (out.error && out.error.kind) || 'failed' }
    }
    const first = await rule(1, asks)
    const left = first.units ? asks.filter((key) => !first.units.some((u) => u.unit === key)) : asks
    return left.length === 0 ? [first] : [first, await rule(2, left)]
  })
}

/** Pure. What a search hands its program. */
function resultOf({ name, tree, ground, ledger, turns, sessions }) {
  const all = Object.values(ledger.asks)
  const asks = Object.fromEntries(all.map((a) => [a.key, {
    end: a.end ? a.end.state : null, label: a.end ? a.end.label : '', why: a.end ? a.end.why : '',
    declared: a.declared, absence: a.absence, hits: a.hits, dismissed: a.dismissed, unreached: a.frontier,
  }]))
  const distinct = (list) => new Set(list.flatMap((a) => a.hits.map((h) => h.key))).size
  const kindOf = (a) => a.key.split(':')[0]
  const kinds = Object.fromEntries([...new Set(all.map(kindOf))].map((kind) => [kind, distinct(all.filter((a) => kindOf(a) === kind))]))
  const returned = turns.length === 0 || turns.some((t) => t.output)
  const last = turns[turns.length - 1]
  return {
    name, status: returned ? 'returned' : 'failed', cause: returned ? '' : last.missing || last.stop,
    tree, ground, asks, sessions, entries_n: distinct(all), kinds, coverage: coverageLines(ledger, name),
  }
}

/**
 * Run one search until no ask is open (docs/DESIGN.md#searches). Its ground table is resolved once
 * through `groundFor`, or is the one the program hands over (a survey's topics share one); either
 * way the `<name>/ground` step records it. A turn is one dispatch on the search's thread, round =
 * the turn: the first starts the navigator's session, every later one resumes it. After each
 * return the ledger is folded from the journal and the call log, and the asks end on its state; at
 * an `askAfter` turn the asks whose state moved go to the ruler. A turn without a return is the next
 * turn's to repeat; the fold stops the asks a second one in a row leaves open. A digest that cannot
 * fit its budget stops the open asks before the turn is dispatched. Re-entrant: called again with
 * more asks, it replays every journaled turn and goes on in the same session and charge.
 */
export async function search(ctx, spec) {
  const { name, role, schema, tree, material = [], config = {}, diff = null, intelligence = 'normal', base = '' } = spec
  const domain = spec.asks[0].domain
  if (spec.asks.some((a) => a.domain !== domain)) throw new Error('the search ' + name + ' mixes the domains of its asks')
  const thread = threadOf(ctx, { role, thread: name }).key
  const callLog = join(searchDir(ctx.dir, thread), 'calls.jsonl')
  const ground = await step(ctx, name + '/ground', () => spec.ground ?? groundFor(ctx, tree, { material, scope: scopeOf(spec.asks), diff, config }))
  const asks = await joined(ctx, name, spec.asks)
  const charge = chargeOf({ domain, asks: spec.asks.filter((_, i) => asks[i].from === 1), material, ground })
  const budget = Math.max(0, BRIEF_BUDGET_CHARS - charge.length)
  const mcpConfig = mcpConfigFor(ctx.dir, thread, {
    tree, asks: asks.map((a) => ({ key: a.key, scope: a.scope, domain: a.domain })), tools: TOOLS_BY_DOMAIN[domain], calls: callLog,
  })
  const turns = []
  const rulings = []
  const fold = () => {
    const through = turns.length ? turns[turns.length - 1].calls_through : 0
    return foldLedger({ asks, ground, calls: callsIn(callLog).filter((c) => c.seq <= through), turns, rulings })
  }
  let ledger = fold()
  for (let turn = 1; openOf(ledger).length > 0; turn++) {
    const threadBrief = digestOf(ledger, { budget })
    const call = {
      role, schema, thread: name, round: turn, intelligence, base, cwd: tree.root, charge, mcpConfig, threadBrief,
      brief: turnBrief(ledger, { turn, joined: asks.filter((a) => a.from === turn && turn > 1).map((a) => a.key) }),
    }
    let out = null
    const held = await step(ctx, name + '/turn:' + turn, async () => {
      const through = lastSeq(callsIn(callLog))
      if (threadBrief.length > budget) return { calls_through: through, stop: 'brief_over_budget' }
      out = await dispatch(ctx, call)
      const after = lastSeq(callsIn(callLog))
      return out.status === 'returned' ? { calls_through: after } : { calls_through: after, missing: out.cause || 'failed' }
    })
    if (!held.missing && !held.stop && !out) out = await dispatch(ctx, call)
    turns.push(held.missing || held.stop ? { turn, ...held } : { turn, output: out.output, calls_through: held.calls_through })
    ledger = fold()
    if (held.missing || held.stop) continue
    const { toRuler } = stateOf(ledger, { turn, checkin: askAfter(turn) })
    if (toRuler.length > 0) {
      rulings.push(...await checkIn(ctx, { name, thread, turn, asks: toRuler, ledger, intelligence }))
      ledger = fold()
    }
  }
  return resultOf({ name, tree, ground, ledger, turns, sessions: sessionsOf(ctx, thread) })
}
