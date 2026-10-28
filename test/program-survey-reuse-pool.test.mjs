// test/program-survey-reuse-pool.test.mjs — pins how the survey reuses the evidence pool: which
// items it reads, the topics stale items send to be searched again, what the planner, scouts and
// judges are told, the context and result, relaunch over a journaled pool read, and the pool read
// in the checkout the survey runs in.
//
// The pool, the scripts and the surveys the parts share are in test/harness/survey-reuse-world.mjs.
//
// Design: docs/DESIGN.md#survey, docs/DESIGN.md#the-drift-ladder.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { itemsFor, liveItems, recordCites, recordJudgement } from '../lib/evidence.mjs'
import { appendProject, readProjectLog } from '../lib/ledger.mjs'
import { programContext } from '../lib/programs/common.mjs'
import { survey } from '../lib/programs/survey.mjs'
import { treeOf } from '../lib/search/pin.mjs'
import { runLogPath } from '../lib/store.mjs'
import { programRig } from './harness/program-rig.mjs'
import {
  A, FILES, EDIT, seedItem, seed, editLine, stateOf, LOADER, newClaim, rule, rulings, script, ARGS, on,
  judgedLines, topicTriples, cov, SUSPECT,
} from './harness/survey-reuse-world.mjs'

const PROBE = '20250101-000000-probe'

/** Stale items that stay in the pool: cited first, in one cite, then each ruled fails. */
function makeStale(repo, ...ids) {
  const cited = recordCites(repo, 'e1', 'f', { items: ids })
  assert.equal(cited.ok, true, JSON.stringify(cited))
  for (const id of ids) assert.equal(recordJudgement(repo, id, 'fails').ok, true)
}

/** A rig whose pool `setup` seeds, then the survey run over a relaunched context. */
async function surveyOver(t, setup, s, over = {}) {
  const base = programRig({ files: FILES })
  t.after(() => base.cleanup())
  const seeded = setup(base.repo) || {}
  const rig = base.relaunch(s)
  const result = await survey(rig.ctx, ARGS(over))
  return { rig, result, s: seeded }
}

const rejudgeCalls = (rig) => rig.calls.filter((c) => c.thread.key.startsWith('rejudge'))
const scoutThreads = (rig) => [...new Set(rig.calls.filter((c) => c.thread.key.startsWith('scout:')).map((c) => c.thread.key))].sort()
const judgeCalls = (rig) => rig.calls.filter((c) => /^judge:\d+$/.test(c.thread.key))
const planBrief = (rig) => on(rig, 'plan')[0].brief

const itemLines = (repo) => readProjectLog(repo, 'items').entries.filter((e) => e.kind === 'item')
const poolIdOf = (repo, claim) => ([...liveItems(repo).values()].find((it) => it.claim === claim) || {}).id

const KNOWN = 'KNOWN-c41 the loader caches resolved paths'

const STALE = 'STALE-e03 the cache keeps results forever'

// --- what is read -----------------------------------------------------------------------------

test('a survey with no ground reads no pool', async (t) => {
  const { rig, result } = await surveyOver(t, (repo) => {
    const [id] = seed(repo, [seedItem({ topic: 'old', claim: SUSPECT })])
    editLine(repo, 11, EDIT)
    assert.equal(stateOf(repo, id), 'suspect')
  }, script(), { ground: [] })
  assert.equal(rejudgeCalls(rig).length, 0)
  assert.ok(!planBrief(rig).includes(SUSPECT))
  assert.deepEqual(result.reused, [])
})

test('standing survey items over the ground are known ground', async (t) => {
  const { rig, result, s } = await surveyOver(t, (repo) => {
    const [id] = seed(repo, [seedItem({ topic: 'known', claim: KNOWN })])
    assert.equal(stateOf(repo, id), 'standing')
    return { id }
  }, script())
  assert.deepEqual(result.reused, [s.id])
  assert.ok(planBrief(rig).includes(KNOWN))
  assert.deepEqual(scoutThreads(rig), ['scout:loader'])
})

test('only survey items are reused', async (t) => {
  const PROBED = 'PROBED-5b0 a probe found this on the ground'
  const { rig, result, s } = await surveyOver(t, (repo) => {
    const [probe] = seed(repo, [seedItem({ topic: 'probed', claim: PROBED })], PROBE)
    const [id] = seed(repo, [seedItem({ topic: 'known', claim: KNOWN })])
    assert.equal(stateOf(repo, probe), 'standing')
    return { id, probe }
  }, script())
  assert.deepEqual(result.reused, [s.id])
  assert.ok(!planBrief(rig).includes(PROBED))
  assert.ok(planBrief(rig).includes(KNOWN))
})

test('an item off the ground is not reused', async (t) => {
  const OFF = 'OFF-2d9 the lib folder has its own loader'
  const { rig, result, s } = await surveyOver(t, (repo) => {
    const [off] = seed(repo, [{ ...seedItem({ topic: 'elsewhere', claim: OFF, ground: ['lib'] }), spans: [{ path: 'lib/b.js', start: 10, end: 12 }] }])
    const [id] = seed(repo, [seedItem({ topic: 'known', claim: KNOWN })])
    return { id, off }
  }, script())
  assert.deepEqual(result.reused, [s.id])
  assert.ok(!planBrief(rig).includes(OFF))
})

// --- stale topics -----------------------------------------------------------------------------

const CACHE = { key: 'cache', find: 'FIND-cache what the cache keeps now', subtree: 'src/cache' }

test('a stale topic the plan adopts is searched again, its search told what it used to claim', async (t) => {
  const { rig, result } = await surveyOver(t, (repo) => {
    const [id] = seed(repo, [seedItem({ topic: 'cache', claim: STALE, ground: ['src/cache'] })])
    makeStale(repo, id)
    assert.equal(stateOf(repo, id), 'stale')
  }, script({ planned: [CACHE, LOADER] }))
  assert.deepEqual(topicTriples(result)[0], { key: 'cache', subtree: 'src/cache', again: true })
  const charge = readFileSync(on(rig, 'scout:cache')[0].role.systemPromptFile, 'utf8')
  for (const part of [CACHE.find, STALE, A + ':10-12']) assert.ok(charge.includes(part), part)
  const judges = judgeCalls(rig).filter((c) => c.round === 1)
  assert.ok(judges.some((c) => c.brief.includes(STALE)), 'a judge holds the claim')
  assert.deepEqual(result.passed, [])
})

test('a stale topic the plan leaves out is not searched, and coverage names it', async (t) => {
  const { rig, result } = await surveyOver(t, (repo) => {
    const [id] = seed(repo, [seedItem({ topic: 'cache', claim: STALE, ground: ['src/cache'] })])
    makeStale(repo, id)
  }, script({ planned: [LOADER] }))
  assert.deepEqual(scoutThreads(rig), ['scout:loader'])
  assert.deepEqual(result.passed, ['cache'])
  assert.ok(cov(result).declared.some((l) => l.startsWith('stale topics the plan did not adopt') && l.endsWith(': cache')), JSON.stringify(cov(result).declared))
  assert.equal(cov(result).complete, true, JSON.stringify(cov(result)))
})

test('the planner is told what the pool establishes and offered each stale topic with what it claimed', async (t) => {
  const STALE_KEY = 'cache-7c1d'
  const { rig } = await surveyOver(t, (repo) => {
    const [stale] = seed(repo, [seedItem({ topic: STALE_KEY, claim: STALE, ground: ['src/cache'] })])
    const [wide] = seed(repo, [seedItem({ topic: 'everywhere', claim: 'WIDE-0b1 the loader is one file', ground: ['.'], start: 30, end: 30 })])
    makeStale(repo, stale, wide)
    seed(repo, [seedItem({ topic: 'known', claim: KNOWN, start: 20, end: 20 })])
  }, script({ planned: [] }))
  const brief = planBrief(rig)
  for (const part of [KNOWN, STALE_KEY + ' (src/cache)', STALE, 'everywhere (the whole repository)']) assert.ok(brief.includes(part), part)
})

test('an item whose anchors all lie off the ground is neither reused nor offered', async (t) => {
  const OFF = 'OFF-2a9 the beta module counts to twenty'
  const { rig, result } = await surveyOver(t, (repo) => {
    const off = (topic, claim) => ({ ...seedItem({ topic, claim, ground: ['.'] }), spans: [{ path: 'lib/b.js', start: 3, end: 4 }] })
    const [stale] = seed(repo, [off('beta-old', OFF)])
    makeStale(repo, stale)
    seed(repo, [off('beta', KNOWN)])
  }, script({ planned: [] }))
  assert.deepEqual(result.reused, [])
  for (const part of ['beta-old', OFF, KNOWN]) assert.ok(!planBrief(rig).includes(part), part)
})

test('a planned key spelled otherwise adopts the stale topic, in the plan\'s order', async (t) => {
  const planned = [
    { key: 'fresh', find: 'FIND-fresh something new', subtree: 'src' },
    { key: 'Cache', find: 'FIND-cache planned again', subtree: 'src/cache' },
  ]
  const { rig, result } = await surveyOver(t, (repo) => {
    const [id] = seed(repo, [seedItem({ topic: 'cache', claim: STALE, ground: ['src/cache'] })])
    makeStale(repo, id)
  }, script({ planned, searched: ['fresh', 'cache'] }))
  assert.deepEqual(result.topics.map((x) => [x.key, x.again]), [['fresh', false], ['cache', true]])
  assert.equal(on(rig, 'scout:cache').length, 1)
})

test('a stale item a newer standing item replaced is neither reused nor searched again', async (t) => {
  const { rig, result, s } = await surveyOver(t, (repo) => {
    const [stale] = seed(repo, [seedItem({ topic: 'cache', claim: STALE })])
    makeStale(repo, stale)
    const [id] = seed(repo, [seedItem({ topic: 'cache', claim: KNOWN, start: 20, end: 20 })])
    assert.equal(stateOf(repo, stale), 'stale')
    return { id, stale }
  }, script({ planned: [] }))
  assert.deepEqual(result.reused, [s.id])
  assert.deepEqual(result.topics, [])
  assert.deepEqual(scoutThreads(rig), [])
})

// --- results and context ----------------------------------------------------------------------

test('a pool that answers the question buys no scout and no judge', async (t) => {
  const { rig, result, s } = await surveyOver(t, (repo) => {
    const [id] = seed(repo, [seedItem({ topic: 'known', claim: KNOWN })])
    return { id }
  }, script({ planned: [] }))
  assert.deepEqual(rig.calls.map((c) => c.thread.key), ['plan'])
  assert.deepEqual(result.reused, [s.id])
  assert.deepEqual(result.items.map(({ id, topic, kind, state }) => ({ id, topic, kind, state })),
    [{ id: s.id, topic: 'known', kind: 'behaviour', state: 'standing' }])
  assert.ok(readFileSync(result.context, 'utf8').includes(KNOWN))
  assert.equal(cov(result).complete, true, JSON.stringify(cov(result)))
})

test("the context holds the ground's standing survey items and the new ones", async (t) => {
  const PROBED = 'PROBED-5b0 a probe found this on the ground'
  const { result } = await surveyOver(t, (repo) => {
    seed(repo, [seedItem({ topic: 'probed', claim: PROBED })], PROBE)
    seed(repo, [seedItem({ topic: 'known', claim: KNOWN })])
  }, script())
  const text = readFileSync(result.context, 'utf8')
  assert.ok(text.includes(KNOWN), 'the standing survey item')
  assert.ok(text.includes(newClaim('loader')), "this run's item")
  assert.ok(!text.includes(PROBED), 'not the probe item')
})

test('reused items come first in the result', async (t) => {
  const AAA = { key: 'aaa', find: 'FIND-aaa something new', subtree: 'src' }
  const { rig, result, s } = await surveyOver(t, (repo) => {
    const [id] = seed(repo, [seedItem({ topic: 'zzz', claim: KNOWN })])
    return { id }
  }, script({ planned: [AAA] }))
  const fresh = poolIdOf(rig.repo, newClaim('aaa'))
  assert.ok(fresh, "this run's item is in the pool")
  assert.equal(result.items.length, 2, JSON.stringify(result.items))
  assert.equal(result.items[0].id, s.id)
  assert.equal(result.items[1].id, fresh)
})

test("a judge's brief holds what the pool establishes", async (t) => {
  const OFF = 'OFF-2d9 the lib folder has its own loader'
  const { rig } = await surveyOver(t, (repo) => {
    seed(repo, [{ ...seedItem({ topic: 'elsewhere', claim: OFF, ground: ['lib'] }), spans: [{ path: 'lib/b.js', start: 10, end: 12 }] }])
    seed(repo, [seedItem({ topic: 'known', claim: KNOWN })])
  }, script())
  const judges = judgeCalls(rig).filter((c) => c.round === 1)
  assert.equal(judges.length, 1)
  const est = judges[0].brief.split('ESTABLISHED —')[1] || ''
  assert.ok(est.includes(KNOWN), 'the standing item is established')
  assert.ok(!judges[0].brief.includes(OFF), 'an item off the ground is not')
})

test('an unreadable pool runs the survey in full and says so', async (t) => {
  const { rig, result } = await surveyOver(t, (repo) => {
    appendProject(repo, 'items', [{ kind: 'item', item: { id: 'I0000abcd', ground: 'src' } }])
    assert.throws(() => itemsFor(repo, { ground: ['src'] }))
  }, script())
  assert.equal(on(rig, 'scout:loader').length, 1)
  assert.ok(poolIdOf(rig.repo, newClaim('loader')), "the planned topic's item is recorded")
  assert.deepEqual(cov(result).failed_channels, ['pool'])
  assert.ok(cov(result).unreached.some((l) => String(l).includes('pool')), JSON.stringify(cov(result).unreached))
  assert.equal(cov(result).complete, false)
})

// --- relaunch and root ------------------------------------------------------------------------

const HELD = 'HELD-31c the loader still reads line eleven'

/** Two suspect items over src, one ruled holds and one fails; the failed topic searched again. */
async function heldAndFailed(t) {
  const base = programRig({ files: FILES })
  t.after(() => base.cleanup())
  const [held, failed] = seed(base.repo, [seedItem({ topic: 'held', claim: HELD }), seedItem({ topic: 'loader', claim: SUSPECT })])
  editLine(base.repo, 11, EDIT)
  const full = script({ planned: [LOADER] })
  const rig = base.relaunch({ 'analyst||rejudge:1': rulings([rule(held, 'holds'), rule(failed, 'fails')]), ...full })
  const result = await survey(rig.ctx, ARGS())
  assert.equal(on(rig, 'rejudge:1').length, 1, 'the first run re-judged')
  assert.deepEqual(result.reused, [held])
  assert.deepEqual(result.topics.map((x) => x.key), ['loader'])
  return { rig, result, full }
}

test('a relaunch calls nothing that returned', async (t) => {
  const { rig, result } = await heldAndFailed(t)
  const items = itemLines(rig.repo).length
  const judged = judgedLines(rig.repo).length
  const rel = rig.relaunch({})
  const again = await survey(rel.ctx, ARGS())
  assert.equal(rel.calls.length, 0)
  assert.deepEqual(again, result)
  assert.equal(itemLines(rel.repo).length, items)
  assert.equal(judgedLines(rel.repo).length, judged)
})

test('a relaunch cut off before its rulings were journaled rules again and reaches the same ground', async (t) => {
  const { rig, result, full } = await heldAndFailed(t)
  const path = runLogPath(rig.repo, rig.run)
  const all = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '')
  const cut = all.findIndex((l) => { const e = JSON.parse(l); return e.kind === 'step' && e.key === 'rulings:1' })
  assert.ok(cut >= 0, 'the run journaled its rulings as step rulings:1')
  writeFileSync(path, all.slice(0, cut).join('\n') + '\n')
  const rel = rig.relaunch(full)
  const again = await survey(rel.ctx, ARGS())
  assert.equal(on(rel, 'rejudge:1').length, 0)
  assert.deepEqual(again.reused, result.reused)
  assert.deepEqual(again.topics, result.topics)
})

/** A pool item standing in the main checkout, and a worktree whose line 11 the survey must see; `survey` runs over them. */
async function poolInWorktree(t, run) {
  const base = programRig({ files: FILES })
  t.after(() => base.cleanup())
  const [id] = seed(base.repo, [seedItem({ topic: 'held', claim: HELD })])
  assert.equal(stateOf(base.repo, id), 'standing')
  const parent = mkdtempSync(join(tmpdir(), 'agentics-survey-reuse-root-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const wt = join(parent, 'wt')
  execFileSync('git', ['-C', base.repo, 'worktree', 'add', '-q', '-b', 'side', wt], { encoding: 'utf8', windowsHide: true })
  const WT_LINE = 'WT-ONLY-6e4 line 11'
  editLine(wt, 11, WT_LINE)
  assert.equal(stateOf(base.repo, id), 'standing', 'the main checkout is untouched')
  const rig = base.relaunch({ 'analyst||rejudge:1': rulings([rule(id, 'holds')]), ...script({ planned: [] }) })
  const result = await run(rig, wt)
  const calls = on(rig, 'rejudge:1')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].brief.includes(WT_LINE), "the worktree's line")
  assert.deepEqual(result.reused, [id])
  assert.deepEqual(result.items.map((it) => [it.id, it.state]), [[id, 'standing']], 'and it stands there')
}

test('the pool is read in the checkout the survey runs in', async (t) => {
  await poolInWorktree(t, (rig, wt) => survey(programContext({ intelligence: 'normal', ...rig.ctx, root: wt }), ARGS()))
})

test('the pool is read in the tree the survey is handed', async (t) => {
  await poolInWorktree(t, (rig, wt) => survey(rig.ctx, ARGS({ tree: treeOf(wt) })))
})

// --- items the caller rests on ------------------------------------------------------------------

test("a caller's items are known ground with no ground of its own, of any kind, and buy no scout they answer", async (t) => {
  const PROBED = 'PROBED-71c a probe found this'
  let ids = []
  const { rig, result } = await surveyOver(t, (repo) => {
    ids = [...seed(repo, [seedItem({ topic: 'probed', claim: PROBED })], PROBE), ...seed(repo, [seedItem({ topic: 'known', claim: KNOWN })])]
  }, script({ planned: [] }), { ground: [], get items() { return ids } })
  assert.deepEqual(rig.calls.map((c) => c.thread.key), ['plan'])
  assert.deepEqual([...result.reused].sort(), [...ids].sort())
  for (const claim of [PROBED, KNOWN]) assert.ok(planBrief(rig).includes(claim), claim)
  assert.ok(readFileSync(result.context, 'utf8').includes(PROBED), 'the context holds the inherited item')
})

test("a stale item a caller rests on that no survey recorded is never a topic to search again", async (t) => {
  let ids = []
  const { rig, result } = await surveyOver(t, (repo) => {
    ids = seed(repo, [seedItem({ topic: 'cache', claim: STALE, ground: ['src/cache'] })], PROBE)
    makeStale(repo, ...ids)
  }, script({ planned: [LOADER] }), { ground: [], get items() { return ids } })
  assert.ok(!planBrief(rig).includes(STALE))
  assert.deepEqual(result.passed, [])
  assert.deepEqual(scoutThreads(rig), ['scout:loader'])
})

test('an item a caller rests on that a re-judge here fails is reported as invalidated', async (t) => {
  const base = programRig({ files: FILES })
  t.after(() => base.cleanup())
  const [id] = seed(base.repo, [seedItem({ topic: 'old', claim: SUSPECT })])
  editLine(base.repo, 11, EDIT)
  const rig = base.relaunch({ 'analyst||rejudge:1': rulings([rule(id, 'fails')]), ...script({ planned: [] }) })
  const result = await survey(rig.ctx, ARGS({ ground: [], items: [id] }))
  assert.deepEqual(result.invalidated, [id])
})
