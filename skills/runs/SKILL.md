---
name: runs
description: Use when the user asks what agentics runs exist, wants to resume or pick up a parked or interrupted plan, or asks what they were working on — "what runs do I have", "resume the feature-B plan", "is that still in flight". Lists every run in the repository with its derived status and hands the chosen one to develop. Not for starting new work (use design or develop).
---

# runs

Every `develop` run writes its plan and its wave-by-wave progression to
`.claude/agentics/runs/<runstamp>/`. Several can be in flight at once — that is the point of
parking a plan — and a runstamp is a timestamp, which tells a human nothing about what the
run was for. This skill is how they find it again.

It owns no judgment. It reads a CLI, shows a table, and hands the pick to `develop`.

This listing IS the progress ledger. A hand-maintained progress file duplicates what this
skill derives on every call, and the copy goes stale the moment a run moves — when a user
keeps one, point them here rather than updating it for them.

## Step 1 — List

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run-status.mjs" <repo-root>
```

Prints `{"runs": [...]}`, newest first. Every field is derived from `plan.json` and
`state.jsonl` on each call — nothing about a run's progress is stored as a claim, because a
stored status outlives what it described and the file that is wrong is the one a human reads.

For one run, order by order — "how far through is this one" rather than "which runs exist" —
add `--run <runstamp>`. It prints `{run, orders, counts}`, where `orders` is `{id, wave,
stage}` per work order, derived from the same two files on the same call. `develop` step 2-bis
mirrors that into a todo list while a run is in flight; the same reading is what you show a
user who asks how a run is getting on.

Show a compact table: **change**, **status**, **merged/total**, **age**. Then, per run that
has any, the open escalations. The change description is the column a human actually scans;
lead with it, and never make the runstamp do that work.

Read `label`, not `status`, when you print the status word. `integrated` and `landed` are
claims about the *waved* orders only — coupled orders went to the session and escalations
went to a human, and neither leaves a trace in `state.jsonl`. `label` carries those
qualifiers already. Printing the bare word next to a run with three unimplemented coupled
orders is a partial result wearing a complete one's label.

**`landed` here is run scope: this run's integration head reached its own `base_ref` branch.**
A programme has a `landed` of its own — a slice that reached the *user's* branch — and a slice
run that landed on its programme branch is finished as a run and has reached the user not at
all. When a row carries `programme` and `slice`, say which scope you mean, or point at
`/agentics:programme`, which reports the other one.

`unreadable` is a real status and not an error to swallow: it means the plan or its partition
could not be parsed, so this tool cannot say what the run did. Report it as unknown. Never
show it as `planned` — that invites re-planning work which may already have merged.

`approved_unmerged` is worth reading out loud when it is non-empty: those orders passed review
and are sitting on their branches unmerged, which is the signature of a run interrupted
mid-wave. A resume merges them as they stand once git confirms each branch is still at the
head its review closed over — no coder, no second review. It is derived from two independent
records now: the workflow's own `state.jsonl` and the `journal.jsonl` the merging and verifying
agents append to themselves, so a run whose recorder was killed still reports what it merged
rather than reading as though nothing happened. `measured_unapproved` is the same story one
stage earlier, and its name is the careful part: it means a verification was **recorded** for
those orders, not that it passed. Whether any of them is green is derived by `develop` when it
resumes, against each order's role and locus; this listing does not repeat that computation and
must not report it as though it had. Say "a measurement is on record for W2 and W5", never "W2
and W5 are verified".

Both are reasons to resume rather than re-plan, so say the numbers out loud.

If there are no runs, say so plainly and stop. Do not offer to start one; that is `design`
or `develop`, and the user asked a different question.

## Step 2 — Pick

If the user named a run, use it. Otherwise present the runs with `AskUserQuestion` and let
them choose. Recommend the most recent `in-flight` run when there is one — interrupted work
is more likely what they meant than a plan they deliberately parked.

Do not pick for them when two runs are plausible. A wrong pick spends a full pipeline on the
wrong change.

## Step 3 — Hand off to develop

Invoke the `agentics:develop` skill with the change from the run's `change` field and
`resume_path` set to its run directory, then **follow that skill's step 3 walk**. Do not
reimplement the walk here — a second consumer of that result contract is a second place for
it to drift.

**Carry a path and a change, nothing else.** Do not read `roots`, `caller_notes` or
`intelligence` out of `plan.json` to pass along. Those travel inside the workflow through the
loader, under a schema, and pushing them through this conversation instead would route the
settled-evidence payload through a model's context as free text with no digest over it. That
is the transcription failure the run-state artifact exists to prevent, aimed squarely at the
data it most exists to protect.

A resumed run pays for no survey and no planning. Say so — it is usually the fact that
decides whether the user resumes now or later.

## Step 4 — Archive, when asked

Runs accumulate for the life of the repository, and the moment they are listed, thirty
`landed` rows is how the two live ones get missed. When the list has grown unwieldy, offer to
move `landed` runs older than a cutoff the user picks into
`.claude/agentics/runs/archived/<runstamp>/`.

Move, never delete, and only with an explicit go. A run directory is the only record of what
a run decided and did, it costs nothing to keep, and nothing about it expires on its own —
an old plan is stale, which is a fact the drift gate reports at resume time, not a reason to
destroy the record.

**A run being archived usually still owns branches and worktrees.** Collect them in the same
pass, per run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/gc.mjs" <repo-root> <runstamp>
```

**From the checkout that accepted the run** — the one whose HEAD contains that run's
integration merge. `git branch -d` refuses a branch that is not in HEAD, and that refusal is
the only thing standing between a sweep and a lost series; asked from a checkout that never
took the merge, the same command answers about a tree nobody meant to ask about. The CLI
establishes the reference point before it touches anything and refuses the whole sweep when it
does not hold — read that refusal as "not from here", never as "there was nothing to collect".

It removes the worktrees of merged branches, deletes those branches, and reports what it kept:
unmerged branches, dirty worktrees, and the escalated and held orders those belong to. Say the
kept list out loud. An escalated order's branch is the resumable state, a held red whose green
never landed is work waiting for its pair, and both survive for the same reason — neither ever
reached HEAD, so neither is the collector's to take.

This is the only destructive thing this skill does, so it happens on an explicit go, like the
archive move above and behind the same human acceptance `develop` already requires. A run that
is still `planned` or `in-flight` is not a candidate: its branches are what a resume salvages.

## Progress tracking

If the host exposes `TaskCreate`/`TaskUpdate`, use them for a multi-run session. If it does
not, fall back to `TodoWrite` and say that you fell back.

## What this skill is not

Not a planner and not an executor — every decision it presents was computed by
`lib/run-status.mjs` or is made by the user. Not a place to fix a run: escalations, stale
orders and blocked orders are all `develop`'s step 3, and answering them here would mean two
skills holding the same contract.
