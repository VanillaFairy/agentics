// lib/verify.mjs — the mechanical checks of one leaf, as one script.
//
// Design: docs/DESIGN.md#verification.
//
// Running a command and copying its exit status is not judgment, and GP4 says cost comes
// out of method: a deterministic thing is a script. So the commit-series check, the build, the
// typecheck, the suite, the discriminator, the declared mutations and the leaf's named checks
// all happen here, in one process, and what a courier carries back is one digest-covered line of
// JSON.
//
// WHAT THIS FILE DOES NOT DO. It decides nothing about whether a leaf passed. It observes, and
// the verdict is computed from its payload by lib/verdict.mjs — the one home of that predicate,
// used by leaf-close on the live path and by lib/resume.mjs on a resume, so a measurement green
// in one invocation cannot be red in the next for no reason anybody can see. That is the whole
// safety argument for letting a script do this work: nothing here can certify anything.
//
// WHICH CHECKS RUN is the leaf's rigor (and, inside a tdd-pair or tdd-triad cycle, its role):
//
//   rigor/role   series  discriminator                    mutations        named checks
//   verify       no      no                               no               yes
//   trivial      yes     no                               no               when given
//   tests-only   yes     yes (the verdict reads passes_now) when declared   when given
//   tdd          yes     yes (fails at base, passes now)  when declared    when given
//   red          yes     yes (fails at base, fails now)   no               no
//   green        yes     over the cycle's tests           no               no
//   audit        yes, an empty series expected  no        when declared    no
//
// "Required" (tests-only and audit need at least one declared mutation) is a verdict question,
// so it lives in lib/verdict.mjs; this file runs what it is given and says what it was given.
// No rigor at all measures the way every order was measured before rigor existed: series, the
// full discriminator, mutations when declared, checks when given.
//
// ABSENT IS NOT FAILED, IN EITHER DIRECTION. `absent` means the repository defines no such
// command at this commit; `failed` means a command ran and exited non-zero. A shell cannot tell
// the two apart — a missing command and a broken build both come back non-zero — so this file
// NEVER infers `absent`. It is recorded only when the caller declares it (`--build-absent`),
// which is a fact somebody established. A command the caller did not name and did not declare
// absent is `command_unknown`: a typed error, escalated to a model, never quietly recorded as a
// repository with no build. That holds for every rigor, a `verify` leaf included.
//
// THE ENVIRONMENT CHECK IS FIRST AND IT REFUSES. The discriminator stashes and moves HEAD. Doing
// that in the tree a human is working in destroys work, so this file establishes that it is
// standing in a LINKED worktree before it touches anything.
//
// THE OBSERVATION JOURNALS ITSELF. Given `repo`, `effort`, `execution` and `node`, `verify()`
// appends the `verify-observed` line through lib/ledger.mjs inside the process that made the
// measurement, so there is no window between the work and the record. The ledger mints `seq`.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { LOG_FORMAT, analyzeSeries, parseLog } from './commit-series.mjs'
import { append } from './ledger.mjs'
import { withTestLock } from './locks.mjs'
import { envelope } from './store.mjs'

/** The last lines of suite output that travel back, verbatim. */
const TAIL_LINES = 40

/** Output buffers: a test suite's output is routinely megabytes. */
const MAX_BUFFER = 1 << 26

const posix = (p) => String(p || '').split('\\').join('/')

/** One git command inside a directory. Never throws; the caller reads the fields. */
function git(cwd, args) {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER, windowsHide: true })
  return {
    ok: run.status === 0,
    status: run.status === null ? -1 : run.status,
    stdout: run.stdout || '',
    stderr: run.stderr || '',
    failedToStart: Boolean(run.error),
    message: run.error ? run.error.message : '',
  }
}

/**
 * One command from the repository's own documentation, run through `sh -c` on every platform: the
 * investigator proves commands in a POSIX shell, and cmd.exe exits 1, not 127, for a missing command.
 *
 * `ran` is false only when the SHELL could not be started. A command the shell could not find
 * exits 127, which is an observed non-zero exit and is reported as one — working out that a
 * repository defines no such command is not this function's job and is not inferrable here.
 */
function shell(cwd, command) {
  const run = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, windowsHide: true })
  return {
    ran: !run.error,
    status: run.status === null ? -1 : run.status,
    output: (run.stdout || '') + (run.stderr || ''),
    message: run.error ? run.error.message : '',
  }
}

// A runner's banner rules — `⎯⎯⎯⎯⎯⎯⎯`, `━━━━━━━`, `═══════` — carry no information and are the
// one part of a tail a courier has to COUNT rather than read. In run 20260902-124933 that is
// exactly where the single corrupted payload of the run was damaged: a model retyping 2.3 KB
// dropped two of them and gained a stray character, the digest caught it, and the measurement
// cost a second dispatch one tier up. Collapsing a run of three or more identical non-ASCII
// glyphs to one leaves every word of the evidence verbatim and removes the counting.
//
// Deliberately narrow. Non-ASCII text that is not a repeated rule — an assertion diff, a test
// name in another language, a path — is untouched, because it is evidence and this is not a
// paraphrase: the program does this before the digest is computed, so what a courier carries
// still digests to exactly what the runner's own output produced.
//
// The line terminators are excluded explicitly. They are outside printable ASCII too, and a
// class that swallowed them would collapse the tail's blank lines — which is a change to the
// output's SHAPE, not to its decoration, and would quietly falsify the line count this tail is
// bounded by.
const deruled = (text) => text.replace(/([^\x20-\x7E\t\r\n])\1{2,}/g, '$1')

const tailOf = (text) => deruled(String(text || '').split('\n').slice(-TAIL_LINES).join('\n'))

// ---------------------------------------------------------------- the environment check
//
// A linked worktree's git directory is `<common>/worktrees/<name>`; the main working tree's IS
// the common directory. That single comparison is the whole test, and it is the one git itself
// answers rather than a guess from the path's shape.

/** @returns {{kind: string, message: string}|null} */
export function worktreeProblem(worktree) {
  if (!worktree) {
    return {
      kind: 'no_worktree',
      message: 'no worktree path was given. This procedure stashes and moves HEAD, so it will ' +
        'not run without one.',
    }
  }
  if (!existsSync(worktree)) {
    return { kind: 'no_worktree', message: posix(worktree) + ' does not exist' }
  }

  const inside = git(worktree, ['rev-parse', '--is-inside-work-tree'])
  if (inside.failedToStart) {
    return { kind: 'no_worktree', message: 'git could not be run: ' + inside.message }
  }
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return {
      kind: 'no_worktree',
      message: posix(worktree) + ' is not inside a git working tree: ' +
        (inside.stderr.trim() || 'git rev-parse --is-inside-work-tree said ' +
          JSON.stringify(inside.stdout.trim())),
    }
  }

  const gitDir = git(worktree, ['rev-parse', '--absolute-git-dir'])
  let common = git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok) {
    // `--path-format` is git 2.31+. The older spelling answers relative to the worktree, so it
    // is resolved here rather than compared as it stands.
    const relative = git(worktree, ['rev-parse', '--git-common-dir'])
    common = { ok: relative.ok, stdout: relative.ok ? resolve(worktree, relative.stdout.trim()) : '' }
  }

  if (!gitDir.ok || !common.ok || !common.stdout.trim()) {
    return {
      kind: 'no_worktree',
      message: 'git could not say where this working tree\'s git directory is, so whether it is ' +
        'a linked worktree cannot be established — and an unanswered question is not a yes',
    }
  }

  if (posix(resolve(gitDir.stdout.trim())) === posix(resolve(common.stdout.trim()))) {
    return {
      kind: 'main_worktree',
      message: posix(worktree) + ' is the repository\'s MAIN working tree, not a worktree cut ' +
        'for this leaf. The discriminator stashes and moves HEAD, and doing that in the tree ' +
        'somebody is working in destroys work. Create a throwaway worktree at the pre-change ' +
        'SHA and point this at that instead.',
    }
  }

  return null
}

// ---------------------------------------------------------------- test files
//
// Which of a change's files are tests, by a CLOSED pattern set rather than by judgment. The set
// is stated here, and the notes say how many changed files matched, so
// an empty discriminator is always accompanied by the number it was drawn from — "this order
// added no tests" and "the pattern matched none of its files" are different sentences.

const TEST_PATH_PATTERNS = [
  /(^|\/)tests?\//i,
  /(^|\/)spec\//i,
  /(^|\/)__tests__\//i,
  /\.(test|spec)\.[A-Za-z0-9]+$/i,
  /(^|\/)test_[^/]+\.[A-Za-z0-9]+$/i,
  /_test\.[A-Za-z0-9]+$/i,
  /(^|\/)[A-Za-z0-9]+(Test|Tests|Spec)\.[A-Za-z0-9]+$/,
]

/** Pure. Whether a repo-relative path is a test file under the closed pattern set. */
export const isTestPath = (path) => {
  const p = posix(path)
  return TEST_PATH_PATTERNS.some((re) => re.test(p))
}

// ---------------------------------------------------------------- failing tests
//
// The load-bearing half of a failure is its FILE: a red order passes when every failure sits in
// the tests it owns, and an order owns files rather than test ids. So a failure this scanner
// cannot place against a real test file is not reported as an unplaceable entry and is not
// dropped either — it raises `suite_failures_unnamed`, and a model reads the output instead.
// Guessing the file is the one move that turns a detectable problem into a wrong verdict.

const FAILURE_MARKERS = [
  /^\s*not ok \d+\s*-?\s*(.+)$/i,                    // TAP
  /^\s*[\u2716\u2717\u00d7]\s+(.+?)(?:\s+\(\d[^)]*\))?\s*$/, // node --test spec reporter
  /^\s*FAILED\s+(.+)$/,                              // pytest
  /^\s*---\s*FAIL:\s*(.+)$/,                         // go
  /^\s*FAIL\s+(.+)$/,                                // jest, go package lines
  /^\s*\u25cf\s+(.+)$/,                              // jest failure detail
  /^\s*test\s+(.+?)\s+\.\.\.\s*FAILED\s*$/,          // cargo
]

// Runner summary lines wear the same marker as a real failure and name no test. Counting one as
// a failure attributes it to whatever file was printed last, which is how a fence check ends up
// ruling on a line that is not a test at all.
//
// The trailing guard is a negative lookahead rather than `\b`, and the difference is a whole
// class of red order. `\b` treats `/` as a boundary, so `tests/unit/x.test.ts` — the id vitest
// and jest print on their `FAIL <path>` line — read as the summary word `tests` and was thrown
// away. The suite then failed while naming nothing, which raises `suite_failures_unnamed`,
// which is `environment_broken`, which `verifiable()` refuses: in run 20260902-124933 a correct
// red order could not be verified at all, and the fix round dispatched at it had no defect to
// find. A summary word is followed by a space or the end of the line; a path continues into
// its own next segment, and every character that can do that is excluded here.
const SUMMARY_ID = /^(failing tests?:?|tests?|suites?|pass|fail|cancelled|skipped|todo|duration_ms)(?![\w/\\.-])/i

/**
 * Every path-shaped token in a line that names an existing test file, REPO-RELATIVE.
 *
 * Repo-relative is not cosmetic: the caller intersects these paths against the order's declared
 * locus, which is repo-relative, so an absolute path reported here matches no fence and reads as
 * collateral damage. Runners print all of it — relative paths, absolute paths, and `file://`
 * URLs in stack frames — so every form is normalized to the one the fence is written in.
 */
function testPathsIn(text, worktree) {
  const root = resolve(worktree)
  const found = []

  for (const raw of String(text || '').split(/[\s,'"()[\]]+/)) {
    if (!raw) continue

    let token = posix(raw)
    if (token.startsWith('file://')) {
      token = token.slice('file://'.length)
      if (/^\/[A-Za-z]:/.test(token)) token = token.slice(1)
      try {
        token = decodeURIComponent(token)
      } catch { /* a token that is not valid percent-encoding is used as it stands */ }
    }

    // pytest writes `path::id`; runners and stack frames write `path:line:col`.
    token = token.split('::')[0].replace(/:\d+(:\d+)?$/, '').replace(/^\.\//, '')
    if (!token) continue

    const abs = resolve(root, token)
    const rel = posix(relative(root, abs))
    if (!rel || rel.startsWith('..')) continue
    if (!isTestPath(rel) || !existsSync(abs)) continue

    found.push(rel)
  }

  return found
}

/**
 * Pure-ish (it stats the worktree). Failures named by a suite's own output.
 * @returns {{failures: Array<{file: string, id: string}>, markers: number, unplaced: number}}
 */
export function extractFailures(output, worktree) {
  const hits = []
  let current = ''

  // TAP names a failure's file AFTER its marker, in the YAML block under it (`location: '<path>:
  // line:col'`), and `node --test` writes TAP whenever its stdout is not a terminal on Node 22 —
  // which is always, here. Placing a TAP failure by the path printed BEFORE it attributes it to
  // the previous failure's file, or to nothing at all, and nothing at all is
  // `suite_failures_unnamed` for a perfectly ordinary red leaf. So a TAP marker waits for its own
  // block: its `location:` line places it, and only a block that ends without one falls back to
  // the path in force at the marker. Narrow on purpose — the one key TAP defines for this, never
  // an arbitrary stack frame that might run through a shared helper.
  let pending = null
  const settle = () => {
    if (pending && !pending.file) pending.file = pending.fallback
    pending = null
  }

  for (const raw of String(output || '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    const paths = testPathsIn(line, worktree)

    if (pending) {
      if (/^\s+location:/.test(line)) {
        if (paths.length > 0 && !pending.file) pending.file = paths[0]
        settle()
      } else if (/^\s*\.\.\.\s*$/.test(line)) {
        settle()
      }
    }

    if (paths.length > 0) current = paths[paths.length - 1]

    for (const [index, marker] of FAILURE_MARKERS.entries()) {
      const match = line.match(marker)
      if (!match) continue

      const id = match[1].trim()
      if (!id || SUMMARY_ID.test(id)) break

      const inline = testPathsIn(id, worktree)
      if (index === 0) {
        settle()
        pending = { id, file: inline.length > 0 ? inline[0] : '', fallback: current }
        hits.push(pending)
      } else {
        hits.push({ id, file: inline.length > 0 ? inline[0] : current })
      }
      break
    }
  }
  settle()

  // Two passes, because a runner names one failure TWICE and only one of the two occurrences
  // carries a path: node's reporter streams `✖ <name>` with no file context around it, then
  // repeats every failure in an epilogue under `test at <path>:<line>`. Counting the streamed
  // occurrence as unplaceable would escalate every red order in the pipeline for no reason.
  const placed = new Map()
  for (const hit of hits) if (hit.file && !placed.has(hit.id)) placed.set(hit.id, hit.file)

  const failures = []
  const seen = new Set()
  let unplaced = 0

  for (const hit of hits) {
    const id = hit.id
    const file = hit.file || placed.get(id) || ''

    if (!file) {
      unplaced += 1
      continue
    }

    const key = file + '\u0000' + id
    if (seen.has(key)) continue
    seen.add(key)
    failures.push({ file, id })
  }

  return { failures, markers: hits.length, unplaced }
}

// ---------------------------------------------------------------- the checks

/** The commit-series findings, or the reason they could not be measured. */
function seriesOf(worktree, base, locus) {
  const log = git(worktree, ['log', '--reverse', '--format=' + LOG_FORMAT, '--name-only',
    base + '..HEAD'])

  if (!log.ok) {
    return {
      findings: [],
      error: {
        kind: 'series_unreadable',
        message: 'git log ' + base + '..HEAD did not run: ' +
          (log.stderr.trim() || log.message || 'exit ' + log.status),
      },
    }
  }

  try {
    return { findings: analyzeSeries(parseLog(log.stdout), locus), error: null }
  } catch (err) {
    // parseLog throws on a truncated stream. An empty findings array means "checked, found
    // nothing"; a failed measurement must never wear that shape.
    return {
      findings: [],
      error: { kind: 'series_unreadable', message: 'the commit series could not be read: ' + err.message },
    }
  }
}

/** One command's outcome as the caller's enum, plus what it printed. */
function runNamedCommand(worktree, command, declaredAbsent, what) {
  if (declaredAbsent) {
    return {
      outcome: 'absent',
      output: '',
      note: 'no ' + what + ' command: the dispatch declared this repository defines none',
      error: null,
    }
  }
  if (!command) {
    return {
      outcome: 'absent',
      output: '',
      note: 'the ' + what + ' command was neither named nor declared absent',
      error: {
        kind: 'command_unknown',
        message: 'no ' + what + ' command was named and none was declared absent. A command ' +
          'nobody named is not a repository with no command, and this script does not go ' +
          'looking — that is judgment, and it escalates.',
      },
    }
  }

  const run = shell(worktree, command)
  if (!run.ran) {
    return {
      outcome: 'absent',
      output: '',
      note: 'the ' + what + ' command could not be started: ' + run.message,
      error: {
        kind: 'shell_refused',
        message: 'the shell could not start ' + JSON.stringify(command) + ': ' + run.message,
      },
    }
  }

  return {
    outcome: run.status === 0 ? 'passed' : 'failed',
    output: run.output,
    note: what + ': ' + JSON.stringify(command) + ' exited ' + run.status,
    error: null,
  }
}

/** The single-test command for one file, from the dispatch's template. */
const singleTestCommand = (template, file) =>
  template.includes('{file}') ? template.split('{file}').join(file) : template + ' ' + file

/**
 * The discriminator: does each new test fail WITHOUT the source change?
 *
 * The new tests are restored onto the base tree before they are run there. A test the change
 * ADDED does not exist at base and cannot be run at all; one it MODIFIED reverts to its old
 * content, which passes — and recording that as `failed_on_base: false` fails perfectly correct
 * work. Restoring the tests under measurement is what makes this a discriminator rather than a
 * coin flip.
 *
 * The tree is always put back. A worktree left on a detached HEAD strands every commit a later
 * fix round makes in it, so a restore that did not happen is `tree_not_restored` — loud, not
 * silent.
 */
function discriminate(worktree, base, head, files, template) {
  const now = new Map()
  for (const file of files) {
    const run = shell(worktree, singleTestCommand(template, file))
    now.set(file, { passes: run.ran && run.status === 0, status: run.status, ran: run.ran })
  }

  const at = atBase(worktree, base, () => {
    const entries = []
    const notes = []
    let unrunnable = null
    const restored = git(worktree, ['checkout', head, '--', ...files])
    if (!restored.ok) {
      return {
        entries, notes, unrunnable: {
          kind: 'test_unrunnable',
          message: 'the tests under measurement could not be restored onto the base tree: ' +
            (restored.stderr.trim() || 'git checkout <head> -- <tests> failed') +
            ' — without them this measures the OLD tests, which is not a discriminator',
        },
      }
    }
    for (const file of files) {
      const run = shell(worktree, singleTestCommand(template, file))
      // 127 is the shell's own "no such command". A test that cannot be LAUNCHED at base was not
      // measured there, and recording that as a failure is the laundering IL2 forbids.
      if (!run.ran || run.status === 127) {
        unrunnable = unrunnable || {
          kind: 'test_unrunnable',
          message: file + ' could not be RUN at ' + base + ' (' +
            (run.ran ? 'the shell reported command not found' : run.message) +
            '). Unobserved and failed are different answers.',
        }
        continue
      }
      const head_status = now.get(file)
      entries.push({
        test_id: file,
        failed_on_base: run.status !== 0,
        passes_now: head_status ? head_status.passes : false,
      })
      notes.push(file + ': exit ' + run.status + ' at base, exit ' +
        (head_status ? head_status.status : '?') + ' at head')
    }
    return { entries, notes, unrunnable }
  })
  const value = at.value || { entries: [], notes: [], unrunnable: null }
  return { entries: value.entries, notes: value.notes, error: at.error || value.unrunnable }
}

/**
 * Run `fn` with the worktree checked out at `base`, and put it back: uncommitted work is stashed
 * and restored, and HEAD is re-attached. `{value, error}`: `error` is `base_checkout_refused` when
 * the base could not be reached (and `fn` never ran), `tree_not_restored` when the tree was not
 * put back — a worktree left on a detached HEAD strands every commit a later fix round makes in it.
 */
function atBase(worktree, base, fn) {
  const dirty = git(worktree, ['status', '--porcelain']).stdout.trim() !== ''
  let stashed = false

  if (dirty) {
    const stash = git(worktree, ['stash', 'push', '--include-untracked', '-m', 'agentics-verify'])
    if (!stash.ok) {
      return {
        value: null,
        error: {
          kind: 'base_checkout_refused',
          message: 'the worktree has uncommitted changes and git refused to stash them, so the ' +
            'base could not be checked out without discarding work: ' +
            (stash.stderr.trim() || 'git stash push failed'),
        },
      }
    }
    stashed = true
  }

  const unstash = () => {
    if (!stashed) return null
    const pop = git(worktree, ['stash', 'pop'])
    return pop.ok ? null : 'the stash could not be popped: ' + (pop.stderr.trim() || 'git stash pop failed')
  }

  const moved = git(worktree, ['-c', 'advice.detachedHead=false', 'checkout', base])
  if (!moved.ok) {
    const left = unstash()
    return {
      value: null,
      error: {
        kind: 'base_checkout_refused',
        message: 'git refused to check out the base ' + base + ': ' +
          (moved.stderr.trim() || 'git checkout failed') + (left ? ' — and ' + left : ''),
      },
    }
  }

  const value = fn()

  const back = git(worktree, ['checkout', '-f', '-'])
  const left = unstash()
  const attached = git(worktree, ['symbolic-ref', '-q', 'HEAD'])

  if (!back.ok || !attached.ok || left) {
    return {
      value,
      error: {
        kind: 'tree_not_restored',
        message: 'the worktree was not put back the way it was found' +
          (back.ok ? '' : ': ' + (back.stderr.trim() || 'git checkout -f - failed')) +
          (attached.ok ? '' : '; HEAD is detached, and a commit made there is unreachable once ' +
            'the worktree is removed') +
          (left ? '; ' + left : ''),
      },
    }
  }
  return { value, error: null }
}

/**
 * The baseline: which failing test files fail at the base as well. Only files the change did not
 * touch are asked — a test the change added or edited is its own — and a file that could not be
 * launched at base is not counted, because unobserved is not failed. A failure that was already
 * there is not the change's to fix, whether the base itself is broken (an asset missing from a
 * fresh worktree) or the test is.
 */
function baselineOf(worktree, base, head, failing, tests, template) {
  const diff = git(worktree, ['diff', '--name-only', base + '..' + head])
  if (!diff.ok) return { failing: [], notes: ['baseline not asked: the diff ' + base + '..' + head + ' could not be read'], error: null }
  const touched = new Set([...diff.stdout.split('\n').map((l) => posix(l.trim())).filter(Boolean), ...tests.map(posix)])
  const files = [...new Set(failing.map((f) => posix(f.file)))].filter((f) => f && !touched.has(f))
  if (files.length === 0) return { failing: [], notes: ['baseline: every failing test is one this change touched'], error: null }
  const at = atBase(worktree, base, () => files.filter((file) => {
    const run = shell(worktree, singleTestCommand(template, file))
    return run.ran && run.status !== 0 && run.status !== 127
  }))
  const before = at.value || []
  return {
    failing: before,
    notes: ['baseline: ' + before.length + ' of ' + files.length + ' failing test file(s) the change did not touch fail at ' + base + ' too'],
    error: at.error,
  }
}

/**
 * The mutation check: does this regression net actually BITE?
 *
 * The discriminator asks "did this test fail before the change under it?", which is the wrong
 * question for a test written to hold something already correct in place — a `tests-only`
 * leaf. Its verdict drops the base half and, alone, that would leave the right question unasked
 * by anything mechanical; an `audit` leaf asks nothing else at all. The test-author or auditor
 * declares the break, and this is that question, executed.
 *
 * A spec is a TEXT SUBSTITUTION in one tracked file, not a command. That is the whole safety
 * argument. A command can do anything and has no defined inverse; a substitution cannot escape
 * the worktree, reverts with one `git checkout --`, and — crucially — can REFUSE. A `find` that
 * matches zero times is a stale spec; one that matches many times is ambiguous about which site
 * was broken. Both are `unapplied`, never "the test did not bite": reporting a spec this program
 * could not apply as a failing net is the laundering IL2 forbids.
 *
 * The tree is always put back, and a file left dirty afterwards is `tree_not_restored` — loud,
 * for the same reason the discriminator's is. A worktree carrying a deliberate break into a
 * later fix round would have that round chasing a defect nobody wrote.
 */
function mutateAndRun(worktree, specs, template) {
  const entries = []
  const notes = []

  if (!template) {
    return {
      entries: [],
      notes: [],
      error: {
        kind: 'command_unknown',
        message: 'this leaf carries mutation specs and no single-test command template was ' +
          'named, so the mutation could not be asked its question',
      },
    }
  }

  for (const spec of specs) {
    const file = String((spec && spec.file) || '')
    const find = String((spec && spec.find) || '')
    const replace = String((spec && spec.replace) || '')
    const expect = Array.isArray(spec && spec.expect_failing) ? spec.expect_failing.map(String) : []

    const entry = {
      file,
      applied: false,
      unapplied_reason: '',
      expect_failing: expect,
      observed_failing: [],
      bites: false,
    }

    const absolute = resolve(worktree, file)
    if (!file || !existsSync(absolute)) {
      entry.unapplied_reason = 'no such file in the worktree'
      entries.push(entry)
      notes.push('mutation ' + file + ': not applied — ' + entry.unapplied_reason)
      continue
    }
    if (expect.length === 0) {
      entry.unapplied_reason = 'the spec names no test that must fail, so it asks nothing'
      entries.push(entry)
      notes.push('mutation ' + file + ': not applied — ' + entry.unapplied_reason)
      continue
    }

    let original = ''
    try {
      original = readFileSync(absolute, 'utf8')
    } catch (err) {
      entry.unapplied_reason = 'the file could not be read: ' + err.message
      entries.push(entry)
      notes.push('mutation ' + file + ': not applied — ' + entry.unapplied_reason)
      continue
    }

    const hits = find === '' ? 0 : original.split(find).length - 1
    if (hits !== 1) {
      entry.unapplied_reason = hits === 0
        ? 'the text to replace does not occur in this file, so the spec is stale'
        : 'the text to replace occurs ' + hits + ' times, so which site was broken is unknown'
      entries.push(entry)
      notes.push('mutation ' + file + ': not applied — ' + entry.unapplied_reason)
      continue
    }

    try {
      writeFileSync(absolute, original.split(find).join(replace))
    } catch (err) {
      entry.unapplied_reason = 'the file could not be written: ' + err.message
      entries.push(entry)
      notes.push('mutation ' + file + ': not applied — ' + entry.unapplied_reason)
      continue
    }

    entry.applied = true
    for (const test of expect) {
      const run = shell(worktree, singleTestCommand(template, test))
      // Unobserved and failed are different answers here too. A test that could not be LAUNCHED
      // under the mutation says nothing about whether the net bites.
      if (!run.ran || run.status === 127) {
        notes.push('mutation ' + file + ': ' + test + ' could not be RUN under the mutation')
        continue
      }
      if (run.status !== 0) entry.observed_failing.push(test)
    }

    // Restore before judging: the verdict is computed from the entry afterwards, and a throw
    // between the write and the checkout would leave the break in the tree.
    const back = git(worktree, ['checkout', '--', file])
    const dirty = git(worktree, ['status', '--porcelain', '--', file]).stdout.trim() !== ''
    if (!back.ok || dirty) {
      return {
        entries,
        notes,
        error: {
          kind: 'tree_not_restored',
          message: 'the mutation of ' + file + ' could not be reverted' +
            (back.ok ? '' : ': ' + (back.stderr.trim() || 'git checkout -- <file> failed')) +
            ' — a deliberate break left in the tree sends the next fix round after a defect ' +
            'nobody wrote',
        },
      }
    }

    entry.bites = expect.every((test) => entry.observed_failing.includes(test))
    entries.push(entry)
    notes.push('mutation ' + file + ': applied, ' + entry.observed_failing.length + ' of ' +
      expect.length + ' expected test(s) failed under it' + (entry.bites ? '' : ' — the net does NOT bite'))
  }

  return { entries, notes, error: null }
}


// ---------------------------------------------------------------- named checks
//
// A leaf's acceptance criteria name the commands that show it works — `node tools/lint.mjs`,
// `npm run e2e -- login` — and leaf-close hands them here. Each is run once, in the worktree,
// and recorded as it came back. Three outcomes and not two: a command the shell could not start,
// or that exited 127 (the shell's own "no such command"), was never OBSERVED passing or failing,
// and folding it into `failed` would send a fix round after a defect in code that is really a
// defect in the criterion. The verdict fails the leaf either way; the difference is who fixes it.

function runChecks(worktree, commands) {
  const entries = []
  const notes = []

  for (const command of commands) {
    const run = shell(worktree, command)
    const status = !run.ran || run.status === 127 ? 'unrunnable' : run.status === 0 ? 'passed' : 'failed'
    entries.push({ command, status })
    notes.push('check ' + JSON.stringify(command) + ': ' + status +
      (run.ran ? ' (exit ' + run.status + ')' : ' (' + run.message + ')'))
    if (status !== 'passed' && run.output) notes.push('check output tail:\n' + tailOf(run.output))
  }

  return { entries, notes }
}

// ---------------------------------------------------------------- which checks run

/** The rigors and roles this file knows. Anything else measures as `tdd`, and says so. */
export const RIGORS = ['verify', 'trivial', 'tests-only', 'tdd', 'tdd-pair', 'tdd-triad']

/**
 * Pure. Which checks one invocation runs, from its mode, rigor and role.
 *
 * A role outranks its rigor: a `tdd-pair` leaf is a red or a green, never a plain `tdd`, and the
 * rigor alone cannot say which. Integration mode outranks both — the merged head has no single
 * declared locus and no one change under test, so the series, the discriminator and the
 * mutations are not asked there, and their emptiness is designed rather than observed.
 *
 * @returns {{profile: string, series: boolean, emptySeriesExpected: boolean,
 *   discriminator: boolean, mutations: boolean, checks: boolean}}
 */
export function checksFor({ mode = 'order', rigor = '', role = 'none' } = {}) {
  const make = (profile, series, discriminator, mutations, checks, emptySeriesExpected = false) =>
    ({ profile, series, emptySeriesExpected, discriminator, mutations, checks })

  if (mode === 'integration') return make('integration', false, false, false, true)
  if (role === 'red') return make('red', true, true, false, false)
  if (role === 'green') return make('green', true, true, false, false)
  // An auditor edits nothing: its product is its declared mutations. An audit branch with no
  // commits on it is the expected shape, so `empty-series` is not a finding here — while any
  // commit that does land is still held to the locus like every other.
  if (role === 'audit') return make('audit', true, false, true, false, true)
  if (rigor === 'verify') return make('verify', false, false, false, true)
  if (rigor === 'trivial') return make('trivial', true, false, false, true)
  if (rigor === 'tests-only') return make('tests-only', true, true, true, true)
  return make('tdd', true, true, true, true)
}

// ---------------------------------------------------------------- the whole measurement

/** The default payload: every field present, nothing observed yet. */
const blank = () => ({
  stop_reason: 'completed',
  build: 'absent',
  typecheck: 'absent',
  suite: 'absent',
  suite_output_tail: '',
  failing_tests: [],
  baseline_failing: [],
  discriminator: [],
  mutations: [],
  series_findings: [],
  checks: [],
  notes: '',
  error: null,
  journal: null,
})

/**
 * Everything that runs tests: the suite, the discriminator, the mutations and the named checks.
 * Fills `payload`, `notes` and `errors` in place, as `measure` does.
 */
function measureTests(options, plan, payload, notes, errors) {
  const suite = runNamedCommand(options.worktree, options.suite, options.suiteAbsent, 'suite')
  payload.suite = suite.outcome
  // Carried only when it has a reader. The tail is the evidence a fix-round failure is built
  // from, and the verdict reaches for it on `suite === 'failed'` and nowhere else — so a passing
  // suite's tail is the largest field in the payload and nothing downstream ever opens it. It is
  // the courier who pays for that: every byte here is retyped by a model on the way back. The
  // field stays present and typed either way, and '' is honest: not "the suite printed
  // nothing", but "nothing here asked what it printed".
  payload.suite_output_tail = suite.outcome === 'failed' ? tailOf(suite.output) : ''
  notes.push(suite.note)
  if (suite.error) errors.push(suite.error)

  if (payload.suite === 'failed') {
    const found = extractFailures(suite.output, options.worktree)
    payload.failing_tests = found.failures
    notes.push('failing tests: ' + found.failures.length + ' placed from ' + found.markers +
      ' failure marker(s)')

    if (options.base && options.testOne && found.failures.length > 0) {
      const head = options.head || git(options.worktree, ['rev-parse', 'HEAD']).stdout.trim()
      const before = baselineOf(options.worktree, options.base, head, found.failures, options.tests, options.testOne)
      payload.baseline_failing = before.failing
      notes.push(...before.notes)
      if (before.error) errors.push(before.error)
    }

    if (found.failures.length === 0 || found.unplaced > 0) {
      errors.push({
        kind: 'suite_failures_unnamed',
        message: 'the suite failed and ' +
          (found.failures.length === 0
            ? 'no failure could be attributed to a test file'
            : found.unplaced + ' failure(s) could not be attributed to a test file') +
          '. A failure with no usable path cannot be placed against a declared locus, and a ' +
          'suite that failed while naming nothing is treated as failing everywhere — so this ' +
          'is read by a model rather than guessed at.',
      })
    }
  }

  if (plan.discriminator) {
    const tests = testsUnderMeasurement(options, plan, notes, errors)
    if (tests === null) {
      // The error is already recorded; the diff could not be read.
    } else if (tests.length === 0) {
      notes.push('discriminator empty: ' + (plan.profile === 'green'
        ? 'no test of the cycle was named or changed, so none of the red tests was measured'
        : 'this leaf added no test this pattern recognises') +
        ', which is a fact about the diff and not a check that passed')
    } else if (!options.testOne) {
      errors.push({
        kind: 'command_unknown',
        message: 'this leaf has ' + tests.length + ' test file(s) under measurement and no ' +
          'single-test command template was named, so the discriminator could not ask its question',
      })
    } else {
      const run = discriminate(options.worktree, options.base, options.head, tests, options.testOne)
      payload.discriminator = run.entries
      notes.push(...run.notes)
      if (run.error) errors.push(run.error)
    }
  }

  // After the discriminator, which has restored the tree by now, so this starts from HEAD as it
  // found it. A leaf with no declared mutation records an empty list and asks nothing.
  if (plan.mutations && options.mutations.length > 0) {
    const run = mutateAndRun(options.worktree, options.mutations, options.testOne)
    payload.mutations = run.entries
    notes.push(...run.notes)
    if (run.error) errors.push(run.error)
  } else if (!plan.mutations && options.mutations.length > 0) {
    notes.push(options.mutations.length + ' mutation spec(s) given and not run: a ' +
      plan.profile + ' leaf is not measured by mutation')
  }

  if (plan.checks && options.checks.length > 0) {
    const run = runChecks(options.worktree, options.checks)
    payload.checks = run.entries
    notes.push(...run.notes)
  } else if (!plan.checks && options.checks.length > 0) {
    notes.push(options.checks.length + ' named check(s) given and not run: a ' + plan.profile +
      ' leaf is measured by its tests, not by named checks')
  }
}

/**
 * Run every check the options select and return the payload. Nothing is journalled here; see
 * `verify`.
 */
function measure(options) {
  const payload = blank()
  const notes = []
  const errors = []
  const worktree = posix(options.worktree || '')

  const broken = worktreeProblem(options.worktree)
  if (broken) {
    payload.stop_reason = 'environment_broken'
    payload.error = broken
    payload.notes = broken.message
    return payload
  }

  const plan = checksFor(options)
  const integration = plan.profile === 'integration'
  notes.push((integration ? 'integration head' : 'leaf series') + ' in ' + worktree)
  if (!integration) {
    notes.push('checks for ' + plan.profile + ': ' +
      ['series', 'discriminator', 'mutations', 'checks'].filter((k) => plan[k]).join(', '))
    if (options.rigor && !RIGORS.includes(options.rigor)) {
      notes.push('rigor ' + JSON.stringify(options.rigor) + ' is not one this program knows; measured as tdd')
    }
  }

  if (plan.series) {
    const series = seriesOf(options.worktree, options.base, options.locus)
    payload.series_findings = plan.emptySeriesExpected
      ? series.findings.filter((f) => f.check !== 'empty-series')
      : series.findings
    if (series.error) errors.push(series.error)
    else {
      notes.push('series: ' + payload.series_findings.length + ' finding(s) over ' + options.base +
        '..HEAD against ' + options.locus.length + ' declared locus path(s)')
    }
  } else if (integration) {
    // Honest emptiness. There is no single declared locus at the merged head and no one change
    // under test, so neither check is asked for — and the caller knows it did not ask.
    notes.push('series check and discriminator not run: this is the merged head, which has no ' +
      'single declared locus and no one change under test')
  } else {
    notes.push('series check not run: a ' + plan.profile + ' leaf writes nothing to check')
  }

  const build = runNamedCommand(options.worktree, options.build, options.buildAbsent, 'build')
  payload.build = build.outcome
  notes.push(build.note)
  if (build.error) errors.push(build.error)
  // A failed build's own output. A fix round's evidence is `notes`, and "exit 1" alone sends an
  // implementer to look for a defect it has not been shown.
  if (build.outcome === 'failed') notes.push('build output tail:\n' + tailOf(build.output))

  // A third outcome, because a passing suite is not evidence that the tree compiles. Vitest and
  // Jest transform TypeScript with esbuild, which strips types without checking them, so a
  // missing key in a typed record is invisible to the suite and fatal to the build. In the field
  // a branch tip carried 826 passing tests over a tree `tsc --noEmit` rejected, and the suite
  // result was the only thing anybody had to go on. `absent` is the common and correct answer —
  // most repositories have no separate typecheck command — so this never manufactures a gate; it
  // refuses to let two different questions share one answer.
  const typecheck = runNamedCommand(
    options.worktree, options.typecheck, options.typecheckAbsent, 'typecheck')
  payload.typecheck = typecheck.outcome
  notes.push(typecheck.note)
  if (typecheck.error) errors.push(typecheck.error)
  if (typecheck.outcome === 'failed') {
    notes.push('typecheck output tail:\n' + tailOf(typecheck.output))
  }

  // One test run at a time in the project: suites that share the machine time out for it, and a
  // failure that is contention is nobody's to fix.
  const tests = () => measureTests(options, plan, payload, notes, errors)
  if (options.repo) withTestLock(options.repo, tests)
  else tests()

  if (errors.length > 0) {
    payload.stop_reason = 'environment_broken'
    // The kind is the FIRST problem in check order and the message names every one: a caller
    // routing on `kind` gets the earliest cause, which is the one the others usually follow from.
    payload.error = {
      kind: errors[0].kind,
      message: errors.map((e) => e.message).join(' — also: '),
    }
  }

  payload.notes = notes.join('; ')
  return payload
}

/**
 * The test files the discriminator measures, or null when the diff could not be read.
 *
 * Ordinarily the test files the leaf's own diff changed. A green leaf changes no test — its
 * red's tests are the yardstick and it may not touch them — so its discriminator runs over the
 * cycle's tests, which the caller names (`tests`): the red's test files, measured at the green's
 * base (the red's head, where they fail for want of an implementation) and now.
 */
function testsUnderMeasurement(options, plan, notes, errors) {
  if (options.tests.length > 0) {
    const named = options.tests.map(posix).filter((f) => existsSync(resolve(options.worktree, f)))
    notes.push('discriminator: ' + options.tests.length + ' test file(s) named by the caller, ' +
      named.length + ' present in the worktree')
    return named
  }

  const diff = git(options.worktree, ['diff', '--name-only', options.base + '..' + options.head])
  if (!diff.ok) {
    errors.push({
      kind: 'series_unreadable',
      message: 'git diff --name-only ' + options.base + '..' + options.head + ' did not run: ' +
        (diff.stderr.trim() || 'exit ' + diff.status),
    })
    return null
  }

  const changed = diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  const tests = changed.filter(isTestPath).filter((f) => existsSync(resolve(options.worktree, f)))
  notes.push('discriminator: ' + changed.length + ' changed file(s), ' + tests.length +
    ' matched the test-file pattern' + (plan.profile === 'green' ? ' (no cycle tests were named)' : ''))
  return tests
}

// ---------------------------------------------------------------- the journal
//
// Written HERE rather than typed into a second command by a dispatch, and that is the point of
// this script applied to its own record: this line carries three nested arrays, and asking an
// agent to copy them out of the payload into a shell heredoc is exactly the transcription hazard
// the script exists to remove. The durability rule is satisfied strictly — the line is written
// in the execution that made the observation, with no window at all between them.
//
// The line carries every field the verdict reads (lib/verdict.mjs `measurementOk`), because a
// resume re-derives a leaf's verdict from this line alone: `typecheck`, `mutations` and `checks`
// included. `seq` is not on it — the ledger mints it under the effort's lock, and a number chosen
// here would order two records confidently and wrongly.

/**
 * Pure. The `verify-observed` line for one measurement.
 * @param {{node: string, branch: string, worktree: string, base: string}} options
 * @param {object} payload what `verify` measured
 * @param {string} head the head actually observed
 */
export function journalLine(options, payload, head) {
  return {
    kind: 'verify-observed',
    node: options.node,
    branch: options.branch,
    worktree: posix(options.worktree),
    base_sha: options.base,
    head_sha: head,
    stop_reason: payload.stop_reason,
    build: payload.build,
    typecheck: payload.typecheck,
    suite: payload.suite,
    failing_tests: payload.failing_tests,
    baseline_failing: payload.baseline_failing,
    discriminator: payload.discriminator,
    mutations: payload.mutations,
    series_findings: payload.series_findings,
    checks: payload.checks,
  }
}

/** Whether an invocation carries everything a journal append needs. */
const journals = (options) => Boolean(options.repo && options.effort && options.execution && options.node)

/**
 * Run every check the options select, journal the observation when the options name where, and
 * return the payload the caller's verdict reads.
 *
 * `stop_reason` is `environment_broken` whenever `error` is non-null, and that pairing is load
 * bearing: a caller that never looks at `error` still fails safe, because the verdict reads
 * `stop_reason` and nothing green can be computed from a broken measurement.
 *
 * @param {object} options see parseArgs
 */
export function verify(given) {
  // Every option present, so a caller that names only what it has — a merge measuring its head —
  // cannot trip over an absent list.
  const options = { ...parseArgs([]), ...given }
  // The head under measurement is the worktree's own HEAD unless the caller pinned one.
  if (!options.head && options.worktree) options.head = git(options.worktree, ['rev-parse', 'HEAD']).stdout.trim()
  const opts = { ...parseArgs([]), ...options }
  const payload = measure(opts)

  if (journals(opts)) {
    // The observed head, not the expected one. A journal line is a record of what was seen — and
    // when the measurement broke, the tree may not be where it was found, so the expected head is
    // the only honest value left.
    const observed = !payload.error ? git(opts.worktree, ['rev-parse', 'HEAD']).stdout.trim() : ''
    const written = append(opts.repo, opts.effort, 'journal:' + opts.execution,
      journalLine(opts, payload, observed || opts.head))
    payload.journal = { written: written.ok === true, error: written.ok ? '' : String(written.error) }
  }

  return payload
}

// ---------------------------------------------------------------- the CLI

const decodeB64 = (token) => {
  try {
    return Buffer.from(String(token), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Pure. The options one invocation carries.
 *
 * Commands may arrive base64-encoded. They are free shell text minted by the caller — a build
 * command with a quote in it typed onto an agent's command line is the same hazard the ledger
 * solved that way, so the same transport is offered here. Named checks arrive ONLY that way:
 * they come from acceptance criteria, which are prose-adjacent and routinely carry quotes.
 */
export function parseArgs(argv) {
  const options = {
    worktree: '', mode: 'order', base: '', head: '', locus: [],
    rigor: '', role: 'none', tests: [], checks: [],
    build: '', typecheck: '', suite: '', testOne: '',
    buildAbsent: false, typecheckAbsent: false, suiteAbsent: false,
    mutations: [],
    repo: '', effort: '', execution: '', node: '', branch: '',
  }

  const value = (i) => (i + 1 < argv.length ? argv[i + 1] : '')

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--worktree': options.worktree = value(i); i++; break
      case '--mode': options.mode = value(i); i++; break
      case '--base': options.base = value(i); i++; break
      case '--head': options.head = value(i); i++; break
      case '--locus': options.locus.push(value(i)); i++; break
      case '--rigor': options.rigor = value(i); i++; break
      case '--role': options.role = value(i) || 'none'; i++; break
      case '--test-file': options.tests.push(value(i)); i++; break
      case '--check-b64': options.checks.push(decodeB64(value(i))); i++; break
      case '--build': options.build = value(i); i++; break
      case '--build-b64': options.build = decodeB64(value(i)); i++; break
      case '--typecheck': options.typecheck = value(i); i++; break
      case '--typecheck-b64': options.typecheck = decodeB64(value(i)); i++; break
      case '--suite': options.suite = value(i); i++; break
      case '--suite-b64': options.suite = decodeB64(value(i)); i++; break
      case '--test-one': options.testOne = value(i); i++; break
      case '--test-one-b64': options.testOne = decodeB64(value(i)); i++; break
      case '--build-absent': options.buildAbsent = true; break
      case '--typecheck-absent': options.typecheckAbsent = true; break
      case '--suite-absent': options.suiteAbsent = true; break
      // Base64 JSON on one argv slot, for the reason every other free text here travels that
      // way: a `find` string is arbitrary source text and will contain quotes, backslashes and
      // newlines. A malformed token is an empty list — the leaf then simply has no mutation to
      // run, which the verdict reads as "nothing was declared", never as "the net does not bite";
      // and for a rigor that requires one, "nothing was declared" fails the leaf on its own.
      case '--mutations-b64': {
        try {
          const parsed = JSON.parse(decodeB64(value(i)))
          options.mutations = Array.isArray(parsed) ? parsed : []
        } catch {
          options.mutations = []
        }
        i++
        break
      }
      case '--repo': options.repo = value(i); i++; break
      case '--effort': options.effort = value(i); i++; break
      case '--execution': options.execution = value(i); i++; break
      case '--node': options.node = value(i); i++; break
      case '--branch': options.branch = value(i); i++; break
      default: break
    }
  }

  return options
}

const isMain = import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)

if (isMain) {
  try {
    const payload = verify(parseArgs(process.argv.slice(2)))
    console.log(JSON.stringify(envelope(payload)))
    // Exit 0 whenever a digest-covered payload was printed. A typed error is a MEASUREMENT
    // OUTCOME, not a tool failure, and a non-zero exit there would have the dispatch report the
    // command as unrunnable — which is a different answer, about the machine rather than the run.
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}
