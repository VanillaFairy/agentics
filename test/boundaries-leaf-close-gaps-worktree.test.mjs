// test/boundaries-leaf-close-gaps-worktree.test.mjs — lib/boundaries/leaf-close.mjs where the other
// boundaries-leaf-close files leave a path open: what a kill, a killed verify and git itself leave
// in a worktree.
//
// What is pinned here:
//
//   G1   a close run again after a kill between a shell-less author's commit and its `authored` line
//   G2   what a killed verify leaves (a file rewritten in place, a detached HEAD, kept work), and
//        what verify notes so a close can tell it from the round's work
//   G9   only this round's `agentics:` commits are read back
//   G10  a staged rename
//
// Every close here is a `leafClose` call over real git and the real measurement; expected ids,
// shas, paths and keys are computed. The world builders the parts share are in
// test/harness/leaf-close-gaps-world.mjs.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#verification.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verify } from '../lib/verify.mjs'
import { git, root } from './harness/boundary-fixture.mjs'
import {
  WIDGET_TEST, cycle as verifyCycle, git as plainGit, mutations as mutationFlags, options as verifyOptions,
} from './harness/verify-fixture.mjs'
import {
  SLOW, REVERT, lf, scenario, world, open, write, commit, auditor, stored, close, run, recs, rec, head,
  subjectsOver, holds, text, DONE, A_FILES, MORE_TEST, ADD_BITE, lfNode, tdd, testsOnly, R_TEST, R_TEST_TWO,
  R_BITES, TABLE, TABLE_TEST, CAPACITY_BITE, TABLE_GREEN, cycle,
} from './harness/leaf-close-gaps-world.mjs'

const NOTE = 'agentics-verify-rewriting'
const KEPT = 'refs/worktree/agentics-verify/'
const OUTSIDE = 'agentics: outside locus'

const posix = (p) => String(p).split('\\').join('/')

const isAncestor = (worktree, ancestor, of) => spawnSync('git', ['-C', worktree, 'merge-base', '--is-ancestor', ancestor, of], { encoding: 'utf8' }).status === 0
const shown = (worktree, ref) => lf(spawnSync('git', ['-C', worktree, 'show', ref], { encoding: 'utf8' }).stdout)

// ================================================================== G1

describe('G1: a close run again after a kill between a shell-less author\'s commit and its authored line', { concurrency: 2 }, () => {
  const s = scenario(async (t) => {
    const c = cycle(t, TABLE_GREEN)
    // The close's own commit as it stands when the process died before it journalled `authored`.
    const made = commit(c.green.worktree, { 'src/table.test.mjs': TABLE_TEST }, 'Pin the capacity')
    const ret = { status: 'done', text: 'pinned', commit: 'Pin the capacity', mutations: [CAPACITY_BITE] }
    const { out } = await run(c.w, { node: 'g', role: 'test-author', round: 2, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: c.greenHead })
    return { c, made, out }
  })
  after(() => s.end())

  test('G1.1 the commit stands with no authored line: its test file is still at the head and no revert commit is made', SLOW, async () => {
    const { c, made } = await s.get()
    assert.equal(shown(c.green.worktree, 'HEAD:src/table.test.mjs'), shown(c.green.worktree, made + ':src/table.test.mjs'))
    assert.ok(isAncestor(c.green.worktree, made, 'HEAD'), 'the commit is still in the series')
    assert.ok(!subjectsOver(c.green.worktree, c.greenHead).includes(REVERT), subjectsOver(c.green.worktree, c.greenHead).join(' | '))
  })

  test('G1.2 that close records no breach_reverted', SLOW, async () => {
    const { c } = await s.get()
    assert.deepEqual(recs(c.w, 'breach_reverted', 'g'), [])
    assert.equal(rec(c.w, 'g', 'test-author', 2).breach, null)
  })

  test('G1.3 that close journals authored naming the commit, and committed is that sha', SLOW, async () => {
    const { c, made } = await s.get()
    const authored = recs(c.w, 'authored', 'g')
    assert.equal(authored.length, 1)
    assert.deepEqual([authored[0].role, authored[0].round, authored[0].sha], ['test-author', 2, made])
    assert.equal(rec(c.w, 'g', 'test-author', 2).committed, made)
  })

  test('G1.4 an implementer round commits are never journalled authored', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, A_FILES, 'Add a')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual(recs(w, 'authored', 'a'), [])
  })
})

// ================================================================== G2

describe('G2: what a killed verify leaves in a worktree', { concurrency: 2 }, () => {
  /** The directory verify keeps its note in: the worktree's own git directory. */
  const noteIn = (worktree) => posix(join(plainGit(worktree, 'rev-parse', '--absolute-git-dir').stdout.trim(), NOTE))

  /** A green's strengthening test round, closed once; the next close of it finds what the test leaves. */
  const strengthened = scenario(async (t) => {
    const c = cycle(t)
    const ret = { status: 'done', text: 'a case more', commit: 'Pin r at 3', mutations: [R_BITES] }
    const spec = { node: 'g', role: 'test-author', round: 2, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: c.greenHead }
    const dispatch = stored(c.w, spec)
    write(c.green.worktree, { 'test/r.test.mjs': R_TEST_TWO })
    await close(c.w, { ...spec, dispatch })
    return { c, spec, dispatch, authored: recs(c.w, 'authored', 'g')[0], size: git(c.green.worktree, 'rev-list', '--count', 'HEAD') }
  })
  after(() => strengthened.end())

  test('G2.1 the red approved text left uncommitted over a file the authored commit changed makes no second authored commit', SLOW, async () => {
    const { c, spec, dispatch, authored, size } = await strengthened.get()
    assert.ok(authored, 'the first close committed the round')
    write(c.green.worktree, { 'test/r.test.mjs': R_TEST })
    writeFileSync(noteIn(c.green.worktree), JSON.stringify(['test/r.test.mjs']))
    await close(c.w, { ...spec, dispatch })
    assert.equal(recs(c.w, 'authored', 'g').length, 1)
    assert.equal(git(c.green.worktree, 'rev-list', '--count', 'HEAD'), size)
    assert.equal(text(c.green.worktree, 'test/r.test.mjs'), lf(R_TEST_TWO))
    assert.equal(shown(c.green.worktree, 'HEAD:test/r.test.mjs'), lf(R_TEST_TWO))
    assert.equal(git(c.green.worktree, 'status', '--porcelain'), '')
  })

  /** A green's test round closed once, then a declared mutation left standing in the cycle source. */
  const mutated = scenario(async (t) => {
    const c = cycle(t, TABLE_GREEN)
    write(c.green.worktree, { 'src/table.test.mjs': TABLE_TEST })
    const ret = { status: 'done', text: 'pinned', commit: 'Pin the capacity', mutations: [CAPACITY_BITE] }
    const spec = { node: 'g', role: 'test-author', round: 2, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: c.greenHead }
    const dispatch = stored(c.w, spec)
    await close(c.w, { ...spec, dispatch })
    const tip = head(c.green.worktree)
    write(c.green.worktree, { 'src/table.mjs': TABLE.replace(CAPACITY_BITE.find, CAPACITY_BITE.replace) })
    writeFileSync(noteIn(c.green.worktree), JSON.stringify(['src/table.mjs']))
    await close(c.w, { ...spec, dispatch })
    return { c, tip }
  })
  after(() => mutated.end())

  test('G2.2 a mutation left standing in a cycle source makes no outside-locus commit, no revert commit and no breach_reverted', SLOW, async () => {
    const { c, tip } = await mutated.get()
    assert.equal(head(c.green.worktree), tip, 'nothing was committed after the leftover')
    assert.ok(!subjectsOver(c.green.worktree, c.greenHead).some((s) => s.startsWith('agentics:')), subjectsOver(c.green.worktree, c.greenHead).join(' | '))
    assert.deepEqual(recs(c.w, 'breach_reverted', 'g'), [])
  })

  test('G2.3 the source in the worktree equals the head after that close', SLOW, async () => {
    const { c } = await mutated.get()
    assert.equal(text(c.green.worktree, 'src/table.mjs'), shown(c.green.worktree, 'HEAD:src/table.mjs'))
  })

  /** A tests-only leaf, the round's work kept under a ref by a verify cut off at the base. */
  const detached = scenario(async (t) => {
    const { w, o } = testsOnly(t, ['test/more.test.mjs', 'test/second.test.mjs'])
    const x1 = commit(o.worktree, { 'test/more.test.mjs': MORE_TEST }, 'Test add with negatives')
    const SECOND = MORE_TEST.replace('adds negatives', 'adds more negatives')
    write(o.worktree, { 'test/second.test.mjs': SECOND })
    git(o.worktree, 'stash', 'push', '--include-untracked', '-m', 'agentics-verify 1-a')
    const kept = git(o.worktree, 'rev-parse', 'stash@{0}')
    git(o.worktree, 'update-ref', KEPT + '1-a', kept)
    git(o.worktree, 'stash', 'drop')
    git(o.worktree, 'checkout', '-q', '--detach', o.base_sha)
    const ret = { status: 'done', text: 'a second file', commit: 'Test the second file', mutations: [ADD_BITE] }
    const { out } = await run(w, { node: 't', role: 'test-author', round: 2, ret, base_sha: o.base_sha, head_before: x1 })
    return { w, o, x1, SECOND, out }
  })
  after(() => detached.end())

  test('G2.4 a worktree verify left detached at the base has the leaf branch checked out again before the close commits', SLOW, async () => {
    const { w, o, x1 } = await detached.get()
    assert.equal(git(o.worktree, 'symbolic-ref', 'HEAD'), 'refs/heads/' + o.branch)
    assert.equal(git(o.worktree, 'rev-parse', o.branch), head(o.worktree), 'the commit the close made is on the branch')
    assert.ok(isAncestor(o.worktree, x1, 'HEAD'), 'the branch head the close started from is kept')
    const authored = recs(w, 'authored', 't')
    assert.equal(authored.length, 1)
    assert.ok(isAncestor(o.worktree, authored[0].sha, o.branch), 'the authored commit is reachable from the branch')
  })

  test('G2.5 the kept work is back in the worktree and the ref is gone', SLOW, async () => {
    const { o, SECOND } = await detached.get()
    assert.equal(text(o.worktree, 'test/second.test.mjs'), lf(SECOND))
    assert.equal(git(o.worktree, 'for-each-ref', KEPT), '')
  })

  /** A verify cycle whose test command appends the note it finds, or `none`, to a log at each call. */
  function noted(t) {
    const c = verifyCycle(t)
    const seen = join(tmpdir(), 'agentics-gaps-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.log')
    t.after(() => rmSync(seen, { force: true }))
    const note = noteIn(c.worktree)
    const cmd = `node -e "const fs=require('fs');fs.appendFileSync('${posix(seen)}',(fs.existsSync('${note}')?fs.readFileSync('${note}','utf8'):'none')+'\\n')" {file}`
    return { c, note, cmd, read: () => (existsSync(seen) ? readFileSync(seen, 'utf8').split('\n').filter(Boolean) : []) }
  }

  test('G2.0 verify notes an approved test file before writing the approved text over it, and clears the note once it is back', SLOW, (t) => {
    const n = noted(t)
    const FILE = 'test/widget.test.mjs'
    write(n.c.worktree, { [FILE]: WIDGET_TEST.replace("'hi'", "'bye'"), 'src/widget.mjs': "export const label = () => 'bye'\n" })
    plainGit(n.c.worktree, 'add', '-A')
    plainGit(n.c.worktree, 'commit', '-qm', 'test(w3): round')
    const headSha = plainGit(n.c.worktree, 'rev-parse', 'HEAD').stdout.trim()
    const asked = verifyOptions({
      worktree: n.c.worktree, base: n.c.head, head: headSha,
      extra: ['--rigor', 'tdd-pair', '--role', 'green', '--producer', 'test-author', '--test-file', FILE, '--test-one', n.cmd],
    })
    verify({ ...asked, approved: [{ file: FILE, sha: n.c.red }] })
    assert.ok(n.read().includes(JSON.stringify([FILE])), 'the note named the approved file while its approved text was written over it: ' + n.read().join(' | '))
    assert.equal(existsSync(n.note), false, 'the note is gone once the file is back')
  })

  test('G2.0 verify notes a file before it applies a mutation to it, and clears the note once it is back', SLOW, (t) => {
    const n = noted(t)
    verify(verifyOptions({
      worktree: n.c.worktree, base: n.c.red, head: n.c.head,
      extra: ['--rigor', 'tdd', '--test-one', n.cmd, ...mutationFlags([{ file: 'src/widget.mjs', find: "'hi'", replace: "'bye'", expect_failing: ['test/widget.test.mjs'] }])],
    }))
    assert.ok(n.read().includes(JSON.stringify(['src/widget.mjs'])), 'the note named the mutated file while the mutation stood: ' + n.read().join(' | '))
    assert.equal(existsSync(n.note), false, 'the note is gone once the file is back')
  })

})

// ================================================================== G9

describe('G9: only this round\'s agentics: commits are read back', { concurrency: 2 }, () => {
  const strays = scenario(async (t) => {
    const { w, o } = testsOnly(t)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST, 'stray.txt': 'one\n' })
    await run(w, { node: 't', role: 'test-author', round: 1, ret: { status: 'done', text: 'one', commit: 'Test add', mutations: [ADD_BITE] }, base_sha: o.base_sha })
    const afterOne = head(o.worktree)
    assert.equal(subjectsOver(o.worktree, o.base_sha)[0], REVERT)
    write(o.worktree, { 'stray2.txt': 'two\n' })
    await run(w, { node: 't', role: 'test-author', round: 2, ret: { status: 'done', text: 'two', mutations: [ADD_BITE] }, base_sha: o.base_sha, head_before: afterOne })
    return { w, o }
  })
  after(() => strays.end())

  test('G9.1 a later round that starts on the revert commit of an earlier one has its own stray file taken out', SLOW, async () => {
    const { o } = await strays.get()
    assert.equal(existsSync(join(o.worktree, 'stray2.txt')), false)
    assert.equal(holds(o.worktree, 'HEAD:stray2.txt'), false)
  })

  test('G9.2 its breach paths name that file and none of the earlier round', SLOW, async () => {
    const { w } = await strays.get()
    assert.deepEqual(rec(w, 't', 'test-author', 2).breach.paths, ['stray2.txt'])
  })

  test('G9.3 an audit cut from a green head ending in a revert records no breach when its auditor writes nothing', SLOW, async (t) => {
    const c = cycle(t, { triad: true, greenSubject: REVERT })
    await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret: auditor([R_BITES]), base_sha: c.audit.base_sha, head_before: c.audit.base_sha })
    assert.deepEqual(recs(c.w, 'breach_reverted', 'au'), [])
    assert.equal(rec(c.w, 'au', 'auditor', 1).breach, null)
  })

  test('G9.4 a round that starts on an outside-locus commit of an earlier round takes out its own stray file and leaves the earlier files out of its breach', SLOW, async (t) => {
    const c = cycle(t, TABLE_GREEN)
    const earlier = commit(c.green.worktree, { 'src/table.mjs': 'export const table = () => ({ capacity: 9 })\n' }, OUTSIDE)
    write(c.green.worktree, { 'stray.txt': 'oops\n' })
    const ret = { status: 'done', text: 'nothing to add', mutations: [R_BITES] }
    await run(c.w, { node: 'g', role: 'test-author', round: 3, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: earlier })
    assert.equal(existsSync(join(c.green.worktree, 'stray.txt')), false)
    assert.deepEqual(rec(c.w, 'g', 'test-author', 3).breach.paths, ['stray.txt'])
  })
})

// ================================================================== G10

describe('G10: a staged rename', () => {
  test('G10.1 a rename inside the locus left staged and uncommitted is put back whole: both paths as at the head, git status clean', SLOW, async (t) => {
    const w = world(t, [root(), lfNode('a', { locus: ['src/a.mjs', 'test/a.test.mjs', 'src/add.mjs', 'src/moved.mjs'] })])
    const o = open(w, 'a')
    commit(o.worktree, A_FILES, 'Add a')
    git(o.worktree, 'mv', 'src/add.mjs', 'src/moved.mjs')
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(existsSync(join(o.worktree, 'src/moved.mjs')), false)
    assert.equal(text(o.worktree, 'src/add.mjs'), shown(o.worktree, 'HEAD:src/add.mjs'))
    assert.equal(git(o.worktree, 'status', '--porcelain'), '')
  })
})
