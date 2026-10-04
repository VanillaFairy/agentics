---
name: challenge-idea
description: Use when a written artefact should be attacked before it is acted on — a design document, a proposal, a spec, an ADR, a plan. Starts the probe program, whose independent analysts receive the document and the repository but nothing from its author, and returns findings on the design severity ladder. Not for reviewing code (that is develop's reviewer) and not for answering a question (investigate).
---

# challenge-idea

Attack a document. Find where it is wrong before somebody builds it.

This skill starts no agent: the `probe` program dispatches every prober, and the skill starts it
and reads its result.

## Why this is a program and not just "go read it critically"

Two properties make a probe worth more than a careful reread, and both are structural:

- **The probers are not the author.** They receive the artefact and the repository. They do
  not receive the author's reasoning, summary, or intent. An author's account of what they
  meant talks a reader into reading the document as intended rather than as written, and what
  gets implemented is what is written. A passage that only parses once you assume what the
  author meant — that assumption *is* the finding.
- **The verdict is computed.** Probers return findings on a fixed ladder and a ruling per unit,
  and have no field with which to bless anything. Whether the artefact is ratifiable is computed
  by the program: every unit ruled and no ambiguity open. The moment a schema offers a verdict,
  the exit condition moves out of arithmetic and into a model's self-assessment.

A self-probe is a legitimate fallback and a substantially weaker one: it reliably finds
mechanical defects — wrong references, missing cases, contradictions — and reliably misses
premise defects, because the premises are the part not being questioned.

## When not to use it

- Reviewing a commit series against acceptance criteria — that is `develop`'s reviewer, on
  the code ladder.
- Answering a question about the codebase — `investigate`.
- A document nobody will act on. A probe costs at least one analyst's full attack; a note to
  self does not earn one.

## Step 1 — Start the probe

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" probe --repo . --detach --artifact <path> --roots <roots> [--context "<one line>"] [--per-axis]
```

`--artifact` is the path to the document. `--roots` is the repository it would be implemented in,
`.` when left out: probers read it, because a claim about what a document would do to a codebase is
worth nothing if nobody looked. `--context` is one line on what the document is for, and it is
optional; it must never become a channel for the author's defence of it.

It prints `{ok, run, pid, log, result_file}` at once. Keep `run` and follow it with the Monitor
tool, re-armed on expiry until it prints its end:

```
Monitor({ command: 'node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" watch --repo . --run <run> --since 0', description: 'probe <run>', timeout_ms: 3600000 })
```

It prints a line per host stop and fault, then `ended done: complete=<bool> result=<file>`: read
`result_file` with the Read tool. On `stopped: …` start the same command again: it resumes the
run, calling only the probers that never returned. A `run_live` refusal names a probe of this
document already going: watch that one. `ended failed` and `launch_failed` are plugin faults: say
so and start the command once more; the same fault again is a plugin defect. Another refusal's
`message` says what to fix.

The program reads the target repository's own review guidance first and probes every axis it
yields, beside the four that always run (contract ambiguity, unnamed invariants, YAGNI and
reinvention); nothing caps them. A project that mandates a particular review style is satisfied by
this probe rather than double-probed.

**Shared ground.** The program resolves every `path:line` the document cites once and puts the
excerpts in every prober's prompt, beside the document numbered by line; a citation that resolves
to **nothing** reaches every prober as evidence about the document.

**How many analysts.** One, by default, holding every axis as a checklist. The program buys
another for each 400 lines of document or each 12 axes, whichever buys more, never more than one
per axis. `result.analysts` says who held what. Pass `--per-axis` only when the user asks for
independent heads per axis; it multiplies the bill by the axis count.

### What a probe costs

The bill is turn count — every turn re-sends the accumulated context — so one analyst is the
default: every extra one pays the same locating turns over the same document. What a run cost is
the result's `cost`: `usd` and `tokens` over its `dispatches`, with `unmeasured` the calls that
gave no figure. Quote it as it stands.

## Where the findings go

<!-- agentics:verbatim effort-store -->
**Efforts — one directory for everything a piece of work produces.** An effort is a subtree of
the execution tree. It lives at `.agentics/<effort>/` in the main checkout, never in a worktree,
and everything scripts write for it — its nodes, their events and its executions —
sits in that directory's `.state/`. Design, challenge-idea and develop are separate sessions by
recommendation, and this directory is how a later one reads what an earlier one established.

Open one at the start. Propose a short name from the user's words and confirm it; `effort.mjs
open` validates it. `effort.mjs slug` turns the words into a first proposal of at most four words:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" slug "<the change or question, in the user's words>"
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" open <repo> <name> --about "<the change or question>" --roots <roots>
```

Opening is idempotent: a later phase adopts the identity the first one recorded.

**Evidence is project-wide, and every item carries its own anchors.** The survey, the
existing-solutions search and the challenge review record what they find themselves, as evidence
items in `.agentics/.state/evidence/`: one claim each, with the lines, searches, sources or other
items it rests on. Nothing is recorded by hand, and no return is summarised into the store.

An item's state is computed whenever it is used, never judged by the session. An item no edit has
touched is **standing**. One whose anchored text changed is **suspect** until a cheap re-judge says
whether the change matters. One that no longer holds is **stale**, and its topic is surveyed again.
List what a ground holds with `node "${CLAUDE_PLUGIN_ROOT}/lib/evidence.mjs" items --repo <repo> --ground <path,path>`.

A folder records the items it rests on, and the coverage gaps it rests on them despite, in one
cite naming every survey, solutions or investigate run it rests on: each run's items come from its
result, less any you `--exclude`, so no list of ids passes through you. A folder's latest cite is
its whole citation. Its `evidence.md` is rendered from those records, never written:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/evidence.mjs" cite --repo <repo> --effort <effort> --folder <folder> --from-run <run> [--from-run <run>]… [--exclude <id>]… [--gap "<gap>"]…
node "${CLAUDE_PLUGIN_ROOT}/lib/render.mjs" evidence --repo <repo> --effort <effort> --folder <folder>
```

The program decides what stands, never the session.
<!-- /agentics:verbatim -->

The program records the round before it returns: every finding is an evidence item, and
`findings_file` holds each in full with every unit's ruling. For a folder's spec, also record the
round in its ledger, `node "${CLAUDE_PLUGIN_ROOT}/lib/approval.mjs" reviewed --repo . --effort <e> --folder <id> --from-run <run>`,
before the disposition below, not after (`spec_changed`: the spec was edited while the probe ran,
so probe again). A disposition is a conversation, and one that runs out of room takes the findings
with it if they live nowhere else.

## Step 2 — Report

<!-- agentics:verbatim design-severity-ladder -->
- **ambiguity** — a term, contract, or interface the design leaves readable two ways. Blocks
  ratification. The archetype is one name with two incompatible definitions in the same
  document: every consumer implements one of them, the mismatch is invisible until
  integration, and it costs a rework round rather than a sentence.
- **gap** — a growth axis or requirement the design names but cannot absorb without rework.
  Resolved, or explicitly accepted by the user with the cost stated. Never silently carried.
- **note** — advisory. Recorded in the design document, never blocks, never loops.
<!-- /agentics:verbatim -->

Lead with `ambiguities` — they block. Then gaps, then notes. For each: the axis, the section,
the claim, and the evidence, read by its id from `result.findings_file`, which holds every
finding in full. Never soften a finding and never merge two into one.

`result.ratifiable` is the computed gate. Report it as computed; it is a count, not an opinion,
and it is false whenever a unit went unruled as well as when an ambiguity is open. **You may not
report a clean probe while `coverage.complete` is false** — "nobody looked" and "nothing there"
look identical in a findings list. Name what was not examined: `units.open` (each axis against
each section no prober ruled), `coverage.failed_channels` and `coverage.unreached`. A probe whose
prober failed recorded nothing: start it again.

## Step 3 — Disposition, with the user

Every **ambiguity** is resolved with the user before the artefact is ratified. Every **gap**
is either designed away or accepted out loud, in the document, in the user's words with the
cost stated. **Notes** are recorded and left alone.

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

<!-- agentics:verbatim probe-disposition -->
**Summarise before you ask anything.** A probe returns findings per axis and the axes
overlap, so handed over raw it is a wall of text that costs more attention than the artefact
did. Open with a count and a table — one row per topic, never one per finding:

```
46 findings across 16 axes. 12 block ratification, in 4 topics:

  topic              blocking  what goes wrong if it stands
  bundle identity        5     two consumers implement different id rules, and the
                               mismatch first shows up at integration
  path derivation        4     ...

Also 9 gaps to accept or design away, and 25 notes recorded without asking.
```

The consequence column is the point of the summary. A reader deciding how much attention
this deserves needs to know what it costs to be wrong, not what the claim was.

**Notes are never questions.** Record them in the artefact and move on. A note that reaches
the user as a question spends their afternoon on advisory text — the exact failure the
ladder's inflation warning names.

**Consolidate questions, never findings.** Every finding is reported as it was returned;
that rule does not move. But several findings turning on a single decision are ONE question
— four axes noticing the same undefined term is one term to define. This is what takes a
disposition from forty questions to six.

**Ask in grouped sets.** `AskUserQuestion` carries up to four questions per call: fill it
with one topic's questions so a set can be answered in a single pass of attention. Order the
sets by blast radius, whatever constrains other decisions first. Every question keeps its
recommended answer marked `(Recommended)`, with the reason in the option's description.

**This is deliberately not the interview's rule.** The interview asks one question at a time
because each answer changes what is worth asking next and the tree is discovered as it is
walked. A disposition has no such tree: the findings are computed, independent, and all on
the table before the first question. One at a time is not care here, it is forty turns.
<!-- /agentics:verbatim -->

Then write the dispositions into the artefact itself — a findings table with what each one
changed. A probe whose findings live only in a conversation has to be run again by the next
person to open the document.

There is no fix loop here, deliberately. The probe reports; a human rules. A document is not
a commit series: there is no mechanical re-verification to converge against, so a loop would
iterate on taste. There is no author-rebuttal round either — the author is the party the
probe exists to check.

**A second probe round is earned, never routine.** A finding the user ruled on, with the
disposition written into the document, is cleared; re-probing to watch it clear buys nothing.
Probe again only when a round returned an `ambiguity` whose resolution reshaped the design — a
new system or interface, a data shape, which component owns a decision — and say which earned it,
passing `--since <the first round's snapshot>`. Otherwise one round is the probe.

## If the probe cannot run

Some sessions run under a standing rule that agents are not dispatched unless the user asked.
Invoking this skill *is* that request, and the probe program is what it asked for.

If the probe cannot run anyway — a refusal you cannot fix, a fault that repeats: **say so, and
never substitute a self-probe silently.** Offer one, name it as the weaker instrument it is, and
let the user decide. A self-probe presented as a probe is a partial result wearing a complete
one's label.

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
