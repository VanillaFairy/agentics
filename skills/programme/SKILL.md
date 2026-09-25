---
name: programme
description: Use when a repository has a programme — a design decomposed into slices by agentics:plan — and the user wants to see where it stands or drive the next slice. Renders the hierarchical status, designs the frontier slice just in time, dispatches one develop run per slice onto a branch this layer owns, and asks once at the end whether to land it. Not for a single change (develop) and not for drawing the graph (plan).
---

# programme

The **DO** of a programme. One run per slice, on a branch this layer owns, until every slice
has arrived and the user says land it.

Session-driven rather than a workflow, for the same reason `design` is: every step here either
talks to the user or launches something, and a workflow script can do neither.

Invoking this skill **is** the user's opt-in for the `Workflow` tool. Do not ask again.

**Everything about progress is derived on read.** Nothing in this skill stores a status, and
nothing in it judges one. `lib/programme.mjs` computes the tree from the authored graph plus an
append-only event log, and you present what it computed. The hand-maintained stage table this
layer replaced said `pending` beside a stage that was in flight at the time, which is what a
stored claim does.

## The branch and the worktree

```
branch:    agentics/programme-<programme-dir-name>
worktree:  .claude/worktrees/programme-<programme-dir-name>/
```

Created lazily, at the first dispatch, from the user's current HEAD:

```bash
git worktree add -b agentics/programme-<name> .claude/worktrees/programme-<name> HEAD
```

then record the base you branched from, observed rather than assumed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/programme.mjs" <repo-root> --programme <name> \
  --append-opened --base-branch "$(git rev-parse --abbrev-ref HEAD)" --base-sha "$(git rev-parse HEAD)"
```

Ensure `.claude/agentics/` and `.claude/worktrees/` are gitignored before either, exactly as
develop's step 1 does — the event log and the worktrees are scaffolding rather than source.

The worktree stays on the branch for the programme's whole life. Every slice run gets it as
`roots` and the branch as `base_ref`; every slice's integration branch merges into it; leaf
documents and plan revisions are committed on it.

**The user's checkout is untouched** until the landing ask. That is the invariant the whole
arrangement exists to hold: a programme runs for days across many runs, and every one of them
has a convenient reason to put something in the tree the user is sitting in.

If the branch or the worktree already exists, **attach** — that is the resumed programme, not a
conflict. Delete nothing and force nothing. A worktree that has been deleted or corrupted is
recreated from the branch; a run in flight at that moment is lost with it, exactly as develop's
own integration worktree already is.

## Step 1 — Reconcile, render, route

**Reconciliation comes before anything new.** Derive every status first, and if any slice is
`in-flight` with an interrupted run, or `delivery-pending`, **finishing that is the first order
of business** — automatically under `standing`, presented first under `gated`. New work is never
started over interrupted work, at this level or inside a run.

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/programme.mjs" <repo-root> --programme <name>
```

Add `--json` when you need the fields to route on; the plain form is what you show the user.
With one programme in the repository `--programme` is optional. With several, the CLI prints
the names and you ask which.

Show the tree, frontier first. Then route, and **every state has a route**:

| state | route |
|---|---|
| `awaiting-design` | the scoped design pass (step 2), then continue as `ready` |
| `ready` | step 3 |
| `in-flight` | present the run and offer to resume it. The user knows whether it is live in another session. **Never re-plan.** |
| `delivery-pending` | complete the between-slice acts (step 4). You may ask git whether the merge already landed before redoing it — the ban on ancestry is about deriving *status*, never about checking before an act |
| `delivered (gaps open)` | present the gaps for an `accepted` ruling, or route leftover work to a plan revision |
| `blocked` / `pending` | name the dependencies holding it, and stop |
| `unknown` | present the cause. **Never dispatch over it.** |

A loader failure or a degraded event log presents the diagnostic and stops. A state file that
exists but will not read, or a single line that will not parse, renders the **whole programme
`unknown`** — a malformed line names no slice, so its blast radius is undecidable, and freezing
everything is the only reading that cannot dispatch over a fact nobody could read. The repair is
a person fixing one line in a text file.

## Step 2 — Design the frontier slice, just in time

Only the frontier slice's leaf is written at ratification time; the rest exist in the graph as
positioned, contracted, undesigned nodes. When one reaches the frontier, **invoke the design
skill** — never restate its steps:

```
Skill({ skill: 'agentics:design', args: 'programme=<name> slice=<slice>' })
```

In that scoped mode design treats the root and delivered predecessors as settled context, scopes
its survey and interview to slice-local decisions, writes the leaf into the programme tree,
probes it, emits the section markers as its final act, and returns here instead of handing off.
Its own gate applies unchanged: the pass cannot end with a blocking probe ambiguity open.

There is **no ratification ceremony per leaf and no recorded approval.** Authorization flows
from `programme.json` existing at all — it could only have come from a `plan` session with the
user. A leaf is dispatchable when the plan exists and its markers are present.

A session that dies mid-design leaves a marker-incomplete document, which derives as
`awaiting-design` again. That is the entire recovery mechanism: mechanical, no ceremony, no
boundary re-asking.

If the leaf conversation reveals the graph itself is wrong — the slice wants splitting, a
dependency is missing — that is a **plan revision**, and the user is by construction present for
the conversation. Hand to `agentics:plan`.

## Step 3 — Drive one ready slice

- **`change`**: extracted from the leaf's marked `change` section. Mechanical, never composed.
- **`notes`**: assembled by the CLI, byte for byte:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/lib/programme.mjs" <repo-root> --programme <name> --notes <slice>
  ```

  It concatenates the root's settled evidence, the leaf's decisions and settled evidence, and
  the satisfied dependencies with their merge shas. A missing marker fails loudly and by name.
  **No model sits between the ratified documents and the planner's prompt.** On a resume, pass
  no `notes` at all — the run adopts its envelope from disk.
- **`roots`** = the programme worktree. This one is silent when it is wrong: a survey run over
  the user's checkout confidently describes a tree missing every predecessor slice, because
  every predecessor lives on the programme branch and nowhere else.
- **`base_ref`** = the programme branch.
- **`programme`** and **`slice`** = copied from `programme.json`, never retyped.

Then invoke `agentics:develop` and **follow its step-3 walk exactly** — escalations first,
its reporting rules, its blocked and coupled buckets. This skill restates none of it, except the
one supersession below. Coupled orders are implemented in the run's integration worktree, never
in the user's checkout.

## Step 4 — After the run returns

1. **Walk the develop result first**, per its step 3. Escalations go to the user, coupled orders
   are implemented in-session, blocked orders are held. A `checkpoint` return — `blocking_gaps`,
   `stale`, `plan_only` — **is not a delivery**: it routes through develop's own step 3, whose
   resolutions are user decisions, and nothing below this line runs. Nothing below runs while an
   escalation is open either.

2. **Merge the slice into the programme branch.** No ask, in either advance mode:

   <!-- agentics:verbatim programme-merge-target -->
   In a programme run, develop step 3d's merge target is the programme branch, in the
   programme worktree, performed by the programme skill without a per-slice ask; its
   dirty-tree and no-open-escalation guards apply unchanged; the user-branch merge it
   describes happens once, at landing.
   <!-- /agentics:verbatim -->

   The question the user wants asked is about *their* branch, once, and this is not their
   branch. A conflict here means the tree moved under the run or two slices overlapped
   undeclared — surface it, never resolve it silently.

3. **Append `delivered`**, with the run's coverage block copied **whole**:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/lib/programme.mjs" <repo-root> --programme <name> \
     --append-delivered --slice <slice> --run <runstamp> --merged-sha <sha> --coverage <file>
   ```

   Write the coverage block to a file exactly as the workflow returned it. Never recompute it,
   never summarize it, and never select from it: copying the block whole is what removes the
   selection problem instead of relocating it. The mirror at
   `.claude/agentics/programmes/<name>/progress.md` refreshes on every append.

   **Never compose an event by hand.** The append verbs validate shape and refuse duplicates,
   and they are the only way a line reaches that file. At run level every event passes through
   a schema; this is that discipline kept one level up.

   External work — a pre-programme run, human-authored code, another tool's output — enters
   with `--run ''` and a required `--ruling`, and only on the user's instruction. That is the
   brownfield door, and the user's voucher is its entire evidence.

4. **Check for drift** — mechanical first, judged second:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/lib/programme.mjs" <repo-root> --programme <name> \
     --drift <the programme head before this merge>
   ```

   It diffs that sha against the programme branch's head in the worktree, resolves each pending
   *designed* slice's consumed contracts to their providers' `provides.paths`, and intersects.
   Do not do this arithmetic yourself: every drift check in this layer is a path-set
   intersection precisely so that it is never a model's reading of prose.

   Read **both** halves of what it returns. `flagged` is what moved under a contract somebody
   is waiting on. `unexamined` names the pending slices that are not designed yet and therefore
   declare nothing to intersect — say so out loud, because "no flag" and "nothing to check
   against" are different answers, and reporting the second as the first reassures the user
   about a slice nobody looked at.

   A non-empty `flagged` goes to the user as facts. The ruling is theirs: unaffected, re-design,
   or re-slice. The last two are plan revisions.

   The limit, stated: `provides.paths` are directory prefixes, so this sees a contract's files
   moving, being deleted, or gaining neighbours — not a semantic change inside a file it never
   names.

5. **Advance.** Under `gated`, stop and present. Under `standing`, proceed — under one rule:

   > **Standing advances through implementation and never authors a decision this plugin
   > reserves for the user.**

   It stops, saying which trigger fired, on any user-decision point. The known instances: an
   undesigned or marker-incomplete leaf, an escalation, a checkpoint return, a gap needing
   acceptance, a drift flag, a `HUMAN:` acceptance criterion a run surfaced, an
   integration-review critical, an `unknown` or `delivery-pending` slice it cannot mechanically
   finish, a loader or state failure, and programme-complete. **The rule is the closure; the
   list is its known instances, not its bounds.**

   **It also stops before a slice it does not expect this session to survive.** A slice
   boundary is the cheapest stop this layer has — the previous slice is merged, its delivery
   event is appended, and the frontier recomputes from disk — so a session running low pays
   almost nothing to stop here and a great deal to be killed halfway through the next
   `develop` run instead. What that costs is not the tokens: work in flight when a limit lands
   leaves nothing to resume from, because the agents that had not yet returned recorded
   nothing. Say which slice is next and what it is estimated to take, and let the user decide
   whether to start it now or in a fresh session.

## Step 5 — Landing, the one ask

On programme-complete — every slice landed or delivered with nothing open, no `unknown`, no
`delivery-pending` — or whenever the user says "land what we have":

First **observe the drift** of the user's branch against the `opened` anchor, and present those
facts *with* the ask. Divergence seen before the yes is a conversation; discovered after it, it
is a conflict.

Then, on yes, **merge the programme branch** in the user's checkout:

```bash
git merge --no-ff agentics/programme-<name>
```

Develop step 3d's dirty-tree and no-open-escalation guards apply unchanged. Then record the act:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/programme.mjs" <repo-root> --programme <name> \
  --append-merged --sha <sha> --base-branch <branch>
```

Which slices the merge carried is derived, not typed — everything delivered and not yet merged
is exactly what was on the branch.

On no, everything stays delivered and mergeable; nothing is lost and nothing is undone. A
conflict is surfaced, and resolving it is a conversation rather than an autonomous rebase.

Clean up only after the user accepts the landing, per develop's "Afterwards". The event log and
the design tree are the record, and they are kept.

**An empty frontier is not completeness.** A programme can have nothing dispatchable and still
be unfinished — a slice delivered with an unruled gap blocks its dependents while nothing is in
flight. Present what blocks; only programme-complete triggers the ask above.

## Live status

`--watch` re-renders on filesystem events in a second terminal. Every CLI append also rewrites
`progress.md` from the same deterministic renderer. Both are local, gitignored, and never
hand-edited.

Granularity, stated honestly: the on-disk heartbeat is per wave plus per approved order.
Agent-level liveness is the harness's own `/workflows` view, and this layer does not duplicate
it.

## Progress tracking

If the host exposes `TaskCreate`/`TaskUpdate`, use them for a multi-slice session. If it does
not, fall back to `TodoWrite`, keep the dependency order in the list, and say that you fell back.

## Deliberately not imported

`reasonable`'s seven-variant gate-result union — the session talks, and step 4's closure rule is
its honest residue. Gated-versus-autonomous as a global session mode: only the ratified
`advance` bit exists here. The enrichment pipeline, fences, ledger and budget machinery, all of
which are solved one level down.

## What this skill is not

Not a designer and not a planner — it invokes both and restates neither. Not an implementer:
every line of code comes from a `develop` run. Not an arbiter of progress — `lib/programme.mjs`
computes every status word you print, and none of them is yours to soften.
