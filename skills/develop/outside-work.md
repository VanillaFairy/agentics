# Work done outside agentics

Read when the user says work on an effort was done by hand, or a run stopped at `outside_work`.
Work no execution did is adopted on the user's word; the folder's integration review then judges
it with the rest.

## 1. The mapping

Ask the user what was done and where. For a run that stopped, the commits are in
`lib/status.mjs checkpoint --repo . --effort <e> --execution <stamp>`. Write one JSON file per
folder with your Write tool, in your scratch directory:

```json
{
  "done":     [{ "node": "<leaf id>", "commits": ["<sha>"] }, { "node": "<leaf id>", "branch": "<branch>" }],
  "outside":  [{ "commits": ["<sha>"] }],
  "handover": [{ "node": "<leaf id>", "branch": "<branch>" }]
}
```

- `done`: a leaf finished by hand. `commits` when they sit straight on the folder's branch;
  `branch` when its own branch was merged into the folder's branch with `--no-ff`. A
  fast-forwarded branch goes by its `commits`.
- `outside`: commits on the folder's branch that belong to no leaf.
- `handover`: a leaf a person started for agentics to finish, by the branch they worked on.
- Every key is optional. Ids, shas and branch names only. `--folder` is the folder whose branch
  holds the work; a group's leaves go with the folder above the group.

## 2. Check

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" adopt --repo . --effort <e> --folder <id> --map-file <path> --action check
```

It writes nothing. `ok: false` lists `refusals[{entry, kind, message}]`: correct the mapping and
check again. `ok: true` carries the report and the `token`.

## 3. Show the report, then ask

Show, as printed:

1. `unaccounted`: commits on the folder's branch this mapping still leaves out. The next run stops
   at `outside_work` again until they are adopted too.
2. `outside_locus`: files an adopted leaf's commits touch that its locus does not admit.
3. `clears_stops`: escalations and parks this adoption overrides.
4. `deps_open`: dependencies of an adopted leaf that are neither merged nor adopted.
5. `criteria`: each adopted leaf's criteria, which the folder's integration review will rule on.

Then one `AskUserQuestion` with the `token` in the question's own text, offering exactly `Adopt`
and `Change it`. On `Change it`, edit the mapping with the user and check again.

## 4. Act, on `Adopt`

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/boundary.mjs" adopt --repo . --effort <e> --folder <id> --map-file <path> --action act
```

It confirms the answer for the token, checks again and writes every record in one batch.
`head_moved`: a branch moved since the question; check and ask again with the new `token`.
`not_approved`: the answer was not `Adopt` to that token. A refusal: as in step 2. Report
`recorded` and the branches in `created`, then relaunch (step 3 of the skill).
