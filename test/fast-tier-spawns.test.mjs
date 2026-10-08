// test/fast-tier-spawns.test.mjs — the run-time half of "the fast tier spawns nothing".
//
// The `fast-tier` lint rule reads imports; it cannot see a lib/ module that spawns when a fast
// test calls it. This test runs the whole tier under test/fast/harness/no-spawn.mjs, so every
// full run fails if any file there starts a process, and runs a spawning file under the same
// preload to show the guard bites. It lives outside test/fast/ because it spawns.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NO_SPAWN = new URL('./fast/harness/no-spawn.mjs', import.meta.url).href

// The runner sets NODE_TEST_CONTEXT in every test process; a node --test that inherits it runs
// nothing and exits 0.
const { NODE_TEST_CONTEXT, ...env } = process.env

const underPreload = (files) => spawnSync(
  process.execPath,
  ['--import', NO_SPAWN, '--test', '--test-concurrency=2', '--test-reporter=tap', ...files],
  { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)

test('every file of the fast tier passes with process creation refused', () => {
  const run = underPreload(['test/fast/**/*.test.mjs'])
  const passed = Number(/^# pass (\d+)$/m.exec(run.stdout)?.[1] ?? 0)
  assert.ok(passed > 0, 'the tier ran no test, so nothing was checked')
  assert.equal(run.status, 0, run.stdout.split('\n').filter((l) => /^\s*not ok/.test(l)).join('\n'))
})

test('a file that starts a process fails under the preload, whichever way it asks', () => {
  const functions = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
  const dir = mkdtempSync(join(tmpdir(), 'no-spawn-'))
  try {
    const fixture = join(dir, 'spawns.test.mjs')
    writeFileSync(fixture, [
      "import { test } from 'node:test'",
      "import * as cp from 'node:child_process'",
      "import { spawnSync } from 'node:child_process'",
      "test('through a named import', () => { spawnSync(process.execPath, ['-e', '0']) })",
      ...functions.map((name) => `test('${name}', () => { cp.${name}(process.execPath, ['-e', '0']) })`),
    ].join('\n') + '\n')

    const run = underPreload([fixture])
    assert.notEqual(run.status, 0, 'the spawning file passed')
    for (const name of ['spawnSync', ...functions]) {
      assert.match(run.stdout, new RegExp(`child_process\\.${name}\\(\\) called in the fast tier`), name)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
