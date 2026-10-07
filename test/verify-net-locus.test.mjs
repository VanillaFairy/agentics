// test/verify-net-locus.test.mjs — lib/verify.mjs's series check judges `locus-breach` on the
// series' net diff (base...HEAD, renames split) through the locus's `admits`, and holds a
// shell-less author's commits to their own fences, against real repositories.
//
// Design: docs/DESIGN.md#the-locus, docs/DESIGN.md#verify-payload.
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

const breaches = (payload) => payload.series_findings.filter((f) => f.check === 'locus-breach')
const naming = (findings, file) => findings.filter((f) => String(f.message).includes(file))

/** A leaf over main: its own series, rigor trivial. */
function leaf(c, over = {}) {
  return verify({ ...options({ worktree: c.worktree, base: c.base, head: rev(c.worktree, 'HEAD') }), rigor: 'trivial', ...over })
}

/** A green over its red: the base is the red commit, the cycle's test is named. */
function green(c, over = {}) {
  return verify({
    ...options({ worktree: c.worktree, base: c.red, head: rev(c.worktree, 'HEAD') }),
    rigor: 'tdd-pair', role: 'green', locus: ['src/widget.mjs'], tests: [TEST_FILE], ...over,
  })
}

// ---------------------------------------------------------------- the net diff

test('a stray file a later commit removes leaves no locus-breach', (t) => {
  const c = order(t)
  commit(c.worktree, { [STRAY]: 'one\n' }, 'chore: note something')
  commit(c.worktree, { [STRAY]: null }, 'chore: drop the note')
  const payload = leaf(c)
  assert.deepEqual(breaches(payload), [])
  assert.deepEqual(naming(payload.series_findings, STRAY), [], 'no finding of any kind names the removed file')
})

test('a stray file left in the series is one blocking breach naming it', (t) => {
  const c = order(t)
  commit(c.worktree, { [STRAY]: 'one\n' }, 'chore: note something')
  commit(c.worktree, { [STRAY]: 'two\n' }, 'chore: note it again')
  const hits = breaches(leaf(c))
  assert.equal(hits.length, 1, 'one breach per file in the net diff, not one per commit')
  assert.ok(String(hits[0].message).includes(STRAY))
  assert.equal(hits[0].blocking, true)
  assert.equal(hits[0].sha, '', 'a net-diff finding belongs to no one commit')
})

test('a new test file beside a listed file passes', (t) => {
  const c = order(t)
  commit(c.worktree, { 'src/widget.test.mjs': PASSING }, 'test: add a sibling test')
  const payload = leaf(c)
  assert.deepEqual(breaches(payload), [])
  assert.deepEqual(naming(payload.series_findings, 'src/widget.test.mjs'), [])
})

test('an existing unlisted test file changed is a breach', (t) => {
  const c = order(t)
  commit(c.worktree, { 'test/base.test.mjs': PASSING }, 'test: change the base suite')
  const hits = breaches(leaf(c))
  assert.equal(hits.length, 1)
  assert.ok(String(hits[0].message).includes('test/base.test.mjs'))
  assert.equal(hits[0].blocking, true)
})

test('a path another unmerged leaf holds is a breach though the locus lists it', (t) => {
  const c = order(t)
  const payload = leaf(c, { held: ['src/widget.mjs'] })
  const hits = breaches(payload)
  assert.equal(naming(hits, 'src/widget.mjs').length, 1)
  assert.deepEqual(naming(hits, TEST_FILE), [], 'the test file is not held')
  assert.equal(naming(hits, 'src/widget.mjs')[0].blocking, true)
})

test('a file moved from outside the locus into it is a breach of the path it removed', (t) => {
  const c = order(t)
  const moved = git(c.worktree, 'mv', 'tools/build.mjs', 'src/build.mjs')
  assert.equal(moved.status, 0, moved.stderr)
  commit(c.worktree, {}, 'chore: move the build')
  const payload = leaf(c, {
    locus: ['src/widget.mjs', TEST_FILE, 'src/build.mjs'], build: 'node -e "process.exit(0)"',
  })
  const hits = breaches(payload)
  assert.equal(naming(hits, 'tools/build.mjs').length, 1, 'the removal of an unlisted path is a breach')
  assert.deepEqual(naming(hits, 'src/build.mjs'), [], 'the listed addition is not')
})

test('a new test file beside a green\'s source is a breach', (t) => {
  const c = cycle(t)
  commit(c.worktree, { 'src/widget.test.mjs': PASSING }, 'test: add a sibling test')
  const hits = breaches(green(c))
  const own = naming(hits, 'src/widget.test.mjs')
  assert.equal(own.length, 1, 'a green may not write tests, beside its source or anywhere')
  assert.equal(own[0].blocking, true)
})

// ---------------------------------------------------------------- the fences

test('a commit made for a shell-less author is held to its own fence', (t) => {
  const c = cycle(t)
  const fenced = commit(c.worktree, {
    [TEST_FILE]: WIDGET_TEST + "\ntest('the widget is a function', () => { assert.equal(typeof label, 'function') })\n",
    'src/widget.mjs': "export const label = () => 'hi'\n// touched by the test round\n",
  }, 'test(w3): pin more of the widget')
  const hits = breaches(green(c, { fences: { [fenced]: [TEST_FILE] } }))
  const own = hits.filter((f) => f.sha === fenced && String(f.message).includes('src/widget.mjs'))
  assert.equal(own.length, 1, 'the fenced commit wrote outside its fence')
  assert.deepEqual(naming(hits, TEST_FILE), [], 'the file inside its fence is no breach')
  assert.equal(hits.filter((f) => f.sha === c.head).length, 0, 'the green commit is held to the locus, which lists its file')
})

test('a test file only a fenced commit changed is no breach of the leaf\'s locus', (t) => {
  const c = cycle(t)
  const fenced = commit(c.worktree, {
    [TEST_FILE]: WIDGET_TEST + "\ntest('the widget is a function', () => { assert.equal(typeof label, 'function') })\n",
  }, 'test(w3): pin more of the widget')
  const payload = green(c, { fences: { [fenced]: [TEST_FILE] } })
  assert.deepEqual(breaches(payload), [])
  assert.deepEqual(naming(payload.series_findings, TEST_FILE), [])
})

test('a cycle test file an unfenced commit also changed is a breach', (t) => {
  const c = cycle(t)
  const fenced = commit(c.worktree, {
    [TEST_FILE]: WIDGET_TEST + "\ntest('the widget is a function', () => { assert.equal(typeof label, 'function') })\n",
  }, 'test(w3): pin more of the widget')
  const unfenced = commit(c.worktree, { [TEST_FILE]: WIDGET_TEST }, 'fix(w2): change the test back')
  const hits = breaches(green(c, { fences: { [fenced]: [TEST_FILE] } }))
  assert.equal(hits.length, 1, 'the net diff of the file is empty, yet the unfenced commit changed it')
  assert.equal(hits[0].sha, unfenced)
  assert.ok(String(hits[0].message).includes(TEST_FILE))
})
