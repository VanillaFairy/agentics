# Parse keys

## Intent

Split parsing into a tokenizer pass and a lookup.

## Decisions

## Design

Two passes over the text.

## Plan

- **tokens** — task · realises: D1 · rigor: tdd · expects: src/api/tokens.js, test/tokens.test.js
  Tokenize the config
  - [ ] tokens split on newlines — check: `node --test test/tokens.test.js`
- **lookup** — task · realises: D1 · after: tokens · rigor: tdd · expects: src/api/lookup.js, test/lookup.test.js
  Look keys up case-insensitively
  - [ ] lookup ignores case — check: `node --test test/lookup.test.js`

## Open questions

## Evidence

None yet.
