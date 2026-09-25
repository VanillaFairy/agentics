# Writing a design level

Read when the design skill reaches step 6. The document is drafted before the probe (step 4 probes
the draft) and finished after its disposition; commit it and write the node last, as the final act
of the level — a node present over a half-finished level says finished.

## The document

Path: `docs/agentics/designs/<effort>/<node>.md`, where `<node>` is `root` for `.` and otherwise
the node id with `/` written `.` (`auth/session` → `auth.session.md`). You write it — design
documents are source — and commit it on its own:

```bash
git add docs/agentics/designs/<effort>/<node>.md
git commit -m "design(<effort>): <node> at <level>"
```

Sections, in order:

1. **Intent** — at `context`: who it is for, the outcome, success criteria, boundaries, what is out
   of scope. Below it: this node's intent in one paragraph, and its ancestors' documents named as
   settled context.
2. **Level** — which level this is, and every skipped level with its reason.
3. **Decisions** — one row per decision: id, the decision in the user's words, their why.
4. **The design** — what this level states: at `container`, the subsystems that change and each
   contract (name, owner, path prefixes); at `component`, components, interfaces and data shapes;
   at `leaf-spec`, each leaf's acceptance criteria and the check that decides each.
5. **Approaches** — the drafts and the user's choice, or the recorded skip.
6. **Open questions** — graded; no `blocking` entry.
7. **Evidence** — the survey's `coverage` as returned (or the standing survey reused, by stamp); the
   outward search's `already_present`, the chosen candidate or the `no_match` lines that justify
   building; the probe's findings table with dispositions, or why no probe was earned. Every gap in
   coverage is named here, with what rests on it.

## The design node

```json
{ "id": "<node id>", "title": "<imperative>", "intent": "<what it makes true>",
  "kind": "design", "level": "<context|container|component|leaf-spec>",
  "defines": [{ "id": "<decision id>", "text": "<the user's words>" }],
  "decisions": ["<ancestor decision ids this node realises>"],
  "design_doc": "docs/agentics/designs/<effort>/<node>.md",
  "ground": ["<paths this level's evidence lives in>"],
  "provides": [{ "name": "<contract>", "paths": ["<prefix>"] }],
  "consumes": [{ "name": "<contract>", "paths": ["<prefix>"] }] }
```

`defines` carries exactly the document's decisions, same ids, same words. A node that already
exists — the one develop parked, or develop's root composite — is revised: take its row from
`lib/tree.mjs show --repo . --effort <e> --json`, change it, and write the **whole** node back (a
revision replaces the node) with `--reason answered`.

## Its children, at the next level

In the same batch. Ids are `<parent>/<segment>` (segments `^[a-z0-9][a-z0-9-]*$`); each child lists
in `decisions` the ids it realises, and together the children realise every id this node
`defines`:

- **`design`** — a child that needs its own level later: `{id, title, intent, kind: 'design',
  level: '<next>', decisions, provides, consumes}`, no children yet (just in time).
- **`composite`** — settled; the planner decomposes it: `{id, title, intent, kind: 'composite',
  decisions, ground, ground_known}` (`ground_known: false` when finding where it goes is part of
  the work).
- **`leaf`** — from a `leaf-spec`: `{id, title, intent, kind: 'leaf', decisions, acceptance: [{text,
  check, decisions}], locus, reads, deps, rigor}` — each criterion names its check, or starts
  `HUMAN:`. Rigor per `docs/DESIGN.md#rigor`.

A contract a child `provides` has a unique name; its consumers `consumes` the same name.

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/tree.mjs" add --repo . --effort <e> --file <path.json> --by session
```

`ok: false` lists the problems and wrote nothing: fix the nodes. Of the warnings, `gaps` (a
decision no child realises) block the hand-off until resolved; `untraced` criteria go to the user
to accept or remove; an `atomicity` warning means a "leaf" is not one — make it a composite.
