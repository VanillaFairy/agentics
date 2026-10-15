// test/fast/search-loop.test.mjs — pins one search as code runs it: the ground built once, one
// navigator session resumed turn by turn with the charge as its system prompt, asks ended only by a
// ruling or by a stall after a ruling, one ruler dispatch per turn on the pinned tree with its brief
// kept on disk, missing outcomes paused and never answered, and a relaunch replaying what the
// journal holds. The scripted runner stands in for the host, and its `calls` seam for the tool server.
//
// Design: docs/DESIGN.md#searches and docs/DESIGN.md#l2--states-end-work-counts-dont.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chargeOf } from '../../lib/briefs/search.mjs'
import { renderMessage } from '../../lib/conversation.mjs'
import { fnv1a } from '../../lib/plan-digest.mjs'
import { programContext, scoped } from '../../lib/programs/common.mjs'
import { askAfter } from '../../lib/programs/converge.mjs'
import { groundFor, search } from '../../lib/programs/search/loop.mjs'
import { loadRole, tierFor } from '../../lib/roles.mjs'
import { schemaOf } from '../../lib/schemas.mjs'
import { coverageLines, foldLedger, standingRefusals } from '../../lib/search/ledger.mjs'
import { TOOLS_BY_DOMAIN, searchDir } from '../../lib/search/server.mjs'
import { memoryLog } from './harness/memory-log.mjs'
import { scriptedRunner } from './harness/scripted-runner.mjs'

const RUN = '20260101-000000-test'
const NOW = () => '2026-01-01T00:00:00.000Z'
const SHA = 'a'.repeat(40)
const NAME = 'locate'
const NAV = 'scout||' + NAME
const RULER_THREAD = (turn) => 'ruler:search:' + NAME + ':' + turn
const RULER_AT = (turn) => 'ruler||' + RULER_THREAD(turn)
const MATERIAL = [{ label: 'The artefact', text: '# The artefact\n\nIt names `src/a.ts` and `parseWidget`.' }]
const CUT_OFF = renderMessage({ msg: 'cut_off' })
const SEPARATOR = '\n\n---\n\n'
/** The text of line 4 of src/a.ts on the pinned tree: the line a ruler brief must quote. */
const SETTLED_LINE = 'export const answer = 42 // the settled line'
const FILES = {
  'src/a.ts': ['// a', 'import x from "x"', '', SETTLED_LINE, 'export default answer', '', '', '', '', ''],
  'src/b.ts': ['// b', 'export const other = 7 // the other settled line', '', '', '', '', '', '', '', ''],
}

/** A ground row each ask owns, so no ask owes its scope file by file unless a test says so. */
const rowOf = (key) => ({ kind: 'path', mention: 'src/' + key + '.ts', key: 'src/' + key + '.ts', exists: true, asks: [key], defs: [], refs: [], files: 0 })
const groundOf = (keys) => ({ rows: keys.map(rowOf), seeds: [] })
const GROUND = groundOf(['A', 'B', 'chain'])

const ask = (key, over = {}) => ({ key, find: 'where ' + key + ' is settled', scope: ['.'], domain: 'repo', ...over })

/**
 * One run's world: a scratch home holding the pinned tree, one log that every start reads back (a
 * relaunch is a start over the same log), the resolver calls the seam received, and the search's
 * call log as it stands. `home` and `log` let a second world stand on the first one's disk with
 * another log (a crash).
 */
function world(t, { ground = GROUND, home = null, log = memoryLog() } = {}) {
  if (!home) {
    home = mkdtempSync(join(tmpdir(), 'agentics-search-loop-'))
    t.after(() => rmSync(home, { recursive: true, force: true }))
    for (const [key, lines] of Object.entries(FILES)) {
      mkdirSync(join(home, 'tree', 'src'), { recursive: true })
      writeFileSync(join(home, 'tree', key), lines.join('\n') + '\n')
    }
  }
  const tree = { root: join(home, 'tree'), sha: SHA }
  const dir = join(home, 'run')
  const grounds = []
  const start = (script, { sleep = () => Promise.resolve() } = {}) => {
    const runner = scriptedRunner(script, { log, now: NOW })
    const ctx = {
      ...programContext({ repo: home, root: home, run: RUN, log, runAgent: runner.runAgent, now: NOW, sleep, dir }),
      groundOf: async (tr, args) => { grounds.push({ tree: tr, args }); return ground },
    }
    return { ctx, calls: runner.calls }
  }
  const path = join(searchDir(dir, NAME), 'calls.jsonl')
  const journal = () => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
  const steps = () => Object.fromEntries(log.entries().filter((e) => e.kind === 'step').map((e) => [e.key, e.value]))
  const spec = (asks, over = {}) => ({ name: NAME, role: 'scout', schema: 'search_repo', tree, asks, material: MATERIAL, intelligence: 'normal', ...over })
  return { log, grounds, start, journal, steps, path, dir, home, tree, spec }
}

/** A grep code ran for `asks`, showing each `path:line` of `lines`. Its pattern tells calls apart. */
const grep = (asks, lines, pattern = 'seen ' + lines.join(' '), paths = []) => ({
  tool: 'grep', args: { pattern, fixed: false, ignore_case: false, paths, page: 1 }, asks, ok: true,
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
/** A turn that greps one new line for each of `keys` and leaves them all open. */
const moving = (keys, n) => turnOf(keys.map((k) => grep([k], ['src/' + k + '.mjs:' + n])), back({ asks: keys.map((k) => declared(k, 'open')) }))
/** A turn that settles `key` on a line its own grep shows, and declares it answered. */
const settling = (key, at) => turnOf([grep([key], [at], 'settle ' + at)], back({ hits: [hit([key], at)], asks: [declared(key, 'answered')] }))
/** A turn that runs no call and returns nothing new: the turn a stall is found on. */
const idle = () => turnOf([], back())

/** The scripted starts of `turns`, in order. */
const stepsOf = (turns) => turns.map((t) => (t.missing ? { status: 'failed', cause: t.missing, calls: t.calls } : { output: t.output, calls: t.calls }))
const units = (...rulings) => rulings.map(([unit, ruling]) => ({ unit, ruling, why: unit + ' is ' + ruling + ' on what the turns before showed' }))
const ruler = (...rulings) => ({ output: { units: units(...rulings) } })

/**
 * The script of a search that closes: the navigator's `work` turns, an idle turn (the stall), and a
 * ruler on the stall's turn ruling `rulings`. `turns` are the navigator turns, `turn` the stall's.
 */
function closing(work, ...rulings) {
  const turns = [...work, idle()]
  const turn = turns.length
  return { turns, turn, script: { [NAV]: stepsOf(turns), [RULER_AT(turn)]: [ruler(...rulings)] } }
}

/**
 * Pure. The ledger the records of `turns` and `rulings` fold to: each call numbered as the server
 * numbers it, each turn through its last call, each ask open from its first turn.
 */
function ledgerOf({ asks, turns, rulings = [], ground = GROUND }) {
  let seq = 0
  const calls = []
  const folded = turns.map((t, i) => {
    for (const c of t.calls) calls.push({ ...c, seq: ++seq })
    return t.missing ? { turn: i + 1, missing: t.missing, calls_through: seq } : { turn: i + 1, output: t.output, calls_through: seq }
  })
  return foldLedger({ asks: asks.map((a) => ({ ...a, from: a.from || 1 })), ground, calls, turns: folded, rulings })
}

const roleOf = (name) => loadRole(name).role
const serverSpecOf = (call) => JSON.parse(readFileSync(JSON.parse(readFileSync(call.mcpConfig, 'utf8')).mcpServers.search.args[2], 'utf8'))
const rolesIn = (calls) => calls.map((c) => c.role.name)
const rulersIn = (calls) => calls.filter((c) => c.role.name === 'ruler')
const rulingSteps = (w) => Object.keys(w.steps()).filter((k) => k.startsWith(NAME + '/ruling:'))
const rulingsIn = (w) => rulingSteps(w).flatMap((k) => w.steps()[k])
const briefFile = (w, turn, round = 1) => join(searchDir(w.dir, NAME), 'rulings', turn + '-' + round + '.md')

// --- turns -----------------------------------------------------------------------------------

test('the first turn is a fresh session whose system prompt is the role and the charge', async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const { script } = closing([settling('A', 'src/a.ts:4')], ['A', 'answered'])
  const { ctx, calls } = w.start(script)
  await search(ctx, w.spec(asks, { base: 'high' }))
  const [first] = calls
  assert.equal(first.resume, false)
  assert.equal(first.round, 1)
  assert.equal(first.thread.key, NAME)
  assert.equal(first.role.name, 'scout')
  assert.equal(first.cwd, w.tree.root)
  assert.deepEqual(first.schema, schemaOf('search_repo'))
  assert.deepEqual(first.tier, tierFor(roleOf('scout'), { intelligence: 'normal', base: 'high' }))
  const charge = chargeOf({ domain: 'repo', asks, material: MATERIAL, ground: GROUND })
  assert.equal(readFileSync(first.role.systemPromptFile, 'utf8'), roleOf('scout').prompt + '\n\n' + charge)
  assert.equal(typeof first.brief, 'string')
  assert.ok(first.brief.length > 0)
})

test('every later turn resumes the same session: no renewal, no message', async (t) => {
  const w = world(t)
  const { script } = closing([looking('A', 1), looking('A', 2)], ['A', 'absent'])
  const { ctx, calls } = w.start(script)
  await search(ctx, w.spec([ask('A')]))
  const nav = calls.filter((c) => c.role.name === 'scout')
  assert.equal(nav.length, 3)
  nav.slice(1).forEach((call, i) => {
    assert.equal(call.round, i + 2)
    assert.equal(call.resume, true, 'turn ' + (i + 2))
    assert.equal(call.thread.session, nav[0].thread.session, 'turn ' + (i + 2))
  })
  assert.deepEqual(w.log.entries().filter((e) => e.kind === 'thread_renewed'), [])
  assert.deepEqual(w.log.entries().filter((e) => e.kind === 'message'), [])
})

// --- endings through the loop ----------------------------------------------------------------

test('a stall is ruled and the ruling ends it', async (t) => {
  const w = world(t)
  const { script } = closing([settling('A', 'src/a.ts:4')], ['A', 'answered'])
  const { ctx, calls } = w.start(script)
  const result = await search(ctx, w.spec([ask('A')]))
  assert.deepEqual(rolesIn(calls), ['scout', 'scout', 'ruler'], 'the declaration on turn 1 ends nothing; the stall on turn 2 goes to the ruler; no turn 3')
  const [, , r] = calls
  assert.equal(r.thread.key, RULER_THREAD(2))
  assert.deepEqual(r.schema, schemaOf('ruler_search'))
  assert.deepEqual(rulingsIn(w).flatMap((x) => x.asks), ['A'])
  assert.deepEqual([result.asks.A.end, result.asks.A.answer, result.asks.A.label], ['done', 'answered', 'ruled'])
  assert.equal(result.asks.A.why, units(['A', 'answered'])[0].why)
  assert.equal(result.status, 'returned')
})

test('a declaration alone never ends an ask: without a stall there is no ruler and no end', async (t) => {
  const w = world(t)
  const turns = [settling('A', 'src/a.ts:4'), missing(), missing()]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns) })
  const result = await search(ctx, w.spec([ask('A')]))
  assert.deepEqual(rolesIn(calls), ['scout', 'scout', 'scout'])
  assert.equal(result.asks.A.end, 'stopped', 'the declared answer is not taken; two missing turns stop it')
  assert.equal(result.asks.A.declared, 'answered')
})

/** Turn 1 works and declares, turn 2 idles (stall, ruled open), turn 3 idles again. */
const OPEN_WHY = 'the caller in src/b.ts is not read yet'
const reopened = () => ({
  [NAV]: stepsOf([settling('A', 'src/a.ts:4'), idle(), idle()]),
  [RULER_AT(2)]: [{ output: { units: [{ unit: 'A', ruling: 'open', why: OPEN_WHY }] } }],
})

test('an open ruling reaches the navigator', async (t) => {
  const w = world(t)
  const { ctx, calls } = w.start(reopened())
  await search(ctx, w.spec([ask('A')]))
  assert.deepEqual(rolesIn(calls).slice(0, 4), ['scout', 'scout', 'ruler', 'scout'])
  const three = calls[3]
  assert.equal(three.round, 3)
  assert.ok(three.brief.toLowerCase().includes(('ruled open after turn 2: ' + OPEN_WHY).toLowerCase()), three.brief)
})

test('a stall after an open ruling ends without a ruler', async (t) => {
  const w = world(t)
  const { ctx, calls } = w.start(reopened())
  const result = await search(ctx, w.spec([ask('A')]))
  assert.deepEqual(rolesIn(calls), ['scout', 'scout', 'ruler', 'scout'], 'no second ruler dispatch and no turn 4')
  assert.deepEqual([result.asks.A.end, result.asks.A.label], ['no_progress', 'observed'])
  assert.ok(result.asks.A.why.includes(OPEN_WHY), 'the why names the standing open ruling: ' + result.asks.A.why)
  assert.ok(!result.asks.A.answer, 'an observed end carries no answer')
})

/** A and B both look on turn 1, only B on turn 2, neither on turn 3: the stall at turn 3 (a check-in) owes both a ruling. */
const TWO = () => [moving(['A', 'B'], 1), turnOf([grep(['B'], ['src/B.mjs:2'])], back({ asks: [declared('A', 'open'), declared('B', 'open')] })), idle()]

test('one ruling step per turn', async (t) => {
  assert.ok(askAfter(3), 'turn 3 is a check-in')
  const w = world(t)
  const { ctx, calls } = w.start({ [NAV]: stepsOf(TWO()), [RULER_AT(3)]: [ruler(['A', 'absent'], ['B', 'not_converging'])] })
  const result = await search(ctx, w.spec([ask('A'), ask('B')]))
  assert.deepEqual(rolesIn(calls), ['scout', 'scout', 'scout', 'ruler'], 'one ruler dispatch rules both')
  assert.deepEqual(rulingSteps(w), [NAME + '/ruling:3'])
  const records = w.steps()[NAME + '/ruling:3']
  assert.equal(records.length, 1)
  assert.deepEqual([...records[0].asks].sort(), ['A', 'B'])
  assert.deepEqual(records[0].units.map((u) => u.unit).sort(), ['A', 'B'])
  assert.ok(calls[3].brief.includes('## A') && calls[3].brief.includes('## B'), 'one brief rules both asks')
  assert.deepEqual([result.asks.A.end, result.asks.A.answer], ['done', 'absent'])
  assert.deepEqual([result.asks.B.end, result.asks.B.label], ['not_converging', 'ruled'])
})

test('the ruler reads the pinned tree', async (t) => {
  const w = world(t)
  const { script } = closing([settling('A', 'src/a.ts:4')], ['A', 'answered'])
  const { ctx, calls } = w.start(script)
  await search(ctx, w.spec([ask('A')]))
  const [r] = rulersIn(calls)
  assert.equal(r.cwd, w.tree.root)
  const entry = w.log.entries().find((e) => e.kind === 'dispatched' && e.thread === RULER_THREAD(2))
  assert.ok(entry, 'the ruler was dispatched')
  assert.equal(entry.cwd, w.tree.root)
})

test('the ruler brief holds the hit lines', async (t) => {
  const w = world(t)
  const { script } = closing([settling('A', 'src/a.ts:4')], ['A', 'answered'])
  const { ctx, calls } = w.start(script)
  await search(ctx, w.spec([ask('A')]))
  assert.ok(existsSync(briefFile(w, 2)), 'the brief file is kept')
  const text = readFileSync(briefFile(w, 2), 'utf8')
  assert.ok(text.includes(SETTLED_LINE), 'the line read from the tree: ' + text)
  assert.ok(rulersIn(calls)[0].brief.includes(SETTLED_LINE))
})

test('the ruler brief is kept', async (t) => {
  const w = world(t)
  const { script } = closing([settling('A', 'src/a.ts:4')], ['A', 'answered'])
  const { ctx } = w.start(script)
  await search(ctx, w.spec([ask('A')]))
  const path = briefFile(w, 2, 1)
  assert.ok(existsSync(path), path)
  const text = readFileSync(path, 'utf8')
  assert.ok(text.includes('A'))
  const entries = w.log.entries().filter((e) => e.kind === 'dispatched' && e.thread === RULER_THREAD(2))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].brief_digest, fnv1a(text))
})

test('a second ruler round keeps its own brief file', async (t) => {
  const w = world(t)
  const { ctx, calls } = w.start({
    [NAV]: stepsOf(TWO()),
    [RULER_AT(3)]: [ruler(['A', 'absent']), ruler(['B', 'absent'])],
  })
  await search(ctx, w.spec([ask('A'), ask('B')]))
  assert.equal(rulersIn(calls).length, 2)
  const [one, two] = [readFileSync(briefFile(w, 3, 1), 'utf8'), readFileSync(briefFile(w, 3, 2), 'utf8')]
  const digests = w.log.entries().filter((e) => e.kind === 'dispatched' && e.thread === RULER_THREAD(3)).map((e) => e.brief_digest)
  assert.deepEqual(digests, [fnv1a(one), fnv1a(two)])
  assert.ok(two.includes('## B') && !two.includes('## A'), 'round 2 rules only what round 1 left')
})

// --- the result (N8) -------------------------------------------------------------------------

const PER_ASK = ['answer', 'declared', 'dismissed', 'end', 'hits', 'label', 'lines', 'looked', 'unreached', 'why']

test('the result per ask', async (t) => {
  const w = world(t)
  const turns = TWO()
  const { ctx } = w.start({ [NAV]: stepsOf(turns), [RULER_AT(3)]: [ruler(['A', 'absent'], ['B', 'not_converging'])] })
  const asks = [ask('A'), ask('B')]
  const result = await search(ctx, w.spec(asks))
  const end = ledgerOf({ asks, turns, rulings: rulingsIn(w) })
  for (const key of ['A', 'B']) {
    const got = result.asks[key]
    assert.deepEqual(Object.keys(got).sort(), PER_ASK, key)
    assert.ok(!('absence' in got), key)
    assert.deepEqual(Object.keys(got.lines).sort(), ['declared', 'failed', 'incomplete', 'unreached'], key)
    assert.deepEqual(got.looked, end.asks[key].looked, key)
    assert.deepEqual(got.hits, end.asks[key].hits, key)
    assert.deepEqual(got.declared, end.asks[key].declared, key)
    for (const list of Object.values(got.lines)) for (const line of list) assert.ok(line.startsWith(NAME + ':' + key), key + ' owns ' + line)
  }
  assert.deepEqual([result.asks.A.end, result.asks.A.answer, result.asks.A.label], ['done', 'absent', 'ruled'])
  assert.ok(result.asks.A.lines.declared.some((l) => l.startsWith(NAME + ':A: ruled absent: ')), JSON.stringify(result.asks.A.lines))
  assert.deepEqual(result.asks.A.lines.incomplete, [])
  assert.deepEqual(result.asks.B.lines.declared, [])
  assert.ok(result.asks.B.lines.incomplete.some((l) => l.startsWith(NAME + ':B: not_converging, ')), JSON.stringify(result.asks.B.lines))
  assert.ok(!result.asks.B.answer, 'not_converging carries no answer')
  assert.ok(!('absence' in result))
  assert.ok(Array.isArray(result.queries))
})

test('the result folds owed files', async (t) => {
  const w = world(t, { ground: { rows: [], seeds: [] } })
  const owed = ['src/x/a.ts', 'src/x/b.ts', 'src/y/c.ts', 'src/z/d.ts']
  // the scope's listing journaled as the loop journals it, so this fast test lists no tree
  w.log.append('step', { key: NAME + '/owes:O', value: owed })
  const work = turnOf([grep(['O'], [], 'nothing like it', ['src/y'])], back({ asks: [declared('O', 'absent')] }))
  const { script } = closing([work], ['O', 'absent'])
  const { ctx } = w.start(script)
  const result = await search(ctx, w.spec([ask('O')]))
  const got = result.asks.O
  assert.equal(got.end, 'done')
  assert.ok(!got.unreached.some((u) => u.kind === 'file'), 'no file item is reported file by file')
  const files = got.unreached.filter((u) => u.kind === 'files').map((u) => [u.key, u.detail]).sort()
  assert.deepEqual(files, [['src/x/', '2 not covered'], ['src/z/', '1 not covered']])
  assert.ok(!got.unreached.some((u) => u.key === 'src/y/' || u.key === 'src/y/c.ts'), 'the grep over src/y covered it')
  assert.ok(got.lines.unreached.includes(NAME + ':O: files src/x/ (2 not covered)'), JSON.stringify(got.lines.unreached))
})

test("coverage is the asks' lines", async (t) => {
  const w = world(t)
  const turns = [...TWO(), idle()]
  // round 1 rules A only, round 2 rules nothing: B is stopped by the ruler, a search-wide failed line
  const { ctx } = w.start({ [NAV]: stepsOf(turns), [RULER_AT(3)]: [ruler(['A', 'answered']), ruler()] })
  const asks = [ask('A'), ask('B')]
  const result = await search(ctx, w.spec(asks))
  assert.equal(result.asks.B.end, 'stopped')
  const flat = (field) => Object.values(result.asks).flatMap((a) => a.lines[field]).sort()
  assert.deepEqual([...result.coverage.declared].sort(), flat('declared'))
  assert.deepEqual([...result.coverage.incomplete].sort(), flat('incomplete'))
  assert.deepEqual([...result.coverage.unreached].sort(), flat('unreached'))
  assert.deepEqual([...result.coverage.failed_channels].sort(), [...flat('failed'), 'converge:' + NAME].sort())
  assert.ok(flat('declared').length > 0 && flat('incomplete').length > 0)
  const navTurns = turns.slice(0, w.log.entries().filter((e) => e.kind === 'step' && e.key.startsWith(NAME + '/turn:')).length)
  assert.deepEqual(result.coverage, coverageLines(ledgerOf({ asks, turns: navTurns, rulings: rulingsIn(w) }), NAME))
})

// --- missing turns ---------------------------------------------------------------------------

test('a navigator turn that ends without a return is dispatched again at once, on the same session', async (t) => {
  const w = world(t)
  const turns = [settling('A', 'src/a.ts:4'), missing(), idle()]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns), [RULER_AT(3)]: [ruler(['A', 'answered'])] })
  const result = await search(ctx, w.spec([ask('A')]))
  assert.deepEqual(rolesIn(calls), ['scout', 'scout', 'scout', 'ruler'], 'a turn without a return is no comparison point: the stall is turn 3 against turn 1')
  const again = calls[2]
  assert.equal(again.round, 3)
  assert.equal(again.resume, true)
  assert.equal(again.thread.session, calls[0].thread.session)
  assert.equal(result.asks.A.end, 'done')
})

test('a second missing turn in a row stops every open ask, and the search makes no further call', async (t) => {
  const w = world(t)
  const turns = [moving(['A', 'B'], 1), missing(), missing()]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns) })
  const result = await search(ctx, w.spec([ask('A'), ask('B')]))
  assert.equal(calls.length, 3)
  assert.deepEqual([result.asks.A.end, result.asks.B.end], ['stopped', 'stopped'])
  assert.equal(result.status, 'returned')
})

test('a search none of whose turns returned has failed with their cause, every ask stopped', async (t) => {
  const w = world(t)
  const { ctx, calls } = w.start({ [NAV]: stepsOf([missing('host_error'), missing('host_error')]) })
  const result = await search(ctx, w.spec([ask('A'), ask('B')]))
  assert.equal(calls.length, 2)
  assert.deepEqual([result.status, result.cause], ['failed', 'host_error'])
  assert.deepEqual([result.asks.A.end, result.asks.B.end], ['stopped', 'stopped'])
})

// --- replay ----------------------------------------------------------------------------------

test('a relaunch replays', async (t) => {
  const w = world(t)
  const { script } = closing([moving(['A', 'B'], 1), settling('A', 'src/a.ts:4')], ['A', 'answered'], ['B', 'absent'])
  const asks = [ask('A'), ask('B')]
  const ran = await search(w.start(script).ctx, w.spec(asks))
  const dispatched = w.log.entries().filter((e) => e.kind === 'dispatched').length
  const again = w.start({})
  const replayed = await search(again.ctx, w.spec(asks))
  assert.deepEqual(replayed, ran)
  assert.equal(again.calls.length, 0)
  assert.equal(w.log.entries().filter((e) => e.kind === 'dispatched').length, dispatched, 'no dispatch on a relaunch')
  assert.equal(w.grounds.length, 1)
})

test('a crash before the ruling rules once', async (t) => {
  const w = world(t)
  const { script } = closing([settling('A', 'src/a.ts:4')], ['A', 'answered'])
  await search(w.start(script).ctx, w.spec([ask('A')]))
  // the log as a crash right after the turn-2 step left it: nothing of the ruling
  const entries = w.log.entries()
  const cut = entries.findIndex((e) => e.kind === 'step' && e.key === NAME + '/turn:2')
  assert.ok(cut > 0)
  const log = memoryLog()
  for (const { kind, seq, ...fields } of entries.slice(0, cut + 1)) log.append(kind, fields)
  const c = world(t, { home: w.home, log })
  const again = c.start({ [RULER_AT(2)]: [ruler(['A', 'answered'])] })
  const result = await search(again.ctx, c.spec([ask('A')]))
  assert.deepEqual(rolesIn(again.calls), ['ruler'], 'the turns replay; the ruler rules turn 2 once')
  assert.equal(log.entries().filter((e) => e.kind === 'step' && e.key === NAME + '/ruling:2').length, 1)
  assert.deepEqual([result.asks.A.end, result.asks.A.label], ['done', 'ruled'])
  const relaunched = c.start({})
  assert.deepEqual(await search(relaunched.ctx, c.spec([ask('A')])), result)
  assert.equal(relaunched.calls.length, 0, 'a relaunch after the ruling rules nothing again')
})

test('a call-log line cut short by a killed server is a call that never answered: a relaunch skips it', async (t) => {
  const w = world(t)
  const { script } = closing([looking('A', 1), settling('A', 'src/a.ts:4')], ['A', 'answered'])
  const ran = await search(w.start(script).ctx, w.spec([ask('A')]))
  appendFileSync(w.path, '{"seq": 3, "tool": "gre')
  const again = w.start({})
  assert.deepEqual(await search(again.ctx, w.spec([ask('A')])), ran)
  assert.equal(again.calls.length, 0)
})

/** A turn cut by a host stop: the call it made before the stop, and the one it made after. */
const BEFORE = grep(['A'], ['src/A.mjs:20'], 'before the stop')
const AFTER = grep(['A'], ['src/a.ts:4'], 'after the stop')
const CUT = turnOf([BEFORE, AFTER], back({ hits: [hit(['A'], 'src/a.ts:4')], asks: [declared('A', 'answered')] }))
/** Turn 1 looks, turn 2 is cut and settles, turn 3 idles: the stall at turn 3 is ruled. */
const CUT_TURNS = [looking('A', 1), CUT, idle()]
const CUT_RULED = { [RULER_AT(3)]: [ruler(['A', 'answered'])] }

async function uninterrupted(t) {
  const w = world(t)
  const run = w.start({ [NAV]: stepsOf(CUT_TURNS), ...CUT_RULED })
  const result = await search(run.ctx, w.spec([ask('A')]))
  return { w, calls: run.calls, result }
}

const withoutTree = (result) => ({ ...result, tree: null })

test('a host stop in the middle of a turn resumes it with cut_off and its brief in the same session, each call counted once', async (t) => {
  const plain = await uninterrupted(t)
  const w = world(t)
  const [s1, , s3] = stepsOf(CUT_TURNS)
  const run = w.start({ [NAV]: [s1, { status: 'stopped', cause: 'rate_limit', calls: [BEFORE] }, { output: CUT.output, calls: [AFTER] }, s3], ...CUT_RULED })
  const result = await search(run.ctx, w.spec([ask('A')]))
  const [, stopped, resumed] = run.calls
  assert.deepEqual([stopped.round, resumed.round], [2, 2])
  assert.equal(resumed.resume, true)
  assert.equal(resumed.brief, CUT_OFF + SEPARATOR + plain.calls[1].brief, 'cut_off followed by the turn brief, never cut_off alone')
  assert.equal(resumed.thread.session, stopped.thread.session)
  const seqs = w.journal().map((c) => c.seq)
  assert.equal(new Set(seqs).size, seqs.length, 'no call is in the call log twice')
  assert.deepEqual(w.journal(), plain.w.journal())
  assert.deepEqual(withoutTree(result), withoutTree(plain.result))
})

test("a run killed in the middle of a turn resumes that turn with cut_off and its brief on relaunch", async (t) => {
  const plain = await uninterrupted(t)
  const w = world(t)
  const [s1, , s3] = stepsOf(CUT_TURNS)
  const killed = w.start({ [NAV]: [s1, { status: 'stopped', cause: 'rate_limit', calls: [BEFORE] }] }, { sleep: () => { throw new Error('killed while waiting') } })
  await assert.rejects(search(killed.ctx, w.spec([ask('A')])), /killed while waiting/)
  const again = w.start({ [NAV]: [{ output: CUT.output, calls: [AFTER] }, s3], ...CUT_RULED })
  const result = await search(again.ctx, w.spec([ask('A')]))
  const [resumed] = again.calls
  assert.equal(resumed.round, 2)
  assert.equal(resumed.resume, true)
  assert.equal(resumed.brief, CUT_OFF + SEPARATOR + plain.calls[1].brief)
  assert.equal(resumed.thread.session, killed.calls[1].thread.session)
  assert.deepEqual(w.journal(), plain.w.journal())
  assert.deepEqual(withoutTree(result), withoutTree(plain.result))
})

// --- what only a ruling ends -----------------------------------------------------------------

test('a long chain whose state keeps moving is never ended by code: the ruler rules it at the check-ins and the stall', async (t) => {
  const w = world(t)
  const moved = Array.from({ length: 10 }, (_, i) => looking('chain', i + 1))
  const turns = [...moved, settling('chain', 'src/a.ts:4'), idle()]
  assert.ok(askAfter(12))
  const script = { [NAV]: stepsOf(turns) }
  for (const turn of [3, 6, 9]) script[RULER_AT(turn)] = [ruler(['chain', 'open'])]
  script[RULER_AT(12)] = [ruler(['chain', 'answered'])]
  const { ctx, calls } = w.start(script)
  const result = await search(ctx, w.spec([ask('chain')]))
  assert.equal(calls.filter((c) => c.role.name === 'scout').length, 12)
  assert.deepEqual(rulersIn(calls).map((c) => c.thread.key), [3, 6, 9, 12].map(RULER_THREAD))
  assert.deepEqual([result.asks.chain.end, result.asks.chain.label], ['done', 'ruled'])
})

// --- configuration and journal ---------------------------------------------------------------

test("each turn's MCP config serves the search's tree, its asks, its domain's tools and its call log", async (t) => {
  const w = world(t)
  const A = ask('A')
  const { script } = closing([settling('A', 'src/a.ts:4')], ['A', 'answered'])
  const { calls, ctx } = w.start(script)
  await search(ctx, w.spec([A]))
  assert.deepEqual(serverSpecOf(calls[0]), { tree: w.tree, asks: [{ key: 'A', scope: ['.'], domain: 'repo' }], tools: TOOLS_BY_DOMAIN.repo, calls: w.path })
})

test('the ground table is built once per search, over its tree, material, diff, config and the union of its scopes', async (t) => {
  const w = world(t)
  const config = { guidance: ['docs/review.md'] }
  const asks = [ask('A', { scope: ['src', 'lib'] }), ask('B', { scope: ['src'] })]
  const diff = { base: 'b'.repeat(40), head: 'c'.repeat(40) }
  const { ctx, calls } = w.start({ [NAV]: stepsOf(TWO()), [RULER_AT(3)]: [ruler(['A', 'absent'], ['B', 'absent'])] })
  const result = await search(ctx, w.spec(asks, { diff, config }))
  assert.equal(w.grounds.length, 1)
  const [{ tree, args }] = w.grounds
  assert.deepEqual(tree, w.tree)
  assert.deepEqual([args.material, args.scope, args.diff, args.config], [MATERIAL, ['lib', 'src'], diff, config])
  assert.deepEqual(result.ground, GROUND)
  const charge = chargeOf({ domain: 'repo', asks, material: MATERIAL, ground: GROUND })
  assert.equal(readFileSync(calls[0].role.systemPromptFile, 'utf8'), roleOf('scout').prompt + '\n\n' + charge)
  await search(w.start({}).ctx, w.spec(asks, { diff, config }))
  assert.equal(w.grounds.length, 1, 'a relaunch reads the ground from the journal')
  assert.equal(await groundFor(w.start({}).ctx, w.tree, { material: MATERIAL }), GROUND)
  assert.equal(w.grounds.length, 2, 'groundFor is the seam the loop resolves through')
})

test('a ground table the program hands over is recorded and used as given, and the search resolves nothing', async (t) => {
  const w = world(t)
  const given = groundOf(['A'])
  const { script } = closing([settling('A', 'src/a.ts:4')], ['A', 'answered'])
  const { ctx } = w.start(script)
  const result = await search(ctx, w.spec([ask('A')], { ground: given }))
  assert.equal(w.grounds.length, 0)
  assert.deepEqual(w.steps()[NAME + '/ground'], given)
  assert.deepEqual(result.ground, given)
  assert.equal(result.asks.A.end, 'done')
})

test("the journal holds the ground, the asks' joining, each turn's last call and missing cause, and each turn's ruling", async (t) => {
  const w = world(t)
  const turns = [settling('A', 'src/a.ts:4'), missing(), idle()]
  const ruled = units(['A', 'answered'])
  const { ctx } = w.start({ [NAV]: stepsOf(turns), [RULER_AT(3)]: [{ output: { units: ruled } }] })
  await search(ctx, w.spec([ask('A')]))
  const steps = w.steps()
  assert.deepEqual(steps[NAME + '/ground'], GROUND)
  assert.deepEqual(steps[NAME + '/asks:0'], ['A'])
  assert.deepEqual(steps[NAME + '/turn:1'], { calls_through: 1 })
  assert.deepEqual(steps[NAME + '/turn:2'], { calls_through: 1, missing: 'host_error' })
  assert.deepEqual(steps[NAME + '/turn:3'], { calls_through: 1 })
  assert.deepEqual(steps[NAME + '/ruling:3'], [{ turn: 3, asks: ['A'], units: ruled }])
  assert.deepEqual(rulingSteps(w), [NAME + '/ruling:3'])
})

// --- retained behaviour, on stall and ruling endings -----------------------------------------

test('a missing session is renewed, the next turn resumes the renewed one, and the result names both sessions', async (t) => {
  const w = world(t)
  const [s1, s2] = stepsOf([settling('A', 'src/a.ts:4'), idle()])
  const { ctx, calls } = w.start({ [NAV]: [s1, { status: 'failed', cause: 'session_missing' }, s2], [RULER_AT(2)]: [ruler(['A', 'answered'])] })
  const result = await search(ctx, w.spec([ask('A')]))
  assert.deepEqual(rolesIn(calls), ['scout', 'scout', 'ruler'])
  assert.deepEqual(w.log.entries().filter((e) => e.kind === 'thread_renewed').map((e) => [e.thread, e.why]), [[NAME, 'session_missing']])
  const sessions = result.sessions.map((s) => s.session)
  assert.equal(new Set(sessions).size, 2, 'the first session and the renewed one')
  assert.ok(result.sessions.every((s) => s.thread === NAME))
  assert.ok(sessions.includes(calls[0].thread.session))
  const navSessions = w.log.entries().filter((e) => e.kind === 'dispatched' && e.thread === NAME).map((e) => e.session)
  assert.deepEqual(navSessions.slice(0, 2), [calls[0].thread.session, calls[0].thread.session], 'turn 2 first resumes the first session')
  const renewed = navSessions.at(-1)
  assert.ok(sessions.includes(renewed))
  assert.notEqual(renewed, calls[0].thread.session, 'turn 2 runs again in the renewed session')
  assert.deepEqual([result.asks.A.end, result.asks.A.label], ['done', 'ruled'])
})

test('the ruler runs at the search\'s intelligence, on its own thread and session', async (t) => {
  const w = world(t)
  const { script } = closing([settling('A', 'src/a.ts:4')], ['A', 'answered'])
  const { ctx, calls } = w.start(script)
  const result = await search(ctx, w.spec([ask('A')], { intelligence: 'max' }))
  const [r] = rulersIn(calls)
  assert.deepEqual(r.tier, tierFor(roleOf('ruler'), { intelligence: 'max' }))
  assert.deepEqual(calls[0].tier, tierFor(roleOf('scout'), { intelligence: 'max', base: '' }))
  for (const s of result.sessions) {
    assert.notEqual(s.session, r.thread.session, 'the ruler is none of the navigator sessions')
    assert.notEqual(s.thread, r.thread.key, 'the ruler is not on the navigator thread')
  }
})

test('a ruling that fails is dispatched again once, and failing again stops every ask it was to rule', async (t) => {
  const w = world(t)
  const failed = { status: 'failed', cause: 'host_error' }
  const { ctx, calls } = w.start({ [NAV]: stepsOf([settling('A', 'src/a.ts:4'), idle()]), [RULER_AT(2)]: [failed, failed] })
  const result = await search(ctx, w.spec([ask('A')]))
  assert.deepEqual(rolesIn(calls), ['scout', 'scout', 'ruler', 'ruler'])
  assert.equal(calls[3].round, 2)
  assert.equal(result.asks.A.end, 'stopped')
  assert.ok(!result.asks.A.answer, 'a stop is no answer')
  assert.equal(result.status, 'returned')
})

test('two searches of one name under different scopes keep separate threads, call logs, servers and steps', async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const keys = ['probe:p:1/' + NAME, 'probe:p:2/' + NAME]
  const script = {}
  keys.forEach((key, i) => {
    script['scout||' + key] = stepsOf([settling('A', 'src/a.ts:' + (i + 1)), idle()])
    script['ruler||ruler:search:' + key + ':2'] = [ruler(['A', 'answered'])]
  })
  const { ctx, calls } = w.start(script)
  await search(scoped(ctx, 'probe:p:1'), w.spec(asks))
  await search(scoped(ctx, 'probe:p:2'), w.spec(asks))
  const nav = calls.filter((c) => c.role.name === 'scout')
  assert.deepEqual(nav.map((c) => c.thread.key), [keys[0], keys[0], keys[1], keys[1]])
  const logs = keys.map((key) => join(searchDir(w.dir, key), 'calls.jsonl'))
  assert.notEqual(logs[0], logs[1])
  assert.deepEqual(nav.map((c) => serverSpecOf(c).calls), [logs[0], logs[0], logs[1], logs[1]])
  logs.forEach((log, i) => {
    const records = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.deepEqual(records.map((r) => [r.seq, r.observed[0].line]), [[1, i + 1]], keys[i])
  })
  const steps = w.steps()
  for (const key of keys) {
    assert.deepEqual(steps[key + '/turn:1'], { calls_through: 1 }, key)
    assert.ok(steps[key + '/ruling:2'], key + ' rules its own stall')
  }
})

test('called again with more asks, a search replays what it ran and goes on with the new asks, in the same session and charge', async (t) => {
  const w = world(t)
  const A = ask('A')
  const want = ask('want:1', { find: 'the other settled line', from: 3 })
  const { script } = closing([settling('A', 'src/a.ts:4')], ['A', 'answered'])
  const first = w.start(script)
  const before = await search(first.ctx, w.spec([A]))
  // the joining ask's ground journaled as the loop journals it (N12), so this fast test resolves nothing
  w.log.append('step', { key: NAME + '/ground:want:1', value: [] })
  // turn 3 is a check-in and want:1's stamp moved from its join baseline, so turn 3's ruling rules it
  const again = w.start({ [NAV]: stepsOf([settling('want:1', 'src/b.ts:2')]), [RULER_AT(3)]: [ruler(['want:1', 'answered'])] })
  const after = await search(again.ctx, w.spec([A, want]))
  assert.deepEqual(rolesIn(again.calls), ['scout', 'ruler'], 'turns 1-2 and their ruling are replayed')
  const [three] = again.calls
  assert.equal(three.round, 3)
  assert.equal(three.resume, true)
  assert.equal(three.thread.session, first.calls[0].thread.session)
  const charge = chargeOf({ domain: 'repo', asks: [A], material: MATERIAL, ground: GROUND })
  assert.equal(readFileSync(three.role.systemPromptFile, 'utf8'), roleOf('scout').prompt + '\n\n' + charge,
    'the charge stays the first call\'s, so the session\'s cached prompt holds')
  assert.deepEqual(after.asks.A, before.asks.A)
  assert.deepEqual([after.asks['want:1'].end, after.asks['want:1'].label], ['done', 'ruled'])
  assert.equal(w.grounds.length, 1)
  const relaunched = w.start({})
  assert.deepEqual(await search(relaunched.ctx, w.spec([A])), before)
  assert.deepEqual(await search(relaunched.ctx, w.spec([A, want])), after)
  assert.equal(relaunched.calls.length, 0)
})

test('a search returns its name, status, tree, ground, sessions and counts in the shape its programs read', async (t) => {
  const keys = ['guidance', 'ground:intro', 'ground:api']
  const ground = groundOf(keys)
  const w = world(t, { ground })
  const asks = keys.map((k) => ask(k))
  const work = turnOf(
    [grep(['guidance'], ['src/a.ts:4', 'src/b.ts:2']), grep(['ground:intro'], ['src/a.ts:1']), grep(['ground:api'], ['src/b.ts:1'])],
    back({
      hits: [hit(['guidance'], 'src/a.ts:4'), hit(['guidance'], 'src/b.ts:2'), hit(['ground:intro'], 'src/a.ts:1'), hit(['ground:api'], 'src/b.ts:1')],
      asks: keys.map((k) => declared(k, 'answered')),
    }))
  const { script } = closing([work], ...keys.map((k) => [k, 'answered']))
  const { ctx, calls } = w.start(script)
  const result = await search(ctx, w.spec(asks))
  assert.deepEqual([result.name, result.status, result.cause], [NAME, 'returned', ''])
  assert.deepEqual(result.tree, w.tree)
  assert.deepEqual(result.ground, ground)
  assert.deepEqual(result.sessions, [{ session: calls[0].thread.session, thread: NAME }])
  for (const k of keys) assert.equal(result.asks[k].end, 'done', k)
  const keysIn = (pick) => new Set(Object.entries(result.asks).filter(([k]) => pick(k)).flatMap(([, a]) => a.hits.map((h) => h.key))).size
  assert.equal(result.entries_n, keysIn(() => true))
  assert.deepEqual(result.kinds, { guidance: keysIn((k) => k === 'guidance'), ground: keysIn((k) => k.startsWith('ground:')) })
})

test('an unobserved citation reaches the navigator before the ask can end, and the search hands back every refusal still standing', async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const work = turnOf([grep(['A'], ['src/a.ts:4'])], back({ hits: [hit(['A'], 'src/b.ts:2')], asks: [declared('A', 'answered')] }))
  const { turns, script } = closing([work], ['A', 'absent'])
  const { ctx, calls } = w.start(script)
  const result = await search(ctx, w.spec(asks))
  assert.deepEqual(rolesIn(calls), ['scout', 'scout', 'ruler'], 'the navigator is shown the refusal before the ruling')
  assert.ok(calls[1].brief.includes('unobserved') && calls[1].brief.includes('src/b.ts:2'), calls[1].brief)
  assert.deepEqual([result.asks.A.end, result.asks.A.hits.length], ['done', 0])
  const end = ledgerOf({ asks, turns, rulings: rulingsIn(w) })
  assert.deepEqual(result.refusals, standingRefusals(end))
  assert.deepEqual(result.refusals.map((r) => [r.turn, r.class, r.item.path, r.asks]), [[1, 'unobserved', 'src/b.ts', ['A']]])
  assert.ok(result.coverage.unreached.some((l) => l.startsWith(NAME + ':A: ') && l.includes('src/b.ts:2')), JSON.stringify(result.coverage.unreached))
})
