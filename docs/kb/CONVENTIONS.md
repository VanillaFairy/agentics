# Conventions

The rules for changing this repo are in `CLAUDE.md`, and the reasons are in `docs/DESIGN.md`.
This file covers only the code-level idioms neither of them states.

## lib files (pattern)

- **Header.** Each file opens with `// lib/<name>.mjs — <role>` and a
  `// Design: docs/DESIGN.md#<anchor>` line. `test/design-doc.test.mjs` fails on an anchor with
  no heading, so grep for pointers before renaming a DESIGN.md heading.
- **CLI main guard.** A file that is also a CLI ends with
  `import.meta.main ?? (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)`.
  Copy that guard. A plain string compare against `argv[1]` breaks on Windows paths.
- **Errors.** Refuse, never repair. Bad input throws or returns `{ ok: false, error }`; it is never
  coerced into something plausible.

## CLI exit codes (bug-causing)

A CLI that printed a digest-covered payload exits 0, even when the payload is a typed error,
because a typed error is a measurement outcome. Only an unexpected failure exits 1. Making typed
errors exit non-zero turns a legitimate refusal into "the tool is broken" at the dispatching courier.

## Adding things (bug-causing: nothing reminds you)

- **Agent.** Add `agents/<name>.md`, its `test/agent-allowlists.test.mjs` entry and its
  `tools/budgets.json` line. Workflows and skills refer to it by its qualified type, `agentics:<name>`.
- **Skill.** Add `skills/<name>/SKILL.md` and its budget line. If it launches a workflow that
  nests another, pass `plugin_root` and add the pair to `test/skill-plugin-root-parity.test.mjs`.
- **Workflow.** Add `service-workflows/<name>.workflow.js` with a static `meta` literal. Disk, git
  and any deterministic step go through a `lib/` CLI run by the courier, never inline.
- **Lint rule.** Add `tools/rules/<id>.mjs` exporting `id`, `applies` and `check`. Any new concept
  it names needs a consumer somewhere, or `test/liveness.test.mjs` fails.
- **Data contract.** Any field change edits its entry in `docs/DESIGN.md#data-contracts` and every
  copy that entry names.
