// test/boundary-detached.test.mjs — lib/boundary.mjs against real git: the CLI, and the jobs it runs detached.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { readLog } from '../lib/ledger.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { executionDir } from '../lib/store.mjs'
import {
  A_TEST, B, BOUNDARY, COMMANDS, commitIn, leaf, repo, root, STAMP,
} from './harness/boundary-fixture.mjs'

const cli = (r, name, args, env = {}) => {
  const out = spawnSync('node', [BOUNDARY, name, '--repo', r, '--effort', 'e1', '--execution', STAMP,
    '--b64', Buffer.from(JSON.stringify(args)).toString('base64')], { encoding: 'utf8', env: { ...process.env, ...env } })
  return JSON.parse(out.stdout).payload
}

test('a long boundary runs detached: pending past the poll limit, collected by the next call', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })])
  B(r, 'preflight', { root: '.', commands: COMMANDS })
  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1 })
  commitIn(open.worktree, { 'test/a.test.mjs': A_TEST, 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  const args = { node: 'a', role: 'implementer', round: 1, base_sha: open.base_sha }
  const run = (wait) => spawnSync('node', [fileURLToPath(new URL('../lib/boundary.mjs', import.meta.url)), 'leaf-close', '--repo', r, '--effort', 'e1', '--execution', STAMP,
    '--b64', Buffer.from(JSON.stringify(args)).toString('base64')], { encoding: 'utf8', env: { ...process.env, AGENTICS_INLINE_JOBS: '', AGENTICS_BOUNDARY_WAIT_MS: String(wait) } })
  const first = JSON.parse(run(1).stdout)
  assert.equal(first.payload.status, 'pending')
  const second = JSON.parse(run(60000).stdout)
  assert.equal(second.payload.status, 'done')
  assert.equal(second.payload.decision.next, 'approve')
  const verifies = readLog(r, 'e1', 'journal:' + STAMP).entries.filter((e) => e.kind === 'verify-observed')
  assert.equal(verifies.length, 1, 'the job ran once, whoever collected it')
})

test('the CLI refuses a damaged argument token and prints an envelope either way', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs'] })])
  const token = Buffer.from(JSON.stringify({ root: '.' })).toString('base64')
  const out = spawnSync('node', [fileURLToPath(new URL('../lib/boundary.mjs', import.meta.url)), 'preflight', '--repo', r, '--effort', 'e1', '--execution', STAMP, '--digest', 'deadbeef', '--b64', token], { encoding: 'utf8' })
  assert.equal(out.status, 0)
  const env = JSON.parse(out.stdout)
  assert.equal(env.payload.error.kind, 'digest_mismatch')
  assert.equal(existsSync(join(executionDir(r, 'e1', STAMP), 'execution.json')), false)
})

test('a detached close re-measures once its inputs change: commands established after command_unknown', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { locus: ['src/a.mjs', 'test/a.test.mjs'] })])
  B(r, 'preflight', { root: '.' })
  const open = B(r, 'leaf-open', { node: 'a', role: 'implementer', round: 1 })
  commitIn(open.worktree, { 'test/a.test.mjs': A_TEST, 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  const args = { node: 'a', role: 'implementer', round: 1, base_sha: open.base_sha }
  const detachedEnv = { AGENTICS_INLINE_JOBS: '', AGENTICS_BOUNDARY_WAIT_MS: '60000' }
  assert.equal(cli(r, 'leaf-close', args, detachedEnv).decision.next, 'command_unknown')
  const add = spawnSync('node', [fileURLToPath(new URL('../lib/gotchas.mjs', import.meta.url)), 'add', '--repo', r, '--effort', 'e1', '--role', 'investigator', '--stdin'],
    { encoding: 'utf8', input: JSON.stringify(['build', 'typecheck', 'suite', 'test_one'].map((name) => ({
      kind: 'command', roles: ['implementer', 'investigator'], paths: [], trigger: 'running ' + name, action: 'use it',
      evidence: { command: name, output: 'ok' },
      command: { name, value: name === 'suite' ? COMMANDS.suite : name === 'test_one' ? COMMANDS.test_one : '', absent: name === 'build' || name === 'typecheck' },
    }))) })
  assert.equal(add.status, 0, add.stdout + add.stderr)
  assert.equal(cli(r, 'leaf-close', args, detachedEnv).decision.next, 'approve', 'the same arguments over new commands are a new job')
})
