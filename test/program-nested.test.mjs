// test/program-nested.test.mjs — pins the evidence programs nested under `scoped`: two surveys in one
// context keep their threads and steps apart, a scoped survey or probe returns what the unscoped one
// returns for the same script, and a relaunch through the scope replays; and the minors fixed with
// them: a pool unreadable after the re-judge is reported, the pool's prompt text carries no empty
// section, a pruned snapshot is reported rather than thrown, a carried finding keeps its own claim, an
// unchanged round's shared ground has the full round's keys, and a judge is compared in the session
// its thread runs in now.
//
// Design: docs/DESIGN.md#programs, docs/DESIGN.md#survey, docs/DESIGN.md#probe, docs/DESIGN.md#coverage-block.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { carriedFindings, liveItems, recordItems, recordProbe, reviewScope, sectionsOf, unitsOf } from '../lib/evidence.mjs'
import { appendProject } from '../lib/ledger.mjs'
import { programContext, scoped, threadOf } from '../lib/programs/common.mjs'
import { probe } from '../lib/programs/probe.mjs'
import { review } from '../lib/programs/review.mjs'
import { survey } from '../lib/programs/survey.mjs'
import { evidenceItemsPath, evidenceSnapshotsDir, posix, sessionOf } from '../lib/store.mjs'
import { hitTurn } from './fast/harness/scout.mjs'
import { closedSearch } from './harness/navigator.mjs'
import { programRig } from './harness/program-rig.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })

function rigFor(t, opts = {}) {
  const rig = programRig(opts)
  t.after(() => rig.cleanup())
  return rig
}

const RULER = 'ruler:search:'
/** `thread` under `<prefix>/`; a search ruler's thread holds the prefixed search key after `ruler:search:`. */
const underPrefix = (prefix, thread) => (thread.startsWith(RULER) ? RULER + prefix + '/' + thread.slice(RULER.length) : prefix + '/' + thread)
/** `script` with every thread under `<prefix>/`, as a scoped program's dispatches key it. */
const prefixed = (prefix, script) => Object.fromEntries(Object.entries(script).map(([key, steps]) => {
  const [role, node, thread] = key.split('|')
  return [role + '|' + node + '|' + underPrefix(prefix, thread), steps]
}))
/** A result as JSON with the rig's repository spelt `<repo>`, so two rigs' results compare. */
const portable = (result, repo) => {
  let text = JSON.stringify(result)
  for (const spelling of [repo, posix(repo)]) text = text.split(JSON.stringify(spelling).slice(1, -1)).join('<repo>')
  return JSON.parse(text)
}
const stepKeys = (rig) => rig.log.entries().filter((e) => e.kind === 'step').map((e) => e.key)

// --- the survey's world ------------------------------------------------------------------------

const A = 'src/a.js'
const lines = (word, n) => Array.from({ length: n }, (_, i) => `${word} line ${i + 1}`).join('\n') + '\n'
const SURVEY_FILES = { [A]: lines('alpha', 40) }
const EDIT = 'EDITED-9f1 line 11'
const editLine = (repo, n, text) => writeFileSync(join(repo, 'src', 'a.js'), SURVEY_FILES[A].replace(new RegExp(`^alpha line ${n}$`, 'm'), text))

const topic = (key) => ({ key, find: 'FIND-' + key, subtree: 'src' })
const planOut = (topics) => ({ topics, common_ground: '', history_question: '', docs_question: '' })
const claimOf = (key) => 'NEW-' + key + ' claim from this run'
const itemOut = (key, line) => ({ topic: key, kind: 'behaviour', claim: claimOf(key), spans: [{ path: A, start: line, end: line }], queries: [], sources: [], rests_on: [] })
/** A survey planning `planned` and scouting and judging `searched`, each topic at its own line. */
function surveyScript({ planned, searched = planned.map((t) => t.key) }) {
  const s = { 'analyst||plan': [{ output: planOut(planned) }] }
  searched.forEach((key, i) => {
    s['scout||scout:' + key] = [hitTurn([{ path: A, line: 3 + i, note: 'NOTE-' + key }])]
  })
  if (searched.length > 0) {
    s['analyst||judge:1'] = [{ output: {
      items: searched.map((key, i) => itemOut(key, 3 + i)), risks: [],
      units: searched.map((key) => ({ unit: key, ruling: 'anchored', ids: [], why: 'anchored' })),
    } }]
  }
  return s
}
const surveyArgs = (over = {}) => ({
  question: 'How does the loader resolve a module path?', roots: ['src'], notes: '', prior: '', max_topics: 8,
  intelligence: 'normal', pace: 'balanced', ground: [], ...over,
})

const OLD_Q = 'An earlier question about the loader?'
const seedItem = (topicKey, claim) =>
  ({ question: OLD_Q, topic: topicKey, ground: ['src'], kind: 'behaviour', claim, spans: [{ path: A, start: 10, end: 12 }], queries: [], sources: [], rests_on: [] })
function seed(repo, items) {
  const out = recordItems(repo, '20250101-000000-survey', items)
  assert.equal(out.ok, true, JSON.stringify(out))
  return out.ids
}

// --- the probe's world -------------------------------------------------------------------------

const STANDING = ['ambiguity', 'invariants', 'yagni', 'reinvention']
const ART = 'docs/spec.md'
const DOC = [
  '# Limiter', '', '## Intent', 'limit inbound requests per key', 'callers see a retry hint', '',
  '## Risks', 'a burst may starve other keys', 'the refill clock may drift', '', '## Design', 'a token bucket per key, refilled each second',
].join('\n') + '\n'
const EDITED = DOC.replace('the refill clock may drift', 'the refill clock may drift under load')
const native = (root, path) => join(root, ...path.split('/'))
const probeArgs = (root, over = {}) => ({
  artifact: native(root, ART), artifact_text: readFileSync(native(root, ART), 'utf8').trim(), roots: ['.'], context: '', per_axis: false, since: '', ...over,
})
const finding = (axis, severity, section, start, claim) => ({ axis, severity, section, claim, evidence: 'line ' + start, start, end: start })
const proberOut = (units, findings = []) => ({
  findings,
  units: units.map((unit) => ({ unit, ruling: findings.some((f) => f.axis + '@' + f.section === unit) ? 'findings' : 'clean', ids: [], why: 'why ' + unit })),
  notes: '', stop_reason: 'exhausted', not_reached: '',
})
/** The locate script that ends every ask of the search over `text`: a closing turn, the stall, and the ruling. */
function locateScript(text) {
  return closedSearch({ name: 'locate', asks: ['guidance', ...sectionsOf(text).map((s) => 'ground:' + s.slug)] })
}
/** A full round of `text`: one prober holds the four standing axes (twelve lines buy one), `prober` its steps. */
function probeScript(text, { findings = [], prober } = {}) {
  const units = unitsOf(STANDING, sectionsOf(text))
  return { ...locateScript(text), 'analyst||prober:1': prober ? prober(units) : [{ output: proberOut(units, findings) }] }
}
const NOTE = finding('yagni', 'note', 'intent', 4, 'CARRIED-NOTE-a1 the key is never defined')
const GAP = finding('reinvention', 'gap', 'design', 12, 'CARRIED-GAP-b2 a token bucket exists already')

// --- nested surveys ----------------------------------------------------------------------------

test('two scoped surveys in one context keep their threads and steps apart', async (t) => {
  const rig = rigFor(t, {
    files: SURVEY_FILES,
    script: {
      ...prefixed('survey:f1', surveyScript({ planned: [topic('loader')] })),
      ...prefixed('survey:f2', surveyScript({ planned: [topic('cache')] })),
    },
  })
  const [one, two] = await Promise.all([
    survey(scoped(rig.ctx, 'survey:f1'), surveyArgs()),
    survey(scoped(rig.ctx, 'survey:f2'), surveyArgs({ question: 'How long does the cache keep a path?' })),
  ])
  for (const call of rig.calls) assert.match(call.thread.key.replace(RULER, ''), /^survey:f[12]\//, call.thread.key)
  const threads = (p) => new Set(rig.calls.filter((c) => c.thread.key.startsWith(p + '/')).map((c) => c.thread.key.slice(p.length + 1)))
  assert.deepEqual([...threads('survey:f1')].sort(), ['judge:1', 'plan', 'scout:loader'])
  assert.deepEqual([...threads('survey:f2')].sort(), ['judge:1', 'plan', 'scout:cache'])
  const keys = stepKeys(rig)
  assert.ok(keys.length > 0)
  for (const key of keys) assert.match(key, /^survey:f[12]\//, key)
  assert.deepEqual(one.topics.map((x) => x.key), ['loader'])
  assert.deepEqual(two.topics.map((x) => x.key), ['cache'])
  assert.equal(one.coverage.complete, true, JSON.stringify(one.coverage))
  assert.equal(two.coverage.complete, true, JSON.stringify(two.coverage))
})

test('a scoped survey returns what the unscoped survey returns for the same script', async (t) => {
  const script = surveyScript({ planned: [topic('loader')] })
  const plain = rigFor(t, { files: SURVEY_FILES, script })
  const nested = rigFor(t, { files: SURVEY_FILES, script: prefixed('survey:f1', script) })
  const want = await survey(plain.ctx, surveyArgs())
  const got = await survey(scoped(nested.ctx, 'survey:f1'), surveyArgs())
  assert.deepEqual(portable(got, nested.repo), portable(want, plain.repo))
})

test('a relaunched scoped survey calls nothing that returned', async (t) => {
  const rig = rigFor(t, { files: SURVEY_FILES, script: prefixed('survey:f1', surveyScript({ planned: [topic('loader')] })) })
  const first = await survey(scoped(rig.ctx, 'survey:f1'), surveyArgs())
  const again = rig.relaunch({})
  assert.deepEqual(await survey(scoped(again.ctx, 'survey:f1'), surveyArgs()), first)
  assert.equal(again.calls.length, 0)
})

// --- a nested probe ----------------------------------------------------------------------------

test('a scoped probe returns what the unscoped probe returns for the same script', async (t) => {
  const script = probeScript(DOC, { findings: [NOTE] })
  const plain = rigFor(t, { files: { [ART]: DOC }, script })
  const nested = rigFor(t, { files: { [ART]: DOC }, script: prefixed('probe:f:1', script) })
  const want = await probe(plain.ctx, probeArgs(plain.repo))
  const got = await probe(scoped(nested.ctx, 'probe:f:1'), probeArgs(nested.repo))
  assert.ok(nested.calls.length > 0)
  for (const call of nested.calls) assert.ok(call.thread.key.replace(RULER, '').startsWith('probe:f:1/'), call.thread.key)
  for (const key of stepKeys(nested)) assert.ok(key.startsWith('probe:f:1/'), key)
  assert.equal(want.findings.length, 1, 'the fixture records one finding')
  assert.deepEqual(portable(got, nested.repo), portable(want, plain.repo))
})

// --- M10: the pool read after the re-judge -----------------------------------------------------

test('a pool unreadable after the re-judge is reported, and its suspect items searched again', async (t) => {
  const base = rigFor(t, { files: SURVEY_FILES })
  const [id] = seed(base.repo, [seedItem('loader', 'SUSPECT-a77 the loader reads line eleven')])
  editLine(base.repo, 11, EDIT)
  const rig = base.relaunch({
    'analyst||rejudge:1': [{ output: { rulings: [{ id, ruling: 'holds', why: 'it holds' }] } }],
    ...surveyScript({ planned: [], searched: ['loader'] }),
  })
  // The pool turns unreadable once the rulings are journaled and readable again once the second read is.
  const file = evidenceItemsPath(rig.repo)
  let saved = null
  const log = {
    entries: () => rig.log.entries(),
    append(kind, fields) {
      const out = rig.log.append(kind, fields)
      if (kind === 'step' && fields.key === 'rulings:1') {
        saved = readFileSync(file, 'utf8')
        appendProject(rig.repo, 'items', [{ kind: 'item', item: { id: 'I0000abcd', ground: 'src' } }])
      }
      if (kind === 'step' && fields.key === 'pool:after' && saved !== null) writeFileSync(file, saved)
      return out
    },
  }
  const result = await survey(programContext({ intelligence: 'normal', ...rig.ctx, log }), surveyArgs({ ground: ['src'] }))
  assert.ok(saved !== null, 'the fixture: the rulings were journaled')
  assert.equal(rig.calls.filter((c) => c.thread.key === 'scout:loader').length, 1, 'one search')
  assert.ok(result.coverage.failed_channels.includes('pool'), JSON.stringify(result.coverage))
  assert.ok(result.coverage.unreached.some((l) => l.includes('pool') && l.includes('re-judge')), JSON.stringify(result.coverage.unreached))
  assert.equal(result.coverage.complete, false)
})

// --- M11: the pool as a prompt -----------------------------------------------------------------

const KNOWN = 'KNOWN-c41 the loader caches resolved paths'
const EMPTY_SECTIONS = ['SUSPECT —', 'STALE —', '(none)']

test('the plan and judge briefs carry the standing items with no empty suspect or stale section', async (t) => {
  const base = rigFor(t, { files: SURVEY_FILES })
  seed(base.repo, [seedItem('known', KNOWN)])
  const rig = base.relaunch(surveyScript({ planned: [topic('loader')] }))
  await survey(rig.ctx, surveyArgs({ ground: ['src'] }))
  const briefs = rig.calls.filter((c) => c.thread.key === 'plan' || c.thread.key === 'judge:1').map((c) => c.brief)
  assert.equal(briefs.length, 2)
  for (const brief of briefs) {
    assert.ok(brief.includes(KNOWN), 'the standing item')
    // the judge's search excerpts follow its pool text and render their own empty lists as (none)
    const pooled = brief.split('EVIDENCE —')[0]
    for (const empty of EMPTY_SECTIONS) assert.ok(!pooled.includes(empty), 'no ' + empty + ' in ' + pooled)
  }
})

// --- M13: a pruned snapshot --------------------------------------------------------------------

test('a snapshot pruned from the store before a relaunch is reported, not thrown', async (t) => {
  const rig = rigFor(t, { files: { [ART]: DOC }, script: probeScript(DOC, { prober: () => [{ status: 'failed', cause: 'host_error' }] }) })
  const first = await probe(rig.ctx, probeArgs(rig.repo))
  assert.equal(first.snapshot, '', 'the fixture: the first round was not recorded')
  rmSync(evidenceSnapshotsDir(rig.repo), { recursive: true, force: true })
  const items = liveItems(rig.repo).size
  const again = rig.relaunch(probeScript(DOC, { findings: [NOTE] }))
  const result = await probe(again.ctx, probeArgs(rig.repo))
  assert.ok(result.coverage.failed_channels.includes('record'), JSON.stringify(result.coverage))
  assert.ok(result.coverage.unreached.some((l) => l.includes('snapshot')), JSON.stringify(result.coverage.unreached))
  assert.equal(result.coverage.complete, false)
  assert.equal(result.snapshot, '')
  assert.equal(result.ratifiable, false)
  assert.equal(liveItems(rig.repo).size, items, 'nothing is recorded against a snapshot the store lost')
})

// --- M19: the narrowed round -------------------------------------------------------------------

/** The last review of DOC recorded over `findings`, then `edited` written; the scope and each finding's item. */
function reviewedThenEdited(t, findings, edited) {
  const rig = rigFor(t, { files: { [ART]: DOC } })
  const file = native(rig.repo, ART)
  const { snapshot: since } = reviewScope(rig.repo, file)
  const rec = recordProbe(rig.repo, { file, snapshot: since, from: [{ findings }], bundle: [STANDING.join('+')] })
  assert.equal(rec.recorded, true, JSON.stringify(rec))
  if (edited !== DOC) writeFileSync(file, edited)
  const claimOfItem = Object.fromEntries(findings.map((f, i) => [rec.findings[i].item, f.claim]))
  return { rig, since, scope: reviewScope(rig.repo, file, since), claimOfItem }
}

test('each carried finding reaches the prober beside its own claim', async (t) => {
  const w = reviewedThenEdited(t, [NOTE, GAP], EDITED)
  const carried = carriedFindings(w.scope)
  assert.equal(carried.length, 2, 'the fixture carries both findings')
  const touched = sectionsOf(EDITED).filter((s) => w.scope.changed.some((r) => r.start <= s.end && s.start <= r.end))
  const run = w.rig.relaunch({ ...locateScript(EDITED), 'analyst||prober:1': [{ output: proberOut(unitsOf(STANDING, touched)) }] })
  await probe(run.ctx, probeArgs(w.rig.repo, { since: w.since }))
  const [call] = run.calls.filter((c) => c.thread.key === 'prober:1')
  const briefLines = call.brief.split('\n')
  for (const f of carried) {
    const line = briefLines.find((l) => l.startsWith('- ' + f.id + ' ['))
    assert.ok(line, f.id + ' is carried')
    assert.ok(line.endsWith(': ' + w.claimOfItem[f.item]), f.id + ' with its own claim: ' + line)
  }
})

test("an unchanged round's shared ground has the full round's keys, nothing resolved", async (t) => {
  const full = rigFor(t, { files: { [ART]: DOC }, script: probeScript(DOC) })
  const fullResult = await probe(full.ctx, probeArgs(full.repo))
  const w = reviewedThenEdited(t, [NOTE], DOC)
  const run = w.rig.relaunch({})
  const result = await probe(run.ctx, probeArgs(w.rig.repo, { since: w.since }))
  assert.equal(run.calls.length, 0, 'the fixture: an unchanged round buys no agent')
  assert.deepEqual(Object.keys(result.shared_ground).sort(), Object.keys(fullResult.shared_ground).sort())
  assert.equal(result.shared_ground.resolved, false)
  for (const [key, value] of Object.entries(result.shared_ground)) if (key !== 'resolved') assert.equal(value, 0, key)
})

// --- M7: a judge's session ---------------------------------------------------------------------

test('a reviewer whose renewed thread shares the producing session is refused', async (t) => {
  const rig = rigFor(t, {
    files: { 'a.js': 'export const a = 1\n' },
    script: { 'reviewer||reviewer': [{ output: { units: [], findings: [], fix_rulings: [], claims: [], notes: '' } }] },
  })
  const dir = mkdtempSync(join(tmpdir(), 'agentics-nested-criteria-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const criteria = '- [ ] the loader returns a plain object'
  writeFileSync(join(dir, 'criteria.md'), criteria + '\n')
  rig.log.append('thread_renewed', { thread: 'reviewer', gen: 1, why: 'raised' })
  const own = threadOf(rig.ctx, { role: 'reviewer', thread: 'reviewer' }).session
  const first = sessionOf({ effort: rig.ctx.effort, execution: rig.run, node: '', role: 'reviewer', thread: 'reviewer', gen: 0 })
  assert.notEqual(own, first, 'the fixture: the renewed session is not the first one')
  const base = git(rig.repo, 'rev-parse', 'HEAD').trim()
  const out = await review(programContext({ intelligence: 'normal', ...rig.ctx, env: { CLAUDE_CODE_SESSION_ID: own } }),
    { base, criteria_file: join(dir, 'criteria.md'), criteria, prior: '' })
  assert.equal(rig.calls.length, 0)
  assert.deepEqual(out.coverage.failed_channels, ['reviewer'])
  assert.equal(out.approved, false)
})
