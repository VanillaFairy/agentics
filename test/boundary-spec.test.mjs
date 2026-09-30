// test/boundary-spec.test.mjs — lib/boundary.mjs against real git: the spec-* boundaries over a planner's folder.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { append, readLog } from '../lib/ledger.mjs'
import { readTree } from '../lib/tree.mjs'
import { posix, specPath } from '../lib/store.mjs'
import { approvalGate, approvalState, recordApproval } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { B, repo } from './harness/boundary-fixture.mjs'

const ROOT_SPEC = [
  '# The change', '', '## Intent', '', 'Make the change.', '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|', '| D1 | do it | asked for |', '',
  '## Design', '', 'One sub-effort the planner writes.', '',
  '## Plan', '', '- **p** — sub-effort · realises: D1 · author: planner', '  Build p.', '  The planner writes its spec.', '',
  '## Open questions', '', '## Evidence', '', 'None gathered.', '',
].join('\n')

const P_SPEC = [
  '# Build p', '', '## Intent', '', 'Build p, as the root plans it.', '',
  '## Decisions', '',
  '## Design', '', 'One function.', '',
  '## Plan', '',
  '- **x** — task · realises: D1 · rigor: tdd · locus: src/x.mjs, test/x.test.mjs',
  '  Add x.', '  Write x and its test.', '  - [ ] x works — check: `node --test test/x.test.mjs`', '',
  '## Open questions', '', '## Evidence', '', 'The root\'s.', '',
].join('\n')

function writeSpecAt(r, folder, text) {
  const path = specPath(r, 'e1', folder)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}

function plannerFolder() {
  const r = repo()
  writeSpecAt(r, '.', ROOT_SPEC)
  assert.equal(recordApproval(r, 'e1', '.').ok, true)
  assert.equal(compileEffort(r, 'e1').ok, true)
  assert.equal(readTree(r, 'e1').nodes.get('p').kind, 'design')
  return r
}

test('spec-check, spec-settle, spec-prepare: a planner spec is checked, settled once, prepared and compiled', () => {
  const r = plannerFolder()
  const path = writeSpecAt(r, 'p', P_SPEC)

  const checked = B(r, 'spec-check', { node: 'p' })
  assert.equal(checked.ok, true, JSON.stringify(checked.error))
  assert.equal(checked.spec_path, posix(path))
  assert.equal(checked.hash, hashSpec(P_SPEC))
  assert.equal(checked.decisions_n, 0)
  assert.deepEqual(checked.problems, [])

  const settle = { node: 'p', dispositions: [{ finding: 'I0badc0de', outcome: 'incorporated' }] }
  B(r, 'spec-settle', settle)
  B(r, 'spec-settle', settle)
  const lines = readLog(r, 'e1', 'ledger').entries.filter((e) => e.kind === 'disposition' && e.folder === 'p')
  assert.deepEqual(lines.map((e) => [e.finding, e.outcome, e.by]), [['I0badc0de', 'incorporated', 'planner']])

  const prepared = B(r, 'spec-prepare', { node: 'p', review: '20260926-120000-probe' })
  assert.equal(prepared.status, 'prepared')
  assert.equal(prepared.compile.ok, true, JSON.stringify(prepared.compile.problems))
  assert.equal(approvalState(r, 'e1', 'p').state, 'prepared')
  const line = readLog(r, 'e1', 'ledger').entries.filter((e) => e.kind === 'prepared' && e.folder === 'p').pop()
  assert.equal(line.review, '20260926-120000-probe', 'the prepared line names the review return that passed')
  const tree = readTree(r, 'e1')
  assert.equal(tree.nodes.get('p').kind, 'composite')
  assert.ok(tree.nodes.has('p/x'))
  assert.deepEqual([prepared.row.id, prepared.row.kind, prepared.row.children_n], ['p', 'composite', 1], 'the prepared node as compiled')
})

test('a planner spec that states a decision is reported by spec-check and refused by spec-prepare', () => {
  const r = plannerFolder()
  writeSpecAt(r, 'p', P_SPEC.replace('## Decisions\n', '## Decisions\n\n| id | decision | why |\n|---|---|---|\n| p.D1 | keep it in memory | faster |\n'))

  const checked = B(r, 'spec-check', { node: 'p' })
  assert.equal(checked.decisions_n, 1)
  assert.ok(checked.problems.length > 0)

  const prepared = B(r, 'spec-prepare', { node: 'p', review: '20260926-120000-probe' })
  assert.equal(prepared.status, 'refused')
  assert.equal(approvalState(r, 'e1', 'p').state, 'none')
  assert.equal(readTree(r, 'e1').nodes.get('p').kind, 'design')
})

test('spec-check on a folder whose parent entry is author: you reports a problem, and spec-prepare refuses it', () => {
  const r = repo()
  writeSpecAt(r, '.', ROOT_SPEC.replace(' · author: planner', ''))
  assert.equal(recordApproval(r, 'e1', '.').ok, true)
  assert.equal(compileEffort(r, 'e1').ok, true)
  writeSpecAt(r, 'p', P_SPEC)

  const checked = B(r, 'spec-check', { node: 'p' })
  assert.equal(checked.exists, true)
  assert.ok(checked.problems.length > 0, 'a folder the parent gives the user is not the planner\'s to prepare')
  assert.equal(B(r, 'spec-prepare', { node: 'p', review: '20260926-120000-probe' }).status, 'refused')
  assert.equal(approvalState(r, 'e1', 'p').state, 'none')
})

test('spec-check on a missing spec reports exists: false, and spec-prepare refuses it', () => {
  const r = plannerFolder()
  assert.equal(B(r, 'spec-check', { node: 'p' }).exists, false)
  assert.equal(B(r, 'spec-prepare', { node: 'p', review: '20260926-120000-probe' }).status, 'refused')
  assert.equal(approvalState(r, 'e1', 'p').state, 'none')
})

test('spec-reviewed records how much of the spec on disk a round examined', () => {
  const r = plannerFolder()
  writeSpecAt(r, 'p', P_SPEC)
  B(r, 'spec-reviewed', { node: 'p', complete: false, remaining: ['growth'] })
  B(r, 'spec-reviewed', { node: 'p', complete: true, remaining: [] })
  const lines = readLog(r, 'e1', 'ledger').entries.filter((e) => e.kind === 'reviewed' && e.folder === 'p')
  assert.deepEqual(lines.map((e) => [e.hash, e.complete, e.remaining]), [[hashSpec(P_SPEC), false, ['growth']], [hashSpec(P_SPEC), true, []]])
})

test('spec-gate is the ledger\'s gate: the latest review of the spec on disk, and every ambiguity disposed', () => {
  const r = plannerFolder()
  writeSpecAt(r, 'p', P_SPEC)
  assert.equal(B(r, 'spec-gate', { node: 'p' }).ratifiable, false, 'no review has read it yet')
  B(r, 'spec-reviewed', { node: 'p', complete: true, remaining: [], ambiguities: ['I0badc0de'] })
  const shut = B(r, 'spec-gate', { node: 'p' })
  assert.deepEqual([shut.ratifiable, shut.open], [false, ['I0badc0de']])
  assert.deepEqual(shut.open, approvalGate(r, 'e1', 'p').open, 'the boundary is approvalGate')
  B(r, 'spec-settle', { node: 'p', dispositions: [{ finding: 'I0badc0de', outcome: 'incorporated' }] })
  assert.equal(B(r, 'spec-gate', { node: 'p' }).ratifiable, true)
  writeSpecAt(r, 'p', P_SPEC.replace('One function.', 'One function, edited.'))
  assert.equal(B(r, 'spec-gate', { node: 'p' }).ratifiable, false, 'an edit waits for a review of the new text')
})

test('spec-prepare clears the spec_changed park its own compile raises on the folder it re-derived', () => {
  const r = plannerFolder()
  writeSpecAt(r, 'p', P_SPEC)
  assert.equal(B(r, 'spec-prepare', { node: 'p', review: '20260926-110000-probe' }).status, 'prepared')
  assert.equal(append(r, 'e1', 'events', { kind: 'dispatched', node: 'p/x', execution: '20260926-120000', role: 'implementer', round: 1 }).ok, true)
  writeSpecAt(r, 'p', P_SPEC.replace('One function.', 'One function, and its test.'))

  const again = B(r, 'spec-prepare', { node: 'p', review: '20260926-120000-probe' })
  assert.equal(again.status, 'prepared')
  const tree = readTree(r, 'e1')
  assert.ok(tree.events.some((e) => e.kind === 'parked' && e.node === 'p' && e.return === 'spec_changed'), 'compile saw the change under dispatched work')
  assert.notEqual(tree.status.get('p').status, 'parked', 'the planner\'s re-derivation answers the park it raised')
  assert.equal(tree.events.filter((e) => e.kind === 'replanned' && e.node === 'p' && e.reason === 'spec_rederived').length, 1)
})
