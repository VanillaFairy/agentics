# A readable design loop

## Intent

Specs a person reads, compiled into the graph develop runs.

Success: starting design never needs an id or a flag.

## Decisions

| id | decision | why |
|---|---|---|
| D1 | Efforts live in `.agentics/<effort>/`. | Local, and writable by the pipeline. |
| D2 | Status never goes into a spec. | A written status outlives what it described. |
| D3 | The parser refuses with the file and the line. | A person fixes what they can find. |

## Design

### Layout

One folder per sub-effort, one `SPEC.md` per folder.

```text
## Plan
# not a heading: this is inside a fence
- **fenced** — task
```

## Plan

- **store-layout** — sub-effort · realises: D1 · provides: store-paths (lib/store.mjs, lib/effort.mjs)
  Put every path under .agentics
  The store computes every path; nothing else types one.
- **spec-parser** — task · realises: D2, D3 · after: store-layout · rigor: tdd-pair · role: red
  · locus: test/spec.test.mjs · reads: `lib/store.mjs`
  · consumes: store-paths · dispatch: producer=sonnet/medium, reviewer=opus/medium
  Write the parser's tests
  Each refusal names its line.

  A second paragraph of context.
  - [ ] every refusal names a line — check: `node --test test/spec.test.mjs`
  - [ ] HUMAN: the messages read well
- **planner-part** — sub-effort · realises: D3 · after: spec-parser, /store-layout · author: planner
  · shared: package.json
  Let the planner write this part
- **later** — deferred · realises: D2
  Export specs later
- **old-idea** — dropped · realises: D2
  Keep status in checkboxes

## Open questions

- **blocking:** Which folder holds the vocabulary?
- **parked (reopens at store-layout):** The exact shape of the ledger.
- **lookup:** Does git follow renames in `diff -U0`?
  It does with -M.
- **compost:** Publishing specs as docs.

## Evidence

See `evidence.md`.
