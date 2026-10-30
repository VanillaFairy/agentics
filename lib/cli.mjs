// lib/cli.mjs — how a lib CLI that awaits runs its call: after its module has evaluated, and
// never ending without printing its result.
//
// Design: docs/DESIGN.md#data-contracts (a CLI a session calls).

const messageOf = (err) => (err && err.message ? err.message : String(err))

/**
 * Run `call` and print its result as JSON, exiting `code(out)`; a throw prints `failed(err)` and
 * exits 1. The call starts once the entry module has evaluated: a top-level await would hold that
 * evaluation open, and a dynamic import reaching back into the entry module (`launch` loading the
 * execute program, which imports lib/boundary.mjs) would wait on it with nothing left to run. A call
 * still pending when nothing is left to run fails the same way, as `unsettled`.
 */
export function runCli(call, { indent = 0, code = () => 0, failed = (err) => ({ error: messageOf(err) }) } = {}) {
  let pending = true
  const print = (out, exit) => {
    pending = false
    console.log(JSON.stringify(out, null, indent))
    process.exit(exit)
  }
  const fail = (err) => print(failed(err), 1)
  process.once('beforeExit', () => {
    if (pending) fail(new Error('unsettled: the call was still pending when nothing was left to settle it'))
  })
  Promise.resolve().then(call).then((out) => print(out, code(out)), fail)
}
