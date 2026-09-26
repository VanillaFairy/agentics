---
name: design
description: Use when the intent of a change is not settled — a new subsystem, a migration, an API, a reshaping of something that exists — or when develop parks a design node. Refines design nodes top-down in levels (context, container, component, leaf-spec) against surveyed evidence, records the user's decisions with ids, probes what earns it, and writes the design document and the nodes that agentics:develop executes. Not for a settled change (develop, task), not for a question (investigate).
---

# design

A design is a subtree of design nodes, refined top-down in levels: each level states only what
the level below needs, and a level is written only when a child reaches it.
Design: `docs/DESIGN.md#design`, `docs/DESIGN.md#traceability`.

Invoking this skill **is** the user's opt-in for the `Workflow` tool. Do not ask again. It is
session-driven because interviewing is interactive: no workflow or agent can talk to the user.

## When not to use it

- The intent is settled and the user wants it built: `develop`, or `task` when it is small.
- The user asked a question: `investigate`.
- The answer fits in a paragraph: write the paragraph.

## Step 0 — Which node, at which level

`agentics:design [--effort <slug>] [--node <id>] <the idea>`.

- **New work:** open the effort (below) and design its root `.`.
- **A node develop parked `needs_design`**, or a design node with no children that reached the
  frontier: design that node. Read the tree (`node "${CLAUDE_PLUGIN_ROOT}/lib/tree.mjs" show --repo
  . --effort <e> --json`) and the `design_doc` of its ancestors and delivered siblings. They are
  settled context: read, never re-litigated.

| level | states | done when |
|---|---|---|
| `context` | the intent: who it is for, the outcome, success criteria, boundaries, what is out of scope | the user ratifies it |
| `container` | which subsystems change, and the contracts between them | every contract has a name, an owner and path prefixes |
| `component` | per subsystem: components, interfaces, data shapes | the planner can write children that satisfy atomicity |
| `leaf-spec` | per leaf: acceptance criteria and their checks | the node is a leaf |

The root starts at `context`. **A level is earned:** a change inside one subsystem skips
`container`; inside one component, `component`. Record every skip, with its reason, in the
document and in the node's `context`.

<!-- agentics:verbatim effort-store -->
**Efforts — one directory for everything a piece of work produces.** An effort is a subtree of
the execution tree. It lives at `.agentics/<effort>/` in the main checkout, never in a worktree,
and everything scripts write for it — its nodes, their events, its evidence and its executions —
sits in that directory's `.state/`. Design, probe and develop are separate sessions by
recommendation, and this directory is how a later one reads what an earlier one established.

Open one at the start. Propose a short name from the user's words and confirm it;
`effort.mjs open` validates it. `effort.mjs slug` turns the words into a first proposal of at
most four words:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" slug "<the change or question, in the user's words>"
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" open <repo> <name> --about "<the change or question>" --roots <roots>
```

Opening is idempotent: a later phase adopts the identity the first one recorded.

Record a survey's or a probe's return into the effort's `.state/evidence/` by writing the workflow's
result object to a file and passing the path — **verbatim, never summarised** — as soon as it
returns, before anything spends it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" record <repo> <slug> survey|probe --file <path.json>
```

`effort.mjs read <repo> <slug> [--latest survey|probe]` reads the effort back.

**A recorded return is context, never evidence — with one computed exception.** Recording a
survey anchors it to its commit and the ground its topics searched, and
`effort.mjs standing <repo> <slug>` answers from git whether it reported complete coverage and
whether any commit or uncommitted edit has touched that ground since. A standing survey is reused
instead of bought again; one that does not stand is bought again in full. The program decides that
a survey stands, never the session.
<!-- /agentics:verbatim -->

## Step 1 — Evidence, scoped to the level

Survey only the ground this level needs. First ask whether recorded evidence stands:
`effort.mjs standing . <e>`. When it stands and its `ground` covers this level's ground, reuse it
and say so. Otherwise:

```
Workflow({ name: 'agentics:agentics-survey', args: { question, roots, notes, intelligence, plugin_root } })
```

`question` is what this level needs to know about the system as it is — never the design question
itself; the survey gathers evidence and never concludes. Record its return at once.

When the level would **build a capability** — a parser, a scheduler, a cache, a protocol client —
launch the outward search in the same message, concurrently:

```
Workflow({ name: 'agentics:agentics-find-existing-solutions', args: { capability, roots, constraints, notes, intelligence } })
```

Skip it for wiring or reshaping what exists. Read `already_present` first. An unfinished sweep is a
`blocking` question whenever the design leans on building from scratch.

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

Whatever the repository, its history or vendor documentation can answer is answered by evidence;
the user is asked only what only the user knows — intent, priorities, taste, real-world limits.
Keep every result's `coverage`: it goes into the document as it stands.

## Step 2 — Decisions are the user's, and carry ids

- **One question at a time**, in dependency order — whatever constrains other decisions first.
  Ask through `AskUserQuestion`, your recommendation first and marked `(Recommended)`, its reason in
  the option's description, grounded in the evidence.
- **The user is the only author.** A recommendation they did not answer is not adopted. Write each
  decision in their words, with their why.
- **Every decision gets an id**, unique across the effort: `D<n>` at the root, `<flat>.D<n>` below
  it, where `<flat>` is the node id with `/` written `.` (`auth.session.D3`).
- **Grade every open question:** `blocking` (the level cannot be ratified without it);
  `parked: <what reopens it>`; `lookup` (answerable from evidence — go and look); `compost`
  (recorded, not pursued).
- **A level with an open `blocking` question does not hand down**, and a design with one
  does not hand off — not to `develop`, not to "we can settle that during the build".
- A changed decision is rewritten in place with its reason; a new answer contradicting a decision
  others lean on is shown beside it, with what depends on which, for the user to rule.

## Step 3 — Approaches, when the decision space is open

Dispatch two or three `agentics:analyst`, in one message, each from an assigned stance:
**minimal-change** (the smallest change satisfying the decisions so far); **long-horizon** (the
growth axes the interview named); **adopt-don't-build** (only when the outward search found
candidates). Hand each the same inline excerpts — the survey verdicts, the decisions so far, this
level's question — and ask for `{approach, shape, contracts, cites, risks}`. When the interview
names an axis the three miss, add a stance for it and say so.

Present the drafts with trade-offs, your recommendation first; an approach that cites no evidence
is an opinion. The user selects. When the level has one obvious shape, skip the panel and record
the skip and its reason in the document.

## Step 4 — The probe, when earned

A probe is earned by the document's length or by a contract other nodes consume (the level
`provides` one). When earned, draft the level's document (its sections are in `writing.md`), then
read `probe.md` beside this skill and follow it. Name what earned it, or record that nothing did.

## Step 5 — The HARD GATE

No children handed down and no `agentics:develop` until the user has read this level's document
and ratified it in as many words — not "looks good so far", not silence, not your judgment that it
is obviously right. The level's done-when must also hold, no `blocking` question may be open, and
no probe ambiguity may be undisposed.

## Step 6 — Write the level

Read `writing.md` beside this skill: the document at
`docs/agentics/designs/<effort>/<node>.md`, committed; the design node and its children at the
next level through `lib/tree.mjs add --by session`.

**Just in time.** Only the frontier's lower levels are written. A sibling left as a design node
with no children is parked `needs_design` when an execution reaches it, and comes back here with
its ancestors and delivered siblings as settled context.

## Step 7 — Where the build runs — ask, do not assume

Once written, ask with `AskUserQuestion`, these two options and no others:

- **New session (Recommended)** — `/agentics:develop --effort <e> --root <node-id>` in a fresh
  context. Everything this pass produced is on disk, so nothing is lost.
- **This session** — `Skill({ skill: 'agentics:develop', args: '--effort <e> --root <node-id>' })`.

Recommend by what this pass accumulated: a long interview, a wide survey or several probe rounds
make a fresh session cheaper; a short pass makes continuing cheaper. Say which, and let the user
answer. On a new session, give the one line to copy and stop — do not invoke `develop` yourself.

Report coverage on the way out: a survey or sweep that did not complete is named, with what rests
on it.
