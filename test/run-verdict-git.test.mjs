// test/run-verdict-git.test.mjs — the half of the verdict that shells out, against real repos.
//
// Everything else in this plugin's test suite hands `gitFacts`'s OUTPUT to the arithmetic as a
// hand-built object, which means the mapping from what git actually prints to that object was
// unverified — and a defect sat in exactly that gap and passed a green suite: when the
// integration branch did not resolve, every order branch came back `commits: []`, which reads
// as `code`, which re-anchors the branch and loses a reviewed series to the reflog. The develop
// skill tells the session to delete the integration branch after the human accepts, so that is
// the ordinary state of a run somebody comes back to.
//
// These tests build small real repositories. They are slower than the rest of the suite and
// they are the only thing that can fail on this.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitFacts, rootFor, verdictFor } from '../lib/run-verdict.mjs'

const RUNSTAMP = '20260827-101500'
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

/** A repo with an integration branch and one order branch carrying `commits` commits. */
function repo({ commits = 2, integration = true, dirty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-git-')).split('\\').join('/')
  git(dir, 'init', '-q', '.')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  const baseSha = git(dir, 'rev-parse', 'HEAD')

  git(dir, 'branch', 'agentics/' + RUNSTAMP + '-integration')
  git(dir, 'checkout', '-q', '-b', 'agentics/' + RUNSTAMP + '-W1')
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(dir, 'w1-' + i + '.txt'), 'x\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'feat: w1 part ' + i)
  }
  git(dir, 'checkout', '-q', 'agentics/' + RUNSTAMP + '-integration')
  if (dirty) writeFileSync(join(dir, 'base.txt'), 'edited\n')
  if (!integration) git(dir, 'checkout', '-q', '--detach')
  if (!integration) git(dir, 'branch', '-D', 'agentics/' + RUNSTAMP + '-integration')

  return { dir, baseSha }
}

test('a branch with commits is read off real git, fork point and all', () => {
  const { dir } = repo({ commits: 2 })
  const facts = gitFacts(dir, RUNSTAMP, ['W1'], true)

  assert.equal(facts.clean, false)
  assert.equal(facts.branches.W1.branch, 'agentics/' + RUNSTAMP + '-W1')
  assert.equal(facts.branches.W1.commits.length, 2)
  assert.deepEqual(facts.branches.W1.commits.map((c) => c.subject),
    ['feat: w1 part 0', 'feat: w1 part 1'], 'oldest first, subjects intact')
  assert.match(facts.branches.W1.base_sha, /^[0-9a-f]{40}$/)
  assert.equal(facts.branches.W1.already_merged, false)
})

test('the commits survive the integration branch being deleted', () => {
  // The defect this exists for. `git merge-base <branch> <gone>` fails, so the fork point was
  // '' and the commit enumeration was skipped entirely — reporting "a branch with no commits
  // on it" about a branch with two.
  const { dir, baseSha } = repo({ commits: 2, integration: false })

  const blind = gitFacts(dir, RUNSTAMP, ['W1'], true)
  assert.equal(blind.branches.W1.commits.length, 0,
    'with nothing to measure against, git genuinely cannot enumerate them')

  const withBase = gitFacts(dir, RUNSTAMP, ['W1'], true, baseSha)
  assert.equal(withBase.branches.W1.commits.length, 2,
    'the plan records the sha the run was cut from; that is the fallback fork point')
  assert.equal(withBase.branches.W1.base_sha, baseSha)
})

// --- the checkpoint tip, read off a real commit ----------------------------------------------

test('an agentics-checkpoint trailer on the tip is read off real git', () => {
  // The trailer is the mark that survives a reworded subject, so it has to come from the
  // commit object rather than from anything a model typed. This is the only test that proves
  // the format string actually asks git for it.
  const { dir } = repo({ commits: 1 })
  git(dir, 'checkout', '-q', 'agentics/' + RUNSTAMP + '-W1')
  writeFileSync(join(dir, 'half.txt'), 'partial\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'feat: most of the thing', '-m', 'agentics-checkpoint: W1')
  git(dir, 'checkout', '-q', 'agentics/' + RUNSTAMP + '-integration')

  const facts = gitFacts(dir, RUNSTAMP, ['W1'], true)

  assert.equal(facts.branches.W1.checkpoint_head, true)
  assert.equal(facts.branches.W1.commits.length, 2, 'and the enumeration still works')
  assert.deepEqual(Object.keys(facts.branches.W1.commits[0]).sort(), ['sha', 'subject'],
    'the trailer itself does not ride the payload — one boolean does')
})

test('a checkpoint subject with no trailer is caught too', () => {
  const { dir } = repo({ commits: 1 })
  git(dir, 'checkout', '-q', 'agentics/' + RUNSTAMP + '-W1')
  writeFileSync(join(dir, 'half.txt'), 'partial\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'checkpoint: stopped mid-series')
  git(dir, 'checkout', '-q', 'agentics/' + RUNSTAMP + '-integration')

  assert.equal(gitFacts(dir, RUNSTAMP, ['W1'], true).branches.W1.checkpoint_head, true)
})

test('an ordinary series reports no checkpoint at its tip', () => {
  const { dir } = repo({ commits: 2 })

  assert.equal(gitFacts(dir, RUNSTAMP, ['W1'], true).branches.W1.checkpoint_head, false)
})

test('a checkpoint that is no longer the tip does not force a continuation', () => {
  // Dissolving one is the continuation coder's job and squashing is how it does it — but a
  // coder that instead landed real work on top has also moved past it. The tip is the
  // question; the history is not.
  const { dir } = repo({ commits: 1 })
  git(dir, 'checkout', '-q', 'agentics/' + RUNSTAMP + '-W1')
  writeFileSync(join(dir, 'half.txt'), 'partial\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'checkpoint: stopped mid-series')
  writeFileSync(join(dir, 'rest.txt'), 'finished\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'feat: the rest of it')
  git(dir, 'checkout', '-q', 'agentics/' + RUNSTAMP + '-integration')

  assert.equal(gitFacts(dir, RUNSTAMP, ['W1'], true).branches.W1.checkpoint_head, false)
})

test('an order branch that was never created is simply absent', () => {
  const { dir } = repo()
  const facts = gitFacts(dir, RUNSTAMP, ['W1', 'W2'], true)

  assert.ok(facts.branches.W1)
  assert.equal(facts.branches.W2, undefined, 'absence is the ordinary case, not an error')
})

test('a merged branch is reported as an ancestor, read from the exit status', () => {
  const { dir } = repo({ commits: 1 })
  git(dir, 'merge', '--no-ff', '-q', '-m', 'merge w1', 'agentics/' + RUNSTAMP + '-W1')

  const facts = gitFacts(dir, RUNSTAMP, ['W1'], true)
  assert.equal(facts.branches.W1.already_merged, true)
})

test('uncommitted changes in a worktree are reported as a fact', () => {
  const { dir } = repo({ commits: 1, dirty: true })
  const facts = gitFacts(dir, RUNSTAMP, ['W1'], true)

  // The order branch has no worktree of its own here, so the dirt is not attributed to it —
  // which is itself the right answer: dirt is reported per worktree, and it has none.
  assert.deepEqual(facts.branches.W1.dirty, [])
  assert.equal(facts.branches.W1.worktree, '')
})

test('a branch checked out in a worktree reports that worktree, and its dirt', () => {
  const { dir } = repo({ commits: 1 })
  const wt = dir + '/wt-w1'
  git(dir, 'worktree', 'add', '-q', wt, 'agentics/' + RUNSTAMP + '-W1')
  writeFileSync(join(wt, 'scratch.txt'), 'uncommitted\n')

  const facts = gitFacts(dir, RUNSTAMP, ['W1'], true)
  assert.equal(facts.branches.W1.worktree.split('\\').join('/'), wt)
  assert.ok(facts.branches.W1.dirty.some((l) => /scratch\.txt/.test(l)),
    'uncommitted work is named so a coder can rule on it, never adopted silently')
})

// --- the clean short-circuit, actually short-circuiting -------------------------------------

test('no records and no branches is clean, and asks git nothing further', () => {
  const { dir } = repo({ commits: 0 })
  git(dir, 'branch', '-D', 'agentics/' + RUNSTAMP + '-W1')

  const facts = gitFacts(dir, RUNSTAMP, ['W1'], false)
  assert.equal(facts.clean, true)
  assert.deepEqual(facts.branches, {})
  assert.equal(facts.integration_head, '', 'the head was never even asked for')
})

test('branches without records is NOT clean — a run can die before it writes anything', () => {
  // The longest unrecorded stretch there is: killed mid-wave-one, with commits on a branch and
  // an empty ledger. Reading that as clean would rebuild work that is sitting right there.
  const { dir } = repo({ commits: 1 })
  const facts = gitFacts(dir, RUNSTAMP, ['W1'], false)

  assert.equal(facts.clean, false)
  assert.equal(facts.branches.W1.commits.length, 1)
})

test('records without branches is NOT clean either', () => {
  const { dir } = repo({ commits: 0 })
  git(dir, 'branch', '-D', 'agentics/' + RUNSTAMP + '-W1')

  assert.equal(gitFacts(dir, RUNSTAMP, ['W1'], true).clean, false)
})

test('a runstamp nobody has planned asks git nothing at all', () => {
  assert.deepEqual(gitFacts('C:/no/such/repo', '', ['W1'], false),
    { clean: true, branches: {}, integration_branch: '', integration_head: '' })
})

test("another run's branches are never mistaken for this one's", () => {
  // The glob is the whole bound on what a resume looks at. A repository with several runs in it
  // must not have one run adopt another's work.
  const { dir } = repo({ commits: 1 })
  git(dir, 'branch', 'agentics/20260101-000000-W1', 'agentics/' + RUNSTAMP + '-W1')

  const facts = gitFacts(dir, '20260101-000000', ['W1'], true)
  assert.ok(facts.branches.W1, 'the other run does hold a branch of its own')

  const mine = gitFacts(dir, RUNSTAMP, ['W1'], true)
  assert.equal(mine.branches.W1.branch, 'agentics/' + RUNSTAMP + '-W1')
})

// --- the repository root, worked out rather than supplied ------------------------------------

test('the root comes from the plan first, the layout second, the hint last', () => {
  const runDir = 'C:/work/thing/.claude/agentics/runs/' + RUNSTAMP

  assert.equal(rootFor({ roots: 'C:/recorded' }, runDir, 'C:/hint'), 'C:/recorded')
  assert.equal(rootFor({ roots: 'C:/one, C:/two' }, runDir, ''), 'C:/one',
    'a multi-root run is git-rooted at its first')
  assert.equal(rootFor({}, runDir, 'C:/hint'), 'C:/work/thing',
    'the layout gives the root away: a run directory is <root>/.claude/agentics/runs/<stamp>')
  assert.equal(rootFor({}, 'C:/odd/place', 'C:/hint'), 'C:/hint',
    'and only somewhere unusual does the caller get a say')
})

test('verdictFor reads the repository the PLAN names, not the one it was handed', () => {
  const { dir } = repo({ commits: 2 })
  const runDir = dir + '/.claude/agentics/runs/' + RUNSTAMP
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify({
    change: 'c', roots: dir, base_branch: 'master', base_sha: '',
    partition_raw: JSON.stringify({ waves: [['W1']], coupled: [] }),
    work_orders: [{ id: 'W1', title: 't', role: 'none', locus: ['a'], reads: [],
                    acceptance: ['x'], context: 'c', deps: [], contract: false }],
  }))

  // The hint is deliberately wrong, the way the caller's cwd was.
  const { payload } = verdictFor('C:/somewhere/else', runDir)

  assert.equal(payload.root.split('\\').join('/'), dir)
  assert.equal(payload.orders[0].next_action, 'verify',
    'the branch was found, so its two commits are measured rather than rebuilt')
})

test('an unreadable plan still comes back as a digest-covered envelope', () => {
  // It used to come back unwrapped, so the caller rejected it as a TRANSPORT failure, bought a
  // retry that could never succeed, and reported the courier as broken while the real reason
  // ("plan.json could not be read") sat in notes and reached nobody.
  const { dir } = repo({ commits: 0 })
  const runDir = dir + '/.claude/agentics/runs/' + RUNSTAMP
  mkdirSync(runDir, { recursive: true })

  const out = verdictFor(dir, runDir)

  assert.ok(out.payload, 'wrapped like every other answer')
  assert.match(out.payload_digest, /^[0-9a-f]{8}$/)
  assert.equal(out.payload.stop_reason, 'unreadable')
  assert.ok(out.payload.notes.some((n) => /plan\.json could not be read/.test(n)),
    'and the reader\'s own words survive the trip')
})
