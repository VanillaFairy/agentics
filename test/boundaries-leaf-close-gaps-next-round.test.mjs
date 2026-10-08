// test/boundaries-leaf-close-gaps-next-round.test.mjs — lib/boundaries/leaf-close.mjs where the
// other boundaries-leaf-close files leave a path open: what a round answered, the pick order of
// commands, the series, the next round and `recordCommands`.
//
// What is pinned here:
//
//   G11  what a round answered
//   G12  the pick order of commands
//   G15  the series and `committed`
//   G16  the next round's messages and the raise
//   G17  `recordCommands`
//
// Every close here is a `leafClose` call over real git and the real measurement; expected ids,
// shas, paths and keys are computed. The world builders the parts share are in
// test/harness/leaf-close-gaps-world.mjs.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#verification.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { recordCommands } from '../lib/boundaries/leaf-close.mjs'
import { gotchaId, listGotchas, writeGotcha } from '../lib/gotchas.mjs'
import { COMMANDS, git, root } from './harness/boundary-fixture.mjs'
import {
  E, SLOW, FAIL, world, open, write, commit, auditor, stored, run, recs, msgs, rec, head, claimsOf, DONE,
  A_FILES, MORE_TEST, ADD_BITE, crit, lfNode, tdd, testsOnly, R_TEST_TWO, R_BITES, R_SURVIVES, R_STALE,
  TABLE_TEST, CAPACITY_BITE, TABLE_GREEN, cycle, answered,
} from './harness/leaf-close-gaps-world.mjs'

const command = (name, value) => ({ kind: 'command', roles: ['implementer', 'investigator'], paths: [], trigger: 'running ' + name, action: 'use it', evidence: { command: name, output: 'ok' }, command: { name, value } })

// ================================================================== G11

describe('G11: what a round answered', () => {
  /** An implementer round carrying the messages `kinds` names, blocked so that nothing is measured. */
  async function carrying(t, kinds) {
    const { w, o } = tdd(t)
    const carries = kinds.map((msg) => answered(w, { node: 'a', thread: 'producer:a', msg, payload: {}, round: 2 }))
    await run(w, { node: 'a', role: 'implementer', round: 2, ret: { status: 'blocked', text: 'stuck' }, carries, base_sha: o.base_sha, head_before: o.base_sha })
    return rec(w, 'a', 'implementer', 2).answering
  }

  test('G11.1 a dispatch carrying needs_tests and, later, findings closes answering needs_tests', SLOW, async (t) => {
    assert.equal(await carrying(t, ['needs_tests', 'findings']), 'needs_tests')
  })

  test('G11.2 a dispatch carrying two messages, neither needs_tests, closes answering the later one', SLOW, async (t) => {
    assert.equal(await carrying(t, ['findings', 'failures']), 'failures')
  })
})

// ================================================================== G12

describe('G12: commands', () => {
  test('G12.1 a suite named by a command gotcha and by the envelope is run as the gotcha names it', SLOW, async (t) => {
    const w = world(t, [root(), lfNode('a', { rigor: 'trivial', locus: ['README.md'] })], { commands: { ...COMMANDS, suite: 'echo envelope-suite' } })
    const o = open(w, 'a')
    commit(o.worktree, { 'README.md': 'hello\nmore\n' }, 'Edit the readme')
    assert.equal(writeGotcha(w.r, E, command('suite', 'echo gotcha-suite'), { source: { role: 'investigator' } }).ok, true)
    const handed = []
    const ports = {
      spawn: (cmd, args, opts) => {
        const child = spawn(cmd, args, opts)
        const end = child.stdin.end.bind(child.stdin)
        child.stdin.end = (data, ...rest) => { handed.push(JSON.parse(String(data))); return end(data, ...rest) }
        return child
      },
    }
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha, ports })
    assert.ok(handed.length > 0, 'the close measured')
    for (const options of handed) assert.equal(options.suite, 'echo gotcha-suite')
  })
})

// ================================================================== G15

describe('G15: the series and committed', { concurrency: 2 }, () => {
  test('G15.1 a round that returned done with no commit over its base journals no series-done', SLOW, async (t) => {
    const { w, o } = tdd(t)
    await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.deepEqual(recs(w, 'series-done', 'a'), [])
  })

  test('G15.2 a test round that commits nothing after an earlier round authored commit has committed empty', SLOW, async (t) => {
    const { w, o } = testsOnly(t)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST })
    await run(w, { node: 't', role: 'test-author', round: 1, ret: { status: 'done', text: 'one', commit: 'Test add', mutations: [ADD_BITE] }, base_sha: o.base_sha })
    assert.equal(recs(w, 'authored', 't').length, 1)
    await run(w, { node: 't', role: 'test-author', round: 2, ret: { status: 'done', text: 'nothing more', mutations: [ADD_BITE] }, base_sha: o.base_sha, head_before: head(o.worktree) })
    assert.equal(rec(w, 't', 'test-author', 2).committed, '')
  })
})

// ================================================================== G16

describe('G16: the next round\'s messages and the raise', { concurrency: 2 }, () => {
  const exists = (f) => `node -e "process.exit(require('fs').existsSync('${f}')?0:1)"`
  const absent = (f) => `node -e "process.exit(require('fs').existsSync('${f}')?1:0)"`

  test('G16.1 a close does not raise when the previous failures were two, one cleared and the other fails again beside a new one', SLOW, async (t) => {
    const w = world(t, [root(), lfNode('a', {
      locus: ['src/a.mjs', 'test/a.test.mjs', 'a.txt', 'b.txt', 'c.txt'],
      acceptance: [
        { text: 'a exists', check: exists('a.txt'), decisions: ['D1'] },
        { text: 'b exists', check: exists('b.txt'), decisions: ['D1'] },
        { text: 'c is absent', check: absent('c.txt'), decisions: ['D1'] },
      ],
    })])
    const o = open(w, 'a')
    const one = commit(o.worktree, A_FILES, 'Add a')
    const first = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(claimsOf(first.out).length, 2, 'a and b fail')
    commit(o.worktree, { 'a.txt': 'x\n', 'c.txt': 'x\n' }, 'Clear a, break c')
    const second = await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: one })
    assert.equal(second.out.decision.next, 'fix', JSON.stringify(second.out.decision))
    assert.equal(claimsOf(second.out).length, 2, 'b and c fail')
    assert.equal(second.out.raise, false)
    assert.equal(rec(w, 'a', 'implementer', 2).raise, false)
  })

  test('G16.2 a test round that answered needs_tests and sends its failures to the green records tests_ready beside them', SLOW, async (t) => {
    const c = cycle(t, TABLE_GREEN)
    const asked = answered(c.w, { node: 'g', thread: 'producer:r', msg: 'needs_tests', payload: { text: 'pin it' }, round: 3, from: 'implementer' })
    write(c.green.worktree, { 'src/table.test.mjs': TABLE_TEST.replace('capacity, 1', 'capacity, 2') })
    const ret = { status: 'done', text: 'pinned', commit: 'Pin the capacity', mutations: [CAPACITY_BITE] }
    const { out } = await run(c.w, { node: 'g', role: 'test-author', round: 3, thread: 'producer:r', ret, carries: [asked], base_sha: c.green.base_sha, head_before: c.greenHead })
    assert.equal(out.decision.next, 'fix', JSON.stringify(out.decision))
    const sent = msgs(c.w, 'failures', 'g')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:g')
    assert.equal(msgs(c.w, 'tests_ready', 'g').length, 1)
  })

  test('G16.3 an audit fix close whose only non-biting mutation could not be applied records failures, not surviving_mutations', SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    const { out } = await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret: auditor([R_STALE]), base_sha: c.audit.base_sha, head_before: c.audit.base_sha })
    assert.equal(out.decision.next, 'fix', JSON.stringify(out.decision))
    assert.equal(msgs(c.w, 'failures', 'au').length, 1)
    assert.deepEqual(msgs(c.w, 'surviving_mutations', 'au'), [])
  })

  test('G16.4 surviving_mutations lists the survivor only when one mutation bit and one got through', SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret: auditor([R_BITES, R_SURVIVES]), base_sha: c.audit.base_sha, head_before: c.audit.base_sha })
    const sent = msgs(c.w, 'surviving_mutations', 'au')
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].payload.mutations.map((m) => m.replace), [R_SURVIVES.replace])
  })

  test('G16.5 an audit fix close with no surviving mutation sends its failures to the red when an earlier measurement let one through', SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret: auditor([R_SURVIVES]), base_sha: c.audit.base_sha, head_before: c.audit.base_sha })
    write(c.audit.worktree, { 'test/r.test.mjs': R_TEST_TWO })
    // The thread is whatever the caller passed; the cycle's test session is picked from the records.
    const { out } = await run(c.w, { node: 'au', role: 'test-author', round: 2, thread: 'producer:au', ret: { status: 'done', text: 'a case more', commit: 'Pin r at 3', mutations: [R_STALE] }, base_sha: c.audit.base_sha, head_before: c.audit.base_sha })
    assert.equal(out.decision.next, 'fix', JSON.stringify(out.decision))
    assert.deepEqual(msgs(c.w, 'surviving_mutations', 'au').filter((m) => m.round === 3), [])
    const sent = msgs(c.w, 'failures', 'au')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:r')
  })

  test('G16.6 a green test-author round 2 failing as implementer round 1 did, at another head, escalates verify_not_converging', SLOW, async (t) => {
    const c = cycle(t, { check: FAIL })
    const first = await run(c.w, { node: 'g', role: 'implementer', round: 1, ret: DONE, base_sha: c.green.base_sha, head_before: c.green.base_sha })
    assert.equal(first.out.decision.next, 'fix', JSON.stringify(first.out.decision))
    write(c.green.worktree, { 'test/r.test.mjs': R_TEST_TWO })
    const ret = { status: 'done', text: 'a case more', commit: 'Pin r at 3', mutations: [R_BITES] }
    const second = await run(c.w, { node: 'g', role: 'test-author', round: 2, thread: 'producer:r', ret, base_sha: c.green.base_sha, head_before: c.greenHead })
    assert.deepEqual([second.out.decision.next, second.out.decision.reason], ['stop', 'verify_not_converging'])
  })

  test('G16.6 a test-author round 2 failing as test-author round 1 did, at another head, escalates verify_not_converging', SLOW, async (t) => {
    const w = world(t, [root(), lfNode('t', { rigor: 'tests-only', locus: ['test/more.test.mjs'], acceptance: crit('t', FAIL) })])
    const o = open(w, 't')
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST })
    const first = await run(w, { node: 't', role: 'test-author', round: 1, ret: { status: 'done', text: 'one', commit: 'Test add', mutations: [ADD_BITE] }, base_sha: o.base_sha })
    assert.equal(first.out.decision.next, 'fix', JSON.stringify(first.out.decision))
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST + '// again\n' })
    const second = await run(w, { node: 't', role: 'test-author', round: 2, ret: { status: 'done', text: 'two', commit: 'Test add again', mutations: [ADD_BITE] }, base_sha: o.base_sha, head_before: head(o.worktree) })
    assert.deepEqual([second.out.decision.next, second.out.decision.reason], ['stop', 'verify_not_converging'])
  })
})

// ================================================================== G17

describe('G17: recordCommands', () => {
  test('G17.1 each command gotcha recordCommands writes is observed at the repository HEAD', SLOW, async (t) => {
    const w = world(t, [root(), lfNode('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })], { commands: null })
    const commands = [command('suite', COMMANDS.suite), command('test_one', COMMANDS.test_one)]
    const inv = stored(w, { node: 'a', role: 'investigator', round: 1, thread: 'investigator', dispatch: 'inv-1', ret: { commands, established: ['suite', 'test_one'], unresolved: [], text: 'found them' } })
    const result = recordCommands(w.xc, { dispatch: inv })
    assert.deepEqual([...result.written].sort(), commands.map(gotchaId).sort())
    const tip = git(w.r, 'rev-parse', 'HEAD')
    for (const id of result.written) assert.equal(listGotchas(w.r, E).find((g) => g.id === id).observed_at, tip)
  })
})
