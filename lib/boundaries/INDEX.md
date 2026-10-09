# lib/boundaries

## PURPOSE

The execute program's deterministic steps, called in-process: an execution's preflight, schedule
and postflight, leaf-open, leaf-close, leaf-review, merge-batch and the suite gate, folder review
and rule-close, and the autonomous review's spec steps. Each reads the tree and logs from disk and
decides records; none starts an agent or is a CLI.

## KEY ABSTRACTIONS

- `records.mjs`'s `recordAll` is how a decided record reaches disk. It appends only what
  `freshRecords` finds not already standing, so a boundary re-run after an unobserved outcome
  converges instead of writing twice. A new record kind needs a `stands` case there: the default is
  `false`, and every re-run appends it again.
- A boundary reads the tree fresh from disk (`readTree`), not from its `executionLog` port, so a
  record that a session CLI or another process wrote counts as standing.
- `storedReturn` reads a dispatch's return only when its `returned` line says `returned`. A
  `watch_failed` call's kept return is on disk but is not the agent's word.
- `commandsFor` takes verification commands only from `command` gotchas. Preflight writes the
  session's commands as gotchas, so a command handed in any other way is never run.

## CONCURRENCY MODEL

Called from the execute program's one event loop. Waits use the async lock forms (`acquireAsync`,
`withBranchLockAsync`) and checks run through `measure`; a synchronous wait here stalls every unit
and the run's heartbeat.

## RESOURCE LIFECYCLE

`leafOpen` takes a slot and the locus locks before it creates the leaf's branch and worktree;
`recordAll` gives a node's slot back when it records a `fault`. Preflight's `clearWorktrees` removes
clean leftover checkouts of the effort's branches and never forces a dirty one; `postflight` writes
`closed`. A merge measured while the user's checkout moved is a `checkout` fault, and the batch is
put back where it started.

## INVARIANTS & GOTCHAS

- A fault holds its node for the rest of the run (`heldOf`); only the next run takes it up.
- `driftOf` in `merge.mjs` finds contract drift only on the batch that landed it. That is why
  `faultRecords` adds the `contract_drift` park while a drift ruling stands unanswered: a fault
  alone would let the next run take the node up on a moved contract.
- Leaf-close reverts what a producer wrote outside its locus with a commit of its own
  (`REVERT_SUBJECT`), and `revertsOf` reads `breach_reverted` across every execution, so a revert
  already made is not made again.

## DEPENDENCIES

- lib — tree, ledger, locks, integration, measure, verify, verdict, gotchas, and `brief.mjs` for a
  leaf's thread brief and `guidanceOf`.
- lib/programs — `execute.mjs` and `execute/` are the callers; `lib/boundary.mjs` reads only
  `openExecutions`.
