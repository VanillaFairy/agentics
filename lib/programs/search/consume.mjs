// lib/programs/search/consume.mjs — one way to consume a search: what its result means to a consumer,
// the wants loop that reruns a search for its consumers' wants and re-dispatches them, the lines a lost
// round leaves, and the tree, config and guidance a program pins.
//
// Data contract, Wants: a consumer's return names `wants: [{unit, want}]`; a want on a unit the consumer
// holds becomes the search ask `{key: 'want:<n>', find: <canonical want>, scope: ['.'], domain: 'repo'}`,
// numbered per search from 1, one ask per canonical text. A want ask's lines are selected by its key.
//
// Design: docs/DESIGN.md#searches.

import { guidanceOf } from '../../brief.mjs'
import { treeOf } from '../../search/pin.mjs'
import { readConfig } from '../../store.mjs'

const listOf = (v) => (Array.isArray(v) ? v : [])
const isWant = (key) => /^want:\d+$/.test(key)

/** Pure. A want's canonical text: trimmed, inner whitespace collapsed. */
export const canonicalWant = (text) => String(text || '').trim().replace(/\s+/g, ' ')

/** Pure. What a search's result means to its consumer, and its coverage lines with want asks reduced to one declared line each. */
export function outcomeOf(result) {
  const asks = Object.entries(result.asks || {})
  const own = asks.filter(([k]) => !isWant(k))
  const nothing = result.status === 'failed' || own.every(([, a]) => a.end === 'stopped' && listOf(a.hits).length === 0)
  const short = !nothing && own.some(([, a]) => a.end !== 'done')
  const why = result.status === 'failed' ? (result.cause || 'failed') : nothing ? 'every ask paused' : ''
  const lines = (field) => own.flatMap(([, a]) => listOf(a.lines && a.lines[field]))
  const wantLines = asks.filter(([k, a]) => isWant(k) && a.end !== 'done')
    .map(([k, a]) => 'want ' + k.slice('want:'.length) + ': ended ' + a.end + ': ' + a.why)
  return {
    nothing, short, why,
    declared: [...lines('declared'), ...wantLines],
    incomplete: lines('incomplete'), unreached: lines('unreached'), failed: lines('failed'),
  }
}

/** Pure. What a result's want asks hold: their hits and the calls run under them. */
const wantedOf = (result, keys) => new Set(keys.flatMap((k) => {
  const a = (result && result.asks && result.asks[k]) || {}
  return [
    ...listOf(a.hits).map((h) => 'hit ' + h.key + ':' + h.line),
    ...listOf(a.looked).map((l) => 'call ' + l.tool + ' ' + l.what + '@' + listOf(l.where).join(',')),
  ]
}))

/** Pure. A return's rulings on `units`, comparable; null when it ruled none of them. */
const rulingsOf = (output, units) => {
  const ruled = listOf(output && output.units).filter((u) => u && units.has(u.unit)).map((u) => [u.unit, u.ruling]).sort()
  return ruled.length ? JSON.stringify(ruled) : null
}

/** The wants loop of the consumers of one search; ends on state, never on a count. */
async function groupRounds(name, consumers, { rerun, redispatch, merge }) {
  const state = new Map(consumers.map((c) => [c, { held: c.held, merged: c.latest, passes: [] }]))
  const latest = new Map(consumers.map((c) => [c, c.latest]))
  const wantedReturns = new Map()
  const seen = new Map()
  let had = new Set()
  let round = 1
  let going = true
  while (going) {
    round++
    const asks = []
    const redo = new Map()
    for (const c of consumers) {
      for (const w of listOf(latest.get(c) && latest.get(c).wants)) {
        const text = canonicalWant(w && w.want)
        if (!text || !c.held.includes(w.unit)) continue
        if (!seen.has(text)) {
          seen.set(text, 'want:' + (seen.size + 1))
          asks.push({ key: seen.get(text), find: text, scope: ['.'], domain: 'repo' })
        }
        if (!asks.some((a) => a.find === text)) continue
        const r = redo.get(c) || { units: new Set(), keys: new Set() }
        r.units.add(w.unit)
        r.keys.add(seen.get(text))
        redo.set(c, r)
      }
    }
    if (asks.length === 0) break
    const result = await rerun(name, asks)
    const now = wantedOf(result, [...seen.values()])
    const added = [...now].some((k) => !had.has(k))
    had = now
    for (const c of consumers) latest.set(c, null)
    const same = await Promise.all([...redo].map(async ([c, r]) => {
      const d = await redispatch(c, r.units, { result, keys: [...r.keys] }, round)
      const s = state.get(c)
      const output = d.status === 'returned' ? d.output : null
      s.passes.push({
        round, units: [...r.units], status: d.status, cause: d.cause || null,
        not_reached: output && typeof output.not_reached === 'string' ? output.not_reached.trim() : '',
      })
      if (!output) return false
      const before = rulingsOf(wantedReturns.get(c), r.units)
      const repeated = before !== null && rulingsOf(output, r.units) === before
      wantedReturns.set(c, output)
      s.merged = merge(s.merged, output, r.units)
      latest.set(c, output)
      return repeated
    }))
    going = added && !same.every(Boolean)
  }
  return consumers.map((c) => [c.id, state.get(c)])
}

/**
 * The wants loop: consumers of one search pass together, consumers of different searches independently.
 * → { [id]: { held, merged, passes: [{ round, units, status, cause, not_reached }] } }
 */
export async function wantsRounds(ctx, { consumers, rerun, redispatch, merge }) {
  const groups = new Map()
  for (const c of consumers) groups.set(c.search, [...(groups.get(c.search) || []), c])
  const done = await Promise.all([...groups].map(([name, group]) => groupRounds(name, group, { rerun, redispatch, merge })))
  return Object.fromEntries(done.flat())
}

/** Pure. The coverage a wants loop leaves: one line per lost round, and each distinct `not_reached` once. */
export function judgeLines(state, label) {
  const unreached = []
  for (const [id, s] of Object.entries(state)) {
    for (const p of s.passes) {
      const line = p.status === 'returned'
        ? (p.not_reached ? label + ' ' + id + ' did not reach: ' + p.not_reached : '')
        : label + ' ' + id + ' did not return for its wants (' + p.cause + '): its earlier items on ' + p.units.join(', ') + ' stand'
      if (line && !unreached.includes(line)) unreached.push(line)
    }
  }
  return { unreached }
}

/** The tree a program reads, its config, and the guidance of that tree. */
export function pinnedOf(ctx, args) {
  const tree = args.tree || treeOf(ctx.root)
  const config = readConfig(ctx.repo)
  return { tree, config, guidance: guidanceOf(tree.root, { dirs: args.roots, config }) }
}
