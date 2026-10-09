// test/boundaries-leaf-close-record.test.mjs — lib/boundaries/leaf-close.mjs: the close record, a
// close run again, and `recordCommands`, over real git and the real measurement.
//
// What is pinned here:
//
//   leafClose        the close record, a close run twice, a failing close run twice, and a close
//                    run again after its revert
//   recordCommands   the investigator's command gotchas, written and refused
//
// A close is never seeded by hand: every close record and every `breach_reverted` line comes from a
// `leafClose` call. Expected ids, shas, paths and keys are computed. The world builders the
// leaf-close files share are in test/harness/leaf-close-world.mjs.
//
// Design: docs/DESIGN.md#boundaries.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { recordCommands } from '../lib/boundaries/leaf-close.mjs'
import { commandsOf, gotchaId, listGotchas } from '../lib/gotchas.mjs'
import { COMMANDS, git, root } from './harness/boundary-fixture.mjs'
import {
  E, SLOW, world, open, commit, write, stored, close, recs, msgs, sizes, rec, head, stopOf, shapeOf, DONE,
  A_FILES, MORE_TEST, ADD_BITE, lf, tdd, testsOnly, outside, gotcha, command, ESTABLISHED, gotchaOf,
} from './harness/leaf-close-world.mjs'

// ================================================================== recordCommands

describe('recordCommands', { concurrency: 4 }, () => {
  test("recordCommands writes the investigator's command gotchas, and the next close measures with them", SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })], { commands: null })
    const o = open(w, 'a')
    commit(o.worktree, A_FILES, 'Add a')
    const spec = { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha }
    const dispatch = stored(w, spec)
    assert.equal((await close(w, { ...spec, dispatch })).decision.next, 'command_unknown')

    const commands = ESTABLISHED()
    const inv = stored(w, { node: 'a', role: 'investigator', round: 1, thread: 'investigator', dispatch: 'inv-1', ret: { commands, unresolved: [], text: 'found them' } })
    const result = recordCommands(w.xc, { dispatch: inv })
    assert.deepEqual([...result.written].sort(), commands.map(gotchaId).sort())
    assert.deepEqual(result.unresolved, [])
    assert.equal(commandsOf(w.r, E).suite, COMMANDS.suite)
    for (const id of result.written) assert.equal(gotchaOf(w, id).source.role, 'investigator')
    const out = await close(w, { ...spec, dispatch })
    assert.equal(out.decision.next, 'approve', JSON.stringify(out.decision))
  })

  test('recordCommands reports what the investigator left unresolved and every command refused', SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })], { commands: null })
    const refused = { ...command('suite', 'node --test'), evidence: { command: '', output: '' } }
    const inv = stored(w, { node: 'a', role: 'investigator', round: 1, thread: 'investigator', dispatch: 'inv-1', ret: { commands: [refused], unresolved: ['typecheck'], text: 'could not find them' } })
    const result = recordCommands(w.xc, { dispatch: inv })
    assert.deepEqual(result.written, [])
    assert.ok(result.unresolved[0].startsWith('typecheck'), 'the return\'s own unresolved come first')
    assert.ok(result.unresolved.some((u) => u.startsWith('suite:')), 'a refusal is `<command name>: <refusal>`')
    assert.deepEqual(commandsOf(w.r, E).suite, '')
  })

  test('recordCommands with no stored return writes nothing and says so', SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })], { commands: null })
    const inv = stored(w, { node: 'a', role: 'investigator', round: 1, thread: 'investigator', dispatch: 'inv-1' })
    const result = recordCommands(w.xc, { dispatch: inv })
    assert.deepEqual(result.written, [])
    assert.equal(result.unresolved.length, 1)
    assert.equal(listGotchas(w.r, E).length, 0)
  })
})

// ================================================================== the close record, and a close run again

describe('leaf-close record and a close run again', { concurrency: 4 }, () => {
  test('the close record holds the round, its measurement, its decision and what the close did', SLOW, async (t) => {
    const g = gotcha('a trap met on the way')
    const s = await outside(t, { ret: { ...DONE, gotchas: [g] } })
    const record = rec(s.w, 'a', 'implementer', 1)
    assert.equal(record.node, 'a')
    assert.equal(record.role, 'implementer')
    assert.equal(record.round, 1)
    assert.equal(record.thread, 'producer:a')
    assert.equal(record.dispatch, s.dispatch)
    assert.equal(record.status, 'done')
    assert.equal(record.answering, '')
    assert.equal(record.head_sha, head(s.o.worktree))
    assert.equal(stopOf(record), 'completed')
    assert.deepEqual([record.decision.next, record.decision.reason], [s.first.decision.next, s.first.decision.reason])
    assert.equal(typeof record.raise, 'boolean')
    assert.deepEqual(record.breach.paths, ['README.md'])
    assert.deepEqual(record.gotchas_written, [gotchaId(g)])
    assert.deepEqual(record.gotchas_deleted, [])
    assert.equal(record.committed, '')
    assert.ok(Array.isArray(record.notes))
  })

  test('a close run twice records nothing twice and commits nothing twice', SLOW, async (t) => {
    const { w, o } = testsOnly(t)
    write(o.worktree, { 'test/more.test.mjs': MORE_TEST, 'stray.txt': 'oops\n' })
    const ret = { status: 'done', text: 'Cases.', commit: 'Test add with negatives', mutations: [ADD_BITE] }
    const spec = { node: 't', role: 'test-author', round: 1, ret, base_sha: o.base_sha }
    const dispatch = stored(w, spec)
    const first = await close(w, { ...spec, dispatch })
    const tip = head(o.worktree)
    const [commits, size] = [git(o.worktree, 'rev-list', '--count', 'HEAD'), sizes(w)]
    const second = await close(w, { ...spec, dispatch })
    assert.deepEqual(sizes(w), size, 'the second close added no event, state or journal line')
    assert.equal(head(o.worktree), tip, 'and left the head where it was')
    assert.equal(git(o.worktree, 'rev-list', '--count', 'HEAD'), commits)
    assert.deepEqual(shapeOf(second), shapeOf(first))
  })

  test('a failing close run twice records its failures message once', SLOW, async (t) => {
    const { w, o } = tdd(t)
    commit(o.worktree, { ...A_FILES, 'src/a.mjs': 'export const a = () => 2\n' }, 'Add a')
    const spec = { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha }
    const dispatch = stored(w, spec)
    const first = await close(w, { ...spec, dispatch })
    const second = await close(w, { ...spec, dispatch })
    assert.equal(first.decision.next, 'fix', JSON.stringify(first.decision))
    assert.equal(msgs(w, 'failures', 'a').length, 1)
    assert.deepEqual(shapeOf(second), shapeOf(first))
  })

  test('a close run again after its revert reads the breach back and decides as before', SLOW, async (t) => {
    const s = await outside(t, { helper: true })
    const breach = rec(s.w, 'a', 'implementer', 1).breach
    assert.ok(breach && breach.paths.includes('src/helper.mjs'))
    const second = await close(s.w, { ...s.spec, dispatch: s.dispatch })
    assert.deepEqual(shapeOf(second), shapeOf(s.first))
    assert.deepEqual([second.decision.next, second.decision.reason], ['stop', 'needs_respec'])
    assert.deepEqual(rec(s.w, 'a', 'implementer', 1).breach, breach)
    assert.equal(recs(s.w, 'parked', 'a').length, 1)
    assert.equal(recs(s.w, 'breach_reverted', 'a').length, 1)
  })
})
