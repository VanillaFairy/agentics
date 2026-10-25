// test/migrate-expects.test.mjs — tools/migrate-expects.mjs: the one-shot rename of a task's
// `locus:` field to `expects:`, on a store made the way 5.x left it.
//
// What is pinned here:
//
//   rename    the keyword alone changes, and code says whether that is all that changed
//   migrate   a dry run writes nothing; `--yes` rewrites each spec, states a signed spec's line again at
//             its new hash so it stays approved, compiles so the nodes carry `expects`, and lists the
//             leaves the user must retry; a second run finds nothing to do
//
// Design: docs/DESIGN.md#migration-from-4x.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

import { approvalState } from '../lib/approval.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { specPath } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { preflight } from '../lib/boundaries/execution.mjs'
import { dispatch } from '../lib/programs/common.mjs'
import { migrate, rename } from '../tools/migrate-expects.mjs'
import { migrate as withdrawRun } from '../tools/migrate-messages.mjs'
import { executionRig } from './harness/program-rig.mjs'

delete process.env.NODE_TEST_CONTEXT

const FILLER = ['## Open questions', '', '## Evidence', '', 'None yet.', '']
const SPEC = [
  '# Two leaves', '', '## Intent', '', 'Two leaves.', '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|', '| D1 | a is there. | Callers need it. |', '',
  '## Design', '', 'As the plan says.', '', '## Plan', '',
  '- **a** — task · realises: D1 · rigor: trivial · expects: src/a.mjs, test/a.test.mjs',
  '  Do a', '  - [ ] a works — check: `node --test test/a.test.mjs`',
  '- **b** — task · realises: D1 · rigor: trivial',
  '  · expects: src/b.mjs', '  Do b', '  - [ ] b works — check: `node --test test/b.test.mjs`', '',
  ...FILLER,
].join('\n')

test('rename changes the field keyword alone, and says so', () => {
  const old = SPEC.replaceAll('· expects:', '· locus:')
  const r = rename(old)
  assert.equal(r.next, SPEC)
  assert.deepEqual([r.changed, r.formatOnly], [true, true])
  assert.deepEqual([rename(SPEC).changed, rename(SPEC).formatOnly], [false, true], 'a migrated spec has nothing to rename')
  assert.ok(!rename(old + '\nlocus: prose that is no field\n').next.includes('expects: prose'), 'a word outside a field is left alone')
})

test('a 5.x store is migrated once: its specs renamed and still approved, its nodes compiled, its stale leaves listed', { timeout: 120_000 }, (t) => {
  const rig = executionRig(t, { spec: SPEC })
  const path = specPath(rig.repo, rig.effort, '.')
  // The store as 5.x left it: the spec says locus, approved at that text; nodes say locus; a leaf
  // stopped on a widened locus and a close that reverted a breach.
  const old = SPEC.replaceAll('· expects:', '· locus:')
  writeFileSync(path, old)
  assert.equal(append(rig.repo, rig.effort, 'ledger', [{ kind: 'approved', folder: '.', hash: hashSpec(old), decisions: [], by: 'user' }]).ok, true)
  const nodes = readTree(rig.repo, rig.effort).nodes
  const { expects, ...a } = nodes.get('a')
  assert.equal(append(rig.repo, rig.effort, 'nodes', [{ kind: 'node', node: { ...a, locus: expects } }]).ok, true)
  rig.log.append('escalated', { node: 'b', reason: 'locus_held', detail: 'held' })
  rig.log.append('breach_reverted', { node: 'a', paths: ['README.md'], sha: 'abc1234' })
  assert.equal(approvalState(rig.repo, rig.effort, '.').state, 'approved')

  const dry = migrate(rig.repo)
  assert.equal(readFileSync(path, 'utf8'), old, 'a dry run writes nothing')
  assert.deepEqual(dry.specs.map((s) => s.folder), ['.'])
  assert.deepEqual(dry.carried.map((c) => [c.from, c.hash]), [[hashSpec(old), hashSpec(SPEC)]])

  const applied = migrate(rig.repo, { yes: true })
  assert.equal(readFileSync(path, 'utf8'), SPEC)
  assert.deepEqual(applied.refused, [])
  const st = approvalState(rig.repo, rig.effort, '.')
  assert.deepEqual([st.state, st.hash], ['approved', hashSpec(SPEC)], 'the user\'s approval stands for the same words')
  const carried = readLog(rig.repo, rig.effort, 'ledger').entries.filter((l) => l.carried_from)
  assert.deepEqual(carried.map((l) => [l.kind, l.by, l.carried_from]), [['approved', 'user', hashSpec(old)]])
  assert.deepEqual(applied.compiled, [{ effort: rig.effort, ok: true, problems: [] }])
  assert.deepEqual(readTree(rig.repo, rig.effort).nodes.get('a').expects, ['src/a.mjs', 'test/a.test.mjs'])
  assert.deepEqual(applied.retry.map((r) => r.node).sort(), ['a', 'b'])

  const again = migrate(rig.repo, { yes: true })
  assert.deepEqual([again.specs, again.carried, again.compiled], [[], [], []], 'a second run finds nothing to do')
})

test('needs_locus messages are withdrawn once, so a planner thread holding them dispatches again, and a merged leaf is not listed to retry', { timeout: 120_000 }, async (t) => {
  let rig = executionRig(t, { spec: SPEC })
  // A 6.0 planner thread: two needs_locus messages it was sent, carried by its next round, then a findings message.
  const asked = ['a', 'b'].map((node) => rig.log.append('message', {
    node: '.', thread: 'planner:.', from: 'code', msg: 'needs_locus', payload: { node, paths: ['src/' + node + '.mjs'], why: 'w' }, round: 1,
  }).seq)
  rig.log.append('dispatched', { node: '.', dispatch: 'd1', thread: 'planner:.', round: 1, carries: asked, role: 'planner' })
  rig.log.append('message', { node: '.', thread: 'planner:.', from: 'code', msg: 'findings', payload: { findings: [] }, round: 2 })
  rig.log.append('breach_reverted', { node: 'a', paths: ['README.md'], sha: 'abc1234' })
  rig.log.append('escalated', { node: 'b', reason: 'locus_held', detail: 'held' })
  rig.log.append('approved', { node: 'a', head_sha: rig.base_sha, review_rounds: 0, at_integration: false })
  rig.log.append('merged', { node: 'a', into: '.', merged_sha: rig.base_sha, head_sha: rig.base_sha })
  assert.equal(readTree(rig.repo, rig.effort).status.get('a').status, 'merged', 'the fixture: a is merged')
  const refused = preflight(rig.xc, {})
  assert.deepEqual([refused.ok, refused.error && refused.error.kind], [false, 'messages_unrenderable'], 'the run refuses before any unit throws on them')
  assert.match(refused.error.message, /run node "[^"]+\/tools\/migrate-expects\.mjs" --repo /, 'the refusal names the migration that handles needs_locus')
  assert.deepEqual(withdrawRun(rig.repo, { yes: true }).withdrawn, [], 'the withdrawal migration leaves needs_locus to migrate-expects')
  const planner = () => dispatch(rig.ctx, { role: 'planner', schema: 'planner_write', node: '.', thread: 'planner:.', round: 3, brief: 'Write it.' })
  await assert.rejects(planner(), /no template for message "needs_locus"/, 'the fixture: the thread cannot be dispatched on')

  const dry = migrate(rig.repo)
  assert.deepEqual(dry.withdrawn.map((w) => w.messages), [asked])
  assert.equal(readLog(rig.repo, rig.effort, 'events').entries.filter((e) => e.kind === 'withdrawn').length, 0, 'a dry run writes nothing')
  const applied = migrate(rig.repo, { yes: true })
  assert.deepEqual(applied.refused, [])
  assert.deepEqual(applied.retry.map((r) => r.node), ['b'], 'a merged leaf has nothing left to retry')
  assert.deepEqual(migrate(rig.repo, { yes: true }).withdrawn, [], 'a second run withdraws nothing')

  rig = rig.relaunch()
  rig.script({ 'planner|.|planner:.': [{ output: { status: 'written', text: '' } }] })
  assert.notEqual((preflight(rig.xc, {}).error || {}).kind, 'messages_unrenderable')
  const out = await planner()
  assert.equal(out.status, 'returned')
  assert.ok(!rig.calls.at(-1).freshBrief.includes('needs_locus'), 'a fresh session is told nothing of what was withdrawn')
})
