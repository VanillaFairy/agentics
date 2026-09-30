# lib

## PURPOSE

The deterministic half of agentics: the execution tree and its ledger, spec parsing and approval,
compile, scheduling, locks, worktree and branch boundaries, merge, verification, verdicts, resume
and rendering. It is separate because workflow scripts have no filesystem: skills shell out to
these CLIs directly, and workflows reach them only through the courier agent.

## KEY ABSTRACTIONS

- `plan-digest.mjs`'s `canonical`/`fnv1a` are hand-copied into the workflows that check a digest,
  because a workflow cannot import. Scenario tests compare the copies against this file, so a change
  here is not done until every `service-workflows/*.workflow.js` holding `fnv1a` changes too.
- `verify.mjs` observes and `verdict.mjs` decides. `leaf-close` and `resume.mjs` call the same
  `verdict.mjs` functions, the second against a replayed `verify-observed` line, so a resume can't
  reach a different pass or fail than the live run. Never inline a pass/fail rule in either caller.

## CONCURRENCY MODEL

Several executions and sessions share `.agentics/.state/`. `store.mjs`'s `withLock` is a mutex made
from a directory rename onto an empty-vs-occupied target, branching on the `HELD` error codes,
because POSIX and Windows refuse that rename differently and a check-then-act would race. It backs
the ledger's `seq` and the slot pool. `locks.mjs` grants a leaf its slot and every locus lock
together or not at all, because a partial grant starves leaves waiting on the same paths. It counts
a `planned` holder as occupying, because `leaf-open` takes the slot before appending `dispatched`.
`boundary.mjs` and `verify.mjs` run detached jobs keyed by `jobKey` (a hash of the arguments), so a
courier that dies mid-poll re-dispatches into the same job rather than starting a second one.

## RESOURCE LIFECYCLE

Node branches and worktrees (under `.claude/worktrees/`) are created lazily per node from the
parent's integration head. Only `boundary.mjs land` touches the user's branch. `preflight` removes
clean leftover checkouts of the effort's branches, because git refuses a branch in two worktrees
and the next invocation would come up detached; it never forces a dirty one. `cleanup` runs only
from the checkout that took the landing merge, and keeps dirty worktrees for the user.

## INVARIANTS & GOTCHAS

- Branches are `agentics/<effort>--<flat>`, with `store.mjs`'s `flat()` turning `/` into `.`, never
  `agentics/<effort>/<node>`. A ref is a file under `refs/heads/`, so `agentics/e` and `agentics/e/x`
  cannot coexist. `preflight` parses the name back the same way, so change both together.
- `boundary.mjs`'s `rowOf().spec_path` is where a node's own spec is or would be written. For a
  task it names a file that exists only after promotion; its entry lives in the folder above. Never
  hand it to an agent as "the plan entry": `rulingBrief` renders the node record instead, because a
  ruler sent to a missing file rules `affected` and the question lands on the user.
- `spec.mjs`'s `normalise` and `approval.mjs`'s `hashSpec` strip a BOM and fold `\r\n` before hashing.
  Drop that and a CRLF checkout reads as an edited, unapproved spec.
- `tree.mjs`, `spec.mjs` and `merge.mjs` refuse malformed input and never repair it. `merge.mjs`
  never resolves a conflict: loci are declared disjoint, so a conflict means the declaration was wrong.
- `ledger.mjs` is the only writer of durable records and the only minter of `seq`. `compile.mjs` is
  the only writer of `nodes.jsonl`, and it skips a spec edited since approval, so develop runs the
  last-approved graph.

## DEPENDENCIES

- service-workflows — carries copies of `plan-digest.mjs`, and parses these CLIs' stdout through the courier.
- skills — call the CLIs directly; a CLI's argv or stdout shape change edits every skill that names it.
- tools — `migrate-legacy.mjs` copies older on-disk state into the `.agentics/` layout `store.mjs`
  defines. A layout change ships its own one-shot migration, never a second reader here.
