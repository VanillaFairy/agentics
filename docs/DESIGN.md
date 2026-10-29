# agentics — design

This is the design of agentics as it stands. It describes the system that runs; git holds how it
got here. Where a rule is not self-evident, a **Why** paragraph gives the reason in as few
sentences as the reason needs.

Reading order: the Laws bind everything and have no exceptions, and each names the mechanism that
enforces it. The Principles decide every question the laws leave open. Everything after them is
the design those two produce.

**When the code and this document disagree, the code is right and this document has a bug.** A
behaviour-changing change updates this document in the same commit series (`CLAUDE.md`).

---

## What the plugin is

agentics is a Claude Code plugin for designing, investigating and building changes in any
codebase. Code decides what happens next; models are called only for the steps that need
judgment.

| Directory | What lives there |
|---|---|
| `skills/` | The commands a user invokes and one hidden service step (see [Skills](#skills)). |
| `lib/` | Node modules and CLIs for everything deterministic: the store, the tree, the runner, and the session's calls (`lib/boundary.mjs`). |
| `lib/boundaries/` | The boundaries an execution calls in-process, each recording what it decides (see [Boundaries](#boundaries)). |
| `lib/programs/` | The programs that orchestrate: an execution, a survey, a probe, a solutions sweep, an investigation, a ruling, approach drafts, an inline review (see [Programs](#programs)); the execution's units live in `lib/programs/execute/`, and the `search` every searching program calls, with what its result means to a program, in `lib/programs/search/`. |
| `lib/search/` | What a search is made of ([Searches](#searches)): the query dialect, the tree tools, the tool server and the pinned tree. |
| `lib/briefs/` | The prompts the programs build, one file per program: the execution's (its reviewers, integration reviewers, rulers, planner and investigator; a leaf round's thread brief is `lib/brief.mjs`'s), the survey's, the probe's, the solutions sweep's, the search's (a scout's charge and its resume brief), the drafts', the inline review's, the investigation's and a ruling's (see [Briefs and returns](#briefs-and-returns)). |
| `roles/` | One file per agent role: its instructions, tools and kind (see [Roles](#roles)). The host never loads them as agents: only the runner starts one. |
| `tools/` | `lint.mjs`, its rules under `tools/rules/`, `budgets.json`, and the one-shot migrations. |
| `test/` | The `node --test` suite, including the scripted runner; `test/fast/` holds the tests that spawn no process. |

**Programs are code with the filesystem.** A program reads and writes the store and git itself,
calls every deterministic step as a function, and starts every agent itself through one runner
(`lib/runner.mjs`), which launches a headless Claude Code session per dispatch and stores what it
returns. No model carries another program's output, and no session starts an agent
([Runtime](#runtime)).

### What it writes in a target repository

| Path | What it holds |
|---|---|
| `.agentics/<effort>/` | One effort: a `DESIGN.md` per folder, and its `.state/` — nodes, events, ledger, evidence, gotchas, executions and locks ([Storage](#storage)) |
| `.agentics/.state/` | What every effort shares: the slot pool, the evidence pool and program runs outside an execution |
| `.agentics/config.json` | The project's settings, edited by the user (`max_parallel`, `max_agents`, `claude_cli`, `guidance`, `design_spend_multiple`) |
| `.claude/worktrees/` | Integration and leaf worktrees, the throwaway worktrees of an inline review and of an execution's investigator while they run, and the trees an execution's searches are pinned to (`search-<effort>-<sha8>`) |
| `refs/agentics/review/<run>` | An inline review's snapshot of the working tree, kept as the record its result names ([The simple task](#the-simple-task)) |

Everything under `.agentics/` and `.claude/worktrees/` is local to the machine. `.agentics/`
sits in the main checkout, where a writer in a linked worktree also lands, and it ignores itself:
every directory made under it goes through `lib/store.mjs mkdirState`, which writes a
`.gitignore` of `*` at its root, whatever the target repository's own ignore rules say. Specs are
the user's documents but not the project's docs: carrying what an effort decided into the docs is
a plan entry of its own.

### How the plugin checks itself

The runtime artifacts are prompts and code, so they are checked in layers — detailed under
[Self-checks](#self-checks): lint judges form, the programs run against real git with a scripted
runner, an opt-in contract test runs the real host, real-git tests run every boundary, and pins
keep restated contracts, allowlists and design pointers from drifting. Run everything with
`node tools/lint.mjs && node tools/suite.mjs`, or just the spawn-free tier with
`node tools/suite.mjs --fast` (see [Self-checks](#self-checks)).

---

## Laws

Four laws. Each names the mechanism that enforces it, and says so where a mechanism stops short;
a law without a mechanism is a defect, and `test/fast/design-doc.test.mjs` fails a law whose section
names none.

### L1 — Honest state

Everything shows exactly how complete it is. A producer's or judge's return states what it covered
and what it did not reach; a search's coverage is code's own record: its status from the runner and the
loop guard, its journal's calls and hits, and its rounds, with the scout's own word on what it
skipped carried beside them as the scout's ([Searches](#searches)); and "looked and found nothing" never merges
with "never looked": a name that resolves to nothing, a return that is not there, a unit nobody
ruled on reads as absent or open, never as empty or passed. Work is in one of three states: **in progress**; **escalated**, carrying
what was established, what was tried, what remains and how to resume; or **done**, every unit of
its intent traced to work and to a passing check ([Traceability](#traceability)). Nothing reads as
more complete than it is, and what stays incomplete leads every report.

*Enforced by:* the `coverage-block` lint rule (every program result computes `complete` from its
fields); `searchCoverage` and `coverageLine` in `lib/programs/search/consume.mjs`, which write each
search's coverage line from its status, its journal's calls and hits, its rounds, its why and the
scout's own word;
`resolveHandle` in `lib/store.mjs`, the one way a CLI turns an argument into a thing, which refuses
an unknown one as `unknown_<kind>`; status derived on read (P3); an integration branch holds no
commit no record accounts for (`outside_work`: `unaccountedOf` in `lib/integration.mjs`, which
preflight reads before anything runs and the adopt check reports, [Outside work](#outside-work)).

### L2 — States end work, counts don't

Work escalates on a state, never on a count. The states are three: a decision only the user can
make; a claim an independent ruling (L3) finds cannot be met as written; and no progress — the
same state again, or an independent ruling that a loop is not converging. A count may decide when
to ask; it never decides the answer. Code sends a producer back for more work through one guard
(`sendBack` in `lib/boundaries/loop-guard.mjs`), over the node's send-backs since it was last
cleared — its latest replan, a retry among them, or its own revision. The guard stops a loop on
one of three states: work sent back at a head the node was already sent back at, returned unmoved;
the same failures as the kind's last send-back at a moved head; or an exact state any earlier
send-back of the kind held. Each send-back records the state it was sent in (`guard`), so the
next is compared by what the records hold. A lossy state — failures keyed with their lines dropped —
that recurs after other ones stops nothing by code: it asks the leaf's convergence ruler at once.
Every third round of a leaf sent back since it was cleared, by any kind or by a review's findings,
is ruled the same way before it opens, so a loop that trades a failing check for a review finding
is one loop ([Executors and review](#executors-and-review)). A search ends on a round of its scout that stops widening it — one that hits fewer than two new
places (a file, commit or URL no earlier round hit) — on a round whose scout declares nothing left unsearched with its guard quiet,
or on a round the host or a dollar budget the user set stopped. The guard's window is the one count in a search: a stall detector the
tool server owns, never a cap on calls that find something new. An external stop — a usage limit, a host error, a crash, the user — leaves work in progress, resumed from the records.

*Enforced by:* the `no-turn-caps` lint rule (no turn or spend cap on a dispatch, over the programs,
the execute program's units, `lib/search/`, `lib/run.mjs`, skills and roles); the `no-loop-bounds`
lint rule (no loop in a program, `lib/search/` or `lib/run.mjs` that a counter ends — a condition, or
an `if` that leaves the loop, comparing a counter the loop increments to a number, a SCREAMING_CASE
name or a `max`/`limit`/`cap` name), the guard's `STALL_WINDOW` its one named exemption; the
convergence predicates in `lib/verdict.mjs`, which compare states; `sendBack` in
`lib/boundaries/loop-guard.mjs`, and the `send-back-guard` lint rule, which lets no other code build
a message that hands a producer more work; `handle` in
`lib/search/server.mjs`, whose loop guard refuses a session's tools once `STALL_WINDOW` calls in a
row showed nothing new; `askAfter` and `rulingDue` in `lib/programs/converge.mjs`, which schedule
a leaf's convergence ruling; the runner's classification of host failures as stops, and its terminal `budget` class,
which `dispatch` does not wait out ([Host stops](#host-stops)).

### L3 — Separate judges

An **observation** is what code can recompute from the records and git: an exit status, a
digest, two states being equal, the set of units a return addresses. A **ruling** is a judgment.
No agent rules on its own work: every ruling, including that a search is complete, comes from the
user or from an agent that did not produce the work, and states what it covered. A ruling is not
itself ruled on; its coverage is shown as declared. Code combines observations and rulings into
every **verdict**, counts a unit nobody ruled on as open, and never stands in for a ruling. No
agent approves anything. A producer may **declare** — that it is done, that its search found what
there is — and a declaration may steer what runs next, but it never reads as a ruling and never
enters a verdict.

*Enforced by:* the role table ([Roles](#roles)), where every role is a producer, a searcher or a
judge, and `dispatchJudge` in `lib/programs/common.mjs`, which refuses to put a unit before the
session that produced it or any session of its thread; the `no-self-verdict` lint rule over
`lib/schemas.mjs` (producer and searcher schemas carry no ruling fields, and a judge's schema rules
per unit); `verdictOf` in `lib/verdict.mjs`, where approval is every unit ruled and none ruled
blocking; a search, the one place a producer ends its own work: a scout round that stops widening the
search, or whose scout declares nothing left unsearched, is a declaration that ends the search and can make a program's coverage complete, and never enters a
verdict; its hits are judged where they are consumed — by the probers, the survey judges, the
assessor and the reviews ([Searches](#searches)).

**Why:** an agent that certifies its own work is the examinee marking the exam, and an empty list
of findings from a reader who looked at nothing is not a pass.

### L4 — The user owns decisions and their branch

The user is the only author of design decisions; an unanswered recommendation is not adopted, and
no replan may alter a decision the user made. The user answers a question once: what they chose is
recorded in their own words, and a choice they made is never put to them again. Only the user gives
a spec its first approval; a later change to an approved spec is approved without a further act of
theirs only when an independent ruling finds that everything it moves either is not moved at all or
is settled by an answer they recorded ([A changed spec](#a-changed-spec)), or, for a one-shot
migration, when code checks the change declares the Design citations the reader of the time took a task's text to make and, once compiled,
hands every brief the text it had: the signature is then stated again at the new hash, as it was
given, and the migration compiles it ([Migrations](#migrations)).
The user's branch and
working tree change only by their explicit act: an inline task edits only the files it was asked to
edit; dispatched work happens on branches and worktrees the framework owns and reaches the user's
branch only at landing, on their explicit go, with no open escalation.

*Enforced by:* `verifyAnswer` in `lib/host.mjs`, which `approve`, `land --action merge`
(`landAct`) and `adopt --action act` (`adoptAct`) call, and which refuses unless the user's answer
chose that act for that folder or effort at that hash ([The user's word](#the-users-word));
`answerTo` in `lib/host.mjs`, through which `lib/answers.mjs record` keeps an answer only as the
session's transcript records it; `respecSettle` in `lib/respec.mjs`, which approves a change
without a further act of the user's only when no unit is ruled `affected`, and for which each of
the user's choices the change makes — a Decisions row added, changed or removed, a contract a
provider changed, a `needs_decision` or `contract_changed` park cleared — is a unit no ruling may
call `unaffected`, settled only by an `answered` ruling citing an answer the brief held; `decisionProblems` in `lib/tree.mjs`,
which admits a decision only from compile, as the approved copy states it, and refuses a replan
that changes a contract or drops a realised decision; the runner's confinement of every agent to
its worktree, its role's writes and its commands, and its watch on the user's checkout
([The agent runner](#the-agent-runner), [Role rules](#role-rules)), with the series' `role-breach`
behind it; `declare` in `tools/migrate-design-cites.mjs`, which carries a signature only over
declarations it proves hand every brief the Design text it had; `lib/verify.mjs`, which refuses to run outside
a linked worktree; `land`, which refuses over an open escalation, a park or a dirty tree.

---

## Principles

Five principles. They decide what the laws leave open; when two pull apart, P1 decides.

### P1 — Fidelity at the chosen level, then cost, then time

The objective is ordered: (1) the work reflects the spec and the intent, at the intelligence
level the user chose for each task; (2) at the lowest total cost that keeps it; (3) in the least
wall-clock time that does not raise cost, unless the user chose to buy speed (`pace: fast`). When
two principles pull apart, take the outcome this order ranks higher; a tie goes to the user.

- **Parallelism of disjoint work** costs no extra tokens and is taken, up to the slot pool.
- **Parallelism over shared context** multiplies cost. It is bought for independence (L3:
  separate approach drafts, separate probers, a test author who never sees the implementation's
  code) or when the user set `pace: fast`.

`pace` (`frugal` | `balanced` | `fast`, default `balanced`) is read by the evidence programs when
they decide how many readers share a body of evidence; an execution passes it to the surveys it
buys.

### P2 — Code does what is deterministic; models only judge

Anything computable is computed in `lib/`: schedules, partitions, briefs, excerpts, digests, merges,
verdicts, records, whether evidence still stands. Between programs, code moves the bytes: a program
puts a model's brief in its prompt and takes the result from its return, and no program waits on a
model to carry another program's output. A model hands on only what it authored itself. Where a
model must name something for a program — a session typing a folder on the user's behalf — the
program resolves the name or refuses it (L1). A lib CLI a skill's session calls takes handles only —
a path, an id, a sha, an enum, a number, a short token — and free text only under a flag it names
free text (`--about`, `--title`, `--text`, `--gap`, `--notes`, `--context`, `--constraints`,
`--reason`, `effort.mjs slug`'s words), one line of at most 300 characters; anything longer is a
file the session wrote with its Write tool, passed by path under the flag's `-file` twin instead
(`--about-file`, `--title-file`, `--text-file`, `--gap-file`, `--notes-file`, `--context-file`,
`--constraints-file`, `--reason-file`; `slug --about-file`), which lib reads whole. Giving a text
by both its flag and its twin is refused (`bad_args`; `bad_arg` from `run.mjs`), a twin naming no
file `unknown_file`, and the refusal of a text past its line names the twin, never a path to put in
the flag. A CLI refuses any other argument with `args_unreadable` before it reads or writes
anything, and an unknown flag with `unknown_flag` — except `run.mjs` and `boundary.mjs`, which
refuse an unknown flag as `bad_arg` (below, and [Session calls](#session-calls)): `handleArgs`,
`argProblem` and `textFlag` in `lib/store.mjs`, each CLI declaring its flags' kinds once. A
conclusion or any other text a session hands a program beyond one line goes as a file
(`survey --prior-file`, `--read-file`, `--question-file`, `--criteria-file`, …), never as a flag's value.

When code must slice prose, the spec names the slice by a structural handle (a Design part a task
`cites` or a `provides` declares, [Spec format](#spec-format)). Code resolves it exactly or refuses.
An undeclared slice is the whole. A pattern over prose or model text may refuse or widen, never
narrow. Model text is matched only as an exact handle or a typed field (a producer's `unread`
entries, [Producer returns](#producer-returns)).

**Why:** a model that retypes bytes is slow, costly and lossy in proportion to their length, and
a checksum over what it typed only turns the loss into a retry. A pattern that narrows drops,
silently, whatever its author did not foresee; one that refuses or widens fails loud or costs only
context.

### P3 — State is derived; records are written as things happen

The status of a node, an execution or an effort is computed from append-only records and git on
every read; no status is stored and nothing trusts a rendered one. A record is written by the code
that ran or received the action, when the action completes, and records are ordered by a `seq` the
ledger mints, never by a clock. Resume names the single next undone action per node, trusting a
stage only where the record and git agree. What a session learns about a node is a `noted` record
like any other, and no status is derived from it.

A node is **cleared** at the later of its latest `replanned` event — a retry, an answer, a
re-derivation, a revision — and its own revision (`clearedAt` in `lib/tree.mjs`, the one reader of
it): a stop, a standing review, a loop's history, a journalled measurement or a plan from before it
answered a question the user's word or a new plan has since re-asked. A `brief_changed` message
clears nothing: it is code telling a resumed thread its context moved, never the user's word on the
node.

A replay identity is the question code puts to a judge (a digest of its observations) plus where the
node it rules on was cleared, wherever the user's word may re-ask the same observations: a contention
or conflict ruler's thread (`judgeThread`), a merge-batch's identity, the standing of a `judged`
ruling, the cut-off of a journalled measurement. Content-addressed caches — anchors, surveys, probe
steps, a measurement's key — take no clearing, and nor do the threads a retry resumes on purpose: a
leaf's producers, its reviewers and its convergence ruler. A ruling recorded from a dispatch stands
exactly while a record with the same `said` does: the same dispatch replayed lands nothing, any other
ruler's lands. A decision that outlives a unit's settle comes from records. Only what is in flight in
this process lives in memory.

**Why:** a record written after the fact by someone else leaves a window where work exists and
nothing says so; a status written down outlives what it described.

### P4 — Everything earns its place

Every mechanism — a stage, a dispatch, a role, a model tier, a field, a record kind, a check —
names the property that earns it and the consumer that reads it, and goes when its consumer goes.

- **Leanness is legible.** Whatever ran says what earned it; whatever did not run is stated. Cost
  is reported measured, never as a projected constant.
- **Leanness never touches verdicts.** What shrinks is dispatches, tiers and phases; the
  predicates a verdict is computed from never shrink once a check runs. Tests are the one input a
  check may lose: a cycle's consolidation round retires tests the cycle approved, and it is
  approved only while every break it declares and every break the cycle's audit held still bites
  ([Rigor](#rigor)); otherwise it is reverted.
- **No mechanism outlives its consumer.** A format change ships a one-shot migration, never a
  permanent second reader: a store stamp, and a frozen migration that rewrites the records
  ([Migrations](#migrations)). `test/fast/liveness.test.mjs` enforces it ([Self-checks](#self-checks)).

### P5 — Faults are fixed in their class, where they live

Prevent where a capability can; detect where it cannot; and every fault that can be detected has
a way to be corrected. Name the fault's class and apply its remedy where the fault lives, with the
cheapest sufficient instrument: a deterministic check, then a fresh agent, then the user. A limit
is designed away, never squeezed past. A new stage, grade or rule is a last resort.

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
- **`.state/`**: machine state, written only by code: an effort's `.state/` (nodes, events,
  ledger, executions) and the project-wide `.agentics/.state/` (slots, program runs, evidence
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
  across the effort; an entry below its promiser may deliver it there, at its paths or under them.
- **approved**: the spec's current hash equals the hash on its latest `approved` ledger line,
  written only once the user's answer chose to approve it. **prepared**: the same against a
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
- **claim ruling**: `met`, `equivalent` (same behaviour, another name or shape) or `accepted` (the
  session's call on a drift) pass; `under`, `over`, `deviates` (drift) park when they name what
  goes wrong, else wait for landing; `spec_defect` (can't be met as written); `cant_tell` (the
  evidence doesn't decide it, never a pass, waits for landing).
- **observation, ruling, declaration, verdict**: an observation is what code can recompute; a
  ruling is a judgment, made per unit by the user or by an agent that did not produce the work; a
  declaration is a producer's word about its own work, which may steer what runs next but never
  passes anything; a verdict is what code computes from observations and rulings.
- **unit**: what one ruling is about: a criterion, a changed file, a spec claim, an axis against a
  section. A unit nobody ruled on is open.
- **dispatch, session**: a dispatch is one call to an agent; its session is the host's
  conversation it runs in, which code may resume later with a message.
- **evidence item**: one claim with the anchors it rests on: spans, queries, sources, or other
  items. Its state is derived on read: **standing** (no anchor changed, or it was re-judged as
  holding), **suspect** (an anchor changed and nobody has judged the change), **stale** (judged as
  failing, expired, or resting on a stale item).
- **park**: a node stops and waits for the user. The answer, recorded once, is a re-spec: edit the
  specs it reaches, have each ruled against it, recompile.

**The laws.** L1: honest state. L2: states end work, counts don't. L3: separate judges. L4: the
user owns decisions and their branch. **The principles.** P1: fidelity at the chosen level, then
cost, then time. P2: code does what is deterministic; models only judge. P3: state is derived;
records are written as things happen. P4: everything earns its place. P5: faults are fixed in their
class, where they live. **And four rules for specs:** no status goes into a spec and no render is
edited by hand; one writer per folder at a time, under the effort lock; when an effort changes
what the project's docs describe, its plan carries the entry that updates them; a value nobody
chose (a delay, a weight, a count) is written `default <value>`, and a default is not a claim.
<!-- /agentics:verbatim -->

---

## Runtime

### The process model

```
user ⇄ session ── skills: design, develop, task, investigate, challenge-idea, next, self-improve
          │           talks to the user, edits specs with them, calls lib CLIs;
          │           every name it types is resolved or refused; it starts no agent
          ▼
     lib/run.mjs ── starts a program, attached or detached
          │
     program ───── lib/programs/*: reads and writes the store and git, calls the
          │         boundaries as functions, schedules, records as it acts
          ▼
     runner ────── lib/runner.mjs: one headless Claude Code session per dispatch,
          │         started or resumed by id, confined, schema-checked, measured
          ▼
     agents ────── roles/*: judgment only; each returns typed output; none
                    addresses another (messages are routed by code: Conversations)
```

A session is where the user is: it asks, it shows, it edits a spec with the user, and it calls
lib. A program is where the work is orchestrated: it never asks the user a question; a question for
the user becomes a park or an escalation the session's watch picks up ([Progress](#progress)), and
an answer the user gave reaches a program only as the `answered` ledger line the session recorded
([The user's word](#the-users-word)). An agent is where judgment happens, and nowhere else.

A program's process carries every live call's stream on one event loop. Git that runs once, O(1),
stays inline, so the work between two awaits stays atomic over worktrees and refs; work whose git
count grows with its input runs off the main thread: a check in a child the program awaits
(`lib/measure.mjs`), and a leaf brief's evidence and a probe round's review scope, whose anchor
checks run git per item, and the planner's compile preview, which reads every spec of its folder, on the one long-lived offload worker (`offload` in `lib/offload.mjs`), a
worker thread started on first use and kept warm. There is no in-process fallback: a request the
worker cannot answer rejects, and its unit faults (`program`), never a silent stall; a git it
killed at its ceiling rejects as `GitHung`. A probe round's carried findings are handed to
`recordProbe` rather than checked again. The main thread watches every request in flight
(`watchdog`): one running past 15 seconds since the worker started it — the worker says when it
does, so a request queued behind a slow one is not counted — is recorded `stalled {label, since}` in
the run's log while it still runs, which the watch prints.

Only `lib/store.mjs` starts git (`gitSync`, `gitAsync`, `readBlobs`; the `git-spawn` lint rule), under
one held environment and one ceiling, `GIT_CEILING_MS`, ten minutes. The ceiling is a hang detector,
not a budget ([L2](#l2--states-end-work-counts-dont)): git on a large or scanned repository takes
seconds or a minute, and one still running at ten minutes waits on something nobody will answer. A
synchronous git past it is killed and throws `GitHung`, so no caller reads a killed git as an answer;
an awaited one resolves failed with the same message. A hang is the environment's, never a fault of
the plugin's: in an execution the unit's node is held for the run by a `git_hung` stop, which the
session relaunches past, and the same hang (the same git, at the same head of the node's branch) on
the node again since it was cleared escalates `git_hung` as no progress (`hungRecords` in
`lib/boundaries/records.mjs`); a run outside one records it on the `git_hung` channel. No catch
reads a hang as an answer (`rethrowHung` in `lib/store.mjs`): the leaf unit rejects with a `GitHung`
its catch-all would otherwise record as a `program` fault, a ruler's throw on a moved base or on
adopted work holds its nodes by `git_hung`, and leaf-close's read of the worktree takes a refusal,
never a hang, for an empty unborn worktree. A check's own reads and its watch let a hang through,
and a hang inside the check's child comes back typed and is thrown again (`measure`, [Verify
payload](#verify-payload)), never an `environment_broken` measurement. The runner's watch on the
user's checkout throws a hang where it would fail the call `watch_failed` — after the call, once the
call's end and the return it paid for are kept — and a step a program reports lost when it fails
(a draft's record, the survey's read of its pool, the solutions' record) is no loss on a hang.

### Programs

A program is an async function over three ports: the store, git and the runner. A test hands it
real git and a scripted runner ([Self-checks](#self-checks)). `node lib/run.mjs <program> [--repo
<checkout>] [--root <checkout to read>] [--detach] [--<arg> <value>]…` is its CLI: it resolves its
arguments (P2), claims the run for the program's scope, records `run {program, scope, pid}` and
runs it in this process, or with `--detach` in a child that outlives the call, printing the run's
id, pid, log path and result path at once ([Detached runs](#detached-runs)). A program's result is
a JSON file in its run's home ([Run directory](#run-directory)), carrying a coverage block
([Coverage block](#coverage-block)); the session reads it.

| program | does | started by |
|---|---|---|
| `execute` | runs an execution over a subtree: plans, dispatches, measures, reviews, merges ([Execution](#execution)) | develop |
| `survey` | gathers evidence for one question and never concludes ([Survey](#survey)) | design, the `investigate` program, and `execute` for a node whose ground is unknown |
| `probe` | attacks a written artefact ([Probe](#probe)) | design, challenge-idea, and `execute` for the autonomous review |
| `solutions` | searches for existing solutions before a capability is built ([Existing solutions](#existing-solutions)) | design, search-for-existing-solutions-before-building |
| `investigate` | answers a question from evidence ([Investigations](#investigations)) | investigate |
| `rule` | rules a changed spec and settles it ([A changed spec](#a-changed-spec)) | develop, design |
| `drafts` | writes approach drafts, one per assigned stance, and records each ([Design](#design)) | design |
| `review` | one fresh review of an inline task's change, its exit computed ([The simple task](#the-simple-task)) | task |

The programs share their dispatching code (`lib/programs/common.mjs`): `dispatch` and
`dispatchJudge` over the runner, `deliver` for messages, `step` for side effects and `coverageOf`
for the coverage block, beside `askAfter` (`lib/programs/converge.mjs`) for convergence rulings and
`search` (`lib/programs/search/search.mjs`) for searches. A dispatch may carry a `charge`, written
after the role's body as its system prompt, and an `mcpConfig`, the tool server the host starts for
it. A program run keeps at most `max_agents` agent calls open at once (`.agentics/config.json`,
default 6), beside the slot pool that bounds leaves ([Scheduling](#scheduling)). A program nested in
another — an investigation runs its survey — shares the run's context: one log, one `max_agents`
bound, one result. Nested in an execution — a folder's survey, the probe rounds of its autonomous
review — it runs `scoped` (`scoped` in `lib/programs/common.mjs`): every thread name and step key it
mints carries its unit's prefix (`survey:<folder>:<basis>/`, `probe:<folder>:<n>/`), so two folders'
nested runs never share a thread or a step.

**Why programs:** orchestration is deterministic, and deterministic work belongs to code that can
read the records it decides from. An orchestrator that cannot read the disk needs a model to carry
every lib result to it, and that carrying is the work P2 gives to code.

**Whoever decides a dispatch** — a program's author, or a session — works to this:

<!-- agentics:verbatim dispatch-economy -->
A dispatch costs context × turns, and every agent pays its own. Tool calls are what make turns;
parallel agents share only the system prompt, so a prompt body handed to four agents is paid four
times; and what an agent returns is re-read on every later turn of the session that dispatched
it.

- Grant tools only where the charge needs the tree. A question answerable from what you hand over
  goes to an agent without tools and comes back in one turn.
- Resolve evidence several agents need once — by script wherever that is deterministic — and hand
  each agent the excerpts inline: never a path to go and read, never a whole source file.
- Prefer fewer agents with disjoint charges. Split by head only where independence is the point,
  and say that it is.
- Ask for a typed return on a fixed shape. Narrative is context you pay for until the session
  ends.
- To check a change, re-dispatch narrowed to what changed and name the narrowing in coverage.
  Never re-run the whole pass.
<!-- /agentics:verbatim -->

**Arguments.** A program declares each argument it takes, with its kind, its default and whether
it is required; `lib/run.mjs` reads it from `--<name>`, an `_` in the name written `-`, and hands
the program the resolved values:

| kind | given as | resolved to |
|---|---|---|
| `file` | a path, absolute or from the working directory | the absolute path of an existing file, and its text — read through `readText` (LF line ends, no byte-order mark), trimmed — under the name the program asks for, so a file's line endings never change a run's arguments or its scope |
| `text` | a string | the string; its `<name>_file` twin (a `file` argument whose `as` names it) gives it from a file, and giving both is `bad_arg` |
| `list` | `a,b,c` | the entries, trimmed, empty ones dropped |
| `int` | digits | a non-negative integer |
| `bool` | the flag alone | `true`; absent, `false` |
| `enum` | one of the program's values | that value |
| `effort`, `folder`, `run` | a name | the name, once `resolveHandle` finds it (a folder inside the `effort` argument) |
| `ref` | a ref or a sha | the commit's sha, read in `--root` |
| `snapshot` | `snapshot:<8 hex digits>`, as a probe returns it | that handle; a bare hash or any other form is `bad_arg` |

An absent argument takes its default, else its kind's empty value. A missing required argument
refuses `missing_arg`; a value its kind refuses, an unknown flag, a flag without its value and a
stray word refuse `bad_arg`; a name that resolves to nothing refuses `unknown_<kind>`, and a ref no
commit answers to `unknown_ref`. The CLI also refuses an unknown program (`unknown_program`), a
host it cannot find (`host_missing`), a live run over the same scope (`run_live`), a launch that
failed (`launch_failed`). `--repo` defaults to the working directory and `--root`
to `--repo`. Every agent call goes through the production runner built on the main checkout, so
its watch reads the user's checkout wherever the run was started.

**The claim.** Under a short lock per program and scope (`runs/.claims/<program>-<scope
digest>.lock`), a live run of the same program and scope refuses a second start (`run_live`, naming
the run, its pid and its log, so the session watches that one); a stopped one whose resolved
arguments digest the same is resumed under its own id, so every session it minted is found again;
otherwise a new run is minted, `<stamp>-<program>`, numbered `-2`, `-3`… when that is taken. A
program may name its run's home instead (`homeOf(args, {repo, now})`, asked inside the claim's
lock, `now` the launch's own time, so the program never reads the clock). `execute`'s is the latest
open execution of its effort whose root is its folder, else a new execution stamped from `now`
(`-2`, `-3`… when taken); its run id is `<effort>.<stamp>`. A live home refuses `run_live`; a
stopped one whose current run recorded nothing since its `run` line refuses `launch_failed`, but
for a relaunch (`relaunchRun` in `lib/boundary.mjs`), which records that start's `launch_failed` and
goes on;
otherwise the run starts there with the arguments it was given, whatever an earlier run of it was
given, and `run.json` is rewritten. A program may also ask for its result once its `ended` is on
disk (`afterEnded(ctx, args, result, {launchRun})`), `launchRun` a start of this CLI as the
session makes one: `execute`'s starts itself again when it stopped for a pause the session has
cleared since ([Session calls](#session-calls)). A run is live while the pid in its `run.json` is alive and its
heartbeat fresh, or while that pid, its heartbeat stale, is still a node process running a `run.mjs`
([Detached runs](#detached-runs)). The scope is what a second start is refused
over:

| program | scope | threads (roles) |
|---|---|---|
| `execute` | the effort and the folder | `producer:<leaf>` (implementer or test-author; a cycle's test rounds on `producer:<red>`), `auditor:<leaf>` (auditor), `reviewer:<leaf>:<n>` and `integration:<folder>:<n>` (reviewer), `planner:<folder>` (planner), `ruler:drift:<target key>:<digest of its open drift>` (`driftThread`), `ruler:<trigger>:<unit key>:<head8>:<digest>:c<cleared>` (`judgeThread`) and `ruler:stale:<base head>` (ruler), `ruler:converge:<leaf>:<n>` (ruler, the convergence ruling after a leaf's review round `n`), `investigator` (investigator), and its nested runs' own under `survey:<folder>:<basis>/` and `probe:<folder>:<n>/` |
| `survey` | the question's digest, the roots, the ground | `plan` (analyst), `scout:<topic>` (scout), `history` (historian), `docs` (doc-researcher), `ruler:search:<name>:<turn>` (ruler, a search's convergence ruling), `judge:<n>` and `rejudge:<n>` (analyst) |
| `probe` | the artefact, by its absolute path | `locate` (scout), `ruler:search:locate:<turn>` (ruler), `axes` (analyst), `relocate` (analyst), `prober:<n>` (analyst) |
| `solutions` | the capability's digest | `frame` (analyst), `research:<angle>` (doc-researcher), `repo` (scout), `ruler:search:<name>:<turn>` (ruler), `assess` (analyst) |
| `investigate` | the question's digest | the survey's, and `synthesis` (analyst) |
| `drafts` | the question's digest | `draft:<stance>` (analyst) |
| `rule` | the effort and the folder | `ruler:<basis>` (ruler) |
| `review` | the checkout it reads (`--root`) and the base | `reviewer` (reviewer) |

**The run log.** A run outside an execution keeps its own log, `runs/<run>/state.jsonl`, with its
own `seq` under its own lock ([State and journal lines](#state-and-journal-lines)), and never
writes an effort's event log, where a `dispatched` line would change the tree's derived status.
An execution's run writes the execution's log (`executionLog` in `lib/ledger.mjs`): a node event —
`dispatched`, `message` and every other kind in `EVENT_KINDS` — goes to the effort's event log
naming the execution, an observation (`verify-observed`, `merge-observed`, `series-done`,
`authored`) to the execution's journal, and everything else to its state log, all under the
effort's one `seq`. Either way the runner, the program and, in an execution, every boundary append
through one port, which refuses a field named `kind`.

**A relaunch runs only what never returned.** `dispatch` hands back a call whose `returned` line
and whole return are on disk without calling the runner; resumes every other call that was started
in its own session, with the fixed `cut_off` message ([Conversations](#conversations)) — one that
never returned, one that failed or was cut off, one whose stored return cannot be read;
waits out a host stop and resumes the same call ([Host stops](#host-stops)); and reads every return
from the store, so one it cannot read is a failed dispatch (`return_unreadable`). A side effect —
recording items, writing a context, settling — is a `step {key, value}` record: a relaunch reads
the value back instead of acting again, and a step cut off before its record runs again, so each
is safe to repeat. A context may carry `replayAfter`, a seq: then only a step recorded after it is
read back, because what was journaled before a unit began is another unit's answer. A value past
16 KB (a survey's evidence pool runs to a megabyte) is written to `steps/<digest>.json` in the
run's home and the record names it (`value_file`, `bytes`), so the log stays small; a record whose
file is gone is no answer. A log is read only as far as it grew since the same process last read
it (`readLog` in `lib/ledger.mjs`): its earlier lines are parsed once, its entries frozen, and a
file whose earlier bytes changed or that shrank is parsed whole again.

**Results.** `lib/run.mjs` writes the result to `result.json` in the run's home with `run` and
`cost` added — `{dispatches, by_model, tokens, usd, unmeasured}` over the home's `returned` lines,
each put to the model of the latest `dispatched` of its dispatch, each entry of `by_model`
`{dispatches, tokens, usd, unmeasured}` (`costOf` in `lib/run.mjs`, over `callsOf`, the one reader
of calls the effort's cost report shares), `usd` the host's own figures and `unmeasured` the calls
that carry none (P4); an execution's cost is over every run of it — and records `ended {result:
{status: done, file, complete}}`, `complete` the coverage block's. A program that throws records
`fault` on channel `program` and `ended` with status `failed`, and the CLI prints `{error}` and
exits 1.

### The agent runner

`lib/runner.mjs` is the one way anything in agentics starts an agent:

`runAgent({dispatch, node, round, thread, role, cwd, brief, freshBrief, briefNow, budgetNow, briefDigest,
briefParts, tier: {model, effort}, permissions, schema, carries, dir, resume, mcpConfig}) → {status: returned | stopped |
failed, cause, until, output, usage, cost_usd, denials[], session, checkout, message}`

It spawns the host's CLI, `claude -p`, without a shell, and owns every flag:

| what | how | why |
|---|---|---|
| the role | `--system-prompt-file` with the body of `roles/<role>.md`, written once under the run's directory as `roles/<role>-<digest>.md`; a search's scout gets its charge after the body (`promptFile(role, dir, charge)`), so the find, the scope and the material are cached once and read back on every turn | the agent is told its role and nothing else |
| the brief | on standard input, once it fits the first read's bound (below) | the brief reaches the agent whole; no command line holds it |
| its tools | `--tools` with the role's host tools from its frontmatter; a tool named `mcp__search__<tool>` is not a host tool and reaches the agent through `--mcp-config` | capability is the tool list |
| what it may touch | `--permission-mode dontAsk --permission-prompts none`; `--allowedTools` with the rules the program computes for this call: a role that writes nothing gets its read tools (`Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`) by their bare names, the search server's tools (`mcp__search__…`, `MCP_TOOL_PREFIX` in `lib/permissions.mjs`) by their exact names and `Bash(<command>:*)` for each command its command lines run (`commandParts` in `lib/permissions.mjs`: a line split at `&&`, `||`, `;`, `|` and newlines outside quotes, a leading `!` dropped, each `$(…)` a command of its own); a writer gets both an `Edit` and a `Write` rule for what it may write, because the host's `Edit` rule admits the Write tool and its `Write` rule does not: a producer by its role's rule ([Role rules](#role-rules)), its whole worktree (`/**`: a pattern is gitignore-style and a leading `/` anchors it at the call's working folder) or only the test-file globs, and a planner exactly its spec's path, its glob characters escaped; `--disallowedTools` for the store's folder (`/.agentics/**`), for the test-file globs where the role may write no test, for the files a call must not read ([Conversations](#conversations)), and, when the role runs commands, for the git options that reach past a worktree (`--amend`, `-C`, `--git-dir`, `--work-tree`, `--output`); `--amend` and `--output` are matched wherever they stand in the command, so a command that only quotes one is denied too | nothing prompts; what is not allowed is denied, and every denial comes back in `denials`. A compound command is allowed only when every part is, so a rule naming a whole check line admits nothing, and one rule per part admits the line and each part run alone |
| settings | `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`; `--mcp-config <file>` for a dispatch that names a tool server | nobody's settings, MCP servers, skills or `CLAUDE.md` reach a dispatch; the only MCP server a dispatch can reach is the one its program wrote for it (the search tool server, [Searches](#searches)); the guidance it needs is in its brief ([Briefs and returns](#briefs-and-returns)) |
| the model | `--model` and `--effort` from the dispatch's tier ([Model tier](#model-tier)) | per task; a resumed session may change model |
| the return | `--json-schema` with the role's return schema from `lib/schemas.mjs`; `--output-format stream-json --verbose` | the host validates the return, and the stream's final `result` event carries it; the events before it feed live activity ([Progress](#progress)) |
| the session | `--session-id <uuid>` for a thread's first call, `--resume <uuid>` for every later one | a session outlives its round ([Conversations](#conversations)); a call cut off mid-turn is resumed, never restarted |
| the environment | the parent's environment without every `CLAUDE_CODE_*` variable, `CLAUDECODE` and `AI_AGENT`, except the user's own settings named in one list in `lib/runner.mjs` (`KEPT_HOST_VARIABLES`: the Bedrock, Vertex and Foundry switches and their auth skips, the OAuth token, the Git Bash path, the client certificate, key and passphrase, the key-helper TTL, the output-token cap); `CLAUDE_CONFIG_DIR` is kept | a dispatch is nobody's child session, so what the launching session owns never reaches it, and it reads the same host configuration as the user's sessions. A session's own variables are too many and change with every host release to list, so the list names what to keep, and a new `CLAUDE_CODE_*` name is dropped until someone keeps it |

A **thread** is one line of work a session carries: a leaf's producer, a cycle's test author, a
planner's folder, a survey's judge. Its session id is minted from it (`sessionOf` in
`lib/store.mjs`: a UUID v5 over the effort, the execution, the node, the role, the thread's name
and its generation), so a program that died and was relaunched finds every session it started.
The host's CLI is the file `.agentics/config.json` names in `claude_cli`, and one that names no
file refuses (`host_missing`) without looking further; otherwise it is the first `claude.exe` or
`claude` in a `PATH` directory. Without one, `lib/run.mjs` refuses to start the program
(`host_missing`).

**The runner records as it goes.** `dispatched {dispatch, node, thread, round, role, model, effort,
session, brief_digest, brief_parts, carries[], prompt, cwd, pid, deny_read[]?}` is appended when the CLI starts — with `pid` 0
when no CLI started (its spawn failed, or the watch's read before the call failed), so every call
reads as started — `carries` naming the messages the call delivers
([Conversations](#conversations)), `brief_digest` the digest of the thread's brief on every call of
the dispatch (its first, a schema retry, each continuation part and a renewal), and `brief_parts`
the digest of each section of that brief by its heading, which only an execution's leaf rounds
give (`{}` on every other call), `prompt` the digest of the system prompt it ran under, `cwd`
where it ran and `deny_read`, only when there is any, the paths the call was denied reading. While the call streams, each host `WebSearch` call is appended as `tool_used
{dispatch, thread, tool, input}`, so a search can journal what its scout searched for.
When it ends, the runner appends `returned {dispatch, session, status, cause, usage, context,
opened, cost_total, cost_usd, denials}` — a host stop records
`host_stop` instead ([Host stops](#host-stops)) — `status` `returned`, `part`, `failed` or `cut_off`, and `cause` naming why a call that did not
return failed or was cut off. A call that returned has its output written whole to
`returns/<dispatch>.json` first (`writeWhole` in `lib/store.mjs`, the one writer of a file replaced
whole: staged beside it and renamed over it, a rename Windows refuses while another process holds
the file open — `EPERM`, `EACCES`, `EBUSY` — tried again for about a second first), so a `returned` line with status `returned` always has its whole
return on disk. `usage` is the host's own figure summed over every model turn of the call, which
cost reads; `context` is what the call's last model turn read — the input, cache-read and
cache-written tokens of the stream's last `assistant` event that carries `message.usage` — and
`opened` the same of its first; each is `null` when no event carried one. The host's cost figure (`cost_total`) accumulates over every
call of a session, so the runner records each call's cost as the difference from the session's
previous call. Cost is measured per call (P4). No agent writes a file that code reads, except the
work it was dispatched to do — a producer's edits in its worktree.

**A first read fits what a model can read.** A call that starts a session reads its system prompt
and its brief before it does anything, and a read that fills its window leaves it no turns to work
in. So every tier is planned against one window (`MODEL_WINDOW` in `lib/roles.mjs`, 200 000 tokens),
of which a first read may take half (`BRIEF_TOKENS`); code checks it in bytes (`BRIEF_BYTES`), at
2.2 bytes a token, the fewest measured over large briefs (each brief's bytes against the `opened`
its call recorded), so the estimate errs high. The runner refuses a fresh call whose system-prompt
file and brief together hold more (`oversize`): nothing starts and nothing is recorded, and the call
fails `brief_too_large`, a terminal class like `budget`, so a relaunch builds the brief again and
meets the same refusal unless what it is built from changed. A resumed call is not checked: its
session carries the brief, and a session past half its window is renewed instead (below).

**A brief is sized when it is built, and sent whole or not at all.** A brief is the evidence its
agent is handed inline; a part cut from it and replaced by a path to open would send the agent to
read what code should have handed it, so no part ever is. The budgets sit beside the window: one
part of a brief may hold half of what a first read may (`PART_BYTES` in `lib/roles.mjs`), so no one
body of text crowds out the rest, and the whole may hold what the role leaves of the bound
(`briefRoomOf` in `lib/programs/common.mjs`: `BRIEF_BYTES` less the role's system prompt and charge).
`dispatch` composes every fresh call's prompt from its parts and checks them before anything starts
(`oversizedPart` in `lib/briefs/size.mjs`): a part past its budget, or else a whole past the room, is
refused `brief_too_large`, the result naming the part (`part`, the whole's largest when the whole is
over), who can make it smaller (`owner`), the `file` it is when it is one, its `bytes`, and the
`budget` it would have to meet — beside the rest, for the whole. Nothing is sent or recorded. A plain
brief's parts are its `## ` and `### ` sections (`sectionsOf`; what comes before the first is its
`charge`, and a heading inside a fence is the fenced text's); a fresh call's thread messages are
parts of their own; a brief built in parts is shaped (`{parts}`, each `{key, text, file?}`), as the
prober's is ([Probe](#probe)). Under budget the prompt is the brief exactly as built. A session the
runner renews mid-call is briefed with the thread's fresh brief, held to the runner's whole bound
alone (`oversize`).

**A refusal goes to whoever owns the part.** One table beside the part names says who can make each
part smaller (`OWNERS` and `ownerOf` in `lib/briefs/size.mjs`), by the `## ` section a part sits
under — kept open, for a section that embeds a document, over that document's own headings — or a
shaped part's key:

| owner | its parts | a refusal naming one |
|---|---|---|
| `work` | a leaf's own work: its Task, criteria, decisions, expected files and reads, its cited Design part, what it consumes, its effort files, measures, commands; its plan entry a ruler reads; a folder's spec a planner or reviewer reads | in a leaf's dispatch (its round, its reviewer, its convergence ruler), a `decompose` to the folder's planner, or `needs_respec` in a folder the user wrote ([Replanning](#replanning)); elsewhere, as `user` |
| `user` | the repository's guidance, one part per file; a changed spec's diff, the user's answers, each fenced so no answer opens a section, and the specs a ruler reads whole, one part per spec; a folder's spec edit and the user's word on it, and its sub-efforts' specs, one part per spec, that an integration reviewer reads; a probed artefact | a stop for the user naming the file and its size: in an execution `escalated brief_too_large` (`dispatchFailed` in `lib/boundaries/records.mjs`), from `rule` `shrink_brief` ([A changed spec](#a-changed-spec)); the user settles it by shrinking or splitting the file |
| `code` | everything else: the charge, thread messages, a probe's ground and settled specs, rendered records; a leaf's evidence and gotchas, a ruler's changes, a producer's return a reviewer reads, a survey's evidence a planner reads, each bounded where it is built (`bounded` and `boundedDiff` in `lib/briefs/size.mjs`), whole items or files kept first and a closing line naming what was left out | none in practice: code bounds what it accumulates as it builds the brief, shedding the least valuable first and declaring what it shed; a refusal that still names one is a defect of its builder, a `role` fault whose detail carries the part, its bytes and budget |

Code gives way first: a bound sheds what code owns before a refusal is laid on the work or the user.
**A fresh session replays its thread within its room** (`replayOf` in `lib/programs/common.mjs`):
its thread brief, then every message recorded on the thread but a `brief_changed`, whose copy of an
older brief the fresh brief supersedes; while that is past the role's room, or a message past its
part's budget, the oldest message is left out, never the latest, and a `left_out` message leading the
rest names each by seq, kind and round. Every message counts as carried. The dispatch returns the
seqs it left out (`left_out`), and an execution declares them in its coverage block.

The spend view flags a unit with a call whose session opened past the bound as measured
([Spend view](#spend-view)), which is how an estimate that errs low shows.

**One driver per session.** The host lets two processes drive one session at once and interleaves
their turns, so the runner keeps it to one: before a session is resumed, the runner makes sure no
earlier call on it is alive, by the `pid` on its `dispatched` line, and ends one that is — it is an
orphan of a program that died, and its session goes on only through the resume; the call it ended
is recorded `returned {status: cut_off, cause: orphan_ended}`. The process port reads a pid as
alive, and ends it, only when its image is the host CLI's executable (`hostProcess` in
`lib/host.mjs`), so a pid the system handed to another program after a crash is never killed. On
Windows such orphans are rare, since a call started without `detached` dies with the program that
started it.

**A run's start ends every call an earlier run left open.** A call is recorded ended by the process
that waits on it, so a run that dies mid-call leaves its `dispatched` line with nothing after it,
and the records would read that call as running for as long as anyone looks. Right after its `run`
line, every run closes each call of its log whose latest `dispatched` has no `returned` and no
`host_stop` after it (`closeLeftOpen` in `lib/runner.mjs`): the claim on the run's home means no
other run waits on it. One still alive is ended and recorded `returned {status: cut_off, cause:
orphan_ended}`; one whose process is gone is recorded `returned {status: cut_off, cause:
process_gone}`; either way its live file goes. Closing a call never stops it from being resumed: a
unit that asks for the same dispatch again finds it started and never returned, and resumes it in
its own session with `cut_off`. A call nothing asks for again — a probe round's prober, when the
folder's next plan moved the round on — stays ended. The execute program notes how many it closed.

**A session the host no longer holds** — the host's cleanup removed it (by default 30 days after
its last turn, `cleanupPeriodDays`; every resume renews it), or the thread began under 4.x —
refuses to resume (`No conversation found`). That is an observation, not a fault: the thread
goes on in a fresh session, briefed with the thread's brief and every message recorded on it.

**A session that grew too large is not resumed.** A session's floor is what its first model turn
read (`opened` on the session's first measured call): the system prompt and the first brief, which a
fresh session carries again. When the session's latest returned call that measured a `context` read
past the midpoint between that floor and a 200 000-token window in its last model turn (`WINDOW` in
`lib/runner.mjs`), the thread goes on in a fresh session, briefed with the call's fresh brief: the
thread's brief and the messages it replays (`replayOf`), the open findings among them, in a program and an
execution alike. So a renewal always sheds turns: a charge that alone fills more than half the window is no reason
to renew. A session whose first measured call recorded no `opened` has floor 0, and a session no
call measured is resumed; the cumulative `usage` never decides it.
**A prompt the host refuses as too long** fails the call `context_exceeded`. A call that carries
`briefNow` (a search's) is renewed once, briefed with what `briefNow()` returns then; a second
refusal fails the call. A call with `briefNow` is briefed with it on every renewal, in place of
its fresh brief.
**A dollar cap.** A call may carry `budgetNow`, which the runner calls at every CLI start: a
remainder of zero or less starts nothing and fails the call `budget`; any other is passed as
`--max-budget-usd`, and the host's stop at it (`error_max_budget_usd`) fails the call `budget`,
which `dispatch` does not wait out.
The runner records every renewal it makes as `thread_renewed {thread, gen, why}`, `why` being `too_large`,
`session_missing` or `context_exceeded`, and the thread's next session id is minted from its new
generation. `dispatch` records it too when it starts a thread's next session itself: on a `fresh`
call, and, for a call with `renewOnChange` (a search's), when the thread's last `dispatched` entry
ran under another system prompt or cwd (`prompt_changed`, `cwd_changed`) — even over a started
call, which then gets `cut_off` and its brief. A call's `mcpConfig` may be a function of the
session, which the runner calls with the session each CLI start runs under.

**A return too large for one response** says so (`more: true`); the runner resumes the same
session for the rest and stores the parts as one return. Only a judge's schema holding an array
offers `more` (`long` in `lib/schemas.mjs`): a part progresses only by adding array elements, so a
schema of strings alone, a searcher's included, has nothing a continuation could add. Each part is recorded `returned {status:
part}` and stored nowhere; the call that completes the return stores the merged whole and only then
records `returned`. A part that adds no array element the merged return lacks and fills no field
the merged return holds empty ends the call failed, `no_progress`: a reworded field is not
progress, so a session that restates itself part after part ends. The parts so far are kept only in the session: the runner
holds them in memory, so a host stop or a relaunch between parts drops them, and the `cut_off`
resume asks the session for its whole return again, from the start. No return schema carries a
bound that would make an agent drop what does not fit (the `no-schema-bounds` lint rule).

**Denials are observations.** Every tool call the permissions refused is in `denials`, on the
record: a write the producer's role may not make ([Role rules](#role-rules)), a command outside its
list.

**The user's checkout is watched.** Before and after every call of a role that runs commands (one
with `Bash`), and every check, the runner reads the main checkout's `HEAD`, its branch refs and its
status. The framework's own `refs/heads/agentics/` are not the user's, nor is a branch checked out
in another worktree of the repository (`git worktree list`), which another session works on: a ref
either read names that way is left out of the comparison. A moved `HEAD` or ref ends the call failed (`cause: checkout`), ahead of any host stop, and
is a fault naming the call ([Faults](#faults)); a changed working tree is recorded,
`checkout_changed {dispatch, paths}`, and shown, not a fault, because the user may be working in it
(a staged rename names its original path as well as its new one).
A watch that cannot read the checkout cannot vouch for it, so the call ends failed,
`watch_failed`: when the read before the call failed no CLI is started, and when the read after it
failed a completed return is kept on disk, a continuation part is kept nowhere and handed back as
no output, and the call still does not count as returned.

**Confinement and what it leaves.** An agent runs in its worktree, may edit only the paths it was
allowed and may run only its role's commands; an implementer also runs its leaf's criterion checks
and the project commands its entry names in `runs` (`roleCommands` in `lib/roles.mjs`), each split
by `commandParts`, the one parser of command lines: split where the shell runs one command after
another, a subshell's, a substitution's and a backquoted command's parts their own, a heredoc's
lines its command's input. A producer that returns `blocked` after the host denied it commands has
each denied line read against what the round was granted (`deniedClass` in `lib/permissions.mjs`):
a project command no grant names, even bare of assignments and redirects, stops as
`command_not_in_runs`, the lines and what the producer said its `detail` — its entry is missing a
`runs`, a spec gap no retry clears; a line that is ad hoc — a file tool such as `cat`, `sed` or
`git`, shell control such as `eval` or a loop, an inline script, or a granted command wrapped in a
`cd`, an assignment or a redirect — goes back to the producer as a `failures` message (`source: the
permission check`), and blocked on ad-hoc lines again, any lines, it stops as `blocked` with what it
said; a line granted as it stands that the host denied anyway is a `program` fault, the plugin's
rules and the host's disagreeing. A `runs` entry is one plain project command (`runsProblem`): no
chain, pipe, background, substitution, redirect or assignment, nothing the role's tools do, and no
bare interpreter or package runner, whose prefix rule would admit any script or package. An agent of a program run outside an execution runs
in the checkout the program reads (`--root`), the `review` program's reviewer in its throwaway
worktree, and none of them is allowed a path to write. Prevention ends where the repository's own
commands begin: a build or test script a producer runs is the project's code, and what it writes
outside the worktree is detected by the watch above, not prevented. The investigator, which has to
discover commands, runs any command in a throwaway worktree detached at the execution's base
(`.claude/worktrees/investigate-<effort>-<stamp>`, removed when its call ends), under the same
watch ([Roles](#roles)).

### Host stops

The runner classifies a call that failed from what the host said (`classifyCall` in
`lib/runner.mjs`): its stderr, its status code, and the result text only of a return the host marked
an error, never the model's own words. A usage or rate limit, an overloaded or unavailable host
and a network failure are **host stops**: the dispatch stays in progress, the runner records
`host_stop {dispatch, cause, until}` (`until` when the host said when), and the program waits and
then resumes the same session with the `cut_off` message. It asks again a minute past the time the
host gave, when it gave one that reads as a date, and never sooner than a minute; otherwise after
one minute, then two, four and so on, doubling up to thirty minutes (`waitFor` in
`lib/programs/common.mjs`). When it
asks again is a count's decision; nothing about the work is (L2). The status shows what the run
waits on and since when. A return that fails its schema is
resumed in its own session with the validation error as the message; a second failure ends the call
failed (`schema_failed`): no progress, and a role fault ([Faults](#faults)). A failure the runner
cannot classify ends the call failed (`host_error`), a `host_error` fault.

### Roles

Every agent is one of these roles. A role is a file in `roles/`: frontmatter (`kind`, `tools`,
`commands`, the names of the return schemas it may be dispatched with, a default tier) and a body
that is its system prompt. A dispatch names one of its role's schemas, and `dispatch` refuses one
the role does not list. The `role-frontmatter` lint rule judges the frontmatter when a role file is
committed; `lib/roles.mjs` refuses a bad one when a dispatch loads it.

| role | kind | does | tools | may run |
|---|---|---|---|---|
| scout | searcher | find what one search of the repository tree is charged with, one session a round, through code's tools | `mcp__search__grep`, `mcp__search__read`, `mcp__search__files`, `mcp__search__refs`, `mcp__search__hit` | — |
| historian | searcher | find what one search of the repository's history is charged with, one session a round, through code's tools | `mcp__search__log`, `mcp__search__show`, `mcp__search__grep`, `mcp__search__read`, `mcp__search__hit` | — |
| doc-researcher | searcher | find what one search of what vendors and specifications say is charged with; its fetches go through code | WebSearch, `mcp__search__fetch`, `mcp__search__hit` | — |
| analyst | judge | judge what it is handed: plan a survey, judge evidence into items, re-judge suspect items, derive a review's axes, name the ground a narrowed review has not located, rule as a prober, frame and assess a solutions sweep, draft an approach from a stance, answer an investigation or turn it into tasks | Read | — |
| ruler | judge | rule whether a change moved a node's premise; rule whether a loop converges | Read | — |
| reviewer | judge | rule every unit of a span: findings with severity, a ruling per criterion, per file, per claim | Read, Grep, Glob, Bash | read-only git |
| auditor | judge | declare mutations an implementation's tests must catch, and name tests to retire | Read, Grep, Glob | — |
| planner | producer | write the spec of a folder develop owns, and settle its review | Read, Grep, Glob, Edit, Write | — |
| implementer | producer | code one leaf as a focused series, or a fix round of it | Read, Grep, Glob, Edit, Write, Bash | the established build, typecheck and test commands; `git add`, `git rm`, `git commit`, `git status`, `git diff`, `git log` |
| test-author | producer | write a leaf's or a cycle's tests and declare mutations | Read, Grep, Glob, Edit, Write | — |
| investigator | producer | establish build, typecheck and test commands when none are known | Read, Grep, Glob, Bash | any command, in a throwaway worktree |

A producer returns its status and its declarations; a searcher records its findings with `hit`
as it goes and returns a summary; a judge a ruling per unit it was handed. A
judge is never handed a unit its own session or thread produced (`judgeAllowed`, which
`dispatchJudge` applies, L3). A role that
writes files writes only in its worktree, and the program commits a shell-less author's files
itself. The roles' instructions are runtime text: reasons live here, and every role file has a
size budget (`tools/budgets.json`).

**Why roles are not plugin agents:** the host loads a plugin's agents into every session, and a
session could then start one outside the records, the confinement and L3. A role file is read by
the runner alone.

### Briefs and returns

A leaf's producers are briefed by code (`leafBrief` in `lib/brief.mjs`) with their thread's brief,
its evidence derived in a child the program awaits (`briefEvidence`), since every anchor check
runs git; within one check each git answer (a diff, a rename, a query) is asked once however many
spans name it, and a commit's blob once for the worker's life, held by its oid (`blobAt` in `lib/offload.mjs`),
in the sections `Task`, `Acceptance criteria`, `Decisions realised`, `Expected files and reads`,
`Evidence`, `Gotchas`, `Measures`, `Commands`, `Worktree` and `Repository guidance`: the node, the
decisions it realises, the files it expects to change (a prediction, never a limit) and those it
reads, a test round of a green or an audit also the test files the red's branch changed
(`cycleTests` in `lib/integration.mjs`); then, under `Spec Design` and only when its entry's `cites`
declares any ([Spec format](#spec-format)), each part of the Design of the spec that holds it the
entry cites, or the whole Design for `cites: Design` (`designCitedBy` and `citedDesign` in
`lib/spec.mjs`), from the text compile last kept for the folder: a producer, and the reviewer handed
its brief, can never be told to match a document its worktree does not hold; then, under `Consumes`
and only when one declares it, the part of its provider's spec's Design that defines each contract the
leaf consumes, read from the providing entry as compile last kept its spec, the provider the
contract's shallowest live provider (`consumedParts`); then,
under `Effort files` and only when there are any,
the text of each file under the effort's store (`.agentics/<effort>/`, its `.state/` records
excepted) that the leaf reads or its intent or context cites, read from the main checkout: the store
is gitignored, so no worktree holds it, and the producer is confined to its worktree. Then its
referenced evidence, the gotchas its role and expected
files call for, how its rigor measures it, the established commands, its worktree, and the
repository's guidance — its `CLAUDE.md` files from the root to each directory its expected files sit
in, and the files
`.agentics/config.json` names in `guidance`. A thread's brief is its owner's, so the cycle's test
session is briefed with the red's on a green's or an audit's round too, with that round's own
worktree. It names no round, no finding and no request, so it stays put across rounds: what a
round must answer — findings, failures, a request — reaches the session as messages
([Conversations](#conversations)). A fresh session's prompt is the thread's brief and every
message on the thread; a resumed one's, the messages it has not been sent. A dispatch loads no
guidance on its own, and no agent is pointed at a file to learn what it is to do. Excerpts several
agents need are resolved once (`lib/citations.mjs`) and put in each of their prompts. The brief's
digest, and in an execution each section's, is on `dispatched`, so a relaunched program can tell
whether a session was briefed with what the records now say.

A program's own dispatches — an execution's reviewers, integration reviewers, rulers, planner and
investigator, a survey's, a probe's, a sweep's, the drafts', a review's, an investigation's
synthesis — are briefed by that program's file in `lib/briefs/`, one per program (a leaf's reviewer
is handed its producer's leaf brief inside its own), and a ruling's by `rulerBrief`
(`lib/briefs/respec.mjs`), over the parts `lib/respec.mjs` gathers ([A changed
spec](#a-changed-spec)). Each carries the repository's guidance from `guidanceOf` in
`lib/brief.mjs`: every `CLAUDE.md` from the repository's root down to each root the program reads
(the root alone when it names none), root first and each file once, then each file
`.agentics/config.json` lists under `guidance`, in its order, a listed file that is missing shown as
not found. Each file is fenced under its path (`fenced` in `lib/briefs/size.mjs`, a fence longer than
any it holds), so its own headings never read as the brief's and it is one part of the brief, the
user's ([The agent runner](#the-agent-runner)). Nothing else in a program builds a prompt; a message
it sends is `renderMessage`'s.

A search's scout is briefed by `lib/briefs/search.mjs`. Its **charge** (`scoutCharge`) — the
domain's tool protocol, the find, the scope, the labels and the program's material fenced as data
— is its system prompt, beside the role's text (`promptFile(role, dir, charge)`), and depends on
nothing a session changes, so the host reads it back from cache on every turn. Its standard input
is `resumeBrief(journal)` in the first round: the opening for an empty journal, else the hits
recorded and the calls run, one line each (`callLines`); a later round's is `roundBrief(journal)`,
the same lines and the ask to find what the earlier rounds missed. A renewed session gets its
round's brief built at that moment (`briefNow`, [Searches](#searches)). The opening and the scout's
role end on one stop line (`STOP_LINE`). Probers and survey judges get a search's hits through
`hitExcerpts`. The `prompt-origin` lint rule
treats `charge` as a prompt key beside `brief`, `threadBrief` and `prompt`.

An agent's return is the JSON its role's schema states (`lib/schemas.mjs`), validated by the host
and stored by the runner. A producer returns its status (`done`, `done_with_concerns`, `blocked`,
`needs_context`, `needs_tests`, `declined` — the cycle's test session's alone — or a
[replanning return](#replanning)) with what it established, tried and needs as text in the same
return; with its gotchas, the mutations it declares and its concerns. A status is the only way a
producer asks for anything ([Conversations](#conversations)). A searcher returns the `search`
schema, `{summary, unsearched}`: its findings are the `hit` records the tool server journaled as it
went, and `unsearched` declares where the find pointed that it did not look. That declaration steers
whether another round runs and is carried as the scout's own word; everything else in its coverage
code observes from what its tools ran ([Searches](#searches)). A judge returns its
rulings, one per unit, and its findings; an auditor, the mutations it declares, the tests it
asks to retire and a ruling per unit, with no status. A program reads the stored return, and nothing reads an agent's word from
anywhere else.

### Conversations

An agent's session outlives its round, and the host keeps it on disk, so work can go back to the
agent that did it, with everything it learned still in its session. Code carries every message: a
message is a producer's status, a judge's finding or an observation code made; the program records
it and delivers it by resuming the recipient's session with the message as its next prompt,
rendered from a fixed template (`renderMessage` in `lib/conversation.mjs`). The recipient's answer
is its return. No agent names its recipient, and a return carries no free-form message: what is
sent where is the routing table (`ROUTES`):

| message | from | to | the answer |
|---|---|---|---|
| `findings`, remedy `code` | a leaf's reviewer | the leaf's producer session | a fix round: new commits and a status |
| `failures` | code: a measurement of the leaf's round (`source: verification`), a merged head the leaf fails alone on (`source: integration`), or a rebase merge its round left unconcluded (`source: the rebase`) | the leaf's producer session; a verification failure on a green or an audit goes to the session the records name ([Rigor](#rigor)) | a fix round |
| `findings`, remedy `tests`; `surviving_mutations` | a green's reviewer; an audit's measurement (code) | the cycle's test session (the red's test author) | tests added, or `declined` with why |
| `needs_tests` | a green's implementer, as its status | the cycle's test session | tests added, or `declined` with why |
| `consolidate` | code, when the review of a cycle's last member would approve it ([Rigor](#rigor)) | the cycle's test session | the cycle's tests made lean, with the breaks they must still catch declared, or nothing written |
| `tests_ready` | code, once the test round is measured | the green's implementer session | a round against the new tests |
| `declined` | the cycle's test session, declining an implementer's `needs_tests` | that implementer's session | a round without the tests, or `blocked` |
| `needs_context` | a producer, as its status | the folder's planner session when the planner wrote the folder; otherwise the node parks for the user | a spec edit, checked, probed and prepared like any; the asker then receives `brief_changed` |
| `rebase` | code, when the judge ruled a leaf's merge conflict resolvable ([The judge](#the-judge)) | the leaf's producer session | a round whose worktree holds the merge of the folder's head in progress: the conflict resolved and the merge concluded, then the work checked against what merged |
| `brief_changed` | code, when a thread's brief no longer matches the records | the thread's session | the work goes on against the new brief, told what changed |
| `retried` | code, when the user's `retry` cleared a leaf's stop after a round this execution dispatched on the thread | the thread's session | the round goes on from where its series stands, told the cleared reason and the text of each note left on the leaf since the stop or the thread's latest return, whichever is later |
| `notes` | code, on a new round of a thread this execution never dispatched | the thread's session | the round goes on, told the text of every note left on the leaf since the latest dispatch of any execution on it, the notes no session of it has seen |
| `findings` of a probe | the autonomous review | the planner session that wrote the spec | dispositions |
| `problems` | the spec check (code) | the planner session that wrote the spec | a corrected spec |
| `refusals` | the evidence recorder, settling a probe's findings, or settling a changed spec (code) | the thread whose return was refused: the judge's session for items, the planner's for dispositions, the ruler's for rulings | corrected items, dispositions or rulings |
| `cut_off` | code, for a call started and never returned, or one a host stop cut short | the thread's session | the turn finished and its whole structured output returned, from the start |
| `left_out` | code, leading a fresh session's replay that left its oldest messages out to fit ([The agent runner](#the-agent-runner)) | the thread's session | the round goes on from the latest messages |

- **Recorded before delivered, delivered once.** `message {node, thread, from, msg, payload,
  round}` is recorded before the recipient is resumed — by the boundary that decided it, before it
  returns, once per node, thread, round and `msg` — and the call that delivers it names it in
  `carries`. In an execution it is a node event naming its execution; one recorded with an empty
  execution is delivered by the next execution that runs its thread. A thread's messages are every
  `message` recorded to it (`threadMessages`). A release that drops a message kind raises
  `STORE_VERSION`, and its store migration rewrites the messages of that kind out
  ([Migrations](#migrations)), so no session's prompt is built over a kind this version cannot say. A declined request that was not an implementer's `needs_tests` is no message: sending
  the same request again would end the conversation, so it escalates `tests_declined`. A resumed
  call is sent every message on its thread no `dispatched` line carried yet, batched into one
  prompt; a message is delivered once a `dispatched` line carries it, and a carrier that never
  returned is resumed, never sent the message again. `cut_off` alone is never recorded: it is the
  brief of every resume of a started call, after a cut-off or a host stop.
- **A refusal names what was refused.** A `refusals` message's payload is `{of, refusals[{claim?,
  id?, finding?, problem}]}`, `of` naming what code refused of its recipient's return — `items`,
  `dispositions` or `rulings` — and its text says who refused them: the evidence store, the ledger
  or the settle.
- **A decline ends the conversation unless it answers only the implementer.** A cycle test round
  that declines a dispatch carrying only the implementer's `needs_tests` answers the implementer
  with `declined`. One that declines a reviewer's tests findings, surviving mutations or code's
  failures, alone or beside `needs_tests`, escalates `tests_declined` and sends the implementer
  nothing: the next request would be the same one sent again. The implementer's `needs_tests`
  stays open, answered only by `tests_ready` or `declined`.
- **Judges are fresh and never argued with.** A judge's session is resumed only with what bears on
  its own return (its schema, its refused items). No producer's word reaches a judge as a message:
  a producer that holds a finding wrong says so in its `concerns`, and the next fresh reviewer reads
  that beside the code while it rules the open blockers itself (L3).
- **The cycle's test author never sees the implementation's code.** Every call of the test session
  after the red is approved is denied `Read` on the files the green's series changed outside the
  cycle's tests, and its `dispatched` line records those paths (`deny_read`): it works from the
  criteria, its own tests, the failures and the signatures.
- **A test session only strengthens, until it consolidates.** In every test round after the red is
  approved but the cycle's consolidation round, the red's approved version of each approved test
  file the round changed runs against the green head; an approved case that fails there blocks,
  unless a fresh reviewer rules that case wrong, one unit per such case. The series check flags a
  test case removed from an approved test file (`test-removed`). The consolidation round alone may
  remove and merge approved cases: its guard is that what the cycle's tests catch still bites
  ([Rigor](#rigor)).
- **Context that failed once is not trusted twice.** A fix round resumes the producer's session.
  After a round that cleared none of its blockers — a review that answered prior blockers and ruled
  none of them `fixed`, or a measurement in which every failure of the round before fails again —
  the next round is a fresh session on the raised tier ([Model tier](#model-tier)), recorded
  `thread_renewed {why: raised}`, handed the thread's brief and the messages it replays.
- **A conversation ends on a state (L2):** the same open findings after a round, the same request
  declined and sent again, or a convergence ruling `rulingDue` asked for.
- **Turns are never interrupted.** A message waits until its recipient's turn has ended, and one
  process drives a session at a time ([The agent runner](#the-agent-runner)).

A resumed session sends its whole conversation again. The host caches it for an hour, and every
call renews the hour: a resume inside it pays cache reads, and one after an hour idle pays to
write the whole history again, an order of magnitude more. So the scheduler delivers a waiting
message while its recipient's hour is still running whenever it can, and the runner's records
show per thread what resuming cost.

### The user's word

Three acts are the user's alone: a spec's first approval, landing, and adopting work done outside
an execution ([Outside work](#outside-work)). Each is a lib call the session makes after it asked
the user, and each checks the asking. The question must contain the act's token, which a call the
session reads first prints: `lib/approval.mjs state` prints `approve <folder>@<hash8>`,
`lib/boundary.mjs land --action check` prints `land <effort>@<head8>` for landing, and
`lib/boundary.mjs adopt --action check` prints `adopt <folder>@<digest8>` for adopting, the digest
being that of the normalized mapping and the folder branch's head. The calls are
`lib/approval.mjs approve`, `lib/boundary.mjs land --action merge` and `lib/boundary.mjs adopt
--action act`. Each confirms the word in its own CLI layer through `confirmAct` in `lib/host.mjs` —
`approveAct` in `lib/approval.mjs`, `landAct` and `adoptAct` in `lib/boundary.mjs` — and an act
whose token is empty (a folder with no spec has none) refuses `no_token` before any word is read.
`recordApproval` and `land`, the in-process functions that settling a ruled change and the tests
call, take no word. Before anyone is asked, `approve` refuses a spec it could not record — one with
problems or an open blocking question — or one the compile of which, previewed as approved, refuses
(`compile_refused`); `state` prints such a spec's `problems` and an empty token, so the user is
never asked to approve a text that has to change before it builds. `land --action merge` confirms
the word first and refuses an open escalation, a parked node or a dirty tree after it. `approve`
and `land --action merge` read their token afresh and confirm the word for it, so a spec edited, or
an effort branch moved, after the session read the token it asked with leaves no question naming
the act's token and refuses `not_approved`: the session reads the token again and asks again. Each
act is bound to what its token named: `approve` records the approval at the hash its token named
and refuses (`spec_changed`) a spec edited while the word was being confirmed, and `land --action
merge` merges the effort head its token named, never the branch as it stands when the merge runs,
and refuses (`head_moved`) a branch that moved meanwhile; `landed` records `by`. `adopt --action
act` writes what the digest its token named described, and refuses (`head_moved`) when the folder
branch or a branch the mapping names moved while the word was being confirmed; every record of the
batch carries `by`.

- **From a session** (`CLAUDE_CODE_SESSION_ID` set), `verifyAnswer` in `lib/host.mjs` reads that
  session's transcript and refuses unless the latest answer to a question containing the token
  chose the act's option, exactly `Approve`, `Land` or `Adopt` (`not_approved`). The token is matched whole:
  a question holds it only where the text ends after it or the next character is outside
  `[0-9A-Za-z#]`, so `approve api@0a1b2c3d#4` is not in a question about `#41`, and `land e1@` is
  not in one about `land e1@abcdef12`. A transcript it cannot find or read refuses
  (`answer_unverifiable`).
- **From the user's own terminal** — no session, and standard input an interactive console — the
  call asks for the token to be typed back (`askLine` in `lib/host.mjs`: the prompt on standard
  error, one line read from standard input), refuses (`not_approved`) anything else — input that
  ends before a line included — and records `by: terminal`.
- **Anything else refuses** (`answer_unverifiable`). A session's tool shells and every agent run
  with standard input redirected, so neither can take the terminal's path.

**Answers.** Every other question the user is asked during an effort — a park, a conflict a
change raised, any question at the Grill once the effort has a tree, since its answer may move a
spec compiled before — is opened before it is asked, answered once, in the user's own words, and
kept. Nothing is ever asked a second time to confirm an answer or to carry a token: the session
opens the question first, and `ask` refuses `no_tree` while nothing is compiled. `lib/answers.mjs ask --effort <e> [--node <id>…]` opens it: an `asked`
ledger line naming the nodes whose stop it settles (a node not in the tree refuses `unknown_node`),
and the token `answer <effort>#<seq>` every question of that one `AskUserQuestion` call carries in
its text. `lib/answers.mjs record --effort <e> --asked <seq>` reads the answer back through
`answerOf` in `lib/host.mjs`: from a session, every question of the latest result whose question
holds the token, with what the user chose or typed (`answerTo`; none refuses `not_answered`); at
the user's own terminal, one line typed in answer to the token's prompt (`terminalAnswer`); from
anywhere else, `answer_unverifiable`. It is kept as `answered {asked, nodes, answers[{question,
answer}], by}`; the same batch recorded again appends nothing, an answer to the question asked
again replaces the earlier one, and a question never opened refuses `unknown_question`. A changed spec is ruled against every answer recorded since its latest
approval ([A changed spec](#a-changed-spec)), so the session that asked never re-asks for approval:
it carries the answer into every spec it reaches, and the rulings decide what, if anything, is
still open.

**What this guards against:** a misread answer, a stale hash, the wrong folder, an answer the user
never gave, a session approving on its own say-so. It does not stop a session that forges its
own transcript or fakes a console; the host contract test pins the transcript's shape and the
variable ([Self-checks](#self-checks)).

### Detached runs

A program started with `--detach` runs in a child process that outlives the tool call that started
it, and its records are how anything follows it. The parent claims the run, starts the same command
with `--child <run>` as a detached child whose output goes to the run's `run.log`, writes the
child's pid into `run.json` and appends the run's `run` line naming it, both inside the claim, so a
start racing it sees the run live and is refused `run_live`; it prints `{run, pid, log, result_file}`
at once. Once a run's `ended` is on disk, a program that asks (`afterEnded`) is handed its result:
an execution that stopped for the session's pause (its result's `paused`), which the session
has cleared since, starts again detached; one the `--pause` flag stopped stays stopped.
`lib/status.mjs watch --run <run>` prints a line for every `host_stop` and `fault` recorded after
the `seq` its `--since <seq>` names (a non-negative safe integer; any other is refused), or after it
began when it is given none (`host_stop <dispatch>: <cause> until <until or ->`, `fault <channel>:
<detail>`); on an execution's run (`<effort>.<stamp>`) it also prints each `escalated` or `parked`
event of the execution that is still its node's open stop when the watch reads it (`<id> escalated
<reason>`, `<id> parked <return>`); then `ended <status>: complete=<bool> result=<file>` at the
run's end — the `ended` after the run's latest `run` line, wherever it stands against `--since`, and
on an execution's run only one whose `seq` is above the `--since` given, so a relaunch whose child
has no `run` line yet is not ended by the previous run's `ended` — or `stopped: start
the same command again to resume run <run>` when the run reads stopped. The session's monitor shows
each line as it comes. A program run's monitor passes `--since 0`, so a fault recorded before the
watch began, or between two of its re-arms, is printed all the same: the run's log is its own. An
execution's log spans every run of it, so develop's watch passes the effort's `seq` it read before
the start instead ([Progress](#progress)); a re-armed watch prints again a line that still stands. A
run is alive while its pid lives and its heartbeat — the last beat in `heart.jsonl`, appended every
10 seconds — is fresh, written within the last 120 seconds. Beats are appended to a file of their
own, never renamed over `run.json`, so a reader holding `run.json` open never refuses one. A worker
thread of the run's process beats (`startHeart` in `lib/heart.mjs`), so synchronous work on the
main thread — a git call, a lock wait — never stales it; each beat also writes `loop_at`, the main thread's last
turn of its event loop, which that thread marks every second. A stale heartbeat therefore means the
process itself froze: a run whose heartbeat went stale is still alive while its pid is a node
process running a `run.mjs` (`runProcess` in `lib/host.mjs`, read only then): `runState` reads it
`live` with `beating: false`, a start is refused `run_live`, and the watch prints `unresponsive: pid
<pid> still runs <run> but has not beaten since <heartbeat_at>; …` once, and `beating again: <run>`
if it does. A run that beats while `loop_at` is stale reads `turning: false`, and the watch prints
`busy: …` once and `turning again: <run>` after: the main thread is held, the process is not hung.
A turn that comes more than 15 seconds late is recorded `stalled {ms, since, spent[{label, n, ms}]}`
in the run's log once the thread turns, which the watch prints: `spent` is the synchronous git time
counted meanwhile by subcommand (`noteSync` and `takeSync` in `lib/store.mjs`), the largest first,
so the line names what held the thread. Every git the plugin runs goes through `gitSync` (or, in the
search server, `gitAsync`) in `lib/store.mjs`, held to what nobody answers mid-run: no credential
prompt, no editor, no lazy fetch of a partial clone's missing object, no optional index lock, and no
automatic gc or maintenance. At its
start a run removes the files `writeWhole` staged under its home whose writer's pid is gone
(`sweepStaged` in `lib/store.mjs`): a process killed between a write and its rename leaves one. One without `ended` whose pid is
gone, or whose pid the system gave another program, shows as stopped, and starting the same command
again resumes it. A run started with `detached` outlives both
a headless session's exit and a background session's stop, and the host's own job does not kill it
on close; one started without `detached` dies with the process that started it. Nothing depends on
survival all the same: resuming from the records costs one relaunch. A relaunch that finds nothing
recorded since the previous `run` started, and a run whose process never started, are a fault
(`launch_failed`), recorded with `ended {status: launch_failed}`: a plugin fault, which the session
starts once more and reports as a plugin defect when it comes again ([Skills](#skills)).

A dispatch started and never returned — its `dispatched` with no `returned`, or the `cut_off`
`returned` a run's start closed it with ([The agent runner](#the-agent-runner)) — is resumed in its
own session when a unit asks for it again, with a fixed message saying it was cut off (`cut_off`); whatever it
did is in its session and its worktree. In an execution, when its brief's digest no longer matches
what the records now brief, the message is `brief_changed` instead
([Conversations](#conversations)). The evidence programs send no `brief_changed`: the claim resumes
only a run whose arguments match, so a relaunch replays a returned call and resumes a cut-off one
with `cut_off` even when the brief it would build now differs.

### Faults

A plugin fault is never the user's decision. A fault is recorded where it is known, as
`fault {node, channel, detail}`: `program` (a program threw, or a unit of an execution did, on that
unit's node, or a unit settled with nothing recorded while waiting on nothing — a livelock no answer
of the user's could end), `role` (a return that failed its schema the same way twice, a dispatch that returned
nothing, a leaf a ruler on a moved base did not rule), `host_error` (a failure the runner could not
classify), `checkout` (the user's `HEAD` or a branch ref moved during a call or a check, or the
watch could not read the checkout: `watch_failed`, whose kept return is not read and whose call
the next run resumes), `launch_failed` (a run that recorded nothing since it last started, or whose
process never started). `git_hung` (a git killed at its ceiling, [The process model](#the-process-model))
shares the channel's record and its hold, and is no plugin fault: the session relaunches past it, and
the same hang again escalates instead. A fault in a run outside an execution names no node, and such a run
records only `program`, `git_hung` and `launch_failed`: a call of its that failed — a moved ref, a schema
failed twice, a failure the runner could not classify — is the `cause` on its `returned` line and
a loss the program's coverage block reports ([Coverage block](#coverage-block)). No `escalated`
event lands, so the node's status is what its last real record says. In an execution the node is
held for the rest of the run — by a fault after the run's latest `run` line, recorded once per node
and channel — which goes on with everything else; develop relaunches once the run ends, and the
next run takes the node up where it stands. The same fault on the same node again is reported as a
plugin defect with what it left undone, never asked as a question.

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
| `expects[]` | leaf: the files the planner expects it to change, optional and empty for a `verify` leaf: a prediction the scheduler, drift detection and the brief read, never a permission ([Role rules](#role-rules)) |
| `reads[]` | leaf: files it builds against and never writes |
| `runs[]` | leaf: the project commands its work runs beyond the established ones and its criterion checks (a codegen, an asset or migration script), each a literal prefix its implementer is allowed (`Bash(<command>:*)`); absent when none was written |
| `deps[]` | node ids whose outputs this node consumes |
| `provides[]`, `consumes[]` | named contracts (`{name, paths[]}`); the prefixes drive [drift detection](#landing-and-drift). A contract's providers form one line: a node may deliver a contract an ancestor promises, at its paths or under them, and is its yardstick; any other second provider is refused (`contractProblems` in `lib/tree.mjs`, which compile and the spec check both apply effort-wide), and a consumer resolves to the promise, the shallowest provider (`promiserOf`) |
| `shared[]` | composite: designated shared files for its subtree (the [coupled lane](#coupled-work)) |
| `rigor` | leaf: see [Rigor](#rigor) |
| `role` | leaf: `none`, `red`, `green`, `audit` |
| `dispatch` | `{producer?, reviewer?}` each `{model, effort}` — set by the node's author (see [Model tier](#model-tier)) |
| `context` | self-contained prose for the executor |
| `retired` | a replan removed it |

Events: `planned`, `replanned`, `dispatched`, `approved`, `merged`, `escalated`, `parked`,
`landed`, `claims`, `noted`, `message`, `outside`, `nets`. A leaf's status is, first match: `merged`; `escalated` or
`parked` when newer than its last replan and last revision (a replan or the user's answer clears
it); `approved` when newer than its last dispatch (a held cycle member is approved and not merged);
`active` while a dispatch has nothing terminal after it; `planned`. A composite is `merged` on its
own event, the root `landed` on its, `escalated` or `parked` on its own open event (cleared like a
leaf's), and otherwise summarizes its children: once all have merged it is `reviewing` until its
integration review stands, then `integrated`. A review stands when the composite's latest `claims`
event is newer than its last clearing (a replan or a revision) and than every `merged` event beneath
it, since each merge moves the head the review judged, and than every `outside` event on the folder
or beneath it, which moves it the same way (`standingReview` in `lib/tree.mjs`). A park an
integration review raised — one whose `said` is the `said` of a `claims` event on the composite — is
cleared by any later `claims` event on it with `review: done`: a new review, a later one ruling what moved, or the
session's acceptance supersedes the verdict the park came from (a `not_earned` one judged nothing
and clears nothing), and a newer one that earns a park records its own after
it. The derived status also carries the composite's `review` — `pending` while `reviewing`, then the
standing event's `done` or `not_earned` — so the review is a step of its own wherever status is
read: a todo and a snapshot entry after the composite's children. Merged children alone never read
as integrated, so nothing lands, merges up or reports a folder finished before its review. A
`reviewing` folder's own work is done all the same: re-approval parks it no more than an
integrated one, and contract drift passes it over. A group summarizes its children the same way,
except that it is `merged` once all of them are: it has no branch of its own to merge and no
integration review.

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
traceability gaps come back as warnings. It refuses; it never repairs. `lib/tree.mjs` has no CLI:
nothing outside compile calls `addNodes`.

### Storage

```
.agentics/                        in the main checkout
  .gitignore                      `*`, written by mkdirState
  config.json                     {max_parallel, max_agents, claude_cli, guidance, design_spend_multiple},
                                  edited by the user
  .state/
    store.json                    the store's version stamp, {version} ([Store stamp](#store-stamp))
    seq, .lock                   the project-wide counter and mutex
    slots/                        the parallelism pool, shared by every execution (see Scheduling)
    runs/<run>/                   one program run outside an execution: run.json, heart.jsonl, state.jsonl with
                                  its seq and .lock, result.json, run.log (a detached child's
                                  output), returns/<dispatch>.json, live/, roles/ (the system
                                  prompts its calls ran with)
    runs/.claims/                 one short lock per program and scope, taken to claim a run
    evidence/                     the evidence item store
                                  ([Evidence item store](#evidence-item-store)): items.jsonl,
                                  returns/<stamp>[-<n>]-<kind>.json, snapshots/<hash>.txt,
                                  anchors/<fnv>.json (a discardable cache of a pinned blob's oid, hash and span windows)
  <effort>/
    DESIGN.md                     the root folder's spec
    <sub-effort>/DESIGN.md        one folder per sub-effort, nested as the plan nests them
    .state/
      effort.json                 {about, roots, opened_at}, written once
      nodes.jsonl                 node revisions, append-only
      events.jsonl                node events, append-only
      ledger.jsonl                approvals, preparations, compiles, dispositions, rulings
      specs/                      the text each folder was compiled from, <key>@<hash>.md
      respec/                     a changed spec's brief and its rulings, <key>@<hash>-<basis>.*
      seq, .lock                  the counter and the effort mutex
      branch.json                 where the effort branch was cut, written once
      cites.jsonl                 each folder's evidence citations ([Cites](#cites))
      knowledge/                  gotchas (see Gotchas)
      executions/<stamp>/         one execution of a subtree, the home of its runs:
                                  execution.json, run.json, heart.jsonl, state.jsonl, journal.jsonl,
                                  result.json, run.log, returns/, live/, roles/, closes/,
                                  reviews/, merges/, gates/, stale-<head>.md and .json
      locks/                      branch locks
```

`lib/store.mjs` computes every name and path; nothing else types one. Every path starts from the
main checkout (`mainCheckout`: git's common directory, or a submodule's `core.worktree`), so a
leaf recording from a linked worktree writes where the next session reads. A directory that is not
the top of a working tree is its own root. Names of efforts, folders and entries follow the
segment rule: `^[a-z0-9][a-z0-9-]*$`, at most 120 characters, no `--`; so no file the store writes
can pass for one. Worktrees live under `.claude/worktrees/`.

Every name minted from something that grows is bounded (`nameKey`). A node appears in a branch
or file name as its **key**: its id with `/` spelled `.`, kept whole up to 40 characters
and otherwise cut to its first 31, `_` and the `fnv1a` digest of the whole. A dispatch in a file
name is bounded the same way; a commit in a file name is its sha's first
10 characters. Ids and labels carry no `_`, so a cut key never equals a whole one. **Why:** a name
built from a nested id or a label that lists every axis outgrows what a filesystem takes — 255
characters for one path component, and Windows' MAX_PATH of 260 for the whole path, which an
atomic write meets with a temporary suffix on top. Bounded, the longest id the id
rule admits leaves every path the plugin mints within both under a checkout as long as
`C:/Users/<first.last>/source/repos/<project>` and a 60-character effort name
(`test/name-limits.test.mjs`).

A worktree's directory is bounded tighter: it is the name of the branch it holds past
`agentics/` — `<effort>` or `<effort>--<key>` — kept whole up to 32 characters and otherwise cut
to its first 23, `_` and the digest of the whole (`worktreeOfBranch`). **Why:** every file the
project checks out in a worktree spends its path's length on the worktree's root first, and a
checkout that runs past MAX_PATH fails without `core.longpaths`, which the plugin does not own.
Named this way, a worktree root under that same long checkout leaves a project path of 150
characters room, whatever the effort's name or the node's depth.

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
before. `approved` is recorded once the user's answer is verified, at the hash its token named
([The user's word](#the-users-word)), or, for a change to a spec compiled before, by a ruling that
the change moves nothing (`by: ruling`, naming its `ruled` line); `prepared` only for a
planner-written spec, naming the review return it passed. The review gate is derived the same way
(`approvalGate`): ratifiable once the latest review of the spec's current text ruled every unit in
scope and each ambiguity it returned has a disposition, from any round, an incorporated ambiguity
counting only once a later `reviewed` line at the current hash lists its section in `clean`. An edit
leaves no review of the new text, so the gate stays shut until one reads it.

`lib/compile.mjs` turns approved and prepared specs into nodes. A folder becomes a composite; a
group, a group node whose tasks' ids sit under it (`<folder>/<group>/<task>`); a sub-effort with
no approved or prepared spec, a design node; a task, a leaf; and a task whose own
folder holds such a spec (task promotion), a composite that carries the task's criteria and must
realise every decision the task did. It appends only what changed, through `addNodes` with
`by: 'compile'`, and records the hash it built from, so a second run appends nothing. A spec
edited since approval is left out, and develop keeps the last approved graph, but its folder's own
node still takes what its parent's entry says of it (`realises`, `after`, contracts, ground,
context): those are the parent spec's to say. A folder is **stale** (`stale` in `lib/approval.mjs`, the
one predicate) while its spec is edited past its latest `approved` or `prepared` line, or while the
`spec_changed` park compile raised on it stands: its children are the plan being replaced. The
schedule, the preflight trace and the integration review's guard all read it. When a spec is
approved again with other text, compile parks every consumer of a contract whose definition the
edit changed (`contract_changed`) — the entries that provide it with their paths and the parts they
declare, and the part of the Design its `provides` declares, or the whole Design when it declares
none (`contractDefinition` in `lib/spec.mjs`), the text it last compiled and the text now both read
under the declaration as it stands now (`declaredPart`); a part the kept text does not hold, or any
change of the declaration, counts as changed, and a plan-only edit parks no consumer. No pattern over the Design's prose ever narrows a definition: code slices
only by the part a spec declares — gives every node realising a changed decision a `decision_changed`
revision, parks the folder when work under it was dispatched (`spec_changed`), and retires the
entries it no longer lists — refusing, by name, one with dispatched or merged work. A parked node
whose spec was approved or prepared after the park gets a new revision (`answered`), which clears
the park. Nothing is written when anything is refused. Compile keeps the text it built each folder
from, by hash, under `.state/specs/`: the next change to that spec is shown against it, and the
copies are the record of every text that was ever built.

**Why:** the user reads and approves a document, never JSON. The graph is derived from what they
approved, so the two cannot disagree about a decision.

### A changed spec

A spec that was compiled and is then edited — an answer to a parked question written into it, a
criterion corrected — is ruled, and the user is never asked to approve it. The `rule` program has
`lib/respec.mjs` brief it inline, the text `rulerBrief`'s (`lib/briefs/respec.mjs`): it previews the
compile of the text as it stands (`compileEffort` with `preview`, which reads the edited spec as
approved, validates the batch and writes nothing) and writes one brief: the change as a diff against
the copy compile kept, every node it reaches, and every spec it names, whole. The spec itself is one
node, ruled with the work dispatched or merged under it and with every stop its approval would clear
— a park compile answers because the spec owns the node, a stop on an entry that gets a new
revision, wherever it is stated — each with its question. Every consumer of a contract it provides,
merged ones included, and every node realising a decision whose text changed is a node of its own
when another spec states it. Any other node that already waits on the user is listed and not ruled.
The brief also holds, in the user's words, every answer recorded on the effort since the spec's
latest approval ([The user's word](#the-users-word)), and puts each of the user's choices the change
makes to the ruler as a unit of its own (`userBound`): `decision:<id>` for a Decisions row added,
changed or removed, `contract:<entry>` for the contracts an entry provides changed, `park:<node>`
for a `needs_decision` or `contract_changed` park it clears. Of a question answered more than once,
only the latest answer is held. The `rule` program hands the brief, with the repository's guidance, to one ruler as its
prompt, pointing it at no file; the ruler returns a ruling per unit (`ruler_respec`) — `unaffected`;
`answered`, citing the answers that settle how the change moves it; or `affected`, with the
question its owner must answer, and a `fix` when the new text itself dictates the edit — and the
program writes the rulings to the brief's rulings file and settles. A choice of the user's ruled
`unaffected`, or an `answered` ruling citing no answer the brief held, is refused. Rulings that settling refuses go
back to the ruler's session as a `refusals` message, until a refusal repeats. A brief past what the
ruler may read ([The agent runner](#the-agent-runner)) is never sent, and ruling again would build
the same one: the program is refused `shrink_brief`, its `why` the part, its file and size, ending
on who makes it smaller — the user, who shrinks or splits the spec or guidance file it names.

Rulings are bound to a **basis**: a digest of the text ruled, the units and the nodes' revisions,
the other specs the brief names, the work under the spec, the stops it would clear and the answers
it was ruled against. The brief and
the rulings file are named by it, so when any of that moves on there are no rulings to settle
from and the change is briefed and ruled again. Settling (`respecSettle`, as the `rule` program
runs it) takes the rulings only whole and records them as a `ruled` ledger line, a new one
whenever the basis or a ruling differs. When no unit is `affected`, it records the approval —
`by: answer`, naming the answers it rests on, when a unit was ruled `answered`; `by: ruling`
otherwise — naming that line, and compiles. Compile reads the
ruling the approval names and spares every node it found `unaffected` or `answered` the
`spec_changed` and `contract_changed` parks (`spared` in its result), so any compile of that text
honours it and no stop is written only to be cleared. Otherwise settle returns `needs_user` with
each `affected` unit and approves nothing: the session makes each `fix` in the spec that owns the
unit and has that spec ruled the same way, asks the user the questions left in one batch, records
their answers, carries them into the specs they reach and rules again. An approval recorded and not
yet compiled is compiled by the next `settle`, or by any compile.

A relaunched `rule` run replays only what was recorded for the text, the answers and the reach
that stand: it briefs the spec afresh, and the ruler's thread (`ruler:<basis>`), the rulings it
wrote and each settle are keyed by the brief's basis, so a relaunch over the same basis calls no
ruler that returned and one over a moved basis rules the spec as it now stands.

What cannot be ruled is refused with what to do next (`next`): a spec never compiled, or whose
compiled text was not kept or cannot be diffed, is the user's to approve; one with problems is
edited; one whose parent spec is edited waits for the parent; a planner's spec is re-derived, or,
edited by the session, reviewed and prepared by the next execution tick.

**Why:** most edits to an approved spec move nothing built on it, and the ones that move a decision
or a contract are the user's answer written into a spec. Asking the user to approve that edit asks
them for the same choice twice. A decision or a contract is still the user's whatever a ruler
finds, so a change to one is approved only on an answer they gave, and a ruler checks that the
spec states what the answer chose and no more. The approval is nobody's own verdict (L3): the
session that made the edit does not rule on it, and code approves only when no ruling is
`affected`. What was approved this way is on the ledger — the `answered` lines in the user's words,
the `ruled` line with every ruling and the stops the approval cleared, the `approved` line that
names both, the brief and the kept text on disk — so it can be read back and overturned by another
edit.

### The ledger

`lib/ledger.mjs` is the only writer of every `.jsonl` under an effort. It mints `seq` per effort
under the effort's lock — a script minting a counter, so no agent ever supplies one, and a
`seq` that arrives on an entry is overwritten — and refuses a batch that does not parse, has an
entry without a `kind`, or fails its caller's digest. Appends are all or nothing and never
read-then-write. Readers are tolerant: a torn line is counted, never thrown on. A log whose last
line a killed writer tore gets a newline before the next record, so the next record stands whole on
its own line, in every log `lib/ledger.mjs` appends to.

No record of an execution reaches the ledger through a model. The code that decides or observes
a line appends it, in the process that ran the action: a boundary recording what it computed from
the runner's stored returns ([Boundaries](#boundaries)), the runner recording a call, a measurement
journalling what it saw.

### Integration branches

Integration is assigned **per composite node, dynamically**. A composite gets its branch and
worktree the first time something needs them, cut from its own parent's integration head, and is
brought up to date with that head whenever the parent has moved — which is how a dependency merged
elsewhere in the tree reaches the leaf that consumes it. Its children branch from it and merge into
it. When its last child has merged, its head passes the [suite gate](#the-suite-gate) and its
integration review is done, it merges into its parent's integration branch like any child. A group
has no branch: its tasks are cut from and merge into their folder's, and a composite promoted inside
a group is cut from that folder.

A leaf follows its parent the same way. Every leaf-open merges the parent's integration head into
a leaf branch that does not hold it, and that head becomes the leaf's base: the series is still
the leaf's own commits, a tdd leaf's new tests still fail at its base, and whatever reached the
parent since the cut is in the tree the leaf is measured on. A clean refresh merge changes nothing
of the leaf's own, and the series check, which reads a merge by what it changed beyond git's remerge,
finds nothing in it; a resolution is the leaf's work. A cycle member takes its parent only at the cut, with
the merge as its base: it is cut from its predecessor's head, which the parent does not hold, so a
later refresh would count its predecessor's commits as its own. The one exception is a rebase round of
the cycle's tip, which a conflict sent: it takes the parent's head so its implementer can resolve the
conflict, and its series is measured from what that merge brought (`MERGE_HEAD`) and, once concluded,
from the parent head it took (`leafBase`), never from the merge itself. A cycle member's series
always leaves out its predecessors' approved heads by name (verify's `exclude`): their commits ride
on its branch but were judged under their own role, so the series check reads only the member's
own. Its net diff is read from that base (`netBaseOf` in `lib/verify.mjs`), or, where a rebase round
took it past its cut — a base that does not hold its predecessor's approved head — from the tree
`git merge-tree --write-tree <predecessor's approved head> <the head it took>` writes: its branch
without its own work. A conflicted remerge (exit 1) gives the conflicted tree, which is exactly that
base, so a resolution is the member's change; any other failure is `series_unreadable`. So a green
and an audit are judged on their net diff like any leaf, and their `tests_rewritten` is named.

The base is read off the branch, never carried from the call that made it (`leafBase` in
`lib/integration.mjs`): the oldest commit on the leaf's first-parent line, from where it left its
cycle predecessor, that holds what it took from its parent. leaf-open is re-run after any
crash, and resume starts from git alone; an open that did the refresh and one
that finds it done must name the same base, or a replay measures the parent's commits as the
leaf's. Every leaf-open records it, and each round is measured from the one its open recorded.

The effort root's integration branch, `agentics/<effort>`, is the effort branch: the one landed
into the user's branch. Every other node's branch is its sibling, `agentics/<effort>--<key>`,
the node's key as [Storage](#storage) mints it. **Why not `agentics/<effort>/<id>`:** git stores a
branch as a file under `refs/heads/`, so `agentics/e` and `agentics/e/auth` — or `auth` and
`auth/session` — cannot both exist. Node-id segments carry no dot and effort names carry no `--`,
so no two nodes share a name; nothing reads an id back out of one. A worktree is named after the
branch it holds, bounded tighter ([Storage](#storage)).

A leaf's worktree lives until the leaf merges. merge-batch removes it, clean, with the merge
(`detach` in `lib/integration.mjs`); its branch stays until [landing](#landing-and-drift) sweeps
it. A merged leaf has nothing left to run in a worktree, and resume
reads git refs, not the checkout. A dirty one is never forced: preflight reports it, and removes
any clean one merge-batch did not reach.

- **Concurrent executions** are allowed on any disjoint subtrees of the same effort. Preflight
  refuses only an execution whose root is an ancestor or a descendant of an open one (checkpoint
  `existing_execution`).
- **Expected files are a schedule, not a lock**: two leaves that expect one file are kept apart by
  the scheduler while it can, and work of two folders that meets before it merged goes to the judge
  at the merge ([The judge](#the-judge)).
- **Merges into one integration branch are serialized** by a lock on that branch, whichever
  execution performs them.

### Outside work

A person works in the repository between executions: commits on a folder's integration branch,
merges a branch into it by hand, starts a leaf's series on a branch of their own. Agentics cannot
tell from git what such work is, and does not guess. The user says what it is, the records then
carry the user's word, and a folder review judges it afterwards: the trust model is the user's word,
then review (L3), and the review is the folder's, because that is where the adopted leaves meet the
rest of the folder.

The mapping the user's word covers has four shapes:

- **`done` with `commits`**: this leaf was finished by these commits, which the folder's branch holds.
- **`done` with `branch`**: this leaf was finished by a branch the folder's branch merged by hand.
  Its commits are what that merge brought in: `rev-list <tip> ^<M>^1`, `M` the first commit on the
  folder branch's first-parent line that holds the tip. A tip that is itself on that line (a
  fast-forward, or straight commits) shows git no fork point, and the entry is refused `empty_entry`
  with the message to list the commits instead.
- **`outside`**: commits on the folder's branch that belong to no leaf.
- **`handover`**: a branch holding a leaf's series, unfinished; the leaf carries it on. Its commits
  are `rev-list <tip> ^merge-base(<tip>, <folder head>)`.

The call is `lib/boundary.mjs adopt --repo <r> --effort <e> --folder <id> --map-file <path> --action
check|act` ([Session calls](#session-calls)). The folder is a live composite, a design node or the
root, and an adopted leaf merges into it. The session writes the mapping file as JSON,
`{done: [{node, commits[]} | {node, branch}], outside: [{commits[]}], handover: [{node, branch}]}`,
each section optional and at least one entry in all; a `done` entry has `commits` or `branch`,
exactly one. A sha may be abbreviated. The call takes handles only (ids, shas, branch names, a
path): no free text reaches a record through it. `check` reads git and the records, writes nothing,
and reports; `act` is the user's: `adoptAct` asks the question that contains the check's token
([The user's word](#the-users-word)), then recomputes the check, refuses on any refusal and on a
digest other than the one its token named (`head_moved`), creates the branches, and appends every
record in one batch.

What `act` records, every record naming no execution (`execution: ''`) and carrying `by`:

| entry | records |
|---|---|
| `done` | `merged {node, into: <folder branch>, merged_sha, head_sha, by, commits[]}`: `commits` in folder order, `head_sha` the last of them, `merged_sha` the first commit on the folder's first-parent line that holds it. The leaf is `merged` from then on, whatever it was before. |
| `outside` | `outside {node: <folder>, commits[], by}` |
| `handover` | `noted {node, by, text}` naming the source branch and its head, and the leaf's canonical branch (`branchOf`) created at that head; the next execution's leaf-open attaches to it, and the session meets the note as a `notes` message ([Conversations](#conversations)). When the leaf is a green or an audit whose cycle predecessor the same batch adopts by `done`, and that predecessor has no canonical branch, one is created at the predecessor's adopted `head_sha` too, because leaf-open cuts a cycle member from its predecessor's. A branch that exists at the same head is left as it is. |

**The check refuses, and repairs nothing.** A refusal is `{entry, kind, message}`, `entry` naming
`done[0]`, `outside[1]`, `handover[0]` or nothing for the mapping or the folder. The kinds:

- `bad_mapping`: the file is unreadable, not JSON, or not the mapping's shape; `empty_mapping`: it
  adopts nothing; `empty_entry`: an entry names no commit, or a `done.branch` shows no fork point.
- `not_a_folder`: `--folder` is no live composite, design node or root; `no_folder_branch`: its
  integration branch does not exist, so nothing is on it; `run_live`: an execution whose root is the
  folder, above it or beneath it is running.
- `unknown_node`, `not_a_leaf` (folders are not adopted: their leaves are, and the folder follows),
  `not_in_folder` (the leaf merges into another folder), `already_merged`.
- `unknown_commit`, `unknown_branch`: git resolves no such commit or branch.
- `not_on_folder_branch`: a commit the folder's branch lacks, or one its cut holds (the effort's
  base, what the parent holds, what a hand refresh from the parent brought in), for `done`,
  `outside` and `done.branch` alike; those are the ground the folder stands on, not its work.
- `claimed_twice`: a node or a commit named by two entries, or a commit a record already accounts
  for (a `merged` event's `commits`, `merged_sha` or `head_sha`, an `outside` event's `commits`).
- `cycle_order`: a green or an audit whose predecessor is neither merged nor adopted in the batch.
- `branch_exists`: a handover leaf's canonical branch exists at another head than the handed branch.

A passing check reports what the user should see before answering: `role_breach` (files an
adopted leaf's commits touched that its role may not change, [Role rules](#role-rules)), `clears_stops` (an adopted leaf that
was escalated or parked: adopting ends the stop), `deps_open` (dependencies that are neither merged
nor adopted in the batch), `criteria` (the criteria of each adopted leaf, none of which anyone has
judged) and `unaccounted` (what the folder's branch would still hold that no record accounts for,
once these records stand, so the user sees a mapping that covers part of it, or a read of git that
failed). The `token` is `adopt <folder>@<digest8>`, the digest over the normalized mapping (full
shas, each entry's commits in folder order) and the folder branch's head.

**Accounted commits.** `unaccountedOf` in `lib/integration.mjs` walks a composite's integration
branch along its first-parent line, from its cut to its head, and returns the commits no record
accounts for, a merge reported by its own sha. The cut of a composite is the merge-base of its
branch and its parent's. The root's cut is `rootBase`'s: `branch.json`'s when agentics cut the
effort branch, else the newest execution envelope's base, because an effort branch that existed
before the first execution has no `branch.json`; and the root's walk also leaves out every commit
the base branch's head holds, which is the user's ground fast-forwarded onto the effort branch, not
outside work. A commit is accounted when, first match:

1. a `merged` or `outside` event names it in `commits`, or it is a `merged` event's `merged_sha`;
2. it is a merge, and every parent after the first is an ancestor of the parent integration branch's
   head (the base branch's, at the root): the refresh merge a leaf or a composite takes from above;
3. it is a merge, and every commit the merge brought in (its later parents, less its first parent
   and less the heads below) is named by a record as in rule 1. The heads are every `merged`
   event's `head_sha`, every `approved` event's `head_sha`, and the branch head of each composite
   among the folder's units. This accounts a leaf's merge-batch commit whatever the series was.

The `merge-observed` journal line is not one of the heads: its `head_sha` is the integration head
after a batch, so it would account every hand commit a later batch sits on top of. The `approved`
heads and a merged composite's branch head close the window in which a batch merged and died before
its `merged` events were written. A leaf's own branch is no witness at all, since a person can
commit on it. A git read that fails is an `error` of the result, never an empty list (L1).

**Who reads it.**

- **Preflight** reads every integration branch in its execution's scope for unaccounted commits
  before anything else, stops at `outside_work` (never confirmable) when it finds any, with the
  branches on the checkpoint's state line, and refuses `unreadable_branch` when git cannot say. To
  proceed, the user adopts them and relaunches ([Resume and checkpoints](#resume-and-checkpoints)).
- **Lost merges.** A `merged` record is trusted only while its integration branch holds it.
  Preflight, before every other checkpoint, stops at `integration_lost` (never confirmable) when an
  integration branch in scope is gone or no longer holds its latest recorded merge (`lostMerges` in
  `lib/integration.mjs`), naming each merged head and the local branches that hold it; and no
  integration branch a `merged` record names is ever cut again from its base (`ensureOne`), which
  would drop that work without a word. To proceed, the user restores the branch, or, when their
  branch holds the work, records its landing.
- **Drift for adopted records.** An adopted leaf's files, and an `outside` event's, can move what a
  node not yet merged consumes; they are ruled once per record
  ([Landing and drift](#landing-and-drift)).
- **The folder review** judges what the folder holds that no agentics review judged: an adopted
  leaf is unreviewed whatever its rigor, adopted leaves and `outside` commits earn the folder's
  review, and the review's brief says which part of the folder a person did
  ([Executors and review](#executors-and-review)). An `outside` event on the folder or beneath it
  voids a standing review, as a `merged` beneath it does ([Nodes](#nodes)).
- **Visibility.** The todo reads `merged (adopted)`, the snapshot's `event` and the node card say who
  adopted what and which commits, and the landing view ends with the section "Work agentics did not
  build" ([The node card](#the-node-card), [Landing and drift](#landing-and-drift)).

**Out of scope.** A whole folder cannot be adopted in one entry: its leaves are, one entry each, and
the folder follows through its review. Nothing undoes an adoption; the event log is append-only.

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

### Removals

A **removal** is an item that only deletes what nothing reads once it is gone: the code, with the
tests, docs, imports and registrations that name it, and any guard whose target is deleted with
it. It is planned as tasks, never as a sub-effort, however many files it spans: one `verify` task
proving the premise, then `trivial` delete tasks, one per concern, each `after` it. The verify
task's criteria run ``! git grep -nwF -e <name> -- . ':(exclude)<path>'`` for every name the
deletions remove, over the tree outside the deleted paths, and the build and the suite. A name
built at runtime escapes the grep, and the spec's Evidence says so. A deletion that takes away
behaviour something still reaches, or a guard whose target stays, is not a removal.

**Why:** a removal has no approach to discover. Whether anything still reads a name is a query (P2),
so the grep, the build and the suite are its evidence, and a planner-written sub-effort would buy a
survey and an autonomous review to answer it by judgment — and a review whose findings the planner
must incorporate grows a plan that should only shrink.

### Atomicity: when to stop splitting

A **leaf** is the smallest unit of work: one commit series, or — for a `verify` leaf, which writes
nothing — one recorded check. A node is a leaf when **every** condition holds, and is split while
any fails:

1. **One concern.** Its change can be stated as one commit subject without a conjunction.
2. **One rigor and one role.** A single [rigor](#rigor) applies to all of it, and it is authored
   by one agent role.
3. **Its own files.** It names the files it expects to change (`expects`), so the scheduler keeps
   two leaves that expect one file from running side by side; a leaf that builds on another's file
   is ordered after it by a dependency, and a designated shared file goes to the
   [coupled lane](#coupled-work). A prediction, never a fence: a leaf changes what its work needs.
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
7. **Fits one executor.** Brief + expected files + reads fit the executor model's context budget
   with headroom for its turns, computed by script from file sizes, at the bytes a token a first
   read measured (`BYTES_PER_TOKEN` in `lib/roles.mjs`), and the model's limit. The brief itself
   is checked again when a round builds it: one past its budget is never sent, and the leaf goes
   to its planner as a `decompose` ([Replanning](#replanning)).

Conditions 2, 4 and 7 are computed by `lib/atomicity.mjs`; 1, 3, 5 and 6 are judgment and are
never reported by a script, because a script that claimed to check "one concern" would be a script
whose silence meant nothing.

**Stop.** A node that satisfies all seven is not split further. A split that yields a child failing
4 or 5 is forbidden. A node that fails a condition and has no permitted split — for example a
change to a closed set whose every consumer must change with it — is **`unsplittable`**: it expects
every consumer, and if that breaks condition 7 it escalates, naming the condition.

**Recovery grain.** An executor commits at every passing step and marks an unfinished series with a
checkpoint commit (the `agentics-checkpoint` trailer), and its session is resumed where it stopped,
so an interruption costs at most the turn it cut off, whatever the leaf's size.

**Why:** the leaf is the recovery grain, the review grain (one reader judges it whole) and the
parallelism grain (leaves that expect disjoint files run side by side). All three want the smallest unit that is still
independently correct.

### Replanning

A leaf's producer or a planner returns one of these instead of finishing; a ruler's `affected`
([Landing and drift](#landing-and-drift)) is handled as a `premise_mismatch`, and a dispatch of a
leaf refused `brief_too_large` for a part of the leaf's own work ([The agent
runner](#the-agent-runner)) as a `decompose`, the refusal its text (`tooLarge` in
`lib/programs/execute/leaf.mjs`); a part only the user can shrink, such as a `CLAUDE.md`, never
reaches the planner, whose own brief carries the same file. A split always revises the asker, so the
refusal is journaled with the leaf's revision, its folder, the part and its bytes; a leaf of that
folder revised since, refused on the same part again, escalates `replan_not_converging` instead of
asking the planner again — its split left the part as large as it was:

| return | meaning | who acts |
|---|---|---|
| `decompose` | the task violates atomicity | the folder's planner, when it wrote the folder: it rewrites the folder's spec, the task split into entries that realise every decision it realised; a folder the user wrote parks the leaf `needs_respec` |
| `unsplittable` | no permitted split exists | the same: the planner widens the entry or escalates; a folder the user wrote parks the leaf `needs_respec` |
| `premise_mismatch` | the brief's premise does not match the code | the same: the planner re-derives the entry; a folder the user wrote parks the leaf `needs_respec` |
| `needs_decision` | condition 6 failed | the user |
| `contract_changed` | a `provides` contract cannot hold as written | the user — a contract is a decision |

The planner answers a leaf's request in the folder's one planner session (`planner:<folder>`),
writing the folder's spec and nothing else: `needs_context` reaches it as its message, any other
request as a brief of its own. No planner writes a spec outside its own folder,
so a task is promoted only by a spec the user writes. The answer goes through the
[autonomous review](#autonomous-review) and is compiled; a replan that leaves the asking leaf at
the revision it asked from escalates `replan_not_converging`, unless it answers a verify finding
with a changed spec (below; `replanOf` in `lib/programs/execute/folder.mjs`), and a request whose planning ends on
a fault is a `program` fault on the asking leaf as well. The request stands while the asking leaf is
at the revision its round was dispatched on and no retry cleared it: a relaunch rebuilds it from the
round's close record and stored return (`routeOf` in `lib/boundaries/leaf-close.mjs`) and sends it
to the planner again, never opening a round whose producer would have nothing to be told. A verify task's finding replans its folder
the same way: the planner rewrites the folder's spec when the planner wrote it, and the folder
parks `needs_respec` for the user when the user did. Under a planner's folder the finding is the
route: leaf-close records no escalation of the leaf, so none outlives the planner's replan, and the
leaf is measured again against the folder as replanned: an answer that changed the spec but not the
verify leaf clears the leaf (`replanned {reason: spec_answered}`), so it is never routed to the same
plan again, and one that changed neither escalates `replan_not_converging`. Under a folder the user wrote the leaf is
escalated `verify_finding` beside the park. Every spec the planner writes passes the autonomous
review before compile builds from it.

**A user-bound return parks the node.** An execution cannot talk to the user, so it keeps running
every task that does not depend on the parked one, and the session's watch asks the user at once
([Progress](#progress)). **The answer is a re-spec:** the session edits the spec that owns the
fault (a decision only ever goes into a spec the user wrote), the user re-approves it, and compile
writes the revision that clears the park (its result's `answered`), which the running program picks
up at its next tick. A park no spec change answers (a `contract_drift` the user rules unaffected)
is cleared by `retry`.

**Autonomous replans preserve decisions.** The planner may split, merge or re-derive nodes only
while every decision id stays realised; anything else is user-bound. `lib/tree.mjs` `addNodes`
enforces it for every writer: a batch may state or change a `defines` entry only from compile, as
the approved copy on the ledger states it; a changed contract is admitted only from compile, on a
node whose entry sits in a spec the user approved — but a contract added to what a node consumes,
which declares a dependency and moves no provider, is admitted from any replan, while one it
consumed must stay, at its paths; and a decision a leaf or a design node realised
before must be realised by one after, unless a `dropped` entry of a spec the user approved gave it
up. The planner returns `needs_decision` or `contract_changed` instead. Replans append
`replanned` events; nothing is rewritten, and merged work stays. A replan that leaves a leaf exactly
as it was escalates as `replan_not_converging` rather than sending the same executor back to the
same wall.

---

## Execution modes

| mode | earned when | what runs |
|---|---|---|
| **inline** | every leaf is `verify`, `trivial`, `tests-only` or `tdd`, the files it changes are known, the intent settled, nothing is irreversible, and the leaves' summed fit (condition 7's computation) is within the session model's budget | the session does it — see [The simple task](#the-simple-task) |
| **dispatched** | anything else | an execution: worktrees, producers per rigor, boundaries, review per rigor, dynamic merge |

A composite may run inline when all its leaves qualify. What stands behind a leaf follows its
rigor, in every mode: from `tdd` up, the check that each new test fails without the change and an
independent reader (inline, one fresh reviewer over the diff, the `review` program's); a `trivial`
leaf, its named check and — when dispatched — the integration review; a `verify` leaf writes
nothing, and its recorded check is its product.

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
- **An independent reader from `tdd` up.** The session writes the criteria — the todo list, one item
  per line with its check, `HUMAN:` lines kept — to a file outside the repository with its Write
  tool, so the snapshot does not hold it, and starts `run.mjs review --base <the commit the change
  started from> --criteria-file <file>`. The program snapshots the working tree onto `HEAD` through
  a temporary index (`GIT_INDEX_FILE`, which `git` in `lib/store.mjs` takes in its environment; `git
  add -A`, `write-tree`, `commit-tree`; `.agentics/` and `.claude/worktrees/` left out) under
  `refs/agentics/review/<run>`, so the user's tree, index and stash are never touched (the temporary
  index is removed whether or not a step fails), and runs one fresh reviewer in a throwaway worktree
  at the snapshot (`.claude/worktrees/review-<run>`, removed when the call ends; the ref is kept as
  the record the result names). The reviewer's units are each criterion and each file the change
  touches; a `HUMAN:` line is the user's and gets no unit. The exit is computed (`reviewExit`):
  `approve`, `fix` or `escalate`. A unit the reviewer did not rule is an open critical
  (`unit:<unit>`) and listed incomplete, so a reviewer that failed (the `reviewer` channel) leaves
  every unit open; a `--prior` run that left no exit is named in `unreached`, and its findings are
  not ruled again. Every critical is fixed before the task is claimed done, and the re-check is the
  same review with `--prior <the previous review's run>`, whose open findings the reviewer rules in
  `fix_rulings`, until it approves; `escalate` tells the user the loop does not converge.
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
| `tests-only` | only adds tests to code that is already correct | one test-author leaf | each new test passes now, and its file fails under a mutation the test-author declared |
| `tdd` | adds behaviour whose expected results the criteria state exactly | one implementer leaf, test first | at least one test file adds a test case, and each that does fails at base and passes now; one that adds none (upkeep: existing tests kept working) passes now |
| `tdd-pair` | adds behaviour where a wrong reading of the criteria would pass its author's own tests: edge-case rules, parsers, state machines, concurrency, contracts other nodes consume | a `red` test-author leaf, then a `green` implementer leaf | red: its tests fail for want of the implementation; green: they pass, the tests untouched by its implementer; a test gap is a test-author round of the green |
| `tdd-triad` | as `tdd-pair`, and a miss ships silently into durable state or is costly to find: persistence formats, migrations, data loss, security, money | red, green, then an `audit` leaf | as `tdd-pair`, plus every mutation the auditor declared and the measurement applied is killed — by the cycle's tests, or by the tests a test-author adds in the audit's later rounds |

**Would a test only restate the diff?** A test of a `trivial` change asserts that the value
written is the value written. A `tdd` change has a result the diff does not state literally — a
computed value, a branch taken, an error raised — and that result is what its test pins. Unsure
between `trivial` and `tdd`: `tdd`, unless the typecheck already fixes the shape and the leaf wires
existing parts: `trivial`.

Unsure between `tdd` and `tdd-pair`, weigh the cost — a pair is two producers, a review loop and
a consolidation round: `tdd` when the leaf is small, and whenever the types fix the shape and the
unit is wiring, even a contract's; `tdd-pair` otherwise.

**Tests are owned, not counted.** Every criterion that names behaviour is owned by a test that
names the mistake it catches; one test may own several, and a criterion the typecheck, lint, the
build or an existing test already owns gets no new test, its owner named in the author's return.
Nothing sets a floor of tests per criterion, and the same rule — verbatim in the test-author's,
the reviewer's and the auditor's roles — says what earns none:

<!-- agentics:verbatim no-test-earned -->
A test earns its place by naming a mistake it catches that no other test or tier already catches.
None of these does: a claim a type already enforces; a table compared to a copy of itself; a test
of a test helper; a tuning constant or other derivable value read back as a literal; a pin on
source text; that something merely exists or has a shape; a second assertion of a claim another
test, the typecheck, lint or the build owns. When the repository's guidance names a testing guide,
read it before you write or judge a test: its rules hold beside these.
<!-- /agentics:verbatim -->

Feedback runs both ways: a judge that finds a test this covers raises it for retirement
(`remedy: retire`, [Executors and review](#executors-and-review)), and an auditor declares only a
break a competent author would plausibly make on that line, naming in `expect_failing` every test
of the suite that catches it, so a break another test already kills asks for no new one.

- **`tdd-pair` and `tdd-triad` are separate leaves** with `deps` (green on red, audit on green),
  each with its own branch, todo, review and resume action. Green is cut from red's branch and
  receives red's committed tests as artifacts, never red's return. No agent authors both a
  behaviour's tests and its code. Red writes the test files and, where the repository's typecheck
  covers tests, the files green builds: red writes those as signatures whose bodies throw, so its
  tests compile and fail for want of the behaviour, and green fills the bodies in. What keeps red
  from implementing is the measurement — its tests must fail now — and what keeps green off the
  tests is its role's rule ([Role rules](#role-rules)), enforced by its permissions and checked by
  the series' `role-breach`. The cycle's tests, which a green is measured on, are the test files
  the red's branch changed (`cycleTests` in `lib/integration.mjs`), read from git.
- **A cycle lands as a unit.** Red is held on approval; its cycle merges together, through its
  tip, once the last member is approved, so the effort branch is never red.
- **Mutations are declarations.** A test-author or auditor declares `{file, find, replace,
  expect_failing}` in its return; leaf-close applies them in code and restores the file. A
  `find` matching zero or several times refuses, pointing at the declaration. A declaration is
  written against the committed blob and a checkout may hold the file with other line endings
  (`core.autocrlf`), so a `find` that does not occur as written is matched in the file's own line
  endings, and `replace` is written in them (`substitute` in `lib/verify.mjs`); excerpts handed to
  agents carry no carriage returns (`rangeExcerpts` in `lib/citations.mjs`).
- **A mutation once applied is never dropped.** A leaf measured by its mutations (`tests-only`,
  `audit`) is measured, every round, on each mutation an earlier round of it applied, beside the
  round's own declarations (`heldMutations` in `lib/verdict.mjs`, from the journal), so a mutation
  its tests let through stays until a test catches it: a gap-closing test is shown to fail on the
  very break that found the gap. A declaration that could not be applied is not held: it is a
  defect in the declaration, not evidence about the tests. Other rigors apply their round's
  declarations alone, because their implementation moves and an old `find` with it. The mutations
  held, and the audit's gap below, are read from the leaf's `verify-observed` lines of every
  execution, as resume reads them (`journalsOf`).
- **Every new test is shown to catch something.** A `tests-only` leaf's test file that adds a case
  is named in the `expect_failing` of a mutation that bites, or the leaf fails.
- **A cycle's test gap is closed inside the cycle.** A gap in the cycle's tests found after the red
  is approved — by an audit's mutation, by a green's review, by a green's implementer — goes to a
  test-author round of the leaf that found it, never to an agent that cannot write tests and never
  to the planner as new children, which would test against breaks of their own choosing.
  Leaf-open derives each round's role and thread from the records, and leaf-close and resume read
  it back off the round's dispatch:
  - **An audit.** From the first measurement in which the cycle's tests let an applied mutation
    through (`auditGap`), every later round goes to the cycle's test session instead of the auditor,
    as a `surviving_mutations` message ([Conversations](#conversations)). Its fix
    round lists each surviving mutation, its text and the tests it names, and the audit approves
    only once every held mutation bites. A round that went back to the auditor could only
    withdraw the mutation.
  - **A green** (`greenRoundRole` in `lib/verdict.mjs`, from the close and the review of the round
    before; a review that escalated and whose stop the session cleared counts as a fix's, so its
    open set routes the retried round). The cycle's test session when the implementer returned
    `needs_tests`, when every blocker the review left open has `remedy: tests`, or when a
    test-author round's measurement failed only on what it wrote (its mutations, its series); an
    implementer otherwise. A unit the reviewer left unruled (`unit:<u>`, `unruledUnit` in
    `lib/verdict.mjs`) is the reviewer's miss, never a producer's finding, and weighs on neither
    choice. A mixed open set goes to the implementer first, with the tests' findings listed as
    carried, then to the cycle's test session once only they remain. A test-author round never reads
    the implementation, so it is not asked to break it: each new test file fails at the round's base,
    the red's head where the implementation is its stubs, or is named by a break listed to it that it
    redeclares and that bites (the `green-tests` profile, [Verification](#verification)).
  - Either way the round writes test files and nothing else, never at the cost of a test the cycle
    approved (`test-removed`) but in the consolidation round below. Its permissions admit only test
    files ([Role rules](#role-rules)); leaf-close commits only those, journals the commit as
    `authored`, and the series check holds each such commit to the test-only rule and every other
    commit to the leaf's own role, so neither producer writes the other's files.
- **A cycle ends in one consolidation round.** When the review of a cycle's last member (the green
  of a pair, the audit of a triad) would approve it, `leafReview` records a `consolidate` message to
  the cycle's test session instead (`consolidationDue` in `lib/verdict.mjs`: once per leaf since its
  latest replan), carrying every test the cycle's judges asked to retire — the `retire` of each
  review record of a member and of each auditor return — and the mutations an audit holds. Its
  round goes to the test session (leaf-open), which merges cases, shares fixtures and retires
  red-step scaffolding and tests that earn nothing, and redeclares the audit's breaks whose tests it
  renamed or merged; blind to the implementation, it declares none of its own. It never holds the cycle up: leaf-close approves the leaf at the head as it stands when
  the round returns another status than `done` or `done_with_concerns`, or writes nothing; measures a commit by the `consolidation`
  profile — no approved case binds it, while its tests pass and every mutation it redeclared and every
  one the audit held bites — and approves it there when it passes; and when it does not, reverts the
  commit with a new one (`git revert`, journalled `authored`) and approves the tree the review
  approved, the measured failures on the close record (`consolidation_dropped`). A revert git
  refuses escalates `consolidation_unrevertable`. No review follows: the code did not move, and
  the measurement is the guard.
- **Review follows rigor.** `tdd-pair`, `tdd-triad` and any leaf that `provides` a contract get a
  review loop of their own; `trivial`, `tests-only` and `tdd` leaves are reviewed at integration;
  `verify` leaves write nothing to review.
- **A fix round** goes to the leaf's producer, its session resumed with the findings
  ([Conversations](#conversations)): on a green or an audit, to whichever the records name above;
  on any other leaf, to its one producer, which owns its tests and its code. After a round that
  cleared none of its blockers, the next is a fresh session on the raised tier.

**Why:** assurance should rise with the cost of a wrong reading, and the cheapest assurance that
closes the specific hole is the right one. Tests are paid for again on every later read and run,
so a test that catches nothing another tier does not is cost without assurance, and only a
ratchet that can also retire keeps a suite at what it catches.

---

## Design

An effort is a folder hierarchy under `.agentics/<effort>/`, and each folder holds one spec,
`DESIGN.md`: the user's document, with fixed headings (Intent, Decisions, Design, Plan, Open
questions, Evidence) and three parsed forms (Decisions rows, graded open-question bullets, plan
entries). A spec never holds status. The `design` skill runs one loop for one folder at a time,
at any depth, and each stage writes what it settles into the spec at once.

| stage | what happens | gate |
|---|---|---|
| Analyze | write back the understanding; survey this layer's question, and search for existing solutions when it would build a capability, the two programs side by side; cite every item their runs returned in one `lib/evidence.mjs cite --from-run` | the user confirms or corrects the understanding |
| Grill | one question at a time, recommendation first; each answer is a Decisions row at once; a cheap choice nothing consumes is defaulted and ruled with the rest at Review; approach drafts when the decision space is open, from the `drafts` program, each recorded as it returns | no `blocking` question is open |
| Draft | Design and Plan at this layer's level of detail, shown section by section | `lib/spec.mjs check` passes; no decision is unrealised |
| Review | the `probe` program when earned (by length, or a contract other entries consume); a second round, earned by a resolution that reshaped the design, narrowed by `--since`, the previous round's snapshot; a partial round that left only units open finished by the next narrowed round, and one that lost a channel, ground or a finding probed whole; every round recorded from its run (`lib/approval.mjs reviewed --from-run`); its findings settled with the user, incorporated or discarded, each a recorded disposition, an ambiguity discarded only on the user's ruling, each settled by one edit in one place; then the user reads the spec | `lib/approval.mjs gate` ratifiable, or the review not earned; and the user's answer chose `Approve` |
| Approve | a spec never compiled: `lib/approval.mjs approve`, which confirms the user's answer, then `lib/compile.mjs`; a spec compiled before: the `rule` program, which approves the change by ruling or hands back the questions the user must answer ([A changed spec](#a-changed-spec)) | — |
| Move on | `lib/next.mjs` offers: design a sub-effort, develop, or stop | the user picks |

- **Which folder.** `/agentics:design <words>` matches the words against every folder's name and
  title (`lib/next.mjs folders`). One match resumes that folder at its earliest unfinished stage,
  derived from its spec (`lib/spec.mjs check`) and the ledger (`lib/approval.mjs state`); several
  are asked about; none proposes a new effort. No id, slug or flag. A sub-effort's folder is
  created as a skeleton spec by `lib/effort.mjs folder`, and renamed among its siblings by
  `lib/effort.mjs rename`, which rewrites every id and path naming it and carries each approval by
  a new ledger line for the renamed text; it is refused once work under the folder was dispatched.
- **Defaults.** A value nobody chose — a delay, a weight, a count — is written `default <value>`
  where the spec states it (the `vocabulary` block's fourth rule for specs), and an integration
  reviewer rules another value of it `equivalent` unless a criterion or a decision fixes it
  (`roles/reviewer.md`, `integrationBrief`). **Why:** a number written as a claim is enforced like
  one, so every review of the folder sends its tuning back for a fix the user never cared about.
- **Scale check.** Before the first question the session says whether the work looks small and
  settled enough for `task`. The user can override; complexity found later never downgrades the
  path.
- **Level of detail.** A layer states only what the layer below needs: a high layer talks in parts
  and how they interact, a low one in interfaces and data shapes. Depth comes from folders.
- **Approach drafts.** The `drafts` program runs one analyst per stance, all at once, each handed
  the question file — the evidence excerpts, the decisions so far and the layer's question — and its
  stance's charge: `minimal-change`, the smallest change that satisfies the decisions so far;
  `long-horizon`, the approach that absorbs the growth axes the decisions name, at the cost of a
  larger change now; `adopt-dont-build`, adopting what exists from the candidates the question names
  and building only what none of them covers. Any other stance argues what its name calls for; a
  stance name follows the segment rule, and one named twice is drafted once. An empty question, no
  stance, or a stance name that breaks the rule starts no analyst and drafts nothing, and
  `coverage.unreached` says why. Each draft is recorded as an `approach` return as it comes back;
  a stance whose analyst failed has no draft (`draft:<stance>`), and one whose record failed keeps
  its draft unrecorded (`record:<stance>`). The session shows each draft with its trade-offs, its
  own recommendation first.
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
  that review was complete — one recorded from a probe run is complete when the run's coverage is
  ([Ledger lines](#ledger-lines)) — and each ambiguity it returned, carried ones included, has a
  disposition from any round, an incorporated ambiguity counting only once a later round ruled its
  section clean. An edit leaves no review of the new text, so the gate shuts until one reads it. The
  design session and develop's autonomous review read the same gate.

**Why:** most design errors are errors of intent or of contract, and both are cheapest to catch in
the layer that states them; writing lower layers early pays for detail the upper layers will
change. The spec is the session's memory, so a design outlives the session that wrote it.

### Traceability

Every decision in every spec has an id, and every plan entry lists in `realises` the ids it makes
true. `lib/spec.mjs check` refuses a `realises` id that neither the spec nor an ancestor defines,
and a decision the spec defines that none of its own entries realises: a `sub-effort` or a `task`
realises what it lists (a sub-effort with no spec yet is the frontier), a `dropped` entry's
decisions count as not realised, accepted, and a `deferred` entry realises nothing. Approval refuses
such a spec, so compile never meets one. A settled request's root spec takes its Decisions from the
request's items, written by develop and approved by the user. Before anything is dispatched,
`lib/traceability.mjs` computes over the compiled tree:

- decisions no child realises — a **blocking gap** (a `design` node with no spec yet is frontier,
  not a gap, and so is a stale planner's folder ([Specs, approval and compile](#specs-approval-and-compile)),
  which the execution plans again: its new plan is traced once it compiles);
- criteria that trace to no decision — reported, for the user to accept or remove.

The integration review receives the decision list of the subtree it reviews, and the folder's spec
as its yardstick.

**Why:** a plan that silently drops a decision passes every leaf-level gate, because each gate
checks a leaf against its own criteria.

### Probe

The `probe` program attacks a written artefact — a design, a proposal, a spec — before anyone
builds from it. The probers are not the author: each is an analyst handed the document and the
repository's excerpts and nothing from the author. Findings sit on the design ladder
(**ambiguity** blocks ratification; **gap** is designed away or accepted out loud; **note** is
advisory). A question the artefact's level of detail leaves to its builder — a type, a call order,
a timing, an edge a planned test's criterion pins — is a note, not an ambiguity: the layer below or
the red test settles it, and a review that blocked on it would keep finding precision in the text
written to answer the last round, never converging. When a person drives it there is no fix loop: the probe reports and a human rules. The
one loop is the [autonomous review](#autonomous-review) of a planner-written spec. The ladder's and
the disposition's wording are the verbatim blocks `design-severity-ladder` and `probe-disposition`
in the `design` and `challenge-idea` skills; every prober's brief carries the ladder word for word
from `lib/briefs/probe.mjs`, which `test/program-probe.test.mjs` holds to the design skill's block.

**A folder's spec is probed against its settled context.** When the artefact is a folder's
`DESIGN.md` under `.agentics/`, code reads every spec above it (`settledContext` in
`lib/spec.mjs`, groups skipped, nearest first) and every prober's brief carries each one's Intent,
Decisions and Design as excerpts: settled, never attacked, and governing over any other document
in the repository that disagrees, such as a superseded draft. The probers are never asked to find
them. The coverage declares the specs handed over; an ancestor whose spec cannot be read is an
`unreached` line, so the round is partial and says why.

**A probe attacks what the artefact adds, reshapes or removes.** Every prober's brief says so: a
finding whose claim holds of the repository with the artefact unapplied — a cost the code already
carries that the artefact neither creates nor changes — is a `note`, however real, and an axis on
which the artefact adds and reshapes nothing is ruled `clean` by the prober, its why saying so.
Only a prober's ruling reads `clean`; code never rules a unit.

**The units of a probe** are each axis it attacks against each section of the artefact in scope, the
sections being its `##` headings outside fenced blocks (as CommonMark reads both: a backtick line
whose info string holds a backtick opens no fence, and a heading's closing `#` run is not part of
its title): the lines before the first heading are a section of their own when they hold more than a
title, and a document with no such heading is one section. A prober is handed the snapshot's text,
line-numbered, in its prompt, and rules every unit it holds: findings, each with its severity,
claim, evidence and the artefact lines it rests on, or `clean` with a line of why. A ruling counts
only for a unit its prober was handed. A prober that lacked ground for a unit says so in its own
return (`not_reached`); the host can ask again. A prober is no searcher, and it is never continued.
`ratifiable` is computed: the coverage complete — every unit in scope ruled, no channel failed, the
locating search complete (`done` or `stalled`) — and no ambiguity open. A unit nobody ruled on is open, so a prober that
skipped a section leaves the review unratifiable, never quietly passed (L1, L3).

Findings are evidence items too. The program first snapshots the artefact (`reviewScope`), and
each new finding is recorded as a `behaviour` item anchored to its lines in that snapshot. Given
`since` — the snapshot the last review judged — the probe attacks only the lines changed since, its
units each axis against each changed part: every changed range cut at the bounds of the sections it
falls in, keyed `<section>~<first line>-<last line>` (`changedParts`), the rest of the document handed
over as context. Where a section is read off a unit or a finding (`partSection`), a part is its
section, so a later round whose parts of a section are all ruled clean rules that section clean. It
carries forward every earlier finding whose
lines no hunk touched, in the probers' prompts and in the round's record: the same anchor check as
all other evidence. A finding whose evidence quotes a passage of the text it was found in that the
text no longer holds (`quotesGone` in `lib/evidence.mjs`) is not carried, though its span stands: the
rewritten lines are among the changed parts, reviewed afresh. Nor, when the artefact is a folder's
spec, is a finding its folder settled as the gate counts it (`settledFindings` in
`lib/approval.mjs`): one discarded, or one incorporated whose section a later review ruled clean.
An incorporation no review has ruled on yet is still carried, and an ambiguity so carried keeps the
gate shut. An earlier `clean` ruling is not carried: the
sections no hunk touched are out of the round's scope. An artefact unchanged since `since` buys no
agent at all and records one empty round, every earlier finding carried; a `since` the store does
not hold intact makes the round whole. A relaunched round whose journaled scope names a snapshot
the store has since pruned refuses that scope (`snapshot_missing`): it runs over the artefact as
given and records nothing. A carried ambiguity is an open ambiguity.

When every prober has returned, the program records the round in-process (`recordProbe`), once:
carried findings first and new ones after, numbered `P1…`; a finding whose axis its prober did not
hold is credited to that prober's bundle; a range outside the snapshot is anchored to the whole
document. It writes every finding and every unit's ruling in full to one findings file, records the
round's `probe` return — an empty one when it found nothing new, so a `prepared` line always names a
real review — and returns the snapshot to pass back as `since`. A round with a failed prober records
nothing: its findings are numbered into the findings file, unrecorded, and a relaunch resumes only
that prober, the others replaying, and records the round then. A finding the store refused is in no
pool, so the snapshot comes back empty, and the next round attacks the whole document again rather
than narrowing past it. The scope and the recorder read the checkout the probe was started in, so a
probe in a linked worktree reads and anchors the worktree's text. An artefact outside every
checkout cannot be snapshotted: it is probed all the same, and its findings stay in the probers'
stored returns, the round's `record` channel failed.

Every axis the repository's guidance yields is probed, beside the standing four: an axis nobody ran
and an axis that found nothing must not leave the same mark, and the per-unit rulings are what tell
them apart. One analyst holds every axis as a checklist; another is bought for every 400 lines
attacked (`probersFor`), a narrowed round counting its changed lines alone, never more than one per
axis, the axes dealt round-robin; `--per-axis` buys one per axis. The checklist's length buys no
head: what fills a prober's context is the text and its ground, which every prober is handed whole,
and an axis adds one line of charge, so a second prober over a short text pays for that text twice
to rule units one prober holds. A second round is earned only by a resolution that reshaped the
design.

The coverage names what the probe could not do. The locating search is one search
([Searches](#searches)) named `locate`, run by the scout over the probe's tree — the tree handed
in-process (an execution's pinned tree), else the checkout the probe started in, its working files
included. It finds the guidance and the code the artefact rests on, its hits labelled `guidance` or
`ground`; its material is the artefact, or, given `since`, each changed range on its own
(`locateMaterial`), and its scope the probe's roots. The artefact's own citations stay apart: they
are resolved by `resolveCitations` and handed over as the shared ground. Every prober gets every
hit's excerpts (`hitExcerpts`); the axes analyst gets the `guidance`-labelled ones, and is bought
when the repository has guidance (`guidanceOf`: the `CLAUDE.md` chain and `config.guidance`,
resolved by code) or any hit is labelled `guidance`. The probe builds its coverage from the search
through `searchCoverage` ([Searches](#searches)): a `done` or `stalled` locate is a `declared` line
and complete, so a stalled locate closes no gate; a `budget` locate leaves `locate` incomplete and
a `failed` one fails the `locate` channel, each with its line in `unreached`. A locate that is
incomplete and holds no hit hands the probers no ground, and the standing axes probe the artefact
and its own citations alone. What each prober declared it never attacked (`not_reached`) is an
`unreached` line too. An axes analyst that failed or could not read the guidance fails
`repo-axes`; a failed prober fails `probe`, its units open; an artefact that cannot be
snapshotted fails `record`. A round whose findings the store refused fails no channel: its new
findings are listed in `unrecorded`, and its snapshot is empty.

**A recorded round keeps its unit rulings** beside its snapshot (`<hash>.rulings.json`): each
section unit (`<axis>@<section>`) that holds a ruling, anchored to its section's text
(`sectionUnits` in `lib/evidence.mjs`). A narrowed round computes its units over the
[review delta](#review-delta) against them: a ruling stands while its section reads the same,
wherever it now sits. Every section a unit of the delta rules with no earlier ruling — an axis no
round attacked it on, a section new or renamed, a unit the `since` round left open — widens the
changed ranges by the whole section (`widenedScope` in `lib/programs/probe.mjs`), says so in
`declared`, and is attacked on that axis, so a partial round is finished by the next narrowed one
instead of a whole round that would re-find, under new ids, what the user already settled; an
artefact unchanged since such a round is attacked in those sections rather than taking the
no-agent path.

**A recorded round keeps its ground** beside its snapshot (`<hash>.ground.json`): the repository axes
it probed, the guidance they rest on, the places it located and their excerpts. A narrowed round
whose `since` kept ground reuses it: it buys no axes analyst, and a locate only for what its changed
lines name that the kept ground does not cover. That is a judgment, so an analyst on `haiku` makes
it (thread `relocate`), handed the changed ranges and the kept places, and lists each term the
places miss. An empty list buys no search: the round's `repo_ground.status` is `kept`. A non-empty
list buys a `locate` over the changed ranges for `ground` alone, starting from those terms, its hits
joined after the kept ones. A judge that failed buys that search too, from no terms, and says so in
`declared`; any doubt routes to a search. Each recorded round whose locate finished and whose axes
analyst did not fail keeps what it used (one that would hand on less keeps nothing), so the next
narrowed round reads it in turn; a `since` with no kept ground narrows the units all the same and
locates and derives its axes as a full round does. Kept ground holds each place once (`joinedGround`):
a hit located again keeps its newer lines where it now stands, and a search block word for word the
same is kept once, so a folder's rounds grow its ground only by places no round held before, and the
bound below keeps it within what a prober may read: what a round sheds is not kept.

**A prober's brief is sized part by part.** The prober's brief is built in parts
([The agent runner](#the-agent-runner)) — the artefact, the settled specs, a narrowed round's carried
findings, the units, the document's citations, the repository ground, the guidance, each beside the
charge's own, each guidance file one part — and is sent whole, the artefact always line-numbered in
full. The ground and the settled specs are code's ([The agent runner](#the-agent-runner)), and grow with
the folder's rounds and its ancestors, so they are bounded as the briefs are built (`boundedBriefs`):
while a prober's brief is past the room, or the ground or the settled part past its budget, the
ground's oldest places go first, a kept round's before the round's own, then the farthest settled
spec; each place and spec shed is declared in `coverage.declared`, and a shed place leaves the kept
ground and its `located` list, so a later round's relocate judge searches for it again. A part of the
user's — the artefact, a guidance file — past its budget is refused `brief_too_large` before it is
sent: the prober fails, its `unreached` line names the part, its size and its budget, the round
records nothing, and the result's `refused` lists it; in an execution the folder escalates
`brief_too_large` naming it (`specReviewed`), for the user to shrink or split the file.

### What a probe costs

**The cost of a probe is turn count, not payload**: every turn re-sends the accumulated context,
and analysts that each locate the same lines pay for them once each. So the program resolves the
document's cited evidence once (`lib/citations.mjs`) and puts the excerpts in every prober's
prompt, and the head count is earned by the lines attacked alone, never one analyst per axis
unless asked.

The Ground phase resolves three bodies of text once: the document's own citations, read from the
probe's tree; the located ground, every `locate` hit with the lines it points at (`hitExcerpts` in
`lib/citations.mjs`, [Searches](#searches)); and the located guidance, the hits labelled
`guidance`. The first two go into every prober's prompt and the guidance to the axes analyst
alone. A hit whose file or line the searched tree does not have is marked, not excerpted, and
counted in `repo_ground.unresolved`. The probers share one read of the ground, and a narrowed round
reads its last round's again rather than searching for it. The snapshot, the narrowing and the record stay on the
checkout the probe was started in, where the artefact lives.

### Autonomous review

A spec develop's planner writes (an `author: planner` sub-effort, written first, or rewritten to
answer a leaf's request, a ruling or its own `spec_changed` park) goes ahead without the user's
approval, but only once an adversarial review passes. It runs inside the `execute` program, one
folder at a time, every planner round in the folder's one planner session (`planner:<folder>`),
which may write that folder's spec and nothing else. Each boundary's answer is journaled as a `step`
under the folder and the round, so a relaunch replays what was decided. A plan journals its start
round first (`plan:<folder>:<basis>`), past every round dispatched on the planner thread and every
earlier plan's start, since a plan of an edit journals its first steps at its start round without
dispatching; and it replays only the steps recorded after its start, so no plan reads back another
plan's check, gate or preparation. The plan's basis — the
folder's revision, or the request it answers — also names where the folder was cleared
([P3](#p3--state-is-derived-records-are-written-as-things-happen)) when that is later than its
revision, so a plan after the user's `retry` or answer is a new plan that runs on from the planner thread's
latest round, never a replay back to the stop the user cleared. Each plan of a folder searches one
tree: before anything else it journals, as the step `tree:<folder>:<basis>`, the head of the nearest
existing integration branch among the folder and its ancestors, else the execution's `base_sha`, and
the searches of its survey and of every probe round run over a detached worktree pinned at that sha
(`.claude/worktrees/search-<effort>-<sha8>`, `pinTree` in `lib/search/pin.mjs`), reused for the sha
and made again when it is gone, so a relaunch searches the tree the plan began on while leaves merge
elsewhere. The artefact, its snapshot and its record stay in the main checkout. For a folder whose
ground is unknown the program first runs a survey (nested as `survey:<folder>:<basis>`, so a
replanned or retried folder surveys afresh), handed the change from the base to the pinned sha and
the items the folder's nearest live ancestor with a citation rests on (its latest `cites` line,
journaled as the step `inherited:<folder>:<basis>`; that citation already holds what its own
ancestors' did, so the list does not grow with depth), and
the planner's brief (`plannerBrief` in `lib/briefs/execute.mjs`) carries the text of its context
file. Landing removes the effort's clean pinned trees, and preflight removes those no plan of an open
execution journaled (`sweepTrees`); a dirty one is never forced, and preflight reports it. The review's steps:

1. **Check.** The `spec-check` boundary closes the planner's dispatch — its write, or a settle that
   edited the spec, checked again before the next probe round (`settled` reads as `written`); a
   dispatch that returned nothing holds the folder on a `role` fault, and any other status parks
   the folder (`needs_decision`, `contract_changed`, `premise_mismatch`) or
   escalates it (`plan_<status>`) on the planner's return. It then parses the spec with its
   ancestors' decisions in view and, when that finds nothing, compiles it dry as its preparation
   would sign it (`compileEffort` with `previewAs: 'prepared'`, on the offload worker), so a refusal
   of the tree's guards — a consumed contract dropped or re-pathed, a provided one changed — reaches
   the planner while it can revise or return `contract_changed`, not after a review round is spent.
   Only the refusals its spec causes count (`plannerCaused`): one more compile with the spec
   reverted, dry as well (`preview: null`, the edited spec kept as it was compiled), names those
   that stand without it, and they are dropped wherever they sit, the
   planner's own file included, since there is no revision of its to make. A Decisions row parks the folder `needs_decision`, because only
   the user states decisions; any other problem goes back to the planner's session as a `problems`
   message, and the same problems again escalate `spec_refused`.
2. **Attack.** Before each round the folder's design spend is held to its allowance (below). The
   `probe` program, nested as `probe:<folder>:<n>` (`n` the planner round it follows), reviews the
   spec, with one standing axis beside the four: `entries` (`PLAN_AXIS` in `lib/briefs/probe.mjs`),
   whether each entry's work does what the decisions it realises say, because nobody else reads a
   planner-written spec before it is built. `since` narrows the review to the spans changed since: the
   previous round's snapshot, and for a plan's first round the snapshot of the folder's latest
   complete `reviewed` line, whichever plan or run made it. Text a complete round judged is not
   judged again: its findings that still stand are carried, and only a revision's changed parts are
   reviewed. `spec-reviewed` reads the
   round's result and records every round as a `reviewed` ledger line with the settlement ids of
   its ambiguities; one that left a unit unruled escalates `review_incomplete`. A round a prober's
   role fault cut short records nothing and holds the folder on that fault. The findings still to
   settle are the ambiguities and gaps no disposition on the ledger has settled: a finding the probe
   carries from an earlier round stays settled. A note is advisory: it stays in the round's record
   and never reaches the planner, because an edit made for it would void the review that raised
   it, and a round whose findings are all notes would never let the gate open on the text it read.
3. **Settle.** The planner's session, resumed with the findings, gives every finding still to
   settle a disposition in its return, and that disposition is incorporated (the spec changed).
   `spec-settle` reads it: a discard, or a finding left out, is refused and goes back to the
   planner's session; the same discard refused again escalates `review_not_converging`. An ambiguity counts as incorporated only when the edit touched
   its anchored lines and the next round rules that section clean; until then it stays open,
   whatever its disposition says (L3). A finding
   whose fix would state a decision parks the folder `needs_decision`. `spec-settle` records each
   disposition, `by: planner`, under the finding's settlement id (its evidence-item id, or the
   reviewed hash and its `P<n>` when it has none).
4. **Converge.** `spec-reviewed` escalates `review_not_converging` when a finding still to settle
   has the same axis, section and claim as one the previous round's file holds and the ledger shows
   incorporated: a computed exit, never a round counter (L2).
5. **Prepare.** The gate is the `spec-gate` boundary, `approvalGate` on the ledger, the one the
   design session reads: the latest review of the spec as it stands is complete and every
   ambiguity it returned has a disposition. An incorporation edited the spec, so it buys a
   narrowed re-review; a gate still shut on a round that edited nothing escalates
   `review_not_converging`. Then `spec-prepare` records the `prepared` ledger line naming the raw
   return the passing review recorded (an empty one when it found nothing new; its snapshot, else
   the spec hash, only when the probe's scope or record failed), reusing a `prepared` line that
   already stands at that hash for that review, and compiles the folder. A spec it cannot prepare
   (missing, stating a decision, or with problems) escalates `prepare_refused`, a compile refusal
   `compile_refused`, a folder compiled with nothing beneath it `planner_wrote_nothing`, and a leaf
   the planner was asked to replan that the compile left at the revision it asked from
   `replan_not_converging`, unless the request was a verify finding and the spec prepared is not the
   one the answer started from: that leaf is cleared (`replanned {reason: spec_answered}`). A leaf whose `expects` grew onto another leaf's file is no stop: an
   expectation claims nothing, and the scheduler keeps the two apart. A `spec_changed` park the
   compile raised on the folder itself is cleared at once (`replanned {reason: spec_rederived}`).

**Proportionality.** Before each probe round, `planFolder` sums what this execution's dispatches for
the folder's design cost — its planner, its surveys and its probe rounds (`designSpend`) — and parks
the folder `design_spend` when that passes its allowance (`designAllowance`): `design_spend_multiple`
(`.agentics/config.json`, 5 by default) × the plan's entries as first checked (the step
`entries:<folder>`, so a plan that grows never raises its own allowance) × the effort's
`leaf_mean_usd` ([Self-checks](#self-checks)), or a default while no merged leaf is measured — once
more for every earlier `design_spend` park on the folder. The question names the numbers. The user
goes on (`retry`), cuts the scope, or hands the work to a task. The count decides when to ask, never
the answer (L2).

A park or an escalation stops only that folder; develop keeps running whatever does not depend on
it. A `spec_changed` park on a folder the planner wrote goes back to the planner, which re-derives
it through these same steps; its preparation clears the park its own compile raises. A folder the
planner wrote whose spec the session edited on the user's word, answering a park on it (an
integration review's `spec_defect` or `integration_critical`, standing or retried), is not ruled:
the next tick hands the edit to the planner's path with no planner write first. The edit is checked
as the user's (its problems escalate `spec_refused`); a gate already open on that very text is
prepared at once, else it is reviewed and its findings settled by the planner; it is prepared and
compiled, and its preparation clears the park it answers (`replanned {reason: spec_edited}`). A
stop of that plan the session clears, by `retry` or an answer, plans the text again, so an edited spec whose gate opens on
the session's word is prepared; and while a planner's folder is stale, no integration review of
the folder runs over the graph compiled before it. The same park on a folder the user wrote waits for the user; a change ruled to move nothing never raises it
([A changed spec](#a-changed-spec)).

**Why:** the parts the user lets go autonomously still get a reader that did not write them
(L3), and the planner may shape a plan but never a decision (L4).

---

## Evidence

Evidence is a project-wide pool of small items. Each item makes one claim and carries the anchors
it rests on, and each item's drift is detected on its own, so an edit re-buys only the claims it
broke. The pool is `.agentics/.state/evidence/`, because a fact about the code belongs to no
single effort; `lib/evidence.mjs` owns it.

### Returns into items

Every agent whose findings become evidence — a survey's planner and judges; a probe's probers; a
solutions sweep's framer and assessor; a re-judge — returns them in its return, in the shape its
role's schema states, and the runner stores it ([Briefs and returns](#briefs-and-returns)). A
searcher's hits reach the pool through the judge that reads them ([Searches](#searches)) or, for a
candidate, through the program. The program maps what was returned to items in-process,
deterministically: a judge's topic to its subtree, a derived item's sibling claims to ids, a probe
finding's lines into the snapshot, a candidate to an `external` item. Free text the caller supplied — a survey's question, a sweep's
capability — is the program's own argument, written by the session that authored it, and reaches
every prompt from there.

### Searches

A search is how a program learns what a tree, its history or the web says about a question it
cannot answer from what it holds: a probe's locate, a survey topic and its history and docs, a
solutions sweep's repository scan and its researchers. Every one is one call of `search`
(`lib/programs/search/search.mjs`): rounds of a scout, each a fresh session that finds what it was
asked to find over code's tools on a pinned tree, until a round stops widening the search.

```
program ──► search(ctx, {name, domain, find, material, scope, subject, labels, budget, tree})
              │ writes the server spec; starts the scout's session, or resumes it
              ▼
        scout (role per domain) ⇄ tool server (one stdio process per CLI process)
              │   repo:    grep · read · files · refs
              │   history: log · show · grep · read
              │   web:     fetch (+ the host's WebSearch, copied into the journal after the session)
              │   every domain: hit
              │   every record goes to calls.jsonl, tagged with its session, before the answer
              │   loop guard: 12 tool calls in a row in this session that show nothing new → stalled
              ▼
        return {summary, unsearched}  →  two or more new places hit,
              │                          and not "nothing unsearched"?  ── yes ──► next round, a fresh session
              │ no                                         briefed with the journal's hits and calls
              │                                            and where the last round did not look
              ▼
        result {name, status, why, summary, hits[], calls[], cost, rounds[], coverage, …}
```

| program | search (its thread) | role, domain | what it finds |
|---|---|---|---|
| `probe` | `locate` | scout, `repo` | the guidance and the code the artefact rests on, labels `guidance` and `ground` |
| `survey` | `scout:<topic>`, one per topic | scout, `repo` | the topic: tools over the roots, hits in its subtree |
| `survey` | `history` | historian, `history` | the plan's history question, when it has one |
| `survey` | `docs` | doc-researcher, `web` | the plan's docs question, when it has one |
| `solutions` | `repo` | scout, `repo` | the repository scan, scoped to the roots |
| `solutions` | `research:<angle>`, one per angle | doc-researcher, `web` | the angle's candidates |

**The spec.** `name` is the search's key in its run, and its thread. `domain` (`repo`, `history` or
`web`) picks the role (`ROLE_OF`) and the tools (`TOOLS_BY_DOMAIN`). `find` says what to find in
plain words, one text per search. `material` is text the find is about — an artefact, a question,
the files a change touched — as `[{label, text}]`. `scope` is the paths the repo tools run over
(default `.`; the web ignores it). `subject` is where a path hit may land (default the scope): `hit`
refuses a path outside it `bad_hit`, so a search about one directory can still read the callers
that decide it. `labels` is an optional enum a hit may carry; with none, a hit
carries no label. `budget` is an optional dollar cap for the whole search (**Budget**, below).
`tree` is the `{root, sha}` it runs over.

**The charge.** The scout's system prompt is its role's text and the charge (`scoutCharge` in
`lib/briefs/search.mjs`, through `promptFile(role, dir, charge)`): the domain's tool protocol in a
sentence, the find, the scope, the subject when it is narrower than the scope, the labels and the material,
each item fenced as data. It depends
on nothing a session changes, so the host caches it. The scout greps for what the material names
on its own: no code resolves the material, seeds the search or ranks what it reads.

**The roles.** `scout` (repo), `historian` (history) and `doc-researcher` (web) are short roles:
find what the charge names, cite only lines a tool showed, record each finding with `hit` as soon as a
tool shows it relevant, not in one batch at the end (a finding only in the summary is lost), stop
when what was asked is found or there is nothing more to look at, and return a one-paragraph summary
of what it found and `unsearched`, each place the find names that it did not look at — empty only
when it looked at all of it. Every role and the opening brief carry the same
stop line (`STOP_LINE` in `lib/briefs/search.mjs`). Each returns the `search` schema,
`{summary, unsearched}`, which holds no ruling field (L3) and offers no `more`. Each role's tools hold `mcp__search__hit`; the
doc-researcher also holds the host's `WebSearch`.

**The tree.** Every search runs over one `{root, sha}`. A standalone program's is the checkout it
reads and its `HEAD`, uncommitted files included. An execution's folder gets a framework-owned
detached worktree (`.claude/worktrees/search-<effort>-<sha8>`, reused for the same sha) at the head
of the nearest existing integration branch among the folder and its ancestors, else the envelope's
`base_sha` ([Autonomous review](#autonomous-review)); the sha is journaled, so a relaunch searches
the same tree while leaves merge; the execution hands its nested survey and probe that tree
in-process (`tree`), and the survey the files changed between the base and that head (`changed`,
by `git diff --name-only`). The probe reads its artefact from the main checkout. A folder's nested
survey is scoped `survey:<folder>:<basis>`, so a replanned or retried folder surveys afresh.

**The tools.** A scout never touches the tree: code runs each call (`lib/search/tools.mjs`) on the
search's tree.

| tool | domains | what code runs |
|---|---|---|
| `grep` | repo, history | `git grep` in the shared query dialect, `--untracked`, binaries skipped |
| `read` | repo, history | a line range of one file from disk, saying where it stopped and how long the file is |
| `files` | repo | a glob over tracked and untracked files, in the search glob dialect (`GLOB_RULES`: `*` within a segment, `**` across segments, `?` one character, everything else literal; a `{a,b}` alternation is refused `unsupported_syntax`, in `files` and in `grep` paths alike, so a glob never matches nothing for want of a reading) |
| `refs` | repo | word-bounded references to a symbol by file, tests marked, `total` their sum |
| `log` | history | `-G`, `-S` or `--grep` over the tree's history, each commit with the keys it touched |
| `show` | history | a commit, or one path in it |
| `fetch` | web | one web page, its lines paged; the first body of a URL in a run is pinned under the run's `pages/` (`<fnv1a(key)>.json`, `{key, status, bytes, lines}`), so every search of the run and every relaunch reads the same body; a query string is part of the URL; a body past `FETCH_BYTES` (8 MiB) is refused `too_large` with its size |
| `hit` | every domain | records one finding: `{path, line, note, label?}`, `{commit, note, label?}` or `{url, line?, note, label?, candidate?}` |

Every key is canonical by construction: git's own output for the pinned tree (a repo-relative posix
path, a full commit sha), or `canonicalUrl` on the web. One query dialect, `queryOf`, serves search
and the evidence pool ([Items and anchors](#items-and-anchors)); paths, globs and the fence share its
module (`lib/search/query.mjs`): `pathKey` spells a path as a key, `globOf` reads a glob in the
search dialect, and `fenced` refuses a key under `.agentics/` or `.claude/worktrees/`
(`not_canonical`), save that `fencedFrom` opens a tree under `.claude/worktrees/` to a scope part
that names it, and the store to nothing. Each tool keys every path as git prints it for that tree,
so spellings, worktree copies and Windows case never split one file. A scope part git reports
ignored is searched with the standard excludes off; `node_modules` only through a part that names
it; each initialised submodule on its own, keyed under its path; a nested repository or another
worktree only where a scope part names it (`--roots .claude/worktrees/<name>`), then on its own like
a submodule, keyed under its path, with its own store and worktrees fenced. Output comes in
pages of `PAGE_LINES` (200), each answer saying which page holds the next lines, so nothing is cut
silently. Every failure is a named refusal (`not_canonical`, `past_eof`, `unsupported_syntax`,
`does_not_compile`, `expander_error`, `outside_scope`, `too_large`), never an exception.

**The tool server.** The tools come from one stdio MCP server, `lib/search/server.mjs`, named
`search`, so the host calls them `mcp__search__<tool>`, and no searcher holds the host's `Read`,
`Grep`, `Glob`, `Bash` or `WebFetch`. The host CLI starts it through `--mcp-config`, beside
`--strict-mcp-config`, and it ends with that CLI process: a resume spawns a new process and so a
new server, which reads the journal again at start. It is no daemon, and nothing outside the
session sees it. `search` hands the runner its MCP config as a function of the session id
(`mcpConfigFor`), so each CLI start gets a spec ([Search tool server
spec](#search-tool-server-spec)) carrying its own `session`.

- **The journal.** The server appends every record to the search's call log
  (`<run dir>/searches/<search key>/calls.jsonl`, [Call log](#call-log)) before it answers,
  numbering them across every server process of the search, and every record carries the spec's
  `session`. Every answer starts with its call's number (`call 7: …`). A request the server does not
  know gets JSON-RPC error `-32601`. What the scout saw and recorded is therefore code's own record.
- **Repeats are per session.** An exact repeat — the same tool and arguments, defaults filled, in
  the same session — is answered from the call it repeats without running it (`repeat_of`). A
  renewed session lost the earlier answer, so its call runs again.
- **`hit`.** A `path` is checked for canonical form with `keyOf` and needs a `line`; a `commit` is
  checked with `rev-parse`, as `show` does; a `url` is stored by `canonicalUrl`; a `candidate`
  carries the fields of a `candidates` item. A bad key, a missing note or a label outside `labels`
  is refused `bad_hit` with a detail the scout can correct. Nothing checks that a tool showed the
  line: the scout may be wrong, and the caller reads the result. `hit` is served at all times,
  after a stall too.
- **The loop guard.** A tool call is *new* when its result shows something no earlier record in
  the journal showed: a `(key, line)` it returns, or a file, commit or page it lists. A call that
  matches nothing, a refused call and an exact repeat are not new; `hit` counts neither way. When
  the last `STALL_WINDOW` (12) tool calls of the current session are all not new, the server
  journals one `stalled` record and answers every later tool call of that session but `hit` with
  `stalled: nothing new in the last 12 calls; record what you found and return`, each journaled as a
  refusal (`stalled`) that never serves as a repeat's source. *New* is judged against the whole
  journal; the window is per session, so a resumed session keeps it and a renewed one starts afresh.
- **The named hole.** The host's `WebSearch` never passes through the server, so the guard cannot
  see it: a web scout looping on `WebSearch` alone is not caught. After the session, `search` copies
  each host `WebSearch` call of the thread (the runner's `tool_used` entries) not yet journaled into
  the call log as a `websearch` record, with the session of the dispatch that ran it, so the calls
  and the resume brief show it.

**Rounds.** One scout session decides when it is done and declares where it did not look. So
`search` runs rounds: round `n` is one dispatch, key round `n`, and a round after the first starts
the thread's next session (`fresh`), briefed with `roundBrief`: the hits and calls every earlier
round journaled, where the last round's scout said it did not look, and the ask to find what they
missed. A round earns the next only while it widens the search (`earnsAnother`): it hit two or more
places no earlier round hit — a path hit's place is its file, any other hit's its key (`placesOf`) —
and its scout did not declare nothing unsearched with its guard quiet. A round that lands on one new
file deepens a place already found, and rounds buy breadth; a scout that returns clean claiming it
looked everywhere the find names has nothing for a fresh session to cover. The files in the subject
bound a search's places, so a scout re-checking files already hit, each re-check a new `path:line`,
does not earn another round. A round is more searching, never a re-check of the hits before it:
nothing rules on them (L3). No counter the loop keeps ends the rounds (L2); a dollar budget caps
every round's spend together. A round's hits are the journal's
hits whose `session` is one of the round's.

**Resume.** The journal is the artifact. Each round runs one dispatch through `dispatch`, with
`renewOnChange`:

- A host stop or a cut-off resumes the same session, which still holds its context and its opening
  brief. Nothing is sent again but `cut_off`.
- A session that is lost (`session_missing`), renewed for size (`too_large`, [The agent
  runner](#the-agent-runner)) or refused as too long (`context_exceeded`, renewed once; a second
  refusal fails) starts fresh on the same charge, briefed with `briefNow()`, the resume brief
  built at that moment. One renewed for a changed system prompt or cwd (`prompt_changed`,
  `cwd_changed`) starts fresh too, with the resume brief built at dispatch. The resume brief
  (`resumeBrief`) is the opening alone for an empty journal, else the hits so far and the calls
  already run, one line each (`callLines`: `grep TOKEN in src → 3 found`, `WebSearch` included).
  Nothing is folded or ranked.
- Compaction is the host's business: a compacted session goes on from the host's summary, and its
  hits are already in the journal.
- A round whose session returned is finished: rerunning the program replays its stored return, so
  a relaunch mid-round replays the rounds before it and resumes that round's session with
  `cut_off` alone; the result is read from the journal again.

**Budget.** The user sets it per program run, `--search-budget <usd>` on `probe`, `survey` and
`solutions`, applied to each search of the run (`budgetOf`); unset or 0 means no cap. The host's
`--max-budget-usd` counts the spend of the process, not the session, as measured on the host, so
`search` passes the runner a function (`budgetNow`) that the runner calls at every CLI start: the
budget less the `cost_usd` recorded on the `returned` entries of every round's dispatch. A remainder of zero
or less starts no process. The host's stop at the cap (`error_max_budget_usd`) is the runner's
`budget` class, terminal, which `dispatch` does not wait out. A killed process records no cost, so
a search can overrun its budget by that process's spend.

**The result.** `{name, status, why, summary, hits[], calls[], cost, tree, pages, sessions[],
rounds[], coverage}` ([Search result](#search-result)):

- `done`: the last round's scout returned, the guard quiet in that round, and the round did not earn another.
  `stalled`: it returned after the guard fired in that round, `why` `nothing new in the last 12
  calls`. `budget`: the cap stopped it, `why` the
  spend against the budget. `failed`: the host failed past `dispatch`'s waits, `why` the cause.
- `hits` are the journal's ok `hit` records (`hitsOf`), each once: by `(path, line)`, by commit, by
  `canonicalUrl`, and a candidate by `candidateKey`.
- `calls` are the journal's call lines, the lines the resume brief holds.
- `sessions` are the sessions the search's thread ran in: no judge of its hits may be one of them
  (`dispatchJudge`, L3).
- `rounds` is each round's `{added, cost}`: the new places it hit and the dollars recorded on it.
  `coverage` is `{rounds, last_added, skipped}`: how many rounds ran, what the last added, and the
  last returned scout's `unsearched` joined by `; `, its own word on where it did not look. `summary`
  is that scout's summary.

**Coverage.** Each program builds its coverage (L1) from its searches' results, through
`lib/programs/search/consume.mjs`. `coverageLine` names the search, its status, its counts of calls
and hits (`no hits` for none), its rounds and what the last added (from `coverage`), its why, and,
when the last returned scout named anything unsearched, that labelled as the scout's own word, its
whitespace folded to one line. A caller that reads only the line sees a search that ran many rounds,
or one whose scout says it left something unlooked at:

```
locate: done, 41 calls, 23 hits, 4 rounds (the last added 1); the scout's own word: vendor/
scout:loader: done, 1 call, no hits, 1 round (the last added 0)
history: stalled, 30 calls, 2 hits, 2 rounds (the last added 1): nothing new in the last 12 calls
research:crates: budget, 7 calls, 1 hit, 1 round (the last added 1): spent $1.02 of its $1 budget
repo: failed, 0 calls, no hits, 1 round (the last added 0): host_error: exit 1
```

`searchCoverage` puts a `done` or `stalled` search's line in `declared` — a complete end
(`searchComplete`), on which its caller proceeds with the hits it has; a `budget` search's name in
`incomplete` and a `failed` search's in `failed_channels`, each with its line in `unreached`.

**Excerpts.** `hitExcerpts(result, {label})` in `lib/citations.mjs` renders a search for the
agents that read it: its name, status and why, its summary, then one block per hit (only those
carrying `label` when one is given): a `path` hit's note and the lines around it through
`resolveLocations`, which marks a path or line the tree lacks; a `commit` hit's note and the
commit's subject; a `url` hit's note and, when it names a line, the lines around it from the run's
pinned page. It also counts the hits and the unresolved ones.

**The laws.** L1: a search's coverage is code's own record — its status from the runner and the
guard, its calls, hits and rounds from the journal — with the scout's word on what it skipped
carried as the scout's, never as code's. L2: a search ends on a round that stops widening it or
whose scout declares nothing unsearched, or on a round the host or a budget the user set stopped; `STALL_WINDOW` is the
one count, a stall detector the server owns, never a cap on calls that find something new. L3: a
round that ends the search is a declaration: it ends the search and can make a program's coverage complete, but
it enters no verdict; the work that consumes the hits is judged where it always is. L4: the tools
read the pinned tree and write nothing but the run's own files, and the user's checkout, index and
stash are never touched. P2: the tools, the journal, the guard, every brief and every dedup are
code; what to look at next is the scout's.

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
otherwise a snapshot of the text it was read from; a query's result is `git grep` re-run in the
shared query dialect (`queryOf` in `lib/search/query.mjs`): `\d \D \s \S \w \W` are transpiled to
their POSIX classes, outside brackets and (`\d \s \w`) inside them; `\D \S \W` inside brackets, `\b`
and every other backslash-letter escape, `(?` and lazy quantifiers are refused, and a NUL byte
anywhere; a scope path is a literal pathspec unless it holds `**`, which makes it a glob;
`.agentics/` is never searched. A refused query refuses its item at record and makes a stored item
stale. The pool keeps a match in a file git calls binary. A source's retrieval date is the
recorder's own. A batch with one refused item is refused whole, so
nothing unanchored enters the pool: a survey judge's refused items go back to that judge
([Survey](#survey)), and a probe round or a sweep whose batch is refused records nothing
([Probe](#probe), [Existing solutions](#existing-solutions)). An item's id is its question, topic
and claim; a new revision of the same claim is appended, and the latest by `seq` wins.

**One query dialect.** `git grep -E` is POSIX and reads `\d` as `d`, so a query in JavaScript's
dialect matches nothing and an absence on it reads as proven. `queryOf` owns the whole argument list
for the pool's `runQuery` and for the search tools alike (`grepArgv`), so a query means one thing
wherever it runs: what has a POSIX form is transpiled, what has none is refused with
`unsupported_syntax`, never passed through. A query's identity is its pattern as given, `fixed`,
`ignore_case` and its sorted paths.

A scope path is literal unless it holds `**`, so a single `*` is a literal character: a pool item
whose scope uses `*` as a wildcard searches the literal path, and may stop matching. An enumeration
item on such a scope goes suspect when its result changes, and an absence item on one stays
standing over the literal path.

### The drift ladder

Whenever evidence is about to be used — before a survey plans, before a re-review, when a brief
is written, when `evidence.md` is rendered — each relevant item's state is derived on read, never
stored:

1. **Anchor check** (deterministic, `checkAnchors`). Content decides first, with no git
   (`spanByContent`): a span whose file hashes as the text it pins stands in place, and one whose
   window — its lines and a line of context each side, at least two of its lines non-blank — was
   unique in that text and is unique in the current file stands where it is now. Anything else goes
   to the diff, so a copy elsewhere never hides an edit to the span's own lines, and a block moved
   away from its context is judged as the diff maps it. git's object database is the content store:
   a commit's blob is read through `blobAt` (`lib/offload.mjs`), whose one map, keyed by oid, keeps
   each text for the life of the thread that read it, the offload worker where checks run. `anchors/`
   keeps per `at` and path only the blob's oid, its hash and each span's window, never the text: a
   cache any check may rebuild, and an entry without an oid is a miss; losing it costs one
   `git cat-file`. Otherwise a committed
   span is mapped through `git diff -U0 -M <at>` to the working tree, so renames are followed and uncommitted edits count;
   a snapshot span is diffed with `git diff --no-index` against its saved text. Both pass
   `--ignore-cr-at-eol`. A hunk wholly above the span shifts it; a hunk overlapping it changes it;
   a pure insertion counts as inside only between two of its lines. A query is re-run and its
   `{path, text}` set compared, line numbers ignored. A source expires after
   `evidence_max_age_days` in `.agentics/config.json` (30 by default). A derived item is stale when
   what it rests on is stale and suspect when it is suspect. Untouched anchors are **standing**; a
   changed one is **suspect**. A line that only gains or loses its final newline is no hunk under
   `--ignore-cr-at-eol`, so it changes nothing.
2. **Re-judge.** Suspect items whose anchors lie on the survey's ground (`bearsOn`) go, up to twenty per call, to an analyst on `haiku`, each claim and
   each changed anchor's old and new text in its prompt. It returns a ruling per id, and
   `recordRulings` records one per id it was handed: an id with no ruling, or one off the ladder, is
   `unsure`. `holds` re-anchors the item where the text now is; `fails` and `unsure` make it
   **stale**, because an unsure check is never a pass. This is the stated exception to the
   intelligence tier: the question is narrow, and any doubt makes the item stale, never standing, so
   being too cheap can cost money but never correctness. Whether text changed is always the diff's call;
   the model rules only on whether the change matters.
3. **Narrowed re-survey.** The survey offers the stale items' topics to its planner, which searches
   again those that bear on its question, with every standing item handed in as known ground, and
   nothing else is bought again. Its new items make new claims,
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

The `survey` program gathers evidence for one question and never concludes.

1. **Reuse.** When the caller names its `ground`, the program reads the items of earlier surveys
   whose ground overlaps it (`itemsFor`) and whose anchors lie on it (`bearsOn`: a span's path or
   a query's scope overlapping a ground path; an item with neither, by its own ground); when it
   names `items` (in-process only: the ids it already rests on), it reads those too, of any kind
   (`itemsById`). Both go into its own
   log as a `step` (`pool`), and again after the re-judge (`pool:after`) when any was suspect, so
   a relaunch sees what the run saw. An item grounded broadly whose anchors all lie elsewhere is
   neither re-judged nor reused. Standing items become known ground; suspect ones are re-judged,
   twenty to a call, the calls side by side; stale ones, and any not standing after the re-judge,
   make their topic a **stale candidate**, carrying what it used to claim — unless a newer standing
   item superseded them. Only an item a survey recorded, with a ground, makes a candidate: an expired
   source or a sweep's item has no topic a scout could search again, and would otherwise become a
   search of the whole repository. A caller's item a re-judge here leaves not standing is listed in
   the result's `invalidated`, since the folder that cites it lost that ground too. A re-judge that fails records nothing, so its items' topics are candidates.
   A pool that cannot be read fails the `pool` channel, and nothing is reused; one that cannot be
   read again after the re-judge fails it too, and every item that was suspect makes a candidate.
2. **Plan.** One analyst decomposes the question into topics, listed in the order the question
   raises them, names each topic's subtree and the common ground's lines, and is told what the pool
   already establishes, what the asking session has already read (`--read-file`), and each stale
   candidate with what it claimed. It plans only what the pool and the session's reading leave open,
   and adopts a stale candidate only when it bears on the question, by planning a topic under its
   key; that topic is searched again (`again`), its find carrying what it used to claim. A candidate
   the plan leaves out is not searched: the result lists it in `passed`, and a `declared` line names
   it. A plan given the session's reading declares that it left that reading to the session. A pool
   that answers the question buys no search. A plan that fails searches nothing and fails the `plan`
   channel, the stale candidates named as dropped; the context still holds the standing items the
   run reused.
3. **Search.** Each topic is one search ([Searches](#searches)) named `scout:<topic>`, run by the
   scout over the survey's tree, its find the topic, its scope the roots and its subject the topic's subtree (else the
   roots). History and docs run alongside when the plan has a question for them, as searches named `history` (the
   historian, the `history` domain) and `docs` (the doc-researcher, the `web` domain), each failing
   alone. Every search shares one material: the question, the common ground, and inside an
   execution the files changed between the execution's base and its pinned tree (`changed`). The
   common ground is the plan's `{path, start?, end?}` ranges read once by code from the searched
   tree (`rangeExcerpts` in `lib/citations.mjs`, journaled as the step `common`) — numbered lines
   under each path, a path alone read whole, ranges of one file merged, what cannot be read named —
   and labelled as already read, so no scout or judge reads those lines again.
4. **Excerpts.** Judges are dealt first: one analyst per 60 path hits the topic searches
   recorded, at least one and never more than one per topic; `pace: fast` buys one per topic. A
   topic weighs its search's path hits, none when it has none, and topics go
   heaviest first to the lightest judge, a tie to the judge holding fewer topics. Each judge holds
   its topics in the plan's order, and the judges are
   numbered (`judge:<n>`, from 1) in the order of each one's first topic. Each judge's prompt holds
   every one of its topics' searches as `hitExcerpts` renders it ([Searches](#searches)) — its
   status and why, its summary, its hits with their notes and the lines they point at, read from
   the searched tree's root — with each topic's search status and the common ground's lines.
5. **Judge.** Each analyst, **without search tools**, returns items — one claim each, with the
   anchor its kind needs — risks, and a ruling per topic it holds, `anchored` or `unanchored`; a
   topic's latest ruling stands. A judge that lacked evidence says so in its own return; judges
   never wait on one another. A topic given neither items nor risks is dropped.
6. **Record.** The program records each judge's items (`recordSurvey`), all or none: while the
   judge's latest answer holds an item the store refuses, nothing is recorded, and the refused items
   go back to the judge's own session as a `refusals` message ([Conversations](#conversations)). A
   pass that refuses none records every item the store accepts — a correction in place of the item
   it corrects, a refused item the judge did not correct dropped — and a pass that refuses no fewer
   than the one before records nothing, so every topic the judge was given items for is listed in
   `unrecorded`. A judge is never continued as a searcher is: beyond the runner's own resumes
   within a dispatch, its session is resumed for its refusals alone.
7. **Context.** The program writes the survey's one file. It opens with a **digest** of at most
   `DIGEST_BYTES` (10 KB, `digestOf` in `lib/evidence.mjs`): every topic in the plan's order, then
   any other an item names, each with its counts and as many of its claims, one line each with its
   first anchor, as its equal share holds, every claim left out counted under its topic. Then every
   item it returns — the standing items over the caller's ground that bear on it, this run's own
   among them where they overlap it, then every other item its records stored — with the judges'
   risks and the history and docs searches' findings. The digest lands in the file's first part. The
   session, or the planner's brief, reads it; the result lists the reused items first, then this
   run's, by topic.

Coverage is complete when every topic's search ended complete (`done` or `stalled`) and all its
items stand. The survey builds its search coverage through `searchCoverage`
([Searches](#searches)) over every topic, history and docs search, and reads guidance from the
pinned tree (`pinnedOf`): a complete search is a `declared` line; a `budget` search is named in
`incomplete` and a `failed` one in `failed_channels`, each with its line in `unreached`. A topic
not dropped is incomplete when its search ended `budget` or `failed`, its items went unrecorded, or
it was given items and its judge never ruled it or ruled it last as anything but `anchored`;
`history` or `docs` is incomplete when that search ended `budget`. A judge that failed is an
unreached line naming its topics. The survey's
evidence calls — the pool read, the re-judge's record, `recordSurvey` and `surveyContext` — read the
tree it searched, so its anchors and absence queries are about that tree.

### Existing solutions

The `solutions` program frames the capability, sends researchers out by angle and a scout through
the repository, has an assessor weigh the candidates against the frame, and records all of it
in-process (`recordSolutions`); lib decides what the returns mean. The researchers — one per angle
the frame names, up to `max_angles`, the rest named as dropped — and the repository scan are
searches ([Searches](#searches)) over the sweep's tree: each angle one search named
`research:<angle>` (the doc-researcher, the `web` domain, its material the capability and the angle,
a candidate being a hit carrying `candidate`, one per candidate key), and the scan one named `repo`
(the scout, scoped to the roots, its material the frame's repository question). A complete search
with no hits is a `declared` line, never a loss. The sweep builds its search coverage through
`searchCoverage` ([Searches](#searches)) and reads its guidance from the pinned tree (`pinnedOf`):
a search that ended `budget` is named in `incomplete` and one that `failed` in `failed_channels`,
each with its line in `unreached`. The assessor is a judge sharing no session with any researcher
(its producers are every research search's `sessions`), and its units are the candidate names the
researchers reported, case aside: a name it did not rule `assessed` leaves the sweep incomplete
(`assess:<name>`). A frame that fails or names no angle searches nothing and fails `frame`; a
failed assessor fails `assess`, and a record that failed fails `record`. A candidate is viable when
it hit none of the frame's disqualifiers; a ground the frame never declared rules nothing out and is
named; a candidate a researcher reported and the assessment dropped is named as lost; without an
assessment the researchers' candidates are carried unmeasured, neither viable nor ruled out. A lost
candidate, a ground the frame never declared and notes the assessment left unsettled each add an
`unreached` line, so the sweep is not complete; the summary names each of them. Each
candidate with a source is recorded as an `external` item anchored at it, and each hit the
repository already carries as a `behaviour` item anchored at that line of the sweep's tree, and all
of it goes into one summary file the session reads. A record the store refuses costs no coverage. A sweep answers its
capability whole, so once a later sweep records items for a question and topic, `itemsFor` leaves
out every item an earlier sweep recorded for them. A sweep is dated by the `seq` its return first
recorded at, and an item the later sweep repeats is the same item and stands.

### Investigations

The `investigate` program runs the survey of its question inside its own run — one log, one
`max_agents` bound — with no `ground`, so it reuses nothing from earlier surveys, and then one
analyst, `synthesis`, handed the survey's context whole (`readContext` in `lib/citations.mjs` reads
back every part `writeContext` wrote) with a caveat per
gap in the survey's coverage: topics dropped, topics or channels not searched to exhaustion, a
failed history or docs channel, what was never reached. With `--as-tasks` the analyst returns an
ordered task list (`investigate_tasks`: a summary, the gaps the evidence cannot settle, and tasks
that each stand on their own, ordered by `blocked_by`); otherwise a written answer
(`investigate_report`). Nothing caps the tasks: a count that dropped some would hide work (L2). A
survey that established nothing still gets its synthesis, which says so and names what would have
to be gathered; an empty question searches nothing and starts no synthesis, and the survey's
coverage says why. A synthesis that failed leaves the evidence in the result and names its loss
(`synthesis`).

### Cites and evidence.md

A folder records the items it rests on, with the coverage gaps it rests on them despite, as a
`cites` line (`evidence.mjs cite`). The folder's latest line by `seq` is its whole citation, never
merged with its earlier lines, so Analyze cites everything the folder rests on each time, in one
`cite` naming every run the folder rests on. Its
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

One distinguished kind, **`command`**, records how to build, typecheck and test: each of
`build`, `typecheck`, `suite`, `suite_fast` and `test_one` (`COMMAND_NAMES` in `lib/gotchas.mjs`),
named or declared absent. Two writers supply it: the session, whose `commands_file` preflight
writes as command gotchas (source role `session`; a command marked absent is written absent even
when a value is given too, `test_one` has no absent, and a command already established stands),
and an investigator's return. The command gotchas are the one source of the established commands:
leaf-open, the leaf brief and every measurement read them (`commandsOf`), never the execution's
envelope. leaf-close refuses a command gotcha a producer returns, and a stale id naming one, each
with a note on the round's close record, so no producer changes what verification runs.

**Where and how.** `.agentics/<effort>/.state/knowledge/<id>.md`, one file per gotcha, with
a one-line JSON frontmatter: `kind` (`pitfall` | `command`), `roles` (who needs it), optional
`paths` (prefixes of the files it applies to), `observed_at` (commit) and `source` (node and role). The id
is minted by code from the normalised trigger, so the same trap recorded twice is one file. A
producer returns gotchas in its return, and leaf-close writes them. Brief assembly appends every
gotcha whose `roles` include the brief's role and whose `paths` (if any) overlap the files its leaf expects. A gotcha
an agent observes no longer holds is deleted, not marked.

**Why so narrow:** a memory that stores claims about the code goes stale silently and is then read
as fact; a gotcha is checked the moment it is used, because the trigger either happens or does not.

---

## Execution

An execution runs a subtree in the integration worktrees of its composites and in per-leaf
worktrees, and never touches the user's tree. It is the `execute` program, which develop starts
detached ([Detached runs](#detached-runs)) over one folder — a folder with a spec; a task or a
group runs with the folder that holds it. The program mints the execution's stamp itself; started
again on a folder an open execution holds, it resumes that one. Every git call names the repository
with `git -C`, and every agent is given absolute worktree paths, so nothing an execution creates
depends on a process's working directory.

### Boundaries

Every deterministic step is a boundary: a function under `lib/boundaries/` the program calls
in-process (`execution.mjs`, `leaf-open.mjs`, `leaf-close.mjs`, `leaf-review.mjs`, `merge.mjs`,
`integration.mjs` and `spec.mjs`, over the records core in `records.mjs`), which reads what it
needs from the records, git and the runner's stored returns, and records what it decides through
the execution's log before it returns. It reads a dispatch's stored return only once that call
returned (`returned` with status `returned`): the return a call that ended failed kept on disk
(`watch_failed`) is not read. Every boundary is **idempotent**: run again after a
crash, it converges on the same state, because each step first checks whether its effect already
exists (a merge already in the branch, a record already the node's word, a worktree already
attached).

| boundary | steps |
|---|---|
| **preflight** | refuse what cannot run — a git older than 2.38 (`git_too_old`, `GIT_MIN` in `lib/store.mjs`: the series check reads `merge-tree --write-tree` and `log --remerge-diff`, [Role rules](#role-rules)), an effort it cannot read (`unreadable`), a folder that is no node (`no_such_node`), an effort root that is a leaf (`root_is_leaf`), a landed effort (`landed`), an execution whose envelope names another root (`wrong_root`), a store whose stamp is not this version (`store_version`, [Store stamp](#store-stamp)), and, writing a new envelope, a `base_ref` that names no commit (`no_base`) or a `commands_file` that is not readable JSON (`commands_unreadable`) — writing nothing; adopt or write the envelope (`execution.json`: base, dial, pace, and the commands the session wrote to `commands_file`); write the session's commands as command gotchas ([Gotchas](#gotchas)) — refusing `commands_unwritable`, naming each command the gotcha store refused, once the envelope is written, so a run again writes only what is missing; read every integration branch in scope for commits no record accounts for ([Outside work](#outside-work)), refusing `unreadable_branch` when git cannot read one; traceability; stop at `integration_lost` ([Outside work](#outside-work)) and then at `outside_work` before every other checkpoint, and never confirm past either, and then at a checkpoint not confirmed past ([Resume and checkpoints](#resume-and-checkpoints)), its lists (the overlapping executions, the gaps, the branches with their unaccounted commits) on its state line, for the session to read with `lib/status.mjs checkpoint`; on a resumed execution with no checkpoint, check whether the base moved under its leaves and write the ruler's brief and its record, and, with no checkpoint, write the brief on the drift of adopted records no ruling covers yet ([Landing and drift](#landing-and-drift)); free this execution's slots, its dead worktrees and merged leaves' worktrees (clean ones only — a dirty one is reported, never forced) |
| **schedule** | compute what to launch from the records (`lib/schedule.mjs`, see [Scheduling](#scheduling)); park a folder the user writes that has nothing planned (`needs_design`); approve a leaf the resume ladder finds measured green, with no review loop of its own and no approval standing; what a pass records is recorded and the launch computed again, until a pass records nothing |
| **leaf-open** | acquire a slot, asked once (`no_slot` goes back to the program, which waits); ensure the parent's integration branch (lazily, refreshed from its own parent, each branch of the chain under its own lock in turn) and cut or attach the leaf's branch and worktree, brought up to that parent's head — a round a `rebase` message waits for leaves a conflicting refresh in the worktree for its producer, and an open run again takes that merge in progress as its own ([The judge](#the-judge)); compute the round — the round of a dispatch this execution started and never got back, else one past the latest; only a producer's or an auditor's dispatch is a round — its role from the records, its thread (resumed, fresh, or fresh on a raise, [Conversations](#conversations)), its tier and its permissions from its role ([Role rules](#role-rules)); build its thread brief; record `retried` when the round resumes a thread after the user's `retry` cleared the leaf's stop, and `notes` when the round starts a thread this execution never dispatched ([Conversations](#conversations)); a refusal escalates `open_refused` |
| **leaf-close** | first put right what a verify cut off in the worktree left ([Verification](#verification)); read the producer's stored return — a round closed again with no `dispatch`, over the work a retry measures first, has none to read and is measured as no producer's ([Resume and checkpoints](#resume-and-checkpoints)); none, or a producer's with no string `status`, holds the leaf on a `role` fault, and an auditor's, which carries no status, reads as `done`: a park, an escalation, a request for the planner (or the `needs_respec` park of a folder the user writes), a `needs_tests` or a `declined` for another session is recorded and routed without measuring, and so is a return naming what it could not read (`unread`), but a path its `dispatched` line's `deny_read` holds, escalated `unread_reference` ([Producer returns](#producer-returns)); otherwise, a round that returned no commits included: measure nothing while a rebase merge the round opened is unconcluded (a `failures` message, `source: the rebase`, naming the unmerged paths; at a head the leaf was sent back at already, the rebase's among them, it escalates `merge_conflict`); commit a shell-less author's files its role may write (`authored`) (a close cut off after that commit finds it in git and journals it), and put every other uncommitted file back to the head; journal the series as `series-done`, from git, when the producer declared it done; measure by rigor — build, typecheck, its own tests, discriminator, declared mutations and named checks; write and delete the gotchas it returned, never a command one; compute the close decision and record it — the approval, the escalation, the next round's message (`failures`, `surviving_mutations`, `tests_ready`), a verify leaf's finding (the `needs_respec` park of a folder the user writes beside the leaf's escalation; under a planner's folder the finding is the route and the leaf is not escalated, [Replanning](#replanning)), every send-back through the loop guard (`sendBack` in `lib/boundaries/loop-guard.mjs`, [L2](#l2--states-end-work-counts-dont)): `fix_without_commits`, carrying the measured failures, when the round returned a head the leaf was already sent back at, unmoved — a test round's redeclared mutations count as moving it — and it still fails, `verify_not_converging` when the failures repeat the last verification send-back at a moved head, and failures an earlier one held marked to ask the leaf's convergence ruler; hand back `command_unknown` until an investigator of this execution has returned, and escalate it after; a cycle's consolidation round approves instead of any other decision, at its commit when it passes and on its revert otherwise ([Rigor](#rigor)); write the round's close record. What it reads of the rounds before spans executions, as a leaf's rounds do ([Resume and checkpoints](#resume-and-checkpoints)) |
| **leaf-review** | read the reviewer's stored rulings over the units its brief listed; compute the review loop's exit (`reviewExit`) against what the round before left open; record the approval or the escalation, or the open findings as `findings` messages, one per thread, for the next round — an approval a cycle's last member owes its consolidation round records the `consolidate` message instead; write the review record, its `retire` findings and its `rulings` kept; read the stored ruling of the leaf's convergence ruler, asked before a round opened (`convergenceRuling`): `not_converging` escalates `not_converging`, `said` the ruler's dispatch, `converging` records nothing, and a return with no ruling holds the leaf on a `role` fault; and, once the session retried a leaf its review loop stopped, record the stopping review's open findings as the next round's `findings` messages (`reviewResumed`) |
| **merge-batch** | under the branch lock, set aside for the judge each leaf or cycle whose contention facts no standing ruling covers ([The judge](#the-judge)); read back the outcome of a batch already taken at its identity, and escalate each child `merge_no_progress` when every part of it was taken up ([Merging](#merging)); record `batch-started` with the head it starts from and its identity; merge every other approved child into one integration branch in dependency order; verify the merged head with the fast suite; bisect a red one; write the batch's record and the ruler's brief, then append the `batch` state line, then `merged` and `merge-observed` for each child not merged before, so a batch run again never resets the merges its outcome names; remove each merged leaf's clean worktree, keeping its branch; send each leaf that fails alone a `failures` message (`source: integration`); hand a leaf's conflict to the judge when its executor can conclude a merge and no failed resolve of it stands; record what stops — any other conflict, a combination failure, a composite or a cycle failing alone, a batch that could not run. A batch that started and never recorded its outcome is reset to where it started and done again, so an unverified merge is never recorded as landed; one during which the user's checkout moved is reset and decides nothing (a `checkout` fault) |
| **suite-gate** | on a composite whose children have all merged, under its branch lock: run the full suite and the criterion checks of its plan on its integration head, against the head it was cut from; record the measurement and a `gate` state line; escalate `fails_full_suite`, `fails_on_integration` or `suite_gate_failed`. It runs nothing where the repository does not split its tests and its plan names no check, or where a gate over the same checks already passed at that head in this execution ([The suite gate](#the-suite-gate)). A gate that passes says whether the integration review is earned, and records one that is not as `claims` with `review: not_earned`; one during which the user's checkout moved decides nothing (a `checkout` fault) |
| **folder-review** | read the integration reviewer's stored rulings; record its claim rulings as `claims` at the head it judged, `said` the reviewer's dispatch, with the prior claims it left standing and the anchor of each unit that holds a ruling ([Review delta](#review-delta)); record the one park they earn, a new record after the claims it follows even where an older park stood; a review that returned nothing holds the folder on a `role` fault |
| **rule-close** | read a ruler's stored rulings on drift or a moved base; record `drift-ruled` or `stale-ruled` with the ruler's `why`; park what the user must answer and hand the program what the planner replans; park a drifted consumer no ruling reached (`contract_drift`), hold a moved leaf no ruling reached on a `role` fault |
| **postflight** | release this execution's slots; summarize the subtree from the records (the nodes the user must act on, the leaves waiting behind each, cycle members held); append `closed {status: done}` when every leaf in scope merged; count the branches eligible for cleanup. The run's `ended` is `lib/run.mjs`'s |

The spec boundaries of a planner's folder are in [Autonomous review](#autonomous-review).

**A record lands once.** A boundary appends a record only while it is not already the node's word
(`freshRecords`): a stop while it stands, an approval at the same head, a review's claims at the
same head while they stand, a fault once per node and channel in a run, a ruling (`judged`,
`drift-ruled`, `stale-ruled`) once per node and ruling dispatch (`said`), a
message once per node, thread, round and `msg`. So a boundary run again
after a crash lands nothing twice, and the same decision taken again — after a retry cleared a stop,
at a new round — lands again.

**A unit is in flight until its records say it ended.** The program keeps its running units in
memory and passes them to `schedule`, which launches nothing beneath a running or replanning node. A
program that died loses that set and rebuilds it from the records: a dispatch with no `returned` is
resumed, a batch with no outcome is reset, and everything else is decided again from disk. A unit
records its own faults and never rejects: a throw inside it is a `program` fault on its node, and
the unit ends — `faulted` even when that fault cannot be recorded. A unit that settles with nothing
recorded by anyone while it ran, and that waits on nothing (its outcome is not `requeue`, `route` or
`paused`), would settle the same way on the same records: it records
`fault {channel: program, detail: settled with nothing recorded}` on its node, which holds the node
for the run and which the coverage lists ([Faults](#faults), P5).

**Checks run as the program's own children.** leaf-close, merge-batch and suite-gate measure through
`measure` (`lib/measure.mjs`): `node lib/verify.mjs --options -` as a child process the program
awaits, its options on standard input, so the event loop — the heartbeat, every running call's
stream — goes on through minutes of suite. Each measurement is keyed (`key` on its `verify-observed`
line) by what its answer depends on — the worktree's head and status, the base, the mode, rigor,
role and producer, the commands, the mutations, the tests, the checks, the approved cases, the
expected files and the fences — and one this execution already journalled at the
same key is handed back instead of taken again, by a relaunch and by the same check asked again
within the execution — unless its environment broke, or its node was cleared since
([P3](#p3--state-is-derived-records-are-written-as-things-happen): the key holds nothing of the
environment, and a user retries a node once they have fixed what failed it). The main checkout is
read before and after each, and two checks one leaf-close measures back to back share the read
between them: nothing a close does between them writes what the watch reads, and a move of the
user's checkout between the two is the second's `checkout` fault. Once the after-read has been made
`measure` journals `measure-done {key, moved}`. A `verify-observed` line no `measure-done` at its
key follows was never vouched for by the watch (it threw, or the process died first), so it is taken
again; a journalled one handed back carries the `moved` its marker recorded. A moved ref is a
`checkout` fault on the node, and the measurement decides nothing. No host time limit applies to
them. Inside one leaf-close, the worktree's HEAD and status are read once and read again only after
a step that writes git there — a commit, a revert, a measurement — and nothing a close read outlives
it.

**Integration branches are locked while they move.** leaf-open creates, attaches and refreshes each
integration branch on its chain under that branch's lock, and cuts the leaf under its parent's, so
concurrent leaf-opens and a merge-batch bisecting into the parent never race.

**What only the program sees, it records.** A throw inside the program, and a dispatch that ended
without a return, are faults ([Faults](#faults)), recorded by the program itself on the node they
hit; a fault on a consumer whose drift a ruler ruled affected, and that nothing answered yet, parks
it `contract_drift` as well, because drift is found only on the batch that landed it. The user is
reached for two things only: a premise a parallel change made obsolete (after the ruler ruled it
so, [Landing and drift](#landing-and-drift)), and a complication no agent could resolve: a review,
a conversation or a replan that does not converge, a merge conflict, a broken environment, a
producer that is blocked.

### Merging

Merging is `lib/merge.mjs`: `git merge --no-ff` in the integration worktree, aborting on conflict
itself. The merge-result contract:

Merge mode reports exactly four fields: `stop_reason` (`completed` or `environment_broken`),
`merged_sha` (`''` when the merge did not complete — a fact, not a verdict), `conflicts`
(conflicting paths verbatim from git; empty when none), and `notes` (what was actually run). The
caller derives the outcome as `mergeOk = stop_reason === 'completed' && merged_sha !== '' &&
conflicts.length === 0` — never from `conflicts` alone, because an `environment_broken` merge has
an empty conflict list too. A conflict whose merge was aborted holds back its unit and every unit
built on it (whose head contains its head), and the other units merge (`mergeUnits` in
`lib/integration.mjs`); a cycle merges through its tip, so its members land together or not at all,
and the program hands a cycle whole or not at all (a member handed without its tip is refused
`cycle_split`). A batch has an **identity** (`batchIdentity`): its target, the head it starts from
once refreshed, its units' heads, and where the target and each child were cleared
([P3](#p3--state-is-derived-records-are-written-as-things-happen)), recorded on its `batch-started`
and `batch` lines and naming its record, `merges/<key>-<identity>.json`. A batch whose identity has a
`batch` line already is not merged or measured again: its outcome is read back from the record, and
each part of it no record took up after that line goes through the outcome again — a conflict or a
contended unit to the judge (`judged`), a leaf failing alone to its `failures`, a stop to its
escalation, drift to its ruler, each replayed by its ruler's `said`. When every part was taken up,
the same children at the same heads were handed again for nothing, and each child — never the
target, whose stop would hold its other children — escalates `merge_no_progress`, the one place
that reason is raised. A leaf with a `rebase` message newer than its latest round opens that round, whatever its
latest round's close left to resume. Every tick reads each such round still owed — an approved leaf's
`rebase` or integration `failures` message newer than its latest dispatch, a cycle's tip only
(`owedRounds` in `lib/programs/execute.mjs`) — from the records and runs it, rather than merging the
head that round must change; a cycle with a member owed a round or held stays out of a merge whole
(`mergeable`).
Anything else that is not `mergeOk` stops the batch. A conflict is never
resolved on an integration branch: a leaf's goes to the judge, who may send the leaf a rebase round
to resolve it on its own branch ([The judge](#the-judge)), and any other reaches the user.

A merged head is measured with the fast suite (`suite_fast`), or the full one where the repository
does not split its tests. The big tests wait for the [suite gate](#the-suite-gate).

**A failing merged head** is reset to the last green head, and the program bisects the batch. A leaf
that fails alone on the new head gets a fix round on its branch refreshed from the integration head,
told what failed by a `failures` message (`source: integration`), and is kept out of merges while it
runs; a composite or a cycle that fails alone has no one producer to send it to, and escalates
(`fails_on_integration`); leaves that each pass alone and fail together escalate as a **combination
failure** naming all of them — it is a design question, not a leaf's. A conflict the batch's first
merge met stands through the bisect: the unit it stopped at was never merged, so no bisect measures
it, and it goes to the judge or escalates `merge_conflict` in the same batch. A batch that cannot run at all escalates
its target (`merge_batch_failed`): nothing is re-batched into a stopped target.

### The judge

Inside one folder merge-batch already serializes: a later unit merges on top of an earlier one, the
fast suite measures the combination, and the bisect finds a pair that fails together. What it cannot
see is two folders' work meeting: each merges cleanly into its own branch, and they first meet when
the folders merge up, as a composite conflict no producer can resolve. So the ruler is asked at the
merge, a `ruler_contention` ruling, about two things (`lib/contention.mjs`, `lib/boundaries/judge.mjs`):

- **Contention.** Before a leaf or a cycle (through its last member) merges, code computes its facts
  against every leaf of another folder that no dependency or standing serialize ruling orders with
  it, outside its cycle, whose work has not merged where the two meet (its ancestor just below their
  lowest common ancestor has not merged): a path of the unit's net diff that the other leaf's net
  diff also holds is an `overlap`; one the other leaf only expects is a `folder` fact. A fact a
  standing `resolve` ruling of the unit covers is none, and a ruling stands only while the unit's
  head and the other leaf's are the ones it was given and its node has not been cleared since
  ([P3](#p3--state-is-derived-records-are-written-as-things-happen)). A unit with facts is set aside from the
  batch.
- **Conflict.** A leaf whose executor has a shell to conclude a merge, whose merge conflicted — of a
  cycle, its tip, whose rebase round goes to its implementer — unless a `resolve` of a conflict on the same paths at an earlier approved head stands
  since the leaf was cleared: that remedy failed, and the conflict escalates `merge_conflict` until the user's retry asks again.

The merge unit dispatches the ruler on `judgeThread`'s `ruler:<trigger>:<unit key>:<head8>:<digest>:c<cleared>`
— the digest of the facts, the other leaves' heads and the paths, and where the unit was cleared —
so the same question replays its ruling and changed facts or the user's word ask a fresh one, on the folder being
merged into, tool-less, handed both sides' plan entries and changes (for a conflict, what merged into
the folder since the unit was cut); it rules each contended leaf, or the one unit `integration` for a
conflict, `serialize`, `resolve`, `replan` or `cant_rule`. A unit the ruler left out of its rulings is
its miss, as a reviewer's is ([Executors and review](#executors-and-review)): a fresh ruler on
`<thread>:<n>` is handed only the units still unruled, and their rulings join the first
(`judgeClose`'s `also`); a unit an earlier ruler of the question missed too ends the asking and
escalates the leaf `review_incomplete`. Code combines (`combineRulings`): a `cant_rule` escalates the
leaf (`contention_unruled`, or `merge_conflict` for a conflict) — with a miss, the only ways the judge
reaches the user; else a `replan` goes to the program's replan, as
a ruler's `affected` does ([Replanning](#replanning)), and the unit stays out of merges until its
plan revised it; else a `serialize` makes the unit wait, but only on a leaf first dispatched before
it, so waits never form a cycle (a serialize against a later leaf reads as `resolve`, and that leaf's
own merge meets this unit); else it is resolved. Every outcome is one `judged` event, once per node,
trigger and ruling dispatch (`said`).

- **serialize** — the unit stays approved, so it occupies no slot, and `schedule` merges it only once
  each leaf it waits on has merged where they meet. It then merges into its folder's branch, which
  merge-batch first refreshes from the branches above, so it lands on top of that work: a conflict
  there is a conflict, a combination failure the bisect's. A stopped leaf it waits on is what the
  execution's summary names it held behind.
- **resolve** — contention: the unit merges in the next batch. A conflict: a `rebase` message waits
  for the leaf's next round, and the program relaunches it as it does a leaf that failed alone, kept
  out of merges until approved again.

**The rebase round.** A round that a `rebase` message waits for refreshes the leaf's branch from its
parent's head and, on a conflict, leaves the merge in progress in the worktree (`mergeForRebase` in
`lib/merge.mjs`) for the producer to resolve and conclude with `git add` and `git commit`; its base
is the head it merges, so its series is its own work over it. The round may write what its role's
rule admits plus exactly the conflicted paths the judge sent (`resolves` of `rolePermissions` in
`lib/permissions.mjs`), so a green's implementer can resolve a conflicted test. A deny wins over every
allow, so a test path to resolve lifts a `no-tests` round's test denials; what else of the tests it
writes, the series check finds: every path the judge ever sent the leaf (verify's `resolves`) is
judged per commit and admitted only in a merge commit's resolution, its remerge diff, so a later
ordinary commit to it is held to the role; each other path is judged by the role, and a test it resolved is named in
`tests_rewritten` for the leaf's reviewer whatever the leaf expects ([L3](#l3--separate-judges)). A leaf owes the rebase until a
round opened for it returned — a dispatch on the message's thread, at its round or later, whose
`returned` line says `returned`, in whichever execution — or the leaf is approved or merged after
the message (`rebaseOwed` in `lib/tree.mjs`; leaf-open, the leaf unit and a green's round role all
read it so): a round reopened before it returned keeps a conflicting refresh too, even one its
producer aborted, and so does the next a later execution opens past it, while every round after
the one that returned is an ordinary round. An open run again finds the merge in
progress and takes it as its own; every other round refuses a conflicting refresh (`open_refused`).
leaf-close measures nothing while the merge is in progress ([Boundaries](#boundaries)).

### The suite gate

A repository may split its tests into fast and big ones, and name the fast ones as `suite_fast`
beside the full `suite`. Then the tests run in three places, each wider than the last: a leaf runs
the tests its planner picked ([Atomicity](#atomicity-when-to-stop-splitting), condition 4); every
merge-batch runs the fast suite on the merged head; and once a composite's last child has merged,
before its integration review and so before it merges up or lands, `suite-gate` runs the full suite
on its integration head. At the effort root, that is the last measurement before landing.

A test failing on the gate that fails at the head the branch was cut from is not the composite's
(`baseline_failing`, as everywhere). Any other failure escalates the composite (`fails_full_suite`):
its merged work has no one producer a fix round could go to, and the user routes it, as with a
composite that fails alone on a merge. A gate that could not run escalates as `suite_gate_failed`. A
passing gate is recorded against its head and not run again there. A failing one asked again at the
same head within the execution reuses its measurement, journalled at the same key
([Boundaries](#boundaries)), until the user retries the composite; the next execution measures it
again too, since what failed it may be the environment.

**A plan criterion with a check is measured, never ruled.** A leaf's criterion checks run at the
leaf's own head, and the folder's head moves on after it merges. So the gate also runs, at the
integration head, the `check:` of every criterion of the plan the composite's spec holds — its own
tasks and its groups' (`criterionChecks` in `lib/boundaries/merge.mjs`), each command once — as
named checks in the same measurement. A check that fails, other than for tests that fail at the base
too, fails the gate; with the suite passing, the composite escalates `fails_on_integration`. The
`gate` line carries the checks' digest, so a passing gate stands only for the checks it ran. The
integration reviewer is handed the results under `## Measured` and is told to leave those criteria
out of its claims, as it leaves out a `HUMAN:` one; no such criterion is a unit it rules, and a
later review decides a prior claim about one it rules again by its result. A criterion's verdict is an observation, and
no reviewer's `cant_tell` stands in for one.

Where the repository does not split its tests and the plan names no check, every merge-batch
already ran the full suite on the very head the gate would measure, and the gate runs nothing.

**Why the big tests wait:** they are slow, and a run of one per merge-batch would make every merge
pay for them. A folder's integration branch is where the work of many leaves first meets whole,
and it is the last point before the work leaves the folder: one full run there catches what the
fast suite misses before anything outside depends on it.

### Scheduling

A ready set per execution, recomputed by the `schedule` boundary (`lib/schedule.mjs`, pure over
the node records, the event log and the execution's state log) whenever anything in flight settles.
The program passes what it has in flight — its running units, and the folders a running unit is
replanning — and launches what comes back.
Nothing below a running or replanning node launches, and a node a fault of this run holds
does not launch at all. A unit that settled while nobody recorded anything (the effort's `seq`
counter did not move; `lastMinted` in `lib/ledger.mjs`) would settle the same way on the same
records, so the program does not launch it again until something is recorded, and the run ends
when only such units are left; a leaf that found no slot is the exception, asked again as below.
Every pass of the loop gives the event loop a turn, so the heartbeat and a child's spawn and exit
are never starved by units that settle at once.

A leaf's dependencies are its own and every ancestor's: a dependency declared on a composite or a
group binds every leaf beneath it. A leaf is ready when its dependencies' outputs exist where it
will be cut — a dependency (or its ancestor just below the two nodes' lowest common ancestor,
groups passed over) has merged into that ancestor's integration branch, or, for a cycle predecessor,
is approved — no open escalation or park sits on its dependency chain, and a slot can be had. Leaves
launch up to the pool less the leaves running.

**Expected files defer, they never hold.** A leaf whose `expects` meets the `expects` of a leaf no
dependency orders with it that runs in this execution, or stands active or approved and unmerged in
the tree, waits, and of two ready leaves that expect one file one launches per pass. When such
deferred leaves are all that would launch and nothing of this execution runs, they launch anyway, one
per pass: a prediction defers work, it never blocks it, escalates or parks. What two leaves really
both changed is merged in order inside a folder and ruled by the judge across folders
([The judge](#the-judge)).

A folder with nothing planned beneath it is planned, up to the pool less the plans running, when
the planner writes it; one the user writes is parked `needs_design` by the tick that finds it. A
folder the planner wrote that its compile parked `spec_changed` (the park's `return`) is re-derived
once per park: again only when this execution has no planner dispatch on that folder newer than
that park. One the planner wrote whose spec is edited past its last `prepared` line while it is
parked (but for `spec_changed` and `design_spend`), or whose latest stop is cleared (a `replanned`
newer than it: a retry, an answer), is planned `spec_edited`: one plan per stop and clearing, its
first step keyed by both (`editedPlanKey` in `lib/boundaries/execution.mjs`), so a relaunch resumes
the plan a dead run left, whatever the text became under it. A plan that stops leaves a stop of its
own, and one that prepares leaves nothing edited. A stale planner's folder
([Specs, approval and compile](#specs-approval-and-compile)) launches no integration review until its
new plan is compiled.

A merge-batch runs whenever approved children wait on an integration branch nobody is merging into,
at the heads their approvals named; a leaf still running (a fix round after it failed on the
integration head) is not among them. Cycles are held and land as a unit. A `reviewing` composite
is reviewed at its integration head, and an `integrated` one — its review standing — is ripe to
merge up. So a folder whose park was answered, or under which something merged again, is
reviewed again before it moves.

**Parallelism lives at the leaves and is controlled from outside the execution.** A slot is the
right to run one leaf. The pool is `.agentics/.state/slots/`: its size comes from the project's
settings file, which the user edits (`.agentics/config.json`, `max_parallel`, default 4), read at
every leaf-open, so a change takes effect
on the next dispatch in every running execution at once. Slots are lock files naming their holder
leaf, acquired at leaf-open. A slot is free when its holder's derived status is no longer active
(approved, held, merged, escalated or parked) — or when it is no longer a leaf, because a replan
decomposed it — so release needs no write of its own. A slot whose
holder belongs to an execution that is no longer running is freed by that execution's next
preflight, or by the user.

**Who controls what.** The `schedule` boundary decides *which* leaves are ready and in what order —
arithmetic over the plan and the events, on disk — and launches no more leaf chains than the
pool's current size. *Admission* is decided by `lib/locks.mjs` inside leaf-open: the entry point
takes a slot. A slot is shared with every other execution and session, so nothing in this execution
says when one frees: leaf-open asks once and answers `no_slot` at once, and the program asks again
when another unit settles, or two seconds later when nothing runs; nothing stalls. The user
controls the limit.

When the user set a token target (`budget`), the program starts no new leaf once what is left of it
— the target less the tokens the execution's calls returned, over all its runs — is spent, or is
below the tokens the execution measured per merged leaf: a count deciding when, never what (L2).
`pause` is a launch flag that does the same once the run's first merge unit settles; the session's
`pause` call ([Session calls](#session-calls)) stops a live run at once, launching nothing, a merge
included, until `resume`. Either way the
units in flight finish, folders are still planned and merges still run, and the run ends `stopped:
budget` or `stopped: pause`. While a merge runs, no leaf that consumes a contract starts: its drift
is known only once that merge is ruled on. A leaf that failed alone on an integration head is
relaunched by the program and kept out of merges until it is approved again; merges, reviews and
merge children a fault of this run holds are not launched again in the run.

**Why a lock-file pool rather than a scheduling agent:** the pool is arithmetic, costs no tokens,
is shared by every execution and every session on the machine, and survives any of them dying. A
persistent agent receiving messages could do the same job, but it would put a model on the
scheduling path (P2) and re-read its growing conversation on every message.

### Coupled work

A leaf that expects a designated shared file (an ancestor composite's `shared`: lockfiles,
configuration roots, barrel files) is **coupled**. It runs on its own branch cut from its parent's
integration head, under the same rigor, verification and review, and merges through a
merge-batch. Coupled leaves run one at a time; everything else keeps running.

### Role rules

What a producer may write is its role's rule, never a list of files (`writesOf` and `rolePermissions`
in `lib/permissions.mjs`):

| producer | writes |
|---|---|
| an implementer, but a green's; a red's test-author | any file of its worktree but the store's folder (`all`) |
| a green's implementer; an auditor | any but a test file (`no-tests`) |
| the test-author of a green's or an audit's test round, and of a `tests-only` leaf | test files only (`tests`) |

A test file is what the test-file table names (`isTestPath`, `TEST_PATTERNS` in `lib/store.mjs`), so
what a call may write and what counts as a test agree name for name. A red's test-author writes like
any writer because, where the typecheck covers tests, it writes the throwing stubs of the files its
green builds ([Rigor](#rigor)); the red verdict fails anything else it breaks.

**Prevented.** leaf-open turns the rule into the call's permissions: an `Edit` and a `Write` rule
for `/**`, the call's worktree, or for each test-file glob at any depth; `--disallowedTools` for
`/.agentics/**` always, and for the test-file globs where the role may write no test. A leading `/`
anchors a pattern at the call's working folder, so the rules reach neither the main checkout nor a
sibling worktree, though both contain the leaf's worktree (`test/host-contract.test.mjs` holds the
host to this). Deleting a file is writing it: an implementer deletes with `git rm`, one of its role's
commands. A rebase round may write the conflicted paths it resolves too ([The judge](#the-judge)).

**Detected.** What permissions cannot stop is a file a repository command wrote, or a path a git
command staged. The series check judges the role on the series' net diff, base to head (`role-breach`,
[Verify payload](#verify-payload)): nothing under `.agentics/`; a green's or an audit's own commits
change no test file; a commit the program made for a cycle's test round or a `tests-only` leaf's
test-author changes only test files. A net-diff hit that counts — a test file, or a path the role may
not change — is read again by content where either side's blob holds a carriage return: a file whose
text, read through `textOf` in `lib/store.mjs` (LF line ends, no byte-order mark; `readText` is the
one port a file's text is read through), did not change is no change. A breach is blocking, so it is a fix round. The round's
uncommitted files are put back to the head before it is measured, and nothing is reverted out of a
series. A test file the series rewrote that exists at the base, outside what the leaf expects and the
cycle's tests, is named in the measurement (`tests_rewritten`) and handed to the leaf's reviewer, or
the folder's integration reviewer, as a `file:` unit to rule closely: a weakened assertion that let a
change pass is no longer stopped by a fence, so a reviewer must see it.

**Expected files.** A leaf's `expects` is the planner's prediction of what it will change, and what
reads it is the scheduler ([Scheduling](#scheduling)), the coupled lane, drift on a moved base
([Landing and drift](#landing-and-drift)), the fit estimate, the brief's evidence, gotchas and
guidance, and the judge's `folder` facts. A leaf that changes a file it did not expect is measured
and reviewed like any other.

### Review delta

Every review that is judged again rules only what moved since a ruling was made. One pure function
computes it (`reviewDelta` in `lib/review-delta.mjs`): given the rulings that stand from earlier
reviews, each keyed by its unit and the **anchor** it was ruled at — a digest of what the unit stood
on — and the units under review now with their anchors, it returns the rulings that **stand** (the
same unit at the same anchor, the ruling carried whole), the units to **rule** (none ruled before,
or ruled at another anchor, that earlier ruling handed on as `was`) and the rulings **gone** (their
unit no longer under review). A whole review is the empty prior. Only a ruling that settled its unit
is handed in as prior: a ruling that left the unit open — a unit a judge left unruled or declared
unexamined — is no prior, so the unit is ruled again. What a judge left open is not a unit ruling but
an open item (a blocker, a claim that is not a pass), and each caller carries those to its next
review as it always does.

An anchor is computed by code, from git and the store, never by a model, and each unit kind has one
owner that names it and computes its anchor. A record that keeps no anchors is read as no prior:
the review it feeds is whole, which costs one review and needs no migration.

| Review | Units, each anchored to | Owner | The prior it reads |
|---|---|---|---|
| a leaf's review | `criterion:<n>`: its text and the head · `file:<path>`: its blob at the head · `approved-case:<file>#<id>`: the head | `reviewUnits` in `lib/boundaries/leaf-review.mjs` | the review record before it in the execution: its `rulings` ([Executors and review](#executors-and-review)) |
| a folder's integration review | `decision:<id>`: its text and the merges beneath the folder carrying an entry that realises it · `file:<path>`: its blob at the head (`fileUnits` in `lib/review-delta.mjs`) · `spec`: the spec's text hash · `claim:<n>`: the head under review | `integrationUnits` and `priorRulings` in `lib/boundaries/integration.mjs` | the folder's last `claims` event with `review: done`: its `anchors`, and its passing claims at its `head_sha` ([Executors and review](#executors-and-review)) |
| a probe's narrowed round — a spec's review, and a plan's, which `planFolder` runs as one | `<axis>@<section>`: its section's text | `sectionUnits` in `lib/evidence.mjs` | the `since` round's kept rulings beside its snapshot (`<hash>.rulings.json`, [Probe](#probe)) |

**Why:** a ruling stands until what it judged moves. Narrowing grew in each review on its own terms,
each with its own fallbacks to a whole review; one delta over anchored rulings narrows every review
the same way, and a fallback is no longer a separate path but the empty prior.

### Executors and review

- **Producers** are a leaf's sessions: implementer and test-author (an auditor judges). Each is
  handed its brief as its prompt, writes a focused commit series its role may write (no amends, no
  rebases, [Role rules](#role-rules)) or, shell-less, the files the program commits for it, and
  returns its status: `done`, `done_with_concerns`, `blocked`, `needs_context`, `needs_tests`, or a
  [replanning](#replanning) return, with what it established, tried and needs in the same return.
  leaf-close reads that return: on done it journals the series as `series-done` from git, after
  committing a shell-less author's files. A producer's return without a string `status` holds the
  leaf on a `role` fault; an auditor judges and returns no status, so any return of its reads as
  `done`, a `status` in it ignored.
  `needs_tests` is a green implementer's: what is left can only be fixed by a test, which its role
  may not write. It is no stop and no fix without commits (it may carry commits or none): leaf-close writes
  the round's close record with `status: needs_tests`, and the request goes to the cycle's test
  session as a `needs_tests` message with the test findings, the failures and the implementer's
  account of what is unpinned ([Conversations](#conversations)); once the tests it adds are
  measured, the implementer's session is resumed with `tests_ready`. The request stays open until a
  test round of the green is measured and goes to review, to approval or back to the implementer:
  that round records `tests_ready` with the test files the cycle's test session committed since the
  request, whatever the round itself carried (the failures of an earlier test round, say). From any
  other leaf it escalates, as `blocked` does: a plain implementer leaf owns its tests, and a
  test-author or an auditor never returns it.
- **Verification failures** send a fix round its failures as a `failures` message (`source:
  verification`), to the producer's session — on a green or an audit, to the session the records
  name ([Rigor](#rigor)). A round that returns no commits is measured like any other: the branch
  as it stands is the leaf's progress, whoever made it and whatever the round was told. Every such
  send-back goes through the loop guard ([L2](#l2--states-end-work-counts-dont)): failures at a
  head the leaf was already sent back at escalate `fix_without_commits`, the measured failures in
  the detail — the producer was asked to fix what it found nothing to change in; a round that
  opened over commits made by hand, after a retry or a revision, was sent nothing at its head. The
  same failures as the last verification send-back, at a moved head, escalate
  `verify_not_converging`: a failure is its check, its claim and what its evidence names failed —
  each compiler diagnostic as `file:code`, its line dropped, as often as it is named, and each
  failing test — so an edit that only moved a diagnostic is no progress, and one of three gone is.
  Failures an earlier send-back held, but not the last, stop nothing: that state is lossy, and the
  send-back asks the leaf's convergence ruler before its round opens. Surviving mutations an audit sends its cycle's tests escalate `verify_not_converging` when the
  same survivors were sent before. lib/verdict.mjs escalates what no commit of
  the leaf can move — on a `tdd` or `red` leaf, discriminator failures that are each a file of class
  adds passing at base and now ([What a verdict is computed from](#what-a-verdict-is-computed-from)):
  a test over behaviour that already holds (`discriminator_undecidable`); a tdd leaf's producer is
  first sent such files back once (`discriminator_sent_back`, a fix round telling it the test passes
  at base and must fail without its change; every file a discriminator send-back named since the
  leaf was cleared counts as sent) — and any environment error by its kind. Such a file may be ruled
  a regression net over behaviour that held at base (`net`, [Session calls](#session-calls)): by the
  session when the file only pins that behaviour ([Skills](#skills), who settles a stop), else by the
  user. A net is keyed by the file's blob in the measurement it was ruled over (`netsOf`), so it
  stands at every head of the leaf where the file holds that content — a rebase for a conflict
  elsewhere, a fix round that left the file alone — and at none where it changed; there the file is
  of class net. A leaf whose nets leave no file of class adds or static-pin in its approved
  measurement (`approvedNets`) is reported `undiscriminated` in the result and named to its folder's
  integration review.
- **Review** is a fresh reviewer each round (`reviewer:<leaf>:<n>`, `n` counting this execution's
  reviews of the leaf), handed its producer's leaf brief, the span, the producer's return (its
  concerns first), the units it must rule — each criterion (`criterion:<n>`), each changed file
  (`file:<path>`), each approved case that fails at the head (`approved-case:<file>#<id>`) — those
  whose rulings stand, named apart, and what the prior round left open; it returns its rulings, and
  `leaf-review` computes the exit (`reviewExit` in `lib/verdict.mjs`), never judged:
  - The units are ruled over the review before's (`reviewDelta`, [Review delta](#review-delta)):
    `reviewUnits` in `lib/boundaries/leaf-review.mjs` anchors a criterion to its text and the head,
    a changed file to its blob there, a failing approved case to the head; the review record keeps
    the `rulings` that stand after it — each that stood and each unit the reviewer ruled examined —
    and the next review of the leaf in the execution reads them. Round 1 reviews the whole series;
    a later round reads the span since the head the review before judged, its criteria ruled again
    over the moved head, its files only where their blobs moved; a fresh reviewer at the same head,
    after one left units unruled, reads the round's span and rules only those units, every other
    ruling standing. The merged change is reviewed whole at the folder's first integration review.
  - The blocking set is the round's criticals, plus its majors when the leaf is a yardstick —
    a `red`, an `audit`, or one that `provides` a contract (`isYardstick` in `lib/tree.mjs`) —
    and the finding carries a non-empty `failure_scenario`. A red's tests are what its green is
    coded against: a test that forbids a correct green, approved as advisory, makes the right
    implementation impossible and the wrong one the only one that passes.
  - The open set is the round's blocking findings, plus every prior blocker ruled
    `not_fixed`/`regressed` in `fix_rulings` — or not ruled on at all — that the round did not
    re-report, plus every unit the round left unruled. Never narrow this to the round's criticals
    alone. A unit the reviewer left unruled (`unit:<u>`) is the reviewer's miss: it stays open for
    the next fresh reviewer, at the same producer round, and never goes to a producer, so an open
    set of those alone sends no message and goes straight to a fresh reviewer. One policy holds for
    every judge's misses, a reviewer's and a contention or conflict ruler's alike (`missedAgain` in
    `lib/verdict.mjs`): a unit an earlier reviewer of the same producer round, since the leaf was
    cleared, left unruled too escalates `review_incomplete`; every review record counts, past a
    reviewer dispatch that faulted and left none. A question has finitely many units, so
    the fresh judges end on a state: each rules a unit no judge ruled before, or misses one a judge
    already missed. A retry of that stop clears the leaf, so the next reviewer is fresh and no
    earlier reviewer's miss counts against it; when the stopping review left only such misses open,
    the retry goes on with that fresh reviewer at the same round, never to a producer round with
    nothing to fix.
  - Each finding names its `remedy`: `code` (the default), `tests`, or `retire` — a test that
    should go or merge into another, whatever severity the reviewer gave it never blocking here or
    at integration (`retires` in `lib/verdict.mjs`). The review record keeps a round's `retire`
    findings, and a cycle's consolidation round is handed them ([Rigor](#rigor)); elsewhere they
    stand in the result. On a green, whose rounds go
    to an implementer or a test-author, a prior blocker whose remedy was not the reviewed round's
    producer's was **carried** past that round: it stays open, and counts toward neither
    escalation rule nor a raise, because nobody who could fix it was asked to.
  - The leaf is approved when the open set is empty — a count the boundary computes — unless it is
    a cycle's last member that owes its consolidation round: then that round opens, and its close
    approves ([Rigor](#rigor)). No convergence ruling is asked over that exit.
  - It escalates when a fix round returns no commits or a blocked status, or when the same finding
    is ruled `not_fixed`/`regressed` in two consecutive rounds (`review_not_converging`).
  - Whether a loop that keeps minting new findings converges is a ruling, on the leaf's whole loop
    rather than its review alone. Before a round that answers a send-back opens, when `rulingDue`
    (`lib/programs/converge.mjs`) picks the leaf's loop — every round sent back since the leaf was
    cleared, by a guarded send-back or a review's `findings` (`producerLoop` in
    `lib/boundaries/loop-guard.mjs`): after every third, and at once when a send-back repeated a
    lossy state of an earlier one — a fresh ruler on `ruler:converge:<leaf>:<n>`, `n` the round the
    last send-back answered, rules it from the loop handed inline (`convergenceBrief` in
    `lib/briefs/execute.mjs`). `not_converging` escalates `not_converging`, `said` the ruler's
    dispatch; `converging` lets the round open, and stands for the same loop in a later execution.
    A relaunch replays a returned ruling and resumes one cut off. A retry ends the stopped loop: the next round opens through leaf-open with the `retried` message, the stopping review's
    open findings wait for it as `findings`, and the stopping review and ruling are never replayed —
    unless the session committed by hand on the branch first: the round is closed again over those
    commits and a fresh reviewer reviews them ([Resume and checkpoints](#resume-and-checkpoints)).
  - Otherwise a fix round, the open findings delivered to the producer's session as a `findings`
    message, re-verification, and a fresh reviewer. A producer that holds a finding wrong says so in
    its `concerns`, which the next fresh reviewer reads beside the code. No round counter ends the
    loop. On a green the round's producer follows the open findings' remedies ([Rigor](#rigor)); an
    implementer's brief lists the `tests` findings of a mixed set apart, as carried to the cycle's
    test session.
- **The code severity ladder** is the verbatim block `severity-ladder` (in `roles/reviewer.md` and
  below): critical must not merge; major is real but mergeable and blocks only on a yardstick leaf,
  only with a failure scenario; minor never blocks. A fix ruling on a prior blocker is `fixed`,
  `not_fixed` or `regressed`.

<!-- agentics:verbatim severity-ladder -->
- **critical** — must not merge: violates or fails an acceptance criterion; introduces
  incorrect behavior; security or data-loss risk; a new test that does not discriminate
  (would pass without the change); a test that a correct implementation of the criteria
  would fail (an exact key set on an object the change may extend, a shape the change's own
  rule contradicts, a derivable fact written as a literal); behavior change inside a commit
  presented as a refactor.
- **major** — real but mergeable: a genuine defect or hazard that does not fail an
  acceptance criterion (unhandled edge case beyond the spec, misleading name, duplicated
  logic, a change in the series' net diff the leaf's intent and criteria do not call for). Reported in the result for the human gate; never loops — except on a leaf whose
  output is a yardstick (a red, an audit, or one that provides a contract), whose majors
  are held open and block exactly as criticals do: a flaw in a yardstick propagates into
  everything measured against it.
- **minor** — style, or a test to retire (remedy `retire`). Reported once; never blocks, never
  loops.
- Severity is assigned by consequence, never by conviction. A critical or major names the
  concrete input, state, or consumer that goes wrong, in `failure_scenario`; a major that
  cannot name one is a minor wearing the wrong label, and on a yardstick leaf that
  mislabel costs a full fix-verify-review round. A finding whose only remedy is rewriting
  an already-landed commit is advisory by definition — the series is append-only. Finding
  nothing new is a real, reportable answer; a severity is never raised to make a round
  look thorough.
<!-- /agentics:verbatim -->

- **Integration review** runs per folder once every child has merged and no plan of the folder or
  an ancestor runs or is due, waiting for a slot or not (`reviewsToLaunch` in `lib/schedule.mjs`): a plan may add
  the very work the spec's claims describe, and a review over the graph before it rules those
  claims `under`. It is a fresh reviewer on
  `integration:<folder>:<n>` (`n` counting the folder's recorded reviews in the execution) over
  the merged diff of its children, against its decision list, the criteria of every child reviewed
  there, and the folder's spec as its yardstick. Its units are each decision the folder defines
  (`decision:<id>`), each changed file (`file:<path>`) and `spec`, the claims the spec makes. No criterion is a unit: one with a check
  was measured by the suite gate at the head under review, and the reviewer is handed its result
  ([The suite gate](#the-suite-gate)); a `HUMAN:` one is the user's. A leaf adopted on the user's
  word ([Outside work](#outside-work)) is a child with no review loop of its own whatever its
  rigor, and its criteria are measured the same way. The review is earned at the root
  whenever something merged there (the landing view reads its rulings), and below the root when a
  child had no review loop of its own or two or more children with work meet there; a leaf adopted
  at any rigor, or an `outside` event on the folder, earns it too, since nothing else would ever
  judge that work. Otherwise it is skipped, and the suite gate that found it unearned records so.
  The brief carries what a person did as its own section, "Work agentics did not produce": each
  adopted leaf with its commits, and the commits that belong to no leaf; and "Leaves with no
  discriminating test": each leaf `undiscriminated` names (`lib/verdict.mjs`), its nets and their
  whys, for the reviewer to judge whether its criterion checks pin the change. It carries "The specs
  of its sub-efforts", each child with a spec of its own in a fence (`childSpecs` in
  `lib/programs/execute/integrate.mjs`), the yardstick for what the folder's entry for it claims;
  and "Entries that run after this folder" (`laterEntries`): every unmerged entry outside the folder
  that waits on it, topmost first, with the decisions it realises. A claim one of them realises is
  not the folder's to have met: the reviewer leaves it out of its claims and names it in its notes.
  Besides findings it returns a
  **claim ruling** for each
  claim the spec makes (a success criterion, a Design statement, a plan criterion): `met`,
  `equivalent`, `under`, `over`, `deviates`, `spec_defect` or `cant_tell`, recorded by `folder-review` as a `claims` event
  at the head it judged (`review: done`; a skipped review records `review: not_earned` and no
  rulings, and one that returned nothing is a plugin fault on the folder and a lost check). Routing
  (`integrationPark`) is by class, first match: any `spec_defect` parks the folder `spec_defect` on
  its spec (a re-spec); any critical, or any `under`, `over` or `deviates` whose `failure_scenario`
  names the input, state or consumer that goes wrong (`harmfulDrift`), parks it
  `integration_critical` (the user routes the fix). A drift that names no failure, and a `cant_tell`,
  park nothing: they stand in the `claims` event, never as a pass, and the land check lists every one
  under `unsettled_claims` (`unsettledClaims` in `lib/tree.mjs`) for the user to judge before they
  land; until then the folder's review row is pending on them, the todo header reads `NEEDS_INPUT`
  (`todosOf` in `lib/status.mjs`) and the Next line names their count. A claim is held to the same consequence rule as a finding: a difference that breaks nothing
  is the user's to read once, not a fix round, a re-review and another question. A drift with no
  behaviour behind it that still parks is the orchestrating session's call:
  `accept` ([Session calls](#session-calls)) records its acceptance of the `under`, `over` and
  `deviates` claims it names, each with a reason, and the folder integrates unless something else
  still parks it. `equivalent` passes like `met`: the work does the claimed thing with the
  same observable behaviour, only a name, a signature's shape or an internal structure differing,
  and nothing outside the folder relies on the difference.

  **After its first review, a folder is reviewed only where it moved** ([Review delta](#review-delta)).
  `reviewUnit` computes its units with their anchors (`integrationUnits` in
  `lib/boundaries/integration.mjs`, the owner of these unit kinds): `decision:<id>` for each decision
  the folder defines, anchored to its text and the merges beneath the folder that carry an entry
  realising it; `file:<path>` for each file the span changed, anchored to its blob at the head;
  `spec`, the claims the spec makes, anchored to the spec's text hash; and `claim:<n>` for each claim
  of the folder's last finished review, anchored to the head under review. The prior is that review's
  `claims` event (`priorRulings`): each unit it anchored, and each claim it ruled `met`, `equivalent`
  or `accepted` at the head it judged. A claim ruled otherwise is open and ruled again by every
  review, as is each unit the reviewer left unexamined. A review that kept no anchors leaves the next
  review whole: no claim carried, no blocker carried. One brief serves every review
  (`integrationBrief`): the folder's span; what merged since the head the last review judged, when it
  moved; the leaves no test discriminates whose nets are among the files to rule, and the existing
  tests rewritten among them; the spec's edit since the text the `spec` ruling was made on (the kept
  copy of that hash, diffed by `keptSpecDiff` in `lib/spec.mjs`, the diff `respec` shows), when one is
  kept; the last review's claims numbered `claim:<n>`; the blockers it left open, each to be ruled in
  `fix_rulings`; every answer the user recorded on the folder, the latest per question, as settled;
  the units to rule, and those whose rulings stand, named apart; and the spec whole. Ruling `spec`
  means giving every claim the spec makes on a first review, every claim the changed lines make or
  alter over a kept edit, and otherwise every claim the spec makes that no claim of the last review
  states. The reviewer returns the claims it ruled; `folderReview` records them with each prior
  claim the return did not restate (a returned claim restates `claim:<n>` by naming it in `unit`, or
  by its very text; a unit ruled in `units` alone restates nothing): one ruled other than a pass
  carried as it was, so that it still parks; a pass that stands carried as it was, and one whose unit
  the review ruled (the head moved under it) as `cant_tell`, never a pass. It anchors each unit
  other than a claim that stood or that the return ruled examined. Every review records the criticals
  it leaves `open`: its own, and each prior one it did not rule `fixed`, dropped only as the same
  critical reported again (`openBlockers`), which parks as its own do. Work agentics did not produce
  needs no whole review: its files' blobs moved, so they are ruled, and the brief names it.

  **Why:** a fix round moves a few files, yet a whole review re-rules every file and every claim
  of the folder, buys a fresh batch of nits, and parks the folder again on what the user just
  settled. A ruling stands until what it judged moves; the user's answers reach the reviewer, so it
  does not dispute what they chose. A drift with no behaviour behind it is the orchestrator's call,
  recorded with its reason (`accept`); doubt still buys a review, a narrowed one.
- **Establishing commands** is judgment: when no build or test command is established, leaf-close
  hands back `command_unknown`, and an investigator establishes them once for the execution — one
  call on thread `investigator`, in a throwaway worktree detached at the envelope's base, shared by
  every leaf that asks while it runs — returning them as `command` gotchas, which the program
  records as the investigator's (`recordCommands`). A close that still finds none once an
  investigator of this execution has returned escalates `command_unknown`; one in flight or failed
  has established nothing.

### Model tier

The node's author sets `dispatch` per stage, because it holds the context. Defaults: **producers**
(implementer, test-author) run the cheaper model, with effort scaled to the leaf's difficulty;
**gates** (reviewer, auditor, planner, analyst, ruler: `GATES` in `lib/roles.mjs`, which `tierFor`
reads) run the stronger model at moderate effort. A leaf whose
output is a yardstick — `red`, `audit`, or one that `provides` a contract — runs its producer on the
stronger model too. A fix round that failed to clear its blockers raises the producer one step, and
that step may exceed the user's ceiling. The user's intelligence dial is otherwise a ceiling,
derived from the session's model unless the user moves it (`low` → sonnet gates, `normal` and `max`
→ opus, `max` one effort step deeper). A gate's effort follows the model it resolves to: opus at
medium (high at `max`), sonnet one step above its call site's base, or above its role's own effort
when the call site gives none; any other role runs at its call site's base, else at its role's own
effort. A raised round is a fresh session one step up (`raiseTier` in `lib/roles.mjs`: haiku to
sonnet, sonnet to opus at medium, else one effort step deeper; [Conversations](#conversations)); a
resumed session keeps its thread's tier. A producer's tier is `producerTier` (the author's
`dispatch.producer`, else the stronger model for a yardstick, else its role's own, under the
dial), a reviewer's `reviewerTier` (the author's `dispatch.reviewer`, else `tierFor`). An
execution tiers every unit from its envelope's dial, set when the execution starts: a relaunch's
`--intelligence` does not change it, and another dial is another execution.

A program run's dial is set once, at entry: `lib/run.mjs` passes the program's `intelligence` arg
(`normal` when it declares none) to `programContext` as `ctx.intelligence`, and a nested program
gets its own through `scoped(ctx, prefix, {intelligence})`; a program called in-process with an
`intelligence` arg takes it at entry (`dialed` in `lib/programs/common.mjs`), and nothing reads the
arg past entry. Every dispatch and every search reads `ctx.intelligence`; a node's own tier and a
call's explicit tier win. The probe takes an `intelligence` arg; the probe and solutions carry the
dial to their searches and rulers, and an execution folder's survey and probe run at the folder's
dial.

### Landing and drift

An execution delivers into its root's parent integration branch, and ultimately the effort branch,
without asking; the user's tree is not involved.

After each merge-batch, the landed diff is intersected with the `consumes` path prefixes of every
pending designed node. Merge-batch writes the ruler one brief
(`merges/<key>-<identity>.drift.md`): per consumer, the node as its executor will be briefed (intent,
context, criteria, what it writes, reads and consumes) and the merged change to the files it
consumes. One ruler, handed it as its prompt, rules each consumer `unaffected` or `affected`, with
the one question its owner must answer; either ruling is a `drift-ruled` state line. A consumer is
not launched while it is being ruled on or replanned.

**A ruling of unaffected stands for the change it ruled on.** The same change reaches a consumer
again at every merge that carries it up the tree, so a ruling that did not stand would be asked
again at each one, and the user's answer put to the ruler as if it had never been given. The
standing ruling on a consumer's contract (`standingRulings` in `lib/boundaries/integration.mjs`, over
the state lines of every execution of the effort) is the latest of: a ruler's `drift-ruled` line
ruling it unaffected, at the head it ruled; and the user's ruling, a `contract_drift` park on an
affected ruling that the session cleared with `retry` (which, on that park, means the user ruled it
unaffected), at that ruling's head. A later affected ruling nobody cleared takes its place. Before
a batch writes its ruler's brief, each drift item under a standing ruling is compared in git: when
its files read at the merged head as they did at the ruled head, it is `standing` (the ruling's
seq, head and author on the drift record), no ruler is asked, and the execute program notes it;
when they changed, the ruler is asked, handed the earlier ruling — its head, the ruler's why, the
park's question and the answers the user recorded on the node between the park and the retry — and
only the change to those files since the ruled head. A head git cannot compare counts as changed.

The same holds for a base branch that moved under a resumed execution. Preflight measures each
unmerged, unstopped leaf from its own **anchor**: the base head the execution's branch already
holds (the merge-base of the base branch with the root's integration branch, or with the nearest
one above it while the root's is not cut yet; never older than the envelope's base), or the head
the leaf was last ruled against when that is newer. A base head merged into the execution's branch
is the ground its leaves are cut from, not a move under them, and a leaf ruled against one head is
asked only about what moved after it. For the leaves whose files moved since their anchor,
preflight writes the same kind of brief to `stale-<head>.md` beside the state log, each leaf with
its own diff, and its record (`stale-<head>.json {now, nodes}`); one ruler rules them before
anything runs. Every ruling is a `stale-ruled` state line naming that base head, with the ruler's
`why`; an affected one anchors the leaf only once something answered it on disk (a revision of the
leaf, or a stop or a replan on it after the ruling), so a replan a plugin fault ended is ruled on
again by the next run. A ruler is one dispatch, and its failure ends the ruling: a leaf no ruling
reached is held on a `role` fault and ruled on by the next run; a leaf already stopped is left out
until its stop clears. No checkpoint stops the run for it.

Work adopted on the user's word ([Outside work](#outside-work)) is drift too: a leaf adopted by
`done` landed files, and `outside` commits touched some, that a node not yet merged may consume.
Each adopted record — a `merged` event with `by`, an `outside` event — is covered once a
`drift-ruled` line carrying its `adopted_seq` stands in the state log of any execution of the
effort, so it is ruled once, not once per execution. When preflight stops at no checkpoint, it
intersects the files of every uncovered record with the `consumes` prefixes of the nodes not yet
merged and not stopped, and writes the ruler one brief, `merges/adopted-<seq>.drift.md` (`<seq>` the
newest record's) with its record beside it, each consumer with the diff of the records that touch
it. The ruler is one dispatch on `ruler:adopted:<newest seq>`, run before anything else; each ruling
is a `drift-ruled` line with its record's `adopted_seq`, and an affected consumer is handled as
above. A record whose files touch no consumer writes no line and is looked at again at the next
launch, at no cost. A consumer no ruling reached is held on a `role` fault and ruled on again by
the next run, where merge-batch drift would park it, because adopted drift is found again at every
launch and a held consumer loses nothing. A commit git cannot read leaves the records uncovered and
the ruler undispatched; the run notes it.

**An unaffected node runs on, and the user never hears of it. An affected one goes to the planner
first**, with the ruler's question as the reason, exactly as an executor's `premise_mismatch` does
([Replanning](#replanning)): a leaf under a folder the planner wrote is a request to that
folder's planner, and a folder the planner wrote is rewritten; a leaf under a folder the user wrote
parks `needs_respec` with the ruler's question, and a folder the user wrote parks `needs_respec`.
The user is reached only by what the planner cannot settle (its own `needs_decision`,
`contract_changed` or `premise_mismatch`), and a replan that leaves the leaf as it was escalates
`replan_not_converging`. A node with work already standing on its plan (a leaf approved and
waiting to merge, a folder with children dispatched or merged; or a unit of this run running on it
or under it) is never replanned under that work: it parks with the ruler's question,
`premise_mismatch` for a moved base and `contract_drift` for drift. Two more cases park
`contract_drift`: a consumer no ruling reached, at once, and one whose replan a plugin fault
ended, because drift is found only on the batch that landed it and a held consumer would lose it.
Everything else keeps running. Undesigned nodes are reported as unexamined.

**Why the brief is written by the lib:** the ruler has no search tools, and a ruling made without
the entry is a guess that lands on the user. The node record is what the executor will be handed,
so it is the premise itself, and it is always on disk.

**Why a ruler, then the planner:** hash drift says a premise may have moved, not that it did. Most
drift touches what a consumer does not rely on, and putting every hit to the user makes the user
the filter for noise; a reader that did not write either side rules first. A premise that did move
is a planning fault before it is a decision: the planner can re-derive a task on the new ground
without touching a decision or a contract, and only a change to one of those is the user's.

**Landing is the one ask.** When the effort is complete, or the user says to land what exists, the
session runs `lib/boundary.mjs land --action check`: how the user's branch drifted since the
effort branch was cut, open escalations and parked nodes, every `HUMAN:` criterion verbatim, the
root's claim rulings (`root_claims`) and the **landing view** (`landing`, from
`lib/render.mjs renderLanding`: the root spec's success criteria beside those rulings, what did
not hold first, a `cant_tell` counted apart from `met`, then what the review said of the evidence
behind each verdict, read from its stored return, and, at its end when the effort holds any, a
section "Work agentics did not build": each adopted leaf with who adopted it, its commits and the
folder review's ruling on each of its criteria, or "not yet judged", then the commits that belong
to no leaf) and the act's `token`. The session shows it,
asks with that token, and
runs `--action merge`, which runs the check again, confirms the user's word for its token
([The user's word](#the-users-word)), merges the effort head that check read into the user's
checked-out branch and appends `landed {into, merged_sha, by}`. It refuses over an open escalation,
a parked node or a dirty tree; nothing changed under `.claude/` or `.agentics/`, tracked or
untracked, is dirt. An effort head the user's branch already holds is not merged again: when the
effort has no `landed` record — a landing killed before it, a merge made by hand — the call records
`landed` with that `HEAD` and its own `by`, and one landed before keeps its record. The same call
then sweeps: every branch of the effort that the landed head holds, and the clean worktree still
on it — composites' integration worktrees; a leaf's went with its merge — is removed, with `git
branch -d` and never `-D`, after a `git worktree prune`. It sweeps from the checkout that took the
merge because that is the one call that holds it: "merged" is read against that checkout's `HEAD`,
and a sweep run elsewhere would read it against a head that never took the merge. What it keeps — a
branch git does not see merged, a dirty worktree, one git would not remove — it names with why. A
`merge` run again over a landed effort merges nothing and sweeps again, so a sweep a locked file
stopped is finished by asking twice; with the effort branch gone, the token it asks with is `land
<effort>@`.

An effort whose work the user's branch already holds — merged by hand, its effort branch gone — is
closed by `land --action record --head <sha>`, the merged head the user names. It moves no branch,
so it asks no token: it refuses unless the user's checked-out branch holds that head and the effort
branch, where one still stands (`not_in_branch`, `effort_branch_ahead`, `no_such_commit`), records
`landed {into, merged_sha: <head>, by: session}` once, lists each recorded merge that branch does
not hold (`left_out`) and each node still parked or escalated, closed with the effort (`closed`),
and sweeps as `merge` does. A landed effort is closed: preflight refuses it (`landed`) and
`lib/next.mjs` says nothing is left to do.

---

## Verification

`lib/verify.mjs` runs the mechanical checks of one leaf — the commit series, the build, the
typecheck, the leaf's own tests, the discriminator, the declared mutations and the named checks —
in one process, and of a merged head — the build, the typecheck and the fast or the full suite, as
the caller asks. **Nothing in it decides whether the leaf passed.** It observes, prints exactly the
fields the verdict reads, and journals its own `verify-observed` line inside the process that
measured, so there is no window between the work and the record. An execution runs it as an awaited
child, `node lib/verify.mjs --options -`: the options one JSON object on standard input, the payload
one JSON line on standard output ([Boundaries](#boundaries)).

Which checks run is the leaf's rigor (and, in a cycle, its role):

| rigor / role | series | discriminator | mutations | named checks |
|---|---|---|---|---|
| verify | no | no | no | yes |
| trivial | yes | no | no | when given |
| tests-only | yes | passes-now half read | required (≥ 1 declared) | when given |
| tdd | yes | full: fails at base, passes now; an upkeep file passes now | when declared | when given |
| red | yes | red: fails now, fails at base; an upkeep file passes now | no | — |
| green | yes | the red leaf's tests pass now | no | when given |
| green, a test-author round | yes | the red leaf's tests and the round's new ones pass now; each new test file fails at base (the red's stubs) | when redeclared, each biting; a new test file failing at base needs none | when given |
| audit | no series expected | no | required | — |
| a cycle's consolidation round, on its green or audit | yes; no approved case binds it | no: its tests and the ones it changed pass now | an audit's held ones and any it redeclares; none of its own | a green's |

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
- **A cut-off verify's leftover is told from a round's work by what verify noted, never by what the
  file holds.** A verify killed inside a rewrite leaves one of three things: a file rewritten in
  place (an approved test's text written over the worktree's, a source with a declared mutation
  applied), HEAD detached at the base, or the worktree's uncommitted work kept under
  `refs/worktree/agentics-verify/`. Before it rewrites a file that is as the head has it, verify
  writes the path into `agentics-verify-rewriting` in the worktree's own git directory (a JSON
  array) and takes it off once the file is back. leaf-close runs `undoLeftover` before it commits,
  reverts or measures: it checks the leaf's branch out again where HEAD is detached — naming, in the
  close's notes, the sha HEAD was detached at when the branch does not hold it, so commits made
  there are reachable and never dropped silently — puts each noted file back to the head's text
  (removed where the head has none), and applies the kept work again and deletes its ref. What
  stands after that is the round's, and a close run again commits and measures it as the first run
  did.
- A test that could not be launched at base is `test_unrunnable`; a suite failure that cannot be
  placed against a test file raises `suite_failures_unnamed`.
- **A changed test file either adds a test case or keeps existing ones working, as its producer
  declares.** The producer names each test file of the leaf's diff that adds none in its return's
  `upkeep` ([Producer returns](#producer-returns)) — a call site given a new argument — and
  leaf-close hands verify those files (`upkeep`), with each file an earlier measurement of the leaf
  recorded adding none where the file holds the same blob at the head and the same at the base
  (`upkeepAt` in `lib/verdict.mjs`), so a relaunch that measures a head before any round keeps the
  declaration, and an edit of the file, or a rebase onto a base that changed it (adding no case is
  a fact about the change from base to head), voids it. Every other file of the diff adds one: a missing declaration costs the stricter
  question. The declaration is the producer's about its own work (L3), so it only ever waives a
  proof: verify reads each such file's `git diff -U0` from base to head, and one whose diff adds a
  test-case declaration it does not also remove (`addedTestCases` in `lib/commit-series.mjs`, over
  `TEST_CASE_PATTERNS`), or whose diff does not run, adds one, the refused declaration named in the
  notes. The closed patterns only refuse a waiver (P2): a framework they miss leaves the
  declaration standing, never a case unasked. A file under measurement the
  leaf's diff did not touch (a cycle's test a green's test round left alone) adds none, and a
  caller's named tests on a green each count as adding one. The reading is on each discriminator
  entry (`adds_test`) and in the notes, so the verdict and a resume read it off the journal line.
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
  runs unlocked, so parallel leaves test in parallel. The wait is long, and the caller is the
  program's own child process.
- **A failure that was already there is not the change's.** When the suite or a named check
  fails, each failing test file the change did not touch (nor the cycle's tests) is run at the base
  and its failures named the same way; a failing test whose same `{file, id}` fails there too is
  `baseline_failing`. A check's failures are named only when every one it printed could be placed
  against a test file.
  A new failure in a file that was already failing for another test stays the change's. A fresh
  worktree missing a gitignored asset fails the same way at its base, and no commit of the leaf
  could move it.

### What a verdict is computed from

`lib/verdict.mjs` is the one home of the measurement verdict. `measurementOk(m, leaf)` derives pass
or fail from the observations against the leaf's profile. Every profile needs a completed
measurement, no failed build or typecheck and no blocking series finding. Then each changed test
file under measurement is of one class, and the profile asks of it the facts of its cell in one
table (`DISCRIMINATOR` in `lib/verdict.mjs`): what it does now, and a proof, any one of which shows
it bites — `base`, it failed at base with the tests under measurement restored, or `mutation`, a
biting mutation names it in `expect_failing`.

| profile | adds | upkeep | net | static-pin |
|---|---|---|---|---|
| tdd | passes now; base | passes now | passes now | passes now |
| red | fails now; base | passes now | passes now | as adds |
| tests-only | passes now; mutation | passes now | as adds | as adds |
| green | passes now | as adds | as adds | as adds |
| green, a test-author round | passes now; base or mutation | passes now | as adds | as adds |

A file's class is the first that fits (`classesOf`): a **net**, a file ruled a regression net
([Executors and review](#executors-and-review)); **upkeep**, a file that adds no test case
(`adds_test: false`, as its producer declares, [Verification](#verification)) — existing tests kept working, which pass at base by construction, so no commit
could make one discriminate; **static-pin**, a file that adds a case to a change the typecheck
rejects at base (`static_on_base`: every changed test file passed at base, and the established
typecheck, or a criterion check that runs it, failed there with them restored and passes now — that
check is the leaf's discriminator; a test file that failed at base is never waived, and no static
check is asked over one, so a behaviour change keeps its test-first rule); **adds**, any other. A
class a row leaves out is held as `adds`: a net or a pin buys nothing where it was never asked.

Beside the table, per leaf: a tdd, red or tests-only leaf adds a test case — one whose every
changed test file is upkeep added none, unless the typecheck rejects its change at base (`new-test`);
a tdd leaf with a net and no file of class adds or static-pin left has nothing that discriminates,
so at least one criterion check must have run; a tests-only leaf declares at least one mutation, and
every held one bites; a red leaf's suite fails, only in its own test files; a green leaf's cycle
tests are measured; a green's test-author round's declared mutations bite; an audit's held mutations
all bite over the cycle's tests; a consolidation round's tests run and pass, and every mutation it
redeclared and every one an audit held bites; trivial, verify, tdd, tests-only and green need their
named checks and their own tests not to have failed. The profile is the leaf's rigor and role
and, on a green, the measured round's producer (`profileOf(leaf, producer)`; a consolidation
round's is `consolidation`, `CONSOLIDATION` in `lib/verdict.mjs`): leaf-close passes it
and the `verify-observed` line records it, so a resume judges a measurement as its close did. A
named check fails for the change when it did not pass, unless it failed naming tests every one of
which fails at its base too (`checkFailed`). A suite failed for the change only when one of its
named failing tests is the change's own: `baseline_failing` lists the failing tests, in files the
change did not touch, whose same test fails at its base too, and `suiteFailed`/`ownFailing` leave
them out, at a leaf and on an integration head alike (whose base is the head before the batch). A
failure that names no test is never excused. `closeDecision` turns that into the next step:
`review`, `approve`, `fix`, `escalate`, `command_unknown`, or — for a `verify` leaf — `finding`. The
same functions re-derive the verdict on resume, which is what makes a journal written by the
measuring process safe.

---

## Resume and checkpoints

Resume (`lib/resume.mjs`) computes, on disk, one next action per leaf — `none`, `merge`, `review`,
`verify`, `continue-series`, `code` — adopting a stage only where the record and git agree:

| What the record and git agree on | next action |
|---|---|
| a `merged` event, or the leaf head is in the parent's integration branch and a witness agrees (the approved head, or a `merge-observed` line) | `none` |
| approved, and the branch is still at the approved head | `merge` |
| a green `verify-observed` at the branch head | `review` for a leaf with its own review loop, else `merge` |
| work to measure first: when the leaf's latest round in any execution is this execution's, the branch's own line, merges aside, above its base when that round's close stopped the leaf, or above the head the close left when it went to a review loop whose stop a retry cleared (`measureFirst`) | `verify` |
| the branch tip is a checkpoint commit | `continue-series` |
| commits and a `series-done` at the tip | `verify` |
| commits without | `continue-series` |
| nothing on the branch | `code` |

A salvaged series is closed and reviewed at the round that produced it, over its own fork point
and brief; a merge merges the head the approval named, never the branch as it stands. A checkpoint
commit (the executor's mark on an unfinished series) means continue, never measure, but for the
work of a stopped round, which a retry measures first (below).

**A stopped leaf's work is measured before any producer goes on.** A retry clears a stop once its
cause is dealt with: the criteria were corrected, the environment fixed, a decision made, or the
session committed on the branch itself (the develop skill has it leave a note when it does). The
work on the branch is then the leaf's progress as it stands, whoever made it and whether or not any
close measured it, and a measurement taken before the retry is never reused (`measure`). So the
next step is a measurement, never a producer asked to redo or certify work that may already pass.
One reader, `measureFirst` in `lib/resume.mjs`, finds that work for the ladder and the leaf unit
alike: the leaf's latest round in any execution must be this execution's, since the unit closes
again only a round of its own. When that round's close stopped the leaf, the work is the branch's
own line above its base; a branch with nothing on it but a refresh merge from the parent holds
none, and its leaf goes to a producer round. When the close went to a review loop whose stop a
retry cleared, the work is the commits made by hand above the head that close left (a loop with
none goes on as [Executors and review](#executors-and-review) says). A close that sent a fix round
its messages is left as it is, so no second `failures` lands beside an undelivered first. The unit
then closes that round again with no return to read (leaf-close with no `dispatch`): the branch is
measured as it stands, as no producer's work, and the decision goes where the round's would —
approved; reviewed by a fresh reviewer, handed no producer's account, whose span starts at the head
the last review judged, or at the base; or a fix round sent the `failures` (beside the `retried`
message), routed by the close record's own role and status, which leaf-open's next round reads
too; a producer that returns those failures' head unmoved escalates `fix_without_commits` (the loop guard). The
re-close's record replaces the round's, so a relaunch finds the head it left and goes on from its
decision; a review loop stopped at another head than the round's close now stands at is over, so
its findings wait for no producer, and a reviewer that judged such a head is not resumed. Where
work reaches a producer round all the same — after a round of another execution, or a close that
sent a fix round — that round may add nothing to it and is measured like any other ([Executors and review](#executors-and-review)).

A clean execution (no records for its leaves and no leaf branches) opens for the cost of one branch
listing. Committed work is salvaged by right and reported as salvaged. A dispatch recorded
`dispatched` and never `returned` is resumed in its own session, which holds its turns so far and
finds its uncommitted edits where it left them; uncommitted work no resumable session owns is
reported and adopted by nobody. Escalations carry forward until `retry` clears them. What a
close reads of the rounds before it spans executions: the close record of the round before (found
by the `execution` its dispatch names), the journals for the mutations held and the audit's gap,
and the state for the breaches reverted. A resume
adopts its envelope (base, dial, pace, commands) from `execution.json`: a relaunch's
`--intelligence`, `--pace`, `--base-ref` and `--commands-file` shape a new execution only, so
another dial is another execution.

A checkpoint dispatches nothing new and says how to proceed. What it found — the overlapping
executions, the gaps, the branches with their unaccounted commits — is on its state line, and
`lib/status.mjs checkpoint --effort <e> --execution <stamp>` prints it. A relaunch with
`confirmed` set to a checkpoint line's `seq`, in this execution or an earlier one of the effort (a
checkpoint ends its execution, so the relaunch that confirms it is a new one), records
`checkpoint-confirmed` with that line's reason and what it found (the gaps of a `blocking_gaps`, the
executions of an `existing_execution`). A confirmation stands, in every later run and execution of
the effort, for a checkpoint of the same reason over the same gaps or executions; once what preflight
finds changes, the checkpoint is raised again. A run that stops again for a reason it already wrote
a line for reuses that line's `seq`:

| checkpoint | meaning | to proceed |
|---|---|---|
| `integration_lost` | an integration branch in scope is gone, or no longer holds its latest recorded merge; checked first, raised on every launch, never confirmed past | restore the branch and relaunch, or, when the user's branch holds the work, record its landing ([Outside work](#outside-work)) |
| `outside_work` | an integration branch in scope holds commits no record accounts for; checked before every other checkpoint, raised on every launch, never confirmed past | adopt them (`lib/boundary.mjs adopt`, [Outside work](#outside-work)) and relaunch |
| `existing_execution` | an open execution's root is an ancestor or descendant of this one | resume it; or relaunch with `confirmed` set to the checkpoint's `seq` |
| `blocking_gaps` | untraced decisions, or evidence the node depends on was not reached | relaunch with `confirmed` set to the checkpoint's `seq` |
| `parked` | the caller launched with `plan_only`; raised on every such launch, never confirmed past | launch without `plan_only` |

---

## Progress

The user follows work through the todo list of the session that launched it. The session writes it
from the records (`lib/status.mjs todos`) when it launches a program, on every line its watch
prints, and when the program ends.

- **One todo per node**, subject `<node-id> — <title>`; composites get one too, completed once
  they merge. A composite whose children have all merged gets a second todo, its integration
  review, keyed `<node-id>/@review` (`@review` at the root; `reviewIdOf` in `lib/tree.mjs`) and
  listed after its children: `in review` while the composite is `reviewing`, pending while the
  composite is stopped before its review, completed once a review stands. The composite's own todo
  reads `awaiting review` meanwhile.
- **The stage is the `activeForm`**, derived from the node's status and latest dispatch:
  `implementing`, `writing tests`, `auditing` or `checking` while dispatched, `fix round N` from the
  second round; `awaiting merge` once approved, `held` for a cycle member awaiting its tip;
  `waiting on user` for a parked node; `waiting on host` during a host stop; completed on merge,
  as `merged (adopted)` for a leaf adopted on the user's word; pending with the reason when escalated.
- **The list is a view.** Nothing reads it back as state, it is never hand-edited, and a status
  header (`ONGOING`, `DONE`, `NEEDS_INPUT`) is rendered from derived status for display only.

**Questions are asked while the run goes on.** A park or an escalation stops only its node; the
session watches for them with `lib/status.mjs watch --run <effort>.<stamp>`, which prints one line
per `escalated` or `parked` event of the execution after the `seq` its `--since <seq>` names that is
still its node's open stop (`<id> escalated <reason>`, `<id> parked <return>`). The `seq` is the
effort's, which `lib/status.mjs list` printed before the start, so nothing raised in between goes
unseen; the watch is re-armed with the same `seq` until the run ends, so a line that still stands is
printed again, and it exits on the `ended` of the run it was armed for (one recorded after that
`seq`: an earlier run's end never ends it), or `stopped`. The session asks the user at once and
records the answer: a re-spec's approval and compile clears a park (`replanned`, `answered`), and
`lib/boundary.mjs retry --node <id>` clears an escalation (`replanned`, `retry_escalated`). The
running program reads the records on every tick, so a stop the session cleared is picked up at the
next one; a program that has ended is started again.

**Why:** the user's attention is the scarcest resource in the loop. A question held until the whole
run returns idles the node for the run's length and hands the user a batch at the end; asked at
once, it is answered while other work goes on and the node rejoins the run.

The agentics viewer (vanillafairy's `agentics-viewer/`) draws an effort live from
`lib/status.mjs snapshot`. It reads, and never writes, the effort store.

**Activity inside a dispatch is drawn live, by code.** The runner reads the host's event stream as
it comes and keeps each running dispatch's activity in `live/<dispatch>.json`: its turns so far,
its latest tool call and the time of it. The viewer draws it on the node. It is a view: no status,
resume step, verdict or review reads it, and it is dropped once the dispatch returns.

### The node card

A session started on one node reads one thing first: `lib/status.mjs node --node <id>`, the node's
entry of the snapshot. Beside the status and the stop it carries the card, computed on every read:

- **the next action** a relaunch would take for the leaf, from the resume ladder itself
  (`resumeLeaves`), so the card and the relaunch cannot disagree;
- **the adoption**, for work agentics did not build: the `event` of a leaf adopted on the user's
  word is `{kind: merged, seq, by, commits, into, merged_sha}`, and a folder that carries `outside`
  commits has `{kind: outside, seq, by, commits}` (the newest record's `seq` and `by`, every
  record's commits). A stop's event comes first when a node has both;
- **how far behind** the leaf's branch is of its folder's: a stopped leaf that lacks commits its
  folder has since taken is often stopped by exactly what they fix;
- **the lead of its latest return**, the first paragraph of what the agent that last worked on it
  said (its text, else its notes; headings and code fences passed over), on one line;
- **the notes** earlier sessions left (`lib/boundary.mjs note`): the cause they established, the
  user's ruling, what they did to the branch by hand;
- **the relaunch arguments**: the open execution that holds the node, its root, and, when the
  node escalated itself, that `lib/boundary.mjs retry` clears it first;
- **what changed in the user's checkout** during the node's latest call that recorded a change
  (`checkout_changed`): that dispatch and the paths.

The viewer shows the card and puts it in the prompt it offers for the node.

**Why:** the status was always one read away, but the reason and the next step were spread over
the event log, the journal, the closes, the returns and git, and what a session worked out about a
stop was written nowhere, so the next session worked it out again or relaunched without it. The
card is a rendering, so it cannot go stale; the note is the one part that cannot be computed, so it
is the one part recorded.

### The Next line

`lib/next.mjs` computes the one command to run next for an effort from its specs, the ledger, the
node and event logs and its executions. First match wins:

1. an open execution → `/agentics:develop <folder>`: watch it while its run is live, relaunch it
   when the run is stopped;
2. a parked or escalated node → what it waits on and the spec to edit: `/agentics:design <node>`
   for a `needs_design` park, `/agentics:develop <folder>` otherwise;
3. a spec the user writes that has a `blocking` question or is not approved →
   `/agentics:design <folder>`; one whose latest review of its current text was partial →
   `/agentics:design <folder>`, which resumes its Review stage on the units it left open;
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

## Skills

| skill | entry for |
|---|---|
| `task` | the inline mode |
| `design` | one folder's spec at any depth: the loop from Analyze to Move on |
| `develop` | building a folder or a settled request: the root spec, launch, result walk, re-specs, landing |
| `challenge-idea` | attacking a written artefact (the `probe` program) |
| `investigate` | answering a question from evidence (the `investigate` program) |
| `search-for-existing-solutions-before-building` | service step, hidden (`user-invocable: false`) — the `solutions` program |
| `next` | every effort, where it stands and its computed Next line; hands the pick on |
| `self-improve` | the session driving a run: watches it, tells a plugin cause from a spec or code cause, and has the plugin itself fixed, released and installed before the work goes on; treats spend the work did not earn as a plugin cause too, judged from the spend view ([Self-checks](#self-checks)) and corrected between runs rather than by stopping one; and at the effort's end reads that view, names each outlier's cause and has every dial or prompt behind one corrected |

A service step carries `user-invocable: false`: it is gone from the `/` menu, and the model still
runs it when asked in chat.

**A skill starts no agent.** Every agent a skill needs is a program's: the skill starts the program
and reads its result, so every dispatch is recorded, confined and judged as the laws ask. The one
exception is `self-improve`'s fix agent, which works on this plugin's own repository, outside every
effort and every execution tree, so no program owns it: the session starts it with the host's agent
tool, and the fix it makes lands as a release like any other change to the plugin.
The session writes every text longer than a phrase that a program takes — a question, a capability,
criteria, the drafts' excerpts — to a file outside the repository with its Write tool, so no
snapshot holds it, and passes the path; a phrase (`--notes`, `--context`, `--constraints`) is the
flag's value, or a file under its `-file` twin past one line of 300 characters. It starts each program with `--detach`, keeps the `run` printed, follows it with
`lib/status.mjs watch --run <run> --since 0` on its monitor — develop's watch of an execution with
`--since <seq>`, the effort's `seq` read before the start, because an execution's log spans every
run of it ([Progress](#progress)) — re-armed until the run's end, and reads the result from the
printed `result_file`. A `run_live` refusal names a run already going over the same
scope, which the session watches instead; starting the same command again resumes a stopped run.
An `ended failed` or a `launch_failed` is a plugin fault: the session says so and starts the command
once more, and the same fault again is reported as a plugin defect.

**A stopped node named to develop is a question, not a launch.** Words that name a parked or
escalated node (a pasted Next line, the viewer's prompt) take develop straight to settling that
node; its execution is relaunched only once the stop is settled. A relaunch without it runs
everything else and hands the same stop back at the end.

**Who settles a stop.** The user owns decisions (L4), so a stop that needs one is theirs. A stop
whose cause is mechanical is the session's, which settles it, notes what it ruled on the node and
names it in its report: a transient (`blocked`), a command the work runs that its entry does not
name (`command_not_in_runs`: added to the entry's `runs`, the edit ruled, then retried), a judge's miss
(`review_incomplete`), a suite or verify failure that is only
timeouts or load passing alone (retried once), a changed test file that only pins behaviour held at
base (ruled a `net`), a file a node needs inside its own folder (added to its entry), and code that
breaks behaviour the spec states (a `task` entry in the folder's own spec that fixes it, never a new
sub-effort). None of these chooses anything the spec leaves open; `review_not_converging`,
`not_converging` and every stop that does go to the user. **Why:** a question whose answer the spec or the mechanism already
gives costs the user a decision they have made, and the run a stop it did not need.

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

Each entry names its **owner** (the code that defines the shape) and where it is **restated**; a
change to a field list edits every place named, in the same commit series. Programs import lib, so
code never restates a shape: what restates one is a role's instructions or a skill's text.

Two conventions hold throughout:

- **Digests** are FNV-1a, 32-bit, 8 hex characters, over `canonical()` from `lib/plan-digest.mjs`:
  keys sorted, `undefined` read as `null`.
- **A CLI a session calls** prints one JSON result and exits 0, even when the result reports a
  typed error (`{ok: false, error: {kind}}`, its reason on stderr). `{error}` with exit 1 means
  the program itself failed. Every argument that names a thing goes through `resolveHandle`, which
  refuses a name that resolves to nothing (`unknown_<kind>`) and never reads its absence as an
  empty thing (L1).

### Node record and events

- **Owner:** `normalizeNode`, `nodeProblems`, `treeProblems`, `deriveStatus`, `claimsOf` in
  `lib/tree.mjs`; `EVENT_KINDS` in `lib/ledger.mjs`; `lib/adopt.mjs` (writes the adopted `merged`,
  `outside` and `noted` events); `judgeClose` in `lib/boundaries/judge.mjs` (writes `judged`).
- **Restated in:** `roles/planner.md`; `skills/develop` and `skills/design` (the root and design
  node JSON); `lib/schedule.mjs` (it reads `author`); `todoFor` in `lib/status.mjs`; the
  entry-to-node mapping in `lib/compile.mjs`; `lib/next.mjs` and `lib/render.mjs` (readers).

Fields as in [Nodes](#nodes). Event lines are `{kind, node, execution, seq, ...}`:
`planned {by}` · `replanned {reason, by}` (also `retry_escalated` and `answered`) ·
`dispatched {dispatch, role, round, model, effort, thread, session, brief_digest, brief_parts,
carries[], pid, deny_read[]?}` (the runner's whole record, [The agent runner](#the-agent-runner)) · `approved
{head_sha, review_rounds, at_integration}` ·
`merged {into, merged_sha, head_sha, by?, commits?}` (`by` and `commits` only on a leaf adopted on the
user's word, [Outside work](#outside-work); a `merged` without `by` is agentics' own) ·
`outside {commits, by}` (commits on a folder's integration branch that belong to no leaf, adopted on the
user's word) · `escalated {reason, detail, said?}` · `parked {return,
question, said?}` (`said` is the dispatch whose stored return holds the agent's own words;
`detail` or `question` is a line the lib composed, or empty, and `saidOf` in `lib/store.mjs` reads
either)
(`return` is a replanning return, `needs_design`, `needs_respec`, `integration_critical`,
`spec_defect`, `cant_tell`, `contract_drift` or `design_spend`) ·
`judged {trigger: contention | conflict, head_sha, heads{<leaf>: sha}, facts[{node, kind: overlap | folder, paths[]}], paths[],
outcome: serialize | resolve | replan | cant_rule, after[], why, said}` (the judge's ruling on a unit
at its approved head, [The judge](#the-judge); `contentionOf`, `waitsOn` and `conflictJudged` read it) ·
`landed {into, merged_sha, by}` (`by` who confirmed the word: `user` or `terminal`, or `session` for a landing recorded over work the user's branch already held) · `nets {head_sha,
nets[{file, blob, why}], by}` (the ruling, the session's or the user's, that test files are regression nets, each at
the blob the measurement it was ruled over read, `net` under [Session calls](#session-calls)) · `claims
{head_sha, review: done | not_earned, claims[{claim, ruling, failure_scenario?}], open?[{id, claim,
failure_scenario}], said?, by?, accepted?[{claim, was, why}], anchors?{<unit>: anchor}}` (`open` is every critical a
finished review leaves open, its own and the prior's it did not rule fixed; `anchors` holds, for each unit other than a
claim that holds a ruling after the review, the anchor it was ruled at, a claim's anchor being the event's `head_sha`
([Review delta](#review-delta)); a review that kept none leaves the next one whole) (`ruling` is the reviewer's `met`, `equivalent`, `under`, `over`, `deviates`, `spec_defect` or
`cant_tell`, or `accepted`, the session's on a drift claim, which `by: session` and `accepted` record
with the ruling it had and its reason, carrying the review's `anchors`; `failure_scenario` is kept only on a drift that names one, the one that parks; each
ruling's evidence is in the reviewer's stored return) · `noted {by, text}` (what a session learned about the node; no status
is derived from it) · `message {thread, from, msg, payload, round, guard?}` (a message code delivers to a
thread's session, [Conversations](#conversations); its `execution` is `''` only on one the migration
recorded, and no status is derived from it; a send-back carries `guard {kind, key, at}`, the loop
it belongs to, its state and the head it was sent at, which the loop guard compares the next by,
[L2](#l2--states-end-work-counts-dont)) · `paused
{by}` and `resumed {by}` (node `''`, the session's pause of the execution it names and its end,
`pause` and `resume` under [Session calls](#session-calls); no status is derived from them). A boundary appends an event only while it is not
already the node's word (`freshRecords` in `lib/boundaries/records.mjs`, [Boundaries](#boundaries)); a
`judged` lands once per node, trigger and `said`, and is read only while it is newer than where its
node was cleared, so the ruling a retried node is given again at the same head is recorded and read.

### Snapshot

- **Owner:** `snapshotOf` in `lib/status.mjs`.
- **Restated in:** `agentics-viewer/shared/snapshot.ts` in the vanillafairy repository (a reader).

`node lib/status.mjs snapshot --repo <r> --effort <e> --json` prints the effort’s whole state in
one read-only call — it writes no file, no lock and no `seq`. The payload:
`format` (4; changing a field this entry lists bumps it), `store` (the main checkout’s
`.agentics`, whether or not `repo` is a linked worktree), `effort`, `about`, `seq_max`, `malformed`,
`folders`, `nodes` and `cost`.

`folders` is every folder that holds a spec, root first, each `{id, title, approval, blocking, spec:
{path}}`: `title` and `blocking` (its open `blocking` questions) from `parseSpec`, `approval` from
`approvalState`. `nodes` is every live node, the root’s subtree first and then any node the tree
cannot reach, each `{id, label, parent, kind, author, title, intent, context, rigor, role, expects,
deps, acceptance, status, event, stage, branch, worktree, commits, live, files, card}`: `label` is
the node's own label, else the last segment of its id (the effort's name at the root); `author` is
who writes the node's spec, `you` or `planner`, so a reader can tell an open design node that waits
on the user from one develop's planner writes; `status` from `deriveStatus`; `event` is the
escalated or parked node’s own event (`{kind, seq, reason, detail, said}` or `{kind, seq, return,
question, said}`, the text read through `saidOf`, `said` the dispatch whose return holds its text,
else empty), else, for work agentics did not build, `{kind: merged, seq, by, commits, into,
merged_sha}` on a leaf adopted on the user's word or `{kind: outside, seq, by, commits}` on a folder
that carries `outside` events, and null for every other node; the new kinds are additive and the
format stays 4; `stage` is `todoFor`’s `activeForm` while its `status` is
`in_progress`, null otherwise; `branch` is the node’s own branch name, always; `worktree` is its
path only when checked out; `commits` is `{count, last_subject, last_at}` over the leaf’s own branch
since its folder’s, null unless the leaf is `active` (an inactive leaf, or anything that is not a
leaf, never earns the git call) or either branch is missing; `live` is the running dispatch's
activity ([Live activity](#live-activity)), null when none runs; `files.spec` is `{path, line}` — a
leaf’s folder spec at its plan entry’s line, a group’s at its heading’s, a folder’s own spec at no
particular line — and `files.returns` lists the node's stored returns. `card` is [the node
card](#the-node-card), `{next, behind, report, notes, relaunch, checkout_changed}`: `next` is
`{action, why}` from the resume ladder, for a leaf that is not merged, null otherwise; `behind`
counts the commits of its folder's branch the leaf's branch lacks, null unless the leaf is unmerged
and both branches exist; `report` is `{dispatch, lead}` for the latest return that carries text,
else null; `notes` is the node's `noted` events, newest first, each `{seq, by, text}`; `relaunch` is
`{execution, root, retry}` for the latest open execution whose root is the node or above it, `retry`
holding the node's id when it escalated itself, else null; `checkout_changed` is `{dispatch,
paths}`, the latest `checkout_changed` record among the node's calls, else null. A composite whose
`review` is set is followed, after its subtree, by its integration review as an entry of its own:
`id` from `reviewIdOf`, `kind` `review`, `parent` the composite, `label` `integration review`,
`status` the composite's `review` (`pending`, `done` or `not_earned`), `stage` its todo's
`activeForm` while in progress, `branch`, `worktree` and `files.spec` the composite's,
`files.returns` and `card.report` its latest reviewer's return, every other field empty or null.
`cost` is `costOf` in `lib/status.mjs` over every execution's `returned` lines, read by `callsOf` in
`lib/run.mjs`, each joined to the latest `dispatched` of its dispatch: `{dispatches, tokens, usd,
unmeasured, by_model, per_leaf, per_folder}`, each entry of `by_model` (per model), `per_leaf` and
`per_folder` (a folder's calls and every call below it) `{dispatches, tokens, usd, unmeasured}`.
`usd` is the host's own figure, and a call with no `returned` counts as unmeasured once its run is
not live. A snapshot asks each execution once whether its run is live and reads its records once, so
its `cost` and every node's `live` read the same answer.

`node lib/status.mjs node --repo <r> --effort <e> --node <id> [--json]` prints one entry of
`nodes`, the same shape, asking git about that node alone.

`node lib/status.mjs list --repo <r> --json` also carries `store`, present whether or not the
effort store exists.

### Spend view

- **Owner:** `spendOf`, `spendUnits`, `flagSpend` and `lineRatio` in `lib/status.mjs`.
- **Restated in:** `skills/self-improve/SKILL.md` (a reader: the flag names it maps to causes, and
  the lines it reports at the effort's end).

`node lib/status.mjs spend --repo <r> --effort <e> [--json]` prints `{effort, multiple,
earlier_efforts, means: {effort, earlier}, by_role, units: {leaf, folder, probe}, flagged, lines}`. Each
mean is per kind (`leaf`, `folder`, `probe`) `{units, usd, rounds}`, or null when no unit of the kind
is fully measured. `by_role` is role → model → `{dispatches, tokens, usd, unmeasured}`. A unit
carries those four and its `id`; a leaf also `status` and `rounds` (the highest round its calls
name), a folder `rounds` (its probe rounds), a probe round `folder`, `round`, `probers`, `axes` and
`spec_lines` (its folder's spec as it stands). Every unit carries `briefs_over`, its calls that opened
their session reading more than a first read may (`BRIEF_TOKENS`, from the `opened` each recorded).
`flagged` lists the units with `kind` and `reasons`, each one of `usd_over_effort_mean`,
`usd_over_earlier_mean`, `rounds_over_effort_mean`, `rounds_over_earlier_mean`, `probers_over_size`,
`axes_again`, `brief_over_bound`. `lines` is `{test_lines, source_lines, ratio}`, the lines the
effort's diff adds from where its branch was cut to its head (the branch, or once landed and swept,
the effort's side of the landing merge), split by `isTestPath`, docs and the store counted as
neither, `ratio` tests per source line or null with no source line; null when either end is
unknown. It is a measurement, and it gates nothing.

### Live activity

- **Owner:** `lib/runner.mjs` (the writer); `nodeOf` and `snapshotOf` in `lib/status.mjs` (the
  readers, each node's `live`).
- **Restated in:** `agentics-viewer/shared/snapshot.ts` in the vanillafairy repository (a reader,
  through the snapshot).

`executions/<stamp>/live/<dispatch>.json`, rewritten whole by the runner while the dispatch runs and
removed when it returns: `{turns, tool: {name, target}, at}` — the turns so far, the latest tool
call's name and target (`target` the call's file, command, pattern, path or url, `''` when it names
none), and when it was made. The `node` view prints it `last <name> <target>`. It is a view: a write
or removal of it that fails is dropped, the last one standing until the next turn's, and never ends
the call.

### Spec format

- **Owner:** `parseSpec`, `checkSpec`, `checkFolder` and `hashSpec` in `lib/spec.mjs`.
- **Restated in:** the `vocabulary` block ([Vocabulary](#vocabulary), naming every copy:
  `docs/DESIGN.md`, `roles/planner.md`, `skills/design/SKILL.md` and `skills/develop/SKILL.md`);
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
plan, or `/a/b` from the root folder), `provides` (`<name> (<path>, …) "<part>"`, the part optional), `consumes`, `ground`;
`author` (`you` or `planner`) and `shared` on a sub-effort; `rigor`, `role`, `expects` (optional), `reads`,
`runs` (the project commands the work runs beyond its role's and its checks, each named literally
and without `*`: ``runs: `npm run asset:rename` ``), `cites` (`Design | "<part>", …`) and `dispatch` (`producer=<model>/<effort>, reviewer=<model>/<effort>`) on a task,
which also needs a criterion; `label` on either, the node's visible name. A node's id is its path and carries its
parents; the label names the work done there in free text for people, at most 16 characters so
it fits a node's block in the viewer (`foundations/world/world-red` is shown as `World tests`). The
viewer draws the label, and the last id segment where none was written. A checked box is refused.
Headings and forms inside a fenced block are prose. A **part** of the Design is a `###` or `####`
heading of it outside a fence, and runs from that heading to the next heading at its level or above;
a quoted `"<part>"` names one by its key — the heading, case, markup and spacing aside — or by a
prefix of it that ends before a space or a bracket (`"Ports"` names `### Ports (critters/ports.ts)`),
and an exact key wins over a prefix (`designPart` in `lib/spec.mjs`). A task declares what it cites of
its spec's Design in `cites`: `Design` for the whole of it, each `"<part>"` for that part; its brief
carries what it cites ([Briefs and returns](#briefs-and-returns)), and a sentence of its title or
context that mentions the Design cites nothing. A task with no `cites` whose title or context cites
the Design the way a spec did before `cites` (`Design's "…"`, `"…" block of the Design`, `Design ›`)
is refused at its entry, naming `cites:` and `tools/migrate-design-cites.mjs`: its brief would carry
none of what it cites. A contract's `"<part>"` on `provides` is the part of
this spec's Design that defines it ([Specs, approval and compile](#specs-approval-and-compile)); a
contract with none is defined by the whole Design. A declared part that no heading answers to, or
more than one does, a `cites: Design` over an empty Design, and an empty `""` are refused at the
line that declares them. So is a task whose
title or context names `npm run <script>`, or that reads a recipe (`.claude/skills/<x>/SKILL.md`, a
`.claude/commands/` file) whose first fenced script is one, when its `runs` lists no such script and
the effort's established commands and its own criterion checks do not run it (`runsProblems` in
`lib/spec.mjs`): its producer would be denied the command.

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

- **Owner:** `lib/approval.mjs`, `lib/respec.mjs` for `ruled`, and `lib/answers.mjs` for `asked`
  and `answered`; the file names in `EFFORT_FILES` in `lib/ledger.mjs`.
- **Restated in:** `lib/compile.mjs` (reads `approved`, `prepared` and `compiled`); `lib/effort.mjs`
  (`renameSubEffort` copies those lines).

`ledger.jsonl` shares the effort's `seq` counter with the node and event logs:
`approved {folder, hash, decisions[{id, text}], by: user | terminal | ruling | answer, ruled?,
answers?, renamed_from?}` (`ruled` is the `seq` of the ruling it rests on, which compile reads;
`answers`, on an approval `by: answer`, the seqs of the `answered` lines it rests on) · `ruled
{folder, hash, from, basis, rulings[{node, ruling: unaffected | answered | affected, why, question,
fix, answers?}], standing[], clears[{node, status, why}], answers[], brief, by: ruler}` (`from` is the compiled hash the text was diffed against; a ruling's `node` is a
node id or a unit of the user's, `decision:`, `contract:` or `park:`; `answers` the seqs the brief
held) · `asked {nodes[]}` (a question opened; its token
is `answer <effort>#<seq>`) · `answered {asked, nodes[], answers[{question, answer}], by: user |
terminal, at?}` (`at` the transcript line the batch was read from) · `prepared {folder, hash,
review, by: planner, renamed_from?}` · `compiled {folder, hash}` · `disposition {folder, finding,
outcome: incorporated | discarded, by: user | planner}` · `review_skipped {folder, hash, reason}` ·
`reviewed {folder, hash, complete, remaining[], ambiguities[], clean[], sections{}}` (one per
review round; `clean` the sections every unit of which the round ruled with no finding, each once,
and `sections` the section of each settlement id; `lib/next.mjs` reads the latest, and the gate
reads the latest at the current hash and every later line's `clean`, a line without them read as
empty). `renamed_from` is the old
folder id, on the line `effort.mjs rename` appends for a renamed folder. A finding is named by its
settlement id: its evidence item id, or `<hash>#<P-id>` when the review could not anchor it;
`disposition` and `reviewed.ambiguities` both use it. A folder's approval state and its review gate
are derived, never stored, and a spec with an open `blocking` question is refused approval.
`node lib/approval.mjs approve|dispose|skip-review|reviewed|state|gate --repo <r> --effort <e>
--folder <id>` prints each function's result; `state` prints the folder's act token, empty with
the `problems` that stop a spec never approved or edited from being approved and compiled
(`askState`), and `approve` verifies the user's answer to it ([The user's word](#the-users-word)).
`node lib/answers.mjs ask --repo <r> --effort <e> [--node <id>…]` prints `{ok, asked, token}`, and
`record --repo <r> --effort <e> --asked <seq>` prints `{ok, answered, answers[], nodes[]}` or a
typed refusal. `skip-review` takes its
`reason` as `--reason <line>` or `--reason-file <path>`. A folder a planner wrote is
prepared in-process, by the spec boundary (`recordPreparation`). `reviewed
--from-run <run>` records a probe run's round from its result, so no list passes through a model:
`remaining` its open units, then `channel:<c>` for each failed channel, then its coverage's incomplete
and dropped entries, then `unreached:<line>` for each unreached line, then `unrecorded:<id>` for
each finding the store refused (a coverage partial with none of these names that), and `complete`
exactly when `remaining` is empty, so a review is never partial without saying what it left; `ambiguities` by settlement id; `clean` and
`sections` from its findings file, `clean` empty when the round kept no snapshot. It refuses a run
that resolves to nothing (`unknown_run`) or left no result (`no_result`), a result that rules no
units (`not_a_probe`), a probe of another artefact than the folder's spec (`not_this_spec`), an
empty snapshot its `unrecorded` findings do not explain (`no_snapshot`), a snapshot it cannot read
(`bad_snapshot`), a snapshot of text the spec has moved on from (`spec_changed`: probe it again),
and `--from-run`
beside `--complete`, `--remaining` or `--ambiguities` (`bad_args`).

### Compile result

- **Owner:** `compileEffort` in `lib/compile.mjs`.

`{ok, problems[{file, line, problem}], written[], retired[], parked[{node, reason}],
spared[{node, reason}], consumers[{node, contract}], flagged[{node, decision}], skipped[{folder,
why}], answered[]}`, printed by
`node lib/compile.mjs --repo <r> --effort <e> [--folder <id>]`. `ok: false` means
nothing was written. `compileEffort`'s `preview` option returns the same shape for an edited spec
read as approved, and writes nothing.

### Changed-spec results

- **Owner:** `respecBrief` and `respecSettle` in `lib/respec.mjs`, run by the `rule` program;
  `rulerBrief` in `lib/briefs/respec.mjs` (the ruler's brief).
- **Restated in:** `skills/develop/SKILL.md`, `skills/develop/respec.md` and
  `skills/design/SKILL.md` (they read the result); `roles/ruler.md` (the rulings it returns).

`node lib/run.mjs rule --repo <r> --effort <e> --folder <id>` briefs the change inline, with the
user's answers since the spec's latest approval, dispatches one ruler with the brief as its prompt,
writes its rulings and settles. Its result is `{status: approved, folder, hash, ruled, by: ruling |
answer, written[], retired[], flagged[], spared[], parked[], answered[]}`, `{status: needs_user,
folder, hash, ruled, affected[{node, why, question, fix}]}` (`affected` the units no answer
settles, a node or a `decision:`, `contract:` or `park:` unit), `{status: compile_refused, folder,
hash, ruled, problems[]}` or `{status: refused, next: user_approves | fix_spec | rule_parent_first
| rule_it | shrink_brief | planner | nothing, why, problems[]}`, each with its coverage block: a ruler that
returned nothing, or whose rulings settling refused the same way twice, fails `ruler`. The ruler
returns `ruler_respec`, `{rulings: [{node, ruling: unaffected | answered | affected, why, question,
fix, answers?}]}`, one per unit of the brief.

### State and journal lines

- **Owner:** the boundaries in `lib/boundaries/` (`fault`, `drift-ruled`, `stale-ruled`, `batch`,
  `batch-started`, `gate`, `checkpoint`, `checkpoint-confirmed`, `closed`, `merge-observed`,
  `series-done`, `authored`); preflight in `lib/boundaries/execution.mjs` also owns
  the adopted drift record file; `lib/runner.mjs` (`dispatched`, `returned`,
  `host_stop`, `checkout_changed`, `thread_renewed`, `tool_used`); `deliver` and `step` in
  `lib/programs/common.mjs` (`message`, `step`);
  `lib/run.mjs` (`run`, `ended`, and `fault` on the
  `program`, `git_hung` and `launch_failed` channels); the execute program (`fault` on a unit's node,
  and `hungRecords` in `lib/boundaries/records.mjs` the `git_hung` stop);
  `journalLine` in `lib/verify.mjs`; `measure` in `lib/measure.mjs` (`measure-done`); `executionLog`
  and `runLog` in `lib/ledger.mjs` (where each record goes).
- **Restated in:** `lib/resume.mjs` and `lib/status.mjs` (readers); `runState` in `lib/ledger.mjs`
  (reads a run's `ended`); `claim` and `callsOf` in `lib/run.mjs` (read `run`, and `returned`'s
  usage and cost, for a run's `costOf` and the effort's cost report in `lib/status.mjs`); `dispatch`
  in `lib/programs/common.mjs` (reads `dispatched`, `returned`, `message` and `thread_renewed`, and
  writes `thread_renewed` for a call it starts in a fresh session, and hands the runner the
  `denyRead` that `dispatched` records as `deny_read`, which `leafOpen` in
  `lib/boundaries/leaf-open.mjs` computes); `leafClose` in `lib/boundaries/leaf-close.mjs` (reads
  `dispatched`'s `deny_read`); `search` in
  `lib/programs/search/search.mjs` (reads `tool_used`, `dispatched` and `returned`);
  `measure` in `lib/measure.mjs` (reads `verify-observed` by `key`).

An execution's records go through its log port: its node events (`dispatched`, `message` and the
rest, [Node record and events](#node-record-and-events)) to the effort's event log, its
observations to `journal.jsonl` and everything else to `state.jsonl`, under the effort's `seq`.
`state.jsonl` (what the execution decided and what its calls cost): `run {program, scope, pid}`,
one per run of the execution; `returned {dispatch, session, status, cause, usage, context, opened,
cost_total, cost_usd, denials[]}` (`usage` the host's own figure for the call, `context` its last
model turn's and `opened` its first's, `null` when unmeasured), one per call the runner made,
written when the call ends; `host_stop {dispatch, cause, until}`; `checkout_changed {dispatch,
paths[]}`; `thread_renewed {thread, gen, why: too_large | session_missing | context_exceeded |
prompt_changed | cwd_changed | raised}`; `step {key,
value}` or `step {key, value_file, bytes}`; `batch {target, identity, merged[], head_sha, verified, failed_alone[], combination[], conflict}`,
landing before the batch's `merged` events; `gate {target, head_sha, passed, checks}`, `checks` the digest of the criterion checks it ran, one per suite gate
that ran; `checkpoint {reason, detail, executions?, gaps?, branches?, lost?}` (the lists the checkpoint found, `branches` the `[{branch, commits}]` of an `outside_work` one, `lost` the `[{branch, exists, node, merged_sha, reachable_from}]` of an `integration_lost` one;
`lib/status.mjs checkpoint` prints them); `checkpoint-confirmed {reason, gaps?, executions?}`, the
reason and what the confirmed checkpoint line found; `closed {status: done | migrated}`; `batch-started {target, pre, children, heads?, identity?}` (`heads` the units' heads, in order; `identity` the batch's `batchIdentity`, absent on a line from before it was recorded, which no batch reads back);
`drift-ruled {node, contract, head_sha, ruling, why, said, adopted_seq?}` (`adopted_seq` the seq of the adopted record the ruling covers, [Landing and drift](#landing-and-drift)) and `stale-ruled {node, base_now,
ruling, why, said}` (`said` the ruler's dispatch; the newest `stale-ruled` of a leaf is its anchor
for the next moved base once it is `unaffected` or answered on disk); `fault {node, channel, detail}`, once per node and channel
in a run (the faults after the latest `run` are what the schedule holds); `ended {result}`, one per
run's end, where a watching session stops.

`execution.json`, the envelope preflight writes once, is `{stamp, root, base_branch, base_sha,
dial, pace, commands}`: `base_branch` the `base_ref` the session gave (else the branch checked out
at the start), and `commands` the session's commands file as it was handed over, `{build,
typecheck, suite, suite_fast, test_one, absent}`, `absent` a map from a command name to `true` — a
record of what the session gave, which nothing that measures reads. Beside it,
`stale-<head>.json {now, nodes}` names the leaves a ruler on a moved base was briefed on, and
`merges/adopted-<seq>.json {kind: adopted, target, seqs[], head_sha, drift[{node, contract, files,
adopted_seq, stopped?}]}` beside its brief `adopted-<seq>.drift.md` those a ruler on adopted work was.

`journal.jsonl` (what was observed, by whoever observed it): `verify-observed {node, branch,
worktree, base_sha, head_sha, producer, key, stop_reason, build, typecheck, suite, suite_scope,
failing_tests, baseline_failing, discriminator, mutations, series_findings, approved_failing,
checks}` (`key` what `measure` reuses it by); `measure-done {key, moved}`, which `measure` appends
once the after-watch has read the checkout, `moved` whether the checkout changed during the check (a
`verify-observed` line counts as journalled only with one at its key after it); `merge-observed
{node, branch, into, merged_sha, head_sha}`; `series-done {node, branch, head_sha, commits[{sha,
subject}]}`, journalled by leaf-close from git when the producer declared it done; `authored {node,
role, round, sha}`, the commit leaf-close made for a shell-less author, read across executions by
the series check of a green or an audit.

A program run outside an execution keeps the same kind of log, `runs/<run>/state.jsonl`, with its
own `seq` ([Programs](#programs)): `run {program, scope, pid}`, one per start or resume;
`dispatched {dispatch, node, round, thread, role, model, effort, session, brief_digest, carries[],
prompt, cwd, pid, deny_read[]?}`; `returned {dispatch, session, status: returned | part | failed | cut_off, cause,
usage, context, opened, cost_total, cost_usd, denials[]}`, a `cut_off` caused `orphan_ended` or
`process_gone`; `host_stop {dispatch, cause,
until}`; `checkout_changed {dispatch, paths[]}`; `thread_renewed {thread, gen, why}`; `tool_used
{dispatch, thread, tool, input}`, one per host `WebSearch` call as the call streams; `message
{thread, from, msg, payload, round}`; `step {key, value}`, a side effect the program journaled; `fault {node, channel, detail}` with `node` empty; and `ended {result: {status: done | failed | launch_failed, file, complete}}`. No
field of a record is named `kind`: the log's port sets it, so a call's failure or stop class is its
`cause`.

### The seq counter

- **Owner:** `append` and `appendRun` in `lib/ledger.mjs`.

An integer, one counter per effort across the node log, the event log and every execution's state
and journal, minted under the effort lock and never supplied by a caller. It is rebuilt from the
highest `seq` on disk when the counter file is lost. What it decides is ordering: which revision is
latest, and whether an escalation or park is newer than the replan that would clear it. A program
run outside an execution counts its own log the same way, under `runs/<run>/seq` and
`runs/<run>/.lock`; an execution's run has no counter of its own: its records take the effort's
`seq`, and `appendRun` refuses an execution's run id.

### Store stamp

- **Owner:** `STORE_VERSION`, `storeVersion` and `mkdirState` in `lib/store.mjs`.
- **Restated in:** each `tools/migrate-to-<v>.mjs`, which writes `{version: v}`; the `store_version`
  row of `skills/develop/SKILL.md`.

`.agentics/.state/store.json` is `{version}`, an integer: the format of every record and file
under `.agentics/`. `mkdirState` writes it, at `STORE_VERSION`, when it gives a store its first
state — the root's own `.state/` or an effort's — and never otherwise, so a store with no stamp is
one that predates the stamp, read as version 0. Preflight refuses a store at any other version than
`STORE_VERSION` (`store_version`): below it, naming each `tools/migrate-to-<v>.mjs` from the store's
version up; above it, a store a newer plugin wrote. A change to what the store holds raises
`STORE_VERSION` and ships the migration that rewrites a store into it.

### Verify payload

- **Owner:** `blank()` and `verify()` in `lib/verify.mjs`.
- **Restated in:** `measurementOk`/`closeDecision` in `lib/verdict.mjs`; `lib/resume.mjs`; the
  merge-batch's and the suite gate's integration checks in `lib/boundaries/merge.mjs`; `measure`
  in `lib/measure.mjs` (hands back a journalled payload, and sets `measure_failed` and
  `watch_failed`).

`stop_reason` (`completed | environment_broken`, broken exactly when `error` is set); `build`,
`typecheck` (`passed | failed | absent`); `suite` (`passed | failed | absent | not_run`) and
`suite_scope` (`fast` or `full` on a merged head, `scoped` for a leaf's own tests, `none` when
nothing ran); `suite_output_tail` (only when the suite failed);
`failing_tests[{file, id}]`; `baseline_failing[{file, id}]` (failing tests that fail at the base
too); `discriminator[{test_id, blob, base_blob, adds_test, failed_on_base, passes_now}]` (`blob` the
file's blob at the measured head, what a ruling over the file is keyed by; `base_blob` the same at
the base, `''` for a file the base lacks, which with `blob` carries an upkeep reading
(`upkeepAt`); `adds_test` false for a
file declared upkeep whose diff adds no test-case declaration, or one the leaf's own diff did not
touch; an entry without it is read as adding one);
`static_on_base[{kind, command, failed_on_base}]` (on a tdd leaf whose every changed test file held
at base, the established typecheck, `kind: typecheck`, and each criterion check that runs it, `kind:
check`, each run at base with the tests under measurement restored; empty otherwise);
`mutations[{file, find, replace, applied, unapplied_reason, expect_failing, observed_failing,
bites}]`; `series_findings[{sha, check, message, blocking}]`; `checks[{command, status,
failing_tests, baseline_failing}]` (`status` `passed | failed | unrunnable`);
`approved_failing[{file, id}]` (approved cases that fail when the red's approved version of their
file runs in its place at the head); `notes`; `error` (`null` or `{kind, message}`: `no_worktree`,
`main_worktree`, `series_unreadable`, `command_unknown`, `shell_refused`, `suite_failures_unnamed`,
`base_checkout_refused`, `test_unrunnable`, `tree_not_restored`; and `measure`'s own, a child that
gave no payload `measure_failed` and a checkout the watch could not read `watch_failed`);
`journal` (`null` or `{written, error}`). `node lib/verify.mjs --options -` reads its options, one
JSON object, on standard input — `key`, `upkeep[]` (the test files read as adding no case),
`approved[{file, sha}]` (the red's approved version of
each cycle test file), `expects[]`, `fences{sha: rule}`, `exclude[]` (a cycle member's predecessors'
approved heads) and `resolves[]` (the paths the judge sent the leaf's rebase rounds) among them — and prints the payload as one
JSON line, or, exiting 1, `{error}` for a throw — with `code: 'git_hung'` and the git's `label` for
a git killed at its ceiling, which `measure` throws as `GitHung` again rather than handing back a
payload. The series checks
come from `lib/commit-series.mjs`: `empty-series`, `empty-commit`, `role-breach`, `test-removed`,
`wip-subject`, `checkpoint-commit`, `and-subject`, `subject-length`. They run over `base..HEAD`,
each merge read by its remerge diff (`log --remerge-diff`): what it changed beyond git's own remerge
of its parents — a resolution, an extra edit, a removal — so a clean refresh lists nothing and is no
empty commit, and a merge owes no subject style, its subject being git's. `role-breach` judges the series' net diff against what the leaf's role may change
([Role rules](#role-rules)), and each commit the program made for a shell-less author against its
own fence (a test round's commit on a green or an audit, held to test files), and each commit that
touches a path a rebase round resolved by the role, but the merge that resolved it; `test-removed`
flags a test case removed from a test file the cycle approved. `tests_rewritten[]` names the test
files the net diff changed that exist at the base, outside `expects` and the cycle's tests, and every
resolved test: an observation a reviewer rules, never a failure.

### Gotcha file

- **Owner:** `lib/gotchas.mjs` (`renderGotcha`, `parseGotcha`, `gotchaProblem`, `writeGotcha`,
  `commandsOf`, `COMMAND_NAMES`).
- **Restated in:** the producer and auditor return schemas in `lib/schemas.mjs`;
  `roles/investigator.md`; `writeSessionCommands` in `lib/boundaries/execution.mjs` (the session's
  commands); `ROLE_NAMES` in `lib/roles.mjs` (the roster `gotchaProblem` reads `roles` against).

Frontmatter `{id, kind, roles, paths, observed_at, source, command?}`, `roles` naming roles of
`ROLE_NAMES` in `lib/roles.mjs`, the roles this plugin defines (any other is refused): `source` is
`{node, role}` for a producer's, `{role: investigator}` or `{role: session}` for a command;
`command` is `{name, value, absent}`, `name` one of `COMMAND_NAMES`. Body `When <trigger>, do
<action>.` plus the evidence. A return carries a gotcha as `{trigger, action, evidence, kind, roles,
paths}`, and the ones it found no longer hold by id; leaf-close refuses a `command` one, and a stale
`command-<name>` id, from a producer.

### Slots and locks

- **Owner:** `lib/locks.mjs` (`acquireAsync`, `withBranchLockAsync`), `withLock` and `withLockAsync`
  in `lib/store.mjs`.

`.agentics/config.json {max_parallel, max_agents, claude_cli, guidance, design_spend_multiple}`; `slots/<n>.lock {effort,
execution, node}`;
`.agentics/.state/locks/tests.lock`, the project's full-suite lock;
`.agentics/.state/runs/.claims/<program>-<scope digest>.lock`, a run's claim; `runs/<run>/.lock`, a
run log's mutex. Branch, test, claim and mutex locks are taken by `withLock`, or inside an execution
by `withLockAsync` and `withBranchLockAsync`, whose waits are awaited sleeps that never stop the
event loop: the lock is a directory holding one holder file, named for that acquisition, `{pid,
host, at}`, built beside the lock and renamed into place, so a lock is never seen without its
holder. A holder on this host is broken exactly when its pid is dead; one from another host after
ten minutes. Breaking removes the holder file it judged, by that name, and then the directory only
if that emptied it: a judgement the lock outran — its holder released, another took it — removes
nothing, because a directory with a holder in it is never empty. A rename onto a lock that is held,
or still being released, is refused, and the taker waits.

### Session calls

- **Owner:** `land`, `landAct`, `adoptAct`, `acceptDrift`, `retry`, `note`, `pauseRun` and `resumeRun` in `lib/boundary.mjs`, which holds those
  and their CLI alone, and `adopt` in `lib/adopt.mjs`, which `adoptAct` and the CLI call: any other
  verb exits 1 with `{error: program_failed}`.
- **Restated in:** `skills/develop/SKILL.md`, its landing reference and its `outside-work.md`.

Every other boundary is a function the `execute` program calls in-process
(`lib/boundaries/*.mjs`); its result is a value, and its shape lives in its own module. These are
the session's, called as CLIs:

- **land** — `check`: `into` (the user's checked-out branch), `effort_branch`, `effort_head` (the
  head its token names), `open_escalations`, `parked`, `human`, `drift {base_sha, base_moved,
  commits, overlap}`, `root_status`, `root_claims`, `unsettled_claims[{node, claim, ruling}]` (every
  drift and `cant_tell` a folder's standing review left without a park), `landing`, `token` (the act the user's answer
  must choose: `land <effort>@<head8>` over the effort branch's head, `land <effort>@` once the
  branch is gone); `merge`: `merged_sha`, `already` (nothing left to merge), `removed[]` (the
  branches swept), `kept[{branch, why}]`, once `landAct` has confirmed the user's word
  ([The user's word](#the-users-word)); the `landed` event records `by`, and `merge` records it
  when no root `landed` record exists or the latest one's `merged_sha` does not hold the effort
  head. A refused merge carries the check's fields with `ok: false` and `error`: `{kind: head_moved,
  message}`, `{kind: no_effort_branch, message}`, or the words of an open escalation or park, a
  dirty tree, a merge that failed and was aborted. `check` with no effort branch (nothing landed
  and swept) returns its report with `token: ''`, `ok: false` and the `no_effort_branch` error, and
  `landAct` returns that refusal before asking anybody. `record --head <sha>`: `into`, `merged_sha`,
  `already`, `closed[{node, status}]`, `left_out[{node, merged_sha}]`, `removed[]`, `kept[]`; refused
  `{kind: no_such_commit | not_in_branch | effort_branch_ahead, message}`, writing nothing. A word not confirmed is `confirmAct`'s
  refusal, `{ok: false, error: {kind, message}}` (`no_token`, `not_approved`,
  `answer_unverifiable`).
- **adopt** — `adopt --repo <r> --effort <e> --folder <id> --map-file <path> --action check|act`
  ([Outside work](#outside-work)); every flag is a handle or a path, and a map file that does not
  resolve refuses `unknown_file`. `check` returns `{ok, action, effort, folder, folder_branch,
  folder_head, digest, refusals[{entry, kind, message}], role_breach[{node, paths[]}],
  clears_stops[{node, kind, reason}], deps_open[{node, deps[]}], unaccounted[{branch, commits[],
  error?}], criteria[{node, criteria[]}], token}`; `ok` is false and `token` empty while any
  refusal stands. `act` (through `adoptAct`, once the user's word is confirmed) returns the check's
  fields beside `recorded` (the seqs of the records written) and `created` (the branches made),
  or `ok: false` with `refusals` when the check refuses, or with `error: {kind, message}`:
  `head_moved` (the digest the token named is not the digest now), `branch_failed` (a branch could
  not be created; those already made are in `created`), `append_failed`, `bad_arg` (an action that
  is neither), or `confirmAct`'s refusal (`no_token`, `not_approved`, `answer_unverifiable`). The
  refusal kinds are listed under [Outside work](#outside-work).
- **net** — `net --repo <r> --effort <e> --node <leaf> --file <path>`: the session's ruling, or the
  user's it records, on a leaf escalated `discriminator_undecidable`. The file is JSON the session
  wrote, `{nets: [{file, why}]}`, each `file` a changed test file of the measurement the escalation
  stands on (its execution's latest `verify-observed` line of the leaf before it) that passes now
  and passed at base, `why` one line. Returns `{ok: true, head_sha, nets_n, all}` or `{ok: false,
  error: {kind, message}}`, writing nothing: `not_a_leaf`, `not_undecidable` (the leaf's standing
  stop is not that escalation), `no_measurement`, `bad_file` (not that shape, or a file listed
  twice), `no_nets`, `not_measured` (no such changed test file), `not_a_net` (it discriminates, or
  does not pass now), `no_reason`, `no_blob` (the measurement records no blob of the file, so a net
  would stand nowhere: retry, and rule on the next measurement); an unresolved file refuses
  `unknown_file`. On success one `nets`
  event is appended under the escalation's execution, each net keyed by its file's blob in that
  measurement, so a commit that changes the file voids it and one that leaves it alone does not;
  `all` when the leaf's nets leave no file of that measurement to discriminate. `retry` then clears
  the stop and the leaf's next close measures it under the ruling.
- **accept** — `accept --repo <r> --effort <e> --node <folder> --file <path>`: the session's verdict
  on drift claims an integration review found, and the one thing that clears the park the review
  earned without a re-spec. The file is JSON the session wrote, `{claims: [{claim, why}]}`, each
  `claim` exactly as the folder's standing `claims` event records it. It prints `{ok, accepted_n,
  park}` (`park` the class of the park what remains still earns, or `null`) or `{ok: false, error:
  {kind, message}}`, writing nothing: `not_a_folder` (not a live composite), `no_review` (no
  `claims` event stands, or it is `not_earned`), `not_a_drift_park` (the folder is not parked
  `integration_critical` by that very review: its `said` is the park's), `no_return` or
  `critical_finding` (the review's stored return is gone, or holds a `critical`, or its event leaves
  one `open`, which is never accepted), `not_acceptable` (a listed claim is not in the event, or was not ruled `under`, `over`
  or `deviates`: a `spec_defect` needs a spec change and a `cant_tell` is never a pass), `no_reason`
  (an empty `why`), `no_claims` (an empty list) and `bad_file` (not that shape, or a claim listed
  twice); a file that does not resolve refuses `unknown_file`. Acceptance may be partial. On success
  one `claims` event is appended under the review's execution: the same `head_sha`, `review: done`
  and `said`, each accepted claim's ruling `accepted`, `accepted[{claim, was, why}]` (the earlier
  acceptances kept) and `by: session`; then, if `integrationPark` over the claims as they now stand
  still earns a park, that park with the same `said`. With no park left the newer event stands and
  the folder reads `integrated`.
- **pause** — `pause --repo <r> --run <run>`: an execution's run (`<effort>.<stamp>`) told to start
  nothing new. One `paused` event under that execution (`pauseExecution`), unless one already
  stands. The running program reads it at its next tick, each of its leaves before its next round
  or review and again once its slot is open, and a merge batch once its branch lock is held
  (`pausedNow` in `lib/boundaries/execution.mjs`, the one reader): a wait never carries a unit past a pause; what runs finishes and records, nothing
  new is launched, a merge included, and the run ends `stopped: pause` once nothing runs, resumable.
  The pause stands over a relaunch until `resume`. Prints `{ok, paused, already, run, live}`
  (`paused` the event's seq) or `{ok: false, error}`: `unknown_run`, `not_an_execution`, `closed`.
- **resume** — `resume --repo <r> --run <run>`: a `resumed` event after the standing pause
  (`resumeExecution`; `resumed: 0` when none stands); a live run goes on at its next tick, and a
  run that is no longer live is started again, detached, with the arguments its run.json records
  but those that shape only a new execution or stop it (`relaunchRun`, `relaunchArgv`): `{ok, resumed, run,
  relaunched}`, `relaunched` what `run.mjs` prints for a start, or null for a live run. The resume
  appends `resumed` and then reads whether the run is live; a run ending appends `ended` and then
  reads the pause (`afterEnded` in `lib/programs/execute.mjs`), starting itself again when it stopped
  for a pause that is cleared. Whichever writes second sees the other's write, so a resume that
  lands while a paused run ends is never lost, and the claim refuses the second of two starts.
- **retry** — `retry --node <id>…`: `{retried[], error}`; each `replanned {reason:
  retry_escalated}` names the open execution holding the node (the latest open one whose root is
  the node or above it), or `''`.
- **note** — `note --node <id> (--text <t> | --text-file <path>)`: `{noted, error}`, `noted` the
  node a `noted` event was appended for, empty when the node is not live or the text is empty; the
  event names the holding execution the same way.

Neither `retry` nor `note` takes `--execution`: any flag but its own, wherever it stands, refuses
`bad_arg` naming that flag, and records nothing; any other argument that is not a handle, and a
`--text` past one line of 300 characters, refuses `args_unreadable` before anything is recorded
(`handleArgs`), naming `--text-file`, which takes the note from a file the session wrote. Both are
live inputs to an execution: leaf-open hands the cleared stop's reason and the notes left since it,
or since the thread's latest return when that is later, to the leaf's next round as `retried` ([Conversations](#conversations)); a leaf its review loop stopped goes on at that
next round, handed the stopping review's open findings beside it. `retry` also makes the node's next
check measure again: `measure` hands back no `verify-observed` line of the node older than its
latest `retry_escalated` event. A retried planner folder plans afresh from the planner thread's
next round ([Autonomous review](#autonomous-review)). Commits the session made on the leaf's branch before it retried are
measured before any producer round ([Resume and checkpoints](#resume-and-checkpoints)).

### Producer returns

- **Owner:** the `producer` schema in `lib/schemas.mjs`; `producerOutcome` in
  `lib/boundaries/leaf-close.mjs` (what each status decides).
- **Restated in:** `roles/implementer.md`, `roles/test-author.md`, `roles/investigator.md`;
  `leafOpen` in `lib/boundaries/leaf-open.mjs`, whose `deny_read` (`greenSource`) decides which
  `unread` entry is dropped; `leafClose`, which hands `upkeep` to verify through `upkeepAt` in
  `lib/verdict.mjs`.

`{status, text, concerns[], unread[{kind, path, what}]?, gotchas[], gotchas_stale[], mutations[], upkeep[]?, commit?}`.
`upkeep` names each test file of the leaf's diff that adds no test case, only keeping existing
tests working, spelled as `unread`'s paths are (`repoPath`): a declaration the discriminator reads
([What a verdict is computed from](#what-a-verdict-is-computed-from)); a file it leaves out, or
one whose diff adds a test-case declaration ([Verification](#verification)), adds one.
`unread` names each document, spec part or contract the brief told the producer to follow or match
that neither its brief nor its worktree held, typed: `kind` `doc` or `source`, its `path`, and `what`
of it: a declaration of what it worked without, never a ruling. A return that names any stops before
it is measured, at every rigor, escalated `unread_reference` with them as its `detail`: work matched
against a guess never merges. A path the round was denied reading is kept from it by design, so
leaf-close drops an entry whose `path` exactly equals one its `dispatched` line records in
`deny_read` (leaf-open records it: a cycle's test round is denied the green's source), both read as
the brief lists paths, repo-relative with `/`: a leading `./`, backslashes and the worktree's root are
spelling, case is not (`repoPath` in `lib/boundaries/leaf-close.mjs`); nothing else of an entry is
matched, and no other entry is dropped. A return stored before `unread` was typed is typed by
`tools/migrate-to-1.mjs` ([Migrations](#migrations)). The reviewer's side of the
same rule (`roles/reviewer.md`): a unit held to a document neither its brief nor the worktree carries
is never ruled clean, but a major finding naming it. `status` is
`done | done_with_concerns | blocked | needs_context | needs_tests | decompose | unsplittable |
premise_mismatch | needs_decision | contract_changed | declined`; for any but `done`, `text` says what was established, tried and needed, its first line
the gist. `needs_tests` is offered to a green's implementer alone and `declined` to the cycle's
test session alone ([Executors and review](#executors-and-review)); `commit` is the subject a
shell-less author's files are committed under. `mutations` are `{file, find, replace,
expect_failing}`. The status is the only request a producer makes; [Conversations](#conversations)
routes it. A return with no string `status` holds the leaf on a `role` fault. An auditor's return,
`{mutations, units, retire?[{claim, evidence}], text}`, carries no status and reads as `done`;
`retire` names the cycle tests it asks the consolidation round to retire or merge (restated in
`roles/auditor.md`).

### Coverage block

- **Owner:** `resultOf` in each `lib/programs/*.mjs`, over `coverageOf` in
  `lib/programs/common.mjs`. The `coverage-block` lint rule requires every program file but
  `common.mjs` and `converge.mjs` to define `resultOf` and build its result with a `coverage` key
  that is not an empty object or null.
- **Restated in:** the skills that walk a result; `coverageLine` and `searchCoverage` in
  `lib/programs/search/consume.mjs`, which build a search's lines and its four lists in the line
  grammar under [Searches](#searches) (owner of that grammar), quoted in the `investigate` and
  `search-for-existing-solutions-before-building` skills (`test/fast/coverage-grammar.test.mjs`
  pins their examples against the lines the code writes).

`complete` (computed: false whenever `dropped`, `incomplete`, `failed_channels` or `unreached`
holds anything, and per program besides — a survey also needs every item it returns standing, an
investigation its survey's `complete`; for
`execute`: no checkpoint, every leaf in scope merged, the
root integrated, nothing escalated or parked — carried from an earlier run or not — and no earned
integration review or survey lost), `declared` (what rests on a declaration — a search's scout returning among them — named),
`dropped[]`, `incomplete[]`, `failed_channels[]`, `unreached[]` (prose, loss first),
`resumable {program, scope, args}` (`args` the flags as given, by argument name).

### Evidence item store

- **Owner:** `lib/evidence.mjs` (`checkItem`, `recordItems`, `recordJudgement`, `recordRulings`,
  and the mappers from returns — objects in-process, or stored files — `recordSurvey`,
  `recordProbe`, `recordSolutions`), whose `runQuery` builds every query through `queryOf` in
  `lib/search/query.mjs`, the dialect the search tools share, a query's `scope` parts read as globs
  in the search glob dialect (`globOf`); `tools/migrate-glob-literal.mjs` reports the stored scopes
  that dialect reads otherwise ([Migrations](#migrations)); written through
  `lib/ledger.mjs appendProject`, which mints a project-wide `seq` under `.agentics/.state/.lock`.
- **Restated in:** the judge return schemas in `lib/schemas.mjs`; the `effort-store`
  block in the design, challenge-idea and develop skills (the `cite` call).

`items.jsonl` holds `{kind: 'item', item, seq}` and `{kind: 'judged', id, ruling: holds | fails |
unsure, at, seq}` (a `holds` that could not be re-anchored is stored as `unsure` with `requested`
and `why`). An item is `{id, question, topic, ground[], kind, claim, spans[{path, start, end, at}],
queries[{pattern, scope[], result[{path, text}]}], sources[{url, version, retrieved}], rests_on[],
detail?, from_return}`; `at` is a commit sha or `snapshot:<hash>`. Raw returns sit in
`returns/<stamp>[-<n>]-<kind>.json` (`survey`, `probe`, `solutions`, `approach`; an `approach`
draft or a clean `probe` round carries no items), spec snapshots in `snapshots/<hash>.txt`.

The programs call the store in-process. A session calls two verbs: `items --ground <a,b>
[--states <s,s>] [--return-kind <kind>]` → `{items[{id, state, topic, kind, seq, ground[]}],
context}`, and `cite --effort <e> --folder <id> --from-run <run> [--from-run <run>]… [--exclude
<id>]… [--gap <text> | --gap-file <path>]…` → `{ok, seq, items_n}`, which cites every item the named runs' results list
— a survey's or a sweep's `items`, an investigation's `evidence.items` — the union in run order,
each once, less the excluded, so no list passes through a model. It refuses a run that resolves to
nothing (`unknown_run`), left no readable result (`no_result`) or whose result carries no items list
(`no_items`, as a probe's or the drafts' does); an `--exclude` no named run lists (`unknown_item`);
`--exclude` without `--from-run` (`bad_args`); and whatever `recordCites` refuses, the whole cite
(`refused`), a cite with no item and no gap among them. A folder cites once, naming every run it
rests on, because its latest line is its whole citation.

### Cites

- **Owner:** `lib/evidence.mjs recordCites`; read by `lib/render.mjs renderEvidence`.
- **Restated in:** the `effort-store` verbatim block.

`cites.jsonl` in an effort's `.state/` holds `{kind: 'cites', folder, items[], gaps[],
renamed_from?, seq}`. A folder's latest line by `seq` is its whole citation; `latestCites` reads
each folder's. `renameSubEffort` appends a copy of a renamed folder's latest line under its new id,
with `renamed_from`.

### Call log

- **Owner:** `handle` and `serve` in `lib/search/server.mjs`, which append each answer's records
  before the answer leaves.
- **Restated in:** the scripted runner's seam (`test/fast/harness/scripted-runner.mjs`, which writes
  it in the spawn-free tier) and its record builders in `test/fast/harness/scout.mjs`; `openCalls`
  in `lib/search/server.mjs` (the one reader); `search` and `hitsOf` in
  `lib/programs/search/search.mjs` (read it, and append the `websearch` records); `callLines` and
  `resumeBrief` in `lib/briefs/search.mjs` (readers).

`<run dir>/searches/<search key, ':' as '~'>/calls.jsonl`, one `CallRecord` per line, `seq`
numbering the records across every server process of the search and `session` the server spec's:

- a tool call: `{seq, session, tool, args, ok: true, total?, page?, pages?, observed[{key, line}],
  keys[], new}`; `args` the call's own arguments, defaults filled and `page` included; `observed`
  the `(key, line)` pairs it showed, `keys` the files, commits or URLs it listed; `new` whether any
  of those is in no earlier record of the journal.
- a refused call: `{seq, session, tool, args, ok: false, refusal, detail, observed: [], keys: [],
  new: false}`; `refusal` `stalled` for a call after the session's guard fired, which never serves
  as a repeat's source.
- an exact repeat in the same session: the call's own `seq`, `session`, `tool` and `args`, with
  `ok`, `refusal`, `detail`, `total`, `page`, `pages`, `observed` and `keys` copied from the call it
  repeats, `repeat_of` that call's seq, and `new: false`.
- a hit: `{seq, session, tool: 'hit', args, ok: true, hit}`, `hit` one of `{path, line, note,
  label?}`, `{commit, note, label?}` or `{url, line?, note, label?, candidate?}`, `candidate`
  `{name, source_url, what_it_is, latest_version, license, maintenance, covers, does_not_cover}`;
  refused, `{seq, session, tool: 'hit', args, ok: false, refusal: 'bad_hit', detail}`.
- the guard firing, once per session: `{seq, session, stalled: true, window: 12}`.
- a host `WebSearch`, appended by `search` after the session, each `from_log` once: `{seq,
  session, tool: 'websearch', args: {query}, ok: true, from_log}`, `from_log` the `tool_used`
  entry's seq and `session` that of the dispatch whose CLI ran it.

### Search tool server spec

- **Owner:** `search` in `lib/programs/search/search.mjs`, which builds it, through `mcpConfigFor`
  in `lib/search/server.mjs`, which writes it.
- **Restated in:** `serve`, `toolDefs` and `handle` in `lib/search/server.mjs` (readers); the
  scripted runner's seam (`test/fast/harness/scripted-runner.mjs`, which reads the call log's path
  from it).

`server-<digest>.json` is `{tree{root, sha}, scope[], subject[], labels[], tools[], calls, pages, session}`:
`scope` the paths the repo tools run over, `subject` the paths a path hit may name, `labels` the enum a hit may carry, `tools` the domain's
(`TOOLS_BY_DOMAIN`), `calls` the absolute path of the search's call log, `pages` the run's
`pages/` directory, where `fetch` pins pages, and `session` the session id of the CLI start it
serves. `<digest>` is the digest of the spec. `mcp-<digest>.json` is `{mcpServers: {search: {type:
'stdio', command, args: [<server.mjs>, '--spec', <server-digest.json>]}}}`, the file
`--mcp-config` names. Both are written at every CLI start of the search, named by the spec's
digest, so a start in a renewed session gets a spec of its own.

### Search result

- **Owner:** `search` in `lib/programs/search/search.mjs`.
- **Restated in:** `hitExcerpts` in `lib/citations.mjs`; `coverageLine`, `searchCoverage` and
  `searchComplete` in `lib/programs/search/consume.mjs`; and the `probe`, `survey` and `solutions`
  programs (readers).

`{name, status: done | stalled | budget | failed, why, summary, hits[], calls[], cost, tree{root,
sha}, pages, sessions[{session, thread}], rounds[{added, cost}], coverage{rounds, last_added,
skipped}}` (`coverageLine` writes `coverage` into the line): `why` says how it ended for every status but `done`
(`''`); `summary` the last returned round's scout's summary (`''` when none returned); `hits` the journal's ok hits,
each once ([Call log](#call-log)); `calls` one line per journaled call, hits left out; `cost` the
dollars recorded on every round's `returned` entries; `pages` the run's `pages/`
directory; `sessions` every session the search's thread ran in; `rounds` each round's new places and dollars;
`coverage` the rounds run, the hits the last added, and `skipped`, the last returned scout's `unsearched` joined by `; ` (`''` when it named none).

### Program results

- **Owner:** `resultOf` in each `lib/programs/*.mjs`.
- **Restated in:** the skills that read them.

- **`execute`** — takes `effort` (required), `folder` (a folder with a spec, default the effort's
  root), `intelligence` (`low | normal | max`, default `normal`), `pace` (`frugal | balanced |
  fast`, default `balanced`), `plan_only`, `pause`, `budget` (tokens; 0 none), `confirmed` (the
  `seq` of the checkpoint line the user confirmed past; 0 none), `base_ref` (the base branch's
  name, kept in the envelope so a later preflight sees the base move) and `commands_file` (the
  session's commands, `{build, typecheck, suite, suite_fast, test_one, absent}`); `intelligence`,
  `pace`, `base_ref` and `commands_file` shape a new execution only. Returns `{effort, root,
  execution, checkpoint {reason, detail, seq}, nodes_n, implemented[{id, rigor, role, rounds,
  review_rounds, at_integration, salvaged, nets, undiscriminated}], escalations[{id, reason, said}], parked[{id, return,
  said}], faults[{id, channel}], blocked[{blocked_by, leaves_n}], integration{branch, head_sha,
  reviews[{target, said}]}, drift[{node, contract}], cleanup_n, stopped: '' | budget | pause,
  paused, notes, coverage}`: `root` is the folder it ran, `paused` the seq of the session's pause the
  run stopped for (0 when it did not, a `--pause` flag's stop included), `checkpoint` null when none stopped the run, and
  `implemented[].role` the node's role (`none` outside a cycle), `nets` the test files whose
  regression nets stand in its approved measurement and `undiscriminated` whether they leave no file
  of it to discriminate (`approvedNets`). A preflight refusal returns the
  same shape with `error {kind, message}`, `checkpoint` null and the unreached line `preflight
  refused (<kind>): nothing was dispatched`. A stop's text is its `said` dispatch's return, or the
  node's card. `coverage.unreached` names every stopped node and counts the rest.
- **Every program `lib/run.mjs` starts** has its result written to `result.json` in its run's home
  by `lib/run.mjs`, with `run` and `cost {dispatches, by_model, tokens, usd, unmeasured}` added,
  each `by_model` entry `{dispatches, tokens, usd, unmeasured}` ([Programs](#programs)).
- **`survey`** — takes `question_file` (required), `roots` (default `.`), `notes` (or `notes_file`),
  `prior_file` (a
  file the session wrote: what an earlier pass concluded, which the planner reads and no searcher is
  shown), `read_file` (a file the session wrote: what it has already read itself, which the planner
  plans around and no searcher is shown), `max_topics` (default 8), `intelligence` (`low | normal | max`, default `normal`), `pace`
  (`frugal | balanced | fast`, default `balanced`), `ground`, `search_budget` (`--search-budget`, dollars per search; 0 none). Returns `{question, topics[{key,
  subtree, again}], ground, items[{id, topic, kind, state}], reused[], invalidated[], unrecorded[], passed[], context,
  risks[{topic, n}], history, docs, coverage}`: `context` is the path of the one file holding its
  digest, then every item it returns in full, the judges' risks and the history and docs searches'
  findings; an `again` topic is a stale candidate the plan adopted, searched again for its stale
  items; `passed` the stale candidates the plan left out; `history` and `docs` are `{status, hits}` — the
  channel search's status and its count of hits — or null when the plan asked no such question.
- **`probe`** — takes `artifact` (required), `roots` (default `.`), `context` (or `context_file`), `per_axis`,
  `since`, `intelligence` (`low | normal | max`, default `normal`), `search_budget` (as the survey's). Returns `{artifact, axes[{key, source}], analysts[[axis]], shared_ground{resolved, cited,
  files, excerpts, unresolved}, guidance_read, repo_ground{status, hits, unresolved}, refused[{prober, part, owner, file, bytes, budget, message}], units{total, ruled,
  open[]}, findings[{id, item, severity, axis, section, carried}], findings_file, ambiguities[],
  ratifiable, snapshot, scope{full, changed}, unrecorded[], review, coverage}`: `repo_ground.status`
  is the `locate` search's status (`''` for an unchanged round, which searches nothing, and `kept` for a
  narrowed round that searched nothing over its kept ground), `hits` its
  count of hits, and `unresolved` the path hits whose lines no file of the tree holds; `coverage.unreached` carries what each prober declared it never attacked
  (`not_reached`); `artifact` is the
  repo-relative path, or the absolute one for an artefact outside every checkout; a standing axis's
  `source` is `''`; `findings_file` holds every finding and every unit's ruling in full;
  `ambiguities` lists every open ambiguity, carried ones included; `snapshot` is empty when the
  round was not recorded or a finding was refused, so the next round is whole; when
  `coverage.complete` is false its loss is named in `units.open`, `coverage.failed_channels`,
  `coverage.incomplete`, `coverage.dropped` or `coverage.unreached`, which `approval.mjs reviewed
  --from-run` reads.
- **`solutions`** — takes `capability_file` (required), `roots` (default `.`), `constraints` (or
  `constraints_file`), `notes` (or `notes_file`), `max_angles` (default 4), `intelligence` (default `normal`), `search_budget` (as the survey's). Returns `{capability,
  constraints, summary, counts{present, candidates, viable, ruled_out, invented, lost, unanchored,
  unsettled}, measured, items[{id, topic, kind}], recorded, coverage}`.
- **`investigate`** — takes `question_file` (required), `roots` (default `.`), `notes` (or
  `notes_file`), `as_tasks`, `intelligence` (default `normal`), `pace` (default `balanced`). Returns `{question,
  mode: tasks | report, tasks: {summary, gaps[], tasks[{ref, subject, description, activeForm,
  blocked_by[]}]} | null, report: <text> | null, evidence{items, context, risks, history, docs},
  coverage}`: the survey's evidence is there whether or not the synthesis returned, `history` and
  `docs` as the survey gives them ([Investigations](#investigations)).
- **`rule`** — takes `effort` and `folder` (both required); its result is in
  [Changed-spec results](#changed-spec-results).
- **`drafts`** — takes `question_file` and `stances[]` (both required) and `intelligence`
  (default `normal`). Returns `{drafts[{stance, return, draft}], coverage}`: `return` names the
  recorded `approach` return and `draft` is the analyst's output; a stance whose analyst failed has
  `''` and null, one whose record failed `''` and its draft.
- **`review`** — takes `base` (a ref) and `criteria_file` (both required) and `prior` (a run).
  Reviews the working tree's change against `base`, snapshotted to a private ref
  (`refs/agentics/review/<run>`) so the user's tree is read and never touched
  ([The simple task](#the-simple-task)). Returns `{base, snapshot{ref, sha}, units[{unit, ruling:
  clean | findings, ids?, why}], findings, fix_rulings, approved, open[], next: approve | fix |
  escalate, reason, exit{open, unfixed, clean_streak}, coverage}`: `exit` is what a later run's
  `--prior` reads, and a unit the reviewer left unruled is incomplete.

### Run directory

- **Owner:** `launch` in `lib/run.mjs` (the claim, `run.json`, `result.json` and what it prints),
  over the paths in `lib/store.mjs` (`runHome`, `runDir`, `runJsonPath`, `heartPath`, `runLogPath`,
  `resultPath`, `runLogFile`), and `homeOf` in a program that names its home; read by `runState`
  in `lib/ledger.mjs` and `lib/status.mjs watch --run`, and outside this repository by
  agent-tree-viewer, which shows a run's sessions under its `session`.
- **Restated in:** the skills that start a program (they keep `run`, follow it and read
  `result_file`).

A run's home is `runs/<run>/`, or for an execution's run, `<effort>.<stamp>`, that execution's
directory (`runHome`), whose log is its `state.jsonl`. Its `run.json` is `{run, program, scope,
scope_key, args, args_digest, raw, session, pid, started_at, heartbeat_at}`: `args` the resolved
arguments, `raw` the flags as given, `scope_key` and `args_digest` the digests of `scope` and
`args`, and `session` the `CLAUDE_CODE_SESSION_ID` of the session that last started the run, `''`
when none did, which is what ties the run's headless sessions to the session that asked for them.
It is written whole when the run starts, `heartbeat_at` the start. Its `heart.jsonl` gets one
`{pid, heartbeat_at, loop_at}` line every 10 seconds while the run's process lives, appended by
`startHeart` in `lib/heart.mjs` and started afresh by each process's first beat; `runState` lays
the last whole line (`readBeat`) over `run.json` when it names `run.json`'s `pid`, so a missing heart
file, or one an earlier process of the run left, is no beat.
`result.json` is the program's result with `run` and `cost`.
A search keeps its files in `searches/<search key>/` (the key's `:` written `~`): `calls.jsonl`, the
call log; `server-<digest>.json`, the tool server's spec; `mcp-<digest>.json`, its MCP config
([Call log](#call-log)); `rulings/<turn>-<round>.md`, each ruler brief as it was dispatched; and
`pages/<fnv1a(key)>.json`, each fetched page's pinned body.
What `lib/run.mjs` prints: attached, `{ok: true, run, result_file, result}`; with `--detach`, at
once, `{ok: true, run, pid, log, result_file}`; refused, `{ok: false, error: {kind, message, run?,
pid?, log?}}`, a `run_live` naming the run already going; `{error}`, exiting 1, when the program
threw.

### Review returns

- **Owner:** `REVIEW` in `lib/schemas.mjs`; read by `leafReview` in
  `lib/boundaries/leaf-review.mjs` and `folderReview` in `lib/boundaries/integration.mjs` over
  `reviewExit` and `integrationPark` in `lib/verdict.mjs`.
- **Restated in:** `roles/reviewer.md`; `integrationBrief` in `lib/briefs/execute.mjs` (its Claims
  line).

`{units[{unit, ruling: clean | findings, ids[], why}], findings[{id, severity: critical | major |
minor, claim, evidence, failure_scenario, remedy?: code | tests | retire}], fix_rulings[{id, status: fixed |
not_fixed | regressed, evidence}], claims[{claim, ruling: met | equivalent | under | over |
deviates | spec_defect | cant_tell, evidence, failure_scenario, unit}], notes}` (`failure_scenario` is
`''` on every claim but a drift that names its failure; `unit` is the `claim:<n>` of the last
review's claim the entry restates, else `''`). The units are those the brief lists to rule — a
leaf review's criteria, changed files and failing approved cases, an integration review's decisions,
changed files, `spec` and the last review's claims — never one it lists as standing
([Review delta](#review-delta)); a unit with no ruling is open. A leaf review returns `claims: []`. `remedy` is who must change to fix a finding
— the implementation (`code`, read when absent) or the cycle's tests (`tests`) — or `retire`, a
test that should go or merge, which never blocks (`retires`); `remedyOf` in `lib/verdict.mjs` reads
it. A leaf review record keeps the round's `retire` findings as `retire[{claim, evidence}]`, which
`leafReview` hands a cycle's consolidation round, its `units` (those it was asked to rule) and its
`rulings[{unit, anchor, ruling}]` (each ruling that holds after it, [Review delta](#review-delta)); a
record without `rulings` leaves the next review whole.

### Planner returns

- **Owner:** the `planner_write` and `planner_settle` schemas in `lib/schemas.mjs`; `planOutcome`
  and `settleOutcome` in `lib/boundaries/spec.mjs`.
- **Restated in:** `roles/planner.md`.

Writing a spec: `{status: written | needs_decision | contract_changed | premise_mismatch |
unsplittable | blocked, text}`. Settling a review, in the same session: `{status: settled |
needs_decision | blocked, dispositions[{finding, outcome: incorporated | discarded}], text}`.
Answering a leaf's request, in the same session — `needs_context` delivered as its message, any
other (`decompose`, `unsplittable`, `premise_mismatch`, a verify leaf's
finding, a ruler's question) as a brief of its own — the spec edited and the writing return; the
edit goes through the autonomous review before the asker runs again.

### Ruler and investigator returns

- **Owner:** `rulingOutcome` in `lib/boundaries/integration.mjs` (the rulings); `convergenceRuling`
  in `lib/boundaries/leaf-review.mjs` (the convergence ruling); `judgeClose` in
  `lib/boundaries/judge.mjs` (the contention ruling); `recordCommands` in
  `lib/boundaries/leaf-close.mjs` (the commands).
- **Restated in:** `roles/ruler.md`; `roles/investigator.md`.

The ruler returns `{rulings[{node, ruling: unaffected | affected, why, question, fix?}]}`
(`ruler_premises`; a changed spec's ruling, `ruler_respec`, is under
[Changed-spec results](#changed-spec-results)), or, asked whether a loop converges, `{ruling:
converging | not_converging, why}` (`ruler_convergence`), or, at a merge, `{rulings[{unit, ruling:
serialize | resolve | replan | cant_rule, why, question?}]}` (`ruler_contention`, one per contended
leaf, or the one unit `integration` for a conflict, [The judge](#the-judge)).
The investigator returns
`{commands[], unresolved[], text}`, `commands` its `command` gotchas ([Gotcha file](#gotcha-file)),
which `recordCommands` writes as the investigator's.

---

## Self-checks

- **Lint** (`tools/lint.mjs`, one module per rule under `tools/rules/`) checks form: no turn or
  spend cap on a dispatch (L2; `no-turn-caps`, over `lib/programs/`, its `execute/` units and its
  `search/` modules, `lib/search/`, `lib/run.mjs`, every `SKILL.md` and every role file in
  `roles/`); no loop bound in a program or a search module except through `askAfter` (L2;
  `no-loop-bounds`, over `lib/programs/**`, `lib/search/` and `lib/run.mjs`; the tool server's
  `STALL_WINDOW` is a stall detector over the journal, no loop's bound); a
  coverage block on every program result (L1; the `coverage-block` rule requires every program file
  but `common.mjs` and `converge.mjs` to build its result in a `resultOf` with a `coverage` key that
  is not an empty object or null); no ruling fields in a producer's or searcher's schema, and
  required per-unit rulings in a judge's (L3; `no-self-verdict`, beside its ban on verdict-named
  booleans); no bound in a return schema (`no-schema-bounds`); role frontmatter (`role-frontmatter`:
  the file's own name and a role of `ROLE_NAMES`, a kind, tools, commands only beside `Bash`,
  schemas `lib/schemas.mjs` exports, a model and an effort of the tier tables, and no other key);
  prompts built only by `lib/brief.mjs`, `lib/briefs/` and `renderMessage`, so no command or path
  for a model to carry reaches one (P2; `prompt-origin`: in a program or a boundary, a `brief`,
  `threadBrief`, `prompt` or `charge` is never a string literal, a template literal or a concatenation,
  directly or through a name the file binds to one; an array's `.join(…)` of such values is not
  judged); only handles in a command a skill runs (P2; `skill-handles`) — and at run time every CLI
  a skill calls refuses an argument that is not a handle or a line of named free text
  (`handleArgs`); no skill that starts an agent (`no-skill-agents`: no skill names the host's Agent
  or Task tool, a `subagent_type`, or an `agentics:` name that is not a skill; `self-improve` alone
  starts its plugin fix agent); gate clauses in
  gated skills (`design-gate`); a stated task-tool fallback (`task-tool-fallback`); size budgets
  (`size-budget`); only `lib/store.mjs` starts git (`git-spawn`: no child-process call in `lib/` whose
  program is git elsewhere), so one environment and one count hold every git; and that nothing in `test/fast/` imports `child_process` or a helper from `test/`
  outside it (`fast-tier`).
- **The suite** runs through `tools/suite.mjs`: `node tools/suite.mjs` runs everything and `--fast`
  only `test/fast/`, the files that spawn no process, which finish in about a second. The fast tier
  runs under a preload (`test/fast/harness/no-spawn.mjs`) that makes every `child_process` call
  throw, so a test there that starts a process, directly or through `lib/`, fails;
  `test/fast-tier-spawns.test.mjs` runs the tier under it in every full run, and the `fast-tier`
  lint rule is the static half that catches the import. A failed run is repeated at
  `--test-concurrency=2` over only the tests that failed, and each first-run failure is named
  `flake` (it passed the repeat) or `red`; the exit code is 1 only for red. A lib CLI verb keeps one
  test that spawns it — the one that pins its argument parsing, exit code and printed line — and
  every other test of its module calls the function in-process; a test of logic private to the CLI
  keeps spawning it.
- **The scripted runner** (`test/fast/harness/scripted-runner.mjs`) stands in for the host: it is
  the real `runAgent` over a scripted CLI, each start of the CLI answered by the next step of a
  script keyed by role, node and thread, so a program run against real git
  (`test/harness/program-rig.mjs`, whose `executionRig` seeds an approved, compiled effort and an
  execution's home, log port and contexts for the execute program and its units) sees the records,
  stored returns, retries, long-return parts and renewals production does. It runs
  without the checkout watch and with no live process, so it never yields `checkout_changed`, a
  `checkout` or `watch_failed` cause, or an `orphan_ended` cut-off. It also stands in for the search
  server in the spawn-free tier: a step's `calls` are appended to the call log its call's MCP config
  names, numbered as the server numbers them.
  Every claim about dispatches, messages, records and resumes is an assertion against it, not prose.
- **The host contract** (`test/host-contract.test.mjs`, run when `AGENTICS_HOST=1`) runs the real
  host CLI on the cheapest model in a scratch repository and checks every behaviour the runner rests
  on: a return validated against its schema and carried by the stream's final event, a brief of 60
  KB on standard input beside 300 permission rules, `--effort` changing the thinking spent, a
  session resumed by id from another directory and on another model, a missing session refused as
  missing, a write outside the allowed paths and a compound command denied and reported, the usage
  figures present and a session's cost figure accumulating across its calls, a detached program
  outliving the session that started it, the transcript shape and the session variable
  `verifyAnswer` reads, a role that writes nothing reading and grepping its folder with no rule, its
  bare `Read` rule reaching a file outside the folder and its bare `WebFetch` rule the web (that one
  only when `AGENTICS_HOST_NET=1` as well), each without a denial under `dontAsk`, `--effort
  xhigh` accepted, and that a stdio MCP server named by `--mcp-config` is a session's only tools
  under `--tools ""`, serves a resumed session, sees every call and journals a `hit`, and that
`--max-budget-usd` stops a call at the cap and, on `--resume`, counts only that process. A host release that changes one of them fails here before it fails an execution.
- **Real git.** Every boundary, the role rules, the judge, the resume ladder, verification and landing are tested
  against real repositories and worktrees.
- **Pins:** verbatim blocks match across files (`test/fast/verbatim-blocks.test.mjs`); every role's
  tools and commands are pinned (`test/fast/role-allowlists.test.mjs`); every pointer into this
  document resolves and every law names its enforcement (`test/fast/design-doc.test.mjs`).
- **Liveness** (P4, `test/fast/liveness.test.mjs`): every role is dispatched by a program (named in
  `lib/programs/`); every record kind is written somewhere and read somewhere; every message kind
  has a route, a template its reader is given, and a program or a boundary that sends it; every
  field a role's schema asks for is read in `lib/` or, for a return a program hands back whole, in a
  skill; every lint rule has its test; every library export is used somewhere but a migration, which
  is frozen and keeps nothing alive ([Migrations](#migrations)).
  Defined-never-dispatched, written-never-read and read-never-written fail the suite.
- **Budgets:** each skill and role file has a size budget in `tools/budgets.json`; the
  `size-budget` lint rule fails a file over it, or one with no budget.
- **Cost:** every call's usage and cost are the host's own figures, recorded by the runner on
  `returned`; `lib/status.mjs cost` aggregates them per node, folder and effort, so triage quotes
  measured figures. A call that never returned is reported as unmeasured, never as zero.
- **Spend:** `lib/status.mjs spend` (`spendOf`) measures the same calls per unit of work — each
  leaf, each folder's design (its planner, surveys and probe rounds, `designPlace`, the one
  ownership test `designSpend` also uses) and each probe round — with their dispatches, rounds and
  dollars beside the mean of each kind in the effort and in the repository's earlier efforts (each
  whose first execution started before this one's), and the spend per role and model. Code flags
  the outliers (`flagSpend`): dollars or rounds above `OUTLIER_MULTIPLE` × a mean of their kind, a
  probe round with more probers than its folder's spec earns (`probersFor`), and a probe round past
  its folder's first that derived the axes again. A unit with an unmeasured call is never flagged on
  its dollars nor counted in a mean. The `self-improve` session judges each flag's cause; nothing
  here decides one. A spend nothing faults is otherwise invisible: a run doing too much of the right
  thing ends green, so without a measured view the only expectation a session holds is a guess.

---

## Migrations

A store is at the version its stamp says ([Store stamp](#store-stamp)), and each
`tools/migrate-to-<v>.mjs` brings a store at `v - 1` to `v`. Such a migration is a frozen copy: it
spells out the formats it reads and writes as they were, imports from `lib/` nothing whose meaning
a later change could move, and rewrites the records themselves, so the plugin reads the current
format alone and keeps no reader of an older one. Liveness counts no migration as a consumer
([Self-checks](#self-checks)). Each dry-runs by default, applies with `--yes`, writes the stamp last,
and does nothing to a store already at its version.

`tools/migrate-to-1.mjs` brings a store that predates the stamp to version 1. In each effort's
`events.jsonl` it drops every `withdrawn` event, every message one names and every message of a kind
version 1 has no template for, so a thread's messages are read as they stand. In each stored return
whose `unread` holds a line of text it types the line ([Producer returns](#producer-returns)): a
blank one is dropped, one that is a single path becomes `{kind: doc, path}`, any other `{kind: doc,
what}`. Every other line and file is kept byte for byte. It exits 1 for a store stamped past 1.

`tools/migrate-to-2.mjs` brings a store at version 1 to 2, which keys a regression net by its file's
blob ([Executors and review](#executors-and-review)). In each effort's `events.jsonl` it gives each
net of a `nets` event `blob`, its file's blob at the event's `head_sha`, and drops the event's
`all`, which version 2 derives from the measurement; in each execution's `journal.jsonl` it gives
each `discriminator` entry of a `verify-observed` line what it lacks of `blob`, its file's blob at
the line's `head_sha`, and `base_blob`, the same at its `base_sha` ([Verify
payload](#verify-payload)). A blob git cannot find, its commit gone, is `''`, which no measurement
matches: a net keyed so stands nowhere, and an approved leaf it covered is no longer named
`undiscriminated`. Its output lists each net and measured file it keys to no head blob
(`voided[{path, node, file}]`), the dry run included, so the user sees them before the store is
stamped. Each log is rewritten under its effort's lock, every other line kept byte for byte. It
exits 1 for a store at any version but 1 or 2.

The one-shots below predate the stamp and rewrite what a store's user must see or approve; each is
run on its own, before or after `migrate-to-1`.

`tools/migrate-design-cites.mjs`, run once after upgrading to the release where a task's `cites`
declares what its brief carries of the Design ([Spec format](#spec-format)), writes `cites:` on each
task where the prose reader of the time, kept frozen in the script, found a citation: a quoted
part, as `"<its heading>"`, or the word "Design", or a quoted passage inside the Design, as `Design`.
A task whose only "Design" opens a sentence ("Design the save format") was given the whole Design,
so it gets `cites: Design` too and is listed for the user to trim: a migration widens, never
narrows. Code then proves each task's brief carries the
same Design text from the new spec as from the old (`declare`); a declaration that would not is
refused and not written, and only a spec whose every brief is proved the same has its latest
`approved` or `prepared` line stated again at the new hash, every field kept and `carried_from`
naming the hash it was given at. A brief reads the spec as compile last kept it, so it then compiles
each effort compiled before in which it carried a signature; until that compile succeeds a carried
task's brief carries no Design. A carried folder with work dispatched below it is listed: that
compile reads the new hash as a change and parks it `spec_changed`. `provides` needs no rewrite: a
contract with no declared part is defined by the whole Design. It dry-runs by default, applies with
`--yes`, and a second run finds nothing to do; it exits 1 while a declaration or a carry is refused
or a compile failed.

`tools/migrate-contract-parks.mjs` clears the `contract_changed` parks an earlier version raised on
an edit that left the contract as it was, read with a frozen copy of the contract reader those parks
were raised under, so its meaning stays what it was whatever the live reader becomes.

`tools/migrate-glob-literal.mjs`, run once after upgrading to 5.5.0, reports on stored evidence
scopes now that the search glob dialect reads brackets literally; it writes nothing. Stored query
scopes are read in the new dialect as they stand. It lists each item whose stored query result
differs from what its scope finds now (`checkAnchors` derives it `suspect` and it goes to its
judge, whose `holds` records the fresh result through `recordJudgement`), each scope part naming a
literally bracketed file at HEAD, and each escaped-bracket part (`\[`) with the files `git ls-files
-- <part>` lists for it. It exits 1 only while a scope or a line is malformed.

---

## Keeping this document true

- A behaviour-changing change updates this document in the same commit series as the code. Role
  files and skill texts count as code here.
- It describes the present. No history, no increment numbers, no links to documents that no
  longer exist. Git has the history.
- `test/fast/design-doc.test.mjs` pins that every section has a body and every pointer into this
  document resolves; `test/fast/verbatim-blocks.test.mjs` pins the `severity-ladder` block above
  against its copy in `roles/reviewer.md`.
- `docs/superpowers/` is gitignored local scratch for planning sessions. Nothing in the repository
  may point into it.
