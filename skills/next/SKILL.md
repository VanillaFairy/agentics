---
name: next
description: Use when the user asks what agentics work exists, where it stands or what to do next — "what's next", "where was I", "what efforts do I have", "how far is the auth work", "what did that cost", "resume the parked one". Lists every effort with its derived status and its computed Next line, and offers to run it. Not for starting new work (design, develop, task).
---

# next

Every effort lives under `.agentics/<effort>/`. Where each stands, and what comes next, is derived
from its specs, the ledger, the node and event logs and git on every call: nothing is stored, and
this skill judges nothing. It runs a CLI, shows what it prints, and offers the command it names.
Design: `docs/DESIGN.md#progress`.

## Step 1 — Every effort and its Next line

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/next.mjs" --repo .
```

One block per effort: its name, its root's derived status, what it is about, and its Next line,
the first of seven rules that matches, with up to two alternatives. Show it as printed. With
`--effort <e>` it prints one effort's line; with `--json`, the `{payload, payload_digest}` form.
When there are no efforts, say so and stop; do not offer to start work.

Root statuses, as derived:

| status | means |
|---|---|
| `unplanned` | nothing is compiled yet: the root spec is not approved |
| `open` | a sub-effort with no spec: it needs `design` |
| `planned` | compiled, nothing dispatched |
| `active` | work is dispatched or under way |
| `parked` | waits on the user: a question, a decision, a design |
| `escalated` | stopped with a cause the user must deal with |
| `integrated` | every child merged; at the root, ready to land |
| `merged` / `landed` | in its parent's branch / the effort branch is in the user's branch |

An execution reads `open` whether it is running, paused or was killed: the logs cannot tell those
apart, so say that rather than guessing which.

## Step 2 — Offer the Next line

One `AskUserQuestion`. The options are the efforts' Next commands, ordered by the rule each
matched (lower first: an open execution before a parked node before design work), ties by effort
name, the first marked `(Recommended)`, plus **Nothing now**. An effort whose line says nothing to
do is not an option. When the user named an effort, offer its command and its alternatives
instead.

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

Run the pick: a command `/agentics:<skill> <words>` is
`Skill({ skill: 'agentics:<skill>', args: '<words>' })`. Carry the words and nothing else; the
skill finds the folder from them, and everything else is on disk.

## Step 3 — Look closer, when asked

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/next.mjs" folders --repo .
node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" show --repo . --effort <e> [--root <node-id>]
node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" todos --repo . --effort <e> --execution <stamp>
node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" cost --repo . --effort <e>
```

- `folders` lists every folder with its approval state (`none`, `approved`, `prepared`, `edited`)
  and its title.
- `show` renders the compiled tree with each node's kind, rigor, derived status and title.
- `todos` is one execution's derived todo list under a display header (`ONGOING`, `DONE`,
  `NEEDS_INPUT`): a rendering, never a state.
- `cost` counts dispatches per model and role, sums measured tokens and dollars per model, and gives
  the mean over merged tasks whose every dispatch was measured. Dispatches with no usage recorded are
  counted as unreported: never quote them as zero, and never quote a projected figure as a measured one.
