// lib/programs/solutions.mjs — the existing-solutions sweep: frame the capability, search for it by
// angle and through the repository, have an assessor weigh the candidates against the frame, and
// record what it all means in-process.
//
// Design: docs/DESIGN.md#existing-solutions.

import { assessBrief, frameBrief, repoFind, researchFind } from '../briefs/solutions.mjs'
import { recordSolutions, sectionSlug } from '../evidence.mjs'
import { fnv1a } from '../plan-digest.mjs'
import { rethrowHung } from '../store.mjs'
import { coverageOf, dialed, dispatch, dispatchJudge, step, threadOf } from './common.mjs'
import { budgetOf, pinnedOf, searchCoverage } from './search/consume.mjs'
import { search } from './search/search.mjs'

export const ARGS = {
  capability_file: { kind: 'file', required: true, as: 'capability' },
  roots: { kind: 'list', default: ['.'] },
  constraints: { kind: 'text' },
  constraints_file: { kind: 'file', as: 'constraints' },
  notes: { kind: 'text' },
  notes_file: { kind: 'file', as: 'notes' },
  max_angles: { kind: 'int', default: 4 },
  intelligence: { kind: 'enum', values: ['low', 'normal', 'max'], default: 'normal' },
  search_budget: { kind: 'usd' },
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

/** Pure. A search's candidates; its hits already hold one per candidate key. */
const candidatesOf = (s) => s.hits.filter((h) => h.candidate).map((h) => h.candidate)

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
export async function solutions(entered, args) {
  const ctx = dialed(entered, args)
  const lost = { declared: [], dropped: [], incomplete: [], failed_channels: [], unreached: [] }
  const capability = args.capability
  if (!textOf(capability)) {
    lost.unreached.push('no capability was supplied, so nothing was searched')
    return resultOf(ctx, args, lost)
  }
  const { tree, guidance } = pinnedOf(ctx, args)

  const framed = await dispatch(ctx, {
    role: 'analyst', schema: 'frame', thread: 'frame', base: 'medium',
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

  const budget = budgetOf(args)
  const context = [{ label: 'the capability', text: capability }, { label: 'what is wanted', text: textOf(frame.capability_line) }]
  const [searches, scan] = await Promise.all([
    Promise.all(kept.map((angle) => search(ctx, {
      name: 'research:' + angle.key, domain: 'web', tree, budget,
      find: researchFind({ frame, angle, constraints: args.constraints }),
      material: [...context, { label: 'the angle', text: angle.find }],
    }))),
    search(ctx, {
      name: 'repo', domain: 'repo', tree, budget, scope: args.roots, find: repoFind({ frame }),
      material: [...context, { label: 'what to look for', text: textOf(frame.repo_question) }],
    }),
  ])
  const covered = searchCoverage([...searches, scan])
  lost.declared.push(...covered.declared)
  lost.incomplete.push(...covered.incomplete)
  lost.failed_channels.push(...covered.failed_channels)
  lost.unreached.push(...covered.unreached)

  const reports = kept.map((angle, i) => ({ key: angle.key, candidates: candidatesOf(searches[i]) }))
  const units = [...new Set(reports.flatMap((r) => r.candidates.map((c) => nameKey(c.name))).filter(Boolean))]
  let assessment = null
  if (units.length > 0) {
    const assessed = await dispatchJudge({
      producer: searches.flatMap((s) => s.sessions),
      judge: { session: threadOf(ctx, { role: 'analyst', thread: 'assess' }).session, thread: 'assess' },
      run: () => dispatch(ctx, {
        role: 'analyst', schema: 'assessment', thread: 'assess', base: 'high',
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
      present: scan.hits.some((h) => h.path !== undefined)
        ? { hits: scan.hits.filter((h) => h.path !== undefined).map(({ path, line, note }) => ({ path, line, note })) } : '',
    }, { root: tree.root, now: new Date(ctx.now()) }))
  } catch (err) {
    rethrowHung(err)
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
