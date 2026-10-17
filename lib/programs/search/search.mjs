// lib/programs/search/search.mjs — one search: rounds of scout sessions over code's tools until a round adds no new hit,
// every call and finding journaled by the tool server as it goes, each round resumed or renewed by dispatch on that journal.
//
// Design: docs/DESIGN.md#searches.

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { callLines, resumeBrief, roundBrief, scoutCharge } from '../../briefs/search.mjs'
import { candidateKey, canonicalUrl } from '../../search/query.mjs'
import { STALL_WINDOW, TOOLS_BY_DOMAIN, mcpConfigFor, openCalls, searchDir } from '../../search/server.mjs'
import { dispatchKey, mkdirState } from '../../store.mjs'
import { dispatch, threadOf } from '../common.mjs'

export const ROLE_OF = { repo: 'scout', history: 'historian', web: 'doc-researcher' }

/** Every session the search's thread ran in, oldest first: the producers no judge of its hits may be. */
const sessionsOf = (ctx, thread) =>
  [...new Set(ctx.log.entries().filter((e) => e.kind === 'dispatched' && e.thread === thread).map((e) => e.session))]
    .map((session) => ({ session, thread }))

/** What the search's dispatch has cost: the cost the runner recorded on each of its calls. */
const spentOn = (ctx, key) => ctx.log.entries()
  .filter((e) => e.kind === 'returned' && e.dispatch === key && typeof e.cost_usd === 'number')
  .reduce((n, e) => n + e.cost_usd, 0)

/** The host's WebSearch calls on the thread, each appended once to the journal, numbered after its last record. */
function journalWebSearches(ctx, thread, callLog) {
  const entries = ctx.log.entries()
  const used = entries.filter((e) => e.kind === 'tool_used' && e.thread === thread && e.tool === 'WebSearch')
  if (used.length === 0) return
  mkdirState(join(callLog, '..'))
  const held = openCalls(callLog)
  const journaled = new Set(held.map((c) => c.from_log))
  let seq = held.reduce((n, c) => Math.max(n, c.seq || 0), 0)
  for (const e of used.filter((u) => !journaled.has(u.seq))) {
    const ran = entries.findLast((d) => d.kind === 'dispatched' && d.dispatch === e.dispatch && d.seq < e.seq)
    const record = { seq: ++seq, session: ran ? ran.session : '', tool: 'websearch', args: { query: e.input && e.input.query }, ok: true, from_log: e.seq }
    appendFileSync(callLog, JSON.stringify(record) + '\n')
  }
}

/** Pure. The journal's hits, each once: by path and line, by commit, by canonical URL, a candidate by its key. */
function hitsOf(records) {
  const seen = new Set()
  const out = []
  for (const r of records) {
    if (r.tool !== 'hit' || !r.ok || !r.hit) continue
    const h = r.hit
    const key = h.candidate ? 'candidate ' + candidateKey(h.candidate)
      : h.path !== undefined ? 'path ' + h.path + ':' + h.line
        : h.commit !== undefined ? 'commit ' + h.commit : 'url ' + canonicalUrl(h.url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(h)
  }
  return out
}

/** The sessions one round's dispatch ran in. */
const roundSessions = (ctx, key) => new Set(ctx.log.entries().filter((e) => e.kind === 'dispatched' && e.dispatch === key).map((e) => e.session))

/**
 * One search (docs/DESIGN.md#searches): rounds of its domain's scout, each a fresh session on the
 * same charge, its tools served over `tree` inside `scope`, its path hits only inside `subject`
 * (default the scope). The first round opens on the journal as it stands; each later one is briefed
 * with the hits and calls the earlier rounds journaled. The search ends when a round adds no new hit, or on a round the host or the `budget` (the dollars
 * every round has spent) stopped. Re-entrant: a round whose session returned replays its stored
 * return, a round cut off resumes its session, and the result is read from the journal again.
 */
export async function search(ctx, { name, domain, find, material = [], scope = ['.'], subject = scope, labels = [], budget = null, tree, intelligence = ctx.intelligence }) {
  const role = ROLE_OF[domain]
  if (!role) throw new Error('the search ' + name + ' has no domain ' + JSON.stringify(domain))
  const thread = threadOf(ctx, { role, thread: name }).key
  const callLog = join(searchDir(ctx.dir, thread), 'calls.jsonl')
  const pages = join(ctx.dir, 'pages')
  const journal = () => {
    journalWebSearches(ctx, thread, callLog)
    return openCalls(callLog)
  }
  const charge = scoutCharge({ domain, find, scope, subject, labels, material })
  const keys = []
  const spent = () => keys.reduce((n, key) => n + spentOn(ctx, key), 0)
  const rounds = []
  let held = new Set()
  for (let round = 1; ; round++) {
    const key = dispatchKey({ node: '', role, thread, round })
    keys.push(key)
    const briefOf = round === 1 ? resumeBrief : roundBrief
    const out = await dispatch(ctx, {
      role, schema: 'search', thread: name, round, intelligence, cwd: tree.root, renewOnChange: true, fresh: round === 1 ? '' : 'next_round',
      charge,
      mcpConfig: (session) => mcpConfigFor(ctx.dir, thread, { tree, scope, subject, labels, tools: TOOLS_BY_DOMAIN[domain], calls: callLog, pages, session }),
      brief: briefOf(journal()),
      briefNow: () => briefOf(journal()),
      budgetNow: budget === null ? null : () => budget - spent(),
    })
    const sessions = new Set([...held, ...roundSessions(ctx, key)])
    const records = journal()
    const added = hitsOf(records.filter((r) => sessions.has(r.session))).length - hitsOf(records.filter((r) => held.has(r.session))).length
    rounds.push({ out, added, cost: spentOn(ctx, key), stalled: records.some((r) => r.stalled && sessions.has(r.session) && !held.has(r.session)) })
    held = sessions
    if (out.status !== 'returned' || added === 0) break
  }
  const last = rounds[rounds.length - 1]
  const records = journal()
  const cost = spent()
  const [status, why] = last.out.status === 'returned'
    ? (last.stalled ? ['stalled', 'nothing new in the last ' + STALL_WINDOW + ' calls'] : ['done', ''])
    : last.out.cause === 'budget' ? ['budget', 'spent $' + cost.toFixed(2) + ' of its $' + budget + ' budget']
      : ['failed', last.out.cause + (last.out.message ? ': ' + last.out.message : '')]
  const summary = rounds.findLast((r) => r.out.status === 'returned')?.out.output.summary
  return {
    name, status, why, summary: String(summary ?? ''),
    hits: hitsOf(records), calls: callLines(records), cost, tree, pages, sessions: sessionsOf(ctx, thread),
    rounds: rounds.map((r) => ({ added: r.added, cost: r.cost })),
    coverage: { rounds: rounds.length, last_added: last.added, skipped: String(summary ?? '') },
  }
}
