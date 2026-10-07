// test/program-survey-reuse.test.mjs — pins how the survey reuses the evidence pool: which items it
// reads, the re-judge of suspect items on the cheapest tier, the topics stale items send to be
// searched again, what the planner, scouts and judges are told, the context and result, relaunch
// over a journaled pool read, and the pool read in the checkout the survey runs in.
//
// Design: docs/DESIGN.md#survey, docs/DESIGN.md#the-drift-ladder.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { itemsFor, liveItems, recordCites, recordItems, recordJudgement } from '../lib/evidence.mjs'
import { appendProject, readProjectLog } from '../lib/ledger.mjs'
import { programContext } from '../lib/programs/common.mjs'
import { survey } from '../lib/programs/survey.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { runLogPath } from '../lib/store.mjs'
import { programRig } from './harness/program-rig.mjs'

// --- the world --------------------------------------------------------------------------------

const Q = 'How does the loader resolve a module path?'
const OLD_Q = 'An earlier question about the loader?'
const GUIDE = 'GUIDE-7f3a: name every loader path you cite.'
const A = 'src/a.js'
const lines = (word, n) => Array.from({ length: n }, (_, i) => `${word} line ${i + 1}`).join('\n') + '\n'
const FILES = {
  'CLAUDE.md': '# Project\n\n' + GUIDE + '\n',
  [A]: lines('alpha', 40),
  'lib/b.js': lines('beta', 20),
}
const EDIT = 'EDITED-9f1 line 11'
/** A line of a file as a brief shows it, not mistaken for a longer line number. */
const lineRe = (word, n) => new RegExp(`${word} line ${n}(?!\\d)`)

const SEED = '20250101-000000-survey'
const PROBE = '20250101-000000-probe'
const seedItem = ({ topic, claim, ground = ['src'], start = 10, end = 12 }) =>
  ({ question: OLD_Q, topic, ground, kind: 'behaviour', claim, spans: [{ path: A, start, end }], queries: [], sources: [], rests_on: [] })
function seed(repo, items, name = SEED) {
  const out = recordItems(repo, name, items)
  assert.equal(out.ok, true, JSON.stringify(out))
  return out.ids
}
/** Edit one line of src/a.js in a working tree, uncommitted. */
const editLine = (base, n, text) => writeFileSync(join(base, 'src', 'a.js'), FILES[A].replace(new RegExp(`^alpha line ${n}$`, 'm'), text))
/** A stale item that stays in the pool: cited first, then ruled fails. */
function makeStale(repo, id) {
  const cited = recordCites(repo, 'e1', 'f', { items: [id] })
  assert.equal(cited.ok, true, JSON.stringify(cited))
  assert.equal(recordJudgement(repo, id, 'fails').ok, true)
}
const stateOf = (repo, id) => (itemsFor(repo, { ground: ['src'], states: ['standing', 'suspect', 'stale'] }).find((it) => it.id === id) || {}).state

// --- scripts ----------------------------------------------------------------------------------

const LOADER = { key: 'loader', find: 'FIND-loader where a module path resolves', subtree: 'src' }
const plan = (topics = [LOADER]) => ({ topics, common_ground: '', history_question: '', docs_question: '' })
const scoutOut = (line) => ({ hits: [{ path: A, line, note: 'seen at ' + A + ':' + line }], searched: ['src'], no_match: '', not_reached: '', stop_reason: 'exhausted' })
const newClaim = (key) => 'NEW-' + key + ' claim from this run'
const newItem = (key, line) => ({ topic: key, kind: 'behaviour', claim: newClaim(key), spans: [{ path: A, start: line, end: line }], queries: [], sources: [], rests_on: [] })
const anchoredUnit = (key) => ({ unit: key, ruling: 'anchored', ids: [], why: 'every claim is anchored' })
const rule = (id, ruling) => ({ id, ruling, why: 'WHY-' + ruling })
const rulings = (list) => [{ output: { rulings: list } }]

/**
 * The plan returns `planned`; `searched` lists every topic key expected to be scouted (planned or
 * forced), each scouted at its own line and given one item by the one judge.
 */
function script({ planned = [LOADER], searched = planned.map((t) => t.key), extra = {} } = {}) {
  const s = { 'analyst||plan': [{ output: plan(planned) }], ...extra }
  searched.forEach((key, i) => { s['scout||scout:' + key] = [{ output: scoutOut(3 + i) }] })
  if (searched.length > 0) {
    s['analyst||judge:1'] = [{
      output: { items: searched.map((key, i) => newItem(key, 3 + i)), risks: [], units: searched.map(anchoredUnit) },
    }]
  }
  return s
}

const ARGS = (over = {}) => ({
  question: Q, roots: ['src'], notes: '', prior: '', max_topics: 8, intelligence: 'normal', pace: 'balanced', ground: ['src'], ...over,
})

/** A rig whose pool `setup` seeds, then the survey run over a relaunched context. */
async function surveyOver(t, setup, s, over = {}) {
  const base = programRig({ files: FILES })
  t.after(() => base.cleanup())
  const seeded = setup(base.repo) || {}
  const rig = base.relaunch(s)
  const result = await survey(rig.ctx, ARGS(over))
  return { rig, result, s: seeded }
}

const on = (rig, thread) => rig.calls.filter((c) => c.thread.key === thread)
const rejudgeCalls = (rig) => rig.calls.filter((c) => c.thread.key.startsWith('rejudge'))
const scoutThreads = (rig) => [...new Set(rig.calls.filter((c) => c.thread.key.startsWith('scout:')).map((c) => c.thread.key))].sort()
const judgeCalls = (rig) => rig.calls.filter((c) => /^judge:\d+$/.test(c.thread.key))
const planBrief = (rig) => on(rig, 'plan')[0].brief
const judgedLines = (repo, id) => readProjectLog(repo, 'items').entries.filter((e) => e.kind === 'judged' && (id === undefined || e.id === id))
const itemLines = (repo) => readProjectLog(repo, 'items').entries.filter((e) => e.kind === 'item')
const poolIdOf = (repo, claim) => ([...liveItems(repo).values()].find((it) => it.claim === claim) || {}).id
const topicTriples = (result) => result.topics.map(({ key, subtree, forced }) => ({ key, subtree, forced }))
const cov = (result) => result.coverage

const KNOWN = 'KNOWN-c41 the loader caches resolved paths'
const SUSPECT = 'SUSPECT-a77 the loader reads line eleven'
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
    const [off] = seed(repo, [seedItem({ topic: 'elsewhere', claim: OFF, ground: ['lib'] })])
    const [id] = seed(repo, [seedItem({ topic: 'known', claim: KNOWN })])
    return { id, off }
  }, script())
  assert.deepEqual(result.reused, [s.id])
  assert.ok(!result.reused.includes(s.off))
  assert.ok(!planBrief(rig).includes(OFF))
})

// --- the re-judge -----------------------------------------------------------------------------

/** One suspect item of `topic` over src, edited at line 11, re-judged by `steps`. */
async function rejudged(t, { topic, steps, planned = [], searched = planned.map((x) => x.key), over = {} }) {
  const base = programRig({ files: FILES })
  t.after(() => base.cleanup())
  const [id] = seed(base.repo, [seedItem({ topic, claim: SUSPECT })])
  editLine(base.repo, 11, EDIT)
  assert.equal(stateOf(base.repo, id), 'suspect')
  const rig = base.relaunch({ 'analyst||rejudge:1': steps(id), ...script({ planned, searched }) })
  const result = await survey(rig.ctx, ARGS(over))
  return { rig, result, id }
}

test('a suspect item is re-judged on the cheapest tier whatever the dial, its claim and changed text inline', async (t) => {
  for (const intelligence of ['low', 'normal', 'max']) {
    const { rig, id } = await rejudged(t, { topic: 'old', steps: (id) => rulings([rule(id, 'holds')]), over: { intelligence } })
    const calls = on(rig, 'rejudge:1')
    assert.equal(calls.length, 1, intelligence)
    assert.equal(calls[0].role.name, 'analyst')
    assert.deepEqual(calls[0].schema, schemaOf('rejudge'))
    assert.deepEqual(calls[0].tier, { model: 'haiku', effort: 'low' }, intelligence)
    const brief = calls[0].brief
    assert.ok(brief.includes(id), intelligence + ': the id')
    assert.ok(brief.includes(SUSPECT), intelligence + ': the claim')
    assert.match(brief, lineRe('alpha', 11), intelligence + ': the old text')
    assert.ok(brief.includes(EDIT), intelligence + ': the new text')
    assert.ok(brief.includes(GUIDE), intelligence + ': the guidance')
  }
})

test('suspect items are re-judged twenty to a call', async (t) => {
  const claims = Array.from({ length: 21 }, (_, i) => `SUSPECT-${String(i).padStart(2, '0')} the loader reads line eleven`)
  const base = programRig({ files: FILES })
  t.after(() => base.cleanup())
  const ids = seed(base.repo, claims.map((claim) => seedItem({ topic: 'held', claim })))
  editLine(base.repo, 11, EDIT)
  const sorted = [...ids].sort()
  const first = sorted.slice(0, 20)
  const last = sorted[20]
  const rig = base.relaunch({
    'analyst||rejudge:1': rulings(first.map((id) => rule(id, 'holds'))),
    'analyst||rejudge:2': rulings([rule(last, 'holds')]),
    ...script({ planned: [] }),
  })
  const result = await survey(rig.ctx, ARGS())
  const [one, two] = [on(rig, 'rejudge:1'), on(rig, 'rejudge:2')]
  assert.equal(one.length, 1)
  assert.equal(two.length, 1)
  for (const id of first) {
    assert.ok(one[0].brief.includes(id), 'rejudge:1 holds ' + id)
    assert.ok(!two[0].brief.includes(id), 'rejudge:2 does not hold ' + id)
  }
  assert.ok(two[0].brief.includes(last), 'rejudge:2 holds the 21st')
  assert.ok(!one[0].brief.includes(last), 'rejudge:1 does not hold the 21st')
  assert.deepEqual([...result.reused].sort(), sorted)
})

test('a re-judged item that holds is known ground', async (t) => {
  const { rig, result, id } = await rejudged(t, { topic: 'held', steps: (id) => rulings([rule(id, 'holds')]), planned: [LOADER] })
  assert.ok(result.reused.includes(id))
  const lines = judgedLines(rig.repo, id)
  assert.equal(lines.length, 1, JSON.stringify(lines))
  assert.equal(lines[0].ruling, 'holds')
  assert.equal(on(rig, 'scout:held').length, 0)
})

test('a re-judged item that fails is searched again', async (t) => {
  const { rig, result, id } = await rejudged(t, { topic: 'loader', steps: (id) => rulings([rule(id, 'fails')]), searched: ['loader'] })
  assert.ok(!result.reused.includes(id))
  assert.deepEqual(topicTriples(result), [{ key: 'loader', subtree: 'src', forced: true }])
  assert.equal(on(rig, 'scout:loader').length, 1)
})

test('an id the re-judge left unruled is unsure, and its topic searched again', async (t) => {
  const { rig, result, id } = await rejudged(t, { topic: 'loader', steps: () => rulings([]), searched: ['loader'] })
  const lines = judgedLines(rig.repo, id)
  assert.equal(lines.length, 1, JSON.stringify(lines))
  assert.equal(lines[0].ruling, 'unsure')
  assert.equal(on(rig, 'scout:loader').length, 1)
  assert.ok(!result.reused.includes(id))
})

test("a failed re-judge records nothing, and its items' topics are searched again", async (t) => {
  const { rig, result } = await rejudged(t, { topic: 'loader', steps: () => [{ status: 'failed', cause: 'host_error' }], searched: ['loader'] })
  assert.equal(on(rig, 'rejudge:1').length, 1)
  assert.deepEqual(judgedLines(rig.repo), [])
  assert.equal(on(rig, 'scout:loader').length, 1)
  assert.equal(cov(result).complete, true, JSON.stringify(cov(result)))
})

// --- stale topics -----------------------------------------------------------------------------

test('a stale topic is searched again, its scout told what it used to claim', async (t) => {
  const { rig, result } = await surveyOver(t, (repo) => {
    const [id] = seed(repo, [seedItem({ topic: 'cache', claim: STALE, ground: ['src/cache'] })])
    makeStale(repo, id)
    assert.equal(stateOf(repo, id), 'stale')
  }, script({ planned: [LOADER], searched: ['cache', 'loader'] }))
  assert.deepEqual(topicTriples(result)[0], { key: 'cache', subtree: 'src/cache', forced: true })
  const scout = on(rig, 'scout:cache')
  assert.equal(scout.length, 1)
  assert.ok(scout[0].brief.includes(STALE), 'the claim')
  assert.ok(scout[0].brief.includes(A + ':10-12'), 'the span')
  const judges = judgeCalls(rig).filter((c) => c.round === 1)
  assert.ok(judges.length > 0)
  assert.ok(judges.some((c) => c.brief.includes(STALE)), 'a judge holds the claim')
})

test('a stale item grounded at the repository is searched again repository-wide', async (t) => {
  const { result } = await surveyOver(t, (repo) => {
    const [id] = seed(repo, [seedItem({ topic: 'everywhere', claim: STALE, ground: ['.'] })])
    makeStale(repo, id)
    assert.equal(stateOf(repo, id), 'stale')
  }, script({ planned: [], searched: ['everywhere'] }))
  assert.deepEqual(topicTriples(result).find((x) => x.key === 'everywhere'), { key: 'everywhere', subtree: '', forced: true })
})

test('the planner is told what the pool establishes and what is searched again', async (t) => {
  const FORCED = 'cache-7c1d'
  const { rig } = await surveyOver(t, (repo) => {
    const [stale] = seed(repo, [seedItem({ topic: FORCED, claim: STALE, ground: ['src/cache'] })])
    makeStale(repo, stale)
    seed(repo, [seedItem({ topic: 'known', claim: KNOWN, start: 20, end: 20 })])
  }, script({ planned: [], searched: [FORCED] }))
  const brief = planBrief(rig)
  assert.ok(brief.includes(KNOWN), 'the standing claim')
  assert.ok(brief.includes(FORCED), 'the forced key')
  assert.ok(!brief.includes(STALE), 'not the stale claim')
})

test('a planned topic a stale topic forces is dropped, forced topics first', async (t) => {
  const planned = [
    { key: 'Cache', find: 'FIND-cache planned again', subtree: 'src/cache' },
    { key: 'fresh', find: 'FIND-fresh something new', subtree: 'src' },
  ]
  const { rig, result } = await surveyOver(t, (repo) => {
    const [id] = seed(repo, [seedItem({ topic: 'cache', claim: STALE, ground: ['src/cache'] })])
    makeStale(repo, id)
  }, script({ planned, searched: ['cache', 'fresh'] }))
  assert.deepEqual(result.topics.map((x) => [x.key, x.forced]), [['cache', true], ['fresh', false]])
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
  const { rig } = await surveyOver(t, (repo) => { seed(repo, [seedItem({ topic: 'known', claim: KNOWN })]) }, script())
  const judges = judgeCalls(rig).filter((c) => c.round === 1)
  assert.equal(judges.length, 1)
  assert.ok(judges[0].brief.includes(KNOWN))
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
  const full = script({ planned: [], searched: ['loader'] })
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

test('the pool is read in the checkout the survey runs in', async (t) => {
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
  const result = await survey(programContext({ ...rig.ctx, root: wt }), ARGS())
  const calls = on(rig, 'rejudge:1')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].brief.includes(WT_LINE), "the worktree's line")
  assert.deepEqual(result.reused, [id])
})
