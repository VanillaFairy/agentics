// test/boundaries-execution.test.mjs — lib/boundaries/execution.mjs in process, against real git and a
// real ledger: an execution's preflight (refusals, the envelope, checkpoints and their confirmation, a
// moved base, cleanup, the dispatches a dead run left open), its schedule (what launches, what it
// records before it returns) and its postflight (the summary, the close).
//
// Every boundary takes an execution's context `xc` (`executionContext` over the execution's log
// port); a refusal is `{ok: false, error: {kind, message}}` and writes nothing. A new run of an
// execution is a fresh context whose log appends `run` first: what follows the latest `run` is the
// current run's. The 4.x courier is gone, so nothing here goes through argv or an envelope payload.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#resume-and-checkpoints, docs/DESIGN.md#scheduling.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { postflight, preflight, schedule } from '../lib/boundaries/execution.mjs'
import { executionContext, fault, recordAll } from '../lib/boundaries/records.mjs'
import { guidanceOf } from '../lib/brief.mjs'
import { staleBrief } from '../lib/briefs/execute.mjs'
import { executionLog, readLog } from '../lib/ledger.mjs'
import { acquire, heldBy, maxParallel } from '../lib/locks.mjs'
import { branchExists, branchOf, configPath, executionDir, git as storeGit, posix, readConfig, stalePath, worktreeOf } from '../lib/store.mjs'
import { trace } from '../lib/traceability.mjs'
import { readTree } from '../lib/tree.mjs'
import { COMMANDS, STAMP, commitIn, git, leaf, repo, root } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const STAMP2 = '20260925-130000'
const STAMP3 = '20260925-140000'
const ADD = 'src/add.mjs'
const SWAPPED = 'export const add = (a, b) => b + a\n'
const SWAPPED_ZERO = 'export const add = (a, b) => b + a + 0\n'
const ORIGINAL_LINE = '-export const add = (a, b) => a + b'

// ------------------------------------------------------------------ the fixtures

/** A repository with a CLAUDE.md (so the guidance is not empty) and the tree `nodes` seeded. */
function world(t, nodes) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  commitIn(r, { 'CLAUDE.md': '# Rules\nKeep the change small.\n', '.gitignore': '.claude/\n.agentics/\n' }, 'Add guidance')
  const seeded = seedTree(r, E, nodes)
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems))
  return r
}

/** An execution's context. A new run of it is another call: its log appends `run` first. */
function ctxOf(r, stamp = STAMP, { run = true } = {}) {
  const log = executionLog(r, E, stamp)
  if (run) log.append('run', { program: 'execute', scope: { effort: E }, pid: 1 })
  return executionContext({ repo: r, effort: E, execution: stamp, log })
}

/** A commands file the session wrote, removed with the test. */
function commandsFile(t, value = COMMANDS, name = 'commands.json') {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-commands-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, name)
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
  return path
}

const envPath = (r, stamp = STAMP) => join(executionDir(r, E, stamp), 'execution.json')
const envelopeOf = (r, stamp = STAMP) => JSON.parse(readFileSync(envPath(r, stamp), 'utf8'))
const stateOf = (r, stamp = STAMP) => readLog(r, E, 'state:' + stamp).entries
const journalOf = (r, stamp = STAMP) => readLog(r, E, 'journal:' + stamp).entries
const stateKind = (r, kind, stamp = STAMP) => stateOf(r, stamp).filter((e) => e.kind === kind)
const eventsOf = (r, kind) => readLog(r, E, 'events').entries.filter((e) => e.kind === kind)
const head = (r, ref = 'HEAD') => git(r, 'rev-parse', ref)
const gapsOf = (r, folder = '.') => trace(readTree(r, E).nodes, folder).gaps
const worktreeList = (r) => git(r, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => posix(l.slice(9).trim()))

/** An execution's envelope written the way a first preflight writes it, for the boundaries after it. */
function envelopeFor(r, stamp = STAMP, rootId = '.') {
  mkdirSync(executionDir(r, E, stamp), { recursive: true })
  const env = { stamp, root: rootId, base_branch: 'main', base_sha: head(r), dial: 'normal', pace: 'balanced', commands: COMMANDS }
  writeFileSync(envPath(r, stamp), JSON.stringify(env, null, 1) + '\n')
}

const NO_GAPS = [root(), leaf('a', { locus: [ADD] }), leaf('b', { locus: ['README.md'] })]
const WITH_GAPS = [root({ defines: [{ id: 'D1', text: 'x' }, { id: 'D2', text: 'y' }] }), leaf('a', { locus: [ADD] })]

/** The stale brief the contract says preflight writes, from the pieces it names. */
function expectedBrief(r, now, items) {
  const tree = readTree(r, E)
  return staleBrief({
    nodes: items.map(({ node, anchor, writes, reads = [] }) => ({ node, anchor, writes, reads, entry: tree.nodes.get(node) })),
    base_now: now,
    diffs: Object.fromEntries(items.map(({ node, anchor, writes, reads = [] }) =>
      [node, storeGit(r, ['diff', anchor + '..' + now, '--', ...writes, ...reads]).stdout])),
    guidance: guidanceOf(r, { config: readConfig(r) }),
  })
}

/** A world whose first preflight already wrote the envelope at the repository's head. */
async function started(t, nodes = NO_GAPS) {
  const r = world(t, nodes)
  const cf = commandsFile(t)
  const base = head(r)
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(out.ok, true)
  assert.equal(out.checkpoint, null)
  return { r, cf, base }
}

/** The fields of a `verify-observed` line that measured a leaf green at `sha` (its `kind` is the port's). */
const greenFields = (id, sha) => ({
  node: id, branch: branchOf(E, id), worktree: '', base_sha: '', head_sha: sha,
  stop_reason: 'completed', build: 'passed', typecheck: 'absent', suite: 'passed', failing_tests: [],
  discriminator: [{ test_id: 'test/x.test.mjs', failed_on_base: true, passes_now: true }],
  mutations: [], series_findings: [], checks: [],
})

/** Leaf `id`'s branch under the root's integration branch, one commit on it, measured green there. Its head. */
function greenLeaf(r, xc, id, file) {
  if (!branchExists(r, branchOf(E, '.'))) git(r, 'branch', branchOf(E, '.'), 'HEAD')
  git(r, 'worktree', 'add', '-q', '-b', branchOf(E, id), worktreeOf(r, E, id), branchOf(E, '.'))
  const sha = commitIn(worktreeOf(r, E, id), { [file]: 'export const x = 1\n' }, 'feat(' + id + '): done')
  xc.log.append('verify-observed', greenFields(id, sha))
  return sha
}

const dispatchedFields = (dispatch, over = {}) =>
  ({ dispatch, node: 'a', round: 1, thread: 'a:implementer', role: 'implementer', session: 's-' + dispatch, pid: 0, ...over })

const ids = (launch) => launch.map((l) => l.unit + ':' + l.id)

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
  const r = world(t, [{ id: '.', kind: 'leaf', title: 'the change', rigor: 'tdd', locus: [ADD], decisions: [], acceptance: [{ text: 'it works', check: 'node --test', decisions: [] }] }])
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
  const r = world(t, [root(), leaf('zeta', { locus: [ADD] }), leaf('b', { locus: ['README.md'] })])
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

test('dial and pace default to normal and balanced, and the folder to the effort root', async (t) => {
  const r = world(t, NO_GAPS)
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  const env = envelopeOf(r)
  assert.equal(env.root, '.')
  assert.equal(env.dial, 'normal')
  assert.equal(env.pace, 'balanced')
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

test('a confirmed existing_execution is recorded with no gaps', async (t) => {
  const r = world(t, NO_GAPS)
  const cf = commandsFile(t)
  assert.equal((await preflight(ctxOf(r, STAMP), { folder: '.', commands_file: cf })).checkpoint, null)
  const first = await preflight(ctxOf(r, STAMP2), { folder: 'a', commands_file: cf })
  assert.equal(first.checkpoint.reason, 'existing_execution')

  const second = await preflight(ctxOf(r, STAMP2), { folder: 'a', confirmed: first.checkpoint.seq, commands_file: cf })
  assert.equal(second.checkpoint, null)
  const confirmed = stateKind(r, 'checkpoint-confirmed', STAMP2)
  assert.equal(confirmed.length, 1)
  assert.equal(Object.hasOwn(confirmed[0], 'gaps'), false)
})

test("a confirmed naming an older checkpoint's seq does not pass it", async (t) => {
  const r = world(t, WITH_GAPS)
  const cf = commandsFile(t)
  const first = await preflight(ctxOf(r), { commands_file: cf })
  const second = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(second.checkpoint.reason, 'blocking_gaps')
  assert.ok(second.checkpoint.seq > first.checkpoint.seq, 'a run that confirmed nothing checkpoints afresh')
  assert.equal(stateKind(r, 'checkpoint').length, 2)

  const third = await preflight(ctxOf(r), { confirmed: first.checkpoint.seq, commands_file: cf })
  assert.equal(third.checkpoint.reason, 'blocking_gaps')
  assert.ok(third.checkpoint.seq > second.checkpoint.seq)
  assert.equal(stateKind(r, 'checkpoint-confirmed').length, 0)
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
  const r = world(t, [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'], defines: [{ id: 'D2', text: 'y' }] }, leaf('c/a', { locus: [ADD] })])
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

// ------------------------------------------------------------------ preflight: a moved base

test('a base that moved under a leaf writes the stale brief and its record beside the state log, and no checkpoint', async (t) => {
  const { r, cf, base } = await started(t)
  const now = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(out.ok, true)
  assert.equal(out.checkpoint, null)
  assert.deepEqual(out.stale.nodes, ['a'], 'b files did not move')
  assert.equal(out.stale.now, now)
  assert.equal(posix(out.stale.brief), stalePath(r, E, STAMP, now))
  assert.equal(posix(out.stale.record), stalePath(r, E, STAMP, now).replace(/\.md$/, '.json'))
  assert.equal(readFileSync(out.stale.brief, 'utf8'), expectedBrief(r, now, [{ node: 'a', anchor: base, writes: [ADD] }]))
  const record = JSON.parse(readFileSync(out.stale.record, 'utf8'))
  assert.equal(record.now, now)
  assert.deepEqual(record.nodes, ['a'])
  assert.equal(stateKind(r, 'checkpoint').length, 0)
})

test('a moved base under a checkpoint writes no stale brief', async (t) => {
  const { r, cf } = await started(t)
  const now = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  const out = await preflight(ctxOf(r), { plan_only: true, commands_file: cf })
  assert.equal(out.checkpoint.reason, 'parked')
  assert.equal(out.stale, null)
  assert.equal(existsSync(stalePath(r, E, STAMP, now)), false)
  assert.equal(existsSync(stalePath(r, E, STAMP, now).replace(/\.md$/, '.json')), false)
})

test('a leaf ruled unaffected against a head is not asked again at that head', async (t) => {
  const { r, cf } = await started(t)
  const now = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  const xc = ctxOf(r)
  assert.deepEqual((await preflight(xc, { commands_file: cf })).stale.nodes, ['a'])
  xc.log.append('stale-ruled', { node: 'a', base_now: now, ruling: 'unaffected', why: 'same sum' })
  const again = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(again.checkpoint, null)
  assert.equal(again.stale, null)
})

test('an affected ruling anchors only once a stop or a replan answers it on disk', async (t) => {
  const { r, cf } = await started(t)
  const now = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  const xc = ctxOf(r)
  assert.deepEqual((await preflight(xc, { commands_file: cf })).stale.nodes, ['a'])
  xc.log.append('stale-ruled', { node: 'a', base_now: now, ruling: 'affected', why: 'the sum moved', question: 'keep the order?' })

  const unanswered = ctxOf(r)
  assert.deepEqual((await preflight(unanswered, { commands_file: cf })).stale.nodes, ['a'], 'a replan that never came leaves the ruling unanswered')

  unanswered.log.append('parked', { node: 'a', return: 'needs_decision', question: '' })
  unanswered.log.append('replanned', { node: 'a', reason: 'answered', by: 'session' })
  const answered = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(answered.stale, null, 'a stop and a replan answered it: the head it was ruled at is the anchor')
})

test('a leaf ruled against one base head is asked only about what moved after it', async (t) => {
  const { r, cf } = await started(t)
  const n1 = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  ctxOf(r).log.append('stale-ruled', { node: 'a', base_now: n1, ruling: 'unaffected', why: 'same sum' })

  commitIn(r, { 'README.md': 'hello again\n' }, 'Greet again')
  const second = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(second.stale.nodes, ['b'], "a new head that leaves a's files alone does not reopen a")

  const n3 = commitIn(r, { [ADD]: SWAPPED_ZERO }, 'Add nothing')
  const third = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual([...third.stale.nodes].sort(), ['a', 'b'])
  assert.equal(third.stale.now, n3)
  const brief = readFileSync(third.stale.brief, 'utf8')
  const diffFromRuled = storeGit(r, ['diff', n1 + '..' + n3, '--', ADD]).stdout.trimEnd()
  assert.ok(brief.includes(diffFromRuled), "a's block shows the change after the head it was ruled at")
  assert.ok(!brief.includes(ORIGINAL_LINE), 'the change a was already ruled against is not shown again')
})

test("a base head the execution's own branch already merged is not a move under its leaves", async (t) => {
  const r = world(t, NO_GAPS)
  const cf = commandsFile(t)
  git(r, 'worktree', 'add', '-q', '-b', branchOf(E, '.'), worktreeOf(r, E, '.'), 'HEAD')
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).ok, true)

  const n1 = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  git(worktreeOf(r, E, '.'), 'merge', '-q', n1)
  const merged = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(merged.checkpoint, null)
  assert.equal(merged.stale, null, 'the head the branch holds is the ground its leaves are cut from')

  const n2 = commitIn(r, { [ADD]: SWAPPED_ZERO }, 'Add nothing')
  const later = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(later.stale.nodes, ['a'])
  const brief = readFileSync(later.stale.brief, 'utf8')
  assert.ok(!brief.includes(ORIGINAL_LINE), 'only what the branch does not hold yet')
  assert.equal(brief, expectedBrief(r, n2, [{ node: 'a', anchor: n1, writes: [ADD] }]))
})

test('a stopped or merged leaf is not asked about a moved base', async (t) => {
  const nodes = [root(), ...['p', 'x', 'm', 'd'].map((id) => leaf(id, { locus: ['src/' + id + '.mjs'] }))]
  const { r, cf } = await started(t, nodes)
  const xc = ctxOf(r)
  xc.log.append('parked', { node: 'p', return: 'needs_decision', question: '' })
  xc.log.append('escalated', { node: 'x', reason: 'blocked', detail: '' })
  xc.log.append('merged', { node: 'm' })
  commitIn(r, Object.fromEntries(['p', 'x', 'm', 'd'].map((id) => ['src/' + id + '.mjs', 'export const v = 1\n'])), 'Touch every file')
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(out.stale.nodes, ['d'], 'only the planned leaf is asked')
  for (const id of ['p', 'x', 'm']) assert.ok(!readFileSync(out.stale.brief, 'utf8').includes('# ' + id + ' '), id + ' is not in the brief')

  const stopped = [root(), ...['p', 'x', 'm'].map((id) => leaf(id, { locus: ['src/' + id + '.mjs'] }))]
  const second = await started(t, stopped)
  const two = ctxOf(second.r)
  two.log.append('parked', { node: 'p', return: 'needs_decision', question: '' })
  two.log.append('escalated', { node: 'x', reason: 'blocked', detail: '' })
  two.log.append('merged', { node: 'm' })
  commitIn(second.r, Object.fromEntries(['p', 'x', 'm'].map((id) => ['src/' + id + '.mjs', 'export const v = 1\n'])), 'Touch every file')
  const none = await preflight(ctxOf(second.r), { commands_file: second.cf })
  assert.equal(none.stale, null)
})

test('a moved file a leaf only reads makes it stale, listed under its reads', async (t) => {
  const { r, cf, base } = await started(t, [root(), leaf('a', { locus: ['src/a.mjs'], reads: [ADD] })])
  const now = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(out.stale.nodes, ['a'])
  assert.equal(readFileSync(out.stale.brief, 'utf8'), expectedBrief(r, now, [{ node: 'a', anchor: base, writes: [], reads: [ADD] }]))
})

test("only the leaves of the execution's folder are asked about a moved base", async (t) => {
  const r = world(t, [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { locus: [ADD] }), leaf('d', { locus: ['README.md'] })])
  const cf = commandsFile(t)
  assert.equal((await preflight(ctxOf(r), { folder: 'c', commands_file: cf })).ok, true)
  commitIn(r, { [ADD]: SWAPPED, 'README.md': 'hello again\n' }, 'Touch both')
  const out = await preflight(ctxOf(r), { folder: 'c', commands_file: cf })
  assert.deepEqual(out.stale.nodes, ['c/a'], 'd is outside the folder this execution runs')
})

test('a ruling at a head outside the span from the held base to now anchors nothing', async (t) => {
  const { r, cf, base } = await started(t)
  const initial = git(r, 'rev-list', '--max-parents=0', 'HEAD')
  const side = join(mkdtempSync(join(tmpdir(), 'agentics-side-')), 'wt')
  t.after(() => rmSync(join(side, '..'), { recursive: true, force: true }))
  git(r, 'worktree', 'add', '-q', '-b', 'side', side, initial)
  const aside = commitIn(side, { [ADD]: 'export const add = () => 42\n' }, 'Diverge')
  const now = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  const xc = ctxOf(r)
  xc.log.append('stale-ruled', { node: 'a', base_now: aside, ruling: 'unaffected', why: 'elsewhere' })
  const out = await preflight(xc, { commands_file: cf })
  assert.deepEqual(out.stale.nodes, ['a'])
  assert.equal(readFileSync(out.stale.brief, 'utf8'), expectedBrief(r, now, [{ node: 'a', anchor: base, writes: [ADD] }]), 'the held base is the anchor')
})

test("the nearest integration branch of the folder decides what its leaves were cut from, not an ancestor's", async (t) => {
  const r = world(t, [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { locus: [ADD] })])
  const cf = commandsFile(t)
  const base = head(r)
  for (const id of ['.', 'c']) git(r, 'worktree', 'add', '-q', '-b', branchOf(E, id), worktreeOf(r, E, id), 'HEAD')
  assert.equal((await preflight(ctxOf(r), { folder: 'c', commands_file: cf })).ok, true)

  const now = commitIn(r, { [ADD]: SWAPPED }, 'Swap the operands')
  git(worktreeOf(r, E, '.'), 'merge', '-q', now)
  const out = await preflight(ctxOf(r), { folder: 'c', commands_file: cf })
  assert.deepEqual(out.stale.nodes, ['c/a'], "the root's branch holds the head, but c's branch, which its leaves are cut from, does not")
  assert.equal(readFileSync(out.stale.brief, 'utf8'), expectedBrief(r, now, [{ node: 'c/a', anchor: base, writes: [ADD] }]))

  git(worktreeOf(r, E, 'c'), 'merge', '-q', now)
  assert.equal((await preflight(ctxOf(r), { folder: 'c', commands_file: cf })).stale, null)
})

test('an integration branch that does not hold the envelope base is no ground for what moved', async (t) => {
  const r = world(t, NO_GAPS)
  const cf = commandsFile(t)
  const initial = git(r, 'rev-list', '--max-parents=0', 'HEAD')
  git(r, 'worktree', 'add', '-q', '-b', branchOf(E, '.'), worktreeOf(r, E, '.'), initial)
  const base = commitIn(r, { [ADD]: SWAPPED }, 'Settle the operands before the execution starts')
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).ok, true)
  assert.equal(envelopeOf(r).base_sha, base)

  const now = commitIn(r, { 'README.md': 'hello again\n' }, 'Greet again')
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(out.stale.nodes, ['b'], "a's file changed before the base, not since it")
  assert.equal(readFileSync(out.stale.brief, 'utf8'), expectedBrief(r, now, [{ node: 'b', anchor: base, writes: ['README.md'] }]))
})

// ------------------------------------------------------------------ preflight: cleanup

test("preflight frees this execution's slots and no other execution's", async (t) => {
  const r = world(t, NO_GAPS)
  assert.equal(acquire(r, { effort: E, execution: STAMP, node: 'a', locus: [ADD] }).ok, true)
  assert.equal(acquire(r, { effort: E, execution: STAMP2, node: 'b', locus: ['README.md'] }).ok, true)
  assert.equal(heldBy(r).slots.length, 2)
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  assert.deepEqual(heldBy(r).slots.map((s) => [s.execution, s.node]), [[STAMP2, 'b']])
})

/** A leaf `a` branch checked out in a worktree at `path`. */
const checkoutOf = (r, path) => git(r, 'worktree', 'add', '-q', '-b', branchOf(E, 'a'), path, 'HEAD')

test("a leftover worktree of the effort's branch away from its own path is removed, its branch kept", async (t) => {
  const r = world(t, NO_GAPS)
  const stray = join(r, '.claude', 'worktrees', 'stray')
  checkoutOf(r, stray)
  assert.ok(worktreeList(r).some((p) => p.endsWith('/.claude/worktrees/stray')))
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  assert.ok(!worktreeList(r).some((p) => p.endsWith('/.claude/worktrees/stray')), 'the leftover is gone from git worktree list')
  assert.deepEqual(out.dirty_worktrees, [])
  assert.equal(branchExists(r, branchOf(E, 'a')), true, 'the branch is kept')
})

test("a merged leaf's clean worktree is removed, its branch kept", async (t) => {
  const { r, cf } = await started(t)
  const own = worktreeOf(r, E, 'a')
  checkoutOf(r, own)
  ctxOf(r).log.append('merged', { node: 'a' })
  assert.ok(worktreeList(r).includes(posix(own)))
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(out.ok, true)
  assert.ok(!worktreeList(r).includes(posix(own)))
  assert.deepEqual(out.dirty_worktrees, [])
  assert.equal(branchExists(r, branchOf(E, 'a')), true)
})

test("an unmerged leaf's own worktree is kept", async (t) => {
  const { r, cf } = await started(t)
  const own = worktreeOf(r, E, 'a')
  checkoutOf(r, own)
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(out.ok, true)
  assert.ok(worktreeList(r).includes(posix(own)), 'a leaf at its own path is its work in progress')
  assert.deepEqual(out.dirty_worktrees, [])
})

test('a dirty leftover worktree is reported and left in place', async (t) => {
  const r = world(t, NO_GAPS)
  const stray = join(r, '.claude', 'worktrees', 'stray')
  checkoutOf(r, stray)
  writeFileSync(join(stray, 'unsaved.txt'), 'work in progress\n')
  const listed = worktreeList(r).find((p) => p.endsWith('/.claude/worktrees/stray'))
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  assert.deepEqual(out.dirty_worktrees.map(posix), [listed])
  assert.ok(worktreeList(r).includes(listed), 'a dirty checkout is never forced')
  assert.equal(existsSync(join(stray, 'unsaved.txt')), true)
})

test('a checkout of an effort branch outside .claude/worktrees is never touched', async (t) => {
  const r = world(t, NO_GAPS)
  const outside = join(mkdtempSync(join(tmpdir(), 'agentics-outside-')), 'mine')
  t.after(() => rmSync(join(outside, '..'), { recursive: true, force: true }))
  checkoutOf(r, outside)
  assert.ok(worktreeList(r).some((p) => p.endsWith('/mine')))
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  assert.ok(worktreeList(r).some((p) => p.endsWith('/mine')), 'it stays listed')
  assert.deepEqual(out.dirty_worktrees, [])
  assert.equal(existsSync(outside), true)
})

test('a worktree under .claude/worktrees on a branch that is not this effort\'s is left alone', async (t) => {
  const r = world(t, NO_GAPS)
  const kept = ['feature', 'other'].map((name) => join(r, '.claude', 'worktrees', name))
  git(r, 'worktree', 'add', '-q', '-b', 'feature/x', kept[0], 'HEAD')
  git(r, 'worktree', 'add', '-q', '-b', branchOf('e10', 'a'), kept[1], 'HEAD')
  const out = await preflight(ctxOf(r), { commands_file: commandsFile(t) })
  assert.equal(out.ok, true)
  const listed = worktreeList(r)
  assert.ok(listed.some((p) => p.endsWith('/.claude/worktrees/feature')), 'another branch is not the effort\'s')
  assert.ok(listed.some((p) => p.endsWith('/.claude/worktrees/other')), "effort e10's branch is not effort e1's")
  assert.deepEqual(out.dirty_worktrees, [])
})

// ------------------------------------------------------------------ preflight: what it reports

test('open_dispatches lists each dispatched with no returned and no host_stop after it', async (t) => {
  const { r, cf } = await started(t)
  const run = ctxOf(r)
  run.log.append('dispatched', dispatchedFields('d-a', { node: 'a', round: 2, thread: 'a:implementer', role: 'implementer' }))
  run.log.append('dispatched', dispatchedFields('d-b', { node: 'b' }))
  run.log.append('returned', { dispatch: 'd-b', session: 's-d-b', status: 'returned', cause: '' })
  run.log.append('dispatched', dispatchedFields('d-c', { node: 'b' }))
  run.log.append('host_stop', { dispatch: 'd-c', cause: 'rate_limit', until: '' })
  run.log.append('dispatched', dispatchedFields('d-e', { node: 'b', round: 3, thread: 'b:reviewer', role: 'reviewer' }))

  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(out.ok, true)
  const open = out.open_dispatches.map(({ dispatch, node, thread, role, round }) => ({ dispatch, node, thread, role, round }))
  assert.deepEqual(open, [
    { dispatch: 'd-a', node: 'a', thread: 'a:implementer', role: 'implementer', round: 2 },
    { dispatch: 'd-e', node: 'b', thread: 'b:reviewer', role: 'reviewer', round: 3 },
  ], 'in the order they were dispatched')
})

test('a dispatch started again after its host stop is open, once', async (t) => {
  const { r, cf } = await started(t)
  const run = ctxOf(r)
  run.log.append('dispatched', dispatchedFields('d-a', { round: 1 }))
  run.log.append('host_stop', { dispatch: 'd-a', cause: 'rate_limit', until: '' })
  run.log.append('dispatched', dispatchedFields('d-a', { round: 2 }))
  run.log.append('dispatched', dispatchedFields('d-r', { node: 'b', round: 1 }))
  run.log.append('returned', { dispatch: 'd-r', session: 's-d-r', status: 'returned', cause: '' })
  run.log.append('dispatched', dispatchedFields('d-r', { node: 'b', round: 2 }))

  const out = await preflight(ctxOf(r), { commands_file: cf })
  const open = out.open_dispatches.map(({ dispatch, round }) => ({ dispatch, round }))
  assert.deepEqual(open, [{ dispatch: 'd-a', round: 2 }, { dispatch: 'd-r', round: 2 }], 'each key once, at its latest dispatched')
})

test('preflight writes no invocation, usage or ended record', async (t) => {
  const r = world(t, WITH_GAPS)
  const cf = commandsFile(t)
  const first = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(first.checkpoint.reason, 'blocking_gaps')
  assert.equal((await preflight(ctxOf(r), { confirmed: first.checkpoint.seq, commands_file: cf })).checkpoint, null)
  const kinds = [...stateOf(r), ...journalOf(r), ...readLog(r, E, 'events').entries].map((e) => e.kind)
  for (const kind of ['invocation', 'usage', 'ended']) assert.ok(!kinds.includes(kind), 'a ' + kind + ' record was written')
})

test("counts are the subtree's nodes, leaves, gaps and untraced criteria, and max_parallel is the pool's", async (t) => {
  const r = world(t, [
    root({ defines: [{ id: 'D1', text: 'x' }, { id: 'D2', text: 'y' }] }),
    { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] },
    leaf('c/a', { locus: ['src/ca.mjs'] }),
    leaf('b', { locus: ['src/b.mjs'], acceptance: [{ text: 'b works', check: 'node --test', decisions: [] }] }),
  ])
  mkdirSync(join(configPath(r), '..'), { recursive: true })
  writeFileSync(configPath(r), JSON.stringify({ max_parallel: 3 }))
  const cf = commandsFile(t)

  const whole = trace(readTree(r, E).nodes, '.')
  assert.ok(whole.gaps.length > 0 && whole.untraced.length > 0)
  const out = await preflight(ctxOf(r, STAMP), { folder: '.', commands_file: cf })
  assert.equal(out.ok, true)
  assert.deepEqual({ nodes: out.counts.nodes, leaves: out.counts.leaves, gaps: out.counts.gaps, untraced: out.counts.untraced },
    { nodes: 4, leaves: 2, gaps: whole.gaps.length, untraced: whole.untraced.length })
  assert.equal(out.max_parallel, maxParallel(r))
  assert.equal(out.max_parallel, 3)

  const below = await preflight(ctxOf(r, STAMP2), { folder: 'c', commands_file: cf })
  assert.deepEqual({ nodes: below.counts.nodes, leaves: below.counts.leaves, gaps: below.counts.gaps, untraced: below.counts.untraced },
    { nodes: 2, leaves: 1, gaps: 0, untraced: 0 })
})

// ------------------------------------------------------------------ schedule

test('schedule refuses an execution with no envelope, and an unreadable tree', async (t) => {
  const r = world(t, NO_GAPS)
  const none = await schedule(ctxOf(r, STAMP, { run: false }), {})
  assert.equal(none.ok, false)
  assert.equal(none.error.kind, 'no_execution')
  assert.deepEqual(stateOf(r), [], 'a refusal records nothing')

  const bad = executionContext({ repo: r, effort: 'Not An Effort!', execution: STAMP, log: executionLog(r, E, STAMP) })
  mkdirSync(bad.dir, { recursive: true })
  writeFileSync(join(bad.dir, 'execution.json'), JSON.stringify({ stamp: STAMP, root: '.', base_branch: 'main', base_sha: head(r), dial: 'normal', pace: 'balanced', commands: COMMANDS }))
  const unreadable = await schedule(bad, {})
  assert.equal(unreadable.ok, false)
  assert.equal(unreadable.error.kind, 'unreadable')
})

test('schedule launches the ready leaves, and none behind an unmerged dependency', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'], deps: ['a'] })])
  envelopeFor(r)
  const out = await schedule(ctxOf(r), {})
  assert.equal(out.ok, true)
  assert.deepEqual(ids(out.launch), ['leaf:a'])
  assert.deepEqual(out.stops, [])
  assert.equal(out.idle, false)
})

test('schedule launches nothing beneath a running unit, and no leaf while stopping', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'] })])
  envelopeFor(r)
  const xc = ctxOf(r)
  assert.deepEqual(ids((await schedule(xc, { running: [] })).launch).sort(), ['leaf:a', 'leaf:b'])
  assert.deepEqual(ids((await schedule(xc, { running: ['leaf:a'] })).launch), ['leaf:b'])
  const stopping = await schedule(xc, { stopping: true })
  assert.equal(stopping.ok, true)
  assert.deepEqual(stopping.launch, [])
})

test('schedule launches nothing beneath a folder being planned', async (t) => {
  const r = world(t, [root(), { id: 'f', kind: 'composite', title: 'f', decisions: ['D1'] }, leaf('f/a', { locus: ['src/fa.mjs'] }), leaf('b', { locus: ['src/b.mjs'] })])
  envelopeFor(r)
  const xc = ctxOf(r)
  assert.deepEqual(ids((await schedule(xc, { planning: [] })).launch).sort(), ['leaf:b', 'leaf:f/a'])
  assert.deepEqual(ids((await schedule(xc, { planning: ['f'] })).launch), ['leaf:b'])
})

test("schedule launches no more leaves than the pool allows, and only those of the execution's folder", async (t) => {
  const r = world(t, [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { locus: ['src/ca.mjs'] }), leaf('c/b', { locus: ['src/cb.mjs'] }), leaf('d', { locus: ['src/d.mjs'] })])
  mkdirSync(join(configPath(r), '..'), { recursive: true })
  writeFileSync(configPath(r), JSON.stringify({ max_parallel: 1 }))
  envelopeFor(r, STAMP, 'c')
  const xc = ctxOf(r)
  const first = await schedule(xc, {})
  assert.equal(first.launch.length, 1, 'the pool is one')
  assert.ok(first.launch[0].id.startsWith('c/'), 'd is outside the execution folder')
  assert.deepEqual(ids((await schedule(xc, { running: ['leaf:c/a'] })).launch), [], 'the one slot is taken')
})

test('schedule holds a node with a fault after the latest run, and takes it up in the next run', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'] })])
  envelopeFor(r)
  const xc = ctxOf(r)
  recordAll(xc, [fault('a', 'role', 'the dispatch returned nothing')])
  assert.deepEqual(ids((await schedule(xc, { running: [] })).launch), ['leaf:b'], 'a held node is not launched again in this run')
  assert.deepEqual(ids((await schedule(xc, { running: [] })).launch), ['leaf:b'])
  assert.equal(stateKind(r, 'fault').length, 1)

  const next = await schedule(ctxOf(r), { running: [] })
  assert.deepEqual(ids(next.launch).sort(), ['leaf:a', 'leaf:b'], 'the next run takes it up')
})

test('schedule parks a childless folder the user writes needs_design and launches it nowhere', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] }), { id: 'mine', kind: 'design', title: 'my part', author: 'you' }])
  envelopeFor(r)
  const out = await schedule(ctxOf(r), {})
  assert.equal(out.ok, true)
  assert.deepEqual(out.launch.map((l) => l.id), ['a'])
  assert.deepEqual(out.stops, [{ id: 'mine', status: 'parked', reason: 'needs_design', said: '' }])
  const now = readTree(r, E).status.get('mine')
  assert.equal(now.status, 'parked')
  assert.equal(now.last.return, 'needs_design')
})

test('schedule parks every childless folder the user writes in one call, past the pool', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] })])
  const n = Math.max(5, maxParallel(r) + 1)
  const mine = Array.from({ length: n }, (_, i) => 'mine' + i)
  const seeded = seedTree(r, E, mine.map((id) => ({ id, kind: 'design', title: 'part ' + id, author: 'you' })))
  assert.equal(seeded.ok, true, JSON.stringify(seeded.problems))
  envelopeFor(r)
  const out = await schedule(ctxOf(r), {})
  assert.equal(out.ok, true)
  assert.deepEqual(out.stops.map((s) => s.id).sort(), [...mine].sort())
  assert.ok(out.stops.every((s) => s.status === 'parked' && s.reason === 'needs_design'))
  assert.deepEqual(out.launch.map((l) => l.id), ['a'])
  const status = readTree(r, E).status
  assert.ok(mine.every((id) => status.get(id).status === 'parked'))
})

test('a childless folder the planner writes is launched to plan', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] }), { id: 'later', kind: 'design', title: 'later part', author: 'planner' }])
  envelopeFor(r)
  const out = await schedule(ctxOf(r), {})
  assert.equal(out.ok, true)
  assert.ok(out.launch.some((l) => l.unit === 'plan' && l.id === 'later'))
  assert.deepEqual(out.stops, [])
  assert.notEqual(readTree(r, E).status.get('later').status, 'parked')
})

/** A leaf `a` measured green at its head with no approval: the world the ladder sends to merge. */
function ladderWorld(t, extra = {}) {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'], ...extra })])
  envelopeFor(r)
  const xc = ctxOf(r)
  return { r, xc, sha: greenLeaf(r, xc, 'a', 'src/a.mjs') }
}

test('schedule approves a ladder-green leaf with no review loop of its own at the head that measured green, and merges it', async (t) => {
  const { r, xc, sha } = ladderWorld(t)
  const out = await schedule(xc, {})
  assert.equal(out.ok, true)
  const approvals = eventsOf(r, 'approved').filter((e) => e.node === 'a')
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].head_sha, sha)
  assert.equal(approvals[0].review_rounds, 0)
  assert.equal(approvals[0].at_integration, true)
  assert.ok(!out.launch.some((l) => l.unit === 'leaf' && l.id === 'a'), 'an approved leaf is not launched as a leaf')
  const merge = out.launch.find((l) => l.unit === 'merge')
  assert.deepEqual(merge.children, [{ id: 'a', head_sha: sha }])
  assert.deepEqual(out.stops, [], 'an approval is no stop')
  assert.equal(out.idle, false)
})

test('a ladder-green leaf with a review loop of its own is launched, not approved', async (t) => {
  const { r, xc } = ladderWorld(t, { provides: [{ name: 'api', paths: ['src/a.mjs'] }] })
  const out = await schedule(xc, {})
  assert.equal(out.ok, true)
  assert.ok(out.launch.some((l) => l.unit === 'leaf' && l.id === 'a'))
  assert.equal(eventsOf(r, 'approved').length, 0)
})

test('a ladder-green leaf whose approval stands is not approved again', async (t) => {
  const { r, xc, sha } = ladderWorld(t)
  xc.log.append('approved', { node: 'a', head_sha: sha, review_rounds: 0, at_integration: true })
  const out = await schedule(xc, {})
  assert.equal(out.ok, true)
  assert.equal(eventsOf(r, 'approved').filter((e) => e.node === 'a').length, 1)
  assert.deepEqual(out.launch.find((l) => l.unit === 'merge').children, [{ id: 'a', head_sha: sha }])
})

test('a planner folder parked spec_changed is re-derived once per park', async (t) => {
  const r = world(t, [root(), { id: 'x', kind: 'composite', title: 'x', author: 'planner', decisions: ['D1'] }, leaf('x/a', { locus: ['src/a.mjs'] })])
  envelopeFor(r)
  const xc = ctxOf(r)
  const plans = async () => (await schedule(xc, {})).launch.filter((l) => l.unit === 'plan')
  xc.log.append('parked', { node: 'x', return: 'spec_changed', question: '' })
  assert.deepEqual(await plans(), [{ unit: 'plan', id: 'x', why: 'spec_changed' }])

  xc.log.append('dispatched', dispatchedFields('d-reviewer', { node: 'x', role: 'reviewer', thread: 'x:reviewer' }))
  assert.equal((await plans()).length, 1, 'a dispatch of another role does not answer the park')
  xc.log.append('dispatched', dispatchedFields('d-planner', { node: 'x', role: 'planner', thread: 'x:planner' }))
  assert.deepEqual(await plans(), [], 'a planner dispatch on the folder newer than the park does')

  xc.log.append('parked', { node: 'x', return: 'spec_changed', question: '' })
  assert.equal((await plans()).length, 1, 'a new park is re-derived once more')
})

test('schedule writes no card files', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'] }), { id: 'later', kind: 'design', title: 'later', author: 'planner' }])
  envelopeFor(r)
  const out = await schedule(ctxOf(r), {})
  assert.ok(out.launch.length >= 3)
  assert.equal(existsSync(join(executionDir(r, E, STAMP), 'cards')), false)
})

test('schedule run twice records nothing twice', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] }), { id: 'mine', kind: 'design', title: 'my part', author: 'you' }])
  envelopeFor(r)
  const xc = ctxOf(r)
  const sha = greenLeaf(r, xc, 'a', 'src/a.mjs')
  const lines = () => [readLog(r, E, 'events').entries.length, stateOf(r).length, journalOf(r).length]
  const before = lines()
  const first = await schedule(xc, {})
  const after = lines()
  assert.ok(after[0] >= before[0] + 2, 'the park and the approval were recorded')
  assert.deepEqual(first.stops.map((s) => s.id), ['mine'])
  assert.equal(eventsOf(r, 'approved')[0].head_sha, sha)

  const again = await schedule(executionContext({ repo: r, effort: E, execution: STAMP, log: executionLog(r, E, STAMP) }), {})
  assert.equal(again.ok, true)
  assert.deepEqual(lines(), after, 'a second schedule over the same disk appends no event')
})

test('schedule is idle when nothing runs and nothing is ready', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] })])
  envelopeFor(r)
  const xc = ctxOf(r)
  xc.log.append('escalated', { node: 'a', reason: 'blocked', detail: '' })
  const idle = await schedule(xc, {})
  assert.equal(idle.ok, true)
  assert.equal(idle.idle, true)
  assert.equal((await schedule(xc, { running: ['review:.'] })).idle, false)
})

// ------------------------------------------------------------------ postflight

test('postflight refuses an unreadable tree', async (t) => {
  const r = world(t, NO_GAPS)
  envelopeFor(r)
  const bad = executionContext({ repo: r, effort: 'Not An Effort!', execution: STAMP, log: executionLog(r, E, STAMP) })
  const out = await postflight(bad)
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'unreadable')
})

test('postflight appends closed {status: done} once every leaf in scope merged', async (t) => {
  const r = world(t, NO_GAPS)
  envelopeFor(r)
  const xc = ctxOf(r)
  xc.log.append('merged', { node: 'a' })
  const partial = await postflight(xc)
  assert.equal(partial.ok, true)
  assert.equal(partial.closed, false)
  assert.equal(stateKind(r, 'closed').length, 0)

  xc.log.append('merged', { node: 'b' })
  const done = await postflight(xc)
  assert.equal(done.closed, true)
  assert.equal(done.summary.done, true)
  const closed = stateKind(r, 'closed')
  assert.equal(closed.length, 1)
  assert.equal(closed[0].status, 'done')
})

test('postflight run twice appends closed once', async (t) => {
  const r = world(t, NO_GAPS)
  envelopeFor(r)
  const xc = ctxOf(r)
  xc.log.append('merged', { node: 'a' })
  xc.log.append('merged', { node: 'b' })
  assert.equal((await postflight(xc)).closed, true)
  assert.equal((await postflight(xc)).closed, true)
  const fresh = await postflight(executionContext({ repo: r, effort: E, execution: STAMP, log: executionLog(r, E, STAMP) }))
  assert.equal(fresh.closed, true)
  assert.equal(stateKind(r, 'closed').length, 1)
})

test('below the effort root, postflight closes only once the root folder merged too', async (t) => {
  const r = world(t, [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { locus: ['src/a.mjs'] })])
  envelopeFor(r, STAMP, 'c')
  const xc = ctxOf(r)
  xc.log.append('merged', { node: 'c/a' })
  assert.equal((await postflight(xc)).closed, false)
  assert.equal(stateKind(r, 'closed').length, 0)
  xc.log.append('merged', { node: 'c' })
  assert.equal((await postflight(xc)).closed, true)
  assert.equal(stateKind(r, 'closed').length, 1)
})

test('postflight writes no ended, invocation or usage record', async (t) => {
  const r = world(t, NO_GAPS)
  envelopeFor(r)
  const xc = ctxOf(r)
  xc.log.append('merged', { node: 'a' })
  xc.log.append('merged', { node: 'b' })
  assert.equal((await postflight(xc)).closed, true)
  const kinds = [...stateOf(r), ...journalOf(r), ...readLog(r, E, 'events').entries].map((e) => e.kind)
  for (const kind of ['ended', 'invocation', 'usage']) assert.ok(!kinds.includes(kind), 'a ' + kind + ' record was written')
})

test("postflight frees this execution's slots", async (t) => {
  const r = world(t, NO_GAPS)
  envelopeFor(r)
  assert.equal(acquire(r, { effort: E, execution: STAMP, node: 'a', locus: [ADD] }).ok, true)
  assert.equal(acquire(r, { effort: E, execution: STAMP2, node: 'b', locus: ['README.md'] }).ok, true)
  const out = await postflight(ctxOf(r))
  assert.equal(out.ok, true)
  assert.deepEqual(heldBy(r).slots.map((s) => [s.execution, s.node]), [[STAMP2, 'b']])
})

test("postflight names the root's integration branch and head, and counts merged and unmerged branches", async (t) => {
  const r = world(t, NO_GAPS)
  envelopeFor(r)
  const xc = ctxOf(r)
  const bare = await postflight(xc)
  assert.deepEqual({ branch: bare.integration.branch, head_sha: bare.integration.head_sha }, { branch: '', head_sha: '' }, 'no integration branch yet')
  assert.equal(bare.cleanup_n, 0)
  assert.equal(bare.unmerged_n, 0)

  git(r, 'worktree', 'add', '-q', '-b', branchOf(E, '.'), worktreeOf(r, E, '.'), 'HEAD')
  const rootHead = commitIn(worktreeOf(r, E, '.'), { 'docs/integrated.md': 'merged work\n' }, 'Integrate')
  git(r, 'branch', branchOf(E, 'a'), 'HEAD')
  git(r, 'branch', branchOf(E, 'b'), 'HEAD')
  xc.log.append('merged', { node: 'a' })
  const out = await postflight(xc)
  assert.equal(out.integration.branch, branchOf(E, '.'))
  assert.equal(out.integration.head_sha, rootHead)
  assert.notEqual(rootHead, head(r))
  assert.equal(out.cleanup_n, 1)
  assert.equal(out.unmerged_n, 1)
  assert.deepEqual(out.stops, [])
})

test('postflight summarizes the subtree: the stopped nodes and the leaves waiting behind each', async (t) => {
  const r = world(t, [root(), leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'], deps: ['a'] })])
  envelopeFor(r)
  const xc = ctxOf(r)
  xc.log.append('escalated', { node: 'a', reason: 'blocked', detail: '' })
  const out = await postflight(xc)
  assert.equal(out.ok, true)
  assert.deepEqual(out.summary.stopped, [{ id: 'a', status: 'escalated', reason: 'blocked' }])
  assert.deepEqual(out.summary.blocked, [{ blocked_by: 'a', leaves_n: 1 }])
  assert.equal(out.summary.leaves_n, 2)
  assert.equal(out.closed, false)
})
