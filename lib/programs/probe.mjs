// lib/programs/probe.mjs — the probe program: attacks a written artefact with analysts handed the
// document, the repository's excerpts and nothing from its author, has every axis ruled against every
// section, and records the round's findings anchored to the snapshot they read.
//
// Design: docs/DESIGN.md#probe.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { guidanceOf } from '../brief.mjs'
import { STANDING_AXES, axesBrief, locateBrief, proberBrief } from '../briefs/probe.mjs'
import { excerptsText, resolveCitations } from '../citations.mjs'
import { recordProbe, reviewScope, sectionSlug, sectionsOf, unitsOf } from '../evidence.mjs'
import { evidenceSnapshotsDir, posix, readConfig, returnPath } from '../store.mjs'
import { unitsOpen } from '../verdict.mjs'
import { coverageOf, dispatch, searchRounds, step } from './common.mjs'

export const ARGS = {
  artifact: { kind: 'file', required: true, as: 'artifact_text' },
  roots: { kind: 'list', default: ['.'] },
  context: { kind: 'text' },
  per_axis: { kind: 'bool' },
  since: { kind: 'text' },
}

/** Pure. What a second probe waits for: the same artefact, by the absolute path it resolved to. */
export const scopeOf = (args) => ({ artifact: posix(args.artifact) })

// One analyst holds every axis; another is bought per this many lines of artefact, or this many axes.
const LINES_PER_ANALYST = 400
const AXES_PER_ANALYST = 12

const listOf = (v) => (Array.isArray(v) ? v : [])
const textOf = (v) => (typeof v === 'string' ? v.trim() : '')
const lineCount = (text) => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length)

/** The text a snapshot holds: what the probers read and the findings are anchored to. */
const snapshotText = (repo, snapshot) =>
  readFileSync(join(evidenceSnapshotsDir(repo), snapshot.slice('snapshot:'.length) + '.txt'), 'utf8')

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
 * The probe: snapshot the artefact, resolve its citations, locate the repository's guidance and the
 * ground it talks about, derive the repository's axes, and have every axis attacked against every
 * section; record the round only when every prober returned.
 */
export async function probe(ctx, args) {
  const scope = await step(ctx, 'scope', () => reviewScope(ctx.repo, args.artifact, '', { root: ctx.root }))
  const artifact = scope.ok ? scope.path : posix(args.artifact)
  const text = scope.ok ? snapshotText(ctx.repo, scope.snapshot) : args.artifact_text
  const guidance = guidanceOf(ctx.root, { dirs: args.roots, config: readConfig(ctx.repo) })
  const failed = []
  const incomplete = []
  const unreached = []

  const cited = resolveCitations(ctx.root, args.artifact, 10)
  const search = await searchRounds(ctx, {
    role: 'scout', schema: 'scout_located', thread: 'locate', brief: locateBrief({ artifact, text, roots: args.roots, guidance }),
  })
  const reports = search.rounds.map((r) => ({ label: 'locate', output: r.output }))
  if (reports.length === 0) {
    failed.push('repo-axes', 'repo-ground')
    unreached.push('the locating scout failed (' + search.cause + '), so neither the repository\'s guidance nor the ground ' +
      'this artefact talks about was located: the standing axes probed the artefact and its own citations only')
  } else if (search.outcome !== 'done') {
    incomplete.push('locate')
    unreached.push('locate: the search for guidance and ground ended (' + (search.why || search.cause) + ') before it was exhausted')
  }
  const ground = reports.length ? { ...excerptsText(ctx.root, reports, { kind: 'ground' }), complete: search.outcome === 'done' } : null

  let found = null
  if ((search.kinds.guidance || 0) > 0) {
    const located = excerptsText(ctx.root, reports, { kind: 'guidance' }).text
    const d = await dispatch(ctx, { role: 'analyst', schema: 'axes', thread: 'axes', brief: axesBrief({ roots: args.roots, located, guidance }) })
    if (d.status === 'returned' && d.output.stop_reason !== 'unreadable') found = d.output
    else {
      failed.push('repo-axes')
      unreached.push('the axes analyst ' + (d.status === 'returned' ? 'could not read the guidance' : 'failed (' + d.cause + ')') +
        ', so this repository\'s own review guidance was not probed: the standing axes only')
    }
  }
  const axes = [...STANDING_AXES, ...repoAxes(found)]

  const sections = sectionsOf(text)
  const bundles = bundlesOf(axes, scope.ok ? scope.lines : lineCount(text), args.per_axis)
  const held = bundles.map((b) => unitsOf(b.map((a) => a.key), sections))
  const probed = await Promise.all(bundles.map((bundle, i) => dispatch(ctx, {
    role: 'analyst', schema: 'prober', thread: 'prober:' + (i + 1),
    brief: proberBrief({ artifact, text, context: args.context, axes: bundle, units: held[i], sections, cited, ground, guidance }),
  })))

  const lost = probed.flatMap((d, i) => (d.status === 'returned' ? [] : [i]))
  if (lost.length) failed.push('probe')
  for (const i of lost) {
    unreached.push('prober:' + (i + 1) + ' failed (' + probed[i].cause + '), so its units are open and the round was not ' +
      'recorded: start the run again to finish it')
  }
  const rulings = probed.flatMap((d, i) => (d.status === 'returned' ? rulingsOf(d.output, held[i]) : []))
  const kept = probed.flatMap((d, i) => (d.status === 'returned' ? [i] : []))
  const spec = {
    file: args.artifact, from: kept.map((i) => probed[i].output), bundle: kept.map((i) => bundles[i].map((a) => a.key).join('+')),
    units: rulings,
  }
  const opts = { root: ctx.root, now: new Date(ctx.now()) }
  let record = null
  if (!scope.ok) {
    failed.push('record')
    unreached.push('the artefact could not be snapshotted (' + scope.error.kind + ': ' + scope.error.message + '), so no finding ' +
      'was numbered or recorded; the probers\' findings are in their stored returns: ' +
      kept.map((i) => posix(returnPath(ctx.dir, probed[i].dispatch))).join(', '))
  } else if (lost.length) {
    record = recordProbe(ctx.repo, { ...spec, snapshot: '' }, opts)
  } else {
    record = await step(ctx, 'record', () => recordProbe(ctx.repo, { ...spec, snapshot: scope.snapshot }, opts))
  }

  const units = unitsOf(axes.map((a) => a.key), sections)
  return resultOf(ctx, {
    scope, artifact, axes, bundles, shared: { resolved: cited.read_error === '', ...cited.counts },
    guidanceRead: found ? listOf(found.guidance_read) : [], ground,
    located: search.kinds.ground || 0, units, open: unitsOpen(units, rulings), record,
    declared: search.outcome === 'done' ? ['locate'] : [], incomplete, failed, unreached,
  })
}

/** The probe's result and its coverage block: ratifiable only when complete and no ambiguity is open. */
function resultOf(ctx, { scope, artifact, axes, bundles, shared, guidanceRead, ground, located, units, open, record, declared, incomplete, failed, unreached }) {
  const findings = record ? record.findings : []
  const recorded = Boolean(record && record.recorded)
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
    ratifiable: coverage.complete && ambiguities.length === 0,
    snapshot: recorded ? scope.snapshot : '',
    scope: scope.ok ? { full: scope.full, changed: scope.changed } : { full: true, changed: [] },
    unrecorded: recorded ? [] : findings.filter((f) => !f.carried).map((f) => f.id),
    review: record ? record.return : '',
    coverage,
  }
}
