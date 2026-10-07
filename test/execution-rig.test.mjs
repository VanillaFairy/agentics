// test/execution-rig.test.mjs — pins the execution rig the unit and execute-program tests build on:
// a compiled effort with its effort branch and envelope, an execution log that starts empty, and a
// context whose scripted dispatch stores its return in the execution's home.
//
// Design: docs/DESIGN.md#execution, docs/DESIGN.md#programs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dispatch } from '../lib/programs/common.mjs'
import { executionDir, readJson, returnPath } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { executionRig } from './harness/program-rig.mjs'

const FIXTURES = fileURLToPath(new URL('./fixtures/compile/', import.meta.url))
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n')
const hits = { hits: [{ path: 'src/add.mjs', line: 1, note: 'there' }], searched: [], no_match: '', not_reached: '', stop_reason: 'exhausted' }

test('the rig builds a compiled effort, its effort branch and its envelope', (t) => {
  const rig = executionRig(t)
  const tree = readTree(rig.repo, rig.effort)
  assert.equal(tree.nodes.get('a')?.kind, 'leaf')
  assert.equal(rig.git('rev-parse', rig.branchOf('.')), rig.git('rev-parse', 'main'))
  const envelope = readJson(join(executionDir(rig.repo, rig.effort, rig.stamp), 'execution.json'))
  assert.equal(envelope.stamp, rig.stamp)
  assert.equal(envelope.base_sha, rig.git('rev-parse', 'main'))
  assert.deepEqual(rig.xc.envelope(), envelope)
  assert.equal(rig.ctx.execution, rig.stamp)
  assert.equal(rig.ctx.dir, rig.xc.dir)
})

test('the rig approves and compiles sub-specs given as a folder map', (t) => {
  const rig = executionRig(t, { spec: { api: fixture('api.md'), '.': fixture('root.md') }, files: { 'docs/x.md': 'x\n' } })
  const tree = readTree(rig.repo, rig.effort)
  assert.equal(tree.nodes.get('cli')?.kind, 'leaf')
  assert.equal(tree.nodes.get('api/parse')?.kind, 'leaf')
  assert.equal(rig.git('show', 'main:docs/x.md'), 'x')
})

test('the execution log starts empty', (t) => {
  const rig = executionRig(t)
  assert.deepEqual(rig.xc.log.entries(), [])
})

test('a scripted dispatch stores its return under the execution home', async (t) => {
  const rig = executionRig(t)
  rig.script({ 'scout|a|plan': [{ output: hits }] })
  const r = await dispatch(rig.ctx, { role: 'scout', schema: 'scout_hits', node: 'a', thread: 'plan', brief: 'Find add.' })
  assert.equal(r.status, 'returned')
  const stored = returnPath(executionDir(rig.repo, rig.effort, rig.stamp), r.dispatch)
  assert.match(stored.replace(/\\/g, '/'), new RegExp('/executions/' + rig.stamp + '/returns/'))
  assert.deepEqual(readJson(stored), hits)
  assert.equal(rig.xc.log.entries().filter((e) => e.kind === 'returned').length, 1)
  const again = rig.relaunch()
  const replay = await dispatch(again.ctx, { role: 'scout', schema: 'scout_hits', node: 'a', thread: 'plan', brief: 'Find add.' })
  assert.equal(replay.replayed, true)
  assert.equal(again.calls.length, 0)
  assert.equal(existsSync(stored), true)
})
