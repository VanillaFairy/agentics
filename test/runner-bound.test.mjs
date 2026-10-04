// test/runner-bound.test.mjs — pins the production runner: runAgent bound to the CLI spawner, a files
// port that replaces a JSON file whole, the identity-checked process port and a watch on the checkout
// for a role that runs commands. The CLI here is test/harness/fake-claude.mjs run by node.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boundRunner } from '../lib/runner.mjs'
import { dispatchKey, returnPath, runDir, sessionOf } from '../lib/store.mjs'
import { memoryLog } from './harness/memory-log.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE = join(here, 'harness', 'fake-claude.mjs')
const SUCCESS = readFileSync(join(here, 'fixtures', 'runner', 'stream-success.jsonl'), 'utf8').split(/\r?\n/).filter((l) => l.trim())
const OUT = JSON.parse(SUCCESS.at(-1)).structured_output
const SCHEMA = { type: 'object', properties: { status: { enum: ['done', 'blocked'] }, text: { type: 'string' } }, required: ['status'] }
const RUN = '20260101-000000-test'
const ids = { effort: '', execution: RUN, node: '', role: 'scout', thread: 'plan' }
const S = sessionOf(ids)
const D = dispatchKey({ node: '', role: 'scout', thread: 'plan', round: 1 })
const EARLIER = dispatchKey({ node: '', role: 'scout', thread: 'plan', round: 0 })
const SPAWNS = { timeout: 30_000 }

/** A git repository with one commit, in a fresh folder named from `prefix`; removed after the test. */
function repoIn(t, prefix = 'agentics-bound-') {
  const base = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const repo = join(base, 'repo')
  mkdirSync(repo)
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
  git('init', '-q')
  git('config', 'user.email', 'a@b.c')
  git('config', 'user.name', 'n')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return { base, repo, git }
}

/** The fake CLI's scenario, kept outside the repository, and the environment that points it there. */
function scenario(base, calls) {
  const file = join(base, 'scenario.json')
  writeFileSync(file, JSON.stringify({ calls }))
  const record = join(base, 'given.jsonl')
  const env = { ...process.env, FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_LOG: record }
  delete env.NODE_TEST_CONTEXT
  return { env, given: () => readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) }
}

const READER = { name: 'scout', tools: ['Read', 'Grep', 'Glob'] }
const SHELL = { name: 'reviewer', tools: ['Read', 'Grep', 'Glob', 'Bash'] }

const callIn = (repo, base, { role = READER, ...over } = {}) => ({
  dispatch: D, node: '', round: 1,
  thread: { key: 'plan', session: S, gen: 0 },
  role: { ...role, systemPromptFile: join(base, 'role prompt.md') },
  cwd: repo, brief: 'Find where the store is written.', tier: { model: 'sonnet', effort: 'medium' },
  permissions: { allowed: ['Read'], disallowed: [] }, schema: SCHEMA, carries: [], dir: runDir(repo, RUN), resume: false,
  ...over,
})

const bound = (repo, env, log) => boundRunner({ repo, cli: process.execPath, prefix: [FAKE], log, env })
const ofKind = (log, kind) => log.entries().filter((e) => e.kind === kind)

/**
 * A long-lived child running `command`; ended, and `cleanup` run, after the test. Call it before
 * anything else registers an `after` hook: hooks run in the order they were added, and a running
 * executable cannot be removed on Windows.
 */
async function idle(t, command, cleanup = () => {}) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const child = spawn(command, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, env })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const running = () => child.exitCode === null && child.signalCode === null
  t.after(async () => {
    if (running()) { child.kill(); await exited }
    cleanup()
  })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  return { child, exited, running }
}

/** A node process under another executable's name: a live pid whose image is not the CLI's. */
async function stranger(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-stranger-'))
  const exe = join(dir, 'stranger' + extname(process.execPath))
  copyFileSync(process.execPath, exe)
  return idle(t, exe, () => rmSync(dir, { recursive: true, force: true }))
}

const seedOrphan = (log, pid) => log.append('dispatched', {
  dispatch: EARLIER, node: '', round: 0, thread: 'plan', role: 'scout', model: 'sonnet', effort: 'medium', session: S, brief_digest: 'x', carries: [], pid,
})

test('a return replaces an earlier one whole, with nothing left beside it', SPAWNS, async (t) => {
  const { base, repo } = repoIn(t)
  const { env } = scenario(base, [{ stdout: SUCCESS }])
  const dir = runDir(repo, RUN)
  mkdirSync(join(dir, 'returns'), { recursive: true })
  writeFileSync(returnPath(dir, D), JSON.stringify({ status: 'blocked', text: 'from an earlier attempt' }))
  const out = await bound(repo, env, memoryLog())(callIn(repo, base))
  assert.equal(out.status, 'returned')
  assert.deepEqual(JSON.parse(readFileSync(returnPath(dir, D), 'utf8')), OUT)
  assert.deepEqual(readdirSync(join(dir, 'returns')), [D + '.json'])
})

test('a call returns and its return is stored whole, with nothing left beside it', SPAWNS, async (t) => {
  const { base, repo, git } = repoIn(t)
  const { env, given } = scenario(base, [{ stdout: SUCCESS }])
  const out = await bound(repo, env, memoryLog())(callIn(repo, base))
  assert.equal(out.status, 'returned')
  assert.deepEqual(out.output, OUT)
  assert.equal(given()[0].argv[0], '-p', 'the prefix runs the CLI, and the call\'s own arguments follow it')
  const dir = runDir(repo, RUN)
  assert.deepEqual(JSON.parse(readFileSync(returnPath(dir, D), 'utf8')), OUT)
  assert.deepEqual(readdirSync(join(dir, 'returns')), [D + '.json'], 'no temporary file is left beside the return')
  assert.deepEqual(existsSync(join(dir, 'live')) ? readdirSync(join(dir, 'live')) : [], [], 'live activity is gone, and no temporary file of it')
  assert.equal(git('status', '--porcelain').stdout, '', "the run's files are never the user's changes")
})

test('the call is recorded in the given log with its CLI pid', SPAWNS, async (t) => {
  const { base, repo } = repoIn(t)
  const { env } = scenario(base, [{ stdout: SUCCESS }])
  const log = memoryLog()
  await bound(repo, env, log)(callIn(repo, base))
  assert.deepEqual(log.entries().map((e) => e.kind), ['dispatched', 'returned'])
  assert.ok(ofKind(log, 'dispatched')[0].pid > 0, 'the dispatch names the process that ran it')
  assert.equal(ofKind(log, 'returned')[0].status, 'returned')
})

/** A log port that edits a file in the repository when the CLI starts: the user working while the call runs. */
function editingLog(repo) {
  const log = memoryLog()
  return {
    log,
    port: {
      append(kind, fields) {
        if (kind === 'dispatched') writeFileSync(join(repo, 'notes.md'), 'edited while the call ran\n')
        return log.append(kind, fields)
      },
      entries: () => log.entries(),
    },
  }
}

test('a role that runs commands is watched: a file written during its call is recorded', SPAWNS, async (t) => {
  const { base, repo } = repoIn(t)
  const { env } = scenario(base, [{ stdout: SUCCESS }])
  const { log, port } = editingLog(repo)
  const out = await bound(repo, env, port)(callIn(repo, base, { role: SHELL }))
  assert.equal(out.status, 'returned')
  assert.deepEqual(ofKind(log, 'checkout_changed').map((e) => [e.dispatch, e.paths]), [[D, ['notes.md']]])
})

test('a role that runs no commands is not watched', SPAWNS, async (t) => {
  const { base, repo } = repoIn(t)
  const { env } = scenario(base, [{ stdout: SUCCESS }])
  const { log, port } = editingLog(repo)
  const out = await bound(repo, env, port)(callIn(repo, base, { role: READER }))
  assert.equal(out.status, 'returned')
  assert.deepEqual(ofKind(log, 'checkout_changed'), [])
})

test('an orphan whose image is not the CLI is left running', SPAWNS, async (t) => {
  const other = await stranger(t)
  const { base, repo } = repoIn(t)
  const { env } = scenario(base, [{ stdout: SUCCESS }])
  const log = memoryLog()
  seedOrphan(log, other.child.pid)
  const out = await bound(repo, env, log)(callIn(repo, base, { resume: true }))
  assert.equal(out.status, 'returned')
  assert.equal(other.running(), true, 'a pid whose image is not the CLI is never killed')
  assert.deepEqual(ofKind(log, 'returned').filter((e) => e.status === 'cut_off'), [])
})

test('an orphan whose image is the CLI is ended before a resume', SPAWNS, async (t) => {
  const orphan = await idle(t, process.execPath)
  const { base, repo } = repoIn(t)
  const { env } = scenario(base, [{ stdout: SUCCESS }])
  const log = memoryLog()
  seedOrphan(log, orphan.child.pid)
  const out = await bound(repo, env, log)(callIn(repo, base, { resume: true }))
  assert.equal(out.status, 'returned')
  await orphan.exited
  assert.equal(orphan.running(), false)
  assert.deepEqual(ofKind(log, 'returned').filter((e) => e.status === 'cut_off').map((e) => [e.dispatch, e.cause]), [[EARLIER, 'orphan_ended']])
})

test('a repository under a path with a space runs a call', SPAWNS, async (t) => {
  const { base, repo } = repoIn(t, 'agentics bound first last ')
  assert.ok(repo.includes(' '))
  const { env, given } = scenario(base, [{ stdout: SUCCESS }, { stdout: SUCCESS }])
  const log = memoryLog()
  const run = bound(repo, env, log)
  const first = await run(callIn(repo, base, { role: SHELL }))
  assert.equal(first.status, 'returned')
  const again = await run(callIn(repo, base, { role: SHELL, dispatch: dispatchKey({ node: '', role: 'scout', thread: 'plan', round: 2 }), round: 2, resume: true }))
  assert.equal(again.status, 'returned', 'the session is resumed there too')
  const argv = given().map((g) => g.argv)
  assert.equal(argv[0][argv[0].indexOf('--system-prompt-file') + 1], join(base, 'role prompt.md'), 'a path with a space reaches the CLI whole')
  assert.equal(argv[1][argv[1].indexOf('--resume') + 1], S)
  assert.deepEqual(JSON.parse(readFileSync(returnPath(runDir(repo, RUN), D), 'utf8')), OUT)
  assert.deepEqual(ofKind(log, 'returned').map((e) => e.status), ['returned', 'returned'])
})
