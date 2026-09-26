# Parse configs

## Intent

Configs load from disk, case-insensitively.

Nothing else changes.

## Decisions

| id | decision | why |
|---|---|---|
| D1 | Keys are case-insensitive. | Users type them by hand. |
| D2 | Unknown keys are an error. | A typo must not pass silently. |
| D3 | Configs reload when the file changes. | Long-running tools need it. |

## Design

A loader reads the file; a parser maps keys.

## Plan

- **api** — sub-effort · realises: D1, D2 · provides: config-api (src/api/) · ground: src/api
  Build the config api
  The loader and the parser live in src/api.
- **cli** — task · realises: D1 · after: api · consumes: config-api · rigor: tdd
  · locus: src/cli.js, test/cli.test.js · reads: src/api/index.js
  Read configs from the command line
  - [ ] the CLI loads a config — check: `node --test test/cli.test.js`
- **reload** — task · realises: D3 · after: api · rigor: tdd · locus: src/reload.js, test/reload.test.js
  Reload configs on change
  - [ ] a changed file reloads — check: `node --test test/reload.test.js`
- **later** — deferred · realises: D2
  Export configs later
- **tuning** — sub-effort · realises: D2 · author: planner
  Tune the error messages

## Open questions

## Evidence

None yet.
