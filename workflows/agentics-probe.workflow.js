export const meta = {
  name: 'agentics-probe',
  description: 'Adversarially probe a written artefact — a design, a proposal, a spec — with independent analysts who receive the document and the target repository\'s own guidance and nothing from its author. Rules on the design severity ladder; the gate is computed.',
  phases: [
    { title: 'Axes', detail: 'read the target repo\'s own review guidance for what to attack' },
    { title: 'Ground', detail: 'resolve the evidence the artefact cites, once, for every axis' },
    { title: 'Probe', detail: 'one analyst holding every axis unless the artefact\'s length earns more; artefact-only handoff' },
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
// Two levers follow, and they are of different sizes. The Ground phase below removes the
// duplicated locating and is the one worth having. The derived-axis cap is a dial: 110 findings
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
    guidance_read: { type: 'array', items: { type: 'string' } },  // files actually opened
    notes: { type: 'string' },
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
        required: ['axis', 'severity', 'section', 'claim', 'evidence'],
        properties: {
          axis: { type: 'string', enum: axisKeys },
          severity: { type: 'string', enum: ['ambiguity', 'gap', 'note'] },
          section: { type: 'string' },   // where in the artefact, as the artefact names it
          claim: { type: 'string' },     // the defect, falsifiably stated
          evidence: { type: 'string' },  // the text or code that makes it real
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

// What the citation courier hands back: one command's stdout, byte-exact, in one string.
// Copied from `agentics-survey`'s CARRIED rather than shared, because a workflow script cannot
// import — the copies are diffed against each other and against the library's output.
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

// The repository the artefact's citations are resolved against — the first root, on the same
// rule the knowledge base follows: a citation is repo-relative and there is one repository it
// is relative TO.
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

// The digest transport, in the one direction this workflow uses it. A payload computed on disk
// arrives through a model, so it is re-digested here before a field of it is believed. Both
// functions are copies of `lib/plan-digest.mjs`'s: scripts cannot import, and the suite pins
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
    'well-known tool? Read the repository to answer, do not reason from memory. YAGNI ' +
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

function axesPrompt() {
  return `Read this repository's own guidance and report what a design review here must ` +
    `attack. You are not reviewing anything yet.\n\n` +
    `REPOSITORY: ${roots}\n\n` +
    `Read its CLAUDE.md, AGENTS.md, any specs or architecture notes under docs/, and any ` +
    `contributing or review guidance you find. Report the files you actually opened in ` +
    `guidance_read — a list of what you looked at is what tells your caller whether the axes ` +
    `below rest on anything.\n\n` +
    `Return one axis per distinct thing this project asks reviewers to check, phrased as a ` +
    `charge to an agent that will attack the document on that axis alone, IN THIS ` +
    `REPOSITORY'S OWN VOCABULARY. A project that mandates its own review style is satisfied ` +
    `by this probe rather than double-probed, and a project whose vocabulary nobody here has ` +
    `heard of gets probed in that vocabulary anyway — which is the entire reason this step ` +
    `exists instead of a hardcoded list.\n\n` +
    `Name the file each axis came from in source. An axis you cannot trace to a file in this ` +
    `repository is an axis you invented; do not return it. Four standing axes (contract ` +
    `ambiguity, unnamed invariants, YAGNI, reinvention) are added by your caller — do not ` +
    `repeat them, and do not omit a repo axis because it looks similar to one of them.\n\n` +
    `A repository with no review guidance at all is a real finding: return ` +
    `no_guidance_found with what you looked for. Never invent axes to fill the list.`
}

function groundPrompt() {
  return `READ MODE. Resolve the evidence this document cites, and return what the command ` +
    `printed — verbatim. You run one command and paste its output; you decide nothing, you ` +
    `search for nothing, and you interpret nothing.\n\n` +
    `Run exactly this:\n\n` +
    `   node "${pluginRoot}/lib/citations.mjs" "${groundRepo}" "${artifact}"\n` +
    (pluginRoot === SHELL_ROOT
      ? `\n   If ${SHELL_ROOT} is empty in your shell that path cannot resolve. Stop and say ` +
        `so in the way your result shape allows — never substitute a relative path or a guess.\n\n`
      : '\n') +
    `Put its ENTIRE stdout into payload_raw, byte for byte, as one string. Do not parse it, do ` +
    `not reformat it, do not summarise it, and do not drop an excerpt that looks uninteresting ` +
    `to you. It is one line of JSON carrying its own digest: your caller recomputes that digest ` +
    `over what arrives, so a copy that drifted by a single character is detected rather than ` +
    `believed.\n\n` +
    `Citations that resolve to NOTHING come back in an "unresolved" list. Those are findings ` +
    `about the document and they travel exactly as they are — do not go looking for what the ` +
    `author probably meant, do not correct a path, and do not drop one because you can see the ` +
    `file was renamed.\n\n` +
    `A document that cites nothing resolvable prints an empty file list, and that IS the good ` +
    `case. Return stop_reason failed ONLY when the command could not be run at all, with what ` +
    `the shell reported in notes.`
}

/**
 * The resolved excerpts, as every analyst reads them.
 *
 * This is the whole of 4a: the document's own citations, resolved once, so an analyst spends its
 * turns ATTACKING rather than locating. The framing matters as much as the payload — an analyst
 * that reads this as "the evidence" stops looking, and an axis whose ground the document never
 * cites is exactly the axis that most needs to go and look.
 */
function groundSection(ground) {
  if (!ground || !ground.payload) {
    return `\n\nNOTE: the evidence this document cites was NOT resolved for you` +
      (ground && ground.why ? ` (${ground.why})` : '') +
      `, so locating it is yours to do, as it always was. Nothing about your axis changes.\n\n`
  }

  const p = ground.payload
  const excerpts = (p.files || []).map((f) =>
    `--- ${f.path} (${f.lines} line(s); the document cites ${(f.cited_at || []).join(', ')})\n` +
    (f.excerpts || []).map((e) => e.text).join('\n     …\n')).join('\n\n')

  const broken = (p.unresolved || []).length === 0 ? '' :
    `\n\nCITATIONS THAT RESOLVE TO NOTHING — read these as evidence about the DOCUMENT, ` +
    `because that is what they are. A document about to be built from that points at a file ` +
    `nobody can open, or past the end of one that exists, is making a claim its reader cannot ` +
    `check:\n` +
    p.unresolved.map((u) => `- ${u.detail}`).join('\n')

  return `\n\nWHAT THE DOCUMENT POINTS AT — resolved once, by a script, for every axis. These ` +
    `are the exact lines the artefact cites, so you do not have to go and find them:\n\n` +
    (excerpts || '(the document cites no location in this repository)') +
    broken +
    `\n\nThis is what the document POINTS AT and it is NOT the repository. Ground it never ` +
    `cites is not here, and on your axis that silence may be the finding — go and read whatever ` +
    `you need. What this removes is the twenty-six searches every other axis was also paying ` +
    `for to arrive at the same lines.\n\n`
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
    `THE ARTEFACT — read it in full before you write anything:\n${artifact}\n\n` +
    `REPOSITORY it will be implemented in: ${roots}\n` +
    `Read the code. A claim about what this document would do to this repository is worth ` +
    `something only if you looked; "this may conflict with the existing design" without a ` +
    `path and a line is not a finding.\n` +
    groundSection(ground) +
    (context ? `WHAT THIS DOCUMENT IS FOR:\n${context}\n\n` : '') +
    axisBlock(bundle) +
    ladderText +
    `Every finding is falsifiable: claim states the defect so it could be shown wrong, and ` +
    `evidence quotes the document or cites the code that makes it real. section names where ` +
    `in the artefact, using the artefact's own section names so a human can find it.\n\n` +
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
  }
}

phase('Axes')

// Launched BEFORE the axes are awaited, because the two are independent: what the repository
// asks reviewers to check and what this document points at are different questions, and paying
// for them one after the other would add the slower one's wall-clock to the faster one's for
// nothing.
const groundHeld = agent(groundPrompt(), {
  agentType: 'agentics:ground', effort: 'low', model: 'haiku', schema: CARRIED,
  phase: 'Ground', label: 'ground',
}).catch((e) => {
  log(`WARNING: resolving the document's cited evidence failed: ${e && e.message}`)
  return null
})

const discovered = await agent(axesPrompt(), {
  agentType: 'agentics:analyst', effort: 'low', schema: AXES,
  phase: 'Axes', label: 'axes',
}).catch((e) => {
  log(`WARNING: reading the repository's review guidance failed: ${e && e.message}`)
  return null
})

const failedChannels = []
const repoAxes = discovered && discovered.stop_reason === 'completed'
  ? (discovered.axes || []).filter((a) => a && a.key && a.charge)
  : []

if (!discovered || discovered.stop_reason === 'unreadable') {
  // Degraded, not fatal: the four standing axes still run. But a probe that never read the
  // project's own rules is a narrower probe than the one that was asked for, and IRON LAW §5
  // says a failed side channel travels in the result rather than in a log line.
  failedChannels.push('repo-axes')
  log('WARNING: probing on the standing axes only — this repository\'s own guidance was not read.')
} else if (discovered.stop_reason === 'no_guidance_found') {
  log('This repository states no review guidance; probing on the standing axes.')
}

// The cap, applied to the DERIVED axes only. What it drops is a declared narrowing rather than
// a coverage failure — the same distinction `agentics-develop`'s fix lane draws when a caller names a
// locus instead of buying a survey — so it does not flip `coverage.complete`, which stays what it
// has always been: axes this probe COMMISSIONED and did not get a report from. It is named in
// `unreached` and in `resumable.remaining` all the same, because "an axis nobody ran" and "an
// axis that found nothing" are the same empty list, and a caller who wants them can re-run with a
// higher cap and get exactly them.
const derived = repoAxes.slice(0, maxDerivedAxes)
const axesDropped = repoAxes.slice(maxDerivedAxes).map((a) => a.key)

if (axesDropped.length > 0) {
  log(`Derived axes capped at ${maxDerivedAxes}: not probing ${axesDropped.join(', ')}. This ` +
    `buys a NARROWER probe, not a cheaper equivalent one — raise max_derived_axes to get them.`)
}

const axes = STANDING.concat(derived)

phase('Ground')
const ground = carriedRead(await groundHeld)

if (!ground.payload) {
  // Degraded, and deliberately NOT a failed channel. A shared-ground read that does not happen
  // costs this probe nothing it was going to have: every analyst locates the document's evidence
  // itself, exactly as it did before this dispatch existed. More work, not less evidence — the
  // same stance `agentics-survey` takes toward an unreadable knowledge base.
  log(`The document's cited evidence was not resolved (${ground.why}); every analyst locates it ` +
    `itself, as it did before. More work, not less evidence.`)
} else {
  const c = ground.payload.counts || {}
  log(`Shared ground: ${c.excerpts || 0} excerpt(s) across ${c.files || 0} file(s) from ` +
    `${c.cited || 0} citation(s)` +
    (c.unresolved ? `, and ${c.unresolved} citation(s) that resolve to nothing — a finding ` +
      `about the document, handed to every axis` : '') + '.')
}

phase('Probe')

// How many analysts the artefact's length earns. An unknown length — the ground read failed —
// earns one, because the continuation below is what a reader that stops short buys anyway.
const artifactLines = ground.payload && Number.isInteger(ground.payload.artifact_lines)
  ? ground.payload.artifact_lines
  : 0
const analysts = perAxis
  ? axes.length
  : Math.max(1, Math.min(axes.length, Math.ceil(artifactLines / LINES_PER_ANALYST)))

// Dealt round-robin, so the standing four spread across analysts rather than all landing on one.
const bundles = Array.from({ length: analysts }, () => [])
axes.forEach((axis, i) => bundles[i % analysts].push(axis))

const bundleLabel = (bundle) => `probe:${bundle.map((a) => a.key).join('+')}`

log(`Probing ${artifact} on ${axes.length} axes with ${analysts} analyst(s) — ` +
  (perAxis ? 'one per axis, as the caller asked'
    : artifactLines ? `${artifactLines} line(s) earn ${analysts}`
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
const findings = []
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
      findings.push({ ...f, axis, id: `P${findings.length + 1}` })
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

const incomplete = partiallyExamined.map((a) => a.key)

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
    .concat(!ground.payload
      ? ['the evidence this document cites was not resolved for the analysts (' + ground.why +
         '), so each located it itself — this cost turns, not coverage, and no finding above ' +
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
  guidance_read: discovered ? (discovered.guidance_read || []) : [],
  findings,
  ambiguities,
  ratifiable,
  coverage,
}
