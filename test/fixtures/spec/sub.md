# Store layout

## Intent

Every path under `.agentics/` comes from one module.

## Decisions

| id | decision | why |
|---|---|---|
| store-layout.D1 | Paths resolve from the main checkout. | A worktree's writes land where the next session looks. |

## Design

`lib/store.mjs` owns every path.

## Plan

- **paths** — task · realises: D1, store-layout.D1 · rigor: tdd · expects: lib/store.mjs, test/store.test.mjs
  · provides: store-api (lib/store.mjs)
  Compute every path in one module
  - [ ] a worktree's write lands in the main checkout — check: `node --test test/store.test.mjs`

## Open questions

## Evidence

None yet.
