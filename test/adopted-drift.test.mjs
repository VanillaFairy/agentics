// test/adopted-drift.test.mjs — drift for work adopted on the user's word, against real git:
// preflight briefs one ruler on what the adopted commits touched, rule-close records each ruling
// under its record's seq, and a consumer no ruling reached is held for the next run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { preflight } from '../lib/boundaries/execution.mjs'
import { ruleClose } from '../lib/boundaries/integration.mjs'
import { append, executionLog, readLog } from '../lib/ledger.mjs'
import { ruleUnit } from '../lib/programs/execute/integrate.mjs'
import { adoptedPath, dispatchKey, returnPath, writeJson, writeWhole } from '../lib/store.mjs'
import { commitIn, git, leaf, root, STAMP } from './harness/boundary-fixture.mjs'
import { E, STAMP2, commandsFile, ctxOf, stateKind, world } from './harness/execution-world.mjs'
import { executionRig } from './harness/program-rig.mjs'

const NODES = [
  root(),
  leaf('p', { expects: ['src/p.mjs'], provides: [{ name: 'api', paths: ['src/api.mjs'] }] }),
  leaf('a', { expects: ['src/api.mjs'], deps: ['p'] }),
  leaf('b', { expects: ['src/b.mjs'], deps: ['p'], consumes: [{ name: 'api', paths: ['src/api.mjs'] }] }),
]

let sides = 0
/** A commit touching `files`, on a side branch so the base does not move: its sha. */
function sideCommit(r, files) {
  const name = 'side' + ++sides
  const path = join(r, '.claude', 'worktrees', name)
  git(r, 'worktree', 'add', '-q', '-b', name, path, 'HEAD')
  return commitIn(path, files, 'by hand')
}

const MERGED = (sha) => ({ kind: 'merged', node: 'a', execution: '', into: 'agentics/e1', merged_sha: sha, head_sha: sha, by: 'user', commits: [sha] })
const OUTSIDE = (sha) => ({ kind: 'outside', node: '.', execution: '', commits: [sha], by: 'user' })
const OWN_MERGE = (sha) => { const { by, ...own } = MERGED(sha); return own }
const API = { 'src/api.mjs': 'export const api = 2\n' }

/** A commit touching `files`, recorded as `shape(sha)`: the record's seq. */
function adopt(r, files, shape = MERGED) {
  return append(r, E, 'events', shape(sideCommit(r, files))).seqs[0]
}

/** A world whose first preflight ran, with a record of `shape` over a commit touching `files`: the record's seq. */
async function adoptedWorld(t, files = API, shape = MERGED) {
  const r = world(t, NODES)
  const cf = commandsFile(t)
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).checkpoint, null)
  return { r, cf, seq: adopt(r, files, shape) }
}

const ruledLine = (adopted_seq, node = 'b') => ({ kind: 'drift-ruled', node, contract: 'api', head_sha: '', adopted_seq, ruling: 'unaffected', why: 'x', said: 'd' })

test('preflight briefs one ruler on the consumers adopted work touched, and writes the record beside it', async (t) => {
  const { r, cf, seq } = await adoptedWorld(t)
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.equal(out.checkpoint, null)
  assert.deepEqual(out.adopted.nodes, ['b'])
  assert.deepEqual(out.adopted.seqs, [seq])
  assert.equal(out.adopted.brief, adoptedPath(r, E, STAMP, seq))
  const brief = readFileSync(out.adopted.brief, 'utf8')
  assert.ok(brief.includes('# b'), 'the brief has b\'s block')
  assert.ok(brief.includes('src/api.mjs') && brief.includes('api'), 'the brief names the file and the contract')
  const record = JSON.parse(readFileSync(out.adopted.record, 'utf8'))
  assert.deepEqual(record.seqs, [seq])
  assert.deepEqual(record.drift.map((d) => [d.node, d.contract, d.adopted_seq]), [['b', 'api', seq]])
})

test('a ruling under the record\'s seq, in any execution, covers it on the next launch', async (t) => {
  const { r, cf, seq } = await adoptedWorld(t)
  append(r, E, 'state:' + STAMP2, ruledLine(seq))
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).adopted, null)
})

test('an outside commit on the folder briefs its consumers as an adopted leaf does', async (t) => {
  const { r, cf, seq } = await adoptedWorld(t, API, OUTSIDE)
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(out.adopted.nodes, ['b'])
  assert.deepEqual(out.adopted.seqs, [seq])
})

test("agentics' own merge of the same files owes no ruling", async (t) => {
  const { r, cf } = await adoptedWorld(t, API, OWN_MERGE)
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).adopted, null)
})

test('a consumer that is already merged is not briefed', async (t) => {
  const { r, cf } = await adoptedWorld(t)
  append(r, E, 'events', { kind: 'merged', node: 'b', execution: '', into: 'agentics/e1', head_sha: 'h' })
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).adopted, null)
})

test('a record ruled in one execution is left out while one still unruled is briefed alone', async (t) => {
  const { r, cf, seq: first } = await adoptedWorld(t)
  const second = adopt(r, { 'src/api.mjs': 'export const api = 3\n' })
  append(r, E, 'state:' + STAMP2, ruledLine(first))
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(out.adopted.seqs, [second])
  assert.equal(out.adopted.brief, adoptedPath(r, E, STAMP, second))
  assert.deepEqual(JSON.parse(readFileSync(out.adopted.record, 'utf8')).drift.map((d) => d.adopted_seq), [second])
})

test('two unruled records are briefed together, oldest first, each item tagged with its own record', async (t) => {
  const { r, cf, seq: first } = await adoptedWorld(t)
  const second = adopt(r, { 'src/api.mjs': 'export const api = 3\n' }, OUTSIDE)
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(out.adopted.seqs, [first, second])
  assert.ok(existsSync(out.adopted.brief))
  const record = JSON.parse(readFileSync(out.adopted.record, 'utf8'))
  assert.deepEqual(record.seqs, out.adopted.seqs)
  assert.deepEqual(record.drift.map((d) => d.adopted_seq).sort((x, y) => x - y), [first, second])
})

test("a record's drift comes from its own commits: work that touches nothing consumed leaves no item", async (t) => {
  const { r, cf } = await adoptedWorld(t, { 'docs/notes.md': 'n\n' })
  const touching = adopt(r, API)
  const out = await preflight(ctxOf(r), { commands_file: cf })
  assert.ok(out.adopted.seqs.includes(touching))
  assert.deepEqual(JSON.parse(readFileSync(out.adopted.record, 'utf8')).drift.map((d) => d.adopted_seq), [touching])
})

/** The ruler's dispatch on `ruler:adopted:<seq>` and its stored return: the dispatch. */
function stored(xc, rulings, seq) {
  const thread = 'ruler:adopted:' + seq
  const dispatch = dispatchKey({ node: '.', role: 'ruler', thread, round: 1 })
  xc.log.append('dispatched', { dispatch, node: '.', round: 1, thread, role: 'ruler', model: 'opus', effort: 'medium', session: 's', brief_digest: 'd', brief_parts: {}, carries: [], pid: 1 })
  writeJson(returnPath(xc.dir, dispatch), { rulings })
  xc.log.append('returned', { dispatch, session: 's', status: 'returned', cause: '', usage: null, cost_total: null, cost_usd: null, denials: [] })
  return dispatch
}

test('a record ruled through rule-close is not briefed at the next launch', async (t) => {
  const { r, cf, seq } = await adoptedWorld(t)
  const xc = ctxOf(r)
  const first = await preflight(xc, { commands_file: cf })
  const dispatch = stored(xc, [{ node: 'b', ruling: 'unaffected', why: 'x', question: '' }], seq)
  ruleClose(xc, { kind: 'adopted', record: first.adopted.record, dispatch })
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).adopted, null)
})

test('a ruler that faults holds the consumers, and the next launch rules them again', async (t) => {
  const { r, cf, seq } = await adoptedWorld(t)
  const xc = ctxOf(r)
  const first = await preflight(xc, { commands_file: cf })
  const out = ruleClose(xc, { kind: 'adopted', record: first.adopted.record, dispatch: 'no-such-dispatch' })
  assert.deepEqual(out.stops.map((s) => [s.id, s.status]), [['b', 'held']])
  assert.equal(stateKind(r, 'drift-ruled').length, 0)
  const next = await preflight(ctxOf(r), { commands_file: cf })
  assert.deepEqual(next.adopted.seqs, [seq])
  assert.deepEqual(next.adopted.nodes, ['b'])
})

test('adopted work that touches nothing a pending node consumes briefs nobody', async (t) => {
  const { r, cf } = await adoptedWorld(t, { 'docs/notes.md': 'n\n' })
  assert.equal((await preflight(ctxOf(r), { commands_file: cf })).adopted, null)
})

test('adopted work is not examined at a checkpoint', async (t) => {
  const { r, cf, seq } = await adoptedWorld(t)
  const out = await preflight(ctxOf(r), { commands_file: cf, plan_only: true })
  assert.equal(out.checkpoint.reason, 'parked')
  assert.equal(out.adopted, null)
  assert.equal(existsSync(adoptedPath(r, E, STAMP, seq)), false, 'no brief is written')
})

/** A record as preflight writes it, the ruler's stored return, and rule-close over them. */
function ruled(t, rulings, drift, nodes = NODES) {
  const r = world(t, nodes)
  const xc = ctxOf(r)
  const record = adoptedPath(r, E, STAMP, 12).replace(/\.drift\.md$/, '.json')
  writeJson(record, { kind: 'adopted', target: '.', seqs: [11, 12], head_sha: '', drift })
  const dispatch = stored(xc, rulings, 12)
  return { r, xc, out: ruleClose(xc, { kind: 'adopted', record, dispatch }), dispatch }
}
const item = (node, seq) => ({ node, contract: 'api', files: ['src/api.mjs'], adopted_seq: seq })

test('each ruling is a drift-ruled line under its record\'s seq: two records, two lines that both stand', (t) => {
  const { r, out, dispatch } = ruled(t, [{ node: 'b', ruling: 'unaffected', why: 'reads none of it', question: '' }], [item('b', 11), item('b', 12)])
  assert.deepEqual(out.replan, [])
  assert.deepEqual(stateKind(r, 'drift-ruled').map((e) => [e.node, e.contract, e.adopted_seq, e.ruling, e.said]),
    [['b', 'api', 11, 'unaffected', dispatch], ['b', 'api', 12, 'unaffected', dispatch]])
})

test('a consumer ruled affected goes to its planner or parks, as merge-batch drift does', (t) => {
  const { r, out } = ruled(t, [{ node: 'b', ruling: 'affected', why: 'the api moved', question: 'does b still hold?' }], [item('b', 11)])
  assert.deepEqual([...out.replan.map((x) => x.id), ...out.stops.map((s) => s.id)], ['b'], JSON.stringify(out))
  assert.deepEqual(stateKind(r, 'drift-ruled').map((e) => [e.node, e.adopted_seq, e.ruling]), [['b', 11, 'affected']])
})

test('a consumer no ruling reached is held on a role fault, never parked: the next run rules it again', (t) => {
  const { r, out } = ruled(t, [], [item('b', 11)])
  assert.deepEqual(out.stops.map((s) => [s.id, s.status]), [['b', 'held']])
  assert.equal(readLog(r, E, 'events').entries.filter((e) => e.kind === 'parked').length, 0)
  assert.equal(stateKind(r, 'drift-ruled').length, 0)
})

test('rulings reach each consumer on its own: the one a ruling skipped is held while the ruled one is recorded', (t) => {
  const nodes = [...NODES, leaf('m', { expects: ['src/m.mjs'], deps: ['p'], consumes: [{ name: 'api', paths: ['src/api.mjs'] }] })]
  const { r, out } = ruled(t, [{ node: 'b', ruling: 'unaffected', why: 'x', question: '' }], [item('b', 11), item('m', 11)], nodes)
  assert.deepEqual(stateKind(r, 'drift-ruled').map((e) => [e.node, e.adopted_seq]), [['b', 11]])
  assert.deepEqual(out.stops.map((s) => [s.id, s.status]), [['m', 'held']])
})

test("the adopted drift ruler is one fresh ruler on the root's thread ruler:adopted:<newest seq>, briefed with preflight's file", { timeout: 120_000 }, async (t) => {
  const rig = executionRig(t)
  const brief = adoptedPath(rig.repo, rig.effort, rig.stamp, 12)
  const record = brief.replace(/\.drift\.md$/, '.json')
  writeWhole(brief, 'THE ADOPTED BRIEF\n')
  writeWhole(record, { kind: 'adopted', target: '.', seqs: [11, 12], head_sha: '', drift: [{ node: 'a', contract: 'api', files: ['src/a.mjs'], adopted_seq: 12 }] })
  rig.script({ 'ruler|.|ruler:adopted:12': [{ output: { rulings: [{ node: 'a', ruling: 'unaffected', why: 'elsewhere', question: '' }] } }] })
  const out = await ruleUnit(rig.ctx, rig.xc, { kind: 'adopted', record, brief, intelligence: 'normal' })
  assert.equal(out.outcome, 'ruled')
  assert.equal(rig.calls.length, 1)
  assert.equal(rig.calls[0].thread.key, 'ruler:adopted:12')
  assert.ok(rig.calls[0].brief.includes('THE ADOPTED BRIEF'))
  assert.ok(existsSync(record))
  const lines = readLog(rig.repo, rig.effort, 'state:' + rig.stamp).entries.filter((e) => e.kind === 'drift-ruled')
  assert.deepEqual(lines.map((e) => [e.node, e.contract, e.adopted_seq, e.ruling]), [['a', 'api', 12, 'unaffected']])
})

test('an adopted ruler whose dispatch failed is unruled: the consumer is held on a role fault, never parked, and no second ruler runs', { timeout: 120_000 }, async (t) => {
  const rig = executionRig(t)
  const brief = adoptedPath(rig.repo, rig.effort, rig.stamp, 12)
  const record = brief.replace(/\.drift\.md$/, '.json')
  writeWhole(brief, 'THE ADOPTED BRIEF\n')
  writeWhole(record, { kind: 'adopted', target: '.', seqs: [12], head_sha: '', drift: [{ node: 'a', contract: 'api', files: ['src/a.mjs'], adopted_seq: 12 }] })
  rig.script({ 'ruler|.|ruler:adopted:12': [{ status: 'failed', cause: 'host_error' }] })
  const out = await ruleUnit(rig.ctx, rig.xc, { kind: 'adopted', record, brief, intelligence: 'normal' })
  assert.equal(out.outcome, 'unruled')
  assert.equal(rig.calls.length, 1)
  const entries = executionLog(rig.repo, rig.effort, rig.stamp).entries()
  assert.deepEqual(entries.filter((e) => e.kind === 'fault').map((f) => [f.node, f.channel]), [['a', 'role']])
  assert.equal(entries.filter((e) => e.kind === 'parked').length, 0)
  assert.equal(readLog(rig.repo, rig.effort, 'state:' + rig.stamp).entries.filter((e) => e.kind === 'drift-ruled').length, 0)
})
