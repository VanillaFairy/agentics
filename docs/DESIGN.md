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
| `skills/` | The six commands a user invokes and one hidden service step (see [Skills](#skills)). |
| `service-workflows/` | Five service workflows, launched by path, never in the menu, holding the orchestration. |
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
| `.agentics/<effort>/` | One effort: a `DESIGN.md` per folder, and its `.state/` — nodes, events, ledger, evidence, gotchas, executions, reports and locks ([Storage](#storage)) |
| `.agentics/.state/` | What every effort shares: the slot pool and the context files |
| `.agentics/config.json` | The project's settings, edited by the user (`max_parallel`) |
| `.claude/worktrees/` | Integration and leaf worktrees |

Everything under `.agentics/` and `.claude/worktrees/` is local to the machine. `.agentics/`
sits in the main checkout, where a writer in a linked worktree also lands, and it ignores itself:
every directory made under it goes through `lib/store.mjs mkdirState`, which writes a
`.gitignore` of `*` at its root, whatever the target repository's own ignore rules say. Specs are
the user's documents but not the project's docs: carrying what an effort decided into the docs is
a plan entry of its own.

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
predicates in code (`lib/verdict.mjs`, the review-loop exit in `execute-approved-plan-in-worktrees`).

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
`lib/verify.mjs` refuses to run outside a linked worktree; `decisionProblems` in `lib/tree.mjs`
admits a batch that states or changes a decision only from compile, as the approved copy on the
ledger states it (see [Specs, approval and compile](#specs-approval-and-compile)), and refuses a
replan that changes a contract or drops a realised decision (see [Replanning](#replanning)).

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
`design`, `composite`, `group` or `leaf` node, with the same schema, event log and derived status
at every depth. Any node can be the root of an execution.

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
  whole travel encoded on one argv slot, or as a file the courier writes (see
  [the ledger transport](#the-ledger)).
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
- **spec**: a folder's `DESIGN.md`, written for the user, with the sections Intent, Decisions,
  Design, Plan, Open questions and Evidence. It never holds status.
- **`.state/`**: machine state, written only by scripts: an effort's `.state/` (nodes, events,
  ledger, executions) and the project-wide `.agentics/.state/` (slots, context files, evidence
  items).
- **segment rule**: names of efforts, folders and entries match `^[a-z0-9][a-z0-9-]*$`, at most 120
  characters, with no `--`.
- **plan entry**: one named unit of work in a spec's Plan: a `sub-effort` (its own folder and spec),
  a `task` (built directly), `deferred` (not now) or `dropped` (abandoned; the decisions it
  realises are accepted as not realised). An entry lists the decision ids it `realises` and what it
  waits for in `after`: a name in the same plan, or a path from the root folder starting with `/`.
- **group**: a `### <name> — group` heading in a Plan that gathers the tasks under it by concern.
  It has no spec, branch or review: its tasks merge into its folder, and its `after` binds them all.
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
  the only writer of nodes. A folder becomes a `composite` node, a group a `group` node, a
  sub-effort with no approved or prepared spec a `design` node (the frontier), and a task a `leaf`.
- **task promotion**: a task that must be decomposed gets its own spec in
  `<folder>/<task>/DESIGN.md`, or `<folder>/<group>/<task>/DESIGN.md` for a task in a group.
  Compile then builds it as a composite that realises the task's decisions and carries its
  criteria.
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
| `label` | the node's visible name, from its entry's `label`: the work done there, not its parents (the id carries those); absent when none was written, and the viewer then shows the last id segment |
| `title` | imperative; the todo subject |
| `intent` | what this node makes true, in the user's or the parent design's words |
| `kind` | `design` (a sub-effort whose spec is not approved or prepared: the frontier), `composite` (a folder whose spec is), `group` (tasks of one folder gathered by concern), `leaf` (a task) |
| `author` | design and composite nodes: who writes the folder's spec, `you` (the default) or `planner` |
| `defines[]` | `{id, text}` — the decisions this node states: a composite's are its spec's Decisions rows |
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
| `retired` | a replan removed it |

Events: `planned`, `replanned`, `dispatched`, `approved`, `merged`, `escalated`, `parked`,
`landed`. A leaf's status is, first match: `merged`; `escalated` or `parked` when newer than its
last replan and last revision (a replan or the user's answer clears it); `approved` when newer than
its last dispatch (a held cycle member is approved and not merged); `active` while a dispatch has
nothing terminal after it; `planned`. A composite is `merged` on its own event, the root `landed`
on its, `escalated` or `parked` on its own open event (cleared like a leaf's), and otherwise
summarizes its children (`integrated` once all have merged). A group summarizes its children the
same way, except that it is `merged` once all of them are: it has no branch of its own to merge.

A group sits in a composite and holds only leaves and promoted tasks. It has no spec, author,
decisions, contracts, branch or integration review. Its `deps` bind every task in it, and a
dependency on a group waits for all of them; cycle detection, atomicity's ordering and
traceability read through a group the same way. A group never takes the id of a node that
dispatched or merged work stood under. Its tasks belong to the folder above it: `ownerOf` in
`lib/tree.mjs` passes over groups, and every question of which spec lists a node, which branch it
is cut from and merges into, and which integration review reads it goes to that owner. `unitsOf`
lists what merges into a composite, with each group replaced by its children.

Nodes are written through `lib/tree.mjs` `addNodes`, by compile alone, from approved and prepared
specs ([Specs, approval and compile](#specs-approval-and-compile)); develop's planner writes specs,
never nodes. It validates a batch against the tree on disk and appends it all or nothing: shape
problems, tree problems (a missing parent, a dependency cycle, a decision nobody defined, a green
without its red) and the decision guard refuse the batch; the computable atomicity conditions and
traceability gaps come back as warnings. It refuses; it never repairs. `lib/tree.mjs`'s CLI has one
command, `show`: nothing outside compile calls `addNodes`, and there is no CLI verb to.

### Storage

```
.agentics/                        in the main checkout
  .gitignore                      `*`, written by mkdirState
  config.json                     {max_parallel}, edited by the user
  .state/
    seq, .lock                   the project-wide counter and mutex
    slots/                        the parallelism pool, shared by every execution (see Scheduling)
    context/                      context files for survey and probe readers, pruned after a week
    evidence/                     the evidence item store ([Evidence item store](#evidence-item-store)):
                                  items.jsonl, returns/<stamp>[-<n>]-<kind>.json, snapshots/<hash>.txt
  <effort>/
    DESIGN.md                     the root folder's spec
    <sub-effort>/DESIGN.md        one folder per sub-effort, nested as the plan nests them
    .legacy/                      design documents the migration copied
    .state/
      effort.json                 {about, roots, opened_at}, written once
      nodes.jsonl                 node revisions, append-only
      events.jsonl                node events, append-only
      ledger.jsonl                approvals, preparations, compiles, dispositions
      seq, .lock                  the counter and the effort mutex
      branch.json                 where the effort branch was cut, written once
      cites.jsonl                 each folder's evidence citations ([Cites](#cites))
      knowledge/                  gotchas (see Gotchas)
      executions/<stamp>/         one execution of a subtree: execution.json, state.jsonl,
                                  journal.jsonl, briefs/, jobs/, closes/, merges/, fixes/, said/
      reports/                    executor reports, one file per dispatch
      locks/                      locus and branch locks
```

`lib/store.mjs` computes every name and path; nothing else types one. Every path starts from the
main checkout (`mainCheckout`: git's common directory, or a submodule's `core.worktree`), so a
leaf recording from a linked worktree writes where the next session reads. A directory that is not
the top of a working tree is its own root. Names of efforts, folders and entries follow the
segment rule: `^[a-z0-9][a-z0-9-]*$`, at most 120 characters, no `--`; so no file the store writes
can pass for one. Worktrees live under `.claude/worktrees/`.

### Specs, approval and compile

A folder's `DESIGN.md` is the user's document: a title and the sections Intent, Decisions, Design,
Plan, Open questions and Evidence, all prose except three parsed forms — the Decisions rows, the
graded open questions and the plan entries ([Spec format](#spec-format)). No status is ever
written into one. `lib/spec.mjs` parses a spec, checks it in its place in the effort (decision ids
and their folder prefix, what each entry realises and waits for, which keys fit which kind, a
planner-written spec stating no decision, every consumed contract provided somewhere, every
decision it defines realised by one of its own entries — a sub-effort or a task lists it, or a
dropped entry gives it up), and refuses with the file and the line. Approval refuses a spec with
any such problem, so compile never meets an unrealised decision.

Approval is a ledger line holding the spec's hash: `fnv1a` over its text, with `\r\n` read as
`\n` and a byte-order mark dropped, so a checkout's line endings never read as an edit.
`lib/approval.mjs` records it and derives the folder's state on every read: `approved` or
`prepared` while the spec's hash equals the latest such line's, `edited` once it differs, `none`
before. `approved` is recorded only after the user approves in so many words; `prepared` only for
a planner-written spec, naming the review return it passed. The review gate is derived the same
way (`approvalGate`): ratifiable once the latest review of the spec's current text examined every
axis and each ambiguity it returned has a disposition, from any round. An edit leaves no review of
the new text, so the gate stays shut until one reads it.

`lib/compile.mjs` turns approved and prepared specs into nodes. A folder becomes a composite; a
group, a group node whose tasks' ids sit under it (`<folder>/<group>/<task>`); a sub-effort with
no approved or prepared spec, a design node; a task, a leaf; and a task whose own
folder holds such a spec (task promotion), a composite that carries the task's criteria and must
realise every decision the task did. It appends only what changed, through `addNodes` with
`by: 'compile'`, and records the hash it built from, so a second run appends nothing. A spec
edited since approval is left out, and develop keeps the last approved graph. When a spec is
approved again with other text, compile parks every consumer of a contract it provides
(`contract_changed`), gives every node realising a changed decision a `decision_changed`
revision, parks the folder when work under it was dispatched (`spec_changed`), and retires the
entries it no longer lists — refusing, by name, one with dispatched or merged work. A parked node
whose spec was approved or prepared after the park gets a new revision (`answered`), which clears
the park. Nothing is written when anything is refused.

**Why:** the user reads and approves a document, never JSON. The graph is derived from what they
approved, so the two cannot disagree about a decision.

### The ledger

`lib/ledger.mjs` is the only writer of every `.jsonl` under an effort. It mints `seq` per effort
under the effort's lock — a script minting a counter, so no agent ever supplies one, and a
`seq` that arrives on an entry is overwritten — and refuses a batch that does not parse, has an
entry without a `kind`, or fails its caller's digest. Appends are all or nothing and never
read-then-write. Readers are tolerant: a torn line is counted, never thrown on.

Lines the workflow mints whole travel base64 on one argv slot with a digest, so there is no path
to escape and no apostrophe to close. A line only the observing agent can fill in (a finished
series) goes by heredoc on stdin and carries no digest; the writer still refuses what does not
parse. A digest makes corruption detectable; the encoding makes it unlikely.

Evidence tokens — a survey's, probe's or solutions sweep's items, a re-judge's verdicts — are the
exception: they are long, and base64 is both longer and the text a courier copies worst. They
travel as JSON by file (`viaJsonFile` in each of those workflows): the courier writes one line of
JSON to `.agentics/.state/token-<digest>.json` with single-quoted `printf '%s' '<chunk>'` calls of
at most `COMMAND_BUDGET` characters (under cmd.exe's 8191-character line), and the lib reads it
with `--json-file` under the token's digest and removes it. Single quotes leave `$` and backticks
alone, but the layer between a model's Bash call and the shell still decodes backslash escapes, so
the text carries no backslash and no apostrophe: `~` is written `~t`, `\` is written `~b` and `'`
is written `~q` (`lib/store.mjs jsonFileText`). Each write is one line, because the harness
indents every line of a computed prompt and a courier copies that indent: before a command it is
harmless, inside a multi-line body such as a heredoc it lands in the token. A courier's cost is its
dispatch, not its bytes, so a long token buys more Bash calls on one courier, never more couriers.
Copying is where such a carry fails, so its one retry — after a courier that could not finish, or
a token the lib refused as unreadable or not matching its digest — goes to the stronger model.

A location list is the exception: it is only paths and line numbers, so it travels as plain text
(`path:line:line,path:line`) with a digest over the exact string, because a courier copies paths
reliably and base64 badly. The workflow sends no path outside `[A-Za-z0-9_./@+:-]`, so the list
needs no quoting; such a location goes to its reader to open.

### Context files

What a courier would otherwise carry back — excerpts for a survey judge, a probe's guidance, its
located ground and the document's own citations — `lib/citations.mjs` writes to
`.agentics/.state/context/<digest>-<n>.md` instead. It prints only the files' paths under a
digest, and the reader Reads them. No model retypes an excerpt. Each part is small enough for one
Read (40 KB, 800 lines). Files are named by the digest of their text, so a retried courier
rewrites the same files, and files a week old are pruned on each write.

### Integration branches

Integration is assigned **per composite node, dynamically**. A composite gets its branch and
worktree the first time something needs them, cut from its own parent's integration head, and is
brought up to date with that head whenever the parent has moved — which is how a dependency merged
elsewhere in the tree reaches the leaf that consumes it. Its children branch from it and merge into
it. When its last child has merged, its head passes the [suite gate](#the-suite-gate) and its
integration review is done, it merges into its parent's integration branch like any child. A group has no branch: its tasks are cut from and merge into
their folder's, and a composite promoted inside a group is cut from that folder.

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

A request is triaged once, by `develop`, before its root spec is written. Two questions fix what
its plan holds; one more fixes the **mode**.

| question | if **no** |
|---|---|
| Is the intent settled — no approach left to discover? | it goes to `design` |
| Does the item satisfy the atomicity rule? | its entry is a `sub-effort` with `author: planner`: the planner writes that spec |
| Is the ground known — finding where the change goes is not part of the work? | the same, and a survey runs before the planner writes (`ground_known: false`) |

Mode (for an effort root, or any folder about to execute): **inline** or **dispatched** — see
[Execution modes](#execution-modes). At the effort root, triage is a recommendation to the user,
and "run it anyway" ends the discussion; inside the tree the planner applies the same questions
to the entries of the specs it writes.

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
   build, a typecheck, a command) that runs on this leaf's branch alone and decides it. The planner
   picks the tests: those the change clearly affects, whatever their size; none it clearly cannot
   reach; and from the gray area between, tests it might reach, fast ones only, never big ones. Big
   tests are those outside the repository's fast suite (`suite_fast`); a repository that does not
   split its tests has none. The whole fast suite only when the change can reach every test (the
   test runner's config, shared test setup, a module nearly everything imports): these checks are
   all the testing a leaf gets before it merges ([Verification](#verification)).
5. **Green when done.** After it merges, the tree builds and the suites pass — except the declared
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
| `decompose` | the task violates atomicity | the planner promotes it: a spec of its own at `<folder>/<task>/DESIGN.md` that realises every decision the task realised; the spec holding the task's entry is not touched |
| `unsplittable` | no permitted split exists | the planner promotes it with a widened locus, or it escalates |
| `premise_mismatch` | the brief's premise does not match the code | the planner promotes it; a premise from a spec the user wrote goes to the user |
| `needs_decision` | condition 6 failed | the user |
| `contract_changed` | a `provides` contract cannot hold as written | the user — a contract is a decision |

A verify task's finding replans its folder: the planner rewrites the folder's spec when the
planner wrote it, and the folder parks `needs_respec` for the user when the user did. Every spec
the planner writes passes the [autonomous review](#autonomous-review) before compile builds from
it.

**A user-bound return parks the node.** The workflow cannot talk to the user, so it keeps running
every task that does not depend on the parked one, then returns naming what it needs. **The answer
is a re-spec:** the session edits the spec that owns the fault (a decision only ever goes into a
spec the user wrote), the user re-approves it, compile writes the revision that clears the park
(its result's `answered`), and develop relaunches with the same execution stamp. A park no spec
change answers (a `contract_drift` the user rules unaffected) is cleared by the relaunch's
`retry_escalated`.

**Autonomous replans preserve decisions.** The planner may split, merge or re-derive nodes only
while every decision id stays realised; anything else is user-bound. `lib/tree.mjs` `addNodes`
enforces it for every writer: a batch may state or change a `defines` entry only from compile, as
the approved copy on the ledger states it; a changed contract is admitted only from compile, on a
node whose entry sits in a spec the user approved; and a decision a leaf or a design node realised
before must be realised by one after, unless a `dropped` entry of a spec the user approved gave it
up. The planner returns `needs_decision` or `contract_changed` instead. Replans append
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
- **Tripwire.** Raise it — recommending the dispatched mode or design — when the work needs
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
| `trivial` | writes a change a test would only restate: literal values and user-visible text (a window title, a label, a message), config values, docs, assets, renames behind an unchanged interface, dependency versions, wiring of existing parts | one implementer leaf | the named check, when the leaf needs one to show it works (build, typecheck, the tests the change can reach, running it, a `HUMAN:` look); a test asserting the changed value is updated in the same leaf |
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

An effort is a folder hierarchy under `.agentics/<effort>/`, and each folder holds one spec,
`DESIGN.md`: the user's document, with fixed headings (Intent, Decisions, Design, Plan, Open
questions, Evidence) and three parsed forms (Decisions rows, graded open-question bullets, plan
entries). A spec never holds status. The `design` skill runs one loop for one folder at a time,
at any depth, and each stage writes what it settles into the spec at once.

| stage | what happens | gate |
|---|---|---|
| Analyze | write back the understanding; survey this layer's question, and search for existing solutions when it would build a capability | the user confirms or corrects the understanding |
| Grill | one question at a time, recommendation first; each answer is a Decisions row at once; a cheap choice nothing consumes is defaulted and ruled with the rest at Review; approach drafts when the decision space is open, each kept as a raw return as it arrives | no `blocking` question is open |
| Draft | Design and Plan at this layer's level of detail, shown section by section | `check-plan-block` passes; no decision is unrealised |
| Review | challenge-idea when earned (by length, or a contract other entries consume); every round recorded with its ambiguities; its findings settled with the user, incorporated or discarded, each a recorded disposition; then the user reads the spec | `lib/approval.mjs gate` ratifiable, or the review not earned; and the user approves in so many words |
| Approve | `lib/approval.mjs approve`, then `lib/compile.mjs` | — |
| Move on | `lib/next.mjs` offers: design a sub-effort, develop, or stop | the user picks |

- **Which folder.** `/agentics:design <words>` matches the words against every folder's name and
  title (`lib/next.mjs folders`). One match resumes that folder at its earliest unfinished stage,
  derived from its spec (`lib/spec.mjs check`) and the ledger (`lib/approval.mjs state`); several
  are asked about; none proposes a new effort. No id, slug or flag. A sub-effort's folder is
  created as a skeleton spec by `lib/effort.mjs folder`, and renamed among its siblings by
  `lib/effort.mjs rename`, which rewrites every id and path naming it and carries each approval by
  a new ledger line for the renamed text; it is refused once work under the folder was dispatched.
- **Scale check.** Before the first question the session says whether the work looks small and
  settled enough for `task`. The user can override; complexity found later never downgrades the
  path.
- **Level of detail.** A layer states only what the layer below needs: a high layer talks in parts
  and how they interact, a low one in interfaces and data shapes. Depth comes from folders.
- **Decisions are the user's and carry ids**: `D<n>` at the root, `<folder id with dots>.D<n>`
  below. Open questions are graded `blocking`, `parked (reopens at <x>)`, `lookup`, `compost`, and
  a spec with an open `blocking` question does not hand off. **The ancestor rule:** an answer that
  contradicts an ancestor's decision becomes a `blocking` question citing it, and the fix happens
  in the ancestor's spec.
- **Just in time.** A sub-effort's spec is written when it is next. `author: you` brings it back
  through this loop; `author: planner` lets develop's planner write it, under the
  [autonomous review](#autonomous-review) instead of the user's approval.
- **Approval is a hash.** A spec is *approved* when its current hash equals the one on its latest
  `approved` ledger line, and *prepared* likewise for a planner-written spec. An edit makes it
  *edited since approval*: it goes back to Review, and compile leaves it out until it is approved
  again.
- **The review gate is computed.** `lib/approval.mjs gate` (`approvalGate`) reads the latest
  `reviewed` ledger line at the spec's current hash and the folder's dispositions: ratifiable when
  that review examined every axis and each ambiguity it returned, carried ones included, has a
  disposition from any round. An edit leaves no review of the new text, so the gate shuts until
  one reads it. The design session and develop's autonomous review read the same gate.

**Why:** most design errors are errors of intent or of contract, and both are cheapest to catch in
the layer that states them; writing lower layers early pays for detail the upper layers will
change. The spec is the session's memory, so a design outlives the session that wrote it.

### Traceability

Every decision in every spec has an id, and every plan entry lists in `realises` the ids it makes
true. `check-plan-block` refuses a `realises` id that neither the spec nor an ancestor defines,
and a decision the spec defines that none of its own entries realises: a `sub-effort` or a `task`
realises what it lists (a sub-effort with no spec yet is the frontier), a `dropped` entry's
decisions count as not realised, accepted, and a `deferred` entry realises nothing. Approval
refuses such a spec, so compile never meets one. A settled request's root spec takes
its Decisions from the request's items, written by develop and approved by the user. Before
anything is dispatched, `lib/traceability.mjs` computes over the compiled tree:

- decisions no child realises — a **blocking gap** (a `design` node with no spec yet is frontier,
  not a gap);
- criteria that trace to no decision — reported, for the user to accept or remove.

The integration review receives the decision list of the subtree it reviews, and the folder's spec
as its yardstick.

**Why:** a plan that silently drops a decision passes every leaf-level gate, because each gate
checks a leaf against its own criteria.

### Probe

`attack-document-with-independent-reviewers` attacks a written artefact — a design, a proposal, a spec — before anyone builds
from it. The probers are not the author: each receives the document and the repository's excerpts
and nothing from the author. Findings sit on the design ladder (**ambiguity** blocks ratification;
**gap** is designed away or accepted out loud; **note** is advisory), and `ratifiable` is computed:
false while any ambiguity is open, and false when any axis went unexamined. When a person drives it
there is no fix loop: the probe reports and a human rules. The one loop is the
[autonomous review](#autonomous-review) of a planner-written spec. The ladder's and the disposition's wording are the verbatim
blocks `design-severity-ladder` and `probe-disposition` in the `design` and `challenge-idea` skills.

Findings are evidence items too. The probe first snapshots the artefact (`evidence.mjs
review-scope`), and each new finding is recorded as a `behaviour` item anchored to its lines in
that snapshot. Given `since` — the snapshot the last review judged — the probe attacks only the
lines changed since, and carries forward every earlier finding whose lines no hunk touched: the
same anchor check as all other evidence, with no mechanism of its own. An artefact unchanged since
`since` buys no analyst. The gate is unchanged: a carried ambiguity is an open ambiguity.

Every round records a raw `probe` return, a clean one included: a round with no new finding
records an empty return (`items: []`), so the result's `review` always names the return the round
recorded, and a `prepared` ledger line names a real review. `review` is empty only when the scope
failed (nothing is recorded without a snapshot) or the store took no batch; develop then names the
preparation by the result's `snapshot`, else the spec hash. The result's `snapshot` is the one to
pass back as `since`, and it is empty when the scope failed or any new finding went unrecorded: an
unrecorded finding is in no pool, so a round narrowed past it would never attack its lines again,
and an empty `since` buys a full probe instead. The scope and the recorder run with `--root` set to
the probe's first root, so a probe in a linked worktree reads and anchors the worktree's text.

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

### Autonomous review

A spec develop's planner writes (an `author: planner` sub-effort, a promoted task, or its own
folder replanned) goes ahead without the user's approval, but only once an adversarial review
passes. It runs inside `execute-approved-plan-in-worktrees`, one folder at a time:

1. **Check.** The `spec-check` boundary parses the spec with its ancestors' decisions in view. A
   Decisions row parks the folder `needs_decision`, because only the user states decisions; any
   other problem escalates `spec_refused`.
2. **Attack.** A nested `attack-document-with-independent-reviewers` reviews the spec. After the first round, `since` (the
   previous return's snapshot) narrows the review to the spans changed since. `spec-reviewed`
   records every round as a `reviewed` ledger line with the settlement ids of its ambiguities; an
   incomplete one escalates `review_incomplete`.
3. **Settle.** The planner gives every new finding a disposition: incorporated (the spec
   changed) or discarded. An `ambiguity` or a `gap` can only be incorporated; a discard of one is
   refused and sent back once, and refused again it escalates `review_not_converging`. A finding
   whose fix would state a decision parks the folder `needs_decision`. `spec-settle` records each
   disposition, `by: planner`, under the finding's settlement id (its evidence-item id, or the
   reviewed hash and its `P<n>` when it has none). A finding the probe carries
   from an earlier round (its lines untouched since) stays settled and is not asked about again.
4. **Converge.** A new finding with the same axis, section and claim as one the previous round
   incorporated escalates `review_not_converging`: a computed exit, never a round counter (IL1).
5. **Prepare.** The gate is the `spec-gate` boundary, `approvalGate` on the ledger, the one the
   design session reads: the latest review of the spec as it stands is complete and every
   ambiguity it returned has a disposition. An incorporation edited the spec, so it buys a
   narrowed re-review; a gate still shut on a round that edited nothing escalates
   `review_not_converging`. Then `spec-prepare` records the `prepared` ledger line naming the raw
   return the passing review recorded (an empty one when it found nothing new; its snapshot, else
   the spec hash, only when the probe's scope or record failed), and compiles the folder. A
   compile refusal escalates `compile_refused`.

A park or an escalation stops only that folder; develop keeps running whatever does not depend on
it. A `spec_changed` park on a folder the planner wrote goes back to the planner, which re-derives
it through these same steps; its preparation clears the park its own compile raises. The same
park on a folder the user wrote waits for the user.

**Why:** the parts the user lets go autonomously still get a reader that did not write them
(IL3), and the planner may shape a plan but never a decision (IL4).

---

## Evidence

Evidence is a project-wide pool of small items. Each item makes one claim and carries the anchors
it rests on, and each item's drift is detected on its own, so an edit re-buys only the claims it
broke. The pool is `.agentics/.state/evidence/`, because a fact about the code belongs to no
single effort; `lib/evidence.mjs` owns it.

### Items and anchors

An item's **kind** decides the anchor it must carry, and `checkItem` refuses an item without it:

| kind | claims | needs |
|---|---|---|
| `behaviour` | what some text does or says | a span: a path, a line range, and where it was read |
| `absence` | that something doesn't exist | a query whose re-run finds nothing |
| `enumeration` | the full list of something | a query and its result set |
| `relation` | how two things connect | spans and a query |
| `external` | a fact from outside the project | a source: URL or package, version, retrieval date |
| `derived` | a conclusion from other items | `rests_on`: the ids it is built on |

A judge supplies the claim and what to anchor it to. The recorder (`recordItems`) makes the
observations a judge can't: a span's `at` is HEAD when the file is unchanged against it, and
otherwise a snapshot of the text it was read from; a query's result is `git grep` re-run; a
source's retrieval date is the recorder's own. A batch with one refused item is refused whole and
goes back to the judge that wrote it, so nothing unanchored enters the pool. An item's id is its
question, topic and claim; a new revision of the same claim is appended, and the latest by `seq`
wins.

### The drift ladder

Whenever evidence is about to be used — before a survey plans, before a re-review, when a brief
is written, when `evidence.md` is rendered — each relevant item's state is derived on read, never
stored:

1. **Anchor check** (deterministic, `checkAnchors`). A committed span is mapped through
   `git diff -U0 -M <at>` to the working tree, so renames are followed and uncommitted edits count;
   a snapshot span is diffed with `git diff --no-index` against its saved text. Both pass
   `--ignore-cr-at-eol`. A hunk wholly above the span shifts it; a hunk overlapping it changes it;
   a pure insertion counts as inside only between two of its lines. A query is re-run and its
   `{path, text}` set compared, line numbers ignored. A source expires after
   `evidence_max_age_days` in `.agentics/config.json` (30 by default). A derived item is stale when
   what it rests on is stale and suspect when it is suspect. Untouched anchors are **standing**; a
   changed one is **suspect**. A line that only gains or loses its final newline is no hunk under
   `--ignore-cr-at-eol`, so it changes nothing.
2. **Re-judge.** Suspect items go, up to twenty per call, to `agentics:analyst` on `haiku`, with
   the claim and each changed anchor's old and new text. `holds` re-anchors the item where the text
   now is; `fails` and `unsure` make it **stale**, because an unsure check is never a pass. This is
   the stated exception to the intelligence tier: the question is narrow, and any doubt routes to
   the full-tier survey, so being too cheap can cost money but never correctness. Whether text
   changed is always the diff's call; the model rules only on whether the change matters.
3. **Narrowed re-survey.** The survey searches the stale items' topics again, with every standing
   item handed in as known ground, and nothing else is bought again. Its new items make new claims,
   so they take new ids and the stale items stay in the log; a stale item is **superseded** once a
   standing item of the same topic, sharing a ground path with it, was recorded at a higher `seq`.
   A superseded item is neither reused nor searched again.

A comment typo inside an anchored span costs one line of one batched re-judge; a typo outside
every span costs nothing. Approved specs are not alarmed by drift: an effort's own development
moves the ground its items describe, so drift is checked when evidence is used.

Every rung reads the checkout the run is in. `recordItems`, `checkAnchors`, `itemsFor`,
`reviewScope` and a `holds` re-anchor take an optional `root` (the CLI's `--root` on `record`,
`items`, `judge` and `review-scope`), the main checkout by default, so a survey or a probe run in
a linked worktree anchors, checks and re-anchors against the worktree's text and HEAD. The pool
itself is always the main checkout's `.agentics/.state/evidence/`.

### Survey

The survey (`gather-evidence-without-concluding`) gathers evidence for one question and never concludes.

1. **Reuse.** When the caller names its `ground`, one courier runs `evidence.mjs items` for the
   items of earlier surveys whose ground overlaps it. Standing items become known ground; suspect
   ones are re-judged; stale ones, and any still suspect after the re-judge, send their topic to be
   searched again.
2. **Plan.** One analyst decomposes the question into topics, names each topic's subtree and the
   common ground, and is told what the pool already establishes and which topics are searched
   again regardless; it plans only what the pool leaves open. A pool that answers the question buys
   no search.
3. **Scout.** One scout per topic, the common ground scouted once. Scouts return locations and a
   `stop_reason`, with `no_match` and `not_reached` kept apart, and are continued on exactly what
   remains until exhausted. History and docs channels run alongside when the plan asks, each with
   its own `.catch`.
4. **Assemble context for analysis.** Judges are dealt first: one analyst for every topic, unless
   `pace` or more than 60 distinct locations earns more. Then, per judge, `lib/citations.mjs
   excerpts` reads that judge's locations and the shared ground's once into
   [context files](#context-files).
5. **Judge.** Each analyst **without search tools** returns items — one claim each, with the
   anchor its kind needs — and risks. A topic with neither is dropped.
6. **Record.** One courier per judge group runs `evidence.mjs record --kind survey` over all its
   items, the token as JSON by file. A refused item goes
   back to its judge until a pass anchors no more; what never anchors is dropped and leaves its
   topic incomplete, and so do items the recorder could not be reached to check.

Coverage is complete when every topic reported complete coverage and all its items stand.

### Existing solutions

`search-for-existing-solutions-before-building` records what it establishes too: each assessed candidate as an
`external` item anchored at the source it was read from, each hit the repository already carries as
a `behaviour` item anchored at that line. Recording is a side channel: a candidate that can't be
anchored or recorded is named in the result and costs no coverage. A sweep answers its capability
whole, so once a later sweep records items for a question and topic, `itemsFor` leaves out every
item an earlier sweep recorded for them. A sweep is dated by the `seq` its return first recorded
at, and an item the later sweep repeats is the same item and stands. The log keeps every line.

### Cites and evidence.md

A folder records the items it rests on, with the coverage gaps it rests on them despite, as a
`cites` line (`evidence.mjs cite`). The folder's latest line by `seq` is its whole citation, never
merged with its earlier lines, so Analyze cites everything the folder rests on each time. Its
`evidence.md` is rendered from that line and the items' states at render time (`render.mjs
evidence`): grouped by topic, each item with its state and anchors, and every gap named. It is
never edited and never read back. `effort.mjs rename` carries each renamed folder's latest line to
its new id, marked `renamed_from`, approved or not.

A folder is **retired** when compile retired its node: `nodes.jsonl` names it and the live tree
doesn't, and its citation counts for nothing. An item that is stale and named by no live folder's
latest line, in any effort, is **pruned**: `itemsFor` leaves it out whatever states it is asked
for, and `recordCites` refuses it. Its lines stay in `items.jsonl`.

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

**Where and how.** `.agentics/<effort>/.state/knowledge/<id>.md`, one file per gotcha, with
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
worktrees, and never touches the user's tree. The workflow is `execute-approved-plan-in-worktrees`; the session
launches it with a stamp it minted, because a workflow cannot read a clock.

### Boundaries

Every deterministic step runs at one of seven boundaries, each one courier dispatch running one
`lib/boundary.mjs` entry point under one digest. Every entry point is **idempotent**: re-running it
after an unobserved outcome converges on the same state, because each step first checks whether its
effect already exists (a merge already in the branch, a record already in the log, a worktree
already attached).

| boundary | fused steps |
|---|---|
| **preflight** | refuse an execution overlapping an open one; drift check against the envelope's base; traceability; free this execution's slots and its dead worktrees (clean ones only — a dirty one is reported, never forced); write the leaves the base moved under, and the diff, for the ruler; create the execution root's todo. A checkpoint's lists (the overlapping executions, the gaps) go on its state line, for the session to read with `lib/status.mjs checkpoint`; the payload carries counts |
| **schedule** | append the workflow's decisions; compute what to launch from the tree on disk (`lib/schedule.mjs`, see [Scheduling](#scheduling)); attach to each launch the one row it needs, and to a leaf's its parent's row and its resume ladder; move the todos of the nodes it touched |
| **leaf-open** | acquire a slot and the locus locks; ensure the parent's integration branch (lazily, refreshed from its own parent) and cut or attach the leaf's branch and worktree; assemble its brief; append `dispatched`; move the todo |
| **leaf-close** | commit a shell-less author's locus files (anything outside is reverted and reported as a breach); build, typecheck, suite, discriminator, declared mutations and named checks by rigor; journal the observation; write and delete reported gotchas; compute the close decision; move the todo |
| **merge-batch** | under the branch lock, record `batch-started` with the head it starts from; merge every approved child into one integration branch in dependency order; verify the merged head with the fast suite; bisect a red one; append `merged` and `merge-observed`; release locus locks; append a `batch` state line; complete the todos. A batch that started and never recorded its outcome is reset to where it started and done again, so an unverified merge is never recorded as landed |
| **suite-gate** | on a composite whose children have all merged, under its branch lock: run the full suite on its integration head, against the head it was cut from; write the measurement; append a `gate` state line. It runs nothing where the repository does not split its tests, or where the full suite already passed at that head in this execution ([The suite gate](#the-suite-gate)) |
| **postflight** | append the workflow's last decisions; release this execution's slots; summarize the subtree from disk (counts, the nodes the user must act on, the leaves waiting behind each, cycle members held); append `closed` when every leaf in scope merged; count the branches eligible for cleanup |

Schedule and postflight first append the workflow's pending decisions (`records`: approvals,
escalations, parks, integration verdicts, dispatch cost lines). No other boundary carries them, and
the main loop calls those two one at a time. Each record carries an id: the invocation's number,
which preflight mints on disk (the workflow has no clock and no randomness), and a digest of the
record's content, counted when one invocation decides the same thing twice. A record sent again
after a lost courier lands once; the same decision taken in a later invocation — an approval at the
same head after a retry — has a new id and lands again; a run the host resumes replays the dead
run's preflight, and so re-derives the same id for the same decision in whatever order its units
finish. A record the lib writes itself (a merge-batch run again) is known by its content.

**A unit is in flight until a tick has carried what it decided.** A unit that ends while a schedule
call is out stays in the workflow's running set, so that call launches nothing beneath it or twice,
and the loop ticks again at once to land its records. Launches that come back are checked against
what the workflow decided while the call was out — a node it stopped or one a leaf waits on (the
launch's `waits_on`), a folder it began replanning — and a stale one is dropped for the next tick.

**A payload is bounded by the pool, never by the effort.** A courier pastes what it carries, and a
host shows only so much of one shell call's output, so nothing a boundary prints grows with the
size of the tree: launches are capped by `max_parallel` per kind, each launch carries one row, and
what spans the whole effort — a checkpoint's lists, the per-leaf picture — stays on disk for the
session, which can read it. What may list nodes is bounded by one folder's fan-out (a merge-batch's
children, an integration review's) or is a node the user must act on (a stopped node).

**A payload carries only what the workflow branches on.** A courier retypes what it carries, token
by token, and a model retyping long or repetitive text — a test run's output above all — normalizes
it: the digest then fails however strong the model. So no output of a build, a suite or a check
crosses the channel in either direction. leaf-close writes everything it measured and decided to
`closes/<stem>.json` and carries `{next, reason, failures[{check, claim}]}`, the record's path and
the todos; merge-batch writes its measurement to `merges/<target>-<pre>.json`. Whoever decides a
node's next round — leaf-close on `fix`, merge-batch for a leaf that fails on the integration head
alone — writes the failures with their evidence to `fixes/<node>-r<round>.json`, and leaf-open
builds that round's brief from it; the arguments carry none. A close that decides anything but
`fix` removes the file for the round after it.

**What an agent says to the user, it writes itself.** The workflow's records reach disk inside a
schedule or postflight token a courier retypes, so they carry no agent's prose. Preflight names
the execution's `said/` directory; every agent that can stop a node — an executor, the planner
writing or settling a spec, a reviewer, the ruler ruling on drift or a moved base — is told a file
there and writes to it, in full, the question, the need, the review or one node's ruling, its first
line saying it in one sentence. Each file is its own: named by the invocation, a count within it
and the dispatch label (a node id's `/` written `.`), so no later dispatch overwrites what an open
stop points at and a file its author did not write is seen missing, never mistaken for an older
one; the ruler gets one file per node. The record carries that path (`said`) and no text of the
agent's; its own `question` or `detail` holds only a line the workflow composed, or nothing. Every
reader — the Next line and the watch (the first line), the snapshot and the landing check (the
whole) — shows the file (`saidOf`), and says so plainly when its author did not write it. Text the workflow holds itself — a
reviewer's findings — goes to the executor in its dispatch prompt, which is never retyped. A
payload field the workflow does not read is not printed.

**Why the lib schedules:** a workflow script has no filesystem, so a scheduler in the script needs
the whole tree carried to it and a second copy of status kept beside the one on disk. Scheduling
where the tree already is removes both: the script holds only its units in flight.

**Long checks run detached.** leaf-close and merge-batch run in a child process keyed by their
arguments and by what their answer depends on — the worktree's head and state, the report, the
established commands, the target's head, the payload's format — and are polled; a poll that reaches the limit (kept
under the courier's own shell-call limit) answers `pending`, and the workflow re-dispatches the
same boundary, which finds the same job. A host's shell timeout can end a courier, never the work. The
same arguments over a moved tree are a new job, and a job that failed is never kept as an answer.

**Integration branches are locked while they move.** leaf-open creates, attaches and refreshes
each integration branch on its chain under that branch's lock, and cuts the leaf under its
parent's, so concurrent leaf-opens and a merge-batch bisecting into the parent never race; a
lock held longer than a leaf-open may wait answers `busy`, and the workflow re-dispatches.

**Retries are sized to what was observed.** A courier that returned nothing or could not run the
command is re-run once, because the entry point is idempotent; a payload that fails its digest
buys one refetch on a stronger model; an argument token the program refused as damaged buys one
fresh courier; a program failure is not retried.

**A plugin fault is never the user's decision.** A boundary that stays unbelievable (`transport`),
a detached job that threw (`program`), an agent dispatch that returned nothing (`dispatch`), a
ledger that refused a record (`ledger`), or a throw in the workflow itself (`pipeline`) ends that
unit as a `fault {node, channel, detail}` state line: no `escalated` event lands, so the node's
status on disk is what its last real record says. It is held for the rest of the invocation — the
schedule is told (`held`) and neither launches it nor counts it against the pool, and its slot is
freed — and the result lists it under `faults` and in `coverage.unreached`. develop
relaunches the execution once at once, and the next invocation takes the node up where it stands;
a fault on the same node again is reported as a plugin defect with what it left undone, never asked
as a question. The user is reached for two things only: a premise a parallel change made obsolete
(after the ruler ruled it so, [Landing and drift](#landing-and-drift)), and a complication no agent
could resolve: a review or a replan that does not converge, a merge conflict, a broken environment,
an executor that is blocked.

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

A merged head is measured with the fast suite (`suite_fast`), or the full one where the repository
does not split its tests. The big tests wait for the [suite gate](#the-suite-gate).

**A failing merged head** is reset to the last green head, and the script bisects the batch. A leaf
that fails alone on the new head gets a fix round on its branch refreshed from the integration
head; a composite or a cycle that fails alone has no one producer to send it to, and escalates
(`fails_on_integration`); leaves that each pass alone and fail together escalate as a
**combination failure** naming all of them — it is a design question, not a leaf's. A batch that
cannot run at all escalates its target (`merge_batch_failed`), and one that merged nothing and
reported no failure escalates too (`merge_no_progress`): nothing is re-batched into a stopped
target.

### The suite gate

A repository may split its tests into fast and big ones, and name the fast ones as `suite_fast`
beside the full `suite`. Then the tests run in three places, each wider than the last: a leaf runs
the tests its planner picked ([Atomicity](#atomicity-when-to-stop-splitting), condition 4); every
merge-batch runs the fast suite on the merged head; and once a composite's last child has merged,
before its integration review and so before it merges up or lands, `suite-gate` runs the full suite
on its integration head. At the effort root, that is the last measurement before landing.

A test failing on the gate that fails at the head the branch was cut from is not the composite's
(`baseline_failing`, as everywhere). Any other failure escalates the composite
(`fails_full_suite`): its merged work has no one producer a fix round could go to, and the user
routes it, as with a composite that fails alone on a merge. A gate that could not run escalates as
`suite_gate_failed`. A passing gate is recorded against its head and not run again there; a failing
one is run again by the next invocation, since what failed it may be the environment.

Where the repository does not split its tests, every merge-batch already ran the full suite on
the very head the gate would measure, and the gate runs nothing.

**Why the big tests wait:** they are slow, and a run of one per merge-batch would make every merge
pay for them. A folder's integration branch is where the work of many leaves first meets whole,
and it is the last point before the work leaves the folder: one full run there catches what the
fast suite misses before anything outside depends on it.

### Scheduling

A ready set per execution, recomputed by the `schedule` boundary (`lib/schedule.mjs`, pure over
the node records, the event log and the execution's state log) whenever anything in flight settles.
The workflow says what it has in flight — its running units, and the folders a running unit is
replanning inline, and the nodes it holds on a plugin fault — and launches what comes back.
Nothing below a running or replanning node launches, and a held node does not launch at all.

A leaf's dependencies are its own and every ancestor's: a dependency declared on a composite or a
group binds every leaf beneath it. A leaf is ready when its dependencies' outputs exist where it
will be cut — a dependency (or its ancestor just below the two nodes' lowest common ancestor,
groups passed over) has merged into that ancestor's integration branch, or, for a cycle predecessor, is approved — no open escalation
or park sits on its dependency chain, no escalated or parked leaf holds a lock on its locus, and a
slot can be had. Leaves launch up to the pool less the leaves running.

A folder with nothing planned beneath it is planned, up to the pool less the plans running. A
folder the planner wrote that its compile parked `spec_changed` (the park's `return`) is re-derived
once per park: again only when this execution has no `plan:<id>` dispatch newer than that park.

A merge-batch runs whenever approved children wait on an integration branch nobody is merging into,
at the heads their approvals named; a leaf still running (a fix round after it failed on the
integration head) is not among them. Cycles are held and land as a unit. A composite whose
children have all merged is reviewed at its integration head; it is ripe to merge up when its
latest `claims` event is newer than its last clearing (a replan, a revision, an answer), names its
current head and says `review: done` or `not_earned`. So a folder whose park was answered is
reviewed again before it moves.

**Parallelism lives at the leaves and is controlled from outside the execution.** A slot is the
right to run one leaf. The pool is `.agentics/.state/slots/`: its size comes from the project's
settings file, which the user edits (`.agentics/config.json`, `max_parallel`, default 4), read at
every leaf-open, so a change takes effect
on the next dispatch in every running execution at once. Slots are lock files naming their holder
leaf, acquired at leaf-open. A slot is free when its holder's derived status is no longer active
(approved, held, merged, escalated or parked) — or when it is no longer a leaf, because a replan
decomposed it — so release needs no write of its own; a locus lock whose holder was decomposed, or
whose revision dropped that path, is free for the same reason; a slot whose
holder belongs to an execution that is no longer running is freed by that execution's next
preflight, or by the user.

**Who controls what.** The `schedule` boundary decides *which* leaves are ready and in what order —
arithmetic over the plan and the events, on disk — and launches no more leaf chains than the
pool's current size. *Admission* is decided by `lib/locks.mjs` inside leaf-open: the entry point takes a slot and the locus locks atomically, or
waits for them in-process (polling the lock files locally, costing no tokens) until they come free.
A wait that reaches the host's shell-call limit returns `no_slot` or `locus_held`, and the script
re-dispatches leaf-open for that leaf; nothing else stalls. A lock held by an escalated or parked
leaf frees only when the user acts, so leaf-open answers `stuck` at once, the scheduler reads the
same lock and does not launch the leaf again, and the leaf is reported blocked by that holder
rather than waited on. The user controls the limit.

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

- **Integration review** runs per folder over the merged diff of its children, against its
  decision list, the criteria of every child reviewed there, and the folder's spec as its
  yardstick. It is earned at the root whenever something merged there (the landing view reads its
  verdicts), and below the root when a child had no review loop of its own or two or more children
  with work meet there; otherwise it is skipped and the log says why. When planned children did not
  land, every finding carries that caveat. Besides findings it returns a **claim verdict** for each
  claim the spec makes (a success criterion, a Design statement, a plan criterion): `met`, `under`,
  `over`, `deviates`, `spec_defect` or `cant_tell`, recorded as a `claims` event at the head it
  judged (`review: done`; a skipped review records `review: not_earned` and no verdicts, and one
  that returns nothing escalates the folder `review_failed`). Routing is by
  class, first match: any `spec_defect` parks the folder `spec_defect` on its spec (a re-spec);
  any critical, or any `under`, `over` or `deviates`, parks it `integration_critical` (the user
  routes the fix); any `cant_tell` parks it `cant_tell`, which never counts as a pass.
- **Establishing commands** is judgment: when no build or test command is established, leaf-close
  returns `command_unknown`, and an investigator establishes them once for the execution, recorded
  as `command` gotchas.

### Model tier

The node's author sets `dispatch` per stage, because it holds the context. Defaults: **producers**
(implementer, test-author) run the cheaper model, with effort scaled to the leaf's difficulty;
**gates** (reviewer, planner, analyst, ruler) run the stronger model at moderate effort. A leaf whose
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
pending designed node. Merge-batch writes the merged change to the files hit
(`merges/<target>-<pre>.drift.diff`) and names each consumer's spec; one ruler reads both and
rules each consumer `unaffected` (a `drift-ruled` state line; it runs on, and the user never hears
of it) or `affected`, with the one question its owner must answer. A consumer is not launched while
it is being ruled on. Only an affected consumer is parked (`contract_drift`) for the user; so is
one no ruler ruled on after a second dispatch, because drift is found only on the batch that
landed it and a held consumer would lose it. Everything else keeps running. Undesigned nodes are
reported as unexamined.

The same holds for a base branch that moved under a resumed execution: preflight writes the leaves
whose files moved, and the diff, to `stale-<now>.json` and `.diff` beside the state log and hands
their ids on; one ruler rules them before anything runs. Each ruling gets a `stale-ruled` state
line keyed to that base head, so a resume against the same head asks about neither again: an
unaffected leaf runs on, an affected one is parked `premise_mismatch` with the question, and the
user's answer stands. A leaf no ruler ruled on after a second dispatch is held as a fault and
ruled on by the next invocation; a leaf already stopped is left out until its stop clears. No
checkpoint stops the run for it.

**Why a ruler first:** hash drift says a premise may have moved, not that it did. Most drift
touches what a consumer does not rely on, and putting every hit to the user makes the user the
filter for noise; a reader that did not write either side rules first, and the user is reached
only when a premise really moved.

**Landing is the one ask.** When the effort is complete, or the user says to land what exists, the
session runs `lib/boundary.mjs land --action check`: how the user's branch drifted since the
effort branch was cut, open escalations and parked nodes, every `HUMAN:` criterion verbatim, the
root's claim verdicts (`root_claims`) and the **landing view** (`landing`, from
`lib/render.mjs renderLanding`: the root spec's success criteria beside those verdicts, what did
not hold first, a `cant_tell` counted apart from `met`). The session shows it, asks, and runs
`--action merge`, which merges the effort branch into the user's checked-out branch and appends
`landed`. It refuses over an open escalation, a parked node or a dirty tree; untracked state under
`.claude/` and `.agentics/` is not dirt. Cleanup of merged branches and their clean worktrees
(`--action cleanup`) follows on a go, and only from the checkout that took the merge.

---

## Verification

`lib/verify.mjs` runs the mechanical checks of one leaf — the commit series, the build, the
typecheck, the leaf's own tests, the discriminator, the declared mutations and the named checks —
in one process, and of a merged head — the build, the typecheck and the fast or the full suite, as
the caller asks. **Nothing in it decides whether the leaf passed.** It observes, prints exactly the fields
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
| green | yes | the red leaf's tests pass now | no | when given |
| audit | no series expected | no | required | — |

- **Absent is never inferred, in either direction.** `absent` means the repository defines no such
  command; `failed` means a command ran and exited non-zero. A command nobody named and nobody
  declared absent is `command_unknown`, a typed error.
- **A passing suite is not evidence that the tree compiles.** The typecheck is its own answer.
- **The environment check runs first, and it refuses.** The discriminator stashes and moves HEAD,
  so the program first establishes that it stands in a linked worktree. It always puts the tree
  back, or says `tree_not_restored`.
- **Uncommitted work is set aside by its own commit, off the shared stack.** Every worktree of a
  repository, and every session in them, shares one stash stack, so a bare pop takes whatever is
  on top. The work is stashed under a tag no other entry carries, kept under a ref of the
  worktree's own (`refs/worktree/agentics-verify/<tag>`) and dropped from the stack at once; it
  comes back by that exact commit. Nothing another tree stashes is popped here, and no pop
  elsewhere takes this work. A drop goes by position, and one that took another entry puts it
  back.
- A test that could not be launched at base is `test_unrunnable`; a suite failure that cannot be
  placed against a test file raises `suite_failures_unnamed`.
- **A leaf runs the tests it is told to, and no others.** Its own tests are the test files its
  diff changed, plus the cycle's test files for a green or an audit, each run through the
  `test_one` template (`suite_scope: scoped`; `none`, with `suite: not_run`, when there are none).
  Beside them it runs every criterion's `check:` command: the tests the planner picked to decide
  the criterion ([Atomicity](#atomicity-when-to-stop-splitting), condition 4). The fast suite runs
  once per merge-batch on the merged head (`suite_scope: fast`; `full` where the repository does not
  split its tests), which is where a leaf's reach beyond its own tests is caught and bisected back
  to it ([Merging](#merging)); the full suite runs on a finished composite's head
  ([The suite gate](#the-suite-gate)). Stack-neutral on purpose: a file-level test template, a
  command per criterion and, optionally, a fast-suite command are all it asks of a repository.
- **One whole suite at a time in the project.** A whole suite, fast or full — a merged head's, a
  gate's, or a named check whose command contains an established suite command — runs under
  `.agentics/.state/locks/tests.lock`, shared by every execution and session. Suites that share
  the machine time out for it, and a failure that is contention is nobody's to fix. Everything else
  runs unlocked, so parallel leaves test in parallel. The wait is long: the caller is a detached
  job, never a courier.
- **A failure that was already there is not the change's.** When the suite or a named check
  fails, each failing test file the change did not touch (nor the cycle's tests) is run at the base
  and its failures named the same way; a failing test whose same `{file, id}` fails there too is
  `baseline_failing`. A check's failures are named only when every one it printed could be placed
  against a test file.
  A new failure in a file that was already failing for another test stays the change's. A fresh worktree missing a gitignored asset fails the same way
  at its base, and no commit inside a locus could move it.

### What a verdict is computed from

`lib/verdict.mjs` is the one home of the measurement verdict. `measurementOk(m, leaf)` derives pass
or fail from the observations against the leaf's profile (every profile needs a completed
measurement, no failed build or typecheck and no blocking series finding; then per profile: a tdd
leaf's new tests fail at base and pass now; a tests-only leaf's tests pass and every declared
mutation bites; a red leaf's tests fail now and at base; a green leaf's cycle tests pass; an audit's
mutations all bite over the cycle's tests; trivial, verify, tdd, tests-only and green need their
named checks and their own tests not to have failed). A named check fails for the change when it
did not pass, unless it failed naming tests every one of which fails at its base too
(`checkFailed`). A suite failed for the change only when one of its named failing tests is the
change's own: `baseline_failing` lists the failing tests, in files the change did not touch, whose
same test fails at its base too, and `suiteFailed`/`ownFailing` leave them out, at a leaf and on an integration head
alike (whose base is the head before the batch). A failure that names no test is never excused.
`closeDecision` turns that into the next step: `review`, `approve`, `fix`,
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

A checkpoint dispatches nothing new and says how to proceed. What it found — the overlapping
executions, the gaps — is on its state line, and
`lib/status.mjs checkpoint --effort <e> --execution <stamp>` prints it:

| checkpoint | meaning | to proceed |
|---|---|---|
| `existing_execution` | an open execution's root is an ancestor or descendant of this one | resume it; or `confirmed_duplicate` |
| `blocking_gaps` | untraced decisions, or evidence the node depends on was not reached | `confirmed_gaps` |
| `parked` | the caller launched with `plan_only`, or nodes await a user-bound return | resume with the answers |

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
  touches a node creates its todo. A move names no task id: the courier finds the node's task by
  its subject with one TaskList call, and creates it when there is none.
- **`--no-progress`** drops those calls. The session then derives the list from the event logs
  (`lib/status.mjs todos`) on launch, on wake and on return, and the workflow's log still narrates
  every boundary. The same path serves a host whose subagents have no task tools: the courier
  reports `task_tools: unavailable` and the workflow says so.
- **The list is a view.** Nothing reads it back as state, it is never hand-edited, and a status
  header (`ONGOING`, `DONE`, `NEEDS_INPUT`) is rendered from derived status for display only.

**Why a flag:** each todo move is a turn on a courier, which is cheap but not free; a user who
watches the log or checks in only at the end should not pay for it.

**Questions are asked while the run goes on.** A park or an escalation stops only its node; the
develop session watches for them with `lib/status.mjs watch`, which prints one line per
`escalated` or `parked` event of the execution after the watch began and exits when postflight
appends `ended`. The session asks the user at once and records the answer: a re-spec's approval and
compile clears a park (`replanned`, `answered`), and `lib/boundary.mjs retry --node <id>` clears an
escalation (`replanned`, `retry_escalated`). The workflow snapshots the stops it decided before
each schedule call; a node from that snapshot the schedule launches anyway is one disk no longer
holds stopped, so the workflow drops it from its escalations and parks and runs it again in the
same invocation. A stop decided while a call was out is not in the snapshot and stays dropped
(see [Boundaries](#boundaries)); a plugin fault is never relaunched this way.

**Why:** the user's attention is the scarcest resource in the loop. A question held until the whole
run returns idles the node for the run's length and hands the user a batch at the end; asked at
once, it is answered while other work goes on and the node rejoins the run.

The agentics viewer (vanillafairy's `agentics-viewer/`) draws an effort live from
`lib/status.mjs snapshot`. It reads, and never writes, the effort store.

### The Next line

`lib/next.mjs` computes the one command to run next for an effort from its specs, the ledger, the
node and event logs and its executions. First match wins:

1. an open execution → `/agentics:develop <folder>`: resume it;
2. a parked or escalated node → what it waits on and the spec to edit: `/agentics:design <node>`
   for a `needs_design` park, `/agentics:develop <folder>` otherwise;
3. a spec the user writes that has a `blocking` question or is not approved →
   `/agentics:design <folder>`; one whose latest review of its current text was partial →
   `/agentics:design <folder>`, which resumes its Review stage on the axes it left unexamined;
4. a spec the user writes, edited since approval → `/agentics:design <folder>`;
5. an approved plan naming an `author: you` sub-effort that has no spec →
   `/agentics:design <entry>`;
6. approved or prepared, with nothing dispatched beneath it → `/agentics:develop <folder>`;
7. the root integrated → the landing view, then `/agentics:develop <effort>`.

Ties go depth-first in sorted folder-id order and nothing else, so a fresh session computes the
same line; up to two alternatives follow it. A folder is named by its path from the root, the root
by the effort's name. Folders the planner writes never route to design. Every visible command ends
by printing the line (the verbatim block `next-footer`), and one invoked where it does not fit
prints the line and points there instead. `/agentics:next` shows every effort, where it stands and
its line, and offers to run it.

**Why:** "what now?" has one computed answer, so no session has to remember it and no two can
disagree about it.

---

## Agents

| role | does | cannot | tools |
|---|---|---|---|
| scout, historian, doc-researcher | find, to exhaustion | conclude | search tools; historian read-only git; doc-researcher the web |
| analyst | judge what it is handed | search | `Read` only |
| ruler | rule whether a change moved the premises of nodes not yet done | search, touch the work | read; write (the ruling files its dispatch names) |
| planner | write the spec of a folder develop owns (an `author: planner` sub-effort, a promoted task, its own folder replanned) and settle its autonomous review | state a decision, implement | read, search, shell (for `lib/spec.mjs check`), write |
| implementer | code one leaf as a focused series, or its fix round | leave its locus, amend, merge, certify | read, edit, shell |
| test-author | write a leaf's tests and declare mutations | implement, execute anything | read, edit |
| auditor | declare mutations against an implementation | edit source, execute anything | read, write (its report, and its said file when it stops short) |
| reviewer | attack a span | approve, edit | read, read-only git; write (its own review file) |
| investigator | establish build and test commands when none are known, recorded as `command` gotchas | judge quality, fix anything | read, shell |
| courier | run one command (after the token writes it is handed), paste stdout; move todos | anything else | shell, task tools |

### Capability layer

Capability is the tool allowlist and nothing else — no hooks. The test-author, auditor, analyst,
ruler, scout and doc-researcher carry no shell, so the authors of every yardstick are structurally unable
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
| `design` | one folder's spec at any depth: the loop from Analyze to Move on |
| `develop` | building a folder or a settled request: the root spec, launch, result walk, re-specs, landing |
| `challenge-idea` | attacking a written artefact |
| `investigate` | answering a question from evidence (`answer-codebase-question-from-evidence`) |
| `search-for-existing-solutions-before-building` | service step, hidden (`user-invocable: false`) — the outward search (`search-for-existing-solutions-before-building`) |
| `next` | every effort, where it stands and its computed Next line; hands the pick on |

A service step carries `user-invocable: false`: it is gone from the `/` menu, and the model still
runs it when asked in chat.

**A stopped node named to develop is a question, not a launch.** Words that name a parked or
escalated node (a pasted Next line, the viewer's prompt) take develop straight to asking the user
about that node; its execution is relaunched only once the answer is recorded. A relaunch without
the answer runs everything else and hands the same stop back at the end.

A skill file holds the router and the steps; step detail lives in reference files loaded when the
step is reached. A contract several files must state identically is a verbatim block, placed only
in the files whose reader acts on it.

**Asking the user** is the verbatim block `asking-the-user`, in every skill that asks. A question
states in its own text everything needed to answer it. One drawn from a set the session holds —
findings, defaults, parked nodes, a batch of decisions — opens with its place and the set's size
(`5/24`), counted across calls; a number once given stands, and a grown set raises the size for the
questions after. A reply that asks a question back instead of choosing is not an answer: nothing is
recorded, and the question is asked again with the elaboration inside it, each option's description
saying what that choice changes. Numbering needs a set held before asking; the Grill's interview,
which finds its next question in the last answer, has none.

**Why:** the dialog is what the user answers from, so the elaboration they asked for belongs in it.
One left in the session's thinking never reaches them, a re-ask that points at it hands back the
question they could not answer, and a clarification taken for an answer records a decision the
user never made.

---

## Data contracts

Workflow scripts cannot import, so a contract can live in several places at once. Each entry names
its **owner** (the code that defines the shape) and where it is **restated**; a change to a field
list edits every place named, in the same commit series.

Two conventions hold throughout:

- **Digests** are FNV-1a, 32-bit, 8 hex characters, over `canonical()` from `lib/plan-digest.mjs`:
  keys sorted, `undefined` read as `null`. `execute-approved-plan-in-worktrees` carries identical copies.
- **A CLI whose output a courier carries back** prints `{payload, payload_digest}` and exits 0,
  even when the payload reports a typed error. `{error}` with exit 1 means the program itself
  failed. Arguments minted by the workflow arrive as `--b64 <token> --digest <d>`, or
  `--json-file <path> --digest <d>` for an evidence token; a mismatch is
  refused as `digest_mismatch`, and nothing is written.

### Node record and events

- **Owner:** `normalizeNode`, `nodeProblems`, `treeProblems`, `deriveStatus`, `claimsOf` in
  `lib/tree.mjs`; `EVENT_KINDS` in `lib/ledger.mjs`.
- **Restated in:** `agents/planner.md`; `skills/develop` and `skills/design` (the root and design
  node JSON); the preflight row in `lib/boundary.mjs` (it carries `author`); `todoFor` in
  `lib/status.mjs`; the entry-to-node mapping in `lib/compile.mjs`; `lib/next.mjs` and
  `lib/render.mjs` (readers).

Fields as in [Nodes](#nodes). Event lines are `{kind, node, execution, seq, ...}`:
`planned {by}` · `replanned {reason, by}` (also `retry_escalated` and `answered`) ·
`dispatched {role, round, model, effort}` · `approved {head_sha, review_rounds, at_integration}` ·
`merged {into, merged_sha, head_sha}` · `escalated {reason, detail, said?}` · `parked {return,
question, said?}` (`said` is the file the agent behind it wrote, in full; `detail` or `question` is
then empty, and `saidOf` in `lib/store.mjs` reads either)
(`return` is a replanning return, `needs_design`, `needs_respec`, `integration_critical`,
`spec_defect`, `cant_tell` or `contract_drift`) ·
`landed {into, merged_sha}` · `claims {head_sha, review: done | not_earned, claims[{claim, verdict}],
said?}` (each verdict's evidence is in the reviewer's `said` file).
An event the workflow decided carries its record id, `rid`.

### Snapshot

- **Owner:** `snapshotOf` in `lib/status.mjs`.
- **Restated in:** `agentics-viewer/shared/snapshot.ts` in the vanillafairy repository (a reader).

`node lib/status.mjs snapshot --repo <r> --effort <e> --json` prints the effort’s whole state in
one read-only call, under a digest — it writes no file, no lock and no `seq`. The payload:
`format` (1; changing a field this entry lists bumps it), `store` (the main checkout’s
`.agentics`, whether or not `repo` is a linked worktree), `effort`, `about`, `seq_max`, `malformed`,
`folders`, `nodes` and `cost`.

`folders` is every folder that holds a spec, root first, each `{id, title, approval, blocking,
spec: {path}}`: `title` and `blocking` (its open `blocking` questions) from `parseSpec`, `approval`
from `approvalState`. `nodes` is every live node, the root’s subtree first and then any node the
tree cannot reach, each `{id, label, parent, kind, title, intent, context, rigor, role, locus, deps,
acceptance, status, event, stage, branch, worktree, commits, files}`: `label` is the node's own
label, else the last segment of its id (the effort's name at the root); `status` from `deriveStatus`;
`event` is the escalated or parked node’s own event (`{kind, seq, reason, detail}` or `{kind, seq,
return, question}`, the text read through `saidOf`), null for every other status; `stage` is `todoFor`’s `activeForm` while its
`status` is `in_progress`, null otherwise; `branch` is the node’s own branch name, always; `worktree`
is its path only when checked out; `commits` is `{count, last_subject, last_at}` over the leaf’s
own branch since its folder’s, null unless the leaf is `active` (an inactive leaf, or anything that
is not a leaf, never earns the git call) or either branch is missing; `files.spec` is `{path, line}`
— a leaf’s folder spec at its plan entry’s line, a group’s at its heading’s, a folder’s own spec
at no particular line — and
`files.briefs`/`files.reports` list only the paths that exist on disk. `cost` is `costOf`’s totals
and `per_leaf`, trimmed to `{dispatches, tokens, tokens_unreported}`.

`node lib/status.mjs list --repo <r> --json` also carries `store`, present whether or not the
effort store exists.

### Spec format

- **Owner:** `parseSpec`, `checkSpec`, `checkFolder` and `hashSpec` in `lib/spec.mjs`.
- **Restated in:** the `vocabulary` block ([Vocabulary](#vocabulary), naming every copy:
  `docs/DESIGN.md`, `agents/planner.md`, `skills/design/SKILL.md` and `skills/develop/SKILL.md`);
  the entry-to-node mapping in `lib/compile.mjs`.

A `# ` title, then `## Intent`, `## Decisions`, `## Design`, `## Plan`, `## Open questions`,
`## Evidence`, in that order. Decisions rows: `| <id> | <decision> | <why> |`, ids `D<n>` at the
root and `<folder id with / as .>.D<n>` below it. Open questions: `- **blocking:** …`,
`- **parked (reopens at <x>):** …`, `- **lookup:** …`, `- **compost:** …`. A plan entry:

```
- **<name>** — <kind> · key: value · key: value
  · key: value
  <title: one imperative line>
  <context prose>
  - [ ] <criterion> — check: `<command>`
  - [ ] HUMAN: <criterion>
```

Kinds: `sub-effort`, `task`, `deferred`, `dropped`. Keys: `realises`, `after` (a name in the same
plan, or `/a/b` from the root folder), `provides` (`<name> (<path>, …)`), `consumes`, `ground`;
`author` (`you` or `planner`) and `shared` on a sub-effort; `rigor`, `role`, `locus`, `reads` and
`dispatch` (`producer=<model>/<effort>, reviewer=<model>/<effort>`) on a task, which also needs a
criterion; `label` on either, the node's visible name. A node's id is its path and carries its
parents; the label names the work done there, at most 60 characters (`foundations/world/world-red`
is shown as `world-red-tests`). The viewer draws the label, and the last id segment where none was
written. A checked box is refused. Headings and forms inside a fenced block are prose.

A group:

```
### <name> — group · after: <name>, /<path>
<title: one imperative line>
<context prose>

- **<name>** — task · …
```

A heading of three or more `#` in a Plan must be a group heading, and `after` is its only key; a
group may not wait for a task inside it. Entries above the first group heading belong to the
folder; each entry below a heading belongs to that group, which must hold at least one task and no
sub-effort. Names are unique across the plan, groups included,
so a bare name in `after` names one entry or group wherever it sits. `parseSpec` returns the
groups beside the entries (`{name, line, title, context, after}`), and each entry carries its
`group` (`''` above the first heading); `entryId` gives the node id compile builds from one.
`node lib/spec.mjs check --repo <r> --effort <e> --folder <id>` prints `{folder, problems}`, each
problem `{file, line, problem}`.

### Ledger lines

- **Owner:** `lib/approval.mjs`; the file names in `EFFORT_FILES` in `lib/ledger.mjs`.
- **Restated in:** `lib/compile.mjs` (reads `approved`, `prepared` and `compiled`); `lib/effort.mjs`
  (`renameSubEffort` copies those lines).

`ledger.jsonl` shares the effort's `seq` counter with the node and event logs:
`approved {folder, hash, decisions[{id, text}], by: user, renamed_from?}` · `prepared {folder, hash,
review, by: planner, renamed_from?}` · `compiled {folder, hash}` · `disposition {folder, finding,
outcome: incorporated | discarded, by: user | planner}` · `review_skipped {folder, hash, reason}` ·
`reviewed {folder, hash, complete, remaining[], ambiguities[]}` (one per review round; `lib/next.mjs`
reads the latest, and the gate reads the latest at the current hash). `renamed_from` is the old
folder id, on the line `effort.mjs rename` appends for a renamed folder. A finding is named by its settlement
id: its evidence item id, or `<hash>#<P-id>` when the review could not anchor it; `disposition`
and `reviewed.ambiguities` both use it. A folder's approval state and its review gate are derived,
never stored, and a spec with an open `blocking` question is refused approval.
`node lib/approval.mjs approve|prepare|dispose|skip-review|reviewed|state|gate --repo <r>
--effort <e> --folder <id>` prints each function's return under a digest.

### Compile result

- **Owner:** `compileEffort` in `lib/compile.mjs`.

`{ok, problems[{file, line, problem}], written[], retired[], parked[{node, reason}],
flagged[{node, decision}], skipped[{folder, why}], answered[]}`, printed by
`node lib/compile.mjs --repo <r> --effort <e> [--folder <id>]` under a digest. `ok: false` means
nothing was written.

### State and journal lines

- **Owner:** `lib/boundary.mjs` (`batch`, `gate`, `checkpoint`, `closed`, `merge-observed`, `series-done`
  for shell-less authors), `dispatch` in `execute-approved-plan-in-worktrees`, `journalLine` in `lib/verify.mjs`.
- **Restated in:** the implementer's `series-done` heredoc in `execute-approved-plan-in-worktrees`; `lib/resume.mjs`
  and `lib/status.mjs` (readers).

`state.jsonl` (what the workflow decided): `dispatch {label, node, role, model, effort, tokens}` —
`tokens` is `null` where the host reports none; `batch {target, merged[], head_sha, verified,
failed_alone[], combination[], conflict}`; `gate {target, head_sha, passed}`, one per suite gate
that ran; `checkpoint {reason, detail, executions?, gaps?}`
(the lists the checkpoint found; `lib/status.mjs checkpoint` prints them); `closed {status}`;
`batch-started {target, pre, children}`; `checkpoint-confirmed {gaps?}` (what the user
confirmed past, printed by the same command); `drift-ruled {node, contract, head_sha, ruling, why, said?}`
(the ruler's `unaffected`) and `stale-ruled {node, base_now, ruling, why, said?}` (either ruling;
`why` is empty when the ruler's `said` file holds it); `invocation {}`, one per preflight, whose count
numbers the invocation's record ids; `fault {node, channel, detail}`, a unit a plugin fault ended;
`ended {}`, one per postflight, where a watching session stops. A line the workflow decided carries its `rid`.

`journal.jsonl` (what was observed, by whoever observed it): `verify-observed {node, branch,
worktree, base_sha, head_sha, stop_reason, build, typecheck, suite, failing_tests, baseline_failing,
discriminator, mutations, series_findings, checks}`; `merge-observed {node, branch, into, merged_sha, head_sha}`;
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
`typecheck` (`passed | failed | absent`); `suite` (`passed | failed | absent | not_run`) and
`suite_scope` (`fast` or `full` on a merged head, `scoped` for a leaf's own tests, `none` when nothing ran);
`suite_output_tail` (only when the suite failed);
`failing_tests[{file, id}]`; `baseline_failing[{file, id}]` (failing tests that fail at the base too);
`discriminator[{test_id, failed_on_base, passes_now}]`;
`mutations[{file, applied, unapplied_reason, expect_failing, observed_failing, bites}]`;
`series_findings[{sha, check, message, blocking}]`; `checks[{command, status, failing_tests,
baseline_failing}]` (`status` `passed | failed | unrunnable`); `notes`; `error`
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

`.agentics/config.json {max_parallel}`; `slots/<n>.lock {effort, execution, node}`;
`locks/locus/<fnv1a(path)>.lock {path, node, execution}`; `.agentics/.state/locks/tests.lock`, the
project's full-suite lock. Branch, test and mutex locks are taken by `withLock`: the lock is a directory
holding one holder file, named for that acquisition, `{pid, host, at}`, built beside the lock and
renamed into place, so a lock is never seen without its holder. A holder on this host is broken
exactly when its pid is dead; one from another host after ten minutes. Breaking removes the holder
file it judged, by that name, and then the directory only if that emptied it: a judgement the lock
outran — its holder released, another took it — removes nothing, because a directory with a holder
in it is never empty. A rename onto a lock that is held, or still being released, is refused, and
the taker waits.

### Boundary payloads

- **Owner:** `lib/boundary.mjs`; the launches and the summary are `lib/schedule.mjs`'s.
- **Restated in:** `execute-approved-plan-in-worktrees` (the readers); `test/harness/develop-sim.mjs`.

Every payload: `{boundary, ok, error, todos[{key, subject, activeForm, status}], notes}` plus:

- **preflight** — `invocation`, `checkpoint {reason, detail}`, `said_dir` (where the execution's
  agents write what a record only points at), `stale {nodes, now, list, diff}`
  (null unless the base moved under unruled leaves), `counts {nodes, leaves, gaps, untraced}`,
  `dirty_worktrees`, `max_parallel`.
- **schedule** — `launch[]`, `idle`, `max_parallel`, `records`. A launch is one of
  `{unit: plan, id, why, row}` (its row with the folder's `intent`), `{unit: leaf, id, row, parent
  {id, title, kind, author, spec_path}, facts, waits_on}` (its dependencies and every ancestor's), `{unit: merge, target,
  children[{id, head_sha}], cycles[[id]]}`, `{unit: review, id, row, earned, where {branch,
  worktree, head, base}, children, unreviewed}`. `facts` is the resume ladder's row for the leaf:
  `{id, next_action, branch, worktree, head_sha, base_sha, rounds, brief_path}`. A row is `{id, title, kind, author, rigor, role, provides_n,
  decisions, dispatch, ground_known, rev, spec_path, children_n, own_review}`.
- **leaf-open** — `status` (`opened | no_slot | locus_held | busy | refused`), `branch`, `worktree`,
  `base_sha`, `head_sha`, `rebased`, `brief_path`, `brief_digest`, `report_path`, `slot`,
  `max_parallel`, `held_by[{effort, path, node, execution, status}]`, `stuck`.
- **leaf-close** — `status` (`done | pending`), `node`, `head_sha`, `decision {next, reason,
  failures[{check, claim}]}`, `record` (the path of `closes/<stem>.json`: `{node, role, round,
  head_sha, measurement, decision}` with each failure's `evidence`, `gotchas_written`,
  `gotchas_deleted`, `mutations`, `committed`, `notes`), `committed`. On `fix` it also writes
  `fixes/<node>-r<round+1>.json`, `[{source, check, claim, evidence}]`, which leaf-open reads.
- **merge-batch** — `status`, `target`, `target_branch`, `target_worktree`, `target_base`,
  `merged[{id, merged_sha}]`, `conflict {node, nodes, paths}`, `head_sha`, `verified`, `record`
  (the path of `merges/<target>-<pre>.json`, with the measurement and each failure's evidence),
  `failed_alone[{id, ids, failures[{check, claim}], row?, parent?, facts?}]` (the row, the
  parent's row and the resume facts for a single leaf, whose fix round launches from them and
  whose `fixes/` file merge-batch writes),
  `combination[]`, `drift[{node, contract, files, spec_path?, stopped?}]` (a node not yet merged
  whose consumed contract the merge touched; `stopped` names its escalation or park, which the
  drift is reported beside and never parked over), `drift_diff` (the path of the merged change to
  the files an unstopped consumer consumes, or `''`), `unexamined_n` (undesigned nodes drift could not check).
- **suite-gate** — `status` (`done | pending`), `target`, `head_sha`, `ran`, `passed`,
  `failures[{check, claim}]`, `record` (the path of `gates/<target>-<head>.json`, with the
  measurement and each failure's evidence; `''` when nothing ran).
- **postflight** — `summary {nodes_n, leaves_n, merged_n, not_merged_n, blocked_n,
  blocked[{blocked_by, leaves_n}], root_status, root_done, done, stopped[{id, status, reason}],
  held[{id, behind}]}`, `integration {branch, head_sha}` of the execution's root, `cleanup_n`,
  `unmerged_n`, `closed`, `records`.
- **spec-check** — `node`, `spec_path`, `exists`, `hash`, `decisions_n`,
  `problems[{file, line, problem}]`: a planner-written spec, checked with its ancestors' decisions
  in view.
- **spec-settle** — `recorded`: the dispositions appended, `by: planner`; one already in the
  ledger for that folder is not appended again.
- **spec-reviewed** — no fields beyond the common ones: it appends the round's `reviewed` ledger
  line (`complete`, `remaining`, `ambiguities`).
- **spec-gate** — `ratifiable`, `open`, `coverage_complete`, `reviewed`: the `approvalGate` of the
  folder's spec as it stands.
- **spec-prepare** — `status` (`prepared | refused`), `hash`, `compile {ok, problems, written_n}`
  (of the `compileEffort` result), `problems`, `row` (the prepared node as compiled, which is how a replan learns whether
  it changed the node and whether it planned anything beneath it). A `spec_changed` park its compile raises on the prepared folder is cleared
  by a `replanned` event, reason `spec_rederived`.
- **land** (the session's, plain JSON) — `check`: `open_escalations`, `parked`, `human`,
  `drift {base_sha, base_moved, commits, overlap}`, `root_status`, `root_claims`, `landing`;
  `merge`: `merged_sha`; `cleanup`: `removed`, `kept`.

### Replanning returns

- **Owner:** `EXECUTOR_STATUSES` in `execute-approved-plan-in-worktrees`; `EXECUTOR_STATUSES` in `lib/brief.mjs`.
- **Restated in:** `agents/implementer.md`, `agents/test-author.md`, `agents/planner.md`.

`done | done_with_concerns | blocked | needs_context | decompose | unsplittable | premise_mismatch
| needs_decision | contract_changed`, with `detail` saying what was established, tried and needed.

### Coverage block

- **Owner:** each workflow's result builder (`result()` in `execute-approved-plan-in-worktrees`, `coverageOf` in
  `gather-evidence-without-concluding` and `search-for-existing-solutions-before-building`, inline in `attack-document-with-independent-reviewers` and
  `answer-codebase-question-from-evidence`). The `coverage-block` lint rule requires one on every exit.
- **Restated in:** the skills that walk a result.

`complete` (computed, per workflow; for `execute-approved-plan-in-worktrees`: no checkpoint, every leaf in scope
merged, the root integrated, nothing escalated or parked — carried from an earlier invocation or
not — and no earned integration review or survey lost), `dropped[]`, `incomplete[]`,
`failed_channels[]`, `unreached[]` (prose, loss first), `resumable {runId, remaining, args?}`.

### Evidence item store

- **Owner:** `lib/evidence.mjs` (`checkItem`, `recordItems`, `recordJudgement`); written through
  `lib/ledger.mjs appendProject`, which mints a project-wide `seq` under `.agentics/.state/.lock`.
- **Restated in:** the item builders of `gather-evidence-without-concluding`, `attack-document-with-independent-reviewers` and
  `search-for-existing-solutions-before-building`, and the survey's copy of `ITEM_KINDS`.

`items.jsonl` holds `{kind: 'item', item, seq}` and `{kind: 'judged', id, verdict: holds|fails|unsure,
at, seq}` (a `holds` that could not be re-anchored is stored as `unsure` with `requested` and
`why`). An item is `{id, question, topic, ground[], kind, claim, spans[{path, start, end, at}],
queries[{pattern, scope[], result[{path, text}]}], sources[{url, version, retrieved}], rests_on[],
detail?, from_return}`; `at` is a commit sha or `snapshot:<hash>`. Raw returns sit in
`returns/<stamp>[-<n>]-<kind>.json` (`survey`, `probe`, `solutions`, `approach`; an `approach`
draft or a clean `probe` round carries no items), spec snapshots in `snapshots/<hash>.txt`. The
CLI (`record`, `items`, `judge`, `review-scope`, `cite`) prints an envelope; `record`, `items`,
`judge` and `review-scope` take `--root <checkout>`, the checkout whose tree they read, the main
checkout by default.

### Cites

- **Owner:** `lib/evidence.mjs recordCites`; read by `lib/render.mjs renderEvidence`.
- **Restated in:** the `effort-store` verbatim block.

`cites.jsonl` in an effort's `.state/` holds `{kind: 'cites', folder, items[], gaps[],
renamed_from?, seq}`. A folder's latest line by `seq` is its whole citation; `latestCites` reads
each folder's. `renameSubEffort` appends a copy of a renamed folder's latest line under its new id,
with `renamed_from`.

### Workflow returns

- **`execute-approved-plan-in-worktrees`** — takes `repo, effort, root, execution, intelligence, pace, plan_only,
  pause, progress, retry_escalated, confirmed_duplicate, confirmed_gaps, base_ref,
  commands, plugin_root`. Returns `{effort, root, execution, checkpoint, nodes_n,
  implemented[{id, rigor, role, rounds, review_rounds, at_integration, salvaged}],
  escalations[{id, reason, detail, said?}], parked[{id, return, question, said?}], faults[{id, channel, detail}],
  blocked[{blocked_by, leaves_n}], integration{branch, head_sha, reviews[{target, findings, claims, notes, reviewed}]}, drift, cleanup_n,
  cost{dispatches, by_model, tokens}, stopped, notes, coverage}`. `coverage.unreached` names every
  stopped node and counts the rest; `coverage.resumable.remaining` names the execution's root,
  because a relaunch with the same stamp re-derives everything below it.
- **`gather-evidence-without-concluding`** — takes `question, roots, notes, prior, max_topics, intelligence, pace,
  plugin_root, ground`. Returns `{question, topics, ground, items, reused, unrecorded,
  risks[{topic, text}], history, docs, coverage}`: reused standing items first, then new ones in
  plan order, each with its `id`.
- **`attack-document-with-independent-reviewers`** — takes `artifact, roots, context, plugin_root, max_derived_axes, per_axis,
  since`. Returns `{artifact, axes, axes_dropped, analysts, shared_ground, guidance_read,
  repo_ground, findings[{axis, severity, section, claim, evidence, start, end, id, item, carried}],
  ambiguities, ratifiable, snapshot, scope{full, changed}, unrecorded, review, coverage}`.
- **`search-for-existing-solutions-before-building`** — takes `capability, roots, constraints, notes,
  max_angles, intelligence, plugin_root`. Returns `{capability, constraints, frame,
  already_present, candidates, viable, ruled_out, items, unrecorded, unanchored, coverage}`.
- **`answer-codebase-question-from-evidence`** — takes `question, roots, notes, as_tasks, intelligence, pace,
  plugin_root`. Returns `{question, mode, tasks, report, evidence, coverage}`; `evidence` is
  `{items, risks, history, docs}` when synthesis failed and the survey's work is handed back, null
  otherwise.

### Review returns

- **Owner:** `FINDINGS` in `execute-approved-plan-in-worktrees`.
- **Restated in:** `agents/reviewer.md` (the verdicts, and when a review returns them).
  `skills/task` asks its own reviewer for `{findings, fix_verdicts, notes}` only.

`{findings[{id, severity: critical|major|minor, claim, evidence, failure_scenario}],
fix_verdicts[{id, status: fixed|not_fixed|regressed, evidence}], claims[{claim, verdict:
met|under|over|deviates|spec_defect|cant_tell, evidence}], notes}`. A leaf review returns
`claims: []`.

### Planner returns

- **Owner:** `PLANNED` and `SETTLED` in `execute-approved-plan-in-worktrees`.
- **Restated in:** `agents/planner.md`.

Writing a spec: `{status: written|needs_decision|contract_changed|premise_mismatch|unsplittable|blocked,
written[], accepted_warnings[], uncovered[], question, detail}`, with the spec's path in
`written`. Settling a review: `{status: settled|needs_decision|blocked, dispositions[{finding,
outcome: incorporated|discarded}], question, detail}`.

---

## Self-checks

- **Lint** (`tools/lint.mjs`, one module per rule under `tools/rules/`) checks form: no
  counter-based termination, a coverage block on every exit, no verdict fields in agent schemas, no
  schema bounds, no imports in workflows, namespaced agent types, valid workflow `meta`, agent
  frontmatter, gate clauses in gated skills, a stated task-tool fallback, and size budgets.
- **The scenario harness** (`test/harness/workflow-host.mjs`) runs the real workflows with scripted
  agents; `test/harness/develop-sim.mjs` answers `execute-approved-plan-in-worktrees`'s boundaries from an in-memory
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
- **Migration:** `tools/migrate-legacy.mjs` is the one-shot copy of a repository's 3.2.0 layout
  into `.agentics/`: each effort's files into its `.state/`, its design documents into its
  `.legacy/`, and its slot configuration into `config.json`. It never deletes: it lists the
  committed files it copied for the user to remove, and a second run copies nothing. Nothing
  reads the old layout.

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
