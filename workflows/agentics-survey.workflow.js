export const meta = {
  name: 'agentics-survey',
  description: 'Gather evidence about a question across the local repos, git history, and vendor documentation. Returns structured findings plus a coverage block — never a conclusion.',
  whenToUse: 'The shared evidence phase for investigate, develop, find-existing-solutions and design. Call it via workflow("agentics-survey", args) as a nested step; it is rarely invoked directly.',
  phases: [
    { title: 'Standing', detail: 'whether a recorded survey of this effort still covers the ground' },
    { title: 'Plan' },
    { title: 'Scout' },
    { title: 'History' },
    { title: 'Docs' },
    { title: 'Assemble context for analysis', detail: 'per judge, one script reads its locations once and writes them to files it Reads' },
    { title: 'Judge', detail: 'one analyst without search tools, unless volume or pace earns more' },
  ],
}

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
// is driven by not_reached, so both have to arrive filled in.
//
// no_match and not_reached stay separate on purpose. "I looked and it is not there" is a
// FINDING — often the one that decides the question. "I never looked" is a HOLE. Merging them
// is exactly how a truncated search gets read as a clean result, and it also poisons the
// resume loop: the next round is handed things already established as absent and pays to
// re-search them.
// Every coverage field is ALWAYS present — an empty string is the correct value for "nothing
// to carry", and each description says so outright. Conditional wording ("must be non-empty
// whenever stop_reason is not exhausted") reads to an exhausted agent as "must be non-empty",
// so it omits the field it has nothing for, trips required-field validation, re-submits the
// same shape until the platform kills it, and a finished search is dropped whole.
const coverageFields = (searchedDescription) => ({
  searched: {
    type: 'array',
    items: { type: 'string' },
    description: searchedDescription +
      ' Always include this field. It is the evidence trail behind stop_reason: without it ' +
      'your completeness claim is an unverifiable self-report, and nobody can resume where ' +
      'you stopped.',
  },
  stop_reason: {
    type: 'string',
    enum: ['exhausted', 'unfinished', 'stuck'],
    description:
      'Always include this field. "exhausted" — every candidate your searches turned up has ' +
      'been triaged and you can name the surface that covers the request. "unfinished" — ' +
      'one pass could not cover the surface; you are handing back an honest partial and the ' +
      'caller will resume you until the search is done. "stuck" — you could not find a way ' +
      'forward. Cost, effort already spent, and the size of your report are never reasons ' +
      'to stop: never stop because the work feels large. Only "exhausted" counts as a ' +
      'complete result, so claim it only when it is true. The other two are not failures: ' +
      'the caller will resume you.',
  },
  no_match: {
    type: 'string',
    description:
      'What you searched for and genuinely did not find. This is a finding, not a gap — it ' +
      'tells the caller the thing is absent. Send an empty string — never omit the field — ' +
      'when everything you looked for was there.',
  },
  not_reached: {
    type: 'string',
    description:
      'What you never searched at all, named specifically enough for someone else to pick it ' +
      'up without redoing your work. Send an empty string when stop_reason is "exhausted"; ' +
      'otherwise it must name what remains — a search you do not describe cannot be resumed ' +
      'and will be recorded as a dead end instead. Never merge this with no_match.',
  },
})

// Only the payload field goes in `required`. The coverage fields are demanded by their
// descriptions and normalized in JS after the call — never by the validator: a required
// field whose semantics are conditional is a deadlock. An agent with nothing to put in it
// omits it, validation rejects the whole report, the agent re-submits the same shape until
// the platform kills it, and evidence already gathered is dropped. Absence is normalized in
// the safe direction: a missing stop_reason never reads as "exhausted", so sloppiness
// degrades toward incomplete, never toward false completeness.

const PLAN = {
  type: 'object',
  additionalProperties: false,
  required: [
    'topics', 'common_ground',
    'docs_needed', 'docs_question', 'history_needed', 'history_question',
  ],
  properties: {
    topics: {
      type: 'array',
      description: 'The independent search topics this question decomposes into.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'find', 'subtree'],
        properties: {
          key: { type: 'string', description: 'Short kebab-case identifier, unique within the plan.' },
          find: {
            type: 'string',
            description: 'A precise instruction for a read-only search agent: what to find and where to look.',
          },
          subtree: {
            type: 'string',
            description:
              'The one subtree this topic is about, as a repo-relative POSIX path — a directory ' +
              'or a single file. It is what this survey is anchored to afterwards: the survey ' +
              'stays evidence exactly as long as no commit touches the subtrees its topics ' +
              'named, so a path naming the topic\'s real ground is what lets a later pass reuse ' +
              'this one instead of buying it again. Send an empty string — never omit the ' +
              'field — when the topic is genuinely repository-wide.',
          },
        },
      },
    },
    common_ground: {
      type: 'string',
      description:
        'A precise search instruction, in the same form as a topic\'s, for ground several ' +
        'topics would each need to read — a shared configuration object, a subsystem they all ' +
        'touch. It is scouted ONCE and what it finds is handed to every judge alongside the ' +
        'topics, so naming it here replaces the same files being searched once per topic. ' +
        'Send an empty string — never omit the field — when the topics genuinely share no ' +
        'ground.',
    },
    docs_needed: {
      type: 'boolean',
      description: 'True only if answering the question needs vendor or standards documentation that is not in these repositories.',
    },
    docs_question: {
      type: 'string',
      description: 'The documentation question. Required and non-empty whenever docs_needed is true — a true flag with no question means the track is skipped entirely.',
    },
    history_needed: {
      type: 'boolean',
      description: 'True only if answering the question needs git history rather than the current tree.',
    },
    history_question: {
      type: 'string',
      description: 'The history question. Required and non-empty whenever history_needed is true — a true flag with no question means the track is skipped entirely.',
    },
  },
}

const HITS = {
  type: 'object',
  additionalProperties: false,
  required: ['hits'],
  properties: {
    hits: {
      type: 'array',
      description: 'One entry per location found. Locations only — no analysis, no recommendations.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'line', 'note'],
        properties: {
          path: { type: 'string', description: 'Path to the file containing the hit, relative to the repository it is in.' },
          line: { type: 'integer', description: 'Line number of the hit.' },
          note: { type: 'string', description: 'What is at that line, in one line.' },
        },
      },
    },
    ...coverageFields('Every grep pattern, glob, and path you actually searched.'),
  },
}

// History and docs return narrative evidence, so `findings` stays prose. They answer the same
// coverage contract as the scouts anyway: without it, a channel that stalled halfway is
// indistinguishable from one that finished, because both arrive as a confident essay.
const evidenceSchema = (findingsDescription, searchedDescription) => ({
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: { type: 'string', description: findingsDescription },
    ...coverageFields(searchedDescription),
  },
})

const HISTORY = evidenceSchema(
  'The commits that matter, in the format your agent instructions specify: sha, date, author, ' +
  'subject, and the path:line of what changed. Include ruled-out candidates where they save ' +
  'the reader work. Never guess a commit.',
  'Every ref, path, and date range you actually searched, plus the git commands behind them.',
)

const DOCS = evidenceSchema(
  'The facts you established, each with the URL that owns it on the same line. Mark a claim ' +
  '"unconfirmed" when only a secondary source carries it.',
  'Every search query and URL you actually read.',
)

// What a courier hands back: one command's stdout, byte-exact, in one string. The shape of
// `agentics-develop`'s CARRIED, copied rather than shared because a workflow script cannot
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

// One judge may hold several topics, so its verdicts come back as a list whose `topic` is a
// closed enum built per dispatch: a key it was not given cannot be where a verdict lands.
function verdictsSchema(keys) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdicts'],
    properties: {
      verdicts: {
        type: 'array',
        description: 'One verdict per topic you were given — every one of them.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['topic', 'conclusion', 'evidence', 'risks'],
          properties: {
            topic: { type: 'string', enum: keys, description: 'The topic key, copied exactly.' },
            conclusion: { type: 'string', description: 'The answer to this topic, in one or two sentences, stated first.' },
            evidence: {
              type: 'array',
              items: { type: 'string' },
              description: 'The two to four facts that decide the conclusion, each carrying a path:line, a commit, or a URL.',
            },
            risks: {
              type: 'array',
              items: { type: 'string' },
              description: 'Risks and unknowns, only where they change the decision. Put an inadequate search surface here rather than accepting it silently.',
            },
          },
        },
      },
    },
  }
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
// no judge and no gate — prior context has no anchor and nothing checked it, so admitted near a
// gate it would be an unverified note laundered into a skipped phase. What CAN stand in for a
// survey is a recorded one whose ground git says is untouched, and that is computed below.
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

// The standing-survey inputs. Whether the change's shape is settled is JUDGMENT and stays with the
// caller; whether a recorded survey still covers the ground is arithmetic and is computed here.
const effort = typeof input.effort === 'string' ? input.effort.trim() : ''
const settledShape = input.settled_shape === true
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
// the first — the repository it is anchored in. A location in another root is not excerpted; the
// judge is handed it as a location to read.
const repo = String(roots).split(/[,;\n]/)[0].trim() || '.'

// ---------------------------------------------------------------- the transport
//
// A payload computed on disk arrives through a model, so it is re-digested here before a field of
// it is believed; a location list this script mints travels as plain text on one argv slot with
// its digest beside it. The functions are copies of `lib/plan-digest.mjs`'s and
// `agentics-develop`'s: scripts cannot import, and the suite pins them together.
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

/** What a courier carried back: the payload, or why it cannot be believed and how to retry. */
function carriedRead(held) {
  if (!held) return { payload: null, why: 'the dispatch returned nothing', retry: 'again' }
  if (held.stop_reason !== 'carried') {
    return { payload: null, why: held.notes || 'the courier could not run the command', retry: 'again' }
  }

  let parsed = null
  try {
    parsed = JSON.parse(held.payload_raw)
  } catch (e) {
    return { payload: null, why: 'it did not survive transcription: ' + (e && e.message), retry: 'stronger' }
  }

  if (parsed && parsed.error) return { payload: null, why: 'the program failed: ' + parsed.error, retry: '' }
  if (!parsed || !parsed.payload || typeof parsed.payload_digest !== 'string') {
    return { payload: null, why: 'what came back is not a digest-covered envelope', retry: 'stronger' }
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

function courierPrompt(command) {
  return 'Run exactly this one command, unchanged, and put its entire stdout in payload_raw:\n\n' +
    command + '\n\n' +
    'Move no todos.' +
    (pluginRoot === SHELL_ROOT
      ? '\nIf ' + SHELL_ROOT + ' is empty in your shell, do not guess a path: set stop_reason ' +
        '"failed" and say so.'
      : '')
}

/**
 * Carry one command's payload, believed only after its digest.
 *
 * Retries are sized to what was observed, as `agentics-develop`'s boundaries size them: a courier
 * that returned nothing or could not run the command is run again once; a payload damaged in
 * transit buys one refetch on a stronger model; a token the program refused as damaged on its way
 * IN is sent again; a program failure is not retried. What stays unbelievable comes back as
 * `{payload: null, why}` — every carry in this workflow is a side channel with a fallback, so
 * none of them may throw.
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
      if (refused && c.payload.error.kind === 'digest_mismatch' && i === 0) {
        why = c.payload.error.message || 'the argument token was damaged on its way in'
        ladder.push(COURIER)
        continue
      }
      if (refused) return { payload: null, why: 'the program refused: ' + (c.payload.error.message || c.payload.error.kind) }
      return { payload: c.payload, why: '' }
    }

    why = c.why || why
    if (c.retry === 'again' && ladder.length < 2) ladder.push(COURIER)
    else if (c.retry === 'stronger' && !ladder.includes(COURIER_UP)) ladder.push(COURIER_UP)
  }

  return { payload: null, why }
}

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
// a survey with no question: a coverage-honest empty result in milliseconds, and the
// interrupted run's cached agents unreachable. They travel with the block a caller actually
// reads when deciding how to resume.
const LAUNCH_ARGS = {
  question, roots, notes, prior, max_topics: maxTopics, intelligence, pace, plugin_root: pluginRoot,
  effort, settled_shape: settledShape, ground: callerGround,
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
// `ground` is the subtrees the topics searched, `.` for a repository-wide topic. It is what a
// later phase anchors this survey to: the survey stays sound evidence exactly as long as no
// commit touches that ground (`lib/effort.mjs standing`).
function surveyResult(topics, verdicts, history, docs, coverageBlock, ground = []) {
  return { question, topics, ground, verdicts, history, docs, coverage: coverageBlock }
}

if (!question) {
  return surveyResult([], [], null, null,
    coverageOf([], [], [], ['no question was supplied, so nothing was searched']))
}

log(`Question: ${question}`)

// ---------------------------------------------------------------- 0. a standing survey
//
// A node whose shape is settled and whose ground a standing survey covers buys no survey. The
// caller answers the first half; `lib/effort.mjs standing` answers the second from git — the
// recorded survey's commit is an ancestor of HEAD, nothing has touched its ground since, and it
// reported complete coverage — and this script checks only that its ground covers the ground the
// caller named. Every refusal surveys in full and says why, because a phase skipped on anything
// less than that arithmetic is exactly the laundering §2 forbids.

// A caller path is covered by a surveyed subtree that is the repository, the path itself, or one
// of its ancestors.
const covers = (surveyed, path) => surveyed.some((g) => {
  const s = groundPath(g)
  return s === '.' || s === path || path.startsWith(s + '/')
})

async function standingSurvey() {
  if (!settledShape || !effort) return null
  const refuse = (why) => {
    log(`No standing survey stands in: ${why}. Surveying in full.`)
    return null
  }
  if (callerGround.length === 0) {
    return refuse('the caller named no ground, so there is nothing a recorded survey could be shown to cover')
  }
  // The slug travels inside a shell command, so only a name `lib/store.mjs` would accept goes.
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(effort) || effort.includes('--') || effort.length > 120) {
    return refuse('"' + effort + '" is not an effort name')
  }

  phase('Standing')

  const held = await carry(`node "${pluginRoot}/lib/effort.mjs" standing "${repo}" "${effort}"`,
    'standing', 'Standing')
  if (!held.payload) return refuse('whether effort ' + effort + '\'s survey stands could not be read (' + held.why + ')')

  const st = held.payload
  if (st.standing !== true) return refuse('effort ' + effort + '\'s newest survey does not stand — ' + (st.why || 'no reason given'))

  const uncovered = callerGround.filter((p) => !covers(Array.isArray(st.ground) ? st.ground : [], p))
  if (uncovered.length > 0) {
    return refuse('the standing survey ' + st.stamp + ' searched ' + (st.ground || []).join(', ') +
      ' and does not cover ' + uncovered.join(', '))
  }

  // The verdicts themselves are a second read: the standing check prints the arithmetic, not the
  // survey, and the stamp both reads name is what proves they are about the same file.
  const read = await carry(`node "${pluginRoot}/lib/effort.mjs" read "${repo}" "${effort}" --latest survey`,
    'standing-read', 'Standing')
  const latest = read.payload && read.payload.latest
  if (!latest) return refuse('the standing survey could not be read (' + (read.why || 'no survey came back') + ')')
  if (latest.stamp !== st.stamp) {
    return refuse('the survey read back (' + latest.stamp + ') is not the one that stood (' + st.stamp + ')')
  }
  const recorded = latest.payload
  if (!recorded || !Array.isArray(recorded.verdicts) || !recorded.coverage || recorded.coverage.complete !== true) {
    return refuse('the recorded survey ' + st.stamp + ' is not a complete survey result')
  }

  log(`Standing survey ${st.stamp} (observed at ${st.observed_at}) covers ${callerGround.join(', ')} ` +
    `and nothing has touched its ground since: its verdicts are this survey's, and nothing was ` +
    `re-searched.`)
  return { recorded, stamp: st.stamp, observedAt: st.observed_at, ground: st.ground }
}

const standing = await standingSurvey()

if (standing) {
  // The recorded survey's own coverage was complete, so the block is complete too — and it says
  // where the evidence came from, so a reused result is never mistaken for one bought today.
  const reused = coverageOf([], [], [], [])
  return {
    question,
    topics: standing.recorded.topics || [],
    ground: standing.recorded.ground || standing.ground || [],
    verdicts: standing.recorded.verdicts,
    history: standing.recorded.history == null ? null : standing.recorded.history,
    docs: standing.recorded.docs == null ? null : standing.recorded.docs,
    coverage: { ...reused, standing: { stamp: standing.stamp, observed_at: standing.observedAt } },
  }
}

// ---------------------------------------------------------------- 1. plan

phase('Plan')

const plan = await agent(
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
  `\nEach topic must be answerable by searching the current code on its own, with no ` +
  `dependency on the other topics — the shared ground below is the one exception to that, ` +
  `because it reaches every judge. Give each a short kebab-case key and a precise ` +
  `instruction for a read-only search agent: what to find, and where to look. Size each ` +
  `topic so a single search agent can exhaust it in one pass — one subsystem, one named ` +
  `concern. Prefer more, smaller topics over one merged catch-all: a kitchen-sink topic ` +
  `forces a partial first pass, and everything later is built on what these searches ` +
  `return.\n\n` +
  `Give every topic a subtree: the one directory or file it is about, repo-relative, or an ` +
  `empty string when the topic is genuinely repository-wide. The survey is anchored to these ` +
  `paths afterwards, so a path that names the topic's real ground is what lets a later pass ` +
  `reuse this survey instead of buying it again.\n\n` +
  `When several topics would each need to read the same files, do NOT fold that surface ` +
  `into each of them. Name it once in common_ground, as a precise instruction for a single ` +
  `search agent: it is searched once, and every judge receives what it finds alongside the ` +
  `topics. Then confine each topic's instruction to what is unique to that topic. Send an ` +
  `empty string when the topics genuinely share no ground.\n\n` +
  `Set history_needed if answering the question requires git history rather than the ` +
  `current tree: when a behaviour changed, which commit introduced or removed something, ` +
  `why code is the way it is, or any regression. Put that question in history_question. ` +
  `A search of the current tree cannot answer these, so getting this flag wrong produces ` +
  `a confident wrong answer.\n\n` +
  `Set docs_needed only if answering the question requires vendor or standards ` +
  `documentation that is not in these repositories. Put that question in docs_question.\n\n` +
  `Leave a question field as an empty string when its flag is false. When a flag is true ` +
  `the matching question must be non-empty — a true flag with no question skips the track ` +
  `entirely and the answer silently loses that evidence.\n` +
  `Do not search anything yourself. Plan only.`,
  { agentType: 'agentics:analyst', schema: PLAN, phase: 'Plan', label: 'plan', ...tiered(judge, 'medium') },
).catch((e) => {
  log(`WARNING: planning failed: ${e && e.message}`)
  return null
})

if (!plan || !plan.topics || plan.topics.length === 0) {
  return surveyResult([], [], null, null,
    coverageOf([], [], [], ['planning produced no topics, so nothing was searched']))
}

// The cap in the prompt is sizing guidance to the planner, never a licence to drop work:
// every topic the planner decided the question needs gets searched. Slicing the overflow off
// produced runs whose plans rested on evidence nobody gathered. Cost is controlled by method —
// cheap scouts, tight schemas — not by cutting work (§8).
if (plan.topics.length > maxTopics) {
  log(`Planner returned ${plan.topics.length} topics (asked for at most ${maxTopics}); searching all of them.`)
}

const topics = plan.topics
// Read defensively: a plan that omits the field is a plan with no shared ground.
const commonFind = (plan.common_ground || '').trim()

log(`Plan: ${topics.length} topic(s)` +
    `${commonFind ? ' + common ground' : ''}` +
    `${plan.history_needed ? ' + git history' : ''}` +
    `${plan.docs_needed ? ' + documentation' : ''}`)

// ---------------------------------------------------------- 2. the resume engine
//
// Drives one evidence agent to exhaustion (IRON LAW §3): the scouts, the historian and the
// doc-researcher all go through here. Every stop condition is about the GOAL, and none is a
// counter or a budget (§1): the loop ends when the agent exhausts the surface, when it
// dead-ends without naming what is left, when a round errors out, or when a round covers no
// new ground — the observable form of "stuck". Cost never ends it: a search still finding
// new ground keeps going, however many rounds that takes, because every later stage is built
// on what this one returns and is far more expensive to mislead than to wait for.
//
// `absorb(found)` folds one round into the caller's accumulators and returns true when the
// round gained new ground. Progress is judged on evidence actually gained, never on the
// agent's account of itself.

// A remainder, normalized for comparison. Whitespace and case only: two differently-worded
// descriptions of the same unreached surface are the same surface.
const remainderKey = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase()

async function resumeToExhaustion({ key, prompt, launch, absorb }) {
  let round = 0
  let prev = null
  let prevRemainder = null
  while (true) {
    round++
    let found
    try {
      found = await launch(prompt(round, prev), round)
    } catch (e) {
      log(`${key}: round ${round} threw (${e && e.message}); keeping what was found.`)
      return { exhausted: false, notReached: `round ${round} failed before completion: ${e && e.message}` }
    }
    if (!found) {
      log(`${key}: round ${round} returned nothing; keeping what was found.`)
      return { exhausted: false, notReached: `round ${round} produced no result` }
    }

    const progressed = absorb(found)
    prev = found

    if (found.stop_reason === 'exhausted') {
      return { exhausted: true, notReached: '' }
    }

    // Not exhausted but nothing named as unreached: another round would be handed an empty
    // task and would return "exhausted" having done nothing. Treat it as the dead end it is
    // rather than paying for a round that launders it into completeness.
    if (!(found.not_reached || '').trim()) {
      const reason = found.stop_reason || 'unstated'
      log(`${key}: stop_reason "${reason}" with nothing named as unreached — treating as a dead end.`)
      return { exhausted: false, notReached: `search stopped as "${reason}" without naming what was missed` }
    }

    // Two independent ways a round can advance: it brought back evidence nobody had, or it
    // narrowed the surface still to cover. An agent told not to repeat itself rewords its
    // account of the same ground every round — new lines, no new knowledge, the same remainder
    // — and left alone that runs until something outside the workflow kills it.
    const remainder = remainderKey(found.not_reached)
    const narrowed = prevRemainder === null || remainder !== prevRemainder
    prevRemainder = remainder

    if (!progressed && !narrowed) {
      log(`${key}: round ${round} brought back nothing new and left the same ground unreached — ` +
        `stopping as stuck rather than looping.`)
      return { exhausted: false, notReached: found.not_reached }
    }

    log(`${key}: unfinished after round ${round} (${found.stop_reason || 'unstated'}), resuming.`)
  }
}

// ------------------------------------------------- 3. history and docs
//
// Both run alongside the scouts, through the same resume engine. IRON LAW §5: a side-channel
// failure must not discard the scout and judge work already paid for, so nothing here rejects.
// Every outcome is recorded, including a track the planner marked necessary and then gave no
// question for — that one otherwise reports as neither researched nor failed.

function sideChannel(name, needed, ask, launch) {
  if (!needed) {
    return Promise.resolve({ requested: false, result: null, error: '' })
  }
  if (!(ask || '').trim()) {
    log(`WARNING: ${name} was marked necessary but the planner produced no question for it.`)
    return Promise.resolve({
      requested: true,
      result: null,
      error: 'the planner marked it necessary and then produced no question, so nothing was searched',
    })
  }
  return launch(ask).then(
    (result) => result
      ? { requested: true, result, error: '' }
      : { requested: true, result: null, error: 'the agent returned no result' },
    (e) => {
      log(`WARNING: ${name} failed: ${e && e.message}`)
      return { requested: true, result: null, error: (e && e.message) || 'unknown error' }
    },
  )
}

// A channel's rounds accumulate prose findings rather than hit lists, so the engine's progress
// measure is new findings text, and the merged rounds keep the shape every consumer already
// reads: findings plus the coverage fields. Returns null when no round ever produced a result,
// which sideChannel records as the failed channel it is.
async function channelToExhaustion({ key, first, launch }) {
  const findings = []
  const searched = []
  const noMatch = []
  const seen = new Set()
  const seenFindings = new Set()
  let sawResult = false

  const absorb = (found) => {
    sawResult = true
    let gained = false

    const text = (found.findings || '').trim()
    if (text && !seenFindings.has(text)) { seenFindings.add(text); findings.push(text); gained = true }

    for (const s of found.searched || []) {
      const k = String(s).trim()
      if (k && !seen.has(k)) { seen.add(k); searched.push(s) }
    }
    if ((found.no_match || '').trim()) noMatch.push(found.no_match.trim())
    return gained
  }

  const prompt = (round, prev) => round === 1
    ? first
    : `Continue an unfinished search — do not start over.\n\n` +
      `ORIGINAL REQUEST:\n${first}\n\n` +
      `ALREADY SEARCHED (do not repeat these):\n${searched.join('\n')}\n\n` +
      `ALREADY ESTABLISHED (do not re-derive these):\n${findings.join('\n\n')}\n\n` +
      `STILL NOT REACHED — this is your job now:\n${prev.not_reached}`

  const end = await resumeToExhaustion({ key, prompt, launch, absorb })
  if (!sawResult) return null
  return {
    findings: findings.join('\n\n'),
    searched,
    stop_reason: end.exhausted ? 'exhausted' : 'unfinished',
    no_match: noMatch.join('\n'),
    not_reached: end.notReached,
  }
}

const historyChannel = sideChannel(
  'git history search', plan.history_needed, plan.history_question,
  (ask) => channelToExhaustion({
    key: 'history',
    first: `${ask}\n\nRepositories: ${roots}\nContext: ${question}`,
    launch: (p, round) => agent(p, {
      agentType: 'agentics:historian', effort: 'low', schema: HISTORY,
      phase: 'History', label: `history${round > 1 ? `#${round}` : ''}` }),
  }),
)

const docsChannel = sideChannel(
  'documentation research', plan.docs_needed, plan.docs_question,
  (ask) => channelToExhaustion({
    key: 'docs',
    first: `Research this against primary sources and report the facts with URLs.\n\n` +
      `${ask}\n\nContext: ${question}`,
    launch: (p, round) => agent(p, {
      agentType: 'agentics:doc-researcher', effort: 'low', schema: DOCS,
      phase: 'Docs', label: `docs${round > 1 ? `#${round}` : ''}` }),
  }),
)

// -------------------------------------------------------------- 4. scout

phase('Scout')

const partial = []

// Search to exhaustion. IRON LAW §3: an incomplete scout is RESUMED, never reported as a
// result. The engine owns the stop conditions; this wrapper owns what a scout accumulates —
// deduplicated hits and searched surface, which double as the engine's progress measure.
async function scoutUntilComplete(topic) {
  const hits = []
  const searched = []
  const noMatch = []
  const seen = new Set()

  // Progress is HITS, not lines of self-report: a scout told not to repeat itself keeps
  // producing fresh descriptions of ground it has already covered.
  const absorb = (found) => {
    let gained = false

    for (const h of found.hits || []) {
      const k = `hit:${h.path}:${h.line}`
      if (!seen.has(k)) { seen.add(k); hits.push(h); gained = true }
    }
    for (const s of found.searched || []) {
      const k = `searched:${String(s).trim()}`
      if (String(s).trim() && !seen.has(k)) { seen.add(k); searched.push(s) }
    }
    if ((found.no_match || '').trim()) noMatch.push(found.no_match.trim())
    return gained
  }

  // The shared ground is searched once, by its own scout, so every other scout is told to
  // leave it alone. The common scout itself is never handed the exclusion.
  const exclude = commonFind && topic.key !== 'common-ground'
    ? `\n\nA separate scout covers this shared ground — do not search it:\n${commonFind}`
    : ''

  const prompt = (round, prev) => round === 1
    ? `${topic.find}${exclude}\n\nRepositories: ${roots}\n\n` +
      `Report every location you find, and search to exhaustion: you stop when the surface ` +
      `is covered or you are genuinely stuck, never because the list is getting long or ` +
      `the work feels large. If one pass truly cannot cover the request, report what you ` +
      `have, set stop_reason to "unfinished", and name exactly what remains in ` +
      `not_reached — you will be resumed until the search is done.`
    : `Continue an unfinished search — do not start over.\n\n` +
      `ORIGINAL REQUEST: ${topic.find}${exclude}\n` +
      `Repositories: ${roots}\n\n` +
      `ALREADY SEARCHED (do not repeat these):\n${searched.join('\n')}\n\n` +
      `ALREADY FOUND (do not report these again):\n` +
      hits.map((h) => `${h.path}:${h.line}`).join('\n') +
      `\n\nSTILL NOT REACHED — this is your job now:\n${prev.not_reached}`

  const launch = (p, round) => agent(p, {
    agentType: 'agentics:scout', effort: 'low', schema: HITS,
    phase: 'Scout', label: `scout:${topic.key}${round > 1 ? `#${round}` : ''}`,
  })

  const end = await resumeToExhaustion({ key: topic.key, prompt, launch, absorb })
  if (!end.exhausted) partial.push(topic.key)

  return {
    hits, searched, complete: end.exhausted, noMatch: noMatch.join('\n'), notReached: end.notReached,
  }
}

// The shared scout runs alongside the topic scouts. It is an ordinary scout in every other
// respect — same labels, same phase, same resume to exhaustion, and the same entry in `partial`
// when it does not get there.
const commonGround = commonFind
  ? scoutUntilComplete({ key: 'common-ground', find: commonFind }).catch((e) => {
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

const normPath = (path) => String(path).split('\\').join('/')
const locKey = (path, line) => normPath(path) + ':' + String(line)

function locationsOf(hits) {
  const seen = new Set()
  const out = []
  for (const h of hits) {
    const loc = { path: normPath(h.path), line: Number.isInteger(h.line) ? h.line : 0 }
    const k = locKey(loc.path, loc.line)
    if (!seen.has(k)) { seen.add(k); out.push(loc) }
  }
  return out
}

const scoutOf = (topic) => scouted[topics.indexOf(topic)]
const commonHits = common ? common.hits : []
const judged = topics.filter((t) => scoutOf(t))
const hitsOf = (group) => group.flatMap((t) => scoutOf(t).hits).concat(commonHits)
const total = locationsOf(hitsOf(judged)).length

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
  const weighed = judged.map((t) => ({ t, n: locationsOf(scoutOf(t).hits).length })).sort((a, b) => b.n - a.n)
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

// ------------------------------------------------ 6. assemble context for analysis
//
// Each judge's locations — its topics' and the shared ground's — read ONCE by a script, overlapping
// windows merged, and written to context files the judge Reads whole. The courier carries only
// their paths back, so no model ever retypes an excerpt. A judge handed the lines spends its
// turns judging; one handed paths spends them opening files one by one. Two judges that share a
// file each get their own window of it: a second read by a script costs nothing.
//
// A side channel with IRON LAW §5 treatment: a batch that could not be carried reaches the judge
// as locations to read itself, which its constitution permits. That costs turns, not evidence.

// A location list travels as plain text on one argv slot — `path:line:line,path:line` — because
// paths and numbers are what a courier copies reliably, and its digest is taken over the exact
// string. A path carrying anything outside these characters would need quoting, so it is not
// sent: its locations reach the reader to open itself.
const CARRIABLE = /^[A-Za-z0-9_.\/@+:-]+$/
const carriable = (loc) => CARRIABLE.test(loc.path)

function locationList(locations) {
  const byPath = new Map()
  for (const loc of locations) {
    if (!byPath.has(loc.path)) byPath.set(loc.path, [])
    byPath.get(loc.path).push(loc.line)
  }
  return [...byPath].map(([path, lines]) => path + ':' + lines.join(':')).join(',')
}

// cmd.exe caps a whole command line at 8191 characters, so a list travels in batches of at most
// this many. Every location of one file goes in the same batch, so no two batches ever hold
// overlapping windows.
const COMMAND_BUDGET = 6000

function batchesOf(locations) {
  const byPath = new Map()
  for (const loc of locations) {
    if (!byPath.has(loc.path)) byPath.set(loc.path, [])
    byPath.get(loc.path).push(loc)
  }

  const batches = []
  let current = []
  for (const group of byPath.values()) {
    const grown = current.concat(group)
    if (current.length > 0 && locationList(grown).length > COMMAND_BUDGET) {
      batches.push(current)
      current = group
    } else {
      current = grown
    }
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function locationsCommand(repoPath, batch) {
  const list = locationList(batch)
  return `node "${pluginRoot}/lib/citations.mjs" excerpts --repo "${repoPath}" --locs "${list}" --digest ${fnv1a(list)}`
}

/** One judge's context files, and the locations that reached none of them. */
async function assembleContext(group) {
  const locations = locationsOf(hitsOf(group))
  if (locations.length === 0) {
    log(`No context to assemble${groupName(group) ? ' for ' + groupName(group) : ''}: no scout reported a location.`)
    return { parts: [], unread: new Set() }
  }

  const parts = []
  const unread = new Set()
  const failures = []

  const unsent = locations.filter((loc) => !carriable(loc))
  for (const loc of unsent) unread.add(locKey(loc.path, loc.line))
  if (unsent.length > 0) failures.push(`${unsent.length} location(s): a path the list cannot carry unquoted`)

  const batches = batchesOf(locations.filter(carriable))
  const base = ['assemble', groupName(group)].filter(Boolean).join(':')
  const carried = await Promise.all(batches.map((batch, i) =>
    carry(locationsCommand(repo, batch), batches.length === 1 ? base : `${base}:${i + 1}`,
      'Assemble context for analysis')))

  carried.forEach((held, i) => {
    const context = held.payload && held.payload.context
    if (context && Array.isArray(context.parts)) {
      parts.push(...context.parts)
    } else {
      for (const loc of batches[i]) unread.add(locKey(loc.path, loc.line))
      failures.push(`${batches[i].length} location(s): ${held.why || 'no context files came back'}`)
    }
  })

  if (failures.length > 0) {
    log(`WARNING: some locations were not assembled (${failures.join('; ')}); the judge reads ` +
      `those itself. More turns, not less evidence.`)
  }
  return { parts, unread }
}

// ------------------------------------------------------------ 7. judge

const hitLine = (h) => `  ${h.path}:${h.line} — ${h.note || ''}`

function topicSection(topic) {
  const f = scoutOf(topic)
  return `[${topic.key}] ${topic.find}\n` +
    `LOCATIONS FOUND:\n${f.hits.length ? f.hits.map(hitLine).join('\n') : '  (none)'}\n` +
    `SEARCH SURFACE ACTUALLY COVERED:\n${f.searched.join('\n') || '(none reported)'}` +
    (f.noMatch ? `\nSEARCHED AND NOT FOUND (this is evidence of absence):\n${f.noMatch}` : '') +
    (f.notReached ? `\nNEVER SEARCHED: ${f.notReached}` : '') +
    (f.complete
      ? `\nThe search was exhausted. Judge the surface above for yourself: if it does not ` +
        `actually cover the topic, say so in risks rather than accepting it.`
      : `\nWARNING: this search did NOT finish and is not exhaustive. Your conclusion inherits ` +
        `that limit — state what it rests on and what would change it.`)
}

// The shared ground, and the load-bearing warning when it did not finish: a judge reasoning over
// a shared surface nobody finished searching must be able to say what its conclusion rests on.
function sharedGroundSection() {
  if (!common) return ''
  return `\n\nSHARED GROUND (scouted once for every topic — treat it as part of your evidence):\n` +
    (common.hits.length ? common.hits.map(hitLine).join('\n') : '  (no locations)') +
    `\nSHARED GROUND SEARCH SURFACE COVERED:\n${common.searched.join('\n')}` +
    (common.noMatch
      ? `\nSHARED GROUND SEARCHED AND NOT FOUND (this is evidence of absence):\n${common.noMatch}`
      : '') +
    (common.complete
      ? ''
      : `\nWARNING: the shared-ground search did NOT finish. It never reached: ` +
        `${common.notReached}. Anything you conclude from the shared ground inherits that ` +
        `limit — state what your conclusion rests on.`)
}

function judgePrompt(group, context, continued) {
  const unread = hitsOf(group)
    .filter((h) => context.unread.has(locKey(h.path, Number.isInteger(h.line) ? h.line : 0)))
  const many = group.length > 1

  return `Judge ${many ? `these ${group.length} topics` : 'this topic'} of a larger question from ` +
    `the evidence below.\n\n` +
    (continued
      ? `A CONTINUATION: an earlier pass returned no verdict for ` +
        `${many ? 'these topics' : 'this topic'}. Judge ${many ? 'them' : 'it'} now.\n\n`
      : '') +
    `OVERALL QUESTION: ${question}\n\n` +
    `TOPICS — return exactly one verdict for each, with topic set to its key:\n\n` +
    group.map(topicSection).join('\n\n') +
    sharedGroundSection() +
    (context.parts.length > 0
      ? `\n\nCONTEXT FILES — every location above, read once for you by a script, overlapping ` +
        `windows merged. Read each file below whole before judging, and do not open the source ` +
        `files again to find these lines; a file's closing section names any location the ` +
        `script could not read:\n` +
        context.parts.map((p) => `  ${p.path} (${p.lines} line(s))`).join('\n')
      : '') +
    (unread.length > 0
      ? `\n\nLOCATIONS NOT EXCERPTED — the script could not read these for you (a lost ` +
        `transport, or a path it could not carry). Read each one yourself, in a line range around it, and nothing else; a ` +
        `location that does not exist is itself worth a line in risks:\n` + unread.map(hitLine).join('\n')
      : '') +
    `\n\nYou have no search tools. Judge what these show; where they are not enough to decide ` +
    `a topic, say what is missing in its risks rather than guessing.` +
    (many ? ` Every topic gets its own verdict — a verdict for one does not answer another.` : '')
}

/**
 * One judge's whole charge: its context assembled, a first pass, then a continuation on exactly
 * the topics it returned no verdict for, for as long as each pass rules on at least one more. No
 * counter ends it (IRON LAW §1); a pass that adds nothing ends it, and what it left is dropped,
 * loudly.
 */
async function judgeGroup(group) {
  const context = await assembleContext(group)
  const label = ['judge', groupName(group)].filter(Boolean).join(':')
  const ruled = new Map()
  let remaining = group
  let pass = 0

  while (remaining.length > 0) {
    pass++
    const keys = remaining.map((t) => t.key)
    const out = await agent(judgePrompt(remaining, context, pass > 1), {
      agentType: 'agentics:analyst', schema: verdictsSchema(keys),
      phase: 'Judge', label: label + (pass > 1 ? `#${pass}` : ''), ...tiered(judge, 'high'),
    }).catch((e) => {
      log(`${label}: the judge failed (${e && e.message}); its unruled topics are dropped.`)
      return null
    })
    if (!out) break

    const got = Array.isArray(out.verdicts) ? out.verdicts.filter(Boolean) : []
    let gained = 0

    // A judge holding one topic has one verdict to give: it is that topic's whatever key the
    // model typed, so a mistyped echo cannot turn a ruled topic into a dropped one.
    if (remaining.length === 1 && got.length > 0 && !got.some((v) => v.topic === keys[0])) {
      got[0] = { ...got[0], topic: keys[0] }
    }
    for (const v of got) {
      if (keys.includes(v.topic) && !ruled.has(v.topic)) {
        ruled.set(v.topic, v)
        gained++
      }
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

  return ruled
}

phase('Assemble context for analysis')
const rulings = await Promise.all(groups.map((group) => judgeGroup(group)))
const ruledBy = new Map()
for (const r of rulings) for (const [k, v] of r) ruledBy.set(k, v)

// ---------------------------------------------------------------- 8. account

const verdicts = []
const dropped = []
for (const topic of topics) {
  if (ruledBy.has(topic.key)) verdicts.push(ruledBy.get(topic.key))
  else dropped.push(topic.key)
}

if (dropped.length > 0) log(`WARNING: no verdict for topic(s): ${dropped.join(', ')}`)
if (partial.length > 0) log(`WARNING: could not search to exhaustion: ${partial.join(', ')}`)

const history = await historyChannel
const docs = await docsChannel

// A requested channel that produced nothing — it threw, it returned nothing, or the planner
// asked for it and then gave it no question. All three mean the evidence is not there, and any
// claim resting on it is unsupported.
const failedChannels = []
if (history.requested && !history.result) failedChannels.push('history')
if (docs.requested && !docs.result) failedChannels.push('docs')

// A channel that RETURNED but did not exhaust its search is not a failure and not a success.
// It belongs with the partially-searched topics: real evidence, known to be incomplete, and
// resumable.
const truncatedChannels = []
if (history.result && history.result.stop_reason !== 'exhausted') truncatedChannels.push('history')
if (docs.result && docs.result.stop_reason !== 'exhausted') truncatedChannels.push('docs')

if (truncatedChannels.length > 0) {
  log(`WARNING: evidence channel(s) returned without exhausting the search: ${truncatedChannels.join(', ')}`)
}

// Compose what the channel established WITH the limits of how it established it, so the
// evidence and its coverage travel as one string. Consumers interpolate this into a synthesis
// prompt under their own heading, which is why no heading appears here.
function channelEvidence(channel) {
  if (!channel.requested || !channel.result) return null
  const r = channel.result
  return r.findings +
    (r.no_match ? `\n\nLooked for and did not find: ${r.no_match}` : '') +
    (r.stop_reason === 'exhausted'
      ? ''
      : `\n\nCOVERAGE LIMIT (${r.stop_reason}) — never reached: ${r.not_reached}. Any claim ` +
        `depending on the unreached part is provisional. Say so rather than presenting it ` +
        `as settled.`)
}

// A topic that produced a verdict but never exhausted its search is still incomplete. One that
// produced nothing at all is already in `dropped`, so it is not counted twice.
const droppedKeys = new Set(dropped)
const incomplete = [...new Set(partial)].filter((k) => !droppedKeys.has(k)).concat(truncatedChannels)

return surveyResult(
  topics.map((t) => t.key),
  verdicts,
  channelEvidence(history),
  channelEvidence(docs),
  coverageOf(dropped, incomplete, failedChannels, []),
  [...new Set(topics.map((t) => groundPath(t.subtree)))],
)
