# Build

There is nothing to install or compile. The repo has no `package.json` and no dependencies, and
Node's built-in runner is the only test tool. Keep it that way: a dependency would have to ship
inside the plugin cache of every user.

## Checks

    node tools/lint.mjs && node --test
    claude plugin validate .

- `node tools/lint.mjs` judges form only and runs nothing. It prints `OK: no findings`, or one
  `<file>:<line>  [<rule>] <message>` per finding, and exits 1 on any finding. `line 0` means the
  whole file.
- `claude plugin validate .` checks `.claude-plugin/plugin.json` and the files it references
  against the plugin schema. Neither the lint nor the tests look at manifest shape.
- Workflow scripts can't be syntax-checked with `node --check`, because of their top-level
  `return`. Compile them the way `test/harness/workflow-host.mjs`'s `compileWorkflow` does.

## Versioning and distribution

The version lives only in `.claude-plugin/plugin.json`. Never restate it anywhere else, because
nothing keeps a second copy in step. The plugin ships through the `vanillafairy` marketplace
(`VanillaFairy/agentic-plugins`), which holds this repo as a submodule. A release only reaches
users once that repo's submodule pointer advances.

An installed plugin runs from Claude Code's plugin cache, not from this checkout. Editing files
here changes nothing in a live session until the cache is updated, whether by reinstalling from
the marketplace or by mirroring the dev tree into the cache.

## Line endings

`.gitattributes` sets `* text=auto eol=lf`, which overrides `core.autocrlf` at checkout. Never
drop or weaken that line: the Workflow permission layer rejects a script containing `\r`, so a
CRLF checkout breaks every workflow the moment it reaches the cache.

## CI

None in this repository. The checks above run by hand.
