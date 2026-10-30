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

import { dispatchFailed } from '../../lib/boundaries/records.mjs'
import { fenced, joined, oversizedPart, ownerOf, sectionsOf } from '../../lib/briefs/size.mjs'
import { proberBrief } from '../../lib/briefs/probe.mjs'
import { hitBlocks } from '../../lib/citations.mjs'
import { briefRoomOf } from '../../lib/programs/common.mjs'
import { boundedBriefs, joinedGround } from '../../lib/programs/probe.mjs'
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

test('a refusal names the split as the remedy, and cutting the file only for repository guidance', () => {
  const big = 'x'.repeat(PART_BYTES + 1)
  const refusal = (section, file = '') => oversizedPart([{ key: file || section, section, file, text: big }], BRIEF_BYTES).message
  for (const spec of [refusal('The specs of its sub-efforts', 'a/DESIGN.md'), refusal('The spec, your yardstick'), refusal('Task')]) {
    assert.ok(spec.includes('the work is too big') && spec.includes('split it into subtasks') && spec.includes('separate efforts'), spec)
  }
  const guidance = refusal('Repository guidance', 'CLAUDE.md')
  assert.ok(guidance.includes('guidance file is too big') && guidance.includes('splits it or cuts it') && !guidance.includes('the work is too big'), guidance)
  assert.ok(!refusal('Evidence').includes('too big'), 'a part code owns is no one\'s to split')
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

test('a guidance file is one part whatever headings or fences it holds, the file the user owns', () => {
  const own = '## Task\n\nrules\n\n~~~~ a fence the file never closes\n\n### More\n\nstill the file'
  const text = ['## Task', '', 'Do it.', '', '## Repository guidance', '', '### CLAUDE.md', '', fenced(own)].join('\n')
  const parts = sectionsOf(text)
  assert.deepEqual(parts.map((p) => [p.key, ownerOf(p), p.file || '']), [['Task', 'work', ''], ['Repository guidance', 'user', ''], ['CLAUDE.md', 'user', 'CLAUDE.md']])
  assert.equal(joined(parts), text)
})

test("an embedded spec's own headings stay the part of the section that holds it", () => {
  const parts = sectionsOf('## Your charge\n\nWrite it.\n\n## The spec as it stands\n\n# Spec\n\n## Intent\n\nwhy\n\n## Plan\n\nwhat')
  assert.deepEqual(parts.map((p) => [p.key, ownerOf(p)]), [['Your charge', 'code'], ['The spec as it stands', 'work'], ['Intent', 'work'], ['Plan', 'work']])
})

test('a refusal names who can make its part smaller and the file it is', () => {
  const brief = (task, file) => sectionsOf(['## Task', '', task, '', '## Repository guidance', '', '### CLAUDE.md', '', fenced(file), '', '## The span', '', 'x'].join('\n'))
  const big = 'b'.repeat(PART_BYTES + 1)
  assert.deepEqual(['owner', 'file'].map((k) => oversizedPart(brief(big, 'r'), Infinity)[k]), ['work', ''])
  const user = oversizedPart(brief('t', big), Infinity)
  assert.deepEqual([user.owner, user.file, user.part], ['user', 'CLAUDE.md', 'CLAUDE.md'])
  assert.equal(oversizedPart(sectionsOf('## The span\n\n' + big), Infinity).owner, 'code')
})

test("a failed dispatch escalates for the user when its brief's part is not code's, and is otherwise a fault naming what failed", () => {
  const at = { nodes: new Map(), events: [], state: [] }
  const refused = (owner) => ({ status: 'failed', cause: 'brief_too_large', owner, message: 'the brief\'s part "CLAUDE.md" is 9 bytes and may hold 8' })
  const [user] = dispatchFailed('a/b', 'the planner dispatch d', refused('user'), at)
  assert.deepEqual([user.kind, user.fields.reason], ['escalated', 'brief_too_large'])
  assert.ok(user.fields.detail.includes(refused('user').message), user.fields.detail)
  assert.equal(dispatchFailed('a/b', 'the planner dispatch d', refused('work'), at)[0].kind, 'escalated')
  const [code] = dispatchFailed('a/b', 'the planner dispatch d', refused('code'), at)
  assert.deepEqual([code.kind, code.fields.channel], ['fault', 'role'])
  assert.ok(code.fields.detail.includes('brief_too_large') && code.fields.detail.includes(refused('code').message), code.fields.detail)
})

test("a prober's ground past its budget sheds its oldest places until the briefs fit, never the user's part", () => {
  const hits = Array.from({ length: Math.ceil(PART_BYTES / bytes(hit(1))) + 5 }, (_, i) => hit(i + 1))
  const build = (extra = {}) => (g, settled) => [proberBrief({ ...at(g), settled, ...extra })]
  const out = boundedBriefs(build(), { ground: groundOf(hits), settled: at(null).settled }, BRIEF_BYTES)
  assert.equal(oversizedPart(out.briefs[0].parts, BRIEF_BYTES), null, 'the briefs fit')
  const heads = hitBlocks(groundOf(hits).text).filter((b) => b.kind === 'hit').map((b) => b.head)
  assert.ok(out.shed.places.length > 0)
  assert.deepEqual(out.shed.places, heads.slice(0, out.shed.places.length), 'the oldest places go first')
  assert.ok(joined(out.briefs[0].parts).includes(heads.at(-1)), 'the latest place stays')
  assert.ok(joined(out.briefs[0].parts).includes('SETTLED_INTENT_TOKEN'), 'the settled spec stays while the ground can give way')
  assert.deepEqual(out.shed.specs, [])

  const artefact = bigSpec(Math.ceil(PART_BYTES / bytes(bigSpec(1))) + 1)
  const user = boundedBriefs(build({ text: artefact }), { ground: groundOf([hit(1)]), settled: [] }, BRIEF_BYTES)
  assert.deepEqual(user.shed.places, [], "nothing of code's is shed for a part of the user's")
  assert.equal(oversizedPart(user.briefs[0].parts, BRIEF_BYTES).part, 'artefact', 'the refusal stands for the dispatch')
})

test('a brief past its room with no ground left sheds the farthest settled spec first', () => {
  const spec = (n) => ({ file: 'spec-' + n + '.md', intent: ('SPEC_' + n + ' ').repeat(Math.floor(PART_BYTES / 28)), decisions: '', design: '' })
  const settled = [spec(1), spec(2), spec(3)]
  const room = bytes(joined(proberBrief({ ...at(null), settled: settled.slice(0, 2) }).parts))
  const out = boundedBriefs((g, s) => [proberBrief({ ...at(g), settled: s })], { ground: null, settled }, room)
  assert.deepEqual(out.shed.specs, ['spec-3.md'])
  assert.deepEqual(out.settled.map((s) => s.file), ['spec-1.md', 'spec-2.md'])
})
