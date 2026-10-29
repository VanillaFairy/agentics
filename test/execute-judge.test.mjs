// test/execute-judge.test.mjs — the judge at the merge, over real git and the scripted runner: what
// merge-batch sets aside, what the ruler's rulings record, what the schedule does with them, and the
// rebase round a conflict's resolve sends.
//
// What is pinned here:
//
//   contention   a leaf about to merge that changed a file a leaf of another folder changed and has
//                not merged is set aside for the ruler: serialize holds its merge until that leaf
//                merged where they meet; resolve merges it in the next batch; replan hands it to
//                the planner and keeps it out of merges; an unruled unit escalates to the user
//   conflict     a leaf whose merge conflicted is ruled: resolve sends a rebase round whose open
//                leaves the merge in progress for the producer, and whose close measures nothing
//                until the producer concluded it
//
// Design: docs/DESIGN.md#the-judge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { leafClose } from '../lib/boundaries/leaf-close.mjs'
import { leafOpen } from '../lib/boundaries/leaf-open.mjs'
import { ensureIntegration, ensureLeaf } from '../lib/integration.mjs'
import { mergeUnit } from '../lib/programs/execute/integrate.mjs'
import { runLeaf } from '../lib/programs/execute/leaf.mjs'
import { schedule } from '../lib/schedule.mjs'
import { dispatchKey, nodeKey } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { executionRig } from './harness/program-rig.mjs'

delete process.env.NODE_TEST_CONTEXT

const SLOW = { timeout: 180_000 }

const FILLER = ['## Open questions', '', '## Evidence', '', 'None yet.', '']
const specOf = (title, decisions, plan) => [
  '# ' + title, '', '## Intent', '', title + '.', '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|',
  ...decisions.map(([id, text]) => `| ${id} | ${text} | Callers need it. |`), '',
  '## Design', '', 'As the plan says.', '', '## Plan', '', ...plan, '', ...FILLER,
].join('\n')
const task = (name, realises, expects) => [
  `- **${name}** — task · realises: ${realises} · rigor: trivial · expects: ${expects.join(', ')}`,
  `  Do ${name}`, `  - [ ] ${name} works — check: \`node --test test/add.test.mjs\``,
].join('\n')
const subEffort = (name, realises) => `- **${name}** — sub-effort · realises: ${realises}\n  Folder ${name}`

/** A root with folders x (leaves a and c) and y (leaf b); b expects the shared file. */
const SPEC = {
  '.': specOf('Root', [['D1', 'x is there.'], ['D2', 'y is there.']], [subEffort('x', 'D1'), subEffort('y', 'D2')]),
  x: specOf('Folder x', [['x.D1', 'x holds.']], [task('a', 'D1, x.D1', ['src/a.mjs']), task('c', 'D1, x.D1', ['src/c.mjs'])]),
  y: specOf('Folder y', [['y.D1', 'y holds.']], [task('b', 'D2, y.D1', ['src/b.mjs', 'src/shared.mjs'])]),
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
const kinds = (rig, kind) => readTree(rig.repo, rig.effort).events.filter((e) => e.kind === kind)
const statusOf = (rig, id) => readTree(rig.repo, rig.effort).status.get(id).status

function commitIn(worktree, files, subject) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true })
    writeFileSync(join(worktree, path), text)
  }
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-q', '-m', subject)
  return git(worktree, 'rev-parse', 'HEAD')
}

/** Stand in for leaf-open and a returned round 1: the leaf's branch cut from its folder's head, its change committed. */
function readyLeaf(rig, id, files) {
  const folder = id.split('/')[0]
  assert.equal(ensureIntegration(rig.repo, rig.effort, folder, rig.envelope).ok, true)
  const from = rig.git('rev-parse', 'refs/heads/' + rig.branchOf(folder))
  const made = ensureLeaf(rig.repo, rig.effort, id, { from, parentBranch: rig.branchOf(folder) })
  assert.equal(made.ok, true, made.error)
  const dispatch = dispatchKey({ node: id, role: 'implementer', thread: 'producer:' + id, round: 1 })
  rig.log.append('dispatched', { node: id, dispatch, round: 1, thread: 'producer:' + id, role: 'implementer' })
  rig.log.append('returned', { dispatch, session: 's', status: 'returned', cause: '', usage: null, cost_total: null, cost_usd: null, denials: [] })
  return { id, worktree: made.worktree, base: made.base, head_sha: commitIn(made.worktree, files, 'Change ' + id) }
}

const approve = (rig, leaf) => rig.log.append('approved', { node: leaf.id, head_sha: leaf.head_sha, review_rounds: 0, at_integration: true })
const merge = (rig, folder, ...leaves) => mergeUnit(rig.ctx, rig.xc, { target: folder, children: leaves.map((l) => ({ id: l.id, head_sha: l.head_sha })), intelligence: 'normal' })
const rulerKey = (trigger, leaf) => `ruler|${leaf.id.split('/')[0]}|ruler:${trigger}:${nodeKey(leaf.id)}:${leaf.head_sha.slice(0, 8)}`
const rulings = (...list) => ({ output: { rulings: list.map(([unit, ruling, question = '']) => ({ unit, ruling, why: unit + ' ' + ruling, question })) } })

/** What the schedule would merge now, from the records. */
function merges(rig) {
  const tree = readTree(rig.repo, rig.effort)
  const approvedHead = (id) => (tree.events.filter((e) => e.kind === 'approved' && e.node === id).pop() || {}).head_sha || ''
  return schedule({ nodes: tree.nodes, status: tree.status, events: tree.events, root: '.', maxParallel: 4, approvedHead })
    .launch.filter((u) => u.unit === 'merge').flatMap((u) => u.children.map((c) => c.id))
}

/** b in folder y changed the shared file first; a in folder x changed it too and is approved. */
function contended(t) {
  const rig = executionRig(t, { spec: SPEC })
  const b = readyLeaf(rig, 'y/b', { 'src/shared.mjs': 'export const shared = "b"\n' })
  const a = readyLeaf(rig, 'x/a', { 'src/shared.mjs': 'export const shared = "a"\n', 'src/a.mjs': 'export const a = 1\n' })
  approve(rig, a)
  return { rig, a, b }
}

// ================================================================== contention

test('serialize: the leaf is set aside, recorded waiting on the other folder\'s leaf, and merged only once that leaf merged where they meet', SLOW, async (t) => {
  const { rig, a, b } = contended(t)
  rig.script({ [rulerKey('contention', a)]: [rulings(['y/b', 'serialize'])] })
  const out = await merge(rig, 'x', a)

  assert.deepEqual(out.merged, [], 'set aside, not merged')
  const [judged] = kinds(rig, 'judged')
  assert.deepEqual([judged.node, judged.trigger, judged.outcome, judged.after, judged.head_sha], ['x/a', 'contention', 'serialize', ['y/b'], a.head_sha])
  assert.deepEqual(judged.facts, [{ node: 'y/b', kind: 'overlap', paths: ['src/shared.mjs'] }])
  assert.equal(judged.heads['y/b'], b.head_sha, 'the ruling names the head it judged')
  assert.ok(rig.calls[0].brief.includes('src/shared.mjs'), 'the ruler is handed the contended path')
  assert.equal(statusOf(rig, 'x/a'), 'approved', 'a waiting unit stays approved: it holds no slot')
  assert.ok(!merges(rig).includes('x/a'), 'its merge waits for y/b')

  rig.log.append('merged', { node: 'y/b', into: rig.branchOf('y'), merged_sha: b.head_sha, head_sha: b.head_sha })
  assert.ok(!merges(rig).includes('x/a'), 'merged into y is not yet where x and y meet')
  rig.log.append('merged', { node: 'y', into: rig.branchOf('.'), merged_sha: b.head_sha, head_sha: b.head_sha })
  assert.ok(merges(rig).includes('x/a'), 'once y merged into the root, x/a merges')
})

test('resolve: the leaf merges in the next batch, its facts covered at the heads ruled', SLOW, async (t) => {
  const { rig, a } = contended(t)
  rig.script({ [rulerKey('contention', a)]: [rulings(['y/b', 'resolve'])] })
  const first = await merge(rig, 'x', a)
  assert.deepEqual(first.merged, [])
  assert.equal(kinds(rig, 'judged')[0].outcome, 'resolve')
  assert.ok(merges(rig).includes('x/a'))

  const second = await merge(rig, 'x', a)
  assert.deepEqual(second.merged.map((m) => m.id), ['x/a'])
  assert.equal(rig.calls.filter((c) => c.role.name === 'ruler').length, 1, 'no second ruling')
})

test('replan: the leaf goes to the planner with the question, and stays out of merges', SLOW, async (t) => {
  const { rig, a } = contended(t)
  rig.script({ [rulerKey('contention', a)]: [rulings(['y/b', 'replan', 'Which folder owns src/shared.mjs?'])] })
  const out = await merge(rig, 'x', a)
  assert.deepEqual(out.replan, [{ id: 'x/a', question: 'Which folder owns src/shared.mjs?' }])
  assert.deepEqual(kinds(rig, 'escalated'), [])
  assert.ok(!merges(rig).includes('x/a'))
})

test('a unit the ruler cannot rule escalates to the user', SLOW, async (t) => {
  const { rig, a } = contended(t)
  rig.script({ [rulerKey('contention', a)]: [rulings(['y/b', 'cant_rule'])] })
  await merge(rig, 'x', a)
  assert.deepEqual(kinds(rig, 'escalated').map((e) => [e.node, e.reason]), [['x/a', 'contention_unruled']])
  assert.equal(statusOf(rig, 'x/a'), 'escalated')
})

// ================================================================== conflict and the rebase round

test('resolve of a conflict sends a rebase round: the open leaves the merge in progress, and a round that returns it unconcluded stops', SLOW, async (t) => {
  const rig = executionRig(t, { spec: SPEC })
  const c = readyLeaf(rig, 'x/c', { 'src/c.mjs': 'export const c = 1\n', 'src/both.mjs': 'export const both = "c"\n' })
  const a = readyLeaf(rig, 'x/a', { 'src/a.mjs': 'export const a = 1\n', 'src/both.mjs': 'export const both = "a"\n' })
  approve(rig, c)
  assert.deepEqual((await merge(rig, 'x', c)).merged.map((m) => m.id), ['x/c'])
  approve(rig, a)
  rig.script({ [rulerKey('conflict', a)]: [rulings(['integration', 'resolve'])] })
  const out = await merge(rig, 'x', a)

  assert.deepEqual(out.merged, [])
  assert.deepEqual(out.rebase, [{ id: 'x/a' }])
  const [judged] = kinds(rig, 'judged')
  assert.deepEqual([judged.trigger, judged.outcome, judged.paths], ['conflict', 'resolve', ['src/both.mjs']])
  assert.deepEqual(kinds(rig, 'escalated'), [], 'the user is not asked')
  const [rebase] = kinds(rig, 'message').filter((m) => m.msg === 'rebase')
  assert.deepEqual([rebase.node, rebase.thread, rebase.round, rebase.payload.paths], ['x/a', 'producer:x/a', 2, ['src/both.mjs']])

  const opened = await leafOpen(rig.xc, { node: 'x/a', intelligence: 'normal' })
  assert.equal(opened.status, 'opened')
  assert.equal(opened.round, 2)
  assert.ok(readFileSync(join(a.worktree, 'src/both.mjs'), 'utf8').includes('<<<<<<<'), 'the conflict is left in the worktree')
  const again = await leafOpen(rig.xc, { node: 'x/a', intelligence: 'normal' })
  assert.equal(again.status, 'opened', 'an open run again takes the merge in progress as its own')

  const close = () => leafClose(rig.xc, { node: 'x/a', role: 'implementer', round: 2, thread: 'producer:x/a', dispatch: '', head_before: opened.head_sha, base_sha: opened.base_sha })
  const waiting = await close()
  assert.deepEqual([waiting.decision.next, waiting.decision.reason], ['stop', 'merge_conflict'], 'it returned the head it was sent the rebase at')
  assert.ok(waiting.decision.failures[0].claim.includes('src/both.mjs'))
  assert.ok(kinds(rig, 'escalated').some((e) => e.node === 'x/a' && e.reason === 'merge_conflict'))

  writeFileSync(join(a.worktree, 'src/both.mjs'), 'export const both = "a and c"\n')
  git(a.worktree, 'add', 'src/both.mjs')
  git(a.worktree, 'commit', '-q', '--no-edit')
  const done = await close()
  assert.equal(done.decision.next, 'approve', JSON.stringify(done.decision))
})

test("a leaf a resolve sent a rebase opens the rebase round, never resuming what its last round left", SLOW, async (t) => {
  const rig = executionRig(t, { spec: SPEC })
  const c = readyLeaf(rig, 'x/c', { 'src/c.mjs': 'export const c = 1\n', 'src/both.mjs': 'export const both = "c"\n' })
  const a = readyLeaf(rig, 'x/a', { 'src/a.mjs': 'export const a = 1\n', 'src/both.mjs': 'export const both = "a"\n' })
  approve(rig, c)
  await merge(rig, 'x', c)
  approve(rig, a)
  rig.script({
    [rulerKey('conflict', a)]: [rulings(['integration', 'resolve'])],
    'implementer|x/a|producer:x/a': [{ output: { status: 'blocked', text: 'stopping here' } }],
  })
  await merge(rig, 'x', a)
  const out = await runLeaf(rig.ctx, rig.xc, { id: 'x/a', intelligence: 'normal' })
  const rounds = kinds(rig, 'dispatched').filter((e) => e.node === 'x/a').map((e) => [e.round, e.role])
  assert.deepEqual(rounds.at(-1), [2, 'implementer'], 'round 1 returned unclosed is not closed again; the rebase opens round 2')
  assert.equal(out.outcome, 'stopped')
})

test('a ruler that leaves a contended unit out is asked once more for it, by name, before anything escalates', SLOW, async (t) => {
  const { rig, a } = contended(t)
  rig.script({ [rulerKey('contention', a)]: [rulings(), rulings(['y/b', 'resolve'])] })
  await merge(rig, 'x', a)
  const calls = kinds(rig, 'dispatched').filter((e) => e.role === 'ruler').map((e) => e.round)
  assert.deepEqual(calls, [1, 2], 'the second call is the re-ask')
  const [judged] = kinds(rig, 'judged')
  assert.equal(judged.outcome, 'resolve', 'the re-asked ruling counts')
  assert.deepEqual(kinds(rig, 'escalated'), [], 'nothing reached the user')
})

test('a ruler that leaves the unit out again escalates contention_unruled, naming it', SLOW, async (t) => {
  const { rig, a } = contended(t)
  rig.script({ [rulerKey('contention', a)]: [rulings(), rulings()] })
  await merge(rig, 'x', a)
  const [stop] = kinds(rig, 'escalated')
  assert.deepEqual([stop.node, stop.reason], ['x/a', 'contention_unruled'])
  assert.match(stop.detail, /y\/b: left unruled/)
})

test('after the session retries a leaf, a new ruling at the head an earlier one stopped it at is recorded and decides', SLOW, async (t) => {
  const { rig, a } = contended(t)
  const earlier = { node: 'x/a', trigger: 'contention', head_sha: a.head_sha, heads: {}, facts: [], paths: [], outcome: 'cant_rule', after: [], why: 'y/b: left unruled', said: 'r0', execution: rig.stamp }
  rig.log.append('judged', earlier)
  rig.log.append('replanned', { node: 'x/a', reason: 'retry_escalated', by: 'session' })
  approve(rig, a)
  rig.script({ [rulerKey('contention', a)]: [rulings(['y/b', 'resolve'])] })
  await merge(rig, 'x', a)
  const judged = kinds(rig, 'judged').filter((e) => e.node === 'x/a')
  assert.deepEqual(judged.map((e) => e.outcome), ['cant_rule', 'resolve'], 'the earlier ruling does not stand over the retry')
  assert.ok(merges(rig).includes('x/a'), 'the new ruling is what the schedule reads')
})
