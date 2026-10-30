// test/fast/verify-no-test-ran.test.mjs — `ranNoTest` over what runners really print.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ranNoTest } from '../../lib/verify.mjs'

test('each runner\'s report of no test is read, colours and all', () => {
  for (const said of [
    '\x1b[33mNo test files found, exiting with code 0\x1b[39m\n',
    'No tests found, exiting with code 1',
    'Error: No tests found',
    'Running 0 tests using 0 workers',
    '===== no tests ran in 0.01s =====',
    'Ran 0 tests in 0.000s\n\nNO TESTS RAN',
    'running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored',
    '?   \texample.com/x\t[no test files]',
    '\u2139 tests 0\n\u2139 pass 0',
    '# tests 0',
  ]) assert.equal(ranNoTest(said), true, said)
})

test('a run that counted a test is a run, whatever else it printed', () => {
  for (const said of [
    '',
    'build finished',
    ' \u2713 a.test.ts (2 tests)\n Test Files  1 passed (1)\n      Tests  2 passed (2)',
    'console.log: No tests found in the fixture\n',
    'No tests found\n Tests  1 failed (1)',
    'running 0 tests\ntest result: ok. 0 passed\nrunning 3 tests\ntest result: ok. 3 passed; 0 failed',
    '\u2139 tests 3',
    '1) e2e/x.spec.ts:3:1\n  1 failed',
  ]) assert.equal(ranNoTest(said), false, said)
})
