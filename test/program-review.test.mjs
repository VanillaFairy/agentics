// test/program-review.test.mjs — pins the review program, the inline task's one independent reader:
// a snapshot of the user's working tree taken without touching their tree, index or stash; the
// throwaway worktree the reviewer reads; the units (criteria and changed files) and the brief; the
// exit computed from the reviewer's rulings and the prior round's; relaunch and the run's scope.
// Also `git`'s environment, which the snapshot's temporary index needs.
//
// Design: docs/DESIGN.md#the-simple-task, docs/DESIGN.md#execution-modes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { readOnlyPermissions } from '../lib/locus.mjs'
import { programContext } from '../lib/programs/common.mjs'
import { review } from '../lib/programs/review.mjs'
import { loadRole, tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { git, posix, resultPath, runDir, sessionOf, writeJson } from '../lib/store.mjs'
import { programRig } from './harness/program-rig.mjs'

const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })

const GUIDE = 'GUIDE-7f3a: loaders never throw on a missing key'
const A_COMMITTED = 'export const a = 1\n'
const A_EDITED = 'export const a = 2 // edited in the working tree\n'
const X_COMMITTED = 'agentics notes, committed\n'
const CRITERIA_LINES = [
  '- [ ] the loader returns a plain object',
  '- keys are case-insensitive',
  '',
  'HUMAN: the page reads well',
  '- [ ] HUMAN: the message is kind',
  'unknown keys are an error',
]
const CRITERIA = CRITERIA_LINES.join('\n')
const CRITERION_TEXT = ['the loader returns a plain object', 'keys are case-insensitive', 'unknown keys are an error']
const HUMAN_TEXT = ['the page reads well', 'the message is kind']
const CHANGED = ['a.js', 'b.js', 'c.js', 'd.js']
const CRITERION_UNITS = CRITERION_TEXT.map((_, i) => 'criterion:' + (i + 1))
const FILE_UNITS = CHANGED.map((f) => 'file:' + f)
const UNITS = [...CRITERION_UNITS, ...FILE_UNITS]
const PRIOR = '20251231-000000-review'

const write = (root, path, text) => {
  const full = join(root, ...path.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text)
}

/**
 * The user's checkout: a base commit, a commit after it, a stash entry, an edit, a staged file, an
 * untracked file, an ignored file, an edited `.agentics/` file and a file under `.claude/`.
 */
function reviewRig(t, script = {}) {
  const rig = programRig({
    files: {
      'CLAUDE.md': '# Guidance\n\n' + GUIDE + '\n',
      'a.js': A_COMMITTED,
      'keep.js': 'export const keep = 1\n',
      '.gitignore': 'ignored.txt\n',
      '.agentics/x.md': X_COMMITTED,
    },
    script,
  })
  t.after(() => rig.cleanup())
  const base = sh(rig.repo, 'rev-parse', 'HEAD').trim()
  write(rig.repo, 'b.js', 'export const b = 1\n')
  sh(rig.repo, 'add', 'b.js')
  sh(rig.repo, 'commit', '-q', '-m', 'b')
  write(rig.repo, 'keep.js', 'export const keep = 2 // stashed\n')
  sh(rig.repo, 'stash', 'push', '-q')
  write(rig.repo, 'a.js', A_EDITED)
  write(rig.repo, 'd.js', 'export const d = 1\n')
  sh(rig.repo, 'add', 'd.js')
  write(rig.repo, 'c.js', 'export const c = 1\n')
  write(rig.repo, 'ignored.txt', 'ignored\n')
  write(rig.repo, '.agentics/x.md', 'agentics notes, edited\n')
  write(rig.repo, '.claude/worktrees/other/x.txt', 'another worktree\n')
  const dir = mkdtempSync(join(tmpdir(), 'agentics-review-criteria-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const criteriaFile = join(dir, 'criteria.md')
  writeFileSync(criteriaFile, CRITERIA + '\n')
  const args = (over = {}) => ({ base, criteria_file: criteriaFile, criteria: CRITERIA, prior: '', ...over })
  return { rig, base, args }
}

const ruled = (unit, ruling = 'clean', ids = []) => ({ unit, ruling, ids, why: 'looked at ' + unit })
const returnOf = ({ units = UNITS.map((u) => ruled(u)), findings = [], fix_rulings = [] } = {}) =>
  ({ units, findings, fix_rulings, claims: [], notes: '' })
const scriptOf = (output) => ({ 'reviewer||reviewer': [{ output }] })
const finding = (id, severity, claim = 'the loader drops a key (' + id + ')') =>
  ({ id, severity, claim, evidence: 'a.js:1', failure_scenario: 'load({A: 1}) returns {}' })

/** A context whose runner runs `during(call)` before the scripted reviewer answers. */
const watching = (rig, during) => programContext({
  ...rig.ctx,
  runAgent: async (call) => {
    await during(call)
    return rig.ctx.runAgent(call)
  },
})

const norm = (p) => {
  const out = posix(resolve(p))
  return process.platform === 'win32' ? out.toLowerCase() : out
}
const worktreeOf = (rig) => join(rig.repo, '.claude', 'worktrees', 'review-' + rig.run)
const listed = (repo, path) => sh(repo, 'worktree', 'list', '--porcelain').split('\n')
  .filter((l) => l.startsWith('worktree ')).some((l) => norm(l.slice('worktree '.length).trim()) === norm(path))
const filesAt = (repo, sha) => sh(repo, 'ls-tree', '-r', '--name-only', sha).split('\n').map((l) => l.trim()).filter(Boolean)
const show = (repo, sha, path) => sh(repo, 'show', sha + ':' + path)
const briefOf = (rig) => {
  assert.equal(rig.calls.length, 1)
  return rig.calls[0].brief
}
const linesNaming = (brief, unit) => brief.split('\n').filter((l) => l.includes(unit))

/** The user's state: the index file's bytes first, then a status that never refreshes the index, then the stash. */
const userState = (repo) => {
  const index = readFileSync(join(repo, '.git', 'index'))
  // The program's own run directory lives under .agentics/.state; it is the plugin's store, not the user's work.
  const status = sh(repo, '--no-optional-locks', 'status', '--porcelain').split('\n')
    .filter((l) => l.trim() && !l.includes('.agentics/.state')).join('\n')
  const stash = sh(repo, 'stash', 'list')
  return { index, status, stash }
}

// --- git with an environment -------------------------------------------------------------------

test('git takes an environment merged over the process environment', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-review-git-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  sh(repo, 'init', '-q', '.')
  process.env.GIT_AUTHOR_EMAIL = 'from-process@example.test'
  try {
    const withEnv = git(repo, ['var', '-l'], undefined, { env: { GIT_COMMITTER_EMAIL: 'from-env@example.test' } })
    assert.equal(withEnv.ok, true, withEnv.stderr)
    const idents = withEnv.stdout.split('\n')
    assert.ok(idents.some((l) => l.startsWith('GIT_AUTHOR_IDENT=') && l.includes('from-process@example.test')), withEnv.stdout)
    assert.ok(idents.some((l) => l.startsWith('GIT_COMMITTER_IDENT=') && l.includes('from-env@example.test')), withEnv.stdout)
    const without = git(repo, ['var', '-l'])
    assert.equal(without.ok, true, without.stderr)
    assert.ok(without.stdout.includes('from-process@example.test'))
    assert.ok(!without.stdout.includes('from-env@example.test'))
  } finally {
    delete process.env.GIT_AUTHOR_EMAIL
  }
})

// --- the snapshot ------------------------------------------------------------------------------

test("the snapshot commits the working tree on HEAD under the run's ref", async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  const out = await review(rig.ctx, args())
  const { ref, sha } = out.snapshot
  assert.equal(ref, 'refs/agentics/review/' + rig.run)
  assert.match(sha, /^[0-9a-f]{40}$/)
  assert.equal(sh(rig.repo, 'rev-parse', ref).trim(), sha)
  assert.equal(sh(rig.repo, 'rev-parse', sha + '^').trim(), sh(rig.repo, 'rev-parse', 'HEAD').trim())
  assert.equal(show(rig.repo, sha, 'a.js'), A_EDITED)
  assert.equal(show(rig.repo, sha, 'd.js'), readFileSync(join(rig.repo, 'd.js'), 'utf8'))
  assert.equal(show(rig.repo, sha, 'b.js'), readFileSync(join(rig.repo, 'b.js'), 'utf8'))
})

test('untracked files are in the snapshot, ignored files and .agentics are not', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  const { sha } = (await review(rig.ctx, args())).snapshot
  const files = filesAt(rig.repo, sha)
  assert.ok(files.includes('c.js'), files.join(', '))
  assert.equal(show(rig.repo, sha, 'c.js'), readFileSync(join(rig.repo, 'c.js'), 'utf8'))
  assert.ok(!files.includes('ignored.txt'), files.join(', '))
  assert.deepEqual(files.filter((f) => f.startsWith('.claude/')), [])
  assert.deepEqual(files.filter((f) => f.startsWith('.agentics/')), ['.agentics/x.md'])
  assert.equal(show(rig.repo, sha, '.agentics/x.md'), X_COMMITTED)
})

test("the user's tree, index and stash are untouched by a review", async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  const USER_EDIT = 'export const a = 3 // the user typed this while the review ran\n'
  const before = userState(rig.repo)
  let seen = null
  const ctx = watching(rig, (call) => {
    write(rig.repo, 'a.js', USER_EDIT)
    seen = readFileSync(join(call.cwd, 'a.js'), 'utf8')
  })
  const out = await review(ctx, args())
  const after = userState(rig.repo)
  assert.ok(before.index.equals(after.index), 'the index file changed')
  assert.equal(after.status, before.status)
  assert.equal(after.stash, before.stash)
  assert.equal(seen, A_EDITED)
  assert.equal(show(rig.repo, out.snapshot.sha, 'a.js'), A_EDITED)
  assert.equal(readFileSync(join(rig.repo, 'a.js'), 'utf8'), USER_EDIT)
})

test('a snapshot git cannot take throws, naming the git command', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  sh(rig.repo, 'symbolic-ref', 'HEAD', 'refs/heads/no-such-branch')
  await assert.rejects(review(rig.ctx, args()), (err) => /read-tree/.test(String(err && err.message)))
  assert.equal(rig.calls.length, 0)
  assert.equal(existsSync(worktreeOf(rig)), false)
  assert.equal(listed(rig.repo, worktreeOf(rig)), false)
})

// --- the worktree ------------------------------------------------------------------------------

test('the reviewer runs in a throwaway worktree at the snapshot, removed when the program ends', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  let cwd = ''
  let head = ''
  const out = await review(watching(rig, (call) => {
    cwd = call.cwd
    head = sh(call.cwd, 'rev-parse', 'HEAD').trim()
  }), args())
  assert.equal(norm(cwd), norm(worktreeOf(rig)))
  assert.equal(head, out.snapshot.sha)
  assert.equal(existsSync(worktreeOf(rig)), false)
  assert.equal(listed(rig.repo, worktreeOf(rig)), false)
})

test('a worktree a cut-off run left behind is removed and made again', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  const path = worktreeOf(rig)
  sh(rig.repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD')
  writeFileSync(join(path, 'leftover.txt'), 'from the run that was cut off\n')
  let sawLeftover = null
  let head = ''
  const out = await review(watching(rig, (call) => {
    sawLeftover = existsSync(join(call.cwd, 'leftover.txt'))
    head = sh(call.cwd, 'rev-parse', 'HEAD').trim()
  }), args())
  assert.equal(sawLeftover, false)
  assert.equal(head, out.snapshot.sha)
  assert.equal(existsSync(path), false)
  assert.equal(listed(rig.repo, path), false)
})

test('the worktree is removed after a failure', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  let cwd = ''
  const ctx = programContext({
    ...rig.ctx,
    runAgent: async (call) => {
      cwd = call.cwd
      throw new Error('the runner broke')
    },
  })
  await assert.rejects(review(ctx, args()))
  assert.notEqual(cwd, '')
  assert.equal(existsSync(worktreeOf(rig)), false)
  assert.equal(listed(rig.repo, worktreeOf(rig)), false)
})

// --- units and the brief -----------------------------------------------------------------------

test('each criterion line that is not HUMAN is a unit, numbered from 1', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf({ units: [] })))
  const out = await review(rig.ctx, args())
  const brief = briefOf(rig)
  CRITERION_TEXT.forEach((text, i) => {
    const unit = 'criterion:' + (i + 1)
    assert.ok(linesNaming(brief, unit).some((l) => l.includes(text)), unit + ' with ' + text)
    assert.ok(out.open.includes('unit:' + unit), unit)
  })
  assert.ok(!out.open.includes('unit:criterion:' + (CRITERION_TEXT.length + 1)))
  assert.ok(!brief.includes('criterion:' + (CRITERION_TEXT.length + 1)))
})

test('each file the change touches since the base is a unit', async (t) => {
  const { rig, base, args } = reviewRig(t, scriptOf(returnOf({ units: [] })))
  const out = await review(rig.ctx, args())
  const changed = sh(rig.repo, 'diff', '--name-only', base, out.snapshot.sha).split('\n').map((l) => l.trim()).filter(Boolean)
  assert.deepEqual([...changed].sort(), CHANGED)
  const brief = briefOf(rig)
  for (const path of changed) {
    assert.ok(brief.includes('file:' + path), path)
    assert.ok(out.open.includes('unit:file:' + path), path)
  }
  assert.deepEqual(out.open.filter((id) => id.startsWith('unit:file:')).sort(), changed.map((p) => 'unit:file:' + p).sort())
  assert.deepEqual([...out.open].sort(), UNITS.map((u) => 'unit:' + u).sort())
})

test('HUMAN criteria are in the brief and are no unit', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  const out = await review(rig.ctx, args())
  const brief = briefOf(rig)
  for (const text of HUMAN_TEXT) {
    assert.ok(brief.includes(text), text)
    for (const unit of UNITS) assert.ok(!linesNaming(brief, unit).some((l) => l.includes(text)), unit + ' / ' + text)
  }
  assert.equal(out.approved, true)
  assert.deepEqual(out.open, [])
})

test("the reviewer is dispatched at its role's tier with its read-only permissions", async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  await review(rig.ctx, args())
  assert.equal(rig.calls.length, 1)
  const [call] = rig.calls
  const role = loadRole('reviewer').role
  assert.equal(call.role.name, 'reviewer')
  assert.equal(call.thread.key, 'reviewer')
  assert.deepEqual(call.schema, schemaOf('reviewer'))
  assert.deepEqual(call.tier, tierFor(role))
  assert.deepEqual(call.permissions, readOnlyPermissions(role))
})

test("the reviewer's brief holds the units, the shas, the diff command and the guidance", async (t) => {
  const { rig, base, args } = reviewRig(t, scriptOf(returnOf()))
  const out = await review(rig.ctx, args())
  const brief = briefOf(rig)
  assert.ok(brief.includes('git diff ' + base + ' ' + out.snapshot.sha), 'the diff command')
  for (const unit of UNITS) assert.ok(brief.includes(unit), unit)
  assert.ok(brief.includes(GUIDE), 'the guidance')
})

test('a reviewer sharing the producing session is refused, and every unit stays open', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  const own = sessionOf({ effort: rig.ctx.effort, execution: rig.run, node: '', role: 'reviewer', thread: 'reviewer' })
  const out = await review(programContext({ ...rig.ctx, env: { CLAUDE_CODE_SESSION_ID: own } }), args())
  assert.equal(rig.calls.length, 0)
  assert.deepEqual(out.coverage.failed_channels, ['reviewer'])
  assert.equal(out.coverage.complete, false)
  assert.equal(out.approved, false)
  for (const unit of UNITS) assert.ok(out.open.includes('unit:' + unit), unit)
})

// --- the exit ----------------------------------------------------------------------------------

test('every unit ruled clean with no finding approves', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  const out = await review(rig.ctx, args())
  assert.equal(out.approved, true)
  assert.equal(out.next, 'approve')
  assert.deepEqual(out.open, [])
  assert.equal(out.coverage.complete, true)
  assert.deepEqual(out.coverage.resumable, rig.ctx.resumable)
})

test('an unruled unit is open', async (t) => {
  const left = 'file:c.js'
  const { rig, args } = reviewRig(t, scriptOf(returnOf({ units: UNITS.filter((u) => u !== left).map((u) => ruled(u)) })))
  const out = await review(rig.ctx, args())
  assert.deepEqual(out.open, ['unit:' + left])
  assert.equal(out.next, 'fix')
  assert.equal(out.approved, false)
  assert.deepEqual(out.coverage.incomplete, [left])
  assert.equal(out.coverage.complete, false)
})

test('a critical finding blocks; a major alone does not', async (t) => {
  const withFinding = (f) => returnOf({ units: UNITS.map((u) => (u === 'file:a.js' ? ruled(u, 'findings', [f.id]) : ruled(u))), findings: [f] })
  const critical = finding('F1', 'critical')
  const one = reviewRig(t, scriptOf(withFinding(critical)))
  const blocked = await review(one.rig.ctx, one.args())
  assert.deepEqual(blocked.open, [critical.id])
  assert.equal(blocked.next, 'fix')
  assert.equal(blocked.approved, false)
  const two = reviewRig(t, scriptOf(withFinding(finding('F2', 'major'))))
  const passed = await review(two.rig.ctx, two.args())
  assert.equal(passed.approved, true)
  assert.equal(passed.next, 'approve')
  assert.deepEqual(passed.open, [])
})

test("the result carries the review's rulings and the exit a later round reads", async (t) => {
  const critical = finding('F1', 'critical')
  const minor = finding('F3', 'minor')
  const returned = returnOf({
    units: UNITS.map((u) => (u === 'file:b.js' ? ruled(u, 'findings', [critical.id, minor.id]) : ruled(u))),
    findings: [critical, minor],
  })
  const { rig, base, args } = reviewRig(t, scriptOf(returned))
  const out = await review(rig.ctx, args())
  assert.equal(out.base, base)
  assert.deepEqual(out.units, returned.units)
  assert.deepEqual(out.findings, returned.findings)
  assert.deepEqual(out.fix_rulings, returned.fix_rulings)
  assert.equal(typeof out.reason, 'string')
  assert.deepEqual(out.exit.open, [critical])
  assert.ok(Array.isArray(out.exit.unfixed))
  assert.equal(typeof out.exit.clean_streak, 'number')
})

// --- prior rounds ------------------------------------------------------------------------------

const PRIOR_FINDING = finding('R7', 'critical', 'the loader keeps keys case-sensitive')
const priorRound = (repo, { unfixed = [] } = {}) =>
  writeJson(resultPath(repo, PRIOR), { exit: { open: [PRIOR_FINDING], unfixed, clean_streak: 0 } })

test('with a prior run, its open findings are in the brief to rule', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf({ fix_rulings: [{ id: PRIOR_FINDING.id, status: 'fixed', evidence: 'a.js:1' }] })))
  priorRound(rig.repo)
  await review(rig.ctx, args({ prior: PRIOR }))
  const brief = briefOf(rig)
  assert.ok(brief.includes(PRIOR_FINDING.id))
  assert.ok(brief.includes(PRIOR_FINDING.claim))
})

test('a prior blocker ruled fixed approves', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf({ fix_rulings: [{ id: PRIOR_FINDING.id, status: 'fixed', evidence: 'a.js:1' }] })))
  priorRound(rig.repo)
  const out = await review(rig.ctx, args({ prior: PRIOR }))
  assert.equal(out.approved, true)
  assert.equal(out.next, 'approve')
  assert.deepEqual(out.open, [])
})

test('a prior blocker the reviewer did not rule stays open', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  priorRound(rig.repo)
  const out = await review(rig.ctx, args({ prior: PRIOR }))
  assert.ok(out.open.includes(PRIOR_FINDING.id), out.open.join(', '))
  assert.ok(out.exit.unfixed.includes(PRIOR_FINDING.id))
  assert.equal(out.next, 'fix')
  assert.equal(out.approved, false)
})

test('the same finding unfixed in two rounds escalates', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf({
    units: UNITS.map((u) => (u === 'file:a.js' ? ruled(u, 'findings', [PRIOR_FINDING.id]) : ruled(u))),
    findings: [PRIOR_FINDING],
    fix_rulings: [{ id: PRIOR_FINDING.id, status: 'not_fixed', evidence: 'a.js:1' }],
  })))
  priorRound(rig.repo, { unfixed: [PRIOR_FINDING.id] })
  const out = await review(rig.ctx, args({ prior: PRIOR }))
  assert.equal(out.next, 'escalate')
  assert.equal(out.reason, 'review_not_converging')
  assert.equal(out.approved, false)
})

test('a prior run with no review exit is named in coverage', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  mkdirSync(runDir(rig.repo, PRIOR), { recursive: true })
  const out = await review(rig.ctx, args({ prior: PRIOR }))
  assert.ok(out.coverage.unreached.some((u) => String(u).includes(PRIOR)), JSON.stringify(out.coverage.unreached))
  assert.equal(out.coverage.complete, false)
  assert.equal(out.next, 'approve')
  assert.deepEqual(out.open, [])
})

// --- relaunch and scope ------------------------------------------------------------------------

test('a relaunch calls nothing that returned', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  const first = await review(rig.ctx, args())
  write(rig.repo, 'a.js', 'export const a = 4 // edited between the runs\n')
  const again = rig.relaunch({})
  const second = await review(again.ctx, args())
  assert.equal(again.calls.length, 0)
  assert.deepEqual(second, first)
  assert.equal(sh(rig.repo, 'rev-parse', first.snapshot.ref).trim(), first.snapshot.sha)
  assert.equal(existsSync(worktreeOf(rig)), false)
  assert.equal(listed(rig.repo, worktreeOf(rig)), false)
})

