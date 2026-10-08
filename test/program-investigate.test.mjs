// test/program-investigate.test.mjs — pins the investigate program: the survey it runs inside its own
// run, the synthesis brief that holds the evidence whole with a caveat per coverage gap, the two
// modes, a failed synthesis, the coverage it carries, what a relaunch calls, and reading a context
// back whole.
//
// Design: docs/DESIGN.md#programs, docs/DESIGN.md#program-results.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { readContext, writeContext } from '../lib/citations.mjs'
import { liveItems, recordItems, recordJudgement } from '../lib/evidence.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import { investigate, scopeOf } from '../lib/programs/investigate.mjs'
import { loadRole, tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { programRig } from './harness/program-rig.mjs'

const QUESTION = 'Can the config loader drop its cache?'
const GUIDE = 'Cite every claim by path and line.'
const numbered = (name, n) => Array.from({ length: n }, (_, i) => name + ' line ' + (i + 1)).join('\n') + '\n'
const FILES = { 'CLAUDE.md': '# Guide\n\n' + GUIDE + '\n', 'src/a.js': numbered('alpha', 40), 'src/b.js': numbered('bravo', 40) }

const plan = (topics, over = {}) => ({ topics, common_ground: '', history_question: '', docs_question: '', ...over })
const topic = (key) => ({ key, find: 'Find ' + key + '.', subtree: 'src' })
const hits = (list, over = {}) => ({ hits: list, searched: ['src/**'], no_match: '', not_reached: '', stop_reason: 'exhausted', ...over })
const claim = (key, path, line, text) => ({ topic: key, kind: 'behaviour', claim: text, spans: [{ path, start: line, end: line }], queries: [], sources: [], rests_on: [] })
const judged = (items, risks = []) => ({ items, risks, units: [...new Set(items.map((i) => i.topic))].map((k) => ({ unit: k, ruling: 'anchored', ids: [], why: '' })) })
const task = (n) => ({ ref: 't' + n, subject: 'Do step ' + n, description: 'src/a.js:' + n + ' needs step ' + n, activeForm: 'Doing step ' + n, blocked_by: n > 1 ? ['t' + (n - 1)] : [] })
const argsOf = (over = {}) => ({ question: QUESTION, roots: ['.'], notes: '', as_tasks: false, intelligence: 'normal', pace: 'balanced', ...over })

/** A one-topic survey whose judge records one claim, then the synthesis step(s) given. */
const script = (synthesis, over = {}) => ({
  'analyst||plan': [{ output: plan([topic('loader')]) }],
  'scout||scout:loader': [{ output: hits([{ path: 'src/a.js', line: 3, note: 'the cache' }]) }],
  'analyst||judge:1': [{ output: judged([claim('loader', 'src/a.js', 3, 'the loader caches in a map')], [{ topic: 'loader', text: 'no tests cover eviction' }]) }],
  'analyst||synthesis': synthesis,
  ...over,
})
const REPORT = [{ output: { report: 'Yes: drop the map at src/a.js:3.' } }]

function rig(t, s) {
  const r = programRig({ files: FILES, script: s })
  t.after(() => r.cleanup())
  return r
}
const on = (r, thread) => r.calls.filter((c) => c.thread.key === thread)
const analyst = () => loadRole('analyst').role

test('an empty question is a report of nothing, with no dispatch', async (t) => {
  for (const question of ['', '  ']) {
    const r = rig(t, {})
    const out = await investigate(r.ctx, argsOf({ question, as_tasks: true }))
    assert.equal(r.calls.length, 0)
    assert.deepEqual([out.mode, out.tasks, out.report], ['report', null, null])
    assert.equal(out.coverage.unreached.length, 1)
    assert.equal(out.coverage.complete, false)
  }
})

test("the investigation's scope is its question", () => {
  assert.deepEqual(scopeOf(argsOf({ notes: 'n', as_tasks: true, pace: 'fast' })), scopeOf(argsOf()))
  assert.deepEqual(scopeOf(argsOf()), { question: fnv1a(QUESTION) })
})

test('the survey runs inside this run, on its log', async (t) => {
  const r = rig(t, script(REPORT))
  await investigate(r.ctx, argsOf())
  assert.deepEqual(r.calls.map((c) => c.thread.key), ['plan', 'scout:loader', 'judge:1', 'synthesis'])
  const dispatched = r.log.entries().filter((e) => e.kind === 'dispatched').map((e) => e.thread)
  assert.deepEqual(dispatched, ['plan', 'scout:loader', 'judge:1', 'synthesis'])
})

test('the survey is asked the question, with the roots, notes, intelligence and pace', async (t) => {
  const s = script(REPORT, {
    'analyst||plan': [{ output: plan([topic('loader'), topic('cache')]) }],
    'scout||scout:cache': [{ output: hits([{ path: 'src/b.js', line: 2, note: 'x' }]) }],
    'analyst||judge:1': [{ output: judged([claim('loader', 'src/a.js', 3, 'loader claim')]) }],
    'analyst||judge:2': [{ output: judged([claim('cache', 'src/b.js', 2, 'cache claim')]) }],
  })
  const r = rig(t, s)
  await investigate(r.ctx, argsOf({ roots: ['pkg-one'], notes: 'The cache was added last year.', intelligence: 'max', pace: 'fast' }))
  const [p] = on(r, 'plan')
  for (const part of [QUESTION, 'pkg-one', 'The cache was added last year.']) assert.ok(p.brief.includes(part), part)
  assert.deepEqual(p.tier, tierFor(analyst(), { intelligence: 'max', base: 'medium' }))
  assert.deepEqual([on(r, 'judge:1').length, on(r, 'judge:2').length], [1, 1], 'pace fast reached the survey')
})

test("the synthesis is the analyst's at the dial, base high, its schema the mode's", async (t) => {
  for (const intelligence of ['low', 'normal', 'max']) {
    for (const asTasks of [false, true]) {
      const r = rig(t, script(asTasks ? [{ output: { summary: 's', gaps: [], tasks: [task(1)] } }] : REPORT))
      await investigate(r.ctx, argsOf({ intelligence, as_tasks: asTasks }))
      const [call] = on(r, 'synthesis')
      assert.equal(call.role.name, 'analyst')
      assert.deepEqual(call.schema, schemaOf(asTasks ? 'investigate_tasks' : 'investigate_report'))
      assert.deepEqual(call.tier, tierFor(analyst(), { intelligence, base: 'high' }), intelligence)
    }
  }
})

test('the synthesis brief holds the context text inline and no context path', async (t) => {
  const r = rig(t, script(REPORT))
  const out = await investigate(r.ctx, argsOf())
  const { brief } = on(r, 'synthesis')[0]
  for (const part of [QUESTION, 'the loader caches in a map', 'no tests cover eviction', GUIDE, 'no search tools']) assert.ok(brief.includes(part), part)
  assert.ok(readContext(out.evidence.context).length > 0)
  assert.ok(brief.includes(readContext(out.evidence.context)))
  assert.ok(!brief.includes(out.evidence.context))
  assert.ok(!brief.includes('.agentics'))
})

test("the synthesis brief names each gap in the survey's coverage", async (t) => {
  const s = {
    'analyst||plan': [{ output: plan([topic('parser'), topic('store'), topic('expiry')], { history_question: 'When?', docs_question: 'What?' }) }],
    'scout||scout:parser': [{ output: hits([{ path: 'src/a.js', line: 3, note: 'x' }]) }],
    'scout||scout:store': [{ output: hits([{ path: 'src/b.js', line: 2, note: 'y' }], { stop_reason: 'stuck', not_reached: '' }) }],
    'scout||scout:expiry': [{ status: 'failed', cause: 'host_error' }],
    'historian||history': [{ status: 'failed', cause: 'host_error' }],
    'doc-researcher||docs': [{ status: 'failed', cause: 'host_error' }],
    'analyst||judge:1': [{ output: judged([claim('store', 'src/b.js', 2, 'store claim')], [{ topic: 'expiry', text: 'nothing came back' }]) }],
    'analyst||synthesis': REPORT,
  }
  const r = rig(t, s)
  const out = await investigate(r.ctx, argsOf())
  const { brief } = on(r, 'synthesis')[0]
  assert.deepEqual(out.coverage.dropped, ['parser'])
  assert.deepEqual(out.coverage.incomplete, ['store', 'expiry'])
  assert.deepEqual(out.coverage.failed_channels, ['history', 'docs'])
  for (const part of ['parser', 'store, expiry', 'the history channel failed', 'the docs channel failed', ...out.coverage.unreached]) {
    assert.ok(brief.includes(part), part)
  }
})

test('tasks mode returns the synthesis tasks whole, with no cap', async (t) => {
  const tasks = Array.from({ length: 15 }, (_, i) => task(i + 1))
  const r = rig(t, script([{ output: { summary: 'Drop the cache in three moves.', gaps: ['eviction timing'], tasks } }]))
  const out = await investigate(r.ctx, argsOf({ as_tasks: true }))
  assert.equal(out.mode, 'tasks')
  assert.deepEqual(out.tasks, { summary: 'Drop the cache in three moves.', gaps: ['eviction timing'], tasks })
  assert.equal(out.report, null)
  assert.equal(out.coverage.complete, true)
})

test('report mode returns the report', async (t) => {
  const r = rig(t, script(REPORT))
  const out = await investigate(r.ctx, argsOf())
  assert.deepEqual([out.mode, out.tasks, out.report], ['report', null, 'Yes: drop the map at src/a.js:3.'])
})

test('a failed synthesis keeps the evidence and names the failure', async (t) => {
  for (const asTasks of [false, true]) {
    const r = rig(t, script([{ status: 'failed', cause: 'host_error' }]))
    const out = await investigate(r.ctx, argsOf({ as_tasks: asTasks }))
    assert.deepEqual([out.mode, out.tasks, out.report], [asTasks ? 'tasks' : 'report', null, null])
    assert.deepEqual(out.coverage.failed_channels, ['synthesis'])
    assert.ok(out.coverage.unreached.some((u) => u.includes('synthesis') && u.includes('host_error')))
    assert.equal(out.coverage.complete, false)
    assert.equal(out.evidence.items.length, 1)
  }
})

test("the evidence is the survey's: items, context, risks, history and docs", async (t) => {
  const r = rig(t, script(REPORT, {
    'analyst||plan': [{ output: plan([topic('loader')], { history_question: 'When did the cache land?' }) }],
    'historian||history': [{ output: { findings: 'abc123 added the cache', searched: ['git log'], no_match: '', not_reached: '', stop_reason: 'exhausted' } }],
  }))
  const out = await investigate(r.ctx, argsOf())
  assert.deepEqual(out.evidence.items.map((i) => i.id), [...liveItems(r.repo).keys()])
  assert.ok(existsSync(out.evidence.context))
  assert.deepEqual(out.evidence.risks, [{ topic: 'loader', n: 1 }])
  assert.ok(existsSync(out.evidence.history))
  assert.equal(out.evidence.docs, null)
})

test("the coverage carries the survey's lists and the run's resumable", async (t) => {
  const r = rig(t, script(REPORT, { 'analyst||judge:1': [{ output: judged([]) }] }))
  const out = await investigate(r.ctx, argsOf())
  assert.deepEqual(out.coverage.dropped, ['loader'])
  assert.deepEqual(out.coverage.resumable, r.ctx.resumable)
  assert.ok(out.coverage.declared.some((d) => d.startsWith('topic loader')))
  assert.equal(out.coverage.complete, false)
})

test("the coverage is not complete when the survey's is not, every list empty", async (t) => {
  const r = rig(t, {})
  const old = recordItems(r.repo, '20250101-000000-survey', [{
    question: 'An older question?', topic: 'old', ground: ['src'], kind: 'behaviour', claim: 'the old claim',
    spans: [{ path: 'src/a.js', start: 3, end: 3 }], queries: [], sources: [], rests_on: [],
  }])
  assert.equal(old.ok, true, JSON.stringify(old))
  assert.equal(recordJudgement(r.repo, old.ids[0], 'fails').ok, true)
  const derived = { topic: 'loader', kind: 'derived', claim: 'derived from the old claim', spans: [], queries: [], sources: [], rests_on: [old.ids[0]] }
  const again = r.relaunch(script(REPORT, { 'analyst||judge:1': [{ output: judged([derived]) }] }))
  const out = await investigate(again.ctx, argsOf())
  assert.ok(out.evidence.items.some((i) => i.state !== 'standing'), JSON.stringify(out.evidence.items))
  for (const list of ['dropped', 'incomplete', 'failed_channels', 'unreached']) assert.deepEqual(out.coverage[list], [], list)
  assert.equal(out.coverage.complete, false)
})

test('a relaunch calls nothing that returned', async (t) => {
  const r = rig(t, script([{ output: { summary: 's', gaps: [], tasks: [task(1), task(2)] } }]))
  const first = await investigate(r.ctx, argsOf({ as_tasks: true }))
  const again = r.relaunch({})
  assert.deepEqual(await investigate(again.ctx, argsOf({ as_tasks: true })), first)
  assert.equal(again.calls.length, 0)
})

// ------------------------------------------------------------------ reading a context back

test('readContext reads every part an index names, in order', (t) => {
  const r = rig(t, {})
  const text = Array.from({ length: 2000 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n'
  const written = writeContext(r.repo, text)
  assert.ok(written.parts.length > 1, 'the text was cut into parts')
  assert.equal(readContext(written.path), text)
})

test('readContext of a context that is gone is empty', (t) => {
  const r = rig(t, {})
  const written = writeContext(r.repo, Array.from({ length: 2000 }, (_, i) => 'line ' + i).join('\n'))
  rmSync(written.parts[1])
  assert.equal(readContext(written.path), '')
  assert.equal(readContext(join(r.repo, 'no-such-context.md')), '')
  assert.equal(readContext(''), '')
})
