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
import { B, repo, wrote } from './harness/boundary-fixture.mjs'

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

/** A review's findings file as the autonomous review writes it: every finding in full. */
const finding = (id, severity, claim, item = 'I' + id.toLowerCase() + 'badc0de') =>
  ({ id, item, severity, axis: 'contract-ambiguity', section: 'Design', claim, evidence: 'DESIGN.md:12' })
const findingsFile = (...findings) => wrote({ findings })
const dispositions = (...pairs) => wrote({ dispositions: pairs.map(([finding, outcome]) => ({ finding, outcome })) })
const ledger = (r, kind) => readLog(r, 'e1', 'ledger').entries.filter((e) => e.kind === kind && e.folder === 'p')
const stopOf = (r) => readTree(r, 'e1').status.get('p')

test('spec-check, spec-settle, spec-prepare: a planner spec is checked, settled once, prepared and compiled', () => {
  const r = plannerFolder()
  const path = writeSpecAt(r, 'p', P_SPEC)

  const checked = B(r, 'spec-check', { node: 'p' })
  assert.equal(checked.status, 'checked')
  assert.equal(checked.spec_path, posix(path))
  assert.equal(checked.hash, hashSpec(P_SPEC))
  assert.deepEqual([checked.decisions_n, checked.problems_n], [0, 0])

  const settle = {
    node: 'p', hash: checked.hash, findings_file: findingsFile(finding('P1', 'gap', 'no retry')), finding: ['P1'],
    return_file: dispositions(['P1', 'incorporated']), status: 'settled', said: '',
  }
  assert.deepEqual([B(r, 'spec-settle', settle).status, B(r, 'spec-settle', settle).incorporated_n], ['settled', 1])
  assert.deepEqual(ledger(r, 'disposition').map((e) => [e.finding, e.outcome, e.by]), [['Ip1badc0de', 'incorporated', 'planner']],
    'a settlement sent again lands once, under the finding\'s settlement id')

  const prepared = B(r, 'spec-prepare', { node: 'p', review: '20260926-120000-probe' })
  assert.equal(prepared.status, 'prepared')
  assert.equal(prepared.compile.ok, true)
  assert.equal(approvalState(r, 'e1', 'p').state, 'prepared')
  assert.equal(ledger(r, 'prepared').pop().review, '20260926-120000-probe', 'the prepared line names the review return that passed')
  const tree = readTree(r, 'e1')
  assert.equal(tree.nodes.get('p').kind, 'composite')
  assert.ok(tree.nodes.has('p/x'))
  assert.deepEqual([prepared.row.kind, prepared.row.children_n], ['composite', 1], 'the prepared node as compiled')
})

test('spec-check closes the planner\'s dispatch: a written spec is checked, a need parks the folder on its file, nothing returned holds it', () => {
  const r = plannerFolder()
  writeSpecAt(r, 'p', P_SPEC)
  assert.equal(B(r, 'spec-check', { node: 'p', status: 'written', said: '/said/plan-p.md' }).status, 'checked')
  const asked = B(r, 'spec-check', { node: 'p', status: 'needs_decision', said: '/said/plan-p.md' })
  assert.deepEqual([asked.status, asked.stops], ['stopped', [{ id: 'p', status: 'parked', reason: 'needs_decision', said: '/said/plan-p.md' }]])
  const blocked = B(r, 'spec-check', { node: 'p', status: 'blocked', said: '/said/plan-p.md' })
  assert.deepEqual(blocked.stops.map((s) => [s.status, s.reason]), [['escalated', 'plan_blocked']])
  const none = B(r, 'spec-check', { node: 'p', status: '', said: '/said/plan-p.md' })
  assert.deepEqual([none.status, none.stops.map((s) => [s.status, s.reason])], ['held', [['held', 'dispatch']]])
})

test('a planner spec that states a decision parks at spec-check, and spec-prepare refuses it', () => {
  const r = plannerFolder()
  writeSpecAt(r, 'p', P_SPEC.replace('## Decisions\n', '## Decisions\n\n| id | decision | why |\n|---|---|---|\n| p.D1 | keep it in memory | faster |\n'))

  const checked = B(r, 'spec-check', { node: 'p' })
  assert.equal(checked.decisions_n, 1)
  assert.deepEqual(checked.stops.map((s) => [s.status, s.reason]), [['parked', 'needs_decision']])
  assert.match(stopOf(r).last.question, /states 1 decision\(s\): only the user states decisions/)

  const prepared = B(r, 'spec-prepare', { node: 'p', review: '20260926-120000-probe' })
  assert.deepEqual(prepared.stops.map((s) => s.reason), ['prepare_refused'])
  assert.equal(approvalState(r, 'e1', 'p').state, 'none')
  assert.equal(readTree(r, 'e1').nodes.get('p').kind, 'design')
})

test('spec-check on a folder whose parent entry is author: you escalates it, and spec-prepare refuses it', () => {
  const r = repo()
  writeSpecAt(r, '.', ROOT_SPEC.replace(' · author: planner', ''))
  assert.equal(recordApproval(r, 'e1', '.').ok, true)
  assert.equal(compileEffort(r, 'e1').ok, true)
  writeSpecAt(r, 'p', P_SPEC)

  const checked = B(r, 'spec-check', { node: 'p' })
  assert.equal(checked.exists, true)
  assert.deepEqual(checked.stops.map((s) => s.reason), ['spec_refused'], 'a folder the parent gives the user is not the planner\'s to prepare')
  assert.match(stopOf(r).last.detail, /gives p to the user/)
  assert.equal(B(r, 'spec-prepare', { node: 'p', review: '20260926-120000-probe' }).status, 'stopped')
  assert.equal(approvalState(r, 'e1', 'p').state, 'none')
})

test('spec-check on a missing spec reports exists: false, and spec-prepare refuses it', () => {
  const r = plannerFolder()
  assert.equal(B(r, 'spec-check', { node: 'p' }).exists, false)
  assert.equal(B(r, 'spec-prepare', { node: 'p', review: '20260926-120000-probe' }).status, 'stopped')
  assert.equal(approvalState(r, 'e1', 'p').state, 'none')
})

test('spec-reviewed records how much of the spec on disk a round examined, and a partial round escalates naming what it left', () => {
  const r = plannerFolder()
  writeSpecAt(r, 'p', P_SPEC)
  const partial = B(r, 'spec-reviewed', { node: 'p', hash: hashSpec(P_SPEC), complete: false, remaining: ['growth'] })
  assert.deepEqual([partial.status, partial.stops.map((s) => s.reason)], ['stopped', ['review_incomplete']])
  B(r, 'spec-reviewed', { node: 'p', hash: hashSpec(P_SPEC), complete: true, remaining: [] })
  assert.deepEqual(ledger(r, 'reviewed').map((e) => [e.hash, e.complete, e.remaining]), [[hashSpec(P_SPEC), false, ['growth']], [hashSpec(P_SPEC), true, []]])
})

test('spec-reviewed reads the round\'s findings from their file: the ambiguities it records, the findings still to settle, and one back after it was incorporated', () => {
  const r = plannerFolder()
  writeSpecAt(r, 'p', P_SPEC)
  const h1 = hashSpec(P_SPEC)
  const first = findingsFile(finding('P1', 'ambiguity', 'Two meanings of tick'), finding('P2', 'note', 'name it', ''))
  const round1 = B(r, 'spec-reviewed', { node: 'p', hash: h1, findings_file: first, complete: true })
  assert.deepEqual(round1.fresh, ['P1', 'P2'])
  assert.deepEqual(ledger(r, 'reviewed').pop().ambiguities, ['Ip1badc0de'])
  B(r, 'spec-settle', {
    node: 'p', hash: h1, findings_file: first, finding: ['P1', 'P2'], status: 'settled',
    return_file: dispositions(['P1', 'incorporated'], ['P2', 'discarded']),
  })
  assert.deepEqual(ledger(r, 'disposition').map((e) => e.finding), ['Ip1badc0de', h1 + '#P2'], 'an unanchored finding is settled under the hash it was found at')

  const carried = findingsFile(finding('P1', 'ambiguity', 'Two meanings of tick'))
  assert.deepEqual(B(r, 'spec-reviewed', { node: 'p', hash: 'h2', findings_file: carried, previous_file: first, previous_hash: h1, complete: true }).fresh, [],
    'a finding a round settled stays settled')
  const back = findingsFile(finding('P7', 'ambiguity', '  two meanings  of TICK ', 'Inew'))
  const out = B(r, 'spec-reviewed', { node: 'p', hash: 'h2', findings_file: back, previous_file: first, previous_hash: h1, complete: true })
  assert.deepEqual(out.stops.map((s) => s.reason), ['review_not_converging'])
  assert.match(stopOf(r).last.detail, /finding P7 came back unchanged after it was incorporated/)
})

test('spec-settle refuses a settlement that discards an ambiguity or leaves a finding out, once; the same refusal twice escalates', () => {
  const r = plannerFolder()
  writeSpecAt(r, 'p', P_SPEC)
  const file = findingsFile(finding('P1', 'ambiguity', 'two readings'), finding('P2', 'gap', 'no retry'))
  const settle = (refused, ...pairs) => B(r, 'spec-settle', {
    node: 'p', hash: 'h', findings_file: file, finding: ['P1', 'P2'], refused, status: 'settled', return_file: dispositions(...pairs),
  })
  const first = settle([], ['P1', 'discarded'])
  assert.deepEqual([first.status, first.refused], ['refused', ['P1', 'P2']])
  assert.deepEqual(ledger(r, 'disposition'), [], 'a refused settlement records nothing')
  const second = settle(first.refused, ['P1', 'discarded'], ['P2', 'incorporated'])
  assert.deepEqual(second.stops.map((s) => s.reason), ['review_not_converging'])
  const asked = B(r, 'spec-settle', { node: 'p', hash: 'h', findings_file: file, finding: ['P1'], status: 'needs_decision', said: '/said/s.md' })
  assert.equal(asked.stops[0].said, '/said/s.md')
})

test('spec-gate is the ledger\'s gate: the latest review of the spec on disk, and every ambiguity disposed', () => {
  const r = plannerFolder()
  writeSpecAt(r, 'p', P_SPEC)
  assert.equal(B(r, 'spec-gate', { node: 'p', edited: true }).ratifiable, false, 'no review has read it yet')
  const file = findingsFile(finding('P1', 'ambiguity', 'two readings', 'I0badc0de'))
  B(r, 'spec-reviewed', { node: 'p', hash: hashSpec(P_SPEC), findings_file: file, complete: true })
  const shut = B(r, 'spec-gate', { node: 'p', edited: true })
  assert.deepEqual([shut.ratifiable, shut.open, shut.status], [false, ['I0badc0de'], 'shut'])
  assert.deepEqual(shut.open, approvalGate(r, 'e1', 'p').open, 'the boundary is approvalGate')
  B(r, 'spec-settle', { node: 'p', hash: hashSpec(P_SPEC), findings_file: file, finding: ['P1'], status: 'settled', return_file: dispositions(['P1', 'incorporated']) })
  const waiting = B(r, 'spec-gate', { node: 'p', edited: true })
  assert.deepEqual([waiting.ratifiable, waiting.open], [false, ['I0badc0de']], 'an incorporated ambiguity waits for a later round that rules its section clean')
  writeSpecAt(r, 'p', P_SPEC.replace('One function.', 'One function, edited.'))
  assert.equal(B(r, 'spec-gate', { node: 'p', edited: true }).ratifiable, false, 'an edit waits for a review of the new text')
  const stuck = B(r, 'spec-gate', { node: 'p', edited: false })
  assert.deepEqual([stuck.status, stuck.stops.map((s) => s.reason)], ['stopped', ['review_not_converging']], 'a round that edited nothing cannot open a shut gate')
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
