// lib/programs/rule.mjs — the rule program: a changed spec briefed inline, ruled by one ruler and
// settled; or, on the user's confirmed word, approved over the ruling they were shown.
//
// Design: docs/DESIGN.md#a-changed-spec.

import { actToken, approvalState } from '../approval.mjs'
import { guidanceOf } from '../brief.mjs'
import { confirmAct } from '../host.mjs'
import { readLog } from '../ledger.mjs'
import { respecBrief, respecRefusal, respecSettle } from '../respec.mjs'
import { readConfig, writeJson } from '../store.mjs'
import { coverageOf, deliver, dispatch, step, stepped } from './common.mjs'

export const ARGS = {
  effort: { kind: 'effort', required: true },
  folder: { kind: 'folder', required: true },
  user_approved: { kind: 'bool' },
}

export const scopeOf = (args) => ({ effort: args.effort, folder: args.folder })

/** The user's word is read from the starting session or typed at this console, so it never runs detached. */
export const attachedOnly = (args) => args.user_approved === true

const refused = (next, why, problems = []) => ({ status: 'refused', next, why, problems })

/** This run's latest `step` record that `match` accepts, in the context's scope. */
const journaled = (ctx, match) => stepped(ctx, match).at(-1)

/** The result: what settling said, the token the user's answer must carry where they decide, and the coverage block. */
function resultOf(ctx, out, { rulerLost = false } = {}) {
  const asks = out.status === 'needs_user'
    ? { reasons: out.reasons || [], token: actToken({ act: 'approve', folder: out.folder, hash: out.hash, seq: out.ruled }) }
    : {}
  return { ...out, ...asks, coverage: coverageOf({ failed_channels: rulerLost ? ['ruler'] : [], resumable: ctx.resumable }) }
}

/**
 * A spec no longer edited: the approval this run's settle recorded for its text, or what settling
 * says now, which compiles an approval recorded and left uncompiled.
 */
async function settledText(ctx, { effort, folder }) {
  const { hash } = approvalState(ctx.repo, effort, folder)
  const mine = journaled(ctx, (e) => e.key.startsWith('settle:') && e.value && e.value.hash === hash && e.value.status !== 'needs_user')
  return mine ? mine.value : step(ctx, 'settle:' + hash, () => respecSettle(ctx.repo, effort, folder, { checkUserBound: true }))
}

/**
 * Brief the change as it stands, have one ruler rule it and settle; refused rulings go back to the
 * ruler until a refusal repeats. The ruler's thread and every step are keyed by the brief's basis,
 * so a relaunch replays only what was recorded for the text and reach that stand.
 */
async function ruleIt(ctx, { effort, folder }) {
  const brief = respecBrief(ctx.repo, effort, folder, { inline: true })
  if (brief.status !== 'brief') return resultOf(ctx, brief.next === 'nothing' ? await settledText(ctx, { effort, folder }) : brief)
  const prompt = [brief.text, guidanceOf(ctx.root, { config: readConfig(ctx.repo) })].filter(Boolean).join('\n\n')
  const ruler = { role: 'ruler', schema: 'ruler_premises', thread: 'ruler:' + brief.basis, threadBrief: prompt }
  const refusals = []
  let reply = await dispatch(ctx, { ...ruler, brief: prompt })
  for (let round = 1; ; round++) {
    if (reply.status !== 'returned') return resultOf(ctx, refused('rule_it', 'the ruler returned no rulings: ' + reply.cause), { rulerLost: true })
    const { rulings } = reply.output
    await step(ctx, 'rulings:' + brief.basis + ':' + round, () => {
      writeJson(brief.rulings, { rulings })
      return brief.rulings
    })
    const settled = await step(ctx, 'settle:' + brief.basis + ':' + round, () => respecSettle(ctx.repo, effort, folder, { checkUserBound: true }))
    if (settled.status !== 'refused' || settled.next !== 'rule_it') return resultOf(ctx, settled)
    if (refusals.includes(settled.why)) return resultOf(ctx, settled, { rulerLost: true })
    refusals.push(settled.why)
    reply = await deliver(ctx, { ...ruler, round: round + 1, msg: 'refusals', payload: { of: 'rulings', refusals: [{ claim: 'rulings', problem: settled.why }] } })
  }
}

/**
 * Approve the change over the latest ruling of the spec as it stands, once the user's word is
 * confirmed. A ruling that can no longer settle is refused before the user is asked; the settle is
 * keyed by the token confirmed. Dispatches nothing.
 */
async function approveOver(ctx, { effort, folder }) {
  const { hash } = approvalState(ctx.repo, effort, folder)
  const last = readLog(ctx.repo, effort, 'ledger').entries
    .filter((l) => l.kind === 'ruled' && l.folder === folder && l.hash === hash)
    .reduce((best, l) => (!best || l.seq > best.seq ? l : best), null)
  if (!last) return resultOf(ctx, refused('rule_it', 'the spec of ' + folder + ' as it stands was never ruled: rule it before the user approves'))
  const token = actToken({ act: 'approve', folder, hash, seq: last.seq })
  // A word already asked for stands; settling checks the ruling again.
  if (!journaled(ctx, (e) => e.key === 'confirm:' + token)) {
    const refusal = respecRefusal(ctx.repo, effort, folder, last.seq)
    if (refusal) return resultOf(ctx, refusal)
  }
  const word = await step(ctx, 'confirm:' + token, () => confirmAct({ token, option: 'Approve', env: ctx.env, stdinIsTTY: ctx.stdinIsTTY, ask: ctx.ask }))
  if (!word.ok) return resultOf(ctx, { ...refused('ask_user', word.error.message), token })
  const settled = await step(ctx, 'settle:' + token, () =>
    respecSettle(ctx.repo, effort, folder, { userApproved: true, checkUserBound: true, by: word.by, over: last.seq }))
  return resultOf(ctx, settled)
}

export async function rule(ctx, args) {
  return args.user_approved ? approveOver(ctx, args) : ruleIt(ctx, args)
}
