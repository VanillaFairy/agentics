// test/evidence-inprocess-survey.test.mjs — the survey's evidence called in-process: judges' returns
// as objects, a re-judge's rulings, superseded items, the pool and the scouts' excerpts as prompt
// text, and the 4.x verbs that keep printing handles only.
//
// Design: docs/DESIGN.md#survey, docs/DESIGN.md#the-drift-ladder, docs/DESIGN.md#returns-into-items.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { excerptsText } from '../lib/citations.mjs'
import {
  checkAnchors, itemsFor, liveItems, poolText, recordJudgement, recordRulings, recordSurvey, supersede, surveyContext,
} from '../lib/evidence.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import {
  cli, commit, gitRepo, lines, linkedWorktree, logOf, record, returnFile, span, stateOf, text, withLine, write,
} from './harness/evidence-fixture.mjs'

const QUESTION = 'how are configs loaded'
const N = 30
const topics = [{ key: 'loader', subtree: 'src' }, { key: 'cache', subtree: 'src/cache.js' }]
const judged = (items, risks = []) => ({ items, risks })

/** A git repository with `files` committed, removed when the test ends. */
function repoOf(t, files) {
  const repo = gitRepo(files)
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  return repo
}

const inProcess = (repo, from, over = {}) => recordSurvey(repo, { question: QUESTION, topics, from, ...over })

// ------------------------------------------------------------------ recordSurvey in-process

test('a survey handed its question records the judges\' return objects under it', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(N)), 'src/cache.js': text(lines(5)) })
  const out = inProcess(repo, [judged([{ ...span('src/a.js', 2, 4), topic: 'loader' }, { ...span('src/cache.js', 1, 2), topic: 'cache' }])])
  assert.equal(out.ok, true, JSON.stringify(out))
  const items = [...liveItems(repo).values()]
  assert.deepEqual(items.map((i) => [i.question, i.topic, i.ground]).sort(),
    [[QUESTION, 'cache', ['src/cache.js']], [QUESTION, 'loader', ['src']]])
  assert.equal(out.recorded_n, items.length)
})

test('a judge\'s return handed as an object records the items its file records', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(N)) })
  const ret = judged([{ ...span('src/a.js', 2, 4), topic: 'loader' }, { ...span('src/a.js', 6, 9), topic: 'loader' }])
  const byFile = recordSurvey(repo, {
    plan: returnFile(repo, { question: QUESTION, topics: [] }), question_digest: fnv1a(QUESTION), topics, from: [returnFile(repo, ret)],
  })
  const byObject = inProcess(repo, [ret])
  assert.deepEqual([byFile.ok, byObject.ok], [true, true], JSON.stringify([byFile, byObject]))
  const batch = (name) => logOf(repo, 'item').filter((e) => e.item.from_return === name)
    .map(({ item }) => { const { from_return: _, ...rest } = item; return rest })
  assert.equal(batch(byFile.return).length, ret.items.length)
  assert.deepEqual(batch(byObject.return), batch(byFile.return), 'the same ids, anchors and ground')
})

test('from and fix may mix return objects and return files', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(N)) })
  const good = { ...span('src/a.js', 2, 4), topic: 'loader' }
  const past = { ...span('src/a.js', N + 10, N + 11), topic: 'cache' }
  const out = inProcess(repo, [returnFile(repo, judged([good, past]))], { fix: [judged([{ ...span('src/a.js', 20, 21), topic: 'cache' }])] })
  assert.deepEqual([out.ok, out.recorded_n, out.dropped_n], [true, 2, 1], JSON.stringify(out))
})

test('a refusal names each refused item\'s topic, claim and problems, and writes nothing', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(N)) })
  const good = { ...span('src/a.js', 2, 4), topic: 'loader' }
  const past = { ...span('src/a.js', N + 10, N + 11), topic: 'cache' }
  const invented = { ...good, topic: 'no where', claim: 'somewhere else' }
  const out = inProcess(repo, [judged([good, past, invented])])
  assert.equal(out.ok, false)
  assert.deepEqual(out.refusals.map((r) => [r.topic, r.claim]), [['cache', past.claim], ['no where', invented.claim]],
    'a topic the judge invented is named as it wrote it')
  assert.ok(out.refusals[0].problems.some((p) => p.includes('has ' + N + ' line(s), so it has no line ' + (N + 11))), JSON.stringify(out.refusals))
  assert.ok(out.refusals[1].problems.some((p) => p.includes('topic "no where" is not one of the topics you were given')), JSON.stringify(out.refusals))
  assert.equal(liveItems(repo).size, 0)
})

test('a survey handed an empty question refuses the record, writing nothing', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(N)) })
  const out = recordSurvey(repo, { question: '  ', topics, from: [judged([{ ...span('src/a.js', 2, 4), topic: 'loader' }])] })
  assert.deepEqual([out.ok, out.error.kind], [false, 'no_question'])
  assert.equal(liveItems(repo).size, 0)
})

test('the record verb prints a refused survey\'s handles, not its refusals', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(N)) })
  const plan = returnFile(repo, { question: QUESTION, topics: [] })
  const from = returnFile(repo, judged([{ ...span('src/a.js', N + 10, N + 11), topic: 'loader' }]))
  const out = cli(repo)('record', '--kind', 'survey', '--plan', plan, '--question-digest', fnv1a(QUESTION),
    '--topic', 'loader', '--subtree', 'src', '--from', from)
  assert.deepEqual([out.ok, out.refused_n], [false, 1])
  assert.equal('refusals' in out, false)
})

// ------------------------------------------------------------------ recordRulings

/** A 30-line file with spans 10-14 and 20-22 recorded, an edit inside each making both suspect. */
function suspectPair(t) {
  const repo = repoOf(t, { 'src/a.js': text(lines(N)) })
  const a = record(repo, span('src/a.js', 10, 14))
  const b = record(repo, span('src/a.js', 20, 22))
  write(repo, 'src/a.js', text(withLine(withLine(lines(N), 12, 'twelve'), 21, 'twenty-one')))
  assert.deepEqual([stateOf(repo, a).state, stateOf(repo, b).state], ['suspect', 'suspect'])
  return { repo, a, b }
}

test('one ruling is recorded per id handed, and an id with no ruling is unsure', (t) => {
  const { repo, a, b } = suspectPair(t)
  const out = recordRulings(repo, [a, b], [{ id: a, ruling: 'holds', why: 'a comment moved' }])
  assert.deepEqual(out.map((r) => [r.id, r.ruling, r.ok, r.state]), [[a, 'holds', true, 'standing'], [b, 'unsure', true, 'stale']])
  assert.deepEqual(logOf(repo, 'judged').map((j) => [j.id, j.verdict]), [[a, 'holds'], [b, 'unsure']])
})

test('a ruling for an id not handed is ignored', (t) => {
  const { repo, a, b } = suspectPair(t)
  const out = recordRulings(repo, [a], [{ id: a, ruling: 'fails', why: '' }, { id: b, ruling: 'holds', why: '' }])
  assert.deepEqual(out.map((r) => r.id), [a])
  assert.deepEqual(logOf(repo, 'judged').map((j) => j.id), [a])
  assert.equal(stateOf(repo, b).state, 'suspect')
})

test('a ruling off the ladder is recorded as unsure', (t) => {
  const { repo, a } = suspectPair(t)
  const [out] = recordRulings(repo, [a], [{ id: a, ruling: 'probably', why: '' }])
  assert.deepEqual([out.ruling, out.ok, out.state], ['unsure', true, 'stale'])
})

test('a holds ruling re-anchors the item where its lines now are', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(N)) })
  const id = record(repo, span('src/a.js', 10, 14))
  const edited = ['top', 'more', ...withLine(lines(N), 12, 'twelve')]
  write(repo, 'src/a.js', text(edited))
  const head = commit(repo)
  const [out] = recordRulings(repo, [id], [{ id, ruling: 'holds', why: 'cosmetic' }])
  assert.deepEqual([out.ok, out.state], [true, 'standing'])
  assert.deepEqual(liveItems(repo).get(id).spans, [{
    path: 'src/a.js', start: edited.indexOf('line 10') + 1, end: edited.indexOf('line 14') + 1, at: head,
  }])
})

test('a holds ruling on an item whose lines are gone leaves it stale, recorded unsure', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(N)) })
  const id = record(repo, span('src/a.js', 10, 14))
  rmSync(join(repo, 'src', 'a.js'))
  const [out] = recordRulings(repo, [id], [{ id, ruling: 'holds', why: '' }])
  assert.deepEqual([out.ruling, out.ok, out.state], ['holds', true, 'stale'])
  assert.deepEqual([logOf(repo, 'judged').at(-1).verdict, logOf(repo, 'judged').at(-1).requested], ['unsure', 'holds'])
})

test('a holds ruling on an item already stale for an expired source leaves it stale', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(3)) })
  const id = record(repo, {
    kind: 'external', claim: 'fs.cp is stable', ground: [],
    sources: [{ url: 'https://nodejs.org/api/fs.html', version: '24.1.0', retrieved: '2020-01-01' }],
  })
  assert.equal(stateOf(repo, id).state, 'stale')
  const [out] = recordRulings(repo, [id], [{ id, ruling: 'holds', why: '' }])
  assert.deepEqual([out.ok, out.state], [true, 'stale'], 'a ruling leaves a source\'s retrieval date as it was')
})

test('a ruling re-anchors in the checkout it is given', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(N)) })
  const id = record(repo, span('src/a.js', 10, 14))
  const wt = linkedWorktree(repo)
  t.after(() => rmSync(dirname(wt), { recursive: true, force: true }))
  write(wt, 'src/a.js', text(['top', ...withLine(lines(N), 12, 'twelve')]))
  const head = commit(wt)
  recordRulings(repo, [id], [{ id, ruling: 'holds', why: '' }], { root: wt })
  assert.equal(liveItems(repo).get(id).spans[0].at, head)
})

test('an id the store does not hold is not recorded', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(3)) })
  const out = recordRulings(repo, ['I00000000'], [{ id: 'I00000000', ruling: 'holds', why: '' }])
  assert.deepEqual(out.map((r) => [r.id, r.ok, r.state]), [['I00000000', false, '']])
  assert.equal(logOf(repo, 'judged').length, 0)
})

// ------------------------------------------------------------------ supersede

const item = (over) => ({ topic: 'loader', state: 'standing', seq: 1, ground: ['src'], ...over })

test('a stale item is superseded by a later standing item of its topic sharing a ground path', () => {
  const old = item({ id: 'old', state: 'stale', seq: 1, ground: ['src', 'lib'] })
  const fresh = item({ id: 'new', state: 'standing', seq: 5, ground: ['lib'] })
  assert.deepEqual(supersede([old, fresh]).map((i) => i.id), ['new'])
})

test('a standing item of another topic supersedes nothing', () => {
  const old = item({ id: 'old', state: 'stale', seq: 1 })
  assert.deepEqual(supersede([old, item({ id: 'new', topic: 'cache', seq: 5 })]).map((i) => i.id), ['old', 'new'])
})

test('a standing item recorded earlier supersedes nothing', () => {
  const old = item({ id: 'old', state: 'stale', seq: 5 })
  assert.deepEqual(supersede([old, item({ id: 'new', seq: 1 })]).map((i) => i.id), ['old', 'new'])
})

test('a standing item on other ground supersedes nothing', () => {
  const old = item({ id: 'old', state: 'stale', seq: 1, ground: ['src/a.js'] })
  assert.deepEqual(supersede([old, item({ id: 'new', seq: 5, ground: ['lib'] })]).map((i) => i.id), ['old', 'new'])
})

test('only a standing item supersedes, and only a stale item is superseded', () => {
  const old = item({ id: 'old', state: 'stale', seq: 1 })
  const suspect = item({ id: 'suspect', state: 'suspect', seq: 5 })
  assert.deepEqual(supersede([old, suspect]).map((i) => i.id), ['old', 'suspect'], 'a suspect item outranks nothing')
  const older = item({ id: 'older', state: 'suspect', seq: 1 })
  assert.deepEqual(supersede([older, item({ id: 'new', seq: 5 })]).map((i) => i.id), ['older', 'new'], 'a suspect item is never dropped')
})

// ------------------------------------------------------------------ the pool and the survey's context as text

/** Every item in the store with its derived state, as itemsFor shapes them, stale ones included. */
function poolOf(repo) {
  const st = new Map(checkAnchors(repo).map((s) => [s.id, s]))
  return [...liveItems(repo).values()].map((it) => ({ ...it, state: st.get(it.id).state, changed: st.get(it.id).changed }))
}

/** Three items on one file: one standing, one made suspect by an edit, one judged stale. */
function threeStates(t) {
  const repo = repoOf(t, { 'src/a.js': text(lines(N)) })
  const standing = record(repo, span('src/a.js', 2, 4))
  const suspect = record(repo, span('src/a.js', 10, 14))
  const stale = record(repo, span('src/a.js', 20, 22))
  assert.equal(recordJudgement(repo, stale, 'fails').ok, true)
  const edited = withLine(lines(N), 12, 'twelve')
  write(repo, 'src/a.js', text(edited))
  return { repo, standing, suspect, stale, edited }
}

test('the pool as a prompt reads it names each item\'s id, state, topic, claim and anchors', (t) => {
  const { repo } = threeStates(t)
  const pool = poolOf(repo)
  assert.deepEqual(pool.map((it) => it.state).sort(), ['stale', 'standing', 'suspect'])
  const said = poolText(pool)
  for (const it of pool) {
    const line = said.split('\n').find((l) => l.includes('[' + it.id + ']'))
    assert.ok(line, it.id + ' is listed')
    const s = it.spans[0]
    for (const part of [it.state, it.topic, it.claim, s.path + ':' + s.start + '-' + s.end]) assert.ok(line.includes(part), part + ' in ' + line)
  }
})

test('a suspect item in the pool carries each changed anchor\'s old and new text', (t) => {
  const { repo, suspect, edited } = threeStates(t)
  const said = poolText(poolOf(repo))
  const after = said.slice(said.indexOf('[' + suspect + ']'))
  assert.ok(after.includes('was:\n' + lines(N).slice(9, 14).join('\n')), after)
  assert.ok(after.includes('is now:\n' + edited.slice(9, 14).join('\n')), after)
})

test('the items verb writes the text poolText renders', (t) => {
  const { repo } = threeStates(t)
  const out = cli(repo)('items', '--ground', 'src')
  assert.equal(readFileSync(out.context, 'utf8'), poolText(itemsFor(repo, { ground: ['src'] })))
})

test('a survey\'s context result carries the text it wrote, whole', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(N)) })
  const rec = inProcess(repo, [judged([{ ...span('src/a.js', 2, 4), topic: 'loader' }])])
  const out = surveyContext(repo, { returns: [rec.return], from: [returnFile(repo, judged([], [{ topic: 'loader', text: 'the loader is untested' }]))] })
  assert.equal(out.text, readFileSync(out.context, 'utf8'))
  assert.ok(out.text.includes('the loader is untested'))
})

test('the context verb prints handles, not the text', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(N)) })
  const rec = inProcess(repo, [judged([{ ...span('src/a.js', 2, 4), topic: 'loader' }])])
  const out = cli(repo)('context', '--return', rec.return)
  assert.equal('text' in out, false)
  assert.equal(readFileSync(out.context, 'utf8'), surveyContext(repo, { returns: [rec.return] }).text)
})

// ------------------------------------------------------------------ excerptsText

const CITATIONS = fileURLToPath(new URL('../lib/citations.mjs', import.meta.url))
const scoutReturn = (hits, over = {}) => ({ hits, searched: [], no_match: '', not_reached: '', stop_reason: 'exhausted', ...over })

test('scout returns become one body: each location with its note, what each scout searched and declared absent, and the lines', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(20)) })
  const scout = scoutReturn([{ path: 'src/a.js', line: 10, note: 'the loader' }],
    { searched: ['grep load'], no_match: 'no retry anywhere', not_reached: 'lib/', stop_reason: 'unfinished' })
  const out = excerptsText(repo, [{ label: 'scout:loader', output: scout }])
  for (const part of [
    '=== scout:loader — the search did NOT finish (unfinished)', '  src/a.js:10 — the loader', '  grep load',
    'SEARCHED AND NOT FOUND (evidence of absence):\n  no retry anywhere', 'NEVER SEARCHED: lib/', String(10).padStart(6) + '\tline 10',
  ]) assert.ok(out.text.includes(part), part)
  assert.deepEqual([out.counts.locations, out.counts.files, out.counts.excerpts, out.counts.unresolved], [1, 1, 1, 0])
})

test('locations several scouts report are read once, overlapping windows merged', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(20)) })
  const out = excerptsText(repo, [
    { label: 'one', output: scoutReturn([{ path: 'src/a.js', line: 10, note: 'x' }]) },
    { label: 'two', output: scoutReturn([{ path: 'src/a.js', line: 12, note: 'y' }]) },
  ])
  assert.deepEqual([out.counts.files, out.counts.excerpts], [1, 1])
  assert.equal(out.text.split('\n').filter((l) => l.endsWith('\tline 11')).length, 1)
})

test('a kind keeps only the hits of that kind', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(20)), 'CLAUDE.md': text(['# guide']) })
  const located = scoutReturn([
    { path: 'src/a.js', line: 3, note: 'the ground', kind: 'ground' }, { path: 'CLAUDE.md', line: 1, note: 'the guidance', kind: 'guidance' },
  ])
  const ground = excerptsText(repo, [{ label: 'locate', output: located }], { kind: 'ground' })
  assert.equal(ground.counts.locations, 1)
  assert.ok(ground.text.includes('the ground') && !ground.text.includes('the guidance'))
  assert.ok(excerptsText(repo, [{ label: 'locate', output: located }], { kind: 'guidance' }).text.includes('the guidance'))
})

test('a location that cannot be read is named with why, and counted', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(20)) })
  const out = excerptsText(repo, [{
    label: 'scout', output: scoutReturn([
      { path: 'src/ghost.js', line: 3, note: 'gone' }, { path: 'src/a.js', line: 99, note: 'past' }, { path: '/elsewhere/x.js', line: 1, note: 'out' },
    ]),
  }])
  const byPath = (a, b) => (a.path < b.path ? -1 : 1)
  assert.deepEqual(out.unresolved.map(({ path, line, why }) => ({ path, line, why })).sort(byPath), [
    { path: '/elsewhere/x.js', line: 1, why: 'outside' }, { path: 'src/a.js', line: 99, why: 'out_of_range' }, { path: 'src/ghost.js', line: 3, why: 'missing' },
  ])
  assert.equal(out.counts.unresolved, out.unresolved.length)
  assert.ok(out.text.includes('NOT EXCERPTED'))
})

test('a return that is not an object is named as unread', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(20)) })
  assert.ok(excerptsText(repo, [{ label: 'scout:lost', output: null }]).text.includes('=== scout:lost — this report could not be read'))
})

test('the excerpts verb writes the text excerptsText renders', (t) => {
  const repo = repoOf(t, { 'src/a.js': text(lines(20)) })
  const scout = scoutReturn([{ path: 'src/a.js', line: 10, note: 'the loader' }, { path: 'src/ghost.js', line: 2, note: 'gone' }],
    { no_match: 'no retry', stop_reason: 'unfinished' })
  const file = returnFile(repo, scout)
  const { NODE_TEST_CONTEXT: _, ...env } = process.env
  const r = spawnSync(process.execPath, [CITATIONS, 'excerpts', '--repo', repo, '--hits', file], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const printed = JSON.parse(r.stdout)
  assert.equal(printed.payload_digest, fnv1a(canonical(printed.payload)))
  assert.equal(readFileSync(printed.payload.context, 'utf8'), excerptsText(repo, [{ label: basename(file), output: scout }]).text)
})
