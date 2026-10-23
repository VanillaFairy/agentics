// test/spec.test.mjs — a DESIGN.md read as data: sections, Decisions rows, graded open questions and
// plan entries; the checks that place a spec in its effort; and the hash approval rests on.
//
// Design: docs/DESIGN.md#spec-format.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import {
  ENTRY_KEYS, ENTRY_KINDS, GRADES, SECTIONS, checkFolder, checkSpec, entryId, hashSpec, parseSpec,
} from '../lib/spec.mjs'
import { specPath } from '../lib/store.mjs'

const CLI = fileURLToPath(new URL('../lib/spec.mjs', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures/spec/', import.meta.url))
// The working tree may hold the fixtures with CRLF endings (core.autocrlf); the tests build both
// endings from one LF copy on purpose.
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n')
const ROOT = read('root.md')
const SUB = read('sub.md')

/** 1-based number of the first line at or after `from` that contains `needle`. */
function lineOf(text, needle, from = 1) {
  const lines = text.split('\n')
  for (let i = from - 1; i < lines.length; i++) if (lines[i].includes(needle)) return i + 1
  throw new Error('no line contains ' + JSON.stringify(needle))
}

/** 1-based number of the last line that is exactly `## <name>` (the fixture's fence holds an earlier `## Plan`). */
function headingLine(text, name) {
  return text.split('\n').lastIndexOf('## ' + name) + 1
}

/** The text with the first line containing `needle` replaced by `replacement` (one or more lines). */
function swap(text, needle, replacement) {
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.includes(needle))
  if (i === -1) throw new Error('no line contains ' + JSON.stringify(needle))
  lines.splice(i, 1, ...replacement.split('\n'))
  return lines.join('\n')
}

const AT_ROOT = { folderId: '.', definedAbove: new Set(), authoredBy: 'you' }

/** Every problem the parse and a root-level check find. */
function problemsOf(text, opts = {}) {
  const spec = parseSpec(text, { file: 'DESIGN.md' })
  return [...spec.problems, ...checkSpec(spec, { ...AT_ROOT, ...opts })]
}

/** Some problem sits on `line`, names DESIGN.md, and says `keyword`. */
function refusedAt(problems, line, keyword) {
  assert.ok(problems.some((p) => p.line === line && p.file === 'DESIGN.md' && keyword.test(p.problem)),
    'expected a problem at line ' + line + ' matching ' + keyword + ', got ' + JSON.stringify(problems))
}

const entry = (spec, name) => spec.entries.find((e) => e.name === name)

test('both fixtures are clean: no parse problem, no check problem', () => {
  assert.deepEqual(problemsOf(ROOT), [])
  const sub = parseSpec(SUB, { file: 'DESIGN.md' })
  assert.deepEqual(sub.problems, [])
  assert.deepEqual(checkSpec(sub, { folderId: 'store-layout', definedAbove: new Set(['D1', 'D2', 'D3']), authoredBy: 'you' }), [])
})

test('the title is the first "# " heading, and every section is found at its line', () => {
  const spec = parseSpec(ROOT, { file: 'DESIGN.md' })
  assert.equal(spec.title, 'A readable design loop')
  assert.equal(spec.file, 'DESIGN.md')
  assert.deepEqual(Object.keys(spec.sections), SECTIONS)
  for (const name of SECTIONS) assert.equal(spec.sections[name].line, headingLine(ROOT, name), name)
  assert.match(spec.sections.Intent.body, /^Specs a person reads/)
  assert.match(spec.sections.Design.body, /### Layout/, 'sub-headings are body text')
})

test('a heading or entry inside a fenced block is prose', () => {
  const spec = parseSpec(ROOT, { file: 'DESIGN.md' })
  assert.equal(spec.sections.Plan.line, lineOf(ROOT, '## Plan', lineOf(ROOT, '```text') + 2))
  assert.ok(spec.sections.Plan.line > lineOf(ROOT, '```text') + 3, 'the fenced "## Plan" is not the section')
  assert.equal(entry(spec, 'fenced'), undefined)
  assert.match(spec.sections.Design.body, /not a heading/)
})

test('Decisions rows parse into id, text and why; the header and separator are not rows', () => {
  const spec = parseSpec(ROOT, { file: 'DESIGN.md' })
  assert.deepEqual(spec.decisions.map((d) => d.id), ['D1', 'D2', 'D3'])
  const d1 = spec.decisions[0]
  assert.equal(d1.text, 'Efforts live in `.agentics/<effort>/`.')
  assert.equal(d1.why, 'Local, and writable by the pipeline.')
  assert.equal(d1.line, lineOf(ROOT, '| D1 |'))
})

test('a pipe escaped inside a cell stays in the cell', () => {
  const text = swap(ROOT, '| D3 |', '| D3 | Use `a \\| b` as the separator. | It reads well. |')
  const d3 = parseSpec(text, { file: 'DESIGN.md' }).decisions[2]
  assert.equal(d3.text, 'Use `a | b` as the separator.')
  assert.equal(d3.why, 'It reads well.')
})

test('open questions carry one grade each; parked names what reopens it; indented lines continue', () => {
  const spec = parseSpec(ROOT, { file: 'DESIGN.md' })
  assert.deepEqual(spec.questions.map((q) => q.grade), ['blocking', 'parked', 'lookup', 'compost'])
  assert.ok(spec.questions.every((q) => GRADES.includes(q.grade)))
  const parked = spec.questions[1]
  assert.equal(parked.reopens, 'store-layout')
  assert.equal(parked.text, 'The exact shape of the ledger.')
  assert.equal(parked.line, lineOf(ROOT, '**parked'))
  const lookup = spec.questions[2]
  assert.match(lookup.text, /^Does git follow renames/)
  assert.match(lookup.text, /It does with -M\./)
  assert.equal(spec.questions[0].reopens, '')
})

test('plan entries parse name, kind, line, title and context', () => {
  const spec = parseSpec(ROOT, { file: 'DESIGN.md' })
  assert.deepEqual(spec.entries.map((e) => [e.name, e.kind]),
    [['store-layout', 'sub-effort'], ['spec-parser', 'task'], ['planner-part', 'sub-effort'], ['later', 'deferred'], ['old-idea', 'dropped']])
  assert.ok(spec.entries.every((e) => ENTRY_KINDS.includes(e.kind)))
  const layout = entry(spec, 'store-layout')
  assert.equal(layout.line, lineOf(ROOT, '**store-layout**'))
  assert.equal(layout.title, 'Put every path under .agentics')
  assert.equal(layout.context, 'The store computes every path; nothing else types one.')
  const parser = entry(spec, 'spec-parser')
  assert.equal(parser.title, 'Write the parser\'s tests')
  assert.match(parser.context, /^Each refusal names its line\.\n+A second paragraph of context\.$/)
})

test('fields parse to their types, wrapped "·" lines included', () => {
  const spec = parseSpec(ROOT, { file: 'DESIGN.md' })
  const layout = entry(spec, 'store-layout')
  assert.deepEqual(layout.realises, ['D1'])
  assert.deepEqual(layout.provides, [{ name: 'store-paths', paths: ['lib/store.mjs', 'lib/effort.mjs'] }])
  assert.equal(layout.author, 'you', 'author defaults to you')
  assert.deepEqual(layout.given, ['realises', 'provides'])

  const parser = entry(spec, 'spec-parser')
  assert.deepEqual(parser.realises, ['D2', 'D3'])
  assert.deepEqual(parser.after, ['store-layout'])
  assert.equal(parser.rigor, 'tdd-pair')
  assert.equal(parser.role, 'red')
  assert.deepEqual(parser.expects, ['test/spec.test.mjs'])
  assert.deepEqual(parser.reads, ['lib/store.mjs'], 'backticks around a value are not part of it')
  assert.deepEqual(parser.consumes, [{ name: 'store-paths' }])
  assert.deepEqual(parser.dispatch, { producer: { model: 'sonnet', effort: 'medium' }, reviewer: { model: 'opus', effort: 'medium' } })
  assert.deepEqual(parser.ground, ['docs/DESIGN.md#storage'])
  assert.deepEqual(parser.given, ['realises', 'after', 'rigor', 'role', 'expects', 'reads', 'consumes', 'dispatch', 'ground'])
  for (const e of spec.entries) for (const key of e.given) assert.ok(ENTRY_KEYS.includes(key), key)

  const planner = entry(spec, 'planner-part')
  assert.equal(planner.author, 'planner')
  assert.deepEqual(planner.after, ['spec-parser', '/store-layout'])
  assert.deepEqual(planner.shared, ['package.json'])

  const paths = entry(parseSpec(SUB, { file: 'DESIGN.md' }), 'paths')
  assert.deepEqual(paths.expects, ['lib/store.mjs', 'test/store.test.mjs'])
})

test('criteria carry their check; a HUMAN: criterion keeps its prefix and has no check', () => {
  const parser = entry(parseSpec(ROOT, { file: 'DESIGN.md' }), 'spec-parser')
  assert.equal(parser.criteria.length, 2)
  const [checked, human] = parser.criteria
  assert.equal(checked.text, 'every refusal names a line')
  assert.equal(checked.check, 'node --test test/spec.test.mjs')
  assert.equal(checked.line, lineOf(ROOT, 'every refusal names a line'))
  assert.equal(human.text, 'HUMAN: the messages read well')
  assert.equal(human.check, '')
})

test('CRLF input parses exactly as LF input does, and hashes the same', () => {
  const crlf = ROOT.replace(/\n/g, '\r\n')
  assert.deepEqual(parseSpec(crlf, { file: 'DESIGN.md' }), parseSpec(ROOT, { file: 'DESIGN.md' }))
  assert.equal(hashSpec(crlf), hashSpec(ROOT))
})

test('a byte-order mark changes neither the parse nor the hash', () => {
  const bom = '﻿' + ROOT
  assert.deepEqual(parseSpec(bom, { file: 'DESIGN.md' }), parseSpec(ROOT, { file: 'DESIGN.md' }))
  assert.equal(hashSpec(bom), hashSpec(ROOT))
})

test('the hash is fnv1a over the canonical LF text, and one changed word changes it', () => {
  assert.equal(hashSpec(ROOT), fnv1a(canonical(ROOT)))
  assert.notEqual(hashSpec(ROOT.replace('Local, and writable', 'Local and writable')), hashSpec(ROOT))
})

// ------------------------------------------------------------------ parse refusals

test('a spec with no title is refused at line 1', () => {
  refusedAt(problemsOf(swap(ROOT, '# A readable design loop', 'A readable design loop')), 1, /title/)
})

test('an unknown section is refused at its heading', () => {
  const text = swap(ROOT, '## Evidence', '## Approaches\n\nTwo drafts.\n\n## Evidence')
  refusedAt(problemsOf(text), lineOf(text, '## Approaches'), /section/)
})

test('a second section of the same name is refused at the second heading', () => {
  const text = swap(ROOT, '## Evidence', '## Evidence\n\nOne.\n\n## Evidence')
  refusedAt(problemsOf(text), lineOf(text, '## Evidence', lineOf(text, '## Evidence') + 1), /second|twice|duplicate/)
})

test('a section out of order is refused at a heading of the pair that is out of order', () => {
  const evidence = ROOT.slice(ROOT.indexOf('## Evidence')).trimEnd()
  const text = ROOT.slice(0, ROOT.indexOf('## Evidence')).replace('## Design', evidence + '\n\n## Design')
  const lines = [headingLine(text, 'Evidence'), headingLine(text, 'Design')]
  assert.ok(problemsOf(text).some((p) => lines.includes(p.line) && /order/.test(p.problem)), JSON.stringify(problemsOf(text)))
})

test('a missing section is refused at line 1, naming it', () => {
  const text = ROOT.slice(0, ROOT.indexOf('## Evidence'))
  refusedAt(problemsOf(text), 1, /Evidence/)
})

test('a Decisions row that is not three cells is refused at its line', () => {
  const text = swap(ROOT, '| D3 |', '| D3 | The parser refuses. |')
  refusedAt(problemsOf(text), lineOf(text, '| D3 |'), /cell|column/)
})

test('a decision with no id, no text or no why is refused at its line', () => {
  for (const row of ['|  | Something. | Because. |', '| D3 |  | Because. |', '| D3 | Something. |  |']) {
    const text = swap(ROOT, '| D3 |', row)
    refusedAt(problemsOf(text), lineOf(text, row), /id|text|why/)
  }
})

test('an unknown grade is refused at its line', () => {
  const text = swap(ROOT, '- **compost:**', '- **someday:** Publishing specs as docs.')
  refusedAt(problemsOf(text), lineOf(text, '**someday:**'), /grade/)
})

test('a parked question that names nothing to reopen it is refused at its line', () => {
  const text = swap(ROOT, '- **parked (reopens at store-layout):**', '- **parked:** The exact shape of the ledger.')
  refusedAt(problemsOf(text), lineOf(text, '- **parked:**'), /reopens/)
})

test('a bullet under Open questions without a grade is refused at its line', () => {
  const text = swap(ROOT, '- **compost:**', '- Publishing specs as docs.')
  refusedAt(problemsOf(text), lineOf(text, '- Publishing specs'), /grade/)
})

test('an entry whose name is not followed by " — " is refused at its line', () => {
  for (const dash of [' - ', ' – ', '—']) {
    const text = swap(ROOT, '- **later** —', '- **later**' + dash + 'deferred · realises: D2')
    refusedAt(problemsOf(text), lineOf(text, '- **later**'), /separator|—/)
  }
})

test('an unknown kind is refused at its entry line', () => {
  const text = swap(ROOT, '- **later** —', '- **later** — epic · realises: D2')
  refusedAt(problemsOf(text), lineOf(text, '- **later**'), /kind/)
})

test('an unknown key is refused at the line it is written on, a wrapped line included', () => {
  const text = swap(ROOT, '· shared: package.json', '  · owner: me')
  refusedAt(problemsOf(text), lineOf(text, '· owner: me'), /key/)
})

test('a key written twice on one entry is refused at the second line', () => {
  const text = swap(ROOT, '· shared: package.json', '  · after: store-layout')
  refusedAt(problemsOf(text), lineOf(text, '  · after: store-layout'), /twice|duplicate|again/)
})

test('a field without "key: value" is refused at its line', () => {
  const text = swap(ROOT, '· shared: package.json', '  · shared package.json')
  refusedAt(problemsOf(text), lineOf(text, '· shared package.json'), /key: value|field/)
})

test('an author other than you or planner is refused at its line', () => {
  const text = swap(ROOT, '· shared: package.json', '  · author: someone')
  const withOne = text.replace(' · author: planner', '')
  refusedAt(problemsOf(withOne), lineOf(withOne, '· author: someone'), /author/)
})

test('a provided contract without its paths is refused at its line', () => {
  const text = swap(ROOT, '- **store-layout** —', '- **store-layout** — sub-effort · realises: D1 · provides: store-paths')
  refusedAt(problemsOf(text), lineOf(text, '- **store-layout**'), /provide|path/)
})

test('a dispatch that is not stage=model/effort is refused at its line', () => {
  for (const bad of ['producer=sonnet', 'builder=sonnet/low', 'producer=sonnet/medium reviewer=opus/low']) {
    const text = swap(ROOT, '· consumes: store-paths · dispatch:', '  · consumes: store-paths · dispatch: ' + bad)
    refusedAt(problemsOf(text), lineOf(text, '· dispatch: ' + bad), /dispatch/)
  }
})

test('an entry with no title line is refused at the entry', () => {
  const text = swap(ROOT, '  Export specs later', '')
  refusedAt(problemsOf(text), lineOf(text, '- **later**'), /title/)
})

test('a criterion with no check and no HUMAN: is refused at its line', () => {
  const text = swap(ROOT, '- [ ] every refusal names a line', '  - [ ] every refusal names a line')
  refusedAt(problemsOf(text), lineOf(text, '- [ ] every refusal names a line'), /check/)
})

test('a checked-off criterion is refused at its line: status is never written into a spec', () => {
  const text = swap(ROOT, '- [ ] HUMAN: the messages read well', '  - [x] HUMAN: the messages read well')
  refusedAt(problemsOf(text), lineOf(text, '- [x]'), /status|checked/)
})

test('a column-0 bullet in the Plan that is not an entry is refused at its line', () => {
  const text = swap(ROOT, '- **later** —', '- later: export specs\n- **later** — deferred · realises: D2')
  refusedAt(problemsOf(text), lineOf(text, '- later: export specs'), /entry/)
})

// ------------------------------------------------------------------ check refusals

test('below the root, a decision id carries the folder\'s prefix; the root\'s carries none', () => {
  const at = { folderId: 'store-layout', definedAbove: new Set(['D1', 'D2', 'D3']), authoredBy: 'you' }
  const unprefixed = swap(SUB, '| store-layout.D1 |', '| D4 | Paths resolve from the main checkout. | Because. |')
  refusedAt(checkSpec(parseSpec(unprefixed, { file: 'DESIGN.md' }), at), lineOf(unprefixed, '| D4 |'), /store-layout\.D/)

  const nested = checkSpec(parseSpec(SUB, { file: 'DESIGN.md' }), { ...at, folderId: 'a/store-layout' })
  refusedAt(nested, lineOf(SUB, '| store-layout.D1 |'), /a\.store-layout\.D/)

  const prefixed = swap(ROOT, '| D3 |', '| store-layout.D3 | The parser refuses. | A person fixes it. |')
  refusedAt(problemsOf(prefixed), lineOf(prefixed, '| store-layout.D3 |'), /D<n>|prefix|id/)
})

test('a decision id defined twice is refused at the second row', () => {
  const text = swap(ROOT, '| D3 |', '| D2 | Again. | Because. |')
  refusedAt(problemsOf(text), lineOf(text, '| D2 | Again.'), /twice|already|duplicate/)
})

test('realising an id neither this spec nor an ancestor defines is refused at the entry', () => {
  const text = swap(ROOT, '- **later** —', '- **later** — deferred · realises: D9')
  refusedAt(problemsOf(text), lineOf(text, '- **later**'), /D9/)
  const sub = parseSpec(SUB, { file: 'DESIGN.md' })
  const alone = checkSpec(sub, { folderId: 'store-layout', definedAbove: new Set(), authoredBy: 'you' })
  refusedAt(alone, lineOf(SUB, '- **paths**'), /D1/)
})

test('"after" must name a sibling, never the entry itself; a /path must be a valid id', () => {
  const ghost = swap(ROOT, '- **later** —', '- **later** — deferred · realises: D2 · after: ghost')
  refusedAt(problemsOf(ghost), lineOf(ghost, '- **later**'), /ghost/)
  const self = swap(ROOT, '- **later** —', '- **later** — deferred · realises: D2 · after: later')
  refusedAt(problemsOf(self), lineOf(self, '- **later**'), /itself/)
  const badPath = swap(ROOT, '- **later** —', '- **later** — deferred · realises: D2 · after: /Store_Layout')
  refusedAt(problemsOf(badPath), lineOf(badPath, '- **later**'), /Store_Layout/)
})

test('a name that breaks the segment rule, or repeats a sibling\'s, is refused at its entry', () => {
  const bad = swap(ROOT, '- **later** —', '- **Later_on** — deferred · realises: D2')
  refusedAt(problemsOf(bad), lineOf(bad, '- **Later_on**'), /segment|name/)
  const twice = swap(ROOT, '- **old-idea** —', '- **later** — dropped · realises: D2')
  refusedAt(problemsOf(twice), lineOf(twice, '- **later** — dropped'), /later/)
})

test('task-only keys and criteria on a sub-effort are refused', () => {
  const text = swap(ROOT, '· shared: package.json', '  · shared: package.json · rigor: tdd · expects: src/a.js\n  Let the planner write this part\n  - [ ] it works — check: `node --test`')
    .replace('\n  Let the planner write this part\n- **later**', '\n- **later**')
  const problems = problemsOf(text)
  refusedAt(problems, lineOf(text, '- **planner-part**'), /rigor|expects|task/)
  refusedAt(problems, lineOf(text, '- [ ] it works'), /criteri|task/)
})

test('author and shared on a task are refused at its entry', () => {
  const text = swap(ROOT, '  · expects: test/spec.test.mjs', '  · expects: test/spec.test.mjs · author: planner · shared: package.json')
  refusedAt(problemsOf(text), lineOf(text, '- **spec-parser**'), /author/)
  refusedAt(problemsOf(text), lineOf(text, '- **spec-parser**'), /shared/)
})

test('a task with no criterion is refused at its entry', () => {
  const text = swap(swap(ROOT, '- [ ] every refusal names a line', ''), '- [ ] HUMAN: the messages read well', '')
  refusedAt(problemsOf(text), lineOf(text, '- **spec-parser**'), /criteri/)
})

test('a planner-written spec with a Decisions row is refused at the row', () => {
  refusedAt(problemsOf(ROOT, { authoredBy: 'planner' }), lineOf(ROOT, '| D1 |'), /planner|decision/)
})

test('a consumed contract no entry of the effort provides is refused, when the effort\'s contracts are known', () => {
  const text = swap(ROOT, '  · consumes: store-paths', '  · consumes: store-paths, ghost-api')
  assert.deepEqual(problemsOf(text).filter((p) => /ghost-api/.test(p.problem)), [], 'unknown without the effort\'s contracts')
  refusedAt(problemsOf(text, { contracts: new Set(['other-api']) }), lineOf(text, '- **spec-parser**'), /ghost-api/)
  assert.deepEqual(problemsOf(ROOT, { contracts: new Set() }), [], 'a contract this spec provides resolves')
})

// ------------------------------------------------------------------ in the effort

function effortOnDisk(files) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-spec-'))
  for (const [id, text] of Object.entries(files)) {
    mkdirSync(dirname(specPath(repo, 'e1', id)), { recursive: true })
    writeFileSync(specPath(repo, 'e1', id), text)
  }
  return repo
}

const cli = (...args) => JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }))

test('checkFolder reads the ancestors\' decisions and the parent entry\'s author', () => {
  const repo = effortOnDisk({ '.': ROOT, 'store-layout': SUB })
  const out = checkFolder(repo, 'e1', 'store-layout')
  assert.equal(out.exists, true)
  assert.deepEqual(out.problems, [])
  assert.equal(out.authoredBy, 'you')
  assert.equal(out.entry.name, 'store-layout')
  assert.equal(out.hash, hashSpec(SUB))
  assert.match(out.file, /store-layout\/DESIGN\.md$/)
  assert.equal(out.spec.title, 'Store layout')
})

test('checkFolder takes planner authorship from the parent entry, and refuses a planner spec\'s decisions', () => {
  const planned = SUB.replace(/store-layout\.D1/g, 'planner-part.D1').replace('# Store layout', '# Planner part')
  const repo = effortOnDisk({ '.': ROOT, 'planner-part': planned })
  const out = checkFolder(repo, 'e1', 'planner-part')
  assert.equal(out.authoredBy, 'planner')
  assert.ok(out.problems.some((p) => p.line === lineOf(planned, '| planner-part.D1 |') && /planner|decision/.test(p.problem)))
})

test('a folder holding a task\'s own spec is a promoted task, written by the planner', () => {
  const promoted = SUB.replace(/\| store-layout\.D1 .*\n/, '').replace(', store-layout.D1', '').replace('# Store layout', '# Spec parser')
  const repo = effortOnDisk({ '.': ROOT, 'spec-parser': promoted })
  const out = checkFolder(repo, 'e1', 'spec-parser')
  assert.equal(out.authoredBy, 'planner')
  assert.equal(out.entry.kind, 'task')
})

test('a folder no entry of its parent names is refused, and a missing spec is one problem at line 0', () => {
  const repo = effortOnDisk({ '.': ROOT, stray: SUB.replace(/store-layout\./g, 'stray.') })
  assert.ok(checkFolder(repo, 'e1', 'stray').problems.some((p) => /entry/.test(p.problem)))
  const missing = checkFolder(repo, 'e1', 'store-layout')
  assert.equal(missing.exists, false)
  assert.equal(missing.problems.length, 1)
  assert.equal(missing.problems[0].line, 0)
})

test('checkFolder checks consumed contracts against every provider in the effort', () => {
  const consumer = swap(SUB, '  · provides: store-api (lib/store.mjs)', '  · provides: store-api (lib/store.mjs) · consumes: store-paths, ghost-api')
  const repo = effortOnDisk({ '.': ROOT, 'store-layout': consumer })
  const problems = checkFolder(repo, 'e1', 'store-layout').problems
  assert.ok(problems.some((p) => /ghost-api/.test(p.problem)))
  assert.ok(!problems.some((p) => /store-paths/.test(p.problem)), 'store-paths is provided by the root spec')
})

test('checkFolder refuses a decision no entry of the spec realises, at its Decisions row', () => {
  const d3 = ROOT.split('\n')[lineOf(ROOT, '| D3 |') - 1]
  const unrealised = swap(ROOT, '| D3 |', d3 + '\n| D4 | Specs export as docs. | Readers asked for it. |')
  const problemsAt = (text) => checkFolder(effortOnDisk({ '.': text }), 'e1', '.').problems
  const about = (problems) => problems.filter((p) => /D4/.test(p.problem))

  const refused = about(problemsAt(unrealised))
  assert.ok(refused.some((p) => p.line === lineOf(unrealised, '| D4 |') && /DESIGN\.md$/.test(p.file)), JSON.stringify(refused))
  assert.notDeepEqual(about(problemsAt(unrealised.replace('deferred · realises: D2', 'deferred · realises: D2, D4'))), [],
    'a deferred entry realises nothing yet')
  for (const [from, to] of [
    ['sub-effort · realises: D3', 'sub-effort · realises: D3, D4'],
    ['task · realises: D2, D3', 'task · realises: D2, D3, D4'],
    ['dropped · realises: D2', 'dropped · realises: D2, D4'],
  ]) {
    const text = unrealised.replace(from, to)
    assert.notEqual(text, unrealised, from)
    assert.deepEqual(about(problemsAt(text)), [], to + ' realises D4')
  }
})

test('checkFolder refuses a task whose node compile would refuse: no rigor, an unknown rigor, a role that does not fit its rigor (I3); a task with no expects is fine', () => {
  const at = (text) => effortOnDisk({ '.': ROOT, 'store-layout': text })
  const line = (text) => lineOf(text, '**paths**')
  const refusedAtLine = (problems, at, keyword) => assert.ok(
    problems.some((p) => p.line === at && keyword.test(p.problem)),
    'expected a problem at line ' + at + ' matching ' + keyword + ', got ' + JSON.stringify(problems))

  const noRigor = SUB.replace('rigor: tdd · ', '')
  refusedAtLine(checkFolder(at(noRigor), 'e1', 'store-layout').problems, line(noRigor), /rigor/)

  const badRigor = SUB.replace('rigor: tdd', 'rigor: fancy')
  refusedAtLine(checkFolder(at(badRigor), 'e1', 'store-layout').problems, line(badRigor), /rigor/)

  const noExpects = SUB.replace(' · expects: lib/store.mjs, test/store.test.mjs', '')
  assert.deepEqual(checkFolder(at(noExpects), 'e1', 'store-layout').problems, [], 'expects is a hint: a task may leave it out')

  const wrongRole = SUB.replace('rigor: tdd', 'rigor: tdd · role: green')
  refusedAtLine(checkFolder(at(wrongRole), 'e1', 'store-layout').problems, line(wrongRole), /role/)

  assert.deepEqual(checkFolder(at(SUB), 'e1', 'store-layout').problems, [], 'the unmutated fixture stays clean')
})

test('the CLI prints {folder, problems} under its digest, and exits 0 even with problems', () => {
  const repo = effortOnDisk({ '.': ROOT, 'store-layout': swap(SUB, '| store-layout.D1 |', '| D4 | x | y |') })
  const clean = cli('check', '--repo', repo, '--effort', 'e1', '--folder', '.')
  assert.equal(clean.payload.folder, '.')
  assert.deepEqual(clean.payload.problems, [])
  assert.equal(clean.payload_digest, fnv1a(canonical(clean.payload)))

  const dirty = cli('check', '--repo', repo, '--effort', 'e1', '--folder', 'store-layout')
  assert.equal(dirty.payload.folder, 'store-layout')
  assert.ok(dirty.payload.problems.some((p) => p.line > 0 && /store-layout\/DESIGN\.md$/.test(p.file)))
})

// ------------------------------------------------------------------ groups

const GROUP = [
  '### checks — group · after: store-layout',
  'Check specs where they sit',
  'One subsystem, reviewed together.',
  '',
  '- **lint-a** — task · realises: D2 · rigor: trivial · expects: lib/a.mjs',
  '  Lint the first half',
  '  - [ ] a lints — check: `node --test`',
  '- **lint-b** — task · realises: D2 · after: lint-a, planner-part · rigor: trivial · expects: lib/b.mjs',
  '  Lint the second half',
  '  - [ ] b lints — check: `node --test`',
  '',
].join('\n')
const GROUPED = ROOT.replace('\n## Open questions', '\n' + GROUP + '\n## Open questions')

test('a group heading opens a group: its prose is its title and context, and the entries under it belong to it', () => {
  const spec = parseSpec(GROUPED, { file: 'DESIGN.md' })
  assert.deepEqual(spec.problems, [])
  assert.deepEqual(checkSpec(spec, AT_ROOT), [])
  assert.deepEqual(spec.groups, [{
    name: 'checks', line: lineOf(GROUPED, '### checks'), title: 'Check specs where they sit',
    context: 'One subsystem, reviewed together.', after: ['store-layout'],
  }])
  assert.equal(entry(spec, 'lint-a').group, 'checks')
  assert.equal(entry(spec, 'lint-b').group, 'checks')
  assert.equal(entry(spec, 'old-idea').group, '', 'an entry above the first group belongs to the folder')
  assert.equal(entryId('.', entry(spec, 'lint-a')), 'checks/lint-a')
  assert.equal(entryId('sub', entry(spec, 'spec-parser')), 'sub/spec-parser')
})

test('a group is refused when its heading is not a group, it carries a field other than after, or it holds no task', () => {
  const heading = swap(GROUPED, '### checks', '### Checks and more')
  refusedAt(problemsOf(heading), lineOf(heading, '### Checks'), /opens a group/)
  const field = swap(GROUPED, '### checks', '### checks — group · realises: D2')
  refusedAt(problemsOf(field), lineOf(field, '### checks'), /only after/)
  const empty = GROUPED.replace(/- \*\*lint-a\*\* — task/, '- **lint-a** — deferred').replace(/- \*\*lint-b\*\* — task/, '- **lint-b** — dropped')
    .replace(/ · rigor: trivial · expects: lib\/[ab]\.mjs/g, '').replace(/ {2}- \[ \] [ab] lints.*\n/g, '')
  refusedAt(problemsOf(empty), lineOf(empty, '### checks'), /holds no task/)
})

test('a group holds no sub-effort, shares one namespace with the entries, and never waits on itself', () => {
  const sub = swap(GROUPED, '- **lint-a**', '- **lint-a** — sub-effort · realises: D2').replace(' · rigor: trivial · expects: lib/a.mjs', '').replace(/ {2}- \[ \] a lints.*\n/, '')
  refusedAt(problemsOf(sub), lineOf(sub, '- **lint-a**'), /a group holds tasks/)
  const clash = swap(GROUPED, '### checks', '### later — group')
  refusedAt(problemsOf(clash), lineOf(clash, '- **later**'), /named later/)
  const own = GROUPED.replace('after: lint-a, planner-part', 'after: checks')
  refusedAt(problemsOf(own), lineOf(own, '- **lint-b**'), /its own group/)
  const onGroup = ROOT.replace('after: spec-parser, /store-layout', 'after: checks')
  refusedAt(problemsOf(onGroup), lineOf(onGroup, '- **planner-part**'), /no entry or group/)
  assert.deepEqual(problemsOf(GROUPED.replace('after: spec-parser, /store-layout', 'after: checks')), [], 'an entry may wait for a group')
})

test('a task promoted inside a group is found in the grandparent\'s plan, through the group', () => {
  const promoted = SUB.replace(/\| store-layout\.D1 .*\n/, '').replace(', store-layout.D1', '').replace('# Store layout', '# Lint a')
  const repo = effortOnDisk({ '.': GROUPED, 'checks/lint-a': promoted })
  const out = checkFolder(repo, 'e1', 'checks/lint-a')
  assert.equal(out.authoredBy, 'planner')
  assert.equal(out.entry.name, 'lint-a')
  assert.ok(!out.problems.some((p) => /ancestor|entry of the parent/.test(p.problem)), JSON.stringify(out.problems))
})

test('group prose may be indented, a group may not wait for its own task, and a deeper heading in the Plan is refused', () => {
  const indented = swap(GROUPED, 'One subsystem, reviewed together.', '  One subsystem, reviewed together.')
  assert.equal(parseSpec(indented, { file: 'DESIGN.md' }).groups[0].context, 'One subsystem, reviewed together.')
  const own = swap(GROUPED, '### checks', '### checks — group · after: lint-a')
  refusedAt(problemsOf(own), lineOf(own, '### checks'), /a task inside it/)
  const deeper = swap(GROUPED, '### checks', '#### checks — group')
  refusedAt(problemsOf(deeper), lineOf(deeper, '#### checks'), /opens a group/)
})

test('the spec CLI refuses a value that is not a handle, and a flag it does not take', () => {
  const refusal = (...args) => {
    try {
      execFileSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NODE_TEST_CONTEXT: '' }, timeout: 30_000,
      })
      return [0, '']
    } catch (err) {
      return [err.status, JSON.parse(err.stdout).kind]
    }
  }
  assert.deepEqual(refusal('check', '--repo', '.', '--effort', 'e1', '--folder', 'a\nb'), [1, 'args_unreadable'])
  assert.deepEqual(refusal('check', '--repo', '.', '--effort', 'e1', '--file', 'DESIGN.md'), [1, 'unknown_flag'])
})

test('a task that still writes locus is refused, naming the migration', () => {
  const old = SUB.replace(' · expects: ', ' · locus: ')
  const problems = checkFolder(effortOnDisk({ '.': ROOT, 'store-layout': old }), 'e1', 'store-layout').problems
  assert.ok(problems.some((p) => p.line === lineOf(old, '**paths**') && /migrate-expects/.test(p.problem)), JSON.stringify(problems))
})
