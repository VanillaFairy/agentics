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

/** Pure. Where a part's lines went once they were handed as the file at `path`. */
const inFile = (path) => 'The lines were left out to fit what you can read in one brief: they are the file ' + path +
  '. Open what you need of it with Read.'

/** Pure. What the document cites, resolved once for every prober, the citations that resolve to nothing last; with `path`, each file's head alone and its lines in that file. */
function citedText(cited, path = '') {
  if (cited.read_error) {
    return 'WHAT THE DOCUMENT POINTS AT was NOT resolved for you (' + cited.read_error + '): open each path:line the ' +
      'artefact cites yourself, in a line range around it.'
  }
  const blocks = cited.files.map((f) => `--- ${f.path} (${f.lines} line(s); the document cites ${f.cited_at.join(', ')})` +
    (path ? '' : '\n' + f.excerpts.map((e) => e.text).join('\n     …\n')))
  if (path && blocks.length) blocks.unshift(inFile(path))
  if (cited.unresolved.length > 0) {
    blocks.push('--- CITATIONS THAT RESOLVE TO NOTHING — evidence about the DOCUMENT: it points at a file nobody can ' +
      'open, or past the end of one that exists:\n' + cited.unresolved.map((u) => '- ' + u.detail).join('\n'))
  }
  return 'WHAT THE DOCUMENT POINTS AT — the lines it cites, read once by a script for every prober. This is what the ' +
    'document points at, NOT the repository: ground it never cites is not here, and on your axes that silence may be ' +
    'the finding.\n\n' + (blocks.length ? blocks.join('\n\n') : '(the document cites no location in this repository)')
}

/** Pure. The repository ground the locating search found, or why there is none; with `path`, its places alone and their lines in that file. */
function groundText(ground, path = '') {
  if (!ground) {
    return 'REPOSITORY GROUND: NOT LOCATED — the search for what this document talks about produced nothing, so you ' +
      'hold the document and its own citations only. A finding that needs ground beyond them says in its evidence that ' +
      'it could not be checked; never present it as checked.'
  }
  return 'REPOSITORY GROUND — what the locating search found as the code and docs this document talks about, and ' +
    'whatever already exists here that does what it proposes:\n\n' +
    (path ? [inFile(path), ...ground.blocks.map((b) => b.head)].join('\n') : ground.text) +
    (ground.complete ? '' : '\n\nWARNING: this search did NOT finish. A finding resting on unlocated ground says so.')
}

const SETTLED_HEAD = 'SETTLED CONTEXT — the specs above this one in its effort, nearest first, which the user has already ruled ' +
  'on. Their Intent, Decisions and Design are settled: do not attack them. Where any other document in the ' +
  'repository (an older draft, a spec under docs/) disagrees with them, they govern and that document is ' +
  'superseded: never attack this artefact for departing from a superseded text. This artefact contradicting a ' +
  'settled decision is a finding.'

/** Pure. The specs above the artefact in its effort, nearest first: settled, and governing wherever another document disagrees. */
function settledText(specs) {
  const part = (title, body) => '#### ' + title + '\n' + (body || '(empty)')
  return SETTLED_HEAD + '\n\n' +
    specs.map((s) => '--- ' + s.file + '\n' + [part('Intent', s.intent), part('Decisions', s.decisions), part('Design', s.design)].join('\n\n'))
      .join('\n\n')
}

/** Pure. The findings a narrowed round carries, one line each. */
const carriedLines = (carried) => (carried.length
  ? carried.map((f) => `- ${f.id} [${f.severity}, ${f.axis}] section ${f.section || '(none named)'}: ${f.claim}`).join('\n')
  : '(nothing was carried forward)')

const CARRIED_HEAD = 'What earlier attacks found on lines no edit touched is settled and carried forward; do not report it again:'

// The lines either side of each changed range a narrowed round keeps inline when its artefact goes as a file.
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

/** Pure. A unit's line, with the section and lines it names. */
const unitLineOf = (sections) => {
  const sectionOf = new Map(sections.map((s) => [s.slug, s]))
  return (u) => {
    const s = sectionOf.get(u.slice(u.indexOf('@') + 1))
    return '- ' + u + (s ? ` — ${s.title ? 'section "' + s.title + '"' : 'the ' + s.slug}, lines ${s.start}-${s.end}` : '')
  }
}

/**
 * Pure. One prober's charge, shaped for the fit (lib/briefs/fit.mjs): the artefact line-numbered, its
 * settled context, its axes and units, the shared ground, the ladder; a narrowed round's ranges and
 * carried findings. Past the room, the ground goes first as places, then the cited lines, the settled
 * specs, the guidance, the carried findings, the units, and last the artefact, whose file holds its
 * text, so its line numbers are the ones findings cite; a narrowed round keeps its changed lines inline.
 */
export function proberBrief({ artifact, text, context = '', settled = [], axes, units, sections, cited, ground, guidance = '', narrow = null }) {
  const many = axes.length > 1
  const charge = (key, body) => ({ key, text: body })
  const artefactHead = `THE ARTEFACT — ${artifact}`
  const parts = [
    charge('charge', `Attack this document on ${many ? 'the axes below' : 'ONE axis'}. You are a probe, not a reviewer: your job is to ` +
      'find where it is wrong, not to appraise it. A document that survives you is not thereby endorsed — you have no ' +
      'way to endorse anything, and your caller computes what your findings mean. Return the prober schema.'),
    {
      key: 'artefact', rank: 6, text: artefactHead + ', every line after its number. Read it in full before you write anything:\n\n' + numbered(text),
      file: String(text || ''),
      ref: (path) => artefactHead + '. Its whole text is the file ' + path + ', whose line numbers are the ones your findings cite: ' +
        'read it in full before you write anything.' +
        (narrow ? ' Its changed lines, with ' + AROUND + ' lines around each, are here, every line after its number:\n\n' + changedExcerpts(text, narrow.changed) : ''),
    },
    ...(narrow ? [
      charge('narrowed', 'A NARROWED RE-REVIEW. This artefact was attacked before; these line ranges changed since, or hold a section that ' +
        'attack left unfinished: ' + narrow.changed.map((r) => r.start + '-' + r.end).join(', ') + '. ATTACK ONLY THESE LINES — read the rest for context.'),
      {
        key: 'carried', rank: 4, text: CARRIED_HEAD + '\n' + carriedLines(narrow.carried), file: carriedLines(narrow.carried),
        ref: (path) => 'What earlier attacks found on lines no edit touched is settled and carried forward: ' + narrow.carried.length +
          ' finding(s), listed in the file ' + path + '. Read it before you report anything, and do not report them again.',
      },
    ] : []),
    ...(context ? [charge('context', 'WHAT THIS DOCUMENT IS FOR:\n' + context)] : []),
    ...(settled.length ? [{
      key: 'settled', rank: 2, text: settledText(settled),
      ref: (path) => SETTLED_HEAD + '\n\n' + inFile(path) + ' They are of:\n' + settled.map((s) => '--- ' + s.file).join('\n'),
    }] : []),
    charge('axes', (many
      ? `YOUR AXES — you hold all ${axes.length} of these, and nobody else does. Treat them as a checklist: attack the ` +
        'whole document on each one in turn. Tag every finding with the ONE axis it most belongs to; a defect two axes ' +
        'both notice is one finding, not two.\n\n'
      : 'YOUR AXIS — stay on it: other probes hold the other axes.\n\n') +
      axes.map((a, i) => `${i + 1}. ${a.key}${a.source ? ' (from ' + a.source + ')' : ''}: ${a.charge}`).join('\n\n')),
    {
      key: 'units', rank: 5, file: units.map(unitLineOf(sections)).join('\n'),
      text: unitsHead(narrow) + '\n' + units.map(unitLineOf(sections)).join('\n'),
      ref: (path) => unitsHead(narrow) + '\nThere are ' + units.length + ', each under exactly its name, listed in the file ' + path + ': read it.',
    },
    charge('tools', 'You carry Read and nothing that searches: the repository\'s ground was located and read for you, below. A claim ' +
      'about what this document would do to this repository is worth something only if it rests on a line you were ' +
      'handed or opened.'),
    { key: 'cited', rank: 1, text: citedText(cited), ref: (path) => citedText(cited, path) },
    { key: 'ground', rank: 0, text: groundText(ground), ref: (path) => groundText(ground, path) },
    charge('rules', [
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
    ].join('\n\n')),
    ...(guidance ? [{
      key: 'guidance', rank: 3, text: guidance,
      ref: (path) => '## Repository guidance\n\nThis repository\'s guidance for the work was left out to fit what you can read in one brief: it is the file ' + path + '. Read it.',
    }] : []),
  ]
  return { parts }
}

/** Pure. The head of a prober's units. */
const unitsHead = (narrow) => 'YOUR UNITS — each of your axes against each ' +
  (narrow ? 'changed part of a section, keyed <section>~<first line>-<last line>' : 'section') +
  '. Rule every one of them in units, with a line of why: ' +
  '"findings" when you report a finding on that axis in that section, "clean" when you attacked it and found ' +
  'nothing. A unit you did not get to stays open; never rule one you did not examine.'
