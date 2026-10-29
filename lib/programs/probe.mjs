// lib/programs/probe.mjs — the probe program: attacks a written artefact with analysts handed the
// document, the repository's excerpts and nothing from its author, has every axis ruled against every
// section, and records the round's findings anchored to the snapshot they read. One search over the
// probe's tree locates the repository's guidance and the ground the document talks about.
//
// Design: docs/DESIGN.md#probe.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { oversizedPart } from '../briefs/size.mjs'
import { LOCATE_FIND, LOCATE_LABELS, STANDING_AXES, axesBrief, locateGroundFind, proberBrief, relocateBrief } from '../briefs/probe.mjs'
import { hitBlocks, hitExcerpts, mergeRanges, placeOf, resolveCitations } from '../citations.mjs'
import { offload } from '../offload.mjs'
import { carriedFindings, changedParts, recordProbe, sectionSlug, sectionUnitOf, sectionUnits, sectionsOf, unitsOf } from '../evidence.mjs'
import { settledFindings } from '../approval.mjs'
import { settledContext, specFolderOf } from '../spec.mjs'
import { reviewDelta } from '../review-delta.mjs'
import { evidenceSnapshotsDir, posix, returnPath, writeWhole } from '../store.mjs'
import { unitsOpen } from '../verdict.mjs'
import { briefRoomOf, coverageOf, dialed, dispatch, step } from './common.mjs'
import { budgetOf, pinnedOf, searchComplete, searchCoverage } from './search/consume.mjs'
import { search } from './search/search.mjs'

export const ARGS = {
  artifact: { kind: 'file', required: true, as: 'artifact_text' },
  roots: { kind: 'list', default: ['.'] },
  context: { kind: 'text' },
  context_file: { kind: 'file', as: 'context' },
  per_axis: { kind: 'bool' },
  since: { kind: 'snapshot' },
  intelligence: { kind: 'enum', values: ['low', 'normal', 'max'], default: 'normal' },
  search_budget: { kind: 'usd' },
}

/** Pure. What a second probe waits for: the same artefact, by the absolute path it resolved to. */
export const scopeOf = (args) => ({ artifact: posix(args.artifact) })

// One analyst holds every axis; another is bought per this many lines attacked, the text being what fills its context.
const LINES_PER_ANALYST = 400
// The judge of whether a narrowed round's changed lines name ground no earlier round located: any doubt routes to a search.
const RELOCATE_TIER = { model: 'haiku', effort: 'low' }

const listOf = (v) => (Array.isArray(v) ? v : [])
const textOf = (v) => (typeof v === 'string' ? v.trim() : '')
const lineCount = (text) => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length)

/** The findings a disposition settled on the folder whose spec `artifact` is; [] for any other artefact. */
function settledOf(repo, artifact) {
  const of = specFolderOf(repo, artifact)
  return of ? settledFindings(repo, of.effort, of.folder) : []
}

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

/** Pure. The probers `lines` attacked earn, however many axes they are attacked on. */
export const probersFor = (lines) => Math.max(1, Math.ceil(lines / LINES_PER_ANALYST))

/** Pure. The axes dealt round-robin to as many probers as the lines earn, never more than one per axis. */
function bundlesOf(axes, lines, perAxis) {
  const n = perAxis ? axes.length : Math.max(1, Math.min(axes.length, probersFor(lines)))
  const bundles = Array.from({ length: n }, () => [])
  axes.forEach((a, i) => bundles[i % n].push(a))
  return bundles
}

/** Pure. A prober's unit rulings, kept only for the units it was handed. */
const rulingsOf = (output, held) => listOf(output.units)
  .filter((u) => u && held.includes(u.unit))
  .map(({ unit, ruling, why }) => ({ unit, ruling, why }))

const besideFile = (repo, snapshot, kind) => join(evidenceSnapshotsDir(repo), snapshot.slice('snapshot:'.length) + '.' + kind + '.json')
const groundFile = (repo, snapshot) => besideFile(repo, snapshot, 'ground')

/**
 * The ground a recorded round kept beside its snapshot for the next narrowed one: its repository
 * axes, the guidance they rest on, the places it located and their excerpts; null when it kept none.
 */
function keptGround(repo, snapshot) {
  try {
    const kept = JSON.parse(readFileSync(groundFile(repo, snapshot), 'utf8'))
    return kept && Array.isArray(kept.axes) && Array.isArray(kept.located) && Array.isArray(kept.guidance_read) ? kept : null
  } catch {
    return null
  }
}

/** Keep one record of a recorded round beside its snapshot, written whole or not at all. */
function keepBeside(repo, snapshot, kind, value) {
  writeWhole(besideFile(repo, snapshot, kind), value)
}

/**
 * The unit rulings a recorded round kept beside its snapshot (`{unit, anchor}`, its section units
 * that hold a ruling, docs/DESIGN.md#review-delta); [] when it kept none, which leaves every unit of
 * the next narrowed round to rule.
 */
function keptRulings(repo, snapshot) {
  try {
    const kept = JSON.parse(readFileSync(besideFile(repo, snapshot, 'rulings'), 'utf8'))
    return Array.isArray(kept.rulings) ? kept.rulings.filter((r) => r && typeof r.unit === 'string' && typeof r.anchor === 'string') : []
  } catch {
    return []
  }
}

/** Keep a recorded round's unit rulings beside its snapshot, for the next narrowed round's delta. */
export const keepRulings = (repo, snapshot, rulings) => keepBeside(repo, snapshot, 'rulings', { rulings: rulings.map(({ unit, anchor }) => ({ unit, anchor })) })

/**
 * Pure. A narrowed round's changed ranges widened by the whole of every section a unit of `delta`
 * rules with no earlier ruling — an axis no round attacked it on, a section new or renamed, a unit
 * the `since` round left open — so a partial round is finished by the next narrowed one and a
 * section is never attacked by its changed lines alone on an axis that never read the rest. The
 * slugs widened come back in `widened`.
 */
function widenedScope(scope, text, delta) {
  const slugs = [...new Set(delta.rule.filter((r) => !r.was).map((r) => r.unit.slice(r.unit.indexOf('@') + 1)))]
  if (slugs.length === 0) return { ...scope, widened: [] }
  const ranges = [...scope.changed, ...sectionsOf(text).filter((s) => slugs.includes(s.slug))].map((r) => ({ from: r.start, to: r.end }))
  return { ...scope, changed: mergeRanges(ranges).map((r) => ({ start: r.from, end: r.to })), widened: slugs }
}

/**
 * Pure. The section units that hold a ruling after a round: each whose ruling stood, and each the
 * round ruled whose every unit it handed — the section whole, or each changed part of it — a prober
 * ruled (`open` the units none did).
 */
function heldRulings(delta, units, open) {
  const left = new Set(open)
  const ruledNow = delta.rule.filter((r) => {
    const parts = units.filter((u) => sectionUnitOf(u) === r.unit)
    return parts.length > 0 && parts.every((u) => !left.has(u))
  })
  return [...delta.stand, ...ruledNow]
}

/**
 * Pure. The kept ground with a narrowed round's own located ground after it, each place once: a hit
 * located again keeps the newer lines, where it now stands; a search block word for word the same is
 * kept once. Null when neither holds any.
 */
export function joinedGround(kept, added) {
  if (!kept || !added) return kept || added
  const blocks = [...hitBlocks(kept.text), ...hitBlocks(added.text)]
  const keyOf = (b) => (b.kind === 'hit' ? 'hit ' + b.head : 'search ' + b.text)
  const last = new Map(blocks.map((b, i) => [keyOf(b), i]))
  const once = blocks.filter((b, i) => last.get(keyOf(b)) === i)
  return {
    text: once.map((b) => b.text).join('\n\n'),
    counts: { hits: once.filter((b) => b.kind === 'hit').length, unresolved: kept.counts.unresolved + added.counts.unresolved },
    complete: kept.complete && added.complete,
  }
}

/**
 * Pure. The probers' briefs `build(ground, settled)` makes, with what code accumulated in them
 * bounded (lib/briefs/size.mjs): while a brief is past its `room`, or past a part's budget in the
 * ground or the settled specs, the oldest places of the ground are shed, enough to cover what is over,
 * then the farthest settled spec. A part of the user's past its own budget, or nothing left to shed,
 * leaves the refusal to the dispatch. `shed` holds each place's head line and each spec's file.
 */
export function boundedBriefs(build, { ground, settled }, room) {
  const shed = { places: [], specs: [] }
  let g = ground
  let specs = settled
  for (;;) {
    const briefs = build(g, specs)
    const over = briefs.map((b) => oversizedPart(b.parts, room)).find(Boolean)
    const blocks = g ? hitBlocks(g.text) : []
    const hits = blocks.filter((b) => b.kind === 'hit')
    const part = over && (over.whole ? (hits.length ? 'ground' : 'settled') : over.part)
    if (!over || (part === 'ground' && !hits.length) || (part === 'settled' && !specs.length) || !['ground', 'settled'].includes(part)) {
      return { briefs, ground: g, settled: specs, shed }
    }
    if (part === 'settled') {
      shed.specs.push(specs[specs.length - 1].file)
      specs = specs.slice(0, -1)
      continue
    }
    const gone = new Set()
    for (let freed = 0; freed < over.bytes - over.budget && gone.size < hits.length; ) {
      const next = hits[gone.size]
      gone.add(next)
      freed += Buffer.byteLength(next.text) + 2
    }
    shed.places.push(...[...gone].map((b) => b.head))
    g = { ...g, text: blocks.filter((b) => !gone.has(b)).map((b) => b.text).join('\n\n'), counts: { ...g.counts, hits: g.counts.hits - gone.size } }
  }
}

/** Pure. A located search's hits as the places a later round's relocate judge reads. */
const placesOf = (located) => (located ? located.hits.map((h) => placeOf(h) + ' — ' + h.note) : [])

/** Pure. The artefact as the locating search's material: whole, or each changed range alone. */
export function locateMaterial(text, artifact, changed) {
  const lines = String(text || '').replace(/\n$/, '').split('\n')
  if (!changed) return [{ label: artifact, text: lines.join('\n') }]
  return changed.map((r) => ({ label: artifact + ', lines ' + r.start + '-' + r.end, text: lines.slice(r.start - 1, r.end).join('\n') }))
}

/**
 * The probe: snapshot the artefact, resolve its citations and, for a folder's spec, read the specs
 * above it as settled context, locate the repository's guidance and the
 * ground it talks about in one search over the probe's tree, derive the repository's axes, and have every axis attacked against every
 * section in scope — given `since`, each changed part of a section, every earlier finding no edit
 * touched carried, and the ground and axes that round kept reused, searching only for what a haiku
 * judge says the changed lines name beyond it; record the round only when every prober returned, and
 * keep its ground beside its snapshot. `axes`, in-process only,
 * are standing axes the caller adds to the four. A finding a disposition of the artefact's folder
 * settled is not carried.
 */
export async function probe(entered, args) {
  const ctx = dialed(entered, args)
  const journaled = await step(ctx, 'scope', async () => {
    // Its anchor checks spawn git once per span: on the offload worker, so the main thread keeps turning.
    return offload('evidence.mjs', 'reviewScope', [ctx.repo, args.artifact, args.since || '', { root: ctx.root, settled: settledOf(ctx.repo, args.artifact) }],
      { label: 'the review scope of ' + args.artifact })
  })
  const { scope: read, text: snapped } = heldScope(ctx.repo, journaled)
  const narrow = read.ok && !read.full
  const artifact = read.ok ? read.path : posix(args.artifact)
  const text = read.ok ? snapped : args.artifact_text
  const kept = narrow ? keptGround(ctx.repo, read.since) : null
  const prior = narrow ? keptRulings(ctx.repo, read.since) : []
  const standing = [...STANDING_AXES, ...listOf(args.axes)]
  // Before any agent, the delta over the axes known so far: the kept ones, else those the `since` round ruled on.
  const knownAxes = [...new Set([...standing.map((a) => a.key), ...(kept ? kept.axes.map((a) => a.key) : prior.map((p) => p.unit.slice(0, p.unit.indexOf('@'))))])]
  const early = narrow ? reviewDelta(prior, sectionUnits(knownAxes, text)) : null
  if (narrow && early.rule.length === 0) return unchanged(ctx, args, read, early.stand)
  const scope = narrow ? widenedScope(read, text, early) : read
  const { tree, guidance } = pinnedOf(ctx, args)
  const failed = []
  const incomplete = []
  const unreached = []
  const cited = resolveCitations(tree.root, args.artifact, 10)
  const material = locateMaterial(text, artifact, narrow ? scope.changed : null)
  const declared = []
  const settled = settledContext(ctx.repo, args.artifact)
  if (settled && settled.specs.length) declared.push('settled context: ' + settled.specs.map((s) => s.file).join(', '))
  for (const id of settled ? settled.unread : []) {
    unreached.push('settled context: the spec of ' + id + ' could not be read, so the probers were not handed it')
  }

  // A narrowed round over kept ground searches only for what its changed lines name that the kept ground does not cover.
  let unlocated = []
  if (kept) {
    declared.push('ground and axes kept from ' + scope.since + ', the round its changes are measured from')
    const d = await dispatch(ctx, {
      role: 'analyst', schema: 'relocate', thread: 'relocate', tier: RELOCATE_TIER, brief: relocateBrief({ artifact, material, located: kept.located }),
    })
    unlocated = d.status === 'returned' ? listOf(d.output.unlocated).filter((t) => t && textOf(t.term)) : null
    if (unlocated === null) declared.push('the relocate judge failed (' + d.cause + '), so the changed lines were searched for their ground')
  }
  const searched = !kept || unlocated === null || unlocated.length > 0
  const located = searched
    ? await search(ctx, {
      name: 'locate', domain: 'repo', tree, scope: args.roots, material, budget: budgetOf(args),
      ...(kept ? { find: locateGroundFind(unlocated || []), labels: ['ground'] } : { find: LOCATE_FIND, labels: LOCATE_LABELS }),
    })
    : null
  const complete = located ? searchComplete(located) : true
  const added = located && (located.hits.length > 0 || complete) ? { ...hitExcerpts(located), complete } : null
  const ground = kept ? joinedGround(kept.ground, added) : added

  let found = null
  if (!kept && (guidance || located.hits.some((h) => h.label === 'guidance'))) {
    const guided = hitExcerpts(located, { label: 'guidance' }).text
    const d = await dispatch(ctx, { role: 'analyst', schema: 'axes', thread: 'axes', brief: axesBrief({ roots: args.roots, located: guided, guidance }) })
    if (d.status === 'returned' && d.output.stop_reason !== 'unreadable') found = d.output
    else {
      failed.push('repo-axes')
      unreached.push('the axes analyst ' + (d.status === 'returned' ? 'could not read the guidance' : 'failed (' + d.cause + ')') +
        ', so this repository\'s own review guidance was not probed: the standing axes only')
    }
  }
  const ownAxes = kept ? kept.axes : repoAxes(found, standing)
  const axes = [...standing, ...ownAxes]

  // The delta over the round's axes: what it rules, its changed ranges widened where a unit was never ruled.
  const delta = narrow ? reviewDelta(prior, sectionUnits(axes.map((a) => a.key), text)) : null
  const attack = narrow ? widenedScope(read, text, delta) : scope
  if (narrow && attack.widened.length) declared.push('sections no ruling of ' + read.since + ' stands for on every axis, attacked whole: ' + attack.widened.join(', '))
  const sections = narrow ? changedParts(sectionsOf(text), attack.changed) : sectionsOf(text)
  const ruled = narrow ? new Set(delta.rule.map((r) => r.unit)) : null
  const attacked = narrow ? attack.changed.reduce((n, r) => n + r.end - r.start + 1, 0) : scope.ok ? scope.lines : lineCount(text)
  const bundles = bundlesOf(axes, attacked, args.per_axis)
  const toRule = (keys) => unitsOf(keys, sections).filter((u) => !ruled || ruled.has(sectionUnitOf(u)))
  const held = bundles.map((b) => toRule(b.map((a) => a.key)))
  const claimOf = new Map(narrow ? scope.carried.map((it) => [it.id, it.claim]) : [])
  const carried = narrow ? carriedFindings(scope).map((f) => ({ ...f, claim: claimOf.get(f.item) })) : []
  const narrowing = narrow ? { changed: attack.changed, carried } : null
  const bounded = boundedBriefs((g, specs) => bundles.map((bundle, i) => proberBrief({
    artifact, text, context: args.context, settled: specs, axes: bundle, units: held[i], sections, cited, ground: g, guidance, narrow: narrowing,
  })), { ground, settled: settled ? settled.specs : [] }, briefRoomOf('analyst'))
  if (bounded.shed.places.length) {
    declared.push(bounded.shed.places.length + ' place(s) of the repository ground left out of the probers\' briefs to fit them, the oldest first: ' +
      bounded.shed.places.map((h) => h.replace(/^- /, '')).join('; '))
  }
  if (bounded.shed.specs.length) declared.push('settled context left out of the probers\' briefs to fit them, the farthest first: ' + bounded.shed.specs.join(', '))
  const probed = await Promise.all(bundles.map((bundle, i) => dispatch(ctx, { role: 'analyst', schema: 'prober', thread: 'prober:' + (i + 1), brief: bounded.briefs[i] })))

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
    const d = probed[i]
    unreached.push(d.cause === 'brief_too_large'
      ? 'prober:' + (i + 1) + ' was not sent: ' + d.message + '; its units are open and the round was not recorded until that part fits'
      : 'prober:' + (i + 1) + ' failed (' + d.cause + '), so its units are open and the round was not recorded: start the run again to finish it')
  }
  const rulings = outputs.flatMap((out, i) => (out ? rulingsOf(out, held[i]) : []))
  const returned = outputs.flatMap((out, i) => (out ? [i] : []))
  const recordSpec = {
    file: args.artifact, from: returned.map((i) => outputs[i]), bundle: returned.map((i) => bundles[i].map((a) => a.key).join('+')),
    units: rulings, since: narrow ? scope.since : '', carried: narrow ? scope.carried : [],
  }
  const opts = { root: ctx.root, now: new Date(ctx.now()) }
  let record = null
  if (!scope.ok) {
    failed.push('record')
    unreached.push('the artefact could not be snapshotted (' + scope.error.kind + ': ' + scope.error.message + '), so no finding ' +
      'was numbered or recorded; the probers\' findings are in their stored returns: ' +
      returned.map((i) => posix(returnPath(ctx.dir, probed[i].dispatch))).join(', '))
  } else if (lost.length) {
    record = recordProbe(ctx.repo, { ...recordSpec, snapshot: '' }, opts)
  } else {
    record = await step(ctx, 'record', () => recordProbe(ctx.repo, { ...recordSpec, snapshot: scope.snapshot }, opts))
  }
  const units = toRule(axes.map((a) => a.key))
  const open = unitsOpen(units, rulings)
  if (record && record.recorded) keepRulings(ctx.repo, scope.snapshot, heldRulings(narrow ? delta : reviewDelta([], sectionUnits(axes.map((a) => a.key), text)), units, open))
  const guidanceRead = kept ? kept.guidance_read : found ? listOf(found.guidance_read) : []
  // Only whole ground is kept: a round that would hand on an unfinished search or missing axes keeps nothing.
  if (record && record.recorded && complete && !failed.includes('repo-axes')) {
    keepBeside(ctx.repo, scope.snapshot, 'ground', {
      axes: ownAxes, guidance_read: guidanceRead,
      located: [...new Set([...(kept ? kept.located : []), ...placesOf(located)])].filter((l) => !bounded.shed.places.some((h) => h.startsWith('- ' + l))),
      ground: bounded.ground && { text: bounded.ground.text, counts: bounded.ground.counts, complete: bounded.ground.complete },
    })
  }

  return resultOf(ctx, {
    scope: attack, artifact, axes, bundles, shared: sharedOf(cited),
    guidanceRead,
    repoGround: { status: located ? located.status : 'kept', hits: bounded.ground ? bounded.ground.counts.hits : 0, unresolved: ground ? ground.counts.unresolved : 0 },
    refused: probed.flatMap((d, i) => (d.cause === 'brief_too_large' ? [{ prober: 'prober:' + (i + 1), part: d.part, owner: d.owner, file: d.file, bytes: d.bytes, budget: d.budget, message: d.message }] : [])),
    units, open, record, declared: [...declared, ...covered.declared], incomplete, failed, unreached,
  })
}

/**
 * A narrowed round with nothing to rule since `since` (every unit's ruling stands, `stand`): no agent,
 * one empty round recorded, every earlier finding carried and every ruling kept.
 */
async function unchanged(ctx, args, scope, stand) {
  const record = await step(ctx, 'record', () => recordProbe(ctx.repo, { file: args.artifact, snapshot: scope.snapshot, since: scope.since, carried: scope.carried },
    { root: ctx.root, now: new Date(ctx.now()) }))
  if (record && record.recorded) keepRulings(ctx.repo, scope.snapshot, stand)
  return resultOf(ctx, {
    scope, artifact: scope.path, axes: [], bundles: [], shared: sharedOf(null),
    guidanceRead: [], repoGround: { status: '', hits: 0, unresolved: 0 }, units: [], open: [], record, declared: [], incomplete: [], failed: [], unreached: [],
  })
}

/** The probe's result and its coverage block: ratifiable only when complete, no ambiguity is open and every finding was recorded. */
function resultOf(ctx, { scope, artifact, axes, bundles, shared, guidanceRead, repoGround, refused = [], units, open, record, declared, incomplete, failed, unreached }) {
  const findings = record ? record.findings : []
  const recorded = Boolean(record && record.recorded)
  const unrecorded = recorded ? [] : findings.filter((f) => !f.carried).map((f) => f.id)
  const ambiguities = findings.filter((f) => f.severity === 'ambiguity').map((f) => f.id)
  const coverage = coverageOf({ log: ctx.log,
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
    refused,
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
