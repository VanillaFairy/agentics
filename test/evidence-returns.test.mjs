// test/evidence-returns.test.mjs — what the store makes of the files its agents write: a survey's
// judges, a probe's analysts, a solutions sweep's assessor and scout, and the one file a survey's
// reader opens afterwards.
//
// Design: docs/DESIGN.md#gp6--couriers-carry-handles-data-stays-where-its-author-wrote-it,
// docs/DESIGN.md#survey, docs/DESIGN.md#probe, docs/DESIGN.md#existing-solutions.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  itemId, liveItems, recordProbe, recordSolutions, recordSurvey, reviewScope, sectionSlug, surveyContext,
} from '../lib/evidence.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import { gitRepo, lines, returnFile, span, text, withLine, write } from './harness/evidence-fixture.mjs'

const QUESTION = 'how are configs loaded'
const topics = [{ key: 'loader', subtree: 'src' }, { key: 'cache', subtree: 'src/cache.js' }]

function survey(repo, files, over = {}) {
  return recordSurvey(repo, {
    plan: returnFile(repo, { question: QUESTION, topics: [] }), question_digest: fnv1a(QUESTION), topics, from: files, ...over,
  })
}

const judged = (items, risks = []) => ({ items, risks })

// ------------------------------------------------------------------ survey

test('a judge\'s items are recorded with the survey\'s question and their topic\'s subtree as ground', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)), 'src/cache.js': text(lines(5)) })
  const out = survey(repo, [returnFile(repo, judged([
    { ...span('src/a.js', 2, 4), topic: 'loader' },
    { ...span('src/cache.js', 1, 2), topic: 'cache' },
  ]))])
  assert.equal(out.ok, true, JSON.stringify(out))
  const items = [...liveItems(repo).values()]
  assert.deepEqual(items.map((i) => [i.question, i.topic, i.ground]).sort(),
    [[QUESTION, 'cache', ['src/cache.js']], [QUESTION, 'loader', ['src']]])
  assert.ok(items.every((i) => i.from_return === out.return))
})

test('a judge holding one topic has given every item to it, whatever key it wrote', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const out = survey(repo, [returnFile(repo, judged([{ ...span('src/a.js', 2, 4), topic: 'loadr' }]))], { topics: [topics[0]] })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual([...liveItems(repo).values()].map((i) => i.topic), ['loader'])
})

test('a derived item names its siblings by claim, and is recorded resting on their ids', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const base = { ...span('src/a.js', 2, 4), topic: 'loader' }
  const out = survey(repo, [returnFile(repo, judged([
    base,
    { topic: 'loader', kind: 'derived', claim: 'so it loads', spans: [], queries: [], sources: [], rests_on: [base.claim] },
  ]))])
  assert.equal(out.ok, true, JSON.stringify(out))
  const derived = [...liveItems(repo).values()].find((i) => i.kind === 'derived')
  assert.deepEqual(derived.rests_on, [itemId({ question: QUESTION, topic: 'loader', claim: base.claim })])
})

test('a plan whose question is not the survey\'s refuses the record, writing nothing', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const out = survey(repo, [returnFile(repo, judged([{ ...span('src/a.js', 2, 4), topic: 'loader' }]))],
    { plan: returnFile(repo, { question: QUESTION + '?' }) })
  assert.equal(out.error.kind, 'question_mismatch')
  assert.equal(liveItems(repo).size, 0)
  assert.equal(survey(repo, [returnFile(repo, judged([]))], { plan: '/no/such/plan.json' }).error.kind, 'plan_unreadable')
  assert.equal(survey(repo, ['/no/such/judge.json']).error.kind, 'return_unreadable')
})

test('a refused item refuses the record, and is written back with its problems for its judge', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const good = { ...span('src/a.js', 2, 4), topic: 'loader' }
  const out = survey(repo, [returnFile(repo, judged([good, { ...span('src/a.js', 40, 41), topic: 'cache' }, { ...good, topic: 'nowhere', claim: 'x' }]))])
  assert.deepEqual([out.ok, out.refused_n], [false, 2])
  assert.deepEqual(out.refused.sort((a, b) => (a.topic < b.topic ? -1 : 1)), [{ topic: 'cache', n: 1 }, { topic: 'nowhere', n: 1 }])
  const said = readFileSync(out.refusals_file, 'utf8')
  assert.match(said, /src\/a\.js has 30 line\(s\), so it has no line 41/)
  assert.match(said, /topic "nowhere" is not one of the topics you were given: loader, cache/)
  assert.equal(liveItems(repo).size, 0, 'a refusal writes nothing')
})

test('once corrections are asked for, an earlier refused item is dropped and only the last correction can refuse', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const good = { ...span('src/a.js', 2, 4), topic: 'loader' }
  const bad = { ...span('src/a.js', 40, 41), topic: 'cache' }
  const first = returnFile(repo, judged([good, bad]))

  const stillBad = survey(repo, [first], { fix: [returnFile(repo, judged([{ ...bad, claim: 'still past the end' }]))] })
  assert.deepEqual([stillBad.ok, stillBad.refused_n], [false, 1])

  const fixed = survey(repo, [first], { fix: [returnFile(repo, judged([{ ...span('src/a.js', 20, 21), topic: 'cache' }]))] })
  assert.deepEqual([fixed.ok, fixed.recorded_n, fixed.dropped_n], [true, 2, 1], JSON.stringify(fixed))
})

// ------------------------------------------------------------------ probe

const SPEC = '.agentics/e1/DESIGN.md'

function specRepo(n = 12) {
  const repo = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  write(repo, SPEC, text(lines(n, 'spec')))
  return repo
}

const finding = (over) => ({ axis: 'yagni', severity: 'gap', section: 'Design / Contracts', claim: 'c', evidence: 'e', start: 2, end: 3, ...over })

test('a probe\'s findings are recorded anchored to the snapshot, and every one is written in full', () => {
  const repo = specRepo()
  const { snapshot } = reviewScope(repo, SPEC)
  const out = recordProbe(repo, {
    file: SPEC, snapshot,
    from: [returnFile(repo, { findings: [finding({ claim: 'one' }), finding({ axis: 'other', claim: 'two', start: 5, end: 99 })] })],
    bundle: ['yagni+invariants'],
  })
  assert.equal(out.recorded, true, JSON.stringify(out))
  assert.deepEqual(out.findings.map((f) => [f.id, f.axis, f.severity, f.section, f.carried]), [
    ['P1', 'yagni', 'gap', 'design-contracts', false],
    ['P2', 'yagni+invariants', 'gap', 'design-contracts', false],
  ], 'an axis the analyst did not hold is its bundle\'s')
  const items = out.findings.map((f) => liveItems(repo).get(f.item))
  assert.deepEqual(items.map((i) => i.spans[0]), [
    { path: SPEC, start: 2, end: 3, at: snapshot },
    { path: SPEC, start: 1, end: 12, at: snapshot },
  ], 'a range past the snapshot anchors the whole document')
  assert.match(readFileSync(out.findings_file, 'utf8'), /P2 \[gap, yagni\+invariants\][\s\S]*claim: two/)
})

test('without a snapshot nothing is recorded, and the findings are still read and written', () => {
  const repo = specRepo()
  const out = recordProbe(repo, { file: SPEC, snapshot: '', from: [returnFile(repo, { findings: [finding({ severity: 'loud' })] }), '/gone.json'], bundle: ['yagni', 'ambiguity'] })
  assert.deepEqual([out.recorded, out.return, out.unread], [false, '', [1]])
  assert.deepEqual(out.findings.map((f) => [f.severity, f.item]), [['ambiguity', '']], 'a severity off the ladder blocks rather than passes')
  assert.equal(liveItems(repo).size, 0)
})

test('a narrowed round lists the findings it carries first, and a clean round still records its return', () => {
  const repo = specRepo()
  const { snapshot } = reviewScope(repo, SPEC)
  const first = recordProbe(repo, { file: SPEC, snapshot, from: [returnFile(repo, { findings: [finding({ claim: 'kept', start: 9, end: 10 })] })], bundle: ['yagni'] })
  write(repo, SPEC, text(withLine(lines(12, 'spec'), 2, 'edited')))
  const next = reviewScope(repo, SPEC, snapshot)
  assert.deepEqual(next.carried.map((i) => i.id), [first.findings[0].item])

  const out = recordProbe(repo, { file: SPEC, snapshot: next.snapshot, since: snapshot, from: [returnFile(repo, { findings: [] })], bundle: ['yagni'] })
  assert.equal(out.recorded, true)
  assert.match(out.return, /-probe$/)
  assert.deepEqual(out.findings.map((f) => [f.id, f.item, f.carried]), [['P1', first.findings[0].item, true]])
})

test('a section name becomes a handle', () => {
  assert.equal(sectionSlug('§3 — Design / Contracts '), '3-design-contracts')
  assert.equal(sectionSlug(''), '')
})

// ------------------------------------------------------------------ solutions

const CAPABILITY = 'rate-limit inbound requests'

function sweep(repo, over) {
  return recordSolutions(repo, {
    frame: returnFile(repo, { capability: CAPABILITY, disqualifiers: ['GPL-licensed', 'Python only'] }),
    question_digest: fnv1a(CAPABILITY), ...over,
  })
}

const candidate = (name, over) => ({
  name, source_url: 'https://example.com/' + name, what_it_is: 'a limiter', latest_version: '1.0.0', license: 'MIT',
  maintenance: 'released 2026-09-01', covers: 'per key limits', does_not_cover: 'nothing identified', ...over,
})

test('viability is computed from the declared disqualifiers, and an undeclared ground rules nothing out', () => {
  const repo = gitRepo({ 'package.json': text(lines(4)) })
  const out = sweep(repo, {
    assessed: returnFile(repo, { assessed: [
      { ...candidate('a'), disqualifiers_hit: [] },
      { ...candidate('b'), disqualifiers_hit: ['gpl-licensed'] },
      { ...candidate('c'), disqualifiers_hit: ['too clever'] },
    ], notes: 'is b the same as d?' }),
    candidates: [returnFile(repo, { candidates: [candidate('a'), candidate('b'), candidate('c'), candidate('d')] })],
    present: returnFile(repo, { hits: [{ path: 'package.json', line: 2, note: 'a limiter dependency' }, { path: 'x', line: 0, note: '' }] }),
  })
  assert.equal(out.recorded, true, JSON.stringify(out))
  assert.deepEqual(out.counts, {
    present: 2, candidates: 3, viable: 2, ruled_out: 1, invented: 1, lost: 1, unanchored: 1, unread: 0, unsettled: 1, present_read: 1,
  })
  assert.deepEqual(out.items.map((i) => [i.topic, i.kind]), [
    ['candidates', 'external'], ['candidates', 'external'], ['candidates', 'external'], ['already-present', 'behaviour'],
  ])
  const said = readFileSync(out.summary_file, 'utf8')
  assert.match(said, /RULED OUT:\n- b[\s\S]*ruled out by: gpl-licensed/)
  assert.match(said, /GROUNDS NOBODY DECLARED[\s\S]*c: too clever/)
  assert.match(said, /FOUND BUT NEVER RULED ON[\s\S]*- d/)
  assert.match(said, /ALREADY IN THE REPOSITORY[\s\S]*package\.json:2 — a limiter dependency/)
})

test('with no assessment the researchers\' candidates are carried unmeasured: neither viable nor ruled out', () => {
  const repo = gitRepo({ 'package.json': text(lines(4)) })
  const out = sweep(repo, { candidates: [returnFile(repo, { candidates: [candidate('a'), candidate('A')] }), '/gone.json'] })
  assert.equal(out.measured, false)
  assert.deepEqual([out.counts.candidates, out.counts.viable, out.counts.ruled_out, out.counts.unread], [1, 0, 0, 1])
  assert.match(readFileSync(out.summary_file, 'utf8'), /UNMEASURED/)
})

test('a frame whose capability is not the sweep\'s refuses it', () => {
  const repo = gitRepo({ 'package.json': text(lines(4)) })
  assert.equal(sweep(repo, { question_digest: fnv1a('another') }).error.kind, 'question_mismatch')
})

// ------------------------------------------------------------------ the survey's one file

test('a survey\'s context holds the standing items it reused, every item it recorded, its risks and its channels', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)), 'src/cache.js': text(lines(5)) })
  const earlier = survey(repo, [returnFile(repo, judged([{ ...span('src/cache.js', 1, 2), topic: 'cache' }]))])
  const now = survey(repo, [returnFile(repo, judged([{ ...span('src/a.js', 2, 4), topic: 'loader' }]))])
  const out = surveyContext(repo, {
    ground: ['src/cache.js'], return_kind: 'survey', returns: [now.return],
    from: [returnFile(repo, judged([], [{ topic: 'loader', text: 'the loader is untested' }]))],
    history: [returnFile(repo, { findings: 'abc123 added the loader', stop_reason: 'unfinished', not_reached: 'the 2024 branches' })],
  })
  assert.deepEqual(out.items.map((i) => [i.topic, i.state, i.return]).sort(), [['cache', 'standing', earlier.return], ['loader', 'standing', now.return]],
    'an item both reused and recorded now is listed once')
  assert.deepEqual(out.counts, { items: 2, risks: 1, history: 1, docs: 0 })
  const said = readFileSync(out.context, 'utf8')
  assert.match(said, /\[loader\]\n- \[I[0-9a-f]{8}\] \(loader, behaviour, standing\) src\/a\.js:2-4 says what it says — src\/a\.js:2-4/)
  assert.match(said, /RISKS THE JUDGES NAMED:\n- \[loader\] the loader is untested/)
  assert.match(said, /GIT HISTORY:\nabc123 added the loader\n\nCOVERAGE LIMIT \(unfinished\) — never reached: the 2024 branches/)
})
