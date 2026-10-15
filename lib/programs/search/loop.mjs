// lib/programs/search/loop.mjs — one search: the ground table resolved once, one navigator session
// resumed turn by turn over code's tools and sent what changed since it was last briefed, the
// ledger folded from the records after every return, and one ruler step per turn for the asks a
// stall made due or a check-in found moved. No count ends a search.
//
// Design: docs/DESIGN.md#searches and docs/DESIGN.md#l2--states-end-work-counts-dont.

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { FOLD_LEVELS, briefOf, chargeOf, rulerBrief } from '../../briefs/search.mjs'
import { loadRole, promptFile } from '../../roles.mjs'
import { promptDigestOf } from '../../runner.mjs'
import { coverageLines, fileGroups, foldLedger, standingRefusals, stateOf } from '../../search/ledger.mjs'
import { groundTable, scopeFiles } from '../../search/resolve.mjs'
import { TOOLS_BY_DOMAIN, mcpConfigFor, openCalls, searchDir } from '../../search/server.mjs'
import { dispatchKey, mkdirState, writeWhole } from '../../store.mjs'
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
const rowsOf = (table) => (table && Array.isArray(table.rows) ? table.rows : [])
const ownsRow = (rows, key) => rows.some((r) => Array.isArray(r.asks) && r.asks.includes(key))

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
 * The ground the fold reads: the search's table plus, for each ask that joined after turn 1, the
 * rows its `find` resolves to under its scope, owned by that ask alone (`<name>/ground:<ask>`).
 */
async function foldGround(ctx, { name, tree, ground, asks, config }) {
  const rows = [...rowsOf(ground)]
  for (const a of asks.filter((x) => x.from > 1)) {
    const own = await step(ctx, name + '/ground:' + a.key, () =>
      groundFor(ctx, tree, { material: [{ label: a.key, text: a.find, asks: [a.key] }], scope: a.scope, config }))
    rows.push(...rowsOf(own).map((r) => ({ ...r, asks: [a.key] })))
  }
  return { ...ground, rows }
}

/**
 * The asks as the fold takes them: a repo ask open from turn 1 with no seed and no ground row of its
 * own carries `owes`, its scope's files, listed once (`<name>/owes:<ask>`).
 */
async function owing(ctx, { name, tree, ground, asks }) {
  const rows = rowsOf(ground)
  const out = []
  for (const a of asks) {
    const owes = a.domain === 'repo' && a.from === 1 && !(a.seeds || []).length && !ownsRow(rows, a.key)
    out.push(owes ? { ...a, owes: await step(ctx, name + '/owes:' + a.key, () => (ctx.scopeFilesOf || scopeFiles)(tree, a.scope)) } : a)
  }
  return out
}

/**
 * The WebSearch calls the host ran on the thread, each appended once to the call log as a
 * search-wide `websearch` record (`from_log` its `tool_used` entry), numbered after the log's last.
 */
function journalWebSearches(ctx, thread, callLog) {
  const used = ctx.log.entries().filter((e) => e.kind === 'tool_used' && e.thread === thread && e.tool === 'WebSearch')
  if (used.length === 0) return
  mkdirState(join(callLog, '..'))
  const held = openCalls(callLog)
  const journaled = new Set(held.map((c) => c.from_log))
  let seq = lastSeq(held)
  for (const e of used.filter((u) => !journaled.has(u.seq))) {
    const record = { seq: ++seq, tool: 'websearch', args: { query: e.input && e.input.query }, asks: [], ok: true, keys: [], observed: [], from_log: e.seq }
    appendFileSync(callLog, JSON.stringify(record) + '\n')
  }
}

/** Whether the thread's next call starts a new session for a changed system prompt or cwd, as `dispatch` decides it. */
function promptMoved(ctx, { thread, role, charge, cwd }) {
  const last = ctx.log.entries().findLast((e) => e.kind === 'dispatched' && e.thread === thread)
  const loaded = loadRole(role)
  if (!last || !loaded.ok) return false
  const prompt = promptDigestOf(promptFile(loaded.role, ctx.dir, charge))
  return (last.prompt !== undefined && last.prompt !== prompt) || (last.cwd !== undefined && last.cwd !== cwd)
}

/**
 * The turn the session the thread holds now was last briefed on (docs/DESIGN.md#searches): the
 * latest turn whose dispatch returned in it, else 0 (a session no turn returned in holds nothing).
 * A compaction during that turn, or a resume that opened below what the session read before, is 0.
 */
function briefedAt(ctx, { thread, role, turns, session }) {
  const returned = ctx.log.entries().filter((e) => e.kind === 'returned' && e.session === session)
  const measured = returned.filter((e) => typeof e.context === 'number')
  for (const t of [...turns].reverse()) {
    if (!t.output) continue
    const key = dispatchKey({ node: '', role, thread, round: t.turn })
    const own = returned.filter((e) => e.dispatch === key)
    if (!own.some((e) => e.status === 'returned')) continue
    const lost = own.some((e) => e.compacted) || own.some((e) => {
      const before = measured[measured.indexOf(e) - 1]
      return typeof e.opened === 'number' && before !== undefined && measured.includes(e) && e.opened < before.context
    })
    return lost ? 0 : t.turn
  }
  return 0
}

/** The text of each hit line of `keys` on the pinned tree, keyed `<key>:<line>` as the ruler brief cites it. */
function hitLines(tree, ledger, keys) {
  const lines = {}
  const files = new Map()
  for (const h of keys.flatMap((k) => (ledger.asks[k] ? ledger.asks[k].hits : []))) {
    if (!(h.line > 0)) continue
    if (!files.has(h.key)) {
      const path = join(tree.root, h.key)
      files.set(h.key, existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [])
    }
    const text = files.get(h.key)[h.line - 1]
    if (text !== undefined) lines[h.key + ':' + h.line] = text.replace(/\r$/, '')
  }
  return lines
}

/**
 * The ruling after turn `turn`: the asks a stall made due and those a check-in found moved go to a
 * ruler that is none of the navigator's sessions, on the pinned tree, one unit per ask. What its
 * return leaves unruled, or every ask when it fails, is ruled again at once on the same ledger. Each
 * round's brief is kept at `<search dir>/rulings/<turn>-<round>.md`. Each dispatch is one Ruling
 * record, `{turn, asks, units}` or `{turn, asks, missing}`. Journaled as one step, so a relaunch
 * never rules a turn twice.
 */
function checkIn(ctx, { name, thread, turn, asks, ledger, intelligence, tree, dir }) {
  // the ruler's thread is named after the search's whole key, outside any scope prefix
  const at = 'ruler:search:' + thread + ':' + turn
  const top = { ...ctx, prefix: '' }
  return step(ctx, name + '/ruling:' + turn, async () => {
    const judge = threadOf(top, { role: 'ruler', thread: at })
    const rule = async (round, keys) => {
      const brief = rulerBrief(ledger, { asks: keys, turn, lines: hitLines(tree, ledger, keys) })
      writeWhole(join(dir, 'rulings', turn + '-' + round + '.md'), brief)
      const out = await dispatchJudge({
        producer: sessionsOf(ctx, thread),
        judge: { session: judge.session, thread: judge.key },
        run: () => dispatch(top, { role: 'ruler', schema: 'ruler_search', thread: at, round, intelligence, cwd: tree.root, brief }),
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

/** Pure. An ask's agenda as a result reports it: `file` items folded to one `files` item per directory. */
const unreachedOf = (agenda) => [
  ...agenda.filter((f) => f.kind !== 'file'),
  ...fileGroups(agenda.filter((f) => f.kind === 'file').map((f) => f.key)).map(({ dir, n }) => ({ kind: 'files', key: dir + '/', detail: n + ' not covered' })),
]

/** Pure. The coverage lines one ask owns, out of the search's. */
function linesOf(coverage, name, key) {
  const mine = (line) => line.startsWith(name + ':' + key + ': ')
  return {
    declared: coverage.declared.filter(mine), incomplete: coverage.incomplete.filter(mine),
    unreached: coverage.unreached.filter(mine), failed: coverage.failed_channels.filter((line) => line === name + ':' + key),
  }
}

/** Pure. What a search hands its program. */
function resultOf({ name, tree, ground, ledger, turns, sessions }) {
  const all = Object.values(ledger.asks)
  const coverage = coverageLines(ledger, name)
  const asks = Object.fromEntries(all.map((a) => [a.key, {
    end: a.end ? a.end.state : null, answer: (a.end && a.end.answer) || '', label: a.end ? a.end.label : '', why: a.end ? a.end.why : '',
    declared: a.declared, hits: a.hits, dismissed: a.dismissed, looked: a.looked, unreached: unreachedOf(a.agenda),
    lines: linesOf(coverage, name, a.key),
  }]))
  const distinct = (list) => new Set(list.flatMap((a) => a.hits.map((h) => h.key))).size
  const kindOf = (a) => a.key.split(':')[0]
  const kinds = Object.fromEntries([...new Set(all.map(kindOf))].map((kind) => [kind, distinct(all.filter((a) => kindOf(a) === kind))]))
  const returned = turns.length === 0 || turns.some((t) => t.output)
  const last = turns[turns.length - 1]
  return {
    name, status: returned ? 'returned' : 'failed', cause: returned ? '' : last.missing || last.stop,
    tree, ground, asks, sessions, entries_n: distinct(all), kinds, refusals: standingRefusals(ledger), coverage, queries: ledger.queries,
  }
}

/**
 * Run one search until no ask is open (docs/DESIGN.md#searches). Its ground table is resolved once
 * through `groundFor`, or is the one the program hands over (a survey's topics share one); either
 * way the `<name>/ground` step records it. A turn is one dispatch on the search's thread, round =
 * the turn: the session gets what changed since the turn it was last briefed on, a fresh, renewed or
 * compacted one the whole state, and a refused prompt is sent again more folded. After each return
 * the host's WebSearch calls join the call log, the ledger is folded, and the asks a stall made due
 * or a check-in found moved go to one ruling. A turn without a return is the next turn's to repeat;
 * the fold stops the asks a second one in a row leaves open. Re-entrant: called again with more
 * asks, it replays every journaled turn and goes on in the same session and charge.
 */
export async function search(ctx, spec) {
  const { name, role, schema, tree, material = [], config = {}, diff = null, intelligence = 'normal', base = '' } = spec
  const domain = spec.asks[0].domain
  if (spec.asks.some((a) => a.domain !== domain)) throw new Error('the search ' + name + ' mixes the domains of its asks')
  const thread = threadOf(ctx, { role, thread: name }).key
  const dir = searchDir(ctx.dir, thread)
  const callLog = join(dir, 'calls.jsonl')
  const ground = await step(ctx, name + '/ground', () => spec.ground ?? groundFor(ctx, tree, { material, scope: scopeOf(spec.asks), diff, config }))
  const joinedAsks = await joined(ctx, name, spec.asks)
  const folding = await foldGround(ctx, { name, tree, ground, asks: joinedAsks, config })
  const asks = await owing(ctx, { name, tree, ground: folding, asks: joinedAsks })
  const charge = chargeOf({ domain, asks: spec.asks.filter((_, i) => asks[i].from === 1), material, ground })
  const mcpConfig = mcpConfigFor(ctx.dir, thread, {
    tree, asks: asks.map((a) => ({ key: a.key, scope: a.scope, domain: a.domain })), tools: TOOLS_BY_DOMAIN[domain], calls: callLog,
  })
  const turns = []
  const rulings = []
  const foldThrough = (n) => {
    const upto = turns.slice(0, n)
    const through = upto.length ? upto[upto.length - 1].calls_through : 0
    return foldLedger({ asks, ground: folding, calls: callsIn(callLog).filter((c) => c.seq <= through), turns: upto, rulings })
  }
  let ledger = foldThrough(0)
  for (let turn = 1; openOf(ledger).length > 0; turn++) {
    const session = threadOf(ctx, { role, thread: name }).session
    const at = promptMoved(ctx, { thread, role, charge, cwd: tree.root }) ? 0 : briefedAt(ctx, { thread, role, turns, session })
    const sessionBase = at > 0 ? foldThrough(at - 1) : null
    const refits = FOLD_LEVELS.filter((level) => level > 1).map((level) => briefOf(ledger, null, { level, turn }))
    const call = {
      role, schema, thread: name, round: turn, intelligence, base, cwd: tree.root, charge, mcpConfig, refits,
      brief: briefOf(ledger, sessionBase, { turn }), threadBrief: briefOf(ledger, null, { turn }),
      renewOnChange: true, resendOnCutOff: true,
    }
    let out = null
    const held = await step(ctx, name + '/turn:' + turn, async () => {
      out = await dispatch(ctx, call)
      journalWebSearches(ctx, thread, callLog)
      const after = lastSeq(callsIn(callLog))
      return out.status === 'returned' ? { calls_through: after } : { calls_through: after, missing: out.cause || 'failed' }
    })
    if (!held.missing && !out) out = await dispatch(ctx, call)
    turns.push(held.missing ? { turn, ...held } : { turn, output: out.output, calls_through: held.calls_through })
    ledger = foldThrough(turns.length)
    if (held.missing) continue
    const { toRuler } = stateOf(ledger, { turn, checkin: askAfter(turn) })
    if (toRuler.length > 0) {
      rulings.push(...await checkIn(ctx, { name, thread, turn, asks: toRuler, ledger, intelligence, tree, dir }))
      ledger = foldThrough(turns.length)
    }
  }
  return resultOf({ name, tree, ground, ledger, turns, sessions: sessionsOf(ctx, thread) })
}
