# Ruling a changed spec

Read when the develop skill's step 4c has edited a spec. Each spec you edited is ruled against
every answer the user recorded since it was last approved, a parent before its child
(`docs/DESIGN.md#a-changed-spec`). The user is never asked to approve a change their answers settle.

The `rule` program rules it, started detached and followed with the Monitor tool on
`node "${CLAUDE_PLUGIN_ROOT}/lib/status.mjs" watch --repo . --run <run> --since 0`; on `ended done`
read `result_file`'s `status`; on `stopped: …` start the command again; `ended failed` and
`launch_failed` are plugin faults, retried once; a `run_live` refusal names a ruling going: watch it.

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run.mjs" rule --repo . --detach --effort <e> --folder <id>
```

- `approved` — every unit is unaffected or settled by the user's answers (`by: answer`): it is
  approved and compiled, and what it reaches is spared its parks. Tell the user in one line; ask nothing.
- `needs_user` — `affected` lists what no answer settles. Make each `fix` in the spec owning the
  unit, rule that spec the same way, then rule this one again. Ask every `question` left in one
  `AskUserQuestion` call, opened and recorded as step 4c says; carry the answers into the specs
  they reach and rule again. Never ask for approval.
- `compile_refused` — its `problems` name file and line: the fix is an edit, ruled again.
- `refused` — by its `next`: `user_approves`, show the change, then ask and approve as the skill's
  step 2 does and compile as its step 3 does; `fix_spec`, edit what `problems` name;
  `rule_parent_first`, rule the spec `why` names; `rule_it`, rule it again; `planner`, leave it to
  the run; `nothing`: approved.
