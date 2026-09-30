// test/evidence-anchors-pool.test.mjs — reading the pool, and the scope of a re-review.
// The family's header is in test/evidence-anchors.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  checkAnchors, itemsFor, recordCites, recordItems, recordJudgement, recordRaw, reviewScope,
} from '../lib/evidence.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { evidenceItemsPath, evidenceReturnsDir } from '../lib/store.mjs'
import {
  gitRepo, lines, record, span, spanFixture, stateOf, text, withLine, write,
} from './harness/evidence-fixture.mjs'

// ------------------------------------------------------------------ reading the pool

test('itemsFor returns the items whose ground overlaps, with their state, standing and suspect by default', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)), 'docs/x.md': text(lines(5)) })
  const src = record(repo, span('src/a.js', 10, 14, { ground: ['src'] }))
  const docs = record(repo, span('docs/x.md', 1, 2, { ground: ['docs'] }))
  const wide = record(repo, span('src/a.js', 1, 2, { ground: ['.'], claim: 'repository-wide' }))
  const wrong = record(repo, span('src/a.js', 20, 21, { ground: ['src'], claim: 'judged wrong' }))
  assert.equal(recordCites(repo, 'e1', 'f', { items: [wrong] }).ok, true, 'cited, so the prune keeps it once stale')
  recordJudgement(repo, wrong, 'fails')

  const got = itemsFor(repo, { ground: ['src/a.js'] })
  assert.deepEqual(got.map((i) => i.id), [src, wide].sort())
  assert.ok(got.every((i) => i.state === 'standing' && Array.isArray(i.changed) && typeof i.why === 'string'))
  assert.deepEqual(itemsFor(repo, { ground: ['src/a.js'], states: ['stale'] }).map((i) => i.id), [wrong])
  assert.deepEqual(itemsFor(repo, { ground: ['docs'] }).map((i) => i.id), [docs, wide].sort())
})

test('reviewScope narrows a re-review to the changed lines and carries what no edit touched', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  const path = '.agentics/e1/DESIGN.md'
  const v1 = lines(40, 'spec')
  write(repo, path, text(v1))

  const first = reviewScope(repo, path)
  assert.equal(first.ok, true)
  assert.deepEqual([first.path, first.full, first.lines, first.changed, first.carried],
    [path, true, 40, [{ start: 1, end: 40 }], []])
  assert.equal(first.snapshot, 'snapshot:' + hashSpec(text(v1)))

  const finding = (start, end, axis) => record(repo, {
    question: path, topic: 'challenge:' + axis, ground: [path], kind: 'behaviour',
    claim: axis + ' finding at ' + start, spans: [{ path, start, end, at: first.snapshot }],
    detail: { axis, severity: 'note', section: '§1', evidence: 'e' },
  })
  const kept = finding(5, 7, 'yagni')
  const touched = finding(30, 32, 'ambiguity')

  const v2 = withLine(v1, 31, 'spec 31, edited')
  write(repo, path, text(v2))
  const next = reviewScope(repo, path, first.snapshot)
  assert.equal(next.full, false)
  assert.deepEqual(next.changed, [{ start: 31, end: 31 }])
  assert.deepEqual(next.carried.map((i) => i.id), [kept])
  assert.ok(!next.carried.some((i) => i.id === touched))
  assert.equal(next.snapshot, 'snapshot:' + hashSpec(text(v2)))

  write(repo, path, text(v1.filter((_, i) => i !== 9)))
  assert.deepEqual(reviewScope(repo, path, first.snapshot).changed, [{ start: 9, end: 10 }],
    'a deletion marks the lines on either side of where it was')

  assert.equal(reviewScope(repo, path, 'snapshot:deadbeef').full, true, 'a since the store never saw is a full review')
})

test('reviewScope carries a finding anchored two snapshots before since and untouched since; never one on another artefact', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  const path = '.agentics/e1/DESIGN.md'
  const other = '.agentics/e1/NOTES.md'
  const v1 = lines(40, 'spec')
  write(repo, path, text(v1))
  write(repo, other, text(v1))
  const finding = (file, at, extra = {}) => record(repo, {
    question: file, topic: 'challenge:yagni', ground: [file], kind: 'behaviour',
    claim: 'a yagni finding in ' + file, spans: [{ path: file, start: 5, end: 7, at }],
    detail: { axis: 'yagni', severity: 'note', section: '§1', evidence: 'e' }, ...extra,
  })
  const s1 = reviewScope(repo, path).snapshot
  const old = finding(path, s1)
  // Its ground overlaps the artefact's, so only the carry rule keeps it out.
  const elsewhere = finding(other, reviewScope(repo, other).snapshot, { ground: ['.agentics/e1'] })

  const v2 = withLine(v1, 31, 'spec 31, edited')
  write(repo, path, text(v2))
  const s2 = reviewScope(repo, path, s1).snapshot
  const v3 = withLine(v2, 35, 'spec 35, edited')
  write(repo, path, text(v3))
  const s3 = reviewScope(repo, path, s2).snapshot
  write(repo, path, text(withLine(v3, 38, 'spec 38, edited')))

  const next = reviewScope(repo, path, s3)
  assert.deepEqual(next.changed, [{ start: 38, end: 38 }])
  assert.deepEqual(next.carried.map((i) => i.id), [old], 'anchored at ' + s1 + ', two snapshots before ' + s3)
  assert.ok(!next.carried.some((i) => i.id === elsewhere))
})

test('reviewScope refuses a path outside the checkout and an unreadable file, and echoes since', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  const outside = reviewScope(repo, '../elsewhere.md')
  assert.deepEqual([outside.ok, outside.error.kind], [false, 'outside'])
  const missing = reviewScope(repo, 'docs/missing.md')
  assert.deepEqual([missing.ok, missing.error.kind], [false, 'unreadable'])
  assert.equal(reviewScope(repo, 'src/a.js', 'snapshot:deadbeef').since, 'snapshot:deadbeef')
  assert.equal(reviewScope(repo, 'src/a.js').since, '')
})

test('deriving states writes nothing', () => {
  const { repo, id } = spanFixture()
  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve')))
  const before = readFileSync(evidenceItemsPath(repo), 'utf8')
  checkAnchors(repo)
  itemsFor(repo, { ground: ['src'] })
  stateOf(repo, id)
  assert.equal(readFileSync(evidenceItemsPath(repo), 'utf8'), before)
})

test('a repository with no item store derives nothing and refuses a judgement', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  assert.deepEqual(checkAnchors(repo), [])
  assert.equal(recordJudgement(repo, 'I00000000', 'holds').ok, false)
  assert.equal(existsSync(evidenceItemsPath(repo)), false, 'a refusal writes nothing')
})

// ------------------------------------------------------------------ a clean review

test('recordRaw records an empty probe return', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  const out = recordRaw(repo, 'probe', { items: [] })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.match(out.return, /^\d{8}-\d{6}-probe$/)
  assert.deepEqual(out.ids, [])
  assert.deepEqual(JSON.parse(readFileSync(join(evidenceReturnsDir(repo), out.return + '.json'), 'utf8')), { items: [] },
    'a review that found nothing is still a review return a prepared line can name')
  assert.equal(existsSync(evidenceItemsPath(repo)), false, 'it adds nothing to the pool')
})

test('a later sweep of the same capability supersedes the earlier sweep\'s items', () => {
  const repo = gitRepo({ 'package.json': text(lines(20)) })
  const hit = (claim, line, over = {}) => ({
    question: 'rate limiting', topic: 'already-present', ground: ['package.json'], kind: 'behaviour', claim,
    spans: [{ path: 'package.json', start: line, end: line, at: '' }], queries: [], sources: [], rests_on: [], ...over,
  })
  const recorded = (name, items) => {
    const out = recordItems(repo, name, items)
    assert.equal(out.ok, true, JSON.stringify(out))
    return out.ids
  }
  const [dropped, repeated] = recorded('20260926-100000-solutions', [hit('package.json: limiter ^1', 3), hit('package.json: kept by both', 5)])
  const [again, fresh] = recorded('20260926-110000-solutions', [hit('package.json: kept by both', 5), hit('package.json: limiter ^2', 3)])
  const [other] = recorded('20260926-120000-solutions', [hit('package.json: another capability', 7, { question: 'caching' })])
  const surveyed = recorded('20260926-130000-survey', [hit('line 3 names a limiter', 3), hit('line 5 names another', 5)])

  const ids = itemsFor(repo, { ground: ['package.json'] }).map((i) => i.id)
  assert.ok(!ids.includes(dropped), 'the earlier sweep\'s item the later one did not repeat is superseded')
  assert.equal(again, repeated, 'a repeated claim is the same item')
  assert.ok(ids.includes(repeated), 'and stands, as its latest revision')
  assert.ok(ids.includes(fresh))
  assert.ok(ids.includes(other), 'another capability is another question')
  for (const id of surveyed) assert.ok(ids.includes(id), 'a survey\'s items keep their own rule')
  assert.ok(readFileSync(evidenceItemsPath(repo), 'utf8').includes(dropped), 'the log keeps its lines')
})
