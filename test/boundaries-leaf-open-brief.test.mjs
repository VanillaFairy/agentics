// test/boundaries-leaf-open-brief.test.mjs — pins leaf-open in-process: what a round's dispatch
// takes from the records: its permissions from its role's rule and its role's commands, its thread
// brief, and the worktree it is cut at (a green from its red's head, work salvaged).
//
// The setup the parts share is in test/harness/leaf-open-world.mjs.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#rigor and docs/DESIGN.md#role-rules.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { leafOpen } from '../lib/boundaries/leaf-open.mjs'
import { leafBrief } from '../lib/brief.mjs'
import { commandsOf, writeGotcha } from '../lib/gotchas.mjs'
import { rolePermissions } from '../lib/permissions.mjs'
import { roleCommands } from '../lib/roles.mjs'
import { worktreeOf } from '../lib/store.mjs'
import { STAMP, commitIn, git, leaf } from './harness/boundary-fixture.mjs'
import { E, RED, mayWrite, setup, ran, nodeOf, roleOf, cycle, askedForTests } from './harness/leaf-open-world.mjs'


/** The suite command an investigator established, as `commandsOf` reads it. */
const established = (r, value) => writeGotcha(r, E, {
  kind: 'command', roles: ['implementer', 'investigator'], paths: [], trigger: 'running suite', action: 'use it',
  evidence: { command: 'suite', output: 'ok' }, command: { name: 'suite', value, absent: false },
}, { source: { role: 'investigator' } })

// ------------------------------------------------------------------ permissions

test('a round\'s permissions are its role\'s rule, with its role\'s commands', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { expects: ['src/a.mjs'] }), leaf('b', { expects: ['src/b.mjs'] })])
  established(r, 'node --test --test-reporter=spec')
  const { permissions } = await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  const commands = roleCommands(roleOf('implementer'), commandsOf(r, E), nodeOf(r, 'a'))
  assert.ok(commands.includes('node --test --test-reporter=spec'), 'the established suite is the role\'s <test>')
  for (const c of commands) assert.ok(permissions.allowed.includes('Bash(' + c + ':*)'), c)
  for (const path of ['src/a.mjs', 'src/b.mjs', 'docs/a.md', 'test/add.test.mjs']) assert.ok(mayWrite(permissions, path), 'any file of the worktree: ' + path)
  assert.ok(!mayWrite(permissions, '.agentics/e1/DESIGN.md'), 'never the store')
})

test('a green\'s implementer may write no test file', async (t) => {
  const { green } = await cycle(t)
  assert.equal(green.role, 'implementer')
  for (const path of ['test/r.test.mjs', 'src/r.test.mjs']) assert.ok(!mayWrite(green.permissions, path), path)
  for (const path of ['src/r.mjs', 'src/other.mjs']) assert.ok(mayWrite(green.permissions, path), path)
})

test('a test round writes test files and never a source file', async (t) => {
  const { xc } = await cycle(t)
  askedForTests(xc)
  const { permissions } = await leafOpen(xc, { node: 'g', intelligence: 'normal' })
  for (const path of ['test/r.test.mjs', 'src/r.test.mjs', 'test/fixtures/r.json']) assert.ok(mayWrite(permissions, path), path)
  for (const path of ['src/r.mjs', '.agentics/r.test.json']) assert.ok(!mayWrite(permissions, path), 'never a source file: ' + path)
  assert.deepEqual(permissions.allowed.filter((p) => p.startsWith('Bash')), [], 'a test author runs no command')
})

test('the cycle\'s test session may not read what the green\'s own commits changed outside the cycle\'s tests', async (t) => {
  const { xc, green } = await cycle(t)
  assert.deepEqual(green.permissions.disallowed.filter((p) => p.startsWith('Read(')), [], 'the implementer reads its own code')
  commitIn(green.cwd, { 'src/r.mjs': 'export const r = () => 1\n', 'src/r-help.mjs': 'export const h = 1\n' }, 'Implement r')
  commitIn(green.cwd, { 'test/r.test.mjs': RED + "test('more', () => {})\n" }, 'Pin more')
  askedForTests(xc)
  const { permissions } = await leafOpen(xc, { node: 'g', intelligence: 'normal' })
  const denied = rolePermissions({ denyRead: ['src/r.mjs', 'src/r-help.mjs'] }).disallowed.filter((p) => p.startsWith('Read('))
  for (const rule of denied) assert.ok(permissions.disallowed.includes(rule), rule)
  const tests = rolePermissions({ denyRead: ['test/r.test.mjs'] }).disallowed.filter((p) => p.startsWith('Read('))
  for (const rule of tests) assert.ok(!permissions.disallowed.includes(rule), 'the cycle\'s tests stay readable: ' + rule)
})

// ------------------------------------------------------------------ the brief and the worktree

test('the brief and its parts are the round\'s leaf brief over the established commands', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { expects: ['src/a.mjs'] })])
  established(r, 'node --test --test-reporter=spec')
  const out = await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  const expected = leafBrief(r, E, 'a', { role: 'implementer', worktree: out.cwd, commands: commandsOf(r, E) })
  assert.equal(out.brief, expected.text)
  assert.deepEqual(out.brief_parts, expected.parts)
  assert.match(out.brief, /node --test --test-reporter=spec/)
})

test('the cycle\'s test session is briefed with the red\'s leaf brief on a green\'s round', async (t) => {
  const { r, xc } = await cycle(t)
  askedForTests(xc)
  const out = await leafOpen(xc, { node: 'g', intelligence: 'normal' })
  const commands = commandsOf(r, E)
  const red = leafBrief(r, E, 'r', { role: 'test-author', worktree: out.cwd, commands })
  assert.equal(out.brief, red.text)
  assert.deepEqual(out.brief_parts, red.parts)
  assert.notEqual(out.brief, leafBrief(r, E, 'g', { role: 'test-author', worktree: out.cwd, commands }).text, 'not the green\'s')
  assert.equal(out.cwd, resolve(worktreeOf(r, E, 'g')), 'it works in the green\'s worktree')
})

test('a green is cut from its red\'s head, and opened again names the same base', async (t) => {
  const { xc, green, redHead } = await cycle(t)
  assert.equal(green.base_sha, redHead)
  assert.equal(green.head_sha, redHead)
  assert.equal((await leafOpen(xc, { node: 'g', intelligence: 'normal' })).base_sha, green.base_sha)
})

test('a green is cut from its red and brought up to the parent\'s head, so its other dependencies are there', async (t) => {
  const { r, xc } = setup(t, [
    leaf('r', { rigor: 'tdd-pair', role: 'red', expects: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], expects: ['src/r.mjs'] }),
  ])
  const red = await leafOpen(xc, { node: 'r', intelligence: 'normal' })
  const redHead = commitIn(red.cwd, { 'test/r.test.mjs': RED }, 'Pin r')
  commitIn(resolve(worktreeOf(r, E, '.')), { 'src/l.mjs': 'export const l = 1\n' }, 'Merge l')
  const green = await leafOpen(xc, { node: 'g', intelligence: 'normal' })
  assert.ok(existsSync(join(green.cwd, 'src', 'l.mjs')), 'what merged into the parent is there')
  assert.ok(existsSync(join(green.cwd, 'test', 'r.test.mjs')), 'and the red\'s tests')
  assert.equal(green.salvaged, false, 'a refresh merge is no work of an earlier round')
  assert.equal(git(r, 'rev-parse', green.base_sha + '^1'), redHead, 'the base is the refresh merge on the red\'s head')
})

test('committed work on the branch no dispatch of this execution made is reported salvaged', async (t) => {
  const { xc } = setup(t, [leaf('a', { expects: ['src/a.mjs'] })])
  const first = await leafOpen(xc, { node: 'a', intelligence: 'normal' })
  assert.equal(first.salvaged, false, 'a new branch holds nothing')
  commitIn(first.cwd, { 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  assert.equal((await leafOpen(xc, { node: 'a', intelligence: 'normal' })).salvaged, true)
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a' })
  assert.equal((await leafOpen(xc, { node: 'a', intelligence: 'normal' })).salvaged, false, 'this execution\'s own round')
})
