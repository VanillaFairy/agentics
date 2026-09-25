// test/citations.test.mjs — the citation resolver against real files.
//
// What is pinned here:
//
//   extraction   path:line, path:from-to, bare paths, and what is NOT a citation
//   merging      overlapping windows in one file collapse into the fewest that cover them
//   the three    resolved / out_of_range / missing, kept apart
//   discipline   nothing outside the repository is read, and a dead citation is a FINDING
//   locations    the survey's Resolve step: scout locations in, merged excerpts out, under a
//                digest on both sides of the courier
//
// Design: docs/DESIGN.md#what-a-probe-costs, docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { citationsIn, mergeRanges, resolveCitations, resolveLocations, safePath } from '../lib/citations.mjs'
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
  assert.ok(out.counts.bytes > 0, 'the judge split is earned by bytes too, so they are counted')
  assert.deepEqual(Object.keys(out).sort(), ['counts', 'files', 'notes', 'repo', 'unresolved'])
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
  assert.match(out.notes, /4 location\(s\) could not be read/)
})

test('an absolute path inside the repository is read as the relative one it is', () => {
  const dir = repo({ 'src/a.js': numbered(5, 'line') })
  const out = resolveLocations(dir, [{ path: dir + '/src/a.js', line: 2 }], 1)
  assert.deepEqual(out.files.map((f) => [f.path, f.excerpts[0].from, f.excerpts[0].to]), [['src/a.js', 1, 3]])
  assert.deepEqual(out.unresolved, [])
})

const b64 = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
const excerptsCli = (args) => JSON.parse(execFileSync(process.execPath, [CLI, 'excerpts', ...args], { encoding: 'utf8' }))

test('the excerpts CLI decodes the minted locations, checks their digest, and prints an envelope', () => {
  const dir = repo({ 'src/a.js': numbered(20, 'line') })
  const locations = [{ path: 'src/a.js', line: 10 }]
  const out = excerptsCli(['--repo', dir, '--b64', b64(locations), '--digest', fnv1a(canonical(locations)), '--context', '2'])

  assert.equal(out.payload_digest, fnv1a(canonical(out.payload)))
  assert.deepEqual(out.payload.files[0].excerpts.map((e) => [e.from, e.to]), [[8, 12]])
})

test('the excerpts CLI refuses a token that changed in transit, and reads nothing', () => {
  const dir = repo({ 'src/a.js': numbered(20, 'line') })
  const out = excerptsCli(['--repo', dir, '--b64', b64([{ path: 'src/a.js', line: 10 }]), '--digest', 'deadbeef'])

  assert.equal(out.payload.ok, false)
  assert.equal(out.payload.error.kind, 'digest_mismatch')
  assert.equal(out.payload_digest, fnv1a(canonical(out.payload)), 'a refusal is a payload, carried like any other')
})

test('the excerpts CLI refuses an argument that is not a list of locations', () => {
  const dir = repo({ 'src/a.js': 'x\n' })
  const value = { path: 'src/a.js', line: 1 }
  const out = excerptsCli(['--repo', dir, '--b64', b64(value), '--digest', fnv1a(canonical(value))])
  assert.equal(out.payload.error.kind, 'bad_args')
})

function writeArtifact(dir, text) {
  const path = join(dir, 'artifact.md')
  writeFileSync(path, text + '\n', 'utf8')
  return path.split('\\').join('/')
}
