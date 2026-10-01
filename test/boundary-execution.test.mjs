// test/boundary-execution.test.mjs — lib/boundary.mjs against real git: preflight, schedule, postflight and the
// session's own verbs over one execution.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { ARGS, land, launchRecords } from '../lib/boundary.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { heldBy } from '../lib/locks.mjs'
import { normalizeNode, readTree } from '../lib/tree.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { envelope, posix, specPath, worktreeOf } from '../lib/store.mjs'
import { checkpointOf } from '../lib/status.mjs'
import { A_TEST, B, COMMANDS, commitIn, git, leaf, repo, root, STAMP, wrote } from './harness/boundary-fixture.mjs'

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
  // The invocation dies here, before the close. The next one resumes the same execution.
  const again = B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.notEqual(again.invocation, first.invocation, 'each invocation is counted afresh')
  const tick = B(r, 'schedule', { running: [] })
  const next = Object.fromEntries(tick.launch.map((l) => [l.id, l.facts.next_action]))
  assert.deepEqual(next, { a: 'continue-series', b: 'code' })
  const a = tick.launch.find((l) => l.id === 'a').facts
  assert.equal(a.base_sha, open.base_sha, 'the fork point travels, so a salvaged close measures the right series')
  assert.equal(a.rounds, 1)
  assert.equal(a.brief_path, open.brief_path)
  assert.deepEqual(heldBy(r).slots, [], 'the dead invocation\'s slots were freed')
})

test('a leaf the ladder finds measured green, with no approval standing and no review loop of its own, is approved by the tick that launches it', () => {
  const nodes = new Map([['a', normalizeNode({ id: 'a', kind: 'leaf', rigor: 'tdd' })], ['p', normalizeNode({ id: 'p', kind: 'leaf', rigor: 'tdd-pair', role: 'red' })]])
  const facts = new Map([['a', { next_action: 'merge', head_sha: 'h1' }], ['p', { next_action: 'merge', head_sha: 'h2' }]])
  const launch = [{ unit: 'leaf', id: 'a' }, { unit: 'leaf', id: 'p' }]
  assert.deepEqual(launchRecords(launch, { nodes, events: [] }, facts, () => '').map((x) => x.entry),
    [{ kind: 'approved', node: 'a', head_sha: 'h1', review_rounds: 0, at_integration: true }], 'a leaf with a review loop of its own was approved by its review')
  const standing = [{ kind: 'approved', node: 'a', head_sha: 'h1', seq: 3 }]
  assert.deepEqual(launchRecords(launch, { nodes, events: standing }, facts, () => ''), [], 'an approval that stands is not recorded again')
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
  assert.deepEqual(JSON.parse(readFileSync(again.stale.record, 'utf8')), { kind: 'stale', now, nodes: ['a'] }, 'what rule-close reads back')
  const brief = readFileSync(again.stale.brief, 'utf8')
  assert.match(brief, /^# a — do a$/m, 'the leaf as planned is in the brief itself: the ruler opens nothing else')
  assert.ok(brief.includes('- a works — check: `node --test`') && brief.includes('- src/add.mjs'))
  assert.match(brief, /\+export const add = \(a, b\) => b \+ a/)
  assert.ok(!brief.includes('# b —'))

  append(r, 'e1', 'state:' + STAMP, { kind: 'stale-ruled', node: 'a', base_now: now, ruling: 'unaffected', why: 'same sum' })
  assert.equal(B(r, 'preflight', { root: '.', commands: COMMANDS }).stale, null, 'ruled once against this head, not asked again')
})

test('an affected ruling is an anchor only once something answers it on disk', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/add.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const now = commitIn(r, { 'src/add.mjs': 'export const add = (a, b) => b + a\n' }, 'Swap the operands')
  const ruled = B(r, 'preflight', { root: '.', commands: COMMANDS })
  const rulings = wrote({ rulings: [{ node: 'a', ruling: 'affected', why: 'the sum moved', question: 'keep the order?' }] })
  const out = B(r, 'rule-close', { kind: 'stale', record: ruled.stale.record, rulings_file: rulings })
  assert.deepEqual(out.replan.map((x) => [x.id, x.row.kind]), [['a', 'leaf']], 'an affected leaf goes to the planner')
  assert.match(readFileSync(out.replan[0].said, 'utf8'), /^keep the order\?\n\nthe sum moved/, 'the boundary writes the file the record points at')
  assert.deepEqual(B(r, 'preflight', { root: '.', commands: COMMANDS }).stale.nodes, ['a'], 'a replan that never came leaves the ruling unanswered')

  append(r, 'e1', 'events', { kind: 'parked', node: 'a', execution: STAMP, return: 'needs_decision', question: '' })
  append(r, 'e1', 'events', { kind: 'replanned', node: 'a', execution: STAMP, reason: 'answered', by: 'session' })
  assert.equal(B(r, 'preflight', { root: '.', commands: COMMANDS }).stale, null, 'a stop answered it: the head it was ruled at is the anchor')
  assert.equal(now, ruled.stale.now)
})

test('a fault the workflow names holds its node for the invocation, once, and gives back its slot', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1 })
  for (const _ of [1, 2]) {
    const tick = B(r, 'schedule', { running: [], fault: ['a:transport'] })
    assert.deepEqual(tick.stops, [{ id: 'a', status: 'held', reason: 'transport', said: '' }])
    assert.deepEqual(tick.launch.map((l) => l.id), ['b'], 'a held node is not launched again in this invocation')
  }
  assert.equal(readLog(r, 'e1', 'state:' + STAMP).entries.filter((e) => e.kind === 'fault').length, 1, 'recorded once')
  assert.deepEqual(heldBy(r).slots.filter((s) => s.node === 'a'), [])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.deepEqual(B(r, 'schedule', { running: [] }).launch.map((l) => l.id).sort(), ['a', 'b'], 'the next invocation takes it up')
})

test('a fault on a consumer whose drift was ruled affected and never answered parks it with the ruling', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  append(r, 'e1', 'state:' + STAMP, { kind: 'drift-ruled', node: 'a', contract: 'api', head_sha: 'h', ruling: 'affected', why: '', said: '/x/ruling.md' })
  const tick = B(r, 'postflight', { fault: ['a:dispatch'] })
  assert.deepEqual(tick.stops.map((s) => [s.id, s.status, s.reason, s.said]), [['a', 'held', 'dispatch', ''], ['a', 'parked', 'contract_drift', '/x/ruling.md']])
  assert.equal(readTree(r, 'e1').status.get('a').status, 'parked')
})

test('a leaf ruled against one base head is asked only about what moved after it', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/add.mjs'] }), leaf('b', { locus: ['README.md'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const n1 = commitIn(r, { 'src/add.mjs': 'export const add = (a, b) => b + a\n' }, 'Swap the operands')
  append(r, 'e1', 'state:' + STAMP, { kind: 'stale-ruled', node: 'a', base_now: n1, ruling: 'unaffected', why: 'same sum' })

  commitIn(r, { 'README.md': 'hello again\n' }, 'Greet again')
  assert.deepEqual(B(r, 'preflight', { root: '.', commands: COMMANDS }).stale.nodes, ['b'], 'a new head that leaves a\'s files alone does not reopen a')

  commitIn(r, { 'src/add.mjs': 'export const add = (a, b) => b + a + 0\n' }, 'Add nothing')
  const third = B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.deepEqual(third.stale.nodes, ['a', 'b'])
  const [ofA] = readFileSync(third.stale.brief, 'utf8').split('# b —')
  assert.match(ofA, /\+export const add = \(a, b\) => b \+ a \+ 0/)
  assert.ok(!ofA.includes('-export const add = (a, b) => a + b'), 'the change a was already ruled against is not shown again')
})

test('a base head the execution\'s own branch already merged is not a move under its leaves', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/add.mjs'] }), leaf('b', { locus: ['README.md'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  B(r, 'leaf-open', { node: 'b', role: 'implementer', round: 1 })
  const n1 = commitIn(r, { 'src/add.mjs': 'export const add = (a, b) => b + a\n' }, 'Swap the operands')
  git(worktreeOf(r, 'e1', '.'), 'merge', '-q', n1)
  assert.equal(B(r, 'preflight', { root: '.', commands: COMMANDS }).stale, null)

  commitIn(r, { 'src/add.mjs': 'export const add = (a, b) => b + a + 0\n' }, 'Add nothing')
  const later = B(r, 'preflight', { root: '.', commands: COMMANDS })
  assert.deepEqual(later.stale.nodes, ['a'])
  assert.ok(!readFileSync(later.stale.brief, 'utf8').includes('-export const add = (a, b) => a + b'), 'only what the branch does not hold yet')
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

test('an escalation decided again after a lost courier lands once, after a retry it lands again, and a composite escalation stops landing', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { rigor: 'trivial', locus: ['src/a.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  B(r, 'leaf-open', { node: 'c/a', role: 'implementer', round: 1 })
  const blocked = () => B(r, 'leaf-close', { node: 'c/a', role: 'implementer', round: 1, status: 'blocked', said: '/said/x.md' })
  blocked()
  blocked()
  const escalations = () => readLog(r, 'e1', 'events').entries.filter((e) => e.kind === 'escalated' && e.node === 'c/a')
  assert.equal(escalations().length, 1, 'a close sent again lands its record once')
  assert.equal(escalations()[0].said, '/said/x.md')
  B(r, 'preflight', { root: '.', commands: COMMANDS, retry: ['c/a'], confirmed_duplicate: true })
  assert.equal(readTree(r, 'e1').status.get('c/a').status, 'planned')
  blocked()
  assert.equal(escalations().length, 2, 'the same decision after a retry lands again')
  assert.equal(readTree(r, 'e1').status.get('c/a').status, 'escalated')

  append(r, 'e1', 'events', { kind: 'escalated', node: 'c', execution: STAMP, reason: 'merge_conflict', detail: '' })
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
  assert.equal(JSON.parse(readFileSync(byId.get('later').card, 'utf8')).title, 'later part', 'the title rides the card, never the payload')
  assert.equal(byId.get('a').row.author, 'you')
  assert.equal(JSON.parse(readFileSync(byId.get('a').card, 'utf8')).parent.spec_path, posix(specPath(r, 'e1', '.')))
})

test('a folder the user writes with nothing planned beneath it is parked for design, never launched to the planner', () => {
  const r = repo()
  assert.equal(seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs'] }), { id: 'mine', kind: 'design', title: 'my part', author: 'you' }]).ok, true)
  B(r, 'preflight', { root: '.', commands: COMMANDS, confirmed_gaps: true })
  const tick = B(r, 'schedule', { running: [] })
  assert.deepEqual(tick.launch.map((l) => l.id), ['a'])
  assert.deepEqual(tick.stops, [{ id: 'mine', status: 'parked', reason: 'needs_design', said: '' }])
  assert.match(readTree(r, 'e1').status.get('mine').last.question, /run the design skill on it/)
})

test('no argument a boundary takes shares a flag with the context every command carries', () => {
  for (const [name, spec] of Object.entries(ARGS)) {
    for (const key of ['repo', 'effort', 'execution', 'digest']) assert.ok(!(key in spec), name + ' takes --' + key + ', which the context already names')
  }
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
