// lib/programs/investigate.mjs — the investigate program: a survey of the question inside this run,
// then one analyst who turns its evidence into a written answer or an ordered task list.
//
// Design: docs/DESIGN.md#programs.

import { guidanceOf } from '../brief.mjs'
import { synthesisBrief } from '../briefs/investigate.mjs'
import { readContext } from '../citations.mjs'
import { fnv1a } from '../plan-digest.mjs'
import { readConfig } from '../store.mjs'
import { coverageOf, dispatch } from './common.mjs'
import { survey } from './survey.mjs'

export const ARGS = {
  question_file: { kind: 'file', required: true, as: 'question' },
  roots: { kind: 'list', default: ['.'] },
  notes: { kind: 'text' },
  as_tasks: { kind: 'bool' },
  intelligence: { kind: 'enum', values: ['low', 'normal', 'max'], default: 'normal' },
  pace: { kind: 'enum', values: ['frugal', 'balanced', 'fast'], default: 'balanced' },
}

/** Pure. What a second investigation may not run over while this one is live. */
export const scopeOf = (args) => ({ question: fnv1a(args.question) })

export async function investigate(ctx, args) {
  const question = typeof args.question === 'string' ? args.question.trim() : ''
  const { roots = ['.'], notes = '', as_tasks: asTasks = false, intelligence = 'normal', pace = 'balanced' } = args
  const found = await survey(ctx, { question, roots, notes, prior: '', max_topics: 8, intelligence, pace, ground: [] })
  if (!question) return resultOf({ question, mode: 'report', found, resumable: ctx.resumable })
  const mode = asTasks ? 'tasks' : 'report'
  const out = await dispatch(ctx, {
    role: 'analyst', schema: asTasks ? 'investigate_tasks' : 'investigate_report', thread: 'synthesis', intelligence, base: 'high',
    brief: synthesisBrief({
      question, asTasks, evidence: readContext(found.context), coverage: found.coverage,
      guidance: guidanceOf(ctx.root, { dirs: roots, config: readConfig(ctx.repo) }),
    }),
  })
  if (out.status !== 'returned') return resultOf({ question, mode, found, failed: out.cause, resumable: ctx.resumable })
  return resultOf({ question, mode, found, resumable: ctx.resumable, tasks: asTasks ? out.output : null, report: asTasks ? null : out.output.report })
}

/** The investigation's result: the survey's evidence always, and its coverage with the synthesis's loss added. */
function resultOf({ question, mode, found, tasks = null, report = null, failed = '', resumable }) {
  const c = found.coverage
  return {
    question, mode, tasks, report,
    evidence: { items: found.items, context: found.context, risks: found.risks, history: found.history, docs: found.docs },
    coverage: coverageOf({
      declared: c.declared, dropped: c.dropped, incomplete: c.incomplete,
      failed_channels: failed ? [...c.failed_channels, 'synthesis'] : c.failed_channels,
      unreached: failed ? [...c.unreached, 'synthesis failed (' + failed + '): the evidence was gathered and never written up'] : c.unreached,
      resumable, also: c.complete,
    }),
  }
}
