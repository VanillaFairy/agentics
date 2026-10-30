// test/status-holder.test.mjs — who holds a stop, as the snapshot entry says it, from records on disk.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { append } from '../lib/ledger.mjs'
import { nodeOf } from '../lib/status.mjs'
import { executionDir, executionRunId, runJsonPath, writeJson } from '../lib/store.mjs'
import { leaf, repo, root, STAMP } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const SESSION = '05eff0cd-be9b-4641-90bd-3d7e8fbb9e00'
const MINUTE = 60000

function world(t) {
  const r = repo()
  const config = mkdtempSync(join(tmpdir(), 'holder-'))
  const before = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = before
    rmSync(r, { recursive: true, force: true })
    rmSync(config, { recursive: true, force: true })
  })
  assert.equal(seedTree(r, E, [root(), leaf('a', { expects: ['src/a.mjs'] })]).ok, true)
  return { r, config }
}

function ranFrom(r, { session = SESSION, pid = 0 } = {}) {
  mkdirSync(executionDir(r, E, STAMP), { recursive: true })
  const run = executionRunId(E, STAMP)
  writeJson(runJsonPath(r, run), { run, session, pid, heartbeat_at: new Date().toISOString() })
}

function transcriptAged(config, ms) {
  const folder = join(config, 'projects', 'p')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, SESSION + '.jsonl')
  writeFileSync(file, '{}\n')
  const at = new Date(Date.now() - ms)
  utimesSync(file, at, at)
}

const park = (r) => append(r, E, 'events', { kind: 'parked', node: 'a', execution: '', return: 'integration_critical', question: 'q' }).seqs[0]
const ask = (r) => append(r, E, 'ledger', { kind: 'asked', nodes: ['a'] }).seqs[0]
const answer = (r, asked) => append(r, E, 'ledger', { kind: 'answered', asked, nodes: ['a'], answers: [], by: 'user' }).seqs[0]

test('a stop with a question open since it is the user\'s, naming the question', (t) => {
  const { r } = world(t)
  park(r)
  const asked = ask(r)
  const { event } = nodeOf(r, E, 'a')
  assert.equal(event.holder, 'user')
  assert.equal(event.asked, asked)
})

test('a stop the session is active on, with no question open, is the session\'s', (t) => {
  const { r, config } = world(t)
  ranFrom(r)
  transcriptAged(config, MINUTE)
  park(r)
  const { event } = nodeOf(r, E, 'a')
  assert.equal(event.holder, 'session')
  assert.equal(event.asked, undefined)
})

test('a stop whose run is live is the session\'s, however quiet its transcript', (t) => {
  const { r } = world(t)
  ranFrom(r, { pid: process.pid })
  park(r)
  assert.equal(nodeOf(r, E, 'a').event.holder, 'session')
})

test('a stop with no live run and a quiet session is nobody\'s', (t) => {
  const { r, config } = world(t)
  ranFrom(r)
  transcriptAged(config, 11 * MINUTE)
  park(r)
  assert.equal(nodeOf(r, E, 'a').event.holder, 'nobody')
})

test('a stop whose run names no session is nobody\'s', (t) => {
  const { r } = world(t)
  ranFrom(r, { session: '' })
  park(r)
  assert.equal(nodeOf(r, E, 'a').event.holder, 'nobody')
})

test('an answered question hands the stop back: the session\'s while it is active, else nobody\'s', (t) => {
  const { r, config } = world(t)
  ranFrom(r)
  park(r)
  answer(r, ask(r))
  transcriptAged(config, MINUTE)
  assert.equal(nodeOf(r, E, 'a').event.holder, 'session')
  transcriptAged(config, 11 * MINUTE)
  assert.equal(nodeOf(r, E, 'a').event.holder, 'nobody')
})

test('a question opened before this stop does not hold it', (t) => {
  const { r, config } = world(t)
  ranFrom(r)
  transcriptAged(config, MINUTE)
  ask(r)
  park(r)
  assert.equal(nodeOf(r, E, 'a').event.holder, 'session')
})

test('a question about another node does not hold this stop', (t) => {
  const { r, config } = world(t)
  ranFrom(r)
  transcriptAged(config, MINUTE)
  park(r)
  append(r, E, 'ledger', { kind: 'asked', nodes: ['.'] })
  assert.equal(nodeOf(r, E, 'a').event.holder, 'session')
})

test('an escalation is held the same way', (t) => {
  const { r, config } = world(t)
  ranFrom(r)
  transcriptAged(config, MINUTE)
  append(r, E, 'events', { kind: 'escalated', node: 'a', execution: '', reason: 'blocked', detail: '' })
  assert.equal(nodeOf(r, E, 'a').event.holder, 'session')
  ask(r)
  assert.equal(nodeOf(r, E, 'a').event.holder, 'user')
})
