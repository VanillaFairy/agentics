export const meta = {
  name: 'search-for-existing-solutions-before-building',
  description: 'Before building something, find what already exists that does it: libraries, tools, standards, services, and whatever this repository already depends on. Returns candidates with licence, version and fit facts plus a coverage block — never a recommendation.',
  whenToUse: 'The build-or-adopt evidence phase. Called by the design skill before approaches are drawn up, and invocable on its own. Distinct from gather-evidence-without-concluding, which searches the code you already have; this one searches the world outside it.',
  phases: [
    { title: 'Frame', detail: 'analyst: the capability, its hard constraints, and what disqualifies a candidate' },
    { title: 'Search', detail: 'one researcher per ecosystem angle, plus a scout over your existing dependencies' },
    { title: 'Assess', detail: 'analyst: dedupe, then rule each candidate against the declared disqualifiers' },
    { title: 'Record', detail: 'candidates and what the repository already carries, into the project-wide evidence pool' },
  ],
}

// ---------------------------------------------------------------- what this is for
//
// `gather-evidence-without-concluding` answers "how does the code we have work". This workflow answers a question
// nothing else in the plugin asks: **should we write this at all?** By the time `develop`
// runs, the change is ratified and the planner decomposes what to build; build-or-adopt is
// already settled. Design is the only stage where the question is still cheap, and it needs
// evidence rather than an opinion.
//
// The failure mode it exists to prevent is specific and quiet: a shallow look that finds
// nothing, followed by three weeks of writing something that was on a registry all along.
// That is why an empty candidate list is NOT a green light on its own — an empty list from a
// sweep that never reached crates.io is a different answer from an empty list after an
// exhausted one, and only the coverage block tells them apart (IRON LAW §2, §4).
//
// It recommends nothing. Licence tolerance, dependency appetite and "we want to own this"
// are the caller's to weigh; this returns the facts they weigh.

// ---------------------------------------------------------------- schemas
//
// No minItems / maxItems / minLength / maxLength anywhere: structured outputs do not support
// them, so a bound written here would silently do nothing or turn a good result into a
// dropped one. Every bound lives in the prompt as behaviour and is enforced in JS.
//
// No verdict booleans. Whether a candidate is viable is COMPUTED below from the
// disqualifiers it was measured against — the moment a schema offers `suitable: boolean`,
// the decision migrates out of JS and into a model's taste.
//
// Field semantics go in `description`, never in a comment: comments are stripped before a
// schema reaches the model, so a contract written only in a comment binds nobody.

// The coverage contract every search channel answers to, identical in spirit to gather-evidence-without-concluding's.
// `no_match` and `not_reached` stay apart on purpose, and here the distinction is the whole
// point of the workflow: "I searched npm and nothing there does this" is a FINDING that
// supports building. "I never searched npm" is a HOLE that supports nothing at all.
// Every coverage field is ALWAYS present — an empty string is the correct value for "nothing
// to carry", and each description says so outright. Conditional-sounding wording ("must be
// non-empty whenever...") read to an exhausted agent as "must be non-empty", so it omitted
// the field it had nothing for, tripped required-field validation, re-submitted the same
// shape until the platform killed it, and a finished search was dropped whole.
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
      'Always include this field. "exhausted" — you covered the surface you were asked to ' +
      'cover and can name it. "unfinished" — one pass could not cover the surface; you are ' +
      'handing back an honest partial and the caller will resume you until the search is ' +
      'done. "stuck" — you could not find a way forward. Cost, effort already spent, and ' +
      'the size of your report are never reasons to stop: never stop because the work ' +
      'feels large. Only "exhausted" counts as complete, so claim it only when it is true. ' +
      'The other two are not failures: the caller will resume you.',
  },
  no_match: {
    type: 'string',
    description:
      'What you looked for and genuinely did not find. This is a FINDING, not a gap — here ' +
      'it is often the finding that decides the question, because it is what says nothing ' +
      'off the shelf does this. Name the surface it is true of ("no maintained Rust crate ' +
      'on crates.io"), never just "nothing found". Send an empty string — never omit the ' +
      'field — when everything you looked for was there.',
  },
  not_reached: {
    type: 'string',
    description:
      'What you never searched at all, named specifically enough for someone else to pick ' +
      'it up without redoing your work. Send an empty string when stop_reason is ' +
      '"exhausted"; otherwise it must name what remains. Never merge this with no_match: ' +
      'an unsearched ecosystem reported as an empty one is how a team ends up rebuilding ' +
      'something that already exists.',
  },
})

// Only the payload field goes in `required`: the coverage fields are demanded by their
// descriptions and normalized in JS after the call, because a required field with
// conditional semantics is a validation deadlock that drops a finished search whole —
// see the same note in gather-evidence-without-concluding, where it was observed in the field.

const FRAME = {
  type: 'object',
  additionalProperties: false,
  required: ['capability_line', 'hard_constraints', 'disqualifiers', 'angles', 'repo_question'],
  properties: {
    capability_line: {
      type: 'string',
      description:
        'The capability in one sentence, stated so that any implementation of it would ' +
        'qualify — no library name, no architecture, no chosen approach. "Rate-limit ' +
        'inbound HTTP requests per API key" admits candidates; "a token-bucket middleware ' +
        'struct" has already picked one and will find only itself.',
    },
    hard_constraints: {
      type: 'array',
      items: { type: 'string' },
      description:
        'What any candidate must satisfy to be usable here at all: language and runtime, ' +
        'platform, licence tolerance, offline or air-gapped operation, existing framework it ' +
        'must sit inside. Take these from the caller notes and from a manifest at a repository ' +
        'root. Do not invent preferences the caller never stated.',
    },
    disqualifiers: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Falsifiable statements that rule a candidate OUT, each checkable against facts a ' +
        'researcher can report — "GPL-licensed", "no release in over two years", "Python ' +
        'only", "requires a hosted service". These are what the assessment stage measures ' +
        'against, so a vague one ("poor quality") produces a vague verdict.',
    },
    angles: {
      type: 'array',
      description:
        'Independent places to look, each searchable on its own with no dependency on the ' +
        'others. Cover the ones that actually apply: the language\'s own standard library ' +
        'first, its package registry, established standards or specifications, well-known ' +
        'tools and services in the domain, and the framework already in use here. The ' +
        'standard library is the angle most often skipped and most often right.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'find'],
        properties: {
          key: { type: 'string', description: 'Short kebab-case identifier, unique within the frame.' },
          find: {
            type: 'string',
            description: 'A precise instruction for a documentation researcher: what to look for and where.',
          },
        },
      },
    },
    repo_question: {
      type: 'string',
      description:
        'What a read-only code scout should look for in the repository itself: a declared ' +
        'dependency that already provides this, vendored code, or a partial implementation ' +
        'somebody started. A capability you already depend on beats every candidate on this ' +
        'list, and it is the cheapest thing here to check.',
    },
  },
}

const CANDIDATES = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      description:
        'One entry per existing solution you found. Report what the primary source says; ' +
        'report nothing it does not. An empty list is a legitimate and valuable answer when ' +
        'your search was genuinely exhausted.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'source_url', 'what_it_is', 'latest_version', 'license',
                   'maintenance', 'covers', 'does_not_cover'],
        properties: {
          name: { type: 'string', description: 'The package, tool, standard or service, as its own docs spell it.' },
          source_url: { type: 'string', description: 'The primary source you read — its docs, repository, or registry page.' },
          what_it_is: { type: 'string', description: 'One line: what it does, in its own terms.' },
          latest_version: {
            type: 'string',
            description:
              'The current released version, read from the registry or release page today — ' +
              'never from memory, which is stale by construction. Empty string when the ' +
              'thing is not versioned (a standard, a service).',
          },
          license: { type: 'string', description: 'The licence as stated by the project. Empty string when you could not find it stated.' },
          maintenance: {
            type: 'string',
            description:
              'Observed signals of whether it is alive: date of the most recent release or ' +
              'commit, and anything the project itself says (archived, deprecated, seeking ' +
              'maintainers). Facts with dates, not an impression of health.',
          },
          covers: { type: 'string', description: 'Which part of the requested capability it does provide.' },
          does_not_cover: {
            type: 'string',
            description:
              'Which part it does NOT provide, against the capability you were given. This ' +
              'is the field that decides adoption, and the one a summary always drops — a ' +
              'candidate with an honest gap is far more useful than one described as a ' +
              'perfect fit. Write "nothing identified" only if you actually checked.',
          },
        },
      },
    },
    ...coverageFields('Every query you ran and every URL you actually read.'),
  },
}

const PRESENT = {
  type: 'object',
  additionalProperties: false,
  required: ['hits'],
  properties: {
    hits: {
      type: 'array',
      description:
        'One entry per place this repository already carries some of this capability: a ' +
        'dependency declared in a manifest, vendored code, or a partial implementation. ' +
        'Locations only — no judgment about whether it is good enough.',
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

const ASSESSMENT = {
  type: 'object',
  additionalProperties: false,
  required: ['assessed', 'notes'],
  properties: {
    assessed: {
      type: 'array',
      description:
        'Every distinct candidate you were handed, merged across the angles that found it, ' +
        'and measured against the disqualifiers. Carry all of them, including the ones that ' +
        'fail: a caller who cannot see what was ruled out and why has to redo the search to ' +
        'check your work.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'source_url', 'what_it_is', 'latest_version', 'license',
                   'maintenance', 'covers', 'does_not_cover', 'disqualifiers_hit'],
        properties: {
          name: { type: 'string', description: 'The candidate name, as the researchers reported it.' },
          source_url: { type: 'string' },
          what_it_is: { type: 'string' },
          latest_version: { type: 'string' },
          license: { type: 'string' },
          maintenance: { type: 'string' },
          covers: { type: 'string' },
          does_not_cover: { type: 'string' },
          disqualifiers_hit: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Copy, VERBATIM, each disqualifier this candidate actually violates, and say ' +
              'nothing here you cannot point at a reported fact for. An empty array means ' +
              'you measured it against every disqualifier and it violated none — it does ' +
              'NOT mean you recommend it, and it is not yours to recommend. Never add a ' +
              'disqualifier that was not on the list you were given.',
          },
        },
      },
    },
    notes: {
      type: 'string',
      description:
        'What the facts could not settle: a licence nobody states, a maintenance signal you ' +
        'could not read, two candidates you suspect are the same project under two names. ' +
        'Uncertainty belongs here, never smoothed into the rows above.',
    },
  },
}

// ---------------------------------------------------------------- inputs

const input = typeof args === 'string' ? { capability: args } : (args || {})
const capability = typeof input.capability === 'string' ? input.capability : ''
const roots = input.roots || '.'
const constraints = input.constraints || ''
const notes = input.notes || ''
const maxAngles = input.max_angles || 4

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

// The intelligence dial — the same three positions every skill in this plugin passes, because
// they share one derivation rule (fable → max, opus → normal, sonnet and below → low) and a
// sonnet session therefore sends `low` here as readily as it sends it to develop. The judging
// tier in this workflow is the analyst that frames the capability and the ones that assess
// each candidate.
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

// ---------------------------------------------------------------- the transport
//
// A payload computed on disk arrives through a model, so it is re-digested here before a field of
// it is believed; a location list this script mints travels as plain text on one argv slot with
// its digest beside it. The functions are copies of `lib/plan-digest.mjs`'s and
// `gather-evidence-without-concluding`'s: scripts cannot import, and the suite pins them together.
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

function courierPrompt(command, writes) {
  const steps = writes.length === 0
    ? 'Run exactly this one command, unchanged, and put its entire stdout in payload_raw:\n\n' + command
    : 'Run these commands in order, each unchanged and in its own Bash call; stop at the first that ' +
      'fails. The ones before the last only write a file. Put the last one\'s entire stdout in ' +
      'payload_raw:\n\n' + [...writes, command].join('\n\n')
  return steps + '\n\n' +
    'Move no todos.' +
    (pluginRoot === SHELL_ROOT
      ? '\nIf ' + SHELL_ROOT + ' is empty in your shell, do not guess a path: set stop_reason ' +
        '"failed" and say so.'
      : '')
}

/**
 * Carry one command's payload, believed only after its digest.
 *
 * Retries are sized to what was observed, as `execute-approved-plan-in-worktrees`'s boundaries size them: a courier
 * that returned nothing or could not run the command is run again once; a payload damaged in
 * transit buys one refetch on a stronger model; a token the program refused as damaged on its way
 * IN is sent again; a program failure is not retried. What stays unbelievable comes back as
 * `{payload: null, why}` — every carry in this workflow is a side channel with a fallback, so
 * none of them may throw. `writes` are the file writes a token too long for one argv slot
 * travels by, run by the same courier before `command`.
 */
async function carry(command, label, phaseName, writes = []) {
  const ladder = [COURIER]
  let why = ''

  for (let i = 0; i < ladder.length; i++) {
    const held = await agent(courierPrompt(command, writes), {
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

// cmd.exe caps a whole command line at 8191 characters, so nothing this script hands a courier to
// type puts more than this many on one line.
const COMMAND_BUDGET = 6000

/**
 * A token this script mints, as the courier carries it: written as one line of JSON to a file
 * under `root`, in heredoc chunks of at most COMMAND_BUDGET characters, then read by `cli` with
 * `--json-file` under the token's digest and removed. `~` goes as `~t` and `\` as `~b`, so no
 * backslash reaches the layer that decodes escapes in a Bash call (lib/store.mjs jsonFileText).
 * Returns the courier's writes and its one command.
 */
function viaJsonFile(cli, token, root) {
  const json = JSON.stringify(token).replace(/~/g, '~t').replace(/\\/g, '~b')
  const digest = fnv1a(canonical(token))
  const dir = `${root}/.agentics/.state`
  const file = `${dir}/token-${digest}.json`
  let delimiter = 'AGENTICS_JSON'
  while (json.includes(delimiter)) delimiter += '_'

  const writes = []
  for (let i = 0; i < json.length;) {
    let end = Math.min(i + COMMAND_BUDGET, json.length)
    const last = json.charCodeAt(end - 1)
    if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--
    const into = i === 0 ? `mkdir -p "${dir}" && cat > "${file}"` : `cat >> "${file}"`
    writes.push(`${into} <<'${delimiter}'\n${json.slice(i, end)}\n${delimiter}`)
    i = end
  }
  return { writes, command: `${cli} --digest ${digest} --json-file "${file}"; rm -f "${file}"` }
}

// Excerpts and efforts are per repository, so a question spanning several roots resolves against
// the first — the repository it is anchored in, and what the recorder is told is its ground.
// `repo` already names the repository scan's result in this file, so this stays its own name.
const groundRepo = String(roots).split(/[,;\n]/)[0].trim() || '.'

/** An item's identity, minted exactly as `lib/evidence.mjs`'s `itemId` does: a script cannot import. */
const itemIdOf = (item) => 'I' + fnv1a(canonical({ question: item.question, topic: item.topic, claim: item.claim }))

// ---------------------------------------------------------------- coverage
//
// IRON LAW §4 as a data structure. `complete` is DERIVED here and never taken from an agent.
//
// It matters more in this workflow than anywhere else in the plugin, because of what the
// caller does with a short answer. Everywhere else, an incomplete search means a weaker
// conclusion. Here, "we found nothing" is the input to a decision to spend weeks writing
// code — and an unsearched ecosystem and an empty one produce the identical sentence.

const RUN_ID = 'unknown-to-script: pair `remaining` with the runId from the Workflow launch result'

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
    resumable: { runId: RUN_ID, remaining: dropped.concat(incomplete) },
  }
}

// Every exit path returns this shape. A caller that receives `undefined` cannot tell
// "nothing exists" from "nothing ran", and those two justify opposite decisions.
// `items` are the pool's copy of `candidates` and `already_present`, anchored and dated: what
// couldn't be recorded (a refusal, a dead courier) is named in `unrecorded`; what couldn't even
// be anchored to send (no source, no line) is named in `unanchored` and never sent.
function solutionsResult(frame, present, assessed, viable, ruledOut, coverageBlock, items, unrecorded, unanchored) {
  return {
    capability,
    constraints,
    frame,
    already_present: present,
    candidates: assessed,
    viable,
    ruled_out: ruledOut,
    coverage: coverageBlock,
    items,
    unrecorded,
    unanchored,
  }
}

if (!capability.trim()) {
  return solutionsResult(null, [], [], [], [],
    coverageOf([], [], [], ['no capability was supplied, so nothing was searched']), [], [], [])
}

log(`Capability: ${capability}`)

const dropped = []
const partial = []
const failedChannels = []
const unreached = []

// ---------------------------------------------------------------- 1. frame

phase('Frame')

const constraintBlock = constraints ? `CONSTRAINTS THE CALLER STATED:\n${constraints}\n\n` : ''
const notesBlock = notes ? `BACKGROUND SUPPLIED BY THE CALLER:\n${notes}\n\n` : ''

const frame = await agent(
  `Frame a build-or-adopt search. Somebody is considering writing this themselves; your job ` +
  `is to set up the search that finds out whether they need to.\n\n` +
  `CAPABILITY THEY ARE CONSIDERING BUILDING:\n${capability}\n\n` +
  `REPOSITORIES: ${roots}\n\n` +
  constraintBlock +
  notesBlock +
  `First restate the capability so that ANY implementation of it would qualify — strip out ` +
  `the architecture, the data structure, and any library already half-chosen. A framing that ` +
  `smuggles in an implementation finds only that implementation, and the search then ` +
  `confirms a decision instead of testing it.\n\n` +
  `Then name the hard constraints a candidate must satisfy to be usable here at all, and the ` +
  `disqualifiers that rule one out. Every disqualifier must be checkable against a fact a ` +
  `researcher can report — a licence, a release date, a runtime requirement. "Not high ` +
  `quality enough" is not checkable and produces a verdict nobody can audit.\n\n` +
  `Then break the search into at most ${maxAngles} independent angles, each answerable on ` +
  `its own. Cover the ones that genuinely apply here — and consider the language's own ` +
  `standard library first, because it is the angle people skip and the one that most often ` +
  `already has the answer. Merge related angles rather than exceeding ${maxAngles}.\n\n` +
  `Finally, write repo_question: what a read-only code scout should look for in this ` +
  `repository to find a dependency, vendored copy, or half-built version that already ` +
  `provides some of this. Something already on the dependency list beats every candidate ` +
  `the search will turn up, and it costs one scout to check.\n\n` +
  `You carry Read and nothing that searches, and the searching is the scouts' and the ` +
  `researchers' after you. Where the constraints turn on what the repository is — its ` +
  `language, its runtime — you may Read a manifest at a repository root (package.json, ` +
  `pyproject.toml, Cargo.toml, go.mod) and nothing further; what you cannot tell from that ` +
  `and the caller's words stays out of hard_constraints. Frame only.`,
  { agentType: 'agentics:analyst', schema: FRAME, label: 'frame', ...tiered(judge, 'medium') },
).catch((e) => {
  log(`WARNING: framing failed: ${e && e.message}`)
  return null
})

if (!frame || !frame.angles || frame.angles.length === 0) {
  log('No search angles were produced, so nothing was searched.')
  return solutionsResult(frame || null, [], [], [], [],
    coverageOf([], [], ['frame'],
      ['framing produced no search angles, so no ecosystem was searched and this result ' +
       'says nothing about whether an existing solution exists']), [], [], [])
}

const angles = frame.angles.slice(0, maxAngles)

for (const extra of frame.angles.slice(maxAngles)) {
  dropped.push(extra.key)
  log(`Framing returned ${frame.angles.length} angles; keeping ${maxAngles}, dropping: ${extra.key}`)
}

log(`Frame: ${angles.length} angle(s), ${(frame.disqualifiers || []).length} disqualifier(s).`)

// ---------------------------------------------------------------- 2. search
//
// The repo scout runs alongside the external angles rather than after them. It answers a
// different question — "do we already have this" — and it is the cheapest and most often
// decisive answer in the whole workflow.

phase('Search')

const constraintLine = (frame.hard_constraints || []).join('\n')

// IRON LAW §3: an unexhausted search is RESUMED, never reported as a result. Every exit
// returns an object, and every incomplete exit records the angle — because here, more than
// anywhere, an interrupted search that reads as a finished one licenses the wrong decision.
//
// No round counter ends this loop (§1): it runs until the angle is exhausted, dead-ends
// without naming what is left, errors out, or a round covers no new ground — the observable
// form of "stuck". Progress is judged on evidence actually gained (new candidates or new
// searched surface, both deduplicated), never on the agent's account of itself: a round
// that re-treads old ground while naming the same remainder would otherwise resume forever.
async function searchUntilComplete(angle) {
  const candidates = []
  const searched = []
  const noMatch = []
  const seen = new Set()
  let round = 0
  let found = null

  function incomplete(notReached) {
    partial.push(angle.key)
    return { candidates, searched, noMatch: noMatch.join('\n'), notReached }
  }

  while (true) {
    round++

    const opening = round === 1
      ? `Find existing solutions. FINDING-EXISTING-SOLUTIONS MODE.\n\n` +
        `WHAT IS WANTED: ${frame.capability_line}\n\n` +
        `THIS ANGLE: ${angle.find}\n\n` +
        `HARD CONSTRAINTS a candidate must satisfy:\n${constraintLine}\n\n` +
        constraintBlock
      : `Continue an unfinished search — do not start over.\n\n` +
        `WHAT IS WANTED: ${frame.capability_line}\n` +
        `THIS ANGLE: ${angle.find}\n\n` +
        `ALREADY SEARCHED (do not repeat these):\n${searched.join('\n')}\n\n` +
        `ALREADY FOUND (do not report these again):\n` +
        candidates.map((c) => c.name).join('\n') +
        `\n\nSTILL NOT REACHED — this is your job now:\n${found.not_reached}\n\n`

    try {
      found = await agent(
        opening +
        `Read primary sources: the project's own documentation, its repository, its registry ` +
        `page. Do not report a candidate you found only in a listicle without opening what it ` +
        `points at — a package that was abandoned three years ago still has glowing blog ` +
        `posts about it.\n\n` +
        `Read latest_version off the registry or the release page TODAY. A version recalled ` +
        `from training data is stale by construction, and a stale version is exactly the fact ` +
        `that makes a caller dismiss a candidate that has since grown the feature they need.\n\n` +
        `Fill does_not_cover honestly for every candidate. A caller decides with that field; ` +
        `a row that claims a perfect fit and hides a gap costs them the whole adoption.\n\n` +
        `Finding nothing IS a result here, and often the decisive one — but only if your ` +
        `search was exhausted. Put what you covered in searched, what is genuinely absent in ` +
        `no_match, and what you never got to in not_reached, and never merge the last two.`,
        {
          agentType: 'agentics:doc-researcher', effort: 'low', schema: CANDIDATES,
          phase: 'Search', label: `find:${angle.key}${round > 1 ? `#${round}` : ''}`,
        },
      )
    } catch (e) {
      log(`${angle.key}: round ${round} threw (${e && e.message}); keeping what was found.`)
      return incomplete(`round ${round} failed before completion: ${e && e.message}`)
    }

    if (!found) {
      log(`${angle.key}: round ${round} returned nothing; keeping what was found.`)
      return incomplete(`round ${round} produced no result`)
    }

    // Absorb the round deduplicated. Exact-name matching is the trivial half of deduping
    // and belongs in JS; the same project under two names stays the assessor's job. The
    // growth of `seen` is also the progress measure that decides whether resuming can work.
    const before = seen.size
    for (const c of found.candidates || []) {
      const k = `candidate:${String((c && c.name) || '').trim().toLowerCase()}`
      if (!seen.has(k)) { seen.add(k); candidates.push(c) }
    }
    for (const s of found.searched || []) {
      const k = `searched:${String(s).trim()}`
      if (String(s).trim() && !seen.has(k)) { seen.add(k); searched.push(s) }
    }
    if ((found.no_match || '').trim()) noMatch.push(found.no_match.trim())

    if (found.stop_reason === 'exhausted') {
      return { candidates, searched, noMatch: noMatch.join('\n'), notReached: '' }
    }

    // Not exhausted but nothing named as unreached: another round would be handed an empty
    // task and would return "exhausted" having done nothing. Treat it as the dead end it is
    // rather than paying for a round that launders it into completeness.
    if (!(found.not_reached || '').trim()) {
      const reason = found.stop_reason || 'unstated'
      log(`${angle.key}: stop_reason "${reason}" with nothing named as unreached — treating as a dead end.`)
      return incomplete(`search stopped as "${reason}" without naming what was missed`)
    }

    if (seen.size === before) {
      log(`${angle.key}: round ${round} covered no new ground — stopping as stuck rather than looping.`)
      return incomplete(found.not_reached)
    }

    log(`${angle.key}: unfinished after round ${round} (${found.stop_reason || 'unstated'}), resuming.`)
  }
}

// The repo channel gets the same treatment every side channel in this plugin gets: it may
// fail, and a failure must not discard the external search already paid for (IRON LAW §5).
const repoChannel = agent(
  `${frame.repo_question}\n\n` +
  `Repositories: ${roots}\n` +
  `Context: somebody is considering building "${frame.capability_line}" and wants to know ` +
  `whether this repository already has it.\n\n` +
  `Search the dependency manifests as well as the source — a package already on the ` +
  `dependency list that provides this is the cheapest possible answer, and it is invisible ` +
  `to anyone grepping only for implementation code.\n\n` +
  `Report locations. Do not judge whether what you find is good enough; that is not your ` +
  `question and not your call.`,
  { agentType: 'agentics:scout', effort: 'low', schema: PRESENT,
    phase: 'Search', label: 'repo' },
).then(
  (result) => result ? { result, error: '' } : { result: null, error: 'the scout returned no result' },
  (e) => {
    log(`WARNING: the repository scan failed: ${e && e.message}`)
    return { result: null, error: (e && e.message) || 'unknown error' }
  },
)

const searches = await parallel(angles.map((angle) => () => searchUntilComplete(angle)))
const repo = await repoChannel

// A dropped angle produced nothing at all, which is different from one that searched and
// found nothing. `parallel` resolves a thrown thunk to null, so the null IS the report.
const gathered = []

// A plain loop rather than forEach: `coverage-block` reads a bare `return` as a path that
// exits with no coverage block, and it cannot tell a callback's early exit from the script's.
// The rule is right to be blunt about it — `continue` says the same thing and says it here.
for (let i = 0; i < angles.length; i++) {
  const angle = angles[i]
  const found = searches[i]

  if (!found) {
    dropped.push(angle.key)
    log(`${angle.key}: produced no result at all.`)
    continue
  }

  gathered.push(...found.candidates)

  if ((found.noMatch || '').trim()) {
    unreached.push(`${angle.key} searched and found nothing: ${found.noMatch.trim()}`)
  }
  if ((found.notReached || '').trim()) {
    unreached.push(`${angle.key} never reached: ${found.notReached.trim()}`)
  }
}

let present = []

if (repo.result) {
  present = repo.result.hits || []

  // Gated on stop_reason, not on not_reached alone — the same test the angle loop applies.
  // A scan that stopped unfinished and left not_reached blank was reading as a finished one,
  // and this is the channel whose answer the skill calls the cheapest and most decisive in
  // the workflow: "you already depend on something that does this". Reported complete when
  // it is not, it sends the user to adopt an external dependency they already had.
  const repoDone = repo.result.stop_reason === 'exhausted'
  const repoRemainder = (repo.result.not_reached || '').trim()

  if (!repoDone || repoRemainder) {
    partial.push('repo')
    unreached.push(repoRemainder
      ? `the repository scan never reached: ${repoRemainder}`
      : `the repository scan stopped "${repo.result.stop_reason || 'unstated'}" without ` +
        `naming what it missed, so what the tree already provides is only partly known`)
  }
} else {
  failedChannels.push('repo')
  unreached.push(
    'the repository was never scanned for what it already provides (' + repo.error + '), so ' +
    'this result cannot say whether you already depend on something that does this')
}

log(`Search: ${gathered.length} raw candidate(s) across ${angles.length} angle(s); ${present.length} hit(s) already in the tree.`)

// A no_match line is evidence FOR building, and it is exactly the line a reader skims past.
// It is carried in `unreached` above so it keeps `complete` honest, and logged here so the
// narrator line does not read as a silent empty result.
if (gathered.length === 0) {
  log('No external candidates found. Read the coverage block before treating that as a green light.')
}

// ---------------------------------------------------------------- 3. assess
//
// One analyst over all candidates, and this is the barrier case that is genuinely justified:
// deduping the same package found by two angles, and ranking against a shared disqualifier
// list, both need every result at once. Per-candidate assessors would each see one row and
// could not tell you that two of them are the same project under different names.

let assessed = []
let viable = []
let ruledOut = []

if (gathered.length > 0) {
  phase('Assess')

  const disqualifierLines = (frame.disqualifiers || []).join('\n')
  const candidateBlock = gathered
    .map((c) => `- ${c.name} (${c.source_url})\n  is: ${c.what_it_is}\n  version: ${c.latest_version}\n` +
                `  licence: ${c.license}\n  maintenance: ${c.maintenance}\n` +
                `  covers: ${c.covers}\n  does not cover: ${c.does_not_cover}`)
    .join('\n')

  const assessment = await agent(
    `Rule on candidates for a build-or-adopt decision. You measure them; you do not pick ` +
    `one, and nobody is asking you to.\n\n` +
    `WHAT IS WANTED: ${frame.capability_line}\n\n` +
    `HARD CONSTRAINTS:\n${constraintLine}\n\n` +
    `DISQUALIFIERS — the only grounds on which you may rule a candidate out:\n` +
    `${disqualifierLines}\n\n` +
    `CANDIDATES, as the researchers reported them. Several angles searched independently, so ` +
    `the same project may appear more than once, under more than one name:\n${candidateBlock}\n\n` +
    constraintBlock +
    `Merge duplicates into one row, keeping the fullest facts from each. Then, for each ` +
    `distinct candidate, copy VERBATIM into disqualifiers_hit each disqualifier it actually ` +
    `violates according to the facts above. An empty array means you checked it against every ` +
    `disqualifier and it violated none.\n\n` +
    `Carry every candidate through, the failing ones included, with what ruled them out. A ` +
    `reader who cannot see what was rejected and why has to redo the entire search to check ` +
    `you.\n\n` +
    `Never invent a disqualifier that is not on the list, and never rule out a candidate on a ` +
    `fact nobody reported — if you think something disqualifies it and you cannot point at ` +
    `the fact, that belongs in notes as an open question — you have no search tools, and a ` +
    `fact you would have to go and find is exactly such a question. Whether the remaining candidates ` +
    `are worth adopting is the caller's decision and rests on things you cannot see: their ` +
    `dependency appetite, their licence policy, whether they want to own this code.`,
    { agentType: 'agentics:analyst', schema: ASSESSMENT, label: 'assess', ...tiered(judge, 'high') },
  ).catch((e) => {
    log(`WARNING: assessment failed: ${e && e.message}`)
    return null
  })

  // Two angles searching independently will report the same package twice, so a name seen
  // already is a duplicate rather than a second candidate. Exact-name matching is the trivial
  // half of deduping and belongs in JS; the same project under two different names is the half
  // that genuinely needs a model, and it stays the assessor's job.
  const nameKey = (name) => (name || '').trim().toLowerCase()

  // The assessor is told to copy disqualifiers VERBATIM and never to invent one. Obedience
  // is not a mechanism: an invented ground — or a paraphrase of a real one that quietly
  // widens it — rules a candidate out just as effectively as a declared one, and the only
  // viable library in the sweep can vanish on a rule nobody wrote. So membership is checked
  // here, against the frame the user actually settled. An entry that matches nothing does
  // not rule anything out; it is reported as an unsettled observation instead.
  const declared = new Map(
    (frame.disqualifiers || []).map((d) => [String(d).trim().toLowerCase(), true]))
  const invented = []

  function disqualifiersHitOf(candidate) {
    const hits = candidate.disqualifiers_hit || []
    const kept = []
    for (const hit of hits) {
      if (declared.has(String(hit).trim().toLowerCase())) kept.push(hit)
      else invented.push(`${candidate.name}: ${hit}`)
    }
    return kept
  }

  function distinctByName(rows) {
    const seen = new Set()
    const out = []
    for (const row of rows) {
      const key = nameKey(row.name)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(row)
    }
    return out
  }

  // Whether anyone measured these candidates at all. The verdict below is computed from
  // `disqualifiers_hit`, and on this path that array is something this script wrote, not
  // something an assessor observed — so the verdict must not be computed from it.
  let assessMeasured = true

  if (!assessment || !assessment.assessed) {
    assessMeasured = false
    failedChannels.push('assess')
    unreached.push(
      'the candidates were found but never measured against the disqualifiers, so nothing ' +
      'here says which of them are usable; they are returned raw — exact-name duplicates ' +
      'merged and nothing else — with disqualifiers_hit empty because nobody checked rather ' +
      'than because nothing was hit')
    assessed = distinctByName(gathered).map((c) => ({ ...c, disqualifiers_hit: [] }))
  } else {
    assessed = assessment.assessed

    if ((assessment.notes || '').trim()) {
      unreached.push(`the assessment could not settle: ${assessment.notes.trim()}`)
    }

    // A candidate the researchers found and the assessor silently dropped would vanish
    // without a trace, and the result would still read as a complete sweep. IRON LAW §4: it
    // is named instead. Compared on a normalized name because the two stages are two models
    // and a difference of capitalization is not a dropped candidate.
    const kept = new Set(assessed.map((c) => nameKey(c.name)))
    const lost = distinctByName(gathered.filter((c) => !kept.has(nameKey(c.name))))
      .map((c) => c.name)

    if (lost.length > 0) {
      log(`WARNING: the assessment dropped ${lost.join(', ')} without ruling on them.`)
      unreached.push(
        `found but never ruled on: ${lost.join(', ')} — these were reported by a researcher ` +
        `and did not survive the assessment stage, so they are neither viable nor ruled out`)
    }
  }

  // The verdict, computed here and nowhere else. `disqualifiers_hit` is a list of facts the
  // assessor was asked to copy verbatim; viability is what this line does with them. A
  // schema field called `suitable` would have moved this decision into a model's taste.
  //
  // With no assessor there are no such facts, and an empty `disqualifiers_hit` this script
  // wrote itself would name EVERY candidate viable — a licence the user's own policy would
  // have killed, presented as cleared — and the empty ruled_out would then suppress the
  // incomplete-sweep warning below, which fires only when nothing is viable. Both lists stay
  // empty instead: the candidates still ride in `assessed`, and failed_channels says why
  // nobody ruled on them. This is the one place the script could mint a partial result into
  // a whole one entirely on its own.
  if (assessMeasured) {
    viable = assessed.filter((c) => disqualifiersHitOf(c).length === 0).map((c) => c.name)
    ruledOut = assessed
      .filter((c) => disqualifiersHitOf(c).length > 0)
      .map((c) => ({ name: c.name, why: disqualifiersHitOf(c).join('; ') }))

    log(`Assessed ${assessed.length} distinct candidate(s): ${viable.length} hit no disqualifier, ${ruledOut.length} ruled out.`)

    if (invented.length > 0) {
      log(`WARNING: ${invented.length} ground(s) cited that nobody declared — not counted.`)
      unreached.push(
        `ruled out on grounds nobody declared, so not counted against them: ` +
        `${invented.join('; ')} — these may be real objections, but they are not in the ` +
        `frame's disqualifier list and no candidate was rejected for them here`)
    }
  } else {
    log(`${assessed.length} candidate(s) carried through unmeasured — neither viable nor ruled out.`)
  }
}

// ---------------------------------------------------------------- 3b. record
//
// What the sweep established enters the project's evidence pool, so the next design that asks
// the same thing finds it anchored and dated rather than buying the sweep again. A side channel:
// what cannot be recorded is logged and costs no coverage, because the candidates are returned
// either way.

const question = capability.trim()
const items = []
const unanchored = []

for (const c of assessed) {
  if (!String(c.source_url || '').trim()) { unanchored.push(c.name); continue }
  const item = {
    question, topic: 'candidates', ground: [], kind: 'external',
    claim: `${c.name} — ${c.what_it_is}. Covers: ${c.covers}. Does not cover: ${c.does_not_cover}.`,
    spans: [], queries: [], rests_on: [],
    sources: [{ url: String(c.source_url).trim(), version: c.latest_version || '', retrieved: '' }],
    detail: { name: c.name, license: c.license || '', maintenance: c.maintenance || '', disqualifiers_hit: c.disqualifiers_hit || [] },
  }
  items.push({ ...item, id: itemIdOf(item) })
}
for (const h of present) {
  const path = String(h.path || '').split('\\').join('/')
  if (!path || !Number.isInteger(h.line) || h.line < 1) { unanchored.push(`${path}:${h.line}`); continue }
  const item = {
    question, topic: 'already-present', ground: [path], kind: 'behaviour', claim: `${path}: ${h.note}`,
    spans: [{ path, start: h.line, end: h.line, at: '' }], queries: [], sources: [], rests_on: [],
  }
  items.push({ ...item, id: itemIdOf(item) })
}

const unrecorded = []

if (unanchored.length > 0) {
  log(`Not anchorable, so not sent to the evidence store: ${unanchored.join(', ')}`)
}

if (items.length > 0) {
  phase('Record')

  const { command, writes } = viaJsonFile(
    `node "${pluginRoot}/lib/evidence.mjs" record --repo "${groundRepo}" --root "${groundRepo}" --kind solutions`,
    { items: items.map(({ id, ...rest }) => rest) }, groundRepo)
  const { payload, why } = await carry(command, 'record', 'Record', writes)

  if (!payload) {
    unrecorded.push(...items.map((it) => it.id))
    log(`${items.length} item(s) not recorded (${why})`)
  } else if (payload.ok === false) {
    unrecorded.push(...items.map((it) => it.id))
    const problems = (payload.refused || []).flatMap((r) => r.problems || []).join('; ')
    log(`${items.length} item(s) not recorded (${problems || 'refused'})`)
  }
}

// ---------------------------------------------------------------- 4. account

if (present.length > 0) {
  log(`ALREADY IN THE TREE: ${present.length} hit(s) — check these before anything on the candidate list.`)
}

const coverage = coverageOf(dropped, partial, failedChannels, unreached)

if (!coverage.complete && viable.length === 0) {
  log('INCOMPLETE SWEEP WITH NO VIABLE CANDIDATE. This does not mean nothing exists — it means ' +
      'nobody finished looking. Read coverage.unreached before deciding to build.')
}

return solutionsResult(
  { capability_line: frame.capability_line,
    hard_constraints: frame.hard_constraints || [],
    disqualifiers: frame.disqualifiers || [] },
  present, assessed, viable, ruledOut, coverage, items, unrecorded, unanchored)
