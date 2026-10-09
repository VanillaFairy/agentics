# Build

There is nothing to install or compile. The repo has no `package.json` and no dependencies, and
Node's built-in runner is the only test tool. Keep it that way: a dependency would have to ship
inside the plugin cache of every user. At run time the programs need the host CLI, which
`resolveCli` in `lib/host.mjs` finds on the `PATH` unless `.agentics/config.json` names one in
`claude_cli`.

## Checks

    node tools/lint.mjs && node tools/suite.mjs
    claude plugin validate .

- `node tools/lint.mjs` judges form only and runs nothing. It prints `OK: no findings`, or one
  `<file>:<line>  [<rule>] <message>` per finding, and exits 1 on any finding. `line 0` means the
  whole file.
- `node tools/suite.mjs` exits 1 only for a `red` test. A test that failed and then passed the rerun
  is printed as `flake` and the run still exits 0, so read the flake lines rather than trusting the
  exit code alone.
- `claude plugin validate .` checks `.claude-plugin/plugin.json` and the files it references
  against the plugin schema. Neither the lint nor the tests look at manifest shape.

## Versioning and distribution

The version lives only in `.claude-plugin/plugin.json`. Never restate it anywhere else, because
nothing keeps a second copy in step. The plugin ships through the `vanillafairy` marketplace
(`VanillaFairy/agentic-plugins`), which holds this repo as a submodule. A release only reaches
users once that repo's submodule pointer advances.

An installed plugin runs from Claude Code's plugin cache, not from this checkout. Editing files
here changes nothing in a live session until the cache is updated, whether by reinstalling from
the marketplace or by mirroring the dev tree into the cache.

## CI

None in this repository. The checks above run by hand.
