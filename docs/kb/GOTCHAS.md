# Gotchas

## Copies that must move together

- `blankStringsAndComments` is copied into each lint rule that needs it. Grep the name and fix every
  copy.
- `agentics:verbatim` blocks restate one contract across roles, skills, `CLAUDE.md` and
  `docs/DESIGN.md`. Grep the id and edit every copy (`test/fast/verbatim-blocks.test.mjs`).
- A lib CLI's flags and printed shape are read by skills directly, and a program's `ARGS` are the
  flags a skill passes to `lib/run.mjs <program>`. Grep `lib/<file>.mjs` in `skills/` before
  changing either.
- `docs/DESIGN.md#data-contracts` names every restated copy of each field list.

## Environment

- `node --test test/` runs nothing: Node resolves a directory argument as a module and fails with
  `MODULE_NOT_FOUND`. Run `node tools/suite.mjs`, or name files or a quoted glob.
- The plugin runs from Claude Code's plugin cache: the skills, `lib/` and the role files the runner
  reads. Editing this checkout changes nothing in a live session until the cache is refreshed.
- A program a skill starts with `--detach` is its own process and outlives the session. Closing
  the session stops nothing; `lib/status.mjs watch` follows the run.
- Git refs are files, so `agentics/<effort>` and `agentics/<effort>/<x>` cannot both exist. Node
  branches are `agentics/<effort>--<key>` from `lib/store.mjs`'s `branchOf`; never build one by hand.
