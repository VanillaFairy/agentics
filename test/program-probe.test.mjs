// test/program-probe.test.mjs — pins the probe program's full round: its scope and snapshot, the
// shared ground resolved once, the one locating search and its ends, the repository's axes beside
// the standing four, the head count and the round-robin deal, what reaches which brief, the units and
// the gate, the record anchored to the snapshot, relaunches, and the result read back by
// `approval.mjs reviewed --from-run`.
//
// Design: docs/DESIGN.md#probe, docs/DESIGN.md#what-a-probe-costs, docs/DESIGN.md#searches,
// docs/DESIGN.md#coverage-block.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { reviewedFromResult } from '../lib/approval.mjs'
import { LOCATE_FIND, LOCATE_LABELS } from '../lib/briefs/probe.mjs'
import { scoutCharge } from '../lib/briefs/search.mjs'
import { resolveCitations } from '../lib/citations.mjs'
import { liveItems, reviewScope, sectionsOf, unitsOf } from '../lib/evidence.mjs'
import { readLog } from '../lib/ledger.mjs'
import { programContext } from '../lib/programs/common.mjs'
import { locateMaterial, probe, scopeOf } from '../lib/programs/probe.mjs'
import { loadRole, tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { treeOf } from '../lib/search/pin.mjs'
import { evidenceReturnsDir, posix } from '../lib/store.mjs'
import { programRig } from './harness/program-rig.mjs'
import { closedSearch, closingRound, grepRecord, hitRecord, hitTurn, scoutStep, stalledRecord } from './fast/harness/scout.mjs'
import { scriptedRunner } from './fast/harness/scripted-runner.mjs'

const STANDING = ['ambiguity', 'invariants', 'yagni', 'reinvention']
const ART = 'docs/spec.md'
const DOC = [
  '# Limiter',
  '',
  '## Intent',
  'limit inbound requests per key',
  'callers see a retry hint',
  '',
  '## Design',
  'a token bucket per key, refilled each second',
].join('\n') + '\n'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
const DESIGN_SKILL = fileURLToPath(new URL('../skills/design/SKILL.md', import.meta.url))

function rigFor(t, opts) {
  const rig = programRig(opts)
  t.after(() => rig.cleanup())
  return rig
}

const native = (root, path) => join(root, ...path.split('/'))
const textOf = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim()
/** The arguments as lib/run.mjs resolves them for `--artifact <path>`. */
const argsFor = (root, path, over = {}) => ({
  artifact: native(root, path), artifact_text: textOf(native(root, path)), roots: ['.'], context: '', per_axis: false, since: '', ...over,
})
const linesOf = (text) => text.trim().split('\n')

// --- returns as the agents give them -----------------------------------------------------------

/** A hit the locating search journals. */
const hitOf = (path, line, label, note = 'bears on it') => ({ path, line, note, label })
/** scriptFor's options for a locate whose scout journals `hits` and returns. */
const located = (hits) => ({ locate: [hitTurn(hits), closingRound()] })
const NOTHING_LOCATED = closedSearch({ name: 'locate' })['scout||locate']
const axis = (key, charge = 'attack the design on ' + key, source = 'docs/REVIEW.md') => ({ key, charge, source })
const axesOut = (axes = [], over = {}) => ({ axes, guidance_read: ['docs/REVIEW.md'], notes: '', stop_reason: 'completed', ...over })
const finding = (axisKey, severity, section, start, over = {}) => ({
  axis: axisKey, severity, section, claim: severity + ' on ' + axisKey + ' in ' + section, evidence: 'line ' + start, start, end: start, ...over,
})
/** A prober's return ruling `units` (less `skip`, plus `extra`); a unit a finding sits on is ruled `findings`. */
function proberOut(units, { findings = [], skip = [], extra = [], over = {} } = {}) {
  const ruled = units.filter((u) => !skip.includes(u)).concat(extra)
  return {
    findings,
    units: ruled.map((unit) => ({
      unit, ruling: findings.some((f) => f.axis + '@' + f.section === unit) ? 'findings' : 'clean', ids: [], why: 'why ' + unit,
    })),
    notes: '', stop_reason: 'exhausted', not_reached: '', ...over,
  }
}
const FAIL = { status: 'failed', cause: 'host_error' }

// --- what a probe is expected to buy, by the rule ----------------------------------------------

/** The head count: one per 400 lines, one per 12 axes, whichever is more; never more than the axes. */
const headsFor = (keys, lines, perAxis) =>
  (perAxis ? keys.length : Math.min(keys.length, Math.max(1, Math.ceil(lines / 400), Math.ceil(keys.length / 12))))
/** The axes dealt round-robin: group i holds the axes whose index is i mod n. */
const deal = (keys, n) => Array.from({ length: n }, (_, i) => keys.filter((_, j) => j % n === i))

/**
 * A script for a whole round of `text` over `keys`: the locating scout's steps (default: it finds
 * nothing), the axes analyst's, and each prober's, `probers[n](units)` giving prober n's steps
 * (default: every unit ruled clean).
 */
function scriptFor(text, keys, { locate = NOTHING_LOCATED, axes = null, perAxis = false, probers = {} } = {}) {
  const sections = sectionsOf(text)
  const groups = deal(keys, headsFor(keys, linesOf(text).length, perAxis))
  const script = { 'scout||locate': locate }
  if (axes) script['analyst||axes'] = axes
  groups.forEach((g, i) => {
    const units = unitsOf(g, sections)
    script['analyst||prober:' + (i + 1)] = probers[i + 1] ? probers[i + 1](units) : [{ output: proberOut(units) }]
  })
  return { script, groups, sections, unitsOfGroup: groups.map((g) => unitsOf(g, sections)) }
}

/** A probe over a rig. */
async function probeIn(t, { files = { [ART]: DOC }, path = ART, script, over = {}, config = {} } = {}) {
  const rig = rigFor(t, { files, script, config })
  const args = argsFor(rig.repo, path, over)
  const result = await probe(rig.ctx, args)
  return { rig, args, result }
}
const chargeOf = (call) => readFileSync(call.role.systemPromptFile, 'utf8')

const callsOf = (rig, thread) => rig.calls.filter((c) => c.thread.key === thread)
const proberCalls = (rig) => rig.calls.filter((c) => c.thread.key.startsWith('prober:'))
const proberBrief = (rig, n) => {
  const calls = callsOf(rig, 'prober:' + n)
  assert.ok(calls.length > 0, 'prober:' + n + ' was called')
  return calls[0].brief
}
const probeReturns = (repo) => {
  const dir = evidenceReturnsDir(repo)
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('-probe.json')) : []
}
const itemsIn = (repo) => [...liveItems(repo).values()]
const sorted = (list) => [...list].sort()
const keysOf = (result) => result.axes.map((a) => a.key)

// --- arguments ---------------------------------------------------------------------------------

test("a probe's scope is its artefact alone", () => {
  const where = { repo: 'C:\\r', root: 'C:\\r' }
  const a = { artifact: 'C:\\r\\docs\\spec.md', artifact_text: 'one', roots: ['.'], context: '', per_axis: false, since: '' }
  const b = { artifact: 'C:\\r\\docs\\spec.md', artifact_text: 'two', roots: ['src', 'lib'], context: 'why', per_axis: true, since: 'snapshot:abc' }
  assert.deepEqual(scopeOf(a, where), scopeOf(b, { repo: 'C:\\other', root: 'C:\\other\\wt' }))
  assert.notDeepEqual(scopeOf(a, where), scopeOf({ ...a, artifact: 'C:\\r\\docs\\other.md' }, where))
  assert.equal(scopeOf(a, where).artifact, posix(a.artifact))
})

// --- the scope ---------------------------------------------------------------------------------

test('the artefact is snapshotted before anything is dispatched', async (t) => {
  const { rig, args, result } = await probeIn(t, { script: scriptFor(DOC, STANDING).script })
  const entries = rig.log.entries()
  const scope = entries.find((e) => e.kind === 'step' && e.key === 'scope')
  assert.ok(scope, 'a step record keyed scope')
  const dispatched = entries.filter((e) => e.kind === 'dispatched')
  assert.ok(dispatched.length > 0)
  assert.ok(dispatched.every((e) => e.seq > scope.seq), 'the scope comes before every dispatched record')
  const expected = reviewScope(rig.repo, args.artifact)
  assert.equal(result.artifact, expected.path)
  assert.equal(result.snapshot, expected.snapshot)
})

test('an artefact outside every checkout is probed in full and nothing is recorded', async (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'agentics-probe-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, 'spec.md'), DOC)
  const rig = rigFor(t, { files: { 'src/a.js': 'a\n' }, script: scriptFor(DOC, STANDING).script })
  const args = argsFor(outside, 'spec.md')
  const result = await probe(rig.ctx, args)
  assert.ok(proberCalls(rig).length > 0, 'the probers still run')
  assert.equal(result.artifact, posix(args.artifact))
  assert.ok(result.coverage.failed_channels.includes('record'), JSON.stringify(result.coverage))
  assert.ok(result.coverage.unreached.length > 0)
  assert.deepEqual(result.findings, [])
  assert.equal(result.snapshot, '')
  assert.equal(result.coverage.complete, false)
  assert.equal(result.ratifiable, false)
  assert.deepEqual(probeReturns(rig.repo), [])
  assert.equal(itemsIn(rig.repo).length, 0)
})

const WT_FINDINGS = [finding('ambiguity', 'ambiguity', 'intent', 4)]
test("a probe in a linked worktree reads and anchors the worktree's text", async (t) => {
  const rig = rigFor(t, { files: { [ART]: DOC } })
  const dir = mkdtempSync(join(tmpdir(), 'agentics-probe-wt-'))
  const wt = join(dir, 'wt')
  t.after(() => {
    try { git(rig.repo, 'worktree', 'remove', '--force', wt) } catch { /* the rig's cleanup removes it */ }
    rmSync(dir, { recursive: true, force: true })
  })
  git(rig.repo, 'worktree', 'add', '-q', '-b', 'side', wt)
  const WT_DOC = DOC.replace('limit inbound requests per key', 'WORKTREE_ONLY_TOKEN limit outbound calls per host')
  assert.notEqual(WT_DOC, DOC, 'the fixture: the worktree text differs')
  writeFileSync(native(wt, ART), WT_DOC)
  const { script } = scriptFor(WT_DOC, STANDING, {
    probers: { 1: (units) => [{ output: proberOut(units, { findings: WT_FINDINGS }) }] },
  })
  const ctx = programContext({ intelligence: 'normal', ...rig.ctx, repo: wt, root: wt, runAgent: scriptedRunner(script, { log: rig.log }).runAgent })
  const args = argsFor(wt, ART)
  const result = await probe(ctx, args)

  assert.equal(result.artifact, ART)
  const scope = reviewScope(wt, args.artifact, '', { root: wt })
  assert.equal(result.snapshot, scope.snapshot)
  assert.notEqual(result.snapshot, reviewScope(rig.repo, native(rig.repo, ART)).snapshot, "the worktree's text, not the main checkout's")
  assert.equal(result.findings.length, WT_FINDINGS.length)
  const items = liveItems(rig.repo)
  for (const f of result.findings) {
    const item = items.get(f.item)
    assert.ok(item, 'the finding ' + f.id + ' is in the store')
    assert.ok(item.spans.length > 0 && item.spans.every((s) => s.at === result.snapshot), JSON.stringify(item.spans))
  }
})

// --- shared ground -----------------------------------------------------------------------------

const CITED_FILES = {
  'src/limiter.js': ['// limiter', 'export const bucket = {}', 'export const CITED_LINE_TOKEN = 3', 'export const refill = 1'].join('\n') + '\n',
}
const CITING_DOC = DOC.replace('a token bucket per key, refilled each second', 'a token bucket per key, as in src/limiter.js:3')

test("the artefact's citations are resolved once and handed to every prober", async (t) => {
  const { script } = scriptFor(CITING_DOC, STANDING, { perAxis: true })
  const { rig, args, result } = await probeIn(t, { files: { [ART]: CITING_DOC, ...CITED_FILES }, script, over: { per_axis: true } })
  const resolved = resolveCitations(rig.repo, args.artifact, 10)
  assert.deepEqual(result.shared_ground, { resolved: true, ...resolved.counts })
  const excerpt = resolved.files.find((f) => f.path === 'src/limiter.js').excerpts[0]
  assert.ok(excerpt.text.includes('CITED_LINE_TOKEN'))
  const calls = proberCalls(rig)
  assert.equal(calls.length, STANDING.length)
  for (const c of calls) assert.ok(c.brief.includes(excerpt.text), c.thread.key + ' holds the cited excerpt')
})

test('a citation that resolves to nothing is named to every prober', async (t) => {
  const doc = DOC.replace('a token bucket per key, refilled each second', 'a token bucket per key, as in src/gone.js:4')
  const { script } = scriptFor(doc, STANDING, { perAxis: true })
  const { rig, args, result } = await probeIn(t, { files: { [ART]: doc }, script, over: { per_axis: true } })
  const resolved = resolveCitations(rig.repo, args.artifact, 10)
  assert.equal(resolved.unresolved.length, 1)
  assert.equal(result.shared_ground.unresolved, 1)
  const calls = proberCalls(rig)
  assert.equal(calls.length, STANDING.length)
  for (const c of calls) assert.ok(c.brief.includes(resolved.unresolved[0].detail), c.thread.key + ' is told the citation resolves to nothing')
})

// --- locating ----------------------------------------------------------------------------------

const GROUND_FILES = {
  'docs/REVIEW.md': ['# Review', 'GUIDANCE_LINE_TOKEN every limit names its unit', 'end'].join('\n') + '\n',
  'src/ground.js': ['// ground', 'export const GROUND_LINE_TOKEN = 1', 'export const end = 2'].join('\n') + '\n',
}
const GUIDE_HIT = hitOf('docs/REVIEW.md', 2, 'guidance')
const GROUND_HIT = hitOf('src/ground.js', 2, 'ground')

test('the locating search is one scout session whose charge holds the find, its labels and the artefact', async (t) => {
  const { rig, args } = await probeIn(t, { script: scriptFor(DOC, STANDING).script })
  const calls = callsOf(rig, 'locate')
  assert.equal(calls.length, 1)
  assert.deepEqual([calls[0].role.name, calls[0].schema], ['scout', schemaOf('search')])
  const charge = chargeOf(calls[0])
  assert.ok(charge.includes(LOCATE_FIND), 'the charge holds the find')
  const material = locateMaterial(DOC, ART, null)
  assert.ok(charge.includes(scoutCharge({ domain: 'repo', find: LOCATE_FIND, scope: args.roots, labels: LOCATE_LABELS, material })), 'the charge is the scout charge of the find, its labels and the artefact')
  for (const label of ['`guidance`', '`ground`']) assert.ok(charge.includes(label), 'the charge names the label ' + label)
  assert.ok(charge.includes(linesOf(args.artifact_text).join('\n')), 'the charge holds the artefact whole')
})

test('located hits reach every prober', async (t) => {
  const { script } = scriptFor(DOC, STANDING, { ...located([GUIDE_HIT, GROUND_HIT]), axes: [{ output: axesOut([]) }], perAxis: true })
  const { rig } = await probeIn(t, { files: { [ART]: DOC, ...GROUND_FILES }, script, over: { per_axis: true } })
  const calls = proberCalls(rig)
  assert.equal(calls.length, STANDING.length)
  for (const c of calls) {
    for (const token of ['GROUND_LINE_TOKEN', 'GUIDANCE_LINE_TOKEN']) assert.ok(c.brief.includes(token), c.thread.key + ' holds ' + token)
  }
})

test('located guidance reaches the axes analyst alone', async (t) => {
  const { script } = scriptFor(DOC, STANDING, { ...located([GUIDE_HIT, GROUND_HIT]), axes: [{ output: axesOut([]) }] })
  const { rig } = await probeIn(t, { files: { [ART]: DOC, ...GROUND_FILES }, script })
  const [axesCall] = callsOf(rig, 'axes')
  assert.ok(axesCall, 'an axes call')
  assert.ok(axesCall.brief.includes('GUIDANCE_LINE_TOKEN'))
  assert.ok(!axesCall.brief.includes('GROUND_LINE_TOKEN'))
})

test('repo_ground counts the hits and the hits no file holds', async (t) => {
  const hits = [GROUND_HIT, hitOf('src/missing.js', 5, 'ground')]
  const files = { [ART]: DOC, ...GROUND_FILES }
  const { result } = await probeIn(t, { files, script: scriptFor(DOC, STANDING, located(hits)).script })
  assert.deepEqual(result.repo_ground, {
    status: 'done', hits: hits.length, unresolved: hits.filter((h) => !(h.path in files)).length,
  })
})

test('a failed locate leaves the ground not located and the probe incomplete', async (t) => {
  const { rig, result } = await probeIn(t, { script: scriptFor(DOC, STANDING, { locate: [FAIL] }).script })
  assert.ok(result.coverage.failed_channels.includes('locate'), JSON.stringify(result.coverage))
  assert.ok(result.coverage.unreached.some((l) => l.startsWith('locate: failed')), JSON.stringify(result.coverage))
  assert.equal(callsOf(rig, 'axes').length, 0)
  assert.deepEqual(keysOf(result), STANDING)
  assert.ok(proberBrief(rig, 1).includes('NOT LOCATED'), 'the probers are told the ground was not located')
  assert.equal(result.coverage.complete, false)
})

test('a stalled locate is complete and keeps what it found', async (t) => {
  const locate = [scoutStep({ calls: [grepRecord([[GROUND_HIT.path, GROUND_HIT.line]]), stalledRecord()], hits: [GROUND_HIT] }), scoutStep({ calls: [stalledRecord()] })]
  const { rig, result } = await probeIn(t, { files: { [ART]: DOC, ...GROUND_FILES }, script: scriptFor(DOC, STANDING, { locate }).script })
  assert.deepEqual(result.coverage.incomplete, [])
  assert.ok(result.coverage.declared.some((l) => l.startsWith('locate: stalled')), JSON.stringify(result.coverage))
  assert.ok(proberBrief(rig, 1).includes('GROUND_LINE_TOKEN'), 'the prober holds what the locate found')
  assert.ok(!proberBrief(rig, 1).includes('did NOT finish'))
})

test('a locate stopped at its budget keeps its hits and is incomplete', async (t) => {
  const locate = [{ status: 'failed', cause: 'budget', cost_total: 1.02, calls: [hitRecord(GROUND_HIT)] }]
  const { rig, result } = await probeIn(t, { files: { [ART]: DOC, ...GROUND_FILES }, script: scriptFor(DOC, STANDING, { locate }).script, over: { search_budget: 1 } })
  assert.deepEqual(result.coverage.incomplete, ['locate'])
  assert.ok(result.coverage.unreached.some((l) => l.startsWith('locate: budget')), JSON.stringify(result.coverage))
  assert.equal(result.repo_ground.hits, 1)
  assert.ok(proberBrief(rig, 1).includes('GROUND_LINE_TOKEN'), 'the prober holds what the locate found')
  assert.ok(proberBrief(rig, 1).includes('did NOT finish'), 'the prober is told the search did not finish')
})

test('a locate that found nothing says no hits', async (t) => {
  const { result } = await probeIn(t, { script: scriptFor(DOC, STANDING).script })
  assert.ok(result.coverage.declared.includes('locate: done, 0 calls, no hits'), JSON.stringify(result.coverage))
  assert.deepEqual(result.repo_ground, { status: 'done', hits: 0, unresolved: 0 })
})

test('the search budget caps the locate', async (t) => {
  const rig = rigFor(t, { files: { [ART]: DOC } })
  const runner = scriptedRunner(scriptFor(DOC, STANDING).script, { log: rig.log })
  await probe(programContext({ ...rig.ctx, runAgent: runner.runAgent }), argsFor(rig.repo, ART, { search_budget: 2 }))
  const [start] = runner.starts.filter((s) => s.key === 'scout||locate')
  const args = start.args
  assert.equal(Number(args[args.indexOf('--max-budget-usd') + 1]), 2)
})

test('no prober is offered wants or a ground table', async (t) => {
  const { rig } = await probeIn(t, { script: scriptFor(DOC, STANDING, { perAxis: true }).script, over: { per_axis: true } })
  for (const c of proberCalls(rig)) {
    assert.ok(!c.brief.includes('WANTS'), c.thread.key + ' is offered no wants')
    assert.ok(!c.brief.includes('WHAT THE DOCUMENT NAMES'), c.thread.key + ' holds no ground table')
  }
})

test('a tree handed in-process is searched and cited; the artefact is snapshotted where the probe started', async (t) => {
  const found = hitOf('src/other.js', 2, 'ground')
  const rig = rigFor(t, { files: { [ART]: CITING_DOC, ...CITED_FILES }, script: scriptFor(CITING_DOC, STANDING, located([found])).script })
  const wt = join(rig.repo, '.claude', 'worktrees', 'other')
  git(rig.repo, 'worktree', 'add', '--detach', wt, 'HEAD')
  writeFileSync(join(wt, 'src', 'limiter.js'), CITED_FILES['src/limiter.js'].replace('CITED_LINE_TOKEN', 'TREE_LINE_TOKEN'))
  writeFileSync(join(wt, 'src', 'other.js'), ['// other', 'export const TREE_ONLY_TOKEN = 1', ''].join('\n'))
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', 'the tree moves on')
  const args = { ...argsFor(rig.repo, ART), tree: treeOf(wt) }
  const result = await probe(rig.ctx, args)
  assert.ok(proberBrief(rig, 1).includes('TREE_LINE_TOKEN'), 'the citations were read from the tree')
  assert.ok(!proberBrief(rig, 1).includes('CITED_LINE_TOKEN'), 'not from the checkout the probe started in')
  assert.ok(proberBrief(rig, 1).includes('TREE_ONLY_TOKEN'), "the search's hit was read from the tree")
  assert.equal(result.snapshot, reviewScope(rig.repo, args.artifact, '', { root: rig.repo }).snapshot, "the snapshot is the checkout's")
})

test('without a handed tree the citations are read from ctx.root, not from the checkout ctx.repo names', async (t) => {
  const rig = rigFor(t, { files: { [ART]: CITING_DOC, ...CITED_FILES }, script: scriptFor(CITING_DOC, STANDING).script })
  const wt = join(rig.repo, '.claude', 'worktrees', 'rooted')
  git(rig.repo, 'worktree', 'add', '--detach', wt, 'HEAD')
  writeFileSync(join(wt, 'src', 'limiter.js'), CITED_FILES['src/limiter.js'].replace('CITED_LINE_TOKEN', 'ROOT_LINE_TOKEN'))
  git(wt, 'commit', '-qam', 'the root moves on')
  await probe({ ...rig.ctx, root: wt }, argsFor(rig.repo, ART))
  assert.ok(proberBrief(rig, 1).includes('ROOT_LINE_TOKEN'), "the citations were read from ctx.root's tree")
  assert.ok(!proberBrief(rig, 1).includes('CITED_LINE_TOKEN'), 'not from ctx.repo')
})

test('guidance is read from the pinned tree', async (t) => {
  const files = { [ART]: DOC, 'CLAUDE.md': 'ROOT_GUIDE_TOKEN the checkout\'s rules\n' }
  const rig = rigFor(t, { files, script: scriptFor(DOC, STANDING, { axes: [{ output: axesOut([]) }] }).script })
  const wt = join(rig.repo, '.claude', 'worktrees', 'pinned')
  git(rig.repo, 'worktree', 'add', '--detach', wt, 'HEAD')
  writeFileSync(join(wt, 'CLAUDE.md'), 'TREE_GUIDE_TOKEN the pinned tree\'s rules\n')
  git(wt, 'commit', '-qam', 'the tree moves on')
  await probe(rig.ctx, { ...argsFor(rig.repo, ART), tree: treeOf(wt) })
  const brief = proberBrief(rig, 1)
  assert.ok(brief.includes('TREE_GUIDE_TOKEN'), "the guidance is the pinned tree's")
  assert.ok(!brief.includes('ROOT_GUIDE_TOKEN'), 'not the guidance at ctx.root')
})

// --- axes --------------------------------------------------------------------------------------

const withGuidance = (axesSteps, keys = STANDING, extra = {}) =>
  scriptFor(DOC, keys, { ...located([GUIDE_HIT]), axes: axesSteps, ...extra })

test('located guidance buys one axes analyst', async (t) => {
  const read = ['docs/REVIEW.md', 'CLAUDE.md']
  const { rig, result } = await probeIn(t, { files: { [ART]: DOC, ...GROUND_FILES }, script: withGuidance([{ output: axesOut([], { guidance_read: read }) }]).script })
  const calls = callsOf(rig, 'axes')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].role.name, 'analyst')
  assert.deepEqual(calls[0].schema, schemaOf('axes'))
  assert.deepEqual(result.guidance_read, read)
})

test('no guidance located buys no axes analyst and fails nothing', async (t) => {
  const { script } = scriptFor(DOC, STANDING, located([GROUND_HIT]))
  const { rig, result } = await probeIn(t, { files: { [ART]: DOC, ...GROUND_FILES }, script })
  assert.equal(callsOf(rig, 'axes').length, 0)
  assert.deepEqual(keysOf(result), STANDING)
  assert.deepEqual(result.coverage.failed_channels, [])
})

test('configured guidance buys the axes analyst with no guidance hit', async (t) => {
  const files = { [ART]: DOC, 'docs/STYLE.md': 'STYLE_GUIDE_TOKEN write short lines\n' }
  const { script } = scriptFor(DOC, STANDING, { axes: [{ output: axesOut([]) }] })
  const { rig } = await probeIn(t, { files, script, config: { guidance: ['docs/STYLE.md'] } })
  assert.equal(callsOf(rig, 'axes').length, 1)
})

test("the repository's axes join the standing four, slugged and each key once", async (t) => {
  const returned = [axis('Error Handling', 'c1', 'docs/REVIEW.md'), axis('yagni', 'c2', 'docs/STYLE.md'), axis('error handling!', 'c3', 'docs/REVIEW.md')]
  const keys = [...STANDING, 'error-handling', 'yagni-2', 'error-handling-2']
  const { result } = await probeIn(t, { files: { [ART]: DOC, ...GROUND_FILES }, script: withGuidance([{ output: axesOut(returned) }], keys).script })
  assert.deepEqual(result.axes.map(({ key, source }) => ({ key, source })), [
    ...STANDING.map((key) => ({ key, source: '' })),
    { key: 'error-handling', source: 'docs/REVIEW.md' },
    { key: 'yagni-2', source: 'docs/STYLE.md' },
    { key: 'error-handling-2', source: 'docs/REVIEW.md' },
  ])
})

test('an axis with no key or no charge is not probed', async (t) => {
  const returned = [axis('', 'a charge with no key'), axis('no-charge', ''), axis('kept', 'probe what is kept')]
  const keys = [...STANDING, 'kept']
  const { rig, result } = await probeIn(t, { files: { [ART]: DOC, ...GROUND_FILES }, script: withGuidance([{ output: axesOut(returned) }], keys).script })
  assert.deepEqual(keysOf(result), keys)
  assert.ok(proberCalls(rig).every((c) => !c.brief.includes('a charge with no key')))
})

test('an axes analyst that fails or cannot read the guidance leaves repo-axes failed', async (t) => {
  for (const steps of [[FAIL], [{ output: axesOut([axis('extra')], { stop_reason: 'unreadable' }) }]]) {
    const { result } = await probeIn(t, { files: { [ART]: DOC, ...GROUND_FILES }, script: withGuidance(steps).script })
    assert.deepEqual(result.coverage.failed_channels, ['repo-axes'], JSON.stringify(steps))
    assert.deepEqual(keysOf(result), STANDING)
  }
})

test('an axes analyst that finds no guidance adds no axis and fails nothing', async (t) => {
  const steps = [{ output: axesOut([axis('listed-anyway')], { stop_reason: 'no_guidance_found' }) }]
  const { result } = await probeIn(t, { files: { [ART]: DOC, ...GROUND_FILES }, script: withGuidance(steps).script })
  assert.deepEqual(keysOf(result), STANDING)
  assert.deepEqual(result.coverage.failed_channels, [])
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage))
})

// --- units and probers -------------------------------------------------------------------------

const RICH_DOC = [
  '# Limiter',
  'a preamble line before any section',
  '## Intent',
  'limit inbound requests per key',
  '```',
  '## not a heading inside a fence',
  '```',
  '## Design',
  'a token bucket per key',
  '## Design',
  'a second design section',
].join('\n') + '\n'

test('the units are every axis against every section of the snapshot', async (t) => {
  const sections = sectionsOf(RICH_DOC)
  const units = unitsOf(STANDING, sections)
  const skipped = units[units.length - 1]
  const { script } = scriptFor(RICH_DOC, STANDING, { probers: { 1: (u) => [{ output: proberOut(u, { skip: [skipped] }) }] } })
  const { rig, result } = await probeIn(t, { files: { [ART]: RICH_DOC }, script })
  assert.equal(result.units.total, STANDING.length * sections.length)
  assert.equal(result.units.ruled, units.length - 1)
  const brief = proberBrief(rig, 1)
  for (const u of units) assert.ok(brief.includes(u), 'the brief names the unit ' + u)
})

test('one prober holds every axis of a short document', async (t) => {
  const { rig, result } = await probeIn(t, { script: scriptFor(DOC, STANDING).script })
  const calls = proberCalls(rig)
  assert.deepEqual(calls.map((c) => c.thread.key), ['prober:1'])
  assert.deepEqual(result.analysts, [STANDING])
})

const longDoc = (n) => ['# Long', '', '## Body', ...Array.from({ length: n - 3 }, (_, i) => 'body line number ' + (i + 4))].join('\n') + '\n'

test('a long document buys a prober per 400 lines', async (t) => {
  const doc = longDoc(801)
  assert.equal(linesOf(doc).length, 801)
  const { rig, result } = await probeIn(t, { files: { [ART]: doc }, script: scriptFor(doc, STANDING).script })
  const n = Math.ceil(801 / 400)
  assert.equal(proberCalls(rig).length, n)
  assert.deepEqual(result.analysts, deal(STANDING, n))
})

test('a long checklist buys a prober per 12 axes', async (t) => {
  const extra = Array.from({ length: 21 }, (_, i) => 'axis-' + String(i + 1).padStart(2, '0'))
  const keys = [...STANDING, ...extra]
  const { rig, result } = await probeIn(t, {
    files: { [ART]: DOC, ...GROUND_FILES }, script: withGuidance([{ output: axesOut(extra.map((k) => axis(k))) }], keys).script,
  })
  assert.equal(keys.length, 25)
  const n = Math.ceil(25 / 12)
  assert.equal(proberCalls(rig).length, n)
  assert.deepEqual(result.analysts, deal(keys, n))
})

test('no more probers than axes', async (t) => {
  const doc = longDoc(2000)
  const { rig, result } = await probeIn(t, { files: { [ART]: doc }, script: scriptFor(doc, STANDING).script })
  assert.equal(proberCalls(rig).length, STANDING.length)
  assert.deepEqual(result.analysts, STANDING.map((k) => [k]))
})

test("every dispatch runs as its role at that role's tier", async (t) => {
  const { rig } = await probeIn(t, {
    files: { [ART]: DOC, ...GROUND_FILES }, script: withGuidance([{ output: axesOut([]) }], STANDING, { perAxis: true }).script, over: { per_axis: true },
  })
  const scout = tierFor(loadRole('scout').role, { intelligence: 'normal' })
  const analyst = tierFor(loadRole('analyst').role, { intelligence: 'normal' })
  const [locate] = callsOf(rig, 'locate')
  assert.deepEqual([locate.role.name, locate.schema, locate.tier], ['scout', schemaOf('search'), scout])
  const [axesCall] = callsOf(rig, 'axes')
  assert.deepEqual([axesCall.role.name, axesCall.schema, axesCall.tier], ['analyst', schemaOf('axes'), analyst])
  const calls = proberCalls(rig)
  assert.equal(calls.length, STANDING.length)
  for (const c of calls) assert.deepEqual([c.role.name, c.schema, c.tier], ['analyst', schemaOf('prober'), analyst], c.thread.key)
})

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test("each prober's brief holds the artefact, every line after its number", async (t) => {
  const { rig, args } = await probeIn(t, { script: scriptFor(DOC, STANDING, { perAxis: true }).script, over: { per_axis: true } })
  const calls = proberCalls(rig)
  assert.equal(calls.length, STANDING.length)
  for (const c of calls) {
    const briefLines = c.brief.replace(/\r\n/g, '\n').split('\n')
    linesOf(args.artifact_text).forEach((line, i) => {
      const own = new RegExp('^\\s*' + (i + 1) + '(?![0-9])[^A-Za-z0-9]*' + escape(line) + '\\s*$')
      assert.ok(briefLines.some((l) => own.test(l)), c.thread.key + ': line ' + (i + 1) + ' stands after its number')
    })
  }
})

test("each prober's brief holds its own axes with their charges and no other prober's", async (t) => {
  const doc = longDoc(801)
  const returned = [axis('alpha', 'CHARGE_ALPHA_TOKEN check every retry'), axis('beta', 'CHARGE_BETA_TOKEN check every bound')]
  const keys = [...STANDING, 'alpha', 'beta']
  const { script, groups } = scriptFor(doc, keys, { ...located([GUIDE_HIT]), axes: [{ output: axesOut(returned) }] })
  const { rig, result } = await probeIn(t, { files: { [ART]: doc, ...GROUND_FILES }, script })
  assert.deepEqual(result.analysts, groups)
  const charge = { alpha: 'CHARGE_ALPHA_TOKEN check every retry', beta: 'CHARGE_BETA_TOKEN check every bound' }
  groups.forEach((g, i) => {
    const brief = proberBrief(rig, i + 1)
    for (const [k, text] of Object.entries(charge)) {
      if (g.includes(k)) assert.ok(brief.includes(text), 'prober:' + (i + 1) + ' holds the charge of ' + k)
      else assert.ok(!brief.includes(text), 'prober:' + (i + 1) + ' holds no charge of ' + k)
    }
  })
})

test("each prober's brief lists the units it rules and no other prober's", async (t) => {
  const { script, unitsOfGroup } = scriptFor(DOC, STANDING, { perAxis: true })
  const { rig } = await probeIn(t, { script, over: { per_axis: true } })
  unitsOfGroup.forEach((own, i) => {
    const brief = proberBrief(rig, i + 1)
    for (const u of own) assert.ok(brief.includes(u), 'prober:' + (i + 1) + ' names ' + u)
    for (const u of unitsOfGroup.flat().filter((x) => !own.includes(x))) assert.ok(!brief.includes(u), 'prober:' + (i + 1) + ' does not name ' + u)
  })
})

test('the context reaches every prober', async (t) => {
  const context = 'CONTEXT_FROM_THE_SESSION_TOKEN the limiter must survive a restart'
  const { rig } = await probeIn(t, { script: scriptFor(DOC, STANDING, { perAxis: true }).script, over: { per_axis: true, context } })
  const calls = proberCalls(rig)
  assert.equal(calls.length, STANDING.length)
  for (const c of calls) assert.ok(c.brief.includes(context), c.thread.key)
})

const collapse = (s) => s.replace(/\s+/g, ' ').trim()
function ladderBlock() {
  const text = readFileSync(DESIGN_SKILL, 'utf8').replace(/\r\n/g, '\n')
  const open = '<!-- agentics:verbatim design-severity-ladder -->'
  const start = text.indexOf(open)
  assert.ok(start >= 0, 'the design skill holds the design-severity-ladder block')
  const end = text.indexOf('<!-- /agentics:verbatim -->', start)
  return text.slice(start + open.length, end)
}

test("each prober's brief holds the design severity ladder", async (t) => {
  const ladder = collapse(ladderBlock())
  assert.ok(ladder.includes('ambiguity'))
  const { rig } = await probeIn(t, { script: scriptFor(DOC, STANDING, { perAxis: true }).script, over: { per_axis: true } })
  const calls = proberCalls(rig)
  assert.equal(calls.length, STANDING.length)
  for (const c of calls) assert.ok(collapse(c.brief).includes(ladder), c.thread.key)
})

test('the guidance from the root to each root, and the configured guidance, is in every brief', async (t) => {
  const files = {
    [ART]: DOC, ...GROUND_FILES,
    'CLAUDE.md': 'ROOT_CLAUDE_TOKEN keep it plain\n',
    'src/CLAUDE.md': 'SRC_CLAUDE_TOKEN src rules\n',
    'docs/STYLE.md': 'STYLE_GUIDE_TOKEN write short lines\n',
    'src/x.js': 'export const x = 1\n',
  }
  const { script } = withGuidance([{ output: axesOut([]) }], STANDING, { perAxis: true })
  const { rig } = await probeIn(t, { files, script, config: { guidance: ['docs/STYLE.md'] }, over: { roots: ['src'], per_axis: true } })
  const briefs = [...callsOf(rig, 'axes'), ...proberCalls(rig)]
  assert.equal(briefs.length, 1 + STANDING.length)
  for (const c of briefs) {
    for (const token of ['ROOT_CLAUDE_TOKEN', 'SRC_CLAUDE_TOKEN', 'STYLE_GUIDE_TOKEN']) assert.ok(c.brief.includes(token), c.thread.key + ' holds ' + token)
  }
})

test('no brief points an agent at a file to learn its task', async (t) => {
  const { rig } = await probeIn(t, {
    files: { [ART]: DOC, ...GROUND_FILES }, script: withGuidance([{ output: axesOut([]) }], STANDING, { perAxis: true }).script, over: { per_axis: true },
  })
  assert.ok(rig.calls.length >= 2 + STANDING.length)
  for (const c of rig.calls) assert.ok(!c.brief.includes('.agentics'), c.thread.key + ' names no .agentics path')
})

test('a prober that stops unfinished is not continued, and what it left is open', async (t) => {
  const units = unitsOf(STANDING, sectionsOf(DOC))
  const left = units.filter((u) => u.endsWith('@design'))
  const { script } = scriptFor(DOC, STANDING, {
    probers: { 1: (u) => [{ output: proberOut(u, { skip: left, over: { stop_reason: 'unfinished', not_reached: 'the design section' } }) }] },
  })
  const { rig, result } = await probeIn(t, { script })
  assert.equal(callsOf(rig, 'prober:1').length, 1)
  assert.deepEqual(sorted(result.units.open), sorted(left))
})

test("what a prober names in not_reached is read into the coverage's unreached", async (t) => {
  const { script } = scriptFor(DOC, STANDING, {
    probers: { 1: (u) => [{ output: proberOut(u, { over: { stop_reason: 'unfinished', not_reached: 'the design section' } }) }] },
  })
  const { result } = await probeIn(t, { script })
  assert.ok(result.coverage.unreached.some((l) => l.includes('prober:1') && l.includes('the design section')), JSON.stringify(result.coverage))
})

// --- the record --------------------------------------------------------------------------------

test('every prober returned: the round is recorded once, anchored to the snapshot', async (t) => {
  const findings = [finding('yagni', 'gap', 'intent', 4), finding('invariants', 'note', 'design', 8)]
  const { script } = scriptFor(DOC, STANDING, { probers: { 1: (u) => [{ output: proberOut(u, { findings }) }] } })
  const { rig, args, result } = await probeIn(t, { script })
  const returns = probeReturns(rig.repo)
  assert.equal(returns.length, 1)
  assert.equal(result.review, returns[0].replace(/\.json$/, ''))
  assert.deepEqual(result.findings.map((f) => [f.id, f.carried]), [['P1', false], ['P2', false]])
  const items = liveItems(rig.repo)
  for (const f of result.findings) {
    const item = items.get(f.item)
    assert.ok(item, f.id + ' is in the store')
    assert.ok(item.spans.length > 0 && item.spans.every((s) => s.at === result.snapshot))
  }
  assert.equal(result.snapshot, reviewScope(rig.repo, args.artifact).snapshot)
  assert.deepEqual(result.unrecorded, [])
})

test('the findings file holds every unit ruling', async (t) => {
  const outputs = []
  const { script } = scriptFor(DOC, STANDING, {
    perAxis: true,
    probers: Object.fromEntries([1, 2, 3, 4].map((n) => [n, (u) => {
      const out = proberOut(u, { findings: n === 2 ? [finding('invariants', 'note', 'intent', 4)] : [] })
      outputs.push(out)
      return [{ output: out }]
    }])),
  })
  const { result } = await probeIn(t, { script, over: { per_axis: true } })
  const file = JSON.parse(readFileSync(result.findings_file, 'utf8'))
  const byUnit = (a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0)
  const expected = outputs.flatMap((o) => o.units).map(({ unit, ruling, why }) => ({ unit, ruling, why })).sort(byUnit)
  assert.equal(expected.length, STANDING.length * sectionsOf(DOC).length)
  assert.deepEqual([...file.units].sort(byUnit), expected)
})

/** Four probers, one axis each, each with a note; prober:2 fails. */
function secondFails() {
  return scriptFor(DOC, STANDING, {
    perAxis: true,
    probers: Object.fromEntries([1, 2, 3, 4].map((n) => [n, (u) => (n === 2
      ? [FAIL]
      : [{ output: proberOut(u, { findings: [finding(STANDING[n - 1], 'note', 'intent', 4)] }) }])])),
  })
}

test('a prober that fails records nothing and leaves its units open', async (t) => {
  const { script, unitsOfGroup } = secondFails()
  const { rig, result } = await probeIn(t, { script, over: { per_axis: true } })
  assert.deepEqual(probeReturns(rig.repo), [])
  assert.equal(itemsIn(rig.repo).length, 0)
  assert.ok(result.coverage.failed_channels.includes('probe'), JSON.stringify(result.coverage))
  assert.deepEqual(sorted(result.units.open), sorted(unitsOfGroup[1]))
  assert.equal(result.findings.length, STANDING.length - 1, 'every prober but the failed one lists its finding')
  assert.ok(result.findings.every((f) => f.item === ''))
  assert.deepEqual(sorted(result.unrecorded), sorted(result.findings.map((f) => f.id)))
  assert.equal(result.snapshot, '')
  assert.equal(result.coverage.complete, false)
  assert.equal(result.ratifiable, false)
})

test('a relaunch after a prober failed calls only it and records the round once', async (t) => {
  const { script, unitsOfGroup } = secondFails()
  const { rig, args } = await probeIn(t, { script, over: { per_axis: true } })
  const again = rig.relaunch({ 'analyst||prober:2': [{ output: proberOut(unitsOfGroup[1]) }] })
  const result = await probe(again.ctx, args)
  assert.deepEqual(again.calls.map((c) => [c.thread.key, c.resume]), [['prober:2', true]])
  assert.equal(probeReturns(rig.repo).length, 1)
  assert.deepEqual(result.coverage.failed_channels, [])
  assert.deepEqual(result.units.open, [])
  assert.equal(result.snapshot, reviewScope(rig.repo, args.artifact).snapshot)
})

test('a relaunch keeps the snapshot its first start took', async (t) => {
  const { script, unitsOfGroup } = secondFails()
  const { rig, args } = await probeIn(t, { script, over: { per_axis: true } })
  const first = reviewScope(rig.repo, args.artifact).snapshot
  writeFileSync(args.artifact, DOC.replace('callers see a retry hint', 'callers see an edited hint'))
  const edited = reviewScope(rig.repo, args.artifact).snapshot
  assert.notEqual(edited, first)
  const again = rig.relaunch({ 'analyst||prober:2': [{ output: proberOut(unitsOfGroup[1]) }] })
  const result = await probe(again.ctx, argsFor(rig.repo, ART, { per_axis: true }))
  assert.equal(result.snapshot, first)
})

test('a finding the store refuses is unrecorded and the snapshot is empty', async (t) => {
  const refused = finding('yagni', 'gap', 'intent', 4, { claim: '' })
  const { script } = scriptFor(DOC, STANDING, { probers: { 1: (u) => [{ output: proberOut(u, { findings: [refused] }) }] } })
  const { rig, result } = await probeIn(t, { script })
  assert.deepEqual(result.unrecorded, ['P1'])
  assert.equal(result.snapshot, '')
  assert.equal(result.review, '')
  assert.deepEqual(probeReturns(rig.repo), [])
})

// --- the gate ----------------------------------------------------------------------------------

test('a unit no prober ruled is open', async (t) => {
  const units = unitsOf(STANDING, sectionsOf(DOC))
  const left = units[1]
  const { script } = scriptFor(DOC, STANDING, { probers: { 1: (u) => [{ output: proberOut(u, { skip: [left] }) }] } })
  const { result } = await probeIn(t, { script })
  assert.equal(result.units.total, units.length)
  assert.equal(result.units.ruled, units.length - 1)
  assert.deepEqual(result.units.open, [left])
  assert.equal(result.coverage.complete, false)
  assert.equal(result.ratifiable, false)
  assert.ok(result.coverage.unreached.length > 0)
})

test('a ruling for a unit the prober was not handed rules nothing', async (t) => {
  const stolen = 'invariants@intent'
  const { script, unitsOfGroup } = scriptFor(DOC, STANDING, {
    perAxis: true,
    probers: {
      1: (u) => [{ output: proberOut(u, { extra: [stolen] }) }],
      2: (u) => [{ output: proberOut(u, { skip: [stolen] }) }],
    },
  })
  assert.ok(unitsOfGroup[1].includes(stolen) && !unitsOfGroup[0].includes(stolen))
  const { result } = await probeIn(t, { script, over: { per_axis: true } })
  assert.deepEqual(result.units.open, [stolen])
  assert.equal(result.coverage.complete, false)
})

test('every ambiguity is listed and keeps the probe unratifiable', async (t) => {
  const findings = [finding('ambiguity', 'ambiguity', 'intent', 4), finding('yagni', 'gap', 'design', 8), finding('invariants', 'note', 'design', 8)]
  const { script } = scriptFor(DOC, STANDING, { probers: { 1: (u) => [{ output: proberOut(u, { findings }) }] } })
  const { result } = await probeIn(t, { script })
  const ambiguous = result.findings.filter((f) => f.severity === 'ambiguity').map((f) => f.id)
  assert.equal(ambiguous.length, 1)
  assert.deepEqual(result.ambiguities, ambiguous)
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage))
  assert.equal(result.ratifiable, false)
})

test('a gap or a note leaves a complete probe ratifiable', async (t) => {
  const findings = [finding('yagni', 'gap', 'design', 8), finding('invariants', 'note', 'design', 8)]
  const { script } = scriptFor(DOC, STANDING, { probers: { 1: (u) => [{ output: proberOut(u, { findings }) }] } })
  const { result } = await probeIn(t, { script })
  assert.deepEqual(result.ambiguities, [])
  assert.equal(result.coverage.complete, true)
  assert.equal(result.ratifiable, true)
})

test('a complete probe declares its locating search and carries its resumable', async (t) => {
  const { rig, result } = await probeIn(t, { script: scriptFor(DOC, STANDING).script })
  const { declared, ...rest } = result.coverage
  assert.deepEqual(rest, { complete: true, dropped: [], incomplete: [], failed_channels: [], unreached: [], resumable: rig.ctx.resumable })
  assert.ok(declared.some((l) => l.startsWith('locate: done')), JSON.stringify(declared))
})

// --- the result's shape: one round with one note finding, run once -----------------------------

let shapedRig = null
let shaped = null
after(() => { if (shapedRig) shapedRig.cleanup() })
/** One probe round with one note finding, run by the first test that asks. */
function shapedRound() {
  shaped ??= (async () => {
    const { script } = scriptFor(DOC, STANDING, {
      probers: { 1: (u) => [{ output: proberOut(u, { findings: [finding('yagni', 'note', 'design', 8)] }) }] },
    })
    shapedRig = programRig({ files: { [ART]: DOC }, script })
    const args = argsFor(shapedRig.repo, ART)
    return { args, result: await probe(shapedRig.ctx, args) }
  })()
  return shaped
}

test('the result holds the fields of a probe result', async () => {
  const { result } = await shapedRound()
  for (const key of ['artifact', 'axes', 'analysts', 'shared_ground', 'guidance_read', 'repo_ground', 'units', 'findings', 'findings_file',
    'ambiguities', 'ratifiable', 'snapshot', 'scope', 'unrecorded', 'review', 'coverage']) {
    assert.ok(key in result, 'the result holds ' + key)
  }
})

test('the scope of a full round is the whole document', async () => {
  const { args, result } = await shapedRound()
  assert.equal(result.scope.full, true)
  assert.deepEqual(result.scope.changed, [{ start: 1, end: linesOf(args.artifact_text).length }])
})

// --- relaunch and read-back --------------------------------------------------------------------

test('a relaunch calls nothing that returned', async (t) => {
  const findings = [finding('ambiguity', 'ambiguity', 'intent', 4)]
  const { script } = scriptFor(DOC, STANDING, { probers: { 1: (u) => [{ output: proberOut(u, { findings }) }] } })
  const { rig, args, result } = await probeIn(t, { script })
  const again = rig.relaunch({})
  const second = await probe(again.ctx, args)
  assert.deepEqual(second, result)
  assert.equal(again.calls.length, 0)
  assert.equal(probeReturns(rig.repo).length, 1)
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

test('the result reads back through reviewed --from-run', { timeout: 120_000 }, async (t) => {
  const findings = [finding('ambiguity', 'ambiguity', 'intent', 4)]
  const { script } = scriptFor(DOC, STANDING, { probers: { 1: (u) => [{ output: proberOut(u, { findings }) }] } })
  const { rig, result } = await probeIn(t, { files: { [SPEC]: DOC }, path: SPEC, script })
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage))
  const [ambiguity] = result.findings.filter((f) => f.severity === 'ambiguity')
  assert.ok(ambiguity && ambiguity.item, 'the ambiguity was recorded')
  const line = readBack(rig, result)
  assert.equal(line.complete, true)
  assert.deepEqual(line.remaining, [])
  assert.deepEqual(line.ambiguities, [ambiguity.item])
})

test("an incomplete probe's loss reads back as what remains", { timeout: 120_000 }, async (t) => {
  const { script, unitsOfGroup } = secondFails()
  const { rig, result } = await probeIn(t, { files: { [SPEC]: DOC }, path: SPEC, script, over: { per_axis: true } })
  const line = readBack(rig, result)
  assert.equal(line.complete, false)
  for (const u of unitsOfGroup[1]) assert.ok(line.remaining.includes(u), 'remaining holds ' + u)
  assert.ok(line.remaining.includes('channel:probe'), JSON.stringify(line.remaining))
})
