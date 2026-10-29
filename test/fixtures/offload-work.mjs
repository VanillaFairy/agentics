// test/fixtures/offload-work.mjs — work test/offload.test.mjs sends to the offload worker.

import { GitHung } from '../../lib/store.mjs'

/** Hold the thread it runs on for `ms`, then answer `ms`. */
export function hold(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) { /* held */ }
  return ms
}

export function fails() {
  throw new Error('it failed')
}

export function hangs() {
  throw new GitHung(['merge'], 1)
}

/** End the thread it runs on mid-request. */
export function dies() {
  process.exit(3)
}
