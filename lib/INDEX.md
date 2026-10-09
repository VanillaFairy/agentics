# lib

## PURPOSE

The deterministic half of agentics: names and storage, the ledger and tree, specs and approval,
locks and branches, verification, resume, status, the agent runner and the CLI that starts
programs. `lib/programs/` and `lib/boundaries/` orchestrate over these; skills call them as CLIs.

## KEY ABSTRACTIONS

- `store.mjs` mints every name: `branchOf`, `worktreeOf`, `dispatchKey`, `sessionOf` and every
  `.agentics/` path. Names are bounded by `nameKey` (a head, `_` and a digest), so they cannot be
  parsed back into a node id; preflight finds a node's branch by computing `branchOf` forward. Never
  build a name by hand. A change to one of these functions orphans what is already on disk
  (branches, worktrees, sessions, stored returns) and ships a `tools/migrate-*.mjs`.
- `verify.mjs` observes and `verdict.mjs` decides. Leaf-close calls `closeDecision` live and
  `resume.mjs` calls `measurementOk` on a replayed `verify-observed` line, so a resume cannot reach
  a different verdict. Never inline a pass or fail rule in a caller.
- `measure.mjs`'s `measureKey` hashes every verify option, and a journalled measurement with the
  same key is taken instead of run. A new verify option left out of `measureKey` lets a stale
  measurement stand for a changed check.
- `runner.mjs`'s `callOnce` writes the return file before the `returned` line, so a `returned`
  line with status `returned` always has its return on disk. Callers read that file, never the
  runner's in-memory output. Keep the order.
- `ledger.mjs`'s `executionLog` routes by kind: `EVENT_KINDS` go to the effort's `events` and so
  into every derived status, `JOURNAL_KINDS` to the journal, the rest to state. Where a new kind
  goes decides whether it moves a node's status. The port mirrors only its own appends, so keep one
  port per execution per process.
- `conversation.mjs`'s `TEMPLATES` render a message when it is delivered, from a payload that an
  earlier version may have written. A template must not assume a payload field newer than the
  records on disk.

## CONCURRENCY MODEL

Executions, program runs and sessions share `.agentics/.state/` across processes. `store.mjs`'s
`withLock` renames a staged holder onto the lock directory and branches on the `HELD` codes,
because POSIX and Windows refuse that rename differently. `withLock` blocks the thread and runs
`fn` synchronously: an async `fn` releases the lock before its promise settles. Inside a program
use `withLockAsync` and its kin (see `lib/programs/INDEX.md`). `locks.mjs` grants a leaf its slot
and every locus lock all or nothing, and counts a `planned` holder as occupying. `max_parallel` bounds leaf slots across the machine
(`locks.mjs`); `max_agents` bounds concurrent calls inside one run (`programs/common.mjs`).

## RESOURCE LIFECYCLE

`integration.mjs` creates node branches and worktrees under `.claude/worktrees/` lazily and
idempotently. Only `boundary.mjs land` touches the user's branch, on their confirmed word; its
sweep deletes only branches git sees merged and keeps dirty worktrees. A detached run
(`run.mjs --detach`) outlives the session that started it; the heartbeat in its `run.json` is what
tells live from stopped.

## DEPENDENCIES

- lib/programs, lib/boundaries — the in-process callers of nearly everything here.
- skills — call the CLIs directly; a flag or printed-shape change edits every skill that names the CLI.
- tools — the migrations write through `store.mjs`, `ledger.mjs` and `integration.mjs`; a naming
  change here is a migration there.
