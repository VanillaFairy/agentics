// test/fast/search.test.mjs — one search over the real runner and a scripted host: its result read
// from the journal, its ends, its budget, its renewals and resumes, its server specs, and the charge,
// brief and coverage lines built for it.
//
// Design: docs/DESIGN.md#searches.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { STOP_LINE, callLines, resumeBrief, roundBrief, scoutCharge } from '../../lib/briefs/search.mjs'
import { renderMessage } from '../../lib/conversation.mjs'
import { programContext } from '../../lib/programs/common.mjs'
import { budgetOf, coverageLine, searchComplete, searchCoverage } from '../../lib/programs/search/consume.mjs'
import { ROLE_OF, search } from '../../lib/programs/search/search.mjs'
import { loadRole } from '../../lib/roles.mjs'
import { STALL_WINDOW, mcpConfigFor, openCalls, searchDir } from '../../lib/search/server.mjs'
import { dispatchKey } from '../../lib/store.mjs'
import { memoryLog } from './harness/memory-log.mjs'
import { closingRound, grepRecord, hitRecord, hitTurn, scoutStep, stalledRecord } from './harness/scout.mjs'
import { scriptedRunner } from './harness/scripted-runner.mjs'

const RUN = '20260101-000000-test'
const NOW = () => '2026-01-01T00:00:00.000Z'
const CUT_OFF = renderMessage({ msg: 'cut_off' })
const A = { path: 'src/a.mjs', line: 3, note: 'the adder' }
const B = { path: 'src/b.mjs', line: 7, note: 'the caller' }
const valueAfter = (args, flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }

/** A run over a scratch directory and the scripted runner; `again(script)` is the same run relaunched on its log. */
function rig(t, script) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-search-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = memoryLog()
  const tree = { root: dir.split('\\').join('/'), sha: 'test' }
  const make = (s) => {
    const runner = scriptedRunner(s, { log, now: NOW })
    const ctx = programContext({ intelligence: 'normal', repo: dir, run: RUN, dir, log, runAgent: runner.runAgent, now: NOW, sleep: async () => {}, env: {} })
    return { ctx, runner }
  }
  const first = make(script)
  return { dir, tree, log, ...first, again: make }
}

const repo = (r, over = {}) => search(r.ctx, { name: 'locate', domain: 'repo', find: 'where TOKEN is', tree: r.tree, ...over })

// ------------------------------------------------------------------ the result

test("a search whose scout returns is done, its hits the journal's", async (t) => {
  const r = rig(t, { 'scout||locate': [hitTurn([A, B]), closingRound('found both')] })
  const out = await repo(r)
  assert.equal(out.status, 'done')
  assert.equal(out.why, '')
  assert.equal(out.summary, 'found both')
  assert.deepEqual(out.hits, [A, B])
})

test('a finding only in the summary is not a hit', async (t) => {
  const r = rig(t, { 'scout||locate': [scoutStep({ summary: 'src/a.mjs:3 is the adder' })] })
  const out = await repo(r)
  assert.deepEqual(out.hits, [])
})

test('two hits on one line are one hit', async (t) => {
  const r = rig(t, { 'scout||locate': [scoutStep({ hits: [A, { ...A, note: 'again' }] }), closingRound()] })
  assert.deepEqual((await repo(r)).hits, [A])
})

test('two hits on one commit are one hit', async (t) => {
  const c = { commit: 'a'.repeat(40), note: 'the change' }
  const r = rig(t, { [ROLE_OF.history + '||history']: [scoutStep({ hits: [c, { ...c, note: 'again' }] }), closingRound()] })
  const out = await search(r.ctx, { name: 'history', domain: 'history', find: 'when', tree: r.tree })
  assert.deepEqual(out.hits, [c])
})

test('two hits on one page, spelled two ways, are one hit', async (t) => {
  const u = { url: 'https://example.com/docs', note: 'the docs' }
  const r = rig(t, { 'doc-researcher||research': [scoutStep({ hits: [u, { url: 'https://EXAMPLE.com/docs#intro', note: 'again' }] }), closingRound()] })
  const out = await search(r.ctx, { name: 'research', domain: 'web', find: 'docs', tree: r.tree })
  assert.deepEqual(out.hits, [u])
})

test('one candidate reached by two names is one hit', async (t) => {
  const candidate = { name: 'Left-Pad', source_url: 'https://github.com/x/left-pad', what_it_is: 'a pad', latest_version: '1', license: 'MIT', maintenance: 'active', covers: 'pads', does_not_cover: 'trims' }
  const one = { url: 'https://github.com/x/left-pad', note: 'it', candidate }
  const two = { url: 'https://npmjs.com/left-pad', note: 'it again', candidate: { ...candidate, name: 'left-pad' } }
  const r = rig(t, { 'doc-researcher||research': [scoutStep({ hits: [one, two] }), closingRound()] })
  const out = await search(r.ctx, { name: 'research', domain: 'web', find: 'a pad', tree: r.tree })
  assert.deepEqual(out.hits, [one])
})

test("calls are the journal's call lines, hits left out", async (t) => {
  const r = rig(t, { 'scout||locate': [hitTurn([A]), closingRound()] })
  const out = await repo(r)
  assert.deepEqual(out.calls, ['grep TOKEN → 1 found'])
})

// ------------------------------------------------------------------ how it ends

test('a search whose guard fired is stalled', async (t) => {
  const r = rig(t, { 'scout||locate': [scoutStep({ calls: [grepRecord([]), stalledRecord()] })] })
  const out = await repo(r)
  assert.equal(out.status, 'stalled')
  assert.equal(out.why, 'nothing new in the last ' + STALL_WINDOW + ' calls')
})

test('a search stopped at its budget ends budget', async (t) => {
  const r = rig(t, { 'scout||locate': [{ status: 'failed', cause: 'budget', cost_total: 1.02 }] })
  const out = await repo(r, { budget: 1 })
  assert.equal(out.status, 'budget')
  assert.equal(out.why, 'spent $1.02 of its $1 budget')
  assert.equal(out.cost, 1.02)
})

const spent = (r, usd) => r.log.append('returned', { dispatch: dispatchKey({ node: '', role: 'scout', thread: 'locate', round: 1 }), session: 'older', status: 'failed', cause: 'host_error', usage: null, cost_total: usd, cost_usd: usd, denials: [] })

test('the budget passed is what is left of it', async (t) => {
  const r = rig(t, { 'scout||locate': [scoutStep()] })
  spent(r, 0.25)
  await repo(r, { budget: 1 })
  assert.equal(valueAfter(r.runner.starts[0].args, '--max-budget-usd'), '0.75')
})

test('a search with nothing left of its budget starts nothing', async (t) => {
  const r = rig(t, { 'scout||locate': [scoutStep()] })
  spent(r, 1)
  const out = await repo(r, { budget: 1 })
  assert.equal(r.runner.starts.length, 0)
  assert.equal(out.status, 'budget')
})

test('a search the host failed is failed', async (t) => {
  const r = rig(t, { 'scout||locate': [{ status: 'failed', cause: 'host_error' }] })
  const out = await repo(r)
  assert.equal(out.status, 'failed')
  assert.ok(out.why.startsWith('host_error'), out.why)
})

test('a budget is a positive search_budget, else none', () => {
  assert.equal(budgetOf({ search_budget: 0 }), null)
  assert.equal(budgetOf({}), null)
  assert.equal(budgetOf({ search_budget: 1.5 }), 1.5)
})

// ------------------------------------------------------------------ renewals, resumes and replays

test('a renewed session is briefed with the hits journaled before it', async (t) => {
  const r = rig(t, { 'scout||locate': [{ status: 'failed', cause: 'context_exceeded', calls: [hitRecord(A)] }, scoutStep({ hits: [B] }), closingRound()] })
  const out = await repo(r)
  const [first, second] = r.runner.starts
  assert.notEqual(second.session, first.session)
  assert.ok(second.stdin.includes('src/a.mjs:3 — the adder'), second.stdin)
  assert.deepEqual(out.hits, [A, B])
})

test('a returned search replays', async (t) => {
  const r = rig(t, { 'scout||locate': [hitTurn([A]), closingRound()] })
  const out = await repo(r)
  const again = r.again({})
  const replay = await search(again.ctx, { name: 'locate', domain: 'repo', find: 'where TOKEN is', tree: r.tree })
  assert.equal(again.runner.starts.length, 0)
  assert.deepEqual(replay, out)
})

test('a search cut off mid-session resumes it with nothing re-sent', async (t) => {
  const r = rig(t, { 'scout||locate': [{ status: 'failed', cause: 'host_error', calls: [hitRecord(A)] }] })
  await repo(r)
  const again = r.again({ 'scout||locate': [scoutStep({ hits: [B] }), closingRound()] })
  const out = await search(again.ctx, { name: 'locate', domain: 'repo', find: 'where TOKEN is', tree: r.tree })
  const [start] = again.runner.starts
  assert.equal(valueAfter(start.args, '--resume'), r.runner.starts[0].session)
  assert.equal(start.stdin, CUT_OFF)
  assert.deepEqual(out.hits, [A, B])
})

test('a renewal with no journal on disk gets the opening brief', async (t) => {
  const r = rig(t, { 'scout||locate': [{ status: 'failed', cause: 'host_error', calls: [hitRecord(A)] }] })
  await repo(r)
  rmSync(join(searchDir(r.dir, 'locate'), 'calls.jsonl'))
  const again = r.again({ 'scout||locate': [scoutStep()] })
  await search(again.ctx, { name: 'locate', domain: 'repo', find: 'something else', tree: r.tree })
  const [start] = again.runner.starts
  assert.equal(start.resume, false)
  assert.ok(start.stdin.endsWith(resumeBrief([])), start.stdin)
})

test('a changed find starts a new session briefed with the journal', async (t) => {
  const r = rig(t, { 'scout||locate': [{ status: 'failed', cause: 'host_error', calls: [hitRecord(A)] }] })
  await repo(r)
  const again = r.again({ 'scout||locate': [scoutStep({ hits: [B] }), closingRound()] })
  const out = await search(again.ctx, { name: 'locate', domain: 'repo', find: 'something else', tree: r.tree })
  const [start] = again.runner.starts
  assert.equal(start.resume, false)
  assert.notEqual(start.session, r.runner.starts[0].session)
  assert.ok(start.stdin.includes('src/a.mjs:3 — the adder'), start.stdin)
  assert.deepEqual(out.hits, [A, B])
})

// ------------------------------------------------------------------ rounds

const C = { path: 'src/c.mjs', line: 1, note: 'the third' }
const D = { path: 'src/d.mjs', line: 2, note: 'the fourth' }
const callsIn = (r) => openCalls(join(searchDir(r.dir, 'locate'), 'calls.jsonl'))

test('the opening and every search role carry one stop line, which says nothing of pages', () => {
  const words = (text) => text.split(/\s+/).filter(Boolean).join(' ')
  assert.ok(resumeBrief([]).endsWith(STOP_LINE))
  for (const role of ['scout', 'historian', 'doc-researcher']) assert.ok(words(loadRole(role).role.prompt).includes(STOP_LINE), role)
  assert.ok(!STOP_LINE.includes('page'), STOP_LINE)
  assert.ok(STOP_LINE.includes('as soon as a tool shows it relevant'), STOP_LINE)
})

test('a round that widened the search is followed by a fresh round briefed with the hits so far', async (t) => {
  const r = rig(t, { 'scout||locate': [hitTurn([A, B]), scoutStep({ hits: [C] }), closingRound()] })
  const out = await repo(r)
  const [first, second] = r.runner.starts
  assert.equal(second.resume, false)
  assert.notEqual(second.session, first.session)
  assert.ok(second.stdin.endsWith(roundBrief(callsIn(r).filter((c) => c.session === first.session))), second.stdin)
  assert.ok(second.stdin.includes('- src/a.mjs:3 — the adder'), second.stdin)
  assert.deepEqual(out.hits, [A, B, C])
})

test('the search ends on the first round that adds no new hit', async (t) => {
  const r = rig(t, { 'scout||locate': [hitTurn([A, B]), scoutStep({ hits: [{ ...A, note: 'again' }] }), scoutStep({ hits: [C] })] })
  const out = await repo(r)
  assert.equal(r.runner.starts.length, 2)
  assert.equal(out.status, 'done')
  assert.deepEqual(out.hits, [A, B])
})

test('a round whose hits all land in files earlier rounds hit ends the search', async (t) => {
  const r = rig(t, { 'scout||locate': [hitTurn([A, B]), scoutStep({ hits: [{ ...A, line: 9, note: 'a re-check' }] }), scoutStep({ hits: [C] })] })
  const out = await repo(r)
  assert.equal(r.runner.starts.length, 2)
  assert.equal(out.status, 'done')
  assert.deepEqual(out.rounds.map((x) => x.added), [2, 0])
  assert.deepEqual(out.hits, [A, B, { ...A, line: 9, note: 'a re-check' }])
})

test('a round that hits one new file ends the search', async (t) => {
  const r = rig(t, { 'scout||locate': [hitTurn([A]), scoutStep({ hits: [B] })] })
  const out = await repo(r)
  assert.equal(r.runner.starts.length, 1)
  assert.equal(out.status, 'done')
  assert.deepEqual(out.hits, [A])
})

test('a round whose scout declares nothing unsearched ends the search', async (t) => {
  const r = rig(t, { 'scout||locate': [hitTurn([A, B], { unsearched: [] }), scoutStep({ hits: [C, D] })] })
  const out = await repo(r)
  assert.equal(r.runner.starts.length, 1)
  assert.equal(out.status, 'done')
  assert.deepEqual(out.coverage, { rounds: 1, last_added: 2, skipped: '' })
})

test('a stalled round that declares nothing unsearched still earns another when it widened the search', async (t) => {
  const r = rig(t, { 'scout||locate': [scoutStep({ calls: [grepRecord([[A.path, A.line], [B.path, B.line]]), stalledRecord()], hits: [A, B], unsearched: [] }), closingRound()] })
  await repo(r)
  assert.equal(r.runner.starts.length, 2)
})

test('a later round is briefed with where the last one did not look', async (t) => {
  const r = rig(t, { 'scout||locate': [hitTurn([A, B], { unsearched: ['vendor/', 'the CLI entry'] }), closingRound()] })
  await repo(r)
  const second = r.runner.starts[1]
  assert.ok(second.stdin.includes(['## Where the last round did not look', '', '- vendor/', '- the CLI entry'].join('\n')), second.stdin)
})

test('a dollar budget stops the search in a later round', async (t) => {
  const r = rig(t, { 'scout||locate': [{ ...hitTurn([A, B]), cost_total: 0.6 }, { status: 'failed', cause: 'budget', cost_total: 0.5 }, closingRound()] })
  const out = await repo(r, { budget: 1 })
  assert.equal(r.runner.starts.length, 2)
  assert.equal(valueAfter(r.runner.starts[1].args, '--max-budget-usd'), '0.4')
  assert.equal(out.status, 'budget')
  assert.equal(out.cost, 1.1)
  assert.deepEqual(out.hits, [A, B])
})

test('a relaunch mid-round resumes that round with nothing re-sent, the finished rounds kept', async (t) => {
  const r = rig(t, { 'scout||locate': [hitTurn([A, B]), { status: 'failed', cause: 'host_error', calls: [hitRecord(C), hitRecord(D)] }] })
  await repo(r)
  const [first, second] = r.runner.starts
  const again = r.again({ 'scout||locate': [scoutStep(), closingRound()] })
  const out = await search(again.ctx, { name: 'locate', domain: 'repo', find: 'where TOKEN is', tree: r.tree })
  const [resumed] = again.runner.starts
  assert.equal(valueAfter(resumed.args, '--resume'), second.session)
  assert.equal(resumed.stdin, CUT_OFF)
  assert.deepEqual(callsIn(r).filter((c) => c.tool === 'hit').map((c) => [c.session, c.hit]),
    [[first.session, A], [first.session, B], [second.session, C], [second.session, D]])
  assert.deepEqual(out.hits, [A, B, C, D])
  assert.equal(out.coverage.rounds, 3)
})

test('coverage carries the rounds run, what the last added and where the scout says it did not look', async (t) => {
  const r = rig(t, { 'scout||locate': [{ ...hitTurn([A, B]), cost_total: 0.25 }, { ...scoutStep({ hits: [C, D] }), cost_total: 0.5 }, scoutStep({ unsearched: ['docs/', 'vendor/'] })] })
  const out = await repo(r)
  assert.deepEqual(out.coverage, { rounds: 3, last_added: 0, skipped: 'docs/; vendor/' })
  assert.deepEqual(out.rounds, [{ added: 2, cost: 0.25 }, { added: 2, cost: 0.5 }, { added: 0, cost: 0 }])
})

test('coverage of a search the budget stopped names what its last round added', async (t) => {
  const r = rig(t, { 'scout||locate': [{ ...hitTurn([A, B]), cost_total: 0.6 }, { status: 'failed', cause: 'budget', cost_total: 0.5, calls: [hitRecord(C)] }] })
  const out = await repo(r, { budget: 1 })
  assert.deepEqual(out.coverage, { rounds: 2, last_added: 1, skipped: '' })
})

// ------------------------------------------------------------------ server specs, WebSearch, pages

/** The server specs a search's directory holds. */
const specsOf = (dir, thread) => readdirSync(searchDir(dir, thread)).filter((f) => f.startsWith('server-'))
  .map((f) => JSON.parse(readFileSync(join(searchDir(dir, thread), f), 'utf8')))

test('each session gets a server spec naming it', async (t) => {
  const r = rig(t, { 'scout||locate': [{ status: 'failed', cause: 'context_exceeded' }, scoutStep()] })
  const out = await repo(r)
  const sessions = r.runner.starts.map((s) => s.session)
  assert.deepEqual(specsOf(r.dir, 'locate').map((s) => s.session).sort(), [...sessions].sort())
  assert.deepEqual(out.sessions.map((s) => s.session), sessions)
})

test("one session's server spec is one file, another session's another", async (t) => {
  const r = rig(t, {})
  const spec = (session) => ({ tree: r.tree, scope: ['.'], labels: [], tools: ['grep'], calls: 'c', pages: 'p', session })
  const one = mcpConfigFor(r.dir, 'locate', spec('s1'))
  assert.equal(mcpConfigFor(r.dir, 'locate', spec('s1')), one)
  assert.notEqual(mcpConfigFor(r.dir, 'locate', spec('s2')), one)
  assert.equal(specsOf(r.dir, 'locate').length, 2)
})

test('a host WebSearch joins the journal once', async (t) => {
  const r = rig(t, { 'doc-researcher||research': [{ ...scoutStep(), webSearches: [{ query: 'left pad' }] }] })
  const args = { name: 'research', domain: 'web', find: 'a pad', tree: r.tree }
  const out = await search(r.ctx, args)
  await search(r.again({}).ctx, args)
  const records = openCalls(join(searchDir(r.dir, 'research'), 'calls.jsonl')).filter((c) => c.tool === 'websearch')
  assert.equal(records.length, 1)
  assert.equal(records[0].session, r.runner.starts[0].session)
  assert.deepEqual(out.calls, ['websearch left pad → run'])
})

test('every search of a run pins pages in one place', async (t) => {
  const r = rig(t, { 'scout||locate': [scoutStep()], 'doc-researcher||research': [scoutStep()] })
  const one = await repo(r)
  const two = await search(r.ctx, { name: 'research', domain: 'web', find: 'a pad', tree: r.tree })
  assert.equal(one.pages, join(r.dir, 'pages'))
  assert.equal(two.pages, one.pages)
  assert.deepEqual([...specsOf(r.dir, 'locate'), ...specsOf(r.dir, 'research')].map((s) => s.pages), [one.pages, one.pages])
})

// ------------------------------------------------------------------ the charge and the brief

test('the charge holds what to find, where, the labels and the material as data', () => {
  const text = scoutCharge({ domain: 'repo', find: 'where TOKEN is', scope: ['src', 'lib'], labels: ['ground', 'guidance'], material: [{ label: 'The spec', text: 'spec body' }] })
  assert.ok(text.includes('hit, which records a finding'))
  assert.ok(text.includes('## Find\n\nwhere TOKEN is'))
  assert.ok(text.includes('Scope: src, lib'))
  assert.ok(!text.includes('Subject:'), 'a subject that is the scope goes unsaid')
  const narrowed = scoutCharge({ domain: 'repo', find: 'x', scope: ['src'], subject: ['src/game'] })
  assert.ok(narrowed.includes('Scope: src\n'), narrowed)
  assert.ok(narrowed.includes('Subject: src/game'), narrowed)
  assert.ok(text.includes('Labels: every hit carries one of `ground`, `guidance`.'))
  assert.ok(text.includes('### The spec\n\n~~~~text\nspec body\n~~~~'))
  const web = scoutCharge({ domain: 'web', find: 'a pad' })
  assert.ok(!web.includes('Scope:'))
  assert.ok(!web.includes('Labels:'))
  assert.ok(!web.includes('## Material'))
})

test('material holding a fence is fenced longer', () => {
  const text = scoutCharge({ domain: 'repo', find: 'x', material: [{ label: 'M', text: 'a\n~~~~\nb' }] })
  assert.ok(text.includes('~~~~~text\na\n~~~~\nb\n~~~~~'), text)
})

test('the resume brief lists the hits and calls the journal holds', () => {
  const opening = resumeBrief([])
  assert.ok(opening.startsWith('Search for what your charge asks.'))
  const records = [grepRecord([['src/a.mjs', 3]]), hitRecord(A), hitRecord({ commit: 'abc', note: 'the change', label: 'history' })]
  const text = resumeBrief(records)
  assert.ok(text.includes('- src/a.mjs:3 — the adder'))
  assert.ok(text.includes('- commit abc — the change [history]'))
  for (const line of callLines(records)) assert.ok(text.includes('- ' + line), line)
  assert.ok(text.endsWith(opening))
})

// ------------------------------------------------------------------ coverage

const result = (name, status, calls, hits, why = '') => ({ name, status, why, calls: Array(calls).fill('c'), hits: Array(hits).fill(A) })

test('a coverage line names the search, its status, its counts and why', () => {
  assert.equal(coverageLine(result('locate', 'done', 41, 23)), 'locate: done, 41 calls, 23 hits')
  assert.equal(coverageLine(result('scout:loader', 'done', 1, 0)), 'scout:loader: done, 1 call, no hits')
  assert.equal(coverageLine(result('history', 'stalled', 30, 2, 'nothing new in the last 12 calls')), 'history: stalled, 30 calls, 2 hits: nothing new in the last 12 calls')
  assert.equal(coverageLine(result('research:crates', 'budget', 7, 1, 'spent $1.02 of its $1 budget')), 'research:crates: budget, 7 calls, 1 hit: spent $1.02 of its $1 budget')
  assert.equal(coverageLine(result('repo', 'failed', 0, 0, 'host_error: exit 1')), 'repo: failed, 0 calls, no hits: host_error: exit 1')
})

const covered = (r, rounds, last_added, skipped) => ({ ...r, coverage: { rounds, last_added, skipped } })

test('a coverage line carries its rounds, what the last added, and the scout\'s own word', () => {
  assert.equal(coverageLine(covered(result('locate', 'done', 41, 23), 11, 0, 'did not open the vendored tree')),
    "locate: done, 41 calls, 23 hits, 11 rounds (the last added 0); the scout's own word: did not open the vendored tree")
  assert.equal(coverageLine(covered(result('research:crates', 'budget', 7, 1, 'spent $1.02 of its $1 budget'), 1, 1, '')),
    'research:crates: budget, 7 calls, 1 hit, 1 round (the last added 1): spent $1.02 of its $1 budget')
  assert.equal(coverageLine(covered(result('repo', 'done', 3, 0), 2, 0, 'skipped\n  the docs')),
    "repo: done, 3 calls, no hits, 2 rounds (the last added 0); the scout's own word: skipped the docs")
})

test('search coverage files each status where it belongs', () => {
  const rs = [result('a', 'done', 1, 1), result('b', 'stalled', 2, 0, 'w'), result('c', 'budget', 3, 0, 'x'), result('d', 'failed', 0, 0, 'y'), null]
  assert.deepEqual(searchCoverage(rs), {
    declared: [coverageLine(rs[0]), coverageLine(rs[1])],
    incomplete: ['c'],
    failed_channels: ['d'],
    unreached: [coverageLine(rs[2]), coverageLine(rs[3])],
  })
  assert.deepEqual(rs.slice(0, 4).map(searchComplete), [true, true, false, false])
})
