---
name: self-improve
description: Use while driving an agentics run (develop, design, task, investigate) whenever the run behaves against expectations — it loops, stalls, runs far longer than its work, raises many regressions, re-runs review rounds, a fault or plugin defect is reported — or spends more than its work earns, including when the user questions a dispatch's size or count. Decides whether the agentics plugin itself is the cause rather than the spec or the code; if it is, has the plugin fixed and released as a new version (stopping the run first for a fault) and resumes the work on that version. At the effort's end, reads its measured spend, names each outlier's cause, has the dial or prompt behind it corrected, and summarises the plugin updates. Not for a spec or code defect, which the driving skill handles.
---

# self-improve

The user's rule for a session driving an agentics run:

1. Monitor every execution step: each watch line, park, escalation, fault and end.
2. When the run behaves against expectations, check whether the cause is the agentics plugin rather
   than the spec or the code. Spend the work did not earn is a plugin signal too, as a fault is.
3. If it is the plugin: have the plugin fixed, released and installed as a new version, and continue
   the work on that version. A fault stops the run at once; a spend signal waits for a natural stop.
4. When the effort is done, reflect on its measured spend, have each unearned outlier's cause
   corrected, and give the user a summary of the plugin updates and corrections made during it.

## Step 1 — Monitor

Follow the run with the driving skill's watch (develop step 3) and act on every line it prints.
Expect each node to move forward between lines: a stop names a cause someone can answer, an
answered stop does not come back, a review round sees changed text, and the run ends.

Measure spend against the work with numbers code computes, never a guess. At every park, escalation
and end, and whenever the user asks about cost, read the spend view:
`node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" spend --repo . --effort <e>`. It lists each leaf, folder
design and probe round with its dispatches, rounds and dollars beside the effort's mean and the
earlier efforts', the spend per role and model, and the units it flagged with their reasons. You
judge the flagged units; you do not compute outliers yourself.

## Step 2 — Plugin, spec or code

Gather the facts before you judge. Read them with Read and Grep, the node's id as the pattern:

- the node card: `node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" node --repo . --effort <e> --node <id>`
  (its status, its `next` and the reason for it, its notes);
- `.agentics/<e>/.state/events.jsonl`: `dispatched`, `escalated`, `parked`, `replanned`
  (`retry_escalated` is the session's retry), `approved`, `merged`, `nets`;
- `.agentics/<e>/.state/executions/<stamp>/state.jsonl`: `returned`, `step` and `fault` lines;
  `journal.jsonl` beside it: `verify-observed`, each measurement with its `head_sha`;
- `.agentics/<e>/.state/ledger.jsonl`: `reviewed`, `disposition`, `prepared`, `approved`,
  `compiled` lines per folder, each with the spec `hash` it was made at;
- a folder's review gate: `node "${CLAUDE_PLUGIN_ROOT}/lib/approval.mjs" gate --repo . --effort <e> --folder <id>`.

| signal | cause |
|---|---|
| a `fault <channel>` naming a throw (`the leaf unit threw`, `the unit … threw`), or channel `program` | plugin |
| the same fault on the same node after one relaunch | plugin |
| a park or escalation back with the same reason after its cause was answered: a `replanned retry_escalated`, a recorded answer or a compiled re-spec stands between the two stops in `events.jsonl` | plugin |
| one thread dispatched again and again with no progress: new `dispatched` lines on the same `thread`, the branch head or the spec `hash` unchanged between them | plugin |
| the node card's `next` contradicts the records (it resumes work a return already ended, or waits on nothing) | plugin |
| the gate is `ratifiable: true` and the run reviews or integrates again instead of preparing | plugin |
| review rounds at one spec `hash` keep an open finding whose quoted text the spec no longer holds | plugin |
| a stop that is a deadlock of the mechanism: a hold or wait on a node the ordering already serialises, a replan that "did not converge" while the answer stands in the spec | plugin |
| a `checkout` fault while nobody touched the user's checkout | plugin |
| a finding or a failing criterion that names a real gap in the spec, a park asking a decision only the user can make | spec: the driving skill's re-spec |
| a failing check whose output names the code, a reviewer's finding with a failure scenario in the code | code: the run's own fix rounds |

Spend the work did not earn is its own class. Its cause is a dial (a constant, a tier, a config
default) or a prompt (a role, a brief, a skill, the planner's habits), both the plugin's, unless the
work itself is that large:

| spend signal | where its cause lives |
|---|---|
| `probers_over_size`: more parallel judges on one artefact than its size earns | the dial that sizes the dispatch |
| `axes_again`, or review rounds over text that did not change in substance (the spec `hash` moved by a wording edit, the findings the same claims) | what decides a round or a full re-derivation is earned |
| a strong model in `by role` on work with nothing to judge: a search, a mechanical edit, a relocate | the role's tier |
| `usd_over_…` or `rounds_over_…` on a unit | that unit's records: a dial, a prompt, a planner habit (entries split too fine, specs that restate each other), or the work being large |
| the user questions a dispatch's size or count ("why three", "overkill") | read it as the signal it names, as you would a fault |

Work that is genuinely large earns its spend: say so, with its numbers, and change nothing.

Where the facts do not settle it, ask the user once, with the lines you read.

## Step 3 — Stop the run

For a fault only. A spend signal does not stop a run doing real work: let what is in flight finish,
and take the correction through step 4 at the next natural stop or between runs.

There is no stop command. Read `pid` from `.agentics/<e>/.state/executions/<stamp>/run.json` and end
its process tree: `taskkill /PID <pid> /T /F` on Windows, `pkill -TERM -P <pid>` and then
`kill -TERM <pid>` elsewhere. The watch prints `stopped: …`. Nothing is lost: a relaunch resumes
the open execution, and a call cut off mid-way resumes in its own session.

## Step 4 — Have the plugin fixed

The fix happens in the plugin's own repository, the git checkout whose `origin` is
`VanillaFairy/agentics`; ask the user for its path when you do not know it. Hand the fix to one
fix agent: start it with the host's `Agent` tool, general-purpose, in the background, and wait
for its notification. Its brief holds, in this order:

- the symptom as the facts of step 2 state it: the watch lines, each record's `seq`, node, reason
  and detail, the files and lines you read; for spend, the spend view's flagged rows, the threads
  they count and the user's words when they raised it;
- the live case is read-only: nothing under the user's repository may be written; it reproduces on
  a copy of the effort's `.state` in a scratch directory of its own;
- read the plugin's `CLAUDE.md` and `docs/kb/BUILD.md` first, and follow them;
- fix the class, not the instance: name the class as you see it, and say what the live case should
  do after the fix;
- a regression test in the repository's test setup that fails without the fix; for spend, one that
  pins the corrected behaviour (the dispatches, tier or rounds the case now buys);
- `node tools/lint.mjs && node tools/suite.mjs` and `claude plugin validate .` pass;
- one commit per fix, in the repository's commit style, each ending with the commit attribution
  lines this session uses;
- the version in `.claude-plugin/plugin.json` bumped by semver: patch for a fix, minor for a new
  mechanism; a change that needs a major bump stops before it and returns the question;
- the release: push the default branch to `origin`;
- the local install: `claude plugin marketplace update vanillafairy`, then
  `claude plugin update agentics@vanillafairy`, and a grep of a changed line in
  `~/.claude/plugins/cache/vanillafairy/agentics/<version>/` as proof;
- its return, in this shape: root cause in one or two sentences; files changed; test names;
  commits as sha and subject; the push's output line; the installed path and the grep proof; the
  commands the session runs to resume the live case; what is left undone and why.

A major bump is the user's call: ask them before the fix agent goes on.

## Step 5 — Continue on the new version

This session keeps the plugin version it loaded: `${CLAUDE_PLUGIN_ROOT}` still names the old cache.
From now on run every lib script from the new cache path,
`node "<home>/.claude/plugins/cache/vanillafairy/agentics/<version>/lib/<script>.mjs" …`, the watch
included. Where the fix changed a skill's text, read that skill's new `SKILL.md` from the same path
and follow it.

Resume as the fix agent's return says: `lib/boundary.mjs retry` for a stop the fix answers,
`lib/boundary.mjs net` or `lib/approval.mjs dispose --by user` where a ruling is the user's, then
the same start command as before, which resumes the open execution. Arm the watch again from the
effort's `seq` read before the relaunch. Tell the user that restarting the session loads the new
version everywhere.

## Step 6 — Reflect at the effort's end

When the effort lands or the user ends it:

1. Read the spend view for the effort. For each flagged unit, name its cause from its records, by
   step 2's spend table: a dial, a prompt, a planner habit, or the work being large.
2. Each cause in a dial or a prompt that no fix during the effort already corrected goes through
   step 4: one fix agent for all of them, one commit and one test per correction, each test
   pinning the corrected behaviour.
3. Give the user one summary: each plugin version made during the effort, its commits and what each
   fixed or corrected, from the fix agents' returns and `git log --oneline` of the plugin checkout
   over the commits pushed since the effort began; then each outlier judged earned, with its
   numbers. With neither, say that no plugin update was needed and every outlier was earned.
