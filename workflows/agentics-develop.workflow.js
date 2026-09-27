export const meta = {
  name: 'agentics-develop',
  description: 'Execute a subtree of an agentics effort: plan unplanned composites, run every leaf by its rigor in its own worktree, review, and merge by composite into framework-owned integration branches — scheduled by readiness, never by waves. Never touches the user\'s branch or working tree.',
  phases: [
    { title: 'Preflight', detail: 'refuse overlaps, resume ladder, drift, gaps, todos — one courier' },
    { title: 'Plan', detail: 'planner per unplanned composite; a survey first where the ground is unknown' },
    { title: 'Execute', detail: 'per leaf: leaf-open, executor by rigor, leaf-close, fix rounds, review loop' },
    { title: 'Integrate', detail: 'merge-batch per composite, integration review, merge up' },
    { title: 'Postflight', detail: 'records, cleanup report' },
  ],
}

// Design: docs/DESIGN.md#execution. Every deterministic step is a `lib/boundary.mjs` entry point
// run by a courier and re-digested here; this script holds only what a script can hold without a
// filesystem: which leaves are ready, in what order, and what each typed return means next.
//
// Schemas carry no bounds and no verdict booleans (lint: no-schema-bounds, no-self-verdict).
// Every verdict below is computed: a measurement's by lib/verdict.mjs on disk, a review round's
// here from the findings, a merge's from the merge-result contract.

const input = args && typeof args === 'object' ? args : {}

const posix = (p) => String(p == null ? '' : p).split('\\').join('/')
const repo = posix(String(input.repo || input.roots || '.').split(/[,;\n]/)[0].trim() || '.')
const effort = String(input.effort || '').trim()
const rootId = String(input.root || '.').trim() || '.'
const execution = String(input.execution || '').trim()
const progress = input.progress !== false
const pace = ['frugal', 'balanced', 'fast'].includes(input.pace) ? input.pace : 'balanced'
const pluginRoot = posix(String(input.plugin_root || '$CLAUDE_PLUGIN_ROOT').trim())

// ---------------------------------------------------------------- digests and transport
//
// Written out here because a workflow script has no imports: these must stay identical to
// `canonical` and `fnv1a` in lib/plan-digest.mjs — the scenario harness mints every envelope with
// the lib copies, so a drift fails every scenario in test/agentics-develop-scenarios.test.mjs.

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

function utf8Bytes(text) {
  const out = []
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00)
        i++
      }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64: one opaque argv slot, nothing in it for a shell to interpret. */
function base64(text) {
  const bytes = utf8Bytes(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4)]
    out += b1 < 0 ? '=' : B64[((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6)]
    out += b2 < 0 ? '=' : B64[b2 & 63]
  }
  return out
}

// ---------------------------------------------------------------- schemas

const CARRIED = {
  type: 'object', additionalProperties: false,
  required: ['stop_reason', 'payload_raw', 'task_ids', 'task_tools', 'notes'],
  properties: {
    stop_reason: { type: 'string', enum: ['carried', 'failed'] },
    payload_raw: { type: 'string' },
    task_ids: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['key', 'id'], properties: { key: { type: 'string' }, id: { type: 'string' } } },
    },
    task_tools: { type: 'string', enum: ['used', 'unavailable', 'skipped'] },
    notes: { type: 'string' },
  },
}

const EXECUTOR_STATUSES = ['done', 'done_with_concerns', 'blocked', 'needs_context',
  'decompose', 'unsplittable', 'premise_mismatch', 'needs_decision', 'contract_changed']

const EXECUTOR_TYPE = {
  implementer: 'agentics:implementer',
  'test-author': 'agentics:test-author',
  auditor: 'agentics:auditor',
}

const EXECUTOR = {
  type: 'object', additionalProperties: false,
  required: ['status', 'detail', 'concerns', 'commits'],
  properties: {
    status: { type: 'string', enum: EXECUTOR_STATUSES },
    detail: { type: 'string' },
    concerns: { type: 'array', items: { type: 'string' } },
    commits: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['sha', 'subject'], properties: { sha: { type: 'string' }, subject: { type: 'string' } } },
    },
  },
}

const FINDINGS = {
  type: 'object', additionalProperties: false,
  required: ['findings', 'fix_verdicts', 'claims', 'notes'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'severity', 'claim', 'evidence', 'failure_scenario'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          failure_scenario: { type: 'string' },
        },
      },
    },
    fix_verdicts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'status', 'evidence'],
        properties: { id: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'not_fixed', 'regressed'] }, evidence: { type: 'string' } },
      },
    },
    claims: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['claim', 'verdict', 'evidence'],
        properties: {
          claim: { type: 'string' },
          verdict: { type: 'string', enum: ['met', 'under', 'over', 'deviates', 'spec_defect', 'cant_tell'] },
          evidence: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

const PLANNED = {
  type: 'object', additionalProperties: false,
  required: ['status', 'written', 'accepted_warnings', 'uncovered', 'question', 'detail'],
  properties: {
    status: { type: 'string', enum: ['written', 'needs_decision', 'contract_changed', 'premise_mismatch', 'unsplittable', 'blocked'] },
    written: { type: 'array', items: { type: 'string' } },
    accepted_warnings: { type: 'array', items: { type: 'string' } },
    uncovered: { type: 'array', items: { type: 'string' } },
    question: { type: 'string' },
    detail: { type: 'string' },
  },
}

const SETTLED = {
  type: 'object', additionalProperties: false,
  required: ['status', 'dispositions', 'question', 'detail'],
  properties: {
    status: { type: 'string', enum: ['settled', 'needs_decision', 'blocked'] },
    dispositions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['finding', 'outcome'],
        properties: { finding: { type: 'string' }, outcome: { type: 'string', enum: ['incorporated', 'discarded'] } },
      },
    },
    question: { type: 'string' },
    detail: { type: 'string' },
  },
}

const ESTABLISHED = {
  type: 'object', additionalProperties: false,
  required: ['commands', 'unresolved', 'notes'],
  properties: {
    commands: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'value', 'absent', 'exit_status'],
        properties: { name: { type: 'string' }, value: { type: 'string' }, absent: { type: 'boolean' }, exit_status: { type: 'integer' } },
      },
    },
    unresolved: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
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

const isYardstick = (row) => row.role === 'red' || row.role === 'audit' || (row.provides || []).length > 0

/**
 * The producer's tier. The author's `dispatch.producer` wins; otherwise sonnet, or opus for a
 * yardstick — under the dial's ceiling. A fix round that failed to clear its blockers raises the
 * producer one step, and that one step may exceed the ceiling.
 */
function producerTier(row, raised) {
  const set = (row.dispatch && row.dispatch.producer) || {}
  let model = set.model || lowerOf(isYardstick(row) ? 'opus' : 'sonnet', JUDGE)
  let tier = set.effort ? { model, effort: set.effort } : tierFor(model, 'medium')
  if (raised) {
    tier = model === 'sonnet' ? tierFor('opus', 'medium') : { model, effort: EFFORT_UP[tier.effort] || 'high' }
    model = tier.model
  }
  return tier
}

const reviewerTier = (row) => {
  const set = (row && row.dispatch && row.dispatch.reviewer) || {}
  return set.model ? { model: set.model, effort: set.effort || tierFor(set.model, 'high').effort } : tierFor(JUDGE, 'high')
}

const COURIER = { model: 'haiku', effort: 'low' }
const COURIER_UP = { model: 'sonnet', effort: 'low' }

// ---------------------------------------------------------------- state

const rows = new Map()          // node id -> preflight row
const leafFacts = new Map()     // leaf id -> resume row
const status = new Map()        // node id -> derived status, kept current here
const taskIds = {}              // todo key -> task id
const records = []              // workflow decisions waiting for the next boundary to append them
const failedChannels = []
const notes = []
const implemented = []
const escalations = []
const parked = []
const reviews = []
const drift = []
const integ = new Map()         // composite id -> {worktree, base, head, branch}
const heads = new Map()         // leaf id -> the head it was approved at
const lockedBy = new Map()      // leaf id -> the stopped leaf holding its files
const rounds = new Map()        // leaf id -> the highest round dispatched, across every chain
const composite = new Map()     // composite id -> 'open' | 'reviewing' | 'ripe' | 'merging' | 'held'
let maxParallel = 4
let cleanup = []
let dispatches = 0
const byModel = {}
let leavesFinished = 0
let mergedSinceStart = 0
let stopping = ''
let commands = null
let taskToolsMissing = false

const note = (text) => {
  notes.push(text)
  log(text)
}

const isLeaf = (id) => rows.has(id) && rows.get(id).kind === 'leaf'
const parentOf = (id) => (id === '.' ? null : id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '.')
const ancestorsOf = (id) => {
  const out = []
  for (let p = parentOf(id); p !== null; p = parentOf(p)) out.push(p)
  return out
}
const inScope = (id) => id === rootId || ancestorsOf(id).includes(rootId)
const childrenOf = (id) => [...rows.keys()].filter((k) => k !== '.' && parentOf(k) === id).sort()
const statusOf = (id) => status.get(id) || 'planned'
/** A leaf's dependencies and every in-scope ancestor's: a composite's deps bind all beneath it. */
const depsOf = (id) => [...new Set([id, ...ancestorsOf(id)].flatMap((a) => (rows.get(a) || {}).deps || []))]

const LOCAL_TERMINAL = new Set(['approved', 'escalated', 'parked', 'merged'])

function absorbTree(payload) {
  for (const row of payload.nodes || []) {
    const before = rows.get(row.id)
    const local = status.get(row.id)
    rows.set(row.id, row)
    // A decision this invocation took may still be queued for the next boundary, so disk can lag
    // it; disk wins only where the node itself was revised since (a replan or an answer).
    const revised = !before || before.rev !== row.rev
    if (revised || !LOCAL_TERMINAL.has(local)) status.set(row.id, row.status)
  }
  for (const leaf of payload.leaves || []) {
    leafFacts.set(leaf.id, leaf)
    // A resumed merge merges the head that was approved, never the branch as it stands now.
    if (leaf.approved_head && !heads.has(leaf.id)) heads.set(leaf.id, leaf.approved_head)
    if (Number.isInteger(leaf.rounds)) rounds.set(leaf.id, Math.max(rounds.get(leaf.id) || 0, leaf.rounds))
  }
  for (const row of payload.nodes || []) {
    if (row.kind !== 'leaf' && row.integration && row.integration.branch) integ.set(row.id, row.integration)
  }
  if (Number.isInteger(payload.max_parallel) && payload.max_parallel > 0) maxParallel = payload.max_parallel
  if (payload.commands) commands = payload.commands
}

// ---------------------------------------------------------------- dispatch with a cost line

/** Every agent dispatch goes through here, so the cost report is measured, not projected. */
async function dispatch(prompt, opts, node) {
  dispatches++
  byModel[opts.model || 'inherit'] = (byModel[opts.model || 'inherit'] || 0) + 1
  records.push({
    file: 'state',
    entry: { kind: 'dispatch', label: opts.label || '', node: node || '', role: (opts.agentType || '').replace('agentics:', ''), model: opts.model || '', effort: opts.effort || '', tokens: null },
  })
  return agent(prompt, opts)
}

// ---------------------------------------------------------------- boundaries

class TransportError extends Error {}

/** What a courier carried back: the payload, or why it cannot be believed and whether to retry. */
function carried(held) {
  if (!held) return { payload: null, why: 'the dispatch returned nothing', retry: 'again' }
  if (held.stop_reason !== 'carried') return { payload: null, why: held.notes || 'the courier could not run the command', retry: 'again' }
  let parsed
  try {
    parsed = JSON.parse(held.payload_raw)
  } catch (e) {
    return { payload: null, why: 'the payload did not survive transcription: ' + (e && e.message), retry: 'stronger' }
  }
  if (parsed && parsed.error) return { payload: null, why: 'the program failed: ' + parsed.error, retry: '' }
  if (!parsed || !parsed.payload || typeof parsed.payload_digest !== 'string') {
    return { payload: null, why: 'what came back is not a digest-covered envelope', retry: 'stronger' }
  }
  const actual = fnv1a(canonical(parsed.payload))
  if (actual !== parsed.payload_digest) {
    return { payload: null, why: 'digest mismatch: computed as ' + parsed.payload_digest + ', arrived as ' + actual, retry: 'stronger' }
  }
  return { payload: parsed.payload, why: '', retry: '' }
}

function courierPrompt(command) {
  return 'Run exactly this one command, unchanged (Bash timeout 600000), and put its entire stdout in payload_raw:\n\n' +
    command + '\n\n' +
    (progress
      ? 'Then apply the todo moves listed in the printed payload.todos (create → TaskCreate, update → ' +
        'TaskUpdate on task_id) and return each created task id as {key, id}. Without task tools, set ' +
        'task_tools to "unavailable".'
      : 'Progress is off: move no todos and set task_tools to "skipped".') +
    (pluginRoot === '$CLAUDE_PLUGIN_ROOT'
      ? '\nIf $CLAUDE_PLUGIN_ROOT is empty in your shell, do not guess a path: set stop_reason "failed" and say so.'
      : '')
}

/**
 * Run one boundary entry point through a courier and believe its payload only after the digest.
 *
 * Retries are sized to what was observed: a courier that returned nothing or could not run the
 * command is re-run (every entry point is idempotent); a payload damaged in transit buys one
 * refetch on a stronger model; a program failure is not retried. What stays unbelievable is a
 * transport failure, thrown for the caller to escalate.
 */
async function boundary(name, a, ctx) {
  const pending = records.splice(0, records.length)
  const argsObject = { ...a, records: pending, task_ids: taskIds, progress }
  const token = base64(JSON.stringify(argsObject))
  const command = 'node "' + pluginRoot + '/lib/boundary.mjs" ' + name + ' --repo "' + repo +
    '" --effort "' + effort + '" --execution "' + execution + '" --digest ' + fnv1a(canonical(argsObject)) +
    ' --b64 ' + token

  const plan = [COURIER]
  let why = ''
  for (let i = 0; i < plan.length; i++) {
    let held = null
    try {
      held = await dispatch(courierPrompt(command), {
        agentType: 'agentics:courier', schema: CARRIED, phase: ctx.phase,
        label: ctx.label + (i ? '#' + (i + 1) : ''), ...plan[i],
      }, a.node || a.target || '')
    } catch (err) {
      held = null
      why = 'the courier threw: ' + (err && err.message)
    }
    const c = carried(held)
    if (c.payload) {
      for (const t of (held.task_ids || [])) if (t && t.key) taskIds[t.key] = t.id
      if (progress && held.task_tools === 'unavailable' && !taskToolsMissing) {
        taskToolsMissing = true
        note('the couriers had no task tools: the todo list did not move — derive it with lib/status.mjs todos')
      }
      if (c.payload.error && c.payload.error.kind === 'digest_mismatch' && i === 0) {
        // The argument token was damaged on its way in; the program wrote nothing.
        why = c.payload.error.message
        plan.push(COURIER)
        continue
      }
      return c.payload
    }
    why = c.why || why
    if (c.retry === 'again' && plan.length < 2) plan.push(COURIER)
    else if (c.retry === 'stronger' && !plan.includes(COURIER_UP)) plan.push(COURIER_UP)
  }
  records.unshift(...pending)
  throw new TransportError(name + ': ' + why)
}

/** A boundary whose long checks run detached: re-dispatch while it reports them pending. */
async function settled(name, a, ctx) {
  let payload = await boundary(name, a, ctx)
  while (payload && payload.status === 'pending') {
    log(ctx.label + ': checks still running detached — re-dispatching to collect them')
    payload = await boundary(name, a, ctx)
  }
  return payload
}

// ---------------------------------------------------------------- prompts

const listOf = (items) => (items && items.length ? items.map((x) => '- ' + x).join('\n') : '(none)')

function executorPrompt(id, role, round, opened, mode) {
  const row = rows.get(id)
  const fetch = role === 'implementer'
    ? 'Fetch it: node "' + pluginRoot + '/lib/brief.mjs" fetch --path "' + opened.brief_path + '" --digest ' + opened.brief_digest
    : 'Read it with your Read tool (the leaf-close script re-checks its digest, ' + opened.brief_digest + ').'
  const finish = role === 'implementer'
    ? '\n\nAfter your last commit, record that the series is finished:\n' +
      'node "' + pluginRoot + '/lib/ledger.mjs" append --repo "' + repo + '" --effort "' + effort +
      '" --file journal:' + execution + " --stdin <<'AGENTICS_EOF'\n" +
      JSON.stringify({ kind: 'series-done', node: id, branch: opened.branch, head_sha: '<git rev-parse HEAD>', commits: [{ sha: '<sha>', subject: '<subject>' }] }) +
      '\nAGENTICS_EOF\n(fill in the head and every commit of your series; run it once).'
    : ''
  const modeText = mode === 'continue'
    ? 'The branch already carries commits of this leaf from an interrupted dispatch: continue the series, do not rebuild it.\n'
    : mode === 'fix'
      ? 'This is fix round ' + round + ': the brief lists the failures and findings to address, as new commits.\n'
      : ''
  return 'You are the ' + role + ' for leaf ' + id + ' ("' + row.title + '"), round ' + round + ', rigor ' + row.rigor +
    (row.role !== 'none' ? ', role ' + row.role : '') + '.\n' + modeText +
    'Worktree: ' + opened.worktree + ' (branch ' + opened.branch + ', base ' + opened.base_sha + ').\n' +
    'Brief: ' + opened.brief_path + '. ' + fetch + '\n' +
    'Report file: ' + opened.report_path + '.' + finish +
    '\n\nReturn status, detail (what you established, tried and need, for any status but done), concerns and commits.'
}

function reviewerPrompt(id, st, round, prior) {
  const row = rows.get(id)
  const span = round === 1 ? st.base + '..' + st.head : st.deltaBase + '..' + st.head
  return 'Adversarially review leaf ' + id + ' ("' + row.title + '"), round ' + round + '. You are fresh: nothing ' +
    'from earlier rounds reaches you but the artifacts below.\n' +
    'Worktree: ' + st.worktree + ' (branch ' + st.branch + '). Span under review: ' + span +
    (round === 1 ? ' — the whole series.' : ' — the fix commits since the last round only; a critical you see outside it is still reported.') + '\n' +
    (st.brief
      ? 'Brief (criteria, locus, decisions, contracts): read ' + st.brief + '.\n'
      : 'Criteria, locus, decisions and contracts: node "' + pluginRoot + '/lib/tree.mjs" show --repo "' + repo +
        '" --effort "' + effort + '" --root "' + id + '" --json\n') +
    (row.provides && row.provides.length ? 'This leaf PROVIDES a contract: its majors with a failure scenario block like criticals.\n' : '') +
    (row.role === 'green' ? 'The tests were written by another agent before this code and sit outside this locus.\n' : '') +
    'The executor\'s concerns — attack these first:\n' + listOf(st.concerns) + '\n' +
    (prior.length
      ? 'Prior blockers — rule on each in fix_verdicts, and re-report under its id any you rule not_fixed or regressed:\n' +
        prior.map((f) => '- ' + f.id + ' [' + f.severity + '] ' + f.claim).join('\n') + '\n'
      : '') +
    'Return claims: [] — claim verdicts belong to integration reviews.\n'
}

function integrationPrompt(id, where, children, missing) {
  const row = rows.get(id)
  return 'Integration review of composite ' + id + ' ("' + row.title + '").\n' +
    'Worktree: ' + where.worktree + '. Merged diff: ' + where.base + '..' + where.head + '.\n' +
    'Yardstick: the folder\'s spec, ' + row.spec_path + '. Judge every claim it makes (each success criterion in its ' +
    'Intent, each statement of its Design, each criterion of its plan) and return one entry per claim in claims: ' +
    '{claim, verdict: met | under | over | deviates | spec_defect | cant_tell, evidence}. A HUMAN: criterion is the user\'s: leave it out.\n' +
    'Its decisions, and the criteria of every child, are in: node "' + pluginRoot + '/lib/tree.mjs" show --repo "' + repo +
    '" --effort "' + effort + '" --root "' + id + '" --json\n' +
    'Children merged here: ' + children.join(', ') + '.\n' +
    'Review these against their own criteria too — they had no review loop of their own:\n' +
    listOf(children.filter((c) => isLeaf(c) && !rows.get(c).own_review)) + '\n' +
    (missing.length
      ? 'Planned children that did NOT land: ' + missing.join(', ') + '. Reason about the gap out loud and carry that caveat on every finding.\n'
      : '') +
    'Look for defects that exist only with the children together, and for any decision no child realised.'
}

function plannerPrompt(id, why, evidence) {
  const row = rows.get(id)
  const check = 'node "' + pluginRoot + '/lib/spec.mjs" check --repo "' + repo + '" --effort "' + effort + '" --folder "' + id + '"'
  const charge = row.kind === 'leaf'
    ? 'Task ' + id + ' ("' + row.title + '") is promoted to a folder of its own. Write its spec: ' + row.spec_path +
      '. Its entries realise every decision the task realises (' + ((row.decisions || []).join(', ') || 'none') +
      ') and carry its criteria forward. Do not touch the spec that holds the task\'s entry.\n'
    : row.kind === 'design'
      ? 'Sub-effort ' + id + ' ("' + row.title + '") has author: planner. Write its spec: ' + row.spec_path + '.\n'
      : 'Folder ' + id + ' ("' + row.title + '") is yours (author: planner). Rewrite its spec in place: ' + row.spec_path + '.\n'
  return 'Plan folder ' + id + ' of effort ' + effort + ' (repository ' + repo + ').\n' + charge +
    (why ? 'Why: ' + why + '\n' : '') +
    'Read the tree: node "' + pluginRoot + '/lib/tree.mjs" show --repo "' + repo + '" --effort "' + effort + '" --json\n' +
    'Check the spec until it prints no problems: ' + check + '\n' +
    'Never write a Decisions row: a decision you need is a needs_decision return.\n' +
    (evidence ? '\nEvidence (a survey of this folder\'s ground):\n' + evidence + '\n' : '') +
    '\nReturn status written with the spec\'s path in written, or the user-bound need.'
}

function settlePrompt(id, path, findings, refused) {
  return 'Settle the autonomous review of folder ' + id + ' of effort ' + effort + ' (repository ' + repo + '). Its spec: ' + path + '.\n' +
    'Give every finding below one disposition: incorporated (you edited the spec\'s Design, Plan or Open questions because of it) ' +
    'or discarded. An ambiguity or a gap can only be incorporated; a note may be discarded. A finding whose fix would state or ' +
    'change a decision is not yours: return needs_decision with the question.\n' +
    'After editing, check the spec until it prints no problems: node "' + pluginRoot + '/lib/spec.mjs" check --repo "' + repo +
    '" --effort "' + effort + '" --folder "' + id + '"\n' +
    (refused.length ? 'Refused last time, settle these again: ' + refused.map((r) => r.why).join('; ') + '\n' : '') +
    '\nFindings:\n' + findings.map((f) => '- ' + f.id + ' [' + f.severity + ', ' + f.axis + ', ' + f.section + '] ' + f.claim + ' — ' + f.evidence).join('\n')
}

// ---------------------------------------------------------------- records

const recordEvent = (entry) => records.push({ file: 'events', entry: { execution, ...entry } })

function escalate(id, reason, detail) {
  status.set(id, 'escalated')
  escalations.push({ id, reason, detail: detail || '' })
  recordEvent({ kind: 'escalated', node: id, reason, detail: String(detail || '').slice(0, 2000) })
  note('escalated ' + id + ': ' + reason)
  leavesFinished++
}

function park(id, why, question) {
  status.set(id, 'parked')
  parked.push({ id, return: why, question: question || '' })
  recordEvent({ kind: 'parked', node: id, return: why, question: String(question || '').slice(0, 2000) })
  note('parked ' + id + ' (' + why + '): waiting on the user')
}

function approve(id, st, atIntegration) {
  // Parked while its chain was running (contract drift): the user rules first, and the approval
  // is not recorded — a resume re-derives it from the measurement once the park is cleared.
  if (statusOf(id) === 'parked') return
  status.set(id, 'approved')
  recordEvent({ kind: 'approved', node: id, head_sha: st.head, review_rounds: st.reviewRounds, at_integration: atIntegration })
  st.approvedHead = st.head
  const was = implemented.findIndex((i) => i.id === id)
  if (was !== -1) implemented.splice(was, 1)
  implemented.push({ id, rigor: rows.get(id).rigor, role: rows.get(id).role, rounds: st.round, review_rounds: st.reviewRounds, at_integration: atIntegration, salvaged: st.salvaged })
  heads.set(id, st.head)
  leavesFinished++
}

// ---------------------------------------------------------------- readiness

/** A leaf's cycle predecessor needs only approval: green is cut from red's branch. */
function cyclePredecessor(id, dep) {
  const a = rows.get(id)
  const d = rows.get(dep)
  return Boolean(a && d) && a.rigor === d.rigor &&
    ((a.role === 'green' && d.role === 'red') || (a.role === 'audit' && d.role === 'green'))
}

/**
 * Whether a dependency's output exists where this leaf will be cut: the dep (or its ancestor just
 * below the two nodes' lowest common ancestor) has merged into that ancestor's integration branch.
 */
function depReady(id, dep) {
  if (!rows.has(dep)) return false
  if (cyclePredecessor(id, dep)) return ['approved', 'merged'].includes(statusOf(dep))
  const up = [id, ...ancestorsOf(id)]
  const chain = [dep, ...ancestorsOf(dep)]
  const lca = up.find((x) => chain.includes(x))
  const at = chain.indexOf(lca)
  if (at <= 0) return true
  return statusOf(chain[at - 1]) === 'merged' || statusOf(chain[at - 1]) === 'landed'
}

/** The escalated or parked node a leaf is waiting behind, or ''. */
function blockedBy(id, seen = new Set()) {
  if (seen.has(id)) return ''
  seen.add(id)
  const row = rows.get(id)
  if (!row) return ''
  for (const dep of depsOf(id)) {
    const s = statusOf(dep)
    if (s === 'escalated' || s === 'parked') return dep
    const deeper = blockedBy(dep, seen)
    if (deeper) return deeper
  }
  return ''
}

const running = new Map()
const coupledInFlight = () => [...running.keys()].some((k) => k.startsWith('leaf:') && (rows.get(k.slice(5)) || {}).coupled)
const leavesInFlight = () => [...running.keys()].filter((k) => k.startsWith('leaf:')).length

function readyLeaves() {
  if (stopping) return []
  const out = []
  for (const [id, row] of rows) {
    if (row.kind !== 'leaf' || !inScope(id) || running.has('leaf:' + id)) continue
    const s = statusOf(id)
    if (s !== 'planned' && s !== 'active') continue
    if (planning.has(parentOf(id))) continue
    if (blockedBy(id) || lockedBy.has(id)) continue
    if (!depsOf(id).every((d) => depReady(id, d))) continue
    if (row.coupled && (coupledInFlight() || out.some((o) => rows.get(o).coupled))) continue
    out.push(id)
  }
  const room = Math.max(0, maxParallel - leavesInFlight())
  return out.slice(0, room)
}

function launch(key, fn) {
  const p = Promise.resolve().then(fn).catch((err) => {
    const id = key.slice(key.indexOf(':') + 1)
    if (err instanceof TransportError) {
      failedChannels.push('transport')
      if (rows.has(id) && statusOf(id) !== 'escalated') escalate(id, 'transport', err.message)
    } else {
      if (rows.has(id) && statusOf(id) !== 'escalated') escalate(id, 'pipeline', String(err && err.message))
      failedChannels.push('pipeline')
    }
  }).finally(() => running.delete(key))
  running.set(key, p)
}

// ---------------------------------------------------------------- planning

const planning = new Set()

function unplanned() {
  const out = []
  for (const [id, row] of rows) {
    if (!inScope(id) || row.kind === 'leaf' || planning.has(id)) continue
    if (childrenOf(id).length > 0) continue
    if (['parked', 'escalated', 'merged', 'landed'].includes(statusOf(id))) continue
    out.push(id)
  }
  return out
}

/**
 * Folders the planner wrote that compile parked `spec_changed` (their spec changed while work under
 * them was dispatched): the planner re-derives each, once per invocation. Its preparation clears
 * the park its own compile raises (`spec-prepare`), so a re-derived folder does not come back here.
 * A folder the user wrote is theirs to re-spec, and stays parked.
 */
const rederived = new Set()
function rederivable() {
  const out = []
  for (const [id, row] of rows) {
    if (!inScope(id) || row.kind === 'leaf' || row.author !== 'planner') continue
    if (planning.has(id) || rederived.has(id) || statusOf(id) !== 'parked' || row.reason !== 'spec_changed') continue
    rederived.add(id)
    out.push(id)
  }
  return out
}

/**
 * Plan a node by writing a spec. A task is promoted by the planner; a folder is replanned by it
 * only when the planner wrote that folder. A folder the user wrote is theirs to re-spec.
 */
async function planNode(id, why) {
  const row = rows.get(id)
  if (row.kind !== 'leaf' && row.author !== 'planner') {
    if (why) park(id, 'needs_respec', why + ' — edit ' + row.spec_path + ', re-approve it and recompile')
    else park(id, 'needs_design', row.kind === 'design'
      ? 'sub-effort ' + id + ' has no approved spec: run the design skill on it'
      : 'folder ' + id + ' plans nothing: its spec ' + row.spec_path + ' needs a Plan')
    return null
  }
  planning.add(id)
  try {
    const spec = await writeSpec(id, why)
    if (spec) await reviewSpec(id, spec)
  } finally {
    planning.delete(id)
  }
  return null
}

/** The planner writes the node's spec; the path it wrote, or null once the node is parked or escalated. */
async function writeSpec(id, why) {
  const row = rows.get(id)
  let evidence = ''
  if (!why && row.ground_known === false && row.evidence !== 'standing') {
    phase('Plan')
    const survey = await workflow('agentics-survey', {
      question: 'Where and how does this change land: ' + row.title + ' — ' + (row.intent || ''),
      roots: repo, notes: '', pace, intelligence: DIAL, plugin_root: pluginRoot,
    }).catch((err) => {
      failedChannels.push('survey')
      note('survey for ' + id + ' failed: ' + (err && err.message) + ' — planning on the tree alone')
      return null
    })
    if (survey) {
      evidence = JSON.stringify({ items: survey.items, risks: survey.risks, coverage: survey.coverage })
      if (survey.coverage && survey.coverage.complete !== true) note('survey for ' + id + ' is incomplete: ' + (survey.coverage.unreached || []).join('; '))
    }
  }
  const tier = tierFor(JUDGE, 'high')
  const res = await dispatch(plannerPrompt(id, why, evidence), {
    agentType: 'agentics:planner', schema: PLANNED, phase: 'Plan', label: 'plan:' + id, ...tier,
  }, id)
  if (!res) throw new Error('the planner returned nothing')
  if (res.status === 'written') {
    log('plan:' + id + ' wrote ' + ((res.written || []).join(', ') || row.spec_path))
    if ((res.accepted_warnings || []).length) note('planner for ' + id + ' accepted: ' + res.accepted_warnings.join('; '))
    if ((res.uncovered || []).length) note('planner for ' + id + ' did not cover: ' + res.uncovered.join('; '))
    return { path: row.spec_path, written: res.written || [] }
  }
  if (['needs_decision', 'contract_changed', 'premise_mismatch'].includes(res.status)) {
    park(id, res.status, res.question || res.detail)
    return null
  }
  escalate(id, 'plan_' + res.status, res.detail)
  return null
}

/** What makes two findings the same finding across rounds: its axis, its section, its claim. */
const findingKey = (f) => [f.axis, f.section, String(f.claim || '').toLowerCase().replace(/\s+/g, ' ').trim()].join('|')

async function reload(label) {
  const payload = await boundary('preflight', { root: rootId, reload: true }, { phase: 'Plan', label })
  absorbTree(payload)
}

/**
 * The autonomous review of a planner-written spec (D21): check it, attack it with a nested probe,
 * have the planner settle every finding, re-review only what changed, until the ledger's gate
 * (`spec-gate`) is ratifiable; then prepare and compile. Every exit is computed: a Decisions row
 * parks the folder; a finding back unchanged after it was incorporated, a discard refused twice,
 * or a gate still shut on a round that edited nothing escalates.
 */
async function reviewSpec(id, spec) {
  let since = ''
  let incorporated = new Set()   // keys of what the last round incorporated
  const settled = new Set()      // disposition ids of every finding settled in any round
  for (;;) {
    const checked = await boundary('spec-check', { node: id }, { phase: 'Plan', label: 'spec-check:' + id })
    if (checked.decisions_n > 0) {
      park(id, 'needs_decision', checked.spec_path + ' states ' + checked.decisions_n + ' decision(s): only the user states decisions')
      return null
    }
    if ((checked.problems || []).length) {
      escalate(id, 'spec_refused', checked.problems.map((p) => p.file + ':' + p.line + ' ' + p.problem).join('; '))
      return null
    }
    const review = await workflow('agentics-probe', {
      artifact: checked.spec_path, roots: repo, plugin_root: pluginRoot,
      context: 'the spec develop\'s planner wrote for folder ' + id + ' of effort ' + effort,
      ...(since ? { since } : {}),
    }).catch((err) => {
      failedChannels.push('autonomous-review')
      note('the autonomous review of ' + id + ' failed: ' + (err && err.message))
      return null
    })
    if (!review) {
      escalate(id, 'review_failed', 'the autonomous review of ' + checked.spec_path + ' returned nothing')
      return null
    }
    // A finding's settlement id: its evidence item, or the reviewed hash and its P-id when the
    // probe could not anchor it. Dispositions and the `reviewed` line both use it.
    const idOf = (f) => f.item || checked.hash + '#' + f.id
    // Every round reaches the ledger, whole or partial, before anything acts on it.
    const whole = !!(review.coverage && review.coverage.complete === true)
    const left = whole ? [] : ((review.coverage && review.coverage.resumable && review.coverage.resumable.remaining) || [])
    const reviewed = await boundary('spec-reviewed', {
      node: id, complete: whole,
      remaining: whole || left.length ? left : ((review.coverage && review.coverage.unreached) || ['the review reported no coverage']),
      ambiguities: (review.findings || []).filter((f) => f.severity === 'ambiguity').map(idOf),
    }, { phase: 'Plan', label: 'spec-reviewed:' + id })
    if (reviewed.error || reviewed.ok === false) {
      escalate(id, 'ledger_refused', (reviewed.error && reviewed.error.message) || 'spec-reviewed refused')
      return null
    }
    if (!whole) {
      escalate(id, 'review_incomplete', ((review.coverage && review.coverage.unreached) || []).join('; '))
      return null
    }
    // A finding carried from an earlier round sits on lines no edit touched: it stays settled.
    const fresh = (review.findings || []).filter((f) => !settled.has(idOf(f)))
    const back = fresh.find((f) => incorporated.has(findingKey(f)))
    if (back) {
      escalate(id, 'review_not_converging', 'finding ' + back.id + ' came back unchanged after it was incorporated: ' + back.claim)
      return null
    }
    let taken = []
    if (fresh.length) {
      const dispositions = await settle(id, spec, fresh)
      if (!dispositions) return null
      const byId = new Map(fresh.map((f) => [f.id, f]))
      const settledOut = await boundary('spec-settle', {
        node: id, dispositions: dispositions.map((d) => ({ finding: idOf(byId.get(d.finding)), outcome: d.outcome })),
      }, { phase: 'Plan', label: 'spec-settle:' + id })
      if (settledOut.error || settledOut.ok === false) {
        escalate(id, 'ledger_refused', (settledOut.error && settledOut.error.message) || 'spec-settle refused')
        return null
      }
      for (const f of fresh) settled.add(idOf(f))
      taken = dispositions.filter((d) => d.outcome === 'incorporated').map((d) => d.finding)
    }
    // The gate is the ledger's (approvalGate), the one the design skill reads: the latest review
    // of the spec as it stands is complete and every ambiguity it returned has a disposition, from
    // any round. An incorporation edited the spec, so the gate stays shut until the narrowed
    // re-review reads it. The probe's own ratifiable counts a settled carried ambiguity as open,
    // so it is not the gate here.
    const gate = await boundary('spec-gate', { node: id }, { phase: 'Plan', label: 'spec-gate:' + id })
    // The prepared line names the review return that passed. A clean round records an empty
    // return, so only a probe whose record failed (then its snapshot) or whose scope failed too
    // (then the spec hash) is named by what it read.
    if (gate.ratifiable) return prepare(id, review.review || review.snapshot || checked.hash)
    if (taken.length === 0) {
      escalate(id, 'review_not_converging', 'the gate stays shut on a spec this round did not edit: open ' +
        ((gate.open || []).join(', ') || 'none') + (gate.coverage_complete ? '' : '; coverage incomplete'))
      return null
    }
    since = review.snapshot || ''
    incorporated = new Set(fresh.filter((f) => taken.includes(f.id)).map(findingKey))
  }
}

/**
 * The planner's dispositions, one per finding. A discarded ambiguity or gap, or a finding left
 * without one, is refused and sent back once; the same finding refused twice escalates.
 */
async function settle(id, spec, findings) {
  let refused = []
  for (let attempt = 1; ; attempt++) {
    const res = await dispatch(settlePrompt(id, spec.path, findings, refused), {
      agentType: 'agentics:planner', schema: SETTLED, phase: 'Plan', label: 'settle:' + id + '#' + attempt, ...tierFor(JUDGE, 'high'),
    }, id)
    if (!res) {
      escalate(id, 'settle_returned_nothing', 'the planner returned nothing for ' + findings.length + ' finding(s)')
      return null
    }
    if (res.status === 'needs_decision') {
      park(id, 'needs_decision', res.question || res.detail)
      return null
    }
    if (res.status === 'blocked') {
      escalate(id, 'blocked', res.detail)
      return null
    }
    const outcome = new Map((res.dispositions || []).map((d) => [d.finding, d.outcome]))
    const wrong = findings.filter((f) => !outcome.has(f.id) || (outcome.get(f.id) === 'discarded' && f.severity !== 'note'))
    if (wrong.length === 0) return findings.map((f) => ({ finding: f.id, outcome: outcome.get(f.id) }))
    const again = wrong.find((f) => refused.some((r) => r.id === f.id))
    if (again) {
      escalate(id, 'review_not_converging', 'the planner left ' + again.id + ' (' + again.severity + ') unincorporated after it was refused')
      return null
    }
    refused = wrong.map((f) => ({
      id: f.id,
      why: f.id + ' (' + f.severity + '): ' + (outcome.has(f.id) ? 'an ' + f.severity + ' can only be incorporated' : 'it has no disposition'),
    }))
  }
}

/** The gate passed on the review `reviewed` names (its return; its snapshot or the spec hash only when the probe's record failed): record the preparation, compile, reload. */
async function prepare(id, reviewed) {
  const out = await boundary('spec-prepare', { node: id, review: reviewed }, { phase: 'Plan', label: 'spec-prepare:' + id })
  if (out.error || out.ok === false) {
    escalate(id, 'ledger_refused', (out.error && out.error.message) || 'spec-prepare refused')
    return null
  }
  if (out.status !== 'prepared') {
    escalate(id, 'prepare_refused', (out.problems || []).map((p) => p.file + ':' + p.line + ' ' + p.problem).join('; ') || String(out.status))
    return null
  }
  const compiled = out.compile || {}
  if (compiled.ok !== true) {
    escalate(id, 'compile_refused', (compiled.problems || []).map((p) => p.file + ':' + p.line + ' ' + p.problem).join('; '))
    return null
  }
  log('prepared ' + id + ' on ' + reviewed + '; compiled ' + (compiled.written || []).length + ' node(s)')
  await reload('reload:' + id)
  if (rows.get(id) && rows.get(id).kind !== 'leaf' && childrenOf(id).length === 0) {
    escalate(id, 'planner_wrote_nothing', 'compiled ' + id + ' with no plan entry beneath it')
  }
  return null
}

// ---------------------------------------------------------------- commands

let establishing = null

/** Establish build and test commands once per execution; the investigator records them. */
function establishCommands(worktree) {
  if (!establishing) {
    establishing = dispatch(
      'No build or test command is established for this repository. Establish build, typecheck, suite and test_one in ' +
      worktree + ', proving each by running it, and record each with:\nnode "' + pluginRoot + '/lib/gotchas.mjs" add --repo "' +
      repo + '" --effort "' + effort + "\" --role investigator --stdin <<'AGENTICS_EOF'\n[<one JSON object per command>]\nAGENTICS_EOF",
      { agentType: 'agentics:investigator', schema: ESTABLISHED, phase: 'Execute', label: 'establish-commands', model: 'sonnet', effort: 'medium' },
      '',
    ).then((res) => {
      if (res) note('commands established: ' + (res.commands || []).map((c) => c.name + (c.absent ? ' (absent)' : ' exit ' + c.exit_status)).join(', '))
      if (res && res.unresolved && res.unresolved.length) note('commands not established: ' + res.unresolved.join('; '))
      return res
    })
  }
  return establishing
}

// ---------------------------------------------------------------- one leaf

const blockingOf = (row, findings) => findings.filter((f) => f.severity === 'critical' ||
  (f.severity === 'major' && (row.provides || []).length > 0 && String(f.failure_scenario || '').trim() !== ''))

const failureKey = (failures) => (failures || []).map((f) => f.check + ':' + f.claim).sort().join('|')

async function openLeaf(id, st, fix, mode) {
  const row = rows.get(id)
  for (;;) {
    const opened = await boundary('leaf-open', {
      node: id, role: st.role, round: st.round, fix, mode, refresh: st.refresh === true,
      dispatch: st.role ? producerTier(row, st.raise) : COURIER,
    }, { phase: 'Execute', label: 'open:' + id + '#' + st.round })
    if (Number.isInteger(opened.max_parallel) && opened.max_parallel > 0) maxParallel = opened.max_parallel
    if (opened.status === 'opened') {
      rounds.set(id, Math.max(rounds.get(id) || 0, st.round))
      st.refresh = false
      st.worktree = opened.worktree
      st.branch = opened.branch
      st.brief = opened.brief_path
      if (!st.base || st.round === 1 || opened.rebased) st.base = opened.base_sha
      if (!st.head) st.head = opened.head_sha || opened.base_sha
      return opened
    }
    if (opened.status === 'locus_held' && opened.stuck) {
      // Held by an escalated or parked leaf: it frees only when the user acts on that leaf.
      const holder = (opened.held_by || [])[0] || {}
      lockedBy.set(id, holder.node || '')
      note(id + ': its files are held by ' + (holder.node || 'a stopped leaf') + ', which waits on the user')
      return null
    }
    if (opened.status === 'no_slot' || opened.status === 'locus_held' || opened.status === 'busy') {
      log('open:' + id + ': ' + opened.status + ' — waiting for ' + (opened.held_by ? JSON.stringify(opened.held_by) : 'the pool'))
      continue
    }
    escalate(id, 'open_refused', (opened.error && opened.error.message) || opened.status)
    return null
  }
}

async function closeLeaf(id, st, executorStatus) {
  for (;;) {
    const closed = await settled('leaf-close', {
      node: id, role: st.role, round: st.round, executor_status: executorStatus, base_sha: st.base,
    }, { phase: 'Execute', label: 'close:' + id + '#' + st.round })
    if (closed.decision && closed.decision.next === 'command_unknown' && !st.commandsTried) {
      st.commandsTried = true
      await establishCommands(st.worktree)
      continue
    }
    return closed
  }
}

/**
 * One leaf, from wherever resume says it stands, to approval, escalation or a park.
 *
 * The review-loop exit is carried over verbatim (docs/DESIGN.md#executors-and-review): the open
 * set is the round's blocking findings plus every prior blocker ruled not_fixed/regressed and not
 * re-reported; approval is that set being empty; escalation is computed — a fix round with no new
 * commits or a blocked status, the same id unfixed two rounds running, or two rounds that each
 * fix every prior blocker and still mint new ones. No round counter ends it.
 */
async function runLeaf(id, entry) {
  const row = rows.get(id)
  const facts = leafFacts.get(id) || {}
  const done = rounds.get(id) || 0
  let stage = entry && entry.stage ? entry.stage : ({
    code: 'code', 'continue-series': 'continue', verify: 'close', review: 'review', merge: 'approve',
  })[facts.next_action || 'code'] || 'code'
  const st = {
    // A salvaged series is closed and reviewed at the round that produced it; anything new is the
    // next round, so its brief, report and dispatch never overwrite an earlier one's.
    role: roleOf(row), round: ['close', 'review', 'approve'].includes(stage) && done ? done : done + 1,
    reviewRounds: 0, raise: false,
    base: facts.base_sha || '', head: facts.head_sha || '', deltaBase: '', concerns: [],
    salvaged: false, worktree: facts.worktree || '', branch: facts.branch || '', brief: facts.brief_path || '',
    refresh: false, lastFailures: '', priorBlockers: [], priorUnfixed: new Set(), cleanStreak: 0,
  }
  let fix = (entry && entry.fix) || []
  if (entry && entry.refresh) st.refresh = true
  if (['close', 'review', 'approve', 'continue'].includes(stage) && facts.head_sha) st.salvaged = true
  if (st.salvaged) note(id + ': salvaged from an earlier invocation at ' + (facts.next_action || stage))

  for (;;) {
    if (stage === 'approve') {
      approve(id, st, !row.own_review)
      return null
    }

    if (stage === 'code' || stage === 'continue' || stage === 'fix') {
      const opened = await openLeaf(id, st, fix, stage === 'code' ? 'fresh' : stage)
      if (!opened) return
      status.set(id, 'active')
      if (st.role) {
        const headBefore = st.head
        const tier = producerTier(row, st.raise)
        const res = await dispatch(executorPrompt(id, st.role, st.round, opened, stage === 'code' ? 'fresh' : stage), {
          agentType: EXECUTOR_TYPE[st.role], schema: EXECUTOR, phase: 'Execute',
          label: st.role + ':' + id + '#' + st.round, ...tier,
        }, id)
        if (!res) {
          escalate(id, 'executor_returned_nothing', 'the ' + st.role + ' dispatch returned nothing')
          return null
        }
        st.concerns = res.concerns || []
        if (['decompose', 'unsplittable', 'premise_mismatch'].includes(res.status)) {
          status.set(id, 'planned')
          note(id + ': ' + res.status + ' — replanning its subtree')
          const before = row.rev
          await planNode(id, res.status + ': ' + res.detail)
          const after = rows.get(id)
          // A replan that wrote no new revision of the leaf would send the same executor back to
          // the same wall.
          if (after && after.kind === 'leaf' && after.rev === before && !['escalated', 'parked'].includes(statusOf(id))) {
            escalate(id, 'replan_not_converging', 'the planner answered ' + res.status + ' without changing the leaf: ' + res.detail)
          }
          return null
        }
        if (['needs_decision', 'contract_changed'].includes(res.status)) {
          park(id, res.status, res.detail)
          return null
        }
        if (res.status === 'blocked' || res.status === 'needs_context') {
          escalate(id, res.status, res.detail)
          return null
        }
        if (stage === 'fix' && st.role === 'implementer' && (res.commits || []).length === 0) {
          escalate(id, 'fix_without_commits', 'fix round ' + st.round + ' returned no commits: ' + res.detail)
          return null
        }
        st.executorStatus = res.status
        st.headBefore = headBefore
      }
      stage = 'close'
    }

    if (stage === 'close') {
      const closed = await closeLeaf(id, st, st.executorStatus || '')
      if (closed.head_sha) {
        if (st.inReview && closed.head_sha !== st.head) st.deltaBase = st.head
        st.head = closed.head_sha
      }
      const d = closed.decision || { next: 'escalate', reason: 'no_decision' }
      if (d.next === 'approve') {
        stage = 'approve'
        continue
      }
      if (d.next === 'review') {
        stage = 'review'
        continue
      }
      if (d.next === 'finding') {
        note(id + ': a verify leaf found its premise false — replanning ' + parentOf(id))
        escalate(id, 'verify_finding', (d.failures || []).map((f) => f.claim).join('; '))
        await planNode(parentOf(id), 'verify leaf ' + id + ' found: ' + (d.failures || []).map((f) => f.claim + ' (' + f.evidence + ')').join('; '))
        return null
      }
      if (d.next === 'fix') {
        const key = failureKey(d.failures)
        if (key && key === st.lastFailures) {
          escalate(id, 'verify_not_converging', 'two consecutive measurements failed identically: ' + key)
          return null
        }
        if (st.lastFailures) st.raise = true
        st.lastFailures = key
        st.round++
        fix = (d.failures || []).map((f) => ({ source: 'verification', claim: f.claim, evidence: f.evidence }))
        stage = 'fix'
        continue
      }
      escalate(id, d.reason || 'escalated', (d.failures || []).map((f) => f.claim).join('; '))
      return null
    }

    if (stage === 'review') {
      st.inReview = true
      st.reviewRounds++
      const round = st.reviewRounds
      const res = await dispatch(reviewerPrompt(id, st, round, st.priorBlockers), {
        agentType: 'agentics:reviewer', schema: FINDINGS, phase: 'Execute',
        label: 'review:' + id + '#' + round, ...reviewerTier(row),
      }, id)
      if (!res) {
        escalate(id, 'review_returned_nothing', 'round ' + round)
        return null
      }
      const findings = res.findings || []
      const blocking = blockingOf(row, findings)
      const verdicts = res.fix_verdicts || []
      // A prior blocker the round did not rule on is not fixed: it was never looked at.
      const unfixed = verdicts.filter((v) => v.status === 'not_fixed' || v.status === 'regressed')
        .concat(st.priorBlockers.filter((p) => !verdicts.some((v) => v.id === p.id)).map((p) => ({ id: p.id, status: 'not_fixed' })))
      const reported = new Set(findings.map((f) => f.id))
      const open = blocking.concat(st.priorBlockers.filter((p) => unfixed.some((u) => u.id === p.id) && !reported.has(p.id)))

      if (open.length === 0) {
        stage = 'approve'
        continue
      }
      const repeat = unfixed.find((u) => st.priorUnfixed.has(u.id))
      if (repeat) {
        escalate(id, 'review_not_converging', 'finding ' + repeat.id + ' ruled ' + repeat.status + ' in two consecutive rounds')
        return null
      }
      const allFixed = st.priorBlockers.length > 0 && st.priorBlockers.every((p) => verdicts.some((v) => v.id === p.id && v.status === 'fixed'))
      st.cleanStreak = allFixed && blocking.length > 0 ? st.cleanStreak + 1 : 0
      if (st.cleanStreak >= 2) {
        escalate(id, 'review_not_converging', 'two rounds each fixed every prior blocker and still minted new ones')
        return null
      }
      st.priorUnfixed = new Set(unfixed.map((u) => u.id))
      if (st.priorBlockers.length && unfixed.length) st.raise = true
      st.priorBlockers = open
      st.round++
      fix = open.map((f) => ({ source: 'review', claim: '[' + f.severity + ' ' + f.id + '] ' + f.claim, evidence: f.evidence + (f.failure_scenario ? ' — ' + f.failure_scenario : '') }))
      stage = 'fix'
      continue
    }
  }
}

function roleOf(row) {
  if (row.rigor === 'verify') return ''
  if (row.role === 'red' || row.rigor === 'tests-only') return 'test-author'
  if (row.role === 'audit') return 'auditor'
  return 'implementer'
}

// ---------------------------------------------------------------- merging

/** The red → green (→ audit) cycle a leaf is in, in order, read from role and deps. */
function cycleOf(id) {
  const row = rows.get(id)
  if (!row || row.kind !== 'leaf' || row.role === 'none') return []
  let red = row
  while (red && red.role !== 'red') {
    const want = red.role === 'audit' ? 'green' : 'red'
    red = (red.deps || []).map((d) => rows.get(d)).find((d) => d && d.role === want && d.rigor === row.rigor)
  }
  if (!red) return []
  const out = [red.id]
  for (const want of ['green', 'audit']) {
    const prev = out[out.length - 1]
    const next = [...rows.values()].find((n) => n.kind === 'leaf' && n.role === want && n.rigor === red.rigor && (n.deps || []).includes(prev))
    if (!next) break
    out.push(next.id)
  }
  return out
}

const inBatch = new Set()

/** Approved children waiting on one integration branch, cycles only when whole. */
function mergeable() {
  const byTarget = new Map()
  const add = (target, child) => {
    if (!byTarget.has(target)) byTarget.set(target, { children: [], cycles: [] })
    byTarget.get(target).children.push(child)
  }
  for (const [id, row] of rows) {
    if (!inScope(id) || inBatch.has(id)) continue
    const target = parentOf(id)
    if (target === null || running.has('merge:' + target)) continue
    if (['escalated', 'parked'].includes(statusOf(target))) continue
    if (row.kind === 'leaf') {
      if (statusOf(id) !== 'approved') continue
      const cycle = cycleOf(id)
      if (cycle.length) {
        if (cycle[0] !== id) continue
        if (!cycle.every((m) => statusOf(m) === 'approved')) continue
        for (const m of cycle) add(target, { id: m, head_sha: heads.get(m) || '' })
        byTarget.get(target).cycles.push(cycle)
        continue
      }
      add(target, { id, head_sha: heads.get(id) || '' })
    } else if (composite.get(id) === 'ripe' && (id !== rootId || rootId !== '.') && !['escalated', 'parked', 'merged'].includes(statusOf(id))) {
      add(target, { id, head_sha: (integ.get(id) || {}).head || '' })
    }
  }
  return byTarget
}

async function mergeInto(target, batch) {
  const ids = batch.children.map((c) => c.id)
  ids.forEach((i) => inBatch.add(i))
  for (const c of batch.children) if (composite.get(c.id) === 'ripe') composite.set(c.id, 'merging')
  try {
    const out = await settled('merge-batch', { target, children: batch.children, cycles: batch.cycles }, { phase: 'Integrate', label: 'merge:' + target })
    if (out.error || out.ok === false) {
      // The batch could not run at all (a refresh that conflicted, a dirty integration worktree, a
      // job that failed): the target is stopped, and nothing is re-batched into it until the user acts.
      escalate(target, 'merge_batch_failed', (out.error && out.error.message) || 'merge-batch refused')
      return null
    }
    integ.set(target, { worktree: out.target_worktree, base: out.target_base, head: out.head_sha, branch: out.target_branch })
    for (const m of out.merged || []) {
      status.set(m.id, 'merged')
      if (composite.has(m.id)) composite.set(m.id, 'merged')
      mergedSinceStart++
    }
    if (out.conflict) {
      escalate(out.conflict.node, 'merge_conflict', 'conflicting paths: ' + (out.conflict.paths || []).join(', ') + ' — loci were declared disjoint; this is a planner defect')
    }
    for (const id of out.combination || []) escalate(id, 'combination_failure', 'passes alone, fails merged with ' + (out.combination || []).filter((x) => x !== id).join(', '))
    for (const d of out.drift || []) {
      drift.push(d)
      if (!['parked', 'escalated', 'merged'].includes(statusOf(d.node))) {
        park(d.node, 'contract_drift', 'merged work touched ' + d.files.join(', ') + ' under contract ' + d.contract +
          ', which ' + d.node + ' consumes: rule it unaffected, re-design it or re-slice it')
      }
    }
    if ((out.unexamined || []).length) note('undesigned nodes not examined for drift: ' + out.unexamined.join(', '))
    for (const f of out.failed_alone || []) {
      const members = f.ids && f.ids.length ? f.ids : [f.id]
      const why = (f.failures || []).map((x) => x.claim).join('; ')
      // A composite, or a cycle that lands as a unit, has no one producer a fix round could go to:
      // its failure on the merged head is the user's to route.
      if (members.length > 1 || !isLeaf(f.id)) {
        for (const m of members) escalate(m, 'fails_on_integration', why)
        continue
      }
      note(f.id + ': fails on the integration head alone — a fix round on the refreshed branch')
      status.set(f.id, 'active')
      heads.delete(f.id)
      launch('leaf:' + f.id, () => runLeaf(f.id, {
        stage: 'fix', refresh: true,
        fix: (f.failures || []).map((x) => ({ source: 'integration', claim: x.claim, evidence: x.evidence })),
      }))
    }
    for (const c of batch.children) {
      if (composite.get(c.id) === 'merging' && statusOf(c.id) !== 'merged') composite.set(c.id, statusOf(c.id) === 'escalated' ? 'held' : 'ripe')
    }
    const progressed = (out.merged || []).length + (out.failed_alone || []).length + (out.combination || []).length + (out.conflict ? 1 : 0)
    if (progressed === 0) escalate(target, 'merge_no_progress', 'a merge-batch into ' + target + ' merged nothing and reported no failure')
    if (input.pause && !stopping) stopping = 'pause'
    if (budgetShort() && !stopping) stopping = 'budget'
  } finally {
    ids.forEach((i) => inBatch.delete(i))
  }
}

const budgetShort = () => {
  if (!budget || !budget.total || leavesFinished === 0) return false
  const perLeaf = budget.spent() / leavesFinished
  return budget.remaining() < perLeaf
}

// ---------------------------------------------------------------- composites

/** Composites whose children have all merged and whose integration review has not run. */
function integrated() {
  const out = []
  for (const [id, row] of rows) {
    if (!inScope(id) || row.kind === 'leaf' || composite.has(id)) continue
    if (['merged', 'landed', 'parked', 'escalated'].includes(statusOf(id))) continue
    const kids = childrenOf(id)
    if (kids.length === 0 || !kids.every((k) => statusOf(k) === 'merged')) continue
    out.push(id)
  }
  return out
}

const DRIFT = ['under', 'over', 'deviates']

/**
 * The one park an integration review earns, or null. A spec defect goes first: fixing work against
 * a claim that cannot be met is wasted. Then criticals and drift, which the user routes to a fix:
 * no single producer owns a folder's merged work (`../shared/architecture.md` § Design Decisions 2, spec §6)
 * Then what the review could not decide, which never counts as a pass.
 */
function integrationPark(id, findings, claims) {
  const off = claims.filter((c) => c.verdict !== 'met')
  const criticals = findings.filter((f) => f.severity === 'critical')
  const why = off.some((c) => c.verdict === 'spec_defect') ? 'spec_defect'
    : criticals.length || off.some((c) => DRIFT.includes(c.verdict)) ? 'integration_critical'
      : off.length ? 'cant_tell' : ''
  if (!why) return null
  const lines = criticals.map((f) => f.id + ': ' + f.claim).concat(off.map((c) => '[' + c.verdict + '] ' + c.claim + ' — ' + c.evidence))
  return { why, question: (why === 'spec_defect' ? 'the spec ' + rows.get(id).spec_path + ': ' : '') + lines.join('; ') }
}

/**
 * The integration review, earned: when a child had no review loop of its own, or when two or more
 * children with commits meet here for the first time. Its criticals go to the user.
 */
async function reviewComposite(id) {
  composite.set(id, 'reviewing')
  const kids = childrenOf(id)
  const where = integ.get(id)
  const withWork = kids.filter((k) => !isLeaf(k) || rows.get(k).rigor !== 'verify')
  const earned = id === '.' ||
    kids.some((k) => isLeaf(k) && !rows.get(k).own_review && rows.get(k).rigor !== 'verify') || withWork.length >= 2
  if (!earned || !where) {
    note(id + ': integration review not earned (' + (where ? 'one reviewed child' : 'nothing merged') + ')')
    composite.set(id, 'ripe')
    return null
  }
  const res = await dispatch(integrationPrompt(id, where, kids, []), {
    agentType: 'agentics:reviewer', schema: FINDINGS, phase: 'Integrate', label: 'review:integration:' + id, ...tierFor(JUDGE, 'high'),
  }, id).catch((err) => {
    failedChannels.push('integration-review')
    note('integration review of ' + id + ' failed: ' + (err && err.message))
    return null
  })
  const findings = res ? res.findings || [] : []
  const claims = res ? res.claims || [] : []
  reviews.push({ target: id, findings, claims, notes: res ? res.notes : '', reviewed: Boolean(res) })
  if (res) recordEvent({ kind: 'claims', node: id, head_sha: where.head, claims })
  const held = integrationPark(id, findings, claims)
  if (held) {
    composite.set(id, 'held')
    park(id, held.why, held.question)
    return null
  }
  composite.set(id, 'ripe')
}

// ---------------------------------------------------------------- result

const RUN_ID = 'unknown-to-script: pair `remaining` with the runId from the Workflow launch result'

function blockedList() {
  const out = []
  for (const [id, row] of rows) {
    if (row.kind !== 'leaf' || !inScope(id)) continue
    if (!['planned', 'active'].includes(statusOf(id))) continue
    const by = blockedBy(id) || lockedBy.get(id)
    if (by) out.push({ id, blocked_by: by })
  }
  return out
}

function result(checkpoint) {
  const leaves = [...rows.keys()].filter((id) => isLeaf(id) && inScope(id))
  const notLanded = leaves.filter((id) => statusOf(id) !== 'merged')
  const blocked = blockedList()
  const rootDone = ['integrated', 'merged', 'landed'].includes(statusOf(rootId)) ||
    (composite.get(rootId) === 'ripe' || composite.get(rootId) === 'merged')
  const unreached = []
    .concat(escalations.map((e) => e.id + ': escalated — ' + e.reason))
    .concat(parked.map((p) => p.id + ': parked — ' + p.return))
    .concat(blocked.map((b) => b.id + ': blocked — ' + b.blocked_by + ' did not land'))
    .concat(notLanded.filter((id) => !escalations.some((e) => e.id === id) && !parked.some((p) => p.id === id) && !blocked.some((b) => b.id === id))
      .map((id) => id + ': not merged in this invocation' + (stopping ? ' (' + stopping + ')' : '')))
    .concat(checkpoint ? ['checkpoint ' + checkpoint.reason + ': nothing was dispatched'] : [])
    .concat([...new Set(failedChannels)].map((c) => 'the ' + c + ' channel failed in this invocation'))
  // Stopped nodes this invocation did not stop itself are carried from an earlier one: they lead
  // the result as much as fresh ones, or a resume reads cleaner than the run it resumed.
  for (const [id, row] of rows) {
    if (!inScope(id)) continue
    if (statusOf(id) === 'escalated' && !escalations.some((e) => e.id === id)) escalations.push({ id, reason: row.reason || 'escalated', detail: 'carried from an earlier invocation', carried: true })
    if (statusOf(id) === 'parked' && !parked.some((p) => p.id === id)) parked.push({ id, return: row.reason || 'parked', question: 'carried from an earlier invocation', carried: true })
  }
  // A held cycle member waits on a later member that stopped: say so, not just "not merged".
  const held = leaves.filter((id) => statusOf(id) === 'approved' && cycleOf(id).some((m) => ['escalated', 'parked'].includes(statusOf(m))))
    .map((id) => ({ id, behind: cycleOf(id).find((m) => ['escalated', 'parked'].includes(statusOf(m))) }))
  for (const h of held) unreached.unshift(h.id + ': held — its cycle member ' + h.behind + ' stopped, and a cycle lands as a unit')
  for (const e of escalations.filter((x) => x.carried)) unreached.unshift(e.id + ': escalated earlier — ' + e.reason)
  for (const p of parked.filter((x) => x.carried)) unreached.unshift(p.id + ': parked earlier — ' + p.return)
  // A lost review is a lost check: the leaves it was owed to were verified and never read.
  const lostReview = failedChannels.includes('integration-review') || failedChannels.includes('survey')
  const where = integ.get(rootId) || {}
  return {
    effort, root: rootId, execution, checkpoint: checkpoint || null,
    nodes_n: [...rows.keys()].filter(inScope).length,
    implemented, escalations, parked, blocked,
    integration: { branch: where.branch || '', head_sha: where.head || '', reviews },
    drift, cleanup,
    cost: { dispatches, by_model: byModel, tokens: budget && budget.total ? budget.spent() : null },
    stopped: stopping || '',
    notes,
    coverage: {
      complete: !checkpoint && notLanded.length === 0 && rootDone && escalations.length === 0 && parked.length === 0 && !lostReview,
      dropped: [],
      incomplete: [],
      failed_channels: [...new Set(failedChannels)],
      unreached,
      resumable: {
        runId: RUN_ID,
        remaining: [...new Set(notLanded.concat(parked.map((p) => p.id)))],
        args: { effort, root: rootId, execution },
      },
    },
  }
}

// ---------------------------------------------------------------- the run

if (!effort || !execution) {
  return result({ reason: 'bad_input', detail: 'effort and execution (a UTC stamp minted by the session) are required' })
}

phase('Preflight')
let pf
try {
  pf = await boundary('preflight', {
    root: rootId,
    retry_escalated: input.retry_escalated || [],
    confirmed_duplicate: input.confirmed_duplicate === true,
    confirmed_gaps: input.confirmed_gaps === true,
    confirmed_stale: input.confirmed_stale === true,
    plan_only: input.plan_only === true,
    dial: DIAL, pace, base_ref: input.base_ref || '', commands: input.commands || null,
  }, { phase: 'Preflight', label: 'preflight' })
} catch (err) {
  failedChannels.push('preflight')
  note('preflight could not be carried: ' + (err && err.message))
  return result({ reason: 'preflight_failed', detail: String(err && err.message) })
}

if (pf.error) {
  note('preflight refused: ' + pf.error.message)
  return result({ reason: pf.error.kind || 'preflight_refused', detail: pf.error.message })
}
absorbTree(pf)
for (const s of pf.stale || []) drift.push(s)
for (const d of pf.dirty_worktrees || []) note('dirty worktree left in place (never forced): ' + d)
if ((pf.gaps || []).length) note('traceability gaps: ' + pf.gaps.map((g) => g.decision + ' at ' + g.at).join(', '))
if ((pf.untraced || []).length) note('criteria tracing to no decision: ' + pf.untraced.map((u) => u.node).join(', '))
if (pf.checkpoint) {
  await boundary('postflight', { status: 'checkpoint' }, { phase: 'Postflight', label: 'postflight' }).catch(() => failedChannels.push('postflight'))
  return result(pf.checkpoint)
}
if (!rows.has(rootId)) return result({ reason: 'no_such_node', detail: 'node ' + rootId + ' is not in effort ' + effort })

log('execution ' + execution + ' of ' + rootId + ': ' + [...rows.keys()].filter((id) => isLeaf(id) && inScope(id)).length +
  ' leaves planned, pool ' + maxParallel + ', dial ' + DIAL + ', pace ' + pace)

phase('Execute')
for (;;) {
  for (const id of unplanned()) launch('plan:' + id, () => planNode(id))
  for (const id of rederivable()) {
    launch('plan:' + id, () => planNode(id, 'spec_changed: its spec changed while work under it was dispatched — re-derive what is below it, keeping every dispatched or merged task that still stands'))
  }
  for (const id of readyLeaves()) launch('leaf:' + id, () => runLeaf(id))
  for (const [target, batch] of mergeable()) launch('merge:' + target, () => mergeInto(target, batch))
  for (const id of integrated()) launch('review:' + id, () => reviewComposite(id))
  if (running.size === 0) break
  await Promise.race(running.values())
}

if (stopping) note('stopped starting new leaves after a merge-batch: ' + stopping)

phase('Postflight')
// Done means delivered: every leaf merged, and a root below the effort's merged into its parent.
const done = [...rows.keys()].filter((id) => isLeaf(id) && inScope(id)).every((id) => statusOf(id) === 'merged') &&
  (rootId === '.' || statusOf(rootId) === 'merged')
try {
  const post = await boundary('postflight', { status: done ? 'done' : stopping ? 'paused' : 'checkpoint' }, { phase: 'Postflight', label: 'postflight' })
  cleanup = post.cleanup || []
} catch (err) {
  failedChannels.push('postflight')
  note('postflight could not be carried: ' + (err && err.message) + ' — decisions since the last boundary were not recorded; a resume re-derives them')
}

return result(null)
