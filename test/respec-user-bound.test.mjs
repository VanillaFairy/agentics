// test/respec-user-bound.test.mjs — the choices of the user's a changed spec makes, each a unit of its
// own: a decision added, changed or removed, a contract whose paths changed, a decision park cleared;
// and what settling does with them: a unit no answer covers is ruled `affected` and goes to the user
// as its question, one the user's answer settles is ruled `answered` and the change is approved by
// that answer, and ruled `unaffected` it is refused back to the ruler.
//
// Design: docs/DESIGN.md#a-changed-spec.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { recordApproval } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { respecBrief, respecSettle, userBound } from '../lib/respec.mjs'
import { specPath } from '../lib/store.mjs'

const FIXTURES = fileURLToPath(new URL('./fixtures/compile/', import.meta.url))
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n')
const ROOT = read('root.md')
const API = read('api.md')
const E = 'e1'
const X = '20260926-120000'

const WORDING = API.replace('`load(path)`, then `parse(text)`.', '`load(path)` returns a frozen object.')
const DECISION_CHANGED = ROOT.replace('Unknown keys are an error.', 'Unknown keys are an error, named in the message.')
const DECISION_REMOVED = API
  .replace('| api.D1 | The loader returns a plain object. | Callers need no class. |\n', '')
  .replace('realises: D2, api.D1', 'realises: D2')
const CONTRACT_CHANGED = API.replace('provides: config-type (src/api/types.js)', 'provides: config-type (src/api/types.js, src/api/more.js)')

function write(repo, id, text) {
  mkdirSync(dirname(specPath(repo, E, id)), { recursive: true })
  writeFileSync(specPath(repo, E, id), text)
}

/** An effort whose root and api specs are approved and compiled; `then` runs before `edit` is written. */
function changed(t, edit, then = () => {}) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-userbound-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  write(repo, '.', ROOT)
  write(repo, 'api', API)
  for (const id of ['.', 'api']) assert.equal(recordApproval(repo, E, id).ok, true)
  assert.equal(compileEffort(repo, E).ok, true)
  then(repo)
  edit(repo)
  return repo
}
const editApi = (text) => (repo) => write(repo, 'api', text)
const editRoot = (text) => (repo) => write(repo, '.', text)

const event = (repo, e) => assert.equal(append(repo, E, 'events', { execution: X, ...e }).ok, true)
const ledger = (repo, kind) => readLog(repo, E, 'ledger').entries.filter((l) => l.kind === kind)

/** The user answers about `nodes`; the seq of the `answered` line. */
function answer(repo, nodes = ['api']) {
  const asked = append(repo, E, 'ledger', { kind: 'asked', nodes })
  const out = append(repo, E, 'ledger', {
    kind: 'answered', asked: asked.seqs[0], nodes, answers: [{ question: 'Is that what you want?', answer: 'Yes, as the spec states it.' }], by: 'user',
  })
  assert.equal(out.ok, true, JSON.stringify(out))
  return out.seqs[0]
}

/** Brief the folder, rule every unit unaffected but those `over` names, settle. */
function settle(repo, folder, over = {}) {
  const brief = respecBrief(repo, E, folder)
  assert.equal(brief.status, 'brief', JSON.stringify(brief))
  writeFileSync(brief.rulings, JSON.stringify({
    rulings: brief.nodes.map((node) => ({ node, ruling: 'unaffected', why: 'nothing it uses moved', question: '', fix: '', ...(over[node] || {}) })),
  }))
  return { brief, out: respecSettle(repo, E, folder) }
}
const affected = (question) => ({ ruling: 'affected', why: 'the user has not chosen this', question })

const dec = (id, text) => ({ id, text })
const entry = (name, ...paths) => ({ name, provides: paths.length ? [{ name: name + '-c', paths }] : [] })

test('an added, changed or removed decision is a unit of the user\'s own', () => {
  const added = userBound({ approvedDecisions: [dec('D1', 'a')], decisions: [dec('D1', 'a'), dec('D2', 'b')] })
  const changedText = userBound({ approvedDecisions: [dec('D1', 'a')], decisions: [dec('D1', 'a, named')] })
  const removed = userBound({ approvedDecisions: [dec('D1', 'a'), dec('D2', 'b')], decisions: [dec('D1', 'a')] })
  for (const [units, unit, verb] of [[added, 'decision:D2', 'adds'], [changedText, 'decision:D1', 'changes'], [removed, 'decision:D2', 'removes']]) {
    assert.deepEqual(units.map((u) => u.unit), [unit], verb)
    assert.ok(units[0].why.startsWith(verb), units[0].why)
    assert.ok(units[0].why.includes(unit.slice('decision:'.length)), units[0].why)
  }
})

test('a changed contract is a unit of the user\'s own, whether it changes, appears or goes', () => {
  const was = [entry('api', 'src/api/')]
  for (const [compiledEntries, entries] of [
    [was, [entry('api', 'src/api/', 'src/shared/')]], [[entry('api')], was], [was, [entry('api')]],
  ]) {
    const units = userBound({ compiledEntries, entries })
    assert.deepEqual(units.map((u) => u.unit), ['contract:api'])
    assert.ok(units[0].why.includes('api'), units[0].why)
  }
})

test('a cleared decision park is a unit of the user\'s own', () => {
  for (const why of ['needs_decision', 'contract_changed']) {
    const units = userBound({ clears: [{ node: 'cli', why }] })
    assert.deepEqual(units.map((u) => u.unit), ['park:cli'], why)
    assert.ok(units[0].why.includes(why) && units[0].why.includes('cli'), units[0].why)
  }
})

test('a wording edit elsewhere is nobody\'s but the ruler\'s', () => {
  const units = userBound({
    approvedDecisions: [dec('D1', 'a')], decisions: [dec('D1', 'a')],
    compiledEntries: [entry('api', 'src/api/'), entry('cli')], entries: [entry('api', 'src/api/'), entry('cli')],
    clears: [{ node: 'cli', why: 'premise_mismatch' }, { node: 'x', why: '' }],
  })
  assert.deepEqual(units, [])
  assert.deepEqual(userBound({}), [])
})

/** Each change of the user's: how it is edited, the folder it is ruled in, the unit it makes, and the setup before. */
const CHANGES = {
  'a changed decision': { edit: editRoot(DECISION_CHANGED), folder: '.', unit: 'decision:D2' },
  'a removed decision': { edit: editApi(DECISION_REMOVED), folder: 'api', unit: 'decision:api.D1' },
  'a changed contract': { edit: editApi(CONTRACT_CHANGED), folder: 'api', unit: 'contract:types' },
  'a cleared decision park': {
    edit: editApi(WORDING), folder: 'api', unit: 'park:api/parse',
    then: (r) => event(r, { kind: 'parked', node: 'api/parse', return: 'needs_decision', question: 'which tokenizer?' }),
  },
}

for (const [name, { edit, folder, unit, then }] of Object.entries(CHANGES)) {
  test(`${name} is a unit the brief gives the ruler, and ruled unaffected it is refused back`, (t) => {
    const repo = changed(t, edit, then)
    const { brief, out } = settle(repo, folder)
    assert.ok(brief.nodes.includes(unit), JSON.stringify(brief.nodes))
    assert.deepEqual([out.status, out.next], ['refused', 'rule_it'], JSON.stringify(out))
    assert.ok(out.why.includes(unit), out.why)
    assert.equal(ledger(repo, 'ruled').length, 0)
    assert.equal(ledger(repo, 'approved').length, 2, 'nothing was approved')
  })

  test(`${name} no answer settles goes to the user as its affected unit`, (t) => {
    const repo = changed(t, edit, then)
    const { out } = settle(repo, folder, { [unit]: affected('What did you choose?') })
    assert.equal(out.status, 'needs_user', JSON.stringify(out))
    assert.deepEqual(out.affected.map((a) => [a.node, a.question]), [[unit, 'What did you choose?']])
    assert.equal(out.ruled, ledger(repo, 'ruled').at(-1).seq, 'the ruled line is recorded first')
    assert.equal(ledger(repo, 'approved').length, 2, 'nothing was approved')
  })

  test(`${name} the user's answer settles is approved by that answer`, (t) => {
    const repo = changed(t, edit, then)
    const seq = answer(repo, [unit.replace(/^[a-z]+:/, '')])
    const { out } = settle(repo, folder, { [unit]: { ruling: 'answered', answers: [seq] } })
    assert.equal(out.status, 'approved', JSON.stringify(out))
    assert.equal(out.by, 'answer')
    const approval = ledger(repo, 'approved').at(-1)
    assert.deepEqual([approval.by, approval.ruled, approval.answers], ['answer', out.ruled, [seq]])
  })
}

test('clearing another park does not by itself reach the user', (t) => {
  const repo = changed(t, editApi(WORDING), (r) => event(r, { kind: 'parked', node: 'api/parse', return: 'premise_mismatch', question: 'is it so?' }))
  const { out } = settle(repo, 'api')
  assert.equal(out.status, 'approved', JSON.stringify(out))
  assert.deepEqual(out.answered, ['api/parse'], 'the park was cleared')
  assert.equal(out.by, 'ruling')
})

test('an unaffected change with nothing of the user\'s is approved by ruling', (t) => {
  const { out } = settle(changed(t, editApi(WORDING)), 'api')
  assert.equal(out.status, 'approved', JSON.stringify(out))
  assert.equal(out.by, 'ruling')
})

test('settling twice records one ruled line', (t) => {
  const repo = changed(t, editRoot(DECISION_CHANGED))
  const { out: first } = settle(repo, '.', { 'decision:D2': affected('Should the error name the key?') })
  const again = respecSettle(repo, E, '.')
  assert.deepEqual([again.status, again.ruled], ['needs_user', first.ruled])
  assert.equal(ledger(repo, 'ruled').length, 1)
})
