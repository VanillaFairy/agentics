// test/evidence-anchors-judge.test.mjs — query and source anchors, and the re-judge's verdicts.
// The family's header is in test/evidence-anchors.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { checkAnchors, liveItems, recordJudgement } from '../lib/evidence.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { configPath, evidenceItemsPath } from '../lib/store.mjs'
import {
  commit, git, gitRepo, lines, logOf, record, span, spanFixture, stateOf, text, withLine, write,
} from './harness/evidence-fixture.mjs'

// ------------------------------------------------------------------ query and source anchors

test('a re-run query with a new hit makes the item suspect; moved lines alone do not', () => {
  const repo = gitRepo({ 'src/a.js': text(['export function one() {}', 'const x = 1', 'export function two() {}']) })
  const id = record(repo, {
    kind: 'enumeration', claim: 'src exports two functions',
    queries: [{ pattern: '^export function', scope: ['src'] }],
  })
  assert.deepEqual(liveItems(repo).get(id).queries[0].result.map((r) => r.text),
    ['export function one() {}', 'export function two() {}'])

  write(repo, 'src/a.js', text(['', '// moved down', 'export function one() {}', 'const x = 1', 'export function two() {}']))
  assert.equal(stateOf(repo, id).state, 'standing', 'line numbers are not part of a query anchor')

  write(repo, 'src/new.js', text(['export function three() {}']))
  const st = stateOf(repo, id)
  assert.equal(st.state, 'suspect', 'an untracked file with a new hit counts')
  assert.deepEqual(st.changed.map((c) => [c.anchor, c.index]), [['query', 0]])
  assert.match(st.changed[0].now, /src\/new\.js/)
})

test('a source older than evidence_max_age_days is stale; the default is thirty days', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  const id = record(repo, {
    kind: 'external', claim: 'fs.cp is stable in 24', ground: [],
    sources: [{ url: 'https://nodejs.org/api/fs.html', version: '24.1.0', retrieved: '2026-09-01' }],
  })
  const at = (iso) => ({ now: new Date(iso + 'T12:00:00Z') })
  assert.equal(stateOf(repo, id, at('2026-09-20')).state, 'standing')
  assert.equal(stateOf(repo, id, at('2026-10-05')).state, 'stale')

  mkdirSync(dirname(configPath(repo)), { recursive: true })
  writeFileSync(configPath(repo), JSON.stringify({ evidence_max_age_days: 10 }))
  assert.equal(stateOf(repo, id, at('2026-09-10')).state, 'standing')
  assert.equal(stateOf(repo, id, at('2026-09-12')).state, 'stale')
})

test('evidence_max_age_days of 0, -1 or \'ten\', or an unparseable config.json, falls back to thirty days', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  const id = record(repo, {
    kind: 'external', claim: 'fs.cp is stable in 24', ground: [],
    sources: [{ url: 'https://nodejs.org/api/fs.html', version: '24.1.0', retrieved: '2026-09-01' }],
  })
  const at = (iso) => ({ now: new Date(iso + 'T12:00:00Z') })
  mkdirSync(dirname(configPath(repo)), { recursive: true })
  for (const config of ['{"evidence_max_age_days":0}', '{"evidence_max_age_days":-1}', '{"evidence_max_age_days":"ten"}', '{ not json']) {
    writeFileSync(configPath(repo), config)
    assert.equal(stateOf(repo, id, at('2026-09-20')).state, 'standing', config)
    assert.equal(stateOf(repo, id, at('2026-10-05')).state, 'stale', config)
  }
})

test('a derived item follows what it rests on, and a base the store lacks is stale', () => {
  const { repo, id: base } = spanFixture()
  const derived = record(repo, { kind: 'derived', claim: 'so the loader is synchronous', rests_on: [base] })
  assert.equal(stateOf(repo, derived).state, 'standing')

  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve')))
  assert.equal(stateOf(repo, derived).state, 'suspect')

  assert.equal(recordJudgement(repo, base, 'fails').ok, true)
  assert.equal(stateOf(repo, derived).state, 'stale')

  const orphan = record(repo, { kind: 'derived', claim: 'rests on nothing we hold', rests_on: ['I00000000'] })
  assert.equal(stateOf(repo, orphan).state, 'stale')
})

// ------------------------------------------------------------------ the re-judge's verdicts

test('holds re-anchors the item at the new HEAD with its lines remapped', () => {
  const { repo, id } = spanFixture()
  const edited = ['top 1', 'top 2', 'top 3', ...lines(12), 'inserted', ...lines(30).slice(12)]
    .map((l) => (l === 'line 12' ? 'line twelve' : l))
  write(repo, 'src/a.js', text(edited))
  const head = commit(repo)
  assert.equal(stateOf(repo, id).state, 'suspect')

  const out = recordJudgement(repo, id, 'holds')
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.state, 'standing')
  assert.deepEqual(liveItems(repo).get(id).spans, [{
    path: 'src/a.js', start: edited.indexOf('line 10') + 1, end: edited.indexOf('line 14') + 1, at: head,
  }])
  assert.equal(stateOf(repo, id).state, 'standing')
})

test('holds on an uncommitted edit anchors at a snapshot, so the same edit is not judged twice', () => {
  const { repo, id } = spanFixture()
  const edited = withLine(lines(30), 12, 'line twelve')
  write(repo, 'src/a.js', text(edited))

  assert.equal(recordJudgement(repo, id, 'holds').state, 'standing')
  assert.equal(liveItems(repo).get(id).spans[0].at, 'snapshot:' + hashSpec(text(edited)))

  commit(repo)
  assert.equal(stateOf(repo, id).state, 'standing', 'committing the judged edit changes nothing')
})

test('fails and unsure both make an item stale, each a judged line at HEAD; an unknown item or verdict is refused', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const a = record(repo, span('src/a.js', 2, 4))
  const b = record(repo, span('src/a.js', 20, 22))
  assert.deepEqual([recordJudgement(repo, a, 'fails').state, recordJudgement(repo, b, 'unsure').state], ['stale', 'stale'])
  assert.deepEqual(checkAnchors(repo, [a, b]).map((s) => s.state), ['stale', 'stale'])
  const head = git(repo, 'rev-parse', 'HEAD')
  assert.deepEqual(logOf(repo, 'judged').map((e) => [e.id, e.ruling, e.at]), [[a, 'fails', head], [b, 'unsure', head]])

  const judged = logOf(repo, 'judged').length
  assert.equal(recordJudgement(repo, 'I00000000', 'holds').ok, false)
  assert.equal(recordJudgement(repo, a, 'maybe').ok, false)
  assert.equal(logOf(repo, 'judged').length, judged, 'a refusal writes nothing')
  assert.equal(stateOf(repo, 'I00000000').state, 'stale', 'an id the store lacks is never standing')
})

test('a judged line carries its ruling and no verdict', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const a = record(repo, span('src/a.js', 2, 4))
  const b = record(repo, span('src/a.js', 10, 14))
  assert.equal(recordJudgement(repo, a, 'fails').ok, true)
  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve')))
  commit(repo)
  assert.equal(recordJudgement(repo, b, 'holds').state, 'standing')
  rmSync(join(repo, 'src', 'a.js'))
  assert.equal(recordJudgement(repo, b, 'holds').state, 'stale')

  const judged = logOf(repo, 'judged')
  assert.deepEqual(judged.map((j) => [j.id, j.ruling]), [[a, 'fails'], [b, 'holds'], [b, 'unsure']])
  for (const j of judged) assert.equal(Object.hasOwn(j, 'verdict'), false, JSON.stringify(j))
  assert.equal(stateOf(repo, a).why, 'judged fails')
})

test('a judged line is read by its ruling, never its verdict', () => {
  const { repo, id } = spanFixture()
  const [item] = logOf(repo, 'item')
  const judgedAs = (fields) => writeFileSync(evidenceItemsPath(repo), [item, { kind: 'judged', id, at: '', seq: item.seq + 1, ...fields }]
    .map((e) => JSON.stringify(e)).join('\n') + '\n')

  judgedAs({ verdict: 'fails', ruling: 'holds' })
  const held = stateOf(repo, id)
  assert.deepEqual([held.state, held.why], ['standing', 'judged holds'])

  judgedAs({ verdict: 'holds' })
  assert.equal(stateOf(repo, id).state, 'stale', 'a judged line with no ruling never holds')
})

test('holds after fails re-anchors the item standing', () => {
  const { repo, id } = spanFixture()
  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve')))
  const head = commit(repo)
  assert.equal(recordJudgement(repo, id, 'fails').state, 'stale')
  assert.equal(recordJudgement(repo, id, 'holds').state, 'standing')
  assert.equal(liveItems(repo).get(id).spans[0].at, head)
  assert.equal(stateOf(repo, id).state, 'standing')
})

test('holds on a derived item returns its base\'s state: suspect while the base is unjudged', () => {
  const { repo, id: base } = spanFixture()
  const derived = record(repo, { kind: 'derived', claim: 'so the loader is synchronous', rests_on: [base] })
  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve')))
  const out = recordJudgement(repo, derived, 'holds')
  assert.deepEqual([out.ok, out.state], [true, 'suspect'])
  assert.equal(recordJudgement(repo, base, 'holds').state, 'standing')
  assert.equal(stateOf(repo, derived).state, 'standing')
})

/** A holds that can't re-anchor: stale, stored as unsure with what was asked, and no new revision. */
function assertUnanchorable(repo, id, opts) {
  const revisions = logOf(repo, 'item').length
  const out = recordJudgement(repo, id, 'holds', opts)
  assert.deepEqual([out.ok, out.state], [true, 'stale'], JSON.stringify(out))
  const last = logOf(repo, 'judged').at(-1)
  assert.deepEqual([last.id, last.ruling, last.requested], [id, 'unsure', 'holds'])
  assert.equal(logOf(repo, 'item').length, revisions, 'no item revision is appended')
  assert.equal(stateOf(repo, id).state, 'stale')
}

test('holds on an item whose file was deleted goes stale as unsure, and appends no revision', () => {
  const { repo, id } = spanFixture()
  rmSync(join(repo, 'src', 'a.js'))
  assertUnanchorable(repo, id)
})

test('holds on a span whose lines were all deleted goes stale the same way', () => {
  const { repo, id } = spanFixture()
  write(repo, 'src/a.js', text(lines(30).filter((_, i) => i < 9 || i > 13)))
  assertUnanchorable(repo, id)
})

test('holds on an absence item whose query now finds a line goes stale, never re-anchored', () => {
  const repo = gitRepo({ 'src/a.js': text(['const x = 1']) })
  const id = record(repo, {
    kind: 'absence', claim: 'nothing in src calls eval', queries: [{ pattern: 'eval\\(', scope: ['src'] }],
  })
  write(repo, 'src/b.js', text(['eval(code)']))
  assert.equal(stateOf(repo, id).state, 'suspect')
  assertUnanchorable(repo, id)
})

test('holds whose query cannot be re-run goes stale the same way, never re-anchored with no hits', () => {
  const repo = gitRepo({ 'src/a.js': text(['export function one() {}']) })
  const id = record(repo, {
    kind: 'enumeration', claim: 'src exports one function', queries: [{ pattern: '^export function', scope: ['src'] }],
  })
  const gone = mkdtempSync(join(tmpdir(), 'agentics-anchors-gone-'))
  rmSync(gone, { recursive: true })
  assertUnanchorable(repo, id, { root: gone })
})

test('a stale item stays stale until a new revision of it is recorded', () => {
  const { repo, id } = spanFixture()
  recordJudgement(repo, id, 'fails')
  assert.equal(stateOf(repo, id).state, 'stale')
  assert.equal(record(repo, span('src/a.js', 10, 14)), id, 'the same claim is the same item')
  assert.equal(stateOf(repo, id).state, 'standing')
})
