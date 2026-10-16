// test/program-review-snapshot.test.mjs — pins the review program, the inline task's one
// independent reader: a snapshot of the user's working tree taken without touching their tree,
// index or stash; the throwaway worktree the reviewer reads; and the units (criteria and changed
// files) and the brief. Also `git`'s environment, which the snapshot's temporary index needs.
//
// The rig and the fixtures the parts share are in test/harness/review-world.mjs.
//
// Design: docs/DESIGN.md#the-simple-task, docs/DESIGN.md#execution-modes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOnlyPermissions } from '../lib/locus.mjs'
import { programContext } from '../lib/programs/common.mjs'
import { review } from '../lib/programs/review.mjs'
import { loadRole, tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { git, sessionOf } from '../lib/store.mjs'
import {
  sh, GUIDE, A_EDITED, X_COMMITTED, CRITERION_TEXT, CHANGED, UNITS, write, reviewRig, ruled, returnOf,
  scriptOf, norm, worktreeOf, listed, briefOf,
} from './harness/review-world.mjs'

const HUMAN_TEXT = ['the page reads well', 'the message is kind']

/** A context whose runner runs `during(call)` before the scripted reviewer answers. */
const watching = (rig, during) => programContext({ intelligence: 'normal',
  ...rig.ctx,
  runAgent: async (call) => {
    await during(call)
    return rig.ctx.runAgent(call)
  },
})

const filesAt = (repo, sha) => sh(repo, 'ls-tree', '-r', '--name-only', sha).split('\n').map((l) => l.trim()).filter(Boolean)
const show = (repo, sha, path) => sh(repo, 'show', sha + ':' + path)

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

test('a snapshot git cannot finish leaves no temporary index behind', async (t) => {
  const { rig, args } = reviewRig(t, scriptOf(returnOf()))
  // A ref below the run's own name makes `update-ref` of that name fail, after the index is written.
  sh(rig.repo, 'update-ref', 'refs/agentics/review/' + rig.ctx.run + '/blocker', 'HEAD')
  await assert.rejects(review(rig.ctx, args()), (err) => /update-ref/.test(String(err && err.message)))
  assert.equal(existsSync(join(rig.ctx.dir, 'review.index')), false)
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
  const ctx = programContext({ intelligence: 'normal',
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
  assert.deepEqual(call.tier, tierFor(role, { intelligence: 'normal' }))
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
  const out = await review(programContext({ intelligence: 'normal', ...rig.ctx, env: { CLAUDE_CODE_SESSION_ID: own } }), args())
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
