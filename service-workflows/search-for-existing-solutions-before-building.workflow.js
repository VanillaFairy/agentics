export const meta = {
  name: 'search-for-existing-solutions-before-building',
  description: 'Before building something, find what already exists that does it: libraries, tools, standards, services, and whatever this repository already depends on. Returns a summary file of the candidates with licence, version, fit facts and computed verdicts, plus a coverage block — never a recommendation.',
  whenToUse: 'The build-or-adopt evidence phase. Called by the design skill before approaches are drawn up, and invocable on its own. Distinct from gather-evidence-without-concluding, which searches the code you already have; this one searches the world outside it.',
  phases: [
    { title: 'Frame', detail: 'analyst: the capability, its hard constraints, and what disqualifies a candidate' },
    { title: 'Search', detail: 'one researcher per ecosystem angle, plus a scout over your existing dependencies' },
    { title: 'Assess', detail: 'analyst: dedupe, then rule each candidate against the declared disqualifiers' },
    { title: 'Record', detail: 'lib decides which candidates are viable, records them and what the repository already carries, and writes one summary' },
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

/// ---------------------------------------------------------------- schemas
//
// No minItems / maxItems / minLength / maxLength anywhere: structured outputs do not support
// them, so a bound written here would silently do nothing or turn a good result into a
// dropped one. Every bound lives in the prompt as behaviour and is enforced in JS.
//
// No verdict booleans. Whether a candidate is viable is COMPUTED by lib/evidence.mjs from the
// disqualifiers it was measured against — the moment a schema offers `suitable: boolean`, the
// decision migrates out of code and into a model's taste.
//
// Every agent here writes its full return to the file its dispatch names, and lib reads those
// files (docs/DESIGN.md#gp6--couriers-carry-handles-data-stays-where-its-author-wrote-it); what
// comes back to this script is what it branches on and what its coverage block says.
//
// Field semantics go in `description`, never in a comment: comments are stripped before a
// schema reaches the model, so a contract written only in a comment binds nobody.

// The coverage contract every search channel answers to, identical in spirit to gather-evidence-without-concluding's.
// `no_match` and `not_reached` stay apart on purpose, and here the distinction is the whole
// point of the workflow: "I searched npm and nothing there does this" is a FINDING that
// supports building. "I never searched npm" is a HOLE that supports nothing at all.
// Every coverage field is ALWAYS present — an empty string is the correct value for "nothing
// to carry", and each description says so outright: an omitted field fails validation and a
// finished search is dropped whole.
const coverageFields = () => ({
  stop_reason: {
    type: 'string',
    enum: ['exhausted', 'unfinished', 'stuck'],
    description:
      'Always include this field, the same value as in your return file. "exhausted" — you ' +
      'covered the surface you were asked to cover and can name it. "unfinished" — one pass could ' +
      'not cover the surface; the caller will resume you. "stuck" — you could not find a way ' +
      'forward. Cost and effort are never reasons to stop. Only "exhausted" counts as complete.',
  },
  no_match: {
    type: 'string',
    description:
      'What you looked for and genuinely did not find, the same text as in your return file — a ' +
      'FINDING, not a gap. Name the surface it is true of ("no maintained Rust crate on ' +
      'crates.io"). Send an empty string — never omit the field — when everything you looked for was there.',
  },
  not_reached: {
    type: 'string',
    description:
      'What you never searched at all, the same text as in your return file, named specifically ' +
      'enough for someone else to pick it up. An empty string when stop_reason is "exhausted". ' +
      'Never merge this with no_match.',
  },
})

const coverageShape = '"searched": ["<every query you ran and every URL or path you actually read>"], ' +
  '"no_match": "<what you looked for and genuinely did not find; empty when none>", ' +
  '"not_reached": "<what you never searched; empty when exhausted>", "stop_reason": "exhausted|unfinished|stuck"'

const FRAME = {
  type: 'object',
  additionalProperties: false,
  required: ['angles'],
  properties: {
    angles: {
      type: 'array',
      description: 'The angles of your frame file, by key only.',
      items: {
        type: 'object', additionalProperties: false, required: ['key'],
        properties: { key: { type: 'string', description: 'The angle\'s key, as in the frame file.' } },
      },
    },
  },
}

const FRAME_FILE = '{"capability": "<the CAPABILITY above, copied exactly>", ' +
  '"capability_line": "<the capability in one sentence, stated so that any implementation of it would qualify — no ' +
  'library name, no architecture, no chosen approach>", ' +
  '"hard_constraints": ["<what any candidate must satisfy to be usable here at all, from the caller\'s words and a ' +
  'manifest at a repository root; no preference the caller never stated>"], ' +
  '"disqualifiers": ["<a falsifiable statement that rules a candidate OUT, checkable against a fact a researcher ' +
  'can report: \'GPL-licensed\', \'no release in over two years\'>"], ' +
  '"angles": [{"key": "<short kebab-case, unique>", "find": "<a precise instruction for a documentation ' +
  'researcher: what to look for and where>"}], ' +
  '"repo_question": "<what a read-only code scout should look for in the repository itself: a declared dependency, ' +
  'vendored code, or a partial implementation>"}'

const CANDIDATES = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates_n'],
  properties: {
    candidates_n: { type: 'integer', description: 'How many candidates your return file holds.' },
    ...coverageFields(),
  },
}

const CANDIDATES_FILE = '{"candidates": [{"name": "<as its own docs spell it>", "source_url": "<the primary source ' +
  'you read>", "what_it_is": "<one line, in its own terms>", "latest_version": "<read from the registry or release ' +
  'page today; empty when unversioned>", "license": "<as the project states it; empty when not stated>", ' +
  '"maintenance": "<observed signals with dates: latest release or commit, archived, deprecated>", "covers": ' +
  '"<which part of the capability it provides>", "does_not_cover": "<which part it does NOT — \'nothing identified\' ' +
  'only if you checked>"}], ' + coverageShape + '}'

const PRESENT = {
  type: 'object',
  additionalProperties: false,
  required: ['hits_n'],
  properties: {
    hits_n: { type: 'integer', description: 'How many locations your return file holds.' },
    ...coverageFields(),
  },
}

const PRESENT_FILE = '{"hits": [{"path": "<repo-relative>", "line": <n>, "note": "<what is at that line, in one ' +
  'line>"}], ' + coverageShape + '}'

const ASSESSMENT = {
  type: 'object',
  additionalProperties: false,
  required: ['assessed_n'],
  properties: { assessed_n: { type: 'integer', description: 'How many candidates your return file rules on.' } },
}

const ASSESSMENT_FILE = '{"assessed": [{"name": "<as the researchers reported it>", "source_url": "", "what_it_is": "", ' +
  '"latest_version": "", "license": "", "maintenance": "", "covers": "", "does_not_cover": "", ' +
  '"disqualifiers_hit": ["<each disqualifier from the frame file it actually violates, copied VERBATIM>"]}], ' +
  '"notes": "<what the facts could not settle: a licence nobody states, two candidates you suspect are one project>"}'

// What a courier hands back: one command's stdout, byte-exact, in one string. The shape of
// `execute-approved-plan-in-worktrees`'s CARRIED, copied rather than shared because a workflow script cannot
// import. This workflow moves no todos, so the two todo fields are left out of its shape.
const CARRIED = {
  type: 'object', additionalProperties: false,
  required: ['stop_reason', 'payload_raw', 'notes'],
  properties: {
    stop_reason: { type: 'string', enum: ['carried', 'failed'] },
    payload_raw: { type: 'string' },
    notes: { type: 'string' },
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
// they share one derivation rule (fable → max, opus → normal, sonnet and below → low). The judging
// tier in this workflow is the analyst that frames the capability and the one that assesses
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
// The one courier here carries handles both ways: the return files' paths in, counts and paths
// back, re-digested before a field of it is believed. canonical and fnv1a are copies of
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
 * unbelievable comes back as `{payload: null, why}`.
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

// Excerpts and efforts are per repository, so a question spanning several roots resolves against
// the first — the repository it is anchored in, and what the recorder is told is its ground.
const groundRepo = String(roots).split(/[,;\n]/)[0].trim() || '.'

// An agent whose output lib/ reads writes it to a return file under the working root, named by its
// dispatch label, bounded by nameKey, and the digest of what it was handed, so a retried dispatch
// rewrites the same file.
const INBOX = `${groundRepo}/.agentics/.state/evidence/inbox`
const returnFile = (label, body) => `${INBOX}/${nameKey(label.replace(/[^A-Za-z0-9.-]+/g, '-'))}-${fnv1a(body)}.json`
const toFile = (body, file, shape) => body +
  `\n\nRETURN FILE — write your full return to ${file} as one JSON object of exactly this shape:\n${shape}\n` +
  'Then return only what your schema asks for.'

// Angle keys are a model's words and become labels, so each is spelled as a slug.
const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'angle'

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

const NO_COUNTS = {
  present: 0, candidates: 0, viable: 0, ruled_out: 0, invented: 0, lost: 0, unanchored: 0, unread: 0, unsettled: 0, present_read: 0,
}

// Every exit path returns this shape. A caller that receives `undefined` cannot tell
// "nothing exists" from "nothing ran", and those two justify opposite decisions. `frame` and
// `summary` are files: the frame its analyst wrote, and the one lib wrote with every candidate's
// facts and verdict and what the repository already carries. `counts` are lib's; `items` are the
// pool's handles for what the sweep recorded.
function solutionsResult({ frame = '', summary = '', counts = NO_COUNTS, measured = false, items = [], recorded = false, coverageBlock }) {
  return { capability, constraints, frame, summary, counts, measured, items, recorded, coverage: coverageBlock }
}

if (!capability.trim()) {
  return solutionsResult({ coverageBlock: coverageOf([], [], [], ['no capability was supplied, so nothing was searched']) })
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

const frameBody =
  `Frame a build-or-adopt search. Somebody is considering writing this themselves; your job ` +
  `is to set up the search that finds out whether they need to.\n\n` +
  `CAPABILITY THEY ARE CONSIDERING BUILDING:\n${capability.trim()}\n\n` +
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
  `Copy the CAPABILITY into the file exactly as it is written above: the store records the sweep ` +
  `under it and checks your copy against it.\n\n` +
  `You carry Read and nothing that searches, and the searching is the scouts' and the ` +
  `researchers' after you. Where the constraints turn on what the repository is — its ` +
  `language, its runtime — you may Read a manifest at a repository root (package.json, ` +
  `pyproject.toml, Cargo.toml, go.mod) and nothing further; what you cannot tell from that ` +
  `and the caller's words stays out of hard_constraints. Frame only.`
const frameFile = returnFile('frame', frameBody)

const framed = await agent(toFile(frameBody, frameFile, FRAME_FILE),
  { agentType: 'agentics:analyst', schema: FRAME, label: 'frame', ...tiered(judge, 'medium') },
).catch((e) => {
  log(`WARNING: framing failed: ${e && e.message}`)
  return null
})

const framedAngles = framed && Array.isArray(framed.angles) ? framed.angles.filter((a) => a && a.key) : []
if (framedAngles.length === 0) {
  log('No search angles were produced, so nothing was searched.')
  return solutionsResult({
    frame: framed ? frameFile : '',
    coverageBlock: coverageOf([], [], ['frame'],
      ['framing produced no search angles, so no ecosystem was searched and this result ' +
       'says nothing about whether an existing solution exists']),
  })
}

const angles = framedAngles.slice(0, maxAngles).map((a) => ({ key: slug(a.key), frameKey: String(a.key) }))

for (const extra of framedAngles.slice(maxAngles)) {
  dropped.push(slug(extra.key))
  log(`Framing returned ${framedAngles.length} angles; keeping ${maxAngles}, dropping: ${slug(extra.key)}`)
}

log(`Frame: ${angles.length} angle(s).`)

// ---------------------------------------------------------------- 2. search
//
// The repo scout runs alongside the external angles rather than after them. It answers a
// different question — "do we already have this" — and it is the cheapest and most often
// decisive answer in the whole workflow.

phase('Search')

// IRON LAW §3: an unexhausted search is RESUMED, never reported as a result. Every exit
// returns an object, and every incomplete exit records the angle — because here, more than
// anywhere, an interrupted search that reads as a finished one licenses the wrong decision.
//
// No round counter ends this loop (§1): it runs until the angle is exhausted, dead-ends
// without naming what is left, errors out, or a round leaves the very remainder it was handed —
// the observable form of "stuck". Each round writes its own return file, and a continuation
// names every earlier one, so a researcher reads what it already covered rather than being told.
async function searchUntilComplete(angle) {
  const files = []
  const noMatch = []
  let round = 0
  let remainder = ''

  const charge =
    `Find existing solutions. FINDING-EXISTING-SOLUTIONS MODE.\n\n` +
    `Read the frame file ${frameFile}: WHAT IS WANTED is its capability_line, THIS ANGLE is the ` +
    `angle keyed "${angle.frameKey}" there (its find), and its hard_constraints are what a ` +
    `candidate must satisfy.\n\n` + constraintBlock +
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
    `no_match, and what you never got to in not_reached, and never merge the last two.`

  const incomplete = (notReached) => {
    partial.push(angle.key)
    return { files, noMatch: noMatch.join('\n'), notReached }
  }

  for (;;) {
    round++
    const body = round === 1
      ? charge
      : `Continue an unfinished search — do not start over.\n\nORIGINAL REQUEST:\n${charge}\n\n` +
        `YOUR EARLIER ROUNDS' REPORTS — read them first: do not repeat what they searched, and do ` +
        `not report again the candidates they found:\n${files.join('\n')}\n\n` +
        `STILL NOT REACHED — this is your job now:\n${remainder}`
    const label = `find:${angle.key}${round > 1 ? `#${round}` : ''}`
    const file = returnFile(label, body)

    let found
    try {
      found = await agent(toFile(body, file, CANDIDATES_FILE), {
        agentType: 'agentics:doc-researcher', effort: 'low', schema: CANDIDATES, phase: 'Search', label,
      })
    } catch (e) {
      log(`${angle.key}: round ${round} threw (${e && e.message}); keeping what was found.`)
      return incomplete(`round ${round} failed before completion: ${e && e.message}`)
    }

    if (!found) {
      log(`${angle.key}: round ${round} returned nothing; keeping what was found.`)
      return incomplete(`round ${round} produced no result`)
    }
    files.push(file)
    if ((found.no_match || '').trim()) noMatch.push(found.no_match.trim())

    if (found.stop_reason === 'exhausted') return { files, noMatch: noMatch.join('\n'), notReached: '' }

    // Not exhausted but nothing named as unreached: another round would be handed an empty
    // task and would return "exhausted" having done nothing. Treat it as the dead end it is.
    const next = (found.not_reached || '').trim()
    if (!next) {
      const reason = found.stop_reason || 'unstated'
      log(`${angle.key}: stop_reason "${reason}" with nothing named as unreached — treating as a dead end.`)
      return incomplete(`search stopped as "${reason}" without naming what was missed`)
    }

    if (next.replace(/\s+/g, ' ').toLowerCase() === remainder.replace(/\s+/g, ' ').toLowerCase()) {
      log(`${angle.key}: round ${round} left the same ground unreached — stopping as stuck rather than looping.`)
      return incomplete(next)
    }
    remainder = next

    log(`${angle.key}: unfinished after round ${round} (${found.stop_reason || 'unstated'}), resuming.`)
  }
}

// The repo channel gets the same treatment every side channel in this plugin gets: it may
// fail, and a failure must not discard the external search already paid for (IRON LAW §5).
const repoBody =
  `Read the frame file ${frameFile}: its repo_question is your charge, and its capability_line is ` +
  `what somebody is considering building — they want to know whether this repository already has it.\n\n` +
  `Repositories: ${roots}\n\n` +
  `Search the dependency manifests as well as the source — a package already on the ` +
  `dependency list that provides this is the cheapest possible answer, and it is invisible ` +
  `to anyone grepping only for implementation code.\n\n` +
  `Report locations. Do not judge whether what you find is good enough; that is not your ` +
  `question and not your call.`
const repoFile = returnFile('repo', repoBody)

const repoChannel = agent(toFile(repoBody, repoFile, PRESENT_FILE),
  { agentType: 'agentics:scout', effort: 'low', schema: PRESENT, phase: 'Search', label: 'repo' },
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
const researched = []

// A plain loop rather than forEach: `coverage-block` reads a bare `return` as a path that
// exits with no coverage block, and it cannot tell a callback's early exit from the script's.
for (let i = 0; i < angles.length; i++) {
  const angle = angles[i]
  const found = searches[i]

  if (!found) {
    dropped.push(angle.key)
    log(`${angle.key}: produced no result at all.`)
    continue
  }

  researched.push(...found.files)

  if ((found.noMatch || '').trim()) {
    unreached.push(`${angle.key} searched and found nothing: ${found.noMatch.trim()}`)
  }
  if ((found.notReached || '').trim()) {
    unreached.push(`${angle.key} never reached: ${found.notReached.trim()}`)
  }
}

if (repo.result) {
  // Gated on stop_reason, not on not_reached alone — the same test the angle loop applies.
  // A scan that stopped unfinished and left not_reached blank was reading as a finished one,
  // and this is the channel whose answer the skill calls the cheapest and most decisive in
  // the workflow: "you already depend on something that does this".
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

log(`Search: ${researched.length} researcher report(s) across ${angles.length} angle(s); the repository scan ` +
  (repo.result ? `reported ${Number(repo.result.hits_n) || 0} hit(s).` : 'failed.'))

// ---------------------------------------------------------------- 3. assess
//
// One analyst over every researcher's report, and this is the barrier case that is genuinely
// justified: deduping the same package found by two angles, and ranking against a shared
// disqualifier list, both need every result at once.

let assessFile = ''

if (researched.length > 0) {
  phase('Assess')

  const assessBody =
    `Rule on candidates for a build-or-adopt decision. You measure them; you do not pick ` +
    `one, and nobody is asking you to.\n\n` +
    `Read the frame file ${frameFile}: WHAT IS WANTED is its capability_line, its hard_constraints ` +
    `bind every candidate, and its disqualifiers are the ONLY grounds on which you may rule a ` +
    `candidate out.\n\n` +
    `Then read the researchers' reports, each a file of candidates as they reported them. Several ` +
    `angles searched independently, so the same project may appear more than once, under more ` +
    `than one name:\n${researched.join('\n')}\n\n` +
    constraintBlock +
    `Merge duplicates into one row, keeping the fullest facts from each. Then, for each ` +
    `distinct candidate, copy VERBATIM into disqualifiers_hit each disqualifier it actually ` +
    `violates according to the facts reported. An empty array means you checked it against every ` +
    `disqualifier and it violated none.\n\n` +
    `Carry every candidate through, the failing ones included, with what ruled them out. A ` +
    `reader who cannot see what was rejected and why has to redo the entire search to check ` +
    `you.\n\n` +
    `Never invent a disqualifier that is not on the list, and never rule out a candidate on a ` +
    `fact nobody reported — if you think something disqualifies it and you cannot point at ` +
    `the fact, that belongs in notes as an open question — you have no search tools, and a ` +
    `fact you would have to go and find is exactly such a question. Whether the remaining candidates ` +
    `are worth adopting is the caller's decision and rests on things you cannot see: their ` +
    `dependency appetite, their licence policy, whether they want to own this code.`
  const file = returnFile('assess', assessBody)

  const assessment = await agent(toFile(assessBody, file, ASSESSMENT_FILE),
    { agentType: 'agentics:analyst', schema: ASSESSMENT, label: 'assess', ...tiered(judge, 'high') },
  ).catch((e) => {
    log(`WARNING: assessment failed: ${e && e.message}`)
    return null
  })
  if (assessment) assessFile = file
}

// ---------------------------------------------------------------- 3b. record and decide
//
// One courier hands lib every file this sweep's agents wrote. lib decides what they mean — which
// candidates hit no declared disqualifier, which grounds nobody declared, which candidates the
// assessment dropped — records each anchored candidate and each hit the repository carries into
// the project's evidence pool, and writes all of it to one summary file. The decision is code's,
// never a model's: an assessor told to copy disqualifiers verbatim is obeyed by a membership test,
// not by trust.

phase('Record')

const held = await carry(
  `node "${pluginRoot}/lib/evidence.mjs" record --repo "${groundRepo}" --root "${groundRepo}" --kind solutions ` +
    `--frame "${frameFile}" --question-digest ${fnv1a(capability.trim())}` +
    (assessFile ? ` --assessed "${assessFile}"` : '') + (repo.result ? ` --present "${repoFile}"` : '') +
    researched.map((f) => ` --from "${f}"`).join(''),
  'record', 'Record')
const decided = held.payload

let counts = NO_COUNTS
if (!decided) {
  failedChannels.push('record')
  unreached.push(`what this sweep found was never read back from its agents' files (${held.why}), so nothing ` +
    'here says which candidates are viable, and nothing was recorded')
} else {
  counts = { ...NO_COUNTS, ...(decided.counts || {}) }
  const summary = decided.summary_file
  if (counts.candidates > 0 && decided.measured === false) {
    failedChannels.push('assess')
    unreached.push(
      'the candidates were found but never measured against the disqualifiers, so nothing ' +
      'here says which of them are usable; they are carried unmeasured in ' + summary + ' — exact-name ' +
      'duplicates merged and nothing else — neither viable nor ruled out, because nobody checked')
  }
  if (counts.unsettled > 0) unreached.push(`the assessment could not settle questions it names in ${summary}`)
  if (counts.lost > 0) {
    log(`WARNING: the assessment dropped ${counts.lost} candidate(s) without ruling on them.`)
    unreached.push(`${counts.lost} candidate(s) were found but never ruled on — reported by a researcher and ` +
      `dropped by the assessment, so neither viable nor ruled out; they are named in ${summary}`)
  }
  if (counts.invented > 0) {
    log(`WARNING: ${counts.invented} ground(s) cited that nobody declared — not counted.`)
    unreached.push(`${counts.invented} ground(s) the assessment cited are not in the frame's disqualifier list, ` +
      `so no candidate was ruled out for them; they are named in ${summary}`)
  }
  if (counts.unread > 0) {
    unreached.push(`${counts.unread} researcher report(s) could not be read, so their candidates are in nothing here`)
  }
  if (repo.result && !counts.present_read) {
    failedChannels.push('repo')
    unreached.push('the repository scan\'s report could not be read, so what the tree already provides is unknown')
  }
  if (!decided.recorded && (decided.refused_n || 0) > 0) {
    log(`${decided.refused_n} item(s) refused by the evidence store` +
      (decided.refusals_file ? `; what is wrong with each is in ${decided.refusals_file}` : '') + ' — not recorded.')
  }
  if (counts.unanchored > 0) log(`${counts.unanchored} candidate(s) or hit(s) not anchorable, so not sent to the evidence store.`)
  log(`Assessed ${counts.candidates} distinct candidate(s): ${counts.viable} hit no disqualifier, ${counts.ruled_out} ruled out.`)
}

// ---------------------------------------------------------------- 4. account

if (counts.present > 0) {
  log(`ALREADY IN THE TREE: ${counts.present} hit(s) — check these before anything on the candidate list.`)
}
if (researched.length > 0 && counts.candidates === 0 && decided) {
  log('No external candidates found. Read the coverage block before treating that as a green light.')
}

const coverage = coverageOf(dropped, partial, failedChannels, unreached)

if (!coverage.complete && counts.viable === 0) {
  log('INCOMPLETE SWEEP WITH NO VIABLE CANDIDATE. This does not mean nothing exists — it means ' +
      'nobody finished looking. Read coverage.unreached before deciding to build.')
}

return solutionsResult({
  frame: frameFile,
  summary: decided ? decided.summary_file : '',
  counts,
  measured: Boolean(decided && decided.measured),
  items: decided && Array.isArray(decided.items) ? decided.items : [],
  recorded: Boolean(decided && decided.recorded),
  coverageBlock: coverage,
})
