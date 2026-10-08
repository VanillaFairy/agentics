// test/boundaries-leaf-open-brief.test.mjs — pins leaf-open in-process: what a round's dispatch
// takes from the records: its permissions from the leaf's locus and its role's commands, its thread
// brief, and the worktree it is cut at (a green from its red's head, work salvaged).
//
// The setup the parts share is in test/harness/leaf-open-world.mjs.
//
// Design: docs/DESIGN.md#boundaries, docs/DESIGN.md#rigor and docs/DESIGN.md#the-locus.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { leafOpen } from '../lib/boundaries/leaf-open.mjs'
import { leafBrief } from '../lib/brief.mjs'
import { commandsOf, writeGotcha } from '../lib/gotchas.mjs'
import { acquire } from '../lib/locks.mjs'
import { TEST_GLOBS, permissionsFor } from '../lib/locus.mjs'
import { roleCommands } from '../lib/roles.mjs'
import { worktreeOf } from '../lib/store.mjs'
import { STAMP, commitIn, git, leaf } from './harness/boundary-fixture.mjs'
import { E, RED, globRule, setup, ran, nodeOf, roleOf, cycle, askedForTests } from './harness/leaf-open-world.mjs'

const editWrite = (target) => [`Edit(${target})`, `Write(${target})`]

/** The suite command an investigator established, as `commandsOf` reads it. */
const established = (r, value) => writeGotcha(r, E, {
  kind: 'command', roles: ['implementer', 'investigator'], paths: [], trigger: 'running suite', action: 'use it',
  evidence: { command: 'suite', output: 'ok' }, command: { name: 'suite', value, absent: false },
}, { source: { role: 'investigator' } })

// ------------------------------------------------------------------ permissions

test('a round\'s permissions come from its leaf\'s locus, with its role\'s commands', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  established(r, 'node --test --test-reporter=spec')
  const { permissions } = await leafOpen(xc, { node: 'a' })
  const commands = roleCommands(roleOf('implementer'), commandsOf(r, E), nodeOf(r, 'a'))
  assert.ok(commands.includes('node --test --test-reporter=spec'), 'the established suite is the role\'s <test>')
  for (const c of commands) assert.ok(permissions.allowed.includes('Bash(' + c + ':*)'), c)
  for (const rule of editWrite('src/a.mjs')) assert.ok(permissions.allowed.includes(rule), rule)
  for (const g of TEST_GLOBS) for (const rule of editWrite('src/' + g)) assert.ok(permissions.allowed.includes(rule), rule)
  for (const rule of editWrite('test/add.test.mjs')) assert.ok(!permissions.allowed.includes(rule), 'no unlisted file: ' + rule)
})

test('paths another unmerged leaf holds are denied, and freed once it merged', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'] })])
  assert.equal(acquire(r, { effort: E, execution: STAMP, node: 'b', locus: ['src/b.mjs'], waitMs: 0 }).ok, true)
  const held = await leafOpen(xc, { node: 'a' })
  for (const rule of editWrite('src/b.mjs')) assert.ok(held.permissions.disallowed.includes(rule), rule)
  xc.log.append('merged', { node: 'b', merged_sha: git(r, 'rev-parse', 'main') })
  const freed = await leafOpen(xc, { node: 'a' })
  for (const rule of editWrite('src/b.mjs')) assert.ok(!freed.permissions.disallowed.includes(rule), rule)
})

test('a green\'s implementer may write no test file', async (t) => {
  const { green } = await cycle(t)
  assert.equal(green.role, 'implementer')
  assert.deepEqual(green.permissions.allowed.filter(globRule), [])
  for (const rule of editWrite('src/r.mjs')) assert.ok(green.permissions.allowed.includes(rule), rule)
  for (const rule of [...editWrite('src/r.mjs'), ...editWrite('test/r.test.mjs')]) assert.ok(!green.permissions.disallowed.includes(rule), 'neither the leaf\'s own locus nor its cycle\'s is held against it: ' + rule)
})

test('a test round writes the cycle\'s tests: the red\'s test files and new tests beside every member\'s locus', async (t) => {
  const { xc } = await cycle(t)
  askedForTests(xc)
  const { permissions } = await leafOpen(xc, { node: 'g' })
  for (const rule of editWrite('test/r.test.mjs')) assert.ok(permissions.allowed.includes(rule), rule)
  for (const folder of ['test', 'src']) {
    for (const g of TEST_GLOBS) for (const rule of editWrite(folder + '/' + g)) assert.ok(permissions.allowed.includes(rule), rule)
  }
  for (const rule of editWrite('src/r.mjs')) assert.ok(!permissions.allowed.includes(rule), 'never a source file: ' + rule)
  assert.deepEqual(permissions.allowed.filter((p) => p.startsWith('Bash')), [], 'a test author runs no command')
})

test('the cycle\'s test session may not read what the green\'s own commits changed outside the cycle\'s tests', async (t) => {
  const { xc, green } = await cycle(t)
  assert.deepEqual(green.permissions.disallowed.filter((p) => p.startsWith('Read(')), [], 'the implementer reads its own code')
  commitIn(green.cwd, { 'src/r.mjs': 'export const r = () => 1\n', 'src/r-help.mjs': 'export const h = 1\n' }, 'Implement r')
  commitIn(green.cwd, { 'test/r.test.mjs': RED + "test('more', () => {})\n" }, 'Pin more')
  askedForTests(xc)
  const { permissions } = await leafOpen(xc, { node: 'g' })
  const denied = permissionsFor({ locus: [], denyRead: ['src/r.mjs', 'src/r-help.mjs'] }).disallowed.filter((p) => p.startsWith('Read('))
  for (const rule of denied) assert.ok(permissions.disallowed.includes(rule), rule)
  const tests = permissionsFor({ locus: [], denyRead: ['test/r.test.mjs'] }).disallowed.filter((p) => p.startsWith('Read('))
  for (const rule of tests) assert.ok(!permissions.disallowed.includes(rule), 'the cycle\'s tests stay readable: ' + rule)
})

// ------------------------------------------------------------------ the brief and the worktree

test('the brief and its parts are the round\'s leaf brief over the established commands', async (t) => {
  const { r, xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  established(r, 'node --test --test-reporter=spec')
  const out = await leafOpen(xc, { node: 'a' })
  const expected = leafBrief(r, E, 'a', { role: 'implementer', worktree: out.cwd, commands: commandsOf(r, E) })
  assert.equal(out.brief, expected.text)
  assert.deepEqual(out.brief_parts, expected.parts)
  assert.match(out.brief, /node --test --test-reporter=spec/)
})

test('the cycle\'s test session is briefed with the red\'s leaf brief on a green\'s round', async (t) => {
  const { r, xc } = await cycle(t)
  askedForTests(xc)
  const out = await leafOpen(xc, { node: 'g' })
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
  assert.equal((await leafOpen(xc, { node: 'g' })).base_sha, green.base_sha)
})

test('a green is cut from its red and brought up to the parent\'s head, so its other dependencies are there', async (t) => {
  const { r, xc } = setup(t, [
    leaf('r', { rigor: 'tdd-pair', role: 'red', locus: ['test/r.test.mjs'] }),
    leaf('g', { rigor: 'tdd-pair', role: 'green', deps: ['r'], locus: ['src/r.mjs'] }),
  ])
  const red = await leafOpen(xc, { node: 'r' })
  const redHead = commitIn(red.cwd, { 'test/r.test.mjs': RED }, 'Pin r')
  commitIn(resolve(worktreeOf(r, E, '.')), { 'src/l.mjs': 'export const l = 1\n' }, 'Merge l')
  const green = await leafOpen(xc, { node: 'g' })
  assert.ok(existsSync(join(green.cwd, 'src', 'l.mjs')), 'what merged into the parent is there')
  assert.ok(existsSync(join(green.cwd, 'test', 'r.test.mjs')), 'and the red\'s tests')
  assert.equal(green.salvaged, false, 'a refresh merge is no work of an earlier round')
  assert.equal(git(r, 'rev-parse', green.base_sha + '^1'), redHead, 'the base is the refresh merge on the red\'s head')
})

test('committed work on the branch no dispatch of this execution made is reported salvaged', async (t) => {
  const { xc } = setup(t, [leaf('a', { locus: ['src/a.mjs'] })])
  const first = await leafOpen(xc, { node: 'a' })
  assert.equal(first.salvaged, false, 'a new branch holds nothing')
  commitIn(first.cwd, { 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  assert.equal((await leafOpen(xc, { node: 'a' })).salvaged, true)
  ran(xc, { node: 'a', round: 1, role: 'implementer', thread: 'producer:a' })
  assert.equal((await leafOpen(xc, { node: 'a' })).salvaged, false, 'this execution\'s own round')
})
