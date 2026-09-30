# tools

## PURPOSE

`lint.mjs` and its rules in `tools/rules/` check the form of the plugin's declarative artifacts
(agents, skills, workflow scripts) against the Iron Laws. `budgets.json` sizes each agent and skill
file. `migrate-legacy.mjs` is the current one-shot migration of older state into `.agentics/`.

## KEY ABSTRACTIONS

- A rule is `id` (equal to its filename stem), `applies` (a RegExp on the POSIX-relative path) and
  `check(source, filePath)`. `loadRules` validates that shape at import, because a typo'd export
  would otherwise throw a bare `TypeError` on the first file and sink every other rule's run.
  Dropping a file into `tools/rules/` registers it; there is no list.
- `applies` is the real coverage boundary. `size-budget` and `agent-frontmatter` match only
  `^agents\/[^/]+\.md$`, so an agent file nested a level deeper escapes both.
- `coverage-block.mjs`, `no-imports.mjs` and `workflow-meta.mjs` each carry their own copy of the
  string/comment blanker, because rules stay self-contained. A blanker fix goes into every copy.

## CONCURRENCY MODEL

Synchronous.

## RESOURCE LIFECYCLE

`migrate-legacy.mjs` writes each copy to a `.migrating` path and renames it in, so a killed run
leaves at most an orphan temp file, never a partial target.

## INVARIANTS & GOTCHAS

- `SKIP_DIRS` (`.git`, `node_modules`, `docs`, `test`) is matched by basename inside `collectFiles`,
  at every depth. A runtime directory named `test` or `docs` anywhere is silently never linted.
- A clean run proves only that the rules whose `applies` matched found nothing. When adding a new
  artifact type, check which rules actually apply to it.
- The blanker closes a string at the next identical quote with no nesting awareness. A backtick
  inside `${...}`, or a quote inside a regex literal (`/can't/`), makes the rest of the file read as
  a string and yields nonsense findings. Hoist such a pattern into `new RegExp('...')`.
- `line: 0` in a finding means the whole file, not line 1. A renderer must not clamp it.
- `size-budget` reports a file missing from `budgets.json` as a finding, so a new agent or skill
  needs its budget entry in the same change.
- `migrate-legacy.mjs` never deletes, moves or overwrites a user's file. A target with different
  bytes refuses that effort's whole migration rather than picking a side.

## DEPENDENCIES

- lib — `migrate-legacy.mjs` takes its paths and git plumbing from `lib/store.mjs`; the rules import nothing.
- agents, skills, service-workflows — what the rules judge; a new file kind there needs a rule whose
  `applies` reaches it.
