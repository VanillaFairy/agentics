// lib/briefs/probe.mjs — every prompt the probe program builds: the locating search's find, the
// axes analyst's charge and each prober's, each a pure function of what it is handed.
//
// Design: docs/DESIGN.md#probe.

/** The four axes every probe attacks beside the repository's own: each names a defect class a document carries to implementation unnoticed. */
export const STANDING_AXES = [
  {
    key: 'ambiguity', source: '', charge: 'Contract ambiguity. Hunt terms, interfaces and field names the document leaves ' +
      'readable two ways. The archetype: one name carrying two incompatible definitions in the same document — every ' +
      'consumer implements one of them and the mismatch is invisible until integration. Also hunt the quieter form: a ' +
      'rule stated once loosely and once precisely, where a reader cannot tell which governs.',
  },
  {
    key: 'invariants', source: '', charge: 'Unnamed invariants. Find what the design silently relies on and never states — ' +
      'an ordering it assumes, a uniqueness it needs, a thing it believes cannot be empty or null, a caller it assumes ' +
      'has already checked something. An invariant nobody wrote down is one nobody will preserve, and it breaks at the ' +
      'first change made by someone who was not in the room.',
  },
  {
    key: 'yagni', source: '', charge: 'YAGNI. Find machinery the document builds for a requirement nobody stated — an ' +
      'abstraction with one implementation, a configuration surface nothing configures, a plugin point selected at ' +
      'runtime by nothing. Be specific about what would have to become true for it to earn its place, so the author ' +
      'can answer.',
  },
  {
    key: 'reinvention', source: '', charge: 'Reinvention. Is anything here rebuilding something that already exists — in ' +
      'this repository, in its declared dependencies, in the language\'s standard library, or as a well-known tool? ' +
      'Answer from the repository ground located for you, not from memory. YAGNI catches building what nobody asked ' +
      'for; it will never catch building what everybody asked for and somebody already shipped.',
  },
]

/** The axis every review of a planner-written spec adds: nobody else reads that spec before it is built. */
export const PLAN_AXIS = {
  key: 'entries', source: '', charge: 'Entries that do not do what they claim. Each plan entry lists the decisions it ' +
    'realises; read each decision\'s text and the entry\'s work side by side. Find an entry whose work does not do what ' +
    'the decision says — a test, a guard, a check or a module the decision never asks for, standing on a decision about ' +
    'something else. An entry added to answer a reviewer rather than a decision is the archetype: it grows the plan ' +
    'and realises nothing.',
}

/** The labels a locating hit carries: the repository's guidance, or the ground the artefact talks about. */
export const LOCATE_LABELS = ['guidance', 'ground']

/** What the locating search finds: the repository's own review and design guidance, and the artefact's ground. */
export const LOCATE_FIND = 'Two things this artefact rests on. First, this repository\'s own review and design guidance: ' +
  'its CLAUDE.md, AGENTS.md, specs or architecture notes under docs/, and any contributing or review guide — one hit, ' +
  'labelled `guidance`, per passage that asks a reviewer or a design to check something, at the line where that ask ' +
  'starts. Second, the code and documents the artefact talks about or would change — the modules, files and contracts ' +
  'it names — and anything here (code, declared dependencies, tooling) that already does what it proposes: hits ' +
  'labelled `ground`. A repository with no such guidance or ground is a real answer: say so in your summary.'

/** Pure. What a narrowed round's locating search finds: the ground the changed lines name that no earlier round located. */
export const locateGroundFind = (terms) => 'The code and documents these changed lines of an artefact talk about or would ' +
  'change, and anything here (code, declared dependencies, tooling) that already does what they propose: hits labelled ' +
  '`ground`.' + (terms.length ? ' Start from what the earlier review did not locate:\n' +
    terms.map((t) => '- ' + t.term + (t.lines ? ' (lines ' + t.lines + ')' : '')).join('\n') + '\n' : ' ') +
  'A repository with no such ground is a real answer: say so in your summary.'

// The design-severity-ladder block of the design and challenge-idea skills, word for word.
const LADDER = [
  '- **ambiguity** — a term, contract, or interface the design leaves readable two ways. Blocks',
  '  ratification. The archetype is one name with two incompatible definitions in the same',
  '  document: every consumer implements one of them, the mismatch is invisible until',
  "  integration, and it costs a rework round rather than a sentence. A question the document's",
  '  level of detail leaves to its builder — a type, a call order, a timing, an edge a planned',
  "  test's criterion pins — is a note, however precise the answer it lacks.",
  '- **gap** — a growth axis or requirement the design names but cannot absorb without rework.',
  '  Resolved, or explicitly accepted by the user with the cost stated. Never silently carried.',
  '- **note** — advisory. Recorded in the design document, never blocks, never loops.',
].join('\n')

const roots = (list) => (list.length ? list.join(', ') : '.')
const withGuidance = (parts, guidance) => (guidance ? [...parts, guidance] : parts).join('\n\n')

/** Pure. The artefact's lines, each after its number, as the probers cite them. */
const numbered = (text) => {
  const body = String(text || '').replace(/\n$/, '')
  return body === '' ? '(the artefact is empty)' : body.split('\n').map((line, i) => String(i + 1).padStart(6) + '\t' + line).join('\n')
}

/** Pure. The axes analyst's charge: what this repository's own guidance asks a design review to attack. */
export function axesBrief({ roots: dirs, located, guidance = '' }) {
  return withGuidance([
    'Derive, from this repository\'s own guidance, what a design review here must attack. You are not reviewing ' +
      'anything yet. Return the axes schema.',
    'REPOSITORY: ' + roots(dirs),
    'THE GUIDANCE a scout located — its CLAUDE.md, AGENTS.md, specs and architecture notes, contributing and review ' +
      'guides, each location with the lines around it:\n\n' + located,
    'Judge from what is above and below. Report the files your axes rest on in guidance_read: that list tells your ' +
      'caller whether the axes rest on anything.',
    'Return one axis per distinct thing this project asks reviewers to check, phrased as a charge to an agent that will ' +
      'attack the document on that axis, IN THIS REPOSITORY\'S OWN VOCABULARY. Name the file each axis came from in ' +
      'source. An axis you cannot trace to a passage you were handed is an axis you invented; do not return it. Four ' +
      'standing axes (contract ambiguity, unnamed invariants, YAGNI, reinvention) are added by your caller — do not ' +
      'repeat them, and do not omit a repository axis because it looks similar to one of them.',
    'Guidance that asks reviewers to check nothing is a real finding: return stop_reason "no_guidance_found" with what ' +
      'you read. Never invent axes to fill the list. Return "unreadable" only when you could not read what you were ' +
      'handed at all; otherwise "completed".',
  ], guidance)
}

/** Pure. The relocate judge's charge: name what the changed lines talk about that the earlier round's ground does not cover. */
export function relocateBrief({ artifact, material, located }) {
  return [
    'An artefact was reviewed against the repository ground listed below, and since then it changed only in the ' +
      'lines below. Name every module, file, contract or tool these changed lines talk about or would change that this ' +
      'ground does not cover, each as a term and the lines it is on. Nothing new is an empty list. Return the relocate schema.',
    'THE CHANGED LINES of ' + artifact + ':\n\n' + material.map((m) => '--- ' + m.label + '\n' + m.text).join('\n\n'),
    'THE GROUND ALREADY LOCATED — each place with what it is:\n' +
      (located.length ? located.map((l) => '- ' + l).join('\n') : '(nothing was located)'),
    'Judge from what is above alone. A term you are unsure the ground covers is an entry.',
  ].join('\n\n')
}

// What a part of a prober's brief says when its lines were left out to fit what the prober can read.
const LEFT_OUT = 'The lines were left out to fit what you can read in one brief: open each place you need with Read.'

/** Pure. What the document cites, resolved once for every prober, the citations that resolve to nothing last; with `places`, each file's head alone. */
function citedText(cited, places = false) {
  if (cited.read_error) {
    return 'WHAT THE DOCUMENT POINTS AT was NOT resolved for you (' + cited.read_error + '): open each path:line the ' +
      'artefact cites yourself, in a line range around it.'
  }
  const blocks = cited.files.map((f) => `--- ${f.path} (${f.lines} line(s); the document cites ${f.cited_at.join(', ')})` +
    (places ? '' : '\n' + f.excerpts.map((e) => e.text).join('\n     …\n')))
  if (places && blocks.length) blocks.unshift(LEFT_OUT)
  if (cited.unresolved.length > 0) {
    blocks.push('--- CITATIONS THAT RESOLVE TO NOTHING — evidence about the DOCUMENT: it points at a file nobody can ' +
      'open, or past the end of one that exists:\n' + cited.unresolved.map((u) => '- ' + u.detail).join('\n'))
  }
  return 'WHAT THE DOCUMENT POINTS AT — the lines it cites, read once by a script for every prober. This is what the ' +
    'document points at, NOT the repository: ground it never cites is not here, and on your axes that silence may be ' +
    'the finding.\n\n' + (blocks.length ? blocks.join('\n\n') : '(the document cites no location in this repository)')
}

/** Pure. The ground as places only: each search's head line and each hit's, none of their lines. */
const groundPlaces = (ground) => [LEFT_OUT, ...ground.blocks.map((b) => b.head)].join('\n')

/** Pure. The repository ground the locating search found, or why there is none; with `places`, its places alone. */
function groundText(ground, places = false) {
  if (!ground) {
    return 'REPOSITORY GROUND: NOT LOCATED — the search for what this document talks about produced nothing, so you ' +
      'hold the document and its own citations only. A finding that needs ground beyond them says in its evidence that ' +
      'it could not be checked; never present it as checked.'
  }
  return 'REPOSITORY GROUND — what the locating search found as the code and docs this document talks about, and ' +
    'whatever already exists here that does what it proposes:\n\n' + (places ? groundPlaces(ground) : ground.text) +
    (ground.complete ? '' : '\n\nWARNING: this search did NOT finish. A finding resting on unlocated ground says so.')
}

/** Pure. The specs above the artefact in its effort, nearest first: settled, and governing wherever another document disagrees; with `places`, their files alone. */
function settledText(specs, places = false) {
  const part = (title, body) => '#### ' + title + '\n' + (body || '(empty)')
  return 'SETTLED CONTEXT — the specs above this one in its effort, nearest first, which the user has already ruled ' +
    'on. Their Intent, Decisions and Design are settled: do not attack them. Where any other document in the ' +
    'repository (an older draft, a spec under docs/) disagrees with them, they govern and that document is ' +
    'superseded: never attack this artefact for departing from a superseded text. This artefact contradicting a ' +
    'settled decision is a finding.\n\n' +
    (places
      ? LEFT_OUT + ' Read the Intent, Decisions and Design of each:\n' + specs.map((s) => '--- ' + s.file).join('\n')
      : specs.map((s) => '--- ' + s.file + '\n' + [part('Intent', s.intent), part('Decisions', s.decisions), part('Design', s.design)].join('\n\n'))
        .join('\n\n'))
}

/** Pure. The findings a narrowed round carries, one line each, as its brief lists them or the file it hands them in holds them. */
const carriedLines = (carried) => (carried.length
  ? carried.map((f) => `- ${f.id} [${f.severity}, ${f.axis}] section ${f.section || '(none named)'}: ${f.claim}`).join('\n')
  : '(nothing was carried forward)')

/** Pure. A narrowed round's charge: the changed ranges alone, and the findings carried from the last round, inline or in the file `carriedFile`. */
function narrowText({ changed, carried }, carriedFile = '') {
  return 'A NARROWED RE-REVIEW. This artefact was attacked before; these line ranges changed since, or hold a section that ' +
    'attack left unfinished: ' +
    changed.map((r) => r.start + '-' + r.end).join(', ') + '. ATTACK ONLY THESE LINES — read the rest for context.\n\n' +
    (carriedFile
      ? 'What earlier attacks found on lines no edit touched is settled and carried forward: ' + carried.length + ' finding(s), ' +
        'listed in ' + carriedFile + '. Read that file before you report anything, and do not report them again.'
      : 'What earlier attacks found on lines no edit touched is settled and carried forward; do not report it again:\n' +
        carriedLines(carried))
}

// The lines either side of each changed range a narrowed round hands inline when its artefact goes by path.
const AROUND = 20

/** Pure. The artefact's lines in each changed range and AROUND lines either side, merged where they meet, each line after its number. */
function changedExcerpts(text, changed) {
  const lines = String(text || '').replace(/\n$/, '').split('\n')
  const spans = changed.map((r) => ({ from: Math.max(1, r.start - AROUND), to: Math.min(lines.length, r.end + AROUND) }))
    .sort((a, b) => a.from - b.from)
    .reduce((out, s) => (out.length && s.from <= out[out.length - 1].to + 1
      ? [...out.slice(0, -1), { from: out[out.length - 1].from, to: Math.max(out[out.length - 1].to, s.to) }]
      : [...out, s]), [])
  return spans.map((s) => lines.slice(s.from - 1, s.to).map((line, i) => String(s.from + i).padStart(6) + '\t' + line).join('\n'))
    .join('\n     …\n')
}

/** Pure. The artefact as the prober reads it: whole and numbered, or from `file`, a narrowed round's changed lines inline. */
function artefactText({ artifact, text, narrow }, file) {
  if (!file) return `THE ARTEFACT — ${artifact}, every line after its number. Read it in full before you write anything:\n\n` + numbered(text)
  const head = `THE ARTEFACT — ${artifact}. Its whole text is the file ${file}, whose line numbers are the ones your findings cite: ` +
    'read it in full before you write anything.'
  return narrow
    ? head + ' Its changed lines, with ' + AROUND + ' lines around each, are here, every line after its number:\n\n' + changedExcerpts(text, narrow.changed)
    : head
}

// The parts of a prober's brief that can be handed as places to open, in the order they are given up to
// fit: the least a prober loses by opening it itself first. A part goes by reference only where its
// caller named a file for it (`files`), or, for the ground, the citations and the settled specs, as places.
const FIT_ORDER = ['ground', 'cited', 'settled', 'guidance', 'carried', 'units', 'artefact']
const BY_FILE = ['guidance', 'carried', 'units', 'artefact']

/**
 * Pure. One prober's charge fitted to `room` bytes: whole when it fits, else each part in FIT_ORDER
 * handed as places to open, until it fits; `trimmed` names what was handed so. A part whose file
 * `files` does not name stays inline. `ground.blocks` are its `hitBlocks`; `files` holds `artefact`
 * (the snapshot's text), and `guidance`, `carried` and `units` (what `proberFiles` renders).
 */
export function proberBrief({ room = Infinity, files = {}, ...at }) {
  const trimmed = []
  let text = proberText(at, trimmed, files)
  for (const part of FIT_ORDER) {
    if (Buffer.byteLength(text, 'utf8') <= room) break
    if (BY_FILE.includes(part) && !files[part]) continue
    if (part === 'carried' && !at.narrow) continue
    trimmed.push(part)
    text = proberText(at, trimmed, files)
  }
  return { text, trimmed }
}

/** Pure. The texts a prober's brief may hand as files: its guidance, its carried findings and its units, one line each. */
export function proberFiles({ guidance = '', narrow = null, units, sections }) {
  return { guidance, carried: narrow ? carriedLines(narrow.carried) : '', units: units.map(unitLineOf(sections)).join('\n') }
}

/** Pure. A unit's line, with the section and lines it names. */
const unitLineOf = (sections) => {
  const sectionOf = new Map(sections.map((s) => [s.slug, s]))
  return (u) => {
    const s = sectionOf.get(u.slice(u.indexOf('@') + 1))
    return '- ' + u + (s ? ` — ${s.title ? 'section "' + s.title + '"' : 'the ' + s.slug}, lines ${s.start}-${s.end}` : '')
  }
}

/** Pure. One prober's charge: the artefact line-numbered, its settled context, its axes and units, the shared ground, the ladder; a narrowed round's ranges and carried findings; the parts `places` names as places alone. */
function proberText({ artifact, text, context = '', settled = [], axes, units, sections, cited, ground, guidance = '', narrow = null }, places, files = {}) {
  const many = axes.length > 1
  const by = (part) => (places.includes(part) ? files[part] : '')
  const guidanceNow = by('guidance')
    ? '## Repository guidance\n\n' + LEFT_OUT + ' This repository\'s guidance for the work is the file ' + files.guidance + ': read it.'
    : guidance
  return withGuidance([
    `Attack this document on ${many ? 'the axes below' : 'ONE axis'}. You are a probe, not a reviewer: your job is to ` +
      'find where it is wrong, not to appraise it. A document that survives you is not thereby endorsed — you have no ' +
      'way to endorse anything, and your caller computes what your findings mean. Return the prober schema.',
    artefactText({ artifact, text, narrow }, by('artefact')),
    ...(narrow ? [narrowText(narrow, by('carried'))] : []),
    ...(context ? ['WHAT THIS DOCUMENT IS FOR:\n' + context] : []),
    ...(settled.length ? [settledText(settled, places.includes('settled'))] : []),
    (many
      ? `YOUR AXES — you hold all ${axes.length} of these, and nobody else does. Treat them as a checklist: attack the ` +
        'whole document on each one in turn. Tag every finding with the ONE axis it most belongs to; a defect two axes ' +
        'both notice is one finding, not two.\n\n'
      : 'YOUR AXIS — stay on it: other probes hold the other axes.\n\n') +
      axes.map((a, i) => `${i + 1}. ${a.key}${a.source ? ' (from ' + a.source + ')' : ''}: ${a.charge}`).join('\n\n'),
    'YOUR UNITS — each of your axes against each ' +
      (narrow ? 'changed part of a section, keyed <section>~<first line>-<last line>' : 'section') +
      '. Rule every one of them in units, with a line of why: ' +
      '"findings" when you report a finding on that axis in that section, "clean" when you attacked it and found ' +
      'nothing. A unit you did not get to stays open; never rule one you did not examine.\n' +
      (by('units') ? 'There are ' + units.length + ', each under exactly its name, listed in ' + files.units + ': read it.' : units.map(unitLineOf(sections)).join('\n')),
    'You carry Read and nothing that searches: the repository\'s ground was located and read for you, below. A claim ' +
      'about what this document would do to this repository is worth something only if it rests on a line you were ' +
      'handed or opened.',
    citedText(cited, places.includes('cited')),
    groundText(ground, places.includes('ground')),
    'YOUR SCOPE — what this document adds, reshapes or removes. A finding whose claim holds of the repository with the ' +
      'document unapplied — a cost the code already carries that the document neither creates nor changes — is a note, ' +
      'however real: the document was not written to fix it. An axis on which the document adds and reshapes nothing ' +
      'has nothing to attack: rule its units clean, the why saying so.',
    'THE LADDER — rule every finding on exactly one of these three, and no other vocabulary:\n' + LADDER,
    'Every finding is falsifiable: claim states the defect so it could be shown wrong, and evidence quotes the document ' +
      'or cites the code that makes it real. axis is one of your axis keys; section is the section key your units name ' +
      '(after the @); start and end are the artefact lines the finding is about, from 1 — for something the document ' +
      'never says, the whole document.',
    'You have the document and the repository, not the author\'s reasoning: if a passage only makes sense once you ' +
      'assume what they meant, that assumption is the finding. Finding nothing after an honest attack IS your report; ' +
      'do not pad it.',
    `Set stop_reason honestly: "exhausted" when you attacked all you were charged with on ${many ? 'every one of your axes' : 'your axis'}, ` +
      '"unfinished" when you did not get that far — then name in not_reached what you never attacked — and ' +
      '"artefact_unreadable" when you could not read it at all.',
  ], guidanceNow)
}
