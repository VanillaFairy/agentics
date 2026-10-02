export const meta = {
  name: 'execute-approved-plan-in-worktrees',
  description: 'Execute a subtree of an agentics effort: plan unplanned composites, run every leaf by its rigor in its own worktree, review, and merge by composite into framework-owned integration branches — scheduled by readiness, never by waves. Never touches the user\'s branch or working tree.',
  phases: [
    { title: 'Preflight', detail: 'refuse overlaps, drift, gaps, free dead slots — one courier' },
    { title: 'Plan', detail: 'planner per unplanned composite; a survey first where the ground is unknown' },
    { title: 'Execute', detail: 'per leaf: leaf-open, executor by rigor, leaf-close, fix rounds, review loop' },
    { title: 'Integrate', detail: 'merge-batch per composite, integration review, merge up' },
    { title: 'Postflight', detail: 'faults, summary, cleanup report' },
  ],
}

// Design: docs/DESIGN.md#execution. Every deterministic step is a `lib/boundary.mjs` entry point
// run by a courier, scheduling and every decision record included: the boundary that closes a
// dispatch reads what its agent wrote and records what it decides. This script holds only what a
// script can hold without a filesystem — the units in flight — and hands each courier handles
// (docs/DESIGN.md#gp6--couriers-carry-handles-data-stays-where-its-author-wrote-it).
//
// Schemas carry no bounds and no verdict booleans (lint: no-schema-bounds, no-self-verdict).

const input = args && typeof args === 'object' ? args : {}

const posix = (p) => String(p == null ? '' : p).split('\\').join('/')
const repo = posix(String(input.repo || input.roots || '.').split(/[,;\n]/)[0].trim() || '.')
const effort = String(input.effort || '').trim()
const rootId = String(input.root || '.').trim() || '.'
const execution = String(input.execution || '').trim()
const pace = ['frugal', 'balanced', 'fast'].includes(input.pace) ? input.pace : 'balanced'
const pluginRoot = posix(String(input.plugin_root || '$CLAUDE_PLUGIN_ROOT').trim())

// ---------------------------------------------------------------- digests and arguments
//
// Written out here because a workflow script has no imports: `canonical` and `fnv1a` must stay
// identical to lib/plan-digest.mjs, and ARGS to `ARGS` in lib/boundary.mjs. The scenario harness
// parses every courier's command with the lib's own `handleArgs` over the lib's own table, so a
// drift in any of them fails every scenario in test/agentics-develop-scenarios.test.mjs.

function canonical(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
}

function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// lib/store.mjs's nameKey, copied because a script cannot import, and pinned to it by the suite.
const NAME_KEY_MAX = 40
const nameKey = (text) => (text.length <= NAME_KEY_MAX ? text : text.slice(0, NAME_KEY_MAX - 9) + '_' + fnv1a(text))

const ARGS = {
  preflight: {
    root: 'one', retry: 'many', confirmed_duplicate: 'bool', confirmed_gaps: 'bool', plan_only: 'bool',
    dial: 'one', pace: 'one', base_ref: 'one', commands_file: 'one', dispatch: 'many',
  },
  schedule: { running: 'many', planning: 'many', stopping: 'bool', fault: 'many', dispatch: 'many' },
  'leaf-open': { node: 'one', role: 'one', round: 'int', tier: 'one', wait_ms: 'int', dispatch: 'many' },
  'leaf-close': {
    node: 'one', role: 'one', round: 'int', mode: 'one', status: 'one', said: 'one', head_before: 'one',
    base_sha: 'one', dispatch: 'many',
  },
  'leaf-review': { node: 'one', round: 'int', review_round: 'int', review_file: 'one', dispatch: 'many' },
  'merge-batch': { target: 'one', card: 'one', dispatch: 'many' },
  'suite-gate': { target: 'one', dispatch: 'many' },
  'folder-review': { target: 'one', card: 'one', review_file: 'one', dispatch: 'many' },
  'rule-close': { kind: 'one', record: 'one', rulings_file: 'one', running: 'many', dispatch: 'many' },
  postflight: { fault: 'many', dispatch: 'many' },
  'spec-check': { node: 'one', status: 'one', said: 'one', dispatch: 'many' },
  'spec-reviewed': {
    node: 'one', hash: 'one', findings_file: 'one', previous_file: 'one', previous_hash: 'one', complete: 'bool',
    remaining: 'many', dispatch: 'many',
  },
  'spec-settle': {
    node: 'one', hash: 'one', findings_file: 'one', return_file: 'one', status: 'one', said: 'one', finding: 'many',
    refused: 'many', dispatch: 'many',
  },
  'spec-gate': { node: 'one', edited: 'bool', dispatch: 'many' },
  'spec-prepare': { node: 'one', review: 'one', leaf_rev: 'one', dispatch: 'many' },
}

// ---------------------------------------------------------------- schemas

const CARRIED = {
  type: 'object', additionalProperties: false,
  required: ['stop_reason', 'payload_raw'],
  properties: {
    stop_reason: { type: 'string', enum: ['carried', 'failed'] },
    payload_raw: { type: 'string' },
  },
}

const EXECUTOR_STATUSES = ['done', 'done_with_concerns', 'blocked', 'needs_context', 'needs_tests',
  'decompose', 'unsplittable', 'premise_mismatch', 'needs_decision', 'contract_changed']

const EXECUTOR_TYPE = {
  implementer: 'agentics:implementer',
  'test-author': 'agentics:test-author',
  auditor: 'agentics:auditor',
}

const EXECUTOR = {
  type: 'object', additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string', enum: EXECUTOR_STATUSES } },
}

/** An agent whose output is the file its dispatch named: the return says only whether it wrote it. */
const WROTE = {
  type: 'object', additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string', enum: ['written', 'not_written'] } },
}

const PLANNED = {
  type: 'object', additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string', enum: ['written', 'needs_decision', 'contract_changed', 'premise_mismatch', 'unsplittable', 'blocked'] } },
}

const SETTLED = {
  type: 'object', additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string', enum: ['settled', 'needs_decision', 'blocked'] } },
}

const COMMAND_NAMES = ['build', 'typecheck', 'suite', 'suite_fast', 'test_one']

const ESTABLISHED = {
  type: 'object', additionalProperties: false,
  required: ['established', 'unresolved'],
  properties: {
    established: { type: 'array', items: { type: 'string', enum: COMMAND_NAMES } },
    unresolved: { type: 'array', items: { type: 'string', enum: COMMAND_NAMES } },
  },
}

// ---------------------------------------------------------------- the dial and the tiers
//
// Design: docs/DESIGN.md#model-tier. The dial is a ceiling derived from the session's model
// (low → sonnet judges, normal/max → opus); effort follows the model a dispatch resolves to.

const DIAL = ['low', 'normal', 'max'].includes(input.intelligence) ? input.intelligence : 'normal'
const JUDGE = { low: 'sonnet', normal: 'opus', max: 'opus' }[DIAL]
const RANK = { haiku: 0, sonnet: 1, opus: 2 }
const SONNET_STEP = { low: 'low', medium: 'high', high: 'xhigh', xhigh: 'xhigh', max: 'max' }
const EFFORT_UP = { low: 'medium', medium: 'high', high: 'xhigh', xhigh: 'max', max: 'max' }
const lowerOf = (a, b) => ((RANK[a] ?? 1) <= (RANK[b] ?? 1) ? a : b)

const tierFor = (model, base) => ({
  model,
  effort: model === 'sonnet' ? SONNET_STEP[base] || 'high' : DIAL === 'max' ? 'high' : 'medium',
})

const isYardstick = (row) => row.role === 'red' || row.role === 'audit' || row.provides_n > 0

/**
 * The producer's tier. The author's `dispatch.producer` wins; otherwise sonnet, or opus for a
 * yardstick — under the dial's ceiling. A fix round that failed to clear its blockers raises the
 * producer one step, and that one step may exceed the ceiling.
 */
function producerTier(row, raised) {
  const set = (row.dispatch && row.dispatch.producer) || {}
  const model = set.model || lowerOf(isYardstick(row) ? 'opus' : 'sonnet', JUDGE)
  const tier = set.effort ? { model, effort: set.effort } : tierFor(model, 'medium')
  if (!raised) return tier
  return model === 'sonnet' ? tierFor('opus', 'medium') : { model, effort: EFFORT_UP[tier.effort] || 'high' }
}

const reviewerTier = (row) => {
  const set = (row && row.dispatch && row.dispatch.reviewer) || {}
  return set.model ? { model: set.model, effort: set.effort || tierFor(set.model, 'high').effort } : tierFor(JUDGE, 'high')
}

const COURIER = { model: 'haiku', effort: 'low' }
const COURIER_UP = { model: 'sonnet', effort: 'low' }
// The refusals that mean the arguments were damaged on their way in, not that the program failed.
const DAMAGED_IN = ['digest_mismatch', 'args_unreadable']

// ---------------------------------------------------------------- state
//
// No copy of the tree lives here, and no record: status is derived on disk, every decision is
// recorded by the boundary that closes its dispatch, and every unit is launched by the `schedule`
// boundary with its card. What this script holds is what only it can: the units in flight, the
// plugin faults only it saw, and what it was told back.

const stoppedHere = new Set()   // nodes stopped or held while this invocation ran
const planning = new Set()      // folders a running unit is replanning inline
const ruling = new Set()        // drift consumers a ruler is ruling on: not launched meanwhile
const running = new Map()       // unit key -> its promise, until a tick has been built after it ended
const finished = new Set()      // units that ended since the last tick was built
let invocation = 0              // minted by preflight: what makes this invocation's file names its own
let saidDir = ''                // minted by preflight: where authors write what a record only points at
const failedChannels = []
const notes = []
const implemented = []
const escalations = []
const parked = []
const faults = []               // plugin faults: never the user's, retried by the next invocation
const reviews = []
const drift = []
let dispatches = 0
const byModel = {}
let leavesFinished = 0
let stopping = ''
let ticks = 0

const note = (text) => {
  notes.push(text)
  log(text)
}

/** Every agent dispatch goes through here, so the result's count is measured, not projected. */
async function dispatch(prompt, opts) {
  dispatches++
  byModel[opts.model || 'inherit'] = (byModel[opts.model || 'inherit'] || 0) + 1
  return agent(prompt, opts)
}

/** A dispatch as the boundary that closes it records its cost line: `<label>=<role>/<model>/<effort>`. */
const tokenOf = (opts) => opts.label + '=' + String(opts.agentType || '').replace('agentics:', '') + '/' + (opts.model || '') + '/' + (opts.effort || '')

/** What a boundary told back about the stops it recorded: escalations, parks, and nodes held on a plugin fault. */
function noteStops(out) {
  for (const s of (out && out.stops) || []) {
    stoppedHere.add(s.id)
    if (s.status === 'held') {
      if (!faults.some((f) => f.id === s.id && f.channel === s.reason)) {
        faults.push({ id: s.id, channel: s.reason })
        note('plugin fault on ' + s.id + ' (' + s.reason + ') — held for the next invocation')
      }
    } else if (s.status === 'escalated' && !escalations.some((e) => e.id === s.id && e.reason === s.reason)) {
      escalations.push({ id: s.id, reason: s.reason, said: s.said })
      note('escalated ' + s.id + ': ' + s.reason)
      leavesFinished++
    } else if (s.status === 'parked' && !parked.some((p) => p.id === s.id && p.return === s.reason)) {
      parked.push({ id: s.id, return: s.reason, said: s.said })
      note('parked ' + s.id + ' (' + s.reason + '): waiting on the user')
    }
  }
}

/**
 * A plugin fault only this script saw — a boundary that stayed unbelievable, a throw here — is not
 * a decision for the user: the node is held for the rest of this invocation, the next schedule or
 * postflight records it, and the next invocation takes the node up where its records say it stands.
 */
function hold(id, channel) {
  stoppedHere.add(id)
  if (faults.some((f) => f.id === id && f.channel === channel)) return
  faults.push({ id, channel })
  note('plugin fault on ' + id + ' (' + channel + ') — held for the next invocation')
}

const faultTokens = () => faults.map((f) => f.id + ':' + f.channel)

/** The user answered a node this invocation stopped, and disk says it is ready again: it runs on. */
function answered(id) {
  stoppedHere.delete(id)
  for (const list of [escalations, parked]) {
    for (let at = list.findIndex((x) => x.id === id); at !== -1; at = list.findIndex((x) => x.id === id)) {
      if (list === escalations) leavesFinished--
      list.splice(at, 1)
    }
  }
  note(id + ': answered while the run went on — relaunched')
}

/**
 * Where the agent behind `label` writes what a record points at: a question for the user, a
 * review, a rulings file. One file per dispatch — the invocation, a count within it and the label,
 * a node id's `/` written `.`, bounded by nameKey — so no later dispatch overwrites what an open
 * stop points at, and no label outgrows its file name.
 */
let saidN = 0
const saidPath = (label, ext) => (saidDir
  ? saidDir + '/' + invocation + '-' + (++saidN) + '-' + nameKey(label.split('/').join('.').replace(/[^A-Za-z0-9.-]+/g, '-')) + '.' + ext
  : '')

// ---------------------------------------------------------------- boundaries

class TransportError extends Error {}

/**
 * What a courier carried back: the payload, or why it cannot be believed and whether to retry.
 * What the program printed decides; the courier's `stop_reason` is read only where it printed
 * nothing to decide by, because a courier may call a typed refusal a failed run.
 */
function carried(held) {
  if (!held) return { payload: null, why: 'the dispatch returned nothing', retry: 'again' }
  const notRun = held.stop_reason !== 'carried'
    ? { payload: null, why: 'the courier could not run the command', retry: 'again' }
    : null
  let parsed
  try {
    parsed = JSON.parse(held.payload_raw)
  } catch (e) {
    return notRun || { payload: null, why: 'the payload did not survive transcription: ' + (e && e.message), retry: 'stronger' }
  }
  if (parsed && typeof parsed.error === 'string') return { payload: null, why: 'the program failed: ' + parsed.error, retry: '' }
  if (!parsed || !parsed.payload || typeof parsed.payload_digest !== 'string') {
    return notRun || { payload: null, why: 'what came back is not a digest-covered envelope', retry: 'stronger' }
  }
  const actual = fnv1a(canonical(parsed.payload))
  if (actual !== parsed.payload_digest) {
    return { payload: null, why: 'digest mismatch: computed as ' + parsed.payload_digest + ', arrived as ' + actual, retry: 'stronger' }
  }
  return { payload: parsed.payload, why: '', retry: '' }
}

const courierPrompt = (command) =>
  'Run exactly this one command, unchanged (Bash timeout 600000), and put its entire stdout in payload_raw:\n\n' + command +
  (pluginRoot === '$CLAUDE_PLUGIN_ROOT'
    ? '\n\nIf $CLAUDE_PLUGIN_ROOT is empty in your shell, do not guess a path: set stop_reason "failed".'
    : '')

const quoted = (s) => '"' + s + '"'

/**
 * The one command a courier runs for a boundary over these arguments: every value a handle on its
 * own flag, built from ARGS, and the digest over the object `handleArgs` will parse back.
 */
function tripOf(name, a) {
  const value = {}
  const flags = []
  for (const [key, kind] of Object.entries(ARGS[name])) {
    const v = a[key]
    if (kind === 'many') {
      value[key] = (Array.isArray(v) ? v : []).map(String)
      for (const x of value[key]) flags.push('--' + key + ' ' + quoted(x))
    } else if (kind === 'int') {
      value[key] = Number(v) || 0
      flags.push('--' + key + ' ' + value[key])
    } else if (kind === 'bool') {
      value[key] = v === true
      flags.push('--' + key + ' ' + (v === true ? 1 : 0))
    } else {
      value[key] = v == null ? '' : String(v)
      if (value[key]) flags.push('--' + key + ' ' + quoted(value[key]))
    }
  }
  return 'node ' + quoted(pluginRoot + '/lib/boundary.mjs') + ' ' + name + ' --repo ' + quoted(repo) + ' --effort ' + quoted(effort) +
    ' --execution ' + quoted(execution) + ' ' + flags.join(' ') + ' --digest ' + fnv1a(canonical(value))
}

/**
 * Run one boundary entry point through a courier and believe its payload only after the digest.
 * Every attempt's courier rides in `dispatch`, beside the agent dispatches the call closes, so the
 * boundary records each cost line once by its label.
 *
 * Retries are sized to what was observed: a courier that returned nothing or could not run the
 * command is re-run (every entry point is idempotent); a payload damaged in transit, or arguments
 * the program refused as damaged on their way in, buy one more trip on a stronger model; a program
 * failure is not retried. What stays unbelievable is a transport failure, thrown: the unit ends as
 * a plugin fault, never a question for the user.
 */
async function boundary(name, a, ctx) {
  const plan = [COURIER]
  const couriers = []
  let why = ''
  for (let i = 0; i < plan.length; i++) {
    const opts = { agentType: 'agentics:courier', schema: CARRIED, phase: ctx.phase, label: ctx.label + (i ? '#' + (i + 1) : ''), ...plan[i] }
    couriers.push(tokenOf(opts))
    let held = null
    try {
      held = await dispatch(courierPrompt(tripOf(name, { ...a, dispatch: [...(a.dispatch || []), ...couriers] })), opts)
    } catch (err) {
      held = null
      why = 'the courier threw: ' + (err && err.message)
    }
    const c = carried(held)
    if (c.payload) {
      if (c.payload.error && DAMAGED_IN.includes(c.payload.error.kind)) {
        // The program wrote nothing. A model that miscopies an argument miscopies it the same way
        // again, so the copy goes to the stronger one; damaged there too, it is a transport fault.
        why = 'the arguments arrived damaged (' + c.payload.error.kind + ')'
        if (!plan.includes(COURIER_UP)) plan.push(COURIER_UP)
        continue
      }
      return c.payload
    }
    why = c.why || why
    if (c.retry === 'again' && plan.length < 2) plan.push(COURIER)
    else if (c.retry === 'stronger' && !plan.includes(COURIER_UP)) plan.push(COURIER_UP)
  }
  throw new TransportError(name + ': ' + why)
}

/** A boundary whose long checks run detached: re-dispatch while it reports them pending, each poll a courier of its own. */
async function settled(name, a, ctx) {
  let payload = await boundary(name, a, ctx)
  for (let poll = 2; payload && payload.status === 'pending'; poll++) {
    log(ctx.label + ': checks still running detached — re-dispatching to collect them')
    payload = await boundary(name, a, { ...ctx, label: ctx.label + '@' + poll })
  }
  return payload
}

// ---------------------------------------------------------------- prompts

const EXECUTOR_SAID = (said) => said
  ? ' For any status but done, first write what you established, what you tried and what you need, in full, to ' + said +
    ' (its first line says it in one sentence): it is what the user reads.'
  : ''

function executorPrompt(item, st, opened, mode) {
  const { id, row } = item
  const fetch = st.role === 'implementer'
    ? 'Fetch it: node "' + pluginRoot + '/lib/brief.mjs" fetch --path "' + opened.brief_path + '" --digest ' + opened.brief_digest
    : 'Read it with your Read tool (the leaf-close script re-checks its digest, ' + opened.brief_digest + ').'
  const modeText = mode === 'continue'
    ? 'The branch already carries commits of this leaf from an interrupted dispatch: continue the series, do not rebuild it.\n'
    : mode === 'fix'
      ? 'This is fix round ' + st.round + ': clear, as new commits, every failure and finding the brief\'s Fix round section lists.\n'
      : ''
  return 'You are the ' + st.role + ' for leaf ' + id + ', round ' + st.round + ', rigor ' + row.rigor +
    (row.role !== 'none' ? ', role ' + row.role : '') + '.\n' + modeText +
    'Worktree: ' + opened.worktree + ' (branch ' + opened.branch + ', base ' + opened.base_sha + ').\n' +
    'Brief: ' + opened.brief_path + '. ' + fetch + '\n' +
    'Report file: ' + opened.report_path + '.\n\nReturn your status.' + EXECUTOR_SAID(st.said)
}

const reviewFileShape = (claims) => 'Write your review, as JSON, to the file below: {"findings": [{"id", "severity", "claim", ' +
  '"evidence", "failure_scenario", "remedy"}], "fix_verdicts": [{"id", "status", "evidence"}], "claims": ' +
  (claims ? '[{"claim", "verdict", "evidence"}]' : '[]') + ', "notes"}. Then return status written.'

function reviewerPrompt(item, st, round, file) {
  const { id, row } = item
  const span = round === 1 ? st.base + '..' + st.head : st.deltaBase + '..' + st.head
  return 'Adversarially review leaf ' + id + ', round ' + round + '. You are fresh: nothing from earlier rounds reaches you ' +
    'but the files named below.\n' +
    'Worktree: ' + st.worktree + ' (branch ' + st.branch + '). Span under review: ' + span +
    (round === 1 ? ' — the whole series.' : ' — the fix commits since the last round only; a critical you see outside it is still reported.') + '\n' +
    (st.brief
      ? 'Brief (criteria, locus, decisions, contracts): read ' + st.brief + '.\n'
      : 'Criteria, locus, decisions and contracts: node "' + pluginRoot + '/lib/tree.mjs" show --repo "' + repo +
        '" --effort "' + effort + '" --root "' + id + '" --json\n') +
    (isYardstick(row) ? 'This leaf\'s output is a YARDSTICK (' + (row.provides_n > 0 ? 'it provides a contract' : 'role ' + row.role) +
      '): its majors with a failure scenario block like criticals.\n' : '') +
    (row.role === 'red' ? 'Its tests are what the green is coded against: a test a correct green would fail is critical.\n' : '') +
    (row.role === 'green' ? 'The tests were written by another agent before this code and sit outside this locus.\n' : '') +
    (st.report ? 'The executor\'s report, whose concerns you attack first: ' + st.report + '.\n' : '') +
    (st.lastReview
      ? 'Prior blockers are the `open` list in ' + st.lastReview + ': rule on each in fix_verdicts, and re-report under its id any you rule not_fixed or regressed.\n'
      : '') +
    'Claim verdicts belong to integration reviews: claims is [].\n' + reviewFileShape(false) + '\n' + file
}

function integrationPrompt(item, file) {
  const { id } = item
  return 'Integration review of composite ' + id + '. Its card, ' + item.card + ', names the worktree, the merged diff ' +
    '(where.base..where.head), the folder\'s spec (spec_path, your yardstick), the children merged here, and those that had ' +
    'no review loop of their own (unreviewed): review those against their own criteria too.\n' +
    'Judge every claim the spec makes (each success criterion in its Intent, each statement of its Design, each criterion of ' +
    'its plan): one entry per claim in claims, {claim, verdict: met | under | over | deviates | spec_defect | cant_tell, evidence}. ' +
    'A HUMAN: criterion is the user\'s: leave it out.\n' +
    'Its decisions, and the criteria of every child, are in: node "' + pluginRoot + '/lib/tree.mjs" show --repo "' + repo +
    '" --effort "' + effort + '" --root "' + id + '" --json\n' +
    'Look for defects that exist only with the children together, and for any decision no child realised.\n' +
    reviewFileShape(true) + '\n' + file
}

const RULING_CHARGE = 'That file holds, per node, its plan entry and the change: it is everything you rule on. ' +
  'For each node, rule `unaffected` when everything its plan entry assumes, and every criterion it must ' +
  'meet, still holds after the change, or `affected` when something it assumes no longer does. Give `why` in one sentence. ' +
  'For `affected`, `question` is the one question its owner must answer: what changed, what in the entry no longer holds, ' +
  'and the choice to make; the planner replans from it, and it reaches the user only if the planner cannot. ' +
  'If the file cannot decide a node, rule it `affected` and ask.'

const driftPrompt = (target, nodes, brief) =>
  'Merged work into ' + target + ' of effort ' + effort + ' touched files under contracts that nodes not yet merged consume: ' +
  nodes.join(', ') + '. Read ' + brief + '.\n' + RULING_CHARGE

const stalePrompt = (stale) =>
  'The base branch of effort ' + effort + ' moved under leaves not yet merged: ' + stale.nodes.join(', ') +
  '. Read ' + stale.brief + '.\n' + RULING_CHARGE

function plannerPrompt(item, why, whyFile, context, said) {
  const { id, row, card } = item
  const check = 'node "' + pluginRoot + '/lib/spec.mjs" check --repo "' + repo + '" --effort "' + effort + '" --folder "' + id + '"'
  const charge = row.kind === 'leaf'
    ? 'Task ' + id + ' is promoted to a folder of its own. Write its spec: ' + row.spec_path + '. Its entries realise every ' +
      'decision the task realises (the card lists them) and carry its criteria forward. Do not touch the spec that holds the task\'s entry.\n'
    : row.kind === 'design'
      ? 'Sub-effort ' + id + ' has author: planner. Write its spec: ' + row.spec_path + '.\n'
      : 'Folder ' + id + ' is yours (author: planner). Rewrite its spec in place: ' + row.spec_path + '.\n'
  return 'Plan folder ' + id + ' of effort ' + effort + ' (repository ' + repo + '). Its card, ' + card + ', holds its title, ' +
    'intent and decisions, and why it is planned.\n' + charge +
    (why ? 'Why: ' + why + (whyFile ? ' — read ' + whyFile + ' for the account behind it.' : '.') + '\n' : '') +
    'Read the tree: node "' + pluginRoot + '/lib/tree.mjs" show --repo "' + repo + '" --effort "' + effort + '" --json\n' +
    'Check the spec until it prints no problems: ' + check + '\n' +
    'Never write a Decisions row: a decision you need is a needs_decision return.\n' +
    (context ? 'Evidence: a survey of this folder\'s ground is in ' + context + '.\n' : '') +
    '\nReturn status written once the spec is written and checked, or the user-bound need. For any other status, first write ' +
    'the question or the need, in full, to ' + said + ' (its first line says it in one sentence): it is what the user reads.'
}

function settlePrompt(id, specFile, findingsFile, fresh, refused, said, file) {
  return 'Settle the autonomous review of folder ' + id + ' of effort ' + effort + ' (repository ' + repo + '). Its spec: ' + specFile +
    '. The review\'s findings, in full: ' + findingsFile + '.\n' +
    'Findings to settle: ' + fresh.join(', ') + '.\n' +
    'Give each one disposition: incorporated (you edited the spec\'s Design, Plan or Open questions because of it) ' +
    'or discarded. An ambiguity or a gap can only be incorporated; a note may be discarded. A finding whose fix would state or ' +
    'change a decision is not yours: return needs_decision with the question.\n' +
    'After editing, check the spec until it prints no problems: node "' + pluginRoot + '/lib/spec.mjs" check --repo "' + repo +
    '" --effort "' + effort + '" --folder "' + id + '"\n' +
    (refused.length
      ? 'Refused last time, settle these again: ' + refused.join(', ') + ' — each needs a disposition, and an ambiguity or a gap can only be incorporated.\n'
      : '') +
    'Write your dispositions, as JSON, to ' + file + ': {"dispositions": [{"finding": "<id>", "outcome": "incorporated" | "discarded"}]}. ' +
    'If you return needs_decision or blocked, first write the question or the need, in full, to ' + said +
    ' (its first line says it in one sentence).\nReturn your status.'
}

// ---------------------------------------------------------------- units

function launch(key, fn) {
  const p = Promise.resolve().then(fn).catch((err) => {
    const id = key.slice(key.indexOf(':') + 1)
    const channel = err instanceof TransportError ? 'transport' : 'pipeline'
    failedChannels.push(channel)
    note(key + ' ended on a ' + channel + ' fault: ' + (err && err.message))
    if (!stoppedHere.has(id)) hold(id, channel)
  }).finally(() => finished.add(key))
  running.set(key, p)
}

/** A boundary answered with an error and recorded nothing about it: the program's fault, never the user's. */
function refusedOn(id, out) {
  noteStops(out)
  if (!out || !out.error) return false
  if (!((out.stops || []).length)) hold(id, 'program')
  return true
}

// ---------------------------------------------------------------- planning

/**
 * Plan a node by having the planner write its spec, then review it until the gate opens, prepare
 * it and compile it. `item` is `{id, card, row}`; `why` says why it is (re)planned and `whyFile`
 * names the account behind it. Returns the node's row as compiled, or null once it stopped.
 */
async function planNode(item, why, whyFile) {
  planning.add(item.id)
  try {
    const checked = await writeSpec(item, why, whyFile)
    return checked ? await reviewSpec(item, checked) : null
  } finally {
    planning.delete(item.id)
  }
}

/** A ruler ruled that a change moved this node's premise: the planner answers first. */
async function replanAffected(r) {
  note(r.id + ': ruled affected — replanning it')
  try {
    await planNode(r, 'premise_mismatch', r.said)
  } catch (err) {
    if (!stoppedHere.has(r.id)) hold(r.id, 'dispatch')
  }
}

/** The planner writes the node's spec; spec-check closes its dispatch. The check, or null once the node stopped. */
async function writeSpec(item, why, whyFile) {
  const { id, row } = item
  let context = ''
  if (!why && row.ground_known === false) {
    phase('Plan')
    const survey = await workflow({ scriptPath: pluginRoot + '/service-workflows/gather-evidence-without-concluding.workflow.js' }, {
      question: 'Where and how does the change described in ' + item.card + ' land? Its title and intent are in that file.',
      roots: repo, notes: '', pace, intelligence: DIAL, plugin_root: pluginRoot,
    }).catch((err) => {
      failedChannels.push('survey')
      note('survey for ' + id + ' failed: ' + (err && err.message) + ' — planning on the tree alone')
      return null
    })
    if (survey) {
      context = survey.context || ''
      if (survey.coverage && survey.coverage.complete !== true) note('survey for ' + id + ' is incomplete')
    }
  }
  const label = 'plan:' + id
  const said = saidPath(label, 'md')
  const opts = { agentType: 'agentics:planner', schema: PLANNED, phase: 'Plan', label, ...tierFor(JUDGE, 'high') }
  const res = await dispatch(plannerPrompt(item, why, whyFile, context, said), opts).catch((err) => {
    note(label + ' returned nothing: ' + (err && err.message))
    return null
  })
  const checked = await boundary('spec-check', { node: id, status: res ? res.status : '', said, dispatch: [tokenOf(opts)] },
    { phase: 'Plan', label: 'spec-check:' + id })
  if (refusedOn(id, checked) || checked.status !== 'checked') return null
  log(label + ' wrote ' + checked.spec_path)
  return checked
}

/**
 * The autonomous review of a planner-written spec: attack it with a nested review, record the
 * round, have the planner settle what the round found, and re-review only what changed, until the
 * ledger's gate opens; then prepare and compile. Every exit is computed by a boundary from the
 * files the review and the planner wrote.
 */
async function reviewSpec(item, first) {
  const { id } = item
  let checked = first
  let since = ''
  let previous = { file: '', hash: '' }
  for (;;) {
    const review = await workflow({ scriptPath: pluginRoot + '/service-workflows/attack-document-with-independent-reviewers.workflow.js' }, {
      artifact: checked.spec_path, roots: repo, plugin_root: pluginRoot,
      context: 'the spec develop\'s planner wrote for folder ' + id + ' of effort ' + effort,
      ...(since ? { since } : {}),
    }).catch((err) => {
      failedChannels.push('autonomous-review')
      note('the autonomous review of ' + id + ' failed: ' + (err && err.message))
      return null
    })
    if (!review) {
      hold(id, 'dispatch')
      return null
    }
    if ((review.lost || []).length) {
      // A prober reported and its return never reached lib: the plugin lost it, so the round is
      // run again, never recorded as a review that left the spec unread.
      note('the autonomous review of ' + id + ' lost ' + review.lost.join(', '))
      hold(id, 'dispatch')
      return null
    }
    const whole = !!(review.coverage && review.coverage.complete === true)
    const remaining = whole ? [] : ((review.coverage && review.coverage.resumable && review.coverage.resumable.remaining) || [])
    const reviewed = await boundary('spec-reviewed', {
      node: id, hash: checked.hash, findings_file: review.findings_file || '', previous_file: previous.file,
      previous_hash: previous.hash, complete: whole, remaining,
    }, { phase: 'Plan', label: 'spec-reviewed:' + id })
    if (refusedOn(id, reviewed) || reviewed.status !== 'recorded') return null
    let edited = false
    if ((reviewed.fresh || []).length) {
      const out = await settle(id, checked, review, reviewed.fresh)
      if (!out) return null
      edited = out.incorporated_n > 0
    }
    const gate = await boundary('spec-gate', { node: id, edited }, { phase: 'Plan', label: 'spec-gate:' + id })
    if (refusedOn(id, gate)) return null
    // The prepared line names the review return that passed. A clean round records an empty
    // return, so only a probe whose record failed (then its snapshot) or whose scope failed too
    // (then the spec hash) is named by what it read.
    if (gate.ratifiable) return prepare(item, review.review || review.snapshot || checked.hash)
    if (gate.status === 'stopped') return null
    since = review.snapshot || ''
    previous = { file: review.findings_file || '', hash: checked.hash }
    checked = await boundary('spec-check', { node: id }, { phase: 'Plan', label: 'spec-check:' + id })
    if (refusedOn(id, checked) || checked.status !== 'checked') return null
  }
}

/** The planner's dispositions, settled by spec-settle: refused ones go back once. Its payload, or null once the folder stopped. */
async function settle(id, checked, review, fresh) {
  let refused = []
  for (let attempt = 1; ; attempt++) {
    const label = 'settle:' + id + '#' + attempt
    const said = saidPath(label, 'md')
    const file = saidPath(label, 'json')
    const opts = { agentType: 'agentics:planner', schema: SETTLED, phase: 'Plan', label, ...tierFor(JUDGE, 'high') }
    const res = await dispatch(settlePrompt(id, checked.spec_path, review.findings_file, fresh, refused, said, file), opts).catch(() => null)
    const out = await boundary('spec-settle', {
      node: id, hash: checked.hash, findings_file: review.findings_file || '', return_file: file, status: res ? res.status : '',
      said, finding: fresh, refused, dispatch: [tokenOf(opts)],
    }, { phase: 'Plan', label: 'spec-settle:' + id + '#' + attempt })
    if (refusedOn(id, out)) return null
    if (out.status === 'refused') {
      refused = out.refused || []
      continue
    }
    return out.status === 'settled' ? out : null
  }
}

/** The gate passed on the review `reviewed` names: record the preparation and compile. The node as compiled, or null. */
async function prepare(item, reviewed) {
  const out = await boundary('spec-prepare', {
    node: item.id, review: reviewed, leaf_rev: item.row.kind === 'leaf' ? String(item.row.rev) : '',
  }, { phase: 'Plan', label: 'spec-prepare:' + item.id })
  if (refusedOn(item.id, out) || out.status !== 'prepared') return null
  log('prepared ' + item.id + ' on ' + reviewed + '; compiled ' + ((out.compile && out.compile.written_n) || 0) + ' node(s)')
  return out.row
}

// ---------------------------------------------------------------- rulings

/**
 * One ruler rules each node a change touched, writing every ruling to one file; rule-close reads
 * it and records each ruling, parking what the user must answer. A dispatch that returned nothing
 * is tried once more, fresh, since it may just have been lost. The nodes to replan come back.
 */
async function rule(kind, label, prompt, phaseName, record) {
  const file = saidPath(label, 'json')
  const told = prompt + '\nWrite every ruling, as JSON, to ' + file + ': {"rulings": [{"node", "ruling", "why", "question"}]}, ' +
    'one entry per node. Then return status written.'
  const tokens = []
  for (const attempt of [1, 2]) {
    const opts = { agentType: 'agentics:ruler', schema: WROTE, phase: phaseName, label: label + (attempt > 1 ? '#' + attempt : ''), ...tierFor(JUDGE, 'high') }
    tokens.push(tokenOf(opts))
    const res = await dispatch(told, opts).catch((err) => {
      note(opts.label + ' returned nothing: ' + (err && err.message))
      return null
    })
    if (res) {
      if (res.status !== 'written') note(opts.label + ': the ruler says it wrote no rulings')
      break
    }
  }
  const out = await boundary('rule-close', { kind, record, rulings_file: file, running: [...running.keys()], dispatch: tokens },
    { phase: phaseName, label: 'ruled:' + label.slice(label.indexOf(':') + 1) })
  noteStops(out)
  return out.replan || []
}

// ---------------------------------------------------------------- commands

let establishing = null

/**
 * Establish build and test commands once per execution: the investigator writes them and records
 * them as `command` gotchas itself. Every leaf that waited on it gets its dispatch's cost token.
 */
function establishCommands(worktree) {
  if (!establishing) {
    const file = saidPath('establish-commands', 'json')
    const opts = { agentType: 'agentics:investigator', schema: ESTABLISHED, phase: 'Execute', label: 'establish-commands', model: 'sonnet', effort: 'medium' }
    establishing = dispatch(
      'No build or test command is established for this repository. Establish build, typecheck, suite, suite_fast and test_one in ' +
      worktree + ', proving each by running it. Write them, as a JSON array of command gotchas, to ' + file + ', then record them with:\n' +
      'node "' + pluginRoot + '/lib/gotchas.mjs" add --repo "' + repo + '" --effort "' + effort + '" --role investigator --file "' + file + '"\n' +
      'Return the commands you established, and those you could not.',
      opts,
    ).then((res) => {
      if (res) note('commands established: ' + ((res.established || []).join(', ') || 'none') + ((res.unresolved || []).length ? '; not established: ' + res.unresolved.join(', ') : ''))
      return [tokenOf(opts)]
    }, () => [tokenOf(opts)])
  }
  return establishing
}

// ---------------------------------------------------------------- one leaf

function roleOf(row) {
  if (row.rigor === 'verify') return ''
  if (row.role === 'red' || row.rigor === 'tests-only') return 'test-author'
  if (row.role === 'audit') return 'auditor'
  return 'implementer'
}

async function openLeaf(item, st) {
  const { id } = item
  for (let attempt = 1; ; attempt++) {
    const tier = st.role ? producerTier(item.row, st.raise) : COURIER
    const opened = await boundary('leaf-open', { node: id, role: st.role, round: st.round, tier: tier.model + '/' + tier.effort },
      { phase: 'Execute', label: 'open:' + id + '#' + st.round + (attempt > 1 ? '@' + attempt : '') })
    noteStops(opened)
    if (opened.status === 'opened') {
      // The lib decides whom a round of a cycle's later member is for, from its records: a test gap
      // in an audit or a green goes to a test-author. roleOf only names the first.
      if (opened.role) st.role = opened.role
      st.worktree = opened.worktree
      st.branch = opened.branch
      st.brief = opened.brief_path
      st.report = opened.report_path
      st.base = opened.base_sha
      if (!st.head) st.head = opened.head_sha || opened.base_sha
      return opened
    }
    if (opened.status === 'locus_held') {
      // Its files free when their holder merges. The scheduler reads the same lock, so the leaf
      // is launched again only then: nothing is dispatched to wait.
      const holder = (opened.held_by || [])[0] || {}
      note(id + ': its files are held by ' + (holder.node || 'another leaf') + (holder.status ? ' (' + holder.status + ')' : '') + ', which has not merged')
      return null
    }
    if (opened.status === 'no_slot' || opened.status === 'busy') {
      log('open:' + id + ': ' + opened.status + ' — asking again')
      continue
    }
    if (!((opened.stops || []).length)) hold(id, 'program')
    return null
  }
}

/** Close the round: leaf-close reads the executor's status, measures, decides and records. */
async function closeLeaf(id, st, close) {
  let tokens = close.tokens
  for (;;) {
    const closed = await settled('leaf-close', {
      node: id, role: st.role, round: st.round, mode: close.mode, status: close.status, said: close.said,
      head_before: st.head, base_sha: st.base, dispatch: tokens,
    }, { phase: 'Execute', label: 'close:' + id + '#' + st.round })
    if (closed.decision && closed.decision.next === 'command_unknown' && !st.commandsTried) {
      st.commandsTried = true
      tokens = [...close.tokens, ...(await establishCommands(st.worktree))]
      continue
    }
    return closed
  }
}

/**
 * One leaf, from wherever resume says it stands, to approval, escalation or a park. `item` is its
 * launch: its card, its row and its resume facts. Every exit — the measurement's, the review
 * loop's — is computed and recorded by the boundary that closes the round.
 */
async function runLeaf(item, entry) {
  const { id, row } = item
  const facts = item.facts || {}
  const done = facts.rounds || 0
  let stage = entry && entry.stage ? entry.stage : ({
    code: 'code', 'continue-series': 'continue', verify: 'close', review: 'review', merge: 'approve',
  })[facts.next_action || 'code'] || 'code'
  const st = {
    // A salvaged series is closed and reviewed at the round that produced it; anything new is the
    // next round, so its brief, report and dispatch never overwrite an earlier one's.
    role: roleOf(row), round: ['close', 'review', 'approve'].includes(stage) && done ? done : done + 1,
    reviewRounds: 0, raise: false, said: '',
    base: facts.base_sha || '', head: facts.head_sha || '', deltaBase: '',
    salvaged: false, worktree: facts.worktree || '', branch: facts.branch || '', brief: facts.brief_path || '',
    report: '', lastReview: '', inReview: false, commandsTried: false,
  }
  if (['close', 'review', 'approve', 'continue'].includes(stage) && facts.head_sha) st.salvaged = true
  if (st.salvaged) note(id + ': salvaged from an earlier invocation at ' + (facts.next_action || stage))
  let close = { status: 'done', said: '', mode: 'resume', tokens: [] }

  for (;;) {
    if (stage === 'approve') {
      approve(item, st)
      return null
    }

    if (stage === 'code' || stage === 'continue' || stage === 'fix') {
      const mode = stage === 'code' ? 'fresh' : stage
      const opened = await openLeaf(item, st)
      if (!opened) return
      close = { status: '', said: '', mode, tokens: [] }
      if (st.role) {
        const label = st.role + ':' + id + '#' + st.round
        st.said = saidPath(label, 'md')
        const opts = { agentType: EXECUTOR_TYPE[st.role], schema: EXECUTOR, phase: 'Execute', label, ...producerTier(row, st.raise) }
        const res = await dispatch(executorPrompt(item, st, opened, mode), opts).catch(() => null)
        close = { status: res ? res.status : '', said: st.said, mode, tokens: [tokenOf(opts)] }
      }
      stage = 'close'
    }

    if (stage === 'close') {
      const closed = await closeLeaf(id, st, close)
      if (refusedOn(id, closed)) return
      if (closed.head_sha) {
        if (st.inReview && closed.head_sha !== st.head) st.deltaBase = st.head
        st.head = closed.head_sha
      }
      if (closed.report_path) st.report = closed.report_path
      const next = closed.decision.next
      if (next === 'approve' || next === 'review') {
        stage = next
        continue
      }
      if (next === 'replan') {
        note(id + ': ' + close.status + ' — replanning its subtree')
        await planNode(item, close.status, close.said)
        return null
      }
      if (next === 'finding' && closed.replan) {
        note(id + ': a verify leaf found its premise false — replanning ' + closed.replan.id)
        await planNode(closed.replan, 'verify_finding', closed.replan.said)
        return null
      }
      if (next === 'fix') {
        st.raise = st.raise || closed.raise === true
        st.round++
        stage = 'fix'
        continue
      }
      return null
    }

    if (stage === 'review') {
      st.inReview = true
      st.reviewRounds++
      const round = st.reviewRounds
      const label = 'review:' + id + '#' + round
      const file = saidPath(label, 'json')
      const opts = { agentType: 'agentics:reviewer', schema: WROTE, phase: 'Execute', label, ...reviewerTier(row) }
      const res = await dispatch(reviewerPrompt(item, st, round, file), opts).catch(() => null)
      if (res && res.status !== 'written') note(label + ': the reviewer says it wrote no review')
      const out = await boundary('leaf-review', { node: id, round: st.round, review_round: round, review_file: file, dispatch: [tokenOf(opts)] },
        { phase: 'Execute', label: 'reviewed:' + id + '#' + round })
      if (refusedOn(id, out)) return
      if (out.record) st.lastReview = out.record
      if (out.decision.next === 'approve') {
        stage = 'approve'
        continue
      }
      if (out.decision.next === 'fix') {
        st.raise = st.raise || out.raise === true
        st.round++
        stage = 'fix'
        continue
      }
      return null
    }
  }
}

/** The leaf is approved on disk — by the boundary that closed its last round, or before this invocation. */
function approve(item, st) {
  if (stoppedHere.has(item.id)) return
  const was = implemented.findIndex((i) => i.id === item.id)
  if (was !== -1) implemented.splice(was, 1)
  implemented.push({
    id: item.id, rigor: item.row.rigor, role: item.row.role, rounds: st.round, review_rounds: st.reviewRounds,
    at_integration: st.reviewRounds === 0 && !item.row.own_review, salvaged: st.salvaged,
  })
  leavesFinished++
}

// ---------------------------------------------------------------- merging

async function mergeInto(item) {
  const { target } = item
  const out = await settled('merge-batch', { target, card: item.card }, { phase: 'Integrate', label: 'merge:' + target })
  if (refusedOn(target, out)) return
  const toRule = []
  for (const d of out.drift || []) {
    drift.push({ node: d.node, contract: d.contract })
    if (d.stopped) note(d.node + ' (' + d.stopped + ') consumes contract ' + d.contract + ', which merged work touched')
    else if (!stoppedHere.has(d.node)) toRule.push(d.node)
  }
  const nodes = [...new Set(toRule)]
  if (nodes.length) {
    // A consumer stays unlaunched until its ruling is answered: replanned, or parked for the user.
    for (const id of nodes) ruling.add(id)
    try {
      const replans = await rule('drift', 'rule:drift:' + target, driftPrompt(target, nodes, out.drift_brief), 'Integrate', out.record)
      await Promise.all(replans.map(replanAffected))
    } finally {
      for (const id of nodes) ruling.delete(id)
    }
  }
  if (out.unexamined_n) note(out.unexamined_n + ' undesigned node(s) not examined for drift')
  for (const f of out.failed_alone || []) {
    note(f.id + ': fails on the integration head alone — a fix round on its branch, brought up to that head')
    if (running.has('leaf:' + f.id)) continue
    launch('leaf:' + f.id, () => runLeaf({ unit: 'leaf', ...f }, { stage: 'fix' }))
  }
  if (input.pause && !stopping) stopping = 'pause'
  if (budgetShort() && !stopping) stopping = 'budget'
}

const budgetShort = () => {
  if (!budget || !budget.total || leavesFinished === 0) return false
  const perLeaf = budget.spent() / leavesFinished
  return budget.remaining() < perLeaf
}

// ---------------------------------------------------------------- composites

/**
 * A finished composite: the full suite on its head (suite-gate, which also records a review that
 * is not earned), then its integration review, read and recorded by folder-review. A review that
 * wrote nothing is a plugin fault on the folder, and a lost check.
 */
async function reviewComposite(item) {
  const { id } = item
  const gate = await settled('suite-gate', { target: id }, { phase: 'Integrate', label: 'gate:' + id })
  if (refusedOn(id, gate) || !gate.passed) return
  if (gate.review !== 'earned') {
    note(id + ': integration review not earned')
    return null
  }
  const label = 'review:integration:' + id
  const file = saidPath(label, 'json')
  const opts = { agentType: 'agentics:reviewer', schema: WROTE, phase: 'Integrate', label, ...tierFor(JUDGE, 'high') }
  const res = await dispatch(integrationPrompt(item, file), opts).catch((err) => {
    note('integration review of ' + id + ' failed: ' + (err && err.message))
    return null
  })
  if (res && res.status !== 'written') note(label + ': the reviewer says it wrote no review')
  const out = await boundary('folder-review', { target: id, card: item.card, review_file: file, dispatch: [tokenOf(opts)] },
    { phase: 'Integrate', label: 'reviewed:integration:' + id })
  if (refusedOn(id, out)) return
  const recorded = out.status === 'recorded'
  if (!recorded) failedChannels.push('integration-review')
  reviews.push({ target: id, review_file: recorded ? file : '', reviewed: recorded })
}

// ---------------------------------------------------------------- result

const RUN_ID = 'unknown-to-script: pair `remaining` with the runId from the Workflow launch result'

const NO_SUMMARY = { nodes_n: 0, leaves_n: 0, merged_n: 0, not_merged_n: 0, blocked_n: 0, blocked: [], root_done: false, done: false, stopped: [], held: [] }

/** The return: postflight's summary of the subtree on disk, and what this invocation was told back. */
function result(checkpoint, post, postflight = '') {
  const s = (post && post.summary) || NO_SUMMARY
  // Stopped nodes this invocation did not stop itself are carried from an earlier one: they lead
  // the result as much as fresh ones, or a resume reads cleaner than the run it resumed.
  for (const x of s.stopped) {
    if (stoppedHere.has(x.id)) continue
    if (x.status === 'escalated') escalations.push({ id: x.id, reason: x.reason || 'escalated', said: '', carried: true })
    if (x.status === 'parked') parked.push({ id: x.id, return: x.reason || 'parked', said: '', carried: true })
  }
  const blocked = s.blocked
  const unreached = []
    .concat(s.held.map((h) => h.id + ': held — its cycle member ' + h.behind + ' stopped, and a cycle lands as a unit'))
    .concat(escalations.filter((e) => e.carried).map((e) => e.id + ': escalated earlier — ' + e.reason))
    .concat(parked.filter((p) => p.carried).map((p) => p.id + ': parked earlier — ' + p.return))
    .concat(escalations.filter((e) => !e.carried).map((e) => e.id + ': escalated — ' + e.reason))
    .concat(parked.filter((p) => !p.carried).map((p) => p.id + ': parked — ' + p.return))
    .concat(faults.map((f) => f.id + ': held on a plugin fault (' + f.channel + ') — relaunch to retry'))
    .concat(blocked.map((b) => b.leaves_n + ' leaf/leaves blocked — ' + b.blocked_by + ' did not land'))
    .concat(s.not_merged_n > 0 ? [s.not_merged_n + ' of ' + s.leaves_n + ' leaves not merged in this invocation' + (stopping ? ' (' + stopping + ')' : '')] : [])
    .concat(checkpoint ? ['checkpoint ' + checkpoint.reason + ': nothing was dispatched'] : [])
    .concat([...new Set(failedChannels)].map((c) => 'the ' + c + ' channel failed in this invocation'))
  // A lost review is a lost check: the leaves it was owed to were verified and never read.
  const lostReview = failedChannels.includes('integration-review') || failedChannels.includes('survey')
  const integration = (post && post.integration) || { branch: '', head_sha: '' }
  return {
    effort, root: rootId, execution, checkpoint: checkpoint || null,
    nodes_n: s.nodes_n,
    implemented, escalations, parked, faults, blocked,
    integration: { branch: integration.branch, head_sha: integration.head_sha, reviews },
    drift, cleanup_n: (post && post.cleanup_n) || 0,
    cost: { dispatches, by_model: byModel, tokens: budget && budget.total ? budget.spent() : null },
    stopped: stopping || '',
    notes,
    coverage: {
      complete: !checkpoint && Boolean(post) && s.not_merged_n === 0 && s.root_done && escalations.length === 0 && parked.length === 0 && faults.length === 0 && !lostReview,
      dropped: [],
      incomplete: [],
      failed_channels: [...new Set(failedChannels)],
      unreached,
      resumable: {
        runId: RUN_ID,
        remaining: s.done ? [] : [rootId],
        args: { effort, root: rootId, execution },
        ...(postflight ? { postflight } : {}),
      },
    },
  }
}

/**
 * Close the invocation: postflight records the faults only this script saw and summarizes the
 * subtree from disk. When no courier can carry it, the session is handed the command itself — all
 * handles — to run in its own shell.
 */
async function finish(checkpoint) {
  const last = { fault: faultTokens() }
  let why = ''
  try {
    const post = await boundary('postflight', last, { phase: 'Postflight', label: 'postflight' })
    noteStops(post)
    if (!post.error) return result(checkpoint, post)
    why = post.error.kind
  } catch (err) {
    why = err && err.message
  }
  failedChannels.push('postflight')
  note('postflight could not be carried: ' + why + ' — this invocation is not closed until the session runs coverage.resumable.postflight')
  return result(checkpoint, null, tripOf('postflight', last))
}

// ---------------------------------------------------------------- the run

if (!effort || !execution) {
  return result({ reason: 'bad_input', detail: 'effort and execution (a UTC stamp minted by the session) are required' }, null)
}
// docs/DESIGN.md#execution: a relative repo resolves in whatever directory each courier's shell stands.
if (!/^([A-Za-z]:)?\//.test(repo)) {
  return result({ reason: 'bad_input', detail: 'repo must be the repository\'s absolute path, not ' + JSON.stringify(repo) }, null)
}

phase('Preflight')
let pf
try {
  pf = await boundary('preflight', {
    root: rootId,
    retry: input.retry_escalated || [],
    confirmed_duplicate: input.confirmed_duplicate === true,
    confirmed_gaps: input.confirmed_gaps === true,
    plan_only: input.plan_only === true,
    dial: DIAL, pace, base_ref: input.base_ref || '', commands_file: input.commands_file || '',
  }, { phase: 'Preflight', label: 'preflight' })
} catch (err) {
  failedChannels.push('preflight')
  note('preflight could not be carried: ' + (err && err.message))
  return result({ reason: 'preflight_failed', detail: String(err && err.message) }, null)
}

if (pf.error) {
  note('preflight refused: ' + pf.error.kind)
  return result({ reason: pf.error.kind || 'preflight_refused', detail: pf.root ? 'execution ' + execution + ' is rooted at ' + pf.root : '' }, null)
}
invocation = pf.invocation
saidDir = pf.said_dir || ''
for (const d of pf.dirty_worktrees || []) note('dirty worktree left in place (never forced): ' + d)
const counts = pf.counts || {}
if (counts.gaps) note(counts.gaps + ' traceability gap(s): node "' + pluginRoot + '/lib/status.mjs" checkpoint lists them when they stop a run')
if (counts.untraced) note(counts.untraced + ' criterion/criteria tracing to no decision')
if (pf.checkpoint) {
  phase('Postflight')
  return finish({ reason: pf.checkpoint.reason, detail: '' })
}

// The base branch moved under leaves not yet merged: a ruler rules each before anything runs, the
// planner replans a leaf whose premise really moved, and only what it cannot settle waits for the user.
if (pf.stale) {
  try {
    const replans = await rule('stale', 'rule:stale', stalePrompt(pf.stale), 'Preflight', pf.stale.record)
    await Promise.all(replans.map(replanAffected))
  } catch (err) {
    // No ruling reached disk: each leaf is held, and the next invocation rules on it again.
    failedChannels.push('transport')
    note('the rulings on a moved base could not be recorded: ' + (err && err.message))
    for (const id of pf.stale.nodes) hold(id, 'transport')
  }
}

log('execution ' + execution + ' of ' + rootId + ': ' + (counts.leaves || 0) + ' leaves planned, pool ' + pf.max_parallel +
  ', dial ' + DIAL + ', pace ' + pace)

const UNITS = {
  plan: (item) => planNode(item, item.why, ''),
  leaf: (item) => runLeaf(item),
  merge: (item) => mergeInto(item),
  review: (item) => reviewComposite(item),
}

/**
 * A launch computed from what disk said when the tick was built, re-checked against what this
 * invocation was told while the tick was in flight: a node stopped, a folder it began replanning.
 */
const stillLaunchable = (item) => {
  const id = item.id || item.target
  if (stoppedHere.has(id) || ruling.has(id) || (item.waits_on || []).some((d) => stoppedHere.has(d))) return false
  return ![...planning].some((p) => p === id || p === '.' || id.startsWith(p + '/'))
}

phase('Execute')
for (;;) {
  // A unit leaves `running` only once the tick being built has seen what it recorded; one that ends
  // while this tick is in flight stays in `running`, so nothing is launched beneath it or twice,
  // and it wakes the loop at once for the next tick.
  for (const key of finished) running.delete(key)
  finished.clear()
  let tick
  // A stop the schedule launches anyway was answered on disk while the run went on — a re-spec
  // or a session's retry.
  const carriedStops = new Set(stoppedHere)
  try {
    ticks++
    tick = await boundary('schedule', {
      running: [...running.keys()], planning: [...planning], stopping: Boolean(stopping), fault: faultTokens(),
    }, { phase: 'Execute', label: 'schedule#' + ticks })
  } catch (err) {
    tick = { error: { kind: String(err && err.message) } }
  }
  if (tick.error) {
    failedChannels.push('schedule')
    note('the schedule could not be carried: ' + tick.error.kind + ' — starting nothing new, letting what runs finish')
    await Promise.allSettled([...running.values()])
    break
  }
  noteStops(tick)
  for (const item of tick.launch || []) {
    const id = item.id || item.target
    if (carriedStops.has(id) && !faults.some((f) => f.id === id)) answered(id)
    const key = item.unit + ':' + id
    if (!running.has(key) && stillLaunchable(item)) launch(key, () => UNITS[item.unit](item))
  }
  if (running.size === 0) break
  await Promise.race(running.values())
}

if (stopping) note('stopped starting new leaves after a merge-batch: ' + stopping)

phase('Postflight')
return finish(null)
