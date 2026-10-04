// test/harness/scripted-runner.mjs — a runner that answers each call from a script keyed by role,
// node and thread, and records exactly as lib/runner.mjs does.
import { dispatchedEntry, returnedEntry } from '../../lib/runner.mjs'

export function scriptedRunner(script, { log, now = () => '2026-01-01T00:00:00.000Z' }) {
  const next = new Map()
  const calls = []
  async function runAgent(call) {
    calls.push(call)
    const key = call.role.name + '|' + call.node + '|' + call.thread.key
    const queue = script[key] || []
    const i = next.get(key) || 0
    if (i >= queue.length) throw new Error('the script has no call ' + (i + 1) + ' for ' + key)
    next.set(key, i + 1)
    const step = { status: 'returned', cause: '', until: '', output: null, usage: null, cost_total: null, cost_usd: null, ...queue[i] }
    const session = call.thread.session
    log.append('dispatched', dispatchedEntry(call, { pid: 0, session }))
    if (step.status === 'stopped') {
      log.append('host_stop', { dispatch: call.dispatch, cause: step.cause, until: step.until })
    } else {
      log.append('returned', returnedEntry(call, { session, status: step.status, cause: step.cause, usage: step.usage, costTotal: step.cost_total, costUsd: step.cost_usd }))
    }
    return { status: step.status, cause: step.cause, until: step.until, output: step.output, usage: step.usage, cost_usd: step.cost_usd, denials: [], session, checkout: { moved: [], changed: [] }, at: now() }
  }
  return { runAgent, calls }
}
