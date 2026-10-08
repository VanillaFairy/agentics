# Ruling a changed spec

Read when the develop skill's step 4c has edited a spec. Each spec you edited is ruled before
anyone is asked to approve it, a parent before its child (`docs/DESIGN.md#a-changed-spec`).

The `rule` program rules it, started detached and followed with the Monitor tool on
`node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" watch --repo . --run <run> --since 0`; on `ended done`
read `result_file`'s `status`; on `stopped: …` start the command again; `ended failed` and
`launch_failed` are plugin faults, retried once; a `run_live` refusal names a ruling going: watch it.

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" rule --repo . --detach --effort <e> --folder <id>
```

- `approved` — nothing the change reaches is moved by it: it is approved on that ruling and
  compiled, and what it reaches is spared its parks. Tell the user what changed in one line; ask nothing.
- `needs_user` — for each `affected` with a `fix`, make that edit in the spec owning the node, rule
  that spec the same way, then rule this one again. Ask the user each `question` left; then show the
  change and its `reasons` and ask, the result's `token` in the question's own text, with exactly
  the options `Approve` and `Change it`. On `Approve`, run it attached, since it reads the answer:
  `node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" rule --repo . --effort <e> --folder <id> --user-approved`.
  It prints `approved`, `refused` with `next: ask_user` (ask again with its `token`), or another result, handled below.
- `compile_refused` — its `problems` name file and line: the fix is an edit, ruled again.
- `refused` — by its `next`: `user_approves`, show the change, then ask and approve as the skill's
  step 2 does and compile as its step 3 does; `fix_spec`, edit what `problems` name;
  `rule_parent_first`, rule the spec `why` names; `rule_it`, rule it again; `planner`, leave it to
  the run; `nothing`: approved.
