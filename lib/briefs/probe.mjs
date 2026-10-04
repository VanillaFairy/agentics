// lib/briefs/probe.mjs — every prompt the probe program builds: the locating scout's charge, the
// axes analyst's and each prober's, each a pure function of what it is handed.
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

// The design-severity-ladder block of the design and challenge-idea skills, word for word.
const LADDER = [
  '- **ambiguity** — a term, contract, or interface the design leaves readable two ways. Blocks',
  '  ratification. The archetype is one name with two incompatible definitions in the same',
  '  document: every consumer implements one of them, the mismatch is invisible until',
  '  integration, and it costs a rework round rather than a sentence.',
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

/** Pure. The locating scout's charge: the repository's review guidance, and the ground the artefact talks about without citing it. */
export function locateBrief({ artifact, text, roots: dirs, guidance = '' }) {
  return withGuidance([
    'Locate two kinds of ground for a probe of a written artefact. You find locations; you judge nothing, and you do ' +
      'not review the artefact. Return the scout_located schema.',
    'REPOSITORY: ' + roots(dirs),
    'THE ARTEFACT (' + artifact + '), whole:\n\n' + String(text || '').replace(/\n$/, ''),
    '1. GUIDANCE (kind "guidance"). This repository\'s own review and design guidance: its CLAUDE.md, AGENTS.md, specs ' +
      'or architecture notes under docs/, and any contributing or review guide. Report one hit per passage that asks a ' +
      'reviewer or a design to check something — the line where that ask starts. A repository with no such guidance is ' +
      'a real finding: say so in no_match.',
    '2. GROUND (kind "ground"). Locate in the repository what the artefact above talks about WITHOUT citing it by path ' +
      'and line: the modules, files and contracts it names or would change, and anything that already exists here — in ' +
      'the code, the declared dependencies, the tooling — that does what the artefact proposes to build. Lines the ' +
      'artefact already cites as path:line are read separately; do not report them again.',
    'The analysts that attack this artefact cannot search: what you locate is what they get to read. Search to ' +
      'exhaustion — stop when both charges are covered or you are genuinely stuck, never because the list is getting ' +
      'long. If one pass cannot cover it, report what you have, set stop_reason "unfinished" and name exactly what ' +
      'remains in not_reached.',
  ], guidance)
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

/** Pure. What the document cites, resolved once for every prober, the citations that resolve to nothing last. */
function citedText(cited) {
  if (cited.read_error) {
    return 'WHAT THE DOCUMENT POINTS AT was NOT resolved for you (' + cited.read_error + '): open each path:line the ' +
      'artefact cites yourself, in a line range around it.'
  }
  const blocks = cited.files.map((f) => `--- ${f.path} (${f.lines} line(s); the document cites ${f.cited_at.join(', ')})\n` +
    f.excerpts.map((e) => e.text).join('\n     …\n'))
  if (cited.unresolved.length > 0) {
    blocks.push('--- CITATIONS THAT RESOLVE TO NOTHING — evidence about the DOCUMENT: it points at a file nobody can ' +
      'open, or past the end of one that exists:\n' + cited.unresolved.map((u) => '- ' + u.detail).join('\n'))
  }
  return 'WHAT THE DOCUMENT POINTS AT — the lines it cites, read once by a script for every prober. This is what the ' +
    'document points at, NOT the repository: ground it never cites is not here, and on your axes that silence may be ' +
    'the finding.\n\n' + (blocks.length ? blocks.join('\n\n') : '(the document cites no location in this repository)')
}

/** Pure. The repository ground the locating scout found, or why there is none. */
function groundText(ground) {
  if (!ground) {
    return 'REPOSITORY GROUND: NOT LOCATED — the search for what this document talks about failed, so you hold the ' +
      'document and its own citations only. A finding that needs ground beyond them says in its evidence that it could ' +
      'not be checked; never present it as checked.'
  }
  return 'REPOSITORY GROUND — what a scout located as the code and docs this document talks about, and whatever ' +
    'already exists here that does what it proposes:\n\n' + ground.text +
    (ground.complete ? '' : '\n\nWARNING: this search did NOT finish. A finding resting on unlocated ground says so.')
}

/** Pure. A narrowed round's charge: the changed ranges alone, and the findings carried from the last round. */
function narrowText({ changed, carried }) {
  return 'A NARROWED RE-REVIEW. This artefact was attacked before, and since then it changed only in these line ranges: ' +
    changed.map((r) => r.start + '-' + r.end).join(', ') + '. ATTACK ONLY THESE LINES — read the rest for context.\n\n' +
    'What earlier attacks found on lines no edit touched is settled and carried forward; do not report it again:\n' +
    (carried.length
      ? carried.map((f) => `- ${f.id} [${f.severity}, ${f.axis}] section ${f.section || '(none named)'}: ${f.claim}`).join('\n')
      : '(nothing was carried forward)')
}

/** Pure. One prober's charge: the artefact line-numbered, its axes and units, the shared ground, the ladder; a narrowed round's ranges and carried findings. */
export function proberBrief({ artifact, text, context = '', axes, units, sections, cited, ground, guidance = '', narrow = null }) {
  const many = axes.length > 1
  const sectionOf = new Map(sections.map((s) => [s.slug, s]))
  const unitLine = (u) => {
    const s = sectionOf.get(u.slice(u.indexOf('@') + 1))
    return '- ' + u + (s ? ` — ${s.title ? 'section "' + s.title + '"' : 'the ' + s.slug}, lines ${s.start}-${s.end}` : '')
  }
  return withGuidance([
    `Attack this document on ${many ? 'the axes below' : 'ONE axis'}. You are a probe, not a reviewer: your job is to ` +
      'find where it is wrong, not to appraise it. A document that survives you is not thereby endorsed — you have no ' +
      'way to endorse anything, and your caller computes what your findings mean. Return the prober schema.',
    `THE ARTEFACT — ${artifact}, every line after its number. Read it in full before you write anything:\n\n` + numbered(text),
    ...(narrow ? [narrowText(narrow)] : []),
    ...(context ? ['WHAT THIS DOCUMENT IS FOR:\n' + context] : []),
    (many
      ? `YOUR AXES — you hold all ${axes.length} of these, and nobody else does. Treat them as a checklist: attack the ` +
        'whole document on each one in turn. Tag every finding with the ONE axis it most belongs to; a defect two axes ' +
        'both notice is one finding, not two.\n\n'
      : 'YOUR AXIS — stay on it: other probes hold the other axes.\n\n') +
      axes.map((a, i) => `${i + 1}. ${a.key}${a.source ? ' (from ' + a.source + ')' : ''}: ${a.charge}`).join('\n\n'),
    'YOUR UNITS — each of your axes against each section. Rule every one of them in units, with a line of why: ' +
      '"findings" when you report a finding on that axis in that section, "clean" when you attacked it and found ' +
      'nothing. A unit you did not get to stays open; never rule one you did not examine.\n' + units.map(unitLine).join('\n'),
    'You carry Read and nothing that searches: the repository\'s ground was located and read for you, below. A claim ' +
      'about what this document would do to this repository is worth something only if it rests on a line you were ' +
      'handed or opened.',
    citedText(cited),
    groundText(ground),
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
  ], guidance)
}
