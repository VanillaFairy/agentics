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
| `lib/programs/` | The programs that orchestrate: an execution, a survey, a probe, a solutions sweep, an investigation, a ruling, approach drafts, an inline review (see [Programs](#programs)); the execution's units live in `lib/programs/execute/`. |
| `lib/briefs/` | The prompts the programs build, one file per program: the execution's (its reviewers, integration reviewers, rulers, planner and investigator; a leaf round's thread brief is `lib/brief.mjs`'s), the survey's, the probe's, the solutions sweep's, the drafts', the inline review's, the investigation's and a ruling's (see [Briefs and returns](#briefs-and-returns)). |
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
| `.agentics/config.json` | The project's settings, edited by the user (`max_parallel`, `max_agents`, `claude_cli`, `guidance`) |
| `.claude/worktrees/` | Integration and leaf worktrees, and the throwaway worktrees of an inline review and of an execution's investigator while they run |
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

Everything shows exactly how complete it is. An agent's return states what it covered and what
it did not reach, and "looked and found nothing" never merges with "never looked": a name that
resolves to nothing, a return that is not there, a unit nobody ruled on reads as absent or open,
never as empty or passed. Work is in one of three states: **in progress**; **escalated**, carrying
what was established, what was tried, what remains and how to resume; or **done**, every unit of
its intent traced to work and to a passing check ([Traceability](#traceability)). Nothing reads as
more complete than it is, and what stays incomplete leads every report.

*Enforced by:* `test/fast/schemas.test.mjs` (every searcher's and judge's return schema in
`lib/schemas.mjs` requires its coverage); the `coverage-block` lint rule (every program result
computes `complete` from its fields); `resolveHandle` in `lib/store.mjs`, the one way a CLI turns
an argument into a thing, which refuses an unknown one as `unknown_<kind>`; status derived on read
(P3); an integration branch holds no commit no record accounts for (`outside_work`: `unaccountedOf` in
`lib/integration.mjs`, which preflight reads before anything runs and the adopt check reports,
[Outside work](#outside-work)).

### L2 — States end work, counts don't

Work escalates on a state, never on a count. The states are three: a decision only the user can
make; a claim an independent ruling (L3) finds cannot be met as written; and no progress — the
same state again, or an independent ruling that a loop is not converging. A count may decide when
to ask; it never decides the answer. An external stop — a usage limit, a host error, a crash, the
user — leaves work in progress, resumed from the records.

*Enforced by:* the `no-turn-caps` lint rule (no turn or spend cap on a dispatch); the
`no-loop-bounds` lint rule (no loop in a program or `lib/run.mjs` that a counter ends — a condition,
or an `if` that leaves the loop, comparing a counter the loop increments to a number, a
SCREAMING_CASE name or a `max`/`limit`/`cap` name); the convergence predicates in `lib/verdict.mjs`,
which compare states; `askAfter` in `lib/programs/converge.mjs`, which schedules a convergence
ruling; the runner's classification of host failures as stops ([Host stops](#host-stops)).

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
blocking.

**Why:** an agent that certifies its own work is the examinee marking the exam, and an empty list
of findings from a reader who looked at nothing is not a pass.

### L4 — The user owns decisions and their branch

The user is the only author of design decisions; an unanswered recommendation is not adopted, and
no replan may alter a decision the user made. The user answers a question once: what they chose is
recorded in their own words, and a choice they made is never put to them again. Only the user gives
a spec its first approval; a later change to an approved spec is approved without a further act of
theirs only when an independent ruling finds that everything it moves either is not moved at all or
is settled by an answer they recorded ([A changed spec](#a-changed-spec)). The user's branch and
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
its worktree, its paths and its commands, and its watch on the user's checkout
([The agent runner](#the-agent-runner)); `lib/verify.mjs`, which refuses to run outside
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
(`survey --prior-file`, `--question-file`, `--criteria-file`, …), never as a flag's value.

**Why:** a model that retypes bytes is slow, costly and lossy in proportion to their length, and
a checksum over what it typed only turns the loss into a retry.

### P3 — State is derived; records are written as things happen

The status of a node, an execution or an effort is computed from append-only records and git on
every read; no status is stored and nothing trusts a rendered one. A record is written by the code
that ran or received the action, when the action completes, and records are ordered by a `seq` the
ledger mints, never by a clock. Resume names the single next undone action per node, trusting a
stage only where the record and git agree. What a session learns about a node is a `noted` record
like any other, and no status is derived from it.

**Why:** a record written after the fact by someone else leaves a window where work exists and
nothing says so; a status written down outlives what it described.

### P4 — Everything earns its place

Every mechanism — a stage, a dispatch, a role, a model tier, a field, a record kind, a check —
names the property that earns it and the consumer that reads it, and goes when its consumer goes.

- **Leanness is legible.** Whatever ran says what earned it; whatever did not run is stated. Cost
  is reported measured, never as a projected constant.
- **Leanness never touches verdicts.** What shrinks is dispatches, tiers and phases; the
  predicates a verdict is computed from never shrink once a check runs.
- **No mechanism outlives its consumer.** A format change ships a one-shot migration, never a
  permanent second reader. `test/fast/liveness.test.mjs` enforces it ([Self-checks](#self-checks)).

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
  across the effort.
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
- **claim ruling**: `met`; `under`, `over` or `deviates` (drift); `spec_defect` (the claim can't
  be met as written); `cant_tell` (the evidence doesn't decide it, and it is never a pass).
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
class, where they live. **And three rules for specs:** no status goes into a spec and no render is
edited by hand; one writer per folder at a time, under the effort lock; when an effort changes
what the project's docs describe, its plan carries the entry that updates them.
<!-- /agentics:verbatim -->

---

## Runtime

### The process model

```
user ⇄ session ── skills: design, develop, task, investigate, challenge-idea, next
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
`dispatchJudge` over the runner, `deliver` for messages, `searchRounds` for continued searches,
`step` for side effects and `coverageOf` for the coverage block, beside `askAfter`
(`lib/programs/converge.mjs`) for convergence rulings. A program run keeps at most `max_agents`
agent calls open at once (`.agentics/config.json`, default 6), beside the slot pool that bounds
leaves ([Scheduling](#scheduling)). A program nested in another — an investigation runs its survey
— shares the run's context: one log, one `max_agents` bound, one result. Nested in an execution —
a folder's survey, the probe rounds of its autonomous review — it runs `scoped` (`scoped` in
`lib/programs/common.mjs`): every thread name and step key it mints carries its unit's prefix
(`survey:<folder>/`, `probe:<folder>:<n>/`), so two folders' nested runs never share a thread or a
step.

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
| `file` | a path, absolute or from the working directory | the absolute path of an existing file, and its text — `\r\n` read as `\n`, trimmed — under the name the program asks for, so a file's line endings never change a run's arguments or its scope |
| `text` | a string | the string; its `<name>_file` twin (a `file` argument whose `as` names it) gives it from a file, and giving both is `bad_arg` |
| `list` | `a,b,c` | the entries, trimmed, empty ones dropped |
| `int` | digits | a non-negative integer |
| `bool` | the flag alone | `true`; absent, `false` |
| `enum` | one of the program's values | that value |
| `effort`, `folder`, `run` | a name | the name, once `resolveHandle` finds it (a folder inside the `effort` argument) |
| `ref` | a ref or a sha | the commit's sha, read in `--root` |

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
stopped one whose current run recorded nothing since its `run` line refuses `launch_failed`;
otherwise the run starts there with the arguments it was given, whatever an earlier run of it was
given, and `run.json` is rewritten. A run is live while the pid in its `run.json` is alive and its
heartbeat fresh ([Detached runs](#detached-runs)). The scope is what a second start is refused
over:

| program | scope | threads (roles) |
|---|---|---|
| `execute` | the effort and the folder | `producer:<leaf>` (implementer or test-author; a cycle's test rounds on `producer:<red>`), `auditor:<leaf>` (auditor), `reviewer:<leaf>:<n>` and `integration:<folder>:<n>` (reviewer), `planner:<folder>` (planner), `ruler:drift:<target key>:<pre8>` and `ruler:stale:<base head>` (ruler), `ruler:converge:<leaf>:<n>` (ruler, the convergence ruling after a leaf's review round `n`), `investigator` (investigator), and its nested runs' own under `survey:<folder>/` and `probe:<folder>:<n>/` |
| `survey` | the question's digest, the roots, the ground | `plan` (analyst), `scout:<topic>` and `common` (scout), `history` (historian), `docs` (doc-researcher), `judge:<n>` and `rejudge:<n>` (analyst) |
| `probe` | the artefact, by its absolute path | `locate` (scout), `axes` (analyst), `prober:<n>` (analyst) |
| `solutions` | the capability's digest | `frame` (analyst), `research:<angle>` (doc-researcher), `repo` (scout), `assess` (analyst) |
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
is safe to repeat.

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

`runAgent({dispatch, node, round, thread, role, cwd, brief, freshBrief, briefDigest, briefParts,
tier: {model, effort}, permissions, schema, carries, dir, resume}) → {status: returned | stopped |
failed, cause, until, output, usage, cost_usd, denials[], session, checkout, message}`

It spawns the host's CLI, `claude -p`, without a shell, and owns every flag:

| what | how | why |
|---|---|---|
| the role | `--system-prompt-file` with the body of `roles/<role>.md`, written once under the run's directory as `roles/<role>-<digest>.md` | the agent is told its role and nothing else |
| the brief | on standard input | a brief of any length reaches the agent whole; no command line holds it |
| its tools | `--tools` from the role's frontmatter | capability is the tool list |
| what it may touch | `--permission-mode dontAsk --permission-prompts none`; `--allowedTools` with the rules the program computes for this call: a role that writes nothing gets its read tools (`Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`) by their bare names and `Bash(<command>:*)` for each of its commands; a writer gets both `Edit(<path>)` and `Write(<path>)` for each path it may write, because the host's `Edit` rule admits the Write tool and its `Write` rule does not (a path is a gitignore-style pattern, so its glob characters are escaped and a root-level name is anchored with a leading `/`); `--disallowedTools` for paths another unmerged leaf holds, for the files a call must not read ([Conversations](#conversations)), and, when the role runs commands, for the git options that reach past a worktree (`--amend`, `-C`, `--git-dir`, `--work-tree`, `--output`); `--amend` and `--output` are matched wherever they stand in the command, so a command that only quotes one is denied too | nothing prompts; what is not allowed is denied, and every denial comes back in `denials`. A compound command is matched whole, so `git status && …` is denied under a `git status` rule |
| settings | `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands` | nobody's settings, MCP servers, skills or `CLAUDE.md` reach a dispatch; the guidance it needs is in its brief ([Briefs and returns](#briefs-and-returns)) |
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
session, brief_digest, brief_parts, carries[], pid}` is appended when the CLI starts — with `pid` 0
when no CLI started (its spawn failed, or the watch's read before the call failed), so every call
reads as started — `carries` naming the messages the call delivers
([Conversations](#conversations)), `brief_digest` the digest of the thread's brief on every call of
the dispatch (its first, a schema retry, each continuation part and a renewal), and `brief_parts`
the digest of each section of that brief by its heading, which only an execution's leaf rounds
give (`{}` on every other call).
When it ends, the runner appends `returned {dispatch, session, status, cause, usage, cost_total,
cost_usd, denials}` — a host stop records `host_stop` instead ([Host stops](#host-stops)) —
`status` `returned`, `part`, `failed` or `cut_off`, and `cause` naming why a call that did not
return failed or was cut off. A call that returned has its output written whole to
`returns/<dispatch>.json` first, so a `returned` line with status `returned` always has its whole
return on disk. Usage is
the host's own figure for that call; the host's cost figure (`cost_total`) accumulates over every
call of a session, so the runner records each call's cost as the difference from the session's
previous call. Cost is measured per call (P4). No agent writes a file that code reads, except the
work it was dispatched to do — a producer's edits in its worktree.

**One driver per session.** The host lets two processes drive one session at once and interleaves
their turns, so the runner keeps it to one: before a session is resumed, the runner makes sure no
earlier call on it is alive, by the `pid` on its `dispatched` line, and ends one that is — it is an
orphan of a program that died, and its session goes on only through the resume; the call it ended
is recorded `returned {status: cut_off, cause: orphan_ended}`. The process port reads a pid as
alive, and ends it, only when its image is the host CLI's executable (`hostProcess` in
`lib/host.mjs`), so a pid the system handed to another program after a crash is never killed. On
Windows such orphans are rare, since a call started without `detached` dies with the program that
started it.

**A session the host no longer holds** — the host's cleanup removed it (by default 30 days after
its last turn, `cleanupPeriodDays`; every resume renews it), or the thread began under 4.x —
refuses to resume (`No conversation found`). That is an observation, not a fault: the thread
goes on in a fresh session, briefed with the thread's brief and every message recorded on it.

**A session that grew too large is not resumed.** When the session's last returned call read more
than half of a 200 000-token window — its input, cache-read and cache-written tokens together
(`WINDOW` in `lib/runner.mjs`) — the thread goes on in a fresh session, briefed with the call's
fresh brief: the thread's brief and every message recorded on it, the open findings among them, in
a program and an execution alike. Either way the runner records
`thread_renewed {thread, gen, why}`, `why` being `too_large` or `session_missing`, and the thread's
next session id is minted from its new generation.

**A return too large for one response** says so (`more: true`); the runner resumes the same
session for the rest and stores the parts as one return. Each part is recorded `returned {status:
part}` and stored nowhere; the call that completes the return stores the merged whole and only then
records `returned`. A part that adds no array element the merged return lacks and changes no field
ends the call failed, `no_progress`. The parts so far are kept only in the session: the runner
holds them in memory, so a host stop or a relaunch between parts drops them, and the `cut_off`
resume asks the session for its whole return again, from the start. No return schema carries a
bound that would make an agent drop what does not fit (the `no-schema-bounds` lint rule).

**Denials are observations.** Every tool call the permissions refused is in `denials`. A producer
that needs a path it was denied returns `needs_locus` ([The locus](#the-locus)); a denial it did not
report is still on the record, and leaf-close reads it.

**The user's checkout is watched.** Before and after every call of a role that runs commands (one
with `Bash`), and every check, the runner reads the main checkout's `HEAD`, its branch refs and its
status. A moved `HEAD` or ref ends the call failed (`cause: checkout`), ahead of any host stop, and
is a fault naming the call ([Faults](#faults)); a changed working tree is recorded,
`checkout_changed {dispatch, paths}`, and shown, not a fault, because the user may be working in it
(a staged rename names its original path as well as its new one).
A watch that cannot read the checkout cannot vouch for it, so the call ends failed,
`watch_failed`: when the read before the call failed no CLI is started, and when the read after it
failed a completed return is kept on disk, a continuation part is kept nowhere and handed back as
no output, and the call still does not count as returned.

**Confinement and what it leaves.** An agent runs in its worktree, may edit only the paths it was
allowed and may run only its role's commands. An agent of a program run outside an execution runs
in the checkout the program reads (`--root`), the `review` program's reviewer in its throwaway
worktree, and none of them is allowed a path to write. Prevention ends where the repository's own
commands begin: a build or test script a producer runs is the project's code, and what it writes
outside the worktree is detected by the watch above, not prevented. The investigator, which has to
discover commands, runs any command in a throwaway worktree detached at the execution's base
(`.claude/worktrees/investigate-<effort>-<stamp>`, removed when its call ends), under the same
watch ([Roles](#roles)).

### Host stops

The runner classifies a call that failed. A usage or rate limit, an overloaded or unavailable host
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
| scout | searcher | find locations for a topic, as far as it judges there is anything to find | Read, Grep, Glob | — |
| historian | searcher | find when and why behaviour changed | Read, Grep, Bash | read-only git |
| doc-researcher | searcher | find what vendors and specifications say | WebSearch, WebFetch, Read | — |
| analyst | judge | judge what it is handed: plan a survey, judge evidence into items, re-judge suspect items, derive a review's axes, rule as a prober, frame and assess a solutions sweep, draft an approach from a stance, answer an investigation or turn it into tasks | Read | — |
| ruler | judge | rule whether a change moved a node's premise; rule whether a loop converges | Read | — |
| reviewer | judge | rule every unit of a span: findings with severity, a ruling per criterion, per file, per claim | Read, Grep, Glob, Bash | read-only git |
| auditor | judge | declare mutations an implementation's tests must catch | Read, Grep, Glob | — |
| planner | producer | write the spec of a folder develop owns, and settle its review | Read, Grep, Glob, Edit, Write | — |
| implementer | producer | code one leaf as a focused series, or a fix round of it | Read, Grep, Glob, Edit, Write, Bash | the established build, typecheck and test commands; `git add`, `git rm`, `git commit`, `git status`, `git diff`, `git log` |
| test-author | producer | write a leaf's or a cycle's tests and declare mutations | Read, Grep, Glob, Edit, Write | — |
| investigator | producer | establish build, typecheck and test commands when none are known | Read, Grep, Glob, Bash | any command, in a throwaway worktree |

A producer returns its status and its declarations; a searcher the facts it found (locations,
sources, what it searched) and its declared coverage; a judge a ruling per unit it was handed. A
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
in the sections `Task`, `Acceptance criteria`, `Decisions realised`, `Locus and reads`,
`Evidence`, `Gotchas`, `Measures`, `Commands`, `Worktree` and `Repository guidance`: the node, the
decisions it realises, its referenced evidence, the gotchas its role and locus call for, how its
rigor measures it, the established commands, its worktree, and the repository's guidance — its
`CLAUDE.md` files from the root to each directory the locus touches, and the files
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
not found. Nothing else in a program builds a prompt; a message it sends is `renderMessage`'s.

An agent's return is the JSON its role's schema states (`lib/schemas.mjs`), validated by the host
and stored by the runner. A producer returns its status (`done`, `done_with_concerns`, `blocked`,
`needs_context`, `needs_tests`, `needs_locus`, `declined` — the cycle's test session's alone — or a
[replanning return](#replanning)) with what it established, tried and needs as text in the same
return; with its gotchas, the mutations it declares and its concerns. A status is the only way a
producer asks for anything ([Conversations](#conversations)). A searcher returns its locations or
sources, what it searched, `no_match`, `not_reached` and its `stop_reason`. A judge returns its
rulings, one per unit, and its findings; an auditor, the mutations it declares and a ruling per
unit, with no status. A program reads the stored return, and nothing reads an agent's word from
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
| `failures` | code: a measurement of the leaf's round (`source: verification`), or a merged head the leaf fails alone on (`source: integration`) | the leaf's producer session; a verification failure on a green or an audit goes to the session the records name ([Rigor](#rigor)) | a fix round |
| `findings`, remedy `tests`; `surviving_mutations` | a green's reviewer; an audit's measurement (code) | the cycle's test session (the red's test author) | tests added, or `declined` with why |
| `needs_tests` | a green's implementer, as its status | the cycle's test session | tests added, or `declined` with why |
| `tests_ready` | code, once the test round is measured | the green's implementer session | a round against the new tests |
| `declined` | the cycle's test session, declining an implementer's `needs_tests` | that implementer's session | a round without the tests, or `blocked` |
| `needs_context` | a producer, as its status | the folder's planner session when the planner wrote the folder; otherwise the node parks for the user | a spec edit, checked, probed and prepared like any; the asker then receives `brief_changed` |
| `needs_locus` | a producer, as its status; or code, when the head with the round's stray paths passed and the head without them fails | the folder's planner session when the planner wrote the folder; otherwise the node parks `needs_respec` for the user, naming the paths | a spec edit widening the locus, admitted where no unmerged leaf holds the paths |
| `brief_changed` | code, when a thread's brief no longer matches the records | the thread's session | the work goes on against the new brief, told what changed |
| `retried` | code, when the user's `retry` cleared a leaf's stop after a round this execution dispatched on the thread | the thread's session | the round goes on from where its series stands, told the cleared reason and the text of each note left on the leaf since the stop or the thread's latest return, whichever is later |
| `notes` | code, on a new round of a thread this execution never dispatched | the thread's session | the round goes on, told the text of every note left on the leaf since the latest dispatch of any execution on it, the notes no session of it has seen |
| `findings` of a probe | the autonomous review | the planner session that wrote the spec | dispositions |
| `problems` | the spec check (code) | the planner session that wrote the spec | a corrected spec |
| `refusals` | the evidence recorder, settling a probe's findings, or settling a changed spec (code) | the thread whose return was refused: the judge's session for items, the planner's for dispositions, the ruler's for rulings | corrected items, dispositions or rulings |
| `continue_search` | code, when `roundOf` reads a search round as unfinished | the searcher's own session | the search's next round ([Continued searches](#continued-searches)) |
| `cut_off` | code, for a call started and never returned, or one a host stop cut short | the thread's session | the turn finished and its whole structured output returned, from the start |

- **Recorded before delivered, delivered once.** `message {node, thread, from, msg, payload,
  round}` is recorded before the recipient is resumed — by the boundary that decided it, before it
  returns, once per node, thread, round and `msg` — and the call that delivers it names it in
  `carries`. In an execution it is a node event naming its execution; one recorded with an empty
  execution (only the migration writes one) is delivered by the next execution that runs its
  thread. A declined request that was not an implementer's `needs_tests` is no message: sending
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
  cycle's tests: it works from the criteria, its own tests, the failures and the signatures.
- **A test session only strengthens.** In every test round after the red is approved, the red's
  approved version of each approved test file the round changed runs against the green head; an
  approved case that fails there blocks, unless a fresh reviewer rules that case wrong, one unit per
  such case. The series check flags a test case removed from an approved test file
  (`test-removed`).
- **Context that failed once is not trusted twice.** A fix round resumes the producer's session.
  After a round that cleared none of its blockers — a review that answered prior blockers and ruled
  none of them `fixed`, or a measurement in which every failure of the round before fails again —
  the next round is a fresh session on the raised tier ([Model tier](#model-tier)), recorded
  `thread_renewed {why: raised}`, handed the thread's brief and every message on it.
- **A conversation ends on a state (L2):** the same open findings after a round, the same request
  declined and sent again, or a convergence ruling `askAfter` asked for.
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
change raised, a choice at the Grill that moves a spec compiled before — is answered once, in the
user's own words, and kept. `lib/answers.mjs ask --effort <e> [--node <id>…]` opens it: an `asked`
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
child's pid into `run.json` inside the claim, and prints `{run, pid, log, result_file}` at once.
`lib/status.mjs watch --run <run>` prints a line for every `host_stop` and `fault` recorded after
the `seq` its `--since <seq>` names (a non-negative safe integer; any other is refused), or after it
began when it is given none (`host_stop <dispatch>: <cause> until <until or ->`, `fault <channel>:
<detail>`); on an execution's run (`<effort>.<stamp>`) it also prints each `escalated` or `parked`
event of the execution that is still its node's open stop when the watch reads it (`<id> escalated
<reason>`, `<id> parked <return>`); then `ended <status>: complete=<bool> result=<file>` at the
run's end — the `ended` after the run's latest `run` line, wherever it stands against `--since`, and
on an execution's run only one whose `seq` is above the `--since` given, so a relaunch whose child
has not yet appended its `run` line is not ended by the previous run's `ended` — or `stopped: start
the same command again to resume run <run>` when the run reads stopped. The session's monitor shows
each line as it comes. A program run's monitor passes `--since 0`, so a fault recorded before the
watch began, or between two of its re-arms, is printed all the same: the run's log is its own. An
execution's log spans every run of it, so develop's watch passes the effort's `seq` it read before
the start instead ([Progress](#progress)); a re-armed watch prints again a line that still stands. A
run is alive while its pid lives and its heartbeat — `heartbeat_at` in `run.json`, rewritten every
10 seconds — is fresh, written within the last 120 seconds, longer than any lock wait or git call
stalls the loop; one without `ended` whose pid is gone or whose heartbeat went stale shows as
stopped, and starting the same command again resumes it. A run started with `detached` outlives both
a headless session's exit and a background session's stop, and the host's own job does not kill it
on close; one started without `detached` dies with the process that started it. Nothing depends on
survival all the same: resuming from the records costs one relaunch. A relaunch that finds nothing
recorded since the previous `run` started, and a run whose process never started, are a fault
(`launch_failed`), recorded with `ended {status: launch_failed}`: a plugin fault, which the session
starts once more and reports as a plugin defect when it comes again ([Skills](#skills)).

A dispatch with `dispatched` and no `returned` is resumed in its own session ([The agent
runner](#the-agent-runner)), with a fixed message saying it was cut off (`cut_off`); whatever it
did is in its session and its worktree. In an execution, when its brief's digest no longer matches
what the records now brief, the message is `brief_changed` instead
([Conversations](#conversations)). The evidence programs send no `brief_changed`: the claim resumes
only a run whose arguments match, so a relaunch replays a returned call and resumes a cut-off one
with `cut_off` even when the brief it would build now differs.

### Faults

A plugin fault is never the user's decision. A fault is recorded where it is known, as
`fault {node, channel, detail}`: `program` (a program threw, or a unit of an execution did, on that
unit's node), `role` (a return that failed its schema the same way twice, a dispatch that returned
nothing, a leaf a ruler on a moved base did not rule), `host_error` (a failure the runner could not
classify), `checkout` (the user's `HEAD` or a branch ref moved during a call or a check, or the
watch could not read the checkout: `watch_failed`, whose kept return is not read and whose call
the next run resumes), `launch_failed` (a run that recorded nothing since it last started, or whose
process never started). A fault in a run outside an execution names no node, and such a run
records only `program` and `launch_failed`: a call of its that failed — a moved ref, a schema
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
`landed`, `claims`, `noted`, `message`, `outside`. A leaf's status is, first match: `merged`; `escalated` or
`parked` when newer than its last replan and last revision (a replan or the user's answer clears
it); `approved` when newer than its last dispatch (a held cycle member is approved and not merged);
`active` while a dispatch has nothing terminal after it; `planned`. A composite is `merged` on its
own event, the root `landed` on its, `escalated` or `parked` on its own open event (cleared like a
leaf's), and otherwise summarizes its children: once all have merged it is `reviewing` until its
integration review stands, then `integrated`. A review stands when the composite's latest `claims`
event is newer than its last clearing (a replan or a revision) and than every `merged` event beneath
it, since each merge moves the head the review judged, and than every `outside` event on the folder
or beneath it, which moves it the same way (`standingReview` in `lib/tree.mjs`). The
derived status also carries the composite's `review` — `pending` while `reviewing`, then the
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
  config.json                     {max_parallel, max_agents, claude_cli, guidance},
                                  edited by the user
  .state/
    seq, .lock                   the project-wide counter and mutex
    slots/                        the parallelism pool, shared by every execution (see Scheduling)
    runs/<run>/                   one program run outside an execution: run.json, state.jsonl with
                                  its seq and .lock, result.json, run.log (a detached child's
                                  output), returns/<dispatch>.json, live/, roles/ (the system
                                  prompts its calls ran with)
    runs/.claims/                 one short lock per program and scope, taken to claim a run
    evidence/                     the evidence item store
                                  ([Evidence item store](#evidence-item-store)): items.jsonl,
                                  returns/<stamp>[-<n>]-<kind>.json, snapshots/<hash>.txt
  <effort>/
    DESIGN.md                     the root folder's spec
    <sub-effort>/DESIGN.md        one folder per sub-effort, nested as the plan nests them
    .legacy/                      design documents the migration copied
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
                                  execution.json, run.json, state.jsonl, journal.jsonl,
                                  result.json, run.log, returns/, live/, roles/, closes/,
                                  reviews/, merges/, gates/, stale-<head>.md and .json
      locks/                      locus and branch locks
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
edited since approval is left out, and develop keeps the last approved graph. When a spec is
approved again with other text, compile parks every consumer of a contract it provides
(`contract_changed`), gives every node realising a changed decision a `decision_changed`
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
back to the ruler's session as a `refusals` message, until a refusal repeats.

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
edited; one whose parent spec is edited waits for the parent; a planner's spec is re-derived.

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
parent since the cut is in the tree the leaf is measured on. The refresh merge is not the leaf's
work, and the series check leaves it out. A cycle member takes its parent only at the cut, with
the merge as its base: it is cut from its predecessor's head, which the parent does not hold, so a
later refresh would count its predecessor's commits as its own.

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
- **Locus locks** are effort-wide: a leaf takes a lock on every file of its locus at leaf-open and
  releases it at merge, so leaves in different executions cannot write the same file unordered.
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

A passing check reports what the user should see before answering: `outside_locus` (files an
adopted leaf's commits touched that its locus does not admit), `clears_stops` (an adopted leaf that
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

### Atomicity: when to stop splitting

A **leaf** is the smallest unit of work: one commit series, or — for a `verify` leaf, which writes
nothing — one recorded check. A node is a leaf when **every** condition holds, and is split while
any fails:

1. **One concern.** Its change can be stated as one commit subject without a conjunction.
2. **One rigor and one role.** A single [rigor](#rigor) applies to all of it, and it is authored
   by one agent role.
3. **Closed locus.** Every file it writes is one its locus admits ([The locus](#the-locus)), and no
   file its locus lists is held by another leaf that is not yet merged (otherwise the two are
   ordered by a dependency, or the file goes to the [coupled lane](#coupled-work)).
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
checkpoint commit (the `agentics-checkpoint` trailer), and its session is resumed where it stopped,
so an interruption costs at most the turn it cut off, whatever the leaf's size.

**Why:** the leaf is the recovery grain, the review grain (one reader judges it whole) and the
parallelism grain (disjoint loci run side by side). All three want the smallest unit that is still
independently correct.

### Replanning

A leaf's producer or a planner returns one of these instead of finishing; a ruler's `affected`
([Landing and drift](#landing-and-drift)) is handled as a `premise_mismatch`:

| return | meaning | who acts |
|---|---|---|
| `decompose` | the task violates atomicity | the folder's planner, when it wrote the folder: it rewrites the folder's spec, the task split into entries that realise every decision it realised; a folder the user wrote parks the leaf `needs_respec` |
| `unsplittable` | no permitted split exists | the same: the planner widens the entry's locus or escalates; a folder the user wrote parks the leaf `needs_respec` |
| `premise_mismatch` | the brief's premise does not match the code | the same: the planner re-derives the entry; a folder the user wrote parks the leaf `needs_respec` |
| `needs_decision` | condition 6 failed | the user |
| `contract_changed` | a `provides` contract cannot hold as written | the user — a contract is a decision |
| `needs_locus` | the work needs a path its locus does not admit ([The locus](#the-locus)) | the planner proposes the widened locus when it wrote the folder, and lib admits it where no unmerged leaf holds the paths; a folder the user wrote parks `needs_respec` with the paths |

The planner answers a leaf's request in the folder's one planner session (`planner:<folder>`),
writing the folder's spec and nothing else: `needs_context` and `needs_locus` reach it as their
messages, any other request as a brief of its own. No planner writes a spec outside its own folder,
so a task is promoted only by a spec the user writes. The answer goes through the
[autonomous review](#autonomous-review) and is compiled; a replan that leaves the asking leaf at
the revision it asked from escalates `replan_not_converging`, and a request whose planning ends on
a fault is a `program` fault on the asking leaf as well. A verify task's finding replans its folder
the same way: the planner rewrites the folder's spec when the planner wrote it, and the folder
parks `needs_respec` for the user when the user did. Under a planner's folder the finding is the
route: leaf-close records no escalation of the leaf, so none outlives the planner's replan, and the
leaf is measured again against the folder as replanned. Under a folder the user wrote the leaf is
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
node whose entry sits in a spec the user approved; and a decision a leaf or a design node realised
before must be realised by one after, unless a `dropped` entry of a spec the user approved gave it
up. The planner returns `needs_decision` or `contract_changed` instead. Replans append
`replanned` events; nothing is rewritten, and merged work stays. A replan that leaves a leaf exactly
as it was escalates as `replan_not_converging` rather than sending the same executor back to the
same wall.

---

## Execution modes

| mode | earned when | what runs |
|---|---|---|
| **inline** | every leaf is `verify`, `trivial`, `tests-only` or `tdd`, the locus is known, the intent settled, nothing is irreversible, and the leaves' summed fit (condition 7's computation) is within the session model's budget | the session does it — see [The simple task](#the-simple-task) |
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
between `trivial` and `tdd`: `tdd`.

Unsure between `tdd` and `tdd-pair`: `tdd` when the leaf is small, `tdd-pair` when it is not.

- **`tdd-pair` and `tdd-triad` are separate leaves** with `deps` (green on red, audit on green),
  each with its own branch, todo, review and resume action. Green is cut from red's branch and
  receives red's committed tests as artifacts, never red's return. No agent authors both a
  behaviour's tests and its code. Red's locus is the test files and, where the repository's
  typecheck covers tests, the files green builds: red writes those as signatures whose bodies
  throw, so its tests compile and fail for want of the behaviour, and green fills the bodies in.
  What keeps red from implementing is the measurement — its tests must fail now — and what keeps
  green off the tests is its locus, enforced by its permissions and checked by the commit-series
  check.
- **A cycle lands as a unit.** Red is held on approval; its cycle merges together, through its
  tip, once the last member is approved, so the effort branch is never red.
- **Mutations are declarations.** A test-author or auditor declares `{file, find, replace,
  expect_failing}` in its return; leaf-close applies them in code and restores the file. A
  `find` matching zero or several times refuses, pointing at the declaration.
- **A mutation once applied is never dropped.** A leaf measured by its mutations (`tests-only`,
  `audit`) is measured, every round, on each mutation an earlier round of it applied, beside the
  round's own declarations (`heldMutations` in `lib/verdict.mjs`, from the journal), so a mutation
  its tests let through stays until a test catches it: a gap-closing test is shown to fail on the
  very break that found the gap. A declaration that could not be applied is not held: it is a
  defect in the declaration, not evidence about the tests. Other rigors apply their round's
  declarations alone, because their implementation moves and an old `find` with it. The mutations
  held, and the audit's gap below, are read from the leaf's `verify-observed` lines of every
  execution, as resume reads them (`journalsOf`). A measurement taken at the head before a
  revert (the parent of an `agentics: revert outside locus` commit) is never one of them: it
  judged a locus the breach had widened, and a mutation applied only to a file the revert took
  out can never be applied again.
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
    carried, then to the cycle's test session once only they remain. A test-author round is measured
    by the breaks it catches (the `green-tests` profile, [Verification](#verification)).
  - Either way the round writes the cycle's tests and nothing else (`cycleTestLocus` in
    `lib/tree.mjs`): the test files of the red's locus, and a new test file directly beside an
    entry of a member's locus — new meaning absent from the parent's integration head — that no
    unmerged leaf outside the cycle holds; never a source file, and never at the cost of a test the
    cycle approved (`test-removed`). Its permissions admit only that; leaf-close commits only what
    it admits, journals the commit as `authored`, and the series check holds each such commit to it
    and every other commit to the leaf's own locus, so neither producer writes the other's files.
- **Review follows rigor.** `tdd-pair`, `tdd-triad` and any leaf that `provides` a contract get a
  review loop of their own; `trivial`, `tests-only` and `tdd` leaves are reviewed at integration;
  `verify` leaves write nothing to review.
- **A fix round** goes to the leaf's producer, its session resumed with the findings
  ([Conversations](#conversations)): on a green or an audit, to whichever the records name above;
  on any other leaf, to its one producer, which owns its tests and its code. After a round that
  cleared none of its blockers, the next is a fresh session on the raised tier.

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
| Analyze | write back the understanding; survey this layer's question, and search for existing solutions when it would build a capability, the two programs side by side; cite every item their runs returned in one `lib/evidence.mjs cite --from-run` | the user confirms or corrects the understanding |
| Grill | one question at a time, recommendation first; each answer is a Decisions row at once; a cheap choice nothing consumes is defaulted and ruled with the rest at Review; approach drafts when the decision space is open, from the `drafts` program, each recorded as it returns | no `blocking` question is open |
| Draft | Design and Plan at this layer's level of detail, shown section by section | `lib/spec.mjs check` passes; no decision is unrealised |
| Review | the `probe` program when earned (by length, or a contract other entries consume); a second round, earned by a resolution that reshaped the design, narrowed by `--since`, the previous round's snapshot, and the whole spec probed again for what a partial round left; every round recorded from its run (`lib/approval.mjs reviewed --from-run`); its findings settled with the user, incorporated or discarded, each a recorded disposition; then the user reads the spec | `lib/approval.mjs gate` ratifiable, or the review not earned; and the user's answer chose `Approve` |
| Approve | a spec never compiled: `lib/approval.mjs approve`, which confirms the user's answer, then `lib/compile.mjs`; a spec compiled before: the `rule` program, which approves the change by ruling or hands back the questions the user must answer ([A changed spec](#a-changed-spec)) | — |
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
  not a gap);
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
advisory). When a person drives it there is no fix loop: the probe reports and a human rules. The
one loop is the [autonomous review](#autonomous-review) of a planner-written spec. The ladder's and
the disposition's wording are the verbatim blocks `design-severity-ladder` and `probe-disposition`
in the `design` and `challenge-idea` skills; every prober's brief carries the ladder word for word
from `lib/briefs/probe.mjs`, which `test/program-probe.test.mjs` holds to the design skill's block.

**The units of a probe** are each axis it attacks against each section of the artefact in scope, the
sections being its `##` headings outside fenced blocks (as CommonMark reads both: a backtick line
whose info string holds a backtick opens no fence, and a heading's closing `#` run is not part of
its title): the lines before the first heading are a section of their own when they hold more than a
title, and a document with no such heading is one section. A prober is handed the snapshot's text,
line-numbered, in its prompt, and rules every unit it holds: findings, each with its severity,
claim, evidence and the artefact lines it rests on, or `clean` with a line of why. A ruling counts
only for a unit its prober was handed, and a prober is no searcher: it is never continued.
`ratifiable` is computed: the coverage complete — every unit in scope ruled, no channel failed, the
locating search done — and no ambiguity open. A unit nobody ruled on is open, so a prober that
skipped a section leaves the review unratifiable, never quietly passed (L1, L3).

Findings are evidence items too. The program first snapshots the artefact (`reviewScope`), and
each new finding is recorded as a `behaviour` item anchored to its lines in that snapshot. Given
`since` — the snapshot the last review judged — the probe attacks only the lines changed since, its
units narrowed to the sections those lines fall in, and carries forward every earlier finding whose
lines no hunk touched, in the probers' prompts and in the round's record: the same anchor check as
all other evidence, with no mechanism of its own. An earlier `clean` ruling is not carried: the
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
them apart. One analyst holds every axis as a checklist; more are bought when the lines attacked are
many enough (one per 400; a narrowed round counts its changed lines alone) or the checklist is (one
per 12 axes), whichever buys more, never more than one per axis, the axes dealt round-robin;
`--per-axis` buys one per axis. A second round is earned only by a resolution that reshaped the
design.

The coverage names what the probe could not do. The locating search is declared (`locate`) when it
was exhausted and incomplete when it ended short. A locating search that returned no round fails
`repo-axes` and `repo-ground`, and the standing axes probe the artefact and its own citations
alone; the axes analyst is bought only when the search located guidance, and one that failed or
could not read it fails `repo-axes`; a failed prober fails `probe`, its units open; an artefact
that cannot be snapshotted fails `record`. A round whose findings the store refused fails no
channel: its new findings are listed in `unrecorded`, and its snapshot is empty.

### What a probe costs

**The cost of a probe is turn count, not payload**: every turn re-sends the accumulated context,
and analysts that each locate the same lines pay for them once each. So the program resolves the
document's cited evidence once (`lib/citations.mjs`) and puts the excerpts in every prober's
prompt, and the head count is earned by the lines attacked and the checklist's size, never one
analyst per axis unless asked.

The Ground phase resolves three bodies of text once: the document's own citations and the located
repository ground, which go into every prober's prompt, and the located guidance, which goes to the
axes analyst alone. The located ground and guidance are excerpts from the locating scout's return,
filtered by the kind of hit, so the probers share one read of the ground.

### Autonomous review

A spec develop's planner writes (an `author: planner` sub-effort, written first, or rewritten to
answer a leaf's request, a ruling or its own `spec_changed` park) goes ahead without the user's
approval, but only once an adversarial review passes. It runs inside the `execute` program, one
folder at a time, every planner round in the folder's one planner session (`planner:<folder>`),
which may write that folder's spec and nothing else. For a folder whose ground is unknown the
program first runs a survey (nested as `survey:<folder>`), and the planner's brief (`plannerBrief`
in `lib/briefs/execute.mjs`) carries the text of its context file. Each boundary's answer is
journaled as a `step` under the folder and the round, so a relaunch replays what was decided:

1. **Check.** The `spec-check` boundary closes the planner's dispatch — its write, or a settle that
   edited the spec, checked again before the next probe round (`settled` reads as `written`); a
   dispatch that returned nothing holds the folder on a `role` fault, and any other status parks
   the folder (`needs_decision`, `contract_changed`, `premise_mismatch`) or
   escalates it (`plan_<status>`) on the planner's return. It then parses the spec with its
   ancestors' decisions in view. A Decisions row parks the folder `needs_decision`, because only
   the user states decisions; any other problem goes back to the planner's session as a `problems`
   message, and the same problems again escalate `spec_refused`.
2. **Attack.** The `probe` program, nested as `probe:<folder>:<n>` (`n` the planner round it
   follows), reviews the spec. After the first round, `since` (the previous
   round's snapshot) narrows the review to the spans changed since. `spec-reviewed` reads the
   round's result and records every round as a `reviewed` ledger line with the settlement ids of
   its ambiguities; one that left a unit unruled escalates `review_incomplete`. A round a prober's
   role fault cut short records nothing and holds the folder on that fault. The findings still to
   settle are the ones no disposition on the ledger has settled: a finding the probe carries from an
   earlier round stays settled.
3. **Settle.** The planner's session, resumed with the findings, gives every finding still to
   settle a disposition in its return: incorporated (the spec changed) or discarded. `spec-settle`
   reads it: an `ambiguity` or a `gap` can only be incorporated, so a discard of one, or a finding
   left out, is refused and goes back to the planner's session; the same discard refused again
   escalates `review_not_converging`. An ambiguity counts as incorporated only when the edit touched
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
   `replan_not_converging`. A leaf whose locus the compile widened onto paths another unmerged leaf
   holds escalates `locus_held` on that leaf, its new revision kept. A `spec_changed` park the
   compile raised on the folder itself is cleared at once (`replanned {reason: spec_rederived}`).

A park or an escalation stops only that folder; develop keeps running whatever does not depend on
it. A `spec_changed` park on a folder the planner wrote goes back to the planner, which re-derives
it through these same steps; its preparation clears the park its own compile raises. The same
park on a folder the user wrote waits for the user; a change ruled to move nothing never raises it
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

Every agent whose findings become evidence — a survey's planner, scouts, historian,
doc-researcher and judges; a probe's locating scout and probers; a solutions sweep's framer,
researchers, repository scout and assessor; a re-judge — returns them in its return, in the shape
its role's schema states, and the runner stores it ([Briefs and returns](#briefs-and-returns)). The
program maps what was returned to items in-process, deterministically: a judge's topic to its
subtree, a derived item's sibling claims to ids, a probe finding's lines into the snapshot, a
candidate to an `external` item. Free text the caller supplied — a survey's question, a sweep's
capability — is the program's own argument, written by the session that authored it, and reaches
every prompt from there.

### Continued searches

A searching agent — a survey's scouts, historian and doc-researcher, a probe's locating scout, a
solutions sweep's researchers and repository scan — declares its coverage in its return:
`stop_reason`, `not_reached`, `no_match` and what it searched. After each round `roundOf` reads the
stored returns and decides what runs next:

- `done` when the round says `exhausted`: the searcher declares it found what there is;
- `stop` with `dead_end` when it says `artefact_unreadable`, or `stuck` without naming a remainder;
- `stop` with `no_progress` when the round found no entry no earlier round holds (a location by
  path and line, a candidate by name) and named the same remainder as the round before, case and
  spacing aside;
- `continue` otherwise.

A round read as `continue` — `unfinished`, `stuck` naming a remainder, any other stop reason or
none — is continued in the searcher's own session, with a fixed message (`continue_search`, naming
what the round said it did not reach): its earlier rounds are in its session, so it covers what the
original request asks that it has not, and reports only what it did not report before. A slip in
filling one field costs one more turn, never the search, and a round after the first that gains
nothing and names the same remainder ends it.

These are declarations, and they steer: they decide whether a searcher is asked again, never
whether anything passes (L3). A search's coverage is shown as declared, in the coverage block and
in every report that rests on it; where a verdict needs to know that something was examined, a
judge rules it unit by unit ([Probe](#probe), [Executors and review](#executors-and-review)).
`entries_n` and `kinds` count the distinct locations across the rounds: a survey topic's
`entries_n` weighs it when judges are dealt, and in a probe a `guidance` entry buys the axes
analyst and the `ground` count is reported as `repo_ground.located`.

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
source's retrieval date is the recorder's own. A batch with one refused item is refused whole, so
nothing unanchored enters the pool: a survey judge's refused items go back to that judge
([Survey](#survey)), and a probe round or a sweep whose batch is refused records nothing
([Probe](#probe), [Existing solutions](#existing-solutions)). An item's id is its question, topic
and claim; a new revision of the same claim is appended, and the latest by `seq` wins.

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
2. **Re-judge.** Suspect items go, up to twenty per call, to an analyst on `haiku`, each claim and
   each changed anchor's old and new text in its prompt. It returns a ruling per id, and
   `recordRulings` records one per id it was handed: an id with no ruling, or one off the ladder, is
   `unsure`. `holds` re-anchors the item where the text now is; `fails` and `unsure` make it
   **stale**, because an unsure check is never a pass. This is the stated exception to the
   intelligence tier: the question is narrow, and any doubt routes to the full-tier survey, so being
   too cheap can cost money but never correctness. Whether text changed is always the diff's call;
   the model rules only on whether the change matters.
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

The `survey` program gathers evidence for one question and never concludes.

1. **Reuse.** When the caller names its `ground`, the program reads the items of earlier surveys
   whose ground overlaps it (`itemsFor`) into its own log as a `step` (`pool`), and again after the
   re-judge (`pool:after`) when any was suspect, so a relaunch sees what the run saw. Standing
   items become known ground; suspect ones are re-judged, twenty to a call, the calls side by side;
   stale ones, and any not standing after the re-judge, send their topic to be searched again,
   with what the topic used to claim in its scout's prompt — unless a newer standing item
   superseded them. A re-judge that fails records nothing, so its items' topics are searched again.
   A pool that cannot be read fails the `pool` channel, and nothing is reused; one that cannot be
   read again after the re-judge fails it too, and every item that was suspect has its topic
   searched again.
2. **Plan.** One analyst decomposes the question into topics, names each topic's subtree and the
   common ground, and is told what the pool already establishes and which topics are searched
   again regardless; it plans only what the pool leaves open, and returns the plan. A pool that
   answers the question buys no search. A plan that fails searches nothing and fails the `plan`
   channel, the topics due to be searched again named as dropped; the context still holds the
   standing items the run reused.
3. **Scout.** One scout per topic, the common ground scouted once, each handed its entry of the
   plan. Scouts return their locations with a note each, what they searched, `no_match`,
   `not_reached` and `stop_reason`, and are continued in their own sessions until `roundOf` reads a
   round as done or ending short ([Continued searches](#continued-searches)). History and docs
   channels run alongside when the plan asks, each failing alone.
4. **Excerpts.** Judges are dealt first: one analyst per 60 distinct locations the scouts found,
   the common ground's counted in, at least one and never more than one per topic; `pace: fast`
   buys one per topic. A topic weighs its scout's distinct locations, none when no round returned,
   and topics go heaviest first to the lightest judge, a tie to the judge holding fewer topics.
   Each judge holds its topics in topic order (the topics searched again first, then the plan's),
   and the judges are numbered (`judge:<n>`, from 1) in the order of each one's first topic. Then,
   per judge, `lib/citations.mjs` reads its topics' and the shared ground's scout returns once into
   one body of excerpts — every location with its note, what each scout covered and declared
   absent, and the lines they point at — which is the judge's prompt.
5. **Judge.** Each analyst, **without search tools**, returns items — one claim each, with the
   anchor its kind needs — risks, and a ruling per topic it holds, `anchored` or `unanchored`; a
   topic's latest ruling stands. A topic given neither items nor risks is dropped.
6. **Record.** The program records each judge's items (`recordSurvey`), all or none: while the
   judge's latest answer holds an item the store refuses, nothing is recorded, and the refused items
   go back to the judge's own session as a `refusals` message ([Conversations](#conversations)). A
   pass that refuses none records every item the store accepts — a correction in place of the item
   it corrects, a refused item the judge did not correct dropped — and a pass that refuses no fewer
   than the one before records nothing, so every topic the judge was given items for is listed in
   `unrecorded`. A judge is never continued as a searcher is: beyond the runner's own resumes
   within a dispatch, its session is resumed for its refusals alone.
7. **Context.** The program writes the survey's one file: every item it returns — the standing
   items over the caller's ground, this run's own among them where they overlap it, then every other
   item its records stored — with the judges' risks and the history and docs channels' returns. The
   session, or the planner's brief, reads it; the result lists the reused items first, then this
   run's, by topic.

Coverage is complete when every topic's search ended `done` and all its items stand; a topic's
completeness is the scouts' declaration, and the result says so: each searcher's stop is a declared
line (`topic <key>: <stop reason>`, with what it did not reach and whether it ended short). A topic
not dropped is incomplete when its search did not end `done`, its items went unrecorded, or it was
given items and its judge never ruled it or ruled it last as anything but `anchored`; `common` is
incomplete when the common-ground search did not end `done`, and `history` or `docs` when that
channel ended short. A scout, a judge or a channel that failed is an unreached line naming what it
cost, and a history or docs channel that failed is named in `failed_channels` as well.

### Existing solutions

The `solutions` program frames the capability, sends researchers out by angle and a scout through
the repository, has an assessor weigh the candidates against the frame, and records all of it
in-process (`recordSolutions`); lib decides what the returns mean. The researchers — one per angle
the frame names, up to `max_angles`, the rest named as dropped — and the repository scan are
continued searches ([Continued searches](#continued-searches)); a researcher's `no_match` is part of
what it declares, never a loss. The assessor is a judge sharing no session or thread with any
researcher, and its units are the candidate names the researchers reported, case aside: a name it
did not rule `assessed` leaves the sweep incomplete (`assess:<name>`). A frame that fails or names
no angle searches nothing and fails `frame`; a researcher that did not end `done` leaves
`find:<angle>` incomplete; the repository scan fails `repo` when it failed and leaves it incomplete
when it ended short; a failed assessor fails `assess`, and a record that failed fails `record`.
A candidate is viable when it hit
none of the frame's disqualifiers; a ground the frame never declared rules nothing out and is
named; a candidate a researcher reported and the assessment dropped is named as lost; without an
assessment the researchers' candidates are carried unmeasured, neither viable nor ruled out. A lost
candidate, a ground the frame never declared and notes the assessment left unsettled each add an
`unreached` line, so the sweep is not complete; the summary names each of them. Each
candidate with a source is recorded as an `external` item anchored at it, and each hit the
repository already carries as a `behaviour` item anchored at that line, and all of it goes into one
summary file the session reads. A record the store refuses costs no coverage. A sweep answers its
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
`paths` (locus prefixes it applies to), `observed_at` (commit) and `source` (node and role). The id
is minted by code from the normalised trigger, so the same trap recorded twice is one file. A
producer returns gotchas in its return, and leaf-close writes them. Brief assembly appends every
gotcha whose `roles` include the brief's role and whose `paths` (if any) overlap its locus. A gotcha
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
| **preflight** | refuse what cannot run — an effort it cannot read (`unreadable`), a folder that is no node (`no_such_node`), an effort root that is a leaf (`root_is_leaf`), an execution whose envelope names another root (`wrong_root`), and, writing a new envelope, a `base_ref` that names no commit (`no_base`) or a `commands_file` that is not readable JSON (`commands_unreadable`) — writing nothing; adopt or write the envelope (`execution.json`: base, dial, pace, and the commands the session wrote to `commands_file`); write the session's commands as command gotchas ([Gotchas](#gotchas)) — refusing `commands_unwritable`, naming each command the gotcha store refused, once the envelope is written, so a run again writes only what is missing; read every integration branch in scope for commits no record accounts for ([Outside work](#outside-work)), refusing `unreadable_branch` when git cannot read one; traceability; stop at `outside_work` before every other checkpoint, and never confirm past it, and then at a checkpoint not confirmed past ([Resume and checkpoints](#resume-and-checkpoints)), its lists (the overlapping executions, the gaps, the branches with their unaccounted commits) on its state line, for the session to read with `lib/status.mjs checkpoint`; on a resumed execution with no checkpoint, check whether the base moved under its leaves and write the ruler's brief and its record, and, with no checkpoint, write the brief on the drift of adopted records no ruling covers yet ([Landing and drift](#landing-and-drift)); free this execution's slots, its dead worktrees and merged leaves' worktrees (clean ones only — a dirty one is reported, never forced); find the dispatches a dead run left open, to resume in their sessions |
| **schedule** | compute what to launch from the records (`lib/schedule.mjs`, see [Scheduling](#scheduling)); park a folder the user writes that has nothing planned (`needs_design`); approve a leaf the resume ladder finds measured green, with no review loop of its own and no approval standing; what a pass records is recorded and the launch computed again, until a pass records nothing |
| **leaf-open** | acquire a slot and the locus locks, asked once (`no_slot` and `locus_held` go back to the program, which waits); ensure the parent's integration branch (lazily, refreshed from its own parent, each branch of the chain under its own lock in turn) and cut or attach the leaf's branch and worktree, brought up to that parent's head; compute the round — the round of a dispatch this execution started and never got back, else one past the latest; only a producer's or an auditor's dispatch is a round — its role from the records, its thread (resumed, fresh, or fresh on a raise, [Conversations](#conversations)), its tier and its permissions from the locus ([The locus](#the-locus)); build its thread brief; record `retried` when the round resumes a thread after the user's `retry` cleared the leaf's stop, and `notes` when the round starts a thread this execution never dispatched ([Conversations](#conversations)); a refusal escalates `open_refused` |
| **leaf-close** | first put right what a verify cut off in the worktree left ([Verification](#verification)); read the producer's stored return — a round closed again with no `dispatch`, over the work a retry measures first, has none to read and is measured as no producer's ([Resume and checkpoints](#resume-and-checkpoints)); none, or a producer's with no string `status`, holds the leaf on a `role` fault, and an auditor's, which carries no status, reads as `done`: a park, an escalation, a request for the planner (or the `needs_respec` park of a folder the user writes), a `needs_tests` or a `declined` for another session is recorded and routed without measuring; otherwise, a round that returned no commits included, commit a shell-less author's admitted files (`authored`) (a close cut off after that commit finds it in git and journals it), take what lies outside the locus out and record it ([The locus](#the-locus)); journal the series as `series-done`, from git, when the producer declared it done; measure by rigor — build, typecheck, its own tests, discriminator, declared mutations and named checks; write and delete the gotchas it returned, never a command one; compute the close decision and record it — the approval, the escalation, the next round's message (`failures`, `surviving_mutations`, `tests_ready`), a verify leaf's finding (the `needs_respec` park of a folder the user writes beside the leaf's escalation; under a planner's folder the finding is the route and the leaf is not escalated, [Replanning](#replanning)), `fix_without_commits`, carrying the measured failures, when an implementer's round sent the failures of the head it opened on returns that head unmoved and it still fails (`fixWithoutProgress` in `lib/verdict.mjs`), `verify_not_converging` when a fix repeats the close before it at a moved head; hand back `command_unknown` until an investigator of this execution has returned, and escalate it after; write the round's close record. What it reads of the rounds before spans executions, as a leaf's rounds do ([Resume and checkpoints](#resume-and-checkpoints)) |
| **leaf-review** | read the reviewer's stored rulings over the units its brief listed; compute the review loop's exit (`reviewExit`) against what the round before left open; record the approval or the escalation, or the open findings as `findings` messages, one per thread, for the next round; write the review record; after a review round `askAfter` picks that ended in a fix, read the ruler's stored convergence ruling (`convergenceRuling`): `not_converging` escalates `review_not_converging`, `said` the ruler's dispatch, `converging` records nothing, and a return with no ruling holds the leaf on a `role` fault; and, once the session retried a leaf its review loop stopped, record the stopping review's open findings as the next round's `findings` messages (`reviewResumed`) |
| **merge-batch** | under the branch lock, record `batch-started` with the head it starts from; merge every approved child into one integration branch in dependency order; verify the merged head with the fast suite; bisect a red one; append the `batch` state line first, then `merged` and `merge-observed` for each child not merged before, so a batch run again never resets the merges its outcome names; release locus locks; remove each merged leaf's clean worktree, keeping its branch; send each leaf that fails alone a `failures` message (`source: integration`); record what stops — a conflict, a combination failure, a composite or a cycle failing alone, a batch that moved nothing, a batch that could not run; write the drift record and the ruler's brief. A batch that started and never recorded its outcome is reset to where it started and done again, so an unverified merge is never recorded as landed; one during which the user's checkout moved is reset and decides nothing (a `checkout` fault) |
| **suite-gate** | on a composite whose children have all merged, under its branch lock: run the full suite on its integration head, against the head it was cut from; record the measurement and a `gate` state line; escalate `fails_full_suite` or `suite_gate_failed`. It runs nothing where the repository does not split its tests, or where the full suite already passed at that head in this execution ([The suite gate](#the-suite-gate)). A gate that passes says whether the integration review is earned, and records one that is not as `claims` with `review: not_earned`; one during which the user's checkout moved decides nothing (a `checkout` fault) |
| **folder-review** | read the integration reviewer's stored rulings; record its claim rulings as `claims` at the head it judged, `said` the reviewer's dispatch; record the one park they earn; a review that returned nothing holds the folder on a `role` fault |
| **rule-close** | read a ruler's stored rulings on drift or a moved base; record `drift-ruled` or `stale-ruled` with the ruler's `why`; park what the user must answer and hand the program what the planner replans; park a drifted consumer no ruling reached (`contract_drift`), hold a moved leaf no ruling reached on a `role` fault |
| **postflight** | release this execution's slots; summarize the subtree from the records (the nodes the user must act on, the leaves waiting behind each, cycle members held); append `closed {status: done}` when every leaf in scope merged; count the branches eligible for cleanup. The run's `ended` is `lib/run.mjs`'s |

The spec boundaries of a planner's folder are in [Autonomous review](#autonomous-review).

**A record lands once.** A boundary appends a record only while it is not already the node's word
(`freshRecords`): a stop while it stands, an approval at the same head, a review's claims at the
same head while they stand, a fault once per node and channel in a run, a ruling once per head, a
message once per node, thread, round and `msg`. So a boundary run again
after a crash lands nothing twice, and the same decision taken again — after a retry cleared a stop,
at a new round — lands again.

**A unit is in flight until its records say it ended.** The program keeps its running units in
memory and passes them to `schedule`, which launches nothing beneath a running or replanning node. A
program that died loses that set and rebuilds it from the records: a dispatch with no `returned` is
resumed, a batch with no outcome is reset, and everything else is decided again from disk. A unit
records its own faults and never rejects: a throw inside it is a `program` fault on its node, and
the unit ends — `faulted` even when that fault cannot be recorded.

**Checks run as the program's own children.** leaf-close, merge-batch and suite-gate measure through
`measure` (`lib/measure.mjs`): `node lib/verify.mjs --options -` as a child process the program
awaits, its options on standard input, so the event loop — the heartbeat, every running call's
stream — goes on through minutes of suite. Each measurement is keyed (`key` on its `verify-observed`
line) by what its answer depends on — the worktree's head and status, the base, the mode, rigor,
role and producer, the commands, the mutations, the tests, the checks, the approved cases, the
locus, the fences and the paths other leaves hold — and one this execution already journalled at the
same key is handed back instead of taken again, by a relaunch and by the same check asked again
within the execution — unless its environment broke, or the user has retried its node since (a
`replanned` event, reason `retry_escalated`, with a higher `seq`: the key holds nothing of the
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
an empty conflict list too. Anything that is not `mergeOk` stops the batch. A conflict is a planner
defect — loci were declared disjoint — surfaced to the user as an escalation, never resolved
silently.

A merged head is measured with the fast suite (`suite_fast`), or the full one where the repository
does not split its tests. The big tests wait for the [suite gate](#the-suite-gate).

**A failing merged head** is reset to the last green head, and the program bisects the batch. A leaf
that fails alone on the new head gets a fix round on its branch refreshed from the integration head,
told what failed by a `failures` message (`source: integration`), and is kept out of merges while it
runs; a composite or a cycle that fails alone has no one producer to send it to, and escalates
(`fails_on_integration`); leaves that each pass alone and fail together escalate as a **combination
failure** naming all of them — it is a design question, not a leaf's. A conflict the batch's first
merge met stands through the bisect: the unit it stopped at was never merged, so no bisect measures
it, and it escalates `merge_conflict` in the same batch. A batch that cannot run at all escalates
its target (`merge_batch_failed`), and one that merged nothing and reported no failure escalates too
(`merge_no_progress`): nothing is re-batched into a stopped target.

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

Where the repository does not split its tests, every merge-batch already ran the full suite on
the very head the gate would measure, and the gate runs nothing.

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
does not launch at all.

A leaf's dependencies are its own and every ancestor's: a dependency declared on a composite or a
group binds every leaf beneath it. A leaf is ready when its dependencies' outputs exist where it
will be cut — a dependency (or its ancestor just below the two nodes' lowest common ancestor,
groups passed over) has merged into that ancestor's integration branch, or, for a cycle predecessor,
is approved — no open escalation or park sits on its dependency chain, no unmerged leaf outside its
cycle holds a lock on its locus, and a slot can be had. Leaves launch up to the pool less the leaves
running.

A folder with nothing planned beneath it is planned, up to the pool less the plans running, when
the planner writes it; one the user writes is parked `needs_design` by the tick that finds it. A
folder the planner wrote that its compile parked `spec_changed` (the park's `return`) is re-derived
once per park: again only when this execution has no planner dispatch on that folder newer than
that park.

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
decomposed it — so release needs no write of its own; a locus lock whose holder was decomposed, or
whose revision dropped that path, is free for the same reason. A locus lock otherwise holds until
its holder merges — except within a cycle, which holds its files as one unit: the cycle is cut as
one chain of branches and lands as one merge, so the next member takes over the lock of an approved
one. A slot whose
holder belongs to an execution that is no longer running is freed by that execution's next
preflight, or by the user.

**Who controls what.** The `schedule` boundary decides *which* leaves are ready and in what order —
arithmetic over the plan and the events, on disk — and launches no more leaf chains than the
pool's current size. *Admission* is decided by `lib/locks.mjs` inside leaf-open: the entry point
takes a slot and the locus locks atomically. A slot is shared with every other execution and
session, so nothing in this execution says when one frees: leaf-open asks once and answers `no_slot`
at once, and the program asks again when another unit settles, or two seconds later when nothing
runs; nothing stalls. A held locus is never waited for. It frees when its holder merges, the
scheduler reads the same lock through the same check, and so it launches the leaf only once the
lock is free; a leaf-open that still finds it held answers `locus_held` at once and the leaf goes
back to the scheduler. A leaf whose holder never merges is reported blocked by that holder,
whatever the holder's status, and costs no dispatch while it waits. The user controls the limit.

When the user set a token target (`budget`), the program starts no new leaf once what is left of it
— the target less the tokens the execution's calls returned, over all its runs — is spent, or is
below the tokens the execution measured per merged leaf: a count deciding when, never what (L2).
`pause` is a launch flag that does the same once the run's first merge unit settles. Either way the
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

A leaf whose locus includes a designated shared file (an ancestor composite's `shared`: lockfiles,
configuration roots, barrel files) is **coupled**. It runs on its own branch cut from its parent's
integration head, under the same rigor, verification and review, and merges through a
merge-batch. Coupled leaves run one at a time; everything else keeps running.

### The locus

A leaf's locus names the files it may change. What it admits (`admits` in `lib/locus.mjs`):

- **A listed file**, existing or new, and every file under an entry ending in `/`.
- **A new test file in the directory of a listed file**: a name the repository's test-file patterns
  match (`isTestPath`), absent at the leaf's base — `src/a/X.ts` admits a new `src/a/X.test.ts`,
  `pkg/foo.go` a new `pkg/foo_test.go`. An entry at the repository's root admits none, because what
  sits at a root is found by convention and acts on everything.
- **Never** a file another unmerged leaf holds, and never a test file for a role the cycle bars from
  tests: a green's implementer, an auditor.

A leaf **holds** the entries its locus lists against every other leaf no dependency orders with
it, directly, through a chain or through a group, until it merges (`heldAgainst` in
`lib/atomicity.mjs`). Leaves a dependency orders never run side by side, so a file a leaf ordered
before or after this one also lists stays this leaf's own. A coupled partner holds its entries
like any other leaf ([Coupled work](#coupled-work)): the lane runs one partner at a time, but an
approved partner waits unmerged while the next one runs, so a test beside a file, or a file under a
directory entry, that the partner lists is never this leaf's to add. An entry a leaf lists itself is
never held against it: every leaf that lists it locks it from leaf-open through the merge, so they
write it one after another. One answer serves leaf-open's permissions, leaf-close's revert, the
series check and a cycle's test round (`cycleTestLocus`).

Anything else is asked for. Existing files stay listed one by one, because they are what parallel
leaves contend for; a test the leaf adds beside its source contends with nothing.

**Checked at the spec.** A producing task whose criterion's `check:` names a path its locus does not
admit, no locus entry starts with and no file the repository tracks starts with is refused by
`checkFolder`, with the file and the line — approval, compile and the spec check all read it — so a
test the plan itself creates and runs is in the plan's locus before anything is dispatched. When git
cannot list the repository's files, the spec is refused once, naming that failure, and no path is
checked. A test that lives outside every listed directory — a `tests/` tree, a mirrored layout — is
listed by name. Only a word of the command holding a `/` is read as a path, and not one that starts
with `-`, holds `://`, leaves the repository or carries shell syntax — a redirection, a pipe, a
variable, an operator, a glob, a brace; quotes around it and a trailing `;`, `,` or `)` are not part
of it. A path written from the current directory (`./test/x.test.mjs`) is read as the repository
path it names.

**Prevented.** leaf-open turns the locus into the call's permissions: `Edit` and `Write` for each
listed file and under each directory entry; `Edit` and `Write` for test-file names in each listed
file's directory; and `--disallowedTools` for every such name that exists at the base unlisted, and
every path another unmerged leaf holds. A test file a leaf creates beside its locus is locked when
leaf-close first sees it, like a listed file. Deleting a file is writing it: an implementer deletes
with `git rm`, one of its role's commands, because no host tool removes a file. A command rule
admits any path, so `git rm` is confined the way `git add` is, after the fact.

**Asked for.** A producer denied a path it needs returns `needs_locus` with the paths and why.
When the planner wrote the folder, the planner proposes the widened locus and lib admits it only
where no unmerged leaf holds the paths; when the user wrote it, the leaf parks `needs_respec` with
the paths as its question, and the answer is a one-line edit to the entry's `locus`, ruled by the
`rule` program like any changed spec.

**Detected and corrected.** What permissions cannot stop is a file a repository command wrote, or
a path a git command staged — `git add` and `git rm` take any path. The
series check judges the locus on the series' net diff, base to head, so a later commit that takes a
stray file out clears it. leaf-close takes every path outside the locus out itself: the round's
uncommitted stray files are first committed as they are (`agentics: outside locus`) and that head is
measured with the locus widened by the outside paths; then the committed ones go back to the base
and the stray ones to the head before, in a commit of its own (`agentics: revert outside locus`). It
records `breach_reverted {node, paths, sha}`, naming the revert, measures the leaf without them, and
raises `needs_locus` for the paths only when the head before the revert passed and the reverted one
fails. A close run again reads either commit back from git, and only its own: those above the head
its round opened on, so a head that is an earlier round's `agentics: revert outside locus` or
`agentics: outside locus` commit is nobody's to read back. A revert is recorded once per node and
sha, whichever execution made it. A rename a producer left staged is two paths, and both are put
back.

Two leaves admitted the same new name meet as a merge conflict, which stops the batch like any
other ([Merging](#merging)).

### Executors and review

- **Producers** are a leaf's sessions: implementer and test-author (an auditor judges). Each is
  handed its brief as its prompt, writes a focused commit series inside its locus (no amends, no
  rebases) or, shell-less, the files the program commits for it, and returns its status: `done`,
  `done_with_concerns`, `blocked`, `needs_context`, `needs_tests`, `needs_locus`, or a
  [replanning](#replanning) return, with what it established, tried and needs in the same return.
  leaf-close reads that return: on done it journals the series as `series-done` from git, after
  committing a shell-less author's files. A producer's return without a string `status` holds the
  leaf on a `role` fault; an auditor judges and returns no status, so any return of its reads as
  `done`, a `status` in it ignored.
  `needs_tests` is a green implementer's: what is left can only be fixed by a test outside its
  locus. It is no stop and no fix without commits (it may carry commits or none): leaf-close writes
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
  as it stands is the leaf's progress, whoever made it and whatever the round was told. It
  escalates (`fix_without_commits`, the measured failures in its detail) only when the close before
  it measured the very head it opened on and sent it those failures, and the head still fails: the
  producer was asked to fix what it found nothing to change in. A round that opened after a retry,
  a brief change or commits made by hand was sent no failures of its head, so its failures go to
  the next round. Two consecutive measurements failing
  identically escalate (`verify_not_converging`). lib/verdict.mjs escalates what no commit inside
  the locus can move — a discriminator that is the only failing fact on a `tdd` leaf
  (`discriminator_undecidable`) — and any environment error by its kind.
- **Review** is a fresh reviewer each round (`reviewer:<leaf>:<n>`, `n` counting this execution's
  reviews of the leaf), handed its producer's leaf brief, the span, the producer's return (its
  concerns first), the units it must rule — each criterion (`criterion:<n>`), each changed file
  (`file:<path>`), each approved case that fails at the head (`approved-case:<file>#<id>`) — and
  what the prior round left open; it returns its rulings, and `leaf-review` computes the exit
  (`reviewExit` in `lib/verdict.mjs`), never judged:
  - Round 1 reviews the whole series; later rounds rule on the open blockers and review the fix
    span alone — the merged change is reviewed whole again at integration.
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
    set of those alone sends no message and goes straight to a fresh reviewer.
  - Each finding names its `remedy`: `code` (the default) or `tests`. On a green, whose rounds go
    to an implementer or a test-author, a prior blocker whose remedy was not the reviewed round's
    producer's was **carried** past that round: it stays open, and counts toward neither
    escalation rule nor a raise, because nobody who could fix it was asked to.
  - The leaf is approved when the open set is empty — a count the boundary computes.
  - It escalates when a fix round returns no commits or a blocked status, when the same finding is
    ruled `not_fixed`/`regressed` in two consecutive rounds, or when two consecutive rounds each
    rule every prior blocker fixed and still mint new blocking findings, or when the convergence
    ruling finds the loop is not converging (`review_not_converging`, `said` the ruler's dispatch).
    The ruling is asked after every review round of the execution that ends in a fix and that
    `askAfter` picks (every third, unit-only re-reviews counted): a fresh ruler on
    `ruler:converge:<leaf>:<n>`, its prompt `convergenceBrief` (`lib/briefs/execute.mjs`) over the
    leaf's review records so far. `converging` lets the loop go on to the next round `askAfter`
    picks; a relaunch replays a returned ruling and resumes one cut off. A retry ends the stopped
    loop: the next round opens through leaf-open with the `retried` message, the stopping review's
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
  presented as a refactor; any change outside the locus in the series' net diff.
- **major** — real but mergeable: a genuine defect or hazard that does not fail an
  acceptance criterion (unhandled edge case beyond the spec, misleading name, duplicated
  logic). Reported in the result for the human gate; never loops — except on a leaf whose
  output is a yardstick (a red, an audit, or one that provides a contract), whose majors
  are held open and block exactly as criticals do: a flaw in a yardstick propagates into
  everything measured against it.
- **minor** — style. Reported once; never blocks, never loops.
- Severity is assigned by consequence, never by conviction. A critical or major names the
  concrete input, state, or consumer that goes wrong, in `failure_scenario`; a major that
  cannot name one is a minor wearing the wrong label, and on a yardstick leaf that
  mislabel costs a full fix-verify-review round. A finding whose only remedy is rewriting
  an already-landed commit is advisory by definition — the series is append-only. Finding
  nothing new is a real, reportable answer; a severity is never raised to make a round
  look thorough.
<!-- /agentics:verbatim -->

- **Integration review** runs per folder once every child has merged, a fresh reviewer on
  `integration:<folder>:<n>` (`n` counting the folder's recorded reviews in the execution) over
  the merged diff of its children, against its decision list, the criteria of every child reviewed
  there, and the folder's spec as its yardstick. Its units are each decision the folder defines
  (`decision:<id>`), each criterion but a `HUMAN:` one of each child with no review of its own
  (`criterion:<child>#<n>`) and each changed file (`file:<path>`). A leaf adopted on the user's
  word ([Outside work](#outside-work)) is a child with no review loop of its own whatever its
  rigor, so its criteria are units here. The review is earned at the root
  whenever something merged there (the landing view reads its rulings), and below the root when a
  child had no review loop of its own or two or more children with work meet there; a leaf adopted
  at any rigor, or an `outside` event on the folder, earns it too, since nothing else would ever
  judge that work. Otherwise it is skipped, and the suite gate that found it unearned records so.
  The brief carries what a person did as its own section, "Work agentics did not produce": each
  adopted leaf with its commits, and the commits that belong to no leaf. Besides findings it returns a
  **claim ruling** for each
  claim the spec makes (a success criterion, a Design statement, a plan criterion): `met`, `under`,
  `over`, `deviates`, `spec_defect` or `cant_tell`, recorded by `folder-review` as a `claims` event
  at the head it judged (`review: done`; a skipped review records `review: not_earned` and no
  rulings, and one that returned nothing is a plugin fault on the folder and a lost check). Routing
  (`integrationPark`) is by class, first match: any `spec_defect` parks the folder `spec_defect` on
  its spec (a re-spec); any critical, or any `under`, `over` or `deviates`, parks it
  `integration_critical` (the user routes the fix); any `cant_tell` parks it `cant_tell`, which
  never counts as a pass.
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

### Landing and drift

An execution delivers into its root's parent integration branch, and ultimately the effort branch,
without asking; the user's tree is not involved.

After each merge-batch, the landed diff is intersected with the `consumes` path prefixes of every
pending designed node. Merge-batch writes the ruler one brief
(`merges/<key>-<pre>.drift.md`): per consumer, the node as its executor will be briefed (intent,
context, criteria, what it writes, reads and consumes) and the merged change to the files it
consumes. One ruler, handed it as its prompt, rules each consumer `unaffected` or `affected`, with
the one question its owner must answer; either ruling is a `drift-ruled` state line. A consumer is
not launched while it is being ruled on or replanned.

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
| red | yes | red: fails now, fails at base | no | — |
| green | yes | the red leaf's tests pass now | no | when given |
| green, a test-author round | yes | the red leaf's tests and the round's new ones pass now | required, this round's alone | when given |
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
- **A changed test file either adds a test case or keeps existing ones working.** Each file of the
  leaf's own diff is classified by its added lines: one declaring a test case (`TEST_CASE_PATTERNS`
  in `lib/verify.mjs`, a closed set like the test-file patterns) that the diff does not also remove
  adds one. A file adding none is upkeep — a call site given a new argument — and passes at base by
  construction, so no commit could make it discriminate. The classification is on each
  discriminator entry (`adds_test`) and in the notes, so the verdict and a resume read it off the
  journal line. A caller's named tests are the cycle's and each counts as adding one.
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
  worktree missing a gitignored asset fails the same way at its base, and no commit inside a locus
  could move it.

### What a verdict is computed from

`lib/verdict.mjs` is the one home of the measurement verdict. `measurementOk(m, leaf)` derives pass
or fail from the observations against the leaf's profile (every profile needs a completed
measurement, no failed build or typecheck and no blocking series finding; then per profile: a tdd
leaf's test files that add a test case fail at base and pass now, and its upkeep files pass now —
when none adds one, every file is held to the whole discriminator; a tests-only leaf's tests pass,
every held mutation bites and each test file that adds a case is one a biting mutation names; a red
leaf's tests fail now and at base; a green leaf's cycle tests pass; a green's test-author round's
cycle tests and new tests pass, at least one mutation it declared this round, each biting, and each
test file that adds a case one a biting mutation names; an audit's held mutations all bite over the
cycle's tests; trivial, verify, tdd, tests-only and green need their
named checks and their own tests not to have failed). The profile is the leaf's rigor and role
and, on a green, the measured round's producer (`profileOf(leaf, producer)`): leaf-close passes it
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
too; a producer that returns those failures' head unmoved escalates `fix_without_commits`. The
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
`confirmed` set to the latest checkpoint line's `seq` records `checkpoint-confirmed` (with the gaps
it passes, for `blocking_gaps`), which confirms the checkpoint line just before it; a reason
confirmed once stays passed for every later run of the execution. A run that stops again for a
reason it already wrote a line for reuses that line's `seq`:

| checkpoint | meaning | to proceed |
|---|---|---|
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

A service step carries `user-invocable: false`: it is gone from the `/` menu, and the model still
runs it when asked in chat.

**A skill starts no agent.** Every agent a skill needs is a program's: the skill starts the program
and reads its result, so every dispatch is recorded, confined and judged as the laws ask.
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
  `outside` and `noted` events).
- **Restated in:** `roles/planner.md`; `skills/develop` and `skills/design` (the root and design
  node JSON); `lib/schedule.mjs` (it reads `author`); `todoFor` in `lib/status.mjs`; the
  entry-to-node mapping in `lib/compile.mjs`; `lib/next.mjs` and `lib/render.mjs` (readers).

Fields as in [Nodes](#nodes). Event lines are `{kind, node, execution, seq, ...}`:
`planned {by}` · `replanned {reason, by}` (also `retry_escalated` and `answered`) ·
`dispatched {dispatch, role, round, model, effort, thread, session, brief_digest, brief_parts,
carries[], pid}` (the runner's whole record, [The agent runner](#the-agent-runner)) · `approved
{head_sha, review_rounds, at_integration}` ·
`merged {into, merged_sha, head_sha, by?, commits?}` (`by` and `commits` only on a leaf adopted on the
user's word, [Outside work](#outside-work); a `merged` without `by` is agentics' own) ·
`outside {commits, by}` (commits on a folder's integration branch that belong to no leaf, adopted on the
user's word) · `escalated {reason, detail, said?}` · `parked {return,
question, said?}` (`said` is the dispatch whose stored return holds the agent's own words;
`detail` or `question` is a line the lib composed, or empty, and `saidOf` in `lib/store.mjs` reads
either)
(`return` is a replanning return, `needs_design`, `needs_respec`, `integration_critical`,
`spec_defect`, `cant_tell` or `contract_drift`) ·
`landed {into, merged_sha, by}` (`by` who confirmed the word: `user` or `terminal`) · `claims
{head_sha, review: done | not_earned, claims[{claim, ruling}], said?}` (each ruling's evidence is in
the reviewer's stored return) · `noted {by, text}` (what a session learned about the node; no status
is derived from it) · `message {thread, from, msg, payload, round}` (a message code delivers to a
thread's session, [Conversations](#conversations); its `execution` is `''` only on one the migration
recorded, and no status is derived from it). A boundary appends an event only while it is not
already the node's word (`freshRecords` in `lib/boundaries/records.mjs`, [Boundaries](#boundaries)).

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
cannot reach, each `{id, label, parent, kind, author, title, intent, context, rigor, role, locus,
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

### Live activity

- **Owner:** `lib/runner.mjs` (the writer); `nodeOf` and `snapshotOf` in `lib/status.mjs` (the
  readers, each node's `live`).
- **Restated in:** `agentics-viewer/shared/snapshot.ts` in the vanillafairy repository (a reader,
  through the snapshot).

`executions/<stamp>/live/<dispatch>.json`, rewritten whole by the runner while the dispatch runs and
removed when it returns: `{turns, tool: {name, target}, at}` — the turns so far, the latest tool
call's name and target (`target` the call's file, command, pattern, path or url, `''` when it names
none), and when it was made. The `node` view prints it `last <name> <target>`.

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
plan, or `/a/b` from the root folder), `provides` (`<name> (<path>, …)`), `consumes`, `ground`;
`author` (`you` or `planner`) and `shared` on a sub-effort; `rigor`, `role`, `locus`, `reads` and
`dispatch` (`producer=<model>/<effort>, reviewer=<model>/<effort>`) on a task, which also needs a
criterion; `label` on either, the node's visible name. A node's id is its path and carries its
parents; the label names the work done there in free text for people, at most 16 characters so
it fits a node's block in the viewer (`foundations/world/world-red` is shown as `World tests`). The
viewer draws the label, and the last id segment where none was written. A checked box is refused.
Headings and forms inside a fenced block are prose.

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
`complete` as its coverage says, and only with no finding the store refused; `remaining` its open
units, then `channel:<c>` for each failed channel, then its coverage's incomplete entries, then
`unrecorded:<id>` for each finding the store refused; `ambiguities` by settlement id; `clean` and
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
| rule_it | planner | nothing, why, problems[]}`, each with its coverage block: a ruler that
returned nothing, or whose rulings settling refused the same way twice, fails `ruler`. The ruler
returns `ruler_respec`, `{rulings: [{node, ruling: unaffected | answered | affected, why, question,
fix, answers?}]}`, one per unit of the brief.

### State and journal lines

- **Owner:** the boundaries in `lib/boundaries/` (`fault`, `drift-ruled`, `stale-ruled`, `batch`,
  `batch-started`, `gate`, `checkpoint`, `checkpoint-confirmed`, `closed`, `merge-observed`,
  `series-done`, `authored`, `breach_reverted`); preflight in `lib/boundaries/execution.mjs` also owns
  the adopted drift record file; `lib/runner.mjs` (`dispatched`, `returned`,
  `host_stop`, `checkout_changed`, `thread_renewed`); `deliver` and `step` in
  `lib/programs/common.mjs` (`message`, `step`); `lib/run.mjs` (`run`, `ended`, and `fault` on the
  `program` and `launch_failed` channels); the execute program (`fault` on a unit's node);
  `journalLine` in `lib/verify.mjs`; `measure` in `lib/measure.mjs` (`measure-done`); `executionLog`
  and `runLog` in `lib/ledger.mjs` (where each record goes).
- **Restated in:** `lib/resume.mjs` and `lib/status.mjs` (readers); `runState` in `lib/ledger.mjs`
  (reads a run's `ended`); `claim` and `callsOf` in `lib/run.mjs` (read `run`, and `returned`'s
  usage and cost, for a run's `costOf` and the effort's cost report in `lib/status.mjs`); `dispatch`
  in `lib/programs/common.mjs` (reads `dispatched`, `returned`, `message` and `thread_renewed`);
  `measure` in `lib/measure.mjs` (reads `verify-observed` by `key`); `tools/migrate-v5.mjs` (writes
  `closed`, `ended` and `message`).

An execution's records go through its log port: its node events (`dispatched`, `message` and the
rest, [Node record and events](#node-record-and-events)) to the effort's event log, its
observations to `journal.jsonl` and everything else to `state.jsonl`, under the effort's `seq`.
`state.jsonl` (what the execution decided and what its calls cost): `run {program, scope, pid}`,
one per run of the execution; `returned {dispatch, session, status, cause, usage, cost_total,
cost_usd, denials[]}` (`usage` the host's own figure for the call), one per call the runner made,
written when the call ends; `host_stop {dispatch, cause, until}`; `checkout_changed {dispatch,
paths[]}`; `thread_renewed {thread, gen, why: too_large | session_missing | raised}`; `step {key,
value}`; `batch {target, merged[], head_sha, verified, failed_alone[], combination[], conflict}`,
landing before the batch's `merged` events; `gate {target, head_sha, passed}`, one per suite gate
that ran; `checkpoint {reason, detail, executions?, gaps?, branches?}` (the lists the checkpoint found, `branches` the `[{branch, commits}]` of an `outside_work` one;
`lib/status.mjs checkpoint` prints them); `checkpoint-confirmed {gaps?}`, confirming the checkpoint
line just before it; `closed {status: done | migrated}`; `batch-started {target, pre, children}`;
`drift-ruled {node, contract, head_sha, ruling, why, said, adopted_seq?}` (`adopted_seq` the seq of the adopted record the ruling covers, [Landing and drift](#landing-and-drift)) and `stale-ruled {node, base_now,
ruling, why, said}` (`said` the ruler's dispatch; the newest `stale-ruled` of a leaf is its anchor
for the next moved base once it is `unaffected` or answered on disk); `breach_reverted {node,
paths, sha}`, `sha` the revert commit; `fault {node, channel, detail}`, once per node and channel
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
pid}`; `returned {dispatch, session, status: returned | part | failed | cut_off, cause, usage,
cost_total, cost_usd, denials[]}`; `host_stop {dispatch, cause, until}`; `checkout_changed
{dispatch, paths[]}`; `thread_renewed {thread, gen, why}`; `message {thread, from, msg, payload,
round}`; `step {key, value}`, a side effect the program journaled; `fault {node, channel, detail}`
with `node` empty; and `ended {result: {status: done | failed | launch_failed, file, complete}}`. No
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
too); `discriminator[{test_id, adds_test, failed_on_base, passes_now}]` (`adds_test` false for a
file of the leaf's own diff that adds no test case; an entry without it is read as adding one);
`mutations[{file, find, replace, applied, unapplied_reason, expect_failing, observed_failing,
bites}]`; `series_findings[{sha, check, message, blocking}]`; `checks[{command, status,
failing_tests, baseline_failing}]` (`status` `passed | failed | unrunnable`);
`approved_failing[{file, id}]` (approved cases that fail when the red's approved version of their
file runs in its place at the head); `notes`; `error` (`null` or `{kind, message}`: `no_worktree`,
`main_worktree`, `series_unreadable`, `command_unknown`, `shell_refused`, `suite_failures_unnamed`,
`base_checkout_refused`, `test_unrunnable`, `tree_not_restored`; and `measure`'s own, a child that
gave no payload `measure_failed` and a checkout the watch could not read `watch_failed`);
`journal` (`null` or `{written, error}`). `node lib/verify.mjs --options -` reads its options, one
JSON object, on standard input — `key`, `approved[{file, sha}]` (the red's approved version of
each cycle test file) and `held[]` (paths other unmerged leaves hold) among them — and prints the
payload as one JSON line. The series checks
come from `lib/commit-series.mjs`: `empty-series`, `empty-commit`, `locus-breach`, `test-removed`,
`wip-subject`, `checkpoint-commit`, `and-subject`, `subject-length`. They run over `base..HEAD`
less every merge whose later parents the base holds: a refresh from the parent, not the leaf's
work. `locus-breach` judges the series' net diff against what the locus admits
([The locus](#the-locus)), and each commit the program made for a shell-less author against its own
fence (a test-author's commit on a green or an audit, held to the cycle's tests); `test-removed`
flags a test case removed from a test file the cycle approved.

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

`.agentics/config.json {max_parallel, max_agents, claude_cli, guidance}`; `slots/<n>.lock {effort,
execution, node}`; `locks/locus/<fnv1a(path)>.lock {path, node, execution}`;
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

- **Owner:** `land`, `landAct`, `adoptAct`, `retry` and `note` in `lib/boundary.mjs`, which holds those
  and their CLI alone, and `adopt` in `lib/adopt.mjs`, which `adoptAct` and the CLI call: any other
  verb exits 1 with `{error: program_failed}`.
- **Restated in:** `skills/develop/SKILL.md`, its landing reference and its `outside-work.md`.

Every other boundary is a function the `execute` program calls in-process
(`lib/boundaries/*.mjs`); its result is a value, and its shape lives in its own module. Four are
the session's, called as CLIs:

- **land** — `check`: `into` (the user's checked-out branch), `effort_branch`, `effort_head` (the
  head its token names), `open_escalations`, `parked`, `human`, `drift {base_sha, base_moved,
  commits, overlap}`, `root_status`, `root_claims`, `landing`, `token` (the act the user's answer
  must choose: `land <effort>@<head8>` over the effort branch's head, `land <effort>@` once the
  branch is gone); `merge`: `merged_sha`, `already` (nothing left to merge), `removed[]` (the
  branches swept), `kept[{branch, why}]`, once `landAct` has confirmed the user's word
  ([The user's word](#the-users-word)); the `landed` event records `by`, and `merge` records it
  when no root `landed` record exists or the latest one's `merged_sha` does not hold the effort
  head. A refused merge carries the check's fields with `ok: false` and `error`: `{kind: head_moved,
  message}`, `{kind: no_effort_branch, message}`, or the words of an open escalation or park, a
  dirty tree, a merge that failed and was aborted. `check` with no effort branch (nothing landed
  and swept) returns its report with `token: ''`, `ok: false` and the `no_effort_branch` error, and
  `landAct` returns that refusal before asking anybody. A word not confirmed is `confirmAct`'s
  refusal, `{ok: false, error: {kind, message}}` (`no_token`, `not_approved`,
  `answer_unverifiable`).
- **adopt** — `adopt --repo <r> --effort <e> --folder <id> --map-file <path> --action check|act`
  ([Outside work](#outside-work)); every flag is a handle or a path, and a map file that does not
  resolve refuses `unknown_file`. `check` returns `{ok, action, effort, folder, folder_branch,
  folder_head, digest, refusals[{entry, kind, message}], outside_locus[{node, paths[]}],
  clears_stops[{node, kind, reason}], deps_open[{node, deps[]}], unaccounted[{branch, commits[],
  error?}], criteria[{node, criteria[]}], token}`; `ok` is false and `token` empty while any
  refusal stands. `act` (through `adoptAct`, once the user's word is confirmed) returns the check's
  fields beside `recorded` (the seqs of the records written) and `created` (the branches made),
  or `ok: false` with `refusals` when the check refuses, or with `error: {kind, message}`:
  `head_moved` (the digest the token named is not the digest now), `branch_failed` (a branch could
  not be created; those already made are in `created`), `append_failed`, `bad_arg` (an action that
  is neither), or `confirmAct`'s refusal (`no_token`, `not_approved`, `answer_unverifiable`). The
  refusal kinds are listed under [Outside work](#outside-work).
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
latest `retry_escalated` event. Commits the session made on the leaf's branch before it retried are
measured before any producer round ([Resume and checkpoints](#resume-and-checkpoints)).

### Producer returns

- **Owner:** the `producer` schema in `lib/schemas.mjs`; `producerOutcome` in
  `lib/boundaries/leaf-close.mjs` (what each status decides).
- **Restated in:** `roles/implementer.md`, `roles/test-author.md`, `roles/investigator.md`.

`{status, text, concerns[], gotchas[], gotchas_stale[], mutations[], commit?, needs_locus?{paths[],
why}}`. `status` is `done | done_with_concerns | blocked | needs_context | needs_tests |
needs_locus | decompose | unsplittable | premise_mismatch | needs_decision | contract_changed |
declined`; for any but `done`, `text` says what was established, tried and needed, its first line
the gist. `needs_tests` is offered to a green's implementer alone and `declined` to the cycle's
test session alone ([Executors and review](#executors-and-review)); `commit` is the subject a
shell-less author's files are committed under. `mutations` are `{file, find, replace,
expect_failing}`. The status is the only request a producer makes; [Conversations](#conversations)
routes it. A return with no string `status` holds the leaf on a `role` fault. An auditor's return,
`{mutations, units, text}`, carries no status and reads as `done`.

### Coverage block

- **Owner:** `resultOf` in each `lib/programs/*.mjs`, over `coverageOf` in
  `lib/programs/common.mjs`. The `coverage-block` lint rule requires every program file but
  `common.mjs` and `converge.mjs` to define `resultOf` and build its result with a `coverage` key
  that is not an empty object or null.
- **Restated in:** the skills that walk a result.

`complete` (computed: false whenever `dropped`, `incomplete`, `failed_channels` or `unreached`
holds anything, and per program besides — a survey also needs every item it returns standing, an
investigation its survey's `complete`; for
`execute`: no checkpoint, every leaf in scope merged, the
root integrated, nothing escalated or parked — carried from an earlier run or not — and no earned
integration review or survey lost), `declared` (what rests on a searcher's own word, named),
`dropped[]`, `incomplete[]`, `failed_channels[]`, `unreached[]` (prose, loss first),
`resumable {program, scope, args}` (`args` the flags as given, by argument name).

### Evidence item store

- **Owner:** `lib/evidence.mjs` (`checkItem`, `recordItems`, `recordJudgement`, `recordRulings`,
  and the mappers from returns — objects in-process, or stored files — `recordSurvey`,
  `recordProbe`, `recordSolutions`); written through
  `lib/ledger.mjs appendProject`, which mints a project-wide `seq` under `.agentics/.state/.lock`.
- **Restated in:** the searcher and judge return schemas in `lib/schemas.mjs`; the `effort-store`
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
  review_rounds, at_integration, salvaged}], escalations[{id, reason, said}], parked[{id, return,
  said}], faults[{id, channel}], blocked[{blocked_by, leaves_n}], integration{branch, head_sha,
  reviews[{target, said}]}, drift[{node, contract}], cleanup_n, stopped: '' | budget | pause,
  notes, coverage}`: `root` is the folder it ran, `checkpoint` null when none stopped the run, and
  `implemented[].role` the node's role (`none` outside a cycle). A preflight refusal returns the
  same shape with `error {kind, message}`, `checkpoint` null and the unreached line `preflight
  refused (<kind>): nothing was dispatched`. A stop's text is its `said` dispatch's return, or the
  node's card. `coverage.unreached` names every stopped node and counts the rest.
- **Every program `lib/run.mjs` starts** has its result written to `result.json` in its run's home
  by `lib/run.mjs`, with `run` and `cost {dispatches, by_model, tokens, usd, unmeasured}` added,
  each `by_model` entry `{dispatches, tokens, usd, unmeasured}` ([Programs](#programs)).
- **`survey`** — takes `question_file` (required), `roots` (default `.`), `notes` (or `notes_file`),
  `prior_file` (a
  file the session wrote: what an earlier pass concluded, which the planner reads and no searcher is
  shown), `max_topics` (default 8), `intelligence` (`low | normal | max`, default `normal`), `pace`
  (`frugal | balanced | fast`, default `balanced`), `ground`. Returns `{question, topics[{key,
  subtree, forced}], ground, items[{id, topic, kind, state}], reused[], unrecorded[], context,
  risks[{topic, n}], history, docs, coverage}`: `context` is the path of the one file holding every
  item it returns in full, the judges' risks and the channels' returns; a `forced` topic is searched
  again for its stale items; `history` and `docs` are the path of that channel's last stored return,
  or null when it did not run or returned no round.
- **`probe`** — takes `artifact` (required), `roots` (default `.`), `context` (or `context_file`), `per_axis`,
  `since`. Returns `{artifact, axes[{key, source}], analysts[[axis]], shared_ground{resolved, cited,
  files, excerpts, unresolved}, guidance_read, repo_ground{located, unresolved}, units{total, ruled,
  open[]}, findings[{id, item, severity, axis, section, carried}], findings_file, ambiguities[],
  ratifiable, snapshot, scope{full, changed}, unrecorded[], review, coverage}`: `artifact` is the
  repo-relative path, or the absolute one for an artefact outside every checkout; a standing axis's
  `source` is `''`; `findings_file` holds every finding and every unit's ruling in full;
  `ambiguities` lists every open ambiguity, carried ones included; `snapshot` is empty when the
  round was not recorded or a finding was refused, so the next round is whole; when
  `coverage.complete` is false its loss is named in `units.open`, `coverage.failed_channels` or
  `coverage.incomplete`, which `approval.mjs reviewed --from-run` reads.
- **`solutions`** — takes `capability_file` (required), `roots` (default `.`), `constraints` (or
  `constraints_file`), `notes` (or `notes_file`), `max_angles` (default 4), `intelligence` (default `normal`). Returns `{capability,
  constraints, summary, counts{present, candidates, viable, ruled_out, invented, lost, unanchored,
  unsettled}, measured, items[{id, topic, kind}], recorded, coverage}`.
- **`investigate`** — takes `question_file` (required), `roots` (default `.`), `notes` (or
  `notes_file`), `as_tasks`, `intelligence` (default `normal`), `pace` (default `balanced`). Returns `{question,
  mode: tasks | report, tasks: {summary, gaps[], tasks[{ref, subject, description, activeForm,
  blocked_by[]}]} | null, report: <text> | null, evidence{items, context, risks, history, docs},
  coverage}`: the survey's evidence is there whether or not the synthesis returned
  ([Investigations](#investigations)).
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
  over the paths in `lib/store.mjs` (`runHome`, `runDir`, `runJsonPath`, `runLogPath`,
  `resultPath`, `runLogFile`), and `homeOf` in a program that names its home; read by `runState`
  in `lib/ledger.mjs` and `lib/status.mjs watch --run`.
- **Restated in:** the skills that start a program (they keep `run`, follow it and read
  `result_file`).

A run's home is `runs/<run>/`, or for an execution's run, `<effort>.<stamp>`, that execution's
directory (`runHome`), whose log is its `state.jsonl`. Its `run.json` is `{run, program, scope,
scope_key, args, args_digest, raw, pid, started_at, heartbeat_at}`: `args` the resolved arguments,
`raw` the flags as given, `scope_key`
and `args_digest` the digests of `scope` and `args`. It is rewritten whole, `heartbeat_at` every 10
seconds while the run's process lives. `result.json` is the program's result with `run` and `cost`.
What `lib/run.mjs` prints: attached, `{ok: true, run, result_file, result}`; with `--detach`, at
once, `{ok: true, run, pid, log, result_file}`; refused, `{ok: false, error: {kind, message, run?,
pid?, log?}}`, a `run_live` naming the run already going; `{error}`, exiting 1, when the program
threw.

### Review returns

- **Owner:** `REVIEW` in `lib/schemas.mjs`; read by `leafReview` in
  `lib/boundaries/leaf-review.mjs` and `folderReview` in `lib/boundaries/integration.mjs` over
  `reviewExit` and `integrationPark` in `lib/verdict.mjs`.
- **Restated in:** `roles/reviewer.md`.

`{units[{unit, ruling: clean | findings, ids[], why}], findings[{id, severity: critical | major |
minor, claim, evidence, failure_scenario, remedy?: code | tests}], fix_rulings[{id, status: fixed |
not_fixed | regressed, evidence}], claims[{claim, ruling: met | under | over | deviates |
spec_defect | cant_tell, evidence}], notes}`. The units are those the brief lists — a leaf review's
criteria, changed files and failing approved cases, an integration review's decisions, the
criteria of its children with no review of their own, and its changed files — and a unit with no
ruling is open. A leaf review returns `claims: []`. `remedy` is who must change to fix a finding
— the implementation (`code`, read when absent) or the cycle's tests (`tests`); `remedyOf` in
`lib/verdict.mjs` reads it.

### Planner returns

- **Owner:** the `planner_write` and `planner_settle` schemas in `lib/schemas.mjs`; `planOutcome`
  and `settleOutcome` in `lib/boundaries/spec.mjs`.
- **Restated in:** `roles/planner.md`.

Writing a spec: `{status: written | needs_decision | contract_changed | premise_mismatch |
unsplittable | blocked, text}`. Settling a review, in the same session: `{status: settled |
needs_decision | blocked, dispositions[{finding, outcome: incorporated | discarded}], text}`.
Answering a leaf's request, in the same session — `needs_context` and `needs_locus` delivered as
their messages, any other (`decompose`, `unsplittable`, `premise_mismatch`, a verify leaf's
finding, a ruler's question) as a brief of its own — the spec edited and the writing return; the
edit goes through the autonomous review before the asker runs again.

### Ruler and investigator returns

- **Owner:** `rulingOutcome` in `lib/boundaries/integration.mjs` (the rulings); `convergenceRuling`
  in `lib/boundaries/leaf-review.mjs` (the convergence ruling); `recordCommands` in
  `lib/boundaries/leaf-close.mjs` (the commands).
- **Restated in:** `roles/ruler.md`; `roles/investigator.md`.

The ruler returns `{rulings[{node, ruling: unaffected | affected, why, question, fix?}]}`
(`ruler_premises`; a changed spec's ruling, `ruler_respec`, is under
[Changed-spec results](#changed-spec-results)), or, asked whether a loop converges, `{ruling: converging | not_converging, why}`. The investigator returns
`{commands[], unresolved[], text}`, `commands` its `command` gotchas ([Gotcha file](#gotcha-file)),
which `recordCommands` writes as the investigator's.

---

## Self-checks

- **Lint** (`tools/lint.mjs`, one module per rule under `tools/rules/`) checks form: no turn or
  spend cap on a dispatch (L2; `no-turn-caps`, over `lib/programs/` and its `execute/` units,
  `lib/run.mjs`, every `SKILL.md` and every role file in `roles/`); no loop bound in a program
  except through `askAfter` (L2; `no-loop-bounds`, over `lib/programs/**` and `lib/run.mjs`); a
  coverage block on every program result (L1; the `coverage-block` rule requires every program file
  but `common.mjs` and `converge.mjs` to build its result in a `resultOf` with a `coverage` key that
  is not an empty object or null); no ruling fields in a producer's or searcher's schema, and
  required per-unit rulings in a judge's (L3; `no-self-verdict`, beside its ban on verdict-named
  booleans); no bound in a return schema (`no-schema-bounds`); role frontmatter (`role-frontmatter`:
  the file's own name and a role of `ROLE_NAMES`, a kind, tools, commands only beside `Bash`,
  schemas `lib/schemas.mjs` exports, a model and an effort of the tier tables, and no other key);
  prompts built only by `lib/brief.mjs`, `lib/briefs/` and `renderMessage`, so no command or path
  for a model to carry reaches one (P2; `prompt-origin`: in a program or a boundary, a `brief`,
  `threadBrief` or `prompt` is never a string literal, a template literal or a concatenation,
  directly or through a name the file binds to one; an array's `.join(…)` of such values is not
  judged); only handles in a command a skill runs (P2; `skill-handles`) — and at run time every CLI
  a skill calls refuses an argument that is not a handle or a line of named free text
  (`handleArgs`); no skill that starts an agent (`no-skill-agents`: no skill names the host's Agent
  or Task tool, a `subagent_type`, or an `agentics:` name that is not a skill); gate clauses in
  gated skills (`design-gate`); a stated task-tool fallback (`task-tool-fallback`); size budgets
  (`size-budget`); and that nothing in `test/fast/` imports `child_process` or a helper from `test/`
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
  stored returns, retries, continuations and renewals production does. It runs
  without the checkout watch and with no live process, so it never yields `checkout_changed`, a
  `checkout` or `watch_failed` cause, or an `orphan_ended` cut-off.
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
  only when `AGENTICS_HOST_NET=1` as well), each without a denial under `dontAsk`, and `--effort
  xhigh` accepted. A host release that changes one of them fails here before it fails an execution.
- **Real git.** Every boundary, the locus, the resume ladder, verification and landing are tested
  against real repositories and worktrees.
- **Pins:** verbatim blocks match across files (`test/fast/verbatim-blocks.test.mjs`); every role's
  tools and commands are pinned (`test/fast/role-allowlists.test.mjs`); every pointer into this
  document resolves and every law names its enforcement (`test/fast/design-doc.test.mjs`).
- **Liveness** (P4, `test/fast/liveness.test.mjs`): every role is dispatched by a program (named in
  `lib/programs/`); every record kind is written somewhere and read somewhere; every message kind
  has a route, a template its reader is given, and a program or a boundary that sends it; every
  field a role's schema asks for is read in `lib/` or, for a return a program hands back whole, in a
  skill; every lint rule has its test; every library export is used somewhere.
  Defined-never-dispatched, written-never-read and read-never-written fail the suite.
- **Budgets:** each skill and role file has a size budget in `tools/budgets.json`; the
  `size-budget` lint rule fails a file over it, or one with no budget.
- **Cost:** every call's usage and cost are the host's own figures, recorded by the runner on
  `returned`; `lib/status.mjs cost` aggregates them per node, folder and effort, so triage quotes
  measured figures. A call that never returned is reported as unmeasured, never as zero.

---

## Migration from 4.x

`tools/migrate-v5.mjs` is the one-shot move of a repository's 4.x effort store to this design. The
default is a dry run, `--yes` applies, and a second run changes nothing: each part recognises its
own work. A record the ledger refuses stops the run there: it prints `{applied, …, error}` — how
many records it appended and why it stopped — exits 1, and the next run finishes the rest. It never
deletes. Every part appends at a new `seq`, so it takes only what keeps every derived status as it
was. An effort is refused whole while its lock's holder (judged by `holderGone` in `lib/store.mjs`,
as every lock's is) or a 4.x job of any of its executions is a live process.

- **Executions.** A 4.x execution is one whose state holds no `run` line. Each that has an
  `execution.json` and no `closed` line gets `closed {status: migrated}` and `ended {result:
  {status: migrated, file: '', complete: false}}`. A 5.0 `execute` over the same folder starts a
  new execution: the resume ladder salvages every leaf's committed work from its branch, and
  unfinished leaves start new sessions. What a 4.x dispatch had not committed is reported and
  adopted by nobody, as on any resume.
- **Stops.** Every escalation and park that is still its node's open stop and whose `said` names a
  4.x file is stated again: the file's text becomes a stored return of its own, `{status:
  migrated, text}`, under the dispatch key `migrated-<node key>-<seq>` (each `_` of the key
  spelled `-`; `migrated-root-<seq>` for the root) in `executions/<its stamp>/returns/`, and a
  fresh `escalated` or `parked` event, the same in every field but `said`, names it. The stop's
  status and question are unchanged, and nothing reads a 4.x file again. A stop whose event names no
  execution, whose file cannot be read, or whose stored return is already there with other bytes is
  refused and keeps its 4.x `said`.
- **Reviews.** A `claims` event that still stands is appended again with each `verdict` as `ruling`,
  its 4.x `said` stated again as a stored return, as a stop's is, so nothing reads a 4.x file again.
  When its said file cannot be stated again it is refused, as a stop's is, and the event is appended
  all the same with each `verdict` as `ruling` and its 4.x `said` kept: only the text is lost. A
  folder not yet approved whose latest `reviewed` line at its current hash is complete gets one line
  marking it incomplete (`remaining: ['migrated: a 5.0 review rules units']`), so its gate waits for
  a 5.0 review that rules units; the line keeps the review's ambiguities and the sections that name
  them, and rules no section clean. A leaf not merged or approved keeps its open review findings,
  while no later 4.x round of that leaf (a `dispatched` event naming no thread) was dispatched after
  the round its latest fixes file was written for — a 5.0 round never read a 4.x fixes file: each
  review entry of that file, carried ones included, is recorded as a `findings` message from code at
  that file's round, with an empty execution, on the thread 5.0 routes it to (on a green or an audit
  a `tests` finding to `producer:<red>`, on an audit the rest to `auditor:<audit>`, otherwise
  `producer:<leaf>`); the next execution that runs the thread delivers it. A migrated green whose
  latest 4.x review left only `tests` findings thus opens its first round on the cycle's test
  session, as 4.x would have: its first round goes by `greenRoundRole` over the messages, as any
  green's. Verification and integration failures are measured again.
- **Threads.** A 4.x dispatch has no session and no thread, so it is never a round: a leaf's next
  call opens a fresh session, as for any session the host no longer holds
  ([The agent runner](#the-agent-runner)), and a 4.x execution's `closes/` and `reviews/` are
  never read.
- **Left on disk.** Everything in a 4.x execution but `execution.json`, `state.jsonl`,
  `journal.jsonl` and `returns/` — its jobs, cards, fixes files, said files, briefs, closes,
  reviews, merges and gates, `stale-*` files and anything else — and the effort's
  `.state/reports/` are read by nothing; the tool lists them, each with why, for the user to
  remove.
- **Evidence.** Each item's latest `judged` line, when it still judges the item's latest revision,
  is appended again with its `verdict` as `ruling`, and nothing reads the old field.
- **Settings.** `.agentics/config.json` keeps its keys; the runner's keys take their defaults.

`tools/migrate-legacy.mjs` is the one-shot copy of a repository's 3.2.0 layout into `.agentics/`:
each effort's files into its `.state/`, its design documents into its `.legacy/`, and its slot
configuration into `config.json`. It never deletes: it lists the committed files it copied for the
user to remove, and a second run copies nothing. `tools/migrate-node-keys.mjs` is the one-shot
rename to bounded keys ([Storage](#storage)): for each node whose key differs from its spelled-out
id, its branch, its worktree and the store's files named after it. `tools/migrate-worktree-keys.mjs`
is the one-shot move of every worktree under `.claude/worktrees/` holding an `agentics/` branch to
the bounded directory that branch names, with `git worktree move`, uncommitted work and all. Each
refuses a target that exists, dry-runs by default, applies with `--yes`, and does nothing the
second time; a 3.x or early-4.x store runs them in that order before `migrate-v5`.

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
