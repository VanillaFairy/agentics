# Gotchas

## Copies that must move together

- `canonical`/`fnv1a` from `lib/plan-digest.mjs` are copied into the workflows that check a digest,
  because workflow scripts cannot import. Grep `fnv1a` and edit every copy; a one-sided change
  passes lint and halts every resume on a false digest mismatch.
- The string/comment blanker is copied into `tools/rules/coverage-block.mjs`, `no-imports.mjs` and
  `workflow-meta.mjs`. A fix goes into all of them.
- `agentics:verbatim` blocks restate one contract across agents and skills. Grep the id and edit
  every copy (`test/verbatim-blocks.test.mjs`).
- A lib CLI's argv or stdout shape is parsed by skills directly and by workflows through the
  courier. Grep the CLI name in `skills/` and `service-workflows/` before changing it.

## Environment

- `node --test test/` runs nothing on the current Node; use bare `node --test`.
- `.gitattributes` forces LF. Removing it breaks every workflow in the plugin cache, because the
  Workflow permission layer rejects `\r`.
- The plugin runs from Claude Code's plugin cache. Editing this checkout doesn't change a live
  session until the cache is refreshed.
- Git refs are files, so `agentics/<effort>` and `agentics/<effort>/<x>` cannot both exist. Node
  branches use `--` plus `store.mjs`'s `flat()` for that reason; never build a branch name by hand.
