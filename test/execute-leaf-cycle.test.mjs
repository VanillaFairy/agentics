// test/execute-leaf-cycle.test.mjs — pins the leaf unit of the execute program (`runLeaf`): one
// leaf driven over the execution rig, with scripted agents, through a red-green cycle.
//
// What is pinned here:
//
//   a cycle    the cycle's test session: a green's needs_tests and tests_ready, a review that finds
//              a test gap, and the red's own session across the green's and the audit's rounds
//   consolidation  the round a cycle's approval opens: what lands when its tests still bite, and
//              when they do not
//
// The rig, the scripted answers and the worlds the parts share are in
// test/harness/execute-leaf-world.mjs.
//
// Design: docs/DESIGN.md#executors-and-review.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMessage } from '../lib/conversation.mjs'
import { attach } from '../lib/integration.mjs'
import {
  T, leafEntry, write, work, world, messages, startsOf, approvals, sessionFor, done, said, verdict, finding,
  fixed, headOf,
} from './harness/execute-leaf-world.mjs'

// The rig does not clear NODE_TEST_CONTEXT, and a measurement's nested `node --test` that inherits
// it reports to this runner and exits 0, so every red or tdd test file would read as passing.
delete process.env.NODE_TEST_CONTEXT

// ------------------------------------------------------------------ the cycle

const R_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { r } from '../src/r.mjs'\ntest('doubles 2', () => assert.equal(r(2), 4))\n"
const R_TEST_TWO = R_TEST + "test('doubles 3', () => assert.equal(r(3), 6))\n"
const R_TEST_FOUR = R_TEST_TWO + "test('doubles 5', () => assert.equal(r(5), 10))\n"
const R_SRC = 'export const r = (x) => x * 2\n'
const R_BITES = { file: 'src/r.mjs', find: 'x * 2', replace: 'x * 3', expect_failing: ['test/r.test.mjs'] }
/** Let through by the tests of R_TEST_TWO, caught by R_TEST_FOUR. */
const R_SURVIVES = { file: 'src/r.mjs', find: 'x * 2', replace: '(x > 4 ? x : x * 2)', expect_failing: ['test/r.test.mjs'] }

function cycleWorld(t, { triad = false } = {}) {
  const rigor = triad ? 'tdd-triad' : 'tdd-pair'
  return world(t, {
    leaves: [
      leafEntry('r', { rigor, role: 'red', expects: ['test/r.test.mjs'], check: 'node pass.mjs' }),
      leafEntry('g', { rigor, role: 'green', after: 'r', expects: ['src/r.mjs'], check: 'node pass.mjs' }),
      ...(triad ? [leafEntry('au', { rigor, role: 'audit', after: 'g', expects: ['docs/audit.md'], check: 'node pass.mjs' })] : []),
    ],
  })
}

/** The red approved without its own rounds: its branch cut from the effort branch, its test committed, `approved` appended. */
function seedRed(w, test = R_TEST) {
  const { rig } = w
  rig.git('branch', rig.branchOf('r'), rig.branchOf('.'))
  assert.equal(attach(rig.repo, rig.branchOf('r'), rig.worktreeOf('r')).ok, true)
  const head = work(rig.worktreeOf('r'), { 'test/r.test.mjs': test }, 'Pin r')
  rig.log.append('approved', { node: 'r', head_sha: head, review_rounds: 1, at_integration: false })
  return head
}

// ------------------------------------------------------------------ one round

describe('the leaf unit', { concurrency: 4 }, () => {

  // ------------------------------------------------------------------ a cycle

  test("a green whose review finds a test gap gets a test-author round on the cycle's test session", T, async (t) => {
    const w = cycleWorld(t)
    seedRed(w)
    w.job('implementer|g#1', (cwd) => work(cwd, { 'src/r.mjs': R_SRC }, 'implement r'))
    w.job('test-author|g#2', (cwd) => write(cwd, { 'test/r.test.mjs': R_TEST_TWO }))
    w.rig.script({
      'implementer|g|producer:g': [done()],
      'reviewer|g|reviewer:g:1': [verdict({ findings: [finding('R1', { remedy: 'tests' })] })],
      'test-author|g|producer:r': [done('pinned doubles 3', { mutations: [R_BITES] }), done('nothing to consolidate')],
      'reviewer|g|reviewer:g:2': [verdict({ fix: [fixed('R1')] })],
    })
    const out = await w.run('g')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 3, 'the review approved round 2; round 3 is the consolidation')
    assert.equal(out.review_rounds, 2)
    assert.equal(startsOf(w.rig, 'implementer', 'g').length, 1, 'its implementer ran once')
    const authors = startsOf(w.rig, 'test-author', 'g')
    assert.equal(authors.length, 2)
    assert.equal(authors[0].round, 2)
    assert.equal(authors[0].thread.key, 'producer:r')
    assert.equal(authors[0].thread.session, sessionFor(w.rig, { node: 'r', role: 'test-author', thread: 'producer:r', gen: 0 }), "the red's generation-0 session")
    const sent = messages(w.rig, 'producer:r', 'findings')
    assert.equal(sent.length, 1)
    assert.ok(authors[0].brief.includes(renderMessage({ msg: 'findings', payload: sent[0].payload })), 'the test round carries the finding')
    assert.equal(approvals(w.rig, 'g').length, 1)
  })

  test("a green's needs_tests goes to the cycle's test session, and tests_ready comes back to the implementer", T, async (t) => {
    const w = cycleWorld(t)
    seedRed(w)
    const ASK = 'r is doubled for 2 only; only a test can pin 3'
    w.job('implementer|g#1', (cwd) => work(cwd, { 'src/r.mjs': R_SRC }, 'implement r'))
    w.job('test-author|g#2', (cwd) => write(cwd, { 'test/r.test.mjs': R_TEST_TWO }))
    w.job('implementer|g#3', (cwd) => work(cwd, { 'src/r.mjs': R_SRC + '// round three\n' }, 'answer the finding'))
    w.rig.script({
      'implementer|g|producer:g': [said('needs_tests', ASK), done()],
      'test-author|g|producer:r': [done('pinned doubles 3', { mutations: [R_BITES] }), done('nothing to consolidate')],
      'reviewer|g|reviewer:g:1': [verdict({ findings: [finding('F1')] })],
      'reviewer|g|reviewer:g:2': [verdict({ fix: [fixed('F1')] })],
    })
    const out = await w.run('g')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 4, 'round 4 is the consolidation')
    const asked = messages(w.rig, 'producer:r', 'needs_tests')
    assert.equal(asked.length, 1)
    assert.equal(asked[0].round, 2)
    assert.equal(asked[0].payload.text, ASK)
    const [author] = startsOf(w.rig, 'test-author', 'g')
    assert.equal(author.round, 2)
    assert.equal(author.thread.key, 'producer:r')
    assert.ok(author.carries.includes(asked[0].seq), 'the test round carries the request')
    const ready = messages(w.rig, 'producer:g', 'tests_ready')
    assert.equal(ready.length, 1)
    assert.deepEqual(ready[0].payload.files, ['test/r.test.mjs'])
    const [one, three] = startsOf(w.rig, 'implementer', 'g')
    assert.equal(three.round, 3)
    assert.equal(three.resume, true)
    assert.equal(three.thread.session, one.thread.session, "the implementer's own session")
    assert.ok(three.carries.includes(ready[0].seq), 'round 3 carries tests_ready')
    assert.ok(three.brief.includes(renderMessage({ msg: 'tests_ready', payload: ready[0].payload })))
    assert.equal(approvals(w.rig, 'g').length, 1)
  })

  test("the cycle's test session is the red's own across the green's and the audit's rounds", T, async (t) => {
    const w = cycleWorld(t, { triad: true })
    w.job('test-author|r#1', (cwd) => write(cwd, { 'test/r.test.mjs': R_TEST }))
    w.job('implementer|g#1', (cwd) => work(cwd, { 'src/r.mjs': R_SRC }, 'implement r'))
    w.job('test-author|g#2', (cwd) => write(cwd, { 'test/r.test.mjs': R_TEST_TWO }))
    w.job('test-author|au#1', (cwd) => write(cwd, { 'test/r.test.mjs': R_TEST_FOUR }))
    w.rig.script({
      'test-author|r|producer:r': [done('red')],
      'reviewer|r|reviewer:r:1': [verdict()],
      'implementer|g|producer:g': [done()],
      'reviewer|g|reviewer:g:1': [verdict({ findings: [finding('R1', { remedy: 'tests' })] })],
      'test-author|g|producer:r': [done('doubles 3', { mutations: [R_BITES] })],
      'reviewer|g|reviewer:g:2': [verdict({ fix: [fixed('R1')] })],
      'test-author|au|producer:r': [done('doubles 5', { mutations: [] }), done('nothing to consolidate')],
      'reviewer|au|reviewer:au:1': [verdict()],
    })
    const red = await w.run('r')
    assert.equal(red.outcome, 'approved', JSON.stringify(red))
    const green = await w.run('g')
    assert.equal(green.outcome, 'approved', JSON.stringify(green))

    // The audit's test round without an auditor round: the record leaf-close would have left, and the message it would have sent.
    w.rig.log.append('verify-observed', { node: 'au', head_sha: '', mutations: [{ ...R_SURVIVES, applied: true, bites: false }] })
    const sent = w.rig.log.append('message', {
      node: 'au', thread: 'producer:r', from: 'code', msg: 'surviving_mutations', payload: { mutations: [R_SURVIVES] }, round: 1,
    }).seq
    const audit = await w.run('au')

    const session = sessionFor(w.rig, { node: 'r', role: 'test-author', thread: 'producer:r', gen: 0 })
    const [own] = startsOf(w.rig, 'test-author', 'r')
    assert.equal(own.thread.session, session)
    assert.equal(own.resume, false, "the red's first call starts the session")
    const [onGreen] = startsOf(w.rig, 'test-author', 'g')
    assert.equal(onGreen.thread.key, 'producer:r')
    assert.equal(onGreen.resume, true, "the green's test round resumes the red's session")
    assert.equal(onGreen.thread.session, session)
    const [onAudit] = startsOf(w.rig, 'test-author', 'au')
    assert.equal(onAudit.thread.key, 'producer:r')
    assert.equal(onAudit.resume, true, "the audit's test round resumes the red's session")
    assert.equal(onAudit.thread.session, session)
    assert.ok(onAudit.carries.includes(sent), 'and carries the surviving mutations')
    assert.equal(audit.outcome, 'approved', JSON.stringify(audit))
  })

  // ------------------------------------------------------------------ consolidation

  test("a cycle's approval opens one consolidation round, told what its judges asked to retire, and lands the leaner tests that still bite", T, async (t) => {
    const w = cycleWorld(t)
    seedRed(w, R_TEST_TWO)
    const RETIRE = 'doubles 3 repeats the claim doubles 2 owns'
    w.job('implementer|g#1', (cwd) => work(cwd, { 'src/r.mjs': R_SRC }, 'implement r'))
    w.job('test-author|g#2', (cwd) => write(cwd, { 'test/r.test.mjs': R_TEST }))
    w.rig.script({
      'implementer|g|producer:g': [done()],
      'reviewer|g|reviewer:g:1': [verdict({ findings: [finding('X1', { severity: 'critical', remedy: 'retire', claim: RETIRE })] })],
      'test-author|g|producer:r': [done('merged the doubling cases', { mutations: [R_BITES] })],
    })
    const out = await w.run('g')
    assert.equal(out.outcome, 'approved', JSON.stringify(out))
    assert.equal(out.review_rounds, 1, 'a retire request blocks nothing')
    const [asked] = messages(w.rig, 'producer:r', 'consolidate')
    assert.equal(asked.round, 2)
    assert.deepEqual(asked.payload.retire.map((r) => r.claim), [RETIRE])
    const [author] = startsOf(w.rig, 'test-author', 'g')
    assert.equal(author.thread.key, 'producer:r')
    assert.ok(author.carries.includes(asked.seq))
    const [approval] = approvals(w.rig, 'g')
    assert.equal(approval.head_sha, headOf(w.rig, 'g'))
    assert.equal(w.rig.git('show', approval.head_sha + ':test/r.test.mjs'), R_TEST.trim(), 'the consolidated tests land')
  })

  test('a consolidation that lets a break through is reverted, and the leaf lands the tests its review approved', T, async (t) => {
    const w = cycleWorld(t)
    seedRed(w, R_TEST_TWO)
    const BLIND = R_TEST.replace("test('doubles 2', () => assert.equal(r(2), 4))", "test('zero', () => assert.equal(r(0), 0))")
    w.job('implementer|g#1', (cwd) => work(cwd, { 'src/r.mjs': R_SRC }, 'implement r'))
    w.job('test-author|g#2', (cwd) => write(cwd, { 'test/r.test.mjs': BLIND }))
    w.rig.script({
      'implementer|g|producer:g': [done()],
      'reviewer|g|reviewer:g:1': [verdict()],
      'test-author|g|producer:r': [done('kept only zero', { mutations: [R_BITES] })],
    })
    const out = await w.run('g')
    assert.equal(out.outcome, 'approved', JSON.stringify(out))
    const [approval] = approvals(w.rig, 'g')
    assert.equal(approval.head_sha, headOf(w.rig, 'g'))
    assert.equal(w.rig.git('show', approval.head_sha + ':test/r.test.mjs'), R_TEST_TWO.trim(), 'the reviewed tests land')
    assert.match(w.rig.git('log', '-1', '--format=%s', approval.head_sha), /^Revert /, 'undone by a new commit, never rewritten')
  })
})
