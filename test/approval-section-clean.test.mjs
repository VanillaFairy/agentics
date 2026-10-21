// test/approval-section-clean.test.mjs — the section-clean gate: `recordReviewed`'s `clean` and
// `sections` fields, `approvalGate` settling an incorporated ambiguity only once a later round at the
// spec's current hash rules its section clean (a discard still settles at once), `reviewedFromResult`
// recording one probe round from the probe's result, and `reviewed --from-run` going through it.
//
// Design: docs/DESIGN.md#design, docs/DESIGN.md#probe, docs/DESIGN.md#autonomous-review.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { approvalGate, recordDisposition, recordReviewed, reviewedFromResult } from '../lib/approval.mjs'
import { changedParts, reviewScope, sectionsOf, unitsOf } from '../lib/evidence.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { resultPath, runDir } from '../lib/store.mjs'
import { gitRepo, lines, returnFile, text, write } from './harness/evidence-fixture.mjs'

const E = 'e1'
const SPEC = '.agentics/e1/DESIGN.md'
const DOC = text(['# Limiter', '', '## Intent', 'limit inbound requests', '', '## Design', 'a token bucket per key', '', '## Growth', 'keys are bounded'])
const SECTIONS = sectionsOf(DOC).map((s) => s.slug)
const AXES = ['yagni', 'invariants']
const A = 'Iaaaaaaaa'
const B = 'Ibbbbbbbb'
const APPROVAL = fileURLToPath(new URL('../lib/approval.mjs', import.meta.url))

/** A git repository with `.agentics/` ignored, holding effort e1's root spec; removed when the test ends. */
function specRepo(t, doc = DOC) {
  const repo = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  write(repo, SPEC, doc)
  return repo
}

const ledgerOf = (repo) => readLog(repo, E, 'ledger').entries
const reviewedLines = (repo) => ledgerOf(repo).filter((l) => l.kind === 'reviewed')
const gate = (repo) => approvalGate(repo, E, '.')
const sorted = (list) => [...list].sort()

/** Record a complete round over the spec as it stands; the ledger's answer, which must be ok. */
function review(repo, over = {}) {
  const out = recordReviewed(repo, E, '.', { complete: true, remaining: [], ...over })
  assert.equal(out.ok, true, JSON.stringify(out))
  return out
}
function dispose(repo, finding, outcome) {
  const out = recordDisposition(repo, E, '.', { finding, outcome, by: 'user' })
  assert.equal(out.ok, true, JSON.stringify(out))
  return out
}

// ------------------------------------------------------------------ recordReviewed

test('recordReviewed writes the sections it ruled clean, trimmed and each once', (t) => {
  const repo = specRepo(t)
  review(repo, { clean: [' design ', 'intent', 'design', 'intent  ', 'growth'] })
  const [line] = reviewedLines(repo)
  assert.deepEqual(line.clean, ['design', 'intent', 'growth'], 'trimmed, each once, in the order given')
})

test('recordReviewed writes clean [] and sections {} when given neither', (t) => {
  const repo = specRepo(t)
  review(repo)
  review(repo, { ambiguities: [A] })
  for (const line of reviewedLines(repo)) {
    assert.deepEqual(line.clean, [])
    assert.deepEqual(line.sections, {})
  }
})

test('recordReviewed writes the section of each ambiguity it names', (t) => {
  const repo = specRepo(t)
  const unanchored = hashSpec(DOC) + '#P2'
  review(repo, { ambiguities: [A, unanchored, B], sections: { [A]: ' design ', [unanchored]: 'intent' } })
  review(repo, { ambiguities: [' ' + B + ' '], sections: { [B]: 'growth' } })
  const [first, second] = reviewedLines(repo)
  assert.deepEqual(first.sections, { [A]: 'design', [unanchored]: 'intent' }, 'values trimmed; an ambiguity may name no section')
  assert.deepEqual(second.sections, { [B]: 'growth' }, 'a key names the trimmed ambiguity')
})

test('recordReviewed refuses a malformed clean or sections, writing nothing', (t) => {
  const repo = specRepo(t)
  const bad = [
    { clean: 'design' },
    { clean: null },
    { clean: ['design', '  '] },
    { clean: ['design', ''] },
    { clean: ['design', 5] },
    { ambiguities: [A], sections: [A] },
    { ambiguities: [A], sections: 'design' },
    { ambiguities: [A], sections: null },
    { ambiguities: [A], sections: { [A]: '  ' } },
    { ambiguities: [A], sections: { [A]: '' } },
    { ambiguities: [A], sections: { [A]: 7 } },
    { ambiguities: [A], sections: { [A]: null } },
    { ambiguities: [A], sections: { [A]: ['design'] } },
    { ambiguities: [A], sections: { [B]: 'design' } },
    { ambiguities: [A], sections: { [A]: 'design', [B]: 'intent' } },
    { ambiguities: [], sections: { [A]: 'design' } },
    { sections: { [A]: 'design' } },
  ]
  for (const over of bad) {
    const out = recordReviewed(repo, E, '.', { complete: true, remaining: [], ...over })
    assert.equal(out.ok, false, JSON.stringify(over))
  }
  assert.deepEqual(reviewedLines(repo), [], 'no refusal wrote a line')
  review(repo, { ambiguities: [A], sections: { [A]: 'design' }, clean: ['intent'] })
  assert.equal(reviewedLines(repo).length, 1, 'the same call, well formed, records')
})

// ------------------------------------------------------------------ the gate

test('an incorporated ambiguity keeps the gate shut until a later round lists its section in clean', (t) => {
  const repo = specRepo(t)
  review(repo, { ambiguities: [A], sections: { [A]: 'design' } })
  dispose(repo, A, 'incorporated')
  const shut = gate(repo)
  assert.deepEqual([shut.ratifiable, shut.open], [false, [A]], 'incorporated, no later round')

  review(repo, { ambiguities: [A], sections: { [A]: 'design' }, clean: [] })
  assert.deepEqual([gate(repo).ratifiable, gate(repo).open], [false, [A]], 'a later round that ruled nothing clean')

  review(repo, { ambiguities: [A], sections: { [A]: 'design' }, clean: ['design'] })
  const open = gate(repo)
  assert.deepEqual([open.ratifiable, open.open], [true, []], 'a later round that ruled the section clean')
})

test('the round that returned an ambiguity does not settle it with its own clean', (t) => {
  const repo = specRepo(t)
  review(repo, { ambiguities: [A], sections: { [A]: 'design' }, clean: ['design', 'intent'] })
  assert.deepEqual(gate(repo).open, [A])
  dispose(repo, A, 'incorporated')
  const after = gate(repo)
  assert.deepEqual([after.ratifiable, after.open], [false, [A]])
})

test('a clean recorded before the incorporation does not settle it', (t) => {
  const repo = specRepo(t)
  review(repo, { clean: ['design', 'intent', 'growth'] })
  review(repo, { ambiguities: [A], sections: { [A]: 'design' }, clean: [] })
  review(repo, { ambiguities: [A], sections: { [A]: 'design' }, clean: ['design'] })
  dispose(repo, A, 'incorporated')
  const after = gate(repo)
  assert.deepEqual([after.ratifiable, after.open], [false, [A]], 'every clean on the ledger came before the disposition')
  review(repo, { ambiguities: [A], sections: { [A]: 'design' }, clean: ['design'] })
  assert.equal(gate(repo).ratifiable, true, 'the same clean, after it, settles')
})

test('a clean for another section does not settle an incorporated ambiguity', (t) => {
  const repo = specRepo(t)
  review(repo, { ambiguities: [A], sections: { [A]: 'design' } })
  dispose(repo, A, 'incorporated')
  review(repo, { ambiguities: [A], sections: { [A]: 'design' }, clean: ['intent', 'growth'] })
  const after = gate(repo)
  assert.deepEqual([after.ratifiable, after.open], [false, [A]])
})

test('a clean recorded at an older hash does not settle an incorporated ambiguity', (t) => {
  const repo = specRepo(t)
  review(repo, { ambiguities: [A], sections: { [A]: 'design' } })
  dispose(repo, A, 'incorporated')
  review(repo, { ambiguities: [A], sections: { [A]: 'design' }, clean: ['design'] })
  assert.equal(gate(repo).ratifiable, true, 'at the hash it was recorded at, it settles')

  write(repo, SPEC, DOC.replace('keys are bounded', 'keys are bounded and expire'))
  review(repo, { ambiguities: [A], sections: { [A]: 'design' }, clean: [] })
  const moved = gate(repo)
  assert.deepEqual([moved.ratifiable, moved.open], [false, [A]], 'the spec moved on: that clean read another text')
  review(repo, { ambiguities: [A], sections: { [A]: 'design' }, clean: ['design'] })
  assert.equal(gate(repo).ratifiable, true, 'a round at the new hash that rules it clean settles')
})

test('an ambiguity incorporated a round ago is settled by a later round at the current hash that rules its section clean, the round\'s other ambiguity left open', (t) => {
  const repo = specRepo(t)
  review(repo, { ambiguities: [A], sections: { [A]: 'design' } })
  dispose(repo, A, 'incorporated')
  write(repo, SPEC, DOC.replace('a token bucket per key', 'a token bucket per key, refilled each second'))
  review(repo, { ambiguities: [A, B], sections: { [A]: 'design', [B]: 'intent' }, clean: ['growth'] })
  assert.deepEqual(gate(repo).open, [A, B], 'a round at the new hash that ruled design clean is still to come')
  review(repo, { ambiguities: [A, B], sections: { [A]: 'design', [B]: 'intent' }, clean: ['design', 'growth'] })
  const after = gate(repo)
  assert.deepEqual(after.open, [B], 'A was incorporated a round ago and its section is clean now; B is neither')
  assert.equal(after.ratifiable, false)
})

test('an incorporated ambiguity with no section recorded stays open whatever is clean', (t) => {
  const repo = specRepo(t)
  review(repo, { ambiguities: [A], clean: SECTIONS })
  dispose(repo, A, 'incorporated')
  review(repo, { ambiguities: [A], sections: {}, clean: SECTIONS })
  const none = gate(repo)
  assert.deepEqual([none.ratifiable, none.open], [false, [A]], 'the latest line names no section for it')
  review(repo, { ambiguities: [A, B], sections: { [B]: 'design' }, clean: SECTIONS })
  const other = gate(repo)
  assert.ok(other.open.includes(A), 'the latest line names a section only for another ambiguity')
  assert.equal(other.ratifiable, false)
})

test('a reviewed line written without clean or sections leaves an incorporated ambiguity open', (t) => {
  const repo = specRepo(t)
  const legacy = { kind: 'reviewed', folder: '.', hash: hashSpec(DOC), complete: true, remaining: [], ambiguities: [A] }
  assert.equal(append(repo, E, 'ledger', legacy).ok, true)
  dispose(repo, A, 'incorporated')
  assert.deepEqual([gate(repo).ratifiable, gate(repo).open], [false, [A]])
  assert.equal(append(repo, E, 'ledger', legacy).ok, true)
  const later = gate(repo)
  assert.deepEqual([later.ratifiable, later.open], [false, [A]], 'a later line of the old shape names no clean section either')
})

test('a discarded ambiguity settles the gate as before', (t) => {
  const repo = specRepo(t)
  const legacy = { kind: 'reviewed', folder: '.', hash: hashSpec(DOC), complete: true, remaining: [], ambiguities: [A] }
  assert.equal(append(repo, E, 'ledger', legacy).ok, true)
  assert.deepEqual(gate(repo).open, [A])
  dispose(repo, A, 'discarded')
  assert.deepEqual([gate(repo).ratifiable, gate(repo).open], [true, []], 'a line of the old shape')

  review(repo, { ambiguities: [A, B], sections: { [A]: 'design', [B]: 'intent' }, clean: [] })
  assert.deepEqual(gate(repo).open, [B], 'an earlier discard settles a carried ambiguity, whatever is clean')
  dispose(repo, B, 'discarded')
  assert.equal(gate(repo).ratifiable, true)
})

// ------------------------------------------------------------------ reviewedFromResult

const coverage = (over = {}) => ({
  complete: true, declared: [], dropped: [], incomplete: [], failed_channels: [], unreached: [], resumable: null, ...over,
})
const handle = (id, section, over = {}) => ({ id, item: '', severity: 'ambiguity', axis: 'yagni', section, carried: false, ...over })

/**
 * A probe round over the spec as it stands, as the probe program returns it: every axis against
 * every section ruled `clean`, less the units in `open` (no ruling) and with `findings` rulings
 * for the units in `ruled`; the findings file written beside it as the evidence store writes it.
 */
function round(repo, { findings = [], ruled = [], open = [], over = {}, units = null } = {}) {
  const { path, snapshot } = reviewScope(repo, SPEC)
  const all = unitsOf(AXES, sectionsOf(DOC))
  const rulings = all.filter((u) => !open.includes(u)).map((unit) => ({ unit, ruling: ruled.includes(unit) ? 'findings' : 'clean', why: 'why ' + unit }))
  const full = findings.map((f) => ({ ...f, claim: 'a claim', evidence: 'some evidence', start: 1, end: 1 }))
  return {
    artifact: path, axes: AXES.map((key) => ({ key, source: 'standing' })), analysts: [AXES],
    shared_ground: { resolved: 0, cited: 0, files: 0, excerpts: 0, unresolved: 0 }, guidance_read: [],
    repo_ground: { located: 0, unresolved: 0 }, units: units || { total: all.length, ruled: all.length - open.length, open },
    findings, findings_file: returnFile(repo, { findings: full, units: rulings }),
    ambiguities: findings.filter((f) => f.severity === 'ambiguity').map((f) => f.id), ratifiable: true, snapshot,
    scope: { full: true, changed: [] }, unrecorded: [], review: '',
    coverage: open.length ? coverage({ complete: false, unreached: [open.length + ' unit(s) no prober ruled']}) : coverage(), ...over,
  }
}

/** `reviewedFromResult` over `result`, which must record; the line it wrote. */
function recorded(repo, result) {
  const out = reviewedFromResult(repo, E, '.', result)
  assert.equal(out.ok, true, JSON.stringify(out))
  const line = reviewedLines(repo).find((l) => l.seq === out.seq)
  assert.ok(line, 'the returned seq is a reviewed line')
  return line
}

/** A refusal: its kind, with nothing recorded. */
function refusedKind(repo, result) {
  const before = reviewedLines(repo).length
  const out = reviewedFromResult(repo, E, '.', result)
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(reviewedLines(repo).length, before, 'a refusal records nothing')
  return typeof out.error === 'string' ? out.error : out.error.kind
}

const designOnly = (...extra) => sorted(SECTIONS.filter((s) => s !== 'design' && !extra.includes(s)))

test('reviewedFromResult rules a section clean when every unit of it was ruled clean', (t) => {
  const repo = specRepo(t)
  const findings = [handle('P1', 'intent', { axis: 'invariants' })]
  const result = round(repo, { findings, ruled: ['invariants@intent', 'yagni@design'] })
  const line = recorded(repo, result)
  assert.deepEqual(line.clean, ['growth'], 'intent has a finding and a findings ruling; design has a findings ruling with no finding on it')
  const plain = recorded(repo, round(repo, {}))
  assert.deepEqual(sorted(plain.clean), sorted(SECTIONS), 'every ruling clean, no finding: every section is clean')
  assert.ok(SECTIONS.length >= 3)
})

test('a narrowed round rules a section clean by its changed parts', (t) => {
  const repo = specRepo(t)
  const design = sectionsOf(DOC).find((s) => s.slug === 'design')
  const parts = changedParts(sectionsOf(DOC), [{ start: design.start, end: design.start }, { start: design.end, end: design.end }])
  assert.equal(parts.length, design.start === design.end ? 1 : 2, 'the fixture: the changes fall in design alone')
  const units = unitsOf(AXES, parts)
  const findings_file = returnFile(repo, { findings: [], units: units.map((unit) => ({ unit, ruling: 'clean', why: 'why' })) })
  const line = recorded(repo, round(repo, { units: { total: units.length, ruled: units.length, open: [] }, over: { findings_file } }))
  assert.deepEqual(line.clean, ['design'])
})

test('a section with a unit no prober ruled is not clean', (t) => {
  const repo = specRepo(t)
  const open = ['yagni@intent']
  const line = recorded(repo, round(repo, { open }))
  assert.deepEqual(sorted(line.clean), sorted(SECTIONS.filter((s) => s !== 'intent')), 'its other rulings are all clean')
  assert.deepEqual([line.complete, line.remaining], [false, open])
})

test('a section a finding of the round names is not clean, a carried finding included', (t) => {
  const repo = specRepo(t)
  const carried = handle('P1', 'design', { item: 'Icarried1', severity: 'gap', carried: true })
  const line = recorded(repo, round(repo, { findings: [carried] }))
  assert.deepEqual(sorted(line.clean), designOnly(), 'design is named by a carried finding, every ruling of it clean')
  const fresh = handle('P1', 'growth', { item: 'Ifresh001', severity: 'note' })
  const next = recorded(repo, round(repo, { findings: [fresh] }))
  assert.deepEqual(sorted(next.clean), sorted(SECTIONS.filter((s) => s !== 'growth')), 'a note names its section too')
})

test('a round whose findings file cannot be read rules no section clean', (t) => {
  const repo = specRepo(t)
  const torn = join(repo, 'torn-findings.json')
  writeFileSync(torn, '{"findings": [')
  for (const findings_file of ['', join(repo, 'gone-findings.json'), torn]) {
    const line = recorded(repo, round(repo, { over: { findings_file } }))
    assert.deepEqual(line.clean, [], JSON.stringify(findings_file))
    assert.equal(line.complete, true, 'the round itself is as complete as its coverage says')
  }
})

test('reviewedFromResult records the section of each ambiguity under its settlement id', (t) => {
  const repo = specRepo(t)
  const findings = [
    handle('P1', 'design', { item: A }),
    handle('P2', 'intent', { item: '' }),
    handle('P3', '', { item: B }),
    handle('P4', 'growth', { item: 'Igap00001', severity: 'gap' }),
    handle('P5', 'growth', { item: 'Icarried1', carried: true }),
  ]
  const result = round(repo, { findings, ruled: ['yagni@design'], over: { ambiguities: ['P1', 'P2', 'P3', 'P5'] } })
  const line = recorded(repo, result)
  assert.deepEqual(line.ambiguities, [A, hashSpec(DOC) + '#P2', B, 'Icarried1'])
  assert.deepEqual(line.sections, { [A]: 'design', [hashSpec(DOC) + '#P2']: 'intent', Icarried1: 'growth' },
    'a blank section and a finding that is no ambiguity are left out')
})

test('a round with unrecorded findings is recorded incomplete, remaining naming each', (t) => {
  const repo = specRepo(t)
  const findings = [handle('P1', 'intent', { severity: 'gap' }), handle('P2', 'design', { severity: 'note' })]
  const unrecorded = ['P1', 'P2']
  for (const over of [{ snapshot: '' }, {}]) {
    const result = round(repo, { findings, over: { unrecorded, ...over } })
    assert.equal(result.coverage.complete, true)
    const line = recorded(repo, result)
    assert.deepEqual([line.hash, line.complete], [hashSpec(DOC), false], JSON.stringify(over))
    assert.deepEqual(line.remaining, unrecorded.map((id) => 'unrecorded:' + id))
  }
})

test('reviewedFromResult lists what remains: open units, failed channels, incomplete entries, then unrecorded findings', (t) => {
  const repo = specRepo(t)
  const open = ['yagni@intent', 'invariants@growth']
  const failed = ['prober:2']
  const incomplete = ['the locating search never finished']
  const findings = [handle('P1', 'design', { severity: 'note' })]
  const result = round(repo, {
    findings, open, over: { snapshot: '', unrecorded: ['P1'], coverage: coverage({ complete: false, failed_channels: failed, incomplete }) },
  })
  const line = recorded(repo, result)
  assert.deepEqual(line.remaining, [...open, ...failed.map((c) => 'channel:' + c), ...incomplete, 'unrecorded:P1'])
  assert.equal(line.complete, false)
})

test('a round recorded without a snapshot rules no section clean', (t) => {
  const repo = specRepo(t)
  const findings = [handle('P1', 'design', { severity: 'note' })]
  const result = round(repo, { findings, over: { snapshot: '', unrecorded: ['P1'] } })
  const line = recorded(repo, result)
  assert.deepEqual(line.clean, [], 'its findings file rules every unit clean, and the round is still not trusted')
  assert.equal(line.hash, hashSpec(DOC))
})

test('reviewedFromResult refuses an empty snapshot that unrecorded does not explain, recording nothing', (t) => {
  const repo = specRepo(t)
  assert.equal(refusedKind(repo, round(repo, { over: { snapshot: '', unrecorded: [] } })), 'no_snapshot')
  assert.deepEqual(reviewedLines(repo), [])
})

test('reviewedFromResult refuses a snapshot that does not parse, recording nothing', (t) => {
  const repo = specRepo(t)
  const good = round(repo).snapshot
  const hash = good.slice('snapshot:'.length)
  for (const snapshot of ['snapshot:xyz', hash, good.toUpperCase(), 'snapshot:' + hash.toUpperCase(), good + ' ']) {
    assert.equal(refusedKind(repo, round(repo, { over: { snapshot } })), 'bad_snapshot', JSON.stringify(snapshot))
  }
  assert.deepEqual(reviewedLines(repo), [])
  assert.equal(recorded(repo, round(repo)).hash, hashSpec(DOC), 'the well formed snapshot records')
})

test('reviewedFromResult refuses a snapshot whose hash is not the spec\'s, recording nothing', (t) => {
  const repo = specRepo(t)
  const result = round(repo)
  write(repo, SPEC, DOC + 'an edit after the probe\n')
  assert.equal(refusedKind(repo, result), 'spec_changed')
  assert.deepEqual(reviewedLines(repo), [])
})

test('reviewedFromResult refuses a missing result and one that rules no units, recording nothing', (t) => {
  const repo = specRepo(t)
  for (const missing of [null, undefined, 'a result']) assert.equal(refusedKind(repo, missing), 'no_result', JSON.stringify(missing))
  const probe = round(repo)
  assert.equal(refusedKind(repo, { ...probe, units: [{ unit: 'u', ruling: 'clean', why: 'w' }] }), 'not_a_probe', 'a list of units')
  const { units, ...bare } = probe
  assert.equal(refusedKind(repo, bare), 'not_a_probe', 'no units at all')
  assert.deepEqual(reviewedLines(repo), [])
})

test('reviewedFromResult refuses in the order the contract lists', (t) => {
  const repo = specRepo(t)
  const good = round(repo)
  const before = reviewedLines(repo).length

  const named = reviewedFromResult(repo, 'Bad_Effort', '.', null)
  assert.equal(typeof named.error, 'string', 'an effort name that breaks the rule comes before the result is read')
  const bare = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  t.after(() => rmSync(bare, { recursive: true, force: true }))
  assert.equal(reviewedFromResult(bare, E, '.', null).error.kind, 'no_result', 'the result is read before the spec')
  assert.equal(reviewedFromResult(bare, E, '.', { ...good, units: [] }).error.kind, 'not_a_probe')
  assert.deepEqual(reviewedFromResult(bare, E, '.', good), { ok: false, error: 'there is no spec that was reviewed' })

  write(repo, 'docs/other.md', text(['## Other', 'another document']))
  const other = reviewScope(repo, 'docs/other.md')
  for (const over of [{ snapshot: '' }, { snapshot: 'snapshot:xyz' }, { snapshot: other.snapshot }]) {
    assert.equal(reviewedFromResult(repo, E, '.', { ...good, artifact: other.path, ...over }).error.kind, 'not_this_spec', JSON.stringify(over))
  }
  assert.equal(reviewedLines(repo).length, before)
  assert.equal(readLog(bare, E, 'ledger').entries.length, 0)
})

// ------------------------------------------------------------------ reviewed --from-run

/** Run `approval.mjs reviewed --from-run` over a result written under its run directory as lib/run.mjs writes it. */
function fromRun(repo, run, value) {
  mkdirSync(runDir(repo, run), { recursive: true })
  writeFileSync(resultPath(repo, run), JSON.stringify({ ...value, run, cost: { dispatches: 0, tokens: 0, usd: 0, unmeasured: 0 } }))
  const r = spawnSync(process.execPath, [APPROVAL, 'reviewed', '--repo', repo, '--effort', E, '--folder', '.', '--from-run', run], {
    encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' },
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.payload_digest, fnv1a(canonical(out.payload)))
  return out.payload
}

test('reviewed --from-run records what reviewedFromResult records', { timeout: 120_000 }, (t) => {
  const repo = specRepo(t)
  const findings = [handle('P1', 'design', { item: A }), handle('P2', 'intent', { item: '' })]
  const result = round(repo, {
    findings, ruled: ['yagni@design', 'yagni@intent'],
    over: { ambiguities: ['P1', 'P2'], coverage: coverage({ complete: false, failed_channels: ['prober:2'] }) },
  })
  const direct = recorded(repo, result)
  const out = fromRun(repo, '20261004-130000-probe', result)
  assert.equal(out.ok, true, JSON.stringify(out))
  const via = reviewedLines(repo).find((l) => l.seq === out.seq)
  assert.ok(via && via.seq !== direct.seq)
  const read = ({ hash, complete, remaining, ambiguities, sections, clean }) => ({ hash, complete, remaining, ambiguities, sections, clean })
  assert.deepEqual(read(via), read(direct))
  assert.ok(via.ambiguities.length > 0 && Object.keys(via.sections).length > 0 && via.clean.length > 0 && via.remaining.length > 0,
    'the comparison is not over empty fields')
})

test('reviewed --from-run records the clean sections of a round that ruled some', { timeout: 120_000 }, (t) => {
  const repo = specRepo(t)
  const result = round(repo, { findings: [handle('P1', 'design', { item: A })], ruled: ['yagni@design'], over: { ambiguities: ['P1'] } })
  const out = reviewedFromResult(repo, E, '.', result)
  assert.equal(out.ok, true, JSON.stringify(out))
  const [line] = reviewedLines(repo)
  assert.deepEqual(sorted(line.clean), designOnly())
  assert.deepEqual(line.sections, { [A]: 'design' })
})

test('reviewed --from-run refuses an empty snapshot that unrecorded does not explain, recording nothing', { timeout: 120_000 }, (t) => {
  const repo = specRepo(t)
  const result = round(repo, { over: { snapshot: '', unrecorded: [] } })
  const out = reviewedFromResult(repo, E, '.', result)
  assert.deepEqual([out.ok, out.error.kind], [false, 'no_snapshot'])
  assert.deepEqual(reviewedLines(repo), [])
})
