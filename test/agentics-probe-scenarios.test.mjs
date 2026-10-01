// test/agentics-probe-scenarios.test.mjs — attack-document-with-independent-reviewers's arithmetic: axis assembly, finding
// attribution, and the computed ratification gate.
//
// The property worth pinning hardest is the one a reader cannot check by reading: an axis
// whose prober died and an axis that honestly found nothing produce the SAME empty findings
// list, and mean opposite things. Everything below exists to keep those two apart.
//
// The probers write their findings to the return files their dispatches name, and lib reads
// them; the record courier below simulates that read from what each scripted prober "wrote".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import {
  carriedEnvelope, contextPath, courierCommand, courierProblems, flagValues, returnFileOf, runWorkflow, scriptedAgents,
} from './harness/workflow-host.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'

const WF = fileURLToPath(new URL('../service-workflows/attack-document-with-independent-reviewers.workflow.js', import.meta.url))

// Most scenarios below pin per-axis arithmetic, so they ask for the per-axis shape by name; the
// default, one analyst holding every axis, has its own section at the end.
const ARGS = { artifact: 'docs/proposal.md', roots: 'C:/repo', per_axis: true }

const STANDING = ['ambiguity', 'invariants', 'yagni', 'reinvention']

const axesResult = (over = {}) => ({
  stop_reason: 'completed', axes: [], guidance_read: ['CLAUDE.md'], notes: 'read the project guidance', ...over,
})

// A prober that read the whole artefact says so. `stop_reason` is what separates "attacked
// it all and found nothing" from "got halfway" — the two write the same empty findings
// list — so the default here is the exhausted one and the short reads are opt-in. `findings`
// is what the prober writes to its return file; it never comes back in its structured return.
const found = (findings = []) => ({ findings, stop_reason: 'exhausted', not_reached: '' })
const stoppedShort = (over = {}) => ({ findings: [], stop_reason: 'unfinished', not_reached: '', ...over })
const finding = (over = {}) => ({ severity: 'note', section: '§3', claim: 'c', evidence: 'e', start: 2, end: 3, ...over })

// What the locating scout reports by default: one passage of guidance and one place the
// artefact talks about, and an exhausted search.
const located = (over = {}) => ({
  hits: [{ path: 'CLAUDE.md', line: 40, kind: 'guidance' }, { path: 'lib/loader.mjs', line: 12, kind: 'ground' }],
  stop_reason: 'exhausted', not_reached: '', ...over,
})

const SNAP = 'snapshot:22222222'
const CITED_PATH = contextPath('cited')
const CARRIED_PATH = contextPath('carried')
const scopeOf = (over = {}) => carriedEnvelope({
  ok: true, path: 'docs/proposal.md', snapshot: SNAP, lines: 40, since: '', full: true,
  changed: [{ start: 1, end: 40 }], carried: [], context: '', ...over,
})
const groundPayload = (over = {}) => carriedEnvelope({
  readable: true, context: CITED_PATH, counts: { cited: 1, files: 1, excerpts: 1, unresolved: 0 }, artifact_lines: 0, ...over,
})
const contextOf = (label) => () => carriedEnvelope({ context: contextPath(label), counts: { reports: 1, unread_reports: 0 } })

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/**
 * The lib side of a probe, simulated: what each prober wrote, keyed by its return file, and a
 * record courier that reads those files back as lib does — carried findings first, then each
 * file's in order, an axis the prober did not hold credited to its bundle — and records them.
 */
function lab({ refuse = false } = {}) {
  const written = new Map()
  const probe = (answer) => (prompt) => {
    const a = typeof answer === 'function' ? answer() : answer
    written.set(returnFileOf(prompt), a.findings || [])
    const { findings, ...rest } = a
    return { findings_n: (findings || []).length, ...rest }
  }
  const record = (prompt, opts) => {
    const command = courierCommand(prompt)
    const carried = /--since /.test(command) ? lab.carried : []
    const snapshot = flagValues(command, 'snapshot')[0] || ''
    const bundles = flagValues(command, 'bundle')
    const fresh = flagValues(command, 'from').flatMap((file, i) => (written.get(file) || []).map((f) => {
      const keys = bundles[i].split('+')
      const axis = keys.length === 1 ? keys[0] : keys.includes(f.axis) ? f.axis : keys.join('+')
      return { item: snapshot && !refuse ? 'I' + fnv1a(f.claim) : '', severity: f.severity, axis, section: slug(f.section), carried: false }
    }))
    return carriedEnvelope({
      recorded: Boolean(snapshot) && !refuse, return: snapshot && !refuse ? '20260926-120000-probe' : '',
      findings: carried.concat(fresh).map((f, i) => ({ id: 'P' + (i + 1), ...f })),
      findings_file: contextPath('findings'), refused_n: refuse ? fresh.length : 0,
      refusals_file: refuse ? contextPath('refused') : '', unread: [],
    })
  }
  return { written, probe, record }
}
lab.carried = []

// `probe:` is a PREFIX key and scriptedAgents takes the first entry that matches, so the
// catch-all has to be registered LAST or it swallows every per-axis answer a scenario sets.
const probeAgents = (over = {}, opts = {}) => {
  const l = lab(opts)
  const script = { ...over }
  const catchAll = script['probe:'] || found()
  delete script['probe:']
  for (const [k, v] of Object.entries(script)) if (/^probe:/.test(k)) script[k] = l.probe(v)
  return scriptedAgents({
    scope: scopeOf(), record: l.record, 'record:': l.record, ground: groundPayload(),
    locate: located(), 'guidance-context': contextOf('guidance'), 'ground-context': contextOf('ground'), axes: axesResult(),
    ...script, 'probe:': l.probe(catchAll),
  })
}

const promptOf = (prompts, label) => (prompts.find((p) => p.opts.label === label) || {}).prompt || ''
const probesIn = (prompts) => prompts.filter((p) => /^probe:/.test(p.opts.label))
const failedCourier = { stop_reason: 'failed', payload_raw: '', notes: 'node is not on the PATH' }

test('every courier carries handles only, both ways', async () => {
  const { prompts } = await runWorkflow(WF, {
    args: { ...ARGS, since: 'snapshot:11111111' },
    agent: probeAgents({ scope: scopeOf({ full: false, changed: [{ start: 3, end: 4 }], since: 'snapshot:11111111' }),
      'probe:yagni': found([finding({ claim: 'x'.repeat(5000) })]) }),
  })
  assert.deepEqual(courierProblems(prompts), [])
  assert.ok(prompts.filter((p) => p.opts.agentType === 'agentics:courier').length >= 5)
})

test('the four standing axes run even when the repository states no guidance', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: ARGS, agent: probeAgents({ axes: axesResult({ stop_reason: 'no_guidance_found', axes: [] }) }),
  })

  assert.deepEqual(result.axes.map((a) => a.key), STANDING)
  assert.equal(probesIn(prompts).length, 4)
  assert.equal(result.ratifiable, true)
  assert.equal(result.coverage.complete, true)
})

test("the repository's own axes are added to the standing four, with their source, as handles", async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({ axes: axesResult({ axes: [
      { key: 'iron-law', charge: 'find counter-based termination', source: 'CLAUDE.md' },
      { key: 'Iron Law', charge: 'the same name, spelled otherwise', source: 'CLAUDE.md' },
    ] }) }),
  })

  assert.deepEqual(result.axes.map((a) => a.key), [...STANDING, 'iron-law', 'iron-law-2'])
  assert.equal(result.axes.find((a) => a.key === 'iron-law').source, 'CLAUDE.md')
  assert.deepEqual(result.guidance_read, ['CLAUDE.md'])
})

test('an axis with no charge is not dispatched as one', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS, agent: probeAgents({ axes: axesResult({ axes: [{ key: 'empty', charge: '', source: 'CLAUDE.md' }] }) }),
  })
  assert.deepEqual(result.axes.map((a) => a.key), STANDING)
})

test('one open ambiguity closes the gate, however many notes accompany it', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({
      'probe:ambiguity': found([finding({ severity: 'ambiguity', claim: 'TapTarget is defined twice' })]),
      'probe:': found([finding(), finding({ severity: 'note', claim: 'd' })]),
    }),
  })

  assert.equal(result.ratifiable, false)
  assert.equal(result.ambiguities.length, 1)
  assert.equal(result.ambiguities[0].axis, 'ambiguity')
  assert.equal(result.coverage.complete, true, 'coverage is about what was examined, not what was found')
})

test('a gap alone does not close the gate', async () => {
  const { result } = await runWorkflow(WF, { args: ARGS, agent: probeAgents({ 'probe:yagni': found([finding({ severity: 'gap' })]) }) })
  assert.equal(result.ratifiable, true, 'a gap is accepted out loud, it does not block')
  assert.equal(result.findings.length, 1)
})

test('an axis whose prober died is unexamined, never a silent pass', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS, agent: probeAgents({ 'probe:reinvention': () => { throw new Error('model unavailable') } }),
  })

  assert.deepEqual(result.findings, [], 'the survivors genuinely found nothing')
  assert.equal(result.ratifiable, false, 'nobody looked for reinvention, and nobody-looked is not nothing-there')
  assert.deepEqual(result.coverage.dropped, ['reinvention'])
  assert.ok(result.coverage.failed_channels.includes('probe'))
  assert.deepEqual(result.coverage.resumable.remaining, ['reinvention'])
})

test('an axis that stopped halfway is not an axis that came back clean', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({
      'probe:yagni': stoppedShort({ not_reached: '§7 onward' }),
      'probe:yagni:continued': stoppedShort({ not_reached: '§7 onward' }),
    }),
  })

  assert.deepEqual(result.findings, [], 'the same empty list a clean probe returns')
  assert.equal(result.ratifiable, false, 'a half-read artefact cannot compute a clean bill of health')
  assert.deepEqual(result.coverage.incomplete, ['yagni'])
  assert.deepEqual(result.coverage.dropped, [], 'it reported — it just did not finish')
  assert.ok(result.coverage.unreached.some((u) => /§7 onward/.test(u)))
})

test('a short read keeps the findings it did make', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS, agent: probeAgents({ 'probe:ambiguity': stoppedShort({ findings: [finding({ severity: 'ambiguity' })] }) }),
  })
  assert.equal(result.ambiguities.length, 1, 'its findings stand')
  assert.equal(result.ratifiable, false)
  assert.ok(result.coverage.unreached.some((u) => /without naming what it missed/.test(u)))
})

test('a missing stop_reason normalizes toward unfinished, never toward done', async () => {
  const { result } = await runWorkflow(WF, { args: ARGS, agent: probeAgents({ 'probe:invariants': { findings: [] } }) })
  assert.equal(result.ratifiable, false, 'silence is not exhaustion')
  assert.deepEqual(result.coverage.incomplete, ['invariants'])
})

test('ratifiable implies coverage.complete — the repo-axes hole included', async () => {
  const { result } = await runWorkflow(WF, { args: ARGS, agent: probeAgents({ axes: () => { throw new Error('unreadable') } }) })
  assert.deepEqual(result.findings, [])
  assert.ok(result.coverage.failed_channels.includes('repo-axes'))
  assert.equal(result.ratifiable, false)
  assert.match(result.coverage.unreached.join(' '), /own review guidance was never read/)
})

test('findings carry their axis, a stable id and a section handle, and every one is in the findings file', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({
      'probe:ambiguity': found([finding({ severity: 'ambiguity', section: 'Design / Contracts' })]),
      'probe:yagni': found([finding({ severity: 'gap' }), finding({ claim: 'd' })]),
    }),
  })

  assert.deepEqual(result.findings.map((f) => f.id), ['P1', 'P2', 'P3'])
  assert.deepEqual(result.findings.map((f) => f.axis), ['ambiguity', 'yagni', 'yagni'])
  assert.equal(result.findings[0].section, 'design-contracts')
  assert.ok(result.findings.every((f) => !('claim' in f) && !('evidence' in f)), 'what a finding says is in the file')
  assert.equal(result.findings_file, contextPath('findings'))
})

test('no artefact probes nothing and says so', async () => {
  const { result, prompts } = await runWorkflow(WF, { args: { roots: 'C:/repo' }, agent: probeAgents() })
  assert.deepEqual(prompts, [])
  assert.equal(result.ratifiable, false)
  assert.match(result.coverage.unreached.join(' '), /no artefact path/)
  assert.deepEqual([result.snapshot, result.review, result.unrecorded, result.scope], ['', '', [], { full: true, changed: [] }])
})

test('the prober prompt carries the artefact, the ladder, its return file and no author intent', async () => {
  const { prompts } = await runWorkflow(WF, { args: { ...ARGS, context: 'the increment-4 proposal' }, agent: probeAgents() })

  const probe = promptOf(prompts, 'probe:ambiguity')
  assert.match(probe, /docs\/proposal\.md/)
  assert.match(probe, /THE LADDER/)
  assert.match(probe, /the increment-4 proposal/)
  assert.match(probe, /You do not have the author's reasoning/)
  assert.match(probe, /"severity": "ambiguity\|gap\|note"/)
  assert.match(returnFileOf(probe), /^C:\/repo\/\.agentics\/\.state\/evidence\/inbox\/probe-ambiguity-[0-9a-f]{8}\.json$/)
  for (const p of probesIn(prompts)) assert.match(p.prompt, /C:\/repo/)
})

// -------------------------------------------------------------------------- shared ground

test('the document\'s cited evidence is resolved once and reaches every axis as one file', async () => {
  const { result, prompts } = await runWorkflow(WF, { args: ARGS, agent: probeAgents() })

  assert.equal(prompts.filter((p) => p.opts.label === 'ground').length, 1)
  assert.equal(courierCommand(promptOf(prompts, 'ground')), 'node "$CLAUDE_PLUGIN_ROOT/lib/citations.mjs" cited --repo "C:/repo" --file "docs/proposal.md"')
  assert.equal(result.shared_ground.resolved, true)
  assert.equal(result.shared_ground.context, CITED_PATH)
  for (const p of probesIn(prompts)) {
    assert.match(p.prompt, /WHAT THE DOCUMENT POINTS AT/)
    assert.ok(p.prompt.includes(CITED_PATH))
    assert.match(p.prompt, /is NOT the repository/)
  }
})

test('a citation that resolves to nothing is counted, reaches every axis in the file, and is no hole in this probe', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS, agent: probeAgents({ ground: groundPayload({ counts: { cited: 2, files: 1, excerpts: 1, unresolved: 1 } }) }),
  })
  assert.equal(result.shared_ground.unresolved, 1)
  assert.match(result.coverage.unreached.join(' '), /resolve to nothing/)
  assert.equal(result.coverage.complete, true)
})

test('a failed ground read degrades to "read it yourself" and never quietly narrows', async () => {
  const { result, prompts } = await runWorkflow(WF, { args: ARGS, agent: probeAgents({ ground: () => { throw new Error('node missing') } }) })
  assert.equal(result.shared_ground.resolved, false)
  assert.match(promptOf(prompts, 'probe:ambiguity'), /reading it is yours to do: open each path:line the artefact cites/)
  assert.equal(result.coverage.complete, true, 'an unresolved shared ground costs turns, not coverage')
})

// ---------------------------------------------------------------- the derived-axis cap

const manyAxes = (n) => Array.from({ length: n }, (_, i) => ({ key: 'repo' + (i + 1), charge: 'attack thing ' + (i + 1), source: 'CLAUDE.md' }))

test('derived axes are capped at eight by default, named in the coverage block, and no coverage failure', async () => {
  const { result } = await runWorkflow(WF, { args: ARGS, agent: probeAgents({ axes: axesResult({ axes: manyAxes(12) }) }) })

  assert.equal(result.axes.length, 12, 'four standing plus eight derived')
  assert.deepEqual(result.axes_dropped, ['repo9', 'repo10', 'repo11', 'repo12'])
  assert.match(result.coverage.unreached.join(' '), /repo9: this axis was derived/)
  assert.ok(result.coverage.resumable.remaining.includes('repo10'))
  assert.deepEqual(result.coverage.dropped, [])
})

test('the cap is a caller\'s dial, and zero means the standing four alone', async () => {
  const { result } = await runWorkflow(WF, {
    args: { ...ARGS, max_derived_axes: 0 }, agent: probeAgents({ axes: axesResult({ axes: manyAxes(3) }) }),
  })
  assert.deepEqual(result.axes.map((a) => a.key), STANDING)
  assert.deepEqual(result.axes_dropped, ['repo1', 'repo2', 'repo3'])
})

// ------------------------------------------------------- the default: analysts earned by length

const DEFAULT_ARGS = { artifact: 'docs/proposal.md', roots: 'C:/repo' }
const sized = (lines, over = {}, opts) => probeAgents({ ground: groundPayload({ artifact_lines: lines }), ...over }, opts)
const ALL = `probe:${STANDING.join('+')}`

test('one analyst holds every axis on a document one reader can hold', async () => {
  const { result, prompts } = await runWorkflow(WF, { args: DEFAULT_ARGS, agent: sized(120, { axes: axesResult({ axes: manyAxes(3) }) }) })

  assert.equal(probesIn(prompts).length, 1)
  assert.deepEqual(result.analysts, [result.axes.map((a) => a.key)])
  const prompt = probesIn(prompts)[0].prompt
  for (const key of STANDING.concat(['repo1', 'repo2', 'repo3'])) assert.match(prompt, new RegExp('\\d+\\. ' + key))
  assert.equal(result.ratifiable, true)
})

test('an unknown length earns one analyst, not one per axis', async () => {
  const { result } = await runWorkflow(WF, { args: DEFAULT_ARGS, agent: probeAgents({ ground: () => { throw new Error('node missing') } }) })
  assert.equal(result.analysts.length, 1)
})

test('length earns more analysts, the axes are dealt across them, and never past one each', async () => {
  const { result } = await runWorkflow(WF, { args: DEFAULT_ARGS, agent: sized(900) })
  assert.equal(result.analysts.length, Math.ceil(900 / 400))
  assert.deepEqual(result.analysts.flat().sort(), [...STANDING].sort())
  const { result: huge } = await runWorkflow(WF, { args: DEFAULT_ARGS, agent: sized(50_000) })
  assert.equal(huge.analysts.length, STANDING.length)
})

test('a shared analyst tags each finding with the axis it belongs to, and the record carries its bundle', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: DEFAULT_ARGS,
    agent: sized(100, { 'probe:': found([finding({ axis: 'yagni', severity: 'gap' }), finding({ axis: 'ambiguity', severity: 'ambiguity' })]) }),
  })
  assert.deepEqual(result.findings.map((f) => f.axis), ['yagni', 'ambiguity'])
  assert.equal(result.ratifiable, false)
  const record = courierCommand(promptOf(prompts, 'record'))
  assert.deepEqual(flagValues(record, 'bundle'), [STANDING.join('+')])
  assert.deepEqual(flagValues(record, 'from'), [returnFileOf(promptOf(prompts, ALL))])
})

test('a reader that stops short is continued on what it never reached, and both passes are read', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: DEFAULT_ARGS,
    agent: sized(100, {
      [ALL]: stoppedShort({ findings: [finding({ axis: 'invariants' })], not_reached: '§5-§9 on yagni' }),
      [ALL + ':continued']: found([finding({ axis: 'yagni', severity: 'gap', claim: 'd' })]),
    }),
  })

  const continued = promptOf(prompts, ALL + ':continued')
  assert.match(continued, /Attack ONLY what it never reached:\n§5-§9 on yagni/)
  assert.ok(continued.includes(returnFileOf(promptOf(prompts, ALL))), 'the earlier pass is named, not retold')
  assert.deepEqual(result.findings.map((f) => f.axis), ['invariants', 'yagni'])
  assert.equal(result.coverage.complete, true)
})

test('a continuation that dies leaves its whole analyst\'s axes incomplete, not clean', async () => {
  const { result } = await runWorkflow(WF, {
    args: DEFAULT_ARGS,
    agent: sized(100, { [ALL]: stoppedShort({ not_reached: '§8' }), [ALL + ':continued']: () => { throw new Error('model unavailable') } }),
  })
  assert.deepEqual([...result.coverage.incomplete].sort(), [...STANDING].sort())
  assert.equal(result.ratifiable, false)
})

// ------------------------------------------------------- locating, for analysts that cannot search

test('one scout locates the guidance and the ground, a courier per reader writes it from the scout\'s reports, and both reach their readers', async () => {
  const { prompts } = await runWorkflow(WF, { args: DEFAULT_ARGS, agent: probeAgents() })

  const locate = prompts.find((p) => p.opts.label === 'locate')
  assert.equal(locate.opts.agentType, 'agentics:scout')
  const report = returnFileOf(locate.prompt)
  for (const [label, kind] of [['guidance-context', 'guidance'], ['ground-context', 'ground']]) {
    const command = courierCommand(promptOf(prompts, label))
    assert.match(command, /lib\/citations\.mjs" excerpts --repo "C:\/repo" --hits "/)
    assert.deepEqual([flagValues(command, 'hits'), flagValues(command, 'hit-kind')], [[report], [kind]])
  }

  const axes = promptOf(prompts, 'axes')
  assert.ok(axes.includes(contextPath('guidance')))
  assert.ok(!axes.includes(contextPath('ground')), 'ground is the probers\', not the axes\'')
  const probe = probesIn(prompts)[0].prompt
  assert.match(probe, /REPOSITORY GROUND/)
  assert.ok(probe.includes(contextPath('ground')))
})

test('an exhausted search that finds no guidance buys no axes analyst and costs no coverage', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: DEFAULT_ARGS, agent: probeAgents({ locate: located({ hits: [located().hits[1]] }) }),
  })
  assert.ok(!prompts.some((p) => p.opts.label === 'axes' || p.opts.label === 'guidance-context'))
  assert.deepEqual(result.axes.map((a) => a.key), STANDING)
  assert.equal(result.ratifiable, true)
})

test('a locating scout that never reports leaves both halves unread, and the gate closed', async () => {
  const { result, prompts } = await runWorkflow(WF, { args: DEFAULT_ARGS, agent: probeAgents({ locate: () => { throw new Error('model unavailable') } }) })
  assert.ok(!prompts.some((p) => p.opts.label === 'axes' || /-context/.test(p.opts.label)))
  assert.deepEqual(result.coverage.failed_channels.sort(), ['repo-axes', 'repo-ground'])
  assert.equal(result.ratifiable, false)
  assert.match(probesIn(prompts)[0].prompt, /REPOSITORY GROUND: NOT LOCATED/)
})

test('an unfinished locating search is resumed from its reports, and a stuck one is incomplete work', async () => {
  const stalled = located({ stop_reason: 'unfinished', not_reached: 'docs/adr/ never opened' })
  const { result, prompts } = await runWorkflow(WF, { args: DEFAULT_ARGS, agent: probeAgents({ locate: stalled, 'locate#2': stalled }) })

  const resumed = promptOf(prompts, 'locate#2')
  assert.match(resumed, /STILL NOT REACHED[\s\S]*docs\/adr\/ never opened/)
  assert.ok(resumed.includes(returnFileOf(promptOf(prompts, 'locate'))))
  assert.ok(!prompts.some((p) => p.opts.label === 'locate#3'), 'a round that gains nothing ends it')
  assert.deepEqual(flagValues(courierCommand(promptOf(prompts, 'ground-context')), 'hits').length, 2, 'both rounds are read')
  assert.ok(result.coverage.incomplete.includes('locate'))
  assert.equal(result.ratifiable, false)
})

test('located ground the courier could not carry reaches the analysts as the scout\'s reports to follow', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: DEFAULT_ARGS,
    agent: probeAgents({ 'guidance-context': failedCourier, 'guidance-context#2': failedCourier, 'ground-context': failedCourier, 'ground-context#2': failedCourier }),
  })
  const report = returnFileOf(promptOf(prompts, 'locate'))
  assert.match(promptOf(prompts, 'axes'), /LOCATIONS NOT EXCERPTED[\s\S]*of kind "guidance"/)
  assert.ok(promptOf(prompts, 'axes').includes(report))
  assert.match(probesIn(prompts)[0].prompt, /LOCATIONS NOT EXCERPTED[\s\S]*of kind "ground"/)
  assert.equal(result.coverage.complete, true, 'more turns for the readers, not less evidence')
  assert.match(result.coverage.unreached.join(' '), /read those locations themselves/)
})

// ------------------------------------------------------------------ findings as evidence items

const narrowedScope = (over = {}) => scopeOf({
  since: 'snapshot:11111111', full: false, changed: [{ start: 31, end: 33 }], context: CARRIED_PATH,
  carried: [{ item: 'Iaaaaaaaa', severity: 'note', axis: 'yagni', section: '2' }], ...over,
})
const carriedLab = (handles) => { lab.carried = handles.map((h) => ({ ...h, carried: true })) }

test('the artefact is snapshotted before anything reads it, and the result names the snapshot', async () => {
  const { result, prompts } = await runWorkflow(WF, { args: ARGS, agent: probeAgents() })
  assert.equal(prompts[0].opts.label, 'scope')
  assert.equal(courierCommand(prompts[0].prompt), 'node "$CLAUDE_PLUGIN_ROOT/lib/evidence.mjs" review-scope --repo "C:/repo" --root "C:/repo" --file "docs/proposal.md"')
  assert.equal(result.snapshot, SNAP)
  assert.deepEqual(result.scope, { full: true, changed: [{ start: 1, end: 40 }] })
})

test('the round is closed by one record courier, handed every prober\'s file, its bundle and the snapshot', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: ARGS, agent: probeAgents({ 'probe:yagni': found([finding({ severity: 'gap', claim: 'the cache is unasked for' })]) }),
  })

  const records = prompts.filter((p) => /^record/.test(p.opts.label))
  assert.deepEqual(records.map((p) => p.opts.label), ['record'])
  const command = courierCommand(records[0].prompt)
  assert.match(command, /record --repo "C:\/repo" --root "C:\/repo" --kind probe --file "docs\/proposal\.md" --snapshot snapshot:22222222/)
  assert.deepEqual(flagValues(command, 'from'), STANDING.map((k) => returnFileOf(promptOf(prompts, 'probe:' + k))))
  assert.deepEqual(flagValues(command, 'bundle'), STANDING)

  assert.equal(result.findings[0].item, 'I' + fnv1a('the cache is unasked for'))
  assert.equal(result.findings[0].carried, false)
  assert.equal(result.review, '20260926-120000-probe')
  assert.deepEqual(result.unrecorded, [])
})

test('since narrows the attack to the changed lines and carries forward what no edit touched', async () => {
  carriedLab([{ item: 'Iaaaaaaaa', severity: 'note', axis: 'yagni', section: '2' }])
  const { result, prompts } = await runWorkflow(WF, {
    args: { ...ARGS, since: 'snapshot:11111111' },
    agent: probeAgents({ scope: narrowedScope(), 'probe:yagni': found([finding({ claim: 'a new gap', severity: 'gap' })]) }),
  })
  lab.carried = []

  assert.match(courierCommand(promptOf(prompts, 'scope')), /--since "snapshot:11111111"$/)
  for (const p of probesIn(prompts)) {
    assert.match(p.prompt, /ATTACK ONLY THESE LINES[\s\S]*31-33/, p.opts.label)
    assert.ok(p.prompt.includes(CARRIED_PATH), p.opts.label + ' reads what is settled from the file lib wrote')
  }
  assert.match(courierCommand(promptOf(prompts, 'record')), /--since "snapshot:11111111"/)
  assert.deepEqual(result.findings.map((f) => [f.id, f.carried]), [['P1', true], ['P2', false]], 'carried findings come first')
  assert.deepEqual(result.scope, { full: false, changed: [{ start: 31, end: 33 }] })
})

test('a since that is not a snapshot id never reaches a command and buys a full probe', async () => {
  for (const since of ['HEAD~1', 'snapshot:1234', 'snapshot:22222222"; rm -rf ~; echo "']) {
    const { prompts, logs } = await runWorkflow(WF, { args: { ...ARGS, since }, agent: probeAgents() })
    for (const p of prompts.filter((x) => x.opts.agentType === 'agentics:courier')) assert.doesNotMatch(p.prompt, /--since|rm -rf/, since)
    assert.ok(logs.some((l) => /not a snapshot id/.test(l)), since)
  }
})

test('a carried ambiguity is still an open ambiguity, and closes the gate', async () => {
  carriedLab([{ item: 'Iaaaaaaaa', severity: 'ambiguity', axis: 'ambiguity', section: '1' }])
  const { result } = await runWorkflow(WF, { args: { ...ARGS, since: 'snapshot:11111111' }, agent: probeAgents({ scope: narrowedScope() }) })
  lab.carried = []
  assert.equal(result.ambiguities.length, 1)
  assert.equal(result.ambiguities[0].carried, true)
  assert.equal(result.ratifiable, false)
})

test('an artefact unchanged since the last review buys no analyst, and its clean round is recorded', async () => {
  carriedLab([{ item: 'Iaaaaaaaa', severity: 'note', axis: 'yagni', section: '2' }])
  const { result, prompts, logs } = await runWorkflow(WF, {
    args: { ...ARGS, since: 'snapshot:11111111' }, agent: probeAgents({ scope: narrowedScope({ changed: [] }) }),
  })
  lab.carried = []
  assert.deepEqual(prompts.map((p) => p.opts.label), ['scope', 'record'])
  assert.deepEqual(flagValues(courierCommand(promptOf(prompts, 'record')), 'from'), [], 'no prober, no file')
  assert.equal(result.review, '20260926-120000-probe')
  assert.deepEqual(result.findings.map((f) => f.item), ['Iaaaaaaaa'])
  assert.equal(result.coverage.complete, true)
  assert.equal(result.ratifiable, true)
  assert.ok(logs.some((l) => /unchanged since/.test(l)))
})

test('a scope that cannot be read costs a full probe, never a narrowed one, and records nothing', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: { ...ARGS, since: 'snapshot:11111111' },
    agent: probeAgents({ scope: failedCourier, 'scope#2': failedCourier, 'probe:yagni': found([finding()]) }),
  })
  assert.equal(probesIn(prompts).length, STANDING.length, 'every axis is attacked in full')
  assert.ok(probesIn(prompts).every((p) => !/ATTACK ONLY THESE LINES/.test(p.prompt)))
  assert.doesNotMatch(courierCommand(promptOf(prompts, 'record')), /--snapshot/, 'without a snapshot nothing is anchored')
  assert.equal(result.findings.length, 1, 'the findings are still read back')
  assert.equal(result.snapshot, '')
  assert.equal(result.coverage.complete, true, 'a lost snapshot costs a full probe, not coverage')
})

test('a round that cannot be closed holds no findings, fails coverage, and names no snapshot', async () => {
  const { result, logs } = await runWorkflow(WF, {
    args: ARGS, agent: probeAgents({ record: failedCourier, 'record#2': failedCourier, 'probe:yagni': found([finding()]) }),
  })
  assert.deepEqual(result.findings, [])
  assert.ok(result.coverage.failed_channels.includes('record'))
  assert.equal(result.coverage.complete, false)
  assert.equal(result.ratifiable, false, 'findings nobody read back are not findings nobody made')
  assert.equal(result.snapshot, '')
  assert.ok(logs.some((l) => /not read or recorded/.test(l)))
})

test('a refused record leaves its findings unrecorded and names no snapshot, so the next round probes in full', async () => {
  const { result, logs } = await runWorkflow(WF, {
    args: ARGS, agent: probeAgents({ 'probe:yagni': found([finding(), finding({ claim: 'a second gap' })]) }, { refuse: true }),
  })
  assert.deepEqual(result.unrecorded, ['P1', 'P2'])
  assert.equal(result.snapshot, '')
  assert.equal(result.review, '')
  assert.equal(result.coverage.complete, true)
  assert.ok(logs.some((l) => /not recorded \(2 refused/.test(l)))
})

test('a handle the reader refused as damaged on its way in is carried again by the stronger courier', async () => {
  const refusal = carriedEnvelope({ ok: false, error: { kind: 'args_unreadable' } })
  const { result, prompts } = await runWorkflow(WF, {
    args: ARGS, agent: probeAgents({ 'ground-context': { ...refusal, stop_reason: 'failed' }, 'ground-context#2': contextOf('ground') }),
  })
  assert.deepEqual(prompts.filter((p) => /^ground-context/.test(p.opts.label)).map((p) => [p.opts.label, p.opts.model]),
    [['ground-context', 'haiku'], ['ground-context#2', 'sonnet']])
  assert.equal(result.coverage.complete, true)
})

test('a probe run from a linked worktree reads, writes and records there', async () => {
  const { prompts } = await runWorkflow(WF, { args: { ...ARGS, roots: 'C:/wt/e1-a' }, agent: probeAgents() })
  assert.match(courierCommand(promptOf(prompts, 'scope')), /review-scope --repo "C:\/wt\/e1-a" --root "C:\/wt\/e1-a" --file /)
  assert.match(courierCommand(promptOf(prompts, 'record')), /record --repo "C:\/wt\/e1-a" --root "C:\/wt\/e1-a" --kind probe /)
  assert.match(returnFileOf(promptOf(prompts, 'locate')), /^C:\/wt\/e1-a\/\.agentics\/\.state\/evidence\/inbox\//)
})

test('a narrowed re-review is sized by the lines it attacks, not by the whole artefact', async () => {
  const { result } = await runWorkflow(WF, {
    args: { artifact: 'docs/proposal.md', roots: 'C:/repo', since: 'snapshot:11111111' },
    agent: probeAgents({ ground: groundPayload({ artifact_lines: 900 }), scope: narrowedScope({ lines: 900 }) }),
  })
  assert.equal(result.analysts.length, 1, 'three changed lines are one reader\'s work')
})
