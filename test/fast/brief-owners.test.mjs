// test/fast/brief-owners.test.mjs — every section a brief builder emits has an owner on purpose, and
// what code owns it bounds as it builds it: a refusal never names a part code could have shed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { contentionBrief, driftBrief, plannerBrief, reviewerBrief, staleBrief } from '../../lib/briefs/execute.mjs'
import { boundedDiff, oversizedPart, owned, sectionsOf } from '../../lib/briefs/size.mjs'
import { PART_BYTES } from '../../lib/roles.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const BUILDERS = ['lib/brief.mjs', ...['drafts', 'execute', 'investigate', 'probe', 'respec', 'review', 'search', 'solutions', 'survey'].map((n) => 'lib/briefs/' + n + '.mjs')]

/**
 * The sections code builds and owns, each small by construction or bounded where it is built. A
 * heading neither here nor in `OWNERS` would default to code's unseen.
 */
const CODE_OWNED = new Set([
  'The span', "The producer's return", 'The units you rule', 'Rulings that stand', 'Prior blockers', 'Return',
  'Existing tests rewritten', 'Leaves with no discriminating test', 'What merged since the last review', 'Caveat',
  'Work agentics did not produce', "The last review's claims", 'Blockers the last review left open', 'Claims',
  'Entries that run after this folder', 'Measured', 'Change', 'Round ', 'Decisions to realise', 'Your charge',
  'Findings to settle', 'The request', 'Evidence on its ground', 'Established already', 'To establish',
  'Nodes to rule', 'Not ruled', 'Rulings', 'Criteria that are not yours', 'Find', 'Material', 'Hits recorded',
  'Calls run', 'Where the last round did not look', 'Evidence', 'Gotchas',
])

/** The `## ` headings a builder's source writes: quoted literals, and the leaf brief's section names. */
function headingsOf(file) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  const quoted = [...text.matchAll(/(['"])## ((?:\\.|(?!\1).)+?)\1/g)].map((m) => m[2].replace(/\\'/g, "'"))
  const named = file === 'lib/brief.mjs' ? [...text.matchAll(/^\s*(?:\? )?\[\[?'([A-Z][\w ]+)', /gm)].map((m) => m[1]) : []
  return [...quoted, ...named]
}

test('every section a brief builder emits is owned on purpose', () => {
  const headings = new Set(BUILDERS.flatMap(headingsOf))
  assert.ok(headings.has('Task') && headings.has("The user's answers"), 'the scan reads both kinds of heading')
  assert.deepEqual([...headings].filter((h) => !owned(h) && !CODE_OWNED.has(h)), [])
})

test('the sections only a user changes are theirs, the plan entry the work\'s', () => {
  const brief = ['## The specs of its sub-efforts', '', '### a (x/DESIGN.md)', '', 'spec', '', "## The user's word on this folder", '', 'w',
    '', '## The edit to the spec', '', 'e', '', '## Plan entry', '', 'p'].join('\n')
  const owners = Object.fromEntries(sectionsOf(brief).map((p) => [p.key, oversizedPart([{ ...p, text: 'x'.repeat(PART_BYTES + 1) }], Infinity)]))
  assert.deepEqual(Object.values(owners).map((r) => [r.owner, r.file]),
    [['user', ''], ['user', 'a (x/DESIGN.md)'], ['user', ''], ['user', ''], ['work', '']])
})

const HUGE = PART_BYTES * 3
const fileDiff = (name, bytes) => 'diff --git a/' + name + ' b/' + name + '\n' + ('+' + 'x'.repeat(99) + '\n').repeat(Math.ceil(bytes / 101))
const entry = { title: 't', intent: 'i', acceptance: [], expects: [], reads: [], consumes: [] }
const codeRefusal = (text) => {
  const over = oversizedPart(sectionsOf(text), Infinity)
  return over && over.owner === 'code' ? over : null
}

test('a change too large for a ruler is cut by whole files, each one left out named', () => {
  const text = boundedDiff(fileDiff('a.mjs', 100) + fileDiff('big.mjs', HUGE), PART_BYTES)
  assert.ok(text.includes('diff --git a/a.mjs') && !text.includes('diff --git a/big.mjs'))
  assert.match(text, /left out to fit this brief: the change to big\.mjs/)
  const one = boundedDiff(fileDiff('big.mjs', HUGE), PART_BYTES)
  assert.ok(one.includes('diff --git a/big.mjs') && one.length <= PART_BYTES, 'a lone file too large is cut to its head')
})

test('no code-owned part of a ruler, reviewer or planner brief outgrows its budget', () => {
  const diff = fileDiff('a.mjs', HUGE)
  const briefs = {
    drift: driftBrief({ target: 'f', records: [{ node: 'n', contract: 'c', files: ['a.mjs'], entry }], diffs: { n: diff } }),
    stale: staleBrief({ nodes: [{ node: 'n', anchor: 'a', writes: [], reads: [], entry }], base_now: 'b', diffs: { n: diff } }),
    contention: contentionBrief({ trigger: 'conflict', unit: 'u', entry, diff, paths: ['a.mjs'], merged: diff }),
    reviewer: reviewerBrief({ leaf: { id: 'l', title: 't', provides: [], role: 'none' }, brief: '## Task', span: { base: 'a', head: 'b' },
      producer: { status: 'done', concerns: [], text: ('word '.repeat(40) + '\n\n').repeat(HUGE / 200) } }),
    planner: plannerBrief({ folder: { id: 'f', spec_path: 's' }, mode: 'write', context: ('fact '.repeat(40) + '\n\n').repeat(HUGE / 200) }),
  }
  for (const [name, text] of Object.entries(briefs)) {
    assert.equal(codeRefusal(text), null, name)
    assert.match(text, /left out to fit this brief/, name + ' declares what it left out')
  }
})
