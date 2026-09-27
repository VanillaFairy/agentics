---
name: search-for-existing-solutions-before-building
description: Use before building something, when the question is whether it needs building at all — a library, tool, standard, service, or something this repository already depends on may already do it. Searches the world outside the codebase and returns candidates with licence, version and fit facts. Not for understanding code you already have (use investigate).
user-invocable: false
---

# search-for-existing-solutions-before-building

Answer one question, with evidence: **does this already exist?**

Invoking this skill **is** the user's opt-in for the `Workflow` tool. Do not ask again.

## How this differs from `investigate`

`investigate` searches the code you already have. This searches the world outside it. Same
evidence discipline, opposite direction — and mixing them up wastes a whole run, because a
scout with `Grep` and `Glob` cannot see a package registry, and a documentation researcher
cannot see your repo.

One exception, and it is deliberate: this workflow also runs a single scout over your tree,
asking only *do we already depend on something that does this*. A capability already on the
dependency list beats every candidate the external search returns, and it costs one agent to
check.

## When not to use it

- The user already picked the library and wants it wired in. Use `task` or `develop`.
- The question is about how something you have works. Use `investigate`.
- It is a language primitive or a five-line function. Write it.

## Step 1 — Read the invocation

**Capability.** What they are thinking of building. Take it in their words, and do not
sharpen it into an implementation — the workflow's first agent restates it
implementation-neutrally on purpose, because a framing that names an architecture finds only
that architecture and turns the search into a confirmation.

**Constraints.** Language and runtime, platform, licence policy, offline operation, a
framework it must sit inside. Pull what you can from the repository rather than asking:
a manifest states the language and the runtime, and asking a person for what a file already
says is the waste this plugin exists to remove. Ask only for what only they know — a licence
policy, an appetite for dependencies.

**Roots.** Which repositories are in play. Default to the current working directory.

**Intelligence.** `low`, `normal` or `max` — the tier the framing and assessing agents run at:
Sonnet, Opus, or Opus one effort step deeper.

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

## Step 2 — Run it

```
Workflow({ name: 'agentics:agentics-find-existing-solutions', args: { capability, roots, constraints, notes, intelligence } })
```

The name is plugin-namespaced; the bare name does not resolve. Record the `runId` from the
launch result — the script cannot read its own id, and `runId` is what pairs with
`coverage.resumable.remaining` if the sweep needs resuming.

Let it run in the background. Tell the user they can watch with `/workflows`. Do not poll, and
do not guess at results before the notification arrives.

**Resuming an interrupted sweep: re-pass the args.** A resume re-executes the script, which
reads nothing from the prior run, so `resumeFromRunId` on its own runs it with no capability
to search for — an empty result in milliseconds, and the interrupted run's cached agents out
of reach. Pass `Workflow({ scriptPath, resumeFromRunId, args })` with the args from
`coverage.resumable.args`.

## Step 3 — Present it, in this order

1. **What you already have.** `already_present` first, always. A dependency you are already
   paying for, or a half-built version somebody started, changes the decision more than
   anything on the candidate list and is the thing a reader most wants to know.
2. **Viable candidates.** `viable` names the ones that hit **no** disqualifier. Show each with
   its version, licence, maintenance signal, and — this one is not optional —
   `does_not_cover`. That field is what adoption actually turns on, and it is the first thing
   a summary drops.
3. **Ruled out, with the reason.** `ruled_out` carries `why` per candidate, quoting the
   disqualifier it violated. Never trim this to save space: a reader who cannot see what was
   rejected has to redo the search to check the work.
4. **Coverage.** Step 4.

`viable` is computed in JS from the disqualifiers the frame declared, not chosen by a model —
report it as the count it is, and never upgrade it into a recommendation.

## Step 4 — Surface the coverage

This step is not optional, and in this skill it is load-bearing in a way it is not elsewhere.

Everywhere else in this plugin, an incomplete search means a weaker conclusion. Here, "we
found nothing" is the input to a decision to spend weeks writing code — and an ecosystem
nobody searched produces the identical sentence to an ecosystem that genuinely has nothing.

So, **binding**:

- You may not report "nothing exists, build it" while `coverage.complete === false`. Say what
  was not reached, and say plainly that the sweep did not finish.
- `unreached` carries both halves and they mean opposite things. A line reading
  *"crates.io searched and found nothing"* is **evidence for building**. A line reading
  *"crates.io never reached"* is **evidence of nothing at all**. Present them apart.
- `failed_channels` naming `repo` means nobody checked what you already depend on. Any claim
  that this capability is missing from the codebase is unsupported.
- `failed_channels` naming `assess` means candidates were found and never measured. They are
  returned raw with empty `disqualifiers_hit` — because nobody checked, not because nothing
  was hit. Do not read that emptiness as viability.

Then the one-line finding: what exists, or what genuinely does not.

## Step 5 — Land it

The decision is the user's, and it rests on things no agent can see — dependency appetite,
licence policy, whether they want to own this code. Present the evidence and let them rule.

When this ran inside a `design` session, the settled facts — the candidate chosen or the
`no_match` lines that justify building — go into the design document's Evidence section, and the
choice itself is a decision with an id, in the user's words. That is how the decision survives:
written down with the evidence behind it, rather than re-argued three weeks later when somebody
asks why this was not just a library.
