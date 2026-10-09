// test/evidence-inprocess-probe.test.mjs — the probe's evidence called in-process: an artefact's
// sections, a probe's units, the findings a narrowed round carries as handles, and a round recorded
// from return objects with every unit's ruling.
//
// Design: docs/DESIGN.md#probe.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'

import { carriedFindings, recordProbe, reviewScope, sectionsOf, unitsOf } from '../lib/evidence.mjs'
import { gitRepo, lines, returnFile, text, withLine, write } from './harness/evidence-fixture.mjs'

/** The fields a section is read by. */
const shape = (sections) => sections.map(({ slug, title, start, end }) => ({ slug, title, start, end }))
/** The 1-based line `line` sits on in `doc`. */
const at = (doc, line) => doc.indexOf(line) + 1

// ------------------------------------------------------------------ sectionsOf

test('an artefact\'s sections are its ## headings, each running to the line before the next, the last to the last line', () => {
  const doc = ['## Context', 'why', '## Design', 'how', 'end']
  assert.deepEqual(shape(sectionsOf(text(doc))), [
    { slug: 'context', title: 'Context', start: at(doc, '## Context'), end: at(doc, '## Design') - 1 },
    { slug: 'design', title: 'Design', start: at(doc, '## Design'), end: doc.length },
  ])
})

test('a ### heading belongs to the ## section above it', () => {
  const doc = ['## Design', 'how', '### Detail', 'more', '## Risks', 'none']
  assert.deepEqual(sectionsOf(text(doc)).map((s) => [s.slug, s.end]), [['design', at(doc, '## Risks') - 1], ['risks', doc.length]])
})

test('a ## line inside a fenced block is no heading', () => {
  const doc = ['## Design', '```md', '~~~', '## not a heading', '```', '~~~', '~~~ text', '## nor this', '~~~', '````', '```', '## still inside', '````', 'after']
  assert.deepEqual(shape(sectionsOf(text(doc))), [{ slug: 'design', title: 'Design', start: 1, end: doc.length }])
})

test('a backtick line whose info string holds a backtick opens no fence', () => {
  const doc = ['## Design', '```not`a fence', '## Risks', 'none']
  assert.deepEqual(shape(sectionsOf(text(doc))), [
    { slug: 'design', title: 'Design', start: 1, end: at(doc, '## Risks') - 1 },
    { slug: 'risks', title: 'Risks', start: at(doc, '## Risks'), end: doc.length },
  ])
})

test('a tilde fence may hold a backtick in its info string', () => {
  const doc = ['## Design', '~~~ a`b', '## not a heading', '~~~', 'after']
  assert.deepEqual(shape(sectionsOf(text(doc))), [{ slug: 'design', title: 'Design', start: 1, end: doc.length }])
})

test("a heading's closing # run is not part of its title; a # glued to the text is", () => {
  const doc = ['## Design ##', 'how', '## Risks #  ', 'x', '## C#', 'y', '## ##', 'z']
  assert.deepEqual(sectionsOf(text(doc)).map((s) => s.title), ['Design', 'Risks', 'C#', ''])
})

test('text before the first heading other than blank lines and a # title is the preamble', () => {
  const doc = ['# Title', '', 'An opening paragraph.', '', '## Design', 'how']
  assert.deepEqual(shape(sectionsOf(text(doc))), [
    { slug: 'preamble', title: '', start: 1, end: at(doc, '## Design') - 1 },
    { slug: 'design', title: 'Design', start: at(doc, '## Design'), end: doc.length },
  ])
})

test('a title and blank lines before the first heading make no preamble', () => {
  const doc = ['# Title', '', '', '## Design', 'how']
  assert.deepEqual(sectionsOf(text(doc)).map((s) => s.slug), ['design'])
})

test('an artefact with no ## heading is one document section spanning it', () => {
  const doc = ['# Title', 'just prose', '### a minor heading', 'more']
  assert.deepEqual(shape(sectionsOf(text(doc))), [{ slug: 'document', title: '', start: 1, end: doc.length }])
})

test('an empty artefact is still one section, so its units are never none', () => {
  assert.deepEqual(sectionsOf('').map((s) => s.slug), ['document'])
  assert.equal(unitsOf(['yagni'], sectionsOf('')).length, 1)
})

test('a repeated slug takes -2, then -3', () => {
  const doc = ['## Open questions', 'a', '## Open Questions', 'b', '## open-questions', 'c']
  assert.deepEqual(sectionsOf(text(doc)).map((s) => s.slug), ['open-questions', 'open-questions-2', 'open-questions-3'])
})

test('a heading with no ASCII letter or digit is a section named section', () => {
  const doc = ['## Überblick', 'a', '## 设计', 'b', '## —', 'c', '##', 'd', '## Section', 'e']
  assert.deepEqual(sectionsOf(text(doc)).map((s) => [s.slug, s.title]),
    [['berblick', 'Überblick'], ['section', '设计'], ['section-2', '—'], ['section-3', ''], ['section-4', 'Section']])
  assert.deepEqual(unitsOf(['yagni'], sectionsOf(text(['## 设计', 'b']))), ['yagni@section'])
})

test('CRLF endings and a missing final newline give the same sections', () => {
  const doc = ['# Title', 'intro', '## Design', 'how', '## Risks', 'none']
  const lf = sectionsOf(text(doc))
  assert.deepEqual(sectionsOf(text(doc, '\r\n')), lf)
  assert.deepEqual(sectionsOf(doc.join('\n')), lf)
})

// ------------------------------------------------------------------ unitsOf

test('a probe\'s units are every axis against every section, axis order outer', () => {
  const sections = sectionsOf(text(['## A', 'x', '## B', 'y']))
  assert.deepEqual(unitsOf(['yagni', 'invariants'], sections), ['yagni@a', 'yagni@b', 'invariants@a', 'invariants@b'])
})

// ------------------------------------------------------------------ carriedFindings and recordProbe

const SPEC = '.agentics/e1/DESIGN.md'
const SPEC_LINES = 12

/** A repository with a gitignored 12-line spec, removed when the test ends. */
function specRepo(t) {
  const repo = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  write(repo, SPEC, text(lines(SPEC_LINES, 'spec')))
  return repo
}

const finding = (over) => ({ axis: 'yagni', severity: 'gap', section: 'Design / Contracts', claim: 'c', evidence: 'e', start: 2, end: 3, ...over })

test('carried items become finding handles numbered from P1, in the order the scope carries them', (t) => {
  const repo = specRepo(t)
  const { snapshot } = reviewScope(repo, SPEC)
  recordProbe(repo, {
    file: SPEC, snapshot, bundle: ['yagni'],
    from: [{ findings: [finding({ claim: 'kept', start: 6, end: 7 }), finding({ severity: 'ambiguity', claim: 'also kept', start: 9, end: 10 })] }],
  })
  write(repo, SPEC, text(withLine(lines(SPEC_LINES, 'spec'), 2, 'edited')))
  const scope = reviewScope(repo, SPEC, snapshot)
  const handles = carriedFindings(scope)
  assert.deepEqual(handles.map((f) => [f.id, f.item, f.carried]), scope.carried.map((it, i) => ['P' + (i + 1), it.id, true]))
  assert.deepEqual(handles.map((f) => f.severity).sort(), ['ambiguity', 'gap'])
  assert.deepEqual(handles.map((f) => f.axis), ['yagni', 'yagni'])
  assert.equal(handles.length, 2)
})

test('a scope that carries nothing gives no findings', (t) => {
  const repo = specRepo(t)
  assert.deepEqual(carriedFindings(reviewScope(repo, SPEC)), [])
})

test('a probe round recorded from return objects records what its files would', (t) => {
  const repo = specRepo(t)
  const { snapshot } = reviewScope(repo, SPEC)
  const ret = { findings: [finding({ claim: 'one' }), finding({ axis: 'other', claim: 'two', start: 5, end: 99 })] }
  const byFile = recordProbe(repo, { file: SPEC, snapshot, from: [returnFile(repo, ret)], bundle: ['yagni+invariants'] })
  const byObject = recordProbe(repo, { file: SPEC, snapshot, from: [ret], bundle: ['yagni+invariants'] })
  assert.deepEqual([byFile.recorded, byObject.recorded], [true, true])
  assert.equal(byObject.findings.length, ret.findings.length)
  assert.deepEqual(byObject.findings, byFile.findings, 'the same handles, under the same item ids')
  assert.equal(readFileSync(byObject.findings_file, 'utf8'), readFileSync(byFile.findings_file, 'utf8'))
})

test('every unit\'s ruling is written into the findings file beside the findings, as {unit, ruling, why}', (t) => {
  const repo = specRepo(t)
  const { snapshot } = reviewScope(repo, SPEC)
  const units = [
    { unit: 'yagni@design', ruling: 'findings', ids: ['F1'], why: 'one gap' },
    { unit: 'yagni@context', ruling: 'clean', ids: [], why: 'nothing speculative' },
  ]
  const out = recordProbe(repo, { file: SPEC, snapshot, from: [{ findings: [finding()] }], bundle: ['yagni'], units })
  const written = JSON.parse(readFileSync(out.findings_file, 'utf8'))
  assert.deepEqual(written.units, units.map(({ unit, ruling, why }) => ({ unit, ruling, why })))
  assert.deepEqual(written.findings.map((f) => f.id), out.findings.map((f) => f.id))
})

test('a round given no units writes an empty list beside the findings', (t) => {
  const repo = specRepo(t)
  const { snapshot } = reviewScope(repo, SPEC)
  const out = recordProbe(repo, { file: SPEC, snapshot, from: [returnFile(repo, { findings: [finding()] })], bundle: ['yagni'] })
  assert.equal(out.recorded, true)
  const written = JSON.parse(readFileSync(out.findings_file, 'utf8'))
  assert.deepEqual([written.units, written.findings.map((f) => f.id)], [[], ['P1']])
})

test('a round mixing a return object and an unreadable file reads the object and names the file unread', (t) => {
  const repo = specRepo(t)
  const out = recordProbe(repo, { file: SPEC, snapshot: '', from: [{ findings: [finding()] }, '/gone.json'], bundle: ['yagni', 'ambiguity'] })
  assert.deepEqual(out.unread, [1])
  assert.deepEqual(out.findings.map((f) => [f.id, f.axis]), [['P1', 'yagni']])
})
