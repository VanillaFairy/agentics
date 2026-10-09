# lib/programs

## PURPOSE

The orchestration, as code. Each program named in `PROGRAM_NAMES` (`lib/run.mjs`) reads and writes
the store itself and starts every agent through `dispatch` in `common.mjs`. Only `lib/run.mjs`
starts a program, attached or detached; `execute/` holds the execute program's units.

## KEY ABSTRACTIONS

- `dispatch` keys a call by `dispatchKey({node, role, thread, round})` and replays a stored return
  under that key instead of calling again. Renaming a thread, renumbering rounds or changing a
  `scoped` prefix makes a run resumed across the change re-buy those dispatches.
- Sessions are minted, never stored: `sessionOf` over effort, execution, owner node, role, thread
  and generation. Change a dispatch's owner or thread and it starts a new host session instead of
  resuming its old one.
- `step(ctx, key, fn)` journals a side effect. A run cut off between `fn` and its record calls `fn`
  again, so `fn` must be safe to repeat.
- `run.mjs`'s `claim` resumes a stopped run only when the program, its `scopeOf` key and its args
  digest all match. Changing `ARGS` or `scopeOf` makes a stopped run unfindable: the next start is
  a fresh run that re-buys everything.
- `judgeAllowed` refuses a judge whose session or thread produced the work (L3). Give a judge a
  thread of its own, never the producer's.
- Only the leaf unit passes `briefParts`, so only a resumed leaf thread is told its brief moved
  (`brief_changed`). Every other resumed thread carries on with the brief it started with.

## CONCURRENCY MODEL

One process, one event loop. `execute.mjs`'s tick loop runs units (a leaf's rounds, a planner's
folder, merges, integration reviews, rulers) as promises; `programContext`'s `slots(maxAgents)`
bounds concurrent calls in the run, and a `scoped` nested program shares its parent's slots and
log. Anything that blocks the thread (a synchronous lock wait, `verify` in-process) stalls every
unit and the heartbeat. Host stops are waited out inside `dispatch` (`waitFor`), never counted.

## RESOURCE LIFECYCLE

`lib/run.mjs` owns a run's claim, heartbeat, `ended` line and result file with its cost. A program
returns its result and writes no result file itself.

## INVARIANTS & GOTCHAS

- Every file but `common.mjs` and `converge.mjs` builds its result in a `resultOf` with a coverage
  block (`coverage-block` lint, which does not reach `execute/`); build it with `coverageOf`.
- No `brief`, `threadBrief` or `prompt` here is a literal, template or concatenation
  (`prompt-origin` lint). Prompt text lives in `lib/briefs/`, `lib/brief.mjs` or a `renderMessage`
  template.
- No loop bound or turn cap (`no-loop-bounds`, `no-turn-caps`). A loop that needs to stop asks a
  ruler through `askAfter` in `converge.mjs`.
- `recordOnce` records a message once per node, thread, round and `msg`, so a second message of the
  same kind in one round is silently the first; it needs a new round.
- `reviewUnit` (`execute/integrate.mjs`) names a child's criterion unit `criterion:<leaf>#<n>`, and
  `renderLanding`'s adopted-work section (`lib/render.mjs`) looks rulings up by that name. Rename
  one side and every adopted criterion reads "not ruled" with no error.

## DEPENDENCIES

- lib — `runner.mjs`, `store.mjs` names, the ledger's log ports, `roles.mjs`, `schemas.mjs`,
  `conversation.mjs`.
- lib/boundaries — the execute program's units call them for every record they decide.
- lib/briefs — every prompt but a leaf round's thread brief (`lib/brief.mjs`).
- skills — start programs through `lib/run.mjs` and read their result files; a result field a skill
  reads is a contract (`docs/DESIGN.md#data-contracts`).
