// test/setup-prepare.test.mjs — the established setup prepares every worktree before it is measured
// or worked in: the integration worktree before its gate, a merged head before a batch measures it,
// a leaf's worktree before its round. A setup that fails, or that changes a file git sees, stops on
// its own outcome, never as failing tests.
//
// Design: docs/DESIGN.md#gotchas, docs/DESIGN.md#verification.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { leafOpen } from '../lib/boundaries/leaf-open.mjs'
import { writeSessionCommands } from '../lib/boundaries/execution.mjs'
import { suiteGate } from '../lib/boundaries/merge.mjs'
import { readJson } from '../lib/store.mjs'
import { COMMANDS, commitIn, git, leaf, root } from './harness/boundary-fixture.mjs'
import { setup } from './harness/leaf-open-world.mjs'
import { SLOW, addOne, batch, handed, inTest, integrationOf, ready, stopsOf, world } from './harness/merge-world.mjs'

// A folder with its own built page, gitignored, made by its build: what a fresh worktree lacks.
const VIEWER = {
  '.gitignore': '.claude/\nviewer/dist/\n',
  'viewer/build.mjs': "import { mkdirSync, writeFileSync } from 'node:fs'\nmkdirSync('viewer/dist', { recursive: true })\nwriteFileSync('viewer/dist/page.html', 'ok')\n",
  'viewer/check.mjs': "import { existsSync } from 'node:fs'\nprocess.exit(existsSync('viewer/dist/page.html') ? 0 : 1)\n",
}
const CHECK = 'node viewer/check.mjs'
const withViewer = (r) => commitIn(r, VIEWER, 'a viewer with a built page')
const checked = (id) => addOne(id, { acceptance: [{ text: 'the page is served', check: CHECK, decisions: ['D1'] }] })
const gateWorld = (t, commands) => world(inTest(t), [root(), checked('a')], { commands, prepare: withViewer })

test('the gate prepares the integration worktree by its setup, and the check that needs the built page passes', SLOW, async (t) => {
  const w = gateWorld(t, { ...COMMANDS, setup: { viewer: 'node viewer/build.mjs' } })
  const integ = integrationOf(w)
  assert.equal(existsSync(join(integ.worktree, 'viewer/dist/page.html')), false, 'a fresh worktree has no built page')
  const out = await suiteGate(w.xc, { target: '.' })

  assert.equal(out.passed, true, JSON.stringify(out.record && readJson(out.record).failures))
  const m = readJson(out.record).measurement
  assert.equal(m.setup, 'passed')
  assert.deepEqual(m.checks.map((c) => [c.command, c.status]), [[CHECK, 'passed']])
})

test('without a setup the same check fails on the unprepared tree', SLOW, async (t) => {
  const w = gateWorld(t, COMMANDS)
  integrationOf(w)
  const out = await suiteGate(w.xc, { target: '.' })
  assert.deepEqual(stopsOf(out), [['.', 'escalated', 'fails_on_integration']])
})

test('a setup that fails stops the gate setup_failed, and no check is run', SLOW, async (t) => {
  const w = gateWorld(t, { ...COMMANDS, setup: 'node -e "process.exit(4)"' })
  integrationOf(w)
  const out = await suiteGate(w.xc, { target: '.' })
  assert.equal(out.passed, false)
  assert.deepEqual(stopsOf(out), [['.', 'escalated', 'setup_failed']])
})

test('a setup that rewrites a tracked file stops setup_dirtied, and the file is put back', SLOW, async (t) => {
  const w = gateWorld(t, { ...COMMANDS, setup: "node -e \"require('fs').appendFileSync('README.md', 'more')\"" })
  const integ = integrationOf(w)
  const out = await suiteGate(w.xc, { target: '.' })
  assert.deepEqual(stopsOf(out), [['.', 'escalated', 'setup_dirtied']])
  assert.doesNotMatch(readFileSync(join(integ.worktree, 'README.md'), 'utf8'), /more/)
  assert.equal(git(integ.worktree, 'status', '--porcelain'), '')
})

test('a setup that rewrites a tracked file to the content git holds changes nothing, whatever its line endings', SLOW, async (t) => {
  const same = "node -e \"require('fs').writeFileSync('README.md', 'hello' + String.fromCharCode(10))\""
  const w = gateWorld(t, { ...COMMANDS, setup: { '.': same, viewer: 'node viewer/build.mjs' } })
  integrationOf(w)
  const out = await suiteGate(w.xc, { target: '.' })
  assert.equal(out.passed, true, JSON.stringify(out.stops))
  assert.equal(readJson(out.record).measurement.setup, 'passed')
})

test('a merged head setup cannot prepare stops the batch on the setup, merging and bisecting nothing', SLOW, async (t) => {
  const w = world(inTest(t), [root(), addOne('a')], { commands: { ...COMMANDS, setup: 'node -e "process.exit(4)"' } })
  const before = integrationOf(w).head
  const a = await ready(w, 'a', { 'src/add.mjs': 'export const add = (a, b) => b + a\n' }, 'Flip add')
  const out = await batch(w, handed(a))
  assert.equal(out.status, 'stopped')
  assert.deepEqual(stopsOf(out), [['.', 'escalated', 'setup_failed']])
  assert.deepEqual(out.failed_alone, [])
  assert.equal(integrationOf(w).head, before, 'the integration head is where the batch started')
})

test('a round opens in a worktree its setup prepared, and a setup that fails stops the leaf setup_failed', async (t) => {
  const make = "node -e \"require('fs').mkdirSync('prepared/x', { recursive: true })\""
  const good = setup(t, [leaf('a', { expects: ['src/a.mjs'] })], { commands: { ...COMMANDS, setup: make } })
  writeSessionCommands(good.xc, good.xc.envelope())
  const a = await leafOpen(good.xc, { node: 'a', intelligence: 'normal' })
  assert.equal(a.status, 'opened')
  assert.ok(existsSync(join(a.cwd, 'prepared', 'x')), 'setup ran in the leaf worktree')
  assert.match(a.brief, /Setup has run in your worktree/)

  const bad = setup(t, [leaf('b', { expects: ['src/b.mjs'] })], { commands: { ...COMMANDS, setup: 'node -e "process.exit(4)"' } })
  writeSessionCommands(bad.xc, bad.xc.envelope())
  const b = await leafOpen(bad.xc, { node: 'b', intelligence: 'normal' })
  assert.equal(b.status, 'stopped')
  assert.deepEqual(b.stops.map((s) => [s.id, s.status, s.reason]), [['b', 'escalated', 'setup_failed']])
})
