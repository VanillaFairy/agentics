// test/resume.test.mjs — lib/resume.mjs, against real git repositories and a real ledger.
//
// Every rung of the ladder is exercised the way a dead invocation leaves it: branches cut where
// leaf-open cuts them, commits made in the worktrees leaf-open makes, events and journal lines
// appended through lib/ledger.mjs. A mock of git would test the ladder against the author's
// idea of git, which is the one thing a resume cannot afford to be wrong about.
//
// The properties worth pinning, in the order they matter:
//   a clean execution runs exactly one git command;
//   a stage is adopted only where the record and git agree on the head;
//   ancestry alone never marks a leaf merged — a witness must agree;
//   a checkpoint tip is continued, never measured;
//   a cycle member's commits are its own, not its predecessor's.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { ACTIONS, gitFacts, nextActionFor, resumeLeaves } from '../lib/resume.mjs'
import { append } from '../lib/ledger.mjs'
import { branchOf, git as runGit, worktreeOf } from '../lib/store.mjs'
import { normalizeNode } from '../lib/tree.mjs'

const EFFORT = 'e1'
const EXECUTION = '20260925-120000'

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr)
  return r.stdout.trim()
}

/** A repository with main and the effort's integration branch, both at one commit. */
function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-resume-')).split('\\').join('/')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-q', '-b', 'main', '.')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'README.md'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  git(dir, 'branch', branchOf(EFFORT, '.'))
  return dir
}

const leaf = (id, over = {}) => normalizeNode({ id, kind: 'leaf', rigor: 'tdd', locus: ['src/' + id + '.mjs'], ...over })

/** Cut a leaf's branch and worktree where leaf-open does: from `from` (the parent's head by default). */
function open(dir, id, from = branchOf(EFFORT, '.')) {
  const wt = worktreeOf(dir, EFFORT, id)
  mkdirSync(join(dir, '.claude', 'worktrees'), { recursive: true })
  git(dir, 'worktree', 'add', '-q', '-b', branchOf(EFFORT, id), wt, from)
  return wt
}

/** One commit in a worktree; returns its sha. */
function commit(wt, file, subject, body = '') {
  mkdirSync(dirname(join(wt, file)), { recursive: true })
  writeFileSync(join(wt, file), subject + '\n')
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', subject + (body ? '\n\n' + body : ''))
  return git(wt, 'rev-parse', 'HEAD')
}

const event = (dir, entry) => assert.equal(append(dir, EFFORT, 'events', { execution: EXECUTION, ...entry }).ok, true)
const journal = (dir, entry) => assert.equal(append(dir, EFFORT, 'journal:' + EXECUTION, entry).ok, true)

const greenLine = (id, head) => ({
  kind: 'verify-observed', node: id, branch: branchOf(EFFORT, id), worktree: '', base_sha: '', head_sha: head,
  stop_reason: 'completed', build: 'passed', typecheck: 'absent', suite: 'passed', failing_tests: [],
  discriminator: [{ test_id: 'test/x.test.mjs', failed_on_base: true, passes_now: true }],
  mutations: [], series_findings: [], checks: [],
})

const rowOf = (rows, id) => rows.find((r) => r.id === id)

/** A git runner that counts what it is asked. */
const counting = () => {
  const calls = []
  const run = (cwd, args) => {
    calls.push(args.join(' '))
    return runGit(cwd, args)
  }
  return { calls, run }
}

// ---------------------------------------------------------------- the clean regime

test('a clean execution opens for one branch listing, and every leaf is code', (t) => {
  const dir = repository(t)
  const nodes = [normalizeNode({ id: '.', kind: 'composite' }), leaf('a'), leaf('b', { rigor: 'trivial' })]
  // Planned events exist for every leaf from the moment it is added; they are not salvage.
  event(dir, { kind: 'planned', node: 'a', by: 'planner' })
  event(dir, { kind: 'planned', node: 'b', by: 'planner' })

  const { calls, run } = counting()
  const rows = resumeLeaves(dir, EFFORT, EXECUTION, nodes, {}, { run })

  assert.deepEqual(calls, ['branch --list agentics/e1--* --format=%(refname:short)'],
    'exactly one git command: the listing bounds everything a dead invocation could have left')
  assert.deepEqual(rows.map((r) => [r.id, r.next_action]), [['a', 'code'], ['b', 'code']])
  assert.deepEqual(rowOf(rows, 'a'), {
    id: 'a', next_action: 'code', note: 'nothing in git for this leaf', branch: 'agentics/e1--a',
    worktree: worktreeOf(dir, EFFORT, 'a'), head_sha: '', base_sha: '', approved_head: '', commits: [], dirty: [],
  })
})

test('a leaf recorded merged is none even with nothing left in git', (t) => {
  const dir = repository(t)
  event(dir, { kind: 'merged', node: 'a', into: '.', merged_sha: 'x', head_sha: 'y' })
  const { calls, run } = counting()
  const rows = resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a')], {}, { run })
  assert.equal(rowOf(rows, 'a').next_action, 'none')
  assert.equal(calls.length, 1)
})

test('gitFacts reports clean when no leaf branch exists, and names what it asked', (t) => {
  const dir = repository(t)
  const facts = gitFacts(dir, EFFORT, ['a', 'b'])
  assert.deepEqual(facts, { clean: true, calls: 1, branches: {} })
})

// ---------------------------------------------------------------- the dirty regime

test('commits with no series-done are continued; a series-done at the tip is verified', (t) => {
  const dir = repository(t)
  const wa = open(dir, 'a')
  commit(wa, 'src/a.mjs', 'feat(a): first half')
  const wb = open(dir, 'b')
  const bHead = commit(wb, 'src/b.mjs', 'feat(b): the whole of it')
  journal(dir, { kind: 'series-done', node: 'b', branch: branchOf(EFFORT, 'b'), head_sha: bHead, commits: [] })

  const rows = resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a'), leaf('b')])

  assert.equal(rowOf(rows, 'a').next_action, 'continue-series')
  assert.equal(rowOf(rows, 'b').next_action, 'verify')
  assert.equal(rowOf(rows, 'b').head_sha, bHead)
  assert.deepEqual(rowOf(rows, 'b').commits, [{ sha: bHead, subject: 'feat(b): the whole of it' }])
})

test('a series-done recorded at an older head does not vouch for the commits after it', (t) => {
  const dir = repository(t)
  const wa = open(dir, 'a')
  const first = commit(wa, 'src/a.mjs', 'feat(a): one')
  journal(dir, { kind: 'series-done', node: 'a', head_sha: first, commits: [] })
  commit(wa, 'src/a2.mjs', 'feat(a): two')

  assert.equal(rowOf(resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a')]), 'a').next_action, 'continue-series')
})

test('a checkpoint tip is continued, never measured — even beside a series-done for it', (t) => {
  const dir = repository(t)
  const wa = open(dir, 'a')
  const head = commit(wa, 'src/a.mjs', 'feat(a): halfway', 'agentics-checkpoint: ran long')
  journal(dir, { kind: 'series-done', node: 'a', head_sha: head, commits: [] })
  const wb = open(dir, 'b')
  commit(wb, 'src/b.mjs', 'checkpoint: stopping here')

  const rows = resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a'), leaf('b')])
  assert.equal(rowOf(rows, 'a').next_action, 'continue-series', 'the trailer is the load-bearing mark')
  assert.equal(rowOf(rows, 'b').next_action, 'continue-series', 'the subject is the readable one')
  assert.match(rowOf(rows, 'a').note, /checkpoint/)
})

test('a branch with no commits is code', (t) => {
  const dir = repository(t)
  open(dir, 'a')
  const row = rowOf(resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a')]), 'a')
  assert.equal(row.next_action, 'code')
  assert.equal(row.note, 'a branch with no commits on it')
})

test('approved and still at the approved head: merge', (t) => {
  const dir = repository(t)
  const wa = open(dir, 'a')
  const head = commit(wa, 'src/a.mjs', 'feat(a): done')
  event(dir, { kind: 'dispatched', node: 'a', role: 'implementer', round: 1 })
  event(dir, { kind: 'approved', node: 'a', head_sha: head, review_rounds: 1, at_integration: false })

  assert.equal(rowOf(resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a')]), 'a').next_action, 'merge')
})

test('an approval the branch has since moved past is not adopted', (t) => {
  const dir = repository(t)
  const wa = open(dir, 'a')
  const approvedHead = commit(wa, 'src/a.mjs', 'feat(a): done')
  event(dir, { kind: 'approved', node: 'a', head_sha: approvedHead })
  commit(wa, 'src/a2.mjs', 'feat(a): and then more')

  assert.equal(rowOf(resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a')]), 'a').next_action, 'continue-series')
})

test('an approval followed by a fresh dispatch or a replan no longer stands', (t) => {
  const dir = repository(t)
  const wa = open(dir, 'a')
  const ha = commit(wa, 'src/a.mjs', 'feat(a): done')
  event(dir, { kind: 'approved', node: 'a', head_sha: ha })
  event(dir, { kind: 'dispatched', node: 'a', role: 'implementer', round: 2 })
  const wb = open(dir, 'b')
  const hb = commit(wb, 'src/b.mjs', 'feat(b): done')
  event(dir, { kind: 'approved', node: 'b', head_sha: hb })
  event(dir, { kind: 'replanned', node: 'b', reason: 'retry_escalated', by: 'session' })

  const rows = resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a'), leaf('b')])
  assert.equal(rowOf(rows, 'a').next_action, 'continue-series')
  assert.equal(rowOf(rows, 'b').next_action, 'continue-series')
})

test('a green measurement at the branch head: review where the leaf reviews itself, merge otherwise', (t) => {
  const dir = repository(t)
  const wa = open(dir, 'a')
  const ha = commit(wa, 'src/a.mjs', 'feat(a): done')
  journal(dir, greenLine('a', ha))
  const wp = open(dir, 'p')
  const hp = commit(wp, 'src/p.mjs', 'feat(p): the api')
  journal(dir, greenLine('p', hp))

  const nodes = [leaf('a'), leaf('p', { provides: [{ name: 'api', paths: ['src/p.mjs'] }] })]
  const rows = resumeLeaves(dir, EFFORT, EXECUTION, nodes)
  assert.equal(rowOf(rows, 'a').next_action, 'merge', 'a tdd leaf is reviewed at integration')
  assert.equal(rowOf(rows, 'p').next_action, 'review', 'a contract provider reviews on its own')
})

test('the last measurement at a head wins: a later red one is not shadowed by an earlier green', (t) => {
  const dir = repository(t)
  const wa = open(dir, 'a')
  const ha = commit(wa, 'src/a.mjs', 'feat(a): done')
  journal(dir, { kind: 'series-done', node: 'a', head_sha: ha, commits: [] })
  journal(dir, greenLine('a', ha))
  journal(dir, { ...greenLine('a', ha), build: 'failed' })

  assert.equal(rowOf(resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a')]), 'a').next_action, 'verify')
})

test('a green measurement is judged against the leaf\'s rigor, not trusted as a label', (t) => {
  // A tests-only leaf needs a mutation that bites. The line records none, so it is not green.
  const dir = repository(t)
  const wa = open(dir, 'a')
  const ha = commit(wa, 'test/a.test.mjs', 'test(a): pin it')
  journal(dir, greenLine('a', ha))

  const row = rowOf(resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a', { rigor: 'tests-only', locus: ['test/a.test.mjs'] })]), 'a')
  assert.equal(row.next_action, 'continue-series')
})

test('a measurement at an older head is not adopted', (t) => {
  const dir = repository(t)
  const wa = open(dir, 'a')
  const old = commit(wa, 'src/a.mjs', 'feat(a): done')
  journal(dir, greenLine('a', old))
  const head = commit(wa, 'src/a2.mjs', 'fix(a): a fix round')
  journal(dir, { kind: 'series-done', node: 'a', head_sha: head, commits: [] })

  assert.equal(rowOf(resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a')]), 'a').next_action, 'verify')
})

// ---------------------------------------------------------------- merged

test('in the parent\'s integration head with a witness: none; ancestry alone never is', (t) => {
  const dir = repository(t)
  const parent = branchOf(EFFORT, '.')

  // a: implemented, approved, merged — and the merge was never recorded.
  const wa = open(dir, 'a')
  const ha = commit(wa, 'src/a.mjs', 'feat(a): done')
  event(dir, { kind: 'approved', node: 'a', head_sha: ha })
  // c: merged, witnessed only by the merge-observed line merge-batch writes inside the merge.
  const wc = open(dir, 'c')
  const hc = commit(wc, 'src/c.mjs', 'feat(c): done')
  journal(dir, { kind: 'merge-observed', node: 'c', branch: branchOf(EFFORT, 'c'), head_sha: hc, merged_sha: '', into: '.' })
  // b: cut and never committed to — an ancestor of the parent head by construction.
  open(dir, 'b')

  const pw = worktreeOf(dir, EFFORT, '.')
  git(dir, 'worktree', 'add', '-q', pw, parent)
  git(pw, 'merge', '-q', '--no-ff', '-m', 'merge a', branchOf(EFFORT, 'a'))
  git(pw, 'merge', '-q', '--no-ff', '-m', 'merge c', branchOf(EFFORT, 'c'))

  const rows = resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a'), leaf('b'), leaf('c')])
  assert.equal(rowOf(rows, 'a').next_action, 'none')
  assert.match(rowOf(rows, 'a').note, /never recorded/)
  assert.equal(rowOf(rows, 'c').next_action, 'none')
  assert.equal(rowOf(rows, 'b').next_action, 'code',
    'a branch whose executor died before its first commit is an ancestor too, and nobody implemented it')
})

test('the parent head can be handed in rather than resolved', (t) => {
  const dir = repository(t)
  const wa = open(dir, 'a')
  const ha = commit(wa, 'src/a.mjs', 'feat(a): done')
  event(dir, { kind: 'approved', node: 'a', head_sha: ha })

  // Handed the leaf's own head as its parent's: the leaf is then contained in it.
  const rows = resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a')], { '.': ha })
  assert.equal(rowOf(rows, 'a').next_action, 'none')
})

// ---------------------------------------------------------------- verify rigor

test('a verify leaf is verify until recorded merged, whatever else is on disk', (t) => {
  const dir = repository(t)
  open(dir, 'v')
  journal(dir, greenLine('v', 'whatever'))
  const nodes = [leaf('v', { rigor: 'verify', locus: [] }), leaf('w', { rigor: 'verify', locus: [] })]
  event(dir, { kind: 'merged', node: 'w', into: '.', merged_sha: '', head_sha: '' })

  const rows = resumeLeaves(dir, EFFORT, EXECUTION, nodes)
  assert.equal(rowOf(rows, 'v').next_action, 'verify')
  assert.equal(rowOf(rows, 'w').next_action, 'none')
})

// ---------------------------------------------------------------- cycles and worktrees

test('a green cut from its red\'s branch is measured from the red\'s head, not the parent\'s', (t) => {
  const dir = repository(t)
  const wr = open(dir, 'r')
  const hr = commit(wr, 'test/r.test.mjs', 'test(r): pin the rule')
  journal(dir, { kind: 'series-done', node: 'r', head_sha: hr, commits: [] })
  open(dir, 'g', branchOf(EFFORT, 'r'))

  const nodes = [
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', locus: ['src/g.mjs'], deps: ['r'] }),
  ]
  const rows = resumeLeaves(dir, EFFORT, EXECUTION, nodes)
  assert.equal(rowOf(rows, 'r').next_action, 'verify')
  assert.equal(rowOf(rows, 'g').next_action, 'code', 'the red\'s commit is not the green\'s series')
  assert.deepEqual(rowOf(rows, 'g').commits, [])

  const wg = worktreeOf(dir, EFFORT, 'g')
  const hg = commit(wg, 'src/g.mjs', 'feat(g): implement the rule')
  const after = rowOf(resumeLeaves(dir, EFFORT, EXECUTION, nodes), 'g')
  assert.deepEqual(after.commits, [{ sha: hg, subject: 'feat(g): implement the rule' }])
})

test('a green brought up to its moved parent at the cut is measured from the refresh merge', (t) => {
  const dir = repository(t)
  const wr = open(dir, 'r')
  const hr = commit(wr, 'test/r.test.mjs', 'test(r): pin the rule')
  const wl = open(dir, 'l')
  const hl = commit(wl, 'src/l.mjs', 'feat(l): add l')
  git(dir, 'branch', '-f', branchOf(EFFORT, '.'), hl)
  const wg = open(dir, 'g', hr)
  git(wg, 'merge', '--no-ff', '--no-edit', branchOf(EFFORT, '.'))
  const refresh = git(wg, 'rev-parse', 'HEAD')
  const hg = commit(wg, 'src/g.mjs', 'feat(g): implement the rule')

  const nodes = [
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', locus: ['src/g.mjs'], deps: ['r'] }),
  ]
  const g = rowOf(resumeLeaves(dir, EFFORT, EXECUTION, nodes), 'g')
  assert.equal(g.base_sha, refresh)
  assert.deepEqual(g.commits, [{ sha: hg, subject: 'feat(g): implement the rule' }], 'l\'s commit is the parent\'s, not g\'s')
})

test('uncommitted work in a leaf\'s worktree is reported, and adopted by nobody', (t) => {
  const dir = repository(t)
  const wa = open(dir, 'a')
  commit(wa, 'src/a.mjs', 'feat(a): done')
  writeFileSync(join(wa, 'src', 'scratch.mjs'), 'not committed\n')

  const row = rowOf(resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a')]), 'a')
  assert.equal(row.next_action, 'continue-series')
  assert.deepEqual(row.dirty, ['?? src/scratch.mjs'])
})

test('journal lines of another execution of the effort are read too, and still need git to agree', (t) => {
  const dir = repository(t)
  const wa = open(dir, 'a')
  const ha = commit(wa, 'src/a.mjs', 'feat(a): done')
  assert.equal(append(dir, EFFORT, 'journal:20260101-000000', { kind: 'series-done', node: 'a', head_sha: ha, commits: [] }).ok, true)

  assert.equal(rowOf(resumeLeaves(dir, EFFORT, EXECUTION, [leaf('a')]), 'a').next_action, 'verify')
})

// ---------------------------------------------------------------- the pure ladder

test('nextActionFor answers from the facts it is handed, and only ever names a known action', () => {
  const a = leaf('a')
  const g = { branch: 'agentics/e1--a', head_sha: 'h2', base_sha: 'h0', commits: [{ sha: 'h2', subject: 's' }], checkpoint_head: false, merged_into_parent: false }
  const cases = [
    [{}, 'code'],
    [{ git: { ...g, commits: [] } }, 'code'],
    [{ git: g }, 'continue-series'],
    [{ git: g, journal: [{ kind: 'series-done', node: 'a', head_sha: 'h2' }] }, 'verify'],
    [{ git: g, journal: [{ kind: 'series-done', node: 'OTHER', head_sha: 'h2' }] }, 'continue-series'],
    [{ git: { ...g, checkpoint_head: true }, journal: [{ kind: 'series-done', node: 'a', head_sha: 'h2' }] }, 'continue-series'],
    [{ git: g, events: [{ kind: 'approved', node: 'a', head_sha: 'h2', seq: 5 }] }, 'merge'],
    [{ git: g, events: [{ kind: 'approved', node: 'a', head_sha: 'h2', seq: 5 }, { kind: 'dispatched', node: 'a', seq: 6 }] }, 'continue-series'],
    [{ git: { ...g, merged_into_parent: true } }, 'continue-series'],
    [{ git: { ...g, merged_into_parent: true }, events: [{ kind: 'approved', node: 'a', head_sha: 'h2', seq: 1 }] }, 'none'],
    [{ events: [{ kind: 'merged', node: 'a', seq: 3 }] }, 'none'],
  ]
  for (const [facts, want] of cases) {
    const got = nextActionFor(a, facts)
    assert.equal(got.next_action, want, JSON.stringify(facts))
    assert.ok(ACTIONS.includes(got.next_action))
    assert.ok(got.note.length > 0)
  }
})
