---
name: plan
description: Use when a ratified design describes several deliverable slices rather than one change, and the slices need a graph — order, dependencies, and the contracts that pass between them. Produces programme.json and plan.md with the user, in conversation. Also the way an existing programme is re-sliced when the world turns out different. Not for a single change (that goes straight to develop) and not for deciding work orders inside a run (the planner agent does that).
---

# plan

The **HOW** of a programme. `design` decides what a system should be; this decides what order
it arrives in and what passes between the parts.

```
design    the WHAT   system.md + leaf docs. Requirements, decisions, invariants,
                     contracts in the design's vocabulary. NO graph.

plan      the HOW    programme.json + plan.md. Slices, deps, provides/consumes with
                     paths, advance mode. Built FROM the ratified design, with the user.

programme the DO     one run per slice, on the programme branch.
```

**One name, two grains, and they never meet: `plan` decides slices; the planner agent inside a
run decides work orders.** Say that sentence when it comes up. The collision is verbal only,
and this is the disambiguation.

Invoking this skill **is** the user's opt-in for anything it launches. Do not ask again.

## When not to use it

- The design describes **one** change. Then there is no graph to draw: go to
  `agentics:develop` and let the run-level planner be the HOW.
- The user wants the work built. That is `agentics:programme`.
- The design is not ratified yet. Finish `agentics:design` first — a graph over an
  unratified design is a decomposition of something that may not survive the interview.

## The artifact is the authorization

`programme.json` can only come into existence through a session like this one, with the user.
It **is** this conversation's work product, which is why any later session that finds it on
disk may proceed without re-asking for permission to build.

That is not an approval *record*. Nothing stored says "the user approved" — a signature like
that goes stale the moment the design is edited underneath it. The artifact simply exists or it
does not, and when a design change invalidates the graph, the graph is revised here, with the
user, and **the revision is its own approval**.

This is also what closes standing mode's self-approval hole structurally rather than by
promise: a session cannot create a DAG alone, so its authorization always traces back to an
artifact the user co-authored.

## Step 1 — Read the design, then propose the decomposition

Read `system.md` and any leaf that already exists. The slices come from the design's own
vocabulary, not from a shape you like.

**A slice is a deliverable, not a layer.** Each one ends with something the user can actually
use. A "data-model slice" nobody can experience is containment wearing a slice's name: it costs
what a slice costs and delivers nothing, and the feedback that was supposed to shape the next
slice never arrives.

Propose an ordering with reasons, then walk it with the user **one decision at a time**, the
way `design` runs its interview. Every question carries a recommendation, with the reasoning
attached. The user authors the graph; you draft it.

The decisions worth their own question:

- **Where the seams are.** Which deliverable ends where, and what the user has at that point.
- **What passes between them.** Every contract gets a **name** from the design's vocabulary and
  a **path set** — repo-relative prefixes, forward slashes. The name is what a consumer joins
  on; the paths are the mechanical half, and every drift check in this layer is a path-set
  intersection rather than a model's reading of prose.
- **Real orderings that carry no contract.** Pedagogy, risk sequencing, "we want to learn X
  before committing to Y" are legitimate dependencies. They are legal *with a reason attached*,
  and the loader refuses them without one — because a dependency nobody can revisit is
  indistinguishable from a `consumes` somebody forgot.
- **`advance`.** `gated` stops after every slice and presents; `standing` proceeds through
  implementation on its own. It is explicit and never inferred. Recommend `gated` unless the
  user asks otherwise; step 4 of the programme skill lists exactly what `standing` still stops
  for, and it is a long list.

## Step 2 — Write `programme.json`

Into the design directory: `docs/agentics/designs/YYYY-MM-DD-<name>/programme.json`.

```json
{
  "advance": "gated",
  "nodes": [
    { "id": "world", "kind": "group", "parent": "" },
    { "id": "walk",  "kind": "slice", "parent": "world",
      "delivers": "a walkable meadow on the tablet",
      "deps": [],
      "provides": [
        { "name": "NavigationGrid", "paths": ["src/core/navigation/"] },
        { "name": "TapToMove",      "paths": ["src/game/interaction/"] }
      ],
      "consumes": [] },
    { "id": "hug",   "kind": "slice", "parent": "world",
      "delivers": "the first need met by walking up and hugging",
      "deps": ["walk"],
      "provides": [ { "name": "NeedLifecycle", "paths": ["src/core/needs/"] } ],
      "consumes": ["NavigationGrid", "TapToMove"] }
  ]
}
```

**Authored facts only. Never progress.** Progress is derived from the event log on every read;
a progress field here would be a claim that outlives what it described.

**The programme's identifier is the directory name, entire.** There is no `slug` field, here or
anywhere — a field restating the directory name can only ever disagree with it.

**Two relations, kept apart.** `parent` is containment and is optional; `deps` is dependency, a
DAG over slices, and may cross subsystem boundaries freely. **A slice's parent is not its
prerequisite.** Collapsing the two schedules work by where it happens to be filed.

A dependency that carries no consumed contract takes the long form:

```json
"deps": [{ "id": "walk", "reason": "the user learns the meadow before anything moves in it" }]
```

Then validate — **the loader is the check, not your reading of it**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/programme.mjs" <repo-root> --programme <name>
```

It refuses eleven ways, each of them a defect nothing downstream would notice: a duplicate id,
a parent that is a slice, a containment or dependency cycle, a contract with no paths, a
contract name used twice, a `consumes` naming a slice the consumer does not depend on, an
ordering with neither a contract nor a reason. **It repairs nothing.** A graph this tool
patched into shape is a graph the user did not author, and every later decision would rest on
it while the file said something else. Fix the file and re-run.

## Step 3 — Write `plan.md`

The human half, beside the JSON: **the reasons**. Why this decomposition, why these contracts,
why this order. Authored here, in the conversation, in the user's words where they gave them.

Then splice in the generated view:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/programme.mjs" <repo-root> --programme <name> --write-view
```

It writes the graph into a marker-delimited section and leaves everything you wrote alone.
**Prose explains, JSON specifies, and the only restatement is machine-written.** `system.md`
carries no graph at all — a third copy would be a third thing to keep true.

## Step 4 — Commit, and hand off

Commit both files. Where they go depends on whether the programme branch exists yet: before the
first dispatch there is none, so they go on the user's branch with the root design; afterwards
they are programme-owned and belong on the programme branch, in its worktree.

Then:

```
Skill({ skill: 'agentics:programme' })
```

Say plainly what now exists: a graph, the frontier it implies, and that the artifact is the
authorization — a later session will build from it without asking again.

## Revisions

Re-invoking this skill on an existing programme is a **revision**, scoped to the pending
subgraph. You may reorder, split, add or drop pending slices, and edit their contracts.
**Delivered slices are never edited** — what happened is the event log's business, and rewriting
the graph underneath a delivered slice makes the log describe a programme that no longer exists.

Two things route here on their own:

- **A drift flag.** The programme skill intersects a landed slice's diff with each pending
  slice's consumed paths. On a hit, the user rules: unaffected, re-design, or re-slice. The
  last two are revisions.
- **Follow-up work.** A slice that ends with something left over is **closed as it is** — its
  `accepted` event records that ruling — and the leftover becomes **a new slice**, added here,
  with its own deps. Dependents that needed the missing piece are re-pointed at it in the same
  revision. There is no "gap-closed" event and no re-opening: the vocabulary stays four events,
  and a slice that means two different things at two different times is a slice nobody can
  reason about.

Re-run the loader and `--write-view` after every revision.

## Progress tracking

If the host exposes `TaskCreate`/`TaskUpdate`, they are reasonable for a long revision session.
If it does not, fall back to `TodoWrite`, carry the dependency order in the list itself, and say
that you fell back.

## What this skill is not

Not a designer — it decomposes a design that is already ratified and never decides what the
system should be. Not an executor — it writes two files and stops. Not the run-level planner:
that agent decides work orders inside one slice, from surveyed evidence, and the two never meet.
