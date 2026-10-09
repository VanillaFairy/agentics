# tools

## PURPOSE

`lint.mjs` and its rules in `tools/rules/` check the form of the plugin's source (programs,
boundaries, schemas, roles, skills and the fast test tier) against the Laws and Principles.
`suite.mjs` runs the tests and reruns failures before calling anything red. `budgets.json` sizes
each role and skill file. `migrate-*.mjs` are the one-shot migrations of on-disk state.

## KEY ABSTRACTIONS

- A rule is `id` (equal to its filename stem), `applies` (a RegExp on the POSIX-relative path) and
  `check(source, filePath)`. `loadRules` validates that shape at import, because a typo'd export
  would otherwise throw a bare `TypeError` on the first file and sink every other rule's run.
  Dropping a file into `tools/rules/` registers it; there is no list, but `liveness` wants its test.
- `applies` is the real coverage boundary. `role-frontmatter` and `size-budget` match `roles/*.md`
  one level deep, and `coverage-block` only the top level of `lib/programs/`, not `execute/`. A file
  a level deeper escapes them.
- Every rule that needs the string and comment blanker carries its own `blankStringsAndComments`,
  because rules stay self-contained. Grep the name and fix every copy.
- `suite.mjs` learns which tests failed only from the JSON lines `suite-reporter.mjs` appends to the
  file `AGENTICS_TEST_FAILURES` names, never by parsing the human report. One reporter does both jobs
  because two trigger node's listener-leak warning on the rerun.

## CONCURRENCY MODEL

Lint is synchronous. `suite.mjs` runs `node --test` at `DEFAULT_CONCURRENCY`, then reruns only the
files with a failed test at `RERUN_CONCURRENCY`.

## RESOURCE LIFECYCLE

`migrate-legacy.mjs` writes each copy to a `.<pid>.migrating` path and renames it in, so a killed
run leaves at most an orphan temp file, never a partial target.

## INVARIANTS & GOTCHAS

- `SKIP_DIRS` (`.git`, `node_modules`, `docs`) is matched by basename at every depth, so a runtime
  directory named `docs` anywhere is never linted. A directory named `test` is linted only in its
  `fast` child (`TEST_LINTED`), because the rest holds the lint's own deliberately bad fixtures.
- An empty rule set throws rather than report no findings. A clean run still proves only that the
  rules whose `applies` matched found nothing; a new kind of file needs a rule that reaches it.
- The blanker closes a string at the next identical quote with no nesting awareness. A backtick
  inside `${...}`, or a quote inside a regex literal (`/can't/`), makes the rest of the file read as
  a string and yields nonsense findings. Hoist such a pattern into `new RegExp('...')`.
- `line: 0` in a finding means the whole file, not line 1. A renderer must not clamp it.
- `size-budget` reports a file missing from `budgets.json`, so a new role or skill file needs its
  budget line in the same change.
- `fast-tier` reads imports only. A `lib/` module that spawns when called is caught at run time by
  `test/fast/harness/no-spawn.mjs`, which `suite.mjs --fast` preloads; a bare `node --test` over
  `test/fast/` skips that check.
- Migrations never delete. `migrate-legacy.mjs` refuses an effort's whole migration when a target
  holds other bytes rather than pick a side.

## DEPENDENCIES

- lib — the migrations write through `store.mjs`, `ledger.mjs` and `integration.mjs`;
  `role-frontmatter` takes `ROLE_NAMES`, the tier tables and `SCHEMAS` from `lib/roles.mjs` and
  `lib/schemas.mjs` rather than keeping lists of its own.
- roles, skills, lib/programs, lib/boundaries, test — what the rules judge.
