# Testing

    node --test                                                   # everything
    node --test test/no-turn-caps.test.mjs                        # one file
    node --test --test-name-pattern="<name>" test/<file>.test.mjs # one test

Never run `node --test test/`. Node resolves the bare argument as a module, fails with
`MODULE_NOT_FOUND` and runs nothing, so a command that chains it has silently never tested
anything. Run it bare, or name `.test.mjs` files.

A file with no tests passes with `pass 0`. If you expected tests, the name is wrong: it must end
in `.test.mjs` and live directly under `test/`.

## Layout

- `test/*.test.mjs` — flat, one file per lib file, lint rule or concern.
- `test/harness/` — the scenario host and simulators (see its `INDEX.md`).
- `test/fixtures/` — static spec and compile inputs.

## What each layer proves

- **Lint** (`tools/lint.mjs`) proves form, and only for files a rule's `applies` reaches.
- **Scenario tests** (`test/agentics-*-scenarios.test.mjs`, `agentics-develop-e2e.test.mjs`) run
  the real workflow source against scripted agents. They prove orchestration, never agent
  behaviour. Never report one as a live run.
- **Real-git tests** (`boundary`, `merge`, `locks`, `verify`, among others) build temp repos and
  prove what the lib CLIs do to actual branches and worktrees.
- **Pins** stop restated contracts from drifting:
  - `verbatim-blocks.test.mjs`: every copy of an `agentics:verbatim` id is byte-identical.
  - `agent-allowlists.test.mjs`: each agent's exact `tools:` list; it changes with any `tools:` edit.
  - `design-doc.test.mjs`: every `docs/DESIGN.md#<anchor>` pointer resolves to a heading.
  - `liveness.test.mjs`: anything defined and never consumed fails.
  - The scenario tests also check that the `fnv1a` copies in workflows match `lib/plan-digest.mjs`.

A test that spawns `node --test` itself must clear `NODE_TEST_CONTEXT` in the child's
environment, as `test/harness/verify-fixture.mjs` does. If the child inherits it, it runs
nothing and exits 0.
