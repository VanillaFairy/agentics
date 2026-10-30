// test/program-rule.test.mjs — the rule program: one ruler rules a changed spec from an inline brief
// that holds the user's answers, its rulings are settled, refused rulings go back to it, a change the
// answers leave open goes to the user as questions, and a choice the user already answered is
// approved on that answer without asking again.
//
// Design: docs/DESIGN.md#a-changed-spec, docs/DESIGN.md#the-users-word.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { answerToken, openQuestion, recordAnswer } from '../lib/answers.mjs'
import { approvalState, recordApproval, recordPreparation } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { renderMessage } from '../lib/conversation.mjs'
import { append, fileFor, readLog, readRunLog, runState } from '../lib/ledger.mjs'
import { programContext } from '../lib/programs/common.mjs'
import { rule } from '../lib/programs/rule.mjs'
import { launch } from '../lib/run.mjs'
import { rulerBrief } from '../lib/briefs/respec.mjs'
import { respecBrief, respecSettle } from '../lib/respec.mjs'
import { BRIEF_BYTES, loadRole, tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { mainCheckout, pidAlive, posix, readJson, resultPath, runLogFile, specPath } from '../lib/store.mjs'
import { programRig } from './harness/program-rig.mjs'

const FIXTURES = fileURLToPath(new URL('./fixtures/compile/', import.meta.url))
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n')
const ROOT = read('root.md')
const API = read('api.md')
const EDITS = {
  wording: { folder: 'api', text: API.replace('`load(path)`, then `parse(text)`.', '`load(path)` returns a frozen object.') },
  decision: { folder: '.', text: ROOT.replace('Unknown keys are an error.', 'Unknown keys are an error, named in the message.') },
  types: { folder: 'api', text: API.replace('Declare the config type', 'Declare the config type, frozen') },
}
const E = 'e1'
const GUIDE = 'GUIDE-MARK: a ruling names the node it rules'

function writeSpec(repo, id, text) {
  mkdirSync(dirname(specPath(repo, E, id)), { recursive: true })
  writeFileSync(specPath(repo, E, id), text)
}

/** A rig whose root and api specs are approved and compiled, then edited as `edit` says; `brief` is the 4.x brief of the change. */
function changed(t, edit = 'wording', { config = {} } = {}) {
  const rig = programRig({ files: { 'CLAUDE.md': GUIDE + '\n' }, config })
  t.after(() => rig.cleanup())
  writeSpec(rig.repo, '.', ROOT)
  writeSpec(rig.repo, 'api', API)
  for (const id of ['.', 'api']) assert.equal(recordApproval(rig.repo, E, id).ok, true)
  assert.equal(compileEffort(rig.repo, E).ok, true)
  if (edit === null) return { rig, folder: 'api', brief: null }
  const { folder, text } = EDITS[edit]
  writeSpec(rig.repo, folder, text)
  const brief = respecBrief(rig.repo, E, folder)
  assert.equal(brief.status, 'brief', JSON.stringify(brief))
  return { rig, folder, brief }
}

const ruling = (node, over = {}) => ({ node, ruling: 'unaffected', why: 'nothing it uses moved', question: '', fix: '', ...over })
/** One ruling per node of the brief, `over[node]` laid over the unaffected default. */
const rulingsOf = (brief, over = {}) => ({ rulings: brief.nodes.map((node) => ruling(node, over[node])) })
const AFFECTED = { cli: { ruling: 'affected', why: 'it mutates what load returns', question: 'Should the CLI copy the config before it edits it?' } }
/** The ruler's thread is keyed by the basis of what it rules. */
const rulerThread = (brief) => 'ruler:' + brief.basis
/** The ruler's starts, on the thread of whichever basis the run briefs. */
const rulerSteps = (...steps) => new Proxy({}, { get: (_, key) => (String(key).startsWith('ruler||ruler:') ? steps : undefined) })
const rulerScript = (...outputs) => rulerSteps(...outputs.map((output) => ({ output })))

const args = (folder) => ({ effort: E, folder })
const ledger = (repo, kind) => readLog(repo, E, 'ledger').entries.filter((l) => l.kind === kind)
const approvalsOf = (repo, folder) => ledger(repo, 'approved').filter((l) => l.folder === folder)
const latestRuled = (repo, folder) => ledger(repo, 'ruled').filter((l) => l.folder === folder).at(-1)
const runRecords = (repo, run, kind) => readRunLog(repo, run).entries.filter((e) => e.kind === kind)

const assertCompleteCoverage = (out, ctx, label) => {
  assert.equal(out.coverage.complete, true, label + ': ' + JSON.stringify(out.coverage))
  for (const list of ['dropped', 'incomplete', 'failed_channels', 'unreached']) assert.deepEqual(out.coverage[list], [], label + ': ' + list)
  assert.deepEqual(out.coverage.resumable, ctx.resumable, label + ': resumable')
}

/** Rule the wording edit with cli ruled affected: the first run, which returned `needs_user`. */
async function needsUser(t) {
  const { rig, folder, brief } = changed(t)
  const first = await rule(rig.relaunch(rulerScript(rulingsOf(brief, AFFECTED))).ctx, args(folder))
  assert.equal(first.status, 'needs_user', JSON.stringify(first))
  return { rig, folder, brief, first }
}

// --- the program module ----------------------------------------------------------------------

// --- the brief and the ruler -----------------------------------------------------------------

test('a change that cannot be ruled is refused with its next step and dispatches nothing', async (t) => {
  const never = programRig({ files: { 'CLAUDE.md': GUIDE + '\n' } })
  t.after(() => never.cleanup())
  writeSpec(never.repo, '.', ROOT)
  const expected = respecBrief(never.repo, E, '.')
  assert.equal(expected.next, 'user_approves')
  const refused = await rule(never.ctx, args('.'))
  assert.deepEqual([refused.status, refused.next, refused.why, refused.problems], ['refused', 'user_approves', expected.why, expected.problems])
  assert.equal(never.calls.length, 0)

  const { rig } = changed(t, null)
  const unchanged = await rule(rig.ctx, args('api'))
  assert.deepEqual([unchanged.status, unchanged.next], ['refused', 'nothing'])
  assert.equal(unchanged.why, respecBrief(rig.repo, E, 'api').why)
  assert.equal(rig.calls.length, 0)
  assert.equal(ledger(rig.repo, 'ruled').length, 0)
})

test('a ruler whose brief is past what it can read is never sent it: the change is refused for the user to shrink the spec it names', async (t) => {
  const pad = (text, mark) => text.replace('## Design\n', '## Design\n\n' + Array.from({ length: 900 }, (_, i) => mark + ' ' + i + ' ' + 'z'.repeat(100)).join('\n') + '\n')
  const rig = programRig({ files: { 'CLAUDE.md': GUIDE + '\n' + 'g'.repeat(30000) + '\n' } })
  t.after(() => rig.cleanup())
  writeSpec(rig.repo, '.', pad(ROOT, 'ROOT_PAD'))
  writeSpec(rig.repo, 'api', pad(API, 'API_PAD'))
  for (const id of ['.', 'api']) assert.equal(recordApproval(rig.repo, E, id).ok, true)
  assert.equal(compileEffort(rig.repo, E).ok, true)
  writeSpec(rig.repo, 'api', pad(EDITS.wording.text, 'API_PAD'))
  const brief = respecBrief(rig.repo, E, 'api')
  assert.equal(brief.status, 'brief')
  assert.ok(Buffer.byteLength(brief.text) + 30000 > BRIEF_BYTES, 'the fixture: with its guidance the whole brief is past the bound')

  const run = rig.relaunch(rulerScript(rulingsOf(brief)))
  const out = await rule(run.ctx, args('api'))
  assert.equal(run.calls.length, 0, 'no ruler is started')
  assert.deepEqual([out.status, out.next], ['refused', 'shrink_brief'], 'ruling it again would build the same brief')
  const spec = brief.parts.specs.find((s) => s.text.includes('ROOT_PAD')).path
  assert.ok(out.why.includes('"' + spec + '"') && out.why.includes('the work is too big') && out.why.endsWith('then it is ruled again'), out.why)
  assert.equal(ledger(run.repo, 'ruled').length, 0)
})

test("one ruler rules the change at its role's tier", async (t) => {
  const { rig, folder, brief } = changed(t)
  const run = rig.relaunch(rulerScript(rulingsOf(brief)))
  await rule(run.ctx, args(folder))
  assert.equal(run.calls.length, 1)
  const [call] = run.calls
  assert.equal(call.role.name, 'ruler')
  assert.equal(call.thread.key, rulerThread(brief))
  assert.deepEqual(call.schema, schemaOf('ruler_respec'))
  assert.deepEqual(call.tier, tierFor(loadRole('ruler').role, { intelligence: 'normal' }))
})

test("the ruler's brief holds the change, every node and every spec it names whole", async (t) => {
  const { rig, folder, brief } = changed(t)
  const run = rig.relaunch(rulerScript(rulingsOf(brief)))
  await rule(run.ctx, args(folder))
  const text = run.calls[0].brief
  assert.ok(text.includes('-`load(path)`, then `parse(text)`.'), 'the line the change removed')
  assert.ok(text.includes('+`load(path)` returns a frozen object.'), 'the line the change added')
  const lines = text.split('\n').map((l) => l.trim())
  for (const id of brief.nodes) assert.ok(lines.includes('### ' + id), 'a heading for ' + id)
  assert.ok(text.includes(EDITS.wording.text.trim()), 'the changed spec as it now stands, whole')
  assert.ok(text.includes(ROOT.trim()), 'the root spec, which states the entry of the consumer cli, whole')
})

test("the ruler's brief carries the repository's guidance", async (t) => {
  const { rig, folder, brief } = changed(t)
  const run = rig.relaunch(rulerScript(rulingsOf(brief)))
  await rule(run.ctx, args(folder))
  assert.ok(run.calls[0].brief.includes(GUIDE))
})

test("the ruler's brief names no file to read or write", async (t) => {
  const { rig, folder, brief } = changed(t)
  const run = rig.relaunch(rulerScript(rulingsOf(brief)))
  await rule(run.ctx, args(folder))
  const text = run.calls[0].brief
  const repoPaths = [posix(mainCheckout(rig.repo)), mainCheckout(rig.repo), posix(rig.repo), rig.repo]
  for (const p of repoPaths) assert.ok(!text.includes(p), 'a path into the repository: ' + p)
  for (const p of [brief.rulings, brief.brief]) {
    assert.ok(!text.includes(p) && !text.includes(posix(p)), 'a respec file: ' + p)
  }
})

test('the brief is written where settle records it and returned whole, as rulerBrief builds it', (t) => {
  const { rig, folder, brief } = changed(t)
  assert.equal(brief.status, 'brief', JSON.stringify(brief))
  assert.ok(brief.text.length > 0)
  assert.equal(brief.text, rulerBrief(brief.parts))
  assert.equal(readFileSync(brief.brief, 'utf8'), brief.text, 'the brief file holds the text returned')
  assert.ok(!Object.hasOwn(brief, 'prompt'), 'the brief has no prompt pointing at files')
  assert.ok(!brief.text.includes(brief.rulings), 'the rulings come back as the structured return, not through a file')

  writeFileSync(brief.rulings, JSON.stringify(rulingsOf(brief)))
  const out = respecSettle(rig.repo, E, folder)
  assert.equal(ledger(rig.repo, 'ruled').find((l) => l.seq === out.ruled).brief, brief.brief)
})

// --- settling --------------------------------------------------------------------------------

test("the ruler's rulings are written where settle reads them", async (t) => {
  const { rig, folder, brief } = changed(t)
  const returned = rulingsOf(brief, AFFECTED)
  const out = await rule(rig.relaunch(rulerScript(returned)).ctx, args(folder))
  assert.deepEqual(JSON.parse(readFileSync(brief.rulings, 'utf8')), returned)
  const lines = ledger(rig.repo, 'ruled')
  assert.equal(lines.length, 1)
  assert.deepEqual(lines[0].rulings, returned.rulings)
  assert.equal(out.ruled, lines[0].seq)
})

test('a change every ruling leaves unaffected is approved by ruling and compiled', async (t) => {
  const { rig, folder, brief } = changed(t)
  const out = await rule(rig.relaunch(rulerScript(rulingsOf(brief))).ctx, args(folder))
  const line = latestRuled(rig.repo, folder)
  assert.deepEqual([out.status, out.folder, out.hash, out.ruled, out.by], ['approved', folder, brief.hash, line.seq, 'ruling'], JSON.stringify(out))
  for (const list of ['written', 'retired', 'flagged', 'spared', 'parked', 'answered']) assert.ok(Array.isArray(out[list]), list)
  const st = approvalState(rig.repo, E, folder)
  assert.deepEqual([st.state, st.compiled_hash], ['approved', brief.hash])
  const approval = approvalsOf(rig.repo, folder).at(-1)
  assert.deepEqual([approval.hash, approval.by, approval.ruled], [brief.hash, 'ruling', out.ruled])
})

test('an affected ruling goes to the user with its question, and nothing is approved', async (t) => {
  const { rig, folder, brief } = changed(t)
  const before = approvalsOf(rig.repo, folder).length
  const out = await rule(rig.relaunch(rulerScript(rulingsOf(brief, AFFECTED))).ctx, args(folder))
  const line = latestRuled(rig.repo, folder)
  assert.deepEqual([out.status, out.folder, out.hash, out.ruled], ['needs_user', folder, brief.hash, line.seq], JSON.stringify(out))
  assert.deepEqual(out.affected, line.rulings.filter((r) => r.ruling === 'affected').map(({ node, why, question, fix }) => ({ node, why, question, fix })))
  assert.deepEqual(out.affected.map((a) => [a.node, a.question]), [['cli', AFFECTED.cli.question]])
  assert.equal(approvalState(rig.repo, E, folder).state, 'edited')
  assert.equal(approvalsOf(rig.repo, folder).length, before)
})

// --- the user's answers ----------------------------------------------------------------------

const DECISION_UNIT = 'decision:D2'
const WORDS = 'Yes: name the unknown key in the message, and keep it an error.'
const decisionRuling = (brief, over) => rulingsOf(brief, { [DECISION_UNIT]: { why: 'the decision changed', ...over } })

/** A session whose transcript holds the user's `answer` to `question`; its env. */
function session(t, question, answer) {
  const config = mkdtempSync(join(tmpdir(), 'agentics-rule-session-'))
  t.after(() => rmSync(config, { recursive: true, force: true }))
  const id = randomUUID()
  mkdirSync(join(config, 'projects', 'some-project'), { recursive: true })
  writeFileSync(join(config, 'projects', 'some-project', id + '.jsonl'), JSON.stringify({
    type: 'user', toolUseResult: { questions: [{ question }], answers: { [question]: answer } },
  }) + '\n')
  return { CLAUDE_CODE_SESSION_ID: id, CLAUDE_CONFIG_DIR: config }
}

/** The user answers `WORDS` to a question opened about `api`; the seq of the `answered` line. */
async function userAnswers(t, rig) {
  const opened = openQuestion(rig.repo, E, { nodes: ['api'] })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const recorded = await recordAnswer(rig.repo, E, opened.asked, { env: session(t, 'Keep D2 an error? ' + opened.token, WORDS) })
  assert.equal(recorded.ok, true, JSON.stringify(recorded))
  return recorded.answered
}

test("a changed decision is a unit of the user's own: ruled unaffected it goes back to the ruler", async (t) => {
  const { rig, folder, brief } = changed(t, 'decision')
  assert.ok(brief.nodes.includes(DECISION_UNIT), JSON.stringify(brief.nodes))
  const run = rig.relaunch(rulerScript(rulingsOf(brief), rulingsOf(brief)))
  const out = await rule(run.ctx, args(folder))
  const [message] = runRecords(rig.repo, rig.run, 'message').filter((m) => m.thread === rulerThread(brief))
  assert.deepEqual([message.msg, message.round], ['refusals', 2])
  assert.ok(message.payload.refusals[0].problem.includes(DECISION_UNIT), JSON.stringify(message.payload))
  assert.deepEqual([out.status, out.next], ['refused', 'rule_it'], 'the same refusal twice ends the run: ' + JSON.stringify(out))
  assert.equal(approvalState(rig.repo, E, folder).state, 'edited')
})

test("a changed decision no answer settles goes to the user as its affected unit, with the ruler's question", async (t) => {
  const { rig, folder, brief } = changed(t, 'decision')
  const question = 'Should an unknown key be named in the error message?'
  const out = await rule(rig.relaunch(rulerScript(decisionRuling(brief, { ruling: 'affected', question }))).ctx, args(folder))
  assert.equal(out.status, 'needs_user', JSON.stringify(out))
  assert.deepEqual(out.affected.map((a) => [a.node, a.question]), [[DECISION_UNIT, question]])
  assert.ok(!('token' in out) && !('reasons' in out), 'the program hands the user nothing to ask by')
  assert.equal(approvalState(rig.repo, E, folder).state, 'edited')
})

test("the user's answer is in the ruler's brief in their own words, and a ruling citing it approves by answer", async (t) => {
  const { rig, folder } = changed(t, 'decision')
  const seq = await userAnswers(t, rig)
  const brief = respecBrief(rig.repo, E, folder)
  assert.deepEqual(brief.parts.answers.map((a) => [a.seq, a.nodes, a.answers.map((x) => x.answer)]), [[seq, ['api'], [WORDS]]])

  const run = rig.relaunch(rulerScript(decisionRuling(brief, { ruling: 'answered', answers: [seq] })))
  const out = await rule(run.ctx, args(folder))
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].role.name, 'ruler')
  assert.ok(run.calls[0].brief.includes(WORDS), 'the ruler is shown what the user answered')
  assert.deepEqual([out.status, out.by, out.ruled], ['approved', 'answer', latestRuled(rig.repo, folder).seq], JSON.stringify(out))
  const approval = approvalsOf(rig.repo, folder).at(-1)
  assert.deepEqual([approval.hash, approval.by, approval.answers], [brief.hash, 'answer', [seq]])
  assert.equal(approvalState(rig.repo, E, folder).compiled_hash, brief.hash, 'the approval is compiled')
  assert.deepEqual(latestRuled(rig.repo, folder).answers, [seq])
})

test('an answered ruling citing an answer the brief did not hold goes back to the ruler', async (t) => {
  const { rig, folder } = changed(t, 'decision')
  const seq = await userAnswers(t, rig)
  const brief = respecBrief(rig.repo, E, folder)
  const run = rig.relaunch(rulerScript(
    decisionRuling(brief, { ruling: 'answered', answers: [seq + 100] }),
    decisionRuling(brief, { ruling: 'answered', answers: [seq] }),
  ))
  const out = await rule(run.ctx, args(folder))
  const [message] = runRecords(rig.repo, rig.run, 'message').filter((m) => m.thread === rulerThread(brief))
  assert.deepEqual([message.msg, message.round], ['refusals', 2])
  assert.ok(message.payload.refusals[0].problem.includes(DECISION_UNIT), JSON.stringify(message.payload))
  assert.equal(run.calls.length, 2)
  assert.deepEqual([out.status, out.by], ['approved', 'answer'], JSON.stringify(out))
})

test('an answer given before the last approval of the folder is not in the brief', async (t) => {
  const { rig } = changed(t, null)
  await userAnswers(t, rig)
  assert.equal(recordApproval(rig.repo, E, '.').ok, true)
  writeSpec(rig.repo, '.', EDITS.decision.text)
  const brief = respecBrief(rig.repo, E, '.')
  assert.equal(brief.status, 'brief', JSON.stringify(brief))
  assert.deepEqual(brief.parts.answers, [])
  assert.ok(!brief.text.includes(WORDS))
})

test('refused rulings go back to the ruler, and its corrected rulings settle', async (t) => {
  const { rig, folder, brief } = changed(t)
  const missing = { rulings: rulingsOf(brief).rulings.filter((r) => r.node !== 'cli') }
  const run = rig.relaunch(rulerScript(missing, rulingsOf(brief)))
  const out = await rule(run.ctx, args(folder))
  const messages = runRecords(rig.repo, rig.run, 'message').filter((m) => m.thread === rulerThread(brief))
  assert.equal(messages.length, 1)
  const [message] = messages
  assert.deepEqual([message.msg, message.round], ['refusals', 2])
  assert.ok(message.payload.refusals[0].problem.includes('cli'), JSON.stringify(message.payload))
  assert.equal(run.calls.length, 2)
  assert.equal(run.calls[1].thread.key, rulerThread(brief))
  assert.equal(run.calls[1].resume, true, 'the second call resumes the ruler\'s session')
  assert.equal(run.calls[1].brief, renderMessage({ msg: message.msg, payload: message.payload }))
  assert.equal(out.status, 'approved', JSON.stringify(out))
  assert.deepEqual(JSON.parse(readFileSync(brief.rulings, 'utf8')), rulingsOf(brief), 'the rulings file holds the corrected round, whole')
})

test('the refusals message to the ruler says the settle refused its rulings', async (t) => {
  const { rig, folder, brief } = changed(t)
  const missing = { rulings: rulingsOf(brief).rulings.filter((r) => r.node !== 'cli') }
  const run = rig.relaunch(rulerScript(missing, rulingsOf(brief)))
  await rule(run.ctx, args(folder))
  const [message] = runRecords(rig.repo, rig.run, 'message').filter((m) => m.thread === rulerThread(brief))
  assert.equal(message.payload.of, 'rulings')
  const text = renderMessage({ msg: message.msg, payload: message.payload })
  assert.ok(text.includes('rulings'), text)
  assert.ok(!/evidence store/i.test(text), text)
  assert.equal(run.calls[1].brief, text, "delivered in the ruler's own session")
})

test('an empty why, or an affected ruling with neither question nor fix, goes back to the ruler', async (t) => {
  const { rig, folder, brief } = changed(t)
  const run = rig.relaunch(rulerScript(
    rulingsOf(brief, { cli: { why: '' } }),
    rulingsOf(brief, { cli: { ruling: 'affected', why: 'it mutates what load returns', question: '', fix: '' } }),
    rulingsOf(brief),
  ))
  const out = await rule(run.ctx, args(folder))
  const messages = runRecords(rig.repo, rig.run, 'message').filter((m) => m.thread === rulerThread(brief))
  assert.deepEqual(messages.map((m) => [m.msg, m.round]), [['refusals', 2], ['refusals', 3]])
  for (const m of messages) assert.ok(m.payload.refusals[0].problem.includes('cli'), JSON.stringify(m.payload))
  assert.equal(run.calls.length, 3)
  assert.equal(out.status, 'approved', JSON.stringify(out))
})

test('the same refusal twice ends the run refused, the ruler lost', async (t) => {
  const { rig, folder, brief } = changed(t)
  const missing = { rulings: rulingsOf(brief).rulings.filter((r) => r.node !== 'cli') }
  const run = rig.relaunch(rulerScript(missing, missing))
  const out = await rule(run.ctx, args(folder))
  assert.deepEqual([out.status, out.next], ['refused', 'rule_it'], JSON.stringify(out))
  assert.ok(out.why.includes('cli'), out.why)
  assert.deepEqual(out.coverage.failed_channels, ['ruler'])
  assert.equal(out.coverage.complete, false)
  assert.equal(run.calls.length, 2)
  assert.equal(ledger(rig.repo, 'ruled').length, 0)
  assert.equal(approvalState(rig.repo, E, folder).state, 'edited')
})

test('a ruler that fails leaves the change unruled, the ruler lost', async (t) => {
  const { rig, folder } = changed(t)
  const run = rig.relaunch(rulerSteps({ status: 'failed', cause: 'host_error' }))
  const out = await rule(run.ctx, args(folder))
  assert.deepEqual([out.status, out.next], ['refused', 'rule_it'], JSON.stringify(out))
  assert.deepEqual(out.coverage.failed_channels, ['ruler'])
  assert.equal(out.coverage.complete, false)
  assert.equal(ledger(rig.repo, 'ruled').length, 0)
  assert.equal(approvalState(rig.repo, E, folder).state, 'edited')
})

test('a compile refusal passes through as compile_refused', { skip: process.getuid?.() === 0 && 'root writes through 0o444' }, async (t) => {
  const { rig, folder, brief } = changed(t, 'types')
  const nodes = fileFor(rig.repo, E, 'nodes').path
  chmodSync(nodes, 0o444)
  let out
  try {
    out = await rule(rig.relaunch(rulerScript(rulingsOf(brief))).ctx, args(folder))
  } finally {
    chmodSync(nodes, 0o644)
  }
  assert.deepEqual([out.status, out.folder, out.hash, out.ruled], ['compile_refused', folder, brief.hash, latestRuled(rig.repo, folder).seq], JSON.stringify(out))
  assert.ok(Array.isArray(out.problems) && out.problems.length > 0)
  assert.equal(out.coverage.complete, true)
  assert.notEqual(approvalState(rig.repo, E, folder).compiled_hash, brief.hash)
})

test('coverage is complete when the ruler ruled or nothing was ruled, and resumable as the run', async (t) => {
  const approved = changed(t)
  const a = approved.rig.relaunch(rulerScript(rulingsOf(approved.brief)))
  const outA = await rule(a.ctx, args(approved.folder))
  assert.equal(outA.status, 'approved')
  assertCompleteCoverage(outA, a.ctx, 'approved')

  const affected = changed(t)
  const n = affected.rig.relaunch(rulerScript(rulingsOf(affected.brief, AFFECTED)))
  const outN = await rule(n.ctx, args(affected.folder))
  assert.equal(outN.status, 'needs_user')
  assertCompleteCoverage(outN, n.ctx, 'needs_user')

  const unchanged = changed(t, null)
  const outR = await rule(unchanged.rig.ctx, args('api'))
  assert.equal(outR.status, 'refused')
  assertCompleteCoverage(outR, unchanged.rig.ctx, 'refused before any dispatch')
})

// --- relaunch --------------------------------------------------------------------------------

test('a relaunch calls nothing that returned', async (t) => {
  const { rig, folder, brief } = changed(t)
  const first = await rule(rig.relaunch(rulerScript(rulingsOf(brief))).ctx, args(folder))
  assert.equal(first.status, 'approved')
  const again = rig.relaunch({})
  const second = await rule(again.ctx, args(folder))
  assert.equal(again.calls.length, 0)
  assert.deepEqual(second, first)
  assert.equal(ledger(rig.repo, 'ruled').length, 1)
  assert.equal(approvalsOf(rig.repo, folder).filter((l) => l.hash === brief.hash).length, 1)
})

test('a run cut off after the ruler returned settles on relaunch without calling it again', async (t) => {
  const { rig, folder, brief } = changed(t)
  const run = rig.relaunch(rulerScript(rulingsOf(brief)))
  const runAgent = async (call) => {
    await run.ctx.runAgent(call)
    throw new Error('cut off after the ruler returned')
  }
  await assert.rejects(rule(programContext({ intelligence: 'normal', ...run.ctx, runAgent }), args(folder)))
  const again = rig.relaunch({})
  const out = await rule(again.ctx, args(folder))
  assert.equal(again.calls.length, 0)
  assert.equal(out.status, 'approved', JSON.stringify(out))
  assert.equal(approvalState(rig.repo, E, folder).compiled_hash, brief.hash)
})

// --- relaunch across a moved spec ------------------------------------------------------------

const X = '20260926-120000'
const event = (repo, e) => assert.equal(append(repo, E, 'events', { execution: X, ...e }).ok, true)
/** Work dispatched under api: it moves api's basis and leaves its text as it is. */
const dispatchUnderApi = (repo) => event(repo, { kind: 'dispatched', node: 'api/parse', role: 'implementer', round: 1 })
const VALIDATOR = 'A loader, a parser and a validator'
const H2_TEXT = EDITS.wording.text.replace('A loader and a parser', VALIDATOR)

test('a relaunch after the spec moved on rules the text as it stands', async (t) => {
  const { rig, folder, brief } = changed(t)
  const first = await rule(rig.relaunch(rulerScript(rulingsOf(brief))).ctx, args(folder))
  assert.deepEqual([first.status, first.hash], ['approved', brief.hash], JSON.stringify(first))
  writeSpec(rig.repo, folder, H2_TEXT)
  const moved = respecBrief(rig.repo, E, folder)
  assert.equal(moved.status, 'brief', JSON.stringify(moved))

  const again = rig.relaunch(rulerScript(rulingsOf(moved)))
  const out = await rule(again.ctx, args(folder))
  assert.equal(again.calls.length, 1)
  assert.ok(again.calls[0].brief.includes(VALIDATOR), 'the brief holds the text as it stands')
  assert.deepEqual([out.status, out.hash], ['approved', moved.hash], JSON.stringify(out))
  assert.equal(approvalState(rig.repo, E, folder).compiled_hash, moved.hash)
})

test('a run cut off before the ruler returned rules the moved text on relaunch', async (t) => {
  const { rig, folder } = changed(t)
  const cut = rig.relaunch({})
  const runAgent = async () => { throw new Error('cut off before the ruler returned') }
  await assert.rejects(rule(programContext({ intelligence: 'normal', ...cut.ctx, runAgent }), args(folder)))
  writeSpec(rig.repo, folder, H2_TEXT)
  const moved = respecBrief(rig.repo, E, folder)
  assert.equal(moved.status, 'brief', JSON.stringify(moved))

  const again = rig.relaunch(rulerScript(rulingsOf(moved)))
  const out = await rule(again.ctx, args(folder))
  assert.equal(again.calls.length, 1)
  assert.ok(again.calls[0].brief.includes(VALIDATOR), 'the brief holds the text as it stands')
  assert.deepEqual(JSON.parse(readFileSync(moved.rulings, 'utf8')), rulingsOf(moved), 'the rulings land in the moved text\'s rulings file')
  assert.deepEqual([out.status, out.hash], ['approved', moved.hash], JSON.stringify(out))
  assert.deepEqual(out.coverage.failed_channels, [])
})

test('a relaunch after the basis moved under the same text rules it again', async (t) => {
  const { rig, folder, brief, first } = await needsUser(t)
  dispatchUnderApi(rig.repo)
  const moved = respecBrief(rig.repo, E, folder)
  assert.equal(moved.hash, brief.hash)
  assert.notEqual(moved.basis, brief.basis)

  const again = rig.relaunch(rulerScript(rulingsOf(moved, AFFECTED)))
  const out = await rule(again.ctx, args(folder))
  assert.equal(again.calls.length, 1)
  assert.ok(again.calls[0].brief.split('\n').some((l) => l.startsWith('- api/parse — ')), 'the dispatched leaf is work under the spec')
  const line = latestRuled(rig.repo, folder)
  assert.ok(line.seq > first.ruled, 'a new ruled line')
  assert.deepEqual([out.ruled, line.basis], [line.seq, moved.basis], JSON.stringify(out))
})

// --- the ruling loop's other refusals --------------------------------------------------------

test('a settle refused with a next other than rule_it ends the ruling loop on it', async (t) => {
  const { rig, folder, brief } = changed(t)
  const run = rig.relaunch(rulerScript(rulingsOf(brief), rulingsOf(brief)))
  const runAgent = async (call) => {
    writeSpec(rig.repo, '.', EDITS.decision.text)
    return run.ctx.runAgent(call)
  }
  const out = await rule(programContext({ intelligence: 'normal', ...run.ctx, runAgent }), args(folder))
  assert.deepEqual([out.status, out.next], ['refused', 'rule_parent_first'], JSON.stringify(out))
  assert.equal(run.calls.length, 1)
  assert.equal(runRecords(rig.repo, rig.run, 'message').length, 0)
  assert.deepEqual(out.coverage.failed_channels, [])
})

// --- the inline brief's specs ----------------------------------------------------------------

const PARSE = read('api-parse.md')
const CLI_SPEC = PARSE.replace('# Parse keys', '# Read configs from the command line').replace(/src\/api\//g, 'src/cli/')

/**
 * The wording edit of api, briefed inline, over an effort whose cli and api/parse tasks are
 * promoted to prepared specs and whose api/parse/tokens was dispatched; `specs` is the brief from
 * "The specs" on, and `heading(id)` the heading a folder's spec has there.
 */
function promoted(t) {
  const { rig } = changed(t, null)
  writeSpec(rig.repo, 'cli', CLI_SPEC)
  writeSpec(rig.repo, 'api/parse', PARSE)
  for (const id of ['cli', 'api/parse']) {
    const prepared = recordPreparation(rig.repo, E, id, { review: 'probe-' + id.replace('/', '.') + '.json' })
    assert.equal(prepared.ok, true, prepared.error)
  }
  const compiled = compileEffort(rig.repo, E)
  assert.equal(compiled.ok, true, JSON.stringify(compiled.problems))
  event(rig.repo, { kind: 'dispatched', node: 'api/parse/tokens', role: 'implementer', round: 1 })
  writeSpec(rig.repo, 'api', EDITS.wording.text)
  const brief = respecBrief(rig.repo, E, 'api')
  assert.equal(brief.status, 'brief', JSON.stringify(brief))
  const heading = (id) => '### ' + posix(relative(mainCheckout(rig.repo), specPath(rig.repo, E, id)))
  return { brief, specs: brief.text.slice(brief.text.indexOf('\n## The specs\n')), heading }
}

test("the inline brief holds whole a reached node's own spec that is no named node's entry file", (t) => {
  const { brief, specs, heading } = promoted(t)
  assert.ok(brief.nodes.includes('cli'), JSON.stringify(brief.nodes))
  assert.ok(!brief.nodes.some((id) => id.startsWith('cli/')), 'no node the cli spec states is named')
  assert.ok(specs.split('\n').includes(heading('cli')), 'the cli spec under "The specs"')
  assert.ok(specs.includes(CLI_SPEC.trim()), 'the cli spec whole')
})

test('the inline brief holds whole the spec that states work under the changed spec, named by no reached node', (t) => {
  const { brief, specs, heading } = promoted(t)
  assert.ok(!brief.nodes.some((id) => id.startsWith('api/parse')), JSON.stringify(brief.nodes))
  assert.ok(brief.text.split('\n').some((l) => l.startsWith('- api/parse/tokens — ')), 'the dispatched leaf is work under api')
  assert.ok(specs.split('\n').includes(heading('api/parse')), 'the api/parse spec under "The specs"')
  assert.ok(specs.includes(PARSE.trim()), 'the api/parse spec whole')
})

// --- through launch, as the CLI starts it ----------------------------------------------------------------------------

/** A rig holding the root spec, never approved, whose host CLI resolves. */
function neverApproved(t) {
  const rig = programRig({ files: { 'CLAUDE.md': GUIDE + '\n' }, config: { claude_cli: process.execPath } })
  writeSpec(rig.repo, '.', ROOT)
  return rig
}
/** Start `rule` as `node lib/run.mjs rule` does, with no session; what it returns. */
const cli = (rig, ...flags) => launch({
  argv: ['rule', '--repo', rig.repo, ...flags], env: { ...process.env, NODE_TEST_CONTEXT: '', CLAUDE_CODE_SESSION_ID: '' },
})

test('a detached rule run of a folder never compiled ends refused user_approves', { timeout: 60000 }, async (t) => {
  const rig = neverApproved(t)
  let pid = 0
  t.after(async () => {
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid)
      } catch {
        // gone already
      }
    }
    for (const by = Date.now() + 10_000; pid && pidAlive(pid) && Date.now() < by;) await new Promise((wake) => setTimeout(wake, 50))
    rig.cleanup()
  })
  const out = await cli(rig, '--detach', '--effort', E, '--folder', '.')
  pid = out.pid
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(typeof out.run, 'string')
  assert.ok(Number.isInteger(out.pid) && out.pid > 0)
  assert.equal(out.log, runLogFile(rig.repo, out.run))
  assert.equal(out.result_file, resultPath(rig.repo, out.run))

  for (const deadline = Date.now() + 45_000; ;) {
    if (Date.now() > deadline) assert.fail('the detached run never ended: ' + runState(rig.repo, out.run).state)
    if (runState(rig.repo, out.run).state === 'ended' && !pidAlive(out.pid)) break
    await new Promise((wake) => setTimeout(wake, 50))
  }
  assert.equal(runRecords(rig.repo, out.run, 'ended').at(-1).result.status, 'done')
  const result = readJson(resultPath(rig.repo, out.run))
  assert.deepEqual([result.status, result.next, result.run], ['refused', 'user_approves', out.run], JSON.stringify(result))
  assert.equal(result.coverage.complete, true)
})
