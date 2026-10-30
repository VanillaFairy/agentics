// A claim that rests on a linked Design stands only when its citation resolves and the reviewer opened
// that spec; the brief hands the core and links the rest.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { heldToDesign } from '../../lib/boundaries/integration.mjs'
import { integrationBrief } from '../../lib/briefs/execute.mjs'
import { rulerBrief } from '../../lib/briefs/respec.mjs'
import { parseStream } from '../../lib/runner.mjs'
import { specSections } from '../../lib/spec.mjs'

const SPEC = ['# C', '', '## Intent', '', 'Why c.', '', '## Decisions', '', '## Design', '', '### Shape', '', 'DESIGN_BODY', '',
  '## Plan', '', 'PLAN_BODY', '', '## Open questions', '', '## Evidence', '', 'EVIDENCE_BODY', ''].join('\n')
const child = { id: 'c', path: 'C:/repo/.agentics/e/c/DESIGN.md', text: SPEC }
const claim = (design_read, ruling = 'met') => ({ claim: 'c has a shape', ruling, evidence: 'a.js:1', failure_scenario: ruling === 'under' ? 'x' : '', unit: '', design_read })
const held = (c, opened) => heldToDesign([c], [child], opened)[0]

test('a claim citing a Design part the reviewer opened keeps its ruling, however the path was typed', () => {
  assert.equal(held(claim('c#Shape'), ['C:\\repo\\.agentics\\e\\c\\DESIGN.md']).ruling, 'met')
  assert.equal(held(claim('c#Design'), [child.path]).ruling, 'met')
})

test('a claim citing a Design the reviewer never opened is cant_tell, a drift included', () => {
  assert.equal(held(claim('c#Shape'), []).ruling, 'cant_tell')
  const drift = held(claim('c#Shape', 'under'), [])
  assert.deepEqual([drift.ruling, drift.failure_scenario], ['cant_tell', ''], 'a drift ruled on an unread Design parks nothing')
})

test('a citation that does not resolve is cant_tell though the spec was opened', () => {
  for (const cite of ['c#No such part', 'other#Shape', 'Shape']) assert.equal(held(claim(cite), [child.path]).ruling, 'cant_tell', cite)
})

test('a claim that cites no Design keeps its ruling', () => {
  assert.equal(held(claim(''), []).ruling, 'met')
  assert.equal(held({ claim: 'old', ruling: 'met' }, []).ruling, 'met')
})

test('the brief holds a sub-effort\'s core and its absolute path, the folder\'s spec without its Evidence, and asks for the citation', () => {
  const text = integrationBrief({
    folder: { id: 'p' }, spec: specSections(SPEC.replace('EVIDENCE_BODY', 'OWN_EVIDENCE'), ['Intent', 'Design']), evidence: 'C:/repo/.agentics/e/DESIGN.md',
    delta: { rule: [{ unit: 'spec', anchor: 's', was: null }], stand: [] }, span: { base: 'b', head: 'h' },
    children: [{ ...child, text: specSections(SPEC, ['Intent', 'Decisions', 'Plan']) }],
  })
  for (const present of ['PLAN_BODY', child.path, 'C:/repo/.agentics/e/DESIGN.md', '`design_read`']) assert.ok(text.includes(present), present)
  const fence = text.split('## The specs of its sub-efforts')[1].split('## The spec, your yardstick')[0]
  for (const absent of ['DESIGN_BODY', 'EVIDENCE_BODY']) assert.ok(!fence.includes(absent), absent)
  assert.ok(!text.includes('OWN_EVIDENCE'), "the folder's Evidence is behind its path")
})

test('a ruler holds the changed spec without its Evidence and each other spec\'s core, each with its absolute path', () => {
  const text = rulerBrief({
    effort: 'e', folder: '.', file: 'f', from: 'a', hash: 'b', diff: 'd', own: '.agentics/e/DESIGN.md',
    specs: [{ path: '.agentics/e/c/DESIGN.md', full: child.path, whole: SPEC, text: specSections(SPEC, ['Intent', 'Decisions', 'Plan']) }],
  })
  const specs = text.split('## The specs')[1]
  for (const present of ['PLAN_BODY', child.path, '`design_read`']) assert.ok(specs.includes(present), present)
  for (const absent of ['DESIGN_BODY', 'EVIDENCE_BODY']) assert.ok(!specs.includes(absent), absent)
})

test('a Read inside a store is journaled for the check, and one outside it is not', () => {
  const read = (file_path) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path } }] } })
  assert.deepEqual(parseStream([read('C:\\r\\.agentics\\e\\DESIGN.md'), read('src/a.js')].join('\n')).storeReads, [{ file_path: 'C:\\r\\.agentics\\e\\DESIGN.md' }])
})
