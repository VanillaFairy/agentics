// test/evidence-from-run.test.mjs — a solutions sweep recorded from return objects, and the two
// verbs a session records a run's outcome by: `evidence.mjs cite --from-run`, which cites the items
// a run's result lists, and `approval.mjs reviewed --from-run`, which records a probe run's round.
//
// Design: docs/DESIGN.md#existing-solutions, docs/DESIGN.md#evidence-item-store,
// docs/DESIGN.md#ledger-lines, docs/DESIGN.md#design.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { approvalGate, recordDisposition, reviewedFromResult } from '../lib/approval.mjs'
import { latestCites, liveItems, recordCites, recordSolutions, reviewScope } from '../lib/evidence.mjs'
import { readLog } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { readJson, resultPath, runDir } from '../lib/store.mjs'
import { gitRepo, lines, linkedWorktree, record, returnFile, text, write } from './harness/evidence-fixture.mjs'

/** A git repository with `.agentics/` ignored, removed when the test ends. */
function repoOf(t) {
  const repo = gitRepo({ 'src/a.js': text(lines(3)), '.agentics/.gitignore': '*\n' })
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  return repo
}

// ------------------------------------------------------------------ recordSolutions in-process

const CAPABILITY = 'rate-limit inbound requests'
const FRAME = { capability: CAPABILITY, disqualifiers: ['GPL-licensed', 'Python only'] }
const candidate = (name, over) => ({
  name, source_url: 'https://example.com/' + name, what_it_is: 'a limiter', latest_version: '1.0.0', license: 'MIT',
  maintenance: 'released 2026-09-01', covers: 'per key limits', does_not_cover: 'nothing identified', ...over,
})
const RESEARCHED = { candidates: [candidate('a'), candidate('b'), candidate('c')] }
const ASSESSED = {
  assessed: [{ ...candidate('a'), disqualifiers_hit: [] }, { ...candidate('b'), disqualifiers_hit: ['gpl-licensed'] }],
  notes: 'is c a fork of a?',
}
const PRESENT = { hits: [{ path: 'src/a.js', line: 2, note: 'a limiter already' }] }

test('a sweep recorded from return objects records what its files would', (t) => {
  const repo = repoOf(t)
  const byFile = recordSolutions(repo, {
    frame: returnFile(repo, FRAME), question_digest: fnv1a(CAPABILITY), assessed: returnFile(repo, ASSESSED),
    candidates: [returnFile(repo, RESEARCHED)], present: returnFile(repo, PRESENT),
  })
  const byObject = recordSolutions(repo, {
    frame: FRAME, question_digest: fnv1a(CAPABILITY), assessed: ASSESSED, candidates: [RESEARCHED], present: PRESENT,
  })
  assert.deepEqual([byFile.recorded, byObject.recorded], [true, true], JSON.stringify(byObject))
  assert.equal(byObject.items.length, ASSESSED.assessed.length + PRESENT.hits.length)
  assert.deepEqual(byObject.items, byFile.items, 'the same items, under the same ids')
  assert.deepEqual([byObject.counts, byObject.measured], [byFile.counts, byFile.measured])
  assert.equal(readFileSync(byObject.summary_file, 'utf8'), readFileSync(byFile.summary_file, 'utf8'))
})

test('the capability handed in-process takes the place of the frame\'s capability and digest', (t) => {
  const repo = repoOf(t)
  const framed = recordSolutions(repo, { frame: FRAME, question_digest: fnv1a(CAPABILITY), assessed: ASSESSED, candidates: [RESEARCHED], present: PRESENT })
  const asked = recordSolutions(repo, {
    question: CAPABILITY + '\n', frame: { disqualifiers: FRAME.disqualifiers }, assessed: ASSESSED, candidates: [RESEARCHED], present: PRESENT,
  })
  assert.equal(asked.recorded, true, JSON.stringify(asked))
  assert.deepEqual(asked.items, framed.items, 'the same items: recorded under the capability handed, trimmed')
  assert.deepEqual(asked.counts, framed.counts, 'the frame\'s disqualifiers still decide what is viable')
  assert.ok([...liveItems(repo).values()].every((it) => it.question === CAPABILITY))
})

test('a blank capability refuses no_question, recording nothing', (t) => {
  const repo = repoOf(t)
  const out = recordSolutions(repo, { question: '  ', frame: FRAME, assessed: ASSESSED, candidates: [RESEARCHED] })
  assert.deepEqual([out.ok, out.error.kind], [false, 'no_question'])
  assert.equal(liveItems(repo).size, 0)
})

test('an unreadable frame refuses frame_unreadable, with the capability handed or its digest', (t) => {
  const repo = repoOf(t)
  for (const over of [{ question: CAPABILITY }, { question_digest: fnv1a(CAPABILITY) }]) {
    const out = recordSolutions(repo, { frame: '/gone.json', assessed: ASSESSED, candidates: [RESEARCHED], ...over })
    assert.deepEqual([out.ok, out.error.kind], [false, 'frame_unreadable'], JSON.stringify(over))
  }
  assert.equal(liveItems(repo).size, 0)
})

test('a frame handed as an object is checked against the digest when no capability is handed', (t) => {
  const repo = repoOf(t)
  const out = recordSolutions(repo, { frame: FRAME, question_digest: fnv1a('another capability'), candidates: [RESEARCHED] })
  assert.deepEqual([out.ok, out.error.kind], [false, 'question_mismatch'])
})

test('researchers\' returns may mix objects and files, and one that cannot be read is counted unread', (t) => {
  const repo = repoOf(t)
  const more = { candidates: [candidate('d'), candidate('A')] }
  const out = recordSolutions(repo, { question: CAPABILITY, frame: FRAME, candidates: [RESEARCHED, returnFile(repo, more), '/gone.json'] })
  const names = new Set([...RESEARCHED.candidates, ...more.candidates].map((c) => c.name.toLowerCase()))
  assert.deepEqual([out.measured, out.counts.candidates, out.counts.unread], [false, names.size, 1])
})

// ------------------------------------------------------------------ the verbs a session records a run by

const E = 'e1'
const SPEC = '.agentics/e1/DESIGN.md'
const SPEC_TEXT = text(['# Limiter', '', '## Intent', 'limit inbound requests', '## Design', 'a token bucket per key'])
const EVIDENCE = fileURLToPath(new URL('../lib/evidence.mjs', import.meta.url))
const APPROVAL = fileURLToPath(new URL('../lib/approval.mjs', import.meta.url))

/** Run a lib CLI: it exits 0 and prints a digest-covered envelope; its payload. */
function cli(script, ...args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.payload_digest, fnv1a(canonical(out.payload)))
  return out.payload
}
const cite = (repo, ...args) => cli(EVIDENCE, 'cite', '--repo', repo, '--effort', E, '--folder', '.', ...args)
const reviewed = (repo, ...args) => cli(APPROVAL, 'reviewed', '--repo', repo, '--effort', E, '--folder', '.', ...args)
/** What `reviewed --from-run` records once it has read the run's result, called in-process. */
const fromRun = (repo, run) => reviewedFromResult(repo, E, '.', readJson(resultPath(repo, run)))

/** A repository holding effort e1's root spec. */
function specRepo(t) {
  const repo = repoOf(t)
  write(repo, SPEC, SPEC_TEXT)
  return repo
}

/** A run's result.json, written by hand under its run directory as lib/run.mjs writes it; the run id. */
function result(repo, run, value) {
  mkdirSync(runDir(repo, run), { recursive: true })
  writeFileSync(resultPath(repo, run), JSON.stringify({ ...value, run, cost: { dispatches: 0, tokens: 0, usd: 0, unmeasured: 0 } }))
  return run
}

/** `n` external items recorded in the store; their ids. */
const itemsIn = (repo, n, word = 'item') => Array.from({ length: n }, (_, i) => record(repo, {
  kind: 'external', claim: word + ' ' + (i + 1), sources: [{ url: 'https://example.com/' + word + '/' + (i + 1), version: '' }],
}))

const coverage = (over = {}) => ({
  complete: true, declared: [], dropped: [], incomplete: [], failed_channels: [], unreached: [], resumable: null, ...over,
})
const handles = (ids, topic = 't') => ids.map((id) => ({ id, topic, kind: 'external', state: 'standing' }))
const survey = (ids) => ({
  question: 'how are requests limited', topics: [], ground: ['src'], items: handles(ids), reused: [], unrecorded: [],
  context: '', risks: [], history: null, docs: null, coverage: coverage(),
})
const solutions = (ids) => ({
  capability: CAPABILITY, constraints: '', summary: '', counts: {}, measured: true, items: handles(ids, 'candidates'), recorded: true, coverage: coverage(),
})

/** The folder's whole citation: its latest cites line. */
const citation = (repo) => latestCites(readLog(repo, E, 'cites').entries).get('.')

// ------------------------------------------------------------------ cite --from-run

test('cite --from-run cites every item the run\'s result lists', (t) => {
  const repo = specRepo(t)
  const ids = itemsIn(repo, 3)
  const out = cite(repo, '--from-run', result(repo, '20261004-120000-survey', survey(ids)))
  assert.deepEqual([out.ok, out.items_n], [true, ids.length], JSON.stringify(out))
  assert.deepEqual([citation(repo).seq, citation(repo).items], [out.seq, ids])
})

test('cite --from-run cites an investigation\'s evidence items', (t) => {
  const repo = specRepo(t)
  const ids = itemsIn(repo, 2)
  const run = result(repo, '20261004-120000-investigate', {
    question: 'q', mode: 'report', tasks: null, report: 'r', evidence: { items: handles(ids), context: '', risks: [], history: null, docs: null }, coverage: coverage(),
  })
  assert.equal(cite(repo, '--from-run', run).ok, true)
  assert.deepEqual(citation(repo).items, ids)
})

test('cite --from-run leaves out every id named by --exclude', (t) => {
  const repo = specRepo(t)
  const ids = itemsIn(repo, 3)
  const out = cite(repo, '--from-run', result(repo, '20261004-120000-survey', survey(ids)), '--exclude', ids[0], '--exclude', ids[2])
  assert.deepEqual([out.ok, out.items_n], [true, 1])
  assert.deepEqual(citation(repo).items, [ids[1]])
})

test('an --exclude the runs do not list refuses unknown_item, citing nothing', (t) => {
  const repo = specRepo(t)
  const ids = itemsIn(repo, 2)
  const [stray] = itemsIn(repo, 1, 'stray')
  const out = cite(repo, '--from-run', result(repo, '20261004-120000-survey', survey(ids)), '--exclude', stray)
  assert.deepEqual([out.ok, out.error.kind], [false, 'unknown_item'])
  assert.equal(citation(repo), undefined)
})

test('cite --from-run named twice cites the items of both runs, each once', (t) => {
  const repo = specRepo(t)
  const [shared, fromSurvey, fromSweep] = itemsIn(repo, 3)
  const a = result(repo, '20261004-120000-survey', survey([shared, fromSurvey]))
  const b = result(repo, '20261004-120500-solutions', solutions([shared, fromSweep]))
  const out = cite(repo, '--from-run', a, '--from-run', b)
  assert.deepEqual([out.ok, out.items_n], [true, 3])
  assert.deepEqual(citation(repo).items, [shared, fromSurvey, fromSweep])
})

test('cite --from-run records every --gap as given, beside the run\'s items', (t) => {
  const repo = specRepo(t)
  const gaps = ['the docs channel never reached the 2024 releases', 'history: not searched']
  const ids = itemsIn(repo, 1)
  const run = result(repo, '20261004-120000-survey', survey(ids))
  assert.equal(cite(repo, '--from-run', run, '--gap', gaps[0], '--gap', gaps[1]).ok, true)
  assert.deepEqual([citation(repo).items, citation(repo).gaps], [ids, gaps])
})

test('a cite by run replaces the folder\'s earlier citation whole', (t) => {
  const repo = specRepo(t)
  const [earlier, ...ids] = itemsIn(repo, 3)
  assert.equal(recordCites(repo, E, '.', { items: [earlier], gaps: ['an earlier gap'] }).ok, true)
  assert.equal(cite(repo, '--from-run', result(repo, '20261004-120000-survey', survey(ids))).ok, true)
  assert.deepEqual([citation(repo).items, citation(repo).gaps], [ids, []])
})

test('citing the same run again leaves the folder\'s citation as it was', (t) => {
  const repo = specRepo(t)
  const run = result(repo, '20261004-120000-survey', survey(itemsIn(repo, 2)))
  cite(repo, '--from-run', run)
  const first = citation(repo)
  const again = cite(repo, '--from-run', run)
  assert.ok(again.seq > first.seq)
  assert.deepEqual([citation(repo).items, citation(repo).gaps], [first.items, first.gaps])
})

test('cite --from-run on a run with no readable result refuses no_result, citing nothing', (t) => {
  const repo = specRepo(t)
  mkdirSync(runDir(repo, '20261004-120000-survey'), { recursive: true })
  assert.deepEqual(cite(repo, '--from-run', '20261004-120000-survey').error.kind, 'no_result')
  writeFileSync(resultPath(repo, '20261004-120000-survey'), '{"items": [')
  assert.deepEqual(cite(repo, '--from-run', '20261004-120000-survey').error.kind, 'no_result', 'a torn result is no result')
  assert.equal(citation(repo), undefined)
})

test('cite --from-run on an unknown run refuses unknown_run', (t) => {
  const repo = specRepo(t)
  const out = cite(repo, '--from-run', '20261004-120000-survey')
  assert.deepEqual([out.ok, out.error.kind], [false, 'unknown_run'])
  assert.equal(citation(repo), undefined)
})

test('a result that lists no items refuses no_items, citing nothing', (t) => {
  const repo = specRepo(t)
  const run = result(repo, '20261004-120000-probe', { artifact: SPEC, units: { total: 1, ruled: 1, open: [] }, findings: [], ambiguities: [], coverage: coverage() })
  assert.deepEqual(cite(repo, '--from-run', run, '--gap', 'a gap').error.kind, 'no_items')
  assert.equal(citation(repo), undefined)
})

test('an item the store does not hold refuses the whole cite', (t) => {
  const repo = specRepo(t)
  const [held] = itemsIn(repo, 1)
  const out = cite(repo, '--from-run', result(repo, '20261004-120000-survey', survey([held, 'I00000000'])), '--gap', 'a gap')
  assert.deepEqual([out.ok, out.error.kind], [false, 'refused'])
  assert.equal(citation(repo), undefined)
})

test('--items with --from-run, or --exclude without it, refuses bad_args', (t) => {
  const repo = specRepo(t)
  const ids = itemsIn(repo, 2)
  const run = result(repo, '20261004-120000-survey', survey(ids))
  assert.equal(cite(repo, '--from-run', run, '--items', ids[0]).error.kind, 'bad_args')
  assert.equal(cite(repo, '--items', ids.join(','), '--exclude', ids[0]).error.kind, 'bad_args')
  assert.equal(citation(repo), undefined)
})

// ------------------------------------------------------------------ reviewed --from-run

/** A probe run's result over the spec as it stands, as the probe program returns it. */
function probe(repo, over = {}) {
  const { path, snapshot } = reviewScope(repo, SPEC)
  return {
    artifact: path, axes: [{ key: 'yagni', source: 'standing' }], analysts: [['yagni']],
    shared_ground: { resolved: 0, cited: 0, files: 0, excerpts: 0, unresolved: 0 }, guidance_read: [],
    repo_ground: { located: 0, unresolved: 0 }, units: { total: 2, ruled: 2, open: [] }, findings: [], findings_file: '',
    ambiguities: [], ratifiable: true, snapshot, scope: { full: true, changed: [] }, unrecorded: [], review: '',
    coverage: coverage(), ...over,
  }
}
const PROBE_RUN = '20261004-130000-probe'
const reviewedLines = (repo) => readLog(repo, E, 'ledger').entries.filter((l) => l.kind === 'reviewed')
const ambiguity = (id, item) => ({ id, item, severity: 'ambiguity', axis: 'yagni', section: 'design', carried: false })

test('reviewed --from-run records a complete round at the spec\'s current hash', (t) => {
  const repo = specRepo(t)
  const out = fromRun(repo, result(repo, PROBE_RUN, probe(repo)))
  assert.equal(out.ok, true, JSON.stringify(out))
  const [line] = reviewedLines(repo)
  assert.deepEqual([line.seq, line.hash, line.complete, line.remaining, line.ambiguities], [out.seq, hashSpec(SPEC_TEXT), true, [], []])
})

test('an incomplete round names its open units, then each failed channel, then the coverage\'s incomplete entries', (t) => {
  const repo = specRepo(t)
  const open = ['yagni@design', 'invariants@intent']
  const failed = ['prober:2']
  const incomplete = ['the locating search never finished']
  const run = result(repo, PROBE_RUN, probe(repo, {
    units: { total: 4, ruled: 2, open }, ratifiable: false, coverage: coverage({ complete: false, failed_channels: failed, incomplete }),
  }))
  assert.equal(fromRun(repo, run).ok, true)
  const [line] = reviewedLines(repo)
  assert.deepEqual([line.complete, line.remaining], [false, [...open, ...failed.map((c) => 'channel:' + c), ...incomplete]])
})

test('each ambiguity is named by its finding\'s evidence item, else by the spec hash and its id', (t) => {
  const repo = specRepo(t)
  const findings = [
    { ...ambiguity('P1', 'Iaaaaaaaa'), carried: true }, ambiguity('P2', ''),
    { ...ambiguity('P3', 'Ibbbbbbbb'), severity: 'gap' },
  ]
  const run = result(repo, PROBE_RUN, probe(repo, { findings, ambiguities: ['P1', 'P2'], ratifiable: false }))
  assert.equal(fromRun(repo, run).ok, true)
  assert.deepEqual(reviewedLines(repo)[0].ambiguities, ['Iaaaaaaaa', hashSpec(SPEC_TEXT) + '#P2'])
})

test('the gate opens on a recorded complete round once each ambiguity it named is settled', (t) => {
  const repo = specRepo(t)
  const run = result(repo, PROBE_RUN, probe(repo, { findings: [ambiguity('P1', 'Iaaaaaaaa')], ambiguities: ['P1'], ratifiable: false }))
  fromRun(repo, run)
  const shut = approvalGate(repo, E, '.')
  assert.deepEqual([shut.ratifiable, shut.open], [false, ['Iaaaaaaaa']])
  assert.equal(recordDisposition(repo, E, '.', { finding: 'Iaaaaaaaa', outcome: 'discarded', by: 'user' }).ok, true)
  assert.equal(approvalGate(repo, E, '.').ratifiable, true)
})

test('recording the same probe run again leaves the gate as it was', (t) => {
  const repo = specRepo(t)
  const run = result(repo, PROBE_RUN, probe(repo, { findings: [ambiguity('P1', 'Iaaaaaaaa')], ambiguities: ['P1'], ratifiable: false }))
  assert.equal(fromRun(repo, run).ok, true)
  const once = approvalGate(repo, E, '.')
  assert.equal(fromRun(repo, run).ok, true)
  assert.deepEqual(approvalGate(repo, E, '.'), once)
  assert.equal(reviewedLines(repo).length, 2)
})

test('a result that rules no units refuses not_a_probe, recording nothing', (t) => {
  const repo = specRepo(t)
  const surveyRun = result(repo, '20261004-120000-survey', survey([]))
  const reviewRun = result(repo, '20261004-120000-review', { base: 'HEAD', units: [{ unit: 'u', ruling: 'clean', why: 'w' }], coverage: coverage() })
  assert.equal(fromRun(repo, surveyRun).error.kind, 'not_a_probe')
  assert.equal(fromRun(repo, reviewRun).error.kind, 'not_a_probe', 'a review\'s units are a list, not a probe\'s count')
  assert.deepEqual(reviewedLines(repo), [])
})

test('reviewed --from-run on a run with no readable result refuses no_result', (t) => {
  const repo = specRepo(t)
  mkdirSync(runDir(repo, PROBE_RUN), { recursive: true })
  assert.equal(reviewed(repo, '--from-run', PROBE_RUN).error.kind, 'no_result')
  assert.deepEqual(reviewedLines(repo), [])
})

test('reviewed --from-run on an unknown run refuses unknown_run', (t) => {
  const repo = specRepo(t)
  assert.equal(reviewed(repo, '--from-run', PROBE_RUN).error.kind, 'unknown_run')
  assert.deepEqual(reviewedLines(repo), [])
})

test('reviewed --from-run on a folder with no spec is refused, recording nothing', (t) => {
  const repo = specRepo(t)
  const run = result(repo, PROBE_RUN, probe(repo))
  rmSync(join(repo, ...SPEC.split('/')))
  assert.deepEqual(fromRun(repo, run), { ok: false, error: 'there is no spec that was reviewed' })
  assert.deepEqual(reviewedLines(repo), [])
})

test('a probe of the spec as it stood before an edit refuses spec_changed, recording nothing', (t) => {
  const repo = specRepo(t)
  const run = result(repo, PROBE_RUN, probe(repo))
  write(repo, SPEC, SPEC_TEXT + 'an edit after the probe\n')
  assert.equal(fromRun(repo, run).error.kind, 'spec_changed')
  assert.deepEqual(reviewedLines(repo), [])
})

test('a probe of another artefact refuses not_this_spec, recording nothing', (t) => {
  const repo = specRepo(t)
  write(repo, 'docs/other.md', text(['## Other', 'another document']))
  const other = reviewScope(repo, 'docs/other.md')
  const run = result(repo, PROBE_RUN, probe(repo, { artifact: other.path, snapshot: other.snapshot }))
  assert.equal(fromRun(repo, run).error.kind, 'not_this_spec')
  assert.deepEqual(reviewedLines(repo), [])
})

test('a round whose record kept no snapshot, its findings unrecorded, is recorded incomplete at the spec\'s current hash', (t) => {
  const repo = specRepo(t)
  const findings = [{ ...ambiguity('P1', ''), severity: 'note' }]
  const out = fromRun(repo, result(repo, PROBE_RUN, probe(repo, { findings, snapshot: '', unrecorded: ['P1'] })))
  assert.equal(out.ok, true, JSON.stringify(out))
  const [line] = reviewedLines(repo)
  assert.deepEqual([line.hash, line.complete, line.remaining], [hashSpec(SPEC_TEXT), false, ['unrecorded:P1']])
})

test('a result whose coverage disagrees with what it names as left is refused, recording nothing', (t) => {
  const repo = specRepo(t)
  const silent = result(repo, PROBE_RUN, probe(repo, { coverage: coverage({ complete: false, unreached: ['the rest'] }) }))
  assert.equal(fromRun(repo, silent).ok, false, 'incomplete, yet no unit, channel or incomplete entry named')
  const open = result(repo, '20261004-130500-probe', probe(repo, { units: { total: 2, ruled: 1, open: ['yagni@design'] } }))
  assert.equal(fromRun(repo, open).ok, false, 'complete, yet a unit is open')
  const coherent = result(repo, '20261004-131000-probe', probe(repo))
  const out = fromRun(repo, coherent)
  assert.equal(out.ok, true, 'the same spec\'s coherent round records')
  assert.deepEqual(reviewedLines(repo).map((l) => l.seq), [out.seq])
})

test('--from-run with --complete, --remaining or --ambiguities refuses bad_args', (t) => {
  const repo = specRepo(t)
  const run = result(repo, PROBE_RUN, probe(repo))
  for (const extra of [['--complete', 'true'], ['--remaining', 'yagni'], ['--ambiguities', 'Iaaaaaaaa']]) {
    assert.equal(reviewed(repo, '--from-run', run, ...extra).error.kind, 'bad_args', extra[0])
  }
  assert.deepEqual(reviewedLines(repo), [])
})

// ------------------------------------------------------------------ from a linked worktree

test('both verbs read the main checkout\'s runs and spec when --repo names a linked worktree', (t) => {
  const repo = specRepo(t)
  const wt = linkedWorktree(repo)
  t.after(() => rmSync(dirname(wt), { recursive: true, force: true }))
  const ids = itemsIn(repo, 2)
  assert.equal(cite(wt, '--from-run', result(repo, '20261004-120000-survey', survey(ids))).ok, true)
  assert.deepEqual(citation(repo).items, ids)
  assert.equal(reviewed(wt, '--from-run', result(repo, PROBE_RUN, probe(repo))).ok, true)
  assert.equal(reviewedLines(repo)[0].hash, hashSpec(SPEC_TEXT))
})
