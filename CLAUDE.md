# CLAUDE.md — agentics

Guidance for Claude Code when working in this repository, and the law inherited by every agent
this plugin defines.

## What this is

A Claude Code plugin providing workflow-orchestrated design, investigation, and development
over a generic codebase. Its runtime artifacts are declarative — agent markdown,
workflow JS, `SKILL.md` — and are validated in three layers: `tools/lint.mjs` judges form, the
scenario harness (`test/harness/workflow-host.mjs`) executes the workflows' orchestration
arithmetic with scripted agents, and `test/verbatim-blocks.test.mjs` diffs every contract that
is restated in prose (`<!-- agentics:verbatim <id> -->` markers) so copies cannot drift. The design
itself — the whole system, as it is today — is `docs/DESIGN.md`.

The development pipeline runs **design → ratified change → develop**. `design` interviews the
user against surveyed evidence and produces the ratified change; `develop` surveys, plans,
partitions, and then runs **every wave of that plan in one invocation**, merging each wave into
an integration worktree it creates and owns. The invariant is tree ownership, not merging:
**the workflow never mutates the user's branch or working tree.** A run's plan and its
wave-by-wave progression are persisted under `.claude/agentics/runs/<runstamp>/`, so an interrupted
run resumes by path instead of by re-buying its survey.

Runs are a **lifecycle**, not a single invocation. `develop --plan-only` parks a plan without
implementing it; several may sit parked at once. `runs` lists every run in a repository with a
status derived from its artefacts (never stored) and hands a pick back to `develop`. A resume
adopts the conditions its plan was written under — roots, tier, settled evidence — from the
plan's envelope, and checks whether the user's tree moved under it before dispatching
anything.

`probe` is the adversarial review of a **written artefact** — a design, a proposal, a spec.
Independent analysts get the document and the repository and nothing from the author; the
ratification gate is a computed count of open ambiguities. `design` step 3 invokes it rather
than describing a probe of its own.

Above a run sits the **programme layer**, for a design whose honest decomposition is several
deliverable slices rather than one change. It repeats the same WHAT → HOW → DO split one level
up: `design` writes a directory (`system.md` plus just-in-time leaves), `plan` turns it into
`programme.json` — slices, dependencies, and the contracts that pass between them, built with
the user, and **the artifact's existence is the authorization** — and `programme` drives one
`develop` run per slice onto a branch the layer owns. Progress is derived from an append-only
event log by `lib/programme.mjs`, never stored as a status; the user's checkout moves once, at
the end, on their yes. **`plan` decides slices; the planner agent decides work orders.**

The pipeline is friendly to interruption by default. `develop` looks for an existing run for
the same change before planning a new one — and the workflow enforces the same check
mechanically: a fresh invocation whose change string matches a `planned` or `in-flight` run
on disk halts at a checkpoint (`existing_run`) instead of planning a duplicate, because a
skill instruction guards only the callers that read it and a silent harness-cache miss
arrives as a fresh invocation. Because order branches are named deterministically, it can go
and look at what an interrupted invocation actually built.

**Durability is written by whoever performs the action, in the execution that performs it.**
A record produced by a separate dispatch after the fact has a window where the work exists and
nothing on disk says so, and a usage limit has landed in that window in the field. So agents
append what they observed to `journal.jsonl` themselves — the verifier its measurements, the
merging agent its merges, the coder the fact that its series is finished — while `state.jsonl`
holds what the *workflow* decided: approvals, escalations, wave outcomes. No agent journals a
verdict: verdicts are re-derived from the recorded facts on resume, by the same functions that
derived them the first time, which is what makes agent-written durability safe. Both files
share one monotonic `seq`, minted here and copied by the writer — a counter rather than a
clock, because an agent that can read a clock can invent one, and a fabricated timestamp orders
two records confidently and wrongly.

**Bytes never ride a model; references and digests do.** A workflow script has no filesystem, so
everything crossing between disk and the script used to ride an agent's OUTPUT, which is where
corruption lives — a loader paraphrased 13 of 14 orders, a recorder wrote five unparseable
lines, and a courier mangled `partition_raw` three times running, each time degrading a
half-built run to "every order is coupled". Reading is the safe direction: a tool result enters
an agent's context byte-exact. So `lib/run-verdict.mjs` computes the entire resume decision on
disk and prints it with its own digest, a courier pastes that stdout, and the script recomputes
the digest before believing a word of it. `lib/ledger.mjs` is the only writer: it parses, checks
the caller's digest, and refuses a line it cannot prove intact. Order prose is never
transported — a coder fetches its own order with `ledger.mjs order` and confirms the digest.
Design: `docs/DESIGN.md#the-ledger`.

**Verification travels the same way, because it is a script.** `lib/verify.mjs` runs the
mechanical checks — commit series, build, typecheck, suite, discriminator, and any declared
mutations — in one process and prints them
under one digest; the verify dispatch is a courier that pastes that line, and the workflow
recomputes the digest before believing a field of it. Running a command and copying its exit
status is not judgment (IRON LAW §8). What stays a model's work is an *escalation*: choosing a
build command nobody has established, and triaging a typed error the program could not resolve.
No verdict predicate moved — the payload carries exactly the fields they already read, which is
why a script may safely do the measuring.

A digest makes corruption **detectable**; it cannot make the retry likelier to succeed, because
the retry is typed by the same agent into the same shell. So a line the workflow mints whole
travels **base64** on one argv slot — no path to escape, no apostrophe to close, no heredoc
delimiter to indent — and the digest is still rechecked after decoding. Journal lines keep the
heredoc, because they carry values only the observing agent knows and there is nothing to encode
ahead of time. Field case: run `20260829-140744` lost its wave line and every escalation line to
a mismatch three retries could not clear, while every journal line in the same run landed.

**A red order never reaches the integration head alone.** A red's whole product is a failing
test; merged on its own it makes the integration head red, and every order in every later wave
is then coded, verified and reviewed against a tree failing for a reason none of them own. With
one red/green pair that is invisible. With two, the partition packs both reds into one wave and
each green is measured on a suite still failing its *sibling's* tests — a fix round it can only
answer "these are not my tests", and a no-commit answer escalates. Run `20260829-140744`
escalated five orders of finished, correct work that way and blocked thirteen behind them.

So an approved cycle member is **held** rather than merged, its cycle's later members are
anchored on its branch instead of the integration head, and the branch tips merge together once
the last member is approved. The cycle is read from `role` and `deps` — nothing new is asked of
a plan. Two properties follow: the integration head is never red, so a green is measured on its
own red's tests and nothing else and the strict verdict already applied to it stays strict; and a
run that stops between waves leaves a branch that still builds. `excusedRedFiles` survives only
for a run resumed from a ledger written before this, whose reds are already merged alone.

A resume then **salvages to the action**. Each order's lifecycle is a fixed sequence —
`code → verify → review → merge` — and the verdict names the single **next undone action** per
order, trusting a stage exactly as far as two independent sources agree: the run recorded that
it closed, and git still holds the head it closed over. Rebuilding from scratch is the bottom of
that ladder, not the top. Committed work is scavengeable by right, since commits live on the
branch and survive a lost worktree; uncommitted work is reported as a fact and adopted by
nobody automatically. Two regimes, deliberately asymmetric: a **clean** run — empty ledger, no
`agentics/<runstamp>-*` branches — has nothing to salvage *by definition* and opens for the cost of
one `git branch --list`, while a **dirty** one resumes each order exactly where it stopped.
Escalations are carried forward rather than silently retried — `retry_escalated` names the ids
whose cause has been dealt with. Salvage is always reported: a run that says "implemented W4"
about work it adopted rather than did is describing work it did not do.

Because the recovery surface is one order's series, **order grain is a correctness property, not
tidiness**: the planner aims at commit series of dozens of lines rather than hundreds, so a
session limit costs dozens.

**Capability is one mechanism: the agent's frontmatter tool allowlist. There are no hooks, and
there will be none** — ruled 2026-08-30 on field experience with the sibling plugin's hook layer
plus the interference surface (plugin hooks fire in *every* session on the machine). Four agents
carry no shell and their blindness is a fact about what they can do; eight carry `Bash`, a shell
subsumes writing, and every restraint in those eight is prose their constitution states as
prose. Locus enforcement stays post-hoc in `lib/commit-series.mjs` — the criterion is **zero
breaches surviving to review**, never zero breach attempts.

**A dispatch is bought by the turn, and an instruction does not build a mechanism.** Every agent
here that searches or reads — analyst, coder, doc-researcher, historian, planner, reviewer, scout,
test-author — carries the `dispatched-economy` block in its constitution, where parallel copies
share the cached system prompt instead of each paying for a prompt body; the four couriers run one
command and carry none of it. Whoever decides a dispatch — a skill's session, or you writing a
workflow — works to this:

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

Measured on 2026-09-16, an orchestrator told exactly this still sent four tool-bearing agents that
each located the same ground for itself: the instruction bought the agent it declined to add, and
none of the sharing. So where this plugin needs shared ground it is code — `lib/citations.mjs`,
the survey's `common_ground` — never a sentence asking a model to arrange it. Design:
`docs/DESIGN.md#what-a-dispatch-costs`.

**What a run learns outlives the run, and none of it is stored as a status.** The project knowledge
base at `.claude/agentics/kb/` mirrors the source tree, one append-only `node.jsonl` per node, holding
anchored observations: what was seen, where, and at which commit. Depth is `LCA(about)` and
freshness is `git log <observed_at>..HEAD -- <about>`, both recomputed on every read by
`lib/kb.mjs` — a status computed cannot be stale, while a status written down outlives the thing it
described. The event log is **git and not this pipeline's ledger**, because the base outlives runs:
hand commits and triage-routed direct sessions write no ledger line, so ledger arithmetic would
certify a stale entry fresh. A coder is seeded with the fresh entries of its own locus chain; a
verifier is seeded with nothing, exactly as it always was; the one thing a verification takes from
the base is the build and suite commands an earlier investigation established, admitted only when
the entry is fresh **and** its source says a verification wrote it. Both seams are advisory side
channels and neither can make a run incomplete.

**What a phase produces outlives the phase.** An **effort** at `.claude/agentics/efforts/<effort>/` is the
unit of work that spans design, survey, probe and runs, and every phase records its return there,
verbatim, written by the session that ran it. Runs and designs are pointers rather than nested
children, so nothing about the resume ladder's paths moved. Read back as `prior`, a return is
**durable scratch and never evidence**: it reaches a survey's planner and nowhere else, and never
the knowledge base's null-survey gate, which reads one computed freshness field and no provenance
at all. **One exception, and it is computed:** a recorded survey is anchored to its commit and the
ground its topics searched, and `lib/effort.mjs standing` answers from git whether it reported
complete coverage and whether anything has touched that ground since. Beside the caller's
`settled_shape`, a standing survey stands in for `develop`'s, so a design pass's survey is not
bought twice. Design: `docs/DESIGN.md#efforts`.

**The survey consumes it too, and the order matters.** Its Plan phase receives the tree *index* —
node paths, entry counts, kinds, no state at all — because before a decomposition exists the only
known paths are the roots, and a chain at a root is the repo-wide node alone. The planner
decomposes against the index and names each topic's subtree; the chains are fetched *then*, at
those subtrees, so freshness is bought only for ground somebody decided to search. Fresh entries
are evidence and turn their topic into a verification; stale ones are leads for the search and
reach no analyst. Anything a result recalled rather than searched for is named in the coverage
block's `from_kb`, derived from what the script handed out and never from an agent's account of
what it used — and its absence reads as "nothing came from cache", never the reverse.

**The survey is the first phase whose presence is derived.** When the caller reports the change's
shape settled (a judgment, so it stays in the caller's seat) *and* names ground the base covers
with fresh entries (arithmetic, so it is computed and never claimed), the phase collapses and the
chain is the run's evidence base — stated in `from_kb`, including that nothing was re-searched. A
stale chain, a partly covered one, or one that could not be read all refuse the collapse by
construction: a phase skipped on the strength of leads is exactly the laundering §2 forbids.

**The data contracts are registered in `docs/DESIGN.md#data-contracts`** — the plan envelope and
work order, the `state.jsonl` and `journal.jsonl` lines, `seq`, the verify payload, the resume
verdict, the knowledge-base entry, the coverage block, the effort store and the programme graph —
each with the code that owns it and every place it is restated. **Any change to one of those field
lists updates its entry there and edits every copy the entry names, in the same commit series; any
change to an agent's `tools:` line edits `test/agent-allowlists.test.mjs` in the same commit** —
nothing finds any of those copies for you.

**Docs land with the code, in the same commit series.** `docs/DESIGN.md` is the single design
document: the whole system **as it is right now**. A behaviour-changing change is not done until
DESIGN.md says what the code now does. Agent constitutions and skill texts count as code here, not
as docs. DESIGN.md carries no history, no increment numbers and no links to documents that no
longer exist — git holds how the system got here. Code, tests, skills and agents point into it as
`docs/DESIGN.md#<anchor>`, and `test/design-doc.test.mjs` fails on any pointer whose heading is
gone. `docs/superpowers/` is gitignored scratch for the vf-superpowers planning skills; nothing in
the repository may point into it.

Run the checks with:

    node tools/lint.mjs && node --test

## Versioning — bump the version in two places

Whenever this plugin's version is bumped, **both** of these move together, in the same change:

1. `.claude-plugin/plugin.json` — the `version` field.
2. The `agentics` entry in `../.claude-plugin/marketplace.json` — the vanillafairy marketplace
   manifest, one directory up. Note it is **outside this repo**, so a commit here does not carry it.

Missing the second one does not break an install — at install time `plugin.json` wins and the
marketplace entry is silently ignored. That is exactly why the drift survives unnoticed: the
stale number is still what the marketplace reports to `claude plugin list --available` and to
update tooling, so everything *reads* like a version nobody is actually running. Verify with:

    claude plugin validate ..

## Standing requirements

Stated by the user 2026-08-27; every proposed improvement to this plugin must serve at least
one.

1. **Configurable intelligence per task.** Intelligence level is balanced and configurable at
   task granularity — not one dial for the whole run.
2. **Completion is mandatory.** If a task is set, it must be done, regardless of cost. This is
   §0 below, mechanically enforced by the rules in the table that follows it.
3. **Minimize cost within the chosen level.** Given the selected intelligence level, any
   available cost reduction must be taken. Cheap where cheap suffices.
4. **Judge the effort's shape.** Development tasks differ: some need strict red-green-refactor
   TDD, some are simple tasks, some are in between. The system must judge which shape a piece
   of work needs. Applies mostly to work orders.
5. **Maximum resumability.** Detect early when a session limit is likely to be hit — never
   start lengthy work that is doomed to be killed; split it into smaller steps. See
   `docs/DESIGN.md#resume` for the current resume design.
6. **Deterministic → script.** If something is deterministic, it must be done as a script, not
   a model. Model calls are reserved for judgment.

---

# §0 — THE IRON LAW

> **When the task is set, it MUST be done and finished, no matter the cost.**
>
> Token efficiency and wall-clock time are real goals and should be achieved wherever they
> cost nothing. They are **optimizations, never termination conditions.** The goal is reached
> regardless.

A law with no enforcement is decoration. Its mechanical consequences:

1. **Completion is defined by the goal, never by a counter.** No agent stops because it hit N
   tool calls, N rounds, or N tokens. Budgets trigger *escalation*, never "done". A prompt
   that says "stop after N" is a bug.

2. **Truncation is never silently laundered into completeness.** Every search-shaped output
   carries an explicit `stop_reason` enum — never a self-reported `complete` boolean — plus
   the surface actually covered and what was not.

3. **Incomplete work is resumed, not reported.** When `stop_reason !== 'exhausted'`, call the
   agent again with what it found and what remains. Only after genuine exhaustion is a topic
   incomplete, and then it *leads* the output rather than sitting in a footnote.

4. **A partial result must never be indistinguishable from a whole one.** An answer built on
   two-thirds of the evidence looks exactly like a complete one. This is the single failure
   mode the whole plugin exists to prevent.

5. **Every side-channel gets a `.catch`.** A failing docs or history agent must not discard
   work already paid for. Log it, carry the flag into synthesis, and state plainly that any
   claim resting on it is unsupported.

6. **Budget exhaustion is a loud, resumable halt — not an answer.** Return an explicit
   incomplete verdict with enough state to resume.

7. **Escalate, never abandon.** An agent that cannot finish returns what it established, what
   it tried, and what it would need. "I couldn't" and "there is nothing there" are different
   answers and must never be conflated.

8. **Cost is controlled by method, not by cutting the work short.** The levers are model tier,
   effort level, tight schemas, and pushing determinism into `lib/`. Exceeding the
   workflow-size guideline when continuation rounds fire is *intended* — say so in the
   narrator line rather than trimming rounds.

---

## Which rule enforces which clause

| Clause | Enforced by |
|---|---|
| §1 no counter-based termination | `tools/rules/no-turn-caps.mjs` |
| §2 stop_reason enum, not a boolean | the `HITS` schema in `agentics-survey` + `tools/rules/coverage-block.mjs` |
| §3 resume, do not truncate | `scoutUntilComplete` in `agentics-survey` |
| §4 partial ≠ whole | `tools/rules/coverage-block.mjs` + `tools/rules/task-tool-fallback.mjs` + `coverage.from_kb` |
| §5 side channels get `.catch` | every side channel in the workflows, `agentics-survey`'s history and docs channels first |
| §6 resumable halt | `coverage.resumable` |
| §7 escalate, never abandon | the agent constitutions |
| §8 cost via method | model and effort tiering, and the intelligence dial (`docs/DESIGN.md#model-tier-earned`) |
