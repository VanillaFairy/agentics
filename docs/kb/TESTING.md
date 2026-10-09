# Testing

    node tools/suite.mjs                                            # everything, failures rerun
    node tools/suite.mjs --fast                                     # test/fast/ only, spawn-free
    node --test test/fast/no-turn-caps.test.mjs                     # one file
    node --test --test-name-pattern="<name>" test/<file>.test.mjs   # one test

What each layer proves (lint, the scripted runner, the host contract, real git, pins, liveness) is
in `docs/DESIGN.md#self-checks`. This file covers the traps.

- Never pass a directory: `node --test test/` resolves it as a module, fails with
  `MODULE_NOT_FOUND` and runs nothing. Name files, or quote a glob: `"test/**/*.test.mjs"`.
- Bare `node --test` also loads the harness modules under `test/` as test files. Use the suite
  script or a `*.test.mjs` glob.
- A file runs only when its name ends in `.test.mjs`. One with no tests passes with `pass 0`.
- `test/fast/` holds the tests that start no process. A test that spawns, directly or through a
  `lib/` call, belongs in `test/`: `fast-tier` fails the import statically, and the `no-spawn.mjs`
  preload fails the call at run time, but only under `tools/suite.mjs --fast` or the full run's
  `test/fast-tier-spawns.test.mjs`. A bare `node --test` over a fast file skips the preload.
- A lib CLI keeps one test that spawns it, pinning its argument parsing, exit code and printed
  line. Every other test of the module calls the function in-process.
- A test that spawns `node --test` itself must clear `NODE_TEST_CONTEXT` in the child's environment,
  as `test/harness/verify-fixture.mjs` does. A child that inherits it runs nothing and exits 0.
- `test/fixtures/` holds static inputs (specs, compile cases, recorded host streams and
  transcripts); `test/harness/INDEX.md` covers the rigs.
