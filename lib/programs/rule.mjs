// lib/programs/rule.mjs — the rule program: a changed spec briefed inline, ruled by one ruler and
// settled; or, on the user's confirmed word, approved over the ruling they were shown.
//
// Design: docs/DESIGN.md#a-changed-spec.

import { actToken, approvalState } from '../approval.mjs'
import { guidanceOf } from '../brief.mjs'
import { confirmAct } from '../host.mjs'
import { readLog } from '../ledger.mjs'
import { respecBrief, respecSettle } from '../respec.mjs'
import { readConfig, writeJson } from '../store.mjs'
import { coverageOf, deliver, dispatch, step } from './common.mjs'

export const ARGS = {
  effort: { kind: 'effort', required: true },
  folder: { kind: 'folder', required: true },
  user_approved: { kind: 'bool' },
}

export const scopeOf = (args) => ({ effort: args.effort, folder: args.folder })

/** The user's word is read from the starting session or typed at this console, so it never runs detached. */
export const attachedOnly = (args) => args.user_approved === true

const refused = (next, why, problems = []) => ({ status: 'refused', next, why, problems })

/** The result: what settling said, the token the user's answer must carry where they decide, and the coverage block. */
function resultOf(ctx, out, { rulerLost = false } = {}) {
  const asks = out.status === 'needs_user'
    ? { reasons: out.reasons || [], token: actToken({ act: 'approve', folder: out.folder, hash: out.hash, seq: out.ruled }) }
    : {}
  return { ...out, ...asks, coverage: coverageOf({ failed_channels: rulerLost ? ['ruler'] : [], resumable: ctx.resumable }) }
}

/** Brief the change, have one ruler rule it and settle; refused rulings go back to the ruler until a refusal repeats. */
async function ruleIt(ctx, { effort, folder }) {
  const brief = await step(ctx, 'brief', () => respecBrief(ctx.repo, effort, folder, { inline: true }))
  if (brief.status !== 'brief') return resultOf(ctx, brief)
  const prompt = [brief.text, guidanceOf(ctx.root, { config: readConfig(ctx.repo) })].filter(Boolean).join('\n\n')
  const ruler = { role: 'ruler', schema: 'ruler_premises', thread: 'ruler', threadBrief: prompt }
  const refusals = []
  let reply = await dispatch(ctx, { ...ruler, brief: prompt })
  for (let round = 1; ; round++) {
    if (reply.status !== 'returned') return resultOf(ctx, refused('rule_it', 'the ruler returned no rulings: ' + reply.cause), { rulerLost: true })
    const { rulings } = reply.output
    await step(ctx, 'rulings:' + round, () => {
      writeJson(brief.rulings, { rulings })
      return brief.rulings
    })
    const settled = await step(ctx, 'settle:' + round, () => respecSettle(ctx.repo, effort, folder, { checkUserBound: true }))
    if (settled.status !== 'refused' || settled.next !== 'rule_it') return resultOf(ctx, settled)
    if (refusals.includes(settled.why)) return resultOf(ctx, settled, { rulerLost: true })
    refusals.push(settled.why)
    reply = await deliver(ctx, { ...ruler, round: round + 1, msg: 'refusals', payload: { refusals: [{ claim: 'rulings', problem: settled.why }] } })
  }
}

/** Approve the change over the latest ruling of the spec as it stands, once the user's word is confirmed. Dispatches nothing. */
async function approveOver(ctx, { effort, folder }) {
  const { hash } = approvalState(ctx.repo, effort, folder)
  const last = readLog(ctx.repo, effort, 'ledger').entries
    .filter((l) => l.kind === 'ruled' && l.folder === folder && l.hash === hash)
    .reduce((best, l) => (!best || l.seq > best.seq ? l : best), null)
  if (!last) return resultOf(ctx, refused('rule_it', 'the spec of ' + folder + ' as it stands was never ruled: rule it before the user approves'))
  const token = actToken({ act: 'approve', folder, hash, seq: last.seq })
  const word = await step(ctx, 'confirm:' + token, () => confirmAct({ token, option: 'Approve', env: ctx.env, stdinIsTTY: ctx.stdinIsTTY, ask: ctx.ask }))
  if (!word.ok) return resultOf(ctx, { ...refused('ask_user', word.error.message), token })
  const settled = await step(ctx, 'settle', () =>
    respecSettle(ctx.repo, effort, folder, { userApproved: true, checkUserBound: true, by: word.by, over: last.seq }))
  return resultOf(ctx, settled)
}

export async function rule(ctx, args) {
  return args.user_approved ? approveOver(ctx, args) : ruleIt(ctx, args)
}
