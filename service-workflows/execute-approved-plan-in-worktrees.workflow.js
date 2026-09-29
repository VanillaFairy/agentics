export const meta = {
  name: 'execute-approved-plan-in-worktrees',
  description: 'Execute a subtree of an agentics effort: plan unplanned composites, run every leaf by its rigor in its own worktree, review, and merge by composite into framework-owned integration branches — scheduled by readiness, never by waves. Never touches the user\'s branch or working tree.',
  phases: [
    { title: 'Preflight', detail: 'refuse overlaps, drift, gaps, free dead slots — one courier' },
    { title: 'Plan', detail: 'planner per unplanned composite; a survey first where the ground is unknown' },
    { title: 'Execute', detail: 'per leaf: leaf-open, executor by rigor, leaf-close, fix rounds, review loop' },
    { title: 'Integrate', detail: 'merge-batch per composite, integration review, merge up' },
    { title: 'Postflight', detail: 'records, cleanup report' },
  ],
}

// Design: docs/DESIGN.md#execution. Every deterministic step is a `lib/boundary.mjs` entry point
// run by a courier and re-digested here, scheduling included: the `schedule` boundary says what to
// launch next from the tree on disk. This script holds only what a script can hold without a
// filesystem: the units in flight and what each typed return means next.
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
  required: ['stop_reason', 'payload_raw', 'task_tools', 'notes'],
  properties: {
    stop_reason: { type: 'string', enum: ['carried', 'failed'] },
    payload_raw: { type: 'string' },
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

const RULINGS = {
  type: 'object', additionalProperties: false,
  required: ['rulings'],
  properties: {
    rulings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['node', 'ruling', 'why', 'question'],
        properties: {
          node: { type: 'string' },
          ruling: { type: 'string', enum: ['unaffected', 'affected'] },
          why: { type: 'string' },
          question: { type: 'string' },
        },
      },
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

const isYardstick = (row) => row.role === 'red' || row.role === 'audit' || row.provides_n > 0

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
//
// No copy of the tree lives here: status is derived on disk, and every unit is launched by the
// `schedule` boundary with the one row it needs. What this script holds is what only it can: the
// units in flight, the decisions it took and has not yet handed to a boundary, and what it saw.

const records = []              // decisions waiting for the next schedule or postflight
const stoppedHere = new Set()   // nodes this invocation escalated, parked or held on a fault
const planning = new Set()      // folders a running unit is replanning inline
const running = new Map()       // unit key -> its promise, until a tick has carried what it decided
const finished = new Set()      // units that ended since the last tick was built
let invocation = 0              // minted by preflight: what makes this invocation's record ids its own
const minted = new Map()        // record content key -> how many times this invocation decided it
const failedChannels = []
const notes = []
const implemented = []
const escalations = []
const parked = []
const faults = []               // units a plugin fault ended: never the user's, retried by the next invocation
const reviews = []
const drift = []
let dispatches = 0
const byModel = {}
let leavesFinished = 0
let stopping = ''
let ticks = 0
let taskToolsMissing = false

const note = (text) => {
  notes.push(text)
  log(text)
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
      ? 'Then apply the todo moves listed in the printed payload.todos: call TaskList once; for each move, the task ' +
        'whose subject equals the move\'s subject is its task — TaskUpdate it with the move\'s activeForm and status; ' +
        'with none, TaskCreate it with the move\'s subject, activeForm and status. Without task tools, set task_tools to "unavailable".'
      : 'Progress is off: move no todos and set task_tools to "skipped".') +
    (pluginRoot === '$CLAUDE_PLUGIN_ROOT'
      ? '\nIf $CLAUDE_PLUGIN_ROOT is empty in your shell, do not guess a path: set stop_reason "failed" and say so.'
      : '')
}

/**
 * The boundaries the main loop calls one at a time: only they carry the pending decisions. Each
 * record goes with an id: this invocation's number and the record's own content, counted when the
 * invocation decides the same thing twice. A record sent again after a lost courier lands once; the
 * same decision taken in a later invocation (an approval after a retry) lands again; and a run a
 * host resumes, which replays the dead run's preflight and so its number, re-derives the same id
 * for the same decision whatever order its units finish in.
 */
const CARRIES_RECORDS = new Set(['schedule', 'postflight'])
function withId(r) {
  if (r.rid) return r
  const key = invocation + ':' + fnv1a(canonical({ file: r.file, entry: r.entry }))
  const n = (minted.get(key) || 0) + 1
  minted.set(key, n)
  return { ...r, rid: n === 1 ? key : key + '#' + n }
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
  const pending = CARRIES_RECORDS.has(name) ? records.splice(0, records.length).map(withId) : []
  const argsObject = { ...a, ...(CARRIES_RECORDS.has(name) ? { records: pending } : {}), progress }
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

function executorPrompt(row, role, round, opened, mode, findings) {
  const id = row.id
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
      ? 'This is fix round ' + round + ': clear, as new commits, the failures the brief lists' +
        (findings.length
          ? ' and these review findings:\n' + findings.map((f) => '- [' + f.severity + ' ' + f.id + '] ' + f.claim + ' — ' + f.evidence +
            (f.failure_scenario ? ' — ' + f.failure_scenario : '')).join('\n') + '\n'
          : '.\n')
      : ''
  return 'You are the ' + role + ' for leaf ' + id + ' ("' + row.title + '"), round ' + round + ', rigor ' + row.rigor +
    (row.role !== 'none' ? ', role ' + row.role : '') + '.\n' + modeText +
    'Worktree: ' + opened.worktree + ' (branch ' + opened.branch + ', base ' + opened.base_sha + ').\n' +
    'Brief: ' + opened.brief_path + '. ' + fetch + '\n' +
    'Report file: ' + opened.report_path + '.' + finish +
    '\n\nReturn status, detail (what you established, tried and need, for any status but done), concerns and commits.'
}

function reviewerPrompt(row, st, round, prior) {
  const id = row.id
  const span = round === 1 ? st.base + '..' + st.head : st.deltaBase + '..' + st.head
  return 'Adversarially review leaf ' + id + ' ("' + row.title + '"), round ' + round + '. You are fresh: nothing ' +
    'from earlier rounds reaches you but the artifacts below.\n' +
    'Worktree: ' + st.worktree + ' (branch ' + st.branch + '). Span under review: ' + span +
    (round === 1 ? ' — the whole series.' : ' — the fix commits since the last round only; a critical you see outside it is still reported.') + '\n' +
    (st.brief
      ? 'Brief (criteria, locus, decisions, contracts): read ' + st.brief + '.\n'
      : 'Criteria, locus, decisions and contracts: node "' + pluginRoot + '/lib/tree.mjs" show --repo "' + repo +
        '" --effort "' + effort + '" --root "' + id + '" --json\n') +
    (row.provides_n > 0 ? 'This leaf PROVIDES a contract: its majors with a failure scenario block like criticals.\n' : '') +
    (row.role === 'green' ? 'The tests were written by another agent before this code and sit outside this locus.\n' : '') +
    'The executor\'s concerns — attack these first:\n' + listOf(st.concerns) + '\n' +
    (prior.length
      ? 'Prior blockers — rule on each in fix_verdicts, and re-report under its id any you rule not_fixed or regressed:\n' +
        prior.map((f) => '- ' + f.id + ' [' + f.severity + '] ' + f.claim).join('\n') + '\n'
      : '') +
    'Return claims: [] — claim verdicts belong to integration reviews.\n'
}

function integrationPrompt(item) {
  const { id, row, where } = item
  return 'Integration review of composite ' + id + ' ("' + row.title + '").\n' +
    'Worktree: ' + where.worktree + '. Merged diff: ' + where.base + '..' + where.head + '.\n' +
    'Yardstick: the folder\'s spec, ' + row.spec_path + '. Judge every claim it makes (each success criterion in its ' +
    'Intent, each statement of its Design, each criterion of its plan) and return one entry per claim in claims: ' +
    '{claim, verdict: met | under | over | deviates | spec_defect | cant_tell, evidence}. A HUMAN: criterion is the user\'s: leave it out.\n' +
    'Its decisions, and the criteria of every child, are in: node "' + pluginRoot + '/lib/tree.mjs" show --repo "' + repo +
    '" --effort "' + effort + '" --root "' + id + '" --json\n' +
    'Children merged here: ' + item.children.join(', ') + '.\n' +
    'Review these against their own criteria too — they had no review loop of their own:\n' +
    listOf(item.unreviewed) + '\n' +
    'Look for defects that exist only with the children together, and for any decision no child realised.'
}

const RULING_CHARGE = 'For each node, rule `unaffected` when everything its spec entry assumes, and every criterion it must ' +
  'meet, still holds after the change, or `affected` when something it assumes no longer does. Give `why` in one sentence. ' +
  'For `affected`, `question` is the one question its owner must answer: what changed, what in the entry no longer holds, ' +
  'and the choice to make. Read only what you are pointed at; if it cannot decide a node, rule it `affected` and ask.'

function driftPrompt(target, entries, diff) {
  return 'Merged work into ' + target + ' of effort ' + effort + ' touched files under contracts that nodes not yet merged consume.\n' +
    'The merged change to those files: read ' + diff + '.\n' +
    entries.map((d) => '- node ' + d.node + ' consumes contract ' + d.contract + ' (touched: ' + d.files.join(', ') +
      '); its plan entry is in ' + d.spec_path).join('\n') + '\n' + RULING_CHARGE
}

function stalePrompt(stale) {
  return 'The base branch of effort ' + effort + ' moved under leaves not yet merged. Read the leaves, the files that moved ' +
    'under each and where each plan entry is, in ' + stale.list + ', and the change to those files in ' + stale.diff + '.\n' +
    RULING_CHARGE
}

/** One analyst rules each node a change touched: a map node -> ruling, or null when none came back. */
async function rule(label, prompt, phaseName) {
  const res = await Promise.resolve().then(() => dispatch(prompt, {
    agentType: 'agentics:analyst', schema: RULINGS, phase: phaseName, label, ...tierFor(JUDGE, 'high'),
  }, '')).catch((err) => {
    note(label + ' returned nothing: ' + (err && err.message))
    return null
  })
  return res ? new Map((res.rulings || []).map((r) => [r.node, r])) : null
}

function plannerPrompt(row, why, evidence) {
  const id = row.id
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
  stoppedHere.add(id)
  escalations.push({ id, reason, detail: detail || '' })
  recordEvent({ kind: 'escalated', node: id, reason, detail: String(detail || '').slice(0, 2000) })
  note('escalated ' + id + ': ' + reason)
  leavesFinished++
}

function park(id, why, question) {
  stoppedHere.add(id)
  parked.push({ id, return: why, question: question || '' })
  recordEvent({ kind: 'parked', node: id, return: why, question: String(question || '').slice(0, 2000) })
  note('parked ' + id + ' (' + why + '): waiting on the user')
}

/** The user answered a node this invocation stopped, and disk says it is ready again: it runs on. */
function answered(id) {
  stoppedHere.delete(id)
  for (const list of [escalations, parked]) {
    const at = list.findIndex((x) => x.id === id)
    if (at !== -1) list.splice(at, 1)
  }
  note(id + ': answered while the run went on — relaunched')
}

function approve(row, st, atIntegration) {
  // Parked by this invocation while its chain was running (contract drift): the user rules first,
  // and the approval is not recorded — a resume re-derives it from the measurement.
  if (stoppedHere.has(row.id)) return
  recordEvent({ kind: 'approved', node: row.id, head_sha: st.head, review_rounds: st.reviewRounds, at_integration: atIntegration })
  const was = implemented.findIndex((i) => i.id === row.id)
  if (was !== -1) implemented.splice(was, 1)
  implemented.push({ id: row.id, rigor: row.rigor, role: row.role, rounds: st.round, review_rounds: st.reviewRounds, at_integration: atIntegration, salvaged: st.salvaged })
  leavesFinished++
}

/**
 * A plugin fault — a boundary that stayed unbelievable, or a throw in this script — is not a
 * decision for the user: the node records no stop on disk, is held for the rest of this
 * invocation, and the next invocation takes it up where its records say it stands.
 */
function fault(id, channel, detail) {
  stoppedHere.add(id)
  faults.push({ id, channel, detail: detail || '' })
  records.push({ file: 'state', entry: { kind: 'fault', node: id, channel, detail: String(detail || '').slice(0, 500) } })
  note('plugin fault on ' + id + ' (' + channel + '): ' + detail + ' — held for the next invocation')
}

function launch(key, fn) {
  const p = Promise.resolve().then(fn).catch((err) => {
    const id = key.slice(key.indexOf(':') + 1)
    const channel = err instanceof TransportError ? 'transport' : 'pipeline'
    failedChannels.push(channel)
    if (!stoppedHere.has(id)) fault(id, channel, String(err && err.message))
  }).finally(() => finished.add(key))
  running.set(key, p)
}

// ---------------------------------------------------------------- planning

/**
 * Plan a node by writing a spec. A task is promoted by the planner; a folder is replanned by it
 * only when the planner wrote that folder. A folder the user wrote is theirs to re-spec. Returns
 * the node as compiled after its spec was prepared, or null when it was parked or escalated.
 */
async function planNode(row, why) {
  const id = row.id
  if (row.kind !== 'leaf' && row.author !== 'planner') {
    if (why) park(id, 'needs_respec', why + ' — edit ' + row.spec_path + ', re-approve it and recompile')
    else park(id, 'needs_design', row.kind === 'design'
      ? 'sub-effort ' + id + ' has no approved spec: run the design skill on it'
      : 'folder ' + id + ' plans nothing: its spec ' + row.spec_path + ' needs a Plan')
    return null
  }
  planning.add(id)
  try {
    const spec = await writeSpec(row, why)
    return spec ? await reviewSpec(id, spec) : null
  } finally {
    planning.delete(id)
  }
}

/** The planner writes the node's spec; the path it wrote, or null once the node is parked or escalated. */
async function writeSpec(row, why) {
  const id = row.id
  let evidence = ''
  if (!why && row.ground_known === false) {
    phase('Plan')
    const survey = await workflow({ scriptPath: pluginRoot + '/service-workflows/gather-evidence-without-concluding.workflow.js' }, {
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
  const res = await dispatch(plannerPrompt(row, why, evidence), {
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

/**
 * The gate passed on the review `reviewed` names (its return; its snapshot or the spec hash only
 * when the probe's record failed): record the preparation and compile. The node as compiled, or null.
 */
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
  log('prepared ' + id + ' on ' + reviewed + '; compiled ' + (compiled.written_n || 0) + ' node(s)')
  if (out.row && out.row.kind !== 'leaf' && out.row.children_n === 0) {
    escalate(id, 'planner_wrote_nothing', 'compiled ' + id + ' with no plan entry beneath it')
    return null
  }
  return out.row
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
  (f.severity === 'major' && row.provides_n > 0 && String(f.failure_scenario || '').trim() !== ''))

const failureKey = (failures) => (failures || []).map((f) => f.check + ':' + f.claim).sort().join('|')

async function openLeaf(row, st, mode) {
  const id = row.id
  for (;;) {
    const opened = await boundary('leaf-open', {
      node: id, role: st.role, round: st.round, mode, refresh: st.refresh === true,
      dispatch: st.role ? producerTier(row, st.raise) : COURIER,
    }, { phase: 'Execute', label: 'open:' + id + '#' + st.round })
    if (opened.status === 'opened') {
      st.refresh = false
      st.worktree = opened.worktree
      st.branch = opened.branch
      st.brief = opened.brief_path
      if (!st.base || st.round === 1 || opened.rebased) st.base = opened.base_sha
      if (!st.head) st.head = opened.head_sha || opened.base_sha
      return opened
    }
    if (opened.status === 'locus_held' && opened.stuck) {
      // Held by an escalated or parked leaf: it frees only when the user acts on that leaf, and
      // the scheduler sees the same lock, so the leaf is not launched again until then.
      const holder = (opened.held_by || [])[0] || {}
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
 * One leaf, from wherever resume says it stands, to approval, escalation or a park. `item` is its
 * launch: its row, its parent's row and its resume facts.
 *
 * The review-loop exit is carried over verbatim (docs/DESIGN.md#executors-and-review): the open
 * set is the round's blocking findings plus every prior blocker ruled not_fixed/regressed and not
 * re-reported; approval is that set being empty; escalation is computed — a fix round with no new
 * commits or a blocked status, the same id unfixed two rounds running, or two rounds that each
 * fix every prior blocker and still mint new ones. No round counter ends it.
 */
async function runLeaf(item, entry) {
  const row = item.row
  const id = row.id
  const facts = item.facts || {}
  const done = facts.rounds || 0
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
  let toClear = []
  if (entry && entry.refresh) st.refresh = true
  if (['close', 'review', 'approve', 'continue'].includes(stage) && facts.head_sha) st.salvaged = true
  if (st.salvaged) note(id + ': salvaged from an earlier invocation at ' + (facts.next_action || stage))

  for (;;) {
    if (stage === 'approve') {
      approve(row, st, !row.own_review)
      return null
    }

    if (stage === 'code' || stage === 'continue' || stage === 'fix') {
      const opened = await openLeaf(row, st, stage === 'code' ? 'fresh' : stage)
      if (!opened) return
      if (st.role) {
        const headBefore = st.head
        const tier = producerTier(row, st.raise)
        const res = await dispatch(executorPrompt(row, st.role, st.round, opened, stage === 'code' ? 'fresh' : stage, toClear), {
          agentType: EXECUTOR_TYPE[st.role], schema: EXECUTOR, phase: 'Execute',
          label: st.role + ':' + id + '#' + st.round, ...tier,
        }, id)
        if (!res) {
          escalate(id, 'executor_returned_nothing', 'the ' + st.role + ' dispatch returned nothing')
          return null
        }
        st.concerns = res.concerns || []
        if (['decompose', 'unsplittable', 'premise_mismatch'].includes(res.status)) {
          note(id + ': ' + res.status + ' — replanning its subtree')
          const after = await planNode(row, res.status + ': ' + res.detail)
          // A replan that wrote no new revision of the leaf would send the same executor back to
          // the same wall.
          if (after && after.kind === 'leaf' && after.rev === row.rev) {
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
        const parent = item.parent
        note(id + ': a verify leaf found its premise false — replanning ' + (parent ? parent.id : 'its folder'))
        escalate(id, 'verify_finding', (d.failures || []).map((f) => f.claim).join('; '))
        if (parent) await planNode(parent, 'verify leaf ' + id + ' found: ' + (d.failures || []).map((f) => f.claim).join('; ') + ' (its measurement: ' + closed.record + ')')
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
        toClear = []
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
      const res = await dispatch(reviewerPrompt(row, st, round, st.priorBlockers), {
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
      toClear = open
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

async function mergeInto(item) {
  const { target } = item
  const out = await settled('merge-batch', { target, children: item.children, cycles: item.cycles }, { phase: 'Integrate', label: 'merge:' + target })
  if (out.error || out.ok === false) {
    // The batch could not run at all (a refresh that conflicted, a dirty integration worktree, a
    // job that failed): the target is stopped, and nothing is re-batched into it until the user acts.
    escalate(target, 'merge_batch_failed', (out.error && out.error.message) || 'merge-batch refused')
    return null
  }
  if (out.conflict) {
    escalate(out.conflict.node, 'merge_conflict', 'conflicting paths: ' + (out.conflict.paths || []).join(', ') + ' — loci were declared disjoint; this is a planner defect')
  }
  for (const id of out.combination || []) escalate(id, 'combination_failure', 'passes alone, fails merged with ' + (out.combination || []).filter((x) => x !== id).join(', '))
  const toRule = []
  for (const d of out.drift || []) {
    drift.push(d)
    if (d.stopped) {
      // Already the user's: ruling on the escalation or park includes this contract moving.
      note(d.node + ' (' + d.stopped + ') consumes contract ' + d.contract + ', which merged work touched: ' + d.files.join(', '))
    } else if (!stoppedHere.has(d.node)) toRule.push(d)
  }
  if (toRule.length) {
    const rulings = await rule('rule:drift:' + target, driftPrompt(target, toRule, out.drift_diff), 'Integrate')
    for (const d of toRule) {
      const r = rulings && rulings.get(d.node)
      if (r && r.ruling === 'unaffected') {
        note(d.node + ': merged work touched contract ' + d.contract + '; ruled unaffected — ' + r.why)
        records.push({ file: 'state', entry: { kind: 'drift-ruled', node: d.node, contract: d.contract, head_sha: out.head_sha || '', ruling: 'unaffected', why: r.why } })
      } else if (!stoppedHere.has(d.node)) {
        park(d.node, 'contract_drift', r ? r.question
          : 'merged work touched ' + d.files.join(', ') + ' under contract ' + d.contract + ', which ' + d.node +
            ' consumes, and no analyst could rule on it: rule it unaffected, re-design it or re-slice it')
      }
    }
  }
  if (out.unexamined_n) note(out.unexamined_n + ' undesigned node(s) not examined for drift')
  for (const f of out.failed_alone || []) {
    const why = (f.failures || []).map((x) => x.claim).join('; ')
    // A composite, or a cycle that lands as a unit, has no one producer a fix round could go to:
    // its failure on the merged head is the user's to route.
    if (!f.row) {
      for (const m of (f.ids && f.ids.length ? f.ids : [f.id])) escalate(m, 'fails_on_integration', why)
      continue
    }
    note(f.id + ': fails on the integration head alone — a fix round on the refreshed branch')
    if (running.has('leaf:' + f.id)) continue
    launch('leaf:' + f.id, () => runLeaf({ unit: 'leaf', id: f.id, row: f.row, parent: f.parent, facts: f.facts }, {
      stage: 'fix', refresh: true,
    }))
  }
  const progressed = (out.merged || []).length + (out.failed_alone || []).length + (out.combination || []).length + (out.conflict ? 1 : 0)
  if (progressed === 0) escalate(target, 'merge_no_progress', 'a merge-batch into ' + target + ' merged nothing and reported no failure')
  if (input.pause && !stopping) stopping = 'pause'
  if (budgetShort() && !stopping) stopping = 'budget'
  return null
}

const budgetShort = () => {
  if (!budget || !budget.total || leavesFinished === 0) return false
  const perLeaf = budget.spent() / leavesFinished
  return budget.remaining() < perLeaf
}

// ---------------------------------------------------------------- composites

const DRIFT = ['under', 'over', 'deviates']

/**
 * The one park an integration review earns, or null. A spec defect goes first: fixing work against
 * a claim that cannot be met is wasted. Then criticals and drift, which the user routes to a fix:
 * no single producer owns a folder's merged work. Then what the review could not decide, which
 * never counts as a pass.
 */
function integrationPark(item, findings, claims) {
  const off = claims.filter((c) => c.verdict !== 'met')
  const criticals = findings.filter((f) => f.severity === 'critical')
  const why = off.some((c) => c.verdict === 'spec_defect') ? 'spec_defect'
    : criticals.length || off.some((c) => DRIFT.includes(c.verdict)) ? 'integration_critical'
      : off.length ? 'cant_tell' : ''
  if (!why) return null
  const lines = criticals.map((f) => f.id + ': ' + f.claim).concat(off.map((c) => '[' + c.verdict + '] ' + c.claim + ' — ' + c.evidence))
  return { why, question: (why === 'spec_defect' ? 'the spec ' + item.row.spec_path + ': ' : '') + lines.join('; ') }
}

/**
 * The integration review, earned: when a child had no review loop of its own, or when two or more
 * children with work meet here for the first time. It always leaves a `claims` event at the head
 * it judged, which is what ripens the composite for merging up. A review that fails escalates.
 */
async function reviewComposite(item) {
  const { id, where } = item
  const head = (where && where.head) || ''
  if (!item.earned) {
    note(id + ': integration review not earned (' + (where ? 'one reviewed child' : 'nothing merged') + ')')
    recordEvent({ kind: 'claims', node: id, head_sha: head, review: 'not_earned', claims: [] })
    return null
  }
  const res = await dispatch(integrationPrompt(item), {
    agentType: 'agentics:reviewer', schema: FINDINGS, phase: 'Integrate', label: 'review:integration:' + id, ...tierFor(JUDGE, 'high'),
  }, id).catch((err) => {
    failedChannels.push('integration-review')
    note('integration review of ' + id + ' failed: ' + (err && err.message))
    return null
  })
  const findings = res ? res.findings || [] : []
  const claims = res ? res.claims || [] : []
  reviews.push({ target: id, findings, claims, notes: res ? res.notes : '', reviewed: Boolean(res) })
  if (!res) {
    escalate(id, 'review_failed', 'the integration review of ' + id + ' returned nothing')
    return null
  }
  recordEvent({ kind: 'claims', node: id, head_sha: head, review: 'done', claims })
  const held = integrationPark(item, findings, claims)
  if (held) park(id, held.why, held.question)
  return null
}

// ---------------------------------------------------------------- result

const RUN_ID = 'unknown-to-script: pair `remaining` with the runId from the Workflow launch result'

const NO_SUMMARY = { nodes_n: 0, leaves_n: 0, merged_n: 0, not_merged_n: 0, blocked_n: 0, blocked: [], root_done: false, done: false, stopped: [], held: [] }

/** The return: postflight's summary of the subtree on disk, and what this invocation saw itself. */
function result(checkpoint, post) {
  const s = (post && post.summary) || NO_SUMMARY
  // Stopped nodes this invocation did not stop itself are carried from an earlier one: they lead
  // the result as much as fresh ones, or a resume reads cleaner than the run it resumed.
  for (const x of s.stopped) {
    if (stoppedHere.has(x.id)) continue
    if (x.status === 'escalated') escalations.push({ id: x.id, reason: x.reason || 'escalated', detail: 'carried from an earlier invocation', carried: true })
    if (x.status === 'parked') parked.push({ id: x.id, return: x.reason || 'parked', question: 'carried from an earlier invocation', carried: true })
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
      },
    },
  }
}

/** Close the invocation: postflight lands the last decisions and summarizes the subtree from disk. */
async function finish(checkpoint) {
  try {
    return result(checkpoint, await boundary('postflight', {}, { phase: 'Postflight', label: 'postflight' }))
  } catch (err) {
    failedChannels.push('postflight')
    note('postflight could not be carried: ' + (err && err.message) + ' — decisions since the last boundary were not recorded; a resume re-derives them')
    return result(checkpoint, null)
  }
}

// ---------------------------------------------------------------- the run

if (!effort || !execution) {
  return result({ reason: 'bad_input', detail: 'effort and execution (a UTC stamp minted by the session) are required' }, null)
}

phase('Preflight')
let pf
try {
  pf = await boundary('preflight', {
    root: rootId,
    retry_escalated: input.retry_escalated || [],
    confirmed_duplicate: input.confirmed_duplicate === true,
    confirmed_gaps: input.confirmed_gaps === true,
    plan_only: input.plan_only === true,
    dial: DIAL, pace, base_ref: input.base_ref || '', commands: input.commands || null,
  }, { phase: 'Preflight', label: 'preflight' })
} catch (err) {
  failedChannels.push('preflight')
  note('preflight could not be carried: ' + (err && err.message))
  return result({ reason: 'preflight_failed', detail: String(err && err.message) }, null)
}

if (pf.error) {
  note('preflight refused: ' + pf.error.message)
  return result({ reason: pf.error.kind || 'preflight_refused', detail: pf.error.message }, null)
}
invocation = pf.invocation
for (const d of pf.dirty_worktrees || []) note('dirty worktree left in place (never forced): ' + d)
const counts = pf.counts || {}
if (counts.gaps) note(counts.gaps + ' traceability gap(s): node "' + pluginRoot + '/lib/status.mjs" checkpoint lists them when they stop a run')
if (counts.untraced) note(counts.untraced + ' criterion/criteria tracing to no decision')
if (pf.checkpoint) {
  phase('Postflight')
  return finish(pf.checkpoint)
}

// The base branch moved under leaves not yet merged: an analyst rules each before anything runs,
// and only a leaf whose premise really moved waits for the user.
if (pf.stale) {
  const rulings = await rule('rule:stale', stalePrompt(pf.stale), 'Preflight')
  for (const id of pf.stale.nodes) {
    const r = rulings && rulings.get(id)
    if (r && r.ruling === 'unaffected') {
      note(id + ': the base moved under it; ruled unaffected — ' + r.why)
      records.push({ file: 'state', entry: { kind: 'stale-ruled', node: id, base_now: pf.stale.now, ruling: 'unaffected', why: r.why } })
    } else {
      park(id, 'premise_mismatch', r ? r.question
        : 'the base branch moved files ' + id + ' writes or reads (' + pf.stale.list + ') and no analyst could rule on it: is its plan entry still valid?')
    }
  }
}

log('execution ' + execution + ' of ' + rootId + ': ' + (counts.leaves || 0) + ' leaves planned, pool ' + pf.max_parallel +
  ', dial ' + DIAL + ', pace ' + pace)

const UNITS = {
  plan: (item) => planNode(item.row, item.why),
  leaf: (item) => runLeaf(item),
  merge: (item) => mergeInto(item),
  review: (item) => reviewComposite(item),
}

/**
 * A launch computed from what disk said when the tick was built, re-checked against what this
 * invocation decided while the tick was in flight: a node it stopped, a folder it began replanning.
 */
const stillLaunchable = (item) => {
  const id = item.id || item.target
  if (stoppedHere.has(id) || (item.waits_on || []).some((d) => stoppedHere.has(d))) return false
  return ![...planning].some((p) => p === id || p === '.' || id.startsWith(p + '/'))
}

phase('Execute')
for (;;) {
  // A unit leaves `running` only once the tick being built carries what it decided; one that ends
  // while this tick is in flight stays in `running`, so nothing is launched beneath it or twice,
  // and it wakes the loop at once for the next tick.
  for (const key of finished) running.delete(key)
  finished.clear()
  let tick
  // Every stop decided before this call rides in it, so the schedule computes over them; one it
  // launches anyway was answered on disk while the run went on — a re-spec or a session's retry.
  const carriedStops = new Set(stoppedHere)
  try {
    ticks++
    tick = await boundary('schedule', { running: [...running.keys()], planning: [...planning], stopping: Boolean(stopping) },
      { phase: 'Execute', label: 'schedule#' + ticks })
  } catch (err) {
    tick = { error: { message: String(err && err.message) } }
  }
  if (tick.error) {
    failedChannels.push('schedule')
    note('the schedule could not be carried: ' + tick.error.message + ' — starting nothing new, letting what runs finish')
    await Promise.allSettled([...running.values()])
    break
  }
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
