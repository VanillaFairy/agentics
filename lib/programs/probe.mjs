// lib/programs/probe.mjs — the probe program: attacks a written artefact with analysts handed the
// document, the repository's excerpts and nothing from its author, has every axis ruled against every
// section, and records the round's findings anchored to the snapshot they read. One search over the
// probe's tree locates the repository's guidance and the ground the document talks about.
//
// Design: docs/DESIGN.md#probe.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { LOCATE_FIND, LOCATE_LABELS, STANDING_AXES, axesBrief, proberBrief } from '../briefs/probe.mjs'
import { hitExcerpts, resolveCitations } from '../citations.mjs'
import { carriedFindings, recordProbe, reviewScope, sectionSlug, sectionsOf, unitsOf } from '../evidence.mjs'
import { evidenceSnapshotsDir, posix, returnPath } from '../store.mjs'
import { unitsOpen } from '../verdict.mjs'
import { coverageOf, dialed, dispatch, step } from './common.mjs'
import { budgetOf, pinnedOf, searchComplete, searchCoverage } from './search/consume.mjs'
import { search } from './search/search.mjs'

export const ARGS = {
  artifact: { kind: 'file', required: true, as: 'artifact_text' },
  roots: { kind: 'list', default: ['.'] },
  context: { kind: 'text' },
  context_file: { kind: 'file', as: 'context' },
  per_axis: { kind: 'bool' },
  since: { kind: 'token' },
  intelligence: { kind: 'enum', values: ['low', 'normal', 'max'], default: 'normal' },
  search_budget: { kind: 'usd' },
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
function repoAxes(found, standing) {
  if (!found || found.stop_reason !== 'completed') return []
  const taken = new Set(standing.map((a) => a.key))
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

/** Pure. The artefact as the locating search's material: whole, or each changed range alone. */
export function locateMaterial(text, artifact, changed) {
  const lines = String(text || '').replace(/\n$/, '').split('\n')
  if (!changed) return [{ label: artifact, text: lines.join('\n') }]
  return changed.map((r) => ({ label: artifact + ', lines ' + r.start + '-' + r.end, text: lines.slice(r.start - 1, r.end).join('\n') }))
}

/**
 * The probe: snapshot the artefact, resolve its citations, locate the repository's guidance and the
 * ground it talks about in one search over the probe's tree, derive the repository's axes, and have every axis attacked against every
 * section in scope — given `since`, the sections the lines changed since fall in, every earlier finding
 * no edit touched carried; record the round only when every prober returned. `axes`, in-process only,
 * are standing axes the caller adds to the four.
 */
export async function probe(entered, args) {
  const ctx = dialed(entered, args)
  const journaled = await step(ctx, 'scope', () => reviewScope(ctx.repo, args.artifact, args.since, { root: ctx.root }))
  const { scope, text: snapped } = heldScope(ctx.repo, journaled)
  const narrow = scope.ok && !scope.full
  if (narrow && scope.changed.length === 0) return unchanged(ctx, args, scope)
  const artifact = scope.ok ? scope.path : posix(args.artifact)
  const text = scope.ok ? snapped : args.artifact_text
  const { tree, guidance } = pinnedOf(ctx, args)
  const failed = []
  const incomplete = []
  const unreached = []
  const sections = sectionsOf(text).filter((s) => !narrow || scope.changed.some((r) => r.start <= s.end && s.start <= r.end))

  const cited = resolveCitations(tree.root, args.artifact, 10)
  const located = await search(ctx, {
    name: 'locate', domain: 'repo', tree, find: LOCATE_FIND, labels: LOCATE_LABELS, scope: args.roots,
    material: locateMaterial(text, artifact, narrow ? scope.changed : null), budget: budgetOf(args),
  })
  const complete = searchComplete(located)
  const ground = located.hits.length > 0 || complete ? { ...hitExcerpts(located), complete } : null

  let found = null
  if (guidance || located.hits.some((h) => h.label === 'guidance')) {
    const guided = hitExcerpts(located, { label: 'guidance' }).text
    const d = await dispatch(ctx, { role: 'analyst', schema: 'axes', thread: 'axes', brief: axesBrief({ roots: args.roots, located: guided, guidance }) })
    if (d.status === 'returned' && d.output.stop_reason !== 'unreadable') found = d.output
    else {
      failed.push('repo-axes')
      unreached.push('the axes analyst ' + (d.status === 'returned' ? 'could not read the guidance' : 'failed (' + d.cause + ')') +
        ', so this repository\'s own review guidance was not probed: the standing axes only')
    }
  }
  const standing = [...STANDING_AXES, ...listOf(args.axes)]
  const axes = [...standing, ...repoAxes(found, standing)]

  const attacked = narrow ? scope.changed.reduce((n, r) => n + r.end - r.start + 1, 0) : scope.ok ? scope.lines : lineCount(text)
  const bundles = bundlesOf(axes, attacked, args.per_axis)
  const held = bundles.map((b) => unitsOf(b.map((a) => a.key), sections))
  const claimOf = new Map(narrow ? scope.carried.map((it) => [it.id, it.claim]) : [])
  const carried = narrow ? carriedFindings(scope).map((f) => ({ ...f, claim: claimOf.get(f.item) })) : []
  const probed = await Promise.all(bundles.map((bundle, i) => dispatch(ctx, {
    role: 'analyst', schema: 'prober', thread: 'prober:' + (i + 1),
    brief: proberBrief({
      artifact, text, context: args.context, axes: bundle, units: held[i], sections, cited, ground, guidance,
      narrow: narrow ? { changed: scope.changed, carried } : null,
    }),
  })))

  const outputs = probed.map((d) => (d.status === 'returned' ? d.output : null))
  outputs.forEach((out, i) => {
    if (out && typeof out.not_reached === 'string' && out.not_reached.trim()) unreached.push('prober:' + (i + 1) + ' did not reach: ' + out.not_reached.trim())
  })
  const covered = searchCoverage([located])
  incomplete.push(...covered.incomplete)
  failed.push(...covered.failed_channels)
  unreached.push(...covered.unreached)

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
    guidanceRead: found ? listOf(found.guidance_read) : [],
    repoGround: { status: located.status, hits: located.hits.length, unresolved: ground ? ground.counts.unresolved : 0 },
    units, open: unitsOpen(units, rulings), record, declared: covered.declared, incomplete, failed, unreached,
  })
}

/** A narrowed round over an artefact unchanged since `since`: no agent, one empty round recorded, every earlier finding carried. */
async function unchanged(ctx, args, scope) {
  const record = await step(ctx, 'record', () => recordProbe(ctx.repo, { file: args.artifact, snapshot: scope.snapshot, since: scope.since },
    { root: ctx.root, now: new Date(ctx.now()) }))
  return resultOf(ctx, {
    scope, artifact: scope.path, axes: [], bundles: [], shared: sharedOf(null),
    guidanceRead: [], repoGround: { status: '', hits: 0, unresolved: 0 }, units: [], open: [], record, declared: [], incomplete: [], failed: [], unreached: [],
  })
}

/** The probe's result and its coverage block: ratifiable only when complete, no ambiguity is open and every finding was recorded. */
function resultOf(ctx, { scope, artifact, axes, bundles, shared, guidanceRead, repoGround, units, open, record, declared, incomplete, failed, unreached }) {
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
    repo_ground: repoGround,
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
