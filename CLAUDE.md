# CLAUDE.md — agentics

Guidance for Claude Code when working in this repository.

## What this is

A Claude Code plugin for designing, investigating and building changes in any codebase. All work
is **one execution tree**: an effort is a subtree of `design`, `composite`, `group` and `leaf`
nodes, decomposed until every leaf is atomic, executed by readiness in framework-owned worktrees,
reviewed by rigor, merged by composite, and landed into the user's branch only on their go.
Orchestration is code: programs in `lib/programs/` read and write the store themselves and start
every agent through one runner (`lib/runner.mjs`), which launches a headless Claude Code session
per dispatch. The design — the whole system — is `docs/DESIGN.md`. Read its **Laws** and
**Principles** before changing anything: they bind every change, and each law names the mechanism
that enforces it.

Run the checks with:

    node tools/lint.mjs && node tools/suite.mjs

`node tools/suite.mjs --fast` runs only `test/fast/`, the tests that spawn no process, in about a
second; the script reruns a failed run's failures before calling any of them red.

## Moving to 5.0.0

Branch `v5` moves the plugin from 4.x to 5.0.0 in four phases: foundations, the evidence
programs, execution, and removing what 4.x alone used. Until the last phase what is left of the
4.x runtime still lives here: the evidence workflows in `service-workflows/`, the agents in
`agents/` they name, the courier, `test/fast/harness/workflow-host.mjs` with the workflows' scenario
tests, and the lint rules that guard them. An execution runs only as the `execute` program, over
the in-process boundaries in `lib/boundaries/`; no boundary is reached through the courier. Keep
the 4.x runtime working and never add to it. New code follows `docs/DESIGN.md` and the rules below.
On this branch the design leads the code: where they disagree, the design is the target.

## Rules for changing this repository

- **Redesign, never work around.** When a limit — a host's behaviour, a transport, a contract, a
  tool's shape — gets in the way, change the design so the limit stops mattering. Never add a
  mechanism whose only job is to squeeze past it.
- **Code does what is deterministic; models only judge** (P2). Code moves bytes between
  programs: a brief goes into a prompt, a result comes back in a return, and no model carries
  another program's output. A name a model types is resolved or refused (`resolveHandle`).
- **No agent rules on its own work** (L3). A producer declares, a judge rules per unit, code
  combines. Never give a producer's or searcher's return schema a ruling field.
- **Docs land with the code, in the same commit series.** A behaviour-changing change is not
  done until `docs/DESIGN.md` says what the code now does. Role files and skill texts count as
  code. The design carries no history and no links to documents that no longer exist, and
  `test/fast/design-doc.test.mjs` fails on a pointer whose heading is gone.
- **Data contracts are registered in `docs/DESIGN.md#data-contracts`**, each with its owner and
  every place it is restated; a change to a field list edits every copy the entry names, in the
  same commit series. A change to a role's `tools:` or `commands:` edits its pin test in the same
  commit.
- **Capability is the role's tool list plus the permissions the runner computes. There are no
  hooks, and there will be none** (plugin hooks fire in every session on the machine). The
  runner confines every agent to its worktree, its paths and its commands; what it cannot
  prevent, it detects.
- **Runtime text holds instructions and contracts; reasons live in DESIGN.md.** Every skill,
  role and agent file has a size budget in `tools/budgets.json`, enforced by the `size-budget`
  lint rule.
- **A format change ships a one-shot migration script, never a permanent second reader**
  (`tools/migrate-*.mjs`).
- `docs/superpowers/` is gitignored scratch for the vf-superpowers planning skills; nothing in
  the repository may point into it.

Whoever decides a dispatch — a program's author, or a session — works to this:

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
   L1 in `docs/DESIGN.md#laws`, mechanically enforced by the rules in the table below.
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

## Which mechanism enforces which law

The laws themselves are in `docs/DESIGN.md#laws`.

| Law | Enforced by |
|---|---|
| L1 — honest state | `tools/rules/coverage-block.mjs`, which requires a coverage block in every program's `resultOf` and every workflow's return; `coverageOf` in `lib/programs/common.mjs`; the coverage every searcher's return schema requires and the per-unit rulings every judge's requires (`test/fast/schemas.test.mjs`); `resolveHandle` in `lib/store.mjs`, through which `lib/run.mjs` resolves every effort, folder, run and file argument (a ref is resolved by git or refused); status derived on read |
| L2 — states end work, counts don't | `tools/rules/no-turn-caps.mjs`, over the programs and the execute program's units (`lib/programs/execute/`), `lib/run.mjs`, skills, agents and workflows; the convergence predicates in `lib/verdict.mjs`; `askAfter` in `lib/programs/converge.mjs`; the runner's host-stop classes, waited out by `dispatch` in `lib/programs/common.mjs` |
| L3 — separate judges | the role kinds in `lib/roles.mjs`; `judgeAllowed` and `dispatchJudge` in `lib/programs/common.mjs`; `tools/rules/no-self-verdict.mjs`; `verdictOf` in `lib/verdict.mjs` |
| L4 — the user owns decisions and their branch | `verifyAnswer` and `confirmAct` in `lib/host.mjs`, called by `approveAct` in `lib/approval.mjs`, `landAct` in `lib/boundary.mjs` and the `rule` program; `userBound` in `lib/respec.mjs`, which the `rule` program and `respec.mjs settle` apply; `decisionProblems` in `lib/tree.mjs`; the runner's confinement and its watch on the user's checkout, and `measure`'s watch around every check in `lib/measure.mjs`; leaf-close's revert of what lies outside a leaf's locus in `lib/boundaries/leaf-close.mjs`; the `review` program's snapshot, which leaves the user's tree, index and stash untouched; `lib/verify.mjs`'s linked-worktree refusal; `land`'s refusals |
| P4 — everything earns its place | `test/fast/liveness.test.mjs`; `tools/rules/size-budget.mjs` |

## Build

    node tools/lint.mjs && node tools/suite.mjs
    node tools/suite.mjs --fast
    node --test test/<file>.test.mjs
    claude plugin validate .

`node --test` alone still runs everything, without the rerun. A test that spawns a process
belongs outside `test/fast/`; the `fast-tier` lint rule fails it there.

## Architecture

- `lib/` — deterministic modules and CLIs: the store, tree, ledger, compile, verify, measure,
  runner, host, locus and conversation modules, and the session's calls in `lib/boundary.mjs`
  (land, retry, note) (`lib/INDEX.md`)
- `lib/boundaries/` — the boundaries an execution calls in-process: preflight, schedule and
  postflight, leaf-open, leaf-close, leaf-review, merge-batch and the suite gate, folder-review and
  rule-close, and the autonomous review's, over one records core
- `lib/programs/` — the programs that orchestrate, started by `lib/run.mjs`; the execute
  program's units (a leaf, a planner's folder, the integration units) in `lib/programs/execute/`
- `lib/briefs/` — the prompts the programs build, one file per program (`execute.mjs` the
  execution's reviewers, rulers, planner and investigator; a leaf round's thread brief is
  `lib/brief.mjs`'s, a ruling's `lib/respec.mjs`'s)
- `roles/` — agent roles: instructions, tools and kind, read by the runner alone
- `skills/` — user entry points: design, develop, task, investigate, next (`docs/kb/skills.md`)
- `tools/` — lint, its rules, size budgets, one-shot migrations (`tools/INDEX.md`)
- `test/` — the `node --test` suite; `test/harness/` holds the scripted runner and the fake CLI
- 4.x, until the last phase: the evidence workflows in `service-workflows/`
  (`service-workflows/INDEX.md`), the agents they name in `agents/` (`docs/kb/agents.md`), the
  courier and `test/fast/harness/workflow-host.mjs`; no execution runs through them

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
