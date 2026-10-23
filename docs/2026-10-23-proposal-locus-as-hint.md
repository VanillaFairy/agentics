# Proposal: the locus becomes a scheduling hint

Status: proposed, 2026-10-23. When it lands, `docs/DESIGN.md` describes the result and this file
is deleted.

## Why

Every leaf carries a locus — the exact files it may write — and the plugin enforces it six ways:
headless permission rules, locus locks, leaf-close's breach revert, the series' `locus-breach`
check, `needs_locus` routed to the planner (which replans and re-probes), and spec-time checks on
criterion paths and entry syntax. Across all six field executions in eva-plays-2 it caught no real
scope breach. It raised 32 friction events: 14 widening requests, all legitimate (a test, a
caller, a sibling file); 9 enforcement false positives (reverts from a missing trailing slash,
compile refusals reading grep patterns as paths); 2 induced workarounds; about $30, ~57 extra
sessions and 7–10 user asks. Its one benefit was two lock waits on real overlaps.

A source map of the enforcement found every job either self-referential (the fence exists to
enforce the fence) or really a role rule. The fence that matters — a green's implementer never
touches the cycle's tests (L3) — keys on role and `isTestPath`, not on the file list. Per-file
test discrimination and merge order do not read the locus; review already reads the actual diff.

What stays valuable: predicting contention so the scheduler does not run two leaves on the same
file at once, drift detection on a moved base, and brief context (evidence, gotchas, guidance).
All three are predictions. None needs a fence.

## Decisions

1. **Rename and loosen.** A leaf's `locus` becomes `expects`: the files the planner expects it to
   change. Optional for every rigor (a `verify` leaf still expects nothing). It is never a
   permission and never a failure.
2. **Permissions are role rules.** A writing call gets `Edit(/**)` and `Write(/**)` (its worktree)
   and denies `/.agentics/**`. A test-author is allowed only the test-file globs of
   `TEST_PATTERNS`. A green's implementer and every auditor are denied those globs. The git denies
   (`--amend`, `-C`, `--git-dir`, `--work-tree`, `--output`) stay. The host honours this: a probe
   against claude 2.1.309 under `dontAsk` (12 cases: writes inside and outside the worktree, into
   `.agentics/`, tests under each role) matched in every case; the same cases join
   `test/host-contract.test.mjs`.
3. **Delete the fence machinery.** Leaf-close's breach revert (`agentics: outside locus` /
   `revert outside locus` commits, `breach_reverted`, `preRevertHeads`, the pre-revert
   measurement and `strayText`); the `needs_locus` status, message, route and schema field; the
   `locus_held` escalation on a widened locus; held paths (`heldAgainst`) and `admits`;
   `criterionPathProblems` and `locusDirectoryProblems`; the "a leaf that writes needs a locus"
   node problem; `isLoneBreach`, the `breach` shape and `verify_oscillating`; atomicity condition 3
   (closed locus).
4. **The series check judges role, not files.** `locus-breach` becomes `role-breach` on the
   series' net diff: no role writes under `.agentics/`; a green's or an audit's own commits change
   no test file; a commit the program made for a shell-less test-author changes only test files
   (the existing per-commit fence, now a role fence). Blocking, so a breach is a fix round as
   before. Uncommitted stray files are put back to the head before measuring, as today for files
   inside the locus; nothing is reverted out of the series.
5. **The cycle's tests come from the red's commits.** `cycleTestLocus` (red's locus test entries)
   is replaced by the test files of the red's actual series, from git: what a green is measured
   on, what the test round may rewrite without breaching, and what the brief lists. A test round
   of a green or an audit may write any test file (decision 2).
6. **Locks become an advisory schedule.** The locus lock files, `locus_held`, `holderReader`,
   `releaseLocus` and the locus half of `heldBy` go. `schedule` defers a leaf whose `expects`
   overlaps a leaf no dependency orders with it that is running in this execution, or active or
   approved and unmerged in the tree. Advisory means: when deferral is all that keeps the
   execution idle, the deferred leaves launch anyway. A deferral never escalates and never parks.
   Coupled work (`shared`) keeps running one at a time, read from `expects`.
7. **One judge rules on real contention.** The ruler gains one ruling, `ruler_contention`
   (tool-less: both diffs and both plan entries are in its brief). Rather than a new role file:
   the ruler is already the judge kind that rules whether a concurrent change moved another
   unit's premises, and this is that question asked of two diffs. Code finds the facts; the ruler
   rules per contended unit; code combines.
8. **The severity ladder drops the locus clause.** "Any change outside the locus in the series'
   net diff" leaves `critical`. `major` gains "a change in the net diff the leaf's intent and
   criteria do not call for": scope creep is a defect a human gate should see, not a reason to
   block a merge. The verbatim copy in `roles/reviewer.md` moves with it.
9. **Migration is one shot.** `tools/migrate-expects.mjs` (dry run by default, `--yes` applies,
   idempotent) rewrites each spec's `locus:` field line to `expects:`; where the spec's hash before
   the rewrite equalled its latest `approved` or `prepared` line, it appends the same kind of line
   at the new hash, `by: migration`; then compiles each effort, so node records carry `expects`.
   It lists, for the user to `retry`, every leaf whose open stop or latest route is a
   `needs_locus`. A spec still carrying `locus:` after the upgrade is refused by the spec check
   with a problem naming the migration. Stored node lines that still say `locus` are read as
   expecting nothing until compiled: a hint that is absent costs scheduling quality, not
   correctness, so no second reader is needed.

What is kept unchanged: drift detection on a moved base (`writes` read from `expects`), evidence,
gotchas and guidance in the brief (from `expects`), the fit estimate (condition 7, from `expects`
and `reads`), merge order, per-file discrimination, review on the actual diff.

## The judge

Code computes **contention facts** for a merge unit (a leaf outside a cycle, or a cycle at its last
member) at the moment it would be approved — in leaf-close and in leaf-review, through one
function, so both paths ask the same question:

- **overlap** — a path in the unit's net diff that is also in the net diff of another leaf `O`
  (its branch from where it was cut to its head), where no dependency orders the two, they are not
  in one cycle, and `O`'s work has not yet merged where the two meet (its ancestor just below
  their lowest common ancestor has not merged — `depReady`'s rule).
- **another folder** — a path in the unit's net diff that a leaf `O` of another folder expects,
  under the same ordering and merge conditions, `O` not already an overlap on that path.

A fact a standing `resolve` ruling of this unit already covers (same `O`, same path) is no fact.
No facts: the approval is recorded as today. Facts: the decision is `judge` instead; the leaf unit
dispatches the ruler on `ruler:contention:<unit>:<head>`, and a new boundary,
`judge-close`, reads the per-unit rulings. A **merge conflict** of a leaf unit in merge-batch is
the third trigger: the merge unit dispatches the ruler on `ruler:conflict:<unit>:<approved head>`
with the conflicting paths, instead of escalating `merge_conflict` at once.

```
 approve? ──facts?──no──▶ approved (as today)
             │yes
             ▼
        ruler_contention ──per contended unit──▶ code combines
             │
   any unruled / cant_rule ──▶ escalate to the user (contention_unruled | merge_conflict)
   else any replan        ──▶ route to the folder's planner | park the user's folder needs_respec
   else any serialize     ──▶ wait for O, then a rebase round
   else (all resolve)     ──▶ approved            | conflict: a rebase round now
```

- **serialize** — the unit goes after `O`. Recorded as `judged {node, head_sha, facts, rulings,
  outcome: serialize, after: [O…], said}`; the unit's slot is released and a `rebase` message
  (`{after, paths, why}`) waits for its next round. `schedule` reads a standing serialize ruling
  as a dependency on each `O`, with `depReady`'s rule, so a stopped `O` shows as the blocker. Once
  `O` has merged where they meet, the leaf's next round opens: leaf-open's refresh brings its
  branch up to its parent's head, which now holds `O`'s work, and the producer checks and adjusts
  its change against it; the round is measured, reviewed and judged again like any other.
- **resolve** — the changes stand together. For an overlap or a folder write: `judged` with
  `outcome: resolve` and the approval. For a conflict: `judged`, and a `rebase` message carrying
  the conflicting paths; the program relaunches the leaf as it does a leaf that failed alone, and
  it is kept out of merges until approved again.
- **replan** — the plan is wrong: under a planner's folder, the leaf routes to the planner with
  request status `contention`; under the user's folder, the leaf escalates `contention` and the
  folder parks `needs_respec` with the ruler's question (as a verify finding does).
- **can't rule** — a unit left unruled or ruled `cant_rule` escalates the leaf with the ruler's
  why: `merge_conflict` for a conflict, `contention_unruled` otherwise. This is the only path to
  the user.

**The rebase round.** A round that opens with an unanswered `rebase` message refreshes the branch
from the parent's head and, on a conflict, leaves it in the worktree (the merge in progress) for
the producer to resolve and commit, instead of refusing the open. The message names the conflicting
paths. Every other round still refuses a conflicting refresh (`open_refused`).

**Bounds.** A cycle has no one producer for its tip's branch, so for a cycle unit `serialize` and a
conflict `resolve` escalate (`contention_unruled` / `merge_conflict`), as a cycle failing alone on
an integration head does today; `resolve` of an overlap approves it. A conflict on the same paths
again after a conflict `resolve` is a remedy that failed: it escalates `merge_conflict` without a
second ruling. A composite unit's conflict escalates as today.

## Data contracts that change

Spec format (`locus:` → `expects:`, optional); node record (`locus[]` → `expects[]`); snapshot
node entry (`locus` → `expects`); producer return (`needs_locus` status and field gone); session
call `adopt` check (`outside_locus` gone: an adopted commit is judged by the role rule, which the
check reports as `role_breach[{node, paths}]`); verify payload (`locus-breach` → `role-breach`,
`held[]` option gone, `locus` option renamed `expects` and read only for the measurement key);
events (`breach_reverted` gone; `judged` added); conversation messages (`needs_locus` gone,
`rebase` added); ruler schemas (`ruler_contention` added); slots and locks (`locks/locus/` gone).

## Tests

- `rolePermissions` per role (fast): a writer's allow and deny sets; a test-author's; a green's
  implementer and an auditor denied tests; commands and the git denies.
- Host contract (`AGENTICS_HOST=1`): the probe's cases.
- `contentionOf` (fast): overlap, another folder, ordered leaves, merged-where-they-meet, cycles,
  coverage by a standing resolve.
- `judge-close` (fast, scripted runner): serialize → `judged`, `rebase` message, slot released,
  `schedule` holds the leaf until `O` merges; resolve → approval (overlap) and rebase message
  (conflict); replan → planner route and user park; cant_rule → escalation.
- Series `role-breach`; red verdict against its own diff; advisory deferral in `schedule`;
  the migration on a fixture store.

## Risks

- **A wrong `expects` costs scheduling, not correctness.** Two leaves the planner did not predict
  to overlap run side by side; the judge sees the real overlap at approval. The field evidence
  says that is rare and cheap next to what the fence cost.
- **The judge adds a call where overlaps are real.** One tool-less ruling per contended
  approval, against a replan and re-probe per widening today.
- **A producer can now write anywhere in its worktree.** Review reads the actual diff, the
  series check holds the role fences, and the judge sees any cross-leaf or cross-folder write
  before it merges.
