// test/effort.test.mjs — an effort's identity and evidence on a real filesystem, and the standing
// survey on real git repositories.
//
// What is pinned here:
//
//   naming       the slug is the directory name, entire; no identity file restates it; no `--`
//   opening      idempotent, and the second opener adopts the first's account of the effort
//   recording    a return lands verbatim at evidence/<stamp>-<kind>.json; a same-second
//                collision gets -2, -3 before the kind, and both survive
//   reading      evidence, executions and the node count are derived from disk
//   standing     a survey stands only while git says nothing reached its anchored ground
//
// Design: docs/DESIGN.md#storage, docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  listEfforts, openEffort, readEffort, recordReturn, safeSlug, slugFor, stampNow,
  standingSurvey,
} from '../lib/effort.mjs'
import { append } from '../lib/ledger.mjs'
import { effortStateDir } from '../lib/store.mjs'
import * as store from '../lib/store.mjs'

const CLI = fileURLToPath(new URL('../lib/effort.mjs', import.meta.url))
const fresh = () => mkdtempSync(join(tmpdir(), 'agentics-effort-')).split('\\').join('/')
const effortPath = (repo, slug, ...rest) => join(effortStateDir(repo, slug), ...rest)

const run = (...args) => JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }))

test('names and stamps are lib/store.mjs\'s, not a second copy', () => {
  assert.equal(safeSlug, store.safeSlug)
  assert.equal(stampNow, store.stampNow)
})

test('a proposed name is the first four words, kebab, undated, and passes the segment rule', () => {
  const about = 'Efforts, and what a probe should cost'
  assert.equal(slugFor(about), about.toLowerCase().match(/[a-z0-9]+/g).slice(0, 4).join('-'))
  assert.equal(slugFor(''), 'effort')
  assert.equal(slugFor('a -- b'), 'a-b')
  for (const text of [about, '', 'a -- b', 'x'.repeat(300) + ' y']) {
    const name = slugFor(text)
    assert.equal(safeSlug(name), name, text)
    assert.ok(name.split('-').length <= 4, name)
  }
})

test('a slug that could climb out of the store, or blur a branch prefix, is refused', () => {
  assert.equal(safeSlug('../../etc'), null)
  assert.equal(safeSlug('a/b'), null)
  assert.equal(safeSlug('..'), null)
  assert.equal(safeSlug(''), null)
  assert.equal(safeSlug('a--b'), null)
  assert.equal(safeSlug('2026-09-04-ok'), '2026-09-04-ok')
  assert.equal(openEffort(fresh(), { slug: 'a--b', about: 'x' }).ok, false)
})

test('opening is idempotent, and no identity file restates the directory name', () => {
  const repo = fresh()
  const first = openEffort(repo, { slug: 'e1', about: 'the change', roots: 'a,b' })
  assert.equal(first.ok, true)
  assert.equal(first.created, true)

  const identity = JSON.parse(readFileSync(effortPath(repo, 'e1', 'effort.json'), 'utf8'))
  assert.deepEqual(Object.keys(identity).sort(), ['about', 'opened_at', 'roots'])
  assert.deepEqual(identity.roots, ['a', 'b'])

  const second = openEffort(repo, { slug: 'e1', about: 'something else entirely' })
  assert.equal(second.created, false)
  assert.equal(second.about, 'the change',
    'the second opener adopts what the first recorded rather than overwriting it')
})

test('a return lands verbatim under evidence/<stamp>-<kind>.json', () => {
  const repo = fresh()
  openEffort(repo, { slug: 'e1', about: 'x' })

  const payload = { question: 'q', coverage: { complete: false, unreached: ['a'] } }
  const out = recordReturn(repo, 'e1', 'probe', payload, new Date('2026-09-04T10:11:12Z'))
  assert.equal(out.ok, true)
  assert.equal(out.stamp, '20260904-101112')
  assert.equal(out.path, effortPath(repo, 'e1', 'evidence', '20260904-101112-probe.json').split('\\').join('/'))
  assert.deepEqual(JSON.parse(readFileSync(out.path, 'utf8')), payload)
  assert.equal(out.anchor, undefined, 'only a survey is anchored')
  assert.equal(existsSync(effortPath(repo, 'e1', 'probes')), false, 'the old per-kind directories are gone')
})

test('a same-second collision takes -2, -3 before the kind, and every return survives', () => {
  const repo = fresh()
  openEffort(repo, { slug: 'e1', about: 'x' })
  const now = new Date('2026-09-04T10:11:12Z')

  const a = recordReturn(repo, 'e1', 'survey', { n: 1 }, now)
  const b = recordReturn(repo, 'e1', 'survey', { n: 2 }, now)
  const c = recordReturn(repo, 'e1', 'survey', { n: 3 }, now)
  const p = recordReturn(repo, 'e1', 'probe', { n: 4 }, now)

  assert.match(a.path, /\/20260904-101112-survey\.json$/)
  assert.match(b.path, /\/20260904-101112-2-survey\.json$/)
  assert.match(c.path, /\/20260904-101112-3-survey\.json$/)
  assert.match(p.path, /\/20260904-101112-probe\.json$/, 'a different kind in the same second does not collide')
  assert.ok(existsSync(b.path.replace(/\.json$/, '.anchor')), 'each survey carries its own anchor')

  const read = readEffort(repo, 'e1', 'survey')
  assert.deepEqual(read.evidence.map((e) => e.stamp + ' ' + e.kind), [
    '20260904-101112 probe', '20260904-101112 survey', '20260904-101112-2 survey', '20260904-101112-3 survey',
  ])
  assert.equal(read.latest.payload.n, 3, 'the collision counter orders within the second')
})

test('the collision counter orders numerically, so -10 is newer than -9', () => {
  const repo = fresh()
  openEffort(repo, { slug: 'e1', about: 'x' })
  const now = new Date('2026-09-04T10:11:12Z')
  for (let n = 1; n <= 10; n++) recordReturn(repo, 'e1', 'probe', { n }, now)
  assert.equal(readEffort(repo, 'e1', 'probe').latest.payload.n, 10)
})

test('recording into an effort nobody opened is refused rather than inventing one', () => {
  const out = recordReturn(fresh(), 'nope', 'survey', { a: 1 })
  assert.equal(out.ok, false)
  assert.match(out.error, /no effort named nope/)
})

test('a return that is not an object, or of an unknown kind, is refused', () => {
  const repo = fresh()
  openEffort(repo, { slug: 'e1', about: 'x' })
  assert.equal(recordReturn(repo, 'e1', 'survey', 'a summary').ok, false)
  assert.equal(recordReturn(repo, 'e1', 'survey', [1, 2]).ok, false)
  assert.equal(recordReturn(repo, 'e1', 'sketch', { a: 1 }).ok, false)
})

test('reading derives identity, evidence, node count and executions from disk', () => {
  const repo = fresh()
  openEffort(repo, { slug: 'e1', about: 'the change', roots: ['src'] })
  recordReturn(repo, 'e1', 'survey', { question: 'first' }, new Date('2026-09-04T10:00:00Z'))
  recordReturn(repo, 'e1', 'survey', { question: 'second' }, new Date('2026-09-04T11:00:00Z'))
  recordReturn(repo, 'e1', 'probe', { ratifiable: false }, new Date('2026-09-04T12:00:00Z'))
  append(repo, 'e1', 'nodes', [
    { kind: 'node', node: { id: '.', title: 'root', kind: 'composite' } },
    { kind: 'node', node: { id: 'a', title: 'a', kind: 'leaf' } },
    { kind: 'node', node: { id: 'a', title: 'a again', kind: 'leaf' } },
    { kind: 'node', node: { id: 'b', title: 'gone', kind: 'leaf', retired: true } },
  ])
  mkdirSync(effortPath(repo, 'e1', 'executions', '20260904-130000'), { recursive: true })
  mkdirSync(effortPath(repo, 'e1', 'executions', 'not-a-stamp'), { recursive: true })

  const read = readEffort(repo, 'e1', 'survey')
  assert.equal(read.exists, true)
  assert.deepEqual(read.identity.roots, ['src'])
  assert.equal(read.identity.about, 'the change')
  assert.deepEqual(read.evidence.map((e) => e.kind), ['survey', 'survey', 'probe'])
  assert.equal(read.latest.payload.question, 'second', 'the newest stamp of the asked kind wins')
  assert.equal(read.nodes_n, 2, 'latest revision per id, retired dropped')
  assert.deepEqual(read.executions, ['20260904-130000'])
  assert.match(read.notes, /proves nothing/)

  assert.equal(readEffort(repo, 'e1').latest, null, 'no kind asked, no payload carried')
})

test('an effort nobody opened reads as absent rather than as empty', () => {
  const read = readEffort(fresh(), 'ghost')
  assert.equal(read.exists, false)
  assert.equal(read.identity, null)
  assert.deepEqual(read.evidence, [])
  assert.match(read.notes, /no effort named ghost/)
})

test('listing a repository with no store says so instead of returning an empty success', () => {
  const out = listEfforts(fresh())
  assert.equal(out.store_present, false)
  assert.deepEqual(out.efforts, [])
})

test('listing counts each effort\'s evidence and executions, newest name first', () => {
  const repo = fresh()
  openEffort(repo, { slug: 'a1', about: 'first' })
  openEffort(repo, { slug: 'b2', about: 'second' })
  recordReturn(repo, 'a1', 'probe', { x: 1 })
  mkdirSync(effortPath(repo, 'b2', 'executions', '20260904-130000'), { recursive: true })

  const out = listEfforts(repo)
  assert.deepEqual(out.efforts.map((e) => e.effort), ['b2', 'a1'])
  assert.equal(out.efforts[1].probes, 1)
  assert.deepEqual(out.efforts[0].executions, ['20260904-130000'])
})

test('the CLI opens, records from a file, and prints an envelope on every read', () => {
  const repo = fresh()
  assert.equal(run('open', repo, 'e1', '--about', 'the change', '--roots', repo).created, true)

  const file = join(repo, 'return.json')
  writeFileSync(file, JSON.stringify({ question: 'q', topics: ['a'] }), 'utf8')
  const recorded = run('record', repo, 'e1', 'survey', '--file', file)
  assert.equal(recorded.ok, true)
  assert.match(recorded.path, /\/evidence\/\d{8}-\d{6}-survey\.json$/)

  const read = run('read', repo, 'e1', '--latest', 'survey')
  assert.equal(read.payload.latest.payload.topics[0], 'a')
  assert.match(read.payload_digest, /^[0-9a-f]{8}$/)

  const flags = run('read', '--repo', repo, '--effort', 'e1')
  assert.equal(flags.payload.evidence.length, 1, 'the flag spelling reads the same effort')

  const listed = run('list', repo)
  assert.equal(listed.payload.efforts.length, 1)
  assert.equal(listed.payload.efforts[0].effort, 'e1')
})

test('the CLI has no link verb any more', () => {
  const repo = fresh()
  run('open', repo, 'e1', '--about', 'x')
  assert.throws(() => execFileSync(process.execPath, [CLI, 'link', repo, 'e1', 'run', '--value', 'x'],
    { encoding: 'utf8', stdio: 'pipe' }))
})

test('the CLI refuses a return file that did not survive transcription', () => {
  const repo = fresh()
  run('open', repo, 'e1', '--about', 'x')
  const file = join(repo, 'broken.json')
  writeFileSync(file, '{ "question": ', 'utf8')

  assert.throws(() => execFileSync(process.execPath, [CLI, 'record', repo, 'e1', 'survey', '--file', file],
    { encoding: 'utf8', stdio: 'pipe' }))
})

test('the slug command needs no repository and proposes an undated name', () => {
  const words = 'Efforts and what a probe should cost'
  const out = run('slug', words)
  assert.equal(out.ok, true)
  assert.equal(out.slug, slugFor(words))
  assert.doesNotMatch(out.slug, /^\d{4}-\d{2}-\d{2}-/)
})

// ------------------------------------------------------------------ standing
//
// A recorded survey is anchored to the commit it was taken at and the ground its topics searched,
// and stands in for a later survey only while git says nothing reached that ground. Real repos,
// because the whole claim is about what git answers.

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

function put(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

function gitRepo() {
  const dir = fresh()
  git(dir, 'init', '-q', '.')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  put(dir, { 'src/a/x.js': 'x\n', 'src/b/y.js': 'y\n' })
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

test('the store ignores itself: an opened effort and its records leave git status clean', () => {
  const repo = gitRepo()
  openEffort(repo, { slug: 'e1', about: 'x' })
  recordReturn(repo, 'e1', 'probe', { question: 'q' }, new Date('2026-09-04T10:11:12Z'))

  assert.equal(git(repo, 'status', '--porcelain'), '', 'local state never shows up as a change to commit')
  assert.equal(readFileSync(join(repo, store.AGENTICS_DIR, '.gitignore'), 'utf8'), '*\n')
})

const commitIn = (dir, files) => {
  put(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'change')
}

const SURVEY = (over = {}) => ({
  question: 'q', topics: ['a'], ground: ['src/a'], verdicts: [], history: null, docs: null,
  coverage: { complete: true, dropped: [], incomplete: [], failed_channels: [], unreached: [] },
  ...over,
})

function surveyed(dir, payload = SURVEY(), now) {
  openEffort(dir, { slug: 'e', about: 'a change', roots: dir })
  return recordReturn(dir, 'e', 'survey', payload, now)
}

test('recording a survey anchors it to HEAD and its ground, beside the verbatim return', () => {
  const dir = gitRepo()
  const out = surveyed(dir)

  assert.equal(out.anchor.observed_at, git(dir, 'rev-parse', 'HEAD'))
  assert.deepEqual(out.anchor.ground, ['src/a'])
  assert.deepEqual(JSON.parse(readFileSync(out.path, 'utf8')), SURVEY(), 'the return stays verbatim')
  assert.deepEqual(JSON.parse(readFileSync(out.path.replace(/\.json$/, '.anchor'), 'utf8')), out.anchor)
  assert.match(out.path, /\/evidence\/\d{8}-\d{6}-survey\.json$/)
  assert.equal(readEffort(dir, 'e').evidence.length, 1, 'the anchor is not listed as evidence')
})

test('an untouched ground stands, and says why', () => {
  const dir = gitRepo()
  surveyed(dir)
  commitIn(dir, { 'src/b/y.js': 'elsewhere\n' })

  const out = standingSurvey(dir, 'e')
  assert.equal(out.standing, true, out.why)
  assert.match(out.survey_path, /\/evidence\/.+-survey\.json$/)
})

test('a commit on the ground un-stands it and names the commit', () => {
  const dir = gitRepo()
  surveyed(dir)
  commitIn(dir, { 'src/a/x.js': 'moved\n' })

  const out = standingSurvey(dir, 'e')
  assert.equal(out.standing, false)
  assert.equal(out.commits_since.length, 1)
  assert.equal(out.commits_since[0], git(dir, 'rev-parse', 'HEAD'))
})

test('an uncommitted edit on the ground un-stands it; one elsewhere does not', () => {
  const dir = gitRepo()
  surveyed(dir)

  put(dir, { 'src/b/new.js': 'n\n' })
  assert.equal(standingSurvey(dir, 'e').standing, true)

  put(dir, { 'src/a/new.js': 'n\n' })
  const out = standingSurvey(dir, 'e')
  assert.equal(out.standing, false)
  assert.deepEqual(out.dirty, ['src/a/new.js'])
})

test('a repository-wide survey is not un-stood by the pipeline\'s own state under the store', () => {
  const dir = gitRepo()
  surveyed(dir, SURVEY({ ground: ['.'] }))
  put(dir, { [store.AGENTICS_DIR + '/e/executions/20260904-101112/state.jsonl']: '{}\n' })
  // Committed despite the store's own ignore, as a repository from before it did.
  put(dir, { [store.AGENTICS_DIR + '/e/nodes.jsonl']: '{}\n' })
  git(dir, 'add', '-f', store.AGENTICS_DIR + '/e/nodes.jsonl')
  git(dir, 'commit', '-qm', 'state')

  assert.equal(standingSurvey(dir, 'e').standing, true)

  put(dir, { '.claude/notes.md': 'mine\n' })
  assert.equal(standingSurvey(dir, 'e').standing, false, 'anything under .claude is ground')
})

test('the newest survey is the one judged, even when an older one would stand', () => {
  const dir = gitRepo()
  surveyed(dir, SURVEY(), new Date('2026-09-04T10:00:00Z'))
  recordReturn(dir, 'e', 'survey', SURVEY({ coverage: { complete: false } }), new Date('2026-09-04T11:00:00Z'))
  const out = standingSurvey(dir, 'e')
  assert.equal(out.standing, false)
  assert.equal(out.stamp, '20260904-110000')
})

test('a survey that did not complete, or names no ground, never stands', () => {
  const partial = gitRepo()
  surveyed(partial, SURVEY({ coverage: { ...SURVEY().coverage, complete: false } }))
  assert.match(standingSurvey(partial, 'e').why, /complete coverage/)

  const groundless = gitRepo()
  surveyed(groundless, SURVEY({ ground: undefined }))
  assert.match(standingSurvey(groundless, 'e').why, /names no ground/)
})

test('a survey whose commit left HEAD\'s history never stands', () => {
  const dir = gitRepo()
  commitIn(dir, { 'src/b/y.js': 'second\n' })
  surveyed(dir)
  git(dir, 'reset', '-q', '--hard', 'HEAD~1')
  assert.match(standingSurvey(dir, 'e').why, /not an ancestor of HEAD/)
})

test('no survey, or an unanchored one, never stands', () => {
  const dir = gitRepo()
  openEffort(dir, { slug: 'e', about: 'a change', roots: dir })
  assert.match(standingSurvey(dir, 'e').why, /no recorded survey/)

  const bare = fresh()
  surveyed(bare)
  assert.match(standingSurvey(bare, 'e').why, /no anchor commit/, 'no git, no anchor, no standing')
})

test('the CLI prints standing under its own digest', () => {
  const dir = gitRepo()
  surveyed(dir)
  const out = run('standing', dir, 'e')
  assert.equal(out.payload.standing, true)
  assert.equal(typeof out.payload_digest, 'string')
})
