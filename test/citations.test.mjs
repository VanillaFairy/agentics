// test/citations.test.mjs — the citation resolver against real files.
//
// What is pinned here:
//
//   extraction   path:line, path:from-to, bare paths, and what is NOT a citation
//   merging      overlapping windows in one file collapse into the fewest that cover them
//   the three    resolved / out_of_range / missing, kept apart
//   discipline   nothing outside the repository is read, and a dead citation is a FINDING
//
// Design: docs/DESIGN.md#what-a-probe-costs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { citationsIn, mergeRanges, resolveCitations, safePath } from '../lib/citations.mjs'

const CLI = fileURLToPath(new URL('../lib/citations.mjs', import.meta.url))

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'vfa-cite-')).split('\\').join('/')
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
  assert.match(out.notes, /resolved to nothing/)
})

test('an unreadable artefact says so rather than reporting an empty resolution', () => {
  const dir = repo({ 'src/a.js': 'x\n' })
  const out = resolveCitations(dir, join(dir, 'no-such-document.md'), 3)
  assert.notEqual(out.read_error, '')
  assert.deepEqual(out.files, [])
  assert.match(out.notes, /must locate the document's evidence itself/)
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

test('the CLI prints the payload under its own digest', () => {
  const dir = repo({ 'src/a.js': numbered(20, 'line') })
  const artifact = writeArtifact(dir, 'see src/a.js:10')
  const out = JSON.parse(execFileSync(process.execPath, [CLI, dir, artifact, '--context', '2'],
    { encoding: 'utf8' }))

  assert.match(out.payload_digest, /^[0-9a-f]{8}$/)
  assert.deepEqual(out.payload.files[0].excerpts.map((e) => [e.from, e.to]), [[8, 12]])
})

function writeArtifact(dir, text) {
  const path = join(dir, 'artifact.md')
  writeFileSync(path, text + '\n', 'utf8')
  return path.split('\\').join('/')
}
