// test/store-ids.test.mjs — pins the 5.0 store additions: deterministic session ids and dispatch
// keys, run and return paths, and resolveHandle, which refuses a name that resolves to nothing.
//
// Design: docs/DESIGN.md#the-agent-runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  AGENTICS_NAMESPACE, NAME_KEY_MAX, dispatchKey, effortDir, executionDir, livePath, resolveHandle, returnPath, runDir,
  sessionOf, specPath, uuidV5,
} from '../lib/store.mjs'

const V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const THREAD = { effort: 'e1', execution: '20261003-120000', node: 'a/b', role: 'implementer', thread: 'producer', gen: 0 }

test('uuidV5 matches the published vector for the DNS namespace', () => {
  assert.equal(uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '886313e1-3b8a-5372-9b90-0c9aee199e5d')
})

test('uuidV5 returns a version-5, RFC-variant uuid', () => {
  assert.match(uuidV5('anything'), V5)
})

test('uuidV5 defaults to the agentics namespace', () => {
  assert.equal(uuidV5('anything'), uuidV5('anything', AGENTICS_NAMESPACE))
  assert.notEqual(uuidV5('anything'), uuidV5('anything', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'))
})

test('sessionOf is the same for the same thread and generation', () => {
  assert.equal(sessionOf(THREAD), sessionOf({ ...THREAD }))
  assert.match(sessionOf(THREAD), V5)
})

test('sessionOf differs when any field of the thread differs', () => {
  const base = sessionOf(THREAD)
  for (const [key, value] of [['effort', 'e2'], ['execution', '20261003-120001'], ['node', 'a/c'],
    ['role', 'reviewer'], ['thread', 'tests'], ['gen', 1]]) {
    assert.notEqual(sessionOf({ ...THREAD, [key]: value }), base, key + ' did not change the id')
  }
})

test('dispatchKey names the role, the thread and the round', () => {
  const key = dispatchKey({ node: 'a/b', role: 'implementer', thread: 'producer', round: 2 })
  assert.match(key, /implementer/)
  assert.match(key, /producer/)
  assert.match(key, /r2/)
})

test('dispatchKey differs by attempt', () => {
  const call = { node: 'a/b', role: 'implementer', thread: 'producer', round: 1 }
  assert.notEqual(dispatchKey(call), dispatchKey({ ...call, attempt: 1 }))
})

test('dispatchKey stays within the name bound for a deep node', () => {
  const node = Array.from({ length: 12 }, (_, i) => 'segment-' + i).join('/')
  assert.ok(dispatchKey({ node, role: 'implementer', thread: 'producer', round: 1 }).length <= NAME_KEY_MAX)
})

test('dispatchKey is file-safe for any thread name', () => {
  const key = dispatchKey({ node: 'a/b', role: 'reviewer', thread: 'review:a/b\\c:1', round: 1 })
  assert.doesNotMatch(key, /[:/\\]/)
})

test('dispatchKey names the root node', () => {
  assert.match(dispatchKey({ node: '.', role: 'planner', thread: 'spec', round: 1 }), /^root\./)
})

test('return and live paths sit under the given directory', () => {
  assert.equal(returnPath('/x', 'k'), join('/x', 'returns', 'k.json'))
  assert.equal(livePath('/x', 'k'), join('/x', 'live', 'k.json'))
})

test('runDir sits under the project state', () => {
  assert.match(runDir('/repo', 'run-1').split('\\').join('/'), /\/\.agentics\/\.state\/runs\/run-1$/)
})

function store(t) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-store-ids-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const put = (path) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '# x\n') }
  put(specPath(repo, 'e1', '.'))
  put(specPath(repo, 'e1', 'api'))
  mkdirSync(executionDir(repo, 'e1', '20261003-120000'), { recursive: true })
  mkdirSync(runDir(repo, 'survey-1'), { recursive: true })
  return repo
}

test('resolveHandle accepts an effort that exists', (t) => {
  const repo = store(t)
  assert.deepEqual(resolveHandle(repo, 'effort', 'e1'), { ok: true, value: 'e1' })
})

test('resolveHandle refuses an effort that does not exist', (t) => {
  const repo = store(t)
  const out = resolveHandle(repo, 'effort', 'e2')
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'unknown_effort')
})

test('resolveHandle refuses a name that breaks the segment rule', (t) => {
  const repo = store(t)
  assert.equal(resolveHandle(repo, 'effort', '../e1').error.kind, 'unknown_effort')
})

test('resolveHandle accepts the root folder and a sub-folder with specs', (t) => {
  const repo = store(t)
  assert.deepEqual(resolveHandle(repo, 'folder', '.', { effort: 'e1' }), { ok: true, value: '.' })
  assert.deepEqual(resolveHandle(repo, 'folder', 'api', { effort: 'e1' }), { ok: true, value: 'api' })
})

test('resolveHandle refuses a folder with no spec', (t) => {
  const repo = store(t)
  assert.equal(resolveHandle(repo, 'folder', 'apl', { effort: 'e1' }).error.kind, 'unknown_folder')
})

test('resolveHandle accepts an execution that exists and refuses a mistyped stamp', (t) => {
  const repo = store(t)
  assert.equal(resolveHandle(repo, 'execution', '20261003-120000', { effort: 'e1' }).ok, true)
  assert.equal(resolveHandle(repo, 'execution', '20261003-12000', { effort: 'e1' }).error.kind, 'unknown_execution')
})

test('resolveHandle accepts a run that exists and refuses one that does not', (t) => {
  const repo = store(t)
  assert.equal(resolveHandle(repo, 'run', 'survey-1').ok, true)
  assert.equal(resolveHandle(repo, 'run', 'survey-2').error.kind, 'unknown_run')
})

test('resolveHandle refuses a kind it does not know', (t) => {
  const repo = store(t)
  assert.equal(resolveHandle(repo, 'colour', 'red').error.kind, 'unknown_kind')
})

test('resolveHandle never reads an empty value as the root', (t) => {
  const repo = store(t)
  assert.equal(resolveHandle(repo, 'effort', '').ok, false)
  assert.ok(effortDir(repo, 'e1'))
})

test('resolveHandle refuses a name that climbs to a path that exists', (t) => {
  const repo = store(t)
  assert.equal(resolveHandle(repo, 'effort', 'e1/..').error.kind, 'unknown_effort')
  assert.equal(resolveHandle(repo, 'folder', 'api/../api', { effort: 'e1' }).error.kind, 'unknown_folder')
  assert.equal(resolveHandle(repo, 'run', '..').error.kind, 'unknown_run')
})

test('resolveHandle refuses a well-formed stamp that names no execution, and a folder in the stamp place', (t) => {
  const repo = store(t)
  assert.equal(resolveHandle(repo, 'execution', '20261003-130000', { effort: 'e1' }).error.kind, 'unknown_execution')
  mkdirSync(executionDir(repo, 'e1', 'notastamp'), { recursive: true })
  assert.equal(resolveHandle(repo, 'execution', 'notastamp', { effort: 'e1' }).error.kind, 'unknown_execution')
})

test('resolveHandle refuses a run id outside the run-id form even when a directory has it', (t) => {
  const repo = store(t)
  mkdirSync(runDir(repo, 'Bad_Run'), { recursive: true })
  assert.equal(resolveHandle(repo, 'run', 'Bad_Run').error.kind, 'unknown_run')
})
