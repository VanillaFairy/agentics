// lib/programs/common.mjs — what every program shares when it dispatches: the run's context, the
// one call that replays what returned, resumes what was cut off and waits out host stops within
// max_agents, in the session its thread's owner mints; journaled steps, messages delivered as they
// wait, a nested program's scope, continued searches, the coverage block; and a judge never rules
// on its own work.
//
// Design: docs/DESIGN.md#programs, docs/DESIGN.md#conversations.

import { deliveryPlan, pendingMessages, renderMessage } from '../conversation.mjs'
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
 * takes the user's word at a terminal. In an execution `dir` is the execution's home and
 * `execution` its stamp, which every session is minted from; `prefix` scopes a nested program's
 * threads and steps (`scoped`).
 */
export function programContext({ repo, root = repo, run, effort = '', log, runAgent, now, sleep,
  env = process.env, maxAgents = 6, resumable = null, stdinIsTTY = false, ask = null,
  dir = runDir(repo, run), execution = run, prefix = '' }) {
  return {
    repo, root, run, dir, execution, prefix, effort, log, runAgent, now, sleep, env, resumable, maxAgents, stdinIsTTY, ask,
    slots: slots(maxAgents),
  }
}

/** Pure. A thread name or step key as `ctx`'s scope spells it. */
const inScope = (ctx, name) => (ctx.prefix ? ctx.prefix + '/' + name : name)

/**
 * The same run, its dispatches', deliveries' and steps' thread names and step keys under
 * `<prefix>/`: a nested program's records never collide with its parent's. It shares the parent's
 * log and slots.
 */
export const scoped = (ctx, prefix) => ({ ...ctx, prefix: inScope(ctx, prefix) })

/**
 * A thread's session as the log has it now: minted from the thread's owner (by default the
 * dispatch's node); its generation is how often the thread was renewed.
 */
export function threadOf(ctx, { role, node = '', thread, owner = node }) {
  const key = inScope(ctx, thread)
  const gen = ctx.log.entries().filter((e) => e.kind === 'thread_renewed' && e.thread === key).length
  const ids = { effort: ctx.effort, execution: ctx.execution, node: owner, role, thread: key }
  return { key, gen, session: sessionOf({ ...ids, gen }), nextSession: sessionOf({ ...ids, gen: gen + 1 }) }
}

const CUT_OFF = () => renderMessage({ msg: 'cut_off' })
const SEPARATOR = '\n\n---\n\n'

/** Record a message from code once per node, thread, round and `msg`; its seq. */
function recordOnce(ctx, { node, thread, msg, payload, round }) {
  const held = ctx.log.entries().find((e) => e.kind === 'message' && (e.node || '') === node && e.thread === thread &&
    e.round === round && e.msg === msg)
  return held ? held.seq : ctx.log.append('message', { node, thread, from: 'code', msg, payload, round }).seq
}

/** Pure. The headings whose digest differs between two `{<heading>: <digest>}` maps. */
const changedParts = (before, now) => [...new Set([...Object.keys(before), ...Object.keys(now)])].filter((h) => before[h] !== now[h])

/**
 * One dispatch through the runner: replayed when its return is stored, resumed with the `cut_off`
 * brief (or a waiting `brief_changed`) when it was started and never returned, waited through host
 * stops. The session is minted from `owner`, the key and records from `node`. `fresh` starts the
 * thread's next session; a resumed thread keeps the tier of its latest call. With no `brief` the
 * prompt is composed: the thread brief and every message on the thread for a first or fresh call
 * (`call.freshBrief`), the messages no earlier call carried alone for a resumed one. `briefParts` (the thread brief's section digests)
 * makes a resumed thread whose brief moved receive `brief_changed`. The program reads the stored
 * return, never the runner's word.
 */
export async function dispatch(ctx, {
  role: name, schema, thread: asked, node = '', owner = node, round = 1, brief, threadBrief = brief,
  intelligence = 'normal', base = '', tier, permissions, cwd, carries = [], fresh = '', briefParts = null,
}) {
  const thread = inScope(ctx, asked)
  const key = dispatchKey({ node, role: name, thread, round })
  const sessionNow = () => threadOf(ctx, { role: name, node, owner, thread: asked })
  const loaded = loadRole(name)
  if (!loaded.ok) {
    return { status: 'failed', cause: 'role_unreadable', message: loaded.error.message, dispatch: key, session: sessionNow().session }
  }
  const role = loaded.role
  if (!role.schemas.includes(schema)) throw new Error('the role ' + name + ' returns no ' + JSON.stringify(schema))

  let entries = ctx.log.entries()
  const done = entries.findLast((e) => e.kind === 'returned' && e.dispatch === key && e.status === 'returned')
  const stored = done ? readJson(returnPath(ctx.dir, key)) : null
  if (stored) return { status: 'returned', output: stored, dispatch: key, session: done.session, replayed: true }

  const started = entries.some((e) => e.kind === 'dispatched' && e.dispatch === key)
  const last = entries.findLast((e) => e.kind === 'dispatched' && e.thread === thread)
  // A renewal not yet used by a call (killed between the two) is this call's: it is not made twice.
  const unused = entries.some((e) => e.kind === 'thread_renewed' && e.thread === thread && (!last || e.seq > last.seq))
  if (fresh && !started && !unused) ctx.log.append('thread_renewed', { thread, gen: sessionNow().gen + 1, why: fresh })
  const resume = started || (!fresh && Boolean(last))

  let changed = 0
  if (briefParts && resume && last.brief_digest !== fnv1a(threadBrief)) {
    const payload = { changed: changedParts(last.brief_parts || {}, briefParts), brief: threadBrief }
    changed = recordOnce(ctx, { node, thread, msg: 'brief_changed', payload, round })
  }
  entries = ctx.log.entries()
  const messages = entries.filter((e) => e.kind === 'message' && e.thread === thread).sort((a, b) => a.seq - b.seq)
  const freshBrief = [threadBrief, ...messages.map((m) => renderMessage({ msg: m.msg, payload: m.payload }))].join(SEPARATOR)
  let prompt = brief
  let carried = carries
  if (started) {
    const waiting = changed && pendingMessages(entries, thread).find((m) => m.seq === changed)
    prompt = waiting ? renderMessage(waiting) : CUT_OFF()
    carried = waiting ? [changed] : carries
  } else if (brief === undefined && resume) {
    const plan = deliveryPlan(entries, thread)
    if (plan.action !== 'deliver') throw new Error('nothing to deliver to the thread ' + thread)
    prompt = plan.prompt
    carried = plan.carries
  } else if (brief === undefined) {
    prompt = freshBrief
    carried = messages.map((m) => m.seq)
  }
  let call = {
    dispatch: key, node, round,
    role: { name, tools: role.tools, systemPromptFile: promptFile(role, ctx.dir) },
    cwd: cwd ?? ctx.root,
    brief: prompt,
    freshBrief,
    briefDigest: fnv1a(threadBrief),
    briefParts: briefParts || {},
    tier: resume ? { model: last.model, effort: last.effort } : (tier ?? tierFor(role, { intelligence, base })),
    permissions: permissions ?? readOnlyPermissions(role),
    schema: schemaOf(schema), carries: carried, dir: ctx.dir, resume,
  }
  for (let attempt = 0; ; attempt++) {
    await ctx.slots.take()
    let out
    try {
      out = await ctx.runAgent({ ...call, thread: sessionNow() })
    } finally {
      ctx.slots.give()
    }
    if (out.status === 'stopped') {
      await ctx.sleep(waitFor({ until: out.until, attempt, now: ctx.now() }))
      call = { ...call, resume: true, brief: CUT_OFF() }
      continue
    }
    if (out.status !== 'returned') return { status: 'failed', cause: out.cause || out.status, message: out.message || '', dispatch: key, session: out.session }
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
  const scopedKey = inScope(ctx, key)
  const done = ctx.log.entries().find((e) => e.kind === 'step' && e.key === scopedKey)
  if (done) return done.value
  const value = await fn()
  ctx.log.append('step', { key: scopedKey, value })
  return value
}

/** The `step` records of `ctx`'s scope that `match` accepts, oldest first, each keyed as the scope named it. */
export function stepped(ctx, match) {
  const head = ctx.prefix ? ctx.prefix + '/' : ''
  return ctx.log.entries().filter((e) => e.kind === 'step' && e.key.startsWith(head))
    .map((e) => ({ ...e, key: e.key.slice(head.length) })).filter(match)
}

/**
 * Record a message from code to a thread, once per node, thread, round and `msg`, then dispatch the
 * round with no brief: it delivers every message waiting on the thread.
 */
export async function deliver(ctx, { thread, msg, payload = {}, round, node = '', brief, carries, ...spec }) {
  recordOnce(ctx, { node, thread: inScope(ctx, thread), msg, payload, round })
  return dispatch(ctx, { ...spec, node, thread, round })
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
