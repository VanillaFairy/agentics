// test/adopt-check.test.mjs — the adoption check against real git: what it reads from the
// branches, what it refuses, what it reports, and that it writes nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { adopt, adoptFacts, checkAdoption, parseMapping } from '../lib/adopt.mjs'
import { actToken } from '../lib/approval.mjs'
import { readLog } from '../lib/ledger.mjs'
import { branchOf, executionDir, worktreeOf } from '../lib/store.mjs'
import { commitIn, git, leaf, repo, root } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const NODES = [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { locus: ['src/a.mjs'] }),
  leaf('c/b', { locus: ['src/b.mjs'] }), { id: 'd', kind: 'composite', title: 'd', decisions: ['D1'] }, leaf('d/x', { locus: ['src/x.mjs'] }),
  leaf('top', { locus: ['src/top.mjs'] })]

function world(t) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  assert.equal(seedTree(r, E, NODES).ok, true)
  const base = git(r, 'rev-parse', 'HEAD')
  git(r, 'branch', branchOf(E, '.'), base)
  git(r, 'branch', branchOf(E, 'c'), base)
  const wt = worktreeOf(r, E, 'c')
  git(r, 'worktree', 'add', '-q', wt, branchOf(E, 'c'))
  const dir = mkdtempSync(join(tmpdir(), 'agentics-map-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let n = 0
  const mapFile = (doc) => {
    const path = join(dir, 'map-' + n++ + '.json')
    writeFileSync(path, JSON.stringify(doc))
    return path
  }
  return { r, base, wt, mapFile }
}
const checkOf = (w, doc, folder = 'c', opts = {}) => adopt(w.r, E, folder, w.mapFile(doc), 'check', opts)
const kinds = (out) => out.refusals.map((x) => [x.entry, x.kind])
const handBranch = (w, name, from) => {
  const path = join(w.r, '.claude', 'worktrees', 'hand-' + name.replace(/\W/g, '-'))
  git(w.r, 'worktree', 'add', '-q', '-b', name, path, from)
  return path
}

test('a check of straight commits is ok, offers the token over its digest and names the criteria', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const two = commitIn(w.wt, { 'src/a.mjs': '2\n' }, 'two')
  const out = checkOf(w, { done: [{ node: 'c/a', commits: [two.slice(0, 10), one] }] })
  assert.equal(out.ok, true, JSON.stringify(out.refusals))
  assert.equal(out.folder_head, two)
  assert.equal(out.token, actToken({ act: 'adopt', folder: 'c', hash: out.digest }))
  assert.deepEqual(out.unaccounted, [])
  assert.deepEqual(out.outside_locus, [])
  assert.deepEqual(out.criteria, [{ node: 'c/a', criteria: ['c/a works'] }])
})

test('a check writes nothing: no record and no branch', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const before = readLog(w.r, E, 'events').entries.length
  const branches = git(w.r, 'branch', '--list')
  checkOf(w, { done: [{ node: 'c/a', commits: [one] }], handover: [] })
  assert.equal(readLog(w.r, E, 'events').entries.length, before)
  assert.equal(git(w.r, 'branch', '--list'), branches)
})

test("commits the mapping leaves out stay in the report's unaccounted", (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const two = commitIn(w.wt, { 'src/b.mjs': '2\n' }, 'two')
  const out = checkOf(w, { done: [{ node: 'c/a', commits: [one] }] })
  assert.equal(out.ok, true)
  assert.deepEqual(out.unaccounted, [{ branch: branchOf(E, 'c'), commits: [two] }])
})

test("a file the leaf's locus does not admit is reported, never refused", (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n', 'README.md': 'edited\n' }, 'one')
  const out = checkOf(w, { done: [{ node: 'c/a', commits: [one] }] })
  assert.equal(out.ok, true)
  assert.deepEqual(out.outside_locus, [{ node: 'c/a', paths: ['README.md'] }])
})

test('a hand --no-ff merged branch adopts what the merge brought in, and the merge leaves nothing unaccounted', (t) => {
  const w = world(t)
  const hand = handBranch(w, 'hand/a', branchOf(E, 'c'))
  const h1 = commitIn(hand, { 'src/a.mjs': '1\n' }, 'h1')
  const h2 = commitIn(hand, { 'src/a.mjs': '2\n' }, 'h2')
  git(w.wt, 'merge', '--no-ff', '--no-edit', 'hand/a')
  const doc = { done: [{ node: 'c/a', branch: 'hand/a' }] }
  const out = checkOf(w, doc)
  assert.equal(out.ok, true, JSON.stringify(out.refusals))
  assert.deepEqual(out.unaccounted, [])
  const mapping = parseMapping(JSON.stringify(doc)).mapping
  assert.deepEqual(checkAdoption(mapping, adoptFacts(w.r, E, 'c', mapping)).normalized.done, [{ node: 'c/a', branch: 'hand/a', commits: [h1, h2] }])
})

test('a fast-forwarded branch refuses empty_entry, naming done.commits', (t) => {
  const w = world(t)
  const hand = handBranch(w, 'hand/ff', branchOf(E, 'c'))
  commitIn(hand, { 'src/a.mjs': '1\n' }, 'ff')
  git(w.wt, 'merge', '--ff-only', 'hand/ff')
  const out = checkOf(w, { done: [{ node: 'c/a', branch: 'hand/ff' }] })
  assert.deepEqual(kinds(out), [['done[0]', 'empty_entry']])
  assert.match(out.refusals[0].message, /commits/)
  assert.equal(out.token, '')
})

test('a sha git cannot resolve refuses unknown_commit; a branch it cannot, unknown_branch', (t) => {
  const w = world(t)
  const out = checkOf(w, { done: [{ node: 'c/a', commits: ['deadbeefdeadbeef'] }, { node: 'c/b', branch: 'no/such' }], outside: [{ commits: ['zz'] }] })
  assert.deepEqual(kinds(out), [['done[0]', 'unknown_commit'], ['done[1]', 'unknown_branch'], ['outside[0]', 'unknown_commit']])
})

test('a commit, or a branch, the folder branch does not hold refuses not_on_folder_branch', (t) => {
  const w = world(t)
  const onMain = commitIn(w.r, { 'docs/main.md': 'm\n' }, 'on main')
  const hand = handBranch(w, 'hand/open', branchOf(E, 'c'))
  commitIn(hand, { 'src/b.mjs': '1\n' }, 'not merged')
  const out = checkOf(w, { done: [{ node: 'c/a', commits: [onMain] }, { node: 'c/b', branch: 'hand/open' }] })
  assert.deepEqual(kinds(out), [['done[0]', 'not_on_folder_branch'], ['done[1]', 'not_on_folder_branch']])
})

test('a folder whose integration branch does not exist refuses no_folder_branch', (t) => {
  const w = world(t)
  const one = commitIn(w.r, { 'src/x.mjs': '1\n' }, 'x')
  assert.deepEqual(kinds(checkOf(w, { done: [{ node: 'd/x', commits: [one] }] }, 'd')), [['', 'no_folder_branch']])
})

test('a live run over the folder or above it refuses run_live; one beside it does not', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const open = (stamp, rootId) => {
    mkdirSync(executionDir(w.r, E, stamp), { recursive: true })
    writeFileSync(join(executionDir(w.r, E, stamp), 'execution.json'), JSON.stringify({ stamp, root: rootId }))
  }
  open('20261009-120000', 'd')
  const doc = { done: [{ node: 'c/a', commits: [one] }] }
  assert.deepEqual(kinds(checkOf(w, doc, 'c', { live: () => true })), [])
  open('20261009-130000', '.')
  assert.deepEqual(kinds(checkOf(w, doc, 'c', { live: (stamp) => stamp === '20261009-130000' })), [['', 'run_live']])
  assert.deepEqual(kinds(checkOf(w, doc, 'c', { live: () => false })), [], 'an open execution that is not running does not refuse')
})

/** The effort branch checked out: its worktree. */
const rootWorktree = (w) => {
  const path = worktreeOf(w.r, E, '.')
  git(w.r, 'worktree', 'add', '-q', path, branchOf(E, '.'))
  return path
}
const envelope = (w, stamp, fields) => {
  mkdirSync(executionDir(w.r, E, stamp), { recursive: true })
  writeFileSync(join(executionDir(w.r, E, stamp), 'execution.json'), JSON.stringify({ stamp, ...fields }))
}

test('a live run rooted below the folder refuses run_live', (t) => {
  const w = world(t)
  const top = commitIn(rootWorktree(w), { 'src/top.mjs': '1\n' }, 'top')
  envelope(w, '20261009-120000', { root: 'c' })
  assert.deepEqual(kinds(checkOf(w, { done: [{ node: 'top', commits: [top] }] }, '.', { live: () => true })), [['', 'run_live']])
})

test("adopting at the root with no branch.json takes the root's cut from the execution envelope", (t) => {
  const w = world(t)
  envelope(w, '20261009-120000', { root: '.', base_branch: 'main', base_sha: w.base })
  const top = commitIn(rootWorktree(w), { 'src/top.mjs': '1\n' }, 'top')
  const out = checkOf(w, { done: [{ node: 'top', commits: [top] }] }, '.')
  assert.equal(out.ok, true, JSON.stringify(out.refusals))
  assert.deepEqual(out.unaccounted, [], 'the base commits are the cut, not outside work')
})

test("a handover onto a canonical branch that exists at another head refuses branch_exists", (t) => {
  const w = world(t)
  const hand = handBranch(w, 'hand/b', branchOf(E, 'c'))
  commitIn(hand, { 'src/b.mjs': '1\n' }, 'started by hand')
  git(w.r, 'branch', branchOf(E, 'c/b'), branchOf(E, 'c'))
  assert.deepEqual(kinds(checkOf(w, { handover: [{ node: 'c/b', branch: 'hand/b' }] })), [['handover[0]', 'branch_exists']])
})

test('the token moves with the folder head', (t) => {
  const w = world(t)
  const one = commitIn(w.wt, { 'src/a.mjs': '1\n' }, 'one')
  const doc = { done: [{ node: 'c/a', commits: [one] }] }
  const first = checkOf(w, doc)
  commitIn(w.wt, { 'src/b.mjs': '1\n' }, 'later')
  const second = checkOf(w, doc)
  assert.notEqual(first.digest, second.digest)
  assert.notEqual(first.token, second.token)
})

// ---------------------------------------------------------------- what the folder's cut holds

test("a commit the folder's cut holds, the effort's base here, is not the folder's work: done and outside refuse alike", (t) => {
  const w = world(t)
  const out = checkOf(w, { done: [{ node: 'c/a', commits: [w.base] }], outside: [{ commits: [w.base] }] })
  assert.deepEqual(kinds(out), [['done[0]', 'not_on_folder_branch'], ['outside[0]', 'not_on_folder_branch']])
  assert.equal(out.token, '')
})

test("a hand merge of the parent into the folder brings in commits the folder's cut holds: neither they nor the parent's branch are adoptable", (t) => {
  const w = world(t)
  const fromParent = commitIn(rootWorktree(w), { 'docs/parent.md': 'p\n' }, 'parent moved on')
  git(w.wt, 'merge', '--no-ff', '--no-edit', branchOf(E, '.'))
  const out = checkOf(w, { done: [{ node: 'c/a', commits: [fromParent] }, { node: 'c/b', branch: branchOf(E, '.') }] })
  assert.deepEqual(kinds(out), [['done[0]', 'not_on_folder_branch'], ['done[1]', 'not_on_folder_branch']])
})

test("a branch that carried a refresh from the parent into the folder adopts its own commits, never the parent's", (t) => {
  const w = world(t)
  const fromParent = commitIn(rootWorktree(w), { 'docs/parent.md': 'p\n' }, 'parent moved on')
  const hand = handBranch(w, 'hand/a', branchOf(E, 'c'))
  const own = commitIn(hand, { 'src/a.mjs': '1\n' }, 'own work')
  git(hand, 'merge', '--no-ff', '--no-edit', branchOf(E, '.'))
  git(w.wt, 'merge', '--no-ff', '--no-edit', 'hand/a')
  const doc = { done: [{ node: 'c/a', branch: 'hand/a' }] }
  const out = checkOf(w, doc)
  assert.equal(out.ok, true, JSON.stringify(out.refusals))
  const mapping = parseMapping(JSON.stringify(doc)).mapping
  const [adopted] = checkAdoption(mapping, adoptFacts(w.r, E, 'c', mapping)).normalized.done
  assert.ok(adopted.commits.includes(own), 'the branch\'s own commit is adopted')
  assert.ok(!adopted.commits.includes(fromParent), 'the parent\'s commit is the cut\'s')
})

test("at the root, a done commit the base holds refuses not_on_folder_branch", (t) => {
  const w = world(t)
  envelope(w, '20261009-120000', { root: '.', base_branch: 'main', base_sha: w.base })
  assert.deepEqual(kinds(checkOf(w, { done: [{ node: 'top', commits: [w.base] }] }, '.')), [['done[0]', 'not_on_folder_branch']])
})

test("at the root, a commit the base branch holds now, fast-forwarded onto the effort branch, is the effort's ground", (t) => {
  const w = world(t)
  envelope(w, '20261009-120000', { root: '.', base_branch: 'main', base_sha: w.base })
  const rootWt = rootWorktree(w)
  const fromBase = commitIn(w.r, { 'docs/base.md': 'b\n' }, 'the user moved main on')
  git(rootWt, 'merge', '-q', '--ff-only', fromBase)
  const top = commitIn(rootWt, { 'src/top.mjs': '1\n' }, 'top')
  assert.deepEqual(kinds(checkOf(w, { outside: [{ commits: [fromBase] }] }, '.')), [['outside[0]', 'not_on_folder_branch']])
  assert.deepEqual(kinds(checkOf(w, { done: [{ node: 'top', commits: [fromBase] }] }, '.')), [['done[0]', 'not_on_folder_branch']])
  const own = checkOf(w, { done: [{ node: 'top', commits: [top] }] }, '.')
  assert.equal(own.ok, true, JSON.stringify(own.refusals))
})

test("at the root, the base branch itself is no done branch once the effort holds it, and a branch that carried a refresh from it adopts only its own commits", (t) => {
  const w = world(t)
  envelope(w, '20261009-120000', { root: '.', base_branch: 'main', base_sha: w.base })
  const rootWt = rootWorktree(w)
  const fromBase = commitIn(w.r, { 'docs/base.md': 'b\n' }, 'the user moved main on')
  const hand = handBranch(w, 'hand/t', branchOf(E, '.'))
  const own = commitIn(hand, { 'src/top.mjs': '1\n' }, 'own work')
  git(hand, 'merge', '--no-ff', '--no-edit', 'main')
  git(rootWt, 'merge', '--no-ff', '--no-edit', 'hand/t')
  const doc = { done: [{ node: 'top', branch: 'hand/t' }] }
  const mapping = parseMapping(JSON.stringify(doc)).mapping
  const [adopted] = checkAdoption(mapping, adoptFacts(w.r, E, '.', mapping)).normalized.done
  assert.ok(adopted.commits.includes(own), "the branch's own commit is adopted")
  assert.ok(!adopted.commits.includes(fromBase), "main's commit is the effort's ground")
  git(rootWt, 'merge', '-q', '--ff-only', 'main')
  assert.deepEqual(kinds(checkOf(w, { done: [{ node: 'top', branch: 'main' }] }, '.')), [['done[0]', 'not_on_folder_branch']])
})
