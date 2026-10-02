export const meta = {
  name: 'gather-evidence-without-concluding',
  description: 'Gather evidence about a question across the local repos, git history, and vendor documentation. Returns anchored evidence items plus a coverage block — never a conclusion.',
  whenToUse: 'The shared evidence phase for investigate, develop, find-existing-solutions and design. Call it via workflow("gather-evidence-without-concluding", args) as a nested step; it is rarely invoked directly.',
  phases: [
    { title: 'Reuse', detail: 'the project pool\'s items over this ground: standing ones are known ground, stale ones are searched again' },
    { title: 'Re-judge', detail: 'one tool-less analyst on the cheapest tier per twenty suspect items: does the change matter to the claim' },
    { title: 'Plan' },
    { title: 'Scout' },
    { title: 'History' },
    { title: 'Docs' },
    { title: 'Assemble context for analysis', detail: 'per judge, one script reads its scouts\' reports and their locations once into a file it Reads' },
    { title: 'Judge', detail: 'one analyst without search tools, unless volume or pace earns more' },
    { title: 'Record', detail: 'the judges\' files into the project-wide store; a refused item goes back to its judge' },
    { title: 'Context', detail: 'one file holding every item the survey returns, for its reader' },
  ],
}

// Design: docs/DESIGN.md#survey. Every agent whose output lib/ reads writes it to the return file
// its dispatch names and hands back only handles; every courier carries handles both ways
// (docs/DESIGN.md#gp6--couriers-carry-handles-data-stays-where-its-author-wrote-it). This script
// holds only what a script can hold without a filesystem: what to dispatch next, and what each
// typed return means.
//
// ---------------------------------------------------------------- schemas
//
// No minItems / maxItems / minLength / maxLength anywhere. Structured outputs do not
// support those constraints: they are stripped before the request or validated
// client-side, so a violation becomes a retry or a dropped result rather than a cap.
// Every bound below lives in the prompt as behaviour and is enforced in JS after the call.
//
// Field semantics go in `description`, never in a comment like this one. Comments are
// stripped before the schema reaches the model, so a contract written only in a comment
// binds nobody — and the coverage fields are load-bearing.

// The coverage contract every evidence-gathering agent answers to: the scouts, the historian
// and the doc-researcher alike. Completeness is DERIVED in JS from stop_reason, and a resume
// is driven by not_reached, so both come back in the structured return; what was searched and
// what was proven absent go to the return file, where the judge reads them.
//
// Every coverage field is ALWAYS present — an empty string is the correct value for "nothing
// to carry", and each description says so outright. Conditional wording ("must be non-empty
// whenever stop_reason is not exhausted") reads to an exhausted agent as "must be non-empty",
// so it omits the field it has nothing for, trips required-field validation, re-submits the
// same shape until the platform kills it, and a finished search is dropped whole.
const coverageFields = () => ({
  stop_reason: {
    type: 'string',
    enum: ['exhausted', 'unfinished', 'stuck'],
    description:
      'Always include this field, the same value as in your return file. "exhausted" — every ' +
      'candidate your searches turned up has been triaged and you can name the surface that ' +
      'covers the request. "unfinished" — one pass could not cover the surface; you are handing ' +
      'back an honest partial and the caller will resume you until the search is done. "stuck" — ' +
      'you could not find a way forward. Cost, effort already spent, and the size of your report ' +
      'are never reasons to stop. Only "exhausted" counts as a complete result, so claim it only ' +
      'when it is true.',
  },
  not_reached: {
    type: 'string',
    description:
      'What you never searched at all, the same text as in your return file, named specifically ' +
      'enough for someone else to pick it up. Send an empty string when stop_reason is ' +
      '"exhausted"; otherwise it must name what remains — a search you do not describe cannot ' +
      'be resumed and is recorded as a dead end. Never put what you searched and did not find here.',
  },
})

// Only the payload field goes in `required`. The coverage fields are demanded by their
// descriptions and normalized in JS after the call — never by the validator: a required
// field whose semantics are conditional is a deadlock. Absence is normalized in the safe
// direction: a missing stop_reason never reads as "exhausted", so sloppiness degrades toward
// incomplete, never toward false completeness.

const PLAN = {
  type: 'object',
  additionalProperties: false,
  required: ['topics', 'common_ground', 'docs_needed', 'history_needed'],
  properties: {
    topics: {
      type: 'array',
      description: 'The topics of your plan file, each by key and subtree only.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'subtree'],
        properties: {
          key: { type: 'string', description: 'The topic\'s key, as in the plan file: short kebab-case, unique within the plan.' },
          subtree: {
            type: 'string',
            description: 'The topic\'s subtree, as in the plan file: a repo-relative POSIX path, or an empty string for a repository-wide topic.',
          },
        },
      },
    },
    common_ground: { type: 'boolean', description: 'True when the plan file\'s common_ground is non-empty.' },
    docs_needed: { type: 'boolean', description: 'True when the plan file\'s docs_question is non-empty.' },
    history_needed: { type: 'boolean', description: 'True when the plan file\'s history_question is non-empty.' },
  },
}

const PLAN_FILE = '{"question": "<the QUESTION above, copied exactly>", "topics": [{"key": "<kebab-case>", ' +
  '"find": "<a precise instruction for a read-only search agent: what to find and where to look>", ' +
  '"subtree": "<repo-relative path, or empty for repository-wide>"}], "common_ground": "<an instruction, or empty>", ' +
  '"history_question": "<or empty>", "docs_question": "<or empty>"}'

const HITS = {
  type: 'object',
  additionalProperties: false,
  required: ['hits'],
  properties: {
    hits: {
      type: 'array',
      description: 'Every location in your return file, by path and line only.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'line'],
        properties: {
          path: { type: 'string', description: 'Path to the file containing the hit, relative to the repository it is in.' },
          line: { type: 'integer', description: 'Line number of the hit.' },
        },
      },
    },
    ...coverageFields(),
  },
}

const HITS_FILE = '{"hits": [{"path": "<repo-relative>", "line": <n>, "note": "<what is at that line, in one line>"}], ' +
  '"searched": ["<every pattern, glob and path you actually searched>"], ' +
  '"no_match": "<what you searched for and genuinely did not find — a finding; empty when none>", ' +
  '"not_reached": "<what you never searched; empty when exhausted>", "stop_reason": "exhausted|unfinished|stuck"}'

// History and docs report narrative evidence, so their file holds `findings` as prose. They answer
// the same coverage contract as the scouts anyway: without it, a channel that stalled halfway is
// indistinguishable from one that finished, because both arrive as a confident essay.
const CHANNEL = {
  type: 'object',
  additionalProperties: false,
  required: ['stop_reason'],
  properties: coverageFields(),
}

const channelFile = (findings, searched) => '{"findings": "' + findings + '", "searched": ["' + searched + '"], ' +
  '"no_match": "<what you looked for and did not find; empty when none>", ' +
  '"not_reached": "<what you never searched; empty when exhausted>", "stop_reason": "exhausted|unfinished|stuck"}'

const HISTORY_FILE = channelFile(
  '<the commits that matter, as your agent instructions format them: sha, date, author, subject, and the path:line of ' +
  'what changed; ruled-out candidates where they save the reader work; never a guessed commit>',
  '<every ref, path and date range you searched, with the git commands behind them>')

const DOCS_FILE = channelFile(
  '<the facts you established, each with the URL that owns it on the same line; a claim only a secondary source ' +
  'carries is marked unconfirmed>',
  '<every search query and URL you actually read>')

// What a courier hands back: one command's stdout, byte-exact, in one string. The shape of
// `execute-approved-plan-in-worktrees`'s CARRIED, copied rather than shared because a workflow script cannot
// import. This workflow moves no todos, so the two todo fields are left out of its shape.
//
// `failed` is the courier unable to run the command AT ALL — node missing, the path unreadable,
// the shell refusing. A program that ran and refused prints a payload saying so, which is read
// as the program's answer rather than as a transport failure.
const CARRIED = {
  type: 'object', additionalProperties: false,
  required: ['stop_reason', 'payload_raw', 'notes'],
  properties: {
    stop_reason: { type: 'string', enum: ['carried', 'failed'] },
    payload_raw: { type: 'string' },
    notes: { type: 'string' },
  },
}

// The kinds of claim an item can make, copied from lib/evidence.mjs (a script cannot import); the
// scenario suite pins the two equal. The kind decides which anchor the recorder demands.
const ITEM_KINDS = ['behaviour', 'absence', 'enumeration', 'relation', 'external', 'derived']

const ITEMS_FILE = '{"items": [{"topic": "<the topic key>", "kind": "' + ITEM_KINDS.join('|') + '", ' +
  '"claim": "<the one sentence this item asserts>", "spans": [{"path": "<repo-relative>", "start": <first line>, "end": <last line>}], ' +
  '"queries": [{"pattern": "<an extended regex, as git grep -E takes it>", "scope": ["<repo-relative paths; empty for the whole repository>"]}], ' +
  '"sources": [{"url": "<the URL or package you read>", "version": "<its version; empty when unversioned>"}], ' +
  '"rests_on": ["<for a derived item: the exact claims of the items here it is drawn from, or ids of ESTABLISHED items>"]}], ' +
  '"risks": [{"topic": "<the topic key>", "text": "<why a topic cannot be anchored, or an inadequate search surface>"}]}'

// One judge may hold several topics, so its handles come back per topic, under a closed enum built
// per dispatch: a key it was not given cannot be where a count lands.
function rulingsSchema(keys) {
  return {
    type: 'object', additionalProperties: false, required: ['topics'],
    properties: {
      topics: {
        type: 'array',
        description: 'One entry per topic your return file rules on: how many items and risks you wrote for it.',
        items: {
          type: 'object', additionalProperties: false, required: ['topic', 'items_n', 'risks_n'],
          properties: {
            topic: { type: 'string', enum: keys, description: 'The topic key, copied exactly.' },
            items_n: { type: 'integer', description: 'How many items your return file holds for this topic.' },
            risks_n: { type: 'integer', description: 'How many risks your return file holds for this topic.' },
          },
        },
      },
    },
  }
}

const WRITTEN = {
  type: 'object', additionalProperties: false, required: ['written_n'],
  properties: { written_n: { type: 'integer', description: 'How many entries your return file holds.' } },
}

// ---------------------------------------------------------------- inputs

const input = typeof args === 'string' ? { question: args } : (args || {})
// Trimmed: the blank-question guard below tests truthiness, and a question of spaces is
// truthy — it would buy a judge-tier planner call before dying at the zero-topics exit.
const question = (input.question || '').trim()
const roots = input.roots || '.'
const notes = input.notes || ''
const maxTopics = input.max_topics || 8

// What an earlier phase of the same effort found, read out of the effort's evidence by the
// session that invoked this survey. It is DURABLE SCRATCH and it reaches exactly one place: the
// planner's prompt, where it can only change how the ground is decomposed. It reaches no scout,
// no judge and no gate — prior context has no anchor and nothing checked it. What CAN stand in for
// searching a claim again is a pool item git says is still standing, and that is computed below.
const prior = typeof input.prior === 'string' ? input.prior.trim() : ''

// The intelligence dial. Three positions, each naming the judging tier rather than inheriting
// it: `low` is sonnet, `normal` is opus, `max` is opus one effort step deeper. The judging tier
// in this workflow is the analysts — the one that plans the topics and the ones that rule on them.
// A position this script did not recognise is served as `normal`: dispatching at one tier while
// the caller reports the one it typed bills a run at one price and describes it at another.
const JUDGE_TIER = { low: { model: 'sonnet' }, normal: { model: 'opus' }, max: { model: 'opus' } }
const intelligence = Object.hasOwn(JUDGE_TIER, input.intelligence) ? input.intelligence : 'normal'
const judge = JUDGE_TIER[intelligence]

// Effort follows the model a judging dispatch resolves to: opus at medium, one step up at `max`;
// sonnet one step above the call site's base.
const SONNET_STEP = { low: 'low', medium: 'high', high: 'xhigh' }
const tiered = (tier, base) => ({
  ...tier,
  effort: tier.model === 'sonnet' ? SONNET_STEP[base] : intelligence === 'max' ? 'high' : 'medium',
})

// `pace` decides how many readers share one body of evidence. Parallel readers over the same
// excerpts multiply cost, so they are bought for speed only when the caller says `fast`.
const PACES = ['frugal', 'balanced', 'fast']
const pace = PACES.includes(input.pace) ? input.pace : 'balanced'

// A repo-relative path as the ground is spelled everywhere: forward slashes, no leading `./`, no
// trailing slash, and `.` for the repository as a whole.
const groundPath = (p) => {
  const norm = String(p == null ? '' : p).split('\\').join('/').trim()
    .replace(/^\.\//, '').replace(/\/+$/, '')
  return norm === '' ? '.' : norm
}

// The ground the caller wants this survey's evidence anchored to. It is what the pool is read
// by (Reuse), and what the result's one context file lists the reused items from.
const callerGround = [...new Set((Array.isArray(input.ground) ? input.ground
  : typeof input.ground === 'string' && input.ground.trim() ? input.ground.split(/[,;\n]/) : [])
  .map(groundPath))]

// Where `lib/` lives: the caller's value, then the environment, then the shell form expanded in
// the courier's own shell. A script's cwd is not the agent's, so a relative path is never guessed.
const SHELL_ROOT = '$CLAUDE_PLUGIN_ROOT'

function resolvePluginRoot() {
  if (typeof input.plugin_root === 'string' && input.plugin_root.trim()) {
    return input.plugin_root.trim().split('\\').join('/')
  }

  const fromEnv = typeof process !== 'undefined' && process && process.env
    ? process.env.CLAUDE_PLUGIN_ROOT
    : ''

  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim().split('\\').join('/')
  return SHELL_ROOT
}

const pluginRoot = resolvePluginRoot()

// Excerpts and efforts are per repository, so a question spanning several roots resolves against
// the first — the repository it is anchored in. This is also the working root every pool read,
// judge and record passes to lib/evidence.mjs: a survey run from a linked worktree derives its
// pool's states, re-anchors a holds and anchors what its judges read there.
const repo = String(roots).split(/[,;\n]/)[0].trim() || '.'

// ---------------------------------------------------------------- handles
//
// A handle goes into a courier's command inside double quotes, so a value holding a quote, a
// shell metacharacter or a line break is never sent: what it names is searched or read some other
// way, and the log says so.
const QUOTABLE = new RegExp('^[^"`$\\\\\\r\\n]*$')
const quotable = (value) => QUOTABLE.test(String(value))

// Topic keys are the planner's words and become labels, enum values and argv handles, so each is
// spelled as a slug; the plan file keeps the planner's own spelling, which a prompt names.
const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'topic'

// ---------------------------------------------------------------- the transport
//
// A payload computed on disk arrives through a model, so it is re-digested here before a field of
// it is believed. canonical and fnv1a are copies of `lib/plan-digest.mjs`'s: scripts cannot import,
// and the suite pins them together.
function canonical(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'

  return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
    .join(',') + '}'
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

/** What a courier carried back: the payload, or why it cannot be believed and how to retry. */
function carriedRead(held) {
  if (!held) return { payload: null, why: 'the dispatch returned nothing', retry: 'again' }
  // What the program printed decides. The courier's `stop_reason` is read only where it printed
  // nothing to decide by, because a courier may call a typed refusal a failed run.
  const notRun = held.stop_reason !== 'carried'
    ? { payload: null, why: held.notes || 'the courier could not run the command', retry: 'again' }
    : null

  let parsed = null
  try {
    parsed = JSON.parse(held.payload_raw)
  } catch (e) {
    return notRun || { payload: null, why: 'it did not survive transcription: ' + (e && e.message), retry: 'stronger' }
  }

  if (parsed && parsed.error) return { payload: null, why: 'the program failed: ' + parsed.error, retry: '' }
  if (!parsed || !parsed.payload || typeof parsed.payload_digest !== 'string') {
    return notRun || { payload: null, why: 'what came back is not a digest-covered envelope', retry: 'stronger' }
  }

  const actual = fnv1a(canonical(parsed.payload))
  if (actual !== parsed.payload_digest) {
    return {
      payload: null,
      why: 'digest mismatch: it was computed as ' + parsed.payload_digest +
        ', what arrived digests to ' + actual,
      retry: 'stronger',
    }
  }

  return { payload: parsed.payload, why: '', retry: '' }
}

const COURIER = { model: 'haiku', effort: 'low' }
const COURIER_UP = { model: 'sonnet', effort: 'low' }
// The refusal that means a handle was damaged on its way in, not that the program failed.
const DAMAGED_IN = ['args_unreadable']

function courierPrompt(command) {
  return 'Run exactly this one command, unchanged, and put its entire stdout in payload_raw:\n\n' + command +
    '\n\nMove no todos.' +
    (pluginRoot === SHELL_ROOT
      ? '\nIf ' + SHELL_ROOT + ' is empty in your shell, do not guess a path: set stop_reason ' +
        '"failed" and say so.'
      : '')
}

/**
 * Carry one command's payload, believed only after its digest.
 *
 * Retries are sized to what was observed, as `execute-approved-plan-in-worktrees`'s boundaries
 * size them: a courier that returned nothing or could not run the command is run again once; a
 * payload damaged in transit buys one refetch on a stronger model, and so does a handle the
 * program refused as damaged on its way in; a program failure is not retried. What stays
 * unbelievable comes back as `{payload: null, why}` — every carry in this workflow is a side
 * channel with a fallback, so none of them may throw.
 */
async function carry(command, label, phaseName) {
  const ladder = [COURIER]
  let why = ''

  for (let i = 0; i < ladder.length; i++) {
    const held = await agent(courierPrompt(command), {
      agentType: 'agentics:courier', schema: CARRIED, phase: phaseName,
      label: label + (i ? '#' + (i + 1) : ''), ...ladder[i],
    }).catch((e) => {
      why = 'the courier threw: ' + (e && e.message)
      return null
    })

    const c = carriedRead(held)
    if (c.payload) {
      const refused = c.payload.ok === false && c.payload.error
      if (refused && DAMAGED_IN.includes(c.payload.error.kind) && !ladder.includes(COURIER_UP)) {
        why = 'a handle was damaged on its way in (' + c.payload.error.kind + ')'
        ladder.push(COURIER_UP)
        continue
      }
      if (refused) return { payload: null, why: 'the program refused: ' + c.payload.error.kind }
      return { payload: c.payload, why: '' }
    }

    why = c.why || why
    if (c.retry === 'again' && ladder.length < 2) ladder.push(COURIER)
    else if (c.retry === 'stronger' && !ladder.includes(COURIER_UP)) ladder.push(COURIER_UP)
  }

  return { payload: null, why }
}

const lib = (cli, verb) => `node "${pluginRoot}/lib/${cli}.mjs" ${verb} --repo "${repo}"`
const flags = (name, values) => values.map((v) => `--${name} "${v}"`).join(' ')

// ---------------------------------------------------------------- return files
//
// An agent whose output lib/ reads writes it to a return file under the working root, named by its
// dispatch label, bounded by nameKey, and the digest of what it was handed, so a retried dispatch
// rewrites the same file.
// A workflow has no clock and no randomness, so nothing else could name it.
const INBOX = `${repo}/.agentics/.state/evidence/inbox`

const returnFile = (label, body) => `${INBOX}/${nameKey(label.replace(/[^A-Za-z0-9.-]+/g, '-'))}-${fnv1a(body)}.json`

/** A dispatch body with its return file named, and the shape that file takes. */
const toFile = (body, file, shape) => body +
  `\n\nRETURN FILE — write your full return to ${file} as one JSON object of exactly this shape:\n${shape}\n` +
  'Then return only what your schema asks for.'

// The re-judge is the stated exception to the intelligence dial: it is always the cheapest tier,
// however the caller dialled the judging analysts.
const REJUDGE = { model: 'haiku', effort: 'low' }
const REJUDGE_BATCH = 20

// ---------------------------------------------------------------- coverage
//
// IRON LAW §4 as a data structure. `complete` is DERIVED here and never taken from an
// agent: an agent cannot assert its own completeness, because that is exactly the
// laundering §2 forbids.

// The runtime does not expose a workflow's own run id to its script, so it cannot be
// written into `resumable` — and a null there is indistinguishable from a field nobody
// filled in. The Workflow launch result carries the real id; the caller records it at
// launch and pairs it with `remaining`.
const RUN_ID = 'unknown-to-script: pair `remaining` with the runId from the Workflow launch result'

// The launch arguments, echoed into every coverage block. A resume re-executes this script
// and reads nothing from the prior run, so a caller who resumes without re-passing them gets
// a survey with no question. They travel with the block a caller actually reads when deciding
// how to resume.
const LAUNCH_ARGS = {
  question, roots, notes, prior, max_topics: maxTopics, intelligence, pace, plugin_root: pluginRoot,
  ground: callerGround,
}

const RESUME_NOTE = 'a resume must re-pass `args` alongside resumeFromRunId — the script is ' +
  're-executed and reads nothing from the prior run; `args` here is that object'

function coverageOf(dropped, incomplete, failedChannels, unreached) {
  return {
    complete:
      dropped.length === 0 &&
      incomplete.length === 0 &&
      failedChannels.length === 0 &&
      unreached.length === 0,
    dropped,
    incomplete,
    failed_channels: failedChannels,
    unreached,
    resumable: { runId: RUN_ID, remaining: dropped.concat(incomplete),
                 args: LAUNCH_ARGS, note: RESUME_NOTE },
  }
}

// Every exit path below returns this shape. A caller that receives `undefined` cannot tell
// "nothing found" from "nothing ran", and that is the failure this plugin exists to prevent.
//
// `items` are handles; `context` is the one file holding every one of them in full, the judges'
// risks and the history and docs channels, for whoever reads the evidence next. `ground` is the
// subtrees the topics searched, `.` for a repository-wide topic — not the ground of a reused item,
// which is not ground this survey searched.
function surveyResult({
  topics = [], ground = [], items = [], reused = [], unrecorded = [], context = '', risks = [], history = null,
  docs = null, coverageBlock,
}) {
  return { question, topics, ground, items, reused, unrecorded, context, risks, history, docs, coverage: coverageBlock }
}

if (!question) {
  return surveyResult({ coverageBlock: coverageOf([], [], [], ['no question was supplied, so nothing was searched']) })
}

log(`Question: ${question}`)

// -------------------------------------------------------- 0. reuse and re-judge
//
// Before planning, the survey reads the project's pool for items whose ground overlaps the
// caller's. Standing ones are known ground the planner and the judges read so they do not
// re-buy it; suspect ones get the cheapest re-judge there is, on whether the change matters to
// the claim; stale ones — never re-checked, or still suspect after the re-judge — send their
// topic to a narrowed re-survey. Whether text changed is never a model's call: that arithmetic is
// lib/evidence.mjs's, deterministic and free of judgment (D20).

/** The survey items over the caller's ground, as handles, and the file holding what they say. */
async function readPool(label) {
  const held = await carry(
    `${lib('evidence', 'items')} --root "${repo}" --ground "${callerGround.join(',')}" --states standing,suspect,stale --return-kind survey`,
    label, 'Reuse')
  if (!held.payload || !Array.isArray(held.payload.items)) return null
  return { items: held.payload.items.filter(Boolean), context: held.payload.context || '' }
}

/** A stale item a newer standing item of its topic, on ground it shares, has already replaced. */
const supersededBy = (known) => (it) => known.some((k) =>
  k.topic === it.topic && (k.seq || 0) > (it.seq || 0) && (k.ground || []).some((g) => (it.ground || []).includes(g)))

/** Drop every stale item a newer standing item of its topic has already replaced (spec §4.9): a
 * narrowed re-survey's items take new ids, so the stale item they replaced stays in the pool, and
 * without this every later survey would search its topic again. */
function finishReuse(known, stale, context) {
  const kept = stale.filter((it) => !supersededBy(known)(it))
  if (kept.length < stale.length) {
    log(`Reuse: ${stale.length - kept.length} stale item(s) already replaced by a newer standing item; not re-surveyed.`)
  }
  return { known, stale: kept, context }
}

async function reusePool() {
  if (callerGround.length === 0) return { known: [], stale: [], context: '' }
  if (callerGround.some((g) => !quotable(g) || g.includes(','))) {
    log('Reuse: the caller\'s ground cannot be carried to the pool as a command argument; surveying in full.')
    return { known: [], stale: [], context: '' }
  }

  phase('Reuse')
  const pool = await readPool('reuse')
  if (!pool) {
    log('Reuse: the project pool could not be read; surveying in full.')
    return { known: [], stale: [], context: '' }
  }

  const standing = pool.items.filter((it) => it.state === 'standing')
  const suspect = pool.items.filter((it) => it.state === 'suspect')
  const stale = pool.items.filter((it) => it.state === 'stale')

  if (suspect.length === 0) return finishReuse(standing, stale, pool.context)

  await rejudge(suspect, pool.context)
  const after = await readPool('reuse-after')

  if (!after) return finishReuse(standing, stale.concat(suspect), pool.context)
  const byId = new Map(after.items.map((it) => [it.id, it]))
  let known = standing
  let allStale = stale
  for (const it of suspect) {
    const second = byId.get(it.id)
    if (second && second.state === 'standing') known = known.concat([second])
    else allStale = allStale.concat([it])
  }
  return finishReuse(known, allStale, after.context)
}

/** One re-judge batch: the analyst writes its verdicts to a file, and a courier hands lib that
 * file and the batch's ids. lib records an id with no verdict, or a file never written, as unsure. */
async function rejudgeBatch(batch, n, context) {
  const label = 'rejudge:' + n
  const body = `Some evidence items already recorded rest on text that has since changed. Whether the ` +
    `text changed is already decided — you judge only whether the change MATTERS to the claim. ` +
    `"unsure" is never a pass: it sends the claim to be searched again, so use it only when you ` +
    `truly cannot tell.\n\n` +
    `Read ${context}: under SUSPECT it lists each item with its claim and, for each anchor that ` +
    `changed, the old text and the new. Judge exactly these items, every one of them, from what ` +
    `is there; open no other file:\n${batch.map((it) => it.id).join(', ')}`
  const file = returnFile(label, body)
  await agent(toFile(body, file,
    '{"judgements": [{"id": "<the item id, copied exactly>", "verdict": "holds|fails|unsure", "why": "<one line>"}]}'), {
    agentType: 'agentics:analyst', schema: WRITTEN, phase: 'Re-judge', label, ...REJUDGE,
  }).catch((e) => {
    log(`${label}: the analyst failed (${e && e.message}); lib records its items as unsure.`)
    return null
  })

  const held = await carry(
    `${lib('evidence', 'judge')} --root "${repo}" --from "${file}" ${batch.map((it) => '--id ' + it.id).join(' ')}`,
    'record-judgements:' + n, 'Re-judge')
  if (!held.payload) log(`record-judgements:${n}: could not be recorded (${held.why}); those items stay suspect.`)
}

/** Suspect items, re-judged in batches of REJUDGE_BATCH, in parallel, on the cheapest tier. */
async function rejudge(items, context) {
  phase('Re-judge')
  const batches = []
  for (let i = 0; i < items.length; i += REJUDGE_BATCH) batches.push(items.slice(i, i + REJUDGE_BATCH))
  await parallel(batches.map((batch, i) => () => rejudgeBatch(batch, i + 1, context)))
}

/** The topics a narrowed re-survey searches again: one per stale topic, at its first item's ground. */
function staleTopics(stale) {
  const byKey = new Map()
  for (const it of stale) {
    if (!byKey.has(it.topic)) byKey.set(it.topic, { key: it.topic, subtree: groundPath((it.ground || [])[0] || ''), forced: true })
  }
  return [...byKey.values()].map((t) => ({ ...t, subtree: t.subtree === '.' ? '' : t.subtree }))
}

const reuse = await reusePool()
const known = reuse.known
const pool = reuse.context
const forced = staleTopics(reuse.stale)

// ---------------------------------------------------------------- the one file a reader opens

/**
 * Every item this survey returns, in one file lib writes for whoever reads the evidence next: the
 * standing items over the caller's ground, every item a record of this survey stored, the judges'
 * risks and the history and docs channels' reports. Null when it could not be carried.
 */
async function writeContext({ returns = [], judgeFiles = [], history = [], docs = [] }) {
  if (known.length === 0 && returns.length + judgeFiles.length + history.length + docs.length === 0) {
    return { items: [], context: '' }
  }
  phase('Context')
  const ground = known.length > 0 ? ` --ground "${callerGround.join(',')}" --return-kind survey` : ''
  const held = await carry(
    `${lib('evidence', 'context')} --root "${repo}"${ground} ${returns.map((r) => '--return ' + r).join(' ')} ` +
      `${flags('from', judgeFiles)} ${flags('history', history)} ${flags('docs', docs)}`.replace(/\s+$/, ''),
    'context', 'Context')
  if (!held.payload || !Array.isArray(held.payload.items)) {
    log(`WARNING: the survey's context file could not be written (${held.why}).`)
    return null
  }
  return { items: held.payload.items, context: held.payload.context || '' }
}

const CONTEXT_LOST = 'the one file holding every item this survey returns could not be written, so its reader ' +
  'holds the item ids and nothing they say'

/** An early exit's result: the reused items only, in their file. */
async function reusedOnly(coverageArgs) {
  const ctx = known.length > 0 ? await writeContext({}) : { items: [], context: '' }
  const [dropped, incomplete, failed, unreached] = coverageArgs
  return surveyResult({
    items: ctx ? ctx.items.map(({ id, topic, kind, state }) => ({ id, topic, kind, state })) : known.map(({ id, topic, kind, state }) => ({ id, topic, kind, state })),
    reused: known.map((i) => i.id),
    context: ctx ? ctx.context : '',
    coverageBlock: coverageOf(dropped, incomplete, ctx ? failed : failed.concat(['context']), ctx ? unreached : unreached.concat([CONTEXT_LOST])),
  })
}

// ---------------------------------------------------------------- 1. plan

phase('Plan')

const planBody =
  `Break this investigation into at most ${maxTopics} independent search topics.\n\n` +
  `QUESTION: ${question}\n` +
  `REPOSITORIES: ${roots}\n` +
  (notes ? `BACKGROUND SUPPLIED BY THE USER:\n${notes}\n` : '') +
  (prior
    ? `\nWHAT AN EARLIER PASS OF THIS SAME EFFORT FOUND. These are somebody's notes, not ` +
      `evidence: nothing here was checked against the current tree, nothing anchors it, and the ` +
      `code may have moved since. Use it to aim the decomposition — it tells you where the last ` +
      `pass ended up looking — and NEVER to decide a topic does not need searching. A topic ` +
      `these notes appear to answer is still a topic, and the search that covers it will either ` +
      `confirm them or find they went stale:\n${prior}\n`
    : '') +
  (known.length
    ? `\nESTABLISHED — evidence items already in the project's pool for this ground, each ` +
      `anchored and still standing: the ones listed under STANDING in ${pool}. Plan no topic ` +
      `these already answer; plan only what they leave open. When they answer the question, ` +
      `plan no topics.\n`
    : '') +
  (forced.length
    ? `\nRE-SURVEYED — these topics are searched again whatever you plan, because what was ` +
      `recorded for them no longer holds. Do not plan them again: ${forced.map((t) => t.key).join(', ')}\n`
    : '') +
  `\nEach topic must be answerable by searching the current code on its own, with no ` +
  `dependency on the other topics — the shared ground below is the one exception to that, ` +
  `because it reaches every judge. Give each a short kebab-case key and a precise ` +
  `instruction for a read-only search agent: what to find, and where to look. Size each ` +
  `topic so a single search agent can exhaust it in one pass — one subsystem, one named ` +
  `concern. Prefer more, smaller topics over one merged catch-all: a kitchen-sink topic ` +
  `forces a partial first pass, and everything later is built on what these searches ` +
  `return.\n\n` +
  `Give every topic a subtree: the one directory or file it is about, repo-relative, or an ` +
  `empty string when the topic is genuinely repository-wide. It becomes the ground of every ` +
  `item this topic's judge returns, so a path naming the topic's real ground is what lets a ` +
  `later survey over overlapping ground find those items and reuse them.\n\n` +
  `When several topics would each need to read the same files, do NOT fold that surface ` +
  `into each of them. Name it once in common_ground, as a precise instruction for a single ` +
  `search agent: it is searched once, and every judge receives what it finds alongside the ` +
  `topics. Then confine each topic's instruction to what is unique to that topic. Leave it ` +
  `empty when the topics genuinely share no ground.\n\n` +
  `Write history_question if answering the question requires git history rather than the ` +
  `current tree: when a behaviour changed, which commit introduced or removed something, ` +
  `why code is the way it is, or any regression. A search of the current tree cannot answer ` +
  `these, so leaving it empty when it is needed produces a confident wrong answer.\n\n` +
  `Write docs_question only if answering the question requires vendor or standards ` +
  `documentation that is not in these repositories.\n\n` +
  `Copy the QUESTION into the file exactly as it is written above: the store records every item ` +
  `under it and checks your copy against it.\n` +
  `Do not search anything yourself. Plan only.`

const planFile = returnFile('plan', planBody)

const plan = await agent(toFile(planBody, planFile, PLAN_FILE), {
  agentType: 'agentics:analyst', schema: PLAN, phase: 'Plan', label: 'plan', ...tiered(judge, 'medium'),
}).catch((e) => {
  log(`WARNING: planning failed: ${e && e.message}`)
  return null
})

if (!plan) {
  return reusedOnly([forced.map((t) => t.key), [], [], ['planning failed, so nothing was searched']])
}

const plannedRaw = Array.isArray(plan.topics) ? plan.topics.filter((t) => t && t.key) : []

// The cap in the prompt is sizing guidance to the planner, never a licence to drop work:
// every topic the planner decided the question needs gets searched. Slicing the overflow off
// produced runs whose plans rested on evidence nobody gathered. Cost is controlled by method —
// cheap scouts, tight schemas — not by cutting work (§8).
if (plannedRaw.length > maxTopics) {
  log(`Planner returned ${plannedRaw.length} topics (asked for at most ${maxTopics}); searching all of them.`)
}

const forcedKeys = new Set(forced.map((t) => t.key))
const taken = new Set(forcedKeys)
const planned = []
for (const t of plannedRaw) {
  let key = slug(t.key)
  if (forcedKeys.has(key)) {
    log(`Plan: topic "${key}" is already forced by a stale item; the planner's copy is dropped.`)
    continue
  }
  for (let n = 2; taken.has(key); n++) key = slug(t.key) + '-' + n
  taken.add(key)
  planned.push({ key, planKey: String(t.key), subtree: typeof t.subtree === 'string' ? t.subtree : '', forced: false })
}
const topics = forced.concat(planned)
const commonPlanned = plan.common_ground === true

log(`Plan: ${topics.length} topic(s)` +
    `${commonPlanned ? ' + common ground' : ''}` +
    `${plan.history_needed ? ' + git history' : ''}` +
    `${plan.docs_needed ? ' + documentation' : ''}`)

if (topics.length === 0 && known.length > 0) {
  log('The pool\'s standing items answer the question: nothing left to search.')
  return reusedOnly([[], [], [], []])
}

if (topics.length === 0) {
  return surveyResult({ coverageBlock: coverageOf([], [], [], ['planning produced no topics, so nothing was searched']) })
}

/** What a topic's scout is charged with, as its prompt names it: its plan entry, or the stale claims it re-establishes. */
const chargeOf = (topic) => topic.forced
  ? `Re-establish from the current code what the recorded claims of topic "${topic.key}" said about ` +
    `${topic.subtree ? topic.subtree : 'the repository'}. They are listed under that topic in ${pool} ` +
    `(under STALE or SUSPECT); none of them holds as recorded any more, so find what is true now.`
  : topic.key === 'common-ground' && topic.common
    ? `Your charge is the common_ground instruction in the plan file ${planFile}. Read it, and ` +
      `search exactly what it says.`
    : `Your charge is the topic keyed "${topic.planKey}" in the plan file ${planFile}. Read it, and ` +
      `search exactly what that topic's find says.`

// ---------------------------------------------------------- 2. the resume engine
//
// Drives one evidence agent to exhaustion (IRON LAW §3): the scouts, the historian and the
// doc-researcher all go through here. Every stop condition is about the GOAL, and none is a
// counter or a budget (§1): the loop ends when the agent exhausts the surface, when it
// dead-ends without naming what is left, when a round errors out, or when a round covers no
// new ground — the observable form of "stuck". Cost never ends it.
//
// `absorb(found)` folds one round into the caller's accumulators and returns true when the
// round gained new ground. Progress is judged on evidence actually gained, never on the
// agent's account of itself.

// A remainder, normalized for comparison. Whitespace and case only: two differently-worded
// descriptions of the same unreached surface are the same surface.
const remainderKey = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * One evidence agent, round by round. Each round writes its own return file; a continuation names
 * every earlier round's file, for what was searched and found, and the remainder the last one named.
 */
async function resumeToExhaustion({ key, label, charge, shape, launch, absorb }) {
  const files = []
  let round = 0
  let prevRemainder = null
  for (;;) {
    round++
    const body = round === 1
      ? charge
      : `Continue an unfinished search — do not start over.\n\nORIGINAL REQUEST:\n${charge}\n\n` +
        `YOUR EARLIER ROUNDS' REPORTS — read them first: do not repeat what they searched, and do ` +
        `not report again what they found:\n${files.join('\n')}\n\n` +
        `STILL NOT REACHED — this is your job now:\n${prevRemainder}`
    const roundLabel = label + (round > 1 ? `#${round}` : '')
    const file = returnFile(roundLabel, body)
    let found
    try {
      found = await launch(toFile(body, file, shape), roundLabel)
    } catch (e) {
      log(`${key}: round ${round} threw (${e && e.message}); keeping what was found.`)
      return { files, exhausted: false, notReached: `round ${round} failed before completion: ${e && e.message}` }
    }
    if (!found) {
      log(`${key}: round ${round} returned nothing; keeping what was found.`)
      return { files, exhausted: false, notReached: `round ${round} produced no result` }
    }
    files.push(file)
    const progressed = absorb(found)

    if (found.stop_reason === 'exhausted') return { files, exhausted: true, notReached: '' }

    // Not exhausted but nothing named as unreached: another round would be handed an empty
    // task and would return "exhausted" having done nothing. Treat it as the dead end it is
    // rather than paying for a round that launders it into completeness.
    const remainder = String(found.not_reached || '').trim()
    if (!remainder) {
      const reason = found.stop_reason || 'unstated'
      log(`${key}: stop_reason "${reason}" with nothing named as unreached — treating as a dead end.`)
      return { files, exhausted: false, notReached: `search stopped as "${reason}" without naming what was missed` }
    }

    // Two independent ways a round can advance: it brought back evidence nobody had, or it
    // narrowed the surface still to cover. An agent told not to repeat itself rewords its
    // account of the same ground every round — and left alone that runs until something
    // outside the workflow kills it.
    const narrowed = prevRemainder === null || remainderKey(remainder) !== remainderKey(prevRemainder)
    prevRemainder = remainder
    if (!progressed && !narrowed) {
      log(`${key}: round ${round} brought back nothing new and left the same ground unreached — ` +
        `stopping as stuck rather than looping.`)
      return { files, exhausted: false, notReached: remainder }
    }

    log(`${key}: unfinished after round ${round} (${found.stop_reason || 'unstated'}), resuming.`)
  }
}

// ------------------------------------------------- 3. history and docs
//
// Both run alongside the scouts, through the same resume engine. IRON LAW §5: a side-channel
// failure must not discard the scout and judge work already paid for, so nothing here rejects.
// Their reports are prose, so a round's progress is the remainder it narrowed.

function sideChannel(name, needed, launch) {
  if (!needed) return Promise.resolve({ requested: false, result: null, error: '' })
  return launch().then(
    (result) => result
      ? { requested: true, result, error: '' }
      : { requested: true, result: null, error: 'the agent returned no result' },
    (e) => {
      log(`WARNING: ${name} failed: ${e && e.message}`)
      return { requested: true, result: null, error: (e && e.message) || 'unknown error' }
    },
  )
}

async function channelToExhaustion({ key, charge, shape, agentType, phaseName }) {
  const end = await resumeToExhaustion({
    key, label: key, charge, shape,
    launch: (prompt, label) => agent(prompt, { agentType, effort: 'low', schema: CHANNEL, phase: phaseName, label }),
    absorb: () => false,
  })
  return end.files.length === 0 ? null : end
}

const historyChannel = sideChannel('git history search', plan.history_needed === true, () => channelToExhaustion({
  key: 'history', agentType: 'agentics:historian', phaseName: 'History', shape: HISTORY_FILE,
  charge: `Your question is the history_question in the plan file ${planFile}. Read it.\n\n` +
    `Repositories: ${roots}\nContext: ${question}\n\n` +
    `If the plan file's history_question is empty, search nothing: set stop_reason "stuck" and say so.`,
}))

const docsChannel = sideChannel('documentation research', plan.docs_needed === true, () => channelToExhaustion({
  key: 'docs', agentType: 'agentics:doc-researcher', phaseName: 'Docs', shape: DOCS_FILE,
  charge: `Research the docs_question in the plan file ${planFile} against primary sources and ` +
    `report the facts with URLs. Read it first.\n\nContext: ${question}\n\n` +
    `If the plan file's docs_question is empty, search nothing: set stop_reason "stuck" and say so.`,
}))

// -------------------------------------------------------------- 4. scout

phase('Scout')

const partial = []
const locKey = (h) => String(h.path).split('\\').join('/') + ':' + (Number.isInteger(h.line) ? h.line : 0)

// Search to exhaustion. IRON LAW §3: an incomplete scout is RESUMED, never reported as a
// result. The engine owns the stop conditions; this wrapper owns what a scout accumulates —
// its distinct locations, which double as the engine's progress measure.
async function scoutUntilComplete(topic) {
  const hits = []
  const seen = new Set()

  // Progress is HITS, not lines of self-report: a scout told not to repeat itself keeps
  // producing fresh descriptions of ground it has already covered.
  const absorb = (found) => {
    const fresh = (Array.isArray(found.hits) ? found.hits : []).filter((h) => h && !seen.has(locKey(h)))
    for (const h of fresh) {
      seen.add(locKey(h))
      hits.push(h)
    }
    return fresh.length > 0
  }

  // The shared ground is searched once, by its own scout, so every other scout is told to
  // leave it alone. The common scout itself is never handed the exclusion.
  const exclude = commonPlanned && !topic.common
    ? `\n\nA separate scout covers the common_ground instruction in the plan file ${planFile} — do not search that.`
    : ''

  const charge = `${chargeOf(topic)}${exclude}\n\nRepositories: ${roots}\n\n` +
    `Report every location you find, and search to exhaustion: you stop when the surface ` +
    `is covered or you are genuinely stuck, never because the list is getting long or ` +
    `the work feels large. If one pass truly cannot cover the request, report what you ` +
    `have, set stop_reason to "unfinished", and name exactly what remains in ` +
    `not_reached — you will be resumed until the search is done.`

  const end = await resumeToExhaustion({
    key: topic.key, label: `scout:${topic.key}`, charge, shape: HITS_FILE,
    launch: (prompt, label) => agent(prompt, { agentType: 'agentics:scout', effort: 'low', schema: HITS, phase: 'Scout', label }),
    absorb,
  })
  if (!end.exhausted) partial.push(topic.key)

  return { hits, files: end.files, complete: end.exhausted, notReached: end.notReached }
}

// The shared scout runs alongside the topic scouts. It is an ordinary scout in every other
// respect — same labels, same phase, same resume to exhaustion, and the same entry in `partial`
// when it does not get there.
const commonGround = commonPlanned
  ? scoutUntilComplete({ key: 'common-ground', common: true }).catch((e) => {
    log(`WARNING: the shared-ground scout failed: ${e && e.message}`)
    partial.push('common-ground')
    return null
  })
  : Promise.resolve(null)

const scouted = await parallel(topics.map((topic) => () => scoutUntilComplete(topic)))
const common = await commonGround

// ------------------------------------------------------------ 5. who judges what
//
// One analyst without search tools judges every topic — one reader per body of evidence. More
// are bought only when the volume would not fit one reader's attention, or when the caller set
// `pace: fast` and pays for wall-clock with parallel readers. Volume is counted in distinct
// locations, because the split is decided before any excerpt is read.

const LOCATIONS_PER_JUDGE = 60

const distinct = (hits) => new Set(hits.map(locKey)).size
const scoutOf = (topic) => scouted[topics.indexOf(topic)]
const commonHits = common ? common.hits : []
const judged = topics.filter((t) => scoutOf(t))
const hitsOf = (group) => group.flatMap((t) => scoutOf(t).hits).concat(commonHits)
const total = distinct(hitsOf(judged))

let groups
if (judged.length === 0) {
  groups = []
} else if (pace === 'fast') {
  groups = judged.map((t) => [t])
  log(`Judge: pace is fast, so ${groups.length} analyst(s), one per topic, over ${total} ` +
    `location(s) — readers bought for wall-clock, each paying for the shared ground.`)
} else {
  const readers = Math.min(judged.length, Math.max(1, Math.ceil(total / LOCATIONS_PER_JUDGE)))

  // Heaviest topic first onto the lightest reader, then each reader's topics back in plan order.
  const loads = Array.from({ length: readers }, () => ({ weight: 0, topics: [] }))
  const weighed = judged.map((t) => ({ t, n: distinct(scoutOf(t).hits) })).sort((a, b) => b.n - a.n)
  for (const { t, n } of weighed) {
    const lightest = loads.reduce((a, b) => (b.weight < a.weight ? b : a))
    lightest.weight += n
    lightest.topics.push(t)
  }
  groups = loads.map((l) => l.topics.sort((a, b) => topics.indexOf(a) - topics.indexOf(b)))

  log(readers === 1
    ? `Judge: one analyst holds all ${judged.length} topic(s) over ${total} location(s).`
    : `Judge: ${total} location(s) earn ${readers} analysts (one per ${LOCATIONS_PER_JUDGE}): ` +
      groups.map((g) => g.map((t) => t.key).join('+')).join(', ') + '.')
}

const groupName = (group) => (groups.length === 1 ? '' : group.map((t) => t.key).join('+'))
const named = (base, group) => [base, groupName(group)].filter(Boolean).join(':')

// ------------------------------------------------ 6. assemble context for analysis
//
// Each judge's scout reports — its topics' and the shared ground's — read ONCE by a script: every
// hit with its note, what each scout covered and proved absent, and the lines they point at, the
// overlapping windows merged, in one file the judge Reads. The courier carries only the reports'
// paths in and the file's path back. Two judges that share a report each get their own file: a
// second read by a script costs nothing.
//
// A side channel with IRON LAW §5 treatment: a context that could not be carried reaches the judge
// as the report files themselves, which it reads and follows. That costs turns, not evidence.

/** The report files a judge's evidence is in: its topics' rounds, then the shared ground's. */
const reportsOf = (group) => group.flatMap((t) => scoutOf(t).files).concat(common ? common.files : [])

async function assembleContext(group) {
  const files = reportsOf(group)
  if (files.length === 0 || hitsOf(group).length === 0) {
    log(`No context to assemble${groupName(group) ? ' for ' + groupName(group) : ''}: no scout reported a location.`)
    return { path: '', files }
  }
  const held = await carry(`${lib('citations', 'excerpts')} ${flags('hits', files)}`, named('assemble', group),
    'Assemble context for analysis')
  if (held.payload && held.payload.context) return { path: held.payload.context, files }
  log(`WARNING: the scouts' reports were not assembled (${held.why || 'no context file came back'}); the judge ` +
    `reads them itself. More turns, not less evidence.`)
  return { path: '', files }
}

// ------------------------------------------------------------ 7. judge

const baseName = (file) => String(file).split('/').pop()

function topicLine(topic) {
  const f = scoutOf(topic)
  return `- ${topic.key}: ${topic.forced
    ? `re-establish the stale claims of topic "${topic.key}" listed in ${pool}`
    : `the topic keyed "${topic.planKey}" in the plan file ${planFile}`}. ` +
    `Its scouts' reports: ${f.files.map(baseName).join(', ') || '(none came back)'}. ` +
    (f.complete
      ? 'The search was exhausted; judge its surface for yourself, and if it does not actually cover ' +
        'the topic, say so in risks rather than accepting it.'
      : `WARNING: the search did NOT finish (never reached: ${f.notReached}). Your conclusion ` +
        'inherits that limit — state what it rests on and what would change it.')
}

function judgePrompt(group, context, continued) {
  const many = group.length > 1
  return `Judge ${many ? `these ${group.length} topics` : 'this topic'} of a larger question from ` +
    `the evidence named below.\n\n` +
    (continued
      ? `A CONTINUATION: an earlier pass did not rule on ${many ? 'these topics' : 'this topic'}. ` +
        `Judge ${many ? 'them' : 'it'} now.\n\n`
      : '') +
    `OVERALL QUESTION: ${question}\n\n` +
    `TOPICS — write evidence items for each, one claim per item; set every item's and risk's ` +
    `topic to the topic's key, whatever else it names. A claim that needs anchors in two ` +
    `unrelated places is two claims. Each kind needs its anchor, one line per kind:\n` +
    `  behaviour: spans;\n` +
    `  absence: a query the recorder re-runs, which refuses the item if it finds anything;\n` +
    `  enumeration: a query whose result the recorder keeps;\n` +
    `  relation: spans and a query;\n` +
    `  external: sources;\n` +
    `  derived: rests_on, the exact claims of sibling items or the ids of ESTABLISHED items.\n` +
    `An item without its anchor is refused and comes back to you. Every topic gets at least one ` +
    `item, or a risk saying why nothing in its evidence can be anchored.\n\n` +
    group.map(topicLine).join('\n') +
    (common
      ? `\n\nSHARED GROUND — scouted once for every topic; treat it as part of your evidence. Its ` +
        `scout's reports: ${common.files.map(baseName).join(', ') || '(none came back)'}.` +
        (common.complete
          ? ''
          : ` WARNING: the shared-ground search did NOT finish. It never reached: ${common.notReached}. ` +
            `Anything you conclude from the shared ground inherits that limit — state what your ` +
            `conclusion rests on.`)
      : '') +
    (known.length
      ? `\n\nESTABLISHED — known ground, already anchored: the items under STANDING in ${pool}. ` +
        `Do not restate these.`
      : '') +
    (context.path
      ? `\n\nCONTEXT FILE — read it whole before judging: every scout report named above, with its ` +
        `locations and what it searched and proved absent, then the lines those locations point ` +
        `at, read once for you by a script. Do not open the source files again to find these ` +
        `lines; its closing section names any location the script could not read:\n  ${context.path}`
      : context.files.length > 0
        ? `\n\nSCOUT REPORTS — the script could not assemble them for you. Read each of these files ` +
          `whole, then each location they report in a line range around it, and nothing else; a ` +
          `location that does not exist is itself worth a line in risks:\n` + context.files.map((f) => '  ' + f).join('\n')
        : '') +
    `\n\nYou have no search tools. Judge what these show; where they are not enough to decide ` +
    `a topic, say what is missing in risks rather than guessing.` +
    (many ? ` Every topic gets its own items — items for one topic do not answer another.` : '')
}

/**
 * One judge's whole charge: its context assembled, a first pass, then a continuation on exactly
 * the topics it ruled on nothing for, for as long as each pass rules on at least one more. No
 * counter ends it (IRON LAW §1); a pass that adds nothing ends it, and what it left is dropped,
 * loudly. Returns the judge's files and, per topic it ruled on, how many items and risks.
 */
async function judgeGroup(group) {
  const context = await assembleContext(group)
  const label = named('judge', group)
  const ruled = new Map()
  const files = []
  let remaining = group
  let pass = 0

  while (remaining.length > 0) {
    pass++
    const keys = remaining.map((t) => t.key)
    const body = judgePrompt(remaining, context, pass > 1)
    const passLabel = label + (pass > 1 ? `#${pass}` : '')
    const file = returnFile(passLabel, body)
    const out = await agent(toFile(body, file, ITEMS_FILE), {
      agentType: 'agentics:analyst', schema: rulingsSchema(keys),
      phase: 'Judge', label: passLabel, ...tiered(judge, 'high'),
    }).catch((e) => {
      log(`${label}: the judge failed (${e && e.message}); its unruled topics are dropped.`)
      return null
    })
    if (!out) break
    files.push(file)

    // A judge holding one topic has one topic to give: everything it wrote is that topic's.
    const counts = (Array.isArray(out.topics) ? out.topics : []).filter((t) => t && keys.includes(t.topic))
    let gained = 0
    for (const t of counts) {
      const n = (Number(t.items_n) || 0) + (Number(t.risks_n) || 0)
      if (n === 0) continue
      const prev = ruled.get(t.topic)
      if (!prev) gained++
      ruled.set(t.topic, { items_n: (prev ? prev.items_n : 0) + (Number(t.items_n) || 0), risks_n: (prev ? prev.risks_n : 0) + (Number(t.risks_n) || 0) })
    }

    if (gained === 0) {
      log(`${label}: pass ${pass} ruled on none of ${keys.join(', ')} — stopping rather than looping.`)
      break
    }
    remaining = remaining.filter((t) => !ruled.has(t.key))
    if (remaining.length > 0) {
      log(`${label}: no verdict yet for ${remaining.map((t) => t.key).join(', ')}; continuing on those.`)
    }
  }

  return { ruled, files }
}

phase('Assemble context for analysis')
const rulings = await Promise.all(groups.map((group) => judgeGroup(group)))
const ruledBy = new Map()
for (const r of rulings) for (const [k, v] of r.ruled) ruledBy.set(k, v)

// ---------------------------------------------------------------- 8. record

/**
 * One judge group's whole record charge, one courier per pass: lib reads the judge's files, the
 * plan's question checked against this survey's, and records the group's items as one batch. A
 * refused item goes back to the judge that wrote it — it reads the refusals file lib wrote and
 * writes its corrections to a file of its own — for as long as a pass refuses fewer than the one
 * before it. No counter ends it — a pass that refuses as many as the last one does.
 */
async function recordGroup(group, judgeFiles) {
  const label = named('record', group)
  const judgeLabel = named('judge', group)
  const topicFlags = group.map((t) => `--topic ${t.key} --subtree "${t.subtree === '.' ? '' : t.subtree}"`).join(' ')
  const unquotable = group.filter((t) => !quotable(t.subtree))
  if (unquotable.length > 0 || judgeFiles.some((f) => !quotable(f))) {
    return { ok: false, return: '', refused: [], refusals: '', why: 'a topic\'s subtree or a return file cannot be carried as a command argument' }
  }

  const fixes = []
  let prevCount = Infinity
  for (let pass = 0; ; pass++) {
    const held = await carry(
      `${lib('evidence', 'record')} --root "${repo}" --kind survey --plan "${planFile}" --question-digest ${fnv1a(question)} ` +
        `${topicFlags} ${flags('from', judgeFiles)}${fixes.length ? ' ' + flags('fix', fixes) : ''}`,
      pass === 0 ? label : label + ':anchors:' + pass, 'Record')
    const out = held.payload
    if (!out) return { ok: false, return: '', refused: [], refusals: '', why: held.why }
    if (out.ok) return { ok: true, return: out.return || '', refused: [], refusals: '', why: '' }

    const refusedN = Number(out.refused_n) || 0
    if (!(refusedN < prevCount) || !out.refusals_file) {
      return { ok: false, return: '', refused: out.refused || [], refusals: out.refusals_file || '', why: '' }
    }
    prevCount = refusedN

    const body = `The evidence store refused ${refusedN} of your items for their anchors. Read ${out.refusals_file}: ` +
      `each refused item as it was written, with what is wrong with it. Write corrected versions of ` +
      `exactly those items, fixing what each problem names, and nothing else.\n\nOVERALL QUESTION: ${question}`
    const fixLabel = judgeLabel + ':anchors:' + (pass + 1)
    const file = returnFile(fixLabel, body)
    const answer = await agent(toFile(body, file, ITEMS_FILE), {
      agentType: 'agentics:analyst', schema: WRITTEN, phase: 'Judge', label: fixLabel, ...tiered(judge, 'high'),
    }).catch(() => null)
    if (!answer) return { ok: false, return: '', refused: out.refused || [], refusals: out.refusals_file, why: 'the re-ask dispatch failed' }
    fixes.push(file)
  }
}

phase('Record')
const recordOutcomes = await Promise.all(groups.map(async (group, i) => {
  const withItems = group.filter((t) => (ruledBy.get(t.key) || { items_n: 0 }).items_n > 0)
  if (withItems.length === 0) return { group, ok: true, return: '', refused: [], refusals: '', why: '' }
  return { group, ...(await recordGroup(group, rulings[i].files)) }
}))

// ---------------------------------------------------------------- 9. account

const returns = recordOutcomes.filter((o) => o.ok && o.return).map((o) => o.return)
const recordIncomplete = []
const recordUnreached = []
const unrecorded = []

for (const outcome of recordOutcomes) {
  if (outcome.ok) continue
  const refusedOf = new Map((outcome.refused || []).map((r) => [r.topic, Number(r.n) || 0]))
  for (const t of outcome.group) {
    const n = (ruledBy.get(t.key) || { items_n: 0 }).items_n
    if (n === 0) continue
    unrecorded.push(t.key)
    recordIncomplete.push(t.key)
    recordUnreached.push(refusedOf.has(t.key)
      ? `${t.key}: ${refusedOf.get(t.key)} item(s) refused for their anchors and dropped, and its judge's other ` +
        `items with them — what is wrong with each is in ${outcome.refusals}`
      : refusedOf.size > 0
        ? `${t.key}: ${n} item(s) not recorded: a batch-mate of an item refused for its anchors, never itself re-asked`
        : `${t.key}: ${n} item(s) not recorded (${outcome.why}), so their anchors were never checked`)
  }
}

const dropped = topics.filter((t) => !ruledBy.has(t.key)).map((t) => t.key)
if (dropped.length > 0) log(`WARNING: no verdict for topic(s): ${dropped.join(', ')}`)
if (partial.length > 0) log(`WARNING: could not search to exhaustion: ${partial.join(', ')}`)

const history = await historyChannel
const docs = await docsChannel

// A requested channel that produced nothing — it threw, or it returned nothing. Both mean the
// evidence is not there, and any claim resting on it is unsupported.
const failedChannels = []
if (history.requested && !history.result) failedChannels.push('history')
if (docs.requested && !docs.result) failedChannels.push('docs')

// A channel that RETURNED but did not exhaust its search is not a failure and not a success.
// It belongs with the partially-searched topics: real evidence, known to be incomplete, and
// resumable.
const truncatedChannels = []
if (history.result && !history.result.exhausted) truncatedChannels.push('history')
if (docs.result && !docs.result.exhausted) truncatedChannels.push('docs')

if (truncatedChannels.length > 0) {
  log(`WARNING: evidence channel(s) returned without exhausting the search: ${truncatedChannels.join(', ')}`)
}

const historyFiles = history.result ? history.result.files : []
const docsFiles = docs.result ? docs.result.files : []
const ctx = await writeContext({
  returns, judgeFiles: rulings.flatMap((r) => r.files), history: historyFiles, docs: docsFiles,
})
if (!ctx) failedChannels.push('context')

// A topic that produced items but never exhausted its search is still incomplete. One that
// produced nothing at all is already in `dropped`, so it is not counted twice.
const droppedKeys = new Set(dropped)
const incomplete = [...new Set([...partial, ...recordIncomplete])]
  .filter((k) => !droppedKeys.has(k)).concat(truncatedChannels)

// Reused standing items first, then this survey's new ones in plan order.
const order = (it) => (returns.includes(it.return) ? topics.findIndex((t) => t.key === it.topic) : -1)
const items = ctx
  ? [...ctx.items].sort((a, b) => order(a) - order(b)).map(({ id, topic, kind, state }) => ({ id, topic, kind, state }))
  : []

return surveyResult({
  topics: topics.map((t) => t.key),
  ground: [...new Set(topics.map((t) => groundPath(t.subtree)))],
  items,
  reused: ctx ? ctx.items.filter((it) => !returns.includes(it.return)).map((it) => it.id) : known.map((i) => i.id),
  unrecorded,
  context: ctx ? ctx.context : '',
  risks: [...ruledBy].filter(([, v]) => v.risks_n > 0).map(([topic, v]) => ({ topic, n: v.risks_n })),
  history: history.result ? historyFiles : null,
  docs: docs.result ? docsFiles : null,
  coverageBlock: coverageOf(dropped, incomplete, failedChannels, recordUnreached.concat(ctx ? [] : [CONTEXT_LOST])),
})
