// test/approval-tokens.test.mjs — pins the token an act's question must carry and the terminal as
// an approver of record.
//
// Design: docs/DESIGN.md#the-users-word.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { actToken, approvalState, recordApproval } from '../lib/approval.mjs'
import { readLog } from '../lib/ledger.mjs'
import { specPath } from '../lib/store.mjs'

const HASH = '0a1b2c3d4e5f6071'

test('an approval token names the folder and the first eight of the hash', () => {
  assert.equal(actToken({ act: 'approve', folder: 'api', hash: HASH }), 'approve api@0a1b2c3d')
})

test('a ruled change\'s token names the ruled line', () => {
  assert.equal(actToken({ act: 'approve', folder: 'api', hash: HASH, seq: 41 }), 'approve api@0a1b2c3d#41')
})

test('a landing token names the effort and the head', () => {
  assert.equal(actToken({ act: 'land', effort: 'e1', hash: 'ffffffff00001111' }), 'land e1@ffffffff')
})

test('an act with no token form is refused', () => {
  assert.throws(() => actToken({ act: 'merge', folder: 'api', hash: HASH }))
})

function effort(t) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-tokens-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const fixture = readFileSync(fileURLToPath(new URL('./fixtures/spec/root.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
  const text = fixture.split('\n').filter((l) => !l.startsWith('- **blocking:**')).join('\n')
  mkdirSync(dirname(specPath(repo, 'e1', '.')), { recursive: true })
  writeFileSync(specPath(repo, 'e1', '.'), text)
  return repo
}

test('the approval state carries the token for the spec as it stands', (t) => {
  const repo = effort(t)
  const st = approvalState(repo, 'e1', '.')
  assert.equal(st.token, actToken({ act: 'approve', folder: '.', hash: st.hash }))
})

test('the terminal is an approver of record', (t) => {
  const repo = effort(t)
  assert.equal(recordApproval(repo, 'e1', '.', { by: 'terminal' }).ok, true)
  assert.equal(readLog(repo, 'e1', 'ledger').entries.at(-1).by, 'terminal')
})

test('an approver that is not the user, the terminal or a ruling is refused', (t) => {
  const repo = effort(t)
  assert.equal(recordApproval(repo, 'e1', '.', { by: 'session' }).ok, false)
})

test('a folder without a spec has no token', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-tokens-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  assert.equal(approvalState(repo, 'e1', '.').token, '')
})

test('an edited spec has a new token', (t) => {
  const repo = effort(t)
  const before = approvalState(repo, 'e1', '.').token
  writeFileSync(specPath(repo, 'e1', '.'), readFileSync(specPath(repo, 'e1', '.'), 'utf8') + '\nOne more line.\n')
  const after = approvalState(repo, 'e1', '.')
  assert.notEqual(after.token, before)
  assert.equal(after.token, actToken({ act: 'approve', folder: '.', hash: after.hash }))
})

test('approving twice from the terminal keeps the folder approved at one token', (t) => {
  const repo = effort(t)
  const token = approvalState(repo, 'e1', '.').token
  assert.equal(recordApproval(repo, 'e1', '.', { by: 'terminal' }).ok, true)
  assert.equal(recordApproval(repo, 'e1', '.', { by: 'terminal' }).ok, true)
  const st = approvalState(repo, 'e1', '.')
  assert.equal(st.state, 'approved')
  assert.equal(st.token, token)
})
