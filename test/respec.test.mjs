// test/respec.test.mjs — a change to a compiled spec: the brief a ruler rules it from, and what
// its rulings settle.
//
// Design: docs/DESIGN.md#a-changed-spec.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { approvalState, recordApproval } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { respecBrief, respecSettle } from '../lib/respec.mjs'
import { specCopyPath, specPath } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'

const CLI = fileURLToPath(new URL('../lib/respec.mjs', import.meta.url))
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

test('the brief holds the change and every node it reaches, and names where the rulings go', () => {
  const repo = changed()
  const brief = respecBrief(repo, E, 'api')
  assert.equal(brief.status, 'brief', JSON.stringify(brief))
  assert.deepEqual(brief.nodes, ['api', 'cli'])
  assert.equal(brief.hash, approvalState(repo, E, 'api').hash)
  const text = readFileSync(brief.brief, 'utf8')
  assert.match(text, /^-`load\(path\)`, then `parse\(text\)`\.$/m)
  assert.match(text, /^\+`load\(path\)` returns a frozen object\.$/m)
  for (const id of brief.nodes) assert.ok(text.includes('### ' + id + '\n'))
  assert.ok(text.includes(brief.rulings) && brief.prompt.includes(brief.brief) && brief.prompt.includes(brief.rulings))
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

  const approved = respecSettle(repo, E, 'api', { userApproved: true })
  assert.deepEqual([approved.status, approved.by], ['approved', 'user'])
  assert.deepEqual(approved.parked, [{ node: 'cli', reason: 'contract_changed' }])
  assert.equal(statusOf(repo, 'cli'), 'parked')
  assert.equal(ledger(repo, 'approved').at(-1).ruled, out.ruled)
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

test('a changed decision reaches the nodes other specs state, and those are ruled by name', () => {
  const repo = changed(null)
  write(repo, '.', ROOT.replace('Unknown keys are an error.', 'Unknown keys are an error, named in the message.'))
  const brief = respecBrief(repo, E, '.')
  assert.deepEqual(brief.nodes, ['.', 'api/types'], 'api and tuning are entries of the root spec itself')
  assert.match(readFileSync(brief.brief, 'utf8'), /Reached because it realises D2, whose text changed\./)
  rule(repo, brief)
  const out = respecSettle(repo, E, '.')
  assert.equal(out.status, 'approved', JSON.stringify(out))
  assert.ok(out.flagged.some((f) => f.node === 'api/types' && f.decision === 'D2'))
})

test('the stops an approval would clear are put to the ruler, and named on the ruled line', () => {
  const repo = changed(API_CHANGED, (r) => {
    event(r, { kind: 'parked', node: 'api/parse', return: 'needs_decision', question: 'which tokenizer?' })
    event(r, { kind: 'escalated', node: 'api/types', reason: 'review_not_converging', detail: 'two rounds' })
  })
  const { brief, out } = ruled(repo, 'api')
  assert.deepEqual(brief.clears, ['api/parse'])
  assert.match(readFileSync(brief.brief, 'utf8'), /^- api\/parse — parked \(needs_decision\): which tokenizer\?$/m)
  assert.deepEqual(out.answered, ['api/parse'])
  assert.deepEqual(ledger(repo, 'ruled').at(-1).clears, [{ node: 'api/parse', status: 'parked', why: 'needs_decision' }])
  assert.equal(statusOf(repo, 'api/types'), 'escalated', 'an escalation on an entry that did not change stands')
})

test('a stopped node that a changed decision revises is put to the ruler as a stop it clears, not called standing', () => {
  const repo = changed(null)
  event(repo, { kind: 'parked', node: 'api/types', return: 'needs_decision', question: 'what type?' })
  write(repo, '.', ROOT.replace('Unknown keys are an error.', 'Unknown keys are an error, named in the message.'))
  const brief = respecBrief(repo, E, '.')
  assert.deepEqual([brief.nodes, brief.standing, brief.clears], [['.'], [], ['api/types']])
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

test('the CLI prints each result under its digest', () => {
  const repo = changed()
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [CLI, ...args, '--repo', repo, '--effort', E, '--folder', 'api'], { encoding: 'utf8' }))
  const brief = run('brief')
  assert.equal(brief.payload_digest, fnv1a(canonical(brief.payload)))
  rule(repo, brief.payload, { api: { ruling: 'affected', why: 'contradicts its Intent', fix: 'say "frozen" in the Intent too' } })
  assert.equal(run('settle').payload.status, 'needs_user')
  assert.equal(run('settle', '--user-approved').payload.status, 'approved')
})
