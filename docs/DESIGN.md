# agentics — design

This is the design of agentics as it stands. It describes the system that runs; git holds how it
got here. Where a rule is not self-evident, a **Why** paragraph gives the reason in as few
sentences as the reason needs.

Reading order: the Iron Laws bind everything and have no exceptions. The Guiding Principles decide
every question the laws leave open. Everything after them is the design those two produce.

**When the code and this document disagree, the code is right and this document has a bug.** A
behaviour-changing change updates this document in the same commit series (`CLAUDE.md`).

---

## What the plugin is

agentics is a Claude Code plugin for designing, investigating and building changes in any
codebase. Scripts decide what happens next; models are called only for the steps that need
judgment.

| Directory | What lives there |
|---|---|
| `skills/` | The seven entry points a user invokes (see [Skills](#skills)). |
| `workflows/` | Five workflow scripts, all named `agentics-*`, holding the orchestration. |
| `agents/` | Eleven agent definitions, one narrow role each (see [Agents](#agents)). |
| `lib/` | Node CLIs for everything deterministic that touches disk or git. |
| `tools/` | `lint.mjs`, its rules under `tools/rules/`, `budgets.json`, and the one-shot migration. |
| `test/` | The `node --test` suite, including the scenario harness. |

**A workflow script runs in a sandbox with no module loader and no filesystem.** It cannot import,
read a file or run git. So anything on disk is a `lib/` CLI run by a courier, whose output the
courier pastes back under a digest the script re-checks (GP4).

### What it writes in a target repository

| Path | What it holds |
|---|---|
| `.claude/agentics/efforts/<effort>/` | One effort: its nodes, events, evidence, gotchas, executions, reports and locks ([Storage](#storage)) |
| `.claude/agentics/slots/` | The parallelism pool every execution on the machine shares |
| `.claude/agentics/context/` | Context files the survey and the probe write for their readers |
| `.claude/worktrees/` | Integration and leaf worktrees |
| `docs/agentics/designs/<effort>/` | Design documents — source, committed |

Everything under `.claude/agentics/` and `.claude/worktrees/` is scaffolding, local to the machine.
`.claude/agentics/` ignores itself: every directory made under it goes through
`lib/store.mjs mkdirState`, which writes a `.gitignore` of `*` at its root, whatever the target
repository's own ignore rules say.

### How the plugin checks itself

The runtime artifacts are prompts and scripts, so they are checked in layers — detailed under
[Self-checks](#self-checks): lint judges form, the scenario harness runs the real workflows with
scripted agents, real-git tests run every boundary, and pins keep restated contracts, allowlists
and design pointers from drifting. Run everything with `node tools/lint.mjs && node --test`.

---

## Iron Laws

Four laws. Each names the mechanism that enforces it; a law without one is a defect.

### IL1 — A set task is finished

When a task is set, it is done, and done means **its intent is met and every unit of that intent
is traced to work and to a check** (see [Traceability](#traceability)). No counter ends anything:
no turn, round, token or time limit. A budget, a limit or an agent that cannot proceed produces an
**escalation** carrying what was established, what was tried, what remains, and enough state to
resume — never a result that reads as finished.

*Enforced by:* the `no-turn-caps` lint rule; typed escalation returns on every agent; the resume
ladder.

### IL2 — A partial result never looks like a whole one

Every search-shaped or execution-shaped output states its own completeness: a `stop_reason` enum
and a coverage block saying what was covered, not reached, failed, or recalled rather than
observed. `complete` is computed from those fields, never reported. "Looked and found nothing" and
"never looked" never merge. Incomplete work is resumed on exactly what remains; what stays
incomplete after exhaustion **leads** the report. A failing side channel keeps what was already
paid for and marks what rests on it as unsupported.

*Enforced by:* the `coverage-block` lint rule; `stop_reason` schemas; continuation loops keyed on
`stop_reason`; a `.catch` on every side channel; the `task-tool-fallback` lint rule.

### IL3 — Nothing judges itself

A verdict is computed by a script from recorded observations. The producer of a piece of work never
certifies it; a reviewer has findings and no approval to give; approval is the open-finding set
being empty.

*Enforced by:* agent schemas with no verdict fields (the `no-self-verdict` lint rule); verdict
predicates in code (`lib/verdict.mjs`, the review-loop exit in `agentics-develop`).

**Why:** an agent that can approve can be persuaded, and an agent that certifies its own work is
the examinee marking the exam.

### IL4 — The user owns decisions and their tree

The user is the only author of design decisions; an unanswered recommendation is not adopted, and
no replan may alter a decision the user made. The user's branch and working tree change only by
the user's explicit act: an inline task the user asked for edits the files it was asked to edit;
anything dispatched works on branches and worktrees the framework owns, and reaches the user's
branch only at landing, on an explicit go, with no open escalation. A check that stashes or moves
`HEAD` runs only in a linked worktree, never in the user's tree.

*Enforced by:* landing is the session's act behind a gate (`lib/boundary.mjs land`);
`lib/verify.mjs` refuses to run outside a linked worktree; replans that touch a decision id return
to the user (see [Replanning](#replanning)).

---

## Guiding Principles

Five principles. When two seem to conflict, GP1's order decides.

### GP1 — Fidelity first, then cost, then wall-clock

The objective is lexicographic: (1) the work reflects the spec and the intent, (2) at the lowest
total cost that still gives the assurance the work needs, (3) in the least wall-clock time that
does not raise cost.

- **Parallelism of disjoint work** costs no extra tokens and is always taken.
- **Parallelism over shared context** multiplies cost. It is bought for *independence* — separate
  approach drafts, separate probe readers, a red author who never sees the green — because that
  serves (1). It is bought for *speed* only when the user sets `pace: fast`.

`pace` (`frugal` | `balanced` | `fast`, default `balanced`) is read by the evidence phases when
they decide how many readers share a body of evidence; an execution passes it to the surveys it
buys. Parallelism of disjoint leaves needs no pace: it is always taken, up to the slot pool.

### GP2 — Everything is earned, legibly, and has a live consumer

A stage, dispatch, model tier, reviewer, survey, design level, field, record kind, agent or check
exists only because a nameable property earned it, and only while something consumes it.

- **Leanness is legible.** Whatever ran names the property that earned it; whatever did not run is
  stated. Cost is reported **measured**, never as a projected constant.
- **Leanness never touches verdicts.** What shrinks is dispatches, tiers, phases and levels; the
  predicates a verdict is computed from never shrink once a check runs.
- **Judgment and arithmetic stay apart.** Whether a shape is settled is judgment and stays with
  whoever holds the context; whether evidence is fresh, a grain is exceeded or a tree is unchanged
  is computed.
- **No mechanism outlives its consumer.** A format change ships a one-shot migration script, never
  a permanent second reader. A check enforces this (see [Self-checks](#self-checks)).

**Why:** an element nobody can justify costs as much as a missed check and is harder to see; a
topology nobody can audit grows back to the maximum.

### GP3 — One execution tree, planned and scheduled dynamically

All work is one tree. The repository is the root; an **effort** is a subtree; every node is a
`design`, `composite` or `leaf` node, with the same schema, event log and derived status at every
depth. Any node can be the root of an execution.

- **Decompose until atomic, no further** (see [Atomicity](#atomicity-when-to-stop-splitting)).
- **Replan locally.** A node that is larger than its grain, rests on a false premise, or needs a
  decision returns a typed result, and its parent replans that subtree only. Nothing else stops.
- **Schedule by readiness.** A node starts when its dependencies' outputs exist, never when a
  sibling group finishes. There are no global phases or waves.

**Why:** fixed layers each grow their own vocabulary, store and scheduler, and work that falls
between two layers has nowhere to go. One recursive node makes depth a property of the work.

### GP4 — Scripts do the deterministic work; each agent gets only what it needs

Anything computable is computed in `lib/`: partitions, digests, schedules, verdicts, merges,
statuses, briefs, excerpts, whether recorded evidence still stands. A workflow script has no
filesystem, so disk crosses into it through a **courier**: an agent that runs one command and
pastes its stdout.

- **Bytes that cross a model carry a digest the receiver re-checks.** Lines the workflow mints
  whole travel encoded on one argv slot (or a file path when an argv slot would overflow).
- **One courier per boundary**, running every deterministic step of that boundary in one command.
- **Briefs are assembled by script** from the node, its referenced evidence and the
  [gotchas](#gotchas) its role and locus call for. Shared evidence is resolved once into excerpts
  and handed inline; an agent whose charge can be answered from what it is handed gets no search
  tools.
- **One reader per body of evidence** unless volume or independence (GP1) earns more.
- **Returns are typed and short**; full reports go to files, opened only by a consumer acting on
  them.
- **Runtime text holds instructions and contracts; reasons live in this document.** Definitions
  are sized to the role — a courier's is a few lines — and each has a budget
  (`tools/budgets.json`).

**Why:** writing through an agent is where corruption lives, and every dispatch is paid in context
× turns by that agent and re-read by whoever dispatched it. Every courier is also a round-trip on
the critical path, so the count of boundaries, not of facts, sets the floor.

### GP5 — Durability by the actor; state is derived, never stored

Whoever performs an action records the observation, in the same execution. No agent records a
verdict; verdicts are re-derived from observations by the same functions on every read. The status
of a node, an execution or an effort is computed from append-only logs and git on every read;
anything that displays a status renders it, and nothing trusts a rendered status. One monotonic
`seq` per effort orders records; it is a counter minted by the ledger script, never by an agent,
and never a clock. Resume names the single next undone action per node, trusting a stage only
where the record and git agree.

**Why:** a record written after the fact leaves a window where work exists and nothing says so; a
status written down outlives what it described; a clock an agent can read is a clock it can invent.

---

## Vocabulary

Every skill and agent that acts on these terms carries this block verbatim, so a term means one
thing in every prompt.

<!-- agentics:verbatim vocabulary -->
**The terms.** Each means exactly this wherever agentics uses it.

- **effort**: one piece of work: the folder `.agentics/<effort>/` in the main checkout, and
  everything under it.
- **folder**: a directory of an effort that holds a spec. The effort's own folder is the root
  folder; every folder below it is a **sub-effort**, and is also an entry in its parent's plan.
- **spec**: a folder's `SPEC.md`, written for the user, with the sections Intent, Decisions,
  Design, Plan, Open questions and Evidence. It never holds status.
- **`.state/`**: machine state, written only by scripts: an effort's `.state/` (nodes, events,
  ledger, executions) and the project-wide `.agentics/.state/` (slots, context files, evidence
  items).
- **segment rule**: names of efforts, folders and entries match `^[a-z0-9][a-z0-9-]*$`, at most 120
  characters, with no `--`.
- **plan entry**: one named unit of work in a spec's Plan: a `sub-effort` (its own folder and spec),
  a `task` (built directly), `deferred` (not now) or `dropped` (abandoned; the decisions it
  realises are accepted as not realised). An entry lists the decision ids it `realises` and what it
  waits for in `after`: a sibling's name, or a path from the root folder starting with `/`.
- **author**: who writes a sub-effort's spec: `you` (the default; it goes through the design loop
  with the user) or `planner` (develop's planner writes it, and an autonomous review must pass it).
- **decision**: a ruling of the user's, in their words with their why, with an id: `D<n>` in the
  root folder, `<folder id with / written as .>.D<n>` below it. Only the user authors decisions. A
  contract is a decision.
- **contract**: a named interface one entry `provides` and others `consumes`. Names are unique
  across the effort.
- **approved**: the spec's current hash equals the hash on its latest `approved` ledger line,
  written only after the user approves in so many words. **prepared**: the same against a
  `prepared` line, written only after a planner-written spec passed its autonomous review.
  **Edited since approval**: a line exists and the hash differs; compile leaves the spec out until
  it is approved again.
- **compile**: the operation that turns approved and prepared specs into the execution graph, and
  the only writer of nodes. A folder becomes a `composite` node, a sub-effort with no approved or
  prepared spec a `design` node (the frontier), and a task a `leaf`.
- **task promotion**: a task that must be decomposed gets its own spec in
  `<folder>/<task>/SPEC.md`. Compile then builds it as a composite that realises the task's
  decisions and carries its criteria.
- **finding**: one result of a review, graded `ambiguity` (blocks until settled), `gap` (designed
  away or accepted out loud) or `note` (advisory). To **settle** a finding is to incorporate it
  into the spec or to discard it.
- **claim verdict**: `met`; `under`, `over` or `deviates` (drift); `spec_defect` (the claim can't
  be met as written); `cant_tell` (the evidence doesn't decide it, and it is never a pass).
- **evidence item**: one claim with the anchors it rests on: spans, queries, sources, or other
  items. Its state is derived on read: **standing** (no anchor changed, or it was re-judged as
  holding), **suspect** (an anchor changed and nobody has judged the change), **stale** (judged as
  failing, expired, or resting on a stale item).
- **park**: a node stops and waits for the user. The answer is a re-spec: edit the spec that owns
  the fault, approve it again, recompile.

**The laws and principles.** IL1: a set task is finished. IL2: a partial result never looks whole.
IL3: nothing judges itself. IL4: the user owns decisions and their tree. And:

1. Specs are authored; state is derived. No status goes into a spec, and no render is edited by
   hand.
2. One writer per folder at a time, under the effort lock.
3. Prevent, detect, correct. Detect with the cheapest sufficient instrument (a deterministic check,
   then a fresh agent, then the user), name the fault's class, and apply the class's remedy where
   the fault lives. A new stage, grade or rule is a last resort.
4. Promoting to docs is plan work. When an effort changes what the project's docs describe, its
   plan carries the entry that updates them.
<!-- /agentics:verbatim -->

---

## The execution tree

### Nodes

A node is one revision line in the effort's node log plus its events in the event log. The latest
revision (by `seq`) wins; a replan appends a revision and nothing is rewritten. `lib/tree.mjs`
owns the record, its validation and every node's derived status.

| field | meaning |
|---|---|
| `id` | stable, path-like (`auth/session/refresh-token`); `.` is the effort root; segments are lower-case letters, digits and dashes, so the parent is the id's prefix |
| `title` | imperative; the todo subject |
| `intent` | what this node makes true, in the user's or the parent design's words |
| `kind` | `design`, `composite`, `leaf` |
| `level` | design nodes: `context`, `container`, `component`, `leaf-spec` (see [Design](#design)) |
| `defines[]` | `{id, text}` — the decisions this node states (a design node, or the root when there is no design node) |
| `decisions[]` | ids of the decisions this node realises (see [Traceability](#traceability)) |
| `acceptance[]` | `{text, check, decisions[]}` — each criterion names its check; `HUMAN:` routes one to the user untouched |
| `ground[]`, `ground_known` | paths the node's evidence lives in; `false` earns a survey before planning |
| `locus[]` | leaf: every file it may write (empty only for a `verify` leaf) |
| `reads[]` | leaf: files it builds against and never writes |
| `deps[]` | node ids whose outputs this node consumes |
| `provides[]`, `consumes[]` | named contracts (`{name, paths[]}`); the prefixes drive [drift detection](#landing-and-drift) |
| `shared[]` | composite: designated shared files for its subtree (the [coupled lane](#coupled-work)) |
| `rigor` | leaf: see [Rigor](#rigor) |
| `role` | leaf: `none`, `red`, `green`, `audit` |
| `dispatch` | `{producer?, reviewer?}` each `{model, effort}` — set by the node's author (see [Model tier](#model-tier)) |
| `context` | self-contained prose for the executor |
| `design_doc` | design nodes: the repo-relative path of the document |
| `retired` | a replan removed it |

Events: `planned`, `replanned`, `dispatched`, `approved`, `merged`, `escalated`, `parked`,
`landed`. A leaf's status is, first match: `merged`; `escalated` or `parked` when newer than its
last replan and last revision (a replan or the user's answer clears it); `approved` when newer than
its last dispatch (a held cycle member is approved and not merged); `active` while a dispatch has
nothing terminal after it; `planned`. A composite is `merged` on its own event, the root `landed`
on its, `escalated` or `parked` on its own open event (cleared like a leaf's), and otherwise
summarizes its children (`integrated` once all have merged).

`lib/tree.mjs add` validates a batch of revisions against the tree on disk and appends it all or
nothing: shape problems and tree problems (a missing parent, a dependency cycle, a decision nobody
defined, a green without its red) refuse the batch; the computable atomicity conditions and
traceability gaps come back as warnings. It refuses; it never repairs.

### Storage

```
.claude/agentics/
  .gitignore                      `*`, written by mkdirState
  context/                        context files for survey and probe readers, pruned after a week
  slots/                          the parallelism pool, shared by every execution (see Scheduling)
    config.json                   {max_parallel}, edited by the user
  efforts/<effort>/
    effort.json                   {about, roots, opened_at}, written once
    nodes.jsonl                   authored node revisions, append-only
    events.jsonl                  node events, append-only
    seq, .lock                    the counter and the effort mutex
    branch.json                   where the effort branch was cut, written once
    evidence/                     survey and probe returns, verbatim, anchored to commit + ground
    knowledge/                    gotchas (see Gotchas)
    executions/<stamp>/           one execution of a subtree: execution.json, state.jsonl,
                                  journal.jsonl, briefs/, jobs/
    reports/                      executor reports, one file per dispatch
    locks/                        locus and branch locks
```

`lib/store.mjs` computes every name and path; nothing types one. Design documents are source and
live in the source tree (`docs/agentics/designs/<effort>/`); a design node points at its document.
Worktrees live under `.claude/worktrees/`.

### The ledger

`lib/ledger.mjs` is the only writer of every `.jsonl` under an effort. It mints `seq` per effort
under the effort's lock file — a script minting a counter, so no agent ever supplies one, and a
`seq` that arrives on an entry is overwritten — and refuses a batch that does not parse, has an
entry without a `kind`, or fails its caller's digest. Appends are all or nothing and never
read-then-write. Readers are tolerant: a torn line is counted, never thrown on.

Lines the workflow mints whole travel base64 on one argv slot with a digest, so there is no path
to escape and no apostrophe to close. A line only the observing agent can fill in (a finished
series) goes by heredoc on stdin and carries no digest; the writer still refuses what does not
parse. A digest makes corruption detectable; the encoding makes it unlikely.

A location list is the exception: it is only paths and line numbers, so it travels as plain text
(`path:line:line,path:line`) with a digest over the exact string, because a courier copies paths
reliably and base64 badly. The workflow sends no path outside `[A-Za-z0-9_./@+:-]`, so the list
needs no quoting; such a location goes to its reader to open.

### Context files

What a courier would otherwise carry back — excerpts for a survey judge, a probe's guidance, its
located ground and the document's own citations — `lib/citations.mjs` writes to
`.claude/agentics/context/<digest>-<n>.md` instead. It prints only the files' paths under a
digest, and the reader Reads them. No model retypes an excerpt. Each part is small enough for one
Read (40 KB, 800 lines). Files are named by the digest of their text, so a retried courier
rewrites the same files, and files a week old are pruned on each write.

### Integration branches

Integration is assigned **per composite node, dynamically**. A composite gets its branch and
worktree the first time something needs them, cut from its own parent's integration head, and is
brought up to date with that head whenever the parent has moved — which is how a dependency merged
elsewhere in the tree reaches the leaf that consumes it. Its children branch from it and merge into
it. When its last child has merged and its integration review is done, it merges into its parent's
integration branch like any child.

The effort root's integration branch, `agentics/<effort>`, is the effort branch: the one landed
into the user's branch. Every other node's branch is its sibling, `agentics/<effort>--<flat>`,
where `flat` spells the id's `/` as `.`. **Why not `agentics/<effort>/<id>`:** git stores a branch
as a file under `refs/heads/`, so `agentics/e` and `agentics/e/auth` — or `auth` and
`auth/session` — cannot both exist. Node-id segments carry no dot and effort names carry no `--`,
so the spelling is reversible. Worktrees follow the same names under `.claude/worktrees/`.

- **Concurrent executions** are allowed on any disjoint subtrees of the same effort. Preflight
  refuses only an execution whose root is an ancestor or a descendant of an open one (checkpoint
  `existing_execution`).
- **Locus locks** are effort-wide: a leaf takes a lock on every file of its locus at leaf-open and
  releases it at merge, so leaves in different executions cannot write the same file unordered.
- **Merges into one integration branch are serialized** by a lock on that branch, whichever
  execution performs them.

### Triage

Every node is triaged when it is created — by the session for an effort's root, by the planner for
its children. Two questions fix its **kind**; one more fixes its **mode**.

| question | if **no** |
|---|---|
| Is the intent settled — no approach left to discover? | kind `design` |
| Does it satisfy the atomicity rule? | kind `composite` — decompose |
| Is the ground known — finding where the change goes is not part of the work? | evidence is earned for this node (`ground_known: false`) |

Mode (for an effort root, or any node about to execute): **inline** or **dispatched** — see
[Execution modes](#execution-modes). At the effort root, triage is a recommendation to the user,
and "run it anyway" ends the discussion; inside the tree it is the planner's, shown in the plan.

### Atomicity: when to stop splitting

A **leaf** is the smallest unit of work: one commit series, or — for a `verify` leaf, which writes
nothing — one recorded check. A node is a leaf when **every** condition holds, and is split while
any fails:

1. **One concern.** Its change can be stated as one commit subject without a conjunction.
2. **One rigor and one role.** A single [rigor](#rigor) applies to all of it, and it is authored
   by one agent role.
3. **Closed locus.** Every file it writes is in `locus`, and no file in it is held by another leaf
   that is not yet merged (otherwise the two are ordered by a dependency, or the file goes to the
   [coupled lane](#coupled-work)).
4. **Checkable alone.** Each acceptance criterion, except a `HUMAN:` one, names a check (a test, the
   build, a typecheck, a command) that runs on this leaf's branch alone and decides it.
5. **Green when done.** After it merges, the tree builds and the suite passes — except the declared
   failing tests of a `red` leaf, which never reach the effort branch without their green.
6. **Decided.** Its brief carries every decision the executor needs.
7. **Fits one executor.** Brief + locus files + reads fit the executor model's context budget with
   headroom for its turns, computed by script from file sizes and the model's limit.

Conditions 2, 3, 4 and 7 are computed by `lib/atomicity.mjs`; 1, 5 and 6 are judgment and are
never reported by a script, because a script that claimed to check "one concern" would be a script
whose silence meant nothing.

**Stop.** A node that satisfies all seven is not split further. A split that yields a child failing
4 or 5 is forbidden. A node that fails a condition and has no permitted split — for example a
change to a closed set whose every consumer must change with it — is **`unsplittable`**: it widens
its locus to own every consumer, and if that breaks condition 7 it escalates, naming the condition.

**Recovery grain.** An executor commits at every passing step and marks an unfinished series with a
checkpoint commit (the `agentics-checkpoint` trailer), so an interruption costs at most the
uncommitted step, whatever the leaf's size.

**Why:** the leaf is the recovery grain, the review grain (one reader judges it whole) and the
parallelism grain (disjoint loci run side by side). All three want the smallest unit that is still
independently correct.

### Replanning

A leaf's executor or a planner returns one of these instead of finishing:

| return | meaning | who acts |
|---|---|---|
| `decompose` | the leaf violates atomicity | the planner splits it, preserving every decision id; siblings unaffected |
| `unsplittable` | no permitted split exists | the planner widens the locus, or the node escalates |
| `premise_mismatch` | the brief's premise does not match the code | the planner re-derives the node from evidence; a premise that came from the user goes to the user |
| `needs_decision` | condition 6 failed | the user |
| `contract_changed` | a `provides` contract cannot hold as written | the user — a contract is a decision |

**A user-bound return parks the node.** The workflow cannot talk to the user, so it keeps running
every leaf that does not depend on the parked one, then returns naming what it needs. The answer
arrives as a node revision (`--reason answered`) and a resume, which re-briefs the parked node and
any not-yet-started consumer.

**Autonomous replans preserve decisions.** The planner may split, merge or re-derive nodes only
while every decision id stays realised; anything else is user-bound. `lib/tree.mjs add` enforces
it for every writer but the session: a batch that states or changes a `defines` entry, changes a
contract a node provides, or leaves a decision some leaf realised before realised by no leaf after
is refused, and the planner returns `needs_decision` or `contract_changed` instead. Replans append
`replanned` events; nothing is rewritten, and merged work stays. A replan that leaves a leaf exactly as it was
escalates as `replan_not_converging` rather than sending the same executor back to the same wall.

---

## Execution modes

| mode | earned when | what runs |
|---|---|---|
| **inline** | every leaf is `verify`, `trivial`, `tests-only` or `tdd`, the locus is known, the intent settled, nothing is irreversible, and the leaves' summed fit (condition 7's computation) is within the session model's budget | the session does it — see [The simple task](#the-simple-task) |
| **dispatched** | anything else | an execution: worktrees, executors per rigor, boundary couriers, review per rigor, dynamic merge |

A composite may run inline when all its leaves qualify. What stands behind a leaf follows its
rigor, in every mode: from `tdd` up, the check that each new test fails without the change and an
independent reader (inline, one fresh reviewer over the diff); a `trivial` leaf, its named check
and — when dispatched — the integration review; a `verify` leaf writes nothing, and its recorded
check is its product.

### The simple task

The inline mode has its own entry skill, `task`. Its rules:

- **Verify the premises first.** Check every file, symbol and assumption the request names against
  the code; surface a mismatch before any plan.
- **Split within-scope from auxiliary.** Within-scope is what was asked, including the tests its
  rigor requires. Auxiliary is what the change makes desirable: stale docs, neighbouring cleanups.
  The rigor decides the tests: a `tdd` leaf writes them, a `trivial` or `verify` leaf writes none,
  and the inline mode never adds or drops one on its own. Auxiliary items are proposed as a
  separate list the user accepts or rejects; a rejected item does not exist. A consequence
  ("skipping this leaves the build red") is stated as information, never used to bypass the
  choice.
- **Ask, do not assume.** A genuine within-scope decision goes to the user, batched in one round.
- **The plan is the todo list.** Each todo is one request item and names its check; that list is
  the task's traceability. No plan file, no worktree for the edit, no execution directory.
- **Discriminate in a throwaway worktree.** A `tdd` leaf's fails-without-the-change check runs in a
  linked worktree at the pre-change commit, never in the user's tree.
- **Tripwire.** Raise it — recommending the dispatched mode or a design node — when the work needs
  design exploration, is cross-cutting, adds a dependency or technology, is ambiguous enough to
  iterate, is irreversible or risky, or outgrows the computed fit. An override is honoured without
  a second argument. Growth during execution re-raises it.
- **Verify before claiming done** with the project's own checks. Commit only when asked.

**Why a separate entry:** the lightest path must not load the heaviest skill's text on every turn.

---

## Rigor

Every leaf carries a `rigor`, set by its author. Walk the table top-down; the first match wins.

| rigor | the work… | leaves | verification |
|---|---|---|---|
| `verify` | writes nothing: confirms a premise, proves a criterion already holds, measures | no producer; the named checks run at leaf-close | the checks' results, recorded; a failure is a finding for the parent, not a fix round |
| `trivial` | writes a change a test would only restate: literal values and user-visible text (a window title, a label, a message), config values, docs, assets, renames behind an unchanged interface, dependency versions, wiring of existing parts | one implementer leaf | the named check, when the leaf needs one to show it works (build, typecheck, the existing suite, running it, a `HUMAN:` look); a test asserting the changed value is updated in the same leaf |
| `tests-only` | only adds tests to code that is already correct | one test-author leaf | each new test passes now and fails under a mutation the test-author declared |
| `tdd` | adds behaviour whose expected results the criteria state exactly | one implementer leaf, test first | at least one new test; each fails at base and passes now |
| `tdd-pair` | adds behaviour where a wrong reading of the criteria would pass its author's own tests: edge-case rules, parsers, state machines, concurrency, contracts other nodes consume | a `red` test-author leaf, then a `green` implementer leaf | red: its tests fail for want of the implementation; green: they pass, tests untouched |
| `tdd-triad` | as `tdd-pair`, and a miss ships silently into durable state or is costly to find: persistence formats, migrations, data loss, security, money | red, green, then an `audit` leaf | as `tdd-pair`, plus the auditor's declared mutations are killed |

**Would a test only restate the diff?** A test of a `trivial` change asserts that the value
written is the value written. A `tdd` change has a result the diff does not state literally — a
computed value, a branch taken, an error raised — and that result is what its test pins. Unsure
between `trivial` and `tdd`: `tdd`.

Unsure between `tdd` and `tdd-pair`: `tdd` when the leaf is small, `tdd-pair` when it is not.

- **`tdd-pair` and `tdd-triad` are separate leaves** with `deps` (green on red, audit on green),
  each with its own branch, todo, review and resume action. Green is cut from red's branch and
  receives red's committed tests as artifacts, never red's report. No agent authors both a
  behaviour's tests and its code; the declared loci are the separation, checked by the
  commit-series check.
- **A cycle lands as a unit.** Red is held on approval; its cycle merges together, through its
  tip, once the last member is approved, so the effort branch is never red.
- **Mutations are declarations.** A test-author or auditor declares `{file, find, replace,
  expect_failing}` in its report; leaf-close applies them by script and restores the file. A
  `find` matching zero or several times refuses, pointing at the declaration. Audit gaps return as
  `decompose` with new `tests-only` or `tdd-pair` children.
- **Review follows rigor.** `tdd-pair`, `tdd-triad` and any leaf that `provides` a contract get a
  review loop of their own; `trivial`, `tests-only` and `tdd` leaves are reviewed at integration;
  `verify` leaves write nothing to review.
- **A fix round** on a test finding goes to a fresh test-author; on an implementation finding, to a
  fresh implementer.

**Why:** assurance should rise with the cost of a wrong reading, and the cheapest assurance that
closes the specific hole is the right one.

---

## Design

Design is a subtree of design nodes, refined top-down in levels as a C4 model is: each level states
only what the level below needs, and a level is written only when a child reaches it.

| level | states | done when |
|---|---|---|
| `context` | the intent: who it is for, the outcome, success criteria, boundaries, what is out of scope | the user ratifies it |
| `container` | which subsystems change, and the contracts between them | every contract has a name, an owner and path prefixes |
| `component` | per subsystem: components, interfaces, data shapes | the planner can write children that satisfy atomicity |
| `leaf-spec` | per leaf: acceptance criteria and their checks | the node is a leaf |

- **A level is earned.** A change inside one subsystem skips `container`; inside one component,
  `component`. The skip is recorded.
- **Evidence is scoped to the level.** Each level surveys only the ground it needs, reuses standing
  evidence, and runs the outward search (`agentics-find-existing-solutions`: does this already
  exist?) concurrently with the survey when it would build a capability.
- **Decisions are the user's and carry ids.** One question at a time, dependency order first, each
  with a recommendation and its reason. Open questions are graded `blocking`, `parked`, `lookup`,
  `compost`; a level with an open `blocking` question does not hand down.
- **Approaches in parallel when the decision space is open.** Independent drafts from assigned
  stances (GP1: bought for independence); skipped and recorded when the level has one obvious
  shape.
- **The probe is earned** by length or by a contract other nodes consume (see [Probe](#probe)).
- **Just in time.** Only the frontier's lower levels are written; a sibling reaching the frontier
  gets its level then, with its ancestors and delivered siblings as settled context.

**Why:** most design errors are errors of intent or of contract, and both are cheapest to catch at
the level that states them; writing lower levels early pays for detail the upper levels will change.

### Traceability

Every decision at every level has an id. When an effort has no design node, its root's decision
list is the request's items as triage stated them. Every child lists the decision ids it realises;
every leaf's criteria trace to them. Before anything is dispatched, `lib/traceability.mjs`
computes:

- decisions no child realises — a **blocking gap** (a node with no children yet is frontier, not a
  gap);
- criteria that trace to no decision — reported, for the user to accept or remove.

The integration review receives the decision list of the subtree it reviews.

**Why:** a plan that silently drops a decision passes every leaf-level gate, because each gate
checks a leaf against its own criteria.

### Probe

`agentics-probe` attacks a written artefact — a design, a proposal, a spec — before anyone builds
from it. The probers are not the author: each receives the document and the repository's excerpts
and nothing from the author. Findings sit on the design ladder (**ambiguity** blocks ratification;
**gap** is designed away or accepted out loud; **note** is advisory), and `ratifiable` is computed:
false while any ambiguity is open, and false when any axis went unexamined. There is no fix loop;
the probe reports and a human rules. The ladder's and the disposition's wording are the verbatim
blocks `design-severity-ladder` and `probe-disposition` in the `design` and `probe` skills.

One analyst holds every axis as a checklist; more are bought only when the document is long
enough to earn them. A second round is earned only by a resolution that reshaped the design.

### What a probe costs

Measured from one 17-agent probe of a 120-line document: 36.5M tokens billed to return about 538k
of evidence. **The cost is turn count, not payload**: every turn re-sends the accumulated context,
and sixteen analysts each independently located the same lines. So the probe resolves the
document's cited evidence once (`lib/citations.mjs`) and hands every analyst the excerpts, and the
head count is earned by length rather than by axis count.

The Ground phase writes three sets of [context files](#context-files): the document's own
citations and the located repository ground, which every prober Reads, and the located guidance,
which only the axes analyst Reads. Each set comes from one script run, so the probers share one
read of the ground.

---

## Evidence

### Survey

The survey (`agentics-survey`) gathers evidence for one node and never concludes.

1. **Plan.** One analyst decomposes the question into topics, names each topic's subtree and the
   common ground.
2. **Scout.** One scout per topic, the common ground scouted once. Scouts return locations and a
   `stop_reason`, with `no_match` and `not_reached` kept apart, and are continued on exactly what
   remains until exhausted. History and docs channels run alongside when the plan asks, each with
   its own `.catch`.
3. **Assemble context for analysis.** Judges are dealt first: one analyst for every topic,
   unless `pace` or more than 60 distinct locations earns more. Then, per judge, a script
   (`lib/citations.mjs excerpts`) reads that judge's locations and the shared ground's, merges
   overlapping windows and writes them to [context files](#context-files). Two judges sharing
   ground each get their own copy of it.
4. **Judge.** Each analyst **without search tools** Reads its context files, then judges its
   topics. A batch whose paths could not be carried reaches it as locations to read itself.

A recorded survey **stands**, and is reused instead of bought again, when its commit is an ancestor
of HEAD, no commit or uncommitted edit has touched its ground since, and it reported complete
coverage — all computed from git by `lib/effort.mjs standing`. A node whose shape is settled and
whose ground a standing survey covers buys no survey, and says so.

---

## Gotchas

`agentics` keeps no knowledge base. It keeps one narrow kind of memory: **gotchas**, the traps an
agent fell into while working, recorded so the next agent does not.

**What qualifies.** An observation is a gotcha only when **all** hold:

1. **Hit, not foreseen.** The agent attempted something in this effort and it failed or misled it:
   a command errored, a tool misbehaved, a check reported something false, a convention was
   enforced by a tool.
2. **Resolved and seen to work.** The agent found a workaround and observed it succeed.
3. **About the environment, not the work.** Tooling, build and test commands, setup, platform
   quirks, tool-enforced conventions. Never a design decision, a fact about the code's behaviour
   (that belongs in the code, its tests or the design), a task's status, or an opinion.
4. **Actionable.** Statable as *when* <trigger> *do* <action>, with the evidence: the failing
   command and the output line that showed it.
5. **Not in the brief.** Nothing the agent was handed already said it.

One distinguished kind, **`command`**, records how to build, typecheck and test; only an
investigator writes it, and it is the one gotcha verification reads.

**Where and how.** `.claude/agentics/efforts/<effort>/knowledge/<id>.md`, one file per gotcha, with
a one-line JSON frontmatter: `kind` (`pitfall` | `command`), `roles` (who needs it), optional
`paths` (locus prefixes it applies to), `observed_at` (commit) and `source` (node and role). The id
is minted by script from the normalised trigger, so the same trap recorded twice is one file. An
executor reports gotchas in a fenced block of its report file; leaf-close extracts and writes them
— no model retypes one. Brief assembly appends every gotcha whose `roles` include the brief's role
and whose `paths` (if any) overlap its locus. A gotcha an agent observes no longer holds is
deleted, not marked.

**Why so narrow:** a memory that stores claims about the code goes stale silently and is then read
as fact; a gotcha is checked the moment it is used, because the trigger either happens or does not.

---

## Execution

An execution runs a subtree in the integration worktrees of its composites and in per-leaf
worktrees, and never touches the user's tree. The workflow is `agentics-develop`; the session
launches it with a stamp it minted, because a workflow cannot read a clock.

### Boundaries

Every deterministic step runs at one of five boundaries, each one courier dispatch running one
`lib/boundary.mjs` entry point under one digest. Every entry point is **idempotent**: re-running it
after an unobserved outcome converges on the same state, because each step first checks whether its
effect already exists (a merge already in the branch, a record already in the log, a worktree
already attached).

| boundary | fused steps |
|---|---|
| **preflight** | refuse an execution overlapping an open one; drift check against the envelope's base; traceability; free this execution's slots and its dead worktrees (clean ones only — a dirty one is reported, never forced); the resume ladder per leaf; create the todos. `reload: true` re-reads the tree after a planner wrote nodes, and does nothing else |
| **leaf-open** | acquire a slot and the locus locks; ensure the parent's integration branch (lazily, refreshed from its own parent) and cut or attach the leaf's branch and worktree; assemble its brief; append `dispatched`; move the todo |
| **leaf-close** | commit a shell-less author's locus files (anything outside is reverted and reported as a breach); build, typecheck, suite, discriminator, declared mutations and named checks by rigor; journal the observation; write and delete reported gotchas; compute the close decision; move the todo |
| **merge-batch** | under the branch lock, record `batch-started` with the head it starts from; merge every approved child into one integration branch in dependency order; verify the merged head; bisect a red one; append `merged` and `merge-observed`; release locus locks; append a `batch` state line; complete the todos. A batch that started and never recorded its outcome is reset to where it started and done again, so an unverified merge is never recorded as landed |
| **postflight** | release this execution's slots; append `closed` when done; report branches and worktrees eligible for cleanup |

Each boundary first appends the workflow's pending decisions (`records`: approvals, escalations,
parks, dispatch cost lines), once each — a record re-sent after a lost courier lands once.

**Long checks run detached.** leaf-close and merge-batch run in a child process keyed by their
arguments and by what their answer depends on — the worktree's head and state, the report, the
established commands, the target's head — and are polled; a poll that reaches the limit (kept
under a host's default shell limit) answers `pending`, and the workflow re-dispatches the same
boundary, which finds the same job. A host's shell timeout can end a courier, never the work. The
same arguments over a moved tree are a new job, and a job that failed is never kept as an answer.

**Integration branches are locked while they move.** leaf-open creates, attaches and refreshes
each integration branch on its chain under that branch's lock, and cuts the leaf under its
parent's, so concurrent leaf-opens and a merge-batch bisecting into the parent never race; a
lock held longer than a leaf-open may wait answers `busy`, and the workflow re-dispatches.

**Retries are sized to what was observed.** A courier that returned nothing or could not run the
command is re-run once, because the entry point is idempotent; a payload that fails its digest
buys one refetch on a stronger model; an argument token the program refused as damaged buys one
fresh courier; a program failure is not retried. What is still unbelievable escalates as a
transport failure.

### Merging

Merging is `lib/merge.mjs`: `git merge --no-ff` in the integration worktree, aborting on conflict
itself. The merge-result contract:

Merge mode reports exactly four fields: `stop_reason` (`completed` or `environment_broken`),
`merged_sha` (`''` when the merge did not complete — a fact, not a verdict), `conflicts`
(conflicting paths verbatim from git; empty when none), and `notes` (what was actually run). The
caller derives the outcome as `mergeOk = stop_reason === 'completed' && merged_sha !== '' &&
conflicts.length === 0` — never from `conflicts` alone, because an `environment_broken` merge has
an empty conflict list too. Anything that is not `mergeOk` stops the batch. A conflict is a planner
defect — loci were declared disjoint — surfaced to the user as an escalation, never resolved
silently.

A merge-batch whose merged tree equals the tree of a leaf head with a recorded green measurement
skips re-verification.

**A failing merged head** is reset to the last green head, and the script bisects the batch. A leaf
that fails alone on the new head gets a fix round on its branch refreshed from the integration
head; a composite or a cycle that fails alone has no one producer to send it to, and escalates
(`fails_on_integration`); leaves that each pass alone and fail together escalate as a
**combination failure** naming all of them — it is a design question, not a leaf's. A batch that
cannot run at all escalates its target (`merge_batch_failed`), and one that merged nothing and
reported no failure escalates too (`merge_no_progress`): nothing is re-batched into a stopped
target.

### Scheduling

A ready set per execution, recomputed whenever anything in flight settles. A leaf's dependencies are
its own and every ancestor's: a dependency declared on a composite binds every leaf beneath it. A
leaf is ready when its dependencies' outputs exist where it will be cut — a dependency (or its ancestor just below the
two nodes' lowest common ancestor) has merged into that ancestor's integration branch, or, for a
cycle predecessor, is approved — no open escalation or park sits on its dependency chain, and a
slot can be had. A merge-batch runs whenever approved children wait on an integration branch
nobody is merging into. Cycles are held and land as a unit.

**Parallelism lives at the leaves and is controlled from outside the execution.** A slot is the
right to run one leaf. The pool is `.claude/agentics/slots/`: its size comes from one configuration
file the user edits (`max_parallel`, default 4), read at every leaf-open, so a change takes effect
on the next dispatch in every running execution at once. Slots are lock files naming their holder
leaf, acquired at leaf-open. A slot is free when its holder's derived status is no longer active
(approved, held, merged, escalated or parked) — or when it is no longer a leaf, because a replan
decomposed it — so release needs no write of its own; a locus lock whose holder was decomposed, or
whose revision dropped that path, is free for the same reason; a slot whose
holder belongs to an execution that is no longer running is freed by that execution's next
preflight, or by the user.

**Who controls what.** The workflow script decides *which* leaves are ready and in what order —
arithmetic over the plan and the events, in the script — and keeps no more leaf chains in flight
than the pool's current size. It cannot touch the pool, which is on disk, so *admission* is decided
by `lib/locks.mjs` inside leaf-open: the entry point takes a slot and the locus locks atomically, or
waits for them in-process (polling the lock files locally, costing no tokens) until they come free.
A wait that reaches the host's shell-call limit returns `no_slot` or `locus_held`, and the script
re-dispatches leaf-open for that leaf; nothing else stalls. A lock held by an escalated or parked
leaf frees only when the user acts, so leaf-open answers `stuck` at once and the leaf is reported
blocked by that holder rather than waited on. The user controls the limit.

When the session set a token target, the scheduler does not start a leaf that the remaining budget
cannot cover at the execution's measured cost per leaf; it stops after the next merge-batch
instead. `pause` is a launch flag with the same effect after the next merge-batch.

**Why a lock-file pool rather than a scheduling agent:** the pool is arithmetic, costs no tokens,
is shared by every execution and every session on the machine, and survives any of them dying. A
persistent agent receiving messages could do the same job, but it would put a model on the
scheduling path (GP4), re-read its growing conversation on every message, lose its state with its
session, and need a courier turn per message from a workflow.

### Coupled work

A leaf whose locus includes a designated shared file (an ancestor composite's `shared`: lockfiles,
configuration roots, barrel files) is **coupled**. It runs on its own branch cut from its parent's
integration head, under the same rigor, verification and review, and merges through a
merge-batch. Coupled leaves run one at a time; everything else keeps running.

### Executors and review

- **Executors** are standalone agents, one per leaf per round: implementer, test-author, auditor.
  Each fetches its brief by reference and confirms its digest (a shell-less author reads it, and
  leaf-close re-checks), writes a focused commit series inside its locus (no amends, no rebases),
  writes its report to a file, and returns a short typed status: `done`, `done_with_concerns`,
  `blocked`, `needs_context`, or a [replanning](#replanning) return. The implementer journals
  `series-done` by heredoc when it has finished; for a shell-less author leaf-close commits its
  files and journals it.
- **Verification failures** send a fresh producer a fix round carrying the failures. A fix round
  that returns no commits escalates (`fix_without_commits`); two consecutive measurements failing
  identically escalate (`verify_not_converging`). lib/verdict.mjs escalates what no commit inside
  the locus can move — a discriminator that is the only failing fact on a `tdd` leaf
  (`discriminator_undecidable`), a locus breach and a broken build alternating
  (`verify_oscillating`) — and any environment error by its kind.
- **Review** is a fresh reviewer each round, given the brief, the span, the executor's concerns and
  the prior round's open findings. The exit is computed, never judged:
  - Round 1 reviews the whole series; later rounds rule on the open blockers and review the fix
    span alone — the merged change is reviewed whole again at integration.
  - The blocking set is the round's criticals, plus its majors when the leaf provides a contract
    and the finding carries a non-empty `failure_scenario`.
  - The open set is the round's blocking findings, plus every prior blocker ruled
    `not_fixed`/`regressed` in `fix_verdicts` — or not ruled on at all — that the round did not
    re-report. Never narrow this to the round's criticals alone.
  - The leaf is approved when the open set is empty — a count the workflow computes.
  - It escalates when a fix round returns no commits or a blocked status, when the same finding is
    ruled `not_fixed`/`regressed` in two consecutive rounds, or when two consecutive rounds each
    rule every prior blocker fixed and still mint new blocking findings.
  - Otherwise a fix round, re-verification, and a fresh reviewer. No round counter ends the loop.
- **The code severity ladder** is the verbatim block `severity-ladder` (in `agents/reviewer.md` and
  below): critical must not merge; major is real but mergeable and blocks only on a contract leaf,
  only with a failure scenario; minor never blocks. A fix verdict on a prior blocker is `fixed`,
  `not_fixed` or `regressed`.

<!-- agentics:verbatim severity-ladder -->
- **critical** — must not merge: violates or fails an acceptance criterion; introduces
  incorrect behavior; security or data-loss risk; a new test that does not discriminate
  (would pass without the change); behavior change inside a commit presented as a refactor;
  any edit outside the declared locus.
- **major** — real but mergeable: a genuine defect or hazard that does not fail an
  acceptance criterion (unhandled edge case beyond the spec, misleading name, duplicated
  logic). Reported in the result for the human gate; never loops — except on a leaf that
  provides a contract, whose majors are held open and block exactly as criticals do:
  an ambiguity in a contract propagates into every consumer.
- **minor** — style. Reported once; never blocks, never loops.
- Severity is assigned by consequence, never by conviction. A critical or major names the
  concrete input, state, or consumer that goes wrong, in `failure_scenario`; a major that
  cannot name one is a minor wearing the wrong label, and on a contract leaf that
  mislabel costs a full fix-verify-review round. A finding whose only remedy is rewriting
  an already-landed commit is advisory by definition — the series is append-only. Finding
  nothing new is a real, reportable answer; a severity is never raised to make a round
  look thorough.
<!-- /agentics:verbatim -->

- **Integration review** runs per composite node, over the merged diff of its children, against its
  decision list and the criteria of every child reviewed there. It is earned when a child had no
  review loop of its own, or when two or more children with work meet there; otherwise it is
  skipped and the log says why. When planned children did not land, every finding carries that
  caveat. Its criticals park the composite for the user.
- **Establishing commands** is judgment: when no build or test command is established, leaf-close
  returns `command_unknown`, and an investigator establishes them once for the execution, recorded
  as `command` gotchas.

### Model tier

The node's author sets `dispatch` per stage, because it holds the context. Defaults: **producers**
(implementer, test-author) run the cheaper model, with effort scaled to the leaf's difficulty;
**gates** (reviewer, planner, analyst) run the stronger model at moderate effort. A leaf whose
output is a yardstick — `red`, `audit`, or one that `provides` a contract — runs its producer on the
stronger model too. A fix round that failed to clear its blockers raises the producer one step, and
that step may exceed the user's ceiling. The user's intelligence dial is otherwise a ceiling,
derived from the session's model unless the user moves it (`low` → sonnet gates, `normal` and `max`
→ opus, `max` one effort step deeper). Effort follows the model a dispatch resolves to: opus at
medium, sonnet one step above its call site's base. Couriers run the cheapest model.

### Landing and drift

An execution delivers into its root's parent integration branch, and ultimately the effort branch,
without asking; the user's tree is not involved.

After each merge-batch, the landed diff is intersected with the `consumes` path prefixes of every
pending designed node; a hit goes to the user as facts, and they rule unaffected, re-design or
re-slice. Until they rule, the consumer is parked (`contract_drift`); everything else keeps
running. Undesigned nodes are reported as unexamined.

**Landing is the one ask.** When the effort is complete, or the user says to land what exists, the
session runs `lib/boundary.mjs land --action check` — how the user's branch drifted since the
effort branch was cut, open escalations and parked nodes, every `HUMAN:` criterion verbatim —
asks, and runs `--action merge`, which merges the effort branch into the user's checked-out branch
and appends `landed`. It refuses over an open escalation, a parked node or a dirty tree. Cleanup of
merged branches and their clean worktrees (`--action cleanup`) follows on a go, and only from the
checkout that took the merge.

---

## Verification

`lib/verify.mjs` runs the mechanical checks of one leaf — the commit series, the build, the
typecheck, the suite, the discriminator, the declared mutations and the named checks — in one
process. **Nothing in it decides whether the leaf passed.** It observes, prints exactly the fields
the verdict reads, and journals its own `verify-observed` line inside the process that measured, so
there is no window between the work and the record.

Which checks run is the leaf's rigor (and, in a cycle, its role):

| rigor / role | series | discriminator | mutations | named checks |
|---|---|---|---|---|
| verify | no | no | no | yes |
| trivial | yes | no | no | when given |
| tests-only | yes | passes-now half read | required (≥ 1 declared) | when given |
| tdd | yes | full: fails at base, passes now | when declared | when given |
| red | yes | red: fails now, fails at base | no | — |
| green | yes | the red leaf's tests pass now | no | — |
| audit | no series expected | no | required | — |

- **Absent is never inferred, in either direction.** `absent` means the repository defines no such
  command; `failed` means a command ran and exited non-zero. A command nobody named and nobody
  declared absent is `command_unknown`, a typed error.
- **A passing suite is not evidence that the tree compiles.** The typecheck is its own answer.
- **The environment check runs first, and it refuses.** The discriminator stashes and moves HEAD,
  so the program first establishes that it stands in a linked worktree. It always puts the tree
  back, or says `tree_not_restored`.
- A test that could not be launched at base is `test_unrunnable`; a suite failure that cannot be
  placed against a test file raises `suite_failures_unnamed`.

### What a verdict is computed from

`lib/verdict.mjs` is the one home of the measurement verdict. `measurementOk(m, leaf)` derives pass
or fail from the observations against the leaf's profile (every profile needs a completed
measurement, no failed build or typecheck and no blocking series finding; then per profile: a tdd
leaf's new tests fail at base and pass now; a tests-only leaf's tests pass and every declared
mutation bites; a red leaf's tests fail now and at base; a green leaf's cycle tests pass; an audit's
mutations all bite with a passing suite; trivial and verify need their named checks and a suite
that did not fail). `closeDecision` turns that into the next step: `review`, `approve`, `fix`,
`escalate`, `command_unknown`, or — for a `verify` leaf — `finding`. The same functions re-derive
the verdict on resume, which is what makes a journal written by the measuring process safe.

---

## Resume and checkpoints

Resume (`lib/resume.mjs`) computes, on disk, one next action per leaf — `none`, `merge`, `review`,
`verify`, `continue-series`, `code` — adopting a stage only where the record and git agree:

| What the record and git agree on | next action |
|---|---|
| a `merged` event, or the leaf head is in the parent's integration branch and a witness agrees (the approved head, or a `merge-observed` line) | `none` |
| approved, and the branch is still at the approved head | `merge` |
| a green `verify-observed` at the branch head | `review` for a leaf with its own review loop, else `merge` |
| the branch tip is a checkpoint commit | `continue-series` |
| commits and a `series-done` at the tip | `verify` |
| commits without | `continue-series` |
| nothing on the branch | `code` |

A salvaged series is closed and reviewed at the round that produced it, over its own fork point
and brief; a merge merges the head the approval named, never the branch as it stands. A checkpoint
commit (the executor's mark on an unfinished series) means continue, never measure. A
clean execution (no records for its leaves and no leaf branches) opens for the cost of one branch
listing. Committed work is salvaged by right and reported as salvaged; uncommitted work is reported
and adopted by nobody. Escalations carry forward until the user names them in `retry_escalated`. A
resume adopts its envelope (base, dial, pace, commands) from `execution.json`.

A checkpoint dispatches nothing new and says how to proceed:

| checkpoint | meaning | to proceed |
|---|---|---|
| `existing_execution` | an open execution's root is an ancestor or descendant of this one | resume it; or `confirmed_duplicate` |
| `blocking_gaps` | untraced decisions, or evidence the node depends on was not reached | `confirmed_gaps` |
| `parked` | the caller launched with `plan_only`, or nodes await a user-bound return | resume with the answers |
| `stale` | the user's tree moved under the plan; per leaf, `writes` and `reads` that moved | `confirmed_stale` |

---

## Progress

The user follows work through the todo list of the session that launched the execution. The
couriers that run the boundaries move it live while the workflow runs.

- **One todo per node**, subject `<node-id> — <title>`; composites get one too, completed by the
  merge-batch that merges them.
- **The stage is the `activeForm`**, set to what happens next: `implementing`, `writing tests`,
  `auditing` or `checking` (leaf-open); `in review`, `awaiting merge` or `fix round N`
  (leaf-close, from the decision); `held` for a cycle member awaiting its tip; `waiting on user`
  (a parked node); completed on merge; pending with the reason when escalated.
- **The movers are the boundary couriers**, which already run at every stage change, so progress
  adds task-tool calls to existing dispatches and no dispatch of its own. The first boundary that
  sees a node creates its todo and returns the task id; later boundaries carry it.
- **`--no-progress`** drops those calls. The session then derives the list from the event logs
  (`lib/status.mjs todos`) on launch, on wake and on return, and the workflow's log still narrates
  every boundary. The same path serves a host whose subagents have no task tools: the courier
  reports `task_tools: unavailable` and the workflow says so.
- **The list is a view.** Nothing reads it back as state, it is never hand-edited, and a status
  header (`ONGOING`, `DONE`, `NEEDS_INPUT`) is rendered from derived status for display only.

**Why a flag:** each todo move is a turn on a courier, which is cheap but not free; a user who
watches the log or checks in only at the end should not pay for it.

---

## Agents

| role | does | cannot | tools |
|---|---|---|---|
| scout, historian, doc-researcher | find, to exhaustion | conclude | search tools; historian read-only git; doc-researcher the web |
| analyst | judge what it is handed | search | `Read` only |
| planner | triage, decompose, set rigor and dispatch, write nodes | implement | read, search, shell (for `lib/tree.mjs`), write |
| implementer | code one leaf as a focused series, or its fix round | leave its locus, amend, merge, certify | read, edit, shell |
| test-author | write a leaf's tests and declare mutations | implement, execute anything | read, edit |
| auditor | declare mutations against an implementation | edit source, execute anything | read, write (its report only) |
| reviewer | attack a span | approve, edit | read, read-only git |
| investigator | establish build and test commands when none are known, recorded as `command` gotchas | judge quality, fix anything | read, shell |
| courier | run one command, paste stdout; move todos | anything else | shell, task tools |

### Capability layer

Capability is the tool allowlist and nothing else — no hooks. The test-author, auditor, analyst,
scout and doc-researcher carry no shell, so the authors of every yardstick are structurally unable
to run what they wrote; their files are committed and their mutations applied by leaf-close.
Agents with a shell are restrained by their definitions and audited post hoc (the locus by the
commit-series check): the criterion is zero breaches surviving to review. The allowlists are pinned
by `test/agent-allowlists.test.mjs`.

Two host facts shape the roster. **An agent must carry at least one tool**, so the analyst — which
the design wants tool-less — keeps `Read` alone: it cannot search, and it opens only what it was
pointed at. **A subagent may not be granted task tools**; the courier lists them, and when they are
absent it says so and the session takes the `--no-progress` path.

---

## Skills

| skill | entry for |
|---|---|
| `task` | the inline mode |
| `design` | a design node at any level |
| `develop` | executing any subtree: triage, launch, result walk, landing |
| `probe` | attacking a written artefact |
| `investigate` | answering a question from evidence (`agentics-investigate`) |
| `find-existing-solutions` | the outward search (`agentics-find-existing-solutions`) |
| `status` | listing efforts, nodes and executions with derived status; handing one to `develop` |

A skill file holds the router and the steps; step detail lives in reference files loaded when the
step is reached. A contract several files must state identically is a verbatim block, placed only
in the files whose reader acts on it.

---

## Data contracts

Workflow scripts cannot import, so a contract can live in several places at once. Each entry names
its **owner** (the code that defines the shape) and where it is **restated**; a change to a field
list edits every place named, in the same commit series.

Two conventions hold throughout:

- **Digests** are FNV-1a, 32-bit, 8 hex characters, over `canonical()` from `lib/plan-digest.mjs`:
  keys sorted, `undefined` read as `null`. `agentics-develop` carries identical copies.
- **A CLI whose output a courier carries back** prints `{payload, payload_digest}` and exits 0,
  even when the payload reports a typed error. `{error}` with exit 1 means the program itself
  failed. Arguments minted by the workflow arrive as `--b64 <token> --digest <d>`; a mismatch is
  refused as `digest_mismatch`, and nothing is written.

### Node record and events

- **Owner:** `normalizeNode`, `nodeProblems`, `treeProblems`, `deriveStatus` in `lib/tree.mjs`;
  `EVENT_KINDS` in `lib/ledger.mjs`.
- **Restated in:** `agents/planner.md`; `skills/develop` and `skills/design` (the root and design
  node JSON); the preflight row in `lib/boundary.mjs`; `todoFor` in `lib/status.mjs`.

Fields as in [Nodes](#nodes). Event lines are `{kind, node, execution, seq, ...}`:
`planned {by}` · `replanned {reason, by}` (also `retry_escalated` and `answered`) ·
`dispatched {role, round, model, effort}` · `approved {head_sha, review_rounds, at_integration}` ·
`merged {into, merged_sha, head_sha}` · `escalated {reason, detail}` · `parked {return, question}`
(`return` is a replanning return, `needs_design`, `integration_critical` or `contract_drift`) ·
`landed {into, merged_sha}`.

### State and journal lines

- **Owner:** `lib/boundary.mjs` (`batch`, `checkpoint`, `closed`, `merge-observed`, `series-done`
  for shell-less authors), `dispatch` in `agentics-develop`, `journalLine` in `lib/verify.mjs`.
- **Restated in:** the implementer's `series-done` heredoc in `agentics-develop`; `lib/resume.mjs`
  and `lib/status.mjs` (readers).

`state.jsonl` (what the workflow decided): `dispatch {label, node, role, model, effort, tokens}` —
`tokens` is `null` where the host reports none; `batch {target, merged[], head_sha, verified,
failed_alone[], combination[], conflict}`; `checkpoint {reason}`; `closed {status}`; `batch-started {target, pre, children}`.

`journal.jsonl` (what was observed, by whoever observed it): `verify-observed {node, branch,
worktree, base_sha, head_sha, stop_reason, build, typecheck, suite, failing_tests, discriminator,
mutations, series_findings, checks}`; `merge-observed {node, branch, into, merged_sha, head_sha}`;
`series-done {node, branch, head_sha, commits[{sha, subject}]}`.

### The seq counter

- **Owner:** `append` in `lib/ledger.mjs`.

An integer, one counter per effort across the node log, the event log and every execution's state
and journal, minted under the effort lock and never supplied by a caller. It is rebuilt from the
highest `seq` on disk when the counter file is lost. What it decides is ordering: which revision is
latest, and whether an escalation or park is newer than the replan that would clear it.

### Verify payload

- **Owner:** `blank()` and `verify()` in `lib/verify.mjs`.
- **Restated in:** `measurementOk`/`closeDecision` in `lib/verdict.mjs`; `lib/resume.mjs`; the
  merge-batch's integration check in `lib/boundary.mjs`.

`stop_reason` (`completed | environment_broken`, broken exactly when `error` is set); `build`,
`typecheck`, `suite` (`passed | failed | absent`); `suite_output_tail` (only when the suite failed);
`failing_tests[{file, id}]`; `discriminator[{test_id, failed_on_base, passes_now}]`;
`mutations[{file, applied, unapplied_reason, expect_failing, observed_failing, bites}]`;
`series_findings[{sha, check, message, blocking}]`; `checks[{command, status}]`; `notes`; `error`
(`null` or `{kind, message}`: `no_worktree`, `main_worktree`, `series_unreadable`,
`command_unknown`, `shell_refused`, `suite_failures_unnamed`, `base_checkout_refused`,
`test_unrunnable`, `tree_not_restored`); `journal` (`null` or `{written, error}`). The series checks
come from `lib/commit-series.mjs`: `empty-series`, `empty-commit`, `locus-breach`, `wip-subject`,
`checkpoint-commit`, `and-subject`, `subject-length`.

### Gotcha file

- **Owner:** `lib/gotchas.mjs` (`renderGotcha`, `parseGotcha`, `gotchaProblem`,
  `extractReportBlocks`).
- **Restated in:** the brief's report contract (`lib/brief.mjs`); `agents/investigator.md`;
  `agents/implementer.md`, `agents/test-author.md`, `agents/auditor.md` (the report blocks).

Frontmatter `{id, kind, roles, paths, observed_at, source, command?}`; body `When <trigger>, do
<action>.` plus the evidence. Report blocks: `agentics-gotchas`, `agentics-gotchas-stale`,
`agentics-mutations`, `agentics-commit`.

### Slots and locks

- **Owner:** `lib/locks.mjs`, `withLock` in `lib/store.mjs`.

`slots/config.json {max_parallel}`; `slots/<n>.lock {effort, execution, node}`;
`locks/locus/<fnv1a(path)>.lock {path, node, execution}`; branch and mutex locks hold `{pid, host,
at}`. A lock on this host is broken exactly when its holder's pid is dead; one from another host
after ten minutes.

### Boundary payloads

- **Owner:** `lib/boundary.mjs`.
- **Restated in:** `agentics-develop` (the readers); `test/harness/develop-sim.mjs`.

Every payload: `{boundary, ok, error, todos[{op, key, task_id, subject, activeForm, status}],
notes}` plus:

- **preflight** — `checkpoint`, `envelope {stamp, root, base_branch, base_sha, dial, pace,
  commands, resumed}`, `nodes[row]`, `leaves[{id, next_action, note, branch, worktree, head_sha,
  base_sha, approved_head, commits, dirty, rounds, brief_path}]`, `gaps`, `untraced`, `atomicity`, `coupled`, `stale`, `freed`,
  `dirty_worktrees`, `commands`, `max_parallel`. A row is `{id, title, kind, level, rigor, role,
  deps, locus, reads, provides, consumes, decisions, dispatch, ground_known, evidence, status,
  reason, rev, children, acceptance_n, human, own_review, coupled, integration}` — no prose.
- **leaf-open** — `status` (`opened | no_slot | locus_held | busy | refused`), `branch`, `worktree`,
  `base_sha`, `head_sha`, `rebased`, `brief_path`, `brief_digest`, `report_path`, `slot`,
  `max_parallel`, `held_by[{effort, path, node, execution, status}]`, `stuck`.
- **leaf-close** — `status` (`done | pending`), `node`, `head_sha`, `measurement`, `decision {next,
  reason, failures[{check, claim, evidence}]}`, `gotchas_written`, `gotchas_deleted`, `mutations`,
  `committed`.
- **merge-batch** — `status`, `target`, `target_branch`, `target_worktree`, `target_base`,
  `merged[{id, merged_sha}]`, `conflict {node, nodes, paths, reason}`, `head_sha`, `verified`,
  `measurement`, `failed_alone[{id, ids, failures}]`, `combination[]`.
- **postflight** — `cleanup[{node, branch, worktree, merged}]`, `unmerged`, `closed`.
- **land** (the session's, plain JSON) — `check`: `open_escalations`, `parked`, `human`,
  `drift {base_sha, base_moved, commits, overlap}`, `root_status`; `merge`: `merged_sha`;
  `cleanup`: `removed`, `kept`.

### Replanning returns

- **Owner:** `EXECUTOR_STATUSES` in `agentics-develop`; `EXECUTOR_STATUSES` in `lib/brief.mjs`.
- **Restated in:** `agents/implementer.md`, `agents/test-author.md`, `agents/planner.md`.

`done | done_with_concerns | blocked | needs_context | decompose | unsplittable | premise_mismatch
| needs_decision | contract_changed`, with `detail` saying what was established, tried and needed.

### Coverage block

- **Owner:** each workflow's result builder (`result()` in `agentics-develop`, `coverageOf` in
  `agentics-survey` and `agentics-find-existing-solutions`, inline in `agentics-probe` and
  `agentics-investigate`). The `coverage-block` lint rule requires one on every exit.
- **Restated in:** the skills that walk a result.

`complete` (computed, per workflow; for `agentics-develop`: no checkpoint, every leaf in scope
merged, the root integrated, nothing escalated or parked — carried from an earlier invocation or
not — and no earned integration review or survey lost), `dropped[]`, `incomplete[]`,
`failed_channels[]`, `unreached[]` (prose, loss first), `resumable {runId, remaining, args?}`.

### Workflow returns

- **`agentics-develop`** — takes `repo, effort, root, execution, intelligence, pace, plan_only,
  pause, progress, retry_escalated, confirmed_duplicate, confirmed_gaps, confirmed_stale, base_ref,
  commands, plugin_root`. Returns `{effort, root, execution, checkpoint, nodes_n,
  implemented[{id, rigor, role, rounds, review_rounds, at_integration, salvaged}],
  escalations[{id, reason, detail}], parked[{id, return, question}], blocked[{id, blocked_by}],
  integration{branch, head_sha, reviews[{target, findings, notes, reviewed}]}, drift, cleanup,
  cost{dispatches, by_model, tokens}, stopped, notes, coverage}`.
- **`agentics-survey`**, **`agentics-probe`**, **`agentics-investigate`**,
  **`agentics-find-existing-solutions`** — their inputs and returns are stated at the top of each
  workflow and in the skill that launches it.

---

## Self-checks

- **Lint** (`tools/lint.mjs`, one module per rule under `tools/rules/`) checks form: no
  counter-based termination, a coverage block on every exit, no verdict fields in agent schemas, no
  schema bounds, no imports in workflows, namespaced agent types, valid workflow `meta`, agent
  frontmatter, gate clauses in gated skills, a stated task-tool fallback, and size budgets.
- **The scenario harness** (`test/harness/workflow-host.mjs`) runs the real workflows with scripted
  agents; `test/harness/develop-sim.mjs` answers `agentics-develop`'s boundaries from an in-memory
  tree. Every claim about dispatch count is a harness assertion, not prose.
- **Real git.** Every boundary, the resume ladder, verification and landing are tested against
  real repositories and worktrees.
- **Pins:** verbatim blocks match across files (`test/verbatim-blocks.test.mjs`); every agent's
  tool allowlist is pinned (`test/agent-allowlists.test.mjs`); every pointer into this document
  resolves (`test/design-doc.test.mjs`).
- **Liveness** (GP2, `test/liveness.test.mjs`): every agent is dispatched by a workflow or a skill;
  every record kind is written somewhere and read somewhere; every field a workflow's schema asks
  for is read by that workflow; every lint rule has its test; every library export is used
  somewhere. Defined-never-dispatched, written-never-read and read-never-written fail the suite.
- **Budgets:** each skill and agent definition has a size budget in `tools/budgets.json`; the
  `size-budget` lint rule fails a file over it, or one with no budget.
- **Cost report:** every execution records its dispatches with model and effort (and tokens where
  the host reports them) as `dispatch` state lines; `lib/status.mjs cost` aggregates them so the
  next triage quotes measured figures.
- **Migration:** `tools/migrate-legacy.mjs` is the one-shot move of a repository's pre-tree state
  (runs, the knowledge base, programmes, effort links) out of the live paths; nothing reads the old
  formats.

---

## Keeping this document true

- A behaviour-changing change updates this document in the same commit series as the code. Agent
  definitions and skill texts count as code here.
- It describes the present. No history, no increment numbers, no links to documents that no
  longer exist. Git has the history.
- `test/design-doc.test.mjs` pins that every section has a body and every pointer into this
  document resolves; `test/verbatim-blocks.test.mjs` pins the `severity-ladder` block above
  against its copy in `agents/reviewer.md`.
- `docs/superpowers/` is gitignored local scratch for planning sessions. Nothing in the repository
  may point into it.
