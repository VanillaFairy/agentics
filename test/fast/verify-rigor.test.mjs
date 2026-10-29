// test/fast/verify-rigor.test.mjs — lib/verify.mjs, pure: which checks a rigor and role select
// (`checksFor`) and how named checks and every option parse (`parseArgs`). Each choice run against
// real repositories is test/verify-rigor.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checksFor, parseArgs } from '../../lib/verify.mjs'

const EXECUTION = '20260925-120000'
const check = (command) => ['--check-b64', Buffer.from(command, 'utf8').toString('base64')]

test('checksFor: the SPEC table, a role outranking its rigor and integration outranking both', () => {
  const pick = (o) => {
    const c = checksFor(o)
    return [c.profile, c.series, c.discriminator, c.mutations, c.checks, c.emptySeriesExpected]
  }
  assert.deepEqual(pick({ rigor: 'verify' }), ['verify', false, false, false, true, false])
  assert.deepEqual(pick({ rigor: 'trivial' }), ['trivial', true, false, false, true, false])
  assert.deepEqual(pick({ rigor: 'tests-only' }), ['tests-only', true, true, true, true, false])
  assert.deepEqual(pick({ rigor: 'tdd' }), ['tdd', true, true, true, true, false])
  assert.deepEqual(pick({ rigor: 'tdd-pair', role: 'red' }), ['red', true, true, false, false, false])
  assert.deepEqual(pick({ rigor: 'tdd-triad', role: 'green' }), ['green', true, true, false, true, false])
  assert.deepEqual(pick({ rigor: 'tdd-pair', role: 'green', producer: 'test-author' }), ['green-tests', true, true, true, true, false],
    'a green\'s test-author round is measured by the breaks its new tests catch')
  assert.deepEqual(pick({ rigor: 'tdd-triad', role: 'audit' }), ['audit', true, false, true, false, true])
  assert.deepEqual(pick({}), ['tdd', true, true, true, true, false], 'no rigor measures as before rigor existed')
  assert.deepEqual(pick({ mode: 'integration', rigor: 'tdd-pair', role: 'red' }),
    ['integration', false, false, false, true, false])
})

test('named checks travel only as base64, and every option parses', () => {
  const o = parseArgs(['--rigor', 'tdd-pair', '--role', 'green', '--test-file', 'test/a.test.mjs',
    ...check("npm run e2e -- 'login flow'"), '--repo', '/r', '--effort', 'e', '--execution', EXECUTION,
    '--node', 'a/b', '--branch', 'agentics/e--a.b'])
  assert.equal(o.rigor, 'tdd-pair')
  assert.equal(o.role, 'green')
  assert.deepEqual(o.tests, ['test/a.test.mjs'])
  assert.deepEqual(o.checks, ["npm run e2e -- 'login flow'"])
  assert.equal(o.repo, '/r')
  assert.equal(o.effort, 'e')
  assert.equal(o.execution, EXECUTION)
  assert.equal(o.node, 'a/b')
  assert.equal(parseArgs([]).role, 'none')
  assert.deepEqual(parseArgs([]).checks, [])
})
