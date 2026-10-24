// test/fast/brief-bound.test.mjs — pins the bound on a call's first read: a fresh call whose system
// prompt and brief hold more than a first read may is refused before anything starts; a prober's
// brief gives up its excerpts, as places to open, to fit; a narrowed probe round's kept ground holds
// each place once; and the spend view flags a unit whose call read past the bound.
//
// Design: docs/DESIGN.md#the-agent-runner, docs/DESIGN.md#probe, docs/DESIGN.md#spend-view.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fitParts, joined, sectionsOf } from '../../lib/briefs/fit.mjs'
import { proberBrief } from '../../lib/briefs/probe.mjs'
import { hitBlocks } from '../../lib/citations.mjs'
import { briefRoomOf } from '../../lib/programs/common.mjs'
import { joinedGround } from '../../lib/programs/probe.mjs'
import { BRIEF_BYTES, BRIEF_TOKENS } from '../../lib/roles.mjs'
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
const at = (ground, room) => ({
  room, artifact: 'DESIGN.md', text: '# T\n\n## Intent\nx\n', axes: [{ key: 'contract', charge: 'attack it' }],
  units: ['contract@intent'], sections: SECTIONS, cited: { read_error: '', files: [], unresolved: [] }, ground,
  settled: [{ file: '.agentics/e/DESIGN.md', intent: 'SETTLED_INTENT_TOKEN '.repeat(200), decisions: '', design: '' }],
})

/** A prober's brief fitted to `room` by the shared fit, each file it hands kept in `files` by key. */
function fitted({ room, ...given }) {
  const files = {}
  const out = fitParts(proberBrief(given).parts, room, (key, body) => { files[key] = body; return '/run/briefs/' + key + '.md' })
  return { text: out.text, trimmed: out.handed.map((h) => h.key), files }
}

test("a prober's brief past its room hands the ground as places to open, every place still named", () => {
  const ground = groundOf(Array.from({ length: 40 }, (_, i) => hit(i + 1)))
  const whole = fitted(at(ground, Infinity))
  assert.deepEqual(whole.trimmed, [])
  const room = Buffer.byteLength(whole.text) - 1000
  const small = fitted(at(ground, room))
  assert.ok(Buffer.byteLength(small.text) <= room, 'it fits')
  assert.deepEqual(small.trimmed, ['ground'], 'giving up the least it must')
  assert.ok(!small.text.includes('EXCERPT_LINE_TOKEN'))
  for (const b of ground.blocks) assert.ok(small.text.includes(b.head), 'still names ' + b.head)
  assert.ok(small.text.includes('SETTLED_INTENT_TOKEN'), 'what fits is kept whole')
})

test("a prober's brief that cannot fit hands every part but its charge as a file", () => {
  const out = fitted(at(groundOf([hit(1)]), 10))
  assert.deepEqual(out.trimmed, ['ground', 'cited', 'settled', 'units', 'artefact'])
  assert.ok(!out.text.includes('SETTLED_INTENT_TOKEN'))
  assert.ok(out.text.includes('.agentics/e/DESIGN.md'), 'the settled spec is named to read')
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

const bigSpec = (lines) => Array.from({ length: lines }, (_, i) => 'line ' + (i + 1) + ' FAR_TEXT_TOKEN ' + 'x'.repeat(120)).join('\n') + '\n'
const carriedOf = (n) => Array.from({ length: n }, (_, i) => ({ id: 'P' + (i + 1), severity: 'gap', axis: 'contract', section: 'design', claim: 'CARRIED_TOKEN ' + 'y'.repeat(900) }))

test('a narrowed round over a large spec fits by handing its artefact and carried findings as files, its changed lines inline', () => {
  const text = bigSpec(806)
  const narrow = { changed: [{ start: 533, end: 533 }, { start: 697, end: 702 }], carried: carriedOf(106) }
  const at2 = {
    ...at(groundOf([hit(1)]), 60000), text, narrow, guidance: '## Repository guidance\n\n### CLAUDE.md\n\n' + 'g'.repeat(16000),
  }
  const out = fitted(at2)
  assert.ok(Buffer.byteLength(out.text) <= at2.room, 'it fits')
  assert.ok(out.trimmed.includes('artefact') && out.trimmed.includes('carried'), JSON.stringify(out.trimmed))
  assert.ok(out.text.includes('/run/briefs/artefact.md') && out.text.includes('/run/briefs/carried.md'))
  assert.equal(out.files.artefact, text, "the artefact's file is its text, so Read numbers its lines as findings cite them")
  assert.match(out.text, /^\s+533\tline 533 /m, 'a changed line, at its own number')
  assert.match(out.text, /^\s+513\tline 513 /m, 'with the lines around it')
  assert.ok(!/^\s+100\tline 100 /m.test(out.text), 'a far unchanged line goes by the file')
})

test('a full round whose artefact alone is past the room hands it as the file to read', () => {
  const out = fitted({ ...at(groundOf([hit(1)]), BRIEF_BYTES - 6000), text: bigSpec(2000) })
  assert.ok(Buffer.byteLength(out.text) <= BRIEF_BYTES - 6000)
  assert.ok(out.trimmed.includes('artefact'))
  assert.ok(!out.text.includes('FAR_TEXT_TOKEN'))
})

test("a plain brief's sections go as files, largest first, its charge and a fenced heading's text kept whole", () => {
  const spec = '~~~~markdown\n## Not a section of the brief\n' + 'S'.repeat(5000) + '\n~~~~'
  const text = ['# Rule this', '', 'Return the rulings.', '', '## The change', '', 'small', '', '## The specs', '', '### a.md', '', spec].join('\n')
  const parts = sectionsOf(text)
  assert.deepEqual(parts.map((p) => p.key), ['charge', 'The change', 'The specs', 'a.md'], 'a heading inside a fence is the fenced text\'s')
  assert.equal(joined(parts), text, 'the parts join back to the brief')
  const out = fitParts(parts, 1000, (key) => '/run/briefs/' + key + '.md')
  assert.deepEqual(out.handed.map((h) => h.key), ['a.md'])
  assert.ok(out.text.startsWith('# Rule this'))
  assert.ok(out.text.includes('### a.md') && out.text.includes('/run/briefs/a.md.md'))
})
