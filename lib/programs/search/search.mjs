// lib/programs/search/search.mjs — one search: one scout session over code's tools, every call and
// finding journaled by the tool server as it goes, resumed or renewed by dispatch on that journal.
//
// Design: docs/DESIGN.md#searches.

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { callLines, resumeBrief, scoutCharge } from '../../briefs/search.mjs'
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

/**
 * One search (docs/DESIGN.md#searches): one dispatch of its domain's scout, its charge the system
 * prompt, its tools served over `tree` inside `scope`. A renewed session is briefed with the journal
 * as it stands; a `budget` caps the dispatch's spend. Re-entrant: a search whose session returned
 * replays its stored return, and its result is read from the journal again.
 */
export async function search(ctx, { name, domain, find, material = [], scope = ['.'], labels = [], budget = null, tree, intelligence = ctx.intelligence }) {
  const role = ROLE_OF[domain]
  if (!role) throw new Error('the search ' + name + ' has no domain ' + JSON.stringify(domain))
  const thread = threadOf(ctx, { role, thread: name }).key
  const key = dispatchKey({ node: '', role, thread, round: 1 })
  const callLog = join(searchDir(ctx.dir, thread), 'calls.jsonl')
  const pages = join(ctx.dir, 'pages')
  const journal = () => {
    journalWebSearches(ctx, thread, callLog)
    return openCalls(callLog)
  }
  const out = await dispatch(ctx, {
    role, schema: 'search', thread: name, intelligence, cwd: tree.root, renewOnChange: true,
    charge: scoutCharge({ domain, find, scope, labels, material }),
    mcpConfig: (session) => mcpConfigFor(ctx.dir, thread, { tree, scope, labels, tools: TOOLS_BY_DOMAIN[domain], calls: callLog, pages, session }),
    brief: resumeBrief(journal()),
    briefNow: () => resumeBrief(journal()),
    budgetNow: budget === null ? null : () => budget - spentOn(ctx, key),
  })
  const records = journal()
  const cost = spentOn(ctx, key)
  const [status, why] = out.status === 'returned'
    ? (records.some((r) => r.stalled) ? ['stalled', 'nothing new in the last ' + STALL_WINDOW + ' calls'] : ['done', ''])
    : out.cause === 'budget' ? ['budget', 'spent $' + cost.toFixed(2) + ' of its $' + budget + ' budget']
      : ['failed', out.cause + (out.message ? ': ' + out.message : '')]
  return {
    name, status, why, summary: out.status === 'returned' ? String(out.output.summary ?? '') : '',
    hits: hitsOf(records), calls: callLines(records), cost, tree, pages, sessions: sessionsOf(ctx, thread),
  }
}
