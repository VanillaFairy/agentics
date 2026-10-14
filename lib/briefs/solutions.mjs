// lib/briefs/solutions.mjs — every prompt the solutions program builds: the frame, a researcher's
// ask, the repository scan's ask and the assessment, each whole, from what the program hands in.
//
// Design: docs/DESIGN.md#existing-solutions.

const text = (v) => String(v ?? '').trim()
const block = (title, body) => (text(body) ? title + ':\n' + text(body) + '\n\n' : '')
const listOf = (v) => (Array.isArray(v) ? v : [])
const bullets = (list) => (listOf(list).length ? listOf(list).map((s) => '- ' + text(s)).join('\n') : '(none)')
const withGuidance = (body, guidance) => (guidance ? body + '\n\n' + guidance : body)

/** Pure. The framer's brief: the capability restated, its hard constraints and disqualifiers, the angles and the repository question. */
export function frameBrief({ capability, roots, constraints, notes, maxAngles, guidance }) {
  return withGuidance(
    'Frame a build-or-adopt search, and return it as the `frame` structured output. Somebody is considering ' +
    'writing this themselves; your job is to set up the search that finds out whether they need to.\n\n' +
    block('CAPABILITY THEY ARE CONSIDERING BUILDING', capability) +
    'REPOSITORY DIRECTORIES: ' + roots.join(', ') + '\n\n' +
    block('CONSTRAINTS THE CALLER STATED', constraints) +
    block('BACKGROUND SUPPLIED BY THE CALLER', notes) +
    'capability_line: restate the capability so that ANY implementation of it would qualify. Strip out the ' +
    'architecture, the data structure and any library already half-chosen: a framing that smuggles in an ' +
    'implementation finds only that implementation.\n\n' +
    'hard_constraints: what a candidate must satisfy to be usable here at all, from the caller\'s words and a ' +
    'manifest at a repository root; no preference the caller never stated.\n\n' +
    'disqualifiers: falsifiable statements that rule a candidate out, each checkable against a fact a researcher ' +
    'can report — a licence, a release date, a runtime requirement. "Not good enough" is not checkable.\n\n' +
    'angles: at most ' + maxAngles + ' independent search angles, each with a short kebab-case key and a precise ' +
    'find: what a documentation researcher should look for and where. Consider the language\'s own standard ' +
    'library first. Merge related angles rather than exceeding ' + maxAngles + '.\n\n' +
    'repo_question: what a read-only code scout should look for in this repository — a declared dependency, a ' +
    'vendored copy, a half-built version — that already provides some of this.\n\n' +
    'You may Read a manifest at a repository root (package.json, pyproject.toml, Cargo.toml, go.mod) and nothing ' +
    'further: the searching is the researchers\' and the scout\'s after you. Frame only.',
    guidance)
}

/** Pure. One researcher's ask: what is wanted, the hard constraints, its angle. The assessor weighs; a researcher reports. */
export function researchFind({ frame, angle, constraints }) {
  return block('WHAT IS WANTED', frame.capability_line) +
    'HARD CONSTRAINTS a candidate must satisfy:\n' + bullets(frame.hard_constraints) + '\n\n' +
    block('THIS ANGLE (' + angle.key + ')', angle.find) +
    block('CONSTRAINTS THE CALLER STATED', constraints) +
    'Read primary sources: the project\'s own documentation, its repository, its registry page. A candidate is a hit ' +
    'on the page you fetched for it, with its facts in candidate. Do not report a candidate you found only in a ' +
    'listicle without fetching what it points at. Read latest_version off the registry or the release page today; a ' +
    'version you recall is stale. Fill does_not_cover honestly for every candidate: a caller decides with that field.'
}

/** Pure. The repository scan's ask: what this repository already has of the capability. */
export function repoFind({ frame }) {
  return block('WHAT IS WANTED', frame.capability_line) +
    block('WHAT TO LOOK FOR', frame.repo_question) +
    'Search the dependency manifests as well as the source: a package already on the dependency list that provides ' +
    'this is the cheapest answer, and it is invisible to anyone grepping only for implementation code. Report ' +
    'locations; whether what you find is good enough is not your question.'
}

const facts = (c) => '- ' + text(c.name) + ' (' + text(c.source_url) + ')\n  is: ' + text(c.what_it_is) +
  '\n  version: ' + text(c.latest_version) + '\n  licence: ' + text(c.license) + '\n  maintenance: ' + text(c.maintenance) +
  '\n  covers: ' + text(c.covers) + '\n  does not cover: ' + text(c.does_not_cover)

/** Pure. The assessor's brief: the frame, every candidate as its researcher reported it, and the units it rules. */
export function assessBrief({ frame, reports, constraints, units, guidance }) {
  return withGuidance(
    'Rule on candidates for a build-or-adopt decision, and return the `assessment` structured output. You measure ' +
    'them; you do not pick one.\n\n' +
    block('WHAT IS WANTED', frame.capability_line) +
    'HARD CONSTRAINTS that bind every candidate:\n' + bullets(frame.hard_constraints) + '\n\n' +
    'DISQUALIFIERS — the only grounds on which you may rule a candidate out:\n' + bullets(frame.disqualifiers) + '\n\n' +
    block('CONSTRAINTS THE CALLER STATED', constraints) +
    'THE RESEARCHERS\' CANDIDATES — several angles searched independently, so one project may appear more than ' +
    'once, under more than one name:\n\n' +
    reports.map((r) => '=== find:' + r.key + '\n' + (r.candidates.length ? r.candidates.map(facts).join('\n') : '(none)')).join('\n\n') + '\n\n' +
    'Merge duplicates into one row of assessed, keeping the fullest facts from each. For each distinct candidate, ' +
    'copy into disqualifiers_hit, word for word, each disqualifier above it violates by the facts reported; an ' +
    'empty list means you checked it against every one and it violated none. Carry every candidate through, the ' +
    'failing ones included. Never cite a ground that is not on the list, and never rule a candidate out on a fact ' +
    'nobody reported: what you cannot settle from these facts goes in notes. You have no search tools.\n\n' +
    'UNITS — rule each in units: `assessed` when you measured it against every disqualifier, `unassessable` when ' +
    'the facts reported cannot settle it, with a line of why:\n' + bullets(units),
    guidance)
}
