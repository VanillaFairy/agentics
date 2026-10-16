// test/fast/search-loop-sessions.test.mjs — pins what a search sends each navigator session: the
// whole state to a fresh, renewed or compacted session and what changed to a resumed one, nothing
// lost to a missing turn, a cut-off or a long return; the more-folded refits a refused prompt is
// sent again with; the files a scope-owing ask owes; the ground a joined want is resolved to; and
// the WebSearch calls the host ran, journaled once and search-wide. The scripted runner stands in
// for the host, its `calls` seam for the tool server, `ctx.groundOf` and `ctx.scopeFilesOf` for
// the resolver.
//
// Design: docs/DESIGN.md#searches and docs/DESIGN.md#briefs-and-returns.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { briefOf } from '../../lib/briefs/search.mjs'
import { renderMessage } from '../../lib/conversation.mjs'
import { programContext } from '../../lib/programs/common.mjs'
import { search } from '../../lib/programs/search/loop.mjs'
import { fileGroups, foldLedger, stateOf } from '../../lib/search/ledger.mjs'
import { searchDir } from '../../lib/search/server.mjs'
import { memoryLog } from './harness/memory-log.mjs'
import { scriptedRunner } from './harness/scripted-runner.mjs'

const RUN = '20260101-000000-test'
const NOW = () => '2026-01-01T00:00:00.000Z'
const TREE = { root: '/pinned/tree', sha: 'a'.repeat(40) }
const NAME = 'locate'
const NAV = 'scout||' + NAME
const WEB = 'doc-researcher||' + NAME
const RULER_AT = (turn) => 'ruler||ruler:search:' + NAME + ':' + turn
const GROUND = { rows: [], seeds: [] }
const MATERIAL = [{ label: 'The artefact', text: '# The artefact\n\nIt names `src/a.mjs` and `parseWidget`.' }]
const CUT_OFF = renderMessage({ msg: 'cut_off' })
/** The files of the pinned tree, as `scopeFiles` would list them. */
const FILES = ['src/a.mjs', 'src/b.mjs', 'src/c/one.mjs', 'src/c/two.mjs', 'src/c/deep/three.mjs', 'src/w/cache.mjs']
const SEED = { key: 'src/seed.mjs', as: 'open', reason: 'named by the material' }

/** A seeded repo ask: it owes no files. */
const ask = (key, over = {}) => ({ key, find: 'where ' + key + ' is settled', scope: ['src'], domain: 'repo', seeds: [SEED], ...over })
/** A repo ask with no seed: with no ground row of its own it owes its scope's files. */
const owing = (key, over = {}) => ({ key, find: 'every place ' + key + ' is configured', scope: ['src/c'], domain: 'repo', ...over })
const specOf = (asks, over = {}) => ({ name: NAME, role: 'scout', schema: 'search_repo', tree: TREE, asks, material: MATERIAL, intelligence: 'normal', ...over })

/**
 * One run's world: a scratch home and one log every start reads back (a relaunch is a start over
 * the same log); the resolver calls each seam received; the search's call log as it stands.
 */
function world(t, { ground = GROUND, groundOf = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agentics-search-sessions-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const dir = join(home, 'run')
  const log = memoryLog()
  const grounds = []
  const scopes = []
  const start = (script, { sleep = () => Promise.resolve() } = {}) => {
    const runner = scriptedRunner(script, { log, now: NOW })
    const ctx = {
      ...programContext({ intelligence: 'normal', repo: home, root: home, run: RUN, log, runAgent: runner.runAgent, now: NOW, sleep, dir }),
      groundOf: async (tree, args) => { grounds.push({ tree, args }); return groundOf ? groundOf(tree, args) : ground },
      scopeFilesOf: async (tree, scope) => {
        scopes.push({ tree, scope })
        return FILES.filter((f) => scope.some((s) => s === '.' || f.startsWith(s + '/')))
      },
    }
    return { ctx, calls: runner.calls, starts: runner.starts }
  }
  const path = join(searchDir(dir, NAME), 'calls.jsonl')
  const journal = () => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
  const steps = () => Object.fromEntries(log.entries().filter((e) => e.kind === 'step').map((e) => [e.key, e.value]))
  const kind = (k) => log.entries().filter((e) => e.kind === k)
  return { log, grounds, scopes, start, journal, steps, kind }
}

/** A grep code ran for `asks`, showing each `path:line` of `lines`; `paths` narrows it. */
const grep = (asks, lines, pattern = 'seen ' + lines.join(' '), paths = []) => ({
  tool: 'grep', args: { pattern, fixed: false, ignore_case: false, paths, page: 1 }, asks, ok: true,
  total: lines.length, page: 1, pages: 1,
  observed: lines.map((at) => ({ key: at.split(':')[0], line: Number(at.split(':')[1]) })),
  keys: [...new Set(lines.map((at) => at.split(':')[0]))],
})
const back = ({ hits = [], dismissed = [], leads = [], asks = [] } = {}) => ({ hits, dismissed, leads, asks })
const hit = (asks, at, note = 'settled at ' + at) => ({ ask: asks, path: at.split(':')[0], line: Number(at.split(':')[1]), note })
const declared = (key, d) => ({ ask: key, declared: d })

const turnOf = (calls, output) => ({ calls, output })
const missing = (cause = 'host_error') => ({ missing: cause, calls: [] })
/** A turn that greps one new line for each of `keys` and declares them open. */
const work = (keys, n) => turnOf(keys.map((k) => grep([k], ['src/' + k.replace(/\W/g, '_') + '.mjs:' + n])), back({ asks: keys.map((k) => declared(k, 'open')) }))
/** A turn that looks at nothing: the stall that closes a search. */
const idle = () => turnOf([], back())

/** The scripted start of a turn; `extra` adds host facts (context, compacted, webSearches). */
const stepOf = (t, extra = {}) => (t.missing ? { status: 'failed', cause: t.missing, calls: t.calls } : { output: t.output, calls: t.calls, ...extra })
const stepsOf = (turns) => turns.map((t) => stepOf(t))
const units = (...pairs) => pairs.map(([unit, ruling]) => ({ unit, ruling, why: unit + ' is ' + ruling + ' on what the ledger holds' }))
const ruler = (turn, ...pairs) => ({ [RULER_AT(turn)]: [{ output: { units: units(...pairs) } }] })

/**
 * The close of a search: the idle turn that stalls it and the ruler of that turn ruling every
 * key in `keys` answered. `turn` is the idle turn's number.
 */
const closing = (turn, keys) => ({ turn: idle(), ruler: ruler(turn, ...keys.map((k) => [k, 'answered'])) })

const CONTEXT_EXCEEDED = { status: 'failed', cause: 'context_exceeded' }

/**
 * Pure. The ledger the records of `turns` and `rulings` fold to, each call numbered as the server
 * numbers it and each turn through its last call. `owes` gives a scope-owing ask its files.
 */
function ledgerOf({ asks, turns, rulings = [], from = {}, owes = {}, ground = GROUND }) {
  let seq = 0
  const calls = []
  const folded = turns.map((t, i) => {
    for (const c of t.calls) calls.push({ ...c, seq: ++seq })
    return t.missing ? { turn: i + 1, missing: t.missing, calls_through: seq } : { turn: i + 1, output: t.output, calls_through: seq }
  })
  const specs = asks.map((a) => ({ ...a, from: from[a.key] || 1, ...(owes[a.key] ? { owes: owes[a.key] } : {}) }))
  return foldLedger({ asks: specs, ground, calls, turns: folded, rulings })
}

/** A brief holds an agenda item: a seed by its directory's line and its name, any other by its key. */
function holds(brief, item) {
  if (item.kind !== 'seed') return brief.includes(item.key)
  const at = item.key.lastIndexOf('/')
  return at < 0 ? brief.includes(item.key) : brief.includes(item.key.slice(0, at) + '/: ') && brief.includes(item.key.slice(at + 1))
}

const navCalls = (calls) => calls.filter((c) => c.role.name !== 'ruler')
const navStarts = (starts, key = NAV) => starts.filter((s) => s.key === key)
const ofRound = (starts, round) => navStarts(starts).filter((s) => s.round === round)

// --- what a session is sent (N10) ------------------------------------------------------------

test('a resumed turn gets what changed', async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const close = closing(2, ['A'])
  const turns = [work(['A'], 1), close.turn]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns), ...close.ruler })
  const result = await search(ctx, specOf(asks))
  const [one, two] = navCalls(calls)
  const L0 = ledgerOf({ asks, turns: [] })
  const L1 = ledgerOf({ asks, turns: turns.slice(0, 1) })
  assert.equal(one.brief, briefOf(L0, null, { turn: 1 }), 'a session starts on the whole state')
  assert.equal(two.resume, true)
  assert.equal(two.thread.session, one.thread.session)
  assert.equal(two.brief, briefOf(L1, L0, { turn: 2 }), 'the base is the ledger the session was last briefed on')
  assert.ok(holds(one.brief, { kind: 'seed', key: SEED.key }), 'the seed is on the first brief')
  assert.ok(!two.brief.includes('seed.mjs'), 'an agenda item that did not change is not sent again')
  assert.equal(result.asks.A.end, 'done')
})

test('a renewed session gets the whole state', async (t) => {
  const w = world(t)
  const asks = [ask('A'), owing('C')]
  const close = closing(3, ['A', 'C'])
  const turns = [work(['A'], 1), work(['A'], 2), close.turn]
  const steps = [stepOf(turns[0], { context: 1000 }), stepOf(turns[1], { context: 150000 }), stepOf(turns[2])]
  const { ctx, starts } = w.start({ [NAV]: steps, ...close.ruler })
  const result = await search(ctx, specOf(asks))
  assert.deepEqual(w.kind('thread_renewed').map((e) => [e.thread, e.why]), [[NAME, 'too_large']])
  const [renewed] = ofRound(starts, 3)
  assert.equal(renewed.resume, false)
  assert.notEqual(renewed.session, ofRound(starts, 1)[0].session)
  const owes = { C: w.steps()[NAME + '/owes:C'] }
  const L2 = ledgerOf({ asks, turns: turns.slice(0, 2), owes })
  assert.equal(renewed.stdin, briefOf(L2, null, { turn: 3 }), "the fresh session's prompt is the whole state")
  for (const a of Object.values(L2.asks).filter((s) => !s.end)) {
    assert.ok(renewed.stdin.includes(a.find), a.key + ': its find')
    for (const item of a.agenda.filter((f) => f.kind !== 'file')) assert.ok(holds(renewed.stdin, item), a.key + ': ' + item.key)
    for (const { dir } of fileGroups(a.agenda.filter((f) => f.kind === 'file').map((f) => f.key))) assert.ok(renewed.stdin.includes(dir + '/'), a.key + ': ' + dir)
  }
  assert.equal(result.asks.A.end, 'done')
})

test('a missing turn drops nothing', async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const close = closing(3, ['A'])
  const cited = turnOf([grep(['A'], ['src/a.mjs:3'])], back({ hits: [hit(['A'], 'src/b.mjs:9')], asks: [declared('A', 'open')] }))
  const turns = [cited, missing(), close.turn]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns), ...close.ruler })
  const result = await search(ctx, specOf(asks))
  const nav = navCalls(calls)
  assert.equal(nav.length, 3)
  const L0 = ledgerOf({ asks, turns: [] })
  const L1 = ledgerOf({ asks, turns: turns.slice(0, 1) })
  const L2 = ledgerOf({ asks, turns: turns.slice(0, 2) })
  assert.ok(L1.refusals.length > 0, 'the first return is refused a citation')
  assert.equal(nav[2].thread.session, nav[0].thread.session, 'the same session')
  assert.equal(nav[2].brief, briefOf(L2, L0, { turn: 3 }), 'based on the last turn that returned, not the one that went missing')
  assert.ok(nav[2].brief.includes('src/b.mjs:9'), 'the refusal of the last returned turn')
  assert.equal(result.asks.A.end, 'done')
})

test('a compacted session gets the whole state', async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const close = closing(2, ['A'])
  const turns = [work(['A'], 1), close.turn]
  const { ctx, calls } = w.start({ [NAV]: [stepOf(turns[0], { compacted: true }), stepOf(turns[1])], ...close.ruler })
  const result = await search(ctx, specOf(asks))
  const [one, two] = navCalls(calls)
  assert.deepEqual(w.kind('returned').filter((e) => e.dispatch === one.dispatch).map((e) => e.compacted), [true])
  assert.equal(two.resume, true)
  assert.equal(two.thread.session, one.thread.session, 'a compaction renews nothing')
  assert.equal(two.brief, briefOf(ledgerOf({ asks, turns: turns.slice(0, 1) }), null, { turn: 2 }))
  assert.equal(result.asks.A.end, 'done')
})

test('a silent compaction is detected', async (t) => {
  for (const [second, whole] of [[20000, true], [60000, false]]) {
    const w = world(t)
    const asks = [ask('A')]
    const close = closing(3, ['A'])
    const turns = [work(['A'], 1), work(['A'], 2), close.turn]
    const steps = [stepOf(turns[0], { context: 50000 }), stepOf(turns[1], { context: second }), stepOf(turns[2])]
    const { ctx, calls } = w.start({ [NAV]: steps, ...close.ruler })
    const result = await search(ctx, specOf(asks))
    const nav = navCalls(calls)
    const [L0, L1, L2] = [0, 1, 2].map((n) => ledgerOf({ asks, turns: turns.slice(0, n) }))
    assert.deepEqual(w.kind('thread_renewed'), [], 'opened ' + second)
    assert.equal(nav[1].brief, briefOf(L1, L0, { turn: 2 }), 'opened ' + second + ': turn 2 is a delta')
    assert.equal(nav[2].thread.session, nav[0].thread.session)
    assert.equal(nav[2].brief, briefOf(L2, whole ? null : L1, { turn: 3 }),
      'opened ' + second + ' after a context of 50000: ' + (whole ? 'the session lost what it held' : 'nothing was lost'))
    assert.equal(result.asks.A.end, 'done')
  }
})

test('search threads renew on a new prompt', async (t) => {
  const w = world(t)
  const A = ask('A')
  const want = ask('want:1', { find: 'where the retry budget of src/a.mjs is spent', seeds: undefined })
  const first = w.start({ [NAV]: stepsOf([work(['A'], 1), idle()]), ...ruler(2, ['A', 'answered']) })
  await search(first.ctx, specOf([A]))
  const material = [{ label: 'The artefact, edited', text: '# The artefact\n\nIt now names `src/b.mjs`.' }]
  const again = w.start({ [NAV]: stepsOf([work(['want:1'], 1)]), ...ruler(3, ['want:1', 'answered']) })
  const result = await search(again.ctx, specOf([A, want], { material }))
  const [relaunched] = navCalls(again.calls)
  assert.notEqual(relaunched.role.systemPromptFile, first.calls[0].role.systemPromptFile, 'the charge changed')
  assert.ok(w.kind('thread_renewed').some((e) => e.thread === NAME && e.why === 'prompt_changed'))
  assert.equal(relaunched.resume, false)
  assert.notEqual(relaunched.thread.session, first.calls[0].thread.session, 'a new session under the new charge')
  assert.ok(ofRound(again.starts, 3)[0].stdin.includes(want.find))
  assert.equal(result.asks['want:1'].end, 'done')

  const c = world(t)
  const cut = c.start({ [NAV]: [stepOf(work(['A'], 1)), { status: 'stopped', cause: 'rate_limit' }, stepOf(idle())], ...ruler(2, ['A', 'answered']) })
  await search(cut.ctx, specOf([A]))
  const [, stopped, resumed] = navCalls(cut.calls)
  assert.deepEqual([stopped.round, resumed.round], [2, 2])
  assert.equal(resumed.resume, true)
  assert.equal(resumed.thread.session, stopped.thread.session)
  assert.notEqual(stopped.brief, CUT_OFF)
  assert.ok(resumed.brief.startsWith(CUT_OFF), 'the cut-off message first')
  assert.ok(resumed.brief.endsWith(stopped.brief), 'then the brief the cut-off turn was sent')

  const k = world(t)
  const killed = k.start({ [NAV]: [stepOf(work(['A'], 1)), { status: 'stopped', cause: 'rate_limit' }] }, { sleep: () => { throw new Error('killed while waiting') } })
  await assert.rejects(search(killed.ctx, specOf([A])), /killed while waiting/)
  const relaunch = k.start({ [NAV]: [stepOf(idle())], ...ruler(2, ['A', 'answered']) })
  await search(relaunch.ctx, specOf([A]))
  const [again2] = navCalls(relaunch.calls)
  assert.equal(again2.round, 2)
  assert.ok(again2.brief.startsWith(CUT_OFF))
  assert.ok(again2.brief.endsWith(navCalls(killed.calls)[1].brief), 'a relaunch resends the brief of the turn it cut off')
})

test('a turn refits before it fails', async (t) => {
  const w = world(t)
  const asks = [ask('A')]
  const close = closing(3, ['A'])
  const turns = [work(['A'], 1), missing('context_exceeded'), close.turn]
  const nav = [stepOf(turns[0]), CONTEXT_EXCEEDED, CONTEXT_EXCEEDED, CONTEXT_EXCEEDED, CONTEXT_EXCEEDED, stepOf(turns[2])]
  const { ctx, calls, starts } = w.start({ [NAV]: nav, ...close.ruler })
  const result = await search(ctx, specOf(asks))
  const L1 = ledgerOf({ asks, turns: turns.slice(0, 1) })
  const refused = navCalls(calls).filter((c) => c.round === 2)
  assert.equal(refused.length, 1, 'one dispatch; the runner refits it')
  assert.deepEqual(refused[0].refits, [2, 3, 4].map((level) => briefOf(L1, null, { level, turn: 2 })), 'three more-folded whole briefs')
  assert.deepEqual(ofRound(starts, 2).slice(1).map((s) => s.stdin), refused[0].refits, 'each refit is sent in turn')
  assert.deepEqual(w.kind('thread_renewed').map((e) => e.why), ['context_exceeded', 'context_exceeded', 'context_exceeded'])
  assert.equal(w.steps()[NAME + '/turn:2'].missing, 'context_exceeded')
  const [three] = navCalls(calls).filter((c) => c.round === 3)
  assert.equal(three.brief, briefOf(ledgerOf({ asks, turns: turns.slice(0, 2) }), null, { turn: 3 }),
    'a session no turn returned in gets the whole state')
  assert.equal(result.asks.A.end, 'done')
})

test('refits run out and the asks stop', async (t) => {
  const w = world(t)
  const asks = [ask('A'), ask('B')]
  const nav = [stepOf(work(['A', 'B'], 1)), ...Array(8).fill(CONTEXT_EXCEEDED)]
  const { ctx, starts } = w.start({ [NAV]: nav })
  const result = await search(ctx, specOf(asks))
  assert.deepEqual([2, 3].map((n) => ofRound(starts, n).length), [4, 4])
  assert.deepEqual([2, 3].map((n) => w.steps()[NAME + '/turn:' + n].missing), ['context_exceeded', 'context_exceeded'])
  for (const key of ['A', 'B']) {
    const a = result.asks[key]
    assert.deepEqual([a.end, a.label], ['stopped', 'observed'], key)
    assert.match(a.why, /context_exceeded/, key)
  }
  assert.equal(result.status, 'returned')
})

/** Pure. The lines of a brief's `## <title>` section. */
const sectionOf = (brief, title) => {
  const lines = brief.split('\n')
  const at = lines.indexOf('## ' + title)
  if (at < 0) return []
  const end = lines.findIndex((l, i) => i > at && l.startsWith('## '))
  return lines.slice(at + 1, end < 0 ? undefined : end).filter((l) => l.startsWith('- '))
}

test('the session received the whole state', async (t) => {
  const w = world(t)
  const asks = [ask('A'), ask('B'), owing('C')]
  const t1 = turnOf([grep(['A'], ['src/a.mjs:1']), grep(['B'], ['src/b.mjs:1'])],
    back({ hits: [hit(['B'], 'src/b.mjs:99')], asks: [declared('A', 'open'), declared('B', 'open')] }))
  const t2 = turnOf([grep(['A'], ['src/a.mjs:2'])], back({ asks: [declared('A', 'open')] }))
  const lead = { ask: ['A'], path: 'src/lead.mjs', why: 'it imports the parser' }
  const part = back({ leads: [lead], asks: [declared('A', 'open')] })
  const rest = back({ asks: [declared('B', 'open')] })
  const t3 = turnOf([grep(['A'], ['src/a.mjs:3'])], back({ leads: [lead], asks: [declared('A', 'open'), declared('B', 'open')] }))
  const t4 = turnOf([grep(['A'], ['src/a.mjs:4'])], back({ asks: [declared('A', 'open')] }))
  const turns = [t1, t2, t3, t4, idle()]
  const at3 = ruler(3, ['A', 'open'], ['B', 'not_converging'], ['C', 'open'])
  const at5 = ruler(5, ['A', 'answered'], ['C', 'answered'])
  const nav = [
    stepOf(t1, { context: 1000 }), stepOf(t2, { context: 150000 }),
    { output: part, more: true, calls: t3.calls }, { output: rest, calls: [] },
    { status: 'stopped', cause: 'rate_limit', calls: [] }, stepOf(t4),
    stepOf(turns[4]),
  ]
  const { ctx, starts } = w.start({ [NAV]: nav, ...at3, ...at5 })
  const result = await search(ctx, specOf(asks))
  assert.deepEqual(w.kind('thread_renewed').map((e) => e.why), ['too_large'], 'the renewal')
  assert.equal(ofRound(starts, 3).length, 2, 'the part and its continuation')
  assert.equal(ofRound(starts, 4).length, 2, 'the cut-off and its resume')

  const owes = { C: w.steps()[NAME + '/owes:C'] }
  const L3 = ledgerOf({ asks, turns: turns.slice(0, 3), owes })
  const sent = stateOf(L3, { turn: 3, checkin: true }).toRuler
  const r3 = { turn: 3, asks: sent, units: at3[RULER_AT(3)][0].output.units.filter((u) => sent.includes(u.unit)) }
  const final = ledgerOf({ asks, turns: turns.slice(0, 4), owes, rulings: [r3] })
  assert.equal(final.asks.B.end && final.asks.B.end.state, 'not_converging', 'the rig ends B before the last turn')

  const current = navStarts(starts).at(-1).session
  const session = navStarts(starts).filter((s) => s.session === current)
  assert.equal(session[0].resume, false, 'the current session opens on a fresh brief')
  assert.equal(session[0].round, 3)
  const received = session.map((s) => s.stdin).join('\n')
  const whole = briefOf(final, null, { turn: 5 })
  const owed = whole.split('\n').filter((l) => l.startsWith('Find: ') || l.startsWith('  - '))
  const dirs = whole.split('\n').map((l) => l.match(/^- (.+\/): \d+ files?$/)).filter(Boolean).map((m) => m[1])
  const refusals = sectionOf(whole, 'Refused')
  const ends = sectionOf(whole, 'Ended')
  assert.ok(owed.length > 0 && dirs.length > 0 && refusals.length > 0 && ends.length > 0, 'the rig puts every kind on the whole brief')
  for (const line of [...owed, ...refusals, ...ends]) assert.ok(received.includes(line), 'never sent: ' + line)
  for (const dir of dirs) assert.ok(received.includes(dir), 'never sent: ' + dir)
  assert.deepEqual([result.asks.A.end, result.asks.B.end], ['done', 'not_converging'])
})

// --- owes and want ground (N2, N12) ----------------------------------------------------------

test('a scope-owing ask owes its files', async (t) => {
  const w = world(t)
  const asks = [owing('C')]
  const close = closing(2, ['C'])
  const turns = [turnOf([grep(['C'], ['src/c/one.mjs:1'], 'config', ['src/c/one.mjs'])], back({ asks: [declared('C', 'open')] })), close.turn]
  const { ctx, calls } = w.start({ [NAV]: stepsOf(turns), ...close.ruler })
  const result = await search(ctx, specOf(asks))
  const files = FILES.filter((f) => f.startsWith('src/c/'))
  assert.deepEqual([...w.steps()[NAME + '/owes:C']].sort(), [...files].sort(), 'the step holds the scope\'s files')
  assert.deepEqual(w.scopes, [{ tree: TREE, scope: ['src/c'] }], 'listed once, through the seam')
  const L0 = ledgerOf({ asks, turns: [], owes: { C: files } })
  assert.deepEqual(L0.asks.C.agenda.filter((f) => f.kind === 'file').map((f) => f.key).sort(), [...files].sort())
  assert.equal(navCalls(calls)[0].brief, briefOf(L0, null, { turn: 1 }), "the fold's agenda has the files")
  for (const { dir } of fileGroups(files)) assert.ok(navCalls(calls)[0].brief.includes(dir + '/'), dir)
  const again = w.start({})
  assert.deepEqual(await search(again.ctx, specOf(asks)), result, 'a relaunch replays the step')
  assert.equal(w.scopes.length, 1)
})

test('an ask with rows owes no files', async (t) => {
  const row = { kind: 'path', mention: 'src/a.mjs', key: 'src/a.mjs', exists: true, asks: ['A'], defs: [], refs: [], files: 0 }
  const w = world(t, { ground: { rows: [row], seeds: [] } })
  const asks = [owing('A', { scope: ['src'] }), ask('B'), owing('C')]
  const close = closing(2, ['A', 'B', 'C'])
  const turns = [work(['A', 'B', 'C'], 1), close.turn]
  const { ctx } = w.start({ [NAV]: stepsOf(turns), ...close.ruler })
  await search(ctx, specOf(asks))
  const owesSteps = Object.keys(w.steps()).filter((k) => k.startsWith(NAME + '/owes:'))
  assert.deepEqual(owesSteps, [NAME + '/owes:C'], 'an own row or a seed owes nothing')
  assert.deepEqual(w.scopes.map((s) => s.scope), [['src/c']])
})

test('a joined want is resolved', async (t) => {
  const wantRow = (asks) => ({ kind: 'path', mention: 'src/w/cache.mjs', key: 'src/w/cache.mjs', exists: true, asks, defs: [], refs: [], files: 0 })
  const groundOf = (tree, args) => {
    const owners = [...new Set((args.material || []).flatMap((m) => m.asks || []))]
    return owners.length ? { rows: [wantRow(owners)], seeds: [] } : GROUND
  }
  const w = world(t, { groundOf })
  const A = ask('A')
  const want = { key: 'want:1', find: 'where the widget cache is flushed', scope: ['src/w'], domain: 'repo' }
  const first = w.start({ [NAV]: stepsOf([work(['A'], 1), work(['A'], 2), idle()]), ...ruler(3, ['A', 'answered']) })
  await search(first.ctx, specOf([A]))
  const again = w.start({ [NAV]: stepsOf([work(['want:1'], 4), idle()]), ...ruler(5, ['want:1', 'answered']) })
  const result = await search(again.ctx, specOf([A, want]))
  assert.deepEqual(w.steps()[NAME + '/asks:3'], ['want:1'], 'it joins at turn 4')
  assert.equal(w.grounds.length, 2, 'the search ground once, the want once')
  const { tree, args } = w.grounds[1]
  assert.deepEqual(tree, TREE)
  assert.equal(args.material.length, 1)
  assert.deepEqual([args.material[0].text, args.material[0].asks], [want.find, ['want:1']])
  assert.deepEqual(args.scope, want.scope)
  const rows = w.steps()[NAME + '/ground:want:1'].rows
  assert.ok(rows.length > 0)
  for (const r of rows) assert.deepEqual(r.asks, ['want:1'])
  const [four] = navCalls(again.calls)
  assert.equal(four.round, 4)
  assert.ok(four.brief.includes('src/w/cache.mjs'), "the want's row is on its agenda")
  assert.equal(four.resume, true)
  assert.equal(four.thread.session, first.calls[0].thread.session)
  assert.equal(readFileSync(four.role.systemPromptFile, 'utf8'), readFileSync(first.calls[0].role.systemPromptFile, 'utf8'), 'the charge is unchanged')
  const prompts = w.kind('dispatched').filter((e) => e.thread === NAME).map((e) => e.prompt)
  assert.equal(new Set(prompts).size, 1, 'one system-prompt digest')
  assert.equal(result.asks['want:1'].end, 'done')
  await search(w.start({}).ctx, specOf([A, want]))
  assert.equal(w.grounds.length, 2, 'a relaunch reads the want ground from the journal')
})

test('a prose want joins near renewal', async (t) => {
  for (const last of [100400, 100600]) {
    const w = world(t)
    const A = ask('A')
    const want = ask('want:1', { find: 'how retries are throttled when the host is busy' })
    const first = w.start({ [NAV]: [stepOf(work(['A'], 1), { context: 1000 }), stepOf(idle(), { context: last })], ...ruler(2, ['A', 'answered']) })
    await search(first.ctx, specOf([A]))
    const again = w.start({ [NAV]: stepsOf([work(['want:1'], 3)]), ...ruler(3, ['want:1', 'answered']) })
    const result = await search(again.ctx, specOf([A, want]))
    const sent = ofRound(again.starts, 3).map((s) => s.stdin).join('\n')
    assert.ok(sent.includes(want.find), 'context ' + last + ': the turn it joins on carries its find')
    assert.equal(result.asks['want:1'].end, 'done')
  }
})

// --- WebSearch journal (N11) -----------------------------------------------------------------

const W = { key: 'W', find: 'which library parses widgets', scope: [], domain: 'web' }
const webSpec = () => specOf([W], { role: 'doc-researcher', schema: 'search_web' })
const QUERIES = [{ query: 'widget parser' }, { query: 'widget parser license' }]
const SEARCHED = { output: back({ asks: [declared('W', 'open')] }), calls: [], webSearches: QUERIES }

test('WebSearch is journaled once', async (t) => {
  const w = world(t)
  const killed = w.start({ [WEB]: [SEARCHED] })
  await assert.rejects(search(killed.ctx, webSpec()), /no start 2/)
  const used = w.kind('tool_used')
  assert.deepEqual(used.map((e) => e.input), QUERIES)
  const again = w.start({ [WEB]: [stepOf(idle())], ...ruler(2, ['W', 'answered']) })
  await search(again.ctx, webSpec())
  await search(w.start({}).ctx, webSpec())
  const records = w.journal().filter((c) => c.tool === 'websearch')
  assert.equal(records.length, 2, 'one record per WebSearch, across relaunches')
  assert.deepEqual(records.map((r) => r.from_log).sort(), used.map((e) => e.seq).sort())
  for (const r of records) {
    const from = used.find((e) => e.seq === r.from_log)
    assert.deepEqual([r.args, r.asks, r.ok, r.keys, r.observed], [{ query: from.input.query }, [], true, [], []])
  }
  const seqs = w.journal().map((c) => c.seq)
  assert.equal(new Set(seqs).size, seqs.length)
})

test('web queries are search-wide', async (t) => {
  const w = world(t)
  const { ctx } = w.start({ [WEB]: [SEARCHED, stepOf(idle())], ...ruler(2, ['W', 'answered']) })
  const result = await search(ctx, webSpec())
  assert.deepEqual(result.queries.filter((c) => c.tool === 'websearch').map((c) => c.args.query).sort(), QUERIES.map((q) => q.query).sort())
  for (const [key, a] of Object.entries(result.asks)) {
    assert.ok(Array.isArray(a.looked), key + ': looked')
    assert.ok(!a.looked.some((e) => e.tool === 'websearch'), key + ': a web query is no ask\'s')
  }
})
