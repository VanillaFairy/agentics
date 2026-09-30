# skills

## PURPOSE

The user-facing entry points: `design`, `develop`, `task`, `investigate`, `next`, `challenge-idea`
and the internal `search-for-existing-solutions-before-building`. A skill runs in the user's
session, so it owns the conversation and the user's gates; workflows and agents own everything else.

## INVARIANTS & GOTCHAS

- Skills that run a workflow state that invoking the skill *is* the user's opt-in for the
  `Workflow` tool. `task` and `next` never run one; they drive `lib/` CLIs inline. Adding a
  workflow to either means adding that opt-in line, or the session stops to ask.
- `search-for-existing-solutions-before-building` is `user-invocable: false`, because only
  `design` reaches it. It is not dead code, even though no user types it.
- Paths go through `${CLAUDE_PLUGIN_ROOT}`, because the skill runs from the installed plugin
  cache, not this checkout. A skill launching a workflow that nests another must pass
  `plugin_root` into it (`test/skill-plugin-root-parity.test.mjs`).
- `<!-- agentics:verbatim <id> -->` blocks are shared with other skills and with `agents/`
  (`vocabulary` with `agents/planner.md`). `test/verbatim-blocks.test.mjs` fails unless every
  copy of an id is byte-identical, so grep the id before editing a block.
- Every file, `skills/develop/landing.md` included, has a line budget in `tools/budgets.json`.
  Reasons belong in `docs/DESIGN.md`; runtime text holds only instructions and contracts.
- `challenge-idea` hands its probers the artifact and the repository, never the author's summary
  or intent. Adding a context field defeats the independence the skill exists for.

## DEPENDENCIES

- lib — skills shell out to its CLIs (`effort`, `spec`, `approval`, `compile`, `next`, `status`,
  `boundary land`) directly; the land step runs only behind the session's gate (IL4).
- service-workflows — the workflow-running skills launch them by `scriptPath`.
- agents — shared verbatim contracts, chiefly `vocabulary`.
- tools — `budgets.json` bounds every file.
