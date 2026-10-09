// test/program-solutions.test.mjs — pins the solutions program: the frame, one researcher per kept
// angle and the repository scan, each search continued and declared as it stopped, the assessor over
// the distinct candidates, the one journaled record and what its counts mean, the coverage block that
// names every loss, and a relaunch that calls nothing that returned.
//
// Design: docs/DESIGN.md#existing-solutions.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { liveItems } from '../lib/evidence.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import { scopeOf, solutions } from '../lib/programs/solutions.mjs'
import { loadRole, tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { dispatchKey, evidenceReturnsDir, posix } from '../lib/store.mjs'
import { programRig } from './harness/program-rig.mjs'

// --- the world -------------------------------------------------------------------------------

const CAPABILITY = 'Parse TOML configuration files without a native addon.'
const GUIDANCE = 'Keep every module free of runtime dependencies beyond the standard library.'
const FILES = {
  'CLAUDE.md': '# Guide\n\n' + GUIDANCE + '\n',
  'src/config.mjs': 'import { readFileSync } from \'node:fs\'\nexport function readConfig(path) { return readFileSync(path, \'utf8\') }\nexport const DEFAULTS = {}\n',
  'src/loader.mjs': 'export function load() {}\nexport function parseLine(line) { return line.split(\'=\') }\n',
  'packages/parser/index.mjs': 'export const parser = null\n',
  'tools/cfg/check.mjs': 'export const check = () => true\n',
  'docs/want.md': CAPABILITY + '\n',
}

const role = (name) => loadRole(name).role
const SEARCH_STOP_FIELDS = { searched: [], no_match: '', not_reached: '', stop_reason: 'exhausted' }

const frameOut = (over = {}) => ({
  capability_line: 'a pure JavaScript TOML reader',
  hard_constraints: ['runs on Node without compilation'],
  disqualifiers: ['copyleft licence'],
  angles: [{ key: 'npm', find: 'look through the npm registry for TOML readers' }],
  repo_question: 'where does the code already read configuration files',
  ...over,
})
const cand = (name, over = {}) => ({
  name,
  source_url: 'https://example.org/' + name.toLowerCase(),
  what_it_is: name + ' reads TOML documents',
  latest_version: '1.2.3',
  license: 'MIT',
  maintenance: 'released last month',
  covers: 'TOML one point oh',
  does_not_cover: 'writing documents back',
  ...over,
})
const found = (candidates, over = {}) => ({ candidates, ...SEARCH_STOP_FIELDS, ...over })
const hit = (path, line, note = 'reads a configuration file') => ({ path, line, note })
const scanned = (hits, over = {}) => ({ hits, ...SEARCH_STOP_FIELDS, ...over })
const row = (c, disqualifiers_hit = []) => ({ ...c, disqualifiers_hit })
const assessed = (rows, { notes = '', units = rows.map((r) => ({ unit: r.name.toLowerCase(), ruling: 'assessed', why: 'checked' })) } = {}) =>
  ({ assessed: rows, notes, units })

const ok = (output) => ({ output })
const FAILED = { status: 'failed', cause: 'host_error' }

/** A script keyed `<role>||<thread>`: the frame, a researcher per slug, the scan and the assessor. */
function scriptOf({ frame = [ok(frameOut())], research = { npm: [ok(found([cand('alpha')]))] }, repo = [ok(scanned([hit('src/config.mjs', 2)]))], assess } = {}) {
  const s = { 'analyst||frame': frame, 'scout||repo': repo }
  for (const [slug, steps] of Object.entries(research)) s['doc-researcher||research:' + slug] = steps
  if (assess !== undefined) s['analyst||assess'] = assess
  return s
}
const DEFAULT_ASSESS = [ok(assessed([row(cand('alpha'))]))]

function rigFor(t, { files = FILES, script } = {}) {
  const rig = programRig({ files, script })
  t.after(() => rig.cleanup())
  return rig
}

const argsFor = (rig, over = {}) => ({
  capability_file: join(rig.repo, 'docs', 'want.md'),
  capability: CAPABILITY,
  roots: ['.'],
  constraints: '',
  notes: '',
  max_angles: 4,
  intelligence: 'normal',
  ...over,
})

async function sweep(t, script, { args = {}, files } = {}) {
  const rig = rigFor(t, { files, script })
  const result = await solutions(rig.ctx, argsFor(rig, args))
  return { rig, result }
}

const callsOn = (rig, thread) => rig.calls.filter((c) => c.thread.key === thread)
const firstBrief = (rig, thread) => {
  const on = callsOn(rig, thread)
  assert.ok(on.length > 0, 'no call on thread ' + thread)
  return on[0].brief
}
const threads = (rig) => [...new Set(rig.calls.map((c) => c.thread.key))]
const pool = (repo) => [...liveItems(repo).values()]
const externals = (repo) => pool(repo).filter((i) => i.kind === 'external')
const behaviours = (repo) => pool(repo).filter((i) => i.kind === 'behaviour')
const keptReturns = (repo) => (existsSync(evidenceReturnsDir(repo)) ? readdirSync(evidenceReturnsDir(repo)).length : 0)
const linesWith = (lines, ...parts) => lines.filter((l) => parts.every((p) => l.includes(p)))
const failedCause = (rig, roleName, thread) => {
  const key = dispatchKey({ node: '', role: roleName, thread, round: 1 })
  const e = rig.log.entries().findLast((x) => x.kind === 'returned' && x.status === 'failed' && x.dispatch === key)
  assert.ok(e, 'no failed return recorded on ' + thread)
  return e.cause
}
const COUNT_KEYS = ['present', 'candidates', 'viable', 'ruled_out', 'invented', 'lost', 'unanchored', 'unsettled']

// --- nothing to search -----------------------------------------------------------------------

test('a blank capability searches nothing', async (t) => {
  const { rig, result } = await sweep(t, {}, { args: { capability: '   ' } })
  assert.equal(rig.calls.length, 0)
  assert.equal(result.coverage.unreached.length, 1)
  assert.equal(result.coverage.complete, false)
  for (const k of COUNT_KEYS) assert.equal(result.counts[k], 0, k)
  assert.equal(result.summary, '')
  assert.deepEqual(result.items, [])
  assert.equal(result.recorded, false)
  assert.equal(result.measured, false)
})

// --- the frame -------------------------------------------------------------------------------

const MAX = 13
test("the frame's brief holds the capability, the roots, the caller's constraints and notes and the angle bound", async (t) => {
  const constraints = 'must stay under a kilobyte of glue'
  const notes = 'the team once tried a YAML reader and dropped it'
  const roots = ['packages/parser', 'tools/cfg']
  const { rig } = await sweep(t, scriptOf({ assess: DEFAULT_ASSESS }), { args: { constraints, notes, roots, max_angles: MAX } })
  const brief = firstBrief(rig, 'frame')
  for (const text of [CAPABILITY, ...roots, constraints, notes, 'at most ' + MAX + ' independent']) assert.ok(brief.includes(text), 'the frame brief lacks ' + text)
})

test("each dispatch's tier is its role's at the dial", async (t) => {
  for (const intelligence of ['low', 'normal', 'max']) {
    const { rig } = await sweep(t, scriptOf({ assess: DEFAULT_ASSESS }), { args: { intelligence } })
    const tier = (thread) => callsOn(rig, thread)[0].tier
    assert.deepEqual(callsOn(rig, 'frame')[0].schema, schemaOf('frame'), intelligence + ' frame schema')
    assert.deepEqual(callsOn(rig, 'assess')[0].schema, schemaOf('assessment'), intelligence + ' assess schema')
    assert.deepEqual(tier('frame'), tierFor(role('analyst'), { intelligence, base: 'medium' }), intelligence + ' frame')
    assert.deepEqual(tier('assess'), tierFor(role('analyst'), { intelligence, base: 'high' }), intelligence + ' assess')
    assert.deepEqual(tier('research:npm'), tierFor(role('doc-researcher')), intelligence + ' researcher')
    assert.deepEqual(tier('repo'), tierFor(role('scout')), intelligence + ' scan')
  }
})

test('a frame that fails stops the sweep with frame failed', async (t) => {
  const { rig, result } = await sweep(t, scriptOf({ frame: [FAILED], research: {}, repo: [] }))
  assert.equal(rig.calls.length, 1)
  assert.deepEqual(result.coverage.failed_channels, ['frame'])
  assert.ok(linesWith(result.coverage.unreached, 'frame').length > 0)
  assert.equal(result.summary, '')
  assert.equal(liveItems(rig.repo).size, 0)
})

test('a frame with no angles stops the sweep with frame failed', async (t) => {
  const { rig, result } = await sweep(t, scriptOf({ frame: [ok(frameOut({ angles: [] }))], research: {}, repo: [] }))
  assert.equal(rig.calls.length, 1)
  assert.deepEqual(result.coverage.failed_channels, ['frame'])
  assert.equal(result.coverage.complete, false)
  assert.equal(keptReturns(rig.repo), 0)
})

// --- angles and researchers ------------------------------------------------------------------

test('angle keys become slugs, numbered when repeated', async (t) => {
  const keys = ['Node Std Lib', 'npm', 'NPM', '!!']
  const slugs = ['node-std-lib', 'npm', 'npm-2', 'angle']
  const frame = frameOut({ angles: keys.map((key, i) => ({ key, find: 'look in place ' + 'abcd'[i] })) })
  const research = Object.fromEntries(slugs.map((s) => [s, [ok(found([]))]]))
  const { rig } = await sweep(t, scriptOf({ frame: [ok(frame)], research, repo: [ok(scanned([]))] }))
  const researched = threads(rig).filter((k) => k.startsWith('research:')).sort()
  assert.deepEqual(researched, slugs.map((s) => 'research:' + s).sort())
})

test('angles past max_angles are dropped, not searched', async (t) => {
  const frame = frameOut({
    angles: [
      { key: 'Alpha Docs', find: 'look in the alpha docs' }, { key: 'Beta', find: 'look in beta' },
      { key: 'Gamma', find: 'look in gamma' }, { key: 'Delta', find: 'look in delta' },
    ],
  })
  const research = { 'alpha-docs': [ok(found([]))], beta: [ok(found([]))] }
  const { rig, result } = await sweep(t, scriptOf({ frame: [ok(frame)], research, repo: [ok(scanned([]))] }), { args: { max_angles: 2 } })
  assert.deepEqual(result.coverage.dropped, ['gamma', 'delta'])
  assert.equal(result.coverage.complete, false)
  assert.equal(callsOn(rig, 'research:gamma').length, 0)
  assert.equal(callsOn(rig, 'research:delta').length, 0)
})

test('one researcher per angle, with the candidates schema', async (t) => {
  const frame = frameOut({ angles: [{ key: 'npm', find: 'look on npm' }, { key: 'github', find: 'look on github' }] })
  const research = { npm: [ok(found([]))], github: [ok(found([]))] }
  const { rig } = await sweep(t, scriptOf({ frame: [ok(frame)], research, repo: [ok(scanned([]))] }))
  for (const slug of ['npm', 'github']) {
    const on = callsOn(rig, 'research:' + slug)
    assert.equal(on.length, 1, slug)
    assert.equal(on[0].role.name, 'doc-researcher')
    assert.deepEqual(on[0].schema, schemaOf('candidates'))
  }
})

test("a researcher's brief holds what is wanted, the hard constraints, its angle and the caller's constraints", async (t) => {
  const frame = frameOut({
    hard_constraints: ['runs on Node without compilation', 'reads files of several megabytes'],
    disqualifiers: ['copyleft licence', 'abandoned upstream'],
    angles: [{ key: 'npm', find: 'look through the npm registry' }, { key: 'github', find: 'look through github topics' }],
  })
  const constraints = 'must stay under a kilobyte of glue'
  const research = { npm: [ok(found([]))], github: [ok(found([]))] }
  const { rig } = await sweep(t, scriptOf({ frame: [ok(frame)], research, repo: [ok(scanned([]))] }), { args: { constraints } })
  const brief = firstBrief(rig, 'research:npm')
  for (const text of [frame.capability_line, ...frame.hard_constraints, frame.angles[0].find, constraints]) {
    assert.ok(brief.includes(text), 'the researcher brief lacks ' + text)
  }
  for (const text of [...frame.disqualifiers, frame.angles[1].find]) assert.ok(!brief.includes(text), 'the researcher brief holds ' + text)
})

test("a researcher's unfinished round goes on, and every round's candidates are recorded", async (t) => {
  const research = {
    npm: [
      ok(found([cand('alpha')], { stop_reason: 'unfinished', not_reached: 'the changelog pages' })),
      ok(found([cand('beta')])),
    ],
  }
  const assess = [ok(assessed([row(cand('alpha')), row(cand('beta'))]))]
  const { rig } = await sweep(t, scriptOf({ research, assess }))
  assert.equal(callsOn(rig, 'research:npm').length, 2)
  const brief = firstBrief(rig, 'assess')
  assert.ok(brief.includes('alpha') && brief.includes('beta'))
  const names = externals(rig.repo).map((i) => i.detail.name).sort()
  assert.deepEqual(names, ['alpha', 'beta'])
})

test('a researcher that stopped short leaves its angle incomplete', async (t) => {
  const short = found([], { stop_reason: 'unfinished', not_reached: 'the archived mailing list' })
  const { rig, result } = await sweep(t, scriptOf({ research: { npm: [ok(short), ok(short)] } }))
  assert.equal(callsOn(rig, 'research:npm').length, 2)
  assert.ok(result.coverage.incomplete.includes('find:npm'))
  assert.equal(linesWith(result.coverage.unreached, 'find:npm', 'no_progress', 'the archived mailing list').length, 1)
  assert.equal(result.coverage.complete, false)
})

test('a researcher that failed leaves its angle incomplete, and the others are still recorded', async (t) => {
  const frame = frameOut({ angles: [{ key: 'npm', find: 'look on npm' }, { key: 'github', find: 'look on github' }] })
  const research = { npm: [FAILED], github: [ok(found([cand('beta')]))] }
  const assess = [ok(assessed([row(cand('beta'))]))]
  const { rig, result } = await sweep(t, scriptOf({ frame: [ok(frame)], research, assess }))
  assert.ok(result.coverage.incomplete.includes('find:npm'))
  assert.ok(linesWith(result.coverage.unreached, 'find:npm', failedCause(rig, 'doc-researcher', 'research:npm')).length > 0)
  assert.deepEqual(externals(rig.repo).map((i) => i.detail.name), ['beta'])
})

test('every search declares its stop, what it found absent and what it never reached', async (t) => {
  const frame = frameOut({
    angles: [{ key: 'aaa', find: 'look in aaa' }, { key: 'bbb', find: 'look in bbb' }, { key: 'ccc', find: 'look in ccc' }],
  })
  const research = {
    aaa: [
      ok(found([], { stop_reason: 'unfinished', no_match: 'no ini reader on the registry', not_reached: 'the forum threads' })),
      ok(found([], { no_match: 'no streaming reader anywhere' })),
    ],
    bbb: [ok(found([], { not_reached: 'the vendor wiki behind a login' }))],
    ccc: [FAILED],
  }
  const repo = [ok(scanned([], { no_match: 'no toml file in the tree' }))]
  const { result } = await sweep(t, scriptOf({ frame: [ok(frame)], research, repo }))
  const declared = result.coverage.declared
  assert.equal(declared.length, 3)
  const a = declared.filter((l) => l.startsWith('find:aaa'))
  assert.equal(a.length, 1)
  for (const text of ['exhausted', 'no ini reader on the registry', 'no streaming reader anywhere']) assert.ok(a[0].includes(text), 'find:aaa lacks ' + text)
  const b = declared.filter((l) => l.startsWith('find:bbb'))
  assert.equal(b.length, 1)
  for (const text of ['exhausted', 'the vendor wiki behind a login']) assert.ok(b[0].includes(text), 'find:bbb lacks ' + text)
  assert.equal(declared.filter((l) => l.startsWith('find:ccc')).length, 0)
  const r = declared.filter((l) => l.startsWith('repo'))
  assert.equal(r.length, 1)
  for (const text of ['exhausted', 'no toml file in the tree']) assert.ok(r[0].includes(text), 'repo lacks ' + text)
})

test('a search that found nothing where it looked is declared, not lost', async (t) => {
  const research = { npm: [ok(found([], { no_match: 'no pure reader published' }))] }
  const { result } = await sweep(t, scriptOf({ research, repo: [ok(scanned([]))] }))
  assert.equal(linesWith(result.coverage.declared, 'find:npm', 'no pure reader published').length, 1)
  assert.equal(result.coverage.complete, true)
})

// --- the repository scan ---------------------------------------------------------------------

test('the repository scan is one scout call on thread repo, its brief holding the repository question, what is wanted and the roots', async (t) => {
  const roots = ['packages/parser', 'tools/cfg']
  const { rig } = await sweep(t, scriptOf({ assess: DEFAULT_ASSESS }), { args: { roots } })
  const on = callsOn(rig, 'repo')
  assert.equal(on.length, 1)
  assert.equal(on[0].role.name, 'scout')
  assert.deepEqual(on[0].schema, schemaOf('scout_hits'))
  const f = frameOut()
  for (const text of [f.repo_question, f.capability_line, ...roots]) assert.ok(on[0].brief.includes(text), 'the scan brief lacks ' + text)
})

test('the repository scan runs whatever the researchers return', async (t) => {
  const { rig, result } = await sweep(t, scriptOf({ research: { npm: [FAILED] } }))
  assert.equal(callsOn(rig, 'repo').length, 1)
  assert.equal(result.counts.present, 1)
})

test("every round's hits are recorded as items the repository already carries", async (t) => {
  const repo = [
    ok(scanned([hit('src/config.mjs', 2)], { stop_reason: 'unfinished', not_reached: 'the loader module' })),
    ok(scanned([hit('src/loader.mjs', 2, 'splits a key from its value')])),
  ]
  const { rig, result } = await sweep(t, scriptOf({ repo, assess: DEFAULT_ASSESS }))
  assert.equal(result.counts.present, 2)
  assert.deepEqual(behaviours(rig.repo).map((i) => i.ground[0]).sort(), ['src/config.mjs', 'src/loader.mjs'])
})

test('a repository scan that failed is a failed channel, and the candidates are still recorded', async (t) => {
  const { rig, result } = await sweep(t, scriptOf({ repo: [FAILED], assess: DEFAULT_ASSESS }))
  assert.ok(result.coverage.failed_channels.includes('repo'))
  assert.ok(linesWith(result.coverage.unreached, 'repo', failedCause(rig, 'scout', 'repo')).length > 0)
  assert.deepEqual(externals(rig.repo).map((i) => i.detail.name), ['alpha'])
})

test('a repository scan that stopped short leaves repo incomplete', async (t) => {
  const short = scanned([hit('src/config.mjs', 2)], { stop_reason: 'unfinished', not_reached: 'the generated sources' })
  const { rig, result } = await sweep(t, scriptOf({ repo: [ok(short), ok(short)], assess: DEFAULT_ASSESS }))
  assert.equal(callsOn(rig, 'repo').length, 2)
  assert.ok(result.coverage.incomplete.includes('repo'))
  assert.ok(!result.coverage.failed_channels.includes('repo'))
  assert.ok(linesWith(result.coverage.unreached, 'repo', 'the generated sources').length > 0)
})

// --- the assessment --------------------------------------------------------------------------

test('the assessor runs only when a researcher reported a named candidate', async (t) => {
  const { rig, result } = await sweep(t, scriptOf({ research: { npm: [ok(found([]))] } }))
  assert.equal(callsOn(rig, 'assess').length, 0)
  assert.equal(result.measured, false)
  assert.equal(result.counts.candidates, 0)
  assert.equal(result.coverage.complete, true)
})

test("the assessor's brief holds every candidate as reported, the frame's constraints and disqualifiers, and the caller's constraints", async (t) => {
  const frame = frameOut({
    hard_constraints: ['runs on Node without compilation', 'reads files of several megabytes'],
    disqualifiers: ['copyleft licence', 'abandoned upstream'],
    angles: [{ key: 'npm', find: 'look on npm' }, { key: 'github', find: 'look on github' }],
  })
  const one = cand('alpha', {
    source_url: 'https://alpha.example.net/reader', what_it_is: 'a streaming reader of tables', latest_version: '4.0.0-rc.7',
    license: 'BSD two clause', maintenance: 'one maintainer, monthly releases', covers: 'inline tables and arrays',
    does_not_cover: 'comments on round trip',
  })
  const two = cand('beta', {
    source_url: 'https://beta.example.net/', what_it_is: 'a strict validator', latest_version: '0.9.1',
    license: 'Apache two', maintenance: 'archived in spring', covers: 'datetime values', does_not_cover: 'dotted keys',
  })
  const constraints = 'must stay under a kilobyte of glue'
  const research = { npm: [ok(found([one]))], github: [ok(found([two]))] }
  const assess = [ok(assessed([row(one), row(two)]))]
  const { rig } = await sweep(t, scriptOf({ frame: [ok(frame)], research, assess }), { args: { constraints } })
  const brief = firstBrief(rig, 'assess')
  const fields = ['name', 'source_url', 'what_it_is', 'latest_version', 'license', 'maintenance', 'covers', 'does_not_cover']
  for (const c of [one, two]) for (const f of fields) assert.ok(brief.includes(c[f]), `the assessor brief lacks ${c.name}.${f}`)
  for (const text of [frame.capability_line, ...frame.hard_constraints, ...frame.disqualifiers, constraints]) {
    assert.ok(brief.includes(text), 'the assessor brief lacks ' + text)
  }
})

test('names that differ only in case are one unit', async (t) => {
  const frame = frameOut({ angles: [{ key: 'npm', find: 'look on npm' }, { key: 'github', find: 'look on github' }] })
  const research = { npm: [ok(found([cand('Smol-TOML')]))], github: [ok(found([cand('smol-toml')]))] }
  const assess = [ok(assessed([row(cand('smol-toml'))], { units: [] }))]
  const { result } = await sweep(t, scriptOf({ frame: [ok(frame)], research, assess }))
  const units = result.coverage.incomplete.filter((u) => u.startsWith('assess:'))
  assert.deepEqual(units, ['assess:smol-toml'])
})

test('a unit the assessor left unruled or unassessable leaves it incomplete', async (t) => {
  const names = ['alpha', 'beta', 'gamma']
  const research = { npm: [ok(found(names.map((n) => cand(n))))] }
  const units = [{ unit: 'beta', ruling: 'unassessable', why: 'no docs' }, { unit: 'gamma', ruling: 'assessed', why: 'read' }]
  const assess = [ok(assessed(names.map((n) => row(cand(n))), { units }))]
  const { result } = await sweep(t, scriptOf({ research, assess }))
  const incomplete = result.coverage.incomplete
  assert.ok(incomplete.includes('assess:alpha'), 'an unruled unit')
  assert.ok(incomplete.includes('assess:beta'), 'an unassessable unit')
  assert.ok(!incomplete.includes('assess:gamma'), 'an assessed unit')
})

test('an assessor that failed leaves the candidates unmeasured', async (t) => {
  const frame = frameOut({ angles: [{ key: 'npm', find: 'look on npm' }, { key: 'github', find: 'look on github' }] })
  const research = { npm: [ok(found([cand('alpha'), cand('beta')]))], github: [ok(found([cand('Alpha')]))] }
  const { rig, result } = await sweep(t, scriptOf({ frame: [ok(frame)], research, assess: [FAILED] }))
  assert.ok(result.coverage.failed_channels.includes('assess'))
  assert.ok(linesWith(result.coverage.unreached, 'assess').length > 0)
  assert.equal(result.measured, false)
  assert.equal(result.counts.candidates, 2)
  assert.equal(result.counts.viable, 0)
  assert.equal(result.counts.ruled_out, 0)
  assert.deepEqual(externals(rig.repo).map((i) => i.detail.name.toLowerCase()).sort(), ['alpha', 'beta'])
})

// --- the record ------------------------------------------------------------------------------

const RECORD_SCRIPT = () => scriptOf({
  research: { npm: [ok(found([cand('alpha'), cand('beta')]))] },
  assess: [ok(assessed([row(cand('alpha')), row(cand('beta'), ['copyleft licence'])]))],
})

test('the record turns candidates and hits into items, and counts what they mean', async (t) => {
  const { rig, result } = await sweep(t, RECORD_SCRIPT())
  assert.deepEqual(externals(rig.repo).map((i) => i.detail.name).sort(), ['alpha', 'beta'])
  assert.deepEqual(behaviours(rig.repo).map((i) => i.ground[0]), ['src/config.mjs'])
  const byId = (a, b) => (a.id < b.id ? -1 : 1)
  assert.deepEqual([...result.items].sort(byId), pool(rig.repo).map(({ id, topic, kind }) => ({ id, topic, kind })).sort(byId))
  assert.equal(result.recorded, true)
  assert.equal(result.measured, true)
  for (const k of COUNT_KEYS) assert.equal(typeof result.counts[k], 'number', k)
  for (const k of ['unread', 'present_read']) assert.ok(!(k in result.counts), 'a sweep reads no files, so it counts none: ' + k)
  assert.equal(result.counts.present, 1)
  assert.equal(result.counts.candidates, 2)
  assert.equal(result.counts.viable, 1)
  assert.equal(result.counts.ruled_out, 1)
  assert.ok(result.summary && existsSync(result.summary), 'the summary is a file')
  assert.ok(readFileSync(result.summary, 'utf8').includes(CAPABILITY))
})

test('a ground the frame never declared is counted and named as a loss', async (t) => {
  const assess = [ok(assessed([row(cand('alpha'), ['written by a competitor'])]))]
  const { result } = await sweep(t, scriptOf({ assess }))
  assert.equal(result.counts.invented, 1)
  assert.equal(result.coverage.unreached.length, 1)
  assert.equal(result.coverage.complete, false)
})

test('a candidate the assessment dropped is counted and named as a loss', async (t) => {
  const research = { npm: [ok(found([cand('alpha'), cand('beta')]))] }
  const units = ['alpha', 'beta'].map((unit) => ({ unit, ruling: 'assessed', why: 'read' }))
  const assess = [ok(assessed([row(cand('alpha'))], { units }))]
  const { result } = await sweep(t, scriptOf({ research, assess }))
  assert.equal(result.counts.lost, 1)
  assert.equal(result.coverage.unreached.length, 1)
  assert.equal(result.coverage.complete, false)
})

test('what the assessment could not settle is named as a loss', async (t) => {
  const assess = [ok(assessed([row(cand('alpha'))], { notes: 'could not tell whether alpha handles dotted keys' }))]
  const { result } = await sweep(t, scriptOf({ assess }))
  assert.equal(result.counts.unsettled, 1)
  assert.equal(result.coverage.unreached.length, 1)
  assert.equal(result.coverage.complete, false)
})

test('a record the store refuses costs no coverage', async (t) => {
  const { rig, result } = await sweep(t, scriptOf({ repo: [ok(scanned([hit('src/gone.mjs', 2)]))], assess: DEFAULT_ASSESS }))
  assert.equal(result.recorded, false)
  assert.deepEqual(result.items, [])
  assert.equal(liveItems(rig.repo).size, 0)
  assert.ok(result.summary && existsSync(result.summary), 'the summary is still a file')
  assert.equal(result.coverage.complete, true)
})

/** Put a plain file where the store keeps its returns, so recording throws. */
function blockStore(repo) {
  const dir = evidenceReturnsDir(repo)
  mkdirSync(dirname(dir), { recursive: true })
  writeFileSync(dir, 'not a directory')
  return () => rmSync(dir, { force: true })
}

test('a record that throws is a failed channel', async (t) => {
  const rig = rigFor(t, { script: scriptOf({ assess: DEFAULT_ASSESS }) })
  blockStore(rig.repo)
  const result = await solutions(rig.ctx, argsFor(rig))
  assert.ok(result.coverage.failed_channels.includes('record'))
  assert.ok(linesWith(result.coverage.unreached, 'record').length > 0)
  assert.equal(result.summary, '')
  assert.equal(result.recorded, false)
  for (const k of COUNT_KEYS) assert.equal(result.counts[k], 0, k)
  assert.deepEqual(result.items, [])
})

test('a record that threw runs again on relaunch', async (t) => {
  const rig = rigFor(t, { script: scriptOf({ assess: DEFAULT_ASSESS }) })
  const unblock = blockStore(rig.repo)
  const first = await solutions(rig.ctx, argsFor(rig))
  assert.ok(first.coverage.failed_channels.includes('record'), 'the first launch failed its record')
  unblock()
  const again = rig.relaunch({})
  const result = await solutions(again.ctx, argsFor(again))
  assert.equal(again.calls.length, 0)
  assert.equal(result.recorded, true)
  assert.ok(liveItems(rig.repo).size > 0)
  assert.equal(result.coverage.complete, true)
  assert.ok(!result.coverage.failed_channels.includes('record'))
})

// --- the result and the run ------------------------------------------------------------------

test("the result carries the capability, the constraints and the run's resumable", async (t) => {
  const constraints = 'must stay under a kilobyte of glue'
  const { rig, result } = await sweep(t, scriptOf({ assess: DEFAULT_ASSESS }), { args: { constraints } })
  assert.equal(result.capability, CAPABILITY)
  assert.equal(result.constraints, constraints)
  assert.deepEqual(result.coverage.resumable, rig.ctx.resumable)
})

test('a relaunch calls nothing that returned', async (t) => {
  const { rig, result } = await sweep(t, RECORD_SCRIPT())
  const kept = keptReturns(rig.repo)
  const items = liveItems(rig.repo).size
  const again = rig.relaunch({})
  const second = await solutions(again.ctx, argsFor(again))
  assert.equal(again.calls.length, 0)
  assert.deepEqual(second, result)
  assert.equal(keptReturns(rig.repo), kept)
  assert.equal(liveItems(rig.repo).size, items)
})

test("every thread's first brief holds the repository's guidance", async (t) => {
  const frame = frameOut({ angles: [{ key: 'npm', find: 'look on npm' }, { key: 'github', find: 'look on github' }] })
  const research = { npm: [ok(found([cand('alpha')]))], github: [ok(found([cand('beta')]))] }
  const assess = [ok(assessed([row(cand('alpha')), row(cand('beta'))]))]
  const { rig } = await sweep(t, scriptOf({ frame: [ok(frame)], research, assess }))
  for (const thread of ['frame', 'research:npm', 'research:github', 'repo', 'assess']) {
    assert.ok(firstBrief(rig, thread).includes(GUIDANCE), thread + ' lacks the guidance')
  }
})

test('no brief points at a file under the run or the store', async (t) => {
  const research = {
    npm: [
      ok(found([cand('alpha')], { stop_reason: 'unfinished', not_reached: 'the changelog pages' })),
      ok(found([cand('beta')])),
    ],
  }
  const assess = [ok(assessed([row(cand('alpha')), row(cand('beta'))]))]
  const { rig } = await sweep(t, scriptOf({ research, assess }))
  assert.ok(rig.calls.length > 0)
  for (const c of rig.calls) {
    for (const text of [c.brief, c.freshBrief]) {
      for (const bad of [rig.ctx.dir, posix(rig.ctx.dir), '.agentics']) {
        assert.ok(!String(text).includes(bad), `${c.thread.key} names ${bad}`)
      }
    }
  }
})

test("the scope is the capability's digest, whatever else is asked", () => {
  const base = { capability_file: '/x/want.md', capability: CAPABILITY, roots: ['.'], constraints: '', notes: '', max_angles: 4, intelligence: 'normal' }
  const at = { repo: '/x', root: '/x' }
  const expected = { capability: fnv1a(CAPABILITY) }
  assert.deepEqual(scopeOf(base, at), expected)
  assert.deepEqual(scopeOf({ ...base, roots: ['src', 'lib'], constraints: 'small', notes: 'n', max_angles: 9, intelligence: 'max' }, at), expected)
  assert.deepEqual(scopeOf({ ...base, intelligence: 'low' }, { repo: '/y', root: '/y/wt' }), expected)
  assert.notDeepEqual(scopeOf({ ...base, capability: 'Another capability.' }, at), expected)
})
