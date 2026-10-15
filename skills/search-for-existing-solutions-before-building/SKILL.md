---
name: search-for-existing-solutions-before-building
description: Use before building something, when the question is whether it needs building at all — a library, tool, standard, service, or something this repository already depends on may already do it. Searches the world outside the codebase and returns candidates with licence, version and fit facts. Not for understanding code you already have (use investigate).
user-invocable: false
---

# search-for-existing-solutions-before-building

Answer one question, with evidence: **does this already exist?**

This skill starts no agent: the `solutions` program frames, searches, scans and assesses, and the
skill starts it and reads its result.

## How this differs from `investigate`

`investigate` searches the code you already have. This searches the world outside it. Same evidence
discipline, opposite direction — and mixing them up wastes a whole run: a scout's tools only read your tree
(`grep`, `read`, `files`, `refs`) and cannot see a package registry; a documentation researcher cannot see your repo.

One exception, and it is deliberate: this program also runs a single scout over your tree, asking
only *do we already depend on something that does this*. A capability already on the dependency
list beats every candidate the external search returns, and it costs one agent to check.

## When not to use it

- The user already picked the library and wants it wired in. Use `task` or `develop`.
- The question is about how something you have works. Use `investigate`.
- It is a language primitive or a five-line function. Write it.

## Step 1 — Read the invocation

**Capability.** What they are thinking of building. Take it in their words, and do not
sharpen it into an implementation — the program's first agent restates it
implementation-neutrally on purpose, because a framing that names an architecture finds only
that architecture and turns the search into a confirmation.

**Constraints.** Language and runtime, platform, licence policy, offline operation, a
framework it must sit inside. Pull what you can from the repository rather than asking:
a manifest states the language and the runtime, and asking a person for what a file already
says is the waste this plugin exists to remove. Ask only for what only they know — a licence
policy, an appetite for dependencies.

**Roots.** Which repositories are in play, comma-separated. Default to the current working directory.

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

Write the capability, in the user's words, to a file outside the repository with the Write tool,
and start the program detached from the repository root. `--constraints` and `--notes` are one line
of at most 300 characters each; longer, write it to a file and pass `--constraints-file` or
`--notes-file` instead:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" solutions --repo . --detach --capability-file <file> --roots <roots> --constraints "<constraints>" [--notes "<notes>"] --intelligence <tier>
```

It prints `{ok, run, pid, log, result_file}` at once. Keep `run` and follow it with the Monitor
tool, re-armed on expiry until it prints its end:

```
Monitor({ command: 'node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" watch --repo . --run <run> --since 0', description: 'solutions <run>', timeout_ms: 3600000 })
```

It prints a line per host stop and fault, then `ended done: complete=<bool> result=<file>`: read
`result_file` with the Read tool, and guess at nothing before that line. On `stopped: …` start the
same command again, with the same file: it resumes the run. A `run_live` refusal names a sweep of
this capability already going: watch that one. `ended failed` and `launch_failed` are plugin
faults: say so and start the command once more; a second is a plugin defect. Another refusal's
`message` says what to fix.

## Step 3 — Present it, in this order

Read the result's `summary` file whole: it holds every candidate with its facts and verdict, and
`counts` says how many of each there are.

1. **What you already have.** Its first section, always. A dependency you are already
   paying for, or a half-built version somebody started, changes the decision more than
   anything on the candidate list and is the thing a reader most wants to know.
2. **Viable candidates.** Under VIABLE, the ones that hit **no** disqualifier. Show each with
   its version, licence, maintenance signal, and — this one is not optional —
   `does not cover`. That field is what adoption actually turns on, and it is the first thing
   a summary drops.
3. **Ruled out, with the reason.** Under RULED OUT, each with the disqualifier it violated.
   Never trim this to save space: a reader who cannot see what was rejected has to redo the
   search to check the work.
4. **Coverage.** Step 4.

Viability is computed by `lib/evidence.mjs` from the disqualifiers the frame declared, not chosen
by a model — report it as the count it is, and never upgrade it into a recommendation.

## Step 4 — Surface the coverage

This step is not optional, and in this skill it is load-bearing in a way it is not elsewhere.

Here, "we found nothing" is the input to a decision to spend weeks writing code, and an ecosystem
nobody searched reads exactly like one that genuinely has nothing.

So, **binding**:

- You may not report "nothing exists, build it" while `coverage.complete === false`. Say what
  was not reached, and say plainly that the sweep did not finish.
- Two lists carry the two halves, and they mean opposite things. `declared` says how each search
  ended and what it rests on: *"find:crates: ruled absent: no crate parses it — looked grep
  parser@crates→0"* is **evidence for building**. `unreached` says what a search never reached:
  *"find:crates: seed crates.io (…)"* is **evidence of nothing at all**. Present them apart.
- `dropped` names the angles the frame gave beyond `--max-angles` (4 unless passed): nobody
  searched them. `incomplete` naming `find:<angle>` or `repo` is a search that stopped short, and
  `assess:<candidate>` a candidate the assessment did not rule on.
- `failed_channels` naming `frame` means nothing was searched at all.
- `failed_channels` naming `repo` means nobody checked what you already depend on. Any claim
  that this capability is missing from the codebase is unsupported.
- `failed_channels` naming `assess` means candidates were found and never measured. The summary
  lists them UNMEASURED — no disqualifier against them because nobody checked, not because
  nothing was hit. Do not read that emptiness as viability.
- `failed_channels` naming `record` means nothing the sweep found was read back: no summary, no
  verdict. Say so; nothing here supports a decision.

Then the one-line finding: what exists, or what genuinely does not.

## Step 5 — Land it

The decision is the user's, and it rests on things no agent can see — dependency appetite,
licence policy, whether they want to own this code. Present the evidence and let them rule.

When this ran inside a `design` session, the settled facts — the candidate chosen or the `found
nothing` lines in `declared` that justify building — go into the design document's Evidence
section, and the choice itself is a decision with an id, in the user's words.
