// test/boundaries-leaf-close-escalation.test.mjs — lib/boundaries/leaf-close.mjs: the raise, a
// close that does not converge, unknown commands and a verify leaf's finding, over real git and the
// real measurement.
//
// What is pinned here:
//
//   leafClose        the raise when every failure key fails again, `verify_not_converging`,
//                    `command_unknown` handed back or escalated by the investigator's dispatch,
//                    and a verify leaf's failing check
//
// A close is never seeded by hand: every close record and every `breach_reverted` line comes from a
// `leafClose` call. Expected ids, shas, paths and keys are computed. The world builders the
// leaf-close files share are in test/harness/leaf-close-world.mjs.
//
// Design: docs/DESIGN.md#boundaries.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { executionLog } from '../lib/ledger.mjs'
import { root } from './harness/boundary-fixture.mjs'
import {
  E, SLOW, world, open, commit, stored, close, run, recs, rec, claimsOf, DONE, A_SRC, A_FILES, crit, lf,
  planner,
} from './harness/leaf-close-world.mjs'

const OTHER_STAMP = '20260926-120000'

const FAIL = "node -e 'process.exit(1)'"

// ================================================================== the decision

describe('leaf-close and the decision', { concurrency: 4 }, () => {
  function twoChecks(t) {
    const ok1 = 'node -e "process.exit(require(\'fs\').existsSync(\'ok1.txt\')?0:1)"'
    const bad2 = 'node -e "process.exit(require(\'fs\').existsSync(\'bad2.txt\')?1:0)"'
    const w = world(t, [root(), lf('a', {
      locus: ['src/a.mjs', 'test/a.test.mjs', 'ok1.txt', 'bad2.txt'],
      acceptance: [{ text: 'ok1 exists', check: ok1, decisions: ['D1'] }, { text: 'bad2 is absent', check: bad2, decisions: ['D1'] }],
    })])
    return { w, o: open(w, 'a') }
  }

  test('a close raises when every failure key of the previous close fails again', SLOW, async (t) => {
    const { w, o } = twoChecks(t)
    const one = commit(o.worktree, A_FILES, 'Add a')
    const first = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(first.out.decision.next, 'fix', JSON.stringify(first.out.decision))
    assert.equal(first.out.raise, false)
    assert.equal(rec(w, 'a', 'implementer', 1).raise, false)
    commit(o.worktree, { 'bad2.txt': 'x\n' }, 'Break the second')
    const second = await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: one })
    assert.equal(second.out.decision.next, 'fix', JSON.stringify(second.out.decision))
    assert.ok(claimsOf(second.out).length > claimsOf(first.out).length, 'round 2 keeps the failure and adds one')
    assert.equal(second.out.raise, true)
    assert.equal(rec(w, 'a', 'implementer', 2).raise, true)
  })

  test('a close does not raise when one failure of the previous close cleared', SLOW, async (t) => {
    const { w, o } = twoChecks(t)
    const one = commit(o.worktree, A_FILES, 'Add a')
    const first = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(first.out.decision.next, 'fix', JSON.stringify(first.out.decision))
    commit(o.worktree, { 'ok1.txt': 'x\n', 'bad2.txt': 'x\n' }, 'Clear the first, break the second')
    const second = await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: one })
    assert.equal(second.out.decision.next, 'fix', JSON.stringify(second.out.decision))
    assert.equal(second.out.raise, false)
    assert.equal(rec(w, 'a', 'implementer', 2).raise, false)
  })

  test('two consecutive closes failing identically at a moved head escalate verify_not_converging', SLOW, async (t) => {
    const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'], acceptance: crit('a', FAIL) })])
    const o = open(w, 'a')
    const one = commit(o.worktree, A_FILES, 'Add a')
    const first = await run(w, { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha })
    assert.equal(first.out.decision.next, 'fix', JSON.stringify(first.out.decision))
    commit(o.worktree, { 'src/a.mjs': A_SRC + '// second try\n' }, 'Try again')
    const second = await run(w, { node: 'a', role: 'implementer', round: 2, ret: DONE, base_sha: o.base_sha, head_before: one })
    assert.deepEqual([second.out.decision.next, second.out.decision.reason], ['stop', 'verify_not_converging'])
    assert.equal(second.out.stops.length, 1)
    assert.deepEqual([second.out.stops[0].id, second.out.stops[0].status, second.out.stops[0].reason], ['a', 'escalated', 'verify_not_converging'])
    assert.equal(recs(w, 'escalated', 'a').filter((e) => e.reason === 'verify_not_converging').length, 1)
  })

  /** A leaf with no commands anywhere, its first close done. */
  async function unknownCommands(t) {
    const w = world(t, [root(), lf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })], { commands: null })
    const o = open(w, 'a')
    commit(o.worktree, A_FILES, 'Add a')
    const spec = { node: 'a', role: 'implementer', round: 1, ret: DONE, base_sha: o.base_sha, head_before: o.base_sha }
    const dispatch = stored(w, spec)
    const first = await close(w, { ...spec, dispatch })
    return { w, spec, dispatch, first, again: () => close(w, { ...spec, dispatch }) }
  }

  const escalations = (w) => recs(w, 'escalated', 'a').filter((e) => e.reason === 'command_unknown')

  test('command_unknown is handed back while no investigator was dispatched in this execution', SLOW, async (t) => {
    const s = await unknownCommands(t)
    assert.equal(s.first.decision.next, 'command_unknown')
    assert.deepEqual(s.first.stops, [])
    assert.equal(escalations(s.w).length, 0)
  })

  test('command_unknown escalates once the investigator dispatched in this execution has returned', SLOW, async (t) => {
    const s = await unknownCommands(t)
    stored(s.w, { node: 'a', role: 'investigator', round: 1, thread: 'investigator', dispatch: 'inv-1' })
    const out = await s.again()
    assert.deepEqual([out.decision.next, out.decision.reason], ['stop', 'command_unknown'])
    assert.deepEqual(out.stops.map((x) => [x.id, x.status, x.reason]), [['a', 'escalated', 'command_unknown']])
    assert.equal(escalations(s.w).length, 1)
  })

  test('command_unknown is handed back while the investigator dispatched in this execution has not returned', SLOW, async (t) => {
    const s = await unknownCommands(t)
    stored(s.w, { node: 'a', role: 'investigator', round: 1, thread: 'investigator', dispatch: 'inv-1', returned: false })
    const out = await s.again()
    assert.equal(out.decision.next, 'command_unknown')
    assert.deepEqual(out.stops, [])
    assert.equal(escalations(s.w).length, 0)
  })

  test('command_unknown is handed back when the investigator dispatched in this execution failed', SLOW, async (t) => {
    const s = await unknownCommands(t)
    stored(s.w, { node: 'a', role: 'investigator', round: 1, thread: 'investigator', dispatch: 'inv-1', returned: 'failed', cause: 'host_error' })
    const out = await s.again()
    assert.equal(out.decision.next, 'command_unknown')
    assert.deepEqual(out.stops, [])
    assert.equal(escalations(s.w).length, 0)
  })

  test('command_unknown is handed back when only another execution has an investigator that returned', SLOW, async (t) => {
    const s = await unknownCommands(t)
    const other = executionLog(s.w.r, E, OTHER_STAMP)
    other.append('dispatched', { dispatch: 'inv-other', node: 'a', round: 1, thread: 'investigator', role: 'investigator', model: 'sonnet', effort: 'medium', carries: [] })
    other.append('returned', { dispatch: 'inv-other', status: 'returned' })
    const out = await s.again()
    assert.equal(out.decision.next, 'command_unknown')
    assert.equal(escalations(s.w).length, 0)
  })

  /** A verify leaf `v` whose one check fails, under the root or a planner's folder. */
  async function verifyLeaf(t, id) {
    const w = world(t, [root(), ...(id === 'c/v' ? [planner()] : []), lf(id, { rigor: 'verify', locus: [], acceptance: crit(id, FAIL) })])
    const o = open(w, id)
    const out = await close(w, { node: id, role: '', round: 1, thread: '', dispatch: '', base_sha: o.base_sha })
    return { w, out }
  }

  test("a verify leaf's failing check escalates verify_finding and parks the folder the user wrote needs_respec", SLOW, async (t) => {
    const { w, out } = await verifyLeaf(t, 'v')
    assert.equal(out.decision.next, 'stop')
    const found = recs(w, 'escalated', 'v')
    assert.equal(found.length, 1)
    assert.equal(found[0].reason, 'verify_finding')
    const parks = recs(w, 'parked', '.')
    assert.equal(parks.length, 1)
    assert.equal(parks[0].return, 'needs_respec')
  })

  test("a verify leaf's failing check under a planner's folder routes the folder to its planner", SLOW, async (t) => {
    const { w, out } = await verifyLeaf(t, 'c/v')
    assert.equal(out.decision.next, 'route')
    assert.equal(out.route.folder, 'c')
    assert.equal(out.route.request.status, 'verify_finding')
    assert.equal(out.route.request.node, 'c/v')
    assert.equal(recs(w, 'parked', 'c').length, 0)
    assert.equal(recs(w, 'escalated', 'c/v').filter((e) => e.reason === 'verify_finding').length, 0, 'the finding is the route: the leaf is not escalated')
  })
})
