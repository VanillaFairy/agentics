// test/boundary-execution.test.mjs — lib/boundary.mjs against real git: preflight, schedule, postflight and the
// session's own verbs over one execution.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { land } from '../lib/boundary.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { heldBy } from '../lib/locks.mjs'
import { readTree } from '../lib/tree.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { envelope, posix, specPath } from '../lib/store.mjs'
import { checkpointOf } from '../lib/status.mjs'
import { A_TEST, B, COMMANDS, commitIn, leaf, repo, root, STAMP } from './harness/boundary-fixture.mjs'

test('preflight checkpoints: an overlapping open execution, a blocking gap, a parked plan', () => {
  const r = repo()
  seedTree(r, 'e1', [root({ defines: [{ id: 'D1', text: 'x' }, { id: 'D2', text: 'y' }] }), leaf('a', { locus: ['src/a.mjs'] })])
  const gaps = B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.equal(gaps.checkpoint.reason, 'blocking_gaps')
  assert.deepEqual(checkpointOf(r, 'e1', STAMP).gaps.map((g) => g.decision), ['D2'], 'the list stays on disk for the session')

  const other = B(r, 'preflight', { root: 'a', commands: COMMANDS, confirmed_gaps: true }, '20260925-130000')
  assert.equal(other.checkpoint.reason, 'existing_execution', 'the first execution never closed and its root contains this one')
  const forced = B(r, 'preflight', { root: 'a', commands: COMMANDS, confirmed_duplicate: true, confirmed_gaps: true, plan_only: true }, '20260925-130000')
  assert.equal(forced.checkpoint.reason, 'parked')
})

test('resume: a preflight after a lost invocation names each leaf\'s next undone action', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] }), leaf('b', { rigor: 'trivial', locus: ['README.md'] })])
  const first = B(r, 'preflight', { root: '.', commands: COMMANDS })
  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1 })
  commitIn(open.worktree, { 'test/a.test.mjs': A_TEST, 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  B(r, 'leaf-close', { node: 'a', role: 'implementer', round: 1, base_sha: open.base_sha })
  // The invocation dies here. The next one resumes the same execution.
  const again = B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.notEqual(again.invocation, first.invocation, 'each invocation numbers its record ids afresh')
  const tick = B(r, 'schedule', { running: [] })
  const next = Object.fromEntries(tick.launch.map((l) => [l.id, l.facts.next_action]))
  assert.deepEqual(next, { a: 'merge', b: 'code' })
  const a = tick.launch.find((l) => l.id === 'a').facts
  assert.equal(a.base_sha, open.base_sha, 'the fork point travels, so a salvaged close measures the right series')
  assert.equal(a.rounds, 1)
  assert.equal(a.brief_path, open.brief_path)
  assert.deepEqual(heldBy(r).slots, [], 'the dead invocation\'s slots were freed')
})

test('a base that moved under a leaf is handed on for a ruling, never a checkpoint, and a ruling holds for that head', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/add.mjs'] }), leaf('b', { locus: ['README.md'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const now = commitIn(r, { 'src/add.mjs': 'export const add = (a, b) => b + a\n' }, 'Swap the operands')
  const again = B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.equal(again.checkpoint, null)
  assert.deepEqual(again.stale.nodes, ['a'])
  assert.equal(again.stale.now, now)
  assert.deepEqual(JSON.parse(readFileSync(again.stale.list, 'utf8')).leaves.map((l) => [l.node, l.writes]), [['a', ['src/add.mjs']]])
  assert.match(readFileSync(again.stale.diff, 'utf8'), /\+export const add = \(a, b\) => b \+ a/)

  append(r, 'e1', 'state:' + STAMP, { kind: 'stale-ruled', node: 'a', base_now: now, ruling: 'unaffected', why: 'same sum' })
  assert.equal(B(r, 'preflight', { root: '.', commands: COMMANDS }).stale, null, 'ruled once against this head, not asked again')
})

test('the session\'s retry clears a stop, so a running execution relaunches the node', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/add.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  append(r, 'e1', 'events', { kind: 'escalated', node: 'a', execution: STAMP, reason: 'blocked', detail: 'needs a key' })
  assert.equal(readTree(r, 'e1').status.get('a').status, 'escalated')
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../lib/boundary.mjs', import.meta.url)), 'retry',
    '--repo', r, '--effort', 'e1', '--execution', STAMP, '--node', 'a', '--node', 'nope'], { encoding: 'utf8' })
  assert.deepEqual(JSON.parse(run.stdout), { retried: ['a'], error: null })
  assert.notEqual(readTree(r, 'e1').status.get('a').status, 'escalated')
  assert.deepEqual(B(r, 'schedule', { running: [] }).launch.map((l) => l.id), ['a'])
})

test('the session\'s note is recorded on the node and changes no status', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/add.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  append(r, 'e1', 'events', { kind: 'escalated', node: 'a', execution: STAMP, reason: 'blocked', detail: 'needs a key' })
  const note = (...args) => JSON.parse(spawnSync(process.execPath, [fileURLToPath(new URL('../lib/boundary.mjs', import.meta.url)), 'note',
    '--repo', r, '--effort', 'e1', '--execution', STAMP, ...args], { encoding: 'utf8' }).stdout)

  assert.deepEqual(note('--node', 'a', '--text', ' the key is in the vault '), { noted: 'a', error: null })
  const noted = readTree(r, 'e1').events.filter((e) => e.kind === 'noted')
  assert.deepEqual(noted.map((e) => [e.node, e.execution, e.by, e.text]), [['a', STAMP, 'session', 'the key is in the vault']])
  assert.equal(readTree(r, 'e1').status.get('a').status, 'escalated')

  assert.match(note('--node', 'nope', '--text', 'x').error, /no live node/)
  assert.match(note('--node', 'a').error, /--text/)
  assert.equal(readTree(r, 'e1').events.filter((e) => e.kind === 'noted').length, 1)
})

test('an escalation repeated after a retry is recorded again, and a composite escalation stops landing', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { rigor: 'trivial', locus: ['src/a.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const esc = (rid) => ({ rid, file: 'events', entry: { kind: 'escalated', node: 'c/a', reason: 'blocked', detail: '' } })
  B(r, 'postflight', { records: [esc('1.1')] })
  B(r, 'postflight', { records: [esc('1.1')] })
  assert.equal(readLog(r, 'e1', 'events').entries.filter((e) => e.kind === 'escalated').length, 1, 'a record sent again lands once')
  B(r, 'preflight', { root: '.', commands: COMMANDS, retry_escalated: ['c/a'], confirmed_duplicate: true })
  assert.equal(readTree(r, 'e1').status.get('c/a').status, 'planned')
  B(r, 'postflight', { records: [esc('2.1')] })
  assert.equal(readTree(r, 'e1').status.get('c/a').status, 'escalated', 'the second occurrence landed in the ledger')

  B(r, 'postflight', { records: [{ rid: '2.2', file: 'events', entry: { kind: 'escalated', node: 'c', reason: 'merge_conflict', detail: '' } }] })
  assert.equal(readTree(r, 'e1').status.get('c').status, 'escalated')
  const check = land(r, 'e1', 'check')
  assert.ok(check.open_escalations.some((e) => e.node === 'c'))
})

test("a launch carries its node's row: author, spec path, and a leaf's parent", () => {
  const r = repo()
  assert.equal(seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs'] }), { id: 'later', kind: 'design', title: 'later part', author: 'planner' }]).ok, true)
  const pre = B(r, 'preflight', { root: '.', commands: COMMANDS, confirmed_gaps: true })
  assert.equal(pre.checkpoint, null, JSON.stringify(pre.checkpoint))
  const tick = B(r, 'schedule', { running: [] })
  const byId = new Map(tick.launch.map((l) => [l.id, l]))
  assert.equal(byId.get('later').unit, 'plan')
  assert.equal(byId.get('later').row.author, 'planner')
  assert.equal(byId.get('later').row.spec_path, posix(specPath(r, 'e1', 'later')))
  assert.equal(byId.get('a').row.author, 'you')
  assert.equal(byId.get('a').parent.spec_path, posix(specPath(r, 'e1', '.')))
})

test('no payload grows with the effort: preflight, schedule and postflight print the same size for 4 leaves and 200', () => {
  const sized = (folders, leavesPer) => {
    const r = repo()
    const nodes = [root()]
    for (let f = 0; f < folders; f++) {
      nodes.push({ id: 'f' + f, kind: 'composite', title: 'folder ' + f, decisions: ['D1'] })
      for (let l = 0; l < leavesPer; l++) nodes.push(leaf('f' + f + '/l' + l, { locus: ['src/f' + f + 'l' + l + '.mjs'] }))
    }
    assert.equal(seedTree(r, 'e1', nodes).ok, true)
    const printed = (name, args) => JSON.stringify(envelope(B(r, name, args))).length
    return {
      preflight: printed('preflight', { root: '.', commands: COMMANDS }),
      schedule: printed('schedule', { running: [] }),
      postflight: printed('postflight', {}),
    }
  }
  const small = sized(1, 4)
  const large = sized(20, 10)
  for (const name of Object.keys(small)) {
    assert.ok(large[name] - small[name] < 400, name + ': ' + small[name] + ' bytes for 4 leaves, ' + large[name] + ' for 200')
  }
})
