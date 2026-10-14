// test/fast/search-loop.test.mjs — pins one search as code runs it: the ground built once, one
// navigator session resumed turn by turn with the charge as its system prompt and the turn brief on
// standard input, every ask ended on the state the records fold to, a separate ruler at the
// check-ins, missing outcomes paused and never answered, and a relaunch or a call with more asks
// replaying what the journal holds. The scripted runner stands in for the host, and its `calls`
// seam for the tool server.
//
// Design: docs/DESIGN.md#evidence and docs/DESIGN.md#l2--states-end-work-counts-dont.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BRIEF_BUDGET_CHARS, chargeOf, digestOf, rulerBrief, turnBrief } from '../../lib/briefs/search.mjs'
import { renderMessage } from '../../lib/conversation.mjs'
import { fnv1a } from '../../lib/plan-digest.mjs'
import { programContext, scoped } from '../../lib/programs/common.mjs'
import { askAfter } from '../../lib/programs/converge.mjs'
import { groundFor, search } from '../../lib/programs/search/loop.mjs'
import { loadRole, tierFor } from '../../lib/roles.mjs'
import { schemaOf } from '../../lib/schemas.mjs'
import { coverageLines, foldLedger, stateOf } from '../../lib/search/ledger.mjs'
import { TOOLS_BY_DOMAIN, searchDir } from '../../lib/search/server.mjs'
import { memoryLog } from './harness/memory-log.mjs'
import { scriptedRunner } from './harness/scripted-runner.mjs'

const RUN = '20260101-000000-test'
const NOW = () => '2026-01-01T00:00:00.000Z'
const TREE = { root: '/pinned/tree', sha: 'a'.repeat(40) }
const NAME = 'locate'
const NAV = 'scout||' + NAME
const RULER_AT = (turn) => 'ruler||ruler:search:' + NAME + ':' + turn
const GROUND = { rows: [], seeds: [] }
const MATERIAL = [{ label: 'The artefact', text: '# The artefact\n\nIt names `src/a.mjs` and `parseWidget`.' }]
const CUT_OFF = renderMessage({ msg: 'cut_off' })
/** A digest budget no ledger of this file comes near, so the digest is never folded. */
const WHOLE = Number.MAX_SAFE_INTEGER

const ask = (key, over = {}) => ({ key, find: 'where ' + key + ' is settled', scope: ['.'], domain: 'repo', ...over })
const specOf = (asks, over = {}) => ({ name: NAME, role: 'scout', schema: 'search_repo', tree: TREE, asks, material: MATERIAL, intelligence: 'normal', ...over })

/**
 * One run's world: a scratch home, one log that every start reads back (a relaunch is a start over
 * the same log), the resolver calls the seam received, and the search's call log as it stands.
 */
function world(t, { ground = GROUND } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agentics-search-loop-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const dir = join(home, 'run')
  const log = memoryLog()
  const grounds = []
  const start = (script, { sleep = () => Promise.resolve() } = {}) => {
    const runner = scriptedRunner(script, { log, now: NOW })
    const ctx = {
      ...programContext({ repo: home, root: home, run: RUN, log, runAgent: runner.runAgent, now: NOW, sleep, dir }),
      groundOf: async (tree, args) => { grounds.push({ tree, args }); return ground },
    }
    return { ctx, calls: runner.calls }
  }
  const path = join(searchDir(dir, NAME), 'calls.jsonl')
  const journal = () => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
  const steps = () => Object.fromEntries(log.entries().filter((e) => e.kind === 'step').map((e) => [e.key, e.value]))
  return { log, grounds, start, journal, steps, path, dir }
}

/** A grep code ran for `asks`, showing each `path:line` of `lines`. Its pattern tells calls apart. */
const grep = (asks, lines, pattern = 'seen ' + lines.join(' ')) => ({
  tool: 'grep', args: { pattern, fixed: false, ignore_case: false, paths: [], page: 1 }, asks, ok: true,
  total: lines.length, page: 1, pages: 1,
  observed: lines.map((at) => ({ key: at.split(':')[0], line: Number(at.split(':')[1]) })),
  keys: [...new Set(lines.map((at) => at.split(':')[0]))],
})
const back = ({ hits = [], dismissed = [], leads = [], asks = [] } = {}) => ({ hits, dismissed, leads, asks })
const hit = (asks, at, note = 'settled at ' + at) => ({ ask: asks, path: at.split(':')[0], line: Number(at.split(':')[1]), note })
const declared = (key, d) => ({ ask: key, declared: d })

/** A navigator turn: the calls its tools made, and its return. A missing turn ends without one. */
const turnOf = (calls, output) => ({ calls, output })
const missing = (cause = 'host_error') => ({ missing: cause, calls: [] })
/** A turn that greps one new line for `key` and leaves it open. */
const looking = (key, n) => turnOf([grep([key], ['src/' + key.replace(/\W/g, '_') + '.mjs:' + n])], back({ asks: [declared(key, 'open')] }))
/** A turn that settles `key` on a line its own grep shows. */
const settling = (key, at) => turnOf([grep([key], [at], 'settle ' + at)], back({ hits: [hit([key], at)], asks: [declared(key, 'answered')] }))
/** A turn that greps one new line for each of `keys` and leaves them all open. */
const moving = (keys, n) => turnOf(keys.map((k) => grep([k], ['src/' + k + '.mjs:' + n])), back({ asks: keys.map((k) => declared(k, 'open')) }))
const quiet = () => turnOf([], back())

/** The scripted starts of `turns`, in order. */
const stepsOf = (turns) => turns.map((t) => (t.missing ? { status: 'failed', cause: t.missing, calls: t.calls } : { output: t.output, calls: t.calls }))
const units = (...rulings) => rulings.map(([unit, ruling]) => ({ unit, ruling, why: unit + ' is ' + ruling + ' over the turns before the check-in' }))

/**
 * Pure. The ledger the records of `turns` and `rulings` fold to: each call numbered as the server
 * numbers it, each turn through its last call, each ask open from its first turn (`from`, 1 unless
 * it joined later).
 */
function ledgerOf({ asks, turns, rulings = [], from = {}, ground = GROUND }) {
  let seq = 0
  const calls = []
  const folded = turns.map((t, i) => {
    for (const c of t.calls) calls.push({ ...c, seq: ++seq })
    if (t.stop) return { turn: i + 1, calls_through: seq, stop: t.stop }
    return t.missing ? { turn: i + 1, missing: t.missing, calls_through: seq } : { turn: i + 1, output: t.output, calls_through: seq }
  })
  return foldLedger({ asks: asks.map((a) => ({ ...a, from: from[a.key] || a.from || 1 })), ground, calls, turns: folded, rulings })
}

const roleOf = (name) => loadRole(name).role
/** The tool server's spec, as the MCP config a dispatch carried names it. */
const serverSpecOf = (call) => JSON.parse(readFileSync(JSON.parse(readFileSync(call.mcpConfig, 'utf8')).mcpServers.search.args[2], 'utf8'))
const rolesIn = (calls) => calls.map((c) => c.role.name)

// --- turns -----------------------------------------------------------------------------------

test('the first turn is a fresh session whose system prompt is the role and the charge, and whose standard input is the turn brief', async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const { ctx, calls } = w.start({ [NAV]: stepsOf([settling('A', 'src/a.mjs:3')]) })
  const result = await search(ctx, specOf(asks, { base: 'high' }))
  assert.equal(calls.length, 1)
  const [first] = calls
  assert.equal(first.resume, false)
  assert.equal(first.round, 1)
  assert.equal(first.thread.key, NAME)
  assert.equal(first.role.name, 'scout')
  assert.deepEqual(first.schema, schemaOf('search_repo'))
  assert.deepEqual(first.tier, tierFor(roleOf('scout'), { intelligence: 'normal', base: 'high' }))
  const charge = chargeOf({ domain: 'repo', asks, material: MATERIAL, ground: GROUND })
  assert.equal(readFileSync(first.role.systemPromptFile, 'utf8'), roleOf('scout').prompt + '\n\n' + charge)
  assert.equal(first.brief, turnBrief(ledgerOf({ asks, turns: [] }), { turn: 1 }))
  assert.equal(result.asks.A.end, 'done')
})

test('every later turn resumes the same session with its own turn brief: no fresh session, no message, no continue_search', async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const turns = [looking('A', 1), looking('A', 2), settling('A', 'src/A.mjs:2')]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns) })
  const result = await search(ctx, specOf(asks))
  assert.equal(calls.length, 3)
  calls.slice(1).forEach((call, i) => {
    const turn = i + 2
    assert.equal(call.round, turn)
    assert.equal(call.resume, true, 'turn ' + turn)
    assert.equal(call.thread.key, NAME)
    assert.equal(call.thread.session, calls[0].thread.session, 'turn ' + turn)
    assert.equal(call.brief, turnBrief(ledgerOf({ asks, turns: turns.slice(0, turn - 1) }), { turn }), 'turn ' + turn)
  })
  assert.deepEqual(w.log.entries().filter((e) => e.kind === 'thread_renewed'), [])
  assert.deepEqual(w.log.entries().filter((e) => e.kind === 'message'), [])
  assert.equal(result.asks.A.end, 'done')
})

test("a turn's thread brief is the ledger's digest, so a renewed session starts from the digest", async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const turns = [looking('A', 1), looking('A', 2), settling('A', 'src/A.mjs:2')]
  const [s1, s2, s3] = stepsOf(turns)
  const { ctx, calls } = w.start({ [NAV]: [s1, { status: 'failed', cause: 'session_missing' }, s2, s3] })
  const result = await search(ctx, specOf(asks))
  assert.equal(calls.length, 3)
  calls.forEach((call, i) => {
    const digest = digestOf(ledgerOf({ asks, turns: turns.slice(0, i) }), { budget: WHOLE })
    assert.equal(call.freshBrief, digest, 'turn ' + (i + 1))
    assert.equal(call.briefDigest, fnv1a(digest), 'turn ' + (i + 1))
  })
  assert.deepEqual(w.log.entries().filter((e) => e.kind === 'thread_renewed').map((e) => [e.thread, e.why]), [[NAME, 'session_missing']])
  const sessions = result.sessions.map((s) => s.session)
  assert.equal(new Set(sessions).size, 2, 'the first session and the renewed one')
  assert.ok(result.sessions.every((s) => s.thread === NAME))
  assert.ok(sessions.includes(calls[0].thread.session))
  assert.ok(sessions.includes(calls[2].thread.session))
  assert.notEqual(calls[2].thread.session, calls[0].thread.session, 'turn 3 resumes the renewed session')
  assert.equal(calls[2].resume, true)
})

// --- endings ---------------------------------------------------------------------------------

test('after each return the asks its state ends are ended, and the next turn is briefed without them', async (t) => {
  const w = world(t)
  const asks = [ask('A'), ask('B')]
  const turns = [
    turnOf([grep(['A'], ['src/a.mjs:3']), grep(['B'], ['src/b.mjs:1'])],
      back({ hits: [hit(['A'], 'src/a.mjs:3')], asks: [declared('A', 'answered'), declared('B', 'open')] })),
    quiet(),
  ]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns) })
  const result = await search(ctx, specOf(asks))
  assert.equal(calls.length, 2, 'B, which the second turn left as it was, ends there: no third turn')
  assert.equal(calls[1].brief, turnBrief(ledgerOf({ asks, turns: turns.slice(0, 1) }), { turn: 2 }))
  const end = ledgerOf({ asks, turns })
  for (const key of ['A', 'B']) {
    assert.deepEqual([result.asks[key].end, result.asks[key].label, result.asks[key].why],
      [end.asks[key].end.state, end.asks[key].end.label, end.asks[key].end.why], key)
  }
  assert.deepEqual([result.asks.A.end, result.asks.B.end], ['done', 'no_progress'])
})

test('at a check-in the open asks whose state moved go to a separate ruler, one unit per ask, and at no other turn', async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const turns = [looking('A', 1), looking('A', 2), looking('A', 3), settling('A', 'src/A.mjs:3')]
  const ruled = units(['A', 'converging'])
  const [s1, s2, s3, s4] = stepsOf(turns)
  const { ctx, calls } = w.start({ [NAV]: [s1, { status: 'failed', cause: 'session_missing' }, s2, s3, s4], [RULER_AT(3)]: [{ output: { units: ruled } }] })
  const result = await search(ctx, specOf(asks, { intelligence: 'max' }))
  assert.deepEqual(rolesIn(calls), ['scout', 'scout', 'scout', 'ruler', 'scout'])
  const ruler = calls[3]
  const at3 = ledgerOf({ asks, turns: turns.slice(0, 3) })
  const sent = stateOf(at3, { turn: 3, checkin: askAfter(3) }).toRuler
  assert.deepEqual(sent, ['A'])
  assert.equal(ruler.thread.key, 'ruler:search:' + NAME + ':3')
  assert.deepEqual(ruler.schema, schemaOf('ruler_search'))
  assert.equal(ruler.brief, rulerBrief(at3, { asks: sent, turn: 3 }))
  assert.deepEqual(ruler.tier, tierFor(roleOf('ruler'), { intelligence: 'max' }))
  assert.deepEqual(calls[0].tier, tierFor(roleOf('scout'), { intelligence: 'max', base: '' }))
  assert.equal(new Set(result.sessions.map((s) => s.session)).size, 2, 'the navigator ran in two sessions')
  for (const s of result.sessions) {
    assert.notEqual(s.session, ruler.thread.session, 'the ruler is none of the navigator sessions')
    assert.notEqual(s.thread, ruler.thread.key, 'the ruler is not on the navigator thread')
  }
  assert.equal(calls[4].brief, turnBrief(ledgerOf({ asks, turns: turns.slice(0, 3), rulings: [{ turn: 3, asks: sent, units: ruled }] }), { turn: 4 }))
  assert.equal(result.asks.A.end, 'done')
})

test("a ruler's not_converging ends that ask, ruled, while its converging lets the other go on", async (t) => {
  const w = world(t)
  const asks = [ask('A'), ask('B')]
  const turns = [moving(['A', 'B'], 1), moving(['A', 'B'], 2), moving(['A', 'B'], 3), settling('B', 'src/B.mjs:3')]
  const ruled = units(['A', 'not_converging'], ['B', 'converging'])
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns), [RULER_AT(3)]: [{ output: { units: ruled } }] })
  const result = await search(ctx, specOf(asks))
  assert.deepEqual(rolesIn(calls), ['scout', 'scout', 'scout', 'ruler', 'scout'])
  const sent = stateOf(ledgerOf({ asks, turns: turns.slice(0, 3) }), { turn: 3, checkin: true }).toRuler
  assert.equal(calls[4].brief, turnBrief(ledgerOf({ asks, turns: turns.slice(0, 3), rulings: [{ turn: 3, asks: sent, units: ruled }] }), { turn: 4 }))
  assert.deepEqual([result.asks.A.end, result.asks.A.label, result.asks.A.why], ['not_converging', 'ruled', ruled[0].why])
  assert.equal(result.asks.B.end, 'done')
})

test('an ask the ruler leaves unruled is ruled again at once, on the same state, before any other turn', async (t) => {
  const w = world(t)
  const asks = [ask('A'), ask('B')]
  const both = turnOf([grep(['A'], ['src/A.mjs:3'], 'settle A'), grep(['B'], ['src/B.mjs:3'], 'settle B')],
    back({ hits: [hit(['A'], 'src/A.mjs:3'), hit(['B'], 'src/B.mjs:3')], asks: [declared('A', 'answered'), declared('B', 'answered')] }))
  const turns = [moving(['A', 'B'], 1), moving(['A', 'B'], 2), moving(['A', 'B'], 3), both]
  const [ruledA, ruledB] = [units(['A', 'converging']), units(['B', 'converging'])]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns), [RULER_AT(3)]: [{ output: { units: ruledA } }, { output: { units: ruledB } }] })
  const result = await search(ctx, specOf(asks))
  assert.deepEqual(rolesIn(calls), ['scout', 'scout', 'scout', 'ruler', 'ruler', 'scout'])
  const [first, second] = [calls[3], calls[4]]
  const at3 = ledgerOf({ asks, turns: turns.slice(0, 3) })
  const sent = stateOf(at3, { turn: 3, checkin: true }).toRuler
  assert.deepEqual([...sent].sort(), ['A', 'B'])
  assert.equal(first.brief, rulerBrief(at3, { asks: sent, turn: 3 }))
  assert.equal(second.thread.key, first.thread.key)
  assert.equal(second.round, 2)
  assert.equal(second.brief, rulerBrief(at3, { asks: ['B'], turn: 3 }))
  const rulings = [{ turn: 3, asks: sent, units: ruledA }, { turn: 3, asks: ['B'], units: ruledB }]
  assert.equal(calls[5].brief, turnBrief(ledgerOf({ asks, turns: turns.slice(0, 3), rulings }), { turn: 4 }))
  assert.deepEqual([result.asks.A.end, result.asks.B.end], ['done', 'done'])
})

test('an ask left unruled twice is stopped, never ended as an answer, and the other asks go on', async (t) => {
  const w = world(t)
  const asks = [ask('A'), ask('B')]
  const turns = [moving(['A', 'B'], 1), moving(['A', 'B'], 2), moving(['A', 'B'], 3), settling('A', 'src/A.mjs:3')]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns), [RULER_AT(3)]: [{ output: { units: units(['A', 'converging']) } }, { output: { units: [] } }] })
  const result = await search(ctx, specOf(asks))
  assert.deepEqual(rolesIn(calls), ['scout', 'scout', 'scout', 'ruler', 'ruler', 'scout'])
  assert.equal(result.asks.B.end, 'stopped')
  assert.equal(result.asks.B.declared, 'open', 'the navigator\'s declaration stands; the stop is no answer')
  assert.equal(result.asks.A.end, 'done')
})

test('a ruling that fails is dispatched again once, and failing again stops every ask it was to rule', async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const turns = [looking('A', 1), looking('A', 2), looking('A', 3)]
  const failed = { status: 'failed', cause: 'host_error' }
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns), [RULER_AT(3)]: [failed, failed] })
  const result = await search(ctx, specOf(asks))
  assert.deepEqual(rolesIn(calls), ['scout', 'scout', 'scout', 'ruler', 'ruler'])
  assert.equal(calls[4].round, 2)
  assert.equal(result.asks.A.end, 'stopped')
  assert.equal(result.status, 'returned')
})

// --- missing turns ---------------------------------------------------------------------------

test('a navigator turn that ends without a return is dispatched again at once, as the next turn on the same ledger and session', async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const turns = [looking('A', 1), missing(), settling('A', 'src/A.mjs:1')]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns) })
  const result = await search(ctx, specOf(asks))
  assert.equal(calls.length, 3)
  const again = calls[2]
  assert.equal(again.round, 3)
  assert.equal(again.resume, true)
  assert.equal(again.thread.session, calls[0].thread.session)
  assert.equal(again.brief, turnBrief(ledgerOf({ asks, turns: turns.slice(0, 2) }), { turn: 3 }))
  assert.equal(result.asks.A.end, 'done')
})

test('a second missing turn in a row stops every open ask, resumable, and the search makes no further call', async (t) => {
  const w = world(t)
  const asks = [ask('A'), ask('B')]
  const turns = [
    turnOf([grep(['A'], ['src/a.mjs:3']), grep(['B'], ['src/b.mjs:1'])],
      back({ hits: [hit(['A'], 'src/a.mjs:3')], asks: [declared('A', 'answered'), declared('B', 'open')] })),
    missing(), missing(),
  ]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns) })
  const result = await search(ctx, specOf(asks))
  assert.equal(calls.length, 3)
  assert.deepEqual([result.asks.A.end, result.asks.B.end], ['done', 'stopped'])
  assert.equal(result.status, 'returned')
  assert.deepEqual(result.coverage, coverageLines(ledgerOf({ asks, turns }), NAME))
})

test('a search none of whose turns returned has failed with their cause, every ask stopped', async (t) => {
  const w = world(t)
  const asks = [ask('A'), ask('B')]
  const turns = [missing('host_error'), missing('host_error')]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns) })
  const result = await search(ctx, specOf(asks))
  assert.equal(calls.length, 2)
  assert.deepEqual([result.status, result.cause], ['failed', 'host_error'])
  assert.deepEqual([result.asks.A.end, result.asks.B.end], ['stopped', 'stopped'])
})

test('a brief over budget after every fold stops the open asks before any dispatch, by the navigator', async (t) => {
  const w = world(t)
  const asks = [ask('A'), ask('B')]
  const material = [{ label: 'An artefact too big to brief', text: 'x'.repeat(BRIEF_BUDGET_CHARS + 1) }]
  const { ctx, calls } = w.start({})
  const result = await search(ctx, specOf(asks, { material }))
  assert.equal(calls.length, 0, 'no session is started on a brief that cannot fit')
  for (const key of ['A', 'B']) assert.deepEqual([result.asks[key].end, result.asks[key].why], ['stopped', 'brief_over_budget'], key)
  assert.deepEqual([result.status, result.cause], ['failed', 'brief_over_budget'])
  assert.deepEqual(w.steps()[NAME + '/turn:1'], { calls_through: 0, stop: 'brief_over_budget' })
  const again = w.start({})
  assert.deepEqual(await search(again.ctx, specOf(asks, { material })), result, 'a relaunch replays the stop')
  assert.equal(again.calls.length, 0)
})

// --- relaunch --------------------------------------------------------------------------------

test('a relaunch replays every journaled turn, ruling and the ground, and makes no new call', async (t) => {
  const w = world(t)
  const asks = [ask('A'), ask('B')]
  const turns = [moving(['A', 'B'], 1), moving(['A', 'B'], 2), moving(['A', 'B'], 3), settling('A', 'src/A.mjs:3'), settling('B', 'src/B.mjs:3')]
  const first = w.start({ [NAV]: stepsOf(turns), [RULER_AT(3)]: [{ output: { units: units(['A', 'converging'], ['B', 'converging']) } }] })
  const ran = await search(first.ctx, specOf(asks))
  const again = w.start({})
  const replayed = await search(again.ctx, specOf(asks))
  assert.deepEqual(replayed, ran)
  assert.equal(again.calls.length, 0)
  assert.equal(w.grounds.length, 1)
})

test('a call-log line cut short by a killed server is a call that never answered: a relaunch skips it', async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const turns = [looking('A', 1), settling('A', 'src/A.mjs:1')]
  const ran = await search(w.start({ [NAV]: stepsOf(turns) }).ctx, specOf(asks))
  appendFileSync(w.path, '{"seq": 3, "tool": "gre')
  const again = w.start({})
  assert.deepEqual(await search(again.ctx, specOf(asks)), ran)
  assert.equal(again.calls.length, 0)
})

/** A turn cut by a host stop: the call it made before the stop, and the one it made after. */
const BEFORE = grep(['A'], ['src/A.mjs:20'], 'before the stop')
const AFTER = grep(['A'], ['src/A.mjs:21'], 'after the stop')
const CUT = turnOf([BEFORE, AFTER], back({ asks: [declared('A', 'open')] }))
const CUT_TURNS = [looking('A', 1), CUT, looking('A', 3), settling('A', 'src/A.mjs:21')]
const CUT_RULED = { [RULER_AT(3)]: [{ output: { units: units(['A', 'converging']) } }] }

/** The same search, never interrupted. */
async function uninterrupted(t) {
  const w = world(t)
  const run = w.start({ [NAV]: stepsOf(CUT_TURNS), ...CUT_RULED })
  const result = await search(run.ctx, specOf([ask('A')]))
  return { w, calls: run.calls, result }
}

test('a host stop in the middle of a turn resumes it with cut_off in the same session, and each call made before the stop counts once', async (t) => {
  const plain = await uninterrupted(t)
  const w = world(t)
  const [s1, , s3, s4] = stepsOf(CUT_TURNS)
  const run = w.start({ [NAV]: [s1, { status: 'stopped', cause: 'rate_limit', calls: [BEFORE] }, { output: CUT.output, calls: [AFTER] }, s3, s4], ...CUT_RULED })
  const result = await search(run.ctx, specOf([ask('A')]))
  const [, stopped, resumed] = run.calls
  assert.deepEqual([stopped.round, resumed.round], [2, 2])
  assert.equal(resumed.resume, true)
  assert.equal(resumed.brief, CUT_OFF)
  assert.equal(resumed.thread.session, stopped.thread.session)
  const seqs = w.journal().map((c) => c.seq)
  assert.equal(new Set(seqs).size, seqs.length, 'no call is in the call log twice')
  assert.deepEqual(w.journal(), plain.w.journal())
  assert.deepEqual(run.calls.slice(3).map((c) => c.brief), plain.calls.slice(2).map((c) => c.brief), 'every later brief is the uninterrupted run\'s')
  assert.deepEqual(result, plain.result)
})

test("a run killed in the middle of a turn resumes that turn with cut_off on relaunch, and its ledger is an uninterrupted run's", async (t) => {
  const plain = await uninterrupted(t)
  const w = world(t)
  const [s1, , s3, s4] = stepsOf(CUT_TURNS)
  const killed = w.start({ [NAV]: [s1, { status: 'stopped', cause: 'rate_limit', calls: [BEFORE] }] }, { sleep: () => { throw new Error('killed while waiting') } })
  await assert.rejects(search(killed.ctx, specOf([ask('A')])), /killed while waiting/)
  const again = w.start({ [NAV]: [{ output: CUT.output, calls: [AFTER] }, s3, s4], ...CUT_RULED })
  const result = await search(again.ctx, specOf([ask('A')]))
  const [resumed] = again.calls
  assert.equal(resumed.round, 2)
  assert.equal(resumed.resume, true)
  assert.equal(resumed.brief, CUT_OFF)
  assert.equal(resumed.thread.session, killed.calls[1].thread.session)
  assert.deepEqual(w.journal(), plain.w.journal())
  assert.deepEqual(again.calls.slice(1).map((c) => c.brief), plain.calls.slice(2).map((c) => c.brief))
  assert.deepEqual(result, plain.result)
})

// --- what only a ruling ends -----------------------------------------------------------------

test('a long chain whose observed state keeps moving is never ended by code: only the navigator and the ruler end it', async (t) => {
  const w = world(t)
  const asks = [ask('chain')]
  const length = 40
  const turns = [...Array.from({ length: length - 1 }, (_, i) => looking('chain', i + 1)), settling('chain', 'src/chain.mjs:' + (length - 1))]
  const checkIns = turns.map((_, i) => i + 1).filter((turn) => askAfter(turn) && turn < length)
  const script = { [NAV]: stepsOf(turns) }
  for (const turn of checkIns) script[RULER_AT(turn)] = [{ output: { units: units(['chain', 'converging']) } }]
  const { ctx, calls } = w.start(script)
  const result = await search(ctx, specOf(asks))
  assert.equal(calls.filter((c) => c.role.name === 'scout').length, length, 'every turn the navigator took was dispatched')
  assert.deepEqual(calls.filter((c) => c.role.name === 'ruler').map((c) => c.thread.key), checkIns.map((turn) => 'ruler:search:' + NAME + ':' + turn))
  assert.equal(result.asks.chain.end, 'done')
})

// --- more asks -------------------------------------------------------------------------------

test('called again with more asks, a search replays what it ran and goes on with the new asks, in the same session and charge', async (t) => {
  const w = world(t)
  const A = ask('A')
  const want = ask('want:1', { find: 'the worktree copy of src/a.mjs', from: 2 })
  const t1 = settling('A', 'src/A.mjs:3')
  const first = w.start({ [NAV]: stepsOf([t1]) })
  const before = await search(first.ctx, specOf([A]))
  const t2 = settling('want:1', 'src/a.mjs:12')
  const again = w.start({ [NAV]: stepsOf([t2]) })
  const after = await search(again.ctx, specOf([A, want]))
  assert.equal(again.calls.length, 1, 'the first turn is replayed')
  const [two] = again.calls
  assert.equal(two.round, 2)
  assert.equal(two.resume, true)
  assert.equal(two.thread.session, first.calls[0].thread.session)
  assert.equal(two.brief, turnBrief(ledgerOf({ asks: [A, want], turns: [t1] }), { turn: 2, joined: ['want:1'] }))
  const charge = chargeOf({ domain: 'repo', asks: [A], material: MATERIAL, ground: GROUND })
  assert.equal(readFileSync(two.role.systemPromptFile, 'utf8'), roleOf('scout').prompt + '\n\n' + charge,
    'the charge stays the first call\'s, so the session\'s cached prompt holds')
  assert.deepEqual(after.asks.A, before.asks.A)
  assert.equal(after.asks['want:1'].end, 'done')
  assert.equal(w.grounds.length, 1)
  const relaunched = w.start({})
  assert.deepEqual(await search(relaunched.ctx, specOf([A])), before)
  assert.deepEqual(await search(relaunched.ctx, specOf([A, want])), after)
  assert.equal(relaunched.calls.length, 0)
})

test("each turn's MCP config serves the search's tree, its asks, its domain's tools and its call log", async (t) => {
  const w = world(t)
  const A = ask('A')
  const want = ask('want:1', { find: 'the worktree copy of src/a.mjs', from: 2 })
  const served = (asks) => ({ tree: TREE, asks: asks.map(({ key, scope, domain }) => ({ key, scope, domain })), tools: TOOLS_BY_DOMAIN.repo, calls: w.path })
  const first = w.start({ [NAV]: stepsOf([settling('A', 'src/A.mjs:3')]) })
  await search(first.ctx, specOf([A]))
  assert.deepEqual(serverSpecOf(first.calls[0]), served([A]))
  const again = w.start({ [NAV]: stepsOf([settling('want:1', 'src/a.mjs:12')]) })
  await search(again.ctx, specOf([A, want]))
  assert.deepEqual(serverSpecOf(again.calls[0]), served([A, want]), 'the joined ask is served from its turn on')
  const h = world(t)
  const H = ask('H', { domain: 'history' })
  const history = h.start({ ['historian||' + NAME]: [{ output: back({ asks: [declared('H', 'absent')] }), calls: [] }] })
  await search(history.ctx, specOf([H], { role: 'historian', schema: 'search_history' }))
  assert.deepEqual(serverSpecOf(history.calls[0]), {
    tree: TREE, asks: [{ key: 'H', scope: ['.'], domain: 'history' }], tools: TOOLS_BY_DOMAIN.history, calls: h.path,
  })
})

test('two searches of one name under different scopes keep separate threads, call logs, servers and steps', async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const keys = ['probe:p:1/' + NAME, 'probe:p:2/' + NAME]
  const script = Object.fromEntries(keys.map((key, i) => ['scout||' + key, stepsOf([settling('A', 'src/A.mjs:' + (i + 1))])]))
  const { ctx, calls } = w.start(script)
  await search(scoped(ctx, 'probe:p:1'), specOf(asks))
  await search(scoped(ctx, 'probe:p:2'), specOf(asks))
  assert.deepEqual(calls.map((c) => c.thread.key), keys)
  const logs = keys.map((key) => join(searchDir(w.dir, key), 'calls.jsonl'))
  assert.notEqual(logs[0], logs[1])
  assert.deepEqual(calls.map((c) => serverSpecOf(c).calls), logs)
  logs.forEach((log, i) => {
    const records = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.deepEqual(records.map((r) => [r.seq, r.observed[0].line]), [[1, i + 1]], keys[i])
  })
  const steps = w.steps()
  for (const key of keys) assert.deepEqual(steps[key + '/turn:1'], { calls_through: 1 }, key)
})

// --- what a search hands back ----------------------------------------------------------------

test('a search returns its ends, hits, sessions, counts and coverage in the shape its programs read', async (t) => {
  const w = world(t)
  const asks = [ask('guidance'), ask('ground:intro'), ask('ground:api')]
  const turns = [turnOf(
    [grep(['guidance'], ['CLAUDE.md:1', 'docs/kb/a.md:4']), grep(['ground:intro'], ['src/a.mjs:3', 'src/b.mjs:5']), grep(['ground:api'], ['src/b.mjs:9'])],
    back({
      hits: [hit(['guidance'], 'CLAUDE.md:1'), hit(['guidance'], 'docs/kb/a.md:4'), hit(['ground:intro'], 'src/a.mjs:3'),
        hit(['ground:intro'], 'src/b.mjs:5'), hit(['ground:api'], 'src/b.mjs:9')],
      asks: asks.map((a) => declared(a.key, 'answered')),
    }))]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns) })
  const result = await search(ctx, specOf(asks))
  const end = ledgerOf({ asks, turns })
  assert.deepEqual([result.name, result.status, result.cause], [NAME, 'returned', ''])
  assert.deepEqual(result.tree, TREE)
  assert.deepEqual(result.ground, GROUND)
  for (const a of asks) {
    const got = result.asks[a.key]
    const want = end.asks[a.key]
    assert.deepEqual([got.end, got.label, got.why], [want.end.state, want.end.label, want.end.why], a.key)
    assert.deepEqual([got.declared, got.absence], [want.declared, want.absence], a.key)
    assert.deepEqual(got.hits, want.hits, a.key)
    assert.deepEqual(got.dismissed, want.dismissed, a.key)
    assert.deepEqual(got.unreached, want.frontier, a.key)
  }
  assert.deepEqual(result.sessions, [{ session: calls[0].thread.session, thread: NAME }])
  const keysIn = (pick) => new Set(Object.values(end.asks).filter(pick).flatMap((a) => a.hits.map((h) => h.key))).size
  assert.equal(result.entries_n, keysIn(() => true))
  assert.deepEqual(result.kinds, { guidance: keysIn((a) => a.key === 'guidance'), ground: keysIn((a) => a.key.startsWith('ground:')) })
  assert.deepEqual(result.coverage, coverageLines(end, NAME))
})

test('the ground table is built once per search, over its tree, material, diff, config and the union of its scopes', async (t) => {
  const ground = { rows: [{ kind: 'path', mention: 'src/A.mjs', key: 'src/A.mjs', exists: true, asks: ['A'], defs: [], refs: [], files: 0 }], seeds: [] }
  const w = world(t, { ground })
  const config = { guidance: ['docs/review.md'] }
  const asks = [ask('A', { scope: ['src', 'lib'] }), ask('B', { scope: ['src'] })]
  const diff = { base: 'b'.repeat(40), head: 'c'.repeat(40) }
  const turns = [turnOf([grep(['A'], ['src/A.mjs:1'], 'a'), grep(['B'], ['src/B.mjs:1'], 'b')], back({
    hits: [hit(['A'], 'src/A.mjs:1'), hit(['B'], 'src/B.mjs:1')],
    asks: [declared('A', 'answered'), declared('B', 'answered')],
  }))]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns) })
  const result = await search(ctx, specOf(asks, { diff, config }))
  assert.equal(w.grounds.length, 1)
  const [{ tree, args }] = w.grounds
  assert.deepEqual(tree, TREE)
  assert.deepEqual([args.material, args.scope, args.diff, args.config], [MATERIAL, ['lib', 'src'], diff, config])
  assert.deepEqual(result.ground, ground)
  const charge = chargeOf({ domain: 'repo', asks, material: MATERIAL, ground })
  assert.equal(readFileSync(calls[0].role.systemPromptFile, 'utf8'), roleOf('scout').prompt + '\n\n' + charge)
  assert.equal(calls[0].brief, turnBrief(ledgerOf({ asks, turns: [], ground }), { turn: 1 }))
  await search(w.start({}).ctx, specOf(asks, { diff, config }))
  assert.equal(w.grounds.length, 1, 'a relaunch reads the ground from the journal')
  assert.equal(await groundFor(w.start({}).ctx, TREE, { material: MATERIAL }), ground)
  assert.equal(w.grounds.length, 2, 'groundFor is the seam the loop resolves through')
})

test('a ground table the program hands over is recorded and used as given, and the search resolves nothing', async (t) => {
  const w = world(t)
  const given = { rows: [{ kind: 'doc', mention: 'docs/kb/a.md', key: 'docs/kb/a.md', exists: true, asks: ['A'], defs: [], refs: [], files: 0 }], seeds: [] }
  const asks = [ask('A')]
  const turns = [turnOf([grep(['A'], ['docs/kb/a.md:2'])], back({ hits: [hit(['A'], 'docs/kb/a.md:2')], asks: [declared('A', 'answered')] }))]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns) })
  const result = await search(ctx, specOf(asks, { ground: given }))
  assert.equal(w.grounds.length, 0)
  assert.deepEqual(w.steps()[NAME + '/ground'], given, 'the ground step records the table it was handed')
  assert.deepEqual(result.ground, given)
  const charge = chargeOf({ domain: 'repo', asks, material: MATERIAL, ground: given })
  assert.equal(readFileSync(calls[0].role.systemPromptFile, 'utf8'), roleOf('scout').prompt + '\n\n' + charge)
  assert.equal(calls[0].brief, turnBrief(ledgerOf({ asks, turns: [], ground: given }), { turn: 1 }))
  assert.equal(result.asks.A.end, 'done')
})

test("the journal holds the ground, the asks' joining, each turn's last call and missing cause, and each check-in's rulings", async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const turns = [looking('A', 1), missing(), looking('A', 3), settling('A', 'src/A.mjs:3')]
  const ruled = units(['A', 'converging'])
  const { ctx } = w.start({ [NAV]: stepsOf(turns), [RULER_AT(3)]: [{ output: { units: ruled } }] })
  await search(ctx, specOf(asks))
  const steps = w.steps()
  assert.deepEqual(steps[NAME + '/ground'], GROUND)
  assert.deepEqual(steps[NAME + '/asks:0'], ['A'])
  assert.deepEqual(steps[NAME + '/turn:1'], { calls_through: 1 })
  assert.deepEqual(steps[NAME + '/turn:2'], { calls_through: 1, missing: 'host_error' })
  assert.deepEqual(steps[NAME + '/turn:3'], { calls_through: 2 })
  assert.deepEqual(steps[NAME + '/ruling:3'], [{ turn: 3, asks: ['A'], units: ruled }])
  assert.deepEqual(steps[NAME + '/turn:4'], { calls_through: 3 })
})
