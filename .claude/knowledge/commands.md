# Commands

## Run the tests
```
node --test
```
From the plugin root. Node's built-in runner — no `package.json`, no install step, no
dependencies, by design. **Do not pass `test/` as an argument** — see gotchas.md.

Single file while iterating:
```
node --test test/no-turn-caps.test.mjs
```

One named test:
```
node --test --test-name-pattern="flags maxTurns" test/no-turn-caps.test.mjs
```

A file with zero tests **passes**. If you expect tests and see `pass 0`, the filename is wrong —
it must end in `.test.mjs` and live under `test/`.

## Run the lint
```
node tools/lint.mjs
```
Prints `OK: no findings`, or one line per finding as `<file>:<line>  [<rule>] <message>`.
Exit `1` when there is at least one finding, `0` otherwise.

Line `0` means the finding is about the file as a whole (a missing block, a missing key) rather
than a specific line.

## Both, as one gate
```
node tools/lint.mjs && node --test
```

## Syntax-check a workflow script
`node --check` is useless on these — the body has a top-level `return`, which is legal in the
runner's function shape but a syntax error as a standalone script. Compile it the way the runner
does instead:
```js
const src = read(file).replace(/^export const/m, 'const')
new (Object.getPrototypeOf(async function () {}).constructor)(
  'args', 'agent', 'workflow', 'phase', 'log', 'pipeline', 'parallel', src)
```
Throws a real `SyntaxError` if the file is broken.

## Run a workflow end to end offline
Same construction, plus stub globals and scripted `agent()` returns. A `pipeline` stub of
`for (const it of items) out.push(await s2(await s1(it), it))` matches the two-stage contract.
This exercises the real control flow — loop exits, escalation paths, coverage derivation —
without spending a single model call, and it caught two genuine bugs in `agentics-develop` before it
was ever committed.

It proves plumbing, not behaviour: it says nothing about whether a real agent honours its
charter, so never report a simulation as a live run.

## Prove per-rule lint coverage
A green `node tools/lint.mjs` does not mean your file was checked — a rule whose `applies`
pattern misses it is silently inapplicable. Import each `tools/rules/*.mjs`, test `applies`
against the POSIX path, then call `check(src, path)` directly. Worth doing when adding a new
runtime artifact type. (`SKILL.md` files, for instance, are matched by `no-turn-caps` only.)

## What the lint does and does not read
The walk skips `.git`, `node_modules`, `docs`, and `test`. It checks the plugin's **runtime
artifacts**, not the plan or the lint's own fixtures — a rule file containing `maxTurns` as a test
fixture must not trip its own rule.

Note the skip list matches a directory's *basename at any depth*, so a nested directory named
`docs` or `test` anywhere in the tree is also skipped.
