// test/respec.test.mjs — a change to a compiled spec: the brief a ruler rules it from, with the
// user's answers and the choices of theirs the change makes as units of their own, and what its
// rulings settle: approval by ruling or by answer, a park an answer settled by code, and the nodes
// compile spares.
//
// Design: docs/DESIGN.md#a-changed-spec.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { approvalState, recordApproval } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { respecBrief, respecSettle } from '../lib/respec.mjs'
import { specCopyPath, specPath } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'

const FIXTURES = fileURLToPath(new URL('./fixtures/compile/', import.meta.url))
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n')
const ROOT = read('root.md')
const API = read('api.md')
const API_CHANGED = API.replace('`load(path)`, then `parse(text)`.', '`load(path)` returns a frozen object.')
const E = 'e1'
const X = '20260926-120000'

function write(repo, id, text) {
  mkdirSync(dirname(specPath(repo, E, id)), { recursive: true })
  writeFileSync(specPath(repo, E, id), text)
}

/** An effort whose root and api specs are approved and compiled; `then` runs before api is edited. */
function changed(text = API_CHANGED, then = () => {}) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-respec-'))
  write(repo, '.', ROOT)
  write(repo, 'api', API)
  for (const id of ['.', 'api']) assert.equal(recordApproval(repo, E, id).ok, true)
  assert.equal(compileEffort(repo, E).ok, true)
  then(repo)
  if (text !== null) write(repo, 'api', text)
  return repo
}

const event = (repo, e) => assert.equal(append(repo, E, 'events', { execution: X, ...e }).ok, true)
const rule = (repo, brief, rulings = {}) => writeFileSync(brief.rulings, JSON.stringify({
  rulings: brief.nodes.map((node) => ({ node, ruling: 'unaffected', why: 'nothing it uses moved', question: '', fix: '', ...(rulings[node] || {}) })),
}))
/** Brief the folder, write its rulings, settle. */
function ruled(repo, folder, rulings, opts) {
  const brief = respecBrief(repo, E, folder)
  assert.equal(brief.status, 'brief', JSON.stringify(brief))
  rule(repo, brief, rulings)
  return { brief, out: respecSettle(repo, E, folder, opts) }
}
const ledger = (repo, kind) => readLog(repo, E, 'ledger').entries.filter((l) => l.kind === kind)
const statusOf = (repo, id) => readTree(repo, E).status.get(id).status
const eventsOf = (repo, id) => readTree(repo, E).events.filter((e) => e.node === id).map((e) => e.kind)
/** The user answers `words` about `nodes` after everything on the ledger so far; the seq of the `answered` line. */
function answer(repo, nodes, words = 'Yes, as the spec now states it.') {
  const asked = append(repo, E, 'ledger', { kind: 'asked', nodes })
  const out = append(repo, E, 'ledger', { kind: 'answered', asked: asked.seqs[0], nodes, answers: [{ question: 'Is that what you want?', answer: words }], by: 'user' })
  assert.equal(out.ok, true, JSON.stringify(out))
  return out.seqs[0]
}
const ROOT_D2 = ROOT.replace('Unknown keys are an error.', 'Unknown keys are an error, named in the message.')
const sizes = (repo) => ['nodes', 'events', 'ledger'].map((f) => readLog(repo, E, f).entries.length)

test('compile keeps the text it built each folder from, by hash', () => {
  const repo = changed(null)
  for (const id of ['.', 'api']) {
    const st = approvalState(repo, E, id)
    assert.equal(readFileSync(specCopyPath(repo, E, id, st.hash), 'utf8'), readFileSync(specPath(repo, E, id), 'utf8'))
  }
})

test('a compile preview says what approving the edited spec would do, and writes nothing', () => {
  const repo = changed()
  const before = sizes(repo)
  const preview = compileEffort(repo, E, { folder: 'api', preview: 'api' })
  assert.equal(preview.ok, true, JSON.stringify(preview.problems))
  assert.deepEqual(preview.parked, [{ node: 'cli', reason: 'contract_changed' }])
  assert.deepEqual(preview.consumers, [{ node: 'cli', contract: 'config-api' }])
  assert.deepEqual(sizes(repo), before)
  assert.equal(approvalState(repo, E, 'api').state, 'edited')

  assert.equal(recordApproval(repo, E, 'api').ok, true)
  assert.deepEqual(compileEffort(repo, E, { folder: 'api' }).parked, preview.parked, 'the real compile parks what the preview said')
})

test('the brief holds the change and every node it reaches, and names no file to write', () => {
  const repo = changed()
  const brief = respecBrief(repo, E, 'api')
  assert.equal(brief.status, 'brief', JSON.stringify(brief))
  assert.deepEqual(brief.nodes, ['api', 'cli'])
  assert.equal(brief.hash, approvalState(repo, E, 'api').hash)
  const text = readFileSync(brief.brief, 'utf8')
  assert.match(text, /^-`load\(path\)`, then `parse\(text\)`\.$/m)
  assert.match(text, /^\+`load\(path\)` returns a frozen object\.$/m)
  for (const id of brief.nodes) assert.ok(text.includes('### ' + id + '\n'))
  assert.equal(text, brief.text, 'the brief file holds the text returned')
  assert.ok(!Object.hasOwn(brief, 'prompt'), 'the brief has no prompt pointing at files')
  assert.ok(!text.includes(brief.rulings), "the rulings come back as the ruler's return, not through a file")
})

test('a change every node is ruled unaffected by is approved by that ruling, and no node it reaches is stopped', () => {
  const repo = changed(API_CHANGED, (r) => event(r, { kind: 'dispatched', node: 'cli', role: 'implementer', round: 1 }))
  const { brief, out } = ruled(repo, 'api')
  assert.equal(out.status, 'approved', JSON.stringify(out))
  assert.equal(out.by, 'ruling')
  assert.deepEqual(out.spared, [{ node: 'cli', reason: 'contract_changed' }])
  assert.deepEqual(out.parked, [])

  const st = approvalState(repo, E, 'api')
  assert.deepEqual([st.state, st.compiled_hash], ['approved', brief.hash])
  assert.equal(statusOf(repo, 'cli'), 'active', 'its dispatch stands: nothing was written about it')
  assert.deepEqual(eventsOf(repo, 'cli'), ['planned', 'dispatched'])
  assert.ok(existsSync(specCopyPath(repo, E, 'api', brief.hash)))

  // The trail: the ruling, and the approval that names it.
  const [line] = ledger(repo, 'ruled')
  assert.deepEqual([line.folder, line.hash, line.basis, line.by, line.rulings.map((r) => [r.node, r.ruling])],
    ['api', brief.hash, brief.basis, 'ruler', [['api', 'unaffected'], ['cli', 'unaffected']]])
  const approval = ledger(repo, 'approved').at(-1)
  assert.deepEqual([approval.folder, approval.by, approval.ruled], ['api', 'ruling', line.seq])
})

test('a change some node is ruled affected by goes to the user, approved by nobody', () => {
  const repo = changed()
  const { out } = ruled(repo, 'api', { cli: { ruling: 'affected', why: 'it mutates what load returns', question: 'Should the CLI copy the config before it edits it?' } })
  assert.equal(out.status, 'needs_user')
  assert.deepEqual(out.affected.map((a) => [a.node, a.question]), [['cli', 'Should the CLI copy the config before it edits it?']])
  assert.equal(approvalState(repo, E, 'api').state, 'edited')
  assert.equal(respecSettle(repo, E, 'api').ruled, out.ruled)
  assert.equal(ledger(repo, 'ruled').length, 1, 'the same rulings are recorded once')

  assert.equal(ledger(repo, 'approved').filter((l) => l.folder === 'api').length, 1, 'only the first approval stands')
})

test('rulings that change are a new ruled line, and an approval names the one it rests on', () => {
  const repo = changed()
  const { brief, out: first } = ruled(repo, 'api', { cli: { ruling: 'affected', why: 'moved', question: 'copy it?' } })
  rule(repo, brief)
  const out = respecSettle(repo, E, 'api')
  assert.equal(out.status, 'approved')
  assert.notEqual(out.ruled, first.ruled)
  const line = ledger(repo, 'ruled').find((l) => l.seq === out.ruled)
  assert.deepEqual(line.rulings.map((r) => r.ruling), ['unaffected', 'unaffected'])
  assert.equal(ledger(repo, 'approved').at(-1).ruled, out.ruled)
})

test('work dispatched under the changed spec stands when the spec is ruled unaffected', () => {
  const repo = changed(API_CHANGED, (r) => event(r, { kind: 'dispatched', node: 'api/parse', role: 'implementer', round: 1 }))
  const { brief, out } = ruled(repo, 'api')
  assert.match(readFileSync(brief.brief, 'utf8'), /^- api\/parse — active — its entry is unchanged — .*DESIGN\.md:\d+$/m)
  assert.deepEqual(out.spared.map((p) => [p.node, p.reason]).sort(), [['api', 'spec_changed'], ['cli', 'contract_changed']])
  assert.equal(statusOf(repo, 'api/parse'), 'active')
  assert.ok(!eventsOf(repo, 'api').includes('parked'))
})

test('a second change to the same spec rules its consumers again', () => {
  const repo = changed()
  assert.equal(ruled(repo, 'api').out.status, 'approved')
  write(repo, 'api', API_CHANGED.replace('A loader and a parser', 'A loader, a parser and a validator'))
  assert.deepEqual(respecBrief(repo, E, 'api').nodes, ['api', 'cli'])
})

test('a consumer whose work has merged is still ruled', () => {
  const repo = changed(API_CHANGED, (r) => event(r, { kind: 'merged', node: 'cli', into: 'agentics/e1', merged_sha: 'def', head_sha: 'abc' }))
  const brief = respecBrief(repo, E, 'api')
  assert.deepEqual(brief.nodes, ['api', 'cli'])
  rule(repo, brief, { cli: { ruling: 'affected', why: 'built on the mutable object', question: 'Reopen the CLI?' } })
  assert.equal(respecSettle(repo, E, 'api').status, 'needs_user')
})

test('a changed decision reaches the nodes other specs state, which are ruled by name, and is a unit of the user\'s own', () => {
  const repo = changed(null)
  write(repo, '.', ROOT_D2)
  const first = respecBrief(repo, E, '.')
  assert.deepEqual(first.nodes, ['.', 'api/types', 'decision:D2'], 'api and tuning are entries of the root spec itself')
  assert.match(readFileSync(first.brief, 'utf8'), /Reached because it realises D2, whose text changed\./)
  assert.deepEqual(first.parts.choices, [{ unit: 'decision:D2', why: 'changes decision D2' }])

  const seq = answer(repo, ['api'])
  const brief = respecBrief(repo, E, '.')
  rule(repo, brief, { 'decision:D2': { ruling: 'answered', answers: [seq] } })
  const out = respecSettle(repo, E, '.')
  assert.deepEqual([out.status, out.by], ['approved', 'answer'], JSON.stringify(out))
  assert.ok(out.flagged.some((f) => f.node === 'api/types' && f.decision === 'D2'))
})

test('a stop an approval would clear that is no choice of the user is put to the ruler and named on the ruled line', () => {
  const repo = changed(API_CHANGED, (r) => {
    event(r, { kind: 'escalated', node: 'api/types', reason: 'review_not_converging', detail: 'two rounds' })
    event(r, { kind: 'parked', node: 'api/parse', return: 'needs_info', question: 'which tokenizer?' })
  })
  const { brief, out } = ruled(repo, 'api')
  assert.deepEqual(brief.clears, ['api/parse'])
  assert.deepEqual(brief.nodes, ['api', 'cli'], 'a park that is no decision or contract is no unit of its own')
  assert.match(readFileSync(brief.brief, 'utf8'), /^- api\/parse — parked \(needs_info\): which tokenizer\?$/m)
  assert.deepEqual(out.answered, ['api/parse'])
  assert.deepEqual(ledger(repo, 'ruled').at(-1).clears, [{ node: 'api/parse', status: 'parked', why: 'needs_info' }])
  assert.equal(statusOf(repo, 'api/types'), 'escalated', 'an escalation on an entry that did not change stands')
})

for (const why of ['needs_decision', 'contract_changed']) {
  test(`a ${why} park the change clears is a unit of the user's, settled only by a ruling that cites their answer`, () => {
    const repo = changed(API_CHANGED, (r) => event(r, { kind: 'parked', node: 'api/parse', return: why, question: 'which tokenizer?' }))
    const unit = 'park:api/parse'
    const open = respecBrief(repo, E, 'api')
    assert.deepEqual(open.nodes, ['api', 'cli', unit])
    rule(repo, open)
    assert.match(respecSettle(repo, E, 'api').why, /park:api\/parse is a choice of the user's/, 'ruled unaffected, it goes back to the ruler')

    const seq = answer(repo, ['api/parse'], 'Use the streaming tokenizer.')
    const settled = respecBrief(repo, E, 'api')
    assert.deepEqual(settled.nodes, ['api', 'cli', unit], 'an answer naming the node is ruled on, never taken on its word')
    assert.deepEqual(settled.parts.answers.map((a) => [a.seq, a.nodes]), [[seq, ['api/parse']]])
    rule(repo, settled, { [unit]: { ruling: 'answered', why: 'the user chose the streaming tokenizer', answers: [seq] } })
    const out = respecSettle(repo, E, 'api')
    assert.deepEqual([out.status, out.by, out.answered], ['approved', 'answer', ['api/parse']], JSON.stringify(out))
    assert.deepEqual(ledger(repo, 'ruled').at(-1).answers, [seq])
    assert.deepEqual(ledger(repo, 'approved').at(-1).answers, [seq])
  })
}

test('of a question answered twice, only the later answer is in the brief and may be cited', () => {
  const repo = changed(API_CHANGED)
  const asked = append(repo, E, 'ledger', { kind: 'asked', nodes: [] }).seqs[0]
  const answered = (words) => append(repo, E, 'ledger', { kind: 'answered', asked, nodes: [], answers: [{ question: 'q', answer: words }], by: 'user' }).seqs[0]
  const first = answered('Postgres')
  const second = answered('SQLite')
  const brief = respecBrief(repo, E, 'api')
  assert.deepEqual(brief.parts.answers.map((a) => a.seq), [second])
  rule(repo, brief, { api: { ruling: 'answered', why: 'the user chose it', answers: [first] } })
  assert.equal(respecSettle(repo, E, 'api').next, 'rule_it')
})

test('a stopped node that a changed decision revises is put to the ruler as a stop it clears, not called standing', () => {
  const repo = changed(null)
  event(repo, { kind: 'parked', node: 'api/types', return: 'needs_decision', question: 'what type?' })
  write(repo, '.', ROOT_D2)
  const brief = respecBrief(repo, E, '.')
  assert.deepEqual([brief.nodes, brief.standing, brief.clears], [['.', 'decision:D2', 'park:api/types'], [], ['api/types']])
  assert.match(readFileSync(brief.brief, 'utf8'), /^- api\/types — parked \(needs_decision\): what type\?$/m)
})

test('a node that already waits on the user is not ruled, and its stop stands', () => {
  const repo = changed(API_CHANGED, (r) => event(r, { kind: 'parked', node: 'cli', return: 'needs_decision', question: 'which loader?' }))
  const brief = respecBrief(repo, E, 'api')
  assert.deepEqual([brief.nodes, brief.standing], [['api'], ['cli']])
  rule(repo, brief)
  assert.equal(respecSettle(repo, E, 'api').status, 'approved')
  assert.equal(statusOf(repo, 'cli'), 'parked')
})

test('rulings bind to what the brief showed: when that moves on there is nothing to settle from', () => {
  const repo = changed()
  const brief = respecBrief(repo, E, 'api')
  rule(repo, brief)
  write(repo, '.', ROOT.replace('Read configs from the command line', 'Read and rewrite configs from the command line'))
  assert.equal(recordApproval(repo, E, '.').ok, true)
  assert.equal(compileEffort(repo, E, { folder: '.' }).ok, true)
  const out = respecSettle(repo, E, 'api')
  assert.deepEqual([out.status, out.next], ['refused', 'rule_it'])
  assert.notEqual(respecBrief(repo, E, 'api').basis, brief.basis)
  assert.equal(ledger(repo, 'ruled').length, 0)

  const edited = changed()
  rule(edited, respecBrief(edited, E, 'api'))
  write(edited, 'api', API_CHANGED.replace('A loader and a parser', 'A loader, a parser and a validator'))
  assert.equal(respecSettle(edited, E, 'api').next, 'rule_it', 'the text itself moved on')
})

test('what cannot be ruled is refused with what to do next', () => {
  const next = (repo, folder) => respecBrief(repo, E, folder).next
  assert.equal(next(changed(null), 'api'), 'nothing')

  const unapproved = mkdtempSync(join(tmpdir(), 'agentics-respec-'))
  write(unapproved, '.', ROOT)
  assert.equal(next(unapproved, '.'), 'user_approves')
  assert.equal(next(unapproved, 'api'), 'fix_spec')

  const uncompiled = mkdtempSync(join(tmpdir(), 'agentics-respec-'))
  write(uncompiled, '.', ROOT)
  assert.equal(recordApproval(uncompiled, E, '.').ok, true)
  write(uncompiled, '.', ROOT.replace('Nothing else changes.', 'Nothing else moves.'))
  assert.equal(next(uncompiled, '.'), 'user_approves')

  const uncopied = changed()
  rmSync(specCopyPath(uncopied, E, 'api', approvalState(uncopied, E, 'api').compiled_hash))
  assert.equal(next(uncopied, 'api'), 'user_approves')

  const broken = respecBrief(changed(API_CHANGED.replace('rigor: trivial', 'rigor: heroic')), E, 'api')
  assert.equal(broken.next, 'fix_spec')
  assert.ok(broken.problems.length > 0)

  const both = changed()
  write(both, '.', ROOT.replace('Nothing else changes.', 'Nothing else moves.'))
  assert.equal(next(both, 'api'), 'rule_parent_first')
})

test('rulings are taken only whole', () => {
  const repo = changed()
  const brief = respecBrief(repo, E, 'api')
  assert.equal(respecSettle(repo, E, 'api').next, 'rule_it')

  writeFileSync(brief.rulings, JSON.stringify({ rulings: [{ node: 'api', ruling: 'unaffected', why: 'fine' }] }))
  assert.match(respecSettle(repo, E, 'api').why, /exactly one ruling is needed for cli/)
  rule(repo, brief, { cli: { ruling: 'affected', why: 'moved' } })
  assert.match(respecSettle(repo, E, 'api').why, /neither a question nor a fix/)
  writeFileSync(brief.rulings, JSON.stringify({ rulings: ['api', 'cli', 'reload'].map((node) => ({ node, ruling: 'unaffected', why: 'fine' })) }))
  assert.match(respecSettle(repo, E, 'api').why, /nodes the brief did not give: reload/)
  assert.equal(ledger(repo, 'ruled').length, 0)
  assert.equal(approvalState(repo, E, 'api').state, 'edited')
})

test('an approval recorded on a ruling and not yet compiled is compiled by the next settle, and by any compile', () => {
  for (const finish of [(r) => respecSettle(r, E, 'api'), (r) => compileEffort(r, E, { folder: 'api' })]) {
    const repo = changed()
    const brief = respecBrief(repo, E, 'api')
    const line = append(repo, E, 'ledger', {
      kind: 'ruled', folder: 'api', hash: brief.hash, from: brief.from, basis: brief.basis, standing: [], clears: [], brief: brief.brief, by: 'ruler',
      rulings: brief.nodes.map((node) => ({ node, ruling: 'unaffected', why: 'fine', question: '', fix: '' })),
    })
    assert.equal(recordApproval(repo, E, 'api', { by: 'ruling', ruled: line.seqs[0] }).ok, true)
    const out = finish(repo)
    assert.deepEqual(out.spared, [{ node: 'cli', reason: 'contract_changed' }], JSON.stringify(out))
    assert.deepEqual(out.parked, [])
    assert.equal(approvalState(repo, E, 'api').compiled_hash, brief.hash)
  }
  assert.equal(recordApproval(changed(), E, 'api', { by: 'ruling' }).ok, false, 'an approval by ruling names its ruling')
})

test('a changed decision no answer settles is never approved by ruling: unaffected is refused, affected goes to the user', () => {
  const repo = changed(null)
  write(repo, '.', ROOT_D2)
  const brief = respecBrief(repo, E, '.')
  rule(repo, brief)
  const refused = respecSettle(repo, E, '.')
  assert.deepEqual([refused.status, refused.next], ['refused', 'rule_it'])
  assert.match(refused.why, /decision:D2 is a choice of the user's/)
  assert.equal(ledger(repo, 'ruled').length, 0)

  rule(repo, brief, { 'decision:D2': { ruling: 'affected', why: 'the message wording is the user\'s', question: 'Should the error name the key?' } })
  const out = respecSettle(repo, E, '.')
  assert.equal(out.status, 'needs_user', JSON.stringify(out))
  assert.deepEqual(out.affected.map((a) => [a.node, a.question]), [['decision:D2', 'Should the error name the key?']])
  assert.equal(approvalState(repo, E, '.').state, 'edited')
  assert.equal(ledger(repo, 'approved').filter((l) => l.by === 'ruling' || l.by === 'answer').length, 0, 'nothing is approved')
})

test('an answered ruling cites one or more of the answers the brief held', () => {
  const repo = changed()
  const seq = answer(repo, ['cli'])
  const brief = respecBrief(repo, E, 'api')
  for (const answers of [[], [seq + 50], [seq, seq + 50]]) {
    rule(repo, brief, { cli: { ruling: 'answered', answers } })
    const out = respecSettle(repo, E, 'api')
    assert.deepEqual([out.status, out.next], ['refused', 'rule_it'], JSON.stringify(answers))
    assert.match(out.why, /cli is ruled answered/)
  }
  assert.equal(ledger(repo, 'ruled').length, 0)
})

test('a node ruled answered is spared the parks a re-approval raises, as one ruled unaffected is', () => {
  const dispatched = (r) => event(r, { kind: 'dispatched', node: 'cli', role: 'implementer', round: 1 })
  const unaffected = ruled(changed(API_CHANGED, dispatched), 'api').out

  const repo = changed(API_CHANGED, dispatched)
  const seq = answer(repo, ['cli'])
  const { out } = ruled(repo, 'api', { cli: { ruling: 'answered', answers: [seq] } })
  assert.deepEqual([out.status, out.by], ['approved', 'answer'], JSON.stringify(out))
  assert.deepEqual([out.spared, out.parked], [unaffected.spared, unaffected.parked])
  assert.deepEqual(out.spared, [{ node: 'cli', reason: 'contract_changed' }])
  assert.equal(statusOf(repo, 'cli'), 'active', 'its dispatch stands')
  assert.deepEqual(ledger(repo, 'approved').at(-1).answers, [seq])
})
