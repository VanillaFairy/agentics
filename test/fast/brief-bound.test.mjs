// test/fast/brief-bound.test.mjs — pins the bound on a call's first read: a fresh call whose system
// prompt and brief hold more than a first read may is refused before anything starts; a brief is
// sized part by part and refused, naming the part, never cut or handed as a file; a narrowed probe
// round's kept ground holds each place once; and the spend view flags a unit whose call read past the
// bound.
//
// Design: docs/DESIGN.md#the-agent-runner, docs/DESIGN.md#probe, docs/DESIGN.md#spend-view.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { joined, oversizedPart, sectionsOf } from '../../lib/briefs/size.mjs'
import { proberBrief } from '../../lib/briefs/probe.mjs'
import { hitBlocks } from '../../lib/citations.mjs'
import { briefRoomOf } from '../../lib/programs/common.mjs'
import { joinedGround } from '../../lib/programs/probe.mjs'
import { BRIEF_BYTES, BRIEF_TOKENS, PART_BYTES } from '../../lib/roles.mjs'
import { callsOf } from '../../lib/run.mjs'
import { oversize, runAgent } from '../../lib/runner.mjs'
import { flagSpend, spendUnits } from '../../lib/status.mjs'
import { memoryLog } from './harness/memory-log.mjs'

const SCHEMA = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] }

function fresh(brief) {
  const log = memoryLog()
  const spawns = []
  const ports = {
    spawnCli: async (args) => { spawns.push(args); return { code: 9, stdout: '', stderr: 'unscripted' } },
    log, fsx: { writeJson() {}, remove() {} }, proc: { alive: () => false, kill() {} }, watch: null, now: () => '2026-10-23T00:00:00.000Z', env: {},
  }
  const call = {
    dispatch: 'd1', node: '', round: 1, thread: { key: 'probe:a:1/prober:1', session: 's1', gen: 0 },
    role: { name: 'analyst', tools: ['Read'], systemPromptFile: join(tmpdir(), 'agentics-no-such-prompt.md') },
    cwd: tmpdir(), brief, tier: { model: 'opus', effort: 'medium' }, permissions: { allowed: [], disallowed: [] },
    schema: SCHEMA, carries: [], dir: tmpdir(), resume: false,
  }
  return { log, spawns, run: () => runAgent(call, ports) }
}

test('a fresh call whose first read holds more than a call may read is refused, nothing started or recorded', async () => {
  const r = fresh('x'.repeat(BRIEF_BYTES + 1))
  const out = await r.run()
  assert.equal(out.status, 'failed')
  assert.equal(out.cause, 'brief_too_large')
  assert.deepEqual(r.spawns, [], 'never sent')
  assert.deepEqual(r.log.entries(), [], 'no call is recorded')
})

test('a first read counts the system prompt with the brief', () => {
  assert.equal(oversize({ systemBytes: 0, brief: 'x'.repeat(BRIEF_BYTES) }), '')
  assert.notEqual(oversize({ systemBytes: 1, brief: 'x'.repeat(BRIEF_BYTES) }), '')
  assert.ok(briefRoomOf('analyst') < BRIEF_BYTES, "a brief's room is what is left after the role's system prompt")
})

const EXCERPT = 'EXCERPT_LINE_TOKEN '.repeat(400)
const hit = (n) => '- src/f' + n + '.ts:' + n + ' — what f' + n + ' does [ground]\n' + '    ' + n + '\t' + EXCERPT
const groundOf = (hits, summary = 'the scout found the ground') => {
  const text = ['=== locate — done\n' + summary, ...hits].join('\n\n')
  return { text, blocks: hitBlocks(text), counts: { hits: hits.length, unresolved: 0 }, complete: true }
}
const SECTIONS = [{ slug: 'intent', title: 'Intent', start: 1, end: 2 }]
const at = (ground) => ({
  artifact: 'DESIGN.md', text: '# T\n\n## Intent\nx\n', axes: [{ key: 'contract', charge: 'attack it' }],
  units: ['contract@intent'], sections: SECTIONS, cited: { read_error: '', files: [], unresolved: [] }, ground,
  settled: [{ file: '.agentics/e/DESIGN.md', intent: 'SETTLED_INTENT_TOKEN '.repeat(200), decisions: '', design: '' }],
})
const bytes = (text) => Buffer.byteLength(text)
const bigSpec = (lines) => Array.from({ length: lines }, (_, i) => 'line ' + (i + 1) + ' ' + 'x'.repeat(120)).join('\n') + '\n'

test("a prober's brief within its budgets is sent whole: the ground's excerpts and the settled specs are in it", () => {
  const ground = groundOf(Array.from({ length: 10 }, (_, i) => hit(i + 1)))
  const { parts } = proberBrief(at(ground))
  assert.equal(oversizedPart(parts, BRIEF_BYTES), null)
  const text = joined(parts)
  assert.ok(text.includes(ground.text), 'every excerpt the search located')
  assert.ok(text.includes('SETTLED_INTENT_TOKEN '.repeat(200)), 'the settled spec, whole')
})

test('a part past what one part may hold is refused by name, even where the whole brief would fit', () => {
  const lines = Math.ceil(PART_BYTES / bytes(bigSpec(1))) + 1
  const { parts } = proberBrief({ ...at(groundOf([hit(1)])), text: bigSpec(lines) })
  const refused = oversizedPart(parts, Infinity)
  assert.equal(refused.part, 'artefact')
  assert.equal(refused.bytes, bytes(parts.find((p) => p.key === 'artefact').text))
  assert.equal(refused.budget, PART_BYTES)
  assert.ok(refused.message.includes('"artefact"'), refused.message)
})

test('a brief past its room, each part within its budget, is refused naming its largest part and what that part may hold beside the rest', () => {
  const brief = (n) => [{ key: 'charge', text: 'Rule this.' }, { key: 'small', text: 's'.repeat(100) }, { key: 'big', text: 'b'.repeat(n) }]
  const room = 5000
  const refused = oversizedPart(brief(6000), room)
  assert.equal(refused.part, 'big')
  assert.equal(refused.bytes, 6000)
  assert.equal(oversizedPart(brief(refused.budget), room), null, 'the largest part at its budget fits')
  assert.notEqual(oversizedPart(brief(refused.budget + 1), room), null, 'and one byte more does not')
})

test("a narrowed round's ground holds each place once, a place located again with its newer lines", () => {
  const kept = groundOf([hit(1), hit(2)])
  const again = '- src/f2.ts:2 — what f2 does [ground]\n     2\tNEWER_LINE_TOKEN'
  const added = groundOf([again, hit(3)], 'the scout found more')
  let joined = joinedGround(kept, added)
  joined = joinedGround(joined, groundOf([hit(1)]))
  const heads = hitBlocks(joined.text).filter((b) => b.kind === 'hit').map((b) => b.head)
  assert.deepEqual([...heads].sort(), [...new Set(heads)].sort(), 'no place twice')
  assert.equal(heads.length, 3)
  assert.equal(joined.counts.hits, 3)
  assert.ok(joined.text.includes('NEWER_LINE_TOKEN'))
  assert.equal(joined.text.split('=== locate — done\nthe scout found the ground').length - 1, 1, 'a search block repeated word for word is kept once')
})

test('the spend view flags a unit whose call opened its session reading past the bound', () => {
  const sent = (dispatch, session, thread) => ({ kind: 'dispatched', dispatch, session, thread, node: '', role: 'analyst', model: 'opus', round: 1 })
  const back = (dispatch, opened) => ({ kind: 'returned', dispatch, status: 'returned', usage: null, cost_usd: 1, opened })
  const entries = [
    sent('big', 's1', 'probe:a:1/prober:1'), back('big', BRIEF_TOKENS + 1),
    sent('again', 's1', 'probe:a:1/prober:1'), back('again', BRIEF_TOKENS * 1.5),
    sent('small', 's2', 'probe:a:2/prober:1'), back('small', BRIEF_TOKENS),
  ].map((e, i) => ({ ...e, seq: i + 1 }))
  const calls = callsOf(entries, true)
  assert.deepEqual(calls.map((c) => c.first_read), [BRIEF_TOKENS + 1, null, BRIEF_TOKENS], 'a resumed call read its session, not its brief')
  const nodes = new Map([['a', { id: 'a', kind: 'composite' }]])
  const units = spendUnits(calls, nodes, new Map([['a', { status: 'active' }]]))
  const flagged = flagSpend({ leaf: [], folder: units.folder, probe: units.probe.map((p) => ({ ...p, spec_lines: 0 })) }).flagged
  const reasons = Object.fromEntries(flagged.map((f) => [f.kind + ' ' + f.id, f.reasons]))
  assert.deepEqual(reasons['probe a:1'], ['brief_over_bound'])
  assert.equal(reasons['probe a:2'], undefined)
  assert.ok(reasons['folder a'].includes('brief_over_bound'))
})

test("a plain brief's parts are its sections keyed by their headings, a fenced heading the fenced text's, and they join back to the brief", () => {
  const spec = '~~~~markdown\n## Not a section of the brief\n' + 'S'.repeat(50) + '\n~~~~'
  const text = ['# Rule this', '', 'Return the rulings.', '', '## The change', '', 'small', '', '## The specs', '', '### a.md', '', spec].join('\n')
  const parts = sectionsOf(text)
  assert.deepEqual(parts.map((p) => p.key), ['charge', 'The change', 'The specs', 'a.md'])
  assert.equal(joined(parts), text)
  assert.deepEqual(sectionsOf('## Task\n\nDo it.').map((p) => p.key), ['Task'], 'a brief that opens on a heading has no charge before it')
})
