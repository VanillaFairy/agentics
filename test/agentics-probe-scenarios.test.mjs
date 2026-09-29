// test/agentics-probe-scenarios.test.mjs — attack-document-with-independent-reviewers's arithmetic: axis assembly, finding
// attribution, and the computed ratification gate.
//
// The property worth pinning hardest is the one a reader cannot check by reading: an axis
// whose prober died and an axis that honestly found nothing produce the SAME empty findings
// list, and mean opposite things. Everything below exists to keep those two apart.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  carriedContext, carriedEnvelope, contextPathFor, excerptLocations, jsonChunks, recordedLine, runWorkflow, scriptedAgents,
} from './harness/workflow-host.mjs'
import { itemId } from '../lib/evidence.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { decodeArgs } from '../lib/store.mjs'

const WF = fileURLToPath(new URL('../service-workflows/attack-document-with-independent-reviewers.workflow.js', import.meta.url))

// Most scenarios below pin per-axis arithmetic, so they ask for the per-axis shape by name; the
// default, one analyst holding every axis, has its own section at the end.
const ARGS = { artifact: 'docs/proposal.md', roots: 'C:/repo', per_axis: true }

const STANDING = ['ambiguity', 'invariants', 'yagni', 'reinvention']

const axesResult = (over = {}) => ({
  stop_reason: 'completed',
  axes: [],
  guidance_read: ['CLAUDE.md'],
  notes: 'read the project guidance',
  ...over,
})

// A prober that read the whole artefact says so. `stop_reason` is what separates "attacked
// it all and found nothing" from "got halfway" — the two produce the same empty findings
// list — so the default here is the exhausted one and the short reads are opt-in.
const found = (findings = [], notes = 'attacked') =>
  ({ findings, notes, stop_reason: 'exhausted', not_reached: '' })

const stoppedShort = (over = {}) =>
  ({ findings: [], notes: '', stop_reason: 'unfinished', not_reached: '', ...over })

const finding = (over = {}) => ({
  severity: 'note', section: '§3', claim: 'c', evidence: 'e', ...over,
})

// What the locating scout reports by default: one passage of guidance and one place the
// artefact talks about, and an exhausted search.
const located = (over = {}) => ({
  hits: [
    { path: 'CLAUDE.md', line: 40, note: 'reviewers check counters', kind: 'guidance' },
    { path: 'lib/loader.mjs', line: 12, note: 'the loader the proposal replaces', kind: 'ground' },
  ],
  searched: ['glob **/CLAUDE.md', 'grep loader'], stop_reason: 'exhausted', no_match: '', not_reached: '',
  ...over,
})

// Every probe snapshots its artefact first and records what it found. By default the scope is a
// full review of a 40-line document and the store accepts every item, which keeps the scenarios
// below about the thing each one tests.
const SNAP = 'snapshot:22222222'
const scopeOf = (over = {}) => carriedEnvelope({
  ok: true, path: 'docs/proposal.md', snapshot: SNAP, lines: 40, since: '', full: true,
  changed: [{ start: 1, end: 40 }], carried: [], ...over,
})
const recordAll = (prompt) => carriedEnvelope({
  ok: true, return: '20260926-120000-probe', ids: recordedLine(prompt).entry.items.map(itemId),
})

// `probe:` is a PREFIX key and scriptedAgents takes the first entry that matches, so the
// catch-all has to be registered LAST or it swallows every per-axis answer a scenario sets.
const probeAgents = ({ ...over } = {}) => {
  const catchAll = over['probe:'] || found()
  delete over['probe:']
  return scriptedAgents({
    scope: scopeOf(), record: recordAll, 'record:': recordAll,
    locate: located(), 'guidance-context': carriedContext, 'ground-context': carriedContext, axes: axesResult(), ...over, 'probe:': catchAll,
  })
}

test('the four standing axes run even when the repository states no guidance', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({ axes: axesResult({ stop_reason: 'no_guidance_found', axes: [] }) }),
  })

  assert.deepEqual(result.axes.map((a) => a.key), STANDING)
  assert.equal(prompts.filter((p) => /^probe:/.test(p.opts.label)).length, 4)
  assert.equal(result.ratifiable, true)
  assert.equal(result.coverage.complete, true)
})

test("the repository's own axes are added to the standing four, with their source", async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({
      axes: axesResult({ axes: [
        { key: 'iron-law', charge: 'find counter-based termination', source: 'CLAUDE.md' },
      ] }),
    }),
  })

  assert.deepEqual(result.axes.map((a) => a.key), [...STANDING, 'iron-law'])
  assert.equal(result.axes.find((a) => a.key === 'iron-law').source, 'CLAUDE.md')
  assert.deepEqual(result.guidance_read, ['CLAUDE.md'])
})

test('an axis with no charge is not dispatched as one', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({
      axes: axesResult({ axes: [{ key: 'empty', charge: '', source: 'CLAUDE.md' }] }),
    }),
  })

  assert.deepEqual(result.axes.map((a) => a.key), STANDING)
})

test('one open ambiguity closes the gate, however many notes accompany it', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({
      'probe:ambiguity': found([
        finding({ severity: 'ambiguity', claim: 'TapTarget is defined twice' }),
      ]),
      'probe:': found([finding(), finding({ severity: 'note' })]),
    }),
  })

  assert.equal(result.ratifiable, false)
  assert.equal(result.ambiguities.length, 1)
  assert.match(result.ambiguities[0].claim, /defined twice/)
  assert.equal(result.ambiguities[0].axis, 'ambiguity')
  // Coverage is about what was examined, not about what was found. Every axis reported.
  assert.equal(result.coverage.complete, true)
})

test('a gap alone does not close the gate', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({ 'probe:yagni': found([finding({ severity: 'gap' })]) }),
  })

  assert.equal(result.ratifiable, true, 'a gap is accepted out loud, it does not block')
  assert.equal(result.findings.length, 1)
})

test('an axis whose prober died is unexamined, never a silent pass', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({
      'probe:reinvention': () => { throw new Error('model unavailable') },
    }),
  })

  assert.deepEqual(result.findings, [], 'the survivors genuinely found nothing')
  assert.equal(result.ratifiable, false,
    'nobody looked for reinvention, and nobody-looked is not nothing-there')
  assert.deepEqual(result.coverage.dropped, ['reinvention'])
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.failed_channels.includes('probe'))
  assert.deepEqual(result.coverage.resumable.remaining, ['reinvention'])
})

test('an axis that stopped halfway is not an axis that came back clean', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({
      'probe:yagni': stoppedShort({ not_reached: '§7 onward' }),
      // Its continuation is handed '§7 onward' and hands the same remainder back: no progress,
      // so no further pass, and the gap stays open.
      'probe:yagni:continued': stoppedShort({ not_reached: '§7 onward' }),
    }),
  })

  assert.deepEqual(result.findings, [], 'the same empty list a clean probe returns')
  assert.equal(result.ratifiable, false,
    'a half-read artefact cannot compute a clean bill of health')
  assert.deepEqual(result.coverage.incomplete, ['yagni'])
  assert.deepEqual(result.coverage.dropped, [], 'it reported — it just did not finish')
  assert.equal(result.coverage.complete, false)
  assert.ok(result.coverage.unreached.some((u) => /§7 onward/.test(u)))
  assert.deepEqual(result.coverage.resumable.remaining, ['yagni'])
})

test('a short read keeps the findings it did make', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({
      'probe:ambiguity': stoppedShort({ findings: [finding({ severity: 'ambiguity' })] }),
    }),
  })

  assert.equal(result.ambiguities.length, 1, 'its findings stand')
  assert.equal(result.ratifiable, false)
  assert.ok(result.coverage.unreached.some((u) => /without naming what it missed/.test(u)))
})

test('a missing stop_reason normalizes toward unfinished, never toward done', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({ 'probe:invariants': { findings: [], notes: '' } }),
  })

  assert.equal(result.ratifiable, false, 'silence is not exhaustion')
  assert.deepEqual(result.coverage.incomplete, ['invariants'])
})

test('ratifiable implies coverage.complete — the repo-axes hole included', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({ axes: () => { throw new Error('unreadable') } }),
  })

  assert.deepEqual(result.findings, [], 'the four standing axes all came back clean')
  assert.ok(result.coverage.failed_channels.includes('repo-axes'))
  assert.equal(result.coverage.complete, false)
  assert.equal(result.ratifiable, false,
    "the project's own review standard was never discovered — nobody looked, one level up")
})

test('findings carry their axis and a stable id', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({
      'probe:ambiguity': found([finding({ severity: 'ambiguity' })]),
      'probe:yagni': found([finding({ severity: 'gap' }), finding()]),
      'probe:': found(),
    }),
  })

  assert.deepEqual(result.findings.map((f) => f.id), ['P1', 'P2', 'P3'])
  assert.deepEqual(result.findings.map((f) => f.axis), ['ambiguity', 'yagni', 'yagni'])
})

test('losing the repo guidance degrades the probe and says which half ran', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({ axes: () => { throw new Error('no such directory') } }),
  })

  assert.deepEqual(result.axes.map((a) => a.key), STANDING, 'the standing axes still run')
  assert.ok(result.coverage.failed_channels.includes('repo-axes'))
  assert.equal(result.coverage.complete, false)
  assert.match(result.coverage.unreached.join(' '), /own review guidance was never read/)
})

test('no artefact probes nothing and says so', async () => {
  const { result } = await runWorkflow(WF, { args: {}, agent: probeAgents() })

  assert.equal(result.ratifiable, false)
  assert.deepEqual(result.findings, [])
  assert.equal(result.coverage.complete, false)
  assert.match(result.coverage.unreached.join(' '), /no artefact path/)
})

test('the prober prompt carries the artefact, the ladder, and no author intent', async () => {
  const { prompts } = await runWorkflow(WF, {
    args: { ...ARGS, context: 'the increment-4 proposal' },
    agent: probeAgents(),
  })

  const probe = prompts.find((p) => p.opts.label === 'probe:ambiguity').prompt
  assert.match(probe, /docs\/proposal\.md/)
  assert.match(probe, /THE LADDER/)
  assert.match(probe, /the increment-4 proposal/)
  assert.match(probe, /You do not have the author's reasoning/)
  assert.match(probe, /Finding nothing on your axis after an honest attack IS your report/)
})

test('every probe reads the repository, not only the document', async () => {
  const { prompts } = await runWorkflow(WF, { args: ARGS, agent: probeAgents() })

  for (const p of prompts.filter((x) => /^probe:/.test(x.opts.label))) {
    assert.match(p.prompt, /C:\/repo/,
      `${p.opts.label} was not pointed at the repository it would be implemented in`)
  }
})

// -------------------------------------------------------------------------- shared ground
//
// The measured probe spent its bill on sixteen analysts independently LOCATING the same
// evidence. What is pinned here is that the resolution happens once, reaches every axis, and
// degrades into "locate it yourself" rather than into a quieter probe.

const CITED_PATH = 'C:/repo/.agentics/.state/context/c17ed000-1.md'

const groundPayload = (over = {}) => carriedEnvelope({
  artifact: 'docs/proposal.md',
  repo: 'C:/repo',
  read_error: '',
  context: { digest: 'c17ed000', parts: [{ path: CITED_PATH, lines: 22, bytes: 700 }] },
  unresolved: [],
  counts: { cited: 1, files: 1, excerpts: 1, unresolved: 0 },
  notes: 'resolved 1 excerpt(s)',
  ...over,
})

const withGround = (over = {}) => probeAgents({ ground: groundPayload(), ...over })

test('the document\'s cited evidence is resolved once and reaches every axis', async () => {
  const { result, prompts } = await runWorkflow(WF, { args: ARGS, agent: withGround() })

  assert.equal(prompts.filter((p) => p.opts.label === 'ground').length, 1,
    'the citations are resolved once, not once per axis')
  assert.equal(result.shared_ground.resolved, true)

  for (const p of prompts.filter((x) => /^probe:/.test(x.opts.label))) {
    assert.match(p.prompt, /WHAT THE DOCUMENT POINTS AT/, `${p.opts.label} got no shared ground`)
    assert.ok(p.prompt.includes(CITED_PATH), `${p.opts.label} was not handed the cited context file`)
    assert.match(p.prompt, /is NOT the repository/,
      `${p.opts.label} was not told the excerpts are a starting point rather than the evidence`)
  }
})

test('a citation that resolves to nothing reaches every axis as a finding to rule on', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: ARGS,
    agent: withGround({
      ground: groundPayload({
        unresolved: [{ path: 'lib/gone.mjs', why: 'missing', detail: 'the document cites lib/gone.mjs and no such file exists in this repository' }],
        counts: { cited: 2, files: 1, excerpts: 1, unresolved: 1 },
      }),
    }),
  })

  assert.equal(result.shared_ground.unresolved.length, 1)
  assert.match(prompts.find((p) => p.opts.label === 'probe:yagni').prompt,
    /any citation that resolves to nothing, which is evidence about the DOCUMENT/)
  assert.match(result.coverage.unreached.join(' '), /resolve to nothing/)
  assert.equal(result.coverage.complete, true,
    'a broken citation is a fact about the document, not a hole in this probe')
})

test('a failed ground read degrades to "read it yourself" and never quietly narrows', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({ ground: () => { throw new Error('node missing') } }),
  })

  assert.equal(result.shared_ground.resolved, false)
  assert.match(prompts.find((p) => p.opts.label === 'probe:ambiguity').prompt,
    /reading it is yours to do: open each path:line the artefact cites/)
  assert.equal(result.coverage.complete, true,
    'an unresolved shared ground costs turns, not coverage')
  assert.match(result.coverage.unreached.join(' '), /no finding above\s+rests on it/)
})

// ---------------------------------------------------------------- the derived-axis cap (4b)

const manyAxes = (n) => Array.from({ length: n }, (_, i) => ({
  key: 'repo' + (i + 1), charge: 'attack thing ' + (i + 1), source: 'CLAUDE.md',
}))

test('derived axes are capped at eight by default, and the standing four are never capped', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: withGround({ axes: axesResult({ axes: manyAxes(12) }) }),
  })

  assert.equal(result.axes.length, 12, 'four standing plus eight derived')
  assert.deepEqual(result.axes.slice(0, 4).map((a) => a.key), STANDING)
  assert.deepEqual(result.axes_dropped, ['repo9', 'repo10', 'repo11', 'repo12'])
})

test('a capped axis is named in the coverage block, not in a log line', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: withGround({ axes: axesResult({ axes: manyAxes(10) }) }),
  })

  assert.match(result.coverage.unreached.join(' '), /repo9: this axis was derived/)
  assert.ok(result.coverage.resumable.remaining.includes('repo10'),
    'a caller who wants the dropped axes can re-run for exactly them')
})

test('a declared narrowing does not read as a coverage failure', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: withGround({ axes: axesResult({ axes: manyAxes(12) }) }),
  })

  assert.deepEqual(result.coverage.dropped, [],
    'dropped stays what it means: an axis this probe commissioned and got no report from')
  assert.equal(result.coverage.complete, true)
  assert.equal(result.ratifiable, true)
})

test('the cap is a caller\'s dial, and zero means the standing four alone', async () => {
  const { result } = await runWorkflow(WF, {
    args: { ...ARGS, max_derived_axes: 0 },
    agent: withGround({ axes: axesResult({ axes: manyAxes(3) }) }),
  })

  assert.deepEqual(result.axes.map((a) => a.key), STANDING)
  assert.deepEqual(result.axes_dropped, ['repo1', 'repo2', 'repo3'])
})

test('under the cap nothing is dropped and nothing is said about dropping', async () => {
  const { result } = await runWorkflow(WF, {
    args: ARGS,
    agent: withGround({ axes: axesResult({ axes: manyAxes(2) }) }),
  })

  assert.deepEqual(result.axes_dropped, [])
  assert.equal(result.coverage.unreached.length, 0)
})

// ------------------------------------------------------- the default: analysts earned by length
//
// The axes are a checklist for a reader, not a head count. What is pinned here is that one
// analyst holds every axis unless the artefact is long enough to earn more, that the head count
// never exceeds the axes, and that a reader who stops short is continued on exactly what it
// never reached rather than written off.

const DEFAULT_ARGS = { artifact: 'docs/proposal.md', roots: 'C:/repo' }
const probeLabels = (prompts) =>
  prompts.filter((p) => /^probe:/.test(p.opts.label)).map((p) => p.opts.label)
const sized = (lines, over = {}) =>
  probeAgents({ ground: groundPayload({ artifact_lines: lines }), ...over })

test('one analyst holds every axis on a document one reader can hold', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: DEFAULT_ARGS,
    agent: sized(120, { axes: axesResult({ axes: manyAxes(3) }) }),
  })

  assert.equal(probeLabels(prompts).length, 1)
  assert.deepEqual(result.analysts, [result.axes.map((a) => a.key)])
  const prompt = prompts.find((p) => /^probe:/.test(p.opts.label)).prompt
  for (const key of STANDING.concat(['repo1', 'repo2', 'repo3'])) {
    assert.match(prompt, new RegExp('\\d+\\. ' + key), `${key} missing from the checklist`)
  }
  assert.equal(result.ratifiable, true)
})

test('an unknown length earns one analyst, not one per axis', async () => {
  const { result } = await runWorkflow(WF, {
    args: DEFAULT_ARGS,
    agent: probeAgents({ ground: () => { throw new Error('node missing') } }),
  })

  assert.equal(result.analysts.length, 1)
})

test('length earns more analysts, the axes are dealt across them, and never past one each', async () => {
  const lines = 900
  const { result } = await runWorkflow(WF, { args: DEFAULT_ARGS, agent: sized(lines) })

  assert.equal(result.analysts.length, Math.ceil(lines / 400))
  assert.deepEqual(result.analysts.flat().sort(), [...STANDING].sort(), 'every axis held once')

  const { result: huge } = await runWorkflow(WF, { args: DEFAULT_ARGS, agent: sized(50_000) })
  assert.equal(huge.analysts.length, STANDING.length)
})

test('a shared analyst tags each finding with the axis it belongs to', async () => {
  const { result } = await runWorkflow(WF, {
    args: DEFAULT_ARGS,
    agent: sized(100, {
      'probe:': found([
        finding({ axis: 'yagni', severity: 'gap' }),
        finding({ axis: 'ambiguity', severity: 'ambiguity' }),
      ]),
    }),
  })

  assert.deepEqual(result.findings.map((f) => f.axis), ['yagni', 'ambiguity'])
  assert.equal(result.ratifiable, false)
})

test('a reader that stops short is continued on what it never reached, and then counts as done', async () => {
  const label = `probe:${STANDING.join('+')}`
  const { result, prompts } = await runWorkflow(WF, {
    args: DEFAULT_ARGS,
    agent: sized(100, {
      [label]: stoppedShort({
        findings: [finding({ axis: 'invariants' })], not_reached: '§5-§9 on yagni',
      }),
      [label + ':continued']: found([finding({ axis: 'yagni', severity: 'gap' })]),
    }),
  })

  const continued = prompts.find((p) => p.opts.label === label + ':continued')
  assert.ok(continued, 'no continuation was dispatched')
  assert.match(continued.prompt, /Attack ONLY what it never reached:\n§5-§9 on yagni/)
  assert.deepEqual(result.findings.map((f) => f.axis), ['invariants', 'yagni'],
    'both passes\' findings stand')
  assert.equal(result.coverage.complete, true)
  assert.equal(result.ratifiable, true)
})

test('a continuation that dies leaves its whole analyst\'s axes incomplete, not clean', async () => {
  const label = `probe:${STANDING.join('+')}`
  const { result } = await runWorkflow(WF, {
    args: DEFAULT_ARGS,
    agent: sized(100, {
      [label]: stoppedShort({ not_reached: '§8' }),
      [label + ':continued']: () => { throw new Error('model unavailable') },
    }),
  })

  assert.deepEqual([...result.coverage.incomplete].sort(), [...STANDING].sort())
  assert.equal(result.ratifiable, false)
  assert.ok(result.coverage.unreached.some((u) => /§8/.test(u)))
})

// ------------------------------------------------------- locating, for analysts that cannot search
//
// The analysts carry `Read` and nothing that searches. So the repository's review guidance and the
// ground the document talks about are located by ONE scout, read once by a script into context
// files, and handed over as their paths; nothing downstream relies on an analyst finding anything
// for itself.

test('one scout locates the guidance and the ground, a courier per reader writes it, and both reach their readers', async () => {
  const { prompts } = await runWorkflow(WF, { args: DEFAULT_ARGS, agent: probeAgents() })

  const locate = prompts.find((p) => p.opts.label === 'locate')
  assert.equal(locate.opts.agentType, 'agentics:scout')
  assert.match(locate.prompt, /docs\/proposal\.md/)

  const courier = (label) => prompts.find((p) => p.opts.label === label)
  for (const label of ['guidance-context', 'ground-context']) {
    assert.equal(courier(label).opts.agentType, 'agentics:courier')
    assert.match(courier(label).prompt, /lib\/citations\.mjs" excerpts --repo "C:\/repo" --locs "/)
  }
  const pathOf = (label) => contextPathFor(excerptLocations(courier(label).prompt).digest)
  assert.deepEqual(excerptLocations(courier('guidance-context').prompt).locations.map((l) => l.path), ['CLAUDE.md'])
  assert.deepEqual(excerptLocations(courier('ground-context').prompt).locations.map((l) => l.path), ['lib/loader.mjs'])

  const axes = prompts.find((p) => p.opts.label === 'axes')
  assert.equal(axes.opts.agentType, 'agentics:analyst')
  assert.ok(axes.prompt.includes(pathOf('guidance-context')), 'the guidance arrives read, not as a path to go find')
  assert.ok(!axes.prompt.includes(pathOf('ground-context')), 'ground is the probers\', not the axes\'')

  const probe = prompts.find((p) => /^probe:/.test(p.opts.label))
  assert.match(probe.prompt, /REPOSITORY GROUND/)
  assert.ok(probe.prompt.includes(pathOf('ground-context')))
  assert.match(probe.prompt, /nothing that searches/)
})

test('every courier here is the courier, on the develop CARRIED shape without the todo fields', async () => {
  const { prompts } = await runWorkflow(WF, { args: DEFAULT_ARGS, agent: probeAgents({ ground: groundPayload() }) })

  const ground = prompts.find((p) => p.opts.label === 'ground')
  assert.equal(ground.opts.agentType, 'agentics:courier')
  assert.equal(ground.opts.model, 'haiku')
  assert.deepEqual(ground.opts.schema.required, ['stop_reason', 'payload_raw', 'notes'])
  assert.ok(!prompts.some((p) => /agentics:(ground|kb|verifier)/.test(p.opts.agentType)))
})

test('an exhausted search that finds no guidance buys no axes analyst and costs no coverage', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: DEFAULT_ARGS,
    agent: probeAgents({ locate: located({ hits: [located().hits[1]], no_match: 'no review guidance anywhere' }) }),
  })

  assert.ok(!prompts.some((p) => p.opts.label === 'axes'))
  assert.deepEqual(result.axes.map((a) => a.key), STANDING)
  assert.equal(result.coverage.complete, true)
  assert.equal(result.ratifiable, true)
})

test('a locating scout that never reports leaves both halves unread, and the gate closed', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: DEFAULT_ARGS,
    agent: probeAgents({ locate: () => { throw new Error('model unavailable') } }),
  })

  assert.ok(!prompts.some((p) => p.opts.label === 'axes' || /-context/.test(p.opts.label)))
  assert.deepEqual(result.coverage.failed_channels.sort(), ['repo-axes', 'repo-ground'])
  assert.equal(result.ratifiable, false, 'analysts that cannot search were handed no repository')
  assert.match(prompts.find((p) => /^probe:/.test(p.opts.label)).prompt, /REPOSITORY GROUND: NOT LOCATED/)
  assert.match(result.coverage.unreached.join(' '), /own review guidance was never read/)
})

test('an unfinished locating search is resumed, and a stuck one is incomplete work', async () => {
  const stalled = located({ stop_reason: 'unfinished', not_reached: 'docs/adr/ never opened' })
  const { result, prompts } = await runWorkflow(WF, {
    args: DEFAULT_ARGS, agent: probeAgents({ locate: stalled, 'locate#2': stalled }),
  })

  const resumed = prompts.find((p) => p.opts.label === 'locate#2')
  assert.match(resumed.prompt, /STILL NOT REACHED[\s\S]*docs\/adr\/ never opened/)
  assert.ok(!prompts.some((p) => p.opts.label === 'locate#3'), 'a round that gains nothing ends it')
  assert.ok(result.coverage.incomplete.includes('locate'))
  assert.equal(result.ratifiable, false)
  assert.match(result.coverage.unreached.join(' '), /never reaching: docs\/adr\/ never opened/)
})

test('located ground the courier could not carry reaches the analysts as locations to read', async () => {
  const failed = { stop_reason: 'failed', payload_raw: '', task_ids: [], task_tools: 'skipped', notes: 'no node' }
  const { result, prompts } = await runWorkflow(WF, {
    args: DEFAULT_ARGS,
    agent: probeAgents({
      'guidance-context': failed, 'guidance-context#2': failed, 'ground-context': failed, 'ground-context#2': failed,
    }),
  })

  assert.match(prompts.find((p) => p.opts.label === 'axes').prompt,
    /LOCATIONS NOT EXCERPTED[\s\S]*CLAUDE\.md:40 — reviewers check counters/)
  assert.match(prompts.find((p) => /^probe:/.test(p.opts.label)).prompt,
    /LOCATIONS NOT EXCERPTED[\s\S]*lib\/loader\.mjs:12/)
  assert.equal(result.coverage.complete, true, 'more turns for the readers, not less evidence')
  assert.match(result.coverage.unreached.join(' '), /read those locations themselves/)
})

// ------------------------------------------------------------------ findings as evidence items
//
// The artefact is snapshotted before anything reads it, and every finding is recorded as an item
// anchored to lines of that snapshot. A later probe given `since` attacks only the lines that
// changed, and carries forward every earlier finding whose lines no edit touched: the narrowing
// is the same anchor check as everywhere else, not a mechanism of its own.

const promptOf = (prompts, label) => (prompts.find((p) => p.opts.label === label) || {}).prompt || ''
const withLines = (over = {}) => finding({ start: 12, end: 14, ...over })
const failedCourier = { stop_reason: 'failed', payload_raw: '', notes: 'node is not on the PATH' }

const CARRIED_ITEM = (over = {}) => ({
  id: 'Iaaaaaaaa', question: 'docs/proposal.md', topic: 'challenge:yagni', ground: ['docs/proposal.md'],
  kind: 'behaviour', claim: 'an older note',
  spans: [{ path: 'docs/proposal.md', start: 5, end: 7, at: 'snapshot:11111111' }],
  queries: [], sources: [], rests_on: [], from_return: '20260925-100000-probe', seq: 3,
  detail: { axis: 'yagni', severity: 'note', section: '§2', evidence: 'the document says so' },
  state: 'standing', changed: [], why: 'every anchor is unchanged', ...over,
})
const narrowed = (over = {}) => scopeOf({
  since: 'snapshot:11111111', full: false, changed: [{ start: 31, end: 33 }], carried: [CARRIED_ITEM()], ...over,
})

test('the artefact is snapshotted before anything reads it, and the result names the snapshot', async () => {
  const { result, prompts } = await runWorkflow(WF, { args: ARGS, agent: probeAgents() })

  const [scope] = prompts
  assert.equal(scope.opts.label, 'scope')
  assert.equal(scope.opts.agentType, 'agentics:courier')
  assert.match(scope.prompt, /lib\/evidence\.mjs" review-scope --repo "C:\/repo" --root "C:\/repo" --file "docs\/proposal\.md"\n/)
  assert.equal(result.snapshot, SNAP)
  assert.deepEqual(result.scope, { full: true, changed: [{ start: 1, end: 40 }] })
})

test('every new finding is recorded as a behaviour item anchored in the snapshot', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({
      'probe:yagni': found([withLines({ severity: 'gap', claim: 'the cache is unasked for', section: '§4', evidence: 'line 12 builds one' })]),
    }),
  })

  const rec = prompts.find((p) => p.opts.label === 'record')
  assert.equal(rec.opts.agentType, 'agentics:courier')
  assert.match(rec.prompt, /lib\/evidence\.mjs" record --repo "C:\/repo" --root "C:\/repo" --kind probe --digest [0-9a-f]{8} --json-file "[^"]+\.json"/)
  const { entry, digest } = recordedLine(rec.prompt)
  assert.equal(digest, fnv1a(canonical(entry)))

  const [item] = entry.items
  assert.equal(entry.items.length, 1)
  assert.equal(item.kind, 'behaviour')
  assert.equal(item.question, 'docs/proposal.md')
  assert.equal(item.topic, 'challenge:yagni')
  assert.deepEqual(item.ground, ['docs/proposal.md'])
  assert.equal(item.claim, 'the cache is unasked for')
  assert.deepEqual(item.spans, [{ path: 'docs/proposal.md', start: 12, end: 14, at: SNAP }])
  assert.deepEqual([item.detail.axis, item.detail.severity, item.detail.section, item.detail.evidence],
    ['yagni', 'gap', '§4', 'line 12 builds one'])

  assert.equal(result.findings[0].item, itemId(item))
  assert.equal(result.findings[0].carried, false)
  assert.deepEqual(result.unrecorded, [])
})

test('the findings schema asks every finding for integer artefact lines', async () => {
  const { prompts } = await runWorkflow(WF, { args: ARGS, agent: probeAgents() })
  const probe = prompts.find((p) => /^probe:/.test(p.opts.label))
  const f = probe.opts.schema.properties.findings.items
  assert.ok(f.required.includes('start') && f.required.includes('end'))
  assert.equal(f.properties.start.type, 'integer')
  assert.equal(f.properties.end.type, 'integer')
})

test('a finding with no usable line range is anchored to the whole artefact', async () => {
  const { prompts } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({
      'probe:yagni': found([
        finding({ claim: 'no range at all' }),
        withLines({ claim: 'past the end', start: 38, end: 41 }),
        withLines({ claim: 'backwards', start: 9, end: 3 }),
      ]),
    }),
  })
  const spans = recordedLine(promptOf(prompts, 'record')).entry.items.map((i) => i.spans[0])
  assert.deepEqual(spans.map((s) => [s.start, s.end]), [[1, 40], [1, 40], [1, 40]],
    'the safe direction: a finding anchored everywhere is re-reviewed on any edit')
})

test('since narrows the attack to the changed lines and carries forward what no edit touched', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: { ...ARGS, since: 'snapshot:11111111' },
    agent: probeAgents({
      scope: narrowed(),
      'probe:yagni': found([withLines({ start: 31, end: 32, claim: 'a new gap', severity: 'gap' })]),
    }),
  })

  assert.match(promptOf(prompts, 'scope'), /--since "snapshot:11111111"/)
  for (const p of prompts.filter((x) => /^probe:/.test(x.opts.label))) {
    assert.match(p.prompt, /ATTACK ONLY THESE LINES[\s\S]*31-33/, p.opts.label)
    assert.match(p.prompt, /an older note/, p.opts.label + ' is told what is settled, so it does not find it again')
  }

  const carried = result.findings.find((f) => f.carried)
  assert.deepEqual([carried.item, carried.axis, carried.severity, carried.claim, carried.section],
    ['Iaaaaaaaa', 'yagni', 'note', 'an older note', '§2'])
  assert.deepEqual(result.findings.map((f) => f.id), result.findings.map((_, i) => 'P' + (i + 1)))
  assert.equal(result.findings[0].carried, true, 'carried findings come first')

  assert.deepEqual(recordedLine(promptOf(prompts, 'record')).entry.items.map((i) => i.claim), ['a new gap'],
    'a carried finding is already in the pool')
  assert.deepEqual(result.scope, { full: false, changed: [{ start: 31, end: 33 }] })
})

test('a since that is not a snapshot id never reaches the scope command and buys a full probe', async () => {
  for (const since of ['HEAD~1', 'snapshot:1234', 'snapshot:22222222"; rm -rf ~; echo "']) {
    const { prompts, logs } = await runWorkflow(WF, { args: { ...ARGS, since }, agent: probeAgents() })
    const scope = promptOf(prompts, 'scope')
    assert.doesNotMatch(scope, /--since/, since)
    assert.doesNotMatch(scope, /rm -rf/, since)
    assert.ok(logs.some((l) => /not a snapshot id/.test(l)), since)
    assert.ok(prompts.filter((p) => /^probe:/.test(p.opts.label)).every((p) => !/ATTACK ONLY THESE LINES/.test(p.prompt)), since)
  }
})

test('a carried ambiguity is still an open ambiguity, and closes the gate', async () => {
  const { result } = await runWorkflow(WF, {
    args: { ...ARGS, since: 'snapshot:11111111' },
    agent: probeAgents({
      scope: narrowed({ carried: [CARRIED_ITEM({ detail: { axis: 'ambiguity', severity: 'ambiguity', section: '§1', evidence: 'x' } })] }),
    }),
  })
  assert.equal(result.ambiguities.length, 1)
  assert.equal(result.ambiguities[0].carried, true)
  assert.equal(result.ratifiable, false)
})

test('an artefact unchanged since the last review buys no analyst', async () => {
  const { result, prompts, logs } = await runWorkflow(WF, {
    args: { ...ARGS, since: 'snapshot:11111111' },
    agent: probeAgents({ scope: narrowed({ changed: [] }) }),
  })
  assert.deepEqual(prompts.map((p) => p.opts.label), ['scope', 'record'], 'no analyst; the clean round is recorded')
  assert.deepEqual(recordedLine(promptOf(prompts, 'record')).entry, { items: [] }, 'a carried finding is already in the pool')
  assert.equal(result.review, '20260926-120000-probe')
  assert.deepEqual(result.findings.map((f) => f.item), ['Iaaaaaaaa'])
  assert.equal(result.coverage.complete, true)
  assert.equal(result.ratifiable, true)
  assert.ok(logs.some((l) => /unchanged since/.test(l)))
})

test('a scope that cannot be read costs a full probe, never a narrowed one, and records nothing', async () => {
  const { result, prompts } = await runWorkflow(WF, {
    args: { ...ARGS, since: 'snapshot:11111111' },
    agent: probeAgents({ scope: failedCourier, 'scope#2': failedCourier, 'probe:yagni': found([withLines()]) }),
  })
  const probes = prompts.filter((p) => /^probe:/.test(p.opts.label))
  assert.equal(probes.length, STANDING.length, 'every axis is attacked in full')
  assert.ok(probes.every((p) => !/ATTACK ONLY THESE LINES/.test(p.prompt)))
  assert.ok(!prompts.some((p) => /^record/.test(p.opts.label)), 'without a snapshot there is nothing to anchor a finding to')
  assert.equal(result.snapshot, '')
  assert.equal(result.coverage.complete, true, 'a lost snapshot costs a full probe, not coverage')
})

test('a record that fails is logged, costs no coverage, and names no snapshot', async () => {
  const { result, logs } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({ record: failedCourier, 'record#2': failedCourier, 'probe:yagni': found([withLines()]) }),
  })
  assert.equal(result.coverage.complete, true)
  assert.equal(result.ratifiable, true)
  assert.deepEqual(result.unrecorded, result.findings.map((f) => f.item))
  assert.equal(result.snapshot, '', 'a next round given this snapshot would never re-attack the unrecorded lines')
  assert.equal(result.review, '')
  assert.ok(logs.some((l) => /not recorded/.test(l)))
})

test('a refused record leaves its findings unrecorded and names no snapshot, so the next round probes in full', async () => {
  const refuse = (prompt) => carriedEnvelope({
    ok: false, refused: recordedLine(prompt).entry.items.map((_, index) => ({ index, problems: ['span 0: at must be a commit sha or snapshot:<hash>'] })),
  })
  const { result, prompts, logs } = await runWorkflow(WF, {
    args: ARGS,
    agent: probeAgents({ record: refuse, 'probe:yagni': found([withLines(), withLines({ claim: 'a second gap' })]) }),
  })
  assert.equal(prompts.filter((p) => /^record/.test(p.opts.label)).length, 1, 'a finding stands whether or not the pool took it: no re-ask')
  assert.deepEqual([...result.unrecorded].sort(), result.findings.map((f) => f.item).sort())
  assert.equal(result.snapshot, '')
  assert.equal(result.coverage.complete, true)
  assert.ok(logs.some((l) => /not recorded/.test(l)))
})

test('findings too many for one line are recorded by one courier, written in chunks that each fit one', async () => {
  const many = Array.from({ length: 12 }, (_, i) => withLines({ claim: 'gap ' + i + ' ' + 'x'.repeat(600) }))
  const { result, prompts } = await runWorkflow(WF, { args: ARGS, agent: probeAgents({ 'probe:yagni': found(many) }) })
  const recs = prompts.filter((p) => /^record/.test(p.opts.label))
  assert.deepEqual(recs.map((p) => p.opts.label), ['record'])
  const chunks = jsonChunks(recs[0].prompt)
  assert.ok(chunks.length > 1, 'twelve long findings do not fit one line')
  for (const chunk of chunks) assert.ok(chunk.length <= 6000)
  assert.deepEqual(recordedLine(recs[0].prompt).entry.items.map((i) => i.claim).sort(), many.map((f) => f.claim).sort())
  assert.deepEqual(result.unrecorded, [])
})

test('a courier copying the chunked writes as the harness shows them, every line indented, writes the token intact', async () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    withLines({ claim: `gap ${i}: it's C:\\src\\x ~b~q $HOME \`id\` "quoted" ` + 'x'.repeat(600) }))
  const { prompts } = await runWorkflow(WF, { args: ARGS, agent: probeAgents({ 'probe:yagni': found(many) }) })
  const prompt = prompts.find((p) => p.opts.label === 'record').prompt
  const { digest } = recordedLine(prompt)

  const dir = mkdtempSync(join(tmpdir(), 'agentics-token-')).replace(/\\/g, '/')
  const shown = prompt.split('\n').map((line) => '  ' + line.replaceAll('C:/repo', dir))
  const writes = shown.filter((line) => /^\s*(mkdir -p |printf )/.test(line))
  assert.ok(writes.length > 1, 'twelve long findings take several writes')
  for (const write of writes) {
    const ran = spawnSync('bash', ['-c', write], { encoding: 'utf8' })
    assert.equal(ran.status, 0, ran.stderr)
  }

  const file = /--json-file "([^"]+)"/.exec(shown.join('\n'))[1]
  const { value, problem } = decodeArgs(['--json-file', file, '--digest', digest])
  assert.equal(problem, null, JSON.stringify(problem))
  assert.deepEqual(value.items.map((i) => i.claim).sort(), many.map((f) => f.claim).sort())
})

test('the result names the return the round\'s findings were recorded in', async () => {
  const named = (prompt, opts) => carriedEnvelope({
    ok: true, return: '20260926-120000-' + opts.label.replace(':', '-') + '-probe', ids: recordedLine(prompt).entry.items.map(itemId),
  })
  const one = await runWorkflow(WF, { args: ARGS, agent: probeAgents({ record: named, 'probe:yagni': found([withLines()]) }) })
  assert.equal(one.result.review, '20260926-120000-record-probe')
})

test('a round with no findings records an empty return and names it', async () => {
  const { result, prompts } = await runWorkflow(WF, { args: ARGS, agent: probeAgents() })
  const recs = prompts.filter((p) => /^record/.test(p.opts.label))
  assert.deepEqual(recs.map((p) => p.opts.label), ['record'])
  assert.equal(recs[0].opts.agentType, 'agentics:courier')
  assert.match(recs[0].prompt, /lib\/evidence\.mjs" record --repo "C:\/repo" --root "C:\/repo" --kind probe --digest [0-9a-f]{8} --json-file "[^"]+\.json"/)
  const { entry, digest } = recordedLine(recs[0].prompt)
  assert.deepEqual(entry, { items: [] })
  assert.equal(digest, fnv1a(canonical(entry)))
  assert.equal(result.review, '20260926-120000-probe', 'a clean review is a review return like any other')
  assert.equal(result.snapshot, SNAP)
  assert.deepEqual(result.unrecorded, [])
  assert.equal(result.ratifiable, true)
})

test('a probe run from a linked worktree records its findings with the worktree as root', async () => {
  const { prompts } = await runWorkflow(WF, {
    args: { ...ARGS, roots: 'C:/wt/e1-a' },
    agent: probeAgents({ 'probe:yagni': found([withLines()]) }),
  })
  assert.match(promptOf(prompts, 'scope'), /review-scope --repo "C:\/wt\/e1-a" --root "C:\/wt\/e1-a" --file /,
    'the artefact and the carried findings are read where the analysts read')
  assert.match(promptOf(prompts, 'record'), /record --repo "C:\/wt\/e1-a" --root "C:\/wt\/e1-a" --kind probe /)
})

test('with no artefact the result names no snapshot, a full scope and nothing unrecorded', async () => {
  const { result, prompts } = await runWorkflow(WF, { args: { roots: 'C:/repo' }, agent: probeAgents() })
  assert.deepEqual(prompts, [])
  assert.equal(result.snapshot, '')
  assert.deepEqual(result.scope, { full: true, changed: [] })
  assert.deepEqual(result.unrecorded, [])
  assert.equal(result.review, '')
})

test('a narrowed re-review is sized by the lines it attacks, not by the whole artefact', async () => {
  const { result } = await runWorkflow(WF, {
    args: { artifact: 'docs/proposal.md', roots: 'C:/repo', since: 'snapshot:11111111' },
    agent: probeAgents({ ground: groundPayload({ artifact_lines: 900 }), scope: narrowed({ lines: 900 }) }),
  })
  assert.equal(result.analysts.length, 1, 'three changed lines are one reader\'s work')
})
