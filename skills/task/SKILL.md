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

When any item is `tdd`, the change is reviewed by the `review` program. It snapshots your working
tree to a private ref and runs one fresh reviewer in a throwaway worktree at that snapshot, so your
tree, index and stash are never touched. Write the criteria file with the Write tool, outside the
repository so no snapshot holds it: the todo list, one item per line, each with its check, and a
`HUMAN:` item kept with its prefix, which the reviewer leaves to the user. Start it detached:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" review --repo . --detach --base <the pre-change sha> --criteria-file <file>
```

It prints `{ok, run, pid, log, result_file}` at once. Keep `run` and follow it with the Monitor
tool, re-armed on expiry until it prints its end:

```
Monitor({ command: 'node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" watch --repo . --run <run> --since 0', description: 'review <run>', timeout_ms: 3600000 })
```

It prints a line per host stop and fault, then `ended done: complete=<bool> result=<file>`: read
`result_file` with the Read tool. On `stopped: …` start the same command again: it resumes the
run. `ended failed` and `launch_failed` are plugin faults: say so and start the command once more;
a second is a plugin defect. Another refusal's `message` says what to fix.

The result's `findings` are the reviewer's, each with its severity, claim and evidence; `units` its
ruling on each criterion and each changed file; `approved`, `next` and `open` the exit, computed
from them. An `open` id starting `unit:` is a criterion or file nobody ruled. Every `critical` is
fixed before you claim done. After the fix, review again, naming the previous review's run, so the
reviewer rules each of its open findings `fixed`, `not_fixed` or `regressed`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" review --repo . --detach --base <the pre-change sha> --criteria-file <file> --prior <the previous review's run>
```

Repeat until `approved` is true. `next: fix` means what is `open` still stands; `next: escalate`
means the loop does not converge (`reason` says why): stop and tell the user. Majors and minors go
to the user as reported. `complete=false` with `coverage.unreached` naming the prior run means
that run left no exit, so its open findings were not ruled again: this round's findings and exit
stand on their own; say so in the report.

## Step 7 — Verify, then report

Before claiming done, run the project's own checks — the build, the typecheck, the whole suite, as
the project defines them (its manifest, its `CLAUDE.md`, its CI). A red check means not done.

Report per todo: what changed, its check, and the check's result; the auxiliary items accepted
and rejected; the reviewer's findings as returned; every `HUMAN:` item verbatim for the user to
judge. Anything unfinished leads the report.

**Commit only when asked.** When asked: focused single-concern commits, only the task's files.

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
