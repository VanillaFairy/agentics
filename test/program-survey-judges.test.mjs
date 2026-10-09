// test/program-survey-judges.test.mjs — pins the survey program without reuse: what each judge is
// handed, recording through the store with refusals sent back to the judge's own session, the
// context file, the result and its coverage block, the agent bound, relaunch, and a run from a
// linked worktree.
//
// The scripts, the rig and the surveys the parts share are in test/harness/survey-world.mjs.
//
// Design: docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderMessage } from '../lib/conversation.mjs'
import { ITEM_KINDS, liveItems, recordItems, recordJudgement } from '../lib/evidence.mjs'
import { readProjectLog } from '../lib/ledger.mjs'
import { programContext } from '../lib/programs/common.mjs'
import { survey } from '../lib/programs/survey.mjs'
import { tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { runLogPath } from '../lib/store.mjs'
import {
  Q, GUIDE, FILES, FILE, TOPIC, plan, hit, scoutOut, behaviour, anchoredUnit, judgeOut, ARGS, CLAIM,
  basicScript, COMMON, fullScript, rigFor, runSurvey, on, pool, roleOf, cov,
} from './harness/survey-world.mjs'

/** A line of a file as an excerpt shows it, not mistaken for a longer line number. */
const lineRe = (word, n) => new RegExp(`${word} line ${n}(?!\\d)`)

const unanchored = (topic, claim) => ({ topic, kind: 'behaviour', claim, spans: [], queries: [], sources: [], rests_on: [] })

const itemLines = (rig) => readProjectLog(rig.repo, 'items').entries.filter((e) => e.kind === 'item').length

test("a judge is the analyst's at the dial, base high", async (t) => {
  for (const intelligence of ['low', 'normal', 'max']) {
    const { rig } = await runSurvey(t, basicScript(), { intelligence })
    const calls = on(rig, 'judge:1')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].role.name, 'analyst')
    assert.deepEqual(calls[0].schema, schemaOf('items'))
    assert.deepEqual(calls[0].tier, tierFor(roleOf('analyst'), { intelligence, base: 'high' }), intelligence)
  }
})

test("a judge's brief holds its scouts' excerpts and coverage inline", async (t) => {
  const { rig } = await runSurvey(t, fullScript({
    'analyst||plan': [{ output: plan({ topics: [TOPIC.loader], common_ground: COMMON }) }],
    'scout||scout:loader': [{
      output: scoutOut({
        hits: [hit(FILE.loader, 7, 'NOTE-a1 resolves'), hit(FILE.loader, 40, 'NOTE-a2 falls back')],
        searched: ['SEARCHED-src/loader/**'], no_match: 'NOMATCH-no dynamic import',
      }),
    }],
    'scout||common': [{ output: scoutOut({ hits: [hit(FILE.shared, 3, 'NOTE-common helper')] }) }],
    'analyst||judge:1': [{ output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader')] }) }],
  }))
  const brief = on(rig, 'judge:1')[0].brief
  assert.match(brief, lineRe('alpha', 7))
  assert.match(brief, lineRe('alpha', 40))
  assert.match(brief, lineRe('delta', 3))
  for (const part of ['NOTE-a1 resolves', 'NOTE-a2 falls back', 'SEARCHED-src/loader/**', 'NOMATCH-no dynamic import', 'NOTE-common helper']) {
    assert.ok(brief.includes(part), part)
  }
})

test("a judge's brief names each kind's anchor and the units it rules", async (t) => {
  const { rig } = await runSurvey(t, fullScript())
  const brief = on(rig, 'judge:1')[0].brief
  for (const kind of ITEM_KINDS) assert.match(brief, new RegExp('^  ' + kind + ': ', 'm'), kind)
  const unitsLine = brief.split('\n').find((l) => l.startsWith('UNITS —'))
  assert.ok(unitsLine, 'a UNITS line')
  assert.deepEqual(unitsLine.split(': ').at(-1).split(', '), ['loader', 'store'])
})

/** Every port and every kind of later round: a continued scout and a refusals round. */
const everyRoundScript = () => fullScript({
  'scout||scout:loader': [
    { output: scoutOut({ hits: [hit(FILE.loader, 7)], stop_reason: 'unfinished', not_reached: 'the tests folder' }) },
    { output: scoutOut({ hits: [hit(FILE.loader, 9)] }) },
  ],
  'analyst||judge:1': [
    { output: judgeOut({ items: [unanchored('loader', CLAIM)], units: [anchoredUnit('loader'), anchoredUnit('store')] }) },
    { output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader'), anchoredUnit('store')] }) },
  ],
})
const everyThread = ['plan', 'scout:loader', 'scout:store', 'common', 'history', 'docs', 'judge:1']

test('no brief points at a file for its evidence', async (t) => {
  const { rig } = await runSurvey(t, everyRoundScript())
  for (const thread of everyThread) assert.ok(on(rig, thread).length > 0, thread)
  for (const c of rig.calls) {
    assert.ok(!c.brief.includes('.agentics'), c.thread.key + ' round ' + c.round + ' brief')
    assert.ok(!c.freshBrief.includes('.agentics'), c.thread.key + ' round ' + c.round + ' freshBrief')
  }
})

test("every brief carries the repository's guidance", async (t) => {
  const { rig } = await runSurvey(t, everyRoundScript())
  for (const thread of everyThread) assert.ok(on(rig, thread).length > 0, thread)
  assert.ok(on(rig, 'judge:1').some((c) => c.round === 2), 'a refusals round ran')
  for (const c of rig.calls) {
    assert.ok(c.freshBrief.includes(GUIDE), c.thread.key + ' round ' + c.round + ' freshBrief')
    if (c.round === 1) assert.ok(c.brief.includes(GUIDE), c.thread.key + ' brief')
  }
})

// --- the record -------------------------------------------------------------------------------

test("a judge's items are recorded under the question, grounded at their topic's subtree", async (t) => {
  const { rig, result } = await runSurvey(t, basicScript())
  const item = pool(rig).find((it) => it.claim === CLAIM)
  assert.ok(item, 'the item is in the pool')
  assert.equal(item.question, Q)
  assert.equal(item.topic, 'loader')
  assert.deepEqual(item.ground, [TOPIC.loader.subtree])
  assert.ok(result.items.some((it) => it.id === item.id))
})

test("a refused item goes back to its judge's own session with what is wrong", async (t) => {
  const { rig, result } = await runSurvey(t, basicScript({
    'analyst||judge:1': [
      { output: judgeOut({ items: [unanchored('loader', CLAIM)], units: [anchoredUnit('loader')] }) },
      { output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader')] }) },
    ],
  }))
  const messages = rig.log.entries().filter((e) => e.kind === 'message' && e.thread === 'judge:1' && e.msg === 'refusals')
  assert.equal(messages.length, 1)
  const m = messages[0]
  assert.equal(m.payload.refusals[0].claim, CLAIM)
  assert.equal(typeof m.payload.refusals[0].problem, 'string')
  assert.ok(m.payload.refusals[0].problem.trim() !== '')
  const calls = on(rig, 'judge:1')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].round, 2)
  assert.equal(calls[1].resume, true)
  assert.equal(calls[1].thread.session, calls[0].thread.session)
  assert.equal(calls[1].brief, renderMessage({ msg: m.msg, payload: m.payload }))
  assert.deepEqual(calls[1].carries, [m.seq])
  assert.ok(pool(rig).some((it) => it.claim === CLAIM))
  assert.equal(cov(result).complete, true, JSON.stringify(cov(result)))
})

test("a refused item's refusals message says the evidence store refused items", async (t) => {
  const { rig } = await runSurvey(t, basicScript({
    'analyst||judge:1': [
      { output: judgeOut({ items: [unanchored('loader', CLAIM)], units: [anchoredUnit('loader')] }) },
      { output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader')] }) },
    ],
  }))
  const [m] = rig.log.entries().filter((e) => e.kind === 'message' && e.thread === 'judge:1' && e.msg === 'refusals')
  assert.equal(m.payload.of, 'items')
  assert.ok(renderMessage({ msg: m.msg, payload: m.payload }).includes('items'))
})

test('each pass that refuses fewer is asked again', async (t) => {
  const A = 'CLAIM-A loader reads at line 7'
  const B = 'CLAIM-B loader falls back at line 12'
  const { rig, result } = await runSurvey(t, basicScript({
    'analyst||judge:1': [
      { output: judgeOut({ items: [unanchored('loader', A), unanchored('loader', B)], units: [anchoredUnit('loader')] }) },
      { output: judgeOut({ items: [behaviour('loader', A, 7), unanchored('loader', B)], units: [anchoredUnit('loader')] }) },
      { output: judgeOut({ items: [behaviour('loader', B, 12)], units: [anchoredUnit('loader')] }) },
    ],
  }))
  assert.equal(on(rig, 'judge:1').length, 3)
  const claims = pool(rig).map((it) => it.claim)
  assert.ok(claims.includes(A) && claims.includes(B), JSON.stringify(claims))
  assert.deepEqual(result.unrecorded, [])
})

test('a judge that refuses no fewer leaves its topics unrecorded and incomplete', async (t) => {
  const { rig, result } = await runSurvey(t, basicScript({
    'analyst||judge:1': [
      { output: judgeOut({ items: [unanchored('loader', CLAIM)], units: [anchoredUnit('loader')] }) },
      { output: judgeOut({ items: [unanchored('loader', CLAIM)], units: [anchoredUnit('loader')] }) },
      { output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader')] }) },
    ],
  }))
  assert.equal(on(rig, 'judge:1').length, 2)
  assert.deepEqual(result.unrecorded, ['loader'])
  assert.deepEqual(cov(result).incomplete, ['loader'])
  assert.equal(pool(rig).length, 0)
})

// --- context, result and coverage -------------------------------------------------------------

test('the context file holds the items, the risks and the channels', async (t) => {
  const { result } = await runSurvey(t, fullScript())
  const text = readFileSync(result.context, 'utf8')
  for (const part of [CLAIM, 'CLAIM-store writes at line 9', 'RISK-5e6f the store may race', 'HIST-FINDINGS-8a1b', 'DOCS-FINDINGS-9b2c']) {
    assert.ok(text.includes(part), part)
  }
})

test('items come in plan topic order', async (t) => {
  const { result } = await runSurvey(t, fullScript({
    'analyst||judge:1': [{
      output: judgeOut({
        items: [behaviour('store', 'CLAIM-store writes at line 9', 9), behaviour('loader', CLAIM)],
        units: [anchoredUnit('loader'), anchoredUnit('store')],
      }),
    }],
  }))
  assert.deepEqual(result.items.map((it) => it.topic), ['loader', 'store'])
  for (const it of result.items) {
    for (const key of ['id', 'topic', 'kind', 'state']) assert.equal(typeof it[key], 'string', key)
  }
})

test('risks are counted per topic from the judges', async (t) => {
  const { result } = await runSurvey(t, fullScript({
    'analyst||judge:1': [{
      output: judgeOut({
        items: [behaviour('loader', CLAIM), behaviour('store', 'CLAIM-store writes at line 9', 9)],
        risks: [{ topic: 'loader', text: 'r1' }, { topic: 'store', text: 'r2' }, { topic: 'loader', text: 'r3' }],
        units: [anchoredUnit('loader'), anchoredUnit('store')],
      }),
    }],
  }))
  const n = (topic) => (result.risks.find((r) => r.topic === topic) || {}).n
  assert.equal(n('loader'), 2)
  assert.equal(n('store'), 1)
})

test('a topic given neither items nor risks is dropped', async (t) => {
  const { result } = await runSurvey(t, fullScript({
    'analyst||judge:1': [{ output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader'), anchoredUnit('store')] }) }],
  }))
  assert.deepEqual(cov(result).dropped, ['store'])
  assert.ok(!cov(result).incomplete.includes('store'))
  assert.equal(cov(result).complete, false)
})

test('a failed judge drops its topics, naming why', async (t) => {
  const { rig, result } = await runSurvey(t, basicScript({ 'analyst||judge:1': [{ status: 'failed', cause: 'host_error' }] }))
  assert.ok(cov(result).dropped.includes('loader'))
  assert.ok(cov(result).unreached.some((l) => l.includes('judge 1') && l.includes('host_error')), JSON.stringify(cov(result).unreached))
  assert.equal(pool(rig).length, 0)
  assert.deepEqual(result.items, [])
})

test('a topic whose unit the judge left open is incomplete', async (t) => {
  const { result } = await runSurvey(t, fullScript({
    'analyst||judge:1': [{
      output: judgeOut({
        items: [behaviour('loader', CLAIM), behaviour('store', 'CLAIM-store writes at line 9', 9)],
        units: [{ unit: 'store', ruling: 'unanchored', ids: [], why: 'the write is not shown' }],
      }),
    }],
  }))
  assert.ok(cov(result).incomplete.includes('loader'), 'never ruled')
  assert.ok(cov(result).incomplete.includes('store'), 'ruled unanchored')
})

test("a topic whose unit the judge's corrected answer rules anchored is complete", async (t) => {
  const { result } = await runSurvey(t, basicScript({
    'analyst||judge:1': [
      { output: judgeOut({ items: [unanchored('loader', CLAIM)], units: [] }) },
      { output: judgeOut({ items: [behaviour('loader', CLAIM)], units: [anchoredUnit('loader')] }) },
    ],
  }))
  assert.ok(!cov(result).incomplete.includes('loader'))
  assert.equal(cov(result).complete, true, JSON.stringify(cov(result)))
})

test('a survey whose every search finished and every item stands is complete', async (t) => {
  const { rig, result } = await runSurvey(t, basicScript())
  const c = cov(result)
  assert.equal(c.complete, true, JSON.stringify(c))
  for (const list of ['dropped', 'incomplete', 'failed_channels', 'unreached']) assert.deepEqual(c[list], [], list)
  assert.deepEqual(c.resumable, rig.ctx.resumable)
})

test('a survey returning an item that does not stand is not complete', async (t) => {
  const rig = rigFor(t, {})
  const old = recordItems(rig.repo, '20250101-000000-survey', [{
    question: 'An older question?', topic: 'old', ground: ['src/loader'], kind: 'behaviour', claim: 'the old claim',
    spans: [{ path: FILE.loader, start: 3, end: 3 }], queries: [], sources: [], rests_on: [],
  }])
  assert.equal(old.ok, true, JSON.stringify(old))
  const staleId = old.ids[0]
  assert.equal(recordJudgement(rig.repo, staleId, 'fails').ok, true)
  const DERIVED = 'CLAIM-derived from the old claim'
  const rel = rig.relaunch(basicScript({
    'analyst||judge:1': [{
      output: judgeOut({
        items: [{ topic: 'loader', kind: 'derived', claim: DERIVED, spans: [], queries: [], sources: [], rests_on: [staleId] }],
        units: [anchoredUnit('loader')],
      }),
    }],
  }))
  const result = await survey(rel.ctx, ARGS())
  const derived = pool(rel).find((it) => it.claim === DERIVED)
  assert.ok(derived, 'the derived item is recorded')
  const listed = result.items.find((it) => it.id === derived.id)
  assert.ok(listed, 'the result lists it')
  assert.equal(listed.state, 'stale')
  for (const list of ['dropped', 'incomplete', 'failed_channels', 'unreached']) assert.deepEqual(cov(result)[list], [], list)
  assert.equal(cov(result).complete, false)
})

// --- bound, relaunch and root -----------------------------------------------------------------

test('a relaunch calls nothing that returned', async (t) => {
  const { rig, result } = await runSurvey(t, fullScript())
  const before = itemLines(rig)
  const rel = rig.relaunch({})
  const again = await survey(rel.ctx, ARGS())
  assert.equal(rel.calls.length, 0)
  assert.deepEqual(again, result)
  assert.equal(itemLines(rel), before)
})

test('a relaunch cut off before its record was journaled records the same items again under the same ids', async (t) => {
  const { rig, result } = await runSurvey(t, fullScript())
  const path = runLogPath(rig.repo, rig.run)
  const kept = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '' && JSON.parse(l).kind !== 'step')
  assert.ok(kept.length < readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').length, 'the run journaled steps')
  writeFileSync(path, kept.join('\n') + '\n')
  const rel = rig.relaunch({})
  const again = await survey(rel.ctx, ARGS())
  assert.equal(rel.calls.length, 0)
  const ids = result.items.map((it) => it.id).sort()
  assert.ok(ids.length > 0)
  assert.deepEqual(again.items.map((it) => it.id).sort(), ids)
  assert.deepEqual([...liveItems(rel.repo).keys()].sort(), ids)
})

test("a survey given a root reads its excerpts and guidance there and records into the repository's pool", async (t) => {
  const rig = rigFor(t, basicScript())
  const parent = mkdtempSync(join(tmpdir(), 'agentics-survey-root-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const wt = join(parent, 'wt')
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
  git(rig.repo, 'worktree', 'add', '-q', '-b', 'side', wt)
  const ROOT_GUIDE = 'ROOT-GUIDE-2b9c: the worktree has its own rules.'
  const changed = FILES[FILE.loader].replace(/^alpha line 7$/m, 'ROOT-ONLY line 7')
  writeFileSync(join(wt, 'src', 'loader', 'index.mjs'), changed)
  writeFileSync(join(wt, 'CLAUDE.md'), '# Project\n\n' + ROOT_GUIDE + '\n')
  git(wt, 'commit', '-qam', 'side change')
  const wtHead = git(wt, 'rev-parse', 'HEAD')
  assert.notEqual(wtHead, git(rig.repo, 'rev-parse', 'HEAD'))

  await survey(programContext({ ...rig.ctx, root: wt }), ARGS())
  const brief = on(rig, 'judge:1')[0].brief
  assert.ok(brief.includes('ROOT-ONLY line 7'), 'the root\'s line')
  assert.ok(brief.includes(ROOT_GUIDE), 'the root\'s guidance')
  const item = pool(rig).find((it) => it.claim === CLAIM)
  assert.ok(item, 'the item is in the main checkout\'s pool')
  assert.equal(item.spans[0].at, wtHead)
})
