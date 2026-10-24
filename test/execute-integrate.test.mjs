// test/execute-integrate.test.mjs — lib/programs/execute/integrate.mjs: the units of the execute
// program that merge, rule, gate and review, over the execution rig (real git, the real
// measurement, a scripted runner).
//
// What is pinned here:
//
//   mergeUnit   the batch's outcome and lists passed through; the ruler on a drift brief (one fresh
//               ruler on the root's thread, briefed with the file merge-batch wrote); drift ruled
//               affected comes back for the planner, ruled unaffected never reaches anyone, a ruler
//               that failed or a consumer in flight parks `contract_drift`, a stopped consumer's
//               drift goes to no ruler; a leaf failing alone gets its failures; a batch that cannot
//               run stops its target; a killed batch is reset and merged again; a refusal is a
//               `program` fault on the target
//   ruleUnit    the same ruler on a moved base (`stale`): an approved leaf stays approved or parks
//               `premise_mismatch`, a planned one comes back for the planner, one the ruler left
//               unruled is held on a `role` fault, never parked; the ruler's thread for a drift
//               over a sub-folder
//   gateUnit    a refusal is a `program` fault on the target
//   reviewUnit  the gate first (a failing one escalates the composite unreviewed, a review that is
//               not earned is `not_earned`); one fresh read-only reviewer in the folder's worktree,
//               handed the spec, the span and its units; the claims recorded with `said` its
//               dispatch; a critical parks through folder-review; a dispatch that failed is a fault
//               on the folder and a lost check, taken up again in its own session by a relaunch
//
// Every claim is read from the records (`rig.log.entries()`, `readTree(…).status`) and from
// `rig.calls`. Expected heads, record paths, tiers and permissions are computed.
//
// Design: docs/DESIGN.md#merging, docs/DESIGN.md#the-suite-gate, docs/DESIGN.md#executors-and-review,
// docs/DESIGN.md#landing-and-drift.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { ensureIntegration, ensureLeaf } from '../lib/integration.mjs'
import { append } from '../lib/ledger.mjs'
import { readOnlyPermissions } from '../lib/permissions.mjs'
import { loadRole, tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { dispatchKey, mergePath, nodeKey, specPath, stalePath, writeWhole } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { programContext } from '../lib/programs/common.mjs'
import { gateUnit, mergeUnit, reviewUnit, ruleUnit } from '../lib/programs/execute/integrate.mjs'
import { executionRig } from './harness/program-rig.mjs'

// merge-batch and the gate measure through `node --test` grandchildren, which refuse to run under
// the test runner's marker; the rig does not clear it.
delete process.env.NODE_TEST_CONTEXT

const SLOW = { timeout: 120_000 }

// ================================================================== specs

const FILLER = ['## Open questions', '', '## Evidence', '', 'None yet.', '']

/** A root or folder spec: `decisions` is [[id, text]], `plan` the Plan section's entries. */
const specOf = (title, decisions, plan) => [
  '# ' + title, '',
  '## Intent', '', title + '.', '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|',
  ...decisions.map(([id, text]) => `| ${id} | ${text} | Callers need it. |`), '',
  '## Design', '', 'As the plan says.', '',
  '## Plan', '', ...plan, '',
  ...FILLER,
].join('\n')

/** One plan task. It expects its check file unless `criteria` is given. */
function task(name, { realises = 'D1', rigor = 'trivial', after = '', provides = '', consumes = '', expects = null, criteria = null } = {}) {
  const own = expects ?? [`src/${name}.mjs`, `test/${name}.test.mjs`]
  const fields = [
    'task', 'realises: ' + realises, ...(after ? ['after: ' + after] : []), ...(provides ? ['provides: ' + provides] : []),
    ...(consumes ? ['consumes: ' + consumes] : []), 'rigor: ' + rigor, ...(own.length ? ['expects: ' + own.join(', ')] : []),
  ]
  const cs = criteria ?? [`${name} works — check: \`node --test test/${name}.test.mjs\``]
  return [`- **${name}** — ${fields.join(' · ')}`, `  Do ${name}`, ...cs.map((c) => `  - [ ] ${c}`)].join('\n')
}
const subEffort = (name, realises) => `- **${name}** — sub-effort · realises: ${realises}\n  Folder ${name}`

/** Drift: p provides api, a writes src/api.mjs without providing it, b consumes api. */
const DRIFT_SPEC = specOf('Drift', [['D1', 'The api is stable.']], [
  task('p', { provides: 'api (src/api.mjs)', expects: ['src/api.mjs', 'test/p.test.mjs'] }),
  task('a', { after: 'p', expects: ['src/api.mjs', 'test/a.test.mjs'] }),
  task('b', { after: 'p', consumes: 'api' }),
])

/** Two leaves a and b; b's second criterion is the user's. */
const AB_SPEC = specOf('Two leaves', [['D1', 'a is there.'], ['D2', 'b is there.']], [
  task('a', { realises: 'D1' }),
  task('b', { realises: 'D2', criteria: ['b works — check: `node --test test/b.test.mjs`', 'HUMAN: b reads well'] }),
])

const subSpec = (leaves) => specOf('Folder c', [['c.D1', 'c holds.']], leaves)
/** A root with a leaf y and a sub-folder c whose only child is a trivial leaf k. */
const TRIVIAL_FOLDER = {
  '.': specOf('Root', [['D1', 'y is there.'], ['D2', 'c is there.']], [task('y', { realises: 'D1' }), subEffort('c', 'D2')]),
  c: subSpec([task('k', { realises: 'D2, c.D1' })]),
}
/** A root whose only entry is a sub-folder c whose only child is a verify leaf v. */
const VERIFY_FOLDER = {
  '.': specOf('Root', [['D1', 'c is there.']], [subEffort('c', 'D1')]),
  c: subSpec([task('v', { realises: 'D1, c.D1', rigor: 'verify', expects: [], criteria: ['v holds — check: `node --test test/add.test.mjs`'] })]),
}

const SPLIT = {
  suite: 'node --test --test-reporter=spec', suite_fast: 'node --test --test-reporter=spec test/add.test.mjs',
  test_one: 'node --test --test-reporter=spec {file}', absent: { build: true, typecheck: true },
}
const BIG_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../../src/add.mjs'\n" +
  "test('adds big', () => assert.equal(add(2, 2), 4))\n"
const BREAK_BIG = 'export const add = (a, b) => (a === 2 && b === 2 ? 5 : a + b)\n'

// ================================================================== a world to work in

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
const same = (a, b) => String(a).replace(/\\/g, '/') === String(b).replace(/\\/g, '/')
const kinds = (rig, kind) => rig.log.entries().filter((e) => e.kind === kind)
const statusOf = (rig, id) => readTree(rig.repo, rig.effort).status.get(id).status
const rootHead = (rig) => rig.git('rev-parse', 'refs/heads/' + rig.branchOf('.'))
const call = (rig, i = 0) => rig.calls[i]
const dispatchedOf = (rig, role) => kinds(rig, 'dispatched').filter((e) => e.role === role)

function commitIn(worktree, files, subject) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true })
    writeFileSync(join(worktree, path), text)
  }
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-q', '-m', subject)
  return git(worktree, 'rev-parse', 'HEAD')
}

/** Stand in for leaf-open: the leaf's branch and worktree, cut from the root, and its round 1. */
function openLeaf(rig, id) {
  const made = ensureLeaf(rig.repo, rig.effort, id, { from: rootHead(rig), parentBranch: rig.branchOf('.') })
  assert.equal(made.ok, true, made.error)
  rig.log.append('dispatched', {
    node: id, dispatch: dispatchKey({ node: id, role: 'implementer', thread: 'producer:' + id, round: 1 }),
    round: 1, thread: 'producer:' + id, role: 'implementer',
  })
  return made
}

/** A leaf opened and its change committed: `{id, head_sha, worktree, branch}`. */
function readyLeaf(rig, id, files, subject = 'Change ' + id) {
  const open = openLeaf(rig, id)
  return { id, worktree: open.worktree, branch: open.branch, head_sha: commitIn(open.worktree, files, subject) }
}

const approve = (rig, leaf) => rig.log.append('approved', { node: leaf.id, head_sha: leaf.head_sha, review_rounds: 1, at_integration: false })
const handed = (...leaves) => leaves.map((l) => ({ id: l.id, head_sha: l.head_sha }))

const rulerKey = (thread, node = '.') => `ruler|${node}|${thread}`
const ruling = (node, kind, why = 'because ' + node, question = '') => ({ node, ruling: kind, why, question: kind === 'affected' ? (question || 'Does ' + node + ' still hold?') : question })
const rulings = (...list) => ({ output: { rulings: list } })
const REVIEW_EMPTY = { units: [], findings: [], fix_rulings: [], claims: [], notes: '' }
const claim = (text, kind = 'met') => ({
  claim: text, ruling: kind, evidence: 'src/x.mjs:1', failure_scenario: ['under', 'over', 'deviates'].includes(kind) ? 'a caller of ' + text + ' breaks' : '',
})
const reviewed = (claims, findings = []) => ({ output: { ...REVIEW_EMPTY, claims, findings } })
const CRITICAL = { id: 'F1', severity: 'critical', claim: 'the pair breaks', evidence: 'src/a.mjs:1', failure_scenario: 'a and b disagree' }

/** The drift world: a merged into the root drifts b. `pre` is the root's head before the batch. */
function driftWorld(t) {
  const rig = executionRig(t, { spec: DRIFT_SPEC })
  const a = readyLeaf(rig, 'a', { 'src/api.mjs': 'export const api = 2\n' }, 'Change the api')
  const pre = rootHead(rig)
  return {
    rig, a, pre, thread: 'ruler:drift:root:' + pre.slice(0, 8),
    brief: mergePath(rig.repo, rig.effort, rig.stamp, '.', pre).replace(/\.json$/, '.drift.md'),
    merge: (extra = {}) => mergeUnit(rig.ctx, rig.xc, { intelligence: 'normal', target: '.', children: handed(a), ...extra }),
  }
}

// ================================================================== the merge unit and the ruler on its drift

test('drift a ruler rules affected comes back for the planner with its question, and parks nothing', SLOW, async (t) => {
  const w = driftWorld(t)
  const question = 'Does b still read the api as it was?'
  w.rig.script({ [rulerKey(w.thread)]: [rulings(ruling('b', 'affected', 'the api changed', question))] })
  const out = await w.merge()

  assert.equal(out.outcome, 'done')
  assert.deepEqual(out.merged.map((m) => m.id), ['a'])
  assert.deepEqual(out.drift, [{ node: 'b', contract: 'api', stopped: '' }])
  assert.deepEqual(out.replan, [{ id: 'b', question }])
  assert.equal(statusOf(w.rig, 'b'), 'planned')
  assert.equal(w.rig.calls.length, 1)
  const ruled = kinds(w.rig, 'drift-ruled')
  assert.equal(ruled.length, 1)
  assert.deepEqual([ruled[0].node, ruled[0].contract, ruled[0].ruling, ruled[0].why], ['b', 'api', 'affected', 'the api changed'])
  assert.equal(ruled[0].said, call(w.rig).dispatch, 'said names the ruler\'s dispatch')
  assert.equal(kinds(w.rig, 'parked').length, 0)
})

test('the drift ruler is one fresh ruler on its own thread of the root, briefed with the file merge-batch wrote', SLOW, async (t) => {
  const w = driftWorld(t)
  w.rig.script({ [rulerKey(w.thread)]: [rulings(ruling('b', 'unaffected'))] })
  await w.merge()

  assert.equal(w.rig.calls.length, 1, 'one ruler, no second one')
  const c = call(w.rig)
  assert.equal(c.role.name, 'ruler')
  assert.equal(c.node, '.')
  assert.equal(c.thread.key, w.thread)
  assert.equal(c.resume, false)
  assert.deepEqual(c.schema, schemaOf('ruler_premises'))
  assert.equal(c.brief, readFileSync(w.brief, 'utf8'), 'the brief is the text of the drift brief file')
  assert.ok(c.brief.includes('b'), 'and the file is not empty')
  assert.deepEqual(c.tier, tierFor(loadRole('ruler').role, { intelligence: 'normal' }))
  const dispatched = dispatchedOf(w.rig, 'ruler')
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].node, '.')
})

test('drift ruled unaffected never reaches the user: nothing parks and nothing is replanned', SLOW, async (t) => {
  const w = driftWorld(t)
  w.rig.script({ [rulerKey(w.thread)]: [rulings(ruling('b', 'unaffected', 'the api is the same'))] })
  const out = await w.merge()

  assert.equal(out.outcome, 'done')
  assert.deepEqual(out.replan, [])
  assert.deepEqual(kinds(w.rig, 'drift-ruled').map((r) => [r.node, r.ruling]), [['b', 'unaffected']])
  assert.equal(kinds(w.rig, 'parked').length, 0)
  assert.equal(kinds(w.rig, 'escalated').length, 0)
  assert.equal(statusOf(w.rig, 'b'), 'planned')
})

test('a drift ruler that fails parks the consumer contract_drift: the drift would not be found again', SLOW, async (t) => {
  const w = driftWorld(t)
  w.rig.script({ [rulerKey(w.thread)]: [{ status: 'failed', cause: 'host_error' }] })
  const out = await w.merge()

  assert.equal(out.outcome, 'done', 'the merge itself stands')
  assert.deepEqual(out.merged.map((m) => m.id), ['a'])
  assert.deepEqual(out.replan, [])
  const parks = kinds(w.rig, 'parked')
  assert.deepEqual(parks.map((p) => [p.node, p.return]), [['b', 'contract_drift']])
  assert.match(parks[0].question, /no ruler/)
  assert.equal(kinds(w.rig, 'drift-ruled').length, 0)
  assert.equal(statusOf(w.rig, 'b'), 'parked')
})

test('a drifted consumer in flight ruled affected parks contract_drift, never replanned under its work', SLOW, async (t) => {
  const w = driftWorld(t)
  const question = 'b is mid-flight: what does it assume?'
  w.rig.script({ [rulerKey(w.thread)]: [rulings(ruling('b', 'affected', 'the api changed', question))] })
  const out = await w.merge({ running: ['leaf:b'] })

  assert.deepEqual(out.replan, [])
  const parks = kinds(w.rig, 'parked')
  assert.deepEqual(parks.map((p) => [p.node, p.return, p.question]), [['b', 'contract_drift', question]])
  assert.equal(kinds(w.rig, 'drift-ruled').length, 1, 'the ruling is recorded all the same')
})

test("a stopped consumer's drift is reported and goes to no ruler", SLOW, async (t) => {
  const w = driftWorld(t)
  w.rig.log.append('escalated', { node: 'b', reason: 'merge_conflict', detail: 'stopped before the batch' })
  const out = await w.merge()

  assert.equal(out.outcome, 'done')
  assert.deepEqual(out.drift, [{ node: 'b', contract: 'api', stopped: 'escalated' }])
  assert.deepEqual(out.replan, [])
  assert.equal(w.rig.calls.length, 0, 'no dispatch')
  assert.equal(kinds(w.rig, 'drift-ruled').length, 0)
})

test('a merge-batch that cannot run stops its target and rules nothing', SLOW, async (t) => {
  const rig = executionRig(t)
  const a = readyLeaf(rig, 'a', { 'src/a.mjs': 'export const a = () => 1\n' })
  const wt = rig.worktreeOf('.')
  rig.git('worktree', 'remove', '--force', wt)
  rig.git('worktree', 'add', '-q', '-b', 'other', wt)
  const out = await mergeUnit(rig.ctx, rig.xc, { target: '.', children: handed(a), intelligence: 'normal' })

  assert.equal(out.outcome, 'stopped')
  assert.deepEqual(out.merged, [])
  assert.deepEqual(kinds(rig, 'escalated').map((e) => [e.node, e.reason]), [['.', 'merge_batch_failed']])
  assert.equal(rig.calls.length, 0)
  assert.equal(kinds(rig, 'merged').length, 0)
})

test('a merge the boundary refuses is a program fault on its target', SLOW, async (t) => {
  const rig = executionRig(t)
  const out = await mergeUnit(rig.ctx, rig.xc, { target: 'a', children: [], intelligence: 'normal' })

  assert.equal(out.outcome, 'faulted')
  assert.deepEqual(kinds(rig, 'fault').map((f) => [f.node, f.channel]), [['a', 'program']])
  assert.equal(rig.calls.length, 0)
})

// ================================================================== the gate and the integration review

test('a gate the boundary refuses is a program fault on its target', SLOW, async (t) => {
  const rig = executionRig(t)
  const out = await gateUnit(rig.ctx, rig.xc, { target: 'a' })

  assert.equal(out.outcome, 'faulted')
  assert.deepEqual(kinds(rig, 'fault').map((f) => [f.node, f.channel]), [['a', 'program']])
})

test('a failing suite gate escalates the composite unreviewed', SLOW, async (t) => {
  const rig = executionRig(t, { commands: SPLIT, files: { 'test/big/add.test.mjs': BIG_TEST } })
  const wt = rig.worktreeOf('.')
  commitIn(wt, { 'src/add.mjs': BREAK_BIG }, 'Break only the big test')
  const out = await reviewUnit(rig.ctx, rig.xc, { id: '.', where: { base: rig.base_sha, worktree: wt }, intelligence: 'normal' })

  assert.equal(out.outcome, 'failed')
  assert.equal(out.said, '')
  assert.deepEqual(kinds(rig, 'escalated').map((e) => [e.node, e.reason]), [['.', 'fails_full_suite']])
  assert.equal(rig.calls.length, 0)
  assert.equal(kinds(rig, 'claims').length, 0)
})

/** Two leaves merged into the root without a batch: their files committed in the root's worktree. */
function mergedAB(rig) {
  const wt = rig.worktreeOf('.')
  const pass = (n) => "import { test } from 'node:test'\ntest('" + n + "', () => {})\n"
  const files = { 'src/a.mjs': 'export const a = () => 1\n', 'src/b.mjs': 'export const b = () => 2\n', 'test/a.test.mjs': pass('a'), 'test/b.test.mjs': pass('b') }
  const sha = commitIn(wt, files, 'Work of a and b')
  for (const id of ['a', 'b']) rig.log.append('merged', { node: id, into: rig.branchOf('.'), merged_sha: sha, head_sha: sha })
  return { wt, where: { base: rig.base_sha, worktree: wt }, head: sha, unreviewed: ['a', 'b'] }
}
const abWorld = (t) => {
  const rig = executionRig(t, { spec: AB_SPEC })
  return { rig, ...mergedAB(rig) }
}
const THREAD_ROOT = 'integration:.:1'
const reviewerKey = (thread = THREAD_ROOT, node = '.') => `reviewer|${node}|${thread}`
const review = (w, extra = {}) => reviewUnit(w.rig.ctx, w.rig.xc, { intelligence: 'normal', id: '.', where: w.where, unreviewed: w.unreviewed, ...extra })

test("the root's integration review is earned once work merged: claims recorded, said its dispatch", SLOW, async (t) => {
  const w = abWorld(t)
  const claims = [claim('a is there'), claim('b is there')]
  w.rig.script({ [reviewerKey()]: [reviewed(claims)] })
  const out = await review(w)

  assert.equal(out.outcome, 'reviewed')
  assert.equal(out.said, call(w.rig).dispatch)
  const recorded = kinds(w.rig, 'claims')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].node, '.')
  assert.equal(recorded[0].head_sha, w.head)
  assert.equal(recorded[0].review, 'done')
  assert.deepEqual(recorded[0].claims, claims.map(({ claim: c, ruling: r }) => ({ claim: c, ruling: r })))
  assert.equal(recorded[0].said, out.said)
  assert.equal(kinds(w.rig, 'parked').length, 0)
})

test("the integration reviewer is a fresh read-only reviewer in the folder's worktree, handed the spec, the span and its units", SLOW, async (t) => {
  const w = abWorld(t)
  w.rig.script({ [reviewerKey()]: [reviewed([claim('a is there'), claim('b is there')])] })
  await review(w, { intelligence: 'low' })

  assert.equal(w.rig.calls.length, 1)
  const c = call(w.rig)
  const role = loadRole('reviewer').role
  assert.equal(c.role.name, 'reviewer')
  assert.equal(c.node, '.')
  assert.equal(c.thread.key, THREAD_ROOT)
  assert.equal(c.resume, false)
  assert.equal(same(c.cwd, w.wt), true, 'cwd ' + c.cwd)
  assert.deepEqual(c.permissions, readOnlyPermissions(role))
  assert.deepEqual(c.tier, tierFor(role, { intelligence: 'low' }))
  assert.deepEqual(c.schema, schemaOf('reviewer'))

  const spec = readFileSync(specPath(w.rig.repo, w.rig.effort, '.'), 'utf8').replace(/\r\n/g, '\n').trim()
  assert.ok(c.brief.includes(spec), 'the root spec\'s text')
  assert.ok(c.brief.includes('git diff ' + w.rig.base_sha + ' ' + w.head), 'the span, base to the gate\'s head')
  const files = git(w.rig.repo, 'diff', '--name-only', w.rig.base_sha, w.head).split('\n').filter(Boolean)
  assert.deepEqual(files.sort(), ['src/a.mjs', 'src/b.mjs', 'test/a.test.mjs', 'test/b.test.mjs'])
  const tree = readTree(w.rig.repo, w.rig.effort)
  const decisions = tree.nodes.get('.').defines.map((d) => d.id)
  assert.deepEqual(decisions, ['D1', 'D2'])
  const units = [...decisions.map((d) => 'decision:' + d), ...files.map((f) => 'file:' + f)]
  const lines = c.brief.split('\n')
  for (const unit of units) assert.ok(lines.includes('- ' + unit), 'a unit line for ' + unit)
  assert.equal(c.brief.includes('criterion:'), false, "no criterion is a unit: a check is measured, a HUMAN one is the user's")
  assert.equal(dispatchedOf(w.rig, 'reviewer')[0].node, '.')
})

test("a criterion with a check is measured at the integration head and handed to the reviewer as observed, never as a unit", SLOW, async (t) => {
  const w = abWorld(t)
  w.rig.script({ [reviewerKey()]: [reviewed([claim('a is there')])] })
  const out = await review(w, { unreviewed: ['a'] })

  assert.equal(out.outcome, 'reviewed')
  const lines = call(w.rig).brief.split('\n')
  assert.equal(lines.some((l) => l.startsWith('- criterion:')), false)
  assert.ok(lines.includes('- `node --test test/a.test.mjs`: passed'))
  assert.ok(lines.includes('- `node --test test/b.test.mjs`: passed'))
})

test('a second review of a folder is a fresh reviewer on the next integration thread', SLOW, async (t) => {
  const w = abWorld(t)
  w.rig.script({ [reviewerKey()]: [reviewed([claim('a is there')])], [reviewerKey('integration:.:2')]: [reviewed([claim('a is there')])] })
  const first = await review(w)
  assert.equal(first.outcome, 'reviewed')
  commitIn(w.wt, { 'src/c.mjs': 'export const c = () => 3\n' }, 'More work')
  const second = await review(w)

  assert.equal(second.outcome, 'reviewed')
  assert.deepEqual(w.rig.calls.map((c) => c.thread.key), [THREAD_ROOT, 'integration:.:2'])
  assert.equal(w.rig.calls[1].resume, false)
  assert.notEqual(w.rig.calls[1].thread.session, w.rig.calls[0].thread.session)
  assert.equal(kinds(w.rig, 'claims').length, 2)
})

/**
 * The root reviewed once, then its spec re-approved over the same head: the spec file edited and a
 * `replanned` event on the folder, as a re-approval's compile leaves them.
 */
async function respecced(t, { first, findings = [], edit = true, moved = false }) {
  const w = abWorld(t)
  w.rig.script({ [reviewerKey()]: [reviewed(first, findings)] })
  assert.equal((await review(w)).outcome, 'reviewed')
  if (moved) commitIn(w.wt, { 'src/c.mjs': 'export const c = () => 3\n' }, 'More work')
  const file = specPath(w.rig.repo, w.rig.effort, '.')
  if (edit) writeFileSync(file, readFileSync(file, 'utf8').replace('As the plan says.', 'As the plan says, and the names are free.'))
  w.rig.log.append('replanned', { node: '.', reason: 'answered' })
  return w
}
const rerun = { output: { ...REVIEW_EMPTY, units: [{ unit: 'claim:2', ruling: 'clean', why: 'ruled' }, { unit: 'change', ruling: 'clean', why: 'ruled' }], claims: [claim('b is there')] } }
const isRerule = (brief) => brief.includes('# Integration re-rule of folder .')
const THREAD_SECOND = 'integration:.:2'

test('a spec re-approved over an unchanged head is re-ruled: the edit and the claims not passed, the rest standing', SLOW, async (t) => {
  const w = await respecced(t, { first: [claim('a is there'), claim('b is there', 'under')] })
  w.rig.script({ [reviewerKey(THREAD_SECOND)]: [rerun] })
  const out = await review(w)

  assert.equal(out.outcome, 'reviewed')
  const c = w.rig.calls.at(-1)
  assert.equal(c.thread.key, THREAD_SECOND)
  assert.equal(isRerule(c.brief), true)
  assert.ok(c.brief.includes('and the names are free.'), 'the edit')
  const units = c.brief.split('## The units you rule')[1].split('## Measured')[0].split('\n').filter((l) => l.startsWith('- '))
  assert.deepEqual(units, ['- claim:2', '- change'])
  assert.equal(c.brief.includes('decision:D1'), false, 'not the whole review')
  const [, second] = kinds(w.rig, 'claims')
  assert.equal(second.rerule, true)
  assert.deepEqual(second.claims.map((x) => [x.claim, x.ruling]), [['a is there', 'met'], ['b is there', 'met']])
  assert.equal(kinds(w.rig, 'parked').length, 1, 'the first review\'s park is the only one: the re-rule earned none')
  assert.equal(statusOf(w.rig, '.'), 'integrated')
})

const unitsIn = (brief) => brief.split('## The units you rule')[1].split('\n## ')[0].split('\n').filter((l) => l.startsWith('- '))

test('a review after work merged is narrowed to what moved: its files, the decisions it realises, and every prior claim judged again', SLOW, async (t) => {
  const w = await respecced(t, { first: [claim('a is there'), claim('b is there', 'under')], moved: true, edit: false })
  w.rig.log.append('merged', { node: 'b', into: w.rig.branchOf('.'), merged_sha: w.head, head_sha: w.head })
  const ruled = ['claim:1', 'claim:2', 'file:src/c.mjs', 'decision:D2'].map((unit) => ({ unit, ruling: 'clean', why: 'ruled' }))
  w.rig.script({ [reviewerKey(THREAD_SECOND)]: [{ output: { ...REVIEW_EMPTY, units: ruled, claims: [claim('a is there'), claim('b is there')] } }] })
  const out = await review(w)

  assert.equal(out.outcome, 'reviewed')
  const c = w.rig.calls.at(-1)
  assert.equal(isRerule(c.brief), true)
  assert.ok(c.brief.includes('## What merged since the last review'))
  assert.equal(c.brief.includes('## The edit to the spec'), false, 'the spec did not change')
  assert.deepEqual(unitsIn(c.brief), ['- claim:1', '- claim:2', '- file:src/c.mjs', '- decision:D2'],
    'every prior claim over moved work, the files that moved, and the decision b merged since realises')
  const second = kinds(w.rig, 'claims').at(-1)
  assert.equal(second.rerule, true)
  assert.deepEqual(second.claims.map((x) => [x.claim, x.ruling]), [['a is there', 'met'], ['b is there', 'met']])
  assert.equal(statusOf(w.rig, '.'), 'integrated')
})

test('a critical the last review left open is put to the next for a fix ruling, and parks again until ruled fixed', SLOW, async (t) => {
  for (const [status, parks] of [['not_fixed', 1], ['fixed', 0]]) {
    const w = await respecced(t, { first: [claim('a is there')], findings: [CRITICAL], moved: true, edit: false })
    assert.deepEqual(kinds(w.rig, 'claims')[0].open, [{ id: 'F1', claim: 'the pair breaks', failure_scenario: 'a and b disagree' }])
    const parkedBefore = kinds(w.rig, 'parked').length
    w.rig.script({ [reviewerKey(THREAD_SECOND)]: [{ output: { ...REVIEW_EMPTY, units: [{ unit: 'file:src/c.mjs', ruling: 'clean', why: 'ruled' }], fix_rulings: [{ id: 'F1', status, evidence: 'src/a.mjs:1' }] } }] })
    assert.equal((await review(w)).outcome, 'reviewed', status)

    const c = w.rig.calls.at(-1)
    assert.ok(c.brief.includes('## Blockers the last review left open') && c.brief.includes('F1: the pair breaks — fails: a and b disagree'), status)
    assert.equal(kinds(w.rig, 'parked').length - parkedBefore, parks, status)
    assert.deepEqual(kinds(w.rig, 'claims').at(-1).open.map((o) => o.id), parks ? ['F1'] : [], status)
  }
})

test("the user's answers on the folder reach a narrowed review, the latest per question", SLOW, async (t) => {
  const w = await respecced(t, { first: [claim('a is there')], moved: true, edit: false })
  append(w.rig.repo, w.rig.effort, 'ledger', { kind: 'answered', asked: 1, nodes: ['.'], answers: [{ question: 'Guard every callback?', answer: 'Yes' }] })
  append(w.rig.repo, w.rig.effort, 'ledger', { kind: 'answered', asked: 2, nodes: ['.'], answers: [{ question: 'Guard every callback?', answer: 'No: a throw may crash the game' }] })
  append(w.rig.repo, w.rig.effort, 'ledger', { kind: 'answered', asked: 3, nodes: ['c'], answers: [{ question: 'Another folder?', answer: 'Not this one' }] })
  w.rig.script({ [reviewerKey(THREAD_SECOND)]: [{ output: { ...REVIEW_EMPTY, units: [{ unit: 'file:src/c.mjs', ruling: 'clean', why: 'ruled' }] } }] })
  assert.equal((await review(w)).outcome, 'reviewed')

  const brief = w.rig.calls.at(-1).brief
  assert.ok(brief.includes('Answered: No: a throw may crash the game'))
  assert.equal(brief.includes('Answered: Yes'), false, 'only the latest answer to a question')
  assert.equal(brief.includes('Not this one'), false, "another folder's answer")
})

test('an integration reviewer leaves an approved leaf approved: its dispatch names the folder', SLOW, async (t) => {
  const rig = executionRig(t, { spec: TRIVIAL_FOLDER })
  const y = readyLeaf(rig, 'y', { 'src/y.mjs': 'export const y = () => 1\n' }, 'Add y')
  approve(rig, y)
  const base = rootHead(rig)
  assert.equal(ensureIntegration(rig.repo, rig.effort, 'c', rig.envelope).ok, true)
  const wt = rig.worktreeOf('c')
  const sha = commitIn(wt, { 'src/k.mjs': 'export const k = () => 1\n', 'test/k.test.mjs': "import { test } from 'node:test'\ntest('k', () => {})\n" }, 'Add k')
  rig.log.append('merged', { node: 'c/k', into: rig.branchOf('c'), merged_sha: sha, head_sha: sha })
  rig.script({ [reviewerKey('integration:c:1', 'c')]: [reviewed([claim('k is there')])] })
  assert.equal(statusOf(rig, 'y'), 'approved')
  const out = await reviewUnit(rig.ctx, rig.xc, { id: 'c', where: { base, worktree: wt }, unreviewed: ['c/k'], intelligence: 'normal' })

  assert.equal(out.outcome, 'reviewed')
  assert.deepEqual(dispatchedOf(rig, 'reviewer').map((e) => e.node), ['c'])
  assert.equal(statusOf(rig, 'y'), 'approved')
  assert.ok(call(rig).brief.split('\n').includes('- `node --test test/k.test.mjs`: passed'))
})

test("a folder's integration reviewer is handed its sub-efforts' specs and the entries that run after it", SLOW, async (t) => {
  const spec = {
    '.': specOf('Root', [['D1', 'y documents what c ruled.'], ['D2', 'c is there.']], [subEffort('c', 'D2'), task('y', { realises: 'D1', after: 'c' })]),
    c: subSpec([task('k', { realises: 'D2, c.D1' })]),
  }
  const rig = executionRig(t, { spec })
  const base = rootHead(rig)
  assert.equal(ensureIntegration(rig.repo, rig.effort, 'c', rig.envelope).ok, true)
  const wt = rig.worktreeOf('c')
  const sha = commitIn(wt, { 'src/k.mjs': 'export const k = () => 1\n', 'test/k.test.mjs': "import { test } from 'node:test'\ntest('k', () => {})\n" }, 'Add k')
  rig.log.append('merged', { node: 'c/k', into: rig.branchOf('c'), merged_sha: sha, head_sha: sha })
  rig.script({
    [reviewerKey('integration:c:1', 'c')]: [reviewed([claim('k is there')])],
    [reviewerKey()]: [reviewed([claim('c is there')])],
  })
  await reviewUnit(rig.ctx, rig.xc, { id: 'c', where: { base, worktree: wt }, unreviewed: ['c/k'], intelligence: 'normal' })
  const later = call(rig).brief.split('## Entries that run after this folder')[1]
  assert.ok(later && later.includes('- y — Do y; realises D1: y documents what c ruled.'), 'y waits on c, so its claims are not c\'s')

  const rootWt = rig.worktreeOf('.')
  const pass = (n) => "import { test } from 'node:test'\ntest('" + n + "', () => {})\n"
  const files = { 'src/k.mjs': 'export const k = () => 1\n', 'test/k.test.mjs': pass('k'), 'src/y.mjs': 'export const y = 1\n', 'test/y.test.mjs': pass('y') }
  const merged = commitIn(rootWt, files, 'Merge c and y')
  for (const node of ['c', 'y']) rig.log.append('merged', { node, into: rig.branchOf('.'), merged_sha: merged, head_sha: merged })
  const out = await reviewUnit(rig.ctx, rig.xc, { id: '.', where: { base: rig.base_sha, worktree: rootWt }, unreviewed: ['c/k', 'y'], intelligence: 'normal' })
  assert.equal(out.outcome, 'reviewed', JSON.stringify(out))
  const root = rig.calls.find((c) => c.thread.key === THREAD_ROOT).brief
  const child = readFileSync(specPath(rig.repo, rig.effort, 'c'), 'utf8').replace(/\r\n/g, '\n').trimEnd()
  assert.ok(root.split('## The specs of its sub-efforts')[1].includes(child), "the root's reviewer reads c's own spec")
})

test("a sub-folder's integration review is not earned when no child lacked a review and fewer than two met there", SLOW, async (t) => {
  const rig = executionRig(t, { spec: VERIFY_FOLDER })
  const base = rootHead(rig)
  assert.equal(ensureIntegration(rig.repo, rig.effort, 'c', rig.envelope).ok, true)
  const wt = rig.worktreeOf('c')
  const out = await reviewUnit(rig.ctx, rig.xc, { id: 'c', where: { base, worktree: wt }, unreviewed: ['c/v'], intelligence: 'normal' })

  assert.equal(out.outcome, 'not_earned')
  assert.equal(out.said, '')
  assert.equal(rig.calls.length, 0, 'no reviewer')
  assert.deepEqual(kinds(rig, 'claims').map((c) => [c.node, c.review]), [['c', 'not_earned']])
})

test('an integration critical parks the folder through folder-review', SLOW, async (t) => {
  const w = abWorld(t)
  w.rig.script({ [reviewerKey()]: [reviewed([claim('a is there'), claim('b is there')], [CRITICAL])] })
  const out = await review(w)

  assert.equal(out.outcome, 'reviewed')
  const parks = kinds(w.rig, 'parked')
  assert.deepEqual(parks.map((p) => [p.node, p.return, p.said]), [['.', 'integration_critical', out.said]])
  assert.equal(out.said, call(w.rig).dispatch)
})

test('an integration review that returned nothing is a fault on the folder and a lost check', SLOW, async (t) => {
  const w = abWorld(t)
  w.rig.script({ [reviewerKey()]: [{ status: 'failed', cause: 'host_error' }] })
  const out = await review(w)

  assert.equal(out.outcome, 'lost')
  assert.equal(out.said, '')
  assert.deepEqual(kinds(w.rig, 'fault').map((f) => [f.node, f.channel]), [['.', 'host_error']])
  assert.equal(kinds(w.rig, 'claims').length, 0)
  assert.equal(kinds(w.rig, 'parked').length, 0)
})

test('a dispatch that failed for any other cause is a role fault on the folder', SLOW, async (t) => {
  const w = abWorld(t)
  w.rig.script({ [reviewerKey()]: [{ status: 'failed', cause: 'schema_failed' }, { status: 'failed', cause: 'schema_failed' }] })
  const out = await review(w)

  assert.equal(out.outcome, 'lost')
  assert.deepEqual(kinds(w.rig, 'fault').map((f) => [f.node, f.channel]), [['.', 'role']])
  assert.equal(kinds(w.rig, 'claims').length, 0)
})

for (const cause of ['checkout', 'watch_failed']) {
  test(`an integration review whose dispatch failed ${cause} is a checkout fault on the folder and a lost check`, SLOW, async (t) => {
    const w = abWorld(t)
    const runAgent = async (call) => ({ status: 'failed', cause, message: 'the host said ' + cause, session: call.thread.session })
    const out = await reviewUnit(programContext({ intelligence: 'normal', ...w.rig.ctx, runAgent }), w.rig.xc, { id: '.', where: w.where, unreviewed: w.unreviewed })
    assert.deepEqual([out.outcome, out.said], ['lost', ''])
    assert.deepEqual(kinds(w.rig, 'fault').map((f) => [f.node, f.channel]), [['.', 'checkout']])
    assert.equal(kinds(w.rig, 'claims').length, 0)
  })
}

test('a relaunch takes a lost integration review up again in its own session', SLOW, async (t) => {
  const w = abWorld(t)
  w.rig.script({ [reviewerKey()]: [{ status: 'failed', cause: 'host_error' }] })
  const lost = await review(w)
  assert.equal(lost.outcome, 'lost')
  const first = call(w.rig)

  const again = w.rig.relaunch()
  again.script({ [reviewerKey()]: [reviewed([claim('a is there'), claim('b is there')])] })
  const out = await reviewUnit(again.ctx, again.xc, { id: '.', where: w.where, unreviewed: w.unreviewed, intelligence: 'normal' })

  assert.equal(out.outcome, 'reviewed')
  assert.equal(again.calls.length, 1)
  const c = call(again)
  assert.equal(c.thread.key, THREAD_ROOT)
  assert.equal(c.resume, true)
  assert.equal(c.thread.session, first.thread.session, 'the first call\'s session')
  assert.equal(kinds(again, 'claims').length, 1)
})

// ================================================================== a ruler on a moved base

const NOW = 'f00dcafe1234'

/** A moved base as preflight leaves it, over leaf a; `approved` leaves a approved first. */
function staleWorld(t, { approved = false } = {}) {
  const rig = executionRig(t)
  if (approved) approve(rig, readyLeaf(rig, 'a', { 'src/a.mjs': 'export const a = () => 1\n' }))
  const brief = stalePath(rig.repo, rig.effort, rig.stamp, NOW)
  const record = brief.replace(/\.md$/, '.json')
  const text = 'THE STALE BRIEF ' + NOW + '\nNode a was planned against the old base.\n'
  writeWhole(brief, text)
  writeWhole(record, { now: NOW, nodes: ['a'] })
  return { rig, brief, record, text, thread: 'ruler:stale:' + NOW, rule: (extra = {}) => ruleUnit(rig.ctx, rig.xc, { intelligence: 'normal', kind: 'stale', record, brief, ...extra }) }
}

test('a ruler on an approved leaf leaves it approved', SLOW, async (t) => {
  const w = staleWorld(t, { approved: true })
  w.rig.script({ [rulerKey(w.thread)]: [rulings(ruling('a', 'unaffected', 'the base change is elsewhere'))] })
  const out = await w.rule()

  assert.equal(out.outcome, 'ruled')
  assert.deepEqual(out.replan, [])
  assert.equal(statusOf(w.rig, 'a'), 'approved')
  assert.equal(out.dispatch, call(w.rig).dispatch)
  assert.equal(dispatchedOf(w.rig, 'ruler')[0].node, '.')
  const ruled = kinds(w.rig, 'stale-ruled')
  assert.equal(ruled.length, 1)
  assert.deepEqual([ruled[0].node, ruled[0].base_now, ruled[0].ruling, ruled[0].said], ['a', NOW, 'unaffected', call(w.rig).dispatch])
  assert.equal(kinds(w.rig, 'parked').length, 0)
})

test("a leaf with approved work ruled affected on a moved base parks premise_mismatch with the ruler's question", SLOW, async (t) => {
  const w = staleWorld(t, { approved: true })
  const question = 'The approved work assumed the old base: which one wins?'
  w.rig.script({ [rulerKey(w.thread)]: [rulings(ruling('a', 'affected', 'the base moved', question))] })
  const out = await w.rule()

  assert.equal(out.outcome, 'ruled')
  assert.deepEqual(out.replan, [], 'never replanned under approved work')
  const parks = kinds(w.rig, 'parked')
  assert.deepEqual(parks.map((p) => [p.node, p.return, p.question]), [['a', 'premise_mismatch', question]])
})

test('a planned leaf ruled affected on a moved base comes back for the planner; the ruler is briefed with the stale file', SLOW, async (t) => {
  const w = staleWorld(t)
  const question = 'Which of the two bases does a build on?'
  w.rig.script({ [rulerKey(w.thread)]: [rulings(ruling('a', 'affected', 'the base moved', question))] })
  const out = await w.rule({ intelligence: 'low' })

  assert.equal(out.outcome, 'ruled')
  assert.deepEqual(out.replan, [{ id: 'a', question }])
  assert.equal(kinds(w.rig, 'parked').length, 0)
  const ruled = kinds(w.rig, 'stale-ruled')
  assert.deepEqual(ruled.map((r) => [r.node, r.ruling]), [['a', 'affected']])
  assert.equal(w.rig.calls.length, 1)
  const c = call(w.rig)
  assert.equal(c.thread.key, w.thread)
  assert.equal(c.role.name, 'ruler')
  assert.equal(c.node, '.')
  assert.equal(c.resume, false)
  assert.deepEqual(c.schema, schemaOf('ruler_premises'))
  assert.equal(c.brief, w.text, 'exactly the stale brief\'s text')
  assert.deepEqual(c.tier, tierFor(loadRole('ruler').role, { intelligence: 'low' }))
})

test('a leaf the ruler leaves unruled on a moved base is held on a role fault, never parked', SLOW, async (t) => {
  const w = staleWorld(t)
  w.rig.script({ [rulerKey(w.thread)]: [rulings()] })
  const out = await w.rule()

  assert.equal(out.outcome, 'ruled')
  assert.deepEqual(out.replan, [])
  assert.deepEqual(kinds(w.rig, 'fault').map((f) => [f.node, f.channel]), [['a', 'role']])
  assert.equal(kinds(w.rig, 'parked').length, 0)
  assert.equal(kinds(w.rig, 'stale-ruled').length, 0)
})

test('a stale ruler whose dispatch failed is unruled: the leaf is held on a role fault, and no second ruler runs', SLOW, async (t) => {
  const w = staleWorld(t)
  w.rig.script({ [rulerKey(w.thread)]: [{ status: 'failed', cause: 'host_error' }] })
  const out = await w.rule()

  assert.equal(out.outcome, 'unruled')
  assert.deepEqual(out.replan, [])
  assert.equal(w.rig.calls.length, 1)
  assert.deepEqual(kinds(w.rig, 'fault').map((f) => [f.node, f.channel]), [['a', 'role']])
  assert.equal(kinds(w.rig, 'parked').length, 0)
})

test("a drift over a sub-folder is ruled on the folder's own thread, named by the record's pre", SLOW, async (t) => {
  const rig = executionRig(t, { spec: TRIVIAL_FOLDER })
  const pre = 'abcdef0123456789abcdef0123456789abcdef01'
  const record = mergePath(rig.repo, rig.effort, rig.stamp, 'c', pre)
  const brief = record.replace(/\.json$/, '.drift.md')
  const text = 'DRIFT BRIEF OVER c\n'
  writeWhole(brief, text)
  writeWhole(record, { target: 'c', pre, head_sha: pre, drift: [{ node: 'y', contract: 'api', files: ['src/y.mjs'] }] })
  const thread = 'ruler:drift:' + nodeKey('c') + ':' + pre.slice(0, 8)
  rig.script({ [rulerKey(thread)]: [rulings(ruling('y', 'unaffected'))] })
  const out = await ruleUnit(rig.ctx, rig.xc, { kind: 'drift', record, brief, intelligence: 'normal' })

  assert.equal(out.outcome, 'ruled')
  assert.equal(call(rig).thread.key, thread)
  assert.equal(call(rig).node, '.', 'the ruler\'s node is the execution\'s root')
  assert.equal(call(rig).brief, text)
  assert.deepEqual(kinds(rig, 'drift-ruled').map((r) => [r.node, r.contract, r.ruling]), [['y', 'api', 'unaffected']])
})
