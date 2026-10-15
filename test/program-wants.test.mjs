// test/program-wants.test.mjs — pins wants: a prober or a survey judge that
// names ground it lacked reopens its program's own search with the want as a new ask, the
// navigator's session resumed; only the judges whose wants ended are dispatched again, for those
// units alone, and what they return for them replaces what they returned before; a want asked
// before adds nothing, so the loop ends.
//
// Design: docs/DESIGN.md#searches, docs/DESIGN.md#probe, docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sectionsOf, unitsOf } from '../lib/evidence.mjs'
import { probe } from '../lib/programs/probe.mjs'
import { survey } from '../lib/programs/survey.mjs'
import { EMPTY_GROUND, closingTurn, hitTurn, repoReturn, withGround } from './harness/navigator.mjs'
import { programRig } from './harness/program-rig.mjs'
import { ARGS, FILE, TOPIC, anchoredUnit, behaviour, endedRounds, plan, pool, rigFor, scouted } from './harness/survey-world.mjs'

const on = (rig, thread) => rig.calls.filter((c) => c.thread.key === thread)
const chargeOf = (call) => readFileSync(call.role.systemPromptFile, 'utf8')

// --- the probe's world -------------------------------------------------------------------------

const STANDING = ['ambiguity', 'invariants', 'yagni', 'reinvention']
const ART = 'docs/spec.md'
const DOC = ['# Limiter', '', '## Intent', 'limit inbound requests per key', '', '## Design', 'a token bucket per key, refilled each second'].join('\n') + '\n'
const BUCKET = 'src/bucket.js'
const PROBE_FILES = {
  [ART]: DOC,
  [BUCKET]: ['// bucket', 'export const BUCKET_STORE_TOKEN = new Map()', 'export const end = 1'].join('\n') + '\n',
}
const LOCATE = ['guidance', ...sectionsOf(DOC).map((s) => 'ground:' + s.slug)]
const WANT = 'WANT-where the token buckets are stored'
const UNIT = 'yagni@design'
const unitsOfAxis = (axis) => unitsOf([axis], sectionsOf(DOC))
const proberOut = (units, { findings = [], wants = [] } = {}) => ({
  findings, wants,
  units: units.map((unit) => ({ unit, ruling: findings.some((f) => f.axis + '@' + f.section === unit) ? 'findings' : 'clean', ids: [], why: 'why ' + unit })),
  notes: '', stop_reason: 'exhausted', not_reached: '',
})
const NEW = { axis: 'yagni', severity: 'note', section: 'design', claim: 'WANTED-FINDING the bucket store is a second map', evidence: 'line 7', start: 7, end: 7 }
const wantFound = (key = 'want:1') => hitTurn(key, [[BUCKET, 2, 'NOTE-the store']])
/** The locate search's first round: one closing turn, its asks ruled absent. */
const located = { turns: [closingTurn(LOCATE)], asks: LOCATE, ruling: 'absent' }
/** A locate round for want `key`: `turns` (default the want found), the want ruled `ruling`. */
const wanted = (key = 'want:1', turns = [wantFound(key)], ruling = 'answered') => ({ turns, asks: key, ruling })

/**
 * One prober per axis (per_axis), prober:n holding STANDING[n-1]; `probers[n]` replaces prober n's steps.
 * `locate` lists the locate search's rounds, each ended by the ruler (`endedRounds`).
 */
function probeScript({ locate, probers = {} }) {
  const s = endedRounds('scout', 'locate', locate)
  STANDING.forEach((axis, i) => { s['analyst||prober:' + (i + 1)] = probers[i + 1] || [{ output: proberOut(unitsOfAxis(axis)) }] })
  return s
}
async function probeIn(t, script) {
  const rig = programRig({ files: PROBE_FILES, script })
  t.after(() => rig.cleanup())
  const artifact = join(rig.repo, ...ART.split('/'))
  const result = await probe(rig.ctx, {
    artifact, artifact_text: readFileSync(artifact, 'utf8').replace(/\r\n/g, '\n').trim(), roots: ['.'], context: '', per_axis: true, since: '',
  })
  return { rig, result }
}
/** prober:3 holds yagni: it wants WANT for UNIT, then rules UNIT again with NEW. */
const wantingYagni = (second = proberOut([UNIT], { findings: [NEW] })) => [
  { output: proberOut(unitsOfAxis('yagni'), { wants: [{ unit: UNIT, want: WANT }] }) },
  { output: second },
]

// --- the probe ---------------------------------------------------------------------------------

test("a prober's want becomes a new ask on the probe's own search, its navigator session resumed", async (t) => {
  const { rig } = await probeIn(t, probeScript({ locate: [located, wanted()], probers: { 3: wantingYagni() } }))
  const calls = on(rig, 'locate')
  assert.equal(calls.length, 3, 'one more navigator turn after the closing turn and its stall, for the want')
  const [first, , second] = calls
  assert.ok(second.brief.includes('want:1'), 'the turn names the new ask')
  assert.ok(second.brief.includes(WANT) || chargeOf(second).includes(WANT), 'the navigator is told what the want asks')
  assert.equal(second.resume, true, 'the session is resumed')
  assert.equal(second.thread.session, first.thread.session, 'in the same session')
  assert.equal(second.thread.gen, first.thread.gen, 'not renewed')
})

test('only the prober whose want ended is dispatched again, for the wanted unit alone, with what the want found', async (t) => {
  const { rig } = await probeIn(t, probeScript({ locate: [located, wanted()], probers: { 3: wantingYagni() } }))
  for (const n of [1, 2, 4]) assert.equal(on(rig, 'prober:' + n).length, 1, 'prober:' + n + ' wanted nothing')
  const calls = on(rig, 'prober:3')
  assert.equal(calls.length, 2)
  const again = calls[1]
  assert.equal(again.resume, true, "the prober's own session")
  assert.equal(again.thread.session, calls[0].thread.session)
  assert.ok(again.brief.includes(UNIT), 'the wanted unit is to be ruled again')
  for (const other of unitsOfAxis('yagni').filter((u) => u !== UNIT)) assert.ok(!again.brief.includes(other), other + ' had no want')
  assert.ok(again.brief.includes('BUCKET_STORE_TOKEN'), 'the lines the want found')
})

test('what a prober returns for a wanted unit replaces what it returned first', async (t) => {
  const { result } = await probeIn(t, probeScript({ locate: [located, wanted()], probers: { 3: wantingYagni() } }))
  assert.ok(result.findings.some((f) => f.axis === 'yagni' && f.section === 'design'), "the second return's finding is recorded")
  assert.equal(result.findings.filter((f) => f.axis === 'yagni' && f.section === 'design').length, 1, 'recorded once')
  assert.deepEqual(result.units.open, [])
  assert.equal(result.units.ruled, result.units.total, 'every unit ruled, none ruled twice over')
  assert.ok(!result.coverage.declared.some((l) => l.startsWith('want 1: ended ')), 'a want that was answered is not declared short')
})

test('a prober whose second return wants something new opens want:2 and is dispatched a third time', async (t) => {
  const WANT_2 = 'WANT-where the refill timer is set'
  const again = proberOut([UNIT], { wants: [{ unit: UNIT, want: WANT_2 }] })
  const { rig, result } = await probeIn(t, probeScript({
    locate: [located, wanted(), wanted('want:2')],
    probers: { 3: [...wantingYagni(again), { output: proberOut([UNIT], { findings: [NEW] }) }] },
  }))
  const calls = on(rig, 'locate')
  assert.equal(calls.length, 5, 'a second want is a second turn, and its stall')
  assert.ok(calls[3].brief.includes('want:2'), 'the turn names the second ask')
  assert.ok(calls[3].brief.includes(WANT_2) || chargeOf(calls[3]).includes(WANT_2))
  assert.equal(calls[3].thread.session, calls[0].thread.session)
  assert.equal(on(rig, 'prober:3').length, 3)
  assert.ok(result.findings.some((f) => f.axis === 'yagni' && f.section === 'design'), "the third return's finding is recorded")
})

test('a want asked again adds nothing, and the probe ends', async (t) => {
  const repeat = proberOut([UNIT], { findings: [NEW], wants: [{ unit: UNIT, want: WANT }] })
  const { rig, result } = await probeIn(t, probeScript({ locate: [located, wanted()], probers: { 3: wantingYagni(repeat) } }))
  assert.equal(on(rig, 'locate').length, 3, 'no navigator turn after the want')
  assert.equal(on(rig, 'prober:3').length, 2, 'no third prober round')
  assert.ok(result.findings.length > 0)
})

test('two probers wanting one thing in one pass open one ask, and both rule again', async (t) => {
  const wantingAmbiguity = [
    { output: proberOut(unitsOfAxis('ambiguity'), { wants: [{ unit: 'ambiguity@design', want: WANT }] }) },
    { output: proberOut(['ambiguity@design']) },
  ]
  const { rig } = await probeIn(t, probeScript({ locate: [located, wanted()], probers: { 1: wantingAmbiguity, 3: wantingYagni() } }))
  const calls = on(rig, 'locate')
  assert.equal(calls.length, 3)
  assert.ok(!calls[2].brief.includes('want:2'), 'one want, one ask')
  assert.equal(on(rig, 'prober:1').length, 2)
  assert.equal(on(rig, 'prober:3').length, 2)
})

test('a want that ends short is declared, reaches the prober again, and leaves the probe complete', async (t) => {
  const nothingFound = { output: repoReturn({}) }
  const locate = [located, { ...wanted('want:1', [nothingFound], 'not_converging'), quiet: true }]
  const { rig, result } = await probeIn(t, probeScript({ locate, probers: { 3: wantingYagni(proberOut([UNIT])) } }))
  assert.equal(on(rig, 'prober:3').length, 2, 'the wanted unit is ruled again though the want found nothing')
  assert.ok(result.coverage.declared.some((l) => l.startsWith('want 1: ended ')), JSON.stringify(result.coverage.declared))
  assert.ok(!result.coverage.incomplete.includes('locate'), 'a short want leaves locate complete')
  for (const list of ['incomplete', 'unreached', 'failed_channels']) {
    assert.ok(!result.coverage[list].some((l) => l.startsWith('locate:want:')), list + ' holds no want line')
  }
  assert.equal(result.coverage.complete, true)
})

test("a want's ask is scoped to the whole tree in the repo domain, its own ground resolved from what it wants", async (t) => {
  const seen = []
  const rig = programRig({ files: PROBE_FILES, script: probeScript({ locate: [located, wanted()], probers: { 3: wantingYagni() } }) })
  t.after(() => rig.cleanup())
  const artifact = join(rig.repo, ...ART.split('/'))
  await probe(withGround(rig.ctx, EMPTY_GROUND, seen), {
    artifact, artifact_text: readFileSync(artifact, 'utf8').replace(/\r\n/g, '\n').trim(), roots: ['.'], context: '', per_axis: true, since: '',
  })
  const asks = rig.log.entries().filter((e) => e.kind === 'step' && /^locate\/asks:/.test(e.key)).flatMap((e) => e.value)
  assert.ok(asks.includes('want:1'), 'want:1 joined the search: ' + JSON.stringify(asks))
  const charge = chargeOf(on(rig, 'locate')[2])
  const own = seen.filter((o) => (o.material || []).some((m) => (m.asks || []).includes('want:1')))
  assert.equal(own.length, 1, "the want's ground is resolved once")
  assert.ok(own[0].material.every((m) => m.text.includes(WANT)), 'from what it wants alone')
  assert.deepEqual(own[0].scope, ['.'], 'under its scope')
  const spec = JSON.parse(readFileSync(JSON.parse(readFileSync(on(rig, 'locate')[2].mcpConfig, 'utf8')).mcpServers.search.args.at(-1), 'utf8'))
  const want = spec.asks.find((a) => a.key === 'want:1')
  assert.deepEqual({ scope: want.scope, domain: want.domain }, { scope: ['.'], domain: 'repo' })
  assert.ok(charge.includes(WANT) || on(rig, 'locate')[2].brief.includes(WANT))
})

test('a want naming a unit its prober was not handed opens no ask', async (t) => {
  const stray = [{ output: proberOut(unitsOfAxis('yagni'), { wants: [{ unit: 'ambiguity@design', want: WANT }] }) }]
  const { rig } = await probeIn(t, probeScript({ locate: [located], probers: { 3: stray } }))
  assert.equal(on(rig, 'locate').length, 2, 'the closing turn and its stall, no turn for a want')
  assert.equal(on(rig, 'prober:3').length, 1)
})

test("a probe's lost wants round is reported", async (t) => {
  const lostRound = [
    { output: proberOut(unitsOfAxis('yagni'), { wants: [{ unit: UNIT, want: WANT }] }) },
    { status: 'failed', cause: 'host_error' },
  ]
  const { rig, result } = await probeIn(t, probeScript({ locate: [located, wanted()], probers: { 3: lostRound } }))
  assert.equal(on(rig, 'locate').length, 3, 'the want was searched')
  assert.equal(on(rig, 'prober:3').length, 2, 'the prober was dispatched for its want')
  const lines = result.coverage.unreached.filter((l) => l.includes('did not return for its wants'))
  assert.equal(lines.length, 1, JSON.stringify(result.coverage.unreached))
  assert.match(lines[0], /3 did not return for its wants \(host_error\): its earlier items on .*yagni@design.* stand$/, 'the judgeLines line')
  assert.ok(lines[0].startsWith('prober'), 'labelled as a prober: ' + lines[0])
  assert.equal(result.coverage.complete, false)
})

// --- the survey --------------------------------------------------------------------------------

const WANT_L = 'WANT-where a module path falls back'
const LOADER_CLAIM = 'CLAIM-loader falls back at line 30'
const STORE_CLAIM = 'CLAIM-store writes at line 9'
const loaderFound = { turns: [hitTurn('loader', [[FILE.loader, 7]])], asks: 'loader' }
const fallbackFound = { turns: [hitTurn('want:1', [[FILE.loader, 30, 'NOTE-the fallback']])], asks: 'want:1' }
/**
 * One judge holds loader and store; loader's search runs again for the judge's want. `loader` lists
 * the loader search's rounds, each ended by the ruler (`endedRounds`).
 */
const surveyScript = (judge, loader = [loaderFound, fallbackFound]) => ({
  'analyst||plan': [{ output: plan({ topics: [TOPIC.loader, TOPIC.store] }) }],
  ...endedRounds('scout', 'scout:loader', loader),
  ...scouted('store', [hitTurn('store', [[FILE.store, 9]])]),
  'analyst||judge:1': judge,
})
const firstJudge = { output: {
  items: [behaviour('store', STORE_CLAIM, 9)], risks: [],
  units: [{ unit: 'loader', ruling: 'unanchored', ids: [], why: 'the fallback was not located' }, anchoredUnit('store')],
  wants: [{ unit: 'loader', want: WANT_L }],
} }
const secondJudge = (wants = []) => ({ output: { items: [behaviour('loader', LOADER_CLAIM, 30)], risks: [], units: [anchoredUnit('loader')], wants } })

async function surveyIn(t, script) {
  const rig = rigFor(t, script)
  const result = await survey(rig.ctx, ARGS())
  return { rig, result }
}

test('a want that ends short in a survey is declared and leaves its topic complete', async (t) => {
  const nothingFound = { turns: [{ output: repoReturn({}) }], asks: 'want:1', ruling: 'not_converging', quiet: true }
  const { rig, result } = await surveyIn(t, surveyScript([firstJudge, secondJudge()], [loaderFound, nothingFound]))
  assert.equal(on(rig, 'judge:1').length, 2, 'the wanted topic is judged again though the want found nothing')
  assert.ok(result.coverage.declared.some((l) => l.startsWith('want 1: ended ')), JSON.stringify(result.coverage.declared))
  for (const list of ['incomplete', 'unreached', 'failed_channels']) {
    assert.ok(!result.coverage[list].some((l) => l.startsWith('scout:loader:want:')), list + ' holds no want line')
  }
  assert.ok(!result.coverage.incomplete.includes('loader'))
})

test('a judge whose wants round does not return leaves an unreached line and the survey incomplete', async (t) => {
  const { rig, result } = await surveyIn(t, surveyScript([firstJudge, { status: 'failed', cause: 'host_error' }]))
  assert.equal(on(rig, 'scout:loader').length, 3, 'the want was searched')
  const line = result.coverage.unreached.find((l) => l.startsWith('judge 1 did not return for its wants'))
  assert.ok(line, JSON.stringify(result.coverage.unreached))
  assert.ok(line.includes('loader'), 'the line names the topic whose second look never happened')
  assert.equal(result.coverage.complete, false)
})

test("a survey judge's want reopens its topic's search, its navigator session resumed", async (t) => {
  const { rig } = await surveyIn(t, surveyScript([firstJudge, secondJudge()]))
  const calls = on(rig, 'scout:loader')
  assert.equal(calls.length, 3, 'its turn, the stall, and the turn for the want')
  assert.ok(calls[2].brief.includes('want:1'))
  assert.ok(calls[2].brief.includes(WANT_L) || chargeOf(calls[2]).includes(WANT_L))
  assert.equal(calls[2].resume, true)
  assert.equal(calls[2].thread.session, calls[0].thread.session)
  assert.equal(on(rig, 'scout:store').length, 2, 'a topic nobody wanted more of is not searched again')
})

test('the judge is dispatched again for the wanted topic alone, with what the want found', async (t) => {
  const { rig } = await surveyIn(t, surveyScript([firstJudge, secondJudge()]))
  const calls = on(rig, 'judge:1')
  assert.equal(calls.length, 2)
  const again = calls[1]
  assert.equal(again.resume, true)
  assert.ok(again.brief.includes('loader'), 'the wanted topic is to be judged again')
  assert.ok(!again.brief.includes(TOPIC.store.find), 'the topic nobody wanted more of is not')
  assert.ok(again.brief.includes('alpha line 30'), 'the lines the want found')
})

test("what the judge returns for a wanted topic is recorded beside its first return's other topics", async (t) => {
  const { rig, result } = await surveyIn(t, surveyScript([firstJudge, secondJudge()]))
  const claims = pool(rig).map((it) => it.claim)
  assert.ok(claims.includes(LOADER_CLAIM), "the wanted topic's item")
  assert.ok(claims.includes(STORE_CLAIM), "the first return's item for the other topic")
  assert.ok(!result.coverage.incomplete.includes('loader'), 'the wanted topic is anchored now')
})

test('a judge whose second return wants something new opens want:2 and is dispatched a third time', async (t) => {
  const WANT_2 = 'WANT-where the fallback is logged'
  const logFound = { turns: [hitTurn('want:2', [[FILE.loader, 31, 'NOTE-the log']])], asks: 'want:2' }
  const script = surveyScript([firstJudge, secondJudge([{ unit: 'loader', want: WANT_2 }]), secondJudge()], [loaderFound, fallbackFound, logFound])
  const { rig } = await surveyIn(t, script)
  const calls = on(rig, 'scout:loader')
  assert.equal(calls.length, 5, 'a second want is a second turn, and its stall')
  assert.ok(calls[3].brief.includes('want:2'))
  assert.ok(calls[3].brief.includes(WANT_2) || chargeOf(calls[3]).includes(WANT_2))
  assert.equal(calls[3].thread.session, calls[0].thread.session)
  assert.equal(on(rig, 'judge:1').length, 3)
})

test("a judge's want asked again adds nothing, and the survey ends", async (t) => {
  const { rig } = await surveyIn(t, surveyScript([firstJudge, secondJudge([{ unit: 'loader', want: WANT_L }])]))
  assert.equal(on(rig, 'scout:loader').length, 3, 'no navigator turn after the want')
  assert.equal(on(rig, 'judge:1').length, 2, 'no third judge round')
})
