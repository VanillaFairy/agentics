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

import { ownReview } from './tree.mjs'

const posix = (p) => String(p || '').split('\\').join('/')
const list = (v) => (Array.isArray(v) ? v : [])

const failure = (check, claim, evidence = '') => ({ check, claim, evidence: String(evidence || '') })

/**
 * Pure. Which verdict profile a leaf is judged by. A role outranks its rigor — a tdd-pair leaf is
 * a red or a green, never a plain tdd. No rigor at all, or one this file does not know, is judged
 * as `tdd`: the strictest profile that asks nothing a plain leaf cannot supply.
 */
export function profileOf(leaf) {
  const role = (leaf && leaf.role) || 'none'
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
const failuresOutside = (failing, allowed) => {
  const fence = new Set(list(allowed).map(posix))
  return list(failing).filter((f) => !f || !fence.has(posix(f.file)))
}

/**
 * The failing tests this change is answerable for: every named failure except the ones that fail
 * at the base too (`baseline_failing`, test files the change did not touch). A test that was
 * already failing before the change is not the change's to fix.
 */
export const ownFailing = (m) => {
  const before = new Set(list(m && m.baseline_failing).map(posix))
  return list(m && m.failing_tests).filter((f) => !f || !before.has(posix(f.file)))
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
 * Every named check must have PASSED. `unrunnable` is not a pass: a check that never ran proved
 * nothing, and reading it as "not failed" would certify a criterion nobody observed.
 */
function checksFailures(m) {
  return list(m.checks)
    .filter((c) => !c || c.status !== 'passed')
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
        : 'the declared mutation of ' + x.file + ' did not make the net bite: ' +
          list(x.observed_failing).length + ' of ' + list(x.expect_failing).length +
          ' expected test(s) failed under it',
      !x || !x.applied
        ? 'a spec this program could not apply says nothing about the test — fix the spec'
        : 'a regression net that survives the break it exists to catch is not a net; the tests ' +
          'pass and verify nothing'))
  }
  return out
}

const noTest = (claim, evidence) => failure('new-test', claim, evidence)

// ---------------------------------------------------------------- per profile

// tdd — new behaviour, test first. At least one new test, and each one fails at base and passes
// now. The discriminator is the highest-value check in the system: nothing else closes the
// passes-for-the-wrong-reason hole.
function tddFailures(m) {
  const out = [...suiteFailure(m), ...mutationFailures(m, { required: false })]
  const disc = list(m.discriminator)
  if (disc.length === 0) {
    out.push(noTest('this leaf added no test', 'a tdd leaf lands at least one test that fails at base and passes now'))
  }
  for (const d of disc) {
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
// a net: at least one declared mutation, and every declared one bites.
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
  return out
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
    out.push(failure('suite', 'this is a red leaf and the whole suite passes',
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
    out.push(failure('discriminator', ((d && d.test_id) || '?') + ' — a red test of this cycle — does not pass now',
      'the green leaf exists to make its red\'s tests pass, with the tests untouched'))
  }
  return out
}

// audit — declares breaks against the implementation. Every declared mutation bites (at least
// one), and the suite passes: an audit is measured on a tree that is supposed to be finished.
function auditFailures(m) {
  const out = mutationFailures(m, { required: true })
  if (m.suite === 'absent' || suiteFailed(m)) {
    out.push(failure('suite', m.suite === 'failed'
      ? 'the test suite exited non-zero'
      : 'no test suite ran, and an audit is measured on a finished, green tree',
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
  audit: auditFailures,
  trivial: trivialFailures,
  verify: verifyFailures,
}

/**
 * Pure. Whether one measurement passes, judged against the leaf's rigor and role.
 *
 * @param {object} m a verify payload, or a `verify-observed` journal line (same fields)
 * @param {object} leaf a normalized node (lib/tree.mjs `normalizeNode`)
 * @returns {{ok: boolean, failures: Array<{check: string, claim: string, evidence: string}>}}
 */
export function measurementOk(m, leaf) {
  const measurement = m && typeof m === 'object' ? m : {}
  const profile = profileOf(leaf)
  const failures = [...common(measurement), ...BY_PROFILE[profile](measurement, leaf)]
  // Red, green and audit are measured by their tests; a named check given to one was not run.
  if (profile !== 'red' && profile !== 'green' && profile !== 'audit') failures.push(...checksFailures(measurement))
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
 * @returns {{next: string, reason: string, failures: object[]}}
 */
export function closeDecision(m, leaf, history = []) {
  const measurement = m && typeof m === 'object' ? m : {}
  const { ok, failures } = measurementOk(measurement, leaf)
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
  const earlier = list(history).map((h) => shapeOf(measurementOk(h, leaf).failures))
  const previous = earlier.length > 0 ? earlier[earlier.length - 1] : ''
  if (now && previous && now !== previous && earlier.slice(0, -1).includes(now)) {
    return decide('escalate', 'verify_oscillating')
  }

  return decide('fix', failures.length + ' failing fact(s) an executor can move from inside its locus')
}
