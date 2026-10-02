// test/boundary-leaf.test.mjs — lib/boundary.mjs against real git: a leaf from open to close.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { land } from '../lib/boundary.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { heldBy } from '../lib/locks.mjs'
import { addNodes, readTree } from '../lib/tree.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { branchExists, executionDir, worktreeOf } from '../lib/store.mjs'
import {
  A_TEST, B, BOUNDARY, CLEAN_REVIEW, COMMANDS, commitIn, git, leaf, repo, root, STAMP, wrote,
} from './harness/boundary-fixture.mjs'

test('a leaf from preflight to landing: open, measure, merge, close, land, clean up', () => {
  const r = repo()
  assert.equal(seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })]).ok, true)

  const pre = B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.equal(pre.ok, true, JSON.stringify(pre.error))
  assert.equal(pre.checkpoint, null)
  assert.ok(statSync(pre.said_dir).isDirectory(), 'the agents of the execution have somewhere to write what they say')
  assert.equal(JSON.parse(readFileSync(join(executionDir(r, 'e1', STAMP), 'execution.json'), 'utf8')).base_branch, 'main')
  assert.deepEqual(pre.counts, { nodes: 2, leaves: 1, gaps: 0, untraced: 0 })
  assert.ok(existsSync(join(executionDir(r, 'e1', STAMP), 'execution.json')))

  const tick = B(r, 'schedule', { running: [], planning: [] })
  assert.deepEqual(tick.launch.map((l) => [l.unit, l.id, l.facts && l.facts.next_action]), [['leaf', 'a', 'code']])
  const card = JSON.parse(readFileSync(tick.launch[0].card, 'utf8'))
  assert.deepEqual([card.title, card.parent.id], ['do a', '.'], 'what is not a handle is on the card')

  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1, tier: 'sonnet/high' })
  assert.equal(open.status, 'opened', JSON.stringify(open))
  assert.equal(open.branch, 'agentics/e1--a')
  assert.equal(open.worktree, worktreeOf(r, 'e1', 'a'))
  assert.ok(branchExists(r, 'agentics/e1'), 'the effort branch was cut lazily')
  assert.match(readFileSync(open.brief_path, 'utf8'), /a works/)
  const dispatched = readLog(r, 'e1', 'events').entries.find((e) => e.kind === 'dispatched')
  assert.deepEqual([dispatched.model, dispatched.effort], ['sonnet', 'high'])
  assert.equal(heldBy(r).slots.length, 1)

  commitIn(open.worktree, { 'test/a.test.mjs': A_TEST, 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  const close = B(r, 'leaf-close', {
    node: 'a', role: 'implementer', round: 1, status: 'done', base_sha: open.base_sha, dispatch: ['implementer:a#1=implementer/sonnet/high'],
  })
  const closed = JSON.parse(readFileSync(close.record, 'utf8'))
  assert.equal(close.decision.next, 'approve', JSON.stringify(close.decision) + '\n' + closed.measurement.notes)
  assert.equal(closed.measurement.suite, 'passed')
  assert.equal(closed.measurement.discriminator[0].failed_on_base, true)
  assert.equal(close.measurement, undefined, 'the measurement stays on disk; the courier carries the decision')
  assert.ok(readLog(r, 'e1', 'journal:' + STAMP).entries.some((e) => e.kind === 'verify-observed' && e.node === 'a'))
  const series = readLog(r, 'e1', 'journal:' + STAMP).entries.filter((e) => e.kind === 'series-done')
  assert.deepEqual(series.map((e) => [e.node, e.commits.map((c) => c.subject)]), [['a', ['Add a']]], 'the executor said done: its series, from git')
  assert.equal(readTree(r, 'e1').status.get('a').status, 'approved', 'the close recorded what it decided')
  assert.deepEqual(readLog(r, 'e1', 'state:' + STAMP).entries.filter((e) => e.kind === 'dispatch').map((e) => [e.label, e.node, e.role]),
    [['implementer:a#1', 'a', 'implementer']], 'and the cost line of the dispatch it closed')

  const ripe = B(r, 'schedule', { running: [] })
  assert.deepEqual(ripe.launch.map((l) => [l.unit, l.target]), [['merge', '.']])
  assert.deepEqual(JSON.parse(readFileSync(ripe.launch[0].card, 'utf8')).children, [{ id: 'a', head_sha: close.head_sha }])
  const merged = B(r, 'merge-batch', { target: '.', card: ripe.launch[0].card })
  assert.deepEqual(merged.merged.map((m) => m.id), ['a'])
  assert.deepEqual(merged.stops, [])
  assert.equal(merged.verified, true)
  assert.equal(readTree(r, 'e1').status.get('a').status, 'merged')
  assert.equal(readTree(r, 'e1').status.get('.').status, 'reviewing', 'merged children leave the root to its review')
  assert.deepEqual(heldBy(r).locus, [], 'the merge released the locus locks')

  const again = B(r, 'merge-batch', { target: '.', children: [{ id: 'a', head_sha: close.head_sha }], cycles: [] })
  assert.equal(again.head_sha, merged.head_sha, 'a re-run converges: nothing merged twice')

  const review = B(r, 'schedule', { running: [] })
  assert.deepEqual(review.launch.map((l) => [l.unit, l.id]), [['review', '.']])
  assert.equal(B(r, 'suite-gate', { target: '.' }).review, 'earned', 'the root\'s review is earned once something merged there')
  const folder = B(r, 'folder-review', { target: '.', card: review.launch[0].card, review_file: wrote(CLEAN_REVIEW) })
  assert.equal(folder.status, 'recorded')
  const post = B(r, 'postflight', {})
  assert.equal(post.closed, true)
  assert.equal(readTree(r, 'e1').status.get('.').status, 'integrated')
  assert.ok(readLog(r, 'e1', 'state:' + STAMP).entries.some((e) => e.kind === 'ended'), 'a watching session stops at postflight')
  assert.equal(post.summary.done, true)
  assert.equal(post.cleanup_n, 1)
  assert.equal(post.integration.branch, 'agentics/e1')
  assert.deepEqual(heldBy(r).slots, [])

  const check = land(r, 'e1', 'check')
  assert.deepEqual(check.open_escalations, [])
  assert.equal(check.drift.base_moved, false)
  const landed = land(r, 'e1', 'merge')
  assert.equal(landed.ok, true, landed.error)
  assert.ok(existsSync(join(r, 'src', 'a.mjs')), 'the user branch now has the work')
  assert.equal(readTree(r, 'e1').status.get('.').status, 'landed')
  assert.deepEqual(landed.removed.sort(), ['agentics/e1', 'agentics/e1--a'], 'the landing swept what it merged')
  assert.deepEqual(landed.kept, [])
  assert.equal(git(r, 'branch', '--list', 'agentics/*'), '')
})

test('a shell-less author: its locus files are committed, a stray file is reverted and reported', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('t', { rigor: 'tests-only', locus: ['test/more.test.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const open = B(r, 'leaf-open', { node: 't', role: 'test-author', round: 1 })
  writeFileSync(join(open.worktree, 'test', 'more.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/add.mjs'\ntest('adds negatives', () => assert.equal(add(-1, -2), -3))\n")
  writeFileSync(join(open.worktree, 'stray.txt'), 'oops\n')
  writeFileSync(open.report_path, [
    'Cases: adds negatives.',
    '```agentics-commit', 'Test add with negatives', '```',
    '```agentics-mutations', JSON.stringify([{ file: 'src/add.mjs', find: 'a + b', replace: 'a - b', expect_failing: ['test/more.test.mjs'] }]), '```',
  ].join('\n'))
  const close = B(r, 'leaf-close', { node: 't', role: 'test-author', round: 1, status: 'done', base_sha: open.base_sha })
  assert.equal(git(open.worktree, 'log', '-1', '--format=%s'), 'Test add with negatives')
  assert.equal(existsSync(join(open.worktree, 'stray.txt')), false)
  const { measurement, committed } = JSON.parse(readFileSync(close.record, 'utf8'))
  assert.equal(committed, true)
  assert.ok(measurement.series_findings.some((f) => f.check === 'locus-breach' && /stray\.txt/.test(f.message)))
  assert.equal(measurement.mutations[0].bites, true)
  assert.equal(close.decision.next, 'fix', 'the breach blocks, so the author gets a fix round')
  assert.ok(close.decision.failures_n > 0 && !('failures' in close.decision), 'only a count crosses the courier')
  const round2 = B(r, 'leaf-open', { node: 't', role: 'test-author', round: 2 })
  assert.match(readFileSync(round2.brief_path, 'utf8'), /## Fix round 2[\s\S]*\[verification\][\s\S]*stray\.txt/, 'the next round\'s brief carries the failure and its evidence from disk')
})

test('a shell-less author whose locus is a directory commits the files under it, none reverted', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('t', { rigor: 'tests-only', locus: ['test/'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const open = B(r, 'leaf-open', { node: 't', role: 'test-author', round: 1 })
  writeFileSync(join(open.worktree, 'test', 'more.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/add.mjs'\ntest('adds negatives', () => assert.equal(add(-1, -2), -3))\n")
  writeFileSync(open.report_path, [
    '```agentics-commit', 'Test add with negatives', '```',
    '```agentics-mutations', JSON.stringify([{ file: 'src/add.mjs', find: 'a + b', replace: 'a - b', expect_failing: ['test/more.test.mjs'] }]), '```',
  ].join('\n'))
  const close = B(r, 'leaf-close', { node: 't', role: 'test-author', round: 1, status: 'done', base_sha: open.base_sha })
  const { measurement, committed } = JSON.parse(readFileSync(close.record, 'utf8'))
  assert.equal(committed, true)
  assert.deepEqual(measurement.series_findings, [])
  assert.equal(close.decision.next, 'approve', JSON.stringify(close.decision))
})

test('a red/green cycle: green is cut from red, measured on red\'s tests, and the pair merges through its tip', () => {
  const r = repo()
  seedTree(r, 'e1', [root(),
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], locus: ['src/r.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })

  const red = B(r, 'leaf-open', { node: 'r', role: 'test-author', round: 1 })
  writeFileSync(join(red.worktree, 'test', 'r.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('r is 2', async () => { const { r } = await import('../src/r.mjs'); assert.equal(r(), 2) })\n")
  writeFileSync(red.report_path, '```agentics-commit\nPin r\n```\n')
  const redClose = B(r, 'leaf-close', { node: 'r', role: 'test-author', round: 1, status: 'done', base_sha: red.base_sha })
  assert.equal(redClose.decision.next, 'review', JSON.stringify(redClose.decision))
  assert.equal(B(r, 'leaf-review', { node: 'r', round: 1, review_round: 1, review_file: wrote(CLEAN_REVIEW) }).decision.next, 'approve')

  const ready = B(r, 'schedule', { running: [] })
  assert.deepEqual(ready.launch.map((l) => [l.unit, l.id]), [['leaf', 'g']], 'green launches once red is approved; red waits for its cycle')
  const green = B(r, 'leaf-open', { node: 'g', role: 'implementer', round: 1 })
  assert.equal(green.base_sha, redClose.head_sha, 'green is cut from red\'s head')
  commitIn(green.worktree, { 'src/r.mjs': 'export const r = () => 2\n' }, 'Implement r')
  const greenClose = B(r, 'leaf-close', { node: 'g', role: 'implementer', round: 1, status: 'done', base_sha: green.base_sha })
  assert.equal(greenClose.decision.next, 'review', JSON.stringify(greenClose.decision) + readFileSync(greenClose.record, 'utf8'))
  assert.equal(B(r, 'leaf-review', { node: 'g', round: 1, review_round: 1, review_file: wrote(CLEAN_REVIEW) }).decision.next, 'approve')

  const whole = B(r, 'schedule', { running: [] })
  assert.deepEqual(whole.launch.map((l) => [l.unit, l.target]), [['merge', '.']])
  const batch = JSON.parse(readFileSync(whole.launch[0].card, 'utf8'))
  assert.deepEqual([batch.children, batch.cycles], [[{ id: 'r', head_sha: redClose.head_sha }, { id: 'g', head_sha: greenClose.head_sha }], [['r', 'g']]])
  const merged = B(r, 'merge-batch', { target: '.', card: whole.launch[0].card })
  assert.deepEqual(merged.merged.map((m) => m.id), ['r', 'g'])
  assert.equal(merged.verified, true)
})

test('a leaf review round: open findings reach the next brief, the next reviewer rules on them, and the approval lands once', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'], provides: [{ name: 'api', paths: ['src/a.mjs'] }] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1 })
  commitIn(open.worktree, { 'test/a.test.mjs': A_TEST, 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  const close = B(r, 'leaf-close', { node: 'a', role: 'implementer', round: 1, status: 'done', base_sha: open.base_sha })
  assert.equal(close.decision.next, 'review', 'a contract leaf buys a review loop of its own')

  const critical = { id: 'F1', severity: 'critical', claim: 'a ignores its input', evidence: 'src/a.mjs:1', failure_scenario: 'a(2) is 1' }
  const first = B(r, 'leaf-review', { node: 'a', round: 1, review_round: 1, review_file: wrote({ ...CLEAN_REVIEW, findings: [critical] }) })
  assert.deepEqual([first.decision.next, first.raise], ['fix', false])
  assert.deepEqual(JSON.parse(readFileSync(first.record, 'utf8')).open.map((f) => f.id), ['F1'], 'what the next reviewer rules on')
  const round2 = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 2 })
  assert.match(readFileSync(round2.brief_path, 'utf8'), /## Fix round 2[\s\S]*\[review critical F1\] a ignores its input[\s\S]*a\(2\) is 1/,
    'the finding reaches the fix round through its brief, never a prompt')

  const nothing = B(r, 'leaf-close', { node: 'a', role: 'implementer', round: 2, mode: 'fix', status: 'done', head_before: close.head_sha, base_sha: open.base_sha })
  assert.deepEqual(nothing.stops, [{ id: 'a', status: 'escalated', reason: 'fix_without_commits', said: '' }], 'a fix round that moved nothing returned no commits')
})

test('a leaf review that clears its blockers approves the leaf once, however often it is sent', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'], provides: [{ name: 'api', paths: ['src/a.mjs'] }] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1 })
  commitIn(open.worktree, { 'test/a.test.mjs': A_TEST, 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  B(r, 'leaf-close', { node: 'a', role: 'implementer', round: 1, status: 'done', base_sha: open.base_sha })
  const critical = { id: 'F1', severity: 'critical', claim: 'a ignores its input', evidence: 'src/a.mjs:1', failure_scenario: 'a(2) is 1' }
  B(r, 'leaf-review', { node: 'a', round: 1, review_round: 1, review_file: wrote({ ...CLEAN_REVIEW, findings: [critical] }) })
  const fixed = wrote({ ...CLEAN_REVIEW, fix_verdicts: [{ id: 'F1', status: 'fixed', evidence: 'src/a.mjs:1' }] })
  for (const _ of [1, 2]) assert.equal(B(r, 'leaf-review', { node: 'a', round: 2, review_round: 2, review_file: fixed }).decision.next, 'approve')
  const approvals = readLog(r, 'e1', 'events').entries.filter((e) => e.kind === 'approved')
  assert.deepEqual(approvals.map((e) => [e.node, e.review_rounds, e.at_integration]), [['a', 2, false]])
})

test('an executor\'s own return is recorded by the close that reads it: a park, an escalation, a dispatch that returned nothing', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'] }), leaf('c', { locus: ['src/c.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  for (const id of ['a', 'b', 'c']) B(r, 'leaf-open', { node: id, role: 'implementer', round: 1 })
  const said = wrote('which format?', 'said.md')
  const a = B(r, 'leaf-close', { node: 'a', role: 'implementer', round: 1, status: 'needs_decision', said })
  assert.deepEqual(a.stops, [{ id: 'a', status: 'parked', reason: 'needs_decision', said }])
  assert.equal(B(r, 'leaf-close', { node: 'b', role: 'implementer', round: 1, status: 'decompose', said }).decision.next, 'replan')
  const c = B(r, 'leaf-close', { node: 'c', role: 'implementer', round: 1, status: '' })
  assert.deepEqual(c.stops, [{ id: 'c', status: 'held', reason: 'dispatch', said: '' }])
  const tree = readTree(r, 'e1')
  assert.deepEqual(['a', 'b', 'c'].map((id) => tree.status.get(id).status), ['parked', 'active', 'active'], 'a fault and a replan are no stop')
  assert.equal(heldBy(r).slots.some((s) => s.node === 'c'), false, 'a fault gives its slot back')
})

test('a green is cut from its red and brought up to the parent head, so its other dependencies are there', () => {
  const r = repo()
  seedTree(r, 'e1', [root(),
    leaf('l', { rigor: 'trivial', locus: ['src/l.mjs'] }),
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r', 'l'], locus: ['src/r.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const red = B(r, 'leaf-open', { node: 'r', role: 'test-author', round: 1 })
  const redHead = commitIn(red.worktree, { 'test/r.test.mjs': "import { test } from 'node:test'\ntest('r', () => {})\n" }, 'Pin r')
  const l = B(r, 'leaf-open', { node: 'l', role: 'implementer', round: 1 })
  const ls = commitIn(l.worktree, { 'src/l.mjs': 'export const l = 1\n' }, 'Add l')
  B(r, 'merge-batch', { target: '.', children: [{ id: 'l', head_sha: ls }], cycles: [] })
  const green = B(r, 'leaf-open', { node: 'g', role: 'implementer', round: 1 })
  assert.ok(existsSync(join(green.worktree, 'src', 'l.mjs')), 'l merged before g was cut, so g builds on it')
  assert.ok(existsSync(join(green.worktree, 'test', 'r.test.mjs')), 'and on red\'s tests')
  assert.notEqual(redHead, green.base_sha)
})

test('a green opened again after its refresh names the same base, and the parent\'s commits stay out of its series', () => {
  const r = repo()
  seedTree(r, 'e1', [root(),
    leaf('l', { rigor: 'trivial', locus: ['src/l.mjs'] }),
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], locus: ['src/r.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const red = B(r, 'leaf-open', { node: 'r', role: 'test-author', round: 1 })
  const redHead = commitIn(red.worktree, { 'test/r.test.mjs': "import { test } from 'node:test'\ntest('r', () => {})\n" }, 'Pin r')
  const l = B(r, 'leaf-open', { node: 'l', role: 'implementer', round: 1 })
  const ls = commitIn(l.worktree, { 'src/l.mjs': 'export const l = 1\n' }, 'Add l')
  B(r, 'merge-batch', { target: '.', children: [{ id: 'l', head_sha: ls }], cycles: [] })

  const first = B(r, 'leaf-open', { node: 'g', role: 'implementer', round: 1 })
  const replay = B(r, 'leaf-open', { node: 'g', role: 'implementer', round: 1 })
  assert.equal(git(r, 'rev-parse', first.base_sha + '^1'), redHead, 'the base is the refresh merge on red\'s head')
  assert.equal(replay.base_sha, first.base_sha, 'the open run again after a lost courier names the same base')

  commitIn(replay.worktree, { 'src/r.mjs': 'export const r = () => 2\n' }, 'Implement r')
  const close = B(r, 'leaf-close', { node: 'g', role: 'implementer', round: 1, status: 'done', base_sha: replay.base_sha })
  const measurement = JSON.parse(readFileSync(close.record, 'utf8')).measurement
  assert.deepEqual(measurement.series_findings, [], 'l\'s commit and the merges are not g\'s work')
  const round2 = B(r, 'leaf-open', { node: 'g', role: 'implementer', round: 2 })
  assert.equal(round2.base_sha, first.base_sha, 'and a fix round measures from it too')
})

test('a leaf decomposed in place releases its claim: its children are not locked out by it', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { rigor: 'trivial', locus: ['src/a.mjs', 'src/b.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.equal(B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1 }).status, 'opened')
  const split = addNodes(r, 'e1', [
    { id: 'a', kind: 'composite', title: 'do a', decisions: ['D1'] },
    leaf('a/x', { rigor: 'trivial', locus: ['src/a.mjs'] }), leaf('a/y', { rigor: 'trivial', locus: ['src/b.mjs'] }),
  ], { by: 'planner', reason: 'decompose' })
  assert.equal(split.ok, true, JSON.stringify(split.problems))
  assert.equal(B(r, 'leaf-open', { node: 'a/x', role: 'implementer', round: 1, wait_ms: 2000 }).status, 'opened')
})

test('a dispatch lands whenever it is not the one the leaf already stands on', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { rigor: 'trivial', locus: ['src/a.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const open = (round) => assert.equal(B(r, 'leaf-open', { node: 'a', role: 'implementer', round }).status, 'opened')
  const rounds = () => readLog(r, 'e1', 'events').entries.filter((e) => e.kind === 'dispatched' && e.node === 'a').map((e) => e.round)

  open(1)
  open(1)
  assert.deepEqual(rounds(), [1], 'the same open run again after a lost courier lands once')

  open(2)
  assert.deepEqual(rounds(), [1, 2], 'a fix round is a dispatch of its own')

  assert.equal(append(r, 'e1', 'events', [{ kind: 'replanned', node: 'a', execution: STAMP, reason: 'retry_escalated', by: 'session' }]).ok, true)
  assert.equal(readTree(r, 'e1').status.get('a').status, 'planned')
  open(1)
  assert.deepEqual(rounds(), [1, 2, 1])
  assert.equal(readTree(r, 'e1').status.get('a').status, 'active', 'a leaf opened again after a replan is at work')
})

test('concurrent leaf-opens under one fresh composite all open', async () => {
  const r = repo()
  seedTree(r, 'e1', [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] },
    ...['p', 'q', 's', 't'].map((id) => leaf('c/' + id, { rigor: 'trivial', locus: ['src/' + id + '.mjs'] }))])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const opens = await Promise.all(['p', 'q', 's', 't'].map((id) => new Promise((resolve) => {
    const child = spawn('node', [BOUNDARY, 'leaf-open', '--repo', r, '--effort', 'e1', '--execution', STAMP,
      '--node', 'c/' + id, '--role', 'implementer', '--round', '1'])
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('close', () => resolve(JSON.parse(out).payload.status))
  })))
  assert.deepEqual(opens, ['opened', 'opened', 'opened', 'opened'])
})

test('leaf-close never commits outside a linked worktree', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('t', { rigor: 'tests-only', locus: ['test/t.test.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  // The worktree path exists but is not a registered worktree: git -C would resolve to the user's repo.
  mkdirSync(worktreeOf(r, 'e1', 't'), { recursive: true })
  writeFileSync(join(r, 'staged.txt'), 'the user\'s staged work\n')
  git(r, 'add', 'staged.txt')
  const head = git(r, 'rev-parse', 'HEAD')
  B(r, 'leaf-close', { node: 't', role: 'test-author', round: 1, status: 'done', base_sha: head })
  assert.equal(git(r, 'rev-parse', 'HEAD'), head, 'the user\'s branch did not move')
})
