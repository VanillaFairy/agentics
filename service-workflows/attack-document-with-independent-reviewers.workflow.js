export const meta = {
  name: 'attack-document-with-independent-reviewers',
  description: 'Adversarially probe a written artefact — a design, a proposal, a spec — with independent analysts who receive the document and the target repository\'s own guidance and nothing from its author. Rules on the design severity ladder; the gate is computed.',
  phases: [
    { title: 'Scope', detail: 'snapshot the artefact; with since, the lines that changed and the findings no edit touched' },
    { title: 'Locate', detail: 'one scout finds the repo\'s review guidance and the ground the artefact talks about' },
    { title: 'Ground', detail: 'write the artefact\'s citations, the located ground and the guidance to context files, once' },
    { title: 'Axes', detail: 'derive what to attack from the repo\'s own review guidance' },
    { title: 'Probe', detail: 'one analyst holding every axis unless the artefact\'s length earns more; artefact-only handoff' },
    { title: 'Record', detail: 'each new finding into the project-wide store, anchored to the snapshot' },
  ],
}

// ---------------------------------------------------------------- why this exists
//
// This repository had the adversarial-probe pattern twice and could reach it from neither:
// welded into `skills/design/SKILL.md` step 3, where it only runs inside a design interview,
// and in `agents/reviewer.md`, which is adversarial but speaks entirely in acceptance
// criteria, commit series and declared loci — none of which a written proposal has. Probing
// anything else meant improvising a probe, and an improvised probe is run by the document's
// own author, which is the one reviewer guaranteed to share its blind spots.
//
// Two properties are the whole point, and both are structural rather than asked-for:
//
//   1. ARTEFACT-ONLY HANDOFF. A prober receives the document and the repository. It never
//      receives the author's reasoning, summary, or "what I was going for". A prober given
//      the intent probes the intent; a prober given the document probes the thing that will
//      actually be implemented, which is the only thing anyone will read later.
//   2. THE GATE IS COMPUTED. Probers return findings on a fixed ladder and have no way to
//      say a design is sound. Whether ratification is blocked is a count of open ambiguities,
//      computed here — the same discipline every other verdict in this plugin follows, for
//      the same reason: the moment a schema offers a verdict, the exit condition migrates
//      out of JS and into a model's self-assessment.
//
// ---------------------------------------------------------------- what a probe costs
//
// Measured on one probe of a 120-line document against this repository (`wf_bbd2fa8e-ae9`,
// 17 agents, 8m24s), from the seventeen agent transcripts rather than from this workflow's own
// report: 33.1M cache reads, 3.3M cache writes, 16k output — 36.5M billed to return ~538k of
// evidence. 68× amplification.
//
// The cost is TURN COUNT, not payload. Every turn re-sends the accumulated context, so an
// analyst running 40 turns against a context growing toward 80k pays roughly 3.2M in cache
// reads, and sixteen of those is the whole bill. It is superlinear: the most expensive axis ran
// 62 turns for 4.36M, the cheapest 34 for 1.30M — 1.8× the turns for 3.4× the cost. Nobody
// ingested a large file; `Read` returned about 26k tokens per agent across the entire run. What
// the turns bought was LOCATING: 248 Reads, 148 Greps and 16 Globs, sixteen analysts
// independently finding the same lines.
//
// Two levers follow, and they are of different sizes. The Locate and Ground phases below remove
// the duplicated locating and are the ones worth having: one scout finds what the document talks
// about and what the repository asks reviewers to check, one script reads it all, and the
// analysts — who carry `Read` and nothing that searches — judge what they are handed. The derived-axis cap is a dial: 110 findings
// landed on 21 sections of a four-claim document, fourteen axes independently attacked the same
// finding, and yield per axis is flat (3–10, mean 6.9) — so cutting axes buys less coverage
// rather than less waste, and it says so in the result instead of in a log line.
//
// Trimming what analysts READ is worth almost nothing, and an earlier reading of this cost
// that blamed large-file ingestion pointed straight at that lever. The transcripts refuted it.
//
// The third lever is the number of analysts, and it is the one the per-axis shape never priced.
// Every analyst pays its own locating and its own turns, so twelve analysts on a 120-line
// document is twelve readers of a document one reader holds whole. The axes are a CHECKLIST for
// a reader, not a head count: by default one analyst carries every axis, and a second is bought
// only when the artefact is long enough that one reader would not get through it on all of them
// — `LINES_PER_ANALYST` below. A reader that still stops short is continued on exactly what it
// never reached (IRON LAW §3), which is the fan-out earned by measurement rather than predicted.
// `per_axis: true` restores one analyst per axis for a caller who wants the independent-heads
// shape and says so.

// ---------------------------------------------------------------- schemas
//
// No minItems / maxItems / minLength / maxLength anywhere — structured outputs do not
// support them, so a bound written here would silently do nothing or turn a good result into
// a dropped one. Bounds live in the prompt as behaviour and are enforced in JS.

const AXES = {
  type: 'object', additionalProperties: false,
  required: ['stop_reason', 'axes', 'guidance_read', 'notes'],
  properties: {
    stop_reason: { type: 'string', enum: ['completed', 'no_guidance_found', 'unreadable'] },
    axes: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['key', 'charge', 'source'],
      properties: {
        key: { type: 'string' },      // short slug, used as the agent label
        charge: { type: 'string' },   // what to attack, in the repository's own vocabulary
        source: { type: 'string' },   // the file that asked for it — '' for the standing axes
      } } },
    guidance_read: { type: 'array', items: { type: 'string' } },  // files the axes rest on
    notes: { type: 'string' },
  },
}

// What the locating scout returns. One scout holds both charges because both are a search of the
// same repository by the same reader, and neither needs the other's answer: `guidance` is what
// this project asks a reviewer to check, `ground` is what the artefact talks about without citing
// it by line — the modules it would change, and whatever already does what it proposes to build.
//
// The coverage fields answer the contract every search in this plugin answers to (IRON LAW §2),
// and only `hits` is required, so a finished search is never deadlocked on a field it had
// nothing for.
const LOCATED = {
  type: 'object', additionalProperties: false,
  required: ['hits'],
  properties: {
    hits: {
      type: 'array',
      description: 'One entry per location found. Locations only — no analysis, no verdicts.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['path', 'line', 'note', 'kind'],
        properties: {
          path: { type: 'string', description: 'Path to the file, relative to the repository.' },
          line: { type: 'integer', description: 'Line number of the hit.' },
          note: { type: 'string', description: 'What is at that line, in one line.' },
          kind: {
            type: 'string', enum: ['guidance', 'ground'],
            description: '"guidance" for a passage of this repository\'s own review or design ' +
              'guidance; "ground" for code or docs the artefact talks about.',
          },
        },
      },
    },
    searched: {
      type: 'array', items: { type: 'string' },
      description: 'Every pattern, glob and path you actually searched. Always include this field.',
    },
    stop_reason: {
      type: 'string', enum: ['exhausted', 'unfinished', 'stuck'],
      description: 'Always include this field. "exhausted" only when both charges are covered and ' +
        'you can name the surface; "unfinished" hands back an honest partial and you will be ' +
        'resumed; "stuck" when you found no way forward. The size of the work is never a reason.',
    },
    no_match: {
      type: 'string',
      description: 'What you searched for and genuinely did not find — a finding, not a gap. ' +
        'Send an empty string, never omit the field, when there is none.',
    },
    not_reached: {
      type: 'string',
      description: 'What you never searched, named so someone else can pick it up. An empty ' +
        'string when exhausted; never merged with no_match.',
    },
  },
}

// `severity` is the design ladder, not the code one. The code ladder is verbatim-diffed and
// speaks in acceptance criteria and commit series; a probe holding it would invent a mapping
// to a document that has neither and rule badly in both directions.
// `stop_reason` is the same instrument every search-shaped output in this plugin carries, and
// it is here for the same reason (IRON LAW §2). A prober that ran out of room halfway down a
// long design returned the identical empty findings list as one that read the whole thing and
// honestly found nothing — and an empty list on every axis computes `ratifiable: true`. That
// is a partial attack minted into a clean bill of health on the one gate that decides whether
// a design gets built.
//
// A prober holding several axes tags each finding with one of them, from a closed list built per
// dispatch: an axis it was not given cannot be where a finding lands.
function probeFindings(axisKeys) {
  return {
    type: 'object', additionalProperties: false,
    required: ['findings', 'notes'],
    properties: {
      findings: { type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['axis', 'severity', 'section', 'claim', 'evidence', 'start', 'end'],
        properties: {
          axis: { type: 'string', enum: axisKeys },
          severity: { type: 'string', enum: ['ambiguity', 'gap', 'note'] },
          section: { type: 'string' },   // where in the artefact, as the artefact names it
          claim: { type: 'string' },     // the defect, falsifiably stated
          evidence: { type: 'string' },  // the text or code that makes it real
          start: { type: 'integer' },    // first artefact line the finding is about, from 1
          end: { type: 'integer' },      // last line; the whole document for something it never says
        } } },
      notes: { type: 'string' },
      // Not `required`: an exhausted prober with nothing to say must never be deadlocked by a
      // field it forgot (the 0.12.1 postmortem). Absent, it is normalized below — toward
      // "unfinished", never toward "done".
      stop_reason: { type: 'string', enum: ['exhausted', 'unfinished', 'artefact_unreadable'] },
      not_reached: { type: 'string' },
    },
  }
}

// What a courier hands back: one command's stdout, byte-exact, in one string. The shape of
// `execute-approved-plan-in-worktrees`'s CARRIED, copied rather than shared because a workflow script cannot
// import. This workflow moves no todos, so the two todo fields are left out of its shape.
//
// `failed` is the courier unable to run the command AT ALL. An artefact that cites nothing is
// not that: it resolves to an empty payload, which is a real answer about the document.
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

const input = typeof args === 'string' ? { artifact: args } : (args || {})
const artifact = typeof input.artifact === 'string' ? input.artifact.trim() : ''
const roots = input.roots || '.'
const context = typeof input.context === 'string' ? input.context : ''

// The snapshot the last review of this artefact judged. With it, only the lines changed since are
// attacked, and earlier findings no edit touched are carried forward. Only a snapshot id goes into
// a command; anything else buys a full probe.
const SNAPSHOT_ID = /^snapshot:[0-9a-f]{8}$/
const since = typeof input.since === 'string' && SNAPSHOT_ID.test(input.since.trim()) ? input.since.trim() : ''
if (input.since && !since) log(`since ${JSON.stringify(input.since)} is not a snapshot id; probing in full.`)

// The repository the artefact's citations and the located ground are resolved against — the
// first root: a citation is repo-relative and there is one repository it is relative TO.
const groundRepo = String(roots).split(/[,;\n]/)[0].trim() || '.'

// How many DERIVED axes run. The standing four are never capped: each names a defect class that
// reaches implementation unnoticed, and dropping one of those would change what a probe IS.
//
// This is a dial and not a saving. Per-axis yield is flat, so a cap buys less coverage rather
// than less waste — which is why what it drops is named in the result. The number is the
// standing four doubled: a starting default to be revised against measurement, never a finding.
const DEFAULT_DERIVED_AXES = 8
const maxDerivedAxes = Number.isInteger(input.max_derived_axes) && input.max_derived_axes >= 0
  ? input.max_derived_axes
  : DEFAULT_DERIVED_AXES

// How many lines of artefact one analyst is asked to attack on every axis it holds. The measured
// probe that set this was 120 lines under seventeen analysts; one reader holds that whole. A
// starting default to be revised against measurement, never a finding — and the continuation
// below catches a reader it overestimated, so erring high costs a sequential round, not coverage.
const LINES_PER_ANALYST = 400
const perAxis = input.per_axis === true

// Where `lib/citations.mjs` lives, resolved the way every other workflow here resolves a plugin
// path: the caller's value, then the environment, then the shell form expanded in the agent's
// own shell. A script's cwd is not the agent's, so a relative path is never guessed at.
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

// The digest transport. A payload computed on disk arrives through a model, so it is re-digested
// here before a field of it is believed; a token this script mints travels by `viaJsonFile`.
// canonical and fnv1a are copies of `lib/plan-digest.mjs`'s: scripts cannot import, and the suite pins
// them together.
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

// cmd.exe caps a whole command line at 8191 characters, so nothing this script hands a courier to
// type puts more than this many on one line.
const COMMAND_BUDGET = 6000

/**
 * A token this script mints, as the courier carries it: one line of JSON written to a file under
 * `root` by single-quoted `printf` calls of at most COMMAND_BUDGET characters each, then read by
 * `cli` with `--json-file` under the token's digest and removed. `~` goes as `~t`, `\` as `~b`
 * and `'` as `~q`, so no backslash reaches the layer that decodes escapes in a Bash call and no
 * quote ends the argument (lib/store.mjs jsonFileText). Every write is a single line: the harness
 * indents each line of a computed prompt, and that indent must land before a command, never
 * inside the token. Returns the courier's writes and its one command.
 */
function viaJsonFile(cli, token, root) {
  const json = JSON.stringify(token).replace(/~/g, '~t').replace(/\\/g, '~b').replace(/'/g, '~q')
  const digest = fnv1a(canonical(token))
  const dir = `${root}/.agentics/.state`
  const file = `${dir}/token-${digest}.json`

  const writes = []
  for (let i = 0; i < json.length;) {
    let end = Math.min(i + COMMAND_BUDGET, json.length)
    const last = json.charCodeAt(end - 1)
    if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--
    const chunk = `printf '%s' '${json.slice(i, end)}'`
    writes.push(i === 0 ? `mkdir -p "${dir}" && ${chunk} > "${file}"` : `${chunk} >> "${file}"`)
    i = end
  }
  return { writes, command: `${cli} --digest ${digest} --json-file "${file}"; rm -f "${file}"` }
}

/** An item's identity: its question, topic and claim — a copy of `lib/evidence.mjs`'s `itemId`. */
const itemIdOf = (item) => 'I' + fnv1a(canonical({ question: item.question, topic: item.topic, claim: item.claim }))

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

  if (parsed && parsed.error) return { payload: null, why: 'the reader refused: ' + parsed.error, retry: '' }
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
// The refusals that mean the token was damaged on its way in, not that the program failed.
const DAMAGED_IN = ['digest_mismatch', 'args_unreadable']

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
 * Carry one command's payload, believed only after its digest. The ladder is `execute-approved-plan-in-worktrees`'s:
 * nothing back or a courier that could not run it is run again once; a payload damaged in transit
 * buys one refetch on a stronger model; a token the program refused as damaged on its way in is
 * copied again by the stronger model. Every carry here has a fallback, so none of them throws: `{payload: null, why}`.
 * `writes` are the file writes a token too long for one argv slot travels by, run first.
 */
async function carry(command, label, phaseName, writes = []) {
  const ladder = [COURIER]
  // A token written by file is copied by the courier, and a copy that failed once is retyped by
  // the stronger model rather than by the same one again.
  const again = writes.length > 0 ? COURIER_UP : COURIER
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
      // A model that miscopies a token miscopies it the same way again: the copy goes to the
      // stronger one.
      if (refused && DAMAGED_IN.includes(c.payload.error.kind) && !ladder.includes(COURIER_UP)) {
        why = c.payload.error.message || 'the argument token was damaged on its way in'
        ladder.push(COURIER_UP)
        continue
      }
      if (refused) return { payload: null, why: 'the program refused: ' + (c.payload.error.message || c.payload.error.kind) }
      return { payload: c.payload, why: '' }
    }

    why = c.why || why
    if (c.retry === 'again' && ladder.length < 2) ladder.push(again)
    else if (c.retry === 'stronger' && !ladder.includes(COURIER_UP)) ladder.push(COURIER_UP)
  }

  return { payload: null, why }
}

// The four axes that run whatever the repository asks for. They are not a house style: each
// names a defect class that a document can carry all the way to implementation before anyone
// notices, which is exactly the class worth paying a probe to find.
const STANDING = [
  { key: 'ambiguity', source: '', charge:
    'Contract ambiguity. Hunt terms, interfaces and field names the document leaves readable ' +
    'two ways. The archetype: one name carrying two incompatible definitions in the same ' +
    'document — every consumer implements one of them and the mismatch is invisible until ' +
    'integration. Also hunt the quieter form: a rule stated once loosely and once precisely, ' +
    'where a reader cannot tell which governs.' },
  { key: 'invariants', source: '', charge:
    'Unnamed invariants. Find what the design silently relies on and never states — an ' +
    'ordering it assumes, a uniqueness it needs, a thing it believes cannot be empty or ' +
    'null, a caller it assumes has already checked something. An invariant nobody wrote down ' +
    'is one nobody will preserve, and it breaks at the first change made by someone who was ' +
    'not in the room.' },
  { key: 'yagni', source: '', charge:
    'YAGNI. Find machinery the document builds for a requirement nobody stated — an ' +
    'abstraction with one implementation, a configuration surface nothing configures, a ' +
    'plugin point selected at runtime by nothing. Be specific about what would have to ' +
    'become true for it to earn its place, so the author can answer.' },
  { key: 'reinvention', source: '', charge:
    'Reinvention. Is anything here rebuilding something that already exists — in this ' +
    'repository, in its declared dependencies, in the language\'s standard library, or as a ' +
    'well-known tool? Answer from the repository ground located for you, not from memory. YAGNI ' +
    'catches building what nobody asked for; it will never catch building what everybody ' +
    'asked for and somebody already shipped.' },
]

const ladderText =
  `THE LADDER — rule every finding on exactly one of these three, and no other vocabulary:\n` +
  `- ambiguity — a term, contract, or interface the design leaves readable two ways. Blocks ` +
  `ratification.\n` +
  `- gap — a growth axis or requirement the design names but cannot absorb without rework. ` +
  `Resolved, or explicitly accepted by the user with the cost stated. Never silently carried.\n` +
  `- note — advisory. Recorded, never blocks.\n\n` +
  `Inflation and deflation are both failures here. An ambiguity blocks a document from being ` +
  `ratified, so calling a preference an ambiguity spends a person's afternoon; calling a ` +
  `genuine double-definition a note ships it into every consumer.\n\n`

function locatePrompt(prev) {
  const charge =
    `Locate two kinds of ground for a probe of a written artefact. You find locations; you judge ` +
    `nothing, and you do not review the artefact.\n\n` +
    `REPOSITORY: ${roots}\n` +
    `THE ARTEFACT: ${artifact}\n\n` +
    `1. GUIDANCE (kind "guidance"). This repository's own review and design guidance: its ` +
    `CLAUDE.md, AGENTS.md, specs or architecture notes under docs/, and any contributing or ` +
    `review guide. Report one hit per passage that asks a reviewer or a design to check ` +
    `something — the line where that ask starts. A repository with no such guidance is a real ` +
    `finding: say so in no_match.\n\n` +
    `2. GROUND (kind "ground"). Read the artefact, then locate in the repository what it talks ` +
    `about WITHOUT citing it by path and line: the modules, files and contracts it names or ` +
    `would change, and anything that already exists here — in the code, the declared ` +
    `dependencies, the tooling — that does what the artefact proposes to build. Lines the ` +
    `artefact already cites as path:line are read separately; do not report them again.\n\n` +
    `The analysts that attack this artefact cannot search: what you locate is what they get to ` +
    `read. Search to exhaustion — stop when both charges are covered or you are genuinely stuck, ` +
    `never because the list is getting long. If one pass cannot cover it, report what you have, ` +
    `set stop_reason "unfinished" and name exactly what remains in not_reached.`

  if (!prev) return charge
  return `Continue an unfinished search — do not start over.\n\nORIGINAL REQUEST:\n${charge}\n\n` +
    `ALREADY SEARCHED (do not repeat these):\n${prev.searched.join('\n')}\n\n` +
    `ALREADY FOUND (do not report these again):\n` +
    prev.hits.map((h) => `${h.path}:${h.line}`).join('\n') +
    `\n\nSTILL NOT REACHED — this is your job now:\n${prev.remainder}`
}

/**
 * The locating scout, driven to exhaustion (IRON LAW §3): continued on exactly what it names as
 * unreached for as long as a round brings back a new location or narrows the remainder. No
 * counter ends it (§1). Null when not one round reported — nothing was located at all.
 */
async function locate() {
  const hits = []
  const searched = []
  const noMatch = []
  const seen = new Set()
  let remainder = ''
  let prevKey = null
  let round = 0

  const result = (complete, notReached) =>
    ({ hits, searched, noMatch: noMatch.join('\n'), complete, notReached })

  for (;;) {
    round++
    const out = await agent(locatePrompt(round > 1 ? { hits, searched, remainder } : null), {
      agentType: 'agentics:scout', effort: 'low', schema: LOCATED,
      phase: 'Locate', label: 'locate' + (round > 1 ? '#' + round : ''),
    }).catch((e) => {
      log(`WARNING: locating round ${round} failed: ${e && e.message}`)
      return null
    })
    if (!out) return round === 1 ? null : result(false, remainder || `round ${round} produced no result`)

    let gained = false
    for (const h of out.hits || []) {
      const k = `${h.path}:${h.line}`
      if (!seen.has(k)) { seen.add(k); hits.push(h); gained = true }
    }
    for (const q of out.searched || []) if (String(q).trim()) searched.push(q)
    if ((out.no_match || '').trim()) noMatch.push(out.no_match.trim())

    if (out.stop_reason === 'exhausted') return result(true, '')

    const next = (out.not_reached || '').trim()
    if (!next) {
      return result(false, `the search stopped as "${out.stop_reason || 'unstated'}" without naming what was missed`)
    }
    const key = next.replace(/\s+/g, ' ').toLowerCase()
    if (!gained && key === prevKey) {
      log('locate: a round brought back nothing new and left the same ground unreached — stopping as stuck.')
      return result(false, next)
    }
    prevKey = key
    remainder = next
    log(`locate: unfinished after round ${round}, resuming.`)
  }
}

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

// A list travels in batches of at most COMMAND_BUDGET characters. Every location of one file goes
// in the same batch, so no two batches ever hold overlapping windows.

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

const normPath = (path) => String(path).split('\\').join('/')
const locKey = (path, line) => normPath(path) + ':' + String(Number.isInteger(line) ? line : 0)

/**
 * One reader's located evidence, read once by `lib/citations.mjs excerpts` into context files. The
 * courier carries back only their paths; the locations that reached none of them are named, so
 * the reader opens those itself.
 */
async function assembleLocated(hits, label) {
  const locations = []
  const seen = new Set()
  for (const h of hits) {
    const k = locKey(h.path, h.line)
    if (!seen.has(k)) { seen.add(k); locations.push({ path: normPath(h.path), line: Number.isInteger(h.line) ? h.line : 0 }) }
  }

  const parts = []
  const unread = new Set()
  const failures = []

  const unsent = locations.filter((loc) => !carriable(loc))
  for (const loc of unsent) unread.add(locKey(loc.path, loc.line))
  if (unsent.length > 0) failures.push(`${unsent.length} location(s): a path the list cannot carry unquoted`)

  const batches = batchesOf(locations.filter(carriable))
  const carried = await Promise.all(batches.map((batch, i) =>
    carry(locationsCommand(groundRepo, batch), batches.length === 1 ? label : `${label}:${i + 1}`, 'Ground')))

  carried.forEach((held, i) => {
    const context = held.payload && held.payload.context
    if (context && Array.isArray(context.parts)) {
      parts.push(...context.parts)
    } else {
      for (const loc of batches[i]) unread.add(locKey(loc.path, loc.line))
      failures.push(`${batches[i].length} location(s): ${held.why || 'no context files came back'}`)
    }
  })
  return { parts, unread, failures }
}

const hitLine = (h) => `  ${h.path}:${h.line} — ${h.note || ''}`
const partsList = (parts) => parts.map((p) => `  ${p.path} (${p.lines} line(s))`).join('\n')

/** Located evidence as a reader reads it: its context files, then whatever it must open itself. */
function locatedBlock(hits, context) {
  const bare = hits.filter((h) => context.unread.has(locKey(h.path, h.line)))
  return (context.parts.length > 0
    ? `CONTEXT FILES — read once for you by a script. Read each file below whole, and do not ` +
      `open the source files again to find these lines; a file's closing section names any ` +
      `location the script could not read:\n` + partsList(context.parts)
    : '') +
    (bare.length > 0
      ? `\n\nLOCATIONS NOT EXCERPTED — the script could not read these for you. Read each one ` +
        `yourself, in a line range around it, and nothing else:\n` + bare.map(hitLine).join('\n')
      : '')
}

function axesPrompt(evidence) {
  return `Derive, from this repository's own guidance, what a design review here must attack. ` +
    `You are not reviewing anything yet.\n\n` +
    `REPOSITORY: ${roots}\n\n` +
    `THE GUIDANCE a scout located — its CLAUDE.md, AGENTS.md, specs and architecture notes, ` +
    `contributing and review guides:\n\n` + evidence + `\n\n` +
    `You have no search tools: judge from what is above. Report the files your axes rest on in ` +
    `guidance_read — that list is what tells your caller whether the axes below rest on ` +
    `anything.\n\n` +
    `Return one axis per distinct thing this project asks reviewers to check, phrased as a ` +
    `charge to an agent that will attack the document on that axis alone, IN THIS ` +
    `REPOSITORY'S OWN VOCABULARY. A project that mandates its own review style is satisfied ` +
    `by this probe rather than double-probed, and a project whose vocabulary nobody here has ` +
    `heard of gets probed in that vocabulary anyway — which is the entire reason this step ` +
    `exists instead of a hardcoded list.\n\n` +
    `Name the file each axis came from in source. An axis you cannot trace to a passage above ` +
    `is an axis you invented; do not return it. Four standing axes (contract ambiguity, ` +
    `unnamed invariants, YAGNI, reinvention) are added by your caller — do not repeat them, ` +
    `and do not omit a repo axis because it looks similar to one of them.\n\n` +
    `Guidance that asks reviewers to check nothing is a real finding: return no_guidance_found ` +
    `with what you read. Never invent axes to fill the list. Return unreadable only when you ` +
    `could not read what you were handed at all.`
}

function citationsCommand() {
  return `node "${pluginRoot}/lib/citations.mjs" "${groundRepo}" "${artifact}"`
}

/**
 * The resolved citations, as every analyst reads them.
 *
 * The document's own citations, resolved once, so an analyst spends its turns ATTACKING rather
 * than locating. The framing matters as much as the payload — an analyst that reads this as "the
 * evidence" stops looking, and an axis whose ground the document never cites is exactly the axis
 * that most needs the located ground below it.
 */
function groundSection(ground) {
  if (!ground || !ground.payload) {
    return `\n\nNOTE: the evidence this document cites was NOT resolved for you` +
      (ground && ground.why ? ` (${ground.why})` : '') +
      `, so reading it is yours to do: open each path:line the artefact cites, in a line range ` +
      `around it. Nothing about your axis changes.\n\n`
  }

  const parts = (ground.payload.context && ground.payload.context.parts) || []

  return `\n\nWHAT THE DOCUMENT POINTS AT — resolved once, by a script, for every axis: the exact ` +
    `lines the artefact cites, so you do not have to go and find them, and last any citation ` +
    `that resolves to nothing, which is evidence about the DOCUMENT. Read each file below whole:\n` +
    (parts.length > 0 ? partsList(parts) : '  (the document cites no location in this repository)') +
    `\n\nThis is what the document POINTS AT and it is NOT the repository. Ground it never ` +
    `cites is not here, and on your axis that silence may be the finding — the ground located ` +
    `below is where to look for it.\n\n`
}

/** The repository ground the scout located beyond the document's own citations. */
function repoGroundSection() {
  if (!located) {
    return `REPOSITORY GROUND: NOT LOCATED — the search for what this document talks about ` +
      `failed, so you hold the document and its own citations only. A finding that needs ground ` +
      `beyond them states that it could not be checked, in its evidence; never present it as ` +
      `checked.\n\n`
  }
  return `REPOSITORY GROUND — what a scout located as the code and docs this document talks ` +
    `about, and whatever already exists here that does what it proposes:\n\n` +
    (groundHits.length > 0 ? locatedBlock(groundHits, groundContext) : '(nothing located)') +
    (located.noMatch ? `\n\nSEARCHED AND NOT FOUND (evidence of absence):\n${located.noMatch}` : '') +
    (located.complete
      ? ''
      : `\n\nWARNING: this search did NOT finish; it never reached: ${located.notReached}. A ` +
        `finding resting on unlocated ground says so.`) +
    `\n\n`
}

function axisBlock(bundle) {
  const one = (a) => `${a.key}${a.source ? ' (from ' + a.source + ')' : ''}:\n${a.charge}`

  if (bundle.length === 1) {
    return `YOUR AXIS — ${one(bundle[0])}\n\n` +
      `Stay on it. Other probes hold the other axes, and a probe that wanders reports what ` +
      `three others already have while its own axis goes unexamined.\n\n`
  }

  return `YOUR AXES — you hold all ${bundle.length} of these, and nobody else does. Treat ` +
    `them as a checklist: attack the whole document on each one in turn, and do not call ` +
    `yourself exhausted until every axis has had its pass. Tag every finding with the ONE ` +
    `axis it most belongs to; a defect two axes both notice is one finding, not two.\n\n` +
    bundle.map((a, i) => `${i + 1}. ${one(a)}`).join('\n\n') + '\n\n'
}

function probePrompt(bundle, ground, remainder) {
  const many = bundle.length > 1
  return `Attack this document on ${many ? 'the axes below' : 'ONE axis'}. You are a probe, ` +
    `not a reviewer: your job is to ` +
    `find where it is wrong, not to appraise it. A document that survives you is not thereby ` +
    `endorsed — you have no way to endorse anything, and your caller computes what your ` +
    `findings mean.\n\n` +
    (remainder
      ? `A CONTINUATION. An earlier probe held these same axes and stopped before it finished. ` +
        `Its findings are already recorded. Attack ONLY what it never reached:\n${remainder}\n` +
        `Read the rest of the document for context, but report only on that part.\n\n`
      : '') +
    (narrow
      ? `ATTACK ONLY THESE LINES — read the rest for context.\n` +
        `A NARROWED RE-REVIEW. This artefact was attacked before, and since then it changed only in ` +
        `these line ranges: ${narrow.changed.map((r) => `${r.start}-${r.end}`).join(', ')}.\n` +
        `What earlier attacks found on lines no edit touched is settled and carried forward; do not ` +
        `report it again:\n` +
        (carriedFindings.length > 0
          ? carriedFindings.map((f) => `- [${f.axis}, ${f.severity}] ${f.claim}`).join('\n')
          : '(nothing was carried forward)') + '\n\n'
      : '') +
    `THE ARTEFACT — read it in full before you write anything:\n${artifact}\n\n` +
    `REPOSITORY it will be implemented in: ${roots}\n` +
    `You carry Read and nothing that searches: the repository's ground was located and read ` +
    `for you, below. A claim about what this document would do to this repository is worth ` +
    `something only if it rests on a line you were handed or opened; "this may conflict with ` +
    `the existing design" without a path and a line is not a finding.\n` +
    groundSection(ground) +
    repoGroundSection() +
    (context ? `WHAT THIS DOCUMENT IS FOR:\n${context}\n\n` : '') +
    axisBlock(bundle) +
    ladderText +
    `Every finding is falsifiable: claim states the defect so it could be shown wrong, and ` +
    `evidence quotes the document or cites the code that makes it real. section names where ` +
    `in the artefact, using the artefact's own section names so a human can find it. start and ` +
    `end are the artefact lines the finding is about, from 1; for something the document never ` +
    `says, give the whole document.\n\n` +
    `You have the document and the repository. You do not have the author's reasoning, and ` +
    `that is deliberate: an author's account of what they meant talks you into reading the ` +
    `document as they intended rather than as it is written, and what gets implemented is ` +
    `what is written. If a passage only makes sense once you assume what they meant, that ` +
    `assumption is the finding.\n\n` +
    `Finding nothing on your axis after an honest attack IS your report. Do not pad it — a ` +
    `manufactured ambiguity costs a person a real conversation about a non-problem.\n\n` +
    `ALWAYS set stop_reason, and set it honestly. "exhausted" means you read the whole ` +
    `artefact and attacked all of it on ${many ? 'every one of your axes' : 'your axis'}. ` +
    `"unfinished" means you did not get that ` +
    `far, whatever the reason — then put what you never reached into not_reached, naming the ` +
    `sections${many ? ' and the axes' : ''}, in enough ` +
    `detail that a later probe can pick it up. "artefact_unreadable" means you could not read ` +
    `it at all.\n\n` +
    `Your caller cannot tell a clean document from a half-read one by looking at an empty ` +
    `findings list — the two are the same list. Only this field separates them, and it gates ` +
    `whether anyone is allowed to build from this design. Reporting "exhausted" for a document ` +
    `you skimmed is not optimism, it is the one lie this pipeline cannot catch.`
}

// ---------------------------------------------------------------- run

if (!artifact) {
  return {
    artifact: '',
    axes: [],
    axes_dropped: [],
    analysts: [],
    shared_ground: null,
    findings: [],
    ambiguities: [],
    ratifiable: false,
    coverage: {
      complete: false,
      dropped: [],
      incomplete: [],
      failed_channels: [],
      unreached: ['no artefact path was supplied, so nothing was probed'],
      resumable: { runId: 'unknown-to-script', remaining: [] },
    },
    snapshot: '',
    scope: { full: true, changed: [] },
    unrecorded: [],
    review: '',
  }
}

phase('Scope')

const scopeHeld = await carry(
  `node "${pluginRoot}/lib/evidence.mjs" review-scope --repo "${groundRepo}" --root "${groundRepo}" --file "${artifact}"` +
    (since ? ` --since "${since}"` : ''),
  'scope', 'Scope')
const scope = scopeHeld.payload && scopeHeld.payload.ok === true ? scopeHeld.payload : null
if (!scope) {
  log(`The artefact was not snapshotted (${scopeHeld.why || 'no scope came back'}): probing in full, and ` +
    `no finding can be recorded without a snapshot to anchor it to.`)
}
const narrow = scope && scope.full === false ? scope : null

/** An earlier finding the scope carried forward: its item, as a finding. */
function carriedFinding(it) {
  const d = it.detail || {}
  const s = (it.spans || [])[0] || {}
  return {
    axis: d.axis || String(it.topic || '').replace(/^challenge:/, ''), severity: d.severity || 'note',
    section: d.section || '', claim: it.claim, evidence: d.evidence || '', start: s.start || 0, end: s.end || 0,
    item: it.id, carried: true,
  }
}
const carriedFindings = narrow ? (narrow.carried || []).map(carriedFinding) : []

/**
 * Record a round's items with one courier. `items` is empty for a round that found nothing new —
 * the token `{items: []}` still records the round's return, so a clean review is a review return
 * like any other (Design Decisions 9).
 */
async function recordRound(items) {
  phase('Record')
  const { command, writes } = viaJsonFile(
    `node "${pluginRoot}/lib/evidence.mjs" record --repo "${groundRepo}" --root "${groundRepo}" --kind probe`,
    { items }, groundRepo)
  const held = await carry(command, 'record', 'Record', writes)
  if (held.payload && held.payload.ok === true) return { review: held.payload.return || '', unrecorded: [] }

  const why = held.why ||
    (held.payload && Array.isArray(held.payload.refused)
      ? held.payload.refused.length + ' item(s) refused: ' +
        held.payload.refused.map((r) => r.problems.join('; ')).join(' | ')
      : 'the result names no review return')
  if (items.length === 0) {
    log(`the clean round was not recorded (${why}): the result names no review return`)
    return { review: '', unrecorded: [] }
  }
  log(`${items.length} finding(s) not recorded (${why}): the result names no snapshot, so the next ` +
    `review of this artefact attacks it in full`)
  return { review: '', unrecorded: items.map(itemIdOf) }
}

if (narrow && narrow.changed.length === 0) {
  log(`The artefact is unchanged since ${since}: nothing to attack; ${carriedFindings.length} earlier ` +
    `finding(s) carried forward.`)
  const { review } = await recordRound([])
  const unchangedFindings = carriedFindings.map((f, i) => ({ ...f, id: 'P' + (i + 1) }))
  const unchangedAmbiguities = unchangedFindings.filter((f) => f.severity === 'ambiguity')
  return {
    artifact,
    axes: [],
    axes_dropped: [],
    analysts: [],
    shared_ground: null,
    guidance_read: [],
    repo_ground: { located: 0, complete: true, unresolved_batches: 0 },
    findings: unchangedFindings,
    ambiguities: unchangedAmbiguities,
    ratifiable: unchangedAmbiguities.length === 0,
    coverage: {
      complete: true,
      dropped: [],
      incomplete: [],
      failed_channels: [],
      unreached: [],
      resumable: { runId: 'unknown-to-script: pair with the runId from the Workflow launch result', remaining: [] },
    },
    snapshot: scope.snapshot,
    scope: { full: false, changed: [] },
    unrecorded: [],
    review,
  }
}

phase('Locate')

// Launched together, because the two are independent: what this document cites is resolved from
// the document alone, and what it talks about is found by a search that does not need that
// resolution. Paying for them one after the other would add the slower one's wall-clock to the
// faster one's for nothing.
const groundHeld = carry(citationsCommand(), 'ground', 'Ground')
const located = await locate()

const failedChannels = []
const guidanceHits = located ? located.hits.filter((h) => h.kind === 'guidance') : []
const groundHits = located ? located.hits.filter((h) => h.kind !== 'guidance') : []

if (!located) {
  // The analysts cannot search, so a scout that never reported leaves them the document and its
  // own citations. Both halves are coverage failures: the project's review standard was never
  // read, and nothing the document talks about without citing was located (IRON LAW §5).
  failedChannels.push('repo-axes', 'repo-ground')
  log('WARNING: nothing was located — the repository\'s guidance and the ground this document ' +
    'talks about are both unread; probing on the standing axes over the document alone.')
} else {
  log(`Located ${guidanceHits.length} guidance passage(s) and ${groundHits.length} ground ` +
    `location(s)${located.complete ? '' : ' — the search did NOT finish'}.`)
}

phase('Ground')

// Guidance and ground have different readers — the axes analyst and the probes — so each is its
// own context. Every probe Reads the same ground files: one read by a script, shared by all.
const [guidanceContext, groundContext] = await Promise.all([
  assembleLocated(guidanceHits, 'guidance-context'),
  assembleLocated(groundHits, 'ground-context'),
])
const locatedFailures = guidanceContext.failures.concat(groundContext.failures)
if (locatedFailures.length > 0) {
  log(`The located ground was not all resolved (${locatedFailures.join('; ')}); the analysts ` +
    `read those locations themselves. More turns, not less evidence.`)
}

const ground = await groundHeld

if (!ground.payload) {
  // Degraded, and deliberately NOT a failed channel. The analysts read the artefact and can open
  // every path:line it cites themselves: more turns, not less evidence.
  log(`The document's cited evidence was not resolved (${ground.why}); every analyst reads the ` +
    `citations itself. More turns, not less evidence.`)
} else {
  const c = ground.payload.counts || {}
  log(`Shared ground: ${c.excerpts || 0} excerpt(s) across ${c.files || 0} file(s) from ` +
    `${c.cited || 0} citation(s)` +
    (c.unresolved ? `, and ${c.unresolved} citation(s) that resolve to nothing — a finding ` +
      `about the document, handed to every axis` : '') + '.')
}

phase('Axes')

// No guidance located after an exhausted search is the repository stating none; no analyst is
// bought to say so. A search that did not finish is its own incompleteness, recorded below.
const discovered = guidanceHits.length === 0
  ? (located ? { stop_reason: 'no_guidance_found', axes: [], guidance_read: [], notes: located.noMatch } : null)
  : await agent(axesPrompt(locatedBlock(guidanceHits, guidanceContext)), {
    agentType: 'agentics:analyst', effort: 'low', schema: AXES,
    phase: 'Axes', label: 'axes',
  }).catch((e) => {
    log(`WARNING: deriving axes from the repository's review guidance failed: ${e && e.message}`)
    return null
  })

const repoAxes = discovered && discovered.stop_reason === 'completed'
  ? (discovered.axes || []).filter((a) => a && a.key && a.charge)
  : []

if (located && (!discovered || discovered.stop_reason === 'unreadable')) {
  // Degraded, not fatal: the four standing axes still run. But a probe that never read the
  // project's own rules is a narrower probe than the one that was asked for, and IRON LAW §5
  // says a failed side channel travels in the result rather than in a log line.
  failedChannels.push('repo-axes')
  log('WARNING: probing on the standing axes only — this repository\'s own guidance was not read.')
} else if (discovered && discovered.stop_reason === 'no_guidance_found') {
  log('This repository states no review guidance; probing on the standing axes.')
}

// The cap, applied to the DERIVED axes only. What it drops is a declared narrowing rather than
// a coverage failure, so it does not flip `coverage.complete`, which stays what it has always
// been: axes this probe COMMISSIONED and did not get a report from. It is named in `unreached`
// and in `resumable.remaining` all the same, because "an axis nobody ran" and "an axis that
// found nothing" are the same empty list, and a caller who wants them can re-run with a higher
// cap and get exactly them.
const derived = repoAxes.slice(0, maxDerivedAxes)
const axesDropped = repoAxes.slice(maxDerivedAxes).map((a) => a.key)

if (axesDropped.length > 0) {
  log(`Derived axes capped at ${maxDerivedAxes}: not probing ${axesDropped.join(', ')}. This ` +
    `buys a NARROWER probe, not a cheaper equivalent one — raise max_derived_axes to get them.`)
}

const axes = STANDING.concat(derived)

phase('Probe')

// How many analysts the artefact's length earns. An unknown length — the ground read failed —
// earns one, because the continuation below is what a reader that stops short buys anyway.
const artifactLines = ground.payload && Number.isInteger(ground.payload.artifact_lines)
  ? ground.payload.artifact_lines
  : 0
// A narrowed re-review is sized by the lines it actually attacks, not by the whole artefact.
const attackLines = narrow
  ? narrow.changed.reduce((n, r) => n + (r.end - r.start + 1), 0)
  : artifactLines
const analysts = perAxis
  ? axes.length
  : Math.max(1, Math.min(axes.length, Math.ceil(attackLines / LINES_PER_ANALYST)))

// Dealt round-robin, so the standing four spread across analysts rather than all landing on one.
const bundles = Array.from({ length: analysts }, () => [])
axes.forEach((axis, i) => bundles[i % analysts].push(axis))

const bundleLabel = (bundle) => `probe:${bundle.map((a) => a.key).join('+')}`

log(`Probing ${artifact} on ${axes.length} axes with ${analysts} analyst(s) — ` +
  (perAxis ? 'one per axis, as the caller asked'
    : attackLines ? `${attackLines} line(s) earn ${analysts}`
      : 'the artefact\'s length is unknown, so one') +
  `: ${bundles.map((b) => b.map((a) => a.key).join('+')).join(', ')}.`)

// One analyst's whole attack: a first pass, then continuations on exactly what it never
// reached, for as long as each pass gets further than the last. No counter ends it (IRON LAW
// §1). It ends when a pass is exhausted, or cannot say what it missed, or hands back the very
// remainder it was given — a pass that made no progress buys no further pass, and what it
// left stays in the coverage block as unreached.
async function attack(bundle) {
  const opts = {
    agentType: 'agentics:analyst', effort: 'medium',
    schema: probeFindings(bundle.map((a) => a.key)), phase: 'Probe', label: bundleLabel(bundle),
  }
  const passes = []
  let remainder = ''

  for (;;) {
    const report = await agent(probePrompt(bundle, ground, remainder),
      remainder ? { ...opts, label: opts.label + ':continued' } : opts).catch((e) => {
      log(`WARNING: ${opts.label} did not report: ${e && e.message}`)
      return null
    })
    if (!report) return { passes, remainder }

    passes.push(report)
    const next = (report.not_reached || '').trim()
    if (report.stop_reason !== 'unfinished' || !next || next === remainder) {
      return { passes, remainder: next }
    }
    remainder = next
  }
}

// parallel(), not pipeline(): every analyst is a leaf. There is no second stage to feed, and
// the barrier costs nothing because nothing waits on the slowest one but the report itself.
const outcomes = await parallel(bundles.map((bundle) => () => attack(bundle)))

// Reconcile by bundle. An axis whose analyst never reported is an axis nobody attacked, and it
// has to be reported as unexamined rather than quietly counted among the ones that found
// nothing — those two look identical in a findings list and mean opposite things.
const findings = carriedFindings.map((f, i) => ({ ...f, id: 'P' + (i + 1) }))
const newItems = []
const unexamined = []
const partiallyExamined = []

bundles.forEach((bundle, i) => {
  const outcome = outcomes[i]
  const passes = outcome ? outcome.passes : []

  const keys = bundle.map((a) => a.key)
  if (passes.length === 0) unexamined.push(...keys)
  for (const report of passes) {
    for (const f of report.findings || []) {
      const axis = keys.length === 1 ? keys[0] : keys.includes(f.axis) ? f.axis : keys.join('+')
      // A finding's own range is trusted only inside the snapshot it is about to be anchored to;
      // otherwise it is anchored to the whole document — the safe direction, re-reviewed on any edit.
      const inRange = scope && Number.isInteger(f.start) && Number.isInteger(f.end) &&
        f.start >= 1 && f.start <= f.end && f.end <= scope.lines
      const start = inRange ? f.start : (scope ? 1 : f.start)
      const end = inRange ? f.end : (scope ? scope.lines : f.end)
      const withRange = { ...f, axis, start, end }
      const item = scope ? itemOf(withRange) : null
      if (item) newItems.push(item)
      findings.push({ ...withRange, id: `P${findings.length + 1}`, item: item ? itemIdOf(item) : '', carried: false })
    }
  }

  // An axis that stopped short keeps whatever it found — the findings above are already in —
  // but it is not an axis that came back clean. Anything other than an explicit "exhausted"
  // counts as short, including an absent field: normalizing silence toward done is exactly how
  // a half-read document earns a clean bill of health.
  const last = passes[passes.length - 1]
  if (last && last.stop_reason !== 'exhausted') {
    for (const key of keys) {
      partiallyExamined.push({ key, why: last.stop_reason || 'unstated', remainder: outcome.remainder })
    }
  }
})

if (unexamined.length > 0) {
  failedChannels.push('probe')
  log(`WARNING: no report from ${unexamined.length} axis/axes: ${unexamined.join(', ')}.`)
}

if (partiallyExamined.length > 0) {
  log(`WARNING: ${partiallyExamined.length} axis/axes stopped before exhausting the artefact: ` +
    `${partiallyExamined.map((a) => `${a.key} (${a.why})`).join(', ')}.`)
}

const ambiguities = findings.filter((f) => f.severity === 'ambiguity')
const gaps = findings.filter((f) => f.severity === 'gap')

log(`${findings.length} finding(s): ${ambiguities.length} ambiguity, ${gaps.length} gap, ` +
  `${findings.length - ambiguities.length - gaps.length} note.`)

// A locating search that stopped short left the analysts less repository than there is. It is
// not an axis, but it is incomplete work every axis rested on, and resumable as such.
const incomplete = partiallyExamined.map((a) => a.key)
  .concat(located && !located.complete ? ['locate'] : [])

const coverage = {
  complete: unexamined.length === 0 && incomplete.length === 0 && failedChannels.length === 0,
  dropped: unexamined,
  incomplete,
  failed_channels: failedChannels,
  unreached: unexamined.map((key) =>
    key + ': no probe reported on this axis, so nothing here was examined for it')
    .concat(partiallyExamined.map((a) =>
      `${a.key}: the probe stopped "${a.why}" before exhausting the artefact` +
      (a.remainder ? `, never reaching: ${a.remainder}` : ', without naming what it missed') +
      ' — its findings stand, its silence does not'))
    .concat(failedChannels.includes('repo-axes')
      ? ['this repository\'s own review guidance was never read, so the probe covered the ' +
         'four standing axes only and anything this project specifically asks reviewers to ' +
         'check went unchecked']
      : [])
    .concat(axesDropped.map((key) =>
      key + ': this axis was derived from the repository\'s own guidance and then not run, ' +
      'because derived axes are capped at ' + maxDerivedAxes + '. Nothing was examined for it ' +
      '— re-run with a higher max_derived_axes to buy it'))
    .concat(failedChannels.includes('repo-ground')
      ? ['nothing the document talks about without citing it was located in the repository, so ' +
         'the analysts — who cannot search — attacked the document and its own citations only']
      : [])
    .concat(located && !located.complete
      ? ['locate: the search for the repository\'s guidance and the ground this document talks ' +
         'about stopped before it was exhausted, never reaching: ' + located.notReached]
      : [])
    .concat(locatedFailures.length > 0
      ? ['some located ground was not resolved for the analysts (' + locatedFailures.join('; ') +
         '), so they read those locations themselves — this cost turns, not coverage']
      : [])
    .concat(!ground.payload
      ? ['the evidence this document cites was not resolved for the analysts (' + ground.why +
         '), so each read it itself — this cost turns, not coverage, and no finding above ' +
         'rests on it']
      : (ground.payload.unresolved || []).length > 0
        ? ['the document cites ' + ground.payload.unresolved.length + ' location(s) that ' +
           'resolve to nothing; every analyst was told, and whether that is a finding is theirs ' +
           'to rule on rather than this script\'s']
        : []),
  resumable: {
    runId: 'unknown-to-script: pair with the runId from the Workflow launch result',
    remaining: unexamined.concat(incomplete).concat(axesDropped),
  },
}

// The gate, computed. `ratifiable` is a count of open ambiguities and the fact that the
// artefact was actually attacked, whole — never a prober's opinion that the document is sound.
//
// It is now exactly "no open ambiguity, and coverage is complete". Three ways of not having
// looked used to differ here: a dead prober made it false, but an axis that read half the
// document and a repo whose own review standard was never discovered both left it true. All
// three mean the same thing to the person about to build from this design — nobody looked —
// so the gate cannot be more permissive than the coverage block it ships beside. Ratifiable
// implies coverage.complete, in one direction and by construction.
const ratifiable = ambiguities.length === 0 && coverage.complete

/** A new finding as an evidence item: a claim about what the document says, anchored in its snapshot. */
function itemOf(f) {
  return {
    question: scope.path, topic: 'challenge:' + f.axis, ground: [scope.path], kind: 'behaviour', claim: f.claim,
    spans: [{ path: scope.path, start: f.start, end: f.end, at: scope.snapshot }],
    queries: [], sources: [], rests_on: [],
    detail: { axis: f.axis, severity: f.severity, section: f.section, evidence: f.evidence },
  }
}

const { review, unrecorded } = scope ? await recordRound(newItems) : { review: '', unrecorded: [] }

return {
  artifact,
  axes: axes.map((a) => ({ key: a.key, source: a.source || '' })),
  // What the cap declined to buy, beside what it bought. An axis list that showed only the
  // axes that ran would read identically whether the repository asked for four or forty.
  axes_dropped: axesDropped,
  // Which analyst held which axes, so the head count is legible: one entry per analyst that ran.
  analysts: bundles.map((b) => b.map((a) => a.key)),
  // The shared-ground read, as a fact rather than as evidence: no finding rests on it, and a
  // reader deciding whether this probe was cheap for a good reason or for a bad one needs to
  // see which.
  shared_ground: ground.payload
    ? { resolved: true, ...ground.payload.counts, unresolved: ground.payload.unresolved }
    : { resolved: false, why: ground.why },
  // What the repository's ground rested on: the guidance the axes were derived from, and how
  // much of what the document talks about was located and handed over.
  guidance_read: discovered && (discovered.guidance_read || []).length > 0
    ? discovered.guidance_read
    : [...new Set(guidanceHits.map((h) => String(h.path)))],
  repo_ground: located
    ? { located: groundHits.length, complete: located.complete, unresolved_batches: locatedFailures.length }
    : { located: 0, complete: false, unresolved_batches: 0 },
  findings,
  ambiguities,
  ratifiable,
  coverage,
  // An unrecorded finding is in no pool, so a next round narrowed by this snapshot would carry
  // nothing for it and never re-attack its lines: the snapshot names nothing until it does.
  snapshot: scope && unrecorded.length === 0 ? scope.snapshot : '',
  scope: scope ? { full: scope.full, changed: scope.changed } : { full: true, changed: [] },
  unrecorded,
  review,
}
