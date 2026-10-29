// test/fast/after-ended.test.mjs — lib/programs/execute.mjs `afterEnded`: only a run the session's
// pause stopped starts again once the run ended; the `--pause` flag's stop stands.
//
// Design: docs/DESIGN.md#session-calls.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { afterEnded } from '../../lib/programs/execute.mjs'

test("a run the --pause flag stopped is never started again after it ended, whatever the session's pause reads", async () => {
  const launched = []
  const ctx = { repo: '/no/such/repo', run: 'e.20260101T000000Z', execution: '20260101T000000Z' }
  const out = await afterEnded(ctx, { effort: 'e' }, { stopped: 'pause', paused: 0 }, {
    launchRun: async (o) => { launched.push(o); return { ok: true } },
  })
  assert.equal(out, null)
  assert.deepEqual(launched, [])
})
