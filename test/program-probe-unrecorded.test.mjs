// test/program-probe-unrecorded.test.mjs — a probe round whose findings the evidence store refused is
// not ratifiable, and read back through `approval.mjs reviewed --from-run` it is recorded incomplete
// at the spec's hash, naming each unrecorded finding; a recorded round reads back with the sections
// it ruled clean and each ambiguity's section.
//
// Design: docs/DESIGN.md#probe, docs/DESIGN.md#design.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { reviewedFromResult } from '../lib/approval.mjs'
import { STANDING_AXES } from '../lib/briefs/probe.mjs'
import { sectionsOf, unitsOf } from '../lib/evidence.mjs'
import { readLog } from '../lib/ledger.mjs'
import { probe } from '../lib/programs/probe.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { closedSearch } from './fast/harness/scout.mjs'
import { programRig } from './harness/program-rig.mjs'

const E = 'e1'
const SPEC = '.agentics/e1/DESIGN.md'
const DOC = [
  '# Limiter', '',
  '## Intent', 'limit inbound requests per key', 'callers see a retry hint', '',
  '## Design', 'a token bucket per key, refilled each second', '',
  '## Growth', 'keys are bounded',
].join('\n') + '\n'
const KEYS = STANDING_AXES.map((a) => a.key)

/** A finding as a prober writes it; an empty `claim` is one the evidence store refuses. */
const finding = (axisKey, severity, section, start, over = {}) => ({
  axis: axisKey, severity, section, claim: severity + ' on ' + axisKey + ' in ' + section, evidence: 'line ' + start, start, end: start, ...over,
})
/** The one prober's return: every unit ruled, `findings` for the unit a finding sits on, clean for the rest. */
const proberOut = (units, findings) => ({
  findings,
  units: units.map((unit) => ({
    unit, ruling: findings.some((f) => f.axis + '@' + f.section === unit) ? 'findings' : 'clean', ids: [], why: 'why ' + unit,
  })),
  notes: '', stop_reason: 'exhausted', not_reached: '',
})

/** The locate script: one scout session that finds nothing. */
const locateScript = () => closedSearch({ name: 'locate' })

/** The real probe over a rig holding the spec, one prober holding every standing axis. */
async function probeRound(t, findings) {
  const units = unitsOf(KEYS, sectionsOf(DOC))
  const rig = programRig({
    files: { [SPEC]: DOC },
    script: { ...locateScript(), 'analyst||prober:1': [{ output: proberOut(units, findings) }] },
  })
  t.after(() => rig.cleanup())
  const artifact = join(rig.repo, ...SPEC.split('/'))
  const result = await probe(rig.ctx, {
    artifact, artifact_text: readFileSync(artifact, 'utf8').replace(/\r\n/g, '\n').trim(), roots: ['.'], context: '', per_axis: false, since: '',
  })
  assert.equal(rig.calls.filter((c) => c.thread.key.startsWith('prober:')).length, 1, 'one prober held every axis')
  return { rig, result }
}

/** Record the run's result as `approval.mjs reviewed --from-run` does once it has read it, in-process; the line it wrote. */
function readBack(rig, result) {
  const out = reviewedFromResult(rig.repo, E, '.', result)
  assert.equal(out.ok, true, JSON.stringify(out))
  const lines = readLog(rig.repo, E, 'ledger').entries.filter((l) => l.kind === 'reviewed')
  assert.equal(lines.length, 1, JSON.stringify(out))
  return lines[0]
}

const refused = (axisKey, section, start) => finding(axisKey, 'note', section, start, { claim: '' })

test('a probe round with unrecorded findings is not ratifiable', { timeout: 120_000 }, async (t) => {
  const { result } = await probeRound(t, [refused('yagni', 'intent', 3)])
  assert.deepEqual(result.unrecorded, ['P1'], 'the store refused the finding')
  assert.equal(result.coverage.complete, true, 'every prober returned and every unit is ruled')
  assert.deepEqual(result.ambiguities, [])
  assert.equal(result.ratifiable, false)
})

test('a complete probe round whose findings were all recorded, with no ambiguity, is ratifiable', { timeout: 120_000 }, async (t) => {
  const { result } = await probeRound(t, [finding('yagni', 'note', 'intent', 3)])
  assert.deepEqual(result.unrecorded, [])
  assert.equal(result.coverage.complete, true)
  assert.deepEqual(result.ambiguities, [])
  assert.equal(result.ratifiable, true)
})

test('reviewed --from-run records a probe round with unrecorded findings as incomplete, naming each', { timeout: 120_000 }, async (t) => {
  const { rig, result } = await probeRound(t, [refused('yagni', 'intent', 3), refused('invariants', 'design', 7)])
  assert.deepEqual(result.unrecorded, result.findings.map((f) => f.id))
  assert.equal(result.unrecorded.length, 2)
  const line = readBack(rig, result)
  assert.equal(line.hash, hashSpec(DOC))
  assert.equal(line.complete, false)
  assert.deepEqual(line.remaining, result.unrecorded.map((id) => 'unrecorded:' + id))
})

test('reviewed --from-run records the sections a probe round ruled clean, and each ambiguity\'s section', { timeout: 120_000 }, async (t) => {
  const { rig, result } = await probeRound(t, [finding('ambiguity', 'ambiguity', 'design', 7)])
  const [ambiguity] = result.findings.filter((f) => f.severity === 'ambiguity')
  assert.ok(ambiguity && ambiguity.item, 'the ambiguity was recorded')
  const line = readBack(rig, result)
  assert.deepEqual(line.ambiguities, [ambiguity.item])
  assert.deepEqual(line.sections, { [ambiguity.item]: 'design' })
  const others = sectionsOf(DOC).map((s) => s.slug).filter((s) => s !== 'design')
  assert.ok(others.length > 0)
  assert.deepEqual([...line.clean].sort(), others.sort(), 'every section but the one the ambiguity is in')
})
