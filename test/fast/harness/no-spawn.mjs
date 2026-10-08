// test/fast/harness/no-spawn.mjs — a preload that makes starting a process an error.
//
//   node --import ./test/fast/harness/no-spawn.mjs --test ...
//
// The fast tier is the tests that start no process. The `fast-tier` lint rule reads imports and
// cannot see a lib/ module that spawns when called; this preload catches that at run time. Every
// function of node:child_process, sync and async, throws and names the tier rule, so a spawning
// test fails where it spawns. test/fast-tier-spawns.test.mjs runs the tier under it, and
// `tools/suite.mjs --fast` passes it with --import.
//
// The module is read through process.getBuiltinModule: an import of child_process is what the
// lint rule forbids in this folder. syncBuiltinESMExports carries the replacements to the named
// ESM imports of modules loaded after this one.

import { syncBuiltinESMExports } from 'node:module'

const childProcess = process.getBuiltinModule('node:child_process')

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = function refused() {
    throw new Error(
      `child_process.${name}() called in the fast tier: test/fast/ spawns nothing ` +
      '(docs/DESIGN.md#self-checks). Move this test out of test/fast/, or take the process out of it.',
    )
  }
}

syncBuiltinESMExports()
