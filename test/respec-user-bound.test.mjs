// test/respec-user-bound.test.mjs — what of a changed spec reaches the user whatever the rulings
// say: a decision added, changed or removed, a contract whose paths changed, a decision park
// cleared; and `respecSettle`'s use of it behind `checkUserBound`.
//
// Design: docs/DESIGN.md#a-changed-spec.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
function changed(edit, then = () => {}) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-userbound-'))
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

/** Brief the folder, rule every node unaffected, settle with the option on. */
function settle(repo, folder, opts = {}) {
  const brief = respecBrief(repo, E, folder)
  assert.equal(brief.status, 'brief', JSON.stringify(brief))
  writeFileSync(brief.rulings, JSON.stringify({
    rulings: brief.nodes.map((node) => ({ node, ruling: 'unaffected', why: 'nothing it uses moved', question: '', fix: '' })),
  }))
  return respecSettle(repo, E, folder, { checkUserBound: true, ...opts })
}

const dec = (id, text) => ({ id, text })
const entry = (name, ...paths) => ({ name, provides: paths.length ? [{ name: name + '-c', paths }] : [] })

test('an added decision is the user\'s', () => {
  const reasons = userBound({ approvedDecisions: [dec('D1', 'a')], decisions: [dec('D1', 'a'), dec('D2', 'b')] })
  assert.deepEqual(reasons, ['adds decision D2'])
})

test('a changed decision text is the user\'s', () => {
  const reasons = userBound({ approvedDecisions: [dec('D1', 'a')], decisions: [dec('D1', 'a, named')] })
  assert.deepEqual(reasons, ['changes decision D1'])
})

test('a removed decision is the user\'s', () => {
  const reasons = userBound({ approvedDecisions: [dec('D1', 'a'), dec('D2', 'b')], decisions: [dec('D1', 'a')] })
  assert.deepEqual(reasons, ['removes decision D2'])
})

test('a changed contract is the user\'s', () => {
  const reasons = userBound({ compiledEntries: [entry('api', 'src/api/')], entries: [entry('api', 'src/api/', 'src/shared/')] })
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /api/)
  assert.equal(userBound({ compiledEntries: [entry('api')], entries: [entry('api', 'src/api/')] }).length, 1, 'a contract appearing')
  assert.equal(userBound({ compiledEntries: [entry('api', 'src/api/')], entries: [entry('api')] }).length, 1, 'a contract going')
})

test('a cleared decision park is the user\'s', () => {
  for (const why of ['needs_decision', 'contract_changed']) {
    const reasons = userBound({ clears: [{ node: 'cli', why }] })
    assert.equal(reasons.length, 1, why)
    assert.ok(reasons[0].includes(why) && reasons[0].includes('cli'), reasons[0])
  }
})

test('a wording edit elsewhere is nobody\'s but the ruler\'s', () => {
  const reasons = userBound({
    approvedDecisions: [dec('D1', 'a')], decisions: [dec('D1', 'a')],
    compiledEntries: [entry('api', 'src/api/'), entry('cli')], entries: [entry('api', 'src/api/'), entry('cli')],
    clears: [{ node: 'cli', why: 'premise_mismatch' }, { node: 'x', why: '' }],
  })
  assert.deepEqual(reasons, [])
  assert.deepEqual(userBound({}), [])
})

test('a changed decision reaches the user', () => {
  const repo = changed(editRoot(DECISION_CHANGED))
  const out = settle(repo, '.')
  assert.equal(out.status, 'needs_user', JSON.stringify(out))
  assert.deepEqual(out.affected, [])
  assert.ok(out.reasons.some((r) => r.includes('D2')), JSON.stringify(out.reasons))
  assert.equal(out.ruled, ledger(repo, 'ruled').at(-1).seq, 'the ruled line is recorded first')
  assert.equal(ledger(repo, 'approved').length, 2, 'nothing was approved')
})

test('a removed decision reaches the user', () => {
  const out = settle(changed(editApi(DECISION_REMOVED)), 'api')
  assert.equal(out.status, 'needs_user', JSON.stringify(out))
  assert.ok(out.reasons.some((r) => r.includes('api.D1')), JSON.stringify(out.reasons))
})

test('a changed contract reaches the user', () => {
  const out = settle(changed(editApi(CONTRACT_CHANGED)), 'api')
  assert.equal(out.status, 'needs_user', JSON.stringify(out))
  assert.ok(out.reasons.some((r) => r.includes('config-type') || r.includes('types')), JSON.stringify(out.reasons))
})

test('clearing a decision park reaches the user', () => {
  const repo = changed(editApi(WORDING), (r) => event(r, { kind: 'parked', node: 'api/parse', return: 'needs_decision', question: 'which tokenizer?' }))
  const out = settle(repo, 'api')
  assert.equal(out.status, 'needs_user', JSON.stringify(out))
  assert.ok(out.reasons.some((r) => r.includes('api/parse')), JSON.stringify(out.reasons))
})

test('clearing another park does not by itself reach the user', () => {
  const repo = changed(editApi(WORDING), (r) => event(r, { kind: 'parked', node: 'api/parse', return: 'premise_mismatch', question: 'is it so?' }))
  const out = settle(repo, 'api')
  assert.equal(out.status, 'approved', JSON.stringify(out))
  assert.deepEqual(out.answered, ['api/parse'], 'the park was cleared')
  assert.equal(out.by, 'ruling')
})

test('an unaffected change with nothing of the user\'s is approved by ruling', () => {
  const out = settle(changed(editApi(WORDING)), 'api')
  assert.equal(out.status, 'approved', JSON.stringify(out))
  assert.equal(out.by, 'ruling')
})

test('the user\'s approval settles a user-bound change', () => {
  const repo = changed(editRoot(DECISION_CHANGED))
  const first = settle(repo, '.')
  assert.equal(first.status, 'needs_user')
  const out = respecSettle(repo, E, '.', { checkUserBound: true, userApproved: true })
  assert.equal(out.status, 'approved', JSON.stringify(out))
  assert.equal(out.by, 'user')
  assert.equal(ledger(repo, 'approved').at(-1).by, 'user')
  assert.equal(ledger(repo, 'approved').at(-1).ruled, first.ruled)
})

test('settling twice records one ruled line', () => {
  const repo = changed(editRoot(DECISION_CHANGED))
  const first = settle(repo, '.')
  const again = respecSettle(repo, E, '.', { checkUserBound: true })
  assert.deepEqual([again.status, again.ruled], ['needs_user', first.ruled])
  assert.equal(ledger(repo, 'ruled').length, 1)
})

test('without the option a changed decision is settled by its rulings', () => {
  const out = settle(changed(editRoot(DECISION_CHANGED)), '.', { checkUserBound: false })
  assert.equal(out.status, 'approved', JSON.stringify(out))
  assert.equal(out.by, 'ruling')
})
