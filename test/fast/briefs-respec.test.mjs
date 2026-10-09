// test/fast/briefs-respec.test.mjs — pins the ruler's brief as a pure function of what respecBrief
// read: every node to rule, every spec whole under its repo-relative path, no file to write, and the
// guidance last.
//
// Design: docs/DESIGN.md#a-changed-spec.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { rulerBrief } from '../../lib/briefs/respec.mjs'

const PARTS = {
  effort: 'e1', folder: 'api', file: '.agentics/e1/api/DESIGN.md', from: 'aaaaaaaa', hash: 'bbbbbbbb',
  diff: '-old line\n+new line', changedDecisions: ['D2'], written: ['api', 'cli'], retired: [],
  own: '.agentics/e1/api/DESIGN.md',
  work: [{ id: 'api/parse', status: 'active', change: 'is unchanged', entry: '.agentics/e1/api/DESIGN.md:12' }],
  clears: [{ node: 'api/types', status: 'parked', why: 'needs_decision', question: 'what type?' }],
  reached: [{ id: 'cli', why: ['realises D2, whose text changed'], entry: '.agentics/e1/DESIGN.md:30', own: '' }],
  standing: ['api/old'],
  specs: [{ path: '.agentics/e1/api/DESIGN.md', text: '# api' }, { path: '.agentics/e1/DESIGN.md', text: '# root' }],
}

test("the ruler's brief rules the changed spec and every node it reaches, and holds every spec whole", () => {
  const text = rulerBrief(PARTS)
  for (const line of [
    '# A changed spec: api of effort e1', '~~~~diff\n-old line\n+new line\n~~~~', 'Decisions whose text changed: D2.',
    '### api\n', '- api/parse — active — its entry is unchanged — .agentics/e1/api/DESIGN.md:12',
    '- api/types — parked (needs_decision): what type?', '### cli\n\nReached because it realises D2, whose text changed.',
    '- api/old: already waits on the user; its stop stands',
    '### .agentics/e1/api/DESIGN.md\n\n~~~~markdown\n# api\n~~~~', '### .agentics/e1/DESIGN.md\n\n~~~~markdown\n# root\n~~~~',
  ]) assert.ok(text.includes(line), line)
  assert.match(text, /Return the rulings as your structured output/)
})

test("the ruler's brief ends with the guidance when it is given, and is otherwise the same", () => {
  const bare = rulerBrief(PARTS)
  assert.equal(rulerBrief({ ...PARTS, guidance: 'GUIDANCE' }), bare + '\n\nGUIDANCE')
  assert.equal(rulerBrief({ ...PARTS, guidance: '' }), bare)
})

test("a node with no plan entry reads '(none)', and empty lists read '(none)'", () => {
  const text = rulerBrief({ ...PARTS, work: [], clears: [], reached: [{ id: 'cli', why: ['x'], entry: '', own: '' }] })
  assert.match(text, /Work under it:\n\(none\)/)
  assert.match(text, /Stops that approving this text clears:\n\(none\)/)
  assert.match(text, /Its plan entry: \(none\)\. Each spec/)
})
