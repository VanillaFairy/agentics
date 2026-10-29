---
name: develop
description: Use when the user asks to build a change, feature or fix through agentics, or to carry on with one already under way — a folder named in plain words, or a settled request. For a request, writes a short root DESIGN.md and builds it once the user approves it; for an approved or prepared folder, an execution in framework-owned worktrees (planned, implemented by rigor, reviewed, merged by folder), a walk of its result where every park is answered by editing a spec, and landing on the user's go. Hands small settled work to task and unsettled work to design. Not for questions (investigate).
---

# develop

The entry for building any folder of an effort: finding it, launching it, walking its result,
landing it. Design: `docs/DESIGN.md#execution-modes`, `docs/DESIGN.md#execution`.

## Vocabulary

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

## Arguments

`[max|normal|low] [--intelligence=<tier>] [--plan-only] [--pause] [--budget <tokens>]
[--pace frugal|balanced|fast] [--base <branch>] <a folder, or the request, in plain words>`

<!-- agentics:verbatim intelligence-tier -->
The dial follows the model this session is running, never how important the work feels:
**Fable → `max`; Opus → `normal`; Sonnet and everything below it → `low`.** When you cannot
tell what you are running, `normal`.

The judging agents belong at the tier of the session driving them. A session that dials itself
up because the change looked significant is charging the user for its own self-assessment; a
Fable session that leaves the dial at `normal` has its work judged less deeply than the session
the user is paying for, and a Sonnet session that claims `normal` bills the user for Opus
judgment nobody asked it for. Only the user moves it off that mapping — a bare leading `max`,
`normal` or `low` token, or `--intelligence=<tier>`.
<!-- /agentics:verbatim -->

The dial is a ceiling on the gates (planner, reviewer, auditor, analyst, ruler); producers run the
cheaper model unless their task's entry set otherwise (`docs/DESIGN.md#model-tier`). At `low`,
say before launching that no strong reader remains anywhere in the loop.

- `--plan-only`: stop at a `parked` checkpoint before anything is dispatched: the compiled plan is
  on disk (`lib/status.mjs show`) and nothing is implemented.
- `--pause`: start no new task after the next merge-batch.
- `--budget`: in tokens; start no new task once what is left cannot cover the execution's measured
  tokens per merged task. Default none.
- `--pace`: `fast` buys parallelism over shared context for speed; default `balanced`.
- `--base`: the branch the effort branch is cut from; default the current branch. A branch or tag
  name, never a sha.

## Step 0 — Which folder

Match the words against every folder of every effort:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/next.mjs" folders --repo .
```

A folder is named as commands name it: the effort's name for its root folder, otherwise its path
from the root (`foundations/entities`). A name equal to the words is the match; otherwise every
folder whose name or title contains them. **One match** is the folder this run builds. **Several**:
ask which with `AskUserQuestion`. **None**: the words are a request, and step 1 takes them.

**Words naming a task or a group**: read its card before anything else, and look up nothing the
card already says:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" node --repo . --effort <e> --node <id>
```

It prints the stop and its reason, the next action a relaunch would take, how many commits the
task's branch lacks of its folder's (say so before relaunching an escalated task that is behind),
the notes earlier sessions left, and the relaunch arguments. **A parked or escalated node** is a
question, not a launch: take it through 4b or 4c now, and relaunch its execution (step 3, on the
card's `relaunch` root) only once the answer is recorded.

For a matched folder, first match:

| the folder | go to |
|---|---|
| an open execution is rooted at it (`node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" list --repo .` lists open executions and their roots) | step 3: the start resumes it, or names the run already going |
| it is the root folder and its status is `integrated` | step 6 |
| its spec is approved or prepared (`node "${CLAUDE_PLUGIN_ROOT}/lib/approval.mjs" state --repo . --effort <e> --folder <id>`) | step 3, a fresh execution |
| anything else | not develop's yet: print the Next line and stop |

## Step 1 — Triage (a request only)

Three questions decide what the root spec's plan holds (`docs/DESIGN.md#triage`):

| question | if **no** |
|---|---|
| Is the intent settled — no approach left to discover? | recommend `agentics:design` and stop |
| Does each item satisfy atomicity (`docs/DESIGN.md#atomicity-when-to-stop-splitting`)? | its entry is a `sub-effort` with `author: planner`: develop's planner writes that spec |
| Is the ground known — finding where the change goes is not part of the work? | its entry is a `sub-effort` with `author: planner` and no `ground`: a survey runs before its planner |

**A removal is tasks, never a sub-effort**, however many files it spans (`docs/DESIGN.md#removals`).
An item that only deletes what nothing reads once it is gone — with the tests, docs, imports and
registrations that name it, and any guard whose target goes with it — is planned as one `verify`
task proving the premise, then `trivial` delete tasks, one per concern, each `after` it. The verify
task's criteria: for every name the deletions remove, ``! git grep -nwF -e <name> -- . ':(exclude)<path>'``
over the tree outside the deleted paths, plus the build and the suite. A name built at runtime
escapes the grep: say so in Evidence. A deletion that takes away behaviour something still reaches
is not a removal.

The mode: **inline** when every task would be `verify`, `trivial`, `tests-only` or `tdd`, the files
it changes are known, the intent settled, nothing is irreversible, and the tasks' summed fit (the task skill's
computation) is within this session's budget — then hand over:
`Skill({ skill: 'agentics:task', args: '<the request, verbatim>' })`. **Dispatched** otherwise.

Say the recommendation in one or two sentences, with the cost where one is measured
(`lib/status.mjs cost --repo . --effort <an earlier effort>` gives `leaf_mean_usd`); with no
measurement, say there is none rather than quoting a constant. **It is a recommendation.** "Run it
anyway" ends the discussion: proceed in the mode the user chose and say nothing more about cost.

## Step 2 — The effort and its root spec (a request only)

<!-- agentics:verbatim effort-store -->
**Efforts — one directory for everything a piece of work produces.** An effort is a subtree of
the execution tree. It lives at `.agentics/<effort>/` in the main checkout, never in a worktree,
and everything scripts write for it — its nodes, their events and its executions —
sits in that directory's `.state/`. Design, challenge-idea and develop are separate sessions by
recommendation, and this directory is how a later one reads what an earlier one established.

Open one at the start. Propose a short name from the user's words and confirm it; `effort.mjs
open` validates it. `effort.mjs slug` turns the words into a first proposal of at most four words:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" slug "<the change or question, in the user's words>"
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" open <repo> <name> --about "<the change or question>" --roots <roots>
```

Opening is idempotent: a later phase adopts the identity the first one recorded.

Free text here (the words, `--about`, `--gap`) is one line of at most 300 characters. Longer
text goes in a file you write with Write, passed as `--about-file <path>` (`slug` takes it too) or
`--gap-file <path>`.

**Evidence is project-wide, and every item carries its own anchors.** The survey, the
existing-solutions search and the challenge review record what they find themselves, as evidence
items in `.agentics/.state/evidence/`: one claim each, with the lines, searches, sources or other
items it rests on. Nothing is recorded by hand, and no return is summarised into the store.

An item's state is computed whenever it is used, never judged by the session. An item no edit has
touched is **standing**. One whose anchored text changed is **suspect** until a cheap re-judge says
whether the change matters. One that no longer holds is **stale**, and its topic is surveyed again.
List what a ground holds with `node "${CLAUDE_PLUGIN_ROOT}/lib/evidence.mjs" items --repo <repo> --ground <path,path>`.

A folder records the items it rests on, and the coverage gaps it rests on them despite, in one
cite naming every survey, solutions or investigate run it rests on: each run's items come from its
result, less any you `--exclude`, so no list of ids passes through you. A folder's latest cite is
its whole citation. Its `evidence.md` is rendered from those records, never written:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/evidence.mjs" cite --repo <repo> --effort <effort> --folder <folder> --from-run <run> [--from-run <run>]… [--exclude <id>]… [--gap "<gap>"]…
node "${CLAUDE_PLUGIN_ROOT}/lib/render.mjs" evidence --repo <repo> --effort <effort> --folder <folder>
```

The program decides what stands, never the session.
<!-- /agentics:verbatim -->

Make sure `.claude/worktrees/` is gitignored; add the line yourself. `.agentics/` ignores itself.

Open the effort as that block says, with `--about "<the request, in the user's words>" --roots .`,
or `--about-file <file> --roots .` when the request is longer than one line of 300 characters.

Write its root spec, `.agentics/<name>/DESIGN.md`. There is no Grill and no challenge here: a
settled request is its own design, and the user approves the spec before anything is built.

```markdown
# <the change, as an imperative>

## Intent

<what the request makes true, in the user's words>. Success criteria: <each item, as the user
put it>.

## Decisions

| id | decision | why |
|---|---|---|
| D1 | <item 1, verbatim> | the request |

## Design

<where the change goes, as triage established it; "Settled by the request." when that is all>

## Plan

- **<name>** — task · realises: D1 · label: <the work> · rigor: <rigor> · expects: <path>, … · reads: <path>, … · runs: <command>, …
  <title: one imperative line>
  <context: self-contained, for an executor who never saw this conversation>
  - [ ] <criterion> — check: `<command>`

## Open questions

## Evidence

No survey ran: the request named its ground.
```

- **Decisions** are the request's items, one per item, `D1`…`Dn`, in the user's words and nothing
  added. Every `Dn` is realised by an entry.
- **Plan**: a `task` for each item triage found atomic with known ground, rigor per
  `docs/DESIGN.md#rigor`, every criterion naming its check (the tests the change clearly affects,
  and from the gray area fast tests only, never big ones) or starting `HUMAN:`, and in `runs` each project
  command the work runs beyond build, tests and its checks (codegen, an asset script); a removal's tasks as
  triage planned them; otherwise one `sub-effort` with `author: planner` realising the items it covers.
- **Evidence**: when the ground is unknown, say so and name the sub-effort whose survey will find it.

Check it until it prints no problems:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/spec.mjs" check --repo . --effort <e> --folder .
```

Show the spec to the user in full and ask with `AskUserQuestion`, the `token` that
`node "${CLAUDE_PLUGIN_ROOT}/lib/approval.mjs" state --repo . --effort <e> --folder .` prints in the
question's own text and exactly the options `Approve` and `Change it`, nothing added to either
label. A change is an edit and a new ask, with the token `state` prints then. While `state` prints
`problems` its token is empty: fix them before asking. On `Approve`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/approval.mjs" approve --repo . --effort <e> --folder .
```

It refuses unless the answer to that token chose `Approve` on the spec as it stands. Step 3's
compile builds it.

## Step 3 — Launch

Compile the folder first. It is idempotent: it builds what is approved or prepared and leaves out
any spec edited since its approval, so the execution keeps the last approved graph:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/compile.mjs" --repo . --effort <e> --folder <id>
```

`ok: false` lists refusals by file and line and wrote nothing: show them and stop; the fix is a
re-spec (step 4c).

A new execution is told the project's commands. Write the ones you know (from the user, the
project's `CLAUDE.md`, its build files) with your Write tool as JSON `{build, typecheck, suite,
suite_fast, test_one}` to a file outside the repository, `test_one` with `{file}` where a test
file's path goes; leave out one you do not know, and the run's investigator establishes it.

Read the effort's `seq` before you start, so the watch misses nothing raised in between: the
`seq <n>` that `node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" list --repo .` prints on the effort's
line. Then start the run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" execute --repo . --detach --effort <e> --folder <id> --intelligence <tier> --commands-file <file> [--pace <pace>] [--base-ref <branch>] [--plan-only] [--pause] [--budget <tokens>] [--confirmed <seq>]
```

- `--folder` is the folder: `.` for the root, else its path from the root. A task or a group runs
  with the folder that holds it.
- `--intelligence` by the dial above: it tiers a new execution's agents; a resume keeps its own.
- `--commands-file`, `--pace` and `--base-ref` shape a new execution only. A start on a folder an
  open execution holds resumes that execution, which keeps the commands, pace and base it began
  with: leave them off.
- `--confirmed` only as step 4a directs.

It prints `{run, pid, log, result_file}` at once: keep `run` (`<e>.<stamp>`, the execution's
stamp after the dot) and `result_file`. A `run_live` refusal names a run already going on this
folder: watch that `run` instead. `launch_failed` is a plugin fault: say so and start the same
command once more; the same refusal again is a plugin defect (`self-improve`). Any other
refusal names the argument it refused: fix it and start again.

The execution works on `agentics/<effort>` and branches and worktrees it owns; it never touches
the user's branch or tree. Uncommitted edits in the user's tree are not in its base — say so when
the tree is dirty. Write the todo list now (step 5); do not poll.

**Follow it.** Right after the start, arm a watch from the `seq` you read, and re-arm it with the
same command whenever it expires, until it prints the run's end:

```
Monitor({ command: 'node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" watch --repo . --run <run> --since <seq>', description: 'agentics run <run>', timeout_ms: 3600000 })
```

Refresh the todo list (step 5) on each line. A re-armed watch prints again a line that still
stands: act on each once. Hold each line to `self-improve`'s signals: it decides when the plugin is the cause.

- `<id> escalated <reason>` or `<id> parked <return>`: a stop of that node alone; the run goes on.
  Read its text on the node's card (step 0). Settle it at once where step 4b or 4c makes it yours,
  else ask the user at once until the answer settles it. A re-spec's approval and compile clears a park; an escalation whose cause is
  dealt with is cleared with `retry` (4b). The running program takes the node up at its next tick.
- `host_stop <dispatch>: <cause> until <time>`: the host is unavailable; the run waits it out and
  resumes the call itself. Nothing to do.
- `fault <channel>: <detail>`: a plugin fault; its node is held for the rest of the run, which goes
  on. Ask nothing: 4b relaunches it once the run ends; one naming a throw goes to `self-improve`.
- `ended <status>: complete=<bool> result=<file>`: read `result_file` and walk it (step 4).
  `ended failed` or `ended launch_failed` is a plugin fault: say so and start the same command once
  more; the same fault again is a plugin defect: take it through `self-improve`.
- `stopped: …`: the run's process is gone. Start the same command again: it resumes.
- `paused: …` and `resumed: …`: a pause (below) taking hold and ending. Nothing to do.
- `unresponsive: …`: the process lives but stopped beating, a plugin defect: take it through `self-improve`.
- `busy: …`, `turning again: …`, `stalled: …`: synchronous work held the run's main thread. Nothing to
  do; a `stalled` over minutes is a spend of time for `self-improve`, its seq naming where.

**Pausing a live run**, when the user asks or a plugin fix must land before more work starts: what
runs finishes and records, nothing new starts, and the run ends `stopped: pause`. The pause stands
over any relaunch until `resume`, which starts a run that has ended again with its own arguments
and prints its `{run, pid, log, result_file}`; arm the watch on it as after a start.

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" pause --repo . --run <run>
node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" resume --repo . --run <run>
```

**Resuming** is starting again. After a stop, a fault, an answer or a kill, from this session or
another, the same start on the same folder resumes the open execution, and each task picks up at
its next undone action (`docs/DESIGN.md#resume-and-checkpoints`); a call cut off mid-way is resumed
in its own session.

## Step 4 — Walk the result, in this order

<!-- agentics:verbatim asking-the-user -->
**Asking the user.** A question states in its own text all the user needs to answer it. One from
a set you hold (findings, defaults, parked nodes, a batch of decisions) opens with its place and
the set's size, `5/24`, counted across calls; a number once given stands, and if the set grows,
later questions carry the new size. An interview, finding each question in the last answer, holds
no set.

**A request for clarification is not an answer.** When the user replies with a question of their
own instead of choosing (what it means, what you foresee, anything they need first), record
nothing for it (the call's other answers stand) and ask it again with the elaboration inside: the
question text answers what they asked, and each option's description says what choosing it
changes. An explanation only in chat beside the dialog, or only in your thinking, which the user
never sees, does not count, nor does a re-ask that refers to one ("given those uses", "as above").
<!-- /agentics:verbatim -->

**First, when the result holds `error`:** preflight refused and nothing was dispatched (the
unreached line `preflight refused (<kind>)`). `no_base`: `--base-ref` names no commit;
`commands_unreadable`: the commands file is not JSON; `git_too_old`: the user updates git;
`store_version`: the user runs the migrations its `message` names, or updates the plugin; any other
`kind`, what its `message` says. Fix it and start again (step 3).

**a. Checkpoint.** `checkpoint {reason, detail, seq}`, non-null, means nothing new was
dispatched; what it found is printed by
`lib/status.mjs checkpoint --repo . --effort <e> --execution <stamp>`.

| `checkpoint.reason` | means | to proceed |
|---|---|---|
| `existing_execution` | an open execution's root is an ancestor or descendant of this one (`detail`) | resume that one (step 3 on its root; `lib/status.mjs list` shows it); relaunch with `--confirmed <checkpoint.seq>` only when both are meant to run |
| `blocking_gaps` | a decision no entry realises, or evidence a node needs was not reached (the checkpoint's `gaps`) | a re-spec (c): an entry that realises the decision — or, on the user's go, relaunch with `--confirmed <checkpoint.seq>` |
| `integration_lost` | an integration branch is gone or lost a recorded merge (the checkpoint's `lost`, each with the branches that hold its merge) | ask the user: restore the branch and relaunch, or, when their branch holds the work, record its landing (`landing.md`, "Already in the user's branch"); `--confirmed` never passes it |
| `outside_work` | an integration branch holds commits no record accounts for (the checkpoint's `branches`) | adopt them: read `outside-work.md` beside this skill and follow it (read it too when the user says work was done by hand), then relaunch; `--confirmed` never passes it |
| `parked` | `--plan-only`: the plan is on disk and nothing was dispatched | show the plan (`lib/status.mjs show`); relaunch without `--plan-only` |

**b. Escalations** — `{id, reason, said}`: its text is on the node's card (step 0), read from the
return `said` names. A stop with a mechanical cause is yours: settle it as the table says, note
what you ruled (below) and name it in your report. Every other stop, and `review_not_converging`
or `not_converging` always, goes to the user: a decision, not information. Once a cause is dealt with, clear the stop,
then relaunch (step 3):

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" retry --repo . --effort <e> --node <id>
```

| `reason` | yours when |
|---|---|
| `blocked`, `review_incomplete` | always — a transient, a judge's miss (a retry asks a fresh one): retry. A `detail` with shell lines (`cat`, `sed`, a script, a `cd`): note that it uses Read, Edit and Write and runs commands as one plain line, then retry |
| `merge_no_progress` | a merge-batch was handed the same children at the same heads again after its whole outcome was taken up: read the leaf's records and the run's notes; a cause in the plugin goes to `self-improve`; then retry |
| `command_not_in_runs` | always — the work runs a project command its entry's `runs` does not name (`detail`): add it there, have the edit ruled (`respec.md`), then retry; never retry first |
| `compile_refused`, `prepare_refused` | a planner-written folder's — retry: its planner is sent the refusals (`detail`) and revises, or returns `contract_changed`, which parks for the user. A problem in a spec the user wrote is a re-spec (`respec.md`) |
| `unread_reference` | always — the producer could not read what `detail` names: when the node's brief now carries it, retry; else put the text in the entry or in a Design part its `cites` names, have the edit ruled (`respec.md`), then retry |
| `fails_full_suite`, `verify_not_converging` | its failures are timeouts or load faults that pass alone: retry once; the same again is the user's |
| `git_hung` | never — a git hung past its ceiling twice at the same head: the user's machine (antivirus scanning the repository, a network drive); retry once they dealt with it |
| `discriminator_undecidable` | it comes only after the file went back to the producer once and still passes at base. A file that only pins behaviour that held at base: rule it a net (below). One that should fail at base, for behaviour the leaf adds: note what it must assert, then retry. The user's only when you cannot tell which |

`discriminator_undecidable`: a changed test file passes at base too. To rule it a regression
net over behaviour that already held, write `{nets: [{file, why}]}` with Write (`why` one line) and run
`node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" net --repo . --effort <e> --node <id> --file <file>` before `retry`. It binds to the
measured head; with every file a net the leaf's criterion checks pin the change, and it lands `undiscriminated`.

**Leave a note on the node** whenever you establish why it stopped, the user rules on it, or you
touch its branch by hand, before you relaunch. One paragraph, plain words; the next session
reads it on the card instead of finding it out again. Write it to a file with Write when it is
longer than one line of 300 characters:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" note --repo . --effort <e> --node <id> --text "<what stopped it, what was done or ruled>"
node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" note --repo . --effort <e> --node <id> --text-file <file>
```

**Faults** — `{id, channel}`: a plugin fault, never a question. Relaunch at once (step 3), asking
nothing; a fault on the same node again is a plugin defect: take it through `self-improve`. A `git_hung` fault is the machine's, never a defect: relaunch.

**c. Parked nodes** — `{id, return, said}`, the question on the node's card (step 0). A park
whose answer the spec already gives is yours, settled as its row below says, and named in your
report: a file the node needs inside its own folder, and code that breaks behaviour the spec
states. Ask the user every other question, one topic at a time,
with your recommendation marked `(Recommended)`. Never answer for them. **The user answers once.**
Open the question first; it prints `asked` and the `token` every question of that one
`AskUserQuestion` call carries in its own text. Record the answer right after:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/answers.mjs" ask --repo . --effort <e> --node <id> [--node <id>…]
node "${CLAUDE_PLUGIN_ROOT}/lib/answers.mjs" record --repo . --effort <e> --asked <asked>
```

The recorded answer is the user's word on every spec it reaches: never ask them to approve what
they answered, and never ask a follow-up to confirm it or to get a token onto it. Any question you
put to the user while the effort has a tree is opened first, this one or not. **Every answer is a re-spec**: carry it into every spec it reaches (the owner of the
fault, its parent, a child or a consumer whose text it decides), have each ruled (below), relaunch.

| `return` | the spec to edit |
|---|---|
| `needs_design` | none yet: run `agentics:design` on that folder; its Approve stage compiles it |
| `needs_decision`, `contract_changed` | the nearest spec at or above the node that the user wrote: a Decisions row in the user's words, and its id in the `realises` of the entry that makes it true. A decision never goes into a spec develop's planner wrote |
| `premise_mismatch`, `needs_respec` | the spec holding the node's entry: correct what the user rules wrong. A file the node needs inside its own folder is yours: add it to the entry's `expects` or `reads` |
| `integration_critical` | judge each drift claim the question lists (`[under]`, `[over]`, `[deviates]`). Behaviour-neutral, low regression risk (a name, a shape): write `{claims: [{claim, why}]}` with Write, each `claim` as listed, and run `node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" accept --repo . --effort <e> --node <id> --file <file>`: no spec edit, no re-review; tell the user what you accepted and why. A critical, or a drift breaking behaviour the spec states: fixing the code to the spec is no decision. Add to the folder's own spec one `task` entry per fix, its criteria the failure scenarios, realising the decisions it restores, and tell the user; never a new sub-effort, whose design costs more than the fix. Only a fix that must choose behaviour the spec does not state is the user's, then the folder's spec as they rule. The next review is narrowed to what the fix moves |
| `cant_tell` | the folder's spec: make the claim decidable, a criterion with a check or a `HUMAN:` criterion the user judges at landing |
| `spec_defect` | the spec the question names: the claim cannot be met as written; the user rules how it changes. On this or `integration_critical`, a folder develop's planner wrote is never ruled: after the edit, relaunch, and the run reviews, prepares and compiles it |
| `contract_drift` | merged work touched a contract the node consumes, and the planner could not take it: no ruler could rule, work already stood on the node's plan when it was ruled affected, or its replan faulted. The consumer's entry: the user rules it unaffected (then clear it with `retry` (b) and edit nothing: the ruling stands until those files change again, and a later ruler is handed it with the answer), re-designs it, or re-slices it |
| `design_spend` | none: a folder develop's planner writes has spent on its design past its allowance, the question naming the numbers. The user goes on (clear it with `retry` (b); the next park comes one allowance later), cuts the scope or hands the work to a task (a re-spec of the entry in the parent spec) |
| `spec_changed` | a folder you wrote was re-approved while work under it was under way, and no ruling found that work untouched: the user rules whether the dispatched work still stands, and re-specs what does not. A folder develop's planner wrote never reaches you with this return: the run hands it back to the planner, which re-derives it |

**Each spec you edited is ruled against the user's answers**, a parent before its child, by the
`rule` program: read `respec.md` beside this skill and follow it.

A park no re-spec cleared (a `contract_drift` ruled unaffected, a `design_spend` the user goes on
past) is cleared with `retry` (b). Then
relaunch (step 3).

**d. Blocked** — `{blocked_by, leaves_n}`: how many tasks were never dispatched because a node they
depend on, or whose files they share, did not land. Name that node as the root cause; do not
relaunch for them while it is still escalated.

**e. Integration.** `integration.branch` and `head_sha`, then `reviews[{target, said}]` per
folder: read each review's return, `.agentics/<e>/.state/executions/<stamp>/returns/<said>.json`,
its `findings` and `claims`. Criticals, and drift claims naming a failure scenario, were parked (c);
a drift naming none and a `cant_tell` parked nothing and wait for landing (`unsettled_claims`);
majors are the user's decision queue, reported as written. A review that ran with planned children missing
carries that caveat on every finding — say so.

**f. `HUMAN:` criteria.** `node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" land --repo . --effort <e>
--action check` is read-only; put every entry of its `human` in front of the user, verbatim, prefix
included.

**g. What was built.** `implemented` per task: rigor and role (a `red` task's tests are required to
fail), rounds, `salvaged` — adopted from an earlier run, not done now; say which; `undiscriminated`
— no test of it discriminates, its `nets` ruled by the user; say so.

### Reporting — binding

- **Never report success while `coverage.complete` is false.** `coverage.unreached` leads —
  escalated, parked, blocked, not merged, failed channels — then what merged.
- Verdicts are reported as computed: never softened, recomputed or paraphrased.
- Cost is `result.cost`, measured, per model in `by_model`. Its `unmeasured` dispatches are
  unreported, never zero.

## Step 5 — Progress

The todo list is a view of the event logs: write it on launch, on every watch line and on return:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" todos --repo . --effort <e> --execution <stamp>
```

Write each item with `TaskCreate` / `TaskUpdate` (subject, `activeForm`, status as printed). **If
the Task tools are not available**, use `TodoWrite` in the printed order and say that you fell
back. The list is a view: refresh it from the command, never move an item by hand.

## Step 6 — Landing

When the root folder is `integrated`, or the user says to land what exists, read `landing.md`
beside this skill and follow it. That is the only place the user's branch moves.

## The Next line

<!-- agentics:verbatim next-footer -->
**End with the Next line.** Whatever this command did, finished, stopped, refused or found itself
in the wrong place, the last thing you print is the Next line, computed and never composed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/next.mjs" --repo . --effort <effort>
```

Print its output as it stands. With no effort in hand, drop `--effort` and print every effort's
line. **Invoked where it does not fit**, a folder not in the state this command acts on, run it
first, before anything else, and point to the command it names instead of going on.
<!-- /agentics:verbatim -->
