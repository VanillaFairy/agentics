---
name: investigate
description: Use when a question about this codebase is too big to answer in one pass — what a change would break, what a migration would take, why something regressed, where a pattern appears across repos, or how a subsystem actually behaves. Covers current code, git history, and vendor documentation together. Not for making the change.
---

# Investigate

Answer one large question about this codebase from evidence, and return either an ordered
task list or a written report.

Invoking this skill **is** the user's opt-in for the `Workflow` tool. Do not ask again.

## When not to use it

- The answer fits in one or two file reads. Just answer.
- The user wants the work done, not investigated. Do the work.
- The work is an iterative loop — run, observe, adjust. This plugin has no pipeline for that:
  a survey reads, it does not execute, so a hypothesis that only a test run can settle is
  outside what the evidence phase can reach. Drive that loop in the session, then bring the
  established cause back here or to `develop`.
- The topics are not independent: what track A finds determines what track B should look for.
  Run two passes, seeding the second with the first's findings, rather than forcing one plan.

## Step 1 — Read the invocation

Parse three things from what the user typed:

**Intelligence.** `low`, `normal` or `max` — the judging tier: Sonnet, Opus, or Opus one effort
step deeper.

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

An override arrives either way round: `/investigate max how does X work` or
`/investigate --intelligence=low ...`. Strip the token from the question text.

**Mode.** Task list or report:

- **Task list** (default) — they want to act on this. Pass `as_tasks: true`.
- **Report** — they asked to understand, explain, or assess something, or used the word
  "report". Omit the flag.

**Roots.** Which repositories are in play. Default to the current working directory.

Ask **at most one** clarifying question, and only when two readings would produce materially
different work. Otherwise state your assumption and continue.

## Step 2 — Run it

```
Workflow({ name: 'agentics:agentics-investigate', args: { question, roots, notes, as_tasks, intelligence } })
```

The name is plugin-namespaced; the bare `agentics-investigate` does not resolve. Record the
`runId` from the launch result — the script cannot read its own id, and `runId` is what
pairs with `coverage.resumable.remaining` if the run needs resuming.

Let it run in the background. Tell the user they can watch with `/workflows`. Do not poll, and
do not guess at results before the notification arrives.

There is no bespoke-script path. If a question genuinely does not fit this shape, say so rather
than authoring a one-off workflow — a shape that recurs belongs in `workflows/` as its own file.

**Resuming an interrupted run: re-pass the args.** A resume re-executes the script, which
reads nothing from the prior run — so `resumeFromRunId` alone runs it with no question at all,
and it returns an empty result in milliseconds while the interrupted run's cached agents go
unreachable. The spent resume is the whole loss; there is no second one.

```
Workflow({ scriptPath, resumeFromRunId, args })
```

`args` is in `coverage.resumable.args` of the result you are resuming from, exactly as it was
launched. When you no longer have that result, rebuild it from this step's argument list —
`question` above all, since that is what the guard tests.

## Step 3 — Land the result

**Task mode:**

1. `TaskList` first, to avoid duplicating tasks that already exist.
2. One `TaskCreate` per returned task — `subject`, `description`, `activeForm`.
3. Map each `ref` to the real task id, then `TaskUpdate` with `addBlockedBy` for the dependencies.
4. Create nothing else. Do not start the work.

**If the Task tools are not available**, fall back to `TodoWrite` and say that you did. They
are host-provided and optional — the VS Code extension is the host you will actually hit. You
cannot detect their absence before the call, so treat a failure there as this branch rather
than as an error to retry.

`TodoWrite` has no dependency edges, so carry the graph in the list itself: emit the tasks in
`blocked_by` order, and open any description that has prerequisites with "After <subject>: …".
Then say plainly that the ordering is advisory rather than enforced. Losing it silently is
worse than losing it out loud — an unordered list looks exactly like an ordered one, which is
the failure this whole skill exists to prevent.

**Report mode:** hand back `result.report` as it stands. Do not summarise it into a shorter
version — the user asked for the report. Offer to save it to a file.

If the user wants the report written to disk, **you** write it. The agents in this plugin are
read-only by design; artifact writing is the main session's job.

## Step 4 — Surface the coverage

This step is not optional, and it is the reason this plugin exists.

Read `result.coverage`. **When `complete` is false, the gap leads** — before the finding, not
after it, and never as a footnote:

- `dropped` — topics that produced no result at all
- `incomplete` — searched and resumed, still not exhausted. Names topics, and also `history`
  or `docs` when an evidence channel returned without finishing its search
- `failed_channels` — a requested channel produced nothing at all, so any claim resting on it
  is unsupported. `history`, `docs`, `survey` or `synthesis`. It covers three causes that mean
  the same thing downstream: the agent threw, it returned nothing, or the planner marked the
  track necessary and never wrote its question
- `unreached` — surface nobody covered

In task mode, also read `result.tasks.gaps` and state it. That is where the synthesis records
what the evidence could not settle, and what it refused to invent a task for. A task list can be
well-formed and still rest on a hole; `gaps` is the only place that hole is named.

Then the one-line finding that shapes the answer, and in task mode the task count and what the
first one is.

An answer built on two-thirds of the evidence looks identical to a complete one. Saying which
one you are handing over is the whole job.

Do not restate the task list or re-summarise the report. The user can see both.
