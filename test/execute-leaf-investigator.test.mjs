// test/execute-leaf-investigator.test.mjs — pins the leaf unit of the execute program (`runLeaf`):
// one leaf driven over the execution rig, with scripted agents, to the investigator that
// establishes the commands.
//
// What is pinned here:
//
//   the investigator  command_unknown: the investigator, once per execution and process, in a
//                     throwaway worktree, and two leaves that find no command at once
//
// The rig, the scripted answers and the worlds the parts share are in
// test/harness/execute-leaf-world.mjs.
//
// Design: docs/DESIGN.md#executors-and-review.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { commandsOf, gotchaId, listGotchas } from '../lib/gotchas.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { closePath } from '../lib/store.mjs'
import {
  T, leafEntry, git, work, world, callsOf, startsOf, approvals, sessionFor, done,
} from './harness/execute-leaf-world.mjs'

// The rig does not clear NODE_TEST_CONTEXT, and a measurement's nested `node --test` that inherits
// it reports to this runner and exits 0, so every red or tdd test file would read as passing.
delete process.env.NODE_TEST_CONTEXT

/** Wait for `pred` by the clock: a measurement is a child process, so a count of ticks says nothing about time. */
async function until(pred, label, ms = 120_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail('never reached: ' + label)
}

// ------------------------------------------------------------------ one round

describe('the leaf unit', { concurrency: 4 }, () => {

  // ------------------------------------------------------------------ the investigator

  const COMMAND = (name, value) => ({
    kind: 'command', roles: ['implementer', 'investigator'], paths: [], trigger: 'running ' + name, action: 'use it',
    evidence: { command: name, output: 'ok' }, command: { name, value },
  })
  const ABSENT = (name) => ({ ...COMMAND(name, ''), command: { name, value: '', absent: true } })
  const SUITE = 'node --test --test-reporter=spec'
  const TEST_ONE = 'node --test --test-reporter=spec {file}'
  const ESTABLISHED = () => [ABSENT('build'), ABSENT('typecheck'), COMMAND('suite', SUITE), COMMAND('test_one', TEST_ONE)]
  const investigated = () => ({
    output: { commands: ESTABLISHED(), established: ['build', 'typecheck', 'suite', 'test_one'], unresolved: [], text: 'found them' },
  })
  const A_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { a } from '../src/a.mjs'\ntest('a is 1', () => assert.equal(a(), 1))\n"

  test('command_unknown: the investigator establishes commands once in a throwaway worktree, then the leaf closes again', T, async (t) => {
    const w = world(t, { rigSpec: true, commands: {} })
    w.job('implementer|a#1', (cwd) => work(cwd, { 'src/a.mjs': 'export const a = () => 1\n', 'test/a.test.mjs': A_TEST }, 'make a'))
    w.rig.script({
      'implementer|a|producer:a': [done()],
      'investigator|.|investigator': [investigated()],
    })
    let seen = null
    const around = async (call, real) => {
      if (call.role.name === 'investigator') {
        seen = { cwd: call.cwd, existed: existsSync(call.cwd), head: git(call.cwd, 'rev-parse', 'HEAD'), listed: git(w.rig.repo, 'worktree', 'list', '--porcelain') }
      }
      return real(call)
    }
    const out = await w.leg({ around }).run('a')
    assert.equal(out.outcome, 'approved', JSON.stringify(out))
    assert.equal(out.round, 1)
    assert.equal(startsOf(w.rig, 'implementer', 'a').length, 1, 'the same round is closed again, not dispatched again')
    const calls = callsOf(w.rig, 'investigator')
    assert.equal(calls.length, 1, 'once')
    const [call] = calls
    assert.equal(call.thread.key, 'investigator')
    assert.equal(call.node, '.', "the envelope's root")
    assert.equal(call.round, 1)
    assert.deepEqual(call.schema, schemaOf('investigator'))
    assert.equal(call.thread.session, sessionFor(w.rig, { node: '.', role: 'investigator', thread: 'investigator' }))
    assert.ok(seen && seen.existed, 'the throwaway worktree existed during the call')
    assert.notEqual(resolve(seen.cwd), resolve(w.rig.worktreeOf('a')), "not the leaf's worktree")
    assert.notEqual(resolve(seen.cwd), resolve(w.rig.repo), 'not the repository')
    assert.ok(seen.cwd.includes('investigate-' + w.rig.effort + '-' + w.rig.stamp))
    assert.equal(seen.head, w.rig.base_sha, "detached at the envelope's base_sha")
    assert.equal(existsSync(seen.cwd), false, 'removed after the call')
    assert.ok(!git(w.rig.repo, 'worktree', 'list', '--porcelain').includes('investigate-'), 'and no longer known to git')
    const found = commandsOf(w.rig.repo, w.rig.effort)
    assert.equal(found.suite, SUITE)
    assert.equal(found.test_one, TEST_ONE)
    const ids = new Set(listGotchas(w.rig.repo, w.rig.effort).map((g) => g.id))
    for (const g of ESTABLISHED()) assert.ok(ids.has(gotchaId(g)), gotchaId(g) + ' is a gotcha')
    assert.equal(approvals(w.rig, 'a').length, 1)
  })

  test('two leaves that find no command at once share one investigator', T, async (t) => {
    const w = world(t, {
      leaves: [leafEntry('b', { locus: ['src/b.txt'] }), leafEntry('c', { locus: ['src/c.txt'] })],
      commands: {},
    })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.job('implementer|c#1', (cwd) => work(cwd, { 'src/c.txt': 'ok\n' }, 'make c'))
    w.rig.script({
      'implementer|b|producer:b': [done()],
      'implementer|c|producer:c': [done()],
      'investigator|.|investigator': [investigated(), investigated()],
    })
    const closed = (id) => existsSync(closePath(w.rig.repo, w.rig.effort, w.rig.stamp, id, 'implementer', 1))
    // The call is held until both leaves have closed on command_unknown, so the second asks while the first is in flight.
    const around = async (call, real) => {
      if (call.role.name === 'investigator') await until(() => closed('b') && closed('c'), 'both leaves closed')
      return real(call)
    }
    const run = w.leg({ around })
    const [one, two] = await Promise.all([run.run('b'), run.run('c')])
    assert.equal(one.outcome, 'approved', JSON.stringify(one))
    assert.equal(two.outcome, 'approved', JSON.stringify(two))
    assert.equal(callsOf(w.rig, 'investigator').length, 1, 'one call, shared')
    assert.equal(approvals(w.rig, 'b').length, 1)
    assert.equal(approvals(w.rig, 'c').length, 1)
  })
})
