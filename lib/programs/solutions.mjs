// lib/programs/solutions.mjs — the existing-solutions sweep: frame the capability, search for it by
// angle and through the repository, have an assessor weigh the candidates against the frame, and
// record what it all means in-process.
//
// Design: docs/DESIGN.md#existing-solutions.

import { guidanceOf } from '../brief.mjs'
import { assessBrief, frameBrief, repoFind, researchFind } from '../briefs/solutions.mjs'
import { recordSolutions, sectionSlug } from '../evidence.mjs'
import { fnv1a } from '../plan-digest.mjs'
import { candidateKey } from '../search/ledger.mjs'
import { treeOf } from '../search/pin.mjs'
import { readConfig } from '../store.mjs'
import { coverageOf, dispatch, dispatchJudge, step, threadOf } from './common.mjs'
import { search } from './search/loop.mjs'

export const ARGS = {
  capability_file: { kind: 'file', required: true, as: 'capability' },
  roots: { kind: 'list', default: ['.'] },
  constraints: { kind: 'text' },
  constraints_file: { kind: 'file', as: 'constraints' },
  notes: { kind: 'text' },
  notes_file: { kind: 'file', as: 'notes' },
  max_angles: { kind: 'int', default: 4 },
  intelligence: { kind: 'enum', values: ['low', 'normal', 'max'], default: 'normal' },
}

/** Pure. What a second sweep may not run beside: one over the same capability. */
export const scopeOf = (args) => ({ capability: fnv1a(args.capability) })

const COUNTS = ['present', 'candidates', 'viable', 'ruled_out', 'invented', 'lost', 'unanchored', 'unsettled']
const listOf = (v) => (Array.isArray(v) ? v : [])
const textOf = (v) => String(v ?? '').trim()
const nameKey = (name) => textOf(name).toLowerCase()

/** Pure. The frame's angles as thread-safe keys: a slug, `angle` when it has none, a repeated one numbered from -2. */
function anglesOf(frame) {
  const used = new Set()
  return listOf(frame.angles).map((a) => {
    const base = sectionSlug(a.key) || 'angle'
    let key = base
    for (let n = 2; used.has(key); n++) key = base + '-' + n
    used.add(key)
    return { key, find: textOf(a.find) }
  })
}

/** Pure. Whether a search produced nothing: it failed, or every ask paused with no hit. */
const nothingFrom = (s) => s.status === 'failed' || Object.values(s.asks).every((a) => a.end === 'stopped' && a.hits.length === 0)
/** Pure. Why a search produced nothing, as one line. */
const silentWhy = (s) => s.cause || Object.values(s.asks).map((a) => a.why).filter(Boolean).join('; ') || 'every ask paused'
/** Pure. One ask's candidates, one per candidate key; none when the search produced nothing. */
const candidatesOf = (s, key) => (nothingFrom(s) ? []
  : [...new Map(s.asks[key].hits.filter((h) => h.candidate).map((h) => [candidateKey(h.candidate), h.candidate])).values()])

/** What a search lost, into `lost` under `channel`: nothing → `whenNothing`; an ask short of done → incomplete. */
function lossOf(lost, channel, s, whenNothing) {
  if (nothingFrom(s)) {
    lost[whenNothing].push(channel)
    lost.unreached.push(channel + ' produced nothing (' + silentWhy(s) + ') and reached nothing it was sent to search')
    return
  }
  lost.declared.push(...s.coverage.declared)
  lost.failed_channels.push(...s.coverage.failed_channels)
  lost.unreached.push(...s.coverage.incomplete, ...s.coverage.unreached)
  if (Object.values(s.asks).some((a) => a.end !== 'done')) lost.incomplete.push(channel)
}

/** The sweep's result, its coverage computed from what was lost on the way. */
function resultOf(ctx, args, lost, decided = null) {
  const ok = decided !== null && decided.ok !== false
  return {
    capability: args.capability,
    constraints: args.constraints,
    summary: ok ? decided.summary_file : '',
    counts: Object.fromEntries(COUNTS.map((k) => [k, ok ? decided.counts[k] : 0])),
    measured: ok && decided.measured === true,
    items: ok ? decided.items : [],
    recorded: ok && decided.recorded === true,
    coverage: coverageOf({ ...lost, resumable: ctx.resumable }),
  }
}

/** The sweep (docs/DESIGN.md#existing-solutions): frame, a search per angle and one through the repository over the sweep's tree, the assessment, the record. */
export async function solutions(ctx, args) {
  const lost = { declared: [], dropped: [], incomplete: [], failed_channels: [], unreached: [] }
  const capability = args.capability
  if (!textOf(capability)) {
    lost.unreached.push('no capability was supplied, so nothing was searched')
    return resultOf(ctx, args, lost)
  }
  const config = readConfig(ctx.repo)
  const guidance = guidanceOf(ctx.root, { dirs: args.roots, config })
  const tree = args.tree || treeOf(ctx.root)
  const dial = { intelligence: args.intelligence }

  const framed = await dispatch(ctx, {
    role: 'analyst', schema: 'frame', thread: 'frame', ...dial, base: 'medium',
    brief: frameBrief({ capability, roots: args.roots, constraints: args.constraints, notes: args.notes, maxAngles: args.max_angles, guidance }),
  })
  const frame = framed.status === 'returned' ? framed.output : null
  const angles = frame ? anglesOf(frame) : []
  if (angles.length === 0) {
    lost.failed_channels.push('frame')
    lost.unreached.push(frame
      ? 'frame gave no search angles, so no ecosystem was searched and nothing here says whether a solution exists'
      : 'frame failed (' + framed.cause + '), so nothing was searched and nothing here says whether a solution exists')
    return resultOf(ctx, args, lost)
  }
  const kept = angles.slice(0, args.max_angles)
  lost.dropped.push(...angles.slice(args.max_angles).map((a) => a.key))

  // What every search reads as context; each search's own find is its ask's material.
  const context = [{ label: 'the capability', text: capability }, { label: 'what is wanted', text: textOf(frame.capability_line) }]
  const [searches, scan] = await Promise.all([
    Promise.all(kept.map((angle) => search(ctx, {
      name: 'research:' + angle.key, role: 'doc-researcher', schema: 'search_web', tree, config,
      asks: [{ key: angle.key, find: researchFind({ frame, angle, constraints: args.constraints }), scope: ['.'], domain: 'web' }],
      material: [...context, { label: 'the angle', text: angle.find, asks: [angle.key] }],
    }))),
    search(ctx, {
      name: 'repo', role: 'scout', schema: 'search_repo', tree, config,
      asks: [{ key: 'repo', find: repoFind({ frame }), scope: args.roots, domain: 'repo' }],
      material: [...context, { label: 'what to look for', text: textOf(frame.repo_question), asks: ['repo'] }],
    }),
  ])

  kept.forEach((angle, i) => lossOf(lost, 'find:' + angle.key, searches[i], 'incomplete'))
  lossOf(lost, 'repo', scan, 'failed_channels')

  const reports = kept.map((angle, i) => ({ key: angle.key, candidates: candidatesOf(searches[i], angle.key) }))
  const units = [...new Set(reports.flatMap((r) => r.candidates.map((c) => nameKey(c.name))).filter(Boolean))]
  let assessment = null
  if (units.length > 0) {
    const assessed = await dispatchJudge({
      producer: searches.flatMap((s) => s.sessions),
      judge: { session: threadOf(ctx, { role: 'analyst', thread: 'assess' }).session, thread: 'assess' },
      run: () => dispatch(ctx, {
        role: 'analyst', schema: 'assessment', thread: 'assess', ...dial, base: 'high',
        brief: assessBrief({ frame, reports, constraints: args.constraints, units, guidance }),
      }),
    })
    if (assessed.status === 'returned') {
      assessment = assessed.output
      const ruled = new Map(listOf(assessment.units).map((u) => [nameKey(u.unit), u.ruling]))
      lost.incomplete.push(...units.filter((u) => ruled.get(u) !== 'assessed').map((u) => 'assess:' + u))
    } else {
      lost.failed_channels.push('assess')
      lost.unreached.push('assess failed (' + (assessed.cause || assessed.error.kind) + '), so the candidates are carried ' +
        'unmeasured: neither viable nor ruled out, because nobody checked')
    }
  }

  let decided
  try {
    decided = await step(ctx, 'record', () => recordSolutions(ctx.repo, {
      question: capability, frame, assessed: assessment || '',
      candidates: reports.map((r) => ({ candidates: r.candidates })),
      present: nothingFrom(scan) ? '' : { hits: scan.asks.repo.hits.map((h) => ({ path: h.key, line: h.line, note: h.note })) },
    }, { root: tree.root, now: new Date(ctx.now()) }))
  } catch (err) {
    decided = { ok: false, error: { kind: 'record_failed', message: err.message } }
  }
  if (decided.ok === false) {
    lost.failed_channels.push('record')
    lost.unreached.push('record failed (' + decided.error.message + '), so nothing the sweep found was recorded or summarised')
    return resultOf(ctx, args, lost)
  }
  const { counts } = decided
  if (counts.lost > 0) lost.unreached.push(counts.lost + ' candidate(s) a researcher reported were never ruled on by the assessment; the summary names them')
  if (counts.invented > 0) lost.unreached.push(counts.invented + ' ground(s) the assessment cited are not among the frame\'s disqualifiers, so nothing was ruled out for them')
  if (counts.unsettled > 0) lost.unreached.push('the assessment could not settle questions it names in the summary')
  return resultOf(ctx, args, lost, decided)
}
