# lib

## PURPOSE

The deterministic half of agentics: names and storage, the ledger and tree, specs and approval,
locks and branches, verification, resume, status, the agent runner and the CLI that starts
programs. `lib/programs/` and `lib/boundaries/` orchestrate over these; skills call them as CLIs.

## KEY ABSTRACTIONS

- `store.mjs` mints every name: `branchOf`, `worktreeOf`, `dispatchKey`, `sessionOf` and every
  `.agentics/` path. Names are bounded by `nameKey` (a head, `_` and a digest), so they cannot be
  parsed back into a node id: compute `branchOf` forward. Never build a name by hand. A change to one of these functions orphans what is already on disk and
  ships a `tools/migrate-*.mjs`.
- `verify.mjs` observes and `verdict.mjs` decides. Leaf-close calls `closeDecision` live and
  `resume.mjs` calls `measurementOk` on a replayed `verify-observed` line, so a resume cannot reach
  a different verdict. Never inline a pass or fail rule in a caller.
- `measure.mjs`'s `measureKey` hashes every verify option, and a journalled measurement with the
  same key is taken instead of run. A verify option left out of `measureKey` lets a stale
  measurement stand for a changed check.
- `runner.mjs`'s `callOnce` writes the return file before the `returned` line, so a `returned`
  line always has its return on disk. Callers read that file, never the runner's output. Keep the
  order.
- `ledger.mjs`'s `executionLog` routes by kind: `EVENT_KINDS` go to the effort's `events` and so
  into every derived status, `JOURNAL_KINDS` to the journal, the rest to state. The port mirrors
  only its own appends, so keep one port per execution per process.
- `conversation.mjs`'s `TEMPLATES` render a message when it is delivered, from a payload an earlier
  version may have written. A template must not assume a payload field newer than the records.
- `integration.mjs`'s `folderSpan` alone bounds a composite's own work. `unaccountedOf` and
  `adoptFacts` (`adopt.mjs`) both read it, so a cut computed elsewhere lets adopt accept what
  preflight still stops at. An unplaceable cut is `error`, never empty, which would read all
  history as the folder's. A first-parent commit counts as accounted only when a record names it,
  never because a merged head contains it: a leaf cut after a hand commit contains it too.
- A `merged` event with a non-empty `by` is an adoption, and nothing else marks one: `adoptedIn`
  (`schedule.mjs`) earns the folder its review, `status.mjs` and `render.mjs` show it adopted, and
  `adoptedUnruled` (preflight) sends it to a drift ruler. A merge agentics makes never carries `by`.

## CONCURRENCY MODEL

Executions, program runs and sessions share `.agentics/.state/` across processes. `store.mjs`'s
`withLock` renames a staged holder onto the lock directory and branches on the `HELD` codes,
because POSIX and Windows refuse that rename differently. `withLock` runs `fn` synchronously, so
an async `fn` loses the lock before it settles: programs use `withLockAsync`. `locks.mjs` grants a
leaf its slot, counting a `planned` holder as occupying; what two leaves expect only defers them in
`schedule.mjs`, and `contention.mjs` decides what the judge at the merge is asked. `max_parallel` bounds leaf slots across the machine; `max_agents` bounds
concurrent calls inside one run (`programs/common.mjs`).

## RESOURCE LIFECYCLE

`integration.mjs` creates node branches and worktrees under `.claude/worktrees/` lazily and
idempotently. `adopt.mjs` creates a handed-over leaf's branch, which leaf-open attaches through
`ensureLeaf`: an `ensureLeaf` that re-cut an existing branch would discard hand-started work. Only `boundary.mjs land` touches the user's
branch; its sweep deletes only branches git sees merged and keeps dirty worktrees. A detached run
(`run.mjs --detach`) outlives its session; the heartbeat in its `run.json` tells live from stopped.

## DEPENDENCIES

- lib/programs, lib/boundaries — the in-process callers of nearly everything here.
- skills — call the CLIs directly; a flag or printed-shape change edits every skill that names the CLI.
- tools — a one-shot migration writes through `store.mjs`, `ledger.mjs` and `integration.mjs`; a
  naming change here is a migration there.
