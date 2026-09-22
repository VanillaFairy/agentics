// test/effort.test.mjs — the effort store on a real filesystem.
//
// What is pinned here:
//
//   naming       the slug is the directory name, entire; no identity file restates it
//   opening      idempotent, and the second opener adopts the first's account of the effort
//   recording    a return is stored verbatim, and two returns in the same second both survive
//   linking      runs and designs are POINTERS — nothing moves under the effort
//   reading      every list is derived from what is on disk, never from a stored status
//   discipline   the path guard, and the notes that say this store proves nothing
//
// Design: docs/DESIGN.md#efforts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EFFORTS_DIR, linkTo, listEfforts, openEffort, readEffort, recordReturn, safeSlug, slugFor,
  standingSurvey,
} from '../lib/effort.mjs'

const CLI = fileURLToPath(new URL('../lib/effort.mjs', import.meta.url))
const fresh = () => mkdtempSync(join(tmpdir(), 'vfa-effort-')).split('\\').join('/')

const run = (...args) => {
  const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  return JSON.parse(out)
}

test('a slug is dated, kebab, and bounded by words rather than by length', () => {
  assert.equal(slugFor('Efforts, and what a probe should cost', '2026-09-04'),
    '2026-09-04-efforts-and-what-a-probe-should')
  assert.equal(slugFor('', '2026-09-04'), '2026-09-04-effort')
  assert.equal(slugFor('x', ''), 'undated-x')
})

test('a slug that could climb out of the store is refused', () => {
  assert.equal(safeSlug('../../etc'), null)
  assert.equal(safeSlug('a/b'), null)
  assert.equal(safeSlug('..'), null)
  assert.equal(safeSlug(''), null)
  assert.equal(safeSlug('2026-09-04-ok'), '2026-09-04-ok')
})

test('opening is idempotent, and no identity file restates the directory name', () => {
  const repo = fresh()
  const first = openEffort(repo, { slug: 'e1', about: 'the change', roots: 'a,b' })
  assert.equal(first.ok, true)
  assert.equal(first.created, true)

  const identity = JSON.parse(readFileSync(join(repo, ...EFFORTS_DIR.split('/'), 'e1', 'effort.json'), 'utf8'))
  assert.deepEqual(Object.keys(identity).sort(), ['about', 'opened_at', 'roots'])
  assert.deepEqual(identity.roots, ['a', 'b'])

  const second = openEffort(repo, { slug: 'e1', about: 'something else entirely' })
  assert.equal(second.created, false)
  assert.equal(second.about, 'the change',
    'the second opener adopts what the first recorded rather than overwriting it')
})

test('a return is stored byte-for-byte, and a collision in the same second keeps both', () => {
  const repo = fresh()
  openEffort(repo, { slug: 'e1', about: 'x' })

  const payload = { question: 'q', coverage: { complete: false, unreached: ['a'] } }
  const now = new Date('2026-09-04T10:11:12Z')
  const a = recordReturn(repo, 'e1', 'survey', payload, now)
  const b = recordReturn(repo, 'e1', 'survey', { question: 'q2' }, now)

  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.notEqual(a.path, b.path)
  assert.deepEqual(JSON.parse(readFileSync(a.path, 'utf8')), payload)
})

test('recording into an effort nobody opened is refused rather than inventing one', () => {
  const repo = fresh()
  const out = recordReturn(repo, 'nope', 'survey', { a: 1 })
  assert.equal(out.ok, false)
  assert.match(out.error, /no effort named nope/)
})

test('a return that is not an object is refused — a stored survey is the survey\'s own result', () => {
  const repo = fresh()
  openEffort(repo, { slug: 'e1', about: 'x' })
  assert.equal(recordReturn(repo, 'e1', 'survey', 'a summary').ok, false)
  assert.equal(recordReturn(repo, 'e1', 'sketch', { a: 1 }).ok, false)
})

test('runs and designs are pointers — the run directory is not moved under the effort', () => {
  const repo = fresh()
  openEffort(repo, { slug: 'e1', about: 'x' })
  assert.equal(linkTo(repo, 'e1', 'run', '20260904-101112').ok, true)
  assert.equal(linkTo(repo, 'e1', 'design', 'docs/vfa/designs/x.md').ok, true)
  assert.equal(linkTo(repo, 'e1', 'run', '20260904-101112').ok, true)

  const read = readEffort(repo, 'e1', '')
  assert.deepEqual(read.runs, ['20260904-101112'], 'the same run linked twice is one run')
  assert.deepEqual(read.designs, ['docs/vfa/designs/x.md'])
  assert.equal(existsSync(join(repo, ...EFFORTS_DIR.split('/'), 'e1', 'runs')), false)
})

test('reading derives every list from disk, and --latest carries one return in full', () => {
  const repo = fresh()
  openEffort(repo, { slug: 'e1', about: 'the change' })
  recordReturn(repo, 'e1', 'survey', { question: 'first' }, new Date('2026-09-04T10:00:00Z'))
  recordReturn(repo, 'e1', 'survey', { question: 'second' }, new Date('2026-09-04T11:00:00Z'))
  recordReturn(repo, 'e1', 'probe', { ratifiable: false }, new Date('2026-09-04T12:00:00Z'))

  const read = readEffort(repo, 'e1', 'survey')
  assert.equal(read.exists, true)
  assert.equal(read.surveys.length, 2)
  assert.equal(read.probes.length, 1)
  assert.equal(read.latest.payload.question, 'second', 'the newest stamp wins')
  assert.match(read.notes, /proves nothing/)
})

test('an effort nobody opened reads as absent rather than as empty', () => {
  const read = readEffort(fresh(), 'ghost', '')
  assert.equal(read.exists, false)
  assert.deepEqual(read.surveys, [])
  assert.match(read.notes, /no effort named ghost/)
})

test('listing a repository with no store says so instead of returning an empty success', () => {
  const out = listEfforts(fresh())
  assert.equal(out.store_present, false)
  assert.deepEqual(out.efforts, [])
})

test('the CLI opens, records from a file, links, and prints a digest on every read', () => {
  const repo = fresh()
  assert.equal(run('open', repo, 'e1', '--about', 'the change', '--roots', repo).created, true)

  const file = join(repo, 'return.json')
  writeFileSync(file, JSON.stringify({ question: 'q', topics: ['a'] }), 'utf8')
  assert.equal(run('record', repo, 'e1', 'survey', '--file', file).ok, true)
  assert.equal(run('link', repo, 'e1', 'run', '--value', '20260904-101112').ok, true)

  const read = run('read', repo, 'e1', '--latest', 'survey')
  assert.equal(read.payload.latest.payload.topics[0], 'a')
  assert.match(read.payload_digest, /^[0-9a-f]{8}$/)

  const listed = run('list', repo)
  assert.equal(listed.payload.efforts.length, 1)
  assert.equal(listed.payload.efforts[0].effort, 'e1')
})

test('the CLI refuses a return file that did not survive transcription', () => {
  const repo = fresh()
  run('open', repo, 'e1', '--about', 'x')
  const file = join(repo, 'broken.json')
  writeFileSync(file, '{ "question": ', 'utf8')

  assert.throws(() => execFileSync(process.execPath, [CLI, 'record', repo, 'e1', 'survey', '--file', file],
    { encoding: 'utf8', stdio: 'pipe' }))
})

test('the slug command needs no repository', () => {
  const out = run('slug', 'Efforts and what a probe should cost')
  assert.equal(out.ok, true)
  assert.match(out.slug, /^\d{4}-\d{2}-\d{2}-efforts-and-what-a-probe-should$/)
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

const commitIn = (dir, files) => {
  put(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'change')
}

const SURVEY = (over = {}) => ({
  question: 'q', topics: ['a'], ground: ['src/a'], verdicts: [], history: null, docs: null,
  coverage: { complete: true, dropped: [], incomplete: [], failed_channels: [], unreached: [], from_kb: [] },
  ...over,
})

function surveyed(dir, payload = SURVEY()) {
  openEffort(dir, { slug: 'e', about: 'a change', roots: dir })
  return recordReturn(dir, 'e', 'survey', payload)
}

test('recording a survey anchors it to HEAD and its ground, beside the verbatim return', () => {
  const dir = gitRepo()
  const out = surveyed(dir)

  assert.equal(out.anchor.observed_at, git(dir, 'rev-parse', 'HEAD'))
  assert.deepEqual(out.anchor.ground, ['src/a'])
  assert.deepEqual(JSON.parse(readFileSync(out.path, 'utf8')), SURVEY(), 'the return stays verbatim')
  assert.equal(readEffort(dir, 'e').surveys.length, 1, 'the anchor is not listed as a survey')
})

test('an untouched ground stands, and says why', () => {
  const dir = gitRepo()
  surveyed(dir)
  commitIn(dir, { 'src/b/y.js': 'elsewhere\n' })

  const out = standingSurvey(dir, 'e')
  assert.equal(out.standing, true, out.why)
  assert.match(out.survey_path, /surveys\/.+\.json$/)
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

test('a repository-wide survey is not un-stood by the pipeline\'s own state under .claude/vfa', () => {
  const dir = gitRepo()
  surveyed(dir, SURVEY({ ground: ['.'] }))
  put(dir, { '.claude/vfa/runs/r1/state.jsonl': '{}\n' })

  assert.equal(standingSurvey(dir, 'e').standing, true)

  put(dir, { '.claude/notes.md': 'mine\n' })
  assert.equal(standingSurvey(dir, 'e').standing, false, 'anything else under .claude is ground')
})

test('a survey that did not complete, or names no ground, never stands', () => {
  const partial = gitRepo()
  surveyed(partial, SURVEY({ coverage: { ...SURVEY().coverage, complete: false } }))
  assert.match(standingSurvey(partial, 'e').why, /complete coverage/)

  const groundless = gitRepo()
  surveyed(groundless, SURVEY({ ground: undefined }))
  assert.match(standingSurvey(groundless, 'e').why, /names no ground/)
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
