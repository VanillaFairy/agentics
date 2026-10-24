// test/program-probe-narrow.test.mjs — pins the probe's narrowed round: given `since`, the snapshot the
// last review judged, it attacks only the changed parts of the sections, earns its head count from
// those lines alone, tells each prober the changed ranges and the carried claims, lists the carried findings
// first and records only its new ones; an artefact unchanged since `since` buys no agent; a `since`
// that names no intact snapshot probes in full; relaunches and the read-back through
// `approval.mjs reviewed --from-run`.
//
// Design: docs/DESIGN.md#probe, docs/DESIGN.md#the-drift-ladder.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { recordDisposition, reviewedFromResult } from '../lib/approval.mjs'
import { carriedFindings, changedParts, liveItems, recordProbe, reviewScope, sectionsOf, unitsOf } from '../lib/evidence.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { locateMaterial, probe } from '../lib/programs/probe.mjs'
import { evidenceReturnsDir, evidenceSnapshotsDir } from '../lib/store.mjs'
import { closedSearch, closingRound, hitTurn } from './fast/harness/scout.mjs'
import { programRig } from './harness/program-rig.mjs'

const STANDING = ['ambiguity', 'invariants', 'yagni', 'reinvention']
const ART = 'docs/spec.md'
const DOC = [
  '# Limiter',
  '',
  '## Intent',
  'limit inbound requests per key',
  'callers see a retry hint',
  '',
  '## Risks',
  'a burst may starve other keys',
  'the refill clock may drift',
  '',
  '## Design',
  'a token bucket per key, refilled each second',
].join('\n') + '\n'
/** DOC with line `n` (1-based) replaced. */
const editLine = (text, n, line) => {
  const lines = text.split('\n')
  lines[n - 1] = line
  return lines.join('\n')
}
const EDITED = editLine(DOC, 9, 'the refill clock may drift under load')


const native = (root, path) => join(root, ...path.split('/'))
const textOf = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim()
/** The arguments as lib/run.mjs resolves them for `--artifact <path>`. */
const argsFor = (root, path, over = {}) => ({
  artifact: native(root, path), artifact_text: textOf(native(root, path)), roots: ['.'], context: '', per_axis: false, since: '', ...over,
})
const linesOf = (text) => text.trim().split('\n')

// --- returns as the agents give them -----------------------------------------------------------

/** The locate script: one scout session that finds nothing. */
const LOCATE = () => closedSearch({ name: 'locate' })
const finding = (axisKey, severity, section, start, claim) => ({
  axis: axisKey, severity, section, claim, evidence: 'line ' + start, start, end: start,
})
/** A prober's return ruling every unit it is handed; a unit a finding sits on is ruled `findings`. */
const proberOut = (units, findings = []) => ({
  findings,
  units: units.map((unit) => ({
    unit, ruling: findings.some((f) => f.axis + '@' + f.section === unit) ? 'findings' : 'clean', ids: [], why: 'why ' + unit,
  })),
  notes: '', stop_reason: 'exhausted', not_reached: '',
})
const FAIL = { status: 'failed', cause: 'host_error' }

// The last review's findings on DOC: one on the line EDITED changes (9), the others on lines it leaves.
const NOTE = finding('yagni', 'note', 'intent', 4, 'CARRIED_NOTE_TOKEN the key is never defined')
const AMBIGUITY = finding('ambiguity', 'ambiguity', 'intent', 5, 'CARRIED_AMBIGUITY_TOKEN which hint the callers see')
const ON_CHANGED = finding('invariants', 'gap', 'risks', 9, 'SUSPECT_GAP_TOKEN drift is never bounded')
const GAP = finding('reinvention', 'gap', 'design', 12, 'CARRIED_GAP_TOKEN a token bucket exists already')
const LAST = [NOTE, AMBIGUITY, ON_CHANGED, GAP]
const NEW = finding('invariants', 'gap', 'risks', 9, 'NEW_FINDING_TOKEN load is never defined')

// --- what a round is expected to buy, by the rule ----------------------------------------------

/** The head count: one per 400 lines however many axes; never more than the axes. */
const headsFor = (keys, lines, perAxis) =>
  (perAxis ? keys.length : Math.min(keys.length, Math.max(1, Math.ceil(lines / 400))))
/** The axes dealt round-robin: group i holds the axes whose index is i mod n. */
const deal = (keys, n) => Array.from({ length: n }, (_, i) => keys.filter((_, j) => j % n === i))
/** The changed lines a narrowed scope earns its head count by. */
const changedLines = (changed) => changed.reduce((n, r) => n + r.end - r.start + 1, 0)

/**
 * What a narrowed round of `text` over `keys` buys, given the scope `reviewScope(repo, file, since)`
 * returns: the changed parts of the sections, the probers' groups and units, and a script giving
 * each prober's steps (`probers[n](units)`, default every unit ruled clean).
 */
function narrowed(text, scope, { keys = STANDING, perAxis = false, probers = {}, locate = LOCATE() } = {}) {
  const touched = changedParts(sectionsOf(text), scope.changed)
  const groups = deal(keys, headsFor(keys, changedLines(scope.changed), perAxis))
  const unitsOfGroup = groups.map((g) => unitsOf(g, touched))
  const script = { ...locate }
  unitsOfGroup.forEach((units, i) => {
    script['analyst||prober:' + (i + 1)] = probers[i + 1] ? probers[i + 1](units) : [{ output: proberOut(units) }]
  })
  return { touched, groups, unitsOfGroup, script }
}

/** A full round's script: every axis against every section, the probers ruling what they are handed. */
function fullScript(text, { keys = STANDING, findings = [] } = {}) {
  const sections = sectionsOf(text)
  const groups = deal(keys, headsFor(keys, linesOf(text).length, false))
  const script = { ...LOCATE() }
  groups.forEach((g, i) => { script['analyst||prober:' + (i + 1)] = [{ output: proberOut(unitsOf(g, sections), i === 0 ? findings : []) }] })
  return script
}

// --- the world: a recorded last review, then an edit ---------------------------------------------

function rigFor(t, files) {
  const rig = programRig({ files })
  t.after(() => rig.cleanup())
  return rig
}

/**
 * Record the last review of `path` as its round does: the snapshot `reviewScope` takes, and the
 * probe return holding `findings`. Returns `since` and what `recordProbe` gave each finding.
 */
function recordLast(rig, path, findings) {
  const file = native(rig.repo, path)
  const { snapshot } = reviewScope(rig.repo, file)
  const rec = recordProbe(rig.repo, { file, snapshot, from: [{ findings }], bundle: [STANDING.join('+')] })
  assert.equal(rec.recorded, true, JSON.stringify(rec))
  return { since: snapshot, rec }
}

/** A rig holding `text` at `path`, its last review recorded over `findings`, then `edited` written on disk. */
function reviewedThenEdited(t, { text = DOC, edited = EDITED, path = ART, findings = LAST } = {}) {
  const rig = rigFor(t, { [path]: text })
  const { since, rec } = recordLast(rig, path, findings)
  if (edited !== text) writeFileSync(native(rig.repo, path), edited)
  const file = native(rig.repo, path)
  const scope = reviewScope(rig.repo, file, since)
  /** The item each last-round finding was recorded as, by its claim. */
  const itemOf = Object.fromEntries(findings.map((f, i) => [f.claim, rec.findings[i].item]))
  return { rig, file, since, rec, scope, itemOf }
}

const proberCalls = (rig) => rig.calls.filter((c) => c.thread.key.startsWith('prober:'))
const probeReturns = (repo) => {
  const dir = evidenceReturnsDir(repo)
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('-probe.json')) : []
}
const readReturn = (repo, name) => JSON.parse(readFileSync(join(evidenceReturnsDir(repo), name + '.json'), 'utf8'))
const sorted = (list) => [...list].sort()

/** Run the narrowed round of the standard world (EDITED over the recorded LAST). */
async function narrowRound(t, { findings = LAST, perAxis = false, probers = {}, path = ART } = {}) {
  const w = reviewedThenEdited(t, { findings, path })
  const n = narrowed(EDITED, w.scope, { perAxis, probers })
  const run = w.rig.relaunch(n.script)
  const args = argsFor(w.rig.repo, path, { since: w.since, per_axis: perAxis })
  const result = await probe(run.ctx, args)
  return { ...w, ...n, run, args, result }
}

// --- a narrowed round --------------------------------------------------------------------------

test('a probe given since attacks only the changed parts of the sections', async (t) => {
  const { run, touched, result } = await narrowRound(t)
  assert.deepEqual(touched.map((s) => s.slug), ['risks~9-9'], 'the fixture: line 9 sits in Risks alone')
  const expected = unitsOf(STANDING, touched)
  assert.equal(result.units.total, expected.length)
  assert.equal(result.units.ruled, expected.length)
  assert.deepEqual(result.units.open, [])
  const calls = proberCalls(run)
  assert.ok(calls.length > 0, 'a prober was called')
  const others = unitsOf(STANDING, sectionsOf(EDITED))
  assert.ok(others.length > 0)
  for (const c of calls) {
    for (const u of expected) assert.ok(c.brief.includes(u), c.thread.key + ' names the unit ' + u)
    for (const u of others) assert.ok(!c.brief.includes('- ' + u + ' —'), c.thread.key + ' names no whole-section unit: ' + u)
  }
})

test("a narrowed round's locate material is its changed ranges", async (t) => {
  const { run, scope } = await narrowRound(t)
  const charge = readFileSync(run.calls.find((c) => c.thread.key === 'locate').role.systemPromptFile, 'utf8')
  const lines = EDITED.split('\n')
  for (const r of scope.changed) {
    assert.ok(charge.includes(ART + ', lines ' + r.start + '-' + r.end), 'the range ' + r.start + '-' + r.end + ' is a material label')
    assert.ok(charge.includes(lines.slice(r.start - 1, r.end).join('\n')), 'the range ' + r.start + '-' + r.end + ' is material')
  }
  for (const line of ['limit inbound requests per key', 'a token bucket per key, refilled each second']) {
    assert.ok(!charge.includes(line), 'a line no edit touched is not material: ' + line)
  }
})

test('the locate material is the artefact whole, or each changed range alone', () => {
  const lines = EDITED.replace(/\n$/, '').split('\n')
  assert.deepEqual(locateMaterial(EDITED, ART, null), [{ label: ART, text: lines.join('\n') }])
  const changed = [{ start: 2, end: 3 }, { start: 9, end: 9 }]
  assert.deepEqual(locateMaterial(EDITED, ART, changed), [
    { label: ART + ', lines 2-3', text: lines[1] + '\n' + lines[2] },
    { label: ART + ', lines 9-9', text: lines[8] },
  ])
})

test("a narrowed round's scope names the changed lines", async (t) => {
  const { rig, file, since, result } = await narrowRound(t)
  const changed = reviewScope(rig.repo, file, since).changed
  assert.deepEqual(changed, [{ start: 9, end: 9 }], 'the fixture: line 9 alone changed')
  assert.equal(result.scope.full, false)
  assert.deepEqual(result.scope.changed, changed)
})

test('each prober is told the changed lines and the carried findings', async (t) => {
  // Lines 8-9 (Risks) and 12 (Design) change: two ranges, two sections; per_axis buys a prober per axis.
  const edited = editLine(editLine(editLine(DOC, 8, 'a burst may starve every other key'), 9, 'the refill clock may drift under load'),
    12, 'a token bucket per key, refilled each tick')
  const w = reviewedThenEdited(t, { edited })
  assert.equal(w.scope.full, false)
  assert.ok(w.scope.changed.length >= 2, 'the fixture: two changed ranges ' + JSON.stringify(w.scope.changed))
  const carried = carriedFindings(w.scope)
  assert.ok(carried.length > 0, 'the fixture carries a finding')
  const claimOf = Object.fromEntries(Object.entries(w.itemOf).map(([claim, item]) => [item, claim]))
  const claims = carried.map((f) => claimOf[f.item])
  assert.ok(claims.every(Boolean))

  const n = narrowed(edited, w.scope, { perAxis: true })
  const run = w.rig.relaunch(n.script)
  await probe(run.ctx, argsFor(w.rig.repo, ART, { since: w.since, per_axis: true }))
  const calls = proberCalls(run)
  assert.equal(calls.length, STANDING.length)
  for (const c of calls) {
    for (const r of w.scope.changed) assert.ok(c.brief.includes(r.start + '-' + r.end), c.thread.key + ' names the range ' + r.start + '-' + r.end)
    for (const claim of claims) assert.ok(c.brief.includes(claim), c.thread.key + ' holds the carried claim ' + JSON.stringify(claim))
  }
})

test('the carried findings come first, marked carried, and the new ones follow', async (t) => {
  const { scope, result } = await narrowRound(t, { probers: { 1: (u) => [{ output: proberOut(u, [NEW]) }] } })
  const carried = carriedFindings(scope)
  const k = carried.length
  assert.ok(k > 0, 'the fixture carries a finding')
  assert.equal(result.findings.length, k + 1)
  assert.deepEqual(result.findings.slice(0, k), carried)
  assert.ok(result.findings.slice(0, k).every((f) => f.carried === true))
  const fresh = result.findings[k]
  assert.equal(fresh.id, 'P' + (k + 1))
  assert.equal(fresh.carried, false)
})

test('a finding on a changed line is not carried', async (t) => {
  const { itemOf, result } = await narrowRound(t)
  const suspect = itemOf[ON_CHANGED.claim]
  assert.ok(suspect, 'the finding on line 9 was recorded')
  const carriedItems = result.findings.filter((f) => f.carried).map((f) => f.item)
  assert.ok(!carriedItems.includes(suspect), 'the finding on the changed line is not carried')
  const others = LAST.filter((f) => f !== ON_CHANGED).map((f) => itemOf[f.claim])
  assert.deepEqual(sorted(carriedItems), sorted(others), "the last round's other findings are carried")
})

test("a finding the spec's folder settled as its gate counts it is not carried; an incorporation not yet ruled clean is", async (t) => {
  const path = '.agentics/e1/DESIGN.md'
  const w = reviewedThenEdited(t, { path })
  const [ambiguity, gap, note] = [AMBIGUITY, GAP, NOTE].map((f) => w.itemOf[f.claim])
  for (const [finding, outcome] of [[ambiguity, 'incorporated'], [gap, 'incorporated'], [note, 'discarded']]) {
    assert.equal(recordDisposition(w.rig.repo, 'e1', '.', { finding, outcome, by: 'planner' }).ok, true)
  }
  // A later review ruled the ambiguity's section clean: the gate counts its incorporation settled.
  append(w.rig.repo, 'e1', 'ledger', { kind: 'reviewed', folder: '.', hash: 'abcd0123', complete: true, remaining: [], ambiguities: [], clean: ['intent'], sections: { [ambiguity]: 'intent' } })
  const n = narrowed(EDITED, reviewScope(w.rig.repo, w.file, w.since))
  const result = await probe(w.rig.relaunch(n.script).ctx, argsFor(w.rig.repo, path, { since: w.since }))
  const carried = result.findings.filter((f) => f.carried).map((f) => f.item)
  assert.deepEqual(carried, [gap], 'the gap whose incorporation no review has ruled on yet is still carried')
  const told = proberCalls(w.rig).map((c) => c.brief).join('\n')
  assert.ok(!told.includes('CARRIED_AMBIGUITY_TOKEN') && !told.includes('CARRIED_NOTE_TOKEN'), 'no prober is told a settled finding')
})

test("a narrowed round's anchor checks leave the event loop free, so the run's heartbeat keeps beating", async (t) => {
  const many = Array.from({ length: 40 }, (_, i) => finding('yagni', 'note', 'intent', 4, 'MANY_' + i + ' the key is never defined'))
  const w = reviewedThenEdited(t, { findings: many })
  const t0 = Date.now()
  assert.equal(reviewScope(w.rig.repo, w.file, w.since).carried.length, many.length)
  const blocking = Date.now() - t0
  assert.ok(blocking > 200, 'the fixture: checked in-process, the anchors hold the loop for ' + blocking + ' ms')

  const n = narrowed(EDITED, w.scope)
  let last = Date.now()
  let gap = 0
  const timer = setInterval(() => { const now = Date.now(); gap = Math.max(gap, now - last); last = now }, 10)
  const result = await probe(w.rig.relaunch(n.script).ctx, argsFor(w.rig.repo, ART, { since: w.since }))
  clearInterval(timer)
  gap = Math.max(gap, Date.now() - last)
  assert.equal(result.findings.filter((f) => f.carried).length, many.length)
  assert.ok(gap < blocking / 2, 'the longest the loop stood still was ' + gap + ' ms, against ' + blocking + ' ms in-process')
})

test('a carried ambiguity is open and keeps the probe unratifiable', async (t) => {
  const { scope, itemOf, result } = await narrowRound(t)
  const ambiguity = carriedFindings(scope).find((f) => f.item === itemOf[AMBIGUITY.claim])
  assert.ok(ambiguity, 'the fixture carries the ambiguity')
  assert.ok(result.ambiguities.includes(ambiguity.id), JSON.stringify(result.ambiguities))
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage))
  assert.equal(result.ratifiable, false)
})

const longDoc = (n) => ['# Long', '', '## Body', ...Array.from({ length: n - 3 }, (_, i) => 'body line number ' + (i + 4))].join('\n') + '\n'

test("a narrowed round's head count is earned by its changed lines", async (t) => {
  const doc = longDoc(900)
  assert.equal(linesOf(doc).length, 900)
  assert.equal(headsFor(STANDING, 900, false), 3, 'the fixture: its full round buys three')
  const edited = editLine(doc, 500, 'an edited body line')
  const w = reviewedThenEdited(t, { text: doc, edited, findings: [] })
  assert.equal(changedLines(w.scope.changed), 1)
  const n = narrowed(edited, w.scope)
  assert.ok(n.groups.length < headsFor(STANDING, linesOf(doc).length, false), 'the fixture: a narrowed round buys fewer heads than a full one')
  const run = w.rig.relaunch(n.script)
  const result = await probe(run.ctx, argsFor(w.rig.repo, ART, { since: w.since }))
  assert.deepEqual(proberCalls(run).map((c) => c.thread.key), n.groups.map((_, i) => 'prober:' + (i + 1)))
  assert.deepEqual(result.analysts, n.groups)
})

test('the narrowed round records only its new findings, anchored to the new snapshot', async (t) => {
  const { rig, file, since, scope, result } = await narrowRound(t, { probers: { 1: (u) => [{ output: proberOut(u, [NEW]) }] } })
  const carried = carriedFindings(scope)
  assert.equal(result.findings.length, carried.length + 1, 'the result lists the carried findings and the new one')
  const snapshot = reviewScope(rig.repo, file).snapshot
  assert.notEqual(snapshot, since)
  assert.equal(result.snapshot, snapshot)
  assert.equal(probeReturns(rig.repo).length, 2)
  assert.ok(result.review, 'the round names its probe return')
  const ret = readReturn(rig.repo, result.review)
  assert.equal(ret.items.length, 1, 'the return holds only the new finding')
  assert.equal(ret.items[0].claim, NEW.claim)
  assert.ok(ret.items[0].spans.length > 0 && ret.items[0].spans.every((s) => s.at === snapshot), JSON.stringify(ret.items[0].spans))
  const fresh = result.findings[carried.length]
  const item = liveItems(rig.repo).get(fresh.item)
  assert.ok(item, 'the new finding is in the store')
  assert.ok(item.spans.every((s) => s.at === snapshot))
})

// --- a narrowed round over the ground its last round kept ---------------------------------------

const REPO_AXIS = { key: 'layering', charge: 'attack the layering', source: 'docs/REVIEW.md' }
const KEYS = [...STANDING, REPO_AXIS.key]
const KEPT_FILES = { [ART]: DOC, 'docs/REVIEW.md': 'Check the layering.\n', 'src/limiter.js': 'export const limit = 1\n' }
const KEPT_HITS = [
  { path: 'docs/REVIEW.md', line: 1, note: 'KEPT_GUIDANCE_NOTE', label: 'guidance' },
  { path: 'src/limiter.js', line: 1, note: 'KEPT_GROUND_NOTE', label: 'ground' },
]
const relocated = (unlocated) => [{ output: { unlocated, notes: '' } }]
const RELOCATE_TIER = { model: 'haiku', effort: 'low' }

/** DOC probed in full by the program itself, which keeps its ground, then EDITED written on disk. */
async function keptThenEdited(t) {
  const rig = rigFor(t, KEPT_FILES)
  const first = rig.relaunch({
    'scout||locate': [hitTurn(KEPT_HITS), closingRound()],
    'analyst||axes': [{ output: { axes: [REPO_AXIS], guidance_read: ['docs/REVIEW.md'], notes: '', stop_reason: 'completed' } }],
    'analyst||prober:1': [{ output: proberOut(unitsOf(KEYS, sectionsOf(DOC))) }],
  }, '20260101-000001-first')
  const one = await probe(first.ctx, argsFor(rig.repo, ART))
  assert.ok(one.snapshot, 'the fixture: the first round is recorded ' + JSON.stringify(one.coverage))
  writeFileSync(native(rig.repo, ART), EDITED)
  return { rig, since: one.snapshot, scope: reviewScope(rig.repo, native(rig.repo, ART), one.snapshot) }
}

/** The narrowed round after keptThenEdited: the relocate judge's steps, the locate's if any, one prober ruling every unit. */
async function keptRound(t, relocate, locate = {}) {
  const w = await keptThenEdited(t)
  const units = unitsOf(KEYS, changedParts(sectionsOf(EDITED), w.scope.changed))
  const run = w.rig.relaunch({ 'analyst||relocate': relocate, ...locate, 'analyst||prober:1': [{ output: proberOut(units) }] }, '20260101-000002-second')
  const result = await probe(run.ctx, argsFor(w.rig.repo, ART, { since: w.since }))
  return { ...w, run, units, result }
}

test('a narrowed round over kept ground that names nothing new searches nothing and derives no axes', async (t) => {
  const { run, since, units, result } = await keptRound(t, relocated([]))
  assert.deepEqual(run.calls.map((c) => c.thread.key), ['relocate', 'prober:1'])
  assert.deepEqual(run.calls[0].tier, RELOCATE_TIER)
  assert.ok(run.calls[0].brief.includes('KEPT_GROUND_NOTE'), 'the judge reads the kept places')
  assert.ok(run.calls[0].brief.includes('the refill clock may drift under load'), 'the judge reads the changed lines')
  assert.deepEqual(result.axes.map((a) => a.key), KEYS, 'the kept axes stand beside the standing four')
  const brief = run.calls[1].brief
  for (const note of ['KEPT_GUIDANCE_NOTE', 'KEPT_GROUND_NOTE']) assert.ok(brief.includes(note), 'the prober holds the kept ground: ' + note)
  assert.equal(result.repo_ground.status, 'kept')
  assert.equal(result.repo_ground.hits, KEPT_HITS.length)
  assert.deepEqual(result.guidance_read, ['docs/REVIEW.md'])
  assert.ok(result.coverage.declared.some((l) => l.includes(since)), JSON.stringify(result.coverage.declared))
  assert.deepEqual(result.units, { total: units.length, ruled: units.length, open: [] })
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage))
})

test('a changed line naming unlocated ground is searched for that ground alone', async (t) => {
  const located = { 'scout||locate': [hitTurn([{ path: 'src/limiter.js', line: 1, note: 'NEW_GROUND_NOTE', label: 'ground' }]), closingRound()] }
  const { run, result } = await keptRound(t, relocated([{ term: 'UNLOCATED_TERM', lines: '9' }]), located)
  assert.deepEqual(run.calls.map((c) => c.thread.key).filter((k) => k !== 'locate'), ['relocate', 'prober:1'], 'no axes analyst')
  const charge = readFileSync(run.calls.find((c) => c.thread.key === 'locate').role.systemPromptFile, 'utf8')
  assert.ok(charge.includes('UNLOCATED_TERM'), 'the search starts from the unlocated term')
  assert.ok(!charge.includes('labelled `guidance`'), 'the search hunts no guidance')
  const brief = proberCalls(run)[0].brief
  for (const note of ['KEPT_GROUND_NOTE', 'NEW_GROUND_NOTE']) assert.ok(brief.includes(note), 'the prober holds the joined ground: ' + note)
  assert.equal(result.repo_ground.hits, KEPT_HITS.length + 1)
})

test('a failed relocate judge searches the changed lines and says so', async (t) => {
  const { run, result } = await keptRound(t, [FAIL], LOCATE())
  assert.ok(run.calls.some((c) => c.thread.key === 'locate'), 'the changed lines are searched')
  assert.ok(result.coverage.declared.some((l) => l.includes('relocate judge failed')), JSON.stringify(result.coverage.declared))
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage))
})

test('a round whose axes analyst failed keeps no ground, so the next round derives its axes again', async (t) => {
  const rig = rigFor(t, KEPT_FILES)
  const first = rig.relaunch({
    'scout||locate': [hitTurn(KEPT_HITS), closingRound()],
    'analyst||axes': [FAIL],
    'analyst||prober:1': [{ output: proberOut(unitsOf(STANDING, sectionsOf(DOC))) }],
  }, '20260101-000001-first')
  const one = await probe(first.ctx, argsFor(rig.repo, ART))
  assert.ok(one.snapshot, 'the fixture: the round is recorded')
  assert.ok(one.coverage.failed_channels.includes('repo-axes'))
  writeFileSync(native(rig.repo, ART), EDITED)
  const scope = reviewScope(rig.repo, native(rig.repo, ART), one.snapshot)
  const units = unitsOf(KEYS, changedParts(sectionsOf(EDITED), scope.changed))
  const run = rig.relaunch({
    'scout||locate': [hitTurn(KEPT_HITS), closingRound()],
    'analyst||axes': [{ output: { axes: [REPO_AXIS], guidance_read: ['docs/REVIEW.md'], notes: '', stop_reason: 'completed' } }],
    'analyst||prober:1': [{ output: proberOut(units) }],
  }, '20260101-000002-second')
  const second = await probe(run.ctx, argsFor(rig.repo, ART, { since: one.snapshot }))
  assert.deepEqual(run.calls.map((c) => c.thread.key).filter((k) => k !== 'locate'), ['axes', 'prober:1'], 'no relocate judge')
  assert.deepEqual(second.axes.map((a) => a.key), KEYS)
})

test('a narrowed round keeps its ground for the round after it', async (t) => {
  const { rig, result } = await keptRound(t, relocated([]))
  const again = editLine(EDITED, 4, 'limit inbound requests per tenant')
  writeFileSync(native(rig.repo, ART), again)
  const scope = reviewScope(rig.repo, native(rig.repo, ART), result.snapshot)
  const units = unitsOf(KEYS, changedParts(sectionsOf(again), scope.changed))
  const run = rig.relaunch({ 'analyst||relocate': relocated([]), 'analyst||prober:1': [{ output: proberOut(units) }] }, '20260101-000003-third')
  const third = await probe(run.ctx, argsFor(rig.repo, ART, { since: result.snapshot }))
  assert.deepEqual(run.calls.map((c) => c.thread.key), ['relocate', 'prober:1'])
  assert.deepEqual(third.axes.map((a) => a.key), KEYS)
  assert.ok(run.calls[1].brief.includes('KEPT_GROUND_NOTE'))
})

// --- a narrowed round after a partial one -------------------------------------------------------

/** DOC probed in full by the program, its prober leaving every unit of `left` unruled; then `edited` on disk. */
async function partialThenEdited(t, { left = 'design', edited = EDITED } = {}) {
  const rig = rigFor(t, { [ART]: DOC })
  const ruled = unitsOf(STANDING, sectionsOf(DOC)).filter((u) => !u.endsWith('@' + left))
  const first = rig.relaunch({ ...LOCATE(), 'analyst||prober:1': [{ output: proberOut(ruled) }] }, '20260101-000001-first')
  const one = await probe(first.ctx, argsFor(rig.repo, ART))
  assert.ok(one.snapshot, 'the fixture: the partial round is recorded')
  assert.ok(one.units.open.length > 0 && one.units.open.every((u) => u.endsWith('@' + left)), JSON.stringify(one.units))
  if (edited !== DOC) writeFileSync(native(rig.repo, ART), edited)
  return { rig, since: one.snapshot, scope: reviewScope(rig.repo, native(rig.repo, ART), one.snapshot) }
}

/** The changed ranges widened by the whole of each section in `slugs`, as the next narrowed round attacks them. */
const widened = (text, changed, slugs) => {
  const ranges = [...changed, ...sectionsOf(text).filter((s) => slugs.includes(s.slug))].map((r) => [r.start, r.end]).sort((a, b) => a[0] - b[0])
  return ranges.reduce((out, [start, end]) => {
    const last = out.at(-1)
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end)
    else out.push({ start, end })
    return out
  }, [])
}

async function afterPartial(t, edited) {
  const w = await partialThenEdited(t, { edited })
  const changed = widened(edited, w.scope.changed, ['design'])
  const units = unitsOf(STANDING, changedParts(sectionsOf(edited), changed))
  const run = w.rig.relaunch({ 'analyst||relocate': relocated([]), 'analyst||prober:1': [{ output: proberOut(units) }] }, '20260101-000002-second')
  const result = await probe(run.ctx, argsFor(w.rig.repo, ART, { since: w.since }))
  return { ...w, run, changed, units, result }
}

test('a narrowed round after a partial one attacks the changed lines and every section that round left open', async (t) => {
  const { since, changed, units, result } = await afterPartial(t, EDITED)
  assert.ok(units.some((u) => u.includes('@risks~')) && units.some((u) => u.includes('@design~')), 'the fixture: the edit and the open section ' + JSON.stringify(units))
  assert.equal(result.scope.full, false)
  assert.deepEqual(result.scope.changed, changed)
  assert.deepEqual(result.units, { total: units.length, ruled: units.length, open: [] })
  assert.ok(result.coverage.declared.some((l) => l.includes(since) && l.includes('design')), JSON.stringify(result.coverage.declared))
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage))
})

test('an artefact unchanged since a partial round is attacked where that round left units open', async (t) => {
  const { run, units, result } = await afterPartial(t, DOC)
  assert.ok(proberCalls(run).length > 0, 'the open section buys a prober')
  assert.ok(units.length > 0 && units.every((u) => u.includes('@design~')), JSON.stringify(units))
  assert.deepEqual(result.units.open, [])
})

test('a section a partial round left open that the text no longer has makes the round whole', async (t) => {
  const renamed = editLine(EDITED, 11, '## Shape')
  const w = await partialThenEdited(t, { edited: renamed })
  const run = w.rig.relaunch({ 'analyst||relocate': relocated([]), ...fullScript(renamed) }, '20260101-000002-second')
  const result = await probe(run.ctx, argsFor(w.rig.repo, ART, { since: w.since }))
  assert.equal(result.scope.full, true)
  assert.equal(result.units.total, unitsOf(STANDING, sectionsOf(renamed)).length)
})

// --- an unchanged artefact ---------------------------------------------------------------------

async function unchangedRound(t, findings) {
  const w = reviewedThenEdited(t, { edited: DOC, findings })
  const run = w.rig.relaunch({})
  const args = argsFor(w.rig.repo, ART, { since: w.since })
  const result = await probe(run.ctx, args)
  return { ...w, run, args, result }
}

test('an artefact unchanged since since buys no agent', async (t) => {
  const { rig, run, file, since, rec, result } = await unchangedRound(t, [NOTE, GAP])
  assert.equal(run.calls.length, 0)
  assert.deepEqual(result.units, { total: 0, ruled: 0, open: [] })
  assert.deepEqual(result.axes, [])
  assert.deepEqual(result.analysts, [])
  assert.equal(result.scope.full, false)
  assert.deepEqual(result.scope.changed, [])
  const carried = carriedFindings(reviewScope(rig.repo, file, since))
  assert.equal(carried.length, 2, 'the fixture carries both findings')
  assert.deepEqual(result.findings, carried)
  const returns = probeReturns(rig.repo)
  assert.equal(returns.length, 2)
  assert.ok(result.review && result.review !== rec.return, 'the round names its own return')
  assert.ok(returns.includes(result.review + '.json'))
  assert.deepEqual(readReturn(rig.repo, result.review).items, [])
  assert.equal(result.snapshot, since)
})

test('an unchanged artefact with nothing open is ratifiable', async (t) => {
  const { result } = await unchangedRound(t, [NOTE])
  assert.deepEqual(result.ambiguities, [])
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage))
  assert.equal(result.ratifiable, true)
})

test('an unchanged artefact with a carried ambiguity is not ratifiable', async (t) => {
  const { scope, itemOf, result } = await unchangedRound(t, [NOTE, AMBIGUITY])
  const ambiguity = carriedFindings(scope).find((f) => f.item === itemOf[AMBIGUITY.claim])
  assert.ok(ambiguity)
  assert.deepEqual(result.ambiguities, [ambiguity.id])
  assert.equal(result.ratifiable, false)
})

// --- a since that does not narrow, and what narrowing keeps -------------------------------------

test('a since that names no intact snapshot probes in full', async (t) => {
  const cases = {
    'an id the store does not hold': (repo, since) => {
      assert.notEqual(since, 'snapshot:0badc0de', 'the fixture: the id is not the last review\'s')
      return 'snapshot:0badc0de'
    },
    'no snapshot id': () => 'not-a-snapshot',
    'a torn snapshot': (repo, since) => {
      writeFileSync(join(evidenceSnapshotsDir(repo), since.slice('snapshot:'.length) + '.txt'), 'other text, torn mid-write\n')
      return since
    },
  }
  for (const [name, sinceOf] of Object.entries(cases)) {
    const w = reviewedThenEdited(t)
    const since = sinceOf(w.rig.repo, w.since)
    const sections = sectionsOf(EDITED)
    const run = w.rig.relaunch(fullScript(EDITED))
    const result = await probe(run.ctx, argsFor(w.rig.repo, ART, { since }))
    assert.equal(result.scope.full, true, name)
    const all = unitsOf(STANDING, sections)
    assert.equal(result.units.total, all.length, name)
    const briefs = proberCalls(run).map((c) => c.brief).join('\n')
    for (const u of all) assert.ok(briefs.includes(u), name + ': a prober names ' + u)
    assert.ok(result.findings.every((f) => f.carried === false), name + ': ' + JSON.stringify(result.findings))
  }
})

test('a store-refused finding in a narrowed round leaves the snapshot empty', async (t) => {
  const refused = { ...NEW, claim: '' }
  const w = reviewedThenEdited(t)
  // Every unit of the document is ruled, so the script serves a full round and a narrowed one alike.
  const all = unitsOf(STANDING, sectionsOf(EDITED))
  const run = w.rig.relaunch({ ...LOCATE(EDITED), 'analyst||prober:1': [{ output: proberOut(all, [refused]) }] })
  const result = await probe(run.ctx, argsFor(w.rig.repo, ART, { since: w.since }))
  assert.equal(result.snapshot, '')
  const fresh = result.findings.filter((f) => !f.carried).map((f) => f.id)
  assert.equal(fresh.length, 1)
  assert.deepEqual(result.unrecorded, fresh)
})

test('carried findings stand in the result when a prober fails', async (t) => {
  const probers = Object.fromEntries([1, 2, 3, 4].map((n) => [n, (u) => (n === 2
    ? [FAIL]
    : [{ output: proberOut(u, [finding(STANDING[n - 1], 'note', 'risks', 9, 'NEW_NOTE_' + n + '_TOKEN')]) }])]))
  const { scope, result } = await narrowRound(t, { perAxis: true, probers })
  const carried = carriedFindings(scope)
  const k = carried.length
  assert.ok(k > 0)
  assert.deepEqual(result.findings.slice(0, k), carried)
  const fresh = result.findings.slice(k)
  assert.equal(fresh.length, 3)
  assert.ok(fresh.every((f) => f.carried === false))
  assert.deepEqual(sorted(result.unrecorded), sorted(fresh.map((f) => f.id)))
  assert.ok(result.coverage.failed_channels.includes('probe'), JSON.stringify(result.coverage))
})

// --- relaunch and read-back --------------------------------------------------------------------

test('a relaunch calls nothing that returned', async (t) => {
  const { rig, args, result } = await narrowRound(t, { probers: { 1: (u) => [{ output: proberOut(u, [NEW]) }] } })
  assert.equal(result.scope.full, false)
  const again = rig.relaunch({})
  const second = await probe(again.ctx, args)
  assert.deepEqual(second, result)
  assert.equal(again.calls.length, 0)
  assert.equal(probeReturns(rig.repo).length, 2)
})

test('a relaunch of an unchanged round records nothing twice', async (t) => {
  const { rig, args, result } = await unchangedRound(t, [NOTE])
  assert.equal(probeReturns(rig.repo).length, 2)
  const again = rig.relaunch({})
  const second = await probe(again.ctx, args)
  assert.deepEqual(second, result)
  assert.equal(again.calls.length, 0)
  assert.equal(probeReturns(rig.repo).length, 2)
})

const E = 'e1'
const SPEC = '.agentics/e1/DESIGN.md'

/** Record the run's result as `approval.mjs reviewed --from-run` does once it has read it, in-process; the line it wrote. */
function readBack(rig, result) {
  const out = reviewedFromResult(rig.repo, E, '.', result)
  assert.equal(out.ok, true, JSON.stringify(out))
  const lines = readLog(rig.repo, E, 'ledger').entries.filter((l) => l.kind === 'reviewed')
  assert.equal(lines.length, 1, JSON.stringify(out))
  return lines[0]
}

test('a narrowed result reads back through reviewed --from-run, carried ambiguities by their items', { timeout: 120_000 }, async (t) => {
  const { rig, itemOf, result } = await narrowRound(t, { path: SPEC })
  assert.equal(result.scope.full, false)
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage))
  const item = itemOf[AMBIGUITY.claim]
  assert.ok(result.findings.some((f) => f.carried && f.item === item && result.ambiguities.includes(f.id)), 'the ambiguity is carried and open')
  const line = readBack(rig, result)
  assert.equal(line.complete, true)
  assert.deepEqual(line.ambiguities, [item])
})
