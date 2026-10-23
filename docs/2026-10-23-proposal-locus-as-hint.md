# Proposal: the locus becomes a scheduling hint

Status: revised after its adversarial review (verdict and dispositions at the end), 2026-10-23;
built on branch `locus-as-hint`, where `docs/DESIGN.md` (Role rules, The judge, Scheduling) now
describes the result. Where the build settled a detail differently, "Built as" at the end says so.

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
2. **Permissions are role rules.** A writing call gets `Edit(/**)` and `Write(/**)` — `/` anchors
   at the call's working folder, the leaf's worktree — and is denied `/.agentics/**`. Then by role:
   - the test-author of a cycle's test round (a green's or an audit's) and of a `tests-only` leaf
     is allowed only the test-file globs of `TEST_PATTERNS`;
   - a red's test-author writes anything a writer may: its tests, and the throwing stubs of the
     files its green builds where the typecheck covers tests (`roles/test-author.md`); the red
     verdict already fails anything else that breaks;
   - a green's implementer and every auditor are denied the test-file globs;
   - the git denies (`--amend`, `-C`, `--git-dir`, `--work-tree`, `--output`) stay.
   The host honours this. Probes against claude 2.1.309 under `dontAsk` matched in every case:
   writes inside the worktree, into its `.agentics/`, outside it, tests under each role; and from
   a leaf worktree nested at `<main>/.claude/worktrees/a`, a new file in the sibling worktree
   `b`, in the main checkout and in `<main>/.agentics/` were each denied. These cases join
   `test/host-contract.test.mjs`.
3. **Delete the fence machinery.** Leaf-close's breach revert (`agentics: outside locus` /
   `revert outside locus` commits, `breach_reverted`, `preRevertHeads`, the pre-revert
   measurement and `strayText`); the `needs_locus` status, message, route and schema field; the
   `locus_held` escalation on a widened locus; held paths (`heldAgainst`) and `admits`;
   `criterionPathProblems` and `locusDirectoryProblems`; the "a leaf that writes needs a locus"
   node problem; `isLoneBreach`, the `breach` shape and `verify_oscillating`; atomicity condition 3
   (closed locus). L4's enforcement entry trades "leaf-close's revert" for the role permissions
   and the series `role-breach` check.
4. **The series check judges role, not files.** `locus-breach` becomes `role-breach` on the
   series' net diff, keyed as decision 2: nothing under `.agentics/`; a green's or an audit's own
   commits change no test file; a commit the program made for the test-author of a cycle's test
   round or of a `tests-only` leaf changes only test files. Blocking, so a breach is a fix round as
   before. Uncommitted stray files are put back to the head before measuring, as today for files
   inside the locus; nothing is reverted out of the series.
5. **Rewritten regression tests are a unit to rule.** With no fence, a producer can edit an
   existing test until the suite passes. Code names every test file the net diff changes that
   exists at the base and lies outside both `expects` and the cycle's tests (`tests_rewritten` on
   the verify payload, an observation). On a leaf with its own review each is already a changed-file
   unit, and its brief marks it; otherwise the folder's integration reviewer is handed each as a unit
   it must rule.
6. **The cycle's tests come from the red's commits.** `cycleTestLocus` (red's locus test entries)
   is replaced by the test files of the red's actual series, from git: what a green is measured
   on, what the brief lists. The red verdict confines its suite failures to the test files of its
   own diff (the discriminator's files) instead of its locus.
7. **Locks become an advisory schedule.** The locus lock files, `locus_held`, `holderReader`,
   `releaseLocus` and the locus half of `heldBy` go. `schedule` defers a leaf whose `expects`
   overlaps a leaf no dependency orders with it that is running in this execution, or active or
   approved and unmerged in the tree. Advisory: when the deferred leaves are all that would launch
   and nothing of this execution runs, they launch anyway. A deferral never escalates and never
   parks. Coupled work (`shared`) keeps running one at a time, read from `expects`.
8. **One judge rules on contention at the merge.** The ruler gains one ruling, `ruler_contention`
   (tool-less: the diffs and the plan entries are in its brief), rather than a new role file: the
   ruler is already the judge kind that rules whether a concurrent change moved another unit's
   premises, and this is that question asked of two diffs. Code finds the facts; the ruler rules
   per contended unit; code combines. Every approved unit passes through merge-batch, so that is
   the one place it is asked (below).
9. **The severity ladder drops the locus clause.** "Any change outside the locus in the series'
   net diff" leaves `critical`. `major` gains "a change in the net diff the leaf's intent and
   criteria do not call for": scope creep is a defect a human gate should see, not a reason to
   block a merge. The verbatim copy in `roles/reviewer.md` moves with it.
10. **Migration is one shot.** `tools/migrate-expects.mjs` (dry run by default, `--yes` applies,
    idempotent) rewrites each spec's `locus:` field lines to `expects:`. A spec whose hash before
    the rewrite equalled its latest `approved` or `prepared` line gets a `carried {folder, from,
    hash, by: format}` ledger line once code has checked that the two texts differ only in that
    keyword; `approvalState` reads a `carried` line whose `from` is the signed hash as the same
    signature at the new hash. L4 names this: a format-only carry-over checked by code, no new
    decision. Then it compiles each effort, so node records carry `expects`. It lists, for the user
    to `retry` or replan: every leaf whose open stop is `locus_held` or `verify_oscillating`, or
    whose latest route is a `needs_locus`; every leaf with a `breach_reverted` record (its held
    mutations may name a file the revert took out). A spec still carrying `locus:` after the
    upgrade is refused by the spec check with a problem naming the migration. Stored node lines
    that still say `locus` read as expecting nothing until compiled: an absent hint costs
    scheduling quality, not correctness, so no second reader is needed.

What is kept unchanged: drift detection on a moved base (`writes` read from `expects`), evidence,
gotchas and guidance in the brief (from `expects`), the fit estimate (condition 7, from `expects`
and `reads`), merge order, per-file discrimination, review on the actual diff.

## The judge

Merge-batch already merges every approved unit — a leaf outside a cycle, a cycle through its tip, a
composite — in dependency order into its folder's branch, measures the merged head with the fast
suite, and bisects. Inside one folder that already serializes and rebases: a later unit merges on
top of an earlier one, the suite verifies the combination, and only a textual conflict needs a
decision. What it cannot see is two folders writing the same file: each merges cleanly into its
own branch and they first meet when the folders merge up, as a composite conflict no producer can
resolve. So the judge is asked at the merge, about two things.

**Contention** (a leaf or cycle unit, before it merges): code computes facts against every leaf
`O` of *another folder* that no dependency or standing serialize ruling orders with the unit and
whose work has not merged where the two meet (its ancestor just below their lowest common ancestor
has not merged — `depReady`'s rule):

- **overlap** — a path in the unit's net diff that is also in `O`'s net diff (its branch from where
  it was cut to its head);
- **another folder** — a path in the unit's net diff that `O` expects, `O` not already an overlap
  on that path.

A fact a standing `resolve` ruling covers is no fact; a ruling stands only while the unit's head
and `O`'s head are the heads it was given. A unit with facts is left out of this batch, and the
merge unit dispatches the ruler on `ruler:contention:<unit>:<head>`.

**Conflict** (a leaf unit whose merge conflicted): the merge unit dispatches the ruler on
`ruler:conflict:<unit>:<approved head>` with the conflicting paths and both sides' diffs, instead
of escalating `merge_conflict` at once.

```
 merge-batch, per unit ──facts?──no──▶ merge (as today) ──conflict?──no──▶ merged
                          │yes                              │yes (leaf unit)
                          ▼                                 ▼
                 ruler_contention                     ruler_contention (conflict)
                          │  one ruling per contended unit; code combines
   any unruled / cant_rule ──▶ escalate to the user (contention_unruled | merge_conflict)
   else any replan        ──▶ route to the folder's planner | park the user's folder needs_respec
   else any serialize     ──▶ the unit's merge waits for O          (contention only)
   else (all resolve)     ──▶ merges in the next batch | conflict: a rebase round
```

Every outcome is recorded as one event, `judged {node, trigger, head_sha, heads{O: sha}, facts,
rulings, outcome, after[], said}`.

- **serialize** — the unit merges after `O`. It stays approved (an approved leaf occupies no slot)
  and `mergesToLaunch` leaves it out until each `O` has merged where they meet. Then it merges as
  usual into its folder's branch, which merge-batch first refreshes from the branches above, so it
  lands on top of `O`'s work: a conflict there is the conflict trigger, a combination failure the
  bisect. Code orders units, not the ruler: a unit may wait only on an `O` first dispatched before
  it, so serialize rulings never form a cycle; a serialize ruled against a later `O` reads as
  `resolve`, and the ordering comes from `O`'s own merge seeing this unit. A stopped `O` holds the
  unit, and the execution's summary names `O` as what it waits behind.
- **resolve** — the changes stand together. For contention: the unit merges in the next batch. For
  a conflict: a `rebase` message waits for the leaf's next round, and the program relaunches it as
  it does a leaf that failed alone; it is kept out of merges until approved again.
- **replan** — the plan is wrong: under a planner's folder, the leaf routes to the planner with
  request status `contention`; under the user's folder, the leaf escalates `contention` and the
  folder parks `needs_respec` with the ruler's question, as a verify finding does.
- **can't rule** — a unit left unruled or ruled `cant_rule` escalates with the ruler's why:
  `merge_conflict` for a conflict, `contention_unruled` otherwise. This is the only path to the
  user.

**The rebase round.** A round whose dispatch carries an unanswered `rebase` message — answered by
that dispatch — refreshes the leaf's branch from its parent's head and, on a conflict, leaves the
merge in progress in the worktree for the producer to resolve and commit; an open run again finds
the merge already in progress and takes it as this round's. Leaf-close refuses to measure while a
merge is in progress or a path is unmerged: that round gets a `failures` message naming them. Every
other round still refuses a conflicting refresh (`open_refused`).

**Bounds.** The rebase round needs a producer with a shell to conclude a merge: a conflict on a
leaf whose executor is shell-less (a red, a `tests-only` leaf), on a cycle, or on a composite
escalates `merge_conflict` as today. Contention on a cycle needs no producer: `serialize` delays the
cycle's merge like any unit's. A conflict on the same paths again after a conflict `resolve`, at a
later approved head, is a remedy that failed: it escalates `merge_conflict` without a second
ruling. A relaunch replays the ruler's stored return under the same thread key, and `judged` lands
once per node and head.

## Data contracts that change

Spec format (`locus:` → `expects:`, optional); node record (`locus[]` → `expects[]`); snapshot
node entry (`locus` → `expects`); producer return (`needs_locus` status and field gone); session
call `adopt` check (`outside_locus` becomes `role_breach[{node, paths}]`, the role rule applied to
the adopted commits); verify payload (`locus-breach` → `role-breach`, `tests_rewritten[]` added,
the `held[]` and `locus` options gone); events (`judged` added); state lines (`breach_reverted`
gone); ledger (`carried` added); conversation messages (`needs_locus` gone, `rebase` added); merge
record (`contended[]` added); ruler schemas (`ruler_contention` added); slots and locks
(`locks/locus/` gone).

## Tests

- `rolePermissions` per role (fast): a writer's allow and deny sets; a red's test-author; a test
  round's and a `tests-only` test-author; a green's implementer and an auditor denied tests;
  commands and the git denies.
- Host contract (`AGENTICS_HOST=1`): the probes' cases, nested worktrees included.
- `contentionOf` (fast): overlap, another folder, same folder ignored, ordered leaves, a standing
  serialize as an order, merged-where-they-meet, coverage only at the ruled heads.
- `judgeClose` and the merge unit: serialize → `judged`, the unit held from merges until `O`
  merges, the later-`O` rule; resolve → merged next batch (contention), `rebase` message and
  relaunch (conflict); replan → planner route and user park; cant_rule → escalation; a repeated
  conflict after resolve escalates.
- The rebase round: open with a conflict kept, open run again, close refusing an unconcluded merge.
- Series `role-breach` and `tests_rewritten`; red verdict against its own diff; advisory deferral
  and its idle fallback in `schedule`; the migration on a fixture store.

## Risks

- **A wrong `expects` costs scheduling, not correctness.** Two leaves the planner did not predict
  to overlap run side by side; inside a folder the merge serializes them, across folders the
  judge sees the real overlap before either merges.
- **The judge adds a call where cross-folder overlaps are real.** One tool-less ruling per
  contended unit, against a replan and re-probe per widening today.
- **A producer can now write anywhere in its worktree.** It cannot write outside it, into the
  store, or into a sibling worktree (decision 2); review reads the actual diff; the series check
  holds the role fences; rewritten tests reach a reviewer as units; the judge sees cross-folder
  writes before they merge.

## Adversarial review (one pass, fresh reviewer, 2026-10-23)

Verdict: **sound-with-changes**. Twelve findings; dispositions below. The revision above is the
result; the reviewer saw the first draft (commit `8f1c388`).

| id | severity | finding | disposition |
|---|---|---|---|
| A1 | blocking | The resume ladder's approval in the schedule boundary bypasses an approval-time judge; a serialized leaf would be approved at its stale head. | Fixed by moving the judge to merge-batch, the one funnel every approved unit passes through; no approval path is intercepted. |
| A2 | blocking | A test-author allowed only test globs breaks tdd-pair/triad where the red writes throwing stubs into the green's source files. | Accepted: the test-only rule binds a cycle's test round and `tests-only`; a red's test-author writes like any writer (decision 2), and decision 4's fence is keyed the same way. |
| A3 | major | A serialized leaf stays `active` and holds its slot; four of them starve the pool. | Gone with the move: serialize delays a merge, and an approved leaf occupies no slot. |
| A4 | major | Two concurrent rulings can serialize each unit after the other: a deadlock. | Accepted: a standing serialize orders units in `contentionOf`, and code admits a wait only on an `O` dispatched first, so the wait graph is acyclic. |
| A5 | major | The rebase round's in-progress merge has no defined path through leaf-close, relaunch or shell-less producers. | Accepted: the open takes an existing merge as its own, the message is answered by the round's dispatch, leaf-close refuses to measure an unconcluded merge (a `failures` round), and shell-less executors escalate. |
| A6 | major | Without the fence a producer can weaken an unrelated existing test until the suite passes. | Accepted as an observation, not a fence: `tests_rewritten` names each such file, and a reviewer must rule it as a unit (decision 5). |
| A7 | major | A `resolve` keyed on (O, path) keeps covering changes it never saw. | Accepted: `judged` stores both heads; a ruling stands only at those heads. |
| A8 | major | Approval-time overlap facts add a concept where merge + fast suite already settle same-folder overlaps. | Partly accepted: same-folder overlap is left to the merge, which already serializes, rebases and verifies; the judge keeps cross-folder contention (where folders meet only at a composite conflict nobody can resolve) and conflicts, as the user's target asks. |
| A9 | major | `approved … by: migration` is an approval with no user act or ruling (L4), and `recordApproval` refuses it. | Accepted: a `carried` ledger line, written only after code checks the texts differ by the keyword alone, read as the same signature; L4 names the format-only carry-over. |
| A10 | major | `/**` must not reach the main checkout or a sibling worktree, both of which contain the leaf worktree's path. | Probed: from a nested leaf worktree, writes to a sibling worktree, the main checkout and `<main>/.agentics/` were denied. Pinned in the host contract. |
| A11 | minor | The migration misses other state the deletions make permanently wrong (breach-reverted held mutations, `locus_held`/`verify_oscillating` stops, pending `needs_locus` routes). | Accepted: the migration lists them for `retry` or replan. |
| A12 | minor | Escalating every cycle `serialize` contradicts "reach the user only when it can't rule". | Gone with the move: serialize on a cycle only delays its merge; only a cycle's conflict escalates, as today. |

## Built as

Three details the build settled differently from the text above:

- **The ruler runs on the folder being merged into**, not on the leaf: a `dispatched` event on an
  approved leaf would read as its next round and make it active again.
- **A replan goes through the program's replan**, as a ruler's `affected` does: under a planner's
  folder a `premise_mismatch` request with the ruler's question; under the user's folder a
  `needs_respec` park of the leaf with that question. There is no separate `contention` escalation
  for a replan; `contention_unruled` and `merge_conflict` remain the two ways the judge reaches the
  user. A unit ruled `replan` stays out of merges until its plan revised it.
- **The migration states the signed line again** rather than writing a `carried` ledger kind: the
  latest `approved` or `prepared` line, every field kept, at the new hash with `carried_from`
  naming the old one. Compile, approval and the effort listing read signed lines by hash, so a new
  kind would have needed a second reader in each.

And one the build found: `ordered` (`lib/atomicity.mjs`) now follows a dependency on a whole folder,
as `dependsOn` did, so a leaf that waits on another folder is no contention fact against its leaves.
