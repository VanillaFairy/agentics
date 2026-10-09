# Conventions

The rules for changing this repo are in `CLAUDE.md`, and the reasons are in `docs/DESIGN.md`.
This file covers only the code-level idioms neither of them states.

## lib files (pattern)

- **Header.** Each file opens with `// lib/<path>.mjs — <role>` and a
  `// Design: docs/DESIGN.md#<anchor>` line. `test/fast/design-doc.test.mjs` fails on an anchor with
  no heading in any file of the repo, this KB included, so grep for pointers before renaming a
  DESIGN.md heading.
- **CLI main guard.** A file that is also a CLI ends with
  `import.meta.main ?? (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)`.
  Copy that guard. A plain string compare against `argv[1]` breaks on Windows paths.
- **Arguments.** A CLI a skill calls checks argv with `handleArgs` from `lib/store.mjs`, each flag
  given its kind. A flag left out of the map is refused as `unknown_flag`.
- **Names.** Branches, worktrees, sessions, dispatch keys and `.agentics/` paths come from
  `lib/store.mjs`, never from string building.
- **Errors.** Refuse, never repair. Bad input throws or returns `{ ok: false, error }`; it is never
  coerced into something plausible.

## CLI exit codes (bug-causing)

A CLI that prints an `envelope` (`payload` and `payload_digest`) exits 0 even when the payload is a
typed error, because a refusal is an answer the skill reads, not a broken tool; only an unexpected
failure exits 1. Not every CLI follows it: `lib/effort.mjs`'s writer verbs print the ledger's
`{ok}` shape and exit 1 when it is false, and `lib/run.mjs` exits 0 whenever its printed object has
an `ok` key. Read the CLI's own main block before relying on its exit code.

## Adding things (bug-causing: nothing reminds you)

- **Role.** `roles/<name>.md`, its name in `ROLE_NAMES` (`lib/roles.mjs`), its schemas in
  `lib/schemas.mjs`, a `tools/budgets.json` line, its pin in `test/fast/role-allowlists.test.mjs`,
  and a program that dispatches it.
- **Program.** `lib/programs/<name>.mjs` exporting `<name>(ctx, args)`, `ARGS` and `scopeOf`
  (`homeOf` and `attachedOnly` when it needs them), its result built in a `resultOf` with a coverage
  block; its name in `PROGRAM_NAMES` (`lib/run.mjs`); its prompts in `lib/briefs/`.
- **Record kind.** Its routing through `EVENT_KINDS` or `JOURNAL_KINDS` in `lib/ledger.mjs`; a
  `stands` case in `freshRecords` (`lib/boundaries/records.mjs`) if a boundary decides it; a writer
  and a reader, or `test/fast/liveness.test.mjs` fails.
- **Message kind.** A row in `ROUTES` and a template in `TEMPLATES` (`lib/conversation.mjs`), and a
  program or boundary that sends it.
- **Skill.** `skills/<name>/SKILL.md` and its budget line. It reaches agents only through
  `lib/run.mjs`.
- **Lint rule.** `tools/rules/<id>.mjs` exporting `id`, `applies` and `check`, and its test.
- **Data contract.** Any field change edits its entry in `docs/DESIGN.md#data-contracts` and every
  copy that entry names.
