// test/harness/dead-pid.mjs — a pid no process holds. An exited child's pid is no answer: the OS
// recycles it, and under a loaded suite a live process can take it before the test reads it.
import assert from 'node:assert/strict'

export const DEAD_PID = 2 ** 31 - 1
assert.throws(() => process.kill(DEAD_PID, 0), { code: 'ESRCH' })
