# Landing — the one ask

Read when the develop skill reaches step 6. The effort branch `agentics/<effort>` is merged into
the user's branch here, on their explicit go, and nowhere else (`docs/DESIGN.md#landing-and-drift`).

## 1. Check

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" land --repo . --effort <e> --action check
```

It prints `{payload, payload_digest}`; the payload carries `open_escalations`, `parked`, `human`
and `drift: {base_moved, commits, files}`. It reads; it writes nothing.

## 2. Present — gaps first

1. **Open escalations and parked nodes.** Landing refuses over an open escalation; resolve those
   first (develop step 4b–c). A parked node is not landed work: name it.
2. **What is not in the effort branch.** When the user asked to land what exists, name every
   planned node that has not merged (`lib/status.mjs show --repo . --effort <e>`), so a partial
   landing never reads as the whole.
3. **Drift.** How the user's branch moved since the effort branch was cut: the commits and the
   files. A file on both sides is where a conflict will be.
4. **Every `HUMAN:` criterion**, verbatim, prefix included. These are the user's to judge before
   the go, and nobody else surfaces them.

## 3. Ask

One `AskUserQuestion`: **Land now** or **Not yet**. Silence is not a go, and nothing lands while
an escalation is open.

## 4. Merge, on a go

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" land --repo . --effort <e> --action merge
```

It runs `git merge --no-ff agentics/<effort>` in the user's checkout and records `landed`. It
refuses over an open escalation or a dirty tree: report the refusal as it came. A dirty tree is the
user's to commit or stash, never yours. A conflict stops the merge: surface the paths, and resolve
nothing without the user.

## 5. Cleanup, on a second go

Offer it after the merge; run it only when the user says so, from the checkout that took the merge:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" land --repo . --effort <e> --action cleanup
```

It removes the worktrees of merged node branches and deletes those branches with `git branch -d`.
It keeps dirty worktrees and unmerged branches — the escalated and parked nodes' resumable state.
Read the kept list out loud. Nothing under `.agentics/<effort>/` is removed: it is
the only record of what was decided and done.
