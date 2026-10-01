# CLAUDE.md — agentics

Guidance for Claude Code when working in this repository.

## What this is

A Claude Code plugin providing workflow-orchestrated design, investigation and development over a
generic codebase. All work is **one execution tree**: an effort is a subtree of `design`,
`composite` and `leaf` nodes, decomposed until every leaf is atomic, executed by readiness in
framework-owned worktrees, reviewed by rigor, merged by composite, and landed into the user's
branch only on their go. The design — the whole system, as it is today — is `docs/DESIGN.md`. Read
its **Iron Laws** and **Guiding Principles** before changing anything: they bind every change to
this plugin, and each names the mechanism that enforces it.

Its runtime artifacts are declarative — agent markdown, workflow JS, `SKILL.md` — plus `lib/` CLIs
for everything deterministic. They are validated in layers: `tools/lint.mjs` judges form, the
scenario harness (`test/harness/workflow-host.mjs`, `test/harness/develop-sim.mjs`) executes the
workflows' orchestration with scripted agents, real-git tests run every boundary, and pins keep
restated contracts (`<!-- agentics:verbatim <id> -->` blocks), agent allowlists and pointers into
the design from drifting. `test/liveness.test.mjs` fails anything defined and never consumed.

Run the checks with:

    node tools/lint.mjs && node --test

## Rules for changing this repository

- **Redesign, never work around.** The plugin is young and any refactor is affordable. When a
  limit — a host's output cap, a transport, a contract, a tool's shape — gets in the way, change
  the design so the limit stops mattering. Never add a mechanism whose only job is to squeeze
  past it: paging, chunking, size-tuned retries, a second path for the big case. If the clean,
  efficient fix means reshaping workflows, the lib or the contracts, reshape them.
- **Docs land with the code, in the same commit series.** `docs/DESIGN.md` is the single design
  document: the whole system **as it is right now**. A behaviour-changing change is not done until
  DESIGN.md says what the code now does. Agent definitions and skill texts count as code here. It
  carries no history and no links to documents that no longer exist. Code, tests, skills and agents
  point into it as `docs/DESIGN.md#<anchor>`, and `test/design-doc.test.mjs` fails on any pointer
  whose heading is gone.
- **Data contracts are registered in `docs/DESIGN.md#data-contracts`** — the node record and
  events, the spec format, the ledger lines, the compile result, the state and journal lines,
  `seq`, the verify payload, the progress file, the gotcha file, slots and locks, the boundary payloads, the
  replanning returns, the coverage block and the workflow returns — each
  with the code that owns it and every place it is restated. **Any change to one of those field
  lists updates its entry there and edits every copy the entry names, in the same commit series;
  any change to an agent's `tools:` line edits `test/agent-allowlists.test.mjs` in the same
  commit** — nothing finds those copies for you.
- **Capability is the agent's frontmatter tool allowlist and nothing else. There are no hooks, and
  there will be none** (plugin hooks fire in every session on the machine). Restraint in an agent
  with a shell is prose, audited post hoc; the criterion is zero breaches surviving to review.
- **Runtime text holds instructions and contracts; reasons live in DESIGN.md.** Every skill and
  agent file has a size budget in `tools/budgets.json`, enforced by the `size-budget` lint rule.
- **A format change ships a one-shot migration script, never a permanent second reader**
  (`tools/migrate-legacy.mjs` is the current one).
- `docs/superpowers/` is gitignored scratch for the vf-superpowers planning skills; nothing in the
  repository may point into it.

Whoever decides a dispatch — a skill's session, or you writing a workflow — works to this:

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

Where this plugin needs shared ground it is code — `lib/citations.mjs`, the survey's common
ground, the brief assembled by `lib/brief.mjs` — never a sentence asking a model to arrange it.

## Versioning

The version lives only in `.claude-plugin/plugin.json`. The plugin ships through the `vanillafairy`
marketplace (VanillaFairy/agentic-plugins), which holds this repository as a submodule and carries
no version of its own for it. Verify with:

    claude plugin validate .

## Standing requirements

Stated by the user 2026-08-27; every proposed improvement to this plugin must serve at least
one.

1. **Configurable intelligence per task.** Intelligence level is balanced and configurable at
   task granularity — not one dial for the whole run.
2. **Completion is mandatory.** If a task is set, it must be done, regardless of cost. This is
   IL1 in `docs/DESIGN.md#iron-laws`, mechanically enforced by the rules in the table below.
3. **Minimize cost within the chosen level.** Given the selected intelligence level, any
   available cost reduction must be taken. Cheap where cheap suffices.
4. **Judge the effort's shape.** Development tasks differ: some need strict red-green-refactor
   TDD, some are simple tasks, some are in between. The system must judge which shape a piece
   of work needs. Applies mostly to leaves (see `docs/DESIGN.md#rigor`).
5. **Maximum resumability.** Detect early when a session limit is likely to be hit — never
   start lengthy work that is doomed to be killed; split it into smaller steps. See
   `docs/DESIGN.md#resume-and-checkpoints` for the current resume design.
6. **Deterministic → script.** If something is deterministic, it must be done as a script, not
   a model. Model calls are reserved for judgment.

---

---

## Which rule enforces which law

The laws themselves are in `docs/DESIGN.md#iron-laws`.

| Law | Enforced by |
|---|---|
| IL1 — a set task is finished; no counter ends anything | `tools/rules/no-turn-caps.mjs`; typed escalations on every agent; the resume ladder (`lib/resume.mjs`) |
| IL2 — a partial result never looks like a whole one | `tools/rules/coverage-block.mjs`; `stop_reason` schemas; continuation loops in `gather-evidence-without-concluding`; a `.catch` on every side channel; `tools/rules/task-tool-fallback.mjs` |
| IL3 — nothing judges itself | `tools/rules/no-self-verdict.mjs`; `lib/verdict.mjs`; the computed review-loop exit in `execute-approved-plan-in-worktrees` |
| IL4 — the user owns decisions and their tree | `lib/boundary.mjs land` behind the session's gate; `lib/verify.mjs`'s linked-worktree refusal; `decisionProblems` in `lib/tree.mjs`, which admits a decision only from compile, against the approved copy on the ledger (`lib/approval.mjs`), and refuses a replan that changes a contract or drops a realised decision; `lib/respec.mjs`, which approves a changed spec without the user only on rulings that are all `unaffected`, each recorded on the ledger |
| GP2 — nothing outlives its consumer | `test/liveness.test.mjs`; `tools/rules/size-budget.mjs` |

## Build

    node tools/lint.mjs && node --test
    node --test test/<file>.test.mjs
    claude plugin validate .

## Architecture

- `lib/` — deterministic CLIs: tree, ledger, compile, boundary, verify (`lib/INDEX.md`)
- `tools/` — lint, its rules, size budgets, one-shot migration (`tools/INDEX.md`)
- `agents/` — subagent definitions; allowlist is capability (`docs/kb/agents.md`)
- `service-workflows/` — sandboxed orchestration scripts; reach lib via courier (`service-workflows/INDEX.md`)
- `skills/` — user entry points: design, develop, task, investigate, next (`docs/kb/skills.md`)
- `test/harness/` — runs workflows offline with scripted agents (`test/harness/INDEX.md`)

## Knowledge base

Each module in the Architecture map has an index at the path shown there: `INDEX.md` beside the
source, or `docs/kb/<module>.md` where a file in the module's folder would load as runtime text.
An index holds what the code and `docs/DESIGN.md` cannot say: couplings, fences, what a change
breaks elsewhere. It never repeats what a signature or a header comment already states.

- `docs/kb/CONVENTIONS.md` — lib file idioms, CLI exit codes, what to touch when adding an agent/skill/workflow/rule.
- `docs/kb/GOTCHAS.md` — copies that must move together, LF, plugin cache, branch naming.
- `docs/kb/BUILD.md` — checks, manifest validation, versioning and distribution.
- `docs/kb/TESTING.md` — running tests, the `node --test test/` trap, what each layer proves.

The KB is a routing aid that bottoms out in source. For exact constants, enumerations or
sequences, read the source. The KB carries no counts.

The KB is refreshed once per finished effort, never inside the commits that build it; until then,
where it disagrees with source, source wins. When an effort is complete, run `/kb:update` with no
argument, which commits its result separately.
