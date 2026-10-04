// test/host-process.test.mjs — pins the production process port: a pid is alive, and is killed, only
// while its image is the host CLI's executable, so a pid the system reused is never killed.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { hostProcess } from '../lib/host.mjs'

const CLI = join('C:', 'Users', 'u', '.local', 'bin', 'claude.exe')
const listing = (images) => (pid) => images[pid] ?? ''

test('a pid whose image is the CLI is alive', () => {
  assert.equal(hostProcess(CLI, { list: listing({ 41: 'claude.exe' }) }).alive(41), true)
})

test('image names compare without case', () => {
  assert.equal(hostProcess(CLI, { list: listing({ 41: 'CLAUDE.EXE' }) }).alive(41), true)
  assert.equal(hostProcess(join('D:', 'Tools', 'Claude.exe'), { list: listing({ 41: 'claude.exe' }) }).alive(41), true)
})

test('image names compare without .exe', () => {
  assert.equal(hostProcess(CLI, { list: listing({ 41: 'claude' }) }).alive(41), true)
  assert.equal(hostProcess('/usr/local/bin/claude', { list: listing({ 41: 'claude.exe' }) }).alive(41), true)
})

test('a pid whose image is another program is not alive', () => {
  const proc = hostProcess(CLI, { list: listing({ 41: 'node.exe', 42: 'claude-helper.exe', 43: 'xclaude' }) })
  for (const pid of [41, 42, 43]) assert.equal(proc.alive(pid), false, String(pid))
})

test('a gone pid is not alive', () => {
  assert.equal(hostProcess(CLI, { list: listing({}) }).alive(41), false)
})

test('a pid that is no process is never alive and never listed', () => {
  const asked = []
  const proc = hostProcess(CLI, { list: (pid) => { asked.push(pid); return 'claude.exe' } })
  for (const pid of [0, -1, 1.5, NaN, undefined]) assert.equal(proc.alive(pid), false, String(pid))
  assert.deepEqual(asked, [])
})

/** A child node process that runs until it is killed; removed after the test. */
async function idleChild(t) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, env })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill() })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  return { child, exited, running: () => child.exitCode === null && child.signalCode === null }
}

test('kill ends a pid only while its image is the CLI', { timeout: 10_000 }, async (t) => {
  const { child, exited, running } = await idleChild(t)
  hostProcess(CLI, { list: listing({ [child.pid]: 'node.exe' }) }).kill(child.pid)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(running(), true, 'a pid whose image is another program is left running')
  hostProcess(CLI, { list: listing({ [child.pid]: 'claude.exe' }) }).kill(child.pid)
  await exited
  assert.equal(running(), false)
})

test('a real process is alive only for its own executable, and killed only by it', { timeout: 10_000 }, async (t) => {
  const { child, exited, running } = await idleChild(t)
  assert.equal(hostProcess(process.execPath).alive(child.pid), true, 'the image of a node child is node')
  const claude = hostProcess('claude')
  assert.equal(claude.alive(child.pid), false, 'a node child is not the claude CLI')
  claude.kill(child.pid)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(running(), true, "the claude port's kill leaves a node child running")
  hostProcess(process.execPath).kill(child.pid)
  await exited
  assert.equal(running(), false)
})
