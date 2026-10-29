// test/fast/verify-journal.test.mjs — lib/verify.mjs, pure: the base64 command transport and the
// journal line. The CLI's transport and the journalled observation against real repositories are
// test/verify-journal.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { journalLine, parseArgs } from '../../lib/verify.mjs'

test('base64 command transport decodes to the same commands', () => {
  const encoded = Buffer.from('npm run build --workspace "a b"', 'utf8').toString('base64')
  assert.equal(parseArgs(['--build-b64', encoded]).build, 'npm run build --workspace "a b"')
})

test('journalLine is pure and carries the observed head', () => {
  const line = journalLine({ node: 'a/b', branch: 'agentics/e--a.b', worktree: 'C:\\w', base: 'b0' },
    { stop_reason: 'completed', build: 'passed', typecheck: 'absent', suite: 'passed', failing_tests: [],
      discriminator: [], mutations: [], series_findings: [], checks: [{ command: 'x', status: 'passed' }] },
    'h1')
  assert.equal(line.node, 'a/b')
  assert.equal(line.worktree, 'C:/w')
  assert.equal(line.head_sha, 'h1')
  assert.equal(line.base_sha, 'b0')
  assert.equal('seq' in line, false, 'the ledger mints seq; a line never carries one in')
  assert.deepEqual(line.checks, [{ command: 'x', status: 'passed' }])
})
