// test/execute-leaf-round.test.mjs — pins the leaf unit of the execute program (`runLeaf`): one
// leaf driven over the execution rig, with scripted agents, to approved, stopped or escalated in a
// round and its fix rounds.
//
// What is pinned here:
//
//   a round     opened by leaf-open and dispatched with what leaf-open gave (no brief, so the
//               waiting messages are delivered), closed by leaf-close against the head it first
//               opened on; the close's decision (approve, fix, stop); the fix rounds and their
//               messages; a retry the session cleared
//
// The rig, the scripted answers and the worlds the parts share are in
// test/harness/execute-leaf-world.mjs.
//
// Design: docs/DESIGN.md#executors-and-review.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { leafOpen } from '../lib/boundaries/leaf-open.mjs'
import { renderMessage } from '../lib/conversation.mjs'
import { attach } from '../lib/integration.mjs'
import { append } from '../lib/ledger.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import { producerTier, reviewerTier } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { readJson, returnPath, sessionOf, worktreeOf } from '../lib/store.mjs'
import {
  T, E, leafEntry, YARD, bLeaf, work, world, ofKind, messages, faultsOf, callsOf, startsOf, headOf, approvals,
  stepsOf, keyOf, nodeOf, roleOf, IMPL, REV, done, said, verdict,
} from './harness/execute-leaf-world.mjs'

// The rig does not clear NODE_TEST_CONTEXT, and a measurement's nested `node --test` that inherits
// it reports to this runner and exits 0, so every red or tdd test file would read as passing.
delete process.env.NODE_TEST_CONTEXT

// ------------------------------------------------------------------ one round

describe('the leaf unit', { concurrency: 4 }, () => {
  test('a leaf measured green with no review loop of its own is approved after one round', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [done()] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 1)
    assert.equal(out.review_rounds, 0)
    assert.equal(out.salvaged, false)
    const ok = approvals(w.rig)
    assert.equal(ok.length, 1)
    assert.equal(ok[0].head_sha, headOf(w.rig))
    assert.equal(callsOf(w.rig, 'reviewer').length, 0, 'no review loop: no reviewer')
    const opened = stepsOf(w.rig, 'opened:b:1')
    assert.equal(opened.length, 1, "the round's first open is journaled")
    assert.match(opened[0].value.base_sha, /^[0-9a-f]{40}$/)
    assert.match(opened[0].value.head_sha, /^[0-9a-f]{40}$/)
  })

  test("a round's dispatch carries leaf-open's role, thread, session, round, tier, permissions, cwd and brief", T, async (t) => {
    const w = world(t)
    const first = await leafOpen(w.xc, { node: 'b', intelligence: 'normal', sleep: w.ctx.sleep })
    assert.equal(first.status, 'opened')
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [done()] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'approved')
    const calls = callsOf(w.rig, 'implementer', 'b')
    assert.equal(calls.length, 1)
    const [call] = calls
    assert.equal(call.role.name, first.role)
    assert.equal(call.thread.key, first.thread)
    assert.equal(call.thread.session, sessionOf({ effort: E, execution: w.rig.stamp, node: first.owner, role: first.role, thread: first.thread, gen: 0 }))
    assert.equal(call.round, first.round)
    assert.equal(call.node, 'b')
    assert.deepEqual(call.tier, first.tier)
    assert.deepEqual(call.permissions, first.permissions)
    assert.equal(resolve(call.cwd), resolve(first.cwd))
    assert.deepEqual(call.schema, schemaOf('producer'))
    assert.equal(call.resume, false)
    assert.equal(call.brief, first.brief, "leaf-open's brief is the prompt: nothing waits on the thread")
    assert.equal(call.briefDigest, fnv1a(first.brief))
    assert.deepEqual(call.briefParts, first.brief_parts)
    const step = stepsOf(w.rig, 'opened:b:1')[0]
    assert.equal(step.value.base_sha, first.base_sha)
    assert.equal(step.value.head_sha, first.head_sha)
  })

  test("the dial reaches the producer's tier and the reviewer's", T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [done()], [REV(1)]: [verdict()] })
    const out = await w.run('b', { intelligence: 'low' })
    assert.equal(out.outcome, 'approved')
    const leaf = nodeOf(w.rig)
    const producerLow = producerTier(leaf, roleOf('implementer'), { intelligence: 'low' })
    const reviewerLow = reviewerTier(leaf, roleOf('reviewer'), { intelligence: 'low' })
    assert.notDeepEqual(producerLow, producerTier(leaf, roleOf('implementer'), { intelligence: 'normal' }), 'the dial is not vacuous for the producer')
    assert.notDeepEqual(reviewerLow, reviewerTier(leaf, roleOf('reviewer'), { intelligence: 'normal' }), 'the dial is not vacuous for the reviewer')
    assert.deepEqual(callsOf(w.rig, 'implementer')[0].tier, producerLow)
    assert.deepEqual(callsOf(w.rig, 'reviewer')[0].tier, reviewerLow)
  })

  test('a verify leaf is measured with no dispatch', T, async (t) => {
    const w = world(t, { leaves: [leafEntry('v', { rigor: 'verify', locus: [], check: 'node pass.mjs' })] })
    const out = await w.run('v')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 1)
    assert.equal(w.rig.calls.length, 0, 'nothing is dispatched')
    assert.equal(ofKind(w.rig, 'dispatched').length, 0)
    assert.equal(approvals(w.rig, 'v').length, 1)
  })

  test('a verify finding under a folder the user wrote parks it needs_respec', T, async (t) => {
    const w = world(t, { leaves: [leafEntry('v', { rigor: 'verify', locus: [], check: 'node check.mjs zz' })] })
    const out = await w.run('v')
    assert.equal(out.outcome, 'stopped')
    assert.equal(w.rig.calls.length, 0, 'nothing is dispatched')
    assert.deepEqual(ofKind(w.rig, 'escalated', 'v').map((e) => e.reason), ['verify_finding'])
    assert.deepEqual(ofKind(w.rig, 'parked', '.').map((e) => e.return), ['needs_respec'])
    assert.equal(approvals(w.rig, 'v').length, 0)
  })

  test('a leaf whose branch holds work from before this execution is reported salvaged', T, async (t) => {
    const w = world(t)
    const { rig } = w
    rig.git('branch', rig.branchOf('b'), rig.branchOf('.'))
    assert.equal(attach(rig.repo, rig.branchOf('b'), rig.worktreeOf('b')).ok, true)
    work(rig.worktreeOf('b'), { 'src/b2.txt': 'earlier\n' }, 'work of an earlier execution')
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    rig.script({ [IMPL]: [done()] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.salvaged, true)
  })

  // ------------------------------------------------------------------ fix rounds

  test('a verification failure sends the producer a fix round in its own session, carrying the failures', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'no\n' }, 'first try'))
    w.job('implementer|b#2', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'fix'))
    w.rig.script({ [IMPL]: [done(), done()] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 2)
    const sent = messages(w.rig, 'producer:b', 'failures')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].round, 2)
    assert.equal(sent[0].payload.source, 'verification')
    assert.ok(sent[0].payload.failures.length > 0)
    const [one, two] = startsOf(w.rig, 'implementer', 'b')
    assert.equal(two.round, 2)
    assert.equal(two.resume, true)
    assert.equal(two.thread.session, one.thread.session, "the fix round is in the producer's own session")
    assert.equal(two.brief, renderMessage({ msg: sent[0].msg, payload: sent[0].payload }))
    assert.deepEqual(two.carries, [sent[0].seq])
  })

  test('the same verification failure twice escalates verify_not_converging', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'no\n' }, 'first try'))
    w.job('implementer|b#2', (cwd) => work(cwd, { 'src/b.txt': 'no again\n' }, 'second try'))
    w.rig.script({ [IMPL]: [done(), done()] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'stopped')
    assert.equal(out.round, 2)
    assert.deepEqual(ofKind(w.rig, 'escalated', 'b').map((e) => e.reason), ['verify_not_converging'])
    assert.equal(approvals(w.rig).length, 0)
  })

  test('a fix round with no commits escalates fix_without_commits', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'no\n' }, 'first try'))
    w.rig.script({ [IMPL]: [done(), done('nothing to do')] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'stopped')
    const stops = ofKind(w.rig, 'escalated', 'b')
    assert.deepEqual(stops.map((e) => e.reason), ['fix_without_commits'])
    const second = startsOf(w.rig, 'implementer', 'b')[1]
    assert.equal(stops[0].said, second.dispatch, "said names the fix round's dispatch")
    assert.equal(stops[0].said, keyOf('b', 'implementer', 'producer:b', 2))
  })

  test("a stop's said names the dispatch whose stored return holds the producer's words", T, async (t) => {
    const w = world(t)
    const WORDS = 'WHICH-FORMAT: json or yaml?'
    w.rig.script({ [IMPL]: [said('needs_decision', WORDS)] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'stopped')
    const parks = ofKind(w.rig, 'parked', 'b')
    assert.equal(parks.length, 1)
    assert.equal(parks[0].return, 'needs_decision')
    assert.equal(parks[0].said, keyOf('b', 'implementer', 'producer:b', 1))
    assert.equal(readJson(returnPath(w.rig.dir, parks[0].said)).text, WORDS)
    assert.equal(ofKind(w.rig, 'escalated', 'b').length, 0)
  })

  test("a retry after a dispatched round resumes the producer's session with the retried message, and the leaf goes on", T, async (t) => {
    const w = world(t)
    const NOTE = 'the format is json, go ahead'
    w.job('implementer|b#2', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'after the retry'))
    w.rig.script({ [IMPL]: [said('blocked', 'cannot tell the format'), done()] })
    const first = await w.run('b')
    assert.equal(first.outcome, 'stopped')
    assert.deepEqual(ofKind(w.rig, 'escalated', 'b').map((e) => e.reason), ['blocked'])
    // What the session's `note` and `retry` write.
    const wrote = append(w.rig.repo, E, 'events', [
      { kind: 'noted', node: 'b', execution: w.rig.stamp, by: 'session', text: NOTE },
      { kind: 'replanned', node: 'b', execution: w.rig.stamp, reason: 'retry_escalated', by: 'session' },
    ])
    assert.equal(wrote.ok, true, JSON.stringify(wrote))
    const second = await w.run('b')
    assert.equal(second.outcome, 'approved')
    assert.equal(second.round, 2)
    assert.equal(faultsOf(w.rig).length, 0)
    const retried = messages(w.rig, 'producer:b', 'retried')
    assert.equal(retried.length, 1)
    assert.equal(retried[0].round, 2)
    assert.deepEqual(retried[0].payload, { reason: 'blocked', notes: [NOTE] })
    const [one, two] = startsOf(w.rig, 'implementer', 'b')
    assert.equal(two.round, 2)
    assert.equal(two.resume, true)
    assert.equal(two.thread.session, one.thread.session)
    assert.equal(two.brief, renderMessage({ msg: 'retried', payload: retried[0].payload }))
    assert.deepEqual(two.carries, [retried[0].seq])
  })

  /** A leaf whose producer stopped `blocked`, then commits the session made on its branch by hand, a note and a retry. */
  async function byHand(t, files) {
    const w = world(t)
    w.rig.script({ [IMPL]: [said('blocked', 'git rm was denied'), done()] })
    assert.equal((await w.run('b')).outcome, 'stopped')
    const hand = work(worktreeOf(w.rig.repo, E, 'b'), files, 'finish b by hand')
    const wrote = append(w.rig.repo, E, 'events', [
      { kind: 'noted', node: 'b', execution: w.rig.stamp, by: 'session', text: 'committed the rest by hand' },
      { kind: 'replanned', node: 'b', execution: w.rig.stamp, reason: 'retry_escalated', by: 'session' },
    ])
    assert.equal(wrote.ok, true, JSON.stringify(wrote))
    return { w, hand }
  }

  test("a retry over commits the session made on the leaf's branch measures them, and no producer round runs", T, async (t) => {
    const { w, hand } = await byHand(t, { 'src/b.txt': 'ok\n' })
    const second = await w.run('b')
    assert.equal(second.outcome, 'approved', JSON.stringify(ofKind(w.rig, 'escalated', 'b')))
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 1, 'the round that stopped is the only producer round')
    assert.deepEqual(approvals(w.rig).map((e) => e.head_sha), [hand])
    assert.deepEqual(ofKind(w.rig, 'escalated', 'b').map((e) => e.reason), ['blocked'])
    assert.equal(faultsOf(w.rig).length, 0)
  })

  test('commits made by hand that fail their measurement send the next round its failures beside the retry', T, async (t) => {
    const { w, hand } = await byHand(t, { 'src/b.txt': 'not yet\n' })
    w.job('implementer|b#2', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'fix b'))
    const second = await w.run('b')
    assert.equal(second.outcome, 'approved', JSON.stringify(ofKind(w.rig, 'escalated', 'b')))
    const [, two] = startsOf(w.rig, 'implementer', 'b')
    assert.equal(two.round, 2)
    const carried = ofKind(w.rig, 'message', 'b').filter((m) => two.carries.includes(m.seq)).map((m) => m.msg)
    assert.deepEqual(carried.sort(), ['failures', 'retried'])
    assert.notEqual(headOf(w.rig), hand)
  })
})
