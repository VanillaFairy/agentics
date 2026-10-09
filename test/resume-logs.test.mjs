// test/resume-logs.test.mjs — lib/resume.mjs `executionLogs`: one log of every execution of an
// effort, read in stamp order, the asking execution's included; `journalsOf` reads through it.
//
// Design: docs/DESIGN.md#resume-and-checkpoints.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { append } from '../lib/ledger.mjs'
import { executionLogs, journalsOf } from '../lib/resume.mjs'

const E = 'e1'
const OLDER = '20260101-120000'
const NEWER = '20260102-120000'
const UNSEEN = '20260103-120000'

function seeded(t) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-resume-logs-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const put = (log, entry) => assert.equal(append(repo, E, log, [entry]).ok, true)
  put('state:' + NEWER, { kind: 'breach_reverted', node: 'a', paths: ['x'], sha: 'b2' })
  put('state:' + OLDER, { kind: 'breach_reverted', node: 'a', paths: ['x'], sha: 'b1' })
  put('journal:' + OLDER, { kind: 'authored', node: 'a', role: 'test-author', round: 1, sha: 'j1' })
  return repo
}

test('executionLogs reads one log of every execution of the effort, in stamp order', (t) => {
  const repo = seeded(t)
  assert.deepEqual(executionLogs(repo, E, NEWER, 'state').map((e) => e.sha), ['b1', 'b2'])
  assert.deepEqual(executionLogs(repo, E, NEWER, 'journal').map((e) => e.sha), ['j1'])
  assert.deepEqual(journalsOf(repo, E, NEWER), executionLogs(repo, E, NEWER, 'journal'))
})

test('executionLogs reads the asking execution though it has no folder yet', (t) => {
  const repo = seeded(t)
  assert.deepEqual(executionLogs(repo, E, UNSEEN, 'state').map((e) => e.sha), ['b1', 'b2'])
  assert.equal(append(repo, E, 'state:' + UNSEEN, [{ kind: 'breach_reverted', node: 'a', paths: ['y'], sha: 'b3' }]).ok, true)
  assert.deepEqual(executionLogs(repo, E, UNSEEN, 'state').map((e) => e.sha), ['b1', 'b2', 'b3'])
})
