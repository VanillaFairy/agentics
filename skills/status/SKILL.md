---
name: status
description: Use when the user asks what agentics work exists or where it stands — "what efforts do I have", "how far is the auth work", "what did that cost", "resume the parked one". Lists efforts, their trees and executions with status derived from the logs, and hands a pick to develop (or design). Not for starting new work (task, design, develop).
---

# status

Every effort lives under `.agentics/<effort>/`, and every status here is derived
from its logs and git on each call — nothing is stored, and nothing here is read back as state
(`docs/DESIGN.md#progress`). This skill owns no judgment: it runs a CLI, shows what it prints, and
hands the pick on.

## Step 1 — List

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" list --repo .
```

One entry per effort, newest name first: what it is about, the root's derived status, node counts
per status, its executions (open or closed, with their roots) and the last `seq`. Add `--json` for
the `{payload, payload_digest}` form. Show a compact table — **effort**, **about**, **root
status**, **counts**, **open executions** — leading with what the effort is about.

Root and node statuses, as derived:

| status | means |
|---|---|
| `unplanned` | the effort has no root node yet |
| `open` | a design node with no children: it needs `design` |
| `planned` | written, nothing dispatched |
| `active` | a leaf is dispatched, or a composite has work under way |
| `approved` | a leaf passed; it waits for its merge (a cycle member is held for its cycle) |
| `parked` | waits on the user: a question, a decision, a design |
| `escalated` | stopped with a cause the user must deal with |
| `integrated` | every child merged into this composite's branch; at the root, ready to land |
| `merged` / `landed` | in its parent's branch / the effort branch is in the user's branch |

An execution reads `open` whether it is running, paused or was killed — the logs cannot tell those
apart, so say that rather than guessing which. `checkpoint` means its last act was a checkpoint.
When nothing exists, say so and stop; do not offer to start work.

## Step 2 — Look closer, when asked

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" show --repo . --effort <e> [--root <node-id>]
node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" todos --repo . --effort <e> --execution <stamp>
node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" cost --repo . --effort <e>
```

- `show` renders the tree with each node's kind, rigor or level, derived status and title.
- `todos` is one execution's derived todo list, under a display header (`ONGOING`, `DONE`,
  `NEEDS_INPUT`) — a rendering, never a state.
- `cost` counts dispatches per model and role, sums measured tokens, and gives the mean over merged
  leaves whose every dispatch was measured. Dispatches the host reported no tokens for are counted
  as unreported: never quote them as zero, and never quote a projected figure as a measured one.

## Step 3 — Pick, and hand it on

If the user named what they want, use it; otherwise ask with `AskUserQuestion`, recommending an
open execution over a parked plan — interrupted work is more likely what they meant. When two are
plausible, do not pick for them.

- **Resume an execution:** `Skill({ skill: 'agentics:develop', args: '--effort <e> --resume <stamp>' })`.
- **A new execution on a subtree:** `Skill({ skill: 'agentics:develop', args: '--effort <e> --root <node-id>' })`
  — a node not covered by an open execution.
- **Land an integrated root:** `Skill({ skill: 'agentics:develop', args: '--effort <e> --land' })`.
- **An `open` design node:** `Skill({ skill: 'agentics:design', args: '--effort <e> --node <node-id>' })`.

Carry the effort, the stamp and the node id — nothing else. The rest is on disk, and `develop`
adopts it from there. Escalations, parked questions and stale plans are answered in `develop`'s
result walk, not here.
