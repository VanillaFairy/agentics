# Gotchas

## `node --test test/` does not work on Node 26.5.1
```
node --test          # correct
node --test test/    # WRONG: MODULE_NOT_FOUND, exit 1, nothing runs
```
Both `node --test test/` and `node --test test` fail with:
```
Error: Cannot find module 'C:\...\agentics\test'
  code: 'MODULE_NOT_FOUND'
```
Node resolves the bare positional argument as a module to load rather than a directory to scan,
and exits `1` **without running a single test**. Bare `node --test` uses default discovery and
finds everything under `test/`.

This is the single most expensive gotcha in this repo — three agents hit it independently in one
session, and the broken form had been copied into `CLAUDE.md` as the documented check command.
Anything that chains `&& node --test test/` silently passes by never running.

## The working tree is CRLF, every test fixture is LF
`core.autocrlf` is `true`, so files on disk after a checkout end in `\r\n`, while every fixture
written as a JS string in a test is LF-joined. **A rule can pass its whole suite and still be
broken on a real file.** This has already caused two shipped bugs:

- Matching a delimiter with exact equality — `lines.indexOf('---')` never finds `"---\r"`.
- `(.*)$` in a line regex. **JS treats `\r` as a line terminator, so `.` refuses to consume it**
  and the match fails outright on `"name: scout\r"`.

Normalize once at the input boundary rather than defending at each use site:
```js
const lines = source.split('\n').map((line) => line.replace(/\r$/, ''))
```
Or compare with `.trim()` — never `line === '---'`.

## `ERROR: Failed to parse repository information` on every commit
Harmless. It comes from the user's *global* hooks directory (`core.hooksPath`), not from anything
in this repo, and the commit lands correctly — check `git log` and `git status` rather than
believing the message. Every agent that commits here will see it twice.

The root cause, so nobody has to dig again: `common.py` in that hooks directory defines
`is_pmi_repo()`, which parses `remote.origin.url` to decide whether the repo belongs to the
`pmi_dev_team`/`dotmatics` workspaces. **This repo has no remote at all**, so parsing returns
nothing and the `else` branch prints that line before returning `False`. The answer — "not a PMI
repo, skip the PMI checks" — is correct; it is just announced with the word ERROR. Twice, because
`pre-commit` and `commit-msg` each call it.

## Never nest a template literal inside another one in a `.workflow.js`
`coverage-block` and `workflow-meta` blank out strings by scanning for the next matching quote
character. They do not track nesting, so an inner backtick **closes the outer string early** and
everything after it is analysed as code — producing findings that make no sense against what you
actually wrote. The same trap applies to a regex literal containing a quote (`/can't/`).

Build list fragments in a named helper with `+` concatenation, and use `split()`/`join()` instead
of a regex carrying a quote.

## Workflow scripts run in a sandbox with no module loader
No `import`, no `require` — an import is a runtime failure, not a style issue. Also no
`Date.now()`, argless `new Date()`, or `Math.random()`: they break run resumption. And never
`minItems`/`maxItems`/`minLength`/`maxLength` in a schema — structured outputs drop them, so the
author believes a bound is enforced when nothing enforces it. Put the bound in the prompt and
enforce it in JS after the call. All of these are enforced by `tools/rules/`.

## The plan digest exists twice, on purpose, and the pin is a test
`lib/plan-digest.mjs` and the `the plan digest` block inside `workflows/agentics-develop.workflow.js`
implement the same FNV-1a-over-canonical-JSON algorithm. They have to: the planner runs the CLI
to write a plan's manifest, and the workflow recomputes it in-script when a resume reads that
plan back — and a workflow script cannot import the library.

**If you change one, change both.** The failure is quiet and total: every resume halts on a
digest mismatch that is not real corruption, and the halt names an order rather than the cause.
The pin is behavioural, in `test/agentics-develop-scenarios.test.mjs` — one scenario feeds the
workflow a manifest that `manifestOf()` computed and asserts the run proceeds. A comment asking
two files to stay in step would not have caught anything.

## `git checkout -B <b>/W3` fails when the ref `<b>` exists
Git stores refs as filesystem paths, so `refs/heads/agentics/…-integration` being a file means
`refs/heads/agentics/…-integration/W3` cannot be a directory. Per-order branches are therefore
`<integration branch>-<order id>` with a **dash**, not a slash. With a slash the run works for
exactly one order and then fails on the second — the kind of bug that looks like a flake.
