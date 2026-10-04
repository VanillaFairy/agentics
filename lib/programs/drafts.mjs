// lib/programs/drafts.mjs — approach drafts: one analyst per assigned stance, all dispatched at once,
// each draft recorded as an `approach` return as it comes back.
//
// Design: docs/DESIGN.md#programs.

import { guidanceOf } from '../brief.mjs'
import { draftBrief } from '../briefs/drafts.mjs'
import { recordRaw } from '../evidence.mjs'
import { fnv1a } from '../plan-digest.mjs'
import { readConfig, safeSlug } from '../store.mjs'
import { coverageOf, dispatch, step } from './common.mjs'

export const ARGS = {
  question_file: { kind: 'file', required: true, as: 'question' },
  stances: { kind: 'list', required: true },
  intelligence: { kind: 'enum', values: ['low', 'normal', 'max'], default: 'normal' },
}

/** Pure. What a second run may not run beside: drafts for the same question. */
export const scopeOf = (args) => ({ question: fnv1a(args.question) })

/** The drafts' result, its coverage computed from what was lost. */
function resultOf(ctx, drafted, lost) {
  return { drafts: drafted, coverage: coverageOf({ ...lost, resumable: ctx.resumable }) }
}

/** Record one draft as an `approach` return. A refusal throws, so the step records nothing and a relaunch records it. */
function recordDraft(ctx, stance, draft) {
  const out = recordRaw(ctx.repo, 'approach', { stance, ...draft }, { now: new Date(ctx.now()), root: ctx.root })
  if (!out.ok) throw new Error(out.error ? out.error.message : 'the store refused the draft')
  return out.return
}

/** One stance: its draft, recorded; `lost` names the channel that failed, and `why` says what that cost. */
async function draftOne(ctx, { question, stance, intelligence, guidance }) {
  const out = await dispatch(ctx, {
    role: 'analyst', schema: 'approach', thread: 'draft:' + stance, intelligence,
    brief: draftBrief({ question, stance, guidance }),
  })
  if (out.status !== 'returned') {
    return { entry: { stance, return: '', draft: null }, lost: 'draft:' + stance, why: 'draft:' + stance + ' failed (' + out.cause + '), so the stance has no draft' }
  }
  try {
    return { entry: { stance, return: await step(ctx, 'record:' + stance, () => recordDraft(ctx, stance, out.output)), draft: out.output } }
  } catch (err) {
    return { entry: { stance, return: '', draft: out.output }, lost: 'record:' + stance, why: 'record:' + stance + ' failed (' + err.message + '), so the draft is not kept as evidence' }
  }
}

/** Approach drafts (docs/DESIGN.md#design): every stance at once, each recorded as it returns. */
export async function drafts(ctx, args) {
  const lost = { failed_channels: [], unreached: [] }
  const stances = [...new Set(args.stances)]
  if (!args.question.trim()) lost.unreached.push('no question was supplied, so no draft was written')
  if (stances.length === 0) lost.unreached.push('no stance was given, so no draft was written')
  for (const s of stances.filter((x) => safeSlug(x) === null)) {
    lost.unreached.push('stance ' + JSON.stringify(s) + ' is not a name of lower-case letters, digits and single dashes, so no draft was written')
  }
  if (lost.unreached.length > 0) return resultOf(ctx, [], lost)
  const guidance = guidanceOf(ctx.root, { config: readConfig(ctx.repo) })
  const outcomes = await Promise.all(stances.map((stance) =>
    draftOne(ctx, { question: args.question, stance, intelligence: args.intelligence, guidance })))
  for (const o of outcomes.filter((x) => x.lost)) {
    lost.failed_channels.push(o.lost)
    lost.unreached.push(o.why)
  }
  return resultOf(ctx, outcomes.map((o) => o.entry), lost)
}
