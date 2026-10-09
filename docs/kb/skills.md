# skills

## PURPOSE

The user's entry points. A skill runs in the user's session, so it owns the conversation and the
user's gates; programs and lib CLIs own everything else. This index lives in `docs/kb/` because
`size-budget`, `skill-handles` and `no-skill-agents` apply to every `.md` under `skills/`.

## INVARIANTS & GOTCHAS

- No skill starts an agent: no `Agent` or `Task` tool, no `subagent_type`, no `agentics:<role>`
  (`no-skill-agents`). Work that needs an agent is a program, started with
  `node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" <program> --detach` and followed with the Monitor tool
  on `lib/status.mjs watch`.
- A command a skill runs carries handles only (`skill-handles`): no `--stdin`, `--json-file` or
  `--b64`, no heredoc, no `printf`, no pipe into `node`. Data goes in a file the session writes with
  Write and names with a `-file` flag; free text goes in a `text` flag of one line. At run time
  `handleArgs` refuses anything else, so a command the lint misses still fails.
- A program that takes the user's word at the console (`attachedOnly`, such as `rule
  --user-approved`) refuses `--detach`, so the skill runs it attached.
- Running a program's command again resumes its stopped run only with the same arguments; a changed
  argument starts a fresh run that re-buys its dispatches.
- `search-for-existing-solutions-before-building` is `user-invocable: false`, because only `design`
  reaches it. It is not dead code.
- Paths go through `${CLAUDE_PLUGIN_ROOT}`, because the skill runs from the installed plugin cache,
  not this checkout.
- `<!-- agentics:verbatim <id> -->` blocks are shared between skills and with `roles/` and
  `docs/DESIGN.md`. Grep the id before editing a block (`test/fast/verbatim-blocks.test.mjs`).
- Every file, `develop/landing.md` and `develop/respec.md` included, has a line budget in
  `tools/budgets.json`. Reasons belong in `docs/DESIGN.md`.

## DEPENDENCIES

- lib — skills shell out to its CLIs (`status`, `approval`, `next`, `effort`, `evidence`,
  `boundary`, `spec`, `render`, `compile`) and to `run.mjs`; a flag or printed-shape change edits
  every skill that names the CLI. `boundary land` runs only behind the session's gate (L4).
- lib/programs — a result field a skill reads is a contract (`docs/DESIGN.md#data-contracts`).
- roles, docs/DESIGN.md — shared verbatim contracts, chiefly `vocabulary`.
- tools — `budgets.json` and the skill lint rules.
