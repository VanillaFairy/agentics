# lib/briefs

## PURPOSE

The prompts the programs build, one file per program. They live apart so that no prompt is
composed inside a program or a boundary, where a command or a path for a model to carry could slip
into it (P2).

## INVARIANTS & GOTCHAS

- Only `lib/briefs/`, `lib/brief.mjs` and `renderMessage` (`lib/conversation.mjs`) build prompt
  text; the `prompt-origin` lint fails a literal prompt in `lib/programs/` or `lib/boundaries/`.
  New prompt text goes here.
- A brief is a pure function of what its program hands it; nothing here imports `node:fs`. The
  program resolves the inputs, the repository's guidance included (`guidanceOf` in
  `lib/brief.mjs`), and passes them in. A brief that read disk would bypass what the program
  checked and drop out of the fast tier.
- `lib/brief.mjs`, outside this folder, is the one brief that reads disk: a leaf round's thread
  brief. Its section digests (`brief_parts`) are what send `brief_changed` to a resumed leaf
  thread, so any change to its output reaches every leaf thread resumed across the change.
- A field a brief asks a role to return must exist in that role's schema (`lib/schemas.mjs`) and be
  read somewhere, or `liveness` fails.

## DEPENDENCIES

- lib/programs — the callers; each program's prompts are in the file of its name, except the `rule`
  program's, which are in `respec.mjs` because `lib/respec.mjs` writes the same ruler brief.
- lib/boundaries — preflight (`stale`, `adopted`) and merge-batch (`drift`) build the ruler's brief
  from `execute.mjs` and write it to disk for `ruleUnit`; these are the briefs a boundary, not a
  program, composes.
