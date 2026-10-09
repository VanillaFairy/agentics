## KB rules
Each module in the Architecture map has an index at the path shown there: `INDEX.md` beside the
source, or `docs/kb/<module>.md` where a file in the module's folder would load as runtime text.
An index holds what the code and `docs/DESIGN.md` cannot say: couplings, fences, what a change
breaks elsewhere. It never repeats what a signature or a header comment already states.

- `docs/kb/CONVENTIONS.md` — lib file idioms, CLI exit codes, what to touch when adding a role/program/record/message/skill/rule.
- `docs/kb/GOTCHAS.md` — copies that must move together, plugin cache, detached runs, branch naming.
- `docs/kb/BUILD.md` — checks, manifest validation, versioning and distribution.
- `docs/kb/TESTING.md` — running tests, the directory-argument trap, the spawn-free tier.

The KB is a routing aid that bottoms out in source. For exact constants, enumerations or
sequences, read the source. The KB carries no counts.

The KB is refreshed once per finished effort, never inside the commits that build it; until then,
where it disagrees with source, source wins. When an effort is complete, run `/kb:update` with no
argument, which commits its result separately.
