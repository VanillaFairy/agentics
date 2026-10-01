// test/citations.test.mjs — the citation resolver against real files.
//
// What is pinned here:
//
//   extraction   path:line, path:from-to, bare paths, and what is NOT a citation
//   merging      overlapping windows in one file collapse into the fewest that cover them
//   the three    resolved / out_of_range / missing, kept apart
//   discipline   nothing outside the repository is read, and a dead citation is a FINDING
//   reports      the Assemble-context step: scouts' report files in, their hits and merged excerpts
//                written to one context file, its path out under a digest
//
// Design: docs/DESIGN.md#what-a-probe-costs, docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  citationsIn, mergeRanges, resolveCitations, resolveLocations, safePath, splitParts, writeContext,
} from '../lib/citations.mjs'
import { contextDir } from '../lib/store.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'

const CLI = fileURLToPath(new URL('../lib/citations.mjs', import.meta.url))

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-cite-')).split('\\').join('/')
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

const numbered = (n, tag) => Array.from({ length: n }, (_, i) => tag + (i + 1)).join('\n')

test('a citation is a path, optionally with a line or a range', () => {
  const found = citationsIn('see `lib/kb.mjs:61` and lib/programme.mjs:717-720, plus CLAUDE.md.')
  assert.deepEqual(found.map((c) => [c.path, c.from, c.to]), [
    ['lib/kb.mjs', 61, 61],
    ['lib/programme.mjs', 717, 720],
    ['CLAUDE.md', 0, 0],
  ])
})

test('a version string and a decimal are not citations', () => {
  assert.deepEqual(citationsIn('bumped to 1.13.0 after 2.5 hours'), [])
})

test('the same location cited twice is resolved once; two lines in one file are two', () => {
  const found = citationsIn('lib/kb.mjs:61 ... lib/kb.mjs:61 ... lib/kb.mjs:717')
  assert.equal(found.length, 2)
})

test('a citation that could climb out of the repository is dropped', () => {
  assert.equal(safePath('../../etc/passwd.txt'), null)
  assert.deepEqual(citationsIn('see ../../secrets.env:3'), [])
})

test('overlapping windows merge; separated ones do not', () => {
  assert.deepEqual(mergeRanges([{ from: 1, to: 20 }, { from: 15, to: 30 }, { from: 90, to: 95 }]),
    [{ from: 1, to: 30 }, { from: 90, to: 95 }])
  assert.deepEqual(mergeRanges([{ from: 10, to: 12 }, { from: 13, to: 15 }]),
    [{ from: 10, to: 15 }])
})

test('excerpts are line-numbered, padded by context, and clamped to the file', () => {
  const dir = repo({ 'src/a.js': numbered(40, 'line') })
  const out = resolveCitations(dir, writeArtifact(dir, 'cites src/a.js:3'), 5)

  const file = out.files[0]
  assert.equal(file.lines, 40)
  assert.deepEqual(file.excerpts.map((e) => [e.from, e.to]), [[1, 8]])
  assert.match(file.excerpts[0].text, /^\s+1\tline1\n/)
  assert.equal(out.counts.unresolved, 0)
})

test('three citations near each other buy one excerpt, not three', () => {
  const dir = repo({ 'src/a.js': numbered(200, 'line') })
  const out = resolveCitations(dir, writeArtifact(dir, 'src/a.js:100 src/a.js:104 src/a.js:180'), 10)
  assert.deepEqual(out.files[0].excerpts.map((e) => [e.from, e.to]), [[90, 114], [170, 190]])
})

test('a missing file and a line past the end are different findings, and both travel', () => {
  const dir = repo({ 'src/a.js': numbered(5, 'line') })
  const out = resolveCitations(dir, writeArtifact(dir, 'src/a.js:99 and src/ghost.js:2'), 3)

  assert.deepEqual(out.unresolved.map((u) => [u.path, u.why]).sort(),
    [['src/a.js', 'out_of_range'], ['src/ghost.js', 'missing']])
})

test('an unreadable artefact says so rather than reporting an empty resolution', () => {
  const dir = repo({ 'src/a.js': 'x\n' })
  const out = resolveCitations(dir, join(dir, 'no-such-document.md'), 3)
  assert.notEqual(out.read_error, '')
  assert.deepEqual(out.files, [])
})

test('the payload says how long the artefact is, and zero when it could not be read', () => {
  const dir = repo({ 'src/a.js': 'x\n' })
  const body = numbered(37, 'para')
  assert.equal(resolveCitations(dir, writeArtifact(dir, body), 3).artifact_lines,
    body.split('\n').length)
  assert.equal(resolveCitations(dir, join(dir, 'no-such-document.md'), 3).artifact_lines, 0)
})

test('a document citing nothing resolvable is a clean empty payload, not an error', () => {
  const dir = repo({ 'src/a.js': 'x\n' })
  const out = resolveCitations(dir, writeArtifact(dir, 'a design with no citations at all'), 3)
  assert.deepEqual(out.files, [])
  assert.deepEqual(out.unresolved, [])
  assert.equal(out.counts.cited, 0)
})

// ------------------------------------------------------------------ scout locations

test('locations in one file merge into the fewest windows, whichever scout reported them', () => {
  const dir = repo({ 'src/a.js': numbered(200, 'line'), 'src/b.js': numbered(10, 'b') })
  const out = resolveLocations(dir, [
    { path: 'src/a.js', line: 100 }, { path: 'src/a.js', line: 104 },
    { path: 'src/a.js', line: 100 }, { path: 'src/a.js', line: 180 },
    { path: 'src/b.js', line: 2 },
  ], 10)

  assert.deepEqual(out.files.map((f) => f.path), ['src/a.js', 'src/b.js'])
  assert.deepEqual(out.files[0].excerpts.map((e) => [e.from, e.to]), [[90, 114], [170, 190]])
  assert.deepEqual(out.files[1].excerpts.map((e) => [e.from, e.to]), [[1, 10]])
  assert.match(out.files[1].excerpts[0].text, /^\s+1\tb1\n/)
  assert.equal(out.counts.excerpts, 3)
  assert.equal(out.counts.locations, 5)
  assert.ok(out.counts.bytes > 0)
})

test('a location that cannot be read is reported per location, in three kinds', () => {
  const dir = repo({ 'src/a.js': numbered(5, 'line') })
  const out = resolveLocations(dir, [
    { path: 'src/a.js', line: 99 },
    { path: 'src/ghost.js', line: 1 },
    { path: '../../etc/passwd', line: 1 },
    { path: '/somewhere/else/entirely.js', line: 1 },
  ], 3)

  assert.deepEqual(out.unresolved.map((u) => [u.path, u.why]).sort(), [
    ['../../etc/passwd', 'outside'],
    ['/somewhere/else/entirely.js', 'outside'],
    ['src/a.js', 'out_of_range'],
    ['src/ghost.js', 'missing'],
  ])
  assert.deepEqual(out.files, [], 'a file whose only location is past its end yields no window')
  assert.equal(out.counts.unresolved, 4)
})

test('an absolute path inside the repository is read as the relative one it is', () => {
  const dir = repo({ 'src/a.js': numbered(5, 'line') })
  const out = resolveLocations(dir, [{ path: dir + '/src/a.js', line: 2 }], 1)
  assert.deepEqual(out.files.map((f) => [f.path, f.excerpts[0].from, f.excerpts[0].to]), [['src/a.js', 1, 3]])
  assert.deepEqual(out.unresolved, [])
})

const cli = (...args) => {
  const out = JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }))
  assert.equal(out.payload_digest, fnv1a(canonical(out.payload)))
  return out.payload
}

function report(dir, value) {
  const path = join(dir, 'report-' + fnv1a(JSON.stringify(value)) + '.json').split('\\').join('/')
  writeFileSync(path, JSON.stringify(value), 'utf8')
  return path
}

test('the excerpts CLI reads the scouts\' own report files and writes their hits and excerpts to one context file', () => {
  const dir = repo({ 'src/a.js': numbered(20, 'line') })
  const scout = report(dir, {
    hits: [{ path: 'src/a.js', line: 10, note: 'the loader', kind: 'ground' }, { path: 'src/ghost.js', line: 3, note: 'gone', kind: 'ground' },
      { path: 'CLAUDE.md', line: 1, note: 'guidance', kind: 'guidance' }],
    searched: ['grep load'], no_match: 'no retry anywhere', not_reached: 'lib/', stop_reason: 'unfinished',
  })
  const out = cli('excerpts', '--repo', dir, '--hits', scout, '--hits', join(dir, 'missing.json'), '--hit-kind', 'ground', '--context', '2')

  assert.ok(out.context.startsWith(resolve(contextDir(dir)).split('\\').join('/') + '/'))
  assert.deepEqual([out.counts.reports, out.counts.unread_reports, out.counts.locations], [2, 1, 2])
  const text = readFileSync(out.context, 'utf8')
  assert.match(text, /the search did NOT finish \(unfinished\)\nLOCATIONS FOUND:\n  src\/a\.js:10 — the loader\n  src\/ghost\.js:3 — gone\n/)
  assert.match(text, /SEARCHED AND NOT FOUND \(evidence of absence\):\n  no retry anywhere\nNEVER SEARCHED: lib\//)
  assert.match(text, /missing\.json — this report could not be read/)
  assert.match(text, /--- src\/a\.js \(20 line\(s\)\)\n\s+8\tline8\n/)
  assert.match(text, /NOT EXCERPTED[\s\S]*src\/ghost\.js:3 — missing/, 'what was not read is named in the file')
  assert.doesNotMatch(text, /guidance/, 'a hit of another kind is left out')
})

test('the excerpts CLI refuses an argument that is not a handle, and reads nothing', () => {
  const dir = repo({ 'src/a.js': numbered(20, 'line') })
  assert.deepEqual(cli('excerpts', '--repo', dir, '--hit-kind', 'two words'), { ok: false, error: { kind: 'args_unreadable' } })
  assert.ok(!existsSync(contextDir(dir)))
})

test('the cited CLI writes the document\'s cited lines, dead citations last, and prints the file and counts', () => {
  const dir = repo({ 'src/a.js': numbered(20, 'line') })
  const artifact = writeArtifact(dir, 'see src/a.js:10 and src/gone.js:4')
  const out = cli('cited', '--repo', dir, '--file', artifact, '--context', '2')

  assert.deepEqual([out.readable, out.counts.unresolved, out.artifact_lines], [true, 1, 1])
  const text = readFileSync(out.context, 'utf8')
  assert.match(text, /--- src\/a\.js \(20 line\(s\); the document cites 10\)\n\s+8\tline8\n/)
  assert.match(text, /CITATIONS THAT RESOLVE TO NOTHING[\s\S]*src\/gone\.js/)
  assert.deepEqual(cli('cited', '--repo', dir, '--file', join(dir, 'no-such.md')), {
    readable: false, context: '', counts: { cited: 0, files: 0, excerpts: 0, unresolved: 0 }, artifact_lines: 0,
  })
})

test('context longer than one Read is named by an index of its parts', () => {
  const dir = repo({})
  const text = Array.from({ length: 2000 }, (_, i) => 'line ' + i).join('\n')
  const out = writeContext(dir, text)
  assert.ok(out.parts.length > 1)
  assert.equal(readFileSync(out.path, 'utf8').split('\n').filter((l) => l.startsWith('  ')).map((l) => l.trim()).join(','), out.parts.join(','))
  assert.equal(out.parts.map((p) => readFileSync(p, 'utf8')).join('\n'), text)
})

test('the same text written twice lands in the same files, not new ones', () => {
  const dir = repo({})
  const first = writeContext(dir, 'the same text\n')
  const second = writeContext(dir, 'the same text\n')
  assert.deepEqual(second.parts, first.parts)
  assert.equal(readdirSync(contextDir(dir)).length, 1)
})

test('context is cut into parts one Read returns whole, at line boundaries', () => {
  const text = Array.from({ length: 50 }, (_, i) => 'x'.repeat(99) + i).join('\n')
  const parts = splitParts(text, 1000, 30)
  assert.equal(parts.join('\n'), text, 'nothing is lost or duplicated at a cut')
  assert.ok(parts.every((p) => Buffer.byteLength(p) <= 1000))
  assert.ok(splitParts(text, 1e9, 30).every((p) => p.split('\n').length <= 30))
})

test('context files a week old are pruned when a new one is written', () => {
  const dir = repo({})
  const stale = join(contextDir(dir), 'old-1.md')
  mkdirSync(dirname(stale), { recursive: true })
  writeFileSync(stale, 'old', 'utf8')
  const week = 7 * 24 * 60 * 60 * 1000

  writeContext(dir, 'a\n', Date.now() + week - 60000)
  assert.ok(existsSync(stale), 'younger than a week, kept')
  writeContext(dir, 'b\n', Date.now() + week + 60000)
  assert.ok(!existsSync(stale))
})

function writeArtifact(dir, text) {
  const path = join(dir, 'artifact.md')
  writeFileSync(path, text + '\n', 'utf8')
  return path.split('\\').join('/')
}
