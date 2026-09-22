---
name: develop
description: Use when the user asks to implement a change, feature, or fix through the vf-agentics pipeline — surveyed evidence, planned work orders, focused commits, mechanical verification, and an adversarial review loop. Not for read-only questions (investigate).
---

# develop

Invoking this skill **is** the user's opt-in for the `Workflow` tool. Do not ask again.

## Parse arguments

**Intelligence** sets the tier for the whole run — the judging agents, and at `max` the coder
along with them, though never to the same model.

<!-- vfa:verbatim intelligence-tier -->
The dial follows the model this session is running, never how important the work feels:
**Fable → `max`; Opus → `normal`; Sonnet and everything below it → `low`.** When you cannot
tell what you are running, `normal`.

The judging agents belong at the tier of the session driving them. A session that dials itself
up because the change looked significant is charging the user for its own self-assessment; a
Fable session that leaves the dial at `normal` has its work judged by a weaker model than the
one the user is talking to, and a Sonnet session that claims `normal` bills the user for Opus
judgment nobody asked it for. Only the user moves it off that mapping — a bare leading `max`,
`normal` or `low` token, or `--intelligence=<tier>`.
<!-- /vfa:verbatim -->

**What each position moves.** The judging agents — the planner, every reviewer, and the
analysts of the nested survey — run on Sonnet at `low`, Opus at `normal`, Fable at `max`. The
coder moves once, at `max`, and moves to **Opus rather than Fable**: judging is where this
pipeline concentrates its judgment, and doubling the price of its highest-volume agent buys
nothing the field evidence ever credited to Fable. Below `max` the coder keeps its own model,
and the verifier, the scouts and the courier keep theirs at every position.

**When the dial lands on `low`, say what it costs before a long run starts.** The coder already
runs Sonnet, so `low` leaves no strong reader anywhere in the loop: a defective work order
implemented faithfully clears verification, and then clears a review fenced to the same
defective criteria. That is the honest price of being judged at the tier of the session driving
the work, and the user may well accept it — a sentence before the run is what they need, not a
session that quietly dials itself up, which is the self-assessment the block above forbids.

**A resume derives nothing.** When you are resuming a parked run (step 3e), pass no
`intelligence` at all — the plan's envelope carries the tier it was planned at, and the
workflow adopts it. A derived value passed into a resume is indistinguishable from a
deliberate override, gets logged as one, and quietly re-tiers somebody else's plan.

Everything after the flags is the change description. `roots` defaults to the current
directory; pass `notes` only when the user gave extra constraints.

`--pause-between-waves` is an opt-in for callers who want to look at each wave before the
next one starts. It is off unless the user asks for it: one invocation carrying the whole
change is the point of this pipeline, and paused waves cost a re-invocation each.

**Reach for it — or for `--plan-only` — when this session is already deep.** The run logs its
plan size before dispatching anything (`Plan size: N order(s) across M wave(s)`), and where the
caller set a token target the workflow stops at a wave boundary rather than starting a wave the
target cannot cover. Neither can see an account's usage limit; you can. A run killed halfway
through a wave does not resume cheaply: the agents that had not returned recorded nothing, so
their work is gone rather than deferred. A wave boundary has the state line written and the
next wave branching from a head that already exists, which is why stopping there is nearly
free — and it is the difference the three interruptions of 2026-08-27 turned on.

`--plan-only` surveys, plans and partitions, then stops with the plan written to disk and
nothing implemented. Use it when the user says to plan something now and build it later, or
wants to look at the decomposition before paying for it. The run returns a checkpoint whose
`reason` is `plan_only`; implementing it later is a resume, not a re-plan, and costs no
second survey. Several plans may sit parked at once — that is the point — and `/vf-agentics:runs`
is how the user finds them again.

`base_ref` names the branch the run's integration worktree is cut from. Absent, it is the
current HEAD. A programme's slice run passes the programme branch, because its predecessors'
work lives there and nowhere else. **It is a named ref only** — pass a branch or a tag, never
a sha; the workflow refuses a sha at input, and the refusal is the point, not fussiness (a sha
re-resolves to itself, so the drift check would compare the anchor to the anchor forever).

`programme` and `slice` tag the run as implementing one slice of one programme. Copy them from
`programme.json`; never retype them. They are what makes a run attributable, and an
unattributable run forces a programme to store its progress as a claim instead of deriving it.

## Step 0 — Resume before you plan

**Before anything else, look for a run that already exists for this change.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/run-status.mjs" <repo-root>
```

Compare each row's `change` against the change you were handed, **exact string**. A row that
matches and is `planned` or `in-flight` is not a coincidence — it is this work, already
surveyed and already planned, possibly already half built. **Resume it** (step 3e's
`resume_path`, which is the run directory) rather than starting over.

This makes re-invocation idempotent, and idempotent entry is exactly what a retry is: a naive
re-invocation by a session that remembers nothing. Without this step nothing was ever required
to look, and in the field a complex run died on a session limit and its retry started from
scratch — twice — with the resumable plan sitting on disk the whole time and worktrees full of
finished commits beside it.

An `in-flight` row may be live in another session right now. Say what you found and ask; the
user is the one who knows. What you must not do is silently plan the same change a second time.

**Which resume, when.** Two tiers exist and they are not interchangeable:

- **`resumeFromRunId`**, the harness's own replay, when *this conversation* recorded the
  `runId` of the launch (step 2 mandates recording it). Every completed agent returns from
  cache and only what died re-runs. This is the cheap one, and it is available only inside the
  conversation that launched the run.
- **`resume_path`**, the durable one, otherwise. It crosses sessions and machines-with-the-same-
  checkout. It pays for ONE courier — which runs `lib/run-verdict.mjs` and pastes its stdout,
  a small payload carrying its own digest — and for nothing else: no survey, no planning, and
  no re-doing of any stage the run recorded and git still corroborates (step 3e's ladder).
  A run whose ledger is empty and whose order branches do not exist is recognised as having
  nothing to salvage *by definition*, and opens for the cost of one `git branch --list`.

Reach for the first when you can and the second when you cannot. The field incident used
neither, because until now no skill said when to use which.

**Trust `resumeFromRunId` once, not forever.** The harness cache is an optimization, not a
record: it can miss silently, and when it does the workflow sees an ordinary fresh
invocation. In the field this happened on the relaunch after a resumed run was killed
mid-flight (`TaskStop`) — byte-identical arguments, zero cache hits, and the run re-surveyed
and re-planned a change whose half-built branches sat on disk. So: after ANY hard kill of a
running invocation — `TaskStop`, a crash, a session limit that died mid-write — relaunch
with `resume_path`, not `resumeFromRunId`. The workflow itself now refuses to plan a change
that already has a `planned` or `in-flight` run recording the same change string (checkpoint
`existing_run`, step 3), so a cache miss can no longer silently buy a duplicate — but that
refusal is a stop, and passing `resume_path` up front is the version of it that keeps moving.

## Triage — is this change worth the pipeline?

**One honest question, asked once, before any survey is bought.** It applies to fresh work
only: a resume (step 0) is a plan somebody already paid for, and `--plan-only` is a user who
asked for a plan in so many words. Neither gets triaged.

Three properties. The answer only points one way when **all three** hold:

- **one obvious locus** — the file or small cluster of files that changes is already known,
  and finding it is not part of the work;
- **a settled shape** — the approach is decided rather than something this change has to
  discover;
- **nothing to partition** — no independent pieces to run side by side, and no red/green
  split worth holding, because it is one series of commits by one author.

When all three hold, **offer the fix lane** — `lane: 'fix'` with the locus you just named. It
is the same run with the survey and the decomposition taken out, and it keeps the two things
the audit found were actually paying: the discriminator and the adversarial review. Say it in
these terms: **this does not need the full pipeline; the fix lane runs the checks that catch
things and skips the parts that were buying nothing here.**

A direct session is still the right answer for the smallest work — a rename, a typo, a
one-line constant — where even four dispatches and a worktree cost more than the change. Offer
that instead when the change is that small, on the same terms as before: this fits a direct
session with a reviewer pass.

**Say why, with the numbers.** They come from a field audit that read ten sessions end to end
and asked of each whether a naive "do X" would have served better. Seven of ten: yes. A run buys ~400–500k tokens of survey before a line is written; a
TDD'd behaviour costs 10–12 dispatches across its red and green halves; a five-line
camera-rounding fix carried its own 48-line pinned test through two dedicated worktrees. The
best direct session in that audit landed ~1,300 lines, 62 tests and four clean commits in 35
minutes with zero corrections. That comparison is the user's to make, and they can only make
it if you put it in front of them.

**Say what has to be kept either way.** The audit's other half is that the periphery is what
paid: adversarial review and the discriminator caught real defects that would otherwise have
shipped. The fix lane keeps both by construction, which is the whole reason it exists — the
recommendation used to end by handing the work back, so the two-thirds that pays got rebuilt
by hand or quietly skipped. If you do send the user to a direct session instead, say the rest
of it: write it directly, then dispatch a fresh `vf-agentics:reviewer` over the diff, and where
the change is a fix, write the test that fails first.

**Anything you dispatch yourself — that reviewer, or any agent outside the workflow — is paid for
by the turn.**

<!-- vfa:verbatim dispatch-economy -->
A dispatch costs context × turns, and every agent pays its own. Tool calls are what make turns;
parallel agents share only the system prompt, so a prompt body handed to four agents is paid four
times; and what an agent returns is re-read on every later turn of the session that dispatched
it.

- Grant tools only where the charge needs the tree. A question answerable from what you hand over
  goes to an agent without tools and comes back in one turn.
- Resolve evidence several agents need once — by script wherever that is deterministic — and hand
  each agent the excerpts inline: never a path to go and read, never a whole source file.
- Prefer fewer agents with disjoint charges. Split by head only where independence is the point,
  and say that it is.
- Ask for a typed return on a fixed shape. Narrative is context you pay for until the session
  ends.
- To check a change, re-dispatch narrowed to what changed and name the narrowing in coverage.
  Never re-run the whole pass.
<!-- /vfa:verbatim -->

**Declining is a recommendation, never a refusal.** The user's "run it anyway" is the end of
the conversation, not the start of a second round of it — proceed to step 1 and say nothing
further about cost. A skill that argues twice has turned advice into a gate, and the IRON LAW
does not have a cost exception for the pipeline's own opinion of the work.

**And do not reach for it where it does not fit.** Several loci, an unsettled approach, a
contract other code depends on, anything with independent pieces, or a change the user wants
reviewed adversarially — all of those are what this pipeline is for. A triage that declines
those is not saving money, it is declining the work. When the three properties do not all
hold, say nothing and start the run.

### The fix lane

`lane: 'fix'` is the pipeline with the two phases the triage just proved unnecessary taken
out. It is a lane inside the same run, not a different tool: the worktree, the check runner,
the review loop, the ledger, the resume verdict and the collector are all unchanged, so a fix
lane run resumes after a session limit exactly like any other and is swept by the same
`lib/gc.mjs` afterwards.

    lane: 'fix', locus: ['src/camera.ts'], regression: true

- **`locus` is required and the lane refuses without it.** What licenses skipping the survey
  is that you have already decided which files this is about — that is the judgment a survey
  would have been bought to make. The run refuses at input rather than asking a planner to
  guess a fence the coder may not widen. Pass the files; the planner confirms them against the
  repository and widens them if you were short, which is free at plan time and expensive
  later.
- **`regression: true` buys one history search.** Pass it when the change is "this used to
  work". A regression has a commit where the behaviour was right and one where it stopped
  being, and finding it is usually cheaper than re-deriving the intent from the tree. Leave it
  off for an ordinary fix — there is no such commit to find, and the search would report that
  at the price of a dispatch.

What it costs: plan, code, verify, review, merge, plus the history search if you asked for one
— against the ten to twelve a red/green behaviour costs through the full ladder, and with no
400–500k-token survey in front of it.

What it does **not** drop: the discriminator still proves the test fails without the fix, the
adversarial reviewer still attacks the series, the mechanical checks still run whole — build,
typecheck, suite, commit series — and the integration review still reads the merged head. Those
are the parts the field audit found were paying for themselves.

One dispatch it keeps that it could have dropped: the planner, at low effort and on sonnet,
charged to write one order rather than to decompose anything. It is the only place the run
directory, the plan envelope and the digest manifest are written, and a lane with no resume
point pays for itself twice the first time a session limit lands mid-run.

**Where not to use it.** Anything with several loci, an unsettled approach, a contract other
work builds against, or independent pieces worth running side by side. If the planner comes
back saying the change cannot honestly be one order, it says so in `blocking_gaps` and returns
the order anyway — that is your cue to consider re-running on the full lane, and it is your
call rather than the planner's.

**`coverage.from_kb` says the lane ran**, that nothing was searched, and which locus was
declared. Present it with the result: a run whose ground was named by the caller is a
different claim from one whose ground was surveyed, and the user is entitled to know which
they have.

### The two properties the run can use

The triage asks these questions whether or not it declines, and two of its answers are worth
carrying into the run rather than throwing away — they are what lets the workflow decide
whether the survey phase is earned at all (the **null survey**).

- **`settled_shape: true`** — pass it when the second property held: the approach is decided,
  and nothing about *how* to do this is something the change has to go and discover. This is a
  judgment and it stays yours; no arithmetic in the workflow can make it, and the workflow
  never infers it. Withholding it costs a survey and nothing else, so when you are unsure, do
  not pass it.
- **`ground: ['src/…', …]`** — pass the paths the first property established. This is not a
  new judgment: you already had to know the locus to answer the triage question. It is what
  makes the other half computable.
- **`effort: '<slug>'`** — pass it whenever this change belongs to an effort, which a design
  hand-off always does. With `settled_shape: true` beside it, the run checks whether the survey
  the design pass recorded still stands, and uses it instead of buying a second one. The check is
  the program's; you only name the effort.

**When the change came from a design document, do not re-derive either of them.** If the
document carries a `ground` marker, read it out rather than retyping it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/programme.mjs" --section ground --file <the design document>
```

One path per line, and they go straight into `ground`. A document with no such marker named no
ground — that is a fact about the design, not a failure, and you answer the triage question
yourself as you always did.

A design document may also carry a paragraph recommending **direct session**, **fix lane** or
**full lane**. Read it as advice from the pass that interviewed the user, weigh it, and say what
you concluded. **It does not decide anything**: the triage below is still the decision point and
the user is still asked once, here. A design that could pre-decide the lane would make the fix
lane's own coverage block false — it states that nothing was searched by this run and nothing
recalled from the knowledge base, and a design survey that supplied the locus makes that untrue.

What the workflow then does with them is arithmetic you do not have to reproduce: it reads one
knowledge-base chain over the named paths and **skips the survey only if every one of them is
covered by a fresh entry** — one a program checked against the current tree and found untouched
since it was observed. A stale entry is a lead, not evidence, so a stale chain refuses; so does
one uncovered path among several; so does a chain it could not read. Every refusal surveys in
full and says which path and why.

When it does fire, the result says so where a survey's coverage would have been:
`coverage.from_kb` names that no survey ran, that nothing was re-searched, which paths the
chain covered and at which commits. **Present that to the user with the result** — a run whose
evidence was recalled rather than searched is a different claim from one whose evidence was
gathered today, and they are entitled to know which one they have.

## Where this run is recorded

<!-- vfa:verbatim effort-store -->
**Efforts — one directory for everything this piece of work produces.** A change moves through
design, survey, probe and one or more runs, and each phase used to write its output somewhere
different or nowhere at all. A survey's findings and a probe's findings went nowhere: the only
record of a probe was a harness temp file, session-scoped and swept. Since design and develop
are separate sessions by recommendation, everything the first learned that did not reach the
document was gone before the second opened.

Open one at the start. The user may name it; if they do not, derive the name and use it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" slug "<the change or question, in the user's words>"
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" open <repo> <slug> --about "<the change or question>" --roots <roots>
```

Opening is idempotent, and a later phase of the same effort adopts the identity the first one
recorded rather than restating it in its own words.

Record a survey's or a probe's return by writing the workflow's result object to a file and
passing the path — **verbatim, never summarised.** The point of the store is what the phase
actually returned, and a command line is finite while a survey's return is as large as the
survey was interesting:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" record <repo> <slug> survey|probe --file <path.json>
```

Link a run and the design document as each comes into being. These are **pointers**: run state
stays at `.claude/vfa/runs/<runstamp>/` where every other part of this pipeline reads and writes
it, and a design stays in the source tree, because it is source:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" link <repo> <slug> run --value <runstamp>
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" link <repo> <slug> design --value <path>
```

Read it back when a later phase opens on the same effort, and pass what it holds as `prior`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/effort.mjs" read <repo> <slug> --latest survey
```

**Read back as `prior`, a stored return is context, never evidence.** Passed as `prior` it
reaches a survey's planner alone, where it can only change how the ground is decomposed — it
never fills `ground`, never reaches the knowledge base's null-survey gate, and never answers the
triage's settled-shape question. That gate reads one field, an entry's computed freshness, and no
provenance, so anything that reached it would be admitted with no grading at all.

**One computed exception: a survey that still stands.** Recording a survey anchors it to the
commit it was taken at and the ground its topics searched. `effort.mjs standing <repo> <slug>`
then answers from git whether that survey reported complete coverage and whether any commit or
uncommitted edit has reached its ground since. Hand `develop` the effort's name as `effort`,
beside `settled_shape: true`, and the run asks that question itself: a standing survey is used
instead of buying a second one, and one that does not stand is bought again in full. The session
never decides that a survey stands; the program does.
<!-- /vfa:verbatim -->

Pass what `read` returns as the workflow's `prior` argument, and link the runstamp as
soon as the launch result carries one — a run linked at the end is a run nobody can find
if the session dies in the middle.

## Run the pipeline

1. Confirm the tree is a git repo and note the current branch and HEAD. If the working tree
   is dirty, tell the user what is uncommitted and get an explicit go/no-go before any
   workflow runs.

   **Ensure `.claude/vfa/` is gitignored, once.** The run's plan and its wave-by-wave state
   are written there, and they are scaffolding rather than source. Add the line yourself if
   it is missing — an agent adding it would be a tree mutation, and no agent in this pipeline
   is allowed one. `.claude/worktrees/` wants the same treatment.

2. Invoke the workflow — the name is plugin-namespaced; the bare `vfa-develop` does not
   resolve:

   ```
   Workflow({ name: 'vf-agentics:vfa-develop', args: { change, roots, notes, prior, intelligence, plugin_root, base_ref, programme, slice, settled_shape, ground, effort } })
   ```

   `plugin_root` is this plugin's absolute root (`${CLAUDE_PLUGIN_ROOT}`); the workflow
   interpolates it into the planner and verifier prompts so those agents can reach `lib/`
   while their own cwd is the target repo. Passing it is not optional — without it, those
   agents halt rather than measure the wrong tree.

   **Record the `runId` from the launch result now.** The script cannot read its own run
   id (its `coverage.resumable.runId` says exactly that), so the id you record here is
   the only handle that pairs with `resumable.remaining` when escalated work needs
   resuming.

   The workflow runs **every wave of the partition** in this one invocation. It creates its
   own integration worktree under `.claude/worktrees/`, merges each wave's approved orders
   into it, and verifies the merged head before the next wave branches from it. It still
   never touches the branch or the working tree the user is sitting in — advancing those is
   your act, at step 3d, after the human gate.

2-bis. **Keep a todo list of the orders, and derive it — never maintain it.** A twelve-order
   run is a long silence with agent labels scrolling past it. Two things answer "how much is
   left", and they cover different moments:

   - **While it runs**, the workflow narrates its own ledger: the whole order list before the
     first dispatch, a line at each wave's start and settle, and the list again at every wave
     close, with each order filed under merged / approved / escalated / blocked / not started.
     That is live and costs this session nothing. Point the user at it instead of polling.
   - **Whenever this session is awake** — on return, and any time the user asks where things
     stand — derive the list and write it to your todo list:

     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/lib/run-status.mjs" <repo-root> --run <runstamp>
     ```

     It prints `{run, orders, counts}`. `orders` is one row per work order — `{id, wave,
     stage}` — recomputed from `state.jsonl` and `journal.jsonl` on every call. Write **one
     todo per order**, its content naming the order and its wave, its status read off the
     stage:

     | stage | todo status | what the record actually says |
     |---|---|---|
     | `merged` | completed | it is in the integration branch |
     | `approved` | completed | review closed; only the merge is left |
     | `reviewed`, `measured`, `implemented` | in_progress | a stage recorded it; more to run |
     | `escalated` | pending | it needs a person, and the escalation says why |
     | `pending` | pending | not dispatched, running, or blocked — the record cannot tell |
     | `coupled` | pending | routed to you; the pipeline never ran it |

     **`measured` means a measurement is on record, not that it was green.** Say "a
     measurement is on record for W2", never "W2 is verified" — the same care
     `/vf-agentics:runs` takes with `measured_unapproved`, and for the same reason: whether it
     was green is derived on resume against the order's role, and this listing does not repeat
     that computation.

   **The list is a view, not a ledger.** Refresh it from the CLI; never move an item because
   you believe something has happened. Going stale between refreshes is fine and expected. The
   list disagreeing with `state.jsonl` is not, and hand-editing is the only route to it —
   `## Afterwards` forbids the hand-maintained kind for exactly this reason.

   **A fresh run has nothing to seed from at launch**, because planning happens inside the
   workflow; the first refresh that can say anything is after it returns, or one the user asks
   for mid-run. **A resume does** — its plan is already on disk — so seed the list before you
   launch. The runstamp comes back in `result.plan_path`; before that, the same CLI with no
   `--run` lists every run and its runstamp.

3. On return, first check `checkpoint`. When it is non-null, **nothing was dispatched** —
   and `checkpoint.reason` says why. Branch on it; the cases want different
   conversations, and treating them alike either asks the human to rule on an empty list or
   parks work they meant to have built.

   - **`existing_run`** — the workflow found a `planned` or `in-flight` run already
     recording this exact change and refused to plan it twice.
     `checkpoint.existing_run` names the run (runstamp, path, status) and
     `checkpoint.resume_path` is ready to pass back. This is almost always a resume you
     meant to make: re-invoke with that `resume_path`. If a second, parallel run of the
     same change is genuinely intended — it almost never is — re-invoke with
     `confirmed_duplicate: true`. Never work around this checkpoint by rewording the
     change: implementing one description's plan under another is the wrong-run failure
     the change comparison exists to catch.

   - **`blocking_gaps`** — the survey could not reach evidence the change description itself
     names, and the planner flagged it. Present `checkpoint.blocking_gaps`. On a go,
     re-invoke with `resume_path: checkpoint.resume_path` and `confirmed_gaps: true` — the
     plan is already on disk, so the confirmation is a path and a bit rather than a 55KB
     payload you retype. On a no-go, stop; the plan in the result is the deliverable.
   - **`plan_only`** — the user asked to park. Present the plan: the orders, their wave
     layout, and what implementing it would involve. Say plainly that nothing was built and
     that `resume_path` is how it gets picked up later. Do not offer to start implementing
     unless the user asks — they said plan.
   - **`stale`** — a resumed run found the user's tree moved under its plan. Step 3f.

   In every case: **do not implement anything yourself on this path.** And
   `checkpoint.resume_path` being empty means the planner could not persist the plan. Say so
   plainly — a re-invocation then has to plan again from scratch, and the human should know
   that before deciding.

   Otherwise walk the result IN THIS ORDER — escalations first, never last:

   a. **Escalations.** Present each (id, reason, unresolved criticals, trail tail) to the
      human. These are decisions, not information — do not resolve them yourself.

      `reason: 'carried_forward'` is the one that is not a fresh decision: an earlier
      invocation escalated that order and this one declined to re-buy it. Say so, name the
      wave it came from, and offer `retry_escalated` rather than presenting it as a failure
      this run observed. Its trail is empty because the original findings were never written
      to disk — do not fill that silence with a guess at what went wrong.

   a-bis. **Role-bearing orders.** The planner may split a behaviour into the
      red-green-refactor cycle: a `red` order landing failing tests, a `green` order making
      them pass, and optionally a `refactor` order restructuring afterwards. Each is verified
      by a different standard — a red order is *required* to fail its tests — so when
      reporting, say which role an order carried. "The tests fail" reads as a defect against
      an ordinary order and as success against a red one, and a report that omits the role
      makes those indistinguishable.

      A wave whose merged head fails only on tests belonging to a landed red order whose
      green has not landed yet is **not** a broken wave; the run says so in `wave_verify` and
      continues. Do not present that as a failure.

   b. **Blocked orders.** `blocked` is `[{id, blocked_by}]`: orders never dispatched because
      an order they depend on did not land, with `blocked_by` naming the escalated root
      rather than the nearest link in the chain. **Do not re-invoke the workflow for a
      blocked order while the escalation naming it is still open.** Its provider does not
      exist in the tree, so a fresh coder would build against thin air and every verifier
      would find a repository missing the thing it was told to use — that is the exact field
      failure (seven orders escalating over a toolchain that never landed) this bucket exists
      to prevent. Resolve the escalation with the human first; a blocked order becomes
      resumable work only once its provider has landed.

   c. **Coupled orders.** Each `coupled` entry carries the full order body — id, title,
      locus, acceptance, context, deps, contract — so nothing needs joining back up by
      hand. Honor `deps` (implement providers before their consumers) and, for an order
      with `contract: true`, hold majors open the way criticals are held below. Implement
      each in this session, yourself, under the coder's commit
      discipline (focused single-concern commits, locus honored). **Before dispatching the
      verifier, create a throwaway worktree at the pre-change SHA and point it there —
      never the tree the user is sitting in.** The verifier's discriminator stashes,
      checks out the base SHA, and force-checks-out back; run that against the user's live
      working tree and it wrecks their uncommitted work. The plugin's design forbids this
      outright, and no other runtime file says so, so it is stated here rather than assumed.
      Then drive the SAME review contract via the Agent tool — `vf-agentics:verifier` for
      facts, then fresh `vf-agentics:reviewer` rounds — under the review loop's exit and
      escalation conditions. The block below is a verbatim copy of that contract, whose
      canonical copy is the plugin's `docs/DESIGN.md#the-review-loop`, and
      `test/verbatim-blocks.test.mjs` diffs the two — a paraphrase down to "zero criticals →
      approved" would reopen a hole the contract explicitly closes:

      <!-- vfa:verbatim review-loop-exit -->
- Dispatch a fresh reviewer each round with the work order, the worktree path, the span
  under review, the coder's `concerns`, the advisory `series_findings`, and — from round
  2 on — the prior round's open blockers (id, claim, fix commits since). Round 1 reviews
  the whole series; later rounds rule on the open blockers and review the fix span alone —
  the merged change is reviewed whole again at integration.
- The blocking set is the round's criticals, plus its majors when the order is marked
  `contract: true` and the finding carries a non-empty `failure_scenario` — a major that
  cannot name what goes wrong for whom is advisory, not blocking.
- The open set is the round's blocking findings, plus every prior blocker ruled
  `not_fixed`/`regressed` in `fix_verdicts` that the round did not re-report. Never
  narrow this to the round's criticals alone — that exact narrowing once shipped an
  order with a known-unfixed critical and `coverage.complete: true`.
- The order is approved when the open set is empty. That is a count you compute — the
  reviewer has no approval to give, by design.
- Escalate (computed, never judged) when (a) a fix round returns no commits, or status
  `blocked`/`needs_context`, or (b) the same finding id is ruled `not_fixed`/`regressed`
  in two consecutive rounds, or (c) two consecutive rounds each rule every prior blocker
  fixed and still mint new blocking findings — the fixes are landing, the reviewer pool is
  not converging, and another round buys another sample rather than a resolution.
- Otherwise dispatch a same-worktree coder fix round carrying the open set (new focused
  commits, no amends, no rebase), re-verify, and dispatch a fresh reviewer.
- No round counter ends this loop (IRON LAW §1). A budget error is caught and becomes an
  escalation carrying resumable state (IRON LAW §6) — never a silent stop.
<!-- /vfa:verbatim -->

   d. **The integration branch.** Read `result.integration` before you touch anything:

      - `merged` — the orders that landed, in merge order. `head_sha` is where they landed.
      - `merge_stopped_at` — non-null means the merge run stopped at that order. The loci in
        a wave were declared pairwise disjoint, so a conflict there is a **planner defect**:
        surface it with the conflicting paths, never resolve it silently.
      - `approved_unmerged` — orders that passed review and never made it in, because the
        merge run stopped before them. They still have branches; nothing was lost, and a
        resumed run merges them as they stand once git confirms the branch is still at the
        reviewed head. **Do not merge one by hand** to "help": that makes it read as landed
        while skipping the wave verification that measures the combination.
      - `wave_verify` — the build and suite facts at the merged head, per wave. A `failed`
        entry is a defect in the *combination* that no single order's own verification could
        have caught.
      - `review.findings` — the integration review, run inside the workflow over the whole
        merged diff. Criticals here go to the human with the trail. **Do not open a fix loop
        for them without the human's say** — an integration critical usually means two orders
        disagree, and which one is wrong is a design decision, not a coding one.

      Then, and only with an explicit go/no-go from the human — the same gate you used for a
      dirty tree at step 1, and **never while an escalation is open** — merge once:

      ```bash
      git merge --no-ff <result.integration.branch>
      ```

      **Superseded inside a programme.** When this run is one slice of a programme, the merge
      below is not the merge that happens, and the block that says so is pinned in both skills:

      <!-- vfa:verbatim programme-merge-target -->
      In a programme run, develop step 3d's merge target is the programme branch, in the
      programme worktree, performed by the programme skill without a per-slice ask; its
      dirty-tree and no-open-escalation guards apply unchanged; the user-branch merge it
      describes happens once, at landing.
      <!-- /vfa:verbatim -->

      The reason the ask does not fire per slice is that the question the user wants asked is
      about *their* branch, and the programme branch is not their branch. Merging a reviewed
      slice into a branch the layer owns is hygiene.

      One branch, one merge, on the user's branch, by you. That is the only point in this
      pipeline where the user's tree moves, and it is deliberately the last thing that
      happens. If that merge conflicts, stop and surface it: the integration branch was built
      from the user's HEAD, so a conflict means the tree moved underneath the run.

   e. **Deferred waves.** `deferred` is non-empty when the line stopped — a merge that did
      not complete, a merged head that failed verification, or a caller-requested pause. Fix
      what stopped it with the human, then re-invoke `vf-agentics:vfa-develop` with
      `change`, `plugin_root` and `resume_path: result.plan_path`.

      `roots`, `notes` and `intelligence` come back off disk with the plan — they were
      recorded in its envelope when it was written, and the workflow adopts them. Pass one
      only to deliberately override it; the run will log that you did. `change` is still
      required: the workflow guards on it before it looks at anything else, and it is
      compared against the recorded change so that resuming the wrong run halts instead of
      implementing one change's plan under another's description.

      The resumed run reads the plan and the state back off disk, skips the orders already
      merged, re-attaches to the same integration branch, and carries on. It pays for no
      survey and no planning. Repeat from step 3. **Accumulate, don't replace:** each
      iteration's escalations, blocked, coupled and still-deferred ids join the running
      totals, so the final report covers every order from every pass.

      **It also salvages, by stage.** Order branches are named `vfa/<runstamp>-<order-id>`,
      which is what makes an interrupted invocation's work findable rather than merely present.
      Before dispatching anything, a resumed run pairs what the run recorded against what git
      holds, and takes each order as far as the two agree:

      | what the record and git agree on | what the resume does |
      |---|---|
      | the branch is already in the integration branch, and the run recorded it approved or merged | records the merge; nothing is rebuilt |
      | approved, and the branch is still at the reviewed head | merges it as it stands — no coder, no verifier, no second review |
      | measured green in the journal, and the branch is still at that head | adopts the commits and goes straight to review |
      | commits on the branch, no stage recorded | adopts them, then verifies and reviews in full |
      | nothing on the branch | dispatches a coder |

      A stage is adopted only where **both** sources say so: the run recorded that it closed,
      and git still holds the head it closed over. A branch that moved since is a branch nobody
      finished, so everything past the last agreed stage is redone. Rebuilding from scratch is
      the bottom of that ladder, not the top.

      Report salvage whenever it happens, and say which kind. A run that says "implemented W4"
      about work it adopted rather than did is describing work it did not do — the result marks
      those entries `review.salvaged`, with `rounds: 0`, precisely so the two are tellable
      apart.

      **Records are written by whoever did the thing.** A verifier appends its measurements to
      the run's `journal.jsonl` inside the dispatch that measured; the agent that performs a
      merge appends the merge inside the dispatch that merged; a coder appends the fact that
      its series is finished. `state.jsonl` keeps what the workflow itself decided — an order's
      approval the moment its review closes, an escalation the moment it happens, and each
      wave's outcome when it ends. The split has a scar behind it: every record used to be
      written by a separate courier dispatched afterwards, and a usage limit killed the courier
      for a wave whose merges had already happened, so the work was in the branch and nothing
      on disk named it.

      That is why a limit landing mid-wave now costs at most the stage in flight rather than
      the wave. Nothing an agent writes is a verdict — the facts are re-derived on resume by
      the same computation that judged them the first time — so a journalled line can never
      wave through work that was not actually measured.

      **Every append goes through `lib/ledger.mjs`,** which parses the line, checks it against
      the digest its caller minted, and refuses what does not match. A run in the field once
      wrote five unreadable records because an agent un-escaped some Windows paths while typing
      the append command; a refused line costs one retry, an unreadable one costs the next
      invocation a re-measurement it cannot see it needs.

      **A resume resumes each order at its next undone action,** never earlier. The lifecycle is
      `code → verify → review → merge`, the records say which steps closed, git says whether the
      commits they closed over are still there, and `lib/run-verdict.mjs` names the one action
      that comes next. Committed work is salvageable by right — commits live on the branch, so
      a pruned worktree loses nothing — while uncommitted changes are reported as a fact and
      adopted by nobody automatically. A series whose coder never recorded finishing is
      *continued* from its last commit rather than measured as if complete.

      **Escalations carry forward.** An order an earlier invocation escalated is not silently
      dispatched again: it comes back in `escalations` with `reason: 'carried_forward'`, and
      its consumers block behind it as usual. Re-invoke with
      `retry_escalated: [<ids>]` for the ones whose cause has been dealt with — those get the
      full ladder, so whatever partial work sits on their branches is still salvaged. The
      findings behind the original escalation were never durable, only the ids: point the human
      at the earlier invocation's report rather than inventing a cause.

      If `result.plan_path` is empty the run was never persisted and there is nothing to
      resume from; say so, and treat a re-run as a fresh plan.

   f. **Stale orders** (`checkpoint.reason === 'stale'`). A run starting from a plan on disk
      compares the user's branch against the commit the plan was written for. Nothing was
      dispatched and no worktree was created.

      `checkpoint.stale` is `[{id, writes, reads}]`, and the split is the useful part:
      `writes` are files the order *owns* that moved, `reads` are files it *builds against*
      that moved. Present both, because they usually call for different rulings — an order
      whose own files moved often just needs its diff rebasing, while an order whose
      dependency moved may be describing an approach that no longer exists, and no rebase
      fixes that.

      Ask the human to rule per order. They have three answers and all three are legitimate:
      still valid, needs re-planning, or already done by whatever moved those files.

      Re-invoke with `confirmed_stale: [<ids ruled still valid>]`. Orders left out stay
      undispatched and come back named in `coverage.unreached`; their consumers block behind
      them, naming them as the root. If the ruling is that the plan no longer describes this
      repository, do not clear orders one at a time to force it through — plan afresh.

      **What this check sees is what the planner declared** — the files each order owns and
      the files it recorded building against. It is exact on both, and blind to a dependency
      the planner did not write down. So an empty `stale` list means "nothing the plan
      declared has moved", which is strong but is still not "the plan is definitely correct".
      Say that plainly when a run is old — `/vf-agentics:runs` shows plan age for exactly this
      reason — and treat a large drift with an empty `stale` list as a reason to re-read the
      plan rather than a clearance. A plan whose orders all declare an empty `reads` is the
      case to distrust most: either the work genuinely stands alone, or the planner did not
      record what it leans on.

      An unreachable anchor (deleted branch, rewritten history) holds the whole run instead
      of listing orders. That one is not negotiable per order: a plan whose anchor is gone is
      a plan to re-ratify.

## Reporting — binding

- You may not report success while `coverage.complete === false`. The gaps lead: name every
  escalated, blocked, coupled-unfinished, and deferred-unfinished order FIRST, then what
  landed.
- Verdicts you report are the computed ones (criticals count, verifyOk facts, mergeOk facts,
  coverage derivation). You never soften, recompute, or paraphrase them.
- Show the review evidence compactly: per order — commits, rounds, open majors. Majors are
  the human's decision queue, not noise to trim. Then the integration review's findings
  separately: they are about the change, not about any one order.
- **Surface every `HUMAN:` acceptance criterion, per order, verbatim, prefix included.** The
  planner writes these for criteria only a person can judge; the reviewer passes them through
  untouched instead of ruling on them. You are the terminal consumer — if you do not put them
  in front of the human, nothing does, and a criterion the plan deliberately routed to the
  gate is silently dropped instead of decided.

## Afterwards

- **Progress lives in derived state, never in a hand-maintained ledger.** A run's status is
  derived from `plan.json` and `state.jsonl` by `/vf-agentics:runs`; a programme's is derived
  from its event log by `/vf-agentics:programme`. A progress file the session maintains by
  hand duplicates both, is stale the moment either moves, and costs the most expensive tokens
  in the pipeline — the orchestrating session's — on every rewrite. In the field one such
  file's mid-run commit to the base branch was misattributed as a locus breach and killed a
  2.9-hour run. If the project keeps one anyway, it is the user's file: update it only after
  a run returns, never while one is in flight, and put nothing in it that `runs` or
  `programme` already derives.
- **Do not route `discovered` entries anywhere by hand.** The run deposits them itself, at its
  own end, into the project knowledge base at `.claude/vfa/kb/` — approved orders only, each
  entry anchored to the order's own locus and stamped with the run's base commit, so the next
  run in that ground opens with them instead of rediscovering them. A second parallel routing
  would put the same claims in two places with two different ideas of whether they are still
  true. The human-facing layer — `docs/codebase-notes.md`, `CLAUDE.md` — stays hand-curated and
  is not touched by any of this; if something the run learned belongs in front of a person,
  that is a judgment you make and write, not a copy you make.
- Clean up ONLY after the human accepts the merged result — the gate has not moved — and do it
  with the collector rather than by hand:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/lib/gc.mjs" <repo-root> <runstamp>
  ```

  **Run it from the checkout you merged into**, the one whose HEAD now contains the integration
  merge. That reference point is the whole safety: `git branch -d` refuses a branch that is not
  in HEAD, and asked from any other tree the same command answers confidently about the wrong
  one. The CLI checks the reference point first and refuses everything if it does not hold.

  It prunes the worktrees of merged branches, deletes those branches with `git branch -d`, and
  **reports what it kept and why** — unmerged branches, dirty worktrees, and with them the
  escalated and held orders that are the resumable state. Read that list out loud; a kept item
  is a fact about the run, not leftover litter. It touches nothing outside `vfa/<runstamp>-*`:
  the harness's own auto-named worktree branches are shared territory across plugins, and tags
  are left alone, since a tag pointing into a deleted branch is what keeps its commits
  reachable.
- Escalated and blocked orders keep their worktrees and branches — they are the resumable
  state, and the collector keeps them for you because neither ever reached HEAD. So does the
  run directory at `result.plan_path`: it is the only record of what this run decided and what
  it did, and it costs nothing to keep.
