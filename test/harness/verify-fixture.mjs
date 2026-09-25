// test/harness/verify-fixture.mjs — the repositories lib/verify.mjs is measured against.
//
// These fixtures are REAL: a real git repository, a real linked worktree, a real commit series,
// and a real test suite that really passes or really fails. None of that is negotiable — the
// whole value of test/verify.test.mjs is that the discriminator moves HEAD, restores files, runs
// a suite there and puts the tree back, and not one of those steps is observable against a mock.
//
// What IS negotiable is building the same starting repository from scratch once per test. That
// cost is not the thing under test, and on Windows it dominates everything that is: constructing
// the repo, its worktree and its series takes ~1690ms of git process spawns, against ~1500ms for
// the whole verify() call it exists to feed. Twenty-odd tests each paid it.
//
// So a template is built ONCE per distinct shape and copied per test. `git worktree repair` is
// what makes the copy legitimate rather than a trick: a copied worktree carries the template's
// absolute paths in `.git/worktrees/<name>/gitdir` and in `wt/.git`, and repair re-points both at
// wherever the copy actually landed. The result is an ordinary linked worktree — `rev-parse
// --git-dir` differs from `--git-common-dir`, `worktree list` sees it, and the discriminator's
// detached checkout and restore work exactly as they do on a freshly built one.
//
// The equivalence is not asserted here, it is TESTED: test/verify.test.mjs pins that a real
// verify() run over a clone produces a byte-identical payload to one over a freshly built
// fixture, for a green order and for a red one. That test is the licence for this file, and if
// a future change makes a clone diverge from real construction it fails rather than drifting.
//
// TWO WAYS TO BREAK THIS, both cheap to avoid and expensive to debug:
//
//   Template poisoning. A template is shared by every clone taken after it. Nothing may write
//   into one, so no caller is ever handed a template's path — `fromTemplate` copies out of it and
//   returns the copy, and the templates live under a root this module alone knows.
//
//   A worktree that was never repaired. Any fixture that registers more than one worktree must
//   repair each of them; a missed one does not fail loudly, it quietly resolves into whichever
//   directory the template happened to occupy.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// This file's consumers run under `node --test`, and the fixtures' own suites are `node --test`
// too. Node marks its test children with NODE_TEST_CONTEXT and a grandchild that sees it refuses
// to run any file at all — silently, with exit 0, which would make every fixture suite "pass".
// The variable is this runner's private business and has no place in a repository's own commands.
// It lives HERE rather than in one test file so that any file building these fixtures is covered
// by importing them, which is the whole hazard of splitting a suite that spawns its own runners.
delete process.env.NODE_TEST_CONTEXT

export const EFFORT = 'widget'
export const NODE = 'w1'
export const BRANCH = 'agentics/widget--w1'
export const BUILD = 'node tools/build.mjs'
// The runner's output format is pinned rather than left to Node's default, which is `spec` on a
// terminal and differs by major version otherwise (Node 22 writes TAP to a pipe, later versions
// `spec`). A fixture whose suite prints a different format on another machine is a test that
// passes on one of them. The TAP path is covered on its own, by name, in test/verify.test.mjs.
export const SUITE = 'node --test --test-reporter=spec'
export const TEST_ONE = 'node --test --test-reporter=spec {file}'
export const SUITE_TAP = 'node --test --test-reporter=tap'

export const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
export const rev = (cwd, ref) => git(cwd, 'rev-parse', ref).stdout.trim()

const posix = (p) => String(p).split('\\').join('/')

export const WIDGET_TEST = [
  "import { test } from 'node:test'",
  "import assert from 'node:assert/strict'",
  "import { label } from '../src/widget.mjs'",
  '',
  "test('the widget is labelled hi', () => {",
  "  assert.equal(label(), 'hi')",
  '})',
  '',
].join('\n')

// Where templates live and where clones are cut. One root, removed when the process ends: a
// template outlives every individual test by design, so `t.after` is the wrong owner for it.
let root = null
let made = 0

function templateRoot() {
  if (root) return root
  root = posix(mkdtempSync(join(tmpdir(), 'agentics-verify-')))
  process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }) } catch { /* the OS gets it */ } })
  return root
}

/** A directory nothing has claimed yet, under the fixture root. */
const fresh = (prefix) => {
  const dir = join(templateRoot(), prefix + made++)
  return posix(dir)
}

// ------------------------------------------------------------------ construction, for real

/** The base repository: a passing suite, a build command, and one source file to change. */
function buildRepository(dir) {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main', '.')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'commit.gpgsign', 'false')

  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'test'))
  mkdirSync(join(dir, 'tools'))

  writeFileSync(join(dir, 'src', 'widget.mjs'), "export const label = () => 'plain'\n")
  writeFileSync(join(dir, 'tools', 'build.mjs'), '// a build that succeeds\n')
  writeFileSync(join(dir, 'test', 'base.test.mjs'), [
    "import { test } from 'node:test'",
    "test('the base suite passes', () => {})",
    '',
  ].join('\n'))

  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

/** That repository, plus one leaf's worktree carrying its series. */
function buildOrder(dir, { implemented, trailer }) {
  buildRepository(dir)
  const worktree = dir + '/wt'

  git(dir, 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'main')
  writeFileSync(join(worktree, 'test', 'widget.test.mjs'), WIDGET_TEST)
  if (implemented) writeFileSync(join(worktree, 'src', 'widget.mjs'), "export const label = () => 'hi'\n")

  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-qm', 'feat: label the widget hi' + (trailer ? '\n\n' + trailer : ''))
  return dir
}

/**
 * A tdd-pair cycle: a red commit landing the widget test, then a green commit implementing it,
 * both on one worktree's branch. The green leaf's base is the red commit — the green is cut from
 * its red's branch head — so its own diff carries no test at all.
 */
function buildCycle(dir) {
  buildRepository(dir)
  const worktree = dir + '/wt'

  git(dir, 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'main')
  writeFileSync(join(worktree, 'test', 'widget.test.mjs'), WIDGET_TEST)
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-qm', 'test(w1): pin the widget label')
  writeFileSync(join(worktree, 'src', 'widget.mjs'), "export const label = () => 'hi'\n")
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-qm', 'feat(w2): label the widget hi')
  return dir
}

// ------------------------------------------------------------------ template and clone

const templates = new Map()

/** The template for one shape, built on first use and reused after. */
function templateFor(key, build) {
  if (!templates.has(key)) {
    const dir = fresh('tmpl-')
    build(dir)
    templates.set(key, dir)
  }
  return templates.get(key)
}

/**
 * A private copy of a template, with every worktree link re-pointed at where it now lives.
 *
 * `worktrees` names the copied worktree directories, relative to the repository root. Each is
 * repaired; a fixture growing a second worktree adds it here rather than discovering later that
 * one of them still resolves into the template.
 */
function fromTemplate(t, key, build, worktrees = []) {
  const template = templateFor(key, build)
  const dir = fresh('run-')

  cpSync(template, dir, { recursive: true })
  for (const relative of worktrees) git(dir, 'worktree', 'repair', dir + '/' + relative)
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  return dir
}

// ------------------------------------------------------------------ what the tests ask for

/** A repository with a passing suite, a build command, and one source file to change. */
export function repository(t) {
  return fromTemplate(t, 'repository', buildRepository)
}

/**
 * One leaf's worktree, cut from main and carrying its series.
 * `implemented: false` is a RED leaf — the new test lands and nothing makes it pass.
 */
export function order(t, { implemented = true, trailer = '' } = {}) {
  const key = 'order:' + (implemented ? 'green' : 'red') + ':' + trailer
  const dir = fromTemplate(t, key, (d) => buildOrder(d, { implemented, trailer }), ['wt'])
  const worktree = dir + '/wt'

  return { dir, worktree, base: rev(dir, 'main'), head: rev(worktree, 'HEAD') }
}

/**
 * A red → green cycle on one branch: `red` is the red commit (the green's base), `head` the
 * green's tip, `base` main.
 */
export function cycle(t) {
  const dir = fromTemplate(t, 'cycle', buildCycle, ['wt'])
  const worktree = dir + '/wt'
  return { dir, worktree, base: rev(dir, 'main'), red: rev(worktree, 'HEAD~1'), head: rev(worktree, 'HEAD') }
}

/**
 * The same leaf, built from scratch rather than copied.
 *
 * Only the equivalence test wants this — it is the other side of the comparison that licenses
 * every clone above, so it deliberately shares the construction functions and not the cache.
 */
export function orderBuiltFresh(t, { implemented = true, trailer = '' } = {}) {
  const dir = fresh('fresh-')
  buildOrder(dir, { implemented, trailer })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const worktree = dir + '/wt'

  return { dir, worktree, base: rev(dir, 'main'), head: rev(worktree, 'HEAD') }
}
