// test/harness/workflow-host.mjs — executes a *.workflow.js the way the runtime does:
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

import { canonical, fnv1a } from '../../lib/plan-digest.mjs'

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
 * An agent handler routed by `opts.label`. `script` maps a label (exact, or a prefix
 * ending in ':') to a value, or to a function (prompt, opts, callIndex) — callIndex
 * counts calls PER LABEL, so a re-verified order can answer differently per round.
 * An unscripted label throws, so a scenario cannot silently feed undefined downstream.
 */
export function scriptedAgents(script) {
  const counts = new Map()
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
    if (key === undefined) throw new Error('unscripted agent call: ' + (label || '(no label)'))
    const value = script[key]
    return typeof value === 'function' ? value(prompt, opts, n) : value
  }
}

/** Every field lib/verify.mjs prints, in the state it prints them in when nothing was observed. */
const BLANK_MEASUREMENT = {
  stop_reason: 'completed', build: 'absent', typecheck: 'absent', suite: 'absent', suite_output_tail: '',
  failing_tests: [], discriminator: [], mutations: [], series_findings: [], notes: '',
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

/**
 * The state line a `record:` dispatch actually carries, decoded.
 *
 * The workflow mints these whole and hands them to the recorder base64-encoded: a heredoc is
 * shell syntax, and every corruption this file has seen in the field was shell syntax too — a
 * Windows path's backslashes, an apostrophe in a test name, an indented closing delimiter.
 * Tests therefore assert on the RECORD rather than on a substring of its serialization, which
 * is the more durable assertion in any case.
 *
 * @param {string} prompt a recorder dispatch prompt
 * @returns {{ entry: object, digest: string, token: string }}
 */
export function recordedLine(prompt) {
  const call = /--digest (\S+) --b64 (\S+)/.exec(prompt || '')
  if (!call) throw new Error('this prompt carries no --digest/--b64 ledger append')

  return {
    entry: JSON.parse(Buffer.from(call[2], 'base64').toString('utf8')),
    digest: call[1],
    token: call[2],
  }
}

/**
 * The locations a `lib/citations.mjs excerpts` dispatch carries, decoded from its argv token.
 *
 * @param {string} prompt a courier prompt carrying `--digest D --b64 T`
 * @returns {{ digest: string, locations: Array<{path: string, line: number}> }}
 */
export function excerptLocations(prompt) {
  const call = /--digest (\S+) --b64 (\S+)/.exec(prompt || '')
  if (!call) throw new Error('this prompt carries no --digest/--b64 locations')
  return { digest: call[1], locations: JSON.parse(Buffer.from(call[2], 'base64').toString('utf8')) }
}

/**
 * `lib/citations.mjs excerpts`'s payload for the locations a prompt carries: a five-line window
 * around each location, merged when they touch, each line's text naming where it came from
 * (`text of <path>:<n>` unless `lineText` says otherwise). Wrap it in `carriedEnvelope` to answer
 * the courier; damage it first to exercise the transport ladder.
 */
export function excerptsPayload(prompt, { lineText = (path, n) => `text of ${path}:${n}` } = {}) {
  const { locations } = excerptLocations(prompt)
  const byPath = new Map()
  for (const { path, line } of locations) {
    if (!byPath.has(path)) byPath.set(path, [])
    byPath.get(path).push({ from: Math.max(1, line - 2), to: line + 2 })
  }

  const files = [...byPath].map(([path, ranges]) => {
    const merged = []
    for (const r of ranges.sort((a, b) => a.from - b.from)) {
      const last = merged[merged.length - 1]
      if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to)
      else merged.push({ ...r })
    }
    return {
      path,
      lines: 999,
      excerpts: merged.map((w) => ({
        ...w,
        text: Array.from({ length: w.to - w.from + 1 },
          (_, i) => `${w.from + i}\t${lineText(path, w.from + i)}`).join('\n'),
      })),
    }
  })

  const windows = files.reduce((n, f) => n + f.excerpts.length, 0)
  const bytes = files.reduce((n, f) => n + f.excerpts.reduce((m, e) => m + e.text.length, 0), 0)
  return {
    repo: '.', files, unresolved: [],
    counts: { locations: locations.length, files: files.length, excerpts: windows, bytes, unresolved: 0 },
    notes: 'resolved ' + windows + ' window(s)',
  }
}

/** An excerpts courier that resolves every location its prompt carries. */
export const carriedExcerpts = (prompt) => carriedEnvelope(excerptsPayload(prompt))
