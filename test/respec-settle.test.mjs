// test/respec-settle.test.mjs — settling a changed spec goes over the folder's latest ruled line at
// the spec's hash: rulings an older line holds are ruled again as a fresh line, so the line the user
// is shown is the line their approval is checked against.
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
import { respecBrief, respecRefusal, respecSettle } from '../lib/respec.mjs'
import { specPath } from '../lib/store.mjs'

const FIXTURES = fileURLToPath(new URL('./fixtures/compile/', import.meta.url))
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n')
const ROOT = read('root.md')
const API = read('api.md')
const API_CHANGED = API.replace('`load(path)`, then `parse(text)`.', '`load(path)` returns a frozen object.')
const API_CHANGED_AGAIN = API_CHANGED.replace('A loader and a parser', 'A loader, a parser and a validator')
const E = 'e1'

function write(repo, id, text) {
  mkdirSync(dirname(specPath(repo, E, id)), { recursive: true })
  writeFileSync(specPath(repo, E, id), text)
}

/** An effort whose root and api specs are approved and compiled, with api then edited. */
function changed(t) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-respec-settle-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  write(repo, '.', ROOT)
  write(repo, 'api', API)
  for (const id of ['.', 'api']) assert.equal(recordApproval(repo, E, id).ok, true)
  assert.equal(compileEffort(repo, E).ok, true)
  write(repo, 'api', API_CHANGED)
  return repo
}

/** Brief api as it stands and write rulings that rule cli affected, asking `question`, and api unaffected. */
function ruleCliAffected(repo, question) {
  const brief = respecBrief(repo, E, 'api')
  assert.equal(brief.status, 'brief', JSON.stringify(brief))
  writeFileSync(brief.rulings, JSON.stringify({
    rulings: brief.nodes.map((node) => (node === 'cli'
      ? { node, ruling: 'affected', why: 'it mutates what load returns', question, fix: '' }
      : { node, ruling: 'unaffected', why: 'nothing it uses moved', question: '', fix: '' })),
  }))
  return brief
}

const ruledLines = (repo) => readLog(repo, E, 'ledger').entries.filter((l) => l.kind === 'ruled')

/** Rulings A, then B, then A again at one hash, each settled: the third settle's rulings are the first line's. */
function rulingsComeBack(t) {
  const repo = changed(t)
  ruleCliAffected(repo, 'Should the CLI copy the config before it edits it?')
  const first = respecSettle(repo, E, 'api')
  assert.equal(first.status, 'needs_user', JSON.stringify(first))
  ruleCliAffected(repo, 'Should the CLI freeze the config it is given?')
  const second = respecSettle(repo, E, 'api')
  assert.equal(second.status, 'needs_user', JSON.stringify(second))
  assert.ok(second.ruled > first.ruled, JSON.stringify([first.ruled, second.ruled]))
  ruleCliAffected(repo, 'Should the CLI copy the config before it edits it?')
  const third = respecSettle(repo, E, 'api')
  return { repo, first, second, third }
}

test('rulings an older ruled line holds are ruled again as a fresh line while a later line stands', (t) => {
  const { repo, first, second, third } = rulingsComeBack(t)
  assert.equal(third.status, 'needs_user', JSON.stringify(third))
  assert.ok(third.ruled > second.ruled, 'settle names ruled line ' + third.ruled + ', never the older ' + first.ruled)
  const lines = ruledLines(repo)
  assert.equal(lines.length, 3)
  assert.equal(lines.at(-1).seq, third.ruled)
  assert.deepEqual(lines.at(-1).rulings, lines.find((l) => l.seq === first.ruled).rulings)
})

test("the user's approval over the latest ruled line settles, though an older line holds the same rulings", (t) => {
  const { repo, third } = rulingsComeBack(t)
  assert.equal(respecRefusal(repo, E, 'api', third.ruled), null)
  const approved = respecSettle(repo, E, 'api', { userApproved: true, over: third.ruled })
  assert.deepEqual([approved.status, approved.ruled], ['approved', third.ruled], JSON.stringify(approved))
  const approval = readLog(repo, E, 'ledger').entries.filter((l) => l.kind === 'approved').at(-1)
  assert.equal(approval.ruled, third.ruled)
})

test('of two ruled lines at one hash with the same rulings, settle names the later and appends none', (t) => {
  const repo = changed(t)
  ruleCliAffected(repo, 'Should the CLI copy the config before it edits it?')
  assert.equal(respecSettle(repo, E, 'api').status, 'needs_user')
  const { seq: _, kind: __, ...line } = ruledLines(repo)[0]
  assert.equal(append(repo, E, 'ledger', { kind: 'ruled', ...line }).ok, true)
  const later = ruledLines(repo).at(-1).seq

  const out = respecSettle(repo, E, 'api')
  assert.deepEqual([out.status, out.ruled], ['needs_user', later], JSON.stringify(out))
  assert.equal(ruledLines(repo).length, 2)
})

test('a ruled line at an older hash is not used', (t) => {
  const repo = changed(t)
  ruleCliAffected(repo, 'Should the CLI copy the config before it edits it?')
  const old = respecSettle(repo, E, 'api')
  assert.equal(old.status, 'needs_user', JSON.stringify(old))
  write(repo, 'api', API_CHANGED_AGAIN)
  const brief = ruleCliAffected(repo, 'Should the CLI copy the config before it edits it?')
  assert.notEqual(brief.hash, old.hash)

  const out = respecSettle(repo, E, 'api')
  assert.equal(out.status, 'needs_user', JSON.stringify(out))
  assert.ok(out.ruled > old.ruled, JSON.stringify([old.ruled, out.ruled]))
  assert.equal(ruledLines(repo).find((l) => l.seq === out.ruled).hash, brief.hash)
})
