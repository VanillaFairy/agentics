# test/harness

## PURPOSE

Runs the plugin's own workflows offline. `workflow-host.mjs` executes a `*.workflow.js` with the
runtime's globals replaced by scripted fakes; `develop-sim.mjs` simulates `lib/boundary.mjs` in
memory for `execute-approved-plan-in-worktrees`; `verify-fixture.mjs` builds real git repos for
`lib/verify.mjs`. It exists because the orchestration is the part lint cannot judge and a live run
is too costly to repeat.

## KEY ABSTRACTIONS

- `compileWorkflow` strips `export` from `export const meta` and passes the rest as the body of an
  `AsyncFunction` whose parameters are the runtime globals. This is the only way to compile a
  workflow, because the top-level `return` is illegal in a module, so `node --check` fails on
  every workflow. A new global a workflow calls must be added to both the parameter list and
  `runWorkflow`'s arguments, in the same order. Miss it and compilation succeeds but the call
  throws `ReferenceError` when reached.
- A passing scenario proves orchestration (coverage derivation, escalation routing, review-loop
  exits) against the real workflow source. It never proves agent behaviour, because every `agent()`
  answer is scripted. Never report a scenario run as a live run.
- `develop-sim`'s `simulate` runs the real `schedule()`; only boundary I/O is faked. Answers
  round-trip through `carriedEnvelope`, the same digest-wrapped shape a courier produces, and
  `script.damage` corrupts one to prove the workflow re-checks the digest.
- `memory-log.mjs`'s `memoryLog()` is the runner's `log` port in memory; `entries()` hands back copies, so a test cannot rewrite what it reads.
- `fake-claude.mjs` stands in for `claude.exe` under `spawner(process.execPath, [FAKE])`; it counts calls in `<scenario>.n` beside the scenario file, so each test needs a fresh scenario file.
- `scripted-runner.mjs` answers runner calls from a script and records as lib/runner.mjs does; programs are tested against it.

## CONCURRENCY MODEL

Deterministic fakes: `pipelineFake` runs items one at a time and `parallelFake` wraps `Promise.all`
over synchronous thunks. Real concurrency (no-barrier pipelines, wall-clock overlap) is not tested here.

## RESOURCE LIFECYCLE

`verify-fixture.mjs` builds one template repo per shape, caches it in a module-level Map and hands
each test a `cpSync` copy. It runs `git worktree repair` on every worktree in the copy, because an
unrepaired copied worktree silently resolves back into the template. Copies go in `t.after`;
templates are swept only by a `process.on('exit')` handler.

## INVARIANTS & GOTCHAS

- `verify-fixture.mjs` deletes `process.env.NODE_TEST_CONTEXT` at load, because a grandchild
  `node --test` that inherits it runs nothing and exits 0, which looks like a pass.
- A workflow that dispatches a new boundary name needs a key in `develop-sim`'s `answer` map, or
  the courier fake throws "unscripted agent".
- `scriptedAgents` matches a label exactly, then by the longest `:`-prefix, and throws when nothing
  matches, so a missing script entry fails at the call rather than as a wrong assertion later.
- The `budget` fake's `remaining()` is `Infinity` unless a scenario passes `opts.budget`, so any
  budget-gated branch goes untested unless a scenario sets one.

## DEPENDENCIES

- service-workflows — what it runs; a change to the runtime globals changes `compileWorkflow`.
- lib — `develop-sim` relies on the real `schedule`, `tree` and `resume`; `workflow-host` builds
  envelopes with `plan-digest` and `citations`.
