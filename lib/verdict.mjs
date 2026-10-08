// lib/verdict.mjs — whether one measurement of a leaf passed, and what happens next.
//
// Design: docs/DESIGN.md#what-a-verdict-is-computed-from.
//
// lib/verify.mjs observes and decides nothing; this file decides and observes nothing. It is the
// ONE home of the measurement verdict. A resume must re-derive a measurement's verdict with the
// same function that derived it the first time — or a leaf green in one invocation is red in the
// next for no reason anybody can see. So leaf-close calls `closeDecision` on the live path and
// lib/resume.mjs calls `measurementOk` on a `verify-observed` line read back off disk, and there is
// no second copy to keep in step.
//
// No verdict is ever read off disk. What is recorded is what was OBSERVED — build, suite, failing
// tests, discriminator, mutations, checks — and pass or fail is computed here from those facts.
// That is what lets a measuring process write its own durability record without certifying its
// own work.
//
// Every predicate is written as a list of failures rather than a boolean, and `ok` is "the list
// is empty". A boolean predicate beside a separate findings function is two things that must be
// kept each other's exact complement, and the day they drift a leaf fails with an empty fix
// instruction — which reads to an implementer as "something is wrong, guess what".
//
// Pure: no fs, no git, no process.

import { inLocus } from './store.mjs'
import { ownReview } from './tree.mjs'

const posix = (p) => String(p || '').split('\\').join('/')
const list = (v) => (Array.isArray(v) ? v : [])

const failure = (check, claim, evidence = '') => ({ check, claim, evidence: String(evidence || '') })

/**
 * Pure. Which verdict profile a leaf is judged by. A role outranks its rigor — a tdd-pair leaf is
 * a red or a green, never a plain tdd. No rigor at all, or one this file does not know, is judged
 * as `tdd`: the strictest profile that asks nothing a plain leaf cannot supply. `producer` is the
 * measured round's agent role, which leaf-close passes and the journal line records: a green's
 * test-author round is `green-tests`.
 */
export function profileOf(leaf, producer = '') {
  const role = (leaf && leaf.role) || 'none'
  if (role === 'green' && producer === 'test-author') return 'green-tests'
  if (role === 'red' || role === 'green' || role === 'audit') return role
  const rigor = (leaf && leaf.rigor) || ''
  if (rigor === 'verify' || rigor === 'trivial' || rigor === 'tests-only') return rigor
  return 'tdd'
}

/**
 * Failures landing outside a declared set of files. The join key is the FILE — a leaf owns
 * files, and suite output names tests, so a comparison on ids alone has nothing to match on. An
 * unreadable entry is outside every fence: "confined to the locus" is a claim that needs a path
 * to rest on.
 */
const failuresOutside = (failing, allowed) => list(failing).filter((f) => !f || !inLocus(allowed, f.file))

/**
 * The failing tests this change is answerable for: every named failure except the ones that fail
 * at the base too (`baseline_failing`, the same test in a file the change did not touch). A test
 * that was already failing before the change is not the change's to fix.
 */
const testKey = (f) => posix(f && f.file) + '\0' + ((f && f.id) || '')
export const ownFailing = (m) => {
  const before = new Set(list(m && m.baseline_failing).map(testKey))
  return list(m && m.failing_tests).filter((f) => !f || !before.has(testKey(f)))
}

/**
 * Pure. Whether the suite failed for this change: it exited non-zero and at least one failing
 * test is the change's own. A suite whose every named failure fails at the base too did not fail
 * for it; one that failed naming nothing is never excused.
 */
export const suiteFailed = (m) => Boolean(m) && m.suite === 'failed' &&
  (list(m.failing_tests).length === 0 || ownFailing(m).length > 0)

// ---------------------------------------------------------------- what every profile needs
//
// Before any profile's own question is worth asking: the measurement finished, the tree builds
// and typechecks, and no commit broke its locus. A build that failed makes every downstream
// signal meaningless — a red leaf's tests "fail" for the same uninformative reason everything
// else does. A failed typecheck sits beside a failed build for the same reason, not as a stricter
// gate: a tree that does not compile makes a passing suite the misleading case rather than the
// reassuring one.
//
// An unreadable series finding counts as blocking. A journal line read back on a resume is not
// schema-validated, so an element that cannot be read must cost a re-measurement rather than
// buy a pass.

function common(m) {
  const out = []
  if (m.stop_reason !== 'completed') {
    out.push(failure('environment', 'the measurement did not complete: ' + (m.stop_reason || 'no stop_reason recorded'),
      (m.error && m.error.message) || m.notes))
  }
  if (m.build === 'failed') out.push(failure('build', 'the build command exited non-zero', m.notes))
  // Its own failure, so the fix round is told which question failed. Folded into the build's,
  // an implementer would go looking for a broken build and find one that works.
  if (m.typecheck === 'failed') {
    out.push(failure('typecheck',
      'the typecheck command exited non-zero — the tree does not compile, whatever the suite says', m.notes))
  }
  for (const f of list(m.series_findings)) {
    if (f && f.blocking === false) continue
    out.push(failure('series-' + ((f && f.check) || 'unreadable'),
      ((f && f.check) || 'unreadable finding') + ': ' + ((f && f.message) || 'a series finding that could not be read'),
      f && f.sha))
  }
  return out
}

/**
 * Pure. Whether one named check failed for this change: it did not pass, unless it failed naming
 * tests every one of which fails at the base too. `unrunnable` is not a pass: a check that never
 * ran proved nothing, and reading it as "not failed" would certify a criterion nobody observed.
 */
const checkFailed = (c) => !c || (c.status !== 'passed' &&
  !(c.status === 'failed' && list(c.failing_tests).length > 0 && ownFailing(c).length === 0))

/** Every named check must have passed, or failed only for tests that fail at the base too. */
function checksFailures(m) {
  return list(m.checks)
    .filter(checkFailed)
    .map((c) => failure('check',
      'the named check ' + JSON.stringify((c && c.command) || '?') + ' ' +
      (c && c.status === 'unrunnable' ? 'could not be run' : 'did not pass') + ': ' + ((c && c.status) || 'unreadable'),
      c && c.status === 'unrunnable'
        ? 'a check that never ran is a defect in the criterion or the environment, not in the code'
        : m.notes))
}

const suiteFailure = (m) => (suiteFailed(m)
  ? [failure('suite', 'the test suite exited non-zero', m.suite_output_tail)]
  : [])

const mutationText = (x) => (typeof x.find === 'string' && x.find
  ? ' (' + JSON.stringify(x.find) + ' → ' + JSON.stringify(String(x.replace ?? '')) + ')'
  : '')

/**
 * Pure. Whether an audit's tests have let one of its applied mutations through in any measurement
 * so far. The gap is then the tests', and every later round of the audit goes to a test-author.
 */
export const auditGap = (measured) =>
  list(measured).some((m) => list(m && m.mutations).some((x) => x && x.applied && !x.bites))

/**
 * Pure. The mutations a leaf's close applies. A leaf measured by its mutations (tests-only, audit)
 * is held to every mutation an earlier measurement of it applied, beside this round's
 * declarations: a mutation its tests let through stays until a test catches it, and is never
 * dropped to pass. A redeclared mutation (same file, find and replace) takes this round's
 * `expect_failing`. Other profiles apply this round's declarations alone: their implementation
 * moves between rounds, and an old `find` with it.
 *
 * @param {object} leaf a normalized node
 * @param {object[]} measured earlier `verify-observed` lines for this leaf
 * @param {object[]} declared this round's `agentics-mutations`
 */
export function heldMutations(leaf, measured, declared) {
  const profile = profileOf(leaf)
  const earlier = profile === 'tests-only' || profile === 'audit'
    ? list(measured).flatMap((m) => list(m && m.mutations))
      .filter((x) => x && x.applied && typeof x.find === 'string')
      .map((x) => ({ file: x.file, find: x.find, replace: x.replace, expect_failing: list(x.expect_failing) }))
    : []
  const held = new Map()
  for (const x of [...earlier, ...list(declared)]) {
    if (x && typeof x === 'object') held.set(JSON.stringify([x.file, x.find, x.replace]), x)
  }
  return [...held.values()]
}

// A mutation this leaf DECLARED and that did not bite. Both halves are required and neither is
// enough alone: a spec that could not be APPLIED says nothing about the net — a stale `find` is a
// defect in the spec, not evidence about the test — so it fails the leaf under its own name
// rather than being read as a net that holds.
function mutationFailures(m, { required }) {
  const out = []
  const mutations = list(m.mutations)
  if (required && mutations.length === 0) {
    out.push(failure('mutation',
      'no mutation was declared, and this rigor is measured by the breaks its tests catch',
      'a regression net nobody tried to break is unmeasured; declare at least one mutation ' +
      '(`agentics-mutations` in the report) that the new tests must catch'))
  }
  for (const x of mutations) {
    if (x && x.applied && x.bites) continue
    out.push(failure('mutation',
      !x || !x.applied
        ? 'the declared mutation of ' + ((x && x.file) || '?') + ' could not be applied: ' +
          ((x && x.unapplied_reason) || 'no reason recorded')
        : 'the declared mutation of ' + x.file + mutationText(x) + ' did not make the net bite: ' +
          list(x.observed_failing).length + ' of ' + list(x.expect_failing).length +
          ' expected test(s) (' + list(x.expect_failing).join(', ') + ') failed under it',
      !x || !x.applied
        ? 'a spec this program could not apply says nothing about the test — fix the spec'
        : 'a regression net that survives the break it exists to catch is not a net; the tests ' +
          'pass and verify nothing'))
  }
  return out
}

const noTest = (claim, evidence) => failure('new-test', claim, evidence)

// ---------------------------------------------------------------- per profile

// A discriminator entry whose file adds a test case. One without the field, or unreadable, does:
// a missing fact must cost the stricter question rather than buy a waiver.
const addsTest = (d) => !d || d.adds_test !== false

// tdd — new behaviour, test first. At least one test file adds a test case, and each one that
// does fails at base and passes now. A file adding none is upkeep, which passes at base by
// construction, so only `passes_now` is asked of it — but only beside a file that adds one: when
// none does, every file is held to the whole discriminator, so a declaration the pattern missed
// buys no waiver. The discriminator is the highest-value check in the system: nothing else closes
// the passes-for-the-wrong-reason hole.
function tddFailures(m) {
  const out = [...suiteFailure(m), ...mutationFailures(m, { required: false })]
  const disc = list(m.discriminator)
  if (disc.length === 0) {
    out.push(noTest('this leaf added no test', 'a tdd leaf lands at least one test that fails at base and passes now'))
  }
  const upkeepWaived = disc.some(addsTest)
  for (const d of disc) {
    if (upkeepWaived && !addsTest(d)) {
      if (d.passes_now) continue
      out.push(failure('discriminator', (d.test_id || '?') + ' adds no test case and does not pass now',
        'a test file kept up to date for the change must still pass'))
      continue
    }
    if (d && d.failed_on_base && d.passes_now) continue
    out.push(failure('discriminator',
      ((d && d.test_id) || '?') + ' does not discriminate: failed_on_base=' + (d && d.failed_on_base) +
      ', passes_now=' + (d && d.passes_now),
      d && d.passes_now
        ? 'a test that passes without the change under test pins nothing'
        : 'a new test that does not pass now is unfinished work'))
  }
  return out
}

// tests-only — a regression net over code that is already correct. Those assertions hold at base
// BY DESIGN, so `failed_on_base` is not a question they can answer; `passes_now` still is, and is
// still required. The waiver is one conjunct wide, and what replaces it is the right question for
// a net: at least one declared mutation, every declared one bites, and every test file that adds a
// case is one a biting mutation names — a file no break was shown to fail could be blind.
function testsOnlyFailures(m) {
  const out = [...suiteFailure(m), ...mutationFailures(m, { required: true })]
  const disc = list(m.discriminator)
  if (disc.length === 0) out.push(noTest('this leaf added no test', 'a tests-only leaf IS its tests; the diff carries none'))
  for (const d of disc) {
    if (d && d.passes_now) continue
    out.push(failure('discriminator',
      ((d && d.test_id) || '?') + ' does not pass now',
      'a tests-only leaf pins code that is already correct, so its tests pass as they land'))
  }
  return [...out, ...unnamedNewTests(m)]
}

// Every test file that adds a case is named in the expect_failing of a mutation that bites: a file
// no break was shown to fail could be blind.
function unnamedNewTests(m) {
  const caught = list(m.mutations).filter((x) => x && x.applied && x.bites).flatMap((x) => list(x.expect_failing).map(String))
  return list(m.discriminator)
    .map((d) => (d && d.test_id) || '')
    .filter((file, i) => file && addsTest(m.discriminator[i]) && !caught.some((t) => t.includes(file)))
    .map((file) => failure('mutation', file + ' adds a test no biting mutation names',
      'every new test is shown to catch a break: declare a mutation it fails under, naming it in expect_failing'))
}

// red — lands tests that MUST fail; that is the entire leaf. Four inversions, each answering a
// way a red leaf can be hollow rather than red:
//   a discriminator that is empty       — it added no test, so it produced nothing
//   a test that passes now              — it pins behaviour that already existed
//   a whole suite that is green         — same, from the other direction
//   a failure outside its own locus     — it broke something; that is collateral, not the point
// The build must still pass (see `common`): tests that fail because nothing compiles pin nothing.
function redFailures(m, leaf) {
  const out = []
  const disc = list(m.discriminator)
  if (disc.length === 0) out.push(noTest('this is a red leaf and it added no test', 'a red leaf IS its tests; the diff carries none'))
  if (m.suite === 'passed') {
    out.push(failure('suite', 'this is a red leaf and its tests pass',
      'tests that pass before anything is implemented assert something already true'))
  }
  for (const d of disc) {
    if (d && d.failed_on_base && !d.passes_now) continue
    out.push(failure('discriminator',
      ((d && d.test_id) || '?') + ' does not fail as a red test must: failed_on_base=' + (d && d.failed_on_base) +
      ', passes_now=' + (d && d.passes_now),
      'a red test must fail at base AND fail now — it pins behaviour nobody has built'))
  }
  if (suiteFailed(m)) {
    // The emptiness check is not a formality: a suite that failed while naming no test would
    // otherwise read as confined to whatever fence it was held against. An unnamed failure could
    // be any failure, so it is confined to nothing.
    if (list(m.failing_tests).length === 0) {
      out.push(failure('suite', 'the suite failed but no failing test was named',
        'an unnamed failure could be any failure, so it cannot be confined to this locus'))
    }
    for (const f of failuresOutside(ownFailing(m), leaf && leaf.locus)) {
      out.push(failure('suite', ((f && f.file) || '?') + ' fails and is not a test this leaf owns (' + ((f && f.id) || '?') + ')',
        'a red leaf fails its own new tests and nothing else; this is collateral damage'))
    }
  }
  return out
}

// green — implements its red. Measured on the cycle's tests (the red's), which must pass now; the
// suite must not fail. A cycle is held until its last member is approved, so the tree a green is
// measured in never carries another pair's unimplemented tests, and this strict verdict is the
// right one for it.
function greenFailures(m) {
  const out = [...suiteFailure(m)]
  const disc = list(m.discriminator)
  if (disc.length === 0) {
    out.push(noTest('none of the cycle\'s red tests was measured',
      'a green leaf is judged by its red\'s tests passing now; leaf-close names them to the measurement'))
  }
  for (const d of disc) {
    if (d && d.passes_now) continue
    out.push(failure('discriminator', ((d && d.test_id) || '?') + ' — a test of this cycle — does not pass now',
      'the green leaf exists to make its red\'s tests pass, with the tests untouched'))
  }
  return out
}

// green, a test-author round — closes a test gap its review found: the cycle's tests and its own
// new ones pass, the suite does not fail, and each break it declares (at least one, this round's
// alone: the implementation moves between rounds) makes the tests it names fail, every new test
// file among them.
const greenTestsFailures = (m) => [...greenFailures(m), ...mutationFailures(m, { required: true }), ...unnamedNewTests(m)]

// audit — declares breaks against the implementation. Every declared mutation bites (at least
// one), and the suite passes: an audit is measured on a tree that is supposed to be finished.
function auditFailures(m) {
  const out = mutationFailures(m, { required: true })
  if (m.suite === 'not_run' || m.suite === 'absent' || suiteFailed(m)) {
    out.push(failure('suite', m.suite === 'failed'
      ? 'the test suite exited non-zero'
      : 'the cycle\'s tests did not run, and an audit is measured on a finished, green tree',
    m.suite_output_tail))
  }
  return out
}

// trivial — a change a test would only restate. No discriminator is asked for; what is asked is
// that nothing the leaf touched broke what already worked.
const trivialFailures = (m) => suiteFailure(m)

// verify — writes nothing. Its named checks are the whole measurement; build, typecheck and suite
// must not have failed where they ran (see `common`, which also covers them for this profile).
const verifyFailures = (m) => suiteFailure(m)

const BY_PROFILE = {
  tdd: tddFailures,
  'tests-only': testsOnlyFailures,
  red: redFailures,
  green: greenFailures,
  'green-tests': greenTestsFailures,
  audit: auditFailures,
  trivial: trivialFailures,
  verify: verifyFailures,
}

/**
 * Pure. Whether one measurement passes, judged against the leaf's rigor and role.
 *
 * @param {object} m a verify payload, or a `verify-observed` journal line (same fields)
 * @param {object} leaf a normalized node (lib/tree.mjs `normalizeNode`)
 * @param {string} [producer] the measured round's agent role (see `profileOf`)
 * @returns {{ok: boolean, failures: Array<{check: string, claim: string, evidence: string}>}}
 */
export function measurementOk(m, leaf, producer = '') {
  const measurement = m && typeof m === 'object' ? m : {}
  const profile = profileOf(leaf, producer)
  const failures = [...common(measurement), ...BY_PROFILE[profile](measurement, leaf)]
  // Red and audit are measured by their tests; a named check given to one was not run.
  if (profile !== 'red' && profile !== 'audit') failures.push(...checksFailures(measurement))
  return { ok: failures.length === 0, failures }
}

// ---------------------------------------------------------------- what happens next

const isLoneBreach = (failures) => failures.length > 0 && failures.every((f) => f.check === 'series-locus-breach')
const isBuildBroken = (failures) => failures.some((f) => f.check === 'build' || f.check === 'typecheck')
const shapeOf = (failures) => (isLoneBreach(failures) ? 'breach' : isBuildBroken(failures) ? 'broken' : '')

/**
 * Pure. What a leaf's close does with one measurement.
 *
 *   command_unknown   the measurement could not run because nobody established a command —
 *                     an investigator's work, never the implementer's
 *   escalate          any other broken measurement (reason = its error kind); a lone
 *                     discriminator failure on a tdd leaf (`discriminator_undecidable`); fix
 *                     rounds cycling between a locus breach and a broken build
 *                     (`verify_oscillating`)
 *   review | approve  it passed: `review` when the leaf buys a review loop of its own
 *                     (`ownReview`), `approve` otherwise and always for a `verify` leaf
 *   finding           a `verify` leaf failed: that is a finding for the parent, not a fix round,
 *                     because there is no producer to send one to
 *   fix               anything else: a failure an executor can move from inside its locus
 *
 * No counter is consulted on any path.
 *
 * @param {object} m the measurement
 * @param {object} leaf a normalized node
 * @param {object[]} history earlier `verify-observed` lines for this node, oldest first
 * @param {string} [producer] the measured round's agent role (see `profileOf`)
 * @returns {{next: string, reason: string, failures: object[]}}
 */
export function closeDecision(m, leaf, history = [], producer = '') {
  const measurement = m && typeof m === 'object' ? m : {}
  const { ok, failures } = measurementOk(measurement, leaf, producer)
  const decide = (next, reason) => ({ next, reason, failures })

  const error = measurement.error
  if (error && error.kind === 'command_unknown') return decide('command_unknown', 'command_unknown')
  if (error || measurement.stop_reason !== 'completed') {
    return decide('escalate', (error && error.kind) || measurement.stop_reason || 'environment_broken')
  }

  if (ok) {
    if (profileOf(leaf) === 'verify') return decide('approve', 'the named checks passed')
    return ownReview(leaf)
      ? decide('review', 'measured green; this leaf buys a review loop of its own')
      : decide('approve', 'measured green; reviewed at integration')
  }

  if (profileOf(leaf) === 'verify') return decide('finding', 'a named check failed; a verify leaf has no producer to fix it')

  // Routed, not refused, and on round ONE. A tdd leaf whose only failing fact is that its new
  // tests pass at base as well as now cannot be moved by any commit inside its own locus: a test
  // over behaviour that already exists fails at base only if the behaviour is broken first. Buying
  // a fix round to find that out again only makes the wrong verdict sound more confident — which
  // is exactly what repeated rounds did to a field run's regression net before a human overrode
  // the gate. A person rules on it, with the criteria in hand; the likely ruling is that the leaf
  // was `tests-only`.
  //
  // Narrowed to tests that DO pass now. One that does not is unfinished work an implementer can
  // move, and it is a fix round like any other.
  if (profileOf(leaf) === 'tdd' && failures.every((f) => f.check === 'discriminator') &&
      list(measurement.discriminator).every((d) => d && d.passes_now)) {
    return decide('escalate', 'discriminator_undecidable')
  }

  // A failure state this leaf already left and has come back to. The field case: a leaf that
  // needed a file its locus did not name cycled — edit outside the locus (a lone blocking
  // breach), revert (the tree no longer compiles), edit again. The same correct change was
  // written three times and reverted twice. The trigger is that the executor is somewhere it has
  // been before, between two constraints no commit inside this locus satisfies both of: a defect
  // in the PLAN, and no number of further rounds widens a fence the executor may not widen.
  const now = shapeOf(failures)
  const earlier = list(history).map((h) => shapeOf(measurementOk(h, leaf, h && h.producer).failures))
  const previous = earlier.length > 0 ? earlier[earlier.length - 1] : ''
  if (now && previous && now !== previous && earlier.slice(0, -1).includes(now)) {
    return decide('escalate', 'verify_oscillating')
  }

  return decide('fix', failures.length + ' failing fact(s) an executor can move from inside its locus')
}

// ---------------------------------------------------------------- fix rounds and reviews

/** What makes two failing measurements the same failure: their checks and claims. */
const failureKey = (failures) => list(failures).map((f) => f.check + ':' + f.claim).sort().join('|')

/**
 * Pure. Whether a `fix` close repeats the one before it: the same failures at a moved head, so the
 * fix round in between changed nothing the checks see. A re-measure of the same head is the same
 * observation, never a second one.
 *
 * @param {{decision: {next: string, failures: object[]}, head_sha: string}|null} previous the close of the round before
 * @param {{failures: object[]}} decision this close's
 * @param {string} head this close's head
 */
export function fixNotConverging(previous, decision, head) {
  if (!previous || !previous.decision || previous.decision.next !== 'fix' || previous.head_sha === head) return false
  const key = failureKey(decision.failures)
  return key !== '' && key === failureKey(previous.decision.failures)
}

/** Pure. Who must change to fix a finding: the cycle's tests (`tests`) or the implementation (`code`, the default). */
export const remedyOf = (finding) => (finding && finding.remedy === 'tests' ? 'tests' : 'code')

/** Pure. Whether an open review entry is a unit its reviewer left unruled (`unit:<u>`, minted by `reviewExit`): the reviewer's miss, no producer's to fix. */
export const unruledUnit = (entry) => String(entry && entry.id).startsWith('unit:')

/**
 * Pure. Who answers the next round of a green (docs/DESIGN.md#rigor), from the round before: its
 * close record and the review of its work. A test-author when that round's implementer returned
 * `needs_tests`, when it was a test-author's round whose measurement failed only on what that
 * author wrote (its declared mutations, its series), or when every blocker the review left open is
 * the tests' to fix. Otherwise an implementer: a mixed open set goes to it first, the tests'
 * findings carried, and so does a new test that does not pass now, which the code may owe. A unit
 * the review left unruled weighs on neither side: no producer can rule it.
 *
 * @param {{close?: {role?: string, status?: string, decision?: {next: string, failures?: object[]}}|null, review?: {next: string, open?: object[]}|null}} before
 * @returns {'implementer'|'test-author'}
 */
export function greenRoundRole({ close = null, review = null } = {}) {
  if (close && close.status === 'needs_tests') return 'test-author'
  const failures = close && close.decision && close.decision.next === 'fix' ? list(close.decision.failures) : []
  const authors = (f) => f && (f.check === 'mutation' || String(f.check).startsWith('series-'))
  if (close && close.role === 'test-author' && failures.length > 0 && failures.every(authors)) return 'test-author'
  const open = review && review.next === 'fix' ? list(review.open).filter((f) => !unruledUnit(f)) : []
  return open.length > 0 && open.every((f) => remedyOf(f) === 'tests') ? 'test-author' : 'implementer'
}

/** Pure. A finding that blocks approval: a critical, or a major with a failure scenario on a yardstick leaf. */
const blocks = (f, yardstick) => f.severity === 'critical' ||
  (f.severity === 'major' && yardstick && String(f.failure_scenario || '').trim() !== '')

/** Rulings in which a judge declares it did not look: they rule nothing, so the unit stays open (L3). */
const NOT_EXAMINED = new Set(['unexamined', 'unassessable', 'unanchored'])
const examinedUnits = (rulings) => new Set(list(rulings).filter((r) => !NOT_EXAMINED.has(r.ruling)).map((r) => r.unit))

/** Pure. Units nobody ruled on, or only declared unexamined. */
export const unitsOpen = (units, rulings) => {
  const examined = examinedUnits(rulings)
  return list(units).filter((u) => !examined.has(u))
}

/** Pure. Approval over units: every unit ruled, no blocking finding (docs/DESIGN.md#l3--separate-judges). */
export function verdictOf({ units = [], rulings = [], findings = [], yardstick = false }) {
  const open = unitsOpen(units, rulings)
  const blocking = list(findings).filter((f) => blocks(f, yardstick))
  return { approved: open.length === 0 && blocking.length === 0, open, blocking }
}

/**
 * Pure. The exit of one leaf review round (docs/DESIGN.md#executors-and-review), from the round's
 * findings and fix verdicts and what the round before left open. The blocking set is the round's
 * criticals, plus its majors when the leaf is a yardstick (`isYardstick` in lib/tree.mjs: a red, an
 * audit, or one that provides a contract) and the finding names a failure scenario. The open set
 * is the blocking set plus every prior blocker ruled `not_fixed` or `regressed`, or not ruled on at
 * all, that the round did not re-report. Approval is that set
 * being empty; escalation is the same finding unfixed two rounds running, or two rounds that each
 * fixed every prior blocker and still minted new ones. No round counter ends the loop. A fix exit
 * raises the next round's tier when the round answered prior blockers and ruled none of them
 * `fixed`: it cleared none of its blockers (docs/DESIGN.md#model-tier).
 *
 * `producer` is the remedy the round under review could apply (`code` for an implementer's, `tests`
 * for a test-author's), given only where a leaf's rounds go to both (a green). A prior blocker of
 * the other remedy was carried past that round: it stays open, and counts toward neither escalation
 * nor a raise.
 *
 * @param {{yardstick: boolean, findings: object[], verdicts: object[], prior?: {open?: object[], unfixed?: string[], clean_streak?: number}, producer?: ''|'code'|'tests', units?: string[]|null, rulings?: {unit: string, ruling: string}[]}} round
 * @returns {{next: 'approve'|'fix'|'escalate', reason: string, detail: string, open: object[], unfixed: string[], clean_streak: number, raise: boolean}}
 */
export function reviewExit({ yardstick = false, findings = [], verdicts = [], prior = {}, producer = '', units = null, rulings = [] }) {
  if (units !== null) {
    const ruled = examinedUnits(rulings)
    findings = [...list(findings), ...unitsOpen(units, rulings).map((u) => ({
      id: 'unit:' + u, severity: 'critical', claim: 'unit not ruled: ' + u, evidence: '', failure_scenario: 'nobody examined ' + u,
    }))]
    verdicts = [...list(verdicts), ...list(prior.open).filter((p) => String(p.id).startsWith('unit:') && ruled.has(String(p.id).slice(5)))
      .map((p) => ({ id: p.id, status: 'fixed', evidence: 'ruled this round' }))]
  }
  const before = list(prior.open)
  const carried = new Set(producer ? before.filter((p) => remedyOf(p) !== producer).map((p) => p.id) : [])
  const answered = before.filter((p) => !carried.has(p.id))
  const unfixedBefore = new Set(list(prior.unfixed))
  const blocking = list(findings).filter((f) => blocks(f, yardstick))
  const ruled = list(verdicts)
  // A prior blocker the round did not rule on is not fixed: it was never looked at.
  const notFixed = ruled.filter((v) => v.status === 'not_fixed' || v.status === 'regressed')
    .concat(before.filter((p) => !ruled.some((v) => v.id === p.id)).map((p) => ({ id: p.id, status: 'not_fixed' })))
  const reported = new Set(list(findings).map((f) => f.id))
  const open = blocking.concat(before.filter((p) => notFixed.some((u) => u.id === p.id) && !reported.has(p.id)))
  const unfixed = notFixed.filter((u) => !carried.has(u.id))
  const out = (next, reason, detail, extra = {}) => ({
    next, reason, detail, open, unfixed: unfixed.map((u) => u.id), clean_streak: 0, raise: false, ...extra,
  })
  if (open.length === 0) return out('approve', '', '')
  const repeat = unfixed.find((u) => unfixedBefore.has(u.id))
  if (repeat) return out('escalate', 'review_not_converging', 'finding ' + repeat.id + ' ruled ' + repeat.status + ' in two consecutive rounds')
  const allFixed = answered.length > 0 && answered.every((p) => ruled.some((v) => v.id === p.id && v.status === 'fixed'))
  const streak = allFixed && blocking.some((f) => !carried.has(f.id)) ? (Number(prior.clean_streak) || 0) + 1 : 0
  if (streak >= 2) return out('escalate', 'review_not_converging', 'two rounds each fixed every prior blocker and still minted new ones')
  const clearedNone = answered.length > 0 && !answered.some((p) => ruled.some((v) => v.id === p.id && v.status === 'fixed'))
  return out('fix', '', '', { clean_streak: streak, raise: clearedNone })
}

const OFF_SPEC = ['under', 'over', 'deviates']

/**
 * Pure. The one park an integration review earns, or null. A spec defect goes first: fixing work
 * against a claim that cannot be met is wasted. Then criticals and drift, which the user routes to
 * a fix: no single producer owns a folder's merged work. Then what the review could not decide,
 * which never counts as a pass.
 *
 * @returns {{why: string, question: string}|null}
 */
export function integrationPark(findings, claims, specPath) {
  const off = list(claims).filter((c) => c.ruling !== 'met')
  const criticals = list(findings).filter((f) => f.severity === 'critical')
  const why = off.some((c) => c.ruling === 'spec_defect') ? 'spec_defect'
    : criticals.length || off.some((c) => OFF_SPEC.includes(c.ruling)) ? 'integration_critical'
      : off.length ? 'cant_tell' : ''
  if (!why) return null
  const lines = criticals.map((f) => f.id + ': ' + f.claim).concat(off.map((c) => '[' + c.ruling + '] ' + c.claim + ' — ' + c.evidence))
  return { why, question: (why === 'spec_defect' ? 'the spec ' + specPath + ': ' : '') + lines.join('; ') }
}
