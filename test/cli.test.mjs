// test/cli.test.mjs — pins lib/cli.mjs: a CLI's call left pending once nothing is left to run
// still prints its failure and exits 1.
//
// Design: docs/DESIGN.md#data-contracts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const CLI = new URL('../lib/cli.mjs', import.meta.url).href

test('a call that can never settle prints its failure as unsettled and exits 1', () => {
  const entry = 'import { runCli } from ' + JSON.stringify(CLI) + '\nrunCli(() => new Promise(() => {}))\n'
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', entry], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(out.status, 1, out.stderr)
  assert.match(JSON.parse(out.stdout).error, /^unsettled/)
})
