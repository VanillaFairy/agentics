// test/boundaries-execution-preflight.test.mjs — lib/boundaries/execution.mjs in process, against
// real git and a real ledger: an execution's preflight: its refusals, the envelope, and the
// checkpoints and their confirmation.
//
// Every boundary takes an execution's context `xc` (`executionContext` over the execution's log
// port); a refusal is `{ok: false, error: {kind, message}}` and writes nothing. A new run of an
// execution is a fresh context whose log appends `run` first: what follows the latest `run` is the
// current run's. The 4.x courier is gone, so nothing here goes through argv or an envelope payload.
// The fixtures the parts share are in test/harness/execution-world.mjs.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#resume-and-checkpoints, docs/DESIGN.md#scheduling.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { preflight } from '../lib/boundaries/execution.mjs'
import { executionContext } from '../lib/boundaries/records.mjs'
import { append, executionLog } from '../lib/ledger.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { revParse, specPath } from '../lib/store.mjs'
import { trace } from '../lib/traceability.mjs'
import { addNodes, readTree } from '../lib/tree.mjs'
import { ensureIntegration } from '../lib/integration.mjs'
import { COMMANDS, STAMP, commitIn, git, leaf, root } from './harness/boundary-fixture.mjs'
import {
  E, STAMP2, ADD, world, ctxOf, commandsFile, envPath, envelopeOf, stateOf, journalOf, stateKind, head,
  NO_GAPS,
} from './harness/execution-world.mjs'

const STAMP3 = '20260925-140000'

const gapsOf = (r, folder = '.') => trace(readTree(r, E).nodes, folder).gaps

const WITH_GAPS = [root({ defines: [{ id: 'D1', text: 'x' }, { id: 'D2', text: 'y' }] }), leaf('a', { expects: [ADD] })]

// ------------------------------------------------------------------ preflight: refusals

test('preflight refuses unreadable when the effort tree cannot be read', async (t) => {
  const r = world(t, NO_GAPS)
  const cf = commandsFile(t)
  const xc = executionContext({ repo: r, effort: 'Not An Effort!', execution: STAMP, log: executionLog(r, E, STAMP) })
  for (const folder of ['.', 'nope']) {
    const out = await preflight(xc, { folder, commands_file: cf })
    assert.equal(out.ok, false)
    assert.equal(out.error.kind, 'unreadable', 'an unreadable tree is refused before any node is looked up (folder ' + folder + ')')
    assert.equal(typeof out.error.message, 'string')
  }
  assert.equal(existsSync(envPath(r)), false)
  assert.deepEqual(stateOf(r), [])
})

test('preflight refuses a folder the tree does not hold, no_such_node, writing nothing', async (t) => {
  const r = world(t, NO_GAPS)
  const out = await preflight(ctxOf(r, STAMP, { run: false }), { folder: 'nope', commands_file: commandsFile(t) })
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'no_such_node')
  assert.equal(typeof out.error.message, 'string')
  assert.equal(existsSync(envPath(r)), false)
  assert.deepEqual(stateOf(r), [])
  assert.deepEqual(journalOf(r), [])
})

test('preflight refuses an effort root that is a leaf, root_is_leaf', async (t) => {
  const r = world(t, [{ id: '.', kind: 'leaf', title: 'the change', rigor: 'tdd', expects: [ADD], decisions: [], acceptance: [{ text: 'it works', check: 'node --test', decisions: [] }] }])
  const xc = ctxOf(r, STAMP, { run: false })
  const out = await preflight(xc, { commands_file: commandsFile(t) })
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'root_is_leaf')
  assert.equal(typeof out.error.message, 'string')
  assert.equal(existsSync(envPath(r)), false)
  assert.deepEqual(stateOf(r), [])
  const first = await preflight(xc, { base_ref: 'no-such-branch', commands_file: join(tmpdir(), 'agentics-no-such-commands.json') })
  assert.equal(first.error.kind, 'root_is_leaf', 'the leaf root is refused before the envelope would be written')
})

test('preflight refuses a folder other than the one the execution recorded, wrong_root, naming that root', async (t) => {
  const r = world(t, [root(), leaf('zeta', { expects: [ADD] }), leaf('b', { expects: ['README.md'] })])
  const cf = commandsFile(t)
  assert.equal((await preflight(ctxOf(r), { folder: 'zeta', commands_file: cf })).ok, true)
  const before = readFileSync(envPath(r), 'utf8')

  const xc = ctxOf(r)
  const wrong = await preflight(xc, { folder: '.', commands_file: cf })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.error.kind, 'wrong_root')
  assert.ok(wrong.error.message.includes('zeta'), 'the message names the root the execution recorded: ' + wrong.error.message)
  assert.equal(envelopeOf(r).root, 'zeta')
  assert.equal(readFileSync(envPath(r), 'utf8'), before)

  const missing = await preflight(xc, { folder: 'nope', commands_file: cf })
  assert.equal(missing.error.kind, 'no_such_node', 'a folder that is no node is refused before its root is compared')
  const both = await preflight(xc, { folder: '.', base_ref: 'no-such-branch', commands_file: join(tmpdir(), 'agentics-no-such-commands.json') })
  assert.equal(both.error.kind, 'wrong_root', 'wrong_root comes before no_base and commands_unreadable')
})

test('preflight refuses a commands file it cannot read, commands_unreadable, writing no envelope', async (t) => {
  const r = world(t, NO_GAPS)
  const missing = join(mkdtempSync(join(tmpdir(), 'agentics-nofile-')), 'commands.json')
  t.after(() => rmSync(join(missing, '..'), { recursive: true, force: true }))
  for (const commands_file of [missing, commandsFile(t, '{ this is not json', 'broken.json')]) {
    const out = await preflight(ctxOf(r, STAMP, { run: false }), { commands_file })
    assert.equal(out.ok, false)
    assert.equal(out.error.kind, 'commands_unreadable')
    assert.equal(typeof out.error.message, 'string')
    assert.equal(existsSync(envPath(r)), false)
    assert.deepEqual(stateOf(r), [])
  }
})

test('preflight refuses a base_ref that names no commit, no_base, writing no envelope', async (t) => {
  const r = world(t, NO_GAPS)
  const out = await preflight(ctxOf(r, STAMP, { run: false }), { base_ref: 'no-such-branch', commands_file: commandsFile(t) })
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'no_base')
  assert.equal(typeof out.error.message, 'string')
  assert.equal(existsSync(envPath(r)), false)
  assert.deepEqual(stateOf(r), [])
  const both = await preflight(ctxOf(r, STAMP, { run: false }), { base_ref: 'no-such-branch', commands_file: join(tmpdir(), 'agentics-no-such-commands.json') })
  assert.equal(both.error.kind, 'no_base', 'no_base comes before commands_unreadable')
})

// ------------------------------------------------------------------ preflight: the envelope

test('the first preflight writes the envelope from its arguments and the commands file', async (t) => {
  const r = world(t, NO_GAPS)
  const xc = ctxOf(r)
  const out = await preflight(xc, { folder: '.', dial: 'high', pace: 'fast', commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  assert.equal(out.checkpoint, null)
  const env = envelopeOf(r)
  assert.equal(env.stamp, STAMP)
  assert.equal(env.root, '.')
  assert.equal(env.base_branch, git(r, 'rev-parse', '--abbrev-ref', 'HEAD'))
  assert.equal(env.base_sha, head(r))
  assert.equal(env.dial, 'high')
  assert.equal(env.pace, 'fast')
  assert.deepEqual(env.commands, COMMANDS)
  assert.deepEqual(xc.envelope(), env, 'the context reads back what was written')
})

test('base_ref names the base branch and its head', async (t) => {
  const r = world(t, NO_GAPS)
  git(r, 'branch', 'release')
  commitIn(r, { 'docs/notes.md': 'ahead of release\n' }, 'Move main ahead')
  assert.notEqual(head(r, 'release'), head(r))
  const out = await preflight(ctxOf(r), { base_ref: 'release', commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  const env = envelopeOf(r)
  assert.equal(env.base_branch, 'release')
  assert.equal(env.base_sha, head(r, 'release'))
})

test('a later preflight adopts the envelope as written, whatever it is given', async (t) => {
  const r = world(t, NO_GAPS)
  const first = commandsFile(t, COMMANDS, 'first.json')
  assert.equal((await preflight(ctxOf(r), { folder: '.', dial: 'high', pace: 'fast', commands_file: first })).ok, true)
  const written = readFileSync(envPath(r), 'utf8')

  git(r, 'branch', 'other')
  commitIn(r, { 'docs/notes.md': 'the base moved\n' }, 'Move the base')
  const xc = ctxOf(r)
  const out = await preflight(xc, { folder: '.', dial: 'low', pace: 'frugal', base_ref: 'other', commands_file: commandsFile(t, { suite: 'other-suite' }, 'second.json') })
  assert.equal(out.ok, true)
  assert.equal(readFileSync(envPath(r), 'utf8'), written, 'execution.json is byte for byte as it was')
  assert.deepEqual(xc.envelope().commands, COMMANDS, "the first file's commands, not the second's")

  const careless = await preflight(ctxOf(r), { base_ref: 'no-such-branch', commands_file: join(tmpdir(), 'agentics-no-such-commands.json') })
  assert.equal(careless.ok, true, 'a base_ref and a commands file the envelope never reads are never refused')
  assert.equal(readFileSync(envPath(r), 'utf8'), written)
})

// ------------------------------------------------------------------ preflight: checkpoints

test('an open execution whose root contains this one checkpoints existing_execution, its executions on the line and its seq in the result', async (t) => {
  const r = world(t, NO_GAPS)
  const cf = commandsFile(t)
  assert.equal((await preflight(ctxOf(r, STAMP), { folder: '.', commands_file: cf })).checkpoint, null)
  const out = await preflight(ctxOf(r, STAMP2), { folder: 'a', commands_file: cf })
  assert.equal(out.ok, true)
  assert.equal(out.checkpoint.reason, 'existing_execution')
  const lines = stateKind(r, 'checkpoint', STAMP2)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].reason, 'existing_execution')
  assert.deepEqual(lines[0].executions.map(({ stamp, root: at }) => ({ stamp, root: at })), [{ stamp: STAMP, root: '.' }])
  assert.equal(typeof lines[0].detail, 'string')
  assert.equal(out.checkpoint.seq, lines[0].seq)
  assert.equal(out.checkpoint.detail, lines[0].detail)
  assert.equal(stateKind(r, 'checkpoint', STAMP).length, 0, 'the other execution is not written to')
})

test("an open execution beneath this one's root checkpoints existing_execution too", async (t) => {
  const r = world(t, NO_GAPS)
  const cf = commandsFile(t)
  assert.equal((await preflight(ctxOf(r, STAMP), { folder: 'a', commands_file: cf })).checkpoint, null)
  const out = await preflight(ctxOf(r, STAMP2), { folder: '.', commands_file: cf })
  assert.equal(out.checkpoint.reason, 'existing_execution')
  const [line] = stateKind(r, 'checkpoint', STAMP2)
  assert.deepEqual(line.executions.map(({ stamp, root: at }) => ({ stamp, root: at })), [{ stamp: STAMP, root: 'a' }])
  assert.equal(out.checkpoint.seq, line.seq)
})

test('a closed execution, or one on a disjoint subtree, checkpoints nothing', async (t) => {
  const r = world(t, NO_GAPS)
  const cf = commandsFile(t)
  const one = ctxOf(r, STAMP)
  assert.equal((await preflight(one, { folder: 'a', commands_file: cf })).checkpoint, null)
  const two = ctxOf(r, STAMP2)
  const disjoint = await preflight(two, { folder: 'b', commands_file: cf })
  assert.equal(disjoint.ok, true)
  assert.equal(disjoint.checkpoint, null, 'an open execution on a does not overlap one on b')
  assert.equal(stateKind(r, 'checkpoint', STAMP2).length, 0)

  one.log.append('closed', { status: 'done' })
  two.log.append('closed', { status: 'done' })
  const third = await preflight(ctxOf(r, STAMP3), { folder: '.', commands_file: cf })
  assert.equal(third.ok, true)
  assert.equal(third.checkpoint, null, 'both overlapping executions are closed')
  assert.equal(stateKind(r, 'checkpoint', STAMP3).length, 0)
})

test('a decision no child realises checkpoints blocking_gaps, the gaps on its line', async (t) => {
  const r = world(t, WITH_GAPS)
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  assert.equal(out.checkpoint.reason, 'blocking_gaps')
  const expected = gapsOf(r)
  assert.ok(expected.length > 0)
  const lines = stateKind(r, 'checkpoint')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].reason, 'blocking_gaps')
  assert.deepEqual(lines[0].gaps, expected)
  assert.equal(out.checkpoint.seq, lines[0].seq)
  assert.equal(out.checkpoint.detail, lines[0].detail)
})

test("a planner's folder edited past its preparation is planned again, so the decisions its children miss checkpoint nothing", async (t) => {
  const defines = [{ id: 'D1', text: 'x' }, { id: 'D2', text: 'y' }]
  const r = world(t, [root({ defines }), { id: 'p', kind: 'composite', title: 'p', author: 'planner', decisions: ['D1', 'D2'] },
    leaf('p/a', { expects: [ADD] }), leaf('b', { decisions: ['D2'], acceptance: [{ text: 'b works', check: 'node --test', decisions: ['D2'] }] })])
  mkdirSync(dirname(specPath(r, E, 'p')), { recursive: true })
  writeFileSync(specPath(r, E, 'p'), '# p\n')
  assert.equal(append(r, E, 'ledger', [{ kind: 'prepared', folder: 'p', hash: '00000000', review: 'x', by: 'planner' }]).ok, true)
  assert.deepEqual(gapsOf(r).map((g) => [g.decision, g.at]), [['D2', 'p']], 'the fixture: p hands D2 to no child')
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.checkpoint, null)

  assert.equal(append(r, E, 'ledger', [{ kind: 'prepared', folder: 'p', hash: hashSpec('# p\n'), review: 'y', by: 'planner' }]).ok, true)
  const prepared = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(prepared.checkpoint && prepared.checkpoint.reason, 'blocking_gaps', 'once its plan is prepared, the gap is its plan\'s')
})

test('an effort branch gone with merges recorded into it checkpoints integration_lost, naming where the merge is held, and is never cut again from base', async (t) => {
  const r = world(t, [root(), leaf('a', { expects: [ADD] })])
  // The effort's work, landed by hand into main; then the effort branch deleted.
  const merged = commitIn(r, { 'src/a.mjs': 'export const a = 1\n' }, 'the effort, merged by hand')
  const branch = 'agentics/' + E
  assert.equal(append(r, E, 'events', [{ kind: 'merged', node: 'a', execution: '', into: branch, merged_sha: merged, head_sha: merged }]).ok, true)
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.checkpoint && out.checkpoint.reason, 'integration_lost')
  assert.deepEqual(stateKind(r, 'checkpoint')[0].lost.map((l) => [l.branch, l.exists, l.merged_sha, l.reachable_from]), [[branch, false, merged, ['main']]])
  const cut = ensureIntegration(r, E, '.', envelopeOf(r))
  assert.equal(cut.ok, false, 'the branch is not cut again from base')
  assert.equal(revParse(r, 'refs/heads/' + branch), '')
})

test('preflight refuses a landed effort, landed, writing no envelope', async (t) => {
  const r = world(t, [root(), leaf('a', { expects: [ADD] })])
  assert.equal(append(r, E, 'events', [{ kind: 'landed', node: '.', execution: '', into: 'main', merged_sha: head(r), by: 'session' }]).ok, true)
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.error && out.error.kind, 'landed')
  assert.equal(existsSync(envPath(r)), false)
})

test('plan_only checkpoints parked', async (t) => {
  const r = world(t, NO_GAPS)
  const out = await preflight(ctxOf(r), { plan_only: true, commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  assert.equal(out.checkpoint.reason, 'parked')
  const lines = stateKind(r, 'checkpoint')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].reason, 'parked')
  assert.equal(out.checkpoint.seq, lines[0].seq)
})

test("confirmed equal to the latest checkpoint's seq passes it and records checkpoint-confirmed with its gaps", async (t) => {
  const r = world(t, WITH_GAPS)
  const cf = commandsFile(t)
  const first = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(first.checkpoint.reason, 'blocking_gaps')
  const [line] = stateKind(r, 'checkpoint')

  const second = await preflight(ctxOf(r), { confirmed: first.checkpoint.seq, commands_file: cf })
  assert.equal(second.ok, true)
  assert.equal(second.checkpoint, null)
  const confirmed = stateKind(r, 'checkpoint-confirmed')
  assert.equal(confirmed.length, 1)
  assert.ok(confirmed[0].seq > line.seq)
  assert.deepEqual(confirmed[0].gaps, line.gaps)
  assert.equal(stateKind(r, 'checkpoint').length, 1, 'the checkpoint is not raised again')
})

test("a confirmed naming an older checkpoint's seq passes it while the gaps it found stand", async (t) => {
  const r = world(t, WITH_GAPS)
  const cf = commandsFile(t)
  const first = await preflight(ctxOf(r), { commands_file: cf })
  const second = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(second.checkpoint.reason, 'blocking_gaps')
  assert.ok(second.checkpoint.seq > first.checkpoint.seq, 'a run that confirmed nothing checkpoints afresh')
  assert.equal(stateKind(r, 'checkpoint').length, 2)

  const third = await preflight(ctxOf(r), { confirmed: first.checkpoint.seq, commands_file: cf })
  assert.equal(third.checkpoint, null)
  assert.deepEqual(stateKind(r, 'checkpoint-confirmed').map((c) => c.reason), ['blocking_gaps'])
})

test('a confirmation made in a new execution passes the checkpoint an earlier one stopped at, until its gaps change', async (t) => {
  const r = world(t, [root({ defines: [{ id: 'D1', text: 'x' }, { id: 'D2', text: 'y' }, { id: 'D3', text: 'z' }] }), leaf('a', { expects: [ADD] })])
  const cf = commandsFile(t)
  const one = ctxOf(r, STAMP)
  const first = await preflight(one, { commands_file: cf })
  assert.equal(first.checkpoint.reason, 'blocking_gaps')
  one.log.append('closed', { status: 'done' })

  const two = ctxOf(r, STAMP2)
  const second = await preflight(two, { confirmed: first.checkpoint.seq, commands_file: cf })
  assert.equal(second.ok, true)
  assert.equal(second.checkpoint, null, 'the confirmation names the checkpoint the closed execution stopped at')
  assert.equal(stateKind(r, 'checkpoint', STAMP2).length, 0)
  const [confirmation] = stateKind(r, 'checkpoint-confirmed', STAMP2)
  assert.deepEqual(confirmation.gaps, stateKind(r, 'checkpoint', STAMP)[0].gaps)
  two.log.append('closed', { status: 'done' })

  const three = ctxOf(r, STAMP3)
  assert.equal((await preflight(three, { commands_file: cf })).checkpoint, null, 'a later execution over the same gaps is not stopped again')
  three.log.append('closed', { status: 'done' })

  const added = addNodes(r, E, [leaf('b', { expects: ['README.md'], decisions: ['D2'], acceptance: [{ text: 'b works', check: 'node --test', decisions: ['D2'] }] })])
  assert.equal(added.ok, true, JSON.stringify(added.problems))
  const changed = await preflight(ctxOf(r, '20260925-150000'), { commands_file: cf })
  assert.equal(changed.checkpoint.reason, 'blocking_gaps', 'gaps that changed are not what the user confirmed')
})

test('a confirmed seq that is no checkpoint line passes nothing', async (t) => {
  const r = world(t, WITH_GAPS)
  const cf = commandsFile(t)
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).checkpoint.reason, 'blocking_gaps')

  const xc = ctxOf(r)
  const [runLine] = stateKind(r, 'run').slice(-1)
  const onRun = await preflight(xc, { confirmed: runLine.seq, commands_file: cf })
  assert.equal(onRun.checkpoint.reason, 'blocking_gaps', 'the seq of a run line confirms nothing')
  const nowhere = await preflight(ctxOf(r), { confirmed: 999999, commands_file: cf })
  assert.equal(nowhere.checkpoint.reason, 'blocking_gaps', 'a seq no line holds confirms nothing')
  assert.equal(stateKind(r, 'checkpoint-confirmed').length, 0)
})

test('a checkpoint once confirmed is not raised again by a later run of the execution', async (t) => {
  const r = world(t, WITH_GAPS)
  const cf = commandsFile(t)
  const first = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal((await preflight(ctxOf(r), { confirmed: first.checkpoint.seq, commands_file: cf })).checkpoint, null)
  const later = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(later.ok, true)
  assert.equal(later.checkpoint, null)
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).checkpoint, null)
  assert.equal(stateKind(r, 'checkpoint').length, 1)
  assert.equal(stateKind(r, 'checkpoint-confirmed').length, 1)
})

test('checkpoints come one at a time: existing_execution first, blocking_gaps once it is confirmed', async (t) => {
  const r = world(t, [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'], defines: [{ id: 'D2', text: 'y' }] }, leaf('c/a', { expects: [ADD] })])
  const cf = commandsFile(t)
  await preflight(ctxOf(r, STAMP), { folder: '.', commands_file: cf })
  assert.ok(gapsOf(r, 'c').length > 0)

  const one = await preflight(ctxOf(r, STAMP2), { folder: 'c', commands_file: cf })
  assert.equal(one.checkpoint.reason, 'existing_execution')
  const two = await preflight(ctxOf(r, STAMP2), { folder: 'c', confirmed: one.checkpoint.seq, commands_file: cf })
  assert.equal(two.checkpoint.reason, 'blocking_gaps')
  assert.ok(two.checkpoint.seq > one.checkpoint.seq)
  const three = await preflight(ctxOf(r, STAMP2), { folder: 'c', confirmed: two.checkpoint.seq, commands_file: cf })
  assert.equal(three.checkpoint, null)

  const confirmed = stateKind(r, 'checkpoint-confirmed', STAMP2)
  assert.equal(confirmed.length, 2)
  assert.equal(Object.hasOwn(confirmed[0], 'gaps'), false, 'the first confirmation is the overlap, which names no gaps')
  assert.deepEqual(confirmed[1].gaps, stateKind(r, 'checkpoint', STAMP2).find((e) => e.reason === 'blocking_gaps').gaps)
})

test('plan_only checkpoints parked on every run, whatever is confirmed', async (t) => {
  const r = world(t, NO_GAPS)
  const cf = commandsFile(t)
  const first = await preflight(ctxOf(r), { plan_only: true, commands_file: cf })
  assert.equal(first.checkpoint.reason, 'parked')
  const second = await preflight(ctxOf(r), { plan_only: true, confirmed: first.checkpoint.seq, commands_file: cf })
  assert.equal(second.checkpoint.reason, 'parked')
  assert.ok(second.checkpoint.seq > first.checkpoint.seq, 'a new line for the new run')
  assert.equal(stateKind(r, 'checkpoint-confirmed').length, 0)
  assert.equal(stateKind(r, 'checkpoint').length, 2)

  const third = await preflight(ctxOf(r), { confirmed: second.checkpoint.seq, commands_file: cf })
  assert.equal(third.ok, true)
  assert.equal(third.checkpoint, null, 'without plan_only nothing is parked, and a parked seq confirms nothing')
  assert.equal(stateKind(r, 'checkpoint-confirmed').length, 0)
})

test('a preflight run again in the same run appends no second checkpoint and no second confirmation', async (t) => {
  const r = world(t, WITH_GAPS)
  const cf = commandsFile(t)
  const xc = ctxOf(r)
  const a = await preflight(xc, { commands_file: cf })
  const b = await preflight(xc, { commands_file: cf })
  assert.equal(a.checkpoint.reason, 'blocking_gaps')
  assert.equal(b.checkpoint.seq, a.checkpoint.seq)
  assert.equal(stateKind(r, 'checkpoint').length, 1)

  const next = ctxOf(r)
  assert.equal((await preflight(next, { confirmed: a.checkpoint.seq, commands_file: cf })).checkpoint, null)
  assert.equal((await preflight(next, { confirmed: a.checkpoint.seq, commands_file: cf })).checkpoint, null)
  assert.equal(stateKind(r, 'checkpoint-confirmed').length, 1)

  const parkedRun = ctxOf(r)
  const p = await preflight(parkedRun, { plan_only: true, commands_file: cf })
  const q = await preflight(parkedRun, { plan_only: true, commands_file: cf })
  assert.equal(p.checkpoint.reason, 'parked')
  assert.equal(q.checkpoint.seq, p.checkpoint.seq)
  assert.equal(stateKind(r, 'checkpoint').filter((e) => e.reason === 'parked').length, 1)
})
