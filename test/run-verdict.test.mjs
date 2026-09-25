// test/run-verdict.test.mjs — the resume verdict: which single action each order resumes at.
//
// This is the arithmetic that used to live inside the workflow script, reconstructed there from
// state lines, journal lines and a scavenge agent's report — every one of which had crossed a
// model to arrive. It now runs on disk, over the real files, which is what makes it testable
// here at all: the whole salvage ladder can be exercised without a repository and without a
// single agent.
//
// The two regimes it must keep apart:
//   CLEAN — an empty ledger and no branches means nothing is salvageable BY DEFINITION, and the
//           machinery must know that without going to look.
//   DIRTY — a stage is adopted exactly as far as two independent sources agree: the run recorded
//           that it closed, and git still holds the head it closed over.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIONS, deriveVerdict, measuredOf, nextActionFor, parseJournal, parseState, partitionOf,
  replay, verifyOk,
} from '../lib/run-verdict.mjs'
import { digestOrder } from '../lib/plan-digest.mjs'

const A40 = 'a'.repeat(40)
const B40 = 'b'.repeat(40)
const C40 = 'c'.repeat(40)
const M40 = 'e'.repeat(40)

const order = (id, over = {}) => ({
  id, title: 'do ' + id, role: 'none', locus: ['src/' + id + '.js'], reads: [],
  acceptance: ['builds'], context: 'ctx', deps: [], contract: false, ...over,
})

const plan = (orders, over = {}) => ({
  change: 'add the thing', roots: 'C:/repo', caller_notes: '', intelligence: 'normal',
  base_branch: 'master', base_sha: A40, programme: '', slice: '',
  work_orders: orders,
  partition_raw: JSON.stringify({ waves: [orders.map((o) => o.id)], coupled: [] }),
  blocking_gaps: [], plan_path: 'C:/repo/.claude/agentics/runs/20260826-184728',
  ...over,
})

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n')

const branchRow = (id, over = {}) => ({
  branch: 'agentics/20260826-184728-' + id,
  head_sha: C40, base_sha: M40,
  commits: [{ sha: C40, subject: 'feat: ' + id }],
  worktree: 'C:/wt/' + id, dirty: [], already_merged: false, ...over,
})

const git = (rows = {}, over = {}) => ({
  clean: false, branches: rows,
  integration_branch: 'agentics/20260826-184728-integration', integration_head: M40, ...over,
})

const NO_GIT = { clean: true, branches: {} }

const waveLine = (over = {}) => ({
  kind: 'wave', seq: 1, wave: 1, merged: [], approved_unmerged: [], escalated: [],
  discovered: [], integration_base: A40, integration_head: M40,
  order: '', branch: '', worktree: '', head_sha: '', measured: [], ...over,
})

const stageLine = (kind, over = {}) => ({
  kind, seq: 2, wave: 1, merged: [], approved_unmerged: [], escalated: [], discovered: [],
  integration_base: '', integration_head: '',
  order: 'W1', branch: 'agentics/20260826-184728-W1', worktree: 'C:/wt/W1',
  head_sha: C40, measured: ['build', 'suite'], ...over,
})

const verifyObserved = (over = {}) => ({
  kind: 'verify-observed', seq: 3, order: 'W1', branch: 'agentics/20260826-184728-W1',
  worktree: 'C:/wt/W1', base_sha: M40, head_sha: C40, stop_reason: 'completed',
  build: 'passed', typecheck: 'passed', suite: 'passed', failing_tests: [],
  discriminator: [{ test_id: 't', failed_on_base: true, passes_now: true }],
  series_findings: [], ...over,
})

/** The action one order resumes at, for the ordinary single-order fixture. */
const actionFor = (id, { state = [], journal = [], branches = {}, orders = [order('W1')] } = {}) => {
  const v = deriveVerdict('20260826-184728', plan(orders), jsonl(state), jsonl(journal),
    Object.keys(branches).length ? git(branches) : NO_GIT, [])
  return v.orders.find((o) => o.id === id)
}

// --- the clean regime -----------------------------------------------------------------------

test('an empty ledger with no branches is clean, and every order is code', () => {
  const v = deriveVerdict('20260826-184728', plan([order('W1'), order('W2')]), '', '', NO_GIT, [])

  assert.equal(v.clean, true)
  assert.deepEqual(v.orders.map((o) => o.next_action), ['code', 'code'])
  assert.match(v.orders[0].stage_note, /nothing on disk/)
})

test('a clean run still carries its envelope, waves and digests', () => {
  // The fast path must be fast, not thin: a parked plan resumed under it has to arrive with
  // everything the run was planned under, or it is a different run wearing the same id.
  const orders = [order('W1'), order('W2', { deps: ['W1'] })]
  const v = deriveVerdict('20260826-184728',
    plan(orders, { partition_raw: JSON.stringify({ waves: [['W1'], ['W2']], coupled: [] }) }),
    '', '', NO_GIT, [])

  assert.deepEqual(v.partition.waves, [['W1'], ['W2']])
  assert.equal(v.envelope.change, 'add the thing')
  assert.equal(v.envelope.base_sha, A40)
  assert.equal(v.orders[1].digest, digestOrder(orders[1]))
  assert.deepEqual(v.orders[1].deps, ['W1'])
})

// Both of the planner's per-order dials, and they fail the same silent way when one is missing:
// `weightOf` normalizes an absent value to `standard`, so a resumed run simply stops discounting
// and nothing anywhere reads wrong. Run 20260902-124933 coded `assetpaths` at sonnet on its
// fresh dispatch and at the run's ceiling on the resume, from this omission alone.
test('the per-order dials travel: a light order resumes light, not standard', () => {
  const orders = [order('W1', { weight: 'light' }), order('W2', { weight: 'heavy' }),
    order('W3', { role: 'red' })]
  const v = deriveVerdict('20260826-184728', plan(orders), '', '', NO_GIT, [])

  assert.deepEqual(v.orders.map((o) => o.weight), ['light', 'heavy', 'standard'])
  assert.deepEqual(v.orders.map((o) => o.role), ['none', 'none', 'red'])
})

test('a plan written before weight existed resumes standard rather than crashing', () => {
  const naked = order('W1')
  delete naked.weight
  const v = deriveVerdict('20260826-184728', plan([naked]), '', '', NO_GIT, [])

  assert.equal(v.orders[0].weight, 'standard')
})

test('the settled evidence is described, never carried', () => {
  // It is the largest string in the envelope and every consumer of it is an agent with a shell.
  // Carrying it through a courier bought nothing but a chance to paraphrase it.
  const v = deriveVerdict('20260826-184728',
    plan([order('W1')], { caller_notes: 'x'.repeat(4000) }), '', '', NO_GIT, [])

  assert.equal(v.envelope.caller_notes_len, 4000)
  assert.match(v.envelope.caller_notes_digest, /^[0-9a-f]{8}$/)
  assert.equal(v.envelope.caller_notes, undefined)
  assert.ok(JSON.stringify(v).length < 2000, 'the payload stays the size of a skeleton')
})

test('the plan prose that nothing reads does not travel', () => {
  // `notes` and `shared_files` rode every resume and were never read on that path. Transcription
  // fidelity falls off with payload length, so a field that travels has to earn it.
  const v = deriveVerdict('20260826-184728',
    plan([order('W1')], { notes: 'y'.repeat(9000), shared_files: ['a.js'] }), '', '', NO_GIT, [])

  assert.equal(v.plan.notes, undefined)
  assert.equal(v.plan.shared_files, undefined)
  assert.deepEqual(v.plan.blocking_gaps, [])
})

// --- the ladder, rung by rung ---------------------------------------------------------------

test('an order the log says merged is done, and is not re-examined', () => {
  const row = actionFor('W1', { state: [waveLine({ merged: ['W1'] })] })

  assert.equal(row.next_action, 'none')
  assert.equal(row.merged_source, 'log', 'the log already records it; no corrective line is owed')
  assert.match(row.stage_note, /merged by an earlier invocation/)
})

test('merged_source is a typed field, not a phrase the caller has to recognise', () => {
  // The caller writes a corrective wave line for a merge only git knows about, and keys that
  // write on this field. An earlier draft sniffed a prefix of `stage_note` instead, which made
  // a durable write depend on the wording of a sentence written for a human — and the note is
  // free to be reworded, which is exactly what would have made reconciled merges stop being
  // recorded with nothing failing.
  const fromGit = actionFor('W1', {
    state: [stageLine('order-approved')],
    branches: { W1: branchRow('W1', { already_merged: true }) },
  })
  const notMerged = actionFor('W1', { branches: { W1: branchRow('W1') } })

  assert.equal(fromGit.merged_source, 'git')
  assert.equal(notMerged.merged_source, '', 'an unmerged order names no merge source')
})

test('an approval git still corroborates is merged as it stands', () => {
  const row = actionFor('W1', {
    state: [stageLine('order-approved')],
    branches: { W1: branchRow('W1') },
  })

  assert.equal(row.next_action, 'merge')
  assert.deepEqual(row.measured, ['build', 'suite'])
})

test('an approval whose branch has moved since is redone, not trusted', () => {
  // Not a problem — just a branch that moved after the stage closed, so the stage is redone
  // over what is actually there now.
  const row = actionFor('W1', {
    state: [stageLine('order-approved', { head_sha: B40 })],
    branches: { W1: branchRow('W1', { head_sha: C40 }) },
  })

  assert.equal(row.next_action, 'verify')
})

test('a measurement green at this exact head sends the order straight to review', () => {
  const row = actionFor('W1', {
    journal: [verifyObserved()],
    branches: { W1: branchRow('W1') },
  })

  assert.equal(row.next_action, 'review')
  assert.equal(row.verified_source, 'journal')
})

test('a measurement at a head git no longer holds is measured again', () => {
  const row = actionFor('W1', {
    journal: [verifyObserved({ head_sha: B40 })],
    branches: { W1: branchRow('W1', { head_sha: C40 }) },
  })

  assert.equal(row.next_action, 'verify')
})

test('commits with no record at all are verified, never rebuilt', () => {
  const row = actionFor('W1', { branches: { W1: branchRow('W1') } })

  assert.equal(row.next_action, 'verify')
  assert.deepEqual(row.commits.map((c) => c.sha), [C40])
})

test('a branch with no commits holds nothing to adopt', () => {
  // A coder cuts its branch AT the integration head, so a branch whose coder died before its
  // first commit exists and is empty. There is nothing there to resume from.
  const row = actionFor('W1', { branches: { W1: branchRow('W1', { commits: [] }) } })

  assert.equal(row.next_action, 'code')
})

// --- continue-series, and why absence has to mean something ---------------------------------

test('a series no coder reported finishing is carried on, not measured as complete', () => {
  const row = actionFor('W1', {
    orders: [order('W1'), order('W2')],
    // Some order in this run DID record a completion, so this run speaks the dialect and the
    // absence of one for W1 is evidence rather than silence.
    journal: [{ kind: 'coder-done', seq: 5, order: 'W2', head_sha: B40, commits: [] }],
    branches: { W1: branchRow('W1') },
  })

  assert.equal(row.next_action, 'continue-series')
  assert.match(row.stage_note, /no coder ever reported finishing/)
})

test('a completed series is verified as it stands', () => {
  const row = actionFor('W1', {
    journal: [{ kind: 'coder-done', seq: 5, order: 'W1', head_sha: C40, commits: [] }],
    branches: { W1: branchRow('W1', { head_sha: C40 }) },
  })

  assert.equal(row.next_action, 'verify')
  assert.match(row.stage_note, /completed series/)
})

test('a run recorded before coder-done existed is measured, never "continued"', () => {
  // The regression this guards: every run planned before 0.17.0 has commits and no completion
  // line anywhere. Reading that absence as "the coder died mid-series" would dispatch a
  // continuation coder at every adopted series in every legacy run — a wasted round, and an
  // invitation to add commits nobody asked for.
  const row = actionFor('W1', {
    state: [waveLine()],
    branches: { W1: branchRow('W1') },
  })

  assert.equal(row.next_action, 'verify')
  assert.match(row.stage_note, /measured as they stand/)
})

// --- checkpoint tips: the one piece of positive evidence the ladder gets --------------------

test('a checkpoint tip is carried on even in a run that never spoke coder-done', () => {
  // The absence of a completion line says nothing on its own (the legacy case above). A
  // checkpoint says something: its author committed it to record that it stopped short. So it
  // does not wait on `speaksCoderDone`, which exists only to interpret silence.
  const row = actionFor('W1', {
    state: [waveLine()],
    branches: { W1: branchRow('W1', { checkpoint_head: true }) },
  })

  assert.equal(row.next_action, 'continue-series')
  assert.match(row.stage_note, /checkpoint/)
})

test('a checkpoint tip outranks a coder-done line for the same order', () => {
  // They contradict — one says finished, the other says stopped short — and a contradiction
  // resolves in the direction that cannot manufacture a false whole: carrying the series on
  // costs a coder round, measuring it as complete ships an unfinished series as a finished one.
  const row = actionFor('W1', {
    journal: [{ kind: 'coder-done', seq: 5, order: 'W1', head_sha: C40, commits: [] }],
    branches: { W1: branchRow('W1', { head_sha: C40, checkpoint_head: true }) },
  })

  assert.equal(row.next_action, 'continue-series')
})

test('an ordinary tip is unaffected, checkpoint machinery or not', () => {
  const row = actionFor('W1', {
    journal: [{ kind: 'coder-done', seq: 5, order: 'W1', head_sha: C40, commits: [] }],
    branches: { W1: branchRow('W1', { head_sha: C40, checkpoint_head: false }) },
  })

  assert.equal(row.next_action, 'verify')
})

test('a checkpoint tip does not resurrect an order that already merged', () => {
  // The rungs above it still win. A merged order is done, and a checkpoint somewhere in the
  // history it merged from is archaeology, not an action.
  const row = actionFor('W1', {
    state: [waveLine({ merged: ['W1'] })],
    branches: { W1: branchRow('W1', { checkpoint_head: true }) },
  })

  assert.equal(row.next_action, 'none')
})

test('uncommitted work is reported as a fact and adopted by nobody', () => {
  const row = actionFor('W1', {
    branches: { W1: branchRow('W1', { dirty: [' M src/w1.js', '?? scratch.txt'] }) },
  })

  assert.deepEqual(row.dirty, [' M src/w1.js', '?? scratch.txt'])
  assert.equal(row.next_action, 'verify', 'dirt does not change which action comes next')
})

// --- merged-in-git, and the second witness --------------------------------------------------

test('ancestry alone never lands an order — a witness is required', () => {
  // A coder cuts its branch at the integration head, so an EMPTY branch is an ancestor of the
  // integration branch too. That branch and a genuinely merged one report identically, and
  // marking the empty one merged would land an order nobody implemented — and write it into
  // the log for every future resume to believe.
  const row = actionFor('W1', {
    branches: { W1: branchRow('W1', { already_merged: true }) },
  })

  assert.notEqual(row.next_action, 'none')
})

test('an approval record at the merged head is the witness', () => {
  const row = actionFor('W1', {
    state: [stageLine('order-approved')],
    branches: { W1: branchRow('W1', { already_merged: true }) },
  })

  assert.equal(row.next_action, 'none')
  assert.match(row.stage_note, /already in the integration branch/)
})

test('a merge the merging agent journalled is the other witness', () => {
  // The two fail independently, which is the point of having both: the incident that motivated
  // the journal killed the recorder, so the run held merges whose only record would have been
  // the line that never got written.
  const row = actionFor('W1', {
    journal: [{ kind: 'merge-observed', seq: 4, order: 'W1',
                branch: 'agentics/20260826-184728-W1', head_sha: M40 }],
    branches: { W1: branchRow('W1', { already_merged: true }) },
  })

  assert.equal(row.next_action, 'none')
})

// --- escalations ----------------------------------------------------------------------------

test('an escalation is reported, and the underlying action is reported with it', () => {
  // Whether an escalation is retried is the caller's policy (`retry_escalated`). A lib that
  // decided it here would take that lever away from the human holding it — and the stage the
  // order actually reached has to survive, or the retry rebuilds instead of resuming.
  const row = actionFor('W1', {
    state: [waveLine({ escalated: ['W1'], seq: 7, wave: 2 })],
    branches: { W1: branchRow('W1') },
  })

  assert.equal(row.escalated, true)
  assert.equal(row.escalated_wave, 2)
  assert.equal(row.next_action, 'verify')
})

test('the escalation wave is the FIRST that named it and the seq is the LAST', () => {
  // Aggregated in opposite directions, deliberately. The wave answers "when did this escalate"
  // — last-wins would report a wave the order was never in. The seq answers "is this still the
  // newest word" — first-wins would let a retry's green clear a verdict just reached again.
  const r = replay([
    waveLine({ seq: 3, wave: 1, escalated: ['W1'] }),
    waveLine({ seq: 9, wave: 4, escalated: ['W1'] }),
  ], { entries: [], torn: 0 }, new Map([['W1', order('W1')]]))

  assert.equal(r.escalated.get('W1').wave, 1)
  assert.equal(r.escalated.get('W1').seq, 9)
})

test('an escalation recorded at the moment it happened survives a lost wave line', () => {
  // The gap this closes: a run killed mid-wave loses the wave line, and with it every
  // escalation the invocation reached — so the resume re-dispatches an order that already
  // defeated a coder, a verifier or a review loop, at full price.
  const row = actionFor('W1', {
    state: [{ kind: 'order-escalated', seq: 8, wave: 3, order: 'W1',
              reason: 'review_unconverged', merged: [], escalated: [], discovered: [] }],
  })

  assert.equal(row.escalated, true)
  assert.equal(row.escalated_wave, 3)
})

test('a success recorded after an escalation supersedes it', () => {
  const r = replay([
    waveLine({ seq: 3, escalated: ['W1'] }),
    stageLine('order-approved', { seq: 5 }),
  ], { entries: [], torn: 0 }, new Map([['W1', order('W1')]]))

  assert.equal(r.escalated.has('W1'), false)
})

test('a journalled green strictly later than an escalation clears it; a tie does not', () => {
  // Strictly greater. Equal means neither preceded the other — two lines written before the
  // counter existed both sit at 0 — and there the honest answer is that the log cannot say.
  const later = replay([waveLine({ seq: 3, escalated: ['W1'] })],
    parseJournal(jsonl([verifyObserved({ seq: 7 })])), new Map([['W1', order('W1')]]))
  assert.equal(later.escalated.has('W1'), false)

  const tied = replay([waveLine({ seq: 0, escalated: ['W1'] })],
    parseJournal(jsonl([verifyObserved({ seq: 0 })])), new Map([['W1', order('W1')]]))
  assert.equal(tied.escalated.has('W1'), true)
})

// --- the journal's own hazards ---------------------------------------------------------------

test('a torn line is skipped and counted, never fatal', () => {
  // Several agents append here and a kill can land mid-write, so a torn last line is the
  // expected shape of this file rather than corruption of the run.
  const parsed = parseJournal('{"kind":"merge-observed","seq":1,"order":"W1"}\n{"kind":"verify-ob')

  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.torn, 1)
})

test('a measurement that did not record everything is not read as green', () => {
  // Every field a predicate reaches for is missing in the PERMISSIVE direction: a series
  // finding with no `blocking` reads as clean, a discriminator with no `passes_now` reads as
  // validly red. What is MISSING must not be read as what is EMPTY.
  const noDiscriminator = verifyObserved()
  delete noDiscriminator.discriminator

  const row = actionFor('W1', {
    journal: [noDiscriminator],
    branches: { W1: branchRow('W1') },
  })

  assert.equal(row.next_action, 'verify', 'an incomplete line buys a re-measurement')
})

test('a blocking series finding missing its flag does not buy a pass', () => {
  const row = actionFor('W1', {
    journal: [verifyObserved({ series_findings: [{ sha: 'x', message: 'locus breach' }] })],
    branches: { W1: branchRow('W1') },
  })

  assert.equal(row.next_action, 'verify')
})

test('the verdict is DERIVED from the recorded facts, never read off them', () => {
  // No agent journals a verdict, because no agent in this pipeline certifies its own work. A
  // red order's measurement is judged by the red rule, and a green suite FAILS a red order.
  const red = order('W1', { role: 'red' })
  const greenSuite = verifyObserved({ suite: 'passed' })

  assert.equal(verifyOk(greenSuite, red), false, 'a red order with a green suite pinned nothing')
  assert.equal(verifyOk(greenSuite, order('W1')), true)

  const properlyRed = verifyObserved({
    suite: 'failed',
    failing_tests: [{ file: 'src/W1.js', id: 't' }],
    discriminator: [{ test_id: 't', failed_on_base: true, passes_now: false }],
  })
  assert.equal(verifyOk(properlyRed, red), true)
})

test('a red order whose failures escape its locus is not green', () => {
  const red = order('W1', { role: 'red', locus: ['src/W1.js'] })
  const collateral = verifyObserved({
    suite: 'failed',
    failing_tests: [{ file: 'src/elsewhere.js', id: 't' }],
    discriminator: [{ test_id: 't', failed_on_base: true, passes_now: false }],
  })

  assert.equal(verifyOk(collateral, red), false)
})

test("a resume derives the same pass for a pins:'data' order as the run that measured it did", () => {
  // A regression net asserts something already true, so it passes at base BY DESIGN. If the
  // resume asked it the base question the live run had waived, an order green in one
  // invocation would be red in the next for no reason anybody could see — which is the one
  // thing this behavioural copy exists to prevent.
  const net = order('W1', { pins: 'data' })
  const passedAtBase = verifyObserved({
    discriminator: [{ test_id: 'test/bundle.test.ts', failed_on_base: false, passes_now: true }],
  })

  assert.equal(verifyOk(passedAtBase, net), true)
  assert.equal(verifyOk(passedAtBase, order('W1')), false, 'an unmarked order is still asked')
})

test("pins:'data' waives the base question only — passes_now still has to hold", () => {
  const net = order('W1', { pins: 'data' })
  const neverPassed = verifyObserved({
    discriminator: [{ test_id: 'test/bundle.test.ts', failed_on_base: false, passes_now: false }],
  })

  assert.equal(verifyOk(neverPassed, net), false)
})

test("pins:'data' on a red order is ignored — its tests must still fail at base", () => {
  const red = order('W1', { role: 'red', pins: 'data' })
  const passedAtBase = verifyObserved({
    suite: 'failed',
    failing_tests: [{ file: 'src/W1.js', id: 't' }],
    discriminator: [{ test_id: 't', failed_on_base: false, passes_now: false }],
  })

  assert.equal(verifyOk(passedAtBase, red), false)
})

test('a journal line naming an order the plan does not carry is counted, not vanished', () => {
  const v = deriveVerdict('20260826-184728', plan([order('W1')]), '',
    jsonl([verifyObserved({ order: 'GHOST' })]), NO_GIT, [])

  assert.ok(v.notes.some((n) => /named no order this plan carries/.test(n)))
})

test('discoveries are unioned from wave lines and from their own journal lines', () => {
  const v = deriveVerdict('20260826-184728', plan([order('W1')]),
    jsonl([waveLine({ discovered: ['the build needs --no-sandbox'] })]),
    jsonl([{ kind: 'discovery', seq: 6, order: 'W1', notes: 'seatTask shares minSeparation' }]),
    NO_GIT, [])

  assert.deepEqual(v.knowledge.sort(),
    ['seatTask shares minSeparation', 'the build needs --no-sandbox'])
})

// --- the partition, parsed on disk ------------------------------------------------------------

test('a mangled partition is named as a parse failure, not read as "no waves"', () => {
  // The field bug, three times on one repository in 2026-08: a courier damaged the escaping,
  // the string would not parse, and "no waves" degraded the run to "every order is coupled" —
  // offering four already-merged orders back to the session to be reimplemented. Here it is
  // JSON.parse over a file, and the failure is NAMED rather than silently absorbed.
  const p = partitionOf({ partition_raw: '{\\"waves\\":[[\\"W1\\"]' })

  assert.deepEqual(p.waves, [])
  assert.match(p.note, /partition_raw is not JSON/)
})

test('a partition the CLI refused is a planning defect and says so', () => {
  const p = partitionOf({ partition_raw: JSON.stringify({ error: 'dependency cycle W1 -> W2 -> W1' }) })

  assert.match(p.note, /refused the plan/)
  assert.match(p.note, /planning defect/)
  assert.doesNotMatch(p.note, /not JSON/, 'a refusal is not a parse failure')
})

test('a clean partition comes back parsed', () => {
  const p = partitionOf({ partition_raw: JSON.stringify({ waves: [['W1'], ['W2']], coupled: ['W3'] }) })

  assert.deepEqual(p.waves, [['W1'], ['W2']])
  assert.deepEqual(p.coupled, ['W3'])
  assert.equal(p.note, '')
})

// --- historical ledgers ------------------------------------------------------------------------

test('a line with no kind is a wave line — every line written then was one', () => {
  const parsed = parseState(jsonl([{ seq: 1, wave: 1, merged: ['W1'] }]))
  const r = replay(parsed.entries, { entries: [], torn: 0 }, new Map([['W1', order('W1')]]))

  assert.equal(r.landed.has('W1'), true)
})

test('a 0.13.0 log still resumes: order-verified state lines are still read', () => {
  // Dropping the reader would make an upgrade rebuild work its own predecessor had finished.
  const row = actionFor('W1', {
    state: [stageLine('order-verified')],
    branches: { W1: branchRow('W1') },
  })

  assert.equal(row.next_action, 'review')
  assert.equal(row.verified_source, 'state')
})

test('the F35 corruption is skipped with a note, and the rest of the run still reads', () => {
  // Verbatim from the field: five of ten lines carried raw Windows paths and were unparseable.
  // The safe direction — a corrupt record can make work look unfinished, never wave it through.
  const raw = [
    JSON.stringify(waveLine({ merged: ['W1'] })),
    '{"kind":"order-approved","seq":6,"order":"W2","worktree":"C:\\work\\repo\\.claude"}',
  ].join('\n')

  const v = deriveVerdict('20260826-184728', plan([order('W1'), order('W2')]), raw, '', NO_GIT, [])

  assert.ok(v.notes.some((n) => /1 state line\(s\) would not parse/.test(n)))
  assert.equal(v.orders.find((o) => o.id === 'W1').next_action, 'none')
  assert.equal(v.orders.find((o) => o.id === 'W2').next_action, 'code')
})

test('the counter is seeded from the highest number in EITHER file', () => {
  // A counter restarting at zero would mint numbers the run has already used, so every
  // comparison across the interruption would read the newer record as the older one.
  const v = deriveVerdict('20260826-184728', plan([order('W1')]),
    jsonl([waveLine({ seq: 4 })]), jsonl([verifyObserved({ seq: 11 })]), NO_GIT, [])

  assert.equal(v.seq_max, 11)
})

test('an unreadable plan is a fact about the reader, not an empty run', () => {
  const v = deriveVerdict('20260826-184728', null, '', '', NO_GIT, ['plan.json is not JSON'])

  assert.equal(v.stop_reason, 'unreadable')
  assert.deepEqual(v.orders, [])
})

// --- the small pure helpers --------------------------------------------------------------------

test('measured records what was mechanically CHECKED, and absent is not a check', () => {
  assert.deepEqual(measuredOf(verifyObserved()), ['build', 'typecheck', 'suite', 'discriminator:1'])
  assert.deepEqual(
    measuredOf(verifyObserved({ build: 'failed', typecheck: 'failed', suite: 'failed', discriminator: [] })),
    ['build', 'typecheck', 'suite'], 'a check that ran and failed still ran')

  // The common shape, and the one that must not read as a gap: most repositories define no
  // separate typecheck, and one whose test command runs `tsc` first is covered by the suite.
  assert.deepEqual(measuredOf(verifyObserved({ typecheck: 'absent', discriminator: [] })),
    ['build', 'suite'], 'no typecheck command is a fact about the repository, not a missing check')

  // The case that matters, and the one an earlier version of this file got backwards. A
  // docs-only order in a repository with no build and no suite has had NOTHING mechanically
  // verified, and `measured: []` is what the caller's vacuity check reads to say so. Returning
  // ['build','suite'] here cleared that check and let such an order come back inside a run
  // reporting `complete: true` — IRON LAW §4 exactly, a partial result wearing a complete
  // one's label.
  assert.deepEqual(
    measuredOf(verifyObserved({ build: 'absent', typecheck: 'absent', suite: 'absent', discriminator: [] })),
    [], 'an absent build is a fact about the repository, not a check that ran')
})

test('a journal line written before typecheck existed resumes under the verdict it was planned under',
  () => {
    // The back-compat rule, exercised through the parser rather than around it: a line from an
    // older version carries no `typecheck` key at all, and reading that as anything but 'absent'
    // would either invent a check that never ran or fail an order for a question nobody asked.
    const old = { ...verifyObserved() }
    delete old.typecheck

    const { entries } = parseJournal(jsonl([old]))

    assert.equal(entries[0].typecheck, 'absent',
      'a missing field is a run that never asked the question')
    assert.ok(entries[0].recorded,
      'an older line is a whole record of what its version measured, not a torn one')
    assert.deepEqual(measuredOf(entries[0]), ['build', 'suite', 'discriminator:1'])
    assert.ok(verifyOk(entries[0], order('W1')),
      'an order green before this field existed is still green on resume')
  })

test('the workflow copy of measuredOf treats absent the same way this one does', async () => {
  // The two live in separate files because a workflow script cannot import, and they disagreed
  // once — invisibly. The same verifier observation produced `[]` on the fresh path and
  // `['build','suite']` on the resume path, which flipped coverage.complete between them.
  //
  // Pinned by reading the predicate rather than by executing it: the divergence was entirely in
  // how `absent` is treated, so that is the thing worth holding, and evaluating source text
  // pulled out of another file is a habit worth not having even in a test.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../workflows/agentics-develop.workflow.js', import.meta.url), 'utf8')
  const body = /const measuredOf = \(v\) => \[[\s\S]*?\]\.filter\(Boolean\)/.exec(src)

  assert.ok(body, 'the workflow still defines measuredOf where this test can find it')
  assert.match(body[0], /v\.build !== 'absent'/,
    'an absent build must not count as a check that ran, on either side')
  assert.match(body[0], /v\.suite !== 'absent'/,
    'and neither must an absent suite')
  assert.match(body[0], /v\.typecheck !== 'absent'/,
    'nor an absent typecheck, which is the ordinary state of most repositories')
  assert.doesNotMatch(body[0], /=== 'absent'/,
    'the inverted form is what the two copies drifted into last time')
})

test('nextActionFor only ever names a value ACTIONS declares', () => {
  // Checked against the exported set rather than a list written here, so a rung added to the
  // ladder without being declared fails this test instead of reaching a caller that switches
  // on a value it has never heard of.
  const allowed = new Set(ACTIONS)
  const r = replay([], { entries: [], torn: 0 }, new Map([['W1', order('W1')]]))

  for (const branches of [{}, { W1: branchRow('W1') }, { W1: branchRow('W1', { commits: [] }) }]) {
    const { next_action } = nextActionFor('W1', order('W1'), r, git(branches))
    assert.ok(allowed.has(next_action), next_action + ' is not a declared action')
  }
})

test('every rung the ladder can reach is a declared action', () => {
  const allowed = new Set(ACTIONS)
  const reached = new Set()
  const fixtures = [
    {},
    { state: [waveLine({ merged: ['W1'] })] },
    { state: [stageLine('order-approved')], branches: { W1: branchRow('W1') } },
    { journal: [verifyObserved()], branches: { W1: branchRow('W1') } },
    { branches: { W1: branchRow('W1') } },
    { branches: { W1: branchRow('W1', { commits: [] }) } },
    { orders: [order('W1'), order('W2')],
      journal: [{ kind: 'coder-done', seq: 5, order: 'W2', head_sha: B40, commits: [] }],
      branches: { W1: branchRow('W1') } },
  ]

  for (const f of fixtures) reached.add(actionFor('W1', f).next_action)

  for (const action of reached) assert.ok(allowed.has(action), action + ' is undeclared')
  assert.equal(reached.size, 6, 'every one of the six rungs is exercised above')
})
