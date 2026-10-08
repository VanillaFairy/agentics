// test/fast/harness/workflow-host.mjs — executes a *.workflow.js the way the runtime does:
// strip the meta export, compile the body as an async function whose parameters are the
// runtime globals, and inject scripted fakes. This is what makes the orchestration
// arithmetic — coverage derivation, escalation routing, checkpoint gating — executable
// in a test, which no linter can do. Lint judges form; this harness judges behaviour.
//
// Fake semantics mirror the documented runtime:
//   pipeline(items, ...stages) — per item, stages run in order, each receiving
//     (prevResult, originalItem, index); a stage that throws drops the item to null and
//     skips its remaining stages. Items run sequentially here — the runtime's
//     no-barrier concurrency is a wall-clock property, not an observable result property.
//   parallel(thunks) — all thunks run; a rejection resolves that slot to null; the call
//     itself never rejects.
//   agent / workflow — delegate to the handlers the scenario supplies. A scenario that
//     supplies none fails loudly on first use rather than returning undefined.
//   budget — no target: remaining() is Infinity, matching a run with no token directive.

import { readFileSync } from 'node:fs'

import { roundOf } from '../../../lib/evidence.mjs'
import { canonical, fnv1a } from '../../../lib/plan-digest.mjs'

const AsyncFunction = (async function () {}).constructor

/** Compile a workflow script. Throws on a syntax error — usable as a parse gate alone. */
export function compileWorkflow(path) {
  const src = readFileSync(path, 'utf8').replace(/^export\s+const\s+meta/m, 'const meta')
  return new AsyncFunction(
    'agent', 'pipeline', 'parallel', 'log', 'phase', 'args', 'budget', 'workflow', src)
}

/**
 * Run a workflow with scripted fakes.
 * @param {string} path      the *.workflow.js file
 * @param {object} scenario  { args, agent(prompt, opts), workflow(name, args) }
 * @returns {Promise<{ result, logs: string[], phases: string[],
 *                     prompts: Array<{prompt: string, opts: object}> }>}
 */
export async function runWorkflow(path, opts = {}) {
  const { args, agent, workflow } = opts
  const logs = []
  const phases = []
  const prompts = []

  const agentFake = async (prompt, opts = {}) => {
    prompts.push({ prompt, opts })
    if (!agent) throw new Error('scenario provided no agent handler, but agent() was called')
    return agent(prompt, opts)
  }

  const workflowFake = async (name, wargs) => {
    if (!workflow) throw new Error('scenario provided no workflow handler, but workflow() was called')
    return workflow(name, wargs)
  }

  const pipelineFake = async (items, ...stages) => {
    const out = []
    for (let i = 0; i < items.length; i++) {
      let value = items[i]
      try {
        for (const stage of stages) value = await stage(value, items[i], i)
        out.push(value)
      } catch {
        out.push(null)
      }
    }
    return out
  }

  const parallelFake = (thunks) =>
    Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))

  // No target by default — remaining() is Infinity, matching a run with no token directive,
  // and every budget-aware branch stays dark. A scenario that wants one passes `budget:
  // { total, perDispatch }`: `spent` then grows by `perDispatch` for every agent dispatched,
  // which is what lets a test drive a workflow's own projection with real arithmetic instead
  // of a stubbed number.
  const budget = opts.budget
    ? {
        total: opts.budget.total,
        spent: () => prompts.length * (opts.budget.perDispatch || 0),
        remaining: () => Math.max(0, opts.budget.total - prompts.length * (opts.budget.perDispatch || 0)),
      }
    : { total: null, spent: () => 0, remaining: () => Infinity }

  const result = await compileWorkflow(path)(
    agentFake, pipelineFake, parallelFake,
    (m) => logs.push(String(m)), (t) => phases.push(String(t)),
    args, budget, workflowFake,
  )

  return { result, logs, phases, prompts }
}

/**
 * What a scripted agent wrote to its return file when that differs from what it returned: an
 * answer carrying `[WROTE]: {...}` returns itself and leaves that object in its file. Without it,
 * the answer is both.
 */
export const WROTE = Symbol('wrote')

/**
 * An agent handler routed by `opts.label`. `script` maps a label (exact, or a prefix
 * ending in ':') to a value, or to a function (prompt, opts, callIndex) — callIndex
 * counts calls PER LABEL, so a re-verified order can answer differently per round.
 * An unscripted label throws, so a scenario cannot silently feed undefined downstream.
 *
 * Every answer to a dispatch that names a return file is kept as that file's content, and an
 * unscripted `round:` courier answers as `lib/evidence.mjs round` does, over those files.
 */
export function scriptedAgents(script) {
  const counts = new Map()
  const files = new Map()
  const keep = (prompt, out) => {
    const file = returnFileOf(prompt)
    if (file && out && typeof out === 'object') files.set(file, out[WROTE] || out)
    return out
  }
  const round = (prompt) => {
    const command = courierCommand(prompt)
    const read = (f) => (files.has(f) ? files.get(f) : null)
    return carriedEnvelope(roundOf(read(flagValues(command, 'from')[0]), flagValues(command, 'earlier').map(read)))
  }
  const answer = scriptedAnswers(script, counts, round)
  return (prompt, opts) => {
    const out = answer(prompt, opts)
    return out && typeof out.then === 'function' ? out.then((v) => keep(prompt, v)) : keep(prompt, out)
  }
}

function scriptedAnswers(script, counts, round) {
  return (prompt, opts) => {
    const label = opts.label || ''
    const n = counts.get(label) || 0
    counts.set(label, n + 1)
    // An exact label beats a prefix, and a longer prefix beats a shorter one, whatever order the
    // script's keys were spread in: a scenario overriding `verify:R1` on top of a base `verify:`
    // must get its override.
    const key = Object.keys(script)
      .filter((k) => label === k || (k.endsWith(':') && label.startsWith(k)))
      .sort((a, b) => (b === label) - (a === label) || b.length - a.length)[0]
    if (key === undefined && label.startsWith('round:')) return round(prompt)
    if (key === undefined) throw new Error('unscripted agent call: ' + (label || '(no label)'))
    const value = script[key]
    return typeof value === 'function' ? value(prompt, opts, n) : value
  }
}

/** Every field lib/verify.mjs prints, in the state it prints them in when nothing was observed. */
const BLANK_MEASUREMENT = {
  stop_reason: 'completed', build: 'absent', typecheck: 'absent', suite: 'not_run', suite_scope: 'none',
  suite_output_tail: '', failing_tests: [], baseline_failing: [], discriminator: [], mutations: [],
  series_findings: [], checks: [], notes: '',
  error: null, journal: null,
}

/**
 * A verify dispatch's answer: lib/verify.mjs's stdout, carried by a courier.
 *
 * A scenario writes the MEASUREMENT it wants — `{ build: 'failed' }` — and this wraps it the way
 * the real trip does: every field filled in, the digest taken over the whole payload, the
 * envelope serialized into `payload_raw`. The workflow recomputes that digest before believing a
 * field of it, so `damage` (applied after the digest, exactly as the resume fixture does) is how
 * a scenario exercises the transport ladder.
 *
 * @param {object} measurement  the fields this scenario cares about
 * @param {(envelope: object) => void} [damage]  mutate the payload after its digest is taken
 */
export function carriedPayload(measurement = {}, damage) {
  return carriedEnvelope({ ...BLANK_MEASUREMENT, ...measurement }, damage,
    'ran the check runner and pasted its stdout')
}

/**
 * Any digest-covered payload, carried by a courier.
 *
 * The envelope is the same one `lib/verify.mjs`, `lib/boundary.mjs`, `lib/citations.mjs` and
 * `lib/effort.mjs` all print, so the trip is the same trip whatever computed it.
 */
export function carriedEnvelope(payload, damage, notes = 'ran the command and pasted its stdout') {
  const envelope = { payload, payload_digest: fnv1a(canonical(payload)) }
  if (damage) damage(envelope)

  return { stop_reason: 'carried', payload_raw: JSON.stringify(envelope), notes }
}

// ------------------------------------------------------------------ handles (docs/DESIGN.md#p2--code-does-what-is-deterministic-models-only-judge)

/** The one command a courier prompt hands its courier: the line after the instruction to run it. */
export function courierCommand(prompt) {
  const at = String(prompt).indexOf('Run exactly this one command')
  if (at === -1) throw new Error('this prompt hands its courier no command')
  return String(prompt).slice(at).split('\n').map((l) => l.trim()).filter(Boolean)[1]
}

/** Every value a command carries under `--<name>`, quoted or bare, in order. */
export function flagValues(command, name) {
  return [...String(command).matchAll(new RegExp('--' + name + ' (?:"([^"]*)"|(\\S+))', 'g'))].map((m) => m[1] ?? m[2])
}

/** The return file a dispatch names for its agent, or ''. */
export function returnFileOf(prompt) {
  const m = /RETURN FILE — write your full return to (.+?) as one JSON object/.exec(String(prompt))
  return m ? m[1] : ''
}

/**
 * What makes a courier dispatch carry data rather than handles: a payload transport on its
 * command, or a line no model should be retyping. [] when every courier prompt carries handles only.
 */
export function courierProblems(prompts) {
  const out = []
  for (const { prompt, opts } of prompts) {
    if (opts.agentType !== 'agentics:courier') continue
    const text = String(prompt)
    for (const [what, re] of [['printf', /printf/], ['--b64', /--b64/], ['--json-file', /--json-file/], ['a heredoc', /<</],
      ['--stdin', /--stdin/], ['a pipe', / \| /]]) {
      if (re.test(text)) out.push(`${opts.label}: carries ${what}`)
    }
    if (text.split('\n').some((l) => l.length > 1000)) out.push(`${opts.label}: a line longer than 1000 characters`)
  }
  return out
}

/** A context file path, as lib writes one, named after what it was written for. */
export const contextPath = (name) => `C:/repo/.agentics/.state/context/${name}-1.md`
