// test/program-review-exit.test.mjs — pins the review program, the inline task's one independent
// reader: the exit computed from the reviewer's rulings and the prior round's, relaunch and the
// run's scope.
//
// The rig and the fixtures the parts share are in test/harness/review-world.mjs.
//
// Design: docs/DESIGN.md#the-simple-task, docs/DESIGN.md#execution-modes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { review } from '../lib/programs/review.mjs'
import { resultPath, runDir, writeJson } from '../lib/store.mjs'
import {
  sh, UNITS, write, reviewRig, ruled, returnOf, scriptOf, worktreeOf, listed, briefOf,
} from './harness/review-world.mjs'

const PRIOR = '20251231-000000-review'

const finding = (id, severity, claim = 'the loader drops a key (' + id + ')') =>
  ({ id, severity, claim, evidence: 'a.js:1', failure_scenario: 'load({A: 1}) returns {}' })

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
