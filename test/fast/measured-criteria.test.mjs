// test/fast/measured-criteria.test.mjs — pins that a plan criterion with a `check:` is the gate's
// observation: the gate measures the checks of the plan a folder's spec holds, and the integration
// reviewer is handed their results and told to leave those criteria out of what it rules.
//
// Design: docs/DESIGN.md#the-suite-gate.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { criterionChecks } from '../../lib/boundaries/merge.mjs'
import { integrationBrief } from '../../lib/briefs/execute.mjs'

const node = (id, kind, acceptance = []) => [id, { id, kind, acceptance }]
const crit = (text, check = '') => ({ text, check })

test("the gate's checks are the criteria of the folder's own plan, its groups' tasks included, each once", () => {
  const nodes = new Map([
    node('.', 'composite'),
    node('a', 'leaf', [crit('a works', 'npm test && npm run lint'), crit('HUMAN: a looks right')]),
    node('g', 'group'),
    node('g/x', 'leaf', [crit('x builds', 'npm run build && npm run test:e2e -- --workers=1'), crit('x again', 'npm test && npm run lint')]),
    node('sub', 'composite'),
    node('sub/y', 'leaf', [crit('y works', 'npx vitest run y')]),
  ])
  assert.deepEqual(criterionChecks(nodes, '.'), ['npm test && npm run lint', 'npm run build && npm run test:e2e -- --workers=1'])
  assert.deepEqual(criterionChecks(nodes, 'sub'), ['npx vitest run y'])
})

const SPAN = { base: 'b0', head: 'h1' }
const WHOLE = { rule: [{ unit: 'spec', anchor: 's', was: null }], stand: [] }
const MEASURED = [{ command: 'npm run build && npm run test:e2e -- --workers=1', status: 'passed' }]

test('the integration reviewer is handed the measured checks and leaves their criteria out of its claims', () => {
  const brief = integrationBrief({ folder: { id: 'f' }, spec: '# F', delta: WHOLE, span: SPAN, measured: MEASURED })
  assert.ok(brief.includes('## Measured'))
  assert.ok(brief.includes('`npm run build && npm run test:e2e -- --workers=1`: passed'))
  assert.match(brief, /criterion with a `check:` is the harness's/)
  assert.ok(!integrationBrief({ folder: { id: 'f' }, spec: '# F', delta: WHOLE, span: SPAN }).includes('## Measured'), 'nothing measured, nothing said')
})

test('a later review decides a measured criterion it rules again by its result', () => {
  const brief = integrationBrief({
    folder: { id: 'f' }, spec: '# F', span: SPAN, measured: MEASURED,
    last: { head_sha: 'h0', claims: [{ claim: 'conform-check#3', ruling: 'cant_tell' }], open: [] }, delta: { rule: [{ unit: 'claim:1', anchor: 'h1', was: null }], stand: [] },
  })
  assert.ok(brief.includes('## Measured'))
  assert.match(brief, /decided by its result under Measured/)
})
