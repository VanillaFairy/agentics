// test/verify-role-breach.test.mjs — lib/verify.mjs's series check judges `role-breach` on the
// series' net diff (base...HEAD, renames split) through what the leaf's role may change, holds a
// shell-less author's commits to their own fence, and names the existing tests a series rewrote
// outside what the leaf expects (`tests_rewritten`), against real repositories.
//
// Design: docs/DESIGN.md#role-rules, docs/DESIGN.md#verify-payload.
//
// Findings are read by `check` and by what their message names, never by wording or order.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { verify } from '../lib/verify.mjs'
import { cycle, git, options, order, rev, WIDGET_TEST } from './harness/verify-fixture.mjs'

const STRAY = 'notes/stray.txt'
const TEST_FILE = 'test/widget.test.mjs'
const PASSING = "import { test } from 'node:test'\ntest('a sibling test passes', () => {})\n"
const MORE = WIDGET_TEST + "\ntest('the widget is a function', () => { assert.equal(typeof label, 'function') })\n"

/** One commit in the worktree: a path maps to its new text, or to null for a deletion. Gives its sha. */
function commit(worktree, changes, message) {
  for (const [path, text] of Object.entries(changes)) {
    const absolute = join(worktree, path)
    if (text === null) rmSync(absolute, { force: true })
    else {
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, text)
    }
  }
  git(worktree, 'add', '-A')
  const done = git(worktree, 'commit', '-qm', message)
  assert.equal(done.status, 0, done.stderr)
  return rev(worktree, 'HEAD')
}

const breaches = (payload) => payload.series_findings.filter((f) => f.check === 'role-breach')
const naming = (findings, file) => findings.filter((f) => String(f.message).includes(file))

/** A leaf over main: its own series, rigor trivial. */
function leaf(c, over = {}) {
  return verify({ ...options({ worktree: c.worktree, base: c.base, head: rev(c.worktree, 'HEAD') }), rigor: 'trivial', ...over })
}

/** A green over its red: the base is the red commit, the cycle's test is named. */
function green(c, over = {}) {
  return verify({
    ...options({ worktree: c.worktree, base: c.red, head: rev(c.worktree, 'HEAD') }),
    rigor: 'tdd-pair', role: 'green', expects: ['src/widget.mjs'], tests: [TEST_FILE], ...over,
  })
}

// ---------------------------------------------------------------- the net diff

test('a writer may change files it does not expect', (t) => {
  const c = order(t)
  commit(c.worktree, { [STRAY]: 'one\n', 'src/widget.test.mjs': PASSING }, 'chore: note something')
  const payload = leaf(c)
  assert.deepEqual(breaches(payload), [])
  assert.deepEqual(naming(payload.series_findings, STRAY), [])
})

test('a file under .agentics/ left in the series is one blocking breach naming it, of no one commit', (t) => {
  const c = order(t)
  commit(c.worktree, { '.agentics/note.json': '{}\n' }, 'chore: note something')
  commit(c.worktree, { '.agentics/note.json': '{"a":1}\n' }, 'chore: note it again')
  const hits = breaches(leaf(c))
  assert.equal(hits.length, 1, 'one breach per file in the net diff, not one per commit')
  assert.ok(String(hits[0].message).includes('.agentics/note.json'))
  assert.equal(hits[0].blocking, true)
  assert.equal(hits[0].sha, '')
})

test('a file under .agentics/ a later commit removes leaves no breach', (t) => {
  const c = order(t)
  commit(c.worktree, { '.agentics/note.json': '{}\n' }, 'chore: note something')
  commit(c.worktree, { '.agentics/note.json': null }, 'chore: drop the note')
  assert.deepEqual(breaches(leaf(c)), [])
})

test("a new test file on a green's own commit is a breach", (t) => {
  const c = cycle(t)
  commit(c.worktree, { 'src/widget.test.mjs': PASSING }, 'test: add a sibling test')
  const own = naming(breaches(green(c)), 'src/widget.test.mjs')
  assert.equal(own.length, 1, 'a green may not write tests, beside its source or anywhere')
  assert.equal(own[0].blocking, true)
})

// ---------------------------------------------------------------- the fences

test('a commit made for a shell-less author is held to its own fence', (t) => {
  const c = cycle(t)
  const fenced = commit(c.worktree, {
    [TEST_FILE]: MORE,
    'src/widget.mjs': "export const label = () => 'hi'\n// touched by the test round\n",
  }, 'test(w3): pin more of the widget')
  const hits = breaches(green(c, { fences: { [fenced]: 'tests' } }))
  const own = hits.filter((f) => f.sha === fenced && String(f.message).includes('src/widget.mjs'))
  assert.equal(own.length, 1, 'the fenced commit wrote a source file')
  assert.deepEqual(naming(hits, TEST_FILE), [], 'the test inside its fence is no breach')
})

test("a test file only a fenced commit changed is no breach of the green's rule", (t) => {
  const c = cycle(t)
  const fenced = commit(c.worktree, { [TEST_FILE]: MORE }, 'test(w3): pin more of the widget')
  const payload = green(c, { fences: { [fenced]: 'tests' } })
  assert.deepEqual(breaches(payload), [])
  assert.deepEqual(naming(payload.series_findings, TEST_FILE), [])
})

test('a cycle test file an unfenced commit also changed is a breach', (t) => {
  const c = cycle(t)
  const fenced = commit(c.worktree, { [TEST_FILE]: MORE }, 'test(w3): pin more of the widget')
  const unfenced = commit(c.worktree, { [TEST_FILE]: WIDGET_TEST }, 'fix(w2): change the test back')
  const hits = breaches(green(c, { fences: { [fenced]: 'tests' } }))
  assert.equal(hits.length, 1, 'the net diff of the file is empty, yet the unfenced commit changed it')
  assert.equal(hits[0].sha, unfenced)
  assert.ok(String(hits[0].message).includes(TEST_FILE))
})

// ---------------------------------------------------------------- rewritten tests

test('an existing test the series rewrote outside what the leaf expects is named, and blocks nothing', (t) => {
  const c = order(t)
  commit(c.worktree, { 'test/base.test.mjs': PASSING, 'src/widget.test.mjs': PASSING }, 'test: change the base suite')
  const payload = leaf(c)
  assert.deepEqual(payload.tests_rewritten, ['test/base.test.mjs'], 'a new test file is no rewrite')
  assert.deepEqual(breaches(payload), [])
  assert.deepEqual(leaf(c, { expects: ['src/widget.mjs', 'test/base.test.mjs'] }).tests_rewritten, [], 'a test the leaf expects to change is no rewrite')
})

// ---------------------------------------------------------------- merges

/** Commit `changes` on main, in the repository's own checkout. Gives its sha. */
const onMain = (c, changes, message) => commit(c.dir, changes, message)

test("a clean refresh merge lists nothing beyond git's remerge, and is no empty commit", (t) => {
  const c = order(t)
  const moved = onMain(c, { 'src/other.mjs': 'export const other = 1\n' }, 'feat: other')
  assert.equal(git(c.worktree, 'merge', '-q', '--no-edit', 'main').status, 0)
  const payload = leaf(c, { base: moved })
  assert.deepEqual(payload.series_findings.filter((f) => f.blocking), [], JSON.stringify(payload.series_findings))
})

test("a merge's resolution of a fenced test file is its own author's change, judged by the leaf's role", (t) => {
  const c = cycle(t)
  const fenced = commit(c.worktree, { 'test/base.test.mjs': PASSING }, 'test(w3): rework the base suite')
  const moved = onMain(c, { 'test/base.test.mjs': PASSING + '// main\n' }, 'test: touch the base suite')
  git(c.worktree, 'merge', '-q', '--no-edit', 'main')
  const merge = commit(c.worktree, { 'test/base.test.mjs': PASSING + '// both\n' }, 'merge main')
  const hits = breaches(green(c, { fences: { [fenced]: 'tests' }, exclude: [moved] }))
  assert.deepEqual(hits.filter((f) => f.sha === merge).length, 1, JSON.stringify(hits))
  assert.deepEqual(hits.filter((f) => f.sha === fenced), [], 'the test round wrote inside its fence')
})
