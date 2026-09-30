# agents

## PURPOSE

The subagent definitions that workflows (and a session driving the same pipeline) dispatch. They
are separate files because each one's frontmatter `tools:` line is its entire capability: there
are no hooks, so anything beyond the allowlist is prose that review audits after the fact.

## INVARIANTS & GOTCHAS

- A `tools:` change edits `test/agent-allowlists.test.mjs` in the same commit, because that test
  pins every allowlist exactly and fails on any widening or narrowing.
- Every file has a line budget in `tools/budgets.json` (`size-budget` lint rule). Raising a budget
  is a reviewed diff; reasons go to `docs/DESIGN.md`, not into the agent text.
- `<!-- agentics:verbatim <id> -->` blocks restate a contract that also lives in other agents or
  in `skills/`. `test/verbatim-blocks.test.mjs` requires every copy of an id to be byte-identical,
  so editing one copy means grepping the id and editing all of them. The `vocabulary` block ties
  `planner.md` to `skills/design/SKILL.md` and `skills/develop/SKILL.md`. `reviewer.md`'s
  `severity-ladder` is a different contract from the skills' `design-severity-ladder`, so don't merge them.
- `courier.md` is the only way a workflow reaches `lib/`, because the workflow sandbox has no
  filesystem. It must stay a byte-for-byte relay: any judgment added to it becomes an unreviewed
  step inside every deterministic boundary.
- Agent types resolve from one flat registry shared by every installed plugin, which is why
  workflows name them qualified (`agentics:scout`). Renaming a file renames the type and breaks
  every workflow and skill that names it.

## DEPENDENCIES

- service-workflows — dispatches these by qualified type; `implementer`, `planner`, `reviewer`,
  `ruler`, `auditor`, `test-author` and `courier` exist only for it.
- lib — `lib/brief.mjs` serves the brief that `implementer`/`test-author` fetch by digest, and
  `lib/commit-series.mjs` checks the implementer's locus per commit after the fact.
- tools — `budgets.json` and the `agent-frontmatter` rule judge these files.
