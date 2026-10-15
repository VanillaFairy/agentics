---
name: investigate
description: Use when a question about this codebase is too big to answer in one pass — what a change would break, what a migration would take, why something regressed, where a pattern appears across repos, or how a subsystem actually behaves. Covers current code, git history, and vendor documentation together. Not for making the change.
---

# Investigate

Answer one large question about this codebase from evidence, and return either an ordered
task list or a written report.

This skill starts no agent: the `investigate` program runs the survey and the synthesis, and the
skill starts it and reads its result.

## When not to use it

- The answer fits in one or two file reads. Just answer.
- The user wants the work done, not investigated: `task`, `design` or `develop`.
- The work is an iterative loop — run, observe, adjust. This plugin has no pipeline for that:
  a survey reads, it does not execute, so a hypothesis that only a test run can settle is
  outside what the evidence phase can reach. Drive that loop in the session, then bring the
  established cause back here, or to `task` or `develop`.
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

- **Task list** (default) — they want to act on this. Pass `--as-tasks`.
- **Report** — they asked to understand, explain, or assess something, or used the word
  "report". Omit the flag.

**Roots.** Which repositories are in play, comma-separated. Default to the current working
directory, `.`. Anything else the user said that bears on the search — a suspect, a place to start
— goes in `--notes`, or in a file under `--notes-file` past one line of 300 characters. Pass
`--pace fast` only when they ask for speed: each topic gets its own judge, which costs more.

Ask **at most one** clarifying question, and only when two readings would produce materially
different work. Otherwise state your assumption and continue.

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

## Step 2 — Run it

Write the question, stripped of the dial token, to a file outside the repository with the Write
tool, and start the program detached from the repository root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" investigate --repo . --detach --question-file <file> --roots <roots> [--notes "<notes>"] [--as-tasks] [--pace fast] --intelligence <tier>
```

It prints `{ok, run, pid, log, result_file}` at once. Keep `run` and follow it with the Monitor
tool, re-armed on expiry until it prints its end:

```
Monitor({ command: 'node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" watch --repo . --run <run> --since 0', description: 'investigate <run>', timeout_ms: 3600000 })
```

It prints a line per host stop and fault, then `ended done: complete=<bool> result=<file>`: read
`result_file` with the Read tool. Do not guess at results before that line. On `stopped: …` start
the same command again, with the same question file: it resumes the run, calling only what never
returned. A `run_live` refusal names an investigation of the same question already going: watch
that one. `ended failed` and `launch_failed` are plugin faults: say so and start the command once
more; the same fault again is a plugin defect. Another refusal's `message` says what to fix.

There is no bespoke path. If a question genuinely does not fit this shape, say so rather than
improvising one.

## Step 3 — Land the result

**Task mode:**

1. `TaskList` first, to avoid duplicating tasks that already exist.
2. One `TaskCreate` per task in `result.tasks.tasks` — `subject`, `description`, `activeForm`.
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

- `dropped` — topics that produced no result at all: their judge gave them neither an item nor
  a risk
- `incomplete` — searched, still not settled: a topic whose search produced nothing or ended
  short, or whose items went unrecorded or unruled, `history` or `docs` when that search ended short
- `failed_channels` — a requested channel produced nothing at all, so any claim resting on it
  is unsupported: `plan` (planning failed, so nothing was searched), `history`, `docs`, a search
  whose navigator was stopped, named by ask (`scout:<topic>:<topic>`), or `synthesis` (the
  analyst who writes the answer failed: the evidence was gathered, is in `result.evidence.context`,
  and was never written up)
- `unreached` — surface nobody covered, one line each: a search that produced nothing, or the keys
  a search never reached, a judge that failed and the topics it left, the synthesis

In task mode, also read `result.tasks.gaps` and state it. That is where the synthesis records
what the evidence could not settle, and what it refused to invent a task for. A task list can be
well-formed and still rest on a hole; `gaps` is the only place that hole is named.

Then the one-line finding that shapes the answer, and in task mode the task count and what the
first one is.

An answer built on two-thirds of the evidence looks identical to a complete one. Saying which
one you are handing over is the whole job.

Do not restate the task list or re-summarise the report. The user can see both.

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
