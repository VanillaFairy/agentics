// test/fixtures/git-hangs.mjs — preloaded (`--import`) into a child test/measure.test.mjs starts: every
// synchronous git comes back as one killed at its ceiling, the way `spawnSync` reports a timeout.

import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const real = childProcess.spawnSync
childProcess.spawnSync = (cmd, ...rest) => (cmd === 'git'
  ? { status: null, signal: 'SIGKILL', stdout: '', stderr: '', error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
  : real(cmd, ...rest))
syncBuiltinESMExports()
