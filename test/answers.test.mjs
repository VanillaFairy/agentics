// test/answers.test.mjs — a question opened with a token, and the user's answer to it recorded in
// their own words on the effort's ledger.
//
// Design: docs/DESIGN.md#the-users-word.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { answersSince, answerToken, openQuestion, recordAnswer } from '../lib/answers.mjs'
import { recordApproval } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { readLog } from '../lib/ledger.mjs'
import { specPath } from '../lib/store.mjs'

const FIXTURES = fileURLToPath(new URL('./fixtures/compile/', import.meta.url))
const ROOT = readFileSync(join(FIXTURES, 'root.md'), 'utf8')
const E = 'e1'

function effort(t) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-answers-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  mkdirSync(dirname(specPath(repo, E, '.')), { recursive: true })
  writeFileSync(specPath(repo, E, '.'), ROOT)
  assert.equal(recordApproval(repo, E, '.').ok, true)
  assert.equal(compileEffort(repo, E).ok, true)
  return repo
}

/** A session whose transcript holds `lines` (AskUserQuestion results), and the lookup that reads it. */
function session(t, ...batches) {
  const config = mkdtempSync(join(tmpdir(), 'agentics-answers-session-'))
  t.after(() => rmSync(config, { recursive: true, force: true }))
  const id = randomUUID()
  mkdirSync(join(config, 'projects', 'p'), { recursive: true })
  const lines = batches.map((answers) => JSON.stringify({
    type: 'user', toolUseResult: { questions: Object.keys(answers).map((question) => ({ question })), answers },
  }))
  writeFileSync(join(config, 'projects', 'p', id + '.jsonl'), lines.join('\n') + '\n')
  return { env: { CLAUDE_CODE_SESSION_ID: id, CLAUDE_CONFIG_DIR: config } }
}

const lines = (repo, kind) => readLog(repo, E, 'ledger').entries.filter((l) => l.kind === kind)

test('a question is opened on the ledger with the nodes it settles, and its token names that line', (t) => {
  const repo = effort(t)
  const opened = openQuestion(repo, E, { nodes: ['api', 'api'] })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  assert.equal(opened.token, answerToken(E, opened.asked))
  const asked = lines(repo, 'asked')
  assert.deepEqual(asked.map((l) => [l.seq, l.nodes]), [[opened.asked, ['api']]])
})

test('a question about a node the effort does not hold is refused, and nothing is opened', (t) => {
  const repo = effort(t)
  const out = openQuestion(repo, E, { nodes: ['nowhere'] })
  assert.equal(out.error.kind, 'unknown_node')
  assert.deepEqual(lines(repo, 'asked'), [])
})

test("the user's answer is recorded in their own words, with the nodes its question named", async (t) => {
  const repo = effort(t)
  const { asked, token } = openQuestion(repo, E, { nodes: ['api'] })
  const words = 'Let it throw, and log it at the call site'
  const out = await recordAnswer(repo, E, asked, session(t, { ['1/1 ' + token + ' What should Sow do?']: words }))
  assert.equal(out.ok, true, JSON.stringify(out))
  const [line] = lines(repo, 'answered')
  assert.deepEqual([line.seq, line.asked, line.nodes, line.answers, line.by],
    [out.answered, asked, ['api'], [{ question: '1/1 ' + token + ' What should Sow do?', answer: words }], 'user'])
})

test('the same batch recorded twice appends one line; the question asked again appends another, even with the same words', async (t) => {
  const repo = effort(t)
  const { asked, token } = openQuestion(repo, E)
  const first = session(t, { [token + ' q']: 'a' })
  const one = await recordAnswer(repo, E, asked, first)
  const again = await recordAnswer(repo, E, asked, first)
  assert.equal(again.answered, one.answered)
  const changed = await recordAnswer(repo, E, asked, session(t, { [token + ' q']: 'a' }, { [token + ' q']: 'b' }))
  const repeated = await recordAnswer(repo, E, asked, session(t, { [token + ' q']: 'a' }, { [token + ' q']: 'b' }, { [token + ' q']: 'b' }))
  assert.equal(new Set([one.answered, changed.answered, repeated.answered]).size, 3)
  assert.deepEqual(lines(repo, 'answered').map((l) => l.answers[0].answer), ['a', 'b', 'b'])
})

test('an answer to a question never opened, or never asked, is refused and nothing is recorded', async (t) => {
  const repo = effort(t)
  assert.equal((await recordAnswer(repo, E, 999, session(t, {}))).error.kind, 'unknown_question')
  const { asked } = openQuestion(repo, E)
  assert.equal((await recordAnswer(repo, E, asked, session(t, { 'another question': 'x' }))).error.kind, 'not_answered')
  assert.deepEqual(lines(repo, 'answered'), [])
})

test('answers since a seq are the answered lines after it, oldest first, each question by its latest answer', () => {
  const ledger = [
    { kind: 'answered', seq: 9, asked: 8 }, { kind: 'approved', seq: 5 }, { kind: 'answered', seq: 4, asked: 3 },
    { kind: 'answered', seq: 7, asked: 6 }, { kind: 'answered', seq: 11, asked: 6 }, { kind: 'answered', seq: 13, asked: 3 },
  ]
  assert.deepEqual(answersSince(ledger, 5).map((l) => l.seq), [9, 11, 13])
  assert.deepEqual(answersSince(ledger, 12).map((l) => l.seq), [13])
})
