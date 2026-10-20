---
name: design
description: Use when the intent of a change is not settled — a new subsystem, a migration, an API, a reshaping of something that exists — or when develop parks a sub-effort for design. Runs one loop (analyze, grill, draft, review, approve, move on) for one folder of an effort at a time, at any depth, writes that folder's DESIGN.md with the user, records their approval and compiles it into the execution tree agentics:develop builds. Not for a settled change (develop, task), not for a question (investigate).
---

# design

An effort is a folder hierarchy under `.agentics/<effort>/`, and every folder holds one spec,
`DESIGN.md`, which you write with the user. This skill runs the same loop for one folder at a time,
at any depth. Each stage writes what it settles into the spec at once, so the spec is the
session's memory and nothing needed later lives only in the conversation.
Design: `docs/DESIGN.md#design`.

This skill starts no agent: every agent it needs runs in a program it starts and whose result it
reads (Running a program, below). It is session-driven because grilling is interactive: no program
or agent can talk to the user.

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

## When not to use it

- The intent is settled and the user wants it built: `develop`, or `task` when it is small.
- The user asked a question: `investigate`.
- The answer fits in a paragraph: write the paragraph.

## Which folder

`/agentics:design <words>`. Match the words against every folder of every effort:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/next.mjs" folders --repo .
```

Each line names a folder as commands name it (the effort's name for a root folder, otherwise its
path from the root, `foundations/entities`), its effort, its approval state and its title. A name
equal to the words is the match; otherwise every folder whose name or title contains them.
**One match** resumes that folder. **Several**: ask which with `AskUserQuestion`. **None**: propose
a new effort with a short name the user confirms or changes (`^[a-z0-9][a-z0-9-]*$`, no `--`, at
most 120 characters), and open it, with `--about-file <file>` in place of `--about` when the change
is longer than one line of 300 characters:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" open . <name> --about "<the change, in the user's words>" --roots .
```

A sub-effort's folder sits under its parent's and carries the name its parent's plan entry gives
it: `.agentics/<effort>/<path>/DESIGN.md`. When its turn comes, create it; it starts as a skeleton
with the six headings, and the loop fills it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" folder . <e> <path> --title "<the entry's title>"
```

To rename a sub-effort, never move the folder by hand:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" rename . <e> --from <path> --to <new path>
```

It renames the folder, the entry, every `after` naming it and every decision id carrying its
prefix, and carries each approval under the new name. It is refused once work under the folder was
dispatched. The parent's spec, whose plan changed, goes back through Review.

A folder whose parent entry says `author: planner`, or that holds a promoted task, belongs to
develop's planner: say so and point to `/agentics:develop`.

**Resume at the earliest unfinished stage**, read from the spec and the ledger, first match:

| the folder | resume at |
|---|---|
| no `DESIGN.md`, or its Intent is empty | Analyze |
| a `blocking` open question | Grill |
| Design or Plan empty, or `lib/spec.mjs check` reports problems | Draft |
| `state` is `none` or `edited` | Review |
| approved, and its compiled hash is not its current hash | Approve (compile only) |
| otherwise | Move on |

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/spec.mjs" check --repo . --effort <e> --folder <id>
node "${CLAUDE_PLUGIN_ROOT}/lib/approval.mjs" state --repo . --effort <e> --folder <id>
```

**Settled context.** Read the specs of the folder's ancestors first. Their Intent and Decisions are
settled: read, never re-litigated here. **The ancestor rule:** an answer or a change that
contradicts an ancestor's decision becomes a `blocking` question citing that decision, and the fix
happens in the ancestor's spec, in that folder's own loop.

## The spec

Headings, in this order. Everything is prose except the Decisions rows, the open-question bullets
and the plan entries, which `lib/spec.mjs check` parses:

- `# <title>`
- `## Intent`: who it is for, the outcome, success criteria, boundaries, what is out of scope; the
  ancestor specs named as settled context.
- `## Decisions`: one row per decision, `| <id> | <the decision, in the user's words> | <their
  why> |`. Ids are unique across the effort: `D<n>` in the root folder; below it, the folder id
  with `/` written `.`, then `.D<n>` (`foundations.entities.D3`).
- `## Design`: this layer's design at its level of detail, which is only what the layer below
  needs from it. A high layer talks in parts and how they interact; a low one in interfaces and
  data shapes. Diagrams where they show more than prose.
- `## Plan`: the entries, below.
- `## Open questions`: `- **blocking:** …`, `- **parked (reopens at <x>):** …`,
  `- **lookup:** …`, `- **compost:** …`. A `lookup` that gates work becomes a `task` entry the
  gated entry lists in `after`.
- `## Evidence`: a pointer to `evidence.md`, with every coverage gap named and what rests on it.

**Status never goes into a spec**: no ticked box, no "approved", no "done". State is derived.

```
- **<name>** — <sub-effort | task | deferred | dropped> · realises: D1, D2 · after: <sibling>, /<path>
  · author: you|planner · provides: <contract> (<path>, …) · consumes: <contract>
  · rigor: <rigor> · locus: <path>, … · reads: <path>, …
  · label: <the work in free text, at most 16 characters: World tests, not world-red>
  <title: one imperative line>
  <context: free prose>
  - [ ] <criterion> — check: `<command>`
  - [ ] HUMAN: <a criterion the user judges>
```

`author` is for a `sub-effort` only. `you`, the default, means it comes back through this loop
when it is next. `planner` lets develop's planner write its spec, which then passes an adversarial
review instead of the user's approval: only for a part the user says may go autonomously, and its
spec may state no decision. `rigor`, `locus`, `reads` and criteria are for a `task` only (rigor per
`docs/DESIGN.md#rigor`); a test check runs the tests that decide its criterion: those the change
clearly affects, and from the gray area fast tests only, never big ones. A `green` task's criteria
add no behaviour: each it states is pinned by a criterion of its red, in a test file red's locus
holds. A `dropped` entry's decisions are recorded as not realised, accepted; a `deferred` entry
compiles to nothing. A contract's name is effort-unique.

Past a handful of tasks, gather the ones that belong together by concern (a subsystem, an area of
the code, work reviewed side by side) under `### <name> — group · after: …`, its title on the next
line. Entries above the first group heading belong to the folder; each one below a heading belongs
to that group. A group holds tasks only, has no spec, and its `after` binds all its tasks. Names
are unique across the plan, groups included, and `after` may name a group.

## Running a program

Every agent this skill needs runs in a program. Text longer than a phrase (a question, a
capability, the drafts' excerpts) goes into a file you write outside the repository with the Write
tool, and its path is the flag's value. Start a program detached, from the repository root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" <program> --repo . --detach --<arg> <value> …
```

It prints `{ok, run, pid, log, result_file}` at once. Keep `run` and `result_file`, and follow the
run with the Monitor tool, re-armed on expiry until it prints its end:

```
Monitor({ command: 'node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" watch --repo . --run <run> --since 0', description: '<program> <run>', timeout_ms: 3600000 })
```

It prints a line per host stop and fault, then `ended done: complete=<bool> result=<file>`: read
`result_file` with the Read tool. `stopped: …` means the run's process died: start the same
command again, with the same files, and it resumes under its own id, calling only what never
returned. `ended failed` (the `fault program:` line says why) and a `launch_failed` refusal are
plugin faults, never the user's decision: say so and start the command once more; the same fault
again is a plugin defect, reported with what it left undone. A `run_live` refusal names a run of
the same program and scope already going: watch that one. Any other refusal's `message` says what
to fix.

## The loop

Analyze → Grill → Draft → Review → Approve → Move on. Leave a stage only when its gate holds.

### Analyze. Gate: the user confirms or corrects the understanding

Write the Intent back: what the user said, kept apart from what you assume. Then evidence for this
layer's question: what it needs to know about the system as it is, never the design question
itself, since the survey gathers and never concludes. Write the question to a file, and what you
have already read toward it (each file or range and what it says) to another, then start `survey`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" survey --repo . --detach --question-file <file> --read-file <file> --roots . --ground <path,path> --intelligence <tier>
```

`--read-file` makes it plan only the gaps your reading leaves (omit it if you read nothing); `--ground`,
the paths this layer touches (omit if unknown), lets it reuse standing items and re-judge only drift.

When the layer would **build a capability** (a parser, a scheduler, a cache, a protocol client),
write the capability to a file and start the `solutions` program in the same message, so both run
at once:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" solutions --repo . --detach --capability-file <file> --roots . --constraints "<language, runtime, licence policy>" --intelligence <tier>
```

Skip it for wiring or reshaping what exists, and read what the repo already carries first. Watch
both runs and read both results. The survey's `context` file opens with a digest of at most 10 KB,
every topic in the question's order: read it first, then only the parts of the full items, risks,
history and docs below it that you need; its `items` are their ids, its `coverage` what it reached.
The search's `summary` file holds every candidate with its facts, `counts` how many of each and
`coverage` what it reached. Incomplete coverage on ground the design would build from scratch is a
`blocking` question. Whatever the repository, its history or vendor documentation can answer is
answered by evidence; the user is asked only what only the user knows: intent, priorities, taste,
real-world limits.

Once the user has confirmed the understanding, record what this folder rests on: one `cite`
naming the survey's run and, when it ran, the search's, each as a `--from-run`, with every entry
of their results' `coverage.unreached` as a `--gap`, then render `evidence.md`. The commands are
in the effort-store block below.

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

**Scale check**, before the first question: say whether the work looks small and settled enough
for `/agentics:task`, and why. The user can override either way. Complexity found later never
downgrades the path.

### Grill. Gate: no `blocking` question is open

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

- **One question at a time**, in dependency order, whatever constrains other decisions first.
  Ask through `AskUserQuestion`, your recommendation first and marked `(Recommended)`, its reason
  in the option's description, grounded in the evidence.
- **Each answer goes into Decisions at once**, in the user's words with their why, before the next
  question. The user is the only author: a recommendation they did not answer is not adopted.
- **Default what qualifies.** A choice that is cheap to reverse and that nothing else consumes is
  not asked. Record it under Open questions as `- **parked (reopens at Review):** default: <the
  choice> — <why you recommend it>`; the user rules on every default together at Review.
- **Approach drafts, when the decision space is open.** Write one file holding the excerpts every
  draft needs (the evidence, the decisions so far, this layer's question, and the candidates the
  solutions run found when there are any) and start the `drafts` program with two or three
  stances: `minimal-change` (the smallest change that satisfies the decisions so far),
  `long-horizon` (the growth axes the grilling named), and `adopt-dont-build` only when the
  solutions run found candidates:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" drafts --repo . --detach --question-file <file> --stances minimal-change,long-horizon,adopt-dont-build --intelligence <tier>
  ```

  Each stance's analyst drafts `{approach, shape, contracts, cites, risks}`, and the program
  records every draft as an `approach` return as it comes back. Show each result's `draft` with
  its trade-offs, your recommendation first. A stance whose `draft` is `null` failed, and
  `coverage.failed_channels` names it; a draft that cites no evidence is an opinion. The one the
  user chooses shapes the Design section, and the choice is a Decisions row. The rest are
  discarded. When the layer has one obvious shape, skip the drafts and say so.
- **Grade every open question**: `blocking` (this stage cannot be passed without it),
  `parked (reopens at <x>)`, `lookup` (go and look), `compost` (recorded, not pursued).
- A changed decision is rewritten in place with its reason. A new answer contradicting a decision
  other entries lean on is shown beside it, with what depends on which, for the user to rule.
- **An answer that changes a spec compiled before** (a parent's plan, a decision another folder
  realises) is opened and recorded with `lib/answers.mjs`, as develop's step 4c does, and carried
  into every spec it reaches. Those specs are ruled against it at Approve; never ask again for it.

A spec with an open `blocking` question does not hand off: not to Draft, not to `develop`, not to
"we can settle that during the build".

### Draft. Gate: `lib/spec.mjs check` passes and no decision is unrealised

Write Design and Plan at this layer's level of detail. Show each section in chat, and write it
into the spec once the user okays it. Then run the check:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/spec.mjs" check --repo . --effort <e> --folder <id>
```

Every problem names a file and line: fix them all. Every decision this spec defines is realised by
one of its own entries: a `sub-effort` or a `task` lists it under `realises` (a sub-effort with no
spec yet is frontier, not unrealised), or a `dropped` entry gives it up; a `deferred` entry
realises nothing. The check reports a decision none realises at its row, and approval refuses the
spec until it is fixed. **Just in time**: a sub-effort's own spec is written when it is next, not
now. Here it is one entry.

### Review. Gate: `approval.mjs gate` ratifiable or the review not earned, and the user's answer chose `Approve`

**A review is earned** by the spec's length, or by a contract other entries consume (an entry
`provides` one). Name what earned it. When nothing did, record that and why, and go straight to
the user's read (a reason past one line of 300 characters goes in a file, as `--reason-file`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/approval.mjs" skip-review --repo . --effort <e> --folder <id> --reason "<why it was not earned>"
```

When earned, challenge the spec with the `probe` program. Its probers get the spec and the
repository and nothing from you; `--context` is one line on what the spec is for, never your
defence of it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" probe --repo . --detach --artifact <the folder's DESIGN.md> --roots . --context "<one line>"
```

When it has ended, first record the round: how much of the spec it examined and every ambiguity's
settlement id, carried ones included, all read from the run's result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/approval.mjs" reviewed --repo . --effort <e> --folder <id> --from-run <run>
```

A `spec_changed` refusal means the spec was edited while the probe ran: probe it again. Read every
finding in full from the result's `findings_file`. The gate is computed, never read off the result
and never judged by you:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/approval.mjs" gate --repo . --effort <e> --folder <id>
```

`ratifiable` is true once the latest review of the spec as it stands ruled every unit in scope and
every ambiguity it returned is discarded, or incorporated with its section ruled clean by a later
round, which incorporating one earns. `open` names the ambiguities still unsettled, `remaining`
what a partial review left (unruled units, failed channels, short searches, unrecorded findings):
probe the whole spec for those, no `--since`. An edit shuts the gate until a review reads it.

<!-- agentics:verbatim design-severity-ladder -->
- **ambiguity** — a term, contract, or interface the design leaves readable two ways. Blocks
  ratification. The archetype is one name with two incompatible definitions in the same
  document: every consumer implements one of them, the mismatch is invisible until
  integration, and it costs a rework round rather than a sentence.
- **gap** — a growth axis or requirement the design names but cannot absorb without rework.
  Resolved, or explicitly accepted by the user with the cost stated. Never silently carried.
- **note** — advisory. Recorded in the design document, never blocks, never loops.
<!-- /agentics:verbatim -->

<!-- agentics:verbatim probe-disposition -->
**Summarise before you ask anything.** A probe returns findings per axis and the axes
overlap, so handed over raw it is a wall of text that costs more attention than the artefact
did. Open with a count and a table — one row per topic, never one per finding:

```
46 findings across 16 axes. 12 block ratification, in 4 topics:

  topic              blocking  what goes wrong if it stands
  bundle identity        5     two consumers implement different id rules, and the
                               mismatch first shows up at integration
  path derivation        4     ...

Also 9 gaps to accept or design away, and 25 notes recorded without asking.
```

The consequence column is the point of the summary. A reader deciding how much attention
this deserves needs to know what it costs to be wrong, not what the claim was.

**Notes are never questions.** Record them in the artefact and move on. A note that reaches
the user as a question spends their afternoon on advisory text — the exact failure the
ladder's inflation warning names.

**Consolidate questions, never findings.** Every finding is reported as it was returned;
that rule does not move. But several findings turning on a single decision are ONE question
— four axes noticing the same undefined term is one term to define. This is what takes a
disposition from forty questions to six.

**Ask in grouped sets.** `AskUserQuestion` carries up to four questions per call: fill it
with one topic's questions so a set can be answered in a single pass of attention. Order the
sets by blast radius, whatever constrains other decisions first. Every question keeps its
recommended answer marked `(Recommended)`, with the reason in the option's description.

**This is deliberately not the interview's rule.** The interview asks one question at a time
because each answer changes what is worth asking next and the tree is discovered as it is
walked. A disposition has no such tree: the findings are computed, independent, and all on
the table before the first question. One at a time is not care here, it is forty turns.
<!-- /agentics:verbatim -->

Put the Grill's defaults on the table in the same pass, as one set. **Settle every finding**:
incorporated (the spec's Design, Plan, Decisions or Open questions change because of it; a
resolution that is a decision is a Decisions row with an id) or discarded. Every `ambiguity` is
incorporated before approval. A `gap` is designed away, or accepted out loud as a Decisions row in
the user's words with the cost stated. A note is incorporated or discarded without asking. Record
each disposition as it is ruled:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/approval.mjs" dispose --repo . --effort <e> --folder <id> --finding <finding id> --outcome incorporated|discarded --by user
```

The finding id is the finding's `item` (its evidence-item id), or `<hash>#<P<n>>` when it has
none, `<hash>` being the spec's hash the review read (`approval.mjs state` prints it): the id
`reviewed --from-run` recorded each ambiguity under. A narrowed second round (`--since` set to the
first round's `snapshot`) carries a settled finding whose lines no edit touched: it stays settled
and is not asked about again.

Review leaves no document of its own: what the findings changed is in the spec, and the rest is
gone. **A second round is earned** by an incorporated ambiguity, or a resolution that reshaped the
design (a new interface, a data shape, which part owns a decision); name the one that earned it,
and pass `--since <the first round's snapshot>` so only the changed lines are attacked (an empty
`snapshot` means that round recorded nothing: probe the whole spec again). If the probe cannot
run, say so, offer a self-review as the weaker instrument it is, and let the user decide. Never
substitute one silently.

**The HARD GATE.** Then the user reads the folder's `DESIGN.md`, the file itself, not your summary
of it. Nothing is approved until they have read it and chosen `Approve` in the question below: not
"looks good so far", not silence, not your judgment that it is obviously right. `approval.mjs
gate` ratifiable or the review not earned, no `blocking` question open, and the user's answer: all
three.

### Approve

Read the folder's state:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/approval.mjs" state --repo . --effort <e> --folder <id>
```

**Already approved** (`state` is `approved`, only the compile left): run the compile below alone.

**A spec never compiled** (`compiled_hash` empty): ask with `AskUserQuestion`, the state's `token`
in the question's own text, offering exactly the options `Approve` and `Change it` with nothing
added to either label. While `state` prints `problems` its token is empty: fix them first, so the
user approves a text that compiles. On `Approve`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/approval.mjs" approve --repo . --effort <e> --folder <id>
node "${CLAUDE_PLUGIN_ROOT}/lib/compile.mjs" --repo . --effort <e> --folder <id>
```

`approve` finds the user's answer to the token and records the spec's hash and its decisions in
the ledger. It refuses when the answer did not choose `Approve`, or the spec changed since the
token was printed: read `state` again and ask with its new token. Any later edit un-approves the
spec and sends it back to Review. Compile builds the folder's entries into the execution tree; a
refusal names file and line, and the fix is an edit, which goes back through Review.

**A spec compiled before** (`compiled_hash` set) is ruled against every answer the user recorded
since its approval, and nobody is asked to approve it: start the `rule` program and watch it.

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" rule --repo . --detach --effort <e> --folder <id>
```

By the result's `status`:

- `approved`: every unit is unaffected or settled by the user's answers, so it is approved on that
  ruling and compiled. Tell the user what changed in one line and move on.
- `needs_user`: `affected` lists what no answer settles. Make each `fix` in the spec that owns its
  unit and have that spec ruled the same way, then start `rule` for this one again. Ask every
  `question` left in one `AskUserQuestion` call, opened and recorded with `lib/answers.mjs`; carry
  the answers into the specs they reach and rule again. Never ask for approval.
- `compile_refused`: its `problems` name file and line; the fix is an edit, ruled again.
- `refused`, by its `next`: `user_approves`, the never-compiled path above; `fix_spec`, edit what
  `problems` name; `rule_parent_first`, rule the spec `why` names first; `rule_it`, start `rule`
  again; `nothing`, it is approved as it stands.

### Move on. Gate: the user picks

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/next.mjs" --repo . --effort <e>
```

Offer its Next line and alternatives with `AskUserQuestion`: design a sub-effort (the same loop,
one folder down, starting from `effort.mjs folder`), develop what is approved, or stop. Stopping loses nothing, since everything is
in the specs. To take an entry out of the plan for now, its kind becomes `deferred`: an edit, so
the spec goes back through Review.

## Where the build runs — ask, do not assume

When the pick is to develop, ask with `AskUserQuestion`, these two options and no others:

- **New session (Recommended)**: `/agentics:develop <folder>` in a fresh context. Everything this
  pass produced is on disk, so nothing is lost.
- **This session**: `Skill({ skill: 'agentics:develop', args: '<folder>' })`.

Recommend by what this pass accumulated: a long grilling, a wide survey or several review rounds
make a fresh session cheaper; a short pass makes continuing cheaper. Say which, and let the user
answer. On a new session, give the one line to copy and stop; do not invoke `develop` yourself.

Report coverage on the way out: a survey or sweep that did not complete is named, with what rests
on it.

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
