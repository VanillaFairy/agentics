export const meta = {
  name: 'vfa-survey',
  description: 'Gather evidence about a question across the local repos, git history, and vendor documentation. Returns structured findings plus a coverage block — never a conclusion.',
  whenToUse: 'The shared evidence phase for investigate, develop, find-existing-solutions and design. Call it via workflow("vfa-survey", args) as a nested step; it is rarely invoked directly.',
  phases: [
    { title: 'Plan' },
    { title: 'Scout' },
    { title: 'History' },
    { title: 'Docs' },
    { title: 'Analyze' },
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
// to carry", and each description says so outright. The earlier wording ("must be non-empty
// whenever stop_reason is not exhausted") read to an exhausted agent as "must be non-empty",
// so it omitted the field it had nothing for, tripped required-field validation, re-submitted
// the same shape until the platform killed it, and a finished search was dropped whole.
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
// field whose semantics are conditional is a deadlock, observed in the field. An agent
// with nothing to put in it omits it, validation rejects the whole report, the agent
// re-submits the same shape until the platform kills it, and evidence already gathered is
// dropped — the exact trade this file's header forbids for minItems-style bounds. Absence
// is normalized in the safe direction: a missing stop_reason never reads as "exhausted",
// so sloppiness degrades toward incomplete, never toward false completeness.

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
        required: ['key', 'find', 'kb_path'],
        properties: {
          key: { type: 'string', description: 'Short kebab-case identifier, unique within the plan.' },
          find: {
            type: 'string',
            description: 'A precise instruction for a read-only search agent: what to find and where to look.',
          },
          kb_path: {
            type: 'string',
            description:
              'The one subtree this topic is about, as a repo-relative POSIX path — a directory ' +
              'or a single file. The project knowledge base is read at exactly this path before ' +
              'the search runs, so a path naming the topic\'s real ground is what decides whether ' +
              'anything already known reaches it. Take it from the index you were shown where a ' +
              'node covers the topic; otherwise name where you expect the topic to live. Send an ' +
              'empty string — never omit the field — when the topic is genuinely repository-wide; ' +
              'the repository-wide level is then what it gets.',
          },
        },
      },
    },
    common_ground: {
      type: 'string',
      description:
        'A precise search instruction, in the same form as a topic\'s, for ground several ' +
        'topics would each need to read — a shared configuration object, a subsystem they all ' +
        'touch. It is scouted ONCE and what it finds is handed to every analyst alongside its ' +
        'own topic, so naming it here replaces the same files being searched and read once per ' +
        'topic. Send an empty string — never omit the field — when the topics genuinely share ' +
        'no ground.',
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
          path: { type: 'string', description: 'Path to the file containing the hit.' },
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
// indistinguishable from one that finished, because both arrive as a confident essay, and
// completeness reported only as prose is read by nothing in JS: a truncated-but-returned
// channel would still leave coverage.complete true.
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

// What a knowledge-base courier hands back: one command's stdout, byte-exact, in one string.
// Copied from `vfa-develop`'s CARRIED rather than shared, because a workflow script cannot
// import — the two are diffed against each other and against `lib/kb.mjs`'s output, never
// re-derived from memory.
//
// `failed` is the courier unable to run the command AT ALL — node missing, the path unreadable,
// the shell refusing. A knowledge base that ran and holds nothing is not that: it prints an empty
// payload, which is the ordinary state of a repository nobody has surveyed twice.
const CARRIED = {
  type: 'object',
  additionalProperties: false,
  required: ['stop_reason', 'payload_raw', 'notes'],
  properties: {
    stop_reason: { type: 'string', enum: ['carried', 'failed'] },
    payload_raw: { type: 'string' },
    notes: { type: 'string' },
  },
}

// What the knowledge-base courier hands back after a DEPOSIT. Copied from `vfa-develop`'s
// RECORDED, for the same reason every other copy here is one: a workflow script cannot import.
//
// `unwritable` is the writer refusing, or the shell truncating the command — either way what the
// survey learned is not durable, which is a fact its caller is told rather than a failure of the
// survey.
const DEPOSIT = {
  type: 'object', additionalProperties: false,
  required: ['stop_reason', 'path', 'notes'],
  properties: {
    stop_reason: { type: 'string', enum: ['recorded', 'unwritable'] },
    path: { type: 'string' },
    notes: { type: 'string' },
  },
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['topic', 'conclusion', 'evidence', 'risks'],
  properties: {
    topic: { type: 'string', description: 'The topic key you were given, copied exactly.' },
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
}

// ---------------------------------------------------------------- inputs

const input = typeof args === 'string' ? { question: args } : (args || {})
// Trimmed: the blank-question guard below tests truthiness, and a question of spaces is
// truthy — it would buy a judge-tier planner call before dying at the zero-topics exit.
const question = (input.question || '').trim()
const roots = input.roots || '.'
const notes = input.notes || ''
const maxTopics = input.max_topics || 8

// What an earlier phase of the same effort found, read out of `.claude/vfa/efforts/<effort>/` by
// the session that invoked this survey. It is DURABLE SCRATCH and it reaches exactly one place:
// the planner's prompt, where it can only change how the ground is decomposed.
//
// It reaches no scout, no analyst and no gate, and that is the whole of the rule. The null
// survey's collapse arithmetic reads one field — an entry's computed `state` — and reads no kind
// and no provenance, so anything admitted near it is admitted on freshness alone with no grading
// whatsoever. Prior context has no freshness to be checked and nothing anchoring it; if it could
// reach a gate it would be an unverified note laundered into a skipped phase. It cannot, because
// it is interpolated into one prompt and nowhere else.
const prior = typeof input.prior === 'string' ? input.prior.trim() : ''

// The intelligence dial. Three positions, each naming the judging tier rather than inheriting
// it: `low` is sonnet, `normal` is opus, `max` is fable. The judging tier in this workflow is
// the analysts — the one that plans the topics and the ones that rule on them.
//
// Every caller derives the position from the model it is running (fable → max, opus → normal,
// sonnet and below → low), and `develop` forwards its own dial into this nested call, so a run
// dialled to `low` reaches its analysis through this line and nowhere else. A position this
// script did not recognise is served as `normal`: dispatching at one tier while the caller
// reports the one it typed bills a run at one price and describes it at another.
const JUDGE_TIER = { low: { model: 'sonnet' }, normal: { model: 'opus' }, max: { model: 'fable' } }
const intelligence = Object.hasOwn(JUDGE_TIER, input.intelligence) ? input.intelligence : 'normal'
const judge = JUDGE_TIER[intelligence]

// ---------------------------------------------------------------- the knowledge base
//
// Where `lib/kb.mjs` lives, resolved the way `vfa-develop` resolves it: the caller's value, then
// the environment, then the shell form expanded in the agent's own shell. A script's cwd is not
// the agent's, so a relative path is never guessed at — and when the shell form is used, the
// dispatch carries an instruction to halt loudly rather than substitute one.
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

const rootWarning = pluginRoot === SHELL_ROOT
  ? '\n   If ' + SHELL_ROOT + ' is empty in your shell that path cannot resolve. Stop and say ' +
    'so in the way your result shape allows — never substitute a relative path or a guess.\n'
  : '\n'

// A knowledge base is PER REPOSITORY — no sharing and no merging across roots — so a question
// spanning several reads the first, which is the repository the question is anchored in.
const kbRepo = String(roots).split(/[,;\n]/)[0].trim() || '.'

// The normalization `lib/kb.mjs` performs on every path it is handed, written here so the key a
// chain comes back under is the key this side looks it up by. `.` and `` are the same node — the
// repository-wide level — and `.` is what travels on a command line, because an empty argv slot
// is a shell argument nobody can read.
const kbKey = (p) => {
  const norm = String(p == null ? '' : p).split('\\').join('/').trim()
    .replace(/^\.\//, '').replace(/\/+$/, '')
  return norm === '.' ? '' : norm
}
const kbArg = (p) => kbKey(p) || '.'

// The digest transport, in the one direction this workflow uses it. A payload computed on disk
// arrives through a model, so it is re-digested here before a field of it is believed — a copy
// that drifted by one character is refused rather than read. Both functions are copies of
// `lib/plan-digest.mjs`'s: scripts cannot import, and the suite pins them together.
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

// The other direction of the same transport. A line this script mints whole travels base64 on one
// argv slot — no path to escape, no apostrophe to close, no heredoc delimiter to indent — and the
// writer recomputes the digest after decoding. Copies of `vfa-develop`'s, for the same reason
// every other copy in this file is one: a workflow script cannot import.
function utf8Bytes(text) {
  const out = []

  for (const ch of String(text)) {
    const c = ch.codePointAt(0)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }

  return out
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64, padded. */
function base64(text) {
  const bytes = utf8Bytes(text)
  let out = ''

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1

    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4)]
    out += b1 < 0 ? '=' : B64_ALPHABET[((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6)]
    out += b2 < 0 ? '=' : B64_ALPHABET[b2 & 63]
  }

  return out
}

/** @returns {{payload: object|null, why: string|null}} */
function carriedRead(held) {
  if (!held) return { payload: null, why: 'the dispatch returned nothing' }
  if (held.stop_reason !== 'carried') {
    return { payload: null, why: held.notes || 'the courier could not run the command' }
  }

  let parsed = null
  try {
    parsed = JSON.parse(held.payload_raw)
  } catch (e) {
    return { payload: null, why: 'it did not survive transcription: ' + (e && e.message) }
  }

  if (parsed && parsed.error) return { payload: null, why: 'the reader refused: ' + parsed.error }
  if (!parsed || !parsed.payload || typeof parsed.payload_digest !== 'string') {
    return { payload: null, why: 'what came back is not a digest-covered envelope' }
  }

  const actual = fnv1a(canonical(parsed.payload))
  if (actual !== parsed.payload_digest) {
    return {
      payload: null,
      why: 'digest mismatch: it was computed as ' + parsed.payload_digest +
        ', what arrived digests to ' + actual,
    }
  }

  return { payload: parsed.payload, why: null }
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
// a survey with no question: it returns a coverage-honest empty result in milliseconds and
// the interrupted run's cached agents become unreachable. Field-observed 2026-08-27. They
// travel with the block a caller actually reads when deciding how to resume.
const LAUNCH_ARGS = { question, roots, notes, prior, max_topics: maxTopics, intelligence,
                      plugin_root: pluginRoot }

const RESUME_NOTE = 'a resume must re-pass `args` alongside resumeFromRunId — the script is ' +
  're-executed and reads nothing from the prior run; `args` here is that object'

// `from_kb` is the seventh field, and it exists for the same reason the other six do: a result
// built partly on what a previous run recorded looks exactly like one built entirely on this
// run's own search. It names, per topic, what came out of the project knowledge base and at which
// commit it was observed, so a reader can tell the two apart (IRON LAW §2 and §4).
//
// It is DERIVED from what this script actually handed to a dispatch, never from an agent's
// account of what it used — the same stance `complete` takes. Absence therefore degrades in the
// safe direction: no line means nothing came from cache, which is the reading that under-claims
// rather than over-claims, and it is what an older result with no field at all must be read as.
//
// A knowledge base that could not be read leaves a line here rather than in `failed_channels`,
// and that is deliberate: `failed_channels` is a conjunct of `complete` in this workflow, and an
// unreadable base costs a survey nothing it was going to have. It searches every topic from
// scratch, exactly as a survey with no knowledge base does. More work, not less evidence.
function coverageOf(dropped, incomplete, failedChannels, unreached, fromKb = []) {
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
    from_kb: fromKb,
    resumable: { runId: RUN_ID, remaining: dropped.concat(incomplete),
                 args: LAUNCH_ARGS, note: RESUME_NOTE },
  }
}

// Every exit path below returns this shape. A caller that receives `undefined` cannot tell
// "nothing found" from "nothing ran", and that is the failure this plugin exists to prevent.
//
// The parameter is named `coverageBlock` so the key can be written out as `coverage:` without
// reading as a redundant `coverage: coverage`. Style only — `coverage-block` understands ES
// shorthand in every position, so `{ …, coverage }` would lint clean too.
// `ground` is the subtrees the topics searched, repo-relative, `.` for a repository-wide topic. It
// is what a later phase anchors this survey to: the survey stays sound evidence exactly as long as
// no commit touches that ground (lib/effort.mjs, `standing`).
function surveyResult(topics, verdicts, history, docs, coverageBlock, ground = []) {
  return { question, topics, ground, verdicts, history, docs, coverage: coverageBlock }
}

if (!question) {
  return surveyResult([], [], null, null,
    coverageOf([], [], [], ['no question was supplied, so nothing was searched']))
}

log(`Question: ${question}`)

// ---------------------------------------------------------------- 1. plan

phase('Plan')

// What this repository already knows, and where — read BEFORE the decomposition, because the
// decomposition is what turns it into paths.
//
// The obvious design was chains at the question's roots, and it is the one the probe killed:
// before any scout runs the only known paths ARE the roots, and a chain at a root is the
// repository-wide node alone, so a planner handed it is handed almost nothing. The index is
// cheap for the opposite reason — it computes no state, only where entries sit and of what kind
// — and it is exactly what a decomposition can aim at. Chains come after, per topic, at the
// subtree each topic names.
//
// A side channel with IRON LAW §5 treatment: a base that cannot be read costs this survey
// nothing it was going to have. Every topic is then searched from scratch, which is how a
// survey with no knowledge base runs.
const kbNotes = []

const kbIndex = await (async () => {
  const held = await agent(
    `READ MODE. Report what this repository's knowledge base holds, and where — verbatim. You ` +
    `run one command and paste its output; you decide nothing and you interpret nothing.\n\n` +
    `REPOSITORY: ${kbRepo}\n\n` +
    `Run exactly this:\n\n` +
    `   node "${pluginRoot}/lib/kb.mjs" index "${kbRepo}"\n` +
    rootWarning +
    `Put its ENTIRE stdout into payload_raw, byte for byte, as one string. Do not parse it, do ` +
    `not reformat it, do not summarise it, and do not drop a node that looks unimportant to ` +
    `you. It is one line of JSON carrying its own digest: your caller recomputes that digest ` +
    `over what arrives, so a copy that drifted by a single character is detected rather than ` +
    `believed.\n\n` +
    `The index carries node paths, entry counts and kinds, and NO freshness — that is worked ` +
    `out per path later, and there is nothing here for you to add.\n\n` +
    `A repository with no knowledge base prints an index holding nothing, and that IS the good ` +
    `case. Return stop_reason failed ONLY when the command could not be run at all, with what ` +
    `the shell reported in notes.`,
    { agentType: 'vf-agentics:kb', effort: 'low', model: 'haiku', schema: CARRIED,
      phase: 'Plan', label: 'kb-index' },
  ).catch((e) => {
    log(`WARNING: the knowledge-base index failed to run: ${e && e.message}`)
    return null
  })

  const carried = carriedRead(held)
  if (!carried.payload) {
    log(`WARNING: the knowledge base could not be read (${carried.why}); every topic is ` +
      `searched from scratch.`)
    kbNotes.push('the project knowledge base could not be read (' + carried.why + '), so ' +
      'nothing in this result came from it: every topic was searched from scratch, exactly as ' +
      'every survey before the base existed')
    return null
  }

  const counts = carried.payload.counts || {}
  log(`Knowledge base: ${counts.entries || 0} entr(ies) across ${counts.nodes || 0} node(s).`)
  return carried.payload
})()

// The index, as the planner reads it: one line per node that holds something. Bounded by how many
// nodes hold anything rather than by how much any of them holds, so it does not grow with the
// base the way a chain dump would.
function indexSection() {
  const nodes = (kbIndex && kbIndex.nodes) || []
  if (nodes.length === 0) {
    return `\nThis repository's knowledge base holds nothing yet, so every topic is a topic ` +
      `nobody has searched before. Set kb_path to where you expect each topic to live anyway — ` +
      `it costs nothing and it is what a later run reads.\n`
  }

  return `\nWHAT THIS REPOSITORY ALREADY KNOWS, AND WHERE. The project knowledge base holds ` +
    `observations from earlier runs, filed under the narrowest directory each one is about. ` +
    `This is the SHAPE of it — paths, how many entries, of which kinds — and it says nothing ` +
    `about whether any of them is still true; that is checked per path, after you decompose.\n` +
    nodes.map((n) => `  ${n.node === '' ? '(repository-wide)' : n.node} — ${n.entries} ` +
      `entr${n.entries === 1 ? 'y' : 'ies'} (${Object.entries(n.kinds || {})
        .map(([kind, count]) => kind + ': ' + count).join(', ') || 'none'})`).join('\n') +
    `\n\nDecompose against this. Where a node covers a topic, set that topic's kb_path to the ` +
    `node's path and what is known there will be checked and handed to the search — a topic on ` +
    `covered ground becomes a VERIFICATION rather than a rediscovery, which is the whole reason ` +
    `this list is in front of you. Where nothing is recorded, plan the topic exactly as you ` +
    `would have anyway: the base is a saving where it applies and never a reason to search ` +
    `less.\n`
}

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
  `because it reaches every topic's analyst. Give each a short kebab-case key and a precise ` +
  `instruction for a read-only search agent: what to find, and where to look. Size each ` +
  `topic so a single search agent can exhaust it in one pass — one subsystem, one named ` +
  `concern. Prefer more, smaller topics over one merged catch-all: a kitchen-sink topic ` +
  `forces a partial first pass, and everything later is built on what these searches ` +
  `return.\n\n` +
  `When several topics would each need to read the same files, do NOT fold that surface ` +
  `into each of them. Name it once in common_ground, as a precise instruction for a single ` +
  `search agent: it is searched once, and every analyst receives what it finds alongside ` +
  `its own topic's locations. Then confine each topic's instruction to what is unique to ` +
  `that topic. Send an empty string when the topics genuinely share no ground.\n\n` +
  `Set history_needed if answering the question requires git history rather than the ` +
  `current tree: when a behaviour changed, which commit introduced or removed something, ` +
  `why code is the way it is, or any regression. Put that question in history_question. ` +
  `A search of the current tree cannot answer these, so getting this flag wrong produces ` +
  `a confident wrong answer.\n\n` +
  `Set docs_needed only if answering the question requires vendor or standards ` +
  `documentation that is not in these repositories. Put that question in docs_question.\n\n` +
  indexSection() +
  `\nGive every topic a kb_path: the one subtree it is about, repo-relative, or an empty ` +
  `string when the topic is genuinely repository-wide. It is read before the search runs, so a ` +
  `path that names the topic's real ground is what decides whether anything already known ` +
  `reaches it.\n\n` +
  `Leave a question field as an empty string when its flag is false. When a flag is true ` +
  `the matching question must be non-empty — a true flag with no question skips the track ` +
  `entirely and the answer silently loses that evidence.\n` +
  `Do not search anything yourself. Plan only.`,
  { agentType: 'vf-agentics:analyst', effort: 'medium', schema: PLAN, label: 'plan', ...judge },
).catch((e) => {
  log(`WARNING: planning failed: ${e && e.message}`)
  return null
})

if (!plan || !plan.topics || plan.topics.length === 0) {
  return surveyResult([], [], null, null,
    coverageOf([], [], [], ['planning produced no topics, so nothing was searched'], kbNotes))
}

// The cap in the prompt is sizing guidance to the planner, never a licence to drop work:
// every topic the planner decided the question needs gets searched. Cutting the list here
// would undersurvey the one stage everything else is built on — the earlier behaviour of
// slicing the overflow off produced runs whose plans rested on evidence nobody gathered.
// Cost is controlled by method — cheap scouts, tight schemas — not by cutting work (§8).
if (plan.topics.length > maxTopics) {
  log(`Planner returned ${plan.topics.length} topics (asked for at most ${maxTopics}); searching all of them.`)
}

// The ground the planner says several topics would each have to read. Read defensively: a
// plan from before this field existed is not a broken plan, it is a plan with no shared
// ground, and it must degrade to exactly that rather than throwing on the way past.
const commonFind = (plan.common_ground || '').trim()

log(`Plan: ${plan.topics.length} topic(s)` +
    `${commonFind ? ' + common ground' : ''}` +
    `${plan.history_needed ? ' + git history' : ''}` +
    `${plan.docs_needed ? ' + documentation' : ''}`)

// ------------------------------------------------- 1b. the chains, one per topic's subtree
//
// Now that the topics exist, their ground has names — so the chains are fetched at those names
// rather than at the roots. One courier carries all of them: a chain is bounded by depth, the
// chains are independent of each other, and buying one dispatch per topic would buy the same
// courier N times for a payload that arrives once.
//
// A topic with no path named is chained at the repository-wide level, which is what `.` resolves
// to inside the reader. Nothing is chained at all when the index already said the base holds
// nothing: a chain over an empty tree is a dispatch bought for nothing.
const kbChains = new Map()

// Keyed per topic, not per path, because two topics may name the same subtree and each still has
// its own account to give.
const topicPath = (topic) => kbKey(topic && topic.kb_path)

const kbFetch = kbIndex && (kbIndex.counts || {}).entries > 0
  ? [...new Set(plan.topics.map((t) => kbArg(topicPath(t))))]
  : []

if (kbFetch.length > 0) {
  const held = await agent(
    `READ MODE. Read what this repository's knowledge base already holds about the ground ` +
    `these searches are about to cover, and return it verbatim. You run one command and paste ` +
    `its output; you decide nothing and you interpret nothing.\n\n` +
    `REPOSITORY: ${kbRepo}\n\n` +
    `Run exactly this:\n\n` +
    `   node "${pluginRoot}/lib/kb.mjs" chain "${kbRepo}" ` +
    kbFetch.map((p) => '"' + p + '"').join(' ') + `\n` +
    rootWarning +
    `Put its ENTIRE stdout into payload_raw, byte for byte, as one string. Do not parse it, do ` +
    `not reformat it, do not summarise it, and do not drop an entry that reads stale or ` +
    `redundant to you. It is one line of JSON carrying its own digest: your caller recomputes ` +
    `that digest over what arrives, so a copy that drifted by a single character is detected ` +
    `rather than believed.\n\n` +
    `Every entry in it arrives with a state the program COMPUTED — fresh, stale or orphaned — ` +
    `from git and from the bytes of the files each entry is anchored to. You do not agree or ` +
    `disagree with those and you never re-check one.\n\n` +
    `Return stop_reason failed ONLY when the command could not be run at all, with what the ` +
    `shell reported in notes.`,
    { agentType: 'vf-agentics:kb', effort: 'low', model: 'haiku', schema: CARRIED,
      phase: 'Plan', label: 'kb-chain' },
  ).catch((e) => {
    log(`WARNING: the knowledge-base chain read failed to run: ${e && e.message}`)
    return null
  })

  const carried = carriedRead(held)
  if (!carried.payload) {
    log(`WARNING: the chains could not be read (${carried.why}); every topic is searched from ` +
      `scratch.`)
    kbNotes.push('the knowledge base was indexed but its chains could not be read (' +
      carried.why + '), so nothing in this result came from it: every topic was searched from ' +
      'scratch')
  } else {
    for (const chain of carried.payload.chains || []) {
      kbChains.set(kbKey(chain.path), chain.entries || [])
    }
    const counts = carried.payload.counts || {}
    log(`Chains: ${counts.fresh || 0} fresh, ${counts.stale || 0} stale, ` +
      `${counts.orphaned || 0} orphaned across ${kbFetch.length} subtree(s). Fresh entries are ` +
      `evidence and turn their topic into a verification; stale ones are leads for the search.`)
  }
}

/**
 * What the base holds for one topic, split by what each state is worth.
 *
 * Fresh is EVIDENCE: a program checked the ground it is about and found it untouched since the
 * observation. Stale is a LEAD: the ground moved, so the claim is a place to look and never a
 * fact to report — which is exactly what a search can use and a coder mid-order cannot.
 * Orphaned is about ground that is gone and rides nothing.
 */
function kbForTopic(topic) {
  const entries = kbChains.get(topicPath(topic)) || []
  return {
    fresh: entries.filter((e) => e && e.state === 'fresh'),
    leads: entries.filter((e) => e && e.state === 'stale'),
  }
}

const entryLine = (e) => '- [' + e.kind + ', seen at ' + (e.observed_at || 'an unrecorded commit') +
  '] ' + e.claim

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
// agent's account of itself: a round that re-treads old ground while naming the same
// remainder would otherwise be resumed forever.
// A remainder, normalized for comparison. Whitespace and case only: two roundsly-worded
// descriptions of the same unreached surface are the same surface, and the question here is
// whether the search advanced, not how it was phrased.
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
    // narrowed the surface still to cover. Neither means the round achieved nothing, whatever
    // it says about itself.
    //
    // The remainder half is what closes the paraphrase loop. `absorb` used to judge progress
    // by counting new `searched` lines, and an agent obediently told not to repeat itself
    // rewords its account of the same ground every round — new lines, no new knowledge, the
    // same remainder, forever. That is not a search that needs more time; it is a search that
    // has stopped moving, and left alone it runs until something outside the workflow kills
    // it, which in the field means a usage limit taking every parallel agent with it.
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
// Both run alongside the scouts, and both are driven through the same resume engine: a
// historian that hands back an honest partial is resumed until the search is done, exactly
// like a scout — before this, the channels were single-shot and a truncated one was merely
// recorded. IRON LAW §5 still holds: a side-channel failure must not discard the scout and
// analyst work already paid for, so nothing here rejects.
//
// Every outcome is recorded, including the one that used to vanish: a track the planner
// marked necessary and then gave no question for. That case reported as neither researched
// nor failed — the channel silently never ran, and coverage still came back complete.

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

// A channel's rounds accumulate prose findings rather than hit lists, so the engine's
// progress measure is the searched surface — the one part of the contract that is
// deduplicable — and the merged rounds keep the shape every consumer already reads:
// findings plus the coverage fields. Returns null when no round ever produced a result,
// which sideChannel records as the failed channel it is.
async function channelToExhaustion({ key, first, launch }) {
  const findings = []
  const searched = []
  const noMatch = []
  const seen = new Set()
  const seenFindings = new Set()
  let sawResult = false

  // Returns whether the round brought back EVIDENCE nobody had. Deliberately not "wrote a
  // line nobody had written": `searched` is an account of where the agent went, and an agent
  // told not to repeat itself will describe the same ground in fresh words indefinitely. The
  // accumulator still collects those lines — the resume prompt needs them — but they no
  // longer testify to progress.
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
      agentType: 'vf-agentics:historian', effort: 'low', schema: HISTORY,
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
      agentType: 'vf-agentics:doc-researcher', effort: 'low', schema: DOCS,
      phase: 'Docs', label: `docs${round > 1 ? `#${round}` : ''}` }),
  }),
)

// -------------------------------------------------- 4. scout -> 5. analyze

const partial = []

// What each scout actually covered, kept for the deposit at the end. The verdict pipeline
// consumes a scout's result and returns an analyst's, so without this the one fact the deposit
// turns on — an exhausted search that found nothing — would be gone by the time it is needed.
const scouted = new Map()

// Search to exhaustion. IRON LAW §3: an incomplete scout is RESUMED, never reported as a
// result. The engine owns the stop conditions; this wrapper owns what a scout accumulates —
// deduplicated hits and searched surface, which double as the engine's progress measure.
async function scoutUntilComplete(topic) {
  const hits = []
  const searched = []
  const noMatch = []
  const seen = new Set()

  // Progress is HITS, not lines of self-report. A scout told not to repeat itself will keep
  // producing fresh descriptions of ground it has already covered, and counting those as
  // progress resumed such a scout forever — see the engine's stuck exit for what that costs.
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
  // leave it alone. Without this the topics that share a surface each re-read it, and each
  // of their analysts then pays to read the same code again — the redundancy this field
  // exists to remove. The common scout itself is never handed the exclusion.
  const exclude = commonFind && topic.key !== 'common-ground'
    ? `\n\nA separate scout covers this shared ground — do not search it:\n${commonFind}`
    : ''

  // What the base holds about this topic's ground, said in the two ways the two states are
  // worth. The distinction is stated verbatim-clearly rather than left for a scout to infer:
  // fresh entries make this topic a
  // VERIFICATION, and stale ones are places to look that no report may rest on.
  const known = kbForTopic(topic)

  const kbBrief =
    (known.fresh.length === 0 ? '' :
      `\n\nALREADY RECORDED ABOUT THIS GROUND — a program checked each of these against the ` +
      `current tree just now and found the ground it is about untouched since it was observed. ` +
      `They are EVIDENCE, not a search you have to redo:\n` +
      known.fresh.map(entryLine).join('\n') +
      `\n\nSo this topic is a VERIFICATION rather than a rediscovery. Confirm the locations ` +
      `these name still exist and report them as hits, and spend the rest of your pass on what ` +
      `they do NOT cover. If one of them turns out to be wrong about the current tree, that is ` +
      `a finding: say so in no_match rather than reporting the claim as a location.`) +
    (known.leads.length === 0 ? '' :
      `\n\nLEADS — the base held these and the ground has moved since, so nothing attests them. ` +
      `They are places to look and never facts to report: confirm anything you use against the ` +
      `current tree, and never report a location you have not seen for yourself:\n` +
      known.leads.map(entryLine).join('\n'))

  const prompt = (round, prev) => round === 1
    ? `${topic.find}${exclude}${kbBrief}\n\nRepositories: ${roots}\n\n` +
      `Report every location you find, and search to exhaustion: you stop when the surface ` +
      `is covered or you are genuinely stuck, never because the list is getting long or ` +
      `the work feels large. If one pass truly cannot cover the request, report what you ` +
      `have, set stop_reason to "unfinished", and name exactly what remains in ` +
      `not_reached — you will be resumed until the search is done.`
    : `Continue an unfinished search — do not start over.\n\n` +
      `ORIGINAL REQUEST: ${topic.find}${exclude}${kbBrief}\n` +
      `Repositories: ${roots}\n\n` +
      `ALREADY SEARCHED (do not repeat these):\n${searched.join('\n')}\n\n` +
      `ALREADY FOUND (do not report these again):\n` +
      hits.map((h) => `${h.path}:${h.line}`).join('\n') +
      `\n\nSTILL NOT REACHED — this is your job now:\n${prev.not_reached}`

  const launch = (p, round) => agent(p, {
    agentType: 'vf-agentics:scout', effort: 'low', schema: HITS,
    phase: 'Scout', label: `scout:${topic.key}${round > 1 ? `#${round}` : ''}`,
  })

  const end = await resumeToExhaustion({ key: topic.key, prompt, launch, absorb })
  if (!end.exhausted) partial.push(topic.key)

  const found = {
    hits, searched, complete: end.exhausted, noMatch: noMatch.join('\n'), notReached: end.notReached,
  }
  scouted.set(topic.key, found)
  return found
}

// Launched before the pipeline rather than inside it: it is one search whose result every
// topic's analyst reads, so it runs alongside the topic scouts instead of after them. It is
// an ordinary scout in every other respect — same labels, same phase, same resume to
// exhaustion, and the same entry in `partial` when it does not get there.
const commonGround = commonFind
  ? scoutUntilComplete({ key: 'common-ground', find: commonFind })
  : Promise.resolve(null)

// What the shared scout found, written into every analyst's evidence. The warning is the
// load-bearing half: an analyst reasoning over a shared surface nobody finished searching
// must be able to say what its conclusion rests on (IRON LAW §4).
function sharedGroundSection(common) {
  if (!common) return ''
  return `\n\nSHARED GROUND (scouted once for every topic — treat it as part of your evidence):\n` +
    JSON.stringify(common.hits, null, 1) +
    `\n\nSHARED GROUND SEARCH SURFACE COVERED:\n${common.searched.join('\n')}` +
    (common.noMatch
      ? `\n\nSHARED GROUND SEARCHED AND NOT FOUND (this is evidence of absence):\n${common.noMatch}`
      : '') +
    (common.complete
      ? ''
      : `\n\nWARNING: the shared-ground search did NOT finish. It never reached: ` +
        `${common.notReached}. Anything you conclude from the shared ground inherits that ` +
        `limit — state what your conclusion rests on.`)
}

// The fresh entries this topic's analyst reasons over, and the one instruction that makes them
// distinguishable in the verdict. Leads are deliberately NOT here: a lead is for somebody going
// looking, and this agent is judging what was found rather than going anywhere.
function cachedEvidenceSection(topic) {
  const fresh = kbForTopic(topic).fresh
  if (fresh.length === 0) return ''

  return `\n\nKNOWN BEFORE THIS RUN (the project knowledge base, checked against the current ` +
    `tree just now and still standing) — this is CACHED evidence: an earlier run observed it, ` +
    `and this run did not go and see it again:\n` +
    fresh.map(entryLine).join('\n') +
    `\n\nWhere your conclusion rests on one of these rather than on a location above, say so in ` +
    `the evidence line itself — "from the knowledge base, observed at <commit>". A conclusion ` +
    `that cannot be told apart from one built on a search this run actually performed is the ` +
    `one failure this whole workflow exists to prevent.`
}

const findings = await pipeline(
  plan.topics,

  (topic) => scoutUntilComplete(topic),

  async (found, topic) => agent(
    `Answer this part of a larger question, using the locations below as your starting point.\n\n` +
    `OVERALL QUESTION: ${question}\n` +
    `THIS TOPIC: ${topic.find}\n\n` +
    `LOCATIONS FOUND (read only what you need, in line ranges):\n` +
    JSON.stringify(found.hits, null, 1) +
    `\n\nSEARCH SURFACE ACTUALLY COVERED:\n${found.searched.join('\n')}` +
    (found.noMatch ? `\n\nSEARCHED AND NOT FOUND (this is evidence of absence):\n${found.noMatch}` : '') +
    (found.notReached ? `\n\nNEVER SEARCHED: ${found.notReached}` : '') +
    cachedEvidenceSection(topic) +
    sharedGroundSection(await commonGround) +
    (found.complete
      ? `\n\nThe search was exhausted. Judge the search surface above for yourself: if it ` +
        `does not actually cover the topic, say so in risks rather than accepting it.`
      : `\n\nWARNING: the search did NOT finish and is not exhaustive. Your conclusion ` +
        `inherits that limit — state what it rests on and what would change it.`) +
    `\n\nDo not search yourself. Judge what these show. Set topic to exactly "${topic.key}".`,
    { agentType: 'vf-agentics:analyst', effort: 'high', schema: VERDICT,
      phase: 'Analyze', label: `analyze:${topic.key}`, ...judge },
  ).catch((e) => {
    // The only unguarded agent call would be this one. The reconciliation below already
    // assumes a failed item arrives as falsy; catching here makes that true whatever
    // pipeline() does with a rejection, and keeps the promise that survey never throws.
    // The topic then falls into `dropped`, so coverage.complete goes false rather than the
    // whole run dying and the caller getting nothing it can reason about.
    log(`${topic.key}: analysis failed (${e && e.message}); reporting the topic as dropped.`)
    return null
  }),
)

// ---------------------------------------------------------- 6. account

// Reconcile by pipeline index, not by the topic string the analyst echoed back. pipeline()
// preserves order, so this is exact and needs no cooperation from the model — a verdict that
// came back under a mistyped key used to be counted as dropped and included as evidence at
// the same time.
const verdicts = []
const dropped = []
plan.topics.forEach((topic, i) => {
  if (findings[i]) verdicts.push(findings[i])
  else dropped.push(topic.key)
})

if (dropped.length > 0) log(`WARNING: no result for topic(s): ${dropped.join(', ')}`)
if (partial.length > 0) log(`WARNING: could not search to exhaustion: ${partial.join(', ')}`)

const history = await historyChannel
const docs = await docsChannel

// A requested channel that produced nothing — it threw, it returned nothing, or the planner
// asked for it and then gave it no question. All three mean the same thing downstream: the
// evidence is not there, and any claim resting on it is unsupported.
const failedChannels = []
if (history.requested && !history.result) failedChannels.push('history')
if (docs.requested && !docs.result) failedChannels.push('docs')

// A channel that RETURNED but did not exhaust its search is not a failure and not a success.
// It belongs with the partially-searched topics: real evidence, known to be incomplete, and
// resumable. Before the channels carried a stop_reason this case was invisible, and a
// half-read history left coverage.complete true.
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

const unreached = []

// A topic that produced a verdict but never exhausted its search is still incomplete. One
// that produced nothing at all is already in `dropped`, so this filter prevents it being
// counted twice.
const droppedKeys = new Set(dropped)
const incomplete = partial.filter((k) => !droppedKeys.has(k)).concat(truncatedChannels)

// ---------------------------------------------------------- 5b. what this survey can deposit
//
// One kind, and it is the only one a survey can honestly mint: `absence`. A search that was
// EXHAUSTED and came back with nothing is the one thing a scout establishes that no later run can
// cheaply re-establish — it costs a full search to learn that a full search finds nothing.
//
// Two rules make it safe, and both were forced rather than chosen.
//
// ONLY FROM AN EXHAUSTED SEARCH. An absence from a scout that stopped early is a false negative
// written into the base as evidence, and the collapse arithmetic would then skip a survey on the
// strength of a search that never finished. `complete` here is `stop_reason === 'exhausted'`,
// derived by the resume engine and never claimed by an agent.
//
// THE ID IS MINTED FROM STABLE INPUTS. Shadowing works because re-observing a fact mints the same
// id from the same bytes, which is what makes newest-id-wins do any work at all. So the id hashes
// the topic's SUBTREE and its KEY — a path and a kebab slug, short and stable across passes that
// search the same ground — and never the claim's prose. The prose then carries what the scout
// looked for and did not find, and a later pass that phrases it differently SHADOWS its
// predecessor with better wording instead of appending a near-duplicate beside it. That is
// precisely the failure that keeps `structural` unwritten: a model-authored sentence rehashes
// every time, so the base grows without ever consolidating.
//
// This is an addition, not the relocation an earlier draft proposed: `vfa-develop`'s run-end
// deposit is untouched, and its two producers — `gotcha` from an approved order's discovered set,
// `command` from a verification — keep working exactly as they do, because both are built from
// run-time material that does not exist when a survey runs.
const COMMAND_BUDGET = 5000

function absenceDeposits() {
  const entries = []

  for (const topic of plan.topics) {
    const path = topicPath(topic)
    const found = scouted.get(topic.key)

    // A repository-wide absence is too broad to mean anything, and `about` cannot be empty.
    if (!path || !found || !found.complete || found.hits.length > 0) continue

    const surface = String(found.noMatch || '').replace(/\s+/g, ' ').trim()
    entries.push({
      id: 'absence:' + fnv1a(path + '\u0000' + topic.key),
      claim: 'an exhausted search of ' + path + ' for ' + topic.key + ' found nothing' +
        (surface ? ': ' + surface : ''),
      kind: 'absence',
      about: [path],
      // The script has no filesystem and no git, so the commit is measured by the writer in the
      // repository rather than guessed at here or asked of a model.
      observed_at: 'HEAD',
      source: { via: 'survey-absence', topic: topic.key },
    })
  }

  return entries
}

function absencePrompt(entries) {
  const batches = []
  let current = []
  for (const entry of entries) {
    const grown = current.concat([entry])
    if (current.length > 0 && base64(JSON.stringify({ entries: grown })).length > COMMAND_BUDGET) {
      batches.push(current)
      current = [entry]
    } else {
      current = grown
    }
  }
  if (current.length > 0) batches.push(current)

  const commands = batches.map((batch) =>
    `node "${pluginRoot}/lib/kb.mjs" append "${kbRepo}" ` +
    `--digest ${fnv1a(canonical({ entries: batch }))} ` +
    `--b64 ${base64(JSON.stringify({ entries: batch }))}`).join('\n\n')

  return `DEPOSIT MODE. Append what these searches established to the project knowledge base.\n\n` +
    `REPOSITORY: ${kbRepo}\n\n` +
    (batches.length === 1
      ? `Run exactly this, as ONE line:\n\n`
      : `Run these ${batches.length} commands, each as ONE line, in this order. They are ` +
        `separate batches of the same deposit and each is written on its own — a later one ` +
        `failing does not undo an earlier one:\n\n`) +
    commands + `\n\n` +
    rootWarning +
    `The long token is a batch of entries, base64-encoded. Copy it as one unbroken string — do ` +
    `not wrap it, do not insert a newline or a backslash continuation, and do not quote it. It ` +
    `contains only letters, digits, +, / and = , so there is nothing in it for a shell to ` +
    `interpret. The writer decodes it and recomputes the digest above over what came out; a ` +
    `token that changed by one character is REFUSED and NOTHING is written.\n\n` +
    `Every entry here says the same kind of thing: a search of a named subtree was run to ` +
    `exhaustion and found nothing. You do not choose where one lands, you do not reword a ` +
    `claim, and you do not drop one that reads uninteresting — an absence is often the finding ` +
    `that decides a question, and it is the one thing a later run cannot cheaply re-establish.\n\n` +
    `Read each writer's output. {"ok":true,...} means that batch is on disk. ` +
    `{"ok":false,"error":...} means it refused; the error names what was wrong. Run that ` +
    `command again, the whole token.\n\n` +
    `If a command comes back from the SHELL rather than from the writer — "unexpected EOF", a ` +
    `truncated line, an unmatched quote — the command line was too long for this platform and ` +
    `retyping it will fail the same way every time. Do not try a heredoc or a script file: ` +
    `those put the same token on the same one command line. Write the token to a file in ` +
    `pieces instead, with several appends, and then pass the PATH:\n\n` +
    `   printf %s '<first piece>' > kb-deposit.b64\n` +
    `   printf %s '<next piece>' >> kb-deposit.b64\n` +
    `   node "${pluginRoot}/lib/kb.mjs" append "${kbRepo}" --digest <that batch's digest> ` +
    `--b64-file kb-deposit.b64\n\n` +
    `Only when a batch has failed both ways: return stop_reason unwritable with the error ` +
    `verbatim in notes. Return stop_reason recorded only when every batch above reported ok:true.`
}

const absences = absenceDeposits()

if (absences.length > 0) {
  // A side channel with IRON LAW §5 treatment: it is written for the NEXT run, so a deposit that
  // does not land costs this result nothing it was going to have. It is still said out loud —
  // silently learning nothing durable is how a repository stays as ignorant on run 20 as on run 1.
  const held = await agent(absencePrompt(absences), {
    agentType: 'vf-agentics:kb', effort: 'low', model: 'haiku', schema: DEPOSIT,
    phase: 'Analyze', label: 'kb-deposit',
  }).catch((e) => {
    log(`WARNING: the knowledge-base deposit failed to run: ${e && e.message}`)
    return null
  })

  if (held && held.stop_reason === 'recorded') {
    log(`Deposited ${absences.length} absence entr(ies): ` +
      absences.map((e) => e.about[0]).join(', ') + '.')
    kbNotes.push(`${absences.length} exhausted search(es) that found nothing were deposited to ` +
      `the project knowledge base, so a later run reads them instead of buying the same empty ` +
      `search again. Nothing in THIS result came from them — they were written by it.`)
  } else {
    log(`WARNING: what these searches established was not made durable ` +
      `(${(held && held.notes) || 'the deposit dispatch returned nothing'}).`)
    kbNotes.push('this survey exhausted ' + absences.length + ' search(es) that found nothing ' +
      'and could not write them to the knowledge base, so the next run over this ground pays ' +
      'for the same empty searches again. It costs this result nothing.')
  }
}

// Provenance, computed from what this script actually handed to a dispatch — never from an
// analyst's account of what it leaned on. One line per topic that received cached evidence,
// naming how much and the commits it was observed at, so a reader can see which part of this
// result was searched for today and which part was recalled.
//
// A topic that received only leads gets no line: a lead is not evidence, no verdict rests on
// one, and claiming provenance for something nothing was built on would make this field mean
// less rather than more.
const fromKb = kbNotes.slice()
let verificationTopics = 0

for (const topic of plan.topics) {
  const fresh = kbForTopic(topic).fresh
  if (fresh.length === 0) continue
  verificationTopics++

  const shas = [...new Set(fresh.map((e) => e.observed_at || 'an unrecorded commit'))]
  fromKb.push(`${topic.key}: ${fresh.length} fresh knowledge-base entr` +
    `${fresh.length === 1 ? 'y' : 'ies'} for ${topicPath(topic) || '(repository-wide)'} entered ` +
    `this topic's evidence, observed at ${shas.join(', ')}. This run did not re-establish what ` +
    `they carry; the search covered what they do not.`)
}

// The degenerate case the topology rule names: every topic already covered, so what ran was one
// verification pass rather than a discovery survey. Said out loud, because a phase that shrinks
// without saying so is exactly the silent maximalism-in-reverse the coverage block exists against.
if (verificationTopics > 0 && verificationTopics === plan.topics.length) {
  fromKb.push('every topic in this plan rested on fresh knowledge-base ground, so what ran was ' +
    'a verification pass rather than a discovery survey: the searches confirmed what was ' +
    'already recorded and covered what it did not reach.')
  log('Every topic was a verification topic — this survey ran as a verification pass.')
}

return surveyResult(
  plan.topics.map((t) => t.key),
  verdicts,
  channelEvidence(history),
  channelEvidence(docs),
  coverageOf(dropped, incomplete, failedChannels, unreached, fromKb),
  [...new Set(plan.topics.map((t) => kbArg(t.kb_path)))],
)
