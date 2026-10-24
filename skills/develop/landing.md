# Landing — the one ask

Read when the develop skill reaches step 6. The effort branch `agentics/<effort>` is merged into
the user's branch here, on their explicit go, and nowhere else (`docs/DESIGN.md#landing-and-drift`).

## 1. Check

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" land --repo . --effort <e> --action check
```

It prints the report as JSON: `open_escalations`, `parked`, `human`,
`drift: {base_moved, commits, overlap}`, `root_claims`, `unsettled_claims`, `landing` and `token`, the act the user's
answer must choose. It reads; it writes nothing. `ok: false` with `no_effort_branch` means nothing
was ever built into an effort branch: there is nothing to land; say so and stop.

## 2. Present — gaps first

1. **The landing view.** `landing` is markdown: the root spec's success criteria beside the root
   integration review's verdict on each claim, what did not hold first. Show it as printed. A
   verdict other than `met`, or a view with no verdicts at all, is named before anything else: a
   `cant_tell` is not a pass, and no review is not a clean review. Under the verdicts it prints
   what the review said of the evidence behind each; a view that says the review's evidence was
   not written down has verdicts with nothing shown behind them: say so.
2. **Unsettled claims**, each of `unsettled_claims` verbatim with its folder and ruling: a drift naming
   no failure, or a claim no review could decide. It parked nothing and is no pass; the go accepts it.
3. **Open escalations and parked nodes.** Landing refuses over an open escalation or a parked
   node; resolve those first (develop step 4b–c).
4. **What is not in the effort branch.** When the user asked to land what exists, name every
   planned node that has not merged (`lib/status.mjs show --repo . --effort <e>`), so a partial
   landing never reads as the whole.
5. **Drift.** How the user's branch moved since the effort branch was cut: the commits and the
   files. A file on both sides is where a conflict will be.
6. **Every `HUMAN:` criterion**, verbatim, prefix included. These are the user's to judge before
   the go, and nobody else surfaces them.

## 3. Ask

One `AskUserQuestion`, the check's `token` in the question's own text, offering exactly the options
`Land` and `Not yet` with nothing added to either label. Silence is not a go, and nothing lands
while an escalation or a park is open.

## 4. Merge, on `Land`

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" land --repo . --effort <e> --action merge
```

It first finds the user's answer to the token and refuses unless it chose `Land` on the effort
head the check saw (`head_moved` when the branch has moved on since): run the check again and ask
with its new `token`. Then it merges that head, the one the token names, never the branch as it
stands by then, into the user's checkout with `git merge --no-ff`, records `landed`, and then
sweeps the effort's merged branches and the clean worktrees on them (`removed`), with `git branch
-d` only. It refuses over an open escalation, a parked node or a dirty tree: report the refusal as
it came. A dirty tree is the user's to commit or stash, never yours. A conflict stops the merge:
surface the paths, and resolve nothing without the user.

## 5. Report what was kept

Read `kept` out loud, each branch with its `why`: unmerged branches and dirty worktrees are the
escalated and parked nodes' resumable state, and the user decides their fate. Delete nothing
yourself. Where a `why` says a worktree could not be removed, once the user has closed what held
it, run the check again, ask with its `token` as in 3, and on `Land` run the same `--action merge`:
it merges nothing and sweeps again. Nothing under
`.agentics/<effort>/` is removed: it is the only record of what was decided and done.
