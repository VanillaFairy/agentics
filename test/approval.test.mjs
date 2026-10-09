// test/approval.test.mjs — approval is a hash on a ledger line, and a folder's approval state is
// derived from the spec on disk and the ledger, never stored.
//
// Design: docs/DESIGN.md#specs-approval-and-compile.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  approvalGate, approvalState, recordApproval, recordCompiled, recordDisposition, recordPreparation,
  recordReviewSkipped, recordReviewed,
} from '../lib/approval.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { hashSpec } from '../lib/spec.mjs'
import { specPath } from '../lib/store.mjs'

const CLI = fileURLToPath(new URL('../lib/approval.mjs', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures/spec/', import.meta.url))
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n')
// The fixture as T06a wrote it still has a blocking question: a draft the Grill has not finished.
const DRAFT = read('root.md')
const BLOCKING = DRAFT.split('\n').find((l) => l.startsWith('- **blocking:**'))
const ROOT = DRAFT.replace(BLOCKING + '\n', '')
const SUB = read('sub.md')
// The spec of `planner-part`, a sub-effort the root spec gives `author: planner`: no Decisions rows.
const PLANNED = SUB.replace(/\| store-layout\.D1 .*\n/, '').replace(', store-layout.D1', '').replace('# Store layout', '# Planner part')
const E = 'e1'
// The user's word for the CLI's approve: a transcript under its own config folder, never the suite's session.
const SESSION = randomUUID()

function effort(files) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-approval-'))
  for (const [id, text] of Object.entries(files)) write(repo, id, text)
  return repo
}
function write(repo, id, text) {
  mkdirSync(dirname(specPath(repo, E, id)), { recursive: true })
  writeFileSync(specPath(repo, E, id), text)
}
const ledger = (repo) => readLog(repo, E, 'ledger').entries
const cli = (...args) => JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }))

test('a folder nobody approved reads none, with the current hash', () => {
  const repo = effort({ '.': ROOT })
  const s = approvalState(repo, E, '.')
  assert.equal(s.state, 'none')
  assert.equal(s.hash, hashSpec(ROOT))
  assert.equal(s.approved_hash, '')
  assert.equal(s.compiled_hash, '')
  assert.deepEqual(s.decisions, [])
})

test('approval appends the spec\'s hash and its decisions, by the user, and the folder reads approved', () => {
  const repo = effort({ '.': ROOT })
  const out = recordApproval(repo, E, '.')
  assert.equal(out.ok, true, out.error)
  assert.equal(out.hash, hashSpec(ROOT))
  assert.ok(Number.isInteger(out.seq))

  const [line] = ledger(repo)
  assert.equal(line.kind, 'approved')
  assert.equal(line.folder, '.')
  assert.equal(line.hash, hashSpec(ROOT))
  assert.equal(line.by, 'user')
  assert.deepEqual(line.decisions.map((d) => d.id), ['D1', 'D2', 'D3'])
  assert.equal(line.decisions[0].text, 'Efforts live in `.agentics/<effort>/`.')

  const s = approvalState(repo, E, '.')
  assert.equal(s.state, 'approved')
  assert.equal(s.approved_hash, s.hash)
  assert.deepEqual(s.decisions, line.decisions)
})

test('an edit after approval reads edited, and approving again reads approved with the new decisions', () => {
  const repo = effort({ '.': ROOT })
  recordApproval(repo, E, '.')
  const edited = ROOT.replace('| D3 | The parser refuses with the file and the line. |', '| D3 | The parser refuses, naming file and line. |')
  write(repo, '.', edited)
  const s = approvalState(repo, E, '.')
  assert.equal(s.state, 'edited')
  assert.equal(s.hash, hashSpec(edited))
  assert.equal(s.approved_hash, hashSpec(ROOT))

  recordApproval(repo, E, '.')
  const again = approvalState(repo, E, '.')
  assert.equal(again.state, 'approved')
  assert.equal(again.decisions.find((d) => d.id === 'D3').text, 'The parser refuses, naming file and line.')
})

test('a spec approved with LF and checked out with CRLF, or saved with a BOM, is still approved', () => {
  const repo = effort({ '.': ROOT })
  recordApproval(repo, E, '.')
  write(repo, '.', ROOT.replace(/\n/g, '\r\n'))
  assert.equal(approvalState(repo, E, '.').state, 'approved')
  write(repo, '.', '﻿' + ROOT.replace(/\n/g, '\r\n'))
  assert.equal(approvalState(repo, E, '.').state, 'approved')
})

test('a spec approved with CRLF reads approved as LF', () => {
  const repo = effort({ '.': ROOT.replace(/\n/g, '\r\n') })
  recordApproval(repo, E, '.')
  write(repo, '.', ROOT)
  assert.equal(approvalState(repo, E, '.').state, 'approved')
})

test('a spec deleted after approval reads edited, with an empty hash', () => {
  const repo = effort({ '.': ROOT })
  recordApproval(repo, E, '.')
  rmSync(specPath(repo, E, '.'))
  const s = approvalState(repo, E, '.')
  assert.equal(s.state, 'edited')
  assert.equal(s.hash, '')
})

test('approval refuses a missing spec and a spec with problems, and writes nothing', () => {
  const missing = effort({})
  assert.equal(recordApproval(missing, E, '.').ok, false)
  assert.deepEqual(ledger(missing), [])

  const broken = effort({ '.': ROOT.replace('| D3 |', '| D3 | only two |\n| D4 |') })
  const out = recordApproval(broken, E, '.')
  assert.equal(out.ok, false)
  assert.match(out.error, /DESIGN\.md/)
  assert.deepEqual(ledger(broken), [])
})

test('approval refuses a spec with an open blocking question, naming it, and writes nothing', () => {
  const repo = effort({ '.': DRAFT })
  const out = recordApproval(repo, E, '.')
  assert.equal(out.ok, false)
  assert.ok(out.error.includes(BLOCKING.replace('- **blocking:** ', '')), out.error)
  assert.deepEqual(ledger(repo), [])
  assert.equal(approvalState(repo, E, '.').state, 'none')

  write(repo, '.', ROOT)
  assert.equal(recordApproval(repo, E, '.').ok, true, 'the question answered, the spec is approvable')
})

test('a review records how much it examined and the ambiguities it raised, at the spec\'s hash', () => {
  const repo = effort({ '.': ROOT })
  const partial = recordReviewed(repo, E, '.', { complete: false, remaining: ['contract-ambiguity', 'growth'] })
  assert.equal(partial.ok, true, partial.error)
  const complete = recordReviewed(repo, E, '.', { complete: true, remaining: [], ambiguities: ['Iaaaaaaaa'] })
  assert.equal(complete.ok, true, complete.error)
  const lines = ledger(repo).filter((l) => l.kind === 'reviewed')
  assert.deepEqual(lines.map((l) => [l.folder, l.hash, l.complete, l.remaining, l.ambiguities]), [
    ['.', hashSpec(ROOT), false, ['contract-ambiguity', 'growth'], []],
    ['.', hashSpec(ROOT), true, [], ['Iaaaaaaaa']],
  ])
  assert.equal(approvalState(repo, E, '.').state, 'none', 'a review approves nothing')

  for (const bad of [
    { complete: 'no', remaining: ['growth'] },
    { complete: false, remaining: [] },
    { complete: true, remaining: ['growth'] },
    { complete: false, remaining: 'growth' },
    { complete: false, remaining: [''] },
    { complete: true, remaining: [], ambiguities: 'Iaaaaaaaa' },
    { complete: true, remaining: [], ambiguities: [''] },
  ]) assert.equal(recordReviewed(repo, E, '.', bad).ok, false, JSON.stringify(bad))
  const noSpec = effort({})
  assert.equal(recordReviewed(noSpec, E, '.', { complete: true, remaining: [] }).ok, false, 'no spec, no review')
  assert.deepEqual(ledger(noSpec), [])
  assert.equal(ledger(repo).length, 2)
})

test('the review gate reads the latest review of the text as it stands, and every ambiguity\'s disposition', () => {
  const repo = effort({ '.': ROOT })
  const unanchored = hashSpec(ROOT) + '#P2'
  const closed = approvalGate(repo, E, '.')
  assert.deepEqual([closed.ratifiable, closed.reviewed, closed.coverage_complete], [false, false, false], 'no review yet')

  recordReviewed(repo, E, '.', { complete: false, remaining: ['growth'] })
  const partial = approvalGate(repo, E, '.')
  assert.deepEqual([partial.ratifiable, partial.coverage_complete, partial.remaining], [false, false, ['growth']])

  recordReviewed(repo, E, '.', { complete: true, remaining: [], ambiguities: ['Iaaaaaaaa', unanchored] })
  const raised = approvalGate(repo, E, '.')
  assert.equal(raised.coverage_complete, true, 'the latest review of this text decides')
  assert.deepEqual(raised.open, ['Iaaaaaaaa', unanchored])
  assert.equal(raised.ratifiable, false)

  recordDisposition(repo, E, 'store-layout', { finding: 'Iaaaaaaaa', outcome: 'incorporated', by: 'user' })
  assert.deepEqual(approvalGate(repo, E, '.').open, ['Iaaaaaaaa', unanchored], 'another folder\'s disposition settles nothing here')

  recordDisposition(repo, E, '.', { finding: 'Iaaaaaaaa', outcome: 'incorporated', by: 'user' })
  recordDisposition(repo, E, '.', { finding: unanchored, outcome: 'discarded', by: 'user' })
  const open = approvalGate(repo, E, '.')
  assert.deepEqual(open.open, ['Iaaaaaaaa'], 'an incorporated ambiguity waits for a later round to rule its section clean')
  assert.equal(open.ratifiable, false)
})

test('an edit closes the gate until a review reads the new text; an earlier disposition still settles a carried ambiguity', () => {
  const repo = effort({ '.': ROOT })
  recordReviewed(repo, E, '.', { complete: true, remaining: [], ambiguities: ['Iaaaaaaaa'] })
  recordDisposition(repo, E, '.', { finding: 'Iaaaaaaaa', outcome: 'discarded', by: 'user' })
  assert.equal(approvalGate(repo, E, '.').ratifiable, true)

  write(repo, '.', ROOT.replace('Local, and writable', 'Local and writable'))
  const edited = approvalGate(repo, E, '.')
  assert.deepEqual([edited.ratifiable, edited.reviewed], [false, false], 'no review has read the edited text')

  recordReviewed(repo, E, '.', { complete: true, remaining: [], ambiguities: ['Iaaaaaaaa', 'Ibbbbbbbb'] })
  assert.deepEqual(approvalGate(repo, E, '.').open, ['Ibbbbbbbb'], 'the carried one was settled a round ago')
  recordDisposition(repo, E, '.', { finding: 'Ibbbbbbbb', outcome: 'discarded', by: 'user' })
  assert.equal(approvalGate(repo, E, '.').ratifiable, true)
})

test('a planner-written spec is prepared against the review it passed, and reads prepared', () => {
  const repo = effort({ '.': ROOT, 'planner-part': PLANNED })
  const out = recordPreparation(repo, E, 'planner-part', { review: 'probe-20260926-120000.json' })
  assert.equal(out.ok, true, out.error)
  const line = ledger(repo).find((l) => l.kind === 'prepared')
  assert.equal(line.folder, 'planner-part')
  assert.equal(line.hash, hashSpec(PLANNED))
  assert.equal(line.review, 'probe-20260926-120000.json')
  assert.equal(line.by, 'planner')

  const s = approvalState(repo, E, 'planner-part')
  assert.equal(s.state, 'prepared')
  assert.equal(s.approved_hash, hashSpec(PLANNED))
  assert.deepEqual(s.decisions, [], 'a prepared spec states no decisions')
})

test('preparation refuses a folder the user authors, a missing review, and a spec with problems', () => {
  const repo = effort({ '.': ROOT, 'store-layout': SUB, 'planner-part': PLANNED })
  assert.equal(recordPreparation(repo, E, 'store-layout', { review: 'r.json' }).ok, false, 'author: you is approved, never prepared')
  assert.equal(recordPreparation(repo, E, '.', { review: 'r.json' }).ok, false, 'the root is the user\'s')
  assert.equal(recordPreparation(repo, E, 'planner-part', { review: '' }).ok, false)
  write(repo, 'planner-part', SUB.replace(/store-layout\./g, 'planner-part.'))
  assert.equal(recordPreparation(repo, E, 'planner-part', { review: 'r.json' }).ok, false, 'a planner spec with a Decisions row')
  assert.deepEqual(ledger(repo), [])
})

test('the latest approved or prepared line decides, by seq', () => {
  const repo = effort({ '.': ROOT, 'planner-part': PLANNED })
  recordPreparation(repo, E, 'planner-part', { review: 'r.json' })
  recordApproval(repo, E, 'planner-part')
  assert.equal(approvalState(repo, E, 'planner-part').state, 'approved', 'the user may approve a planner-written spec')
  recordPreparation(repo, E, 'planner-part', { review: 'r2.json' })
  assert.equal(approvalState(repo, E, 'planner-part').state, 'prepared')
})

test('folders are independent: one folder\'s lines never approve another', () => {
  const repo = effort({ '.': ROOT, 'store-layout': SUB })
  recordApproval(repo, E, 'store-layout')
  assert.equal(approvalState(repo, E, '.').state, 'none')
  assert.equal(approvalState(repo, E, 'store-layout').state, 'approved')
})

test('compiled records the hash compile built from', () => {
  const repo = effort({ '.': ROOT })
  recordApproval(repo, E, '.')
  const out = recordCompiled(repo, E, '.', hashSpec(ROOT))
  assert.equal(out.ok, true, out.error)
  assert.equal(approvalState(repo, E, '.').compiled_hash, hashSpec(ROOT))
  const line = ledger(repo).find((l) => l.kind === 'compiled')
  assert.equal(line.folder, '.')
  assert.equal(line.hash, hashSpec(ROOT))
})

test('a disposition records the finding and how it was settled; a bad one is refused', () => {
  const repo = effort({ '.': ROOT })
  const out = recordDisposition(repo, E, '.', { finding: 'P3', outcome: 'incorporated', by: 'user' })
  assert.equal(out.ok, true, out.error)
  const line = ledger(repo).find((l) => l.kind === 'disposition')
  assert.equal(line.folder, '.')
  assert.equal(line.finding, 'P3')
  assert.equal(line.outcome, 'incorporated')
  assert.equal(line.by, 'user')

  for (const bad of [
    { finding: '', outcome: 'discarded', by: 'user' },
    { finding: 'P1', outcome: 'ignored', by: 'user' },
    { finding: 'P1', outcome: 'discarded', by: 'session' },
  ]) assert.equal(recordDisposition(repo, E, '.', bad).ok, false, JSON.stringify(bad))
  assert.equal(ledger(repo).length, 1)
})

test('a skipped review records its reason and the hash it was skipped at', () => {
  const repo = effort({ '.': ROOT })
  const out = recordReviewSkipped(repo, E, '.', 'short, and no contract other entries consume')
  assert.equal(out.ok, true, out.error)
  const line = ledger(repo).find((l) => l.kind === 'review_skipped')
  assert.equal(line.hash, hashSpec(ROOT))
  assert.match(line.reason, /no contract/)
  assert.equal(recordReviewSkipped(repo, E, '.', '').ok, false)
  assert.equal(ledger(repo).length, 1)
})

test('writers refuse an effort name or folder id that breaks the segment rule', () => {
  const repo = effort({ '.': ROOT })
  assert.equal(recordApproval(repo, 'Bad_Effort', '.').ok, false)
  assert.equal(recordApproval(repo, E, 'Store_Layout').ok, false)
  assert.equal(recordCompiled(repo, E, '../x', 'abc').ok, false)
  assert.deepEqual(ledger(repo), [])
})

test('the ledger shares the effort\'s one seq counter', () => {
  const repo = effort({ '.': ROOT })
  const event = append(repo, E, 'events', { kind: 'planned', node: '.' })
  const out = recordApproval(repo, E, '.')
  assert.equal(out.seq, event.seqs[0] + 1)
  assert.equal(append(repo, E, 'cites', { kind: 'cites', folder: '.', items: [] }).ok, true, 'cites is an effort log too')
})

/** The env of a session whose transcript answers `answer` to a question holding `token`. */
function answered(t, token, answer) {
  const config = mkdtempSync(join(tmpdir(), 'agentics-approval-config-'))
  t.after(() => rmSync(config, { recursive: true, force: true }))
  const question = '1/1. Approve the spec? ' + token
  mkdirSync(join(config, 'projects', 'p'), { recursive: true })
  writeFileSync(join(config, 'projects', 'p', SESSION + '.jsonl'), JSON.stringify({
    type: 'user', toolUseResult: { questions: [{ question }], answers: { [question]: answer } },
  }) + '\n')
  const env = { ...process.env, NODE_TEST_CONTEXT: '' }
  delete env.CLAUDE_CODE_SESSION_ID
  delete env.CLAUDE_CONFIG_DIR
  return { ...env, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CONFIG_DIR: config }
}

test('the CLI approves and reads state under its digest', (t) => {
  const repo = effort({ '.': ROOT })
  const env = answered(t, approvalState(repo, E, '.').token, 'Approve')
  const approved = JSON.parse(execFileSync(process.execPath, [CLI, 'approve', '--repo', repo, '--effort', E, '--folder', '.'], {
    encoding: 'utf8', env, input: '',
  }))
  assert.equal(approved.payload.ok, true)
  assert.equal(approved.payload_digest, fnv1a(canonical(approved.payload)))
  const state = cli('state', '--repo', repo, '--effort', E, '--folder', '.')
  assert.equal(state.payload.state, 'approved')
  const disposed = cli('dispose', '--repo', repo, '--effort', E, '--folder', '.', '--finding', 'P1', '--outcome', 'discarded', '--by', 'user')
  assert.equal(disposed.payload.ok, true)
  const skipped = cli('skip-review', '--repo', repo, '--effort', E, '--folder', '.', '--reason', 'not earned')
  assert.equal(skipped.payload.ok, true)
  const partial = cli('reviewed', '--repo', repo, '--effort', E, '--folder', '.', '--complete', 'false', '--remaining', 'growth,yagni')
  assert.equal(partial.payload.ok, true)
  const whole = cli('reviewed', '--repo', repo, '--effort', E, '--folder', '.', '--complete', 'true', '--remaining', '', '--ambiguities', 'Iaaaaaaaa,Ibbbbbbbb')
  assert.equal(whole.payload.ok, true)
  assert.deepEqual(ledger(repo).filter((l) => l.kind === 'reviewed').map((l) => [l.complete, l.remaining, l.ambiguities]),
    [[false, ['growth', 'yagni'], []], [true, [], ['Iaaaaaaaa', 'Ibbbbbbbb']]])
  const gate = cli('gate', '--repo', repo, '--effort', E, '--folder', '.')
  assert.deepEqual([gate.payload.ratifiable, gate.payload.open], [false, ['Iaaaaaaaa', 'Ibbbbbbbb']])
})
