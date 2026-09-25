---
name: probe
description: Use when a written artefact should be attacked before it is acted on — a design document, a proposal, a spec, an ADR, a plan. Dispatches independent analysts who receive the document and the repository but nothing from its author, and returns findings on the design severity ladder. Not for reviewing code (that is develop's reviewer) and not for answering a question (investigate).
---

# probe

Attack a document. Find where it is wrong before somebody builds it.

Invoking this skill **is** the user's opt-in for the `Workflow` tool. Do not ask again.

## Why this is a workflow and not just "go read it critically"

Two properties make a probe worth more than a careful reread, and neither survives being
asked for politely — they have to be structural:

- **The probers are not the author.** They receive the artefact and the repository. They do
  not receive the author's reasoning, summary, or intent. An author's account of what they
  meant talks a reader into reading the document as intended rather than as written, and what
  gets implemented is what is written. A passage that only parses once you assume what the
  author meant — that assumption *is* the finding.
- **The verdict is computed.** Probers return findings on a fixed ladder and have no field
  with which to bless anything. Whether the artefact is ratifiable is a count of open
  ambiguities, computed in the workflow. The moment a schema offers a verdict, the exit
  condition moves out of arithmetic and into a model's self-assessment.

A self-probe is a legitimate fallback and a substantially weaker one: it reliably finds
mechanical defects — wrong references, missing cases, contradictions — and reliably misses
premise defects, because the premises are the part not being questioned.

## When not to use it

- Reviewing a commit series against acceptance criteria — that is `develop`'s reviewer, on
  the code ladder.
- Answering a question about the codebase — `investigate`.
- A document nobody will act on. A probe costs at least one analyst's full attack; a note to
  self does not earn one.

## Step 1 — Invoke

```
Workflow({ name: 'agentics:agentics-probe', args: { artifact, roots, context, plugin_root } })
```

`artifact` is the path to the document. `roots` is the repository it would be implemented
in — probers read it, because a claim about what a document would do to a codebase is worth
nothing if nobody looked. `context` is one line on what the document is for, and it is
optional; it must never become a channel for the author's defence of it. `plugin_root` is
`${CLAUDE_PLUGIN_ROOT}`, and it is what lets the shared-ground read below find its script.

The workflow reads the target repository's own review guidance first and derives its axes
from that, so a project that mandates a particular review style is satisfied by this probe
rather than double-probed. Four axes always run: contract ambiguity, unnamed invariants,
YAGNI, and reinvention.

**Shared ground.** Before the analysts run, one script resolves the evidence the document
cites — every `path:line` in it, read once, handed to every axis. It replaces the twenty-six
searches each analyst was separately paying to arrive at the same lines. Two things travel
with it and both matter on the way out: citations that resolve to **nothing** reach every
analyst as evidence about the document, and a shared-ground read that fails costs turns
rather than coverage, because each analyst then locates what it needs exactly as it did
before.

**How many analysts.** One, by default, holding every axis as a checklist. The workflow buys
another for each 400 lines of document, never more than one per axis, and continues an analyst
that stops short on exactly what it never reached. `result.analysts` says who held what. Pass
`per_axis: true` only when the user asks for independent heads per axis; it multiplies the bill
by the axis count.

**`max_derived_axes`** caps the axes derived from the repository's guidance, at 8 by default.
The standing four are never capped. Raising it buys more axes; it does not buy proportionally
more coverage, because per-axis yield is flat and what bounds a probe is the document's claim
count rather than the axis. What the cap declines to buy comes back in `axes_dropped` and in
the coverage block, so a narrower probe never reads like a clean one.

### What a probe costs, and what the workflow report does not tell you

Measured on one 17-agent probe of a 120-line document: **36.5M tokens billed** to return about
538k of evidence. The bill is turn count — every turn re-sends the accumulated context — and
it is superlinear in turns, not in what anybody read. That is why one analyst is the default:
every extra analyst pays the same locating turns over the same document.

The harness's own `subagent_tokens` field reported 1.31M for that run, low by a factor of 28.
**Never quote it as what a probe cost**, and never let it stand as the basis for deciding
whether a probe is worth buying. If the user asks what a run cost, say that the field
under-reports it by more than an order of magnitude and that the real figure is in the agent
transcripts.

## Where the findings go

<!-- agentics:verbatim effort-store -->
**Efforts — one directory for everything this piece of work produces.** A change moves through
design, survey, probe and one or more runs, and every phase records what it returned in the
effort's directory. Design and develop are separate sessions by recommendation, so this is how
the second reads what the first learned beyond the design document.

Open one at the start. The user may name it; if they do not, derive the name and use it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" slug "<the change or question, in the user's words>"
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" open <repo> <slug> --about "<the change or question>" --roots <roots>
```

Opening is idempotent, and a later phase of the same effort adopts the identity the first one
recorded rather than restating it in its own words.

Record a survey's or a probe's return by writing the workflow's result object to a file and
passing the path — **verbatim, never summarised.** The point of the store is what the phase
actually returned, and a command line is finite while a survey's return is as large as the
survey was interesting:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" record <repo> <slug> survey|probe --file <path.json>
```

Link a run and the design document as each comes into being. These are **pointers**: run state
stays at `.claude/agentics/runs/<runstamp>/` where every other part of this pipeline reads and writes
it, and a design stays in the source tree, because it is source:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" link <repo> <slug> run --value <runstamp>
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" link <repo> <slug> design --value <path>
```

Read it back when a later phase opens on the same effort, and pass what it holds as `prior`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" read <repo> <slug> --latest survey
```

**Read back as `prior`, a stored return is context, never evidence.** Passed as `prior` it
reaches a survey's planner alone, where it can only change how the ground is decomposed — it
never fills `ground`, never reaches the knowledge base's null-survey gate, and never answers the
triage's settled-shape question. That gate reads one field, an entry's computed freshness, and no
provenance, so anything that reached it would be admitted with no grading at all.

**One computed exception: a survey that still stands.** Recording a survey anchors it to the
commit it was taken at and the ground its topics searched. `effort.mjs standing <repo> <slug>`
then answers from git whether that survey reported complete coverage and whether any commit or
uncommitted edit has reached its ground since. Hand `develop` the effort's name as `effort`,
beside `settled_shape: true`, and the run asks that question itself: a standing survey is used
instead of buying a second one, and one that does not stand is bought again in full. The session
never decides that a survey stands; the program does.
<!-- /agentics:verbatim -->

Record the probe's whole return before the disposition below, not after. A disposition
is a conversation, and a conversation that runs out of room takes the findings with it if
they live nowhere else.

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
the claim, and the evidence. Never soften a finding and never merge two into one.

`result.ratifiable` is the computed gate. Report it as computed; it is a count, not an
opinion, and it is false whenever an axis went unexamined as well as when an ambiguity is
open. **You may not report a clean probe while `coverage.complete` is false** — an axis whose
prober died examined nothing, and "nobody looked" and "nothing there" are different answers
that look identical in a findings list.

## Step 3 — Disposition, with the user

Every **ambiguity** is resolved with the user before the artefact is ratified. Every **gap**
is either designed away or accepted out loud, in the document, in the user's words with the
cost stated. **Notes** are recorded and left alone.

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
Probe again only when a round returned an `ambiguity` whose resolution reshaped the design —
a new system or interface, a data shape, which component owns a decision — and say which
ambiguity earned it. Otherwise one round is the probe.

## If the probe cannot dispatch

Some sessions run under a standing rule that subagents and workflows are not dispatched
unless the user asked. Invoking this skill *is* that request, and routing through `Workflow`
is what makes it unambiguous rather than a judgment call.

If dispatch genuinely fails anyway: **say so, and never substitute a self-probe silently.**
Offer one, name it as the weaker instrument it is, and let the user decide. A self-probe
presented as a probe is a partial result wearing a complete one's label.
