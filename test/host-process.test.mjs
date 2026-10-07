// test/host-process.test.mjs — pins the production process port: a pid is alive, and is killed, only
// while it runs the host CLI — its image is the CLI's executable, or it is node running the CLI's
// script — so a pid the system reused is never killed.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hostProcess } from '../lib/host.mjs'

const CLI = join('C:', 'Users', 'u', '.local', 'bin', 'claude.exe')
const SCRIPT = join('C:', 'Users', 'u', 'AppData', 'npm', 'claude')
const REAL = join('C:', 'Users', 'u', 'AppData', 'npm', 'node_modules', 'claude-code', 'cli.js')
const realpath = (path) => (path === SCRIPT ? REAL : path)
const listing = (procs) => (pid) => procs[pid] ?? null
const proc = (image, args = '') => ({ image, args })
const quoted = (path) => '"' + path + '"'

test('a pid whose image is the CLI is alive', () => {
  assert.equal(hostProcess(CLI, { list: listing({ 41: proc('claude.exe') }) }).alive(41), true)
})

test('image names compare without case', () => {
  assert.equal(hostProcess(CLI, { list: listing({ 41: proc('CLAUDE.EXE') }) }).alive(41), true)
  assert.equal(hostProcess(join('D:', 'Tools', 'Claude.exe'), { list: listing({ 41: proc('claude.exe') }) }).alive(41), true)
})

test('image names compare without .exe', () => {
  assert.equal(hostProcess(CLI, { list: listing({ 41: proc('claude') }) }).alive(41), true)
  assert.equal(hostProcess('/usr/local/bin/claude', { list: listing({ 41: proc('claude.exe') }) }).alive(41), true)
})

test('a pid whose image is another program is not alive', () => {
  const port = hostProcess(CLI, { list: listing({ 41: proc('node.exe'), 42: proc('claude-helper.exe'), 43: proc('xclaude') }) })
  for (const pid of [41, 42, 43]) assert.equal(port.alive(pid), false, String(pid))
})

test('a gone pid is not alive', () => {
  assert.equal(hostProcess(CLI, { list: listing({}) }).alive(41), false)
})

test('a pid that is no process is never alive and never listed', () => {
  const asked = []
  const port = hostProcess(CLI, { list: (pid) => { asked.push(pid); return proc('claude.exe') } })
  for (const pid of [0, -1, 1.5, NaN, undefined]) assert.equal(port.alive(pid), false, String(pid))
  assert.deepEqual(asked, [])
})

test('node running the CLI by its path is alive', () => {
  const port = hostProcess(SCRIPT, { realpath, list: listing({
    41: proc('node', 'node ' + SCRIPT + ' -p --output-format stream-json'),
    42: proc('node.exe', quoted(join('C:', 'Program Files', 'nodejs', 'node.exe')) + ' ' + quoted(SCRIPT) + ' -p'),
    43: proc('NODE.EXE', 'node ' + SCRIPT),
  }) })
  for (const pid of [41, 42, 43]) assert.equal(port.alive(pid), true, String(pid))
})

test('node running the CLI by its real path is alive', () => {
  const port = hostProcess(SCRIPT, { realpath, list: listing({ 41: proc('node', 'node ' + REAL + ' -p') }) })
  assert.equal(port.alive(41), true)
})

test('node running another script is not alive', () => {
  const other = join('C:', 'Users', 'u', 'tools', 'server.js')
  const port = hostProcess(SCRIPT, { realpath, list: listing({ 41: proc('node', 'node ' + other + ' --port 80'), 42: proc('node', '') }) })
  for (const pid of [41, 42]) assert.equal(port.alive(pid), false, String(pid))
})

test("a command line naming a longer path than the CLI's is not alive", () => {
  const port = hostProcess(SCRIPT, { realpath, list: listing({
    41: proc('node', 'node ' + SCRIPT + '-helper -p'),
    42: proc('node', 'node ' + join('D:', 'old') + SCRIPT + ' -p'),
    43: proc('node', 'node ' + REAL + '.bak'),
  }) })
  for (const pid of [41, 42, 43]) assert.equal(port.alive(pid), false, String(pid))
})

test('only node is read by its command line', () => {
  const port = hostProcess(SCRIPT, { realpath, list: listing({ 41: proc('python', 'python ' + SCRIPT), 42: proc('bash.exe', 'bash ' + REAL) }) })
  for (const pid of [41, 42]) assert.equal(port.alive(pid), false, String(pid))
})

test('a CLI whose real path cannot be read is matched by its own path', () => {
  const unreadable = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  const port = hostProcess(SCRIPT, { realpath: unreadable, list: listing({ 41: proc('node', 'node ' + SCRIPT), 42: proc('node', 'node ' + REAL) }) })
  assert.equal(port.alive(41), true)
  assert.equal(port.alive(42), false)
})

/** A child node process that runs until it is killed; removed after the test. */
async function idleChild(t, args = ['-e', 'setInterval(() => {}, 1000)']) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true, env })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited } })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  return { child, exited, running: () => child.exitCode === null && child.signalCode === null }
}

test('kill ends a pid only while its image is the CLI', { timeout: 10_000 }, async (t) => {
  const { child, exited, running } = await idleChild(t)
  hostProcess(CLI, { list: listing({ [child.pid]: proc('node.exe') }) }).kill(child.pid)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(running(), true, 'a pid whose image is another program is left running')
  hostProcess(CLI, { list: listing({ [child.pid]: proc('claude.exe') }) }).kill(child.pid)
  await exited
  assert.equal(running(), false)
})

test('kill ends a node pid only while its command line names the CLI', { timeout: 10_000 }, async (t) => {
  const { child, exited, running } = await idleChild(t)
  hostProcess(SCRIPT, { realpath, list: listing({ [child.pid]: proc('node', 'node other.js') }) }).kill(child.pid)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(running(), true, 'node running another script is left running')
  hostProcess(SCRIPT, { realpath, list: listing({ [child.pid]: proc('node', 'node ' + SCRIPT) }) }).kill(child.pid)
  await exited
  assert.equal(running(), false)
})

test('a real process is alive only for its own executable, and killed only by it', { timeout: 30_000 }, async (t) => {
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

test('a real node process is alive for the script its command line names', { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-host-process-'))
  const script = join(dir, 'cli.js')
  writeFileSync(script, 'setInterval(() => {}, 1000)')
  const { child, exited, running } = await idleChild(t, [script])
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(hostProcess(script).alive(child.pid), true, 'node running the script is that script')
  assert.equal(hostProcess(join(dir, 'other.js')).alive(child.pid), false, 'node running the script is not another script')
  hostProcess(script).kill(child.pid)
  await exited
  assert.equal(running(), false)
})

test('a real pid that has exited is not alive', () => {
  const env = { ...process.env, NODE_TEST_CONTEXT: '' }
  const { pid } = spawnSync(process.execPath, ['-e', ''], { env })
  assert.equal(hostProcess(process.execPath).alive(pid), false)
})
