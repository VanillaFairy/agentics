---
name: task
description: Use when the user asks for a small, settled change the session can make itself — a fix, a rename, a config or text change, added tests, a small behaviour whose expected results are exact — in files that are already known. Verifies the premises, asks once, keeps the todo list as the plan, writes tests by rigor, and verifies with the project's own checks. Not for work that needs design, crosses subsystems or wants worktrees and parallel executors (develop), and not for a question (investigate).
---

# task

The inline mode: the session does the work in the user's tree, on the files it was asked to
change, and nothing else. Design: `docs/DESIGN.md#the-simple-task`.

## Step 1 — Verify the premises

Before any plan, check every file, symbol, behaviour and assumption the request names against
the code. Read them. A premise that does not hold — the function is elsewhere, the flag already
exists, the bug does not reproduce — is surfaced to the user now, with what you found, before
anything is planned on it.

Record the pre-change commit: `git rev-parse HEAD`. Every check below that needs "without the
change" is measured against it.

## Step 2 — Scope, rigor, questions

**Within scope** is what was asked, including the tests its rigor requires. **Auxiliary** is
what the change makes desirable — stale docs, a neighbouring cleanup, a rename it invites.
Propose auxiliary items as a separate list the user accepts or rejects; a rejected item does not
exist. A consequence ("leaving this out keeps the build red") is stated as information, never used
to decide for them.

**Rigor decides the tests.** Give each within-scope item a rigor by walking this table top-down;
the first match wins (`docs/DESIGN.md#rigor`):

| rigor | the item… | tests |
|---|---|---|
| `verify` | writes nothing: confirms a premise, proves a criterion already holds, measures | none; the check's result is the product |
| `trivial` | writes what a test would only restate: literal values, user-visible text, config, docs, assets, renames behind an unchanged interface, dependency versions, wiring existing parts | none new; an existing test asserting the changed value is updated with it |
| `tests-only` | only adds tests to code that is already correct | each new test passes now and fails under a mutation you declare |
| `tdd` | adds behaviour whose expected results are exact | test first; each new test fails at the pre-change commit and passes now |

A `tdd` change has a result the diff does not state literally — a computed value, a branch
taken, an error raised. Unsure between `trivial` and `tdd`: `tdd`. Never add or drop a test the
rigor does not call for. An item that needs `tdd-pair` or `tdd-triad` — edge-case rules, parsers,
state machines, concurrency, a contract other code consumes, persistence formats, migrations,
security, money — is not inline work: raise the tripwire.

**Ask, do not assume.** A genuine within-scope decision goes to the user, all of them batched in
one round of `AskUserQuestion` (up to four questions per call), each with your recommended answer
first, marked `(Recommended)`, and its reason in the option's description. The auxiliary list
rides in the same round. Anything the code can answer is looked up, not asked.

## Step 3 — The tripwire

Raise it — recommend the dispatched mode through `agentics:develop`, or a design node through
`agentics:design` — when the work:

- needs design exploration: the approach is not settled;
- is cross-cutting: several subsystems, or a contract other code consumes;
- adds a dependency or a technology;
- is ambiguous enough that it will take iterations to converge;
- is irreversible or risky: data, migrations, deletions, anything shipped outward;
- needs a rigor above `tdd`;
- outgrows the computed fit. Sum every file the task writes and reads, against this session's
  model (`opus` or `sonnet`):

  ```bash
  node -e "import('${CLAUDE_PLUGIN_ROOT}/lib/atomicity.mjs').then((m) => console.log(JSON.stringify(m.fitOf('.', { locus: [<files written>], reads: [<files read>] }, { model: '<opus|sonnet>' }))))"
  ```

  `fits: false` trips it.

Say which trigger fired and what the recommended mode buys, in two sentences. **An override is
honoured without a second argument**: "do it here" ends the discussion. If the work grows while
you do it — a new file, a new subsystem, a premise that fell — the tripwire is raised again,
once, for what changed.

## Step 4 — The plan is the todo list

One todo per request item, its subject naming the item, its description naming the check that
decides it (the test, the build, the command, or `HUMAN:` for what only the user can judge). That
list is the task's traceability; there is no plan file, no worktree for the edit, no execution
directory.

Use `TaskCreate` for each todo and `TaskUpdate` to move it (`in_progress` when you start it,
`completed` only when its check has passed). **If the Task tools are not available**, fall back to
`TodoWrite` and say that you did; it has no dependency edges, so list the todos in the order they
must run and open a dependent one with "After <subject>: …".

## Step 5 — Do the work, by rigor

Edit only the files the task covers.

- **`verify`** — run the named check and record its result. A failure is a finding for the user,
  not a fix you start.
- **`trivial`** — make the change; run the named check when the item needs one to show it works.
- **`tests-only`** — write the tests; run them, they pass. Then prove each can fail: declare a
  mutation of the code under test (`file`, what to find, what to replace it with, which tests
  must fail) and run it in a throwaway worktree (below). A test no mutation fails is not done.
- **`tdd`** — write the test first and run it: it fails. Make the change: it passes. Then the
  discriminator.

**The discriminator — never in the user's tree.** "Fails without the change" runs in a linked
worktree at the pre-change commit:

```bash
git worktree add --detach <scratch>/pre-change <pre-change sha>
cp <each new or changed test file> <scratch>/pre-change/<same relative path>
(cd <scratch>/pre-change && <the project's command for those tests>)   # each new test must fail
git worktree remove --force <scratch>/pre-change
```

For `tests-only` the code did not change, so the same worktree serves: copy the tests in, apply
each declared mutation there, run, and every test it names must fail. If the project's dependencies live in an untracked directory (`node_modules`, `.venv`),
link it into the worktree rather than installing. A test that cannot be run there is reported as
unrunnable — never counted as failing, never skipped silently. Nothing in this step stashes,
checks out or resets the user's tree.

## Step 6 — Review, from `tdd` up

When any item is `tdd`, dispatch one fresh `agentics:reviewer` over the diff with the Agent tool.
Hand it, inline: the todo list with each item's check, the pre-change sha, the repository path, and
that the change is `git diff <pre-change sha>` in the working tree (its shell is read-only git).
Ask for this return and nothing else:
`{findings: [{id, severity, claim, evidence, failure_scenario}], fix_verdicts: [{id, status, evidence}], notes}`.

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

Every `critical` is fixed before you claim done. Check the fix with a fresh reviewer narrowed to
it, handed the open critical ids to rule `fixed`, `not_fixed` or `regressed`, and repeat until no
critical is open. Majors and minors go to the user as reported.

## Step 7 — Verify, then report

Before claiming done, run the project's own checks — the build, the typecheck, the whole suite, as
the project defines them (its manifest, its `CLAUDE.md`, its CI). A red check means not done.

Report per todo: what changed, its check, and the check's result; the auxiliary items accepted
and rejected; the reviewer's findings as returned; every `HUMAN:` item verbatim for the user to
judge. Anything unfinished leads the report.

**Commit only when asked.** When asked: focused single-concern commits, only the task's files.
