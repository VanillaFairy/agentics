# service-workflows

## PURPOSE

The orchestration scripts: evidence gathering, adversarial document review, build-or-adopt search,
answering a codebase question, and executing an approved plan in worktrees. They are separate from
`lib/` because they run in the workflow host's sandbox, where they may dispatch agents but cannot
touch the filesystem or git, so every deterministic step goes out through a courier to a `lib/` CLI.

## KEY ABSTRACTIONS

- Nested calls go by path, `workflow({ scriptPath: pluginRoot + '/service-workflows/<name>.workflow.js' }, args)`,
  not by name, because these scripts sit outside a registered `workflows/` folder and have no name
  to call. The `workflow("name", args)` wording in `gather-evidence-without-concluding`'s `whenToUse`
  is loose. A skill that launches a nesting workflow must pass `plugin_root`, which
  `test/skill-plugin-root-parity.test.mjs` pins.
- `meta` must be a static object literal, because the host reads it without evaluating the module:
  `description: 'a' + 'b'` is valid JS that the host refuses, and the workflow never registers
  (`tools/rules/workflow-meta.mjs`).

## CONCURRENCY MODEL

`execute-approved-plan-in-worktrees.workflow.js` runs leaves and inline folder replans as
concurrent promises held in `running`, scheduled by readiness. The script owns no locks: whether a
leaf may start is decided by `lib/boundary.mjs leaf-open`, which answers `no_slot`, `locus_held` or
`busy`, and the script retries. A unit leaves `running` only once a tick carries what it decided,
because dropping it earlier lets the scheduler launch beneath it or twice.

## INVARIANTS & GOTCHAS

- `canonical`/`fnv1a` appear in several of these scripts as copies of `lib/plan-digest.mjs`, on
  purpose, because a workflow cannot `import` (`tools/rules/no-imports.mjs`). Grep `fnv1a` and
  change every copy together: a one-sided edit passes lint, then every resume halts on a digest
  mismatch that doesn't name the cause. The scenario tests compare the copies against the lib.
- Schemas carry no `minItems`/`maxItems`/`minLength`/`maxLength` (`tools/rules/no-schema-bounds.mjs`),
  because structured output drops them. A cap lives in the prompt and is enforced in JS after the call.
- No schema carries a verdict boolean (`suitable`, `approved`), because the dispatched agent would
  be judging itself (`tools/rules/no-self-verdict.mjs`). Every gate is computed here from typed findings.
- No turn or round caps in prompt text or schema (`tools/rules/no-turn-caps.mjs`, IL1). The
  review loop ends on computed progress conditions, never a counter; adding `rounds` breaks the law.
- Never nest a template literal inside another, and never put a quote inside a regex literal,
  because `coverage-block` and `workflow-meta` blank strings without tracking nesting and then
  report nonsense against the code that follows.

## DEPENDENCIES

- lib — every deterministic step (boundary, verify, status, gotchas) is a CLI run by the courier;
  `plan-digest.mjs` is the one duplicated instead.
- agents — dispatched by qualified type (`tools/rules/qualified-agent-types.mjs`); the courier is
  the only path to `lib/`.
- test-harness — `workflow-host.mjs` runs these bodies; a change to the runner's globals changes it too.
