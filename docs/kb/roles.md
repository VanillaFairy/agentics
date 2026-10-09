# roles

## PURPOSE

The agent roles. A file's frontmatter is the role's kind, tools, commands, return schemas and
default tier; its body is the system prompt. `lib/roles.mjs` is the only reader, and the runner
hands the body to a headless host session. They are not Claude Code agents, so nothing but a
program can start one. This index lives in `docs/kb/` because `role-frontmatter` and `size-budget`
apply to every `roles/*.md`.

## INVARIANTS & GOTCHAS

- Capability is `tools:` and `commands:` plus the permissions `lib/locus.mjs` computes:
  `permissionsFor` for a leaf's producer, `readOnlyPermissions` for the rest. A change to either line
  edits `test/fast/role-allowlists.test.mjs` in the same commit.
- `roleCommands` replaces `<build>`, `<typecheck>` and `<test>` with the effort's established
  commands, and gives an implementer its leaf's criterion checks too. A literal command written in
  `commands:` is granted as written in every repository.
- `tierFor` ignores the frontmatter `model:` of a role in `GATES`: the intelligence dial sets it,
  and `low` runs the frontmatter effort one step deeper on sonnet. Editing a gate's model changes
  nothing at run time.
- A new role needs its file, its name in `ROLE_NAMES`, every `schemas:` entry exported by
  `lib/schemas.mjs`, a `tools/budgets.json` line, its `role-allowlists` pin, and a program that
  dispatches it, or `liveness` fails. `role-frontmatter` rejects any other frontmatter key.
- `<!-- agentics:verbatim <id> -->` blocks tie roles to skills and `docs/DESIGN.md` (`vocabulary` in
  `planner.md`, `severity-ladder` in `reviewer.md`) and to each other (`comment-policy`).
  `severity-ladder` is a different contract from the skills' `design-severity-ladder`, so don't merge
  them. Grep the id and edit every copy (`test/fast/verbatim-blocks.test.mjs`).
- A producer's or searcher's schema carries no ruling field (`no-self-verdict`). Role text that asks a
  producer to certify its own work asks for a field nothing accepts.

## DEPENDENCIES

- lib — `roles.mjs` (parse, tiers, commands), `schemas.mjs` (returns), `locus.mjs` (permissions),
  `runner.mjs` (the session).
- lib/programs — the only dispatchers; a role's thread, round and owner are the program's choice.
- tools — `role-frontmatter`, `size-budget` and `no-turn-caps` judge these files.
