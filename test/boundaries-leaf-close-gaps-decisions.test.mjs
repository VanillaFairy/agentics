// test/boundaries-leaf-close-gaps-decisions.test.mjs — lib/boundaries/leaf-close.mjs where the
// other boundaries-leaf-close files leave a path open: the decisions D1-D4 and the previous close
// across executions.
//
// What is pinned here:
//
//   G3  [D1] a decline of a round that carried `needs_tests` and findings
//   G5  [D2] an implementer's `needs_tests` is answered by the test round that finally measures
//   G6  [D3] a verify finding under a planner's folder
//   G7  the previous close and the breach record across executions
//   G8  [D4] held mutations and the audit gap across executions
//
// Every close here is a `leafClose` call over real git and the real measurement; expected ids,
// shas, paths and keys are computed. The world builders the parts share are in
// test/harness/leaf-close-gaps-world.mjs.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#verification.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeSessionCommands } from '../lib/boundaries/execution.mjs'
import { executionContext } from '../lib/boundaries/records.mjs'
import { executionLog } from '../lib/ledger.mjs'
import { executionDir, mkdirState } from '../lib/store.mjs'
import { addNodes, readTree } from '../lib/tree.mjs'
import { COMMANDS, git, root } from './harness/boundary-fixture.mjs'
import {
  E, SLOW, FAIL, scenario, world, open, write, commit, auditor, stored, close, run, recs, msgs, observed, rec,
  head, claimsOf, DONE, A_SRC, A_FILES, MORE_TEST, ADD_BITE, crit, lfNode, testsOnly, R_TEST_TWO, R_SRC,
  R_SURVIVES, R_STALE, TABLE_TEST, CAPACITY_BITE, cycle, answered, outside,
} from './harness/leaf-close-gaps-world.mjs'

const OTHER_STAMP = '20260926-120000'

/** The same world under a later execution: its own directory, envelope, log and context. */
function elsewhere(w, stamp = OTHER_STAMP) {
  const dir = executionDir(w.r, E, stamp)
  mkdirState(dir)
  writeFileSync(join(dir, 'execution.json'), JSON.stringify({ stamp, root: '.', base_branch: 'main', base_sha: w.base, commands: COMMANDS }))
  const xc = executionContext({ repo: w.r, effort: E, execution: stamp, log: executionLog(w.r, E, stamp) })
  writeSessionCommands(xc, xc.envelope())
  return { ...w, stamp, xc }
}

const filesOf = (worktree, sha) => git(worktree, 'show', '--name-only', '--format=', sha).split('\n').filter(Boolean)

const ADD_SURVIVES = { file: 'src/add.mjs', find: 'a + b', replace: 'b + a', expect_failing: ['test/more.test.mjs'] }
const ADD_BITE_TOO = { file: 'src/add.mjs', find: 'a + b', replace: 'a * b', expect_failing: ['test/more.test.mjs'] }

const planner = (id = 'c') => ({ id, kind: 'composite', title: id, author: 'planner', decisions: ['D1'] })

const TABLE_LABELLED = "export const table = () => ({ capacity: 1, label: 'x' })\n"

const LABEL_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { table } from './table.mjs'\ntest('is labelled x', () => assert.equal(table().label, 'x'))\n"

const LABEL_BITE = { file: 'src/table.mjs', find: "label: 'x'", replace: "label: 'y'", expect_failing: ['src/table.label.test.mjs'] }
const LABEL_UNBITTEN = { ...LABEL_BITE, expect_failing: ['src/table.test.mjs'] }

// ================================================================== G3

describe('G3: [D1] a decline of a round that carried needs_tests and findings', { concurrency: 2 }, () => {
  const s = scenario(async (t) => {
    const c = cycle(t)
    const asked = answered(c.w, { node: 'g', thread: 'producer:r', msg: 'needs_tests', payload: { text: 'pin it' }, round: 3, from: 'implementer' })
    const found = answered(c.w, { node: 'g', thread: 'producer:r', msg: 'findings', payload: { findings: [] }, round: 3 })
    const ret = { status: 'declined', text: 'a test of that would pin an implementation detail' }
    const { out, dispatch } = await run(c.w, { node: 'g', role: 'test-author', round: 3, thread: 'producer:r', ret, carries: [asked, found], base_sha: c.green.base_sha, head_before: c.greenHead })
    return { c, out, dispatch }
  })
  after(() => s.end())

  test('G3.1 the decline escalates tests_declined, said the dispatch, and stops', SLOW, async () => {
    const { out, dispatch } = await s.get()
    assert.equal(out.decision.next, 'stop')
    assert.deepEqual(out.stops, [{ id: 'g', status: 'escalated', reason: 'tests_declined', said: dispatch }])
  })

  test('G3.2 that close records no declined message', SLOW, async () => {
    const { c } = await s.get()
    assert.deepEqual(msgs(c.w, 'declined', 'g'), [])
  })

  test('G3.3 a decline of needs_tests that also carried brief_changed goes back to the implementer as declined', SLOW, async (t) => {
    const c = cycle(t)
    const asked = answered(c.w, { node: 'g', thread: 'producer:r', msg: 'needs_tests', payload: { text: 'pin it' }, round: 3, from: 'implementer' })
    const moved = answered(c.w, { node: 'g', thread: 'producer:r', msg: 'brief_changed', payload: { changed: ['Acceptance'], brief: 'the red moved' }, round: 3 })
    const ret = { status: 'declined', text: 'a test of that would pin an implementation detail' }
    const { out } = await run(c.w, { node: 'g', role: 'test-author', round: 3, thread: 'producer:r', ret, carries: [asked, moved], base_sha: c.green.base_sha, head_before: c.greenHead })
    assert.deepEqual(out.stops, [])
    const sent = msgs(c.w, 'declined', 'g')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:g')
  })
})

// ================================================================== G5

describe('G5: [D2] an implementer\'s needs_tests is answered by the test round that finally measures', { concurrency: 2 }, () => {
  const s = scenario(async (t) => {
    const c = cycle(t, { greenLocus: ['src/r.mjs', 'src/table.mjs'], greenFiles: { 'src/r.mjs': R_SRC, 'src/table.mjs': TABLE_LABELLED } })
    const asked = answered(c.w, { node: 'g', thread: 'producer:r', msg: 'needs_tests', payload: { text: 'pin it' }, round: 3, from: 'implementer' })
    write(c.green.worktree, { 'src/table.test.mjs': TABLE_TEST })
    const one = { status: 'done', text: 'pinned', commit: 'Pin the capacity', mutations: [LABEL_UNBITTEN] }
    const first = await run(c.w, { node: 'g', role: 'test-author', round: 3, thread: 'producer:r', ret: one, carries: [asked], base_sha: c.green.base_sha, head_before: c.greenHead })
    const sent = msgs(c.w, 'failures', 'g')
    write(c.green.worktree, { 'src/table.label.test.mjs': LABEL_TEST })
    const two = { status: 'done', text: 'pinned the label', commit: 'Pin the label', mutations: [CAPACITY_BITE, LABEL_BITE] }
    const second = await run(c.w, { node: 'g', role: 'test-author', round: 4, thread: 'producer:r', ret: two, carries: sent.map((m) => m.seq), base_sha: c.green.base_sha, head_before: head(c.green.worktree) })
    return { c, first: first.out, second: second.out, sent }
  })
  after(() => s.end())

  test('G5.1 the next test round, carrying only the failures, measures review and records tests_ready to the green at the round after', SLOW, async () => {
    const { c, first, second, sent } = await s.get()
    assert.deepEqual([first.decision.next, sent.length, sent[0].thread], ['fix', 1, 'producer:r'], 'the first round sent its failures back to the test session')
    assert.equal(second.decision.next, 'review', JSON.stringify(second.decision))
    assert.equal(rec(c.w, 'g', 'test-author', 4).answering, 'failures')
    const ready = msgs(c.w, 'tests_ready', 'g')
    assert.equal(ready.length, 1)
    assert.deepEqual([ready[0].thread, ready[0].round], ['producer:g', 5])
  })

  test('G5.2 its files are the test files the cycle test session committed since the request', SLOW, async () => {
    const { c } = await s.get()
    const expected = recs(c.w, 'authored', 'g').flatMap((a) => filesOf(c.green.worktree, a.sha))
    assert.equal(expected.length, 2)
    assert.deepEqual([...msgs(c.w, 'tests_ready', 'g')[0].payload.files].sort(), [...expected].sort())
  })
})

// ================================================================== G6

describe('G6: [D3] a verify finding under a planner\'s folder', () => {
  test('G6.1 the folder replanned without the leaf leaves the leaf not escalated', SLOW, async (t) => {
    const w = world(t, [root(), planner(), lfNode('c/v', { rigor: 'verify', locus: [], acceptance: crit('c/v', FAIL) })])
    const o = open(w, 'c/v')
    const out = await close(w, { node: 'c/v', role: '', round: 1, thread: '', dispatch: '', base_sha: o.base_sha })
    assert.equal(out.decision.next, 'route')
    assert.equal(out.route.request.status, 'verify_finding')
    const replanned = addNodes(w.r, E, [{ ...planner(), title: 'c, rewritten by its planner' }], { by: 'planner', reason: 'verify_finding' })
    assert.equal(replanned.ok, true, JSON.stringify(replanned.problems))
    const tree = readTree(w.r, E)
    assert.notEqual(tree.status.get('c/v').status, 'escalated')
  })
})

// ================================================================== G7

describe('G7: the previous close and the breach record across executions', { concurrency: 2 }, () => {
  test('G7.1 a round-2 close in a later execution escalates verify_not_converging against the earlier execution round-1 close', SLOW, async (t) => {
    const first = world(t, [root(), lfNode('a', { locus: ['src/a.mjs', 'test/a.test.mjs'], acceptance: crit('a', FAIL) })])
    const o = open(first, 'a')
    const one = commit(o.worktree, A_FILES, 'Add a')
    const r1 = await run(first, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(r1.out.decision.next, 'fix', JSON.stringify(r1.out.decision))
    const later = elsewhere(first)
    commit(o.worktree, { 'src/a.mjs': A_SRC + '// second try\n' }, 'Try again')
    const r2 = await run(later, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: one })
    assert.deepEqual([r2.out.decision.next, r2.out.decision.reason], ['stop', 'verify_not_converging'])
  })

  test('G7.2 a round-2 close in a later execution that fails on every earlier key and one more raises', SLOW, async (t) => {
    const ok1 = 'node -e "process.exit(require(\'fs\').existsSync(\'ok1.txt\')?0:1)"'
    const bad2 = 'node -e "process.exit(require(\'fs\').existsSync(\'bad2.txt\')?1:0)"'
    const first = world(t, [root(), lfNode('a', {
      locus: ['src/a.mjs', 'test/a.test.mjs', 'ok1.txt', 'bad2.txt'],
      acceptance: [{ text: 'ok1 exists', check: ok1, decisions: ['D1'] }, { text: 'bad2 is absent', check: bad2, decisions: ['D1'] }],
    })])
    const o = open(first, 'a')
    const one = commit(o.worktree, A_FILES, 'Add a')
    const r1 = await run(first, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    const later = elsewhere(first)
    commit(o.worktree, { 'bad2.txt': 'x\n' }, 'Break the second')
    const r2 = await run(later, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: one })
    assert.ok(claimsOf(r2.out).length > claimsOf(r1.out).length, 'round 2 keeps the failure and adds one')
    assert.equal(r2.out.raise, true)
    assert.equal(rec(later, 'a', 'implementer', 2).raise, true)
  })

  test('G7.3 a close run again under a new execution records no second breach_reverted for the node and sha', SLOW, async (t) => {
    const s = await outside(t)
    const reverted = recs(s.w, 'breach_reverted', 'a')
    assert.equal(reverted.length, 1)
    const later = elsewhere(s.w)
    const dispatch = stored(later, s.spec)
    const second = await close(later, { ...s.spec, dispatch })
    assert.equal(second.decision.next, s.first.decision.next)
    assert.deepEqual(recs(later, 'breach_reverted', 'a'), [])
    assert.deepEqual(recs(s.w, 'breach_reverted', 'a'), reverted)
  })
})

// ================================================================== G8

describe('G8: [D4] held mutations and the audit gap across executions', { concurrency: 2 }, () => {
  test('G8.1 a close in a later execution applies a mutation an earlier execution applied that did not bite, beside its own', SLOW, async (t) => {
    const { w, o } = testsOnly(t)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST })
    const r1 = await run(w, { node: 't', role: 'test-author', round: 1, ret: { status: 'done', text: 'one', commit: 'Test add', mutations: [ADD_BITE, ADD_SURVIVES] }, base_sha: o.base_sha })
    assert.equal(r1.out.decision.next, 'fix', JSON.stringify(r1.out.decision))
    const later = elsewhere(w)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST + '// again\n' })
    await run(later, { node: 't', role: 'test-author', round: 2, ret: { status: 'done', text: 'two', commit: 'Test add again', mutations: [ADD_BITE_TOO] }, base_sha: o.base_sha, head_before: head(o.worktree) })
    const line = observed(later, 't').find((l) => l.head_sha === head(o.worktree))
    assert.ok(line, 'the later execution measured the head')
    const replaces = line.mutations.map((m) => m.replace)
    assert.ok(replaces.includes(ADD_SURVIVES.replace), 'the earlier mutation that got through is applied again: ' + replaces.join(', '))
    assert.ok(replaces.includes(ADD_BITE_TOO.replace), 'and so is the new one')
  })

  test('G8.2 an audit fix close in a later execution with no surviving mutation sends its failures to the red when an earlier execution let one through', SLOW, async (t) => {
    const c = cycle(t, { triad: true })
    const r1 = await run(c.w, { node: 'au', role: 'auditor', round: 1, thread: 'producer:au', ret: auditor([R_SURVIVES]), base_sha: c.audit.base_sha, head_before: c.audit.base_sha })
    assert.equal(r1.out.decision.next, 'fix', JSON.stringify(r1.out.decision))
    const later = elsewhere(c.w)
    write(c.audit.worktree, { 'test/r.test.mjs': R_TEST_TWO })
    // The thread is whatever the caller passed; the cycle's test session is picked from the records.
    const r2 = await run(later, { node: 'au', role: 'test-author', round: 2, thread: 'producer:au', ret: { status: 'done', text: 'a case more', commit: 'Pin r at 3', mutations: [R_STALE] }, base_sha: c.audit.base_sha, head_before: c.audit.base_sha })
    assert.equal(r2.out.decision.next, 'fix', JSON.stringify(r2.out.decision))
    assert.deepEqual(msgs(later, 'surviving_mutations', 'au').filter((m) => m.round === 3), [])
    const sent = msgs(later, 'failures', 'au')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].thread, 'producer:r')
  })
})
