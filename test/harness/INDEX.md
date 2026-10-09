# test/harness

## PURPOSE

The worlds the suite runs over, in two folders. `test/fast/harness/` holds what the spawn-free tier
may use: the scripted runner, the in-memory log port, the no-spawn preload and the path limits.
`test/harness/` holds the real-git rigs and worlds and `fake-claude.mjs`. They are split because
nothing in `test/fast/` may import from `test/` outside it (`fast-tier` lint).

## KEY ABSTRACTIONS

- `scripted-runner.mjs` is the real `runAgent` over a scripted CLI keyed by `role|node|thread`. Each
  CLI start plays the next step, so a schema retry, a `more` part, a renewal or a resume after a host
  stop each need a step of their own; a missing one throws "the script has no start". It runs with
  no checkout watch and no live process, so `checkout`, `watch_failed`, `checkout_changed` and
  `orphan_ended` never occur under it.
- A passing program test proves orchestration (records, stored returns, replays, messages), never
  agent behaviour. Never report one as a live run; only `test/host-contract.test.mjs`, run when
  `AGENTICS_HOST=1`, touches the real host.
- `program-rig.mjs`'s `relaunch(script)` starts the same run again over a fresh log port and
  context. Test a resume with it: reusing the first context hides what a relaunched program reads
  back from disk.
- `fake-claude.mjs` stands in for `claude.exe` and counts its calls in `<scenario>.n` beside the
  scenario file, so each test needs a fresh scenario file.
- `seed-tree.mjs` writes nodes `by: 'compile'` with each `defines` admitted against itself. Use it
  only where the decision guard is not under test.
- `dead-pid.mjs` exists because an exited child's pid is no proof of death: the OS recycles it.

## CONCURRENCY MODEL

The worlds are builders with nothing run at import. Test files run in parallel under
`tools/suite.mjs`, so a world never hands two files one mutable directory.

## RESOURCE LIFECYCLE

`verify-fixture.mjs` and `seeded-repo.mjs` build one template per distinct shape per process, cache
it in a module-level Map and hand each caller a `cpSync` copy; templates are swept only by a
`process.on('exit')` handler. `verify-fixture.mjs` runs `git worktree repair` on every worktree of a
copy, because an unrepaired copied worktree silently resolves back into the template; a fixture
that grows a worktree adds it to that list. Copies are removed in `t.after`.

## INVARIANTS & GOTCHAS

- `verify-fixture.mjs` and `boundary-fixture.mjs` delete `process.env.NODE_TEST_CONTEXT` at load,
  because a grandchild `node --test` that inherits it runs nothing and exits 0, which reads as a
  pass. A new fixture whose repositories run a suite does the same.
- `no-spawn.mjs` reaches `child_process` through `process.getBuiltinModule`, because importing it is
  what `fast-tier` forbids in `test/fast/`.

## DEPENDENCIES

- lib — the scripted runner wraps `runner.mjs`; the rigs drive `lib/programs/`, `lib/boundaries/`,
  `ledger.mjs` and `store.mjs` for real.
- tools — `suite.mjs --fast` preloads `no-spawn.mjs`.
