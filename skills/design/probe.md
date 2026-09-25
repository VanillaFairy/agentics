# The probe of a design level

Read when the design skill reaches step 4 and the probe is earned. The `probe` skill owns the
axes, the ladder and the computed gate; this is how a design pass uses it. Do not hand-roll a
probe here.

```
Workflow({ name: 'agentics:agentics-probe', args: { artifact, roots, context, plugin_root } })
```

`artifact` is the path of the level's drafted document; `context` is one line on what it is
for, never the author's defence of it. Probers get the document and the repository — the
ancestors' documents are in the repository, so cross-level contracts are probed as evidence the
probers find themselves. One analyst holds every axis unless length earns more. Reinvention is
always an axis: is anything here rebuilding what the outward search found?

Record the return (`effort.mjs record . <e> probe --file <path.json>`) before the disposition.

`result.ratifiable` is the gate: a count, false while any ambiguity is open and false when any axis
went unexamined. Read `coverage` before acting on a clean report; incomplete coverage is re-run
for what `coverage.resumable.remaining` names.

<!-- agentics:verbatim design-severity-ladder -->
- **ambiguity** — a term, contract, or interface the design leaves readable two ways. Blocks
  ratification. The archetype is one name with two incompatible definitions in the same
  document: every consumer implements one of them, the mismatch is invisible until
  integration, and it costs a rework round rather than a sentence.
- **gap** — a growth axis or requirement the design names but cannot absorb without rework.
  Resolved, or explicitly accepted by the user with the cost stated. Never silently carried.
- **note** — advisory. Recorded in the design document, never blocks, never loops.
<!-- /agentics:verbatim -->

Every `ambiguity` is resolved with the user before the level is ratified; every `gap` is designed
away or accepted out loud, in the document, in the user's words; notes are written down and left
alone. A resolution that is a decision gets an id like any other decision.

<!-- agentics:verbatim probe-disposition -->
**Summarise before you ask anything.** A probe returns findings per axis and the axes
overlap, so handed over raw it is a wall of text that costs more attention than the artefact
did. Open with a count and a table — one row per topic, never one per finding:

```
46 findings across 16 axes. 12 block ratification, in 4 topics:

  topic              blocking  what goes wrong if it stands
  bundle identity        5     two consumers implement different id rules, and the
                               mismatch first shows up at integration
  path derivation        4     ...

Also 9 gaps to accept or design away, and 25 notes recorded without asking.
```

The consequence column is the point of the summary. A reader deciding how much attention
this deserves needs to know what it costs to be wrong, not what the claim was.

**Notes are never questions.** Record them in the artefact and move on. A note that reaches
the user as a question spends their afternoon on advisory text — the exact failure the
ladder's inflation warning names.

**Consolidate questions, never findings.** Every finding is reported as it was returned;
that rule does not move. But several findings turning on a single decision are ONE question
— four axes noticing the same undefined term is one term to define. This is what takes a
disposition from forty questions to six.

**Ask in grouped sets.** `AskUserQuestion` carries up to four questions per call: fill it
with one topic's questions so a set can be answered in a single pass of attention. Order the
sets by blast radius, whatever constrains other decisions first. Every question keeps its
recommended answer marked `(Recommended)`, with the reason in the option's description.

**This is deliberately not the interview's rule.** The interview asks one question at a time
because each answer changes what is worth asking next and the tree is discovered as it is
walked. A disposition has no such tree: the findings are computed, independent, and all on
the table before the first question. One at a time is not care here, it is forty turns.
<!-- /agentics:verbatim -->

Write the dispositions into the document — a findings table with what each one changed. A gate
closed by ambiguities is opened by their written dispositions, not by probing again. **A second
round is earned** only by an ambiguity whose resolution reshaped the design (a new interface, a
data shape, which component owns a decision); name the one that earned it.

If the probe cannot dispatch, say so. Offer a self-probe as the weaker instrument it is, and let
the user decide; never substitute one silently.
