// test/evidence-anchors.test.mjs — the first rung of the drift ladder: whether an item's anchors
// are unchanged, decided by git and never by a model, and what a re-judge's verdict does to it.
//
// Every expectation is computed from the fixture's own text, because what these tests pin is the
// arithmetic of mapping a span through hunks, and a pinned line number would only pin a guess.
//
// Design: docs/DESIGN.md#evidence.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  checkAnchors, hunksOf, itemId, itemsFor, liveItems, mapSpan, recordItems, recordJudgement, recordRaw, reviewScope, snapshotSpec,
} from '../lib/evidence.mjs'
import { appendProject, readProjectLog } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { configPath, evidenceItemsPath, evidenceReturnsDir, evidenceSnapshotsDir } from '../lib/store.mjs'

const CLI = fileURLToPath(new URL('../lib/evidence.mjs', import.meta.url))
const RETURN = '20260926-100000-survey'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

const lines = (n, word = 'line') => Array.from({ length: n }, (_, i) => word + ' ' + (i + 1))
const text = (ls, eol = '\n') => ls.join(eol) + eol

function write(dir, path, content) {
  const full = join(dir, ...path.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function gitRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-anchors-'))
  git(dir, 'init', '-q', '.')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'core.autocrlf', 'false')
  for (const [path, content] of Object.entries(files)) write(dir, path, content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

const commit = (dir) => {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'edit')
  return git(dir, 'rev-parse', 'HEAD')
}

const itemOf = (item) => ({
  question: 'q', topic: 't', ground: ['src'], spans: [], queries: [], sources: [], rests_on: [], ...item,
})

/** Record one item through the real recorder and return its id. */
function record(repo, item, opts) {
  const out = recordItems(repo, RETURN, [itemOf(item)], opts)
  assert.equal(out.ok, true, JSON.stringify(out))
  return out.ids[0]
}

const span = (path, start, end, extra = {}) => ({
  kind: 'behaviour', claim: path + ':' + start + '-' + end + ' says what it says',
  spans: [{ path, start, end, at: '' }], ...extra,
})

const stateOf = (repo, id, opts) => checkAnchors(repo, [id], opts)[0]

/** The 30-line file every span test starts from, with its span 10-14 recorded. */
function spanFixture() {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  return { repo, id: record(repo, span('src/a.js', 10, 14)) }
}

const withLine = (ls, lineNo, value) => ls.map((l, i) => (i === lineNo - 1 ? value : l))

/** A gitignored 12-line spec with its span 3-5 recorded at a snapshot, and that snapshot's file. */
function specFixture() {
  const repo = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  const path = '.agentics/e1/DESIGN.md'
  const spec = lines(12, 'spec')
  write(repo, path, text(spec))
  const at = snapshotSpec(repo, text(spec))
  const id = record(repo, {
    kind: 'behaviour', claim: 'the spec says so', ground: ['.agentics/e1'], spans: [{ path, start: 3, end: 5, at }],
  })
  return { repo, path, spec, id, file: join(evidenceSnapshotsDir(repo), at.slice('snapshot:'.length) + '.txt') }
}

/** A linked worktree of `repo` on a new branch, outside the main checkout. */
function linkedWorktree(repo) {
  const wt = join(mkdtempSync(join(tmpdir(), 'agentics-anchors-wt-')), 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'side', wt)
  return wt
}

/** The store's lines of one kind, in seq order. */
const logOf = (repo, kind) => readProjectLog(repo, 'items').entries.filter((e) => e.kind === kind)

/** Run the CLI against `repo`: every verb exits 0 and prints a digest-covered envelope. */
const cli = (repo) => (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.payload_digest, fnv1a(canonical(out.payload)))
  return out.payload
}

const token = (value) => ['--digest', fnv1a(canonical(value)), '--b64', Buffer.from(JSON.stringify(value)).toString('base64')]

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
  assert.deepEqual(logOf(repo, 'judged').map((e) => [e.id, e.verdict, e.at]), [[a, 'fails', head], [b, 'unsure', head]])

  const judged = logOf(repo, 'judged').length
  assert.equal(recordJudgement(repo, 'I00000000', 'holds').ok, false)
  assert.equal(recordJudgement(repo, a, 'maybe').ok, false)
  assert.equal(logOf(repo, 'judged').length, judged, 'a refusal writes nothing')
  assert.equal(stateOf(repo, 'I00000000').state, 'stale', 'an id the store lacks is never standing')
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
  assert.deepEqual([last.id, last.verdict, last.requested], [id, 'unsure', 'holds'])
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

// ------------------------------------------------------------------ reading the pool

test('itemsFor returns the items whose ground overlaps, with their state, standing and suspect by default', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)), 'docs/x.md': text(lines(5)) })
  const src = record(repo, span('src/a.js', 10, 14, { ground: ['src'] }))
  const docs = record(repo, span('docs/x.md', 1, 2, { ground: ['docs'] }))
  const wide = record(repo, span('src/a.js', 1, 2, { ground: ['.'], claim: 'repository-wide' }))
  const wrong = record(repo, span('src/a.js', 20, 21, { ground: ['src'], claim: 'judged wrong' }))
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

// ------------------------------------------------------------------ worktrees

test('a span recorded from a linked worktree is read from the worktree and stored in the main checkout', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const wt = linkedWorktree(repo)
  write(wt, 'src/a.js', text([...lines(30), ...lines(10, 'more')]))
  const head = commit(wt)
  const item = span('src/a.js', 35, 38)
  assert.equal(recordItems(repo, RETURN, [itemOf(item)]).ok, false, 'by default the main checkout is read, and it has no line 35')

  const id = record(repo, item, { root: wt })
  assert.deepEqual(liveItems(repo).get(id).spans, [{ path: 'src/a.js', start: 35, end: 38, at: head }])
  assert.ok(existsSync(evidenceItemsPath(repo)))
  assert.equal(existsSync(join(wt, '.agentics')), false, 'nothing is written in the worktree')
})

test('checkAnchors given a worktree root reads the worktree: an edit only in the worktree makes the item suspect', () => {
  const { repo, id } = spanFixture()
  const wt = linkedWorktree(repo)
  const edited = withLine(lines(30), 12, 'line twelve')
  write(wt, 'src/a.js', text(edited))
  assert.equal(stateOf(wt, id).state, 'standing', 'without a root the main checkout is read, and it is untouched')

  const st = stateOf(repo, id, { root: wt })
  assert.equal(st.state, 'suspect', 'the worktree is the checkout the run is in')
  assert.equal(st.changed[0].now, edited.slice(9, 14).join('\n'), 'its text is the worktree\'s')

  const listed = record(repo, {
    kind: 'enumeration', claim: 'src has one line 7', queries: [{ pattern: '^line 7$', scope: ['src'] }],
  })
  write(wt, 'src/new.js', text(['line 7']))
  assert.equal(stateOf(wt, listed).state, 'standing', 'the main checkout has no src/new.js')
  const q = stateOf(repo, listed, { root: wt })
  assert.equal(q.state, 'suspect', 'a query is re-run in the worktree, untracked files included')
  assert.match(q.changed[0].now, /src\/new\.js/)

  commit(wt)
  assert.equal(stateOf(wt, id, { root: wt }).state, 'suspect', 'a commit on the worktree\'s branch is read there too')
  assert.equal(stateOf(repo, id).state, 'standing')

  const judged = recordJudgement(repo, listed, 'holds', { root: wt })
  assert.deepEqual([judged.ok, judged.state], [true, 'standing'], JSON.stringify(judged))
  assert.deepEqual(liveItems(repo).get(listed).queries[0].result.map((r) => r.path), ['src/a.js', 'src/new.js'],
    'a holds re-runs the query in the worktree')
  assert.equal(existsSync(join(wt, '.agentics')), false, 'nothing is written in the worktree')
})

test('itemsFor and holds read the root they are given: a holds judged in a worktree re-anchors at the worktree\'s HEAD', () => {
  const { repo, id } = spanFixture()
  const wt = linkedWorktree(repo)
  const edited = ['top', ...withLine(lines(30), 12, 'line twelve')]
  write(wt, 'src/a.js', text(edited))
  const head = commit(wt)

  assert.deepEqual(itemsFor(repo, { ground: ['src'] }).map((i) => [i.id, i.state]), [[id, 'standing']])
  assert.deepEqual(itemsFor(repo, { ground: ['src'], root: wt }).map((i) => [i.id, i.state]), [[id, 'suspect']])

  const out = recordJudgement(repo, id, 'holds', { root: wt })
  assert.deepEqual([out.ok, out.state], [true, 'standing'], JSON.stringify(out))
  assert.deepEqual(liveItems(repo).get(id).spans, [{
    path: 'src/a.js', start: edited.indexOf('line 10') + 1, end: edited.indexOf('line 14') + 1, at: head,
  }], 'the lines and the HEAD the judge read')
  assert.equal(logOf(repo, 'judged').at(-1).at, head)
  assert.equal(existsSync(join(wt, '.agentics')), false, 'the store stays in the main checkout')
})

test('reviewScope reads the root it is given, and maps a worktree path to the same repository-relative path', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  const wt = linkedWorktree(repo)
  const spec = '.agentics/e1/DESIGN.md'
  write(repo, '.agentics/.gitignore', '*\n')
  write(repo, spec, text(lines(12, 'spec')))
  write(wt, spec, text(lines(20, 'spec')))
  for (const file of [join(wt, '.agentics', 'e1', 'DESIGN.md'), spec]) {
    const main = reviewScope(wt, file)
    assert.equal(main.ok, true, JSON.stringify(main))
    assert.deepEqual([main.path, main.lines], [spec, 12], 'without a root, the main checkout: ' + file)
    const here = reviewScope(wt, file, '', { root: wt })
    assert.equal(here.ok, true, JSON.stringify(here))
    assert.deepEqual([here.path, here.lines], [spec, 20], 'with the worktree as root, the worktree: ' + file)
  }

  const s = reviewScope(repo, spec).snapshot
  const finding = record(repo, {
    question: spec, topic: 'challenge:yagni', ground: [spec], kind: 'behaviour',
    claim: 'a yagni finding at 5', spans: [{ path: spec, start: 5, end: 7, at: s }],
    detail: { axis: 'yagni', severity: 'note', section: '§1', evidence: 'e' },
  })
  write(wt, spec, text(withLine(lines(20, 'spec'), 6, 'spec 6, edited')))
  assert.deepEqual(reviewScope(repo, spec, s).carried.map((i) => i.id), [finding], 'the main checkout never saw the edit')
  assert.deepEqual(reviewScope(repo, spec, s, { root: wt }).carried, [], 'its lines changed in the worktree, so it is not carried there')
})

// ------------------------------------------------------------------ the CLI

test('the items verb lists by ground, standing and suspect by default, and --states filters', () => {
  const { repo, id } = spanFixture()
  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve')))
  const run = cli(repo)
  const listed = run('items', '--ground', 'src')
  assert.deepEqual(listed.ground, ['src'])
  assert.deepEqual(listed.items.map((i) => [i.id, i.state]), [[id, 'suspect']])
  assert.deepEqual(run('items', '--ground', 'src', '--states', 'standing').items, [])
  assert.deepEqual(run('items', '--ground', 'src', '--states', 'standing,suspect').items.map((i) => i.id), [id])
})

test('the judge verb records each judgement, an unknown id as ok: false inside its payload', () => {
  const { repo, id } = spanFixture()
  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve')))
  const judged = cli(repo)('judge', ...token({ judgements: [{ id, verdict: 'holds' }, { id: 'I00000000', verdict: 'holds' }] }))
  assert.deepEqual(judged.recorded.map((r) => [r.id, r.verdict, r.ok]), [[id, 'holds', true], ['I00000000', 'holds', false]])
  assert.equal(judged.recorded[0].state, 'standing')
  assert.equal(stateOf(repo, id).state, 'standing')
})

test('the judge verb refuses a token whose digest does not match, and records nothing', () => {
  const { repo, id } = spanFixture()
  const [, , b64flag, b64] = token({ judgements: [{ id, verdict: 'fails' }] })
  const damaged = cli(repo)('judge', '--digest', 'deadbeef', b64flag, b64)
  assert.equal(damaged.error.kind, 'digest_mismatch')
  assert.deepEqual(logOf(repo, 'judged'), [])
  assert.equal(stateOf(repo, id).state, 'standing')
})

test('the review-scope verb prints the reviewScope payload', () => {
  const { repo } = spanFixture()
  const run = cli(repo)
  const scope = run('review-scope', '--file', 'src/a.js')
  assert.deepEqual([scope.ok, scope.path, scope.full, scope.lines], [true, 'src/a.js', true, 30])
  assert.equal(run('review-scope', '--file', 'src/a.js', '--since', 'snapshot:deadbeef').since, 'snapshot:deadbeef')
})

test('the record verb reads the checkout to record from out of --root', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const wt = linkedWorktree(repo)
  write(wt, 'src/a.js', text([...lines(30), ...lines(10, 'more')]))
  const head = commit(wt)
  const out = cli(repo)('record', '--kind', 'survey', '--root', wt, ...token({ items: [itemOf(span('src/a.js', 35, 38))] }))
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(liveItems(repo).get(out.ids[0]).spans[0].at, head)
})

test('the items, judge and review-scope verbs read the checkout out of --root', () => {
  const { repo, id } = spanFixture()
  const wt = linkedWorktree(repo)
  const edited = withLine(lines(30), 12, 'line twelve')
  write(wt, 'src/a.js', text(edited))
  const run = cli(repo)

  assert.deepEqual(run('items', '--ground', 'src').items.map((i) => i.state), ['standing'])
  assert.deepEqual(run('items', '--ground', 'src', '--root', wt).items.map((i) => i.state), ['suspect'])

  const judged = run('judge', '--root', wt, ...token({ judgements: [{ id, verdict: 'holds' }] }))
  assert.deepEqual(judged.recorded.map((r) => [r.id, r.ok, r.state]), [[id, true, 'standing']])
  assert.equal(liveItems(repo).get(id).spans[0].at, 'snapshot:' + hashSpec(text(edited)),
    'an uncommitted worktree edit re-anchors at a snapshot of the worktree\'s text')

  write(wt, 'src/a.js', text(lines(40)))
  assert.equal(run('review-scope', '--file', 'src/a.js').lines, 30)
  assert.equal(run('review-scope', '--file', 'src/a.js', '--root', wt).lines, 40)
})

// ------------------------------------------------------------------ T22d: the audit's gaps

test('G1: a file committed with CRLF bytes stands through a line-ending change and moved lines; an edit inside reads as LF text', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30), '\r\n') })
  const id = record(repo, span('src/a.js', 10, 14))
  assert.equal(stateOf(repo, id).state, 'standing')

  write(repo, 'src/a.js', text(lines(30)))
  assert.equal(stateOf(repo, id).state, 'standing', 'the working copy turned LF: only line endings moved')

  write(repo, 'src/a.js', text(['above', ...lines(30)], '\r\n'))
  assert.equal(stateOf(repo, id).state, 'standing', 'a line added above the span')

  const edited = withLine(lines(30), 12, 'line twelve')
  write(repo, 'src/a.js', text(edited, '\r\n'))
  const st = stateOf(repo, id)
  assert.equal(st.state, 'suspect')
  assert.equal(st.changed[0].old, lines(30).slice(9, 14).join('\n'), 'the old text is read from a CRLF blob, and has no CR')
  assert.equal(st.changed[0].now, edited.slice(9, 14).join('\n'))
})

test('G2: a derived cycle is stale, never a stack overflow', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  const a = itemOf({ kind: 'derived', claim: 'A holds because B does' })
  const b = itemOf({ kind: 'derived', claim: 'B holds because A does' })
  const c = itemOf({ kind: 'derived', claim: 'C holds because C does' })
  const [idA, idB, idC] = [a, b, c].map(itemId)
  const out = recordItems(repo, RETURN, [{ ...a, rests_on: [idB] }, { ...b, rests_on: [idA] }, { ...c, rests_on: [idC] }])
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(checkAnchors(repo, [idA, idB, idC]).map((s) => s.state), ['stale', 'stale', 'stale'])
})

test('G2: a derived lattice derives each base once per call: thirty rungs of two, each resting on both below', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  let below = [record(repo, {
    kind: 'external', claim: 'the floor', ground: [], sources: [{ url: 'https://example.com', version: '', retrieved: '' }],
  })]
  for (let k = 1; k <= 30; k++) {
    const out = recordItems(repo, RETURN, [0, 1].map((n) => itemOf({ kind: 'derived', claim: 'rung ' + k + '.' + n, rests_on: below })))
    assert.equal(out.ok, true, JSON.stringify(out))
    below = out.ids
  }
  // Deriving each base once is 61 derivations; deriving it per path is 2^30. A child process
  // is killed at the timeout, where a runaway in this one would hang the suite.
  const script = 'import(' + JSON.stringify(pathToFileURL(CLI).href) + ').then((m) => console.log(m.checkAnchors(' +
    JSON.stringify(repo) + ', [' + JSON.stringify(below[0]) + '])[0].state))'
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 })
  assert.equal(r.signal, null, 'the check ran away: a base is derived more than once')
  assert.equal(r.stdout.trim(), 'standing', r.stderr)
})

test('G3: the revision a holds appends carries no seq inside its item', () => {
  const { repo, id } = spanFixture()
  write(repo, 'src/a.js', text(withLine(lines(30), 12, 'line twelve')))
  commit(repo)
  assert.equal(recordJudgement(repo, id, 'holds').state, 'standing')
  const last = logOf(repo, 'item').at(-1)
  assert.equal(last.item.id, id)
  assert.equal(Object.hasOwn(last.item, 'seq'), false, 'seq belongs to the log line, never to the item')
})

test('G4: the latest judgement is the one with the highest seq, whatever the line order', () => {
  const { repo, id } = spanFixture()
  const [item] = logOf(repo, 'item')
  writeFileSync(evidenceItemsPath(repo), [
    item,
    { kind: 'judged', id, verdict: 'fails', at: '', seq: item.seq + 2 },
    { kind: 'judged', id, verdict: 'holds', at: '', seq: item.seq + 1 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')
  assert.equal(stateOf(repo, id).state, 'stale', 'the fails line has the higher seq, though the holds line comes later')
})

test('G5: reviewScope marks line 1 for a deleted first line, the new last line for a deleted last line, and merges touching ranges', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  const path = '.agentics/e1/DESIGN.md'
  const v1 = lines(40, 'spec')
  write(repo, path, text(v1))
  const since = reviewScope(repo, path).snapshot
  const changedAfter = (ls) => {
    write(repo, path, text(ls))
    return reviewScope(repo, path, since).changed
  }

  assert.deepEqual(changedAfter(v1.slice(1)), [{ start: 1, end: 1 }], 'the line that followed the deleted first line')
  const shorter = v1.slice(0, -1)
  assert.deepEqual(changedAfter(shorter), [{ start: shorter.length, end: shorter.length }], 'no line follows a deleted last line')
  // Old line 9 goes, so new lines 8 and 9 flank where it was; old line 11, edited, is new line 10.
  const both = v1.filter((_, i) => i !== 8).map((l) => (l === 'spec 11' ? 'spec 11, edited' : l))
  const eleven = both.indexOf('spec 11, edited') + 1
  assert.deepEqual(changedAfter(both), [{ start: v1.indexOf('spec 9'), end: eleven }], 'touching ranges are one range')
})

test('G6: a query git cannot run is refused at record, and stale in the store', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  const raw = itemOf({ kind: 'absence', claim: 'nothing matches a pattern git refuses', queries: [{ pattern: 'a(b', scope: ['src'] }] })
  const refused = recordItems(repo, RETURN, [raw])
  assert.deepEqual([refused.ok, refused.refused && refused.refused[0].index], [false, 0], JSON.stringify(refused))

  const item = { ...raw, queries: [{ pattern: 'a(b', scope: ['src'], result: [] }], from_return: RETURN }
  const id = itemId(item)
  assert.equal(appendProject(repo, 'items', [{ kind: 'item', item: { ...item, id } }]).ok, true)
  assert.equal(stateOf(repo, id).state, 'stale')
})

test('G7: a query whose pattern or scope holds a NUL is refused at record, never thrown, and leaves no raw return', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  for (const q of [{ pattern: 'a\u0000b', scope: ['src'] }, { pattern: 'line', scope: ['sr\u0000c'] }]) {
    const out = recordItems(repo, RETURN, [itemOf({ kind: 'enumeration', claim: 'nul in ' + JSON.stringify(q), queries: [q] })])
    assert.deepEqual([out.ok, out.refused && out.refused[0].index], [false, 0], JSON.stringify(q))
    const raw = recordRaw(repo, 'survey', { items: [itemOf({ kind: 'enumeration', claim: 'raw nul in ' + JSON.stringify(q), queries: [q] })] })
    assert.equal(raw.ok, false, JSON.stringify(q))
  }
  assert.equal(existsSync(evidenceItemsPath(repo)), false, 'nothing entered the pool')
  const returns = evidenceReturnsDir(repo)
  assert.deepEqual(existsSync(returns) ? readdirSync(returns) : [], [], 'a refused return is deleted again')
})

test('G7: a stored query pattern holding a NUL is stale, never thrown', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  const item = itemOf({
    kind: 'absence', claim: 'a stored pattern holding a NUL', queries: [{ pattern: 'a\u0000b', scope: ['src'], result: [] }], from_return: RETURN,
  })
  const id = itemId(item)
  assert.equal(appendProject(repo, 'items', [{ kind: 'item', item: { ...item, id } }]).ok, true)
  assert.equal(stateOf(repo, id).state, 'stale')
})

test('G8: a query never matches inside .agentics/, even with the store\'s ignore file gone', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)) })
  const id = record(repo, {
    kind: 'absence', claim: 'nothing in the repository says zqxj', ground: ['.'], queries: [{ pattern: 'zqxj', scope: ['.'] }],
  })
  rmSync(join(repo, '.agentics', '.gitignore'))
  assert.equal(stateOf(repo, id).state, 'standing', 'the store holds the pattern, and the store is never searched')

  const listed = record(repo, {
    kind: 'enumeration', claim: 'where zqxj is said', ground: ['.'], queries: [{ pattern: 'zqxj', scope: ['.'] }],
  })
  assert.deepEqual(liveItems(repo).get(listed).queries[0].result, [], 'the recorder searches the tree, never the store')
})

test('G9: reviewScope given a since snapshot that does not hash to its name gives a full review', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  const path = '.agentics/e1/DESIGN.md'
  const v1 = lines(40, 'spec')
  write(repo, path, text(v1))
  const since = reviewScope(repo, path).snapshot
  writeFileSync(join(evidenceSnapshotsDir(repo), since.slice('snapshot:'.length) + '.txt'), text(v1).slice(0, 20))
  write(repo, path, text(withLine(v1, 31, 'spec 31, edited')))
  const next = reviewScope(repo, path, since)
  assert.equal(next.full, true, 'a torn snapshot is not the old text')
  assert.deepEqual(next.changed, [{ start: 1, end: v1.length }])
})
