// lib/programs/solutions.mjs — the existing-solutions sweep: frame the capability, search for it by
// angle and through the repository, have an assessor weigh the candidates against the frame, and
// record what it all means in-process.
//
// Design: docs/DESIGN.md#existing-solutions.

import { guidanceOf } from '../brief.mjs'
import { assessBrief, frameBrief, repoBrief, researchBrief } from '../briefs/solutions.mjs'
import { recordSolutions, sectionSlug } from '../evidence.mjs'
import { fnv1a } from '../plan-digest.mjs'
import { readConfig } from '../store.mjs'
import { coverageOf, dispatch, dispatchJudge, searchRounds, step, threadOf } from './common.mjs'

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

/** Pure. A search's declaration, from its stored rounds: its last stop, what it found absent, what it never reached. */
function declaredOf(channel, search) {
  const outs = search.rounds.map((r) => r.output)
  if (outs.length === 0) return []
  const last = outs[outs.length - 1]
  const absent = outs.map((o) => textOf(o.no_match)).filter(Boolean)
  const remains = textOf(last.not_reached)
  return [channel + ': ' + (textOf(last.stop_reason) || 'no stop reason') +
    (absent.length ? '; found nothing: ' + absent.join('; ') : '') + (remains ? '; not reached: ' + remains : '')]
}

/** Pure. What a search that did not end done left unsearched, as one line of prose. */
function shortOf(channel, search) {
  const outs = search.rounds.map((r) => r.output)
  const remains = outs.length ? textOf(outs[outs.length - 1].not_reached) : ''
  const how = search.outcome === 'failed' ? 'failed (' + search.cause + ')' : 'stopped (' + search.why + ')'
  return channel + ' ' + how + ' and never reached ' +
    (remains || (outs.length ? 'whatever its rounds did not name' : 'anything it was sent to search'))
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

/** The sweep (docs/DESIGN.md#existing-solutions): frame, researchers and the repository scan, the assessment, the record. */
export async function solutions(ctx, args) {
  const lost = { declared: [], dropped: [], incomplete: [], failed_channels: [], unreached: [] }
  const capability = args.capability
  if (!textOf(capability)) {
    lost.unreached.push('no capability was supplied, so nothing was searched')
    return resultOf(ctx, args, lost)
  }
  const guidance = guidanceOf(ctx.root, { dirs: args.roots, config: readConfig(ctx.repo) })
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

  const [searches, scan] = await Promise.all([
    Promise.all(kept.map((angle) => searchRounds(ctx, {
      role: 'doc-researcher', schema: 'candidates', thread: 'research:' + angle.key,
      brief: researchBrief({ frame, angle, constraints: args.constraints, guidance }),
    }))),
    searchRounds(ctx, { role: 'scout', schema: 'scout_hits', thread: 'repo', brief: repoBrief({ frame, roots: args.roots, guidance }) }),
  ])

  kept.forEach((angle, i) => {
    const channel = 'find:' + angle.key
    lost.declared.push(...declaredOf(channel, searches[i]))
    if (searches[i].outcome !== 'done') {
      lost.incomplete.push(channel)
      lost.unreached.push(shortOf(channel, searches[i]))
    }
  })
  lost.declared.push(...declaredOf('repo', scan))
  if (scan.outcome === 'failed') lost.failed_channels.push('repo')
  else if (scan.outcome === 'stop') lost.incomplete.push('repo')
  if (scan.outcome !== 'done') lost.unreached.push(shortOf('repo', scan))

  const reports = kept.map((angle, i) => ({ key: angle.key, candidates: searches[i].rounds.flatMap((r) => listOf(r.output.candidates)) }))
  const units = [...new Set(reports.flatMap((r) => r.candidates.map((c) => nameKey(c.name))).filter(Boolean))]
  let assessment = null
  if (units.length > 0) {
    const assessed = await dispatchJudge({
      producer: kept.map((angle, i) => ({ session: searches[i].last.session, thread: 'research:' + angle.key })),
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
      candidates: searches.flatMap((s) => s.rounds.map((r) => r.output)),
      present: scan.rounds.length ? { hits: scan.rounds.flatMap((r) => listOf(r.output.hits)) } : '',
    }, { root: ctx.root, now: new Date(ctx.now()) }))
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
