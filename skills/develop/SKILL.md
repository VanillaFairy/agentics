---
name: develop
description: Use when the user asks to build a change, feature or fix through agentics, or to carry on with one already under way — a folder named in plain words, or a settled request. For a request, writes a short root DESIGN.md and builds it once the user approves it; for an approved or prepared folder, an execution in framework-owned worktrees (planned, implemented by rigor, reviewed, merged by folder), a walk of its result where every park is answered by editing a spec, and landing on the user's go. Hands small settled work to task and unsettled work to design. Not for questions (investigate).
---

# develop

The entry for building any folder of an effort: finding it, launching it, walking its result,
landing it. Design: `docs/DESIGN.md#execution-modes`, `docs/DESIGN.md#execution`.

Invoking this skill **is** the user's opt-in for the `Workflow` tool. Do not ask again.

## Vocabulary

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
  `<folder>/<task>/DESIGN.md`. Compile then builds it as a composite that realises the task's
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

## Arguments

`[max|normal|low] [--intelligence=<tier>] [--resume <stamp>] [--plan-only] [--pause]
[--no-progress] [--pace frugal|balanced|fast] [--base <ref>] <a folder, or the request, in plain words>`

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

The dial is a ceiling on the gates (planner, reviewer, auditor, analyst); producers run the
cheaper model unless their task's entry set otherwise (`docs/DESIGN.md#model-tier`). At `low`,
say before launching that no strong reader remains anywhere in the loop.

- `--resume <stamp>`: relaunch that execution: go to step 3 with its stamp.
- `--plan-only`: plan the folder and stop at a `parked` checkpoint; nothing is implemented.
- `--pause`: start no new task after the next merge-batch.
- `--no-progress`: the couriers do not move todos; the session derives the list (step 5).
- `--pace`: `fast` buys parallelism over shared context for speed; default `balanced`.
- `--base`: the named ref the effort branch is cut from; default the current HEAD. A branch or
  tag, never a sha.

## Step 0 — Which folder

Match the words against every folder of every effort:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/next.mjs" folders --repo .
```

A folder is named as commands name it: the effort's name for its root folder, otherwise its path
from the root (`foundations/entities`). A name equal to the words is the match; otherwise every
folder whose name or title contains them. **One match** is the folder this run builds. **Several**:
ask which with `AskUserQuestion`. **None**: the words are a request, and step 1 takes them.

For a matched folder, first match:

| the folder | go to |
|---|---|
| an open execution is rooted at it (`node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" list --repo .` lists open executions and their roots) | step 3 with that execution's stamp: this is the resume |
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

The mode: **inline** when every task would be `verify`, `trivial`, `tests-only` or `tdd`, the locus
is known, the intent settled, nothing is irreversible, and the tasks' summed fit (the task skill's
computation) is within this session's budget — then hand over:
`Skill({ skill: 'agentics:task', args: '<the request, verbatim>' })`. **Dispatched** otherwise.

Say the recommendation in one or two sentences, with the cost where one is measured
(`lib/status.mjs cost --repo . --effort <an earlier effort>` gives `leaf_mean_tokens`); with no
measurement, say there is none rather than quoting a constant. **It is a recommendation.** "Run it
anyway" ends the discussion: proceed in the mode the user chose and say nothing more about cost.

Anything you dispatch yourself, outside the workflow, is paid for by the turn:

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

## Step 2 — The effort and its root spec (a request only)

<!-- agentics:verbatim effort-store -->
**Efforts — one directory for everything a piece of work produces.** An effort is a subtree of
the execution tree. It lives at `.agentics/<effort>/` in the main checkout, never in a worktree,
and everything scripts write for it — its nodes, their events and its executions —
sits in that directory's `.state/`. Design, challenge-idea and develop are separate sessions by
recommendation, and this directory is how a later one reads what an earlier one established.

Open one at the start. Propose a short name from the user's words and confirm it;
`effort.mjs open` validates it. `effort.mjs slug` turns the words into a first proposal of at
most four words:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" slug "<the change or question, in the user's words>"
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" open <repo> <name> --about "<the change or question>" --roots <roots>
```

Opening is idempotent: a later phase adopts the identity the first one recorded.

**Evidence is project-wide, and every item carries its own anchors.** The survey, the
existing-solutions search and the challenge review record what they find themselves, as evidence
items in `.agentics/.state/evidence/`: one claim each, with the lines, searches, sources or other
items it rests on. Nothing is recorded by hand, and no return is summarised into the store.

An item's state is computed whenever it is used, never judged by the session. An item no edit
has touched is **standing**. One whose anchored text changed is **suspect** until a cheap
re-judge says whether the change matters. One that no longer holds is **stale**, and its topic
is surveyed again. List what a ground holds with
`node "${CLAUDE_PLUGIN_ROOT}/lib/evidence.mjs" items --repo <repo> --ground <path,path>`.

A folder records the items it rests on, and the coverage gaps it rests on them despite. Its
`evidence.md` is rendered from those records, never written:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/evidence.mjs" cite --repo <repo> --effort <effort> --folder <folder> --items <id,id> [--gap "<gap>"]
node "${CLAUDE_PLUGIN_ROOT}/lib/render.mjs" evidence --repo <repo> --effort <effort> --folder <folder>
```

The program decides what stands, never the session.
<!-- /agentics:verbatim -->

Make sure `.claude/worktrees/` is gitignored; add the line yourself. `.agentics/` ignores itself.

Propose a short effort name the user confirms or changes (`^[a-z0-9][a-z0-9-]*$`, no `--`, at
most 120 characters), and open it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" open . <name> --about "<the request, in the user's words>" --roots .
```

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

- **<name>** — task · realises: D1 · rigor: <rigor> · locus: <path>, … · reads: <path>, …
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
  `docs/DESIGN.md#rigor`, every criterion naming its check or starting `HUMAN:`; otherwise one
  `sub-effort` with `author: planner` realising the items it covers.
- **Evidence**: when the ground is unknown, say so and name the sub-effort whose survey will find it.

Check it until it prints no problems:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/spec.mjs" check --repo . --effort <e> --folder .
```

Show the spec to the user in full and ask, with `AskUserQuestion`: **Approve and build**, or
**Change it**. Nothing is recorded until the user approves in so many words. A change is an edit
and a new ask. On approval:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/approval.mjs" approve --repo . --effort <e> --folder .
```

Step 3's compile builds it.

## Step 3 — Launch

Compile the folder first. It is idempotent: it builds what is approved or prepared and leaves out
any spec edited since its approval, so the execution keeps the last approved graph:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/compile.mjs" --repo . --effort <e> --folder <id>
```

`ok: false` lists refusals by file and line and wrote nothing: show them and stop; the fix is a
re-spec (step 4c). Then mint the stamp with `date -u +%Y%m%d-%H%M%S`; a resume reuses its stamp.

```
Workflow({ scriptPath: '${CLAUDE_PLUGIN_ROOT}/service-workflows/execute-approved-plan-in-worktrees.workflow.js', args: { repo: '.', effort, root: <folder id>, execution, plugin_root, intelligence, progress, pace, plan_only, pause, base_ref, commands, retry_escalated, confirmed_duplicate, confirmed_gaps, confirmed_stale } })
```

- `plugin_root` is this plugin's absolute root (`${CLAUDE_PLUGIN_ROOT}`) — required.
- `root` is the folder id: `.` for the root folder.
- `intelligence` on a fresh execution only. A resume passes none: it adopts its envelope.
- `commands` only when the user named them: `{build, typecheck, suite, test_one}`.
- The confirmations and `retry_escalated` only as step 4 directs.

**Record the `runId`.** The execution works on `agentics/<effort>` and branches and worktrees it
owns; it never touches the user's branch or tree. Uncommitted edits in the user's tree are not in
its base — say so when the tree is dirty. While it runs the todo list moves live; do not poll.

**Resuming.** Inside this conversation, `resumeFromRunId` with the same args replays finished
agents from cache. After a hard kill, or from another session, relaunch with the same `execution`:
preflight adopts the envelope and each task resumes at its next undone action
(`docs/DESIGN.md#resume-and-checkpoints`). Every resume is the same launch with the same stamp.

## Step 4 — Walk the result, in this order

**a. Checkpoint.** Non-null means nothing new was dispatched.

| `checkpoint.reason` | means | to proceed |
|---|---|---|
| `existing_execution` | an open execution's root is an ancestor or descendant of this one (`detail`) | resume that one by its stamp (`lib/status.mjs list` shows it); relaunch with `confirmed_duplicate: true` only when both are meant to run |
| `blocking_gaps` | a decision no entry realises, or evidence a node needs was not reached (`detail`, `notes`) | a re-spec (c): an entry that realises the decision — or, on the user's go, relaunch with `confirmed_gaps: true` |
| `parked` | `plan_only`, or nodes await the user | show the plan (`lib/status.mjs show`) or answer them (c); relaunch |
| `stale` | the user's branch moved under the plan; `drift` lists per task the `writes` and `reads` that moved | the user rules per task; relaunch with `confirmed_stale: true` for "still valid", or re-spec a task that needs replanning first (c) |
| anything else | the launch failed (`bad_input`, `preflight_failed`, `no_such_node`, a refusal) | fix what `detail` says; relaunch |

**b. Escalations** — `{id, reason, detail}`, each to the user. They are decisions, not
information; do not resolve them yourself. Once a cause is dealt with, relaunch with the same
`execution` and `retry_escalated: [<ids>]`.

**c. Parked nodes** — `{id, return, question}`. Ask the user each question, one topic at a time,
with your recommendation marked `(Recommended)`. Never answer for them. **Every answer is a
re-spec**: edit the spec that owns the fault, have it re-approved, recompile, relaunch.

| `return` | the spec to edit |
|---|---|
| `needs_design` | none yet: run `agentics:design` on that folder; its Approve stage compiles it |
| `needs_decision`, `contract_changed` | the nearest spec at or above the node that the user wrote: a Decisions row in the user's words, and its id in the `realises` of the entry that makes it true. A decision never goes into a spec develop's planner wrote |
| `premise_mismatch`, `needs_respec` | the spec holding the node's entry: correct what the user rules wrong |
| `integration_critical` | the folder's spec: the user rules which part is wrong; a `task` entry that fixes it, or the corrected criterion |
| `spec_defect` | the spec the question names: the claim cannot be met as written; the user rules how it changes |
| `cant_tell` | the folder's spec: make the claim decidable, a criterion with a check or a `HUMAN:` criterion the user judges at landing |
| `contract_drift` | the consumer's entry: the user rules it unaffected (then relaunch with `retry_escalated: [<id>]` and edit nothing), re-designs it, or re-slices it |
| `spec_changed` | compile parked a folder you wrote because its spec was re-approved while work under it was under way: the user rules whether the dispatched work still stands, and re-specs what does not. A folder develop's planner wrote never reaches you with this return: the run hands it back to the planner, which re-derives it |

For each spec you edited: show the change, and on the user's approval in so many words run
`approval.mjs approve` for that folder and the compile of step 3. Compile's `answered` lists the
parks the re-approval cleared; a park it did not clear (no spec changed, as with a
`contract_drift` ruled unaffected) is cleared by relaunching with `retry_escalated: [<id>]`. Then
relaunch with the **same** `execution`.

**d. Blocked** — `{id, blocked_by}`: never dispatched because what they depend on did not land.
Name the root cause; do not relaunch for them while it is still escalated.

**e. Integration.** `integration.branch` and `head_sha`, then `reviews` per folder: criticals,
and claims that did not hold, were parked (c); majors are the user's decision queue, reported as
returned. A review that ran with
planned children missing carries that caveat on every finding — say so.

**f. `HUMAN:` criteria.** `node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" land --repo . --effort <e>
--action check` is read-only; put every entry of its `human` in front of the user, verbatim, prefix
included.

**g. What was built.** `implemented` per task: rigor and role (a `red` task's tests are required to
fail), rounds, `salvaged` — adopted from an earlier invocation, not done now; say which.

### Reporting — binding

- **Never report success while `coverage.complete` is false.** `coverage.unreached` leads —
  escalated, parked, blocked, not merged, failed channels — then what merged.
- Verdicts are reported as computed: never softened, recomputed or paraphrased.
- Cost is `result.cost`, measured. A `null` token count is unreported, never zero.

## Step 5 — Progress without the couriers

With `--no-progress`, or when the result's notes say the couriers had no task tools, derive the
list on launch, on wake and on return:

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
