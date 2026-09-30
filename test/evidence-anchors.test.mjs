// test/evidence-anchors.test.mjs — the first rung of the drift ladder: whether an item's anchors
// are unchanged, decided by git and never by a model, and what a re-judge's verdict does to it.
// This file holds the span arithmetic and the span anchors; the test/evidence-anchors-*.test.mjs
// files hold the rest, one concern each so they run side by side.
//
// Every expectation is computed from the fixture's own text, because what these tests pin is the
// arithmetic of mapping a span through hunks, and a pinned line number would only pin a guess.
//
// Design: docs/DESIGN.md#evidence.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { hunksOf, liveItems, mapSpan, snapshotSpec } from '../lib/evidence.mjs'
import {
  commit, git, gitRepo, lines, record, span, spanFixture, specFixture, stateOf, text, withLine, write,
} from './harness/evidence-fixture.mjs'

// ------------------------------------------------------------------ the pure half

test('hunksOf reads the -U0 headers, an omitted count meaning one', () => {
  const diff = ['diff --git a/x b/x', '@@ -3 +3 @@', '-a', '+b', '@@ -5,0 +6,2 @@ ctx', '+x', '+y',
    '@@ -9,2 +10,0 @@', '-p', '-q'].join('\n')
  assert.deepEqual(hunksOf(diff), [
    { oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 },
    { oldStart: 5, oldCount: 0, newStart: 6, newCount: 2 },
    { oldStart: 9, oldCount: 2, newStart: 10, newCount: 0 },
  ])
})

test('mapSpan: a hunk above shifts the span, one touching it changes it, one below leaves it', () => {
  const S = 10
  const E = 14
  // A hunk as `git diff -U0` writes it. A pure insertion (old count 0) sits after old line
  // `oldStart`, so its new lines start one further on; a pure deletion's `newStart` is the line
  // before where it was. `shift` is the net delta of the hunks above this one.
  const h = (oldStart, oldCount, newCount, shift = 0) => ({
    oldStart, oldCount, newCount,
    newStart: shift + (oldCount === 0 ? oldStart + 1 : newCount === 0 ? oldStart - 1 : oldStart),
  })
  const straddle = h(S - 2, 4, 2)    // old 8-11 become two lines; the span keeps old 12-14
  const covering = h(S - 1, 7, 3)    // old 9-15 become three lines
  const cases = [
    ['wholly above', [h(2, 2, 5)], { changed: false, start: S + 3, end: E + 3 }],
    ['ends on the line before the span', [h(8, 2, 1)], { changed: false, start: S - 1, end: E - 1 }],
    ['starts above, ends inside', [straddle], { changed: true, start: straddle.newStart, end: E - 2 }],
    ['one hunk covers the whole span', [covering],
      { changed: true, start: covering.newStart, end: covering.newStart + covering.newCount - 1 }],
    ['on the first line', [h(S, 1, 1)], { changed: true, start: S, end: E }],
    ['on the last line', [h(E, 1, 1)], { changed: true, start: S, end: E }],
    // Old 12-15 go: span lines 10 and 11 survive where they were; line 15 was never the span's.
    ['deletes across the end', [h(12, 4, 0)], { changed: true, start: S, end: S + 1 }],
    ['deletes exactly the span, leaving it empty', [h(S, E - S + 1, 0)], { changed: true, start: S, end: S - 1 }],
    ['the line after the span', [h(E + 1, 1, 4)], { changed: false, start: S, end: E }],
    ['pure add between the line before and the first', [h(S - 1, 0, 2)], { changed: false, start: S + 2, end: E + 2 }],
    ['pure add between two span lines', [h(S, 0, 2)], { changed: true, start: S, end: E + 2 }],
    ['pure add before the last line', [h(E - 1, 0, 1)], { changed: true, start: S, end: E + 1 }],
    ['pure add after the last line', [h(E, 0, 3)], { changed: false, start: S, end: E }],
    ['pure add at the top of the file', [h(0, 0, 1)], { changed: false, start: S + 1, end: E + 1 }],
    ['above and inside together', [h(2, 2, 5), h(12, 1, 2, 3)], { changed: true, start: S + 3, end: E + 3 + 1 }],
  ]
  for (const [name, hunks, expected] of cases) assert.deepEqual(mapSpan(hunks, S, E), expected, name)
})

// ------------------------------------------------------------------ span anchors

test('a span no hunk touches stands, however far the lines above it moved', () => {
  const { repo, id } = spanFixture()
  write(repo, 'src/a.js', text(['new 1', 'new 2', 'new 3', 'new 4', 'new 5', ...lines(30)]))
  commit(repo)
  assert.deepEqual(stateOf(repo, id).changed, [])
  assert.equal(stateOf(repo, id).state, 'standing')

  write(repo, 'src/a.js', text(lines(30).slice(2)))
  commit(repo)
  assert.equal(stateOf(repo, id).state, 'standing', 'lines removed above shift it the other way')

  write(repo, 'src/a.js', text(withLine(lines(30).slice(2), 20, 'below, edited')))
  commit(repo)
  assert.equal(stateOf(repo, id).state, 'standing', 'an edit below touches nothing')
})

test('an edit inside the span makes the item suspect, with the old and the new text', () => {
  const { repo, id } = spanFixture()
  const edited = withLine(lines(30), 12, 'line twelve')
  write(repo, 'src/a.js', text(edited))
  commit(repo)

  const st = stateOf(repo, id)
  assert.equal(st.state, 'suspect')
  assert.deepEqual(st.changed.map((c) => [c.anchor, c.index]), [['span', 0]])
  assert.equal(st.changed[0].old, lines(30).slice(9, 14).join('\n'))
  assert.equal(st.changed[0].now, edited.slice(9, 14).join('\n'))
})

test('an uncommitted edit counts; one outside the span does not', () => {
  const { repo, id } = spanFixture()
  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve')))
  assert.equal(stateOf(repo, id).state, 'suspect')

  write(repo, 'src/a.js', text(withLine(lines(30), 25, 'line twenty-five')))
  assert.equal(stateOf(repo, id).state, 'standing')
})

test('a rename is followed to the file the lines now live in', () => {
  const { repo, id } = spanFixture()
  git(repo, 'mv', 'src/a.js', 'src/b.js')
  commit(repo)
  assert.equal(stateOf(repo, id).state, 'standing')

  const moved = withLine(lines(30), 12, 'line twelve')
  write(repo, 'src/b.js', text(moved))
  const st = stateOf(repo, id)
  assert.equal(st.state, 'suspect')
  assert.equal(st.changed[0].now, moved.slice(9, 14).join('\n'), 'the new text is read from where the file went')
})

test('a committed rename plus an edit outside the span stands', () => {
  const { repo, id } = spanFixture()
  git(repo, 'mv', 'src/a.js', 'src/b.js')
  write(repo, 'src/b.js', text(withLine(lines(30), 25, 'line twenty-five')))
  commit(repo)
  assert.equal(stateOf(repo, id).state, 'standing')
})

test('a rename below git\'s similarity threshold is suspect', () => {
  const { repo, id } = spanFixture()
  git(repo, 'mv', 'src/a.js', 'src/b.js')
  write(repo, 'src/b.js', text(lines(30, 'rewritten')))
  commit(repo)
  assert.equal(stateOf(repo, id).state, 'suspect', 'git sees a deletion and an addition; the span is never silently standing')
})

test('an unstaged plain mv reads as a deletion: suspect, with an empty now', () => {
  const { repo, id } = spanFixture()
  renameSync(join(repo, 'src', 'a.js'), join(repo, 'src', 'b.js'))
  const st = stateOf(repo, id)
  assert.equal(st.state, 'suspect')
  assert.equal(st.changed[0].now, '', 'git sees no rename of a file it does not track')
})

test('a deleted and committed file makes its spans suspect, with an empty now', () => {
  const { repo, id } = spanFixture()
  rmSync(join(repo, 'src', 'a.js'))
  commit(repo)
  const st = stateOf(repo, id)
  assert.equal(st.state, 'suspect')
  assert.equal(st.changed[0].now, '')
})

test('a file deleted but not committed makes its spans suspect, with an empty now', () => {
  const { repo, id } = spanFixture()
  rmSync(join(repo, 'src', 'a.js'))
  const st = stateOf(repo, id)
  assert.equal(st.state, 'suspect')
  assert.equal(st.changed[0].now, '')
})

test('lines appended after a span ending on the file\'s last line leave it standing', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const id = record(repo, span('src/a.js', 26, 30))
  write(repo, 'src/a.js', text([...lines(30), 'appended 1', 'appended 2']))
  commit(repo)
  assert.equal(stateOf(repo, id).state, 'standing')
})

test('a comment typo inside a span makes the item suspect, not stale; one outside every span changes nothing', () => {
  const code = [
    'export function load(path) {',
    '  const raw = read(path)',
    '  // retreive the parsed value',
    '  const value = parse(raw)',
    '  return value',
    '}',
    ...lines(20, '// filler'),
  ]
  code[19] = '// recieve the next batch'
  const repo = gitRepo({ 'src/load.js': text(code) })
  const id = record(repo, span('src/load.js', 1, 6))

  const outside = code.map((l) => l.replace('recieve', 'receive'))
  write(repo, 'src/load.js', text(outside))
  assert.equal(stateOf(repo, id).state, 'standing', 'a typo outside every span re-buys nothing')

  write(repo, 'src/load.js', text(outside.map((l) => l.replace('retreive', 'retrieve'))))
  const st = stateOf(repo, id)
  assert.equal(st.state, 'suspect', 'a typo inside a span costs a re-judge, never a re-survey')
  assert.match(st.changed[0].old, /retreive/)
  assert.match(st.changed[0].now, /retrieve/)
})

test('a gitignored spec is diffed against its snapshot', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  const path = '.agentics/e1/DESIGN.md'
  const spec = lines(40, 'spec')
  write(repo, path, text(spec))
  const at = snapshotSpec(repo, text(spec))
  const id = record(repo, {
    kind: 'behaviour', claim: 'the plan lists five tasks', ground: ['.agentics/e1'],
    spans: [{ path, start: 20, end: 24, at }],
  })
  assert.equal(git(repo, 'status', '--porcelain'), '', 'the spec is ignored, so git history alone cannot see it')

  const typo = withLine(spec, 5, 'spec five, edited')
  write(repo, path, text(typo))
  assert.equal(stateOf(repo, id).state, 'standing', 'an edit above the span')

  const grown = ['added a', 'added b', ...typo]
  write(repo, path, text(grown))
  assert.equal(stateOf(repo, id).state, 'standing', 'lines added above the span')

  const inside = withLine(grown, 22 + 2, 'spec 22, edited')
  write(repo, path, text(inside))
  const st = stateOf(repo, id)
  assert.equal(st.state, 'suspect')
  assert.equal(st.changed[0].old, spec.slice(19, 24).join('\n'))
  assert.equal(st.changed[0].now, inside.slice(19 + 2, 24 + 2).join('\n'))
})

test('a gitignored spec deleted from disk makes its snapshot spans suspect, with an empty now', () => {
  const { repo, path, id } = specFixture()
  rmSync(join(repo, ...path.split('/')))
  const st = stateOf(repo, id)
  assert.equal(st.state, 'suspect')
  assert.equal(st.changed[0].now, '')
})

test('a span whose snapshot file is gone from the store is stale, not thrown', () => {
  const { repo, id, file } = specFixture()
  rmSync(file)
  assert.equal(stateOf(repo, id).state, 'stale')
})

test('a torn snapshot reads as stale until snapshotSpec rewrites it', () => {
  const { repo, spec, id, file } = specFixture()
  writeFileSync(file, text(spec).slice(0, 20))
  assert.equal(stateOf(repo, id).state, 'stale', 'a snapshot whose text does not hash to its name is not the old text')
  snapshotSpec(repo, text(spec))
  assert.equal(readFileSync(file, 'utf8'), text(spec))
  assert.equal(stateOf(repo, id).state, 'standing')
})

test('a span anchored at a commit the repository no longer has is stale, not thrown', () => {
  const { repo, id } = spanFixture()
  const at = liveItems(repo).get(id).spans[0].at
  git(repo, 'commit', '--amend', '-qm', 'history rewritten')
  rmSync(join(repo, '.git', 'ORIG_HEAD'), { force: true })
  git(repo, 'reflog', 'expire', '--expire=now', '--all')
  git(repo, 'gc', '-q', '--prune=now')
  assert.throws(() => git(repo, 'cat-file', '-e', at + '^{commit}'), Error, 'the fixture really lost the commit')
  assert.equal(stateOf(repo, id).state, 'stale')
})

test('a CRLF working copy of the snapshotted text is the same text', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  const path = '.agentics/e1/DESIGN.md'
  const spec = lines(12, 'spec')
  write(repo, path, text(spec))
  const id = record(repo, {
    kind: 'behaviour', claim: 'the spec says so', ground: ['.agentics/e1'],
    spans: [{ path, start: 3, end: 5, at: snapshotSpec(repo, text(spec)) }],
  })
  write(repo, path, text(spec, '\r\n'))
  assert.equal(stateOf(repo, id).state, 'standing')
})

test('a committed LF file checked out CRLF under core.autocrlf=true stands', () => {
  const { repo, id } = spanFixture()
  git(repo, 'config', 'core.autocrlf', 'true')
  write(repo, 'src/a.js', text(lines(30), '\r\n'))
  assert.equal(stateOf(repo, id).state, 'standing')

  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve'), '\r\n'))
  const st = stateOf(repo, id)
  assert.equal(st.state, 'suspect')
  assert.ok(!st.changed[0].old.includes('\r') && !st.changed[0].now.includes('\r'), 'the re-judge reads text, not line endings')
})
