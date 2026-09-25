# agentics — design (next)

This is the target design of agentics. It replaces `docs/DESIGN.md` as the implementation lands;
until then, `docs/DESIGN.md` describes what runs and this document describes what is being built.
It carries no history. Where a rule is not self-evident, a **Why** paragraph gives the reason in as
few sentences as the reason needs.

Reading order: the Iron Laws bind everything and have no exceptions. The Guiding Principles decide
every question the laws leave open. Everything after them is the design those two produce.

---

## Iron Laws

Four laws. Each names the mechanism that enforces it; a law without one is a defect.

### IL1 — A set task is finished

When a task is set, it is done, and done means **its intent is met and every unit of that intent
is traced to work and to a check** (see [Traceability](#traceability)). No counter ends anything:
no turn, round, token or time limit. A budget, a limit or an agent that cannot proceed produces an
**escalation** carrying what was established, what was tried, what remains, and enough state to
resume — never a result that reads as finished.

*Enforced by:* the lint rule forbidding counter-based termination; typed escalation returns on
every agent; the resume ladder.

### IL2 — A partial result never looks like a whole one

Every search-shaped or execution-shaped output states its own completeness: a `stop_reason` enum
and a coverage block saying what was covered, not reached, failed, or recalled rather than
observed. `complete` is computed from those fields, never reported. "Looked and found nothing" and
"never looked" never merge. Incomplete work is resumed on exactly what remains; what stays
incomplete after exhaustion **leads** the report. A failing side channel keeps what was already
paid for and marks what rests on it as unsupported.

*Enforced by:* the coverage-block lint rule; `stop_reason` schemas; continuation loops keyed on
`stop_reason`; a `.catch` on every side channel; the task-tool-fallback lint rule.

### IL3 — Nothing judges itself

A verdict is computed by a script from recorded observations. The producer of a piece of work never
certifies it; a reviewer has findings and no approval to give; approval is the open-finding set
being empty.

*Enforced by:* agent schemas with no verdict fields (no-self-verdict lint); verdict predicates in
code.

**Why:** an agent that can approve can be persuaded, and an agent that certifies its own work is
the examinee marking the exam.

### IL4 — The user owns decisions and their tree

The user is the only author of design decisions; an unanswered recommendation is not adopted, and
no replan may alter a decision the user made. The user's branch and working tree change only by
the user's explicit act: an inline task the user asked for edits the files it was asked to edit;
anything dispatched works on branches and worktrees the framework owns, and reaches the user's
branch only at landing, on an explicit go, with no open escalation. A check that stashes or moves
`HEAD` runs only in a linked worktree, never in the user's tree.

*Enforced by:* landing is the session's act behind a gate; `lib/verify.mjs` refuses to run outside
a linked worktree; replans that touch a decision id return to the user (see
[Replanning](#replanning)).

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

`pace` (`frugal` | `balanced` | `fast`, default `balanced`) is read by the scheduler and by the
evidence phases when they decide how many readers share a body of evidence.

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
statuses, briefs, excerpts, whether recorded evidence still stands. A workflow script has no filesystem, so disk crosses into it
through a **courier**: an agent that runs one command and pastes its stdout.

- **Bytes that cross a model carry a digest the receiver re-checks.** Lines the workflow mints
  whole travel encoded on one argv slot (or a file path when an argv slot would overflow).
- **One courier per boundary**, running every deterministic step of that boundary in one command.
- **Briefs are assembled by script** from the node, its referenced evidence and the
  [gotchas](#gotchas) its role and locus call for. Shared evidence is resolved once into excerpts and handed inline; an agent whose
  charge can be answered from what it is handed gets no tools.
- **One reader per body of evidence** unless volume or independence (GP1) earns more.
- **Returns are typed and short**; full reports go to files, opened only by a consumer acting on
  them.
- **Runtime text holds instructions and contracts; reasons live in this document.** Definitions
  are sized to the role — a courier's is a few lines.

**Why:** writing through an agent is where corruption lives, and every dispatch is paid in context
× turns by that agent and re-read by whoever dispatched it. Every courier is also a round-trip on
the critical path, so the count of boundaries, not of facts, sets the floor.

### GP5 — Durability by the actor; state is derived, never stored

Whoever performs an action records the observation, in the same execution. No agent records a
verdict; verdicts are re-derived from observations by the same functions on every read. The status
of a node, an execution or an effort is computed from append-only logs and git
on every read; anything that displays a status renders it, and nothing trusts a rendered status.
One monotonic `seq` per effort orders records; it is a counter minted by the ledger script,
never by an agent, and never a clock. Resume names the
single next undone action per node, trusting a stage only where the record and git agree.

**Why:** a record written after the fact leaves a window where work exists and nothing says so; a
status written down outlives what it described; a clock an agent can read is a clock it can invent.

---

## The execution tree

### Nodes

A node is one file of authored facts plus its events in the effort's log.

| field | meaning |
|---|---|
| `id` | stable, path-like (`auth/session/refresh-token`) |
| `intent` | what this node makes true, in the user's or the parent design's words |
| `kind` | `design`, `composite`, `leaf` |
| `level` | design nodes: `context`, `container`, `component`, `leaf-spec` (see [Design](#design)) |
| `decisions[]` | ids of the decisions this node realises (see [Traceability](#traceability)) |
| `acceptance[]` | criteria, each naming its check; `HUMAN:` routes one to the user untouched |
| `ground[]` | paths the node's evidence lives in; decides whether recorded evidence still stands |
| `locus[]` | leaf: every file it may write |
| `reads[]` | leaf: files it builds against and never writes |
| `deps[]` | node ids whose outputs this node consumes |
| `provides[]`, `consumes[]` | named contracts (a name plus path prefixes); the prefixes drive [drift detection](#landing-and-drift) |
| `rigor` | leaf: see [Rigor](#rigor) |
| `role` | leaf: `none`, `red`, `green`, `audit` |
| `dispatch` | model and effort per stage, set by the node's author (see [Model tier](#model-tier)) |

Events: `planned`, `replanned`, `dispatched`, `approved`, `merged`, `escalated`, `parked`,
`landed`. A composite's status is derived from its children's.

### Storage

```
.claude/agentics/
  slots/                          the parallelism pool, shared by every execution (see Scheduling)
  efforts/<effort>/
    nodes.jsonl                   authored node facts, append-only (a revision appends)
    events.jsonl                  node events, append-only
    evidence/                     survey and probe returns, verbatim, anchored to commit + ground
    knowledge/                    gotchas (see Gotchas)
    executions/<stamp>/           one execution of a subtree: state.jsonl, journal.jsonl
    reports/                      executor reports, one file per dispatch
    locks/                        locus and branch locks
```

`lib/ledger.mjs` is the only writer of every `.jsonl` here. It mints `seq` per effort under a lock
file — a script minting a counter, so no agent ever supplies one — and refuses a line that does not
parse, lacks a kind, or fails its caller's digest.

Design documents are source and live in the source tree (`docs/agentics/designs/<effort>/`); a
design node points at its document. Worktrees live under `.claude/worktrees/`.

### Integration branches

Integration is assigned **per composite node, dynamically**. A composite gets its branch
`agentics/<effort>/<node-id>` and worktree the first time one of its children is ready to merge,
cut from its own parent's integration head. Its children branch from it and merge into it. When
its last child has merged and its integration review is done, it merges into its parent's
integration branch like any child. A leaf's branch is `agentics/<effort>/<node-id>` too.

The effort root's integration branch, `agentics/<effort>`, is the effort branch: the one landed
into the user's branch.

- **Concurrent executions** are allowed on any disjoint subtrees of the same effort. Preflight
  refuses only an execution whose root is an ancestor or a descendant of an active one (checkpoint
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
| Is the ground known — finding where the change goes is not part of the work? | evidence is earned for this node |

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

**Stop.** A node that satisfies all seven is not split further. A split that yields a child failing
4 or 5 is forbidden. A node that fails a condition and has no permitted split — for example a
change to a closed set whose every consumer must change with it — is **`unsplittable`**: it widens
its locus to own every consumer, and if that breaks condition 7 it escalates, naming the condition.

**Recovery grain.** An executor commits at every passing step and marks an unfinished series with a
checkpoint commit, so an interruption costs at most the uncommitted step, whatever the leaf's size.

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
every leaf that does not depend on the parked one, then returns a checkpoint naming what it needs.
The answer arrives on a resume, which re-briefs the parked node and any not-yet-started consumer.

**Autonomous replans preserve decisions.** The planner may split, merge or re-derive nodes only
while every decision id stays realised; anything else is user-bound. Replans append `replanned`
events; nothing is rewritten, and merged work stays.

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
  The rigor decides the tests: a `tdd` leaf writes them, a `trivial` or `verify` leaf writes none, and the
  inline mode never adds or drops one on its own. Auxiliary items are proposed as a separate list the user accepts or rejects; a rejected item does
  not exist. A consequence ("skipping this leaves the build red") is stated as information, never
  used to bypass the choice.
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

- **`tdd-pair` and `tdd-triad` are separate leaves** with `deps` (green on red, audit on green), each with
  its own branch, todo, review and resume action. Green is cut from red's branch and receives red's
  committed tests as artifacts, never red's report. No agent authors both a behaviour's tests and
  its code; the declared loci are the separation, checked by the commit-series check.
- **A cycle lands as a unit.** Red is held on approval; its cycle merges together once the last
  member is approved, so the effort branch is never red.
- **Mutations are declarations.** A test-author or auditor declares `{file, find, replace,
  expect_failing}`; leaf-close applies them by script and restores the file. Audit gaps return as
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
  evidence, and runs the outward search (does this already exist?)
  concurrently with the survey when it would build a capability.
- **Decisions are the user's and carry ids.** One question at a time, dependency order first, each
  with a recommendation and its reason. Open questions are graded `blocking`, `parked`, `lookup`,
  `compost`; a level with an open `blocking` question does not hand down.
- **Approaches in parallel when the decision space is open.** Independent drafts from assigned
  stances (GP1: bought for independence); skipped and recorded when the level has one obvious
  shape.
- **The probe is earned** by length or by a contract other nodes consume. One analyst holds every
  axis unless length earns more; a second round is earned only by a resolution that reshaped the
  design.
- **Just in time.** Only the frontier's lower levels are written; a sibling reaching the frontier
  gets its level then, with its ancestors and delivered siblings as settled context.

**Why:** most design errors are errors of intent or of contract, and both are cheapest to catch at
the level that states them; writing lower levels early pays for detail the upper levels will change.

### Traceability

Every decision at every level has an id. When an effort has no design node, its root's decision
list is the request's items as triage stated them. Every child lists the decision ids it realises;
every leaf's criteria trace to them. Before anything is dispatched, a script computes:

- decisions no child realises — a **blocking gap**;
- criteria that trace to no decision — reported, for the user to accept or remove.

The integration review receives the decision list of the subtree it reviews.

**Why:** a plan that silently drops a decision passes every leaf-level gate, because each gate
checks a leaf against its own criteria.

---

## Evidence

### Survey

The survey gathers evidence for one node and never concludes.

1. **Plan.** One analyst decomposes the question into topics, names each topic's subtree and the
   common ground.
2. **Scout.** One scout per topic, the common ground scouted once. Scouts return locations and a
   `stop_reason`, with `no_match` and `not_reached` kept apart, and are continued on exactly what
   remains until exhausted. History and docs channels run alongside when the plan asks, each with
   its own `.catch`.
3. **Resolve.** A script reads the locations, merges overlapping windows and produces excerpts,
   once, under a digest.
4. **Judge.** One analyst **without tools** judges every topic from the excerpts, unless volume or
   `pace` earns more readers.

A recorded survey **stands**, and is reused instead of bought again, when its commit is an ancestor
of HEAD, no commit or uncommitted edit has touched its ground since, and it reported complete
coverage — all computed from git. A node whose shape is settled and whose ground a standing survey
covers buys no survey, and says so.

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
frontmatter `kind` (`pitfall` | `command`), `roles` (who needs it), optional `paths` (locus prefixes
it applies to), `observed_at` (commit) and `source` (node and role). The id is minted by script from
the normalised trigger, so the same trap recorded twice is one file. An executor reports gotchas in
a fenced block of its report file; leaf-close extracts and writes them — no model retypes one.
Brief assembly appends every gotcha whose `roles` include the brief's role and whose `paths` (if
any) overlap its locus. A gotcha an agent observes no longer holds is deleted, not marked.

**Why so narrow:** a memory that stores claims about the code goes stale silently and is then read
as fact; a gotcha is checked the moment it is used, because the trigger either happens or does not.

---

---

## Execution

An execution runs a subtree in the integration worktrees of its composites and in per-leaf
worktrees, and never touches the user's tree.

### Boundaries

Every deterministic step runs at one of five boundaries, each one courier dispatch running one
`lib/` entry point under one digest. Every entry point is **idempotent**: re-running it after an
unobserved outcome converges on the same state, because each step first checks whether its effect
already exists (a merge already in the branch, a line already in the log, a worktree already
attached).

| boundary | fused steps |
|---|---|
| **preflight** | refuse an execution overlapping an active one; drift check against the plan's anchor; free this execution's dead worktrees, locks and slots (clean worktrees only — a dirty one is reported, never forced); create the todos |
| **leaf-open** | acquire a slot and the locus locks; create or attach the leaf's worktree and branch (and its parent's integration branch if absent); assemble its brief; append `dispatched`; move the todo |
| **leaf-close** | commit a shell-less author's files; commit-series check, build, typecheck, suite, discriminator, declared mutations; journal the observation; write reported gotchas; append the state line; move the todo |
| **merge-batch** | under the branch lock, merge every approved child into one integration branch in dependency order; verify the merged head; release locus locks; append the state line; complete the todos |
| **postflight** | report worktrees and branches eligible for cleanup |

Long checks run detached inside the entry point and are polled to completion, so a host's shell
timeout cannot cut a boundary short.

**Retries are sized to what was observed.** A refusal (the writer says it wrote nothing) buys one
fresh courier; a courier that threw or returned nothing is re-run only because the entry point is
idempotent, and a payload that fails its digest buys one refetch on a stronger model before
escalating as a transport failure.

### Merging

Merge follows the merge-result contract carried over from `docs/DESIGN.md`: success is computed
from `stop_reason`, `merged_sha` and `conflicts` together, and a conflict stops the batch as a
planner defect surfaced to the user. A merge-batch whose merged tree equals an already verified
leaf tree skips re-verification.

**A failing merged head** is reset to the last green head, and the script bisects the batch. A leaf
that fails alone on the new head gets a fix round; leaves that each pass alone and fail together
escalate as a **combination failure** naming all of them — it is a design question, not a leaf's.

### Scheduling

A ready set per execution, recomputed at every boundary. A leaf is ready when its dependencies are
merged, its locus locks are free, and no open escalation sits on its dependency chain. A ready leaf
dispatches as soon as it holds a slot. A merge-batch runs whenever approved children wait on an
integration branch whose lock is free. Cycles are held and land as a unit.

**Parallelism lives at the leaves and is controlled from outside the execution.** A slot is the
right to run one leaf. The pool is `.claude/agentics/slots/`: its size comes from one
configuration file the user edits (`max_parallel`), read at every leaf-open, so a change takes
effect on the next dispatch in every running execution at once. Slots are lock files naming their holder leaf, acquired at
leaf-open. A slot is free when its holder's derived status is no longer active (approved, held,
merged or escalated), so release needs no write of its own; a slot whose holder belongs to an
execution that is no longer running is freed by that execution's next preflight, or by the user.

When the session set a token target, the scheduler does not start a leaf that the remaining budget
cannot cover at the effort's measured cost per leaf; it stops at the next merge-batch instead.
`pause` is a launch flag with the same effect after the next merge-batch.

**Why a lock-file pool rather than a scheduling agent:** the pool is arithmetic, costs no tokens,
is shared by every execution and every session on the machine, and survives any of them dying. A
persistent agent receiving messages could do the same job, but it would put a model on the
scheduling path (GP4), re-read its growing conversation on every message, lose its state with its
session, and need a courier turn per message from a workflow. It remains an open question — see
[Open questions](#open-questions).

### Coupled work

A leaf whose locus includes a designated shared file (lockfiles, configuration roots, barrel files)
is **coupled**. It runs on its own branch cut from its parent's integration head, under the same rigor,
verification and review, and merges through a merge-batch. Coupled leaves run one at a time;
everything else keeps running.

### Executors and review

- **Executors** are standalone agents, one per leaf per round: implementer, test-author, auditor.
  Each fetches its brief by reference and confirms its digest, writes a focused commit series
  inside its locus (no amends, no rebases), writes its report to a file, and returns a short typed
  status: `done`, `done_with_concerns`, `blocked`, `needs_context`, or a
  [replanning](#replanning) return.
- **Review** is a fresh reviewer each round, given the brief, the span, the executor's concerns and
  the prior round's open findings. The review-loop exit, the code severity ladder and the
  fix-verdict vocabulary are carried over verbatim from `docs/DESIGN.md`: the open set includes
  prior blockers ruled `not_fixed` or `regressed` and not re-reported; a major blocks only on a
  contract leaf and only with a failure scenario.
- **Integration review** runs per composite node, over the merged diff of its children, against its
  decision list and the criteria of every child reviewed there. A diff too large for one reader
  (condition 7's computation) is reviewed per child composite. When planned children did not land,
  every finding carries that caveat. Its criticals go to the user.
- **Establishing commands** is judgment: when no build or test command is established, leaf-close
  returns `command_unknown`, and an investigator establishes them once for the execution.

### Model tier

The node's author sets `dispatch` per stage, because it holds the context. Defaults: **producers**
(implementer, test-author) run the cheaper model, with effort scaled to the leaf's difficulty;
**gates** (reviewer, auditor, planner, analyst) run the stronger model at moderate effort. A leaf
whose output is a yardstick — `red`, `audit`, or one that `provides` a contract — runs its producer
on the stronger model too. A fix round that failed to clear its blockers raises the producer one
step, and that step may exceed the user's ceiling. The user's intelligence dial is otherwise a
ceiling, derived from the session's model unless the user moves it. Couriers run the cheapest model.

### Landing and drift

An execution delivers into its root's parent integration branch, and ultimately the effort branch, without
asking; the user's tree is not involved.
After each merge-batch, the landed diff is intersected with the `consumes` path prefixes of every
pending designed node; a hit goes to the user as facts, and they rule unaffected, re-design or
re-slice. Undesigned nodes are reported as unexamined.

**Landing is the one ask.** When the effort is complete, or the user says to land what exists, the
session reports how the user's branch drifted since the effort branch was cut, asks, and merges the
effort branch into the user's branch; the event is `landed`. The session presents gaps first,
surfaces every `HUMAN:` criterion verbatim, and never lands over an open escalation. Cleanup of
merged branches and worktrees follows on a go.

---

## Resume and checkpoints

Resume computes, on disk, one next action per leaf — `none`, `merge`, `review`, `verify`,
`continue-series`, `code` — adopting a stage only where the record and git agree. A checkpoint
commit (the executor's mark on an unfinished series) means continue, never measure. A clean
execution (empty ledger, no leaf branches) opens for the cost of one branch listing. Committed work
is salvaged by right and reported as salvaged; uncommitted work is reported and adopted by nobody.
Escalations carry forward until the user names them in `retry_escalated`. A resume adopts its
envelope (base, dial, settled evidence) from disk.

A checkpoint dispatches nothing new and says how to proceed:

| checkpoint | meaning | to proceed |
|---|---|---|
| `existing_execution` | the effort already has an active or planned execution | resume it; or `confirmed_duplicate` |
| `blocking_gaps` | untraced decisions, or evidence the node depends on was not reached | `confirmed_gaps` |
| `parked` | the caller launched with `plan_only`, or nodes await a user-bound return | resume with the answers |
| `stale` | the user's tree moved under the plan; per leaf, `writes` and `reads` that moved | `confirmed_stale` |

---

## Progress

The user follows work through the todo list of the session that launched the execution, as in
`vf-superpowers`' subagent-driven development. Agents dispatched by a workflow share that session's
list and move it live while the workflow runs (verified on the host).

- **One todo per leaf**, subject `<node-id> — <title>`; composites get one too, completed by the
  merge-batch that merges them.
- **The stage is the `activeForm`**, set to what happens next: `implementing` or `writing tests`
  (leaf-open); `in review`, `awaiting merge` or `fix round N` (leaf-close, from the measurement);
  `waiting on user` (a parked node); `completed` on merge; `pending` with the reason when escalated.
- **The movers are the boundary couriers**, which already run at every stage change, so progress
  adds task-tool calls to existing dispatches and no dispatch of its own. The first boundary that
  sees a leaf creates its todo and returns the task id; later boundaries carry it.
- **`--no-progress`** drops those calls. The session then derives the list from the event logs
  (`lib/status.mjs`) on launch, on wake and on return, and the workflow's log still narrates every
  boundary.
- **The list is a view.** Nothing reads it back as state, it is never hand-edited, and a status
  header (`ONGOING`, `DONE`, `NEEDS_INPUT`) is rendered from derived status for display only.

**Why a flag:** each todo move is a turn on a courier, which is cheap but not free; a user who
watches the log or checks in only at the end should not pay for it.

---

## Agents

| role | does | cannot | tools |
|---|---|---|---|
| scout, historian, doc-researcher | find, to exhaustion | conclude | search tools; historian read-only git |
| analyst | judge what it is handed | search | none by default |
| planner | triage, decompose, set rigor and dispatch, write nodes | implement | read, search, write node files |
| implementer | code one leaf as a focused series, or its fix round | leave its locus, amend, merge, certify | read, edit, shell |
| test-author | write a leaf's tests and declare mutations | implement, execute anything | read, edit |
| auditor | declare mutations against an implementation | edit anything, execute anything | read |
| reviewer | attack a span | approve, edit | read, read-only git |
| investigator | establish build and test commands when none are known, recorded as a `command` gotcha | judge quality, fix anything | read, shell |
| courier | run one command, paste stdout; move todos | anything else | shell, task tools |

Capability is the tool allowlist and nothing else — no hooks. The test-author and auditor carry no
shell, so the authors of every yardstick are structurally unable to run what they wrote; their
files are committed and their mutations applied by leaf-close. Agents with a shell are restrained
by their definitions and audited post hoc (the locus by the commit-series check): the criterion is
zero breaches surviving to review.

---

## Skills

| skill | entry for |
|---|---|
| `task` | the inline mode |
| `design` | a design node at any level |
| `develop` | executing any subtree: triage, launch, result walk, landing |
| `probe` | attacking a written artefact |
| `investigate` | answering a question from evidence |
| `find-existing-solutions` | the outward search |
| `status` | listing efforts, nodes and executions with derived status; handing one to `develop` |

A skill file holds the router and the steps; step detail lives in reference files loaded when the
step is reached. A contract several files must state identically is a verbatim block, placed only
in the files whose reader acts on it.

---

## Data contracts

Each contract names its owner (the code that defines the shape) and every place it is restated; a
change to a field list edits every place in the same commit series. New in this design: the node
record, the node event, the gotcha file, the slot and lock files, the boundary payloads (`preflight`, `leaf-open`, `leaf-close`,
`merge-batch`, `postflight`) and the replanning returns. **Carried over verbatim** from
`docs/DESIGN.md`: the digest convention, the state and journal lines, `seq`, the verify payload and
its typed outcomes (`command_unknown`, `discriminator_undecidable`, `verify_oscillating`,
`test_unrunnable`, `suite_failures_unnamed`, `tree_not_restored`; absent never inferred; typecheck
never derived from the suite), the merge result, the resume verdict, the
coverage block (without `from_kb`), the review-loop exit and both severity ladders.

---

## Self-checks

- **Lint** checks form: no counter-based termination, a coverage block on every exit, no verdict
  fields in agent schemas, no schema bounds, no imports in workflows, namespaced agent types, valid
  workflow `meta`, agent frontmatter, gate clauses in gated skills, a stated task-tool fallback.
- **The scenario harness** runs the real workflows with scripted agents; every claim about dispatch
  count is a harness assertion, not prose.
- **Pins:** verbatim blocks match across files; every agent's tool allowlist is pinned; every
  pointer into the design document resolves.
- **Liveness** (GP2): for every agent, record kind, schema field, lint rule and library export, a
  check finds a producer and a consumer in the source; defined-never-dispatched,
  written-never-read and read-never-written fail the suite.
- **Budgets:** each skill and agent definition has a size budget in one configuration file; lint
  fails a file over it.
- **Cost report:** every execution records its dispatches with model, effort and, where the host
  reports it, tokens, so the next triage quotes measured figures.

---

## Open questions

1. **A persistent agent for parallelism.** The design controls parallelism with a lock-file slot
   pool (see [Scheduling](#scheduling)). The alternative — one long-lived agent that executions
   message to ask for slots — is not adopted. Before it could be, a check would have to show: that
   an agent dispatched inside a workflow can message a persistent agent and get an answer on this
   host; what one exchange costs as that agent's conversation grows; and that the agent's state
   survives its session ending. The pool needs none of these.
