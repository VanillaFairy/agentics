# The config api

## Intent

A loader and a parser in src/api.

## Decisions

| id | decision | why |
|---|---|---|
| api.D1 | The loader returns a plain object. | Callers need no class. |

## Design

`load(path)`, then `parse(text)`.

## Plan

- **types** — task · realises: D2, api.D1 · rigor: trivial · expects: src/api/types.js
  · provides: config-type (src/api/types.js)
  Declare the config type
  - [ ] HUMAN: the type reads well
- **parse** — task · realises: D1 · after: types · consumes: config-type · rigor: tdd
  · expects: src/api/parse.js, test/parse.test.js · reads: src/api/types.js
  Parse keys case-insensitively
  Use the existing tokenizer.
  - [ ] key lookup ignores case — check: `node --test test/parse.test.js`

## Open questions

## Evidence

None yet.
