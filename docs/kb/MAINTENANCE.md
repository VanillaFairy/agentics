# Knowledge base maintenance

This is the operating manual for the repository's knowledge base (KB). Claude Code agents don't
read it; their rules live in `CLAUDE.md`'s `## Knowledge base` section. It's also separate from
`README.md`, which describes the plugin itself, and from `docs/DESIGN.md`, which is the design.

## Who reads what

| File | Audience | Edit where |
|---|---|---|
| `CLAUDE.md` (`## Build`, `## Architecture`, `## Knowledge base`) | agents, every session | `CLAUDE.md`; keep `## Knowledge base` identical to `docs/kb/KB_RULES.md` |
| `docs/kb/KB_RULES.md` | agents, through `CLAUDE.md` | here, then copy into `CLAUDE.md` |
| `lib/INDEX.md`, `lib/programs/INDEX.md`, `lib/boundaries/INDEX.md`, `lib/briefs/INDEX.md`, `tools/INDEX.md`, `test/harness/INDEX.md` | agents | beside the source |
| `docs/kb/roles.md`, `docs/kb/skills.md` | agents | `docs/kb/`: a file inside `roles/` would be judged as a role, and one inside `skills/` fails lint |
| `docs/kb/BUILD.md`, `TESTING.md`, `CONVENTIONS.md`, `GOTCHAS.md` | agents | `docs/kb/` |
| `docs/kb/MAINTENANCE.md`, `README.md` | humans only | here |

`.kbignore` at the root lists what KB analysis skips (worktrees, `.agentics/`, fixtures, planning scratch).

## Ownership

| File | Owner |
|---|---|
| `CLAUDE.md`, `docs/kb/KB_RULES.md` | maintainer only; loaded into every session |
| `docs/kb/GOTCHAS.md`, `CONVENTIONS.md` | maintainer review |
| module indexes, `BUILD.md`, `TESTING.md` | anyone, through `/kb:update` |

## When to update

Once per finished effort, meaning work that would stand as its own PR. Run `/kb:update` with no
argument: it refreshes the modules the effort touched and commits the result as one separate
commit. Development commits never touch the KB.

An index needs a change when an effort:

- adds or breaks a coupling, such as a new copy of the lint rules' string blanker, a new verbatim block, or a CLI
  whose output a skill parses;
- changes locking, slots, worktree or branch lifecycle;
- adds a module or a dependency between modules.

It doesn't need one for bug fixes, private refactors, test-only changes, or anything DESIGN.md
already records.

## Review checklist

- [ ] Each new line names the mistake it prevents, and it would still be a mistake for someone reading the code.
- [ ] Nothing restates a header comment, a frontmatter description or a DESIGN.md section.
- [ ] No counts of anything the code enumerates (agents, rules, files, tests); name the thing instead.
- [ ] Every claim names a greppable identifier and says why ("X, because Y").
- [ ] Concurrency and lifecycle claims match `lib/store.mjs`, `lib/locks.mjs` and `lib/boundary.mjs`.
- [ ] Each index stays under about 600 words.

## Quarterly review

- Run `/kb:check` and fix the drift it reports.
- Put a few real questions to a fresh agent with only the KB (for example "where does a leaf get
  its slot", or "what else changes when I rename a thread"), and fix the files behind the wrong answers first.
- Delete gotchas whose mechanism is gone. The old KB's per-order branch naming and its CRLF
  fixture advice were both dead by the time this KB was built.

## Anti-patterns

- Copying doc comments or DESIGN.md prose into an index.
- Padding with information obvious from a file name.
- Counts, which rot the moment something is added.
- Narrating what a function does step by step.
- An index past about 800 tokens: cut before splitting.
