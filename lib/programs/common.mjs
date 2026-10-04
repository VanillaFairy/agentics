// lib/programs/common.mjs — what every program shares when it dispatches: the run's context, the
// one call that replays what returned, resumes what was cut off and waits out host stops within
// max_agents; journaled steps, delivered messages, continued searches, the coverage block; and a
// judge never rules on its own work.
//
// Design: docs/DESIGN.md#programs.

import { renderMessage } from '../conversation.mjs'
import { roundOf } from '../evidence.mjs'
import { readOnlyPermissions } from '../locus.mjs'
import { fnv1a } from '../plan-digest.mjs'
import { loadRole, promptFile, tierFor } from '../roles.mjs'
import { schemaOf } from '../schemas.mjs'
import { dispatchKey, readJson, returnPath, runDir, sessionOf } from '../store.mjs'

/** `n` slots; a taker waits, first come first served, until one is given back. */
function slots(n) {
  let free = n
  const waiting = []
  return {
    take: () => (free > 0 ? (free--, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve))),
    give: () => {
      const next = waiting.shift()
      if (next) next()
      else free++
    },
  }
}

/**
 * A run's context. `log` is the run's log port, `runAgent(call)` the runner, `now()` the clock as
 * an ISO string, `sleep(ms)` a promise; `stdinIsTTY` and `ask` reach confirmAct for a program that
 * takes the user's word at a terminal.
 */
export function programContext({ repo, root = repo, run, effort = '', log, runAgent, now, sleep,
  env = process.env, maxAgents = 6, resumable = null, stdinIsTTY = false, ask = null }) {
  return {
    repo, root, run, dir: runDir(repo, run), effort, log, runAgent, now, sleep, env, resumable, maxAgents, stdinIsTTY, ask,
    slots: slots(maxAgents),
  }
}

/** A thread's session as the log has it now: its generation is how often the runner renewed it. */
function threadOf(ctx, { role, node, thread }) {
  const gen = ctx.log.entries().filter((e) => e.kind === 'thread_renewed' && e.thread === thread).length
  const ids = { effort: ctx.effort, execution: ctx.run, node, role, thread }
  return { key: thread, gen, session: sessionOf({ ...ids, gen }), nextSession: sessionOf({ ...ids, gen: gen + 1 }) }
}

const CUT_OFF = () => renderMessage({ msg: 'cut_off' })

/**
 * One dispatch through the runner: replayed when its return is stored, resumed with the `cut_off`
 * brief when it was started and never returned, waited through host stops. The program reads the
 * stored return, never the runner's word.
 */
export async function dispatch(ctx, {
  role: name, schema, thread, node = '', round = 1, brief, threadBrief = brief,
  intelligence = 'normal', base = '', tier, permissions, cwd, carries = [],
}) {
  const key = dispatchKey({ node, role: name, thread, round })
  const loaded = loadRole(name)
  if (!loaded.ok) {
    return { status: 'failed', cause: 'role_unreadable', message: loaded.error.message, dispatch: key, session: threadOf(ctx, { role: name, node, thread }).session }
  }
  const role = loaded.role
  if (!role.schemas.includes(schema)) throw new Error('the role ' + name + ' returns no ' + JSON.stringify(schema))

  const entries = ctx.log.entries()
  const done = entries.findLast((e) => e.kind === 'returned' && e.dispatch === key && e.status === 'returned')
  const stored = done ? readJson(returnPath(ctx.dir, key)) : null
  if (stored) return { status: 'returned', output: stored, dispatch: key, session: done.session, replayed: true }

  const started = entries.some((e) => e.kind === 'dispatched' && e.dispatch === key)
  const messages = entries.filter((e) => e.kind === 'message' && e.thread === thread).sort((a, b) => a.seq - b.seq)
  let call = {
    dispatch: key, node, round,
    role: { name, tools: role.tools, systemPromptFile: promptFile(role, ctx.dir) },
    cwd: cwd ?? ctx.root,
    brief: started ? CUT_OFF() : brief,
    freshBrief: [threadBrief, ...messages.map((m) => renderMessage({ msg: m.msg, payload: m.payload }))].join('\n\n---\n\n'),
    briefDigest: fnv1a(threadBrief),
    tier: tier ?? tierFor(role, { intelligence, base }),
    permissions: permissions ?? readOnlyPermissions(role),
    schema: schemaOf(schema), carries, dir: ctx.dir,
    resume: started || entries.some((e) => e.kind === 'dispatched' && e.thread === thread),
  }
  for (let attempt = 0; ; attempt++) {
    await ctx.slots.take()
    let out
    try {
      out = await ctx.runAgent({ ...call, thread: threadOf(ctx, { role: name, node, thread }) })
    } finally {
      ctx.slots.give()
    }
    if (out.status === 'stopped') {
      await ctx.sleep(waitFor({ until: out.until, attempt, now: ctx.now() }))
      call = { ...call, resume: true, brief: CUT_OFF() }
      continue
    }
    if (out.status !== 'returned') return { status: 'failed', cause: out.cause, message: out.message || '', dispatch: key, session: out.session }
    const output = readJson(returnPath(ctx.dir, key))
    if (!output) return { status: 'failed', cause: 'return_unreadable', message: 'no stored return for ' + key, dispatch: key, session: out.session }
    return { status: 'returned', output, dispatch: key, session: out.session, replayed: false }
  }
}

/**
 * A side effect, journaled: a `step` record with this key gives its value without calling `fn`.
 * A run cut off between `fn` and its record calls `fn` again, so `fn` must be safe to repeat.
 */
export async function step(ctx, key, fn) {
  const done = ctx.log.entries().find((e) => e.kind === 'step' && e.key === key)
  if (done) return done.value
  const value = await fn()
  ctx.log.append('step', { key, value })
  return value
}

/** Record a message from code to a thread, once per thread and round, then dispatch the round that carries it. */
export async function deliver(ctx, { thread, msg, payload = {}, round, ...spec }) {
  const held = ctx.log.entries().find((e) => e.kind === 'message' && e.thread === thread && e.round === round)
  const seq = held ? held.seq : ctx.log.append('message', { thread, from: 'code', msg, payload, round }).seq
  return dispatch(ctx, { ...spec, thread, round, brief: renderMessage({ msg, payload }), carries: [seq] })
}

/** A searcher's rounds on one thread, continued while `roundOf` reads `continue` (docs/DESIGN.md#continued-searches). */
export async function searchRounds(ctx, spec) {
  const threadBrief = spec.threadBrief ?? spec.brief
  const rounds = []
  let reading = { entries_n: 0, kinds: {} }
  let last = await dispatch(ctx, { ...spec, threadBrief, round: 1 })
  const end = (outcome, why = '', cause = '') => ({ outcome, why, cause, rounds, last, entries_n: reading.entries_n, kinds: reading.kinds })
  for (;;) {
    if (last.status !== 'returned') return end('failed', '', last.cause)
    reading = roundOf(last.output, rounds.map((r) => r.output))
    rounds.push(last)
    if (reading.next === 'done') return end('done')
    if (reading.next === 'stop') return end('stop', reading.why)
    const notReached = typeof last.output.not_reached === 'string' ? last.output.not_reached : ''
    last = await deliver(ctx, { ...spec, threadBrief, round: rounds.length + 1, msg: 'continue_search', payload: { not_reached: notReached } })
  }
}

/** Pure. A program's coverage block (docs/DESIGN.md#coverage-block). */
export function coverageOf({ declared = [], dropped = [], incomplete = [], failed_channels = [], unreached = [], resumable = null, also = true } = {}) {
  const complete = also && [dropped, incomplete, failed_channels, unreached].every((list) => list.length === 0)
  return { complete, declared, dropped, incomplete, failed_channels, unreached, resumable }
}

/** Pure. How long to wait after a host stop before resuming: past the host's `until` when it gave one, else backing off. */
export function waitFor({ until = '', attempt = 0, now }) {
  const at = Date.parse(until)
  if (Number.isFinite(at)) return Math.max(at - new Date(now).getTime() + 60000, 60000)
  return Math.min(60000 * 2 ** attempt, 1800000)
}

const producersOf = (producer) => (Array.isArray(producer) ? producer : [producer])

/** Pure. A judge never rules on what its own session or thread produced, for any of the producers. */
export const judgeAllowed = ({ producer, judge }) =>
  producersOf(producer).every((p) => judge.session !== p.session && judge.thread !== p.thread)

/** Refuse a judge dispatch on its own work, else run it. */
export async function dispatchJudge({ producer, judge, run }) {
  if (!judgeAllowed({ producer, judge })) {
    return { status: 'failed', error: { kind: 'self_judging', message: 'a judge may not rule on the work of ' + producersOf(producer).map((p) => p.thread).join(', ') } }
  }
  return run()
}
