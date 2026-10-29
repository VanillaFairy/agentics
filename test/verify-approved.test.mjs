// test/verify-approved.test.mjs — lib/verify.mjs holds a test round to the red's approved tests:
// `test-removed`, `approved_failing`, the `key` and `approved_failing` on the journalled
// `verify-observed` line, and `node lib/verify.mjs --options -`, against real repositories.
//
// Design: docs/DESIGN.md#conversations, docs/DESIGN.md#verify-payload.
//
// A round is a green's test-author round: one commit made in the worktree after the cycle, over
// the red's approved version of the cycle's test file. Findings are read by `check` and by what
// their message names; `approved_failing` is read with `some` and `every` unless it is fully fixed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verify } from '../lib/verify.mjs'
import { readLog } from '../lib/ledger.mjs'
import {
  BRANCH, cycle, EFFORT, EXECUTION, git, NODE, options, rev, WIDGET_TEST,
} from './harness/verify-fixture.mjs'

const CLI = fileURLToPath(new URL('../lib/verify.mjs', import.meta.url))
const FILE = 'test/widget.test.mjs'
const CASE = 'the widget is labelled hi'
const DECLARATION = `test('${CASE}', () => {`
const SOURCE_HI = "export const label = () => 'hi'\n"
const SOURCE_BYE = "export const label = () => 'bye'\n"
const WIDGET_TEST_BYE = WIDGET_TEST.replace("label(), 'hi'", "label(), 'bye'")
const EXTRA_CASE = "\ntest('the widget label is a string', () => {\n  assert.equal(typeof label(), 'string')\n})\n"

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

/** The cycle, then one round's commit over it; `approved` is the red's version of the test file. */
function round(t, changes) {
  const c = cycle(t)
  const head = commit(c.worktree, changes, 'test(w3): round the tests')
  return { ...c, base: c.head, head, approved: [{ file: FILE, sha: c.red }] }
}

/** The round's measurement options. */
const asked = (r, over = {}) => ({
  ...options({ worktree: r.worktree, base: r.base, head: r.head }),
  rigor: 'tdd-pair', role: 'green', producer: 'test-author',
  tests: [FILE], expects: ['src/widget.mjs'], approved: r.approved, ...over,
})

const journaling = (r) => ({ repo: r.dir, effort: EFFORT, execution: EXECUTION, node: NODE, branch: BRANCH })
const journal = (r) => readLog(r.dir, EFFORT, 'journal:' + EXECUTION).entries
const removals = (payload) => payload.series_findings.filter((f) => f.check === 'test-removed')
const failing = (payload) => payload.approved_failing
const LF = (text) => text.replace(/\r\n/g, '\n')

// ---------------------------------------------------------------- test-removed

test('test-removed names an approved case the round removed', (t) => {
  const r = round(t, { [FILE]: WIDGET_TEST.replace(CASE, 'the widget is called hi') })
  const hits = removals(verify(asked(r)))
  assert.equal(hits.length, 1)
  assert.equal(hits[0].blocking, true)
  assert.equal(hits[0].sha, '')
  assert.ok(String(hits[0].message).includes(FILE), 'the message names the file')
  assert.ok(String(hits[0].message).includes(DECLARATION), 'the message names the declaration')
})

test('removing one of two identical approved cases is test-removed', (t) => {
  const c = cycle(t)
  const doubled = commit(c.worktree, { [FILE]: WIDGET_TEST + '\n' + WIDGET_TEST.split('\n').slice(4).join('\n') },
    'test(w1): pin the label twice')
  assert.equal(readFileSync(join(c.worktree, FILE), 'utf8').split(DECLARATION).length - 1, 2, 'the approved text holds the case twice')
  const head = commit(c.worktree, { [FILE]: WIDGET_TEST }, 'test(w3): keep one copy')
  const r = { ...c, base: doubled, head, approved: [{ file: FILE, sha: doubled }] }
  const hits = removals(verify(asked(r)))
  assert.equal(hits.length, 1)
  assert.ok(String(hits[0].message).includes(DECLARATION))
})

test('no test-removed when the approved file is unchanged', (t) => {
  const r = round(t, { 'src/widget.mjs': SOURCE_HI + '// a round that leaves the tests alone\n' })
  const payload = verify(asked(r))
  assert.deepEqual(removals(payload), [])
  assert.deepEqual(failing(payload), [], 'a file that did not change is not run in the approved version\'s place')
})

// ---------------------------------------------------------------- approved_failing

test('approved_failing names an approved case that fails at the head, is on the journalled verify-observed, and the run leaves the worktree as it found it', (t) => {
  const r = round(t, { 'src/widget.mjs': SOURCE_BYE, [FILE]: WIDGET_TEST_BYE })

  const payload = verify(asked(r, { ...journaling(r), key: 'k-0002' }))

  assert.ok(Array.isArray(failing(payload)))
  assert.ok(failing(payload).some((e) => e.file === FILE && String(e.id).includes(CASE)),
    'the approved case that now fails is named')
  assert.ok(failing(payload).every((e) => e.file === FILE), "every entry is the approved file's")

  const [line] = journal(r)
  assert.deepEqual(line.approved_failing, failing(payload), 'the round has approved cases failing, and the journalled line carries them')

  const atHead = git(r.worktree, 'show', r.head + ':' + FILE).stdout
  assert.equal(LF(readFileSync(join(r.worktree, FILE), 'utf8')), LF(atHead), "running the approved version leaves the head's text in the worktree")
  assert.equal(git(r.worktree, 'status', '--porcelain').stdout.trim(), '', 'and the worktree clean')
  assert.equal(rev(r.worktree, 'HEAD'), r.head, 'and HEAD where it was')
})

test('approved_failing is empty when every approved case passes', (t) => {
  const r = round(t, { [FILE]: WIDGET_TEST + EXTRA_CASE })
  const payload = verify(asked(r))
  assert.deepEqual(failing(payload), [])
  assert.deepEqual(removals(payload), [])
})

test('an approved file the head deleted loses every case, and its failing cases are named', (t) => {
  const r = round(t, { [FILE]: null, 'src/widget.mjs': SOURCE_BYE })
  const payload = verify(asked(r))
  const hits = removals(payload)
  assert.ok(hits.some((f) => String(f.message).includes(DECLARATION)), 'the deleted case is removed')
  assert.ok(failing(payload).some((e) => e.file === FILE && String(e.id).includes(CASE)),
    'the approved case fails at the head and is named')
  assert.equal(existsSync(join(r.worktree, FILE)), false, 'the head had no such file, so none is left')
  assert.equal(git(r.worktree, 'status', '--porcelain').stdout.trim(), '')
})

test('an approved version that cannot be read is environment_broken, series_unreadable', (t) => {
  const r = round(t, { [FILE]: WIDGET_TEST + EXTRA_CASE })
  const control = verify(asked(r))
  assert.equal(control.stop_reason, 'completed', 'the same round measures when its approved version reads')

  const payload = verify(asked(r, { approved: [{ file: FILE, sha: '0'.repeat(40) }] }))
  assert.equal(payload.stop_reason, 'environment_broken')
  assert.equal(payload.error.kind, 'series_unreadable')
})

test('an approved file that fails naming no case is one entry with an empty id', (t) => {
  const r = round(t, { [FILE]: WIDGET_TEST + EXTRA_CASE })
  const payload = verify(asked(r, { testOne: 'node -e "process.exit(1)" {file}' }))
  assert.deepEqual(failing(payload), [{ file: FILE, id: '' }])
})

// ---------------------------------------------------------------- the CLI

/** `node lib/verify.mjs --options -` with `input` on standard input. */
const cli = (input) => spawnSync(process.execPath, [CLI, '--options', '-'], { input, encoding: 'utf8' })

test('node lib/verify.mjs --options - reads its options from standard input and prints the payload as one line', { timeout: 120_000 }, (t) => {
  const r = round(t, { [FILE]: WIDGET_TEST.replace(CASE, 'the widget is called hi') })
  const run = cli(JSON.stringify(asked(r, { ...journaling(r), key: 'k-cli' })))
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.trim().split('\n').length, 1, 'one line')
  const payload = JSON.parse(run.stdout)
  assert.equal(typeof payload.stop_reason, 'string', 'the payload itself is printed, not an envelope')
  assert.ok(removals(payload).some((f) => String(f.message).includes(DECLARATION)),
    'the approved files that came from standard input are held to')
  const [line] = journal(r)
  assert.equal(line.key, 'k-cli')

  for (const input of ['not json', '[]']) {
    const bad = cli(input)
    assert.notEqual(bad.status, 0, `${JSON.stringify(input)} is not a JSON object`)
    assert.ok(!String(bad.stdout).includes('stop_reason'), 'no payload is printed')
    assert.ok(!String(bad.stderr).includes('stop_reason'), 'no payload is printed')
  }
})
