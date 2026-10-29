// test/boundaries-spec.test.mjs — pins the autonomous review's boundaries run in-process
// (lib/boundaries/spec.mjs): specCheck, specReviewed, specSettle, specGate and specPrepare, each
// `(xc, args)` over an execution context. What a planner said is read from its stored return, a
// round from a nested probe's result object, and what the planner was told from the `problems` and
// `refusals` messages on its thread. Every stop, fault and message goes through `recordAll`, so a
// call run again records nothing twice.
//
// Design: docs/DESIGN.md#autonomous-review.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { executionContext } from '../lib/boundaries/records.mjs'
import { specCheck, specGate, specPrepare, specReviewed, specSettle } from '../lib/boundaries/spec.mjs'
import {
  approvalState, recordApproval, recordDisposition, recordPreparation, recordReviewed,
} from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { renderMessage } from '../lib/conversation.mjs'
import { executionLog, readLog } from '../lib/ledger.mjs'
import { checkFolder, hashSpec } from '../lib/spec.mjs'
import { ROOT_ID, branchOf, dispatchKey, posix, returnPath, specPath } from '../lib/store.mjs'
import { schedule } from '../lib/schedule.mjs'
import { readTree } from '../lib/tree.mjs'
import { STAMP, repo } from './harness/boundary-fixture.mjs'

const E = 'e1'
const REVIEW = '20261005-120000.probe'
const REVIEW_2 = '20261005-130000.probe'

// ------------------------------------------------------------------ the repository

const ROOT_SPEC = [
  '# The change', '', '## Intent', '', 'Make the change.', '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|', '| D1 | do it | asked for |', '',
  '## Design', '', 'A sub-effort the planner writes and a task.', '',
  '## Plan', '',
  '- **p** — sub-effort · author: planner', '  Build p.', '  The planner writes its spec.',
  '- **q** — task · realises: D1 · rigor: tdd · expects: src/q.mjs', '  Add q.', '  Write q and its test.',
  '  - [ ] q works — check: `node --test test/add.test.mjs`', '',
  '## Open questions', '', '## Evidence', '', 'None gathered.', '',
].join('\n')

/** The folder's spec: one task `x` realising D1; each option is one way a test changes it. */
const folderSpec = ({ expects = 'src/x.mjs, test/x.test.mjs', extra = '', after = '', design = 'One function.', title = 'Add x.', rigor = 'tdd', decisions = [], plan } = {}) => [
  '# Build p', '', '## Intent', '', 'Build p, as the root plans it.', '',
  '## Decisions', ...(decisions.length ? ['', '| id | decision | why |', '|---|---|---|', ...decisions.map(([id, text]) => '| ' + id + ' | ' + text + ' | faster |')] : []), '',
  '## Design', '', design, '', ...(extra ? [extra, ''] : []),
  '## Plan', '',
  ...(plan || ['- **x** — task · realises: D1 · rigor: ' + rigor + ' · expects: ' + expects + after, '  ' + title, '  Write x and its test.',
    '  - [ ] x works — check: `node --test test/x.test.mjs`']), '',
  '## Open questions', '', '## Evidence', '', 'The root\'s.', '',
].join('\n')

const put = (r, folder, text) => {
  const path = specPath(r, E, folder)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** An execution context over a repository whose root is approved and compiled; `spec` is the folder's spec (null: none written). */
function rig(t, { spec = folderSpec(), root = ROOT_SPEC } = {}) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  put(r, '.', root)
  assert.equal(recordApproval(r, E, '.').ok, true)
  assert.equal(compileEffort(r, E).ok, true)
  if (spec !== null) put(r, 'p', spec)
  return executionContext({ repo: r, effort: E, execution: STAMP, log: executionLog(r, E, STAMP) })
}

/** The same execution seen by a process that started again: a fresh log port over what is on disk. */
const restarted = (xc) => executionContext({ repo: xc.repo, effort: E, execution: STAMP, log: executionLog(xc.repo, E, STAMP) })

// ------------------------------------------------------------------ what is on disk

const events = (xc, kind, pred = () => true) => readTree(xc.repo, E).events.filter((e) => e.kind === kind && pred(e))
const messages = (xc, msg) => events(xc, 'message', (e) => e.node === 'p' && e.thread === 'planner:p' && (!msg || e.msg === msg))
const ledger = (xc, kind, folder = 'p') => readLog(xc.repo, E, 'ledger').entries.filter((e) => e.kind === kind && e.folder === folder)
const stateLines = (xc, kind) => readLog(xc.repo, E, 'state:' + STAMP).entries.filter((e) => e.kind === kind)
const statusOf = (xc, id = 'p') => readTree(xc.repo, E).status.get(id)
const nodeOf = (xc, id) => readTree(xc.repo, E).nodes.get(id)
const escalations = (xc, id = 'p') => events(xc, 'escalated', (e) => e.node === id)
const parks = (xc, id = 'p') => events(xc, 'parked', (e) => e.node === id)
const everything = (xc) => ({
  events: readTree(xc.repo, E).events,
  ledger: readLog(xc.repo, E, 'ledger').entries,
  state: readLog(xc.repo, E, 'state:' + STAMP).entries,
})
const problemsOf = (xc) => checkFolder(xc.repo, E, 'p').problems
const textsOf = (problems) => problems.map((p) => p.file + '|' + p.problem).sort()
const detailOf = (xc, id = 'p') => String(((statusOf(xc, id) || {}).last || {}).detail || '')

/** A planner round of thread planner:p: its `dispatched` record and, when it returned, its stored return. */
function planner(xc, round, ret = null) {
  const dispatch = dispatchKey({ node: 'p', role: 'planner', thread: 'planner:p', round })
  xc.log.append('dispatched', {
    dispatch, node: 'p', round, thread: 'planner:p', role: 'planner', model: 'opus', effort: 'high', session: 'session-' + round,
    brief_digest: 'digest-' + round, brief_parts: [], carries: [], pid: 4242,
  })
  if (ret) {
    mkdirSync(join(xc.dir, 'returns'), { recursive: true })
    writeFileSync(returnPath(xc.dir, dispatch), JSON.stringify({ text: '', ...ret }))
    xc.log.append('returned', { dispatch, session: 'session-' + round, status: 'returned' })
  }
  return dispatch
}

/** A fault holding the folder on its role channel, as a boundary reports it. */
function assertHeld(xc, out) {
  assert.equal(out.status, 'held')
  assert.deepEqual(out.stops, [{ id: 'p', status: 'held', reason: 'role', said: '' }])
  assert.equal(stateLines(xc, 'fault').filter((f) => f.node === 'p' && f.channel === 'role').length, 1, 'one role fault on the folder')
}

/** A stop of one kind on `id`, as a boundary returns it. */
function assertStop(out, id, status, reason) {
  assert.equal(out.status, 'stopped')
  assert.equal(out.stops.length, 1, JSON.stringify(out.stops))
  assert.deepEqual([out.stops[0].id, out.stops[0].status, out.stops[0].reason], [id, status, reason])
}

// ------------------------------------------------------------------ a probe round by hand

let files = 0
const settlementId = (hash) => (f) => f.item || hash + '#' + f.id

/** A finding in full, as the probe's findings file holds it. */
const finding = (id, severity, claim, { item, section = 'design', axis = 'contract-ambiguity', carried = false } = {}) =>
  ({ id, ...(item ? { item } : {}), severity, axis, section, claim, evidence: 'DESIGN.md:12', carried })

/** A finding as the probe's result lists it. */
const handleOf = ({ claim, evidence, ...handle }) => handle

/**
 * A nested probe's result over the spec as it stands: the units are `contract-ambiguity@design` and
 * `contract-ambiguity@plan`, a unit holding a finding rules `finding`, the others `clean`.
 */
function probeResult(xc, { findings = [], open = [], failed = [], incomplete = [], unrecorded = [], snapshot, artifact } = {}) {
  const units = ['design', 'plan'].map((s) => 'contract-ambiguity@' + s)
  const rulings = units.filter((u) => !open.includes(u)).map((unit) => ({
    unit, ruling: findings.some((f) => 'contract-ambiguity@' + f.section === unit) ? 'finding' : 'clean', why: 'read it',
  }))
  const findingsFile = join(xc.repo, 'probe-findings-' + ++files + '.json')
  writeFileSync(findingsFile, JSON.stringify({ findings, units: rulings }))
  const complete = open.length === 0 && failed.length === 0 && incomplete.length === 0
  return {
    artifact: artifact || specPath(xc.repo, E, 'p'),
    axes: [{ key: 'contract-ambiguity', source: 'default' }],
    units: { total: units.length, ruled: rulings.length, open },
    findings: findings.map(handleOf),
    findings_file: findingsFile,
    ambiguities: findings.filter((f) => f.severity === 'ambiguity').map((f) => f.id),
    ratifiable: false,
    snapshot: snapshot === undefined ? 'snapshot:' + approvalState(xc.repo, E, 'p').hash : snapshot,
    unrecorded,
    review: '',
    coverage: { complete, declared: [], incomplete, failed_channels: failed, unreached: [], resumable: false },
  }
}

const hashNow = (xc) => approvalState(xc.repo, E, 'p').hash

/** Record a `reviewed` line at the spec as it stands, listing the ambiguities among `findings` by settlement id. */
function reviewedLine(xc, findings, { clean = [], sections } = {}) {
  const idOf = settlementId(hashNow(xc))
  const ambiguities = findings.filter((f) => f.severity === 'ambiguity').map(idOf)
  const out = recordReviewed(xc.repo, E, 'p', {
    complete: true, ambiguities, clean,
    sections: sections || Object.fromEntries(findings.filter((f) => f.severity === 'ambiguity').map((f) => [idOf(f), f.section])),
  })
  assert.equal(out.ok, true, JSON.stringify(out))
}

const dispose = (xc, finding, outcome) => {
  const out = recordDisposition(xc.repo, E, 'p', { finding, outcome, by: 'planner' })
  assert.equal(out.ok, true, JSON.stringify(out))
}

// ================================================================== spec-check

test('spec-check: a written spec is checked and records nothing', async (t) => {
  const xc = rig(t)
  const dispatch = planner(xc, 1, { status: 'written' })
  assert.deepEqual(problemsOf(xc), [], 'the fixture spec is sound')
  const before = everything(xc)
  const out = await specCheck(xc, { folder: 'p', dispatch })
  assert.equal(out.status, 'checked')
  assert.equal(out.spec_path, posix(specPath(xc.repo, E, 'p')))
  assert.equal(out.hash, hashSpec(folderSpec()))
  assert.equal(out.exists, true)
  assert.equal(out.decisions_n, 0)
  assert.equal(out.problems_n, 0)
  assert.deepEqual(out.stops, [])
  assert.deepEqual(everything(xc), before, 'a clean check records nothing')
})

test('spec-check: a rewrite compile would refuse (a consumed contract dropped) goes back to the planner before any review, naming the guard', async (t) => {
  const root = ROOT_SPEC.replace('- **q** — task · realises: D1 · rigor: tdd · expects: src/q.mjs', '- **q** — task · realises: D1 · rigor: tdd · expects: src/q.mjs · provides: api (src/q.mjs)')
  const consuming = folderSpec({ after: ' · consumes: api' })
  const xc = rig(t, { root, spec: consuming })
  assert.equal(recordPreparation(xc.repo, E, 'p', { review: REVIEW }).ok, true)
  assert.equal(compileEffort(xc.repo, E).ok, true)
  assert.deepEqual(nodeOf(xc, 'p/x').consumes.map((c) => c.name), ['api'])

  put(xc.repo, 'p', folderSpec({ title: 'Add x again.' }))
  assert.deepEqual(problemsOf(xc), [], 'the spec alone checks clean')
  const dispatch = planner(xc, 1, { status: 'written' })
  const out = await specCheck(xc, { folder: 'p', dispatch })
  assert.equal(out.status, 'problems')
  const sent = messages(xc, 'problems')
  assert.equal(sent.length, 1)
  assert.match(sent[0].payload.problems.map((p) => p.problem).join(), /drop or re-path a contract this node consumes \(api\)/)

  put(xc.repo, 'p', folderSpec({ title: 'Add x again.', after: ' · consumes: api' }))
  assert.equal((await specCheck(restarted(xc), { folder: 'p', dispatch: planner(xc, 2, { status: 'written' }) })).status, 'checked', 'kept, it checks clean')
})

test('spec-check: the compile check writes nothing, over a sub-effort approved again but not compiled', async (t) => {
  const root = ROOT_SPEC.replace('- **q** — task · realises: D1 · rigor: tdd · expects: src/q.mjs', '- **q** — task · realises: D1 · rigor: tdd · expects: src/q.mjs · provides: api (src/q.mjs)')
  const sub = ['- **s** — sub-effort', '  Build s.', '  The user writes its spec.']
  const xLines = (after = '', title = 'Add x.') => ['- **x** — task · realises: D1 · rigor: tdd · expects: src/x.mjs, test/x.test.mjs' + after, '  ' + title, '  Write x and its test.',
    '  - [ ] x works — check: `node --test test/x.test.mjs`']
  const sSpec = (title) => folderSpec({ plan: ['- **y** — task · realises: D1 · rigor: tdd · expects: src/y.mjs', '  ' + title, '  Write y.',
    '  - [ ] y works — check: `node --test test/y.test.mjs`'] }).replace('# Build p', '# Build s')
  const xc = rig(t, { root, spec: folderSpec({ plan: [...xLines(' · consumes: api'), ...sub] }) })
  put(xc.repo, 'p/s', sSpec('Add y.'))
  assert.equal(recordPreparation(xc.repo, E, 'p', { review: REVIEW }).ok, true)
  assert.equal(recordApproval(xc.repo, E, 'p/s').ok, true)
  assert.equal(compileEffort(xc.repo, E).ok, true)
  assert.ok(nodeOf(xc, 'p/s/y'), 'the sub-effort is compiled')

  put(xc.repo, 'p/s', sSpec('Add y again.'))
  assert.equal(recordApproval(xc.repo, E, 'p/s').ok, true, 'approved again, not compiled')
  put(xc.repo, 'p', folderSpec({ plan: [...xLines('', 'Add x again.'), ...sub] }))
  assert.deepEqual(problemsOf(xc), [], 'the spec alone checks clean')
  const dispatch = planner(xc, 1, { status: 'written' })
  const before = { ...everything(xc), nodes: [...readTree(xc.repo, E).nodes.values()] }
  const out = await specCheck(xc, { folder: 'p', dispatch })
  assert.equal(out.status, 'problems')
  const after = everything(xc)
  assert.deepEqual(after.events.filter((e) => e.kind !== 'message'), before.events.filter((e) => e.kind !== 'message'), 'no event but the problems message')
  assert.deepEqual(after.ledger, before.ledger, 'nothing recorded compiled')
  assert.deepEqual([...readTree(xc.repo, E).nodes.values()], before.nodes, 'no node written')
})

test('spec-check: a settled return reads as written', async (t) => {
  const xc = rig(t)
  const dispatch = planner(xc, 1, { status: 'settled', dispositions: [] })
  const out = await specCheck(xc, { folder: 'p', dispatch })
  assert.equal(out.status, 'checked')
  assert.deepEqual(out.stops, [])
})

for (const status of ['needs_decision', 'contract_changed', 'premise_mismatch']) {
  test(`spec-check: ${status} parks the folder on the planner's dispatch`, async (t) => {
    const xc = rig(t, { spec: null })
    const dispatch = planner(xc, 1, { status })
    const out = await specCheck(xc, { folder: 'p', dispatch })
    assert.equal(out.status, 'stopped')
    assert.deepEqual(out.stops, [{ id: 'p', status: 'parked', reason: status, said: dispatch }])
    const now = statusOf(xc)
    assert.deepEqual([now.status, now.last.return, now.last.said], ['parked', status, dispatch])
    assert.deepEqual(messages(xc), [], 'the return decides: no spec was checked, so no problems were sent')
  })
}

for (const status of ['blocked', 'unsplittable']) {
  test(`spec-check: ${status} escalates plan_${status} on the planner's dispatch`, async (t) => {
    const xc = rig(t, { spec: null })
    const dispatch = planner(xc, 1, { status })
    const out = await specCheck(xc, { folder: 'p', dispatch })
    assert.equal(out.status, 'stopped')
    assert.deepEqual(out.stops, [{ id: 'p', status: 'escalated', reason: 'plan_' + status, said: dispatch }])
    const now = statusOf(xc)
    assert.deepEqual([now.status, now.last.reason, now.last.said], ['escalated', 'plan_' + status, dispatch])
    assert.deepEqual(messages(xc), [])
  })
}

test('spec-check: any other status escalates plan_<status> on the planner\'s dispatch', async (t) => {
  const xc = rig(t, { spec: null })
  const dispatch = planner(xc, 1, { status: 'confused' })
  const out = await specCheck(xc, { folder: 'p', dispatch })
  assert.deepEqual(out.stops, [{ id: 'p', status: 'escalated', reason: 'plan_confused', said: dispatch }])
})

test('spec-check: a planner dispatch with no stored return holds the folder on a role fault', async (t) => {
  const xc = rig(t, { spec: folderSpec({ rigor: 'wild' }) })
  const dispatch = planner(xc, 1)
  assert.ok(problemsOf(xc).length > 0, 'the spec on disk has problems')
  const out = await specCheck(xc, { folder: 'p', dispatch })
  assertHeld(xc, out)
  assert.deepEqual(messages(xc), [], 'no message is sent over a spec nobody said was written')
  assert.deepEqual(escalations(xc), [])
})

test('spec-check: a spec that states a decision parks needs_decision', async (t) => {
  const xc = rig(t, { spec: folderSpec({ decisions: [['p.D1', 'keep it in memory']] }) })
  assert.ok(problemsOf(xc).length > 0, 'a decision nothing realises is also a problem')
  const dispatch = planner(xc, 1, { status: 'written' })
  const out = await specCheck(xc, { folder: 'p', dispatch })
  assertStop(out, 'p', 'parked', 'needs_decision')
  assert.equal(out.decisions_n, 1)
  const now = statusOf(xc)
  assert.deepEqual([now.status, now.last.return], ['parked', 'needs_decision'])
  assert.match(now.last.question, /states 1 decision\(s\): only the user states decisions/)
  assert.deepEqual(messages(xc), [], 'a decision is the user\'s: the planner is not sent its problems')
})

test('spec-check: problems go to the planner once, as a problems message for its next round', async (t) => {
  const xc = rig(t, { spec: folderSpec({ rigor: 'wild' }) })
  const problems = problemsOf(xc)
  assert.ok(problems.length > 0)
  const out = await specCheck(xc, { folder: 'p', dispatch: planner(xc, 1, { status: 'written' }) })
  assert.equal(out.status, 'problems')
  assert.deepEqual(out.stops, [])
  assert.equal(out.problems_n, problems.length)
  assert.equal(out.exists, true)
  assert.equal(out.hash, hashSpec(folderSpec({ rigor: 'wild' })))
  const sent = messages(xc)
  assert.equal(sent.length, 1)
  assert.deepEqual([sent[0].msg, sent[0].thread, sent[0].node, sent[0].from, sent[0].round], ['problems', 'planner:p', 'p', 'code', 2])
  assert.deepEqual(sent[0].payload.problems, problems, 'checkFolder\'s problems, as they are')
  assert.deepEqual(escalations(xc).concat(parks(xc)), [], 'the planner is told first: nothing stops')
})

test('spec-check: the message goes to the round after the dispatch\'s own', async (t) => {
  const xc = rig(t, { spec: folderSpec({ rigor: 'wild' }) })
  const out = await specCheck(xc, { folder: 'p', dispatch: planner(xc, 3, { status: 'written' }) })
  assert.equal(out.status, 'problems')
  assert.deepEqual(messages(xc).map((m) => m.round), [4])
})

test('spec-check: the same problems again escalate spec_refused', async (t) => {
  const xc = rig(t, { spec: folderSpec({ rigor: 'wild' }) })
  const problems = problemsOf(xc)
  await specCheck(xc, { folder: 'p', dispatch: planner(xc, 1, { status: 'written' }) })
  const out = await specCheck(xc, { folder: 'p', dispatch: planner(xc, 2, { status: 'written' }) })
  assertStop(out, 'p', 'escalated', 'spec_refused')
  const detail = detailOf(xc)
  for (const p of problems) assert.ok(detail.includes(p.file + ':' + p.line + ' ' + p.problem), 'the detail names ' + p.problem + ': ' + detail)
  assert.equal(messages(xc).length, 1, 'no second message')
  assert.equal(statusOf(xc).last.reason, 'spec_refused')
})

test('spec-check: a problem that moved to another line is the same problem', async (t) => {
  const xc = rig(t, { spec: folderSpec({ rigor: 'wild' }) })
  const first = problemsOf(xc)
  await specCheck(xc, { folder: 'p', dispatch: planner(xc, 1, { status: 'written' }) })
  put(xc.repo, 'p', folderSpec({ rigor: 'wild', extra: 'A paragraph the planner added above the plan.' }))
  const second = problemsOf(xc)
  assert.deepEqual(textsOf(second), textsOf(first), 'the same problem texts')
  assert.notDeepEqual(second.map((p) => p.line), first.map((p) => p.line), 'on other lines')
  const out = await specCheck(xc, { folder: 'p', dispatch: planner(xc, 2, { status: 'written' }) })
  assertStop(out, 'p', 'escalated', 'spec_refused')
  assert.equal(messages(xc).length, 1)
})

test('spec-check: different problems on the next round are sent again', async (t) => {
  const xc = rig(t, { spec: folderSpec({ rigor: 'wild' }) })
  const first = problemsOf(xc)
  await specCheck(xc, { folder: 'p', dispatch: planner(xc, 1, { status: 'written' }) })
  put(xc.repo, 'p', folderSpec({ plan: ['- **x** — task · realises: D9 · rigor: tdd · expects: src/x.mjs, test/x.test.mjs', '  Add x.', '  Write x and its test.', '  - [ ] x works — check: `node --test test/x.test.mjs`'] }))
  const second = problemsOf(xc)
  assert.ok(second.length > 0)
  assert.equal(textsOf(second).some((s) => textsOf(first).includes(s)), false, 'no problem in common')
  const out = await specCheck(xc, { folder: 'p', dispatch: planner(xc, 2, { status: 'written' }) })
  assert.equal(out.status, 'problems')
  assert.deepEqual(out.stops, [])
  const sent = messages(xc)
  assert.deepEqual(sent.map((m) => m.round).sort(), [2, 3])
  assert.deepEqual(sent.find((m) => m.round === 3).payload.problems, second)
  assert.deepEqual(escalations(xc), [])
})

test('spec-check: a set of problems that grew is a different set', async (t) => {
  const xc = rig(t, { spec: folderSpec({ rigor: 'wild' }) })
  await specCheck(xc, { folder: 'p', dispatch: planner(xc, 1, { status: 'written' }) })
  put(xc.repo, 'p', folderSpec({ rigor: 'wild', plan: ['- **x** — task · realises: D9 · expects: src/x.mjs, test/x.test.mjs', '  Add x.', '  Write x and its test.', '  - [ ] x works — check: `node --test test/x.test.mjs`'] }))
  const now = problemsOf(xc)
  assert.ok(now.length >= 2, JSON.stringify(now))
  const out = await specCheck(xc, { folder: 'p', dispatch: planner(xc, 2, { status: 'written' }) })
  assert.equal(out.status, 'problems')
  assert.deepEqual(messages(xc).map((m) => m.round).sort(), [2, 3])
  assert.deepEqual(escalations(xc), [])
})

test('spec-check: a folder the parent gives the user escalates spec_refused at once', async (t) => {
  const xc = rig(t, { root: ROOT_SPEC.replace(' · author: planner', '') })
  const out = await specCheck(xc, { folder: 'p', dispatch: planner(xc, 1, { status: 'written' }) })
  assertStop(out, 'p', 'escalated', 'spec_refused')
  assert.match(detailOf(xc), /the parent spec gives p to the user/)
  assert.deepEqual(messages(xc), [], 'no message: nothing the planner could fix')
})

test('spec-check: a spec the planner never wrote is a problem sent to the planner', async (t) => {
  const xc = rig(t, { spec: null })
  const c = checkFolder(xc.repo, E, 'p')
  assert.equal(c.exists, false)
  const out = await specCheck(xc, { folder: 'p', dispatch: planner(xc, 1, { status: 'written' }) })
  assert.equal(out.status, 'problems')
  assert.equal(out.exists, false)
  assert.equal(out.problems_n, c.problems.length)
  assert.deepEqual(out.stops, [])
  const sent = messages(xc)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].round, 2)
  assert.deepEqual(sent[0].payload.problems, c.problems)
  assert.ok(JSON.stringify(sent[0].payload).includes(c.file), 'the message names the missing file')
})

test('spec-check: a spec still missing after the planner\'s next round escalates spec_refused', async (t) => {
  const xc = rig(t, { spec: null })
  await specCheck(xc, { folder: 'p', dispatch: planner(xc, 1, { status: 'written' }) })
  const out = await specCheck(xc, { folder: 'p', dispatch: planner(xc, 2, { status: 'written' }) })
  assertStop(out, 'p', 'escalated', 'spec_refused')
  assert.ok(detailOf(xc).includes(checkFolder(xc.repo, E, 'p').file), 'the detail names the missing file')
  assert.equal(messages(xc).length, 1)
})

test('spec-check run twice on one dispatch records its message once', async (t) => {
  const xc = rig(t, { spec: folderSpec({ rigor: 'wild' }) })
  const dispatch = planner(xc, 1, { status: 'written' })
  const first = await specCheck(xc, { folder: 'p', dispatch })
  const second = await specCheck(xc, { folder: 'p', dispatch })
  assert.deepEqual([first.status, second.status], ['problems', 'problems'])
  assert.equal(messages(xc).length, 1, 'the message the call sent for the next round is not the planner having been told')
  assert.deepEqual(escalations(xc), [])
  const third = await specCheck(restarted(xc), { folder: 'p', dispatch })
  assert.equal(third.status, 'problems')
  assert.equal(messages(xc).length, 1, 'nor after a restart')
})

test('spec-check run twice on a park records it once', async (t) => {
  const xc = rig(t, { spec: null })
  const dispatch = planner(xc, 1, { status: 'needs_decision' })
  const first = await specCheck(xc, { folder: 'p', dispatch })
  const second = await specCheck(xc, { folder: 'p', dispatch })
  assert.deepEqual(first.stops, second.stops)
  assert.equal(second.stops.length, 1, 'the stop is reported both times')
  assert.equal(parks(xc).filter((e) => e.return === 'needs_decision').length, 1)
  await specCheck(restarted(xc), { folder: 'p', dispatch })
  assert.equal(parks(xc).length, 1, 'and after a restart')
})

test('spec-check run twice on a refusal records it once', async (t) => {
  const xc = rig(t, { spec: folderSpec({ rigor: 'wild' }) })
  await specCheck(xc, { folder: 'p', dispatch: planner(xc, 1, { status: 'written' }) })
  const dispatch = planner(xc, 2, { status: 'written' })
  const first = await specCheck(xc, { folder: 'p', dispatch })
  const second = await specCheck(xc, { folder: 'p', dispatch })
  assert.deepEqual(first.stops, second.stops)
  assert.equal(escalations(xc).filter((e) => e.reason === 'spec_refused').length, 1)
})

// ================================================================== spec-reviewed

test('spec-reviewed: a complete round is recorded, and its findings no disposition settled are fresh', (t) => {
  const xc = rig(t)
  const ambiguity = finding('P1', 'ambiguity', 'Two meanings of tick', { item: 'Ip1badc0de' })
  const gap = finding('P2', 'gap', 'No retry', { section: 'plan' })
  const out = specReviewed(xc, { folder: 'p', result: probeResult(xc, { findings: [ambiguity, gap] }) })
  assert.equal(out.status, 'recorded')
  assert.deepEqual(out.stops, [])
  assert.deepEqual([...out.fresh].sort(), ['P1', 'P2'])
  const lines = ledger(xc, 'reviewed')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].hash, hashSpec(folderSpec()))
  assert.equal(lines[0].complete, true)
  assert.deepEqual(lines[0].remaining, [])
  assert.deepEqual(lines[0].ambiguities, ['Ip1badc0de'], 'its ambiguities by settlement id')
  assert.deepEqual(escalations(xc).concat(parks(xc)), [])
})

test('spec-reviewed: a finding a disposition settled is not fresh', (t) => {
  const xc = rig(t)
  const h = hashNow(xc)
  const anchored = finding('P1', 'ambiguity', 'Two meanings of tick', { item: 'Ip1badc0de', carried: true })
  const unanchored = finding('P2', 'gap', 'No retry', { carried: true })
  const open = finding('P3', 'gap', 'No timeout', { item: 'Ip3badc0de' })
  dispose(xc, 'Ip1badc0de', 'incorporated')
  dispose(xc, h + '#P2', 'incorporated')
  const out = specReviewed(xc, { folder: 'p', result: probeResult(xc, { findings: [anchored, unanchored, open] }) })
  assert.equal(out.status, 'recorded')
  assert.deepEqual(out.fresh, ['P3'])
  assert.deepEqual(out.stops, [])
})

test('spec-reviewed: a finding is settled under the id of its own spec, not under another\'s', (t) => {
  const xc = rig(t)
  const old = hashNow(xc)
  dispose(xc, old + '#P2', 'incorporated')
  put(xc.repo, 'p', folderSpec({ design: 'One function, edited.' }))
  const out = specReviewed(xc, { folder: 'p', result: probeResult(xc, { findings: [finding('P2', 'gap', 'No retry')] }) })
  assert.deepEqual(out.fresh, ['P2'], 'an unanchored finding of the edited text was not settled at the text before')
})

test('spec-reviewed: a round that left a unit unruled is recorded incomplete and escalates review_incomplete', (t) => {
  const xc = rig(t)
  const unit = 'contract-ambiguity@plan'
  const out = specReviewed(xc, { folder: 'p', result: probeResult(xc, { findings: [finding('P1', 'gap', 'No retry')], open: [unit] }) })
  assertStop(out, 'p', 'escalated', 'review_incomplete')
  assert.deepEqual(out.fresh, [])
  const lines = ledger(xc, 'reviewed')
  assert.equal(lines.at(-1).complete, false)
  assert.ok(lines.at(-1).remaining.includes(unit), JSON.stringify(lines.at(-1).remaining))
  assert.ok(detailOf(xc).includes(unit), 'the escalation names the open unit: ' + detailOf(xc))
})

test('spec-reviewed: a round with unrecorded findings escalates review_incomplete naming them', (t) => {
  const xc = rig(t)
  const out = specReviewed(xc, {
    folder: 'p', result: probeResult(xc, { findings: [finding('P1', 'gap', 'No retry')], unrecorded: ['P1'] }),
  })
  assertStop(out, 'p', 'escalated', 'review_incomplete')
  assert.deepEqual(out.fresh, [])
  const line = ledger(xc, 'reviewed').at(-1)
  assert.equal(line.complete, false)
  assert.ok(line.remaining.includes('unrecorded:P1'), JSON.stringify(line.remaining))
  assert.ok(detailOf(xc).includes('unrecorded:P1'), detailOf(xc))
})

test('spec-reviewed: a failed channel other than the prober makes the round incomplete', (t) => {
  const xc = rig(t)
  const out = specReviewed(xc, { folder: 'p', result: probeResult(xc, { failed: ['analyst'] }) })
  assertStop(out, 'p', 'escalated', 'review_incomplete')
  assert.ok(ledger(xc, 'reviewed').at(-1).remaining.includes('channel:analyst'))
})

test('spec-reviewed: a finding back unchanged after it was incorporated escalates review_not_converging', (t) => {
  const xc = rig(t)
  const first = probeResult(xc, { findings: [finding('P1', 'ambiguity', 'Two meanings of tick', { item: 'Ip1badc0de' })] })
  dispose(xc, 'Ip1badc0de', 'incorporated')
  put(xc.repo, 'p', folderSpec({ design: 'One function, edited.' }))
  const back = probeResult(xc, { findings: [finding('P7', 'ambiguity', '  two meanings  of TICK ', { item: 'Inewbadc0de' })] })
  const out = specReviewed(xc, { folder: 'p', result: back, previous: first })
  assertStop(out, 'p', 'escalated', 'review_not_converging')
  assert.ok(detailOf(xc).includes('P7'), 'the detail names the fresh finding: ' + detailOf(xc))
  assert.equal(statusOf(xc).last.reason, 'review_not_converging')
})

test('spec-reviewed: a finding back is matched on its axis and section too', (t) => {
  const xc = rig(t)
  const first = probeResult(xc, { findings: [finding('P1', 'ambiguity', 'Two meanings of tick', { item: 'Ip1badc0de' })] })
  dispose(xc, 'Ip1badc0de', 'incorporated')
  put(xc.repo, 'p', folderSpec({ design: 'One function, edited.' }))
  const otherSection = finding('P7', 'ambiguity', 'Two meanings of tick', { item: 'Inewbadc0de', section: 'plan' })
  const otherAxis = finding('P8', 'ambiguity', 'Two meanings of tick', { item: 'Inew2badc0de', axis: 'growth' })
  const out = specReviewed(xc, { folder: 'p', result: probeResult(xc, { findings: [otherSection, otherAxis] }), previous: first })
  assert.equal(out.status, 'recorded')
  assert.deepEqual([...out.fresh].sort(), ['P7', 'P8'])
  assert.deepEqual(escalations(xc), [])
})

test('spec-reviewed: an unanchored finding back unchanged is matched at the hash of the round before', (t) => {
  const xc = rig(t)
  const h1 = hashNow(xc)
  const first = probeResult(xc, { findings: [finding('P1', 'ambiguity', 'Two meanings of tick')] })
  dispose(xc, h1 + '#P1', 'incorporated')
  put(xc.repo, 'p', folderSpec({ design: 'One function, edited.' }))
  assert.notEqual(hashNow(xc), h1)
  const back = probeResult(xc, { findings: [finding('P1', 'ambiguity', 'Two meanings of tick')] })
  const out = specReviewed(xc, { folder: 'p', result: back, previous: first })
  assertStop(out, 'p', 'escalated', 'review_not_converging')
  assert.ok(detailOf(xc).includes('P1'), detailOf(xc))
})

test('spec-reviewed: a note is no finding to settle', (t) => {
  const xc = rig(t)
  const out = specReviewed(xc, {
    folder: 'p', result: probeResult(xc, { findings: [finding('P1', 'note', 'Name it better'), finding('P2', 'gap', 'No retry')] }),
  })
  assert.equal(out.status, 'recorded')
  assert.deepEqual(out.fresh, ['P2'])
})

test('spec-reviewed: a finding back after it was discarded does not escalate', (t) => {
  const xc = rig(t)
  const first = probeResult(xc, { findings: [finding('P1', 'gap', 'No retry', { item: 'Ip1badc0de' })] })
  dispose(xc, 'Ip1badc0de', 'discarded')
  put(xc.repo, 'p', folderSpec({ design: 'One function, edited.' }))
  const back = probeResult(xc, { findings: [finding('P2', 'gap', 'no  RETRY', { item: 'Inewbadc0de' })] })
  const out = specReviewed(xc, { folder: 'p', result: back, previous: first })
  assert.equal(out.status, 'recorded')
  assert.deepEqual(out.stops, [])
  assert.ok(out.fresh.includes('P2'), 'a discarded finding does not settle its reappearance')
  assert.deepEqual(escalations(xc), [])
})

test("spec-reviewed: a round a prober's fault cut short records nothing and holds the folder", (t) => {
  const xc = rig(t)
  const out = specReviewed(xc, { folder: 'p', result: probeResult(xc, { findings: [finding('P1', 'gap', 'No retry')], failed: ['probe'] }) })
  assertHeld(xc, out)
  assert.deepEqual(out.fresh, [])
  assert.deepEqual(ledger(xc, 'reviewed'), [], 'no reviewed line')
  assert.deepEqual(escalations(xc), [])
})

test('spec-reviewed: a round with no snapshot and nothing unrecorded is refused no_snapshot', (t) => {
  const xc = rig(t)
  const before = everything(xc)
  const out = specReviewed(xc, { folder: 'p', result: probeResult(xc, { snapshot: '' }) })
  assert.equal(out.ok, false)
  assert.equal(out.error.kind, 'no_snapshot')
  assert.equal(typeof out.error.message, 'string')
  assert.deepEqual(out.fresh, [])
  assert.deepEqual(out.stops, [])
  assert.deepEqual(everything(xc), before, 'no line, no escalation')
})

for (const [name, kind, make] of [
  ['a snapshot of other text', 'spec_changed', (xc) => ({ ...probeResult(xc), snapshot: 'snapshot:' + '0'.repeat(8) })],
  ['a round over another artefact', 'not_this_spec', (xc) => probeResult(xc, { artifact: specPath(xc.repo, E, '.') })],
  ['a result that rules no unit', 'not_a_probe', (xc) => ({ ...probeResult(xc), units: undefined })],
  ['a result with no spec to review', 'refused', (xc) => {
    const result = probeResult(xc)
    rmSync(specPath(xc.repo, E, 'p'))
    return result
  }],
]) {
  test(`spec-reviewed: ${name} is refused ${kind}, recording nothing`, (t) => {
    const xc = rig(t)
    const result = make(xc)
    const before = everything(xc)
    const out = specReviewed(xc, { folder: 'p', result })
    assert.equal(out.ok, false)
    assert.equal(out.error.kind, kind)
    assert.equal(typeof out.error.message, 'string')
    assert.deepEqual(out.fresh, [])
    assert.deepEqual(out.stops, [])
    assert.deepEqual(everything(xc), before)
  })
}

test('spec-reviewed run twice over an incomplete round escalates once', (t) => {
  const xc = rig(t)
  const result = probeResult(xc, { open: ['contract-ambiguity@plan'] })
  const first = specReviewed(xc, { folder: 'p', result })
  const second = specReviewed(xc, { folder: 'p', result })
  assert.deepEqual(first.stops, second.stops)
  assert.equal(second.stops.length, 1)
  assert.equal(escalations(xc).filter((e) => e.reason === 'review_incomplete').length, 1)
  specReviewed(restarted(xc), { folder: 'p', result })
  assert.equal(escalations(xc).length, 1, 'and after a restart')
})

// ================================================================== spec-settle

/** A rig whose spec has been reviewed, over `findings`; the handles to settle. */
function settling(t, findings) {
  const xc = rig(t)
  reviewedLine(xc, findings)
  return { xc, asked: findings.map(handleOf) }
}

const dispositionsOf = (xc) => ledger(xc, 'disposition').map((e) => [e.finding, e.outcome, e.by]).sort()

test('spec-settle: each disposition is recorded by the planner under its settlement id', (t) => {
  const xc = rig(t)
  reviewedLine(xc, [])
  put(xc.repo, 'p', folderSpec({ design: 'One function, edited.' }))
  const findings = [
    finding('P1', 'ambiguity', 'Two meanings of tick', { item: 'Ip1badc0de' }), finding('P2', 'gap', 'No retry'),
  ]
  reviewedLine(xc, findings)
  const h = hashNow(xc)
  // The planner edits the spec while it settles, so the spec is no longer the text the round reviewed.
  put(xc.repo, 'p', folderSpec({ design: 'One function, edited again to settle.' }))
  assert.notEqual(hashNow(xc), h)
  const dispatch = planner(xc, 1, {
    status: 'settled',
    dispositions: [{ finding: 'P1', outcome: 'incorporated' }, { finding: 'P2', outcome: 'incorporated' }],
  })
  const out = specSettle(xc, { folder: 'p', dispatch, findings: findings.map(handleOf) })
  assert.equal(out.status, 'settled')
  assert.equal(out.incorporated_n, 2)
  assert.deepEqual(out.stops, [])
  assert.deepEqual(dispositionsOf(xc), [
    ['Ip1badc0de', 'incorporated', 'planner'], [h + '#P2', 'incorporated', 'planner'],
  ].sort(), 'an unanchored finding is settled under the latest reviewed hash')
  assert.deepEqual(messages(xc), [])
})

test('spec-settle sent again records each disposition once', (t) => {
  const findings = [finding('P1', 'ambiguity', 'Two meanings of tick', { item: 'Ip1badc0de' }), finding('P2', 'gap', 'No retry')]
  const { xc, asked } = settling(t, findings)
  const dispatch = planner(xc, 1, { status: 'settled', dispositions: [{ finding: 'P1', outcome: 'incorporated' }, { finding: 'P2', outcome: 'incorporated' }] })
  const first = specSettle(xc, { folder: 'p', dispatch, findings: asked })
  const second = specSettle(xc, { folder: 'p', dispatch, findings: asked })
  const third = specSettle(restarted(xc), { folder: 'p', dispatch, findings: asked })
  assert.deepEqual([first.status, second.status, third.status], ['settled', 'settled', 'settled'])
  assert.deepEqual([first.incorporated_n, second.incorporated_n, third.incorporated_n], [2, 2, 2])
  assert.equal(ledger(xc, 'disposition').length, 2, 'one line per disposition')
})

test("spec-settle: a discarded ambiguity is refused once, with a refusals message for the planner's next round", (t) => {
  const findings = [finding('P1', 'ambiguity', 'Two meanings of tick', { item: 'Ip1badc0de' })]
  const { xc, asked } = settling(t, findings)
  const dispatch = planner(xc, 1, { status: 'settled', dispositions: [{ finding: 'P1', outcome: 'discarded' }] })
  const out = specSettle(xc, { folder: 'p', dispatch, findings: asked })
  assert.equal(out.status, 'refused')
  assert.deepEqual(out.refused, ['P1'])
  assert.deepEqual(out.stops, [])
  const sent = messages(xc)
  assert.equal(sent.length, 1)
  assert.deepEqual([sent[0].msg, sent[0].thread, sent[0].node, sent[0].from, sent[0].round], ['refusals', 'planner:p', 'p', 'code', 2])
  assert.equal(sent[0].payload.refusals.length, 1)
  const [refusal] = sent[0].payload.refusals
  assert.deepEqual([refusal.id, refusal.finding], ['P1', 'Ip1badc0de'], 'the finding is named by its settlement id')
  assert.equal(typeof refusal.problem, 'string')
  assert.notEqual(refusal.problem.trim(), '')
  assert.deepEqual(ledger(xc, 'disposition'), [], 'a refused settlement records nothing')
  assert.deepEqual(escalations(xc), [])
})

test("spec-settle: the planner's refusals message says the ledger refused its dispositions", (t) => {
  const findings = [finding('P1', 'ambiguity', 'Two meanings of tick', { item: 'Ip1badc0de' })]
  const { xc, asked } = settling(t, findings)
  const dispatch = planner(xc, 1, { status: 'settled', dispositions: [{ finding: 'P1', outcome: 'discarded' }] })
  assert.equal(specSettle(xc, { folder: 'p', dispatch, findings: asked }).status, 'refused')
  const [sent] = messages(xc, 'refusals')
  assert.equal(sent.payload.of, 'dispositions')
  assert.equal(sent.thread, 'planner:p', 'back to the thread whose return was refused')
  const text = renderMessage({ msg: sent.msg, payload: sent.payload })
  assert.ok(text.includes('dispositions'), text)
  assert.ok(!/evidence store/i.test(text), text)
})

test('spec-settle: a discarded gap is refused', (t) => {
  const findings = [finding('P1', 'gap', 'No retry', { item: 'Ip1badc0de' })]
  const { xc, asked } = settling(t, findings)
  const dispatch = planner(xc, 1, { status: 'settled', dispositions: [{ finding: 'P1', outcome: 'discarded' }] })
  const out = specSettle(xc, { folder: 'p', dispatch, findings: asked })
  assert.equal(out.status, 'refused')
  assert.deepEqual(out.refused, ['P1'])
  assert.deepEqual(ledger(xc, 'disposition'), [])
})

test('spec-settle: a finding the settlement leaves out is refused', (t) => {
  const findings = [finding('P1', 'gap', 'No retry', { item: 'Ip1badc0de' }), finding('P2', 'gap', 'No timeout')]
  const { xc, asked } = settling(t, findings)
  const reviewedAt = hashNow(xc)
  put(xc.repo, 'p', folderSpec({ design: 'One function, edited to settle.' }))
  const dispatch = planner(xc, 1, { status: 'settled', dispositions: [{ finding: 'P1', outcome: 'incorporated' }] })
  const out = specSettle(xc, { folder: 'p', dispatch, findings: asked })
  assert.equal(out.status, 'refused')
  assert.deepEqual(out.refused, ['P2'])
  assert.deepEqual(ledger(xc, 'disposition'), [], 'not even the finding the planner did settle')
  const [refusal] = messages(xc, 'refusals')[0].payload.refusals
  assert.deepEqual([refusal.id, refusal.finding], ['P2', reviewedAt + '#P2'], 'named under the hash of the reviewed line')
})

test('spec-settle: a finding refused once and wrong again escalates review_not_converging', (t) => {
  const findings = [finding('P1', 'ambiguity', 'Two meanings of tick', { item: 'Ip1badc0de' })]
  const { xc, asked } = settling(t, findings)
  const wrong = { status: 'settled', dispositions: [{ finding: 'P1', outcome: 'discarded' }] }
  const first = specSettle(xc, { folder: 'p', dispatch: planner(xc, 1, wrong), findings: asked })
  assert.equal(first.status, 'refused')
  const second = specSettle(xc, { folder: 'p', dispatch: planner(xc, 2, wrong), findings: asked })
  assertStop(second, 'p', 'escalated', 'review_not_converging')
  assert.match(detailOf(xc), /P1|Ip1badc0de/, 'the detail names the finding')
  assert.deepEqual(ledger(xc, 'disposition'), [])
  assert.equal(messages(xc, 'refusals').length, 1, 'no second message')
})

test('spec-settle: a finding refused once and left out the next round is refused too, by its settlement id', (t) => {
  const findings = [finding('P1', 'gap', 'No retry')]
  const { xc, asked } = settling(t, findings)
  specSettle(xc, { folder: 'p', dispatch: planner(xc, 1, { status: 'settled', dispositions: [] }), findings: asked })
  const out = specSettle(xc, { folder: 'p', dispatch: planner(xc, 2, { status: 'settled', dispositions: [] }), findings: asked })
  assertStop(out, 'p', 'escalated', 'review_not_converging')
  assert.equal(messages(xc, 'refusals').length, 1)
})

test('spec-settle: a finding refused once and then settled rightly settles', (t) => {
  const findings = [finding('P1', 'ambiguity', 'Two meanings of tick', { item: 'Ip1badc0de' })]
  const { xc, asked } = settling(t, findings)
  specSettle(xc, { folder: 'p', dispatch: planner(xc, 1, { status: 'settled', dispositions: [{ finding: 'P1', outcome: 'discarded' }] }), findings: asked })
  const out = specSettle(xc, {
    folder: 'p', dispatch: planner(xc, 2, { status: 'settled', dispositions: [{ finding: 'P1', outcome: 'incorporated' }] }), findings: asked,
  })
  assert.equal(out.status, 'settled')
  assert.equal(out.incorporated_n, 1)
  assert.deepEqual(dispositionsOf(xc), [['Ip1badc0de', 'incorporated', 'planner']])
  assert.deepEqual(escalations(xc), [])
})

test('spec-settle run twice on a refused settlement sends one refusals message', (t) => {
  const findings = [finding('P1', 'ambiguity', 'Two meanings of tick', { item: 'Ip1badc0de' })]
  const { xc, asked } = settling(t, findings)
  const dispatch = planner(xc, 1, { status: 'settled', dispositions: [{ finding: 'P1', outcome: 'discarded' }] })
  const first = specSettle(xc, { folder: 'p', dispatch, findings: asked })
  const second = specSettle(xc, { folder: 'p', dispatch, findings: asked })
  assert.deepEqual([first.status, second.status], ['refused', 'refused'])
  assert.deepEqual(second.refused, ['P1'])
  assert.equal(messages(xc, 'refusals').length, 1, 'the message the call sent for the next round is not "refused before"')
  assert.deepEqual(escalations(xc), [])
  assert.equal(specSettle(restarted(xc), { folder: 'p', dispatch, findings: asked }).status, 'refused')
  assert.equal(messages(xc, 'refusals').length, 1, 'nor after a restart')
})

test('spec-settle: a settlement that needs a decision parks the folder on its dispatch', (t) => {
  const findings = [finding('P1', 'gap', 'No retry', { item: 'Ip1badc0de' })]
  const { xc, asked } = settling(t, findings)
  const dispatch = planner(xc, 1, { status: 'needs_decision', dispositions: [{ finding: 'P1', outcome: 'incorporated' }] })
  const out = specSettle(xc, { folder: 'p', dispatch, findings: asked })
  assert.equal(out.status, 'stopped')
  assert.deepEqual(out.stops, [{ id: 'p', status: 'parked', reason: 'needs_decision', said: dispatch }])
  const now = statusOf(xc)
  assert.deepEqual([now.status, now.last.return, now.last.said], ['parked', 'needs_decision', dispatch])
  assert.deepEqual(ledger(xc, 'disposition'), [])
})

test('spec-settle: a blocked settlement escalates blocked on its dispatch', (t) => {
  const findings = [finding('P1', 'gap', 'No retry', { item: 'Ip1badc0de' })]
  const { xc, asked } = settling(t, findings)
  const dispatch = planner(xc, 1, { status: 'blocked', dispositions: [{ finding: 'P1', outcome: 'incorporated' }] })
  const out = specSettle(xc, { folder: 'p', dispatch, findings: asked })
  assert.equal(out.status, 'stopped')
  assert.deepEqual(out.stops, [{ id: 'p', status: 'escalated', reason: 'blocked', said: dispatch }])
  assert.equal(statusOf(xc).last.said, dispatch)
  assert.deepEqual(ledger(xc, 'disposition'), [])
})

test('spec-settle: a settle dispatch with no stored return holds the folder on a role fault', (t) => {
  const findings = [finding('P1', 'gap', 'No retry', { item: 'Ip1badc0de' })]
  const { xc, asked } = settling(t, findings)
  const out = specSettle(xc, { folder: 'p', dispatch: planner(xc, 1), findings: asked })
  assertHeld(xc, out)
  assert.deepEqual(ledger(xc, 'disposition'), [])
  assert.deepEqual(messages(xc), [])
})

// ================================================================== spec-gate

test('spec-gate: shut before any review of the spec as it stands', (t) => {
  const xc = rig(t)
  const out = specGate(xc, { folder: 'p', edited: true })
  assert.equal(out.ratifiable, false)
  assert.equal(out.status, 'shut')
  assert.equal(out.reviewed, false)
  assert.deepEqual(out.stops, [])
  reviewedLine(xc, [])
  put(xc.repo, 'p', folderSpec({ design: 'One function, edited.' }))
  const edited = specGate(xc, { folder: 'p', edited: true })
  assert.deepEqual([edited.ratifiable, edited.status, edited.reviewed], [false, 'shut', false], 'a review of the text before is no review of this text')
})

test('spec-gate: a gate that is open stops nothing, edited or not', (t) => {
  const xc = rig(t)
  reviewedLine(xc, [])
  for (const edited of [true, false]) {
    const out = specGate(xc, { folder: 'p', edited })
    assert.deepEqual([out.ratifiable, out.status, out.open, out.stops], [true, 'open', [], []])
  }
  assert.deepEqual(escalations(xc), [])
})

test('spec-gate: an incorporated ambiguity keeps the gate shut until a later round reviews the edited spec clean', (t) => {
  const xc = rig(t)
  const ambiguity = finding('P1', 'ambiguity', 'Two meanings of tick', { item: 'Ia' })
  const gate = () => specGate(xc, { folder: 'p', edited: true })
  reviewedLine(xc, [ambiguity])
  dispose(xc, 'Ia', 'incorporated')
  assert.deepEqual([gate().ratifiable, gate().open], [false, ['Ia']], 'incorporated, but no round has read the edit')
  put(xc.repo, 'p', folderSpec({ design: 'One function, edited.' }))
  assert.equal(gate().ratifiable, false, 'an edit waits for a review of the new text')
  reviewedLine(xc, [ambiguity], { clean: [] })
  assert.deepEqual([gate().ratifiable, gate().open], [false, ['Ia']], 'a round that still finds it in its section')
  reviewedLine(xc, [ambiguity], { clean: ['design'] })
  const open = gate()
  assert.deepEqual([open.ratifiable, open.status, open.open, open.stops], [true, 'open', [], []])
  assert.deepEqual(escalations(xc), [])
})

test('spec-gate: shut on a round that edited nothing escalates review_not_converging', (t) => {
  const xc = rig(t)
  reviewedLine(xc, [finding('P1', 'ambiguity', 'Two meanings of tick', { item: 'Ia' }), finding('P2', 'ambiguity', 'Two meanings of tock', { item: 'Ib' })])
  const out = specGate(xc, { folder: 'p', edited: false })
  assertStop(out, 'p', 'escalated', 'review_not_converging')
  assert.equal(out.ratifiable, false)
  assert.deepEqual([...out.open].sort(), ['Ia', 'Ib'])
  const detail = detailOf(xc)
  assert.ok(detail.includes('Ia') && detail.includes('Ib'), 'the detail names each open id: ' + detail)
})

test('spec-gate run twice on an unedited round escalates once', (t) => {
  const xc = rig(t)
  reviewedLine(xc, [finding('P1', 'ambiguity', 'Two meanings of tick', { item: 'Ia' })])
  const first = specGate(xc, { folder: 'p', edited: false })
  const second = specGate(xc, { folder: 'p', edited: false })
  assert.deepEqual(first.stops, second.stops)
  assert.equal(second.status, 'stopped')
  assert.equal(escalations(xc).filter((e) => e.reason === 'review_not_converging').length, 1)
  specGate(restarted(xc), { folder: 'p', edited: false })
  assert.equal(escalations(xc).length, 1, 'and after a restart')
})

// ================================================================== spec-prepare

const seqOfNode = (xc, id) => (nodeOf(xc, id) || {}).seq
const rederived = (xc) => events(xc, 'replanned', (e) => e.node === 'p' && e.reason === 'spec_rederived')

/** A first preparation of the sound spec: p composite holding p/x. */
function prepared(t, opts) {
  const xc = rig(t, opts)
  const out = specPrepare(xc, { folder: 'p', review: REVIEW })
  assert.equal(out.status, 'prepared', JSON.stringify(out))
  return xc
}

test('spec-prepare: a gated spec is recorded prepared, naming its review, and compiled', (t) => {
  const xc = rig(t)
  const out = specPrepare(xc, { folder: 'p', review: REVIEW })
  assert.equal(out.status, 'prepared')
  assert.deepEqual(out.stops, [])
  assert.equal(out.hash, hashSpec(folderSpec()))
  assert.equal(out.compile.ok, true)
  assert.ok(out.compile.written_n > 0)
  const lines = ledger(xc, 'prepared')
  assert.equal(lines.length, 1)
  assert.deepEqual([lines[0].by, lines[0].review, lines[0].hash], ['planner', REVIEW, hashSpec(folderSpec())])
  assert.equal(approvalState(xc.repo, E, 'p').state, 'prepared')
  assert.equal(nodeOf(xc, 'p').kind, 'composite')
  assert.ok(nodeOf(xc, 'p/x'), 'the folder holds p/x')
  assert.deepEqual([out.row.kind, out.row.children_n], ['composite', 1])
  assert.equal(out.row.rev, nodeOf(xc, 'p').seq, 'rev is the node\'s seq')
  assert.deepEqual(rederived(xc), [], 'nothing was parked, so nothing is cleared')
  assert.deepEqual(escalations(xc, 'p').concat(escalations(xc, 'p/x')), [])
})

test('spec-prepare run twice records one preparation and compiles nothing more', (t) => {
  const xc = rig(t)
  const first = specPrepare(xc, { folder: 'p', review: REVIEW })
  const seqs = { p: seqOfNode(xc, 'p'), x: seqOfNode(xc, 'p/x') }
  const second = specPrepare(xc, { folder: 'p', review: REVIEW })
  const third = specPrepare(restarted(xc), { folder: 'p', review: REVIEW })
  for (const out of [second, third]) {
    assert.equal(out.status, 'prepared')
    assert.equal(out.hash, first.hash)
    assert.equal(out.compile.written_n, 0)
    assert.equal(out.row.rev, first.row.rev, 'no node revision')
    assert.deepEqual(out.stops, [])
  }
  assert.deepEqual({ p: seqOfNode(xc, 'p'), x: seqOfNode(xc, 'p/x') }, seqs)
  assert.equal(ledger(xc, 'prepared').length, 1)
})

test('spec-prepare: another review of the same text is recorded as its own preparation', (t) => {
  const xc = prepared(t)
  const out = specPrepare(xc, { folder: 'p', review: REVIEW_2 })
  assert.equal(out.status, 'prepared')
  assert.deepEqual(ledger(xc, 'prepared').map((l) => l.review), [REVIEW, REVIEW_2])
})

test('spec-prepare: a spec that states a decision is refused prepare_refused', (t) => {
  const xc = rig(t, { spec: folderSpec({ decisions: [['p.D1', 'keep it in memory']] }) })
  const out = specPrepare(xc, { folder: 'p', review: REVIEW })
  assertStop(out, 'p', 'escalated', 'prepare_refused')
  assert.deepEqual(ledger(xc, 'prepared'), [])
  assert.equal(nodeOf(xc, 'p').kind, 'design')
  assert.equal(nodeOf(xc, 'p/x'), undefined, 'nothing compiled')
})

test('spec-prepare: a spec with a problem is refused prepare_refused', (t) => {
  const xc = rig(t, { spec: folderSpec({ rigor: 'wild' }) })
  const out = specPrepare(xc, { folder: 'p', review: REVIEW })
  assertStop(out, 'p', 'escalated', 'prepare_refused')
  assert.deepEqual(ledger(xc, 'prepared'), [])
  assert.equal(nodeOf(xc, 'p').kind, 'design')
})

test('spec-prepare: a folder the parent gives the user is refused prepare_refused', (t) => {
  const xc = rig(t, { root: ROOT_SPEC.replace(' · author: planner', '') })
  const out = specPrepare(xc, { folder: 'p', review: REVIEW })
  assertStop(out, 'p', 'escalated', 'prepare_refused')
  assert.match(detailOf(xc), /the parent spec gives p to the user/)
  assert.equal(approvalState(xc.repo, E, 'p').state, 'none')
  assert.deepEqual(ledger(xc, 'prepared'), [])
})

test('spec-prepare: a missing spec is refused prepare_refused', (t) => {
  const xc = rig(t, { spec: null })
  const out = specPrepare(xc, { folder: 'p', review: REVIEW })
  assertStop(out, 'p', 'escalated', 'prepare_refused')
  assert.deepEqual(ledger(xc, 'prepared'), [])
  assert.equal(nodeOf(xc, 'p').kind, 'design')
})

test('spec-prepare: a compile refusal escalates compile_refused', (t) => {
  const xc = rig(t, { spec: folderSpec({ after: ' · after: /nowhere' }) })
  assert.deepEqual(problemsOf(xc), [], 'the spec check passes: only compile sees the dependency')
  const out = specPrepare(xc, { folder: 'p', review: REVIEW })
  assertStop(out, 'p', 'escalated', 'compile_refused')
  assert.equal(out.compile.ok, false)
  const refused = compileEffort(xc.repo, E, { folder: 'p', preview: true })
  assert.equal(refused.ok, false)
  for (const problem of refused.problems) assert.ok(detailOf(xc).includes(problem.problem), 'the detail names ' + problem.problem + ': ' + detailOf(xc))
})

test('spec-prepare: a folder compiled with nothing beneath it escalates planner_wrote_nothing', (t) => {
  const xc = rig(t, { spec: folderSpec({ plan: ['- **x** — deferred', '  Later.'] }) })
  assert.deepEqual(problemsOf(xc), [])
  const out = specPrepare(xc, { folder: 'p', review: REVIEW })
  assertStop(out, 'p', 'escalated', 'planner_wrote_nothing')
  assert.deepEqual([out.row.kind, out.row.children_n], ['composite', 0])
})

test('spec-prepare: a replan that leaves the leaf at its revision escalates replan_not_converging', (t) => {
  const xc = prepared(t)
  const rev = seqOfNode(xc, 'p/x')
  put(xc.repo, 'p', folderSpec({ design: 'One function, edited.' }))
  const out = specPrepare(xc, { folder: 'p', review: REVIEW_2, replanning: { node: 'p/x', rev } })
  assertStop(out, 'p/x', 'escalated', 'replan_not_converging')
  assert.equal(seqOfNode(xc, 'p/x'), rev, 'the compile left the leaf as it was')
  assert.equal(statusOf(xc, 'p/x').last.reason, 'replan_not_converging')
})

test('spec-prepare: a replan that changed the leaf is prepared', (t) => {
  const xc = prepared(t)
  const rev = seqOfNode(xc, 'p/x')
  put(xc.repo, 'p', folderSpec({ title: 'Add x, differently.' }))
  const out = specPrepare(xc, { folder: 'p', review: REVIEW_2, replanning: { node: 'p/x', rev } })
  assert.equal(out.status, 'prepared')
  assert.deepEqual(out.stops, [])
  assert.ok(seqOfNode(xc, 'p/x') > rev, 'compile revised the leaf')
  assert.deepEqual(escalations(xc, 'p/x'), [])
})

/** The sound spec prepared, work dispatched under it, its Design edited and prepared again: compile parks the folder spec_changed. */
function changedUnderWork(t) {
  const xc = prepared(t)
  xc.log.append('dispatched', { node: 'p/x', round: 1, role: 'implementer', thread: 'producer:p/x' })
  put(xc.repo, 'p', folderSpec({ design: 'One function, and its test.' }))
  return xc
}

test('spec-prepare clears the spec_changed park its own compile raised, once', (t) => {
  const xc = changedUnderWork(t)
  const out = specPrepare(xc, { folder: 'p', review: REVIEW_2 })
  assert.equal(out.status, 'prepared')
  assert.deepEqual(out.stops, [])
  assert.equal(parks(xc).filter((e) => e.return === 'spec_changed').length, 1, 'compile saw the change under dispatched work')
  const cleared = rederived(xc)
  assert.equal(cleared.length, 1)
  assert.deepEqual([cleared[0].by, cleared[0].execution], ['planner', STAMP])
  assert.notEqual(statusOf(xc).status, 'parked', 'the planner\'s re-derivation answers the park it raised')
  const again = specPrepare(xc, { folder: 'p', review: REVIEW_2 })
  assert.equal(again.status, 'prepared')
  specPrepare(restarted(xc), { folder: 'p', review: REVIEW_2 })
  assert.equal(rederived(xc).length, 1, 'also after a second call')
  assert.equal(parks(xc).filter((e) => e.return === 'spec_changed').length, 1)
})

test('spec-prepare clears a spec_changed park a cut-off call left standing', (t) => {
  const xc = changedUnderWork(t)
  assert.equal(recordPreparation(xc.repo, E, 'p', { review: REVIEW_2 }).ok, true)
  assert.equal(compileEffort(xc.repo, E, { folder: 'p' }).ok, true)
  assert.equal(statusOf(xc).status, 'parked', 'the call was cut between compile\'s park and the clear')
  const out = specPrepare(xc, { folder: 'p', review: REVIEW_2 })
  assert.equal(out.status, 'prepared')
  assert.equal(ledger(xc, 'prepared').filter((l) => l.review === REVIEW_2).length, 1, 'the standing line is reused')
  assert.equal(rederived(xc).length, 1)
  assert.notEqual(statusOf(xc).status, 'parked')
})

/** The sound spec prepared, then its leaf's `expects` grown by `path` and prepared again. */
function widened(t, path, before = () => {}, opts) {
  const xc = prepared(t, opts)
  before(xc)
  put(xc.repo, 'p', folderSpec({ expects: 'src/x.mjs, test/x.test.mjs, ' + path }))
  return { xc, out: specPrepare(xc, { folder: 'p', review: REVIEW_2 }) }
}

test("spec-prepare: a leaf whose expects grew onto another unmerged leaf's file is prepared with no stop", (t) => {
  const { xc, out } = widened(t, 'src/q.mjs')
  assert.equal(out.status, 'prepared', JSON.stringify(out.stops))
  assert.deepEqual(out.stops, [])
  assert.ok(nodeOf(xc, 'p/x').expects.includes('src/q.mjs'), 'the leaf\'s new revision is compiled')
  assert.deepEqual(escalations(xc, 'p/x'), [], 'an expectation is no claim: the scheduler keeps the two apart')
})
