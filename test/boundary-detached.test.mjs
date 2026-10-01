// test/boundary-detached.test.mjs — lib/boundary.mjs against real git: the CLI, and the jobs it runs detached.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { readLog } from '../lib/ledger.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { executionDir } from '../lib/store.mjs'
import {
  A_TEST, B, BOUNDARY, COMMANDS, argvFor, commitIn, leaf, repo, root, STAMP, wrote,
} from './harness/boundary-fixture.mjs'

/** The boundary as a courier runs it: its context, then each argument on a flag of its own. */
const cli = (r, name, args, env = {}, extra = []) => {
  const out = spawnSync('node', [BOUNDARY, name, '--repo', r, '--effort', 'e1', '--execution', STAMP, ...argvFor(name, args), ...extra],
    { encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: out.status, printed: out.stdout.trim(), envelope: out.stdout.trim() ? JSON.parse(out.stdout) : null }
}

test('a long boundary runs detached: pending past the poll limit, collected by the next call', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1 })
  commitIn(open.worktree, { 'test/a.test.mjs': A_TEST, 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  const args = { node: 'a', role: 'implementer', round: 1, status: 'done', base_sha: open.base_sha }
  const run = (wait, label) => cli(r, 'leaf-close', { ...args, dispatch: [label + '=courier/haiku/low'] },
    { AGENTICS_INLINE_JOBS: '', AGENTICS_BOUNDARY_WAIT_MS: String(wait) }).envelope
  assert.equal(run(1, 'close:a#1').payload.status, 'pending')
  const second = run(60000, 'close:a#1@2').payload
  assert.equal(second.status, 'done')
  assert.equal(second.decision.next, 'approve')
  const verifies = readLog(r, 'e1', 'journal:' + STAMP).entries.filter((e) => e.kind === 'verify-observed')
  assert.equal(verifies.length, 1, 'the job ran once, whoever collected it: a poll\'s courier is not what the job answers')
  const couriers = readLog(r, 'e1', 'state:' + STAMP).entries.filter((e) => e.kind === 'dispatch').map((e) => [e.label, e.node])
  assert.deepEqual(couriers, [['close:a#1', 'a'], ['close:a#1@2', 'a']], 'each poll\'s courier is a cost line of its own')
})

test('the CLI refuses damaged or non-handle arguments with a typed refusal, and prints one line of handles either way', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs'] })])
  const damaged = cli(r, 'preflight', { root: '.' }, {}, ['--digest', 'deadbeef'])
  assert.equal(damaged.status, 0)
  assert.deepEqual(damaged.envelope.payload.error, { kind: 'digest_mismatch' })
  assert.equal(existsSync(join(executionDir(r, 'e1', STAMP), 'execution.json')), false, 'a refused call does nothing')
  assert.deepEqual(cli(r, 'preflight', { root: '.', dial: 'as smart as it gets' }).envelope.payload.error, { kind: 'args_unreadable' }, 'prose is no handle')
  assert.equal(damaged.printed.split('\n').length, 1)
})

test('a detached close re-measures once its inputs change: commands established after command_unknown', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })])
  B(r, 'preflight', { root: '.' })
  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1 })
  commitIn(open.worktree, { 'test/a.test.mjs': A_TEST, 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  const args = { node: 'a', role: 'implementer', round: 1, status: 'done', base_sha: open.base_sha }
  const detachedEnv = { AGENTICS_INLINE_JOBS: '', AGENTICS_BOUNDARY_WAIT_MS: '60000' }
  assert.equal(cli(r, 'leaf-close', args, detachedEnv).envelope.payload.decision.next, 'command_unknown')
  // The investigator writes the commands it established to a file, and records them from it.
  const file = wrote(['build', 'typecheck', 'suite', 'test_one'].map((name) => ({
    kind: 'command', roles: ['implementer', 'investigator'], paths: [], trigger: 'running ' + name, action: 'use it',
    evidence: { command: name, output: 'ok' },
    command: { name, value: name === 'suite' ? COMMANDS.suite : name === 'test_one' ? COMMANDS.test_one : '', absent: name === 'build' || name === 'typecheck' },
  })))
  const add = spawnSync('node', [join(BOUNDARY, '..', 'gotchas.mjs'), 'add', '--repo', r, '--effort', 'e1', '--role', 'investigator', '--file', file], { encoding: 'utf8' })
  assert.equal(add.status, 0, add.stdout + add.stderr)
  const again = cli(r, 'leaf-close', { ...args, dispatch: ['establish-commands=investigator/sonnet/medium'] }, detachedEnv).envelope.payload
  assert.equal(again.decision.next, 'approve', 'the same arguments over new commands are a new job')
})

test('commands still unknown once an investigator ran escalate the leaf, never send it to another', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })])
  B(r, 'preflight', { root: '.' })
  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1 })
  commitIn(open.worktree, { 'test/a.test.mjs': A_TEST, 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  const args = { node: 'a', role: 'implementer', round: 1, status: 'done', base_sha: open.base_sha }
  assert.equal(B(r, 'leaf-close', args).decision.next, 'command_unknown')
  const again = B(r, 'leaf-close', { ...args, dispatch: ['establish-commands=investigator/sonnet/medium'] })
  assert.deepEqual(again.stops.map((s) => [s.id, s.status, s.reason]), [['a', 'escalated', 'command_unknown']])
})
