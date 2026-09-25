# agentics — design (next)

This is the target design of agentics. It replaces `docs/DESIGN.md` as the implementation lands;
until then, `docs/DESIGN.md` describes what runs and this document describes what is being built.
It carries no history. Where a rule is not self-evident, a **Why** paragraph gives the reason in as
few sentences as the reason needs.

Reading order: the Iron Laws bind everything and have no exceptions. The Guiding Principles decide
every design question the laws leave open. Everything after them is the design those two produce.

---

## Iron Laws

Four laws. Each is enforced by a mechanism named beside it; a law without one is a defect.

### IL1 — A set task is finished

When a task is set, it is done, and done means **its intent is met and every unit of that intent
is traced to work and to a check** (see [Traceability](#traceability)). Nothing stops work because
a counter ran out: no turn, round, token or time limit ends anything. A budget, a limit or an
agent that cannot proceed produces an **escalation** that carries what was established, what was
tried, what remains and enough state to resume — never a result that reads as finished.

*Enforced by:* the lint rule forbidding counter-based termination; typed escalation returns on
every agent; the resume ladder.

### IL2 — A partial result never looks like a whole one

Every search-shaped or execution-shaped output states its own completeness through a `stop_reason`
enum and a coverage block: what was covered, what was not reached, what failed, what was recalled
rather than observed. `complete` is computed from those fields, never reported. "Looked and found
nothing" and "never looked" are different answers and never merge. Incomplete work is resumed on
exactly what remains; what is still incomplete after exhaustion **leads** the report. A failing
side channel keeps what was already paid for and marks what rests on it as unsupported.

*Enforced by:* the coverage-block lint rule; schemas with `stop_reason` enums; continuation
loops keyed on `stop_reason`; `.catch` on every side channel.

### IL3 — Nothing judges itself

A verdict is computed by a script from recorded observations. The agent that produced a piece of
work never certifies it; a reviewer has no approval to give, only findings; a coder has no pass to
give, only commits and a status. Approval is the open-finding set being empty.

*Enforced by:* schemas with no verdict fields (no-self-verdict lint); verdict predicates in code.

**Why:** an agent that can approve can be persuaded, and an agent that certifies its own work is
the examinee marking the exam.

### IL4 — The user owns decisions and their tree

The user is the only author of design decisions; an unanswered recommendation is not adopted. The
framework never mutates the user's branch or working tree: all work happens on branches and
worktrees the framework owns, and the user's tree moves once, on an explicit go, with no open
escalation.

*Enforced by:* the merge step being the session's act behind a gate; worktree environment checks
that refuse to run a mutating check in a non-linked tree.

---

## Guiding Principles

Seven principles. When two seem to conflict, GP1's order decides.

### GP1 — Fidelity first, then cost, then wall-clock

The objective is lexicographic: (1) the work reflects the spec and the intent, (2) at the lowest
total cost that still gives the assurance the work needs, (3) in the least wall-clock time that
does not raise cost. **Parallelism is the instrument of (3), not a goal.** Running disjoint work
side by side costs no extra tokens and is always taken. Running several agents over the *same*
context multiplies its cost and is bought only when the user sets `pace: fast`.

`pace` is a user dial: `frugal` (no duplicated-context parallelism, fewest dispatches), `balanced`
(default), `fast` (duplicated context accepted where it shortens the critical path).

### GP2 — Everything is earned, and legibly

A stage, a dispatch, a model tier, a reviewer, a survey or a design level exists only because a
nameable property of the node earned it. Three rules bind this:

- **Leanness is legible.** Whatever ran names the property that earned it; whatever did not run
  is stated. A report shows the cost of what ran, **measured**, never a projected constant.
- **Leanness never touches verdicts.** What shrinks is the number of dispatches, tiers, phases and
  levels. The predicates a verdict is computed from never shrink once a check runs.
- **The judgment half and the arithmetic half of every "is this earned?" decision stay apart.**
  Whether a shape is settled is judgment and stays with whoever holds the context; whether
  evidence is fresh, a grain is exceeded or a tree is unchanged is arithmetic and is computed.

**Why:** a pipeline element nobody can justify costs as much as a missed check and is harder to
see; a topology nobody can audit grows back to the maximum.

### GP3 — One execution tree, planned and scheduled dynamically

All work is one tree. The repository is the root; an **effort** is a subtree; every node is either
**composite** (it decomposes into children) or a **leaf** (an atomic task — see
[Atomicity](#atomicity-when-to-stop-splitting)). The same node schema, triage, event log and
derived status apply at every depth. Any node can be the root of an execution.

- **Decompose until atomic, no further.** A node splits exactly while it violates the atomicity
  rule.
- **Replan locally and dynamically.** A node that discovers it is larger than its grain, rests on
  a false premise, or needs a decision returns a typed result; its parent replans that subtree
  only. Nothing else stops.
- **Schedule by readiness.** A node starts when its dependencies' outputs exist, never when a
  sibling group finishes. There are no global phases or waves.

**Why:** fixed layers each grow their own vocabulary, store and scheduler, and work that fits
between two layers has nowhere to go. One recursive node makes depth a property of the work.

### GP4 — Deterministic work is a script, and scripts are fused

Anything computable is computed in `lib/`: partitions, digests, schedules, verdicts, merges,
statuses, briefs, freshness. A workflow script has no filesystem, so disk crosses into it through
an agent — a **courier** that runs one command and pastes its stdout. Two rules:

- **Bytes never ride a model; references and digests do.** Readers fetch content from disk
  themselves; payloads that cross carry a digest the script re-checks; lines the workflow mints
  whole travel encoded on one argv slot.
- **One courier per boundary, not per fact.** Every deterministic step that happens at the same
  boundary runs in one command, under one digest.

**Why:** reading enters an agent's context byte-exact; writing through an agent is where
corruption lives. And every courier is a round-trip on the critical path, so the count of
boundaries, not of facts, sets the floor.

### GP5 — Each agent gets only what it needs

A dispatch costs context × turns, paid by every agent separately; what an agent returns is re-read
on every later turn of whoever dispatched it.

- **Briefs are assembled by script** from the node, its referenced evidence and role-scoped
  knowledge — never retyped by a model, never a path "to go and read" for evidence the dispatcher
  already holds.
- **Shared evidence is resolved once** and handed inline as excerpts. An agent whose charge can be
  answered from what it is handed gets no tools.
- **One reader per body of evidence** unless its volume earns more; split heads only where
  independence is the point, and say so.
- **Returns are typed and short**; full reports go to files the next consumer opens only when it
  acts on them.
- **Agent definitions are sized to the role.** A courier's definition is a few lines. Runtime text
  (skills, definitions, prompts) holds instructions and contracts; reasons live in this document.

### GP6 — Durability by the actor; state is derived, never stored

Whoever performs an action records the observation, in the same execution. No agent records a
verdict; verdicts are re-derived from observations by the same functions on every read. Status —
of a node, a run, an effort, a knowledge entry — is computed from append-only logs and git on
every read. One monotonic `seq` orders records across logs; it is a counter, never a clock.
Resume names the single next undone action per node, trusting a stage only where the record and
git agree.

**Why:** a record written after the fact leaves a window where work exists and nothing says so; a
status written down outlives the thing it described; a clock an agent can read is a clock it can
invent.

### GP7 — Every mechanism has a live consumer

Every agent, stage, field, record kind, lint rule and library export has a producer and a consumer
that exist today. A mechanism with neither is removed, not kept "for compatibility"; a change of
format ships a one-shot migration script, not a permanent second reader. A check enforces this
(see [Self-checks](#self-checks)).

---

## The execution tree

### Nodes

A node is one file of authored facts plus an append-only event log. Authored facts:

| field | meaning |
|---|---|
| `id` | stable, path-like (`auth/session/refresh-token`) |
| `intent` | what this node makes true, in the user's or the parent design's words |
| `kind` | `design`, `composite`, `leaf` |
| `level` | for design nodes: `context`, `container`, `component`, `leaf-spec` (see [Design](#design)) |
| `decisions[]` | ids of the parent decisions this node realises (see [Traceability](#traceability)) |
| `acceptance[]` | criteria, each naming its check; `HUMAN:` routes one to the user untouched |
| `ground[]` | paths the node's evidence lives in (checked against the knowledge base) |
| `locus[]` | leaf only: every file it may write |
| `reads[]` | leaf only: files it builds against and never writes |
| `deps[]` | node ids whose outputs this node consumes |
| `provides[]`, `consumes[]` | named contracts (a name plus path prefixes) crossing between nodes |
| `rigor` | leaf only: see [Rigor](#rigor) |
| `tier` | model and effort per stage, set by the node's author (see [Model tier](#model-tier)) |

Events: `planned`, `replanned`, `dispatched`, `observed` (journal facts), `approved`, `merged`,
`escalated`, `parked`, `delivered`. Status is derived from them plus git.

### Storage

The repository is the root node. Everything the framework writes lives under it:

```
.claude/agentics/
  kb/                         the knowledge base: the root node's child, shared by every effort
  efforts/<effort>/
    node.json                 the effort's root node
    events.jsonl
    nodes/<id>/node.json      descendants, one directory per node, nested by id
    nodes/<id>/events.jsonl
    evidence/                 survey and probe returns, verbatim, anchored to commit + ground
    runs/<runstamp>/          one execution of a subtree: plan snapshot, state.jsonl, journal.jsonl
    reports/                  executor reports, one file per dispatch
```

Design documents are source and live in the source tree (`docs/agentics/designs/<effort>/`); a
design node points at its document. Worktrees live under `.claude/worktrees/`. Branches:
`agentics/<effort>/<node-id>` for a leaf, `agentics/<effort>/integration` for an effort's
integration branch.

**Why the knowledge base hangs on the root:** knowledge outlives efforts; an effort's discoveries
are deposited upward, and every effort reads the same base.

### Triage

Every node is triaged once, when it is created, by whoever creates it (the session for an
effort's root, the planner for its children). Triage answers four questions and derives the kind:

| question | if **no** |
|---|---|
| Is the intent settled — no approach left to discover? | `design` node |
| Is the ground known — finding where the change goes is not part of the work? | evidence (survey) is earned for this node |
| Does it satisfy the atomicity rule? | `composite` — decompose |
| Can it run inline in the session? (see [Tiers](#tiers)) | dispatched execution |

Triage is a recommendation to the user at the effort root; "run it anyway" ends the discussion.
Inside the tree, triage is the planner's, and the user sees it in the plan.

### Atomicity: when to stop splitting

A **leaf** is the smallest unit that deserves a commit. A node is a leaf when **every** condition
holds, and it is split while any fails:

1. **One concern.** Its change can be stated as one commit subject without a conjunction. Two
   concerns are two leaves.
2. **One rigor.** A single [rigor](#rigor) level applies to all of it. Parts needing different
   rigor are different leaves.
3. **Closed locus.** Every file it writes is declared in `locus`, and no file in it is written by a
   node that can run concurrently with it (otherwise the two are ordered by a dependency or the
   file is routed to the [coupled lane](#coupled-work)).
4. **Checkable alone.** Each acceptance criterion names a check (a test, the build, a typecheck, a
   command) that can be run on this leaf's branch alone and decides the criterion.
5. **Green when done.** After the leaf, the tree builds and the suite passes — except the declared
   failing tests of a `red` leaf, which never reach the integration head alone.
6. **Decided.** The brief contains every decision the executor needs. A leaf that needs a decision
   the brief does not carry is a design question, not a leaf.
7. **Fits one executor.** Brief + locus files + expected diff fit within the executor model's
   context budget with headroom for its turns. Computed by script from file sizes and the model's
   limit, never guessed.

**The stop rule:** a node that satisfies all seven is not split further, even if it could be — a
split that yields a child failing condition 4 or 5 is forbidden, because a child that cannot be
checked alone or leaves the tree red is not a unit of recovery.

**Why:** the leaf is the recovery grain (a lost session costs one leaf), the review grain (one
reader judges it whole) and the parallelism grain (disjoint loci run side by side). All three want
the smallest unit that is still independently correct.

### Replanning

An executor or planner returns one of these instead of finishing, and the parent replans the
subtree rooted at that node:

| return | meaning | parent action |
|---|---|---|
| `decompose` | the leaf violates atomicity (usually 1, 3 or 7) | split it; siblings unaffected |
| `premise_mismatch` | the brief's premise does not match the code | re-derive the node from evidence; surface to the user when the premise came from them |
| `needs_decision` | condition 6 failed | the question goes to the user; the node waits, siblings proceed |
| `contract_changed` | a `provides` contract cannot hold as written | re-brief every not-yet-started consumer; started ones get the change as a fix round |

Replanning appends `replanned` events; nothing is rewritten. A replanned node's merged work stays.

---

## Tiers

A node's tier is how much machinery surrounds its execution. It follows from triage; it is not a
separate choice.

| tier | earned when | what runs |
|---|---|---|
| **inline** | every leaf of the node is `verify` or `tdd` rigor, the locus is known, the intent settled, the whole node fits the session comfortably, and nothing is irreversible | the session does it — see [The simple task](#the-simple-task) |
| **dispatched** | a leaf needs `pair`/`triad` rigor, or the node has independent leaves worth running side by side, or it needs resumability beyond the session | an execution: worktrees, executors per rigor, fused verification, review per rigor, dynamic merge |
| **composite** | the node fails atomicity | decomposition, then each child is tiered on its own |
| **design** | the intent is not settled | a design node at the right level (see [Design](#design)) |

Every tier keeps two things: the check that each new test fails without the change, and an
independent reader for any behaviour change — on the inline tier, one fresh reviewer over the diff
when a leaf is `tdd`; none for `verify`, whose check is that no test outcome changed.

### The simple task

The inline tier is the framework's lightest path and has its own entry skill. Its rules:

- **Verify the premises first.** Check every file, symbol and assumption the request names
  against the code. A mismatch is surfaced before any plan.
- **Split within-scope from auxiliary.** Within-scope is what was asked, including the tests its
  rigor requires. Auxiliary is what the change makes desirable: stale docs, neighbouring cleanups.
  Auxiliary items are proposed as a separate list the user accepts or rejects; a rejected item does
  not exist. A consequence ("skipping this leaves the build red") is stated as information, never
  used to bypass the choice.
- **Ask, do not assume.** A genuine within-scope decision goes to the user, batched in one round.
- **The plan is the todo list.** No plan file, no worktree, no run directory. One item
  `in_progress` at a time.
- **Tripwire.** Raise it — and recommend the dispatched or design tier — when the work needs
  design exploration, is cross-cutting, adds a dependency or technology, is ambiguous enough to
  iterate, is irreversible or risky, or plausibly outgrows the session. An override is honoured
  without a second argument. During execution, growth past triage re-raises the tripwire.
- **Verify before claiming done** with the project's own checks. Commit only when asked.

**Why a separate entry:** the lightest path must not pay for loading the heaviest skill's text on
every turn.

---

## Rigor

Every leaf carries a `rigor`, set by its author. Walk the table top-down; the first match wins.

| rigor | the leaf… | executors | verification |
|---|---|---|---|
| `verify` | changes no behaviour: docs, comments, config values, renames behind an unchanged interface, dependency bumps, wiring | one implementer | the named check passes; no test outcome changes |
| `tests-only` | only adds tests to code that is already correct | one test-author | each new test passes now and is shown able to fail by a declared mutation |
| `tdd` | adds behaviour whose expected results the criteria state exactly | one implementer, test first | each new test fails at base and passes now; **at least one new test** |
| `pair` | adds behaviour where a wrong reading of the criteria would pass its author's own tests: edge-case rules, parsers, state machines, concurrency, contracts other nodes consume | a `red` test-author and a `green` implementer, separate agents | red: tests fail for want of the implementation; green: they pass, tests untouched |
| `triad` | as `pair`, and a miss ships silently into durable state or is costly to find: persistence formats, migrations, data loss, security, money | red, green, and an auditor | as `pair`, plus the auditor's mutations bite |

Unsure between `tdd` and `pair`: `tdd` when the leaf is small, `pair` when it is not.

- **No agent writes both a behaviour's tests and its code** at `pair` or `triad`. Separation is the
  declared loci, checked post hoc by the commit-series check; green receives red's committed tests
  as artifacts, never red's report.
- **A red leaf never reaches the integration head alone.** Red and green merge together once green
  is approved; green is cut from red's branch.
- **`verify` claims no tests and needs none**; `tdd` with an empty discriminator fails.
- **Review is per rigor.** `pair`, `triad` and any leaf that `provides` a contract get a review
  loop of their own; `verify`, `tests-only` and `tdd` leaves are reviewed at integration against
  their own criteria.

**Why:** assurance should rise with the cost of a wrong reading, and the cheapest assurance that
closes the specific hole is the right one.

---

## Design

Design is a subtree of design nodes, refined top-down in levels, as a C4 model is: each level
states only what the level below needs, and a level is written only when a child reaches it.

| level | states | ends when |
|---|---|---|
| `context` | the intent: who it is for, the outcome, success criteria, boundaries, what is out of scope | the user ratifies the intent |
| `container` | which subsystems change and the contracts between them | every contract has a name and an owner |
| `component` | per subsystem: components, interfaces, data shapes | the planner can write leaves that satisfy atomicity |
| `leaf-spec` | per leaf: acceptance criteria and their checks | it is a leaf |

- **A level is earned.** A change within one subsystem skips `container`; a change within one
  component skips `component`. The skip is recorded.
- **Evidence is scoped to the level.** Each level surveys only the ground it needs, reuses fresh
  knowledge and standing evidence, and runs the outward search (does this already exist?)
  alongside the survey, never after it.
- **Decisions are the user's and carry ids.** One question at a time, dependency order first, each
  with a recommendation and its reason. Open questions are graded `blocking`, `parked`, `lookup`,
  `compost`; a level with an open `blocking` question does not hand down.
- **Approaches in parallel, when the decision space is open.** Independent drafts from assigned
  stances; skipped, and recorded as skipped, when the level has one obvious shape.
- **The probe is earned.** A level's document is probed when it is long enough to hide an
  ambiguity or carries a contract other nodes consume. One analyst holds every axis unless length
  earns more. A second round is earned only by a resolution that reshaped the design.
- **Just in time.** Only the frontier's lower levels are written. A sibling reaching the frontier
  gets its level written then, with its ancestors and delivered siblings as settled context.

**Why:** most design errors are errors of intent or of contract, and both are cheapest to catch at
the level that states them; writing lower levels ahead of need pays for detail the upper levels
will change.

### Traceability

Every decision at every level has an id. Every child node lists the decision ids it realises; every
leaf's criteria trace to them. A script computes, before anything is dispatched:

- decisions no child realises — a **blocking gap**;
- criteria that trace to no decision — reported, for the user to accept or remove.

The integration review receives the decision list of the subtree it reviews, not only the leaves'
own criteria.

**Why:** a plan that silently drops a decision passes every leaf-level gate, because each gate
checks a leaf against its own criteria.

---

## Evidence

### Survey

The survey gathers evidence for one node and never concludes.

1. **Plan.** One analyst decomposes the question into topics against the knowledge base's index,
   names each topic's subtree, and names the common ground.
2. **Scout.** One scout per topic, the common ground scouted once. Scouts return locations, a
   `stop_reason`, `no_match` and `not_reached` kept apart, and are continued on exactly what
   remains until exhausted.
3. **Resolve.** A script reads the scouts' locations, merges overlapping windows and produces
   excerpts, once.
4. **Judge.** One analyst **without tools** judges every topic from the excerpts, unless volume
   earns more readers; history and docs channels run in parallel with scouting when the plan asks
   for them, each with its own `.catch`.

Fresh knowledge-base entries turn a topic into a verification; stale entries are leads for scouts
only; a node whose whole ground is fresh and whose shape is settled buys no survey (the null
survey), and says so. A recorded survey whose commit is an ancestor of HEAD, whose ground no commit
or edit has touched since, and which reported complete coverage **stands** and is reused.

### Knowledge base

Anchored observations, one append-only log per source-tree node. Depth is the lowest common
ancestor of what an entry is about; freshness is `git log <observed_at>..HEAD -- <about>` plus a
dirty-tree check, computed on read. Fresh is evidence, stale is a lead, orphaned is a claim about
ground that is gone. Only script-minted kinds are written. Executors are seeded with fresh entries
on their locus chain; verification is seeded with nothing but established commands whose source is
a verification.

---

## Execution

An execution runs a subtree. It owns an integration worktree on `agentics/<effort>/integration`
cut from the named base ref, and never touches the user's tree.

### Boundaries

Every deterministic step runs at one of five boundaries, each one courier dispatch running one
`lib/` entry point under one digest:

| boundary | fused steps |
|---|---|
| **preflight** | find existing executions of this subtree; drift check against the plan's anchor; create or attach the integration worktree; free dead worktrees; read the knowledge chain for every locus |
| **leaf-open** | create the leaf's worktree and branch; assemble its brief from the node, evidence and knowledge; record `dispatched` |
| **leaf-close** | commit-series check, build, typecheck, suite, discriminator, mutations; journal the observation; append the state line |
| **merge-batch** | merge every leaf approved since the last batch in dependency order; verify the merged head; append the state line; move progress |
| **postflight** | deposit approved leaves' discoveries; report worktrees and branches eligible for cleanup |

A merge-batch whose merged tree equals an already verified leaf tree skips re-verification; a
failing batch is bisected by the script to the leaf that broke it.

### Scheduling

A ready set, recomputed at every boundary: a leaf is ready when its dependencies are merged, its
locus is free of any running leaf, and it is not blocked by an open escalation on its dependency
chain. Ready leaves dispatch immediately. Merge-batches run whenever approved leaves are waiting
and no batch is in flight. Red/green/audit chains are held and merge as a unit.

`pause` stops at the next merge-batch boundary, where state is written and the next dispatch would
branch from an existing head.

### Coupled work

A leaf whose locus includes a designated shared file (lockfiles, configuration roots, barrel
files) runs in the **coupled lane**: serially, on the integration head, under the same rigor,
verification and review as any leaf. The lane runs alongside the ready set; only coupled leaves
wait for one another.

### Executors and review

- **Executors** are standalone agents, one per role per leaf: implementer, test-author, auditor,
  fixer. Each fetches its brief by reference and confirms its digest, writes a focused commit
  series inside its locus (no amends, no rebases, early commits), writes its report to a file and
  returns a short typed status: `done`, `done_with_concerns`, `blocked`, `needs_context`, or a
  [replanning](#replanning) return.
- **Review** is a fresh reviewer each round, given the brief, the span, the executor's concerns and
  the prior round's open findings. Findings sit on a severity ladder assigned by consequence
  (`critical`, `major`, `minor`), each critical or major naming its failure scenario. The blocking
  set is criticals, plus majors on a contract leaf. The loop exits when the open set is empty, and
  escalates — computed — when a fix round lands no commits, the same finding is unfixed twice
  running, or two rounds each fix every prior blocker and still mint new ones.
- **Integration review** reads the merged diff of the subtree against its decision list and every
  leaf reviewed there. Its criticals go to the user.

### Model tier

The node's author sets model and effort per stage, because it holds the context. Defaults: agents
that **produce** (implementer, test-author, fixer) run the cheaper model, with effort scaled to the
leaf's difficulty; agents that **gate** (reviewer, auditor, planner, analyst) run the stronger
model at moderate effort. Output that becomes the yardstick for other work (`pair`, `triad`,
contract leaves) never gates on the cheaper model. A fix round that failed to clear its blockers
raises the producer one step. The user's intelligence dial is a ceiling, derived from the session's
model unless the user moves it; couriers run the cheapest model at every position.

### The human gate

The execution returns its result in a fixed order: checkpoint, escalations, blocked nodes (naming
the escalated root), then the integration branch. The session presents gaps first, surfaces every
`HUMAN:` criterion verbatim, and merges the integration branch into the user's branch only on an
explicit go with no open escalation. Cleanup of merged branches and worktrees follows on a go.

---

## The ledger and resume

Per execution: `state.jsonl` holds what the workflow decided (approvals, escalations, batch
outcomes); `journal.jsonl` holds what actors observed (measurements, merges, finished series,
review rounds). `lib/ledger.mjs` is the only writer; it refuses a line that does not parse, lacks a
kind or an integer `seq`, or fails its caller's digest.

Resume computes, on disk, one next action per leaf — `none`, `merge`, `review`, `verify`,
`continue-series`, `code` — adopting a stage only where the record and git agree. A clean
execution (empty ledger, no leaf branches) opens for the cost of one branch listing. Committed work
is salvaged by right and reported as salvaged; uncommitted work is reported and adopted by nobody.
Escalations carry forward until the user names them for retry. A resume adopts its envelope (base,
tier, settled evidence) from disk, and a fresh request for a subtree that already has a planned or
running execution returns a checkpoint instead of planning a duplicate.

Checkpoints: `existing_execution`, `blocking_gaps`, `parked`, `stale`. A checkpoint dispatches
nothing.

---

## Progress

The user follows work through the host's todo list, and it moves at the moment a stage changes.

- **One todo per leaf**, created when the leaf is planned, subject `<node-id> — <title>`.
- **Stage in `activeForm`:** `implementing`, `writing tests`, `in review`, `fix round N`,
  `merging`, `waiting on user`. `completed` when merged; `pending` when deferred or escalated,
  with the reason.
- **Composite nodes** appear as a todo whose status is derived from their children.
- **The mover is the boundary courier:** leaf-open and leaf-close move a leaf's todo, merge-batch
  completes it, so progress costs no dispatch of its own.
- **A checkpoint line** heads each execution's state: `Status: ONGOING | DONE | NEEDS_INPUT`, read
  first by any resume.
- **Whenever the session is awake** it can re-derive every todo from the event logs; the list is a
  view and is never hand-edited.

---

## Agents

| role | does | cannot | tools |
|---|---|---|---|
| scout, historian, doc-researcher | find, to exhaustion | conclude | search tools; historian read-only git |
| analyst | judge excerpts it is handed | search | none by default |
| planner | triage, decompose, set rigor and tier, write nodes | implement | read, search, write node files |
| implementer | code one leaf as a focused series | leave its locus, amend, merge, certify | read, edit, shell |
| test-author | write a leaf's tests | implement, run the suite as a verdict | read, edit, shell for committing |
| auditor | mutate an implementation to test its tests | edit the implementation | read, shell |
| reviewer | attack a span | approve, edit | read, read-only git |
| courier | run one command, paste stdout | anything else | shell |

Capability is the tool allowlist and nothing else — no hooks. Agents with a shell are restrained by
their definitions; restraint is audited post hoc (locus by the commit-series check), and the
criterion is zero breaches surviving to review.

---

## Skills

Entry points, each loading only what its path needs:

| skill | entry for |
|---|---|
| `task` | the inline tier: premise check, gated auxiliary, todo plan, project checks |
| `design` | a design node at any level |
| `develop` | executing any subtree: triage, launch, result walk, human gate |
| `probe` | attacking a written artefact |
| `investigate` | answering a question from evidence |
| `find-existing-solutions` | the outward search |
| `status` | listing efforts and executions with derived status; handing one to `develop` |

A skill file holds the router and the steps; step detail lives in reference files loaded when the
step is reached. A contract several files must state identically is a verbatim block, and each
block appears only in the files whose reader acts on it.

---

## Self-checks

- **Lint** checks form: no counter-based termination, coverage block on every exit, no verdict
  fields in agent schemas, no imports in workflows, namespaced agent types, agent frontmatter.
- **The scenario harness** runs the real workflows with scripted agents; every structural claim
  about dispatch count is a harness assertion, not prose.
- **Verbatim blocks** are compared across files.
- **Liveness** (GP7): for every agent, record kind, schema field, lint rule and library export, a
  check finds a producer and a consumer in the source; defined-never-dispatched,
  written-never-read and read-never-written fail the suite.
- **Budgets:** each skill and agent definition has a size budget in one configuration file; lint
  fails a file over its budget.
- **Cost report:** every execution records its dispatches with model, effort and — where the host
  reports it — tokens, so the next triage quotes measured figures.

---

## Open questions

1. **Progress from inside a workflow.** A workflow script cannot call the task tools; the design
   moves todos from the boundary couriers. Whether a subagent's task-tool calls reach the session's
   todo list while the session is blocked on a workflow must be verified on the host before this
   is built. The fallback is the workflow's own log narration plus session-side derivation.
2. **Tests on the inline tier.** The simple-task model writes no tests unless asked; this design
   has the leaf's rigor decide (`tdd` writes them). Confirm rigor governs.
3. **Knowledge base placement.** The design reads "kb is a child of the effort" as "kb is a child
   of the repository root node, of which every effort is a subtree", so knowledge survives across
   efforts. Confirm.
