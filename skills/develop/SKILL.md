---
name: develop
description: Use when the user asks to build a change, feature or fix through agentics, or to carry on with one already under way — triage, then an execution of a subtree of the effort's tree in framework-owned worktrees (planned, implemented by rigor, reviewed, merged by composite), a walk of its result, and landing on the user's go. Hands small settled work to task and unsettled work to design. Not for questions (investigate).
---

# develop

The entry for executing any subtree of an effort: triage, launch, result walk, landing.
Design: `docs/DESIGN.md#execution-modes`, `docs/DESIGN.md#execution`.

Invoking this skill **is** the user's opt-in for the `Workflow` tool. Do not ask again.

## Arguments

`[max|normal|low] [--intelligence=<tier>] [--effort <slug>] [--root <node-id>] [--resume <stamp>]
[--land] [--plan-only] [--pause] [--no-progress] [--pace frugal|balanced|fast] [--base <ref>] <the request>`

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
cheaper model unless their node's author set otherwise (`docs/DESIGN.md#model-tier`). At `low`,
say before launching that no strong reader remains anywhere in the loop.

- `--effort` — an existing effort; a design hand-off always names one. Otherwise step 2 opens one.
- `--root` — the subtree to execute; default `.`, the effort root.
- `--resume <stamp>` — relaunch that execution: skip steps 1 and 2, go to step 3 with its stamp.
- `--land` — go straight to step 6 for the effort.
- `--plan-only` — plan the subtree and stop at a `parked` checkpoint; nothing is implemented.
- `--pause` — start no new leaf after the next merge-batch.
- `--no-progress` — the couriers do not move todos; the session derives the list (step 5).
- `--pace` — `fast` buys parallelism over shared context for speed; default `balanced`.
- `--base` — the named ref the effort branch is cut from; default the current HEAD. A branch or
  tag, never a sha.

## Step 1 — Triage (fresh work only)

A resume, or an effort whose root already has nodes, skips this: it was triaged when its root was
written. Three questions fix the root's kind (`docs/DESIGN.md#triage`):

| question | if **no** |
|---|---|
| Is the intent settled — no approach left to discover? | a design node: recommend `agentics:design` |
| Does it satisfy atomicity (`docs/DESIGN.md#atomicity-when-to-stop-splitting`)? | a composite: the planner decomposes it |
| Is the ground known — finding where the change goes is not part of the work? | `ground_known: false`: a survey runs before planning |

The mode: **inline** when every leaf would be `verify`, `trivial`, `tests-only` or `tdd`, the locus
is known, the intent settled, nothing is irreversible, and the leaves' summed fit (the task skill's
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

## Step 2 — The effort and its root

<!-- agentics:verbatim effort-store -->
**Efforts — one directory for everything a piece of work produces.** An effort is a subtree of
the execution tree. It lives at `.agentics/<effort>/` in the main checkout, never in a worktree,
and everything scripts write for it — its nodes, their events, its evidence and its executions —
sits in that directory's `.state/`. Design, probe and develop are separate sessions by
recommendation, and this directory is how a later one reads what an earlier one established.

Open one at the start. Propose a short name from the user's words and confirm it;
`effort.mjs open` validates it. `effort.mjs slug` turns the words into a first proposal of at
most four words:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" slug "<the change or question, in the user's words>"
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" open <repo> <name> --about "<the change or question>" --roots <roots>
```

Opening is idempotent: a later phase adopts the identity the first one recorded.

Record a survey's or a probe's return into the effort's `.state/evidence/` by writing the workflow's
result object to a file and passing the path — **verbatim, never summarised** — as soon as it
returns, before anything spends it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" record <repo> <slug> survey|probe --file <path.json>
```

`effort.mjs read <repo> <slug> [--latest survey|probe]` reads the effort back.

**A recorded return is context, never evidence — with one computed exception.** Recording a
survey anchors it to its commit and the ground its topics searched, and
`effort.mjs standing <repo> <slug>` answers from git whether it reported complete coverage and
whether any commit or uncommitted edit has touched that ground since. A standing survey is reused
instead of bought again; one that does not stand is bought again in full. The program decides that
a survey stands, never the session.
<!-- /agentics:verbatim -->

Make sure `.claude/worktrees/` is gitignored; add the line yourself. `.agentics/` ignores itself.

When the effort has no nodes yet (`node "${CLAUDE_PLUGIN_ROOT}/lib/tree.mjs" show --repo . --effort
<e> --json` lists none), write its root — a composite `.` whose `defines` are the request's items
as decisions, one per item, `D1`…`Dn`, in the user's words and nothing added:

```json
[{ "id": ".", "title": "<imperative>", "intent": "<what the request makes true, the user's words>",
   "kind": "composite", "defines": [{ "id": "D1", "text": "<item 1, verbatim>" }],
   "ground": ["<paths known>"], "ground_known": true }]
```

- `ground_known: false` when finding where the change goes is part of the work.
- Children are the planner's. Only when triage already knows the one leaf, add it in the same
  batch: `{id, title, intent, kind: 'leaf', decisions: ['D1', …], acceptance: [{text, check,
  decisions}], locus, reads, rigor}` — every `Dn` realised, every criterion naming its check.

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/tree.mjs" add --repo . --effort <e> --file <path.json> --by session
```

`ok: false` lists the problems and wrote nothing: fix the nodes. `warnings` (atomicity, gaps,
untraced criteria) go to the user. A design node already at the root is left as it is.

## Step 3 — Launch

Mint the stamp with `date -u +%Y%m%d-%H%M%S`; a resume reuses its stamp. Then:

```
Workflow({ name: 'agentics:agentics-develop', args: { repo: '.', effort, root, execution, plugin_root, intelligence, progress, pace, plan_only, pause, base_ref, commands, retry_escalated, confirmed_duplicate, confirmed_gaps, confirmed_stale } })
```

- `plugin_root` is this plugin's absolute root (`${CLAUDE_PLUGIN_ROOT}`) — required.
- `intelligence` on a fresh execution only. A resume passes none: it adopts its envelope.
- `commands` only when the user named them: `{build, typecheck, suite, test_one}`.
- The confirmations and `retry_escalated` only as step 4 directs.

**Record the `runId`.** The execution works on `agentics/<effort>` and branches and worktrees it
owns; it never touches the user's branch or tree. Uncommitted edits in the user's tree are not in
its base — say so when the tree is dirty. While it runs the todo list moves live; do not poll.

**Resuming.** Inside this conversation, `resumeFromRunId` with the same args replays finished
agents from cache. After a hard kill, or from another session, relaunch with the same `execution`:
preflight adopts the envelope and each leaf resumes at its next undone action
(`docs/DESIGN.md#resume-and-checkpoints`). Every resume is the same launch with the same stamp.

## Step 4 — Walk the result, in this order

**a. Checkpoint.** Non-null means nothing new was dispatched.

| `checkpoint.reason` | means | to proceed |
|---|---|---|
| `existing_execution` | an open execution's root is an ancestor or descendant of this one (`detail`) | resume that one by its stamp (`lib/status.mjs list` shows it); relaunch with `confirmed_duplicate: true` only when both are meant to run |
| `blocking_gaps` | a decision no child realises, or evidence a node needs was not reached (`detail`, `notes`) | fix the tree — a child realising the decision, through design or the planner — or, on the user's go, relaunch with `confirmed_gaps: true` |
| `parked` | `plan_only`, or nodes await the user | show the plan (`lib/status.mjs show`) or answer them (c); relaunch |
| `stale` | the user's branch moved under the plan; `drift` lists per leaf the `writes` and `reads` that moved | the user rules per leaf; relaunch with `confirmed_stale: true` for "still valid", revise a leaf (c) that needs replanning first |
| anything else | the launch failed (`bad_input`, `preflight_failed`, `no_such_node`, a refusal) | fix what `detail` says; relaunch |

**b. Escalations** — `{id, reason, detail}`, each to the user. They are decisions, not
information; do not resolve them yourself. Once a cause is dealt with, relaunch with the same
`execution` and `retry_escalated: [<ids>]`.

**c. Parked nodes** — `{id, return, question}`. Ask the user each question, one topic at a time,
with your recommendation marked `(Recommended)`. Never answer for them. Write each answer:

- **a fact the node needed** (a clarified criterion, a ruled premise): a revision of that node.
  Take its row from `lib/tree.mjs show --repo . --effort <e> --root <id> --json`, change what the
  answer changes (`context`, `acceptance`, `locus`), and write the **whole** node back — a revision
  replaces the node — with `add … --by session --reason answered`;
- **a decision** (`needs_decision`, `contract_changed`): a `defines` entry `{id, text}` in the
  user's words on the design or composite node that owns it, and its id in the `decisions` of the
  node that realises it — both revisions in one batch, `--reason answered`;
- **`needs_design`**: run `agentics:design` on that node, and resume once it has children;
- **`integration_critical`**: the user rules which child is wrong; write the ruling as a revision
  of that composite (a fix leaf beneath it, or the ruling in its `context`), `--reason answered`.

Then relaunch with the **same** `execution`.

**d. Blocked** — `{id, blocked_by}`: never dispatched because what they depend on did not land.
Name the root cause; do not relaunch for them while it is still escalated.

**e. Integration.** `integration.branch` and `head_sha`, then `reviews` per composite: criticals
were parked (c); majors are the user's decision queue, reported as returned. A review that ran with
planned children missing carries that caveat on every finding — say so.

**f. `HUMAN:` criteria.** `node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" land --repo . --effort <e>
--action check` is read-only; put every entry of its `human` in front of the user, verbatim, prefix
included.

**g. What was built.** `implemented` per leaf: rigor and role (a `red` leaf's tests are required to
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

When the execution's root is `integrated`, or the user says to land what exists, read
`landing.md` beside this skill and follow it. That is the only place the user's branch moves.
