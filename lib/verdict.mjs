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

import { inPaths, isAncestorOrSelf } from './store.mjs'
import { ownReview } from './tree.mjs'

const posix = (p) => String(p || '').split('\\').join('/')
const list = (v) => (Array.isArray(v) ? v : [])

const failure = (check, claim, evidence = '') => ({ check, claim, evidence: String(evidence || '') })

/** The `producer` a cycle's consolidation round is measured and journalled as (docs/DESIGN.md#rigor). */
export const CONSOLIDATION = 'consolidation'

/**
 * Pure. Which verdict profile a leaf is judged by. A role outranks its rigor — a tdd-pair leaf is
 * a red or a green, never a plain tdd. No rigor at all, or one this file does not know, is judged
 * as `tdd`: the strictest profile that asks nothing a plain leaf cannot supply. `producer` is the
 * measured round's agent role, which leaf-close passes and the journal line records: a green's
 * test-author round is `green-tests`, and a cycle's consolidation round (`CONSOLIDATION`) is
 * `consolidation`.
 */
export function profileOf(leaf, producer = '') {
  const role = (leaf && leaf.role) || 'none'
  if (producer === CONSOLIDATION && (role === 'green' || role === 'audit')) return 'consolidation'
  if (role === 'green' && producer === 'test-author') return 'green-tests'
  if (role === 'red' || role === 'green' || role === 'audit') return role
  const rigor = (leaf && leaf.rigor) || ''
  if (rigor === 'verify' || rigor === 'trivial' || rigor === 'tests-only') return rigor
  return 'tdd'
}

/**
 * Failures landing outside a set of test files. The join key is the FILE — a leaf owns the test
 * files of its own diff, and suite output names tests, so a comparison on ids alone has nothing to
 * match on. An unreadable entry is outside every set: "confined to its own tests" is a claim that
 * needs a path to rest on.
 */
const failuresOutside = (failing, own) => list(failing).filter((f) => !f || !inPaths(own, f.file))

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
// and typechecks, and no commit broke its role's rule. A build that failed makes every downstream
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
export function checksFailures(m) {
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

// The entries held to `passes_now` alone: a file ruled a regression net at the measured head
// (`nets`, see `netsAt`), and an upkeep file beside one that adds a test case. Upkeep passes at base
// by construction, so no commit could make it discriminate. When no file adds one, an upkeep file
// is held to the profile's whole question, so a declaration the pattern missed buys no waiver.
function passesNowAlone(disc, nets) {
  const upkeepWaived = disc.some(addsTest)
  return (d) => Boolean(d) && ((upkeepWaived && !addsTest(d)) || nets.includes(d.test_id))
}

// One entry held to `passes_now` alone that does not pass now: an existing test the change broke.
const keptFailure = (d) => failure('discriminator', (d.test_id || '?') + ' adds no test case and does not pass now',
  'a test file kept up to date for the change must still pass')

// A change the typecheck rejects at base: every changed test file passed at base, and a static
// check asked there with those files restored (`static_on_base`) failed — the typecheck, passing now,
// or a criterion check that runs it and passed now. That check is the leaf's discriminator, and its
// test files are held to passing now. A behaviour change is untouched: a test file that failed at
// base is never waived, and no static check is asked over one.
function staticallyPinned(m, disc) {
  if (disc.length === 0 || !disc.every((d) => d && !d.failed_on_base)) return false
  const passedNow = (s) => (s.kind === 'typecheck' ? m.typecheck === 'passed'
    : list(m.checks).some((c) => c && c.command === s.command && c.status === 'passed'))
  return list(m.static_on_base).some((s) => s && s.failed_on_base === true && passedNow(s))
}

// tdd — new behaviour, test first. At least one test file adds a test case, and each one that
// does fails at base and passes now; upkeep files and nets pass now (`passesNowAlone`), and so
// does every test file of a change the typecheck rejects at base (`staticallyPinned`). The
// discriminator is the highest-value check in the system: nothing else closes the
// passes-for-the-wrong-reason hole. When no file is left to discriminate, the leaf's criterion
// checks are what pin the change, so at least one must have run.
function tddFailures(m, leaf, { nets = [] } = {}) {
  const out = [...suiteFailure(m), ...mutationFailures(m, { required: false })]
  const disc = list(m.discriminator)
  if (disc.length === 0) {
    out.push(noTest('this leaf added no test', 'a tdd leaf lands at least one test that fails at base and passes now'))
  }
  const netted = (d) => Boolean(d) && nets.includes(d.test_id)
  if (disc.length > 0 && disc.every(netted) && list(m.checks).length === 0) {
    out.push(failure('discriminator', 'every changed test file is ruled a regression net and no criterion check ran',
      'with no test that discriminates, a named check that fails at base is what pins the change'))
  }
  const alone = passesNowAlone(disc, nets)
  const pinned = staticallyPinned(m, disc)
  for (const d of disc) {
    if (alone(d)) {
      if (!d.passes_now) out.push(keptFailure(d))
      continue
    }
    if (d && d.failed_on_base && d.passes_now) continue
    if (pinned && d.passes_now) continue
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

/** Pure. Whether a test file is named in the expect_failing of an applied mutation that bites. */
function namedByBite(m) {
  const caught = list(m.mutations).filter((x) => x && x.applied && x.bites).flatMap((x) => list(x.expect_failing).map(String))
  return (file) => caught.some((t) => t.includes(file))
}

// Every test file that adds a case is named in the expect_failing of a mutation that bites: a file
// no break was shown to fail could be blind.
function unnamedNewTests(m) {
  const named = namedByBite(m)
  return list(m.discriminator)
    .map((d) => (d && d.test_id) || '')
    .filter((file, i) => file && addsTest(m.discriminator[i]) && !named(file))
    .map((file) => failure('mutation', file + ' adds a test no biting mutation names',
      'every new test is shown to catch a break: declare a mutation it fails under, naming it in expect_failing'))
}

// red — lands tests that MUST fail; that is the entire leaf. Four inversions, each answering a
// way a red leaf can be hollow rather than red:
//   a discriminator that is empty       — it added no test, so it produced nothing
//   a test that passes now              — it pins behaviour that already existed
//   a whole suite that is green         — same, from the other direction
//   a failure outside its own tests     — it broke something; that is collateral, not the point
// The build must still pass (see `common`): tests that fail because nothing compiles pin nothing.
// An upkeep file beside one that adds a case, and a file ruled a net, pass now, as on a tdd leaf:
// each held at base, and no test it holds is the red's to fail.
function redFailures(m, leaf, { nets = [] } = {}) {
  const out = []
  const disc = list(m.discriminator)
  if (disc.length === 0) out.push(noTest('this is a red leaf and it added no test', 'a red leaf IS its tests; the diff carries none'))
  if (m.suite === 'passed') {
    out.push(failure('suite', 'this is a red leaf and its tests pass',
      'tests that pass before anything is implemented assert something already true'))
  }
  const alone = passesNowAlone(disc, nets)
  for (const d of disc) {
    if (alone(d)) {
      if (!d.passes_now) out.push(keptFailure(d))
      continue
    }
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
        'an unnamed failure could be any failure, so it cannot be confined to this leaf\'s tests'))
    }
    const own = list(m.discriminator).map((d) => (d && d.test_id) || '').filter(Boolean)
    for (const f of failuresOutside(ownFailing(m), own)) {
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
// new ones pass and the suite does not fail. The test-author never reads the implementation, so it
// is not asked to break it: each new test file fails at the round's base, the red's head where the
// implementation is its throwing stubs, or is named by a break it redeclared that bites.
const greenTestsFailures = (m) => [...greenFailures(m), ...mutationFailures(m, { required: false }), ...blindNewTests(m)]

/** Pure. The new test files a blind test round adds that neither fail at its base nor are named by a biting mutation. */
function blindNewTests(m) {
  const named = namedByBite(m)
  return list(m.discriminator)
    .filter((d) => d && d.test_id && addsTest(d) && !(d.failed_on_base && d.passes_now) && !named(d.test_id))
    .map((d) => failure('discriminator', d.test_id + " adds a test that passes at the red's stubs too, and no biting mutation names it",
      "a test the cycle's red head already passes pins nothing the implementation added"))
}

// audit — declares breaks against the implementation. Every declared mutation bites (at least
// one), and the suite passes: an audit is measured on a tree that is supposed to be finished.
// consolidation asks the same of a cycle's leaner tests: on an audit leaf the held mutations are
// the audit's own (`heldMutations`), so nothing the audit showed caught is lost.
function finishedTreeFailures(m) {
  const out = mutationFailures(m, { required: true })
  if (m.suite === 'not_run' || m.suite === 'absent' || suiteFailed(m)) {
    out.push(failure('suite', m.suite === 'failed'
      ? 'the test suite exited non-zero'
      : 'the cycle\'s tests did not run, and this round is measured on a finished, green tree',
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
  audit: finishedTreeFailures,
  // The consolidation round is the cycle's blind test session too: the breaks it is held to are the
  // ones code applies again (an audit's), never ones it must write against code it cannot read.
  consolidation: (m) => [...mutationFailures(m, { required: false }), ...finishedTreeFailures(m).filter((f) => f.check !== 'mutation')],
  trivial: trivialFailures,
  verify: verifyFailures,
}

/**
 * Pure. Whether one measurement passes, judged against the leaf's rigor and role.
 *
 * @param {object} m a verify payload, or a `verify-observed` journal line (same fields)
 * @param {object} leaf a normalized node (lib/tree.mjs `normalizeNode`)
 * @param {string} [producer] the measured round's agent role (see `profileOf`)
 * @param {{nets?: string[]}} [opts] `nets`, the test files ruled regression nets at this head (`netsAt`)
 * @returns {{ok: boolean, failures: Array<{check: string, claim: string, evidence: string}>}}
 */
export function measurementOk(m, leaf, producer = '', { nets = [] } = {}) {
  const measurement = m && typeof m === 'object' ? m : {}
  const profile = profileOf(leaf, producer)
  const failures = [...common(measurement), ...BY_PROFILE[profile](measurement, leaf, { nets })]
  // Red and audit are measured by their tests; a named check given to one was not run.
  if (profile !== 'red' && profile !== 'audit') failures.push(...checksFailures(measurement))
  return { ok: failures.length === 0, failures }
}

/**
 * Pure. The user's ruling (`nets` event) on leaf `id` that stands at `head`: `{files, why, all}`,
 * `all` when it left no changed test file to discriminate; null when none stands. A ruling made at
 * that head stands whole. Else the leaf's latest ruling stands for each net whose file holds the
 * same content at `head` as at the head it was ruled at (`sameAt(ruledHead, head, file)`, the git
 * port), `all` only when every one of them does; a net whose file changed since is voided.
 */
export function netsAt(events, id, head, sameAt = () => false) {
  const mine = list(events).filter((e) => e && e.kind === 'nets' && e.node === id && e.head_sha)
  const exact = head ? mine.filter((e) => e.head_sha === head).pop() : null
  const ruled = exact || mine.pop()
  if (!ruled || !head) return null
  const all = list(ruled.nets)
  const nets = exact ? all : all.filter((n) => sameAt(ruled.head_sha, head, n.file))
  if (nets.length === 0) return null
  return { files: nets.map((n) => n.file), nets, all: ruled.all === true && nets.length === all.length }
}

/**
 * Pure. The leaves at or under `rootId` approved at a head where the user ruled every changed test
 * file a regression net, so none discriminates: `[{id, nets: [{file, why}]}]`, for the result and
 * the integration review. `sameAt` is `netsAt`'s.
 */
export function undiscriminated(nodes, events, rootId, sameAt = () => false) {
  const out = []
  for (const n of nodes.values()) {
    if (n.kind !== 'leaf' || !isAncestorOrSelf(rootId, n.id)) continue
    const approval = list(events).filter((e) => e && e.kind === 'approved' && e.node === n.id).pop()
    const ruled = approval ? netsAt(events, n.id, approval.head_sha, sameAt) : null
    if (ruled && ruled.all) out.push({ id: n.id, nets: ruled.nets })
  }
  return out
}

// ---------------------------------------------------------------- what happens next

/**
 * Pure. What a leaf's close does with one measurement.
 *
 *   command_unknown   the measurement could not run because nobody established a command —
 *                     an investigator's work, never the implementer's
 *   escalate          any other broken measurement (reason = its error kind); a lone
 *                     discriminator failure on a tdd or red leaf (`discriminator_undecidable`)
 *   review | approve  it passed: `review` when the leaf buys a review loop of its own
 *                     (`ownReview`), `approve` otherwise and always for a `verify` leaf
 *   finding           a `verify` leaf failed: that is a finding for the parent, not a fix round,
 *                     because there is no producer to send one to
 *   fix               anything else: a failure an executor can move
 *
 * No counter is consulted on any path.
 *
 * @param {object} m the measurement
 * @param {object} leaf a normalized node
 * @param {string} [producer] the measured round's agent role (see `profileOf`)
 * @param {{nets?: string[], sentBack?: string[]}} [opts] `nets` as `measurementOk` takes it;
 *   `sentBack`, the test files the round before was already sent back as not discriminating
 * @returns {{next: string, reason: string, failures: object[], files?: string[]}}
 */
export function closeDecision(m, leaf, producer = '', { nets = [], sentBack = [] } = {}) {
  const measurement = m && typeof m === 'object' ? m : {}
  const { ok, failures } = measurementOk(measurement, leaf, producer, { nets })
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
  // tests pass at base as well as now cannot be moved by any commit of its own: a test
  // over behaviour that already exists fails at base only if the behaviour is broken first. Buying
  // a fix round to find that out again only makes the wrong verdict sound more confident — which
  // is exactly what repeated rounds did to a field run's regression net before a human overrode
  // the gate. A person rules on it, with the criteria in hand; the likely ruling is that the leaf
  // was `tests-only`, or that a file is a regression net (`lib/boundary.mjs net`, read by `netsAt`).
  //
  // Narrowed to tests that DO pass now. One that does not is unfinished work an implementer can
  // move, and it is a fix round like any other.
  //
  // A red leaf the same way: beside its tests that fail as they must, a file that adds a case and
  // passes at base and now is a test over behaviour that already holds, and no failing test the
  // test-author writes in its place is the one the spec asked for.
  const lone = failures.every((f) => f.check === 'discriminator')
  const disc = list(measurement.discriminator)
  if (lone && profileOf(leaf) === 'tdd' && disc.every((d) => d && d.passes_now)) {
    // The producer is asked first: a test that passes at base may be one that asserts too little.
    // Only a file sent back once and still holding at base is a question for a person.
    const held = disc.filter((d) => addsTest(d) && !d.failed_on_base && !nets.includes(d.test_id)).map((d) => d.test_id)
    if (held.every((f) => list(sentBack).includes(f))) return decide('escalate', 'discriminator_undecidable')
    const told = failures.map((f) => (f.check === 'discriminator'
      ? { ...f, evidence: 'this test passes at the base too, so it pins nothing your change adds: make it fail without your change — assert what the change adds — or say in concerns why it cannot' }
      : f))
    return { next: 'fix', reason: 'discriminator_sent_back', failures: told, files: held }
  }
  if (lone && profileOf(leaf) === 'red') {
    const alone = passesNowAlone(disc, nets)
    const heldAtBase = (d) => d && !d.failed_on_base && d.passes_now
    if (disc.every((d) => d && (alone(d) ? d.passes_now : (d.failed_on_base && !d.passes_now) || heldAtBase(d)))) {
      return decide('escalate', 'discriminator_undecidable')
    }
  }

  return decide('fix', failures.length + ' failing fact(s) an executor can move')
}

// ---------------------------------------------------------------- fix rounds and reviews

/** Pure. Who must change to fix a finding: the cycle's tests (`tests`) or the implementation (`code`, the default). */
export const remedyOf = (finding) => (finding && finding.remedy === 'tests' ? 'tests' : 'code')

/**
 * Pure. Whether a finding asks for a test to go or merge (`remedy: retire`): whatever severity it
 * was given, it never blocks; a cycle's consolidation round acts on it.
 */
export const retires = (finding) => Boolean(finding) && finding.remedy === 'retire'

/**
 * Pure. Whether review round `round` of `leaf` approving owes the cycle's consolidation round first
 * (docs/DESIGN.md#rigor): `leaf` is the last member of a cycle (`cycle`, from `cycleOf`), and no
 * `consolidate` message of an earlier round was recorded for it since its latest replan. The message
 * the approval records is for `round + 1`, so a replayed review owes the same one again.
 */
export function consolidationDue(leaf, cycle, events, round) {
  if (cycle.length < 2 || cycle[cycle.length - 1] !== leaf.id) return false
  const mine = list(events).filter((e) => e && e.node === leaf.id)
  const since = Math.max(0, ...mine.filter((e) => e.kind === 'replanned').map((e) => e.seq || 0))
  return !mine.some((e) => e.kind === 'message' && e.msg === 'consolidate' && e.round <= round && (e.seq || 0) > since)
}

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

/** Pure. A finding that blocks approval: a critical, or a major with a failure scenario on a yardstick leaf; never a `retire`. */
const blocks = (f, yardstick) => !retires(f) && (f.severity === 'critical' ||
  (f.severity === 'major' && yardstick && String(f.failure_scenario || '').trim() !== ''))

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

/** The claim rulings that pass: `equivalent` is a reviewer's, `accepted` the session's on a drift (`boundary.mjs accept`). */
export const PASSING = ['met', 'equivalent', 'accepted']

/** Pure. Whether a claim ruling is a drift that names what goes wrong: only that one stops the folder. */
export const harmfulDrift = (c) => OFF_SPEC.includes(c.ruling) && String(c.failure_scenario || '').trim() !== ''

/**
 * Pure. The one park an integration review earns, or null. A spec defect goes first: fixing work
 * against a claim that cannot be met is wasted. Then criticals and a drift that names its failure
 * scenario, which the user routes to a fix: no single producer owns a folder's merged work. A drift
 * that names none, and what the review could not decide, park nothing: they stand in the claims, never
 * as a pass, and landing puts them before the user (`unsettledClaims`).
 *
 * @returns {{why: string, question: string}|null}
 */
export function integrationPark(findings, claims, specPath) {
  const defects = list(claims).filter((c) => c.ruling === 'spec_defect')
  const drift = list(claims).filter(harmfulDrift)
  const criticals = list(findings).filter((f) => f.severity === 'critical' && !retires(f))
  const why = defects.length ? 'spec_defect' : criticals.length || drift.length ? 'integration_critical' : ''
  if (!why) return null
  const lines = criticals.map((f) => f.id + ': ' + f.claim)
    .concat([...defects, ...drift].map((c) => '[' + c.ruling + '] ' + c.claim + ' — ' + c.evidence + (c.failure_scenario ? ' — fails: ' + c.failure_scenario : '')))
  return { why, question: (why === 'spec_defect' ? 'the spec ' + specPath + ': ' : '') + lines.join('; ') }
}
