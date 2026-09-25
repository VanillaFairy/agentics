# vf-agentics — design

This is the design of vf-agentics as it stands today. It describes the system that actually
runs. It does not tell the story of how the system got here; git history has that.

Two ground rules for reading it:

- **When the code and this document disagree, the code is right and this document has a bug.**
  A change to behaviour updates this document in the same commit series as the code. The rule
  is in `CLAUDE.md`.
- **The IRON LAW and the six standing requirements live in `CLAUDE.md`**, because every agent
  in the plugin inherits them from there. This document refers to them as "IRON LAW §N" and
  "requirement N" rather than repeating them.

---

## What the plugin is

vf-agentics is a Claude Code plugin for designing, investigating and building changes in any
codebase. It works by orchestration: scripts decide what happens next, and models are called
only for the steps that need judgment.

Everything it ships is declarative or a small script:

| Directory | What lives there |
|---|---|
| `skills/` | Eight skills. These are the entry points a user invokes. |
| `workflows/` | Five workflow scripts, all named `vfa-*`. They hold the orchestration. |
| `agents/` | Twelve agent constitutions. Each defines one narrow role. |
| `lib/` | Node CLIs for everything deterministic that has to touch disk or git. |
| `tools/` | `lint.mjs` and its rules under `tools/rules/`. |
| `test/` | The `node --test` suite, including the scenario harness. |

One platform fact shapes a lot of the design: **a workflow script runs in a sandbox with no
module loader and no filesystem.** It cannot import, read a file or run git. So anything that
has to happen on disk is a `lib/` CLI, run by an agent, whose output the agent pastes back. How
that paste is kept honest is covered under [The ledger](#the-ledger).

### The skills

| Skill | What it is for | How it runs |
|---|---|---|
| `design` | Interview the user against evidence and produce a ratified design document | Session-driven. Calls `vfa-survey`, `vfa-find-existing-solutions` and `vfa-probe` |
| `probe` | Attack a written document before anyone builds from it | `vfa-probe` |
| `develop` | Implement a change: plan, code, verify, review, merge | `vfa-develop`, which nests `vfa-survey` |
| `runs` | List a repository's runs and hand one back to `develop` | `lib/run-status.mjs` |
| `plan` | Turn a staged design into a programme graph, with the user | Session-driven, `lib/programme.mjs` |
| `programme` | Drive a programme one slice at a time | Session-driven. Calls `design` and `develop` |
| `investigate` | Answer one large question, as a task list or a report | `vfa-investigate`, which nests `vfa-survey` |
| `find-existing-solutions` | Find out whether something needs building at all | `vfa-find-existing-solutions` |

The main path is **design → ratified change → develop**. A design too big for one run takes a
longer path: **design → plan → programme**, with one `develop` run per slice.

`design`, `plan` and `programme` are session-driven rather than workflows. Each of them either
talks to the user or launches something, and a workflow script can do neither.

### What it writes in a target repository

| Path | What it holds |
|---|---|
| `.claude/vfa/runs/<runstamp>/` | One run's plan and ledgers |
| `.claude/vfa/kb/` | The project knowledge base |
| `.claude/vfa/efforts/<effort>/` | Everything one piece of work produced, across phases |
| `.claude/vfa/programmes/<name>/` | A programme's event log and its rendered progress mirror |
| `.claude/worktrees/` | Integration, per-order and programme worktrees |
| `docs/vfa/designs/` | Design documents. These are source and get committed |

Everything under `.claude/vfa/` and `.claude/worktrees/` is scaffolding, and the skills make
sure it is gitignored.

Branches follow fixed names, which is what makes interrupted work findable:
`vfa/<runstamp>-<order-id>` for an order, `vfa/<runstamp>-integration` for a run's integration
branch, and `vfa/programme-<name>` for a programme.

### How the plugin checks itself

The runtime artifacts are prompts and scripts, so they get checked in layers:

- **`tools/lint.mjs` checks form.** Each rule is a single-purpose module under `tools/rules/`:
  no turn caps, a coverage block on every workflow exit, no schema bounds, no verdict-named
  booleans, no imports in workflows, namespaced agent types, a valid workflow `meta`, agent
  frontmatter, the gate clauses in the gated skills, and a stated fallback wherever a skill
  uses the Task tools.
- **The scenario harness executes orchestration.** `test/harness/workflow-host.mjs` runs the
  real workflow scripts with scripted agents, so the arithmetic between dispatches is tested
  for real.
- **Verbatim blocks stop copies drifting.** A contract restated in several files sits between
  `<!-- vfa:verbatim <id> -->` markers, and `test/verbatim-blocks.test.mjs` requires every
  copy of an id to match word for word. Several of those contracts have their canonical copy
  in this document.
- **Pins.** `test/agent-allowlists.test.mjs` pins every agent's tool list, and
  `test/design-doc.test.mjs` pins the shape of this document.

Run everything with `node tools/lint.mjs && node --test`.

---

## The doctrine

**A deterministic pipeline with stochastic nodes. Model judgment lives inside a node, never
between them.**

That sentence settles most design arguments in this codebase.

Every step whose answer can be computed is computed: the independence partition, the plan
digest, the commit-series checks, the merge, the resume verdict, the derived status of a run.
Every step that needs judgment is a model call with a narrow brief: planning a decomposition,
writing code, attacking a commit series. What comes back from that call is treated as a fact,
and the surrounding script reasons over it.

What a model never does is decide what happens next. Scheduling, verdicts, escalation and
completeness are all arithmetic.

Two consequences carry a lot of weight:

- **Dynamism means a variable number of iterations over a fixed shape.** A review loop runs as
  many rounds as it takes to converge. It may not grow a new stage. IRON LAW §1 is the
  lint-enforced form of this: no counter ever ends anything.
- **A model that authored orchestration would be the governed party editing the rules.** That
  is why the planner picks from closed vocabularies (roles, lanes, pins) instead of composing a
  process. Work that fits nothing in the vocabulary escalates to a human. It never gets a
  one-off graph.

### Topology is earned

The pipeline's job is not simply to run. It is to find **the leanest execution graph the work's
own properties justify**, at every level.

The burden of proof points one way: a piece of pipeline exists only because something nameable
about the work earned it. **A pipeline element nobody can justify is a defect of the same rank
as a missed verification.**

| Level | The choice | Earned by |
|---|---|---|
| Effort | whether to engage at all, and which phases run | how many loci, whether the shape is settled, how new the ground is, contract risk |
| Plan | how much plan to buy now | frontier size, slice count, available feedback |
| Orders | the lane for each order, and order size | role, contract flag, size |
| Scheduling | which orders dispatch when | the dependency edges |
| Steps | who executes each step, and how deep verification goes | whether the step measures or judges |
| Survey | how wide to fan out; discovery or verification | how the question decomposes, knowledge-base freshness |

Two rules bind this principle:

- **Leanness must be legible.** Whatever ran names the property that earned it, and whatever
  did not run is stated. A topology nobody can audit quietly grows back to the maximum.
- **Leanness never touches verdicts.** What shrinks is the number of dispatches, the model
  tier, the phases, and which orders buy a review loop of their own. What a verdict is computed
  from, once a step runs, never shrinks, and every order still meets an adversarial reviewer
  before the human gate.

The most visible instrument of this is `develop`'s triage, which picks how much pipeline a change
earns, down to none at all (see [Triage](#triage)).

### Phase presence is derived

A phase runs only when something about the work earns it. The survey is the main example, and
the rule it follows binds every phase built the same way.

Deciding whether a phase runs splits into two halves, and the split is not negotiable:

- **The judgment half stays with whoever can make it.** For the survey that is "is this
  change's shape settled, or does the change have to discover its approach?" No arithmetic
  can answer that, so the caller supplies it as `settled_shape`.
- **The arithmetic half is computed.** For the survey that is "does the knowledge base cover
  the ground this change names, and is that coverage fresh?" The caller names the ground; a
  program checks it.

Neither half decides anything alone. Three properties stop a skipped phase from becoming a
silent one:

1. **A skip rests only on a program's answer.** A stale knowledge-base entry is a lead, not
   evidence. So a stale chain, an unreadable chain, or a chain that covers only part of the
   named ground all refuse the skip, by construction.
2. **The skip is reported where the phase would have reported.** The coverage block says what
   the chain covered, at which commits, and, first, that none of it was re-searched by this
   run.
3. **It changes no verdict.** Planning, verification and review run exactly as they would
   have. What was not bought is a search, and the result says so.

The same rule applies one level down. When every topic in a survey rests on fresh ground, what
ran was a verification pass rather than a discovery survey, and the coverage block says that
too.

---

## The survey

`vfa-survey` is the shared evidence engine. `develop`, `investigate` and `design` all call it.
It gathers evidence and **never concludes**: it returns findings and a coverage block, and the
caller decides what they mean.

It runs in five phases:

1. **Plan.** An analyst decomposes the question into independent topics. It works against the
   knowledge base's *index* (see below) and names each topic's subtree. It also names the
   **common ground** (the surface every topic shares) and decides whether the history and docs
   channels are needed. `max_topics` is a hint to this planner, not a cap: any overflow is
   still searched.
2. **Scout.** One scout per topic searches the repository, and the common ground is scouted
   once, as its own topic, rather than by every scout separately. A scout that stops before
   exhausting its topic is resumed with what it found and what remains, until it reports
   `exhausted` (IRON LAW §3).
3. **History.** A historian searches git history, when the plan asked for it.
4. **Docs.** A doc-researcher searches vendor documentation, when the plan asked for it.
5. **Analyze.** Analysts judge each topic on the evidence gathered. Analysts do not search.

History and docs are side channels. Each has its own `.catch`, so a failing channel never
discards work already paid for; it lands in `failed_channels` and anything resting on it is
marked unsupported (IRON LAW §5).

### Two kinds of "nothing"

Every search agent reports `no_match` and `not_reached` separately, and they must never merge.

"I looked and it is not there" is a **finding**, and often the one that decides the question.
"I never looked" is a **hole**. Merging them is exactly how a truncated search gets read as a
clean result. It also poisons resumption: the next round would be handed things already
established as absent and pay to search them again.

Completeness is **derived** from each agent's `stop_reason`, never taken from a self-reported
boolean (IRON LAW §2).

### Knowledge-base consumption

The survey reads the [knowledge base](#knowledge-base) in a particular order, and the order
matters.

**The index first, then chains per topic.** Before a decomposition exists, the only known paths
are the roots, and a chain read at a root returns only the repository-wide node. So the Plan
phase receives the tree **index**: node paths, entry counts and kinds, with no freshness state.
That makes it cheap enough to buy before anything is known. The planner decomposes against it
and names each topic's subtree. Chains are fetched *then*, at those subtrees, in one courier
dispatch. Freshness is only paid for on ground somebody decided to search.

**Each state is worth something different, and the dispatch says so:**

- A **fresh** entry is evidence. It turns its topic into a verification: confirm what is
  recorded still stands, then spend the search on what the entry does not cover. An entry
  that turns out wrong is reported as a finding.
- A **stale** entry is a lead: a place to look, never a fact to report. Leads reach the search
  only. No analyst ever sees one, because an analyst judges what was found, and a claim it
  cannot check does not belong beside locations it can.

**A result that recalled something says so.** The coverage block's `from_kb` names, per topic,
which evidence came out of the knowledge base: how many entries, for which subtree, observed at
which commits. It is derived from what the script actually handed to each dispatch, never from
an analyst's account of what it leaned on. When it names nothing, that reads as "nothing came
from cache", which is the direction that under-claims.

**Absences are deposited.** When a scout searches a named subtree to exhaustion and finds
nothing, the survey writes an `absence` entry. That is the one thing a scout establishes that no
later run can cheaply re-establish, because it costs a full search to learn that a full search
finds nothing.

### The null survey

A change whose ground the knowledge base already covers buys no survey at all. This is the
phase-presence rule applied: the caller supplies `settled_shape: true` (judgment) and names the
`ground` (paths). The workflow reads one chain over those paths and skips the survey only if
**every** named path is covered by a fresh entry. The chain then becomes the run's evidence
base, and `from_kb` says so, including that nothing was re-searched.

Every refusal surveys in full and says which path refused, and why.

### Prior context

`prior` is what an earlier phase of the same [effort](#efforts) stored. It reaches the survey's
planner and nowhere else, where it can only change how the ground is decomposed. It is never
evidence, it never fills `ground`, and it never answers the settled-shape question. (A whole
survey can stand in for a later one, but only through the computed `standing` check described
under Efforts, never as `prior`.)

---

## Investigate

`vfa-investigate` answers one large question from evidence: what a change would break, why
something regressed, how a subsystem behaves. It runs the survey and then one synthesis step.

It returns either:

- **a task list** (the default), mapped one-to-one onto the host's Task tools, with
  dependency edges; or
- **a written report**.

In task mode the synthesis also returns `gaps`: what the evidence could not settle, and what it
refused to invent a task for. A well-formed task list can still rest on a hole, and `gaps` is
the only place that hole is named.

The task tools are optional in some hosts. When they are missing, the skill falls back to
`TodoWrite`, carries the dependency order in the list itself, and says that the ordering is now
advisory. The `task-tool-fallback` lint rule requires every skill that uses the Task tools to
state such a fallback.

## Find existing solutions

`vfa-find-existing-solutions` answers "should we write this at all?" It searches the world
outside the codebase, which is the opposite direction from the survey.

It runs in three phases:

1. **Frame.** An analyst restates the capability without naming an implementation, lists its
   hard constraints, and declares what disqualifies a candidate. The framing is deliberately
   neutral: a framing that names an architecture finds only that architecture.
2. **Search.** One doc-researcher per ecosystem angle, plus one scout over the repository asking
   only "do we already depend on something that does this?"
3. **Assess.** An analyst dedupes the candidates and rules each one against the declared
   disqualifiers.

`viable` is **computed** from the disqualifiers each candidate hit. No model chooses it, and it
is never a recommendation. `already_present` is reported first, because a dependency the
repository already carries beats every external candidate.

Here the coverage block carries more weight than anywhere else. "We found nothing" is the input
to a decision to spend weeks writing code, and an ecosystem nobody searched produces the same
sentence as one that genuinely has nothing. `unreached` keeps "searched and found nothing"
(evidence for building) apart from "never reached" (evidence of nothing at all).

---

## Design

`design` produces a **ratified change**: the document `develop` takes as input. Design work
that does not happen here happens during implementation instead, where a finding costs a fix
round rather than a sentence.

The pass runs like this:

1. **Evidence before questions.** Run the survey scoped to what the design needs to know about
   the existing system. Every question the repository, its history or vendor documentation can
   answer is answered here. The human is asked only what only the human knows: intent,
   priorities, taste and real-world constraints.
2. **Does it already exist?** When the design would build a capability, run
   `find-existing-solutions` too.
3. **One change or several?** When the evidence supports it, recommend staging and let the user
   rule. A staged design becomes a [programme](#programmes).
4. **The interview.** One question at a time, in dependency order, each with a recommended
   answer. **The user is the only author of decisions.** An unanswered recommendation is not
   adopted, and each decision is written in the user's words with its reason. Open questions
   are graded `blocking`, `parked`, `lookup` or `compost`, and a design with an open `blocking`
   question does not hand off.
5. **Approaches, then the probe.** Two or three `analyst` dispatches draft approaches in
   parallel, each from an assigned stance (minimal change, long horizon, adopt-don't-build), so
   that the options cannot anchor on each other. The design document is then attacked by
   [the probe](#probe).
6. **The artifact and the gate.** The session writes the design document and commits it. No
   implementation and no `develop` call happen until the user has read it and ratified it in as
   many words.
7. **Hand-off.** The change string is extracted from the document, never retyped, and the user
   is asked whether to build in a fresh session (the recommended default) or this one.

### The design document

A single change is one file, `docs/vfa/designs/YYYY-MM-DD-<slug>.md`. A programme is a
directory (see [Programmes](#programmes)).

Its sections are Context, Decisions, The design, Open questions, and Settled evidence. The last
one is written for a planner rather than a person: it is exactly the `notes` payload `develop`
consumes, and it stops the run from re-litigating what the design already settled.

**Section markers are the machine-readable half.** `change`, `decisions` and
`settled-evidence` are marked with `<!-- vfa:section <name> -->`. An optional `ground` section
lists the paths the change lives in, one per line. `lib/programme.mjs --section <name>` prints
a section byte for byte, so nothing downstream composes or paraphrases a design. A document
missing a required marker fails loudly, by name. Markers are written last, because a marker
over a half-written section says "finished".

`ground` and `locus` must never be confused:

- **`ground` is checked.** It feeds the null survey's freshness arithmetic, and a wrong path
  only costs the survey that was not skipped.
- **`locus` is declared.** It puts a run on the fix lane and fences what the coder may touch, so
  a wrong value misroutes the whole run. It is never fed from a document.

A design may also carry one paragraph recommending a triage rung: **direct**, **direct +
reviewer**, **fix lane** or **full run**. That is advice to `develop`'s triage, never a decision
and never the `lane` argument.

### Why the hand-off leans toward a fresh session

The change string is a key, not a description: `develop`'s duplicate-run guard and its resume
guard both compare it exactly. So the design skill prints it from the document and the user
copies it. A retyped or rewrapped string is a different change as far as those guards can tell.

Starting `develop` in a fresh session is the recommended default because everything the design
pass accumulated (the interview, survey returns, probe rounds) would otherwise be re-read on
every turn of a run that can last hours. None of it is needed once the document exists. The
skill still asks, and says so when a short pass makes continuing the cheaper choice.

---

## Probe

`vfa-probe` attacks a written document before anyone acts on it. Two properties make it worth
more than a careful reread, and both are structural:

- **The probers are not the author.** Each analyst receives the document and the repository,
  and nothing from the author: no summary, no intent, no defence. An author's account of what
  they meant talks a reader into reading the intent instead of the text, and what gets built is
  the text.
- **The verdict is computed.** Probers return findings on a fixed ladder and have no field with
  which to approve anything. `ratifiable` is false while any ambiguity is open, and false when
  any axis went unexamined.

It runs in three phases:

1. **Axes.** Read the target repository's own review guidance and derive the axes to attack
   from it. Four axes always run: contract ambiguity, unnamed invariants, YAGNI, and
   reinvention. Derived axes are capped at `max_derived_axes` (8 by default); the standing four
   are never capped.
2. **Ground.** One script resolves the evidence the document cites, once, for every axis (see
   [What a probe costs](#what-a-probe-costs)). It also reports the document's length.
3. **Probe.** One analyst holds every axis as a checklist. More are bought only when the
   document is long enough to earn them: one per 400 lines, never more than one per axis, with
   the axes dealt across them round-robin. An unknown length earns one. An analyst that stops
   short is continued on exactly what it never reached, for as long as each pass gets further
   than the last (IRON LAW §3); a pass that hands back the remainder it was given ends the
   attack, and what it left stays unreached in the coverage block. `per_axis: true` restores one
   analyst per axis for a caller who wants independent heads and says so.

**Rounds are earned too.** Resolving a finding with the user and writing the disposition into
the document is what clears it; that needs no second probe. A second round is bought only when
round N returned an ambiguity whose resolution reshaped the design (a new system or interface,
a data shape, which component owns a decision), and it attacks the revised document as a whole
document, not the author's account of what changed.

Findings sit on the **design severity ladder**, which is not the code ladder. The code ladder
speaks in acceptance criteria, commit series and loci, and a document has none of those.

- **ambiguity** — readable two ways. Blocks ratification.
- **gap** — something the design names but cannot absorb without rework. Designed away, or
  accepted out loud by the user.
- **note** — advisory. Recorded, never asked about.

The exact wording of this ladder, and of how findings are disposed of with the user, is pinned
as the verbatim blocks `design-severity-ladder` and `probe-disposition` in the `design` and
`probe` skills.

There is no fix loop. A document has nothing mechanical to re-verify against, so a loop would
iterate on taste. The probe reports; a human rules.

---

## Develop

`develop` implements one change. The workflow, `vfa-develop`, runs every wave of the plan in a
single invocation, merging into an integration worktree it creates and owns.

**The workflow never mutates the user's branch or working tree.** The user's tree moves once,
at the end, when the session merges the integration branch after a human go-ahead.

The phases are Survey, Plan, Implement, Verify, Review and Integrate.

### Triage

Before any survey is bought, the `develop` skill asks, once, how much pipeline the change earns.
It answers four questions (is the locus known, is the shape settled, is there anything to
partition, how big is it) and climbs a ladder only as far as the answers push:

| rung | earned when |
|---|---|
| **direct** | no behaviour changes: a rename, a typo, a constant |
| **direct + reviewer** | locus known, shape settled, small; the session writes the failing test first, then the change, and dispatches one fresh reviewer |
| **fix lane** | locus known, shape settled, nothing to partition, too big to finish comfortably in the session |
| **design first** | the shape is not settled |
| **full run, trimmed** | shape settled, several loci or independent pieces; `settled_shape`, `ground` and `effort` let the survey collapse where it is covered |
| **full run** | the ground is unknown |

Every rung keeps two things: the discriminator's question, and an adversarial reviewer who wrote
neither the code nor the tests. Inside a run the same rule continues: review loops, red/green
splits and waves are each bought by the property that earns them. A survey costs roughly
400–500k tokens before a line is written, which is why the lower rungs exist.

**Declining is a recommendation, never a refusal.** "Run it anyway" ends the conversation, and
the skill proceeds without arguing a second time. The IRON LAW has no cost exception for the
pipeline's own opinion of the work.

Triage also yields the two inputs the null survey needs: `settled_shape` (judgment, and never
inferred) and `ground` (the locus the triage already had to know). A resume and a `--plan-only`
run are never triaged.

### Lane catalogue

A lane is **a pre-verified path through states the ledger can record.** Two lanes exist.

**`full`** is the default: survey, plan, partition, waves, held red/green cycles, integration.

**`fix`** is the same run with the survey and the decomposition taken out, for a change the
caller has already narrowed to one locus. Three properties keep it honest rather than merely
cheap:

- **It is a lane inside the run, not a second workflow.** Worktrees, the check runner, the review
  loop, the ledger, the resume verdict and the collector are all inherited. Because the
  recordable states do not change, the lane resumes like any other run.
- **The locus is the admission rule.** What licenses skipping the survey is that the caller
  already decided which files the change is about. Without a `locus`, the run refuses at input,
  rather than sending a planner to invent a fence the coder may not widen.
- **Only phases are dropped, never gates.** The discriminator, the full mechanical checks and
  the integration review all still run, and the integration review is the lane's adversarial
  review of its one order, as it is for any order that is not a yardstick. The planner still runs too, at low
  effort, charged with writing one order: it is the only place the run directory, plan envelope
  and digest manifest get written, and a lane with no resume point pays twice the first time a
  session limit lands.

`regression: true` adds one history search, for a change that is "this used to work".

`coverage.from_kb` states which lane ran and that nothing was searched. It must never let a lane
read like a fresh knowledge-base chain: a chain is a program's finding that the ground is
recorded, while a lane is a caller's judgment that it is known.

Work that fits no lane takes the full path. It never gets a bespoke graph.

### Planning

The `planner` agent turns the survey's evidence into **work orders**, persists the plan, and
runs the partition.

Each order carries an imperative title, 2–5 acceptance criteria that each name how they will be
verified, a self-contained context, a declared **locus** (every file it may create or modify),
**reads** (files it builds against and never modifies), **deps**, and three vocabulary fields:

- **`role`** — `none`, or one step of a red-green-refactor cycle (`red`, `green`, `refactor`).
- **`contract`** — true when other orders build against this one's output. Its majors then
  block the way criticals do.
- **`pins`** — `behaviour` (the default) or `data`, for a regression net whose tests are true at
  base by design.

`weight` and `mutations` are covered under [Model tier](#model-tier-earned) and
[Verification](#verification). A criterion only a person can judge is prefixed `HUMAN:`. It is
routed to the human gate untouched and never turned into a synthetic test.

**Order grain is a correctness property, not tidiness.** The recovery surface after an
interruption is one order's commit series. So the planner aims at series of dozens of lines
rather than hundreds, and a session limit then costs dozens.

An order that widens a closed set (a union, an enum, a status list) owns every exhaustive
consumer of that set, and they go in its locus. Otherwise the coder can only choose between a
locus breach and a tree that does not compile. The run detects that oscillation and escalates it
as `verify_oscillating`, naming the locus as the defect.

A survey gap the change itself depends on goes in `blocking_gaps`. The run then stops at a
checkpoint and hands the plan back for confirmation instead of dispatching.

### Partition and waves

`lib/independence.mjs` partitions the orders. Two orders are independent when their loci are
disjoint **and** neither touches a designated shared file (lockfiles, config roots, barrel
files). An order that touches a shared file is **coupled**: it is routed back to the session and
belongs to no wave. The rest are packed into waves by their dependency edges.

The planner runs the partition itself and pastes the output verbatim into `partition_raw`. The
workflow parses it. A paraphrased partition would be the laundering IRON LAW §2 forbids.

Each wave runs its orders in parallel, each in its own worktree on its own branch. Approved
orders merge into the integration worktree, and **the merged head is verified before the next
wave branches from it.** A failure there is a defect in the combination that no single order's
checks could have caught.

The run logs its plan size before dispatching: orders, waves, how many buy a review loop of their
own, and the **dispatch floor** — coder, verifier and merge per order, a reviewer per looped
order, a wave-head verify per wave, and the integration review. Fix rounds sit on top, so it is a
floor and says so. A checkpoint carries the same figures as `plan_cost`, so a parked plan shows its
price before anyone pays it. A wave
boundary is the cheap place to stop: the state line is written and the next wave branches from a
head that already exists. `--pause-between-waves` makes the run stop there on purpose.

### Red, green and refactor

When a behaviour's tests become a yardstick, the planner splits the work into a cycle. That is
the case when other orders build against the behaviour, or when its criteria admit two readings
and the difference reaches a consumer. Everything else is one `role: none` order: the
discriminator proves each new test fails without the change, and a reviewer attacks the tests.
A cycle costs two coders, a held merge and a per-order review loop, so it is bought where an
independent reading of the criteria is the point:

| role | locus | lands |
|---|---|---|
| `red` | test files only | tests that fail for want of an implementation |
| `green` | implementation files only | the code that makes them pass |
| `refactor` | implementation files | restructuring, with tests untouched |

**The separation is the declared loci, and nothing else.** `lib/commit-series.mjs` blocks any
commit that reaches outside a locus, so a green order cannot edit the tests it is measured
against. The point is that two agents must independently arrive at the same reading of the
criteria. An exam written by the examinee passes by construction.

**A red order never reaches the integration head alone.** A red's whole product is a failing
test. Merged by itself, it would turn the integration head red, and every later order would be
measured against a tree failing for a reason none of them own.

So an approved cycle member is **held** rather than merged. The cycle's later members are coded
on its branch instead of the integration head, and the branch tips merge together once the last
member is approved. The cycle is read from `role` and `deps`, so nothing new is asked of the
plan. The integration head is never red, and a run stopped between waves leaves a branch that
still builds.

### Coding

One `coder` per order, in its own worktree on `vfa/<runstamp>-<order-id>`. It fetches its own
order from disk with `lib/ledger.mjs order` and checks the digest, so order prose never travels
through a model.

It implements the order as a **focused commit series**: one concern per commit, no amends, no
rebases, nothing outside the locus. It commits early, because a commit is the only thing that
survives a hard kill.

It reports what happened (`done`, `done_with_concerns`, `blocked`, `needs_context`) and never
certifies itself. Its doubts travel with the work as `concerns`, which become the reviewer's
first attack surface. It also reports `discovered`: gotchas about the repository that later work
should know. These are deposited into the knowledge base at the end of the run, for approved
orders only.

### The review loop

**Which orders buy a loop.** A yardstick order, a `red` or a `contract: true` one, is reviewed
per order: nothing downstream can check it, and later waves build on it before integration would
see it. Every other order is verified per order (build, typecheck, suite, discriminator) and
approved, and its adversarial review is carried by the integration review, which is handed its
criteria and its coder's concerns. Its result entry says so with `review.at_integration: true`.
`review_every_order: true` buys the loop for every order.

Each reviewed order is attacked by a **fresh** `reviewer` each round. A reviewer that saw an
earlier round defends its earlier reading instead of attacking the code.

**The reviewer has no approval to give.** Approval is a count the workflow computes: the open
set being empty. A reviewer that could approve would be a reviewer that could be persuaded.

The exit contract, verbatim:

<!-- vfa:verbatim review-loop-exit -->
- Dispatch a fresh reviewer each round with the work order, the worktree path, the span
  under review, the coder's `concerns`, the advisory `series_findings`, and — from round
  2 on — the prior round's open blockers (id, claim, fix commits since). Round 1 reviews
  the whole series; later rounds rule on the open blockers and review the fix span alone —
  the merged change is reviewed whole again at integration.
- The blocking set is the round's criticals, plus its majors when the order is marked
  `contract: true` and the finding carries a non-empty `failure_scenario` — a major that
  cannot name what goes wrong for whom is advisory, not blocking.
- The open set is the round's blocking findings, plus every prior blocker ruled
  `not_fixed`/`regressed` in `fix_verdicts` that the round did not re-report. Never
  narrow this to the round's criticals alone — that exact narrowing once shipped an
  order with a known-unfixed critical and `coverage.complete: true`.
- The order is approved when the open set is empty. That is a count you compute — the
  reviewer has no approval to give, by design.
- Escalate (computed, never judged) when (a) a fix round returns no commits, or status
  `blocked`/`needs_context`, or (b) the same finding id is ruled `not_fixed`/`regressed`
  in two consecutive rounds, or (c) two consecutive rounds each rule every prior blocker
  fixed and still mint new blocking findings — the fixes are landing, the reviewer pool is
  not converging, and another round buys another sample rather than a resolution.
- Otherwise dispatch a same-worktree coder fix round carrying the open set (new focused
  commits, no amends, no rebase), re-verify, and dispatch a fresh reviewer.
- No round counter ends this loop (IRON LAW §1). A budget error is caught and becomes an
  escalation carrying resumable state (IRON LAW §6) — never a silent stop.
<!-- /vfa:verbatim -->

The code severity ladder the reviewer rules on, verbatim:

<!-- vfa:verbatim severity-ladder -->
- **critical** — must not merge: violates or fails an acceptance criterion; introduces
  incorrect behavior; security or data-loss risk; a new test that does not discriminate
  (would pass without the change); behavior change inside a commit presented as a refactor;
  any edit outside the declared locus.
- **major** — real but mergeable: a genuine defect or hazard that does not fail an
  acceptance criterion (unhandled edge case beyond the spec, misleading name, duplicated
  logic). Reported in the result for the human gate; never loops — except on an order
  marked `contract: true`, whose majors are held open and block exactly as criticals do:
  an ambiguity in a contract propagates into every consumer.
- **minor** — style. Reported once; never blocks, never loops.
- Severity is assigned by consequence, never by conviction. A critical or major names the
  concrete input, state, or consumer that goes wrong, in `failure_scenario`; a major that
  cannot name one is a minor wearing the wrong label, and on a contract order that
  mislabel costs a full fix-verify-review round. A finding whose only remedy is rewriting
  an already-landed commit is advisory by definition — the series is append-only. Finding
  nothing new is a real, reportable answer; a severity is never raised to make a round
  look thorough.
<!-- /vfa:verbatim -->

A fix verdict on a prior blocker is `fixed`, `not_fixed` or `regressed`.

### Integration and the human gate

Merging an approved branch is deterministic, so it is a script: `lib/merge.mjs` runs
`git merge --no-ff` in the integration worktree and aborts on conflict itself. The dispatched
agent only runs it and pastes the result, which carries a digest. The merge result contract,
verbatim:

<!-- vfa:verbatim merge-result -->
Merge mode reports exactly four fields: `stop_reason` (`completed` or
`environment_broken`), `merged_sha` (`''` when the merge did not complete — a fact, not
a verdict), `conflicts` (conflicting paths verbatim from git; empty when none), and
`notes` (what was actually run). The caller derives the outcome as
`mergeOk = stop_reason === 'completed' && merged_sha !== '' && conflicts.length === 0` —
never from `conflicts` alone, because an `environment_broken` merge has an empty conflict
list too, and reading that as success waves a broken merge through. Anything that is not
`mergeOk` stops the merge run. A conflict is a planner defect — loci were declared
pairwise disjoint — surfaced to the human, never resolved silently.
<!-- /vfa:verbatim -->

After the last wave, a reviewer reads the **whole merged diff**. It has two charges: the
defects that only exist once orders are together, and the review of every merged order that did
not buy a loop of its own, against that order's criteria. Its criticals go to the human, not into
a fix loop: an integration critical usually means two orders disagree, which is a design
decision, and one inside a single order's diff is a finding the human rules on before the user's
tree moves.

**An integration review over a partial merge says so, on every finding.** When some planned
orders did not land, the reviewer is told which ones are missing and asked to reason about the
gap out loud. Every critical it reports carries that caveat out to the human. A review of an
incomplete tree can be accurate about what it saw and still point the wrong way once the missing
orders arrive. A whole merge carries no caveat, because a warning that is always present is one
nobody reads.

The result the session walks has a fixed order: checkpoint first; then escalations; then blocked
orders (with `blocked_by` naming the escalated root, not the nearest link); then coupled orders,
which the session implements itself under the same verify and review contract; then the
integration branch.

**A coupled order is never verified in the user's own tree.** The discriminator stashes, checks
out the base commit and forces the tree back, so run against a live working tree it destroys
uncommitted work. The session creates a throwaway worktree at the pre-change commit and points the
verifier there. Only then, with an explicit go-ahead and never while an escalation is open,
does the session run `git merge --no-ff <integration branch>` on the user's branch. That is the
single point in the pipeline where the user's tree moves. Inside a programme the merge target is
the programme branch instead (see [Programmes](#programmes)).

The session never reports success while `coverage.complete` is false. Gaps lead. Every `HUMAN:`
criterion is surfaced verbatim, because the session is its last consumer.

After the human accepts the result, `lib/gc.mjs` cleans up: it removes the worktrees of merged
branches and deletes those branches with `git branch -d`. It must be run from the checkout that
took the merge, and it refuses everything if that does not hold. It reports what it kept and
why, and it touches nothing outside `vfa/<runstamp>-*`. Escalated and held orders keep their
branches, because they are the resumable state.

### Checkpoints

A run can return a `checkpoint` instead of results. When it does, nothing was dispatched.

| `checkpoint.reason` | What happened |
|---|---|
| `existing_run` | A `planned` or `in-flight` run already records this exact change string. The run refuses to plan it twice and hands back that run's `resume_path`. `confirmed_duplicate: true` overrides. |
| `blocking_gaps` | The survey could not reach evidence the change depends on. Re-invoke with `resume_path` and `confirmed_gaps: true` to go ahead. |
| `plan_only` | The caller asked to park the plan (`--plan-only`). `plan_cost` says what building it would cost at its floor. |
| `stale` | A resumed run found the user's tree moved under its plan. |

The duplicate guard lives in the workflow, not only in the skill, because a skill instruction
guards only callers that read it, and a silent harness-cache miss arrives looking exactly like a
fresh invocation.

---

## Runs: park, list, resume

A run is a **lifecycle**, not a single invocation.

- **`--plan-only`** surveys, plans and partitions, then stops with the plan on disk and nothing
  built. Several plans can sit parked at once. Building one later is a resume and costs no
  second survey.
- **`runs`** lists every run in a repository with a status derived from its files on every call,
  and hands the chosen run to `develop`. The change description leads the table, because a
  runstamp tells a human nothing. `landed` here means the run reached its own `base_ref`; a
  programme has a `landed` of its own that means something different.
- **Resuming** has two tiers. `resumeFromRunId` is the harness's replay, available only inside
  the conversation that launched the run; it is cheap, and it can miss silently. `resume_path`
  is durable across sessions and pays for one courier and nothing else. After any hard kill,
  relaunch with `resume_path`.

A resume **adopts** the conditions the plan was written under (roots, notes, intelligence) from
the plan's envelope. Passing one of them again is a deliberate override and gets logged as one.
The `change` string is still required and is compared against the recorded one, so resuming the
wrong run halts instead of implementing one change's plan under another's description.

**Stale plans.** A resumed run compares the user's branch against the commit the plan was
written for. For each order it splits what moved into `writes` (files the order owns) and
`reads` (files it builds against). Those usually call for different rulings: moved writes often
need a rebase, while a moved dependency may mean the approach no longer exists. The human rules
per order and re-invokes with `confirmed_stale`. The check sees only what the planner declared,
so an empty `stale` list means "nothing the plan declared has moved", not "the plan is correct".
An unreachable anchor holds the whole run.

**Escalations carry forward.** An order an earlier invocation escalated is not silently retried.
It comes back with `reason: 'carried_forward'`, and `retry_escalated` names the ones whose cause
has been dealt with.

Archiving moves old `landed` runs to `.claude/vfa/runs/archived/` on an explicit go. Run
directories are never deleted: they are the only record of what a run decided and did.

---

## The ledger

A run's durable state lives in `.claude/vfa/runs/<runstamp>/`:

- `plan.json` — what was decided, with its envelope and a digest manifest;
- `plan.md` — the same plan, for a human;
- `state.jsonl` — what the workflow decided as it went: approvals, escalations, wave outcomes;
- `journal.jsonl` — what agents observed: measurements, merges, finished series.

The field lists are in [Data contracts](#data-contracts). The rules that make the ledger
trustworthy are these.

**Durability is written by whoever performed the action, in the execution that performed it.**
A record written by a separate courier afterwards leaves a window in which the work exists and
nothing on disk says so, and a usage limit can land in that window and take a wave's merges with
it. So the verifier journals its own measurements (in fact `lib/verify.mjs` writes them, inside
the process that measured), the merging agent its merges, and the coder the fact that its series
is finished.

**No agent ever journals a verdict.** Agents record observations. Pass and fail are computed from
them, on resume, by the same functions that computed them the first time. That asymmetry is what
makes agent-written durability safe: a journalled line cannot wave through work that was never
measured, because the line does not carry the judgment.

**One monotonic `seq` spans both files.** The workflow mints it and the writer copies it. It is a
counter rather than a clock, because an agent that can read a clock can invent one, and a
fabricated timestamp orders two records confidently and wrongly.

**Bytes never ride a model; references and digests do.** Anything crossing between disk and the
script has to ride an agent, and an agent's *output* is where corruption lives: loaders
paraphrase, recorders mangle escapes, couriers garble JSON. Reading is the safe direction,
because a tool result enters an agent's context byte for byte. So:

- the resume decision is computed on disk by `lib/run-verdict.mjs`, printed with its own digest,
  pasted by a courier, and re-checked by the script before it believes a word;
- `lib/ledger.mjs` is the only writer. It refuses a line that does not parse, has no `kind` or a
  non-integer `seq`, or does not match the digest its caller minted;
- a line the workflow mints whole travels **base64** on one argv slot, with a digest, so there is
  no path to escape and no apostrophe to close. Journal lines an agent writes by hand keep the
  heredoc and carry no digest, because they hold values only the observing agent knows and there
  is nothing to encode ahead of time.

A digest makes corruption detectable. It cannot make a retry likelier to succeed, which is why
the encoding matters as much as the check.

**One argv slot has a ceiling.** Windows caps a command line at 8191 characters, and a wave line
is as large as the wave was interesting. So the token can instead be written to a file and the
path passed (`--b64-file`). A heredoc or a script file does not help, because either one puts the
same token on the same single command line. The digest is minted over the line as the writer
will see it, after its JSON round trip.

**Retries are sized to what was observed.** A refusal is the writer's own statement that it
appended nothing, so it buys exactly one fresh recorder. A dispatch that threw or returned
nothing buys none: the outcome is unobserved, and a retry could append the line twice.

---

## Resume

Each order's lifecycle is `code → verify → review → merge`, and `lib/run-verdict.mjs` names the
single **next undone action** for each order.

A stage is adopted only where **two independent sources agree**: the run recorded that the stage
closed, and git still holds the head it closed over. Rebuilding is the bottom of that ladder, not
the top:

| What the record and git agree on | `next_action` | What the resume does |
|---|---|---|
| a wave line records it landed, or git has it in the integration branch and a witness agrees (the approved head, or a `merge-observed` line naming the branch) | `none` | records the merge; nothing is rebuilt |
| approved, and the branch is still at the reviewed head | `merge` | merges it as it stands |
| measured green, and the branch is still at that head | `review` | adopts the commits and goes straight to review |
| commits on the branch whose tip is a checkpoint commit | `continue-series` | a coder continues from the last commit |
| commits on the branch and a `coder-done` line | `verify` | verifies and reviews in full |
| nothing on the branch | `code` | dispatches a coder |

Commits with neither a checkpoint tip nor a `coder-done` line are continued when the run's coders
record `coder-done` elsewhere (so its absence means "unfinished"), and verified otherwise.

Committed work is scavengeable by right, because commits live on the branch and survive a lost
worktree. Uncommitted work is reported as a fact and adopted by nobody automatically. A
checkpoint commit, the coder's own signature on an unfinished series, outranks everything else
recorded: the series is continued, never measured as if it were complete.

Two regimes are deliberately asymmetric. A **clean** run, with an empty ledger and no order
branches, has nothing to salvage by definition and opens for the cost of one
`git branch --list`. A **dirty** one resumes each order exactly where it stopped.

**A dead invocation's worktrees are freed before anything is dispatched.** Git refuses to check
out one branch in two worktrees, so a leftover checkout of a run's own branch does not announce
itself: the next dispatch's worktree simply comes up detached, and a coder on a detached HEAD can
commit nowhere that survives. The integration setup pass therefore lists the worktrees, removes
the clean ones and reports the rest. A dirty worktree is **never** forced; it is named in
`coverage.unreached` and the human decides.

Salvage is always reported, marked `review.salvaged` with `rounds: 0`. A run that says
"implemented W4" about work it adopted is describing work it did not do.

---

## Programmes

A design whose honest decomposition is several deliverable slices becomes a **programme**. The
layer repeats the WHAT → HOW → DO split one level up:

| Skill | Role | Produces |
|---|---|---|
| `design` | the WHAT | `system.md` (the root design, with no graph) plus leaf designs, written just in time |
| `plan` | the HOW | `programme.json` and `plan.md`, built with the user |
| `programme` | the DO | one `develop` run per slice, on a branch the layer owns |

Everything lives in one directory, `docs/vfa/designs/YYYY-MM-DD-<name>/`. **The programme's
identifier is the directory name**; there is no `slug` field, because a field restating the
directory name can only ever disagree with it.

**`plan` decides slices; the planner agent decides work orders.** Same word, two grains, and they
never meet.

### The graph

`programme.json` holds authored facts only, never progress. It has an `advance` mode and a list
of nodes. A node is a `group` or a `slice`:

- `parent` is containment, and it is optional;
- `deps` is dependency, a DAG over slices that may cross subsystem boundaries freely. **A slice's
  parent is not its prerequisite.**

Each slice names what it `delivers` (something a person can actually use, since a slice is a
deliverable and not a layer), the contracts it `provides` (each a name plus a set of path
prefixes), and the contract names it `consumes`. A dependency that carries no contract must state
a reason.

The loader is the check. `lib/programme.mjs` refuses a malformed graph (duplicate ids, a slice as
a parent, cycles, contracts without paths, duplicate contract names, a `consumes` from a slice not
depended on, an ordering with neither contract nor reason) and **repairs nothing**. A graph the
tool patched is a graph the user did not author.

**The artifact is the authorization.** `programme.json` can only come into being through a `plan`
session with the user, so a later session that finds it on disk may build from it without asking
again. Nothing stores "the user approved". A revision, made with the user, is its own approval.
Delivered slices are never edited.

### Driving it

The programme runs on `vfa/programme-<name>` in `.claude/worktrees/programme-<name>/`, created
lazily at the first dispatch. Every slice run gets the worktree as `roots`, the branch as
`base_ref`, and its `programme` and `slice` tags copied from `programme.json`.

**Progress is derived, never stored.** `lib/programme.mjs` computes every slice's state from the
graph and an append-only event log, recomputed on every read. The log has four event kinds, and
only the CLI's append verbs write it; nobody composes an event by hand. A line that will not
parse renders the whole programme `unknown`, because a malformed line names no slice and so its
blast radius cannot be decided.

Slice states route mechanically: `awaiting-design` goes to a scoped design pass, `ready` to a run,
`in-flight` to a resume (never a re-plan), `delivery-pending` to finishing the between-slice
steps, and `unknown` is presented and never dispatched over. **Reconciliation comes before new
work**, at this level as inside a run.

**Leaf designs are written just in time.** Only the frontier slice's leaf exists at first. When
another slice reaches the frontier, the `design` skill runs in scoped mode: the root design and
delivered predecessors are settled context, the probe runs on the leaf, and the section markers
are the completeness signal. A session that dies mid-design leaves a marker-incomplete leaf,
which simply derives as `awaiting-design` again.

After each slice run:

1. The develop result is walked exactly as `develop` walks it. A checkpoint is not a delivery.
2. The slice's integration branch merges into the programme branch **without asking**, because
   the question the user wants asked is about *their* branch, and this is not it.
3. A `delivered` event is appended, carrying the run's coverage block copied whole.
4. **Drift is checked mechanically:** the landed diff is intersected with every pending designed
   slice's consumed contract paths. A hit goes to the user as facts; they rule unaffected,
   re-design or re-slice. Undesigned slices are reported as `unexamined`, because "no flag" and
   "nothing to check against" are different answers.
5. The programme advances. **`gated`** stops after every slice. **`standing`** continues through
   implementation, but never authors a decision reserved for the user: it stops at any
   user-decision point, and before a slice it does not expect the session to survive.

The develop skill's merge step is superseded inside a programme, and both skills pin the wording:

<!-- vfa:verbatim programme-merge-target -->
In a programme run, develop step 3d's merge target is the programme branch, in the
programme worktree, performed by the programme skill without a per-slice ask; its
dirty-tree and no-open-escalation guards apply unchanged; the user-branch merge it
describes happens once, at landing.
<!-- /vfa:verbatim -->

**Landing is the one ask.** When the programme is complete, or the user says "land what we
have", the session first reports how the user's branch drifted from the `opened` anchor, then
asks, then merges `vfa/programme-<name>` into the user's checkout and appends `merged`. An empty
frontier is not completeness: a slice delivered with an unruled gap blocks its dependents while
nothing is in flight.

---

## The roles, and their asymmetries

The roster is small on purpose, and its useful property is that the roles are deliberately
unequal. Each one is denied something, and the denial is the point.

| Role | Does | Cannot |
|---|---|---|
| `scout` / `historian` / `doc-researcher` | find things, to exhaustion | conclude anything |
| `analyst` | judge, on gathered evidence | search for more |
| `planner` | decompose into orders, run the partition, persist the plan | implement, or invent process |
| `coder` | implement one order as a focused series | leave its locus, amend, or merge |
| `test-author` | write an order's failing tests | run, implement or commit them |
| `verifier` | carry a measurement; perform the checks by hand when the script cannot | judge quality, or fix anything |
| `reviewer` | attack one series adversarially | approve, or edit |
| `run-state` | carry a verdict, or append one line | read anything outside the run directory |
| `kb` | carry a computed chain, or append a batch of observations | open a file, or judge what it carries |
| `ground` | carry the probe's resolved citations | anything else |

Two asymmetries matter most. **The reviewer has no approval to give**, and **the coder cannot
certify itself**; both are covered under [The review loop](#the-review-loop) and
[Coding](#coding).

The couriers (`ground`, `kb`, `run-state`, and the `verifier` in its measuring mode) run one
command and paste what it printed. Their tier does not move with the intelligence dial, because
pasting one line is pasting one line.

## Capability layer

**There is one capability mechanism in this system: the agent's frontmatter tool allowlist.**
Everything else that looks like a restraint is prose in a constitution, audited after the fact.
That is the settled design, not a gap waiting to be closed.

**The roster splits in two, and the split is the whole content of the layer.**

- **Blind by capability.** `scout`, `analyst`, `doc-researcher` and `test-author` carry **no
  shell**. Nothing they can be talked into executes anything, reaches git, or writes outside the
  harness's own file tools, so their read-only and cannot-execute claims are facts.
  `test-author` is the case designed for this: the agent that wrote the exam is structurally not
  the agent that watched it pass.
- **Restrained by discipline.** `historian`, `reviewer`, `verifier`, `coder`, `planner`,
  `run-state`, `kb` and `ground` all carry `Bash`, and **a shell subsumes writing**. Every
  restraint on those eight is a rule the agent keeps: the historian's read-only git commands, the
  reviewer's `log`/`show`/`diff`-only shell, the planner's three writable files. Each charter
  says which half it is in, because a restraint that reads like a fence and is not one is worse
  than no claim at all.

**The allowlists are pinned mechanically.** `test/agent-allowlists.test.mjs` maps each agent
name to its sorted tool list, in both directions, plus the shell-free set as its own assertion.
Widening, narrowing, or adding an agent without a pin fails the suite. The friction is
deliberate: a capability change should land in a diff a reviewer reads.

**No hooks, permanently.** A `PreToolUse` locus fence, a `Stop` auto-commit and a `SessionStart`
briefing were designed and are deliberately not built. The reasons:

- plugin hooks fire in **every** session on the machine, so a process spawn per tool call would
  tax work this plugin is not even part of;
- path-shaped scoping risks fencing other plugins' agents, because the harness's worktrees are
  shared territory;
- the fence had no sound writer for its lane descriptor, because the harness creates the coder's
  worktree inside the coder's own dispatch;
- experience with hook-based enforcement in a sibling plugin was negative.

The cost is stated rather than hidden: nothing replaces a crash-path auto-commit, and the coder's
rule to reach its first commit early is the only guard that survives a hard kill.

**Enforcement is post-hoc, by design.** The locus fence is `lib/commit-series.mjs`, measuring a
finished series against the order's declared paths. So the success criterion is **"zero breaches
surviving to review"**, never "zero breach attempts".

**What is not claimed**, said plainly because each is easy to assume:

- **Not read-blindness.** `test-author` holds `Read`. It is told not to read the implementation
  it tests, and that is discipline, backed by the reviewer's ladder.
- **Not shell-channel prevention.** Any agent with a shell can write any file the process can.
- **Not path scoping.** An allowlist grants `Write`; it cannot grant `Write` to three paths.

---

## Model tier, earned

Which model runs a step is a topology choice like any other, and it is earned the same way. The
question is not how hard the work looks. It is **what catches this if the model is wrong?**

Where a discriminator, a build, a suite and a fresh adversarial reviewer stand behind an output,
a cheaper executor is a bet the pipeline is built to win. Where the output becomes the standard
later work is measured against, nothing stands behind it. A red order pins acceptance criteria in
failing tests; the green coder implements a wrong reading faithfully, and the reviewer is fenced
to the same criteria. So an order whose **output is the yardstick** (a red order or a contract
order) floors at Opus at every dial position, and no dial waives it.

Three things move a tier, and they are deliberately unequal.

**The dial is a ceiling, derived from the session.** Fable → `max`, Opus → `normal`, Sonnet and
below → `low`. A session never chooses its own position: dialling up because the work felt
important charges the user for the session's self-assessment, and dialling down hides behind a
cheaper reader. Only the user moves it off that mapping. The exact wording is pinned as the
verbatim block `intelligence-tier` in the four skills that take the dial.

At `low`, `normal` and `max`, the judging agents (the planner, every reviewer, the survey's
analysts) run on Sonnet, Opus and Fable respectively. The coder moves once, at `max`, and to
**Opus rather than Fable**: judgment is where this pipeline concentrates its spend. Below `max`
the coder keeps its own model, and the verifier, scouts and couriers keep theirs at every
position. At `low` there is no strong reader anywhere in the loop, and the skill says so before a
long run starts.

**`weight` moves an order down from the ceiling, and only down.** An upward move would let the
planner buy a tier the user never authorized. A trivial order is still reviewed, just not by the
most expensive reader in the run. Both per-order dials travel the resume transport with the
order, because arithmetic reads them on the far side. A missing `weight` would normalize to
`standard` and silently price every resumed order at the ceiling.

**Measurement moves an order up.** A fix round that did not clear its blockers is evidence that
the tier was too low, so the next round implements at the Opus floor. This is the one sanctioned
rise above the ceiling. It is one step, never past Opus, and it ends nothing: the round count
selects an instrument, while the loop's exits stay computed.

**Judges never adapt upward.** A judge's product is sometimes a refusal: a blocking gap, a
critical. A cheaper judge does not refuse less often because the work was easy; it refuses less
often, full stop, and that failure is silent. A reviewer whose tier depended on its own earlier
findings would be setting its price from its own output.

What each order's tier bought is recorded on its approval line (`weight`, the two model
decisions, the round count), so the mapping can be audited across runs. Nothing reads it back.
Re-tiering future orders from past outcomes would need its own argument.

A resume passes no `intelligence`: the plan's envelope carries the tier it was planned at.

---

## Verification

The mechanical checks of one work order (the commit series, the build, the typecheck, the test
suite, the discriminator, and any declared mutations) are **one program**, `lib/verify.mjs`, run
in one process. Nothing in it decides whether the order passed. It observes, and prints exactly
the fields the workflow's verdict reads. That is the whole argument for letting a script do this
work.

**The dispatch is a courier.** The workflow names one fully-filled invocation. The verifier runs
it and pastes its stdout, one line of JSON carrying its own digest. It parses nothing, reformats
nothing and repairs nothing. The workflow recomputes the digest before believing a field.

**Judgment is an escalation, not a default.** Choosing a build command is judgment; running one
is not. A repository whose commands nobody has established yet comes back `command_unknown`, a
typed error, never a repository quietly recorded as having no build. A Sonnet investigator then
reads the manifest and performs the checks by hand. What it establishes is reused for every later
check in the run, which is a script again.

**Established commands travel one way.** They go *out* to the run's knowledge set, so later coders
see them. They are never read back *in* to verification from a coder's report. A coder's guessed
build command becoming the command every verdict is computed from would be a report laundered
into a measurement. The one thing verification takes from the knowledge base is a `command`
entry that is fresh **and** whose source says a verification wrote it.

**Three failures, told apart.** A courier that could not run the command, a payload damaged in
transit, and a runner that ran and refused are three different events. The first two buy one
refetch a tier up; if no tier can carry the measurement, the order escalates naming the
*transport*. The third buys the investigator. Two rungs, never a loop.

**A passing suite is not evidence that the tree compiles.** The typecheck is its own answer,
never derived from the build or the suite. Vitest and Jest transform with esbuild, which strips
types without checking them, so a suite can be green over a tree `tsc --noEmit` rejects.
`absent` is the ordinary answer for repositories with no separate typecheck, but it is a fact
somebody established, never inferred from an empty command.

**Absent is never inferred, in either direction.** `absent` means the repository defines no such
command; `failed` means a command ran and exited non-zero. A test that could not be launched at
base is `test_unrunnable`, never `failed_on_base`. A suite failure that cannot be placed against
a real test file raises `suite_failures_unnamed` instead of a guess, because an order owns files,
not test ids.

**The environment check runs first, and it refuses.** The discriminator stashes and moves HEAD,
so the program first establishes that it stands in a linked worktree, never the tree a human is
working in. It always puts the tree back, or says `tree_not_restored` out loud.

**The observation journals itself.** The program writes the run's `verify-observed` line inside
the process that made the measurement, so there is no window between the work and the record.

**The payload is sized for whoever has to retype it.** `suite_output_tail` rides only when the
suite failed, since that is the only case anything opens it. A run of three or more identical
non-ASCII glyphs (a test runner's banner rule) collapses to one, because that is the part of a
tail a courier has to count rather than read.

### What a verdict is computed from

`verifyOk` derives pass or fail from the observations, **against the order's role**:

- a plain order needs a green suite and a discriminator that failed at base and passes now;
- a `red` order needs the mirror image, and a green suite fails it;
- a `refactor` order needs a suite that actually ran, and adds no test.

The discriminator is the highest-value check in the system. Nothing else closes the
passes-for-the-wrong-reason hole.

**It has one class of order it cannot be right about.** "Did this test fail before the change?"
is the wrong question for a test that exists to hold something already correct in place. So
`pins: 'data'` drops the base-failure half and keeps `passes_now`. It is inert on a `red` order.

**A regression net is checked by breaking what it guards.** The waiver leaves only `passes_now`,
which `true === true` also satisfies. So an order may declare `mutations`: a text substitution in
one tracked file, plus the tests that must fail once it is applied. The program applies it, runs
those tests, requires every one to fail, and restores the file. A substitution rather than a
command, because a substitution cannot leave the worktree, reverts with one checkout, and can
**refuse**: a `find` matching zero times is a stale spec, and one matching many times is
ambiguous. Both fail the order pointing at the spec, not the test.

**Where the plan failed to say so, the round is not bought.** An ordinary order that fails with
the discriminator as its only failing fact cannot be moved by any commit inside its own locus. It
escalates on round one as `discriminator_undecidable`, with the discriminator's findings and the
order's criteria side by side.

**A merged wave is verified too.** At the integration head the build and suite run again, per
wave, in integration mode. A wave whose head fails only on tests belonging to a held red whose
green has not landed is not a broken wave, and the run says so.

---

## Completeness: the coverage block

Every workflow exit carries a **coverage block**, and IRON LAW §4 rests on it: a partial result
must never be indistinguishable from a whole one.

`complete` is computed, never reported by an agent, and each workflow derives it from what can go
missing in that workflow. Degradation always lands in a named array (`dropped`, `incomplete`,
`failed_channels`), with prose in `unreached`, so a reader can see what was lost and where.
`resumable` carries enough state to pick the work up again (IRON LAW §6). `from_kb` names anything
recalled from the knowledge base rather than searched for today; an empty or absent `from_kb`
means nothing came from cache.

The `coverage-block` lint rule requires every workflow to return one. The field list and exactly
how each workflow derives `complete` are in [Data contracts](#coverage-block).

**A failed side channel is spelled out, not left as a bare word.** In `develop`, a lost state line
or a lost knowledge deposit does not make the run's work incomplete (the work happened; what
failed is its record), but it is explained beside the escalations. Both cost the *next*
invocation: a lost state line makes a resume re-derive outcomes from git, and a lost deposit makes
the next run pay again to learn what this one learned.

---

## Knowledge base

Without a memory, every run opens blind on ground a previous run already paid to see. The
knowledge base is that memory.

It lives at `.claude/vfa/kb/` in the target repository and mirrors the source tree: one
append-only `node.jsonl` per node. `lib/kb.mjs` owns it.

**It stores observations and computes everything judgmental on read.** A line says what was seen,
where, and at which commit. Whether it is still true is never on the line. A status that is
computed cannot be stale; a status written down outlives the thing it described.

**Depth is arithmetic.** An entry's node is `LCA(about)`: the narrowest directory containing every
path it names, recomputed on every read. Nobody files an entry anywhere, so an entry whose subject
moves is re-filed by arithmetic. A consumer reads a **chain**, from the root down to the narrowest
node covering its path and never the tree below, so a dispatch payload is bounded by depth rather
than by how much the repository knows.

**Freshness is event-invalidated, and the event log is git.** `git log <observed_at>..HEAD --
<about>` empty means fresh, with no file read at all. Non-empty demotes the entry to a digest
check, which is not the same as stale: a commit that moved a file and moved it back is an event
about nothing. The log has to be git rather than this pipeline's own ledger because the base
outlives runs; hand commits and direct sessions write no ledger line. `git log` sees only
committed history, so one `git status` per invocation stops an entry whose subject is dirty from
taking the shortcut.

**Three states, and each gates what an entry may be used as.** **Fresh** is evidence. **Stale** is
a lead. **Orphaned** is a claim about ground that is gone. An anchor class the checker cannot yet
attest demotes its entry rather than passing, because unchecked and clean are different answers.

**`kb_present` separates two facts.** Without it, a repository with no base at all and a base
that knows nothing about this path would look identical: an empty chain. Only the first is a
setup fact, since the null survey can never fire there. The message says which case it hit.

### Inside a run

There are two seams.

- **Before the first order**, one chain read covers every locus the plan touches, and each coder
  is seeded from its own locus chain, fresh entries only, labelled as observations to verify
  rather than instructions.
- **After the last order**, approved orders' `discovered` entries are deposited, anchored to the
  order's locus and stamped with the run's base commit. Escalated orders' discoveries stay out;
  they are unreviewed claims about a repository that rejected the work.

**The verifier receives nothing**, and the whole design rests on that asymmetry. A coder may act
on hearsay and be caught by verification; verification has nothing behind it.

**Deposits are split to fit a command line, by the script.** base64 makes a batch safe on a
command line; it does not make it fit. So batching is arithmetic done in the workflow, each batch
under its own digest, refused or accepted alone. Appends resolve newest-id-wins, so N commands
deposit exactly what one would. An entry too large to split goes through `--b64-file`.

Both seams are advisory side channels. A base that cannot be read or written costs the run
nothing it has already paid for; the loss lands in `failed_channels`.

### Which kinds get written

The id decides which kinds can be deposited at all. Re-observing a fact mints the same id from the
same bytes, which is what makes shadowing work, so only claims a **script** mints from stable
inputs may be written.

- **`absence`** is written by the survey. Its id hashes the subtree and a topic key, while the
  scout's own words ride in the claim, so a later pass that phrases it better *shadows* its
  predecessor. Its subject is a directory, so it reads fresh only through the git-event shortcut.
- **`structural`** exists in the vocabulary and is written by nobody. A model-authored sentence
  rehashes on every pass and would append a near-duplicate each time, growing the base without
  ever consolidating it.

---

## Efforts

An **effort** is the unit of work that spans phases: design, survey, probe and one or more runs.
Without it, a survey's or a probe's findings would go nowhere durable, and everything the design
session learned that did not reach the design document would be gone before the develop session
opened.

It owns a directory:

```
.claude/vfa/efforts/<effort>/
  effort.json            { about, roots, opened_at }
  surveys/<stamp>.json   each survey's return, verbatim
  probes/<stamp>.json    each probe's findings, verbatim
  links.jsonl            pointers: the runstamps it owns, the design it was built from
```

The identifier is the directory name. Runs and designs are **pointers**: run state stays where the
resume ladder reads it, and a design stays in the source tree, because it is source. The writer is
the **session** that ran the phase, through `lib/effort.mjs`, and a return is stored exactly as it
was returned. Opening is idempotent, and a later phase adopts the identity the first one recorded.

**Read back as prior context, a stored return proves nothing.** The knowledge base's null-survey
gate reads one field, an entry's computed freshness, and no kind and no provenance, so anything
that reached it would be admitted on freshness alone. Prior context has no freshness to check, so
it reaches exactly one place: a survey's planner.

**A survey that still stands is the one computed exception.** Recording a survey writes an
anchor beside it: the commit it was taken at, and its `ground`, the subtrees its topics searched.
`standing` then answers from git, never from anybody's account:

- the survey reported `coverage.complete`;
- its commit is still an ancestor of HEAD;
- no commit since reaches its ground (the pipeline's own `.claude/vfa/` is excluded);
- no uncommitted edit sits on its ground.

`develop` asks when the caller passes `effort` beside `settled_shape: true`. A standing survey is
the run's evidence base, read by the planner from disk, and `from_kb` says so; one that does not
stand is bought again in full, and the log says which check refused. This is the git-event half
of a knowledge-base entry's freshness applied to a whole survey, and it exists because the
design → develop hand-off otherwise buys the same 400–500k-token survey twice. It answers only
whether the ground moved. Whether the shape is settled stays the caller's judgment.

The wording every phase uses is pinned as the verbatim block `effort-store`.

---

## What a probe costs

Measured from the transcripts of one 17-agent probe of a 120-line document: **36.5M tokens billed
to return about 538k of evidence**, a 68× amplification. The harness's own token field reported
1.31M for the same run, low by a factor of 28, and the probe skill says never to quote it.

**The cost is turn count, not payload.** Every turn re-sends the accumulated context, so an
analyst running 40 turns against a context growing toward 80k pays roughly 3.2M in cache reads,
and sixteen of those is the whole bill. It is superlinear in turns. Nobody ingested a large file;
what the turns bought was **locating**, with sixteen analysts independently finding the same
lines. Trimming what analysts read is worth almost nothing.

So the probe resolves the document's shared surface once. A probed document cites its evidence as
`path:line`, and `lib/citations.mjs` extracts those citations, merges overlapping windows, reads
the excerpts, and one `ground` courier carries the result to every axis. A citation that resolves
to nothing is itself a finding about the document, and it travels to every analyst as one. If the
shared-ground read fails, it costs turns rather than coverage: each analyst locates what it needs
as before.

**The head count was the lever the per-axis shape never priced.** Every analyst pays its own
locating and its own turns, so seventeen analysts on a 120-line document is seventeen readers of
a document one reader holds whole. The axes are a checklist for a reader rather than a head
count, so the default is one analyst, and length is what buys a second. What stops a single
reader from quietly skimming is the same `stop_reason` every search in the plugin carries, plus
the continuation that follows an `unfinished`.

**The derived-axis cap is a dial, not a saving.** Yield per axis is flat, so capping buys less
coverage rather than less waste, and the result says so: what the cap declined to buy is named in
`axes_dropped`, `coverage.unreached` and `resumable.remaining`, so a re-run with a higher cap buys
exactly the skipped axes. It does not flip `coverage.complete`, which keeps its meaning: axes this
probe commissioned and got no report from.

## What a dispatch costs

A dispatch costs context times turns, and every agent pays its own. Two blocks carry that rule.

**`dispatched-economy`** closes the constitution of every agent that searches or reads: analyst,
coder, doc-researcher, historian, planner, reviewer, scout and test-author. Excerpts a dispatch
hands over were read for the agent and are not re-opened; passages are found with Grep and read
by range; the return is exactly the shape asked for; and none of that shortens the work. The four
couriers run one command and carry none of it.

It lives in the constitution because that is where the cache is. Parallel agents share the system
prompt and nothing else, so a rule in the constitution is paid once per agent type, and the same
rule in a prompt body is paid once per dispatch.

**`dispatch-economy`** is the dispatcher's half. It sits in the `develop` skill's direct-session
path and in `CLAUDE.md`, for whoever writes a workflow. It is guidance, and it was measured as
guidance: given four claims resting on the same two files, an orchestrator with it dispatched one
agent fewer, and neither arm built shared ground. So **where this plugin needs shared ground, it
is code** (`lib/citations.mjs` for a probe, the survey's common ground) and never a sentence
asking a model to arrange it.

---

## Data contracts

Workflow scripts cannot import, so most contracts live in several places at once: the code that
writes a record, the code that reads it back, and the prompts that tell an agent what to write.
Each entry below names the **owner** (the code that defines the shape) and **where it is
restated**. A change to a field list edits every place named, in the same commit series. Nothing
finds the copies for you.

Two conventions hold throughout:

- **Digests** are FNV-1a, 32-bit, 8 hex characters, over `canonical()` from
  `lib/plan-digest.mjs`: keys sorted, `undefined` read as `null`.
- **A CLI whose output a courier carries back** prints `{payload, payload_digest}` and exits 0,
  even when the payload reports a typed error. `{error}` with exit 1 means the program itself
  failed.

### Plan envelope and work orders

`.claude/vfa/runs/<runstamp>/plan.json`, written by the planner.

- **Owner:** the order shape is `WORK_ORDER_ITEM` (inside `WORK_ORDERS`) in
  `workflows/vfa-develop.workflow.js`. No constant holds the whole envelope; the planner writes it
  following `agents/planner.md` step 9. The order digest is `ORDER_FIELDS` and `digestOrder` in
  `lib/plan-digest.mjs`.
- **Restated in:** the planner and fix-lane prompts, `envelopeSection()` and the resume adoption
  in `vfa-develop`; `deriveVerdict` in `lib/run-verdict.mjs`; `deriveRun` in `lib/run-status.mjs`;
  `order` and `notes` in `lib/ledger.mjs`; `agents/planner.md`; `skills/develop` and `skills/runs`.

The envelope:

- `runstamp` — `YYYYMMDD-HHMMSS`. Code takes the runstamp from the directory name.
- `change` — the caller's change string, byte for byte. Every guard compares it exactly.
- `roots` — comma-separated. The first is the git root the resume verdict uses.
- `caller_notes` — the settled evidence, verbatim. Agents fetch it with `ledger.mjs notes`; it is
  never transported through a model.
- `intelligence` — the tier the plan was made at.
- `base_branch`, `base_sha` — observed with `git rev-parse`, or the named `base_ref`. The drift
  anchor for a resume.
- `programme`, `slice` — copied character for character; `''` outside a programme.
- `work_orders` — below.
- `shared_files` — the partition's input.
- `partition_raw` — the verbatim stdout of `lib/independence.mjs`, parsed on disk.
- `blocking_gaps`, `notes` — the planner's gaps and prose.
- `manifest` — `{id, locus_n, acceptance_n, digest}` per order, added as proof the file parses.
  Nothing compares it later; the digests that matter are recomputed from `plan.json` itself by
  `lib/run-verdict.mjs` and `ledger.mjs order`.

A work order:

- `id`, `title`, `context` — strings. The context is self-contained.
- `acceptance[]` — 2–5 criteria, each naming how it is verified. A `HUMAN:` prefix routes it to
  the gate.
- `locus[]` — every file the order may create or modify, repo-relative with forward slashes.
- `reads[]` — files it builds against and never writes.
- `deps[]` — order ids.
- `contract` — boolean.
- `role` — `none | red | green | refactor`. Missing reads as `none`.
- `pins` — `behaviour | data`. Honoured only when `role` is `none`.
- `weight` — `light | standard | heavy`. Missing reads as `standard`.
- `mutations[]` — optional, `{file, find, replace, expect_failing[]}`. `find` must occur exactly
  once; `replace: ''` is a deletion.

The order digest covers `id`, `title`, `locus`, `acceptance`, `context`, `deps` and `contract`,
plus `role` when it is not `none` and `reads` when it is non-empty. It does not cover `pins`,
`weight` or `mutations`.

### State lines

`state.jsonl`: what the workflow decided.

- **Owner:** the builders `waveLine`, `orderStageLine`, `orderLine` and `escalationLine` in
  `vfa-develop`, appended through `appendState` by the `run-state` recorder, as base64 with a
  digest.
- **Restated in:** `parseState` and `replay` in `lib/run-verdict.mjs`; `lib/run-status.mjs`;
  `agents/run-state.md`; `skills/develop`.

Every line has the same total shape — `kind, seq, wave, merged, approved_unmerged, escalated,
discovered, integration_base, integration_head, order, branch, worktree, head_sha, measured` —
and a field a kind does not use is `''` or `[]`.

- **`wave`**, when a wave ends: `merged` (cumulative), `approved_unmerged` (a snapshot),
  `escalated` (this wave's), `discovered` (knowledge new since the last line),
  `integration_base`, `integration_head`.
- **`order-approved`**, the moment review closes: `order`, `branch`, `worktree`, `head_sha`, and
  `measured` (values from `build`, `typecheck`, `suite`, `discriminator:<n>`). Also `weight`,
  `coder_model`, `judge_model` and `review_rounds`, which record what the order's tier bought.
- **`order-escalated`**, the moment an order escalates: `order` and `reason`.
- **`order-verified`** is still read for older runs, and written by nothing.

A line with no `kind` reads as a `wave` line.

### Journal lines

`journal.jsonl`: what agents observed. Each kind is written by whoever did the thing, through
`lib/ledger.mjs append --file journal`.

- **Owner:** `journalLine` in `lib/verify.mjs` for `verify-observed`. The other kinds are JSON
  templates inside `vfa-develop`'s dispatch prompts. `parseJournal` in `lib/run-verdict.mjs` is
  what reads them back.
- **Restated in:** `replay` in `lib/run-verdict.mjs`; `lib/run-status.mjs`;
  `agents/verifier.md`; `test/verify.test.mjs`; `skills/develop`.

`verify-observed` from `lib/verify.mjs` carries a digest. The hand-written kinds go through a
heredoc with no digest, because they carry values only the observing agent knows; the writer
still refuses a line that does not parse, has no `kind`, or has a non-integer `seq`.

- **`verify-observed`**, written by `lib/verify.mjs` inside the measuring process (or by the
  verifier by hand, in investigate mode): `order, branch, worktree, base_sha, head_sha,
  stop_reason, build, typecheck, suite, failing_tests, discriminator, mutations,
  series_findings`. It counts as recorded only with a string `stop_reason`, `build` and `suite` in
  `passed | failed | absent`, and well-formed arrays. A missing `typecheck` or `mutations` reads as
  `absent` or `[]`.
- **`merge-observed`**, written by the verifier in merge mode, only after a merge that completed.
  `order`, `branch` and `head_sha` are what gets read.
- **`coder-done`**, written by the coder at the end of a fresh or continued series: `order,
  branch, head_sha, commits[{sha, subject}]`.
- **`review-observed`**, written by the reviewer once per round: `order, round, branch, head_sha,
  findings[{id, severity}]`. Only the count is read, as `review_rounds`.
- **`discovery`** is read (its notes join the knowledge set) and written by nothing.

### The seq counter

- **Owner:** `nextSeq()` in `vfa-develop`. On a resume it is seeded from the verdict's `seq_max`.
- **Restated in:** the line builders and journal templates in `vfa-develop`; the `--seq` flag of
  `lib/verify.mjs`; `entryProblem` in `lib/ledger.mjs`; the readers in `lib/run-verdict.mjs` and
  `lib/run-status.mjs`; `agents/verifier.md` and `agents/run-state.md`.

`seq` is an integer, minted when a line or a prompt is built and copied exactly by the writer.
One counter spans both files, and it follows dispatch order rather than completion order.
`lib/ledger.mjs` refuses a non-integer. A missing value reads as 0, meaning "written before the
counter existed".

What it decides is narrow. Records resolve by fixed precedence (landed over approved over
verified), not by "last line wins". `seq` decides one question: a verified record clears an
earlier escalation only when its `seq` is strictly greater. `lib/run-status.mjs` also orders an
order's stages by it.

### Verify payload

- **Owner:** `blank()` and `verify()` in `lib/verify.mjs`.
- **Restated in:** `VERIFY` (the investigate-mode shape, which adds `commands`), `CARRIED`,
  `carriedVerify`, `verifyInvocation`, the verify prompts, `measuredOf` and the verdict predicates
  in `vfa-develop`; the behavioural copy of the predicates in `lib/run-verdict.mjs`;
  `agents/verifier.md`.

Fields:

- `stop_reason` — `completed | environment_broken`, broken exactly when `error` is set.
- `build`, `typecheck`, `suite` — `passed | failed | absent`. `absent` only when declared.
- `suite_output_tail` — the last 40 lines, with banner runs collapsed. Present only when the suite
  failed.
- `failing_tests[{file, id}]`
- `discriminator[{test_id, failed_on_base, passes_now}]`
- `mutations[{file, applied, unapplied_reason, expect_failing, observed_failing, bites}]`
- `series_findings[{sha, check, message, blocking}]`
- `notes`
- `error` — `null` or `{kind, message}`. The kinds are `no_worktree`, `main_worktree`,
  `series_unreadable`, `command_unknown`, `shell_refused`, `suite_failures_unnamed`,
  `base_checkout_refused`, `test_unrunnable` and `tree_not_restored`.
- `journal` — `null` or `{written, error}`.

Integration mode (`--mode integration`) skips the series check, the discriminator and the
mutations. Mutations arrive as base64 JSON on `--mutations-b64`.

The series checks come from `lib/commit-series.mjs`: `empty-series`, `empty-commit`,
`locus-breach`, `wip-subject`, `checkpoint-commit`, `and-subject` and `subject-length`. A
checkpoint commit carries the `vfa-checkpoint` trailer.

### Resume verdict

- **Owner:** `deriveVerdict`, `nextActionFor` and `gitFacts` in `lib/run-verdict.mjs`.
- **Restated in:** the `VERDICT` schema, `verdictPrompt` and `verdictProblem` (the digest
  recheck) in `vfa-develop`; `agents/run-state.md`.

The payload: `stop_reason` (`loaded | unreadable`), `runstamp`, `clean`, `envelope{change, roots,
intelligence, base_branch, base_sha, programme, slice, caller_notes_len, caller_notes_digest}`,
`plan{blocking_gaps}`, `partition{waves, coupled, note}`, `orders[]`, `integration{base_sha,
head_sha, branch, observed_head}`, `knowledge[]`, `seq_max`, `last_wave`, `notes[]`, `root` and
`plan_path`.

An order row: `id, title, role, weight, locus, reads, deps, contract, acceptance_n, locus_n,
digest`, then `next_action` with its `stage_note` and `merged_source`, then what git and the
ledger say: `branch, worktree, base_sha, head_sha, commits, dirty, already_merged, measured,
verified_source, verified_seq, escalated, escalated_wave, escalated_seq, escalated_reason,
review_rounds`.

`next_action` is one of `code | continue-series | verify | review | merge | none`, chosen by the
ladder in [Resume](#resume). Escalations are reported and never acted on.

### Knowledge-base entry

One line of `.claude/vfa/kb/**/node.jsonl`.

- **Owner:** `lib/kb.mjs` (`KINDS`, `entryProblem`, `stateOf`, `appendEntries`). Entries are minted
  by `kbDeposits` in `vfa-develop` and `absenceDeposits` in `vfa-survey`.
- **Restated in:** `agents/kb.md`; the `kb.mjs` command lines in the `vfa-develop` and
  `vfa-survey` prompts; `skills/develop` and `skills/design`; `CLAUDE.md`.

Fields:

- `id` — the shadowing key. Minted ids are `gotcha:<fnv1a(claim)>`, `command:<name>` and
  `absence:<fnv1a(path, NUL, topic key)>`, meaning the subtree path and the topic key joined by
  a NUL character.
- `claim` — the observation, in words.
- `kind` — `structural | gotcha | command | absence`.
- `about[]` — repo-relative forward-slash paths. The entry's node is `LCA(about)`.
- `anchors` — measured by the writer, never taken from the caller: `{path, digest}` for each file
  in `about`. Anchors of any other class are carried through untouched.
- `observed_at` — a commit sha. `'HEAD'` is resolved at append time. `''` is legal and disables the
  git-event shortcut.
- `source` — optional and free-form. Today: `{runstamp, via: 'coder-discovered', order}`,
  `{runstamp, via: 'verify-established'}`, `{via: 'survey-absence', topic}`.
- `command` — for `kind: command` only: `{name: build | typecheck | suite | test_one, value,
  absent}`.

What gets written: `gotcha` from approved orders' discoveries (about = the order's locus,
observed_at = the run's base commit); `command` for commands a verification established; `absence`
for a subtree searched to exhaustion with no hits. `structural` is written by nothing.

What a reader sees per entry: `id, claim, kind, about, observed_at, source, node, state, reason`,
plus `command` on command entries. Anchors never travel.

The CLI:

- `chain <repo> [paths…]` — the chains, with state counts and `kb_present`.
- `index <repo>` — node paths, entry counts and kinds, with no state at all.
- `verify <repo>` and `compact <repo>` — maintenance; `compact` drops shadowed, orphaned and
  malformed lines.
- `append <repo> [--digest <hex>] (--b64 <token> | --b64-file <path>)` — validation is
  all-or-nothing for the batch.

### Coverage block

- **Owner:** there is no single definition, because scripts cannot import. The builders are
  `coverageOf` in `vfa-survey`, `vfa-develop` and `vfa-find-existing-solutions`, and inline
  literals in `vfa-probe` and `vfa-investigate`. The `coverage-block` lint rule requires every
  workflow to return one.
- **Restated in:** `skills/investigate`, `skills/find-existing-solutions`, `skills/develop`,
  `skills/probe`; `lib/programme.mjs` (which reads `complete` and `unreached`); `CLAUDE.md`.

Fields:

- `complete` — always computed, and computed per workflow:
  - **survey** and **find-existing-solutions**: all four loss arrays are empty;
  - **probe**: `dropped`, `incomplete` and `failed_channels` are empty (`unreached` is not part of
    it, so a capped axis does not flip it);
  - **develop**: no escalated, coupled or deferred orders, nothing extra unreached, and the survey
    it ran was complete (`failed_channels` is not part of it);
  - **investigate**: the survey's value, forced false when synthesis fails or the task list
    overflows its cap.
- `dropped[]` — units that produced nothing: survey topics, find-existing angles, probe axes.
- `incomplete[]` — units searched but not exhausted, including the `history` and `docs` channels.
- `failed_channels[]` — channels that produced nothing at all. Survey: `history`, `docs`.
  Investigate adds `survey`, `synthesis`. Find-existing: `frame`, `repo`, `assess`. Probe:
  `repo-axes`, `probe`. Develop: `survey`, `history`, `run-state`, `planner`, `partition`,
  `integration`, `worktrees`, `scavenge`, `kb`, `integration-review`, `pipeline`.
- `unreached[]` — prose: surface nobody covered. Some workflows also restate a failed channel
  here, and find-existing records "searched and found nothing" lines here too.
- `resumable` — `{runId, remaining}`, plus `args` in the survey and investigate. The script cannot
  read its own run id, so `runId` says so, and the caller records the real one at launch.
- `from_kb[]` — provenance, never part of `complete`. The survey and develop always emit it;
  probe, find-existing and investigate's own exits do not. The survey also records its
  absence-deposit outcome here, so a non-empty `from_kb` does not by itself mean anything was
  recalled.

### Effort store

`.claude/vfa/efforts/<effort>/`, described under [Efforts](#efforts).

- **Owner:** `lib/effort.mjs`.
- **Restated in:** the verbatim block `effort-store` in `skills/design`, `skills/develop` and
  `skills/probe`; the `prior` input of `vfa-survey` and `vfa-develop`, which accept it as a string;
  `CLAUDE.md`.

The pieces:

- `<effort>` — one path segment, `^[a-z0-9][a-z0-9._-]*$`, at most 120 characters. `slug` builds
  `<UTC date>-<first six words, kebab-case>`.
- `effort.json` — written once and never rewritten: `about`, `roots[]` (default: the repo),
  `opened_at`.
- `surveys/<stamp>.json`, `probes/<stamp>.json` — a phase's return, verbatim. A stamp is UTC
  `YYYYMMDD-HHMMSS`, suffixed `-2`, `-3` on a collision.
- `surveys/<stamp>.anchor` — written beside each survey when it is recorded:
  `{observed_at: <HEAD sha, '' when git could not answer>, ground: [<repo-relative path | '.'>]}`.
  A ground path that fails the path guard empties `ground`, which refuses standing.
- `links.jsonl` — `{kind: run | design, value, at}`. Readers skip malformed lines and dedupe.

The CLI: `slug`, `open`, `record … survey|probe --file`, `link … run|design --value`, `read
[--latest survey|probe]`, `standing`, and `list`. `standing` prints, under a digest,
`{standing, why, effort, survey_path, stamp, observed_at, head, ground, commits_since, dirty}`.
The `effort` input of `vfa-develop` restates the slug rule.

### Programme graph and events

- **Owner:** `lib/programme.mjs` (`parseProgramme`, `EVENT_TYPES`, `appendCheck`,
  `deriveProgramme`, `driftCheck`, `LEAF_SECTIONS`, `ROOT_SECTIONS`, `assembleNotes`).
- **Restated in:** `skills/plan` (a worked `programme.json`), `skills/programme` (the status
  routes, and the verbatim block `programme-merge-target`, twinned with `skills/develop`),
  `skills/design` (paths and section markers), `skills/runs`, `CLAUDE.md`.

`docs/vfa/designs/<name>/programme.json`, read from the programme worktree when one exists:

- `advance` — `gated | standing`, default `gated`.
- `nodes[]`, each with:
  - `id` — required and unique;
  - `kind` — `group | slice`;
  - `parent` — optional: `''` or a group's id;
  - `delivers` — what a person gets;
  - `deps` — a slice id, or `{id, reason}`. The reason is required unless the node consumes
    something that dependency provides;
  - `provides` — `[{name, paths[]}]`, names unique across the programme;
  - `consumes` — contract names, each provided somewhere in the node's transitive deps.

Unknown keys are dropped. The design tree beside it holds `system.md` (requires the
`settled-evidence` section), `slices/<id>.md` (requires `change`, `decisions` and
`settled-evidence`; `ground` is optional) and `plan.md`.

The event log is `.claude/vfa/programmes/<name>/state.jsonl`, append-only, written only by the
CLI's append verbs, and mirrored to `progress.md` on every append:

- `opened` — `{base_branch, base_sha}`, once.
- `delivered` — `{slice, run, merged_sha, coverage, ruling}`, once per slice. `run: ''` marks
  external work and then requires a `ruling`. A run must be `integrated` or `landed` to be
  delivered.
- `accepted` — `{slice, gaps[], ruling, by}`: gaps copied exactly from the delivery's
  `coverage.unreached`.
- `merged-to-base` — `{sha, base_branch, slices[]}`, where the slices are derived.

Slice status, in precedence order: `unknown`, `landed`, `delivered`, `delivery-pending`,
`in-flight`, then `awaiting-design` or `pending` (undesigned; dependencies met or not), then
`ready` or `blocked` (designed; dependencies met or not). A slice is **satisfied** when it is
delivered and either external, complete, or every `unreached` line has been accepted.

The CLI: render (`--json`, `--write-view`, `--watch`), `--notes <slice>`, `--change <slice>`,
`--section <name> --file <path>`, `--drift <sha>` (`{flagged, unexamined, moved}`), and
`--append-opened | --append-delivered | --append-accepted | --append-merged`.

### Workflow returns

What each workflow hands its caller. Every one also carries a `coverage` block.

- **`vfa-survey`** — takes `question, roots, notes, max_topics, prior, intelligence, plugin_root`.
  Returns `{question, topics, ground, verdicts[{topic, conclusion, evidence, risks}], history,
  docs, coverage}`, where `ground` is the topics' subtrees (`.` for a repository-wide topic). Search agents report `stop_reason` as `exhausted | unfinished | stuck`.
- **`vfa-investigate`** — takes `question, roots, notes, as_tasks, intelligence`. Returns
  `{question, mode, tasks{summary, gaps, tasks[{ref, subject, description, activeForm,
  blocked_by}]} | null, report | null, evidence | null, coverage}`. Tasks are capped at 12;
  `evidence` is set only when synthesis fails.
- **`vfa-find-existing-solutions`** — takes `capability, roots, constraints, notes, max_angles,
  intelligence`. Returns `{capability, constraints, frame, already_present[{path, line, note}],
  candidates[{name, source_url, what_it_is, latest_version, license, maintenance, covers,
  does_not_cover, disqualifiers_hit}], viable, ruled_out[{name, why}], coverage}`.
- **`vfa-probe`** — takes `artifact, roots, context, max_derived_axes, per_axis, plugin_root`.
  Returns `axes[{key, source}]`, `axes_dropped`, `analysts` (the axis keys each analyst held),
  `shared_ground`, `guidance_read`,
  `findings[{id, severity: ambiguity | gap | note, section, claim, evidence, axis}]`,
  `ambiguities`, `ratifiable` (no ambiguities and a complete coverage block) and `coverage`.
  `lib/citations.mjs` prints `{artifact, repo, read_error, files[{path, lines, cited_at,
  excerpts}], unresolved[{path, why: missing | out_of_range, detail}], counts, artifact_lines,
  notes}`.
- **`vfa-develop`** — every exit goes through `developResult`: `{change, work_orders, coupled,
  deferred, blocked, implemented, escalations, integration, plan_path, checkpoint,
  survey_coverage, coverage}`. `checkpoint` is `null` unless the run stopped before dispatching
  (see [Checkpoints](#checkpoints)). `integration` carries `branch`, `merged`, `head_sha`,
  `merge_stopped_at`, `approved_unmerged`, `wave_verify` and the integration `review`. Each
  `implemented` entry's `review` carries `at_integration`, true when its only adversarial review
  was the integration review. `coupled`
  entries carry the whole order body.

---

## Not built

These are absent today. Each is a deliberate gap, stated so nobody assumes it exists.

- **Lanes beyond `fix`.** No `tdd` or `docs` order-level lane, no series-shape rules over a
  declared test and implementation locus, and no test-migration lane. The `test-author` agent
  exists and its allowlist is pinned, but no workflow dispatches it yet: red orders are written
  by the `coder`.
- **Just-in-time planning inside a run.** A run plans every order up front. Planning only the
  frontier and elaborating later slices against merged reality happens one level up, in
  programmes, but not inside a run.
- **Edge-triggered dispatch.** Waves are still a barrier: an order waits for its whole wave to
  close, not just for its own dependencies to merge.
- **More knowledge-base anchor classes.** Only the file anchor exists. There are no guardian
  anchors (a pinned test that fails when a broad claim dies), no surface-glob anchors, no
  `kb init` harvesting of existing notes, and no `INDEX.md` render for humans.
- **Tier feedback.** The approval line records what each order's tier bought, and nothing reads
  it back.

---

## Keeping this document true

- A behaviour-changing change updates this document in the same commit series as the code. Agent
  constitutions and skill texts count as code here.
- It describes the present. No history, no increment numbers, no links to documents that no
  longer exist. Git has the history.
- `test/design-doc.test.mjs` pins that the major sections exist and are not empty, and that the
  doctrine sentences are stated rather than merely referenced.
- The verbatim blocks above (`review-loop-exit`, `severity-ladder`, `merge-result`,
  `programme-merge-target`) are checked against their copies by `test/verbatim-blocks.test.mjs`.
  Edit one, and every copy has to move with it.
- `docs/superpowers/` is gitignored local scratch for planning sessions. Nothing there is part of
  the design, and nothing in the repository may point into it.
