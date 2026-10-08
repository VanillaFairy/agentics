// test/host.test.mjs — pins what lib/host.mjs knows about the host CLI's layout: where the CLI is,
// where a session's transcript is, what the user answered, and whether an act was confirmed.
//
// Design: docs/DESIGN.md#the-users-word and docs/DESIGN.md#the-agent-runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  actorOf, answersIn, confirmAct, projectsDir, resolveCli, sessionExists, terminalAct, transcriptOf, verifyAnswer,
} from '../../lib/host.mjs'

const FIXTURE = fileURLToPath(new URL('../fixtures/host/transcript.jsonl', import.meta.url))
const FIXTURE_TEXT = readFileSync(FIXTURE, 'utf8')
const SESSION = '0f0e0d0c-0b0a-4000-8000-000000000001'
const CONFIG = join('C:', 'cfg')
const PROJECTS = join(CONFIG, 'projects')
const TRANSCRIPT = join(PROJECTS, 'C--work-b', SESSION + '.jsonl')
const env = { CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_CODE_SESSION_ID: SESSION }
const listing = { [PROJECTS]: ['C--work-a', 'C--work-b'], [join(PROJECTS, 'C--work-a')]: [], [join(PROJECTS, 'C--work-b')]: [SESSION + '.jsonl'] }
const list = (dir) => { if (!listing[dir]) throw new Error('ENOENT ' + dir); return listing[dir] }
const isFile = (p) => p === TRANSCRIPT
const readerOf = (text) => (p) => { if (p !== TRANSCRIPT) throw new Error('ENOENT ' + p); return text }
const read = readerOf(FIXTURE_TEXT)
const lookup = { env, list, isFile, read }

const APPROVE_TOKEN = 'approve api@0a1b2c3d'
const LAND_TOKEN = 'land e1@ffffffff'
const fixtureLines = FIXTURE_TEXT.split(/\r?\n/).filter((l) => l !== '')
const answerLine = (question, answer) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-x', content: 'answered' }] },
  toolUseResult: { questions: [{ question }], answers: { [question]: answer } },
})
const pairs = (entries) => entries.map(({ question, answer }) => ({ question, answer }))
const refusal = (result, kind) => {
  assert.equal(result.ok, false)
  assert.equal(result.error.kind, kind)
  assert.equal(typeof result.error.message, 'string')
  assert.ok(result.error.message.length > 0)
}
const neverAsk = () => { throw new Error('ask must not be called') }

test('the configured CLI is used when it exists', () => {
  const configured = join('D:', 'tools', 'claude.exe')
  const result = resolveCli({ config: { claude_cli: configured }, env: { PATH: join('E:', 'bin') }, isFile: (p) => p === configured })
  assert.equal(result.ok, true)
  assert.equal(result.path, configured)
})

test('a configured CLI that is missing is refused', () => {
  const configured = join('D:', 'tools', 'claude.exe')
  const bin = join('E:', 'bin')
  const onPath = new Set([join(bin, 'claude.exe'), join(bin, 'claude')])
  const result = resolveCli({ config: { claude_cli: configured }, env: { PATH: bin, Path: bin }, isFile: (p) => onPath.has(p) })
  refusal(result, 'host_missing')
})

test('the CLI is found on the PATH', () => {
  const empty = join('E:', 'empty')
  const first = join('E:', 'first')
  const second = join('E:', 'second')
  const held = new Set([first, second].flatMap((dir) => [join(dir, 'claude.exe'), join(dir, 'claude')]))
  const fileCheck = (p) => held.has(p)
  for (const key of ['PATH', 'Path']) {
    const result = resolveCli({ config: {}, env: { [key]: [empty, first, second].join(delimiter) }, isFile: fileCheck })
    assert.equal(result.ok, true, key)
    assert.ok([join(first, 'claude.exe'), join(first, 'claude')].includes(result.path), `${key}: ${result.path}`)
  }
})

test('a CLI named claude is found without claude.exe', () => {
  const dir = join('E:', 'unix')
  const result = resolveCli({ config: {}, env: { PATH: [join('E:', 'empty'), dir].join(delimiter) }, isFile: (p) => p === join(dir, 'claude') })
  assert.equal(result.ok, true)
  assert.equal(result.path, join(dir, 'claude'))
})

test('a CLI named claude.exe is found without claude', () => {
  const dir = join('E:', 'win')
  const result = resolveCli({ config: {}, env: { PATH: [join('E:', 'empty'), dir].join(delimiter) }, isFile: (p) => p === join(dir, 'claude.exe') })
  assert.equal(result.ok, true)
  assert.equal(result.path, join(dir, 'claude.exe'))
})

test('no CLI anywhere is refused', () => {
  const dirs = [join('E:', 'a'), join('E:', 'b')].join(delimiter)
  refusal(resolveCli({ config: {}, env: { PATH: dirs }, isFile: () => false }), 'host_missing')
  refusal(resolveCli({ config: {}, env: {}, isFile: () => false }), 'host_missing')
})

test('the projects folder follows CLAUDE_CONFIG_DIR', () => {
  assert.equal(projectsDir({ CLAUDE_CONFIG_DIR: CONFIG }), PROJECTS)
})

test('the projects folder defaults under the home folder', () => {
  const expected = join(homedir(), '.claude', 'projects')
  assert.equal(projectsDir({}), expected)
  assert.equal(projectsDir({ CLAUDE_CONFIG_DIR: '' }), expected)
})

test('a transcript is found in its project folder', () => {
  assert.equal(transcriptOf(SESSION, { env, list, isFile }), TRANSCRIPT)
  assert.equal(sessionExists(SESSION, { env, list, isFile }), true)
})

test('an unknown session has no transcript', () => {
  const unknown = '0f0e0d0c-0b0a-4000-8000-000000000002'
  assert.equal(transcriptOf(unknown, { env, list, isFile }), '')
  assert.equal(sessionExists(unknown, { env, list, isFile }), false)
})

test('a session id that is not a uuid finds no transcript', () => {
  for (const id of ['not-a-uuid', '', SESSION + '0', 'x' + SESSION, join('..', 'C--work-b', SESSION)]) {
    const planted = join(PROJECTS, 'C--work-b', id + '.jsonl')
    const plantedListing = { ...listing, [join(PROJECTS, 'C--work-b')]: [SESSION + '.jsonl', id + '.jsonl'] }
    const opts = {
      env,
      list: (dir) => { if (!plantedListing[dir]) throw new Error('ENOENT ' + dir); return plantedListing[dir] },
      isFile: (p) => p === planted || p.endsWith(id + '.jsonl'),
    }
    assert.equal(transcriptOf(id, opts), '', JSON.stringify(id))
    assert.equal(sessionExists(id, opts), false, JSON.stringify(id))
  }
})

test('a missing config folder holds no transcript', () => {
  const gone = { CLAUDE_CONFIG_DIR: join('C:', 'nowhere'), CLAUDE_CODE_SESSION_ID: SESSION }
  assert.equal(transcriptOf(SESSION, { env: gone, list, isFile: () => false }), '')
  assert.equal(sessionExists(SESSION, { env: gone, list, isFile: () => false }), false)
})

test('answers are read in file order', () => {
  const question = '1/1. Approve? ' + APPROVE_TOKEN
  assert.deepEqual(pairs(answersIn(FIXTURE_TEXT)), [
    { question, answer: 'Change it' },
    { question, answer: 'Approve' },
    { question: LAND_TOKEN, answer: 'Land' },
    { question: 'Name?', answer: 'x' },
  ])
  const reversed = fixtureLines.slice().reverse().join('\n')
  assert.deepEqual(pairs(answersIn(reversed)).map((e) => e.answer), ['Land', 'x', 'Approve', 'Change it'])
})

test('non-JSON lines are skipped', () => {
  const garbage = ['{{not json', '', '   ', '{"type":"user",', 'not json at all'].join('\n')
  assert.deepEqual(answersIn(garbage), [])
  const text = ['{{not json', answerLine('q ' + LAND_TOKEN, 'Land'), '{{not json', answerLine('q2', 'y')].join('\n')
  assert.deepEqual(pairs(answersIn(text)), [{ question: 'q ' + LAND_TOKEN, answer: 'Land' }, { question: 'q2', answer: 'y' }])
})

test('every question of one result is read', () => {
  const multi = fixtureLines.find((l) => l.includes('"Name?"'))
  const got = pairs(answersIn(multi))
  assert.equal(got.length, 2)
  assert.deepEqual(new Set(got.map((e) => `${e.question}=${e.answer}`)), new Set([`${LAND_TOKEN}=Land`, 'Name?=x']))
})

test('a result without answers yields nothing', () => {
  const unanswered = fixtureLines.at(-1)
  assert.ok(unanswered.includes('toolUseResult') && !unanswered.includes('"answers"'))
  assert.deepEqual(answersIn(unanswered), [])
  assert.deepEqual(answersIn(fixtureLines[0]), [])
})

const bareAnswer = JSON.stringify({ type: 'user', toolUseResult: { answers: { ['1/1. Approve? ' + APPROVE_TOKEN]: 'Approve' } } })

test('answers without questions are not read', () => {
  assert.deepEqual(answersIn(bareAnswer), [])
})

test('answers without questions do not approve', () => {
  refusal(verifyAnswer({ token: APPROVE_TOKEN, option: 'Approve', ...lookup, read: readerOf(bareAnswer + '\n') }),'not_approved')
})

test("a session's answer verifies", () => {
  assert.deepEqual(verifyAnswer({ token: LAND_TOKEN, option: 'Land', ...lookup }), { ok: true, by: 'user' })
})

test('the latest answer decides, approve after change', () => {
  assert.deepEqual(verifyAnswer({ token: APPROVE_TOKEN, option: 'Approve', ...lookup }), { ok: true, by: 'user' })
  refusal(verifyAnswer({ token: APPROVE_TOKEN, option: 'Change it', ...lookup }), 'not_approved')
})

test('the latest answer decides, change after approve', () => {
  const change = fixtureLines.findIndex((l) => l.includes('"Change it"'))
  const approve = fixtureLines.findIndex((l) => l.includes(`"${'1/1. Approve? ' + APPROVE_TOKEN}":"Approve"`))
  assert.ok(change >= 0 && approve > change)
  const swapped = fixtureLines.slice()
  ;[swapped[change], swapped[approve]] = [swapped[approve], swapped[change]]
  const reordered = { ...lookup, read: readerOf(swapped.join('\n') + '\n') }
  refusal(verifyAnswer({ token: APPROVE_TOKEN, option: 'Approve', ...reordered }), 'not_approved')
  assert.deepEqual(verifyAnswer({ token: APPROVE_TOKEN, option: 'Change it', ...reordered }), { ok: true, by: 'user' })
})

test('a token nobody was asked about is not approved', () => {
  refusal(verifyAnswer({ token: 'land e9@00000000', option: 'Land', ...lookup }), 'not_approved')
  refusal(verifyAnswer({ token: 'land e2@eeeeeeee', option: 'Land', ...lookup }), 'not_approved')
  refusal(verifyAnswer({ token: LAND_TOKEN, option: 'Land', ...lookup, read: readerOf('') }), 'not_approved')
})

test('a latest answer to a question without the token is not approval', () => {
  const text = answerLine('Name?', 'Land') + '\n'
  refusal(verifyAnswer({ token: LAND_TOKEN, option: 'Land', ...lookup, read: readerOf(text) }), 'not_approved')
})

test('a typed answer is not the option', () => {
  const question = '1/1. Approve? ' + APPROVE_TOKEN
  for (const typed of ['Approve it', 'I approve', 'Approved']) {
    const text = answerLine(question, typed) + '\n'
    refusal(verifyAnswer({ token: APPROVE_TOKEN, option: 'Approve', ...lookup, read: readerOf(text) }), 'not_approved')
  }
  const after = FIXTURE_TEXT + answerLine(question, 'Approve it') + '\n'
  refusal(verifyAnswer({ token: APPROVE_TOKEN, option: 'Approve', ...lookup, read: readerOf(after) }), 'not_approved')
})

test('an answer naming the option among others is not the option', () => {
  const question = '1/1. Approve? ' + APPROVE_TOKEN
  for (const text of [answerLine(question, 'Approve, Change it'), FIXTURE_TEXT + answerLine(question, 'Approve, Change it')]) {
    refusal(verifyAnswer({ token: APPROVE_TOKEN, option: 'Approve', ...lookup, read: readerOf(text + '\n') }), 'not_approved')
  }
})

test('a question naming two acts answers only the act its option names', () => {
  const both = answerLine(`1/1. Which? ${APPROVE_TOKEN} or ${LAND_TOKEN}`, 'Land') + '\n'
  const opts = { ...lookup, read: readerOf(both) }
  assert.deepEqual(verifyAnswer({ token: LAND_TOKEN, option: 'Land', ...opts }), { ok: true, by: 'user' })
  refusal(verifyAnswer({ token: APPROVE_TOKEN, option: 'Approve', ...opts }), 'not_approved')
  const later = { ...lookup, read: readerOf(FIXTURE_TEXT + both) }
  refusal(verifyAnswer({ token: APPROVE_TOKEN, option: 'Approve', ...later }), 'not_approved')
})

// A question contains a token only where the token ends: at the end of the text, or before a character
// outside [0-9A-Za-z#].

const answered = (question, token, option = 'Approve') =>
  verifyAnswer({ token, option, ...lookup, read: readerOf(answerLine(question, option) + '\n') })

test('a token is not matched inside a longer seq', () => {
  refusal(answered('1/1. Approve? approve api@0a1b2c3d#41', 'approve api@0a1b2c3d#4'), 'not_approved')
})

test('a token without a seq is not matched by one with a seq', () => {
  refusal(answered('1/1. Approve? approve api@0a1b2c3d#4', APPROVE_TOKEN), 'not_approved')
})

test('a token with an empty head is not matched by one with a head', () => {
  refusal(answered('1/1. Land? land e1@abcdef12', 'land e1@', 'Land'), 'not_approved')
})

test('a token followed by punctuation, a space, a newline or the end is matched', () => {
  for (const after of ['?', '.', ')', ' now', '\nApprove it?', '']) {
    assert.deepEqual(answered('1/1. Approve ' + APPROVE_TOKEN + after, APPROVE_TOKEN), { ok: true, by: 'user' }, JSON.stringify(after))
  }
})

test('a token inside backticks is matched', () => {
  assert.deepEqual(answered('1/1. Approve `' + APPROVE_TOKEN + '`?', APPROVE_TOKEN), { ok: true, by: 'user' })
})

test('a token is found whole after a longer lookalike in the same question', () => {
  assert.deepEqual(answered('1/1. Not approve api@0a1b2c3d#41 but approve api@0a1b2c3d#4?', 'approve api@0a1b2c3d#4'), { ok: true, by: 'user' })
})

test('a lookalike token is not the token', () => {
  const lookalike = APPROVE_TOKEN.replace('a', 'а')
  assert.notEqual(lookalike, APPROVE_TOKEN)
  const text = answerLine('1/1. Approve? ' + lookalike, 'Approve') + '\n'
  refusal(verifyAnswer({ token: APPROVE_TOKEN, option: 'Approve', ...lookup, read: readerOf(text) }), 'not_approved')
})

test('without a session id the answer is unverifiable', () => {
  const noSession = { CLAUDE_CONFIG_DIR: CONFIG }
  refusal(verifyAnswer({ token: LAND_TOKEN, option: 'Land', ...lookup, env: noSession }), 'answer_unverifiable')
})

test('a missing transcript is unverifiable', () => {
  refusal(verifyAnswer({ token: LAND_TOKEN, option: 'Land', ...lookup, isFile: () => false, list: () => [] }), 'answer_unverifiable')
  const elsewhere = { ...env, CLAUDE_CODE_SESSION_ID: '0f0e0d0c-0b0a-4000-8000-000000000002' }
  refusal(verifyAnswer({ token: LAND_TOKEN, option: 'Land', ...lookup, env: elsewhere }), 'answer_unverifiable')
})

test('an unreadable transcript is unverifiable', () => {
  const broken = () => { throw new Error('EACCES') }
  refusal(verifyAnswer({ token: LAND_TOKEN, option: 'Land', ...lookup, read: broken }), 'answer_unverifiable')
})

test('a session is a session even at a terminal', () => {
  assert.equal(actorOf({ env: { CLAUDE_CODE_SESSION_ID: SESSION }, stdinIsTTY: true }), 'session')
  assert.equal(actorOf({ env: { CLAUDE_CODE_SESSION_ID: SESSION }, stdinIsTTY: false }), 'session')
})

test('no session and a console is a terminal', () => {
  assert.equal(actorOf({ env: {}, stdinIsTTY: true }), 'terminal')
})

test('no session and no console is nobody', () => {
  assert.equal(actorOf({ env: {}, stdinIsTTY: false }), 'none')
  assert.equal(actorOf({ env: {} }), 'none')
})

test('a terminal act verifies the typed token', async () => {
  for (const typed of [LAND_TOKEN, `  ${LAND_TOKEN}  `, `${LAND_TOKEN}\n`, `\t${LAND_TOKEN}\r\n`]) {
    let asked = 0
    const ask = async () => { asked += 1; return typed }
    assert.deepEqual(await terminalAct({ token: LAND_TOKEN, ask }), { ok: true, by: 'terminal' }, JSON.stringify(typed))
    assert.equal(asked, 1)
  }
})

test('a terminal act refuses another answer', async () => {
  const others = ['', '   ', 'yes', 'Land', LAND_TOKEN.slice(0, -1), LAND_TOKEN + 'f', LAND_TOKEN.replace('a', 'а'), APPROVE_TOKEN]
  for (const typed of others) {
    refusal(await terminalAct({ token: LAND_TOKEN, ask: async () => typed }), 'not_approved')
  }
})

test('confirmAct from a session reads the transcript', async () => {
  let reads = 0
  const counted = (p) => { reads += 1; return read(p) }
  const base = { env, stdinIsTTY: true, ask: neverAsk, list, isFile, read: counted }
  assert.deepEqual(await confirmAct({ token: LAND_TOKEN, option: 'Land', ...base }), { ok: true, by: 'user' })
  assert.ok(reads > 0)
  refusal(await confirmAct({ token: APPROVE_TOKEN, option: 'Change it', ...base }), 'not_approved')
  refusal(await confirmAct({ token: LAND_TOKEN, option: 'Land', ...base, isFile: () => false, list: () => [] }), 'answer_unverifiable')
})

test('confirmAct at a terminal asks for the token', async () => {
  const neverRead = () => { throw new Error('read must not be called') }
  const noSession = { CLAUDE_CONFIG_DIR: CONFIG }
  let asked = 0
  const ask = async () => { asked += 1; return ` ${LAND_TOKEN} ` }
  const base = { env: noSession, stdinIsTTY: true, list, isFile, read: neverRead }
  assert.deepEqual(await confirmAct({ token: LAND_TOKEN, option: 'Land', ...base, ask }), { ok: true, by: 'terminal' })
  assert.equal(asked, 1)
  refusal(await confirmAct({ token: LAND_TOKEN, option: 'Land', ...base, ask: async () => 'Land' }), 'not_approved')
})

test('neither a session nor a terminal is unverifiable', async () => {
  const result = await confirmAct({ token: LAND_TOKEN, option: 'Land', env: { CLAUDE_CONFIG_DIR: CONFIG }, stdinIsTTY: false, ask: neverAsk, list, isFile, read })
  refusal(result, 'answer_unverifiable')
})
