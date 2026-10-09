// test/boundary-session-calls.test.mjs — the session's own calls against real git: retry and note
// name the open execution that holds the node, take no --execution, and land records a second
// landing killed before its record and refuses a check that names no commit.
//
// Design: docs/DESIGN.md#session-calls.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { land, landAct } from '../lib/boundary.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { executionDir, revParse } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { commitIn, git, leaf, repo, root } from './harness/boundary-fixture.mjs'

const BOUNDARY = fileURLToPath(new URL('../lib/boundary.mjs', import.meta.url))
const E = 'e1'
const EFFORT_BRANCH = 'agentics/' + E
const OLDER = '20260925-120000'
const NEWER = '20260925-130000'
const NEWEST = '20260925-140000'

/** A repository on `main`, removed after the test. */
function fresh(t) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  return r
}

/** A repository whose effort holds the folder `c` with the leaf `c/a`, and the leaf `b`. */
function seeded(t) {
  const r = fresh(t)
  seedTree(r, E, [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'] })])
  return r
}

/** An execution over `rootId` as its preflight leaves it; `closed` as its postflight leaves it. */
function execution(r, stamp, rootId, { closed = false } = {}) {
  const dir = executionDir(r, E, stamp)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'execution.json'), JSON.stringify({ stamp, root: rootId }))
  if (closed) append(r, E, 'state:' + stamp, { kind: 'closed', status: 'done' })
}

/** A session call through the boundary CLI, as develop runs it: what it prints. */
function call(r, verb, ...args) {
  const out = spawnSync(process.execPath, [BOUNDARY, verb, '--repo', r, '--effort', E, ...args], {
    encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' }, timeout: 30_000,
  })
  assert.equal(out.status, 0, out.stderr)
  return JSON.parse(out.stdout)
}

const eventsOf = (r, kind) => readTree(r, E).events.filter((e) => e.kind === kind)
const executionOf = (r, kind, id) => eventsOf(r, kind).filter((e) => e.node === id).map((e) => e.execution)
const escalate = (r, id, stamp) => append(r, E, 'events', { kind: 'escalated', node: id, execution: stamp, reason: 'blocked', detail: 'needs a key' })

// ================================================================== retry

test('retry clears the stop of each live node it names and of no other', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  escalate(r, 'c/a', OLDER)
  assert.equal(readTree(r, E).status.get('c/a').status, 'escalated')
  assert.deepEqual(call(r, 'retry', '--node', 'c/a', '--node', 'nope'), { retried: ['c/a'], error: null })
  assert.notEqual(readTree(r, E).status.get('c/a').status, 'escalated')
  assert.deepEqual(eventsOf(r, 'replanned').map((e) => [e.node, e.reason, e.by]), [['c/a', 'retry_escalated', 'session']])
})

test('retry names the open execution whose root holds the node, not a later one beside it', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  execution(r, NEWER, 'c')
  call(r, 'retry', '--node', 'b')
  assert.deepEqual(executionOf(r, 'replanned', 'b'), [OLDER])
})

test('retry names the latest of the open executions whose root holds the node', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  execution(r, NEWER, 'c')
  call(r, 'retry', '--node', 'c/a')
  assert.deepEqual(executionOf(r, 'replanned', 'c/a'), [NEWER])
})

test('retry never names a closed execution', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  execution(r, NEWEST, '.', { closed: true })
  call(r, 'retry', '--node', 'b')
  assert.deepEqual(executionOf(r, 'replanned', 'b'), [OLDER])
})

test('retry names no execution when no open one holds the node', (t) => {
  const r = seeded(t)
  call(r, 'retry', '--node', 'b')
  execution(r, NEWER, 'c')
  execution(r, NEWEST, '.', { closed: true })
  call(r, 'retry', '--node', 'b')
  assert.deepEqual(executionOf(r, 'replanned', 'b'), ['', ''])
})

test('an execution folder whose execution.json is gone holds no node', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  mkdirSync(executionDir(r, E, NEWER), { recursive: true })
  call(r, 'retry', '--node', 'b')
  call(r, 'note', '--node', 'b', '--text', 'learned')
  assert.deepEqual(executionOf(r, 'replanned', 'b'), [OLDER])
  assert.deepEqual(executionOf(r, 'noted', 'b'), [OLDER])
})

test('retry refuses --execution as an unknown flag, recording nothing', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  escalate(r, 'b', OLDER)
  const out = call(r, 'retry', '--execution', OLDER, '--node', 'b')
  assert.deepEqual(out.retried, [])
  assert.equal(out.error.kind, 'bad_arg')
  assert.ok(out.error.message.includes('--execution'), out.error.message)
  assert.equal(eventsOf(r, 'replanned').length, 0)
  assert.equal(readTree(r, E).status.get('b').status, 'escalated')
})

// ================================================================== note

test('note records what the session learned on the node and changes no status', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  escalate(r, 'b', OLDER)
  assert.deepEqual(call(r, 'note', '--node', 'b', '--text', ' the key is in the vault '), { noted: 'b', error: null })
  assert.deepEqual(eventsOf(r, 'noted').map((e) => [e.node, e.by, e.text]), [['b', 'session', 'the key is in the vault']])
  assert.equal(readTree(r, E).status.get('b').status, 'escalated')
})

test('note names the latest open execution whose root holds the node', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  execution(r, NEWER, 'c')
  execution(r, NEWEST, '.', { closed: true })
  call(r, 'note', '--node', 'c/a', '--text', 'one')
  call(r, 'note', '--node', 'b', '--text', 'two')
  assert.deepEqual(executionOf(r, 'noted', 'c/a'), [NEWER])
  assert.deepEqual(executionOf(r, 'noted', 'b'), [OLDER])
})

test('note names no execution when no open one holds the node', (t) => {
  const r = seeded(t)
  execution(r, NEWER, 'c')
  call(r, 'note', '--node', 'b', '--text', 'learned')
  assert.deepEqual(executionOf(r, 'noted', 'b'), [''])
})

test('note refuses --execution as an unknown flag, recording nothing', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  const out = call(r, 'note', '--execution', OLDER, '--node', 'b', '--text', 'learned')
  assert.equal(out.noted, '')
  assert.equal(out.error.kind, 'bad_arg')
  assert.ok(out.error.message.includes('--execution'), out.error.message)
  assert.equal(eventsOf(r, 'noted').length, 0)
})

test('an unknown flag where a value was due is the flag named, not the word after it', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  const out = call(r, 'note', '--node', '--execution', OLDER, '--text', 'learned')
  assert.equal(out.error.kind, 'bad_arg')
  assert.ok(out.error.message.includes('--execution'), out.error.message)
  assert.ok(!out.error.message.includes(OLDER), out.error.message)
  assert.equal(eventsOf(r, 'noted').length, 0)
})

test('a text that starts with -- is the text of note, not a flag', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  const out = call(r, 'note', '--node', 'b', '--text', '--force is wrong')
  assert.deepEqual([out.noted, out.error], ['b', null], JSON.stringify(out))
  assert.deepEqual(eventsOf(r, 'noted').map((e) => e.text), ['--force is wrong'])
})

test('note refuses a node that is not live and a text that says nothing, recording nothing', (t) => {
  const r = seeded(t)
  assert.match(call(r, 'note', '--node', 'nope', '--text', 'x').error, /no live node/)
  assert.match(call(r, 'note', '--node', 'b').error, /--text/)
  assert.match(call(r, 'note', '--node', 'b', '--text', '   ').error, /--text/)
  assert.equal(eventsOf(r, 'noted').length, 0)
})

// ================================================================== land

const landedEvents = (r) => readLog(r, E, 'events').entries.filter((e) => e.kind === 'landed')

/** The effort branch cut from the checkout's head with one commit of `file`; its head. */
function effortWork(r, file) {
  git(r, 'checkout', '-q', '-b', EFFORT_BRANCH)
  commitIn(r, { [file]: file + '\n' }, 'work in ' + file)
  git(r, 'checkout', '-q', 'main')
  return revParse(r, 'refs/heads/' + EFFORT_BRANCH)
}

/** A terminal that types back the token it is shown, and records each prompt. */
function typesBack() {
  const prompts = []
  const ask = async (prompt) => {
    prompts.push(prompt)
    return prompt.match(/land \S+@\S*/)[0]
  }
  return { opts: { env: {}, stdinIsTTY: true, ask }, prompts }
}

test('a second landing killed between its merge and its record is recorded by the next confirmed land', async (t) => {
  const r = fresh(t)
  effortWork(r, 'first.txt')
  assert.equal(land(r, E, 'merge').ok, true)
  const second = effortWork(r, 'second.txt')
  git(r, 'merge', '--no-ff', '--no-edit', '-m', 'Merge agentics effort ' + E, second)
  assert.equal(landedEvents(r).length, 1, 'the second merge left no record')
  const { opts, prompts } = typesBack()
  const out = await landAct(r, E, opts)
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.already, true)
  assert.equal(prompts.length, 1)
  const events = landedEvents(r)
  assert.equal(events.length, 2)
  assert.equal(events[1].merged_sha, revParse(r, 'HEAD'))
  assert.equal(events[1].by, 'terminal')
})

test('a land whose latest record already holds the effort head records nothing more', (t) => {
  const r = fresh(t)
  const head = effortWork(r, 'first.txt')
  assert.equal(land(r, E, 'merge').ok, true)
  git(r, 'branch', EFFORT_BRANCH, head)
  const out = land(r, E, 'merge')
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.already, true)
  assert.equal(landedEvents(r).length, 1)
})

test('the check over no effort branch and nothing landed is refused no_effort_branch, with no token', (t) => {
  const r = fresh(t)
  const out = land(r, E, 'check')
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(out.error.kind, 'no_effort_branch')
  assert.ok(out.error.message.includes(EFFORT_BRANCH), out.error.message)
  assert.equal(out.token, '')
})

test('the check over an effort landed and swept still stands', (t) => {
  const r = fresh(t)
  effortWork(r, 'first.txt')
  assert.equal(land(r, E, 'merge').ok, true)
  assert.equal(revParse(r, 'refs/heads/' + EFFORT_BRANCH), '', 'the landing swept its branch')
  const out = land(r, E, 'check')
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.token, 'land ' + E + '@')
})

test('landAct over no effort branch returns the check refusal and asks nobody', async (t) => {
  const r = fresh(t)
  const before = revParse(r, 'HEAD')
  const out = await landAct(r, E, { env: {}, stdinIsTTY: true, ask: async () => { throw new Error('nobody may be asked') } })
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(out.error.kind, 'no_effort_branch')
  assert.equal(revParse(r, 'HEAD'), before)
  assert.equal(landedEvents(r).length, 0)
})

test('a merge over no effort branch and nothing landed is refused no_effort_branch', (t) => {
  const r = fresh(t)
  const out = land(r, E, 'merge')
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(out.error.kind, 'no_effort_branch')
  assert.equal(landedEvents(r).length, 0)
})

test('a session call refuses a value that is not a handle and a text past its line, recording nothing', (t) => {
  const r = seeded(t)
  for (const out of [call(r, 'note', '--node', 'b', '--text', 'one\ntwo'), call(r, 'note', '--node', 'b', '--text', 'x'.repeat(301))]) {
    assert.deepEqual([out.noted, out.error.kind], ['', 'args_unreadable'])
  }
  const retried = call(r, 'retry', '--node', 'a b')
  assert.deepEqual([retried.retried, retried.error.kind], [[], 'args_unreadable'])
  const landed = call(r, 'land', '--action', 'check now')
  assert.deepEqual([landed.ok, landed.error.kind], [false, 'args_unreadable'])
  assert.equal(eventsOf(r, 'noted').length, 0)
})

test('a note past one line is refused naming --text-file, and --text-file records the file\'s text whole', (t) => {
  const r = seeded(t)
  const long = ['what stopped it:', 'the vault key was rotated', 'y'.repeat(400)].join('\n')
  const refused = call(r, 'note', '--node', 'b', '--text', long.replace(/\n/g, ' '))
  assert.deepEqual([refused.noted, refused.error.kind], ['', 'args_unreadable'])
  assert.match(refused.error.message, /--text-file/)
  assert.equal(eventsOf(r, 'noted').length, 0)

  const file = join(r, 'note.txt')
  writeFileSync(file, long)
  assert.deepEqual(call(r, 'note', '--node', 'b', '--text-file', file), { noted: 'b', error: null })
  assert.deepEqual(eventsOf(r, 'noted').map((e) => e.text), [long], 'the text, not the path')
})

test('a note by --text and --text-file is refused bad_args, and by a file that is none unknown_file', (t) => {
  const r = seeded(t)
  const file = join(r, 'note.txt')
  writeFileSync(file, 'x')
  assert.equal(call(r, 'note', '--node', 'b', '--text', 'y', '--text-file', file).error.kind, 'bad_args')
  assert.equal(call(r, 'note', '--node', 'b', '--text-file', join(r, 'missing.txt')).error.kind, 'unknown_file')
  assert.equal(eventsOf(r, 'noted').length, 0)
})
