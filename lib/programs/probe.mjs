// lib/programs/probe.mjs — the probe program: attacks a written artefact with analysts handed the
// document, the repository's excerpts and nothing from its author, has every axis ruled against every
// section, and records the round's findings anchored to the snapshot they read. One search over the
// probe's tree locates the repository's guidance and the ground the document talks about.
//
// Design: docs/DESIGN.md#probe.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { guidanceOf } from '../brief.mjs'
import { GUIDANCE_FIND, STANDING_AXES, axesBrief, groundFind, proberBrief, wantedBrief } from '../briefs/probe.mjs'
import { groundText } from '../briefs/search.mjs'
import { resolveCitations, searchExcerpts } from '../citations.mjs'
import { carriedFindings, recordProbe, reviewScope, sectionSlug, sectionsOf, unitsOf } from '../evidence.mjs'
import { treeOf } from '../search/pin.mjs'
import { keyOf } from '../search/tools.mjs'
import { evidenceSnapshotsDir, posix, readConfig, returnPath } from '../store.mjs'
import { unitsOpen } from '../verdict.mjs'
import { coverageOf, dispatch, step } from './common.mjs'
import { groundFor, search } from './search/loop.mjs'

export const ARGS = {
  artifact: { kind: 'file', required: true, as: 'artifact_text' },
  roots: { kind: 'list', default: ['.'] },
  context: { kind: 'text' },
  context_file: { kind: 'file', as: 'context' },
  per_axis: { kind: 'bool' },
  since: { kind: 'token' },
}

/** Pure. What a second probe waits for: the same artefact, by the absolute path it resolved to. */
export const scopeOf = (args) => ({ artifact: posix(args.artifact) })

// One analyst holds every axis; another is bought per this many lines of artefact, or this many axes.
const LINES_PER_ANALYST = 400
const AXES_PER_ANALYST = 12

const listOf = (v) => (Array.isArray(v) ? v : [])
const textOf = (v) => (typeof v === 'string' ? v.trim() : '')
const lineCount = (text) => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length)

/** The text a snapshot holds: what the probers read and the findings are anchored to; null once the store lost it. */
function snapshotText(repo, snapshot) {
  try {
    return readFileSync(join(evidenceSnapshotsDir(repo), snapshot.slice('snapshot:'.length) + '.txt'), 'utf8')
  } catch {
    return null
  }
}

/**
 * The journaled scope and its snapshot's text. A scope whose snapshot the store no longer holds (pruned
 * since the scope was journaled) is refused `snapshot_missing`, so the round runs over the artefact as
 * given and records nothing.
 */
function heldScope(repo, scope) {
  const text = scope.ok ? snapshotText(repo, scope.snapshot) : null
  if (!scope.ok || text !== null) return { scope, text }
  const error = { kind: 'snapshot_missing', message: 'the snapshot ' + scope.snapshot + ' is no longer in the evidence store' }
  return { scope: { ok: false, error }, text: null }
}

// The shared ground a result reports: whether the citations resolved, and these counts of them.
const SHARED_COUNTS = ['cited', 'files', 'excerpts', 'unresolved']
/** Pure. A result's shared ground from `resolveCitations`' answer; nothing resolved when it is null. */
const sharedOf = (cited) => ({
  resolved: Boolean(cited) && cited.read_error === '',
  ...Object.fromEntries(SHARED_COUNTS.map((k) => [k, cited ? cited.counts[k] : 0])),
})

/** Pure. The repository's axes from a completed axes return: slugged, each key once, none a standing key. */
function repoAxes(found) {
  if (!found || found.stop_reason !== 'completed') return []
  const taken = new Set(STANDING_AXES.map((a) => a.key))
  const out = []
  for (const a of listOf(found.axes)) {
    if (!a || !textOf(a.key) || !textOf(a.charge)) continue
    const base = sectionSlug(a.key) || 'axis'
    let key = base
    for (let n = 2; taken.has(key); n++) key = base + '-' + n
    taken.add(key)
    out.push({ key, charge: textOf(a.charge), source: textOf(a.source) })
  }
  return out
}

/** Pure. The axes dealt round-robin to as many probers as the lines and the axes earn, never more than one per axis. */
function bundlesOf(axes, lines, perAxis) {
  const n = perAxis ? axes.length
    : Math.max(1, Math.min(axes.length, Math.max(Math.ceil(lines / LINES_PER_ANALYST), Math.ceil(axes.length / AXES_PER_ANALYST))))
  const bundles = Array.from({ length: n }, () => [])
  axes.forEach((a, i) => bundles[i % n].push(a))
  return bundles
}

/** Pure. A prober's unit rulings, kept only for the units it was handed. */
const rulingsOf = (output, held) => listOf(output.units)
  .filter((u) => u && held.includes(u.unit))
  .map(({ unit, ruling, why }) => ({ unit, ruling, why }))

/**
 * Pure. The artefact as the locating search's material, once: the lines before its first section
 * and every section out of scope as context, each section in scope as its own ground ask's.
 */
function artefactMaterial(text, artifact, inScope) {
  const lines = String(text || '').replace(/\n$/, '').split('\n')
  const all = sectionsOf(text)
  const head = all.length ? all[0].start - 1 : lines.length
  const name = (s) => (s.title ? 'section "' + s.title + '"' : s.slug) + ', lines ' + s.start + '-' + s.end
  return [
    ...(head > 0 ? [{ label: artifact + ', lines 1-' + head, text: lines.slice(0, head).join('\n') }] : []),
    ...all.map((s) => ({
      label: artifact + ', ' + name(s), text: lines.slice(s.start - 1, s.end).join('\n'),
      ...(inScope.has(s.slug) ? { asks: ['ground:' + s.slug] } : {}),
    })),
  ]
}

/**
 * The locating search's asks: the repository's guidance, seeded open with the resolver's guidance
 * keys less the artefact itself, and one ground ask per section in scope, whose frontier is its own
 * material's ground rows. `keyOf` reads the tree, so it runs inside a step.
 */
function locateAsks(tree, { artifact, sections, roots, ground }) {
  const own = keyOf(tree, artifact)
  const seeds = ground.seeds.filter((k) => !(own.ok && k === own.key)).map((key) => ({ key, as: 'open', reason: 'guidance the resolver found' }))
  return [
    { key: 'guidance', find: GUIDANCE_FIND, scope: ['.'], domain: 'repo', seeds },
    ...sections.map((s) => ({ key: 'ground:' + s.slug, find: groundFind(s), scope: roots, domain: 'repo' })),
  ]
}

const isWant = (key) => key.startsWith('want:')
/** Pure. Whether a search produced nothing: it failed, or every ask but a want paused with no hit. */
const nothingFrom = (s) => s.status === 'failed' ||
  Object.entries(s.asks).filter(([k]) => !isWant(k)).every(([, a]) => a.end === 'stopped' && a.hits.length === 0)

/** Pure. A search's coverage without its want asks, and a declared line per want that ended short (D22). */
function wantsDeclared(s) {
  const mine = (line) => !line.startsWith(s.name + ':want:')
  const short = Object.entries(s.asks).filter(([k, a]) => isWant(k) && a.end !== 'done')
  return {
    declared: [...s.coverage.declared, ...short.map(([k, a]) => 'want ' + k.slice('want:'.length) + ': ended ' + a.end + ': ' + a.why)],
    incomplete: s.coverage.incomplete.filter(mine), unreached: s.coverage.unreached.filter(mine),
    failed_channels: s.coverage.failed_channels.filter(mine),
  }
}

/** Pure. A want's canonical text: trimmed, inner whitespace collapsed. */
const canonicalWant = (w) => String(w || '').trim().replace(/\s+/g, ' ')

/**
 * Pure. One pass of wants: from each judge's latest return (`latest[i]`, null when it returned
 * nothing new), the wants for units it holds whose canonical text `seen` has not asked. Extends
 * `seen` (canonical → ask key, numbered from 1). Returns the new asks and, per judge, the units
 * to rule again and the ask keys that serve them.
 */
function wantsPass(latest, held, seen) {
  const asks = []
  const redo = new Map()
  const fresh = new Set()
  latest.forEach((out, i) => {
    for (const w of listOf(out && out.wants)) {
      const text = canonicalWant(w && w.want)
      if (!text || !held[i].includes(w.unit)) continue
      if (!seen.has(text)) {
        seen.set(text, 'want:' + (seen.size + 1))
        fresh.add(text)
        asks.push({ key: seen.get(text), find: text, scope: ['.'], domain: 'repo' }) // `from`: set by the loop
      }
      if (!fresh.has(text)) continue
      const r = redo.get(i) || { units: new Set(), keys: new Set() }
      r.units.add(w.unit)
      r.keys.add(seen.get(text))
      redo.set(i, r)
    }
  })
  return { asks, redo }
}

/** Pure. A prober's return with `units`' rulings and findings taken from `next`. */
const mergedProber = (prev, next, units) => ({
  ...prev,
  findings: [...listOf(prev.findings).filter((f) => !units.has(f.axis + '@' + f.section)),
    ...listOf(next.findings).filter((f) => units.has(f.axis + '@' + f.section))],
  units: [...listOf(prev.units).filter((u) => !units.has(u && u.unit)), ...listOf(next.units).filter((u) => u && units.has(u.unit))],
})

/**
 * The probe: snapshot the artefact, resolve its citations, locate the repository's guidance and the
 * ground it talks about in one search over the probe's tree, derive the repository's axes, and have every axis attacked against every
 * section in scope — given `since`, the sections the lines changed since fall in, every earlier finding
 * no edit touched carried; record the round only when every prober returned.
 */
export async function probe(ctx, args) {
  const journaled = await step(ctx, 'scope', () => reviewScope(ctx.repo, args.artifact, args.since, { root: ctx.root }))
  const { scope, text: snapped } = heldScope(ctx.repo, journaled)
  const narrow = scope.ok && !scope.full
  if (narrow && scope.changed.length === 0) return unchanged(ctx, args, scope)
  const artifact = scope.ok ? scope.path : posix(args.artifact)
  const text = scope.ok ? snapped : args.artifact_text
  const tree = args.tree || treeOf(ctx.root)
  const guidance = guidanceOf(ctx.root, { dirs: args.roots, config: readConfig(ctx.repo) })
  const failed = []
  const incomplete = []
  const unreached = []
  const sections = sectionsOf(text).filter((s) => !narrow || scope.changed.some((r) => r.start <= s.end && s.start <= r.end))

  const cited = resolveCitations(tree.root, args.artifact, 10)
  const material = artefactMaterial(text, artifact, new Set(sections.map((s) => s.slug)))
  const config = readConfig(ctx.repo)
  const table = await step(ctx, 'ground', () => groundFor(ctx, tree, { material, scope: args.roots, config }))
  const asks = await step(ctx, 'asks', () => locateAsks(tree, { artifact: args.artifact, sections, roots: args.roots, ground: table }))
  const spec = { name: 'locate', role: 'scout', schema: 'search_repo', tree, material, ground: table, config }
  let located = await search(ctx, { ...spec, asks })
  const nothing = nothingFrom(located)
  const groundAsks = Object.keys(located.asks).filter((k) => k.startsWith('ground:'))
  const ground = nothing ? null
    : { ...searchExcerpts(located, { kind: 'ground' }), complete: groundAsks.every((k) => located.asks[k].end === 'done') }

  let found = null
  if (!nothing && (located.kinds.guidance || 0) > 0) {
    const guided = searchExcerpts(located, { kind: 'guidance' }).text
    const d = await dispatch(ctx, { role: 'analyst', schema: 'axes', thread: 'axes', brief: axesBrief({ roots: args.roots, located: guided, guidance }) })
    if (d.status === 'returned' && d.output.stop_reason !== 'unreadable') found = d.output
    else {
      failed.push('repo-axes')
      unreached.push('the axes analyst ' + (d.status === 'returned' ? 'could not read the guidance' : 'failed (' + d.cause + ')') +
        ', so this repository\'s own review guidance was not probed: the standing axes only')
    }
  }
  const axes = [...STANDING_AXES, ...repoAxes(found)]

  const attacked = narrow ? scope.changed.reduce((n, r) => n + r.end - r.start + 1, 0) : scope.ok ? scope.lines : lineCount(text)
  const bundles = bundlesOf(axes, attacked, args.per_axis)
  const held = bundles.map((b) => unitsOf(b.map((a) => a.key), sections))
  const claimOf = new Map(narrow ? scope.carried.map((it) => [it.id, it.claim]) : [])
  const carried = narrow ? carriedFindings(scope).map((f) => ({ ...f, claim: claimOf.get(f.item) })) : []
  const probed = await Promise.all(bundles.map((bundle, i) => dispatch(ctx, {
    role: 'analyst', schema: 'prober', thread: 'prober:' + (i + 1),
    brief: proberBrief({
      artifact, text, context: args.context, axes: bundle, units: held[i], sections, cited, ground, table: groundText(table), guidance,
      narrow: narrow ? { changed: scope.changed, carried } : null,
    }),
  })))

  const outputs = probed.map((d) => (d.status === 'returned' ? d.output : null))
  const seen = new Map()
  let asked = asks
  let latest = outputs
  for (let round = 2; ; round++) {
    const { asks: more, redo } = wantsPass(latest, held, seen)
    if (more.length === 0) break
    asked = [...asked, ...more]
    located = await search(ctx, { ...spec, asks: asked })
    latest = outputs.map(() => null)
    await Promise.all([...redo].map(async ([i, r]) => {
      const d = await dispatch(ctx, {
        role: 'analyst', schema: 'prober', thread: 'prober:' + (i + 1), round,
        brief: wantedBrief({ units: [...r.units], found: searchExcerpts(located, { asks: [...r.keys] }).text }),
      })
      if (d.status !== 'returned') {
        unreached.push('prober:' + (i + 1) + ' did not return for its wants (' + d.cause + '): its earlier rulings on ' + [...r.units].join(', ') + ' stand')
        return
      }
      outputs[i] = mergedProber(outputs[i], d.output, r.units)
      latest[i] = d.output
    }))
  }

  const none = nothingFrom(located)
  if (none) {
    failed.push('repo-axes', 'repo-ground')
    unreached.push('the locating search produced nothing (' + (located.cause || 'every ask paused') + '), so neither the ' +
      'repository\'s guidance nor the ground this artefact talks about was located: the standing axes probed the artefact ' +
      'and its own citations only')
  } else {
    if (Object.entries(located.asks).some(([k, a]) => !isWant(k) && a.end !== 'done')) incomplete.push('locate')
    const covered = wantsDeclared(located)
    unreached.push(...covered.incomplete, ...covered.unreached)
    failed.push(...covered.failed_channels)
  }

  const lost = probed.flatMap((d, i) => (d.status === 'returned' ? [] : [i]))
  if (lost.length) failed.push('probe')
  for (const i of lost) {
    unreached.push('prober:' + (i + 1) + ' failed (' + probed[i].cause + '), so its units are open and the round was not ' +
      'recorded: start the run again to finish it')
  }
  const rulings = outputs.flatMap((out, i) => (out ? rulingsOf(out, held[i]) : []))
  const kept = outputs.flatMap((out, i) => (out ? [i] : []))
  const recordSpec = {
    file: args.artifact, from: kept.map((i) => outputs[i]), bundle: kept.map((i) => bundles[i].map((a) => a.key).join('+')),
    units: rulings, since: narrow ? scope.since : '',
  }
  const opts = { root: ctx.root, now: new Date(ctx.now()) }
  let record = null
  if (!scope.ok) {
    failed.push('record')
    unreached.push('the artefact could not be snapshotted (' + scope.error.kind + ': ' + scope.error.message + '), so no finding ' +
      'was numbered or recorded; the probers\' findings are in their stored returns: ' +
      kept.map((i) => posix(returnPath(ctx.dir, probed[i].dispatch))).join(', '))
  } else if (lost.length) {
    record = recordProbe(ctx.repo, { ...recordSpec, snapshot: '' }, opts)
  } else {
    record = await step(ctx, 'record', () => recordProbe(ctx.repo, { ...recordSpec, snapshot: scope.snapshot }, opts))
  }

  const units = unitsOf(axes.map((a) => a.key), sections)
  return resultOf(ctx, {
    scope, artifact, axes, bundles, shared: sharedOf(cited),
    guidanceRead: found ? listOf(found.guidance_read) : [], ground,
    located: none ? 0 : located.kinds.ground || 0, units, open: unitsOpen(units, rulings), record,
    declared: none ? [] : wantsDeclared(located).declared, incomplete, failed, unreached,
  })
}

/** A narrowed round over an artefact unchanged since `since`: no agent, one empty round recorded, every earlier finding carried. */
async function unchanged(ctx, args, scope) {
  const record = await step(ctx, 'record', () => recordProbe(ctx.repo, { file: args.artifact, snapshot: scope.snapshot, since: scope.since },
    { root: ctx.root, now: new Date(ctx.now()) }))
  return resultOf(ctx, {
    scope, artifact: scope.path, axes: [], bundles: [], shared: sharedOf(null),
    guidanceRead: [], ground: null, located: 0, units: [], open: [], record, declared: [], incomplete: [], failed: [], unreached: [],
  })
}

/** The probe's result and its coverage block: ratifiable only when complete, no ambiguity is open and every finding was recorded. */
function resultOf(ctx, { scope, artifact, axes, bundles, shared, guidanceRead, ground, located, units, open, record, declared, incomplete, failed, unreached }) {
  const findings = record ? record.findings : []
  const recorded = Boolean(record && record.recorded)
  const unrecorded = recorded ? [] : findings.filter((f) => !f.carried).map((f) => f.id)
  const ambiguities = findings.filter((f) => f.severity === 'ambiguity').map((f) => f.id)
  const coverage = coverageOf({
    declared, incomplete, failed_channels: failed, resumable: ctx.resumable,
    unreached: open.length ? [...unreached, open.length + ' unit(s) no prober ruled: ' + open.join(', ')] : unreached,
  })
  return {
    artifact,
    axes: axes.map(({ key, source }) => ({ key, source })),
    analysts: bundles.map((b) => b.map((a) => a.key)),
    shared_ground: shared,
    guidance_read: guidanceRead,
    repo_ground: { located, unresolved: ground ? ground.counts.unresolved : 0 },
    units: { total: units.length, ruled: units.length - open.length, open },
    findings,
    findings_file: record ? record.findings_file : '',
    ambiguities,
    ratifiable: coverage.complete && ambiguities.length === 0 && unrecorded.length === 0,
    snapshot: recorded ? scope.snapshot : '',
    scope: scope.ok ? { full: scope.full, changed: scope.changed } : { full: true, changed: [] },
    unrecorded,
    review: record ? record.return : '',
    coverage,
  }
}
