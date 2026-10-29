// lib/programs/common.mjs — what every program shares when it dispatches: the run's context, the
// one call that replays what returned, resumes what was cut off and waits out host stops within
// max_agents, in the session its thread's owner mints; journaled steps, messages delivered as they
// wait, a nested program's scope, the coverage block; and a judge never rules
// on its own work.
//
// Design: docs/DESIGN.md#programs, docs/DESIGN.md#conversations.

import { join } from 'node:path'

import { fitParts, joined, sectionsOf } from '../briefs/fit.mjs'
import { deliveryPlan, pendingMessages, renderMessage, threadMessages } from '../conversation.mjs'
import { readOnlyPermissions } from '../permissions.mjs'
import { fnv1a } from '../plan-digest.mjs'
import { BRIEF_BYTES, loadRole, promptFile, tierFor } from '../roles.mjs'
import { promptDigestOf } from '../runner.mjs'
import { schemaOf } from '../schemas.mjs'
import { dispatchKey, posix, readJson, returnPath, runDir, sessionOf, writeWhole } from '../store.mjs'

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
 * threads and steps (`scoped`). `closed` lists the calls an earlier run left open that this run's
 * start closed (`closeLeftOpen` in lib/runner.mjs).
 */
export function programContext({ repo, root = repo, run, effort = '', log, runAgent, now, sleep,
  env = process.env, maxAgents = 6, resumable = null, stdinIsTTY = false, ask = null,
  dir = runDir(repo, run), execution = run, prefix = '', intelligence, closed = [] }) {
  return {
    intelligence, repo, root, run, dir, execution, prefix, effort, log, runAgent, now, sleep, env, resumable, maxAgents, stdinIsTTY, ask, closed,
    slots: slots(maxAgents),
  }
}

/** Pure. A thread name or step key as `ctx`'s scope spells it. */
const inScope = (ctx, name) => (ctx.prefix ? ctx.prefix + '/' + name : name)

/**
 * The same run, its dispatches', deliveries' and steps' thread names and step keys under
 * `<prefix>/`: a nested program's records never collide with its parent's. It shares the parent's
 * log and slots; `dial.intelligence`, when given, is the nested program's dial.
 */
export const scoped = (ctx, prefix, dial = {}) => dialed({ ...ctx, prefix: inScope(ctx, prefix) }, dial)

/**
 * Pure. `ctx` at the dial a program was entered with: its own `intelligence` arg when one was passed
 * in-process, else the context's. Every dispatch and search of the program reads `ctx.intelligence`.
 */
export const dialed = (ctx, { intelligence } = {}) => (intelligence ? { ...ctx, intelligence } : ctx)

/**
 * A thread's session as the log has it now: minted from the thread's owner (by default the
 * dispatch's node); its generation is how often the thread was renewed. `sessionAt(gen)` names the
 * session of any generation, for a runner that renews the thread more than once in a call.
 */
export function threadOf(ctx, { role, node = '', thread, owner = node }) {
  const key = inScope(ctx, thread)
  const gen = ctx.log.entries().filter((e) => e.kind === 'thread_renewed' && e.thread === key).length
  const ids = { effort: ctx.effort, execution: ctx.execution, node: owner, role, thread: key }
  const sessionAt = (at) => sessionOf({ ...ids, gen: at })
  return { key, gen, session: sessionAt(gen), nextSession: sessionAt(gen + 1), sessionAt }
}

const CUT_OFF = () => renderMessage({ msg: 'cut_off' })
const SEPARATOR = '\n\n---\n\n'
/** A brief sent after the `cut_off` message: the thread was cut off in the middle of it. */
const afterCutOff = (text) => [CUT_OFF(), text].join(SEPARATOR)

/** Pure. Why a thread's next call starts a new session: its last call ran under another prompt, else another cwd. An entry written before they were recorded is no change. */
const changeSince = (last, { system, cwd }) => {
  if (last.prompt !== undefined && last.prompt !== system) return 'prompt_changed'
  return last.cwd !== undefined && last.cwd !== cwd ? 'cwd_changed' : ''
}

/** Record a message from code once per node, thread, round and `msg`; its seq. */
function recordOnce(ctx, { node, thread, msg, payload, round }) {
  const held = ctx.log.entries().find((e) => e.kind === 'message' && (e.node || '') === node && e.thread === thread &&
    e.round === round && e.msg === msg)
  return held ? held.seq : ctx.log.append('message', { node, thread, from: 'code', msg, payload, round }).seq
}

/** Pure. A brief as text: a plain one as it is, a shaped one (`{parts}`, lib/briefs/fit.mjs) joined. */
const textOf = (b) => (b && typeof b === 'object' ? joined(b.parts) : b)

/** Pure. A brief's parts: a shaped one's own, a plain one's sections. */
const partsOf = (b) => (b && typeof b === 'object' ? b.parts : sectionsOf(String(b ?? '')))

/**
 * Pure. A thread's message as a part of a fresh prompt, led by its separator. A message no returned
 * call carried is what the call is for, so it stays inline; one a returned call answered may go as a
 * file, before any part of the brief.
 */
function messagePart(m, live) {
  const key = 'message ' + m.seq + ' ' + m.msg
  const text = '---\n\n' + renderMessage({ msg: m.msg, payload: m.payload })
  if (live) return { key, text }
  return { key, rank: -1, text, ref: (path) => '---\n\nAn earlier message on this thread (' + m.msg + '), answered already, is the file ' + path + '.' }
}

/** Pure. The seqs of `messages` that no call which returned carried. */
function liveSeqs(entries, messages) {
  const returned = new Set(entries.filter((e) => e.kind === 'returned').map((e) => e.dispatch))
  const answered = new Set(entries.filter((e) => e.kind === 'dispatched' && returned.has(e.dispatch)).flatMap((e) => e.carries || []))
  return new Set(messages.map((m) => m.seq).filter((seq) => !answered.has(seq)))
}

/**
 * The prompt a fresh call of a role that carries Read is sent: fitted to the room the role leaves
 * (`briefRoomOf`), every part but the charge past it written under the run's `briefs/` and handed
 * as the file to open (`fitParts`). A role without Read is sent the prompt as it is.
 */
function fitterFor(ctx, role, charge) {
  if (!role.tools.includes('Read')) return (text) => ({ text, handed: [] })
  const room = briefRoomOf(role.name, { charge })
  const write = (key, text) => {
    const file = join(ctx.dir, 'briefs', (String(key).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'part') + '-' + fnv1a(text) + '.md')
    writeWhole(file, text)
    return posix(file)
  }
  return (text, parts) => {
    const out = fitParts(parts, room, write)
    return out.handed.length ? out : { text, handed: [] }
  }
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
 * return, never the runner's word. `charge` is written after the role's body as the system prompt;
 * `mcpConfig` names the tool server the host starts for the call. `brief` and `threadBrief` are text
 * or shaped (`{parts}`); a fresh call's prompt is fitted to what its role can read (`fitterFor`), and
 * the result's `handed` names what went as files. A search thread
 * passes `renewOnChange`: when the thread's last call ran under another system prompt or cwd, this
 * call starts the thread's next session, even over a started call, which then gets `cut_off` and
 * its brief; a resumed started call and a host stop get `cut_off` alone. `briefNow` builds the brief a renewed session gets, `budgetNow`
 * the dollars left at each start; `mcpConfig` may be a function of the session. `denyRead`, the
 * paths `permissions` deny reading, goes on the call's `dispatched` line.
 */
export async function dispatch(ctx, {
  role: name, schema, thread: asked, node = '', owner = node, round = 1, brief: shapedBrief, threadBrief: shapedThread = shapedBrief,
  intelligence = ctx.intelligence, base = '', tier, permissions, denyRead = [], cwd, carries = [], fresh = '', briefParts = null,
  charge = '', mcpConfig = '', renewOnChange = false, briefNow = null, budgetNow = null,
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
  const brief = textOf(shapedBrief)
  const threadBrief = textOf(shapedThread)

  let entries = ctx.log.entries()
  const done = entries.findLast((e) => e.kind === 'returned' && e.dispatch === key && e.status === 'returned')
  const stored = done ? readJson(returnPath(ctx.dir, key)) : null
  if (stored) return { status: 'returned', output: stored, dispatch: key, session: done.session, replayed: true }

  const started = entries.some((e) => e.kind === 'dispatched' && e.dispatch === key)
  const last = entries.findLast((e) => e.kind === 'dispatched' && e.thread === thread)
  // A renewal not yet used by a call (killed between the two) is this call's: it is not made twice.
  const unused = entries.some((e) => e.kind === 'thread_renewed' && e.thread === thread && (!last || e.seq > last.seq))
  const systemPromptFile = promptFile(role, ctx.dir, charge)
  const cwdNow = cwd ?? ctx.root
  const changed = renewOnChange && last ? changeSince(last, { system: promptDigestOf(systemPromptFile), cwd: cwdNow }) : ''
  const why = (fresh && !started ? fresh : '') || changed
  if (why && !unused) ctx.log.append('thread_renewed', { thread, gen: sessionNow().gen + 1, why })
  const resume = !why && (started || Boolean(last))

  let briefChanged = 0
  if (briefParts && resume && last.brief_digest !== fnv1a(threadBrief)) {
    const payload = { changed: changedParts(last.brief_parts || {}, briefParts), brief: threadBrief }
    briefChanged = recordOnce(ctx, { node, thread, msg: 'brief_changed', payload, round })
  }
  entries = ctx.log.entries()
  const messages = threadMessages(entries, thread)
  const freshBrief = [threadBrief, ...messages.map((m) => renderMessage({ msg: m.msg, payload: m.payload }))].join(SEPARATOR)
  const live = liveSeqs(entries, messages)
  const freshParts = [...partsOf(shapedThread), ...messages.map((m) => messagePart(m, live.has(m.seq)))]
  let prompt = brief
  let carried = carries
  if (started && why) {
    prompt = afterCutOff(brief ?? freshBrief)
    carried = brief === undefined ? messages.map((m) => m.seq) : carries
  } else if (started) {
    const waiting = briefChanged && pendingMessages(entries, thread).find((m) => m.seq === briefChanged)
    prompt = waiting ? renderMessage(waiting) : CUT_OFF()
    carried = waiting ? [briefChanged] : carries
  } else if (brief === undefined && resume) {
    const plan = deliveryPlan(entries, thread)
    if (plan.action !== 'deliver') throw new Error('nothing to deliver to the thread ' + thread)
    prompt = plan.prompt
    carried = plan.carries
  } else if (brief === undefined) {
    prompt = freshBrief
    carried = messages.map((m) => m.seq)
  }
  const fit = fitterFor(ctx, role, charge)
  const own = brief === undefined ? freshParts : partsOf(shapedBrief)
  const sent = resume ? { text: prompt, handed: [] } : fit(prompt, started && why ? [{ key: 'cut_off', text: CUT_OFF() + '\n\n---' }, ...own] : own)
  let call = {
    dispatch: key, node, round,
    role: { name, tools: role.tools, systemPromptFile },
    cwd: cwdNow,
    mcpConfig,
    brief: sent.text,
    freshBrief: fit(freshBrief, freshParts).text, briefNow: briefNow && (() => { const b = briefNow(); return fit(textOf(b), partsOf(b)).text }), budgetNow,
    briefDigest: fnv1a(threadBrief),
    briefParts: briefParts || {},
    tier: resume ? { model: last.model, effort: last.effort } : (tier ?? tierFor(role, { intelligence, base })),
    permissions: permissions ?? readOnlyPermissions(role), denyRead,
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
    const handed = sent.handed.map((h) => h.key)
    if (out.status !== 'returned') return { status: 'failed', cause: out.cause || out.status, message: out.message || '', dispatch: key, session: out.session, handed }
    const output = readJson(returnPath(ctx.dir, key))
    if (!output) return { status: 'failed', cause: 'return_unreadable', message: 'no stored return for ' + key, dispatch: key, session: out.session, handed }
    return { status: 'returned', output, dispatch: key, session: out.session, replayed: false, handed }
  }
}

/**
 * The bytes a fresh call of role `name` may be briefed with: what a first read may hold, less the
 * role's system prompt (with `charge` after it). A brief past it is refused before it is sent
 * (`brief_too_large`), so a program that can trim one fits it to this.
 */
export function briefRoomOf(name, { charge = '' } = {}) {
  const loaded = loadRole(name)
  if (!loaded.ok) return BRIEF_BYTES
  return BRIEF_BYTES - Buffer.byteLength(charge ? loaded.role.prompt + '\n\n' + charge : loaded.role.prompt, 'utf8')
}

/**
 * A side effect, journaled: a `step` record with this key gives its value without calling `fn`.
 * A run cut off between `fn` and its record calls `fn` again, so `fn` must be safe to repeat.
 * With `ctx.replayAfter` (a seq) only a record newer than it is replayed: what a unit journaled
 * before it began is another unit's answer. A value past `STEP_INLINE_BYTES` is kept in a file of
 * the run's home the record names (`value_file`), so the log every read parses stays small; a
 * record whose file is gone is no answer, and `fn` runs again.
 */
export async function step(ctx, key, fn) {
  const scopedKey = inScope(ctx, key)
  const after = ctx.replayAfter || 0
  for (const done of ctx.log.entries().filter((e) => e.kind === 'step' && e.key === scopedKey && (!after || e.seq > after))) {
    if (!done.value_file) return done.value
    const kept = readJson(join(ctx.dir, done.value_file))
    if (kept && Object.hasOwn(kept, 'value')) return kept.value
  }
  const value = await fn()
  const text = JSON.stringify(value === undefined ? null : value)
  if (text.length <= STEP_INLINE_BYTES || !ctx.dir) {
    ctx.log.append('step', { key: scopedKey, value })
    return value
  }
  const file = 'steps/' + fnv1a(scopedKey) + '-' + fnv1a(text) + '.json'
  writeWhole(join(ctx.dir, file), { key: scopedKey, value })
  ctx.log.append('step', { key: scopedKey, value_file: file, bytes: text.length })
  return value
}

/** A step value larger than this is written to a file of its own, not into the run's log. */
const STEP_INLINE_BYTES = 16384

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
