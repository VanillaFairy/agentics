// lib/programs/rule.mjs — the rule program: a changed spec briefed inline, with every answer the user
// gave since it was last approved, ruled by one ruler and settled.
//
// Design: docs/DESIGN.md#a-changed-spec.

import { approvalState } from '../approval.mjs'
import { citationHolds } from '../boundaries/integration.mjs'
import { guidanceOf } from '../brief.mjs'
import { rulerBrief } from '../briefs/respec.mjs'
import { respecBrief, respecSettle } from '../respec.mjs'
import { readConfig, writeJson } from '../store.mjs'
import { coverageOf, deliver, dispatch, step, stepped } from './common.mjs'

export const ARGS = {
  effort: { kind: 'effort', required: true },
  folder: { kind: 'folder', required: true },
}

export const scopeOf = (args) => ({ effort: args.effort, folder: args.folder })

const refused = (next, why, problems = []) => ({ status: 'refused', next, why, problems })

/**
 * Pure. Why a ruler's brief was never sent, ending on what makes it fit: ruling it again builds the
 * same brief, so what `d.message` names as its remedy comes first.
 */
const tooLarge = (d) => d.message + (d.owner === 'code' ? ': a defect of the brief\'s builder, for self-improve' : '; then it is ruled again')

/** The result: what settling said, and the coverage block. */
function resultOf(ctx, out, { rulerLost = false } = {}) {
  return { ...out, coverage: coverageOf({ log: ctx.log, failed_channels: rulerLost ? ['ruler'] : [], resumable: ctx.resumable }) }
}

/**
 * A spec no longer edited: the approval this run's settle recorded for its text, or what settling
 * says now, which compiles an approval recorded and left uncompiled.
 */
async function settledText(ctx, { effort, folder }) {
  const { hash } = approvalState(ctx.repo, effort, folder)
  const mine = stepped(ctx, (e) => e.key.startsWith('settle:') && e.value && e.value.hash === hash && e.value.status !== 'needs_user').at(-1)
  return mine ? mine.value : step(ctx, 'settle:' + hash, () => respecSettle(ctx.repo, effort, folder))
}

/**
 * Brief the change as it stands, have one ruler rule it and settle; refused rulings go back to the
 * ruler until a refusal repeats; a brief past what the ruler may read is refused `shrink_brief`,
 * naming its part (`tooLarge`). The ruler's thread and every step are keyed by the brief's basis,
 * so a relaunch replays only what was recorded for the text, the answers and the reach that stand.
 */
export async function rule(ctx, { effort, folder }) {
  const brief = respecBrief(ctx.repo, effort, folder)
  if (brief.status !== 'brief') return resultOf(ctx, brief.next === 'nothing' ? await settledText(ctx, { effort, folder }) : brief)
  const prompt = rulerBrief({ ...brief.parts, guidance: guidanceOf(ctx.root, { config: readConfig(ctx.repo) }) })
  const ruler = { role: 'ruler', schema: 'ruler_respec', thread: 'ruler:' + brief.basis, threadBrief: prompt }
  const refusals = []
  let reply = await dispatch(ctx, { ...ruler, brief: prompt })
  if (reply.cause === 'brief_too_large') return resultOf(ctx, refused('shrink_brief', tooLarge(reply)), { rulerLost: true })
  for (let round = 1; ; round++) {
    if (reply.status !== 'returned') return resultOf(ctx, refused('rule_it', 'the ruler returned no rulings: ' + reply.cause + (reply.message ? ': ' + reply.message : '')), { rulerLost: true })
    const { rulings } = reply.output
    const opened = ctx.log.entries().filter((e) => e.kind === 'tool_used' && e.tool === 'Read' && e.thread === ruler.thread).map((e) => e.input.file_path)
    const specs = brief.parts.specs.map((s) => ({ id: s.path, path: s.full, text: s.whole }))
    const unread = rulings.filter((r) => !citationHolds(r.design_read, specs, opened)).map((r) => r.node + ' cites ' + r.design_read)
    if (unread.length) {
      const why = 'a ruling cites a Design part that does not resolve, or of a spec it did not open: ' + unread.join('; ')
      if (refusals.includes(why)) return resultOf(ctx, refused('rule_it', why), { rulerLost: true })
      refusals.push(why)
      reply = await deliver(ctx, { ...ruler, round: round + 1, msg: 'refusals', payload: { of: 'rulings', refusals: [{ claim: 'rulings', problem: why }] } })
      continue
    }
    await step(ctx, 'rulings:' + brief.basis + ':' + round, () => {
      writeJson(brief.rulings, { rulings })
      return brief.rulings
    })
    const settled = await step(ctx, 'settle:' + brief.basis + ':' + round, () => respecSettle(ctx.repo, effort, folder))
    if (settled.status !== 'refused' || settled.next !== 'rule_it') return resultOf(ctx, settled)
    if (refusals.includes(settled.why)) return resultOf(ctx, settled, { rulerLost: true })
    refusals.push(settled.why)
    reply = await deliver(ctx, { ...ruler, round: round + 1, msg: 'refusals', payload: { of: 'rulings', refusals: [{ claim: 'rulings', problem: settled.why }] } })
  }
}
