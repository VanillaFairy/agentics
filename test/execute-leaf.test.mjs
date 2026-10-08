// test/execute-leaf.test.mjs — pins the leaf unit of the execute program (`runLeaf`): one leaf driven
// over the execution rig, with scripted agents, to approved, stopped, requeue, route or faulted.
// What it pins: a round opened by leaf-open and dispatched with what leaf-open gave (no brief, so
// the waiting messages are delivered), closed by leaf-close against the head it first opened on;
// the close's decision (approve, route, fix, review, command_unknown, stop); the fix rounds and
// their messages; the review loop with a fresh reviewer each round, its units, the blockers
// handed on, the raise, the escalations, and the open set of unruled units that goes to the next
// reviewer instead of the producer; the cycle's test session; the investigator, once per
// execution and process, in a throwaway worktree; requeues, routes and faults by cause; a retry
// the session cleared; a relaunch rebuilt from the records; and a throw inside the unit.
//
// Design: docs/DESIGN.md#executors-and-review.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { reviewerBrief } from '../lib/briefs/execute.mjs'
import { heldOf } from '../lib/boundaries/records.mjs'
import { leafOpen } from '../lib/boundaries/leaf-open.mjs'
import { renderMessage } from '../lib/conversation.mjs'
import { commandsOf, gotchaId, listGotchas } from '../lib/gotchas.mjs'
import { attach } from '../lib/integration.mjs'
import { append, executionLog, readLog } from '../lib/ledger.mjs'
import { acquire } from '../lib/locks.mjs'
import { readOnlyPermissions } from '../lib/locus.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import { programContext } from '../lib/programs/common.mjs'
import { runLeaf } from '../lib/programs/execute/leaf.mjs'
import { loadRole, producerTier, raiseTier, reviewerTier } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { closePath, configPath, dispatchKey, readJson, returnPath, reviewPath, sessionOf, writeJson } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { executionRig } from './harness/program-rig.mjs'

// The rig does not clear NODE_TEST_CONTEXT, and a measurement's nested `node --test` that inherits
// it reports to this runner and exits 0, so every red or tdd test file would read as passing.
delete process.env.NODE_TEST_CONTEXT

const T = { timeout: 300_000 }
const E = 'e1'

// ------------------------------------------------------------------ the world

const CHECK_MJS = "import { readFileSync } from 'node:fs'\nlet ok = false\n" +
  "try { ok = readFileSync('src/' + process.argv[2] + '.txt', 'utf8').trim() === 'ok' } catch {}\nprocess.exit(ok ? 0 : 1)\n"
const FILES = { 'check.mjs': CHECK_MJS, 'pass.mjs': '' }

/** One Plan entry and its criterion. */
function leafEntry(id, { rigor = 'trivial', role = '', after = '', provides = '', locus, check } = {}) {
  const paths = locus ?? ['src/' + id + '.txt']
  const cmd = check ?? 'node check.mjs ' + id
  return [
    '- **' + id + '** — task · realises: D1' + (after ? ' · after: ' + after : '') + ' · rigor: ' + rigor +
      (role ? ' · role: ' + role : '') + (paths.length ? ' · locus: ' + paths.join(', ') : '') +
      (provides ? ' · provides: ' + provides : ''),
    '  Make ' + id,
    '  - [ ] ' + id + ' says ok — check: `' + cmd + '`',
    '',
  ]
}

/** A spec text: the six sections, one Decisions row (none for a planner's), and the Plan entries given. */
function specText(entries, { decisions = true } = {}) {
  return [
    '# Leaf unit', '', '## Intent', '', 'Leaves under test.', '',
    '## Decisions', '', '| id | decision | why |', '|---|---|---|',
    ...(decisions ? ['| D1 | They run. | The unit needs them. |'] : []), '',
    '## Design', '', 'Files under src.', '',
    '## Plan', '', ...entries.flat(),
    '## Open questions', '', '## Evidence', '', 'None yet.', '',
  ].join('\n')
}

const B_LOCUS = ['src/b.txt', 'src/b2.txt']
const YARD = { provides: 'b-file (src/b.txt)' }
const bLeaf = (extra = {}) => leafEntry('b', { locus: B_LOCUS, ...extra })

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()

function write(cwd, files) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(cwd, ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
}

/** Write `files` in `cwd` and commit them; the new head. */
function work(cwd, files, subject = 'work') {
  write(cwd, files)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', subject)
  return git(cwd, 'rev-parse', 'HEAD')
}

const jobKey = (call) => call.role.name + '|' + call.node + '#' + call.round

/**
 * A leg of a world: a program context over `rig` whose `runAgent(call)` first runs the test's job
 * for `<role>|<node>#<round>` (once per dispatch, in the call's worktree), then the real call
 * (`around(call, real)` when a test replaces it). `sleep` replaces the rig's hand-resolved one.
 */
function leg(w, rig, { sleep, around } = {}) {
  const ctx = programContext({
    ...rig.ctx,
    ...(sleep ? { sleep } : {}),
    runAgent: async (call) => {
      if (!w.ran.has(call.dispatch)) {
        w.ran.add(call.dispatch)
        const job = w.jobs[jobKey(call)]
        if (job) await job(call.cwd, call)
      }
      return around ? around(call, rig.ctx.runAgent) : rig.ctx.runAgent(call)
    },
  })
  return { rig, ctx, xc: rig.xc, run: (id = 'b', over = {}) => runLeaf(ctx, rig.xc, { id, ...over }) }
}

/**
 * A world: the rig over the Plan entries given (`leaves`), the spec text given, or the rig's own
 * spec (`rigSpec`); the test's jobs; and a leg over the rig.
 */
function world(t, { leaves, spec, rigSpec = false, commands, files = {} } = {}) {
  const text = rigSpec ? undefined : spec ?? specText(leaves ?? [bLeaf()])
  const rig = executionRig(t, { spec: text, commands, files: { ...FILES, ...files } })
  const w = { rig, jobs: {}, ran: new Set() }
  w.job = (key, fn) => { w.jobs[key] = fn }
  Object.assign(w, leg(w, rig))
  w.leg = (over) => leg(w, rig, over)
  w.relaunch = (over) => leg(w, rig.relaunch(), over)
  return w
}

/** A scenario built once and shared by the tests that read it; its repositories go with `end()`. */
function scenario(build) {
  const cleanups = []
  let made = null
  return {
    get: () => (made ??= build({ after: (fn) => cleanups.push(fn) })),
    end: () => { for (const fn of cleanups) fn() },
  }
}

// ------------------------------------------------------------------ reading the records

const all = (rig) => executionLog(rig.repo, rig.effort, rig.stamp).entries()
const ofKind = (rig, kind, node) => all(rig).filter((e) => e.kind === kind && (node === undefined || e.node === node))
const messages = (rig, thread, msg) => ofKind(rig, 'message').filter((e) => (thread === undefined || e.thread === thread) && (msg === undefined || e.msg === msg))
const stateOf = (rig) => readLog(rig.repo, rig.effort, 'state:' + rig.stamp).entries
const faultsOf = (rig, node = 'b') => ofKind(rig, 'fault', node)
const callsOf = (rig, role, node) => rig.calls.filter((c) => c.role.name === role && (node === undefined || c.node === node))
/** The calls of a role on a node, one per dispatch (a host stop calls the same dispatch again), first start first. */
const startsOf = (rig, role, node) => [...new Map(callsOf(rig, role, node).map((c) => [c.dispatch, c])).values()]
const headOf = (rig, id = 'b') => rig.git('rev-parse', 'refs/heads/' + rig.branchOf(id))
const approvals = (rig, id = 'b') => ofKind(rig, 'approved', id)
const stopsOn = (rig, id = 'b') => [...ofKind(rig, 'escalated', id), ...ofKind(rig, 'parked', id)]
const stepsOf = (rig, key) => ofKind(rig, 'step').filter((e) => e.key === key)
const reviewRecord = (rig, n, id = 'b') => readJson(reviewPath(rig.repo, rig.effort, rig.stamp, id, n))
const keyOf = (node, role, thread, round) => dispatchKey({ node, role, thread, round })
const sessionFor = (rig, { node, role, thread, gen = 0 }) =>
  sessionOf({ effort: rig.effort, execution: rig.stamp, node, role, thread, gen })
const nodeOf = (rig, id = 'b') => readTree(rig.repo, rig.effort).nodes.get(id)
const roleOf = (name) => loadRole(name).role
const sorted = (list) => [...list].sort()

// ------------------------------------------------------------------ scripted steps

const IMPL = 'implementer|b|producer:b'
const REV = (n, id = 'b') => 'reviewer|' + id + '|reviewer:' + id + ':' + n

const done = (text = 'did the work', extra = {}) => ({ output: { status: 'done', text, concerns: [], ...extra } })
const said = (status, text = 'the producer says so') => ({ output: { status, text } })
const stopped = () => ({ status: 'stopped', cause: 'rate_limit' })
const failed = (cause) => ({ status: 'failed', cause })

/** Every unit any world here can produce: a reviewer step rules them all clean unless a test means some unruled. */
const ALL_UNITS = [
  'criterion:1', 'file:src/b.txt', 'file:src/b2.txt', 'file:src/r.mjs', 'file:test/r.test.mjs',
  'file:docs/audit.md', 'file:src/a.mjs', 'file:test/a.test.mjs',
]
const verdict = ({ ruled = ALL_UNITS, findings = [], fix = [] } = {}) => ({
  output: {
    units: ruled.map((unit) => ({ unit, ruling: 'clean', why: 'read it' })),
    findings, fix_rulings: fix, claims: [], notes: '',
  },
})
const finding = (id, extra = {}) => ({
  id, severity: 'critical', claim: 'CLAIM-' + id + ' is wrong', evidence: 'evidence of ' + id, failure_scenario: 'breaks when ' + id, ...extra,
})
const fixed = (id) => ({ id, status: 'fixed', evidence: 'ruled ' + id })
const notFixed = (id) => ({ id, status: 'not_fixed', evidence: 'ruled ' + id })

/** A reviewer thread's quiet end of a killed run: resolves the promise a test awaits and never resolves itself. */
function killer() {
  let hit
  const reached = new Promise((resolveIt) => { hit = resolveIt })
  return { reached, hit, sleep: () => { hit(); return new Promise(() => {}) } }
}

/** Wait for `pred` by the clock: a measurement is a child process, so a count of ticks says nothing about time. */
async function until(pred, label, ms = 120_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail('never reached: ' + label)
}

// ------------------------------------------------------------------ the cycle

const R_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { r } from '../src/r.mjs'\ntest('doubles 2', () => assert.equal(r(2), 4))\n"
const R_TEST_TWO = R_TEST + "test('doubles 3', () => assert.equal(r(3), 6))\n"
const R_TEST_FOUR = R_TEST_TWO + "test('doubles 5', () => assert.equal(r(5), 10))\n"
const R_SRC = 'export const r = (x) => x * 2\n'
const R_BITES = { file: 'src/r.mjs', find: 'x * 2', replace: 'x * 3', expect_failing: ['test/r.test.mjs'] }
/** Let through by the tests of R_TEST_TWO, caught by R_TEST_FOUR. */
const R_SURVIVES = { file: 'src/r.mjs', find: 'x * 2', replace: '(x > 4 ? x : x * 2)', expect_failing: ['test/r.test.mjs'] }

function cycleWorld(t, { triad = false } = {}) {
  const rigor = triad ? 'tdd-triad' : 'tdd-pair'
  return world(t, {
    leaves: [
      leafEntry('r', { rigor, role: 'red', locus: ['test/r.test.mjs'], check: 'node pass.mjs' }),
      leafEntry('g', { rigor, role: 'green', after: 'r', locus: ['src/r.mjs'], check: 'node pass.mjs' }),
      ...(triad ? [leafEntry('au', { rigor, role: 'audit', after: 'g', locus: ['docs/audit.md'], check: 'node pass.mjs' })] : []),
    ],
  })
}

/** The red approved without its own rounds: its branch cut from the effort branch, its test committed, `approved` appended. */
function seedRed(w, test = R_TEST) {
  const { rig } = w
  rig.git('branch', rig.branchOf('r'), rig.branchOf('.'))
  assert.equal(attach(rig.repo, rig.branchOf('r'), rig.worktreeOf('r')).ok, true)
  const head = work(rig.worktreeOf('r'), { 'test/r.test.mjs': test }, 'Pin r')
  rig.log.append('approved', { node: 'r', head_sha: head, review_rounds: 1, at_integration: false })
  return head
}

// ------------------------------------------------------------------ one round

describe('the leaf unit', { concurrency: 4 }, () => {
  test('a leaf measured green with no review loop of its own is approved after one round', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [done()] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 1)
    assert.equal(out.review_rounds, 0)
    assert.equal(out.salvaged, false)
    const ok = approvals(w.rig)
    assert.equal(ok.length, 1)
    assert.equal(ok[0].head_sha, headOf(w.rig))
    assert.equal(callsOf(w.rig, 'reviewer').length, 0, 'no review loop: no reviewer')
    const opened = stepsOf(w.rig, 'opened:b:1')
    assert.equal(opened.length, 1, "the round's first open is journaled")
    assert.match(opened[0].value.base_sha, /^[0-9a-f]{40}$/)
    assert.match(opened[0].value.head_sha, /^[0-9a-f]{40}$/)
  })

  test("a round's dispatch carries leaf-open's role, thread, session, round, tier, permissions, cwd and brief", T, async (t) => {
    const w = world(t)
    const first = await leafOpen(w.xc, { node: 'b', intelligence: 'normal', sleep: w.ctx.sleep })
    assert.equal(first.status, 'opened')
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [done()] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'approved')
    const calls = callsOf(w.rig, 'implementer', 'b')
    assert.equal(calls.length, 1)
    const [call] = calls
    assert.equal(call.role.name, first.role)
    assert.equal(call.thread.key, first.thread)
    assert.equal(call.thread.session, sessionOf({ effort: E, execution: w.rig.stamp, node: first.owner, role: first.role, thread: first.thread, gen: 0 }))
    assert.equal(call.round, first.round)
    assert.equal(call.node, 'b')
    assert.deepEqual(call.tier, first.tier)
    assert.deepEqual(call.permissions, first.permissions)
    assert.equal(resolve(call.cwd), resolve(first.cwd))
    assert.deepEqual(call.schema, schemaOf('producer'))
    assert.equal(call.resume, false)
    assert.equal(call.brief, first.brief, "leaf-open's brief is the prompt: nothing waits on the thread")
    assert.equal(call.briefDigest, fnv1a(first.brief))
    assert.deepEqual(call.briefParts, first.brief_parts)
    const step = stepsOf(w.rig, 'opened:b:1')[0]
    assert.equal(step.value.base_sha, first.base_sha)
    assert.equal(step.value.head_sha, first.head_sha)
  })

  test("the dial reaches the producer's tier and the reviewer's", T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [done()], [REV(1)]: [verdict()] })
    const out = await w.run('b', { intelligence: 'low' })
    assert.equal(out.outcome, 'approved')
    const leaf = nodeOf(w.rig)
    const producerLow = producerTier(leaf, roleOf('implementer'), { intelligence: 'low' })
    const reviewerLow = reviewerTier(leaf, roleOf('reviewer'), { intelligence: 'low' })
    assert.notDeepEqual(producerLow, producerTier(leaf, roleOf('implementer'), { intelligence: 'normal' }), 'the dial is not vacuous for the producer')
    assert.notDeepEqual(reviewerLow, reviewerTier(leaf, roleOf('reviewer'), { intelligence: 'normal' }), 'the dial is not vacuous for the reviewer')
    assert.deepEqual(callsOf(w.rig, 'implementer')[0].tier, producerLow)
    assert.deepEqual(callsOf(w.rig, 'reviewer')[0].tier, reviewerLow)
  })

  test('a verify leaf is measured with no dispatch', T, async (t) => {
    const w = world(t, { leaves: [leafEntry('v', { rigor: 'verify', locus: [], check: 'node pass.mjs' })] })
    const out = await w.run('v')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 1)
    assert.equal(w.rig.calls.length, 0, 'nothing is dispatched')
    assert.equal(ofKind(w.rig, 'dispatched').length, 0)
    assert.equal(approvals(w.rig, 'v').length, 1)
  })

  test('a verify finding under a folder the user wrote parks it needs_respec', T, async (t) => {
    const w = world(t, { leaves: [leafEntry('v', { rigor: 'verify', locus: [], check: 'node check.mjs zz' })] })
    const out = await w.run('v')
    assert.equal(out.outcome, 'stopped')
    assert.equal(w.rig.calls.length, 0, 'nothing is dispatched')
    assert.deepEqual(ofKind(w.rig, 'escalated', 'v').map((e) => e.reason), ['verify_finding'])
    assert.deepEqual(ofKind(w.rig, 'parked', '.').map((e) => e.return), ['needs_respec'])
    assert.equal(approvals(w.rig, 'v').length, 0)
  })

  test('a leaf whose branch holds work from before this execution is reported salvaged', T, async (t) => {
    const w = world(t)
    const { rig } = w
    rig.git('branch', rig.branchOf('b'), rig.branchOf('.'))
    assert.equal(attach(rig.repo, rig.branchOf('b'), rig.worktreeOf('b')).ok, true)
    work(rig.worktreeOf('b'), { 'src/b2.txt': 'earlier\n' }, 'work of an earlier execution')
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    rig.script({ [IMPL]: [done()] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.salvaged, true)
  })

  // ------------------------------------------------------------------ fix rounds

  test('a verification failure sends the producer a fix round in its own session, carrying the failures', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'no\n' }, 'first try'))
    w.job('implementer|b#2', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'fix'))
    w.rig.script({ [IMPL]: [done(), done()] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 2)
    const sent = messages(w.rig, 'producer:b', 'failures')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].round, 2)
    assert.equal(sent[0].payload.source, 'verification')
    assert.ok(sent[0].payload.failures.length > 0)
    const [one, two] = startsOf(w.rig, 'implementer', 'b')
    assert.equal(two.round, 2)
    assert.equal(two.resume, true)
    assert.equal(two.thread.session, one.thread.session, "the fix round is in the producer's own session")
    assert.equal(two.brief, renderMessage({ msg: sent[0].msg, payload: sent[0].payload }))
    assert.deepEqual(two.carries, [sent[0].seq])
  })

  test('the same verification failure twice escalates verify_not_converging', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'no\n' }, 'first try'))
    w.job('implementer|b#2', (cwd) => work(cwd, { 'src/b.txt': 'no again\n' }, 'second try'))
    w.rig.script({ [IMPL]: [done(), done()] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'stopped')
    assert.equal(out.round, 2)
    assert.deepEqual(ofKind(w.rig, 'escalated', 'b').map((e) => e.reason), ['verify_not_converging'])
    assert.equal(approvals(w.rig).length, 0)
  })

  test('a fix round with no commits escalates fix_without_commits', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'no\n' }, 'first try'))
    w.rig.script({ [IMPL]: [done(), done('nothing to do')] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'stopped')
    const stops = ofKind(w.rig, 'escalated', 'b')
    assert.deepEqual(stops.map((e) => e.reason), ['fix_without_commits'])
    const second = startsOf(w.rig, 'implementer', 'b')[1]
    assert.equal(stops[0].said, second.dispatch, "said names the fix round's dispatch")
    assert.equal(stops[0].said, keyOf('b', 'implementer', 'producer:b', 2))
  })

  test("a stop's said names the dispatch whose stored return holds the producer's words", T, async (t) => {
    const w = world(t)
    const WORDS = 'WHICH-FORMAT: json or yaml?'
    w.rig.script({ [IMPL]: [said('needs_decision', WORDS)] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'stopped')
    const parks = ofKind(w.rig, 'parked', 'b')
    assert.equal(parks.length, 1)
    assert.equal(parks[0].return, 'needs_decision')
    assert.equal(parks[0].said, keyOf('b', 'implementer', 'producer:b', 1))
    assert.equal(readJson(returnPath(w.rig.dir, parks[0].said)).text, WORDS)
    assert.equal(ofKind(w.rig, 'escalated', 'b').length, 0)
  })

  test("a retry after a dispatched round resumes the producer's session with the retried message, and the leaf goes on", T, async (t) => {
    const w = world(t)
    const NOTE = 'the format is json, go ahead'
    w.job('implementer|b#2', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'after the retry'))
    w.rig.script({ [IMPL]: [said('blocked', 'cannot tell the format'), done()] })
    const first = await w.run('b')
    assert.equal(first.outcome, 'stopped')
    assert.deepEqual(ofKind(w.rig, 'escalated', 'b').map((e) => e.reason), ['blocked'])
    // What the session's `note` and `retry` write.
    const wrote = append(w.rig.repo, E, 'events', [
      { kind: 'noted', node: 'b', execution: w.rig.stamp, by: 'session', text: NOTE },
      { kind: 'replanned', node: 'b', execution: w.rig.stamp, reason: 'retry_escalated', by: 'session' },
    ])
    assert.equal(wrote.ok, true, JSON.stringify(wrote))
    const second = await w.run('b')
    assert.equal(second.outcome, 'approved')
    assert.equal(second.round, 2)
    assert.equal(faultsOf(w.rig).length, 0)
    const retried = messages(w.rig, 'producer:b', 'retried')
    assert.equal(retried.length, 1)
    assert.equal(retried[0].round, 2)
    assert.deepEqual(retried[0].payload, { reason: 'blocked', notes: [NOTE] })
    const [one, two] = startsOf(w.rig, 'implementer', 'b')
    assert.equal(two.round, 2)
    assert.equal(two.resume, true)
    assert.equal(two.thread.session, one.thread.session)
    assert.equal(two.brief, renderMessage({ msg: 'retried', payload: retried[0].payload }))
    assert.deepEqual(two.carries, [retried[0].seq])
  })

  // ------------------------------------------------------------------ the review loop

  /** A critical in review 1, fixed in round 2 and ruled fixed in review 2; the world is read by several tests. */
  const loop = scenario(async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    const opened = await leafOpen(w.xc, { node: 'b', intelligence: 'normal', sleep: w.ctx.sleep })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n', 'src/b2.txt': 'one\n' }, 'round one'))
    w.job('implementer|b#2', (cwd) => work(cwd, { 'src/b2.txt': 'two\n' }, 'round two'))
    w.rig.script({
      [IMPL]: [done('ROUND-ONE-ACCOUNT'), done('round two account')],
      [REV(1)]: [verdict({ findings: [finding('F1')] })],
      [REV(2)]: [verdict({ fix: [fixed('F1')] })],
    })
    const out = await w.run('b')
    return { w, out, opened }
  })
  describe('the review loop', { concurrency: 4 }, () => {
    after(() => loop.end())

    test('the review loop: a critical sent back, fixed next round, approves after two fresh reviewers', T, async () => {
      const { w, out } = await loop.get()
      assert.equal(out.outcome, 'approved')
      assert.equal(out.round, 2)
      assert.equal(out.review_rounds, 2)
      const reviewers = startsOf(w.rig, 'reviewer', 'b')
      assert.deepEqual(reviewers.map((c) => c.thread.key), ['reviewer:b:1', 'reviewer:b:2'])
      assert.deepEqual(reviewers.map((c) => c.resume), [false, false])
      assert.deepEqual(reviewers.map((c) => c.round), [1, 2], "a reviewer's round is the reviewed producer round")
      const producer = startsOf(w.rig, 'implementer', 'b')[0].thread.session
      const sessions = [producer, ...reviewers.map((c) => c.thread.session)]
      assert.equal(new Set(sessions).size, 3, 'the reviewers and the producer are three sessions')
      const ok = approvals(w.rig)
      assert.equal(ok.length, 1)
      assert.equal(ok[0].review_rounds, 2)
      assert.equal(ok[0].head_sha, headOf(w.rig))
    })

    test("a reviewer runs fresh, read-only, in the leaf's worktree, on the reviewer's tier", T, async () => {
      const { w, opened } = await loop.get()
      const leaf = nodeOf(w.rig)
      const reviewer = roleOf('reviewer')
      const [one, two] = startsOf(w.rig, 'reviewer', 'b')
      for (const call of [one, two]) {
        assert.equal(call.node, 'b')
        assert.equal(call.resume, false)
        assert.equal(resolve(call.cwd), resolve(w.rig.worktreeOf('b')))
        assert.deepEqual(call.permissions, readOnlyPermissions(reviewer))
        assert.deepEqual(call.tier, reviewerTier(leaf, reviewer, { intelligence: 'normal' }))
        assert.deepEqual(call.schema, schemaOf('reviewer'))
        assert.equal(call.role.name, 'reviewer')
      }
      // Its prompt is reviewerBrief over the span, the producer's return and the units (the leaf's brief as its producer has it ends it).
      const MARK = '@@LEAF-BRIEF@@'
      const record = reviewRecord(w.rig, 1)
      const lead = reviewerBrief({
        leaf, brief: MARK, span: { base: opened.base_sha, head: record.head_sha },
        producer: { status: 'done', concerns: [], text: 'ROUND-ONE-ACCOUNT' }, units: record.units, prior: [],
      }).split(MARK)[0]
      assert.ok(one.brief.startsWith(lead), "review 1's prompt is reviewerBrief's: the span, the return, the units")
      assert.ok(one.brief.includes(opened.brief.trim()), "and the leaf's brief as its producer has it")
    })

    test('a review rules each criterion and each file the span changed', T, async () => {
      const { w } = await loop.get()
      const record = reviewRecord(w.rig, 1)
      assert.equal(record.units[0], 'criterion:1')
      assert.deepEqual(sorted(record.units.slice(1)), ['file:src/b.txt', 'file:src/b2.txt'])
      assert.equal(record.units.length, 3)
    })

    test('a later review rules only the files of the fix span', T, async () => {
      const { w } = await loop.get()
      const record = reviewRecord(w.rig, 2)
      assert.equal(record.units[0], 'criterion:1')
      assert.deepEqual(record.units.slice(1), ['file:src/b2.txt'], 'the fix round changed one file')
    })

    test('the next reviewer is handed the blockers the round before left open', T, async () => {
      const { w } = await loop.get()
      const [one, two] = startsOf(w.rig, 'reviewer', 'b')
      assert.ok(two.brief.includes(finding('F1').claim), "review 2's prompt names the claim review 1 left open")
      assert.ok(!one.brief.includes(finding('F1').claim), "review 1's does not")
    })

    test("a fix round resumes the producer's session with the open findings as its prompt", T, async () => {
      const { w } = await loop.get()
      const sent = messages(w.rig, 'producer:b', 'findings')
      assert.equal(sent.length, 1)
      assert.equal(sent[0].round, 2)
      assert.ok(sent[0].payload.findings.some((f) => f.id === 'F1'))
      const [one, two] = startsOf(w.rig, 'implementer', 'b')
      assert.equal(two.round, 2)
      assert.equal(two.resume, true)
      assert.equal(two.thread.session, one.thread.session)
      assert.equal(two.brief, renderMessage({ msg: 'findings', payload: sent[0].payload }))
      assert.deepEqual(two.carries, [sent[0].seq])
    })
  })

  test('a round after a review that cleared none of its blockers is a fresh session on the raised tier', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n', 'src/b2.txt': 'one\n' }, 'round one'))
    w.job('implementer|b#2', (cwd) => work(cwd, { 'src/b2.txt': 'two\n' }, 'round two'))
    w.job('implementer|b#3', (cwd) => work(cwd, { 'src/b2.txt': 'three\n' }, 'round three'))
    w.rig.script({
      [IMPL]: [done(), done(), done()],
      [REV(1)]: [verdict({ findings: [finding('F1')] })],
      [REV(2)]: [verdict({ fix: [notFixed('F1')] })],
      [REV(3)]: [verdict({ fix: [fixed('F1')] })],
    })
    const out = await w.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 3)
    assert.equal(out.review_rounds, 3)
    const renewals = stateOf(w.rig).filter((e) => e.kind === 'thread_renewed' && e.thread === 'producer:b')
    assert.equal(renewals.length, 1, 'renewed once')
    assert.equal(renewals[0].gen, 1)
    assert.equal(renewals[0].why, 'raised')
    const [one, two, three] = startsOf(w.rig, 'implementer', 'b')
    assert.equal(two.resume, true)
    assert.equal(three.round, 3)
    assert.equal(three.resume, false)
    assert.equal(three.thread.gen, 1)
    assert.equal(three.thread.session, sessionFor(w.rig, { node: 'b', role: 'implementer', thread: 'producer:b', gen: 1 }))
    assert.notEqual(three.thread.session, one.thread.session)
    assert.deepEqual(three.tier, raiseTier(two.tier))
    assert.notDeepEqual(three.tier, two.tier)
    const dispatchedThree = ofKind(w.rig, 'dispatched', 'b').find((e) => e.dispatch === three.dispatch)
    assert.ok(renewals[0].seq < dispatchedThree.seq, 'the renewal comes before the call')
  })

  test('a prior blocker ruled not_fixed and not re-reported stays open, and not fixed twice escalates', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n', 'src/b2.txt': 'one\n' }, 'round one'))
    w.job('implementer|b#2', (cwd) => work(cwd, { 'src/b2.txt': 'two\n' }, 'round two'))
    w.job('implementer|b#3', (cwd) => work(cwd, { 'src/b2.txt': 'three\n' }, 'round three'))
    w.rig.script({
      [IMPL]: [done(), done(), done()],
      [REV(1)]: [verdict({ findings: [finding('F1')] })],
      [REV(2)]: [verdict({ fix: [notFixed('F1')] })],
      [REV(3)]: [verdict({ fix: [notFixed('F1')] })],
    })
    const out = await w.run('b')
    assert.equal(out.outcome, 'stopped')
    assert.equal(out.review_rounds, 3)
    assert.equal(out.round, 3)
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 3, 'review 2 left F1 open although nobody re-reported it')
    const stops = ofKind(w.rig, 'escalated', 'b')
    assert.deepEqual(stops.map((e) => e.reason), ['review_not_converging'])
    assert.equal(stops[0].said, keyOf('b', 'reviewer', 'reviewer:b:3', 3), "said is the third reviewer's dispatch")
    assert.equal(approvals(w.rig).length, 0)
  })

  test('a review that leaves units unruled goes to a fresh reviewer, not to the producer', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n', 'src/b2.txt': 'one\n' }, 'round one'))
    w.rig.script({
      [IMPL]: [done()],
      [REV(1)]: [verdict({ ruled: ['criterion:1'] })],
      [REV(2)]: [verdict()],
    })
    const out = await w.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 1)
    assert.equal(out.review_rounds, 2)
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 1, 'no producer round 2')
    const reviewers = startsOf(w.rig, 'reviewer', 'b')
    assert.deepEqual(reviewers.map((c) => c.thread.key), ['reviewer:b:1', 'reviewer:b:2'])
    assert.deepEqual(reviewers.map((c) => c.round), [1, 1], 'the same producer round')
    assert.deepEqual(reviewers.map((c) => c.resume), [false, false])
    const first = reviewRecord(w.rig, 1)
    assert.equal(first.next, 'fix')
    assert.ok(first.open.length > 0 && first.open.every((o) => String(o.id).startsWith('unit:')), 'what stayed open is unruled units alone')
    assert.deepEqual(messages(w.rig, 'producer:b'), [], 'no message waits on the producer, whatever its kind')
    assert.equal(approvals(w.rig).length, 1)
  })

  test('a reviewer dispatch that fails holds the leaf on a fault', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'round one'))
    w.rig.script({ [IMPL]: [done()], [REV(1)]: [failed('host_error')] })
    const out = await w.run('b')
    assert.equal(out.outcome, 'faulted')
    const faults = faultsOf(w.rig)
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'host_error')
    assert.ok(heldOf(stateOf(w.rig)).has('b'))
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 1, 'no producer round follows')
    assert.deepEqual(stopsOn(w.rig), [])
    assert.equal(approvals(w.rig).length, 0)
  })

  test('a review that comes back without findings holds the leaf on a role fault', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'round one'))
    w.rig.script({
      [IMPL]: [done()],
      [REV(1)]: [{ output: { units: ALL_UNITS.map((unit) => ({ unit, ruling: 'clean', why: 'read it' })), claims: [], notes: '' } }],
    })
    const out = await w.run('b')
    assert.equal(out.outcome, 'faulted')
    const faults = faultsOf(w.rig)
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'role')
    assert.ok(heldOf(stateOf(w.rig)).has('b'))
    assert.equal(startsOf(w.rig, 'implementer', 'b').length, 1, 'no producer round follows')
    assert.equal(startsOf(w.rig, 'reviewer', 'b').length, 1)
    assert.equal(approvals(w.rig).length, 0)
  })

  // ------------------------------------------------------------------ a cycle

  test("a green whose review finds a test gap gets a test-author round on the cycle's test session", T, async (t) => {
    const w = cycleWorld(t)
    seedRed(w)
    w.job('implementer|g#1', (cwd) => work(cwd, { 'src/r.mjs': R_SRC }, 'implement r'))
    w.job('test-author|g#2', (cwd) => write(cwd, { 'test/r.test.mjs': R_TEST_TWO }))
    w.rig.script({
      'implementer|g|producer:g': [done()],
      'reviewer|g|reviewer:g:1': [verdict({ findings: [finding('R1', { remedy: 'tests' })] })],
      'test-author|g|producer:r': [done('pinned doubles 3', { mutations: [R_BITES] })],
      'reviewer|g|reviewer:g:2': [verdict({ fix: [fixed('R1')] })],
    })
    const out = await w.run('g')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 2)
    assert.equal(out.review_rounds, 2)
    assert.equal(startsOf(w.rig, 'implementer', 'g').length, 1, 'its implementer ran once')
    const authors = startsOf(w.rig, 'test-author', 'g')
    assert.equal(authors.length, 1)
    assert.equal(authors[0].round, 2)
    assert.equal(authors[0].thread.key, 'producer:r')
    assert.equal(authors[0].thread.session, sessionFor(w.rig, { node: 'r', role: 'test-author', thread: 'producer:r', gen: 0 }), "the red's generation-0 session")
    const sent = messages(w.rig, 'producer:r', 'findings')
    assert.equal(sent.length, 1)
    assert.ok(authors[0].brief.includes(renderMessage({ msg: 'findings', payload: sent[0].payload })), 'the test round carries the finding')
    assert.equal(approvals(w.rig, 'g').length, 1)
  })

  test("a green's needs_tests goes to the cycle's test session, and tests_ready comes back to the implementer", T, async (t) => {
    const w = cycleWorld(t)
    seedRed(w)
    const ASK = 'r is doubled for 2 only; only a test can pin 3'
    w.job('implementer|g#1', (cwd) => work(cwd, { 'src/r.mjs': R_SRC }, 'implement r'))
    w.job('test-author|g#2', (cwd) => write(cwd, { 'test/r.test.mjs': R_TEST_TWO }))
    w.job('implementer|g#3', (cwd) => work(cwd, { 'src/r.mjs': R_SRC + '// round three\n' }, 'answer the finding'))
    w.rig.script({
      'implementer|g|producer:g': [said('needs_tests', ASK), done()],
      'test-author|g|producer:r': [done('pinned doubles 3', { mutations: [R_BITES] })],
      'reviewer|g|reviewer:g:1': [verdict({ findings: [finding('F1')] })],
      'reviewer|g|reviewer:g:2': [verdict({ fix: [fixed('F1')] })],
    })
    const out = await w.run('g')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 3)
    const asked = messages(w.rig, 'producer:r', 'needs_tests')
    assert.equal(asked.length, 1)
    assert.equal(asked[0].round, 2)
    assert.equal(asked[0].payload.text, ASK)
    const [author] = startsOf(w.rig, 'test-author', 'g')
    assert.equal(author.round, 2)
    assert.equal(author.thread.key, 'producer:r')
    assert.ok(author.carries.includes(asked[0].seq), 'the test round carries the request')
    const ready = messages(w.rig, 'producer:g', 'tests_ready')
    assert.equal(ready.length, 1)
    assert.deepEqual(ready[0].payload.files, ['test/r.test.mjs'])
    const [one, three] = startsOf(w.rig, 'implementer', 'g')
    assert.equal(three.round, 3)
    assert.equal(three.resume, true)
    assert.equal(three.thread.session, one.thread.session, "the implementer's own session")
    assert.ok(three.carries.includes(ready[0].seq), 'round 3 carries tests_ready')
    assert.ok(three.brief.includes(renderMessage({ msg: 'tests_ready', payload: ready[0].payload })))
    assert.equal(approvals(w.rig, 'g').length, 1)
  })

  test("the cycle's test session is the red's own across the green's and the audit's rounds", T, async (t) => {
    const w = cycleWorld(t, { triad: true })
    w.job('test-author|r#1', (cwd) => write(cwd, { 'test/r.test.mjs': R_TEST }))
    w.job('implementer|g#1', (cwd) => work(cwd, { 'src/r.mjs': R_SRC }, 'implement r'))
    w.job('test-author|g#2', (cwd) => write(cwd, { 'test/r.test.mjs': R_TEST_TWO }))
    w.job('test-author|au#1', (cwd) => write(cwd, { 'test/r.test.mjs': R_TEST_FOUR }))
    w.rig.script({
      'test-author|r|producer:r': [done('red')],
      'reviewer|r|reviewer:r:1': [verdict()],
      'implementer|g|producer:g': [done()],
      'reviewer|g|reviewer:g:1': [verdict({ findings: [finding('R1', { remedy: 'tests' })] })],
      'test-author|g|producer:r': [done('doubles 3', { mutations: [R_BITES] })],
      'reviewer|g|reviewer:g:2': [verdict({ fix: [fixed('R1')] })],
      'test-author|au|producer:r': [done('doubles 5', { mutations: [] })],
      'reviewer|au|reviewer:au:1': [verdict()],
    })
    const red = await w.run('r')
    assert.equal(red.outcome, 'approved', JSON.stringify(red))
    const green = await w.run('g')
    assert.equal(green.outcome, 'approved', JSON.stringify(green))

    // The audit's test round without an auditor round: the record leaf-close would have left, and the message it would have sent.
    w.rig.log.append('verify-observed', { node: 'au', head_sha: '', mutations: [{ ...R_SURVIVES, applied: true, bites: false }] })
    const sent = w.rig.log.append('message', {
      node: 'au', thread: 'producer:r', from: 'code', msg: 'surviving_mutations', payload: { mutations: [R_SURVIVES] }, round: 1,
    }).seq
    const audit = await w.run('au')

    const session = sessionFor(w.rig, { node: 'r', role: 'test-author', thread: 'producer:r', gen: 0 })
    const [own] = startsOf(w.rig, 'test-author', 'r')
    assert.equal(own.thread.session, session)
    assert.equal(own.resume, false, "the red's first call starts the session")
    const [onGreen] = startsOf(w.rig, 'test-author', 'g')
    assert.equal(onGreen.thread.key, 'producer:r')
    assert.equal(onGreen.resume, true, "the green's test round resumes the red's session")
    assert.equal(onGreen.thread.session, session)
    const [onAudit] = startsOf(w.rig, 'test-author', 'au')
    assert.equal(onAudit.thread.key, 'producer:r')
    assert.equal(onAudit.resume, true, "the audit's test round resumes the red's session")
    assert.equal(onAudit.thread.session, session)
    assert.ok(onAudit.carries.includes(sent), 'and carries the surviving mutations')
    assert.equal(audit.outcome, 'approved', JSON.stringify(audit))
  })

  // ------------------------------------------------------------------ the investigator

  const COMMAND = (name, value) => ({
    kind: 'command', roles: ['implementer', 'investigator'], paths: [], trigger: 'running ' + name, action: 'use it',
    evidence: { command: name, output: 'ok' }, command: { name, value },
  })
  const ABSENT = (name) => ({ ...COMMAND(name, ''), command: { name, value: '', absent: true } })
  const SUITE = 'node --test --test-reporter=spec'
  const TEST_ONE = 'node --test --test-reporter=spec {file}'
  const ESTABLISHED = () => [ABSENT('build'), ABSENT('typecheck'), COMMAND('suite', SUITE), COMMAND('test_one', TEST_ONE)]
  const investigated = () => ({
    output: { commands: ESTABLISHED(), established: ['build', 'typecheck', 'suite', 'test_one'], unresolved: [], text: 'found them' },
  })
  const A_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { a } from '../src/a.mjs'\ntest('a is 1', () => assert.equal(a(), 1))\n"

  test('command_unknown: the investigator establishes commands once in a throwaway worktree, then the leaf closes again', T, async (t) => {
    const w = world(t, { rigSpec: true, commands: {} })
    w.job('implementer|a#1', (cwd) => work(cwd, { 'src/a.mjs': 'export const a = () => 1\n', 'test/a.test.mjs': A_TEST }, 'make a'))
    w.rig.script({
      'implementer|a|producer:a': [done()],
      'investigator|.|investigator': [investigated()],
    })
    let seen = null
    const around = async (call, real) => {
      if (call.role.name === 'investigator') {
        seen = { cwd: call.cwd, existed: existsSync(call.cwd), head: git(call.cwd, 'rev-parse', 'HEAD'), listed: git(w.rig.repo, 'worktree', 'list', '--porcelain') }
      }
      return real(call)
    }
    const out = await w.leg({ around }).run('a')
    assert.equal(out.outcome, 'approved', JSON.stringify(out))
    assert.equal(out.round, 1)
    assert.equal(startsOf(w.rig, 'implementer', 'a').length, 1, 'the same round is closed again, not dispatched again')
    const calls = callsOf(w.rig, 'investigator')
    assert.equal(calls.length, 1, 'once')
    const [call] = calls
    assert.equal(call.thread.key, 'investigator')
    assert.equal(call.node, '.', "the envelope's root")
    assert.equal(call.round, 1)
    assert.deepEqual(call.schema, schemaOf('investigator'))
    assert.equal(call.thread.session, sessionFor(w.rig, { node: '.', role: 'investigator', thread: 'investigator' }))
    assert.ok(seen && seen.existed, 'the throwaway worktree existed during the call')
    assert.notEqual(resolve(seen.cwd), resolve(w.rig.worktreeOf('a')), "not the leaf's worktree")
    assert.notEqual(resolve(seen.cwd), resolve(w.rig.repo), 'not the repository')
    assert.ok(seen.cwd.includes('investigate-' + w.rig.effort + '-' + w.rig.stamp))
    assert.equal(seen.head, w.rig.base_sha, "detached at the envelope's base_sha")
    assert.equal(existsSync(seen.cwd), false, 'removed after the call')
    assert.ok(!git(w.rig.repo, 'worktree', 'list', '--porcelain').includes('investigate-'), 'and no longer known to git')
    const found = commandsOf(w.rig.repo, w.rig.effort)
    assert.equal(found.suite, SUITE)
    assert.equal(found.test_one, TEST_ONE)
    const ids = new Set(listGotchas(w.rig.repo, w.rig.effort).map((g) => g.id))
    for (const g of ESTABLISHED()) assert.ok(ids.has(gotchaId(g)), gotchaId(g) + ' is a gotcha')
    assert.equal(approvals(w.rig, 'a').length, 1)
  })

  test('two leaves that find no command at once share one investigator', T, async (t) => {
    const w = world(t, {
      leaves: [leafEntry('b', { locus: ['src/b.txt'] }), leafEntry('c', { locus: ['src/c.txt'] })],
      commands: {},
    })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.job('implementer|c#1', (cwd) => work(cwd, { 'src/c.txt': 'ok\n' }, 'make c'))
    w.rig.script({
      'implementer|b|producer:b': [done()],
      'implementer|c|producer:c': [done()],
      'investigator|.|investigator': [investigated(), investigated()],
    })
    const closed = (id) => existsSync(closePath(w.rig.repo, w.rig.effort, w.rig.stamp, id, 'implementer', 1))
    // The call is held until both leaves have closed on command_unknown, so the second asks while the first is in flight.
    const around = async (call, real) => {
      if (call.role.name === 'investigator') await until(() => closed('b') && closed('c'), 'both leaves closed')
      return real(call)
    }
    const run = w.leg({ around })
    const [one, two] = await Promise.all([run.run('b'), run.run('c')])
    assert.equal(one.outcome, 'approved', JSON.stringify(one))
    assert.equal(two.outcome, 'approved', JSON.stringify(two))
    assert.equal(callsOf(w.rig, 'investigator').length, 1, 'one call, shared')
    assert.equal(approvals(w.rig, 'b').length, 1)
    assert.equal(approvals(w.rig, 'c').length, 1)
  })

  // ------------------------------------------------------------------ requeues, routes and faults

  test('no slot: the leaf goes back to the scheduler, nothing dispatched', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(), leafEntry('x', { locus: ['src/x.txt'] })] })
    writeJson(configPath(w.rig.repo), { max_parallel: 1 })
    const held = acquire(w.rig.repo, { effort: E, execution: w.rig.stamp, node: 'x', locus: ['src/x.txt'], waitMs: 0 })
    assert.equal(held.ok, true, JSON.stringify(held))
    w.rig.script({})
    const out = await w.run('b')
    assert.equal(out.outcome, 'requeue')
    assert.equal(w.rig.calls.length, 0)
    assert.equal(ofKind(w.rig, 'dispatched', 'b').length, 0)
    assert.deepEqual(faultsOf(w.rig), [])
    assert.deepEqual(stopsOn(w.rig), [])
  })

  test('a locus another leaf holds: the leaf goes back to the scheduler, nothing dispatched', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(), leafEntry('x', { locus: ['src/x.txt', 'src/b.txt'] })] })
    const held = acquire(w.rig.repo, { effort: E, execution: w.rig.stamp, node: 'x', locus: ['src/x.txt', 'src/b.txt'], waitMs: 0 })
    assert.equal(held.ok, true, JSON.stringify(held))
    w.rig.script({})
    const out = await w.run('b')
    assert.equal(out.outcome, 'requeue')
    assert.equal(w.rig.calls.length, 0)
    assert.equal(ofKind(w.rig, 'dispatched', 'b').length, 0)
    assert.deepEqual(faultsOf(w.rig), [])
  })

  test("needs_context under a planner's folder comes back as a route to that planner", T, async (t) => {
    const root = specText([['- **f** — sub-effort · realises: D1 · author: planner', '  Fold f', '']])
    // A planner-written spec states no decision of its own: its task realises the root's D1.
    const sub = specText([leafEntry('b', { locus: ['src/b.txt'] })], { decisions: false })
    const w = world(t, { spec: { '.': root, f: sub } })
    const ASKED = 'which format does the folder want?'
    w.rig.script({ 'implementer|f/b|producer:f/b': [said('needs_context', ASKED)] })
    const out = await w.run('f/b')
    assert.equal(out.outcome, 'route')
    assert.equal(out.route.folder, 'f')
    assert.equal(out.route.request.node, 'f/b')
    assert.equal(out.route.request.status, 'needs_context')
    assert.equal(out.route.request.text, ASKED)
    assert.deepEqual(stopsOn(w.rig, 'f/b'), [], 'the leaf is not parked')
    assert.deepEqual(stopsOn(w.rig, 'f'), [], 'nor the folder')
  })

  /** A dispatch that failed: the fault it records, the leaf it holds, and no question. */
  function assertFaulted(w, out, channel) {
    assert.equal(out.outcome, 'faulted')
    const faults = faultsOf(w.rig)
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, channel)
    assert.ok(heldOf(stateOf(w.rig)).has('b'), 'the leaf is held')
    assert.deepEqual(stopsOn(w.rig), [], 'no escalation, no park')
    assert.equal(approvals(w.rig).length, 0)
  }

  test('a dispatch that failed schema_failed is a role fault, and the leaf is held', T, async (t) => {
    const w = world(t)
    w.rig.script({ [IMPL]: [failed('schema_failed'), failed('schema_failed')] })
    assertFaulted(w, await w.run('b'), 'role')
  })

  test('a dispatch that failed host_error is a host_error fault, and the leaf is held', T, async (t) => {
    const w = world(t)
    w.rig.script({ [IMPL]: [failed('host_error')] })
    assertFaulted(w, await w.run('b'), 'host_error')
  })

  for (const cause of ['checkout', 'watch_failed']) {
    test(`a dispatch that failed ${cause} is a checkout fault, and the leaf is held`, T, async (t) => {
      const w = world(t)
      const around = async (call) => ({ status: 'failed', cause, message: 'the host said ' + cause, session: call.thread.session })
      assertFaulted(w, await w.leg({ around }).run('b'), 'checkout')
    })
  }

  test('a throw inside the unit is a program fault on the leaf', T, async (t) => {
    const w = world(t)
    w.rig.script({})
    const out = await w.run('b')
    assert.equal(out.outcome, 'faulted')
    const faults = faultsOf(w.rig)
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'program')
    assert.ok(heldOf(stateOf(w.rig)).has('b'))
    assert.deepEqual(stopsOn(w.rig), [])
  })

  // ------------------------------------------------------------------ a relaunch

  test('a relaunch resumes a cut-off producer in its own session', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [stopped()] })
    const k = killer()
    w.leg({ sleep: k.sleep }).run('b').catch(() => {})
    await k.reached
    const cut = startsOf(w.rig, 'implementer', 'b')[0]
    assert.ok(cut, 'the first run called the producer')
    const again = w.relaunch()
    again.rig.script({ [IMPL]: [done()] })
    const out = await again.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 1)
    assert.equal(again.rig.calls.length, 1)
    const [call] = again.rig.calls
    assert.equal(call.dispatch, cut.dispatch, 'the same dispatch')
    assert.equal(call.resume, true)
    assert.equal(call.thread.session, cut.thread.session)
    assert.equal(call.brief, renderMessage({ msg: 'cut_off' }))
  })

  test('a fix round cut off after it committed is judged on relaunch against the head it first opened on', T, async (t) => {
    const w = world(t)
    let headBefore = ''
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'no\n' }, 'first try'))
    w.job('implementer|b#2', (cwd) => {
      headBefore = git(cwd, 'rev-parse', 'HEAD')
      work(cwd, { 'src/b.txt': 'ok\n' }, 'fix')
    })
    w.rig.script({ [IMPL]: [done(), stopped()] })
    const k = killer()
    w.leg({ sleep: k.sleep }).run('b').catch(() => {})
    await k.reached
    assert.notEqual(headBefore, '')
    const again = w.relaunch()
    again.rig.script({ [IMPL]: [done()] })
    const out = await again.run('b')
    assert.equal(ofKind(again.rig, 'escalated', 'b').length, 0, 'a head moved by the round itself is not a fix without commits')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 2)
    const opened = stepsOf(again.rig, 'opened:b:2')
    assert.equal(opened.length, 1)
    assert.equal(opened[0].value.head_sha, headBefore, 'the head the round first opened on')
    assert.equal(again.rig.calls.length, 1)
    assert.equal(again.rig.calls[0].resume, true)
  })

  test('a round whose call returned but was never closed is closed on relaunch, not dispatched again', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [done()] })
    const k = killer()
    const around = async (call, real) => {
      await real(call)
      k.hit()
      return new Promise(() => {})
    }
    w.leg({ around }).run('b').catch(() => {})
    await k.reached
    const closePathB = closePath(w.rig.repo, w.rig.effort, w.rig.stamp, 'b', 'implementer', 1)
    assert.equal(existsSync(closePathB), false, 'killed before the close')
    const again = w.relaunch()
    again.rig.script({})
    const out = await again.run('b')
    assert.equal(again.rig.calls.length, 0, 'no call')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.round, 1)
    assert.equal(existsSync(closePathB), true, 'its close record is written')
    assert.equal(approvals(again.rig).length, 1)
  })

  test('a round closed on relaunch whose stored return is gone holds the leaf on a role fault', T, async (t) => {
    const w = world(t)
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [done()] })
    const k = killer()
    const around = async (call, real) => {
      await real(call)
      k.hit()
      return new Promise(() => {})
    }
    w.leg({ around }).run('b').catch(() => {})
    await k.reached
    rmSync(returnPath(w.rig.dir, keyOf('b', 'implementer', 'producer:b', 1)))
    const again = w.relaunch()
    again.rig.script({})
    const out = await again.run('b')
    assert.equal(again.rig.calls.length, 0, 'no call')
    assert.equal(out.outcome, 'faulted')
    const faults = faultsOf(again.rig)
    assert.equal(faults.length, 1)
    assert.equal(faults[0].channel, 'role')
    assert.ok(heldOf(stateOf(again.rig)).has('b'))
    assert.equal(approvals(again.rig).length, 0)
  })

  test('a relaunch resumes a reviewer cut off mid-review in its own session and dispatches no producer round', T, async (t) => {
    const w = world(t, { leaves: [bLeaf(YARD)] })
    w.job('implementer|b#1', (cwd) => work(cwd, { 'src/b.txt': 'ok\n' }, 'make b'))
    w.rig.script({ [IMPL]: [done()], [REV(1)]: [stopped()] })
    const k = killer()
    w.leg({ sleep: k.sleep }).run('b').catch(() => {})
    await k.reached
    const cut = startsOf(w.rig, 'reviewer', 'b')[0]
    assert.ok(cut, 'the first run called the reviewer')
    const again = w.relaunch()
    again.rig.script({ [REV(1)]: [verdict()] })
    const out = await again.run('b')
    assert.equal(out.outcome, 'approved')
    assert.equal(out.review_rounds, 1)
    assert.equal(out.round, 1)
    assert.equal(again.rig.calls.length, 1, "the relaunch's only call is the reviewer's")
    const [call] = again.rig.calls
    assert.equal(call.role.name, 'reviewer')
    assert.equal(call.dispatch, cut.dispatch)
    assert.equal(call.resume, true)
    assert.equal(call.thread.session, cut.thread.session)
    assert.equal(call.brief, renderMessage({ msg: 'cut_off' }))
    assert.equal(approvals(again.rig).length, 1)
    assert.equal(approvals(again.rig)[0].review_rounds, 1)
  })
})
