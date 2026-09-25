---
name: design
description: Use when a change is worth designing before it is built — a new subsystem, a migration, an API, a reshaping of something that exists. Interviews the user against evidence the repository already holds, records their decisions, probes the design adversarially, and produces a ratified design document that agentics:develop implements. Not for a change whose shape is already settled (use develop), and not for a question (use investigate).
---

# design

Produce a **ratified change**: the thing `develop` names as its input and that nothing in
this plugin previously produced.

The pipeline is **design → ratified change → develop.** Design work that does not happen here
happens in the implement phase instead, where a finding costs a fix round and a merge conflict
rather than one sentence in a document.

This skill is session-driven rather than a workflow, for one reason: interviewing is
interactive, and neither a workflow script nor an agent can talk to the user.

Invoking this skill **is** the user's opt-in for the `Workflow` tool. Do not ask again.

## When not to use it

- The change is already decided and the user wants it built. Go straight to `develop`.
- The user asked a question rather than for a design. Use `investigate`.
- The answer fits in a paragraph. Write the paragraph.

## Where this pass writes what it learns

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

## Step 1 — Evidence before questions

Run the survey first, scoped to the idea:

```
Workflow({ name: 'agentics:agentics-survey', args: { question, roots, notes, intelligence, prior } })
```

`question` is what the design needs to know about the existing system — how the thing it
touches works today, what already exists that it should reuse, what constrains it. Not the
design question itself; the survey gathers evidence and never concludes.

`intelligence` is the tier every workflow this session launches runs at — this survey, and the
sweep in step 1b.

<!-- agentics:verbatim intelligence-tier -->
The dial follows the model this session is running, never how important the work feels:
**Fable → `max`; Opus → `normal`; Sonnet and everything below it → `low`.** When you cannot
tell what you are running, `normal`.

The judging agents belong at the tier of the session driving them. A session that dials itself
up because the change looked significant is charging the user for its own self-assessment; a
Fable session that leaves the dial at `normal` has its work judged by a weaker model than the
one the user is talking to, and a Sonnet session that claims `normal` bills the user for Opus
judgment nobody asked it for. Only the user moves it off that mapping — a bare leading `max`,
`normal` or `low` token, or `--intelligence=<tier>`.
<!-- /agentics:verbatim -->

**Every question the repository, its git history, or vendor documentation can answer is
answered here, not asked of the human.** The human is asked only what only the human knows:
intent, priorities, taste, real-world constraints, what they are actually trying to
accomplish. Asking a person where a function lives, when the survey could have found it,
spends the scarcest thing in the room to save the cheapest.

`prior` is what an earlier phase of this effort stored, when there is one. It reaches the
planner and nothing else; see the effort rule above.

**Record the survey's return into the effort as soon as it comes back**, before the interview
spends any of it. An interview is a long conversation, and a survey that lives only in this
context dies with it.

Keep `result.coverage`. It travels into the design document as it stands: an unreached
channel visible at design time is a decision the human can make now, and the same gap
discovered at the `develop` evidence checkpoint costs a whole survey and a whole planning
pass to discover again.

## Step 1b — Does this already exist?

`agentics-survey` searches the code you have. It cannot tell you that the thing you are about to
design is on a package registry, so run the outward sweep too:

```
Workflow({ name: 'agentics:agentics-find-existing-solutions', args: { capability, roots, constraints, notes, intelligence } })
```

Run it whenever the design would **build a capability** — a parser, a scheduler, a cache, a
protocol client, a rate limiter, a diffing algorithm. Skip it when the design is about wiring
things this system already has, or reshaping code that exists: there is nothing off the shelf
for "how our checkout flow should be structured".

Read `already_present` first. A dependency this repository already carries beats every
external candidate and is the cheapest fact in the whole phase.

**Nothing here decides anything.** The sweep returns candidates, not a verdict, and adoption
turns on things it cannot see — licence policy, appetite for another dependency, whether the
team wants to own this code. Those are interview questions for step 2, and they are exactly
the kind only the human can answer.

Carry the result into the design document either way. A chosen candidate is a decision with
evidence behind it; the `no_match` lines that justify building are evidence too, and they are
what stops somebody asking in three weeks why this was not just a library. An **unfinished**
sweep is a `blocking` open question when the design leans on building from scratch — you
cannot ratify "we must write this" on a search that never reached the registry.

## Step 1c — Is this one change, or several?

A design whose honest decomposition is many deliverable slices has no shape in a pipeline that
hands `develop` exactly one ratified change. It gets built either as one oversized run — in the
field: thirteen orders, forty-two agents, 1.32M tokens, one order landed — or as staging in
prose that nothing reads and nothing keeps true.

So when the evidence supports it, **recommend staging and let the user rule.** The signals:

- an order-count estimate materially past one run's healthy size. The field number is **6–12
  orders in ≤3 waves**; it is folklore from one project, it feeds a recommendation, and it is
  never a computed gate;
- more than one deliverable the user could actually use;
- subsystems with narrow seams between them.

A design that stays a single change keeps today's shape exactly, and that is the common case.
A staged one becomes a **programme**: this skill writes the root design and the first slice's
leaf, `/agentics:plan` turns it into a graph with the user, and `/agentics:programme`
drives it. Read the programme section of this plugin's design
(`${CLAUDE_PLUGIN_ROOT}/docs/DESIGN.md#programmes`) before recommending it, so you can say what
the user is agreeing to.

**A slice is a deliverable, not a layer.** Each one ends with something a person can use. A
"data-model slice" nobody can experience is containment wearing a slice's name — it has all the
cost of a slice and delivers nothing, and the feedback that was supposed to shape the next
slice never arrives.

## Step 2 — The interview

**One question at a time**, walking the decision tree in dependency order — whatever
constrains other decisions is resolved first. A batch of six questions gets six shallow
answers and buries the one that mattered.

**Every question carries a recommended answer.** Ask through `AskUserQuestion`, put your
recommendation first, and mark it `(Recommended)`. A question with no recommendation is you
asking the user to do your thinking; a recommendation with no reasoning is you asking them to
trust you. Give the reason in the option's description, grounded in what the survey found.

**The user is the only author of decisions.** Never record a decision the user did not make.
A recommendation they did not answer is not adopted — silence is silence. Write each decision
in the user's own words, and keep the *why* whenever they gave one: a decision without its
reason cannot be revisited later, only re-argued.

**Grade every open question** as you go. The grades are interview discipline — they tell you
what to do next, and they are not pipeline fields:

- `blocking` — the design cannot be ratified without it.
- `parked: <what reopens it>` — set aside, with the trigger that brings it back written down.
- `lookup` — answerable from evidence. Go and look; do not ask.
- `compost` — interesting, not load-bearing. Recorded, not pursued.

One rule here is machine-consequential, and it is this: **a design with an open `blocking`
question does not hand off.** Not to `develop`, not to an implementation, not to "we can
settle that during the build". Everything else in this list is bookkeeping for you.

**Revisions rewrite in place.** When a decision changes, the document carries the ruling and
its reason — never the wobble history. A design that reads as a transcript of how the
designer's mind changed is a design nobody can implement from.

**Raise conflicts when they are load-bearing.** Do not sweep for contradictions. But when a
new answer contradicts a recorded decision that other decisions lean on, show both, say what
depends on which, and let the user rule.

## Step 3 — Approaches, then the adversarial probe

### The approach panel

Draft **two or three approaches in parallel**, one `agentics:analyst` each, dispatched in
a single message. Every one gets the same survey verdicts and the decisions the interview has
recorded so far; each gets a different assigned stance:

- **minimal-change** — the smallest diff that satisfies the decisions recorded so far.
- **long-horizon** — optimise for the growth axes the interview actually named.
- **adopt-don't-build** — maximise use of what step 1b surfaced. Dispatch this one only when
  step 1b ran and found candidates; otherwise it argues from nothing.

Then synthesise: present them with trade-offs, recommendation first, each citing the survey
verdicts it leans on. An approach that cites nothing is an opinion.

Parallel authorship, not one author writing three times: independent drafts cannot anchor on
each other, so a menu written by one hand — where the second option is drafted in the shadow
of the first and the "alternatives" are one idea wearing three hats — stops being the default.

Two honest limits. **Selection is still one judgment**: the panel widens what reaches you, it
does not check your taste in choosing, and no scoring stage is proposed because the *user* is
the selector here and putting a model between the drafts and their choice would take a
decision this skill says is theirs. And **the stances are a fixed list**, so anchoring moved
up a level rather than away — `minimal-change` and `long-horizon` are close to two points on
one axis. When the interview names an axis these three miss, add a stance for it and say that
you did.

You may skip the panel when the decision space is genuinely pinned — the interview forced one
shape. Record the skip and the reason in the design document, so a skipped panel is visible
rather than silent.

### The probe

Before ratification, probe the design document with `agentics:probe`:

```
Workflow({ name: 'agentics:agentics-probe', args: { artifact, roots, context } })
```

Do not hand-roll a probe here. That skill owns the axes, the ladder, and the computed gate;
describing a second probe in this file is how the two drift until they rule differently on
the same document. It reads the target repository's own guidance for its axes — so a project
that mandates its own design review is satisfied by this probe rather than double-probed —
and always runs contract ambiguity, unnamed invariants, YAGNI, and **reinvention**.

Reinvention is a separate axis from YAGNI on purpose. YAGNI catches building what nobody
asked for; it will not catch building what everybody asked for and somebody already shipped.
Here it also has a specific target: is anything in this design rebuilding what step 1b found,
or what step 1b would have found had it been run?

`result.ratifiable` is the gate, and it is a count rather than an opinion — false while any
ambiguity is open, and false when any axis went unexamined. Read the probe's coverage block
before you act on a clean report.

The probe rules on the **design severity ladder** below — its own ladder, not the code one.
The code ladder speaks entirely in acceptance criteria, commit series and declared loci, and
a design document has none of those, so a probe holding it would have to invent a mapping
and would rule badly in both directions.

<!-- agentics:verbatim design-severity-ladder -->
- **ambiguity** — a term, contract, or interface the design leaves readable two ways. Blocks
  ratification. The archetype is one name with two incompatible definitions in the same
  document: every consumer implements one of them, the mismatch is invisible until
  integration, and it costs a rework round rather than a sentence.
- **gap** — a growth axis or requirement the design names but cannot absorb without rework.
  Resolved, or explicitly accepted by the user with the cost stated. Never silently carried.
- **note** — advisory. Recorded in the design document, never blocks, never loops.
<!-- /agentics:verbatim -->

Every `ambiguity` is resolved with the user before the design can be ratified. Every `gap` is
either designed away or accepted out loud, in the document, in the user's words. Notes are
written down and left alone.

A gate closed by ambiguities is opened by their written dispositions, not by probing again.
Buy a second round only under the probe skill's rule: an ambiguity whose resolution reshaped
the design. A gate closed by incomplete coverage is different. Nobody looked, so re-run the
probe for what `coverage.resumable.remaining` names.

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

## Step 4 — The artifact and the HARD GATE

Write the design in the target repository, and commit it. **You** write it — the agents in this
plugin are read-only by design, and artifact writing is the main session's job.

**Where it goes — a file for a single-change design, a directory for a programme.**

```
docs/agentics/designs/YYYY-MM-DD-<slug>.md          one change

docs/agentics/designs/YYYY-MM-DD-<name>/            a programme
  system.md            the root design — pure WHAT, and it carries NO graph
  slices/<slice>.md    leaf designs, written just in time (below)
  programme.json       written later, by /agentics:plan
  plan.md              likewise
```

**The programme's identifier is the directory name, entire** — `2026-08-15-eva-plays-2`. There
is no `slug` field anywhere; a field restating the directory name can only ever disagree with
it.

Sections, in both shapes:

1. **Context** — the problem, and what the survey established about the system as it is.
2. **Decisions** — user-authored, each with its *why*. This is the section the design exists
   to produce.
3. **The design** — the approach, its shape, its contracts, its named invariants.
4. **Open questions** — graded, with `blocking` empty. If it is not empty, the design is not
   finished and step 5 does not happen.
5. **Settled evidence** — toolchain versions verified live, binding contracts, environmental
   facts ("rsync absent; transport is scp"), and the survey's coverage block as it stands.

That last block is not decoration: it is **the exact `notes` payload `develop` consumes**, and
it is what stops the evidence checkpoint re-litigating questions this session already settled.
Write it to be read by a planner, not by a person.

### Section markers — the machine-readable half

Three sections carry markers, in a root document and a leaf alike:

```
<!-- agentics:section change -->            one paragraph: the ratified change, verbatim
<!-- agentics:section decisions -->         the user-authored decisions
<!-- agentics:section settled-evidence -->  the payload a planner consumes
<!-- /agentics:section -->
```

A fourth is **optional**: `ground`. Write it when this pass established which paths the change
lives in — one repo-relative path per line, nothing else in the section. Leave it out when it
did not; a design with no ground section is a finished design and always was, and "this design
did not name its ground" is a fact about the design rather than a defect in it.

**What `ground` is, and the input it must never be confused with.** It feeds `develop`'s
`ground` argument, which is **checked**: the workflow reads a knowledge-base chain over those
paths and collapses the survey only if every one carries a fresh entry. A wrong path there
refuses the collapse and says which path and why — it costs a survey nobody needed to skip.

It is **not** `locus`. That input is **declared**: it puts the run on the fix lane, drops the
survey and the decomposition outright, and fences what the coder may touch, so a wrong value
misroutes the whole run. The fix lane's locus stays a caller declaration made in the develop
session, and is never fed from a document.

They exist so everything downstream that consumes a design document does it **mechanically**.
`lib/programme.mjs --notes` concatenates marked sections byte for byte; the ratified change is
*extracted*, never composed; and a document missing a required marker fails loudly by name,
which is what keeps an empty payload from being indistinguishable from "no settled evidence".

They are also the **completeness signal**. A leaf whose required sections are absent is a
design that was never finished — whatever else is in the file — and the programme skill routes
it straight back to `awaiting-design`. That is the whole recovery mechanism for a session that
died mid-design: no ceremony, no re-asking, just a document that does not yet parse as done.

**Link the finished document into the effort** the moment it is on disk — a design nobody
linked is a design the develop session has to be told about by hand.

**Write them last**, as the final act of the pass. A marker present over a half-written section
is worse than no marker: it says finished.

### Leaf designs are written just in time

In a programme, **only the frontier slice's leaf is written at ratification.** Later slices
exist in the plan as positioned, contracted, undesigned nodes. Feedback beats prediction: a leaf
designed months early is designed at the moment of least knowledge, against a tree that will
not exist when it is implemented.

When an undesigned slice reaches the frontier, `/agentics:programme` invokes **this skill**
with `programme` and `slice` arguments. In that scoped mode:

- the root document and delivered predecessors' leaves are **settled context** — read, not
  re-litigated;
- the survey and the interview are scoped to slice-local decisions;
- the leaf is written into the programme tree and committed on the programme branch;
- the probe runs on the leaf. The probers get the repository, and the root and predecessor
  documents are *in* the repository — so cross-slice contracts are probed as evidence the
  probers found themselves, never as author-supplied `context`;
- step 3's own gate applies unchanged: **the pass cannot end while a blocking probe ambiguity
  is open**;
- the markers above are emitted as the final act;
- **step 5 is skipped** — you return to the programme skill, which owns the dispatch, the
  envelope tags and the notes assembly.

If the leaf conversation reveals the graph itself is wrong — the slice wants splitting, a
dependency is missing — that is a plan revision. Say so and hand back; the user is by
construction present for the conversation.

**HARD GATE.** No implementation, and no `develop` invocation, until the user has read the
document and ratified it in as many words. Not "looks good so far", not silence, not your own
judgment that it is obviously right. This gate is the whole reason the phase exists: it is the
last point at which a wrong shape costs a paragraph.

In scoped mode there is no second ratification and no per-leaf "go". Authorization to build a
slice comes from `programme.json` existing at all — it can only have come into being through a
`plan` session with the user, so it *is* that conversation's work product. A leaf is
dispatchable when the plan exists and the leaf's markers are present. The gate above governs
the ratification of a design; it is not a second ceremony bolted onto every slice.

## Step 5 — Hand off

Once ratified — **a single-change design only; scoped mode returns instead** — read the change
out of the document rather than retyping it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/programme.mjs" --section change --file <the design document>
```

`--section settled-evidence` prints the planner's payload the same way, and
`--section ground` prints the ground block when the document carries one. Those strings, plus
the effort's name, are the whole handoff — `develop` surveys, plans, partitions and implements
from them. The effort's name is what lets `develop` use this pass's survey instead of buying a
second one, when nothing has touched its ground in between.

### Say how much pipeline the change needs — as advice, not as an argument

A design pass has just spent an interview establishing how big and how settled the change is.
Handing it over with nothing said about that makes `develop`'s triage re-derive from a change
string what this conversation already knew.

So write one short paragraph, in the document, naming which rung of the triage's ladder this
change looks like — **direct**, **direct + reviewer**, **fix lane**, or **full run** — and why.
Use those words and no others; they are the triage's vocabulary, and inventing another gives the
develop session something it cannot act on.

Two things this paragraph is not:

- **It is not the `lane` argument.** That input is a closed two-value enum that falls back to
  `full` on anything it does not recognise. Never pass a lane from here.
- **It is not a decision.** The triage stays the decision point and the user is asked once, by
  `develop`. A design that pre-decided the lane would make the fix lane's own coverage block
  false: it states in words that nothing was searched by this run and nothing was recalled from
  the knowledge base, which stops being true the moment a design survey supplied the locus.

**Why the extra command instead of copying the paragraph.** The change string is a key, not a
description: `develop`'s existing-run guard and its resume guard both compare it exactly. A
rewrapped line or a normalized dash between one session and the next is a different change as
far as those guards can tell, so the duplicate they exist to catch goes through and the same
work is planned and implemented twice. Bytes never ride a model.

### Where the build runs — ask, do not assume

With both strings in hand, ask the user where `develop` should run. Use `AskUserQuestion`,
with these two options and no others; do not print them as prose and do not pick for them:

- **New session (Recommended)** — start `develop` in a fresh context, from the document.
- **This session** — chain straight into `develop` here.

**Why this is a question at all, and why the default leans away from the obvious.** Chaining
looks free — the design is right there, and one invocation carrying the whole change is what
this pipeline is for. It is not free. Everything this pass accumulated is still in the
context: the interview, the survey's returns, every probe round's findings. `develop` inherits
all of it and re-reads it on every turn of a run that can last hours, and none of it is load
bearing once the document exists. A measured run of this plugin started its build phase
carrying nearly 400k tokens of settled design conversation and paid for that inheritance on
every one of the build's turns; the same run's build driver, dispatching 185 agents over seven
hours, added only 70k of its own. The expensive context was inherited, not generated.

Nothing is lost by starting fresh, because nothing that matters lives in the conversation. The
document on disk is the entire product of this pass — that is what the section markers are for,
and what makes a session that died mid-design recoverable. A fresh session reads what a
continuing one would only be remembering.

**When continuing here is the better call — say so if it is.** The recommendation follows the
size of what this pass actually accumulated, not a rule. A short interview, a small survey and
a probe that cleared in one round leave little behind, and the handoff is then cheaper than the
re-entry. Long interviews, a wide survey, or a second and third probe round are the expensive
cases, and they are the common ones. Read the pass you just ran and recommend accordingly —
but let the user answer either way.

**If they choose this session:**

```
Skill({ skill: 'agentics:develop', args: '<the change string, verbatim>' })
```

with the settled-evidence block as `notes`. `develop` is already aware it may be starting deep
— that is what its `--pause-between-waves` and `--plan-only` flags are for, and this is the
case they were written for. Say the plan size out loud when it prints.

**If they choose a new session:** give them one block to copy, carrying the extracted bytes
inline, and name the document so nothing has to be reconstructed:

```
/agentics:develop <the change string, verbatim>
```

Copy-paste preserves the bytes; a retype does not, and the guards above cannot tell the
difference between a retyped change and a new one. Then stop. Do not invoke `develop` yourself
after handing over the block — starting the run here is precisely what the user declined, and
the design is already durable without it.

A **programme** hands off to the graph rather than to the build:

```
Skill({ skill: 'agentics:plan', args: '<the design directory>' })
```

`plan` decides slices with the user; the planner agent inside a run decides work orders. Same
word, two grains, and they never meet.

Report the coverage honestly on the way out, the same as everywhere else in this plugin: if
the survey did not complete, say which channel did not, and say that the design rests on it.
A design built on two-thirds of the evidence reads exactly like one built on all of it.

## Deliberately not imported

The knowledge-graph interviewer's folder-tree machinery — parent nodes, node splitting, hub
shapes. A design document is one file with sections, and a storage model built for a graph
would be ceremony here. What is imported is the interviewing **discipline**: one question at a
time, in dependency order, with a recommendation attached and the user as the sole author of
what gets written down.
